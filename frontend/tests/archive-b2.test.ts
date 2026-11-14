import assert from "node:assert/strict";
import test from "node:test";
import { archiveB2Run, rankArchiveB2, searchArchiveB2 } from "../lib/archive-b2.ts";

const week = { from: "2026-11-14", to: "2026-11-21", priority: "joint" as const };

test("matches production B2 site rankings and hourly totals, including an arbitrary later date", () => {
  const source = rankArchiveB2(week)!;
  assert.equal(source.runId, "B2_spice_pgda_bruteforce_2026_2030_fix676af9d");
  assert.equal(source.rows.length, 23);
  assert.equal(source.rows.find(s => s.id === "im1_odysseus")?.bothHours, 47);
  assert.equal(source.rows.find(s => s.id === "im2_athena")?.bothHours, 139);
  const nov = rankArchiveB2({ ...week, to: "2026-11-15" })!;
  assert.deepEqual(nov.leaders, ["chandrayaan3_vikram"]);
  assert.equal(nov.rows[0].bothHours, 18);
  const dec = rankArchiveB2({ ...week, from: "2026-12-01", to: "2026-12-04" })!;
  assert.deepEqual(dec.leaders, ["im1_odysseus"]);
  assert.equal(dec.rows[0].pctBoth, 27.777778);
  const later = rankArchiveB2({ ...week, from: "2028-04-17", to: "2028-04-23" })!;
  assert.deepEqual(later.leaders.sort(), ["ref_connecting_ridge_c2", "ref_de_gerlache_rim"]);
  assert.equal(later.rows[0].bothHours, 144);
  assert.equal(rankArchiveB2({ ...week, from: "2026-01-01", to: "2031-01-01" })?.rows.length, 23);
});

test("scores only eligible UTC starts, counts every tie and caps the displayed candidates", () => {
  const input = { from: "2026-11-15", to: "2026-11-16", priority: "joint" as const, siteId: "im2_athena", missionHours: 3 };
  const x = searchArchiveB2({ ...input, earliest: "2026-11-15T03:00", latest: "2026-11-15T06:00:00Z" })!;
  assert.deepEqual([x.nEvaluated, x.best, x.ties], [4, 3, 2]);
  assert.deepEqual(x.rows.map(c => [c.start.slice(11, 16), c.bothHours]), [["05:00", 3], ["06:00", 3], ["04:00", 2], ["03:00", 1]]);
  const all = searchArchiveB2({ ...input, from: archiveB2Run.start, to: archiveB2Run.end, siteId: "psr_shackleton_floor", missionHours: 1 })!;
  assert.deepEqual([all.nEvaluated, all.best, all.ties, all.rows.length], [43824, 0, 43824, 5]);
  assert.equal(all.rows[0].start, archiveB2Run.start);
  assert.equal(all.last, "2030-12-31T23:00:00Z");
  const boundary = searchArchiveB2({ ...input, from: "2030-12-31T21:00:00Z", to: archiveB2Run.end })!;
  assert.deepEqual([boundary.nEvaluated, boundary.rows[0].end], [1, archiveB2Run.end]);
});

test("requires real dates on the hourly grid, visible source sites and positive whole-hour missions", () => {
  for (const request of [
    { from: "2026-02-30" }, { from: "2025-12-31" }, { from: "2026-11-14T00:01:00Z" }, { to: "2031-01-01T01:00:00Z" },
    { from: week.to, to: week.to },
  ]) assert.equal(rankArchiveB2({ ...week, ...request }), null);
  const mission = { ...week, siteId: "im1_odysseus", missionHours: 3 };
  for (const options of [{ siteId: "not-in-archive" }, { missionHours: 0 }, { missionHours: 1.5 }, { earliest: "2026-11-15T03:30" },
    { earliest: week.to }, { latest: week.to }, { earliest: "2026-11-17", latest: "2026-11-16" }])
    assert.equal(searchArchiveB2({ ...mission, ...options }), null);
});
