/**
 * OpenAPI EXAMPLE DATA: small fixtures extracted from the REAL sample precompute output
 * (output/sample_2026Q1_spice_pgda, 6 sites, 2026-01-01..2026-04-01 hourly, SPICE + PGDA) by
 * scripts/make-fixtures.py. They feed the example* builders, i.e. the examples of contract/openapi.json
 * (and therefore the Prism mock). No route handler uses them: every route reads MongoDB (src/repos).
 *
 * Only TYPE imports from the endpoint contracts (no runtime cycle: contract -> fixtures -> JSON). Ranking and
 * custom ids use the REAL implementations (routes/a/ranking.ts, python/customSiteId.ts), so there is one copy of the logic.
 */
import runJson from './run.json' with { type: 'json' };
import sitesJson from './sites.json' with { type: 'json' };
import horizonsJson from './horizons.json' with { type: 'json' };
import seriesJson from './series.json' with { type: 'json' };
import windowsJson from './windows.json' with { type: 'json' };
import altDatesJson from './alt_dates.json' with { type: 'json' };
import { ApiError, runNotFound, siteNotFound } from '../lib/problem.ts';
import { parseIsoUtc, parseIsoUtcCeil, precisionH, sampleIndex, snapRange, toIsoUtc } from '../lib/time.ts';
import { DEFAULT_RANK_WEIGHTS, type ClippedWindow, type Metrics, type RankWeights, type WindowKind } from '../contract/common.ts';
import { normalizeWeights, rankSites as rankInputs, sameWeights, type RankInput } from '../routes/a/ranking.ts';
import { customSiteId } from '../python/customSiteId.ts';
import type { RunDetail, RunSummary, RunsResponse } from '../contract/runs.ts';
import type { HorizonResponse, SiteDetail, SiteListItem, SiteRecord, SitesGeoJson, SitesResponse } from '../contract/sites.ts';
import type { InstantResponse, SeriesResponse } from '../contract/series.ts';
import type { WindowsResponse } from '../contract/windows.ts';
import type { CompareRequest, CompareResponse, RankingResponse } from '../contract/analysis.ts';
import type { AltDatesRequest, AltDatesResponse } from '../contract/alt_dates.ts';
import type { CustomSiteJobRequest, Job, JobAccepted, JobStatus } from '../contract/jobs.ts';

// ---- raw fixture shapes ----------------------------------------------------------------------------
interface FixtureSite {
  record: SiteRecord;
  files: Record<string, string>;
  extra: Record<string, unknown> | null;
  map: SiteListItem['map'];
  metrics: Metrics;
  rank: number;
  score: number;
}
interface FixtureWindow {
  start: string;
  end: string;
  duration_h: number;
  state: boolean;
  truncated_start: boolean;
  truncated_end: boolean;
  start_index: number;
  end_index: number;
}
type FixtureWindows = Record<WindowKind, FixtureWindow[]> & { range_start_utc: string; range_end_utc: string; step_s: number };
interface FixtureSeries {
  start: string;
  n: number;
  columns: Record<string, (number | boolean | null)[]>;
}
type FixtureHorizon = Omit<HorizonResponse, 'run_id' | 'step_s' | 'precision_h' | 'site_id'>;

const RUN = runJson as unknown as RunDetail;
const SITES = (sitesJson as unknown as { sites: FixtureSite[] }).sites;
const HORIZONS = horizonsJson as unknown as Record<string, FixtureHorizon>;
const SERIES = (seriesJson as unknown as { sites: Record<string, FixtureSeries> }).sites;
const WINDOWS = windowsJson as unknown as Record<string, FixtureWindows>;
const ALT = altDatesJson as unknown as { request: Omit<AltDatesRequest, 'site_id' | 'run_id'>; result: Omit<AltDatesResponse, 'run_id' | 'step_s' | 'precision_h' | 'cache_id'> };

export const STUB_FOCUS_SITE = 'ref_connecting_ridge_c1';

