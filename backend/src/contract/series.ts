/**
 * Hourly time series (plan 6.2 #7 series - timeline curves + Sun/Earth tracks on the sky diagram)
 * and #9 instant (readout at the timeline slider position).
 * Field names = columns of visibility.csv.gz (docs/OUTPUT_SPEC.md 3.5).
 */
import { z } from 'zod';
import { IsoUtc, IsoUtcInput, SiteId, StepS, WindowKind, csvList, provenance, runIdQuery } from './common.ts';
import { exampleHorizon, exampleInstant, exampleSeries, stubSeries, STUB_FOCUS_SITE } from '../fixtures/index.ts';
import { MS_PER_H, parseIsoUtc, toIsoUtc } from '../lib/time.ts';

export interface SeriesFieldInfo {
  name: string;
  unit: string;
  type: 'number' | 'boolean';
  nullable: boolean;
  description: string;
}

/** Every series field (= visibility.csv.gz columns except time_utc), in file order. */
export const SERIES_FIELD_INFO = [
  { name: 'sun_az_deg', unit: 'deg', type: 'number', nullable: false, description: 'Sun azimuth [0,360), clockwise from local north' },
  { name: 'sun_el_deg', unit: 'deg', type: 'number', nullable: false, description: 'Sun center elevation (airless, apparent)' },
  { name: 'sun_dist_km', unit: 'km', type: 'number', nullable: false, description: 'Observer -> Sun center distance' },
  { name: 'sun_semidiam_deg', unit: 'deg', type: 'number', nullable: false, description: 'Solar angular semi-diameter' },
  { name: 'horizon_el_sun_deg', unit: 'deg', type: 'number', nullable: false, description: 'Terrain horizon elevation at the Sun azimuth' },
  { name: 'sun_clearance_deg', unit: 'deg', type: 'number', nullable: false, description: 'sun_el - horizon_el_sun (Sun center)' },
  { name: 'sun_fraction', unit: '1', type: 'number', nullable: false, description: 'Visible fraction of the solar disc (0..1)' },
  { name: 'sun_visible', unit: 'bool', type: 'boolean', nullable: false, description: 'Upper limb above the terrain horizon' },
  { name: 'power_horizontal', unit: '1', type: 'number', nullable: false, description: 'Relative power of a flat-lying panel (0..1)' },
  { name: 'power_tracking', unit: '1', type: 'number', nullable: false, description: 'Relative power of a Sun-tracking panel (0..1)' },
  { name: 'irradiance_tracking_wm2', unit: 'W/m2', type: 'number', nullable: false, description: 'Irradiance on a Sun-tracking panel' },
  { name: 'earth_az_deg', unit: 'deg', type: 'number', nullable: false, description: 'Earth azimuth [0,360)' },
  { name: 'earth_el_deg', unit: 'deg', type: 'number', nullable: false, description: 'Earth center elevation' },
  { name: 'earth_dist_km', unit: 'km', type: 'number', nullable: false, description: 'Observer -> Earth center distance' },
  { name: 'earth_semidiam_deg', unit: 'deg', type: 'number', nullable: false, description: 'Earth angular semi-diameter' },
  { name: 'horizon_el_earth_deg', unit: 'deg', type: 'number', nullable: false, description: 'Terrain horizon elevation at the Earth azimuth' },
  { name: 'earth_clearance_deg', unit: 'deg', type: 'number', nullable: false, description: 'earth_el - horizon_el_earth' },
  { name: 'earth_fraction', unit: '1', type: 'number', nullable: false, description: 'Visible fraction of the Earth disc (informative)' },
  { name: 'earth_visible', unit: 'bool', type: 'boolean', nullable: false, description: 'earth_clearance > min_earth_clearance_deg (DTE link possible)' },
  { name: 'both_visible', unit: 'bool', type: 'boolean', nullable: false, description: 'sun_visible AND earth_visible' },
  { name: 'hours_until_sunset', unit: 'h', type: 'number', nullable: true, description: '0 if dark; else hours to the next dark window; null = none before run end' },
  { name: 'hours_until_sunrise', unit: 'h', type: 'number', nullable: true, description: '0 if lit; else hours to the next sunrise; null = none before run end' },
  { name: 'hours_until_earthset', unit: 'h', type: 'number', nullable: true, description: '0 if Earth not visible; else hours to the next comms gap' },
  { name: 'hours_until_earthrise', unit: 'h', type: 'number', nullable: true, description: '0 if Earth visible; else hours to the next Earth rise' },
] as const satisfies readonly SeriesFieldInfo[];

