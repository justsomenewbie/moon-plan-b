import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dataset } from "../lib/dataset.ts";

test("offline interval audit detects an omitted short overlap even when the longest still matches", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "moon-joint-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "release.json");
  const script = fileURLToPath(new URL("../scripts/check-joint-intervals.ts", import.meta.url));
  const release: Dataset = JSON.parse(readFileSync(new URL("../public/data/demo.json", import.meta.url), "utf8"));
  const [ridge] = release.scenarios;
  const incomplete = release.scenarios.filter(s => s.coverage !== "complete");
  release.scenarios = [ridge, ...incomplete];
  const interval = (start: string, end: string) => ({
    startUtc: "2026-11-14T" + start + "Z", endUtc: "2026-11-14T" + end + "Z", endClipped: false,
  });
  const intervals = ridge.intervals!;
  const short = interval("01:00:00", "01:00:01");
  intervals.sun.unshift(short);
  intervals.earth.unshift(short);
  // Touching endpoints at 18:00 add no third overlap.
  intervals.earth.push(interval("18:00:00", "19:00:00"));
  ridge.metrics!.sunAboveHours += 1 / 3600;
  ridge.metrics!.earthAboveHours += 1 + 1 / 3600;
  function run() {
    writeFileSync(file, JSON.stringify(release));
    const child = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
    assert.equal(child.stderr, "");
    return { status: child.status, rows: child.stdout.trim().split("\n").map(line => JSON.parse(line)) };
  }
  const omitted = run();
  assert.equal(omitted.status, 1);
  assert.equal(omitted.rows[0].status, "mismatch");
  assert.deepEqual(omitted.rows[0].expectedUtc[0], ["2026-11-14T01:00:00.000Z", "2026-11-14T01:00:01.000Z"]);
  assert.equal(omitted.rows[0].expectedUtc.length, 2);
  assert.equal(omitted.rows[0].suppliedUtc.length, 1);
  assert.equal(omitted.rows[0].suppliedTotalHours, 9);
  assert.equal(omitted.rows[0].longestContinuousHours, omitted.rows[0].producerLongestHours);
  assert.equal(omitted.rows[0].expectedTotalHours, 9 + 1 / 3600);

  intervals.simultaneous.unshift({ ...short, startUtc: short.startUtc.replace("Z", ".000Z") });
  const restored = run();
  assert.equal(restored.status, 0);
  assert.deepEqual(restored.rows.slice(0, 3).map(r => r.status), ["match", "unassessed", "unassessed"]);
  assert.equal(restored.rows.at(-1).checked, 1);

  // Adjacent segments cover the same instants. The producer reports its longest entry.
  intervals.simultaneous.splice(1, 1, interval("06:00:00", "10:00:00"), interval("10:00:00", "15:00:00"));
  ridge.metrics!.simultaneousLongestHours = 5;
  ridge.criteria.forEach(c => { c.result = c.minimumHours <= 5 ? "meets" : "below"; });
  const segmented = run();
  assert.equal(segmented.status, 1);
  assert.equal(segmented.rows[0].status, "match");
  assert.equal(segmented.rows[0].longestStatus, "review");
  assert.equal(segmented.rows[0].producerLongestHours, 5);
  assert.equal(segmented.rows[0].longestContinuousHours, 9);

  for (const [split, expectedExit] of [[3600, 1], [3599, 0]] as const) {
    const at = new Date(Date.parse(interval("06:00:00", "15:00:00").startUtc) + split).toISOString();
    intervals.simultaneous[1].endUtc = at;
    intervals.simultaneous[2].startUtc = at;
    ridge.metrics!.simultaneousLongestHours = (9 * 3600000 - split) / 3600000;
    ridge.criteria.forEach(c => { c.result = c.minimumHours <= ridge.metrics!.simultaneousLongestHours ? "meets" : "below"; });
    assert.equal(run().status, expectedExit, `longest differs by ${split} ms`);
  }

  release.scenarios = incomplete;
  const noComplete = run();
  assert.equal(noComplete.status, 1);
  assert.equal(noComplete.rows.at(-1).checked, 0);
});
