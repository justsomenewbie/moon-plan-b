// Checks the intervals, summary and any supplied plotting data against the producer contract.
import { utcMillis } from "../dataset.ts";
import type { components } from "./producer";

type Row = Record<string, unknown>;
type Coverage = "complete" | "partial" | "missing";
type Span = { start: number; end: number };
const HOUR = 3_600_000;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function row(value: unknown, field: string): Row {
  check(value && typeof value === "object" && !Array.isArray(value), `Invalid ${field} object.`);
  return value as Row;
}
function items(value: unknown, field: string, max: number): unknown[] {
  check(Array.isArray(value) && value.length <= max, `Invalid ${field} list (limit ${max}).`);
  return value;
}
function text(value: unknown, field: string): string {
  check(typeof value === "string" && value.trim() && value.length <= 4096, `Invalid ${field} text.`);
  return value;
}
function number(value: unknown, field: string): number {
  check(typeof value === "number" && Number.isFinite(value), `Invalid ${field} number.`);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  check(typeof value === "boolean", `Invalid ${field} flag.`);
  return value;
}
function identifier(value: unknown, field: string, pattern: RegExp): string {
  const id = text(value, field);
  check(pattern.test(id), `Invalid ${field} identifier.`);
  return id;
}
function sha256(value: unknown): string {
  return identifier(value, "SHA-256", /^[a-f0-9]{64}$/i);
}
function link(value: unknown, manifest = false): string {
  const href = text(value, manifest ? "manifest URL" : "source URL");
  check(href === href.trim() && !/[\\\u0000-\u001f\u007f]/.test(href), "Invalid provenance URL.");
  if (manifest) {
    check(href.startsWith("/") && !href.startsWith("//"), "Expected a same-origin manifest path.");
  } else {
    const url = new URL(href);
    check(["https:", "http:"].includes(url.protocol) && !url.username && !url.password, "Expected an HTTP(S) source URL without credentials.");
  }
  return href;
}
function utc(value: unknown, field: string): string {
  const stamp = text(value, field);
  check(stamp.length === 20, `Expected a whole-second UTC ${field}.`);
  utcMillis(stamp, field);
  return stamp;
}

// Relative arithmetic preserves sub-millisecond inputs supported by the producer at a grid boundary.
function secondsFromBoundary(input: string, boundary: string): number {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(input);
  check(match, "Invalid requested UTC instant.");
  return (utcMillis(match[1] + "Z") - Date.parse(boundary)) / 1000 + Number("0." + (match[2] ?? "0"));
}
function readRange(value: unknown, request?: { from: string; to: string }) {
  const r = row(value, "range");
  const start = utc(r.start, "start"), end = utc(r.end, "end");
  const requested_start = utc(r.requested_start, "requested start"), requested_end = utc(r.requested_end, "requested end");
  const step_s = number(r.step_s, "step_s"), n_samples = number(r.n_samples, "n_samples");
  const stepMs = step_s * 1000;
  const startMs = Date.parse(start), endMs = Date.parse(end);
  check(Number.isSafeInteger(step_s) && step_s > 0 && Number.isSafeInteger(n_samples) && n_samples > 0 &&
    endMs - startMs === n_samples * stepMs, "Inconsistent sample grid for the evaluated UTC range.");
  check(requested_start <= start && end <= requested_end &&
    (startMs - Date.parse(requested_start)) % stepMs === 0 && (Date.parse(requested_end) - endMs) % stepMs === 0,
    "Evaluated UTC range falls outside the requested grid.");
  if (request) {
    const fromOffset = secondsFromBoundary(request.from, requested_start);
    const toOffset = secondsFromBoundary(request.to, requested_end);
    check(secondsFromBoundary(request.to, requested_start) > fromOffset &&
      fromOffset >= 0 && fromOffset < step_s && toOffset <= 0 && toOffset > -step_s, "The response describes a different requested UTC range.");
  }
  return { start, end, requested_start, requested_end, step_s, n_samples };
}
type Range = ReturnType<typeof readRange>;

