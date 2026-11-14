import assert from "node:assert/strict";
import test from "node:test";
import { findAltDates, landingDelayHours, landingGridBounds, type AltDatesRequest } from "../lib/api/alt-dates.ts";
import { ApiError } from "../lib/api/client.ts";

const request: AltDatesRequest = {
  run_id: "unit-run", site_id: "unit-site", earliest: "2026-11-15T03:30:00Z", latest: "2026-11-15T06:15:00Z",
  mission_h: 3, max_results: 2, constraints: { objective: "earliest", min_both_pct: 100, min_separation_h: 1 },
};
const grid = "2026-11-15T00:00:00Z";

// Synthetic service responses. Continuous visibility from landing may exceed the mission duration.
function example() {
  return {
    run_id: request.run_id, site_id: request.site_id, cache_id: "d".repeat(64), step_s: 3600, precision_h: 1,
    earliest_utc: request.earliest, latest_utc: request.latest, mission_duration_h: 3,
    constraints: {
      min_sun_pct: 0, min_earth_pct: 0, min_both_pct: 100, min_separation_h: 1, objective: "earliest" as const,
      require_sun_at_landing: true, require_earth_at_landing: false, min_continuous_sun_h: 0, min_continuous_earth_h: 0,
      max_dark_gap_h: null, max_comms_gap_h: null, min_sun_el_at_landing_deg: null,
    },
    n_evaluated: 3, n_feasible: 2, rejected_by: { min_both_pct: 1, require_sun_at_landing: 1 },
    candidates: [5, 6].map((hour, i) => ({
      rank: i + 1, landing_utc: `2026-11-15T0${hour}:00:00Z`, mission_end_utc: `2026-11-15T0${hour + 3}:00:00Z`,
      slip_h: hour - 3.5, score: 3.5 - hour, sun_pct: 100, earth_pct: 100, both_pct: 100,
      longest_dark_h: 0, longest_comms_gap_h: 0, continuous_sun_h: 90, continuous_earth_h: 120,
      continuous_sun_lower_bound: false, continuous_earth_lower_bound: true, sun_at_landing: true, earth_at_landing: true,
      sun_el_at_landing_deg: 1, earth_el_at_landing_deg: -1, mean_power_horizontal: 0.1, mean_power_tracking: 0.6,
    })),
  };
}

test("submits once, preserves ranked candidates, and accepts no match with overlapping rejections", async t => {
  const results = example(), posted: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    assert.equal(req.method, "POST");
    assert.equal(new URL(req.url).pathname, "/api/v1/alt-dates");
    posted.push(await req.json());
    return Response.json(results);
  });
  assert.deepEqual(await findAltDates(request, 3600, undefined, grid), results);
  assert.deepEqual(posted, [{ ...request, constraints: results.constraints }]);
  results.candidates = [];
  results.n_feasible = 0;
  results.rejected_by = { min_both_pct: 3, require_sun_at_landing: 3 };
  const empty = await findAltDates(request, 3600, undefined, grid);
  assert.deepEqual(empty, results);
  assert.equal(posted.length, 2);
});

test("rejects invalid bounds, duration and constraints before POST and does not retry backend failure", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ detail: "Bridge unavailable" }, { status: 503 }); });
  for (const invalid of [
    { latest: request.earliest.replace("03:", "02:") }, { earliest: "2026-11-15T04:00:00.500Z" },
    { mission_h: 1.5 }, { constraints: { min_both_pct: 101 } }, { max_results: 51 },
  ]) await assert.rejects(findAltDates({ ...request, ...invalid }, 3600), (e: unknown) => e instanceof ApiError && e.status === 422);
  await assert.rejects(findAltDates(request, 3600, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(findAltDates(request, 3600), /Bridge unavailable/);
  assert.equal(calls, 1);
});

test("checks response identity, counts, rank, source grid, mission bounds, and observable percentages", async t => {
  const baseline = example();
  let reply: unknown = baseline;
  t.mock.method(globalThis, "fetch", async () => Response.json(reply));
  const candidate = baseline.candidates[0];
  for (const change of [
    { site_id: "other" }, { run_id: "other" }, { earliest_utc: grid }, { precision_h: 2 },
    { constraints: { ...baseline.constraints, min_both_pct: 0 } }, { n_feasible: 4 }, { candidates: [] },
    { rejected_by: { min_both_pct: 2 } },
    ...[{ rank: 2 }, { landing_utc: grid }, { landing_utc: "2026-11-15T05:01:00Z" },
      { mission_end_utc: grid }, { slip_h: 2 }, { both_pct: 100, sun_pct: 75 }, { both_pct: 90 }, { sun_at_landing: false }, { sun_at_landing: "yes" }]
      .map(override => ({ candidates: [{ ...candidate, ...override }] })),
  ]) {
    reply = { ...baseline, ...change };
    await assert.rejects(findAltDates(request, 3600, undefined, grid), (e: unknown) => e instanceof ApiError && e.status === 502);
  }
});

