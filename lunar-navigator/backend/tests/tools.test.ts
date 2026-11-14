/**
 * POST /api/v1/tools/ephemeris and POST /api/v1/tools/horizon with the FAKE lunarnav
 * (tests/jobs/fake_b4/lunarnav: deterministic values, failure modes chosen by the site latitude) and the
 * real bridges (backend/python/ephemeris_json.py, horizon_json.py, tools_common.py) and the run_small
 * fixture imported into a throw-away MongoDB 8.0. Real numbers: tests/tools.slow.test.ts.
 * GET /capabilities is wrapped so single tests can switch a provider / DEM / CLI flag off.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/contract/capabilities.ts';
import { EphemerisResponse, HorizonToolResponse, TOOLS_LIMITS } from '../src/contract/tools.ts';
import { loadConfig } from '../src/config.ts';
import { getDb } from '../src/db.ts';
import { importRun } from '../src/importer/importRun.ts';
import { Problem } from '../src/lib/problem.ts';
import { startTestApp, type TestContext } from './helpers.ts';

let capsPatch: ((c: Capabilities) => Capabilities) | null = null;
vi.mock('../src/python/capabilities.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/python/capabilities.ts')>();
  return {
    ...orig,
    getCapabilities: async (...args: Parameters<typeof orig.getCapabilities>) => {
      const c = await orig.getCapabilities(...args);
      return capsPatch ? capsPatch(structuredClone(c)) : c;
    },
  };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ROOT = path.join(here, 'jobs', 'fake_b4');
const FIXTURE = path.resolve(here, 'importer', 'fixtures', 'run_small');
const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);
const RUN_ID = 'run_small';
const API = '/api/v1';
const TIMES = ['2026-01-01T02:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T02:00:00Z'];

let ctx: TestContext;

const post = (tool: 'ephemeris' | 'horizon', payload: unknown) => ctx.app.inject({ method: 'POST', url: `${API}/tools/${tool}`, payload: payload as object });

async function problem(tool: 'ephemeris' | 'horizon', payload: unknown, status: number, code: string): Promise<Problem> {
  const r = await post(tool, payload);
  expect(r.statusCode, r.body).toBe(status);
  expect(r.headers['content-type']).toContain('application/problem+json');
  const p = Problem.parse(r.json());
  expect(p.code).toBe(code);
  return p;
}

/** fake provider values (tests/jobs/fake_b4/lunarnav/precompute.py), rounded like the run files */
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const fakeSunAz = (t: string, lon: number) => r6((((Date.parse(t) - Date.parse('2026-01-01T00:00:00Z')) / 3_600_000) * 15 + lon) % 360 + 1 / 3);

