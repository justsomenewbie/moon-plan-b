/**
 * Synchronous Python tools under /api/v1/tools/* (docs/PYTHON_INTEGRATION.md section 3.3).
 * OWNER: builder B4 (tools); contract: src/contract/tools.ts.
 *
 *   POST /tools/ephemeris -> backend/python/ephemeris_json.py
 *   POST /tools/horizon   -> backend/python/horizon_json.py
 *
 * Safety: Python only through runPython() (no shell, args array, timeout, kill tree, env allow-list);
 * the request is passed as JSON on stdin and never contains a path; everything Python prints is
 * zod-validated; messages shown to the client have server paths replaced. Small concurrency limit +
 * bounded queue (429 QUEUE_FULL) + at most TOOLS_LIMITS.max_pending_per_client requests waiting / running per
 * client (429 TOO_MANY_JOBS) + RATE_LIMIT_TOOLS_MAX per minute per IP. Time budget = ALTDATES_TIMEOUT_S (the
 * sync bridge timeout) x TOOLS_LIMITS.<tool>_timeout_factor and covers the queue wait AND the computation:
 * a request still queued when it runs out answers 429 QUEUE_FULL, Python gets the rest (then 504). A client
 * that disconnects leaves the queue, or has its Python process tree killed. dem pgda work counts into the
 * PGDA download budget (src/python/pgdaCache.ts; 429 QUOTA_EXCEEDED) and trims the PGDA cache.
 *
 * Site resolution (both tools): lat/lon rounded to the canonical custom-site grid (4 decimals, exactly the
 * coordinates a precompute job uses for the same custom_sites entry); site_id -> the site record
 * of `run_id` (default: the default run, when it contains the site), else the lunarnav catalog / the
 * canonical custom id (resolved by Python with lunarnav.sites.get_site, exactly like precompute).
 */
import PQueue from 'p-queue';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Capabilities } from '../contract/capabilities.ts';
import { EphemerisRequest, EphemerisResponse, HorizonToolRequest, HorizonToolResponse, TOOLS_LIMITS } from '../contract/tools.ts';
import {
  PyEphemeris,
  PyHorizon,
  checkHorizonCapabilities,
  horizonResponse,
  pyEnvelope,
  requireAvailable,
  resolveToolSite,
  sanitizeToolText,
  toolSite,
  type ResolvedSite,
} from '../jobs/types/b4_tools.ts';
import { ApiError, problemResponses, siteNotFound } from '../lib/problem.ts';
import { requestClientKey } from '../lib/client.ts';
import { getCapabilities } from '../python/capabilities.ts';
import { checkPgdaBudget, trackPgda } from '../python/pgdaCache.ts';
import { runPython, type RunPythonResult } from '../python/process.ts';
import { bridgeScriptArgs, lunarnavCwd, lunarnavEnv } from '../python/scripts.ts';

export const EPHEMERIS_SCRIPT = 'ephemeris_json.py';
export const HORIZON_SCRIPT = 'horizon_json.py';
const DEFAULT_MAST_M = 2;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

type ToolsConfig = Pick<Config, 'PYTHON_BIN' | 'LUNARNAV_ROOT' | 'DATA_DIR' | 'ALTDATES_TIMEOUT_S' | 'JOB_TIMEOUT_S' | 'CUSTOM_RUN_TTL_DAYS'> &
  Partial<Pick<Config, 'NODE_ENV' | 'CAPABILITIES_NETWORK_PROBE' | 'CAPABILITIES_TTL_S' | 'PGDA_DOWNLOAD_MAX_MB_PER_DAY' | 'PGDA_CACHE_MAX_MB'>>;

/** Least remaining time budget (ms) a request must still have when its turn comes to start Python. */
export const TOOL_MIN_RUN_MS = 1000;

export interface ToolRunOptions {
  /** Aborted when the HTTP client disconnects: leave the queue / kill the Python process tree. */
  signal?: AbortSignal;
  /** clientKey of the caller (TOOLS_LIMITS.max_pending_per_client). */
  client?: string;
  /** The computation may read PGDA blocks (download budget + cache trim). */
  pgda?: boolean;
}

