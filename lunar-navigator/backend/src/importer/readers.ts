/**
 * Readers turning one precompute file into MongoDB documents (plan section 8 steps 6-7).
 * Pure with respect to the database: they only build docs / hand batches to a sink, so the same code
 * runs for a real import and for --dry-run.
 */
import { SERIES_FIELD_INFO } from '../contract/series.ts';
import type { WindowKind } from '../contract/common.ts';
import { WINDOW_KINDS } from '../contract/common.ts';
import { parseIsoUtc } from '../lib/time.ts';
import { siteRunId, windowDocId } from '../repos/collections.ts';
import type { HorizonDoc, SeriesDoc, SeriesValue, SiteRecordDoc, WindowDoc } from '../repos/types.ts';
import { CsvFormatError, columnIndex, csvRecords, parseBoolCell, parseNumberCell, parseRequiredNumber, readCsvObjects } from './csv.ts';
import { SUMMARY_COLUMNS, SummaryRow, summaryColumnKind, type SiteRecordFile, type WindowsFile } from './schemas.ts';

// ---- series (visibility.csv.gz) ------------------------------------------------------------------
export const VISIBILITY_COLUMNS = ['time_utc', ...SERIES_FIELD_INFO.map((f) => f.name)] as const;

export interface SeriesGrid {
  startMs: number;
  stepS: number;
  nSamples: number;
}

export interface SeriesReadStats {
  rows: number;
  /** count of true per boolean column (post-check vs metrics). */
  trueCounts: Record<'sun_visible' | 'earth_visible' | 'both_visible', number>;
}

type ColumnParser = (s: string, where: string) => SeriesValue;
const nullableNumber: ColumnParser = parseNumberCell;
const requiredNumber: ColumnParser = parseRequiredNumber;
const bool: ColumnParser = parseBoolCell;

/**
 * Stream visibility.csv.gz -> SeriesDoc batches. Checks the header, the uniform time grid
 * (t_k = start + k*step) and the row count (n_samples). `sink` receives each batch (awaited with one
 * batch of lookahead so parsing overlaps the previous insert).
 */
export async function readSeries(
  file: string,
  meta: { run_id: string; site_id: string },
  grid: SeriesGrid,
  batchSize: number,
  sink: (docs: SeriesDoc[]) => Promise<void>,
): Promise<SeriesReadStats> {
  const stepMs = grid.stepS * 1000;
  let parsers: { name: string; i: number; parse: ColumnParser }[] = [];
  let timeIdx = 0;
  let k = 0;
  let batch: SeriesDoc[] = [];
  let pending: Promise<void> | null = null;
  const trueCounts = { sun_visible: 0, earth_visible: 0, both_visible: 0 };
  let header = true;
  for await (const rec of csvRecords(file)) {
    if (header) {
      header = false;
      const idx = columnIndex(rec, VISIBILITY_COLUMNS, file);
      timeIdx = idx.get('time_utc') ?? 0;
      parsers = SERIES_FIELD_INFO.map((f) => ({
        name: f.name,
        i: idx.get(f.name) ?? -1,
        parse: f.type === 'boolean' ? bool : f.nullable ? nullableNumber : requiredNumber,
      }));
      continue;
    }
    const where = `${file} row ${k + 1}`;
    const ts = rec[timeIdx] ?? '';
    const expected = grid.startMs + k * stepMs;
    if (ts.length !== 20 || !ts.endsWith('Z') || Date.parse(ts) !== expected) {
      throw new CsvFormatError(`${where}: time_utc ${JSON.stringify(ts)} is not on the run grid (expected ${new Date(expected).toISOString().replace('.000Z', 'Z')})`);
    }
    // meta built fresh with a fixed key order: time-series buckets compare meta objects field by field.
    const doc: Record<string, unknown> = { t: new Date(expected), meta: { run_id: meta.run_id, site_id: meta.site_id } };
    for (const p of parsers) doc[p.name] = p.parse(rec[p.i] ?? '', `${where} ${p.name}`);
    if (doc['sun_visible'] === true) trueCounts.sun_visible += 1;
    if (doc['earth_visible'] === true) trueCounts.earth_visible += 1;
    if (doc['both_visible'] === true) trueCounts.both_visible += 1;
    batch.push(doc as SeriesDoc);
    k += 1;
    if (k > grid.nSamples) throw new CsvFormatError(`${file}: more than n_samples=${grid.nSamples} rows`);
    if (batch.length >= batchSize) {
      if (pending) await pending;
      pending = sink(batch);
      batch = [];
    }
  }
  if (pending) await pending;
  if (batch.length > 0) await sink(batch);
  if (k !== grid.nSamples) throw new CsvFormatError(`${file}: ${k} rows, expected n_samples=${grid.nSamples}`);
  return { rows: k, trueCounts };
}

