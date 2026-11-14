import { ApiError, apiError, producer } from "./client.ts";
import { rankingInOrder, rankingMetrics, type SiteComparison } from "./compare-sites.ts";
import { getTerrainDateSites } from "./terrain-dates.ts";
import type { components } from "./producer";

export type CatalogRanking = components["schemas"]["RankingResponse"];
type Row = CatalogRanking["ranking"][number];
const epsilon = 0.000002; // Producer percentages, scores and durations are reported to six decimal places.

function check(condition: unknown): asserts condition {
  if (!condition) throw new ApiError("The catalog ranking differs from the selected comparison.", 502);
}
function bounded(value: number, max: number) {
  return Number.isFinite(value) && value >= 0 && value <= max;
}
function close(a: number, b: number) {
  return Number.isFinite(a) && Math.abs(a - b) <= epsilon;
}
function checkRow(row: Row, rank: number, duration: number, weights: CatalogRanking["weights"]) {
  check(row && row.rank === rank && typeof row.site_id === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(row.site_id) &&
    typeof row.name === "string" && row.name.trim() && typeof row.group === "string" &&
    Array.isArray(row.reasons) && row.reasons.every(reason => typeof reason === "string"));
  check(rankingMetrics.every(field => bounded(row[field], 100)) &&
    row.pct_both <= Math.min(row.pct_sun, row.pct_earth) + epsilon &&
    row.pct_both + epsilon >= row.pct_sun + row.pct_earth - 100 &&
    close(row.pct_sun_no_earth, row.pct_sun - row.pct_both));
  check(bounded(row.longest_dark_h, duration + epsilon) && bounded(row.longest_comms_gap_h, duration + epsilon) &&
    typeof row.longest_dark_truncated === "boolean" && typeof row.longest_comms_gap_truncated === "boolean" &&
    bounded(row.mean_power_tracking, 1) &&
    close(row.score, rankingMetrics.reduce((score, field) => score + row[field] * (weights[field] ?? 0), 0)));
}

export async function readCatalogRanking(
  context: Pick<SiteComparison, "run_id" | "range" | "weights" | "step_s" | "precision_h">,
  signal?: AbortSignal, catalogSites?: readonly { id: string }[],
): Promise<CatalogRanking> {
  const { run_id, range, weights } = context;
  signal?.throwIfAborted();
  const { data, error, response } = await producer.GET("/api/v1/ranking", { signal, params: { query: {
    run_id, start: range.start, end: range.end,
    weights: rankingMetrics.map(field => field + ":" + (weights[field] ?? 0)).join(","),
  } } });
  signal?.throwIfAborted();
  if (!response.ok) throw apiError(error, response.status);
  check(data && data.run_id === run_id && data.step_s === context.step_s && data.precision_h === context.precision_h &&
    data.range?.start === range.start && data.range.end === range.end && data.range.step_s === range.step_s &&
    data.range.n_samples === range.n_samples && (data.source === "computed" || data.source === "summary"));
  check(data.weights && Object.keys(data.weights).every(key => rankingMetrics.some(field => field === key)) &&
    rankingMetrics.every(field => (data.weights[field] ?? 0) === (weights[field] ?? 0)) &&
    Array.isArray(data.ranking) && data.ranking.length > 0);
  const duration = range.n_samples * range.step_s / 3600;
  const byId = new Map<string, Row>();
  for (const [i, row] of data.ranking.entries()) {
    checkRow(row, i + 1, duration, weights);
    check(!byId.has(row.site_id));
    if (i > 0) check(rankingInOrder(data.ranking[i - 1], row, weights, range.n_samples));
    byId.set(row.site_id, row);
  }
  const sites = catalogSites ?? await getTerrainDateSites(run_id, signal);
  signal?.throwIfAborted();
  check(byId.size === sites.length && sites.every(site => byId.has(site.id)));
  return data;
}

export async function getCatalogRanking(
  comparison: SiteComparison, signal?: AbortSignal, catalogSites?: readonly { id: string }[],
): Promise<CatalogRanking> {
  if (!comparison.ranking.every(row => comparison.coverageBySite[row.site_id] === "complete"))
    throw new ApiError("The catalog ranking requires complete coverage for both selected sites.", 422);
  const data = await readCatalogRanking(comparison, signal, catalogSites);
  const byId = new Map(data.ranking.map(row => [row.site_id, row]));
  let previousRank = 0;
  for (const selected of comparison.ranking) {
    const catalog = byId.get(selected.site_id);
    check(catalog && catalog.rank > previousRank && catalog.name === selected.name && catalog.group === selected.group &&
      catalog.longest_dark_truncated === selected.longest_dark_truncated &&
      catalog.longest_comms_gap_truncated === selected.longest_comms_gap_truncated);
    for (const field of [...rankingMetrics, "score", "longest_dark_h", "longest_comms_gap_h", "mean_power_tracking"] as const)
      check(close(catalog[field], selected[field]));
    previousRank = catalog.rank;
  }
  return data;
}