/** Never delivered (the client is gone); a 4xx so the server log does not report it as an error. */
const abandoned = (): ApiError => new ApiError('QUEUE_FULL', 'request abandoned: the client closed the connection');

/** Signal aborted when the client goes away before the response was sent. */
function clientGone(reply: { raw: NodeJS.EventEmitter & { writableEnded: boolean } }): AbortSignal {
  const ac = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) ac.abort();
  });
  return ac.signal;
}

// ---- the Python call -----------------------------------------------------------------------------------------
export class ToolsService {
  private readonly queue = new PQueue({ concurrency: TOOLS_LIMITS.concurrency });
  private readonly cfg: ToolsConfig;

  constructor(cfg: ToolsConfig) {
    this.cfg = cfg;
  }

  capabilities(): Promise<Capabilities> {
    return getCapabilities(this.cfg);
  }

  sanitize(s: string): string {
    return sanitizeToolText(this.cfg, s);
  }

  /** Requests of each client waiting or running now. */
  private readonly perClient = new Map<string, number>();

  async run<T extends z.ZodType>(script: string, label: string, timeoutFactor: number, input: unknown, schema: T, opts: ToolRunOptions = {}): Promise<z.output<T>> {
    const { signal, client } = opts;
    if (signal?.aborted) throw abandoned();
    if (client !== undefined) {
      const n = this.perClient.get(client) ?? 0;
      if (n >= TOOLS_LIMITS.max_pending_per_client) {
        throw new ApiError('TOO_MANY_JOBS', `this client already has ${n} tool computation(s) waiting or running (limit ${TOOLS_LIMITS.max_pending_per_client}); wait for them`, {
          headers: { 'retry-after': '5' },
          extensions: { max_pending_per_client: TOOLS_LIMITS.max_pending_per_client },
        });
      }
    }
    if (this.queue.size >= TOOLS_LIMITS.max_pending) {
      throw new ApiError('QUEUE_FULL', `too many ${label} computations in progress, retry in a few seconds`, { headers: { 'retry-after': '5' } });
    }
    if (opts.pgda) checkPgdaBudget(this.cfg);
    if (client !== undefined) this.perClient.set(client, (this.perClient.get(client) ?? 0) + 1);
    try {
      const r = await this.queued(label, timeoutFactor, script, input, opts);
      return this.parse(r, label, schema);
    } finally {
      if (client !== undefined) {
        const left = (this.perClient.get(client) ?? 1) - 1;
        if (left > 0) this.perClient.set(client, left);
        else this.perClient.delete(client);
      }
    }
  }

