/**
 * Unit tests of the pure energy model (src/mission/energy.ts) on synthetic series with KNOWN answers.
 * Base case: 100 W tracking panel, Sun 12 h on / 12 h off, 50 W load, 1 h steps.
 *   day  : +50 Wh/h (battery full -> curtailed)        night: -50 Wh/h -> 600 Wh per night
 */
import { describe, expect, it } from 'vitest';
import {
  AU_KM,
  decimateSoc,
  irradianceScale,
  longestDark,
  panelFactor,
  requiredBatteryWh,
  runBattery,
  simulate,
  type EnergyParams,
  type EnergySample,
} from '../../src/mission/energy.ts';

const lit = (on: boolean, extra: Partial<EnergySample> = {}): EnergySample => ({
  sun_az_deg: 90,
  sun_el_deg: on ? 10 : -5,
  sun_fraction: on ? 1 : 0,
  power_horizontal: on ? Math.sin((10 * Math.PI) / 180) : 0,
  sun_visible: on,
  sun_dist_km: AU_KM,
  ...extra,
});

/** `days` cycles of 12 h lit + 12 h dark (or dark first). */
function dayNight(days: number, darkFirst = false): EnergySample[] {
  const out: EnergySample[] = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) out.push(lit(darkFirst ? h >= 12 : h < 12));
  }
  return out;
}

const base: EnergyParams = {
  battery_wh: 1000,
  night_load_w: 50,
  day_load_w: 50,
  panel_peak_w: 100,
  panel_mode: 'tracking',
  panel_azimuth_deg: null,
  initial_soc_pct: 100,
  min_soc_pct: 0,
  irradiance: 'constant',
};

