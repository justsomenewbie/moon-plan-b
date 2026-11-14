/**
 * Data-access layer shared by the read routes (runs, sites, horizon, series, instant, windows,
 * compare, ranking, export). Reads the collections written by the importer (src/importer/).
 *
 * Conventions
 * - Every function uses the connected singleton (db.ts getDb()); without MongoDB they throw the
 *   503 SERVICE_UNAVAILABLE ApiError of getDb().
 * - Instants are epoch milliseconds in arguments and BSON Dates in returned documents; convert to
 *   the wire format with lib/time.ts toIsoUtc(). Ranges are [fromMs, toMs) (end EXCLUSIVE) and are
 *   expected to be snapped to the run grid already (lib/time.ts snapRange()).
 * - Functions return null / [] for "not found"; only resolveRun() throws problem errors
 *   (RUN_NOT_FOUND / RUN_NOT_READY), so routes decide which 404 to raise for sites.
 * - Field names are the snake_case names of docs/OUTPUT_SPEC.md (types in ./types.ts).
 */
import type { Document, Filter } from 'mongodb';
import { ApiError, runNotFound } from '../lib/problem.ts';
import { toIsoUtc } from '../lib/time.ts';
import { WINDOW_KINDS, type WindowKind } from '../contract/common.ts';
import { BOOLEAN_SERIES_FIELDS, SERIES_FIELDS, type SeriesFieldName } from '../contract/series.ts';
import { dataCollections } from './collections.ts';
import type { HorizonDoc, RunDoc, RunKind, RunStatus, SeriesDoc, SeriesSample, SeriesValue, SiteDoc, SiteRunDoc, SummaryRow, WindowDoc } from './types.ts';

export * from './types.ts';
export { dataCollections, ensureDataCollections, siteRunId, SERIES_QUERY_INDEX } from './collections.ts';

const SERIES_FIELD_SET: ReadonlySet<string> = new Set(SERIES_FIELDS);

// =================================================================================================
// runs
// =================================================================================================

export interface ListRunsOptions {
  kind?: RunKind;
  /** Default: every status (the /runs contract shows status). */
  status?: RunStatus;
}

/** All runs, default run first, then most recently imported first. Includes the full manifest. */
export async function listRuns(opts: ListRunsOptions = {}): Promise<RunDoc[]> {
  const filter: Filter<RunDoc> = {};
  if (opts.kind) filter.kind = opts.kind;
  if (opts.status) filter.status = opts.status;
  return dataCollections().runs.find(filter).sort({ is_default: -1, imported_at: -1, _id: 1 }).toArray();
}

/** One run by id (any status), or null. */
export async function getRun(runId: string): Promise<RunDoc | null> {
  return dataCollections().runs.findOne({ _id: runId });
}

/**
 * Id of the default run: the `ready` run flagged is_default; if none is flagged, the most recently
 * imported ready precompute run; null when there is no ready run at all.
 */
export async function getDefaultRunId(): Promise<string | null> {
  const { runs } = dataCollections();
  const flagged = await runs.findOne({ is_default: true, status: 'ready' }, { projection: { _id: 1 } });
  if (flagged) return flagged._id;
  const latest = await runs.find({ status: 'ready', kind: 'precompute' }, { projection: { _id: 1 } }).sort({ imported_at: -1 }).limit(1).next();
  return latest?._id ?? null;
}

/**
 * The run a data request reads: `runId` or, when omitted, the default run.
 * Throws ApiError RUN_NOT_FOUND (unknown id / no default run) or RUN_NOT_READY (importing / failed).
 */
export async function resolveRun(runId?: string): Promise<RunDoc> {
  const id = runId ?? (await getDefaultRunId());
  if (id === null) throw new ApiError('RUN_NOT_FOUND', 'no run has been imported yet (npm run import -- <dir> --default)');
  const run = await getRun(id);
  if (!run) throw runNotFound(id);
  if (run.status !== 'ready') {
    throw new ApiError('RUN_NOT_READY', `run ${id} is ${run.status}${run.error ? `: ${run.error}` : ''}`, { extensions: { run_status: run.status } });
  }
  return run;
}

// =================================================================================================
// sites (site_runs joined with the global sites catalog)
// =================================================================================================

/** A site as seen in one run: per-run record/metrics/rank + global catalog data (map, extra). */
export interface SiteView {
  site_run: SiteRunDoc;
  /** Global site doc (null only if the catalog row is missing - should not happen after an import). */
  site: SiteDoc | null;
}

