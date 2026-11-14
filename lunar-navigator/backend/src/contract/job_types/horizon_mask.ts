/**
 * POST /api/v1/jobs request + Job.output of job type 'horizon_mask'.
 * OWNER: builder B4 (tools) (docs/PYTHON_INTEGRATION.md section 6). Only the owner edits this file.
 *
 * Async version of POST /api/v1/tools/horizon for masks that may exceed the sync timeout: any radius up to
 * COMPUTE_LIMITS.radius_km_max (precompute runs use 150 km), az step down to 0.05 deg, method bruteforce,
 * dem trek (only when its GeoTIFFs are on the server). Same site resolution and the same horizon factory
 * (lunarnav.precompute.make_horizon_fn) as the tool; the full mask is the artifact `horizon.json`
 * (= a HorizonToolResponse document), Job.output a small summary.
 */
import { z } from 'zod';
import { HorizonToolResponse, ToolRounding, ToolSite, refineSite, siteFields } from '../tools.ts';
import { COMPUTE_LIMITS, JobDem, JobDemFallback, JobHorizonMethod, JobName, NearExclusion } from './common.ts';

export const HORIZON_MASK_ARTIFACT = 'horizon.json';

export const HORIZON_MASK_LIMITS = {
  radius_km_max: COMPUTE_LIMITS.radius_km_max,
  az_step_deg_min: COMPUTE_LIMITS.az_step_deg_min,
  az_step_deg_max: COMPUTE_LIMITS.az_step_deg_max,
  observer_height_m_max: COMPUTE_LIMITS.observer_height_m_max,
  /** Python timeout of one job, s. */
  timeout_s: 1800,
} as const;

const HorizonMaskJobRequestShape = z.strictObject({
  type: z.literal('horizon_mask'),
  name: JobName.optional(),
  ...siteFields,
  dem: JobDem.default('pgda'),
  method: JobHorizonMethod.default('raymarch').describe("Forced to 'flat' when dem = none"),
  radius_km: z.number().positive().max(HORIZON_MASK_LIMITS.radius_km_max).default(150).describe('Search radius, km (150 = what precompute runs use)'),
  az_step_deg: z
    .number()
    .min(HORIZON_MASK_LIMITS.az_step_deg_min)
    .max(HORIZON_MASK_LIMITS.az_step_deg_max)
    .default(0.5)
    .refine((v) => Math.abs(360 / v - Math.round(360 / v)) < 1e-9, { message: 'must divide 360' })
    .describe('Azimuth step, deg (must divide 360)'),
  observer_height_m: z.number().min(0).max(HORIZON_MASK_LIMITS.observer_height_m_max).default(2).describe('Mast height above the surface, m'),
  near_exclusion_m: NearExclusion.optional(),
  dem_fallback: JobDemFallback.default('flat'),
  rounding: ToolRounding.default('run_files'),
});

export const HorizonMaskJobRequest = refineSite(HorizonMaskJobRequestShape)
  .describe('Terrain horizon mask of one point as a job (async POST /tools/horizon without its radius / step / method limits). Result: artifact horizon.json')
  .meta({
    id: 'HorizonMaskJobRequest',
    examples: [{ type: 'horizon_mask', site_id: 'ref_shackleton_rim', dem: 'pgda', method: 'raymarch', radius_km: 150, az_step_deg: 0.5 }],
  });
export type HorizonMaskJobRequest = z.output<typeof HorizonMaskJobRequest>;

/** Job.output of a succeeded 'horizon_mask' job (the full mask: artifact horizon.json, a HorizonToolResponse). */
export const HorizonMaskJobOutput = z.object({
  site: ToolSite,
  method: HorizonToolResponse.shape.method,
  dem_source: z.string(),
  radius_km: z.number(),
  az_step_deg: z.number(),
  observer_height_m: z.number(),
  surface_height_m: z.number(),
  near_exclusion_m: z.number().nullable(),
  dem_fallback: z.string().nullable(),
  n_az: z.int().min(1),
  min_el_deg: z.number(),
  max_el_deg: z.number(),
  elapsed_ms: z.int().min(0),
  artifact: z.literal(HORIZON_MASK_ARTIFACT).describe('Artifact holding the full mask (HorizonToolResponse document)'),
});
export type HorizonMaskJobOutput = z.output<typeof HorizonMaskJobOutput>;
