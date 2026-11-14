/**
 * SLOW cross-check of POST /api/v1/tools/ephemeris and POST /api/v1/tools/horizon with the REAL lunarnav
 * (real SPICE kernels, real PGDA tiles) against
 *   (1) the imported real sample run (tests/fixtures/sample_2026Q1_spice_pgda, SPICE + PGDA raymarch 150 km):
 *       GET /sites/{id}/series and GET /sites/{id}/horizon, and the run files themselves;
 *   (2) direct Python calls of lunarnav (lunarnav.sites.get_site, precompute.get_provider(...).compute,
 *       precompute.make_horizon_fn) in a separate interpreter, independent of the bridges.
 * SPICE comparisons are EXACT (toBe on doubles).
 * Opt-in: RUN_SLOW=1 npx vitest run tests/tools.slow.test.ts  (~30-60 s with cached PGDA tiles).
 * RUN_NETWORK=1 additionally checks provider horizons (JPL Horizons API) against SPICE.
 * Also the async job horizon_mask (150 km, the run's options) == the run horizon exactly.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SeriesResponse } from '../src/contract/series.ts';
import { HorizonResponse } from '../src/contract/sites.ts';
import { Job, JobAccepted } from '../src/contract/jobs.ts';
import { EphemerisResponse, HorizonToolResponse, type EphemerisResponse as EphemerisResponseT } from '../src/contract/tools.ts';
import { getDb } from '../src/db.ts';
import { importRun } from '../src/importer/importRun.ts';
import { startTestApp, type TestContext } from './helpers.ts';
import { PYTHON_BIN, REPO_ROOT, SAMPLE_DIR, SAMPLE_RUN_ID, hasPython, hasSample } from './sample.ts';

const SLOW = process.env['RUN_SLOW'] === '1';
const NETWORK = process.env['RUN_NETWORK'] === '1';
const API = '/api/v1';
const COLS = ['sun_az_deg', 'sun_el_deg', 'sun_dist_km', 'earth_az_deg', 'earth_el_deg', 'earth_dist_km'] as const;
type Col = (typeof COLS)[number];
const SITES = ['ref_shackleton_rim', 'ref_connecting_ridge_c1', 'apollo11', 'change6'] as const;
const RUN_START = Date.parse('2026-01-01T00:00:00Z');
const N_SAMPLES = 2160;

let ctx: TestContext;

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** seeded PRNG (mulberry32) */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** grid times of the run: first, last and 10 random samples, shuffled (rows must come back in request order) */
function gridTimes(seed: number): string[] {
  const rnd = prng(seed);
  const idx = [0, N_SAMPLES - 1, ...Array.from({ length: 10 }, () => Math.floor(rnd() * N_SAMPLES))];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.map((k) => iso(RUN_START + k * 3_600_000));
}

/** ephemeris file of the run, by time */
function runEphemerisFile(siteId: string): Map<string, Record<Col, number>> {
  const rows = parse(gunzipSync(readFileSync(path.join(SAMPLE_DIR, 'sites', siteId, 'ephemeris_spice.csv.gz'))), { columns: true }) as Record<string, string>[];
  return new Map(rows.map((r) => [r['time_utc']!, Object.fromEntries(COLS.map((c) => [c, Number(r[c])])) as Record<Col, number>]));
}

/** direct lunarnav call in a separate interpreter (no bridge code): JSON in on stdin, JSON out (float repr round-trips) */
const DIRECT_PY = String.raw`
import json, sys
import numpy as np
req = json.load(sys.stdin)
from lunarnav.sites import get_site
from lunarnav.precompute import get_provider, make_horizon_fn, _fmt_column
site = get_site(req["site_id"])
out = {}
if req["what"] == "ephemeris":
    times = np.array([t.rstrip("Z") for t in req["times"]], dtype="datetime64[s]")
    eph = get_provider(req["provider"]).compute(site, times, float(req["height_above_sphere_m"]))
    for c in ("sun_az_deg", "sun_el_deg", "sun_dist_km", "earth_az_deg", "earth_el_deg", "earth_dist_km"):
        a = np.asarray(getattr(eph, c), float)
        out[c] = {"none": [float(x) for x in a], "run_files": [float(s) for s in _fmt_column(c, a)]}
else:
    m = make_horizon_fn(dem=req["dem"], method=req["method"], radius_km=float(req["radius_km"]),
                        az_step_deg=float(req["az_step_deg"]), observer_height_m=float(req["observer_height_m"]),
                        dem_fallback="flat")(site)
    out = {"method": m.method, "dem_source": str(m.dem_source),
           "az_deg": [float(s) for s in _fmt_column("az_deg", m.az_deg)],
           "el_deg": [float(s) for s in _fmt_column("el_deg", m.el_deg)],
           "el_deg_none": [float(x) for x in np.asarray(m.el_deg, float)]}
print(json.dumps(out))
`;

