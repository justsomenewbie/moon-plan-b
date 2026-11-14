/**
 * POST /api/v1/jobs request + Job.output of job type 'validate'.
 * OWNER: builder B3 (reports) (docs/PYTHON_INTEGRATION.md section 6). Only the owner edits this file.
 *
 * lunarnav.validate.run_all (Horizons vs SPICE vs analytic cross-check, negative controls, Apollo 11,
 * lunar day, + the terrain hook) -> artifacts validation_report.json / validation_report.md (and
 * validate_terrain_report.json when the terrain hook ran). A FAILED validation is a SUCCEEDED job with
 * output.passed = false; the job fails only when the validation could not run.
 */
import { z } from 'zod';
import { JobName } from './common.ts';

export const ValidateMode = z.enum(['quick', 'full']).describe('quick = 2 sites x 1 month (minutes); full = every validation site and time set');

export const ValidateJobRequest = z
  .strictObject({
    type: z.literal('validate'),
    name: JobName.optional(),
    mode: ValidateMode.default('quick'),
    offline: z.boolean().default(false).describe('Horizons answers from the server disk cache only (fails when something is not cached)'),
    no_horizons: z.boolean().default(false).describe('Skip Method A (JPL Horizons): SPICE vs analytic only, no network'),
    no_terrain: z.boolean().default(false).describe('Skip the terrain hook (lunarnav.validate_terrain; slow, reads PGDA / Moon Trek)'),
  })
  .describe('Cross-method validation report (lunarnav validate)')
  .meta({ id: 'ValidateJobRequest', examples: [{ type: 'validate', mode: 'quick', no_horizons: true, no_terrain: true }] });
export type ValidateJobRequest = z.output<typeof ValidateJobRequest>;

const MAX_LIST = 50;

/** Summary written by backend/python/validate_json.py (zod-validated) = Job.output. */
export const ValidateJobOutput = z.object({
  passed: z.boolean().describe('Overall verdict of lunarnav.validate (ephemeris checks, and the terrain hook when it ran)'),
  mode: ValidateMode,
  offline: z.boolean(),
  providers: z.array(z.string()).describe('Methods compared (horizons, spice, analytic)'),
  n_sites: z.int().min(0),
  n_time_sets: z.int().min(0),
  n_pairs: z.int().min(0).describe('Rows of the pass/fail matrix (method pair x body)'),
  failed_pairs: z.array(z.string()).max(MAX_LIST).describe('"<pair>/<body>" rows that failed'),
  sections: z.record(z.string(), z.boolean().nullable()).describe('Verdict per section (crosscheck_matrix, negative_controls, apollo11, lunar_day)'),
  terrain: z.object({ status: z.string(), passed: z.boolean().nullable() }).nullable().describe('Terrain hook (null = no_terrain)'),
  n_checks: z.int().min(0).describe('Boolean pass flags found in the report'),
  n_checks_failed: z.int().min(0),
  failed_checks: z.array(z.string()).max(MAX_LIST).describe('JSON paths of the failed pass flags'),
  generated_utc: z.string().nullable(),
  lunarnav_version: z.string().nullable(),
});
export type ValidateJobOutput = z.output<typeof ValidateJobOutput>;
