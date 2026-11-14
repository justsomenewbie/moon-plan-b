/**
 * Pure helpers of GET /api/v1/dataset (no MongoDB): series decimation that keeps every visibility
 * transition, horizon resampling, visible windows, range metrics and threshold criteria, the energy
 * proxies (mean panel power) and the survival hint (include=survival_hint).
 * Unit-tested in tests/routes/dataset/build.test.ts and tests/pointing/dataset_hint.test.ts.
 */
import { createHash } from 'node:crypto';
import type { DatasetCriterion, DatasetHorizon, DatasetSurvivalHint, DatasetWindow, DatasetWindowMetrics } from '../contract/dataset.ts';
import type { WindowKind } from '../contract/common.ts';
import { fmtHours, fmtNum } from '../contract/pointing.ts';
import type { HorizonDoc, WindowDoc } from '../repos/types.ts';
import { toIsoUtc } from '../lib/time.ts';
import { batteryText, nightOnlyBatteryWhOfRuns } from '../mission/energy.ts';
import { pyRound } from './a/pyround.ts';

// =================================================================================================
// series decimation
// =================================================================================================

export interface Decimation {
  /** Kept sample indices, strictly increasing. */
  indices: number[];
  /** Stride of the regular samples (>= kReq). */
  k: number;
  /** Changes of sun_visible or earth_visible between consecutive samples. */
  nTransitions: number;
  /** Distinct samples kept because they sit next to a transition (i-1 and i of every change). */
  nTransSamples: number;
}

/** Thrown when the transition samples alone do not fit in maxPoints (route -> 422). */
export class TooManyTransitionsError extends Error {
  readonly needed: number;
  readonly maxPoints: number;
  constructor(needed: number, maxPoints: number) {
    super(`${needed} transition samples do not fit in max_points=${maxPoints}`);
    this.needed = needed;
    this.maxPoints = maxPoints;
  }
}

/**
 * Keep sample 0, every k-th sample, the last sample, and both samples i-1, i around every change of
 * sun or earth visibility. k starts at kReq and grows until the result has <= maxPoints samples.
 * kReq = 1 and n <= maxPoints -> every sample.
 */
export function decimateSeries(sunVis: readonly boolean[], earthVis: readonly boolean[], kReq: number, maxPoints: number): Decimation {
  const n = sunVis.length;
  const trans = new Uint8Array(n);
  let nTransitions = 0;
  let nTransSamples = 0;
  for (let i = 1; i < n; i++) {
    if (sunVis[i] !== sunVis[i - 1] || earthVis[i] !== earthVis[i - 1]) {
      nTransitions++;
      if (trans[i - 1] === 0) {
        trans[i - 1] = 1;
        nTransSamples++;
      }
      trans[i] = 1;
      nTransSamples++;
    }
  }
  const all = (): number[] => Array.from({ length: n }, (_v, i) => i);
  if (n === 0) return { indices: [], k: Math.max(1, kReq), nTransitions, nTransSamples };
  if (kReq <= 1 && n <= maxPoints) return { indices: all(), k: 1, nTransitions, nTransSamples };
  if (nTransSamples + 2 > maxPoints) throw new TooManyTransitionsError(nTransSamples + 2, maxPoints);

  const pick = (k: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (i % k === 0 || i === n - 1 || trans[i] === 1) out.push(i);
    return out;
  };
  // upper bound that always fits: ceil(n/k) regular + transitions + last <= maxPoints
  const kHigh = Math.max(kReq, Math.ceil(n / Math.max(1, maxPoints - nTransSamples - 1)));
  for (let k = Math.max(1, kReq, Math.ceil(n / maxPoints)); k < kHigh; k++) {
    const idx = pick(k);
    if (idx.length <= maxPoints) return { indices: idx, k, nTransitions, nTransSamples };
  }
  return { indices: pick(kHigh), k: kHigh, nTransitions, nTransSamples };
}

/**
 * Quick first payload check, before anything is read: regular samples per site (capped by max_points),
 * WITHOUT the transition samples. The exact count (planSeriesPoints) is checked once the windows are loaded.
 */
