/**
 * Shared building blocks of the job-type request schemas (docs/PYTHON_INTEGRATION.md).
 * OWNER: skeleton (shared) - builders IMPORT from here, they do not edit it (ask the coordinator).
 *
 * Every job-type request is a `z.strictObject({ type: z.literal('<type>'), ... })` in its own file under
 * src/contract/job_types/; src/contract/jobs.ts joins them into the `CreateJobRequest` discriminated union.
 * Keep requests strict (unknown keys -> 400) and give every option a default, so the canonical params
 * (= what is hashed into params_hash) are explicit.
 */
import { z } from 'zod';

/** Display name of a job (not hashed). Shared by every job type. */
export const JobName = z.string().min(1).max(80).describe('Display name (not part of the job identity)');

/** Ephemeris providers a job may use (lunarnav --provider; 'synthetic' is test-only and never exposed). */
export const JobProvider = z.enum(['spice', 'horizons', 'analytic']).describe('Ephemeris method: spice (local kernels), horizons (JPL API, network), analytic (approximate)');
/** Terrain sources (lunarnav --dem). trek needs the GeoTIFF files on the server (GET /capabilities). */
export const JobDem = z.enum(['pgda', 'trek', 'none']).describe('Terrain: pgda (LOLA 20 m tiles, downloaded on demand), trek (local Moon Trek GeoTIFF only), none (smooth sphere)');
export const JobHorizonMethod = z.enum(['raymarch', 'bruteforce', 'flat']);
export const JobDemFallback = z.enum(['flat', 'error']).describe('Sites outside the DEM coverage: flat = smooth-sphere horizon (recorded in dem_source), error = fail the job');
/** 'auto' or metres >= 0. Accepted only when GET /capabilities says cli.near_exclusion_m = true. */
export const NearExclusion = z
  .union([z.literal('auto'), z.number().min(0).max(5000)])
  .describe("raymarch: ignore terrain closer than this many metres; 'auto' = lunarnav default. Only when capabilities.cli.near_exclusion_m");

/**
 * Hard upper bounds shared by the compute job types (precompute / analyse / alt_dates_python).
 * Per-type limits (max sites x samples...) live in the type's own file.
 */
export const COMPUTE_LIMITS = {
  step_min_min: 1,
  step_min_max: 1440,
  radius_km_max: 300,
  az_step_deg_min: 0.05,
  az_step_deg_max: 10,
  observer_height_m_max: 100,
  min_clearance_deg_max: 10,
} as const;

/**
 * Computation options of lunarnav `_add_common` (cli.py), as zod fields with the CLI defaults - except
 * provider (horizons: online JPL API, chosen by the user 14/11 - call online sources, download only what must be
 * local; spice stays available offline), dem (pgda, read on demand over HTTP) and dem_fallback (flat), which are the web defaults.
 * Spread into a request: `z.strictObject({ type: ..., ...ComputeOptionsShape, ... })`.
 */
export const ComputeOptionsShape = {
  step_min: z.number().min(COMPUTE_LIMITS.step_min_min).max(COMPUTE_LIMITS.step_min_max).default(60).describe('Time step, minutes'),
  provider: JobProvider.default('horizons'),
  dem: JobDem.default('pgda'),
  horizon_method: JobHorizonMethod.default('raymarch').describe("Forced to 'flat' when dem = none"),
  radius_km: z.number().positive().max(COMPUTE_LIMITS.radius_km_max).default(150).describe('Horizon search radius, km'),
  az_step_deg: z.number().min(COMPUTE_LIMITS.az_step_deg_min).max(COMPUTE_LIMITS.az_step_deg_max).default(0.5).describe('Horizon azimuth step, deg'),
  observer_height_m: z.number().min(0).max(COMPUTE_LIMITS.observer_height_m_max).default(2).describe('Mast height above local terrain, m'),
  min_clearance_deg: z.number().min(0).max(COMPUTE_LIMITS.min_clearance_deg_max).default(0).describe('Earth must be this many deg above the horizon'),
  dem_fallback: JobDemFallback.default('flat'),
  near_exclusion_m: NearExclusion.optional(),
} as const;

export const ComputeOptions = z.strictObject(ComputeOptionsShape);
export type ComputeOptions = z.output<typeof ComputeOptions>;

// ---- artifacts (files a job produced: GET /jobs/{id}/artifacts[/{name}]) ---------------------------
/** Flat file names only (no directories, no leading dot): the artifact store never resolves a path from them. */
export const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const ArtifactName = z
  .string()
  .regex(ARTIFACT_NAME_RE, 'artifact names match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}')
  .describe('Artifact file name (flat, no directories)')
  .meta({ examples: ['report.json'] });

export const JobArtifact = z
  .object({
    name: ArtifactName,
    media_type: z.string().describe('Content-Type the file is served with'),
    bytes: z.int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    url: z.string().describe('Relative URL of the file (GET)'),
  })
  .meta({ id: 'JobArtifact' });
export type JobArtifact = z.output<typeof JobArtifact>;
