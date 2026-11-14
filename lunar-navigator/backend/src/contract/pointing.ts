/**
 * GET /api/v1/sites/{site_id}/pointing - WHERE TO POINT the solar panel and the antenna at one instant,
 * in compass words, with the time left before sunset / earthset (or until sunrise / earthrise).
 * The same `PointingCore` block is embedded per site in GET /dataset (`include=pointing` -> sites[].now).
 *
 * Everything is read from the stored hourly sample containing t (= the /instant readout): no new
 * geometry, only a re-statement of sun_az/el (panel) and earth_az/el (antenna) plus the terrain-horizon
 * flags. Every assumption is returned under `assumptions` (POINTING_ASSUMPTIONS).
 */
import { z } from 'zod';
import { IsoUtc, IsoUtcInput, SiteId, provenance, runIdQuery } from './common.ts';
import { exampleInstant } from '../fixtures/index.ts';
import { COMPASS_CODES, compassPoint } from '../lib/compass.ts';
import { MS_PER_H, parseIsoUtc, toIsoUtc } from '../lib/time.ts';
import { nextEventFromColumn } from './series.ts';

// ---- query -----------------------------------------------------------------------------------------
export const PointingQuery = z.strictObject({
  run_id: runIdQuery,
  t: IsoUtcInput.describe('Instant to read; the hourly sample k = floor((t - run start) / step_s) containing it is used'),
});
export type PointingQuery = z.output<typeof PointingQuery>;

// ---- response ----------------------------------------------------------------------------------------
export const Compass = z
  .object({
    code: z.enum(COMPASS_CODES).describe('16-point compass code (N, NNE, NE, ... NNW)'),
    en: z.string().describe('English name, e.g. "northeast"'),
    vi: z.string().describe('Vietnamese name, e.g. "Đông Bắc"'),
  })
  .describe('16-point compass direction of an azimuth: sector i is centred on i * 22.5 deg (+- 11.25 deg; a boundary belongs to the clockwise sector)')
  .meta({ id: 'Compass' });
export type Compass = z.output<typeof Compass>;

const hoursUntil = (what: string) =>
  z
    .number()
    .min(0)
    .nullable()
    .describe(`Hours from t until ${what} (0 = already in that state); null = it does not happen before the run end (so at least hours_to_run_end). Accurate to +- precision_h.`);

export const PointingPanel = z
  .object({
    azimuth_deg: z.number().describe('Direction the panel must FACE = Sun azimuth, deg clockwise from local north [0, 360)'),
    compass: Compass,
    tilt_from_vertical_deg: z
      .number()
      .describe(
        'For a panel whose face points at the Sun: tilt back from vertical = Sun elevation (near the poles the Sun is low, so the panel stands almost upright; negative = the Sun centre is below the horizontal plane, lean forward)',
      ),
    tilt_from_horizontal_deg: z.number().describe('= 90 - tilt_from_vertical_deg (the same panel measured from the ground)'),
    panel_normal_elevation_deg: z.number().describe('Elevation of the panel normal = Sun centre elevation, deg'),
    sun_visible: z.boolean().describe('Upper limb of the Sun above the TERRAIN horizon (not el > 0)'),
    sun_fraction: z.number().min(0).max(1).describe('Visible fraction of the solar disc above the terrain horizon'),
    sun_clearance_deg: z.number().describe('Sun centre elevation minus terrain horizon elevation at the Sun azimuth (negative = hidden by terrain)'),
    power_tracking: z.number().min(0).max(1).describe('Relative output of a Sun-tracking panel at this sample (= sun_fraction)'),
    power_horizontal: z.number().min(0).max(1).describe('Relative output of a flat-lying panel (= sun_fraction * max(0, sin el))'),
    irradiance_tracking_wm2: z.number().min(0).describe('Irradiance on the Sun-tracking panel, W/m2 (solar distance and visible fraction included)'),
    hours_until_sunset: hoursUntil('the Sun is hidden (dark window starts)'),
    sunset_utc: IsoUtc.nullable().describe('Instant of the next sunset (= t when already dark); null when none before the run end'),
    hours_until_sunrise: hoursUntil('the Sun is visible again'),
    sunrise_utc: IsoUtc.nullable().describe('Instant of the next sunrise (= t when already lit); null when none before the run end'),
  })
  .meta({ id: 'PointingPanel' });
