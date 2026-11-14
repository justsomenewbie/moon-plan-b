/** GET /api/v1/runs, GET /api/v1/runs/{run_id} (plan 6.2 #3: run picker + "about the data"). */
import { z } from 'zod';
import { IsoUtc, RunId, SiteId, StepS } from './common.ts';
import { RankWeights } from './common.ts';
import { exampleRunDetail, exampleRunsResponse } from '../fixtures/index.ts';

export const RunKind = z.enum(['precompute', 'custom']).describe('precompute = imported Colab output; custom = result of a POST /jobs');
export const RunStatus = z.enum(['importing', 'ready', 'failed']).describe('Only `ready` runs serve data (others -> 409 RUN_NOT_READY)');

export const RunSummary = z
  .object({
    run_id: RunId,
    kind: RunKind,
    is_default: z.boolean().describe('Used when a request omits run_id'),
    label: z.string(),
    status: RunStatus,
    imported_at: IsoUtc.nullable(),
    expires_at: IsoUtc.nullable().describe('custom runs are deleted after this instant; null = kept'),
    params_fingerprint: z.string().describe('16-hex hash of the computation parameters (lunarnav manifest)'),
    code_version: z.string().describe('lunarnav version that produced the run'),
    git_commit: z.string().nullable(),
    run_timestamp_utc: IsoUtc,
    provider: z.string().describe('Ephemeris method: horizons | spice | analytic | synthetic'),
    dem: z.string().describe('Terrain source: trek | pgda | none'),
    horizon_method: z.string().describe('raymarch | bruteforce | flat'),
    start_utc: IsoUtc,
    end_utc: IsoUtc.describe('EXCLUSIVE end'),
    step_s: StepS,
    n_samples: z.int().min(0),
    observer_height_m: z.number(),
    min_earth_clearance_deg: z.number(),
    rank_weights: RankWeights,
    site_ids: z.array(SiteId),
    n_sites: z.int().min(0),
  })
  .meta({ id: 'RunSummary' });
export type RunSummary = z.output<typeof RunSummary>;

export const RUNS_PAGE = { limit_default: 50, limit_max: 200 } as const;

export const RunsQuery = z.strictObject({
  kind: RunKind.optional().describe('Only runs of this kind'),
  status: RunStatus.optional().describe('Only runs with this status'),
  limit: z.coerce.number().int().min(1).max(RUNS_PAGE.limit_max).default(RUNS_PAGE.limit_default).describe('Page size'),
  offset: z.coerce.number().int().min(0).default(0).describe('Number of runs to skip (order: default run first, then most recently imported)'),
});
export type RunsQuery = z.output<typeof RunsQuery>;

const RunsResponseShape = z
  .object({
    default_run_id: RunId.nullable().describe('Run used when a request omits run_id (null = nothing imported yet)'),
    total: z.int().min(0).describe('Number of runs matching the filters (all pages)'),
    limit: z.int().min(1).max(RUNS_PAGE.limit_max).describe('Page size used'),
    offset: z.int().min(0).describe('Offset used'),
    runs: z.array(RunSummary).describe('This page: default run first, then most recently imported first'),
  });
export type RunsResponse = z.output<typeof RunsResponseShape>;
export const RunsResponse = RunsResponseShape.meta({
  id: 'RunsResponse',
  examples: [exampleRunsResponse()],
});

export const DataSource = z
  .looseObject({ name: z.string(), url: z.string().nullable(), sha256: z.string().nullable() })
  .meta({ id: 'DataSource' });

const RunDetailShape = RunSummary.extend({
  manifest: z.object({
    format: z.literal('lunarnav-precompute'),
    format_version: z.literal(1),
    parameters: z.record(z.string(), z.unknown()).describe('manifest.json "parameters" verbatim'),
    data_sources: z.array(DataSource),
    conventions: z.record(z.string(), z.string()).describe('Human-readable conventions (time, azimuth, ...)'),
    files: z
      .array(z.object({ path: z.string(), sha256: z.string() }))
      .describe('Raw files downloadable via GET /api/v1/runs/{run_id}/files/{file_path}'),
  }),
});
export type RunDetail = z.output<typeof RunDetailShape>;
export const RunDetail = RunDetailShape.meta({ id: 'RunDetail', examples: [exampleRunDetail()] });

export const RunParams = z.strictObject({ run_id: RunId });
