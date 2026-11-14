/**
 * Job type 'precompute' (docs/PYTHON_INTEGRATION.md). OWNER: builder B1 (compute).
 * `lunarnav precompute` for catalog sites (list | 'all' | 'group:<g>') and/or custom coordinates over any
 * range / step with the full ComputeOptions, written to DATA_DIR/runs/job_<id>/ and imported as a run of
 * kind 'precompute' (result.run_id = job_<id>).
 *
 * Also the home of the helpers shared by the compute job types (analyse.ts, alt_dates_python.ts):
 * site selection -> canonical ids, range snapping + size guard rails, ComputeOptions -> canonical params
 * (capability checks: provider, DEM, Trek files, --near-exclusion-m) -> CLI flags.
 *
 * Safety: every value reaches Python as ONE argv element `--flag=value` (flagArg) through runPython (no
 * shell); site ids are validated (catalog ids against the catalog, custom ids canonical); paths are the
 * server's own (run.outDir / run.artifactsDir).
 */
import { copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Capabilities } from '../../contract/capabilities.ts';
import type { ComputeOptions } from '../../contract/job_types/common.ts';
import {
  PRECOMPUTE_LIMITS,
  PrecomputeJobOutput,
  type PrecomputeJobRequest,
} from '../../contract/job_types/precompute.ts';
import { getDb } from '../../db.ts';
import { ApiError, catalogSiteNotFound } from '../../lib/problem.ts';
import { parseIsoUtc, parseIsoUtcCeil, toIsoUtc } from '../../lib/time.ts';
import { customSiteId, isCustomSiteId, parseCustomSiteId, roundCustom } from '../../python/customSiteId.ts';
import { lunarnavCatalogPath } from '../../python/lunarnav.ts';
import { failureReason, progressFromLine } from '../../python/precompute.ts';
import { flagArg, lunarnavCliArgs } from '../../python/scripts.ts';
import { getImporter, importErrorMessage, purgeRunDocs } from '../importer.ts';
import { JobFailure, defineJobType, type SubmitContext, type TtlConfig } from './define.ts';

// ---- shared: errors --------------------------------------------------------------------------------
const bodyError = (field: string, message: string, extra: { hint?: string; extensions?: Record<string, unknown> } = {}): ApiError =>
  new ApiError('VALIDATION_ERROR', message, { errors: [{ path: field, in: 'body', message }], ...extra });

const capabilityError = (option: string, message: string, reason: string | null): ApiError =>
  new ApiError('CAPABILITY_UNAVAILABLE', message, {
    errors: [{ path: option, in: 'body', message }],
    hint: 'GET /api/v1/capabilities lists the providers, DEMs and CLI flags of this server',
    extensions: { option, reason },
  });

// ---- shared: compute options -----------------------------------------------------------------------
/** Canonical ComputeOptions (hashed): near_exclusion_m null = CLI default (auto) or not applicable. */
export type ComputeParams = {
  step_min: number;
  provider: ComputeOptions['provider'];
  dem: ComputeOptions['dem'];
  horizon_method: ComputeOptions['horizon_method'];
  radius_km: number;
  az_step_deg: number;
  observer_height_m: number;
  min_clearance_deg: number;
  dem_fallback: ComputeOptions['dem_fallback'];
  near_exclusion_m: number | null;
};

/**
 * Request options -> canonical params, checked against GET /capabilities: provider and DEM available,
 * Trek only with local GeoTIFFs (the API never downloads them), near_exclusion_m only when the CLI has
 * --near-exclusion-m. dem 'none' forces horizon_method 'flat' (what the CLI does); near_exclusion_m only
 * matters for raymarch and 'auto' = the CLI default, both canonicalised to null (equivalent requests share a hash).
 */