test("rejects candidates that contradict an enabled landing constraint", async t => {
  const results = example();
  const candidate = results.candidates[0];
  const constraints = { ...results.constraints, require_earth_at_landing: true, min_sun_pct: 95, min_earth_pct: 95,
    min_both_pct: 90, min_continuous_sun_h: 48, min_continuous_earth_h: 48,
    max_dark_gap_h: 1, max_comms_gap_h: 1, min_sun_el_at_landing_deg: 1.0000004 };
  const search = { ...request, constraints };
  const response = { ...results, constraints };
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  await findAltDates(search, 3600, undefined, grid);
  for (const change of [
    { min: "Sun percentage", fields: { sun_pct: 94, both_pct: 94 } },
    { min: "Earth percentage", fields: { earth_pct: 94, both_pct: 94 } },
    { min: "joint percentage", fields: { both_pct: 89 } },
    { min: "Sun at landing", fields: { sun_at_landing: false } },
    { min: "Earth at landing", fields: { earth_at_landing: false } },
    { min: "continuous Sun", fields: { continuous_sun_h: 24 } },
    { min: "continuous Earth", fields: { continuous_earth_h: 24, continuous_earth_lower_bound: false } },
    { min: "dark gap", fields: { longest_dark_h: 2 } },
    { min: "communications gap", fields: { longest_comms_gap_h: 2 } },
    { min: "landing elevation", fields: { sun_el_at_landing_deg: 0.75 } },
  ]) {
    response.candidates[0] = { ...candidate, ...change.fields };
    await assert.rejects(findAltDates(search, 3600, undefined, grid), (e: unknown) => e instanceof ApiError && e.status === 502, change.min);
  }
  // A clipped continuous duration is a lower bound, not an upper bound.
  response.candidates[0] = { ...candidate, continuous_earth_h: 24, continuous_earth_lower_bound: true };
  await findAltDates(search, 3600, undefined, grid);
});

test("rejects unknown constraint keys on requests and responses", async t => {
  const result = example();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ ...result, constraints: { ...result.constraints, min_unimplemented: 1 } });
  });
  const invalid = { ...request.constraints, min_unimplemented: 1 };
  await assert.rejects(findAltDates({ ...request, constraints: invalid }, 3600), (e: unknown) => e instanceof ApiError && e.status === 422);
  assert.equal(calls, 0);
  await assert.rejects(findAltDates(request, 3600), (e: unknown) => e instanceof ApiError && e.status === 502);
});

test("joint visibility respects both marginal percentages even without a minimum", async t => {
  const results = example();
  results.constraints.min_both_pct = 0;
  const search = { ...request, constraints: results.constraints };
  const candidate = results.candidates[0];
  t.mock.method(globalThis, "fetch", async () => Response.json(results));
  Object.assign(candidate, { sun_pct: 100, earth_pct: 100, both_pct: 0 });
  await assert.rejects(findAltDates(search, 3600, undefined, grid), (error: unknown) => error instanceof ApiError && error.status === 502);
  Object.assign(candidate, { sun_pct: 66.666667, earth_pct: 66.666667, both_pct: 33.333333 });
  await findAltDates(search, 3600, undefined, grid);
});


test("accepts older exact and newer inward grid bounds while retaining delays from the requested start", async t => {
  const results = example();
  t.mock.method(globalThis, "fetch", async () => Response.json(results));
  const { first, last } = landingGridBounds(request.earliest, request.latest, 3600, grid);
  assert.deepEqual([first, last], [Date.parse("2026-11-15T04:00:00Z"), Date.parse("2026-11-15T06:00:00Z")]);
  const exact = await findAltDates(request, 3600, undefined, grid);
  assert.deepEqual(exact.candidates.map(c => c.slip_h), [1.5, 2.5]);
  Object.assign(results, { earliest_utc: "2026-11-15T04:00:00Z", latest_utc: "2026-11-15T06:00:00Z" });
  for (const candidate of results.candidates) candidate.slip_h -= 0.5;
  const snapped = await findAltDates(request, 3600, undefined, grid);
  assert.deepEqual(snapped.candidates.map(c => c.slip_h), [1, 2]);
  assert.deepEqual(snapped.candidates.map(c => landingDelayHours(c.landing_utc, request.earliest)), [1.5, 2.5]);
  results.candidates[0].slip_h = 1.5;
  await assert.rejects(findAltDates(request, 3600, undefined, grid), /invalid proposed landing window/);
});

test("checks both ends of the inward grid pair against the supplied model origin", async t => {
  const first = "2026-11-15T04:00:00Z", last = "2026-11-15T06:00:00Z";
  const results = { ...example(), candidates: [], n_feasible: 0, n_evaluated: 3 };
  t.mock.method(globalThis, "fetch", async () => Response.json(results));
  for (const [earliest_utc, latest_utc] of [
    [grid, last], [first, "2026-11-15T07:00:00Z"], [request.earliest, last], [first, request.latest],
    ["2026-11-15T05:00:00Z", last], [first, "2026-11-15T05:00:00Z"], [last, first],
  ]) {
    Object.assign(results, { earliest_utc, latest_utc });
    await assert.rejects(findAltDates(request, 3600, undefined, grid), /differs from the request/);
  }
  Object.assign(results, { earliest_utc: first, latest_utc: last });
  await assert.rejects(findAltDates(request, 3600), /differs from the request/);
  await assert.rejects(findAltDates(request, 3600, undefined, "2026-11-15T00:15:00Z"), /differs from the request/);
  Object.assign(results, { earliest_utc: "2026-11-15T04:15:00Z", latest_utc: "2026-11-15T06:15:00Z" });
  await findAltDates(request, 3600, undefined, "2026-11-15T00:15:00Z");
});

test("preserves the producer's 422 when the requested interval contains no grid point", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ detail: "No landing time on the model grid" }, { status: 422 });
  });
  const noGrid = { ...request, latest: "2026-11-15T03:45:00Z" };
  await assert.rejects(findAltDates(noGrid, 3600, undefined, grid), (e: unknown) =>
    e instanceof ApiError && e.status === 422 && /No landing time/.test(e.message));
  assert.equal(calls, 1);
});
