/**
 * Job type 'alt_dates_python' (builder B1) through the real POST /jobs route with the FAKE lunarnav of
 * tests/jobs/fake_b1 (argparse CLI with the real alt-dates options) and the real bridge
 * backend/python/alt_dates_python_job.py. LUNARNAV_DATA points to a scratch dir (capabilities re-probes).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { DateConstraints } from '../../src/contract/alt_dates.ts';
import { Capabilities } from '../../src/contract/capabilities.ts';
import { Job, JobAccepted } from '../../src/contract/jobs.ts';
import { AltDatesPythonJobOutput } from '../../src/contract/job_types/alt_dates_python.ts';
import { Problem } from '../../src/lib/problem.ts';
import { altDatesSamples, constraintFlags } from '../../src/jobs/types/alt_dates_python.ts';
import { resetCapabilitiesCache } from '../../src/python/capabilities.ts';
import { BACKEND_PYTHON_DIR } from '../../src/python/scripts.ts';
import { startTestApp, type TestContext } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ROOT = path.join(here, 'fake_b1');
const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

const okBody = (over: Record<string, unknown> = {}) => ({
  type: 'alt_dates_python',
  site_id: 'apollo11',
  earliest: '2027-01-01T00:20:00Z',
  latest: '2027-01-10T23:40:00Z',
  mission_h: 48,
  ...over,
});

describe('alt_dates_python helpers (units)', () => {
  it('maps DateConstraints to the CLI flags (defaults, booleans, nullable limits)', () => {
    const d = DateConstraints.parse({});
    expect(constraintFlags(d)).toEqual([
      '--min-sun-pct=0',
      '--min-earth-pct=0',
      '--min-both-pct=0',
      '--min-continuous-sun-h=0',
      '--min-continuous-earth-h=0',
      '--objective=balanced',
      '--min-separation-h=12',
    ]);
    const c = DateConstraints.parse({
      require_sun_at_landing: false,
      require_earth_at_landing: true,
      max_dark_gap_h: 30,
      max_comms_gap_h: 0,
      min_sun_el_at_landing_deg: -1.5,
      objective: 'energy',
    });
    expect(constraintFlags(c)).toEqual(
      expect.arrayContaining(['--allow-dark-landing', '--require-earth-at-landing', '--max-dark-gap-h=30', '--max-comms-gap-h=0', '--min-sun-el=-1.5', '--objective=energy']),
    );
  });

  it('counts the samples like find_alternative_dates_for_site', () => {
    const c = DateConstraints.parse({});
    // 9 days window + 48 h mission + 1 step, hourly
    expect(altDatesSamples({ earliest: '2027-01-01T00:00:00Z', latest: '2027-01-10T00:00:00Z', mission_h: 48, constraints: c, step_min: 60 })).toBe(9 * 24 + 48 + 1);
    expect(
      altDatesSamples({ earliest: '2027-01-01T00:00:00Z', latest: '2027-01-02T00:00:00Z', mission_h: 2, constraints: { ...c, min_continuous_sun_h: 10 }, step_min: 30 }),
    ).toBe(48 + 20 + 1);
  });
});

describe.skipIf(!HAVE_PY)('alt_dates_python job (fake lunarnav B1)', () => {
  let ctx: TestContext;
  let dataRoot: string;
  const prevData = process.env['LUNARNAV_DATA'];

  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-b1alt-data-'));
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
  const fakeCall = async (jobId: string) =>
    JSON.parse(await readFile(path.join(ctx.dataDir, 'jobs', jobId, 'fake_call_alt-dates.json'), 'utf8')) as {
      argv: string[];
      env: Record<string, string | null>;
      script: string;
    };
  async function reprobe(): Promise<Capabilities> {
    resetCapabilitiesCache();
    return Capabilities.parse((await get('/api/v1/capabilities')).json());
  }

  it('catalog site: snapped window, exact argv through the bridge, Job.output + alt_dates.json, cache hit', async () => {
    const acc = await accepted(
      okBody({
        name: 'alt test',
        step_min: 30,
        provider: 'analytic',
        dem: 'pgda',
        horizon_method: 'raymarch',
        near_exclusion_m: 0,
        max_results: 5,
        constraints: { min_sun_pct: 50, require_earth_at_landing: true, max_dark_gap_h: 24, objective: 'sun' },
      }),
    );
    expect(acc).toMatchObject({ type: 'alt_dates_python', site_id: 'apollo11', cached: false });
    const j = await waitFor(acc.job_id);
    expect(j.error).toBeNull();
    expect(j).toMatchObject({ status: 'succeeded', result: null });
    expect(j.params).toMatchObject({
      type: 'alt_dates_python',
      site_id: 'apollo11',
      lat_deg: null,
      lon_deg: null,
      earliest: '2027-01-01T00:30:00Z',
      latest: '2027-01-10T23:30:00Z',
      mission_h: 48,
      max_results: 5,
      step_min: 30,
      near_exclusion_m: 0,
    });
    const out = AltDatesPythonJobOutput.parse(j.output);
    expect(out).toMatchObject({ site_id: 'apollo11', n_evaluated: 25, n_feasible: 4, step_min: 30, provider: 'analytic', dem: 'pgda', horizon_method: 'raymarch' });
    expect(out.candidates).toHaveLength(1);
    expect(out.constraints).toMatchObject({ min_sun_pct: 50, require_earth_at_landing: true, max_dark_gap_h: 24, objective: 'sun' });
    expect(j.artifacts.map((a) => a.name)).toEqual(['alt_dates.json']);
    const file = await get(j.artifacts[0]?.url ?? '');
    expect(file.statusCode).toBe(200);
    expect((file.json() as { site_id: string }).site_id).toBe('apollo11');

    const call = await fakeCall(acc.job_id);
    expect(path.resolve(call.script)).toBe(path.join(BACKEND_PYTHON_DIR, 'alt_dates_python_job.py'));
    expect(call.argv).toEqual([
      'alt-dates',
      '--sites=apollo11',
      '--earliest=2027-01-01T00:30:00Z',
      '--latest=2027-01-10T23:30:00Z',
      '--mission-h=48',
      '--step-min=30',
      '--provider=analytic',
      '--dem=pgda',
      '--horizon-method=raymarch',
      '--radius-km=150',
      '--az-step=0.5',
      '--observer-height=2',
      '--min-clearance=0',
      '--dem-fallback=flat',
      '--near-exclusion-m=0',
      '--min-sun-pct=50',
      '--min-earth-pct=0',
      '--min-both-pct=0',
      '--min-continuous-sun-h=0',
      '--min-continuous-earth-h=0',
      '--objective=sun',
      '--min-separation-h=12',
      '--require-earth-at-landing',
      '--max-dark-gap-h=24',
      '--max-results=5',
      `--json=${path.join(ctx.dataDir, 'jobs', acc.job_id, 'artifacts', 'alt_dates.json')}`,
    ]);
    expect(call.env['MONGODB_URI']).toBeNull();
    expect(call.env['PYTHONPATH']?.split(path.delimiter)).toContain(FAKE_ROOT);

    // same request with the snapped instants and explicit defaults -> cache hit
    const again = await post(
      okBody({
        name: 'other name',
        earliest: '2027-01-01T00:30:00Z',
        latest: '2027-01-10T23:30:00Z',
        step_min: 30,
        provider: 'analytic',
        near_exclusion_m: 0,
        max_results: 5,
        dem_fallback: 'flat',
        constraints: { min_sun_pct: 50, require_earth_at_landing: true, max_dark_gap_h: 24, objective: 'sun', min_separation_h: 12 },
      }),
    );
    expect(again.statusCode, again.body).toBe(200);
    expect(JobAccepted.parse(again.json())).toMatchObject({ job_id: acc.job_id, cached: true });
  });

  it('lat/lon (west-negative) -> canonical custom site; dem none -> flat; no feasible date is a successful empty result', async () => {
    const acc = await accepted({
      type: 'alt_dates_python',
      lat_deg: -89.45,
      lon_deg: -137.31,
      earliest: '2027-01-01T00:00:00Z',
      latest: '2027-01-03T00:00:00Z',
      mission_h: 24,
      dem: 'none',
      constraints: { min_sun_pct: 99 },
    });
    expect(acc.site_id).toBe('custom:-89.4500:222.6900');
    const j = await waitFor(acc.job_id);
    expect(j.error).toBeNull();
    expect(j.status).toBe('succeeded');
    expect(j.params).toMatchObject({ site_id: 'custom:-89.4500:222.6900', lat_deg: -89.45, lon_deg: 222.69, horizon_method: 'flat', near_exclusion_m: null });
    const out = AltDatesPythonJobOutput.parse(j.output);
    expect(out).toMatchObject({ n_feasible: 0, candidates: [], rejected_by: { min_sun_pct: 25 }, horizon_method: 'flat', dem: 'none' });
    expect(j.progress.lines.some((l) => l.includes('no feasible landing time'))).toBe(true);
    expect((await fakeCall(acc.job_id)).argv).toContain('--sites=custom:-89.4500:222.6900');
  });

  it('Python failures: DEM pre-flight -> PYTHON_FAILED; result for another site -> RESULT_FAILED (nothing published)', async () => {
    const f = await waitFor((await accepted(okBody({ observer_height_m: 7 }))).job_id);
    expect(f).toMatchObject({ status: 'failed', output: null, artifacts: [] });
    expect(f.error?.code).toBe('PYTHON_FAILED');
    expect(f.error?.message).toMatch(/fake missing DEM file|cannot serve/);

    const b = await waitFor((await accepted(okBody({ site_id: 'a3_haworth', observer_height_m: 9 }))).job_id);
    expect(b.status).toBe('failed');
    expect(b.error?.code).toBe('RESULT_FAILED');
    expect(b.error?.message).toMatch(/alt_dates\.json is for site apollo11, not a3_haworth/);
    expect(b.artifacts).toEqual([]);
  });

  it('rejects bad / unsafe / oversized requests before queueing (400 / 404 / 422)', async () => {
    const base = okBody();
    await problem({ ...base, site_id: undefined }, 400, 'VALIDATION_ERROR'); // no site
    await problem({ ...base, lat_deg: -89, lon_deg: 10 }, 400, 'VALIDATION_ERROR'); // site_id AND lat/lon
    await problem({ ...base, site_id: undefined, lat_deg: -89 }, 400, 'VALIDATION_ERROR'); // lat without lon
    await problem({ ...base, site_id: 'nowhere' }, 404, 'SITE_NOT_FOUND');
    await problem({ ...base, site_id: 'custom:-89.45:222.69' }, 400, 'VALIDATION_ERROR'); // not canonical
    for (const bad of ['a b', '../x', '--json=C:/x', 'a\nb']) await problem({ ...base, site_id: bad }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, json: 'C:/x' }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, constraints: { bogus: 1 } }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, latest: '2026-12-01T00:00:00Z' }, 400, 'VALIDATION_ERROR');
    await problem({ ...base, earliest: '2027-01-01T00:10:00Z', latest: '2027-01-01T00:50:00Z' }, 400, 'VALIDATION_ERROR'); // no grid instant
    await problem({ ...base, max_results: 51 }, 400, 'VALIDATION_ERROR');
    const w = await problem({ ...base, latest: '2028-01-03T00:00:00Z' }, 422, 'OUT_OF_RANGE');
    expect(w).toMatchObject({ max_window_days: 366 });
    await problem({ ...base, earliest: '1890-01-01T00:00:00Z', latest: '1890-01-02T00:00:00Z' }, 422, 'OUT_OF_RANGE');
    await problem({ ...base, mission_h: 1.5 }, 422, 'BAD_MISSION_LENGTH');
    const big = await problem({ ...base, step_min: 1, latest: '2027-06-01T00:00:00Z' }, 422, 'JOB_TOO_LARGE');
    expect(big).toMatchObject({ max_samples: 200_000 });
    const t = await problem({ ...base, dem: 'trek' }, 422, 'CAPABILITY_UNAVAILABLE');
    expect(t).toMatchObject({ option: 'dem' });

    await writeFile(path.join(dataRoot, 'no_near_exclusion'), '');
    try {
      expect((await reprobe()).cli.near_exclusion_m).toBe(false);
      expect(await problem({ ...base, near_exclusion_m: 100 }, 422, 'CAPABILITY_UNAVAILABLE')).toMatchObject({ option: 'near_exclusion_m' });
    } finally {
      await rm(path.join(dataRoot, 'no_near_exclusion'), { force: true });
      await reprobe();
    }
  });
});
