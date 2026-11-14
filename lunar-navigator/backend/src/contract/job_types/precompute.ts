/**
 * POST /api/v1/jobs request + Job.output of job type 'precompute'.
 * OWNER: builder B1 (compute) (docs/PYTHON_INTEGRATION.md section 6). Only the owner edits this file.
 *
 * `lunarnav precompute` for catalog sites (list | 'all' | 'group:<g>') and/or custom coordinates, any
 * range / step, full ComputeOptions; the output directory is imported as a new run (kind 'precompute',
 * run id `job_<job_id>` = result.run_id). Guard rails (checked at POST, before anything is queued):
 * PRECOMPUTE_LIMITS (sites, samples per site, sites x samples -> 422 JOB_TOO_LARGE), Trek only when its
 * GeoTIFFs are on the server, near_exclusion_m only when the CLI supports it (422 CAPABILITY_UNAVAILABLE).
 *
 * The site / range part (SiteSelection, CustomSiteInput, ComputeRangeShape) is shared with 'analyse'.
 */
import { z } from 'zod';
import { IsoUtc, IsoUtcInput, Lat, RunId, SiteId } from '../common.ts';
import { ComputeOptionsShape, JobName } from './common.ts';

/** Request limits of precompute / analyse (also in GET /capabilities job_types[].limits). */
export const PRECOMPUTE_LIMITS = {
  /** Distinct sites of one job (after expanding 'all' / 'group:<g>'). */
  max_sites: 30,
  /** custom_sites entries of one request. */
  max_custom_sites: 10,
  /** Samples of one site = (end - start) / step. */
  max_samples_per_site: 100_000,
  /** sites x samples of one job. */
  max_site_samples: 600_000,
  /** sites x samples with provider horizons (JPL API, network). */
  max_site_samples_horizons: 150_000,
  /** Requested instants must lie in [min_utc, max_utc). */
  min_utc: '1900-01-01T00:00:00Z',
  max_utc: '2150-01-01T00:00:00Z',
} as const;

const SITE_SELECTOR_RE = /^(?:all|group:[A-Za-z0-9_.-]{1,64}|[A-Za-z0-9_.:-]{1,64})$/;

export const SiteSelector = z
  .string()
  .regex(SITE_SELECTOR_RE, "a catalog site id, a canonical custom id (custom:<lat>:<lon>), 'all' or 'group:<name>'")
  .describe("Catalog site id, canonical custom id `custom:<lat>:<lon>`, `all` (whole catalog) or `group:<name>` (catalog group, e.g. group:south_pole)")
  .meta({ examples: ['group:south_pole'] });

export const SiteSelection = z
  .union([SiteSelector, z.array(SiteSelector).max(64)])
  .describe("One selector or a list of selectors (catalog ids, custom ids, 'all', 'group:<name>'); duplicates are merged");

export const CustomSiteInput = z
  .strictObject({
    lat_deg: Lat,
    lon_deg: z.number().min(-360).max(360).describe('Longitude, deg; EAST-positive (west-negative values are converted to [0, 360))'),
  })
  .describe('A custom coordinate; its site id is the canonical custom:<lat>:<lon> (4 decimals)');

/** Sites + range + ComputeOptions: the part of the request shared by precompute and analyse. */
export const ComputeRangeShape = {
  sites: SiteSelection.default([]).describe('Catalog / custom site selectors (give sites and/or custom_sites)'),
  custom_sites: z.array(CustomSiteInput).max(PRECOMPUTE_LIMITS.max_custom_sites).default([]),
  start: IsoUtcInput.describe('Snapped DOWN to the step grid'),
  end: IsoUtcInput.describe('EXCLUSIVE end; snapped UP to the step grid'),
  ...ComputeOptionsShape,
} as const;

export const PrecomputeJobRequest = z
  .strictObject({
    type: z.literal('precompute'),
    name: JobName.optional(),
    ...ComputeRangeShape,
    run_label: z.string().min(1).max(80).optional().describe('Label of the imported run (run picker); default: name or a generated label'),
  })
  .meta({
    id: 'PrecomputeJobRequest',
    description:
      'lunarnav precompute for catalog and/or custom sites; the output is imported as a run of kind precompute (result.run_id). ' +
      'Limits: GET /api/v1/capabilities job_types[type=precompute].limits.',
  });
export type PrecomputeJobRequest = z.output<typeof PrecomputeJobRequest>;

export const PrecomputeSiteOutput = z.object({
  site_id: SiteId,
  name: z.string(),
  dem_source: z.string().nullable().describe("Terrain actually used ('none:outside-<dem>-coverage' = smooth-sphere fallback)"),
  horizon_method: z.string(),
  dem_fallback: z.boolean().describe('true = the site was outside the DEM coverage and got the smooth-sphere horizon'),
});

/** Job.output of a succeeded 'precompute' job (the data itself: normal endpoints with run_id). */
export const PrecomputeJobOutput = z.object({
  run_id: RunId,
  run_label: z.string(),
  n_sites: z.int().min(1),
  start: IsoUtc,
  end: IsoUtc,
  step_min: z.number(),
  n_samples: z.int().min(1).describe('Samples per site'),
  sites: z.array(PrecomputeSiteOutput),
});
export type PrecomputeJobOutput = z.output<typeof PrecomputeJobOutput>;