export type PointingPanel = z.output<typeof PointingPanel>;

export const PointingAntenna = z
  .object({
    azimuth_deg: z.number().describe('Direction to point the antenna = Earth centre azimuth, deg clockwise from local north [0, 360)'),
    compass: Compass,
    elevation_deg: z.number().describe('Antenna elevation = Earth centre elevation, deg'),
    earth_visible: z.boolean().describe('Earth centre more than min_earth_clearance_deg above the terrain horizon (direct-to-Earth link possible)'),
    clearance_deg: z.number().describe('Earth centre elevation minus terrain horizon elevation at the Earth azimuth'),
    hours_until_earthset: hoursUntil('the Earth is hidden (comms gap starts)'),
    earthset_utc: IsoUtc.nullable(),
    hours_until_earthrise: hoursUntil('the Earth is visible again'),
    earthrise_utc: IsoUtc.nullable(),
    distance_km: z.number().positive().describe('Observer -> Earth centre distance, km (for a link budget)'),
  })
  .meta({ id: 'PointingAntenna' });
export type PointingAntenna = z.output<typeof PointingAntenna>;

export const PlainSummary = z
  .object({
    en: z.string().describe('One line in plain English'),
    vi: z.string().describe('One line in plain Vietnamese'),
  })
  .meta({ id: 'PlainSummary' });

export const PointingCore = z
  .object({
    t: IsoUtc.describe('Requested instant (normalised to whole seconds)'),
    sample_utc: IsoUtc.describe('Start of the hourly sample that was read (<= t)'),
    panel: PointingPanel,
    antenna: PointingAntenna,
    hours_to_run_end: z.number().min(0).describe('Hours from t to the run end (the horizon of every hours_until_* value)'),
    summary: PlainSummary,
  })
  .meta({ id: 'PointingCore' });
export type PointingCore = z.output<typeof PointingCore>;

const PointingResponseShape = z.object({
  ...provenance,
  site_id: SiteId,
  ...PointingCore.shape,
  assumptions: z.array(z.string()).min(1).describe('Every assumption behind the numbers, in plain English'),
});
export type PointingResponse = z.output<typeof PointingResponseShape>;

/**
 * Whether a run / site horizon models the terrain: false for horizon_method 'flat' or dem 'none' (also the
 * 'none:outside-<dem>-coverage' smooth-sphere fallback) - the prose then says "horizon", not "terrain".
 */
export function terrainModelled(horizonMethod: string, demSource: string): boolean {
  return !(horizonMethod === 'flat' || demSource === 'none' || demSource.startsWith('none:'));
}

/** Prose options of the pointing block. terrain = false -> an ideal flat horizon (no DEM), see terrainModelled(). */
export interface PointingProse {
  terrain: boolean;
}
const TERRAIN: PointingProse = { terrain: true };

/** Assumptions of the pointing block (route B and /dataset include=pointing). terrain = false: flat horizon, no DEM. */
export function pointingAssumptions(minEarthClearanceDeg: number, observerHeightM: number, stepS: number, terrain = true): string[] {
  const stepH = stepS / 3600;
  const hz = terrain ? 'terrain horizon' : 'horizon';
  return [
    'Azimuth is measured in degrees clockwise from local north (N = 0, E = 90, S = 180, W = 270); compass names use 16 sectors of 22.5 deg centred on each name.',
    'Panel = a 2-axis Sun-tracking panel whose face points at the centre of the Sun: face azimuth = Sun azimuth, tilt back from vertical = Sun elevation (negative = lean forward: the Sun centre is below the horizontal plane). A fixed panel must be re-aimed as the Sun moves (about 0.5 deg of azimuth per hour near the poles).',
    terrain
      ? `Sun visible = the upper limb of the Sun is above the terrain horizon of the digital elevation model, seen from a ${observerHeightM} m mast; the Moon is airless (no refraction).`
      : `Sun visible = the upper limb of the Sun is above an IDEAL FLAT horizon: this run has no terrain model (flat horizon / no DEM), so hills and crater walls do NOT shadow the site; seen from a ${observerHeightM} m mast; the Moon is airless (no refraction).`,
    `sun_fraction = visible fraction of the solar disc above the ${hz}; sun_clearance_deg is measured to the Sun CENTRE, so it is negative while only the upper part of the disc shows (sun_visible true, sun_fraction < 1). A Sun-tracking panel then gives power_tracking = sun_fraction of its full-sun output.`,
    `Antenna = points at the centre of the Earth; Earth visible = the Earth centre is more than ${minEarthClearanceDeg} deg above the ${hz}. No antenna pattern, link budget or relay satellite is modelled.`,
    `Values are those of the hourly sample containing t (sample_utc <= t < sample_utc + ${stepH} h); times until sunset / sunrise / earthset / earthrise are measured from t and accurate to +- ${stepH} h.`,
    'An hours_until_* value of null means the event does not happen before the end of the computed run (it is at least hours_to_run_end away).',
  ];
}

