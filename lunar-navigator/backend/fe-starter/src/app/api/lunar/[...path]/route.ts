/**
 * app/api/lunar/[...path]/route.ts - server-side proxy to the lunarnav API (copy into the Next.js app).
 *
 * The browser calls  /api/lunar/api/v1/...  (same origin, no key); this handler forwards method, query and
 * body to  ${API_INTERNAL_URL}/api/v1/...  and adds  X-API-Key  from the SERVER env (LUNARNAV_API_KEY,
 * never NEXT_PUBLIC_*), then streams the response back with its status and headers (SSE included).
 * Only /api/v1/* is forwarded (not /docs), so the proxy cannot be used to reach anything else.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PREFIX = '/api/lunar';
const API_ORIGIN = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3000';
const API_KEY = process.env.LUNARNAV_API_KEY ?? '';

/** Request headers passed to the backend (no cookies, no browser Authorization). */
const REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'if-modified-since', 'last-event-id', 'prefer'];
/** Response headers passed back (content-encoding / content-length are dropped: fetch() already decoded the body). */
const RESPONSE_HEADERS = [
  'content-type', 'cache-control', 'etag', 'last-modified', 'content-disposition', 'location', 'retry-after',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-lunarnav-cache', 'x-lunarnav-stub', 'vary',
];

const problem = (status: number, code: string, title: string, detail: string): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title, status, code, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.slice(PREFIX.length); // keeps the percent-encoding (site ids with ':', file paths with %2F)
  if (!path.startsWith('/api/v1/')) return problem(404, 'NOT_FOUND', 'Route not found', `no route ${req.method} ${url.pathname}`);
  if (!API_KEY && process.env.NODE_ENV === 'production') {
    return problem(500, 'INTERNAL', 'Internal server error', 'LUNARNAV_API_KEY is not set on the Next.js server');
  }

  const headers = new Headers();
  for (const h of REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  if (API_KEY) headers.set('x-api-key', API_KEY);

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(`${API_ORIGIN}${path}${url.search}`, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined, // API bodies are small JSON (<= 1 MiB)
      cache: 'no-store',
      redirect: 'manual',
      signal: req.signal, // browser closed the page / EventSource -> close the upstream stream too
    });
  } catch (e) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return problem(502, 'SERVICE_UNAVAILABLE', 'Service unavailable', `backend not reachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const out = new Headers();
  for (const h of RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v !== null) out.set(h, v);
  }
  if (upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
    out.set('cache-control', 'no-cache, no-transform'); // no compression / buffering of SSE
    out.set('x-accel-buffering', 'no'); // nginx in front of Next.js: do not buffer the stream
  }
  // Body streamed through as-is (null for 204 / 304 / HEAD).
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export { proxy as GET, proxy as POST, proxy as DELETE, proxy as HEAD };
