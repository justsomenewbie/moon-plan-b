/**
 * Route group B against a synthetic run with known transitions (always runs; throw-away MongoDB 8.0).
 * Covers: series (full resolution, binning, events, limits, ranges), instant (hours_until + NextEvent),
 * sky (event-preserving decimation + horizon), windows (clipping/tiling), CSV exports (streaming,
 * gzip), raw files (ETag/304), problem+json errors, response schemas.
 */
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import { InstantResponse, SeriesResponse, SkyResponse, type SeriesEvent } from '../../../src/contract/series.ts';
import { WindowsResponse } from '../../../src/contract/windows.ts';
import { Problem } from '../../../src/lib/problem.ts';
import { getDb } from '../../../src/db.ts';
import { startTestApp, type TestContext } from '../../helpers.ts';
import { buildSyntheticRun, SYN, type SyntheticRun } from './data.ts';

const API = '/api/v1';
const S = `${API}/sites/${SYN.site_id}`;
let ctx: TestContext;
let syn: SyntheticRun;

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const at = (i: number) => iso(syn.t0 + i * SYN.step_s * 1000);

async function get(url: string, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method: 'GET', url, headers });
}
async function getJson<T>(url: string, schema: { parse: (x: unknown) => T }): Promise<T> {
  const res = await get(url);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  return schema.parse(res.json());
}
async function problem(url: string, status: number, code: string) {
  const res = await get(url);
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const p = Problem.parse(res.json());
  expect(p.code).toBe(code);
  return p;
}

beforeAll(async () => {
  ctx = await startTestApp();
  syn = await buildSyntheticRun(getDb(), ctx.dataDir);
});
afterAll(async () => {
  await ctx?.close();
});

