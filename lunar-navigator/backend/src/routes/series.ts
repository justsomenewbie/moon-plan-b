/**
 * Time series (plan 6.2 #7), instant readout (#9) and sky diagram data - contract: src/contract/series.ts.
 *   GET /api/v1/sites/{site_id}/series    columnar, downsampled, + exact transition events
 *   GET /api/v1/sites/{site_id}/instant   readout at one instant (+ time until sunset/sunrise/earthset/earthrise)
 *   GET /api/v1/sites/{site_id}/sky       Sun / Earth az-el tracks (event-preserving decimation) + horizon silhouette
 * Data: `series` time-series collection, `windows`, `horizons` (plan 5.3 / 5.4) via src/repos/index.ts.
 *
 * Event-preserving downsampling (documented in the contract descriptions too):
 *   series: regular bins of bin_s = ceil(n / max_points) * step_s aligned on the snapped start.
 *     agg=sample -> first sample of each bin; agg=minmax -> per-bin min/max of numbers (extremes kept),
 *     booleans -> fraction true. Either way `events` lists every window boundary inside the range
 *     (from the windows collection = the Python windows.json, exact to +- one step), so a short window
 *     hidden inside one bin is never lost.
 *   sky: irregular decimation (decimateTrack): bucket first + argmin/argmax elevation, last sample, and
 *     both samples around every visibility transition.
 *
 * Shared helpers of route group B (range snapping, site check, cache headers) are exported from here
 * and reused by routes/windows.ts and routes/export.ts.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply } from 'fastify';
import { SiteParams, WINDOW_KINDS, type WindowKind } from '../contract/common.ts';
import {
  BOOLEAN_SERIES_FIELDS,
  InstantQuery,
  InstantResponse,
  SeriesQuery,
  SeriesResponse,
  SkyQuery,
  SkyResponse,
  eventKindOfField,
  nextEventFromColumn,
  type SeriesEvent,
  type SeriesFieldName,
  type SkyTrack,
} from '../contract/series.ts';
import { ApiError, problemResponses, siteNotFound } from '../lib/problem.ts';
import { provenanceOf } from '../lib/provenance.ts';
import { cacheControlFor } from './a/http_cache.ts';
import { MS_PER_S, parseIsoUtc, parseIsoUtcCeil, sampleIndex, snapRange, toIsoUtc, type SnappedRange } from '../lib/time.ts';
import {
  chooseBinS,
  getHorizon,
  getSample,
  getSeries,
  getSite,
  getWindows,
  resolveRun,
  streamSeries,
  type MinMaxColumn,
  type RunDoc,
  type SeriesSample,
  type SeriesValue,
  type SiteView,
  type WindowDoc,
} from '../repos/index.ts';

// =================================================================================================
// shared helpers (route group B)
// =================================================================================================


/** Parse a query instant; impossible dates (2026-02-30T...) -> 400 VALIDATION_ERROR on that parameter. */
export function parseQueryInstant(value: string, param: string, round: 'down' | 'up' = 'down'): number {
  const fail = (message: string): never => {
    throw new ApiError('VALIDATION_ERROR', `${param}: ${message}`, { errors: [{ path: param, in: 'querystring', message, code: 'invalid_date' }] });
  };
  let ms = Number.NaN;
  try {
    // full ms precision: an end of 15:00:00.500Z must snap UP to the next sample, not be truncated to 15:00:00 first
    ms = parseIsoUtc(value);
  } catch (e) {
    fail(e instanceof Error ? e.message : 'invalid instant');
  }
  // Date.parse is lenient (2026-02-30 -> 2026-03-02): require the calendar fields to round-trip.
  if (toIsoUtc(ms) !== `${value.slice(0, 19)}Z`) fail(`not a valid calendar date/time: ${value}`);
  // 'up' (end bounds): a remainder below 1 ms (15:00:00.000001Z) counts too - Date.parse keeps only 3 digits
  return round === 'up' ? parseIsoUtcCeil(value) : ms;
}

