/**
 * 16-point compass names for an azimuth (deg clockwise from local north, the convention of every
 * *_az_deg field). Pure, no I/O; used by GET /sites/{id}/pointing and the /dataset `now` block.
 *
 * Sector i (0..15) is centred on i * 22.5 deg and spans [i*22.5 - 11.25, i*22.5 + 11.25); a boundary
 * value belongs to the clockwise sector (11.25 -> NNE, 348.75 -> N).
 */

export const COMPASS_POINTS = [
  { code: 'N', en: 'north', vi: 'Bắc' },
  { code: 'NNE', en: 'north-northeast', vi: 'Bắc Đông Bắc' },
  { code: 'NE', en: 'northeast', vi: 'Đông Bắc' },
  { code: 'ENE', en: 'east-northeast', vi: 'Đông Đông Bắc' },
  { code: 'E', en: 'east', vi: 'Đông' },
  { code: 'ESE', en: 'east-southeast', vi: 'Đông Đông Nam' },
  { code: 'SE', en: 'southeast', vi: 'Đông Nam' },
  { code: 'SSE', en: 'south-southeast', vi: 'Nam Đông Nam' },
  { code: 'S', en: 'south', vi: 'Nam' },
  { code: 'SSW', en: 'south-southwest', vi: 'Nam Tây Nam' },
  { code: 'SW', en: 'southwest', vi: 'Tây Nam' },
  { code: 'WSW', en: 'west-southwest', vi: 'Tây Tây Nam' },
  { code: 'W', en: 'west', vi: 'Tây' },
  { code: 'WNW', en: 'west-northwest', vi: 'Tây Tây Bắc' },
  { code: 'NW', en: 'northwest', vi: 'Tây Bắc' },
  { code: 'NNW', en: 'north-northwest', vi: 'Bắc Tây Bắc' },
] as const;

export type CompassCode = (typeof COMPASS_POINTS)[number]['code'];
export const COMPASS_CODES = COMPASS_POINTS.map((p) => p.code) as [CompassCode, ...CompassCode[]];

export interface CompassPoint {
  code: CompassCode;
  en: string;
  vi: string;
}

/** Azimuth normalised to [0, 360). Throws RangeError for a non-finite value. */
export function normalizeAzimuth(azDeg: number): number {
  if (!Number.isFinite(azDeg)) throw new RangeError(`azimuth must be finite: ${azDeg}`);
  const a = azDeg % 360;
  const r = a < 0 ? a + 360 : a;
  return r >= 360 ? 0 : r + 0; // + 0: no -0
}

/** Index 0..15 of the 16-point sector containing azDeg. */
export function compassIndex(azDeg: number): number {
  return Math.floor(normalizeAzimuth(azDeg) / 22.5 + 0.5) % 16;
}

/** 16-point compass name of an azimuth: { code: 'NE', en: 'northeast', vi: 'Đông Bắc' }. */
export function compassPoint(azDeg: number): CompassPoint {
  const p = COMPASS_POINTS[compassIndex(azDeg)] ?? COMPASS_POINTS[0];
  return { code: p.code, en: p.en, vi: p.vi };
}