  /** Wait for a slot (bounded by the time budget, left on client abort), then run Python with the rest of it. */
  private async queued(label: string, timeoutFactor: number, script: string, input: unknown, opts: ToolRunOptions): Promise<RunPythonResult & { budgetS: number }> {
    const budgetS = this.cfg.ALTDATES_TIMEOUT_S * timeoutFactor;
    const deadline = Date.now() + budgetS * 1000;
    // aborts the WAIT only (never a running task: p-queue would free its slot while Python still runs)
    const wait = new AbortController();
    let started = false;
    const timer = setTimeout(() => wait.abort(new Error('queue wait exceeded the time budget')), budgetS * 1000);
    const onGone = (): void => {
      if (!started) wait.abort(new Error('client gone'));
    };
    opts.signal?.addEventListener('abort', onGone, { once: true });
    try {
      const r = await this.queue.add(
        async (): Promise<RunPythonResult | 'gone' | 'late'> => {
          started = true;
          clearTimeout(timer);
          const remaining = deadline - Date.now();
          if (opts.signal?.aborted) return 'gone';
          if (remaining < TOOL_MIN_RUN_MS) return 'late';
          const spawn = () =>
            runPython({
              bin: this.cfg.PYTHON_BIN,
              args: bridgeScriptArgs(script),
              cwd: lunarnavCwd(this.cfg),
              env: lunarnavEnv(this.cfg, { bridge: true }),
              input: JSON.stringify(input),
              captureStdout: true,
              maxStdoutBytes: MAX_STDOUT_BYTES,
              timeoutMs: remaining,
              ...(opts.signal ? { signal: opts.signal } : {}),
            });
          return opts.pgda ? trackPgda(this.cfg, spawn) : spawn();
        },
        { signal: wait.signal },
      );
      if (r === 'gone') throw abandoned();
      if (r === 'late') throw this.busy(label, budgetS);
      if (r.canceled) throw abandoned();
      return { ...r, budgetS };
    } catch (e) {
      if (wait.signal.aborted && !started) throw opts.signal?.aborted ? abandoned() : this.busy(label, budgetS);
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onGone);
    }
  }

  private busy(label: string, budgetS: number): ApiError {
    return new ApiError('QUEUE_FULL', `the ${label} tool is busy: no computation slot within the ${budgetS} s budget, retry in a few seconds`, {
      headers: { 'retry-after': '5' },
    });
  }

  private parse<T extends z.ZodType>(r: RunPythonResult & { budgetS: number }, label: string, schema: T): z.output<T> {
    const timeoutS = r.budgetS;
    if (r.timedOut) {
      throw new ApiError('PYTHON_TIMEOUT', `${label} exceeded ${timeoutS} s`, {
        hint: label === 'horizon' ? 'use a coarser az_step_deg / smaller radius_km, or POST /api/v1/jobs (type horizon_mask)' : 'send fewer times per request',
      });
    }
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    type Envelope = { ok: true; bridge_version: number; result: z.output<T> } | { ok: false; error: { type: string; message: string } };
    let parsed: Envelope | null = null;
    try {
      const j = pyEnvelope(schema).safeParse(JSON.parse(last));
      if (j.success) parsed = j.data as unknown as Envelope;
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.ok && r.exitCode !== 0) || (!parsed.ok && r.exitCode !== 2)) {
      const why = r.spawnError ?? (r.overflow ? 'stdout too large' : (r.stderrTail.at(-1) ?? `exit code ${String(r.exitCode)}`));
      // full stderr goes to the server log (error handler logs err + cause), not to the client
      throw new ApiError('PYTHON_FAILED', `${label} bridge failed (see server log)`, { cause: new Error(`${why}\n${r.stderrTail.join('\n')}`) });
    }
    if (parsed.ok) return parsed.result;
    const msg = this.sanitize(parsed.error.message);
    switch (parsed.error.type) {
      case 'site_not_found':
        throw new ApiError('SITE_NOT_FOUND', msg);
      case 'value_error':
      case 'dem_coverage':
        throw new ApiError('OUT_OF_RANGE', msg);
      case 'capability':
        throw new ApiError('CAPABILITY_UNAVAILABLE', msg, { hint: 'GET /api/v1/capabilities' });
      case 'provider_error':
        throw new ApiError('PYTHON_FAILED', `${label}: ${msg}`);
      default:
        throw new ApiError('PYTHON_FAILED', `${label} bridge rejected its input (see server log)`, { cause: new Error(`${parsed.error.type}: ${parsed.error.message}`) });
    }
  }
}

// ---- POST /tools/ephemeris: height plan ------------------------------------------------------------------------
type HeightSpec =
  | { mode: 'fixed'; source: 'run' | 'value' | 'sphere'; surface_height_m: number; observer_height_m: number; observer_height_above_sphere_m: number; note: string | null }
  | { mode: 'dem'; fallback_sphere: boolean; observer_height_m: number; note: string | null };

function heightFromRun(rs: ResolvedSite, mast: number | undefined, note: string | null): HeightSpec | null {
  const r = rs.record;
  if (!r) return null;
  const m = mast ?? r.observer_height_m;
  // the record's observer height above the sphere is exactly what the run's ephemeris used (mm-rounded)
  const above = m === r.observer_height_m ? r.observer_height_above_sphere_m : r.surface_height_m + m;
  return { mode: 'fixed', source: 'run', surface_height_m: r.surface_height_m, observer_height_m: m, observer_height_above_sphere_m: above, note };
}

