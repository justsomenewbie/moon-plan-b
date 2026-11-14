/**
 * Regression tests for the Python-integration review (sync tools, capabilities, OpenAPI contract), with the
 * FAKE lunarnav of the tool tests (tests/jobs/fake_b4: latitude -12 sleeps 60 s, -16 = PGDA offline):
 *   - a client that disconnects leaves the tools queue / has its Python killed; the time budget covers the
 *     queue wait (429 QUEUE_FULL instead of waiting behind abandoned work); per-client cap (429 TOO_MANY_JOBS)
 *   - PGDA offline: dems.pgda unavailable even with cached tiles; bridge 'cannot open PGDA product' -> 422
 *   - lat/lon rounded to the canonical custom site (= the run a precompute job would make)
 *   - horizon_mask: numeric near_exclusion_m with bruteforce -> 400
 *   - OpenAPI: POST /jobs documents 409; JSON artifacts are not typed as strings
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { EphemerisResponse, HorizonToolResponse, TOOLS_LIMITS } from '../src/contract/tools.ts';
import { Problem } from '../src/lib/problem.ts';
import { probeCapabilities, resetCapabilitiesCache } from '../src/python/capabilities.ts';
import { startTestApp, type TestContext } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ROOT = path.join(here, 'jobs', 'fake_b4');
const PY = loadConfig({}).PYTHON_BIN;
const HAVE_PY = existsSync(PY);
const API = '/api/v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = ['2026-01-01T00:00:00Z'];

describe.skipIf(!HAVE_PY)('tools / capabilities / contract review fixes (fake lunarnav)', () => {
  let ctx: TestContext;
  let base = '';
  let dataRoot: string;
  const prevData = process.env['LUNARNAV_DATA'];

  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-tools-review-'));
    process.env['LUNARNAV_DATA'] = dataRoot;
    resetCapabilitiesCache();
    // budgets: ephemeris 3 s, horizon 6 s (ALTDATES_TIMEOUT_S x factor)
    ctx = await startTestApp({ config: { LUNARNAV_ROOT: FAKE_ROOT, RATE_LIMIT_POST_MAX: 10_000, RATE_LIMIT_TOOLS_MAX: 10_000, ALTDATES_TIMEOUT_S: 3 } });
    base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await ctx?.close();
    if (prevData === undefined) delete process.env['LUNARNAV_DATA'];
    else process.env['LUNARNAV_DATA'] = prevData;
    resetCapabilitiesCache();
    await rm(dataRoot, { recursive: true, force: true });
  });

  const inject = (tool: 'ephemeris' | 'horizon', payload: unknown, remoteAddress = '127.0.0.1') =>
    ctx.app.inject({ method: 'POST', url: `${API}/tools/${tool}`, payload: payload as object, remoteAddress });
  /** A real HTTP request the test can abort (the server sees the socket close). */
  const fetchTool = (tool: 'ephemeris' | 'horizon', payload: unknown, ac: AbortController) =>
    fetch(`${base}${API}/tools/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: ac.signal }).catch(() => null);
  const quick = { lat_deg: -85.5, lon_deg: 10, times: T, surface_height: 'sphere' };
  const slowHorizon = (lon: number) => ({ lat_deg: -12, lon_deg: lon, dem: 'none' });

  it('a disconnected client frees its slot: later requests do not wait behind abandoned computations', async () => {
    const acs = [new AbortController(), new AbortController()];
    const pending = acs.map((ac, i) => fetchTool('horizon', slowHorizon(i + 1), ac));
    await sleep(500); // both are running now (2 slots)
    // the same client (127.0.0.1) already has 2 tool requests in flight
    const third = await inject('ephemeris', quick);
    expect(third.statusCode, third.body).toBe(429);
    expect(Problem.parse(third.json())).toMatchObject({ code: 'TOO_MANY_JOBS', max_pending_per_client: TOOLS_LIMITS.max_pending_per_client });
    for (const ac of acs) ac.abort();
    await Promise.all(pending);
    await sleep(1500); // process trees killed
    const t0 = Date.now();
    const ok = await inject('ephemeris', quick);
    expect(ok.statusCode, ok.body).toBe(200);
    EphemerisResponse.parse(ok.json());
    // without the abort both slots would stay busy until the 6 s horizon budget ran out
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('the time budget covers the queue wait: a request that gets no slot in time -> 429 QUEUE_FULL (not a longer wait)', async () => {
    const hogs = [inject('horizon', slowHorizon(11), '10.7.0.1'), inject('horizon', slowHorizon(12), '10.7.0.2')];
    await sleep(300);
    const t0 = Date.now();
    const waited = await inject('ephemeris', quick, '10.7.0.3'); // ephemeris budget 3 s < the hogs' 6 s
    const ms = Date.now() - t0;
    expect(waited.statusCode, waited.body).toBe(429);
    expect(Problem.parse(waited.json()).code).toBe('QUEUE_FULL');
    expect(ms).toBeGreaterThan(2500);
    expect(ms).toBeLessThan(5000);
    const done = await Promise.all(hogs);
    expect(done.map((r) => r.statusCode)).toEqual([504, 504]);
  });

  it('PGDA offline (lunarnav cannot open the product): horizon / ephemeris dem -> 422 CAPABILITY_UNAVAILABLE, not 502', async () => {
    const h = await inject('horizon', { lat_deg: -16, lon_deg: 5, dem: 'pgda' });
    expect(h.statusCode, h.body).toBe(422);
    expect(Problem.parse(h.json()).code).toBe('CAPABILITY_UNAVAILABLE');
    const e = await inject('ephemeris', { lat_deg: -16, lon_deg: 5, times: T, surface_height: 'dem' });
    expect(e.statusCode, e.body).toBe(422);
    expect(Problem.parse(e.json()).detail).toContain('PGDA is not reachable');
  });

  it('capabilities: dems.pgda unavailable when PGDA is unreachable, even with cached tiles', async () => {
    await mkdir(path.join(dataRoot, 'cache', 'pgda', 'LDEM_80S_20MPP_ADJ'), { recursive: true });
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const c = await probeCapabilities({ ...ctx.app.config, CAPABILITIES_NETWORK_PROBE: true });
      expect(c.network.pgda.reachable).toBe(false);
      expect(c.dems.pgda.cached_products).toBe(1);
      expect(c.dems.pgda.available).toBe(false);
      if (c.modules['rasterio'] === true) expect(c.dems.pgda.reason).toMatch(/PGDA not reachable \(ENOTFOUND\).*even when its tiles are cached/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lat/lon are rounded to the canonical custom site: same values as its custom id (what precompute computes)', async () => {
    const raw = await inject('ephemeris', { lat_deg: -85.12345, lon_deg: 30.00004, times: T, surface_height: 'sphere', rounding: 'none' });
    expect(raw.statusCode, raw.body).toBe(200);
    const a = EphemerisResponse.parse(raw.json());
    expect(a.site.custom_site_id).toBe('custom:-85.1235:30.0000');
    expect([a.site.lat_deg, a.site.lon_deg]).toEqual([-85.1235, 30]);
    const b = EphemerisResponse.parse((await inject('ephemeris', { site_id: 'custom:-85.1235:30.0000', times: T, surface_height: 'sphere', rounding: 'none' })).json());
    expect(a.rows).toEqual(b.rows);
    const hz = HorizonToolResponse.parse((await inject('horizon', { lat_deg: -85.12345, lon_deg: 30.00004, dem: 'none' })).json());
    expect([hz.site.lat_deg, hz.site.lon_deg]).toEqual([-85.1235, 30]);
  });

  it('horizon_mask: numeric near_exclusion_m with method bruteforce -> 400 (lunarnav rejects it)', async () => {
    const r = await ctx.app.inject({
      method: 'POST',
      url: `${API}/jobs`,
      payload: { type: 'horizon_mask', lat_deg: -85, lon_deg: 10, dem: 'pgda', method: 'bruteforce', near_exclusion_m: 50 },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(Problem.parse(r.json())).toMatchObject({ code: 'VALIDATION_ERROR', errors: [{ path: 'near_exclusion_m' }] });
  });

  it('OpenAPI: POST /jobs documents 409; JSON artifacts are documents, the other media types strings', () => {
    const spec = ctx.app.swagger() as unknown as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: { type?: string } }> }> }>> };
    expect(Object.keys(spec.paths['/api/v1/jobs']?.['post']?.responses ?? {})).toContain('409');
    const content = spec.paths['/api/v1/jobs/{job_id}/artifacts/{name}']?.['get']?.responses['200']?.content ?? {};
    expect(content['application/json']?.schema.type).toBeUndefined();
    expect(content['text/csv']?.schema.type).toBe('string');
  });
});
