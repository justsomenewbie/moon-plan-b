/**
 * GET /api/v1/capabilities - what THIS server can run (docs/PYTHON_INTEGRATION.md section 5):
 * ephemeris providers, DEMs (Trek GeoTIFFs present? PGDA reachable?), job types, sync tools and
 * lunarnav CLI flags (e.g. --near-exclusion-m, detected from the CLI help output).
 * Probed at startup and cached (CAPABILITIES_TTL_S); `?refresh=true` re-probes (coalesced).
 */
import { z } from 'zod';
import { IsoUtc } from './common.ts';
import { JobType } from './jobs.ts';

export const Availability = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable().describe('Why it is not available (null when available)'),
  })
  .meta({ id: 'Availability' });
export type Availability = z.output<typeof Availability>;

const Reachability = z.object({
  reachable: z.boolean().nullable().describe('null = not probed (CAPABILITIES_NETWORK_PROBE off)'),
  latency_ms: z.number().nullable(),
  error: z.string().nullable(),
});

const CapabilitiesShape = z.object({
  checked_at: IsoUtc,
  python: z.object({
    ok: z.boolean(),
    python_version: z.string().nullable(),
    lunarnav_code_version: z.string().nullable(),
    error: z.string().nullable(),
  }),
  cli: z.object({
    subcommands: z.array(z.string()).describe('lunarnav CLI sub-commands (from its argparse help)'),
    near_exclusion_m: z.boolean().describe('The installed CLI supports --near-exclusion-m (request field near_exclusion_m)'),
    flags: z.record(z.string(), z.array(z.string())).describe('Long options per sub-command, from `lunarnav <cmd> --help`'),
  }),
  modules: z.record(z.string(), z.boolean()).describe('Python modules importable by the interpreter (spiceypy, rasterio, lunarnav.validate...)'),
  providers: z.object({ spice: Availability, horizons: Availability, analytic: Availability }),
  dems: z.object({
    pgda: Availability.extend({ cached_products: z.int().min(0).describe('PGDA products with a local tile cache') }),
    trek: Availability.extend({
      files: z.array(z.object({ label: z.string(), bytes: z.int().min(0) })).describe('Moon Trek GeoTIFFs present in LUNARNAV_DATA/dem (never downloaded by the API)'),
    }),
    none: Availability,
  }),
  horizon_methods: z.array(z.enum(['raymarch', 'bruteforce', 'flat'])),
  network: z.object({ horizons: Reachability, pgda: Reachability }),
  job_types: z.array(
    z.object({
      type: JobType,
      implemented: z.boolean().describe('false = registered placeholder (POST answers 501 JOB_TYPE_UNAVAILABLE)'),
      available: z.boolean(),
      reason: z.string().nullable(),
      timeout_s: z.int(),
      result_ttl_h: z.number(),
      limits: z.record(z.string(), z.unknown()).describe('Type-specific request limits'),
    }),
  ),
  tools: z.record(z.string(), Availability).describe('Synchronous tools under /api/v1/tools/*'),
});
export type Capabilities = z.output<typeof CapabilitiesShape>;
export const Capabilities = CapabilitiesShape.meta({ id: 'Capabilities' });

export const CapabilitiesQuery = z.strictObject({
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true')
    .describe('true = probe again now instead of serving the cached result'),
});
