/**
 * Async job engine (plan 7.2; docs/PYTHON_INTEGRATION.md): `jobs` collection + in-process p-queue
 * (concurrency JOB_CONCURRENCY, shared by every job type) + execa'd Python + the job-type registry
 * (src/jobs/types/: canonicalize / planPython / onSuccess per type) + the artifacts store.
 *
 *   submit  -> 200 (identical job succeeded) | 202 (identical job active -> the caller is subscribed to it,
 *              or new job queued) | 429 TOO_MANY_JOBS (JOB_MAX_ACTIVE_PER_CLIENT) | 429 QUEUE_FULL
 *              | 429 QUOTA_EXCEEDED / 503 STORAGE_FULL (job-run storage budget, PGDA download budget).
 *              Creating a NEW job (limit checks -> insert -> enqueue) is serialized in this process, so
 *              concurrent POSTs cannot all pass the per-client / queue / storage checks with the same count
 *              (one server per database, see recover()).
 *   execute -> queued -> running -> Python (timeout def.limits.timeout_s ?? JOB_TIMEOUT_S) -> def.onSuccess
 *              (custom_site: import) -> artifacts -> succeeded
 *              | failed {code: PYTHON_FAILED | PYTHON_TIMEOUT | PYTHON_UNAVAILABLE | IMPORT_FAILED | RESULT_FAILED | ARTIFACTS_FAILED | ...}
 *   cancel  -> removes the caller's subscription (403 JOB_NOT_YOURS for a client that is not subscribed);
 *              when no subscriber is left: queued/running -> cancelled (the Python process tree is killed)
 *   start   -> boot recovery: jobs left queued/running -> failed SERVER_RESTARTED; hourly cleanup.
 *
 * Every status write is guarded by the expected current status, so cancel / finish races are safe.
 * Files: imported run = DATA_DIR/runs/job_<id>/ (the run's source dir); job dir DATA_DIR/jobs/<id>/
 * (= LUNARNAV_OUTPUT of the child) with <logName> (precompute.log for custom_site) and artifacts/.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import PQueue from 'p-queue';
import type { Config } from '../config.ts';
import { COLLECTIONS, collection, getDb } from '../db.ts';
import type { CreateJobRequest, Job, JobStage } from '../contract/jobs.ts';
import { ApiError, jobNotFound } from '../lib/problem.ts';
import { toIsoUtc } from '../lib/time.ts';
import { getCapabilities } from '../python/capabilities.ts';
import { checkPgdaBudget, trackPgda } from '../python/pgdaCache.ts';
import { lunarnavCatalogIds, lunarnavCodeVersion } from '../python/lunarnav.ts';
import { runPython } from '../python/process.ts';
import { lunarnavEnv } from '../python/scripts.ts';
import { ARTIFACT_LIMITS, ArtifactError, artifactPath, artifactsDirOf, collectArtifacts, toApiArtifacts } from './artifacts.ts';
import { cleanupExpired, type CleanupReport } from './cleanup.ts';
import { paramsHash } from './params.ts';
import { JobFailure, jobTypeDef, listJobTypes, type AnyJobTypeDef, type JobOutcome, type PythonPlan, type ProgressState, type RunContext, type SubmitContext } from './types/index.ts';
import { isTerminal, jobRunId, type JobDoc, type JobError, type StoredArtifact } from './types.ts';
import { getRun } from '../repos/index.ts';

export const PROGRESS_LINES_MAX = 50;
export const PROGRESS_FLUSH_MS = 1000;
export const FAILED_JOB_TTL_H = 24;
export const CLEANUP_INTERVAL_MS = 3_600_000;
/** A succeeded job is reused (200 cached) only while it has at least this long to live. */
export const CACHE_MIN_REMAINING_MS = 86_400_000;
const H = 3_600_000;

export type RunnerConfig = Pick<
  Config,
  'DATA_DIR' | 'PYTHON_BIN' | 'LUNARNAV_ROOT' | 'JOB_TIMEOUT_S' | 'JOB_CONCURRENCY' | 'JOB_QUEUE_MAX' | 'CUSTOM_RUN_TTL_DAYS'
