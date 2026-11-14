/**
 * Shared code of the B4 tools: POST /tools/ephemeris, POST /tools/horizon (src/routes/tools.ts) and the
 * async fallback job type 'horizon_mask' (./horizon_mask.ts). OWNER: builder B4 (tools).
 *
 *  - site resolution (site_id of a run / the lunarnav catalog / a canonical custom id, or lat/lon)
 *  - zod schemas of what the Python bridges print / write (backend/python/{ephemeris_json,horizon_json,
 *    tools_horizon_mask}.py; never trust Python output)
 *  - the horizon response builder (sync tool and job artifact are the same document)
 *
 * Kept out of src/routes/tools.ts so the job type does not import a route module (src/python/capabilities.ts
 * -> jobs registry -> horizon_mask.ts would otherwise close an import cycle through the route).
 */
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../../config.ts';
import type { Capabilities } from '../../contract/capabilities.ts';
import { EphemerisRow, type HorizonToolResponse, type ToolSite } from '../../contract/tools.ts';
import { ApiError, isApiError } from '../../lib/problem.ts';
import { getDefaultRunId, getSite, resolveRun, type SiteRecordDoc } from '../../repos/index.ts';
import { customSiteId, isCustomSiteId, parseCustomSiteId, roundCustom } from '../../python/customSiteId.ts';
import { lunarnavCatalogIds, lunarnavDataDir } from '../../python/lunarnav.ts';

// ---- what Python prints / writes (zod-validated) ---------------------------------------------------------
export const PySite = z.object({ id: z.string(), name: z.string(), lat_deg: z.number(), lon_deg: z.number(), height_m: z.number().nullable() });
export type PySite = z.output<typeof PySite>;
export const PyError = z.object({ type: z.string(), message: z.string() });

/** tools_common.run_tool protocol line: {"ok": true, "bridge_version", "result"} | {"ok": false, "error"}. */
export const pyEnvelope = <T extends z.ZodType>(result: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), bridge_version: z.int(), result }),
    z.object({ ok: z.literal(false), error: PyError }),
  ]);

export const PyEphemeris = z.object({
  site: PySite,
  provider: z.enum(['spice', 'analytic', 'horizons']),
  provider_config: z.record(z.string(), z.unknown()),
  height: z.object({
    source: z.enum(['run', 'dem', 'sphere', 'value']),
    surface_height_m: z.number(),
    observer_height_m: z.number(),
    observer_height_above_sphere_m: z.number(),
    dem_source: z.string().nullable(),
    note: z.string().nullable(),
  }),
  rows: z.array(EphemerisRow),
  elapsed_ms: z.int().min(0),
});

export const PyHorizon = z.object({
  site: PySite,
  method: z.enum(['raymarch', 'bruteforce', 'flat']),
  dem_source: z.string(),
  radius_km: z.number(),
  az_step_deg: z.number(),
  observer_height_m: z.number(),
  surface_height_m: z.number(),
  near_exclusion_m: z.number().nullable(),
  dem_fallback: z.string().nullable(),
  az_deg: z.array(z.number()),
  el_deg: z.array(z.number()),
  covered_radius_km: z.array(z.number()),
  horizon_distance_km: z.array(z.number().nullable()).nullable(),
  elapsed_ms: z.int().min(0),
});
export type PyHorizon = z.output<typeof PyHorizon>;

// ---- site resolution -------------------------------------------------------------------------------------
/** Site reference sent to the bridges (tools_common.resolve_site). Plain JSON: part of a job's params. */
export type SiteRef =
  | { kind: 'catalog' | 'custom_id'; site_id: string }
  | { kind: 'run'; site_id: string; lat_deg: number; lon_deg: number; name: string; height_m: number | null }
  | { kind: 'coordinates'; lat_deg: number; lon_deg: number };

export interface ResolvedSite {
  ref: SiteRef;
  source: ToolSite['source'];
  runId: string | null;
  record: SiteRecordDoc | null;
}

export interface SiteInput {
  site_id?: string | undefined;
  run_id?: string | undefined;
  lat_deg?: number | undefined;
  lon_deg?: number | undefined;
}

