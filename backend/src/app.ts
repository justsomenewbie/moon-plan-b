/**
 * buildApp(opts): the Fastify application factory (used by server.ts, tests and the OpenAPI export).
 *
 * Order matters: compilers -> error/404 handlers -> security/infra plugins -> swagger -> routes.
 * Every route module under src/routes/ is an async plugin registered below with prefix /api/v1;
 * engineers change handlers inside their own route file, never this list (unless adding a group).
 */
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ResponseSerializationError,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { loadConfig, type Config, type ConfigInput } from './config.ts';
import { closeDb, connectDb, ensureIndexes } from './db.ts';
import { API_VERSION } from './contract/health.ts';
import { ApiError, PROBLEM_CONTENT_TYPE, PROBLEM_DESCRIPTION_401, isApiError, problemBody, validationProblem, type Problem } from './lib/problem.ts';
import { fromWire, namingHooksEnabled, toWire } from './lib/naming.ts';
import { applyResponseExamples, applySecurityResponses, pruneComponents } from './lib/openapi.ts';
import { API_KEY_SCHEME, authSettings, createAuthHook, rateLimitKey } from './lib/auth.ts';
import healthRoutes from './routes/health.ts';
import metaRoutes from './routes/meta.ts';
import runsRoutes from './routes/runs.ts';
import sitesRoutes from './routes/sites.ts';
import seriesRoutes from './routes/series.ts';
import windowsRoutes from './routes/windows.ts';
import analysisRoutes from './routes/analysis.ts';
import altDatesRoutes from './routes/alt_dates.ts';
import jobsRoutes from './routes/jobs.ts';
import exportRoutes from './routes/export.ts';
import datasetRoutes from './routes/dataset.ts';
import capabilitiesRoutes from './routes/capabilities.ts';
import toolsRoutes from './routes/tools.ts';
import missionRoutes from './routes/mission.ts';
import pointingRoutes from './routes/pointing.ts';

export const API_PREFIX = '/api/v1';
export const OPENAPI_JSON_PATH = `${API_PREFIX}/openapi.json`;
export const DOCS_PATH = '/docs';
export const HEALTH_PATH = `${API_PREFIX}/health`;

/**
 * CORS_ORIGINS entry -> @fastify/cors origin: exact string, or a RegExp when the entry contains '*'
 * (each '*' matches exactly one DNS label: https://*.vercel.app matches https://my-fe-git-x.vercel.app,
 * not https://vercel.app or https://a.b.vercel.app).
 */
