/**
 * POST /api/v1/alt-dates (plan 6.2 #12; plan 7.1) - contract: src/contract/alt_dates.ts.
 * Synchronous Python bridge (backend/python/alt_dates_json.py, ALTDATES_TIMEOUT_S) on the stored
 * visibility file of the run + `cache` collection - service: src/python/altDates.ts.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AltDatesRequest, AltDatesResponse } from '../contract/alt_dates.ts';
import { problemResponses } from '../lib/problem.ts';
import { COLLECTIONS, registerCollection } from '../db.ts';
import { AltDatesService } from '../python/altDates.ts';

registerCollection({
  name: COLLECTIONS.cache,
  owner: 'routes/alt_dates.ts',
  indexes: [
    { key: { expires_at: 1 }, name: 'expires_at_ttl', expireAfterSeconds: 0 },
    { key: { run_id: 1 }, name: 'run_id_1' },
  ],
});

export const CACHE_HEADER = 'x-lunarnav-cache';

export const altDatesRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new AltDatesService(app.config);

  app.post(
    '/alt-dates',
    {
      schema: {
        tags: ['alt-dates'],
        operationId: 'findAltDates',
        summary: 'Alternative landing dates for one site (slip calendar)',
        description:
          `Synchronous (<= ${app.config.ALTDATES_TIMEOUT_S} s, ~0.5 s typical; identical requests are served from a 7-day cache, ` +
          `header \`${CACHE_HEADER}: hit|miss|shared\`). No feasible date = 200 with empty candidates + rejected_by. ` +
          'mission_h not a multiple of the step -> 422 BAD_MISSION_LENGTH; earliest before the run start -> 422 OUT_OF_RANGE (min_earliest); ' +
          'latest + mission_h past the run end -> 422 OUT_OF_RANGE (max_latest); latest < earliest -> 400. ' +
          'Works on custom job runs too (run_id = job_...).',
        body: AltDatesRequest,
        response: { 200: AltDatesResponse, ...problemResponses(400, 404, 409, 413, 415, 422, 502, 503, 504) },
      },
      config: { rateLimit: { max: app.config.RATE_LIMIT_POST_MAX, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const r = await service.find(req.body);
      reply.header(CACHE_HEADER, r.cache);
      return r.body;
    },
  );
};

export default altDatesRoutes;