export function estimatePoints(n: number, kReq: number, maxPoints: number): number {
  return Math.min(maxPoints, Math.ceil(n / Math.max(1, kReq)) + (kReq > 1 ? 1 : 0));
}

/**
 * Per-sample visibility of the n grid samples [startMs, startMs + n * step) rebuilt from the clipped
 * windows of one kind (the stored windows tile the run, so this equals the stored flags when the
 * series has no gaps).
 */
export function flagsFromSpans(spans: readonly ClippedSpan[], startMs: number, stepS: number, n: number): boolean[] {
  const stepMs = stepS * 1000;
  const out = new Array<boolean>(n).fill(false);
  for (const s of spans) {
    if (!s.state) continue;
    const i0 = Math.max(0, Math.round((s.startMs - startMs) / stepMs));
    const i1 = Math.min(n, i0 + s.n);
    for (let i = i0; i < i1; i++) out[i] = true;
  }
  return out;
}

export interface SeriesPlan {
  /** Series points the site will return (decimateSeries on the window-derived flags). */
  points: number;
  /** Samples kept because of visibility transitions (+2 = the smallest max_points that can work). */
  transSamples: number;
}

/**
 * Exact series point count of one site BEFORE its series is read: decimateSeries() run on the
 * visibility flags rebuilt from the windows, so the transition samples are counted. Throws
 * TooManyTransitionsError like decimateSeries.
 */
export function planSeriesPoints(
  sun: readonly ClippedSpan[],
  earth: readonly ClippedSpan[],
  startMs: number,
  stepS: number,
  n: number,
  kReq: number,
  maxPoints: number,
): SeriesPlan {
  const d = decimateSeries(flagsFromSpans(sun, startMs, stepS, n), flagsFromSpans(earth, startMs, stepS, n), kReq, maxPoints);
  return { points: d.indices.length, transSamples: d.nTransSamples };
}

// =================================================================================================
// horizon
// =================================================================================================

/**
 * Resample the stored silhouette (uniform grid i * az_step_deg) at 0, step, ..., 360 (inclusive, the
 * last point repeats azimuth 0). Exact stored values where the grids coincide, else periodic linear
 * interpolation rounded to 6 decimals. A coarser output step POINT-SAMPLES the stored grid (1 deg from
 * the stored 0.5 deg drops the odd half-degree samples, so a narrow peak between two whole degrees is
 * not drawn); only the stored step is exactly consistent with sun_visible / earth_visible. Max-of-bin
 * was measured to disagree with the flags MORE often, so it is deliberately not used.
 */
export function resampleHorizon(h: Pick<HorizonDoc, 'az_step_deg' | 'el_deg' | 'min_el_deg' | 'max_el_deg' | 'method' | 'dem_source'>, stepDeg: number): DatasetHorizon {
  const n = h.el_deg.length;
  const m = Math.round(360 / stepDeg);
  const az: number[] = [];
  const el: number[] = [];
  for (let j = 0; j <= m; j++) {
    const a = j === m ? 360 : j * stepDeg;
    az.push(a);
    if (n === 0) {
      el.push(0);
      continue;
    }
    const pos = (a % 360) / h.az_step_deg;
    const i0 = Math.floor(pos + 1e-9);
    const frac = pos - i0;
    const e0 = h.el_deg[((i0 % n) + n) % n] ?? 0;
    if (frac < 1e-9) {
      el.push(e0);
    } else {
      const e1 = h.el_deg[(i0 + 1) % n] ?? e0;
      el.push(pyRound(e0 + (e1 - e0) * frac, 6));
    }
  }
  return {
    step_deg: stepDeg,
    az_deg: az,
    el_deg: el,
    min_el_deg: h.min_el_deg,
    max_el_deg: h.max_el_deg,
    source_step_deg: h.az_step_deg,
    method: h.method,
    dem_source: h.dem_source,
  };
}

// =================================================================================================
// windows + metrics
// =================================================================================================

/** A stored window intersected with [startMs, endMs). */
export interface ClippedSpan {
  state: boolean;
  startMs: number;
  endMs: number;
  /** samples inside the range */
  n: number;
  clipped_start: boolean;
  clipped_end: boolean;
}

