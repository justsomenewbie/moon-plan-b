/** Unit tests of the pure /dataset helpers (src/routes/dataset_build.ts). */
import { describe, expect, it } from 'vitest';
import {
  TooManyTransitionsError,
  clipSpans,
  decimateSeries,
  estimatePoints,
  evaluateCriteria,
  flagsFromSpans,
  planSeriesPoints,
  rangeMetrics,
  resampleHorizon,
  sourcesOf,
  visibleWindows,
} from '../../../src/routes/dataset_build.ts';
import type { WindowDoc } from '../../../src/repos/types.ts';

const H = 3_600_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const win = (kind: WindowDoc['kind'], state: boolean, i0: number, i1: number, n: number): WindowDoc => ({
  _id: `r|s|${kind}|${i0}`,
  run_id: 'r',
  site_id: 's',
  kind,
  state,
  start: new Date(T0 + i0 * H),
  end: new Date(T0 + i1 * H),
  duration_h: i1 - i0,
  start_index: i0,
  end_index: i1,
  truncated_start: i0 === 0,
  truncated_end: i1 === n,
});

describe('decimateSeries', () => {
  it('returns every sample when k = 1 and n <= max_points', () => {
    const d = decimateSeries([true, true, false], [true, true, true], 1, 10);
    expect(d.indices).toEqual([0, 1, 2]);
    expect(d.nTransitions).toBe(1);
  });

  it('keeps every k-th sample, the last one and both samples around each transition', () => {
    const sun = Array.from({ length: 20 }, (_v, i) => i < 7 || i > 7); // 1-sample dark blip at 7
    const earth = Array.from({ length: 20 }, (_v, i) => i < 13);
    const d = decimateSeries(sun, earth, 5, 100);
    expect(d.k).toBe(5);
    expect(d.nTransitions).toBe(3);
    expect(d.indices).toEqual([0, 5, 6, 7, 8, 10, 12, 13, 15, 19]);
  });

  it('raises k until the result fits max_points', () => {
    const n = 1000;
    const sun = Array.from({ length: n }, (_v, i) => Math.floor(i / 100) % 2 === 0);
    const earth = Array.from({ length: n }, () => true);
    const d = decimateSeries(sun, earth, 1, 50);
    expect(d.indices.length).toBeLessThanOrEqual(50);
    for (let i = 1; i < n; i++) if (sun[i] !== sun[i - 1]) expect(d.indices).toEqual(expect.arrayContaining([i - 1, i]));
  });

  it('throws when the transitions alone exceed max_points', () => {
    const sun = Array.from({ length: 100 }, (_v, i) => i % 2 === 0);
    expect(() => decimateSeries(sun, sun, 2, 20)).toThrow(TooManyTransitionsError);
  });

  it('estimatePoints', () => {
    expect(estimatePoints(744, 1, 10_000)).toBe(744);
    expect(estimatePoints(43_824, 1, 10_000)).toBe(10_000);
    expect(estimatePoints(744, 6, 10_000)).toBe(125);
  });
});

describe('planSeriesPoints (exact payload count before the series is read)', () => {
  // windows tiling n samples, alternating every `period` samples (sun), earth always visible
  const alternating = (kind: WindowDoc['kind'], n: number, period: number): WindowDoc[] => {
    const out: WindowDoc[] = [];
    for (let i = 0, st = true; i < n; i += period, st = !st) out.push(win(kind, st, i, Math.min(n, i + period), n));
    return out;
  };

  it('flagsFromSpans rebuilds the per-sample flags of a sub-range', () => {
    const docs = alternating('sun', 20, 3);
    const f = flagsFromSpans(clipSpans(docs, T0 + 2 * H, T0 + 10 * H, 3600), T0 + 2 * H, 3600, 8);
    expect(f).toEqual([true, false, false, false, true, true, true, false]); // samples 2..9
  });

  it('equals decimateSeries on the real flags (transition samples counted)', () => {
    const n = 2000;
    const sunDocs = alternating('sun', n, 37);
    const earthDocs = alternating('earth', n, 101);
    const sun = clipSpans(sunDocs, T0, T0 + n * H, 3600);
    const earth = clipSpans(earthDocs, T0, T0 + n * H, 3600);
    const sunVis = Array.from({ length: n }, (_v, i) => Math.floor(i / 37) % 2 === 0);
    const earthVis = Array.from({ length: n }, (_v, i) => Math.floor(i / 101) % 2 === 0);
    for (const [k, max] of [[1, 10_000], [24, 10_000], [24, 150], [6, 400]] as const) {
      const d = decimateSeries(sunVis, earthVis, k, max);
      expect(planSeriesPoints(sun, earth, T0, 3600, n, k, max)).toEqual({ points: d.indices.length, transSamples: d.nTransSamples });
    }
  });

  it('the review case: 23 sites x whole run at step_s=86400 is over 50 000 points although the regular estimate is not', () => {
    // 43 824 hourly samples, ~1 018 transition samples per site (like ref_shackleton_rim over 2026-2030)
    const n = 43_824;
    const sun = clipSpans(alternating('sun', n, 86), T0, T0 + n * H, 3600);
    const earth = clipSpans(alternating('earth', n, n), T0, T0 + n * H, 3600);
    const est = estimatePoints(n, 24, 10_000);
    expect(est * 23).toBeLessThanOrEqual(50_000); // the old check passed
    const plan = planSeriesPoints(sun, earth, T0, 3600, n, 24, 10_000);
    expect(plan.transSamples).toBeGreaterThan(1000);
    expect(plan.points * 23).toBeGreaterThan(50_000); // the new one rejects it
  });
});

