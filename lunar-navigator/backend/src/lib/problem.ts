/**
 * RFC 9457 "problem details" errors (application/problem+json) - the ONE error shape of the API.
 *
 * - Throw `new ApiError(status, code, detail, extras)` (or a helper below) anywhere in a handler.
 * - The app error handler (app.ts) turns ApiError, zod validation errors, rate-limit errors and
 *   unexpected errors into a `Problem` body via `toProblem*()`.
 * - Route schemas list their error responses with `problemResponses(400, 404, ...)` so every 4xx/5xx
 *   appears in openapi.json (FE types) with the shared `Problem` component.
 */
import { z } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
/**
 * Base of the RFC 9457 `type` URI. `.example` is a reserved, never-resolving TLD (RFC 2606): the `type` is a
 * stable identifier only, not a documentation link (clients should branch on `code`). Kept as-is because the
 * deployed API (api.lunavigator.com) and the frontend fixtures already use it.
 */
export const PROBLEM_TYPE_BASE = 'https://lunarnav.example/errors/';

/** Every machine-readable error code (plan section 6.4) -> HTTP status + human title. */
export const PROBLEM_CODES = {
  VALIDATION_ERROR: { status: 400, title: 'Invalid request' },
  TOO_MANY_POINTS: { status: 400, title: 'Too many points or fields requested' },
  UNAUTHORIZED: { status: 401, title: 'Missing or invalid API key' },
  NOT_FOUND: { status: 404, title: 'Route not found' },
  SITE_NOT_FOUND: { status: 404, title: 'Site not found' },
  RUN_NOT_FOUND: { status: 404, title: 'Run not found' },
  JOB_NOT_FOUND: { status: 404, title: 'Job not found' },
  JOB_NOT_YOURS: { status: 403, title: 'Job was not submitted from this client' },
  FILE_NOT_FOUND: { status: 404, title: 'File not found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  RUN_NOT_READY: { status: 409, title: 'Run is not ready (still importing or failed)' },
  JOB_NOT_CANCELLABLE: { status: 409, title: 'Job already finished' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Request body too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  OUT_OF_RANGE: { status: 422, title: 'Range outside run' },
  BAD_MISSION_LENGTH: { status: 422, title: 'Mission length is not a whole number of steps' },
  CAPABILITY_UNAVAILABLE: { status: 422, title: 'Option not available on this server (see GET /api/v1/capabilities)' },
  JOB_TOO_LARGE: { status: 422, title: 'Job exceeds the size limits of its type' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  QUEUE_FULL: { status: 429, title: 'Job queue is full' },
  TOO_MANY_JOBS: { status: 429, title: 'Too many active jobs from this client' },
  TOO_MANY_STREAMS: { status: 429, title: 'Too many open event streams from this client' },
  QUOTA_EXCEEDED: { status: 429, title: 'Storage / download quota reached' },
  INTERNAL: { status: 500, title: 'Internal server error' },
  JOB_TYPE_UNAVAILABLE: { status: 501, title: 'Job type not available on this server' },
  PYTHON_FAILED: { status: 502, title: 'Python computation failed' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable (database not connected)' },
  STORAGE_FULL: { status: 503, title: 'Server storage budget for job runs is used up' },
  PYTHON_TIMEOUT: { status: 504, title: 'Python computation timed out' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ProblemCode = keyof typeof PROBLEM_CODES;
export const PROBLEM_CODE_LIST = Object.keys(PROBLEM_CODES) as [ProblemCode, ...ProblemCode[]];

export const ProblemFieldError = z
  .object({
    path: z.string().describe('Dotted path of the offending field ("" = whole object), e.g. "end" or "site_ids.2"'),
    in: z.enum(['querystring', 'params', 'body', 'headers']).optional().describe('Where the field was sent'),
    message: z.string(),
    code: z.string().optional().describe('zod issue code, e.g. "too_big", "invalid_type"'),
  })
  .meta({ id: 'ProblemFieldError' });

export const Problem = z
  .looseObject({
    type: z.string().describe('URI identifying the problem type'),
    title: z.string().describe('Short human-readable summary of the problem type'),
    status: z.int().min(400).max(599).describe('HTTP status code (same as the response status)'),
    code: z.enum(PROBLEM_CODE_LIST).describe('Stable machine-readable error code - switch on this in the FE'),
    detail: z.string().optional().describe('Human-readable explanation of this occurrence'),
    instance: z.string().optional().describe('Request path that produced the problem'),
    errors: z.array(ProblemFieldError).optional().describe('Per-field details (validation errors)'),
    hint: z.string().optional().describe('How to fix the request, when known'),
  })
  .describe('RFC 9457 problem details. Extra members (e.g. `max_latest`, `limits`) may be present.')
  .meta({
    id: 'Problem',
    examples: [
      {
        type: `${PROBLEM_TYPE_BASE}out-of-range`,
        title: 'Range outside run',
        status: 422,
        code: 'OUT_OF_RANGE',
        detail: 'end 2032-01-01T00:00:00Z > run end 2026-04-01T00:00:00Z',
        instance: '/api/v1/sites/apollo11/series',
        errors: [{ path: 'end', in: 'querystring', message: 'must be <= 2026-04-01T00:00:00Z' }],
      },
    ],
  });

export type Problem = z.output<typeof Problem>;
export type ProblemFieldError = z.output<typeof ProblemFieldError>;

export interface ApiErrorExtras {
  /** Overrides the code's default title for this occurrence (the `code` stays the same, so FE switches keep working). */
  title?: string;
  errors?: ProblemFieldError[];
  hint?: string;
  /** Extension members merged into the problem body (snake_case keys). */
  extensions?: Record<string, unknown>;
  headers?: Record<string, string>;
  cause?: unknown;
}

/** Throw this from handlers; the app error handler renders it as problem+json. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly statusCode: number;
  readonly code: ProblemCode;
  readonly extras: ApiErrorExtras;

  constructor(code: ProblemCode, detail?: string, extras: ApiErrorExtras = {}) {
    super(detail ?? PROBLEM_CODES[code].title, extras.cause === undefined ? undefined : { cause: extras.cause });
    this.code = code;
    this.statusCode = PROBLEM_CODES[code].status;
    this.extras = extras;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

const slug = (code: ProblemCode): string => code.toLowerCase().replaceAll('_', '-');

export function problemBody(code: ProblemCode, instance: string, detail?: string, extras: ApiErrorExtras = {}): Problem {
  const def = PROBLEM_CODES[code];
  const body: Problem = {
    ...(extras.extensions ?? {}),
    type: `${PROBLEM_TYPE_BASE}${slug(code)}`,
    title: extras.title ?? def.title,
    status: def.status,
    code,
    instance,
  };
  if (detail !== undefined) body.detail = detail;
  if (extras.errors && extras.errors.length > 0) body.errors = extras.errors;
  if (extras.hint !== undefined) body.hint = extras.hint;
  return body;
}

// ---- helpers for the common cases --------------------------------------------------------------
export const siteNotFound = (siteId: string): ApiError =>
  new ApiError('SITE_NOT_FOUND', `site ${JSON.stringify(siteId)} is not in this run`, {
    hint: 'GET /api/v1/sites lists the site ids of a run; encodeURIComponent() ids that contain ":"',
  });
/** A job / tool request names a site id that is neither in the lunarnav catalog nor a canonical custom id. */
export const catalogSiteNotFound = (siteId: string): ApiError =>
  new ApiError('SITE_NOT_FOUND', `site ${JSON.stringify(siteId)} is not in the lunarnav site catalog`, {
    hint: 'use a catalog id (GET /api/v1/sites), a group:<name> selector, or lat_deg + lon_deg for a custom site',
  });
export const runNotFound = (runId: string): ApiError =>
  new ApiError('RUN_NOT_FOUND', `run ${JSON.stringify(runId)} does not exist`, { hint: 'GET /api/v1/runs lists runs' });
export const jobNotFound = (jobId: string): ApiError =>
  new ApiError('JOB_NOT_FOUND', `job ${JSON.stringify(jobId)} does not exist (or expired)`);

// ---- zod validation issues -> problem ------------------------------------------------------------
export interface ValidationIssueLike {
  instancePath: string;
  message?: string | undefined;
  keyword: string;
}

/**
 * Fields whose `too_big` errors are reported as TOO_MANY_POINTS (plan 6.4): the series / sky / csv
 * querystrings AND the embedded series of POST /compare, so one FE handler covers every endpoint.
 */
const TOO_MANY_POINTS_PATHS = new Set(['max_points', 'fields', 'include.series.max_points', 'include.series.fields']);

export function validationProblem(
  issues: readonly ValidationIssueLike[],
  context: string | undefined,
  instance: string,
): Problem {
  const where = (['querystring', 'params', 'body', 'headers'] as const).find((c) => c === context);
  const errors: ProblemFieldError[] = issues.map((i) => {
    const e: ProblemFieldError = {
      path: i.instancePath.replace(/^\//, '').replaceAll('/', '.'),
      message: i.message ?? 'invalid value',
      code: i.keyword,
    };
    if (where) e.in = where;
    return e;
  });
  const tooMany =
    errors.length > 0 &&
    errors.every((e) => e.code === 'too_big' && TOO_MANY_POINTS_PATHS.has(e.path));
  const code: ProblemCode = tooMany ? 'TOO_MANY_POINTS' : 'VALIDATION_ERROR';
  const summary = errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
  const extras: ApiErrorExtras = { errors };
  if (tooMany) extras.hint = 'Use max_points <= 5000 and at most 8 fields (see GET /api/v1/meta limits)';
  return problemBody(code, instance, `${where ?? 'request'} validation failed: ${summary}`, extras);
}

// ---- OpenAPI response entries -----------------------------------------------------------------
const PROBLEM_DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid request (VALIDATION_ERROR, TOO_MANY_POINTS)',
  401: 'Unauthorized (UNAUTHORIZED: missing or invalid API key; send X-API-Key: <key> or Authorization: Bearer <key>)',
  403: 'Forbidden (JOB_NOT_YOURS: only a client that submitted the job may cancel it)',
  404: 'Not found (SITE_NOT_FOUND, RUN_NOT_FOUND, JOB_NOT_FOUND, FILE_NOT_FOUND, NOT_FOUND = no such route or method)',
  409: 'Conflict (RUN_NOT_READY, JOB_NOT_CANCELLABLE)',
  413: 'Request body too large',
  415: 'Unsupported media type (UNSUPPORTED_MEDIA_TYPE): send Content-Type: application/json',
  422: 'Semantically invalid (OUT_OF_RANGE, BAD_MISSION_LENGTH, CAPABILITY_UNAVAILABLE, JOB_TOO_LARGE)',
  429: 'Rate limited (RATE_LIMITED, QUEUE_FULL, TOO_MANY_JOBS, TOO_MANY_STREAMS, QUOTA_EXCEEDED)',
  500: 'Internal error (INTERNAL)',
  501: 'Not implemented on this server (JOB_TYPE_UNAVAILABLE: see GET /api/v1/capabilities)',
  502: 'Python failed (PYTHON_FAILED)',
  503: 'Unavailable (SERVICE_UNAVAILABLE: database not connected / shutting down; STORAGE_FULL: job-run storage budget used up)',
  504: 'Python timed out (PYTHON_TIMEOUT)',
};

/** Description of the 401 response that lib/openapi.ts adds to every protected operation. */
export const PROBLEM_DESCRIPTION_401 = PROBLEM_DESCRIPTIONS[401] ?? 'Unauthorized';

export type ProblemStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 501 | 502 | 503 | 504;

export interface ProblemResponse {
  description: string;
  content: { [PROBLEM_CONTENT_TYPE]: { schema: typeof Problem } };
}

/** `response: { 200: X, ...problemResponses(400, 404) }` - 429 and 500 are always added. */
export function problemResponses<S extends ProblemStatus>(...statuses: S[]): Record<S | 429 | 500, ProblemResponse> {
  const out = {} as Record<S | 429 | 500, ProblemResponse>;
  for (const s of [...statuses, 429 as const, 500 as const]) {
    out[s] = {
      description: PROBLEM_DESCRIPTIONS[s] ?? 'Error',
      content: { [PROBLEM_CONTENT_TYPE]: { schema: Problem } },
    };
  }
  return out;
}
