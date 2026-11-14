/**
 * Multi-site analysis (plan 6.2 #10, #11):
 *   POST /api/v1/compare   compare 2-4 sites over a date range (metrics, ranking, optional windows/series)
 *   GET  /api/v1/ranking   ranking table of all sites (summary.csv when full range + default weights)
 */
import { z } from 'zod';
import {
  DEFAULT_RANK_WEIGHTS,
  IsoUtcInput,
  Metrics,
  RANK_METRICS,
  RankWeights,
  RankingRow,
  RunId,
  SiteId,
  TimeRange,
  WindowKind,
  WindowsByKind,
  provenance,
  runIdQuery,
} from './common.ts';
import { SeriesAgg, SeriesBlock, SeriesField, SERIES_LIMITS } from './series.ts';
import { exampleCompareRequest, exampleCompareResponse, exampleRankingResponse } from '../fixtures/index.ts';

export const COMPARE_LIMITS = { min_sites: 2, max_sites: 4, series_max_points_default: 1500 } as const;

const CompareRequestShape = z
  .strictObject({
    run_id: RunId.optional().describe('Default: the default run'),
    site_ids: z
      .array(SiteId)
      .min(COMPARE_LIMITS.min_sites)
      .max(COMPARE_LIMITS.max_sites)
      .refine((ids) => new Set(ids).size === ids.length, 'site_ids must be unique')
      .describe(`${COMPARE_LIMITS.min_sites}-${COMPARE_LIMITS.max_sites} distinct site ids`),
    start: IsoUtcInput.optional().describe('Default: run start'),
    end: IsoUtcInput.optional().describe('EXCLUSIVE end; default: run end'),
    weights: RankWeights.optional().describe('Default 0.4 pct_sun + 0.3 pct_earth + 0.3 pct_both'),
    include: z
      .strictObject({
        windows: z.array(WindowKind).min(1).max(3).optional().describe('Window kinds to embed per site'),
        series: z
          .strictObject({
            fields: z.array(SeriesField).min(1).max(SERIES_LIMITS.max_fields),
            max_points: z.int().min(2).max(SERIES_LIMITS.max_points_max).default(COMPARE_LIMITS.series_max_points_default),
            agg: SeriesAgg.default('sample'),
          })
          .optional()
          .describe('Embed a downsampled series per site'),
      })
      .optional(),
  });
export type CompareRequest = z.output<typeof CompareRequestShape>;
export const CompareRequest = CompareRequestShape.meta({ id: 'CompareRequest', examples: [exampleCompareRequest()] });

export const CompareSite = z
  .object({
    metrics: Metrics,
    windows: WindowsByKind.optional(),
    series: SeriesBlock.optional(),
    warnings: z.array(z.string()),
  })
  .meta({ id: 'CompareSite' });

const CompareResponseShape = z
  .object({
    ...provenance,
    range: TimeRange,
    weights: RankWeights,
    ranking: z.array(RankingRow),
    sites: z.record(z.string(), CompareSite).describe('site id -> details (same ids as site_ids)'),
  });
export type CompareResponse = z.output<typeof CompareResponseShape>;
export const CompareResponse = CompareResponseShape.meta({ id: 'CompareResponse', examples: [exampleCompareResponse()] });

// ---- ranking -----------------------------------------------------------------------------------
// decimal or exponent notation (JS String(1e-7) === '1e-7'); the 0..1 range is checked by RankWeights
const WEIGHT_NUM = '\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?';
const WEIGHT_PAIR = `(?:${RANK_METRICS.join('|')}):${WEIGHT_NUM}`;
const WEIGHTS_RE = new RegExp(`^${WEIGHT_PAIR}(?:,${WEIGHT_PAIR})*$`);

/** `pct_sun:0.4,pct_earth:0.3,pct_both:0.3` -> RankWeights (a metric given twice -> 400). */
export const WeightsQuery = z
  .string()
  .regex(WEIGHTS_RE, `expected metric:weight pairs, metrics: ${RANK_METRICS.join(', ')}`)
  .transform((s, ctx) => {
    const out: Record<string, number> = {};
    for (const part of s.split(',')) {
      const [k, v] = part.split(':');
      if (k === undefined || v === undefined) continue;
      if (k in out) {
        ctx.issues.push({ code: 'custom', message: `metric ${k} is given more than once`, input: s });
        return z.NEVER;
      }
      out[k] = Number(v);
    }
    return out;
  })
  .pipe(RankWeights)
  .describe(
    `Comma separated metric:weight pairs (weights 0..1, each metric at most once, at least one > 0), e.g. pct_sun:0.4,pct_earth:0.3,pct_both:0.3. Metrics: ${RANK_METRICS.join(', ')}`,
  );

export const RankingQuery = z.strictObject({
  run_id: runIdQuery,
  group: z.string().regex(/^[a-z0-9_]{1,32}$/).optional().describe('Only rank sites of this group'),
  start: IsoUtcInput.optional().describe('Default: run start'),
  end: IsoUtcInput.optional().describe('EXCLUSIVE end; default: run end'),
  weights: WeightsQuery.optional(),
});
export type RankingQuery = z.output<typeof RankingQuery>;

const RankingResponseShape = z
  .object({
    ...provenance,
    range: TimeRange,
    weights: RankWeights,
    source: z
      .enum(['summary', 'computed'])
      .describe('summary = values of summary.csv verbatim (full range, default weights); computed = recomputed for this range/weights'),
    ranking: z.array(RankingRow),
  });
export type RankingResponse = z.output<typeof RankingResponseShape>;
export const RankingResponse = RankingResponseShape.meta({ id: 'RankingResponse', examples: [exampleRankingResponse()] });

export { DEFAULT_RANK_WEIGHTS };
