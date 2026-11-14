/**
 * importRun(): one precompute output directory (docs/OUTPUT_SPEC.md) -> MongoDB (plan section 8).
 *
 *  1. read manifest.json (+ sha256 of its bytes = idempotency key)
 *  2. run_id = opts.runId ?? `pf_<params_fingerprint>`
 *  3. idempotency: run already `ready` with the same manifest_sha256 -> no-op (unless force);
 *     checked BEFORE the gate so a repeated import costs milliseconds, not a full Python check
 *  4. gate: `python -m lunarnav.cli check <dir>` must report 0 violations (refuse unless force)
 *  5. verify the sha256 of every file listed in manifest.files (refuse unless force)
 *  6. copy the directory to DATA_DIR/runs/<run_id>/ (kept as the source of truth for raw downloads)
 *  7. runs.status = importing; delete the previous data of run_id in every collection
 *  8. sites (upsert, catalog extra + map), site_runs, horizons, windows, series (streamed in batches)
 *  9. post-check: counts in MongoDB = files; Sun/Earth/both percentages recomputed from the stored
 *     series = windows.json metrics; summary.csv = windows.json metrics. Mismatch -> status failed
 * 10. status = ready (+ is_default when requested)
 *
 * The same function serves the CLI (scripts/import-run.ts) and the jobs worker (kind 'custom').
 * `dryRun` runs steps 1-5 and parses every file completely (all checks) without writing anything.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AnyBulkWriteOperation, Db } from 'mongodb';
import { RUN_ID_RE, WINDOW_KINDS, type Metrics, type WindowKind } from '../contract/common.ts';
import { parseIsoUtc } from '../lib/time.ts';
import { COLLECTIONS } from '../db.ts';
import { dataCollections, ensureDataCollections, siteRunId, type DataCollections } from '../repos/collections.ts';
import type { HorizonDoc, ImportStats, RunDoc, RunKind, SeriesDoc, SiteDoc, SiteRunDoc, WindowDoc } from '../repos/types.ts';
import { loadCatalogExtras, southPolarXY } from './catalog.ts';
import { ImportInputError, copyRunDir, isDirectory, readJsonFile, resolveInside, sha256File, sha256Hex } from './files.ts';
import { runPythonCheck, type PythonCheckOptions, type PythonCheckResult } from './pythonCheck.ts';
import { readHorizon, readSeries, readSummary, recordWithoutFiles, windowDocs } from './readers.ts';
import { ManifestFile, SitesFile, WindowsFile, type SummaryRow } from './schemas.ts';

export interface ImportLogger {
  info(msg: string): void;
  warn(msg: string): void;
}
export const silentLogger: ImportLogger = { info: () => {}, warn: () => {} };

export interface ImportRunOptions {
  /** Precompute output directory (contains manifest.json). */
  dir: string;
  /** Default `pf_<params_fingerprint>`; must match [A-Za-z0-9_.-]{1,64}. */
  runId?: string;
  /** Human label (run picker). Default: kept from a previous import, else generated from the parameters. */
  label?: string;
  kind?: RunKind;
  /** Flag this run is_default (and clear the flag on every other run). */
  setDefault?: boolean;
  /** Import despite check violations / checksum mismatches, and re-import an unchanged run. */
  force?: boolean;
  /** Validate and parse everything, write nothing (no MongoDB writes, no copy). */
  dryRun?: boolean;
  /** Python gate; false = skip (tests / no Python available). */
  check: PythonCheckOptions | false;
  /** Copy the directory to `<dataDir>/runs/<run_id>/` and import from there; null = import in place. */
  dataDir: string | null;
  /** lunarnav/catalog/sites.json (source of `extra`); null = no catalog. */
  catalogPath: string | null;
  /** custom runs: when they may be deleted. */
  expiresAt?: Date | null;
  /** Series docs per insertMany (default 5000). */
  batchSize?: number;
  log?: ImportLogger;
}

export interface ImportCounts {
  sites: number;
  site_runs: number;
  horizons: number;
  windows: number;
  series: number;
}

export interface ImportResult {
  run_id: string;
  /** imported = data written; skipped = already imported with the same manifest; dry_run = nothing written. */
  outcome: 'imported' | 'skipped' | 'dry_run';
  manifest_sha256: string;
  params_fingerprint: string;
  /** Directory the files were read from (DATA_DIR/runs/<run_id> after a copy). */
  source_dir: string;
  counts: ImportCounts;
  check: PythonCheckResult | null;
  checksum_problems: string[];
  warnings: string[];
  duration_ms: number;
}