export async function canonicalComputeOptions(o: ComputeOptions, ctx: SubmitContext): Promise<ComputeParams> {
  if (!Number.isInteger(Math.round(o.step_min * 60 * 1e6) / 1e6)) {
    throw bodyError('step_min', 'step_min must be a whole number of seconds (step_min * 60 integer)');
  }
  const caps: Capabilities = await ctx.capabilities();
  const prov = caps.providers[o.provider];
  if (!prov.available) throw capabilityError('provider', `provider ${o.provider} is not available on this server: ${prov.reason ?? 'unavailable'}`, prov.reason);
  const dem = caps.dems[o.dem];
  if (o.dem === 'trek' && caps.dems.trek.files.length === 0) {
    throw capabilityError('dem', 'dem trek needs the Moon Trek GeoTIFFs on the server and none are present (the API never downloads them)', dem.reason);
  }
  if (!dem.available) throw capabilityError('dem', `dem ${o.dem} is not available on this server: ${dem.reason ?? 'unavailable'}`, dem.reason);
  const method = o.dem === 'none' ? 'flat' : o.horizon_method;
  let nearEx: number | null = null;
  if (o.near_exclusion_m !== undefined && o.near_exclusion_m !== 'auto') {
    // lunarnav.precompute.make_horizon_fn rejects this combination (like the CLI): never drop it silently
    if (method === 'bruteforce' && o.near_exclusion_m > 0) {
      throw bodyError('near_exclusion_m', "near_exclusion_m applies to horizon_method raymarch only (bruteforce rejects it, like the CLI); use 'auto' or 0");
    }
    if (!caps.cli.near_exclusion_m) {
      throw capabilityError('near_exclusion_m', 'near_exclusion_m needs a lunarnav CLI with --near-exclusion-m (capabilities.cli.near_exclusion_m is false)', null);
    }
    if (method === 'raymarch') nearEx = o.near_exclusion_m;
  }
  return {
    step_min: o.step_min,
    provider: o.provider,
    dem: o.dem,
    horizon_method: method,
    radius_km: o.radius_km,
    az_step_deg: o.az_step_deg,
    observer_height_m: o.observer_height_m,
    min_clearance_deg: o.min_clearance_deg,
    dem_fallback: o.dem_fallback,
    near_exclusion_m: nearEx,
  };
}

/** Canonical ComputeOptions -> lunarnav `_add_common` flags (one `--flag=value` element each). */
export function computeFlags(p: ComputeParams): string[] {
  const f = [
    flagArg('--step-min', p.step_min),
    flagArg('--provider', p.provider),
    flagArg('--dem', p.dem),
    flagArg('--horizon-method', p.horizon_method),
    flagArg('--radius-km', p.radius_km),
    flagArg('--az-step', p.az_step_deg),
    flagArg('--observer-height', p.observer_height_m),
    flagArg('--min-clearance', p.min_clearance_deg),
    flagArg('--dem-fallback', p.dem_fallback),
  ];
  if (p.near_exclusion_m !== null) f.push(flagArg('--near-exclusion-m', p.near_exclusion_m));
  return f;
}

/** Flags of `_add_common` the job types pass (checked against the CLI help output). */
export const COMMON_FLAGS = [
  '--sites',
  '--step-min',
  '--provider',
  '--dem',
  '--horizon-method',
  '--radius-km',
  '--az-step',
  '--observer-height',
  '--min-clearance',
  '--dem-fallback',
] as const;

/** def.available(): the installed CLI has the sub-command and the flags (when the probe could read them). */
export function cliAvailability(caps: Capabilities, sub: string, flags: readonly string[]): string | null {
  if (caps.cli.subcommands.length > 0 && !caps.cli.subcommands.includes(sub)) return `the lunarnav CLI has no ${sub} sub-command`;
  const have = caps.cli.flags[sub];
  if (have && have.length > 0) {
    const missing = flags.filter((f) => !have.includes(f));
    if (missing.length > 0) return `lunarnav ${sub} lacks ${missing.join(', ')}`;
  }
  return null;
}

// ---- shared: sites ---------------------------------------------------------------------------------
export interface CatalogSite {
  id: string;
  group: string | null;
  name: string | null;
}

const CatalogFile = z.object({
  sites: z.array(z.object({ id: z.string(), group: z.string().nullish(), name: z.string().nullish() }).loose()),
});

/** lunarnav/catalog/sites.json (ids, groups, names in catalog order) or null when unreadable. */
export async function readCatalog(cfg: SubmitContext['cfg']): Promise<CatalogSite[] | null> {
  try {
    const doc = CatalogFile.safeParse(JSON.parse(await readFile(lunarnavCatalogPath(cfg), 'utf8')));
    if (!doc.success) return null;
    return doc.data.sites.map((s) => ({ id: s.id, group: s.group ?? null, name: s.name ?? null }));
  } catch {
    return null;
  }
}

/** A canonical custom id from lat/lon (400 on bad coordinates). */
function customIdOf(lat: number, lon: number, field: string): string {
  try {
    roundCustom(lat, lon);
    return customSiteId(lat, lon);
  } catch (e) {
    throw bodyError(field, (e as Error).message);
  }
}