> &
  Partial<
    Pick<
      Config,
      | 'JOB_MAX_ACTIVE_PER_CLIENT'
      | 'NODE_ENV'
      | 'CAPABILITIES_NETWORK_PROBE'
      | 'CAPABILITIES_TTL_S'
      | 'PRECOMPUTE_RUN_TTL_DAYS'
      | 'JOB_RUNS_MAX_PER_CLIENT'
      | 'JOB_RUNS_MAX_TOTAL'
      | 'JOB_RUNS_MAX_MB'
      | 'DATA_DIR_MIN_FREE_MB'
      | 'PGDA_DOWNLOAD_MAX_MB_PER_DAY'
      | 'PGDA_CACHE_MAX_MB'
    >
  >;

/** Prefix of the artifact URLs in Job.artifacts when the caller does not pass one (= app.ts API_PREFIX). */
export const DEFAULT_API_PREFIX = '/api/v1';

/** Client key used when a caller does not say who it is (engine tests, scripts). */
export const LOCAL_CLIENT = 'local';

export interface SubmitResult {
  doc: JobDoc;
  cached: boolean;
  statusCode: 200 | 202;
}

export function newJobId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  return `j_${[...randomBytes(12)].map((b) => alphabet[b % 36]).join('')}`;
}

/** Site id of a job (def.siteId; null for an unknown type or a type without a single site). */
export function jobSiteId(d: Pick<JobDoc, 'type' | 'params'>): string | null {
  try {
    return jobTypeDef(d.type).siteId(d.params);
  } catch {
    return null;
  }
}

/** API view of a job; `client` = the viewer, whose own display name is shown when it is subscribed. */
export function toApiJob(d: JobDoc, client?: string, prefix: string = DEFAULT_API_PREFIX): Job {
  const mine = client === undefined ? undefined : d.subscribers?.find((x) => x.client === client);
  return {
    job_id: d._id,
    type: d.type,
    status: d.status,
    site_id: jobSiteId(d),
    params: { ...d.params, name: mine ? mine.name : d.name },
    progress: { stage: d.progress.stage, pct: d.progress.pct, lines: d.progress.lines },
    result: d.result,
    output: d.status === 'succeeded' ? (d.output ?? null) : null,
    artifacts: d.status === 'succeeded' ? toApiArtifacts(prefix, d._id, d.artifacts) : [],
    error: d.error,
    clients: isTerminal(d.status) ? 0 : (d.subscribers?.length ?? 1),
    created_at: toIsoUtc(d.created_at),
    started_at: d.started_at ? toIsoUtc(d.started_at) : null,
    finished_at: d.finished_at ? toIsoUtc(d.finished_at) : null,
    expires_at: d.expires_at ? toIsoUtc(d.expires_at) : null,
  };
}

const jobs = () => collection<JobDoc>(COLLECTIONS.jobs);
const MB = 1024 * 1024;

/** Job types whose Python may read PGDA blocks (download budget + cache trim): dem pgda, terrain validation. */
export function jobUsesPgda(p: { type: string } & Record<string, unknown>): boolean {
  if (p['dem'] === 'pgda') return true;
  if (p.type === 'validate_terrain') return true;
  if (p.type === 'validate') return p['no_terrain'] !== true;
  return false;
}

/** Bytes of the regular files under `dir` (0 when it does not exist). */
export async function dirBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += await dirBytes(p);
    else if (e.isFile()) n += (await stat(p).catch(() => null))?.size ?? 0;
  }
  return n;
}
const isDuplicateKey = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 11000;

