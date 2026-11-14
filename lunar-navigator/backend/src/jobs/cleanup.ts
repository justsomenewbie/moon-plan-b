/**
 * Result TTL (plan 7.2 "hourly cleanup"): delete expired jobs together with their custom runs.
 *  1. jobs with expires_at <= now: purge the run documents (series/windows/site_runs/horizons/cache/runs),
 *     remove DATA_DIR/runs/job_<id>/ and DATA_DIR/jobs/<id>/, delete the job.
 *  2. orphan custom runs (`runs._id` = job_<id>) whose job is gone (the Mongo TTL monitor may delete a
 *     job document first) or whose own expires_at passed: purge.
 *  3. orphan directories under DATA_DIR/jobs and DATA_DIR/runs/job_* without a live job: remove.
 */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from 'mongodb';
import { COLLECTIONS } from '../db.ts';
import { dataCollections } from '../repos/index.ts';
import { purgeRunDocs } from './importer.ts';
import type { JobDoc } from './types.ts';

export interface CleanupReport {
  expired_jobs: number;
  orphan_runs: number;
  removed_dirs: number;
}

const JOB_RUN_RE = /^job_(j_[A-Za-z0-9]+)$/;

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export async function cleanupExpired(db: Db, dataDir: string, now: Date = new Date()): Promise<CleanupReport> {
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);
  const { runs } = dataCollections(db);
  const report: CleanupReport = { expired_jobs: 0, orphan_runs: 0, removed_dirs: 0 };
  const runsDir = path.join(dataDir, 'runs');
  const jobsDir = path.join(dataDir, 'jobs');

  for (const j of await jobs.find({ expires_at: { $lte: now }, active: { $exists: false } }).toArray()) {
    await purgeRunDocs(db, j.result?.run_id ?? `job_${j._id}`);
    await rm(path.join(runsDir, `job_${j._id}`), { recursive: true, force: true });
    await rm(path.join(jobsDir, j._id), { recursive: true, force: true });
    await jobs.deleteOne({ _id: j._id });
    report.expired_jobs++;
  }

  for (const r of await runs.find({ _id: { $regex: '^job_j_' } }).toArray()) {
    const jobId = JOB_RUN_RE.exec(r._id)?.[1];
    const job = jobId ? await jobs.findOne({ _id: jobId }, { projection: { status: 1 } }) : null;
    const expired = r.expires_at instanceof Date && r.expires_at <= now;
    if (!job || expired || job.status === 'failed' || job.status === 'cancelled') {
      await purgeRunDocs(db, r._id);
      await rm(path.join(runsDir, r._id), { recursive: true, force: true });
      report.orphan_runs++;
    }
  }

  // List directories BEFORE reading the jobs: a job document always exists before its directories.
  const runDirs = await listDirs(runsDir);
  const jobDirs = await listDirs(jobsDir);
  const live = new Set(
    (await jobs.find({ status: { $in: ['queued', 'running', 'succeeded'] } }, { projection: { _id: 1 } }).toArray()).map((j) => j._id),
  );
  const known = new Set((await jobs.find({}, { projection: { _id: 1 } }).toArray()).map((j) => j._id));
  for (const name of runDirs) {
    const jobId = JOB_RUN_RE.exec(name)?.[1];
    if (jobId && !live.has(jobId)) {
      await rm(path.join(runsDir, name), { recursive: true, force: true });
      report.removed_dirs++;
    }
  }
  for (const name of jobDirs) {
    if (/^j_[A-Za-z0-9]+$/.test(name) && !known.has(name)) {
      await rm(path.join(jobsDir, name), { recursive: true, force: true });
      report.removed_dirs++;
    }
  }
  return report;
}