export function clipSpans(list: readonly WindowDoc[], startMs: number, endMs: number, stepS: number): ClippedSpan[] {
  const stepMs = stepS * 1000;
  const out: ClippedSpan[] = [];
  for (const w of list) {
    const ws = w.start.getTime();
    const we = w.end.getTime();
    if (!(ws < endMs && we > startMs)) continue;
    const s = Math.max(ws, startMs);
    const e = Math.min(we, endMs);
    out.push({
      state: w.state,
      startMs: s,
      endMs: e,
      n: Math.round((e - s) / stepMs),
      clipped_start: s > ws || w.truncated_start,
      clipped_end: e < we || w.truncated_end,
    });
  }
  return out;
}

const WINDOW_KIND_LIST: readonly WindowKind[] = ['sun', 'earth', 'both'];

const hoursOf = (n: number, stepS: number): number => pyRound((n * stepS) / 3600, 6);

export function visibleWindows(spans: readonly ClippedSpan[], stepS: number): DatasetWindow[] {
  return spans
    .filter((s) => s.state)
    .map((s) => ({ start: toIsoUtc(s.startMs), end: toIsoUtc(s.endMs), duration_h: hoursOf(s.n, stepS), clipped_start: s.clipped_start, clipped_end: s.clipped_end }));
}

/** First span with the strictly greatest length among those in `state` (Python order). */
function longestSpan(spans: readonly ClippedSpan[], state: boolean): ClippedSpan | null {
  let best: ClippedSpan | null = null;
  for (const s of spans) if (s.state === state && (best === null || s.n > best.n)) best = s;
  return best;
}

/**
 * Edges of the longest Sun+Earth interval(s) inside the range (all intervals of length longest_both_h).
 * A sampled edge is uncertain by up to one data step: the true rise is in (t_first - step, t_first] and
 * the true set in [t_last, t_last + step), so a sampled start can only ADD up to one step and a sampled
 * end can only REMOVE up to one step. Inside the range, a start AT the range start is exact (the true
 * rise is <= range start) and an end cut by the range / run end (clipped_end) is exact.
 */
export interface LongestBothEdges {
  /** Some longest interval is cut by the range or run boundary: the full interval may be longer outside the range. */
  clipped: boolean;
  /** Some longest interval ends at the range end (clipped_end): nothing can shorten it. */
  endExact: boolean;
  /** Some longest interval starts after the range start (a sampled rise): it may be up to one step longer inside the range. */
  startUncertain: boolean;
}

export interface MetricsResult {
  metrics: DatasetWindowMetrics;
  longestBoth: LongestBothEdges;
}

/**
 * Metrics over a range of nRange samples from the clipped windows of each kind (windows tile the run,
 * so the clipped ones tile the range). Same float operations as lunarnav.windows.compute_metrics.
 */
export function rangeMetrics(
  spans: Record<WindowKind, readonly ClippedSpan[]>,
  nRange: number,
  stepS: number,
  rangeStartMs: number = Math.min(...WINDOW_KIND_LIST.flatMap((k) => spans[k].map((s) => s.startMs))),
): MetricsResult {
  const total = nRange * stepS;
  const count = (k: WindowKind): number => spans[k].reduce((a, s) => a + (s.state ? s.n : 0), 0);
  const pct = (k: number): number => (total > 0 ? pyRound((100.0 * (k * stepS)) / total, 6) : 0);
  const len = (s: ClippedSpan | null): number => (s ? hoursOf(s.n, stepS) : 0);
  const nSun = count('sun');
  const nEarth = count('earth');
  const nBoth = count('both');
  const lb = longestSpan(spans.both, true);
  const longest = lb ? spans.both.filter((s) => s.state && s.n === lb.n) : [];
  return {
    metrics: {
      duration_h: pyRound(total / 3600, 6),
      pct_sun: pct(nSun),
      pct_earth: pct(nEarth),
      pct_both: pct(nBoth),
      sun_hours: hoursOf(nSun, stepS),
      earth_hours: hoursOf(nEarth, stepS),
      both_hours: hoursOf(nBoth, stepS),
      longest_sun_h: len(longestSpan(spans.sun, true)),
      longest_earth_h: len(longestSpan(spans.earth, true)),
      longest_both_h: len(lb),
      longest_dark_h: len(longestSpan(spans.sun, false)),
      longest_comms_gap_h: len(longestSpan(spans.earth, false)),
    },
    longestBoth:
      longest.length === 0
        ? // no simultaneous sample: an interval shorter than one step may have been missed
          { clipped: false, endExact: false, startUncertain: true }
        : {
            clipped: longest.some((s) => s.clipped_start || s.clipped_end),
            endExact: longest.some((s) => s.clipped_end),
            // an interval starting AT the range start cannot grow inside the range (its true rise is <= range start)
            startUncertain: longest.some((s) => s.startMs > rangeStartMs),
          },
  };
}

