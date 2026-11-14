/**
 * GET /api/v1/capabilities - contract: src/contract/capabilities.ts, service: src/python/capabilities.ts.
 * The first probe starts in the background when the server is ready (so the CLI flags are known before
 * the first job), except under NODE_ENV=test.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Capabilities, CapabilitiesQuery } from '../contract/capabilities.ts';
import { problemResponses } from '../lib/problem.ts';
import { getCapabilities } from '../python/capabilities.ts';

export const capabilitiesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onReady', async () => {
    if (app.config.NODE_ENV === 'test') return;
    void getCapabilities(app.config).then(
      (c) => app.log.info({ python_ok: c.python.ok, near_exclusion_m: c.cli.near_exclusion_m, trek_files: c.dems.trek.files.length }, 'capabilities probed'),
      (err: unknown) => app.log.warn({ err }, 'capabilities probe failed'),
    );
  });

  app.get(
    '/capabilities',
    {
      schema: {
        tags: ['meta'],
        operationId: 'getCapabilities',
        summary: 'What this server can run (providers, DEMs, job types, tools, CLI flags)',
        description:
          'Probed at startup and cached (CAPABILITIES_TTL_S, default 600 s; `checked_at`). `?refresh=true` probes again ' +
          '(at most every 30 s). Use it to enable / disable UI options: a job type with available = false answers ' +
          '501 JOB_TYPE_UNAVAILABLE, an option the server lacks (dem trek without files, near_exclusion_m without CLI support) ' +
          '422 CAPABILITY_UNAVAILABLE. Network reachability is null when the probe is disabled.',
        querystring: CapabilitiesQuery,
        response: { 200: Capabilities, ...problemResponses(400) },
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return getCapabilities(app.config, { force: req.query.refresh });
    },
  );
};

export default capabilitiesRoutes;