/**
 * Snap the requested [start, end) (defaults = run range) to the run grid and clamp it to the run:
 * start snaps DOWN, end snaps UP (the requested instants are always covered).
 * end <= start, or no overlap with the run -> 422 OUT_OF_RANGE (with the run range as extensions).
 */
export function resolveRange(run: RunDoc, start: string | undefined, end: string | undefined): SnappedRange {
  const runStart = run.start.getTime();
  const runEnd = run.end.getTime();
  const s = start === undefined ? runStart : parseQueryInstant(start, 'start');
  const e = end === undefined ? runEnd : parseQueryInstant(end, 'end', 'up');
  const extensions = { run_start_utc: toIsoUtc(runStart), run_end_utc: toIsoUtc(runEnd) };
  if (e <= s) {
    throw new ApiError('OUT_OF_RANGE', `end ${toIsoUtc(e)} must be after start ${toIsoUtc(s)}`, {
      errors: [{ path: 'end', in: 'querystring', message: 'must be after start' }],
      extensions,
    });
  }
  const r = snapRange(s, e, runStart, runEnd, run.step_s);
  if (!r) {
    throw new ApiError('OUT_OF_RANGE', `range [${toIsoUtc(s)}, ${toIsoUtc(e)}) does not overlap the run [${extensions.run_start_utc}, ${extensions.run_end_utc})`, {
      extensions,
      hint: 'omit start/end to get the whole run',
    });
  }
  return r;
}

/** The site as part of the run, or 404 SITE_NOT_FOUND. */
export async function requireSite(runId: string, siteId: string): Promise<SiteView> {
  const view = await getSite(runId, siteId);
  if (!view) throw siteNotFound(siteId);
  return view;
}

/**
 * Precompute data is immutable per run id: cache it when the client named the run explicitly.
 * Without run_id the default run may change -> short cache.
 */
export function setCacheHeaders(reply: FastifyReply, explicitRunId: string | undefined): void {
  reply.header('cache-control', cacheControlFor(explicitRunId));
}

/** Window boundaries strictly inside (startMs, endMs) as events, sorted by t then kind (sun, earth, both). */
export function windowEvents(byKind: Partial<Record<WindowKind, WindowDoc[]>>, startMs: number, endMs: number): SeriesEvent[] {
  const out: { ms: number; order: number; ev: SeriesEvent }[] = [];
  for (const [order, kind] of WINDOW_KINDS.entries()) {
    for (const w of byKind[kind] ?? []) {
      const ms = w.start.getTime();
      if (ms > startMs && ms < endMs) out.push({ ms, order, ev: { t: toIsoUtc(ms), kind, state: w.state } });
    }
  }
  out.sort((a, b) => a.ms - b.ms || a.order - b.order);
  return out.map((x) => x.ev);
}

// =================================================================================================
// series
// =================================================================================================

type WireValues = SeriesResponse['fields'][string];

/** Repo columns -> wire columns. Boolean minmax (fraction true) is sent as {min, max} with equal values. */
function toWireColumn(field: SeriesFieldName, col: SeriesValue[] | MinMaxColumn, agg: 'sample' | 'minmax'): WireValues {
  if (!Array.isArray(col)) return col;
  const isBool = BOOLEAN_SERIES_FIELDS.has(field);
  if (agg === 'minmax') {
    const frac = col.map((v) => (typeof v === 'number' ? v : null));
    return { min: frac, max: [...frac] };
  }
  if (isBool) return col.map((v) => (typeof v === 'boolean' ? v : null));
  return col.map((v) => (typeof v === 'number' ? v : null));
}

// =================================================================================================
// sky diagram decimation
// =================================================================================================

export interface DecimatedTrack {
  /** Kept sample indices, strictly increasing. */
  indices: number[];
  decimated: boolean;
  n_transitions: number;
}

