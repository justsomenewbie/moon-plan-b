/**
 * GET /api/v1/sites/{site_id}/pointing on the REAL sample run (tests/fixtures/sample_2026Q1_spice_pgda,
 * 6 sites, 2026-01-01..2026-04-01 hourly) loaded into a throw-away MongoDB 8.0.
 * Cross-checks: panel / antenna = the visibility.csv.gz columns of the sample containing t, compass =
 * compassPoint(az), times until events = GET /instant next_events (same Python semantics).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PointingResponse } from '../../src/contract/pointing.ts';
import { InstantResponse } from '../../src/contract/series.ts';
import { Problem } from '../../src/lib/problem.ts';
import { compassPoint } from '../../src/lib/compass.ts';
import { getDb } from '../../src/db.ts';
import { startTestApp, type TestContext } from '../helpers.ts';
import { SAMPLE_DIR, hasSample, loadSampleRun, type SampleRun, type SampleSite } from '../routes/b/data.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { terrainModelled } from '../../src/contract/pointing.ts';

const API = '/api/v1';
const RIDGE = 'ref_connecting_ridge_c1';
let ctx: TestContext;
let sample: SampleRun;
/** Sites of the sample whose horizon models the terrain (apollo11 / change6 are outside the PGDA DEM -> flat). */
const TERRAIN_SITES: Set<string> = hasSample()
  ? new Set(
      (JSON.parse(readFileSync(path.join(SAMPLE_DIR, 'sites.json'), 'utf8')) as { sites: { id: string; horizon_method: string; dem_source: string }[] }).sites
        .filter((r) => terrainModelled(r.horizon_method, r.dem_source))
        .map((r) => r.id),
    )
  : new Set();

const site = (id: string): SampleSite => {
  const s = sample.sites.get(id);
  if (!s) throw new Error(`no sample site ${id}`);
  return s;
};
const col = (s: SampleSite, f: string): (number | boolean | null)[] => (s.columns as Record<string, (number | boolean | null)[]>)[f] ?? [];
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

async function pointing(siteId: string, query: string, status = 200) {
  const res = await ctx.app.inject({ method: 'GET', url: `${API}/sites/${encodeURIComponent(siteId)}/pointing${query}` });
  expect(res.statusCode, res.body.slice(0, 500)).toBe(status);
  return res;
}
const ok = async (siteId: string, query: string): Promise<PointingResponse> => PointingResponse.parse((await pointing(siteId, query)).json());
const instant = async (siteId: string, t: string): Promise<InstantResponse> =>
  InstantResponse.parse((await ctx.app.inject({ method: 'GET', url: `${API}/sites/${encodeURIComponent(siteId)}/instant?t=${t}` })).json());

/** Compare one /pointing response with the sample columns and with /instant at the same t. */
async function crossCheck(siteId: string, i: number, offsetMin = 0): Promise<PointingResponse> {
  const s = site(siteId);
  const t = iso((s.times[i] ?? 0) + offsetMin * 60_000);
  const p = await ok(siteId, `?t=${t}`);
  const at = (f: string) => col(s, f)[i];
  expect(p.site_id).toBe(siteId);
  expect(p.t).toBe(t);
  expect(p.sample_utc).toBe(iso(s.times[i] ?? 0));
  expect(p.panel.azimuth_deg).toBe(at('sun_az_deg'));
  expect(p.panel.compass).toEqual(compassPoint(at('sun_az_deg') as number));
  expect(p.panel.tilt_from_vertical_deg).toBe(at('sun_el_deg'));
  expect(p.panel.panel_normal_elevation_deg).toBe(at('sun_el_deg'));
  expect(p.panel.tilt_from_horizontal_deg).toBeCloseTo(90 - (at('sun_el_deg') as number), 6);
  expect(p.panel.sun_visible).toBe(at('sun_visible'));
  expect(p.panel.sun_fraction).toBe(at('sun_fraction'));
  expect(p.panel.sun_clearance_deg).toBe(at('sun_clearance_deg'));
  expect(p.panel.power_tracking).toBe(at('power_tracking'));
  expect(p.panel.power_horizontal).toBe(at('power_horizontal'));
  expect(p.panel.irradiance_tracking_wm2).toBe(at('irradiance_tracking_wm2'));
  expect(p.antenna.azimuth_deg).toBe(at('earth_az_deg'));
  expect(p.antenna.compass).toEqual(compassPoint(at('earth_az_deg') as number));
  expect(p.antenna.elevation_deg).toBe(at('earth_el_deg'));
  expect(p.antenna.earth_visible).toBe(at('earth_visible'));
  expect(p.antenna.clearance_deg).toBe(at('earth_clearance_deg'));
  expect(p.antenna.distance_km).toBe(at('earth_dist_km'));
  const ins = await instant(siteId, t);
  const ev = ins.next_events;
  expect(ev).toBeTruthy();
  if (!ev) return p;
  const exp = (e: (typeof ev)['sunset']) => (e.lower_bound ? { h: null, at: null } : { h: e.hours, at: e.at });
  expect({ h: p.panel.hours_until_sunset, at: p.panel.sunset_utc }).toEqual(exp(ev.sunset));
  expect({ h: p.panel.hours_until_sunrise, at: p.panel.sunrise_utc }).toEqual(exp(ev.sunrise));
  expect({ h: p.antenna.hours_until_earthset, at: p.antenna.earthset_utc }).toEqual(exp(ev.earthset));
  expect({ h: p.antenna.hours_until_earthrise, at: p.antenna.earthrise_utc }).toEqual(exp(ev.earthrise));
  expect(p.hours_to_run_end).toBeCloseTo((Date.parse('2026-04-01T00:00:00Z') - Date.parse(t)) / 3_600_000, 6);
  return p;
}

