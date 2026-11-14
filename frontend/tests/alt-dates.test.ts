import assert from "node:assert/strict";
import test from "node:test";
import { findAltDates, type AltDatesRequest } from "../lib/api/alt-dates.ts";
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
      min_sun_pct: 0, min_earth_pct: 0, min_both_pct: 100, min_separation_h: 1, objective: "earliest",
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
