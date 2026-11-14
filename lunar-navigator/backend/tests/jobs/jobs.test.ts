/**
 * Jobs API + engine against a FAKE lunarnav (tests/jobs/fake_lunarnav, selected through LUNARNAV_ROOT =
 * the cwd of `python -m lunarnav.cli`) and a throw-away MongoDB 8.0 (mongodb-memory-server).
 * The fake's success mode copies the real run_small fixture, so the REAL importer runs on job output.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { COLLECTIONS, getDb } from '../../src/db.ts';
import { Job, JobAccepted } from '../../src/contract/jobs.ts';
import { Problem } from '../../src/lib/problem.ts';
import { JobRunner, type RunnerConfig } from '../../src/jobs/runner.ts';
import { cleanupExpired } from '../../src/jobs/cleanup.ts';
import type { JobDoc } from '../../src/jobs/types.ts';
import { startTestApp, type TestContext } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ROOT = path.join(here, 'fake_lunarnav');
const PY = loadConfig({}).PYTHON_BIN;
const HAVE_PY = existsSync(PY);

let ctx: TestContext;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jobs = () => getDb().collection<JobDoc>(COLLECTIONS.jobs);

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'custom_site',
  site_id: 'apollo11',
  start: '2027-01-01T00:00:00Z',
  end: '2027-01-15T00:00:00Z',
  ...over,
});
const at = (lat: number, lon = 20, over: Record<string, unknown> = {}) => body({ site_id: undefined, lat_deg: lat, lon_deg: lon, ...over });

/** `remote` = client IP (per-client limits and job ownership are keyed by it; inject default 127.0.0.1). */
async function post(b: Record<string, unknown>, remote = '127.0.0.1') {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/jobs', payload: JSON.parse(JSON.stringify(b)) as object, remoteAddress: remote });
  return res;
}

async function del(id: string, remote = '127.0.0.1') {
  return ctx.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${id}`, remoteAddress: remote });
}

async function getJob(id: string, remote = '127.0.0.1') {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/jobs/${id}`, remoteAddress: remote });
  expect(res.statusCode).toBe(200);
  return Job.parse(res.json());
}