async function joinSites(siteRuns: SiteRunDoc[]): Promise<SiteView[]> {
  if (siteRuns.length === 0) return [];
  const ids = [...new Set(siteRuns.map((s) => s.site_id))];
  const docs = await dataCollections().sites.find({ _id: { $in: ids } }).toArray();
  const byId = new Map(docs.map((d) => [d._id, d]));
  return siteRuns.map((sr) => ({ site_run: sr, site: byId.get(sr.site_id) ?? null }));
}

export interface ListSitesOptions {
  /** Catalog group filter (`south_pole`, `reference`, ...; custom sites have group ""). */
  group?: string;
}

/** Sites of a run sorted by rank (1 = best, default weights). */
export async function listSites(runId: string, opts: ListSitesOptions = {}): Promise<SiteView[]> {
  const filter: Filter<SiteRunDoc> = { run_id: runId };
  if (opts.group !== undefined) filter['record.group'] = opts.group;
  const srs = await dataCollections().site_runs.find(filter).sort({ rank: 1 }).toArray();
  return joinSites(srs);
}

/** One site of a run, or null when the site is not part of the run. */
export async function getSite(runId: string, siteId: string): Promise<SiteView | null> {
  const sr = await dataCollections().site_runs.findOne({ run_id: runId, site_id: siteId });
  if (!sr) return null;
  const [view] = await joinSites([sr]);
  return view ?? null;
}

/** Several sites of a run, in the order of `siteIds`; ids not in the run are omitted (compare their lengths). */
export async function getSites(runId: string, siteIds: readonly string[]): Promise<SiteView[]> {
  const srs = await dataCollections().site_runs.find({ run_id: runId, site_id: { $in: [...siteIds] } }).toArray();
  const byId = new Map(srs.map((s) => [s.site_id, s]));
  const ordered = siteIds.map((id) => byId.get(id)).filter((s): s is SiteRunDoc => s !== undefined);
  return joinSites(ordered);
}

/**
 * summary.csv rows of a run (OUTPUT_SPEC 3.7, values verbatim = Python's ranking with the run's
 * rank_weights over the full range), sorted by rank. Optional group filter (ranks are NOT renumbered).
 */
export async function getSummary(runId: string, opts: ListSitesOptions = {}): Promise<SummaryRow[]> {
  const filter: Filter<SiteRunDoc> = { run_id: runId };
  if (opts.group !== undefined) filter['record.group'] = opts.group;
  const rows = await dataCollections().site_runs.find(filter, { projection: { summary: 1, rank: 1 } }).sort({ rank: 1 }).toArray();
  return rows.map((r) => r.summary);
}

/** Horizon profile of a site in a run (full resolution), or null. */
export async function getHorizon(runId: string, siteId: string): Promise<HorizonDoc | null> {
  return dataCollections().horizons.findOne({ run_id: runId, site_id: siteId });
}

// =================================================================================================
// windows
// =================================================================================================

export interface WindowsRange {
  /** Inclusive query start, epoch ms (default: no lower bound). */
  fromMs?: number;
  /** EXCLUSIVE query end, epoch ms (default: no upper bound). */
  toMs?: number;
  /** Default: sun, earth, both. */
  kinds?: readonly WindowKind[];
}

/**
 * Windows overlapping [fromMs, toMs) (`start < toMs AND end > fromMs`), grouped by kind, each list
 * sorted by start. NOT clipped: clipping to the query range (clipped_start/clipped_end) is done by
 * the caller. Only the requested kinds are present as keys.
 */
export async function getWindows(runId: string, siteId: string, range: WindowsRange = {}): Promise<Partial<Record<WindowKind, WindowDoc[]>>> {
  const kinds = range.kinds ?? WINDOW_KINDS;
  const filter: Filter<WindowDoc> = { run_id: runId, site_id: siteId, kind: { $in: [...kinds] } };
  if (range.toMs !== undefined) filter.start = { $lt: new Date(range.toMs) };
  if (range.fromMs !== undefined) filter.end = { $gt: new Date(range.fromMs) };
  const docs = await dataCollections().windows.find(filter).sort({ kind: 1, start: 1 }).toArray();
  const out: Partial<Record<WindowKind, WindowDoc[]>> = {};
  for (const k of kinds) out[k] = [];
  for (const d of docs) out[d.kind]?.push(d);
  return out;
}

