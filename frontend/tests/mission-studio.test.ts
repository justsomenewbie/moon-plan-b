import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Dataset } from "../lib/dataset.ts";
import {
  analyzeScenarioClearance,
  clampClearanceDeg,
  computeLanderHud,
  evaluateSampleClearance,
  shortestAzimuthDelta,
} from "../lib/mission-studio.ts";

const fixture = () => JSON.parse(readFileSync(new URL("../public/data/demo.json", import.meta.url), "utf8")) as Dataset;

test("shortestAzimuthDelta handles North wrap-around (359° -> 1°) without 180° spikes", () => {
  assert.equal(shortestAzimuthDelta(359, 1), 2);
  assert.equal(shortestAzimuthDelta(1, 359), 2);
  assert.equal(shortestAzimuthDelta(350, 20), 30);
  assert.equal(shortestAzimuthDelta(0, 180), 180);
  assert.equal(clampClearanceDeg(-3), 0);
  assert.equal(clampClearanceDeg(14), 10);
  assert.equal(clampClearanceDeg(2.6), 2.5);
});

test("analyzeScenarioClearance reproduces 0° baseline and degrades windows as θ_mask rises", () => {
  const data = fixture();
  const ridge1 = data.scenarios[0];
  const base = analyzeScenarioClearance(ridge1, 0, 12);
  assert.equal(base.coverage, "complete");
  assert.equal(base.goldenHours, 9);
  assert.equal(base.solarOnlyHours, 3);
  assert.equal(base.commsOnlyHours, 3);
  assert.equal(base.blackoutHours, 9);
  assert.equal(base.longestGoldenStreakHours, 9);
  assert.equal(base.longestSolarDarknessHours, 6);
  assert.equal(base.batteryStatus, "safe");

  const strictBattery = analyzeScenarioClearance(ridge1, 0, 3);
  assert.equal(strictBattery.batteryStatus, "risk");

  const elevatedMask = analyzeScenarioClearance(ridge1, 10, 12);
  assert.ok(elevatedMask.goldenHours! < base.goldenHours!);
  assert.ok(elevatedMask.longestSolarDarknessHours! >= base.longestSolarDarknessHours!);
});

test("analyzeScenarioClearance preserves null totals and unknown battery status on partial/missing coverage", () => {
  const data = fixture();
  const partial = data.scenarios.find((s) => s.coverage === "partial")!;
  const missing = data.scenarios.find((s) => s.coverage === "missing")!;

  const partialSummary = analyzeScenarioClearance(partial, 2, 12);
  assert.equal(partialSummary.goldenHours, null);
  assert.equal(partialSummary.longestSolarDarknessHours, null);
  assert.equal(partialSummary.batteryStatus, "unknown");

  const missingSummary = analyzeScenarioClearance(missing, 0, 12);
  assert.equal(missingSummary.goldenHours, null);
  assert.equal(missingSummary.segments.length, 0);
  assert.equal(missingSummary.batteryStatus, "unknown");
});

test("computeLanderHud derives solar array, dish antenna, shadow vector and clearance state", () => {
  const data = fixture();
  const sample = data.scenarios[0].samples[3]; // 09:00 UTC: Sun Az 62 El 15, Earth Az 47 El 40
  const hud0 = computeLanderHud(sample, 0);
  assert.equal(hud0.opState, "golden");
  assert.equal(hud0.sunClearsMask, true);
  assert.equal(hud0.earthClearsMask, true);
  assert.equal(hud0.azimuthSeparationDeg, 15);
  assert.equal(hud0.shadowAzimuthDeg, 242);
  assert.ok(hud0.shadowLengthFactor! > 3 && hud0.shadowLengthFactor! < 4);

  const hud20 = computeLanderHud(sample, 10);
  assert.equal(hud20.sunClearsMask, true);
  assert.equal(evaluateSampleClearance(data.scenarios[0].samples[2], 0), "comms-only"); // Sun El 0, Earth El 20
});
