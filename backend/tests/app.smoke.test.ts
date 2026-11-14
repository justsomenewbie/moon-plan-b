/**
 * Smoke test of the whole contract on REAL data: boots buildApp() against a throw-away MongoDB 8.0,
 * imports the real sample run (tests/fixtures/sample_2026Q1_spice_pgda) with the real importer, and
 * checks that EVERY operation of the OpenAPI document answers with a schema-valid response, that errors
 * are application/problem+json, and that the committed contract/openapi.json matches the code.
 *
 * Jobs and alt-dates use the FAKE lunarnav (tests/jobs/fake_lunarnav via LUNARNAV_ROOT) so this file
 * never starts a real precompute; the real bridge is covered by tests/jobs and tests/crosscheck.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HealthResponse } from '../src/contract/health.ts';
import { MetaResponse } from '../src/contract/meta.ts';
import { RunDetail, RunsResponse } from '../src/contract/runs.ts';
import { HorizonResponse, SiteDetail, SitesGeoJson, SitesResponse } from '../src/contract/sites.ts';
import { InstantResponse, SeriesResponse, SkyResponse, SERIES_FIELDS } from '../src/contract/series.ts';
import { WindowsResponse } from '../src/contract/windows.ts';
import { CompareResponse, RankingResponse } from '../src/contract/analysis.ts';
import { AltDatesResponse } from '../src/contract/alt_dates.ts';
import { DatasetResponse } from '../src/contract/dataset.ts';
import { SurvivalResponse } from '../src/contract/mission.ts';
import { PointingResponse } from '../src/contract/pointing.ts';
import { Job, JobAccepted } from '../src/contract/jobs.ts';
import { Problem } from '../src/lib/problem.ts';
import { exampleAltDatesRequest, exampleCompareRequest, exampleJobRequest } from '../src/fixtures/index.ts';
import { getDb } from '../src/db.ts';
import { importRun } from '../src/importer/importRun.ts';
import { startTestApp, type TestContext } from './helpers.ts';
import { CATALOG_PATH, SAMPLE_DIR, SAMPLE_RUN_ID } from './sample.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_LUNARNAV = path.join(here, 'jobs', 'fake_lunarnav');
const SITE = 'ref_connecting_ridge_c1';
const API = '/api/v1';
const RUN_FILE = 'sites/apollo11/windows.json';

interface Case {
  op: string;
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  body?: unknown;
  status: number;
  contentType: string;
  schema?: z.ZodType;
  check?: (body: unknown, headers: Record<string, unknown>) => void | Promise<void>;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const CASES: Case[] = [
  { op: 'getHealth', method: 'GET', url: `${API}/health`, status: 200, contentType: 'application/json', schema: HealthResponse,
    check: (b) => {
      const h = b as HealthResponse;
      expect(h.mongo.ok).toBe(true);
      expect(h.default_run_id).toBe(SAMPLE_RUN_ID);
      expect(h.python.ok).toBe(true);
      expect(h.python.lunarnav_code_version).toBe('0.0.0-fake');
      expect(h.status).toBe('ok');
    } },
  { op: 'getMeta', method: 'GET', url: `${API}/meta`, status: 200, contentType: 'application/json', schema: MetaResponse,
    check: (b) => expect((b as MetaResponse).series_fields.map((f) => f.name)).toEqual(SERIES_FIELDS) },
  { op: 'listRuns', method: 'GET', url: `${API}/runs`, status: 200, contentType: 'application/json', schema: RunsResponse,
    check: (b) => {
      const r = b as RunsResponse;
      expect(r.default_run_id).toBe(SAMPLE_RUN_ID);
      expect(r.total).toBe(1);
      expect(r.runs[0]?.is_default).toBe(true);
    } },
  { op: 'getRun', method: 'GET', url: `${API}/runs/${SAMPLE_RUN_ID}`, status: 200, contentType: 'application/json', schema: RunDetail,
    check: (b) => {
      const r = b as RunDetail;
      expect(r.n_samples).toBe(2160);
      expect(r.status).toBe('ready');
    } },
  { op: 'listSites', method: 'GET', url: `${API}/sites`, status: 200, contentType: 'application/json', schema: SitesResponse,
    check: (b) => {
      const s = (b as SitesResponse).sites;
      expect(s).toHaveLength(6);
      expect(s.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(s[0]?.id).toBe(SITE);
    } },
  { op: 'listSites', method: 'GET', url: `${API}/sites?group=south_pole&format=geojson`, status: 200, contentType: 'application/geo+json', schema: SitesGeoJson,
    check: (b) => {
      const g = b as SitesGeoJson;
      expect(g.features.filter((f) => f.properties.kind === 'site')).toHaveLength(2);
      expect(g.features.some((f) => f.geometry.type === 'Polygon')).toBe(true);
    } },
  { op: 'getSite', method: 'GET', url: `${API}/sites/${SITE}`, status: 200, contentType: 'application/json', schema: SiteDetail,
    check: (b) => {
      const d = b as SiteDetail;
      expect(d.rank).toBe(1);
      expect(d.score).toBe(71.162037);
      expect(d.metrics.pct_sun).toBe(98.564815);
    } },
  { op: 'getSiteHorizon', method: 'GET', url: `${API}/sites/${SITE}/horizon`, status: 200, contentType: 'application/json', schema: HorizonResponse,
    check: (b) => {
      const h = b as HorizonResponse;
      expect(h.az_deg).toHaveLength(720);
      expect(h.el_deg).toHaveLength(720);
      expect(Math.min(...h.el_deg)).toBeCloseTo(h.min_el_deg, 6);
    } },
  { op: 'getSiteSeries', method: 'GET', url: `${API}/sites/${SITE}/series?start=2026-01-01T00:30:00Z&end=2026-01-02T00:00:00Z&fields=sun_el_deg,sun_visible`, status: 200, contentType: 'application/json', schema: SeriesResponse,
    check: (b) => {
      const s = b as SeriesResponse;
      expect(s.start).toBe('2026-01-01T00:00:00Z'); // snapped down
      expect(s.n).toBe(24);
      expect(s.fields['sun_el_deg']).toHaveLength(24);
      expect((s.fields['sun_el_deg'] as number[])[0]).toBe(0.805135);
    } },
  { op: 'getSiteSeries', method: 'GET', url: `${API}/sites/${SITE}/series?fields=earth_el_deg&max_points=100&agg=minmax`, status: 200, contentType: 'application/json', schema: SeriesResponse,
    check: (b) => {
      const s = b as SeriesResponse;
      expect(s.n).toBeLessThanOrEqual(100);
      expect(s.bin_s % s.step_s).toBe(0);
      expect(s.fields['earth_el_deg']).toHaveProperty('min');
    } },
  { op: 'getSiteInstant', method: 'GET', url: `${API}/sites/${SITE}/instant?t=2026-01-01T05:30:00Z`, status: 200, contentType: 'application/json', schema: InstantResponse,
    check: (b) => {
      const i = b as InstantResponse;
      expect(i.sample_utc).toBe('2026-01-01T05:00:00Z');
      expect(i.sun.visible).toBe(true);
      expect(i.hours_until.sunset).toBe(2083);
    } },
  { op: 'getSitePointing', method: 'GET', url: `${API}/sites/${SITE}/pointing?t=2026-01-01T05:30:00Z`, status: 200, contentType: 'application/json', schema: PointingResponse,
    check: (b) => {
      const p = b as PointingResponse;
      expect(p.sample_utc).toBe('2026-01-01T05:00:00Z');
      expect(p.panel.sun_visible).toBe(true);
      expect(p.panel.hours_until_sunset).toBe(2082.5);
      expect(p.summary.en.length).toBeGreaterThan(0);
      expect(p.assumptions.length).toBeGreaterThan(0);
    } },
  { op: 'getSiteSky', method: 'GET', url: `${API}/sites/${SITE}/sky?max_points=64`, status: 200, contentType: 'application/json', schema: SkyResponse,
    check: (b) => {
      const s = b as SkyResponse;
      expect(s.n_samples).toBe(2160);
      expect(s.horizon.az_deg).toHaveLength(720);
      expect(s.sun.t.length).toBeLessThanOrEqual(64 + 2 * s.sun.n_transitions);
      expect(s.sun.decimated).toBe(true);
    } },
  { op: 'getSiteWindows', method: 'GET', url: `${API}/sites/${SITE}/windows?start=2026-03-01T00:00:00Z&kinds=sun`, status: 200, contentType: 'application/json', schema: WindowsResponse,
    check: (b) => {
      const w = b as WindowsResponse;
      expect(w.earth).toBeUndefined();
      expect(w.sun?.[0]?.clipped_start).toBe(true);
      expect(w.sun?.[0]?.start).toBe('2026-03-01T00:00:00Z');
    } },
  { op: 'compareSites', method: 'POST', url: `${API}/compare`, body: { ...exampleCompareRequest(), include: { windows: ['sun'], series: { fields: ['sun_el_deg'], max_points: 50 } } }, status: 200, contentType: 'application/json', schema: CompareResponse,
    check: (b) => {
      const c = b as CompareResponse;
      expect(c.ranking.map((r) => r.site_id)).toEqual(['ref_connecting_ridge_c1', 'apollo11', 'a3_haworth']);
      expect(c.sites['apollo11']?.warnings.length).toBeGreaterThan(0);
      expect(c.sites['a3_haworth']?.series?.n).toBeLessThanOrEqual(50);
    } },
  { op: 'getDataset', method: 'GET', url: `${API}/dataset?site_ids=${SITE},apollo11&start=2026-01-07T00:00:00Z&end=2026-01-14T00:00:00Z`, status: 200, contentType: 'application/json', schema: DatasetResponse,
    check: (b) => expect((b as DatasetResponse).sites.map((s) => s.series?.t.length)).toEqual([168, 168]) },
  { op: 'simulateSurvival', method: 'POST', url: `${API}/mission/survival`, body: { site_id: SITE, landing_utc: '2026-01-01T00:00:00Z', mission_h: 720, battery_wh: 3000, night_load_w: 30, panel_peak_w: 200 }, status: 200, contentType: 'application/json', schema: SurvivalResponse,
    check: (b) => {
      const s = b as SurvivalResponse;
      expect(s.n_steps).toBe(720);
      expect(s.inputs.panel_mode).toBe('tracking');
      expect(s.timeline.n_full).toBe(721);
      expect(s.assumptions.length).toBeGreaterThan(0);
    } },
  { op: 'getRanking', method: 'GET', url: `${API}/ranking`, status: 200, contentType: 'application/json', schema: RankingResponse,
    check: (b) => {
      const r = b as RankingResponse;
      expect(r.source).toBe('summary');
      expect(r.ranking[0]?.score).toBe(71.162037); // = summary.csv
    } },
  { op: 'getRanking', method: 'GET', url: `${API}/ranking?weights=pct_sun:1&group=south_pole`, status: 200, contentType: 'application/json', schema: RankingResponse,
    check: (b) => {
      const r = b as RankingResponse;
      expect(r.source).toBe('computed');
      expect(r.ranking.map((x) => x.site_id)).toEqual(['a3_de_gerlache_rim_2', 'a3_haworth']);
    } },
  { op: 'findAltDates', method: 'POST', url: `${API}/alt-dates`, body: exampleAltDatesRequest(), status: 200, contentType: 'application/json', schema: AltDatesResponse,
    check: (b, h) => {
      expect((b as AltDatesResponse).candidates.length).toBeGreaterThan(0);
      expect(h['x-lunarnav-cache']).toBe('miss');
    } },
  { op: 'exportSiteSeriesCsv', method: 'GET', url: `${API}/sites/${SITE}/export/series.csv?end=2026-01-01T03:00:00Z&fields=sun_el_deg,sun_visible`, status: 200, contentType: 'text/csv',
    check: (b) => expect(String(b)).toBe('time_utc,sun_el_deg,sun_visible\n2026-01-01T00:00:00Z,0.805135,1\n2026-01-01T01:00:00Z,0.805347,1\n2026-01-01T02:00:00Z,0.8056,1\n') },
  { op: 'exportSiteWindowsCsv', method: 'GET', url: `${API}/sites/${SITE}/export/windows.csv?kinds=sun`, status: 200, contentType: 'text/csv',
    check: (b) => {
      const lines = String(b).trim().split('\n');
      expect(lines[0]).toBe('kind,start,end,duration_h,state,truncated_start,truncated_end,clipped_start,clipped_end');
      expect(lines[1]).toBe('sun,2026-01-01T00:00:00Z,2026-03-29T00:00:00Z,2088,1,1,0,0,0');
    } },
  { op: 'exportSummaryCsv', method: 'GET', url: `${API}/export/summary.csv`, status: 200, contentType: 'text/csv',
    check: (b) => {
      const lines = String(b).trim().split('\n');
      expect(lines).toHaveLength(7);
      expect(lines[1]?.startsWith('1,ref_connecting_ridge_c1,')).toBe(true);
    } },
  { op: 'getRunFile', method: 'GET', url: `${API}/runs/${SAMPLE_RUN_ID}/files/${encodeURIComponent(RUN_FILE)}`, status: 200, contentType: 'application/json',
    check: async (b, h) => {
      const bytes = await readFile(path.join(SAMPLE_DIR, ...RUN_FILE.split('/')));
      expect(String(b)).toBe(bytes.toString('utf8'));
      expect(h['etag']).toBe(`"${sha256(bytes)}"`);
    } },
];

/** operationIds exercised in this file (CASES + the job tests below). */
const covered = new Set<string>(CASES.map((c) => c.op));
let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestApp({ config: { LUNARNAV_ROOT: FAKE_LUNARNAV, JOB_CONCURRENCY: 2 } });
  // the real importer; copies the run into DATA_DIR/runs/<run_id>/ (source of the raw-file route)
  const res = await importRun(getDb(), { dir: SAMPLE_DIR, check: false, dataDir: ctx.dataDir, catalogPath: CATALOG_PATH, setDefault: true });
  expect(res.run_id).toBe(SAMPLE_RUN_ID);
});