// =================================================================================================
// series (time-series collection)
// =================================================================================================

/** The run grid a series query needs (a RunDoc satisfies it). */
export type RunGrid = Pick<RunDoc, '_id' | 'step_s'>;

export type SeriesAggMode = 'sample' | 'minmax';

export interface Downsample {
  /** Bin width in seconds: a positive multiple of run.step_s (use chooseBinS()). Default step_s. */
  bin_s?: number;
  /** sample (default): first sample of each bin; minmax: min/max per bin (booleans -> fraction true). */
  agg?: SeriesAggMode;
}

export interface MinMaxColumn {
  min: (number | null)[];
  max: (number | null)[];
}

/**
 * Columnar series. Point i is at start_ms + i * bin_s * 1000; every column has length n.
 * Missing samples / bins (outside the stored range) are null.
 * agg=sample: number|boolean|null per point. agg=minmax: numeric fields -> {min, max};
 * boolean fields -> fraction of true samples in the bin (0..1, null for an empty bin).
 */
export interface SeriesColumns {
  start_ms: number;
  end_ms: number;
  step_s: number;
  bin_s: number;
  n: number;
  agg: SeriesAggMode;
  fields: Record<string, SeriesValue[] | MinMaxColumn>;
}

/** Smallest bin (multiple of stepS) giving <= maxPoints points for nSamples samples. */
export function chooseBinS(nSamples: number, stepS: number, maxPoints: number): number {
  if (maxPoints < 1) throw new RangeError('maxPoints must be >= 1');
  return stepS * Math.max(1, Math.ceil(nSamples / maxPoints));
}

function assertFields(fields: readonly string[]): void {
  for (const f of fields) if (!SERIES_FIELD_SET.has(f)) throw new RangeError(`unknown series field: ${f}`);
}

const seriesMatch = (siteId: string, run: RunGrid, fromMs: number, toMs: number): Filter<SeriesDoc> => ({
  'meta.run_id': run._id,
  'meta.site_id': siteId,
  t: { $gte: new Date(fromMs), $lt: new Date(toMs) },
});

/**
 * Values of `fields` for one site in [fromMs, toMs), optionally downsampled into bins.
 * Exact stored values (floats round-trip the CSV text exactly) when bin_s = step_s and agg=sample.
 * Throws RangeError for an unknown field or a bin_s that is not a positive multiple of step_s.
 */
export async function getSeries(
  siteId: string,
  run: RunGrid,
  fromMs: number,
  toMs: number,
  fields: readonly SeriesFieldName[],
  downsample: Downsample = {},
): Promise<SeriesColumns> {
  assertFields(fields);
  const stepS = run.step_s;
  const binS = downsample.bin_s ?? stepS;
  const agg = downsample.agg ?? 'sample';
  if (!Number.isInteger(binS / stepS) || binS < stepS) throw new RangeError(`bin_s ${binS} is not a positive multiple of step_s ${stepS}`);
  const binMs = binS * 1000;
  const n = Math.max(0, Math.ceil((toMs - fromMs) / binMs));
  const out: SeriesColumns = { start_ms: fromMs, end_ms: toMs, step_s: stepS, bin_s: binS, n, agg, fields: {} };
  if (n === 0) return out;
  const { series } = dataCollections();
  const match = seriesMatch(siteId, run, fromMs, toMs);

  if (agg === 'sample' && binS === stepS) {
    const cols: Record<string, SeriesValue[]> = {};
    for (const f of fields) cols[f] = new Array<SeriesValue>(n).fill(null);
    const projection: Document = { _id: 0, t: 1 };
    for (const f of fields) projection[f] = 1;
    const cursor = series.find(match, { projection }).sort({ t: 1 });
    for await (const doc of cursor) {
      const i = Math.floor((doc.t.getTime() - fromMs) / binMs);
      if (i < 0 || i >= n) continue;
      for (const f of fields) (cols[f] as SeriesValue[])[i] = doc[f] ?? null;
    }
    out.fields = cols;
    return out;
  }

  const group: Document = { _id: { $toLong: { $floor: { $divide: [{ $subtract: ['$t', new Date(fromMs)] }, binMs] } } } };
  for (const f of fields) {
    if (agg === 'sample') group[f] = { $first: `$${f}` };
    else if (BOOLEAN_SERIES_FIELDS.has(f)) group[f] = { $avg: { $cond: [{ $eq: [`$${f}`, true] }, 1, 0] } };
    else {
      group[`${f}__min`] = { $min: `$${f}` };
      group[`${f}__max`] = { $max: `$${f}` };
    }
  }
  const rows = await series.aggregate<Document>([{ $match: match }, { $sort: { t: 1 } }, { $group: group }]).toArray();
  const cols: Record<string, SeriesValue[] | MinMaxColumn> = {};
  for (const f of fields) {
    cols[f] = agg === 'minmax' && !BOOLEAN_SERIES_FIELDS.has(f)
      ? { min: new Array<number | null>(n).fill(null), max: new Array<number | null>(n).fill(null) }
      : new Array<SeriesValue>(n).fill(null);
  }
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  for (const r of rows) {
    const i = Number(r['_id']);
    if (!Number.isInteger(i) || i < 0 || i >= n) continue;
    for (const f of fields) {
      const col = cols[f];
      if (col === undefined) continue;
      if (Array.isArray(col)) {
        const v: unknown = r[f];
        col[i] = typeof v === 'number' || typeof v === 'boolean' ? v : null;
      } else {
        col.min[i] = num(r[`${f}__min`]);
        col.max[i] = num(r[`${f}__max`]);
      }
    }
  }
  out.fields = cols;
  return out;
}

