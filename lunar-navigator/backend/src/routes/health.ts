/** GET /api/v1/health - contract: src/contract/health.ts (plan 6.2 #1). */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { API_VERSION, HealthResponse } from '../contract/health.ts';
import { problemResponses } from '../lib/problem.ts';
import { pingDb } from '../db.ts';
import { toIsoUtc } from '../lib/time.ts';
import { getDefaultRunId } from '../repos/index.ts';
import { checkPython } from '../python/lunarnav.ts';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        operationId: 'getHealth',
        summary: 'Liveness + dependency status',
        description:
          'Always 200 while the process is up; `status` is `degraded` when MongoDB or Python (the lunarnav bridge used by jobs and alt-dates) is not usable. ' +
          'The Python probe starts the interpreter once and is cached for 60 s.',
        security: [], // public liveness probe: no API key (lib/auth.ts exempts this route)
        response: { 200: HealthResponse, ...problemResponses() },
      },
      config: { rateLimit: false },
    },
    async () => {
      const [latency, py] = await Promise.all([pingDb(), checkPython(app.config)]);
      const defaultRunId = latency === null ? null : await getDefaultRunId().catch(() => null);
      return {
        status: latency !== null && py.ok ? 'ok' : 'degraded',
        api_version: API_VERSION,
        node_version: process.version,
        time_utc: toIsoUtc(Date.now()),
        uptime_s: Math.round(process.uptime() * 10) / 10,
        mongo: { ok: latency !== null, latency_ms: latency, db: app.config.MONGODB_DB },
        python: { ok: py.ok, bin: app.config.PYTHON_BIN, lunarnav_code_version: py.lunarnav_version },
        default_run_id: defaultRunId,
      } as const;
    },
  );
};

export default healthRoutes;
