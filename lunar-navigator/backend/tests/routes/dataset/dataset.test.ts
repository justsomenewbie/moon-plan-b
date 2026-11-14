/**
 * GET /api/v1/dataset on the REAL sample run (tests/fixtures/sample_2026Q1_spice_pgda, 6 sites x 2160
 * hourly samples), imported with the real importer into a throw-away MongoDB 8.0.
 *
 * Cross-checks (exact):
 *   - whole run: metrics = summary.csv (pct_*, longest_*), longest_both_h = longest "both" window of
 *     windows.json, windows = the visible intervals of windows.json (clipped_* = truncated_*);
 *   - series at the data step = visibility.csv.gz values;
 *   - sub-range: metrics = POST /compare metrics (lunarnav compute_metrics semantics) of the same range;
 *   - horizon (1 deg) = horizon_*.csv at integer azimuths.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATASET_LIMITS, DatasetResponse } from '../../../src/contract/dataset.ts';
import { CompareResponse } from '../../../src/contract/analysis.ts';
import { Problem } from '../../../src/lib/problem.ts';
import { getDb } from '../../../src/db.ts';
import { importRun } from '../../../src/importer/importRun.ts';
import { dataCollections } from '../../../src/repos/index.ts';
import type { WindowDoc } from '../../../src/repos/types.ts';
import { decimateSeries } from '../../../src/routes/dataset_build.ts';
import { startTestApp, type TestContext } from '../../helpers.ts';
import { CATALOG_PATH, SAMPLE_DIR, SAMPLE_RUN_ID } from '../../sample.ts';

const API = '/api/v1';
const RIDGE = 'ref_connecting_ridge_c1';

interface FileWindow {
  start: string;
  end: string;
  duration_h: number;
  state: boolean;
  truncated_start: boolean;
  truncated_end: boolean;
}
interface SiteFileRecord {
  id: string;
  horizon_method: string;
  files: { horizon: string; visibility: string; windows: string };
}
const SITES = (JSON.parse(readFileSync(path.join(SAMPLE_DIR, 'sites.json'), 'utf8')) as { sites: SiteFileRecord[] }).sites;
const site = (id: string): SiteFileRecord => {
  const s = SITES.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};
const windowsFile = (id: string) =>
  JSON.parse(readFileSync(path.join(SAMPLE_DIR, site(id).files.windows), 'utf8')) as { sun: FileWindow[]; earth: FileWindow[]; both: FileWindow[] };
const visibilityRows = (id: string) => parse(gunzipSync(readFileSync(path.join(SAMPLE_DIR, site(id).files.visibility))).toString('utf8'), { columns: true }) as Record<string, string>[];
const SUMMARY = (parse(readFileSync(path.join(SAMPLE_DIR, 'summary.csv'), 'utf8'), { columns: true }) as Record<string, string>[]).map((r) => ({
  site_id: r['site_id'] ?? '',
  pct_sun: Number(r['pct_sun']),
  pct_earth: Number(r['pct_earth']),
  pct_both: Number(r['pct_both']),
  longest_dark_h: Number(r['longest_dark_h']),
  longest_comms_gap_h: Number(r['longest_comms_gap_h']),
  longest_sun_h: Number(r['longest_sun_h']),
  longest_earth_h: Number(r['longest_earth_h']),
}));
const bool = (s: string | undefined): boolean => s === '1' || s === 'True' || s === 'true';

let ctx: TestContext;

async function getDataset(query: string, headers: Record<string, string> = {}) {
  const res = await ctx.app.inject({ method: 'GET', url: `${API}/dataset${query}`, headers });
  expect(res.statusCode, res.body.slice(0, 500)).toBe(200);
  const parsed = DatasetResponse.safeParse(res.json());
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  return { body: parsed.data as DatasetResponse, headers: res.headers, raw: res.body };
}

async function problem(query: string, status: number) {
  const res = await ctx.app.inject({ method: 'GET', url: `${API}/dataset${query}` });
  expect(res.statusCode, res.body.slice(0, 500)).toBe(status);
  expect(res.headers['content-type']).toContain('application/problem+json');
  return Problem.parse(res.json());
}

beforeAll(async () => {
  ctx = await startTestApp();
  const res = await importRun(getDb(), { dir: SAMPLE_DIR, check: false, dataDir: null, catalogPath: CATALOG_PATH, setDefault: true });
  expect(res.run_id).toBe(SAMPLE_RUN_ID);
}, 600_000);

afterAll(async () => {
  await ctx?.close();
});

describe('GET /dataset - whole run cross-checks against the Python files', () => {
  let ds: DatasetResponse;
  beforeAll(async () => {
    ds = (await getDataset('')).body;
  });

  it('defaults: default run, every site in sites.json order, whole range, all parts', () => {
    expect(ds.schema_version).toBe('lunarnav-dataset-1');
    expect(ds.evidence).toBe('computed-ephemeris');
    expect(ds.run.run_id).toBe(SAMPLE_RUN_ID);
    expect(ds.dataset_id.startsWith(`${SAMPLE_RUN_ID}.`)).toBe(true);
    expect(ds.sites.map((s) => s.id)).toEqual(SITES.map((s) => s.id));
    expect(ds.range).toMatchObject({ start: '2026-01-01T00:00:00Z', end: '2026-04-01T00:00:00Z', step_s: 3600, n_samples: 2160 });
    expect(ds.criteria_hours).toEqual([24, 72, 168]);
    expect(ds.include).toEqual(['horizon', 'series', 'windows', 'metrics', 'criteria']);
    expect(ds.model.limits.length).toBeGreaterThan(0);
    expect(ds.sources.map((s) => s.id)).toContain('naif-spice-generic-kernels');
    for (const s of ds.sites) {
      expect(s.coverage).toBe('complete');
      expect(s.series?.t).toHaveLength(2160);
      expect(s.series?.decimated).toBe(false);
    }
  });

  it('metrics over the whole run = summary.csv; longest_both_h = longest both window of windows.json', () => {
    for (const row of SUMMARY) {
      const s = ds.sites.find((x) => x.id === row.site_id);
      const m = s?.metrics;
      expect(m, row.site_id).toBeTruthy();
      if (!m) continue;
      const { site_id: _id, ...expected } = row;
      expect(m, row.site_id).toMatchObject(expected);
      expect(m.duration_h).toBe(2160);
      const wf = windowsFile(row.site_id);
      expect(m.longest_both_h).toBe(Math.max(0, ...wf.both.filter((w) => w.state).map((w) => w.duration_h)));
      const sumTrue = (ws: FileWindow[]) => ws.filter((w) => w.state).reduce((a, w) => a + w.duration_h, 0);
      expect(m.sun_hours).toBe(sumTrue(wf.sun));
      expect(m.earth_hours).toBe(sumTrue(wf.earth));
      expect(m.both_hours).toBe(sumTrue(wf.both));
    }
  });

  it('windows = the visible intervals of windows.json (clipped_* = truncated_* over the whole run)', () => {
    for (const s of ds.sites) {
      const wf = windowsFile(s.id);
      for (const kind of ['sun', 'earth', 'both'] as const) {
        const expected = wf[kind]
          .filter((w) => w.state)
          .map((w) => ({ start: w.start, end: w.end, duration_h: w.duration_h, clipped_start: w.truncated_start, clipped_end: w.truncated_end }));
        expect(s.windows?.[kind], `${s.id} ${kind}`).toEqual(expected);
      }
    }
  });

  it('series at the data step = visibility.csv.gz (every sample, exact)', () => {
    for (const id of [RIDGE, 'apollo11']) {
      const rows = visibilityRows(id);
      const s = ds.sites.find((x) => x.id === id)?.series;
      expect(s).toBeTruthy();
      if (!s) continue;
      expect(s.t).toEqual(rows.map((r) => r['time_utc']));
      expect(s.sun_az_deg).toEqual(rows.map((r) => Number(r['sun_az_deg'])));
      expect(s.sun_el_deg).toEqual(rows.map((r) => Number(r['sun_el_deg'])));
      expect(s.earth_az_deg).toEqual(rows.map((r) => Number(r['earth_az_deg'])));
      expect(s.earth_el_deg).toEqual(rows.map((r) => Number(r['earth_el_deg'])));
      expect(s.sun_visible).toEqual(rows.map((r) => bool(r['sun_visible'])));
      expect(s.earth_visible).toEqual(rows.map((r) => bool(r['earth_visible'])));
      expect(s.both_visible).toEqual(rows.map((r) => bool(r['both_visible'])));
      expect(s.step_s).toBe(3600);
    }
  });

  it('horizon at 1 deg: 361 points 0..360, closed, = horizon_*.csv at integer azimuths', () => {
    for (const s of ds.sites) {
      const h = s.horizon;
      expect(h).toBeTruthy();
      if (!h) continue;
      expect(h.az_deg).toHaveLength(361);
      expect(h.az_deg[0]).toBe(0);
      expect(h.az_deg[360]).toBe(360);
      expect(h.el_deg[360]).toBe(h.el_deg[0]);
      const csv = parse(readFileSync(path.join(SAMPLE_DIR, site(s.id).files.horizon), 'utf8'), { columns: true }) as Record<string, string>[];
      const byAz = new Map(csv.map((r) => [Number(r['az_deg']), Number(r['el_deg'])]));
      for (let j = 0; j < 360; j++) expect(h.el_deg[j], `${s.id} az ${j}`).toBe(byAz.get(j));
      expect(h.method).toBe(site(s.id).horizon_method);
    }
  });

  it('criteria: one per threshold on longest_both_h; borderline only when the sampled edges straddle the minimum', () => {
    for (const s of ds.sites) {
      const v = s.metrics?.longest_both_h ?? 0;
      expect(s.criteria?.map((c) => c.minimum_hours)).toEqual([24, 72, 168]);
      const longest = (s.windows?.both ?? []).filter((w) => w.duration_h === v);
      const endExact = longest.some((w) => w.clipped_end);
      const startUncertain = longest.length === 0 || longest.some((w) => w.start > ds.range.start);
      for (const c of s.criteria ?? []) {
        expect(c.value_h).toBe(v);
        expect(c.metric).toBe('longest_both_h');
        expect(c.value_clipped).toBe(longest.some((w) => w.clipped_start || w.clipped_end));
        const d = v - c.minimum_hours;
        const want = (endExact ? d >= 0 : d >= 1) ? 'meets' : (startUncertain ? d <= -1 : d < 0) ? 'below' : 'borderline';
        expect(c.result, `${s.id} ${c.minimum_hours}`).toBe(want);
        expect(c.reason.length).toBeGreaterThan(10);
      }
    }
  });

  it('run provenance: git_commit, manifest_sha256 and a manifest_url that serves the manifest', async () => {
    expect(ds.run.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ds.run.manifest_url).toBe(`${API}/runs/${SAMPLE_RUN_ID}/files/manifest.json`);
    const res = await ctx.app.inject({ method: 'GET', url: ds.run.manifest_url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['etag']).toBe(`"${ds.run.manifest_sha256}"`);
  });
});

describe('GET /dataset - sub-range, decimation, include, limits', () => {
  it('sub-second end snaps UP to the next sample (FE report 14/11: 15:00:00.500Z must give 16:00 and 2 samples)', async () => {
    for (const end of ['2026-01-07T15:00:00.500Z', '2026-01-07T15:00:01Z', '2026-01-07T15:00:00.000001Z', '2026-01-07T15:00:00.000000001Z']) {
      const { body } = await getDataset(`?site_ids=${RIDGE},apollo11&start=2026-01-07T14:00:00Z&end=${end}&include=series`);
      expect(body.range, end).toMatchObject({ start: '2026-01-07T14:00:00Z', end: '2026-01-07T16:00:00Z', n_samples: 2 });
      for (const s of body.sites) expect(s.series?.t, `${s.id} ${end}`).toEqual(['2026-01-07T14:00:00Z', '2026-01-07T15:00:00Z']);
    }
    // a whole-hour end stays exclusive
    const { body } = await getDataset(`?site_ids=${RIDGE}&start=2026-01-07T14:00:00Z&end=2026-01-07T15:00:00Z&include=series`);
    expect(body.range).toMatchObject({ end: '2026-01-07T15:00:00Z', n_samples: 1 });
  });

  it('one week for 2 sites: clipped windows, metrics = POST /compare over the same range', async () => {
    const start = '2026-01-07T00:00:00Z';
    const end = '2026-01-14T00:00:00Z';
    const { body } = await getDataset(`?site_ids=${RIDGE},apollo11&start=${start}&end=${end}&step_s=3600`);
    expect(body.sites.map((s) => s.id)).toEqual([RIDGE, 'apollo11']);
    expect(body.range).toMatchObject({ start, end, n_samples: 168, requested_start: start, requested_end: end });
    const cmp = await ctx.app.inject({ method: 'POST', url: `${API}/compare`, payload: { site_ids: [RIDGE, 'apollo11'], start, end } });
    expect(cmp.statusCode, cmp.body).toBe(200);
    const c = CompareResponse.parse(cmp.json());
    for (const s of body.sites) {
      expect(s.series?.t).toHaveLength(168);
      expect(s.series?.t[0]).toBe(start);
      const ref = c.sites[s.id]?.metrics;
      expect(ref).toBeTruthy();
      expect(s.metrics).toMatchObject({
        duration_h: 168,
        pct_sun: ref?.pct_sun,
        pct_earth: ref?.pct_earth,
        pct_both: ref?.pct_both,
        longest_dark_h: ref?.longest_dark_h,
        longest_comms_gap_h: ref?.longest_comms_gap_h,
        longest_sun_h: ref?.longest_sun_h,
        longest_earth_h: ref?.longest_earth_h,
      });
      for (const kind of ['sun', 'earth', 'both'] as const) {
        for (const w of s.windows?.[kind] ?? []) {
          expect(w.start >= start && w.end <= end).toBe(true);
          if (w.start === start) expect(w.clipped_start).toBe(true);
          if (w.end === end) expect(w.clipped_end).toBe(true);
        }
      }
      // series flags agree with the windows
      const ser = s.series;
      if (!ser) continue;
      const inSun = (t: string) => (s.windows?.sun ?? []).some((w) => w.start <= t && t < w.end);
      ser.t.forEach((t, i) => expect(ser.sun_visible[i], `${s.id} ${t}`).toBe(inSun(t)));
    }
  });

  it('step_s 21600 decimates but keeps both samples around every transition', async () => {
    const full = (await getDataset(`?site_ids=${RIDGE}&include=series`)).body.sites[0]?.series;
    const dec = (await getDataset(`?site_ids=${RIDGE}&include=series&step_s=21600`)).body.sites[0]?.series;
    expect(full && dec).toBeTruthy();
    if (!full || !dec) return;
    expect(dec.decimated).toBe(true);
    expect(dec.step_s).toBe(21600);
    expect(dec.t.length).toBeLessThan(full.t.length);
    const kept = new Set(dec.t);
    let transitions = 0;
    for (let i = 1; i < full.t.length; i++) {
      if (full.sun_visible[i] !== full.sun_visible[i - 1] || full.earth_visible[i] !== full.earth_visible[i - 1]) {
        transitions++;
        expect(kept.has(full.t[i - 1] ?? ''), `before ${full.t[i]}`).toBe(true);
        expect(kept.has(full.t[i] ?? ''), `at ${full.t[i]}`).toBe(true);
      }
    }
    expect(dec.n_transitions).toBe(transitions);
    expect(dec.t[0]).toBe(full.t[0]);
    expect(dec.t.at(-1)).toBe(full.t.at(-1));
    // values of kept samples are the stored ones
    const idx = new Map(full.t.map((t, i) => [t, i]));
    dec.t.forEach((t, j) => expect(dec.sun_el_deg[j]).toBe(full.sun_el_deg[idx.get(t) ?? -1]));
    expect([...dec.t].sort()).toEqual(dec.t);
  });

  it('max_points caps every series (transitions still kept)', async () => {
    const { body } = await getDataset('?include=series&max_points=200');
    for (const s of body.sites) {
      expect(s.series?.t.length ?? 0).toBeLessThanOrEqual(200);
      expect(s.series?.decimated).toBe(true);
      expect((s.series?.step_s ?? 0) % 3600).toBe(0);
    }
  });

  it('the payload plan (decimation of the window-derived flags) equals the series actually returned', async () => {
    for (const q of ['&step_s=21600', '&step_s=86400', '&max_points=300', '&start=2026-02-03T05:00:00Z&end=2026-03-01T00:00:00Z&step_s=10800']) {
      const { body } = await getDataset(`?include=series,windows${q}`);
      const n = body.range.n_samples;
      const t0 = Date.parse(body.range.start);
      const flags = (ws: { start: string; end: string }[]) => {
        const f = new Array<boolean>(n).fill(false);
        for (const w of ws) for (let i = (Date.parse(w.start) - t0) / 3_600_000; i < (Date.parse(w.end) - t0) / 3_600_000; i++) f[i] = true;
        return f;
      };
      for (const s of body.sites) {
        const ser = s.series;
        if (!ser || !s.windows) throw new Error(s.id);
        const k = Math.max(1, Math.floor((Number(new URLSearchParams(q).get('step_s') ?? 3600)) / 3600));
        const maxPoints = Number(new URLSearchParams(q).get('max_points') ?? 10_000);
        const d = decimateSeries(flags(s.windows.sun), flags(s.windows.earth), k, maxPoints);
        expect(ser.t.length, `${s.id} ${q}`).toBe(d.indices.length);
        expect(ser.sun_visible).toEqual(d.indices.map((i) => flags(s.windows?.sun ?? [])[i]));
      }
    }
  });

  it('include=metrics only returns just metrics; horizon_step_deg=0.5 -> 721 points', async () => {
    const m = (await getDataset(`?site_ids=${RIDGE}&include=metrics`)).body.sites[0];
    expect(m && Object.keys(m).sort()).toEqual(['coverage', 'coverage_in_range', 'group', 'id', 'lat_deg', 'lon_deg', 'metrics', 'name', 'surface_height_m']);
    expect(m?.coverage).toBe('complete');
    const h = (await getDataset(`?site_ids=${RIDGE}&include=horizon&horizon_step_deg=0.5`)).body.sites[0]?.horizon;
    expect(h?.az_deg).toHaveLength(721);
    expect(h?.step_deg).toBe(0.5);
  });

  it('a range partly outside the run is clamped and coverage = partial', async () => {
    const { body } = await getDataset(`?site_ids=${RIDGE}&start=2026-03-25T00:00:00Z&end=2026-04-08T00:00:00Z&include=series,metrics`);
    expect(body.range).toMatchObject({ start: '2026-03-25T00:00:00Z', end: '2026-04-01T00:00:00Z', n_samples: 168, requested_end: '2026-04-08T00:00:00Z' });
    expect(body.sites[0]?.coverage).toBe('partial');
    expect(body.sites[0]?.coverage_in_range).toBe('complete'); // inside [range.start, range.end) every sample is there
    expect(body.sites[0]?.series?.t).toHaveLength(168);
    expect(body.sites[0]?.series?.t.at(-1)).toBe('2026-03-31T23:00:00Z'); // end exclusive: last sample = end - step
    const w = (await getDataset(`?site_ids=${RIDGE}&start=2026-03-25T00:00:00Z&end=2026-04-08T00:00:00Z&include=windows`)).body.sites[0];
    expect(w?.coverage).toBe('partial');
  });

  it('criteria_hours are parsed, deduplicated and sorted', async () => {
    const { body } = await getDataset(`?site_ids=${RIDGE}&include=criteria&criteria_hours=72,%206.5,72,1`);
    expect(body.criteria_hours).toEqual([1, 6.5, 72]);
    expect(body.sites[0]?.criteria?.map((c) => c.minimum_hours)).toEqual([1, 6.5, 72]);
    expect(body.sites[0]?.metrics).toBeUndefined();
  });

  it('ETag + Cache-Control like the other read routes; dataset_id depends on the selection', async () => {
    const a = await getDataset(`?site_ids=${RIDGE}&include=metrics`);
    expect(a.headers['etag']).toMatch(/^W\/"/);
    expect(a.headers['cache-control']).toBe('public, max-age=60');
    const again = await ctx.app.inject({ method: 'GET', url: `${API}/dataset?site_ids=${RIDGE}&include=metrics`, headers: { 'if-none-match': String(a.headers['etag']) } });
    expect(again.statusCode).toBe(304);
    const pinned = await getDataset(`?run_id=${SAMPLE_RUN_ID}&site_ids=${RIDGE}&include=metrics`);
    expect(pinned.headers['cache-control']).toBe('public, max-age=3600');
    expect(pinned.body.dataset_id).toBe(a.body.dataset_id);
    const other = await getDataset(`?site_ids=${RIDGE}&include=metrics&criteria_hours=1`);
    expect(other.body.dataset_id).not.toBe(a.body.dataset_id);
  });

  it('gzip is applied globally', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `${API}/dataset?site_ids=${RIDGE}`, headers: { 'accept-encoding': 'gzip' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });
});

describe('GET /dataset - errors', () => {
  it('the FE draft parameters (from/to/resolutionSeconds) -> 400 VALIDATION_ERROR', async () => {
    const p = await problem('?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&resolutionSeconds=3600', 400);
    expect(p.code).toBe('VALIDATION_ERROR');
  });

  it('unknown site -> 404 SITE_NOT_FOUND; unknown run -> 404 RUN_NOT_FOUND', async () => {
    expect((await problem('?site_ids=apollo11,nope', 404)).code).toBe('SITE_NOT_FOUND');
    expect((await problem('?run_id=nope', 404)).code).toBe('RUN_NOT_FOUND');
  });

  it('bad step_s / horizon_step_deg / include / criteria -> 400', async () => {
    for (const q of ['?step_s=60', '?horizon_step_deg=2', '?include=foo', '?criteria_hours=-1', '?criteria_hours=abc', '?start=2026-02-30T00:00:00Z']) {
      expect((await problem(q, 400)).code, q).toBe('VALIDATION_ERROR');
    }
  });

  it('max_points above 10000 -> 400 TOO_MANY_POINTS (the app-wide code for point caps)', async () => {
    expect((await problem('?max_points=20000', 400)).code).toBe('TOO_MANY_POINTS');
  });

  it('range outside the run / end <= start -> 422 OUT_OF_RANGE', async () => {
    expect((await problem('?start=2027-01-01T00:00:00Z', 422)).code).toBe('OUT_OF_RANGE');
    const inverted = await problem('?start=2026-02-01T00:00:00Z&end=2026-01-01T00:00:00Z', 422);
    expect(inverted.code).toBe('OUT_OF_RANGE');
    expect(inverted.title).toBe('Range outside run'); // real range errors keep the default title
  });

  it('payload over the limit -> 422 with the numbers and a fitting max_points', async () => {
    // a long synthetic run (5 years, 23 sites) sharing the sample site_runs: the check happens before any series read
    const { runs, site_runs } = dataCollections();
    const base = await runs.findOne({ _id: SAMPLE_RUN_ID });
    expect(base).toBeTruthy();
    if (!base) return;
    const ids = Array.from({ length: 23 }, (_v, i) => `big_site_${i}`);
    await runs.insertOne({ ...base, _id: 'big_run', is_default: false, end: new Date('2031-01-01T00:00:00Z'), n_samples: 43824, site_ids: ids, n_sites: ids.length });
    const srs = await site_runs.find({ run_id: SAMPLE_RUN_ID }).toArray();
    await site_runs.insertMany(ids.map((id, i) => ({ ...(srs[i % srs.length] as (typeof srs)[number]), _id: `big_run|${id}`, run_id: 'big_run', site_id: id })));
    const p = await problem('?run_id=big_run', 422);
    expect(p.code).toBe('OUT_OF_RANGE');
    // own title: "Range outside run" read as a wrong date choice; the code stays OUT_OF_RANGE
    expect(p.title).toBe('Series point limit exceeded');
    expect(p.hint).toContain('request fewer site_ids');
    expect(p['limit_total_points']).toBe(DATASET_LIMITS.max_total_points);
    expect(p['requested_total_points']).toBe(23 * 10_000);
    expect(p.hint).toContain(`max_points (<= ${Math.floor(DATASET_LIMITS.max_total_points / 23)}`);
    // 31 days of all 23 sites at the data step fits
    const ok = await ctx.app.inject({ method: 'GET', url: `${API}/dataset?run_id=big_run&end=2026-02-01T00:00:00Z&include=metrics` });
    expect(ok.statusCode).toBe(200);
    const okSeries = await problem(`?run_id=big_run&max_points=${Math.floor(DATASET_LIMITS.max_total_points / 23) + 1}`, 422);
    expect(okSeries.code).toBe('OUT_OF_RANGE');

    // review case: 23 sites x whole run at step_s=86400. Regular samples alone fit (23 x 1 827 = 42 021 <= 50 000),
    // but ~1 018 transition samples per site push it over -> 422 BEFORE any series is read (big_run has no series).
    const H = 3_600_000;
    const t0 = base.start.getTime();
    const n = 43_824;
    const winDocs: WindowDoc[] = [];
    for (const id of ids) {
      for (let i = 0, st = true; i < n; i += 86, st = !st) {
        const e = Math.min(n, i + 86);
        winDocs.push({ _id: `big_run|${id}|sun|${i}`, run_id: 'big_run', site_id: id, kind: 'sun', state: st, start: new Date(t0 + i * H), end: new Date(t0 + e * H), duration_h: e - i, start_index: i, end_index: e, truncated_start: i === 0, truncated_end: e === n });
      }
      winDocs.push({ _id: `big_run|${id}|earth|0`, run_id: 'big_run', site_id: id, kind: 'earth', state: true, start: new Date(t0), end: new Date(t0 + n * H), duration_h: n, start_index: 0, end_index: n, truncated_start: true, truncated_end: true });
    }
    const { windows } = dataCollections();
    await windows.insertMany(winDocs);
    const big = await problem('?run_id=big_run&step_s=86400&include=series', 422);
    expect(big.code).toBe('OUT_OF_RANGE');
    expect(big.detail).toContain('transition samples included');
    expect(big['requested_total_points']).toBeGreaterThan(DATASET_LIMITS.max_total_points);
    expect(big['points_per_site']).toBeGreaterThan(2500); // 1 827 regular + transition samples (some coincide)
    expect(big['max_points_fit']).toBe(Math.floor(DATASET_LIMITS.max_total_points / 23));
    // the fitting max_points it suggests is accepted by the payload check (it then fails only because big_run has no series docs)
    const fit = await ctx.app.inject({ method: 'GET', url: `${API}/dataset?run_id=big_run&step_s=86400&include=series&max_points=${String(big['max_points_fit'])}` });
    expect(fit.statusCode).not.toBe(422);
    await windows.deleteMany({ run_id: 'big_run' });
    await site_runs.deleteMany({ run_id: 'big_run' });
    await runs.deleteOne({ _id: 'big_run' });
  });
});
