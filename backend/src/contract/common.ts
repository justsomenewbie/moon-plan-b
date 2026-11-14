/**
 * Shared contract building blocks (zod 4). Field names = docs/OUTPUT_SPEC.md (snake_case, see
 * src/lib/naming.ts). Schemas with `.meta({ id })` become named components in openapi.json
 * (-> named TS types for the FE via openapi-typescript).
 */
import { z } from 'zod';
import { ISO_UTC_INPUT_RE, ISO_UTC_RE, isCalendarIsoUtc } from '../lib/time.ts';

export { Problem, ProblemFieldError, problemResponses } from '../lib/problem.ts';

// ---- scalars -------------------------------------------------------------------------------------
export const IsoUtc = z
  .string()
  .regex(ISO_UTC_RE, 'expected YYYY-MM-DDTHH:MM:SSZ')
  .describe('UTC instant, ISO 8601 `YYYY-MM-DDTHH:MM:SSZ`')
  .meta({ examples: ['2026-01-01T00:00:00Z'] });

/** Request-side instant: fractional seconds allowed, `Z` mandatory. */
export const IsoUtcInput = z
  .string()
  .regex(ISO_UTC_INPUT_RE, 'expected an ISO 8601 UTC time ending in Z, e.g. 2026-01-01T00:00:00Z')
  // impossible dates (hour 25, month 13, Feb 30) -> 400 VALIDATION_ERROR in every query AND body
  .refine((s) => !ISO_UTC_INPUT_RE.test(s) || isCalendarIsoUtc(s), { message: 'not a valid calendar date/time', abort: true })
  .describe('UTC instant, ISO 8601 with `Z` (e.g. `2026-01-01T00:00:00Z`). Snapped to the sample grid by the server.');

export const SITE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const RUN_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const JOB_ID_RE = /^j_[A-Za-z0-9]{6,40}$/;

export const SiteId = z
  .string()
  .regex(SITE_ID_RE, 'site ids match [A-Za-z0-9_.:-]{1,64}')
  .describe('Site id: catalog id (`a3_haworth`) or canonical custom id (`custom:-89.4500:222.6900`). Contains ":" -> always encodeURIComponent() it in paths.')
  .meta({ examples: ['ref_connecting_ridge_c1'] });

export const RunId = z
  .string()
  .regex(RUN_ID_RE, 'run ids match [A-Za-z0-9_.-]{1,64}')
  .describe('Run id: `pf_<params_fingerprint>` for imported precompute runs, `job_<job_id>` for custom jobs')
  .meta({ examples: ['pf_21c3f3f6dc56b1e1'] });

export const JobId = z.string().regex(JOB_ID_RE).describe('Job id').meta({ examples: ['j_7f3k2m9q4x1z'] });

export const StepS = z.int().positive().describe('Sample step of the run, seconds').meta({ examples: [3600] });
export const PrecisionH = z
  .number()
  .positive()
  .describe('= step_s / 3600. Every boundary and "hours until" value is accurate to +- this many hours.')
  .meta({ examples: [1] });

export const Lat = z.number().min(-90).max(90).describe('Planetocentric latitude, deg [-90, 90]');
export const LonEast = z.number().min(0).lt(360).describe('EAST longitude, deg [0, 360)');

/** Common provenance fields of every data response. */
export const provenance = {
  run_id: RunId,
  step_s: StepS,
  precision_h: PrecisionH,
};

// ---- query helpers -------------------------------------------------------------------------------
export const runIdQuery = RunId.optional().describe('Run to read; default = the run flagged is_default (GET /api/v1/runs)');

/**
 * Comma separated list in a query string -> validated array (`kinds=sun,earth`). For an enum item the
 * raw string also gets a `pattern` in the OpenAPI document only (so the Prism mock rejects unknown names
 * too); the server validates item by item, so an error points at the bad item (`kinds.1`).
 */
export function csvList<T extends z.ZodType<string, string>>(item: T, opts: { min: number; max: number; default: string; description: string }) {
  let raw = z.string();
  if (item instanceof z.ZodEnum) {
    const names = (item.options as readonly string[]).map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    raw = raw.meta({ pattern: `^[\\s,]*(?:${names})(?:\\s*,[\\s,]*(?:${names}))*[\\s,]*$` });
  }
  return raw
    .default(opts.default)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    )
    .pipe(z.array(item).min(opts.min).max(opts.max))
    .describe(opts.description);
}