describe('energy model - 100 W panel, 12 h on / 12 h off, 50 W load', () => {
  it('exact SOC curve, totals and required capacity (start full, day first)', () => {
    const sim = simulate(dayNight(3), 1, base);
    const expected: number[] = [];
    for (let k = 0; k <= 72; k++) {
      const h = k % 24;
      const day = Math.floor(k / 24);
      if (k === 0) expected.push(1000);
      else if (h === 0) expected.push(400); // end of a night
      else if (h <= 12) expected.push(day === 0 ? 1000 : Math.min(1000, 400 + 50 * h));
      else expected.push(1000 - 50 * (h - 12));
    }
    expect([...sim.soc_wh]).toEqual(expected);
    expect(sim.survived).toBe(true);
    expect(sim.first_depletion_h).toBeNull();
    expect(sim.min_soc_wh).toBe(400);
    expect(sim.min_soc_h).toBe(24);
    expect(sim.end_soc_wh).toBe(400);
    expect(sim.energy_in_wh).toBe(3600);
    expect(sim.energy_out_wh).toBe(3600);
    expect(sim.energy_curtailed_wh).toBe(600);
    expect(sim.energy_unserved_wh).toBe(0);
    expect(sim.required_battery_wh).toBe(600);
    expect(sim.longest_dark_h).toBe(12);
    expect(sim.longest_dark_truncated).toBe(true); // the last (equally long) night ends with the mission: lower bound
    // smallest panel: day 1 is clamped full, then 2 * 12 * (P - 50) - 800 >= 0 -> P >= 83.33 W
    expect(sim.required_panel_peak_w).toBeGreaterThanOrEqual(83.33);
    expect(sim.required_panel_peak_w).toBeLessThanOrEqual(83.35);
    expect(simulate(dayNight(3), 1, { ...base, panel_peak_w: sim.required_panel_peak_w ?? 0 }).survived).toBe(true);
    expect(simulate(dayNight(3), 1, { ...base, panel_peak_w: 83.3 }).survived).toBe(false);
  });

  it('battery = required capacity just survives; 1 Wh less dies at the interpolated instant', () => {
    // night first, landing at 50 %: A = 600 / 0.5 = 1200, drawdown from full = 600 -> 1200 Wh
    const s = dayNight(2, true);
    const p = { ...base, initial_soc_pct: 50, battery_wh: 1200 };
    const ok = simulate(s, 1, p);
    expect(ok.required_battery_wh).toBe(1200);
    expect(ok.survived).toBe(true);
    expect(ok.min_soc_wh).toBe(0);
    expect(ok.min_soc_h).toBe(12);
    const dead = simulate(s, 1, { ...p, battery_wh: 1199 });
    expect(dead.survived).toBe(false);
    // 599.5 Wh at 50 W -> empty after 11.99 h; the step 11 is dark, dark since landing
    expect(dead.first_depletion_h).toBeCloseTo(11.99, 12);
    expect(dead.min_soc_h).toBeCloseTo(11.99, 12);
    expect(dead.dark_h_at_depletion).toBeCloseTo(11.99, 12);
    expect(dead.dark_at_depletion_truncated).toBe(true);
    expect(dead.hours_below_min).toBeCloseTo(0.01, 12);
    // day 1 refills 0 -> 600, night 2 drains it to exactly 0 at the end: load met, not below
    expect(dead.n_depletions).toBe(1);
    expect(dead.energy_unserved_wh).toBeCloseTo(0.5, 9);
    expect(dead.end_soc_wh).toBeCloseTo(600, 9); // day 2 refills it
  });

  it('reserve (min_soc_pct 20 %): required = 600 / 0.8; a smaller battery dips below the reserve every night', () => {
    const s = dayNight(3);
    const p = { ...base, min_soc_pct: 20, battery_wh: 750 };
    const ok = simulate(s, 1, p);
    expect(ok.required_battery_wh).toBe(750);
    expect(ok.survived).toBe(true);
    expect(ok.min_soc_wh).toBe(150);
    const low = simulate(s, 1, { ...p, battery_wh: 740 });
    // reserve 148: night from 740 crosses 148 after 11.84 h, ends at 140; next day climbs back in 0.16 h
    expect(low.survived).toBe(false);
    expect(low.first_depletion_h).toBeCloseTo(23.84, 9);
    expect(low.dark_h_at_depletion).toBeCloseTo(11.84, 9);
    expect(low.n_depletions).toBe(3);
    expect(low.hours_below_min).toBeCloseTo(0.16 * 5, 9);
    expect(low.min_soc_wh).toBeCloseTo(140, 9);
  });

  it('energy balance identity holds: end - start = in - curtailed - (out - unserved)', () => {
    for (const p of [base, { ...base, battery_wh: 300 }, { ...base, panel_peak_w: 20, day_load_w: 10, night_load_w: 80 }]) {
      const sim = simulate(dayNight(4, true), 1, p);
      const lhs = sim.end_soc_wh - p.battery_wh * (p.initial_soc_pct / 100);
      const rhs = sim.energy_in_wh - sim.energy_curtailed_wh - (sim.energy_out_wh - sim.energy_unserved_wh);
      expect(lhs).toBeCloseTo(rhs, 9);
    }
  });

  it('a step of 0.5 h integrates the same energy as two 1 h halves', () => {
    const hourly = dayNight(2);
    const half = hourly.flatMap((x) => [x, x]);
    const a = simulate(hourly, 1, { ...base, battery_wh: 500 });
    const b = simulate(half, 0.5, { ...base, battery_wh: 500 });
    expect(b.end_soc_wh).toBeCloseTo(a.end_soc_wh, 9);
    expect(b.first_depletion_h).toBeCloseTo(a.first_depletion_h ?? Number.NaN, 9);
    expect(b.required_battery_wh).toBeCloseTo(a.required_battery_wh ?? Number.NaN, 9);
  });

  it('longest_no_input_h: = longest night for tracking; a fixed panel facing away adds the lit-but-behind hours; independent of panel size', () => {
    const t = simulate(dayNight(3), 1, base);
    expect(t.longest_no_input_h).toBe(12);
    // Sun at az 90 during the day: a vertical panel facing west (270) never produces -> 72 h, no panel size helps
    const v = simulate(dayNight(3), 1, { ...base, panel_mode: 'vertical_fixed', panel_azimuth_deg: 270 });
    expect(v.longest_no_input_h).toBe(72);
    expect(v.energy_in_wh).toBe(0);
    expect(v.required_panel_peak_w).toBeNull();
    expect(simulate(dayNight(3), 1, { ...base, panel_peak_w: 0 }).longest_no_input_h).toBe(12);
  });

  it('day load differs from night load (selected by sun_visible)', () => {
    const sim = simulate(dayNight(1), 1, { ...base, day_load_w: 80, night_load_w: 20 });
    expect(sim.energy_out_wh).toBe(12 * 80 + 12 * 20);
    expect(sim.soc_wh[24]).toBe(1000 - 12 * 20);
  });
});

