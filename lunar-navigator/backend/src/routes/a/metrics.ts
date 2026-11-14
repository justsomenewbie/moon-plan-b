/**
 * Metrics of one site over a sub-range of a run (docs/OUTPUT_SPEC.md 3.6), recomputed in Node
 * exactly like `lunarnav.windows.compute_metrics` would on the samples of that sub-range:
 *
 * - windows of the full run are clipped to the sample range [i0, i1); a clipped window touching
 *   the sub-range boundary is "truncated" (as Python sees a shorter series);
 * - percentages use the same float operations as Python (100.0 * k*step / (n*step));
 * - longest runs: first window with a strictly greater duration wins (Python order);
 * - means need the series (sun_el over lit samples, power columns) -> passed in as sums;
 * - every float is rounded like the precompute writer (`clean_float`, 6 decimals, ties to even).
 *
 * Pure module: no MongoDB, unit-tested against Python output.
 */
import type { Metrics } from '../../contract/common.ts';
import { pyRound } from './pyround.ts';

/** A window of the FULL run, sample indices [start_index, end_index). */
export interface IndexedWindow {
  state: boolean;
  start_index: number;
  end_index: number;
}

export type { SeriesSums } from '../../repos/index.ts';
import type { SeriesSums } from '../../repos/index.ts';

interface Clipped {
  state: boolean;
  n: number;
  truncated: boolean;
}

/** Clip full-run windows to [i0, i1). Windows are assumed sorted and tiling the run. */
export function clipIndexed(windows: readonly IndexedWindow[], i0: number, i1: number): Clipped[] {
  const out: Clipped[] = [];
  for (const w of windows) {
    const s = Math.max(w.start_index, i0);
    const e = Math.min(w.end_index, i1);
    if (e <= s) continue;
    out.push({ state: w.state, n: e - s, truncated: s === i0 || e === i1 });
  }
  return out;
}

function longest(ws: readonly Clipped[], state: boolean, stepS: number): { h: number; truncated: boolean } {
  let best = 0;
  let trunc = false;
  for (const w of ws) {
    const h = (w.n * stepS) / 3600;
    if (w.state === state && h > best) {
      best = h;
      trunc = w.truncated;
    }
  }
  return { h: best, truncated: trunc };
}

const countTrue = (ws: readonly Clipped[]): number => ws.reduce((a, w) => a + (w.state ? w.n : 0), 0);

export interface RangeMetricsInput {
  stepS: number;
  i0: number;
  i1: number;
  sun: readonly IndexedWindow[];
  earth: readonly IndexedWindow[];
  both: readonly IndexedWindow[];
  sums: SeriesSums;
}

export function rangeMetrics(inp: RangeMetricsInput): Metrics {
  const { stepS, i0, i1 } = inp;
  const n = i1 - i0;
  if (n <= 0) throw new RangeError('empty range');
  const sun = clipIndexed(inp.sun, i0, i1);
  const earth = clipIndexed(inp.earth, i0, i1);
  const both = clipIndexed(inp.both, i0, i1);
  const total = n * stepS;
  const nSun = countTrue(sun);
  const nEarth = countTrue(earth);
  const nBoth = countTrue(both);
  const pct = (k: number): number => pyRound((100.0 * (k * stepS)) / total, 6);
  const ld = longest(sun, false, stepS);
  const lg = longest(earth, false, stepS);
  const ls = longest(sun, true, stepS);
  const le = longest(earth, true, stepS);
  const s = inp.sums;
  if (s.n !== n) throw new RangeError(`series has ${s.n} samples in the range, expected ${n}`);
  return {
    duration_h: pyRound(total / 3600, 6),
    pct_sun: pct(nSun),
    pct_earth: pct(nEarth),
    pct_both: pct(nBoth),
    pct_sun_no_earth: pct(nSun - nBoth),
    longest_dark_h: pyRound(ld.h, 6),
    longest_dark_truncated: ld.truncated,
    longest_comms_gap_h: pyRound(lg.h, 6),
    longest_comms_gap_truncated: lg.truncated,
    longest_sun_h: pyRound(ls.h, 6),
    longest_sun_truncated: ls.truncated,
    longest_earth_h: pyRound(le.h, 6),
    longest_earth_truncated: le.truncated,
    n_sun_windows: sun.filter((w) => w.state).length,
    n_dark_windows: sun.filter((w) => !w.state).length,
    n_earth_windows: earth.filter((w) => w.state).length,
    n_comms_gaps: earth.filter((w) => !w.state).length,
    mean_sun_el_lit_deg: s.n_lit > 0 ? pyRound(s.sum_sun_el_lit / s.n_lit, 6) : null,
    mean_power_horizontal: pyRound(s.sum_power_horizontal / n, 6),
    mean_power_tracking: pyRound(s.sum_power_tracking / n, 6),
  };
}