export type SeriesFieldName = (typeof SERIES_FIELD_INFO)[number]['name'];
export const SERIES_FIELDS = SERIES_FIELD_INFO.map((f) => f.name) as [SeriesFieldName, ...SeriesFieldName[]];
export const BOOLEAN_SERIES_FIELDS: ReadonlySet<string> = new Set(
  SERIES_FIELD_INFO.filter((f) => f.type === 'boolean').map((f) => f.name),
);

export const SERIES_LIMITS = {
  max_fields: 8,
  max_points_default: 2000,
  max_points_max: 5000,
  default_fields: 'sun_el_deg,earth_el_deg,sun_visible,earth_visible',
} as const;

export const SeriesField = z.enum(SERIES_FIELDS).describe('A visibility.csv column name').meta({ id: 'SeriesField' });

export const SeriesAgg = z
  .enum(['sample', 'minmax'])
  .describe(
    'Downsampling when the range has more samples than max_points (bins of bin_s = ceil(n / max_points) * step_s, aligned on start; ' +
      'the last bin may be partial). sample: value of the first sample of each bin. minmax: {min,max} per bin for numbers ' +
      '(elevation extremes are preserved, e.g. draw a band between min and max); booleans -> fraction of true samples in the bin ' +
      '(0..1, same value in min and max; 0 < value < 1 <=> the bin contains a transition). In both modes the exact transitions ' +
      'are listed in `events`. With bin_s = step_s, agg=sample returns the stored values unchanged.',
  );

const fieldsQuery = csvList(SeriesField, {
  min: 1,
  max: SERIES_LIMITS.max_fields,
  default: SERIES_LIMITS.default_fields,
  description: `Comma separated field names (max ${SERIES_LIMITS.max_fields}), see GET /api/v1/meta series_fields`,
});

const maxPointsQuery = z.coerce
  .number()
  .int()
  .min(2)
  .max(SERIES_LIMITS.max_points_max)
  .default(SERIES_LIMITS.max_points_default)
  .describe('Maximum number of points per field; above it the server picks bin_s (a multiple of step_s)');


export const SeriesQuery = z.strictObject({
  run_id: runIdQuery,
  start: IsoUtcInput.optional().describe('Inclusive start (default: run start). Snapped DOWN to the sample grid.'),
  end: IsoUtcInput.optional().describe('EXCLUSIVE end (default: run end). Snapped UP to the sample grid.'),
  fields: fieldsQuery,
  max_points: maxPointsQuery,
  agg: SeriesAgg.default('sample'),
});
export type SeriesQuery = z.output<typeof SeriesQuery>;

const NumArr = z.array(z.number().nullable());
const BoolArr = z.array(z.boolean().nullable());
export const MinMax = z.object({ min: NumArr, max: NumArr }).meta({ id: 'SeriesMinMax' });

export const SeriesValues = z
  .union([NumArr, BoolArr, MinMax])
  .describe('agg=sample: array of values (number | boolean | null); agg=minmax: {min:[...], max:[...]}');

/** Columnar series block (also embedded in POST /compare). Point i is at start + i * bin_s. */
export const SeriesBlock = z
  .object({
    start: IsoUtc,
    end: IsoUtc,
    step_s: StepS,
    bin_s: z.int().positive().describe('Spacing of returned points, s (multiple of step_s)'),
    n: z.int().min(0).describe('Points per field'),
    agg: SeriesAgg,
    fields: z.record(z.string(), SeriesValues).describe('field name -> values (same length n)'),
  })
  .meta({ id: 'SeriesBlock' });

