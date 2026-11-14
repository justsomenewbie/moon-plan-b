/**
 * Job types 'precompute' and 'analyse' (builder B1) through the real POST /jobs route with a FAKE lunarnav
 * (tests/jobs/fake_b1: argparse CLI with the real long options, catalog of 5 sites) and the real importer
 * (the fake precompute copies tests/importer/fixtures/run_small = real lunarnav output of apollo11,
 * custom:-89.4500:222.6900 and ref_shackleton_rim). LUNARNAV_DATA points to a scratch dir so the tests can
 * add a Trek GeoTIFF / hide --near-exclusion-m and re-probe the capabilities.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { Capabilities } from '../../src/contract/capabilities.ts';
import { Job, JobAccepted } from '../../src/contract/jobs.ts';
import { AnalyseJobOutput } from '../../src/contract/job_types/analyse.ts';
import { PRECOMPUTE_LIMITS, PrecomputeJobOutput } from '../../src/contract/job_types/precompute.ts';
import { COLLECTIONS, getDb } from '../../src/db.ts';
import { Problem } from '../../src/lib/problem.ts';
import { checkJobSize, computeFlags, snapPeriod } from '../../src/jobs/types/precompute.ts';
import { resetCapabilitiesCache } from '../../src/python/capabilities.ts';
import { startTestApp, type TestContext } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ROOT = path.join(here, 'fake_b1');
const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FIXTURE_SITES = ['apollo11', 'custom:-89.4500:222.6900', 'ref_shackleton_rim'];
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

/** Request whose sites are exactly the fixture's (so the fake output imports). */
const okBody = (over: Record<string, unknown> = {}) => ({
  type: 'precompute',
  sites: ['ref_shackleton_rim', 'apollo11'],
  custom_sites: [{ lat_deg: -89.45, lon_deg: -137.31 }],
  start: '2027-01-01T00:30:00Z',
  end: '2027-01-14T23:10:00Z',
  ...over,
});

describe('compute helpers (units)', () => {
  it('snaps the period to the step grid and guards the job size', () => {
    expect(snapPeriod('2027-01-01T00:30:00Z', '2027-01-01T05:10:00Z', 60)).toEqual({ start: '2027-01-01T00:00:00Z', end: '2027-01-01T06:00:00Z', n_samples: 6 });
    expect(snapPeriod('2027-01-01T00:07:00Z', '2027-01-01T00:31:00Z', 15)).toEqual({ start: '2027-01-01T00:00:00Z', end: '2027-01-01T00:45:00Z', n_samples: 3 });
    const code = (f: () => unknown): string | undefined => {
      try {
        f();
      } catch (e) {
        return (e as { code?: string }).code;
      }
      return undefined;
    };
    expect(code(() => snapPeriod('2027-01-01T01:00:00Z', '2027-01-01T01:00:00Z', 60))).toBe('VALIDATION_ERROR');
    expect(code(() => snapPeriod('1850-01-01T00:00:00Z', '1850-02-01T00:00:00Z', 60))).toBe('OUT_OF_RANGE');
    expect(code(() => checkJobSize(PRECOMPUTE_LIMITS.max_sites + 1, 10, 'spice'))).toBe('JOB_TOO_LARGE');
    expect(code(() => checkJobSize(1, PRECOMPUTE_LIMITS.max_samples_per_site + 1, 'spice'))).toBe('JOB_TOO_LARGE');
    expect(code(() => checkJobSize(10, 60_001, 'spice'))).toBe('JOB_TOO_LARGE');
    expect(code(() => checkJobSize(10, 60_000, 'spice'))).toBeUndefined();
    expect(code(() => checkJobSize(2, 80_000, 'horizons'))).toBe('JOB_TOO_LARGE');
  });

  it('builds one --flag=value element per option (negative / fractional values safe)', () => {
    const base = { step_min: 30, provider: 'spice', dem: 'pgda', horizon_method: 'raymarch', radius_km: 60.5, az_step_deg: 0.25, observer_height_m: 0, min_clearance_deg: 1.5, dem_fallback: 'error', near_exclusion_m: null } as const;
    expect(computeFlags(base)).toEqual([
      '--step-min=30',
      '--provider=spice',
      '--dem=pgda',
      '--horizon-method=raymarch',
      '--radius-km=60.5',
      '--az-step=0.25',
      '--observer-height=0',
      '--min-clearance=1.5',
      '--dem-fallback=error',
    ]);
    expect(computeFlags({ ...base, near_exclusion_m: 0 }).at(-1)).toBe('--near-exclusion-m=0');
  });
});

