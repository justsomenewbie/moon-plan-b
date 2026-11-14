/**
 * Sites (plan 6.2 #4, #5, #6) - contract: src/contract/sites.ts.
 *   GET /api/v1/sites, GET /api/v1/sites/{site_id}, GET /api/v1/sites/{site_id}/horizon
 * Reads `site_runs` (+ global `sites`) and `horizons` through repos/index.ts.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HorizonResponse, SiteDetail, SiteQuery, SitesGeoJson, SitesQuery, SitesResponse, type SiteListItem, type SiteRecord } from '../contract/sites.ts';
import { SiteParams } from '../contract/common.ts';
import { problemResponses, siteNotFound } from '../lib/problem.ts';
import { toIsoUtc } from '../lib/time.ts';
import { getHorizon, getSite, listSites, resolveRun, type RunDoc, type SiteRunDoc, type SiteView } from '../repos/index.ts';
import { applyCache, cacheControlFor, notModified, notModifiedResponse, weakEtag } from './a/http_cache.ts';
import { runVersion } from './runs.ts';
import { provenanceOf } from '../lib/provenance.ts';

export const GEOJSON_MEDIA_TYPE = 'application/geo+json';


/** Caveats shown next to a site's numbers. */
export function siteWarnings(rec: Pick<SiteRecord, 'dem_source' | 'horizon_method'>): string[] {
  const w: string[] = [];
  if (rec.dem_source.startsWith('none:')) w.push(`smooth-sphere horizon (dem_source ${rec.dem_source})`);
  if (rec.horizon_method === 'flat') w.push('flat horizon: terrain shadowing not modelled');
  return w;
}

/** The typed sites.json record of a site_run (repos SiteRecordDoc = importer/schemas.ts SiteRecordCore). */
export const recordOf = (sr: SiteRunDoc): SiteRecord => sr.record;

export function siteRecord(r: SiteRecord): SiteRecord {
  return {
    id: r.id,
    name: r.name,
    lat_deg: r.lat_deg,
    lon_deg: r.lon_deg,
    origin: r.origin,
    group: r.group,
    source: r.source,
    note: r.note,
    height_m_input: r.height_m_input,
    surface_height_m: r.surface_height_m,
    observer_height_m: r.observer_height_m,
    observer_height_above_sphere_m: r.observer_height_above_sphere_m,
    horizon_method: r.horizon_method,
    dem_source: r.dem_source,
    horizon_radius_km: r.horizon_radius_km,
    horizon_min_el_deg: r.horizon_min_el_deg,
    horizon_max_el_deg: r.horizon_max_el_deg,
  };
}

function listItem(v: SiteView): SiteListItem {
  const r = recordOf(v.site_run);
  const m = v.site_run.metrics;
  return {
    id: r.id,
    name: r.name,
    group: r.group,
    origin: r.origin,
    lat_deg: r.lat_deg,
    lon_deg: r.lon_deg,
    map: v.site?.map ?? null,
    dem_source: r.dem_source,
    horizon_method: r.horizon_method,
    rank: v.site_run.rank,
    score: v.site_run.score,
    pct_sun: m.pct_sun,
    pct_earth: m.pct_earth,
    pct_both: m.pct_both,
    longest_dark_h: m.longest_dark_h,
    longest_comms_gap_h: m.longest_comms_gap_h,
  };
}

