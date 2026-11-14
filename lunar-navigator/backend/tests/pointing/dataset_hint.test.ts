/**
 * Pure unit tests of the /dataset energy proxies and survival hint (src/routes/dataset_build.ts):
 * synthetic windows with a known answer. No MongoDB.
 */
import { describe, expect, it } from 'vitest';
import { DatasetSurvivalHint } from '../../src/contract/dataset.ts';
import { requiredBatteryWh, runBattery } from '../../src/mission/energy.ts';
import { clipSpans, fmtEnergy, meanPowerPct, nightBatteryWh, rangeMetrics, survivalHint, survivalHintAssumptions, type ClippedSpan } from '../../src/routes/dataset_build.ts';
import type { WindowDoc } from '../../src/repos/types.ts';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const H = 3_600_000;

/** Alternating sun windows of the given lengths (h), starting with `firstLit`, tiling [T0, T0 + sum). */
function sunWindows(lengths: number[], firstLit: boolean): WindowDoc[] {
  const out: WindowDoc[] = [];
  let i = 0;
  let st = firstLit;
  const n = lengths.reduce((a, b) => a + b, 0);
  for (const len of lengths) {
    out.push({
      _id: `r|s|sun|${i}`, run_id: 'r', site_id: 's', kind: 'sun', state: st, start: new Date(T0 + i * H), end: new Date(T0 + (i + len) * H),
      duration_h: len, start_index: i, end_index: i + len, truncated_start: i === 0, truncated_end: i + len === n,
    });
    i += len;
    st = !st;
  }
  return out;
}

describe('nightBatteryWh: required battery of the night load = load x longest dark period (energy model)', () => {
  it('12 h on / 12 h off, 50 W night load -> 600 Wh; matches a hand-integrated SOC curve', () => {
    expect(nightBatteryWh([12, 12, 12], 3600, 50)).toBe(600);
    // cross-check with the battery integrator: a 600 Wh battery that starts full runs 12 h at 50 W down to exactly 0, a 599 Wh one does not
    const pIn = new Float64Array(12);
    const load = new Float64Array(12).fill(50);
    const ok = runBattery(pIn, load, 1, 600, 600, 0);
    expect(ok.survived).toBe(true);
    expect(ok.end_soc_wh).toBeCloseTo(0, 9);
    expect(Array.from(ok.soc_wh)).toEqual(Array.from({ length: 13 }, (_v, k) => 600 - 50 * k));
    expect(runBattery(pIn, load, 1, 599, 599, 0).survived).toBe(false);
    expect(requiredBatteryWh(pIn, load, 1, 1, 0)).toBe(600);
  });

  it('worst period wins; non-integer loads and steps', () => {
    expect(nightBatteryWh([3, 354, 10], 3600, 30)).toBe(10_620);
    expect(nightBatteryWh([4], 7200, 12.5)).toBe(100); // 4 steps x 2 h x 12.5 W
    expect(nightBatteryWh([], 3600, 50)).toBe(0);
    expect(nightBatteryWh([0], 3600, 50)).toBe(0);
  });
});

