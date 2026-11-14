import assert from "node:assert/strict";
import test from "node:test";
import { guideObservation } from "../lib/guide-observation.ts";
import { parseTerrainSummary } from "../lib/api/terrain-summary.ts";

const stamp = (hour: number) => `2026-01-01T${String(hour).padStart(2, "0")}:00:00Z`;
const interval = (from: number, to: number) => ({
  start: stamp(from), end: stamp(to), duration_h: to - from, clipped_start: from === 0, clipped_end: to === 8,
});

function example() {
  // Invented eight-hour window with two separate overlaps, included only as a parser test.
  return {
    schema_version: "lunarnav-dataset-1", evidence: "computed-ephemeris", dataset_id: "unit-test.range", attribution: "Test fixture",
    include: ["windows", "metrics"], range: { start: stamp(0), end: stamp(8), requested_start: stamp(0), requested_end: stamp(8), step_s: 3600, n_samples: 8 },
    run: {
      run_id: "unit-test", label: "Parser test run", provider: "test", dem: "test", horizon_method: "test", code_version: "test", run_timestamp_utc: stamp(0),
      observer_height_m: 2, min_earth_clearance_deg: 0, git_commit: null, manifest_sha256: "a".repeat(64), manifest_url: "/api/v1/runs/unit-test/files/manifest.json",
    },
    model: { id: "lunarnav-terrain-horizon-v1", label: "Declared test model", definition: "Test only", limits: ["Synthetic test values"] },
    sources: [{ id: "source", title: "Test reference", url: "https://example.org/reference", sha256: null }],
    sites: [{
      id: "custom:-89.4500:222.6900", name: "Example", coverage: "complete", coverage_in_range: "complete",
      windows: { sun: [interval(0, 2), interval(3, 8)], earth: [interval(1, 5)], both: [interval(1, 2), interval(3, 5)] },
      metrics: { duration_h: 8, sun_hours: 7, earth_hours: 4, both_hours: 3, longest_sun_h: 5, longest_earth_h: 4, longest_both_h: 2,
        longest_dark_h: 1, longest_comms_gap_h: 3, pct_sun: 87.5, pct_earth: 50, pct_both: 37.5 },
    }],
  };
}

test("reads summary-only aggregates and leaves unavailable plotting sections null", () => {
  const d = example();
  const parsed = parseTerrainSummary(d, { from: stamp(0), to: stamp(8) });
  assert.deepEqual(parsed.sites[0].windows, d.sites[0].windows);
  assert.equal(parsed.sites[0].metrics?.both_hours, 3);
  assert.equal(parsed.sites[0].metrics?.longest_both_h, 2);
  assert.deepEqual(parsed.sources, d.sources);
  assert.deepEqual(parsed.run, d.run);
  assert.deepEqual(parsed.model, d.model);
  assert.equal(parsed.sites[0].series, null);
  assert.equal(parsed.sites[0].horizon, null);
});

test("accepts snapped client input and run clamping, rejects wrong request, reversed range and sample count", () => {
  const d = example();
  d.range.requested_end = stamp(9);
  d.sites[0].coverage = "partial";
  const result = parseTerrainSummary(d, { from: "2026-01-01T00:30:00Z", to: "2026-01-01T08:00:00.000000001Z" });
  assert.equal(result.sites[0].coverage_in_range, "complete");
  assert.throws(() => parseTerrainSummary(d, { from: stamp(0), to: stamp(8) }), /requested UTC range/);
  assert.throws(() => parseTerrainSummary(d, { from: stamp(1), to: stamp(9) }), /requested UTC range/);
  d.range.n_samples--;
  assert.throws(() => parseTerrainSummary(d), /sample grid/);
  const single = example();
  Object.assign(single.range, { requested_end: stamp(1), end: stamp(1), n_samples: 1 });
  assert.throws(() => parseTerrainSummary(single, { from: "2026-01-01T00:30:00Z", to: "2026-01-01T00:10:00Z" }), /requested UTC range/);
});

