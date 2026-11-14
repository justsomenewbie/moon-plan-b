/**
 * Job type 'custom_site' (plan 7.1 / 7.2): ONE catalog or custom site over a date range, hourly,
 * `lunarnav precompute --sites <id>` into DATA_DIR/runs/job_<id>/, then imported as a custom run.
 * OWNER: skeleton. External behaviour is frozen (tests/jobs/jobs.test.ts, tests/app.smoke.test.ts).
 * This is also the reference implementation for the other job types.
 */
import type { CustomSiteJobRequest } from '../../contract/jobs.ts';
import { getDb } from '../../db.ts';
import { toIsoUtc } from '../../lib/time.ts';
import { lunarnavCatalogPath } from '../../python/lunarnav.ts';
import { failureReason, precomputeArgv, progressFromLine } from '../../python/precompute.ts';
import { getImporter, importErrorMessage, purgeRunDocs } from '../importer.ts';
import { canonicalizeJob } from '../params.ts';
import type { CanonicalJobParams } from '../types.ts';
import { rm } from 'node:fs/promises';
import { JobFailure, defineJobType } from './define.ts';

export const customSiteJob = defineJobType<CustomSiteJobRequest, CanonicalJobParams>({
  type: 'custom_site',
  implemented: true,
  owner: 'skeleton',
  summary: 'One catalog or custom site over <= 366 days (hourly), imported as a custom run (result.run_id)',
  label: 'lunarnav precompute',
  logName: 'precompute.log',
  pythonStage: 'precompute',
  // timeout = JOB_TIMEOUT_S, result TTL = CUSTOM_RUN_TTL_DAYS (runner defaults)
  limits: { public: { max_range_days: 366, step_min_allowed: [60], observer_height_m_max: 100 }, creates_run: true },

  async canonicalize(req, ctx) {
    return canonicalizeJob(req, { catalogIds: await ctx.catalogIds() });
  },

  siteId: (p) => p.site_id,

  planPython: (p, run) => ({
    args: precomputeArgv({ params: p, outDir: run.outDir, runTimestamp: toIsoUtc(run.createdAt) }),
  }),

  progress: (line, prev) => progressFromLine(line, prev),

  failureReason: (lines, exitCode) => failureReason(lines, exitCode),

  async onSuccess(p, run, _py) {
    await run.setProgress('import', 95);
    const expiresAt = new Date(Date.now() + run.cfg.CUSTOM_RUN_TTL_DAYS * 24 * 3_600_000);
    try {
      const res = await getImporter()({
        sourceDir: run.outDir,
        runId: run.runId,
        jobId: run.jobId,
        label: run.name ?? p.site_id,
        expiresAt,
        dataDir: run.cfg.DATA_DIR,
        catalogPath: lunarnavCatalogPath(run.cfg),
      });
      return { result: { run_id: res.run_id, site_id: p.site_id }, expiresAt };
    } catch (e) {
      run.log.error({ err: e, jobId: run.jobId }, 'job import failed');
      await purgeRunDocs(getDb(), run.runId).catch(() => undefined);
      throw new JobFailure('IMPORT_FAILED', run.sanitize(importErrorMessage(e)));
    }
  },

  async onDiscard(_p, run, outcome) {
    // cancelled (or server stopping) during the import: drop what was imported
    await purgeRunDocs(getDb(), outcome.result?.run_id ?? run.runId);
    await rm(run.outDir, { recursive: true, force: true });
  },
});