describe('survivalHint', () => {
  it('12 h lit / 12 h dark, 50 W: longest dark 12 h, 600 Wh, first longest period reported', () => {
    const w = sunWindows([12, 12, 12, 12, 12], true);
    const spans = clipSpans(w, T0, T0 + 60 * H, 3600);
    const h = survivalHint(spans, 3600, 50);
    expect(DatasetSurvivalHint.safeParse(h).success).toBe(true);
    expect(h).toMatchObject({
      longest_dark_h: 12,
      longest_dark_start: '2026-01-01T12:00:00Z',
      longest_dark_end: '2026-01-02T00:00:00Z',
      longest_dark_clipped: false,
      night_load_w: 50,
      required_battery_wh: 600,
    });
    // equals metrics.longest_dark_h of the same spans
    expect(rangeMetrics({ sun: spans, earth: spans, both: spans }, 60, 3600).metrics.longest_dark_h).toBe(12);
    expect(h.summary.en).toBe('Longest night in the range: 12 h, from 2026-01-01T12:00:00Z to 2026-01-02T00:00:00Z. A 50 W night load needs a battery of 600 Wh (usable, starting full).');
    expect(h.summary.vi).toContain('Đêm dài nhất trong khoảng: 12 giờ');
    expect(h.summary.vi).toContain('Tải ban đêm 50 W cần pin 600 Wh');
    // a tie with a night cut by the run end -> clipped (the real longest night may be longer)
    const tie = survivalHint(clipSpans(sunWindows([12, 12, 12, 12, 12, 12], true), T0, T0 + 72 * H, 3600), 3600, 50);
    expect(tie).toMatchObject({ longest_dark_h: 12, longest_dark_start: '2026-01-01T12:00:00Z', longest_dark_clipped: true, required_battery_wh: 600 });
  });

  it('the longest night cut by the range -> clipped, lower bound wording', () => {
    const w = sunWindows([10, 200, 30], false); // dark 10 (cut by run start), lit 200, dark 30 (cut by run end)
    const spans = clipSpans(w, T0, T0 + 240 * H, 3600);
    const h = survivalHint(spans, 3600, 100);
    expect(h).toMatchObject({ longest_dark_h: 30, longest_dark_clipped: true, required_battery_wh: 3000, longest_dark_end: '2026-01-11T00:00:00Z' });
    expect(h.summary.en).toContain('the real longest night may be longer');
    expect(h.summary.en).toContain('at least 3.0 kWh');
    expect(h.summary.vi).toContain('ít nhất 3.0 kWh');
    // a sub-range that cuts a long night in the middle
    const sub = clipSpans(sunWindows([5, 354, 5], true), T0 + 100 * H, T0 + 200 * H, 3600);
    expect(survivalHint(sub, 3600, 50)).toMatchObject({ longest_dark_h: 100, longest_dark_clipped: true, required_battery_wh: 5000 });
  });

  it('no night_load_w -> required_battery_wh null and a hint to give it; always lit -> 0 h', () => {
    const spans = clipSpans(sunWindows([12, 12], true), T0, T0 + 24 * H, 3600);
    const h = survivalHint(spans, 3600, null);
    expect(h.required_battery_wh).toBeNull();
    expect(h.night_load_w).toBeNull();
    expect(h.summary.en).toContain('Give night_load_w');
    const lit: ClippedSpan[] = clipSpans(sunWindows([24], true), T0, T0 + 24 * H, 3600);
    const l = survivalHint(lit, 3600, 50);
    expect(l).toMatchObject({ longest_dark_h: 0, longest_dark_start: null, longest_dark_end: null, longest_dark_clipped: false, required_battery_wh: 0 });
    expect(l.summary.en).toContain('no battery is needed for the night');
  });

  it('never lit in the range: says no lit period can recharge the battery (no "starting full")', () => {
    const spans = clipSpans(sunWindows([240], false), T0, T0 + 240 * H, 3600);
    const h = survivalHint(spans, 3600, 10);
    expect(h).toMatchObject({ longest_dark_h: 240, longest_dark_clipped: true, required_battery_wh: 2400 });
    expect(h.summary.en).toContain('The Sun is never visible in the range: no lit period can recharge the battery');
    expect(h.summary.en).toContain('A 10 W night load drains at least 2.4 kWh over this dark period (a battery charged BEFORE the range, never recharged).');
    expect(h.summary.en).not.toContain('starting full');
    expect(h.summary.vi).toContain('không có lúc nào sạc lại được pin');
    // night_load_w 0 is allowed (as POST /mission/survival): 0 Wh
    const z = survivalHint(clipSpans(sunWindows([12, 12], true), T0, T0 + 24 * H, 3600), 3600, 0);
    expect(z).toMatchObject({ night_load_w: 0, required_battery_wh: 0 });
    expect(DatasetSurvivalHint.safeParse(z).success).toBe(true);
    expect(survivalHintAssumptions(3600).join(' ')).toContain('never visible in the range');
  });

  it('flat-horizon runs: assumptions say "ideal flat horizon", not "TERRAIN"', () => {
    const a = survivalHintAssumptions(3600, false).join(' ');
    expect(a).toContain('IDEAL FLAT horizon');
    expect(a).not.toContain('TERRAIN horizon');
  });

  it('assumptions state the simplified definition', () => {
    const a = survivalHintAssumptions(3600).join(' ');
    expect(a).toContain('night_load_w x longest_dark_h');
    expect(a).toContain('POST /mission/survival');
    expect(a).toContain('TERRAIN horizon');
    expect(a).toContain('lower bounds');
  });
});

describe('meanPowerPct / fmtEnergy', () => {
  it('100 x mean, 4 decimals, clamped; null without samples', () => {
    expect(meanPowerPct({ n: 4, sum_power_tracking: 2, sum_power_horizontal: 0.1 })).toEqual({ mean_power_tracking_pct: 50, mean_power_horizontal_pct: 2.5 });
    expect(meanPowerPct({ n: 3, sum_power_tracking: 1, sum_power_horizontal: 0 })).toEqual({ mean_power_tracking_pct: 33.3333, mean_power_horizontal_pct: 0 });
    expect(meanPowerPct({ n: 2, sum_power_tracking: 2.0000001, sum_power_horizontal: 0 }).mean_power_tracking_pct).toBe(100);
    expect(meanPowerPct(undefined)).toEqual({ mean_power_tracking_pct: null, mean_power_horizontal_pct: null });
    expect(meanPowerPct({ n: 0, sum_power_tracking: 0, sum_power_horizontal: 0 })).toEqual({ mean_power_tracking_pct: null, mean_power_horizontal_pct: null });
  });
  it('formats Wh / kWh', () => {
    expect(fmtEnergy(600)).toBe('600 Wh');
    expect(fmtEnergy(17_700)).toBe('17.7 kWh');
    expect(fmtEnergy(5_333.3)).toBe('5.33 kWh');
  });
});
