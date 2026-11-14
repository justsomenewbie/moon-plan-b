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

test("linear mask crossings split one hour into the three observed-order states", () => {
  const scenario = fixture().scenarios[0];
  const start = Date.parse(scenario.startUtc);
  const utc = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const body = (elevationDeg: number) => ({ azimuthDeg: 0, elevationDeg });
  scenario.samples = [
    { utc: utc(0), sun: body(2), earth: body(14) },
    { utc: utc(60), sun: body(14), earth: body(2) },
  ];
  scenario.endUtc = utc(60);
  scenario.sampleStepSeconds = 3600;
  const summary = analyzeScenarioClearance(scenario, 5);
  assert.deepEqual(summary.segments.map(s => [s.state, s.startUtc, s.endUtc]), [
    ["comms-only", utc(0), utc(15)], ["golden", utc(15), utc(45)], ["solar-only", utc(45), utc(60)],
  ]);
  assert.equal(summary.goldenHours, 0.5);
  assert.equal(summary.longestSolarDarknessHours, 0.25);
  assert.equal(summary.batteryStatus, "safe");
  assert.deepEqual(analyzeScenarioClearance({ ...scenario, coverage: "partial" }, 5).segments, summary.segments);
});

test("touching the exact threshold separates otherwise adjacent golden streaks", () => {
  const scenario = fixture().scenarios[0];
  scenario.samples = scenario.samples.slice(0, 3).map((s, i) => ({
    ...s, sun: { azimuthDeg: 0, elevationDeg: i === 1 ? 5 : 6 }, earth: { azimuthDeg: 0, elevationDeg: 7 },
  }));
  scenario.endUtc = scenario.samples[2].utc;
  const summary = analyzeScenarioClearance(scenario, 5);
  assert.equal(summary.goldenHours, 6);
  assert.equal(summary.longestGoldenStreakHours, 3);
  assert.equal(summary.segments.length, 2);
  assert.equal(evaluateSampleClearance(scenario.samples[1], 5), "comms-only");
});

test("null body or missing cadence breaks both neighboring spans and suppresses whole-window totals", () => {
  const scenario = fixture().scenarios[0];
  const fifth = scenario.samples[4];
  const retained = scenario.samples.filter((_, i) => i !== 3);
  retained[1] = { ...retained[1], sun: null };
  for (const coverage of ["partial", "complete"] as const) {
    const summary = analyzeScenarioClearance({ ...scenario, coverage, samples: retained });
    assert.equal(summary.coverage, "partial");
    assert.equal(summary.goldenHours, null);
    assert.equal(summary.batteryStatus, "unknown");
    assert.ok(summary.segments.length > 0);
    assert.equal(Date.parse(summary.segments[0].startUtc), Date.parse(fifth.utc));
  }
});

test("minute cadence accumulates an hour before rounding", () => {
  const scenario = fixture().scenarios[0];
  const start = Date.parse(scenario.startUtc);
  const body = { azimuthDeg: 30, elevationDeg: 10 };
  scenario.samples = Array.from({ length: 61 }, (_, i) => ({
    utc: new Date(start + i * 60_000).toISOString(), sun: body, earth: body,
  }));
  scenario.endUtc = scenario.samples[60].utc;
  scenario.sampleStepSeconds = 60;
  const summary = analyzeScenarioClearance(scenario);
  assert.equal(summary.segments.length, 1);
  assert.equal(summary.segments[0].durationHours, 1);
  assert.equal(summary.goldenHours, 1);
});

test("ideal shadow uses the flat-ground slope, wraps north, and needs a Sun direction", () => {
  const sample = fixture().scenarios[0].samples[0];
  const low = computeLanderHud({ ...sample, sun: { azimuthDeg: 179.99, elevationDeg: 0.5 } });
  assert.ok(Math.abs(low.shadowLengthFactor! - 114.58865) < 0.001);
  assert.equal(low.shadowAzimuthDeg, 0);
  const overhead = computeLanderHud({ ...sample, sun: { azimuthDeg: 40, elevationDeg: 90 } });
  assert.equal(overhead.shadowLengthFactor, 0);
  assert.equal(overhead.shadowAzimuthDeg, null);
  for (const sun of [null, { azimuthDeg: 10, elevationDeg: 0 }]) {
    const hud = computeLanderHud({ ...sample, sun });
    assert.equal(hud.shadowLengthFactor, null);
    assert.equal(hud.shadowAzimuthDeg, null);
  }
});
