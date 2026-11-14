/**
 * GET /api/v1/dataset - the FE comparison page in ONE call (contract: src/contract/dataset.ts).
 *
 * Per site, from the stored run (repos/index.ts):
 *   horizon  <- `horizons` resampled to horizon_step_deg (dataset_build.resampleHorizon)
 *   series   <- `series` at full resolution, decimated keeping every visibility transition
 *   windows / metrics / criteria <- `windows` (= Python windows.json) clipped to the range, so the
 *            whole-run metrics equal summary.csv and the windows equal windows.json exactly;
 *            metrics.mean_power_*_pct <- one seriesSums() $group over the range (all sites)
 *   now (include=pointing)  <- the stored sample at range.start, re-stated by buildPointing (as /pointing)
 *   survival_hint           <- the clipped sun windows + the energy model (dataset_build.survivalHint)
 * Payload guard (series points of all sites <= DATASET_LIMITS.max_total_points, else 422), in 3 steps:
 *   1. before any read: regular samples only (estimatePoints) -> cheap reject of obviously big requests;
 *   2. after the windows are loaded, before the series is read: the EXACT count per site, transition
 *      samples included (planSeriesPoints = decimateSeries on the window-derived flags);
 *   3. after decimation: the real count (safety net for series with gaps).
 * Caching: weak ETag of (schema version, run identity, canonical selection) + cacheControlFor().
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { WINDOW_KINDS, type WindowKind } from '../contract/common.ts';
import {
  DATASET_EVIDENCE,
  DATASET_INCLUDE,
  DATASET_LIMITS,
  DATASET_SCHEMA_VERSION,
  DatasetQuery,
  DatasetResponse,
  type DatasetSeries,
  type DatasetSite,
} from '../contract/dataset.ts';
import { ApiError, problemResponses, siteNotFound } from '../lib/problem.ts';
import { MS_PER_S, parseIsoUtc, parseIsoUtcCeil, snapDown, snapUp, toIsoUtc } from '../lib/time.ts';
import { getHorizon, getSample, getSites, getWindows, resolveRun, seriesSums, streamSeries, type RunDoc, type SeriesSums, type SiteView } from '../repos/index.ts';
import { buildPointing } from '../contract/pointing.ts';
import { applyCache, cacheControlFor, notModified, notModifiedResponse, weakEtag } from './a/http_cache.ts';
import {
  TooManyTransitionsError,
  clipSpans,
  coveredSamples,
  decimateSeries,
  estimatePoints,
  evaluateCriteria,
  meanPowerPct,
  planSeriesPoints,
  rangeMetrics,
  resampleHorizon,
  shortHash,
  sourcesOf,
  survivalHint,
  survivalHintAssumptions,
  visibleWindows,
  type ClippedSpan,
} from './dataset_build.ts';
import { pointingAssumptionsOf, readingFromSample, runTerrainModelled, siteTerrainModelled } from './pointing.ts';

/**
 * Bumped when the response for the SAME selection changes (2 = metrics.mean_power_*_pct added; 3 = pointing /
 * survival_hint prose: partly visible Sun, lean forward, flat horizon, never-lit range), so a cached body
 * with the old fields / wording is not revalidated by a 304. Not part of dataset_id.
 */
const DATASET_ETAG_REVISION = '3';

/** Run-level pointing assumptions + a note naming the sites whose horizon has no terrain model when the run does. */
function datasetPointingAssumptions(run: RunDoc, views: readonly SiteView[]): string[] {
  const terrain = runTerrainModelled(run);
  const out = pointingAssumptionsOf(run, terrain);
  const flat = views.filter((v) => !siteTerrainModelled(v.site_run.record)).map((v) => v.site_run.site_id);
  if (terrain && flat.length > 0) {
    out.push(`No terrain model for ${flat.join(', ')} (flat horizon / dem_source none, e.g. outside the DEM coverage): for these sites "visible" means above an ideal flat horizon and their summaries say "horizon", not "terrain".`);
  }
  return out;
}

/** Identity of a run's imported content (same as routes/runs.ts runVersion; copied to keep this module self-contained). */
const runVersion = (r: RunDoc): string => `${r._id}|${r.manifest_sha256}|${r.status}|${r.imported_at?.getTime() ?? ''}`;

