import assert from "node:assert/strict";
import test from "node:test";
import { getPlannerRun, getPlannerRanking, type PlannerRun } from "../lib/api/planner.ts";

const start = "2026-03-01T00:00:00Z", end = "2026-03-02T00:00:00Z";
const ids = ["alpha", "beta", "unknown"];
const run: PlannerRun = { runId: "fixture", start, end, stepSeconds: 3600,
  sites: ids.map(id => ({ id, name: id, demSource: "fixture", horizonMethod: "fixture" })) };
const nativeRange = { start, end, step_s: 3600, n_samples: 24 };
const weights = { pct_both: 1 };
const thresholdHours = [24, 72, 168];

function replies() {
  const interval = [{ start, end, duration_h: 24, clipped_start: true, clipped_end: true }];
  const metrics = { duration_h: 24, sun_hours: 24, earth_hours: 24, both_hours: 24, longest_sun_h: 24, longest_earth_h: 24,
    longest_both_h: 24, longest_dark_h: 0, longest_comms_gap_h: 0, pct_sun: 100, pct_earth: 100, pct_both: 100 };
  const aggregate = {
    schema_version: "lunarnav-dataset-1", evidence: "computed-ephemeris", dataset_id: "fixture.range", attribution: "Synthetic regression fixture",
    range: { ...nativeRange, requested_start: start, requested_end: end }, include: ["windows", "metrics", "criteria"], criteria_hours: thresholdHours,
    run: { run_id: "fixture", label: "Test run", provider: "test", dem: "test", horizon_method: "test", code_version: "test", run_timestamp_utc: start,
      observer_height_m: 2, min_earth_clearance_deg: 0, git_commit: null, manifest_sha256: "a".repeat(64), manifest_url: "/api/v1/runs/fixture/files/manifest.json" },
    model: { id: "lunarnav-terrain-horizon-v1", label: "Test", definition: "Test", limits: ["Synthetic"] },
    sources: [{ id: "source", title: "Test", url: "https://example.org", sha256: null }],
    sites: ids.map(id => {
      const missing = id === "unknown";
      const observed = missing ? [] : interval;
      return { id, name: id, coverage: missing ? "missing" : "complete", coverage_in_range: missing ? "missing" : "complete",
        windows: { sun: observed, earth: observed, both: observed }, metrics: missing ? null : metrics,
        criteria: missing ? [] : thresholdHours.map(minimum_hours => ({ minimum_hours, metric: "longest_both_h", value_h: 24, value_clipped: true,
          result: minimum_hours === 24 ? "meets" : "below", reason: "Test" })) };
    }),
  };
  const ranking = { run_id: "fixture", step_s: 3600, precision_h: 1, range: nativeRange, weights, source: "computed",
    ranking: ids.map((site_id,i) => ({ site_id, rank: i + 1, name: site_id, group: "fixture", score: 100,
      pct_sun: 100, pct_earth: 100, pct_both: 100, pct_sun_no_earth: 0, mean_power_tracking: 0,
      longest_dark_h: 0, longest_comms_gap_h: 0, longest_dark_truncated: false, longest_comms_gap_truncated: false, reasons: [] })) };
  return { aggregate, ranking };
}

test("discovers the producer's default, requires matching coverage bounds and a complete run-pinned catalog", async t => {
  const record = { run_id: run.runId, is_default: true, status: "ready", start_utc: start, end_utc: end,
    n_samples: 24, step_s: 3600, n_sites: 3, site_ids: [...ids].reverse() };
  let catalog = ids.map(id => ({ id, name: id, dem_source: "fixture", horizon_method: "fixture" }));
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    const url = new URL(req.url);
    paths.push(url.pathname + url.search);
    return Response.json(url.pathname.endsWith("/runs") ? { default_run_id: run.runId, runs: [record] } : { run_id: run.runId, sites: catalog });
  });
  assert.deepEqual(await getPlannerRun(), run);
  assert.deepEqual(paths, ["/api/v1/runs?limit=1", "/api/v1/sites?run_id=fixture&format=json"]);
  catalog = catalog.slice(1);
  await assert.rejects(getPlannerRun(), /default model run/);
  record.n_samples = 25;
  await assert.rejects(getPlannerRun(), /default model run/);
  record.n_samples = 24; record.is_default = false;
  await assert.rejects(getPlannerRun(), /default model run/);
});

test("matches the native interval evidence to all ranked IDs, preserves ties and excludes missing coverage", async t => {
  const { ranking, aggregate } = replies();
  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    assert.equal(req.method, "GET");
    const url = new URL(req.url); calls.push(url);
    return Response.json(url.pathname.endsWith("/dataset") ? aggregate : ranking);
  });
  const request = { from: start.replace("Z", ".000000001Z"), to: end, priority: "joint" as const };
  const result = await getPlannerRanking(run, request);
  assert.deepEqual(result.recommendedIds, ["alpha", "beta"]);
  assert.equal(result.evidence.sites[2].coverage, "missing");
  assert.equal(result.ranking.ranking.length, 3);
  assert.equal(calls[0].searchParams.get("start"), request.from);
  assert.equal(calls[0].searchParams.get("site_ids"), ids.join(","));
  assert.equal(calls[0].searchParams.get("include"), "windows,metrics,criteria");
  assert.equal(calls[1].searchParams.get("start"), start);
  assert.equal(calls[1].searchParams.get("weights"), "pct_sun:0,pct_earth:0,pct_both:1,pct_sun_no_earth:0");
  ranking.ranking[0].longest_comms_gap_h = 1;
  await assert.rejects(getPlannerRanking(run, request), /observation evidence/);
});

test("rejects dates beyond either inclusive start or exclusive end, reversal and cancellation before any lookup", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}); });
  const request = { from: start, to: end, priority: "earth" as const };
  for (const bounds of [{ from: "2026-02-28T23:59:59.999999999Z" }, { to: end.replace("Z", ".000000001Z") }, { to: start }])
    await assert.rejects(getPlannerRanking(run, { ...request, ...bounds }), /inside the model run/);
  await assert.rejects(getPlannerRanking(run, request, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(calls, 0);
});
