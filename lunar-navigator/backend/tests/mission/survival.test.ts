/**
 * POST /api/v1/mission/survival on the REAL sample run (tests/fixtures/sample_2026Q1_spice_pgda, 6 sites,
 * 2026-01-01..2026-04-01 hourly) loaded into a throw-away MongoDB 8.0. The SOC curve is re-derived here
 * independently from the visibility.csv.gz columns, and the energy totals are cross-checked against the
 * series' own irradiance_tracking_wm2 / power_horizontal columns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SurvivalResponse, type SurvivalRequest } from '../../src/contract/mission.ts';
import { Problem } from '../../src/lib/problem.ts';
import { getDb } from '../../src/db.ts';
import { startTestApp, type TestContext } from '../helpers.ts';
import { hasSample, loadSampleRun, type SampleRun, type SampleSite } from '../routes/b/data.ts';

const URL = '/api/v1/mission/survival';
const RIDGE = 'ref_connecting_ridge_c1';
const HAWORTH = 'a3_haworth';
const AU_KM = 149_597_870.7;
let ctx: TestContext;
let sample: SampleRun;

type Body = Partial<SurvivalRequest> & Record<string, unknown>;
const ref: Body = { site_id: RIDGE, landing_utc: '2026-01-01T00:00:00Z', mission_h: 720, battery_wh: 3000, night_load_w: 30, panel_peak_w: 200, panel_mode: 'tracking' };

async function post(body: Body, status = 200) {
  const res = await ctx.app.inject({ method: 'POST', url: URL, payload: body });
  expect(res.statusCode, res.body).toBe(status);
  return res;
}
const ok = async (body: Body): Promise<SurvivalResponse> => SurvivalResponse.parse((await post(body)).json());
const site = (id: string): SampleSite => {
  const s = sample.sites.get(id);
  if (!s) throw new Error(`no sample site ${id}`);
  return s;
};
const col = (s: SampleSite, f: string, i0: number, n: number) => (s.columns as Record<string, (number | boolean | null)[]>)[f]?.slice(i0, i0 + n) ?? [];

/** Independent naive re-implementation: hourly, tracking or horizontal, solar-distance irradiance. */
function naiveSoc(s: SampleSite, i0: number, n: number, b: { battery_wh: number; load_w: number; day_load_w?: number; panel_w: number; mode: 'tracking' | 'horizontal' }) {
  const frac = col(s, 'sun_fraction', i0, n) as number[];
  const ph = col(s, 'power_horizontal', i0, n) as number[];
  const dist = col(s, 'sun_dist_km', i0, n) as number[];
  const vis = col(s, 'sun_visible', i0, n) as boolean[];
  const soc = [b.battery_wh];
  let e = b.battery_wh;
  let eIn = 0;
  for (let k = 0; k < n; k++) {
    const factor = b.mode === 'tracking' ? (frac[k] ?? 0) : (ph[k] ?? 0);
    const pin = b.panel_w * factor * (AU_KM / (dist[k] ?? AU_KM)) ** 2;
    eIn += pin;
    const load = vis[k] ? (b.day_load_w ?? b.load_w) : b.load_w;
    e = Math.min(b.battery_wh, Math.max(0, e + pin - load));
    soc.push(e);
  }
  return { soc, eIn };
}