describe.skipIf(!hasSample())('GET /sites/{site_id}/pointing (real sample run)', () => {
  beforeAll(async () => {
    ctx = await startTestApp();
    sample = await loadSampleRun(getDb());
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('lit instant mid-sample: panel / antenna = the sample columns, times = /instant next_events', async () => {
    const s = site(RIDGE);
    const i = col(s, 'sun_visible').findIndex((v, k) => v === true && col(s, 'earth_visible')[k] === true && k > 5);
    expect(i).toBeGreaterThan(0);
    const p = await crossCheck(RIDGE, i, 30);
    expect(p.panel.sun_visible).toBe(true);
    expect(p.panel.hours_until_sunrise).toBe(0);
    expect(p.summary.en).toContain(`face ${p.panel.compass.code} (${p.panel.compass.en}`);
    expect(p.summary.vi).toContain(`quay về hướng ${p.panel.compass.vi}`);
    expect(p.run_id).toBe(sample.run_id);
    expect(p.step_s).toBe(3600);
    expect(p.assumptions.length).toBeGreaterThanOrEqual(5);
    expect(p.assumptions.join(' ')).toContain(`${sample.run.observer_height_m} m mast`);
  });

  it('dark instant and Earth-hidden instant on every site that has them', async () => {
    let nDark = 0;
    let nNoEarth = 0;
    for (const id of sample.sites.keys()) {
      const s = site(id);
      const iDark = col(s, 'sun_visible').findIndex((v) => v === false);
      if (iDark >= 0) {
        const p = await crossCheck(id, iDark);
        expect(p.panel.sun_visible).toBe(false);
        expect(p.panel.hours_until_sunset).toBe(0);
        if (TERRAIN_SITES.has(id)) {
          expect(p.summary.en).toContain('the Sun is hidden by the terrain');
          expect(p.summary.vi).toContain('Mặt Trời đang bị địa hình che');
        } else {
          // flat horizon (outside the DEM): never claims terrain
          expect(p.summary.en).toContain('the Sun is below the flat horizon');
          expect(p.summary.en).not.toMatch(/terrain/i);
          expect(p.assumptions.join(' ')).toContain('IDEAL FLAT horizon');
        }
        nDark++;
      }
      const iNoEarth = col(s, 'earth_visible').findIndex((v) => v === false);
      if (iNoEarth >= 0) {
        const p = await crossCheck(id, iNoEarth, 59);
        expect(p.antenna.earth_visible).toBe(false);
        expect(p.summary.en).toContain(TERRAIN_SITES.has(id) ? 'the Earth is below the terrain horizon' : 'the Earth is below the flat horizon');
        nNoEarth++;
      }
    }
    expect(nDark).toBeGreaterThan(0);
    expect(nNoEarth).toBeGreaterThan(0);
  });

  it('partly visible Sun on the real sample: "grazing" + visible % + output %, never a negative "above the terrain"', async () => {
    let n = 0;
    let nLean = 0;
    for (const id of sample.sites.keys()) {
      const s = site(id);
      const frac = col(s, 'sun_fraction');
      const clr = col(s, 'sun_clearance_deg');
      const el = col(s, 'sun_el_deg');
      const i = frac.findIndex((f, k) => typeof f === 'number' && f > 0 && f < 0.5 && (clr[k] as number) < 0);
      if (i >= 0) {
        const p = await crossCheck(id, i);
        expect(p.panel.sun_visible).toBe(true);
        expect(p.panel.sun_clearance_deg).toBeLessThan(0);
        const pctVis = `${(100 * (frac[i] as number)) < 10 ? Number((100 * (frac[i] as number)).toFixed(1)) : Math.round(100 * (frac[i] as number))} %`;
        if (TERRAIN_SITES.has(id)) {
          expect(p.summary.en).toContain(`the Sun is grazing the terrain: only ${pctVis} of the disc is visible`);
          expect(p.summary.en).toContain('below the ridge), panel output ~');
          expect(p.summary.vi).toContain(`Mặt Trời sát địa hình: chỉ ${pctVis} đĩa Mặt Trời lộ ra`);
        } else {
          expect(p.summary.en).toContain(`the Sun is grazing the horizon: only ${pctVis} of the disc is visible`);
          expect(p.summary.vi).toContain(`Mặt Trời sát đường chân trời: chỉ ${pctVis} đĩa Mặt Trời lộ ra`);
        }
        expect(p.summary.en).not.toMatch(/-[\d.]+° above/);
        expect(p.summary.vi).not.toMatch(/cao hơn địa hình -/);
        n++;
      }
      const j = col(s, 'sun_visible').findIndex((v, k) => v === true && (el[k] as number) < 0);
      if (j >= 0) {
        const p = await crossCheck(id, j);
        expect(p.summary.en).toContain('leaning forward ');
        expect(p.summary.en).not.toContain('tilted back -');
        expect(p.summary.vi).toContain('nghiêng về phía trước ');
        nLean++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(3);
    expect(nLean).toBeGreaterThanOrEqual(1);
  });

  it('first and last sample of the run', async () => {
    await crossCheck(RIDGE, 0);
    const s = site(RIDGE);
    const p = await crossCheck(RIDGE, s.times.length - 1, 59);
    expect(p.hours_to_run_end).toBeCloseTo(1 / 60, 6);
  });

  it('ETag + Cache-Control; run_id pins the run', async () => {
    const t = '2026-02-01T12:00:00Z';
    const a = await pointing(RIDGE, `?t=${t}`);
    expect(a.headers['etag']).toMatch(/^W\/"/);
    expect(a.headers['cache-control']).toBe('public, max-age=60');
    const again = await ctx.app.inject({ method: 'GET', url: `${API}/sites/${RIDGE}/pointing?t=${t}`, headers: { 'if-none-match': String(a.headers['etag']) } });
    expect(again.statusCode).toBe(304);
    const pinned = await pointing(RIDGE, `?t=${t}&run_id=${sample.run_id}`);
    expect(pinned.headers['cache-control']).toBe('public, max-age=3600');
    expect(PointingResponse.parse(pinned.json()).panel).toEqual(PointingResponse.parse(a.json()).panel);
    const other = await pointing(RIDGE, '?t=2026-02-01T13:00:00Z');
    expect(other.headers['etag']).not.toBe(a.headers['etag']);
  });

  it('errors are problem+json: t outside the run 422, unknown site 404, bad / missing t 400, unknown run 404, unknown param 400', async () => {
    const cases: [string, string, number, string][] = [
      [RIDGE, '?t=2026-04-01T00:00:00Z', 422, 'OUT_OF_RANGE'],
      [RIDGE, '?t=2025-12-31T23:59:59Z', 422, 'OUT_OF_RANGE'],
      ['no_such_site', '?t=2026-02-01T00:00:00Z', 404, 'SITE_NOT_FOUND'],
      [RIDGE, '?t=2026-02-30T00:00:00Z', 400, 'VALIDATION_ERROR'],
      [RIDGE, '', 400, 'VALIDATION_ERROR'],
      [RIDGE, '?t=2026-02-01T00:00:00Z&run_id=nope', 404, 'RUN_NOT_FOUND'],
      [RIDGE, '?t=2026-02-01T00:00:00Z&foo=1', 400, 'VALIDATION_ERROR'],
    ];
    for (const [id, q, status, code] of cases) {
      const res = await pointing(id, q, status);
      expect(res.headers['content-type'], q).toContain('application/problem+json');
      expect(Problem.parse(res.json()).code, q).toBe(code);
    }
  });
});
