/**
 * Runtime configuration: environment variables parsed and validated once with zod.
 * `loadConfig()` reads process.env (Node's --env-file-if-exists=.env loads .env in dev/start);
 * tests call `loadConfig({...})` / `buildApp({ config: {...} })` with explicit overrides.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** backend/ directory (works from src/ and from dist/src/). */
const BACKEND_ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const parts = here.split(path.sep);
  const i = parts.lastIndexOf('src');
  const base = i > 0 ? parts.slice(0, i).join(path.sep) : here;
  return base.endsWith(`${path.sep}dist`) ? path.dirname(base) : base;
})();

const defaultPythonBin =
  process.platform === 'win32'
    ? path.join(BACKEND_ROOT, '..', '.venv', 'Scripts', 'python.exe')
    : path.join(BACKEND_ROOT, '..', '.venv', 'bin', 'python');

const boolFromEnv = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');

const csvList = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0),
  );

/** Minimum length of an API key (`openssl rand -hex 32` = 64 chars) and of DOCS_PASSWORD (enforced in production). */
export const API_KEY_MIN_LENGTH = 32;
export const DOCS_PASSWORD_MIN_LENGTH = 12;

export interface ApiKeyEntry {
  /** Client name used in logs and as the rate-limit key (`fe`, `tester`, or `key1`, `key2`... for unnamed keys). */
  name: string;
  key: string;
}

const API_KEY_NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const API_KEY_CHARS = /^[!-~]+$/; // visible ASCII, no spaces (an HTTP header value)

/** `API_KEYS=fe:<key>,tester:<key>` or plain `<key>,<key>` (named key1, key2, ...). */
const apiKeyList = z.string().transform((s, ctx): ApiKeyEntry[] => {
  const out: ApiKeyEntry[] = [];
  const entries = s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  entries.forEach((entry, i) => {
    const colon = entry.indexOf(':');
    const name = colon > 0 ? entry.slice(0, colon) : `key${i + 1}`;
    const key = colon > 0 ? entry.slice(colon + 1) : entry;
    // Never echo the key itself in an error message.
    if (colon > 0 && !API_KEY_NAME.test(name)) {
      ctx.addIssue({ code: 'custom', message: `entry ${i + 1}: client name must match ${API_KEY_NAME.source}` });
    } else if (colon === 0) {
      ctx.addIssue({ code: 'custom', message: `entry ${i + 1}: empty client name before ':'` });
    } else if (!API_KEY_CHARS.test(key)) {
      ctx.addIssue({ code: 'custom', message: `entry ${i + 1} (${name}): key must be non-empty visible ASCII without spaces` });
    } else if (out.some((e) => e.name === name)) {
      ctx.addIssue({ code: 'custom', message: `entry ${i + 1}: duplicate client name ${JSON.stringify(name)}` });
    } else if (out.some((e) => e.key === key)) {
      ctx.addIssue({ code: 'custom', message: `entry ${i + 1} (${name}): same key as another client` });
    } else {
      out.push({ name, key });
    }
  });
  return out;
});

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// URI').default('mongodb://127.0.0.1:27017'),
  MONGODB_DB: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/).default('lunarnav_dev'),

  CORS_ORIGINS: csvList.default(['http://localhost:3000', 'http://127.0.0.1:3000']),

  PYTHON_BIN: z.string().min(1).default(defaultPythonBin),
  LUNARNAV_ROOT: z.string().min(1).default(path.resolve(BACKEND_ROOT, '..')),
  DATA_DIR: z.string().min(1).default(path.join(BACKEND_ROOT, 'data')),

  JOB_TIMEOUT_S: z.coerce.number().int().positive().default(1200),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  JOB_QUEUE_MAX: z.coerce.number().int().min(1).default(20),
  /** Queued + running jobs one client (IP, IPv6 /64) may wait on; 0 = no per-client limit. */
  JOB_MAX_ACTIVE_PER_CLIENT: z.coerce.number().int().min(0).default(2),
  /** Concurrent GET /jobs/{id}/events streams per client. */
  SSE_MAX_PER_CLIENT: z.coerce.number().int().min(1).default(5),
  ALTDATES_TIMEOUT_S: z.coerce.number().int().positive().default(30),
  CUSTOM_RUN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Lifetime of the run a `precompute` job imports (API-created, possibly large: shorter than CUSTOM_RUN_TTL_DAYS). */
  PRECOMPUTE_RUN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  /**
   * Storage budget of the runs jobs import (custom_site, precompute), checked when a NEW job is queued:
   * live job runs (active + succeeded, not expired) per creating client / per server, their total size on
   * disk (MB, measured when each job finishes) and the free space of DATA_DIR. 0 = no limit.
   */
  JOB_RUNS_MAX_PER_CLIENT: z.coerce.number().int().min(0).default(20),
  JOB_RUNS_MAX_TOTAL: z.coerce.number().int().min(0).default(200),
  JOB_RUNS_MAX_MB: z.coerce.number().int().min(0).default(10_240),
  DATA_DIR_MIN_FREE_MB: z.coerce.number().int().min(0).default(2048),
  /**
   * PGDA tile cache (LUNARNAV_DATA/cache/pgda) written by lunarnav when a job / tool reads PGDA blocks not yet
   * cached: new bytes per UTC day (beyond it, new dem pgda work answers 429 QUOTA_EXCEEDED until midnight UTC)
   * and the size the cache is trimmed to (oldest blocks first) after each PGDA job / tool call. 0 = no limit.
   */
  PGDA_DOWNLOAD_MAX_MB_PER_DAY: z.coerce.number().int().min(0).default(1024),
  PGDA_CACHE_MAX_MB: z.coerce.number().int().min(0).default(4096),
  /** GET /capabilities: probe network reachability of JPL Horizons / PGDA (default: on, except NODE_ENV=test). */
  CAPABILITIES_NETWORK_PROBE: boolFromEnv.optional(),
  /** GET /capabilities: how long a probe result is served from cache. */
  CAPABILITIES_TTL_S: z.coerce.number().int().min(0).default(600),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_POST_MAX: z.coerce.number().int().positive().default(5),
  /** POST /tools/* (sync Python; also bounded by a small concurrency queue): requests per minute per IP and tool. */
  RATE_LIMIT_TOOLS_MAX: z.coerce.number().int().positive().default(30),

  COMPRESS: boolFromEnv.default(true),

  /**
   * API keys accepted on /api/v1/* (except GET /health), sent as `X-API-Key: <key>` or `Authorization: Bearer <key>`.
   * Comma separated, optionally `name:key` (`fe:<64 hex>,tester:<64 hex>`). Generate keys with `openssl rand -hex 32`.
   * Empty: required in production (startup fails); elsewhere authentication is OFF (one warning at startup).
   */
  API_KEYS: apiKeyList.default([]),
  /** HTTP Basic credentials of /docs and /api/v1/openapi.json. Required in production; unset elsewhere = docs open. */
  DOCS_USER: z.string().regex(/^[^:\s]{1,64}$/, 'must be 1-64 chars without ":" or spaces').optional(),
  DOCS_PASSWORD: z.string().max(256).optional(),
});

