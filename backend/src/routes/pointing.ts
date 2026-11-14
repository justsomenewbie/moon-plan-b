/**
 * GET /api/v1/sites/{site_id}/pointing - where to point the solar panel and the antenna at instant t,
 * in compass words, with the time left before sunset / earthset (contract: src/contract/pointing.ts).
 *
 * Reads the stored hourly sample containing t (same sample as GET /instant) through repos/index.ts and
 * re-states it with buildPointing(). Also exports readingFromSample() for GET /dataset include=pointing.
 * Caching: weak ETag of (run identity, url) + cacheControlFor(), like the other read routes.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SiteParams } from '../contract/common.ts';
import { PointingQuery, PointingResponse, buildPointing, pointingAssumptions, terrainModelled, type PointingReading } from '../contract/pointing.ts';
import type { SeriesFieldName } from '../contract/series.ts';
import { ApiError, problemResponses, siteNotFound } from '../lib/problem.ts';
import { provenanceOf } from '../lib/provenance.ts';
import { MS_PER_S, sampleIndex, toIsoUtc } from '../lib/time.ts';
import { getSample, getSite, resolveRun, type RunDoc, type SeriesSample, type SeriesValue } from '../repos/index.ts';
import { applyCache, cacheControlFor, notModified, notModifiedResponse, weakEtag } from './a/http_cache.ts';
import { parseQueryInstant } from './series.ts';
import { runVersion } from './runs.ts';

/** Bumped when the body for the same URL and run changes (2 = summary prose: partly visible Sun, lean forward, flat horizon). */
const POINTING_ETAG_REVISION = '2';

const numberOrNull = (v: SeriesValue | undefined): number | null => (typeof v === 'number' ? v : null);

/** Stored sample -> the inputs of buildPointing(). Throws INTERNAL when a required column is missing. */
export function readingFromSample(s: Partial<SeriesSample>, where: string): PointingReading {
  const num = (f: SeriesFieldName): number => {
    const v = s[f];
    if (typeof v !== 'number') throw new ApiError('INTERNAL', `${where}: stored sample has no numeric ${f}`);
    return v;
  };
  return {
    sun: {
      az_deg: num('sun_az_deg'),
      el_deg: num('sun_el_deg'),
      clearance_deg: num('sun_clearance_deg'),
      fraction: num('sun_fraction'),
      visible: s.sun_visible === true,
      power_horizontal: num('power_horizontal'),
      power_tracking: num('power_tracking'),
      irradiance_tracking_wm2: num('irradiance_tracking_wm2'),
    },
    earth: {
      az_deg: num('earth_az_deg'),
      el_deg: num('earth_el_deg'),
      clearance_deg: num('earth_clearance_deg'),
      visible: s.earth_visible === true,
      dist_km: num('earth_dist_km'),
    },
    hours_until: {
      sunset: numberOrNull(s.hours_until_sunset),
      sunrise: numberOrNull(s.hours_until_sunrise),
      earthset: numberOrNull(s.hours_until_earthset),
      earthrise: numberOrNull(s.hours_until_earthrise),
    },
  };
}

/** Whether the run models the terrain (false: horizon_method flat or dem none -> "ideal flat horizon" prose). */
export const runTerrainModelled = (run: Pick<RunDoc, 'horizon_method' | 'dem'>): boolean => terrainModelled(run.horizon_method, run.dem);
/** Whether one site's horizon models the terrain (also false for the dem_source 'none:outside-...' fallback). */
export const siteTerrainModelled = (rec: { horizon_method: string; dem_source: string }): boolean => terrainModelled(rec.horizon_method, rec.dem_source);

/** Assumptions of a run's pointing blocks; terrain defaults to the run's horizon (pass the site's for one site). */
export const pointingAssumptionsOf = (
  run: Pick<RunDoc, 'min_earth_clearance_deg' | 'observer_height_m' | 'step_s' | 'horizon_method' | 'dem'>,
  terrain: boolean = runTerrainModelled(run),
): string[] => pointingAssumptions(run.min_earth_clearance_deg, run.observer_height_m, run.step_s, terrain);

export const pointingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/sites/:site_id/pointing',
    {
      schema: {
        tags: ['series'],
        operationId: 'getSitePointing',
        summary: 'Where to point the solar panel and the antenna at instant t (compass words + time left before sunset / earthset)',
        description:
          'Reads the hourly sample containing t (as GET /instant). panel: face azimuth = Sun azimuth with its 16-point compass name (English + Vietnamese), ' +
          'tilt from vertical = Sun elevation (a 2-axis Sun-tracking panel), Sun visibility against the TERRAIN horizon, hours until sunset / sunrise. ' +
          'antenna: Earth azimuth / elevation, compass name, Earth visibility, hours until earthset / earthrise, distance. ' +
          'Plus a one-line plain-language summary (en, vi) and every assumption. t outside the run -> 422 OUT_OF_RANGE.',
        params: SiteParams,
        querystring: PointingQuery,
        response: { 200: PointingResponse, ...notModifiedResponse, ...problemResponses(400, 404, 409, 422, 503) },
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
      const view = await getSite(run._id, siteId);
      if (!view) throw siteNotFound(siteId);
      if (applyCache(req, reply, weakEtag('pointing', POINTING_ETAG_REVISION, runVersion(run), req.url), cacheControlFor(req.query.run_id))) return notModified(reply);
      const sampleMs = runStart + k * run.step_s * MS_PER_S;
      const s = await getSample(siteId, run, sampleMs);
      if (!s) throw new ApiError('INTERNAL', `run ${run._id} has no stored sample for ${siteId} at ${toIsoUtc(sampleMs)} (incomplete import?)`);
      const reading = readingFromSample(s, `run ${run._id} site ${siteId} ${toIsoUtc(sampleMs)}`);
      const terrain = siteTerrainModelled(view.site_run.record);
      return {
        ...provenanceOf(run),
        site_id: siteId,
        ...buildPointing(reading, tMs, sampleMs, runEnd, { terrain }),
        assumptions: pointingAssumptionsOf(run, terrain),
      };
    },
  );
};

export default pointingRoutes;
