// AI-assisted semantic validation. API types are generated from the shared draft contract.
import type { components } from "./api/schema";
export type Angles = components["schemas"]["Angles"];
export type Sample = components["schemas"]["Sample"];
export type Interval = components["schemas"]["Interval"];
export type Scenario = components["schemas"]["Scenario"];
export type Dataset = components["schemas"]["Dataset"];

type RecordValue = Record<string, unknown>;
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function record(value: unknown, path: string): RecordValue {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${path} must be an object.`);
  return value as RecordValue;
}
function list(value: unknown, path: string, maximum = 10000): unknown[] {
  requireValue(Array.isArray(value) && value.length <= maximum, `${path} must be an array with at most ${maximum} items.`);
  return value;
}
function text(value: unknown, path: string): string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= 2000, `${path} must be nonempty text (up to 2000 characters).`);
  return value;
}
function number(value: unknown, path: string, min: number, max: number): number {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max, `${path} must be a finite number between ${min} and ${max}.`);
  return value;
}
export function utcMillis(value: unknown, path = "Timestamp"): number {
  requireValue(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value), `${path} must be an ISO UTC timestamp ending in Z.`);
  const time = Date.parse(value);
  requireValue(Number.isFinite(time) && new Date(time).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z")), `${path} is not a real calendar instant.`);
  return time;
}
function link(value: unknown, path: string) {
  const url = new URL(text(value, path));
  requireValue(["https:", "http:"].includes(url.protocol) && !url.username && !url.password, `${path} must be an HTTP(S) URL without credentials.`);
}
function ids(items: unknown[], path: string): Set<string> {
  const result = new Set<string>();
  for (const [index, item] of items.entries()) {
    const id = text(record(item, `${path}[${index}]`).id, `${path}[${index}].id`);
    requireValue(/^[a-zA-Z0-9._-]{1,100}$/.test(id) && !result.has(id), `${path} IDs must be unique, short URL-safe identifiers.`);
    result.add(id);
  }
  return result;
}

export function validateDataset(input: unknown): Dataset {
  const d = record(input, "Dataset");
  requireValue(d.schemaVersion === "frontend-draft-2", "Unsupported schema. Expected frontend-draft-2 (pending producer review).");
  text(d.attribution, "Data attribution");
  text(d.datasetId, "datasetId");
  requireValue(d.evidence === "synthetic-fixture" || d.evidence === "computed-ephemeris", "evidence must identify synthetic-fixture or computed-ephemeris.");
  const real = d.evidence === "computed-ephemeris";
  const model = record(d.model, "model");
  for (const key of ["id", "label", "definition"]) text(model[key], `model.${key}`);
  requireValue(model.id === "ideal-horizon-center-v1", "This frontend draft supports only the ideal-horizon center model.");
  requireValue(list(model.limits, "model.limits", 30).length > 0, "Model limitations are required.");
  (model.limits as unknown[]).forEach((v) => text(v, "Model limitation"));
  const criteria = list(d.criteriaHours, "criteriaHours", 30).map((v) => number(v, "Minimum hours", 0.001, 100000));
  requireValue(criteria.length > 0 && new Set(criteria).size === criteria.length, "criteriaHours must contain unique positive thresholds.");
  const sources = list(d.sources, "sources", 200);
  const sourceIds = ids(sources, "sources");
  for (const item of sources) {
    const source = record(item, "Source");
    text(source.title, "Source title"); text(source.version, "Source version");
    link(source.url, "Source URL"); utcMillis(source.retrievedAtUtc, "Source retrieval timestamp");
    requireValue(source.rawSha256 === null || typeof source.rawSha256 === "string" && /^[a-f0-9]{64}$/.test(source.rawSha256), "rawSha256 must be null or a lowercase SHA-256 hash.");
  }
  const references = (value: unknown, path: string) => {
    const refs = list(value, path, 200);
    requireValue(!real || refs.length > 0, `${path} must identify actual sources for computed ephemerides.`);
    for (const ref of refs) requireValue(typeof ref === "string" && sourceIds.has(ref), `${path} contains an unknown source ID.`);
    return refs;
  };
  const sites = list(d.sites, "sites", 100);
  const siteIds = ids(sites, "sites");
  for (const item of sites) {
    const site = record(item, "Site"); text(site.name, "Site name");
    references(site.sourceIds, "Site sourceIds");
    requireValue(!real || site.location !== null, "Computed ephemerides require a sourced location.");
    if (site.location !== null) {
      const loc = record(site.location, "Site location");
      number(loc.latitudeDeg, "Latitude", -90, 90); number(loc.longitudeEastDeg, "East longitude", -180, 180);
      number(loc.elevationKm, "Elevation in km", -100, 100);
      text(loc.frame, "Location frame"); text(loc.elevationDatum, "Elevation datum");
    }
  }
  const scenarios = list(d.scenarios, "scenarios", 500);
  ids(scenarios, "scenarios");
  for (const item of scenarios) {
    const s = record(item, "Scenario");
    requireValue(typeof s.siteId === "string" && siteIds.has(s.siteId), "Scenario references an unknown site.");
    const start = utcMillis(s.startUtc, "Scenario start"), end = utcMillis(s.endUtc, "Scenario end");
    requireValue(end > start, "Scenario end must follow start.");
    const hours = (end - start) / 3600000;
    const step = number(s.sampleStepSeconds, "Sample step in seconds", 1, 31557600) * 1000;
    requireValue(Number.isInteger(s.sampleStepSeconds), "Sample step must be an integer number of seconds.");
    const horizon = list(s.horizonCurve, "Horizon curve", 361);
    requireValue(horizon.length >= 2, "A supplied horizon curve is required.");
    let previousAzimuth = -1;
    for (const point of horizon) {
      const p = record(point, "Horizon point"), azimuth = number(p.azimuthDeg, "Horizon azimuth", 0, 360);
      requireValue(azimuth > previousAzimuth && p.elevationDeg === 0, "The current ideal-horizon model requires an ordered flat curve at zero degrees.");
      previousAzimuth = azimuth;
    }
    requireValue(record(horizon[0], "Horizon").azimuthDeg === 0 && previousAzimuth === 360, "Horizon curve must cover 0 through 360 degrees.");
    requireValue(s.coverage === "complete" || s.coverage === "partial" || s.coverage === "missing", "Unknown coverage state.");
    const refs = references(s.sourceIds, "Scenario sourceIds");
    if (s.evidenceUrl !== null) link(s.evidenceUrl, "Scenario evidence URL");
    requireValue(!real || s.evidenceUrl !== null && sources.some((v) => refs.includes(record(v, "Source").id) && record(v, "Source").rawSha256 !== null), "Computed ephemerides need a processing-evidence URL and referenced raw-response hash.");
    const samples = list(s.samples, "samples");
    let previous = start - 1;
    let hasMissing = false;
    for (const item of samples) {
      const sample = record(item, "Sample"), time = utcMillis(sample.utc, "Sample timestamp");
      requireValue(time >= start && time <= end && time > previous, "Samples must be strictly increasing and inside the scenario window.");
      if (previous >= start && time - previous > step) hasMissing = true;
      previous = time;
      for (const body of ["sun", "earth"]) {
        if (sample[body] === null) { hasMissing = true; continue; }
        const angles = record(sample[body], body);
        number(angles.elevationDeg, `${body} elevation`, -90, 90);
        requireValue(number(angles.azimuthDeg, `${body} azimuth`, 0, 360) < 360, "Azimuth must be below 360 degrees.");
      }
    }
    const complete = s.coverage === "complete";
    if (complete) {
      requireValue(samples.length >= 2 && !hasMissing && utcMillis(record(samples[0], "Sample").utc) === start && previous === end, "Complete coverage requires non-null samples at both window boundaries.");
      const m = record(s.metrics, "Complete scenario metrics");
      const sun = number(m.sunAboveHours, "Sun hours", 0, hours), earth = number(m.earthAboveHours, "Earth hours", 0, hours);
      const joint = number(m.simultaneousLongestHours, "Longest joint hours", 0, Math.min(sun, earth));
      const intervals = record(s.intervals, "Complete scenario intervals");
      const bounds: Record<string, { start: number; end: number }[]> = {};
      for (const body of ["sun", "earth", "simultaneous"]) {
        bounds[body] = [];
        let lastEnd = start, sum = 0, longest = 0;
        for (const item of list(intervals[body], `${body} intervals`)) {
          const interval = record(item, "Interval");
          const a = utcMillis(interval.startUtc), b = utcMillis(interval.endUtc);
          requireValue(a >= lastEnd && b > a && b <= end, "Intervals must be ordered, disjoint and inside the window.");
          requireValue(typeof interval.endClipped === "boolean" && (!interval.endClipped || b === end), "Clipped intervals must end at the window boundary.");
          bounds[body].push({ start: a, end: b });
          lastEnd = b; sum += (b - a) / 3600000; longest = Math.max(longest, (b - a) / 3600000);
        }
        const expected = body === "sun" ? sun : body === "earth" ? earth : joint;
        requireValue(Math.abs((body === "simultaneous" ? longest : sum) - expected) < 0.001, `${body} interval duration does not match supplied metrics.`);
      }
      // Ordered, disjoint intervals permit a linear scan; repeated searches can stall an importing tab.
      for (const body of ["sun", "earth"]) {
        let cursor = 0;
        for (const item of bounds.simultaneous) {
          while (cursor < bounds[body].length && bounds[body][cursor].end < item.end) cursor++;
          const container = bounds[body][cursor];
          requireValue(container && container.start <= item.start && container.end >= item.end, "A simultaneous interval must be contained in both supplied body intervals.");
        }
      }
    } else {
      requireValue(s.metrics === null && s.intervals === null, "Incomplete coverage must keep metrics and intervals null, never zero.");
      requireValue(s.coverage !== "missing" || samples.length === 0, "Missing coverage must have no samples.");
    }
    const assessments = list(s.criteria, "Scenario criteria", 30);
    requireValue(assessments.length === criteria.length, "Each scenario needs one assessment per released criterion.");
    const seen = new Set<number>();
    for (const item of assessments) {
      const c = record(item, "Criterion");
      requireValue(typeof c.minimumHours === "number" && criteria.includes(c.minimumHours) && !seen.has(c.minimumHours), "Criterion is duplicated or not released.");
      seen.add(c.minimumHours);
      requireValue(typeof c.result === "string" && ["meets", "below", "borderline", "unknown"].includes(c.result) && (complete || c.result === "unknown"), "Criterion result is invalid for this coverage.");
      if (complete && (c.result === "meets" || c.result === "below")) {
        const joint = (s.metrics as Scenario["metrics"])!.simultaneousLongestHours;
        requireValue(c.result === "meets" ? joint >= c.minimumHours : joint < c.minimumHours, "Criterion contradicts the supplied joint-window duration.");
      }
      text(c.reason, "Criterion explanation");
    }
  }
  return input as Dataset;
}

export const durationHours = (s: Scenario) => (Date.parse(s.endUtc) - Date.parse(s.startUtc)) / 3600000;
export type Mode = "dates" | "sites";
export type Selection = { mode: Mode; a: string; b: string; h: number };
export function alternatives(d: Dataset, a: Scenario, mode: Mode): Scenario[] {
  return d.scenarios.filter((s) => s.id !== a.id && durationHours(s) === durationHours(a) && (mode === "dates"
    ? s.siteId === a.siteId && Date.parse(s.startUtc) !== Date.parse(a.startUtc)
    : s.siteId !== a.siteId && Date.parse(s.startUtc) === Date.parse(a.startUtc) && Date.parse(s.endUtc) === Date.parse(a.endUtc)));
}
export function initialSelection(d: Dataset): Selection | null {
  const a = d.scenarios[0];
  return a ? { mode: "dates", a: a.id, b: alternatives(d, a, "dates")[0]?.id ?? "", h: d.criteriaHours[0] } : null;
}
export function laterMatch(d: Dataset, a: Scenario, h: number): { candidate?: Scenario; unresolvedBefore: boolean } {
  let unresolvedBefore = false;
  const candidates = alternatives(d, a, "dates").filter((s) => Date.parse(s.startUtc) > Date.parse(a.startUtc)).sort((x, y) => Date.parse(x.startUtc) - Date.parse(y.startUtc));
  for (const candidate of candidates) {
    const result = candidate.criteria.find((c) => c.minimumHours === h)?.result;
    if (result === "meets") return { candidate, unresolvedBefore };
    if (result !== "below") unresolvedBefore = true;
  }
  return { unresolvedBefore };
}
export function readSelection(params: URLSearchParams, d: Dataset): Selection | null {
  const keys = ["v", "mode", "a", "b", "duration", "h"];
  if (!keys.some((k) => params.has(k))) return initialSelection(d);
  requireValue(keys.every((k) => params.getAll(k).length === 1), "The shared selection is incomplete or contains duplicate fields.");
  requireValue(params.get("v") === d.datasetId, "This link needs a different dataset version. Import that exact release before reopening it.");
  const mode = params.get("mode");
  requireValue(mode === "dates" || mode === "sites", "The comparison mode in this link is invalid.");
  const a = d.scenarios.find((s) => s.id === params.get("a"));
  requireValue(a && durationHours(a) === Number(params.get("duration")), "The primary scenario or duration is not available in this release.");
  const b = params.get("b") ?? "";
  requireValue(alternatives(d, a, mode).some((s) => s.id === b), "The comparison pair in this link is incompatible or unavailable.");
  const h = Number(params.get("h"));
  requireValue(d.criteriaHours.includes(h), "This criterion is not available in this release.");
  return { mode, a: a.id, b, h };
}
export function selectionParams(d: Dataset, s: Selection): URLSearchParams {
  const a = d.scenarios.find((v) => v.id === s.a)!;
  return new URLSearchParams({ v: d.datasetId, mode: s.mode, a: s.a, b: s.b, duration: String(durationHours(a)), h: String(s.h) });
}

export function commonOffsets(a: Scenario, b?: Scenario): number[] {
  const offsets = a.samples.map((s) => Date.parse(s.utc) - Date.parse(a.startUtc));
  if (!b) return offsets;
  const other = new Set(b.samples.map((s) => Date.parse(s.utc) - Date.parse(b.startUtc)));
  return offsets.filter((n) => other.has(n));
}
export function sampleAt(s: Scenario, offset: number): Sample | undefined {
  return s.samples.find((v) => Date.parse(v.utc) - Date.parse(s.startUtc) === offset);
}
export function skyPath(s: Scenario, body: "sun" | "earth"): string {
  let previousAzimuth: number | null = null;
  let previousTime = 0;
  return s.samples.map((sample) => {
    const value = sample[body];
    if (!value) { previousAzimuth = null; return ""; }
    const time = Date.parse(sample.utc);
    const move = previousAzimuth === null || time - previousTime > s.sampleStepSeconds * 1000 || Math.abs(value.azimuthDeg - previousAzimuth) > 180;
    previousAzimuth = value.azimuthDeg; previousTime = time;
    return `${move ? "M" : "L"}${value.azimuthDeg},${90 - value.elevationDeg}`;
  }).join(" ");
}
export function chartPath(s: Scenario, body: "sun" | "earth", width = 800, height = 240): string {
  let open = false;
  let previous = Date.parse(s.startUtc);
  return s.samples.map((sample) => {
    const time = Date.parse(sample.utc);
    if (time - previous > s.sampleStepSeconds * 1000) open = false;
    previous = time;
    if (sample[body] === null) { open = false; return ""; }
    const x = (Date.parse(sample.utc) - Date.parse(s.startUtc)) / (Date.parse(s.endUtc) - Date.parse(s.startUtc)) * width;
    const y = (90 - sample[body].elevationDeg) / 180 * height;
    const result = `${open ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    open = true; return result;
  }).join(" ");
}
