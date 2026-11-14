/**
 * Typed API client for the Lunar Landing Site Navigator backend (copy into the Next.js app).
 *
 *   npm i openapi-fetch@0.17.0 && npm i -D openapi-typescript@7.13.0
 *   npx openapi-typescript <path>/backend/contract/openapi.json -o src/lib/api/schema.d.ts --default-non-nullable false
 *   (--default-non-nullable false: request fields that have a server default stay OPTIONAL in the types)
 *
 * Paths in the spec already start with /api/v1, so `baseUrl` is an origin (or a proxy prefix):
 *   - browser: '/api/lunar' = the server-side proxy app/api/lunar/[...path]/route.ts, which adds the API key
 *     (or NEXT_PUBLIC_API_ORIGIN, only for a backend WITHOUT API keys, e.g. the Prism mock)
 *   - server (RSC / route handlers): an absolute origin is required -> API_INTERNAL_URL (default http://127.0.0.1:3000),
 *     and the API key comes from LUNARNAV_API_KEY (server env, never NEXT_PUBLIC_*: the browser must not see it)
 */
import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';

export type Schemas = components['schemas'];
export type Problem = Schemas['Problem'];
export type ProblemCode = Problem['code'];

const isServer = typeof window === 'undefined';

export const API_ORIGIN = isServer
  ? (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3000')
  : process.env.NEXT_PUBLIC_API_ORIGIN || '/api/lunar';

/** Server only: undefined in the browser bundle (not a NEXT_PUBLIC_ variable). */
const API_KEY = isServer ? process.env.LUNARNAV_API_KEY : undefined;

/** Error thrown by `unwrap()`: always carries a Problem (RFC 9457) with a stable `code`. */
export class ApiProblem extends Error {
  readonly problem: Problem;
  readonly status: number;
  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiProblem';
    this.problem = problem;
    this.status = problem.status;
  }
  get code(): ProblemCode {
    return this.problem.code;
  }
}

function isProblem(x: unknown): x is Problem {
  return typeof x === 'object' && x !== null && 'code' in x && 'status' in x && 'title' in x;
}

/** Non-problem error bodies (proxy HTML page, network error...) -> a Problem-shaped object. */
function toProblem(error: unknown, response: Response | undefined): Problem {
  if (isProblem(error)) return error;
  const status = response?.status ?? 503;
  return {
    type: 'about:blank',
    title: response ? `HTTP ${status}` : 'Network error',
    status: status >= 400 && status <= 599 ? status : 500,
    code: status === 429 ? 'RATE_LIMITED' : status === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL',
    detail: typeof error === 'string' ? error.slice(0, 300) : undefined,
  };
}

interface FetchResultLike {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/** `await unwrap(api.GET(...))` -> data, or throws ApiProblem (TanStack Query puts it in `error`). */
export async function unwrap<R extends FetchResultLike>(request: Promise<R>): Promise<NonNullable<R['data']>> {
  let result: R;
  try {
    result = await request;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiProblem(toProblem(e instanceof Error ? e.message : e, undefined));
  }
  if (result.error !== undefined || !result.response.ok) throw new ApiProblem(toProblem(result.error, result.response));
  return result.data as NonNullable<R['data']>;
}

/** Dev helper: warn once per path when the backend still answers with day-1 stub data. */
const warnedStub = new Set<string>();
const stubWarning: Middleware = {
  onResponse({ response }) {
    if (process.env.NODE_ENV !== 'production' && response.headers.get('x-lunarnav-stub') === '1') {
      const p = new URL(response.url, 'http://x').pathname;
      if (!warnedStub.has(p)) {
        warnedStub.add(p);
        console.info(`[api] ${p}: stub data (x-lunarnav-stub: 1)`);
      }
    }
    return undefined;
  },
};

export function createApi(origin: string = API_ORIGIN) {
  const client = createClient<paths>({ baseUrl: origin, ...(API_KEY ? { headers: { 'x-api-key': API_KEY } } : {}) });
  client.use(stubWarning);
  return client;
}

/** Shared client. Path params are URL-encoded by openapi-fetch (site ids like custom:-89.4500:222.6900 are safe). */
export const api = createApi();

/** Comma separated query lists (`fields`, `kinds`): csv(['sun', 'earth']) -> 'sun,earth'. */
export const csv = (items: readonly string[]): string => items.join(',');

/**
 * Ranking weights query: weightsParam({ pct_sun: 0.5, pct_both: 0.5 }) -> 'pct_sun:0.5,pct_both:0.5'.
 * Plain decimals with at most 6 places (String(1e-7) would be '1e-7'); weights that round to 0 are
 * dropped. The API wants each metric at most once and at least one weight > 0 (else 400).
 */
export const weightsParam = (w: Partial<Record<'pct_sun' | 'pct_earth' | 'pct_both' | 'pct_sun_no_earth', number>>): string =>
  Object.entries(w)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
    .map(([k, v]) => [k, v.toFixed(6).replace(/\.?0+$/, '')] as const)
    .filter(([, v]) => v !== '0' && v !== '-0')
    .map(([k, v]) => `${k}:${v}`)
    .join(',');

/** Absolute URL for downloads (<a href download>): CSV exports and raw run files. */
export function downloadUrl(path: string, query?: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, v);
  const q = qs.toString();
  return `${API_ORIGIN}${path}${q ? `?${q}` : ''}`;
}