async function siteInRun(siteId: string, runId: string | undefined): Promise<{ runId: string; record: SiteRecordDoc } | null> {
  if (runId !== undefined) {
    const run = await resolveRun(runId); // RUN_NOT_FOUND / RUN_NOT_READY
    const view = await getSite(run._id, siteId);
    if (!view) throw new ApiError('SITE_NOT_FOUND', `site ${JSON.stringify(siteId)} is not in run ${run._id}`, { hint: 'omit run_id to use the lunarnav catalog' });
    return { runId: run._id, record: view.site_run.record };
  }
  let def: string | null;
  try {
    def = await getDefaultRunId();
  } catch (e) {
    if (isApiError(e) && e.code === 'SERVICE_UNAVAILABLE') return null; // no database: the catalog still works
    throw e;
  }
  if (def === null) return null;
  const run = await resolveRun(def).catch(() => null);
  if (!run) return null;
  const view = await getSite(run._id, siteId);
  return view ? { runId: run._id, record: view.site_run.record } : null;
}

/**
 * lat/lon rounded like a custom site id (4 decimals, east longitude in [0, 360)); site_id -> the site record of `run_id` (default: the
 * default run, when it contains the site), else the canonical custom id / the lunarnav catalog (resolved
 * by Python with lunarnav.sites.get_site, exactly like precompute). Throws 400 / 404 / 409 ApiErrors.
 */
export async function resolveToolSite(cfg: Pick<Config, 'LUNARNAV_ROOT'>, b: SiteInput): Promise<ResolvedSite> {
  if (b.site_id === undefined) {
    // zod guarantees lat_deg + lon_deg here. Rounded to the canonical custom-site grid (4 decimals): the
    // coordinates a precompute job uses for the same custom_sites entry, so values match its run exactly.
    let r: { lat: number; lon: number };
    try {
      r = roundCustom(b.lat_deg ?? 0, b.lon_deg ?? 0);
    } catch (e) {
      throw new ApiError('VALIDATION_ERROR', (e as Error).message, { errors: [{ path: 'lat_deg', in: 'body', message: (e as Error).message }] });
    }
    return { ref: { kind: 'coordinates', lat_deg: r.lat, lon_deg: r.lon }, source: 'coordinates', runId: null, record: null };
  }
  const siteId = b.site_id;
  const custom = isCustomSiteId(siteId);
  if (custom) {
    try {
      parseCustomSiteId(siteId);
    } catch (e) {
      throw new ApiError('VALIDATION_ERROR', (e as Error).message, { errors: [{ path: 'site_id', in: 'body', message: (e as Error).message }] });
    }
  }
  const inRun = await siteInRun(siteId, b.run_id);
  if (inRun) {
    const r = inRun.record;
    return {
      ref: { kind: 'run', site_id: siteId, lat_deg: r.lat_deg, lon_deg: r.lon_deg, name: r.name, height_m: r.height_m_input },
      source: 'run',
      runId: inRun.runId,
      record: r,
    };
  }
  if (custom) return { ref: { kind: 'custom_id', site_id: siteId }, source: 'custom_id', runId: null, record: null };
  const ids = await lunarnavCatalogIds(cfg);
  if (ids !== null && !ids.has(siteId)) {
    throw new ApiError('SITE_NOT_FOUND', `site ${JSON.stringify(siteId)} is neither in the lunarnav catalog nor in the default run`, {
      hint: 'GET /api/v1/sites lists site ids; or send lat_deg + lon_deg',
    });
  }
  return { ref: { kind: 'catalog', site_id: siteId }, source: 'catalog', runId: null, record: null };
}

export function toolSite(requestedSiteId: string | null, source: ToolSite['source'], runId: string | null, py: PySite): ToolSite {
  return {
    site_id: requestedSiteId,
    name: source === 'coordinates' ? null : py.name,
    lat_deg: py.lat_deg,
    lon_deg: py.lon_deg,
    custom_site_id: customSiteId(py.lat_deg, py.lon_deg),
    source,
    run_id: runId,
  };
}

