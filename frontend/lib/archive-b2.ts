import catalog from "../public/data/run-b2/catalog.json" with { type: "json" };
import archive from "../public/data/run-b2/visibility.json" with { type: "json" };

type Priority = "joint" | "sun" | "earth";
type Request = { from: string; to: string; priority: Priority };
type Body = "sun" | "earth" | "both";
type Edges = Record<Body, number[]>;
type Counts = { sunHours: number; earthHours: number; bothHours: number };
type Candidate = { hour: number; score: number };

const HOUR = 3600000;
const origin = Date.parse(archive.start);
const masks: Record<string, Edges> = archive.sites;
const selected = { joint: "bothHours", sun: "sunHours", earth: "earthHours" } as const;
const provenance = { runId: archive.runId, manifestSha256: archive.manifestSha256, stepSeconds: archive.stepSeconds };
export const archiveB2Run = {
  ...provenance, start: archive.start, end: archive.end,
  sites: catalog.sites.map(s => ({ id: s.id, name: s.name, group: s.group, lat_deg: s.lat_deg, lon_deg: s.lon_deg,
    demSource: s.dem_source, horizonMethod: s.horizon_method })),
};

function iso(hour: number) {
  return new Date(origin + hour * HOUR).toISOString().replace(".000Z", "Z");
}
function hourIndex(value: string) {
  const match = /^(\d{4}-\d\d-\d\d)(?:T(\d\d):00(?::00)?Z?)?$/.exec(value);
  if (!match) return NaN;
  const normalized = match[1] + "T" + (match[2] ?? "00") + ":00:00Z";
  const hour = (Date.parse(normalized) - origin) / HOUR;
  return Number.isSafeInteger(hour) && iso(hour) === normalized ? hour : NaN;
}
function bounds(request: Request) {
  const start = hourIndex(request.from), end = hourIndex(request.to);
  return Object.hasOwn(selected, request.priority) && start >= 0 && end > start && end <= archive.sampleCount ? { start, end } : null;
}
function observed(edges: number[], start: number, end: number) {
  let hours = 0;
  for (let i = 0; i < edges.length && edges[i] < end; i += 2)
    hours += Math.max(0, Math.min(end, edges[i + 1]) - Math.max(start, edges[i]));
  return hours;
}

// Counts and ties are hourly model samples. Each window is [start,end) in UTC.
export function rankArchiveB2(request: Request) {
  const range = bounds(request);
  if (!range) return null;
  const { start, end } = range, duration = end - start;
  const pct = (n: number) => Number((100 * n / duration).toFixed(6));
  const rows = archiveB2Run.sites.map(({ id, name }) => {
    const mask = masks[id];
    const sunHours = observed(mask.sun, start, end), earthHours = observed(mask.earth, start, end), bothHours = observed(mask.both, start, end);
    return { id, name, sunHours, earthHours, bothHours, pctSun: pct(sunHours), pctEarth: pct(earthHours), pctBoth: pct(bothHours) };
  });
  const field = selected[request.priority];
  rows.sort((a, b) => b[field] - a[field] || a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
  return { ...provenance, from: iso(start), to: iso(end), scope: "catalog" as const, rows,
    leaders: rows.filter(row => row[field] === rows[0][field]).map(row => row.id) };
}

// One prefix per hour lets all 43,824 candidate starts be scored in O(hours + windows).
function prefix(edges: number[], start: number, end: number) {
  const sums = new Uint32Array(end - start + 1);
  let i = 0;
  for (let h = start; h < end; h++) {
    while (i < edges.length && edges[i + 1] <= h) i += 2;
    sums[h - start + 1] = sums[h - start] + Number(i < edges.length && edges[i] <= h);
  }
  return sums;
}

export function searchArchiveB2(request: Request & { siteId: string; missionHours: number; earliest?: string; latest?: string }) {
  const range = bounds(request);
  const site = archiveB2Run.sites.find(s => s.id === request.siteId);
  const duration = request.missionHours;
  if (!range || !site || !Number.isSafeInteger(duration) || duration < 1 || duration > range.end - range.start) return null;
  const first = request.earliest ? hourIndex(request.earliest) : range.start;
  const last = request.latest ? hourIndex(request.latest) : range.end - duration;
  if (!(range.start <= first && first <= last && last <= range.end - duration)) return null;

  const edges = masks[site.id];
  const sums = { sunHours: prefix(edges.sun, first, last + duration), earthHours: prefix(edges.earth, first, last + duration),
    bothHours: prefix(edges.both, first, last + duration) };
  const hours = (key: keyof Counts, hour: number) => sums[key][hour - first + duration] - sums[key][hour - first];
  const top: Candidate[] = [];
  let best = -1, ties = 0;
  for (let hour = first; hour <= last; hour++) {
    const score = hours(selected[request.priority], hour);
    if (score > best) { best = score; ties = 1; }
    else if (score === best) ties++;
    // Scanning chronologically keeps the earliest starts within each tied score.
    if (top.length === 5 && score <= top[4].score) continue;
    const at = top.findIndex(candidate => candidate.score < score);
    top.splice(at === -1 ? top.length : at, 0, { hour, score });
    if (top.length > 5) top.pop();
  }
  const rows = top.map(({ hour }) => ({ start: iso(hour), end: iso(hour + duration),
    sunHours: hours("sunHours", hour), earthHours: hours("earthHours", hour), bothHours: hours("bothHours", hour) }));
  return { ...provenance, from: iso(range.start), to: iso(range.end), siteId: site.id, name: site.name,
    nEvaluated: last - first + 1, best, ties, first: iso(first), last: iso(last), rows };
}