/**
 * Event-preserving decimation of a body track (see SkyTrack description in the contract):
 * n <= maxPoints -> all samples. Else buckets of b = ceil(3n / (maxPoints - 4)) samples keep their
 * first sample + argmin/argmax elevation; the last sample is kept; for every transition
 * visible[i] != visible[i-1] both i-1 and i are kept. Result size <= maxPoints + 2 * n_transitions.
 */
export function decimateTrack(el: readonly number[], visible: readonly boolean[], maxPoints: number): DecimatedTrack {
  const n = el.length;
  let nTransitions = 0;
  for (let i = 1; i < n; i++) if (visible[i] !== visible[i - 1]) nTransitions++;
  if (n <= maxPoints) return { indices: Array.from({ length: n }, (_v, i) => i), decimated: false, n_transitions: nTransitions };
  const keep = new Uint8Array(n);
  const b = Math.ceil((3 * n) / Math.max(1, maxPoints - 4));
  for (let s = 0; s < n; s += b) {
    const e = Math.min(n, s + b);
    let iMin = s;
    let iMax = s;
    for (let i = s + 1; i < e; i++) {
      const v = el[i] ?? 0;
      if (v < (el[iMin] ?? 0)) iMin = i;
      if (v > (el[iMax] ?? 0)) iMax = i;
    }
    keep[s] = 1;
    keep[iMin] = 1;
    keep[iMax] = 1;
  }
  keep[n - 1] = 1;
  for (let i = 1; i < n; i++) {
    if (visible[i] !== visible[i - 1]) {
      keep[i - 1] = 1;
      keep[i] = 1;
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) indices.push(i);
  return { indices, decimated: true, n_transitions: nTransitions };
}

interface RawTrack {
  tMs: number[];
  az: number[];
  el: number[];
  vis: boolean[];
}

function buildTrack(raw: RawTrack, maxPoints: number): SkyTrack {
  const d = decimateTrack(raw.el, raw.vis, maxPoints);
  const pick = <T>(a: readonly T[]): T[] => d.indices.map((i) => a[i] as T);
  return {
    t: d.indices.map((i) => toIsoUtc(raw.tMs[i] ?? 0)),
    az_deg: pick(raw.az),
    el_deg: pick(raw.el),
    visible: pick(raw.vis),
    decimated: d.decimated,
    n_transitions: d.n_transitions,
  };
}

// =================================================================================================
// instant helpers
// =================================================================================================

function requireNumber(sample: Partial<SeriesSample>, field: SeriesFieldName): number {
  const v = sample[field];
  if (typeof v !== 'number') throw new ApiError('INTERNAL', `stored sample has no numeric ${field}`);
  return v;
}
const numberOrNull = (v: SeriesValue | undefined): number | null => (typeof v === 'number' ? v : null);

// =================================================================================================
// routes
// =================================================================================================

export const seriesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/sites/:site_id/series',
    {
      schema: {
        tags: ['series'],
        operationId: 'getSiteSeries',
        summary: 'Columnar time series (timeline curves) with exact transition events',
        description:
          'Point i is at start + i*bin_s. If the range has more samples than max_points the server bins them (bin_s = ceil(n / max_points) * step_s), ' +
          'see `agg`; exact window boundaries inside the range are always listed in `events`. Range partly outside the run -> clamped ' +
          '(the snapped range actually used is echoed); no overlap -> 422 OUT_OF_RANGE. More than 8 fields or max_points > 5000 -> 400 TOO_MANY_POINTS.',
        params: SiteParams,
        querystring: SeriesQuery,
        response: { 200: SeriesResponse, ...problemResponses(400, 404, 409, 422, 503) },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const siteId = req.params.site_id;
      const run = await resolveRun(q.run_id);
      const r = resolveRange(run, q.start, q.end);
      const fields = [...new Set(q.fields)];
      await requireSite(run._id, siteId);
      const binS = chooseBinS(r.n, run.step_s, q.max_points);
      const kinds = WINDOW_KINDS.filter((k) => fields.some((f) => eventKindOfField(f) === k));
      const [cols, wins] = await Promise.all([
        getSeries(siteId, run, r.startMs, r.endMs, fields, { bin_s: binS, agg: q.agg }),
        kinds.length > 0 ? getWindows(run._id, siteId, { fromMs: r.startMs, toMs: r.endMs, kinds }) : Promise.resolve({}),
      ]);
      const outFields: SeriesResponse['fields'] = {};
      for (const f of fields) {
        const c = cols.fields[f];
        if (c !== undefined) outFields[f] = toWireColumn(f, c, q.agg);
      }
      setCacheHeaders(reply, q.run_id);
      return {
        ...provenanceOf(run),
        site_id: siteId,
        start: toIsoUtc(r.startMs),
        end: toIsoUtc(r.endMs),
        bin_s: cols.bin_s,
        n: cols.n,
        agg: q.agg,
        fields: outFields,
        events: windowEvents(wins, r.startMs, r.endMs),
      };
    },
  );

  app.get(
    '/sites/:site_id/instant',
    {
      schema: {
        tags: ['series'],
        operationId: 'getSiteInstant',
        summary: 'Readout at one instant (timeline slider): az/el, flags, time until sunset / sunrise / earthset / earthrise',
        description:
          'Reads the sample k containing t (sample_utc <= t < sample_utc + step_s). `hours_until` = the precomputed columns of that sample ' +
          '(lunarnav.windows.hours_until_state, measured from sample_utc); `next_events` = the same events measured from t ' +
          '(lunarnav.windows.time_until_sunset / next_sunrise / time_until_earthset / next_earthrise). t outside the run -> 422 OUT_OF_RANGE.',
        params: SiteParams,
        querystring: InstantQuery,
        response: { 200: InstantResponse, ...problemResponses(400, 404, 409, 422, 503) },
      },
    },
    async (req, reply) => {
      const siteId = req.params.site_id;
      const run = await resolveRun(req.query.run_id);
      const tMs = parseQueryInstant(req.query.t, 't');
      const runStart = run.start.getTime();
      const runEnd = run.end.getTime();
      const k = sampleIndex(tMs, runStart, run.step_s);
      if (k < 0 || k >= run.n_samples || tMs >= runEnd) {
        throw new ApiError('OUT_OF_RANGE', `t ${toIsoUtc(tMs)} is outside the run [${toIsoUtc(runStart)}, ${toIsoUtc(runEnd)})`, {
          errors: [{ path: 't', in: 'querystring', message: `must be in [${toIsoUtc(runStart)}, ${toIsoUtc(runEnd)})` }],
          extensions: { run_start_utc: toIsoUtc(runStart), run_end_utc: toIsoUtc(runEnd) },
        });
      }
      const sampleMs = runStart + k * run.step_s * MS_PER_S;
      const [site, s] = await Promise.all([getSite(run._id, siteId), getSample(siteId, run, sampleMs)]);
      if (!site) throw siteNotFound(siteId);
      if (!s) throw new ApiError('INTERNAL', `run ${run._id} has no stored sample for ${siteId} at ${toIsoUtc(sampleMs)} (incomplete import?)`);
      const sunVis = s.sun_visible === true;
      const earthVis = s.earth_visible === true;
      const hu = {
        sunset: numberOrNull(s.hours_until_sunset),
        sunrise: numberOrNull(s.hours_until_sunrise),
        earthset: numberOrNull(s.hours_until_earthset),
        earthrise: numberOrNull(s.hours_until_earthrise),
      };
      const ev = (now: boolean, target: boolean, h: number | null) => nextEventFromColumn(tMs, sampleMs, runEnd, now, target, h);
      setCacheHeaders(reply, req.query.run_id);
      return {
        ...provenanceOf(run),
        site_id: siteId,
        t: toIsoUtc(tMs),
        sample_utc: toIsoUtc(sampleMs),
        sample_index: k,
        sun: {
          az_deg: requireNumber(s, 'sun_az_deg'),
          el_deg: requireNumber(s, 'sun_el_deg'),
          horizon_el_deg: requireNumber(s, 'horizon_el_sun_deg'),
          clearance_deg: requireNumber(s, 'sun_clearance_deg'),
          fraction: requireNumber(s, 'sun_fraction'),
          visible: sunVis,
          power_horizontal: requireNumber(s, 'power_horizontal'),
          power_tracking: requireNumber(s, 'power_tracking'),
          irradiance_tracking_wm2: requireNumber(s, 'irradiance_tracking_wm2'),
          dist_km: requireNumber(s, 'sun_dist_km'),
        },
        earth: {
          az_deg: requireNumber(s, 'earth_az_deg'),
          el_deg: requireNumber(s, 'earth_el_deg'),
          horizon_el_deg: requireNumber(s, 'horizon_el_earth_deg'),
          clearance_deg: requireNumber(s, 'earth_clearance_deg'),
          fraction: requireNumber(s, 'earth_fraction'),
          visible: earthVis,
          dist_km: requireNumber(s, 'earth_dist_km'),
        },
        both_visible: s.both_visible === true,
        hours_until: hu,
        next_events: {
          sunset: ev(sunVis, false, hu.sunset),
          sunrise: ev(sunVis, true, hu.sunrise),
          earthset: ev(earthVis, false, hu.earthset),
          earthrise: ev(earthVis, true, hu.earthrise),
        },
      };
    },
  );

  app.get(
    '/sites/:site_id/sky',
    {
      schema: {
        tags: ['series'],
        operationId: 'getSiteSky',
        summary: 'Sky diagram data: Sun and Earth az/el tracks + terrain horizon silhouette',
        description:
          'Tracks are decimated to about max_points points each while keeping elevation extremes and both samples around every ' +
          'visibility transition (see SkyTrack). The horizon is the full-resolution silhouette of the run. Range rules as /series.',
        params: SiteParams,
        querystring: SkyQuery,
        response: { 200: SkyResponse, ...problemResponses(400, 404, 409, 422, 503) },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const siteId = req.params.site_id;
      const run = await resolveRun(q.run_id);
      const r = resolveRange(run, q.start, q.end);
      const [, horizon] = await Promise.all([requireSite(run._id, siteId), getHorizon(run._id, siteId)]);
      if (!horizon) throw new ApiError('INTERNAL', `run ${run._id} has no horizon for ${siteId} (incomplete import?)`);
      const sun: RawTrack = { tMs: [], az: [], el: [], vis: [] };
      const earth: RawTrack = { tMs: [], az: [], el: [], vis: [] };
      const fields = ['sun_az_deg', 'sun_el_deg', 'sun_visible', 'earth_az_deg', 'earth_el_deg', 'earth_visible'] as const;
      for await (const row of streamSeries(siteId, run, r.startMs, r.endMs, fields)) {
        const ms = row.t.getTime();
        sun.tMs.push(ms);
        sun.az.push(numberOrNull(row.sun_az_deg) ?? 0);
        sun.el.push(numberOrNull(row.sun_el_deg) ?? 0);
        sun.vis.push(row.sun_visible === true);
        earth.tMs.push(ms);
        earth.az.push(numberOrNull(row.earth_az_deg) ?? 0);
        earth.el.push(numberOrNull(row.earth_el_deg) ?? 0);
        earth.vis.push(row.earth_visible === true);
      }
      setCacheHeaders(reply, q.run_id);
      return {
        ...provenanceOf(run),
        site_id: siteId,
        start: toIsoUtc(r.startMs),
        end: toIsoUtc(r.endMs),
        n_samples: sun.tMs.length,
        horizon: {
          method: horizon.method,
          dem_source: horizon.dem_source,
          az_step_deg: horizon.az_step_deg,
          az_deg: horizon.az_deg,
          el_deg: horizon.el_deg,
          min_el_deg: horizon.min_el_deg,
          max_el_deg: horizon.max_el_deg,
        },
        sun: buildTrack(sun, q.max_points),
        earth: buildTrack(earth, q.max_points),
      };
    },
  );
};

export default seriesRoutes;