// ---- capability checks -------------------------------------------------------------------------------------
export function requireAvailable(what: string, av: { available: boolean; reason: string | null }, field: string): void {
  if (!av.available) {
    throw new ApiError('CAPABILITY_UNAVAILABLE', `${what} is not available on this server: ${av.reason ?? 'unknown reason'}`, {
      errors: [{ path: field, in: 'body', message: av.reason ?? 'not available' }],
      hint: 'GET /api/v1/capabilities',
    });
  }
}

/** DEM + near_exclusion checks shared by POST /tools/horizon and the horizon_mask job. */
export function checkHorizonCapabilities(caps: Capabilities, o: { dem: 'pgda' | 'trek' | 'none'; near_exclusion_m?: number | 'auto' | undefined }): void {
  if (o.dem === 'trek' && caps.dems.trek.files.length === 0) {
    throw new ApiError('CAPABILITY_UNAVAILABLE', 'dem trek needs the Moon Trek GeoTIFFs on the server and none are present (the API never downloads them)', {
      errors: [{ path: 'dem', in: 'body', message: 'no Moon Trek GeoTIFF in LUNARNAV_DATA/dem' }],
      hint: 'GET /api/v1/capabilities',
    });
  }
  if (o.dem !== 'none') requireAvailable(`dem ${o.dem}`, caps.dems[o.dem], 'dem');
  // 'auto' = the lunarnav default (what omitting the field does): needs no capability, like precompute
  if (typeof o.near_exclusion_m === 'number' && !caps.cli.near_exclusion_m) {
    throw new ApiError('CAPABILITY_UNAVAILABLE', 'near_exclusion_m is not supported by the installed lunarnav', {
      errors: [{ path: 'near_exclusion_m', in: 'body', message: 'capabilities.cli.near_exclusion_m is false' }],
      hint: 'GET /api/v1/capabilities',
    });
  }
}

// ---- server paths out of client text -------------------------------------------------------------------------
export function sanitizeToolText(cfg: Pick<Config, 'LUNARNAV_ROOT' | 'DATA_DIR'>, s: string): string {
  let out = s;
  const dirs: [string, string][] = [
    [path.resolve(lunarnavDataDir(cfg)), '<LUNARNAV_DATA>'],
    [path.resolve(cfg.DATA_DIR), '<DATA_DIR>'],
    [path.resolve(cfg.LUNARNAV_ROOT), '<LUNARNAV_ROOT>'],
  ];
  for (const [dir, label] of dirs) {
    for (const d of new Set([dir, dir.split(path.sep).join('/'), dir.split(path.sep).join('\\')])) out = out.split(d).join(label);
  }
  return out.length > 500 ? `${out.slice(0, 500)}...` : out;
}

// ---- horizon response -------------------------------------------------------------------------------------------
/** Throws when the bridge's arrays do not line up (the caller maps it to PYTHON_FAILED / RESULT_FAILED). */
export function checkHorizonArrays(py: PyHorizon): number {
  const n = py.az_deg.length;
  if (n === 0 || py.el_deg.length !== n || py.covered_radius_km.length !== n || (py.horizon_distance_km !== null && py.horizon_distance_km.length !== n)) {
    throw new Error('horizon bridge returned arrays of different lengths');
  }
  return n;
}

export function horizonResponse(
  site: ToolSite,
  py: PyHorizon,
  rounding: HorizonToolResponse['rounding'],
  sanitize: (s: string) => string,
): HorizonToolResponse {
  const n = checkHorizonArrays(py);
  let min = Infinity;
  let max = -Infinity;
  for (const e of py.el_deg) {
    if (e < min) min = e;
    if (e > max) max = e;
  }
  return {
    site,
    method: py.method,
    dem_source: sanitize(py.dem_source),
    radius_km: py.radius_km,
    az_step_deg: py.az_step_deg,
    observer_height_m: py.observer_height_m,
    surface_height_m: py.surface_height_m,
    near_exclusion_m: py.near_exclusion_m,
    dem_fallback: py.dem_fallback === null ? null : sanitize(py.dem_fallback),
    rounding,
    n_az: n,
    min_el_deg: min,
    max_el_deg: max,
    az_deg: py.az_deg,
    el_deg: py.el_deg,
    covered_radius_km: py.covered_radius_km,
    horizon_distance_km: py.horizon_distance_km,
    elapsed_ms: py.elapsed_ms,
  };
}