afterAll(async () => {
  await ctx?.close();
});

describe('every operation answers with a schema-valid response', () => {
  it.each(CASES.map((c) => [`${c.method} ${c.url}`, c] as const))('%s', async (_name, c) => {
    const res = await ctx.app.inject({ method: c.method, url: c.url, ...(c.body === undefined ? {} : { payload: c.body as object }) });
    expect(res.statusCode, res.body).toBe(c.status);
    expect(res.headers['content-type']).toContain(c.contentType);
    const body: unknown = c.contentType.includes('json') && c.op !== 'getRunFile' ? res.json() : res.body;
    if (c.schema) {
      const parsed = c.schema.safeParse(body);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    }
    expect(res.headers['x-lunarnav-stub']).toBeUndefined();
    await c.check?.(body, res.headers);
  });
});

describe('jobs (fake lunarnav)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitTerminal(id: string): Promise<Job> {
    for (let k = 0; k < 200; k++) {
      const j = Job.parse((await ctx.app.inject({ method: 'GET', url: `${API}/jobs/${id}` })).json());
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
      await sleep(100);
    }
    throw new Error(`job ${id} did not finish`);
  }
  let jobId = '';

  it('POST /jobs -> 202, GET /jobs/{id} -> succeeded, data queryable through the read routes', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: `${API}/jobs`, payload: { type: 'custom_site', lat_deg: -10, lon_deg: 20, start: '2027-01-01T00:00:00Z', end: '2027-01-15T00:00:00Z' } });
    expect(res.statusCode, res.body).toBe(202);
    const acc = JobAccepted.parse(res.json());
    expect(acc.site_id).toBe('custom:-10.0000:20.0000');
    expect(res.headers['location']).toBe(acc.poll);
    jobId = acc.job_id;
    const j = await waitTerminal(jobId);
    expect(j.status, JSON.stringify(j.error)).toBe('succeeded');
    expect(j.result?.run_id).toBe(`job_${jobId}`);
    const site = await ctx.app.inject({ method: 'GET', url: `${API}/sites?run_id=job_${jobId}` });
    expect(site.statusCode).toBe(200);
    expect(SitesResponse.parse(site.json()).sites.length).toBeGreaterThan(0);
    covered.add('createJob').add('getJob');
  });

  it('GET /jobs/{id}/events streams the terminal state and ends', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `${API}/jobs/${jobId}/events` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toMatch(/^event: job\ndata: \{.*"status":"succeeded".*\}\n\n$/s);
    covered.add('streamJobEvents');
  });

  it('DELETE /jobs/{id} cancels a running job; a finished one is 409', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: `${API}/jobs`, payload: { type: 'custom_site', lat_deg: -20, lon_deg: 20, start: '2027-01-01T00:00:00Z', end: '2027-01-15T00:00:00Z' } });
    expect(res.statusCode).toBe(202);
    const id = JobAccepted.parse(res.json()).job_id;
    const del = await ctx.app.inject({ method: 'DELETE', url: `${API}/jobs/${id}` });
    expect(del.statusCode, del.body).toBe(200);
    expect(Job.parse(del.json()).status).toBe('cancelled');
    const again = await ctx.app.inject({ method: 'DELETE', url: `${API}/jobs/${jobId}` });
    expect(again.statusCode).toBe(409);
    expect(Problem.parse(again.json()).code).toBe('JOB_NOT_CANCELLABLE');
    covered.add('cancelJob');
  });

  it('GET /jobs/{id}/artifacts[/{name}] (custom_site publishes none) and GET /capabilities', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: `${API}/jobs/${jobId}/artifacts` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ job_id: jobId, type: 'custom_site', status: 'succeeded', artifacts: [] });
    const file = await ctx.app.inject({ method: 'GET', url: `${API}/jobs/${jobId}/artifacts/report.json` });
    expect(file.statusCode).toBe(404);
    expect(Problem.parse(file.json()).code).toBe('FILE_NOT_FOUND');
    const caps = await ctx.app.inject({ method: 'GET', url: `${API}/capabilities` });
    expect(caps.statusCode).toBe(200);
    expect((caps.json() as { job_types: { type: string }[] }).job_types[0]?.type).toBe('custom_site');
    covered.add('listJobArtifacts').add('getJobArtifact').add('getCapabilities');
  });

  it('POST /tools/ephemeris and /tools/horizon answer problem+json here (fake lunarnav; 200s: tests/tools*.test.ts)', async () => {
    for (const tool of ['ephemeris', 'horizon'] as const) {
      const bad = await ctx.app.inject({ method: 'POST', url: `${API}/tools/${tool}`, payload: { lat_deg: -85 } });
      expect(bad.statusCode).toBe(400);
      expect(Problem.parse(bad.json()).code).toBe('VALIDATION_ERROR');
      const payload = tool === 'ephemeris' ? { lat_deg: -85, lon_deg: 10, times: ['2026-01-01T00:00:00Z'], surface_height: 'sphere' } : { lat_deg: -85, lon_deg: 10, dem: 'none' };
      const res = await ctx.app.inject({ method: 'POST', url: `${API}/tools/${tool}`, payload });
      expect([422, 502], res.body).toContain(res.statusCode); // the fake package has no providers / horizon factory
      expect(res.headers['content-type']).toContain('application/problem+json');
      Problem.parse(res.json());
    }
    covered.add('toolEphemeris').add('toolHorizon');
  });
});

