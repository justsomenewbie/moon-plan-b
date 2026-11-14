/**
 * Downloads (plan 6.2 #15) - contract: src/contract/export.ts.
 *   GET /api/v1/sites/{site_id}/export/series.csv    streamed from the `series` cursor (flat memory)
 *   GET /api/v1/sites/{site_id}/export/windows.csv   clipped windows, streamed
 *   GET /api/v1/export/summary.csv                   summary.csv rows of the run (verbatim values)
 *   GET /api/v1/runs/{run_id}/files/{file_path}      raw precompute file, ETag = manifest sha256 (not compressed)
 *
 * CSVs are produced with csv-stringify's streaming API; everything that can fail (run, site, range)
 * is checked BEFORE the first byte so errors are still problem+json. @fastify/compress (app.ts)
 * gzip/brotli-encodes the stream when the client accepts it. Booleans are 1/0 and missing values
 * empty, like the Python files (OUTPUT_SPEC section 1).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { stringify, type Stringifier } from 'csv-stringify';
import { z } from 'zod';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SiteParams } from '../contract/common.ts';
import {
  CSV_CONTENT_TYPE,
  RUN_FILE_MEDIA_TYPES,
  RunFileParams,
  SeriesCsvQuery,
  SummaryCsvQuery,
  WindowsCsvQuery,
  runFileResponse,
  seriesCsvResponse,
  summaryCsvResponse,
  windowsCsvResponse,
} from '../contract/export.ts';
import { ApiError, problemResponses } from '../lib/problem.ts';
import { toIsoUtc } from '../lib/time.ts';
import { getSummary, resolveRun, streamSeries } from '../repos/index.ts';
import { SUMMARY_COLUMNS } from '../importer/schemas.ts';
import { requireSite, resolveRange, setCacheHeaders } from './series.ts';
import { CACHE_IMMUTABLE, etagMatches } from './a/http_cache.ts';
import { runDirectory } from '../python/runFiles.ts';
import { clippedWindowsByKind } from './windows.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.csv': CSV_CONTENT_TYPE,
  '.gz': RUN_FILE_MEDIA_TYPES.gzip,
};

export const WINDOWS_CSV_COLUMNS = ['kind', 'start', 'end', 'duration_h', 'state', 'truncated_start', 'truncated_end', 'clipped_start', 'clipped_end'] as const;

const attachment = (name: string) => `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, '_')}"`;

type CsvCell = string | number | boolean | null | undefined;

/** csv-stringify stream with the conventions of the precompute files (booleans 1/0, null -> empty). */
export function csvStream(columns: readonly string[]): Stringifier {
  return stringify({ header: true, columns: [...columns], cast: { boolean: (v: boolean) => (v ? '1' : '0') } });
}

/** Pipe rows (arrays) into a CSV stream; errors after the headers went out abort the response (logged). */
function sendCsv(reply: FastifyReply, log: FastifyBaseLogger, filename: string, columns: readonly string[], rows: AsyncIterable<CsvCell[]> | Iterable<CsvCell[]>) {
  const csv = csvStream(columns);
  pipeline(Readable.from(rows), csv, (err) => {
    if (err) log.error({ err }, 'CSV export stream failed');
  });
  return reply
    .type(CSV_CONTENT_TYPE)
    .header('content-disposition', attachment(filename))
    // Stream body: the zod response schema (z.string) only documents it; Fastify pipes streams unserialized.
    .send(csv as unknown as string);
}

