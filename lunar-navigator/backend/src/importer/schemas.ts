/**
 * zod schemas of the precompute OUTPUT files (docs/OUTPUT_SPEC.md, format `lunarnav-precompute` v1),
 * as the importer reads them from disk. These are INPUT schemas (files written by Python), not API
 * contract schemas: unknown keys are kept (looseObject) so a newer lunarnav adding fields still imports.
 */
import { z } from 'zod';
import { ISO_UTC_RE } from '../lib/time.ts';
import { SITE_ID_RE } from '../contract/common.ts';
import { Metrics } from '../contract/common.ts';

const Iso = z.string().regex(ISO_UTC_RE, 'expected YYYY-MM-DDTHH:MM:SSZ');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256');

export const MANIFEST_FORMAT = 'lunarnav-precompute';
export const MANIFEST_FORMAT_VERSION = 1;

/** manifest.json (OUTPUT_SPEC 3.1). */
export const ManifestFile = z.looseObject({
  format: z.literal(MANIFEST_FORMAT),
  format_version: z.literal(MANIFEST_FORMAT_VERSION),
  code_version: z.string(),
  git_commit: z.string().nullable(),
  run_timestamp_utc: Iso,
  params_fingerprint: z.string().regex(/^[0-9a-f]{16}$/, 'expected 16 hex chars'),
  parameters: z.looseObject({
    start_utc: Iso,
    end_utc: Iso,
    step_s: z.int().positive(),
    n_samples: z.int().positive(),
    provider: z.string(),
    dem: z.string(),
    horizon_method: z.string(),
    observer_height_m: z.number(),
    min_earth_clearance_deg: z.number(),
    rank_weights: z.record(z.string(), z.number()),
    site_ids: z.array(z.string().regex(SITE_ID_RE)).min(1),
  }),
  data_sources: z.array(z.looseObject({ name: z.string(), url: z.string().nullable().optional(), sha256: z.string().nullable().optional() })),
  conventions: z.record(z.string(), z.string()),
  files: z.record(z.string(), Sha256),
});
export type ManifestFile = z.output<typeof ManifestFile>;

export const SiteFiles = z.looseObject({
  horizon: z.string().min(1),
  ephemeris: z.string().min(1),
  visibility: z.string().min(1),
  windows: z.string().min(1),
});
export type SiteFiles = z.output<typeof SiteFiles>;

/** Known fields of a sites.json record (OUTPUT_SPEC 3.2), without `files`. */
const siteRecordShape = {
  id: z.string().regex(SITE_ID_RE),
  name: z.string(),
  lat_deg: z.number().min(-90).max(90),
  lon_deg: z.number().min(0).lt(360),
  origin: z.enum(['catalog', 'custom']),
  group: z.string(),
  source: z.string().nullable(),
  note: z.string().nullable(),
  height_m_input: z.number().nullable(),
  surface_height_m: z.number(),
  observer_height_m: z.number(),
  observer_height_above_sphere_m: z.number(),
  horizon_method: z.string(),
  dem_source: z.string(),
  horizon_radius_km: z.number().nullable(),
  horizon_min_el_deg: z.number(),
  horizon_max_el_deg: z.number(),
};
const SiteRecordCore = z.object(siteRecordShape);
/** Typed sites.json record without `files` (what site_runs.record holds; unknown extra keys are kept in MongoDB but untyped). */
export type SiteRecordCore = z.output<typeof SiteRecordCore>;

/** One record of sites.json (OUTPUT_SPEC 3.2). Unknown keys are kept. */
export const SiteRecordFile = z.looseObject({ ...siteRecordShape, files: SiteFiles });
export type SiteRecordFile = SiteRecordCore & { files: SiteFiles };

export const SitesFile = z.looseObject({
  format_version: z.literal(1),
  sites: z.array(SiteRecordFile).min(1),
});
export type SitesFile = z.output<typeof SitesFile>;

/** One window of windows.json (OUTPUT_SPEC 3.6). */
export const WindowFile = z.looseObject({
  start: Iso,
  end: Iso,
  duration_h: z.number().min(0),
  state: z.boolean(),
  truncated_start: z.boolean(),
  truncated_end: z.boolean(),
  start_index: z.int().min(0),
  end_index: z.int().min(0),
});
export type WindowFile = z.output<typeof WindowFile>;