export function corsOriginMatcher(entry: string): string | RegExp {
  if (!entry.includes('*')) return entry;
  const re = entry
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('[a-z0-9-]+');
  return new RegExp(`^${re}$`, 'i');
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

/** The app instance type (zod type provider). */
export type App = FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, FastifyBaseLogger, ZodTypeProvider>;

export interface BuildAppOptions {
  /** Overrides on top of process.env (validated by ConfigSchema). */
  config?: Partial<ConfigInput>;
  /**
   * 'required' (default): connect + ensureIndexes, throw if MongoDB is unreachable.
   * 'optional': try, log a warning and run degraded (handlers using getDb() answer 503).
   * 'none': never connect (OpenAPI export).
   */
  db?: 'required' | 'optional' | 'none';
  /** Fastify logger option; default: pino at LOG_LEVEL (silent in tests if LOG_LEVEL=silent). */
  logger?: FastifyServerOptions['logger'];
}

const isSerializationError = (e: unknown): e is ResponseSerializationError =>
  typeof e === 'object' && e !== null && isResponseSerializationError(e);

/** Map any thrown error to a problem body (RFC 9457). */
function toProblem(err: unknown, instance: string): { body: Problem; headers: Record<string, string> } {
  if (isApiError(err)) return { body: problemBody(err.code, instance, err.message, err.extras), headers: err.extras.headers ?? {} };
  if (hasZodFastifySchemaValidationErrors(err)) return { body: validationProblem(err.validation, err.validationContext, instance), headers: {} };
  if (isSerializationError(err)) {
    return { body: problemBody('INTERNAL', instance, 'response did not match the API contract (see server log)'), headers: {} };
  }
  const fe = (typeof err === 'object' && err !== null ? err : {}) as Partial<FastifyError>;
  const status = typeof fe.statusCode === 'number' ? fe.statusCode : 500;
  const detail = typeof fe.message === 'string' ? fe.message : 'error';
  switch (status) {
    case 400:
      return { body: problemBody('VALIDATION_ERROR', instance, detail), headers: {} };
    case 401:
      return { body: problemBody('UNAUTHORIZED', instance, detail), headers: {} };
    case 404:
      return { body: problemBody('NOT_FOUND', instance, detail), headers: {} };
    case 405:
      return { body: problemBody('METHOD_NOT_ALLOWED', instance, detail), headers: {} };
    case 413:
      return { body: problemBody('PAYLOAD_TOO_LARGE', instance, detail), headers: {} };
    case 415:
      return { body: problemBody('UNSUPPORTED_MEDIA_TYPE', instance, detail), headers: {} };
    case 429:
      return { body: problemBody('RATE_LIMITED', instance, detail), headers: {} };
    default:
      return { body: problemBody('INTERNAL', instance, status >= 500 ? 'unexpected server error' : detail), headers: {} };
  }
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<App> {
  const config = loadConfig({ ...process.env, ...opts.config });

  const app = Fastify({
    logger: opts.logger ?? { level: config.LOG_LEVEL },
    bodyLimit: 1024 * 1024,
    trustProxy: 'loopback',
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 300 },
  }).withTypeProvider<ZodTypeProvider>();

  // Request bodies are JSON only: without the default text/plain parser a text body gets 415
  // UNSUPPORTED_MEDIA_TYPE like every other non-JSON type (instead of a confusing 400 "received string").
  app.removeContentTypeParser('text/plain');
  app.decorate('config', config);
  app.decorateRequest('apiClient', undefined);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ---- errors: every 4xx/5xx is application/problem+json ------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    const instance = req.url.split('?')[0] ?? req.url;
    const { body, headers } = toProblem(err, instance);
    if (body.status >= 500) {
      const issues = isSerializationError(err) ? err.cause.issues : undefined;
      req.log.error({ err, issues }, 'request failed');
    } else {
      req.log.info({ code: body.code, status: body.status }, body.detail ?? body.title);
    }
    return reply.status(body.status).headers(headers).type(PROBLEM_CONTENT_TYPE).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const instance = req.url.split('?')[0] ?? req.url;
    const body = problemBody('NOT_FOUND', instance, `no route ${req.method} ${instance}`, {
      hint: `API routes start with ${API_PREFIX}; documentation at ${DOCS_PATH}`,
    });
    return reply.status(404).type(PROBLEM_CONTENT_TYPE).send(body);
  });

  // ---- infra plugins --------------------------------------------------------------------------------
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    // Entries may contain '*' for one DNS label, e.g. https://*.vercel.app (FE preview deployments).
    origin: config.CORS_ORIGINS.includes('*') ? true : config.CORS_ORIGINS.map(corsOriginMatcher),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['etag', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-lunarnav-cache', 'content-disposition', 'location'],
    maxAge: 600,
  });
  // Authentication: ONE root onRequest hook, added after CORS (a 401 still carries the CORS headers) and
  // before every route, so it runs ahead of the route-level rate-limit hooks (lib/auth.ts).
  const auth = authSettings(config);
  for (const w of auth.warnings) app.log.warn(w);
  app.addHook('onRequest', createAuthHook(config, { apiPrefix: API_PREFIX, healthPath: HEALTH_PATH, openapiPath: OPENAPI_JSON_PATH, docsPath: DOCS_PATH }));
  if (config.COMPRESS) await app.register(compress, { threshold: 1024, brotliOptions: { params: { 1: 4 } } });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    // Per API client (key name) when authenticated, else per IP (auth off / public routes) as before.
    keyGenerator: rateLimitKey,
    errorResponseBuilder: (_req, ctx) =>
      new ApiError('RATE_LIMITED', `rate limit of ${ctx.max} requests per ${ctx.after} exceeded`, {
        extensions: { retry_after_s: Math.ceil(ctx.ttl / 1000) },
      }),
  });

  if (namingHooksEnabled()) {
    // Only active if lib/naming.ts switches FIELD_CASE (not in v1).
    app.addHook('preValidation', async (req) => {
      req.body = fromWire(req.body);
      req.query = fromWire(req.query);
    });
    app.addHook('preSerialization', async (_req, _reply, payload) => toWire(payload));
  }

  // ---- OpenAPI ----------------------------------------------------------------------------------------
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Lunar Landing Site Navigator API',
        version: API_VERSION,
        description:
          'NASA Space Apps 2026. Sun / Earth visibility, windows and rankings of lunar landing sites computed by the Python package `lunarnav`.\n\n' +
          '* JSON keys are snake_case = docs/OUTPUT_SPEC.md; times are ISO 8601 UTC `YYYY-MM-DDTHH:MM:SSZ`; ranges are `[start, end)`.\n' +
          '* `run_id` is optional on every data GET (default run). Site ids may contain `:` -> encodeURIComponent() them.\n' +
          '* Every error is `application/problem+json` (RFC 9457) with a stable `code`.\n' +
          '* Authentication: every /api/v1 route except GET /api/v1/health needs an API key in `X-API-Key: <key>` (or `Authorization: Bearer <key>`); a missing or wrong key -> 401 `UNAUTHORIZED`. ' +
          'Call the API from a server (e.g. a Next.js route handler) so the key never reaches the browser. In Swagger UI use **Authorize**.\n' +
          '* v1 only grows additively; breaking changes go to /api/v2.\n' +
          '* Examples come from the real 2026-Q1 sample run (6 sites, 2026-01-01..2026-04-01 hourly, SPICE + PGDA); full captured responses are in backend/contract/examples/.',
      },
      servers: [{ url: '/', description: 'This server' }],
      // Global requirement; GET /health opts out with `security: []`. Enforced by lib/auth.ts (off when API_KEYS is empty outside production).
      security: [{ [API_KEY_SCHEME]: [] }],
      components: {
        securitySchemes: {
          [API_KEY_SCHEME]: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            description: 'API key issued by the backend operator (`Authorization: Bearer <key>` is accepted too). Keep it server side.',
          },
        },
      },
      tags: [
        { name: 'meta', description: 'Health, enums and limits' },
        { name: 'runs', description: 'Imported precompute runs' },
        { name: 'sites', description: 'Site catalog, site card, horizon' },
        { name: 'series', description: 'Hourly series and instant readout' },
        { name: 'windows', description: 'Visibility windows (timeline bands)' },
        { name: 'analysis', description: 'Compare and rank sites' },
        { name: 'alt-dates', description: 'Alternative landing dates (Python bridge)' },
        { name: 'jobs', description: 'Async Python jobs (custom_site, precompute, analyse, validate, ...)' },
        { name: 'tools', description: 'Synchronous Python tools (ephemeris, horizon)' },
        { name: 'export', description: 'CSV exports and raw files' },
        { name: 'mission', description: 'Mission energy: lander battery survival' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: (doc) =>
      applySecurityResponses(applyResponseExamples(pruneComponents(jsonSchemaTransformObject(doc))), PROBLEM_DESCRIPTION_401, PROBLEM_CONTENT_TYPE),
  });
  // staticCSP adds `upgrade-insecure-requests`, which makes browsers fetch /docs/static/* over https and
  // leaves a blank page when the API is served over plain http on a LAN IP (localhost is exempt). Strip
  // only that directive; TLS (Caddy on the VPS) still enforces https in production.
  await app.register(swaggerUi, {
    routePrefix: DOCS_PATH,
    staticCSP: true,
    transformStaticCSP: (header: string) => header.replace(/\s*upgrade-insecure-requests;?/g, ''),
    uiConfig: { deepLinking: true, docExpansion: 'list', persistAuthorization: true },
  });

  app.get(OPENAPI_JSON_PATH, { schema: { hide: true } }, async (_req, reply) => reply.type('application/json; charset=utf-8').send(app.swagger()));

  // ---- API routes ---------------------------------------------------------------------------------
  const routeModules = [healthRoutes, metaRoutes, runsRoutes, sitesRoutes, seriesRoutes, windowsRoutes, analysisRoutes, altDatesRoutes, jobsRoutes, exportRoutes, datasetRoutes, capabilitiesRoutes, toolsRoutes, missionRoutes, pointingRoutes];
  for (const mod of routeModules) await app.register(mod, { prefix: API_PREFIX });

  // ---- database -----------------------------------------------------------------------------------
  const dbMode = opts.db ?? 'required';
  if (dbMode !== 'none') {
    try {
      const db = await connectDb(config.MONGODB_URI, config.MONGODB_DB);
      await ensureIndexes(db);
    } catch (e) {
      if (dbMode === 'required') {
        await closeDb();
        throw e;
      }
      app.log.warn({ err: e }, 'MongoDB not reachable - running degraded (data routes answer 503)');
    }
    app.addHook('onClose', async () => {
      await closeDb();
    });
  }

  return app;
}