// ---- windows -------------------------------------------------------------------------------------
export const WindowKind = z
  .enum(['sun', 'earth', 'both'])
  .describe('sun: Sun visible (true) / dark (false); earth: Earth visible = DTE link (true) / comms gap (false); both: sun AND earth')
  .meta({ id: 'WindowKind' });
export type WindowKind = z.output<typeof WindowKind>;
export const WINDOW_KINDS = WindowKind.options;

export const Window = z
  .object({
    start: IsoUtc.describe('First sample of the window'),
    end: IsoUtc.describe('EXCLUSIVE end (first sample of the next window, or range end)'),
    duration_h: z.number().min(0),
    state: z.boolean().describe('true = visible (Sun lit / Earth in view / both); false = dark / comms gap'),
    truncated_start: z.boolean().describe('Window starts at the RUN start - its true start is earlier or unknown'),
    truncated_end: z.boolean().describe('Window runs to the RUN end'),
  })
  .meta({ id: 'Window' });

export const ClippedWindow = Window.extend({
  clipped_start: z.boolean().describe('start was clipped to the QUERY start (differs from truncated_* = run boundary)'),
  clipped_end: z.boolean().describe('end was clipped to the QUERY end'),
})
  .describe('A window intersected with the query range [start, end)')
  .meta({
    id: 'ClippedWindow',
    examples: [
      {
        start: '2026-01-01T00:00:00Z',
        end: '2026-03-29T00:00:00Z',
        duration_h: 2088,
        state: true,
        truncated_start: true,
        truncated_end: false,
        clipped_start: false,
        clipped_end: false,
      },
    ],
  });
export type ClippedWindow = z.output<typeof ClippedWindow>;

export const WindowsByKind = z
  .object({
    sun: z.array(ClippedWindow).optional(),
    earth: z.array(ClippedWindow).optional(),
    both: z.array(ClippedWindow).optional(),
  })
  .describe('Only the requested kinds are present')
  .meta({ id: 'WindowsByKind' });

// ---- metrics (OUTPUT_SPEC 3.6) ---------------------------------------------------------------------
export const Metrics = z
  .object({
    duration_h: z.number().min(0).describe('Length of the evaluated range, h'),
    pct_sun: z.number().min(0).max(100).describe('% of time the Sun is visible (upper limb above terrain)'),
    pct_earth: z.number().min(0).max(100).describe('% of time the Earth is visible (direct-to-Earth comms)'),
    pct_both: z.number().min(0).max(100).describe('% of time with Sun AND Earth'),
    pct_sun_no_earth: z.number().min(0).max(100).describe('% of time with Sun but no Earth'),
    longest_dark_h: z.number().min(0).describe('Longest continuous dark period, h'),
    longest_dark_truncated: z.boolean().describe('true -> touches the range boundary: value is a lower bound'),
    longest_comms_gap_h: z.number().min(0).describe('Longest continuous period without Earth, h'),
    longest_comms_gap_truncated: z.boolean(),
    longest_sun_h: z.number().min(0),
    longest_sun_truncated: z.boolean(),
    longest_earth_h: z.number().min(0),
    longest_earth_truncated: z.boolean(),
    n_sun_windows: z.int().min(0),
    n_dark_windows: z.int().min(0),
    n_earth_windows: z.int().min(0),
    n_comms_gaps: z.int().min(0),
    mean_sun_el_lit_deg: z.number().nullable().describe('Mean Sun elevation over lit samples; null if never lit'),
    mean_power_horizontal: z.number().min(0).max(1).describe('Mean relative power of a flat-lying panel (0..1)'),
    mean_power_tracking: z.number().min(0).max(1).describe('Mean relative power of a Sun-tracking panel (0..1)'),
  })
  .describe('Time-weighted metrics over a range (docs/OUTPUT_SPEC.md section 3.6)')
  .meta({
    id: 'Metrics',
    examples: [
      {
        duration_h: 2160,
        pct_sun: 98.564815,
        pct_earth: 53.611111,
        pct_both: 52.175926,
        pct_sun_no_earth: 46.388889,
        longest_dark_h: 26,
        longest_dark_truncated: false,
        longest_comms_gap_h: 326,
        longest_comms_gap_truncated: false,
        longest_sun_h: 2088,
        longest_sun_truncated: true,
        longest_earth_h: 334,
        longest_earth_truncated: false,
        n_sun_windows: 3,
        n_dark_windows: 2,
        n_earth_windows: 4,
        n_comms_gaps: 4,
        mean_sun_el_lit_deg: 0.340818,
        mean_power_horizontal: 0.009032,
        mean_power_tracking: 0.971631,
      },
    ],
  });
