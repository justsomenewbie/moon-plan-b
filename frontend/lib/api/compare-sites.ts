import { utcMillis } from "../dataset.ts";
import { ApiError, apiError, producer } from "./client.ts";
import type { components } from "./producer";

type Schemas = components["schemas"];
type Coverage = "complete" | "partial" | "missing";
export type SiteComparison = Schemas["CompareResponse"] & { coverageBySite: Record<string, Coverage> };
export type SiteComparisonRequest = { runId: string; siteIds: readonly [string, string]; from: string; to: string };

const HOUR = 3600000;
const kinds = ["sun", "earth", "both"] as const;
export const rankingMetrics = ["pct_sun", "pct_earth", "pct_both", "pct_sun_no_earth"] as const;
const weights = { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3, pct_sun_no_earth: 0 };

function check(condition: unknown): asserts condition {
  if (!condition) throw new ApiError("The site comparison is inconsistent with the requested sites or UTC window.", 502);
}
function close(a: number, b: number) {
  return Number.isFinite(a) && Math.abs(a - b) <= 0.000002;
}
// Different visibility percentages can produce the same six-decimal score in the response.
export function rankingInOrder(first: Schemas["RankingRow"], next: Schemas["RankingRow"],
    scoreWeights: Record<string, number>, samples: number, complete = true) {
  if (first.score !== next.score) return first.score > next.score;
  if (!complete || 100 / samples <= 0.000002) return true;
  const sameInputs = rankingMetrics.every(field => !scoreWeights[field] || (
    first[field] === next[field] && close(first[field], 100 * Math.round(first[field] * samples / 100) / samples)
  ));
  return !sameInputs || first.longest_dark_h < next.longest_dark_h ||
    (first.longest_dark_h === next.longest_dark_h && first.site_id < next.site_id);
}
function within(value: number, max: number) {
  return Number.isFinite(value) && value >= 0 && value <= max;
}
function strings(value: unknown) {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function sourceTime(value: string) {
  check(typeof value === "string" && value.length === 20);
  try { return utcMillis(value); } catch { throw new ApiError("The site comparison returned an invalid UTC instant.", 502); }
}

// Each kind contains visible AND hidden spans. Only a contiguous partition covers the entire evaluated window.
function checkSite(site: Schemas["CompareSite"], rank: Schemas["RankingRow"], start: number, end: number, step: number) {
  const metrics = site?.metrics, windows = site?.windows;
  const duration = (end - start) / HOUR;
  check(metrics && windows && strings(site.warnings) && close(metrics.duration_h, duration));
  const spans = kinds.map(kind => {
    const intervals = windows[kind];
    check(Array.isArray(intervals));
    let previous = start;
    return intervals.map(w => {
      check(w && typeof w.state === "boolean" &&
        [w.clipped_start, w.clipped_end, w.truncated_start, w.truncated_end].every(flag => typeof flag === "boolean"));
      const a = sourceTime(w.start), b = sourceTime(w.end);
      check(a >= previous && b > a && b <= end && (a - start) % step === 0 && (b - start) % step === 0 && close(w.duration_h, (b - a) / HOUR));
      previous = b;
      return { start: a, end: b, state: w.state };
    });
  });
  let coverage: Coverage = "complete";
  if (spans.every(list => !list.length)) coverage = "missing";
  else if (spans.some(list => list.reduce((sum, w) => sum + (w.end - w.start), 0) !== end - start)) coverage = "partial";
  for (const field of rankingMetrics) check(within(metrics[field], 100) && close(rank[field], metrics[field]));
  check(metrics.pct_both + 0.000002 >= metrics.pct_sun + metrics.pct_earth - 100 &&
    metrics.pct_both <= Math.min(metrics.pct_sun, metrics.pct_earth) + 0.000002 &&
    close(metrics.pct_sun_no_earth, metrics.pct_sun - metrics.pct_both));
  for (const field of ["longest_dark_h", "longest_comms_gap_h", "longest_sun_h", "longest_earth_h"] as const)
    check(within(metrics[field], duration));
  for (const field of ["longest_dark_truncated", "longest_comms_gap_truncated", "longest_sun_truncated", "longest_earth_truncated"] as const)
    check(typeof metrics[field] === "boolean");
  for (const field of ["n_sun_windows", "n_dark_windows", "n_earth_windows", "n_comms_gaps"] as const)
    check(Number.isSafeInteger(metrics[field]) && metrics[field] >= 0);
  check((metrics.mean_sun_el_lit_deg === null || (Number.isFinite(metrics.mean_sun_el_lit_deg) && Math.abs(metrics.mean_sun_el_lit_deg) <= 90)) &&
    within(metrics.mean_power_tracking, 1) && within(metrics.mean_power_horizontal, 1));
  for (const field of ["longest_dark_h", "longest_comms_gap_h", "longest_dark_truncated", "longest_comms_gap_truncated", "mean_power_tracking"] as const)
    check(rank[field] === metrics[field]);
  // Advance only to supplied edges. A gap contributes no known state.
  const cursor = [0, 0, 0];
  for (let time = start; time < end;) {
    let next = end;
    const [sun, earth, both] = spans.map((list, i) => {
      const w = list[cursor[i]];
      if (!w) return undefined;
      next = Math.min(next, time < w.start ? w.start : w.end);
      return time < w.start ? undefined : w.state;
    });
    if (both === true) check(sun !== false && earth !== false);
    if (both === false) check(sun !== true || earth !== true);
    time = next;
    spans.forEach((list, i) => { if (list[cursor[i]]?.end === time) cursor[i]++; });
  }
  if (coverage === "complete") {
    for (const [i, kind] of kinds.entries()) {
      const visible = spans[i].reduce((sum, w) => w.state ? sum + (w.end - w.start) : sum, 0);
      check(close(metrics[`pct_${kind}`], 100 * visible / (end - start)));
    }
    let dark = 0, longestDark = 0;
    for (const w of spans[0]) {
      dark = w.state ? 0 : dark + (w.end - w.start);
      longestDark = Math.max(longestDark, dark);
    }
    check(close(metrics.longest_dark_h, longestDark / HOUR));
  }
  return coverage;
}

export async function compareSites(request: SiteComparisonRequest, signal?: AbortSignal): Promise<SiteComparison> {
  const { siteIds, runId, from, to } = request;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(runId) || siteIds.length !== 2 || siteIds[0] === siteIds[1] ||
      !siteIds.every(id => /^[A-Za-z0-9_.:-]{1,64}$/.test(id)))
    throw new ApiError("Choose two different sites from the same model run.", 422);
  const first = utcMillis(from, "Start UTC"), last = utcMillis(to, "End UTC");
  if (last <= first) throw new ApiError("Choose an increasing UTC range for the site comparison.", 422);
  const wireEnd = last % 1000 ? new Date(Math.ceil(last / 1000) * 1000).toISOString().replace(".000Z", "Z") : to;
  if (wireEnd.startsWith("+")) throw new ApiError("End UTC exceeds the supported four-digit year.", 422);
  signal?.throwIfAborted();
  const { data, error, response } = await producer.POST("/api/v1/compare", { signal, body: {
    run_id: runId, site_ids: [...siteIds], start: from, end: wireEnd,
    weights: { ...weights }, include: { windows: [...kinds] },
  } });
  signal?.throwIfAborted();
  if (!response.ok) throw apiError(error, response);
  check(data?.run_id === runId && data.range && Number.isSafeInteger(data.step_s) && data.step_s > 0 &&
    data.range.step_s === data.step_s && data.precision_h === data.step_s / 3600);
  const start = sourceTime(data.range.start), end = sourceTime(data.range.end), step = data.step_s * 1000;
  check(start <= first && first - start < step && end >= last && end - last < step &&
    Number.isSafeInteger(data.range.n_samples) && data.range.n_samples > 0 && end - start === step * data.range.n_samples);
  check(data.weights && rankingMetrics.every(field => (data.weights[field] ?? 0) === weights[field]) &&
    data.sites && Object.keys(data.sites).length === 2 && siteIds.every(id => Object.hasOwn(data.sites, id)) &&
    Array.isArray(data.ranking) && data.ranking.length === 2);
  const coverageBySite: Record<string, Coverage> = Object.create(null);
  for (const [i, row] of data.ranking.entries()) {
    check(row && row.rank === i + 1 && siteIds.includes(row.site_id) && !Object.hasOwn(coverageBySite, row.site_id) &&
      typeof row.name === "string" && row.name.length && typeof row.group === "string" && strings(row.reasons));
    coverageBySite[row.site_id] = checkSite(data.sites[row.site_id], row, start, end, step);
    check(close(row.score, rankingMetrics.reduce((sum, f) => sum + weights[f] * row[f], 0)));
    if (i > 0) {
      const prior = data.ranking[i - 1];
      check(rankingInOrder(prior, row, weights, data.range.n_samples,
        coverageBySite[prior.site_id] === "complete" && coverageBySite[row.site_id] === "complete"));
    }
  }
  return { ...data, coverageBySite };
}