test("keeps incomplete and missing measurements distinct from a complete zero-overlap result", () => {
  const d = example();
  const site = d.sites[0];
  const empty = { sun: [], earth: [], both: [] };
  const missing = { ...site, coverage: "missing", coverage_in_range: "missing", metrics: null, windows: empty };
  assert.equal(parseTerrainSummary({ ...d, sites: [missing] }).sites[0].metrics, null);
  assert.throws(() => parseTerrainSummary({ ...d, sites: [{ ...missing, windows: site.windows }] }), /Missing site coverage/);
  assert.throws(() => parseTerrainSummary({ ...d, sites: [{ ...missing, metrics: site.metrics }] }), /Missing site coverage/);
  const partial = { ...site, coverage: "partial", coverage_in_range: "partial" };
  assert.equal(parseTerrainSummary({ ...d, sites: [partial] }).sites[0].coverage_in_range, "partial");
  assert.equal(parseTerrainSummary({ ...d, sites: [{ ...partial, metrics: null }] }).sites[0].metrics, null);
  assert.throws(() => parseTerrainSummary({ ...d, sites: [{ ...site, metrics: null }] }), /requires metrics/);
  const noOverlap = { ...site, windows: { ...site.windows, earth: [], both: [] },
    metrics: { ...site.metrics, earth_hours: 0, both_hours: 0, longest_earth_h: 0, longest_both_h: 0, longest_comms_gap_h: 8, pct_earth: 0, pct_both: 0 } };
  assert.equal(parseTerrainSummary({ ...d, sites: [noOverlap] }).sites[0].metrics?.both_hours, 0);
});

test("checks ordered intervals, exact full Sun/Earth intersection and matching supplied metrics", () => {
  const d = example(), s = d.sites[0];
  s.windows.both = [interval(1, 2)]; // A true subinterval still omits the second overlap.
  assert.throws(() => parseTerrainSummary(d), /full Sun\/Earth intersection/);
  s.windows.both = [interval(1, 2), interval(3, 5)];
  s.windows.sun.reverse();
  assert.throws(() => parseTerrainSummary(d), /Unordered/);
  s.windows.sun.reverse();
  s.windows.earth[0].duration_h = 3;
  assert.throws(() => parseTerrainSummary(d), /window duration/);
  s.windows.earth[0].duration_h = 4;
  s.metrics.longest_both_h = s.metrics.both_hours;
  assert.throws(() => parseTerrainSummary(d), /longest interval/);
  s.metrics.longest_both_h = 2;
  s.metrics.longest_comms_gap_h = 2;
  assert.throws(() => parseTerrainSummary(d), /longest_comms_gap_h/);
});

test("rejects missing sections, unsafe links and duplicate site identifiers", () => {
  const d = example();
  assert.throws(() => parseTerrainSummary({ ...d, include: ["metrics"] }), /needs windows and metrics/);
  assert.throws(() => parseTerrainSummary({ ...d, model: { ...d.model, id: "different-horizon" } }), /Unsupported terrain visibility model/);
  assert.throws(() => parseTerrainSummary({ ...d, sites: [d.sites[0], d.sites[0]] }), /Duplicate site/);
  for (const url of ["javascript:alert(1)", "https://user:password@example.org/"]) {
    assert.throws(() => parseTerrainSummary({ ...d, sources: [{ ...d.sources[0], url }] }), /source URL/);
  }
  for (const manifest_url of ["//example.org/path", "/\\example.org/path", "javascript:alert(1)"]) {
    assert.throws(() => parseTerrainSummary({ ...d, run: { ...d.run, manifest_url } }), /URL|manifest/);
  }
});

test("astronaut reports the last covered terrain sample and preserves incomplete coverage", () => {
  const input = example();
  const terrain = parseTerrainSummary(input);
  const read = (hour: number, minutes = 0) => guideObservation(Date.parse(stamp(hour)) + minutes * 60000, "", terrain);
  assert.equal(read(0)?.readings[0].visibility, "sun");
  assert.equal(read(1, 59)?.time, Date.parse(stamp(1)));
  assert.equal(read(1, 59)?.readings[0].visibility, "both");
  assert.equal(read(2)?.readings[0].visibility, "earth");
  assert.equal(read(8), null);
  const incomplete = parseTerrainSummary({ ...input, sites: [{ ...input.sites[0], coverage: "partial", coverage_in_range: "partial", metrics: null }] });
  assert.equal(guideObservation(Date.parse(stamp(1)), "", incomplete), null);
});

test("saved guide reports only joint visibility and honors exclusive saved range limits", () => {
  const site = "im2_athena";
  const read = (utc: string, choice = site) => guideObservation(Date.parse(utc), choice, null);
  assert.equal(read("2026-11-15T04:59:59Z")?.readings[0].visibility, "outsideJoint");
  assert.equal(read("2026-11-15T05:00:00Z")?.readings[0].visibility, "both");
  assert.equal(read("2026-11-21T00:00:00Z")?.readings[0].visibility, "both");
  assert.equal(read("2026-11-21T00:00:00Z", "2026-11-14T00:00:00Z"), null);
  assert.equal(read("2026-11-28T00:00:00Z"), null);
  assert.equal(read("2026-11-18T00:00:00Z", "unknown"), null);
});