interface DatasetRangeSel {
  startMs: number;
  endMs: number;
  n: number;
  reqStartMs: number;
  reqEndMs: number;
  nRequested: number;
}

/** Requested [start, end) snapped to the run grid (start down, end up), then clamped to the run. */
function resolveDatasetRange(run: RunDoc, start: string | undefined, end: string | undefined): DatasetRangeSel {
  const runStart = run.start.getTime();
  const runEnd = run.end.getTime();
  const stepMs = run.step_s * MS_PER_S;
  // Keep sub-second digits: end=15:00:00.500Z must snap UP to 16:00 (it used to be truncated to 15:00:00 first,
  // which dropped the last sample - FE report 14/11). start snaps down either way.
  // end is rounded UP even below 1 ms (Date.parse keeps only 3 fractional digits)
  const s = start === undefined ? runStart : parseIsoUtc(start);
  const e = end === undefined ? runEnd : parseIsoUtcCeil(end);
  const extensions = { run_start_utc: toIsoUtc(runStart), run_end_utc: toIsoUtc(runEnd) };
  if (e <= s) {
    throw new ApiError('OUT_OF_RANGE', `end ${toIsoUtc(e)} must be after start ${toIsoUtc(s)}`, {
      errors: [{ path: 'end', in: 'querystring', message: 'must be after start' }],
      extensions,
    });
  }
  const reqStartMs = snapDown(s, runStart, run.step_s);
  const reqEndMs = snapUp(e, runStart, run.step_s);
  const startMs = Math.max(reqStartMs, runStart);
  const endMs = Math.min(reqEndMs, runEnd);
  if (endMs <= startMs) {
    throw new ApiError('OUT_OF_RANGE', `range [${toIsoUtc(s)}, ${toIsoUtc(e)}) does not overlap the run [${extensions.run_start_utc}, ${extensions.run_end_utc})`, {
      errors: [{ path: s >= runEnd ? 'start' : 'end', in: 'querystring', message: `must overlap [${extensions.run_start_utc}, ${extensions.run_end_utc})` }],
      extensions,
      hint: 'omit start/end to get the whole run',
    });
  }
  return {
    startMs,
    endMs,
    n: Math.round((endMs - startMs) / stepMs),
    reqStartMs,
    reqEndMs,
    nRequested: Math.round((reqEndMs - reqStartMs) / stepMs),
  };
}

function modelOf(run: RunDoc): DatasetResponse['model'] {
  const stepH = run.step_s / 3600;
  const clr = run.min_earth_clearance_deg;
  return {
    id: 'lunarnav-terrain-horizon-v1',
    label: 'Terrain horizon · Sun upper limb · Earth centre',
    definition:
      `Sun visible = the upper limb of the solar disc is above the local terrain horizon. ` +
      `Earth visible = the centre of the Earth is more than ${clr}° above the terrain horizon (direct-to-Earth line of sight). ` +
      `The observer is a ${run.observer_height_m} m mast above the surface. Sun and Earth positions come from ${run.provider} ephemerides ` +
      `in the MOON_ME frame; the horizon comes from the ${run.dem} terrain model (${run.horizon_method} method); the Moon is airless (no refraction).`,
    limits: [
      `Samples every ${stepH} h: each rise or set time is accurate to +-${stepH} h, and an event shorter than one step can be missed.`,
      'The terrain horizon comes from a digital elevation model of finite resolution and radius; rocks and relief smaller than its pixels are not modelled.',
      'Visibility is geometric only: no power-system, thermal, antenna pattern or radio link-budget model, and no relay satellites.',
      'Not a landing-safety assessment: slopes, hazards and surface conditions are not evaluated.',
    ],
  };
}

function attributionOf(run: RunDoc, sources: readonly { url: string | null }[]): string {
  const hosts = [
    ...new Set(
      sources
        .map((s) => {
          try {
            return s.url ? new URL(s.url).host : null;
          } catch {
            return null;
          }
        })
        .filter((h): h is string => h !== null),
    ),
  ];
  return (
    `Computed by lunarnav ${run.code_version} (run ${run._id}, ${run.run_timestamp_utc}): ${run.provider} ephemerides, ${run.dem} terrain, ${run.horizon_method} horizon.` +
    (hosts.length > 0 ? ` Data: ${hosts.join(', ')}.` : '')
  );
}

