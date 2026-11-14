/**
 * Downloads (plan 6.2 #15): CSV exports + raw precompute files.
 *   GET /api/v1/sites/{site_id}/export/series.csv
 *   GET /api/v1/sites/{site_id}/export/windows.csv
 *   GET /api/v1/export/summary.csv
 *   GET /api/v1/runs/{run_id}/files/{file_path}     (file_path URL-encoded, e.g. sites%2Fapollo11%2Fwindows.json)
 */
import { z } from 'zod';
import { IsoUtcInput, RunId, WindowKind, csvList, runIdQuery } from './common.ts';
import { SeriesField, SERIES_FIELDS } from './series.ts';

export const CSV_MEDIA_TYPE = 'text/csv';
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

export const SeriesCsvQuery = z.strictObject({
  run_id: runIdQuery,
  start: IsoUtcInput.optional(),
  end: IsoUtcInput.optional().describe('EXCLUSIVE end'),
  fields: csvList(SeriesField, {
    min: 1,
    max: SERIES_FIELDS.length,
    default: SERIES_FIELDS.join(','),
    description: 'Comma separated columns (default: all visibility columns); time_utc is always first',
  }),
});
export type SeriesCsvQuery = z.output<typeof SeriesCsvQuery>;

export const WindowsCsvQuery = z.strictObject({
  run_id: runIdQuery,
  start: IsoUtcInput.optional(),
  end: IsoUtcInput.optional().describe('EXCLUSIVE end'),
  kinds: csvList(WindowKind, { min: 1, max: 3, default: 'sun,earth,both', description: 'Comma separated window kinds' }),
});
export type WindowsCsvQuery = z.output<typeof WindowsCsvQuery>;

export const SummaryCsvQuery = z.strictObject({ run_id: runIdQuery });

export const RunFileParams = z.strictObject({
  run_id: RunId,
  file_path: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_.:\-/]+$/)
    .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''), 'invalid path segment')
    .describe('Path relative to the run directory, exactly as listed in RunDetail.manifest.files[].path (URL-encode "/" as %2F)'),
});

const csvBody = (description: string, example: string) => ({
  description,
  content: { [CSV_MEDIA_TYPE]: { schema: z.string().meta({ examples: [example] }) } },
});

export const seriesCsvResponse = csvBody(
  'CSV, one row per sample: time_utc + requested columns (booleans 1/0, missing empty) - same format as visibility.csv.gz',
  'time_utc,sun_el_deg,sun_visible\n2026-01-01T00:00:00Z,0.805135,1\n2026-01-01T01:00:00Z,0.805347,1\n',
);
export const windowsCsvResponse = csvBody(
  'CSV, one row per (clipped) window: kind,start,end,duration_h,state,truncated_start,truncated_end,clipped_start,clipped_end',
  'kind,start,end,duration_h,state,truncated_start,truncated_end,clipped_start,clipped_end\nsun,2026-01-01T00:00:00Z,2026-03-29T00:00:00Z,2088,1,1,0,0,0\n',
);
export const summaryCsvResponse = csvBody(
  'summary.csv of the run (docs/OUTPUT_SPEC.md 3.7), sorted by rank',
  'rank,site_id,name,group,lat_deg,lon_deg,surface_height_m,score,pct_sun,pct_earth,pct_both\n1,ref_connecting_ridge_c1,"Shackleton-de Gerlache connecting ridge, point C1",reference,-89.4505,222.84,1957.291,71.162037,98.564815,53.611111,52.175926\n',
);
/** Content-Type of a raw run file, by extension (routes/export.ts). */
export const RUN_FILE_MEDIA_TYPES = {
  json: 'application/json',
  csv: CSV_MEDIA_TYPE,
  gzip: 'application/gzip',
  other: 'application/octet-stream',
} as const;

const rawBytes = (what: string) => z.string().describe(`${what} (raw file bytes)`);
export const runFileResponse = {
  description:
    'Raw file bytes, never re-encoded (no Content-Encoding). ETag = "<sha256 from the manifest>"; Content-Type from the extension: ' +
    '.json -> application/json, .csv -> text/csv, .csv.gz -> application/gzip, anything else -> application/octet-stream',
  content: {
    [RUN_FILE_MEDIA_TYPES.json]: { schema: rawBytes('manifest.json, sites.json, windows.json') },
    [RUN_FILE_MEDIA_TYPES.csv]: { schema: rawBytes('summary.csv, horizon_*.csv') },
    [RUN_FILE_MEDIA_TYPES.gzip]: { schema: rawBytes('visibility.csv.gz, ephemeris_*.csv.gz') },
    [RUN_FILE_MEDIA_TYPES.other]: { schema: rawBytes('other files') },
  },
};