// ---- events: exact window boundaries (downsampling never hides a transition) -----------------------
export const SeriesEvent = z
  .object({
    t: IsoUtc.describe('Window boundary = first sample of the new state; the real transition lies in (t - step_s, t]'),
    kind: WindowKind,
    state: z.boolean().describe('State from t on: true = rise (becomes visible), false = set (dark / comms gap)'),
  })
  .describe('A visibility transition strictly inside the returned range (= start of a window of the windows collection)')
  .meta({ id: 'SeriesEvent' });
export type SeriesEvent = z.output<typeof SeriesEvent>;

/**
 * Window kind "related" to a series field (selects SeriesResponse.events):
 * sun_* / power_* / irradiance_* / horizon_el_sun_deg / hours_until_sun* -> sun;
 * earth_* / horizon_el_earth_deg / hours_until_earth* -> earth; both_visible -> both.
 */
export function eventKindOfField(field: SeriesFieldName): WindowKind {
  if (field === 'both_visible') return 'both';
  if (field.startsWith('earth_') || field === 'horizon_el_earth_deg' || field.startsWith('hours_until_earth')) return 'earth';
  return 'sun';
}

const SeriesResponseShape = z.object({
  ...provenance,
  site_id: SiteId,
  ...SeriesBlock.shape,
  events: z
    .array(SeriesEvent)
    .optional()
    .describe(
      'Always present in real (non-stub) responses. Exact visibility transitions inside (start, end), sorted by t, for the window kinds ' +
        'related to the requested fields (sun_*, power_*, irradiance_*, horizon_el_sun_deg, hours_until_sun* -> sun; earth_*, ' +
        'horizon_el_earth_deg, hours_until_earth* -> earth; both_visible -> both). Use them to place rise/set marks on a ' +
        'downsampled curve: with agg=sample a boolean point is the first sample of its bin, so a window shorter than bin_s can be ' +
        'invisible in the values but is never missing here.',
    ),
});
export type SeriesResponse = z.output<typeof SeriesResponseShape>;
const exampleSeriesResponse = (): SeriesResponse => ({
  ...exampleSeries(),
  events: [{ t: '2026-01-07T14:00:00Z', kind: 'earth', state: false }],
});
export const SeriesResponse = SeriesResponseShape.meta({ id: 'SeriesResponse', examples: [exampleSeriesResponse()] });

// ---- instant -------------------------------------------------------------------------------------
export const InstantQuery = z.strictObject({
  run_id: runIdQuery,
  t: IsoUtcInput.describe('Instant to read; the sample k = floor((t - t0) / step) containing it is used'),
});

export const NextEvent = z
  .object({
    hours: z.number().min(0).describe('Hours from t (the requested instant, NOT sample_utc) until the event; 0 = condition already holds'),
    at: IsoUtc.nullable().describe('Instant of the event (= t when it already holds); null when it does not happen before the run end'),
    state_now: z.boolean().describe('Flag value at t'),
    lower_bound: z.boolean().describe('true -> no event before the run end: hours = time to the run end (a lower bound)'),
  })
  .describe('= lunarnav.windows.time_until_sunset / next_sunrise / time_until_earthset / next_earthrise(...).to_dict()')
  .meta({ id: 'NextEvent' });
export type NextEvent = z.output<typeof NextEvent>;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6 + 0;

/**
 * NextEvent semantics of lunarnav.windows._time_until_state, computed from the precomputed
 * hours_until_* column of the sample k containing t (that column = hours_until_state(...)[k], measured
 * from t_k): event instant = t_k + column; hours = event - t. Column null -> no event before run end.
 */
export function nextEventFromColumn(
  tMs: number,
  sampleMs: number,
  runEndMs: number,
  stateNow: boolean,
  target: boolean,
  hoursFromSample: number | null,
): NextEvent {
  if (stateNow === target) return { hours: 0, at: toIsoUtc(tMs), state_now: stateNow, lower_bound: false };
  if (hoursFromSample === null) return { hours: round6((runEndMs - tMs) / MS_PER_H), at: null, state_now: stateNow, lower_bound: true };
  const atMs = sampleMs + Math.round(hoursFromSample * 3600) * 1000;
  return { hours: round6((atMs - tMs) / MS_PER_H), at: toIsoUtc(atMs), state_now: stateNow, lower_bound: false };
}