/** sites/<id>/windows.json (OUTPUT_SPEC 3.6). */
export const WindowsFile = z.looseObject({
  site_id: z.string().regex(SITE_ID_RE),
  step_s: z.int().positive(),
  n_samples: z.int().positive(),
  range_start_utc: Iso,
  range_end_utc: Iso,
  min_earth_clearance_deg: z.number(),
  sun: z.array(WindowFile),
  earth: z.array(WindowFile),
  both: z.array(WindowFile),
  metrics: Metrics,
  params_fingerprint: z.string(),
  data_sources: z.array(z.unknown()).optional(),
});
export type WindowsFile = z.output<typeof WindowsFile>;

/** Column list of summary.csv (OUTPUT_SPEC 3.7), in file order. */
export const SUMMARY_COLUMNS = [
  'rank', 'site_id', 'name', 'group', 'lat_deg', 'lon_deg', 'surface_height_m', 'score', 'pct_sun', 'pct_earth', 'pct_both',
  'pct_sun_no_earth', 'longest_dark_h', 'longest_dark_truncated', 'longest_comms_gap_h', 'longest_comms_gap_truncated',
  'longest_sun_h', 'longest_earth_h', 'n_sun_windows', 'n_dark_windows', 'n_earth_windows', 'n_comms_gaps',
  'mean_sun_el_lit_deg', 'mean_power_horizontal', 'mean_power_tracking', 'horizon_min_el_deg', 'horizon_max_el_deg',
] as const;
export type SummaryColumn = (typeof SUMMARY_COLUMNS)[number];

const SUMMARY_STRING_COLUMNS: ReadonlySet<SummaryColumn> = new Set(['site_id', 'name', 'group']);
const SUMMARY_INT_COLUMNS: ReadonlySet<SummaryColumn> = new Set(['rank', 'n_sun_windows', 'n_dark_windows', 'n_earth_windows', 'n_comms_gaps']);
const SUMMARY_BOOL_COLUMNS: ReadonlySet<SummaryColumn> = new Set(['longest_dark_truncated', 'longest_comms_gap_truncated']);
const SUMMARY_NULLABLE_COLUMNS: ReadonlySet<SummaryColumn> = new Set(['mean_sun_el_lit_deg']);

export const summaryColumnKind = (c: SummaryColumn): 'string' | 'int' | 'bool' | 'number' | 'nullable_number' =>
  SUMMARY_STRING_COLUMNS.has(c) ? 'string'
  : SUMMARY_INT_COLUMNS.has(c) ? 'int'
  : SUMMARY_BOOL_COLUMNS.has(c) ? 'bool'
  : SUMMARY_NULLABLE_COLUMNS.has(c) ? 'nullable_number'
  : 'number';

/** One parsed row of summary.csv (types per OUTPUT_SPEC 3.7). */
export const SummaryRow = z.object({
  rank: z.int().min(1),
  site_id: z.string().regex(SITE_ID_RE),
  name: z.string(),
  group: z.string(),
  lat_deg: z.number(),
  lon_deg: z.number(),
  surface_height_m: z.number(),
  score: z.number(),
  pct_sun: z.number(),
  pct_earth: z.number(),
  pct_both: z.number(),
  pct_sun_no_earth: z.number(),
  longest_dark_h: z.number(),
  longest_dark_truncated: z.boolean(),
  longest_comms_gap_h: z.number(),
  longest_comms_gap_truncated: z.boolean(),
  longest_sun_h: z.number(),
  longest_earth_h: z.number(),
  n_sun_windows: z.int().min(0),
  n_dark_windows: z.int().min(0),
  n_earth_windows: z.int().min(0),
  n_comms_gaps: z.int().min(0),
  mean_sun_el_lit_deg: z.number().nullable(),
  mean_power_horizontal: z.number(),
  mean_power_tracking: z.number(),
  horizon_min_el_deg: z.number(),
  horizon_max_el_deg: z.number(),
});
export type SummaryRow = z.output<typeof SummaryRow>;
