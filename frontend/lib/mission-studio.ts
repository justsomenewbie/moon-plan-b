// Educational sample-level clearance, 4-state mission operations and lander orientation helpers.
// Keeps producer-supplied 0° intervals untouched and never fabricates values across missing/partial gaps.
import type { Sample, Scenario } from "./dataset";

export type MissionOpState = "golden" | "solar-only" | "comms-only" | "blackout" | "unavailable";

export interface MissionSegment {
  state: MissionOpState;
  startUtc: string;
  endUtc: string;
  durationHours: number;
  startPct: number;
  widthPct: number;
}

export interface ScenarioClearanceSummary {
  clearanceDeg: number;
  coverage: Scenario["coverage"];
  goldenHours: number | null;
  solarOnlyHours: number | null;
  commsOnlyHours: number | null;
  blackoutHours: number | null;
  longestGoldenStreakHours: number | null;
  longestSolarDarknessHours: number | null;
  batteryStatus: "safe" | "risk" | "unknown";
  segments: MissionSegment[];
}

export interface LanderHudMetrics {
  sunAzimuthDeg: number | null;
  sunElevationDeg: number | null;
  sunClearsMask: boolean;
  earthAzimuthDeg: number | null;
  earthElevationDeg: number | null;
  earthClearsMask: boolean;
  azimuthSeparationDeg: number | null;
  shadowAzimuthDeg: number | null;
  shadowLengthFactor: number | null;
  opState: MissionOpState;
}

export function clampClearanceDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, Math.round(value * 2) / 2));
}

export function shortestAzimuthDelta(azA: number, azB: number): number {
  const diff = Math.abs(((azA - azB) % 360 + 360) % 360);
  return Number((diff > 180 ? 360 - diff : diff).toFixed(1));
}

export function evaluateSampleClearance(sample: Sample | undefined, clearanceDeg = 0): MissionOpState {
  if (!sample || !sample.sun || !sample.earth) return "unavailable";
  const mask = clampClearanceDeg(clearanceDeg);
  const sunClear = sample.sun.elevationDeg > mask;
  const earthClear = sample.earth.elevationDeg > mask;
  if (sunClear && earthClear) return "golden";
  if (sunClear) return "solar-only";
  if (earthClear) return "comms-only";
  return "blackout";
}

export function computeLanderHud(sample: Sample | undefined, clearanceDeg = 0): LanderHudMetrics {
  const mask = clampClearanceDeg(clearanceDeg);
  const sun = sample?.sun ?? null;
  const earth = sample?.earth ?? null;
  const sunClearsMask = sun !== null && sun.elevationDeg > mask;
  const earthClearsMask = earth !== null && earth.elevationDeg > mask;
  const azimuthSeparationDeg = sun && earth ? shortestAzimuthDelta(sun.azimuthDeg, earth.azimuthDeg) : null;
  const shadowAzimuthDeg = sun && sun.elevationDeg > 0 ? Number(((sun.azimuthDeg + 180) % 360).toFixed(1)) : null;
  const shadowLengthFactor = sun && sun.elevationDeg > 0
    ? Number(Math.min(25, 1 / Math.tan(Math.max(1, sun.elevationDeg) * Math.PI / 180)).toFixed(1))
    : null;
  return {
    sunAzimuthDeg: sun ? sun.azimuthDeg : null,
    sunElevationDeg: sun ? sun.elevationDeg : null,
    sunClearsMask,
    earthAzimuthDeg: earth ? earth.azimuthDeg : null,
    earthElevationDeg: earth ? earth.elevationDeg : null,
    earthClearsMask,
    azimuthSeparationDeg,
    shadowAzimuthDeg,
    shadowLengthFactor,
    opState: evaluateSampleClearance(sample, mask),
  };
}

