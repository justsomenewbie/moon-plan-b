import catalog from "../public/data/run-b/catalog.json" with { type: "json" };
import data from "./saved-planner-data.json" with { type: "json" };

type Priority = "joint" | "sun" | "earth";
type Request = { from: string; to: string; priority: Priority };
export type SavedPlannerRow = { id: string; name: string; sunHours: number; earthHours: number; bothHours: number; pctSun: number; pctEarth: number; pctBoth: number };
const HOUR = 3600000;
const pair = data.pairWindow;
type PairId = keyof typeof pair.intervals;
const full = data.catalogWindows[0];
const provenance = { runId: data.runId, manifestSha256: data.manifestSha256, stepSeconds: data.stepSeconds };
export const savedPlannerRun = { ...provenance, start: full.from, end: full.to,
  sites: catalog.sites.map(s => ({ id: s.id, name: s.name, lat_deg: s.lat_deg, lon_deg: s.lon_deg, demSource: s.dem_source, horizonMethod: s.horizon_method })) };
export const savedPlannerWindows = {
  catalog: data.catalogWindows.map(({ from, to }) => ({ from, to })),
  pair: { from: pair.from, to: pair.to, siteIds: Object.keys(pair.intervals) },
};

function bounds(request: Request) {
  if (!["joint", "sun", "earth"].includes(request.priority)) return null;
  const parse = (s: string) => {
    const utc = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00Z" : s;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(utc)) return NaN;
    const ms = Date.parse(utc);
    return Number.isFinite(ms) && new Date(ms).toISOString().replace(".000Z", "Z") === utc ? ms : NaN;
  };
  const start = parse(request.from), end = parse(request.to);
  return start < end ? { start, end } : null;
}

const field = { joint: "bothHours", sun: "sunHours", earth: "earthHours" } as const;
const format = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const ids = Object.keys(pair.intervals) as PairId[];
const spans = new Map(ids.map(id => [id, Object.fromEntries(Object.entries(pair.intervals[id]).map(
  ([metric, list]) => [metric, list.map(([a, b]) => [Date.parse(a), Date.parse(b)])],
)) as Record<"sun" | "earth" | "both", number[][]>]));
function pairHours(id: PairId, start: number, end: number) {
  const site = spans.get(id)!;
  return (["sun", "earth", "both"] as const).map(key => site[key].reduce((hours, [a,b]) =>
    hours + Math.max(0, Math.min(b, end) - Math.max(a, start)) / HOUR, 0));
}
function row(id: string, hours: readonly number[], n: number): SavedPlannerRow {
  const name = savedPlannerRun.sites.find(s => s.id === id)!.name;
  const pct = (h: number) => Number((100 * h / n).toFixed(6));
  return { id, name, sunHours: hours[0], earthHours: hours[1], bothHours: hours[2],
    pctSun: pct(hours[0]), pctEarth: pct(hours[1]), pctBoth: pct(hours[2]) };
}

export function getSavedPlannerRanking(request: Request) {
  const range = bounds(request);
  if (!range) return null;
  const { start, end } = range, from = format(start), to = format(end);
  const catalog = data.catalogWindows.find(w => w.from === from && w.to === to);
  const insidePair = from >= pair.from && to <= pair.to;
  if (!catalog && !insidePair) return null;
  const n = (end - start) / HOUR;
  const rows = catalog ? catalog.counts.map((h, i) => row(data.siteIds[i], h, n)) : ids.map(id => row(id, pairHours(id, start, end), n));
  const key = field[request.priority];
  rows.sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name, "en"));
  const scope: "catalog" | "pair" = catalog ? "catalog" : "pair";
  return { ...provenance, from, to, scope, rows, leaders: rows.filter(r => r[key] === rows[0][key]).map(r => r.id) };
}

// Within the retained pair, rank every native-hour start whose whole mission fits the exact requested window.
export function getSavedPlannerDates(request: Request & { siteId: string; missionHours: number }) {
  const range = bounds(request);
  if (!range || !Object.hasOwn(pair.intervals, request.siteId) || !Number.isSafeInteger(request.missionHours) || request.missionHours < 1
      || format(range.start) < pair.from || format(range.end) > pair.to || request.missionHours * HOUR > range.end - range.start) return null;
  const id = request.siteId as PairId, rows = [];
  for (let t = range.start; t + request.missionHours * HOUR <= range.end; t += HOUR) {
    const end = t + request.missionHours * HOUR;
    const [sunHours, earthHours, bothHours] = pairHours(id, t, end);
    rows.push({ start: format(t), end: format(end), sunHours, earthHours, bothHours });
  }
  const key = field[request.priority];
  rows.sort((a, b) => b[key] - a[key] || a.start.localeCompare(b.start));
  return { ...provenance, siteId: id, name: savedPlannerRun.sites.find(s => s.id === id)!.name,
    from: format(range.start), to: format(range.end), nEvaluated: rows.length, rows };
}
