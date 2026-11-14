import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../lib/api/client.ts";
import { getTerrainDates, validateTerrainDates } from "../lib/api/terrain-dates.ts";

const request = {
  siteId: "im2_athena",
  first: { from: "2026-12-01T00:00:00Z", to: "2026-12-04T00:00:00Z" },
  second: { from: "2026-12-18T00:00:00Z", to: "2026-12-21T00:00:00Z" },
};

// Invented source responses exercise the zero, clipped and partially covered paths.
function example(range: typeof request.first, visible: boolean) {
  const windows = visible ? [{ start: range.from, end: range.to, clipped_start: true, clipped_end: true, duration_h: 72 }] : [];
  const hours = visible ? 72 : 0, percent = visible ? 100 : 0;
  return {
    schema_version: "lunarnav-dataset-1", evidence: "computed-ephemeris", dataset_id: "unit-range", attribution: "Unit test",
    include: ["windows", "metrics"], sources: [],
    model: { id: "lunarnav-terrain-horizon-v1", label: "Test model", definition: "Invented for tests", limits: ["Test only"] },
    run: { run_id: "test-run", label: "Test", provider: "test", dem: "test", horizon_method: "test", code_version: "test",
      run_timestamp_utc: range.from, observer_height_m: 2, min_earth_clearance_deg: 0, git_commit: null,
      manifest_sha256: "a".repeat(64), manifest_url: "/api/v1/runs/test-run/files/manifest.json" },
    range: { start: range.from, end: range.to, requested_start: range.from, requested_end: range.to, step_s: 3600, n_samples: 72 },
    sites: [{ id: request.siteId, name: "Catalog site", coverage: "complete", coverage_in_range: "complete",
      windows: { sun: windows, earth: windows, both: windows }, metrics: {
        duration_h: 72, sun_hours: hours, earth_hours: hours, both_hours: hours,
        longest_sun_h: hours, longest_earth_h: hours, longest_both_h: hours, longest_dark_h: 72 - hours,
        longest_comms_gap_h: 72 - hours, pct_sun: percent, pct_earth: percent, pct_both: percent,
      } }],
  };
}

test("requests two bounded one-site summaries, pins both when given a run, preserves zeros and clipping", async t => {
  const queries: URLSearchParams[] = [];
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    const url = new URL(req.url);
    assert.equal(req.method, "GET");
    assert.equal(url.pathname, "/api/v1/dataset");
    queries.push(url.searchParams);
    const second = url.searchParams.get("start") === request.second.from;
    return Response.json(example(second ? request.second : request.first, second));
  });
  for (const runId of [undefined, "test-run"]) {
    queries.length = 0;
    const { first, second } = await getTerrainDates({ ...request, runId });
    assert.deepEqual(queries.map(q => Object.fromEntries(q)), [request.first, request.second].map((r, i) => ({
      ...(i === 1 || runId ? { run_id: "test-run" } : {}), site_ids: request.siteId, start: r.from, end: r.to,
      step_s: "3600", include: "windows,metrics",
    })));
    assert.equal(first.sites[0].metrics?.both_hours, 0);
    assert.equal(second.sites[0].metrics?.both_hours, 72);
    assert.equal(second.sites[0].windows.both[0].clipped_end, true);
  }
});

test("preserves partial coverage and rejects a stale site, run, manifest or UTC range", async t => {
  const first = example(request.first, false), second = example(request.second, true);
  let reply: unknown = second;
  t.mock.method(globalThis, "fetch", async (req: Request) =>
    Response.json(new URL(req.url).searchParams.get("start") === request.first.from ? first : reply));
  reply = { ...second, sites: [{ ...second.sites[0], coverage: "partial", coverage_in_range: "partial", metrics: null }] };
  const partial = (await getTerrainDates(request)).second.sites[0];
  assert.equal(partial.coverage_in_range, "partial");
  assert.equal(partial.metrics, null);
  for (const [replacement, pattern] of [
    [{ ...second, sites: [{ ...second.sites[0], id: "im1_odysseus" }] }, /returned sites/],
    [{ ...second, run: { ...second.run, run_id: "unexpected" } }, /returned model run/],
    [{ ...second, run: { ...second.run, manifest_sha256: "b".repeat(64) } }, /source manifests/],
    [{ ...second, range: first.range }, /different requested UTC range/],
    [{ ...second, range: { ...second.range, step_s: 7200, n_samples: 36 } }, /sampling steps/],
  ] as const) {
    reply = replacement;
    await assert.rejects(getTerrainDates(request), pattern);
  }
});

test("rejects unsuitable date pairs and stops before the next GET on error or cancellation", async t => {
  assert.throws(() => validateTerrainDates({ ...request, second: request.first }), /equal duration/);
  assert.throws(() => validateTerrainDates({ ...request, second: { ...request.second, to: "2026-12-22T00:00:00Z" } }), /equal duration/);
  assert.throws(() => validateTerrainDates({ ...request, siteId: "unknown" }), /Odysseus or Athena/);
  assert.throws(() => validateTerrainDates({ ...request, runId: "" }), /valid model run ID/);
  const controller = new AbortController();
  let calls = 0;
  let cancel = false;
  t.mock.method(globalThis, "fetch", async () => {
    ++calls;
    if (!cancel) return Response.json({ detail: "Source unavailable" }, { status: 503 });
    controller.abort();
    return Response.json(example(request.first, false));
  });
  await assert.rejects(getTerrainDates(request), (error: unknown) => error instanceof ApiError && error.status === 503);
  assert.equal(calls, 1);
  cancel = true;
  await assert.rejects(getTerrainDates(request, controller.signal), { name: "AbortError" });
  assert.equal(calls, 2);
  await assert.rejects(getTerrainDates(request, controller.signal), { name: "AbortError" });
  assert.equal(calls, 2);
});
