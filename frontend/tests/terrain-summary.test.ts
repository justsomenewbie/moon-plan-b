import assert from "node:assert/strict";
import test from "node:test";
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

test("reads aggregate windows, individual clipping, total, longest and provenance without interpreting series or horizons", () => {
  const d = example();
  d.include.push("series", "horizon");
  const raw = { ...d, sites: [{ ...d.sites[0], series: { t: [] }, horizon: {} }] };
  const parsed = parseTerrainSummary(raw, { from: stamp(0), to: stamp(8) });
  assert.deepEqual(parsed.sites[0].windows, d.sites[0].windows);
  assert.equal(parsed.sites[0].metrics?.both_hours, 3);
  assert.equal(parsed.sites[0].metrics?.longest_both_h, 2);
  assert.deepEqual(parsed.sources, d.sources);
  assert.deepEqual(parsed.run, d.run);
  assert.deepEqual(parsed.model, d.model);
  assert.deepEqual(Object.keys(parsed.sites[0]).sort(), ["coverage", "coverage_in_range", "id", "metrics", "name", "windows"].sort());
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
