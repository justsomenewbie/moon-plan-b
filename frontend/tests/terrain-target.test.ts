import assert from "node:assert/strict";
import test from "node:test";
import { defaultTerrainSites, readTerrainTarget, terrainSiteIds, writeTerrainTarget, type TerrainTarget } from "../lib/terrain-target.ts";

test("default, single and ordered pair pins round-trip without modifying UTC or observation fields", () => {
  const custom = "custom:-89.4500:222.6900";
  const pair = { run_id: "run-B", site_ids: custom + ",a3_haworth" };
  const single = { run_id: "job_j_test123", site_id: custom };
  const params = new URLSearchParams({ from: "2026-11-14T00:30:00Z", to: "2026-11-14T03:00:00Z", view_site: custom });
  assert.equal(readTerrainTarget(params), undefined);
  assert.equal(terrainSiteIds(), defaultTerrainSites);
  const targets: TerrainTarget[] = [pair, single, { run_id: "run-B" }];
  for (const target of targets) {
    writeTerrainTarget(params, target);
    assert.deepEqual(readTerrainTarget(new URLSearchParams(params.toString())), target);
    assert.equal(terrainSiteIds(target), target.site_ids ?? target.site_id ?? defaultTerrainSites);
    assert.equal(params.get("from"), "2026-11-14T00:30:00Z");
    assert.equal(params.get("view_site"), custom);
  }
});

test("rejects duplicate, mixed, unpinned and malformed target IDs and preserves original parameters on failure", () => {
  for (const query of ["site_ids=a,b", "site_id=a", "run_id=&site_ids=a,b", "run_id=invalid%2Frun", "run_id=B&run_id=B",
    "run_id=B&site_id=a&site_id=a", "run_id=B&site_ids=a,b&site_ids=c,d", "run_id=B&site_ids=a,b&site_id=a",
    "run_id=B&site_ids=one", "run_id=B&site_ids=one,one", "run_id=B&site_ids=one,two,three", "run_id=B&site_ids=a,",
    "run_id=B&site_ids=,b", "run_id=B&site_ids=a,%20b", "run_id=B&site_ids=a,%2Fb", "run_id=B&site_ids=a," + "x".repeat(65)]) {
    assert.throws(() => readTerrainTarget(new URLSearchParams(query)), /shared|run|sites/i, query);
  }
  const original = new URLSearchParams({ from: "first", run_id: "old", site_id: "old_site" });
  const prior = original.toString();
  assert.throws(() => writeTerrainTarget(original, { run_id: "run", site_ids: "repeat,repeat" }));
  assert.equal(original.toString(), prior);
});