function planHeight(body: EphemerisRequest, rs: ResolvedSite, caps: Capabilities): HeightSpec {
  const sh = body.surface_height;
  const mast = body.observer_height_m;
  if (typeof sh === 'number') {
    const m = mast ?? DEFAULT_MAST_M;
    return { mode: 'fixed', source: 'value', surface_height_m: sh, observer_height_m: m, observer_height_above_sphere_m: sh + m, note: null };
  }
  if (sh === 'sphere') {
    const m = mast ?? DEFAULT_MAST_M;
    return { mode: 'fixed', source: 'sphere', surface_height_m: 0, observer_height_m: m, observer_height_above_sphere_m: m, note: null };
  }
  if (sh === 'run') {
    const h = heightFromRun(rs, mast, null);
    if (h) return h;
    if (body.site_id === undefined) {
      throw new ApiError('VALIDATION_ERROR', "surface_height 'run' needs site_id", { errors: [{ path: 'surface_height', in: 'body', message: "'run' needs site_id (a site of an imported run)" }] });
    }
    throw siteNotFound(body.site_id);
  }
  if (sh === 'dem') {
    requireAvailable('dem pgda', caps.dems.pgda, 'surface_height');
    return { mode: 'dem', fallback_sphere: false, observer_height_m: mast ?? DEFAULT_MAST_M, note: null };
  }
  // auto
  const fromRun = heightFromRun(rs, mast, rs.runId === null ? null : `auto: site record of run ${rs.runId}`);
  if (fromRun) return fromRun;
  const m = mast ?? DEFAULT_MAST_M;
  if (caps.dems.pgda.available) return { mode: 'dem', fallback_sphere: true, observer_height_m: m, note: 'auto: PGDA DEM height at the site' };
  return { mode: 'fixed', source: 'sphere', surface_height_m: 0, observer_height_m: m, observer_height_above_sphere_m: m, note: `auto: PGDA not available (${caps.dems.pgda.reason ?? 'unknown'}); smooth sphere used` };
}

// ---- routes -----------------------------------------------------------------------------------------------------
const TOOL_QUEUE_NOTE =
  `The time budget covers the wait for one of the ${TOOLS_LIMITS.concurrency} computation slots too (no slot in time -> 429 QUEUE_FULL); ` +
  `at most ${TOOLS_LIMITS.max_pending_per_client} tool requests per client waiting or running (429 TOO_MANY_JOBS); a request whose client ` +
  'disconnects is dropped (its Python is killed). dem pgda: daily PGDA download budget (429 QUOTA_EXCEEDED).';
