/** GET /api/v1/meta (plan 6.2 #2): enums + limits for building UI controls. Static. */
import { z } from 'zod';
import { DEFAULT_RANK_WEIGHTS, RANK_METRICS, RankWeights, WINDOW_KINDS } from './common.ts';
import { SERIES_FIELD_INFO, SERIES_LIMITS } from './series.ts';
import { ALT_DATE_OBJECTIVES, ALT_DATES_LIMITS } from './alt_dates.ts';
import { COMPARE_LIMITS } from './analysis.ts';
import { JOB_LIMITS } from './jobs.ts';
import { API_VERSION } from './health.ts';
import { FIELD_CASE } from '../lib/naming.ts';

export const SITE_GROUPS = ['south_pole', 'reference', 'apollo', 'far_side'] as const;

const MetaResponseBase = z
  .object({
    api_version: z.string(),
    field_case: z.enum(['snake_case', 'camelCase']).describe('Naming of JSON keys and query parameters'),
    time_format: z.string().describe('Format of every timestamp'),
    site_groups: z.array(z.string()),
    window_kinds: z.array(z.string()),
    series_fields: z.array(
      z.object({
        name: z.string(),
        unit: z.string(),
        type: z.enum(['number', 'boolean']),
        nullable: z.boolean(),
        description: z.string(),
      }),
    ),
    rank_metrics: z.array(z.string()),
    default_rank_weights: RankWeights,
    alt_date_objectives: z.array(z.string()),
    limits: z.object({
      series_max_fields: z.int(),
      series_max_points_default: z.int(),
      series_max_points_max: z.int(),
      compare_min_sites: z.int(),
      compare_max_sites: z.int(),
      alt_dates_max_results: z.int(),
      job_max_range_days: z.int(),
      job_step_min_allowed: z.array(z.int()),
      job_queue_max: z.int(),
      rate_limit_per_min: z.int(),
      rate_limit_post_per_min: z.int().describe('POST /alt-dates and POST /jobs'),
    }),
  });
export type MetaResponse = z.output<typeof MetaResponseBase>;

export function buildMeta(cfg: { JOB_QUEUE_MAX: number; RATE_LIMIT_MAX: number; RATE_LIMIT_POST_MAX: number }): MetaResponse {
  return {
    api_version: API_VERSION,
    field_case: FIELD_CASE,
    time_format: 'ISO 8601 UTC YYYY-MM-DDTHH:MM:SSZ; ranges are [start, end) with exclusive end',
    site_groups: [...SITE_GROUPS],
    window_kinds: [...WINDOW_KINDS],
    series_fields: SERIES_FIELD_INFO.map((f) => ({ ...f })),
    rank_metrics: [...RANK_METRICS],
    default_rank_weights: { ...DEFAULT_RANK_WEIGHTS },
    alt_date_objectives: [...ALT_DATE_OBJECTIVES],
    limits: {
      series_max_fields: SERIES_LIMITS.max_fields,
      series_max_points_default: SERIES_LIMITS.max_points_default,
      series_max_points_max: SERIES_LIMITS.max_points_max,
      compare_min_sites: COMPARE_LIMITS.min_sites,
      compare_max_sites: COMPARE_LIMITS.max_sites,
      alt_dates_max_results: ALT_DATES_LIMITS.max_results_max,
      job_max_range_days: JOB_LIMITS.max_range_days,
      job_step_min_allowed: [...JOB_LIMITS.step_min_allowed],
      job_queue_max: cfg.JOB_QUEUE_MAX,
      rate_limit_per_min: cfg.RATE_LIMIT_MAX,
      rate_limit_post_per_min: cfg.RATE_LIMIT_POST_MAX,
    },
  };
}

export const MetaResponse = MetaResponseBase.meta({
  id: 'MetaResponse',
  examples: [buildMeta({ JOB_QUEUE_MAX: 20, RATE_LIMIT_MAX: 300, RATE_LIMIT_POST_MAX: 5 })],
});