function readRun(value: unknown) {
  const r = row(value, "run");
  return {
    run_id: identifier(r.run_id, "run", /^[A-Za-z0-9_.-]{1,64}$/), label: text(r.label, "run label"),
    provider: text(r.provider, "provider"), dem: text(r.dem, "DEM"), horizon_method: text(r.horizon_method, "horizon method"),
    code_version: text(r.code_version, "code version"), run_timestamp_utc: text(r.run_timestamp_utc, "run timestamp"),
    observer_height_m: number(r.observer_height_m, "observer height"), min_earth_clearance_deg: number(r.min_earth_clearance_deg, "Earth clearance"),
    git_commit: r.git_commit === null ? null : text(r.git_commit, "git commit"),
    manifest_sha256: sha256(r.manifest_sha256), manifest_url: link(r.manifest_url, true),
  };
}
function readModel(value: unknown) {
  const m = row(value, "model");
  check(m.id === "lunarnav-terrain-horizon-v1", "Unsupported terrain visibility model.");
  const limits = items(m.limits, "model limitations", 100).map(item => text(item, "model limitation"));
  check(limits.length, "Model limitations are missing.");
  return { id: text(m.id, "model ID"), label: text(m.label, "model label"), definition: text(m.definition, "model definition"), limits };
}
function coverage(value: unknown): Coverage {
  check(value === "complete" || value === "partial" || value === "missing", "Unknown site coverage.");
  return value;
}
function close(actual: number, expected: number, field: string) {
  // Backend metrics are rounded to six decimal places.
  check(Math.abs(actual - expected) < 0.000002, `Inconsistent ${field}.`);
}
function readWindows(value: unknown, range: Range, field: string) {
  let previousEnd = range.start;
  return items(value, field, 50000).map(item => {
    const w = row(item, field);
    const start = utc(w.start, "window start"), end = utc(w.end, "window end");
    check(previousEnd <= start && start < end && end <= range.end, `Unordered or out-of-range ${field}.`);
    previousEnd = end;
    const duration_h = number(w.duration_h, "window duration");
    close(duration_h, (Date.parse(end) - Date.parse(start)) / HOUR, "window duration");
    return { start, end, duration_h, clipped_start: boolean(w.clipped_start, "clipped_start"), clipped_end: boolean(w.clipped_end, "clipped_end") };
  });
}
type Windows = ReturnType<typeof readWindows>;

function appendSpan(spans: Span[], start: number, end: number) {
  const last = spans.at(-1);
  if (last?.end === start) last.end = end;
  else spans.push({ start, end });
}
function spans(windows: Windows): Span[] {
  const result: Span[] = [];
  for (const w of windows) appendSpan(result, Date.parse(w.start), Date.parse(w.end));
  return result;
}
function checkOverlap(sun: Span[], earth: Span[], both: Span[]) {
  const expected: Span[] = [];
  for (let i = 0, j = 0; i < sun.length && j < earth.length;) {
    const a = sun[i], b = earth[j];
    const start = Math.max(a.start, b.start), end = Math.min(a.end, b.end);
    if (start < end) appendSpan(expected, start, end);
    if (a.end <= b.end) i++;
    if (b.end <= a.end) j++;
  }
  check(expected.length === both.length && both.every((w, i) => w.start === expected[i].start && w.end === expected[i].end),
    "The simultaneous windows differ from the full Sun/Earth intersection.");
}
const metricNames = ["duration_h", "sun_hours", "earth_hours", "both_hours", "longest_sun_h", "longest_earth_h",
  "longest_both_h", "longest_dark_h", "longest_comms_gap_h", "pct_sun", "pct_earth", "pct_both"] as const;
type Metrics = Record<typeof metricNames[number], number>;

function readMetrics(value: unknown, range: Range, windows: Record<"sun" | "earth" | "both", Span[]>, inRange: Coverage): Metrics | null {
  if (value === null) {
    check(inRange !== "complete", "Complete site coverage requires metrics.");
    return null;
  }
  check(inRange !== "missing", "Missing site coverage cannot have metrics.");
  const m = row(value, "site metrics");
  const duration = (Date.parse(range.end) - Date.parse(range.start)) / HOUR;
  const result = {} as Metrics;
  for (const key of metricNames) {
    const v = number(m[key], key);
    check(v >= 0 && v <= (key.startsWith("pct_") ? 100 : duration + 0.000002), `Out-of-range ${key}.`);
    result[key] = v;
  }
  close(result.duration_h, duration, "evaluated duration");
  for (const body of ["sun", "earth", "both"] as const) {
    let total = 0, longest = 0, longestGap = 0;
    let previousEnd = Date.parse(range.start);
    for (const window of windows[body]) {
      const hours = (window.end - window.start) / HOUR;
      longestGap = Math.max(longestGap, (window.start - previousEnd) / HOUR);
      previousEnd = window.end;
      total += hours;
      longest = Math.max(longest, hours);
    }
    close(result[`${body}_hours`], total, `${body} total`);
    close(result[`longest_${body}_h`], longest, `${body} longest interval`);
    close(result[`pct_${body}`], 100 * total / duration, `${body} percentage`);
    if (inRange === "complete" && body !== "both") {
      const key = body === "sun" ? "longest_dark_h" : "longest_comms_gap_h";
      close(result[key], Math.max(longestGap, (Date.parse(range.end) - previousEnd) / HOUR), key);
    }
  }
  return result;
}
function angles(value: unknown, field: string, length: number, min: number, max: number): number[] {
  const column = items(value, field, length);
  check(column.length === length, `Mismatched ${field} length.`);
  return column.map(entry => {
    const angle = number(entry, field);
    check(angle >= min && angle <= max, `Out-of-range ${field}.`);
    return angle;
  });
}