describe('problem+json errors', () => {
  async function problem(method: 'GET' | 'POST', url: string, status: number, code: string, payload?: string | object) {
    const res = await ctx.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload, headers: { 'content-type': 'application/json' } }),
    });
    expect(res.statusCode, res.body).toBe(status);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = Problem.parse(res.json());
    expect(body.code).toBe(code);
    expect(body.status).toBe(status);
    expect(body.instance).toBe(url.split('?')[0]);
    return body;
  }

  it('400 VALIDATION_ERROR with field details for a bad query', async () => {
    const p = await problem('GET', `${API}/sites/${SITE}/series?max_points=abc&start=yesterday`, 400, 'VALIDATION_ERROR');
    const paths = (p.errors ?? []).map((e) => e.path).sort();
    expect(paths).toEqual(['max_points', 'start']);
    expect(p.errors?.every((e) => e.in === 'querystring')).toBe(true);
  });

  it('400 VALIDATION_ERROR for unknown query parameters and bad enum values', async () => {
    const p = await problem('GET', `${API}/sites?colour=red`, 400, 'VALIDATION_ERROR');
    expect(p.errors?.[0]?.code).toBe('unrecognized_keys');
    const q = await problem('GET', `${API}/sites/${SITE}/windows?kinds=sun,moon`, 400, 'VALIDATION_ERROR');
    expect(q.errors?.[0]?.path).toBe('kinds.1');
  });

  it('400 TOO_MANY_POINTS above the series limits', async () => {
    await problem('GET', `${API}/sites/${SITE}/series?max_points=9999`, 400, 'TOO_MANY_POINTS');
    const nine = SERIES_FIELDS.slice(0, 9).join(',');
    const p = await problem('GET', `${API}/sites/${SITE}/series?fields=${nine}`, 400, 'TOO_MANY_POINTS');
    expect(p.hint).toContain('5000');
  });

  it('400 for invalid bodies (zod) and malformed JSON', async () => {
    const p = await problem('POST', `${API}/compare`, 400, 'VALIDATION_ERROR', { site_ids: ['apollo11'] });
    expect(p.errors?.[0]).toMatchObject({ path: 'site_ids', in: 'body', code: 'too_small' });
    await problem('POST', `${API}/compare`, 400, 'VALIDATION_ERROR', '{"site_ids": [');
    const j = await problem('POST', `${API}/jobs`, 400, 'VALIDATION_ERROR', { ...exampleJobRequest(), site_id: 'apollo11' });
    expect(j.errors?.[0]?.message).toContain('either site_id or lat_deg');
  });

  it('404 SITE_NOT_FOUND / RUN_NOT_FOUND / JOB_NOT_FOUND / FILE_NOT_FOUND / NOT_FOUND', async () => {
    await problem('GET', `${API}/sites/nope`, 404, 'SITE_NOT_FOUND');
    await problem('GET', `${API}/sites/${encodeURIComponent('custom:-89.4500:222.6900')}/horizon`, 404, 'SITE_NOT_FOUND');
    await problem('GET', `${API}/sites?run_id=pf_0000000000000000`, 404, 'RUN_NOT_FOUND');
    await problem('GET', `${API}/runs/pf_0000000000000000`, 404, 'RUN_NOT_FOUND');
    await problem('GET', `${API}/jobs/j_doesnotexist`, 404, 'JOB_NOT_FOUND');
    await problem('GET', `${API}/runs/${SAMPLE_RUN_ID}/files/${encodeURIComponent('sites/apollo11/nothing.json')}`, 404, 'FILE_NOT_FOUND');
    await problem('GET', `${API}/runs/${SAMPLE_RUN_ID}/files/${encodeURIComponent('../../secret.txt')}`, 400, 'VALIDATION_ERROR');
    await problem('GET', `${API}/nothing-here`, 404, 'NOT_FOUND');
  });

  it('422 OUT_OF_RANGE outside the run', async () => {
    const p = await problem('GET', `${API}/sites/${SITE}/instant?t=2027-01-01T00:00:00Z`, 422, 'OUT_OF_RANGE');
    expect(p.errors?.[0]?.path).toBe('t');
    await problem('GET', `${API}/sites/${SITE}/series?start=2030-01-01T00:00:00Z&end=2030-02-01T00:00:00Z`, 422, 'OUT_OF_RANGE');
    await problem('POST', `${API}/alt-dates`, 422, 'OUT_OF_RANGE', { ...exampleAltDatesRequest(), earliest: '2025-12-01T00:00:00Z' });
  });
});

