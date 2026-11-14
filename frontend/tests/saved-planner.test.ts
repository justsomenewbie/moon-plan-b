import test from "node:test";
import assert from "node:assert/strict";
import { getSavedPlannerDates, getSavedPlannerRanking, savedPlannerRun, savedPlannerWindows } from "../lib/saved-planner.ts";

test("three original catalog periods stay distinct from the two-site hourly archive", () => {
  assert.equal(savedPlannerRun.sites.length, 23);
  assert.equal(savedPlannerWindows.catalog.length, 3);
  const full = getSavedPlannerRanking({ from: "2026-01-01", to: "2031-01-01", priority: "joint" })!;
  assert.equal(full.rows.length, 23); assert.equal(full.scope, "catalog");
  const row = full.rows.find(s => s.id === "ref_connecting_ridge_c1")!;
  assert.equal(row.pctBoth, 48.799744); assert.equal(row.bothHours, 21386);
  const nov = getSavedPlannerRanking({ from: "2026-11-14", to: "2026-11-15", priority: "joint" })!;
  assert.deepEqual(nov.leaders, ["chandrayaan3_vikram"]); assert.equal(nov.rows[0].bothHours, 18);
  const dec = getSavedPlannerRanking({ from: "2026-12-01", to: "2026-12-04", priority: "joint" })!;
  assert.deepEqual(dec.leaders, ["im1_odysseus"]); assert.equal(dec.rows[0].bothHours, 20);
  assert.equal(getSavedPlannerRanking({ from: "2026-12-01", to: "2026-12-02", priority: "sun" }), null);
  assert.equal(getSavedPlannerRanking({ from: "2026-02-31", to: "2026-03-03", priority: "earth" }), null);
});

test("overlap, ties, hourly boundaries and site-first searches use the retained native observations", () => {
  const rq = { from: "2026-11-14", to: "2026-11-21", priority: "joint" as const };
  const first = getSavedPlannerRanking(rq)!;
  assert.equal(first.scope, "pair"); assert.deepEqual(first.rows.map(s => s.bothHours), [139, 33]);
  const next = getSavedPlannerRanking({ ...rq, from: "2026-11-21", to: "2026-11-28" })!;
  assert.equal(next.leaders.length, 2); assert.deepEqual(next.rows.map(s => s.bothHours), [168, 168]);
  const search = getSavedPlannerDates({ ...rq, siteId: "im1_odysseus", missionHours: 24 })!;
  assert.equal(search.nEvaluated, 145);
  assert.deepEqual(search.rows[0], { start: "2026-11-19T15:00:00Z", end: "2026-11-20T15:00:00Z", sunHours: 24, earthHours: 24, bothHours: 24 });
  assert.equal(search.rows.filter(w => w.bothHours === 24).length, 10);
  assert.equal(getSavedPlannerDates({ ...rq, siteId: "apollo11", missionHours: 1 }), null);
  assert.equal(getSavedPlannerDates({ ...rq, siteId: "im1_odysseus", missionHours: 169 }), null);
  assert.equal(getSavedPlannerDates({ ...rq, siteId: "im2_athena", from: "2026-11-13", missionHours: 1 }), null);
});
