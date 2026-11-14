/**
 * POST /api/v1/jobs request + Job.output of job type 'analyse'.
 * OWNER: builder B1 (compute) (docs/PYTHON_INTEGRATION.md section 6). Only the owner edits this file.
 *
 * Same sites / range / options as 'precompute' (same limits) -> `lunarnav analyse --json`: the ranking
 * is the artifact ranking.json and also Job.output.ranking (<= PRECOMPUTE_LIMITS.max_sites rows). Nothing is imported.
 */
import { z } from 'zod';
import { IsoUtc, SiteId } from '../common.ts';
import { JobName } from './common.ts';
import { ComputeRangeShape } from './precompute.ts';

export const AnalyseJobRequest = z
  .strictObject({
    type: z.literal('analyse'),
    name: JobName.optional(),
    ...ComputeRangeShape,
  })
  .meta({
    id: 'AnalyseJobRequest',
    description: 'lunarnav analyse: rank sites over a period (no import). Output: Job.output.ranking + artifact ranking.json.',
  });
export type AnalyseJobRequest = z.output<typeof AnalyseJobRequest>;

/** One row of lunarnav.analysis.rank_sites (score = 0.4 pct_sun + 0.3 pct_earth + 0.3 pct_both). */
export const AnalyseRankingRow = z.object({
  rank: z.int().min(1),
  site_id: SiteId,
  score: z.number(),
  pct_sun: z.number(),
  pct_earth: z.number(),
  pct_both: z.number(),
  longest_dark_h: z.number(),
  longest_comms_gap_h: z.number(),
});
export type AnalyseRankingRow = z.output<typeof AnalyseRankingRow>;

/** File written by `lunarnav analyse --json` (= artifact ranking.json). */
export const AnalyseRankingFile = z.object({ ranking: z.array(AnalyseRankingRow).min(1) });

/** Job.output of a succeeded 'analyse' job. */
export const AnalyseJobOutput = z.object({
  n_sites: z.int().min(1),
  start: IsoUtc,
  end: IsoUtc,
  step_min: z.number(),
  n_samples: z.int().min(1).describe('Samples per site'),
  provider: z.string(),
  dem: z.string(),
  horizon_method: z.string(),
  ranking: z.array(AnalyseRankingRow),
});
export type AnalyseJobOutput = z.output<typeof AnalyseJobOutput>;
