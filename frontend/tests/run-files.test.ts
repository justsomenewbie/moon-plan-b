import assert from "node:assert/strict";
import test from "node:test";
import { getRunFiles } from "../lib/api/run-files.ts";
import type { TerrainSummary } from "../lib/api/terrain-summary.ts";

const run: TerrainSummary["run"] = {
  run_id: "unit", label: "Test", code_version: "1.0", run_timestamp_utc: "2026-03-01T00:00:00Z",
  provider: "test", dem: "test", horizon_method: "test", observer_height_m: 2, git_commit: null,
  min_earth_clearance_deg: 0, manifest_url: "/api/v1/runs/unit/files/manifest.json", manifest_sha256: "a".repeat(64),
};
test("builds only run-pinned links to exact listed file paths and retains producer file digests", async t => {
  const file = { path: "sites/unit/ephemeris.csv.gz", sha256: "b".repeat(64) };
  const response = { ...run, status: "ready", manifest: { files: [file] } };
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    assert.equal(req.method, "GET");
    assert.equal(new URL(req.url).pathname, "/api/v1/runs/unit");
    return Response.json(response);
  });
  assert.deepEqual(await getRunFiles(run), [{ ...file, href: "/api/v1/runs/unit/files/sites%2Funit%2Fephemeris.csv.gz" }]);
  for (const path of ["../unit", "sites//unit", "/unit", "site%2Ffile", "a?b", ""]) {
    response.manifest.files = [{ ...file, path }];
    await assert.rejects(getRunFiles(run), /does not match/);
  }
  for (const invalid of [[file, file], [{ ...file, sha256: "unknown" }]]) {
    response.manifest.files = invalid;
    await assert.rejects(getRunFiles(run), /does not match/);
  }
  response.manifest.files = [file]; response.run_id = "other";
  await assert.rejects(getRunFiles(run), /does not match/);
});
