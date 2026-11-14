/**
 * Async Python jobs (plan 6.2 #13, #14; plan 7.2; docs/PYTHON_INTEGRATION.md).
 *   POST   /api/v1/jobs                           -> 202 JobAccepted (200 when an identical job already succeeded)
 *   GET    /api/v1/jobs/{job_id}                  -> Job (poll every 1-2 s = the contract)
 *   DELETE /api/v1/jobs/{job_id}                  -> Job (status cancelled, or still running when other clients wait on it)
 *   GET    /api/v1/jobs/{job_id}/events           -> text/event-stream (optional live progress)
 *   GET    /api/v1/jobs/{job_id}/artifacts        -> JobArtifactsResponse (files the job produced)
 *   GET    /api/v1/jobs/{job_id}/artifacts/{name} -> the file
 * `CreateJobRequest` is a discriminated union on `type`; each job type's request lives in
 * src/contract/job_types/<type>.ts (owned by the builder of that type). When a custom_site / precompute
 * job succeeds, call the normal data endpoints with run_id = result.run_id.
 */
import { z } from 'zod';
import { IsoUtc, IsoUtcInput, JobId, Lat, RunId, SiteId } from './common.ts';
import { ArtifactName, JobArtifact, JobName } from './job_types/common.ts';
import { AltDatesPythonJobRequest } from './job_types/alt_dates_python.ts';
import { AnalyseJobRequest } from './job_types/analyse.ts';
import { CheckJobRequest } from './job_types/check.ts';
import { CompareRunsJobRequest } from './job_types/compare_runs.ts';
import { HorizonMaskJobRequest } from './job_types/horizon_mask.ts';
import { PrecomputeJobRequest } from './job_types/precompute.ts';
import { ValidateJobRequest } from './job_types/validate.ts';
import { ValidateTerrainJobRequest } from './job_types/validate_terrain.ts';
import { exampleJob, exampleJobAccepted, exampleJobRequest } from '../fixtures/index.ts';

export { JobArtifact } from './job_types/common.ts';

/** Limits of the custom_site job type (also in GET /meta). */
export const JOB_LIMITS = {
  max_range_days: 366,
  step_min_allowed: [60],
  observer_height_m_max: 100,
} as const;

/** Every job type of the registry (src/jobs/types/index.ts). Order = documentation order. */
export const JOB_TYPES = [
  'custom_site',
  'precompute',
  'analyse',
  'alt_dates_python',
  'check',
  'validate',
  'validate_terrain',
  'compare_runs',
  'horizon_mask',
] as const;
export const JobType = z.enum(JOB_TYPES).describe('Job type (GET /api/v1/capabilities lists which ones this server runs)').meta({ id: 'JobType' });
export type JobType = z.output<typeof JobType>;

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).meta({ id: 'JobStatus' });
export type JobStatus = z.output<typeof JobStatus>;

/** Progress stages: custom_site / precompute use precompute + import; the other types python (+ artifacts). */
export const JOB_STAGES = ['queued', 'precompute', 'python', 'import', 'artifacts', 'done'] as const;
export const JobStage = z.enum(JOB_STAGES);
export type JobStage = z.output<typeof JobStage>;

// ---- custom_site (one site, hourly; unchanged since v1) -------------------------------------------------
const CustomSiteJobRequestShape = z
  .strictObject({
    type: z.literal('custom_site'),
    site_id: SiteId.optional().describe('A catalog site id (to compute a date range outside the precomputed runs) - XOR lat_deg/lon_deg'),
    lat_deg: Lat.optional(),
    lon_deg: z
      .number()
      .min(-360)
      .max(360)
      .optional()
      .describe('Longitude, deg; EAST-positive (west-negative values are converted to [0, 360))'),
    name: JobName.optional().describe('Display name of the custom site'),
    start: IsoUtcInput,
    end: IsoUtcInput.describe(`EXCLUSIVE end; at most ${JOB_LIMITS.max_range_days} days after start`),
    step_min: z.literal(60).default(60).describe('Time step, minutes (only 60 for now)'),
    provider: z
      .enum(['spice', 'horizons', 'analytic'])
      .default('horizons')
      .describe('Ephemeris: horizons (JPL Horizons API, online; the web default since 14/11), spice (local NAIF kernels, ~45 MB, works offline), analytic (approximate)'),
    dem: z.enum(['pgda', 'trek', 'none']).default('pgda'),
    horizon_method: z.enum(['raymarch', 'bruteforce', 'flat']).default('raymarch'),
    observer_height_m: z.number().min(0).max(JOB_LIMITS.observer_height_m_max).default(2),
  })
  .refine((b) => (b.site_id !== undefined) !== (b.lat_deg !== undefined || b.lon_deg !== undefined), {
    message: 'give either site_id or lat_deg + lon_deg (not both)',
  })
  .refine((b) => (b.lat_deg === undefined) === (b.lon_deg === undefined), {
    message: 'lat_deg and lon_deg go together',
    path: ['lon_deg'],
  });