function checkCustomId(id: string, field: string): string {
  try {
    parseCustomSiteId(id);
    return id;
  } catch (e) {
    throw bodyError(field, (e as Error).message, { hint: 'custom ids are canonical custom:<lat>:<lon> with 4 decimals, or use custom_sites / lat_deg + lon_deg' });
  }
}

/**
 * Site selectors + custom coordinates -> sorted distinct canonical site ids. 'all' / 'group:<g>' expand
 * from the catalog; catalog ids are checked against it (404 SITE_NOT_FOUND); custom ids must be canonical.
 */
export async function resolveSiteIds(
  selection: string | readonly string[],
  custom: readonly { lat_deg: number; lon_deg: number }[],
  ctx: SubmitContext,
): Promise<string[]> {
  const selectors = typeof selection === 'string' ? [selection] : [...selection];
  const needsCatalog = selectors.some((s) => s === 'all' || s.startsWith('group:') || !isCustomSiteId(s));
  const catalog = needsCatalog ? await readCatalog(ctx.cfg) : null;
  const out = new Set<string>();
  selectors.forEach((sel, i) => {
    const field = typeof selection === 'string' ? 'sites' : `sites.${i}`;
    if (sel === 'all' || sel.startsWith('group:')) {
      if (!catalog) throw capabilityError('sites', `'${sel}' needs the lunarnav site catalog, which is not readable on this server`, 'catalog unreadable');
      const g = sel === 'all' ? null : sel.slice('group:'.length);
      const ids = catalog.filter((s) => g === null || s.group === g).map((s) => s.id);
      if (ids.length === 0) {
        const groups = [...new Set(catalog.map((s) => s.group).filter((x): x is string => !!x))].sort();
        throw bodyError(field, `no catalog site in group ${g ?? ''}`, { extensions: { groups } });
      }
      for (const id of ids) out.add(id);
    } else if (isCustomSiteId(sel)) {
      out.add(checkCustomId(sel, field));
    } else {
      if (catalog && !catalog.some((s) => s.id === sel)) throw catalogSiteNotFound(sel);
      out.add(sel);
    }
  });
  custom.forEach((c, i) => out.add(customIdOf(c.lat_deg, c.lon_deg, `custom_sites.${i}`)));
  if (out.size === 0) throw bodyError('sites', 'select at least one site (sites and/or custom_sites)');
  return [...out].sort();
}

/** One site of a single-site request: site_id (catalog / canonical custom) XOR lat_deg + lon_deg. */
export async function resolveSingleSite(
  body: { site_id?: string | undefined; lat_deg?: number | undefined; lon_deg?: number | undefined },
  ctx: SubmitContext,
): Promise<{ site_id: string; lat_deg: number | null; lon_deg: number | null }> {
  if (body.lat_deg !== undefined && body.lon_deg !== undefined) {
    const id = customIdOf(body.lat_deg, body.lon_deg, 'lon_deg');
    const r = parseCustomSiteId(id);
    return { site_id: id, lat_deg: r.lat, lon_deg: r.lon };
  }
  const id = body.site_id ?? '';
  if (isCustomSiteId(id)) {
    const r = parseCustomSiteId(checkCustomId(id, 'site_id'));
    return { site_id: id, lat_deg: r.lat, lon_deg: r.lon };
  }
  const ids = await ctx.catalogIds();
  if (ids && !ids.has(id)) throw catalogSiteNotFound(id);
  return { site_id: id, lat_deg: null, lon_deg: null };
}

// ---- shared: time range ----------------------------------------------------------------------------
const MIN_MS = parseIsoUtc(PRECOMPUTE_LIMITS.min_utc);
const MAX_MS = parseIsoUtc(PRECOMPUTE_LIMITS.max_utc);

/** Both instants inside [min_utc, max_utc) of the ephemeris sources (422 OUT_OF_RANGE). */
export function checkEpochs(fields: Record<string, number>): void {
  for (const [field, t] of Object.entries(fields)) {
    if (t < MIN_MS || t > MAX_MS) {
      throw new ApiError('OUT_OF_RANGE', `${field} must be within [${PRECOMPUTE_LIMITS.min_utc}, ${PRECOMPUTE_LIMITS.max_utc}]`, {
        errors: [{ path: field, in: 'body', message: 'outside the supported epochs' }],
        extensions: { min_utc: PRECOMPUTE_LIMITS.min_utc, max_utc: PRECOMPUTE_LIMITS.max_utc },
      });
    }
  }
}