const RUN_START_MS = parseIsoUtc(RUN.start_utc);
const RUN_END_MS = parseIsoUtc(RUN.end_utc);
const STEP_S = RUN.step_s;
const prov = { run_id: RUN.run_id, step_s: STEP_S, precision_h: precisionH(STEP_S) };

// ---- lookups ------------------------------------------------------------------------------------
/** Throws RUN_NOT_FOUND unless run_id is omitted or the stub run. */
export function stubRun(runId?: string): RunDetail {
  if (runId !== undefined && runId !== RUN.run_id) throw runNotFound(runId);
  return RUN;
}

export function stubSite(siteId: string): FixtureSite {
  const s = SITES.find((x) => x.record.id === siteId);
  if (!s) throw siteNotFound(siteId);
  return s;
}

/** Snap [start, end) (defaults = run range) to the run grid; 422 OUT_OF_RANGE when empty. */
export function stubRange(start?: string, end?: string): { startMs: number; endMs: number; n: number; i0: number } {
  const s = start === undefined ? RUN_START_MS : parseIsoUtc(start);
  const e = end === undefined ? RUN_END_MS : parseIsoUtcCeil(end);
  if (e <= s) {
    throw new ApiError('OUT_OF_RANGE', `end ${toIsoUtc(e)} must be after start ${toIsoUtc(s)}`, {
      errors: [{ path: 'end', message: 'must be after start' }],
    });
  }
  const r = snapRange(s, e, RUN_START_MS, RUN_END_MS, STEP_S);
  if (!r) {
    throw new ApiError('OUT_OF_RANGE', `range does not overlap the run [${RUN.start_utc}, ${RUN.end_utc})`, {
      extensions: { run_start_utc: RUN.start_utc, run_end_utc: RUN.end_utc },
    });
  }
  return r;
}

const timeRange = (r: { startMs: number; endMs: number; n: number }) => ({
  start: toIsoUtc(r.startMs),
  end: toIsoUtc(r.endMs),
  step_s: STEP_S,
  n_samples: r.n,
});

function siteWarnings(rec: SiteRecord): string[] {
  const w: string[] = [];
  if (rec.dem_source.startsWith('none:')) w.push(`smooth-sphere horizon (dem_source ${rec.dem_source})`);
  if (rec.horizon_method === 'flat') w.push('flat horizon: terrain shadowing not modelled');
  return w;
}

// ---- runs ---------------------------------------------------------------------------------------
function runSummary(): RunSummary {
  const { manifest: _m, ...summary } = RUN;
  return summary;
}
/** limit 50 = RUNS_PAGE.limit_default (contract/runs.ts; not imported here to avoid a runtime cycle). */
export const stubRunsResponse = (): RunsResponse => ({ default_run_id: RUN.run_id, total: 1, limit: 50, offset: 0, runs: [runSummary()] });

// ---- sites --------------------------------------------------------------------------------------
function listItem(s: FixtureSite): SiteListItem {
  const r = s.record;
  return {
    id: r.id,
    name: r.name,
    group: r.group,
    origin: r.origin,
    lat_deg: r.lat_deg,
    lon_deg: r.lon_deg,
    map: s.map,
    dem_source: r.dem_source,
    horizon_method: r.horizon_method,
    rank: s.rank,
    score: s.score,
    pct_sun: s.metrics.pct_sun,
    pct_earth: s.metrics.pct_earth,
    pct_both: s.metrics.pct_both,
    longest_dark_h: s.metrics.longest_dark_h,
    longest_comms_gap_h: s.metrics.longest_comms_gap_h,
  };
}

export function stubSitesResponse(group?: string): SitesResponse {
  return { ...prov, sites: SITES.filter((s) => group === undefined || s.record.group === group).map(listItem) };
}