export type Config = z.output<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parse env-like input (defaults: process.env). Empty strings count as "unset". */
export function loadConfig(input: Record<string, unknown> = process.env): Config {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== '') cleaned[k] = v;
  }
  const r = ConfigSchema.safeParse(cleaned);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const problems = authConfigProblems(r.data);
  if (problems.length > 0) throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  return Object.freeze(r.data);
}

/** Authentication rules that depend on NODE_ENV (production: API keys and docs credentials are mandatory). */
function authConfigProblems(c: z.output<typeof ConfigSchema>): string[] {
  const out: string[] = [];
  const prod = c.NODE_ENV === 'production';
  if (prod && c.API_KEYS.length === 0) {
    out.push('API_KEYS: required when NODE_ENV=production (comma separated, e.g. fe:<key>,tester:<key>; generate each key with `openssl rand -hex 32`)');
  }
  if (prod) {
    for (const e of c.API_KEYS) {
      if (e.key.length < API_KEY_MIN_LENGTH) {
        out.push(`API_KEYS: key of client ${JSON.stringify(e.name)} is shorter than ${API_KEY_MIN_LENGTH} chars (use \`openssl rand -hex 32\`)`);
      }
    }
  }
  if ((c.DOCS_USER === undefined) !== (c.DOCS_PASSWORD === undefined)) {
    out.push('DOCS_USER / DOCS_PASSWORD: set both (HTTP Basic auth of /docs) or neither');
  } else if (prod && c.DOCS_USER === undefined) {
    out.push('DOCS_USER / DOCS_PASSWORD: required when NODE_ENV=production (HTTP Basic auth of /docs and /api/v1/openapi.json)');
  }
  if (prod && c.DOCS_PASSWORD !== undefined && c.DOCS_PASSWORD.length < DOCS_PASSWORD_MIN_LENGTH) {
    out.push(`DOCS_PASSWORD: must be at least ${DOCS_PASSWORD_MIN_LENGTH} chars in production`);
  }
  return out;
}

export { BACKEND_ROOT };
