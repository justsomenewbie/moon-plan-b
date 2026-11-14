/**
 * Locate an imported run on disk for the Python bridge. Everything comes from the shared data-access
 * layer (src/repos): resolveRun() picks the run (RUN_NOT_FOUND / RUN_NOT_READY problems, same default
 * run as every read route) and the site's `site_runs.files` gives the visibility file relative to
 * the run's source directory (docs/OUTPUT_SPEC.md 3.2).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getSite, resolveRun, type RunDoc } from '../repos/index.ts';
import { ApiError, siteNotFound } from '../lib/problem.ts';

export interface RunOnDisk {
  runId: string;
  /** Absolute run directory (runDirectory(): DATA_DIR/runs/<run_id>, else runs.source_dir). */
  dir: string;
  paramsFingerprint: string;
  startMs: number;
  /** exclusive */
  endMs: number;
  stepS: number;
  minEarthClearanceDeg: number;
}

/**
 * Directory that holds the files of an imported run. A copied run (the default import, and every job
 * output) lives at DATA_DIR/runs/<run_id>/ - use that whenever it exists, so a database moved to
 * another machine (mongodump on Windows -> mongorestore on the VPS, docs/vi/DEPLOY_VPS.md 4.3) still finds
 * its files although `runs.source_dir` holds the old absolute path. `source_dir` is the fallback for
 * runs imported in place (--no-copy).
 */
export function runDirectory(run: Pick<RunDoc, '_id' | 'source_dir'>, dataDir: string): string {
  const copied = path.resolve(dataDir, 'runs', run._id);
  if (existsSync(path.join(copied, 'manifest.json'))) return copied;
  return path.resolve(run.source_dir);
}

/** The run a bridge request reads (`runId` or the default run). Throws RUN_NOT_FOUND / RUN_NOT_READY. */
export async function resolveRunOnDisk(runId: string | undefined, dataDir: string): Promise<RunOnDisk> {
  return runOnDisk(await resolveRun(runId), dataDir);
}

export function runOnDisk(run: RunDoc, dataDir: string): RunOnDisk {
  return {
    runId: run._id,
    dir: runDirectory(run, dataDir),
    paramsFingerprint: run.params_fingerprint,
    startMs: run.start.getTime(),
    endMs: run.end.getTime(),
    stepS: run.step_s,
    minEarthClearanceDeg: run.min_earth_clearance_deg,
  };
}

/** Absolute visibility.csv.gz of a site of the run. Throws SITE_NOT_FOUND; never leaves the run dir. */
export async function visibilityPath(run: RunOnDisk, siteId: string): Promise<string> {
  const view = await getSite(run.runId, siteId);
  if (!view) throw siteNotFound(siteId);
  const abs = path.resolve(run.dir, view.site_run.files.visibility);
  if (!abs.startsWith(run.dir + path.sep)) {
    throw new ApiError('INTERNAL', `visibility file of ${siteId} lies outside the directory of run ${run.runId}`);
  }
  return abs;
}
