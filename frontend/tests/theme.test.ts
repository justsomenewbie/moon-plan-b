import test from "node:test";
import assert from "node:assert/strict";
import { localTheme, savedTheme } from "../lib/theme.ts";

test("automatic appearance follows the device color-scheme preference", () => {
  assert.equal(localTheme("auto", true), "dark");
  assert.equal(localTheme("auto", false), "light");
  for (const prefersDark of [true, false]) {
    assert.equal(localTheme("light", prefersDark), "light");
    assert.equal(localTheme("dark", prefersDark), "dark");
  }
});

test("unknown or missing stored preferences return to automatic appearance", () => {
  for (const value of [null, "", "system", "AUTO", "<script>", "auto"]) assert.equal(savedTheme(value), "auto");
  assert.equal(savedTheme("light"), "light");
  assert.equal(savedTheme("dark"), "dark");
});
