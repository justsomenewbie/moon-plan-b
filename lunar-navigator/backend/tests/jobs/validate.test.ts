/**
 * Job types 'validate' and 'validate_terrain' (builder B3) through the real POST /jobs route and the real
 * bridges (backend/python/validate_json.py, validate_terrain_json.py) with a FAKE lunarnav.validate /
 * lunarnav.validate_terrain (tests/jobs/fake_b3; behaviour chosen by quick / offline / terrain).
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { Capabilities } from '../../src/contract/capabilities.ts';
import { ValidateJobOutput } from '../../src/contract/job_types/validate.ts';
import { ValidateTerrainJobOutput } from '../../src/contract/job_types/validate_terrain.ts';
import { validateJob } from '../../src/jobs/types/validate.ts';
import { validateTerrainJob } from '../../src/jobs/types/validate_terrain.ts';
import { startTestApp, type TestContext } from '../helpers.ts';
import { FAKE_B3_ROOT, expectNoPaths, jobsClient } from './fake_b3/harness.ts';

const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);

describe.skipIf(!HAVE_PY)('validate + validate_terrain jobs (fake lunarnav B3)', () => {
  let ctx: TestContext;
  const c = jobsClient(() => ctx);

  beforeAll(async () => {
    ctx = await startTestApp({
      config: { LUNARNAV_ROOT: FAKE_B3_ROOT, JOB_CONCURRENCY: 1, JOB_QUEUE_MAX: 20, JOB_TIMEOUT_S: 60, RATE_LIMIT_POST_MAX: 1000, JOB_MAX_ACTIVE_PER_CLIENT: 50 },
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('lists both types as implemented + available in GET /capabilities', async () => {
    const caps = Capabilities.parse((await c.get('/api/v1/capabilities')).json());
    for (const t of ['validate', 'validate_terrain']) {
      expect(caps.job_types.find((x) => x.type === t), t).toMatchObject({ implemented: true, available: true, reason: null });
    }
  });

  it('validate quick: passed report (json + md + terrain report), summary output, strict JSON without server paths, cache hit', async () => {
    const body = { type: 'validate', mode: 'quick', no_horizons: true };
    const j = await c.run(body);
    expect(j.error).toBeNull();
    expect(j).toMatchObject({ status: 'succeeded', type: 'validate', site_id: null, result: null });
    const out = ValidateJobOutput.parse(j.output);
    expect(out).toMatchObject({
      passed: true,
      mode: 'quick',
      offline: false,
      providers: ['spice', 'analytic'],
      n_sites: 2,
      n_time_sets: 1,
      n_pairs: 2,
      failed_pairs: [],
      sections: { apollo11: true, lunar_day: true, negative_controls: true, crosscheck_matrix: true },
      terrain: { status: 'ran', passed: null },
      n_checks_failed: 0,
      generated_utc: '2026-11-14T00:00:00Z',
      lunarnav_version: '0.0.0-fake-b3',
    });
    expect(j.artifacts.map((a) => a.name)).toEqual(['validate_terrain_report.json', 'validation_report.json', 'validation_report.md']);
    const rep = await c.artifact(j, 'validation_report.json');
    const parsed = JSON.parse(rep.body) as { ephemeris: { kernel_dir: string }; terrain: Record<string, unknown> };
    expect(parsed.ephemeris.kernel_dir.replaceAll('\\', '/')).toBe('<LUNARNAV_ROOT>/data/kernels');
    expect(parsed.terrain).toMatchObject({ status: 'ran', report_path: 'validate_terrain_report.json', nan_value: null });
    const md = await c.artifact(j, 'validation_report.md');
    expect(md.contentType).toMatch(/text\/markdown/);
    expect(md.body).toMatch(/overall: \*\*PASS\*\*/);
    const terr = await c.artifact(j, 'validate_terrain_report.json');
    expect(JSON.parse(terr.body)).toEqual({ generated_by: 'fake', quick: true, x: null });
    expectNoPaths(rep.body + md.body + terr.body + JSON.stringify(j), [FAKE_B3_ROOT, ctx.dataDir]);
    expect(j.progress.lines).toContain('validate: overall PASS');

    // offline is irrelevant without Horizons: same params_hash -> cache hit (200)
    const hit = await c.post({ ...body, offline: true });
    expect(hit.statusCode, hit.body).toBe(200);
    expect(hit.json()).toMatchObject({ job_id: j.job_id });
  });

  it('validate full + no_terrain: a FAILED validation is a succeeded job (passed false, failed pair listed)', async () => {
    const j = await c.run({ type: 'validate', mode: 'full', no_horizons: true, no_terrain: true });
    expect(j.status, JSON.stringify(j.error)).toBe('succeeded');
    const out = ValidateJobOutput.parse(j.output);
    expect(out).toMatchObject({ passed: false, mode: 'full', terrain: null, failed_pairs: ['spice-analytic/earth'], sections: { crosscheck_matrix: false } });
    expect(out.n_checks_failed).toBeGreaterThan(0);
    expect(j.artifacts.map((a) => a.name)).toEqual(['validation_report.json', 'validation_report.md']);
    expect((await c.artifact(j, 'validation_report.md')).body).toMatch(/overall: \*\*FAIL\*\*/);
  });

  it('validate that cannot run fails the job with the exception text (PYTHON_FAILED)', async () => {
    const j = await c.run({ type: 'validate', offline: true, no_terrain: true });
    expect(j).toMatchObject({ status: 'failed', output: null, artifacts: [] });
    expect(j.error?.code).toBe('PYTHON_FAILED');
    expect(j.error?.message).toMatch(/not in the offline cache/);
  });

  it('validate rejects unknown keys and modes (400)', async () => {
    await c.problem({ type: 'validate', mode: 'huge' }, 400, 'VALIDATION_ERROR');
    await c.problem({ type: 'validate', out: 'C:/x' }, 400, 'VALIDATION_ERROR');
  });

  it('canonical validate params: offline dropped with no_horizons; Horizons unreachable -> CAPABILITY_UNAVAILABLE', async () => {
    const real = Capabilities.parse((await c.get('/api/v1/capabilities')).json());
    const sub = (caps: Capabilities) => ({ capabilities: () => Promise.resolve(caps), catalogIds: () => Promise.resolve(null) }) as never;
    const base = { type: 'validate' as const, mode: 'quick' as const, offline: true, no_horizons: true, no_terrain: false };
    expect(await validateJob.canonicalize(base, sub(real))).toEqual({ type: 'validate', mode: 'quick', offline: false, no_horizons: true, no_terrain: false });
    const offNet = { ...real, network: { ...real.network, horizons: { reachable: false, latency_ms: null, error: 'timeout' } } };
    await expect(validateJob.canonicalize({ ...base, no_horizons: false, offline: false }, sub(offNet))).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(await validateJob.canonicalize({ ...base, no_horizons: false, offline: true }, sub(offNet))).toMatchObject({ offline: true, no_horizons: false });
    const noSpice = { ...real, providers: { ...real.providers, spice: { available: false, reason: 'no kernels' } } };
    await expect(validateJob.canonicalize(base, sub(noSpice))).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(validateJob.progress?.('diagnostics against spice', { stage: 'python', pct: 12 })).toEqual({ stage: 'python', pct: 50 });
    expect(validateJob.progress?.('cross-check: x', { stage: 'python', pct: 50 })).toEqual({ stage: 'python', pct: 50 });
  });

  it('validate_terrain quick: strict-JSON report (NaN -> null, inf -> "inf"), summary of the pass flags, no server paths', async () => {
    const j = await c.run({ type: 'validate_terrain' });
    expect(j.error).toBeNull();
    expect(j).toMatchObject({ status: 'succeeded', type: 'validate_terrain', site_id: null });
    const out = ValidateTerrainJobOutput.parse(j.output);
    expect(out).toEqual({
      mode: 'quick',
      all_checks_passed: false,
      runtime_s: 1.5,
      sections: ['generated_by', 'illumination', 'method_comparison', 'quick', 'runtime_s', 'step_check', 'trek_header'],
      n_checks: 3,
      n_checks_failed: 1,
      failed_checks: ['illumination.lit'],
      trek_header: { LRO_LOLA_DEM_SPole75_30mp_v04: true },
      method_comparison: [{ site_id: 'ref_connecting_ridge_c1', p95_abs_deg: 0.01, max_abs_deg: null }],
      illumination: { n_psr: 8, n_lit: 8, primary: 'LDEM' },
    });
    expect(j.artifacts.map((a) => a.name)).toEqual(['validate_terrain_report.json']);
    const rep = await c.artifact(j, 'validate_terrain_report.json');
    const parsed = JSON.parse(rep.body) as { step_check: { avg_illum_pct_1h: unknown; cache: string }; report_path?: unknown };
    expect(parsed.step_check.avg_illum_pct_1h).toBe('inf');
    expect(parsed.step_check.cache.replaceAll('\\', '/')).toBe('<LUNARNAV_ROOT>/data/cache');
    expect(parsed.report_path).toBeUndefined();
    expectNoPaths(rep.body + JSON.stringify(j), [FAKE_B3_ROOT, ctx.dataDir]);
  });

  it('validate_terrain failure -> PYTHON_FAILED with the exception text; bad mode -> 400', async () => {
    const j = await c.run({ type: 'validate_terrain', mode: 'full' });
    expect(j).toMatchObject({ status: 'failed', artifacts: [] });
    expect(j.error).toMatchObject({ code: 'PYTHON_FAILED' });
    expect(j.error?.message).toMatch(/full mode unavailable/);
    await c.problem({ type: 'validate_terrain', mode: 'fast' }, 400, 'VALIDATION_ERROR');
    expect(validateTerrainJob.canonicalize({ type: 'validate_terrain', mode: 'full' }, {} as never)).toEqual({ type: 'validate_terrain', mode: 'full' });
  });
});