export function analyzeScenarioClearance(
  scenario: Scenario,
  clearanceDeg = 0,
  batteryLimitHours = 12,
): ScenarioClearanceSummary {
  const mask = clampClearanceDeg(clearanceDeg);
  const windowStart = Date.parse(scenario.startUtc);
  const windowEnd = Date.parse(scenario.endUtc);
  const totalSpanMs = Math.max(1, windowEnd - windowStart);
  const maxStepMs = scenario.sampleStepSeconds * 1000;

  if (scenario.coverage !== "complete" || scenario.samples.length < 2) {
    const partialSegments: MissionSegment[] = [];
    for (let i = 0; i < scenario.samples.length - 1; i++) {
      const current = scenario.samples[i];
      const next = scenario.samples[i + 1];
      const t0 = Date.parse(current.utc);
      const t1 = Date.parse(next.utc);
      if (t1 - t0 > maxStepMs) continue;
      const state = evaluateSampleClearance(current, mask);
      partialSegments.push({
        state,
        startUtc: current.utc,
        endUtc: next.utc,
        durationHours: (t1 - t0) / 3600000,
        startPct: ((t0 - windowStart) / totalSpanMs) * 100,
        widthPct: ((t1 - t0) / totalSpanMs) * 100,
      });
    }
    return {
      clearanceDeg: mask,
      coverage: scenario.coverage,
      goldenHours: null,
      solarOnlyHours: null,
      commsOnlyHours: null,
      blackoutHours: null,
      longestGoldenStreakHours: null,
      longestSolarDarknessHours: null,
      batteryStatus: "unknown",
      segments: partialSegments,
    };
  }

  let goldenHours = 0;
  let solarOnlyHours = 0;
  let commsOnlyHours = 0;
  let blackoutHours = 0;
  let currentGoldenStreak = 0;
  let longestGoldenStreakHours = 0;
  let currentDarknessStreak = 0;
  let longestSolarDarknessHours = 0;
  const segments: MissionSegment[] = [];

  for (let i = 0; i < scenario.samples.length - 1; i++) {
    const current = scenario.samples[i];
    const next = scenario.samples[i + 1];
    const t0 = Date.parse(current.utc);
    const t1 = Date.parse(next.utc);
    const stepHours = (t1 - t0) / 3600000;
    // Evaluate midpoint or endpoint visibility across the sample step:
    // A step is clear when both endpoints or midpoint are above the clearance threshold,
    // or using midpoint elevation between consecutive samples for smooth threshold response.
    const sunMid = current.sun && next.sun ? (current.sun.elevationDeg + next.sun.elevationDeg) / 2 : null;
    const earthMid = current.earth && next.earth ? (current.earth.elevationDeg + next.earth.elevationDeg) / 2 : null;
    const sunClear = sunMid !== null && sunMid > mask;
    const earthClear = earthMid !== null && earthMid > mask;
    const state: MissionOpState = sunMid === null || earthMid === null
      ? "unavailable"
      : sunClear && earthClear
        ? "golden"
        : sunClear
          ? "solar-only"
          : earthClear
            ? "comms-only"
            : "blackout";

    if (state === "golden") {
      goldenHours += stepHours;
      currentGoldenStreak += stepHours;
      longestGoldenStreakHours = Math.max(longestGoldenStreakHours, currentGoldenStreak);
    } else {
      currentGoldenStreak = 0;
    }

    if (state === "solar-only") solarOnlyHours += stepHours;
    if (state === "comms-only") commsOnlyHours += stepHours;
    if (state === "blackout") blackoutHours += stepHours;

    if (!sunClear) {
      currentDarknessStreak += stepHours;
      longestSolarDarknessHours = Math.max(longestSolarDarknessHours, currentDarknessStreak);
    } else {
      currentDarknessStreak = 0;
    }

    const prev = segments.at(-1);
    if (prev && prev.state === state && prev.endUtc === current.utc) {
      prev.endUtc = next.utc;
      prev.durationHours = Number((prev.durationHours + stepHours).toFixed(2));
      prev.widthPct = ((Date.parse(next.utc) - Date.parse(prev.startUtc)) / totalSpanMs) * 100;
    } else {
      segments.push({
        state,
        startUtc: current.utc,
        endUtc: next.utc,
        durationHours: Number(stepHours.toFixed(2)),
        startPct: ((t0 - windowStart) / totalSpanMs) * 100,
        widthPct: ((t1 - t0) / totalSpanMs) * 100,
      });
    }
  }

  return {
    clearanceDeg: mask,
    coverage: scenario.coverage,
    goldenHours: Number(goldenHours.toFixed(1)),
    solarOnlyHours: Number(solarOnlyHours.toFixed(1)),
    commsOnlyHours: Number(commsOnlyHours.toFixed(1)),
    blackoutHours: Number(blackoutHours.toFixed(1)),
    longestGoldenStreakHours: Number(longestGoldenStreakHours.toFixed(1)),
    longestSolarDarknessHours: Number(longestSolarDarknessHours.toFixed(1)),
    batteryStatus: longestSolarDarknessHours <= batteryLimitHours ? "safe" : "risk",
    segments,
  };
}