export class JobRunner {
  readonly events = new EventEmitter();
  readonly instanceId = `${os.hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private readonly queue: PQueue;
  private readonly controllers = new Map<string, AbortController>();
  private readonly mine = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private closing = false;
  /** Tail of the submit critical section (limit checks -> insert -> enqueue run one at a time). */
  private submitTail: Promise<unknown> = Promise.resolve();

  private readonly cfg: RunnerConfig;
  private readonly log: FastifyBaseLogger;

  constructor(cfg: RunnerConfig, log: FastifyBaseLogger) {
    this.cfg = cfg;
    this.log = log;
    this.queue = new PQueue({ concurrency: cfg.JOB_CONCURRENCY });
    this.events.setMaxListeners(0);
  }

  outDir(jobId: string): string {
    return path.join(this.cfg.DATA_DIR, 'runs', jobRunId(jobId));
  }

  jobDir(jobId: string): string {
    return path.join(this.cfg.DATA_DIR, 'jobs', jobId);
  }

  /** Lifetime of a succeeded job of this type (ms). */
  private resultTtlMs(def: AnyJobTypeDef): number {
    return (def.resultTtlH?.(this.cfg) ?? def.limits.result_ttl_h ?? this.cfg.CUSTOM_RUN_TTL_DAYS * 24) * H;
  }

  /** Run `fn` after every earlier serialized() call has settled (in-process mutex). */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.submitTail.then(fn, fn);
    this.submitTail = run.catch(() => undefined);
    return run;
  }

  private timeoutS(def: AnyJobTypeDef): number {
    return def.limits.timeout_s ?? this.cfg.JOB_TIMEOUT_S;
  }

  private submitContext(): SubmitContext {
    return {
      cfg: this.cfg,
      catalogIds: () => lunarnavCatalogIds(this.cfg),
      capabilities: () => getCapabilities(this.cfg),
    };
  }

  /**
   * A succeeded job may be served as a cache hit: every artifact it published must still be on disk (same
   * size) in this server's DATA_DIR, then def.reusable (default: its imported run, if any, is still ready).
   */
  private async reusable(def: AnyJobTypeDef, doc: JobDoc): Promise<boolean> {
    if (!(await this.artifactsPresent(doc))) return false;
    if (def.reusable) return def.reusable(doc);
    if (doc.result) return (await getRun(doc.result.run_id))?.status === 'ready';
    return true;
  }

  private async artifactsPresent(doc: JobDoc): Promise<boolean> {
    const dir = this.jobDir(doc._id);
    for (const a of doc.artifacts ?? []) {
      try {
        const st = await stat(artifactPath(dir, a.name));
        if (!st.isFile() || st.size !== a.bytes) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Jobs of this process waiting or running. */
  load(): number {
    return this.queue.size + this.queue.pending;
  }

  private emit(jobId: string): void {
    this.events.emit('job', jobId);
  }

  // ---- lifecycle ------------------------------------------------------------------------------------
  /** Boot: recover jobs a previous process left behind, run a cleanup pass, schedule hourly cleanup. */
  async start(): Promise<{ recovered: number }> {
    const recovered = await this.recover();
    await this.cleanup().catch((err: unknown) => this.log.warn({ err }, 'job cleanup failed'));
    this.timer = setInterval(() => {
      void this.cleanup().catch((err: unknown) => this.log.warn({ err }, 'job cleanup failed'));
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
    return { recovered };
  }

  async recover(): Promise<number> {
    const stale = await jobs().find({ status: { $in: ['queued', 'running'] } }, { projection: { _id: 1 } }).toArray();
    if (stale.length === 0) return 0;
    const now = new Date();
    const r = await jobs().updateMany(
      { _id: { $in: stale.map((s) => s._id) }, status: { $in: ['queued', 'running'] } },
      {
        $set: {
          status: 'failed',
          error: { code: 'SERVER_RESTARTED', message: 'the server restarted while this job was queued or running; POST /api/v1/jobs again' },
          finished_at: now,
          expires_at: new Date(now.getTime() + FAILED_JOB_TTL_H * H),
          'progress.stage': 'done',
        },
        $unset: { active: '' },
      },
    );
    await Promise.all(stale.map((s) => rm(this.outDir(s._id), { recursive: true, force: true })));
    if (r.modifiedCount > 0) this.log.warn({ count: r.modifiedCount }, 'jobs left queued/running by a previous server marked failed');
    return r.modifiedCount;
  }

  cleanup(now: Date = new Date()): Promise<CleanupReport> {
    return cleanupExpired(getDb(), this.cfg.DATA_DIR, now);
  }

  /** Shutdown: stop timers, fail this process's active jobs (SERVER_STOPPED) and kill their Python processes. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.clear();
    const ids = [...this.mine];
    if (ids.length > 0) {
      const now = new Date();
      try {
        await jobs().updateMany(
          { _id: { $in: ids }, status: { $in: ['queued', 'running'] } },
          {
            $set: {
              status: 'failed',
              error: { code: 'SERVER_STOPPED', message: 'the server stopped while this job was queued or running; POST /api/v1/jobs again' },
              finished_at: now,
              expires_at: new Date(now.getTime() + FAILED_JOB_TTL_H * H),
              'progress.stage': 'done',
            },
            $unset: { active: '' },
          },
        );
      } catch (err) {
        this.log.warn({ err }, 'could not mark active jobs failed on shutdown');
      }
    }
    for (const ac of this.controllers.values()) ac.abort();
    await Promise.race([this.queue.onIdle(), new Promise((r) => setTimeout(r, 15_000).unref())]);
  }

  // ---- API operations -------------------------------------------------------------------------------
  async submit(body: CreateJobRequest, client: string = LOCAL_CLIENT): Promise<SubmitResult> {
    const def = jobTypeDef(body.type);
    if (!def.implemented) {
      throw new ApiError('JOB_TYPE_UNAVAILABLE', `job type ${def.type} is not implemented yet`, {
        hint: 'GET /api/v1/capabilities lists the job types this server runs',
        extensions: { job_type: def.type },
      });
    }
    if (def.available) {
      const reason = def.available(await getCapabilities(this.cfg));
      if (reason !== null) {
        throw new ApiError('JOB_TYPE_UNAVAILABLE', `job type ${def.type} is not available on this server: ${reason}`, {
          hint: 'GET /api/v1/capabilities',
          extensions: { job_type: def.type, reason },
        });
      }
    }
    const params = await def.canonicalize(body, this.submitContext());
    if (params.type !== def.type) throw new Error(`job type ${def.type}: canonicalize() returned params of type ${String(params.type)}`);
    const usesPgda = jobUsesPgda(params as { type: string } & Record<string, unknown>);
    const codeVersion = await lunarnavCodeVersion(this.cfg);
    const hash = paramsHash(params, codeVersion);
    const name = body.name ?? null;
    // a cached result must outlive the caller's polling; short-lived types keep half their TTL
    const minRemainingMs = Math.min(CACHE_MIN_REMAINING_MS, this.resultTtlMs(def) / 2);

    // A few attempts: the job we try to join may finish / be cancelled, or a concurrent POST may insert first.
    for (let attempt = 0; attempt < 5; attempt++) {
      // cache hit = a succeeded job that is not about to expire and whose result is still there
      if (def.limits.cacheable !== false) {
        const done = await jobs().findOne(
          { params_hash: hash, status: 'succeeded', expires_at: { $gt: new Date(Date.now() + minRemainingMs) } },
          { sort: { finished_at: -1 } },
        );
        if (done && (await this.reusable(def, done))) {
          return { doc: done, cached: true, statusCode: 200 };
        }
      }
      const active = await jobs().findOne({ params_hash: hash, active: true });
      if (active) {
        const joined = await this.subscribe(active._id, client, name);
        if (joined) return { doc: joined, cached: true, statusCode: 202 };
        continue; // it just finished or was cancelled: look again
      }
      // The checks and the insert + enqueue form ONE step: concurrent submits cannot all see the old counts.
      const created = await this.serialized(async (): Promise<JobDoc | null> => {
        if (this.closing) throw new ApiError('SERVICE_UNAVAILABLE', 'server is shutting down');
        await this.checkClientLimit(client);
        if (this.load() >= this.cfg.JOB_QUEUE_MAX) {
          throw new ApiError('QUEUE_FULL', `the job queue holds ${this.cfg.JOB_QUEUE_MAX} jobs; retry later`, {
            headers: { 'retry-after': '60' },
            extensions: { queue_max: this.cfg.JOB_QUEUE_MAX },
          });
        }
        if (usesPgda) checkPgdaBudget(this.cfg);
        if (def.limits.creates_run) await this.checkRunStorage(client);
        const now = new Date();
        const doc: JobDoc = {
          _id: newJobId(),
          type: def.type,
          status: 'queued',
          active: true,
          params,
          name,
          subscribers: [{ client, name, at: now }],
          creator: client,
          params_hash: hash,
          code_version: codeVersion,
          progress: { stage: 'queued', pct: 0, lines: [] },
          stderr_tail: [],
          result: null,
          output: null,
          artifacts: [],
          error: null,
          owner: this.instanceId,
          duration_ms: null,
          created_at: now,
          started_at: null,
          finished_at: null,
          expires_at: null,
        };
        try {
          await jobs().insertOne(doc);
        } catch (e) {
          if (!isDuplicateKey(e)) throw e;
          return null; // an identical job was inserted concurrently: join it
        }
        this.enqueue(doc._id); // synchronous: load() counts it before the next submit runs its checks
        return doc;
      });
      if (!created) continue;
      return { doc: created, cached: false, statusCode: 202 };
    }
    throw new ApiError('SERVICE_UNAVAILABLE', 'the job changed state repeatedly while submitting; retry');
  }

  /** Subscribe `client` to an active job (idempotent). null when the job is no longer queued/running. */
  private async subscribe(jobId: string, client: string, name: string | null): Promise<JobDoc | null> {
    const pushed = await jobs().findOneAndUpdate(
      { _id: jobId, active: true, 'subscribers.client': { $ne: client } },
      { $push: { subscribers: { client, name, at: new Date() } } },
      { returnDocument: 'after' },
    );
    if (pushed) return pushed;
    // already subscribed (a repeated POST), or no longer active
    return jobs().findOne({ _id: jobId, active: true, 'subscribers.client': client });
  }

  /** 429 TOO_MANY_JOBS when `client` already waits on JOB_MAX_ACTIVE_PER_CLIENT queued/running jobs. */
  private async checkClientLimit(client: string): Promise<void> {
    const max = this.cfg.JOB_MAX_ACTIVE_PER_CLIENT ?? 0;
    if (max <= 0) return;
    const n = await jobs().countDocuments({ active: true, 'subscribers.client': client });
    if (n >= max) {
      throw new ApiError('TOO_MANY_JOBS', `this client already waits on ${n} queued/running job(s) (limit ${max}); wait for one to finish or cancel it`, {
        headers: { 'retry-after': '30' },
        extensions: { max_active_per_client: max },
      });
    }
  }

  /**
   * Storage budget of job runs (types with limits.creates_run), checked before a NEW such job is queued:
   * 429 QUOTA_EXCEEDED beyond JOB_RUNS_MAX_PER_CLIENT live runs of this creator; 503 STORAGE_FULL beyond
   * JOB_RUNS_MAX_TOTAL live runs, JOB_RUNS_MAX_MB on disk, or when DATA_DIR has < DATA_DIR_MIN_FREE_MB free.
   * Live = queued/running, or succeeded with an imported run that has not expired.
   */
  private async checkRunStorage(client: string): Promise<void> {
    const now = new Date();
    const live = {
      type: { $in: listRunCreatingTypes() as JobDoc['type'][] },
      $or: [{ active: true as const }, { status: 'succeeded' as const, result: { $ne: null }, expires_at: { $gt: now } }],
    };
    const perClient = this.cfg.JOB_RUNS_MAX_PER_CLIENT ?? 0;
    if (perClient > 0) {
      const n = await jobs().countDocuments({ ...live, creator: client });
      if (n >= perClient) {
        throw new ApiError('QUOTA_EXCEEDED', `this client already has ${n} live job run(s) (limit ${perClient}); they expire after their TTL`, {
          headers: { 'retry-after': '3600' },
          hint: 'reuse an existing run (identical parameters are served from cache) or wait until older runs expire',
          extensions: { quota: 'job_runs_per_client', limit: perClient, used: n },
        });
      }
    }
    const storageFull = (msg: string, ext: Record<string, unknown>): ApiError =>
      new ApiError('STORAGE_FULL', msg, { headers: { 'retry-after': '3600' }, hint: 'retry later (job runs expire after their TTL)', extensions: ext });
    const total = this.cfg.JOB_RUNS_MAX_TOTAL ?? 0;
    if (total > 0) {
      const n = await jobs().countDocuments(live);
      if (n >= total) throw storageFull(`the server already keeps ${n} job runs (limit ${total})`, { quota: 'job_runs_total', limit: total, used: n });
    }
    const maxMb = this.cfg.JOB_RUNS_MAX_MB ?? 0;
    if (maxMb > 0) {
      const agg = await jobs()
        .aggregate<{ bytes: number }>([
          { $match: { type: live.type, status: 'succeeded', result: { $ne: null }, expires_at: { $gt: now } } },
          { $group: { _id: null, bytes: { $sum: { $ifNull: ['$run_bytes', 0] } } } },
        ])
        .toArray();
      const bytes = agg[0]?.bytes ?? 0;
      if (bytes >= maxMb * MB) {
        throw storageFull(`job runs use ${Math.round(bytes / MB)} MB on disk (limit ${maxMb} MB)`, { quota: 'job_runs_mb', limit_mb: maxMb, used_mb: Math.round(bytes / MB) });
      }
    }
    const minFree = this.cfg.DATA_DIR_MIN_FREE_MB ?? 0;
    if (minFree > 0) {
      const st = await statfs(this.cfg.DATA_DIR).catch(() => null);
      const free = st ? st.bavail * st.bsize : null;
      if (free !== null && free < minFree * MB) {
        throw storageFull(`DATA_DIR has ${Math.round(free / MB)} MB free (minimum ${minFree} MB)`, { quota: 'data_dir_min_free_mb', limit_mb: minFree, free_mb: Math.round(free / MB) });
      }
    }
  }

  async get(jobId: string): Promise<JobDoc> {
    const d = await jobs().findOne({ _id: jobId });
    if (!d) throw jobNotFound(jobId);
    return d;
  }

  /**
   * DELETE: remove `client`'s subscription. The job is cancelled (Python killed) only when no other client
   * waits on it; otherwise it keeps running and the current doc is returned (Job.clients > 0).
   */
  async cancel(jobId: string, client: string = LOCAL_CLIENT): Promise<JobDoc> {
    const notCancellable = (d: JobDoc) =>
      new ApiError('JOB_NOT_CANCELLABLE', `job ${jobId} already ${d.status}`, { extensions: { job_status: d.status } });
    const notYours = () =>
      new ApiError('JOB_NOT_YOURS', `job ${jobId} was not submitted from this client`, {
        hint: 'only a client that POSTed these parameters can cancel the job (POSTing the same body subscribes you to it)',
      });
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await this.get(jobId);
      if (isTerminal(cur.status)) throw notCancellable(cur);
      const subs = cur.subscribers;
      if (subs !== undefined && subs.length > 0) {
        if (!subs.some((x) => x.client === client)) throw notYours();
        const left = await jobs().findOneAndUpdate(
          { _id: jobId, status: { $in: ['queued', 'running'] }, 'subscribers.client': client },
          { $pull: { subscribers: { client } } },
          { returnDocument: 'after' },
        );
        if (!left) continue; // state changed under us: re-evaluate
        if ((left.subscribers?.length ?? 0) > 0) {
          this.log.info({ jobId, remaining: left.subscribers?.length }, 'job subscriber left; the job keeps running for the others');
          this.emit(jobId);
          return left;
        }
      }
      const now = new Date();
      const updated = await jobs().findOneAndUpdate(
        // only when nobody (re)subscribed in between
        { _id: jobId, status: { $in: ['queued', 'running'] }, $or: [{ subscribers: { $exists: false } }, { subscribers: { $size: 0 } }] },
        {
          $set: { status: 'cancelled', finished_at: now, expires_at: new Date(now.getTime() + FAILED_JOB_TTL_H * H), 'progress.stage': 'done' },
          $unset: { active: '' },
        },
        { returnDocument: 'after' },
      );
      if (updated) {
        this.controllers.get(jobId)?.abort();
        this.emit(jobId);
        return updated;
      }
      const latest = await this.get(jobId);
      if (isTerminal(latest.status)) throw notCancellable(latest);
      // somebody subscribed after our $pull: the job continues for them
      if ((latest.subscribers?.length ?? 0) > 0) return latest;
    }
    throw new ApiError('SERVICE_UNAVAILABLE', 'the job changed state repeatedly while cancelling; retry');
  }

  // ---- execution ------------------------------------------------------------------------------------
  private enqueue(jobId: string): void {
    this.mine.add(jobId);
    this.queue
      .add(() => this.execute(jobId))
      .catch(async (err: unknown) => {
        this.log.error({ err, jobId }, 'job crashed');
        await this.fail(jobId, { code: 'INTERNAL', message: 'internal error while running the job (see server log)' }, [], [], Date.now()).catch(
          () => undefined,
        );
      })
      .finally(() => {
        this.mine.delete(jobId);
        this.controllers.delete(jobId);
      });
  }

  private sanitize(line: string): string {
    let s = line;
    for (const [dir, label] of [
      [path.resolve(this.cfg.DATA_DIR), '<DATA_DIR>'],
      [path.resolve(this.cfg.LUNARNAV_ROOT), '<LUNARNAV_ROOT>'],
    ] as const) {
      s = s.split(dir).join(label);
    }
    return s.length > 500 ? `${s.slice(0, 500)}...` : s;
  }

  private async fail(jobId: string, error: JobError, lines: string[], stderrTail: string[], t0: number): Promise<void> {
    // Remove the partial output BEFORE the terminal write: a client that sees `failed` never finds a
    // half-written run directory (tests/jobs/jobs.test.ts IMPORT_FAILED).
    await rm(this.outDir(jobId), { recursive: true, force: true }).catch((err: unknown) => this.log.warn({ err, jobId }, 'could not remove the output of a failed job'));
    const now = new Date();
    await jobs().updateOne(
      // 'queued' too: the crash handler of enqueue() may run before the job was marked running
      { _id: jobId, status: { $in: ['queued', 'running'] } },
      {
        $set: {
          status: 'failed',
          error,
          stderr_tail: stderrTail,
          progress: { stage: 'done', pct: null, lines },
          finished_at: now,
          duration_ms: Date.now() - t0,
          expires_at: new Date(now.getTime() + FAILED_JOB_TTL_H * H),
        },
        $unset: { active: '' },
      },
    );
    this.log.warn({ jobId, error }, 'job failed');
    this.emit(jobId);
  }

  private async execute(jobId: string): Promise<void> {
    if (this.closing) return;
    const t0 = Date.now();
    // Register the controller BEFORE the queued -> running write: a DELETE landing between that write and
    // the spawn must still abort this run (runPython kills a child whose signal is already aborted).
    const ac = new AbortController();
    this.controllers.set(jobId, ac);
    const queued = await jobs().findOne({ _id: jobId, status: 'queued' }, { projection: { type: 1 } });
    if (!queued) return; // cancelled while queued
    const def = jobTypeDef(queued.type);
    const started = await jobs().findOneAndUpdate(
      { _id: jobId, status: 'queued' },
      { $set: { status: 'running', started_at: new Date(), owner: this.instanceId, progress: { stage: def.pythonStage, pct: 5, lines: [] } } },
      { returnDocument: 'after' },
    );
    if (!started) return; // cancelled while queued
    this.emit(jobId);
    const outDir = this.outDir(jobId);
    const jobDir = this.jobDir(jobId);
    const artifactsDir = artifactsDirOf(jobDir);
    const runId = jobRunId(jobId);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(artifactsDir, { recursive: true });
    const logFile = createWriteStream(path.join(jobDir, def.logName), { flags: 'a' });

    const lines: string[] = [];
    let progress: ProgressState = { stage: def.pythonStage, pct: 5 };
    let dirty = false;
    const onLine = (raw: string, isErr: boolean): void => {
      logFile.write(`${isErr ? '[stderr] ' : ''}${raw}\n`);
      const line = this.sanitize(raw);
      if (line.trim().length === 0) return;
      lines.push(line);
      if (lines.length > PROGRESS_LINES_MAX) lines.shift();
      if (!isErr && def.progress) progress = def.progress(raw, progress);
      dirty = true;
    };
    const flush = async (): Promise<void> => {
      if (!dirty) return;
      dirty = false;
      await jobs().updateOne({ _id: jobId, status: 'running' }, { $set: { progress: { stage: progress.stage, pct: progress.pct, lines: [...lines] } } });
      this.emit(jobId);
    };
    const ctx: RunContext = {
      jobId,
      createdAt: started.created_at,
      name: started.name,
      cfg: this.cfg,
      log: this.log,
      jobDir,
      artifactsDir,
      outDir,
      runId,
      sanitize: (s) => this.sanitize(s),
      setProgress: async (stage: JobStage, pct: number | null) => {
        progress = { stage, pct };
        dirty = true;
        await flush();
      },
      signal: ac.signal,
    };

    let plan: PythonPlan;
    try {
      plan = await def.planPython(started.params, ctx);
    } catch (e) {
      await new Promise<void>((res) => logFile.end(() => res()));
      if (e instanceof JobFailure) return this.fail(jobId, { code: e.code, message: e.message }, lines, [], t0);
      this.log.error({ err: e, jobId }, 'could not build the Python command');
      const msg = e instanceof Error ? e.message : String(e);
      return this.fail(jobId, { code: 'INTERNAL', message: `could not prepare ${def.label}: ${this.sanitize(msg)}` }, lines, [], t0);
    }
    const timeoutS = plan.timeoutS ?? this.timeoutS(def);
    const flusher = setInterval(() => {
      void flush().catch((err: unknown) => this.log.warn({ err, jobId }, 'progress write failed'));
    }, PROGRESS_FLUSH_MS);

    const spawn = () =>
      runPython({
        bin: this.cfg.PYTHON_BIN,
        args: plan.args,
        cwd: plan.cwd ?? this.cfg.LUNARNAV_ROOT,
        env: { ...lunarnavEnv(this.cfg, { jobDir }), ...(plan.env ?? {}) },
        ...(plan.input === undefined ? {} : { input: plan.input }),
        timeoutMs: timeoutS * 1000,
        signal: ac.signal,
        onStdoutLine: (l) => onLine(l, false),
        onStderrLine: (l) => onLine(l, true),
      });
    // PGDA work: count newly cached blocks into today's download budget, trim the cache afterwards
    const r = jobUsesPgda(started.params as { type: string } & Record<string, unknown>)
      ? await trackPgda(this.cfg, spawn, (err) => this.log.warn({ err, jobId }, 'PGDA cache bookkeeping failed'))
      : await spawn();
    clearInterval(flusher);
    await new Promise<void>((res) => logFile.end(() => res()));
    this.log.info({ jobId, type: def.type, exitCode: r.exitCode, ms: r.durationMs, timedOut: r.timedOut, canceled: r.canceled }, `${def.label} finished`);

    if (r.canceled) {
      // status was set by cancel() / close(); keep the last lines for the UI
      await jobs().updateOne({ _id: jobId }, { $set: { 'progress.lines': lines, duration_ms: Date.now() - t0 } });
      await rm(outDir, { recursive: true, force: true });
      this.emit(jobId);
      return;
    }
    const stderrTail = r.stderrTail.map((l) => this.sanitize(l));
    if (r.timedOut) return this.fail(jobId, { code: 'PYTHON_TIMEOUT', message: `${def.label} exceeded ${timeoutS} s` }, lines, stderrTail, t0);
    if (r.spawnError) return this.fail(jobId, { code: 'PYTHON_UNAVAILABLE', message: `could not start Python: ${r.spawnError}` }, lines, stderrTail, t0);
    if (r.exitCode !== 0) {
      const all = [...lines, ...stderrTail];
      const reason = def.failureReason ? def.failureReason(all, r.exitCode) : genericFailureReason(def.label, all, r.exitCode);
      return this.fail(jobId, { code: 'PYTHON_FAILED', message: reason }, lines, stderrTail, t0);
    }

    // ---- type-specific result (import / output / artifacts) -------------------------------------------
    let outcome: JobOutcome;
    try {
      outcome = await def.onSuccess(started.params, ctx, { lines: [...lines], stderrTail, durationMs: r.durationMs });
    } catch (e) {
      if (e instanceof JobFailure) return this.fail(jobId, { code: e.code, message: e.message }, lines, stderrTail, t0);
      this.log.error({ err: e, jobId }, 'job result handling failed');
      const msg = e instanceof Error ? e.message : String(e);
      return this.fail(jobId, { code: 'RESULT_FAILED', message: this.sanitize(msg) }, lines, stderrTail, t0);
    }
    let artifacts: StoredArtifact[];
    try {
      const got = await collectArtifacts(jobDir, { ...ARTIFACT_LIMITS, ...(def.limits.artifacts ?? {}) });
      artifacts = got.artifacts;
      if (got.skipped.length > 0) this.log.warn({ jobId, skipped: got.skipped }, 'artifacts with invalid names / not regular files were not published');
    } catch (e) {
      await def.onDiscard?.(started.params, ctx, outcome).catch(() => undefined);
      if (!(e instanceof ArtifactError)) this.log.error({ err: e, jobId }, 'artifact collection failed');
      const msg = e instanceof ArtifactError ? e.message : 'could not read the artifacts (see server log)';
      return this.fail(jobId, { code: 'ARTIFACTS_FAILED', message: msg }, lines, stderrTail, t0);
    }
    const runBytes = outcome.result ? await dirBytes(outDir).catch(() => null) : null;
    const fin = new Date();
    const ok = await jobs().updateOne(
      { _id: jobId, status: 'running' },
      {
        $set: {
          status: 'succeeded',
          result: outcome.result ?? null,
          output: outcome.output ?? null,
          artifacts,
          progress: { stage: 'done', pct: 100, lines },
          stderr_tail: stderrTail,
          run_bytes: runBytes,
          finished_at: fin,
          duration_ms: Date.now() - t0,
          expires_at: outcome.expiresAt ?? new Date(fin.getTime() + this.resultTtlMs(def)),
        },
        $unset: { active: '' },
      },
    );
    if (ok.matchedCount === 0) {
      // cancelled (or server stopping) during onSuccess: drop what it produced
      await def.onDiscard?.(started.params, ctx, outcome);
    }
    this.emit(jobId);
  }
}

/** One-line reason of a failed Python run (job types without their own failureReason). */
/** Job types that import a run (limits.creates_run). */
export function listRunCreatingTypes(): string[] {
  return listJobTypes()
    .filter((d) => d.limits.creates_run === true)
    .map((d) => d.type);
}

export function genericFailureReason(label: string, lines: readonly string[], exitCode: number | null): string {
  const meaningful = [...lines].reverse().find((l) => l.trim().length > 0 && !/^\s*(File |Traceback|\^)/.test(l));
  return meaningful ? meaningful.trim().slice(0, 500) : `${label} exited with code ${String(exitCode)}`;
}