const BodySun = z.object({
  az_deg: z.number(),
  el_deg: z.number(),
  horizon_el_deg: z.number(),
  clearance_deg: z.number(),
  fraction: z.number().min(0).max(1),
  visible: z.boolean(),
  power_horizontal: z.number(),
  power_tracking: z.number(),
  irradiance_tracking_wm2: z.number(),
  dist_km: z.number(),
});
const BodyEarth = z.object({
  az_deg: z.number(),
  el_deg: z.number(),
  horizon_el_deg: z.number(),
  clearance_deg: z.number(),
  fraction: z.number().min(0).max(1),
  visible: z.boolean(),
  dist_km: z.number(),
});

const InstantResponseShape = z.object({
  ...provenance,
  site_id: SiteId,
  t: IsoUtc.describe('Requested instant (normalised to whole seconds)'),
  sample_utc: IsoUtc.describe('Start of the sample that was read (<= t)'),
  sample_index: z.int().min(0).optional().describe('k = floor((t - run start) / step_s). Always present in real responses.'),
  sun: BodySun,
  earth: BodyEarth,
  both_visible: z.boolean(),
  hours_until: z
    .object({
      sunset: z.number().nullable(),
      sunrise: z.number().nullable(),
      earthset: z.number().nullable(),
      earthrise: z.number().nullable(),
    })
    .describe(
      'The precomputed hours_until_* columns of sample k = lunarnav.windows.hours_until_state(...)[k]: hours from sample_utc ' +
        '(+- precision_h); 0 = already in that state; null = no such event before run end',
    ),
  next_events: z
    .object({ sunset: NextEvent, sunrise: NextEvent, earthset: NextEvent, earthrise: NextEvent })
    .optional()
    .describe('Same events measured from t itself (Python NextEvent semantics, incl. lower_bound). Always present in real responses.'),
});
export type InstantResponse = z.output<typeof InstantResponseShape>;

const EXAMPLE_RUN_START_MS = parseIsoUtc('2026-01-01T00:00:00Z');
const EXAMPLE_RUN_END_MS = parseIsoUtc('2026-04-01T00:00:00Z');
function exampleInstantResponse(): InstantResponse {
  const base = exampleInstant();
  const tMs = parseIsoUtc(base.t);
  const sMs = parseIsoUtc(base.sample_utc);
  const ev = (now: boolean, target: boolean, h: number | null) => nextEventFromColumn(tMs, sMs, EXAMPLE_RUN_END_MS, now, target, h);
  return {
    ...base,
    sample_index: Math.round((sMs - EXAMPLE_RUN_START_MS) / (base.step_s * 1000)),
    next_events: {
      sunset: ev(base.sun.visible, false, base.hours_until.sunset),
      sunrise: ev(base.sun.visible, true, base.hours_until.sunrise),
      earthset: ev(base.earth.visible, false, base.hours_until.earthset),
      earthrise: ev(base.earth.visible, true, base.hours_until.earthrise),
    },
  };
}
export const InstantResponse = InstantResponseShape.meta({ id: 'InstantResponse', examples: [exampleInstantResponse()] });

// ---- sky diagram ---------------------------------------------------------------------------------
export const SKY_LIMITS = { max_points_default: 2000, max_points_min: 16, max_points_max: 5000 } as const;

export const SkyQuery = z.strictObject({
  run_id: runIdQuery,
  start: IsoUtcInput.optional().describe('Inclusive start (default: run start). Snapped DOWN to the sample grid.'),
  end: IsoUtcInput.optional().describe('EXCLUSIVE end (default: run end). Snapped UP to the sample grid.'),
  max_points: z.coerce
    .number()
    .int()
    .min(SKY_LIMITS.max_points_min)
    .max(SKY_LIMITS.max_points_max)
    .default(SKY_LIMITS.max_points_default)
    .describe('Budget of regular points per track (transition points come on top, see SkyTrack)'),
});
export type SkyQuery = z.output<typeof SkyQuery>;

