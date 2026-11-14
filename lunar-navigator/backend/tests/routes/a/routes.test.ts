/**
 * Group A read routes against REAL data: the sample precompute run is imported with the importer
 * (src/importer/importRun.ts) into a throw-away MongoDB 8.0 (mongodb-memory-server), then
 * runs / sites / horizon / ranking / compare are compared with the Python outputs:
 * summary.csv and windows.json verbatim, and lunarnav's own sub-range metrics/rankings
 * (fixtures/reference.json). Skipped when output/sample_2026Q1_spice_pgda is absent (git-ignored).
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { RunDetail, RunsResponse } from '../../../src/contract/runs.ts';
import { HorizonResponse, SiteDetail, SitesGeoJson, SitesResponse } from '../../../src/contract/sites.ts';
import { CompareResponse, RankingResponse } from '../../../src/contract/analysis.ts';
import { Problem } from '../../../src/lib/problem.ts';
import { getDb } from '../../../src/db.ts';
import { importRun } from '../../../src/importer/importRun.ts';
import { dataCollections } from '../../../src/repos/index.ts';
import { sameWeights } from '../../../src/routes/a/ranking.ts';
import { startTestApp, type TestContext } from '../../helpers.ts';
import { CATALOG_PATH, REFERENCE, SAMPLE_DIR, horizonCsv, summaryRows, windowsJson } from './sample.ts';

const API = '/api/v1';
const RUN = 'pf_21c3f3f6dc56b1e1';
const COPY = 'sample_copy';
const RIDGE = 'ref_connecting_ridge_c1';

let ctx: TestContext;

async function get<S extends z.ZodType>(url: string, schema: S, headers: Record<string, string> = {}): Promise<{ body: z.output<S>; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers });
  expect(res.statusCode, res.body).toBe(200);
  const parsed = schema.safeParse(res.json());
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  return { body: parsed.data as z.output<S>, headers: res.headers };
}

async function post<S extends z.ZodType>(url: string, payload: object, schema: S): Promise<z.output<S>> {
  const res = await ctx.app.inject({ method: 'POST', url, payload });
  expect(res.statusCode, res.body).toBe(200);
  const parsed = schema.safeParse(res.json());
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  return parsed.data as z.output<S>;
}

async function problem(method: 'GET' | 'POST', url: string, status: number, code: string, payload?: object) {
  const res = await ctx.app.inject({ method, url, ...(payload ? { payload } : {}) });
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toContain('application/problem+json');
  const p = Problem.parse(res.json());
  expect(p.code).toBe(code);
  return p;
}

describe.runIf(existsSync(SAMPLE_DIR))('group A routes on the imported sample run', () => {
  beforeAll(async () => {
    ctx = await startTestApp();
    const db = getDb();
    const base = { dir: SAMPLE_DIR, check: false as const, dataDir: null, catalogPath: CATALOG_PATH };
    const a = await importRun(db, { ...base, setDefault: true });
    expect(a.run_id).toBe(RUN);
    // a second, non-default run of the same data (pagination, run selection)
    await importRun(db, { ...base, runId: COPY, label: 'copy' });
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  // ---- runs ----------------------------------------------------------------------------------------
  describe('runs', () => {
    it('lists runs with the default first, paginated', async () => {
      const { body, headers } = await get(`${API}/runs`, RunsResponse);
      expect(body.default_run_id).toBe(RUN);
      expect(body.total).toBe(2);
      expect(body.runs.map((r) => r.run_id)).toEqual([RUN, COPY]);
      expect(body.runs.map((r) => r.is_default)).toEqual([true, false]);
      const r0 = body.runs[0];
      expect(r0).toMatchObject({ kind: 'precompute', status: 'ready', provider: 'spice', dem: 'pgda', start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-04-01T00:00:00Z', step_s: 3600, n_samples: 2160, n_sites: 6 });
      expect(r0?.rank_weights).toEqual({ pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 });
      expect(headers['cache-control']).toBe('public, max-age=30');

      const page = await get(`${API}/runs?limit=1&offset=1`, RunsResponse);
      expect(page.body).toMatchObject({ total: 2, limit: 1, offset: 1 });
      expect(page.body.runs.map((r) => r.run_id)).toEqual([COPY]);
      expect((await get(`${API}/runs?kind=custom`, RunsResponse)).body.runs).toEqual([]);
      await problem('GET', `${API}/runs?limit=0`, 400, 'VALIDATION_ERROR');
    });

    it('returns one run with its manifest, 404 for an unknown id', async () => {
      const { body } = await get(`${API}/runs/${RUN}`, RunDetail);
      expect(body.manifest.format).toBe('lunarnav-precompute');
      expect(body.manifest.files.find((f) => f.path === 'summary.csv')?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.manifest.files.length).toBe(2 + 6 * 4);
      expect(body.manifest.data_sources.every((d) => 'url' in d && 'sha256' in d)).toBe(true);
      await problem('GET', `${API}/runs/pf_nope`, 404, 'RUN_NOT_FOUND');
    });
  });

  // ---- sites ---------------------------------------------------------------------------------------
  describe('sites', () => {
    it('lists the sites in summary.csv order with summary values verbatim', async () => {
      const summary = summaryRows();
      const { body, headers } = await get(`${API}/sites`, SitesResponse);
      expect(body).toMatchObject({ run_id: RUN, step_s: 3600, precision_h: 1 });
      expect(body.sites.map((s) => [s.id, s.rank, s.score, s.pct_sun, s.pct_earth, s.pct_both, s.longest_dark_h, s.longest_comms_gap_h])).toEqual(
        summary.map((r) => [r.site_id, r.rank, r.score, r.pct_sun, r.pct_earth, r.pct_both, r.longest_dark_h, r.longest_comms_gap_h]),
      );
      const ridge = body.sites.find((s) => s.id === RIDGE);
      expect(ridge?.map?.projection).toBe('south_polar_stereographic_R1737.4km');
      expect(body.sites.find((s) => s.id === 'apollo11')?.map).toBeNull();
      expect(headers['etag']).toMatch(/^W\/"/);
      // no run_id -> follows the (mutable) default run -> short lifetime; long only with run_id
      expect(headers['cache-control']).toBe('public, max-age=60');
      expect((await get(`${API}/sites?run_id=${RUN}`, SitesResponse)).headers['cache-control']).toBe('public, max-age=3600');
    });

    it('filters by group and selects another run with run_id', async () => {
      const sp = await get(`${API}/sites?group=south_pole`, SitesResponse);
      expect(sp.body.sites.map((s) => s.id)).toEqual(['a3_de_gerlache_rim_2', 'a3_haworth']);
      const copy = await get(`${API}/sites?run_id=${COPY}&group=reference`, SitesResponse);
      expect(copy.body.run_id).toBe(COPY);
      expect(copy.body.sites.map((s) => s.id)).toEqual([RIDGE, 'ref_shackleton_rim']);
      expect((await get(`${API}/sites?group=nothing`, SitesResponse)).body.sites).toEqual([]);
    });

    it('serves GeoJSON points (+ region polygons from the catalog)', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: `${API}/sites?format=geojson` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/geo+json');
      const g = SitesGeoJson.parse(res.json());
      const points = g.features.filter((f) => f.properties.kind === 'site');
      expect(points).toHaveLength(6);
      const apollo = points.find((f) => f.id === 'apollo11');
      expect(apollo?.geometry).toEqual({ type: 'Point', coordinates: [23.47314, 0.67416] });
      for (const poly of g.features.filter((f) => f.properties.kind === 'region')) {
        expect(poly.geometry.type).toBe('Polygon');
        const ring = poly.geometry.coordinates[0] as [number, number][];
        expect(ring[0]).toEqual(ring[ring.length - 1]);
      }
    });

    it('answers 304 when the ETag is current', async () => {
      const first = await ctx.app.inject({ method: 'GET', url: `${API}/sites` });
      const etag = String(first.headers['etag']);
      const again = await ctx.app.inject({ method: 'GET', url: `${API}/sites`, headers: { 'if-none-match': etag } });
      expect(again.statusCode).toBe(304);
      expect(again.body).toBe('');
      expect(again.headers['etag']).toBe(etag);
      const other = await ctx.app.inject({ method: 'GET', url: `${API}/sites?run_id=${COPY}`, headers: { 'if-none-match': etag } });
      expect(other.statusCode).toBe(200);
    });

    it('site card: windows.json metrics and summary rank verbatim', async () => {
      for (const row of summaryRows()) {
        const { body } = await get(`${API}/sites/${row.site_id}`, SiteDetail);
        expect(body.metrics).toEqual(windowsJson(row.site_id).metrics);
        expect([body.rank, body.score]).toEqual([row.rank, row.score]);
        expect(body.site.surface_height_m).toBe(row.surface_height_m);
        expect(body.range).toEqual({ start: '2026-01-01T00:00:00Z', end: '2026-04-01T00:00:00Z', step_s: 3600, n_samples: 2160 });
      }
      const apollo = await get(`${API}/sites/apollo11`, SiteDetail);
      expect(apollo.body.warnings).toContain('flat horizon: terrain shadowing not modelled');
      const ridge = await get(`${API}/sites/${RIDGE}`, SiteDetail);
      expect(ridge.body.warnings).toEqual([]);
      expect(ridge.body.extra).not.toBeNull();
    });

    it('horizon = horizon CSV', async () => {
      const { body } = await get(`${API}/sites/${RIDGE}/horizon`, HorizonResponse);
      const csv = horizonCsv(RIDGE, 'raymarch');
      expect(body.az_deg).toEqual(csv.az);
      expect(body.el_deg).toEqual(csv.el);
      expect(body.method).toBe('raymarch');
      expect(body.min_el_deg).toBe(Math.min(...csv.el));
    });

    it('404 / 409 problems', async () => {
      await problem('GET', `${API}/sites/nope`, 404, 'SITE_NOT_FOUND');
      await problem('GET', `${API}/sites/${encodeURIComponent('custom:-89.4500:222.6900')}/horizon`, 404, 'SITE_NOT_FOUND');
      await problem('GET', `${API}/sites?run_id=pf_0000000000000000`, 404, 'RUN_NOT_FOUND');
      await dataCollections().runs.updateOne({ _id: COPY }, { $set: { status: 'importing' } });
      try {
        await problem('GET', `${API}/sites/${RIDGE}?run_id=${COPY}`, 409, 'RUN_NOT_READY');
        await problem('GET', `${API}/ranking?run_id=${COPY}`, 409, 'RUN_NOT_READY');
      } finally {
        await dataCollections().runs.updateOne({ _id: COPY }, { $set: { status: 'ready' } });
      }
    });
  });

  // ---- ranking ------------------------------------------------------------------------------------
  describe('ranking', () => {
    it('full run + default weights = summary.csv verbatim', async () => {
      const { body } = await get(`${API}/ranking`, RankingResponse);
      expect(body.source).toBe('summary');
      expect(body.range).toEqual({ start: '2026-01-01T00:00:00Z', end: '2026-04-01T00:00:00Z', step_s: 3600, n_samples: 2160 });
      const summary = summaryRows();
      expect(body.ranking.map((r) => [r.rank, r.site_id, r.name, r.group, r.score, r.pct_sun, r.pct_earth, r.pct_both, r.pct_sun_no_earth, r.longest_dark_h, r.longest_dark_truncated, r.longest_comms_gap_h, r.longest_comms_gap_truncated, r.mean_power_tracking])).toEqual(
        summary.map((r) => [r.rank, r.site_id, r.name, r.group, r.score, r.pct_sun, r.pct_earth, r.pct_both, r.pct_sun_no_earth, r.longest_dark_h, r.longest_dark_truncated, r.longest_comms_gap_h, r.longest_comms_gap_truncated, r.mean_power_tracking]),
      );
      expect(body.ranking[0]?.reasons.length).toBeGreaterThan(0);
      // same weights in another order / explicit range -> still the summary
      const again = await get(`${API}/ranking?weights=pct_both:0.3,pct_earth:0.3,pct_sun:0.4&start=2026-01-01T00:00:00Z&end=2026-04-01T00:00:00Z`, RankingResponse);
      expect(again.body.source).toBe('summary');
      expect(again.body.ranking).toEqual(body.ranking);
    });

    it('group filter keeps summary values and numbers ranks within the group', async () => {
      const { body } = await get(`${API}/ranking?group=reference`, RankingResponse);
      expect(body.source).toBe('summary');
      expect(body.ranking.map((r) => [r.rank, r.site_id, r.score])).toEqual([[1, RIDGE, 71.162037], [2, 'ref_shackleton_rim', 70.185186]]);
    });

    it('sub-ranges and other weights = lunarnav compute_metrics + rank_sites EXACTLY', async () => {
      for (const rg of REFERENCE.ranges) {
        for (const rk of rg.rankings) {
          const w = Object.entries(rk.weights).map(([k, v]) => `${k}:${v}`).join(',');
          const { body } = await get(`${API}/ranking?start=${rg.start}&end=${rg.end}&weights=${w}`, RankingResponse);
          const isSummary = rg.start === '2026-01-01T00:00:00Z' && rg.end === '2026-04-01T00:00:00Z' && sameWeights(rk.weights, { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 });
          expect(body.source).toBe(isSummary ? 'summary' : 'computed');
          expect(body.ranking.map((r) => ({ rank: r.rank, site_id: r.site_id, score: r.score })), `${rg.start}..${rg.end} ${w}`).toEqual(rk.rows);
          for (const r of body.ranking) {
            const m = rg.metrics[r.site_id];
            expect([r.pct_sun, r.pct_earth, r.pct_both, r.pct_sun_no_earth, r.longest_dark_h, r.longest_dark_truncated, r.longest_comms_gap_h, r.longest_comms_gap_truncated]).toEqual(
              [m?.pct_sun, m?.pct_earth, m?.pct_both, m?.pct_sun_no_earth, m?.longest_dark_h, m?.longest_dark_truncated, m?.longest_comms_gap_h, m?.longest_comms_gap_truncated],
            );
          }
        }
      }
    });

    it('snaps the range and rejects empty / outside ranges', async () => {
      const { body } = await get(`${API}/ranking?start=2026-02-01T00:30:00Z&end=2026-02-01T05:10:00Z`, RankingResponse);
      expect(body.range).toEqual({ start: '2026-02-01T00:00:00Z', end: '2026-02-01T06:00:00Z', step_s: 3600, n_samples: 6 });
      await problem('GET', `${API}/ranking?start=2026-03-01T00:00:00Z&end=2026-02-01T00:00:00Z`, 422, 'OUT_OF_RANGE');
      const p = await problem('GET', `${API}/ranking?start=2027-01-01T00:00:00Z`, 422, 'OUT_OF_RANGE');
      expect(p.errors?.[0]?.path).toBe('start');
      await problem('GET', `${API}/ranking?weights=pct_moon:1`, 400, 'VALIDATION_ERROR');
    });

    it('caches GETs with an ETag that depends on the query', async () => {
      const a = await ctx.app.inject({ method: 'GET', url: `${API}/ranking` });
      const b = await ctx.app.inject({ method: 'GET', url: `${API}/ranking?weights=pct_sun:1` });
      expect(a.headers['etag']).not.toBe(b.headers['etag']);
      const c = await ctx.app.inject({ method: 'GET', url: `${API}/ranking`, headers: { 'if-none-match': String(a.headers['etag']) } });
      expect(c.statusCode).toBe(304);
    });
  });

  // ---- compare ------------------------------------------------------------------------------------
  describe('compare', () => {
    it('full run: windows.json metrics verbatim, ranking scores = summary.csv', async () => {
      const ids = ['apollo11', RIDGE, 'a3_haworth'];
      const body = await post(`${API}/compare`, { site_ids: ids }, CompareResponse);
      expect(Object.keys(body.sites)).toEqual(ids);
      for (const id of ids) expect(body.sites[id]?.metrics).toEqual(windowsJson(id).metrics);
      const summary = new Map(summaryRows().map((r) => [r.site_id, r]));
      expect(body.ranking.map((r) => r.site_id)).toEqual([RIDGE, 'apollo11', 'a3_haworth']);
      for (const r of body.ranking) expect(r.score).toBe(summary.get(r.site_id)?.score);
      expect(body.weights).toEqual({ pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 });
    });

    it('sub-range: metrics = lunarnav compute_metrics on that range', async () => {
      for (const rg of REFERENCE.ranges.slice(1)) {
        const ids = [RIDGE, 'a3_de_gerlache_rim_2', 'change6', 'apollo11'];
        const body = await post(`${API}/compare`, { site_ids: ids, start: rg.start, end: rg.end, weights: { pct_sun: 1 } }, CompareResponse);
        for (const id of ids) expect(body.sites[id]?.metrics, `${id} ${rg.start}`).toEqual(rg.metrics[id]);
        const ref = rankSitesSubset(rg, ids, { pct_sun: 1 });
        expect(body.ranking.map((r) => r.site_id)).toEqual(ref);
      }
    });

    it('embeds clipped windows and a downsampled series on request', async () => {
      const body = await post(
        `${API}/compare`,
        { site_ids: [RIDGE, 'a3_haworth'], start: '2026-03-01T00:00:00Z', end: '2026-04-01T00:00:00Z', include: { windows: ['sun', 'both'], series: { fields: ['sun_el_deg', 'sun_visible'], max_points: 100 } } },
        CompareResponse,
      );
      const ridge = body.sites[RIDGE];
      expect(ridge?.windows?.earth).toBeUndefined();
      const sun = ridge?.windows?.sun ?? [];
      expect(sun[0]?.start).toBe('2026-03-01T00:00:00Z');
      expect(sun[0]?.clipped_start).toBe(true);
      expect(sun.at(-1)?.end).toBe('2026-04-01T00:00:00Z');
      expect(sun.reduce((a, w) => a + w.duration_h, 0)).toBe(744);
      const s = ridge?.series;
      expect(s).toMatchObject({ start: '2026-03-01T00:00:00Z', end: '2026-04-01T00:00:00Z', step_s: 3600, bin_s: 8 * 3600, n: 93, agg: 'sample' });
      expect(s?.fields['sun_el_deg']).toHaveLength(93);
      expect(typeof (s?.fields['sun_visible'] as unknown[])[0]).toBe('boolean');
    });

    it('problems: unknown site 404, bad range 422, bad body 400', async () => {
      const p = await problem('POST', `${API}/compare`, 404, 'SITE_NOT_FOUND', { site_ids: [RIDGE, 'nope'] });
      expect(p.detail).toContain('nope');
      await problem('POST', `${API}/compare`, 422, 'OUT_OF_RANGE', { site_ids: [RIDGE, 'apollo11'], start: '2026-02-01T00:00:00Z', end: '2026-02-01T00:00:00Z' });
      await problem('POST', `${API}/compare`, 404, 'RUN_NOT_FOUND', { run_id: 'pf_x', site_ids: [RIDGE, 'apollo11'] });
      await problem('POST', `${API}/compare`, 400, 'VALIDATION_ERROR', { site_ids: [RIDGE, RIDGE] });
    });
  });
});

/** Order lunarnav would give for a subset of sites (from the reference metrics). */
function rankSitesSubset(rg: (typeof REFERENCE.ranges)[number], ids: string[], w: Record<string, number>): string[] {
  const score = (id: string) => Object.entries(w).reduce((a, [k, v]) => a + v * Number((rg.metrics[id] as unknown as Record<string, number>)[k]), 0);
  return [...ids].sort((a, b) => score(b) - score(a) || (rg.metrics[a]?.longest_dark_h ?? 0) - (rg.metrics[b]?.longest_dark_h ?? 0) || (a < b ? -1 : 1));
}
