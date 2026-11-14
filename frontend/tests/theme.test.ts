import test from "node:test";
import assert from "node:assert/strict";
import { localTheme, savedTheme } from "../lib/theme.ts";

test("automatic appearance follows local wall-clock boundaries without changing UTC data", () => {
  for (const [hour, minute, expected] of [[0, 0, "dark"], [6, 59, "dark"], [7, 0, "light"], [18, 59, "light"], [19, 0, "dark"], [23, 59, "dark"]] as const) {
    const date = new Date(2026, 10, 14, hour, minute);
    const before = date.toISOString();
    assert.equal(localTheme("auto", date), expected);
    assert.equal(date.toISOString(), before);
    assert.equal(localTheme("light", date), "light");
    assert.equal(localTheme("dark", date), "dark");
  }
});

test("unknown or missing stored preferences return to automatic appearance", () => {
  for (const value of [null, "", "system", "AUTO", "<script>", "auto"]) assert.equal(savedTheme(value), "auto");
  assert.equal(savedTheme("light"), "light");
  assert.equal(savedTheme("dark"), "dark");
});
