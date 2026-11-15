import test from "node:test";
import assert from "node:assert/strict";
import { localTheme, nextThemeBoundary, savedTheme } from "../lib/theme.ts";

test("automatic appearance follows local wall-clock boundaries without changing UTC data", () => {
  for (const [hour, minute, expected] of [[0, 0, "dark"], [5, 59, "dark"], [6, 0, "light"], [17, 59, "light"], [18, 0, "dark"], [23, 59, "dark"]] as const) {
    const date = new Date(2026, 10, 14, hour, minute);
    const before = date.toISOString();
    assert.equal(localTheme("auto", date), expected);
    assert.equal(date.toISOString(), before);
    assert.equal(localTheme("light", date), "light");
    assert.equal(localTheme("dark", date), "dark");
  }
});

test("the next automatic change is the following local 06:00 or 18:00", () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
  assert.deepEqual(nextThemeBoundary(at(14, 3, 30)), at(14, 6));
  assert.deepEqual(nextThemeBoundary(at(14, 6)), at(14, 18));
  assert.deepEqual(nextThemeBoundary(at(14, 17, 59)), at(14, 18));
  assert.deepEqual(nextThemeBoundary(at(14, 18)), at(15, 6));
  assert.deepEqual(nextThemeBoundary(at(14, 23, 59)), at(15, 6));
  for (const date of [at(14, 3), at(14, 12), at(14, 21)]) {
    const next = nextThemeBoundary(date);
    assert.ok(next > date);
    assert.notEqual(localTheme("auto", next), localTheme("auto", new Date(next.getTime() - 1)));
  }
});

test("unknown or missing stored preferences return to automatic appearance", () => {
  for (const value of [null, "", "system", "AUTO", "<script>", "auto"]) assert.equal(savedTheme(value), "auto");
  assert.equal(savedTheme("light"), "light");
  assert.equal(savedTheme("dark"), "dark");
});