describe.skipIf(!hasSample())('POST /mission/survival on the sample run', () => {
  beforeAll(async () => {
    ctx = await startTestApp();
    sample = await loadSampleRun(getDb());
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('reference ridge, 30 days, 3 kWh, 30 W night load, 200 W tracking: matches an independent re-computation', async () => {
    const r = await ok({ ...ref, max_points: 5000 });
    expect(r.run_id).toBe(sample.run_id);
    expect(r.n_steps).toBe(720);
    expect(r.mission_end_utc).toBe('2026-01-31T00:00:00Z');
    expect(r.inputs.day_load_w).toBe(30);
    expect(r.timeline.decimated).toBe(false);
    expect(r.timeline.t).toHaveLength(721);
    const s = site(RIDGE);
    const n = naiveSoc(s, 0, 720, { battery_wh: 3000, load_w: 30, panel_w: 200, mode: 'tracking' });
    r.timeline.soc_wh.forEach((v, i) => expect(v, `soc ${i}`).toBeCloseTo(n.soc[i] ?? Number.NaN, 2));
    expect(r.energy_in_wh).toBeCloseTo(n.eIn, 2);
    // same totals from the stored irradiance column: P = panel * irradiance_tracking_wm2 / 1361 (column rounded to 0.01 W/m2)
    const irr = (col(s, 'irradiance_tracking_wm2', 0, 720) as number[]).reduce((a, x) => a + x, 0);
    expect(Math.abs(r.energy_in_wh - (200 * irr) / 1361)).toBeLessThan(720 * 200 * (0.005 / 1361) + 1e-6);
    expect(r.energy_out_wh).toBe(30 * 720);
    // energy balance identity
    expect(r.end_soc_wh - 3000).toBeCloseTo(r.energy_in_wh - r.energy_curtailed_wh - (r.energy_out_wh - r.energy_unserved_wh), 2);
    // longest night = longest run of sun_visible false in the mission
    const vis = col(s, 'sun_visible', 0, 720) as boolean[];
    let best = 0;
    let cur = 0;
    for (const v of vis) {
      cur = v ? 0 : cur + 1;
      best = Math.max(best, cur);
    }
    expect(r.longest_dark_h).toBe(best);
    expect(r.longest_no_input_h).toBeGreaterThanOrEqual(r.longest_dark_h);
    expect(r.survived).toBe(r.min_soc_wh > 0 || r.hours_below_min === 0);
    expect(r.verdict.vi.length).toBeGreaterThan(10);
    expect(r.verdict.en.length).toBeGreaterThan(10);
    expect(r.assumptions.length).toBeGreaterThanOrEqual(8);
    expect(Math.min(...r.timeline.soc_wh)).toBeCloseTo(r.min_soc_wh, 3);
  });

  it('a failing site: required_battery_wh is exact (survives at it, dies 1 % below) and the verdict says when', async () => {
    // Haworth (crater floor near the pole): long nights -> 1 kWh, 60 W is not enough
    const body: Body = { ...ref, site_id: HAWORTH, battery_wh: 1000, night_load_w: 60, landing_utc: '2026-01-10T00:00:00Z' };
    const r = await ok(body);
    expect(r.survived).toBe(false);
    expect(r.first_depletion_utc).not.toBeNull();
    expect(r.n_depletions).toBeGreaterThanOrEqual(1);
    expect(r.hours_below_min).toBeGreaterThan(0);
    expect(r.energy_unserved_wh).toBeGreaterThan(0);
    expect(r.min_soc_wh).toBe(0);
    expect(r.verdict.vi).toMatch(/^Thiếu điện: hết pin lúc .* cần pin >= /);
    expect(r.verdict.en).toMatch(/^Out of energy: battery empty at .* needs a battery >= /);
    // initial 100 %, reserve 0 %: no landing-charge condition, full-start size = required size
    expect(r.verdict.en).not.toContain('at landing');
    expect(r.required_battery_full_start_wh).toBe(r.required_battery_wh);
    const req = r.required_battery_wh;
    expect(req).not.toBeNull();
    expect(req).toBeGreaterThan(1000);
    expect((await ok({ ...body, battery_wh: req ?? 0 })).survived).toBe(true);
    expect((await ok({ ...body, battery_wh: (req ?? 0) * 0.99 })).survived).toBe(false);
    // a bigger panel that survives, if any
    if (r.required_panel_peak_w !== null) {
      expect((await ok({ ...body, panel_peak_w: r.required_panel_peak_w })).survived).toBe(true);
      expect((await ok({ ...body, panel_peak_w: Math.max(0, r.required_panel_peak_w - 0.5) })).survived).toBe(false);
    }
  });

  it('verdict is qualified: "Energy OK (power balance only ...)", never an outright "survives"', async () => {
    const r = await ok({ ...ref, site_id: 'ref_shackleton_rim', landing_utc: '2026-02-12T09:00:00Z', mission_h: 48, battery_wh: 3000 });
    expect(r.survived).toBe(true);
    expect(r.verdict.en).toMatch(/^Energy OK \(power balance only, no thermal\/dust model\): battery lowest /);
    expect(r.verdict.vi).toMatch(/^Đủ điện \(chỉ tính cân bằng năng lượng, chưa mô hình nhiệt\/bụi\): pin thấp nhất /);
    expect(r.verdict.en).not.toMatch(/surviv/i);
    expect(r.assumptions.join(' ')).toContain('ENERGY BALANCE ONLY');
    expect(r.assumptions.join(' ')).toContain('terrain shadowing');
  });

  it('a part-charged landing: the battery size states the landing charge and gives the full-at-landing size', async () => {
    // probe case of the review: 48 h, 30 W, 200 W tracking; 100 % -> ~375 Wh is enough
    const base: Body = { ...ref, site_id: 'ref_shackleton_rim', landing_utc: '2026-02-12T09:00:00Z', mission_h: 48, battery_wh: 3000 };
    const full = await ok(base);
    const low = await ok({ ...base, initial_soc_pct: 5 });
    expect(low.survived).toBe(false);
    expect(low.required_battery_wh).not.toBeNull();
    expect(low.required_battery_wh ?? 0).toBeGreaterThan(10 * (full.required_battery_wh ?? 0));
    // full-start size of the part-charged request = required size of the full request (same loads / panel / reserve)
    expect(low.required_battery_full_start_wh).toBeCloseTo(full.required_battery_wh ?? -1, 3);
    expect(full.required_battery_full_start_wh).toBe(full.required_battery_wh);
    expect(low.verdict.en).toMatch(/needs a battery >= [\d.]+ kWh \(charged to 5 % at landing, 0 % reserve; fully charged at landing: >= \d+ Wh\)/);
    expect(low.verdict.vi).toMatch(/cần pin >= [\d.]+ kWh \(nếu chỉ sạc 5 % lúc hạ cánh, 0 % dự trữ; nếu sạc đầy lúc hạ cánh: cần pin >= \d+ Wh\)/);
    // a battery of required_battery_full_start_wh charged full survives
    expect((await ok({ ...base, battery_wh: low.required_battery_full_start_wh })).survived).toBe(true);
    // reserve only (landing full): the condition names the reserve
    const res = await ok({ ...base, battery_wh: 100, min_soc_pct: 20 });
    expect(res.survived).toBe(false);
    expect(res.verdict.en).toMatch(/^Out of energy: battery below the 20 % reserve at /);
    expect(res.verdict.en).toContain('(20 % reserve kept)');
    expect(res.verdict.vi).toContain('(giữ 20 % dự trữ)');
  });

  it('horizontal panel uses power_horizontal; vertical panel facing away from the Sun produces less than facing it', async () => {
    const s = site(RIDGE);
    const h = await ok({ ...ref, panel_mode: 'horizontal' });
    const n = naiveSoc(s, 0, 720, { battery_wh: 3000, load_w: 30, panel_w: 200, mode: 'horizontal' });
    expect(h.energy_in_wh).toBeCloseTo(n.eIn, 2);
    const t = await ok(ref);
    expect(h.energy_in_wh).toBeLessThan(t.energy_in_wh);
    const az = col(s, 'sun_az_deg', 0, 1)[0] as number;
    const facing = await ok({ ...ref, panel_mode: 'vertical_fixed', panel_azimuth_deg: Math.round(az) % 360 });
    const away = await ok({ ...ref, panel_mode: 'vertical_fixed', panel_azimuth_deg: (Math.round(az) + 180) % 360 });
    expect(facing.energy_in_wh).toBeGreaterThan(0);
    expect(facing.energy_in_wh).toBeLessThanOrEqual(t.energy_in_wh + 1e-6);
    expect(facing.inputs.panel_azimuth_deg).toBe(Math.round(az) % 360);
    expect(away.energy_in_wh).toBeLessThan(t.energy_in_wh);
  });

  it('constant irradiance vs solar distance; landing snapped down; reserve and day load', async () => {
    const c = await ok({ ...ref, irradiance: 'constant' });
    const d = await ok(ref);
    expect(c.energy_in_wh).not.toBeCloseTo(d.energy_in_wh, 0); // January: Moon near perihelion, ~3 % more
    const snapped = await ok({ ...ref, landing_utc: '2026-01-01T00:59:59.5Z' });
    expect(snapped.landing_utc).toBe('2026-01-01T00:00:00Z');
    const reserve = await ok({ ...ref, min_soc_pct: 20, initial_soc_pct: 80, day_load_w: 50 });
    expect(reserve.inputs).toMatchObject({ min_soc_pct: 20, initial_soc_pct: 80, day_load_w: 50, min_soc_wh: 600 });
    expect(reserve.timeline.soc_wh[0]).toBe(2400);
    expect(reserve.energy_out_wh).toBeGreaterThan(d.energy_out_wh);
  });

  it('timeline decimation keeps the minimum and stays within max_points', async () => {
    const r = await ok({ ...ref, site_id: HAWORTH, battery_wh: 1500, night_load_w: 40, mission_h: 2000, max_points: 60 });
    expect(r.timeline.decimated).toBe(true);
    expect(r.timeline.n_full).toBe(2001);
    expect(r.timeline.t.length).toBeLessThanOrEqual(60);
    expect(r.timeline.t[0]).toBe(r.landing_utc);
    expect(r.timeline.t.at(-1)).toBe(r.mission_end_utc);
    expect(Math.min(...r.timeline.soc_wh)).toBeCloseTo(r.min_soc_wh, 3);
  });

  it('validation: 422 OUT_OF_RANGE / BAD_MISSION_LENGTH, 400 for bad bodies, 404 unknown site', async () => {
    const problem = async (body: Body, status: number, code: string) => {
      const res = await post(body, status);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const p = Problem.parse(res.json());
      expect(p.code).toBe(code);
      return p;
    };
    await problem({ ...ref, landing_utc: '2025-12-31T23:00:00Z' }, 422, 'OUT_OF_RANGE');
    await problem({ ...ref, landing_utc: '2026-04-01T00:00:00Z' }, 422, 'OUT_OF_RANGE');
    const late = await problem({ ...ref, landing_utc: '2026-03-20T00:00:00Z' }, 422, 'OUT_OF_RANGE');
    expect(late['max_mission_h']).toBe(12 * 24);
    await problem({ ...ref, mission_h: 1.5 }, 422, 'BAD_MISSION_LENGTH');
    await problem({ ...ref, mission_h: 9000 }, 400, 'VALIDATION_ERROR');
    await problem({ ...ref, battery_wh: 0 }, 400, 'VALIDATION_ERROR');
    await problem({ ...ref, night_load_w: -1 }, 400, 'VALIDATION_ERROR');
    await problem({ ...ref, panel_mode: 'vertical_fixed' }, 400, 'VALIDATION_ERROR');
    await problem({ ...ref, panel_azimuth_deg: 90 }, 400, 'VALIDATION_ERROR');
    const soc = await problem({ ...ref, initial_soc_pct: 10, min_soc_pct: 20 }, 400, 'VALIDATION_ERROR');
    expect(soc.errors?.[0]?.path).toBe('initial_soc_pct');
    await problem({ ...ref, extra: 1 }, 400, 'VALIDATION_ERROR');
    await problem({ ...ref, landing_utc: '2026-02-30T00:00:00Z' }, 400, 'VALIDATION_ERROR');
    await problem({ ...ref, site_id: 'nope' }, 404, 'SITE_NOT_FOUND');
    await problem({ ...ref, run_id: 'pf_nope' }, 404, 'RUN_NOT_FOUND');
  });
});