/** The import was refused (gate failed); nothing was written. */
export class ImportRefusedError extends Error {
  override name = 'ImportRefusedError';
  readonly reasons: string[];
  constructor(message: string, reasons: string[]) {
    super(message);
    this.reasons = reasons;
  }
}

/** Post-check failed after writing; the run is marked `failed`. */
export class ImportVerificationError extends Error {
  override name = 'ImportVerificationError';
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`post-import verification failed:\n  ${problems.join('\n  ')}`);
    this.problems = problems;
  }
}

const PCT_TOL = 1e-5;
const DEFAULT_BATCH = 5000;

/**
 * Delete every document of `runId` except the `runs` row: the data collections plus the derived
 * `cache` entries (alt-dates results keyed by run_id) so a re-import never serves stale results.
 */
export async function deleteRunData(db: Db, runId: string): Promise<void> {
  const c = dataCollections(db);
  await Promise.all([
    db.collection(COLLECTIONS.cache).deleteMany({ run_id: runId }),
    c.site_runs.deleteMany({ run_id: runId }),
    c.horizons.deleteMany({ run_id: runId }),
    c.windows.deleteMany({ run_id: runId }),
    c.series.deleteMany({ 'meta.run_id': runId }),
  ]);
}

/** Delete a run completely (data + runs row). The raw directory on disk is NOT touched. */
export async function deleteRun(db: Db, runId: string): Promise<void> {
  await deleteRunData(db, runId);
  await dataCollections(db).runs.deleteOne({ _id: runId });
}

/** Flag one run as the default and clear the flag elsewhere. */
export async function setDefaultRun(db: Db, runId: string): Promise<void> {
  const { runs } = dataCollections(db);
  await runs.updateMany({ _id: { $ne: runId }, is_default: true }, { $set: { is_default: false } });
  await runs.updateOne({ _id: runId }, { $set: { is_default: true } });
}

