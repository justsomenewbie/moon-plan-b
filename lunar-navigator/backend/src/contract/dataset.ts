/**
 * GET /api/v1/dataset - everything the FE comparison page needs in ONE call (agreed with the FE dev):
 * run provenance, the visibility model in plain English, conventions, and per site: horizon curve,
 * a decimated Sun/Earth series that keeps every visibility transition, the visible windows, metrics
 * and threshold criteria over the requested range. snake_case like the rest of v1; the FE maps names
 * and units in its API layer.
 */
import { z } from 'zod';
import { IsoUtc, IsoUtcInput, Lat, LonEast, RunId, SiteId, StepS, csvList, runIdQuery } from './common.ts';
import { PlainSummary, PointingCore } from './pointing.ts';

export const DATASET_SCHEMA_VERSION = 'lunarnav-dataset-1' as const;
export const DATASET_EVIDENCE = 'computed-ephemeris' as const;
export const DATASET_INCLUDE = ['horizon', 'series', 'windows', 'metrics', 'criteria', 'pointing', 'survival_hint'] as const;
export type DatasetInclude = (typeof DATASET_INCLUDE)[number];
/** Parts returned when `include` is omitted (unchanged: pointing and survival_hint are opt-in). */
export const DATASET_DEFAULT_INCLUDE = ['horizon', 'series', 'windows', 'metrics', 'criteria'] as const satisfies readonly DatasetInclude[];

export const DATASET_LIMITS = {
  /** Per-site series cap (= the FE limit of 10 000 samples per series). */
  max_points_default: 10_000,
  max_points_max: 10_000,
  max_points_min: 16,
  /**
   * Safe payload: sum over the requested sites of the series points ACTUALLY returned (regular +
   * transition samples, counted before the series is read). ~90 bytes per point in JSON -> ~4.5 MB
   * uncompressed (the FE reader stops at 5 MiB), ~1 MB gzip. Windows and horizon bytes are not counted.
   */
  max_total_points: 50_000,
  max_sites: 100,
  max_criteria: 30,
  min_step_s: 3600,
  max_step_s: 2_678_400,
  default_criteria_hours: '24,72,168',
  /** Upper bound of night_load_w (include=survival_hint), W. */
  max_night_load_w: 1_000_000,
} as const;

// ---- query ----------------------------------------------------------------------------------------
const siteIdsQuery = z
  .string()
  .optional()
  .transform((s) =>
    s === undefined
      ? undefined
      : [
          ...new Set(
            s
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x.length > 0),
          ),
        ],
  )
  .pipe(z.array(SiteId).min(1).max(DATASET_LIMITS.max_sites).optional())
  .describe(`Comma separated site ids (max ${DATASET_LIMITS.max_sites}, duplicates ignored, response keeps this order). Default: every site of the run in sites.json order.`);

const criteriaHoursQuery = z
  .string()
  .default(DATASET_LIMITS.default_criteria_hours)
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .regex(/^\d+(\.\d+)?$/, 'expected a positive number of hours')
          .transform(Number)
          .pipe(z.number().positive().max(100_000)),
      )
      .min(1)
      .max(DATASET_LIMITS.max_criteria),
  )
  .transform((a) => [...new Set(a)].sort((x, y) => x - y))
  .describe(`Comma separated minimum durations in hours (> 0, max ${DATASET_LIMITS.max_criteria}; deduplicated and sorted ascending). Each one is evaluated against longest_both_h.`);