describe('GET /sites/{id}/series', () => {
  it('full resolution returns the stored values unchanged, no stub header, and exact events', async () => {
    const r = await get(`${S}/series?fields=sun_el_deg,sun_visible,hours_until_sunset`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-lunarnav-stub']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    const b = SeriesResponse.parse(r.json());
    expect(b).toMatchObject({ run_id: SYN.run_id, site_id: SYN.site_id, step_s: 3600, precision_h: 1, bin_s: 3600, n: SYN.n, agg: 'sample' });
    expect(b.start).toBe(SYN.start);
    expect(b.end).toBe(at(SYN.n));
    expect(b.fields['sun_el_deg']).toEqual(syn.samples.map((s) => s.sun_el_deg));
    expect(b.fields['sun_visible']).toEqual(syn.sun);
    expect(b.fields['hours_until_sunset']).toEqual(syn.samples.map((s) => s.hours_until_sunset));
    const sunEvents: SeriesEvent[] = [
      { t: at(100), kind: 'sun', state: false },
      { t: at(101), kind: 'sun', state: true },
      { t: at(300), kind: 'sun', state: false },
      { t: at(450), kind: 'sun', state: true },
    ];
    expect(b.events).toEqual(sunEvents); // only sun-related fields requested -> only sun events
  });

  it('events cover the kinds of the requested fields, sorted by time', async () => {
    const b = await getJson(`${S}/series?fields=earth_el_deg,both_visible&run_id=${SYN.run_id}`, SeriesResponse);
    const kinds = new Set(b.events?.map((e) => e.kind));
    expect(kinds).toEqual(new Set(['earth', 'both']));
    expect(b.events?.filter((e) => e.kind === 'earth')).toEqual([
      { t: at(50), kind: 'earth', state: false },
      { t: at(350), kind: 'earth', state: true },
    ]);
    const ts = (b.events ?? []).map((e) => Date.parse(e.t));
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
  });

  it('downsampled agg=sample takes the first sample per bin; the 1-sample blip survives in events', async () => {
    const b = await getJson(`${S}/series?fields=sun_visible,sun_el_deg&max_points=50`, SeriesResponse);
    expect(b.bin_s).toBe(12 * 3600);
    expect(b.n).toBe(50);
    const vis = b.fields['sun_visible'] as boolean[];
    expect(vis).toEqual(Array.from({ length: 50 }, (_v, k) => syn.sun[k * 12]));
    // bin 8 = samples 96..107 contains the dark blip at 100, but its first sample is lit
    expect(vis[8]).toBe(true);
    expect(b.events?.some((e) => e.t === at(100) && e.state === false)).toBe(true);
    expect(b.fields['sun_el_deg']).toEqual(Array.from({ length: 50 }, (_v, k) => syn.samples[k * 12]?.sun_el_deg));
  });

  it('agg=minmax keeps per-bin extremes and gives boolean fractions', async () => {
    const b = await getJson(`${S}/series?fields=sun_el_deg,sun_visible&max_points=50&agg=minmax`, SeriesResponse);
    const el = b.fields['sun_el_deg'] as { min: number[]; max: number[] };
    const vis = b.fields['sun_visible'] as { min: number[]; max: number[] };
    for (let k = 0; k < 50; k++) {
      const chunk = syn.samples.slice(k * 12, k * 12 + 12).map((s) => s.sun_el_deg as number);
      expect(el.min[k]).toBeCloseTo(Math.min(...chunk), 12);
      expect(el.max[k]).toBeCloseTo(Math.max(...chunk), 12);
      const frac = syn.sun.slice(k * 12, k * 12 + 12).filter(Boolean).length / 12;
      expect(vis.min[k]).toBeCloseTo(frac, 12);
      expect(vis.max[k]).toBeCloseTo(frac, 12);
    }
    expect(vis.min[8]).toBeCloseTo(11 / 12, 12); // the blip shows as a fraction < 1
    expect(Math.max(...el.max)).toBe(5); // the spike at 257 is kept
  });

  it('snaps and clamps the range, echoing what was used', async () => {
    const b = await getJson(`${S}/series?start=2029-12-31T00:00:00Z&end=2030-01-01T05:30:00.5Z&fields=sun_az_deg`, SeriesResponse);
    expect(b.start).toBe(SYN.start);
    expect(b.end).toBe(at(6));
    expect(b.n).toBe(6);
    expect(b.fields['sun_az_deg']).toEqual(syn.samples.slice(0, 6).map((s) => s.sun_az_deg));
    const mid = await getJson(`${S}/series?start=2030-01-02T00:30:00Z&end=2030-01-02T03:00:00Z&fields=sun_az_deg`, SeriesResponse);
    expect(mid.start).toBe(at(24));
    expect(mid.n).toBe(3);
  });

  it('errors: no overlap / reversed -> 422, bad date -> 400, limits -> TOO_MANY_POINTS, unknown site/run -> 404', async () => {
    const p = await problem(`${S}/series?start=2031-01-01T00:00:00Z&end=2031-02-01T00:00:00Z`, 422, 'OUT_OF_RANGE');
    expect(p['run_end_utc']).toBe(at(SYN.n));
    await problem(`${S}/series?start=2030-01-05T00:00:00Z&end=2030-01-04T00:00:00Z`, 422, 'OUT_OF_RANGE');
    const bad = await problem(`${S}/series?start=2030-02-30T00:00:00Z`, 400, 'VALIDATION_ERROR');
    expect(bad.errors?.[0]?.path).toBe('start');
    await problem(`${S}/series?max_points=6000`, 400, 'TOO_MANY_POINTS');
    await problem(`${S}/series?fields=sun_az_deg,sun_el_deg,sun_dist_km,sun_semidiam_deg,horizon_el_sun_deg,sun_clearance_deg,sun_fraction,sun_visible,power_tracking`, 400, 'TOO_MANY_POINTS');
    await problem(`${S}/series?fields=nope`, 400, 'VALIDATION_ERROR');
    await problem(`${API}/sites/other_site/series`, 404, 'SITE_NOT_FOUND');
    await problem(`${S}/series?run_id=pf_unknown`, 404, 'RUN_NOT_FOUND');
  });

  it('explicit run_id gets a long cache lifetime; gzip works', async () => {
    const r = await get(`${S}/series?run_id=${SYN.run_id}&fields=sun_el_deg,earth_el_deg`, { 'accept-encoding': 'gzip' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
    expect(r.headers['content-encoding']).toBe('gzip');
    const b = SeriesResponse.parse(JSON.parse(gunzipSync(r.rawPayload).toString('utf8')));
    expect(b.n).toBe(SYN.n);
  });
});

describe('GET /sites/{id}/instant', () => {
  it('reads the sample containing t; hours_until = columns; next_events from t', async () => {
    // index 90: lit, sunset at 100 -> 10 h from the sample, 9.5 h from t = sample + 30 min
    const b = await getJson(`${S}/instant?t=${encodeURIComponent('2030-01-04T18:30:00Z')}`, InstantResponse);
    expect(b.sample_utc).toBe(at(90));
    expect(b.sample_index).toBe(90);
    expect(b.t).toBe('2030-01-04T18:30:00Z');
    expect(b.sun.visible).toBe(true);
    expect(b.earth.visible).toBe(false);
    expect(b.hours_until).toEqual({ sunset: 10, sunrise: 0, earthset: 0, earthrise: 260 });
    expect(b.next_events).toEqual({
      sunset: { hours: 9.5, at: at(100), state_now: true, lower_bound: false },
      sunrise: { hours: 0, at: '2030-01-04T18:30:00Z', state_now: true, lower_bound: false },
      earthset: { hours: 0, at: '2030-01-04T18:30:00Z', state_now: false, lower_bound: false },
      earthrise: { hours: 259.5, at: at(350), state_now: false, lower_bound: false },
    });
    expect(b.sun.el_deg).toBe(syn.samples[90]?.sun_el_deg);
    expect(b.both_visible).toBe(false);
  });

  it('no event before the run end -> null column and lower_bound = time to run end', async () => {
    const b = await getJson(`${S}/instant?t=2030-01-25T23:15:00Z`, InstantResponse); // index 599, last sample
    expect(b.sample_index).toBe(599);
    expect(b.hours_until.sunset).toBeNull();
    expect(b.next_events?.sunset).toEqual({ hours: 0.75, at: null, state_now: true, lower_bound: true });
    expect(b.next_events?.earthset).toEqual({ hours: 0.75, at: null, state_now: true, lower_bound: true });
  });

  it('t outside the run -> 422; unknown site -> 404', async () => {
    await problem(`${S}/instant?t=2030-01-26T00:00:00Z`, 422, 'OUT_OF_RANGE');
    await problem(`${S}/instant?t=2029-12-31T23:59:59Z`, 422, 'OUT_OF_RANGE');
    await problem(`${S}/instant`, 400, 'VALIDATION_ERROR');
    await problem(`${API}/sites/x/instant?t=2030-01-02T00:00:00Z`, 404, 'SITE_NOT_FOUND');
  });
});

describe('GET /sites/{id}/sky', () => {
  it('returns all samples when they fit, plus the horizon silhouette', async () => {
    const b = await getJson(`${S}/sky`, SkyResponse);
    expect(b.n_samples).toBe(SYN.n);
    expect(b.sun.decimated).toBe(false);
    expect(b.sun.t).toHaveLength(SYN.n);
    expect(b.sun.n_transitions).toBe(4);
    expect(b.earth.n_transitions).toBe(2);
    expect(b.horizon.az_deg).toHaveLength(72);
    expect(b.horizon).toMatchObject({ method: 'flat', az_step_deg: 5, min_el_deg: -1, max_el_deg: 1 });
  });

  it('decimates while keeping both samples of every transition and the elevation extremes', async () => {
    const b = await getJson(`${S}/sky?max_points=60`, SkyResponse);
    const tr = b.sun;
    expect(tr.decimated).toBe(true);
    expect(tr.t.length).toBeLessThanOrEqual(60 + 2 * tr.n_transitions);
    expect(tr.t.length).toBeGreaterThan(30);
    for (const i of [99, 100, 101, 299, 300, 449, 450, 0, SYN.n - 1, SYN.spikeIndex]) expect(tr.t).toContain(at(i));
    for (const i of [49, 50, 349, 350]) expect(b.earth.t).toContain(at(i));
    const ms = tr.t.map((t) => Date.parse(t));
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1] ?? 0);
    const k = tr.t.indexOf(at(100));
    expect(tr.visible[k]).toBe(false);
    expect(tr.visible[k - 1]).toBe(true);
    expect(tr.el_deg[tr.t.indexOf(at(SYN.spikeIndex))]).toBe(5);
    expect(tr.az_deg).toHaveLength(tr.t.length);
  });

  it('range and limits', async () => {
    const b = await getJson(`${S}/sky?start=2030-01-02T00:00:00Z&end=2030-01-03T00:00:00Z`, SkyResponse);
    expect(b.n_samples).toBe(24);
    expect(b.sun.t[0]).toBe(at(24));
    await problem(`${S}/sky?max_points=5001`, 400, 'TOO_MANY_POINTS');
    await problem(`${S}/sky?max_points=3`, 400, 'VALIDATION_ERROR');
  });
});

describe('GET /sites/{id}/windows', () => {
  it('full range = stored windows, tiling the run', async () => {
    const b = await getJson(`${S}/windows`, WindowsResponse);
    expect(b.sun?.map((w) => [w.start, w.end, w.state, w.truncated_start, w.truncated_end])).toEqual([
      [at(0), at(100), true, true, false],
      [at(100), at(101), false, false, false],
      [at(101), at(300), true, false, false],
      [at(300), at(450), false, false, false],
      [at(450), at(600), true, false, true],
    ]);
    expect(b.sun?.every((w) => !w.clipped_start && !w.clipped_end)).toBe(true);
    expect(b.both?.length).toBe(syn.windows.both.length);
  });

  it('clips to the query range and flags clipped_* separately from truncated_*', async () => {
    const b = await getJson(`${S}/windows?start=${at(200)}&end=${at(400)}&kinds=sun,earth`, WindowsResponse);
    expect(b.both).toBeUndefined();
    expect(b.sun).toEqual([
      { start: at(200), end: at(300), duration_h: 100, state: true, truncated_start: false, truncated_end: false, clipped_start: true, clipped_end: false },
      { start: at(300), end: at(400), duration_h: 100, state: false, truncated_start: false, truncated_end: false, clipped_start: false, clipped_end: true },
    ]);
    const total = (b.earth ?? []).reduce((a, w) => a + w.duration_h, 0);
    expect(total).toBe(200);
    for (let i = 1; i < (b.earth ?? []).length; i++) expect(b.earth?.[i]?.start).toBe(b.earth?.[i - 1]?.end);
  });

  it('errors', async () => {
    await problem(`${S}/windows?kinds=moon`, 400, 'VALIDATION_ERROR');
    await problem(`${S}/windows?start=2040-01-01T00:00:00Z`, 422, 'OUT_OF_RANGE');
    await problem(`${API}/sites/x/windows`, 404, 'SITE_NOT_FOUND');
  });
});

describe('CSV exports', () => {
  const stamp = (iso: string) => iso.replace(/[-:]/g, '');
  const csvName = (kind: string, a: string, b: string) => `attachment; filename="${SYN.site_id}_${SYN.run_id}_${kind}_${stamp(a)}_${stamp(b)}.csv"`;

  it('series.csv streams every sample (booleans 1/0, null empty) and gzips', async () => {
    const r = await get(`${S}/export/series.csv?fields=sun_el_deg,sun_visible,hours_until_sunset`, { 'accept-encoding': 'gzip' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.headers['content-disposition']).toBe(csvName('series', at(0), at(SYN.n))); // whole run: [first sample, run end)
    const text = gunzipSync(r.rawPayload).toString('utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('time_utc,sun_el_deg,sun_visible,hours_until_sunset');
    expect(lines).toHaveLength(SYN.n + 1);
    expect(lines[101]).toBe(`${at(100)},${syn.samples[100]?.sun_el_deg},0,0`);
    expect(lines[SYN.n]).toBe(`${at(SYN.n - 1)},${syn.samples[SYN.n - 1]?.sun_el_deg},1,`);
    const rows = parse(text, { columns: true }) as Record<string, string>[];
    expect(rows.map((x) => Number(x['sun_el_deg']))).toEqual(syn.samples.map((s) => s.sun_el_deg));
  });

  it('series.csv default = all columns, range snapped', async () => {
    const r = await get(`${S}/export/series.csv?start=${at(10)}&end=${at(20)}`);
    expect(r.statusCode).toBe(200);
    const rows = parse(r.body, { columns: true }) as Record<string, string>[];
    expect(rows).toHaveLength(10);
    expect(Object.keys(rows[0] ?? {})).toHaveLength(25);
    expect(rows[0]?.['time_utc']).toBe(at(10));
    expect(r.headers['content-disposition']).toBe(csvName('series', at(10), at(20)));
  });

  it('different ranges get different file names (snapped UTC range in the name; FE report 14/11)', async () => {
    const a = await get(`${S}/export/series.csv?fields=sun_el_deg&start=${at(10)}&end=${at(20)}`);
    const b = await get(`${S}/export/series.csv?fields=sun_el_deg&start=${at(30)}&end=${at(40)}`);
    expect(a.headers['content-disposition']).not.toBe(b.headers['content-disposition']);
    const w1 = await get(`${S}/export/windows.csv?start=${at(10)}&end=${at(20)}`);
    const w2 = await get(`${S}/export/windows.csv?start=${at(10)}&end=${at(21)}`);
    expect(w1.headers['content-disposition']).toBe(csvName('windows', at(10), at(20)));
    expect(w2.headers['content-disposition']).toBe(csvName('windows', at(10), at(21)));
  });

  it('series.csv errors are problem+json (checked before streaming)', async () => {
    await problem(`${API}/sites/x/export/series.csv`, 404, 'SITE_NOT_FOUND');
    await problem(`${S}/export/series.csv?start=2040-01-01T00:00:00Z`, 422, 'OUT_OF_RANGE');
  });

  it('windows.csv', async () => {
    const r = await get(`${S}/export/windows.csv?kinds=earth,sun&start=${at(200)}&end=${at(400)}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe(csvName('windows', at(200), at(400)));
    expect(r.body.trimEnd().split('\n')).toEqual([
      'kind,start,end,duration_h,state,truncated_start,truncated_end,clipped_start,clipped_end',
      `earth,${at(200)},${at(350)},150,0,0,0,1,0`,
      `earth,${at(350)},${at(400)},50,1,0,1,0,1`,
      `sun,${at(200)},${at(300)},100,1,0,0,1,0`,
      `sun,${at(300)},${at(400)},100,0,0,0,0,1`,
    ]);
  });

  it('summary.csv: OUTPUT_SPEC 3.7 columns, quoting, booleans and nulls', async () => {
    const r = await get(`${API}/export/summary.csv`);
    expect(r.statusCode).toBe(200);
    const lines = r.body.trimEnd().split('\n');
    expect(lines[0]?.split(',')).toHaveLength(27);
    expect(lines[0]?.startsWith('rank,site_id,name,group,lat_deg')).toBe(true);
    const rows = parse(r.body, { columns: true }) as Record<string, string>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rank: '1', site_id: SYN.site_id, name: 'Synthetic A, "quoted"', longest_dark_truncated: '0', mean_sun_el_lit_deg: '', pct_sun: '74.833333' });
  });
});

describe('GET /runs/{run_id}/files/{file_path}', () => {
  it('serves listed files with ETag and 304, manifest.json too', async () => {
    const url = `${API}/runs/${SYN.run_id}/files/${encodeURIComponent(syn.rawFile.path)}`;
    const r = await get(url);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(syn.rawFile.content);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    const etag = String(r.headers['etag']);
    expect(etag).toBe(`"${syn.run.manifest.files[syn.rawFile.path]}"`);
    const r304 = await get(url, { 'if-none-match': etag });
    expect(r304.statusCode).toBe(304);
    const m = await get(`${API}/runs/${SYN.run_id}/files/manifest.json`);
    expect(m.statusCode).toBe(200);
    expect(m.headers['etag']).toBe(`"${syn.run.manifest_sha256}"`);
  });

  it('unlisted, missing on disk, traversal and unknown run -> problems', async () => {
    await problem(`${API}/runs/${SYN.run_id}/files/${encodeURIComponent('sites/other/windows.json')}`, 404, 'FILE_NOT_FOUND');
    await problem(`${API}/runs/${SYN.run_id}/files/${encodeURIComponent('sites/synth_a/visibility.csv.gz')}`, 404, 'FILE_NOT_FOUND');
    await problem(`${API}/runs/${SYN.run_id}/files/${encodeURIComponent('../x.json')}`, 400, 'VALIDATION_ERROR');
    await problem(`${API}/runs/pf_nope/files/manifest.json`, 404, 'RUN_NOT_FOUND');
  });
});

describe('run status', () => {
  it('a run that is still importing -> 409 RUN_NOT_READY', async () => {
    const runs = getDb().collection<typeof syn.run>('runs');
    await runs.insertOne({ ...syn.run, _id: 'importing_run', is_default: false, status: 'importing' });
    await problem(`${S}/series?run_id=importing_run`, 409, 'RUN_NOT_READY');
    await problem(`${S}/instant?run_id=importing_run&t=${SYN.start}`, 409, 'RUN_NOT_READY');
  });
});

