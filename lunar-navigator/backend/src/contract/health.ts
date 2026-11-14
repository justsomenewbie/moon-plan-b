/** GET /api/v1/health (plan 6.2 #1). */
import { z } from 'zod';
import { RunId } from './common.ts';

export const API_VERSION = '1.0.0';

export const HealthResponse = z
  .object({
    status: z.enum(['ok', 'degraded']).describe('degraded = API is up but MongoDB or Python is not usable'),
    api_version: z.string().describe('Semantic version of this contract (v1 only grows additively)'),
    node_version: z.string(),
    time_utc: z.string().describe('Server time, ISO 8601 UTC'),
    uptime_s: z.number().min(0),
    mongo: z.object({
      ok: z.boolean(),
      latency_ms: z.number().nullable(),
      db: z.string().describe('Database name'),
    }),
    python: z.object({
      ok: z.boolean().nullable().describe('null = not checked yet'),
      bin: z.string().describe('Configured interpreter (path)'),
      lunarnav_code_version: z.string().nullable().describe('lunarnav.__version__ of the bridge interpreter'),
    }),
    default_run_id: RunId.nullable().describe('Run used when run_id is omitted; null when nothing is imported'),
  })
  .meta({
    id: 'Health',
    examples: [
      {
        status: 'ok',
        api_version: API_VERSION,
        node_version: 'v24.16.0',
        time_utc: '2026-11-14T09:30:00Z',
        uptime_s: 12.5,
        mongo: { ok: true, latency_ms: 0.8, db: 'lunarnav_dev' },
        python: { ok: true, bin: 'D:\\UAV\\lunar-navigator\\.venv\\Scripts\\python.exe', lunarnav_code_version: '0.1.0' },
        default_run_id: 'pf_21c3f3f6dc56b1e1',
      },
    ],
  });
export type HealthResponse = z.output<typeof HealthResponse>;