describe.skipIf(!HAVE_PY)('POST /tools/* (fake lunarnav)', () => {
  beforeAll(async () => {
    ctx = await startTestApp({ config: { LUNARNAV_ROOT: FAKE_ROOT, RATE_LIMIT_POST_MAX: 10_000, RATE_LIMIT_TOOLS_MAX: 10_000, ALTDATES_TIMEOUT_S: 3 } });
    await importRun(getDb(), { dir: FIXTURE, runId: RUN_ID, check: false, dataDir: null, catalogPath: null, setDefault: true });
  });
  afterAll(async () => {
    await ctx?.close();
  });
  afterEach(() => {
    capsPatch = null;
  });

  describe('ephemeris', () => {
    it('lat/lon: rows in request order, auto height = DEM, run-file rounding, provider config', async () => {
      const r = await post('ephemeris', { lat_deg: -85.5, lon_deg: -170, times: TIMES });
      expect(r.statusCode, r.body).toBe(200);
      const b = EphemerisResponse.parse(r.json());
      expect(b.site).toEqual({ site_id: null, name: null, lat_deg: -85.5, lon_deg: 190, custom_site_id: 'custom:-85.5000:190.0000', source: 'coordinates', run_id: null });
      expect(b.provider).toBe('horizons'); // web default since 14/11 (online)
      expect(b.provider_config).toEqual({ name: 'horizons', flavour: 'fake' });
      expect(b.height).toEqual({ source: 'dem', surface_height_m: 914.5, observer_height_m: 2, observer_height_above_sphere_m: 916.5, dem_source: 'pgda:fake_bands', note: 'auto: PGDA DEM height at the site' });
      expect(b.rounding).toBe('run_files');
      expect(b.n_times).toBe(3);
      expect(b.rows.map((x) => x.time_utc)).toEqual(TIMES);
      expect(b.rows[1]!.sun_az_deg).toBe(fakeSunAz(TIMES[1]!, 190));
      expect(b.rows[0]!.sun_az_deg).toBe(fakeSunAz(TIMES[0]!, 190));
      expect(b.rows[0]).toEqual(b.rows[2]);
      expect(b.rows[0]!.sun_el_deg).toBe(r6(-0.855 + 916.5 / 1e6 + 1 / 7));
      expect(b.rows[0]!.sun_dist_km).toBe(Math.round((1.5e8 + 916.5 / 3) * 1000) / 1000);
      expect(b.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it("rounding 'none' returns float64 values; provider analytic / horizons are passed through", async () => {
      const b = EphemerisResponse.parse((await post('ephemeris', { lat_deg: -85.5, lon_deg: 190, times: [TIMES[0]], rounding: 'none', provider: 'analytic' })).json());
      expect(b.rows[0]!.sun_el_deg).toBe(-0.855 + 916.5 / 1e6 + 1 / 7);
      expect(b.provider).toBe('analytic');
      expect(b.provider_config['name']).toBe('analytic');
      const h = await post('ephemeris', { lat_deg: -85.5, lon_deg: 190, times: [TIMES[0]], provider: 'horizons' });
      expect(h.statusCode, h.body).toBe(200);
    });

    it('site of the default run: coordinates + heights from its site record', async () => {
      const rec = (await getDb().collection<{ _id: string; record: Record<string, number> }>('site_runs').findOne({ _id: `${RUN_ID}|ref_shackleton_rim` }))!.record;
      const r = await post('ephemeris', { site_id: 'ref_shackleton_rim', times: [TIMES[0]] });
      expect(r.statusCode, r.body).toBe(200);
      const b = EphemerisResponse.parse(r.json());
      expect(b.site).toMatchObject({ site_id: 'ref_shackleton_rim', source: 'run', run_id: RUN_ID, lat_deg: rec['lat_deg'], lon_deg: rec['lon_deg'] });
      expect(b.height).toEqual({
        source: 'run',
        surface_height_m: rec['surface_height_m'],
        observer_height_m: rec['observer_height_m'],
        observer_height_above_sphere_m: rec['observer_height_above_sphere_m'],
        dem_source: null,
        note: `auto: site record of run ${RUN_ID}`,
      });
      // explicit run + another mast: surface + mast
      const m = EphemerisResponse.parse((await post('ephemeris', { site_id: 'ref_shackleton_rim', run_id: RUN_ID, surface_height: 'run', observer_height_m: 10, times: [TIMES[0]] })).json());
      expect(m.height).toMatchObject({ source: 'run', observer_height_m: 10, observer_height_above_sphere_m: rec['surface_height_m']! + 10, note: null });
      // custom site of the run
      const c = EphemerisResponse.parse((await post('ephemeris', { site_id: 'custom:-89.4500:222.6900', times: [TIMES[0]] })).json());
      expect(c.site).toMatchObject({ source: 'run', custom_site_id: 'custom:-89.4500:222.6900' });
    });

    it('catalog / custom ids outside the run are resolved by lunarnav.sites; heights value / sphere / dem', async () => {
      const a = EphemerisResponse.parse((await post('ephemeris', { site_id: 'fake_polar', times: [TIMES[0]], surface_height: 123.5, observer_height_m: 1.5 })).json());
      expect(a.site).toMatchObject({ site_id: 'fake_polar', name: 'Fake polar site', lat_deg: -85, lon_deg: 10, source: 'catalog', run_id: null });
      expect(a.height).toMatchObject({ source: 'value', surface_height_m: 123.5, observer_height_m: 1.5, observer_height_above_sphere_m: 125 });
      const s = EphemerisResponse.parse((await post('ephemeris', { site_id: 'custom:-80.0000:10.0000', times: [TIMES[0]], surface_height: 'sphere' })).json());
      expect(s.site).toMatchObject({ source: 'custom_id', lat_deg: -80, lon_deg: 10 });
      expect(s.height).toMatchObject({ source: 'sphere', surface_height_m: 0, observer_height_above_sphere_m: 2 });
      const d = EphemerisResponse.parse((await post('ephemeris', { site_id: 'fake_polar', times: [TIMES[0]], surface_height: 'dem' })).json());
      expect(d.height).toMatchObject({ source: 'dem', surface_height_m: 915, dem_source: 'pgda:fake_bands' });
    });

    it('outside the DEM: auto -> smooth sphere with a note, dem -> 422 OUT_OF_RANGE', async () => {
      const a = EphemerisResponse.parse((await post('ephemeris', { lat_deg: 10, lon_deg: 20, times: [TIMES[0]] })).json());
      expect(a.height.source).toBe('sphere');
      expect(a.height.note).toContain('fake PGDA covers the south polar region only');
      const p = await problem('ephemeris', { lat_deg: 10, lon_deg: 20, times: [TIMES[0]], surface_height: 'dem' }, 422, 'OUT_OF_RANGE');
      expect(p.detail).toContain('south polar region only');
    });

    it('400 for bad bodies', async () => {
      const t = [TIMES[0]];
      await problem('ephemeris', { times: t }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { site_id: 'apollo11', lat_deg: 1, lon_deg: 2, times: t }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { lat_deg: 1, times: t }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { lat_deg: 1, lon_deg: 2, run_id: RUN_ID, times: t }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { lat_deg: 1, lon_deg: 2, times: [] }, 400, 'VALIDATION_ERROR');
      const many = Array.from({ length: TOOLS_LIMITS.ephemeris_max_times + 1 }, (_, i) => new Date(Date.UTC(2026, 0, 1, i)).toISOString().replace('.000Z', 'Z'));
      await problem('ephemeris', { lat_deg: 1, lon_deg: 2, times: many }, 400, 'VALIDATION_ERROR');
      const frac = await problem('ephemeris', { lat_deg: 1, lon_deg: 2, times: ['2026-01-01T00:00:00.5Z'] }, 400, 'VALIDATION_ERROR');
      expect(frac.errors?.[0]?.message).toContain('fractional');
      await problem('ephemeris', { lat_deg: 1, lon_deg: 2, times: ['1850-01-01T00:00:00Z'] }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { lat_deg: 1, lon_deg: 2, times: ['2026-02-30T00:00:00Z'] }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { lat_deg: 1, lon_deg: 2, times: t, provider: 'synthetic' }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { lat_deg: 1, lon_deg: 2, times: t, path: '/etc/passwd' }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { lat_deg: 1, lon_deg: 2, times: t, surface_height: 'run' }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { site_id: 'custom:-89.45:222.69', times: t }, 400, 'VALIDATION_ERROR');
      await problem('ephemeris', { site_id: '../../etc', times: t }, 400, 'VALIDATION_ERROR');
    });

    it('404 / 409 for unknown sites and runs', async () => {
      const t = [TIMES[0]];
      await problem('ephemeris', { site_id: 'nope', times: t }, 404, 'SITE_NOT_FOUND');
      await problem('ephemeris', { site_id: 'apollo11', run_id: 'pf_0000000000000000', times: t }, 404, 'RUN_NOT_FOUND');
      await problem('ephemeris', { site_id: 'fake_polar', run_id: RUN_ID, times: t }, 404, 'SITE_NOT_FOUND');
      await problem('ephemeris', { site_id: 'fake_polar', surface_height: 'run', times: t }, 404, 'SITE_NOT_FOUND');
    });

    it('Python failures: provider error 502 (paths hidden), traceback / garbage 502, ValueError 422, timeout 504', async () => {
      const t = [TIMES[0]];
      const pe = await problem('ephemeris', { lat_deg: -11, lon_deg: 0, times: t, surface_height: 'sphere' }, 502, 'PYTHON_FAILED');
      expect(pe.detail).toContain('network down');
      expect(pe.detail).toMatch(/<LUNARNAV_(DATA|ROOT)>[\\/]cache[\\/]x\.bin/);
      expect(pe.detail).not.toContain(FAKE_ROOT);
      const tb = await problem('ephemeris', { lat_deg: -14, lon_deg: 0, times: t, surface_height: 'sphere' }, 502, 'PYTHON_FAILED');
      expect(tb.detail).toBe('ephemeris bridge failed (see server log)');
      await problem('ephemeris', { lat_deg: -13, lon_deg: 0, times: t, surface_height: 'sphere' }, 502, 'PYTHON_FAILED');
      const ve = await problem('ephemeris', { lat_deg: -15, lon_deg: 0, times: t, surface_height: 'sphere' }, 422, 'OUT_OF_RANGE');
      expect(ve.detail).toContain('time outside the ephemeris');
      const t0 = Date.now();
      const to = await problem('ephemeris', { lat_deg: -12, lon_deg: 0, times: t, surface_height: 'sphere' }, 504, 'PYTHON_TIMEOUT');
      expect(to.detail).toContain('exceeded 3 s');
      expect(Date.now() - t0).toBeLessThan(20_000);
    }, 30_000);

    it('422 CAPABILITY_UNAVAILABLE when the provider or PGDA is not available', async () => {
      capsPatch = (c) => ({ ...c, providers: { ...c.providers, horizons: { available: false, reason: 'JPL Horizons not reachable' } } });
      const p = await problem('ephemeris', { lat_deg: -85, lon_deg: 0, times: [TIMES[0]], provider: 'horizons' }, 422, 'CAPABILITY_UNAVAILABLE');
      expect(p.detail).toContain('JPL Horizons not reachable');
      capsPatch = (c) => ({ ...c, dems: { ...c.dems, pgda: { ...c.dems.pgda, available: false, reason: 'rasterio is not installed' } } });
      await problem('ephemeris', { lat_deg: -85, lon_deg: 0, times: [TIMES[0]], surface_height: 'dem' }, 422, 'CAPABILITY_UNAVAILABLE');
      const a = EphemerisResponse.parse((await post('ephemeris', { lat_deg: -85, lon_deg: 0, times: [TIMES[0]] })).json());
      expect(a.height).toMatchObject({ source: 'sphere', surface_height_m: 0 });
      expect(a.height.note).toContain('rasterio is not installed');
    });
  });

  describe('horizon', () => {
    it('pgda raymarch: options reach make_horizon_fn, mask arrays, distances, near exclusion', async () => {
      const r = await post('horizon', { lat_deg: -85.5, lon_deg: 190, radius_km: 30, az_step_deg: 2, observer_height_m: 3, near_exclusion_m: 250 });
      expect(r.statusCode, r.body).toBe(200);
      const b = HorizonToolResponse.parse(r.json());
      expect(b.site).toMatchObject({ source: 'coordinates', lat_deg: -85.5, lon_deg: 190 });
      expect(b).toMatchObject({ method: 'raymarch', dem_source: 'fake:pgda:raymarch:r30:ne250:obs3', radius_km: 30, az_step_deg: 2, observer_height_m: 3, surface_height_m: 914.5, near_exclusion_m: 250, dem_fallback: null, rounding: 'run_files', n_az: 180 });
      expect(b.az_deg).toHaveLength(180);
      expect(b.az_deg[1]).toBe(2);
      expect(b.el_deg[45]).toBe(r6(0.1 + 1 / 7));
      expect(b.max_el_deg).toBe(Math.max(...b.el_deg));
      expect(b.min_el_deg).toBe(Math.min(...b.el_deg));
      expect(b.covered_radius_km.every((x) => x === 30)).toBe(true);
      expect(b.horizon_distance_km?.[0]).toBeNull();
      expect(b.horizon_distance_km?.[1]).toBe(10);
      // defaults: 60 km, 0.5 deg, near_exclusion not sent -> lunarnav default 'auto'
      const d = HorizonToolResponse.parse((await post('horizon', { site_id: 'fake_polar' })).json());
      expect(d).toMatchObject({ dem_source: 'fake:pgda:raymarch:r60:neauto:obs2', n_az: 720, near_exclusion_m: 0 });
      expect(d.site).toMatchObject({ source: 'catalog', name: 'Fake polar site' });
    });

    it('dem none -> flat (catalog height kept); outside PGDA: fallback flat or 422', async () => {
      const f = HorizonToolResponse.parse((await post('horizon', { site_id: 'fake_tall', dem: 'none', az_step_deg: 10 })).json());
      expect(f).toMatchObject({ method: 'flat', dem_source: 'none', surface_height_m: 100, near_exclusion_m: null, n_az: 36, horizon_distance_km: null });
      const fb = HorizonToolResponse.parse((await post('horizon', { site_id: 'apollo11', az_step_deg: 10 })).json());
      expect(fb).toMatchObject({ method: 'flat', dem_source: 'none:outside-pgda-coverage', dem_fallback: 'outside the fake PGDA coverage' });
      expect(fb.site).toMatchObject({ source: 'run', run_id: RUN_ID });
      await problem('horizon', { site_id: 'apollo11', dem_fallback: 'error' }, 422, 'OUT_OF_RANGE');
    });

    it('400 for limits / bad options, 422 when near_exclusion or PGDA is not available', async () => {
      await problem('horizon', { lat_deg: -85, lon_deg: 0, radius_km: 61 }, 400, 'VALIDATION_ERROR');
      await problem('horizon', { lat_deg: -85, lon_deg: 0, az_step_deg: 0.1 }, 400, 'VALIDATION_ERROR');
      const div = await problem('horizon', { lat_deg: -85, lon_deg: 0, az_step_deg: 0.7 }, 400, 'VALIDATION_ERROR');
      expect(div.errors?.[0]?.message).toContain('divide 360');
      await problem('horizon', { lat_deg: -85, lon_deg: 0, method: 'bruteforce' }, 400, 'VALIDATION_ERROR');
      await problem('horizon', { lat_deg: -85, lon_deg: 0, dem: 'trek' }, 400, 'VALIDATION_ERROR');
      await problem('horizon', { lat_deg: -85, lon_deg: 0, near_exclusion_m: -1 }, 400, 'VALIDATION_ERROR');
      capsPatch = (c) => ({ ...c, cli: { ...c.cli, near_exclusion_m: false } });
      await problem('horizon', { lat_deg: -85, lon_deg: 0, near_exclusion_m: 250 }, 422, 'CAPABILITY_UNAVAILABLE');
      // 'auto' = the lunarnav default: no capability needed, not sent to make_horizon_fn
      const auto = HorizonToolResponse.parse((await post('horizon', { lat_deg: -85, lon_deg: 0, near_exclusion_m: 'auto', az_step_deg: 10 })).json());
      expect(auto.dem_source).toBe('fake:pgda:raymarch:r60:neauto:obs2');
      capsPatch = (c) => ({ ...c, dems: { ...c.dems, pgda: { ...c.dems.pgda, available: false, reason: 'PGDA not reachable and no cached tiles' } } });
      await problem('horizon', { lat_deg: -85, lon_deg: 0 }, 422, 'CAPABILITY_UNAVAILABLE');
      const ok = await post('horizon', { lat_deg: -85, lon_deg: 0, dem: 'none' });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it('Python failures map like the ephemeris tool', async () => {
      await problem('horizon', { lat_deg: -11, lon_deg: 0 }, 502, 'PYTHON_FAILED');
      await problem('horizon', { lat_deg: -14, lon_deg: 0 }, 502, 'PYTHON_FAILED');
      await problem('horizon', { lat_deg: -15, lon_deg: 0 }, 422, 'OUT_OF_RANGE');
      await problem('horizon', { site_id: 'nope_not_here' }, 404, 'SITE_NOT_FOUND');
      const to = await problem('horizon', { lat_deg: -12, lon_deg: 0 }, 504, 'PYTHON_TIMEOUT');
      expect(to.hint).toContain('horizon_mask');
    }, 30_000);
  });

  it('GET /capabilities lists both tools as available', async () => {
    const c = (await ctx.app.inject({ method: 'GET', url: `${API}/capabilities` })).json() as Capabilities;
    expect(c.tools).toEqual({ ephemeris: { available: true, reason: null }, horizon: { available: true, reason: null } });
  });
});