describe('panel factor and irradiance', () => {
  const s = lit(true, { sun_az_deg: 90, sun_el_deg: 0, sun_fraction: 0.5, power_horizontal: 0 });
  it('tracking = sun_fraction; horizontal = power_horizontal', () => {
    expect(panelFactor(s, 'tracking', null)).toBe(0.5);
    expect(panelFactor(lit(true), 'horizontal', null)).toBeCloseTo(Math.sin((10 * Math.PI) / 180), 15);
  });
  it('vertical_fixed = fraction * cos(el) * max(0, cos(az - panel_az))', () => {
    expect(panelFactor(s, 'vertical_fixed', 90)).toBeCloseTo(0.5, 15);
    expect(panelFactor(s, 'vertical_fixed', 45)).toBeCloseTo(0.5 * Math.SQRT1_2, 15);
    expect(panelFactor(s, 'vertical_fixed', 180)).toBeCloseTo(0, 15);
    expect(panelFactor(s, 'vertical_fixed', 270)).toBe(0); // Sun behind the panel
    expect(panelFactor({ ...s, sun_el_deg: 60 }, 'vertical_fixed', 90)).toBeCloseTo(0.25, 15);
    expect(() => panelFactor(s, 'vertical_fixed', null)).toThrow(RangeError);
  });
  it('solar_distance scales by (AU / d)^2; constant = 1', () => {
    expect(irradianceScale(lit(true, { sun_dist_km: AU_KM / 1.01 }), 'solar_distance')).toBeCloseTo(1.0201, 12);
    expect(irradianceScale(lit(true, { sun_dist_km: AU_KM / 1.01 }), 'constant')).toBe(1);
    const sim = simulate([lit(true, { sun_dist_km: AU_KM / 1.01 })], 1, { ...base, irradiance: 'solar_distance', battery_wh: 1e6, initial_soc_pct: 50 });
    expect(sim.energy_in_wh).toBeCloseTo(102.01, 9);
  });
});

describe('helpers', () => {
  it('longestDark finds the longest dark run and flags the boundaries', () => {
    expect(longestDark([1, 0, 0, 1, 0, 0, 0, 1], 1)).toEqual({ hours: 3, truncated: false });
    expect(longestDark([0, 0, 0, 1, 0, 1], 2)).toEqual({ hours: 6, truncated: true });
    expect(longestDark([1, 1], 1)).toEqual({ hours: 0, truncated: false });
  });

  it('decimateSoc keeps first, last and every minimum, size <= max_points', () => {
    const soc = Array.from({ length: 1000 }, (_v, i) => 500 + 400 * Math.sin(i / 7) + (i === 613 ? -450 : 0));
    const d = decimateSoc(soc, 50);
    expect(d.decimated).toBe(true);
    expect(d.indices.length).toBeLessThanOrEqual(50);
    expect(d.indices[0]).toBe(0);
    expect(d.indices.at(-1)).toBe(999);
    expect(d.indices).toContain(613);
    expect(decimateSoc([1, 2, 3], 10)).toEqual({ indices: [0, 1, 2], decimated: false });
  });

  it('requiredBatteryWh is exact on random series (property test)', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let trial = 0; trial < 200; trial++) {
      const n = 20 + Math.floor(rnd() * 200);
      const pIn = Array.from({ length: n }, () => (rnd() < 0.5 ? 0 : rnd() * 200));
      const load = Array.from({ length: n }, () => 10 + rnd() * 60);
      const s0 = 0.3 + rnd() * 0.7;
      const m = rnd() < 0.5 ? 0 : rnd() * Math.min(0.3, s0);
      const dt = rnd() < 0.5 ? 1 : 0.25;
      const req = requiredBatteryWh(pIn, load, dt, s0, m);
      expect(req).not.toBeNull();
      const c = req ?? 0;
      if (c === 0) continue;
      expect(runBattery(pIn, load, dt, c, c * s0, c * m).survived, `trial ${trial}`).toBe(true);
      const c2 = c * (1 - 1e-6);
      expect(runBattery(pIn, load, dt, c2, c2 * s0, c2 * m).survived, `trial ${trial} smaller`).toBe(false);
    }
  });

  it('requiredBatteryWh: null when starting at the reserve with a net drain, 0 when the panel always covers the load', () => {
    expect(requiredBatteryWh([0, 100], [50, 50], 1, 0.2, 0.2)).toBeNull();
    expect(requiredBatteryWh([100, 100], [50, 50], 1, 0.2, 0.2)).toBe(0);
  });

  it('requiredPanelPeakW bisects up to the search cap (answer between 2^23 W and 1e7 W)', async () => {
    const { requiredPanelPeakW, PANEL_SEARCH_MAX_W } = await import('../../src/mission/energy.ts');
    // 1 h, 1 W per W of panel, 9e6 W load, 1 Wh battery full: survives iff w + 1 >= 9e6 -> w* = 8 999 999 W
    const w = requiredPanelPeakW([1], [9e6], 1, 1, 1, 0);
    expect(w).not.toBeNull();
    expect(w ?? 0).toBeGreaterThanOrEqual(8_999_999);
    expect(w ?? 0).toBeLessThan(8_999_999 + 1e-6 * 9e6 + 0.02);
    expect(w ?? 0).toBeLessThan(PANEL_SEARCH_MAX_W);
    expect(runBattery([1], [9e6], 1, 1, 1, 0, w ?? 0).survived).toBe(true);
    expect(runBattery([1], [9e6], 1, 1, 1, 0, 8_999_998).survived).toBe(false);
    // exactly at the cap: 1e7 is the answer; above the cap: null
    expect(requiredPanelPeakW([1], [1e7 + 1], 1, 1, 1, 0)).toBe(PANEL_SEARCH_MAX_W);
    expect(requiredPanelPeakW([1], [1e7 + 2], 1, 1, 1, 0)).toBeNull();
    // small answers unchanged: 12 h on / 12 h off, 50 W, 600 Wh battery -> 100 W
    const unit = Array.from({ length: 48 }, (_v, k) => (Math.floor(k / 12) % 2 === 0 ? 1 : 0));
    const panel = requiredPanelPeakW(unit, new Array(48).fill(50), 1, 600, 600, 0);
    expect(panel).toBeGreaterThanOrEqual(100);
    expect(panel ?? 0).toBeLessThanOrEqual(100.02);
  });

  it('required_battery_full_start_wh = required battery with the landing charge at 100 %', () => {
    // 12 h dark first, 50 W, panel 100 W: full start needs 600 Wh; starting at 50 % needs 1200 Wh
    const samples = dayNight(2, true);
    const sim = simulate(samples, 1, { ...base, battery_wh: 600, initial_soc_pct: 50 });
    expect(sim.required_battery_wh).toBeCloseTo(1200, 6);
    expect(sim.required_battery_full_start_wh).toBeCloseTo(600, 6);
    const full = simulate(samples, 1, { ...base, battery_wh: 600, initial_soc_pct: 100 });
    expect(full.required_battery_full_start_wh).toBe(full.required_battery_wh);
  });

  it('rejects inconsistent parameters', () => {
    expect(() => simulate(dayNight(1), 1, { ...base, initial_soc_pct: 10, min_soc_pct: 20 })).toThrow(RangeError);
    expect(() => simulate(dayNight(1), 0, base)).toThrow(RangeError);
  });
});