function readHorizon(value: unknown): components["schemas"]["DatasetHorizon"] {
  const h = row(value, "terrain horizon");
  const step_deg = number(h.step_deg, "horizon step"), source_step_deg = number(h.source_step_deg, "source horizon step");
  const size = Math.round(360 / step_deg) + 1;
  check(step_deg > 0 && source_step_deg > 0 && size >= 2 && size <= 10000, "Invalid horizon grid.");
  const az_deg = angles(h.az_deg, "horizon azimuth", size, 0, 360);
  const el_deg = angles(h.el_deg, "horizon elevation", size, -90, 90);
  az_deg.forEach((az, i) => close(az, i * step_deg, "horizon azimuth grid"));
  close(az_deg[size - 1], 360, "horizon azimuth endpoint");
  close(el_deg[size - 1], el_deg[0], "horizon closure");
  const min_el_deg = number(h.min_el_deg, "horizon minimum"), max_el_deg = number(h.max_el_deg, "horizon maximum");
  const min = Math.min(...el_deg), max = Math.max(...el_deg);
  // A coarser returned profile can omit peaks and troughs of the source silhouette.
  check(min_el_deg >= -90 && max_el_deg <= 90 && min_el_deg <= max_el_deg &&
    min >= min_el_deg - 0.000002 && max <= max_el_deg + 0.000002, "Inconsistent horizon extrema.");
  if (step_deg === source_step_deg) {
    close(min, min_el_deg, "source horizon minimum");
    close(max, max_el_deg, "source horizon maximum");
  }
  return { step_deg, az_deg, el_deg, min_el_deg, max_el_deg, source_step_deg,
    method: text(h.method, "horizon method"), dem_source: text(h.dem_source, "horizon source") };
}

function readSeries(value: unknown, range: Range, inRange: Coverage, windows: Record<"sun" | "earth" | "both", Span[]>): components["schemas"]["DatasetSeries"] {
  const s = row(value, "site series");
  const t = items(s.t, "series timestamps", 10000).map(entry => utc(entry, "series timestamp"));
  const times = t.map(stamp => Date.parse(stamp)), start = Date.parse(range.start), end = Date.parse(range.end);
  const grid = range.step_s * 1000;
  check(times.every((time, i) => time >= start && time < end && (time - start) % grid === 0 && (!i || times[i - 1] < time)), "Series timestamps must increase on the evaluated UTC grid.");
  const step_s = number(s.step_s, "series step"), decimated = boolean(s.decimated, "decimation");
  const n_transitions = number(s.n_transitions, "visibility transitions");
  check(Number.isSafeInteger(step_s) && step_s > 0 && step_s % range.step_s === 0, "Invalid per-site series step.");
  check(Number.isSafeInteger(n_transitions) && n_transitions >= 0, "Invalid visibility transition count.");
  if (inRange === "missing") check(!times.length, "Missing site coverage cannot have series samples.");
  if (inRange === "complete") {
    check(times[0] === start && times.at(-1) === end - grid && decimated === (times.length < range.n_samples), "Incomplete series for the declared coverage and decimation.");
    if (decimated) {
      const retained = new Set(times), stride = step_s * 1000;
      check(Math.ceil((end - start) / stride) <= times.length, "Missing regular series samples.");
      for (let time = start; time < end; time += stride) check(retained.has(time), "Missing regular series sample.");
      for (const body of [windows.sun, windows.earth]) {
        for (const span of body) for (const edge of [span.start, span.end]) {
          if (edge > start && edge < end) check(retained.has(edge - grid) && retained.has(edge), "Missing samples around a visibility transition.");
        }
      }
    }
  }
  function visibility(body: "sun" | "earth" | "both"): boolean[] {
    const field = body + "_visible", flags = items(s[field], field, t.length);
    check(flags.length === t.length, `Mismatched ${field} length.`);
    let cursor = 0;
    const spans = windows[body];
    return flags.map((entry, i) => {
      const visible = boolean(entry, field), time = times[i];
      while (cursor < spans.length && spans[cursor].end <= time) cursor++;
      check(visible === (cursor < spans.length && spans[cursor].start <= time), `${field} contradicts the supplied windows.`);
      return visible;
    });
  }
  const sun_az_deg = angles(s.sun_az_deg, "Sun azimuth", t.length, 0, 360);
  const earth_az_deg = angles(s.earth_az_deg, "Earth azimuth", t.length, 0, 360);
  check(!sun_az_deg.includes(360) && !earth_az_deg.includes(360), "Body azimuth must be below 360 degrees.");
  return { t, step_s, decimated, n_transitions, sun_az_deg, earth_az_deg,
    sun_el_deg: angles(s.sun_el_deg, "Sun elevation", t.length, -90, 90), earth_el_deg: angles(s.earth_el_deg, "Earth elevation", t.length, -90, 90),
    sun_visible: visibility("sun"), earth_visible: visibility("earth"), both_visible: visibility("both") };
}

