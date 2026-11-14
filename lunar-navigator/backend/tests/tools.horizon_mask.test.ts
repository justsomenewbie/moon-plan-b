/**
 * Job type 'horizon_mask' (async POST /tools/horizon) through the real POST /jobs route, the real bridge
 * (backend/python/tools_horizon_mask.py -> horizon_json.compute) and the FAKE lunarnav of the tools tests
 * (tests/jobs/fake_b4: values / failures chosen by the site latitude). Real numbers: tests/tools.slow.test.ts.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { Capabilities } from '../src/contract/capabilities.ts';
import { HorizonMaskJobOutput } from '../src/contract/job_types/horizon_mask.ts';
import { Job, JobAccepted } from '../src/contract/jobs.ts';
import { HorizonToolResponse } from '../src/contract/tools.ts';
import { getDb } from '../src/db.ts';
import { importRun } from '../src/importer/importRun.ts';
import { Problem } from '../src/lib/problem.ts';
import { startTestApp, type TestContext } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ROOT = path.join(here, 'jobs', 'fake_b4');
const FIXTURE = path.resolve(here, 'importer', 'fixtures', 'run_small');
const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);
const RUN_ID = 'run_small';
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

let ctx: TestContext;
const post = (b: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/api/v1/jobs', payload: { type: 'horizon_mask', ...b } });

async function run(b: Record<string, unknown>): Promise<Job> {
  const res = await post(b);
  expect(res.statusCode, res.body).toBe(202);
  const id = JobAccepted.parse(res.json()).job_id;
  const t0 = Date.now();
  for (;;) {
    const j = Job.parse((await ctx.app.inject({ method: 'GET', url: `/api/v1/jobs/${id}` })).json());
    if (TERMINAL.includes(j.status)) return j;
    if (Date.now() - t0 > 30_000) throw new Error(`job ${id} still ${j.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function problem(b: Record<string, unknown>, status: number, code: string): Promise<Problem> {
  const res = await post(b);
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toContain('application/problem+json');
  const p = Problem.parse(res.json());
  expect(p.code).toBe(code);
  return p;
}

async function mask(j: Job): Promise<HorizonToolResponse> {
  expect(j.artifacts.map((a) => a.name)).toEqual(['horizon.json']);
  const res = await ctx.app.inject({ method: 'GET', url: j.artifacts[0]!.url });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('application/json');
  return HorizonToolResponse.parse(res.json());
}

describe.skipIf(!HAVE_PY)('job horizon_mask (fake lunarnav)', () => {
  beforeAll(async () => {
    ctx = await startTestApp({
      config: { LUNARNAV_ROOT: FAKE_ROOT, JOB_CONCURRENCY: 1, JOB_QUEUE_MAX: 20, JOB_TIMEOUT_S: 60, RATE_LIMIT_POST_MAX: 1000, JOB_MAX_ACTIVE_PER_CLIENT: 50 },
    });
    await importRun(getDb(), { dir: FIXTURE, runId: RUN_ID, check: false, dataDir: null, catalogPath: null, setDefault: true });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('is implemented + available in GET /capabilities', async () => {
    const caps = Capabilities.parse((await ctx.app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json());
    expect(caps.job_types.find((x) => x.type === 'horizon_mask')).toMatchObject({ implemented: true, available: true, reason: null, timeout_s: 1800 });
  });

  it('beyond the sync limits (150 km, 0.25 deg, bruteforce): artifact horizon.json = tool document, summary output, cache hit', async () => {
    const body = { lat_deg: -85.5, lon_deg: -170, radius_km: 150, az_step_deg: 0.25, method: 'bruteforce', observer_height_m: 3 };
    const j = await run(body);
    expect(j.error, JSON.stringify(j.error)).toBeNull();
    expect(j).toMatchObject({ status: 'succeeded', type: 'horizon_mask', site_id: null, result: null });
    const m = await mask(j);
    expect(m.site).toEqual({ site_id: null, name: null, lat_deg: -85.5, lon_deg: 190, custom_site_id: 'custom:-85.5000:190.0000', source: 'coordinates', run_id: null });
    expect(m).toMatchObject({ method: 'bruteforce', dem_source: 'fake:pgda:bruteforce:r150:neauto:obs3', radius_km: 150, az_step_deg: 0.25, n_az: 1440, observer_height_m: 3, surface_height_m: 914.5, dem_fallback: null, rounding: 'run_files' });
    expect(m.el_deg[360]).toBe(r6(0.1 + 1 / 7));
    expect(m.covered_radius_km.every((x) => x === 150)).toBe(true);
    const out = HorizonMaskJobOutput.parse(j.output);
    expect(out).toMatchObject({ n_az: 1440, method: 'bruteforce', min_el_deg: m.min_el_deg, max_el_deg: m.max_el_deg, artifact: 'horizon.json', site: m.site });
    expect(j.progress.lines.some((l) => l.startsWith('horizon_mask: computing dem=pgda method=bruteforce'))).toBe(true);
    const text = JSON.stringify(m) + JSON.stringify(j);
    for (const p of [FAKE_ROOT, ctx.dataDir]) for (const v of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) expect(text.includes(v), `leaks ${v}`).toBe(false);

    // identical request (west longitude written east) -> same params_hash -> 200 cached
    const hit = await post({ ...body, lon_deg: 190 });
    expect(hit.statusCode, hit.body).toBe(200);
    expect(hit.json()).toMatchObject({ job_id: j.job_id, cached: true });
  });

  it('site of the default run (site_id shown), dem none -> flat, near_exclusion auto == omitted', async () => {
    const j = await run({ site_id: 'ref_shackleton_rim', dem: 'none', az_step_deg: 10, near_exclusion_m: 250 });
    expect(j.status, JSON.stringify(j.error)).toBe('succeeded');
    expect(j.site_id).toBe('ref_shackleton_rim');
    const m = await mask(j);
    expect(m).toMatchObject({ method: 'flat', dem_source: 'none', n_az: 36, near_exclusion_m: null, horizon_distance_km: null });
    expect(m.site).toMatchObject({ site_id: 'ref_shackleton_rim', source: 'run', run_id: RUN_ID });
    expect(j.params).toMatchObject({ method: 'flat', near_exclusion_m: null, site_source: 'run' });

    const a = await run({ site_id: 'fake_polar', az_step_deg: 10, near_exclusion_m: 'auto' });
    const b = await post({ site_id: 'fake_polar', az_step_deg: 10 });
    expect(b.statusCode, b.body).toBe(200); // same canonical params
    expect(b.json()).toMatchObject({ job_id: a.job_id });
    expect((await mask(a)).site).toMatchObject({ source: 'catalog', name: 'Fake polar site' });
  });

  it('Python failures -> failed job with a one-line sanitized reason', async () => {
    const pe = await run({ lat_deg: -11, lon_deg: 0, az_step_deg: 10 });
    expect(pe.status).toBe('failed');
    expect(pe.error?.code).toBe('PYTHON_FAILED');
    expect(pe.error?.message).toContain('network down');
    expect(pe.error?.message).not.toContain(FAKE_ROOT);
    expect(pe.error?.message).toMatch(/<LUNARNAV_(DATA|ROOT)>[\\/]cache[\\/]x\.bin/);
    const cov = await run({ site_id: 'apollo11', dem_fallback: 'error', az_step_deg: 10 });
    expect(cov.error).toMatchObject({ code: 'PYTHON_FAILED' });
    expect(cov.error?.message).toContain('dem_coverage: site apollo11: outside the fake PGDA coverage');
    const tb = await run({ lat_deg: -14, lon_deg: 0, az_step_deg: 10 });
    expect(tb.error?.code).toBe('PYTHON_FAILED');
    expect(tb.error?.message).toContain('ZeroDivisionError');
    expect(tb.artifacts).toEqual([]);
    // the fake has no catalog file: an unknown id is only caught by lunarnav.sites.get_site (real catalog: 404 at POST)
    const nf = await run({ site_id: 'nope_not_here', az_step_deg: 10 });
    expect(nf.error).toMatchObject({ code: 'PYTHON_FAILED', message: "site_not_found: unknown site id 'nope_not_here'" });
  });

  it('400 / 404 / 422 at POST', async () => {
    await problem({ lat_deg: -85, lon_deg: 0, radius_km: 301 }, 400, 'VALIDATION_ERROR');
    await problem({ lat_deg: -85, lon_deg: 0, az_step_deg: 0.01 }, 400, 'VALIDATION_ERROR');
    await problem({ lat_deg: -85, lon_deg: 0, az_step_deg: 0.7 }, 400, 'VALIDATION_ERROR');
    await problem({ lat_deg: -85 }, 400, 'VALIDATION_ERROR');
    await problem({ site_id: 'fake_polar', lat_deg: -85, lon_deg: 0 }, 400, 'VALIDATION_ERROR');
    await problem({ lat_deg: -85, lon_deg: 0, out_path: 'C:/x' }, 400, 'VALIDATION_ERROR');
    await problem({ site_id: 'fake_polar', run_id: RUN_ID }, 404, 'SITE_NOT_FOUND');
    const trek = await problem({ lat_deg: -85, lon_deg: 0, dem: 'trek' }, 422, 'CAPABILITY_UNAVAILABLE');
    expect(trek.detail).toContain('never downloads');
  });
});