export const DatasetQuery = z.strictObject({
  run_id: runIdQuery,
  site_ids: siteIdsQuery,
  start: IsoUtcInput.optional().describe('Inclusive start (default: run start). Snapped DOWN to the sample grid.'),
  end: IsoUtcInput.optional().describe('EXCLUSIVE end (default: run end). Snapped UP to the sample grid. A range partly outside the run is clamped (coverage = partial); no overlap -> 422 OUT_OF_RANGE.'),
  step_s: z.coerce
    .number()
    .int()
    .min(DATASET_LIMITS.min_step_s)
    .max(DATASET_LIMITS.max_step_s)
    .optional()
    .describe(
      'Desired spacing of the series, seconds (default = the data step, 3600). The server keeps every k-th sample, k = floor(step_s / data step), ' +
        'PLUS both samples around every Sun/Earth visibility transition, and raises k further if needed so a site never exceeds max_points. ' +
        'The spacing actually used is series.step_s.',
    ),
  max_points: z.coerce
    .number()
    .int()
    .min(DATASET_LIMITS.max_points_min)
    .max(DATASET_LIMITS.max_points_max)
    .default(DATASET_LIMITS.max_points_default)
    .describe(
      `Cap on series points per site (default and max ${DATASET_LIMITS.max_points_max}), transition samples included. ` +
        `Also: the series points of all sites together must be <= ${DATASET_LIMITS.max_total_points}, else 422 OUT_OF_RANGE with title "Series point limit exceeded".`,
    ),
  horizon_step_deg: z.coerce
    .number()
    .pipe(z.union([z.literal(0.5), z.literal(1)]))
    .default(1)
    .meta({ enum: [0.5, 1] })
    .describe(
      'Azimuth step of the returned horizon curve: 1 (default, 361 points 0..360) or 0.5 (721 points, ~4 KB per site). ' +
        'The stored silhouette is 0.5 deg for most sites: 1 POINT-SAMPLES it at whole degrees (the half-degree samples are dropped, so a narrow ' +
        'peak between two whole degrees is not drawn and a Sun / Earth marker can appear on the wrong side of the drawn curve near it). ' +
        'Only 0.5 is exactly consistent with sun_visible / earth_visible; prefer it for rim sites (or all sites) when drawing markers against the horizon.',
    ),
  criteria_hours: criteriaHoursQuery,
  include: csvList(z.enum(DATASET_INCLUDE), {
    min: 1,
    max: DATASET_INCLUDE.length,
    default: DATASET_DEFAULT_INCLUDE.join(','),
    description:
      'Comma separated parts of each site to return: horizon, series, windows, metrics, criteria, pointing, survival_hint ' +
      `(default: ${DATASET_DEFAULT_INCLUDE.join(',')}; pointing and survival_hint are opt-in). Omitted parts are absent from sites[]. ` +
      'pointing -> sites[].now = where to point the solar panel and the antenna at range.start (same block as GET /sites/{site_id}/pointing); ' +
      'survival_hint -> sites[].survival_hint = the longest dark period of the range and the battery a night_load_w load needs to bridge it.',
  }),
  night_load_w: z.coerce
    .number()
    .min(0)
    .max(DATASET_LIMITS.max_night_load_w)
    .optional()
    .describe(
      'Reference load while the Sun is hidden, W, >= 0 (as POST /mission/survival night_load_w; include=survival_hint): survival_hint.required_battery_wh = the battery this load needs to bridge the longest ' +
        'dark period of the range (null when omitted). Ignored without survival_hint. For a real panel and day load use POST /mission/survival.',
    ),
});
export type DatasetQuery = z.output<typeof DatasetQuery>;

// ---- response ---------------------------------------------------------------------------------------
const DatasetRun = z
  .object({
    run_id: RunId,
    label: z.string(),
    provider: z.string().describe('Ephemeris provider (spice | horizons)'),
    dem: z.string().describe('Terrain model family (pgda | trek | flat ...)'),
    horizon_method: z.string().describe('bruteforce | raymarch | flat'),
    code_version: z.string().describe('lunarnav version that computed the run'),
    run_timestamp_utc: z.string().describe('When the precompute ran (manifest.json, verbatim)'),
    observer_height_m: z.number().describe('Mast height above the surface, m'),
    min_earth_clearance_deg: z.number().describe('Earth counts as visible when its centre is more than this above the terrain horizon'),
    git_commit: z.string().nullable().describe('Git commit of the lunarnav code that computed the run (null when unknown)'),
    manifest_sha256: z.string().describe('sha256 of the run manifest.json (lists every raw file with its sha256)'),
    manifest_url: z.string().describe('Path of the processing evidence: the run manifest.json (GET, same origin)'),
  })
  .meta({ id: 'DatasetRun' });

const DatasetModel = z
  .object({
    id: z.string().describe('Stable id of the visibility model'),
    label: z.string(),
    definition: z.string().describe('Plain-English definition of "visible"'),
    limits: z.array(z.string()).min(1).describe('Plain-English caveats to show next to the numbers'),
  })
  .meta({ id: 'DatasetModel' });

