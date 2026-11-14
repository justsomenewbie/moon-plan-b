import { ApiError, apiError, getTerrainAggregate, producer } from "./client.ts";
import { readCatalogRanking, type CatalogRanking } from "./catalog-ranking.ts";
import { terrainUtcNanos, type TerrainSummary } from "./terrain-summary.ts";
import type { components } from "./producer";
import { rankLiveMissionWindows } from "../mission-window-ranking.ts";
import { getTerrainDateSites } from "./terrain-dates.ts";

export type PlannerRun = {
  runId: string; start: string; end: string; stepSeconds: number; sites: Awaited<ReturnType<typeof getTerrainDateSites>>;
};
export type PlannerPriority = "joint" | "sun" | "earth";
export type PlannerDateRequest = { from: string; to: string; priority: PlannerPriority };
export type PlannerRanking = { ranking: CatalogRanking; evidence: TerrainSummary; recommendedIds: string[] };

function requireRun(ok: unknown): asserts ok {
  if (!ok) throw new ApiError("The model run or its site catalog is unavailable.", 502);
}
function requireMatch(ok: unknown): asserts ok {
  if (!ok) throw new ApiError("The catalog ranking and its observation evidence do not match.", 502);
}

export async function getPlannerRun(signal?: AbortSignal, pinnedRunId?: string): Promise<PlannerRun> {
  signal?.throwIfAborted();
  let run: components["schemas"]["RunSummary"] | undefined;
  if (pinnedRunId !== undefined) {
    requireRun(/^[A-Za-z0-9_.-]{1,64}$/.test(pinnedRunId) && pinnedRunId !== "." && pinnedRunId !== "..");
    const { data, error, response } = await producer.GET("/api/v1/runs/{run_id}", { signal, params: { path: { run_id: pinnedRunId } } });
    if (!response.ok) throw apiError(error, response);
    requireRun(data?.run_id === pinnedRunId);
    run = data;
  } else {
    const { data, error, response } = await producer.GET("/api/v1/runs", { signal, params: { query: { limit: 1 } } });
    if (!response.ok) throw apiError(error, response);
    run = data?.runs?.[0];
    requireRun(run && data?.default_run_id === run.run_id && run.is_default === true);
  }
  signal?.throwIfAborted();
  requireRun(run && run.status === "ready" &&
    typeof run.run_id === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(run.run_id) &&
    Number.isSafeInteger(run.step_s) && run.step_s > 0 && Number.isSafeInteger(run.n_samples) && run.n_samples > 0 &&
    typeof run.start_utc === "string" && run.start_utc.length === 20 && typeof run.end_utc === "string" && run.end_utc.length === 20 &&
    terrainUtcNanos(run.end_utc) - terrainUtcNanos(run.start_utc) === BigInt(run.step_s) * BigInt(run.n_samples) * 1_000_000_000n &&
    Array.isArray(run.site_ids) && run.n_sites === run.site_ids.length && run.n_sites > 0);
  const sites = await getTerrainDateSites(run.run_id, signal);
  signal?.throwIfAborted();
  const ids = new Set(run.site_ids);
  requireRun(sites.length === run.n_sites && ids.size === sites.length && sites.every(site => ids.has(site.id)));
  return { runId: run.run_id, start: run.start_utc, end: run.end_utc, stepSeconds: run.step_s, sites };
}

async function getCatalogEvidence(run: PlannerRun, request: PlannerDateRequest, signal?: AbortSignal) {
  const from = terrainUtcNanos(request.from, "Start UTC"), to = terrainUtcNanos(request.to, "End UTC");
  const runStart = terrainUtcNanos(run.start);
  if (from < runStart || to > terrainUtcNanos(run.end) || to <= from)
    throw new ApiError("Choose an increasing UTC window inside the model run.", 422);
  if (!["joint", "sun", "earth"].includes(request.priority)) throw new ApiError("Choose a visibility priority.", 422);
  signal?.throwIfAborted();
  // The aggregate supplies full-resolution intervals with coverage for every site, without time series.
  const evidence = await getTerrainAggregate({ from: request.from, to: request.to, resolutionSeconds: run.stepSeconds },
    run.sites.map(site => site.id).join(","), run.runId, false, signal);
  const stepNanos = BigInt(run.stepSeconds) * 1_000_000_000n;
  requireMatch(evidence.range.step_s === run.stepSeconds && evidence.range.start === evidence.range.requested_start &&
    evidence.range.end === evidence.range.requested_end && (terrainUtcNanos(evidence.range.start) - runStart) % stepNanos === 0n);
  requireMatch(evidence.sites.every((site, i) => site.name === run.sites[i].name));
  return evidence;
}

export async function getPlannerMissionRanking(run: PlannerRun, request: PlannerDateRequest & { missionHours: number }, signal?: AbortSignal) {
  const hours = request.missionHours;
  if (!Number.isSafeInteger(hours) || hours < 1 || (hours * 3600) % run.stepSeconds !== 0 ||
      BigInt(hours) * 3_600_000_000_000n > terrainUtcNanos(request.to) - terrainUtcNanos(request.from))
    throw new ApiError("Choose a mission duration that fits the travel window and model step.", 422);
  const evidence = await getCatalogEvidence(run, request, signal);
  const ranking = rankLiveMissionWindows(evidence, request);
  requireMatch(ranking);
  return { evidence, ranking };
}

export async function getPlannerRanking(run: PlannerRun, request: PlannerDateRequest, signal?: AbortSignal): Promise<PlannerRanking> {
  const evidence = await getCatalogEvidence(run, request, signal);
  const metric = ({ joint: "pct_both", sun: "pct_sun", earth: "pct_earth" } as const)[request.priority];
  const ranking = await readCatalogRanking({ run_id: run.runId, range: evidence.range, step_s: run.stepSeconds,
    precision_h: run.stepSeconds / 3600, weights: { [metric]: 1 } }, signal, run.sites);
  const byId = new Map(evidence.sites.map(site => [site.id, site]));
  const recommendedIds: string[] = [];
  let best: number | undefined;
  for (const row of ranking.ranking) {
    const site = byId.get(row.site_id);
    requireMatch(site && site.name === row.name);
    if (site.coverage !== "complete" || site.coverage_in_range !== "complete") continue;
    const metrics = site.metrics;
    requireMatch(metrics);
    requireMatch((["pct_sun", "pct_earth", "pct_both", "longest_dark_h", "longest_comms_gap_h"] as const)
      .every(key => Math.abs(row[key] - metrics[key]) <= 0.000002));
    best ??= row.score;
    if (row.score === best) recommendedIds.push(row.site_id);
  }
  return { ranking, evidence, recommendedIds };
}