describe('infrastructure', () => {
  it('creates the registered collections and indexes (series is time-series)', async () => {
    const db = getDb();
    const cols = await db.listCollections().toArray();
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const name of ['runs', 'sites', 'site_runs', 'horizons', 'windows', 'series', 'jobs', 'cache']) expect(byName.has(name), name).toBe(true);
    expect(byName.get('series')?.type).toBe('timeseries');
    const jobIx = await db.collection('jobs').indexes();
    expect(jobIx.find((i) => i.name === 'expires_at_ttl')?.expireAfterSeconds).toBe(0);
    const srIx = await db.collection('site_runs').indexes();
    expect(srIx.find((i) => i.name === 'run_id_1_site_id_1')?.unique).toBe(true);
    const info = await db.admin().serverInfo();
    expect(String(info['version'])).toMatch(/^8\.0\./);
  });

  it('serves the OpenAPI document and it equals the committed contract/openapi.json', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `${API}/openapi.json` });
    expect(res.statusCode).toBe(200);
    const live = res.json() as { openapi: string };
    expect(live.openapi).toBe('3.1.0');
    const committed = JSON.parse(await readFile(path.join(here, '..', 'contract', 'openapi.json'), 'utf8')) as unknown;
    expect(live, 'contract/openapi.json is stale - run npm run openapi:export').toEqual(committed);
  });

  it('every operation of the OpenAPI document is exercised by this file', async () => {
    const spec = (await ctx.app.inject({ method: 'GET', url: `${API}/openapi.json` })).json() as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ops = Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(ops.every((o) => typeof o === 'string')).toBe(true);
    expect(covered).toEqual(new Set(ops));
    expect(ops).toHaveLength(30);
  });

  it('serves the docs UI', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('answers CORS preflight for the Next.js dev origin only and exposes the API headers', async () => {
    const ok = await ctx.app.inject({ method: 'OPTIONS', url: `${API}/sites`, headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const get = await ctx.app.inject({ method: 'GET', url: `${API}/meta`, headers: { origin: 'http://localhost:3000' } });
    const exposed = String(get.headers['access-control-expose-headers']).split(',').map((h) => h.trim());
    for (const h of ['etag', 'location', 'retry-after', 'x-lunarnav-cache', 'content-disposition']) expect(exposed).toContain(h);
    const bad = await ctx.app.inject({ method: 'GET', url: `${API}/meta`, headers: { origin: 'http://evil.example' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('compresses large JSON when asked', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `${API}/sites/${SITE}/horizon`, headers: { 'accept-encoding': 'br' } });
    expect(res.headers['content-encoding']).toBe('br');
  });

  it('ETag / If-None-Match on raw files and on data responses', async () => {
    for (const url of [`${API}/runs/${SAMPLE_RUN_ID}/files/${encodeURIComponent(RUN_FILE)}`, `${API}/sites`]) {
      const first = await ctx.app.inject({ method: 'GET', url });
      expect(first.headers['etag'], url).toBeDefined();
      const again = await ctx.app.inject({ method: 'GET', url, headers: { 'if-none-match': String(first.headers['etag']) } });
      expect(again.statusCode, url).toBe(304);
      expect(again.body).toBe('');
    }
  });
});