const CONVENTIONS: DatasetResponse['conventions'] = {
  time: 'UTC ISO-8601 YYYY-MM-DDTHH:MM:SSZ; ranges are [start, end) with exclusive end; sample t represents [t, t + step)',
  azimuth: 'deg clockwise from local north, [0, 360) (N = 0, E = 90)',
  longitude: 'deg EAST, [0, 360), planetocentric, MOON_ME frame',
  latitude: 'deg planetocentric, [-90, 90]',
  elevation: 'deg above the local horizontal plane (airless, body centre)',
  distance: 'km (no distance field in this response; GET /series has sun_dist_km / earth_dist_km)',
  height: 'surface_height_m: m above the 1737.4 km reference sphere; observer_height_m: m above the surface',
  duration: 'hours (duration_h, *_hours, longest_*_h, minimum_hours)',
  percent: 'pct_*: 0-100 % of the range',
};

const SERIES_FIELDS = ['sun_az_deg', 'sun_el_deg', 'sun_visible', 'earth_az_deg', 'earth_el_deg', 'earth_visible', 'both_visible'] as const;

interface RawSeries {
  tMs: number[];
  sunAz: number[];
  sunEl: number[];
  sunVis: boolean[];
  earthAz: number[];
  earthEl: number[];
  earthVis: boolean[];
  bothVis: boolean[];
}

async function loadSeries(run: RunDoc, siteId: string, startMs: number, endMs: number): Promise<RawSeries> {
  const r: RawSeries = { tMs: [], sunAz: [], sunEl: [], sunVis: [], earthAz: [], earthEl: [], earthVis: [], bothVis: [] };
  const num = (v: unknown, f: string, t: Date): number => {
    if (typeof v !== 'number') throw new ApiError('INTERNAL', `run ${run._id} site ${siteId}: stored sample ${toIsoUtc(t)} has no numeric ${f}`);
    return v;
  };
  for await (const row of streamSeries(siteId, run, startMs, endMs, SERIES_FIELDS)) {
    r.tMs.push(row.t.getTime());
    r.sunAz.push(num(row.sun_az_deg, 'sun_az_deg', row.t));
    r.sunEl.push(num(row.sun_el_deg, 'sun_el_deg', row.t));
    r.sunVis.push(row.sun_visible === true);
    r.earthAz.push(num(row.earth_az_deg, 'earth_az_deg', row.t));
    r.earthEl.push(num(row.earth_el_deg, 'earth_el_deg', row.t));
    r.earthVis.push(row.earth_visible === true);
    r.bothVis.push(row.both_visible === true);
  }
  return r;
}

/**
 * Title of the 422s raised by the series point caps. They keep code OUT_OF_RANGE (contract unchanged), but the
 * default title "Range outside run" read as a wrong date choice to the FE dev (14/11), so they get their own title.
 */
export const SERIES_POINT_LIMIT_TITLE = 'Series point limit exceeded';

/** decimateSeries / planSeriesPoints, with TooManyTransitionsError -> 422. */
function withTransitionCheck<T>(siteId: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof TooManyTransitionsError) {
      throw new ApiError('OUT_OF_RANGE', `site ${siteId} has ${e.needed} visibility-transition samples in the range, more than max_points=${e.maxPoints}`, {
        title: SERIES_POINT_LIMIT_TITLE,
        errors: [{ path: 'max_points', in: 'querystring', message: `must be >= ${e.needed} for this range, or shorten the range` }],
        extensions: { site_id: siteId, needed_points: e.needed, max_points: e.maxPoints },
        hint: 'shorten the range (start/end) or raise max_points',
      });
    }
    throw e;
  }
}

