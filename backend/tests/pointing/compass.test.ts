/**
 * Pure unit tests of src/lib/compass.ts (16-point compass) and of buildPointing() in
 * src/contract/pointing.ts (synthetic readings with a known answer). No MongoDB.
 */
import { describe, expect, it } from 'vitest';
import { COMPASS_POINTS, compassIndex, compassPoint, normalizeAzimuth } from '../../src/lib/compass.ts';
import { PointingCore, buildPointing, fmtHours, fmtNum, pointingAssumptions, terrainModelled, type PointingReading } from '../../src/contract/pointing.ts';
import { parseIsoUtc } from '../../src/lib/time.ts';

describe('compass', () => {
  it('normalizes azimuths to [0, 360) without -0', () => {
    expect(normalizeAzimuth(0)).toBe(0);
    expect(normalizeAzimuth(360)).toBe(0);
    expect(normalizeAzimuth(-90)).toBe(270);
    expect(normalizeAzimuth(725)).toBe(5);
    expect(Object.is(normalizeAzimuth(-0), -0)).toBe(false);
    expect(Object.is(normalizeAzimuth(-360), -0)).toBe(false);
    expect(() => normalizeAzimuth(Number.NaN)).toThrow(RangeError);
    expect(() => normalizeAzimuth(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('sector centres map to their own name; 16 distinct codes in clockwise order', () => {
    expect(COMPASS_POINTS).toHaveLength(16);
    expect(new Set(COMPASS_POINTS.map((p) => p.code)).size).toBe(16);
    COMPASS_POINTS.forEach((p, i) => {
      expect(compassIndex(i * 22.5)).toBe(i);
      expect(compassPoint(i * 22.5).code).toBe(p.code);
      expect(compassPoint(i * 22.5 + 11.2).code).toBe(p.code);
      expect(compassPoint(i * 22.5 - 11.2).code).toBe(p.code);
    });
  });

  it('cardinal and intercardinal names in English and Vietnamese', () => {
    expect(compassPoint(0)).toEqual({ code: 'N', en: 'north', vi: 'Bắc' });
    expect(compassPoint(45)).toEqual({ code: 'NE', en: 'northeast', vi: 'Đông Bắc' });
    expect(compassPoint(90)).toEqual({ code: 'E', en: 'east', vi: 'Đông' });
    expect(compassPoint(135)).toEqual({ code: 'SE', en: 'southeast', vi: 'Đông Nam' });
    expect(compassPoint(180)).toEqual({ code: 'S', en: 'south', vi: 'Nam' });
    expect(compassPoint(225)).toEqual({ code: 'SW', en: 'southwest', vi: 'Tây Nam' });
    expect(compassPoint(270)).toEqual({ code: 'W', en: 'west', vi: 'Tây' });
    expect(compassPoint(315)).toEqual({ code: 'NW', en: 'northwest', vi: 'Tây Bắc' });
    expect(compassPoint(22.5).code).toBe('NNE');
    expect(compassPoint(337.5).code).toBe('NNW');
  });

  it('a boundary belongs to the clockwise sector; wrap-around near north', () => {
    expect(compassPoint(11.25).code).toBe('NNE');
    expect(compassPoint(11.2499).code).toBe('N');
    expect(compassPoint(348.75).code).toBe('N');
    expect(compassPoint(348.7499).code).toBe('NNW');
    expect(compassPoint(359.99).code).toBe('N');
    expect(compassPoint(-10).code).toBe('N');
    expect(compassPoint(-12).code).toBe('NNW');
    expect(compassPoint(405).code).toBe('NE');
  });
});

describe('prose formatting', () => {
  it('fmtNum / fmtHours', () => {
    expect(fmtNum(1.2345, 1)).toBe('1.2');
    expect(fmtNum(-0.04, 1)).toBe('0');
    expect(fmtNum(3, 2)).toBe('3');
    expect(fmtHours(5.5, 'en')).toBe('5.5 h');
    expect(fmtHours(5.5, 'vi')).toBe('5.5 giờ');
    expect(fmtHours(130, 'en')).toBe('130 h (5.4 d)');
    expect(fmtHours(130, 'vi')).toBe('130 giờ (5.4 ngày)');
    // 1 decimal also above 48 h (as hours_until_*), not "147 h" for 146.5
    expect(fmtHours(146.5, 'en')).toBe('146.5 h (6.1 d)');
    expect(fmtHours(146.5, 'vi')).toBe('146.5 giờ (6.1 ngày)');
  });
});

// ---- buildPointing --------------------------------------------------------------------------------
const T0 = parseIsoUtc('2026-01-01T00:00:00Z');
const H = 3_600_000;
const RUN_END = T0 + 100 * H;

function reading(over: { sun?: Partial<PointingReading['sun']>; earth?: Partial<PointingReading['earth']>; hours_until?: Partial<PointingReading['hours_until']> } = {}): PointingReading {
  return {
    sun: { az_deg: 47, el_deg: 1.5, clearance_deg: 0.8, fraction: 1, visible: true, power_horizontal: 0.026177, power_tracking: 1, irradiance_tracking_wm2: 1400, ...over.sun },
    earth: { az_deg: 0.4, el_deg: 4, clearance_deg: 3, visible: true, dist_km: 384_400, ...over.earth },
    hours_until: { sunset: 10, sunrise: 0, earthset: 30, earthrise: 0, ...over.hours_until },
  };
}

describe('buildPointing (synthetic readings)', () => {
  it('lit + Earth up: panel faces the Sun, antenna points at the Earth; times measured from t', () => {
    const tMs = T0 + 5 * H + 30 * 60_000; // 05:30 inside the sample 05:00
    const p = buildPointing(reading(), tMs, T0 + 5 * H, RUN_END);
    expect(PointingCore.safeParse(p).success).toBe(true);
    expect(p.t).toBe('2026-01-01T05:30:00Z');
    expect(p.sample_utc).toBe('2026-01-01T05:00:00Z');
    expect(p.panel).toMatchObject({
      azimuth_deg: 47,
      compass: { code: 'NE', en: 'northeast', vi: 'Đông Bắc' },
      tilt_from_vertical_deg: 1.5,
      tilt_from_horizontal_deg: 88.5,
      panel_normal_elevation_deg: 1.5,
      sun_visible: true,
      sun_clearance_deg: 0.8,
      hours_until_sunset: 9.5, // sample + 10 h = 15:00, from 05:30
      sunset_utc: '2026-01-01T15:00:00Z',
      hours_until_sunrise: 0,
      sunrise_utc: '2026-01-01T05:30:00Z',
    });
    expect(p.antenna).toMatchObject({
      azimuth_deg: 0.4,
      compass: { code: 'N', en: 'north', vi: 'Bắc' },
      elevation_deg: 4,
      earth_visible: true,
      clearance_deg: 3,
      hours_until_earthset: 29.5,
      earthset_utc: '2026-01-02T11:00:00Z',
      hours_until_earthrise: 0,
      distance_km: 384_400,
    });
    expect(p.hours_to_run_end).toBe(94.5);
    expect(p.summary.en).toContain('face NE (northeast, azimuth 47°)');
    expect(p.summary.en).toContain('sunset in 9.5 h');
    expect(p.summary.en).toContain('earthset in 29.5 h');
    expect(p.summary.vi).toContain('Đông Bắc');
    expect(p.summary.vi).toContain('còn 9.5 giờ đến lúc lặn');
    expect(p.summary.vi).toContain('Trái Đất lặn sau 29.5 giờ');
  });

  it('dark + Earth hidden: sunrise / earthrise branch, sunset / earthset = 0 (already)', () => {
    const r = reading({
      sun: { az_deg: 200, el_deg: -0.5, clearance_deg: -2.1, fraction: 0, visible: false, power_horizontal: 0, power_tracking: 0, irradiance_tracking_wm2: 0 },
      earth: { az_deg: 271, el_deg: -1, clearance_deg: -1.2, visible: false },
      hours_until: { sunset: 0, sunrise: 52, earthset: 0, earthrise: 7 },
    });
    const p = buildPointing(r, T0, T0, RUN_END);
    expect(p.panel).toMatchObject({ compass: { code: 'SSW' }, sun_visible: false, hours_until_sunset: 0, sunset_utc: '2026-01-01T00:00:00Z', hours_until_sunrise: 52, sunrise_utc: '2026-01-03T04:00:00Z' });
    expect(p.antenna).toMatchObject({ compass: { code: 'W' }, earth_visible: false, hours_until_earthset: 0, hours_until_earthrise: 7, earthrise_utc: '2026-01-01T07:00:00Z' });
    expect(p.summary.en).toContain('the Sun is hidden by the terrain');
    expect(p.summary.en).toContain('sunrise in 52 h (2.2 d)');
    expect(p.summary.en).toContain('earthrise in 7 h');
    expect(p.summary.vi).toContain('Mặt Trời đang bị địa hình che');
    expect(p.summary.vi).toContain('Trái Đất mọc sau 7 giờ');
  });

  it('no event before the run end -> null hours / instant and "not before the end of the data" prose', () => {
    const p = buildPointing(reading({ hours_until: { sunset: null, earthset: null } }), T0 + 90 * H, T0 + 90 * H, RUN_END);
    expect(p.panel.hours_until_sunset).toBeNull();
    expect(p.panel.sunset_utc).toBeNull();
    expect(p.antenna.hours_until_earthset).toBeNull();
    expect(p.hours_to_run_end).toBe(10);
    expect(p.summary.en).toContain('no sunset before the end of the data (> 10 h)');
    expect(p.summary.en).toContain('no earthset before the end of the data (> 10 h)');
    expect(p.summary.vi).toContain('Mặt Trời chưa lặn trước khi hết dữ liệu (> 10 giờ)');
  });

  it('clamps the 0..1 fields and keeps irradiance >= 0', () => {
    const p = buildPointing(reading({ sun: { fraction: 1.0000001, power_tracking: 1.0000001, power_horizontal: -1e-9, irradiance_tracking_wm2: -0 } }), T0, T0, RUN_END);
    expect(p.panel.sun_fraction).toBe(1);
    expect(p.panel.power_tracking).toBe(1);
    expect(p.panel.power_horizontal).toBe(0);
    expect(p.panel.irradiance_tracking_wm2).toBe(0);
  });

  it('a grazing Sun keeps 2 decimals in the prose (not "0° above the terrain")', () => {
    const p = buildPointing(reading({ sun: { clearance_deg: 0.04, el_deg: 0.12 } }), T0, T0, RUN_END);
    expect(p.summary.en).toContain('tilted back 0.12° from vertical; the Sun is 0.04° above the terrain');
    expect(p.summary.vi).toContain('Mặt Trời cao hơn địa hình 0.04°');
  });

  it('a partly visible disc (centre below the ridge): "grazing", visible %, panel output %, never a negative "above"', () => {
    // real probe value: change6 2026-01-08T20:00Z, sun_fraction 0.044, clearance -0.22
    const p = buildPointing(reading({ sun: { clearance_deg: -0.22, el_deg: 0.31, fraction: 0.044, power_tracking: 0.044 } }), T0, T0, RUN_END);
    expect(p.summary.en).toContain('the Sun is grazing the terrain: only 4.4 % of the disc is visible (centre 0.22° below the ridge), panel output ~4.4 % of full sun');
    expect(p.summary.vi).toContain('Mặt Trời sát địa hình: chỉ 4.4 % đĩa Mặt Trời lộ ra (tâm thấp hơn đỉnh địa hình 0.22°), tấm pin chỉ phát ~4.4 % công suất nắng đầy đủ');
    expect(p.summary.en).not.toMatch(/-[\d.]+° above/);
    expect(p.summary.vi).not.toMatch(/cao hơn địa hình -/);
    // centre above the ridge but part of the disc hidden (fraction < 0.995): still "grazing", centre above
    const q = buildPointing(reading({ sun: { clearance_deg: 0.1, fraction: 0.68, power_tracking: 0.68 } }), T0, T0, RUN_END);
    expect(q.summary.en).toContain('only 68 % of the disc is visible (centre 0.1° above the ridge), panel output ~68 %');
    // whole disc: the output is stated as 100 %
    const f = buildPointing(reading(), T0, T0, RUN_END);
    expect(f.summary.en).toContain('the Sun is 0.8° above the terrain (whole disc visible, panel output 100 % of full sun)');
    expect(f.summary.vi).toContain('Mặt Trời cao hơn địa hình 0.8° (lộ cả đĩa');
    // 99.7 % rounds to 99 %, never "only 100 %"
    const g = buildPointing(reading({ sun: { clearance_deg: -0.001, fraction: 0.9996, power_tracking: 0.9996 } }), T0, T0, RUN_END);
    expect(g.summary.en).toContain('only 99 % of the disc');
  });

  it('Sun centre below the horizontal plane: the panel leans forward (no negative "tilted back")', () => {
    const p = buildPointing(reading({ sun: { el_deg: -1.3, clearance_deg: 0.5 } }), T0, T0, RUN_END);
    expect(p.panel.tilt_from_vertical_deg).toBe(-1.3);
    expect(p.summary.en).toContain('leaning forward 1.3° from vertical (the Sun is 1.3° below the horizontal)');
    expect(p.summary.vi).toContain('nghiêng về phía trước 1.3° so với phương thẳng đứng (Mặt Trời thấp hơn mặt phẳng ngang 1.3°)');
    expect(p.summary.en).not.toContain('tilted back -');
    expect(p.summary.vi).not.toContain('ngả ra sau -');
  });

  it('flat horizon (no terrain model): "horizon", never "terrain", in summary and assumptions', () => {
    const lit = buildPointing(reading({ earth: { visible: false } }), T0, T0, RUN_END, { terrain: false });
    expect(lit.summary.en).toContain('the Sun is 0.8° above the horizon');
    expect(lit.summary.en).toContain('the Earth is below the flat horizon');
    expect(lit.summary.vi).toContain('Mặt Trời cao hơn đường chân trời 0.8°');
    const dark = buildPointing(reading({ sun: { visible: false, fraction: 0, clearance_deg: -1 } }), T0, T0, RUN_END, { terrain: false });
    expect(dark.summary.en).toContain('the Sun is below the flat horizon');
    expect(dark.summary.vi).toContain('Mặt Trời ở dưới đường chân trời phẳng');
    for (const s of [lit.summary.en, dark.summary.en]) expect(s).not.toMatch(/terrain/i);
    for (const s of [lit.summary.vi, dark.summary.vi]) expect(s).not.toContain('địa hình');
    const a = pointingAssumptions(0, 2, 3600, false).join(' ');
    expect(a).toContain('IDEAL FLAT horizon');
    expect(a).not.toContain('digital elevation model');
    expect(a).not.toContain('terrain horizon');
    expect(terrainModelled('flat', 'none')).toBe(false);
    expect(terrainModelled('raymarch', 'none:outside-pgda-coverage')).toBe(false);
    expect(terrainModelled('bruteforce', 'pgda:bands[1]')).toBe(true);
  });

  it('assumptions name the conventions and the run parameters', () => {
    const a = pointingAssumptions(2, 2, 3600);
    expect(a.length).toBeGreaterThanOrEqual(5);
    expect(a.join(' ')).toContain('clockwise from local north');
    expect(a.join(' ')).toContain('2 m mast');
    expect(a.join(' ')).toContain('more than 2 deg above the terrain horizon');
    expect(a.join(' ')).toContain('+- 1 h');
  });
});