export type Metrics = z.output<typeof Metrics>;

// ---- ranking -------------------------------------------------------------------------------------
export const RANK_METRICS = ['pct_sun', 'pct_earth', 'pct_both', 'pct_sun_no_earth'] as const;
export const RankMetric = z.enum(RANK_METRICS).describe('Metric usable in a ranking weight');
export const DEFAULT_RANK_WEIGHTS = { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 } as const;

export const RankWeights = z
  .strictObject({
    pct_sun: z.number().min(0).max(1).optional(),
    pct_earth: z.number().min(0).max(1).optional(),
    pct_both: z.number().min(0).max(1).optional(),
    pct_sun_no_earth: z.number().min(0).max(1).optional(),
  })
  // all-zero weights would score every site 0 and rank by the tie-break only
  .refine((w) => Object.values(w).some((v) => v !== undefined && v > 0), { message: 'at least one weight must be > 0' })
  .describe(
    'score = sum(weight[k] * metric[k]) (0..100 when weights sum to 1). Missing keys = 0; at least one weight must be > 0. Default 0.4 pct_sun + 0.3 pct_earth + 0.3 pct_both.',
  )
  .meta({ id: 'RankWeights', examples: [DEFAULT_RANK_WEIGHTS] });
export type RankWeights = z.output<typeof RankWeights>;

export const RankingRow = z
  .object({
    rank: z.int().min(1).describe('1 = best. Ties -> shorter longest_dark_h, then site_id'),
    site_id: SiteId,
    name: z.string(),
    group: z.string(),
    score: z.number(),
    pct_sun: z.number(),
    pct_earth: z.number(),
    pct_both: z.number(),
    pct_sun_no_earth: z.number(),
    longest_dark_h: z.number(),
    longest_dark_truncated: z.boolean(),
    longest_comms_gap_h: z.number(),
    longest_comms_gap_truncated: z.boolean(),
    mean_power_tracking: z.number(),
    reasons: z.array(z.string()).describe('Short human-readable reasons for this rank (for UI tooltips)'),
  })
  .meta({
    id: 'RankingRow',
    examples: [
      {
        rank: 1,
        site_id: 'ref_connecting_ridge_c1',
        name: 'Shackleton-de Gerlache connecting ridge, point C1',
        group: 'reference',
        score: 71.162037,
        pct_sun: 98.564815,
        pct_earth: 53.611111,
        pct_both: 52.175926,
        pct_sun_no_earth: 46.388889,
        longest_dark_h: 26,
        longest_dark_truncated: false,
        longest_comms_gap_h: 326,
        longest_comms_gap_truncated: false,
        mean_power_tracking: 0.971631,
        reasons: ['Sun visible 98.6% of the time', 'longest night only 26 h', 'Earth in view 53.6%'],
      },
    ],
  });
export type RankingRow = z.output<typeof RankingRow>;

export const TimeRange = z
  .object({
    start: IsoUtc.describe('Snapped start actually used'),
    end: IsoUtc.describe('Snapped EXCLUSIVE end actually used'),
    step_s: StepS,
    n_samples: z.int().min(0),
  })
  .meta({ id: 'TimeRange' });

// ---- map -----------------------------------------------------------------------------------------
export const MapPoint = z
  .object({
    projection: z.literal('south_polar_stereographic_R1737.4km'),
    x_km: z.number(),
    y_km: z.number(),
  })
  .describe('Position on the LOLA south polar stereographic map (sphere R = 1737.4 km); null for sites north of 60 S')
  .meta({ id: 'MapPoint' });

// ---- path params ---------------------------------------------------------------------------------
export const SiteParams = z.strictObject({ site_id: SiteId });