/** 422 when the series points of all sites exceed the payload limit. */
function payloadTooLarge(perSite: readonly number[], minPerSite: number, stage: string): ApiError {
  const nSites = perSite.length;
  const total = perSite.reduce((a, b) => a + b, 0);
  const maxSite = Math.max(0, ...perSite);
  const fitMax = Math.floor(DATASET_LIMITS.max_total_points / Math.max(1, nSites));
  const canFit = fitMax >= Math.max(DATASET_LIMITS.max_points_min, minPerSite);
  return new ApiError(
    'OUT_OF_RANGE',
    `payload too large: ${nSites} sites need ${total} series points (${stage}) > limit ${DATASET_LIMITS.max_total_points} points`,
    {
      title: SERIES_POINT_LIMIT_TITLE,
      errors: [
        {
          path: 'max_points',
          in: 'querystring',
          message: canFit ? `with ${nSites} sites use max_points <= ${fitMax}` : `even max_points=${fitMax} cannot hold the visibility transitions of this range`,
        },
      ],
      extensions: {
        limit_total_points: DATASET_LIMITS.max_total_points,
        requested_total_points: total,
        n_sites: nSites,
        points_per_site: maxSite,
        max_points_fit: canFit ? fitMax : null,
      },
      hint: canFit
        ? `lower max_points (<= ${fitMax} for ${nSites} sites), request fewer site_ids, shorten the range, or drop series from include`
        : `request fewer site_ids or shorten the range (transition samples alone need ${minPerSite} points for one site), or drop series from include`,
    },
  );
}

function buildSeries(raw: RawSeries, run: RunDoc, kReq: number, maxPoints: number, siteId: string): DatasetSeries {
  const d = withTransitionCheck(siteId, () => decimateSeries(raw.sunVis, raw.earthVis, kReq, maxPoints));
  const pick = <T>(a: readonly T[]): T[] => d.indices.map((i) => a[i] as T);
  return {
    t: d.indices.map((i) => toIsoUtc(raw.tMs[i] ?? 0)),
    sun_az_deg: pick(raw.sunAz),
    sun_el_deg: pick(raw.sunEl),
    sun_visible: pick(raw.sunVis),
    earth_az_deg: pick(raw.earthAz),
    earth_el_deg: pick(raw.earthEl),
    earth_visible: pick(raw.earthVis),
    both_visible: pick(raw.bothVis),
    step_s: d.k * run.step_s,
    decimated: d.indices.length < raw.tMs.length,
    n_transitions: d.nTransitions,
  };
}

