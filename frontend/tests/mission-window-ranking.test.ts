import assert from "node:assert/strict";
import test from "node:test";
import { archiveB2Run } from "../lib/archive-b2.ts";
import { getSavedPlannerRanking } from "../lib/saved-planner.ts";
import { rankLiveMissionWindows, rankSavedMissionWindows } from "../lib/mission-window-ranking.ts";
import type { TerrainSummary } from "../lib/api/terrain-summary.ts";

const hour = 3_600_000, origin = Date.parse("2026-11-14T00:00:00Z");
const stamp = (hours: number) => new Date(origin + hours * hour).toISOString().replace(".000Z", "Z");
const request = { from: "2026-11-14", to: "2026-11-21", priority: "joint" as const, missionHours: 6 };

function intervals(mask: number[], stepHours: number) {
  const windows = [];
  for (let i = 0; i < mask.length;) {
    if (!mask[i]) { i++; continue; }
    const first = i++;
    while (i < mask.length && mask[i]) i++;
    windows.push({ start: stamp(first * stepHours), end: stamp(i * stepHours), duration_h: (i - first) * stepHours,
      clipped_start: first === 0, clipped_end: i === mask.length });
  }
  return windows;
}
function aggregate(sun: number[], earth = sun, stepHours = 1) {
  const end = stamp(sun.length * stepHours), both = sun.map((v, i) => v && earth[i]);
  const windows = { sun: intervals(sun, stepHours), earth: intervals(earth, stepHours), both: intervals(both, stepHours) };
  // Only the parsed fields used in this calculation are relevant to this synthetic numeric fixture.
  return { run: { run_id: "fixture" }, range: { start: stamp(0), requested_start: stamp(0),
    end, requested_end: end, step_s: stepHours * 3600, n_samples: sun.length },
    sites: [{ id: "fixture", name: "Fixture", coverage: "complete", coverage_in_range: "complete", windows }] } as TerrainSummary;
}

test("live native windows match a brute force oracle for every eight-hour mask, duration and tie", () => {
  for (let bits = 0; bits < 256; bits++) {
    const mask = Array.from({ length: 8 }, (_, i) => (bits >> i) & 1), evidence = aggregate(mask);
    for (let duration = 1; duration <= mask.length; duration++) {
      const totals = Array.from({ length: 9 - duration }, (_, i) => mask.slice(i, i + duration).reduce((a, b) => a + b, 0));
      const best = Math.max(...totals), first = totals.indexOf(best);
      const result = rankLiveMissionWindows(evidence, { from: stamp(0), to: stamp(8), priority: "joint", missionHours: duration })!;
      assert.equal(result.nEvaluated, totals.length);
      const [row] = result.rows;
      assert.deepEqual([row.start, row.end, row.bothHours, row.ties], [stamp(first), stamp(first + duration), best, totals.filter(v => v === best).length]);
    }
  }
});

test("applies the selected body on a half-hour native grid, reports all counts at its earliest optimum and excludes gaps", () => {
  const evidence = aggregate([1, 1, 0, 0, 1, 1], [0, 0, 1, 1, 1, 0], .5);
  const complete = evidence.sites[0];
  evidence.sites.push({ ...complete, id: "partial", coverage: "partial", coverage_in_range: "partial" });
  for (const [priority, expected] of [
    ["sun", [stamp(0), 1, 0, 0, 2]], ["earth", [stamp(1), 0, 1, 0, 2]], ["joint", [stamp(1.5), .5, 1, .5, 2]],
  ] as const) {
    const r = rankLiveMissionWindows(evidence, { from: stamp(0), to: stamp(3), missionHours: 1, priority })!;
    assert.equal(r.nEvaluated, 5);
    assert.deepEqual(r.excludedIds, ["partial"]);
    assert.deepEqual(r.leaders, ["fixture"]);
    const [row] = r.rows;
    assert.deepEqual([row.start, row.sunHours, row.earthHours, row.bothHours, row.ties], expected);
  }
  evidence.sites = [evidence.sites[1]];
  assert.deepEqual(rankLiveMissionWindows(evidence, { from: stamp(0), to: stamp(3), missionHours: .5, priority: "joint" })!.leaders, []);
});

test("does not accept rounded requests, an off-grid interval, invalid durations or invalid dates", () => {
  const evidence = aggregate([1, 0, 1, 0]);
  const q = { ...request, from: stamp(0), to: stamp(4), missionHours: 2 };
  for (const missionHours of [0, -1, 1.3, NaN, 200]) assert.equal(rankLiveMissionWindows(evidence, { ...q, missionHours }), null);
  for (const from of ["2026-02-30", stamp(.5), stamp(5)]) assert.equal(rankLiveMissionWindows(evidence, { ...q, from }), null);
  evidence.range.requested_start = stamp(-1);
  assert.equal(rankLiveMissionWindows(evidence, q), null);
  evidence.range.requested_start = stamp(0);
  evidence.sites[0].windows.sun[0].end = stamp(.5);
  assert.equal(rankLiveMissionWindows(evidence, q), null);
});

test("saved B2 ranks the requested mission across the catalog and scales to its five-year archive", () => {
  const result = rankSavedMissionWindows("saved-b2", request)!;
  assert.equal(result.scope, "catalog");
  assert.equal(result.rows.length, 23);
  assert.equal(result.nEvaluated, 163);
  assert.equal(result.leaders.length, 16);
  const odysseus = result.rows.find(r => r.id === "im1_odysseus")!;
  assert.deepEqual([odysseus.start, odysseus.end, odysseus.bothHours, odysseus.ties], [stamp(121), stamp(127), 6, 42]);
  const full = rankSavedMissionWindows("saved-b2", { ...request, from: archiveB2Run.start, to: archiveB2Run.end })!;
  assert.equal(full.nEvaluated, 43819);
  assert.ok(full.rows.every(r => r.bothHours <= 6));
});

test("historical B uses its detailed pair or a retained all-site summary that proves the only candidate", () => {
  const old = rankSavedMissionWindows("saved", request)!;
  assert.equal(old.scope, "pair");
  assert.deepEqual(old.rows.map(r => r.id), ["im1_odysseus", "im2_athena"]);
  assert.equal(old.rows[0].start, stamp(135));
  const catalogDay = { ...request, to: "2026-11-15", missionHours: 24 };
  const all = rankSavedMissionWindows("saved", catalogDay)!;
  const summary = getSavedPlannerRanking(catalogDay)!;
  assert.equal(all.scope, "catalog");
  assert.equal(all.rows.length, 23);
  assert.deepEqual(all.leaders, summary.leaders);
  assert.ok(all.rows.every(r => r.ties === 1 && r.start === all.from && r.end === all.to));
  assert.equal(rankSavedMissionWindows("saved", { ...request, from: "2027-01-01", to: "2027-01-08" }), null);
});
