/**
 * Site catalog + site card + horizon silhouette (plan 6.2 #4, #5, #6).
 *   GET /api/v1/sites                       list / map markers (json or geojson)
 *   GET /api/v1/sites/{site_id}             site card: record, extra, metrics over the full run, rank
 *   GET /api/v1/sites/{site_id}/horizon     terrain horizon profile (sky diagram)
 */
import { z } from 'zod';
import { Lat, LonEast, MapPoint, Metrics, SiteId, TimeRange, provenance, runIdQuery } from './common.ts';
import { exampleHorizon, exampleSiteDetail, exampleSitesGeoJson, exampleSitesResponse } from '../fixtures/index.ts';

export const SiteOrigin = z.enum(['catalog', 'custom']).describe('catalog = lunarnav/catalog/sites.json; custom = user coordinates (POST /jobs)');

export const SitesQuery = z.strictObject({
  run_id: runIdQuery,
  group: z
    .string()
    .regex(/^[a-z0-9_]{1,32}$/)
    .optional()
    .describe('Filter by catalog group: south_pole | reference | apollo | far_side (custom sites have group "")'),
  format: z
    .enum(['json', 'geojson'])
    .default('json')
    .describe('json -> application/json SitesResponse; geojson -> application/geo+json FeatureCollection (points + Artemis III region polygons)'),
});
export type SitesQuery = z.output<typeof SitesQuery>;

export const SiteListItem = z
  .object({
    id: SiteId,
    name: z.string(),
    group: z.string().describe('Catalog group ("" for custom sites)'),
    origin: SiteOrigin,
    lat_deg: Lat,
    lon_deg: LonEast,
    map: MapPoint.nullable(),
    dem_source: z
      .string()
      .describe('DEM used for the horizon; `none:outside-<dem>-coverage` = smooth-sphere horizon (show a warning)'),
    horizon_method: z.string(),
    rank: z.int().min(1).describe('Rank in this run with the default weights'),
    score: z.number(),
    pct_sun: z.number(),
    pct_earth: z.number(),
    pct_both: z.number(),
    longest_dark_h: z.number(),
    longest_comms_gap_h: z.number(),
  })
  .meta({ id: 'SiteListItem' });
export type SiteListItem = z.output<typeof SiteListItem>;

const SitesResponseShape = z
  .object({ ...provenance, sites: z.array(SiteListItem) });
export type SitesResponse = z.output<typeof SitesResponseShape>;
export const SitesResponse = SitesResponseShape.meta({ id: 'SitesResponse', examples: [exampleSitesResponse()] });

// ---- GeoJSON (RFC 7946; coordinates = [lon_east_deg, lat_deg] on the Moon) -------------------------
const GeoPoint = z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) });
const GeoPolygon = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))).describe('Closed rings of [lon_east_deg, lat_deg]'),
});

export const SiteFeature = z
  .object({
    type: z.literal('Feature'),
    id: z.string().describe('site id (Point) or `<site id>#region` (Polygon)'),
    geometry: z.union([GeoPoint, GeoPolygon]),
    properties: z.object({
      kind: z.enum(['site', 'region']),
      site_id: SiteId,
      name: z.string(),
      group: z.string(),
      origin: SiteOrigin,
      rank: z.int().min(1),
      score: z.number(),
      pct_sun: z.number(),
      pct_earth: z.number(),
      pct_both: z.number(),
      dem_source: z.string(),
    }),
  })
  .meta({ id: 'SiteFeature' });

const SitesGeoJsonShape = z
  .object({
    type: z.literal('FeatureCollection'),
    run_id: z.string(),
    features: z.array(SiteFeature),
  })
  .describe('GeoJSON FeatureCollection in lunar coordinates (planetocentric lat, EAST lon, MOON_ME)');
export type SitesGeoJson = z.output<typeof SitesGeoJsonShape>;
export const SitesGeoJson = SitesGeoJsonShape.meta({ id: 'SitesGeoJson', examples: [exampleSitesGeoJson()] });

// ---- site card ------------------------------------------------------------------------------------
export const SiteRecord = z
  .object({
    id: SiteId,
    name: z.string(),
    lat_deg: Lat,
    lon_deg: LonEast,
    origin: SiteOrigin,
    group: z.string(),
    source: z.string().nullable().describe('Literature / catalog source of the coordinates'),
    note: z.string().nullable(),
    height_m_input: z.number().nullable().describe('null = surface height read from the DEM'),
    surface_height_m: z.number().describe('m above the 1737.4 km sphere'),
    observer_height_m: z.number().describe('Mast height above the surface, m'),
    observer_height_above_sphere_m: z.number(),
    horizon_method: z.string(),
    dem_source: z.string(),
    horizon_radius_km: z.number().nullable().describe('null = unbounded'),
    horizon_min_el_deg: z.number(),
    horizon_max_el_deg: z.number(),
  })
  .describe('sites.json record of the run (docs/OUTPUT_SPEC.md 3.2), without file paths')
  .meta({ id: 'SiteRecord' });
export type SiteRecord = z.output<typeof SiteRecord>;

const SiteDetailShape = z
  .object({
    ...provenance,
    site: SiteRecord,
    extra: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('Free-form catalog metadata (accuracy, source_url, region_corners_latlon [[lat, lon_east], ...], ...); null for custom sites'),
    map: MapPoint.nullable(),
    range: TimeRange.describe('Range of the metrics (= full run)'),
    metrics: Metrics,
    rank: z.int().min(1),
    score: z.number(),
    warnings: z.array(z.string()).describe('Caveats to show next to the numbers (e.g. smooth-sphere horizon)'),
  });
export type SiteDetail = z.output<typeof SiteDetailShape>;
export const SiteDetail = SiteDetailShape.meta({ id: 'SiteDetail', examples: [exampleSiteDetail()] });

export const SiteQuery = z.strictObject({ run_id: runIdQuery });

// ---- horizon --------------------------------------------------------------------------------------
const HorizonResponseShape = z
  .object({
    ...provenance,
    site_id: SiteId,
    method: z.string().describe('raymarch | bruteforce | flat'),
    dem_source: z.string(),
    az_step_deg: z.number().positive(),
    az_deg: z.array(z.number()).describe('Uniform azimuth grid i * az_step_deg in [0, 360), clockwise from north'),
    el_deg: z.array(z.number()).describe('Terrain horizon elevation, deg (may be < 0 = dip)'),
    covered_radius_km: z.array(z.number()).describe('Radius actually searched in that direction, km'),
    min_el_deg: z.number(),
    max_el_deg: z.number(),
  })
  .describe('Horizon at an arbitrary azimuth = periodic linear interpolation between grid points');
export type HorizonResponse = z.output<typeof HorizonResponseShape>;
export const HorizonResponse = HorizonResponseShape.meta({ id: 'HorizonResponse', examples: [exampleHorizon(10)] });