export const toolsRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ToolsService(app.config);
  const rateLimit = { rateLimit: { max: app.config.RATE_LIMIT_TOOLS_MAX, timeWindow: '1 minute' } };
  const ephTimeout = app.config.ALTDATES_TIMEOUT_S * TOOLS_LIMITS.ephemeris_timeout_factor;
  const hzTimeout = app.config.ALTDATES_TIMEOUT_S * TOOLS_LIMITS.horizon_timeout_factor;

  app.post(
    '/tools/ephemeris',
    {
      schema: {
        tags: ['tools'],
        operationId: 'toolEphemeris',
        summary: 'Sun / Earth azimuth, elevation and distance at up to 200 instants (synchronous)',
        description:
          `Synchronous Python (<= ${ephTimeout} s; spice / analytic ~0.1-1 s, horizons needs the network). Computed like ` +
          '`lunarnav precompute` (same provider defaults, observer = surface + mast). With site_id of a run site, surface_height auto|run ' +
          "and rounding run_files (defaults), SPICE values are EXACTLY the run's stored ephemeris. " +
          'Provider / DEM not available on this server -> 422 CAPABILITY_UNAVAILABLE; site outside the PGDA coverage with surface_height dem ' +
          '-> 422 OUT_OF_RANGE; unknown site -> 404 SITE_NOT_FOUND; Horizons / network failure -> 502 PYTHON_FAILED; timeout -> 504. ' +
          'lat/lon are rounded to 4 decimals (the canonical custom site, = custom_site_id: what a precompute job computes). ' +
          TOOL_QUEUE_NOTE,
        body: EphemerisRequest,
        response: { 200: EphemerisResponse, ...problemResponses(400, 404, 409, 413, 415, 422, 429, 502, 503, 504) },
      },
      config: rateLimit,
    },
    async (req, reply) => {
      const body = req.body;
      const signal = clientGone(reply);
      const caps = await service.capabilities();
      requireAvailable(`provider ${body.provider}`, caps.providers[body.provider], 'provider');
      const rs = await resolveToolSite(app.config, body);
      const height = planHeight(body, rs, caps);
      const py = await service.run(
        EPHEMERIS_SCRIPT,
        'ephemeris',
        TOOLS_LIMITS.ephemeris_timeout_factor,
        { site: rs.ref, times: body.times, provider: body.provider, height, rounding: body.rounding },
        PyEphemeris,
        { signal, client: requestClientKey(req), pgda: height.mode === 'dem' },
      );
      if (py.rows.length !== body.times.length) throw new ApiError('PYTHON_FAILED', `ephemeris bridge returned ${py.rows.length} rows for ${body.times.length} times`);
      return {
        site: toolSite(body.site_id ?? null, rs.source, rs.runId, py.site),
        provider: py.provider,
        provider_config: py.provider_config,
        height: { ...py.height, dem_source: py.height.dem_source === null ? null : service.sanitize(py.height.dem_source), note: py.height.note === null ? null : service.sanitize(py.height.note) },
        rounding: body.rounding,
        n_times: py.rows.length,
        rows: py.rows,
        elapsed_ms: py.elapsed_ms,
      };
    },
  );

  app.post(
    '/tools/horizon',
    {
      schema: {
        tags: ['tools'],
        operationId: 'toolHorizon',
        summary: 'Terrain horizon mask of one point (synchronous, radius <= 60 km)',
        description:
          `Synchronous Python (<= ${hzTimeout} s; ~5 s for 60 km at 0.5 deg on cached PGDA tiles, longer the first time a region is read). ` +
          'Same horizon factory as `lunarnav precompute` (lunarnav.precompute.make_horizon_fn): for the same options the mask equals a run ' +
          "horizon except where the run's 150 km search found higher terrain beyond radius_km. dem none -> smooth-sphere mask. " +
          'A numeric near_exclusion_m needs capabilities.cli.near_exclusion_m (else 422 CAPABILITY_UNAVAILABLE; auto = the lunarnav default). Site outside the PGDA coverage: ' +
          'dem_fallback flat -> smooth sphere (dem_fallback says why), error -> 422 OUT_OF_RANGE. Timeout -> 504 (hint: POST /api/v1/jobs type horizon_mask). ' +
          'PGDA not reachable from the server -> 422 CAPABILITY_UNAVAILABLE. lat/lon are rounded to 4 decimals (custom_site_id). ' +
          TOOL_QUEUE_NOTE,
        body: HorizonToolRequest,
        response: { 200: HorizonToolResponse, ...problemResponses(400, 404, 409, 413, 415, 422, 429, 502, 503, 504) },
      },
      config: rateLimit,
    },
    async (req, reply) => {
      const body = req.body;
      const signal = clientGone(reply);
      const caps = await service.capabilities();
      checkHorizonCapabilities(caps, body);
      const rs = await resolveToolSite(app.config, body);
      const method = body.dem === 'none' ? 'flat' : body.method;
      const py = await service.run(
        HORIZON_SCRIPT,
        'horizon',
        TOOLS_LIMITS.horizon_timeout_factor,
        {
          site: rs.ref,
          dem: body.dem,
          method,
          radius_km: body.radius_km,
          az_step_deg: body.az_step_deg,
          observer_height_m: body.observer_height_m,
          // 'auto' = the lunarnav default = omitted
          ...(typeof body.near_exclusion_m === 'number' && method !== 'flat' ? { near_exclusion_m: body.near_exclusion_m } : {}),
          dem_fallback: body.dem_fallback,
          rounding: body.rounding,
        },
        PyHorizon,
        { signal, client: requestClientKey(req), pgda: body.dem === 'pgda' },
      );
      try {
        return horizonResponse(toolSite(body.site_id ?? null, rs.source, rs.runId, py.site), py, body.rounding, (t) => service.sanitize(t));
      } catch (e) {
        throw new ApiError('PYTHON_FAILED', (e as Error).message);
      }
    },
  );
};

export default toolsRoutes;
