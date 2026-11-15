import assert from "node:assert/strict";
import { test } from "node:test";
import { noSunlightData, periodSunlight, sunlightRamp, sunlightStyle } from "../lib/sunlight-color.ts";
import { rankArchiveB2 } from "../lib/archive-b2.ts";
import { missionSites } from "../lib/globe-sites.ts";

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

test("Orbit marker sunlight uses the run B2 hours of the selected week, like the planner", () => {
  const keyOf = (id: string) => missionSites.find(mission => mission.id === id)?.name;
  const week = (from: string, to: string) => {
    const result = rankArchiveB2({ from, to, priority: "joint" })!;
    const share = periodSunlight(result.rows, (Date.parse(to) - Date.parse(from)) / 3600000, keyOf);
    return { result, share };
  };
  const first = week("2026-11-14", "2026-11-21");
  // Only the two mission sites have Orbit markers.
  assert.deepEqual([...first.share.keys()].sort(), ["Athena · IM-2", "Odysseus · IM-1"]);
  const odysseus = first.result.rows.find(row => row.id === "im1_odysseus")!, athena = first.result.rows.find(row => row.id === "im2_athena")!;
  assert.equal(odysseus.sunHours, 47);
  assert.equal(athena.sunHours, 139);
  // 47 / 168 h is 28%, not the 20% of the older run B archive (33 / 168 h).
  assert.equal(sunlightStyle(first.share.get("Odysseus · IM-1")).percent, 28);
  assert.equal(sunlightStyle(first.share.get("Athena · IM-2")).percent, 83);
  // Every week maps its own hours.
  const second = week("2026-11-21", "2026-11-28");
  for (const row of second.result.rows.filter(row => keyOf(row.id))) {
    assert.equal(sunlightStyle(second.share.get(keyOf(row.id)!)).percent, Math.round(row.sunHours / 168 * 100));
  }
  // A period without a length gives "no data" rather than an invented value.
  assert.equal(periodSunlight([{ id: "im1_odysseus", sunHours: 47 }], 0, keyOf).get("Odysseus · IM-1"), null);
});
