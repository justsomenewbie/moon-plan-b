/**
 * Adapter to the run importer (src/importer/importRun.ts, plan section 8) used when a job succeeds.
 *
 * The job's precompute output is written straight to DATA_DIR/runs/job_<id>/ (= the run's source dir),
 * so the importer is called with dataDir = DATA_DIR (destination == source -> no copy) and without the
 * `lunarnav check` gate: `lunarnav precompute` already ran check_output and exited 0.
 */
import path from 'node:path';
import type { Db } from 'mongodb';
import { getDb } from '../db.ts';
import { ImportRefusedError, ImportVerificationError, deleteRun, importRun } from '../importer/importRun.ts';

export interface ImportRequest {
  sourceDir: string;
  runId: string;
  jobId: string;
  label: string;
  expiresAt: Date;
  /** DATA_DIR (the run directory is DATA_DIR/runs/<runId>). */
  dataDir: string;
  /** lunarnav/catalog/sites.json (site `extra` for catalog-site jobs); null = none. */
  catalogPath: string | null;
  /** Run kind (default 'custom'; the precompute job type imports 'precompute' runs). */
  kind?: 'custom' | 'precompute';
}

export type ImportFn = (req: ImportRequest) => Promise<{ run_id: string }>;

let override: ImportFn | null = null;

/** Test seam: replace the importer (null = back to the real module). Per process (vitest forks per file). */
export function overrideImporter(fn: ImportFn | null): void {
  override = fn;
}

/** One-line reason from an importer error (refusal reasons / verification problems included). */
export function importErrorMessage(e: unknown): string {
  if (e instanceof ImportRefusedError) return `${e.message}: ${e.reasons.slice(0, 3).join('; ')}`;
  if (e instanceof ImportVerificationError) return `post-import verification failed: ${e.problems.slice(0, 3).join('; ')}`;
  return e instanceof Error ? e.message : String(e);
}

export const defaultImporter: ImportFn = async (req) => {
  const res = await importRun(getDb(), {
    dir: req.sourceDir,
    runId: req.runId,
    label: req.label,
    kind: req.kind ?? 'custom',
    setDefault: false,
    force: false,
    check: false,
    dataDir: path.resolve(req.sourceDir) === path.resolve(req.dataDir, 'runs', req.runId) ? req.dataDir : null,
    catalogPath: req.catalogPath,
    expiresAt: req.expiresAt,
  });
  return { run_id: res.run_id };
};

export const getImporter = (): ImportFn => override ?? defaultImporter;

/** Remove every document of a run (all collections of plan 5.3 + cache). Used by cancel races and cleanup. */
export async function purgeRunDocs(db: Db, runId: string): Promise<void> {
  await deleteRun(db, runId);
}