/** Samples of the range covered by stored windows (windows tile the run). */
export const coveredSamples = (sunSpans: readonly ClippedSpan[]): number => sunSpans.reduce((a, s) => a + s.n, 0);

// =================================================================================================
// criteria
// =================================================================================================

const fmtH = (h: number): string => `${Number.isInteger(h) ? h : pyRound(h, 3)} h`;

/**
 * Each minimum against v = longest_both_h (the longest Sun+Earth interval INSIDE the range). From the
 * edges (LongestBothEdges) the true in-range length L is in [v or (v - step, and v] or v + step). meets
 * when every possible L >= minimum, below when every possible L < minimum, else borderline. With both
 * edges sampled this is the plain rule borderline <=> |v - minimum| < one step; with both edges cut by
 * the range L = v exactly, so the result is meets or below.
 */
export function evaluateCriteria(m: DatasetWindowMetrics, edges: LongestBothEdges, minimums: readonly number[], stepS: number): DatasetCriterion[] {
  const stepH = stepS / 3600;
  const v = m.longest_both_h;
  const num = (h: number): string => String(Number.isInteger(h) ? h : pyRound(h, 3));
  const span = `${edges.endExact ? `[${num(v)}` : `(${num(v - stepH)}`}, ${edges.startUncertain ? `${num(v + stepH)})` : `${num(v)}]`} h`;
  const clippedNote = edges.clipped ? '; that interval is cut by the range or run boundary, so the full interval may be longer outside the range' : '';
  return minimums.map((min) => {
    const diff = v - min;
    const meets = edges.endExact ? diff >= 0 : diff >= stepH;
    const below = edges.startUncertain ? diff <= -stepH : diff < 0;
    let result: DatasetCriterion['result'];
    let reason: string;
    if (meets) {
      result = 'meets';
      reason = `Longest simultaneous Sun + Earth interval is ${fmtH(v)} >= ${fmtH(min)}`;
    } else if (below) {
      result = 'below';
      reason = `Longest simultaneous Sun + Earth interval is ${fmtH(v)} < ${fmtH(min)}`;
    } else {
      result = 'borderline';
      reason =
        `Longest simultaneous Sun + Earth interval is ${fmtH(v)}; rise and set times are known to one data step (${fmtH(stepH)}), ` +
        `so its true length in the range is in ${span}, which straddles the ${fmtH(min)} minimum`;
    }
    return { minimum_hours: min, metric: 'longest_both_h' as const, value_h: v, value_clipped: edges.clipped, result, reason: `${reason}${clippedNote}.` };
  });
}

// =================================================================================================
// energy proxies (metrics.mean_power_*_pct) + survival hint (include=survival_hint)
// =================================================================================================

/** Sums of the power columns over the stored samples of a range (repos.seriesSums). */
export interface PowerSums {
  n: number;
  sum_power_tracking: number;
  sum_power_horizontal: number;
}