const DatasetRange = z
  .object({
    start: IsoUtc.describe('Snapped start actually used (requested start clamped to the run)'),
    end: IsoUtc.describe('Snapped EXCLUSIVE end actually used'),
    step_s: StepS.describe('Data step of the run, s (series.step_s is the spacing after decimation)'),
    n_samples: z.int().min(0).describe('Data samples in [start, end) per site'),
    requested_start: IsoUtc.describe('Requested start snapped to the grid, before clamping to the run'),
    requested_end: IsoUtc.describe('Requested end snapped to the grid, before clamping to the run'),
  })
  .meta({ id: 'DatasetRange' });

const DatasetConventions = z
  .object({
    time: z.string(),
    azimuth: z.string(),
    longitude: z.string(),
    latitude: z.string(),
    elevation: z.string(),
    distance: z.string(),
    height: z.string(),
    duration: z.string(),
    percent: z.string(),
  })
  .meta({ id: 'DatasetConventions' });

export const DatasetHorizon = z
  .object({
    step_deg: z.number().positive().describe('Azimuth step of az_deg'),
    az_deg: z.array(z.number()).describe('0, step, ..., 360 inclusive (the last point repeats azimuth 0 so the curve is closed)'),
    el_deg: z.array(z.number()).describe('Terrain horizon elevation, deg (periodic linear interpolation of the stored silhouette; exact where the grids coincide)'),
    min_el_deg: z.number(),
    max_el_deg: z.number(),
    source_step_deg: z.number().positive().describe('Azimuth step of the stored silhouette'),
    method: z.string().describe('bruteforce | raymarch | flat'),
    dem_source: z.string(),
  })
  .meta({ id: 'DatasetHorizon' });

export const DatasetSeries = z
  .object({
    t: z.array(IsoUtc).describe('Sample instants, strictly increasing (irregular where transition samples were kept)'),
    sun_az_deg: z.array(z.number()).describe('Sun centre azimuth [0,360), clockwise from north'),
    sun_el_deg: z.array(z.number()).describe('Sun centre elevation, deg (airless)'),
    sun_visible: z.array(z.boolean()).describe('Upper solar limb above the terrain horizon'),
    earth_az_deg: z.array(z.number()),
    earth_el_deg: z.array(z.number()),
    earth_visible: z.array(z.boolean()).describe('Earth centre above the terrain horizon + min_earth_clearance_deg'),
    both_visible: z.array(z.boolean()).describe('sun_visible AND earth_visible'),
    step_s: z.int().positive().describe('Spacing of the regular samples actually used, s (multiple of the data step). PER SITE: max_points can raise it differently for each site'),
    decimated: z.boolean().describe('false = every data sample of the range is present'),
    n_transitions: z.int().min(0).describe('Sun / Earth visibility changes inside the range; both samples around each are always present'),
  })
  .describe(
    'Columnar series (all arrays have the same length, <= max_points). Decimation keeps sample 0, every k-th sample, the last sample, and the samples ' +
      'i-1 and i around every change of sun_visible or earth_visible, so a rise or set is never lost (exact to +- one data step). ' +
      'When decimated, t is IRREGULAR (transition samples sit between the regular ones): plot by timestamp. The last sample is range.end - range.step_s ' +
      '(end is exclusive). Use the *_visible flags (or windows) for visibility: they are NOT el > 0 (Sun upper limb, Earth centre + clearance, terrain horizon, mast height).',
  )
  .meta({ id: 'DatasetSeries' });

export const DatasetWindow = z
  .object({
    start: IsoUtc.describe('First sample of the visible interval (inside the range)'),
    end: IsoUtc.describe('EXCLUSIVE end (first sample after it, or range end)'),
    duration_h: z.number().min(0),
    clipped_start: z.boolean().describe('The true start is earlier or unknown: cut by the range start, or the run starts inside the interval'),
    clipped_end: z.boolean().describe('The true end is later or unknown: cut by the range end, or the run ends inside the interval'),
  })
  .meta({ id: 'DatasetWindow' });

