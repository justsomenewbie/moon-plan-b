/**
 * Authentication (registered by app.ts as ONE root onRequest hook, before every route and before the
 * route-level rate-limit hooks, so an unauthenticated flood is rejected after a hash + compare):
 *
 * - API key on every /api/v1/* request except GET /api/v1/health, /api/v1/openapi.json (docs auth below)
 *   and OPTIONS (CORS preflight): `X-API-Key: <key>` or `Authorization: Bearer <key>`. Missing and wrong
 *   keys get the SAME 401 UNAUTHORIZED problem. The matched client name is bound to the request logger
 *   (`client`) and is the rate-limit key (`rateLimitKey()`); the key itself is never logged.
 * - HTTP Basic auth on /docs, /docs/* and /api/v1/openapi.json (DOCS_USER / DOCS_PASSWORD).
 *
 * Comparisons are constant time: SHA-256 of the presented value vs SHA-256 of each configured value
 * (equal-length digests -> timingSafeEqual; every configured key is compared, no early exit).
 * Either part is OFF when its env vars are unset (allowed outside production only, see config.ts).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_KEY_MIN_LENGTH, DOCS_PASSWORD_MIN_LENGTH, type Config } from '../config.ts';
import { ApiError } from './problem.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Name of the API client whose key authenticated this request (undefined: no key needed / auth off). */
    apiClient: string | undefined;
  }
}

export const API_KEY_HEADER = 'x-api-key';
export const API_KEY_SCHEME = 'ApiKeyAuth';
export const WWW_AUTHENTICATE_API_KEY = 'ApiKey header="X-API-Key"';
export const WWW_AUTHENTICATE_DOCS = 'Basic realm="lunarnav docs"';

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time equality of two strings of any length (compares their SHA-256 digests). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export interface AuthPaths {
  apiPrefix: string;
  healthPath: string;
  openapiPath: string;
  docsPath: string;
}

export interface AuthSettings {
  apiKeys: boolean;
  docs: boolean;
  /** Startup warnings (auth disabled outside production, short secrets). */
  warnings: string[];
}

/** What the config enables; app.ts logs `warnings` once at startup. */
export function authSettings(config: Config): AuthSettings {
  const warnings: string[] = [];
  const apiKeys = config.API_KEYS.length > 0;
  const docs = config.DOCS_USER !== undefined && config.DOCS_PASSWORD !== undefined;
  if (!apiKeys) warnings.push(`API_KEYS is empty: API key authentication is DISABLED (NODE_ENV=${config.NODE_ENV}; mandatory in production)`);
  for (const e of config.API_KEYS) {
    if (e.key.length < API_KEY_MIN_LENGTH) warnings.push(`API key of client ${JSON.stringify(e.name)} is shorter than ${API_KEY_MIN_LENGTH} chars (rejected in production)`);
  }
  if (!docs) warnings.push(`DOCS_USER / DOCS_PASSWORD unset: /docs and the OpenAPI JSON are OPEN (NODE_ENV=${config.NODE_ENV}; mandatory in production)`);
  else if ((config.DOCS_PASSWORD ?? '').length < DOCS_PASSWORD_MIN_LENGTH) warnings.push(`DOCS_PASSWORD is shorter than ${DOCS_PASSWORD_MIN_LENGTH} chars (rejected in production)`);
  return { apiKeys, docs, warnings };
}

/** The presented API key: X-API-Key wins; else `Authorization: Bearer <key>` (Basic and other schemes are ignored). */
function presentedKey(req: FastifyRequest): string | undefined {
  const x = req.headers[API_KEY_HEADER];
  if (typeof x === 'string' && x.length > 0) return x.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(auth);
    if (m) return m[1];
  }
  return undefined;
}

/** Name of the client owning `key`, comparing against EVERY configured key in constant time. */
function matchKey(digests: readonly { name: string; digest: Buffer }[], key: string | undefined): string | undefined {
  // A missing key is hashed too, so missing and wrong keys cost the same.
  const d = sha256(key ?? '');
  let found: string | undefined;
  for (const e of digests) {
    if (timingSafeEqual(d, e.digest) && key !== undefined && found === undefined) found = e.name;
  }
  return found;
}

function basicCredentials(req: FastifyRequest): { user: string; password: string } | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return undefined;
  const m = /^Basic[ \t]+([A-Za-z0-9+/=]+)[ \t]*$/i.exec(auth);
  if (!m?.[1]) return undefined;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

export const unauthorizedApiKey = (): ApiError =>
  new ApiError('UNAUTHORIZED', 'send a valid API key in the X-API-Key header (or Authorization: Bearer <key>)', {
    headers: { 'www-authenticate': WWW_AUTHENTICATE_API_KEY },
  });

export const unauthorizedDocs = (): ApiError =>
  new ApiError('UNAUTHORIZED', 'the API documentation requires HTTP Basic authentication', {
    title: 'Missing or invalid documentation credentials',
    headers: { 'www-authenticate': WWW_AUTHENTICATE_DOCS },
  });

/** Rate-limit key: the authenticated client name, else the IP (unchanged behaviour without API keys). */
export function rateLimitKey(req: FastifyRequest): string {
  return req.apiClient !== undefined ? `client:${req.apiClient}` : req.ip;
}

/** The root onRequest hook (app.ts: `app.addHook('onRequest', createAuthHook(config, paths))`). */
export function createAuthHook(config: Config, paths: AuthPaths): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { apiKeys, docs } = authSettings(config);
  const digests = config.API_KEYS.map((e) => ({ name: e.name, digest: sha256(e.key) }));
  const docsUser = config.DOCS_USER ?? '';
  const docsPassword = config.DOCS_PASSWORD ?? '';
  const isDocs = (p: string) => p === paths.docsPath || p.startsWith(`${paths.docsPath}/`) || p === paths.openapiPath;
  const isApi = (p: string) => p === paths.apiPrefix || p.startsWith(`${paths.apiPrefix}/`);

  return async (req, reply) => {
    if (req.method === 'OPTIONS') return; // CORS preflight (@fastify/cors answers it), never carries credentials
    // Prefer the MATCHED route pattern (robust against encoded / doubled slashes); unmatched -> raw path.
    const route = req.routeOptions.url;
    const rawPath = req.url.split('?')[0] ?? req.url;
    const p = route ?? rawPath;

    if (isDocs(p) || (route === undefined && isDocs(rawPath))) {
      if (!docs) return;
      const c = basicCredentials(req);
      // Both comparisons always run (no short-circuit on the user name).
      const okUser = safeEqual(c?.user ?? '', docsUser);
      const okPassword = safeEqual(c?.password ?? '', docsPassword);
      if (c === undefined || !okUser || !okPassword) throw unauthorizedDocs();
      return;
    }

    if (!apiKeys || !isApi(p)) return;
    if (route === paths.healthPath) return; // GET/HEAD /api/v1/health: public liveness probe

    const client = matchKey(digests, presentedKey(req));
    if (client === undefined) throw unauthorizedApiKey();
    req.apiClient = client;
    req.log = req.log.child({ client });
    reply.log = req.log;
  };
}