export function stubSitesGeoJson(group?: string): SitesGeoJson {
  const features: SitesGeoJson['features'] = [];
  for (const s of SITES.filter((x) => group === undefined || x.record.group === group)) {
    const r = s.record;
    const properties = {
      site_id: r.id,
      name: r.name,
      group: r.group,
      origin: r.origin,
      rank: s.rank,
      score: s.score,
      pct_sun: s.metrics.pct_sun,
      pct_earth: s.metrics.pct_earth,
      pct_both: s.metrics.pct_both,
      dem_source: r.dem_source,
    };
    features.push({ type: 'Feature', id: r.id, geometry: { type: 'Point', coordinates: [r.lon_deg, r.lat_deg] }, properties: { kind: 'site', ...properties } });
    const corners = s.extra?.['region_corners_latlon'];
    if (Array.isArray(corners) && corners.length >= 3) {
      const ring = (corners as [number, number][]).map(([lat, lon]): [number, number] => [lon, lat]);
      const first = ring[0];
      if (first) ring.push(first);
      features.push({ type: 'Feature', id: `${r.id}#region`, geometry: { type: 'Polygon', coordinates: [ring] }, properties: { kind: 'region', ...properties } });
    }
  }
  return { type: 'FeatureCollection', run_id: RUN.run_id, features };
}

export function stubSiteDetail(siteId: string): SiteDetail {
  const s = stubSite(siteId);
  return {
    ...prov,
    site: s.record,
    extra: s.extra,
    map: s.map,
    range: timeRange({ startMs: RUN_START_MS, endMs: RUN_END_MS, n: RUN.n_samples }),
    metrics: s.metrics,
    rank: s.rank,
    score: s.score,
    warnings: siteWarnings(s.record),
  };
}

/** stride > 1 keeps every stride-th azimuth (used for compact OpenAPI examples). */
export function stubHorizon(siteId: string, stride = 1): HorizonResponse {
  stubSite(siteId);
  const h = HORIZONS[siteId];
  if (!h) throw siteNotFound(siteId);
  const pick = <T>(a: T[]): T[] => a.filter((_v, i) => i % stride === 0);
  return {
    ...prov,
    site_id: siteId,
    ...h,
    az_step_deg: h.az_step_deg * stride,
    az_deg: pick(h.az_deg),
    el_deg: pick(h.el_deg),
    covered_radius_km: pick(h.covered_radius_km),
  };
}

// ---- series / instant ---------------------------------------------------------------------------
/**
 * Stub series: the fixture holds only the first 48 h of each site; the requested range is snapped
 * and echoed, values come from the fixture hours (wrapping around) - shapes are exact, values illustrative.
 */
export function stubSeries(siteId: string, q: { start?: string | undefined; end?: string | undefined; fields: string[]; max_points: number; agg: 'sample' | 'minmax' }): SeriesResponse {
  stubSite(siteId);
  const fx = SERIES[siteId];
  if (!fx) throw siteNotFound(siteId);
  const r = stubRange(q.start, q.end);
  const factor = Math.max(1, Math.ceil(r.n / q.max_points));
  const n = Math.ceil(r.n / factor);
  const fields: SeriesResponse['fields'] = {};
  for (const name of q.fields) {
    const col = fx.columns[name] ?? [];
    const at = (k: number) => col[(r.i0 + k) % fx.n] ?? null;
    if (q.agg === 'sample') {
      const out = Array.from({ length: n }, (_v, b) => at(b * factor));
      fields[name] = out as number[];
    } else {
      const min: (number | null)[] = [];
      const max: (number | null)[] = [];
      for (let b = 0; b < n; b++) {
        const vals: number[] = [];
        for (let k = b * factor; k < Math.min(r.n, (b + 1) * factor); k++) {
          const v = at(k);
          if (typeof v === 'number') vals.push(v);
          else if (typeof v === 'boolean') vals.push(v ? 1 : 0);
        }
        if (typeof at(b * factor) === 'boolean') {
          const frac = vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null;
          min.push(frac);
          max.push(frac);
        } else {
          min.push(vals.length ? Math.min(...vals) : null);
          max.push(vals.length ? Math.max(...vals) : null);
        }
      }
      fields[name] = { min, max };
    }
  }
  return { ...prov, site_id: siteId, start: toIsoUtc(r.startMs), end: toIsoUtc(r.endMs), bin_s: STEP_S * factor, n, agg: q.agg, fields };
}