async function verifyChecksums(dir: string, files: Record<string, string>): Promise<string[]> {
  const problems: string[] = [];
  for (const [rel, expected] of Object.entries(files)) {
    let abs: string;
    try {
      abs = resolveInside(dir, rel);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    try {
      const got = await sha256File(abs);
      if (got !== expected) problems.push(`${rel}: sha256 ${got} != manifest ${expected}`);
    } catch {
      problems.push(`${rel}: missing`);
    }
  }
  return problems;
}

const near = (a: number | null, b: number | null, tol: number): boolean => (a === null || b === null ? a === b : Math.abs(a - b) <= tol);

/** summary.csv row vs windows.json metrics (OUTPUT_SPEC section 4 invariant 7). */
function summaryVsMetrics(siteId: string, s: SummaryRow, m: Metrics): string[] {
  const out: string[] = [];
  const keys = [
    'pct_sun', 'pct_earth', 'pct_both', 'pct_sun_no_earth', 'longest_dark_h', 'longest_comms_gap_h', 'longest_sun_h', 'longest_earth_h',
    'n_sun_windows', 'n_dark_windows', 'n_earth_windows', 'n_comms_gaps', 'mean_sun_el_lit_deg', 'mean_power_horizontal', 'mean_power_tracking',
  ] as const;
  for (const k of keys) if (!near(s[k], m[k], PCT_TOL)) out.push(`${siteId}: summary.csv ${k}=${String(s[k])} != windows.json ${String(m[k])}`);
  if (s.longest_dark_truncated !== m.longest_dark_truncated) out.push(`${siteId}: longest_dark_truncated differs`);
  if (s.longest_comms_gap_truncated !== m.longest_comms_gap_truncated) out.push(`${siteId}: longest_comms_gap_truncated differs`);
  return out;
}

function defaultLabel(m: ManifestFile, nSites: number): string {
  const p = m.parameters;
  return `${p.provider} + ${p.dem} ${p.horizon_method}, ${p.start_utc.slice(0, 10)}..${p.end_utc.slice(0, 10)} (${nSites} sites)`;
}

interface ParsedSite {
  siteRun: SiteRunDoc;
  site: SiteDoc;
  horizon: HorizonDoc;
  windows: WindowDoc[];
  /** visibility file, relative to the run directory. */
  visibilityRel: string;
}

export async function importRun(db: Db | null, opts: ImportRunOptions): Promise<ImportResult> {
  const t0 = performance.now();
  const log = opts.log ?? silentLogger;
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
    log.warn(m);
  };
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;
  if (!dryRun && db === null) throw new Error('importRun: a database is required unless dryRun');
  const srcDir = path.resolve(opts.dir);
  if (!(await isDirectory(srcDir))) throw new ImportInputError(`not a directory: ${srcDir}`);

  // 1. manifest
  const manifestPath = path.join(srcDir, 'manifest.json');
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch {
    throw new ImportInputError(`${manifestPath}: missing (not a lunarnav precompute output directory?)`);
  }
  const manifestSha = sha256Hex(manifestBytes);
  const manifest = await readJsonFile(manifestPath, ManifestFile);
  const p = manifest.parameters;
  log.info(`manifest: fingerprint ${manifest.params_fingerprint}, ${p.site_ids.length} sites, ${p.start_utc} .. ${p.end_utc} step ${p.step_s} s (${p.n_samples} samples), ${p.provider}/${p.dem}/${p.horizon_method}`);

  // 2. run id
  const runId = opts.runId ?? `pf_${manifest.params_fingerprint}`;
  if (!RUN_ID_RE.test(runId)) throw new ImportInputError(`invalid run id ${JSON.stringify(runId)} (must match ${String(RUN_ID_RE)})`);
  const kind: RunKind = opts.kind ?? 'precompute';
  const counts: ImportCounts = { sites: 0, site_runs: 0, horizons: 0, windows: 0, series: 0 };

  // 3. idempotency (before the gate: an unchanged run is a cheap no-op, the files were checked when it was imported)
  const cols: DataCollections | null = db ? dataCollections(db) : null;
  let existing: RunDoc | null = null;
  if (db && cols) {
    if (!dryRun) await ensureDataCollections(db);
    existing = await cols.runs.findOne({ _id: runId });
    if (existing && existing.status === 'ready' && existing.manifest_sha256 === manifestSha && !force && !dryRun) {
      if (opts.setDefault) await setDefaultRun(db, runId);
      const stats = existing.stats;
      log.info(`run ${runId} already imported with the same manifest (${existing.imported_at?.toISOString() ?? '?'}) -> nothing to do`);
      return {
        run_id: runId,
        outcome: 'skipped',
        manifest_sha256: manifestSha,
        params_fingerprint: manifest.params_fingerprint,
        source_dir: existing.source_dir,
        counts: { sites: stats?.n_sites ?? 0, site_runs: stats?.n_sites ?? 0, horizons: stats?.horizons_docs ?? 0, windows: stats?.windows_docs ?? 0, series: stats?.series_docs ?? 0 },
        check: null,
        checksum_problems: [],
        warnings,
        duration_ms: Math.round(performance.now() - t0),
      };
    }
  }

  // 4. Python gate
  let check: PythonCheckResult | null = null;
  if (opts.check) {
    log.info(`gate: ${opts.check.pythonBin} -m lunarnav.cli check ${srcDir}`);
    check = await runPythonCheck(srcDir, opts.check);
    if (check.ok) log.info(`gate: ${check.summary} (${check.duration_ms} ms)`);
    else {
      const reasons = check.failure ? [check.failure] : check.violations.map((v) => `VIOLATION: ${v}`);
      if (!force) throw new ImportRefusedError(`lunarnav check failed for ${srcDir} (use --force to import anyway)`, reasons);
      for (const r of reasons.slice(0, 20)) warn(`gate (forced): ${r}`);
    }
  } else {
    warn('gate: python check skipped');
  }

  // 5. checksums
  const checksumProblems = await verifyChecksums(srcDir, manifest.files);
  if (checksumProblems.length > 0) {
    if (!force) throw new ImportRefusedError(`manifest checksums do not match in ${srcDir} (use --force to import anyway)`, checksumProblems);
    for (const c of checksumProblems) warn(`checksum (forced): ${c}`);
  } else {
    log.info(`checksums: ${Object.keys(manifest.files).length} files match the manifest`);
  }

  // parse the small files from the source (all of them, before copying or touching the database)
  const sitesFile = await readJsonFile(resolveInside(srcDir, 'sites.json'), SitesFile);
  const ids = sitesFile.sites.map((s) => s.id);
  if (JSON.stringify(ids) !== JSON.stringify(p.site_ids)) throw new ImportInputError(`sites.json ids [${ids.join(', ')}] != manifest parameters.site_ids`);
  const summary = await readSummary(resolveInside(srcDir, 'summary.csv'));
  const summaryIds = [...summary.keys()].sort();
  if (JSON.stringify(summaryIds) !== JSON.stringify([...ids].sort())) throw new ImportInputError(`summary.csv site ids [${summaryIds.join(', ')}] != sites.json ids`);
  const startMs = parseIsoUtc(p.start_utc);
  const endMs = parseIsoUtc(p.end_utc);
  if (startMs + p.n_samples * p.step_s * 1000 !== endMs) throw new ImportInputError(`manifest: start + n_samples*step != end`);
  const catalog = opts.catalogPath ? await loadCatalogExtras(opts.catalogPath) : { extras: new Map<string, Record<string, unknown>>(), warning: null };
  if (catalog.warning) warn(catalog.warning);

  const now = new Date();
  const parsed: ParsedSite[] = [];
  for (const rec of sitesFile.sites) {
    const w = await readJsonFile(resolveInside(srcDir, rec.files.windows), WindowsFile);
    const bad: string[] = [];
    if (w.site_id !== rec.id) bad.push(`site_id ${w.site_id}`);
    if (w.step_s !== p.step_s) bad.push(`step_s ${w.step_s}`);
    if (w.n_samples !== p.n_samples) bad.push(`n_samples ${w.n_samples}`);
    if (w.range_start_utc !== p.start_utc || w.range_end_utc !== p.end_utc) bad.push(`range ${w.range_start_utc}..${w.range_end_utc}`);
    if (bad.length > 0) throw new ImportInputError(`${rec.files.windows}: does not match the manifest (${bad.join(', ')})`);
    const row = summary.get(rec.id);
    if (!row) throw new ImportInputError(`summary.csv has no row for ${rec.id}`);
    const mismatch = summaryVsMetrics(rec.id, row, w.metrics);
    if (mismatch.length > 0) throw new ImportInputError(mismatch.join('\n'));
    const win = windowDocs(runId, rec.id, w);
    const horizon = await readHorizon(resolveInside(srcDir, rec.files.horizon), runId, rec);
    parsed.push({
      siteRun: {
        _id: siteRunId(runId, rec.id),
        run_id: runId,
        site_id: rec.id,
        record: recordWithoutFiles(rec),
        files: rec.files,
        metrics: w.metrics,
        rank: row.rank,
        score: row.score,
        summary: row,
        range_start: new Date(startMs),
        range_end: new Date(endMs),
        n_samples: p.n_samples,
        step_s: p.step_s,
        min_earth_clearance_deg: w.min_earth_clearance_deg,
        n_windows: win.counts,
      },
      site: {
        _id: rec.id,
        name: rec.name,
        group: rec.group,
        origin: rec.origin,
        lat_deg: rec.lat_deg,
        lon_deg: rec.lon_deg,
        source: rec.source,
        note: rec.note,
        extra: rec.origin === 'catalog' ? (catalog.extras.get(rec.id) ?? null) : null,
        map: southPolarXY(rec.lat_deg, rec.lon_deg),
        updated_at: now,
      },
      horizon,
      windows: win.docs,
      visibilityRel: rec.files.visibility,
    });
  }

  const grid = { startMs, stepS: p.step_s, nSamples: p.n_samples };
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;

  if (dryRun || !db || !cols) {
    // parse every series file completely (all format checks), write nothing
    for (const [i, s] of parsed.entries()) {
      const t1 = performance.now();
      const st = await readSeries(resolveInside(srcDir, s.visibilityRel), { run_id: runId, site_id: s.site._id }, grid, batchSize, async () => {});
      counts.series += st.rows;
      counts.windows += s.windows.length;
      log.info(`[${i + 1}/${parsed.length}] ${s.site._id}: ${st.rows} series rows, ${s.windows.length} windows parsed (${Math.round(performance.now() - t1)} ms) [dry run]`);
    }
    counts.sites = counts.site_runs = counts.horizons = parsed.length;
    const unchanged = existing?.status === 'ready' && existing.manifest_sha256 === manifestSha;
    const action = unchanged && !force ? 'skip (already imported with the same manifest)' : existing ? `re-import (existing status ${existing.status}${existing.manifest_sha256 === manifestSha ? ', same manifest' : ', different manifest'})` : 'new import';
    log.info(`dry run OK: would ${action} run ${runId}: ${counts.series} series docs, ${counts.windows} windows, ${parsed.length} sites`);
    return { run_id: runId, outcome: 'dry_run', manifest_sha256: manifestSha, params_fingerprint: manifest.params_fingerprint, source_dir: srcDir, counts, check, checksum_problems: checksumProblems, warnings, duration_ms: Math.round(performance.now() - t0) };
  }

  // 6. copy into DATA_DIR/runs/<run_id> (only now: a parse error above must not replace the files of a ready run)
  let readDir = srcDir;
  if (opts.dataDir !== null) {
    const dest = path.resolve(opts.dataDir, 'runs', runId);
    if (dest !== srcDir) {
      log.info(`copy: ${srcDir} -> ${dest}`);
      await copyRunDir(srcDir, dest);
      const copied = sha256Hex(await readFile(path.join(dest, 'manifest.json')));
      if (copied !== manifestSha) throw new ImportInputError(`copy of manifest.json differs (${dest})`);
    }
    readDir = dest;
  }

  // 7. runs row -> importing, clear previous data
  await cols.runs.updateOne(
    { _id: runId },
    {
      $set: {
        kind,
        label: opts.label ?? existing?.label ?? defaultLabel(manifest, parsed.length),
        status: 'importing',
        error: null,
        manifest,
        manifest_sha256: manifestSha,
        params_fingerprint: manifest.params_fingerprint,
        code_version: manifest.code_version,
        git_commit: manifest.git_commit,
        run_timestamp_utc: manifest.run_timestamp_utc,
        provider: p.provider,
        dem: p.dem,
        horizon_method: p.horizon_method,
        start: new Date(startMs),
        end: new Date(endMs),
        step_s: p.step_s,
        n_samples: p.n_samples,
        observer_height_m: p.observer_height_m,
        min_earth_clearance_deg: p.min_earth_clearance_deg,
        rank_weights: p.rank_weights,
        site_ids: ids,
        n_sites: ids.length,
        source_dir: readDir,
        started_at: now,
        imported_at: null,
        expires_at: opts.expiresAt ?? null,
        stats: null,
      },
      $setOnInsert: { is_default: false },
    },
    { upsert: true },
  );

  try {
    await deleteRunData(db, runId);

    // 8. small collections
    const siteOps: AnyBulkWriteOperation<SiteDoc>[] = parsed.map((s) => {
      const { _id, ...rest } = s.site;
      return { updateOne: { filter: { _id }, update: { $set: rest }, upsert: true } };
    });
    await cols.sites.bulkWrite(siteOps, { ordered: false });
    await cols.site_runs.insertMany(parsed.map((s) => s.siteRun), { ordered: false });
    await cols.horizons.insertMany(parsed.map((s) => s.horizon), { ordered: false });
    const allWindows = parsed.flatMap((s) => s.windows);
    for (let i = 0; i < allWindows.length; i += batchSize) await cols.windows.insertMany(allWindows.slice(i, i + batchSize), { ordered: false });
    counts.sites = counts.site_runs = counts.horizons = parsed.length;
    counts.windows = allWindows.length;
    log.info(`small collections: ${parsed.length} sites, ${parsed.length} site_runs, ${parsed.length} horizons, ${allWindows.length} windows`);

    // series, streamed
    const sink = async (docs: SeriesDoc[]): Promise<void> => {
      await cols.series.insertMany(docs, { ordered: false });
    };
    for (const [i, s] of parsed.entries()) {
      const t1 = performance.now();
      const st = await readSeries(resolveInside(readDir, s.visibilityRel), { run_id: runId, site_id: s.site._id }, grid, batchSize, sink);
      counts.series += st.rows;
      const ms = performance.now() - t1;
      log.info(`[${i + 1}/${parsed.length}] ${s.site._id}: ${st.rows} series docs in ${(ms / 1000).toFixed(1)} s (${Math.round(st.rows / Math.max(ms / 1000, 1e-3))} docs/s)`);
    }

    // 9. post-check against what is now in MongoDB
    const problems = await verifyStored(cols, runId, parsed, p.n_samples);
    if (problems.length > 0) throw new ImportVerificationError(problems);

    // 10. ready
    const stats: ImportStats = {
      n_sites: parsed.length,
      series_docs: counts.series,
      windows_docs: counts.windows,
      horizons_docs: counts.horizons,
      duration_ms: Math.round(performance.now() - t0),
    };
    await cols.runs.updateOne({ _id: runId }, { $set: { status: 'ready', imported_at: new Date(), stats } });
    if (opts.setDefault) await setDefaultRun(db, runId);
    log.info(`run ${runId} ready: ${counts.series} series docs, ${counts.windows} windows, ${parsed.length} sites in ${(stats.duration_ms / 1000).toFixed(1)} s${opts.setDefault ? ' (default run)' : ''}`);
    return { run_id: runId, outcome: 'imported', manifest_sha256: manifestSha, params_fingerprint: manifest.params_fingerprint, source_dir: readDir, counts, check, checksum_problems: checksumProblems, warnings, duration_ms: stats.duration_ms };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await cols.runs.updateOne({ _id: runId }, { $set: { status: 'failed', error: msg.slice(0, 2000) } }).catch(() => undefined);
    throw e;
  }
}

