import { archiveB2Run, searchArchiveB2 } from "./archive-b2.ts";
import { getSavedPlannerDates, getSavedPlannerRanking, savedPlannerRun, savedPlannerWindows } from "./saved-planner.ts";
import { utcMillis } from "./dataset.ts";
import type { TerrainSummary } from "./api/terrain-summary.ts";

export type MissionWindowRequest = { from: string; to: string; priority: "joint" | "sun" | "earth"; missionHours: number };
type MissionWindowRow = { id: string; name: string; start: string; end: string; sunHours: number; earthHours: number; bothHours: number; ties: number };
export type MissionWindowRanking = {
  runId: string; from: string; to: string; missionHours: number; stepSeconds: number; nEvaluated: number;
  scope: "catalog" | "pair"; leaders: string[]; rows: MissionWindowRow[]; excludedIds: string[];
};

const HOUR = 3_600_000;
const field = { joint: "bothHours", sun: "sunHours", earth: "earthHours" } as const;
const format = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
function grid(request: MissionWindowRequest, stepSeconds: number) {
  function time(s: string) { return utcMillis(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00Z" : s); }
  if (!Object.hasOwn(field, request.priority) || !Number.isSafeInteger(stepSeconds) || stepSeconds < 1 ||
      !Number.isFinite(request.missionHours) || request.missionHours <= 0) return null;
  let start, end;
  try { start = time(request.from); end = time(request.to); } catch { return null; }
  const step = stepSeconds * 1000, count = (end - start) / step, duration = request.missionHours * HOUR / step;
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(duration) || duration < 1 || duration > count) return null;
  return { start, end, step, count, duration, nEvaluated: count - duration + 1 };
}

function ranked(request: MissionWindowRequest, result: Omit<MissionWindowRanking, "leaders">): MissionWindowRanking {
  const metric = field[request.priority];
  result.rows.sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
  return { ...result, leaders: result.rows.filter(row => row[metric] === result.rows[0][metric]).map(row => row.id) };
}

export function rankSavedMissionWindows(source: "saved-b2" | "saved", request: MissionWindowRequest): MissionWindowRanking | null {
  const b2 = source === "saved-b2", run = b2 ? archiveB2Run : savedPlannerRun;
  const range = grid(request, run.stepSeconds);
  if (!range || range.start < Date.parse(run.start) || range.end > Date.parse(run.end)) return null;
  const from = format(range.start), to = format(range.end), normalized = { ...request, from, to };
  const base = { runId: run.runId, from, to, missionHours: request.missionHours, stepSeconds: run.stepSeconds, nEvaluated: range.nEvaluated, excludedIds: [] };
  if (!b2 && range.nEvaluated === 1) {
    const whole = getSavedPlannerRanking(normalized);
    if (whole) return ranked(request, { ...base, scope: whole.scope, rows: whole.rows.map(({ id, name, sunHours, earthHours, bothHours }) =>
      ({ id, name, sunHours, earthHours, bothHours, start: from, end: to, ties: 1 })) });
  }
  const ids = b2 ? run.sites.map(site => site.id) : savedPlannerWindows.pair.siteIds;
  const rows: MissionWindowRow[] = [];
  for (const siteId of ids) {
    const query = { ...normalized, siteId };
    const result = b2 ? searchArchiveB2(query) : getSavedPlannerDates(query);
    if (!result) return null;
    const first = result.rows[0], metric = field[request.priority];
    const ties = "ties" in result ? result.ties : result.rows.filter(row => row[metric] === first[metric]).length;
    rows.push({ id: siteId, name: result.name, ...first, ties });
  }
  return ranked(request, { ...base, scope: b2 ? "catalog" : "pair", rows });
}

type Interval = { start: number; end: number };
function visibleSteps(intervals: Interval[], start: number, end: number) {
  return intervals.reduce((sum, window) => sum + Math.max(0, Math.min(end, window.end) - Math.max(start, window.start)), 0);
}

// Shifting a mission by one sample adds the rightmost sample and removes the leftmost one.
// This difference is constant between visibility edges and edges shifted by the mission length.
function bestStart(intervals: Interval[], duration: number, lastStart: number) {
  let score = visibleSteps(intervals, 0, duration), best = score, first = 0, ties = 1;
  const events = new Map<number, number>([[0, 0], [lastStart, 0]]);
  function change(start: number, end: number, amount: number) {
    const a = Math.max(0, start), b = Math.min(lastStart, end);
    if (a < b) {
      events.set(a, (events.get(a) ?? 0) + amount);
      events.set(b, (events.get(b) ?? 0) - amount);
    }
  }
  for (const { start, end } of intervals) {
    change(start - duration, end - duration, 1);
    change(start, end, -1);
  }
  let previous = 0, slope = 0;
  for (const [stop, delta] of [...events].sort((a, b) => a[0] - b[0])) {
    if (stop > previous) {
      // Count the segment (previous, stop] once; its best is at an end or on the entire plateau.
      const candidate = slope > 0 ? stop : previous + 1;
      const value = score + slope * (candidate - previous);
      const count = slope === 0 ? stop - previous : 1;
      if (value > best) { best = value; first = candidate; ties = count; }
      else if (value === best) ties += count;
      score += slope * (stop - previous);
    }
    previous = stop;
    slope += delta;
  }
  return { first, ties };
}

type VisibleSpan = { start: string; end: string };
export type RetainedSiteWindows = {
  id: string; name: string; complete: boolean;
  windows: Record<"sun" | "earth" | "both", readonly VisibleSpan[]>;
};

export function rankLiveMissionWindows(evidence: TerrainSummary, request: MissionWindowRequest): MissionWindowRanking | null {
  const range = grid(request, evidence.range.step_s);
  if (!range || evidence.range.n_samples !== range.count) return null;
  const from = format(range.start), to = format(range.end);
  if (from !== evidence.range.start || to !== evidence.range.end ||
      from !== evidence.range.requested_start || to !== evidence.range.requested_end) return null;
  return rankRetainedMissionWindows(evidence.run.run_id, evidence.range, evidence.sites.map(site => ({
    ...site, complete: site.coverage === "complete" && site.coverage_in_range === "complete",
  })), request);
}

// Score a requested subrange using only the visible intervals retained for this run.
export function rankRetainedMissionWindows(runId: string, retained: { start: string; end: string; step_s: number },
  sites: readonly RetainedSiteWindows[], request: MissionWindowRequest): MissionWindowRanking | null {
  const range = grid(request, retained.step_s);
  const origin = Date.parse(retained.start), limit = Date.parse(retained.end);
  if (!range || range.start < origin || range.end > limit || (range.start - origin) % range.step !== 0) return null;
  const rows: MissionWindowRow[] = [], excludedIds: string[] = [];
  for (const site of sites) {
    if (!site.complete) {
      excludedIds.push(site.id);
      continue;
    }
    const windows: Record<"sun" | "earth" | "both", Interval[]> = { sun: [], earth: [], both: [] };
    for (const key of ["sun", "earth", "both"] as const) {
      let previousEnd = origin;
      for (const window of site.windows[key]) {
        const start = Date.parse(window.start), end = Date.parse(window.end);
        if (!Number.isSafeInteger((start - origin) / range.step) || !Number.isSafeInteger((end - origin) / range.step) ||
            start < previousEnd || end <= start || end > limit) return null;
        const clippedStart = Math.max(range.start, start), clippedEnd = Math.min(range.end, end);
        if (clippedStart < clippedEnd) windows[key].push({ start: (clippedStart - range.start) / range.step, end: (clippedEnd - range.start) / range.step });
        previousEnd = end;
      }
    }
    const objective = request.priority === "joint" ? "both" : request.priority;
    const { first, ties } = bestStart(windows[objective], range.duration, range.count - range.duration);
    const last = first + range.duration, hours = (key: keyof typeof windows) => visibleSteps(windows[key], first, last) * range.step / HOUR;
    rows.push({ id: site.id, name: site.name, start: format(range.start + first * range.step), end: format(range.start + last * range.step),
      sunHours: hours("sun"), earthHours: hours("earth"), bothHours: hours("both"), ties });
  }
  return ranked(request, { runId, from: format(range.start), to: format(range.end), missionHours: request.missionHours,
    stepSeconds: retained.step_s, nEvaluated: range.nEvaluated, scope: "catalog", rows, excludedIds });
}