export function stubInstant(siteId: string, t: string): InstantResponse {
  stubSite(siteId);
  const fx = SERIES[siteId];
  if (!fx) throw siteNotFound(siteId);
  const tMs = parseIsoUtc(t);
  const k = sampleIndex(tMs, RUN_START_MS, STEP_S);
  if (k < 0 || k >= RUN.n_samples) {
    throw new ApiError('OUT_OF_RANGE', `t ${toIsoUtc(tMs)} is outside the run [${RUN.start_utc}, ${RUN.end_utc})`, {
      errors: [{ path: 't', in: 'querystring', message: `must be in [${RUN.start_utc}, ${RUN.end_utc})` }],
    });
  }
  const c = (name: string): number | boolean | null => fx.columns[name]?.[k % fx.n] ?? null;
  const num = (name: string): number => Number(c(name) ?? 0);
  const numOrNull = (name: string): number | null => {
    const v = c(name);
    return typeof v === 'number' ? v : null;
  };
  return {
    ...prov,
    site_id: siteId,
    t: toIsoUtc(tMs),
    sample_utc: toIsoUtc(RUN_START_MS + k * STEP_S * 1000),
    sun: {
      az_deg: num('sun_az_deg'),
      el_deg: num('sun_el_deg'),
      horizon_el_deg: num('horizon_el_sun_deg'),
      clearance_deg: num('sun_clearance_deg'),
      fraction: num('sun_fraction'),
      visible: c('sun_visible') === true,
      power_horizontal: num('power_horizontal'),
      power_tracking: num('power_tracking'),
      irradiance_tracking_wm2: num('irradiance_tracking_wm2'),
      dist_km: num('sun_dist_km'),
    },
    earth: {
      az_deg: num('earth_az_deg'),
      el_deg: num('earth_el_deg'),
      horizon_el_deg: num('horizon_el_earth_deg'),
      clearance_deg: num('earth_clearance_deg'),
      fraction: num('earth_fraction'),
      visible: c('earth_visible') === true,
      dist_km: num('earth_dist_km'),
    },
    both_visible: c('both_visible') === true,
    hours_until: {
      sunset: numOrNull('hours_until_sunset'),
      sunrise: numOrNull('hours_until_sunrise'),
      earthset: numOrNull('hours_until_earthset'),
      earthrise: numOrNull('hours_until_earthrise'),
    },
  };
}

// ---- windows ------------------------------------------------------------------------------------
function clipWindows(list: FixtureWindow[], startMs: number, endMs: number): ClippedWindow[] {
  const out: ClippedWindow[] = [];
  for (const w of list) {
    const ws = parseIsoUtc(w.start);
    const we = parseIsoUtc(w.end);
    if (!(ws < endMs && we > startMs)) continue;
    const s = Math.max(ws, startMs);
    const e = Math.min(we, endMs);
    out.push({
      start: toIsoUtc(s),
      end: toIsoUtc(e),
      duration_h: (e - s) / 3_600_000,
      state: w.state,
      truncated_start: w.truncated_start,
      truncated_end: w.truncated_end,
      clipped_start: s > ws,
      clipped_end: e < we,
    });
  }
  return out;
}

export function stubWindowsByKind(siteId: string, kinds: readonly WindowKind[], startMs: number, endMs: number): Partial<Record<WindowKind, ClippedWindow[]>> {
  stubSite(siteId);
  const fx = WINDOWS[siteId];
  if (!fx) throw siteNotFound(siteId);
  const out: Partial<Record<WindowKind, ClippedWindow[]>> = {};
  for (const k of kinds) out[k] = clipWindows(fx[k], startMs, endMs);
  return out;
}

export function stubWindows(siteId: string, q: { start?: string | undefined; end?: string | undefined; kinds: WindowKind[] }): WindowsResponse {
  const r = stubRange(q.start, q.end);
  return { ...prov, site_id: siteId, start: toIsoUtc(r.startMs), end: toIsoUtc(r.endMs), ...stubWindowsByKind(siteId, q.kinds, r.startMs, r.endMs) };
}

