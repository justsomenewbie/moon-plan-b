/**
 * MongoDB document shapes (plan section 5.3), written by the importer (src/importer/) and read by the
 * repos (src/repos/index.ts). Field names = docs/OUTPUT_SPEC.md (snake_case); instants are BSON Dates
 * in Mongo (convert with lib/time.ts toIsoUtc() at the HTTP boundary), except strings copied verbatim
 * from the manifest (run_timestamp_utc).
 */
import type { MapPoint, Metrics, WindowKind } from '../contract/common.ts';
import type { SeriesFieldName } from '../contract/series.ts';
import type { ManifestFile, SiteFiles, SiteRecordCore, SiteRecordFile, SummaryRow } from '../importer/schemas.ts';
import type { z } from 'zod';

export type { ManifestFile, SiteFiles, SiteRecordCore, SiteRecordFile, SummaryRow };
export type RunKind = 'precompute' | 'custom';
export type RunStatus = 'importing' | 'ready' | 'failed';
export type MapPointValue = z.output<typeof MapPoint>;

/** Counts measured by the importer after writing (post-check) + timing. */
export interface ImportStats {
  n_sites: number;
  series_docs: number;
  windows_docs: number;
  horizons_docs: number;
  duration_ms: number;
}

/** `runs`: one precompute directory (manifest.json). `_id` = run_id. */
export interface RunDoc {
  _id: string;
  kind: RunKind;
  is_default: boolean;
  label: string;
  status: RunStatus;
  /** Failure reason when status = failed, else null. */
  error: string | null;
  /** manifest.json verbatim (parsed). */
  manifest: ManifestFile;
  /** sha256 of the manifest.json bytes: idempotency key of the import. */
  manifest_sha256: string;
  params_fingerprint: string;
  code_version: string;
  git_commit: string | null;
  run_timestamp_utc: string;
  provider: string;
  dem: string;
  horizon_method: string;
  /** Run range [start, end) and grid (from manifest.parameters). */
  start: Date;
  end: Date;
  step_s: number;
  n_samples: number;
  observer_height_m: number;
  min_earth_clearance_deg: number;
  rank_weights: Record<string, number>;
  /** In sites.json order (= parameters.site_ids). */
  site_ids: string[];
  n_sites: number;
  /** Absolute directory holding the raw files (normally DATA_DIR/runs/<run_id>/). */
  source_dir: string;
  started_at: Date;
  /** Set when status becomes ready. */
  imported_at: Date | null;
  /** custom runs: delete after this instant; null = keep. */
  expires_at: Date | null;
  stats: ImportStats | null;
}

/** `sites`: one site of the catalog or a custom site (global, not per run). `_id` = site_id. */
export interface SiteDoc {
  _id: string;
  name: string;
  group: string;
  origin: 'catalog' | 'custom';
  lat_deg: number;
  lon_deg: number;
  source: string | null;
  note: string | null;
  /** lunarnav/catalog/sites.json `extra` (accuracy, region_corners_latlon, ...); null for custom/unknown sites. */
  extra: Record<string, unknown> | null;
  /** South polar stereographic position (null north of 60 S). */
  map: MapPointValue | null;
  updated_at: Date;
}

/** sites.json record without `files`. */
export type SiteRecordDoc = SiteRecordCore;

/** `site_runs`: one (run, site). `_id` = `${run_id}|${site_id}`. */
export interface SiteRunDoc {
  _id: string;
  run_id: string;
  site_id: string;
  record: SiteRecordDoc;
  /** Relative paths inside RunDoc.source_dir (from sites.json `files`). */
  files: SiteFiles;
  /** windows.json metrics verbatim (full run range). */
  metrics: Metrics;
  /** summary.csv rank / score (default weights). */
  rank: number;
  score: number;
  /** summary.csv row, typed. */
  summary: SummaryRow;
  range_start: Date;
  range_end: Date;
  n_samples: number;
  step_s: number;
  min_earth_clearance_deg: number;
  n_windows: Record<WindowKind, number>;
}

/** `horizons`: one (run, site). `_id` = `${run_id}|${site_id}`. */
export interface HorizonDoc {
  _id: string;
  run_id: string;
  site_id: string;
  method: string;
  dem_source: string;
  az_step_deg: number;
  az_deg: number[];
  el_deg: number[];
  covered_radius_km: number[];
  min_el_deg: number;
  max_el_deg: number;
}

/** `windows`: one window. `_id` = `${run_id}|${site_id}|${kind}|${start_index}`. */
export interface WindowDoc {
  _id: string;
  run_id: string;
  site_id: string;
  kind: WindowKind;
  state: boolean;
  start: Date;
  /** EXCLUSIVE. */
  end: Date;
  duration_h: number;
  start_index: number;
  end_index: number;
  truncated_start: boolean;
  truncated_end: boolean;
}

export type SeriesValue = number | boolean | null;
export interface SeriesMeta {
  run_id: string;
  site_id: string;
}
/** All visibility.csv.gz columns except time_utc: numbers (null = empty CSV field) and booleans. */
export type SeriesSample = Record<SeriesFieldName, SeriesValue>;

/** `series` (time-series collection, timeField t, metaField meta): one hourly sample. */
export type SeriesDoc = { t: Date; meta: SeriesMeta } & SeriesSample;