async function waitFor(id: string, pred: (j: Job) => boolean, timeoutMs = 20_000): Promise<Job> {
  const t0 = Date.now();
  for (;;) {
    const j = await getJob(id);
    if (pred(j)) return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} still ${j.status}: ${JSON.stringify(j.progress)}`);
    await sleep(100);
  }
}
const terminal = (j: Job) => ['succeeded', 'failed', 'cancelled'].includes(j.status);

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(p: string, timeoutMs = 10_000): Promise<string> {
  const t0 = Date.now();
  while (!existsSync(p)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`no file ${p}`);
    await sleep(50);
  }
  await sleep(50);
  return readFile(p, 'utf8');
}

/** Wait until no job is active and every started cancelled job has finished its cleanup (queue drained). */
async function settle(timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const active = await jobs().countDocuments({ active: true });
    const unfinished = await jobs().countDocuments({ status: 'cancelled', started_at: { $ne: null }, duration_ms: null });
    if (active === 0 && unfinished === 0) break;
    if (Date.now() - t0 > timeoutMs) throw new Error(`jobs not settled: active ${active}, unfinished ${unfinished}`);
    await sleep(100);
  }
  await sleep(300);
}

describe.skipIf(!HAVE_PY)('jobs (fake lunarnav)', () => {
  beforeAll(async () => {
    ctx = await startTestApp({
      config: { LUNARNAV_ROOT: FAKE_ROOT, JOB_CONCURRENCY: 1, JOB_QUEUE_MAX: 3, JOB_TIMEOUT_S: 60, RATE_LIMIT_POST_MAX: 1000 },
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  let firstId = '';

  it('POST -> 202 + Location, runs the CLI with --sites, imports the output, then succeeded', async () => {
    const res = await post(body({ name: 'Apollo again' }));
    expect(res.statusCode).toBe(202);
    const acc = JobAccepted.parse(res.json());
    expect(acc).toMatchObject({ status: 'queued', site_id: 'apollo11', cached: false });
    expect(acc.poll).toBe(`/api/v1/jobs/${acc.job_id}`);
    expect(res.headers['location']).toBe(acc.poll);
    firstId = acc.job_id;

    const j = await waitFor(acc.job_id, terminal);
    expect(j.error).toBeNull();
    expect(j.status).toBe('succeeded');
    expect(j.result).toEqual({ run_id: `job_${acc.job_id}`, site_id: 'apollo11' });
    expect(j.progress.stage).toBe('done');
    expect(j.progress.pct).toBe(100);
    expect(j.progress.lines[0]).toBe('[1/1] apollo11: horizon + ephemeris + visibility');
    // absolute server paths are not leaked to the client
    expect(j.progress.lines).toContain(`wrote ${path.join('<DATA_DIR>', 'runs', `job_${acc.job_id}`)}`);
    expect(j.params).toMatchObject({ site_id: 'apollo11', start: '2027-01-01T00:00:00Z', end: '2027-01-15T00:00:00Z', provider: 'horizons', dem: 'pgda', name: 'Apollo again' });
    expect(Date.parse(j.expires_at ?? '') - Date.parse(j.finished_at ?? '')).toBeGreaterThan(29 * 86_400_000);

    // command line, cwd and environment of the child
    const call = JSON.parse(await readFile(path.join(ctx.dataDir, 'jobs', acc.job_id, 'fake_call.json'), 'utf8')) as {
      argv: string[];
      env: Record<string, string | null>;
      cwd: string;
    };
    const val = (k: string) => call.argv[call.argv.indexOf(k) + 1];
    expect(call.argv).not.toContain('--custom-site');
    expect(val('--sites')).toBe('apollo11');
    expect(val('--provider')).toBe('horizons'); // web default since 14/11 (online)
    expect(val('--horizon-method')).toBe('raymarch');
    expect(path.resolve(val('--out') ?? '')).toBe(path.resolve(ctx.dataDir, 'runs', `job_${acc.job_id}`));
    expect(path.resolve(call.env['LUNARNAV_OUTPUT'] ?? '')).toBe(path.resolve(ctx.dataDir, 'jobs', acc.job_id));
    expect(path.resolve(call.env['LUNARNAV_DATA'] ?? '')).toBe(path.resolve(FAKE_ROOT, 'data'));
    expect(call.env['PYTHONIOENCODING']).toBe('utf-8');
    expect(path.resolve(call.cwd)).toBe(path.resolve(FAKE_ROOT));
    expect(await readFile(path.join(ctx.dataDir, 'jobs', acc.job_id, 'precompute.log'), 'utf8')).toContain('check_output: 0 violation(s)');

    // the real importer stored the run as a custom run
    const run = await getDb().collection<{ _id: string; kind: string; status: string; expires_at: Date | null; label: string; is_default: boolean }>(COLLECTIONS.runs).findOne({ _id: `job_${acc.job_id}` });
    expect(run).toMatchObject({ kind: 'custom', status: 'ready', label: 'Apollo again', is_default: false });
    expect(run?.expires_at).toBeInstanceOf(Date);
    expect(await getDb().collection(COLLECTIONS.site_runs).countDocuments({ run_id: `job_${acc.job_id}` })).toBe(3);
    expect(await getDb().collection(COLLECTIONS.series).countDocuments({ 'meta.run_id': `job_${acc.job_id}`, 'meta.site_id': 'apollo11' })).toBe(336);
  });

  it('an identical request is served from the succeeded job (200, cached)', async () => {
    const res = await post(body({ name: 'different display name', start: '2027-01-01T00:20:00Z' })); // snaps to the same hour
    expect(res.statusCode).toBe(200);
    expect(JobAccepted.parse(res.json())).toMatchObject({ job_id: firstId, status: 'succeeded', cached: true });
  });

  it('canonicalises custom coordinates (west longitude -> east)', async () => {
    const res = await post(at(-10, -340));
    expect(res.statusCode).toBe(202);
    const acc = JobAccepted.parse(res.json());
    expect(acc.site_id).toBe('custom:-10.0000:20.0000');
    const j = await waitFor(acc.job_id, terminal);
    expect(j.status).toBe('succeeded');
    expect(j.result?.site_id).toBe('custom:-10.0000:20.0000');
    // same site given by its id -> same job
    const again = await post(body({ site_id: 'custom:-10.0000:20.0000' }));
    expect(again.statusCode).toBe(200);
    expect(JobAccepted.parse(again.json()).job_id).toBe(acc.job_id);
  });

  it('merges identical active jobs, cancels a running job and kills its process', async () => {
    const a = JobAccepted.parse((await post(at(-20, 1))).json());
    const b = await post(at(-20, 1));
    expect(b.statusCode).toBe(202);
    expect(JobAccepted.parse(b.json())).toMatchObject({ job_id: a.job_id, cached: true });

    const pid = Number(await waitForFile(path.join(ctx.dataDir, 'jobs', a.job_id, 'pid.txt')));
    expect(await pidAlive(pid)).toBe(true);
    const running = await waitFor(a.job_id, (j) => j.status === 'running' && j.progress.lines.length > 0);
    expect(running.progress.stage).toBe('precompute');
    expect(running.progress.pct).toBe(10);

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${a.job_id}` });
    expect(del.statusCode).toBe(200);
    expect(Job.parse(del.json()).status).toBe('cancelled');
    const t0 = Date.now();
    while ((await pidAlive(pid)) && Date.now() - t0 < 10_000) await sleep(100);
    expect(await pidAlive(pid)).toBe(false);
    expect(existsSync(path.join(ctx.dataDir, 'runs', `job_${a.job_id}`))).toBe(false);

    const again = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${a.job_id}` });
    expect(again.statusCode).toBe(409);
    expect(Problem.parse(again.json()).code).toBe('JOB_NOT_CANCELLABLE');
    // a cancelled job is not a cache hit: the same request starts a new job
    const c = await post(at(-20, 1));
    expect(c.statusCode).toBe(202);
    const cj = JobAccepted.parse(c.json());
    expect(cj.job_id).not.toBe(a.job_id);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${cj.job_id}` })).statusCode).toBe(200);
    await settle();
  });

  it('a shared job is cancelled only when its last client leaves; strangers get 403 JOB_NOT_YOURS', async () => {
    await settle();
    const A = '10.1.0.1';
    const B = '10.1.0.2';
    const C = '10.1.0.3';
    const a = await post(at(-20, 11, { name: 'user A' }), A);
    expect(a.statusCode).toBe(202);
    const aj = JobAccepted.parse(a.json());
    const b = await post(at(-20, 11, { name: 'user B' }), B);
    expect(b.statusCode).toBe(202);
    expect(JobAccepted.parse(b.json())).toMatchObject({ job_id: aj.job_id, cached: true });
    // a repeated POST from the same client does not subscribe it twice
    expect((await post(at(-20, 11, { name: 'user B' }), B)).statusCode).toBe(202);

    const pid = Number(await waitForFile(path.join(ctx.dataDir, 'jobs', aj.job_id, 'pid.txt')));
    await waitFor(aj.job_id, (j) => j.status === 'running');
    // each client sees its own display name; clients = 2
    expect((await getJob(aj.job_id, A)).params['name']).toBe('user A');
    const seenByB = await getJob(aj.job_id, B);
    expect(seenByB.params['name']).toBe('user B');
    expect(seenByB.clients).toBe(2);

    // a client that never submitted it cannot cancel it
    const stranger = await del(aj.job_id, C);
    expect(stranger.statusCode).toBe(403);
    expect(Problem.parse(stranger.json()).code).toBe('JOB_NOT_YOURS');

    // B leaves: the job keeps running for A, the Python process is alive
    const bLeft = await del(aj.job_id, B);
    expect(bLeft.statusCode).toBe(200);
    expect(Job.parse(bLeft.json())).toMatchObject({ status: 'running', clients: 1 });
    await sleep(300);
    expect(await pidAlive(pid)).toBe(true);
    expect((await getJob(aj.job_id)).status).toBe('running');
    // B is no longer subscribed
    expect((await del(aj.job_id, B)).statusCode).toBe(403);

    // A leaves too: now it is cancelled and the process is killed
    const aLeft = await del(aj.job_id, A);
    expect(aLeft.statusCode).toBe(200);
    expect(Job.parse(aLeft.json())).toMatchObject({ status: 'cancelled', clients: 0 });
    const t0 = Date.now();
    while ((await pidAlive(pid)) && Date.now() - t0 < 10_000) await sleep(100);
    expect(await pidAlive(pid)).toBe(false);
    await settle();
  });

  it('429 TOO_MANY_JOBS beyond JOB_MAX_ACTIVE_PER_CLIENT (2) for one client; other clients still get in', async () => {
    await settle();
    const A = '10.2.0.1';
    const ids: string[] = [];
    for (const lon of [21, 22]) {
      const r = await post(at(-20, lon), A);
      expect(r.statusCode).toBe(202);
      ids.push(JobAccepted.parse(r.json()).job_id);
    }
    const third = await post(at(-20, 23), A);
    expect(third.statusCode).toBe(429);
    const p = Problem.parse(third.json());
    expect(p.code).toBe('TOO_MANY_JOBS');
    expect(p['max_active_per_client']).toBe(2);
    expect(third.headers['retry-after']).toBe('30');
    // the limit is per client: A's IPv6 neighbour in the same /64 is ONE client, so it can join (no new job)
    // but A itself may still join a running job of somebody else (subscribing starts nothing)
    const v6 = '2001:db8:1:2::10';
    const join = await post(at(-20, 21), v6);
    expect(join.statusCode).toBe(202);
    expect(JobAccepted.parse(join.json()).job_id).toBe(ids[0]);
    expect((await getJob(ids[0] ?? '')).clients).toBe(2);
    // clean up: queued one first; the shared one is cancelled when its second client (same /64, other address) leaves
    expect((await del(ids[1] ?? '', A)).statusCode).toBe(200);
    expect(Job.parse((await del(ids[0] ?? '', '2001:db8:1:2:ffff::1')).json()).clients).toBe(1);
    expect(Job.parse((await del(ids[0] ?? '', A)).json()).status).toBe('cancelled');
    await settle();
  });

  it('limits concurrent event streams per client (429 TOO_MANY_STREAMS) and shares one poll per job', async () => {
    await settle();
    const r = await post(at(-20, 31), '10.3.0.1');
    const id = JobAccepted.parse(r.json()).job_id;
    await waitFor(id, (j) => j.status === 'running');
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const controllers: AbortController[] = [];
    try {
      const open = async (): Promise<number> => {
        const ac = new AbortController();
        controllers.push(ac);
        const res = await fetch(`${address}/api/v1/jobs/${id}/events`, { signal: ac.signal });
        if (res.status !== 200) {
          await res.text();
          return res.status;
        }
        // first event arrived = stream registered
        const reader = res.body?.getReader();
        await reader?.read();
        return res.status;
      };
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push(await open());
      expect(statuses).toEqual([200, 200, 200, 200, 200]);
      const sixth = await fetch(`${address}/api/v1/jobs/${id}/events`);
      expect(sixth.status).toBe(429);
      expect(((await sixth.json()) as { code: string }).code).toBe('TOO_MANY_STREAMS');
      // closing one frees a slot
      controllers.shift()?.abort();
      await sleep(300);
      expect(await open()).toBe(200);
    } finally {
      for (const ac of controllers) ac.abort();
    }
    expect((await del(id, '10.3.0.1')).statusCode).toBe(200);
    await settle();
  });

  it('cancels a queued job without ever starting it; 429 QUEUE_FULL beyond JOB_QUEUE_MAX', async () => {
    await settle();
    const ids: string[] = [];
    // three different clients (the per-client limit is 2), so the GLOBAL queue limit (3) is what trips
    const ip = (lon: number) => `10.0.0.${lon}`;
    for (const lon of [2, 3, 4]) {
      const r = await post(at(-20, lon), ip(lon));
      expect(r.statusCode).toBe(202);
      ids.push(JobAccepted.parse(r.json()).job_id);
    }
    const full = await post(at(-20, 5), ip(5));
    expect(full.statusCode).toBe(429);
    const p = Problem.parse(full.json());
    expect(p.code).toBe('QUEUE_FULL');
    expect(full.headers['retry-after']).toBe('60');
    expect(full.headers['content-type']).toMatch(/application\/problem\+json/);

    const last = ids[2] ?? '';
    expect((await getJob(last)).status).toBe('queued');
    const d = await del(last, ip(4));
    expect(Job.parse(d.json()).status).toBe('cancelled');
    // queued one first, so it never starts when the running one is killed
    for (const [id, lon] of [[ids[1] ?? '', 3], [ids[0] ?? '', 2]] as const) {
      expect((await del(id, ip(lon))).statusCode).toBe(200);
    }
    for (const id of [last, ids[1] ?? '']) {
      const never = await jobs().findOne({ _id: id });
      expect(never?.started_at).toBeNull();
      expect(existsSync(path.join(ctx.dataDir, 'jobs', id))).toBe(false);
    }
    await settle();
    // capacity is back
    const ok = await post(at(-10, 6));
    expect(ok.statusCode).toBe(202);
    expect((await waitFor(JobAccepted.parse(ok.json()).job_id, terminal)).status).toBe('succeeded');
  });

  it('reports Python failures with a useful reason', async () => {
    const v = JobAccepted.parse((await post(at(-30))).json());
    const jv = await waitFor(v.job_id, terminal);
    expect(jv.status).toBe('failed');
    expect(jv.error).toEqual({ code: 'PYTHON_FAILED', message: 'check_output failed: 1 violation(s), first: sites/x/windows.json: metrics differ from visibility' });
    expect(jv.result).toBeNull();

    const s = JobAccepted.parse((await post(at(-40))).json());
    const js = await waitFor(s.job_id, terminal);
    expect(js.status).toBe('failed');
    expect(js.error?.code).toBe('PYTHON_FAILED');
    expect(js.error?.message).toContain('x: missing DEM file');
    expect(js.progress.lines.some((l) => l.includes('cannot serve 1 site'))).toBe(true);
    expect(Date.parse(js.expires_at ?? '') - Date.parse(js.finished_at ?? '')).toBe(24 * 3_600_000);

    // a failed job is retried by the next identical POST (new job)
    const retry = await post(at(-40));
    expect(retry.statusCode).toBe(202);
    expect(JobAccepted.parse(retry.json()).job_id).not.toBe(s.job_id);
    await waitFor(JobAccepted.parse(retry.json()).job_id, terminal);
  });

  it('fails with IMPORT_FAILED when the output cannot be imported, leaving no run behind', async () => {
    const r = JobAccepted.parse((await post(at(-50))).json());
    const j = await waitFor(r.job_id, terminal);
    expect(j.status).toBe('failed');
    expect(j.error?.code).toBe('IMPORT_FAILED');
    expect(j.error?.message).not.toContain(ctx.dataDir);
    expect(await getDb().collection(COLLECTIONS.runs).countDocuments({ _id: `job_${r.job_id}` } as object)).toBe(0);
    expect(existsSync(path.join(ctx.dataDir, 'runs', `job_${r.job_id}`))).toBe(false);
  });

  it('validates requests and ids', async () => {
    const both = await post(body({ lat_deg: -80, lon_deg: 10 }));
    expect(both.statusCode).toBe(400);
    expect(Problem.parse(both.json()).code).toBe('VALIDATION_ERROR');
    const unknown = await post(body({ site_id: 'not_a_site' }));
    expect(unknown.statusCode).toBe(404);
    expect(Problem.parse(unknown.json()).code).toBe('SITE_NOT_FOUND');
    const nonCanon = await post(body({ site_id: 'custom:-89.45:222.69' }));
    expect(nonCanon.statusCode).toBe(400);
    const long = await post(body({ end: '2028-01-03T00:00:00Z' }));
    expect(long.statusCode).toBe(422);
    expect(Problem.parse(long.json())).toMatchObject({ code: 'OUT_OF_RANGE', max_end: '2028-01-02T00:00:00Z' });
    const badStep = await post(body({ step_min: 30 }));
    expect(badStep.statusCode).toBe(400);
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/jobs/j_doesnotexist1' });
    expect(missing.statusCode).toBe(404);
    expect(Problem.parse(missing.json()).code).toBe('JOB_NOT_FOUND');
    const badId = await ctx.app.inject({ method: 'GET', url: '/api/v1/jobs/nope' });
    expect(badId.statusCode).toBe(400);
  });

  it('streams job events (SSE) and ends after a terminal status', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/jobs/${firstId}/events` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    const events = res.body.split('\n\n').filter((e) => e.startsWith('event: job'));
    expect(events).toHaveLength(1);
    const data = Job.parse(JSON.parse(events[0]?.split('\ndata: ')[1] ?? '{}'));
    expect(data).toMatchObject({ job_id: firstId, status: 'succeeded' });
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/jobs/j_doesnotexist1/events' });
    expect(missing.statusCode).toBe(404);
  });

  describe('engine (separate runners on the same database)', () => {
    const base = (): RunnerConfig => ({
      DATA_DIR: ctx.dataDir,
      PYTHON_BIN: PY,
      LUNARNAV_ROOT: FAKE_ROOT,
      JOB_TIMEOUT_S: 60,
      JOB_CONCURRENCY: 1,
      JOB_QUEUE_MAX: 5,
      CUSTOM_RUN_TTL_DAYS: 30,
    });
    const submitAndWait = async (runner: JobRunner, b: Record<string, unknown>): Promise<JobDoc> => {
      const r = await runner.submit(b as Parameters<JobRunner['submit']>[0]);
      const t0 = Date.now();
      for (;;) {
        const d = await runner.get(r.doc._id);
        if (['succeeded', 'failed', 'cancelled'].includes(d.status)) return d;
        if (Date.now() - t0 > 20_000) throw new Error('timeout');
        await sleep(100);
      }
    };
    const full = (lat: number, lon: number) => ({
      type: 'custom_site',
      lat_deg: lat,
      lon_deg: lon,
      start: '2027-01-01T00:00:00Z',
      end: '2027-01-02T00:00:00Z',
      step_min: 60,
      provider: 'spice',
      dem: 'pgda',
      horizon_method: 'raymarch',
      observer_height_m: 2,
    });

    it('kills a job that exceeds JOB_TIMEOUT_S (PYTHON_TIMEOUT)', async () => {
      const runner = new JobRunner({ ...base(), JOB_TIMEOUT_S: 1 }, ctx.app.log);
      const d = await submitAndWait(runner, full(-20, 50));
      expect(d.status).toBe('failed');
      expect(d.error).toEqual({ code: 'PYTHON_TIMEOUT', message: 'lunarnav precompute exceeded 1 s' });
      expect(d.duration_ms).toBeLessThan(10_000);
      const pid = Number(await readFile(path.join(ctx.dataDir, 'jobs', d._id, 'pid.txt'), 'utf8'));
      expect(await pidAlive(pid)).toBe(false);
      await runner.close();
    });

    it('fails with PYTHON_UNAVAILABLE when the interpreter is missing', async () => {
      const runner = new JobRunner({ ...base(), PYTHON_BIN: path.join(ctx.dataDir, 'no', 'python.exe') }, ctx.app.log);
      const d = await submitAndWait(runner, full(-10, 51));
      expect(d.status).toBe('failed');
      expect(d.error?.code).toBe('PYTHON_UNAVAILABLE');
      await runner.close();
    });

    it('boot recovery: jobs left queued/running by a dead server become failed SERVER_RESTARTED', async () => {
      const now = new Date();
      const stale = (id: string, status: 'queued' | 'running'): JobDoc => ({
        _id: id,
        type: 'custom_site',
        status,
        active: true,
        params: { type: 'custom_site', site_id: `custom:-1.0000:${id.length}.0000`, lat_deg: -1, lon_deg: id.length, start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z', step_min: 60, provider: 'spice', dem: 'pgda', horizon_method: 'raymarch', observer_height_m: 2 },
        name: null,
        params_hash: `hash_${id}`,
        code_version: 'x',
        progress: { stage: 'precompute', pct: 10, lines: ['[1/1] x'] },
        stderr_tail: [],
        result: null,
        error: null,
        owner: 'dead-host:1:abc',
        duration_ms: null,
        created_at: now,
        started_at: status === 'running' ? now : null,
        finished_at: null,
        expires_at: null,
      });
      await jobs().insertMany([stale('j_stalerunning1', 'running'), stale('j_stalequeued12', 'queued')]);
      const partial = path.join(ctx.dataDir, 'runs', 'job_j_stalerunning1');
      await mkdir(partial, { recursive: true });
      await writeFile(path.join(partial, 'half.csv'), 'x');

      const runner = new JobRunner(base(), ctx.app.log);
      const { recovered } = await runner.start();
      expect(recovered).toBe(2);
      for (const id of ['j_stalerunning1', 'j_stalequeued12']) {
        const j = await getJob(id);
        expect(j.status).toBe('failed');
        expect(j.error?.code).toBe('SERVER_RESTARTED');
        expect(j.finished_at).not.toBeNull();
        expect((await jobs().findOne({ _id: id }))?.active).toBeUndefined();
      }
      expect(existsSync(partial)).toBe(false);
      await runner.close();
    });

    it('result TTL: cleanup removes expired jobs, their runs and directories, keeps live ones', async () => {
      const db = getDb();
      // firstId succeeded above (run job_<firstId> imported). Expire it.
      await jobs().updateOne({ _id: firstId }, { $set: { expires_at: new Date(Date.now() - 1000) } });
      const orphanDir = path.join(ctx.dataDir, 'runs', 'job_j_orphandir123');
      await mkdir(orphanDir, { recursive: true });
      const keepDir = path.join(ctx.dataDir, 'runs', 'pf_keepme');
      await mkdir(keepDir, { recursive: true });
      const liveBefore = await jobs().countDocuments({ status: 'succeeded' });

      const report = await cleanupExpired(db, ctx.dataDir);
      expect(report.expired_jobs).toBe(1);
      expect(report.removed_dirs).toBeGreaterThanOrEqual(1);
      expect(await jobs().findOne({ _id: firstId })).toBeNull();
      expect(await db.collection(COLLECTIONS.runs).countDocuments({ _id: `job_${firstId}` } as object)).toBe(0);
      expect(await db.collection(COLLECTIONS.series).countDocuments({ 'meta.run_id': `job_${firstId}` })).toBe(0);
      expect(await db.collection(COLLECTIONS.site_runs).countDocuments({ run_id: `job_${firstId}` })).toBe(0);
      expect(existsSync(path.join(ctx.dataDir, 'runs', `job_${firstId}`))).toBe(false);
      expect(existsSync(path.join(ctx.dataDir, 'jobs', firstId))).toBe(false);
      expect(existsSync(orphanDir)).toBe(false);
      expect(existsSync(keepDir)).toBe(true);
      expect(await jobs().countDocuments({ status: 'succeeded' })).toBe(liveBefore - 1);
      // the other succeeded custom job (custom:-10.0000:20.0000) is untouched
      const other = await jobs().findOne({ 'params.site_id': 'custom:-10.0000:20.0000', status: 'succeeded' });
      expect(other).not.toBeNull();
      expect(existsSync(path.join(ctx.dataDir, 'runs', `job_${other?._id ?? ''}`))).toBe(true);
      // the expired job id no longer resolves
      const gone = await ctx.app.inject({ method: 'GET', url: `/api/v1/jobs/${firstId}` });
      expect(gone.statusCode).toBe(404);
    });

    it('does not reuse a succeeded job whose run is gone or which expires soon', async () => {
      const old = await jobs().findOne({ 'params.site_id': 'custom:-10.0000:6.0000', status: 'succeeded' });
      expect(old).not.toBeNull();
      await getDb().collection<{ _id: string }>(COLLECTIONS.runs).deleteOne({ _id: old?.result?.run_id ?? '' });
      const r1 = await post(at(-10, 6));
      expect(r1.statusCode).toBe(202);
      const id1 = JobAccepted.parse(r1.json()).job_id;
      expect(id1).not.toBe(old?._id);
      expect((await waitFor(id1, terminal)).status).toBe('succeeded');
      expect((await post(at(-10, 6))).statusCode).toBe(200);

      await jobs().updateOne({ _id: id1 }, { $set: { expires_at: new Date(Date.now() + 3_600_000) } });
      const r2 = await post(at(-10, 6));
      expect(r2.statusCode).toBe(202);
      expect(JobAccepted.parse(r2.json()).job_id).not.toBe(id1);
      await waitFor(JobAccepted.parse(r2.json()).job_id, terminal);
    });
  });
});