// ---- ranking / compare (full-run metrics in the stub; real code recomputes per range) ------------
/** Ranks fixture sites with the REAL ranking code (src/routes/a/ranking.ts). */
const rankSites = (sites: readonly FixtureSite[], weights: RankWeights) =>
  rankInputs(sites.map((x): RankInput => ({ site_id: x.record.id, name: x.record.name, group: x.record.group, metrics: x.metrics })), weights);

export function stubRanking(q: { group?: string | undefined; start?: string | undefined; end?: string | undefined; weights?: RankWeights | undefined }): RankingResponse {
  const r = stubRange(q.start, q.end);
  const weights = normalizeWeights(q.weights);
  const full = r.startMs === RUN_START_MS && r.endMs === RUN_END_MS;
  const sites = SITES.filter((s) => q.group === undefined || s.record.group === q.group);
  return { ...prov, range: timeRange(r), weights, source: full && sameWeights(weights, DEFAULT_RANK_WEIGHTS) ? 'summary' : 'computed', ranking: rankSites(sites, weights) };
}

export function stubCompare(body: CompareRequest): CompareResponse {
  stubRun(body.run_id);
  const sites = body.site_ids.map(stubSite);
  const r = stubRange(body.start, body.end);
  const weights = normalizeWeights(body.weights);
  const out: CompareResponse['sites'] = {};
  for (const s of sites) {
    const id = s.record.id;
    const entry: CompareResponse['sites'][string] = { metrics: s.metrics, warnings: siteWarnings(s.record) };
    if (body.include?.windows) entry.windows = stubWindowsByKind(id, body.include.windows, r.startMs, r.endMs);
    if (body.include?.series) {
      const { run_id: _r, precision_h: _p, site_id: _id, ...block } = stubSeries(id, {
        start: toIsoUtc(r.startMs),
        end: toIsoUtc(r.endMs),
        fields: body.include.series.fields,
        max_points: body.include.series.max_points,
        agg: body.include.series.agg,
      });
      entry.series = block;
    }
    out[id] = entry;
  }
  return { ...prov, range: timeRange(r), weights, ranking: rankSites(sites, weights), sites: out };
}

// ---- alt-dates ----------------------------------------------------------------------------------
export function stubAltDates(body: AltDatesRequest): AltDatesResponse {
  stubRun(body.run_id);
  stubSite(body.site_id);
  return {
    ...prov,
    cache_id: 'c5d0a3f1e2b4c6d8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d',
    ...ALT.result,
    site_id: body.site_id,
    constraints: body.constraints,
    candidates: ALT.result.candidates.slice(0, body.max_results),
  };
}

// ---- jobs ---------------------------------------------------------------------------------------
export const STUB_JOB_ID = 'j_7f3k2m9q4x1z';
const CUSTOM_SITE = 'custom:-89.4500:222.6900';

export function stubJob(status: JobStatus, jobId = STUB_JOB_ID): Job {
  const done = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  return {
    job_id: jobId,
    type: 'custom_site',
    status,
    site_id: CUSTOM_SITE,
    params: {
      type: 'custom_site',
      lat_deg: -89.45,
      lon_deg: 222.69,
      name: 'My ridge',
      start: '2026-01-01T00:00:00Z',
      end: '2026-02-01T00:00:00Z',
      step_min: 60,
      provider: 'spice',
      dem: 'pgda',
      horizon_method: 'raymarch',
      observer_height_m: 2,
    },
    progress: {
      stage: status === 'queued' ? 'queued' : status === 'running' ? 'precompute' : 'done',
      pct: null,
      lines: status === 'queued' ? [] : [`[1/1] ${CUSTOM_SITE}: horizon raymarch (pgda)`, `[1/1] ${CUSTOM_SITE}: ephemeris spice 744 samples`],
    },
    result: status === 'succeeded' ? { run_id: `job_${jobId}`, site_id: CUSTOM_SITE } : null,
    output: null,
    artifacts: [],
    clients: done ? 0 : 1,
    error: status === 'failed' ? { code: 'PYTHON_FAILED', message: 'lunarnav precompute exited with code 1' } : null,
    created_at: '2026-11-14T10:00:00Z',
    started_at: status === 'queued' ? null : '2026-11-14T10:00:01Z',
    finished_at: done ? '2026-11-14T10:03:12Z' : null,
    expires_at: status === 'succeeded' ? '2026-12-14T10:03:12Z' : null,
  };
}

