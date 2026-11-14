/**
 * POST /alt-dates service (plan 7.1): synchronous Python bridge (backend/python/alt_dates_json.py) on
 * the stored visibility file of an imported run, with
 *   - semantic pre-checks in Node (422 OUT_OF_RANGE with min_earliest / max_latest, 422 BAD_MISSION_LENGTH),
 *   - a Mongo `cache` (key = sha256 of endpoint + bridge version + run fingerprint + canonical params),
 *   - coalescing of identical in-flight requests and a small concurrency limit (DoS guard),
 *   - zod validation of everything Python prints.
 */
import path from 'node:path';
import PQueue from 'p-queue';
import { z } from 'zod';
import { BACKEND_ROOT, type Config } from '../config.ts';
import { COLLECTIONS, collection } from '../db.ts';
import { DateConstraints, LandingCandidate, type AltDatesRequest, type AltDatesResponse } from '../contract/alt_dates.ts';
import { ApiError } from '../lib/problem.ts';
import { MS_PER_H, parseIsoUtc, parseIsoUtcCeil, toIsoUtc } from '../lib/time.ts';
import { sha256, stableStringify } from './hash.ts';
import { lunarnavCodeVersion, lunarnavDataDir } from './lunarnav.ts';
import { pythonPathWith, runPython } from './process.ts';
import { resolveRunOnDisk, visibilityPath, type RunOnDisk } from './runFiles.ts';

export const ALT_DATES_SCRIPT = path.join(BACKEND_ROOT, 'python', 'alt_dates_json.py');
/** Bump when the bridge output or the cache key changes (invalidates cached bodies). */
export const ALT_DATES_BRIDGE_VERSION = 1;
export const ALT_DATES_CACHE_TTL_DAYS = 7;
export const ALT_DATES_CONCURRENCY = 2;
export const ALT_DATES_MAX_PENDING = 8;

const PyResult = z.object({
  site_id: z.string(),
  earliest_utc: z.string(),
  latest_utc: z.string(),
  mission_duration_h: z.number(),
  constraints: DateConstraints,
  n_evaluated: z.int(),
  n_feasible: z.int(),
  rejected_by: z.record(z.string(), z.int()),
  candidates: z.array(LandingCandidate),
});
const PyOut = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), bridge_version: z.int().optional(), result: PyResult }),
  z.object({ ok: z.literal(false), error: z.object({ type: z.string(), message: z.string() }) }),
]);

interface CacheDoc {
  _id: string;
  kind: 'alt_dates';
  run_id: string;
  body: AltDatesResponse;
  created_at: Date;
  expires_at: Date;
}

export interface AltDatesPlan {
  run: RunOnDisk;
  cacheId: string;
  input: Record<string, unknown>;
}

/** Validate a request against the run and build the bridge input + cache id (no Python). */
export async function planAltDates(cfg: Pick<Config, 'LUNARNAV_ROOT' | 'DATA_DIR'>, body: AltDatesRequest): Promise<AltDatesPlan> {
  const run = await resolveRunOnDisk(body.run_id, cfg.DATA_DIR);
  const vis = await visibilityPath(run, body.site_id);
  const earliestMs = parseIsoUtcCeil(body.earliest);
  const latestMs = parseIsoUtc(body.latest);
  const stepMs = run.stepS * 1000;
  const missionMs = Math.round(body.mission_h * MS_PER_H);
  if (latestMs < earliestMs) {
    throw new ApiError('VALIDATION_ERROR', 'latest must be >= earliest', {
      errors: [{ path: 'latest', in: 'body', message: `must be >= earliest (${body.earliest})` }],
    });
  }
  const m = (body.mission_h * 3600) / run.stepS;
  if (Math.abs(m - Math.round(m)) > 1e-6 || Math.round(m) < 1) {
    throw new ApiError('BAD_MISSION_LENGTH', `mission_h ${body.mission_h} is not a positive multiple of the run step (${run.stepS / 3600} h)`, {
      errors: [{ path: 'mission_h', in: 'body', message: `must be a multiple of ${run.stepS / 3600}` }],
      extensions: { step_h: run.stepS / 3600 },
    });
  }
  if (earliestMs < run.startMs) {
    throw new ApiError('OUT_OF_RANGE', `earliest ${body.earliest} is before the run start ${toIsoUtc(run.startMs)}`, {
      errors: [{ path: 'earliest', in: 'body', message: `must be >= ${toIsoUtc(run.startMs)}` }],
      extensions: { min_earliest: toIsoUtc(run.startMs) },
    });
  }
  // The last landing sample t must satisfy t + mission <= run end (python: i + m <= n).
  const maxLatestMs = run.endMs - missionMs;
  if (latestMs > maxLatestMs) {
    throw new ApiError('OUT_OF_RANGE', `latest + mission_h must be <= run end ${toIsoUtc(run.endMs)}`, {
      errors: [{ path: 'latest', in: 'body', message: `must be <= ${toIsoUtc(maxLatestMs)}` }],
      extensions: { max_latest: toIsoUtc(maxLatestMs) },
    });
  }
  // At least one sample of the grid must lie in [earliest, latest].
  const firstK = Math.ceil((earliestMs - run.startMs) / stepMs);
  if (run.startMs + firstK * stepMs > latestMs) {
    throw new ApiError('OUT_OF_RANGE', `no sample of the run grid (step ${run.stepS} s) lies in [earliest, latest]`, {
      errors: [{ path: 'latest', in: 'body', message: 'widen [earliest, latest] to contain a sample time' }],
    });
  }
  // Hand Python the grid samples that bound [earliest, latest] (first sample >= earliest, last sample <= latest).
  // toIsoUtc drops sub-second digits, so passing earliest as-is turned 05:00:00.500Z into 05:00:00Z and the
  // 05:00 sample (0.5 s before earliest) came back as a candidate (FE report 14/11). Snapping also makes
  // requests that select the same samples share one cache entry.
  const firstSampleMs = run.startMs + firstK * stepMs;
  const lastSampleMs = run.startMs + Math.floor((latestMs - run.startMs) / stepMs) * stepMs;
  const params = {
    site_id: body.site_id,
    earliest: toIsoUtc(firstSampleMs),
    latest: toIsoUtc(lastSampleMs),
    mission_h: body.mission_h,
    max_results: body.max_results,
    constraints: body.constraints,
  };
  const cacheId = sha256(
    stableStringify({
      endpoint: 'alt-dates',
      v: ALT_DATES_BRIDGE_VERSION,
      // a new lunarnav version may change find_alternative_dates -> new cache entries
      code_version: await lunarnavCodeVersion(cfg),
      run_id: run.runId,
      params_fingerprint: run.paramsFingerprint,
      params,
    }),
  );
  const input = { ...params, visibility_path: vis, min_earth_clearance_deg: run.minEarthClearanceDeg };
  return { run, cacheId, input };
}