/** One stored sample at exactly `sampleMs` (a grid instant: snap t down first), all columns; or null. */
export async function getSample(siteId: string, run: RunGrid, sampleMs: number): Promise<(SeriesSample & { t: Date }) | null> {
  const doc = await dataCollections().series.findOne(
    { 'meta.run_id': run._id, 'meta.site_id': siteId, t: new Date(sampleMs) },
    { projection: { _id: 0, meta: 0 } },
  );
  return doc ?? null;
}

export type SeriesRow = { t: Date } & Partial<SeriesSample>;

/**
 * Stream the samples of [fromMs, toMs) in time order (CSV export). `fields` default = all columns.
 * Memory stays flat (cursor batches); stop early by breaking out of the for-await loop.
 */
export async function* streamSeries(siteId: string, run: RunGrid, fromMs: number, toMs: number, fields: readonly SeriesFieldName[] = SERIES_FIELDS): AsyncGenerator<SeriesRow> {
  assertFields(fields);
  const projection: Document = { _id: 0, t: 1 };
  for (const f of fields) projection[f] = 1;
  const cursor = dataCollections().series.find(seriesMatch(siteId, run, fromMs, toMs), { projection, batchSize: 5000 }).sort({ t: 1 });
  try {
    for await (const doc of cursor) yield doc as SeriesRow;
  } finally {
    await cursor.close();
  }
}

/** Per-site sums of the series columns the range metrics need (mean sun elevation over lit samples, mean power). */
export interface SeriesSums {
  /** samples in the range (must equal i1 - i0) */
  n: number;
  /** samples with sun_visible */
  n_lit: number;
  /** sum of sun_el_deg over lit samples */
  sum_sun_el_lit: number;
  sum_power_horizontal: number;
  sum_power_tracking: number;
}

/** One $group aggregation over `series` for several sites of a run in [fromMs, toMs). Sites without samples are absent. */
export async function seriesSums(runId: string, siteIds: readonly string[], fromMs: number, toMs: number): Promise<Map<string, SeriesSums>> {
  const rows = await dataCollections()
    .series.aggregate<SeriesSums & { _id: string }>([
      { $match: { 'meta.run_id': runId, 'meta.site_id': { $in: [...siteIds] }, t: { $gte: new Date(fromMs), $lt: new Date(toMs) } } },
      {
        $group: {
          _id: '$meta.site_id',
          n: { $sum: 1 },
          n_lit: { $sum: { $cond: [{ $eq: ['$sun_visible', true] }, 1, 0] } },
          sum_sun_el_lit: { $sum: { $cond: [{ $eq: ['$sun_visible', true] }, '$sun_el_deg', 0] } },
          sum_power_horizontal: { $sum: '$power_horizontal' },
          sum_power_tracking: { $sum: '$power_tracking' },
        },
      },
    ])
    .toArray();
  return new Map(rows.map(({ _id, ...s }) => [_id, s]));
}

/** Convenience for routes: Date -> wire ISO string (`YYYY-MM-DDTHH:MM:SSZ`). */
export const iso = (d: Date): string => toIsoUtc(d);
