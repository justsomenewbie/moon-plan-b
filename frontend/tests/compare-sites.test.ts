import test from "node:test";
import assert from "node:assert/strict";
import { compareSites, type SiteComparisonRequest } from "../lib/api/compare-sites.ts";
import { ApiError } from "../lib/api/client.ts";
import type { components } from "../lib/api/producer";

const start = "2026-11-14T00:00:00Z", end = "2026-11-15T00:00:00Z";
const request: SiteComparisonRequest = { runId: "unit-run", siteIds: ["dark", "earth-only"], from: start, to: end };
const weights = { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 };

// Synthetic controls with 24 hourly samples and different pair/catalog ranking semantics.
function example(): components["schemas"]["CompareResponse"] {
  const window = (state: boolean) => [{ start, end, duration_h: 24, state,
    truncated_start: false, truncated_end: false, clipped_start: true, clipped_end: true }];
  const site = (earth: boolean) => ({
    warnings: earth ? ["Flat test horizon."] : [],
    windows: { sun: window(false), earth: window(earth), both: window(false) },
    metrics: { duration_h: 24, pct_sun: 0, pct_earth: earth ? 100 : 0, pct_both: 0, pct_sun_no_earth: 0,
      longest_dark_h: 24, longest_dark_truncated: true, longest_comms_gap_h: earth ? 0 : 24, longest_comms_gap_truncated: !earth,
      longest_sun_h: 0, longest_sun_truncated: false, longest_earth_h: earth ? 24 : 0, longest_earth_truncated: earth,
      n_sun_windows: 0, n_dark_windows: 1, n_earth_windows: earth ? 1 : 0, n_comms_gaps: earth ? 0 : 1,
      mean_sun_el_lit_deg: null, mean_power_horizontal: 0, mean_power_tracking: 0 },
  });
  const sites = { "earth-only": site(true), dark: site(false) };
  const ranking = (["earth-only", "dark"] as const).map((id, i) => ({
    ...sites[id].metrics, site_id: id, name: id, group: "test", score: i ? 0 : 30, rank: i + 1, reasons: ["Test metric."],
  }));
  return { run_id: request.runId, step_s: 3600, precision_h: 1, range: { start, end, step_s: 3600, n_samples: 24 }, weights, sites, ranking };
}

test("POSTs one bounded pair on demand and preserves ordered inputs, ranked output, evaluated time and warnings", async t => {
  const response = example(), calls: Request[] = [];
  t.mock.method(globalThis, "fetch", async (req: Request) => { calls.push(req); return Response.json(response); });
  const offGrid = { ...request, from: "2026-11-14T00:20:00Z", to: "2026-11-14T23:00:00.001Z" };
  const result = await compareSites(offGrid);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(new URL(calls[0].url).pathname, "/api/v1/compare");
  assert.deepEqual(await calls[0].json(), { site_ids: request.siteIds, run_id: request.runId, start: offGrid.from, end: "2026-11-14T23:00:01Z",
    weights: { ...weights, pct_sun_no_earth: 0 }, include: { windows: ["sun", "earth", "both"] } });
  assert.deepEqual(result.range, response.range);
  assert.deepEqual(result.ranking.map(row => [row.site_id, row.rank, row.score]), [["earth-only", 1, 30], ["dark", 2, 0]]);
  assert.deepEqual(result.sites["earth-only"].warnings, ["Flat test horizon."]);
  assert.deepEqual({ ...result.coverageBySite }, { "earth-only": "complete", dark: "complete" });
  assert.equal(result.sites.dark.windows?.both?.[0].state, false);
});

test("distinguishes gaps and missing state windows from fully observed darkness", async t => {
  const response = example();
  response.sites["earth-only"].windows!.sun = [];
  response.sites.dark.windows = { sun: [], earth: [], both: [] };
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  const result = await compareSites(request);
  assert.equal(result.coverageBySite.dark, "missing");
  assert.equal(result.coverageBySite["earth-only"], "partial");
});

test("rejects mismatched runs, dates, pair identities, weights, metrics and joint visibility", async t => {
  const baseline = example();
  let response = example();
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  const faults = [
    () => { response.run_id = "other"; }, () => { response.range.start = end; },
    () => { response.precision_h = 0; }, () => { response.range.n_samples--; },
    () => { response.sites.other = response.sites.dark; },
    () => { response.ranking[0].site_id = "dark"; }, () => { response.ranking[0].rank = 10; },
    () => { response.ranking[0].score = 95; }, () => { response.weights.pct_both = 0.8; },
    () => { response.sites.dark.metrics.pct_sun = 40; }, () => { response.sites.dark.windows!.earth!.push(...baseline.sites.dark.windows!.earth!); },
    () => { response.sites.dark.windows!.both![0].state = true; },
  ];
  for (const mutate of faults) {
    response = structuredClone(baseline); mutate();
    await assert.rejects(compareSites(request), (e: unknown) => e instanceof ApiError && e.status === 502);
  }
});

test("invalid selections and aborts never post; backend error is preserved", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ detail: "Run unavailable" }, { status: 409 }); });
  for (const bad of [{ ...request, siteIds: ["dark", "dark"] as const }, { ...request, from: end }, { ...request, runId: "" }]) {
    await assert.rejects(compareSites(bad), (e: unknown) => e instanceof ApiError && e.status === 422);
  }
  await assert.rejects(compareSites(request, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(compareSites(request), (e: unknown) => e instanceof ApiError && e.status === 409 && e.message === "Run unavailable");
  assert.equal(calls, 1);
});
