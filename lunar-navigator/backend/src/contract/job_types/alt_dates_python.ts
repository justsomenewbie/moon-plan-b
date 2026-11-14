/**
 * POST /api/v1/jobs request + Job.output of job type 'alt_dates_python'.
 * OWNER: builder B1 (compute) (docs/PYTHON_INTEGRATION.md section 6; reassigned from B2). Only the owner edits this file.
 *
 * `lunarnav alt-dates` computed directly by Python for ONE site (catalog id, canonical custom id or
 * lat/lon) with full ComputeOptions: ephemeris + horizon + visibility are recomputed over
 * [earliest, latest + mission], then landing instants are ranked under DateConstraints (same fields
 * as POST /api/v1/alt-dates, which stays the fast path on imported runs). An empty candidate list is a
 * successful job (see rejected_by).
 */
import { z } from 'zod';
import { DateConstraints, LandingCandidate, ALT_DATES_LIMITS } from '../alt_dates.ts';
import { IsoUtc, IsoUtcInput, Lat, SiteId } from '../common.ts';
import { ComputeOptionsShape, JobName } from './common.ts';

export const ALT_DATES_PYTHON_LIMITS = {
  /** latest - earliest. */
  max_window_days: 366,
  max_mission_h: 8784,
  /** Samples of the computed series ([earliest, latest + max(mission, continuous constraints) + 1 step]). */
  max_samples: 200_000,
  max_results_max: ALT_DATES_LIMITS.max_results_max,
} as const;

const AltDatesPythonJobRequestShape = z
  .strictObject({
    type: z.literal('alt_dates_python'),
    name: JobName.optional(),
    site_id: SiteId.optional().describe('Catalog site id or canonical custom id - XOR lat_deg/lon_deg'),
    lat_deg: Lat.optional(),
    lon_deg: z.number().min(-360).max(360).optional().describe('Longitude, deg; EAST-positive (west-negative values are converted to [0, 360))'),
    earliest: IsoUtcInput.describe('Earliest landing (inclusive); snapped UP to the step grid'),
    latest: IsoUtcInput.describe(`Latest landing (inclusive); snapped DOWN to the step grid; <= ${ALT_DATES_PYTHON_LIMITS.max_window_days} days after earliest`),
    mission_h: z.number().positive().max(ALT_DATES_PYTHON_LIMITS.max_mission_h).describe('Mission duration, h; a whole number of steps (else 422 BAD_MISSION_LENGTH)'),
    max_results: z.int().min(1).max(ALT_DATES_PYTHON_LIMITS.max_results_max).default(ALT_DATES_LIMITS.max_results_default),
    constraints: DateConstraints.default(DateConstraints.parse({})),
    ...ComputeOptionsShape,
  })
  .refine((b) => (b.site_id !== undefined) !== (b.lat_deg !== undefined || b.lon_deg !== undefined), {
    message: 'give either site_id or lat_deg + lon_deg (not both)',
  })
  .refine((b) => (b.lat_deg === undefined) === (b.lon_deg === undefined), {
    message: 'lat_deg and lon_deg go together',
    path: ['lon_deg'],
  });
export type AltDatesPythonJobRequest = z.output<typeof AltDatesPythonJobRequestShape>;
export const AltDatesPythonJobRequest = AltDatesPythonJobRequestShape.meta({
  id: 'AltDatesPythonJobRequest',
  description: 'lunarnav alt-dates recomputed by Python for one site with full options. Output: Job.output (candidates) + artifact alt_dates.json.',
});

/** File written by `lunarnav alt-dates --json` (AltDateResult.to_dict()) = artifact alt_dates.json. */
export const AltDatesPythonFile = z.object({
  site_id: SiteId,
  earliest_utc: IsoUtc,
  latest_utc: IsoUtc,
  mission_duration_h: z.number(),
  constraints: DateConstraints,
  n_evaluated: z.int().min(0),
  n_feasible: z.int().min(0),
  rejected_by: z.record(z.string(), z.int().min(0)),
  candidates: z.array(LandingCandidate),
});

/** Job.output of a succeeded 'alt_dates_python' job = the file + how it was computed. */
export const AltDatesPythonJobOutput = AltDatesPythonFile.extend({
  step_min: z.number(),
  provider: z.string(),
  dem: z.string(),
  horizon_method: z.string(),
});
export type AltDatesPythonJobOutput = z.output<typeof AltDatesPythonJobOutput>;