export function stubJobAccepted(body: CustomSiteJobRequest): JobAccepted {
  const siteId = body.site_id ?? customSiteId(body.lat_deg ?? 0, body.lon_deg ?? 0);
  return { job_id: STUB_JOB_ID, type: 'custom_site', status: 'queued', site_id: siteId, poll: `/api/v1/jobs/${STUB_JOB_ID}`, cached: false };
}

// ---- OpenAPI examples (keep these when the stubs go away) ----------------------------------------
export const exampleRunsResponse = stubRunsResponse;
export const exampleRunDetail = (): RunDetail => RUN;
export const exampleSitesResponse = (): SitesResponse => ({ ...stubSitesResponse(), sites: stubSitesResponse().sites.slice(0, 2) });
export const exampleSitesGeoJson = (): SitesGeoJson => ({ ...stubSitesGeoJson('south_pole'), features: stubSitesGeoJson('south_pole').features.slice(0, 2) });
export const exampleSiteDetail = (): SiteDetail => stubSiteDetail(STUB_FOCUS_SITE);
export const exampleHorizon = (stride: number): HorizonResponse => stubHorizon(STUB_FOCUS_SITE, stride);
export const exampleSeries = (): SeriesResponse =>
  stubSeries(STUB_FOCUS_SITE, { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', fields: ['sun_el_deg', 'earth_el_deg', 'sun_visible', 'earth_visible'], max_points: 2000, agg: 'sample' });
export const exampleInstant = (): InstantResponse => stubInstant(STUB_FOCUS_SITE, '2026-01-01T05:30:00Z');
export const exampleWindows = (): WindowsResponse => stubWindows(STUB_FOCUS_SITE, { start: '2026-03-01T00:00:00Z', end: '2026-04-01T00:00:00Z', kinds: ['sun', 'earth'] });
export const exampleRankingResponse = (): RankingResponse => stubRanking({});
export const exampleCompareRequest = (): CompareRequest => ({
  site_ids: ['ref_connecting_ridge_c1', 'a3_haworth', 'apollo11'],
  start: '2026-01-01T00:00:00Z',
  end: '2026-04-01T00:00:00Z',
  weights: { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 },
  include: { windows: ['sun'] },
});
export const exampleCompareResponse = (): CompareResponse => stubCompare({ site_ids: ['ref_connecting_ridge_c1', 'apollo11'], include: { windows: ['sun'] } });
export const exampleAltDatesRequest = (): AltDatesRequest => ({ site_id: STUB_FOCUS_SITE, ...ALT.request });
export const exampleAltDatesResponse = (): AltDatesResponse => stubAltDates(exampleAltDatesRequest());
export const exampleJobRequest = (): CustomSiteJobRequest => ({
  type: 'custom_site',
  lat_deg: -89.45,
  lon_deg: 222.69,
  name: 'My ridge',
  start: '2026-01-01T00:00:00Z',
  end: '2026-02-01T00:00:00Z',
  step_min: 60,
  provider: 'spice',
  dem: 'pgda',
  horizon_method: 'raymarch',
  observer_height_m: 2,
});
export const exampleJobAccepted = (): JobAccepted => stubJobAccepted(exampleJobRequest());
/** 200 of POST /jobs: an identical job already succeeded (cache hit). */
export const exampleJobCached = (): JobAccepted => ({ ...stubJobAccepted(exampleJobRequest()), status: 'succeeded', cached: true });
export const exampleJob = (status: JobStatus): Job => stubJob(status);