function plotted(hours = [0, 1, 2, 3, 4, 5, 7]) {
  const d = example();
  const series = {
    t: hours.map(stamp), step_s: 4 * 3600, decimated: true, n_transitions: 4,
    sun_az_deg: hours.map(() => 0), sun_el_deg: hours.map(() => 1),
    earth_az_deg: hours.map(() => 359), earth_el_deg: hours.map(() => -1),
    sun_visible: hours.map(h => h !== 2), earth_visible: hours.map(h => h >= 1 && h < 5),
    both_visible: hours.map(h => h !== 2 && h >= 1 && h < 5),
  };
  const horizon = { method: "test", dem_source: "Synthetic test", source_step_deg: 0.5, step_deg: 1,
    az_deg: Array.from({ length: 361 }, (_, i) => i), el_deg: Array(361).fill(0) as number[], min_el_deg: -2, max_el_deg: 1 };
  return { ...d, include: [...d.include, "series", "horizon"], sites: [{ ...d.sites[0], series, horizon }] };
}

test("keeps irregular transition rows, signed elevations, zero azimuth and terrain flags", () => {
  const d = plotted(), site = parseTerrainSummary(d).sites[0];
  assert.deepEqual(site.series, d.sites[0].series);
  assert.deepEqual(site.horizon, d.sites[0].horizon);
  const full = plotted([0, 1, 2, 3, 4, 5, 6, 7]);
  full.sites[0].series.decimated = false;
  assert.equal(parseTerrainSummary(full).sites[0].series?.step_s, 4 * 3600);
  assert.throws(() => parseTerrainSummary(plotted([0, 1, 2, 3, 4, 7])), /transition/);
  assert.throws(() => parseTerrainSummary(plotted([0, 1, 2, 3, 5, 7])), /regular/);
});

test("rejects contradictory normal, clock, parallel column and visibility fields", () => {
  const mutations: ((series: ReturnType<typeof plotted>["sites"][number]["series"]) => void)[] = [
    s => { s.sun_az_deg[0] = 360; },
    s => { s.earth_el_deg[0] = NaN; }, s => { s.t[2] = s.t[1]; },
    s => { s.t[2] = "2026-01-01T02:30:00Z"; }, s => { s.t[6] = stamp(8); },
    s => { s.earth_az_deg.pop(); }, s => { s.both_visible[1] = false; },
    s => { s.sun_visible[2] = true; }, s => { s.earth_visible[1] = false; },
    s => { s.decimated = false; }, s => { s.step_s = 3700; },
  ];
  for (const mutation of mutations) {
    const d = plotted();
    mutation(d.sites[0].series);
    assert.throws(() => parseTerrainSummary(d));
  }
});

test("accepts incomplete traces without a boundary sample and rejects samples for missing coverage", () => {
  const d = plotted([1, 4, 7]), s = d.sites[0];
  s.coverage = s.coverage_in_range = "partial";
  assert.deepEqual(parseTerrainSummary(d).sites[0].series?.t, [1, 4, 7].map(stamp));
  const missing = { ...s, coverage: "missing", coverage_in_range: "missing", windows: { sun: [], earth: [], both: [] }, metrics: null };
  assert.throws(() => parseTerrainSummary({ ...d, sites: [missing] }), /cannot have series samples/);
});

test("requires a closed uniform horizon and bounds its elevations by the source extrema", () => {
  const d = plotted(), h = d.sites[0].horizon;
  h.az_deg[2] = h.az_deg[1];
  assert.throws(() => parseTerrainSummary(d), /azimuth grid/);
  h.az_deg[2] = 2; h.el_deg[360] = 0.5;
  assert.throws(() => parseTerrainSummary(d), /closure/);
  h.el_deg[360] = 0; h.el_deg[2] = 2;
  assert.throws(() => parseTerrainSummary(d), /extrema/);
  h.el_deg[2] = 0; h.source_step_deg = h.step_deg;
  assert.throws(() => parseTerrainSummary(d), /source horizon minimum/);
  h.min_el_deg = h.max_el_deg = 0;
  assert.equal(parseTerrainSummary(d).sites[0].horizon?.el_deg.length, 361);
});