export const SkyTrack = z
  .object({
    t: z.array(IsoUtc).describe('Sample instants (strictly increasing; irregular spacing when decimated)'),
    az_deg: z.array(z.number()).describe('Body center azimuth [0,360), clockwise from north'),
    el_deg: z.array(z.number()).describe('Body center elevation, deg'),
    visible: z.array(z.boolean()).describe('sun_visible / earth_visible of the sample'),
    decimated: z.boolean().describe('false = every sample of the range is present'),
    n_transitions: z.int().min(0).describe('Visibility transitions inside the range; both samples around each one are always kept'),
  })
  .describe(
    'Decimated path of a body on the sky. Algorithm: if the range has <= max_points samples, all are returned. Otherwise the range is ' +
      'cut into buckets of b = ceil(3n / (max_points - 4)) samples and each bucket keeps its first sample plus the samples of its minimum ' +
      'and maximum elevation (culminations are preserved); the last sample of the range is kept; and for every visibility transition ' +
      '(visible[i] != visible[i-1]) BOTH samples i-1 and i are kept, so the horizon crossing is exact to +- one step. ' +
      'Point count <= max_points + 2 * n_transitions.',
  )
  .meta({ id: 'SkyTrack' });
export type SkyTrack = z.output<typeof SkyTrack>;

export const SkyHorizon = z
  .object({
    method: z.string().describe('raymarch | bruteforce | flat'),
    dem_source: z.string(),
    az_step_deg: z.number().positive(),
    az_deg: z.array(z.number()).describe('Uniform grid i * az_step_deg in [0, 360)'),
    el_deg: z.array(z.number()).describe('Terrain horizon elevation (silhouette), deg; periodic linear interpolation in between'),
    min_el_deg: z.number(),
    max_el_deg: z.number(),
  })
  .describe('Terrain horizon silhouette at full resolution (same data as GET /sites/{site_id}/horizon without covered_radius_km)')
  .meta({ id: 'SkyHorizon' });
export type SkyHorizon = z.output<typeof SkyHorizon>;

const SkyResponseShape = z.object({
  ...provenance,
  site_id: SiteId,
  start: IsoUtc.describe('Snapped start actually used'),
  end: IsoUtc.describe('Snapped EXCLUSIVE end actually used'),
  n_samples: z.int().min(0).describe('Samples in [start, end) before decimation'),
  horizon: SkyHorizon,
  sun: SkyTrack,
  earth: SkyTrack,
});
export type SkyResponse = z.output<typeof SkyResponseShape>;

function exampleSkyResponse(): SkyResponse {
  const s = stubSeries(STUB_FOCUS_SITE, {
    start: '2026-01-01T00:00:00Z',
    end: '2026-01-01T04:00:00Z',
    fields: ['sun_az_deg', 'sun_el_deg', 'sun_visible', 'earth_az_deg', 'earth_el_deg', 'earth_visible'],
    max_points: 2000,
    agg: 'sample',
  });
  const t = Array.from({ length: s.n }, (_v, i) => toIsoUtc(parseIsoUtc(s.start) + i * s.bin_s * 1000));
  const col = (k: string): unknown[] => {
    const v = s.fields[k];
    return Array.isArray(v) ? v : [];
  };
  const nums = (k: string): number[] => col(k).map((v) => (typeof v === 'number' ? v : 0));
  const bools = (k: string): boolean[] => col(k).map((v) => v === true);
  const h = exampleHorizon(30);
  return {
    run_id: s.run_id,
    step_s: s.step_s,
    precision_h: s.precision_h,
    site_id: s.site_id,
    start: s.start,
    end: s.end,
    n_samples: s.n,
    horizon: { method: h.method, dem_source: h.dem_source, az_step_deg: h.az_step_deg, az_deg: h.az_deg, el_deg: h.el_deg, min_el_deg: h.min_el_deg, max_el_deg: h.max_el_deg },
    sun: { t, az_deg: nums('sun_az_deg'), el_deg: nums('sun_el_deg'), visible: bools('sun_visible'), decimated: false, n_transitions: 0 },
    earth: { t, az_deg: nums('earth_az_deg'), el_deg: nums('earth_el_deg'), visible: bools('earth_visible'), decimated: false, n_transitions: 0 },
  };
}
export const SkyResponse = SkyResponseShape.meta({ id: 'SkyResponse', examples: [exampleSkyResponse()] });