/** 100 * mean power_tracking / power_horizontal, 4 decimals (= summary.csv's 6-decimal fraction); null when no sample. */
export function meanPowerPct(s: PowerSums | undefined): { mean_power_tracking_pct: number | null; mean_power_horizontal_pct: number | null } {
  if (!s || s.n <= 0) return { mean_power_tracking_pct: null, mean_power_horizontal_pct: null };
  const pct = (sum: number): number => Math.min(100, Math.max(0, pyRound((100 * sum) / s.n, 4)));
  return { mean_power_tracking_pct: pct(s.sum_power_tracking), mean_power_horizontal_pct: pct(s.sum_power_horizontal) };
}

/** "17.7 kWh" / "850 Wh". */
export function fmtEnergy(wh: number): string {
  return wh >= 1000 ? `${fmtNum(wh / 1000, 2)} kWh` : `${fmtNum(wh, 1)} Wh`;
}

/**
 * Battery the reference night load needs: nightOnlyBatteryWhOfRuns() of the POST /mission/survival energy
 * model (src/mission/energy.ts) - the same function that gives that route's required_battery_night_only_wh -
 * over the dark periods of the range: each starts FULL (an unlimited panel refilled it in the lit period
 * before), zero panel input, the night load, reserve 0 %; worst period kept (= night_load_w * longest_dark_h).
 */
export function nightBatteryWh(darkSteps: readonly number[], stepS: number, nightLoadW: number): number {
  return pyRound(nightOnlyBatteryWhOfRuns(darkSteps, stepS / 3600, nightLoadW), 6);
}

/**
 * survival_hint of one site from its clipped sun windows (they tile the range, so the longest dark
 * span = metrics.longest_dark_h). nightLoadW null -> required_battery_wh null.
 */
export function survivalHint(sunSpans: readonly ClippedSpan[], stepS: number, nightLoadW: number | null): DatasetSurvivalHint {
  const dark = sunSpans.filter((s) => !s.state);
  const longest = longestSpan(sunSpans, false);
  const h = longest ? hoursOf(longest.n, stepS) : 0;
  const clipped = longest ? dark.some((s) => s.n === longest.n && (s.clipped_start || s.clipped_end)) : false;
  const req = nightLoadW === null ? null : nightBatteryWh(dark.map((s) => s.n), stepS, nightLoadW);
  const startUtc = longest ? toIsoUtc(longest.startMs) : null;
  const endUtc = longest ? toIsoUtc(longest.endMs) : null;

  let en: string;
  let vi: string;
  if (!longest || h === 0) {
    en = 'The Sun is visible during the whole range: no battery is needed for the night.';
    vi = 'Mặt Trời chiếu suốt khoảng thời gian này: không cần pin cho ban đêm.';
  } else {
    en = `Longest night in the range: ${fmtHours(h, 'en')}, from ${startUtc} to ${endUtc}`;
    vi = `Đêm dài nhất trong khoảng: ${fmtHours(h, 'vi')}, từ ${startUtc} đến ${endUtc}`;
    if (clipped) {
      en += ' (a night this long is cut by the range or run boundary: the real longest night may be longer)';
      vi += ' (một đêm dài như vậy bị cắt bởi giới hạn khoảng thời gian / dữ liệu: đêm thật có thể còn dài hơn)';
    }
    const atLeast = clipped ? ' at least' : '';
    const itNhat = clipped ? ' ít nhất' : '';
    // never lit: no lit period refills the battery, so "starting full" means charged BEFORE the range
    const neverLit = !sunSpans.some((s) => s.state && s.n > 0);
    if (neverLit) {
      en += '. The Sun is never visible in the range: no lit period can recharge the battery, so a solar panel cannot keep the lander running here';
      vi += '. Mặt Trời không lúc nào lộ ra trong khoảng này: không có lúc nào sạc lại được pin, tấm pin mặt trời không thể nuôi tàu ở đây';
    }
    if (req !== null && nightLoadW !== null) {
      if (neverLit) {
        en += `. A ${fmtNum(nightLoadW, 1)} W night load drains${atLeast} ${batteryText(req)} over this dark period (a battery charged BEFORE the range, never recharged).`;
        vi += `. Tải ban đêm ${fmtNum(nightLoadW, 1)} W tiêu hao${itNhat} ${batteryText(req)} trong thời gian tối này (pin phải được sạc đầy TRƯỚC khoảng này, không sạc lại được).`;
      } else {
        en += `. A ${fmtNum(nightLoadW, 1)} W night load needs a battery of${atLeast} ${batteryText(req)} (usable, starting full).`;
        vi += `. Tải ban đêm ${fmtNum(nightLoadW, 1)} W cần pin${itNhat} ${batteryText(req)} (dung lượng dùng được, pin đầy khi bắt đầu đêm).`;
      }
    } else {
      en += '. Give night_load_w to size the battery (Wh = night load W x dark hours).';
      vi += '. Nhập night_load_w để tính pin cần thiết (Wh = tải ban đêm W x số giờ tối).';
    }
  }
  return {
    longest_dark_h: h,
    longest_dark_start: startUtc,
    longest_dark_end: endUtc,
    longest_dark_clipped: clipped,
    night_load_w: nightLoadW,
    required_battery_wh: req,
    summary: { en, vi },
  };
}