export const DatasetWindows = z
  .object({
    sun: z.array(DatasetWindow).describe('Sun visible'),
    earth: z.array(DatasetWindow).describe('Earth visible (direct-to-Earth link possible)'),
    both: z.array(DatasetWindow).describe('Sun AND Earth visible'),
  })
  .describe('ONLY the visible intervals inside the range, sorted by start (boundaries +- one data step)')
  .meta({ id: 'DatasetWindows' });

export const DatasetMetrics = z
  .object({
    duration_h: z.number().min(0).describe('Length of the evaluated range (= range), h'),
    pct_sun: z.number().min(0).max(100),
    pct_earth: z.number().min(0).max(100),
    pct_both: z.number().min(0).max(100),
    sun_hours: z.number().min(0),
    earth_hours: z.number().min(0),
    both_hours: z.number().min(0),
    longest_sun_h: z.number().min(0),
    longest_earth_h: z.number().min(0),
    longest_both_h: z.number().min(0),
    longest_dark_h: z.number().min(0).describe('Longest continuous period without Sun, h'),
    longest_comms_gap_h: z.number().min(0).describe('Longest continuous period without Earth, h'),
    mean_power_tracking_pct: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        'Energy proxy: mean output of a 2-axis Sun-tracking panel over the stored samples of the range, % of its output in full sunlight ' +
          '(= 100 * mean power_tracking = 100 * mean sun_fraction; whole run -> 100 * summary.csv mean_power_tracking). null when no sample is stored',
      ),
    mean_power_horizontal_pct: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        'Energy proxy: mean output of a flat-lying panel, % of a panel facing the Sun in full sunlight ' +
          '(= 100 * mean power_horizontal = 100 * mean sun_fraction * max(0, sin el); tiny near the poles where the Sun is low). null when no sample is stored',
      ),
  })
  .describe('Over the REQUESTED range (clamped to the run). Whole run -> pct_* / longest_* equal summary.csv exactly.')
  .meta({ id: 'DatasetMetrics' });

export const DatasetSurvivalHint = z
  .object({
    longest_dark_h: z.number().min(0).describe('Longest continuous period without Sun inside the range, h (= metrics.longest_dark_h)'),
    longest_dark_start: IsoUtc.nullable().describe('First sample of that dark period inside the range (the first one when several are equally long); null when the range has no dark sample'),
    longest_dark_end: IsoUtc.nullable().describe('EXCLUSIVE end of that dark period inside the range (the sunrise sample, or range.end)'),
    longest_dark_clipped: z
      .boolean()
      .describe(
        'A dark period of length longest_dark_h is cut by the range or the run boundary: the real longest night may be longer, so longest_dark_h and required_battery_wh are LOWER bounds',
      ),
    night_load_w: z.number().min(0).nullable().describe('Reference night load of the request (query night_load_w); null when not given'),
    required_battery_wh: z
      .number()
      .min(0)
      .nullable()
      .describe(
        'Smallest usable battery capacity (starting full, allowed down to 0) that runs night_load_w through EVERY dark period of the range when the panel ' +
          'refills it during each lit period; = night_load_w * longest_dark_h. null when night_load_w is not given',
      ),
    summary: PlainSummary,
  })
  .describe('Battery sizing hint for a reference night load (include=survival_hint). Simplified on purpose; POST /mission/survival simulates a real panel, day load and state of charge hour by hour.')
  .meta({ id: 'DatasetSurvivalHint' });

export const CriterionResult = z.enum(['meets', 'below', 'borderline']).meta({ id: 'CriterionResult' });

export const DatasetCriterion = z
  .object({
    minimum_hours: z.number().positive(),
    metric: z.literal('longest_both_h'),
    value_h: z.number().min(0).describe('longest_both_h of the site over the range'),
    value_clipped: z
      .boolean()
      .describe('A longest interval is cut by the range or run boundary: the full interval may be longer outside the range (show e.g. "may be longer" next to a below result)'),
    result: CriterionResult.describe(
      'Rise / set times are known to one data step: a start after the range start can add up to one step, an end not cut by the range end (clipped_end false) can remove up to one step; ' +
        'a start at the range start and a clipped end are exact inside the range. ' +
        'meets = every possible true in-range length >= minimum_hours, below = every possible length < minimum_hours, else borderline. ' +
        'With both edges sampled: borderline <=> |value_h - minimum_hours| < one data step; with both edges cut by the range: meets or below, never borderline.',
    ),
    reason: z.string(),
  })
  .meta({ id: 'DatasetCriterion' });

