// Educational sample-level clearance, 4-state mission operations and lander orientation helpers.
// The what-if model linearly interpolates elevations only between adjacent valid observations.
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
  darknessClipped: boolean;
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
  return Math.max(0, Math.min(10, Math.round(value * 10) / 10));
}

export function shortestAzimuthDelta(azA: number, azB: number): number {
  const diff = Math.abs(((azA - azB) % 360 + 360) % 360);
  return Number((diff > 180 ? 360 - diff : diff).toFixed(1));
}

function clearanceState(sun: number, earth: number, mask: number): Exclude<MissionOpState, "unavailable"> {
  if (sun > mask) return earth > mask ? "golden" : "solar-only";
  return earth > mask ? "comms-only" : "blackout";
}

export function evaluateSampleClearance(sample: Sample | undefined, clearanceDeg = 0): MissionOpState {
  if (!sample?.sun || !sample.earth) return "unavailable";
  return clearanceState(sample.sun.elevationDeg, sample.earth.elevationDeg, clampClearanceDeg(clearanceDeg));
}

export function computeLanderHud(sample: Sample | undefined, clearanceDeg = 0): LanderHudMetrics {
  const mask = clampClearanceDeg(clearanceDeg);
  const sun = sample?.sun ?? null;
  const earth = sample?.earth ?? null;
  const sunClearsMask = sun !== null && sun.elevationDeg > mask;
  const earthClearsMask = earth !== null && earth.elevationDeg > mask;
  const azimuthSeparationDeg = sun && earth ? shortestAzimuthDelta(sun.azimuthDeg, earth.azimuthDeg) : null;
  const shadowAzimuthDeg = sun && sun.elevationDeg > 0 && sun.elevationDeg < 90
    ? Number((sun.azimuthDeg + 180).toFixed(1)) % 360 : null;
  const shadowLengthFactor = !sun || sun.elevationDeg <= 0 ? null
    : sun.elevationDeg === 90 ? 0 : 1 / Math.tan(sun.elevationDeg * Math.PI / 180);
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
  const span = windowEnd - windowStart;
  const maxStep = scenario.sampleStepSeconds * 1000;
  const samples = scenario.samples;
  let complete = scenario.coverage === "complete" && samples.length >= 2
    && Date.parse(samples[0].utc) === windowStart && Date.parse(samples[samples.length - 1].utc) === windowEnd;
  const segments: MissionSegment[] = [];
  const totals = { golden: 0, "solar-only": 0, "comms-only": 0, blackout: 0 };
  let longestGolden = 0, longestDark = 0, currentDark = 0;
  let cursor = windowStart;

  const appendUnavailable = (from: number, to: number) => {
    const start = Math.max(windowStart, from), end = Math.min(windowEnd, to);
    if (end <= start) return;
    const startUtc = new Date(start).toISOString(), endUtc = new Date(end).toISOString();
    const previous = segments.at(-1);
    if (previous?.state === "unavailable" && previous.endUtc === startUtc) {
      previous.endUtc = endUtc;
      previous.durationHours = (end - Date.parse(previous.startUtc)) / 3_600_000;
      previous.widthPct = (end - Date.parse(previous.startUtc)) / span * 100;
    } else {
      segments.push({ state: "unavailable", startUtc, endUtc, durationHours: (end - start) / 3_600_000,
        startPct: (start - windowStart) / span * 100, widthPct: (end - start) / span * 100 });
    }
  };

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const start = Date.parse(a.utc), end = Date.parse(b.utc);
    const step = end - start;
    if (start > cursor) {
      appendUnavailable(cursor, start);
      complete = false;
      currentDark = 0;
    }
    if (!(start >= windowStart && end <= windowEnd && step > 0 && step <= maxStep)
        || !a.sun || !b.sun || !a.earth || !b.earth) {
      complete = false;
      currentDark = 0;
      appendUnavailable(start, end);
      cursor = Math.max(cursor, Math.min(windowEnd, end));
      continue;
    }
    const sun = a.sun.elevationDeg, earth = a.earth.elevationDeg;
    const sunChange = b.sun.elevationDeg - sun, earthChange = b.earth.elevationDeg - earth;
    if (![sun, b.sun.elevationDeg, earth, b.earth.elevationDeg].every(value => Number.isFinite(value) && Math.abs(value) <= 90)) {
      complete = false;
      currentDark = 0;
      continue;
    }
    const cuts = [0, 1];
    for (const [elevation, change] of [[sun, sunChange], [earth, earthChange]]) {
      if (change === 0) continue;
      const crossing = (mask - elevation) / change;
      if (crossing > 0 && crossing < 1) cuts.push(crossing);
    }
    cuts.sort((x, y) => x - y);
    for (let j = 1; j < cuts.length; j++) {
      const from = start + Math.round(step * cuts[j - 1]);
      const to = start + Math.round(step * cuts[j]);
      if (to <= from) continue;
      // Between consecutive threshold crossings neither body's strict comparison changes.
      const mid = (cuts[j - 1] + cuts[j]) / 2;
      const state = clearanceState(sun + mid * sunChange, earth + mid * earthChange, mask);
      totals[state] += to - from;
      currentDark = state === "comms-only" || state === "blackout" ? currentDark + to - from : 0;
      longestDark = Math.max(longestDark, currentDark);

      const startUtc = new Date(from).toISOString(), endUtc = new Date(to).toISOString();
      const previous = segments.at(-1);
      // A touch at a shared sample breaks a strictly-above streak, even when its duration is zero.
      const joins = cuts[j - 1] === 0 && clearanceState(sun, earth, mask) === state;
      if (previous && previous.state === state && previous.endUtc === startUtc && joins) {
        previous.endUtc = endUtc;
        const duration = to - Date.parse(previous.startUtc);
        previous.durationHours = duration / 3_600_000;
        previous.widthPct = duration / span * 100;
      } else {
        segments.push({ state, startUtc, endUtc, durationHours: (to - from) / 3_600_000,
          startPct: (from - windowStart) / span * 100, widthPct: (to - from) / span * 100 });
      }
      if (state === "golden") longestGolden = Math.max(longestGolden, segments[segments.length - 1].durationHours);
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < windowEnd) {
    appendUnavailable(cursor, windowEnd);
    complete = false;
  }
  const darknessClipped = segments.some(segment =>
    (segment.state === "comms-only" || segment.state === "blackout")
    && (Date.parse(segment.startUtc) === windowStart || Date.parse(segment.endUtc) === windowEnd));
  const hours = (milliseconds: number) => complete ? milliseconds / 3_600_000 : null;
  return {
    clearanceDeg: mask,
    coverage: !complete && scenario.coverage === "complete" ? "partial" : scenario.coverage,
    goldenHours: hours(totals.golden),
    solarOnlyHours: hours(totals["solar-only"]),
    commsOnlyHours: hours(totals["comms-only"]),
    blackoutHours: hours(totals.blackout),
    longestGoldenStreakHours: complete ? longestGolden : null,
    longestSolarDarknessHours: hours(longestDark),
    darknessClipped,
    batteryStatus: !complete || darknessClipped ? "unknown" : longestDark <= batteryLimitHours * 3_600_000 ? "safe" : "risk",
    segments,
  };
}
