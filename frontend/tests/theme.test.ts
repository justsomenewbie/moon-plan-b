import test from "node:test";
import assert from "node:assert/strict";
import { followsClock, localTheme, nextThemeBoundary, savedTheme, toggleAppearance, toggleAuto } from "../lib/theme.ts";

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

test("Auto can be turned off, and an explicit choice survives the clock", () => {
  const noon = new Date(2026, 10, 14, 12), night = new Date(2026, 10, 14, 22);
  // Auto on, sun/moon button pressed: an explicit choice opposite to what is showing, so Auto is off.
  for (const [date, showing, expected] of [[noon, "light", "dark"], [night, "dark", "light"]] as const) {
    assert.equal(localTheme("auto", date), showing);
    const next = toggleAppearance(showing);
    assert.equal(next, expected);
    assert.equal(followsClock(next), false);
  }
  // Auto on, Auto pressed again: off, keeping the theme that is showing as the explicit choice.
  assert.equal(toggleAuto("auto", "light"), "light");
  assert.equal(toggleAuto("auto", "dark"), "dark");
  // Auto off, Auto pressed: back to the clock.
  assert.equal(toggleAuto("light", "light"), "auto");
  assert.equal(toggleAuto("dark", "dark"), "auto");
  assert.equal(followsClock("auto"), true);
  // An explicit choice does not follow the clock: it is the same before and after 06:00 and 18:00,
  // which is what a boundary timer or a visibilitychange re-evaluation would compute.
  for (const mode of ["light", "dark"] as const) {
    assert.equal(followsClock(mode), false);
    for (const hour of [5, 6, 17, 18, 23]) assert.equal(localTheme(mode, new Date(2026, 10, 14, hour, 0, 1)), mode);
    assert.equal(localTheme(mode, nextThemeBoundary(noon)), mode);
  }
  // What is stored is what a reload reads back, for every state the buttons can produce.
  for (const mode of [toggleAppearance("light"), toggleAppearance("dark"), toggleAuto("auto", "light"), toggleAuto("dark", "dark")]) {
    assert.equal(savedTheme(mode), mode);
  }
});
