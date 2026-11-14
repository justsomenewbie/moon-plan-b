/**
 * POST /api/v1/jobs request + Job.output of job type 'compare_runs'.
 * OWNER: builder B3 (reports) (docs/PYTHON_INTEGRATION.md section 6). Only the owner edits this file.
 *
 * Compare two imported runs site by site via backend/python/compare_runs.py (port of
 * lunarnav_runs/compare_A_B.py): ephemeris angle difference, horizon difference p95 / max, flag mismatch %,
 * summary metric deltas (A - B). Artifacts compare_runs.json (every site) + compare_runs.csv.
 */
import { z } from 'zod';
import { RunId, SiteId } from '../common.ts';
import { JobName } from './common.ts';

export const COMPARE_RUNS_LIMITS = {
  /** Sites per job. */
  max_sites: 300,
  /** Compared sites x samples per site (~2 s of Python per 5-year hourly site on the dev machine). */
  max_site_samples: 15_000_000,
} as const;

export const CompareRunsJobRequest = z
  .strictObject({
    type: z.literal('compare_runs'),
    name: JobName.optional(),
    run_a: RunId.describe('Run A (differences are A - B)'),
    run_b: RunId.describe('Run B; must differ from run_a'),
    site_ids: z
      .array(SiteId)
      .min(1)
      .max(COMPARE_RUNS_LIMITS.max_sites)
      .nullable()
      .default(null)
      .describe('Sites to compare (each must be in both runs); null = every site the two runs share'),
  })
  .describe('Compare two imported runs site by site (ephemeris, horizon, visibility flags, metrics)')
  .meta({ id: 'CompareRunsJobRequest', examples: [{ type: 'compare_runs', run_a: 'pf_aec206eb', run_b: 'pf_21c3f3f6dc56b1e1' }] });
export type CompareRunsJobRequest = z.output<typeof CompareRunsJobRequest>;

const Agg = z.object({
  n: z.int().min(0),
  max: z.number().nullable(),
  median: z.number().nullable(),
  mean: z.number().nullable(),
  worst_site: z.string().nullable(),
});

/** Summary written by backend/python/compare_runs.py (zod-validated) = Job.output. */
export const CompareRunsJobOutput = z.object({
  run_a: RunId,
  run_b: RunId,
  n_sites_compared: z.int().min(0),
  n_sites_failed: z.int().min(0).describe('Sites whose files could not be read (status error in compare_runs.json)'),
  n_sites_no_common_samples: z.int().min(0).describe('Sites whose time grids share no instant'),
  only_in_a: z.array(z.string()).max(100),
  only_in_b: z.array(z.string()).max(100),
  n_only_in_a: z.int().min(0),
  n_only_in_b: z.int().min(0),
  ephem_sun_max_arcsec: Agg.describe('Per-site max of max(|d az| cos el, |d el|), arcsec'),
  ephem_earth_max_arcsec: Agg,
  horizon_p95_abs_deg: Agg,
  horizon_max_abs_deg: Agg,
  sun_flag_mismatch_pct: Agg,
  earth_flag_mismatch_pct: Agg,
  abs_d_pct_sun: Agg.describe('|pct_sun A - B| (summary.csv, each over its own run range)'),
  abs_d_pct_earth: Agg,
  abs_d_longest_dark_h: Agg,
  n_rank_changes: z.int().min(0),
  same_range: z.boolean().describe('Both runs cover the same range and step (metric deltas compare the same period)'),
});
export type CompareRunsJobOutput = z.output<typeof CompareRunsJobOutput>;
