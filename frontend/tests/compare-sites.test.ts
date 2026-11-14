import test from "node:test";
import assert from "node:assert/strict";
import { compareSites, type SiteComparisonRequest } from "../lib/api/compare-sites.ts";
import { getCatalogRanking } from "../lib/api/catalog-ranking.ts";
import { pairGuideContext } from "../lib/api/guide-chat.ts";
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

test("rejects a reversed exact tie and a dark-gap duration contradicted by complete coverage", async t => {
  const response = example();
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  response.sites.dark.metrics.longest_dark_h = response.ranking[1].longest_dark_h = 0;
  await assert.rejects(compareSites(request), (e: unknown) => e instanceof ApiError && e.status === 502);
  response.sites.dark = structuredClone(response.sites["earth-only"]);
  response.ranking[1] = { ...response.ranking[0], site_id: "dark", rank: 2 };
  await assert.rejects(compareSites(request), (e: unknown) => e instanceof ApiError && e.status === 502);
  response.ranking.reverse().forEach((r, i) => { r.rank = i + 1; });
  assert.equal((await compareSites(request)).ranking[0].site_id, "dark");
});

test("checks the joint state over observed portions of a partial range and leaves gaps unknown", async t => {
  const response = example(), windows = response.sites["earth-only"].windows!;
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  const after = "2026-11-14T01:00:00Z";
  windows.sun![0] = { ...windows.sun![0], end: after, duration_h: 1 };
  const joint = windows.both![0];
  windows.both = [{ ...joint, end: after, duration_h: 1 }, { ...joint, start: after, duration_h: 23, state: true }];
  assert.equal((await compareSites(request)).coverageBySite["earth-only"], "partial");
  windows.both[0].state = true;
  await assert.rejects(compareSites(request), (e: unknown) => e instanceof ApiError && e.status === 502);
});

test("shorter dark intervals break an exact score tie before site IDs", async t => {
  const response = example();
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  const stamp = (hour: number) => new Date(Date.parse(start) + hour * 3600000).toISOString().replace(".000Z", "Z");
  for (const row of response.ranking) {
    const site = response.sites[row.site_id], shortDark = row.site_id === "earth-only";
    Object.assign(site.metrics, { pct_sun: 50, pct_earth: 0, pct_both: 0, pct_sun_no_earth: 50,
      longest_sun_h: shortDark ? 6 : 12, longest_earth_h: 0, longest_dark_h: shortDark ? 6 : 12,
      longest_dark_truncated: true, longest_sun_truncated: true, longest_earth_truncated: false,
      n_sun_windows: shortDark ? 2 : 1, n_dark_windows: shortDark ? 2 : 1, n_earth_windows: 0, n_comms_gaps: 1,
      longest_comms_gap_h: 24, longest_comms_gap_truncated: true });
    Object.assign(row, site.metrics, { score: 20 });
    const spans = shortDark ? [0, 6, 12, 18, 24] : [0, 12, 24];
    site.windows!.sun = spans.slice(1).map((to, i) => ({
      start: stamp(spans[i]), end: stamp(to), duration_h: to - spans[i], state: i % 2 === 0,
      truncated_start: false, truncated_end: false, clipped_start: i === 0, clipped_end: to === 24,
    }));
    site.windows!.earth![0].state = false;
  }
  assert.equal((await compareSites(request)).ranking[0].site_id, "earth-only");
  response.ranking.reverse().forEach((r, i) => { r.rank = i + 1; });
  await assert.rejects(compareSites(request), (e: unknown) => e instanceof ApiError && e.status === 502);
});

test("pair and catalog retain producer order when equal displayed scores have different visibility inputs", async t => {
  const response = example();
  const site = response.sites.dark, row = response.ranking[1];
  const transition = "2026-11-14T18:00:00Z";
  const original = site.windows!.sun![0];
  site.windows!.sun = [
    { ...original, state: true, end: transition, duration_h: 18, clipped_end: false },
    { ...original, start: transition, duration_h: 6, clipped_start: false },
  ];
  Object.assign(site.metrics, { pct_sun: 75, pct_sun_no_earth: 75, longest_sun_h: 18,
    longest_sun_truncated: true, longest_dark_h: 6, n_sun_windows: 1 });
  Object.assign(row, site.metrics, { score: 30 });
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    if (req.method === "POST") return Response.json(response);
    const { sites: _sites, ...ranking } = response;
    return Response.json({ ...ranking, source: "computed" });
  });
  const pair = await compareSites(request);
  const catalog = await getCatalogRanking(pair, undefined, request.siteIds.map(id => ({ id })));
  for (const result of [pair, catalog]) {
    assert.deepEqual(result.ranking.map(r => [r.site_id, r.score, r.longest_dark_h]),
      [["earth-only", 30, 24], ["dark", 30, 6]]);
  }
});

test("the guide uses the displayed pair order, exact visible intervals and evaluated UTC range", async t => {
  const response = example(), site = response.sites["earth-only"], row = response.ranking[0];
  const at = "2026-11-14T01:00:00Z", [full] = site.windows!.earth!;
  site.windows!.earth = [{ ...full, end: at, duration_h: 1 }, { ...full, start: at, duration_h: 23, state: false }];
  site.metrics.pct_earth = row.pct_earth = 4.166667;
  site.metrics.longest_earth_h = 1;
  site.metrics.longest_comms_gap_h = row.longest_comms_gap_h = 23;
  row.score = 1.25;
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  const requestWithin = { ...request, from: "2026-11-14T00:01:00Z" };
  const complete = await compareSites(requestWithin);
  const expected = { source: request.runId, from: start, to: end };
  assert.deepEqual(pairGuideContext(complete, complete.ranking), { kind: "terrain", rows: [
    { ...expected, site: "earth-only", sunHours: 0, earthHours: 1, bothHours: 0 },
    { ...expected, site: "dark", sunHours: 0, earthHours: 0, bothHours: 0 },
  ] });
  response.sites.dark.windows!.sun = [];
  const partial = await compareSites(requestWithin);
  const context = pairGuideContext(partial, [...partial.ranking].reverse());
  assert.deepEqual(context.rows[0], { ...expected, site: "dark", sunHours: null, earthHours: null, bothHours: null });
  assert.equal(context.rows[1].earthHours, 1);
  assert.equal(pairGuideContext(partial, [{ ...row, name: "www.example.org" }]).kind, "unavailable");
});