export const datasetRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/dataset',
    {
      schema: {
        tags: ['analysis'],
        operationId: 'getDataset',
        summary: 'Everything the comparison page needs in one call: run, model, per-site horizon, series, windows, metrics, criteria',
        description:
          'Defaults: default run, every site of the run, the whole run range, data step (3600 s), max_points 10000, horizon_step_deg 1, criteria_hours 24,72,168, ' +
          'include horizon,series,windows,metrics,criteria (opt-in: pointing -> sites[].now = where to point the panel and the antenna at range.start, as GET /sites/{site_id}/pointing; ' +
          'survival_hint -> sites[].survival_hint = longest dark period + the battery a reference night_load_w needs; their assumptions are in `assumptions`). ' +
          'metrics also carry energy proxies mean_power_tracking_pct / mean_power_horizontal_pct over the range. ' +
          'Series are decimated per site to <= max_points while keeping both samples around every visibility transition (see DatasetSeries). ' +
          'Windows / metrics / criteria are computed from the full-resolution windows over the requested range (whole run -> exactly summary.csv / windows.json). ' +
          `Payload limit: the series points of all sites together (regular + transition samples, exactly as returned) must be <= ${DATASET_LIMITS.max_total_points} ` +
          `(about 4.5 MB of JSON, ~1 MB gzip), else 422 OUT_OF_RANGE (title "Series point limit exceeded") with the numbers and a fitting max_points; ` +
          'first check (before any read): sites x min(max_points, n_samples / k) - so a call with no parameters on a 23-site 5-year run is 422; ' +
          'e.g. all 23 sites x 31 days hourly = 17 112 points is fine, the whole 5-year run for many sites needs max_points <= 50000 / n_sites or fewer site_ids ' +
          '(a large step_s alone may not be enough: transition samples are always kept). Windows and horizon bytes are not counted. ' +
          'Without `series` in include there is no point limit (whole run, 23 sites: ~0.7 MB, ~0.2 s); a whole-run series for all sites takes ~8 s, so request series for <= 1 year or a few sites. ' +
          'A range partly outside the run is clamped (coverage = partial); no overlap -> 422 OUT_OF_RANGE. Unknown site id -> 404 SITE_NOT_FOUND.',
        querystring: DatasetQuery,
        response: { 200: DatasetResponse, ...notModifiedResponse, ...problemResponses(400, 404, 409, 422, 503) },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const run = await resolveRun(q.run_id);
      const range = resolveDatasetRange(run, q.start, q.end);
      const siteIds = q.site_ids ?? run.site_ids;
      const views = await getSites(run._id, siteIds);
      if (views.length !== siteIds.length) {
        const found = new Set(views.map((v) => v.site_run.site_id));
        throw siteNotFound(siteIds.find((id) => !found.has(id)) ?? '');
      }
      const include = new Set(q.include);
      const nightLoadW = q.night_load_w ?? null;
      const kReq = Math.max(1, Math.floor((q.step_s ?? run.step_s) / run.step_s));

      if (include.has('series')) {
        const perSite = estimatePoints(range.n, kReq, q.max_points);
        if (perSite * views.length > DATASET_LIMITS.max_total_points) {
          throw payloadTooLarge(views.map(() => perSite), 0, `${perSite} per site from max_points / step_s`);
        }
      }

      const selection = JSON.stringify({
        sites: views.map((v) => v.site_run.site_id),
        start: range.reqStartMs,
        end: range.reqEndMs,
        k: kReq,
        max_points: q.max_points,
        horizon_step_deg: q.horizon_step_deg,
        criteria_hours: q.criteria_hours,
        include: DATASET_INCLUDE.filter((x) => include.has(x)),
        // only when it matters, so the dataset_id of the other selections is unchanged
        ...(include.has('survival_hint') ? { night_load_w: nightLoadW } : {}),
      });
      const etag = weakEtag('dataset', DATASET_SCHEMA_VERSION, DATASET_ETAG_REVISION, runVersion(run), selection);
      if (applyCache(req, reply, etag, cacheControlFor(q.run_id))) return notModified(reply);

      // windows of every site first (always: windows / metrics / criteria, coverage without series, and the exact series point count)
      const spansBySite: Record<WindowKind, ClippedSpan[]>[] = await Promise.all(
        views.map(async (v) => {
          const wins = await getWindows(run._id, v.site_run.site_id, { fromMs: range.startMs, toMs: range.endMs });
          return Object.fromEntries(WINDOW_KINDS.map((k) => [k, clipSpans(wins[k] ?? [], range.startMs, range.endMs, run.step_s)])) as Record<WindowKind, ClippedSpan[]>;
        }),
      );
      if (include.has('series')) {
        const plans = views.map((v, i) => {
          const sp = spansBySite[i] as Record<WindowKind, ClippedSpan[]>;
          return withTransitionCheck(v.site_run.site_id, () => planSeriesPoints(sp.sun, sp.earth, range.startMs, run.step_s, range.n, kReq, q.max_points));
        });
        const perSite = plans.map((p) => p.points);
        if (perSite.reduce((a, b) => a + b, 0) > DATASET_LIMITS.max_total_points) {
          throw payloadTooLarge(perSite, Math.max(0, ...plans.map((p) => p.transSamples + 2)), `up to ${Math.max(0, ...perSite)} per site, transition samples included`);
        }
      }

      // energy proxies of metrics: one $group over the range for all sites
      const sums: Map<string, SeriesSums> = include.has('metrics')
        ? await seriesSums(
            run._id,
            views.map((v) => v.site_run.site_id),
            range.startMs,
            range.endMs,
          )
        : new Map();

      const sites: DatasetSite[] = await Promise.all(
        views.map(async (v: SiteView, i): Promise<DatasetSite> => {
          const id = v.site_run.site_id;
          const rec = v.site_run.record;
          const spans = spansBySite[i] as Record<WindowKind, ClippedSpan[]>;
          const [horizon, raw, nowSample] = await Promise.all([
            include.has('horizon') ? getHorizon(run._id, id) : Promise.resolve(null),
            include.has('series') ? loadSeries(run, id, range.startMs, range.endMs) : Promise.resolve(null),
            include.has('pointing') ? getSample(id, run, range.startMs) : Promise.resolve(null),
          ]);
          const present = raw ? raw.tMs.length : coveredSamples(spans.sun);
          const coverageAgainst = (n: number): DatasetSite['coverage'] => (present === 0 ? 'missing' : present >= n ? 'complete' : 'partial');
          const coverage = coverageAgainst(range.nRequested);
          const out: DatasetSite = {
            id,
            name: rec.name,
            group: rec.group,
            lat_deg: rec.lat_deg,
            lon_deg: rec.lon_deg,
            surface_height_m: rec.surface_height_m,
            coverage,
            coverage_in_range: coverageAgainst(range.n),
          };
          if (include.has('horizon')) {
            if (!horizon) throw new ApiError('INTERNAL', `run ${run._id} has no horizon for ${id} (incomplete import?)`);
            out.horizon = resampleHorizon(horizon, q.horizon_step_deg);
          }
          if (raw) out.series = buildSeries(raw, run, kReq, q.max_points, id);
          if (include.has('windows')) {
            out.windows = { sun: visibleWindows(spans.sun, run.step_s), earth: visibleWindows(spans.earth, run.step_s), both: visibleWindows(spans.both, run.step_s) };
          }
          if (include.has('metrics') || include.has('criteria')) {
            const m = coverage === 'missing' ? null : rangeMetrics(spans, range.n, run.step_s, range.startMs);
            if (include.has('metrics')) out.metrics = m ? { ...m.metrics, ...meanPowerPct(sums.get(id)) } : null;
            if (include.has('criteria')) out.criteria = m ? evaluateCriteria(m.metrics, m.longestBoth, q.criteria_hours, run.step_s) : [];
          }
          if (include.has('pointing')) {
            out.now = nowSample
              ? buildPointing(readingFromSample(nowSample, `run ${run._id} site ${id} ${toIsoUtc(range.startMs)}`), range.startMs, range.startMs, run.end.getTime(), {
                  terrain: siteTerrainModelled(rec),
                })
              : null;
          }
          if (include.has('survival_hint')) out.survival_hint = coverage === 'missing' ? null : survivalHint(spans.sun, run.step_s, nightLoadW);
          return out;
        }),
      );
      if (include.has('series')) {
        // safety net (the plan above is exact unless the stored series has gaps)
        const actual = sites.map((x) => x.series?.t.length ?? 0);
        if (actual.reduce((a, b) => a + b, 0) > DATASET_LIMITS.max_total_points) throw payloadTooLarge(actual, 0, `up to ${Math.max(0, ...actual)} per site after decimation`);
      }

      const sources = sourcesOf(run.manifest.data_sources);
      return {
        schema_version: DATASET_SCHEMA_VERSION,
        dataset_id: `${run._id}.${shortHash(selection)}`,
        evidence: DATASET_EVIDENCE,
        attribution: attributionOf(run, sources),
        run: {
          run_id: run._id,
          label: run.label,
          provider: run.provider,
          dem: run.dem,
          horizon_method: run.horizon_method,
          code_version: run.code_version,
          run_timestamp_utc: run.run_timestamp_utc,
          observer_height_m: run.observer_height_m,
          min_earth_clearance_deg: run.min_earth_clearance_deg,
          git_commit: run.git_commit,
          manifest_sha256: run.manifest_sha256,
          manifest_url: `/api/v1/runs/${encodeURIComponent(run._id)}/files/manifest.json`,
        },
        model: modelOf(run),
        range: {
          start: toIsoUtc(range.startMs),
          end: toIsoUtc(range.endMs),
          step_s: run.step_s,
          n_samples: range.n,
          requested_start: toIsoUtc(range.reqStartMs),
          requested_end: toIsoUtc(range.reqEndMs),
        },
        conventions: CONVENTIONS,
        criteria_hours: q.criteria_hours,
        include: DATASET_INCLUDE.filter((x) => include.has(x)),
        ...(include.has('survival_hint') ? { night_load_w: nightLoadW } : {}),
        ...(include.has('pointing') || include.has('survival_hint')
          ? {
              assumptions: {
                ...(include.has('pointing') ? { pointing: datasetPointingAssumptions(run, views) } : {}),
                ...(include.has('survival_hint') ? { survival_hint: survivalHintAssumptions(run.step_s, runTerrainModelled(run)) } : {}),
              },
            }
          : {}),
        sites,
        sources,
      };
    },
  );
};


export default datasetRoutes;
