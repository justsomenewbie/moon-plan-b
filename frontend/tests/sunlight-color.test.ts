import assert from "node:assert/strict";
import { test } from "node:test";
import { noSunlightData, sunlightRamp, sunlightStyle } from "../lib/sunlight-color.ts";

test("sunlight percentage maps to a dark-to-bright OKLCH ramp, with a neutral style when missing", () => {
  assert.deepEqual(sunlightStyle(0), { percent: 0, color: "oklch(0.35 0.02 90)", ink: "#FFFFFF", glow: false });
  assert.deepEqual(sunlightStyle(50), { percent: 50, color: "oklch(0.635 0.095 90)", ink: "#0B0F1A", glow: false });
  assert.deepEqual(sunlightStyle(100), { percent: 100, color: "oklch(0.92 0.17 90)", ink: "#0B0F1A", glow: true });
  assert.equal(sunlightStyle(0).color, sunlightRamp.from);
  assert.equal(sunlightStyle(100).color, sunlightRamp.to);
  // Missing or unusable values never get an invented colour.
  for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(sunlightStyle(missing), noSunlightData);
  assert.equal(noSunlightData.percent, null);
  // Lightness rises with the percentage, and only well-lit sites glow.
  const lightness = (value: number) => Number(sunlightStyle(value).color.match(/oklch\(([\d.]+)/)![1]);
  for (let value = 0; value < 100; value += 10) assert.ok(lightness(value + 10) > lightness(value));
  assert.equal(sunlightStyle(70).glow, false);
  assert.equal(sunlightStyle(71).glow, true);
  // Out-of-range input is clamped, and labels use whole percentages.
  assert.equal(sunlightStyle(140).color, sunlightRamp.to);
  assert.equal(sunlightStyle(-5).color, sunlightRamp.from);
  assert.equal(sunlightStyle(39.450986).percent, 39);
});