describe.skipIf(!HAVE_PY)('precompute + analyse jobs (fake lunarnav B1)', () => {
  let ctx: TestContext;
  let dataRoot: string;
  const prevData = process.env['LUNARNAV_DATA'];

  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-b1-data-'));
    process.env['LUNARNAV_DATA'] = dataRoot;
    resetCapabilitiesCache();
    ctx = await startTestApp({
      config: { LUNARNAV_ROOT: FAKE_ROOT, JOB_CONCURRENCY: 1, JOB_QUEUE_MAX: 20, JOB_TIMEOUT_S: 60, RATE_LIMIT_POST_MAX: 1000, JOB_MAX_ACTIVE_PER_CLIENT: 50 },
    });
  });
  afterAll(async () => {
    await ctx?.close();
    if (prevData === undefined) delete process.env['LUNARNAV_DATA'];
    else process.env['LUNARNAV_DATA'] = prevData;
    await rm(dataRoot, { recursive: true, force: true });
  });

  const post = (b: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/api/v1/jobs', payload: b });
  const get = (url: string) => ctx.app.inject({ method: 'GET', url });
  async function waitFor(id: string, pred: (j: Job) => boolean = (j) => TERMINAL.includes(j.status), timeoutMs = 20_000): Promise<Job> {
    const t0 = Date.now();
    for (;;) {
      const j = Job.parse((await get(`/api/v1/jobs/${id}`)).json());
      if (pred(j)) return j;
      if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} still ${j.status}`);
      await sleep(100);
    }
  }
  async function accepted(b: Record<string, unknown>): Promise<JobAccepted> {
    const res = await post(b);
    expect(res.statusCode, res.body).toBe(202);
    return JobAccepted.parse(res.json());
  }
  async function problem(b: Record<string, unknown>, status: number, code: string): Promise<Problem> {
    const res = await post(b);
    expect(res.statusCode, res.body).toBe(status);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const p = Problem.parse(res.json());
    expect(p.code).toBe(code);
    return p;
  }
  const fakeCall = async (jobId: string, cmd: string) =>
    JSON.parse(await readFile(path.join(ctx.dataDir, 'jobs', jobId, `fake_call_${cmd}.json`), 'utf8')) as { argv: string[]; env: Record<string, string | null>; script: string };
  async function reprobe(): Promise<Capabilities> {
    resetCapabilitiesCache();
    return Capabilities.parse((await get('/api/v1/capabilities')).json());
  }

  it('GET /capabilities: the three B1 types are implemented and available, with their limits', async () => {
    const c = await reprobe();
    expect(c.cli.near_exclusion_m).toBe(true);
    for (const t of ['precompute', 'analyse', 'alt_dates_python'] as const) {
      expect(c.job_types.find((j) => j.type === t), t).toMatchObject({ implemented: true, available: true, reason: null });
    }
    expect(c.job_types.find((j) => j.type === 'precompute')).toMatchObject({ timeout_s: 3600, limits: { max_sites: 30, max_site_samples: 600_000 } });
    expect(c.job_types.find((j) => j.type === 'analyse')).toMatchObject({ result_ttl_h: 168 });
  });

  it('precompute: catalog + custom sites -> imported run (kind precompute), exact argv, output, summary.csv artifact', async () => {
    const acc = await accepted(okBody({ run_label: 'B1 test run', near_exclusion_m: 250, step_min: 60, radius_km: 80, az_step_deg: 1, min_clearance_deg: 2 }));
    expect(acc).toMatchObject({ type: 'precompute', site_id: null, cached: false });
    const j = await waitFor(acc.job_id);
    expect(j.error).toBeNull();
    expect(j.status).toBe('succeeded');
    const runId = `job_${acc.job_id}`;
    expect(j.result).toEqual({ run_id: runId, site_id: 'apollo11' });
    expect(j.params).toMatchObject({
      type: 'precompute',
      site_ids: FIXTURE_SITES,
      start: '2027-01-01T00:00:00Z',
      end: '2027-01-15T00:00:00Z',
      provider: 'horizons',
      dem: 'pgda',
      horizon_method: 'raymarch',
      dem_fallback: 'flat',
      near_exclusion_m: 250,
      run_label: 'B1 test run',
    });
    const out = PrecomputeJobOutput.parse(j.output);
    expect(out).toMatchObject({ run_id: runId, run_label: 'B1 test run', n_sites: 3, n_samples: 336, step_min: 60 });
    expect(out.sites.map((s) => [s.site_id, s.dem_source, s.dem_fallback])).toEqual([
      ['apollo11', 'none', false],
      ['custom:-89.4500:222.6900', 'none', false],
      ['ref_shackleton_rim', 'none', false],
    ]);
    expect(j.artifacts.map((a) => a.name)).toEqual(['summary.csv']);
    expect(j.progress.lines).toContain('[1/3] apollo11: horizon + ephemeris + visibility');

    const call = await fakeCall(acc.job_id, 'precompute');
    expect(call.argv).toEqual([
      'precompute',
      '--sites=apollo11,custom:-89.4500:222.6900,ref_shackleton_rim',
      '--start=2027-01-01T00:00:00Z',
      '--end=2027-01-15T00:00:00Z',
      '--step-min=60',
      '--provider=horizons',
      '--dem=pgda',
      '--horizon-method=raymarch',
      '--radius-km=80',
      '--az-step=1',
      '--observer-height=2',
      '--min-clearance=2',
      '--dem-fallback=flat',
      '--near-exclusion-m=250',
      `--out=${path.join(ctx.dataDir, 'runs', runId)}`,
      `--run-timestamp=${j.created_at}`,
    ]);
    expect(call.env['MONGODB_URI']).toBeNull();
    expect(call.env['LUNARNAV_OUTPUT']).toBe(path.join(ctx.dataDir, 'jobs', acc.job_id));

    const run = await getDb().collection<{ _id: string; kind: string; status: string; label: string }>(COLLECTIONS.runs).findOne({ _id: runId });
    expect(run).toMatchObject({ kind: 'precompute', status: 'ready', label: 'B1 test run' });
    const site = await get(`/api/v1/sites/${encodeURIComponent('custom:-89.4500:222.6900')}?run_id=${runId}`);
    expect(site.statusCode).toBe(200);
    const csv = await get(j.artifacts[0]?.url ?? '');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.body.split('\n')[0]).toMatch(/^rank,site_id,/);

    // an equivalent request (other order, custom id as a selector, 'auto' / default fields explicit) is a cache hit
    const again = await post({
      type: 'precompute',
      name: 'other display name',
      sites: ['custom:-89.4500:222.6900', 'apollo11', 'ref_shackleton_rim', 'apollo11'],
      start: '2027-01-01T00:00:00Z',
      end: '2027-01-15T00:00:00Z',
      run_label: 'B1 test run',
      near_exclusion_m: 250,
      radius_km: 80,
      az_step_deg: 1,
      min_clearance_deg: 2,
      provider: 'horizons',
      dem_fallback: 'flat',
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(JobAccepted.parse(again.json())).toMatchObject({ job_id: acc.job_id, cached: true, status: 'succeeded' });
  });

  it("expands 'all' / 'group:<g>'; an output without the requested sites fails with IMPORT_FAILED and leaves nothing", async () => {
    const acc = await accepted({ type: 'precompute', sites: 'group:south_pole', start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z', dem: 'none' });
    const j = await waitFor(acc.job_id);
    expect(j.params).toMatchObject({ site_ids: ['a3_haworth', 'a3_nobile_rim_1'], horizon_method: 'flat', near_exclusion_m: null });
    expect(j.status).toBe('failed');
    expect(j.error?.code).toBe('IMPORT_FAILED');
    expect(j.error?.message).toMatch(/lacks 2 requested site\(s\): a3_haworth, a3_nobile_rim_1/);
    expect(existsSync(path.join(ctx.dataDir, 'runs', `job_${acc.job_id}`))).toBe(false);
    expect(await getDb().collection(COLLECTIONS.runs).countDocuments({ _id: `job_${acc.job_id}` as never })).toBe(0);
    expect((await fakeCall(acc.job_id, 'precompute')).argv).not.toContain('--near-exclusion-m=auto');

    const all = await accepted({ type: 'precompute', sites: ['all', 'apollo11'], custom_sites: [{ lat_deg: -10, lon_deg: 20 }], start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' });
    const ja = await waitFor(all.job_id);
    expect((ja.params as { site_ids: string[] }).site_ids).toEqual([
      'a3_haworth',
      'a3_nobile_rim_1',
      'apollo11',
      'custom:-10.0000:20.0000',
      'ref_connecting_ridge_c1',
      'ref_shackleton_rim',
    ]);
  });

  it('rejects bad / unsafe requests before queueing (400 / 404 / 422)', async () => {
    const base = { type: 'precompute', start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' };
    await problem({ ...base }, 400, 'VALIDATION_ERROR'); // no site
    await problem({ ...base, sites: [] }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: ['nowhere'] }, 404, 'SITE_NOT_FOUND');
    const g = await problem({ ...base, sites: 'group:mars' }, 400, 'VALIDATION_ERROR');
    expect(g['groups']).toEqual(['apollo', 'reference', 'south_pole']);
    await problem({ ...base, sites: ['custom:-89.45:222.69'] }, 400, 'VALIDATION_ERROR'); // not canonical
    for (const bad of ['a b', '../etc', 'x;rm', '--out=/tmp', 'a\nb']) await problem({ ...base, sites: [bad] }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: 'apollo11', bogus: 1 }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: 'apollo11', out: 'C:/x' }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: 'apollo11', end: '2027-01-01T00:00:00Z' }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: 'apollo11', step_min: 1.001 }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: 'apollo11', step_min: 0.5 }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: 'apollo11', provider: 'synthetic' }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: 'apollo11', radius_km: 301 }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: 'apollo11', custom_sites: [{ lat_deg: -91, lon_deg: 0 }] }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, sites: 'apollo11', start: '1850-01-01T00:00:00Z' }, 422, 'OUT_OF_RANGE');
    // lunarnav rejects near_exclusion_m > 0 with bruteforce (like the CLI): 400, never silently dropped
    const nb = await problem({ ...base, sites: 'apollo11', horizon_method: 'bruteforce', near_exclusion_m: 50 }, 400, 'VALIDATION_ERROR');
    expect(nb.errors?.[0]?.path).toBe('near_exclusion_m');
    const big =await problem({ ...base, sites: 'apollo11', step_min: 1, end: '2027-04-01T00:00:00Z' }, 422, 'JOB_TOO_LARGE');
    expect(big).toMatchObject({ n_sites: 1, n_samples: 129_600, max_samples_per_site: 100_000 });
    await problem({ ...base, sites: 'all', step_min: 1, end: '2027-01-29T00:00:00Z', provider: 'horizons' }, 422, 'JOB_TOO_LARGE');
    // 7 sites x 86 400 samples = 604 800 > 600 000
    const custom = [
      { lat_deg: 1, lon_deg: 1 },
      { lat_deg: 2, lon_deg: 2 },
    ];
    await problem({ ...base, type: 'analyse', sites: 'all', custom_sites: custom, step_min: 1, end: '2027-03-02T00:00:00Z' }, 422, 'JOB_TOO_LARGE');
  });

  it('trek needs local GeoTIFFs; near_exclusion_m needs the CLI flag (422 CAPABILITY_UNAVAILABLE, re-probed)', async () => {
    const p = await problem(okBody({ dem: 'trek' }), 422, 'CAPABILITY_UNAVAILABLE');
    expect(p).toMatchObject({ option: 'dem' });
    expect(p.detail).toMatch(/never downloads/);
    await mkdir(path.join(dataRoot, 'dem'), { recursive: true });
    await writeFile(path.join(dataRoot, 'dem', 'LRO_LOLA_DEM_SPole875_5mp_v04_EQ.tif'), 'II*\0fake');
    expect((await reprobe()).dems.trek.files).toHaveLength(1);
    const acc = await accepted(okBody({ dem: 'trek', horizon_method: 'bruteforce' }));
    const j = await waitFor(acc.job_id);
    expect(j.status).toBe('succeeded');
    expect((await fakeCall(acc.job_id, 'precompute')).argv).toEqual(expect.arrayContaining(['--dem=trek', '--horizon-method=bruteforce']));

    await writeFile(path.join(dataRoot, 'no_near_exclusion'), '');
    try {
      expect((await reprobe()).cli.near_exclusion_m).toBe(false);
      expect(await problem(okBody({ near_exclusion_m: 100 }), 422, 'CAPABILITY_UNAVAILABLE')).toMatchObject({ option: 'near_exclusion_m' });
      // 'auto' = the CLI default: accepted, never passed
      const a = await accepted(okBody({ near_exclusion_m: 'auto', observer_height_m: 3 }));
      await waitFor(a.job_id);
      expect((await fakeCall(a.job_id, 'precompute')).argv.some((x) => x.startsWith('--near-exclusion-m'))).toBe(false);
    } finally {
      await rm(path.join(dataRoot, 'no_near_exclusion'), { force: true });
      await reprobe();
    }
  });

  it('Python failures: DEM pre-flight message -> PYTHON_FAILED; broken output -> IMPORT_FAILED; cancel kills the run', async () => {
    const f = await waitFor((await accepted(okBody({ observer_height_m: 7 }))).job_id);
    expect(f).toMatchObject({ status: 'failed', output: null, artifacts: [], result: null });
    expect(f.error?.code).toBe('PYTHON_FAILED');
    expect(f.error?.message).toMatch(/fake missing DEM file|cannot serve/);

    const b = await waitFor((await accepted(okBody({ observer_height_m: 9 }))).job_id);
    expect(b.error?.code).toBe('IMPORT_FAILED');
    expect(b.error?.message).toMatch(/sites\.json/);
    expect(b.error?.message).not.toContain(ctx.dataDir);

    const h = await accepted(okBody({ observer_height_m: 8 }));
    await waitFor(h.job_id, (j) => j.status === 'running' && j.progress.lines.length > 0);
    const pid = Number(await readFile(path.join(ctx.dataDir, 'jobs', h.job_id, 'pid.txt'), 'utf8'));
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${h.job_id}` });
    expect(del.statusCode).toBe(200);
    expect(Job.parse(del.json()).status).toBe('cancelled');
    // the hanging child is killed (not left running for 120 s)
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const t0 = Date.now();
    while (alive() && Date.now() - t0 < 10_000) await sleep(100);
    expect(alive()).toBe(false);
  });

  it('analyse: ranking.json artifact + Job.output.ranking, no import; a bad ranking file -> RESULT_FAILED', async () => {
    const acc = await accepted({ type: 'analyse', sites: ['apollo11', 'a3_haworth'], start: '2027-01-01T00:00:00Z', end: '2027-01-08T00:00:00Z', provider: 'analytic', dem: 'none' });
    expect(acc).toMatchObject({ type: 'analyse', site_id: null });
    const j = await waitFor(acc.job_id);
    expect(j.error).toBeNull();
    expect(j).toMatchObject({ status: 'succeeded', result: null });
    const out = AnalyseJobOutput.parse(j.output);
    expect(out).toMatchObject({ n_sites: 2, n_samples: 168, provider: 'analytic', dem: 'none', horizon_method: 'flat' });
    expect(out.ranking.map((r) => [r.rank, r.site_id])).toEqual([
      [1, 'a3_haworth'],
      [2, 'apollo11'],
    ]);
    expect(j.artifacts.map((a) => a.name)).toEqual(['ranking.json']);
    const file = await get(j.artifacts[0]?.url ?? '');
    expect(file.statusCode).toBe(200);
    expect((file.json() as { ranking: unknown[] }).ranking).toHaveLength(2);
    const call = await fakeCall(acc.job_id, 'analyse');
    expect(call.argv[0]).toBe('analyse');
    expect(call.argv.at(-1)).toBe(`--json=${path.join(ctx.dataDir, 'jobs', acc.job_id, 'artifacts', 'ranking.json')}`);
    expect(await getDb().collection(COLLECTIONS.runs).countDocuments({ _id: `job_${acc.job_id}` as never })).toBe(0);

    // single-site analyse shows the site; a broken ranking file fails the job and publishes nothing
    const bad = await accepted({ type: 'analyse', sites: 'apollo11', start: '2027-01-01T00:00:00Z', end: '2027-01-08T00:00:00Z', observer_height_m: 9 });
    expect(bad.site_id).toBe('apollo11');
    const jb = await waitFor(bad.job_id);
    expect(jb.status).toBe('failed');
    expect(jb.error?.code).toBe('RESULT_FAILED');
    expect(jb.error?.message).toMatch(/ranking\.json is not JSON/);
    expect(jb.artifacts).toEqual([]);
  });
});
