/**
 * UTC time helpers. Wire format everywhere: ISO 8601 `YYYY-MM-DDTHH:MM:SSZ` (1 s resolution,
 * docs/OUTPUT_SPEC.md section 1). Samples are t_k = t0 + k*step_s; ranges are [start, end) (end exclusive).
 */

export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** Accepted on input: optional fractional seconds, mandatory `Z`. */
export const ISO_UTC_INPUT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export const MS_PER_S = 1000;
export const MS_PER_H = 3_600_000;

/** Date | epoch ms -> `YYYY-MM-DDTHH:MM:SSZ` (truncates sub-second part). */
export function toIsoUtc(t: Date | number): string {
  const ms = typeof t === 'number' ? t : t.getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`invalid time: ${String(t)}`);
  return new Date(Math.floor(ms / MS_PER_S) * MS_PER_S).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Parse an ISO UTC string (must end in Z) -> epoch ms. Throws RangeError if invalid. */
export function parseIsoUtc(s: string): number {
  if (!ISO_UTC_INPUT_RE.test(s)) throw new RangeError(`not an ISO-8601 UTC time ending in Z: ${s}`);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new RangeError(`invalid date: ${s}`);
  return ms;
}

/**
 * Like parseIsoUtc, but rounds a sub-millisecond remainder UP to the next ms. Date.parse keeps only 3
 * fractional digits, so 15:00:00.000001Z would read as exactly 15:00:00 and an end bound that must snap UP
 * to the grid would lose the 15:00 sample (FE report 14/11). Use it for bounds that are rounded up
 * (end, earliest); plain parseIsoUtc (= floor) stays right for start / latest / t.
 */
export function parseIsoUtcCeil(s: string): number {
  const ms = parseIsoUtc(s);
  const frac = /\.(\d+)Z$/.exec(s)?.[1] ?? '';
  return /[1-9]/.test(frac.slice(3)) ? ms + 1 : ms;
}

/**
 * true when `s` matches ISO_UTC_INPUT_RE AND names a real calendar instant: Date.parse is lenient
 * (2026-02-30 -> 2026-03-02) or fails (hour 25, month 13), so the date/time fields must round-trip.
 */
export function isCalendarIsoUtc(s: string): boolean {
  if (!ISO_UTC_INPUT_RE.test(s)) return false;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return false;
  return toIsoUtc(ms) === `${s.slice(0, 19)}Z`;
}

export function isIsoUtc(s: string): boolean {
  try {
    parseIsoUtc(s);
    return true;
  } catch {
    return false;
  }
}

/** Index of the sample containing t: floor((t - t0) / step). May be negative / >= n. */
export function sampleIndex(tMs: number, t0Ms: number, stepS: number): number {
  return Math.floor((tMs - t0Ms) / (stepS * MS_PER_S));
}

/** Snap t DOWN to the sample grid t0 + k*step (k = floor). */
export function snapDown(tMs: number, t0Ms: number, stepS: number): number {
  return t0Ms + sampleIndex(tMs, t0Ms, stepS) * stepS * MS_PER_S;
}

/** Snap t UP to the sample grid (k = ceil); grid points map to themselves. */
export function snapUp(tMs: number, t0Ms: number, stepS: number): number {
  const stepMs = stepS * MS_PER_S;
  return t0Ms + Math.ceil((tMs - t0Ms) / stepMs) * stepMs;
}

export interface SnappedRange {
  startMs: number;
  endMs: number;
  /** index of the first sample */
  i0: number;
  /** number of samples in [start, end) */
  n: number;
  clampedStart: boolean;
  clampedEnd: boolean;
}

/**
 * Snap a requested [start, end) to the grid of a run [runStart, runEnd) and clamp to it:
 * start snaps down, end snaps up (so the requested instants are always covered).
 * Returns null when the (clamped) range is empty.
 */
export function snapRange(
  startMs: number,
  endMs: number,
  runStartMs: number,
  runEndMs: number,
  stepS: number,
): SnappedRange | null {
  let s = snapDown(startMs, runStartMs, stepS);
  let e = snapUp(endMs, runStartMs, stepS);
  const clampedStart = s < runStartMs;
  const clampedEnd = e > runEndMs;
  if (clampedStart) s = runStartMs;
  if (clampedEnd) e = runEndMs;
  if (e <= s) return null;
  const stepMs = stepS * MS_PER_S;
  return { startMs: s, endMs: e, i0: Math.round((s - runStartMs) / stepMs), n: Math.round((e - s) / stepMs), clampedStart, clampedEnd };
}

export const hoursBetween = (aMs: number, bMs: number): number => (bMs - aMs) / MS_PER_H;
export const addHours = (tMs: number, h: number): number => tMs + h * MS_PER_H;
/** Precision of every boundary/time derived from samples: +- one step, in hours. */
export const precisionH = (stepS: number): number => stepS / 3600;
