/**
 * Metrics of several sites over a range of a run (POST /compare, GET /ranking).
 *
 * Full run -> the stored windows.json metrics verbatim (= Python). Sub-range -> recomputed by
 * metrics.ts from the stored windows (clipped by sample index) + one `series` aggregation for the
 * means (sun elevation over lit samples, mean power). One aggregation for all sites.
 */
import type { Metrics } from '../../contract/common.ts';
import { getWindows, seriesSums, type RunDoc, type SiteView } from '../../repos/index.ts';
import { ApiError } from '../../lib/problem.ts';
import { rangeMetrics } from './metrics.ts';
import type { RunRange } from './range.ts';

export async function metricsForRange(run: RunDoc, views: readonly SiteView[], range: RunRange): Promise<Map<string, Metrics>> {
  const out = new Map<string, Metrics>();
  if (range.full) {
    for (const v of views) out.set(v.site_run.site_id, v.site_run.metrics);
    return out;
  }
  const ids = views.map((v) => v.site_run.site_id);
  const [sums, windows] = await Promise.all([
    seriesSums(run._id, ids, range.startMs, range.endMs),
    Promise.all(ids.map((id) => getWindows(run._id, id, { fromMs: range.startMs, toMs: range.endMs }))),
  ]);
  ids.forEach((id, k) => {
    const s = sums.get(id);
    const w = windows[k];
    if (!s || !w || s.n !== range.n) {
      throw new ApiError('INTERNAL', `stored series of ${id} in run ${run._id} is incomplete (${s?.n ?? 0} of ${range.n} samples)`);
    }
    out.set(id, rangeMetrics({ stepS: run.step_s, i0: range.i0, i1: range.i1, sun: w.sun ?? [], earth: w.earth ?? [], both: w.both ?? [], sums: s }));
  });
  return out;
}