/** Plan section 8 step 8: compare MongoDB contents with the parsed files. */
async function verifyStored(cols: DataCollections, runId: string, parsed: ParsedSite[], nSamples: number): Promise<string[]> {
  const problems: string[] = [];
  const agg = await cols.series
    .aggregate<{ _id: string; n: number; sun: number; earth: number; both: number }>([
      { $match: { 'meta.run_id': runId } },
      {
        $group: {
          _id: '$meta.site_id',
          n: { $sum: 1 },
          sun: { $sum: { $cond: ['$sun_visible', 1, 0] } },
          earth: { $sum: { $cond: ['$earth_visible', 1, 0] } },
          both: { $sum: { $cond: ['$both_visible', 1, 0] } },
        },
      },
    ])
    .toArray();
  const bySite = new Map(agg.map((a) => [a._id, a]));
  const winCounts = await cols.windows
    .aggregate<{ _id: { site_id: string; kind: WindowKind }; n: number }>([
      { $match: { run_id: runId } },
      { $group: { _id: { site_id: '$site_id', kind: '$kind' }, n: { $sum: 1 } } },
    ])
    .toArray();
  const win = new Map(winCounts.map((w) => [`${w._id.site_id}|${w._id.kind}`, w.n]));
  for (const s of parsed) {
    const id = s.site._id;
    const a = bySite.get(id);
    if (!a || a.n !== nSamples) {
      problems.push(`${id}: ${a?.n ?? 0} series docs in MongoDB, expected ${nSamples}`);
      continue;
    }
    const m = s.siteRun.metrics;
    const pct = (k: number): number => (100 * k) / nSamples;
    if (!near(pct(a.sun), m.pct_sun, PCT_TOL)) problems.push(`${id}: stored series give pct_sun ${pct(a.sun)} != metrics ${m.pct_sun}`);
    if (!near(pct(a.earth), m.pct_earth, PCT_TOL)) problems.push(`${id}: stored series give pct_earth ${pct(a.earth)} != metrics ${m.pct_earth}`);
    if (!near(pct(a.both), m.pct_both, PCT_TOL)) problems.push(`${id}: stored series give pct_both ${pct(a.both)} != metrics ${m.pct_both}`);
    for (const k of WINDOW_KINDS) {
      const got = win.get(`${id}|${k}`) ?? 0;
      if (got !== s.siteRun.n_windows[k]) problems.push(`${id}: ${got} ${k} windows in MongoDB, expected ${s.siteRun.n_windows[k]}`);
    }
  }
  const nRuns = await cols.site_runs.countDocuments({ run_id: runId });
  if (nRuns !== parsed.length) problems.push(`${nRuns} site_runs docs, expected ${parsed.length}`);
  const nHor = await cols.horizons.countDocuments({ run_id: runId });
  if (nHor !== parsed.length) problems.push(`${nHor} horizons docs, expected ${parsed.length}`);
  return problems;
}
