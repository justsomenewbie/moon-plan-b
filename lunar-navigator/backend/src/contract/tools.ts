/**
 * Synchronous Python tools (docs/PYTHON_INTEGRATION.md section 3.3).
 * OWNER: builder B4 (tools). Only the owner edits this file and src/routes/tools.ts.
 *
 *   POST /api/v1/tools/ephemeris  site or lat/lon, <= 200 UTC times, provider spice|analytic|horizons
 *                                 -> Sun / Earth az / el / dist per time (backend/python/ephemeris_json.py)
 *   POST /api/v1/tools/horizon    lat/lon or site, dem pgda|none, method raymarch|flat, radius <= 60 km,
 *                                 near_exclusion_m -> terrain horizon mask (backend/python/horizon_json.py).
 *                                 Bigger requests (radius > 60 km, az step < 0.25 deg, bruteforce, trek):
 *                                 POST /api/v1/jobs (job type horizon_mask / custom_site).
 *
 * Numbers are computed exactly like `lunarnav precompute` (same provider defaults, same horizon factory
 * make_horizon_fn) and, with `rounding: 'run_files'` (default), rounded like the run files (angles 1e-6 deg,
 * distances 1 m): a SPICE ephemeris of a run's site with its run heights equals the imported values exactly.
 *
 * TOOLS_IMPLEMENTED feeds GET /capabilities `tools`.
 */
import { z } from 'zod';
import { IsoUtc, IsoUtcInput, Lat, LonEast, RunId, SiteId } from './common.ts';
import { NearExclusion } from './job_types/common.ts';

