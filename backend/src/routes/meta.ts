/** GET /api/v1/meta - contract: src/contract/meta.ts (plan 6.2 #2). Static, real data. */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { MetaResponse, buildMeta } from '../contract/meta.ts';
import { problemResponses } from '../lib/problem.ts';

export const metaRoutes: FastifyPluginAsyncZod = async (app) => {
  const meta = buildMeta(app.config);
  app.get(
    '/meta',
    {
      schema: {
        tags: ['meta'],
        operationId: 'getMeta',
        summary: 'Enums and limits for UI controls',
        description: 'Series fields with units, window kinds, ranking metrics + default weights, alt-date objectives, request limits.',
        response: { 200: MetaResponse, ...problemResponses() },
      },
    },
    async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=300');
      return meta;
    },
  );
};

export default metaRoutes;