export class AltDatesService {
  private readonly queue = new PQueue({ concurrency: ALT_DATES_CONCURRENCY });
  private readonly inflight = new Map<string, Promise<AltDatesResponse>>();

  private readonly cfg: Pick<Config, 'DATA_DIR' | 'PYTHON_BIN' | 'LUNARNAV_ROOT' | 'ALTDATES_TIMEOUT_S'>;

  constructor(cfg: Pick<Config, 'DATA_DIR' | 'PYTHON_BIN' | 'LUNARNAV_ROOT' | 'ALTDATES_TIMEOUT_S'>) {
    this.cfg = cfg;
  }

  /** Returns the response and whether it came from the cache. */
  async find(body: AltDatesRequest): Promise<{ body: AltDatesResponse; cache: 'hit' | 'miss' | 'shared' }> {
    const plan = await planAltDates(this.cfg, body);
    const cached = await collection<CacheDoc>(COLLECTIONS.cache).findOne({ _id: plan.cacheId, expires_at: { $gt: new Date() } });
    if (cached) return { body: cached.body, cache: 'hit' };
    const running = this.inflight.get(plan.cacheId);
    if (running) return { body: await running, cache: 'shared' };
    if (this.queue.size >= ALT_DATES_MAX_PENDING) {
      throw new ApiError('QUEUE_FULL', 'too many alt-dates computations in progress, retry in a few seconds', { headers: { 'retry-after': '5' } });
    }
    const p = this.queue.add(() => this.compute(plan)).finally(() => this.inflight.delete(plan.cacheId));
    this.inflight.set(plan.cacheId, p);
    return { body: await p, cache: 'miss' };
  }

  private async compute(plan: AltDatesPlan): Promise<AltDatesResponse> {
    const r = await runPython({
      bin: this.cfg.PYTHON_BIN,
      args: ['-u', ALT_DATES_SCRIPT],
      cwd: this.cfg.LUNARNAV_ROOT,
      // The bridge script lives in backend/python (= its sys.path[0]); PYTHONPATH makes it import the
      // lunarnav of LUNARNAV_ROOT, the same package `-m lunarnav.cli` uses for jobs (cwd = LUNARNAV_ROOT).
      env: { LUNARNAV_DATA: lunarnavDataDir(this.cfg), PYTHONPATH: pythonPathWith(this.cfg.LUNARNAV_ROOT) },
      input: JSON.stringify(plan.input),
      captureStdout: true,
      maxStdoutBytes: 4 * 1024 * 1024,
      timeoutMs: this.cfg.ALTDATES_TIMEOUT_S * 1000,
    });
    if (r.timedOut) throw new ApiError('PYTHON_TIMEOUT', `alt-dates computation exceeded ${this.cfg.ALTDATES_TIMEOUT_S} s`);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    let parsed: z.output<typeof PyOut> | null = null;
    try {
      const j = PyOut.safeParse(JSON.parse(last));
      if (j.success) parsed = j.data;
    } catch {
      parsed = null;
    }
    if (!parsed || (r.exitCode !== 0 && r.exitCode !== 2)) {
      const why = r.spawnError ?? r.stderrTail.at(-1) ?? `exit code ${String(r.exitCode)}`;
      // stderr goes to the server log (error handler logs err + cause), not to the client.
      throw new ApiError('PYTHON_FAILED', 'alt-dates bridge failed (see server log)', { cause: new Error(`${why}\n${r.stderrTail.join('\n')}`) });
    }
    if (!parsed.ok) throw new ApiError('OUT_OF_RANGE', parsed.error.message);
    const body: AltDatesResponse = {
      run_id: plan.run.runId,
      step_s: plan.run.stepS,
      precision_h: plan.run.stepS / 3600,
      cache_id: plan.cacheId,
      ...parsed.result,
    };
    const now = new Date();
    await collection<CacheDoc>(COLLECTIONS.cache).replaceOne(
      { _id: plan.cacheId },
      { kind: 'alt_dates', run_id: plan.run.runId, body, created_at: now, expires_at: new Date(now.getTime() + ALT_DATES_CACHE_TTL_DAYS * 86_400_000) },
      { upsert: true },
    );
    return body;
  }
}
