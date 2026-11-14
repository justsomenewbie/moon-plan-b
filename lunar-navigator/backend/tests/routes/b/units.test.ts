/** Pure helpers of route group B (no database). */
import { describe, expect, it } from 'vitest';
import { eventKindOfField, nextEventFromColumn, SERIES_FIELDS } from '../../../src/contract/series.ts';
import { decimateTrack, windowEvents } from '../../../src/routes/series.ts';
import { clipWindowDocs } from '../../../src/routes/windows.ts';
import type { WindowDoc } from '../../../src/repos/types.ts';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

describe('decimateTrack', () => {
  it('keeps everything when it fits', () => {
    const d = decimateTrack([1, 2, 3], [true, false, false], 16);
    expect(d).toEqual({ indices: [0, 1, 2], decimated: false, n_transitions: 1 });
  });

  it('bounds the size, keeps extremes, last sample and both sides of every transition', () => {
    const n = 10_000;
    const el = Array.from({ length: n }, (_v, i) => Math.sin(i / 300));
    el[4321] = 9; // spike
    el[777] = -9; // dip
    const vis = Array.from({ length: n }, (_v, i) => !(i >= 5000 && i < 5003) && i !== 9000);
    const d = decimateTrack(el, vis, 100);
    expect(d.decimated).toBe(true);
    expect(d.n_transitions).toBe(4);
    expect(d.indices.length).toBeLessThanOrEqual(100 + 2 * d.n_transitions);
    for (const i of [0, n - 1, 4321, 777, 4999, 5000, 5002, 5003, 8999, 9000, 9001]) expect(d.indices).toContain(i);
    for (let k = 1; k < d.indices.length; k++) expect(d.indices[k]).toBeGreaterThan(d.indices[k - 1] ?? -1);
  });

  it('never exceeds max_points (+ transitions) across sizes', () => {
    for (const n of [17, 100, 1001, 43_824]) {
      for (const mp of [16, 50, 2000, 5000]) {
        const el = Array.from({ length: n }, (_v, i) => Math.cos(i));
        const d = decimateTrack(el, new Array<boolean>(n).fill(true), mp);
        expect(d.indices.length).toBeLessThanOrEqual(mp);
      }
    }
  });
});

describe('nextEventFromColumn (Python NextEvent semantics)', () => {
  const end = T0 + 100 * H;
  it('already in the target state -> 0 h at t', () => {
    expect(nextEventFromColumn(T0 + 1800_000, T0, end, true, true, 0)).toEqual({ hours: 0, at: iso(T0 + 1800_000), state_now: true, lower_bound: false });
  });
  it('event measured from t, not from the sample', () => {
    expect(nextEventFromColumn(T0 + 5 * H + 15 * 60_000, T0 + 5 * H, end, true, false, 3)).toEqual({ hours: 2.75, at: iso(T0 + 8 * H), state_now: true, lower_bound: false });
  });
  it('no event -> lower bound to the run end', () => {
    expect(nextEventFromColumn(T0 + 99 * H + 1000, T0 + 99 * H, end, false, true, null)).toEqual({ hours: 0.999722, at: null, state_now: false, lower_bound: true });
  });
});

describe('windows helpers', () => {
  const w = (kind: WindowDoc['kind'], s: number, e: number, state: boolean, ts = false, te = false): WindowDoc => ({
    _id: `${kind}${s}`, run_id: 'r', site_id: 's', kind, state, start: new Date(T0 + s * H), end: new Date(T0 + e * H), duration_h: e - s,
    start_index: s, end_index: e, truncated_start: ts, truncated_end: te,
  });

  it('clipWindowDocs intersects and flags clipped vs truncated', () => {
    const docs = [w('sun', 0, 10, true, true), w('sun', 10, 12, false), w('sun', 12, 30, true, false, true)];
    expect(clipWindowDocs(docs, T0 + 5 * H, T0 + 11 * H)).toEqual([
      { start: iso(T0 + 5 * H), end: iso(T0 + 10 * H), duration_h: 5, state: true, truncated_start: true, truncated_end: false, clipped_start: true, clipped_end: false },
      { start: iso(T0 + 10 * H), end: iso(T0 + 11 * H), duration_h: 1, state: false, truncated_start: false, truncated_end: false, clipped_start: false, clipped_end: true },
    ]);
    expect(clipWindowDocs(docs, T0 + 30 * H, T0 + 31 * H)).toEqual([]);
  });

  it('windowEvents lists starts strictly inside the range, sorted by t then kind', () => {
    const ev = windowEvents({ earth: [w('earth', 0, 10, true), w('earth', 10, 20, false)], sun: [w('sun', 0, 10, true), w('sun', 10, 20, false), w('sun', 20, 30, true)] }, T0, T0 + 20 * H);
    expect(ev).toEqual([
      { t: iso(T0 + 10 * H), kind: 'sun', state: false },
      { t: iso(T0 + 10 * H), kind: 'earth', state: false },
    ]);
  });

  it('eventKindOfField maps every series field', () => {
    const kinds = Object.fromEntries(SERIES_FIELDS.map((f) => [f, eventKindOfField(f)]));
    expect(kinds['power_tracking']).toBe('sun');
    expect(kinds['horizon_el_earth_deg']).toBe('earth');
    expect(kinds['hours_until_earthrise']).toBe('earth');
    expect(kinds['hours_until_sunset']).toBe('sun');
    expect(kinds['both_visible']).toBe('both');
    expect(Object.values(kinds).filter((k) => k === 'earth')).toHaveLength(10);
  });
});