export const exportRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/sites/:site_id/export/series.csv',
    {
      schema: {
        tags: ['export'],
        operationId: 'exportSiteSeriesCsv',
        summary: 'Download the series of a site as CSV (streamed, every sample of the range)',
        description: 'No downsampling: one row per sample of the snapped range (a full 5-year hourly run is ~44k rows). Range rules as /series.',
        params: SiteParams,
        querystring: SeriesCsvQuery,
        response: { 200: seriesCsvResponse, ...problemResponses(400, 404, 409, 422, 503) },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const siteId = req.params.site_id;
      const run = await resolveRun(q.run_id);
      const r = resolveRange(run, q.start, q.end);
      const fields = [...new Set(q.fields)];
      await requireSite(run._id, siteId);
      async function* rows(): AsyncGenerator<CsvCell[]> {
        for await (const doc of streamSeries(siteId, run, r.startMs, r.endMs, fields)) {
          const row: CsvCell[] = [toIsoUtc(doc.t)];
          for (const f of fields) row.push(doc[f] ?? null);
          yield row;
        }
      }
      setCacheHeaders(reply, q.run_id);
      return sendCsv(reply, req.log, `${siteId}_${run._id}_series.csv`, ['time_utc', ...fields], rows());
    },
  );

  app.get(
    '/sites/:site_id/export/windows.csv',
    {
      schema: {
        tags: ['export'],
        operationId: 'exportSiteWindowsCsv',
        summary: 'Download the visibility windows of a site as CSV',
        description: 'Rows grouped by kind (in the order of `kinds`), sorted by start; windows clipped to the query range as in /windows.',
        params: SiteParams,
        querystring: WindowsCsvQuery,
        response: { 200: windowsCsvResponse, ...problemResponses(400, 404, 409, 422, 503) },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const siteId = req.params.site_id;
      const run = await resolveRun(q.run_id);
      const r = resolveRange(run, q.start, q.end);
      const kinds = [...new Set(q.kinds)];
      const [, byKind] = await Promise.all([requireSite(run._id, siteId), clippedWindowsByKind(run._id, siteId, kinds, r.startMs, r.endMs)]);
      const rows: CsvCell[][] = [];
      for (const k of kinds) {
        for (const w of byKind[k] ?? []) {
          rows.push([k, w.start, w.end, w.duration_h, w.state, w.truncated_start, w.truncated_end, w.clipped_start, w.clipped_end]);
        }
      }
      setCacheHeaders(reply, q.run_id);
      return sendCsv(reply, req.log, `${siteId}_${run._id}_windows.csv`, WINDOWS_CSV_COLUMNS, rows);
    },
  );

  app.get(
    '/export/summary.csv',
    {
      schema: {
        tags: ['export'],
        operationId: 'exportSummaryCsv',
        summary: 'Download summary.csv of a run (all sites, sorted by rank)',
        description: 'Same columns and values as the summary.csv of the precompute run (docs/OUTPUT_SPEC.md 3.7).',
        querystring: SummaryCsvQuery,
        response: { 200: summaryCsvResponse, ...problemResponses(400, 404, 409, 503) },
      },
    },
    async (req, reply) => {
      const run = await resolveRun(req.query.run_id);
      const summary = await getSummary(run._id);
      const rows = summary.map((s) => SUMMARY_COLUMNS.map((c): CsvCell => s[c]));
      setCacheHeaders(reply, req.query.run_id);
      return sendCsv(reply, req.log, `${run._id}_summary.csv`, SUMMARY_COLUMNS, rows);
    },
  );

  app.get(
    '/runs/:run_id/files/:file_path',
    {
      schema: {
        tags: ['export'],
        operationId: 'getRunFile',
        summary: 'Download a raw precompute file of a run',
        description:
          'file_path must be `manifest.json` or one of RunDetail.manifest.files[].path, URL-encoded (sites%2Fapollo11%2Fwindows.json). ' +
          'ETag = the sha256 of the file (from the manifest, strong: the body is never re-encoded by the server); If-None-Match -> 304. ' +
          'Content-Type from the extension: .json application/json, .csv text/csv, .csv.gz application/gzip, else application/octet-stream.',
        params: RunFileParams,
        response: {
          200: runFileResponse,
          304: z.undefined().describe('Not modified (If-None-Match matched the ETag)'),
          ...problemResponses(400, 404, 409, 503),
        },
      },
      // raw bytes as stored: keeps Content-Length and the strong sha256 ETag valid (.gz files are compressed already)
      compress: false,
    },
    async (req, reply) => {
      const { run_id, file_path } = req.params;
      const run = await resolveRun(run_id);
      const sha = file_path === 'manifest.json' ? run.manifest_sha256 : (run.manifest.files[file_path] ?? null);
      if (sha === null) throw new ApiError('FILE_NOT_FOUND', `${file_path} is not a file of run ${run_id}`, { hint: 'GET /api/v1/runs/{run_id} lists manifest.files' });
      const runDir = runDirectory(run, app.config.DATA_DIR);
      const abs = path.resolve(runDir, ...file_path.split('/'));
      if (!abs.startsWith(runDir + path.sep)) throw new ApiError('FILE_NOT_FOUND', 'invalid path');
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) throw new ApiError('FILE_NOT_FOUND', `${file_path} is listed in the manifest but not present in the run directory`);
      const etag = `"${sha}"`;
      reply.header('etag', etag).header('cache-control', CACHE_IMMUTABLE);
      if (etagMatches(req.headers['if-none-match'], etag)) return reply.status(304).send();
      const ext = file_path.endsWith('.csv.gz') ? '.gz' : path.extname(file_path);
      return reply
        .type(CONTENT_TYPES[ext] ?? 'application/octet-stream')
        .header('content-length', st.size)
        .header('content-disposition', attachment(path.basename(file_path)))
        // Binary stream body: the zod response schema (z.string) only documents it; Fastify pipes streams unserialized.
        .send(createReadStream(abs) as unknown as string);
    },
  );
};

export default exportRoutes;