describe('resampleHorizon', () => {
  const h = { az_step_deg: 0.5, el_deg: Array.from({ length: 720 }, (_v, i) => i / 10), min_el_deg: 0, max_el_deg: 71.9, method: 'bruteforce', dem_source: 'x' };
  it('1 deg: 361 points, exact stored values, closed at 360', () => {
    const r = resampleHorizon(h, 1);
    expect(r.az_deg).toHaveLength(361);
    expect(r.el_deg[1]).toBe(0.2);
    expect(r.el_deg[360]).toBe(r.el_deg[0]);
  });
  it('interpolates when the stored grid is coarser', () => {
    const r = resampleHorizon({ ...h, az_step_deg: 1, el_deg: Array.from({ length: 360 }, (_v, i) => i) }, 0.5);
    expect(r.az_deg).toHaveLength(721);
    expect(r.el_deg[1]).toBe(0.5);
    expect(r.el_deg[719]).toBe(179.5); // between 359 and 0
  });
});

describe('windows, metrics, criteria', () => {
  // 48 samples: sun lit [0,30) dark [30,48); earth [0,10) gap [10,20) visible [20,48); both = lit & earth
  const N = 48;
  const docs = {
    sun: [win('sun', true, 0, 30, N), win('sun', false, 30, 48, N)],
    earth: [win('earth', true, 0, 10, N), win('earth', false, 10, 20, N), win('earth', true, 20, 48, N)],
    both: [win('both', true, 0, 10, N), win('both', false, 10, 20, N), win('both', true, 20, 30, N), win('both', false, 30, 48, N)],
  };
  const clip = (s: number, e: number) => ({
    sun: clipSpans(docs.sun, T0 + s * H, T0 + e * H, 3600),
    earth: clipSpans(docs.earth, T0 + s * H, T0 + e * H, 3600),
    both: clipSpans(docs.both, T0 + s * H, T0 + e * H, 3600),
  });

  it('whole range', () => {
    const sp = clip(0, N);
    const { metrics, longestBoth } = rangeMetrics(sp, N, 3600);
    expect(metrics).toEqual({
      duration_h: 48,
      pct_sun: 62.5,
      pct_earth: 79.166667,
      pct_both: 41.666667,
      sun_hours: 30,
      earth_hours: 38,
      both_hours: 20,
      longest_sun_h: 30,
      longest_earth_h: 28,
      longest_both_h: 10,
      longest_dark_h: 18,
      longest_comms_gap_h: 10,
    });
    // both [0,10) (cut by the run start) and [20,30) (sampled edges) are 10 h long
    expect(longestBoth).toEqual({ clipped: true, endExact: false, startUncertain: true });
    expect(visibleWindows(sp.earth, 3600)).toEqual([
      { start: '2026-01-01T00:00:00Z', end: '2026-01-01T10:00:00Z', duration_h: 10, clipped_start: true, clipped_end: false },
      { start: '2026-01-01T20:00:00Z', end: '2026-01-03T00:00:00Z', duration_h: 28, clipped_start: false, clipped_end: true },
    ]);
  });

  it('sub-range clips windows and flags the cut ends', () => {
    const sp = clip(5, 25);
    const w = visibleWindows(sp.sun, 3600);
    expect(w).toEqual([{ start: '2026-01-01T05:00:00Z', end: '2026-01-02T01:00:00Z', duration_h: 20, clipped_start: true, clipped_end: true }]);
    expect(rangeMetrics(sp, 20, 3600).metrics.longest_both_h).toBe(5);
  });

  it('criteria: meets / below / borderline (within one step when both edges are sampled)', () => {
    const { metrics, longestBoth } = rangeMetrics(clip(0, N), N, 3600);
    const c = evaluateCriteria(metrics, longestBoth, [5, 9, 9.5, 10, 10.9, 11, 24], 3600);
    expect(c.map((x) => x.result)).toEqual(['meets', 'meets', 'borderline', 'borderline', 'borderline', 'below', 'below']);
    expect(c[0]?.reason).toContain('10 h >= 5 h');
    expect(c[3]?.reason).toContain('(9, 11) h');
    expect(c.every((x) => x.value_clipped)).toBe(true);
    expect(c[6]?.reason).toContain('cut by the range');
    const sampled = { clipped: false, endExact: false, startUncertain: true };
    expect(evaluateCriteria(metrics, sampled, [24], 3600)[0]).toMatchObject({ result: 'below', value_clipped: false });
    expect(evaluateCriteria(metrics, sampled, [24], 3600)[0]?.reason).not.toContain('cut by the range');
  });

  it('criteria: an edge cut by the range is exact (no borderline when both edges are cut)', () => {
    // range [22, 28): the both window [20,30) is cut on both sides -> exactly 6 h inside the range
    const sp = clip(22, 28);
    const { metrics, longestBoth } = rangeMetrics(sp, 6, 3600);
    expect(metrics.longest_both_h).toBe(6);
    expect(longestBoth).toEqual({ clipped: true, endExact: true, startUncertain: false });
    expect(evaluateCriteria(metrics, longestBoth, [5, 5.5, 6, 6.5, 7], 3600).map((x) => x.result)).toEqual(['meets', 'meets', 'meets', 'below', 'below']);
    // range [22, 40): [22,30) cut at the start only -> true length in (7, 8], so 8 h is borderline
    const sp2 = clip(22, 40);
    const r2 = rangeMetrics(sp2, 18, 3600);
    expect(r2.metrics.longest_both_h).toBe(8);
    expect(r2.longestBoth).toEqual({ clipped: true, endExact: false, startUncertain: false });
    expect(evaluateCriteria(r2.metrics, r2.longestBoth, [7, 7.5, 8, 8.5], 3600).map((x) => x.result)).toEqual(['meets', 'borderline', 'borderline', 'below']);
    // range [20, 40): [20,30) starts AT the range start (not cut: sample 19 is dark) -> its rise is <= range start, true length in (9, 10]
    const r4 = rangeMetrics(clip(20, 40), 20, 3600, T0 + 20 * H);
    expect(r4.longestBoth).toEqual({ clipped: false, endExact: false, startUncertain: false });
    expect(evaluateCriteria(r4.metrics, r4.longestBoth, [9, 10, 10.5], 3600).map((x) => x.result)).toEqual(['meets', 'borderline', 'below']);
    // range [15, 28): [20,28) cut at the end only -> true length in [8, 9)
    const sp3 = clip(15, 28);
    const r3 = rangeMetrics(sp3, 13, 3600);
    expect(r3.metrics.longest_both_h).toBe(8);
    expect(r3.longestBoth).toEqual({ clipped: true, endExact: true, startUncertain: true });
    expect(evaluateCriteria(r3.metrics, r3.longestBoth, [7.5, 8, 8.5, 9], 3600).map((x) => x.result)).toEqual(['meets', 'meets', 'borderline', 'below']);
  });
});

describe('sourcesOf', () => {
  it('dedupes by name and builds unique slug ids', () => {
    const s = sourcesOf([
      { name: 'NAIF SPICE generic kernels', url: 'https://naif.jpl.nasa.gov/', sha256: null },
      { name: 'NAIF SPICE generic kernels', url: 'https://naif.jpl.nasa.gov/' },
      { name: 'DEM pgda: bands[LDEM_80S_20MPP_ADJ<15km]', url: null },
    ]);
    expect(s.map((x) => x.id)).toEqual(['naif-spice-generic-kernels', 'dem-pgda-bands-ldem_80s_20mpp_adj-15km']);
    expect(s[1]?.url).toBeNull();
  });
});