export interface SnappedPeriod {
  start: string;
  end: string;
  n_samples: number;
}

/** start snapped DOWN, end UP to the step grid (UTC epoch multiples), end exclusive, epochs checked. */
export function snapPeriod(startIso: string, endIso: string, stepMin: number): SnappedPeriod {
  const stepMs = Math.round(stepMin * 60) * 1000;
  const start = Math.floor(parseIsoUtc(startIso) / stepMs) * stepMs;
  const end = Math.ceil(parseIsoUtcCeil(endIso) / stepMs) * stepMs;
  if (end <= start) throw bodyError('end', 'end must be after start');
  checkEpochs({ start, end });
  return { start: toIsoUtc(start), end: toIsoUtc(end), n_samples: Math.round((end - start) / stepMs) };
}

/** Size guard rails of precompute / analyse (422 JOB_TOO_LARGE), checked before anything is queued. */
export function checkJobSize(nSites: number, nSamples: number, provider: string): void {
  const L = PRECOMPUTE_LIMITS;
  const siteSamples = nSites * nSamples;
  const maxSiteSamples = provider === 'horizons' ? L.max_site_samples_horizons : L.max_site_samples;
  const ext = { n_sites: nSites, n_samples: nSamples, site_samples: siteSamples, max_sites: L.max_sites, max_samples_per_site: L.max_samples_per_site, max_site_samples: maxSiteSamples };
  const tooLarge = (msg: string, field: string): ApiError =>
    new ApiError('JOB_TOO_LARGE', msg, { errors: [{ path: field, in: 'body', message: msg }], hint: 'split the job (fewer sites, shorter range or a larger step_min)', extensions: ext });
  if (nSites > L.max_sites) throw tooLarge(`${nSites} sites selected; a job takes at most ${L.max_sites}`, 'sites');
  if (nSamples > L.max_samples_per_site) throw tooLarge(`${nSamples} samples per site; at most ${L.max_samples_per_site} (range / step_min)`, 'end');
  if (siteSamples > maxSiteSamples) {
    throw tooLarge(`${nSites} sites x ${nSamples} samples = ${siteSamples}; at most ${maxSiteSamples}${provider === 'horizons' ? ' with provider horizons' : ''}`, 'sites');
  }
}

// ---- precompute ------------------------------------------------------------------------------------
export type PrecomputeParams = {
  type: 'precompute';
  site_ids: string[];
  start: string;
  end: string;
  run_label: string | null;
} & ComputeParams;

/** Canonical params of precompute / analyse requests (without type / run_label). */
export async function canonicalRangeJob(
  req: Pick<PrecomputeJobRequest, 'sites' | 'custom_sites' | 'start' | 'end'> & ComputeOptions,
  ctx: SubmitContext,
): Promise<{ site_ids: string[]; start: string; end: string; n_samples: number } & ComputeParams> {
  const opts = await canonicalComputeOptions(req, ctx);
  const period = snapPeriod(req.start, req.end, opts.step_min);
  const siteIds = await resolveSiteIds(req.sites, req.custom_sites, ctx);
  checkJobSize(siteIds.length, period.n_samples, opts.provider);
  return { site_ids: siteIds, ...period, ...opts };
}

export const samplesOf = (p: { start: string; end: string; step_min: number }): number =>
  Math.round((parseIsoUtc(p.end) - parseIsoUtc(p.start)) / (Math.round(p.step_min * 60) * 1000));

/** sites.json of a precompute output (the fields this type reads). */
const SitesJson = z.object({
  sites: z.array(
    z
      .object({
        id: z.string(),
        name: z.string().nullish(),
        dem_source: z.string().nullish(),
        horizon_method: z.string().nullish(),
      })
      .loose(),
  ),
});

export const PRECOMPUTE_TIMEOUT_S = 3600;
export const DEFAULT_PRECOMPUTE_RUN_TTL_DAYS = 7;
const precomputeRunTtlDays = (cfg: TtlConfig): number => cfg.PRECOMPUTE_RUN_TTL_DAYS ?? DEFAULT_PRECOMPUTE_RUN_TTL_DAYS;