// =================================================================================================
// pure builder (route B, /dataset now block, OpenAPI example)
// =================================================================================================

/** The parts of an /instant readout the pointing block needs (route: from the stored sample). */
export interface PointingReading {
  sun: { az_deg: number; el_deg: number; clearance_deg: number; fraction: number; visible: boolean; power_horizontal: number; power_tracking: number; irradiance_tracking_wm2: number };
  earth: { az_deg: number; el_deg: number; clearance_deg: number; visible: boolean; dist_km: number };
  /** Precomputed hours_until_* columns of the sample (hours from sample_utc; null = none before run end). */
  hours_until: { sunset: number | null; sunrise: number | null; earthset: number | null; earthrise: number | null };
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6 + 0;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Number for prose: at most `d` decimals, no trailing zeros. */
export function fmtNum(x: number, d = 1): string {
  const r = Number(x.toFixed(d));
  return String(Object.is(r, -0) ? 0 : r);
}

/** Duration for prose (1 decimal, as hours_until_*): "52 h", "146.5 h (6.1 d)" / "52 giờ", "146.5 giờ (6.1 ngày)". */
export function fmtHours(h: number, lang: 'en' | 'vi'): string {
  const hu = lang === 'en' ? 'h' : 'giờ';
  const du = lang === 'en' ? 'd' : 'ngày';
  if (h < 48) return `${fmtNum(h, 1)} ${hu}`;
  return `${fmtNum(h, 1)} ${hu} (${fmtNum(h / 24, 1)} ${du})`;
}

/** Percentage of a 0..1 fraction for prose: 1 decimal below 10 %, else whole, capped at 99 % (only used for a partly hidden disc). */
function fmtPartPct(f: number): string {
  const x = 100 * f;
  return x < 10 ? `${fmtNum(x, 1)} %` : `${Math.min(99, Math.round(x))} %`;
}

/** A disc whose centre is above the horizon reads as "whole disc visible" from this fraction up. */
const FULL_DISC_FRACTION = 0.995;

function summaryOf(p: PointingPanel, a: PointingAntenna, toEndH: number, prose: PointingProse): z.output<typeof PlainSummary> {
  // 2 decimals below 1 deg so a grazing Sun does not read "0° above the terrain"
  const deg = (x: number): string => `${fmtNum(x, Math.abs(x) < 0.95 ? 2 : 1)}°`;
  const pc = p.compass;
  const ac = a.compass;
  const t = prose.terrain;
  // "<event> in 9.5 h" / "no <event> before the end of the data (> 10 h)"
  const en = (h: number | null, event: string): string => (h === null ? `no ${event} before the end of the data (> ${fmtHours(toEndH, 'en')})` : `${event} in ${fmtHours(h, 'en')}`);
  // "còn 9.5 giờ đến lúc lặn" / "chưa lặn trước khi hết dữ liệu (> 10 giờ)"
  const vi = (h: number | null, soon: (d: string) => string, never: string): string => (h === null ? `${never} trước khi hết dữ liệu (> ${fmtHours(toEndH, 'vi')})` : soon(fmtHours(h, 'vi')));

  // tilt: a panel facing a Sun below the horizontal plane leans FORWARD (not "tilted back -1.3°")
  const tilt = p.tilt_from_vertical_deg;
  const tiltEn = tilt < 0 ? `leaning forward ${deg(-tilt)} from vertical (the Sun is ${deg(-tilt)} below the horizontal)` : `tilted back ${deg(tilt)} from vertical`;
  const tiltVi =
    tilt < 0 ? `nghiêng về phía trước ${deg(-tilt)} so với phương thẳng đứng (Mặt Trời thấp hơn mặt phẳng ngang ${deg(-tilt)})` : `ngả ra sau ${deg(tilt)} so với phương thẳng đứng`;

  // Sun: sun_clearance_deg is to the Sun CENTRE, so a partly visible disc (sun_visible, fraction < 1) has a
  // negative or small clearance -> say how much of the disc shows and what a tracking panel then gives
  const grazing = p.sun_clearance_deg < 0 || p.sun_fraction < FULL_DISC_FRACTION;
  const groundEn = t ? 'terrain' : 'horizon';
  const groundVi = t ? 'địa hình' : 'đường chân trời';
  const ridgeEn = t ? 'the ridge' : 'the horizon';
  const ridgeVi = t ? 'đỉnh địa hình' : 'đường chân trời';
  const c = p.sun_clearance_deg;
  const centreEn = c < 0 ? `centre ${deg(-c)} below ${ridgeEn}` : `centre ${deg(c)} above ${ridgeEn}`;
  const centreVi = c < 0 ? `tâm thấp hơn ${ridgeVi} ${deg(-c)}` : `tâm cao hơn ${ridgeVi} ${deg(c)}`;
  const outPct = fmtPartPct(p.power_tracking);
  const sunEn = grazing
    ? `the Sun is grazing the ${groundEn}: only ${fmtPartPct(p.sun_fraction)} of the disc is visible (${centreEn}), panel output ~${outPct} of full sun`
    : `the Sun is ${deg(c)} above the ${groundEn} (whole disc visible, panel output 100 % of full sun)`;
  const sunVi = grazing
    ? `Mặt Trời sát ${groundVi}: chỉ ${fmtPartPct(p.sun_fraction)} đĩa Mặt Trời lộ ra (${centreVi}), tấm pin chỉ phát ~${outPct} công suất nắng đầy đủ`
    : `Mặt Trời cao hơn ${groundVi} ${deg(c)} (lộ cả đĩa, tấm pin phát 100 % công suất nắng đầy đủ)`;

  const panelEn = p.sun_visible
    ? `Solar panel: face ${pc.code} (${pc.en}, azimuth ${deg(p.azimuth_deg)}), ${tiltEn}; ${sunEn}, ${en(p.hours_until_sunset, 'sunset')}`
    : `Solar panel: the Sun is ${t ? 'hidden by the terrain' : 'below the flat horizon'} (it is ${pc.code}, azimuth ${deg(p.azimuth_deg)}, elevation ${deg(p.panel_normal_elevation_deg)}); ${en(p.hours_until_sunrise, 'sunrise')}`;
  const antEn = a.earth_visible
    ? `Antenna: point ${ac.code} (${ac.en}, azimuth ${deg(a.azimuth_deg)}) at ${deg(a.elevation_deg)} elevation; ${en(a.hours_until_earthset, 'earthset')}`
    : `Antenna: the Earth is below the ${t ? 'terrain horizon' : 'flat horizon'} (no direct link; it is ${ac.code}, azimuth ${deg(a.azimuth_deg)}); ${en(a.hours_until_earthrise, 'earthrise')}`;
  const panelVi = p.sun_visible
    ? `Tấm pin: quay về hướng ${pc.vi} (${pc.code}, phương vị ${deg(p.azimuth_deg)}), ${tiltVi}; ${sunVi}, ${vi(p.hours_until_sunset, (d) => `còn ${d} đến lúc lặn`, 'Mặt Trời chưa lặn')}`
    : `Tấm pin: Mặt Trời ${t ? 'đang bị địa hình che' : 'ở dưới đường chân trời phẳng'} (ở hướng ${pc.vi}, phương vị ${deg(p.azimuth_deg)}, độ cao ${deg(p.panel_normal_elevation_deg)}); ${vi(p.hours_until_sunrise, (d) => `còn ${d} đến lúc mọc`, 'Mặt Trời chưa mọc')}`;
  const antVi = a.earth_visible
    ? `Ăng-ten: chĩa về hướng ${ac.vi} (${ac.code}, phương vị ${deg(a.azimuth_deg)}), góc ngẩng ${deg(a.elevation_deg)}; ${vi(a.hours_until_earthset, (d) => `Trái Đất lặn sau ${d}`, 'Trái Đất chưa lặn')}`
    : `Ăng-ten: Trái Đất khuất dưới đường chân trời ${t ? 'địa hình' : 'phẳng'} (không liên lạc trực tiếp; ở hướng ${ac.vi}, phương vị ${deg(a.azimuth_deg)}); ${vi(a.hours_until_earthrise, (d) => `Trái Đất mọc sau ${d}`, 'Trái Đất chưa mọc')}`;
  return { en: `${panelEn}. ${antEn}.`, vi: `${panelVi}. ${antVi}.` };
}

/**
 * Pointing block at instant tMs read from the sample starting at sampleMs (sampleMs <= tMs < sampleMs + step).
 * Times until events use the /instant NextEvent semantics (lunarnav.windows.time_until_*), measured from tMs.
 * prose.terrain = false (flat horizon / no DEM, see terrainModelled()) -> the summary says "horizon", not "terrain".
 */
export function buildPointing(r: PointingReading, tMs: number, sampleMs: number, runEndMs: number, prose: PointingProse = TERRAIN): PointingCore {
  const ev = (now: boolean, target: boolean, h: number | null) => {
    const e = nextEventFromColumn(tMs, sampleMs, runEndMs, now, target, h);
    return e.lower_bound ? { hours: null, at: null } : { hours: e.hours, at: e.at };
  };
  const sunset = ev(r.sun.visible, false, r.hours_until.sunset);
  const sunrise = ev(r.sun.visible, true, r.hours_until.sunrise);
  const earthset = ev(r.earth.visible, false, r.hours_until.earthset);
  const earthrise = ev(r.earth.visible, true, r.hours_until.earthrise);
  const panel: PointingPanel = {
    azimuth_deg: r.sun.az_deg,
    compass: compassPoint(r.sun.az_deg),
    tilt_from_vertical_deg: r.sun.el_deg,
    tilt_from_horizontal_deg: round6(90 - r.sun.el_deg),
    panel_normal_elevation_deg: r.sun.el_deg,
    sun_visible: r.sun.visible,
    sun_fraction: clamp01(r.sun.fraction),
    sun_clearance_deg: r.sun.clearance_deg,
    power_tracking: clamp01(r.sun.power_tracking),
    power_horizontal: clamp01(r.sun.power_horizontal),
    irradiance_tracking_wm2: Math.max(0, r.sun.irradiance_tracking_wm2),
    hours_until_sunset: sunset.hours,
    sunset_utc: sunset.at,
    hours_until_sunrise: sunrise.hours,
    sunrise_utc: sunrise.at,
  };
  const antenna: PointingAntenna = {
    azimuth_deg: r.earth.az_deg,
    compass: compassPoint(r.earth.az_deg),
    elevation_deg: r.earth.el_deg,
    earth_visible: r.earth.visible,
    clearance_deg: r.earth.clearance_deg,
    hours_until_earthset: earthset.hours,
    earthset_utc: earthset.at,
    hours_until_earthrise: earthrise.hours,
    earthrise_utc: earthrise.at,
    distance_km: r.earth.dist_km,
  };
  const toEndH = Math.max(0, round6((runEndMs - tMs) / MS_PER_H));
  return {
    t: toIsoUtc(tMs),
    sample_utc: toIsoUtc(sampleMs),
    panel,
    antenna,
    hours_to_run_end: toEndH,
    summary: summaryOf(panel, antenna, toEndH, prose),
  };
}

// ---- OpenAPI example (from the real sample run fixture used by /instant) --------------------------------
const EXAMPLE_RUN_END_MS = parseIsoUtc('2026-04-01T00:00:00Z');
function examplePointingResponse(): PointingResponse {
  const i = exampleInstant();
  return {
    run_id: i.run_id,
    step_s: i.step_s,
    precision_h: i.precision_h,
    site_id: i.site_id,
    ...buildPointing(i, parseIsoUtc(i.t), parseIsoUtc(i.sample_utc), EXAMPLE_RUN_END_MS),
    assumptions: pointingAssumptions(0, 2, i.step_s),
  };
}
export const PointingResponse = PointingResponseShape.meta({ id: 'PointingResponse', examples: [examplePointingResponse()] });
