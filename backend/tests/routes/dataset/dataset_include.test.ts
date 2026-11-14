/**
 * GET /api/v1/dataset - the opt-in parts include=pointing (sites[].now) and include=survival_hint, and
 * the metrics energy proxies mean_power_*_pct, on the REAL sample run imported with the real importer
 * into a throw-away MongoDB 8.0. Cross-checks against summary.csv, visibility.csv.gz, windows.json and
 * GET /sites/{site_id}/pointing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatasetResponse } from '../../../src/contract/dataset.ts';
import { Problem } from '../../../src/lib/problem.ts';
import { getDb } from '../../../src/db.ts';
import { importRun } from '../../../src/importer/importRun.ts';
import { startTestApp, type TestContext } from '../../helpers.ts';
import { CATALOG_PATH, SAMPLE_DIR, SAMPLE_RUN_ID } from '../../sample.ts';
import { terrainModelled } from '../../../src/contract/pointing.ts';

const API = '/api/v1';
const RIDGE = 'ref_connecting_ridge_c1';
const H = 3_600_000;

interface FileWindow {
  start: string;
  end: string;
  duration_h: number;
  state: boolean;
  truncated_start: boolean;
  truncated_end: boolean;
}
interface SiteFileRecord {
  id: string;
  horizon_method: string;
  dem_source: string;
  files: { visibility: string; windows: string };
}
const SITES = (JSON.parse(readFileSync(path.join(SAMPLE_DIR, 'sites.json'), 'utf8')) as { sites: SiteFileRecord[] }).sites;
const site = (id: string): SiteFileRecord => {
  const s = SITES.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};
const windowsFile = (id: string) => JSON.parse(readFileSync(path.join(SAMPLE_DIR, site(id).files.windows), 'utf8')) as { sun: FileWindow[] };
const rowsCache = new Map<string, Record<string, string>[]>();
const visibilityRows = (id: string): Record<string, string>[] => {
  let r = rowsCache.get(id);
  if (!r) {
    r = parse(gunzipSync(readFileSync(path.join(SAMPLE_DIR, site(id).files.visibility))).toString('utf8'), { columns: true }) as Record<string, string>[];
    rowsCache.set(id, r);
  }
  return r;
};
const SUMMARY_POWER = (parse(readFileSync(path.join(SAMPLE_DIR, 'summary.csv'), 'utf8'), { columns: true }) as Record<string, string>[]).map((r) => ({
  site_id: r['site_id'] ?? '',
  mean_power_tracking: Number(r['mean_power_tracking']),
  mean_power_horizontal: Number(r['mean_power_horizontal']),
}));
const bool = (s: string | undefined): boolean => s === '1' || s === 'True' || s === 'true';
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

let ctx: TestContext;

async function getDataset(query: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `${API}/dataset${query}` });
  expect(res.statusCode, res.body.slice(0, 500)).toBe(200);
  const parsed = DatasetResponse.safeParse(res.json());
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  return { body: parsed.data as DatasetResponse, headers: res.headers };
}

beforeAll(async () => {
  ctx = await startTestApp();
  const res = await importRun(getDb(), { dir: SAMPLE_DIR, check: false, dataDir: null, catalogPath: CATALOG_PATH, setDefault: true });
  expect(res.run_id).toBe(SAMPLE_RUN_ID);
}, 600_000);

afterAll(async () => {
  await ctx?.close();
});

describe('GET /dataset - metrics energy proxies', () => {
  it('default include is unchanged: no now / survival_hint / assumptions / night_load_w', async () => {
    const { body } = await getDataset(`?site_ids=${RIDGE}`);
    expect(body.include).toEqual(['horizon', 'series', 'windows', 'metrics', 'criteria']);
    expect(body.assumptions).toBeUndefined();
    expect(body.night_load_w).toBeUndefined();
    expect(body.sites[0]?.now).toBeUndefined();
    expect(body.sites[0]?.survival_hint).toBeUndefined();
  });

  it('whole run: mean_power_*_pct = 100 x summary.csv mean_power_* (6-decimal fractions)', async () => {
    const { body } = await getDataset('?include=metrics');
    expect(body.sites).toHaveLength(SUMMARY_POWER.length);
    for (const row of SUMMARY_POWER) {
      const m = body.sites.find((s) => s.id === row.site_id)?.metrics;
      expect(m, row.site_id).toBeTruthy();
      if (!m) continue;
      expect(Math.abs((m.mean_power_tracking_pct ?? -1) - 100 * row.mean_power_tracking), row.site_id).toBeLessThanOrEqual(1e-4 + 1e-9);
      expect(Math.abs((m.mean_power_horizontal_pct ?? -1) - 100 * row.mean_power_horizontal), row.site_id).toBeLessThanOrEqual(1e-4 + 1e-9);
    }
  });

  it('sub-range: mean_power_*_pct = 100 x the mean of the visibility.csv.gz columns over [start, end)', async () => {
    const start = '2026-02-03T05:00:00Z';
    const end = '2026-02-17T17:00:00Z';
    const { body } = await getDataset(`?site_ids=${RIDGE},a3_haworth&start=${start}&end=${end}&include=metrics`);
    for (const s of body.sites) {
      const rows = visibilityRows(s.id).filter((r) => {
        const t = Date.parse(r['time_utc'] ?? '');
        return t >= Date.parse(start) && t < Date.parse(end);
      });
      expect(rows).toHaveLength(body.range.n_samples);
      const mean = (f: string): number => (100 * rows.reduce((a, r) => a + Number(r[f]), 0)) / rows.length;
      expect(s.metrics?.mean_power_tracking_pct).toBeCloseTo(mean('power_tracking'), 4);
      expect(s.metrics?.mean_power_horizontal_pct).toBeCloseTo(mean('power_horizontal'), 4);
    }
  });
});

describe('GET /dataset - include=pointing', () => {
  it('sites[].now = GET /sites/{id}/pointing at range.start; assumptions.pointing = its assumptions', async () => {
    const { body } = await getDataset('?start=2026-02-10T07:20:00Z&end=2026-02-12T00:00:00Z&include=pointing'); // start snapped down to 07:00
    expect(body.include).toEqual(['pointing']);
    expect(body.range.start).toBe('2026-02-10T07:00:00Z');
    expect(body.assumptions?.pointing?.length).toBeGreaterThanOrEqual(5);
    expect(body.assumptions?.survival_hint).toBeUndefined();
    expect(body.night_load_w).toBeUndefined();
    expect(body.sites).toHaveLength(SITES.length);
    for (const s of body.sites) {
      expect(Object.keys(s).sort()).toEqual(['coverage', 'coverage_in_range', 'group', 'id', 'lat_deg', 'lon_deg', 'name', 'now', 'surface_height_m']);
      const res = await ctx.app.inject({ method: 'GET', url: `${API}/sites/${encodeURIComponent(s.id)}/pointing?t=${body.range.start}` });
      expect(res.statusCode).toBe(200);
      const { run_id: _r, step_s: _s, precision_h: _p, site_id: _id, assumptions, ...core } = res.json() as Record<string, unknown>;
      expect(s.now, s.id).toEqual(core);
      const rec = site(s.id);
      if (terrainModelled(rec.horizon_method, rec.dem_source)) {
        // run-level assumptions (+ a note naming the flat-horizon sites) start with this site's assumptions
        expect(body.assumptions?.pointing?.slice(0, (assumptions as string[]).length)).toEqual(assumptions);
      } else {
        expect((assumptions as string[]).join(' ')).toContain('IDEAL FLAT horizon');
        expect(s.now?.summary.en).not.toMatch(/terrain/i);
        expect(body.assumptions?.pointing?.at(-1)).toContain(s.id);
      }
      expect(s.now?.t).toBe('2026-02-10T07:00:00Z');
      expect(s.now?.sample_utc).toBe('2026-02-10T07:00:00Z');
      const row = visibilityRows(s.id).find((r) => r['time_utc'] === '2026-02-10T07:00:00Z');
      expect(s.now?.panel.azimuth_deg).toBe(Number(row?.['sun_az_deg']));
      expect(s.now?.panel.tilt_from_vertical_deg).toBe(Number(row?.['sun_el_deg']));
      expect(s.now?.antenna.azimuth_deg).toBe(Number(row?.['earth_az_deg']));
      expect(s.now?.antenna.elevation_deg).toBe(Number(row?.['earth_el_deg']));
      expect(s.now?.panel.sun_visible).toBe(bool(row?.['sun_visible']));
      expect(s.now?.antenna.earth_visible).toBe(bool(row?.['earth_visible']));
    }
  });
});

describe('GET /dataset - include=survival_hint', () => {
  it('longest dark = metrics.longest_dark_h = a dark window of windows.json; required battery = night_load_w x longest dark', async () => {
    const { body } = await getDataset('?include=metrics,survival_hint&night_load_w=50');
    expect(body.night_load_w).toBe(50);
    expect(body.assumptions?.survival_hint?.join(' ')).toContain('night_load_w x longest_dark_h');
    expect(body.assumptions?.pointing).toBeUndefined();
    let nNights = 0;
    for (const s of body.sites) {
      const h = s.survival_hint;
      expect(h, s.id).toBeTruthy();
      if (!h || !s.metrics) continue;
      expect(h.longest_dark_h).toBe(s.metrics.longest_dark_h);
      expect(h.night_load_w).toBe(50);
      expect(h.required_battery_wh).toBeCloseTo(50 * h.longest_dark_h, 6);
      const dark = windowsFile(s.id).sun.filter((w) => !w.state);
      if (h.longest_dark_h > 0) {
        nNights++;
        const w = dark.find((x) => x.start === h.longest_dark_start);
        expect(w?.end).toBe(h.longest_dark_end);
        expect(w?.duration_h).toBe(h.longest_dark_h);
        expect(dark.every((x) => x.duration_h <= h.longest_dark_h)).toBe(true);
        expect(h.longest_dark_clipped).toBe(dark.some((x) => x.duration_h === h.longest_dark_h && (x.truncated_start || x.truncated_end)));
        expect(h.summary.en).toContain('A 50 W night load needs a battery of');
        expect(h.summary.vi).toContain('Tải ban đêm 50 W cần pin');
      } else {
        expect(dark).toHaveLength(0);
        expect(h.required_battery_wh).toBe(0);
      }
    }
    expect(nNights).toBeGreaterThan(0);
  });

  it('without night_load_w: hint present, battery null; night_load_w changes dataset_id + ETag only with survival_hint', async () => {
    const noLoad = await getDataset('?include=survival_hint');
    expect(noLoad.body.night_load_w).toBeNull();
    expect(noLoad.body.sites.every((s) => s.survival_hint?.required_battery_wh === null)).toBe(true);
    expect(noLoad.body.sites.some((s) => s.survival_hint?.summary.en.includes('Give night_load_w'))).toBe(true);
    const withLoad = await getDataset('?include=survival_hint&night_load_w=50');
    expect(withLoad.body.dataset_id).not.toBe(noLoad.body.dataset_id);
    expect(withLoad.headers['etag']).not.toBe(noLoad.headers['etag']);
    const a = await getDataset(`?site_ids=${RIDGE}&include=metrics`);
    const b = await getDataset(`?site_ids=${RIDGE}&include=metrics&night_load_w=50`);
    expect(b.body.dataset_id).toBe(a.body.dataset_id);
    expect(b.body.night_load_w).toBeUndefined();
  });

  it('a sub-range that cuts a night: clipped, lower-bound wording', async () => {
    const night = windowsFile(RIDGE).sun.find((w) => !w.state && w.duration_h >= 4 && !w.truncated_start);
    expect(night).toBeTruthy();
    if (!night) return;
    const mid = iso(Date.parse(night.start) + 2 * H);
    const { body } = await getDataset(`?site_ids=${RIDGE}&start=${mid}&end=${night.end}&include=survival_hint&night_load_w=10`);
    const h = body.sites[0]?.survival_hint;
    expect(h).toMatchObject({ longest_dark_h: night.duration_h - 2, longest_dark_start: mid, longest_dark_end: night.end, longest_dark_clipped: true });
    expect(h?.required_battery_wh).toBeCloseTo(10 * (night.duration_h - 2), 6);
    expect(h?.summary.en).toContain('at least');
  });

  it('bad night_load_w / include -> 400 problem+json; all parts together', async () => {
    // night_load_w 0 is valid (as POST /mission/survival): battery 0
    const zero = await getDataset(`?site_ids=${RIDGE}&include=survival_hint&night_load_w=0`);
    expect(zero.body.night_load_w).toBe(0);
    expect(zero.body.sites[0]?.survival_hint?.required_battery_wh).toBe(0);
    for (const q of ['?include=survival_hint&night_load_w=-5', '?include=survival_hint&night_load_w=abc', '?include=survival_hint&night_load_w=2000000', '?include=pointings']) {
      const res = await ctx.app.inject({ method: 'GET', url: `${API}/dataset${q}` });
      expect(res.statusCode, q).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(Problem.parse(res.json()).code, q).toBe('VALIDATION_ERROR');
    }
    const { body } = await getDataset(`?site_ids=${RIDGE}&end=2026-01-08T00:00:00Z&include=horizon,series,windows,metrics,criteria,pointing,survival_hint&night_load_w=25`);
    expect(body.include).toEqual(['horizon', 'series', 'windows', 'metrics', 'criteria', 'pointing', 'survival_hint']);
    const s = body.sites[0];
    expect(s?.now?.t).toBe('2026-01-01T00:00:00Z');
    expect(s?.survival_hint?.night_load_w).toBe(25);
    expect(s?.survival_hint?.longest_dark_h).toBe(s?.metrics?.longest_dark_h);
    expect(s?.metrics?.mean_power_tracking_pct).not.toBeNull();
    expect(body.assumptions?.pointing).toBeTruthy();
    expect(body.assumptions?.survival_hint).toBeTruthy();
  });
});
