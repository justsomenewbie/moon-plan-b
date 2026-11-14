/**
 * Route group B against the REAL sample precompute output (output/sample_2026Q1_spice_pgda, 6 sites,
 * 2026-01-01..2026-04-01 hourly, SPICE + PGDA), loaded into a throw-away MongoDB 8.0.
 * Cross-checks the API against the files (series values, windows, CSV export, summary) and the
 * instant readout against Python lunarnav (hours_until_state + time_until_* NextEvent).
 * Skipped when the git-ignored sample directory (or the Python venv, for the parity test) is absent.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import { InstantResponse, SeriesResponse, SkyResponse, type NextEvent } from '../../../src/contract/series.ts';
import { WindowsResponse } from '../../../src/contract/windows.ts';
import { WINDOW_KINDS } from '../../../src/contract/common.ts';
import { getDb } from '../../../src/db.ts';
import { startTestApp, type TestContext } from '../../helpers.ts';
import { PYTHON_BIN, REPO_ROOT, SAMPLE_DIR, hasPython, hasSample, loadSampleRun, type SampleRun } from './data.ts';

const API = '/api/v1';
const RIDGE = 'ref_connecting_ridge_c1';
let ctx: TestContext;
let sample: SampleRun;

async function getJson<T>(url: string, schema: { parse: (x: unknown) => T }): Promise<T> {
  const res = await ctx.app.inject({ method: 'GET', url });
  expect(res.statusCode, res.body).toBe(200);
  return schema.parse(res.json());
}
const site = (id: string) => {
  const s = sample.sites.get(id);
  if (!s) throw new Error(`no sample site ${id}`);
  return s;
};

describe.skipIf(!hasSample())('sample run (real data)', () => {
  beforeAll(async () => {
    ctx = await startTestApp();
    sample = await loadSampleRun(getDb());
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('series at full resolution equals visibility.csv.gz for every site and field', async () => {
    for (const s of sample.sites.values()) {
      const fields = ['sun_el_deg', 'sun_visible', 'irradiance_tracking_wm2', 'earth_clearance_deg', 'both_visible', 'hours_until_sunset', 'hours_until_earthrise', 'earth_az_deg'] as const;
      const b = await getJson(`${API}/sites/${s.id}/series?fields=${fields.join(',')}&max_points=5000`, SeriesResponse);
      expect(b.n).toBe(2160);
      expect(b.bin_s).toBe(3600);
      for (const f of fields) expect(b.fields[f], `${s.id} ${f}`).toEqual(s.columns[f]);
    }
  });

  it('sub-second end snaps UP on /series too (15:00:00.500Z -> 2 samples)', async () => {
    for (const end of ['2026-01-07T15:00:00.500Z', '2026-01-07T15:00:00.000001Z', '2026-01-07T15:00:00.000000001Z']) {
      const b = await getJson(`${API}/sites/${RIDGE}/series?fields=sun_el_deg&start=2026-01-07T14:00:00Z&end=${end}`, SeriesResponse);
      expect(b.n, end).toBe(2);
      expect(b.end, end).toBe('2026-01-07T16:00:00Z');
    }
    // a 9-digit fraction just below the next second must not fail the calendar check
    const near = await getJson(`${API}/sites/${RIDGE}/series?fields=sun_el_deg&start=2026-01-07T14:00:00Z&end=2026-01-07T14:59:59.999999999Z`, SeriesResponse);
    expect(near.n).toBe(1);
  });

  it('events = window boundaries of windows.json; minmax bins = extremes of the file', async () => {
    const s = site(RIDGE);
    const b = await getJson(`${API}/sites/${RIDGE}/series?fields=sun_el_deg,sun_visible,earth_visible&max_points=100&agg=minmax`, SeriesResponse);
    expect(b.bin_s).toBe(22 * 3600);
    expect(b.n).toBe(Math.ceil(2160 / 22));
    const expected = (['sun', 'earth'] as const)
      .flatMap((k) => s.windowsJson[k].slice(1).map((w) => ({ t: w.start, kind: k, state: w.state })))
      .sort((a, c) => Date.parse(a.t) - Date.parse(c.t) || (a.kind === 'sun' ? -1 : 1) - (c.kind === 'sun' ? -1 : 1));
    expect(b.events).toEqual(expected);
    const el = b.fields['sun_el_deg'] as { min: number[]; max: number[] };
    const col = s.columns.sun_el_deg as number[];
    for (let k = 0; k < b.n; k++) {
      const chunk = col.slice(k * 22, k * 22 + 22);
      expect(el.min[k]).toBe(Math.min(...chunk));
      expect(el.max[k]).toBe(Math.max(...chunk));
    }
  });

  it('windows over the full run equal windows.json; clipped sub-range tiles it', async () => {
    for (const s of sample.sites.values()) {
      const b = await getJson(`${API}/sites/${s.id}/windows`, WindowsResponse);
      for (const k of WINDOW_KINDS) {
        expect(b[k]?.map((w) => ({ start: w.start, end: w.end, duration_h: w.duration_h, state: w.state, truncated_start: w.truncated_start, truncated_end: w.truncated_end })), `${s.id} ${k}`).toEqual(
          s.windowsJson[k].map((w) => ({ start: w.start, end: w.end, duration_h: w.duration_h, state: w.state, truncated_start: w.truncated_start, truncated_end: w.truncated_end })),
        );
      }
    }
    const sub = await getJson(`${API}/sites/${RIDGE}/windows?start=2026-02-10T07:20:00Z&end=2026-03-05T00:00:00Z`, WindowsResponse);
    expect(sub.start).toBe('2026-02-10T07:00:00Z');
    for (const k of WINDOW_KINDS) {
      const ws = sub[k] ?? [];
      expect(ws[0]?.start).toBe(sub.start);
      expect(ws.at(-1)?.end).toBe(sub.end);
      expect(ws.reduce((a, w) => a + w.duration_h, 0)).toBeCloseTo((Date.parse(sub.end) - Date.parse(sub.start)) / 3_600_000, 9);
    }
  });

  it('sky: transitions are preserved under heavy decimation', async () => {
    const b = await getJson(`${API}/sites/${RIDGE}/sky?max_points=64`, SkyResponse);
    const s = site(RIDGE);
    expect(b.sun.n_transitions).toBe(s.windowsJson.sun.length - 1);
    expect(b.earth.n_transitions).toBe(s.windowsJson.earth.length - 1);
    for (const w of s.windowsJson.sun.slice(1)) {
      const i = b.sun.t.indexOf(w.start);
      expect(i, w.start).toBeGreaterThan(0);
      expect(b.sun.visible[i]).toBe(w.state);
      expect(b.sun.visible[i - 1]).toBe(!w.state);
      expect(Date.parse(b.sun.t[i] ?? '') - Date.parse(b.sun.t[i - 1] ?? '')).toBe(3_600_000);
    }
    const maxEl = Math.max(...(s.columns.sun_el_deg as number[]));
    expect(Math.max(...b.sun.el_deg)).toBe(maxEl);
    expect(b.horizon.az_deg).toHaveLength(720);
    expect(b.horizon.method).toBe('raymarch');
  });

  it('series.csv export reproduces the visibility file values', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `${API}/sites/apollo11/export/series.csv` });
    expect(r.statusCode).toBe(200);
    const rows = parse(r.body, { columns: true }) as Record<string, string>[];
    const s = site('apollo11');
    expect(rows).toHaveLength(2160);
    expect(rows[0]?.['time_utc']).toBe('2026-01-01T00:00:00Z');
    for (const f of ['sun_el_deg', 'earth_dist_km', 'hours_until_sunrise'] as const) {
      expect(rows.map((x) => (x[f] === '' ? null : Number(x[f]))), f).toEqual(s.columns[f]);
    }
    expect(rows.map((x) => x['sun_visible'] === '1')).toEqual(s.columns.sun_visible);
  });

  it('summary.csv export has the same values as the precompute summary.csv', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `${API}/export/summary.csv` });
    expect(r.statusCode).toBe(200);
    const ours = parse(r.body, { columns: true }) as Record<string, string>[];
    const theirs = parse(sample.summaryText, { columns: true }) as Record<string, string>[];
    expect(ours.map((x) => x['site_id'])).toEqual(theirs.map((x) => x['site_id']));
    for (const [i, row] of theirs.entries()) {
      for (const [k, v] of Object.entries(row)) {
        const o = ours[i]?.[k] ?? '';
        if (v !== '' && !Number.isNaN(Number(v))) expect(Number(o), `${row['site_id']} ${k}`).toBe(Number(v));
        else expect(o, `${row['site_id']} ${k}`).toBe(v);
      }
    }
  });

  it('raw file download serves the sample bytes with the manifest sha256', async () => {
    const rel = 'sites/ref_shackleton_rim/windows.json';
    const r = await ctx.app.inject({ method: 'GET', url: `${API}/runs/${sample.run_id}/files/${encodeURIComponent(rel)}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['etag']).toBe(`"${sample.run.manifest.files[rel]}"`);
    expect((JSON.parse(r.body) as { site_id: string }).site_id).toBe('ref_shackleton_rim');
  });

  interface PyInstant {
    sample_utc: string;
    sun_visible: boolean;
    earth_visible: boolean;
    hours_until_state: Record<'sunset' | 'sunrise' | 'earthset' | 'earthrise', number | null>;
    next: Record<'sunset' | 'sunrise' | 'earthset' | 'earthrise', NextEvent>;
  }

  it.skipIf(!hasPython())('instant matches Python lunarnav.windows (hours_until_state + time_until_*)', async () => {
    const cases: Record<string, string[]> = {
      [RIDGE]: ['2026-01-01T00:00:00Z', '2026-01-01T05:30:00Z', '2026-01-07T13:59:59Z', '2026-03-28T23:59:59Z', '2026-03-29T10:15:00Z', '2026-03-31T23:30:00Z'],
      ref_shackleton_rim: ['2026-01-15T12:00:00Z', '2026-02-20T03:45:10Z', '2026-03-10T00:00:00Z'],
      apollo11: ['2026-01-03T00:00:00Z', '2026-01-20T17:30:00Z', '2026-02-14T09:00:00Z', '2026-03-31T23:59:59Z'],
      change6: ['2026-01-10T06:06:06Z', '2026-03-01T00:00:00Z'],
    };
    const script = path.join(REPO_ROOT, 'backend', 'tests', 'routes', 'b', 'python_instants.py');
    const args = ['-I', script, SAMPLE_DIR, ...Object.entries(cases).map(([id, ts]) => `${id}=${ts.join(',')}`)];
    const py = spawnSync(PYTHON_BIN, args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(py.status, py.stderr).toBe(0);
    const ref = JSON.parse(py.stdout) as Record<string, Record<string, PyInstant>>;
    let checked = 0;
    for (const [id, ts] of Object.entries(cases)) {
      for (const t of ts) {
        const expected = ref[id]?.[t];
        expect(expected, `${id} ${t}`).toBeDefined();
        if (!expected) continue;
        const b = await getJson(`${API}/sites/${id}/instant?t=${t}&run_id=${sample.run_id}`, InstantResponse);
        expect(b.sample_utc, `${id} ${t}`).toBe(expected.sample_utc);
        expect(b.sun.visible).toBe(expected.sun_visible);
        expect(b.earth.visible).toBe(expected.earth_visible);
        expect(b.hours_until, `${id} ${t} hours_until`).toEqual(expected.hours_until_state);
        expect(b.next_events, `${id} ${t} next_events`).toEqual(expected.next);
        checked++;
      }
    }
    expect(checked).toBe(15);
  });
});
