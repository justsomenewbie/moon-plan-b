import assert from "node:assert/strict";
import test from "node:test";
import { savedB2EarthWindows } from "../lib/archive-b2.ts";
import { clipEarthWindows } from "../lib/earth-windows.ts";
import { savedEarthWindows } from "../lib/saved-planner.ts";

const utc = (day: number, hour: number) =>
  `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;

test("clips to a half-open mission window, coalesces adjacent spans and leaves true gaps", () => {
  const spans = [
    { start: utc(1, 0), end: utc(1, 2) },
    { start: utc(1, 4), end: utc(1, 6) },
    { start: utc(1, 6), end: utc(1, 8) },
    { start: utc(1, 9), end: utc(1, 12) },
  ];
  assert.deepEqual(clipEarthWindows(spans, utc(1, 5), utc(1, 11)), [
    { start: utc(1, 5), end: utc(1, 8) }, { start: utc(1, 9), end: utc(1, 11) },
  ]);
  assert.deepEqual(clipEarthWindows(spans, utc(1, 2), utc(1, 4)), []);
  assert.equal(spans[1].end, utc(1, 6));
});

test("B2 keeps separate Athena intervals and clips a Nobile Rim 1 visit at its own boundaries", () => {
  assert.deepEqual(savedB2EarthWindows("im2_athena", "2026-11-01", "2026-12-01"), [
    { start: utc(1, 0), end: utc(7, 13) },
    { start: utc(12, 11), end: "2026-12-01T00:00:00Z" },
  ]);
  assert.deepEqual(savedB2EarthWindows("a3_nobile_rim_1", utc(19, 15), utc(20, 15)), [
    { start: utc(19, 21), end: utc(20, 15) },
  ]);
});

test("B2 distinguishes known zero visibility from invalid, off-grid or unrepresented queries", () => {
  assert.deepEqual(savedB2EarthWindows("change4", utc(14, 0), utc(21, 0)), []);
  assert.deepEqual(savedB2EarthWindows("chandrayaan3_vikram", utc(14, 0), utc(21, 0)), [
    { start: utc(14, 0), end: utc(21, 0) },
  ]);
  assert.equal(savedB2EarthWindows("constructor", utc(14, 0), utc(21, 0)), undefined);
  assert.equal(savedB2EarthWindows("change4", "2026-11-14T00:30:00Z", utc(21, 0)), undefined);
  assert.equal(savedB2EarthWindows("change4", "2025-12-31", "2026-01-01"), undefined);
  assert.deepEqual(savedB2EarthWindows("apollo11", "2030-12-31T23:00:00Z", "2031-01-01"), [
    { start: "2030-12-31T23:00:00Z", end: "2031-01-01T00:00:00Z" },
  ]);
});

test("earlier B exposes only its two retained sites and never reconstructs transitions from totals", () => {
  assert.deepEqual(savedEarthWindows("im1_odysseus", utc(19, 15), utc(20, 15)), [
    { start: utc(19, 15), end: utc(20, 15) },
  ]);
  assert.deepEqual(savedEarthWindows("im2_athena", "2026-11-14", "2026-11-28"), [
    { start: utc(14, 0), end: utc(28, 0) },
  ]);
  assert.equal(savedEarthWindows("chandrayaan3_vikram", "2026-11-14", "2026-11-15"), undefined);
  assert.equal(savedEarthWindows("im2_athena", "2026-12-01", "2026-12-04"), undefined);
  assert.equal(savedEarthWindows("im2_athena", utc(13, 23), utc(14, 2)), undefined);
  assert.equal(savedEarthWindows("im2_athena", utc(27, 23), utc(28, 1)), undefined);
});