export const precomputeJob = defineJobType<PrecomputeJobRequest, PrecomputeParams>({
  type: 'precompute',
  implemented: true,
  owner: 'builder B1 (compute)',
  summary: 'lunarnav precompute for catalog and/or custom sites, imported as a new run (kind precompute; result.run_id)',
  label: 'lunarnav precompute',
  logName: 'precompute.log',
  pythonStage: 'precompute',
  limits: {
    timeout_s: PRECOMPUTE_TIMEOUT_S,
    public: { ...PRECOMPUTE_LIMITS },
    creates_run: true,
  },

  // API-created runs can be large: kept PRECOMPUTE_RUN_TTL_DAYS (default 7), not CUSTOM_RUN_TTL_DAYS
  resultTtlH: (cfg) => precomputeRunTtlDays(cfg) * 24,

  available: (caps) => cliAvailability(caps, 'precompute', [...COMMON_FLAGS, '--start', '--end', '--out', '--run-timestamp']),

  async canonicalize(req, ctx) {
    const { n_samples: _n, ...rest } = await canonicalRangeJob(req, ctx);
    return { type: 'precompute', ...rest, run_label: req.run_label ?? null };
  },

  siteId: (p) => (p.site_ids.length === 1 ? (p.site_ids[0] ?? null) : null),

  planPython: (p, run) => ({
    args: lunarnavCliArgs('precompute', [
      flagArg('--sites', p.site_ids.join(',')),
      flagArg('--start', p.start),
      flagArg('--end', p.end),
      ...computeFlags(p),
      flagArg('--out', run.outDir),
      flagArg('--run-timestamp', toIsoUtc(run.createdAt)),
    ]),
  }),

  progress: (line, prev) => progressFromLine(line, prev),

  failureReason: (lines, exitCode) => failureReason(lines, exitCode),

  async onSuccess(p, run) {
    await run.setProgress('import', 95);
    // the output must hold exactly the requested sites before it becomes a run
    let sites: z.output<typeof SitesJson>['sites'];
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(run.outDir, 'sites.json'), 'utf8'));
      sites = SitesJson.parse(raw).sites;
    } catch (e) {
      throw new JobFailure('IMPORT_FAILED', run.sanitize(`precompute output has no readable sites.json: ${(e as Error).message}`));
    }
    const got = new Set(sites.map((s) => s.id));
    const missing = p.site_ids.filter((id) => !got.has(id));
    if (missing.length > 0) throw new JobFailure('IMPORT_FAILED', `precompute output lacks ${missing.length} requested site(s): ${missing.slice(0, 5).join(', ')}`);

    const label = p.run_label ?? run.name ?? `precompute ${p.site_ids.length === 1 ? p.site_ids[0] : `${p.site_ids.length} sites`} ${p.start.slice(0, 10)}..${p.end.slice(0, 10)}`;
    const expiresAt = new Date(Date.now() + precomputeRunTtlDays(run.cfg) * 24 * 3_600_000);
    try {
      await getImporter()({
        sourceDir: run.outDir,
        runId: run.runId,
        jobId: run.jobId,
        label,
        expiresAt,
        dataDir: run.cfg.DATA_DIR,
        catalogPath: lunarnavCatalogPath(run.cfg),
        kind: 'precompute',
      });
    } catch (e) {
      run.log.error({ err: e, jobId: run.jobId }, 'precompute job import failed');
      await purgeRunDocs(getDb(), run.runId).catch(() => undefined);
      throw new JobFailure('IMPORT_FAILED', run.sanitize(importErrorMessage(e)));
    }
    await run.setProgress('artifacts', 98);
    await copyFile(path.join(run.outDir, 'summary.csv'), path.join(run.artifactsDir, 'summary.csv')).catch(() => undefined);

    const byId = new Map(sites.map((s) => [s.id, s]));
    const output = PrecomputeJobOutput.parse({
      run_id: run.runId,
      run_label: label,
      n_sites: p.site_ids.length,
      start: p.start,
      end: p.end,
      step_min: p.step_min,
      n_samples: samplesOf(p),
      sites: p.site_ids.map((id) => {
        const s = byId.get(id);
        const demSource = s?.dem_source ?? null;
        return {
          site_id: id,
          name: s?.name ?? id,
          dem_source: demSource,
          horizon_method: s?.horizon_method ?? p.horizon_method,
          dem_fallback: demSource !== null && /^none:outside-/.test(demSource),
        };
      }),
    });
    return { result: { run_id: run.runId, site_id: p.site_ids[0] ?? '' }, output, expiresAt };
  },

  async onDiscard(_p, run, outcome) {
    await purgeRunDocs(getDb(), outcome.result?.run_id ?? run.runId);
    await rm(run.outDir, { recursive: true, force: true });
  },
});