describe('night-only battery (shared with /dataset survival_hint)', () => {
  it('12 h on / 12 h off, 50 W: 600 Wh = required_battery_wh of an unlimited panel; runs and formatting', async () => {
    const { nightOnlyBatteryWh, nightOnlyBatteryWhOfRuns, darkRuns, batteryText } = await import('../../src/mission/energy.ts');
    const litArr = Uint8Array.from({ length: 72 }, (_v, k) => (Math.floor(k / 12) % 2 === 0 ? 1 : 0));
    expect(darkRuns(litArr)).toEqual([12, 12, 12]);
    expect(darkRuns(Uint8Array.from([0, 0, 1, 0]))).toEqual([2, 1]);
    expect(nightOnlyBatteryWh(litArr, 1, 50)).toBe(600);
    expect(nightOnlyBatteryWhOfRuns([3, 354, 10], 1, 30)).toBe(10_620);
    expect(nightOnlyBatteryWh(new Uint8Array(10).fill(1), 1, 50)).toBe(0);
    // same model: simulate() with a huge panel and no day load gives the same required battery
    const samples = Array.from(litArr, (l) => lit(l === 1));
    const sim = simulate(samples, 1, {
      battery_wh: 1000, night_load_w: 50, day_load_w: 0, panel_peak_w: 1e7, panel_mode: 'tracking', panel_azimuth_deg: null,
      initial_soc_pct: 100, min_soc_pct: 0, irradiance: 'constant',
    }, { panelSearch: false });
    expect(sim.required_battery_wh).toBeCloseTo(600, 6);
    expect(batteryText(600)).toBe('600 Wh');
    expect(batteryText(600.0000000001)).toBe('600 Wh');
    expect(batteryText(600.4)).toBe('601 Wh');
    expect(batteryText(10_397.6)).toBe('10.4 kWh');
    expect(batteryText(3000)).toBe('3.0 kWh');
    expect(batteryText(5301)).toBe('5.4 kWh');
  });
});
