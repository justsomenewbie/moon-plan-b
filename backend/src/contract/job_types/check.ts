/**
 * POST /api/v1/jobs request + Job.output of job type 'check'.
 * OWNER: builder B3 (reports; reassigned from B2) (docs/PYTHON_INTEGRATION.md section 6). Only the owner edits this file.
 *
 * `lunarnav check` (lunarnav.precompute.check_output, docs/OUTPUT_SPEC.md) on the files of an imported
 * run -> violations (Job.output + artifact violations.json). A run WITH violations is a SUCCEEDED job
 * (output.ok = false); the job fails only when the check itself cannot run.
 */
import { z } from 'zod';
import { RunId } from '../common.ts';
import { JobName } from './common.ts';

/** Violations copied into Job.output (all of them are in the violations.json artifact). */
export const CHECK_OUTPUT_MAX_VIOLATIONS = 50;

export const CheckJobRequest = z
  .strictObject({
    type: z.literal('check'),
    name: JobName.optional(),
    run_id: RunId.optional().describe('Imported run to verify; default = the run flagged is_default (GET /api/v1/runs)'),
  })
  .describe('Verify the files of an imported run against docs/OUTPUT_SPEC.md (lunarnav check). Never cached: every job re-reads the files.')
  .meta({ id: 'CheckJobRequest', examples: [{ type: 'check', run_id: 'pf_21c3f3f6dc56b1e1' }] });
export type CheckJobRequest = z.output<typeof CheckJobRequest>;

/** Job.output of a succeeded 'check' job. */
export const CheckJobOutput = z.object({
  run_id: RunId,
  ok: z.boolean().describe('true = no violation'),
  n_violations: z.int().min(0),
  n_files: z.int().min(0).nullable().describe('Files listed in manifest.json (null = manifest unreadable)'),
  violations: z.array(z.string()).max(CHECK_OUTPUT_MAX_VIOLATIONS).describe(`First ${CHECK_OUTPUT_MAX_VIOLATIONS} violations (all: artifact violations.json)`),
  truncated: z.boolean(),
});
export type CheckJobOutput = z.output<typeof CheckJobOutput>;

/** Artifact violations.json. */
export const CheckViolationsFile = z.object({
  run_id: RunId,
  ok: z.boolean(),
  n_violations: z.int().min(0),
  n_files: z.int().min(0).nullable(),
  violations: z.array(z.string()),
});