export const DatasetSite = z
  .object({
    id: SiteId,
    name: z.string(),
    group: z.string(),
    lat_deg: Lat,
    lon_deg: LonEast,
    surface_height_m: z.number().describe('m above the 1737.4 km sphere'),
    coverage: z
      .enum(['complete', 'partial', 'missing'])
      .describe('Against the REQUESTED range: complete = a stored sample for every grid instant of [range.requested_start, range.requested_end); partial = some missing (range clamped to the run, or gaps); missing = none'),
    coverage_in_range: z
      .enum(['complete', 'partial', 'missing'])
      .describe('Same, against the range actually used [range.start, range.end) (after clamping to the run). complete here = every number of this site is fully backed by data'),
    horizon: DatasetHorizon.optional(),
    series: DatasetSeries.optional(),
    windows: DatasetWindows.optional(),
    metrics: DatasetMetrics.nullable().optional().describe('null when coverage = missing'),
    criteria: z.array(DatasetCriterion).optional().describe('One per criteria_hours value; empty when coverage = missing'),
    now: PointingCore.nullable()
      .optional()
      .describe(
        'include=pointing: where to point the solar panel and the antenna at range.start (t = sample_utc = range.start; the same block as GET /sites/{site_id}/pointing). ' +
          'null when that sample is not stored',
      ),
    survival_hint: DatasetSurvivalHint.nullable().optional().describe('include=survival_hint; null when coverage = missing'),
  })
  .describe('Parts not listed in `include` are absent')
  .meta({ id: 'DatasetSite' });

export const DatasetSource = z
  .object({
    id: z.string().regex(/^[a-z0-9._-]{1,100}$/),
    title: z.string(),
    url: z.string().nullable(),
    sha256: z.string().nullable(),
  })
  .meta({ id: 'DatasetSource' });

const DatasetResponseShape = z.object({
  schema_version: z.literal(DATASET_SCHEMA_VERSION),
  dataset_id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).describe('<run_id>.<hash of the selection (sites, range, step, limits, include, criteria)>'),
  evidence: z.literal(DATASET_EVIDENCE),
  attribution: z.string(),
  run: DatasetRun,
  model: DatasetModel,
  range: DatasetRange,
  conventions: DatasetConventions,
  criteria_hours: z.array(z.number().positive()),
  include: z.array(z.enum(DATASET_INCLUDE)),
  night_load_w: z.number().min(0).nullable().optional().describe('include=survival_hint: the night_load_w used (null when not given)'),
  assumptions: z
    .object({
      pointing: z.array(z.string()).min(1).optional().describe('Assumptions of sites[].now (include=pointing)'),
      survival_hint: z.array(z.string()).min(1).optional().describe('Assumptions of sites[].survival_hint and of metrics.mean_power_* (include=survival_hint)'),
    })
    .optional()
    .describe('Present when include has pointing or survival_hint: every assumption behind those numbers, in plain English'),
  sites: z.array(DatasetSite),
  sources: z.array(DatasetSource),
});
export type DatasetResponse = z.output<typeof DatasetResponseShape>;
export type DatasetSite = z.output<typeof DatasetSite>;
export type DatasetWindow = z.output<typeof DatasetWindow>;
export type DatasetMetrics = z.output<typeof DatasetMetrics>;
/** Metrics computed from the windows alone (dataset_build.rangeMetrics); mean_power_* come from the series sums. */
export type DatasetWindowMetrics = Omit<DatasetMetrics, 'mean_power_tracking_pct' | 'mean_power_horizontal_pct'>;
export type DatasetSurvivalHint = z.output<typeof DatasetSurvivalHint>;
export type DatasetCriterion = z.output<typeof DatasetCriterion>;
export type DatasetHorizon = z.output<typeof DatasetHorizon>;
export type DatasetSeries = z.output<typeof DatasetSeries>;
export const DatasetResponse = DatasetResponseShape.meta({ id: 'DatasetResponse' });
