/**
 * SLOW end-to-end tests of the B3 report job types with the REAL lunarnav (default LUNARNAV_ROOT):
 *   - check on an imported run (run_small fixture, then the same files with one byte changed),
 *   - validate quick + no_horizons + no_terrain (SPICE vs analytic: no network),
 *   - compare_runs between the run_small fixture (synthetic ephemeris) and a real 2-day custom_site job
 *     (SPICE, dem none, flat) of their common site custom:-89.4500:222.6900.
 * Opt-in: RUN_SLOW=1 npx vitest run tests/jobs/validate_reports.slow.test.ts  (~1-3 min on the dev machine).
 */
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { CheckJobOutput } from '../../src/contract/job_types/check.ts';
import { CompareRunsJobOutput } from '../../src/contract/job_types/compare_runs.ts';
import { ValidateJobOutput } from '../../src/contract/job_types/validate.ts';
import { startTestApp, type TestContext } from '../helpers.ts';
import { expectNoPaths, importScratchRun, jobsClient } from './fake_b3/harness.ts';

const SLOW = process.env['RUN_SLOW'] === '1';
const cfg0 = loadConfig({});
const HAVE_PY = existsSync(cfg0.PYTHON_BIN);
const SITE = 'custom:-89.4500:222.6900';

describe.skipIf(!SLOW || !HAVE_PY)('slow e2e: report job types (real lunarnav)', () => {
  let ctx: TestContext;
  const c = jobsClient(() => ctx);
  const runs: { dir: string; cleanup: () => Promise<void> }[] = [];

  beforeAll(async () => {
    ctx = await startTestApp({ config: { JOB_TIMEOUT_S: 3600, RATE_LIMIT_POST_MAX: 1000, JOB_MAX_ACTIVE_PER_CLIENT: 10 } });
    runs.push(await importScratchRun('e2e_small'), await importScratchRun('e2e_tampered'));
  });
  afterAll(async () => {
    await ctx?.close();
    for (const r of runs) await r.cleanup();
  });

  it('check: a real run passes; a tampered file is reported (job still succeeded)', { timeout: 300_000 }, async () => {
    const ok = await c.run({ type: 'check', run_id: 'e2e_small' }, 280_000);
    expect(ok.error).toBeNull();
    expect(CheckJobOutput.parse(ok.output)).toMatchObject({ run_id: 'e2e_small', ok: true, n_violations: 0, n_files: 14 });

    await appendFile(path.join(runs[1]!.dir, 'sites', 'apollo11', 'horizon_flat.csv'), '\n');
    const bad = await c.run({ type: 'check', run_id: 'e2e_tampered' }, 280_000);
    expect(bad.status, JSON.stringify(bad.error)).toBe('succeeded');
    const out = CheckJobOutput.parse(bad.output);
    console.info(`[e2e check] tampered: ${out.violations.join(' | ')}`);
    expect(out.ok).toBe(false);
    expect(out.violations.some((v) => v.includes('horizon_flat.csv'))).toBe(true);
    expectNoPaths(JSON.stringify(bad) + (await c.artifact(bad, 'violations.json')).body, [runs[1]!.dir]);
  });

  it('validate quick + no_horizons + no_terrain: report artifacts + summary', { timeout: 1_800_000 }, async () => {
    const t0 = Date.now();
    const j = await c.run({ type: 'validate', mode: 'quick', no_horizons: true, no_terrain: true }, 1_780_000);
    console.info(`[e2e validate] ${j.status} in ${Date.now() - t0} ms: ${JSON.stringify(j.output ?? j.error)}`);
    expect(j.error).toBeNull();
    const out = ValidateJobOutput.parse(j.output);
    expect(out).toMatchObject({ mode: 'quick', providers: ['spice', 'analytic'], n_sites: 2, n_time_sets: 1, terrain: null });
    expect(out.n_pairs).toBeGreaterThan(0);
    expect(out.passed).toBe(true);
    expect(j.artifacts.map((a) => a.name)).toEqual(['validation_report.json', 'validation_report.md']);
    const rep = await c.artifact(j, 'validation_report.json');
    expect(JSON.parse(rep.body)).toMatchObject({ passed: true, ephemeris: { providers: ['spice', 'analytic'] } });
    expect((await c.artifact(j, 'validation_report.md')).body).toMatch(/overall: \*\*PASS\*\*/);
    expectNoPaths(rep.body, [path.resolve(cfg0.LUNARNAV_ROOT), ctx.dataDir]);
  });

  it('compare_runs: fixture (synthetic) vs a real custom_site run (spice), common site + overlapping range', { timeout: 900_000 }, async () => {
    const job = await c.run({ type: 'custom_site', lat_deg: -89.45, lon_deg: -137.31, start: '2027-01-01T00:00:00Z', end: '2027-01-03T00:00:00Z', dem: 'none', horizon_method: 'flat' }, 880_000);
    expect(job.error).toBeNull();
    const runB = job.result?.run_id ?? '';
    const j = await c.run({ type: 'compare_runs', run_a: 'e2e_small', run_b: runB }, 300_000);
    console.info(`[e2e compare_runs] ${JSON.stringify(j.output ?? j.error)}`);
    expect(j.error).toBeNull();
    const out = CompareRunsJobOutput.parse(j.output);
    expect(out).toMatchObject({ run_a: 'e2e_small', run_b: runB, n_sites_compared: 1, n_sites_failed: 0, n_only_in_a: 2, n_only_in_b: 0, same_range: false });
    expect(out.only_in_a.sort()).toEqual(['apollo11', 'ref_shackleton_rim']);
    expect(out.ephem_sun_max_arcsec.worst_site).toBe(SITE);
    // synthetic vs SPICE ephemeris differ measurably; flat horizons on the same sphere are identical
    expect(out.ephem_sun_max_arcsec.max ?? 0).toBeGreaterThan(0);
    expect(out.horizon_max_abs_deg.max).toBeLessThan(0.01);
    const full = JSON.parse((await c.artifact(j, 'compare_runs.json')).body) as { sites: { site_id: string; n_common: number }[] };
    expect(full.sites[0]).toMatchObject({ site_id: SITE, n_common: 48 });
  });
});