export type CustomSiteJobRequest = z.output<typeof CustomSiteJobRequestShape>;
export const CustomSiteJobRequest = CustomSiteJobRequestShape.meta({
  id: 'CustomSiteJobRequest',
  description: 'One catalog or custom site over a date range (hourly), imported as a custom run (result.run_id)',
});

// ---- the union ---------------------------------------------------------------------------------------
const CreateJobRequestShape = z.discriminatedUnion('type', [
  CustomSiteJobRequest,
  PrecomputeJobRequest,
  AnalyseJobRequest,
  AltDatesPythonJobRequest,
  CheckJobRequest,
  ValidateJobRequest,
  ValidateTerrainJobRequest,
  CompareRunsJobRequest,
  HorizonMaskJobRequest,
]);
export type CreateJobRequest = z.output<typeof CreateJobRequestShape>;
export const CreateJobRequest = CreateJobRequestShape.meta({
  id: 'CreateJobRequest',
  description: 'Discriminated on `type`. Types this server cannot run answer 501 JOB_TYPE_UNAVAILABLE (see GET /api/v1/capabilities).',
  examples: [exampleJobRequest()],
});

const JobAcceptedShape = z.object({
  job_id: JobId,
  type: JobType,
  status: JobStatus,
  site_id: SiteId.nullable().describe('Canonical site id the job computes (custom:<lat>:<lon> with 4 decimals); null for job types without a single site'),
  poll: z.string().describe('Relative URL to poll'),
  cached: z.boolean().describe('true = identical job (same params_hash) reused instead of starting a new one'),
});
export type JobAccepted = z.output<typeof JobAcceptedShape>;
export const JobAccepted = JobAcceptedShape.meta({ id: 'JobAccepted', examples: [exampleJobAccepted()] });

const JobShape = z.object({
  job_id: JobId,
  type: JobType,
  status: JobStatus,
  site_id: SiteId.nullable().describe('null for job types without a single site'),
  params: z.record(z.string(), z.unknown()).describe('Canonical parameters (CreateJobRequest after defaults)'),
  progress: z.object({
    stage: JobStage,
    pct: z.number().min(0).max(100).nullable().describe('null = unknown (lunarnav prints text progress only)'),
    lines: z.array(z.string()).describe('Last <= 50 progress lines of the Python process'),
  }),
  result: z
    .object({ run_id: RunId, site_id: SiteId })
    .nullable()
    .describe('Imported run of a succeeded custom_site / precompute job (site_id = its first site); null for the other types'),
  output: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe('Small type-specific JSON summary of a succeeded job (schema: src/contract/job_types/<type>.ts); null otherwise'),
  artifacts: z.array(JobArtifact).describe('Files the job produced (reports, JSON); [] for custom_site. Download: artifacts[].url'),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  clients: z
    .int()
    .min(0)
    .describe(
      'Clients currently waiting on this job (identical POSTs from different clients share one job). ' +
        'DELETE removes only the caller: the job is cancelled when the last one leaves, otherwise it keeps running for the others. 0 once finished.',
    ),
  created_at: IsoUtc,
  started_at: IsoUtc.nullable(),
  finished_at: IsoUtc.nullable(),
  expires_at: IsoUtc.nullable(),
});
export type Job = z.output<typeof JobShape>;
export const Job = JobShape.meta({ id: 'Job', examples: [exampleJob('succeeded')] });

export const JobParams = z.strictObject({ job_id: JobId });
export const JobArtifactParams = z.strictObject({ job_id: JobId, name: ArtifactName });

const JobArtifactsResponseShape = z.object({
  job_id: JobId,
  type: JobType,
  status: JobStatus,
  artifacts: z.array(JobArtifact),
});
export type JobArtifactsResponse = z.output<typeof JobArtifactsResponseShape>;
export const JobArtifactsResponse = JobArtifactsResponseShape.meta({ id: 'JobArtifactsResponse' });
