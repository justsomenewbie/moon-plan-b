/**
 * POST /api/v1/jobs request + Job.output of job type 'validate_terrain'.
 * OWNER: builder B3 (reports) (docs/PYTHON_INTEGRATION.md section 6). Only the owner edits this file.
 *
 * lunarnav.validate_terrain.run(quick, out_path) (terrain -> horizon -> visibility chain against NASA PGDA
 * products, Trek vs PGDA, sensitivities) -> artifact validate_terrain_report.json (strict JSON: NaN -> null).
 * The terrain report has no overall verdict; output.all_checks_passed = every boolean pass flag is true.
 */
import { z } from 'zod';
import { JobName } from './common.ts';

export const ValidateTerrainMode = z.enum(['quick', 'full']).describe('quick = 8 + 8 pixels over 5 years (~minutes when cached); full = 30 + 30 pixels over 18.6 years');

export const ValidateTerrainJobRequest = z
  .strictObject({
    type: z.literal('validate_terrain'),
    name: JobName.optional(),
    mode: ValidateTerrainMode.default('quick'),
  })
  .describe('Terrain / horizon / visibility validation report (lunarnav.validate_terrain). Reads PGDA tiles and the Moon Trek ImageServer (network unless cached)')
  .meta({ id: 'ValidateTerrainJobRequest', examples: [{ type: 'validate_terrain', mode: 'quick' }] });
export type ValidateTerrainJobRequest = z.output<typeof ValidateTerrainJobRequest>;

const MAX_LIST = 50;

/** Summary written by backend/python/validate_terrain_json.py (zod-validated) = Job.output. */
export const ValidateTerrainJobOutput = z.object({
  mode: ValidateTerrainMode,
  all_checks_passed: z.boolean().describe('Every boolean pass flag of the report is true (the report has no overall verdict)'),
  runtime_s: z.number().nullable(),
  sections: z.array(z.string()).describe('Top-level sections of the report'),
  n_checks: z.int().min(0),
  n_checks_failed: z.int().min(0),
  failed_checks: z.array(z.string()).max(MAX_LIST).describe('JSON paths of the failed pass flags'),
  trek_header: z.record(z.string(), z.boolean()).describe('Moon Trek header check per file'),
  method_comparison: z
    .array(z.object({ site_id: z.string(), p95_abs_deg: z.number().nullable(), max_abs_deg: z.number().nullable() }))
    .max(20)
    .describe('raymarch vs bruteforce horizon on real terrain, per site'),
  illumination: z.object({ n_psr: z.number().nullable(), n_lit: z.number().nullable(), primary: z.string().nullable() }),
});
export type ValidateTerrainJobOutput = z.output<typeof ValidateTerrainJobOutput>;
