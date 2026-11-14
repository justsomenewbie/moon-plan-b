/**
 * Pure group-A modules (no MongoDB): Python-compatible rounding, ranking = lunarnav.analysis.rank_sites,
 * metric clipping, ETag matching. Reference numbers come from lunarnav itself (fixtures/reference.json,
 * see make_reference.py) and from the sample run's summary.csv / windows.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import type { Metrics } from '../../../src/contract/common.ts';
import { cmpStr, pyRound } from '../../../src/routes/a/pyround.ts';
import { rankSites, rawScore, sameWeights } from '../../../src/routes/a/ranking.ts';
import { clipIndexed, rangeMetrics } from '../../../src/routes/a/metrics.ts';
import { etagMatches, weakEtag } from '../../../src/routes/a/http_cache.ts';
import { REFERENCE, SAMPLE_DIR, summaryRows } from './sample.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('pyRound = Python round(x, nd)', () => {
  // expected values printed by CPython 3 (round() on the exact binary value, ties to even)
  const cases: [number, number, number][] = [
    [2.675, 2, 2.67], // binary value is below the tie
    [0.125, 2, 0.12], // exact tie -> even
    [0.375, 2, 0.38], // exact tie -> even (up)
    [2.5, 0, 2],
    [3.5, 0, 4],
    [-0.125, 2, -0.12],
    [1.0000005, 6, 1.000001], // stored as 1.00000050000000005838...
    [71.16203699999999, 6, 71.162037],
    [0.3 * 52.268519, 6, 15.680556],
    [123.456, 9, 123.456],
  ];
  it.each(cases)('round(%d, %d) == %d', (x, nd, want) => {
    expect(pyRound(x, nd)).toBe(want);
  });

  it('differs from the naive Math.round where Python does', () => {
    const naive = (x: number, nd: number) => Math.round(x * 10 ** nd) / 10 ** nd;
    expect(naive(2.675, 2)).toBe(2.68);
    expect(pyRound(2.675, 2)).toBe(2.67);
  });

  it('compares strings by code point like Python', () => {
    expect(['b', 'B', 'a_1', 'a1'].sort(cmpStr)).toEqual(['B', 'a1', 'a_1', 'b']);
  });
});

describe('ranking = lunarnav.analysis.rank_sites', () => {
  it('weights equality ignores key order and treats missing as 0', () => {
    expect(sameWeights({ pct_both: 0.3, pct_earth: 0.3, pct_sun: 0.4 }, { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3, pct_sun_no_earth: 0 })).toBe(true);
    expect(sameWeights({ pct_sun: 1 }, { pct_sun: 0.4 })).toBe(false);
  });

  it('ties break on shorter longest_dark_h, then site id (code points)', () => {
    const m = (pct: number, dark: number) => ({ pct_sun: pct, pct_earth: 0, pct_both: 0, pct_sun_no_earth: pct, longest_dark_h: dark, longest_dark_truncated: false, longest_comms_gap_h: 0, longest_comms_gap_truncated: false, mean_power_tracking: 0 });
    const rows = rankSites(
      [
        { site_id: 'b', name: 'b', group: 'g', metrics: m(50, 10) },
        { site_id: 'a', name: 'a', group: 'g', metrics: m(50, 10) },
        { site_id: 'Z', name: 'Z', group: 'g', metrics: m(50, 10) },
        { site_id: 'c', name: 'c', group: 'g', metrics: m(50, 5) },
        { site_id: 'd', name: 'd', group: 'g', metrics: m(60, 99) },
      ],
      { pct_sun: 1 },
    );
    expect(rows.map((r) => r.site_id)).toEqual(['d', 'c', 'Z', 'a', 'b']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('scores accumulate in Python order (0.0 + 0.4a + 0.3b + 0.3c)', () => {
    const m = { pct_sun: 97.268519, pct_earth: 52.268519, pct_both: 51.990741, pct_sun_no_earth: 0, longest_dark_h: 0, longest_dark_truncated: false, longest_comms_gap_h: 0, longest_comms_gap_truncated: false, mean_power_tracking: 0 };
    expect(rawScore(m, { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 })).toBe(0.0 + 0.4 * 97.268519 + 0.3 * 52.268519 + 0.3 * 51.990741);
  });

  describe.runIf(existsSync(SAMPLE_DIR))('sample run (needs output/sample_2026Q1_spice_pgda)', () => {
    it('ranking the stored windows.json metrics reproduces summary.csv rank and score EXACTLY', () => {
      const summary = summaryRows();
      const inputs = summary.map((r) => {
        const w = JSON.parse(readFileSync(path.join(SAMPLE_DIR, 'sites', r.site_id, 'windows.json'), 'utf8')) as { metrics: Metrics };
        return { site_id: r.site_id, name: r.name, group: r.group, metrics: w.metrics };
      });
      const rows = rankSites(inputs, { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 });
      expect(rows.map((r) => [r.rank, r.site_id, r.score])).toEqual(summary.map((r) => [r.rank, r.site_id, r.score]));
    });
  });

  it('ranking lunarnav sub-range metrics reproduces lunarnav rank_sites for every weight set', () => {
    for (const rg of REFERENCE.ranges) {
      const inputs = Object.entries(rg.metrics).map(([id, metrics]) => ({ site_id: id, name: id, group: '', metrics }));
      for (const rk of rg.rankings) {
        const rows = rankSites(inputs, rk.weights);
        expect(rows.map((r) => ({ rank: r.rank, site_id: r.site_id, score: r.score })), `${rg.start} ${JSON.stringify(rk.weights)}`).toEqual(rk.rows);
      }
    }
  });
});

describe('range metrics from clipped windows', () => {
  const sun = [
    { state: false, start_index: 0, end_index: 10 },
    { state: true, start_index: 10, end_index: 40 },
    { state: false, start_index: 40, end_index: 48 },
  ];
  it('clips by sample index and marks windows touching the sub-range boundary truncated', () => {
    expect(clipIndexed(sun, 5, 45)).toEqual([
      { state: false, n: 5, truncated: true },
      { state: true, n: 30, truncated: false },
      { state: false, n: 5, truncated: true },
    ]);
    expect(clipIndexed(sun, 12, 20)).toEqual([{ state: true, n: 8, truncated: true }]);
  });

  it('computes percentages, longest runs, counts and means like compute_metrics', () => {
    const earth = [{ state: true, start_index: 0, end_index: 48 }];
    const m = rangeMetrics({
      stepS: 3600, i0: 5, i1: 45, sun, earth, both: sun,
      sums: { n: 40, n_lit: 30, sum_sun_el_lit: 30 * 1.5, sum_power_horizontal: 0.4, sum_power_tracking: 30 },
    });
    expect(m).toEqual({
      duration_h: 40, pct_sun: 75, pct_earth: 100, pct_both: 75, pct_sun_no_earth: 0,
      longest_dark_h: 5, longest_dark_truncated: true, longest_comms_gap_h: 0, longest_comms_gap_truncated: false,
      longest_sun_h: 30, longest_sun_truncated: false, longest_earth_h: 40, longest_earth_truncated: true,
      n_sun_windows: 1, n_dark_windows: 2, n_earth_windows: 1, n_comms_gaps: 0,
      mean_sun_el_lit_deg: 1.5, mean_power_horizontal: 0.01, mean_power_tracking: 0.75,
    });
  });

  it('refuses an incomplete series', () => {
    expect(() => rangeMetrics({ stepS: 3600, i0: 0, i1: 48, sun, earth: sun, both: sun, sums: { n: 47, n_lit: 0, sum_sun_el_lit: 0, sum_power_horizontal: 0, sum_power_tracking: 0 } })).toThrow(/47/);
  });
});

describe('ETag', () => {
  it('weak tags compare weakly, with lists and *', () => {
    const t = weakEtag('a', 'b');
    expect(t).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(weakEtag('a', 'b')).toBe(t);
    expect(weakEtag('ab', '')).not.toBe(t);
    expect(etagMatches(t, t)).toBe(true);
    expect(etagMatches(t.slice(2), t)).toBe(true);
    expect(etagMatches(`"x", ${t}`, t)).toBe(true);
    expect(etagMatches('*', t)).toBe(true);
    expect(etagMatches('"x"', t)).toBe(false);
    expect(etagMatches(undefined, t)).toBe(false);
  });
});

it('reference fixture was produced from the sample run', () => {
  expect(existsSync(path.join(here, 'fixtures', 'reference.json'))).toBe(true);
  expect(REFERENCE.ranges.length).toBeGreaterThanOrEqual(4);
  expect(parse).toBeTypeOf('function');
});