export const TOOL_NAMES = ['ephemeris', 'horizon'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOLS_IMPLEMENTED: Record<ToolName, boolean> = {
  ephemeris: true,
  horizon: true,
};

/** Hard limits of the synchronous tools (bigger requests: async jobs). */
export const TOOLS_LIMITS = {
  /** POST /tools/ephemeris: times per request. */
  ephemeris_max_times: 200,
  /** Instants accepted by every provider (SPICE de440s covers 1849-12-26 .. 2150-01-22). */
  time_min: '1900-01-01T00:00:00Z',
  time_max: '2149-12-31T23:59:59Z',
  /** POST /tools/horizon */
  horizon_radius_km_max: 60,
  horizon_az_step_deg_min: 0.25,
  horizon_az_step_deg_max: 10,
  observer_height_m_max: 100,
  surface_height_m_abs_max: 20_000,
  /** Python child timeouts = ALTDATES_TIMEOUT_S (sync bridge timeout, default 30 s) x factor. */
  ephemeris_timeout_factor: 1,
  horizon_timeout_factor: 2,
  /** Concurrent tool computations per server; more waiting than max_pending -> 429 QUEUE_FULL. */
  concurrency: 2,
  max_pending: 8,
  /**
   * Tool computations one client (IP, IPv6 /64) may have waiting or running at once (both tools together);
   * beyond it 429 TOO_MANY_JOBS. A request whose client disconnects leaves the queue / has its Python killed.
   */
  max_pending_per_client: 2,
} as const;

export const ToolProvider = z
  .enum(['spice', 'analytic', 'horizons'])
  .describe('horizons = JPL Horizons API (network; the default); spice = NAIF DE440 + MOON_ME (local kernels, works offline); analytic = ERFA series + IAU_MOON (approximate, <~0.011 deg)');

export const ToolRounding = z
  .enum(['run_files', 'none'])
  .describe('run_files = rounded like the precompute run files (angles 1e-6 deg, distances 1 m; azimuth wrapped to [0, 360)) so values compare exactly with imported runs; none = full float64');

const lonInput = z
  .number()
  .min(-360)
  .max(360)
  .describe('Longitude, deg; EAST-positive (west-negative values are converted to [0, 360))');

/** site_id XOR lat_deg + lon_deg; run_id only with site_id. */
export const siteFields = {
  site_id: SiteId.optional().describe('Catalog id or canonical custom id (custom:<lat>:<lon>) - XOR lat_deg/lon_deg'),
  run_id: RunId.optional().describe(
    'Only with site_id: imported run whose site record supplies the coordinates (and heights for the ephemeris). ' +
      'Default: the default run, when it contains the site; otherwise the lunarnav catalog.',
  ),
  lat_deg: Lat.optional(),
  lon_deg: lonInput.optional(),
};

type SiteFieldsIn = { site_id?: string | undefined; run_id?: string | undefined; lat_deg?: number | undefined; lon_deg?: number | undefined };

export function refineSite<T extends z.ZodType<SiteFieldsIn>>(schema: T) {
  return schema
    .refine((b) => (b.site_id !== undefined) !== (b.lat_deg !== undefined || b.lon_deg !== undefined), {
      message: 'give either site_id or lat_deg + lon_deg (not both)',
    })
    .refine((b) => (b.lat_deg === undefined) === (b.lon_deg === undefined), { message: 'lat_deg and lon_deg go together', path: ['lon_deg'] })
    .refine((b) => b.run_id === undefined || b.site_id !== undefined, { message: 'run_id needs site_id', path: ['run_id'] });
}

const wholeSecond = IsoUtcInput.refine((s) => !s.includes('.'), { message: 'fractional seconds are not supported (whole seconds only)' }).refine(
  (s) => s >= TOOLS_LIMITS.time_min && s <= TOOLS_LIMITS.time_max,
  { message: `must be within [${TOOLS_LIMITS.time_min}, ${TOOLS_LIMITS.time_max}]` },
);

// ---- POST /tools/ephemeris ---------------------------------------------------------------------------
export const SurfaceHeight = z
  .union([z.enum(['auto', 'run', 'dem', 'sphere']), z.number().min(-TOOLS_LIMITS.surface_height_m_abs_max).max(TOOLS_LIMITS.surface_height_m_abs_max)])
  .describe(
    'Surface height of the site above the 1737.4 km sphere, m. run = the site record of the run (exact parity with its stored ephemeris); ' +
      'dem = PGDA LOLA DEM height at the site (south polar sites, < 60 S; what a pgda precompute uses); sphere = 0; a number = that height. ' +
      'auto = run when the site is in the run, else dem when PGDA covers the site, else sphere.',
  );

const EphemerisRequestShape = z.strictObject({
  ...siteFields,
  times: z
    .array(wholeSecond)
    .min(1)
    .max(TOOLS_LIMITS.ephemeris_max_times)
    .describe(`UTC instants (1..${TOOLS_LIMITS.ephemeris_max_times}, whole seconds, any order, repeats allowed); rows come back in this order`),
  provider: ToolProvider.default('horizons'),
  surface_height: SurfaceHeight.default('auto'),
  observer_height_m: z
    .number()
    .min(0)
    .max(TOOLS_LIMITS.observer_height_m_max)
    .optional()
    .describe("Mast height above the surface, m. Default: the run's value when surface_height comes from a run, else 2"),
  rounding: ToolRounding.default('run_files'),
});
export type EphemerisRequest = z.output<typeof EphemerisRequestShape>;
export const EphemerisRequest = refineSite(EphemerisRequestShape).meta({
  id: 'EphemerisToolRequest',
  examples: [{ site_id: 'ref_connecting_ridge_c1', times: ['2026-01-01T00:00:00Z', '2026-02-03T05:00:00Z'], provider: 'spice' }],
});

export const ToolSite = z
  .object({
    site_id: SiteId.nullable().describe('Requested site id; null for lat/lon requests'),
    name: z.string().nullable(),
    lat_deg: Lat,
    lon_deg: LonEast,
    custom_site_id: SiteId.describe('Canonical custom id of these coordinates (4 decimals) - usable with POST /jobs custom_site'),
    source: z.enum(['run', 'catalog', 'custom_id', 'coordinates']).describe('Where the coordinates came from'),
    run_id: RunId.nullable().describe('Run whose site record was used (source = run), else null'),
  })
  .meta({ id: 'ToolSite' });
export type ToolSite = z.output<typeof ToolSite>;

export const EphemerisRow = z
  .object({
    time_utc: IsoUtc,
    sun_az_deg: z.number().describe('[0, 360) clockwise from local north'),
    sun_el_deg: z.number().describe('Sun center, airless apparent'),
    sun_dist_km: z.number(),
    earth_az_deg: z.number(),
    earth_el_deg: z.number(),
    earth_dist_km: z.number(),
  })
  .meta({ id: 'EphemerisRow' });

const EphemerisResponseShape = z.object({
  site: ToolSite,
  provider: ToolProvider,
  provider_config: z.record(z.string(), z.unknown()).describe('Public settings of the lunarnav provider (SPICE: lunar_set, frame, abcorr...)'),
  height: z.object({
    source: z.enum(['run', 'dem', 'sphere', 'value']),
    surface_height_m: z.number(),
    observer_height_m: z.number().describe('Mast'),
    observer_height_above_sphere_m: z.number().describe('Height of the observer above the 1737.4 km sphere actually used (surface + mast)'),
    dem_source: z.string().nullable().describe('DEM read for source = dem'),
    note: z.string().nullable().describe('Why auto chose this source (e.g. the site is outside the PGDA coverage)'),
  }),
  rounding: ToolRounding,
  n_times: z.int().min(1),
  rows: z.array(EphemerisRow),
  elapsed_ms: z.int().min(0).describe('Python computation time'),
});
export type EphemerisResponse = z.output<typeof EphemerisResponseShape>;
export const EphemerisResponse = EphemerisResponseShape.meta({ id: 'EphemerisToolResponse' });

// ---- POST /tools/horizon -----------------------------------------------------------------------------
const HorizonToolRequestShape = z.strictObject({
  ...siteFields,
  dem: z.enum(['pgda', 'none']).default('pgda').describe('pgda = LOLA PGDA product-90 bands (south polar, < 60 S); none = smooth sphere'),
  method: z.enum(['raymarch', 'flat']).default('raymarch').describe("Forced to 'flat' when dem = none (bruteforce: async job)"),
  radius_km: z
    .number()
    .positive()
    .max(TOOLS_LIMITS.horizon_radius_km_max)
    .default(TOOLS_LIMITS.horizon_radius_km_max)
    .describe(`Search radius, km (<= ${TOOLS_LIMITS.horizon_radius_km_max} here; precompute runs use 150 km -> POST /jobs for more)`),
  az_step_deg: z
    .number()
    .min(TOOLS_LIMITS.horizon_az_step_deg_min)
    .max(TOOLS_LIMITS.horizon_az_step_deg_max)
    .default(0.5)
    .refine((v) => Math.abs(360 / v - Math.round(360 / v)) < 1e-9, { message: 'must divide 360' })
    .describe('Azimuth step, deg (must divide 360)'),
  observer_height_m: z.number().min(0).max(TOOLS_LIMITS.observer_height_m_max).default(2).describe('Mast height above the surface, m'),
  near_exclusion_m: NearExclusion.optional(),
  dem_fallback: z
    .enum(['flat', 'error'])
    .default('flat')
    .describe('Site outside the DEM coverage: flat = smooth-sphere mask (dem_source none:outside-pgda-coverage), error = 422 OUT_OF_RANGE'),
  rounding: ToolRounding.default('run_files'),
});
export type HorizonToolRequest = z.output<typeof HorizonToolRequestShape>;
export const HorizonToolRequest = refineSite(HorizonToolRequestShape).meta({
  id: 'HorizonToolRequest',
  examples: [{ lat_deg: -89.45, lon_deg: 222.69, dem: 'pgda', radius_km: 60, az_step_deg: 1 }],
});

const HorizonToolResponseShape = z.object({
  site: ToolSite,
  method: z.enum(['raymarch', 'bruteforce', 'flat']).describe('bruteforce only in horizon_mask job artifacts'),
  dem_source: z.string().describe('e.g. pgda:bands[...], none, none:outside-pgda-coverage'),
  radius_km: z.number(),
  az_step_deg: z.number(),
  observer_height_m: z.number(),
  surface_height_m: z.number().describe('DEM surface height at the site above the 1737.4 km sphere (0 / catalog height for flat)'),
  near_exclusion_m: z.number().nullable().describe('Near-field exclusion actually applied by raymarch, m (null for flat)'),
  dem_fallback: z.string().nullable().describe('Why the smooth-sphere fallback was used (null = not used)'),
  rounding: ToolRounding,
  n_az: z.int().min(1),
  min_el_deg: z.number(),
  max_el_deg: z.number(),
  az_deg: z.array(z.number()),
  el_deg: z.array(z.number()).describe('Terrain horizon elevation per azimuth, deg (can be < 0)'),
  covered_radius_km: z.array(z.number()).describe('Radius actually searched per azimuth, km'),
  horizon_distance_km: z
    .array(z.number().nullable())
    .nullable()
    .describe('Distance of the horizon-setting terrain per azimuth, km (null when unknown / flat; an item is null where no terrain was found)'),
  elapsed_ms: z.int().min(0).describe('Python computation time'),
});
export type HorizonToolResponse = z.output<typeof HorizonToolResponseShape>;
export const HorizonToolResponse = HorizonToolResponseShape.meta({ id: 'HorizonToolResponse' });