function direct<T>(req: object): T {
  const r = spawnSync(PYTHON_BIN, ['-c', DIRECT_PY], { cwd: REPO_ROOT, input: JSON.stringify(req), encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT }, timeout: 300_000 });
  if (r.status !== 0) throw new Error(`direct python failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T;
}

async function ephemeris(payload: object): Promise<EphemerisResponseT> {
  // the API default provider is horizons (network) since 14/11: these exact comparisons are against the SPICE run
  const r = await ctx.app.inject({ method: 'POST', url: `${API}/tools/ephemeris`, payload: { provider: 'spice', ...payload } });
  expect(r.statusCode, r.body).toBe(200);
  return EphemerisResponse.parse(r.json());
}

describe.skipIf(!SLOW || !hasPython() || !hasSample())('slow: /tools/* vs the imported sample run and direct lunarnav calls', () => {
  beforeAll(async () => {
    ctx = await startTestApp({ config: { RATE_LIMIT_POST_MAX: 10_000, RATE_LIMIT_TOOLS_MAX: 10_000, ALTDATES_TIMEOUT_S: 120 } });
    await importRun(getDb(), { dir: SAMPLE_DIR, runId: SAMPLE_RUN_ID, check: false, dataDir: null, catalogPath: null, setDefault: true });
  }, 300_000);
  afterAll(async () => {
    await ctx?.close();
  });

  it.each(SITES.map((s, i) => [s, i] as const))('ephemeris spice of run site %s == imported run (series API) == run file, exactly', { timeout: 120_000 }, async (siteId, i) => {
    const times = gridTimes(20261114 + i);
    const b = await ephemeris({ site_id: siteId, times });
    expect(b.site).toMatchObject({ site_id: siteId, source: 'run', run_id: SAMPLE_RUN_ID });
    expect(b.height.source).toBe('run');
    expect(b.provider_config).toMatchObject({ lunar_set: 'de440', frame: 'MOON_ME', abcorr: 'CN+S' });
    expect(b.rows.map((r) => r.time_utc)).toEqual(times);
    const file = runEphemerisFile(siteId);
    for (const row of b.rows) {
      const s = await ctx.app.inject({
        method: 'GET',
        url: `${API}/sites/${encodeURIComponent(siteId)}/series?run_id=${SAMPLE_RUN_ID}&start=${row.time_utc}&end=${iso(Date.parse(row.time_utc) + 3_600_000)}&fields=${COLS.join(',')}`,
      });
      expect(s.statusCode, s.body).toBe(200);
      const ser = SeriesResponse.parse(s.json());
      expect(ser.n).toBe(1);
      const f = file.get(row.time_utc)!;
      for (const c of COLS) {
        const api = (ser.fields[c] as (number | null)[])[0];
        expect(row[c], `${siteId} ${row.time_utc} ${c} vs series API`).toBe(api);
        expect(row[c], `${siteId} ${row.time_utc} ${c} vs run file`).toBe(f[c]);
      }
    }
  });

  it('ephemeris spice at arbitrary instants (off the grid) == direct lunarnav call, rounding run_files and none, exactly', { timeout: 120_000 }, async () => {
    const rnd = prng(7);
    const times = Array.from({ length: 40 }, () => iso(Date.parse('2024-01-01T00:00:00Z') + Math.floor(rnd() * 10 * 365.25 * 86400) * 1000));
    for (const siteId of ['ref_shackleton_rim', 'apollo11']) {
      const rec = (await getDb().collection<{ _id: string; record: { observer_height_above_sphere_m: number } }>('site_runs').findOne({ _id: `${SAMPLE_RUN_ID}|${siteId}` }))!.record;
      const ref = direct<Record<Col, { none: number[]; run_files: number[] }>>({ what: 'ephemeris', site_id: siteId, times, provider: 'spice', height_above_sphere_m: rec.observer_height_above_sphere_m });
      const a = await ephemeris({ site_id: siteId, times });
      const n = await ephemeris({ site_id: siteId, times, rounding: 'none' });
      times.forEach((t, k) => {
        for (const c of COLS) {
          expect(a.rows[k]![c], `${siteId} ${t} ${c} run_files`).toBe(ref[c].run_files[k]);
          expect(n.rows[k]![c], `${siteId} ${t} ${c} none`).toBe(ref[c].none[k]);
        }
      });
    }
  });

  it('lat/lon + numeric surface height of the run site record == the run (coordinates path)', { timeout: 60_000 }, async () => {
    const rec = (await getDb().collection<{ _id: string; record: { lat_deg: number; lon_deg: number; surface_height_m: number; observer_height_m: number } }>('site_runs').findOne({ _id: `${SAMPLE_RUN_ID}|ref_connecting_ridge_c1` }))!.record;
    const times = gridTimes(99).slice(0, 5);
    const b = await ephemeris({ lat_deg: rec.lat_deg, lon_deg: rec.lon_deg - 360, times, surface_height: rec.surface_height_m, observer_height_m: rec.observer_height_m });
    expect(b.site).toMatchObject({ source: 'coordinates', lat_deg: rec.lat_deg, lon_deg: rec.lon_deg });
    const file = runEphemerisFile('ref_connecting_ridge_c1');
    for (const row of b.rows) for (const c of COLS) expect(row[c], `${row.time_utc} ${c}`).toBe(file.get(row.time_utc)![c]);
    // auto height for bare coordinates = PGDA DEM height (what a pgda precompute uses), within a few metres of the record
    const d = await ephemeris({ lat_deg: rec.lat_deg, lon_deg: rec.lon_deg, times: times.slice(0, 1) });
    expect(d.height.source).toBe('dem');
    expect(Math.abs(d.height.surface_height_m - rec.surface_height_m)).toBeLessThan(0.01);
  });

  it('provider analytic agrees with SPICE to < 0.02 deg (documented approximation)', { timeout: 60_000 }, async () => {
    const times = gridTimes(5);
    const s = await ephemeris({ site_id: 'ref_shackleton_rim', times });
    const a = await ephemeris({ site_id: 'ref_shackleton_rim', times, provider: 'analytic' });
    expect(a.provider).toBe('analytic');
    let worst = 0;
    s.rows.forEach((r, k) => {
      for (const c of ['sun_el_deg', 'earth_el_deg'] as const) worst = Math.max(worst, Math.abs(r[c] - a.rows[k]![c]));
      for (const c of ['sun_az_deg', 'earth_az_deg'] as const) worst = Math.max(worst, Math.abs(((r[c] - a.rows[k]![c] + 540) % 360) - 180));
    });
    console.info(`[tools.slow] analytic vs spice worst angle diff ${worst.toFixed(6)} deg`);
    expect(worst).toBeLessThan(0.02);
  });

  it.skipIf(!NETWORK)('provider horizons agrees with SPICE to < 0.01 deg (network)', { timeout: 120_000 }, async () => {
    const times = gridTimes(6).slice(0, 4);
    const s = await ephemeris({ site_id: 'ref_shackleton_rim', times });
    const h = await ephemeris({ site_id: 'ref_shackleton_rim', times, provider: 'horizons' });
    s.rows.forEach((r, k) => {
      expect(Math.abs(r.sun_el_deg - h.rows[k]!.sun_el_deg)).toBeLessThan(0.01);
      expect(Math.abs(r.earth_el_deg - h.rows[k]!.earth_el_deg)).toBeLessThan(0.01);
    });
  });

  it('horizon pgda raymarch 60 km == direct make_horizon_fn exactly, and never above the run horizon (150 km)', { timeout: 300_000 }, async () => {
    for (const siteId of ['ref_shackleton_rim', 'ref_connecting_ridge_c1']) {
      const r = await ctx.app.inject({ method: 'POST', url: `${API}/tools/horizon`, payload: { site_id: siteId, radius_km: 60, az_step_deg: 0.5 } });
      expect(r.statusCode, r.body).toBe(200);
      const t = HorizonToolResponse.parse(r.json());
      expect(t).toMatchObject({ method: 'raymarch', radius_km: 60, n_az: 720, dem_fallback: null });
      const ref = direct<{ method: string; dem_source: string; az_deg: number[]; el_deg: number[]; el_deg_none: number[] }>({
        what: 'horizon', site_id: siteId, dem: 'pgda', method: 'raymarch', radius_km: 60, az_step_deg: 0.5, observer_height_m: 2,
      });
      expect(t.dem_source).toBe(ref.dem_source);
      expect(t.az_deg).toEqual(ref.az_deg);
      expect(t.el_deg).toEqual(ref.el_deg);
      const run = HorizonResponse.parse((await ctx.app.inject({ method: 'GET', url: `${API}/sites/${siteId}/horizon?run_id=${SAMPLE_RUN_ID}` })).json());
      expect(run.az_deg).toEqual(t.az_deg);
      expect(run.dem_source).toBe(t.dem_source);
      const above = t.el_deg.filter((e, k) => e > run.el_deg[k]! + 1e-6).length;
      const equal = t.el_deg.filter((e, k) => e === run.el_deg[k]).length;
      console.info(`[tools.slow] ${siteId}: 60 km tool horizon equals the 150 km run horizon at ${equal}/720 azimuths, above it at ${above}`);
      expect(above).toBe(0);
      expect(equal).toBeGreaterThan(0);
    }
  });

  it('job horizon_mask with the run options (pgda raymarch 150 km, 0.5 deg) == the run horizon exactly', { timeout: 600_000 }, async () => {
    const res = await ctx.app.inject({ method: 'POST', url: `${API}/jobs`, payload: { type: 'horizon_mask', site_id: 'ref_connecting_ridge_c1', radius_km: 150, az_step_deg: 0.5 } });
    expect(res.statusCode, res.body).toBe(202);
    const id = JobAccepted.parse(res.json()).job_id;
    let j: Job;
    for (;;) {
      j = Job.parse((await ctx.app.inject({ method: 'GET', url: `${API}/jobs/${id}` })).json());
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(j.status, JSON.stringify(j.error)).toBe('succeeded');
    const a = await ctx.app.inject({ method: 'GET', url: j.artifacts.find((x) => x.name === 'horizon.json')!.url });
    const t = HorizonToolResponse.parse(a.json());
    const run = HorizonResponse.parse((await ctx.app.inject({ method: 'GET', url: `${API}/sites/ref_connecting_ridge_c1/horizon?run_id=${SAMPLE_RUN_ID}` })).json());
    expect(t).toMatchObject({ method: 'raymarch', radius_km: 150, n_az: 720 });
    expect(t.site).toMatchObject({ source: 'run', run_id: SAMPLE_RUN_ID });
    expect(t.dem_source).toBe(run.dem_source);
    expect(t.az_deg).toEqual(run.az_deg);
    expect(t.el_deg).toEqual(run.el_deg);
    console.info(`[tools.slow] horizon_mask 150 km job: ${t.elapsed_ms} ms, equals the run horizon at all 720 azimuths`);
  });

  it('horizon outside PGDA (apollo11): smooth-sphere fallback == the run horizon file exactly; dem none -> flat', { timeout: 120_000 }, async () => {
    const r = await ctx.app.inject({ method: 'POST', url: `${API}/tools/horizon`, payload: { site_id: 'apollo11' } });
    expect(r.statusCode, r.body).toBe(200);
    const t = HorizonToolResponse.parse(r.json());
    const run = HorizonResponse.parse((await ctx.app.inject({ method: 'GET', url: `${API}/sites/apollo11/horizon?run_id=${SAMPLE_RUN_ID}` })).json());
    expect(t.method).toBe('flat');
    expect(t.dem_fallback).not.toBeNull();
    expect(t.dem_source).toBe(run.dem_source);
    expect(t.az_deg).toEqual(run.az_deg);
    expect(t.el_deg).toEqual(run.el_deg);
    const n = HorizonToolResponse.parse((await ctx.app.inject({ method: 'POST', url: `${API}/tools/horizon`, payload: { site_id: 'apollo11', dem: 'none' } })).json());
    expect(n).toMatchObject({ method: 'flat', dem_source: 'none', dem_fallback: null });
    expect(n.el_deg).toEqual(run.el_deg);
  });
});
