/**
 * A (POST /mission/survival) and C (GET /dataset include=survival_hint) use ONE energy model
 * (src/mission/energy.ts). On the REAL sample run (throw-away MongoDB 8.0), for every site and several
 * ranges [landing, landing + mission_h):
 *   - survival.longest_dark_h                  = dataset survival_hint.longest_dark_h (= metrics.longest_dark_h)
 *   - survival.required_battery_night_only_wh  = dataset survival_hint.required_battery_wh (same night_load_w)
 *   - survival with an unlimited panel (1e7 W), day load 0, 100 % start, 0 % reserve: required_battery_wh = that value too
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatasetResponse } from '../../src/contract/dataset.ts';
import { SurvivalResponse } from '../../src/contract/mission.ts';
import { getDb } from '../../src/db.ts';
import { importRun } from '../../src/importer/importRun.ts';
import { startTestApp, type TestContext } from '../helpers.ts';
import { CATALOG_PATH, SAMPLE_DIR, SAMPLE_RUN_ID } from '../sample.ts';

let ctx: TestContext;
const H = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

beforeAll(async () => {
  ctx = await startTestApp();
  const res = await importRun(getDb(), { dir: SAMPLE_DIR, check: false, dataDir: null, catalogPath: CATALOG_PATH, setDefault: true });
  expect(res.run_id).toBe(SAMPLE_RUN_ID);
}, 600_000);
afterAll(async () => {
  await ctx?.close();
});

async function dataset(start: string, end: string, load: number) {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/dataset?start=${start}&end=${end}&include=metrics,survival_hint&night_load_w=${load}` });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return DatasetResponse.parse(res.json());
}
async function survival(body: Record<string, unknown>) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/mission/survival', payload: body });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return SurvivalResponse.parse(res.json());
}

describe('one energy model: /mission/survival vs /dataset survival_hint', () => {
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const ranges: [number, number][] = [
    [0, 720],
    [100, 500],
    [1000, 1160],
  ];
  for (const [offH, lenH] of ranges) {
    it(`range +${offH} h, ${lenH} h, night load 37.5 W: same longest night and same night-only battery at every site`, async () => {
      const start = iso(T0 + offH * H);
      const end = iso(T0 + (offH + lenH) * H);
      const ds = await dataset(start, end, 37.5);
      expect(ds.sites.length).toBeGreaterThan(0);
      let nNights = 0;
      for (const s of ds.sites) {
        const h = s.survival_hint;
        if (!h) continue;
        const base = { site_id: s.id, landing_utc: start, mission_h: lenH, battery_wh: 1000, night_load_w: 37.5 };
        const a = await survival({ ...base, panel_peak_w: 150, day_load_w: 20, panel_mode: 'horizontal' });
        expect(a.longest_dark_h, s.id).toBe(h.longest_dark_h);
        expect(a.longest_dark_h, s.id).toBe(s.metrics?.longest_dark_h);
        expect(a.required_battery_night_only_wh, s.id).toBe(h.required_battery_wh);
        // the night-only value is A's own required_battery_wh in the unlimited-panel limit
        const inf = await survival({ ...base, panel_peak_w: 1e7, day_load_w: 0, panel_mode: 'tracking' });
        expect(inf.required_battery_night_only_wh, s.id).toBe(h.required_battery_wh);
        expect(inf.required_battery_wh ?? Number.NaN, s.id).toBeCloseTo(h.required_battery_wh ?? Number.NaN, 2);
        if (h.longest_dark_h > 0) nNights++;
      }
      if (offH === 0) expect(nNights).toBeGreaterThan(0);
    });
  }
});