function readSite(value: unknown, range: Range, include: unknown[]) {
  const s = row(value, "site"), c = coverage(s.coverage), inRange = coverage(s.coverage_in_range);
  const clamped = range.start !== range.requested_start || range.end !== range.requested_end;
  check(c === (clamped && inRange === "complete" ? "partial" : inRange), "Contradictory requested and evaluated site coverage.");
  const w = row(s.windows, "visibility windows");
  const windows = { sun: readWindows(w.sun, range, "Sun windows"), earth: readWindows(w.earth, range, "Earth windows"), both: readWindows(w.both, range, "simultaneous windows") };
  const bodySpans = { sun: spans(windows.sun), earth: spans(windows.earth), both: spans(windows.both) };
  check(inRange !== "missing" || !windows.sun.length && !windows.earth.length && !windows.both.length, "Missing site coverage cannot have visibility windows.");
  checkOverlap(bodySpans.sun, bodySpans.earth, bodySpans.both);
  return {
    id: identifier(s.id, "site", /^[A-Za-z0-9_.:-]{1,64}$/), name: text(s.name, "site name"), coverage: c, coverage_in_range: inRange,
    windows, metrics: readMetrics(s.metrics, range, bodySpans, inRange),
    horizon: include.includes("horizon") && (s.horizon !== undefined || inRange !== "missing") ? readHorizon(s.horizon) : null,
    series: include.includes("series") && (s.series !== undefined || inRange !== "missing") ? readSeries(s.series, range, inRange, bodySpans) : null,
  };
}
function uniqueIds<T extends { id: string }>(rows: T[], field: string): T[] {
  check(new Set(rows.map(r => r.id)).size === rows.length, `Duplicate ${field} ID.`);
  return rows;
}
export function parseTerrainSummary(input: unknown, request?: { from: string; to: string }): TerrainSummary {
  const d = row(input, "dataset");
  check(d.schema_version === "lunarnav-dataset-1" && d.evidence === "computed-ephemeris", "Unsupported terrain dataset schema or evidence.");
  const include = items(d.include, "included sections", 32);
  check(include.includes("windows") && include.includes("metrics"), "The terrain summary needs windows and metrics.");
  const range = readRange(d.range, request);
  const sources = uniqueIds(items(d.sources, "sources", 500).map(item => {
    const s = row(item, "source");
    return { id: identifier(s.id, "source", /^[a-z0-9._-]{1,100}$/), title: text(s.title, "source title"),
      url: s.url === null ? null : link(s.url), sha256: s.sha256 === null ? null : sha256(s.sha256) };
  }), "source");
  return {
    schema_version: d.schema_version, dataset_id: identifier(d.dataset_id, "dataset", /^[A-Za-z0-9._-]{1,100}$/),
    evidence: d.evidence, attribution: text(d.attribution, "attribution"), run: readRun(d.run), model: readModel(d.model),
    range, sources, sites: uniqueIds(items(d.sites, "sites", 100).map(site => readSite(site, range, include)), "site"),
  };
}
export type TerrainSummary = {
  schema_version: "lunarnav-dataset-1"; dataset_id: string; evidence: "computed-ephemeris"; attribution: string;
  run: ReturnType<typeof readRun>; model: ReturnType<typeof readModel>; range: Range;
  sites: ReturnType<typeof readSite>[];
  sources: { id: string; title: string; url: string | null; sha256: string | null }[];
};

export function readTerrainObservation(params: URLSearchParams, result: TerrainSummary) {
  const siteId = params.get("view_site"), at = params.get("at");
  if (siteId === null && at === null) return { siteIndex: 0, sample: 0 };
  const siteIndex = result.sites.findIndex(site => site.id === siteId);
  if (siteIndex < 0) throw new Error("The shared observation site is unavailable in this result.");
  const times = result.sites[siteIndex].series?.t;
  const sample = at === null ? 0 : times?.indexOf(at) ?? -1;
  if (sample < 0) throw new Error("The shared UTC sample was not returned for this site.");
  return { siteIndex, sample };
}
