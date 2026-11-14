/**
 * Runtime smoke test of the starter (run by verify.sh, not copied into the FE app):
 * canned responses = the REAL captured examples in backend/contract/examples/.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseView, serializeView } from './src/lib/url-state.ts';

const example = (name: string): string => readFileSync(new URL(`./examples/${name}`, import.meta.url), 'utf8');
const seen: string[] = [];

globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  seen.push(url.pathname + url.search);
  const json = (body: string, status: number, type = 'application/json') => new Response(body, { status, headers: { 'content-type': type } });
  if (url.pathname === '/api/v1/sites/ref_connecting_ridge_c1') return json(example('site_detail.json'), 200);
  if (url.pathname.startsWith('/api/v1/sites/custom')) return json(example('error_site_not_found.json'), 404, 'application/problem+json');
  if (url.pathname.endsWith('/windows')) return json(example('windows_march_sun_earth.json'), 200);
  return new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
};

// Import after the fetch stub: openapi-fetch captures globalThis.fetch when the client is created.
const { createApi, unwrap, ApiProblem, csv } = await import('./src/lib/api/client.ts');
const api = createApi('http://127.0.0.1:3000');

const card = await unwrap(api.GET('/api/v1/sites/{site_id}', { params: { path: { site_id: 'ref_connecting_ridge_c1' } } }));
assert.equal(card.site.id, 'ref_connecting_ridge_c1');
assert.equal(card.precision_h, 1);

const w = await unwrap(
  api.GET('/api/v1/sites/{site_id}/windows', {
    params: { path: { site_id: 'ref_connecting_ridge_c1' }, query: { start: '2026-03-01T00:00:00Z', kinds: csv(['sun', 'earth']) } },
  }),
);
assert.ok(Array.isArray(w.sun) && w.sun.length > 0);
assert.match(seen.at(-1) ?? '', /kinds=sun(%2C|,)earth/);

// Site ids with ':' are URL-encoded in the path by openapi-fetch.
await assert.rejects(
  unwrap(api.GET('/api/v1/sites/{site_id}', { params: { path: { site_id: 'custom:-89.4500:222.6900' } } })),
  (e: unknown) => e instanceof ApiProblem && e.code === 'SITE_NOT_FOUND' && e.status === 404,
);
assert.ok(seen.includes('/api/v1/sites/custom%3A-89.4500%3A222.6900'), `encoded path, saw ${seen.join(' ')}`);

// Non-problem error body (e.g. proxy HTML) still becomes an ApiProblem.
await assert.rejects(unwrap(api.GET('/api/v1/meta')), (e: unknown) => e instanceof ApiProblem && e.status === 502 && e.code === 'INTERNAL');

// URL state round trip; invalid values dropped.
const qs = serializeView({ site: 'custom:-89.4500:222.6900', start: '2026-03-01T00:00:00Z', kinds: ['sun', 'earth'], cmp: ['apollo11'] });
assert.equal(qs, 'site=custom:-89.4500:222.6900&start=2026-03-01T00:00:00Z&kinds=sun,earth&cmp=apollo11');
assert.deepEqual(parseView(new URLSearchParams(qs)), { site: 'custom:-89.4500:222.6900', start: '2026-03-01T00:00:00Z', kinds: ['sun', 'earth'], cmp: ['apollo11'] });
assert.deepEqual(parseView(new URLSearchParams('site=bad id&t=yesterday&kinds=sun,moon')), { kinds: ['sun'] });

console.log(`runtime checks OK (${seen.length} requests)`);
