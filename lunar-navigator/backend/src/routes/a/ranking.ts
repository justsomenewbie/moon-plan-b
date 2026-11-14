/**
 * Ranking = `lunarnav.analysis.rank_sites` re-implemented bit-for-bit:
 *   score = sum_k w[k] * metric[k]   (accumulated in RANK_METRICS order, starting at 0.0)
 *   sort by (-round(score, 9), longest_dark_h, site_id)   (str order = code points)
 *   reported score = round(score, 6)
 * Metrics must be the stored (6-decimal) values, as the precompute ranks "from stored (rounded)
 * metrics" -> identical to summary.csv for the full run and the run's weights.
 */
import { DEFAULT_RANK_WEIGHTS, RANK_METRICS, type Metrics, type RankWeights, type RankingRow } from '../../contract/common.ts';
import { cmpStr, pyRound } from './pyround.ts';

/** The metrics a ranking row shows (a full Metrics or a summary.csv row both satisfy it). */
export type RankMetrics = Pick<
  Metrics,
  | 'pct_sun'
  | 'pct_earth'
  | 'pct_both'
  | 'pct_sun_no_earth'
  | 'longest_dark_h'
  | 'longest_dark_truncated'
  | 'longest_comms_gap_h'
  | 'longest_comms_gap_truncated'
  | 'mean_power_tracking'
>;

export interface RankInput {
  site_id: string;
  name: string;
  group: string;
  metrics: RankMetrics;
}

/** Full weight object (missing keys = 0) for display / comparisons. */
export function normalizeWeights(w: RankWeights | undefined): RankWeights {
  return w ?? { ...DEFAULT_RANK_WEIGHTS };
}

/** Same weights (missing key == 0)? */
export function sameWeights(a: RankWeights, b: RankWeights): boolean {
  return RANK_METRICS.every((k) => (a[k] ?? 0) === (b[k] ?? 0));
}

export function rawScore(m: RankMetrics, w: RankWeights): number {
  let s = 0.0;
  for (const k of RANK_METRICS) {
    const wk = w[k];
    if (wk === undefined) continue;
    s += wk * m[k];
  }
  return s;
}

export function reasons(m: RankMetrics): string[] {
  const out = [`Sun visible ${m.pct_sun.toFixed(1)}% of the time`, `Earth in view ${m.pct_earth.toFixed(1)}%`];
  if (m.pct_both > 0) out.push(`Sun and Earth together ${m.pct_both.toFixed(1)}%`);
  const dark = `${m.longest_dark_h} h${m.longest_dark_truncated ? '+' : ''}`;
  if (m.longest_dark_h === 0) out.push('never dark in this range');
  else out.push(m.longest_dark_h <= 48 ? `longest night only ${dark}` : `longest night ${dark}`);
  if (m.pct_earth === 0) out.push('no direct-to-Earth link (far side or blocked by terrain)');
  else if (m.longest_comms_gap_h > 0) out.push(`longest comms gap ${m.longest_comms_gap_h} h${m.longest_comms_gap_truncated ? '+' : ''}`);
  return out;
}

/** Row of the ranking table for given metrics, rank and score (no recomputation). */
export function rankingRow(rank: number, score: number, s: RankInput): RankingRow {
  const m = s.metrics;
  return {
    rank,
    site_id: s.site_id,
    name: s.name,
    group: s.group,
    score,
    pct_sun: m.pct_sun,
    pct_earth: m.pct_earth,
    pct_both: m.pct_both,
    pct_sun_no_earth: m.pct_sun_no_earth,
    longest_dark_h: m.longest_dark_h,
    longest_dark_truncated: m.longest_dark_truncated,
    longest_comms_gap_h: m.longest_comms_gap_h,
    longest_comms_gap_truncated: m.longest_comms_gap_truncated,
    mean_power_tracking: m.mean_power_tracking,
    reasons: reasons(m),
  };
}

export function rankSites(sites: readonly RankInput[], weights: RankWeights): RankingRow[] {
  const rows = sites.map((s) => {
    const score = rawScore(s.metrics, weights);
    return { s, score, key: pyRound(score, 9) };
  });
  rows.sort((a, b) => b.key - a.key || a.s.metrics.longest_dark_h - b.s.metrics.longest_dark_h || cmpStr(a.s.site_id, b.s.site_id));
  return rows.map((r, i) => rankingRow(i + 1, pyRound(r.score, 6), r.s));
}