/** Region corners from the catalog extra (`region_corners_latlon: [[lat, lon_east], ...]`) -> closed GeoJSON ring. */
export function regionRing(extra: Record<string, unknown> | null | undefined): [number, number][] | null {
  const corners = extra?.['region_corners_latlon'];
  if (!Array.isArray(corners) || corners.length < 3) return null;
  const ring: [number, number][] = [];
  for (const c of corners) {
    if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
    ring.push([c[1], c[0]]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push(first);
  return ring;
}

export function sitesGeoJson(run: RunDoc, views: readonly SiteView[]): SitesGeoJson {
  const features: SitesGeoJson['features'] = [];
  for (const v of views) {
    const r = recordOf(v.site_run);
  const m = v.site_run.metrics;
    const properties = {
      site_id: r.id,
      name: r.name,
      group: r.group,
      origin: r.origin,
      rank: v.site_run.rank,
      score: v.site_run.score,
      pct_sun: m.pct_sun,
      pct_earth: m.pct_earth,
      pct_both: m.pct_both,
      dem_source: r.dem_source,
    };
    features.push({ type: 'Feature', id: r.id, geometry: { type: 'Point', coordinates: [r.lon_deg, r.lat_deg] }, properties: { kind: 'site', ...properties } });
    const ring = regionRing(v.site?.extra);
    if (ring) {
      features.push({ type: 'Feature', id: `${r.id}#region`, geometry: { type: 'Polygon', coordinates: [ring] }, properties: { kind: 'region', ...properties } });
    }
  }
  return { type: 'FeatureCollection', run_id: run._id, features };
}

export const sitesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/sites',
    {
      schema: {
        tags: ['sites'],
        operationId: 'listSites',
        summary: 'Site catalog of a run (list + map markers)',
        description:
          'Sorted by rank (default weights, = summary.csv). format=geojson returns application/geo+json with Point features and Artemis III region Polygons.',
        querystring: SitesQuery,
        response: {
          200: {
            description: 'Sites of the run',
            content: {
              'application/json': { schema: SitesResponse },
              [GEOJSON_MEDIA_TYPE]: { schema: SitesGeoJson },
            },
          },
          ...notModifiedResponse,
          ...problemResponses(400, 404, 409),
        },
      },
    },
    async (req, reply) => {
      const run = await resolveRun(req.query.run_id);
      if (applyCache(req, reply, weakEtag('sites', runVersion(run), req.url), cacheControlFor(req.query.run_id))) return notModified(reply);
      const views = await listSites(run._id, req.query.group === undefined ? {} : { group: req.query.group });
      if (req.query.format === 'geojson') {
        reply.type(GEOJSON_MEDIA_TYPE);
        return sitesGeoJson(run, views);
      }
      reply.type('application/json');
      return { ...provenanceOf(run), sites: views.map(listItem) };
    },
  );

  app.get(
    '/sites/:site_id',
    {
      schema: {
        tags: ['sites'],
        operationId: 'getSite',
        summary: 'Site card: record, catalog extra, metrics over the full run, rank/score',
        description: 'metrics = windows.json metrics and rank/score = summary.csv of the run, verbatim.',
        params: SiteParams,
        querystring: SiteQuery,
        response: { 200: SiteDetail, ...notModifiedResponse, ...problemResponses(400, 404, 409) },
      },
    },
    async (req, reply) => {
      const run = await resolveRun(req.query.run_id);
      const v = await getSite(run._id, req.params.site_id);
      if (!v) throw siteNotFound(req.params.site_id);
      if (applyCache(req, reply, weakEtag('site', runVersion(run), req.url), cacheControlFor(req.query.run_id))) return notModified(reply);
      const sr = v.site_run;
      return {
        ...provenanceOf(run),
        site: siteRecord(recordOf(sr)),
        extra: v.site?.extra ?? null,
        map: v.site?.map ?? null,
        range: { start: toIsoUtc(sr.range_start), end: toIsoUtc(sr.range_end), step_s: sr.step_s, n_samples: sr.n_samples },
        metrics: sr.metrics,
        rank: sr.rank,
        score: sr.score,
        warnings: siteWarnings(recordOf(sr)),
      };
    },
  );

  app.get(
    '/sites/:site_id/horizon',
    {
      schema: {
        tags: ['sites'],
        operationId: 'getSiteHorizon',
        summary: 'Terrain horizon profile (sky diagram silhouette)',
        params: SiteParams,
        querystring: SiteQuery,
        response: { 200: HorizonResponse, ...notModifiedResponse, ...problemResponses(400, 404, 409) },
      },
    },
    async (req, reply) => {
      const run = await resolveRun(req.query.run_id);
      const h = await getHorizon(run._id, req.params.site_id);
      if (!h) throw siteNotFound(req.params.site_id);
      if (applyCache(req, reply, weakEtag('horizon', runVersion(run), req.url), cacheControlFor(req.query.run_id))) return notModified(reply);
      return {
        ...provenanceOf(run),
        site_id: h.site_id,
        method: h.method,
        dem_source: h.dem_source,
        az_step_deg: h.az_step_deg,
        az_deg: h.az_deg,
        el_deg: h.el_deg,
        covered_radius_km: h.covered_radius_km,
        min_el_deg: h.min_el_deg,
        max_el_deg: h.max_el_deg,
      };
    },
  );
};

export default sitesRoutes;
