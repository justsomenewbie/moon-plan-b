/**
 * Regression tests for the Python-integration review (job engine limits), FAKE lunarnav
 * (tests/jobs/fake_lunarnav: custom latitude -20 hangs, -10 succeeds and imports run_small):
 *   - per-client limit and queue limit hold under CONCURRENT submits (check + insert + enqueue serialized)
 *   - storage budget of job runs (QUOTA_EXCEEDED / STORAGE_FULL; cache hits still served), run_bytes recorded
 *   - PGDA download budget (QUOTA_EXCEEDED for new dem-pgda jobs) and the cache trim
 *   - precompute runs live PRECOMPUTE_RUN_TTL_DAYS (capabilities shows it)
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { Capabilities } from '../../src/contract/capabilities.ts';
import { JobAccepted } from '../../src/contract/jobs.ts';
import { COLLECTIONS, getDb } from '../../src/db.ts';
import { Problem } from '../../src/lib/problem.ts';
import { JobRunner, dirBytes, jobUsesPgda, type RunnerConfig } from '../../src/jobs/runner.ts';
import type { JobDoc } from '../../src/jobs/types.ts';
import { resetCapabilitiesCache } from '../../src/python/capabilities.ts';
import { EVICT_MIN_AGE_MS, checkPgdaBudget, listPgdaBlocks, pgdaDownloadedToday, resetPgdaBudgets, trackPgda, trimPgdaCache } from '../../src/python/pgdaCache.ts';
import { startTestApp, type TestContext } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ROOT = path.join(here, 'fake_lunarnav');
const PY = loadConfig({}).PYTHON_BIN;
const HAVE_PY = existsSync(PY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

const at = (lat: number, lon: number, over: Record<string, unknown> = {}) => ({
  type: 'custom_site',
  lat_deg: lat,
  lon_deg: lon,
  start: '2027-01-01T00:00:00Z',
  end: '2027-01-02T00:00:00Z',
  // engine submits get no zod defaults: the full canonical request
  step_min: 60,
  provider: 'spice',
  dem: 'pgda',
  horizon_method: 'raymarch',
  observer_height_m: 2,
  ...over,
});
type Body = Parameters<JobRunner['submit']>[0];
const codeOf = (r: PromiseSettledResult<unknown>): string => (r.status === 'fulfilled' ? 'ok' : String((r.reason as { code?: string }).code));

describe('PGDA cache helpers (units)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-pgda-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('trims the oldest-used blocks first, keeps recently used ones and non-.npz files', async () => {
    const prod = path.join(dir, 'LDEM_TEST');
    await mkdir(prod, { recursive: true });
    const now = Date.now();
    for (const [name, ageMin] of [['a.npz', 300], ['b.npz', 200], ['c.npz', 100], ['d.npz', 1]] as const) {
      const f = path.join(prod, name);
      await writeFile(f, Buffer.alloc(MB));
      const t = new Date(now - ageMin * 60_000);
      await utimes(f, t, t);
    }
    await writeFile(path.join(prod, 'header.json'), '{}');
    // oldest first: down to the cap with a + b
    expect(await trimPgdaCache(dir, 2 * MB, now)).toEqual({ removed: 2, bytes_removed: 2 * MB, bytes_left: 2 * MB });
    expect((await listPgdaBlocks(dir)).map((b) => path.basename(b.path)).sort()).toEqual(['c.npz', 'd.npz']);
    // c is old enough; d (used 1 min ago) is protected even though the cache stays above the cap
    expect(await trimPgdaCache(dir, 0.5 * MB, now)).toEqual({ removed: 1, bytes_removed: MB, bytes_left: MB });
    expect((await listPgdaBlocks(dir)).map((b) => path.basename(b.path))).toEqual(['d.npz']);
    expect(existsSync(path.join(prod, 'header.json'))).toBe(true);
    const r2 = await trimPgdaCache(dir, 0, now + EVICT_MIN_AGE_MS + 120_000);
    expect(r2.bytes_left).toBe(0);
  });

  it('counts cache growth into the daily download budget (429 QUOTA_EXCEEDED once used)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-root-'));
    const prev = process.env['LUNARNAV_DATA'];
    delete process.env['LUNARNAV_DATA'];
    try {
      resetPgdaBudgets();
      const cfg = { LUNARNAV_ROOT: root, PGDA_DOWNLOAD_MAX_MB_PER_DAY: 1, PGDA_CACHE_MAX_MB: 0 };
      expect(() => checkPgdaBudget(cfg)).not.toThrow();
      const blocks = path.join(root, 'data', 'cache', 'pgda', 'LDEM_TEST');
      await mkdir(blocks, { recursive: true });
      const out = await trackPgda(cfg, async () => {
        await writeFile(path.join(blocks, 'x.npz'), Buffer.alloc(Math.round(1.5 * MB)));
        return 42;
      });
      expect(out).toBe(42);
      expect(pgdaDownloadedToday(cfg)).toBe(Math.round(1.5 * MB));
      let err: unknown = null;
      try {
        checkPgdaBudget(cfg);
      } catch (e) {
        err = e;
      }
      expect((err as { code?: string }).code).toBe('QUOTA_EXCEEDED');
      expect(Number((err as { extras?: { headers?: Record<string, string> } }).extras?.headers?.['retry-after'])).toBeGreaterThanOrEqual(60);
      // a failing call is still accounted (and its error passed on)
      await expect(trackPgda(cfg, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      // 0 = no limit
      expect(() => checkPgdaBudget({ ...cfg, PGDA_DOWNLOAD_MAX_MB_PER_DAY: 0 })).not.toThrow();
    } finally {
      if (prev !== undefined) process.env['LUNARNAV_DATA'] = prev;
      resetPgdaBudgets();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('jobUsesPgda: dem pgda and terrain validation only', () => {
    expect(jobUsesPgda({ type: 'precompute', dem: 'pgda' })).toBe(true);
    expect(jobUsesPgda({ type: 'precompute', dem: 'none' })).toBe(false);
    expect(jobUsesPgda({ type: 'validate_terrain' })).toBe(true);
    expect(jobUsesPgda({ type: 'validate', no_terrain: true })).toBe(false);
    expect(jobUsesPgda({ type: 'validate', no_terrain: false })).toBe(true);
    expect(jobUsesPgda({ type: 'check' })).toBe(false);
  });
});

describe.skipIf(!HAVE_PY)('job limits under concurrency + storage budget (fake lunarnav)', () => {
  let ctx: TestContext;
  let dataRoot: string;
  const prevData = process.env['LUNARNAV_DATA'];
  const runners: JobRunner[] = [];
  const jobs = () => getDb().collection<JobDoc>(COLLECTIONS.jobs);

  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-limits-data-'));
    process.env['LUNARNAV_DATA'] = dataRoot;
    resetCapabilitiesCache();
    resetPgdaBudgets();
    // route defaults: JOB_MAX_ACTIVE_PER_CLIENT 2; a high POST rate limit so only the job limits trip
    ctx = await startTestApp({ config: { LUNARNAV_ROOT: FAKE_ROOT, JOB_CONCURRENCY: 1, JOB_QUEUE_MAX: 20, JOB_TIMEOUT_S: 60, RATE_LIMIT_POST_MAX: 1000 } });
  });
  afterAll(async () => {
    for (const r of runners) await r.close().catch(() => undefined);
    await ctx?.close();
    if (prevData === undefined) delete process.env['LUNARNAV_DATA'];
    else process.env['LUNARNAV_DATA'] = prevData;
    resetPgdaBudgets();
    await rm(dataRoot, { recursive: true, force: true });
  });
  afterEach(async () => {
    // fail whatever is still active (each test uses its own runner; the hanging fake never finishes)
    for (const r of runners.splice(0)) await r.close().catch(() => undefined);
    await jobs().updateMany({ active: true }, { $set: { status: 'cancelled' }, $unset: { active: '' } });
  });

  const base = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
    DATA_DIR: ctx.dataDir,
    PYTHON_BIN: PY,
    LUNARNAV_ROOT: FAKE_ROOT,
    JOB_TIMEOUT_S: 60,
    JOB_CONCURRENCY: 1,
    JOB_QUEUE_MAX: 20,
    CUSTOM_RUN_TTL_DAYS: 30,
    ...over,
  });
  const runner = (over: Partial<RunnerConfig> = {}): JobRunner => {
    const r = new JobRunner(base(over), ctx.app.log);
    runners.push(r);
    return r;
  };
  async function waitDone(r: JobRunner, id: string): Promise<JobDoc> {
    const t0 = Date.now();
    for (;;) {
      const d = await r.get(id);
      if (['succeeded', 'failed', 'cancelled'].includes(d.status)) return d;
      if (Date.now() - t0 > 20_000) throw new Error(`job ${id} still ${d.status}`);
      await sleep(100);
    }
  }

  it('POST /jobs: N > JOB_MAX_ACTIVE_PER_CLIENT concurrent submits from one client -> exactly 2 x 202, rest 429 TOO_MANY_JOBS', async () => {
    const res = await Promise.all(
      [61, 62, 63, 64, 65].map((lon) => ctx.app.inject({ method: 'POST', url: '/api/v1/jobs', payload: at(-20, lon, { dem: 'none' }), remoteAddress: '10.9.0.1' })),
    );
    const codes = res.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 202)).toHaveLength(2);
    expect(codes.filter((c) => c === 429)).toHaveLength(3);
    for (const r of res.filter((x) => x.statusCode === 429)) expect(Problem.parse(r.json()).code).toBe('TOO_MANY_JOBS');
    expect(await jobs().countDocuments({ active: true, 'subscribers.client': '10.9.0.1' })).toBe(2);
    for (const r of res.filter((x) => x.statusCode === 202)) {
      const id = JobAccepted.parse(r.json()).job_id;
      expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${id}`, remoteAddress: '10.9.0.1' })).statusCode).toBe(200);
    }
  });

  it('JOB_QUEUE_MAX holds under concurrent submits from many clients (exactly 3 accepted)', async () => {
    const r = runner({ JOB_QUEUE_MAX: 3, JOB_MAX_ACTIVE_PER_CLIENT: 0 });
    const settled = await Promise.allSettled([71, 72, 73, 74, 75, 76, 77, 78].map((lon) => r.submit(at(-20, lon, { dem: 'none' }) as Body, `10.8.0.${lon}`)));
    const codes = settled.map(codeOf);
    expect(codes.filter((c) => c === 'ok')).toHaveLength(3);
    expect(codes.filter((c) => c === 'QUEUE_FULL')).toHaveLength(5);
    expect(r.load()).toBe(3);
  });

  it('the per-client limit also holds on the engine with the queue nearly empty (no reservation gap)', async () => {
    const r = runner({ JOB_MAX_ACTIVE_PER_CLIENT: 3 });
    const settled = await Promise.allSettled([81, 82, 83, 84, 85, 86, 87].map((lon) => r.submit(at(-20, lon, { dem: 'none' }) as Body, 'c-race')));
    expect(settled.map(codeOf).filter((c) => c === 'ok')).toHaveLength(3);
    expect(settled.map(codeOf).filter((c) => c === 'TOO_MANY_JOBS')).toHaveLength(4);
  });

  it('job-run storage budget: per creator (429 QUOTA_EXCEEDED), per server (503 STORAGE_FULL); cache hits are still served', async () => {
    const r = runner({ JOB_RUNS_MAX_PER_CLIENT: 1 });
    const first = await r.submit(at(-10, 91, { dem: 'none' }) as Body, 'q1');
    const done = await waitDone(r, first.doc._id);
    expect(done.status).toBe('succeeded');
    expect(done.creator).toBe('q1');
    expect(done.run_bytes).toBe(await dirBytes(r.outDir(done._id)));
    expect(done.run_bytes).toBeGreaterThan(0);
    // same client, new parameters -> over its budget
    await expect(r.submit(at(-10, 92, { dem: 'none' }) as Body, 'q1')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', statusCode: 429 });
    // identical parameters -> cache hit, no new run
    expect((await r.submit(at(-10, 91, { dem: 'none' }) as Body, 'q1')).statusCode).toBe(200);

    const liveTotal = await jobs().countDocuments({ type: 'custom_site', status: 'succeeded', result: { $ne: null }, expires_at: { $gt: new Date() } });
    await expect(runner({ JOB_RUNS_MAX_TOTAL: liveTotal }).submit(at(-10, 93, { dem: 'none' }) as Body, 'q2')).rejects.toMatchObject({ code: 'STORAGE_FULL', statusCode: 503 });
    await jobs().updateOne({ _id: done._id }, { $set: { run_bytes: 5 * MB } });
    await expect(runner({ JOB_RUNS_MAX_MB: 4 }).submit(at(-10, 94, { dem: 'none' }) as Body, 'q2')).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    await expect(runner({ DATA_DIR_MIN_FREE_MB: 1_000_000_000 }).submit(at(-10, 95, { dem: 'none' }) as Body, 'q2')).rejects.toMatchObject({
      code: 'STORAGE_FULL',
      extras: { extensions: { quota: 'data_dir_min_free_mb' } },
    });
    // another client still has its own budget
    const other = await r.submit(at(-10, 96, { dem: 'none' }) as Body, 'q2');
    expect((await waitDone(r, other.doc._id)).status).toBe('succeeded');
  });

  it('PGDA download budget: new dem pgda jobs answer 429 QUOTA_EXCEEDED, dem none still runs', async () => {
    resetPgdaBudgets();
    const r = runner({ PGDA_DOWNLOAD_MAX_MB_PER_DAY: 1 });
    const blocks = path.join(dataRoot, 'cache', 'pgda', 'LDEM_TEST');
    await mkdir(blocks, { recursive: true });
    await trackPgda(base(), () => writeFile(path.join(blocks, 'y.npz'), Buffer.alloc(2 * MB)));
    await expect(r.submit(at(-20, 101, { dem: 'pgda' }) as Body, 'p1')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', extras: { extensions: { quota: 'pgda_download_mb_per_day' } } });
    const ok = await r.submit(at(-20, 102, { dem: 'none' }) as Body, 'p1');
    expect(ok.statusCode).toBe(202);
    resetPgdaBudgets();
  });

  it('capabilities: precompute runs live PRECOMPUTE_RUN_TTL_DAYS (7 d), custom_site CUSTOM_RUN_TTL_DAYS (30 d)', async () => {
    const c = Capabilities.parse((await ctx.app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json());
    expect(c.job_types.find((t) => t.type === 'precompute')?.result_ttl_h).toBe(7 * 24);
    expect(c.job_types.find((t) => t.type === 'custom_site')?.result_ttl_h).toBe(30 * 24);
  });
});