/** Assumptions of include=survival_hint (and of metrics.mean_power_*_pct). */
export function survivalHintAssumptions(stepS: number, terrain = true): string[] {
  const stepH = stepS / 3600;
  const dark = terrain
    ? 'Dark = sun_visible false: the upper limb of the Sun is below the TERRAIN horizon (not just el < 0).'
    : 'Dark = sun_visible false: the upper limb of the Sun is below an IDEAL FLAT horizon (this run has no terrain model: flat horizon / no DEM, so terrain shadowing is NOT included).';
  return [
    `${dark} longest_dark_h = the longest run of consecutive dark samples inside the requested range, accurate to +- ${stepH} h at each end.`,
    'required_battery_wh = night_load_w x longest_dark_h: the battery starts every dark period FULL (the panel refilled it during the lit period before), the panel gives nothing while dark, the battery may be drained to 0 % (no reserve), 100 % charge / discharge efficiency, no ageing or temperature effect. Computed with nightOnlyBatteryWhOfRuns() of the POST /mission/survival energy model (src/mission/energy.ts): the same number as required_battery_night_only_wh of POST /mission/survival for the same range [landing, landing + mission_h) and night_load_w. The battery size in the summary text is rounded UP (0.1 kWh / 1 Wh), as in the /mission/survival verdict.',
    'Only the night load is counted: the day load and the panel size are NOT checked (a panel too small to refill the battery in the lit period needs a bigger battery). POST /mission/survival simulates the hour-by-hour state of charge with a real panel, day load and reserve.',
    'When a dark period of that length is cut by the range or run boundary (longest_dark_clipped), the real longest night may be longer: longest_dark_h and required_battery_wh are then lower bounds.',
    'When the Sun is never visible in the range (metrics.sun_hours = 0) no lit period can recharge the battery: required_battery_wh is then the energy the night load draws over the whole range from a battery charged before it, and no solar panel helps.',
    'metrics.mean_power_tracking_pct / mean_power_horizontal_pct = 100 x the mean of the hourly power_tracking (= sun_fraction, a 2-axis Sun-tracking panel) / power_horizontal (= sun_fraction x max(0, sin el), a flat panel) columns over the stored samples of the range: output relative to a panel facing the Sun in full sunlight at a fixed 1361 W/m2 (the few-% change of the Sun distance is not included).',
  ];
}

// =================================================================================================
// sources + ids
// =================================================================================================

export interface SourceLike {
  name: string;
  url?: string | null | undefined;
  sha256?: string | null | undefined;
}

/** manifest data_sources -> {id, title, url, sha256}, deduplicated by name; ids are unique slugs. */
export function sourcesOf(list: readonly SourceLike[]): { id: string; title: string; url: string | null; sha256: string | null }[] {
  const seen = new Set<string>();
  const ids = new Set<string>();
  const out: { id: string; title: string; url: string | null; sha256: string | null }[] = [];
  for (const s of list) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    const base =
      s.name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '') || 'source';
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
    ids.add(id);
    out.push({ id, title: s.name, url: s.url ?? null, sha256: s.sha256 ?? null });
  }
  return out;
}

export const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);