// ---- horizon_<method>.csv ------------------------------------------------------------------------
export async function readHorizon(file: string, runId: string, rec: SiteRecordFile): Promise<HorizonDoc> {
  const { header, rows } = await readCsvObjects(file);
  columnIndex(header, ['az_deg', 'el_deg', 'covered_radius_km'], file);
  const az: number[] = [];
  const el: number[] = [];
  const cov: number[] = [];
  rows.forEach((r, i) => {
    const w = `${file} row ${i + 1}`;
    az.push(parseRequiredNumber(r['az_deg'] ?? '', `${w} az_deg`));
    el.push(parseRequiredNumber(r['el_deg'] ?? '', `${w} el_deg`));
    cov.push(parseRequiredNumber(r['covered_radius_km'] ?? '', `${w} covered_radius_km`));
  });
  if (az.length < 2) throw new CsvFormatError(`${file}: fewer than 2 azimuths`);
  const step = Math.round(((az[1] ?? 0) - (az[0] ?? 0)) * 1e9) / 1e9;
  return {
    _id: siteRunId(runId, rec.id),
    run_id: runId,
    site_id: rec.id,
    method: rec.horizon_method,
    dem_source: rec.dem_source,
    az_step_deg: step,
    az_deg: az,
    el_deg: el,
    covered_radius_km: cov,
    min_el_deg: rec.horizon_min_el_deg,
    max_el_deg: rec.horizon_max_el_deg,
  };
}

// ---- windows.json --------------------------------------------------------------------------------
export function windowDocs(runId: string, siteId: string, w: WindowsFile): { docs: WindowDoc[]; counts: Record<WindowKind, number> } {
  const docs: WindowDoc[] = [];
  const counts = { sun: 0, earth: 0, both: 0 } satisfies Record<WindowKind, number>;
  for (const kind of WINDOW_KINDS) {
    for (const x of w[kind]) {
      docs.push({
        _id: windowDocId(runId, siteId, kind, x.start_index),
        run_id: runId,
        site_id: siteId,
        kind,
        state: x.state,
        start: new Date(parseIsoUtc(x.start)),
        end: new Date(parseIsoUtc(x.end)),
        duration_h: x.duration_h,
        start_index: x.start_index,
        end_index: x.end_index,
        truncated_start: x.truncated_start,
        truncated_end: x.truncated_end,
      });
      counts[kind] += 1;
    }
  }
  return { docs, counts };
}

// ---- summary.csv ---------------------------------------------------------------------------------
export async function readSummary(file: string): Promise<Map<string, SummaryRow>> {
  const { header, rows } = await readCsvObjects(file);
  columnIndex(header, SUMMARY_COLUMNS, file);
  const out = new Map<string, SummaryRow>();
  rows.forEach((r, i) => {
    const w = `${file} row ${i + 1}`;
    const o: Record<string, unknown> = {};
    for (const c of SUMMARY_COLUMNS) {
      const s = r[c] ?? '';
      switch (summaryColumnKind(c)) {
        case 'string':
          o[c] = s;
          break;
        case 'bool':
          o[c] = parseBoolCell(s, `${w} ${c}`);
          break;
        case 'nullable_number':
          o[c] = parseNumberCell(s, `${w} ${c}`);
          break;
        default:
          o[c] = parseRequiredNumber(s, `${w} ${c}`);
      }
    }
    const parsed = SummaryRow.safeParse(o);
    if (!parsed.success) throw new CsvFormatError(`${w}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    if (out.has(parsed.data.site_id)) throw new CsvFormatError(`${w}: duplicate site_id ${parsed.data.site_id}`);
    out.set(parsed.data.site_id, parsed.data);
  });
  return out;
}

/** sites.json record without the `files` member. */
export function recordWithoutFiles(rec: SiteRecordFile): SiteRecordDoc {
  const { files: _files, ...rest } = rec;
  return rest;
}
