/**
 * Job type 'compare_runs' (builder B3) through the real POST /jobs route and the REAL bridge
 * (backend/python/compare_runs.py: numpy only, no lunarnav) on two scratch copies of the run_small fixture,
 * run B perturbed by known amounts (Sun elevation of one ephemeris sample, horizon mask, a visibility flag,
 * summary.csv metrics) so every difference the bridge reports can be checked exactly.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { COMPARE_RUNS_LIMITS, CompareRunsJobOutput } from '../../src/contract/job_types/compare_runs.ts';
import { startTestApp, type TestContext } from '../helpers.ts';
import { RUN_SMALL_SITES, expectNoPaths, importScratchRun, jobsClient, reimport } from './fake_b3/harness.ts';

const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);
const SITE = 'apollo11';

/** Edit one CSV (optionally gzipped): fn(header, rows) mutates the rows in place. */
async function editCsv(file: string, fn: (head: string[], rows: string[][]) => void): Promise<void> {
  const gz = file.endsWith('.gz');
  const raw = await readFile(file);
  const text = (gz ? gunzipSync(raw) : raw).toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol).filter((l) => l.length > 0);
  const head = lines[0]!.split(',');
  const rows = lines.slice(1).map((l) => l.split(','));
  fn(head, rows);
  const out = [head.join(','), ...rows.map((r) => r.join(','))].join(eol) + eol;
  await writeFile(file, gz ? gzipSync(Buffer.from(out, 'utf8')) : out);
}
const col = (head: string[], name: string): number => {
  const i = head.indexOf(name);
  if (i < 0) throw new Error(`no column ${name} in ${head.join(',')}`);
  return i;
};

describe.skipIf(!HAVE_PY)('compare_runs job (real bridge, perturbed run_small copies)', () => {
  let ctx: TestContext;
  const c = jobsClient(() => ctx);
  const runs: { dir: string; cleanup: () => Promise<void> }[] = [];
  let dirA = '';
  let dirB = '';

  beforeAll(async () => {
    ctx = await startTestApp({ config: { JOB_CONCURRENCY: 1, JOB_QUEUE_MAX: 20, JOB_TIMEOUT_S: 60, RATE_LIMIT_POST_MAX: 1000, JOB_MAX_ACTIVE_PER_CLIENT: 50 } });
    const a = await importScratchRun('cmp_a');
    const b = await importScratchRun('cmp_b');
    runs.push(a, b);
    dirA = a.dir;
    dirB = b.dir;
    const siteDir = path.join(dirB, 'sites', SITE);
    // ephemeris: Sun elevation of sample 10 + 0.001 deg (= 3.6 arcsec; |d el| dominates)
    await editCsv(path.join(siteDir, 'ephemeris_synthetic.csv.gz'), (h, rows) => {
      const i = col(h, 'sun_el_deg');
      rows[10]![i] = String(Number(rows[10]![i]) + 0.001);
    });
    // horizon: + 0.5 deg everywhere
    await editCsv(path.join(siteDir, 'horizon_flat.csv'), (h, rows) => {
      const i = col(h, 'el_deg');
      for (const r of rows) r[i] = String(Number(r[i]) + 0.5);
    });
    // visibility: flip sun_visible of 3 of the 336 samples (0.893 %)
    await editCsv(path.join(siteDir, 'visibility.csv.gz'), (h, rows) => {
      const i = col(h, 'sun_visible');
      for (const k of [0, 1, 2]) rows[k]![i] = rows[k]![i] === '1' ? '0' : '1';
    });
    // summary.csv: pct_sun - 5 and rank 1 -> 2 for apollo11
    await editCsv(path.join(dirB, 'summary.csv'), (h, rows) => {
      const r = rows.find((x) => x[col(h, 'site_id')] === SITE)!;
      r[col(h, 'pct_sun')] = String(Number(r[col(h, 'pct_sun')]) - 5);
      r[col(h, 'rank')] = '2';
    });
  });
  afterAll(async () => {
    await ctx?.close();
    for (const r of runs) await r.cleanup();
  });

  it('compares every common site: exact differences, json + csv artifacts, no server paths, cache hit', async () => {
    const j = await c.run({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'cmp_b' });
    expect(j.error).toBeNull();
    expect(j).toMatchObject({ status: 'succeeded', type: 'compare_runs', site_id: null, result: null });
    const out = CompareRunsJobOutput.parse(j.output);
    expect(out).toMatchObject({
      run_a: 'cmp_a',
      run_b: 'cmp_b',
      n_sites_compared: 3,
      n_sites_failed: 0,
      n_sites_no_common_samples: 0,
      only_in_a: [],
      only_in_b: [],
      same_range: true,
      n_rank_changes: 1,
    });
    expect(out.ephem_sun_max_arcsec).toMatchObject({ n: 3, worst_site: SITE });
    expect(out.ephem_sun_max_arcsec.max).toBeCloseTo(3.6, 2);
    expect(out.ephem_earth_max_arcsec.max).toBe(0);
    expect(out.horizon_p95_abs_deg).toMatchObject({ max: 0.5, worst_site: SITE });
    expect(out.horizon_max_abs_deg.max).toBeCloseTo(0.5, 6);
    expect(out.sun_flag_mismatch_pct).toMatchObject({ max: 0.893, worst_site: SITE });
    expect(out.earth_flag_mismatch_pct.max).toBe(0);
    expect(out.abs_d_pct_sun).toMatchObject({ n: 3, max: 5, worst_site: SITE });
    expect(out.abs_d_pct_earth.max).toBe(0);

    expect(j.artifacts.map((a) => a.name)).toEqual(['compare_runs.csv', 'compare_runs.json']);
    const full = JSON.parse((await c.artifact(j, 'compare_runs.json')).body) as { sites: Record<string, unknown>[]; columns: string[] };
    expect(full.sites.map((s) => s['site_id']).sort()).toEqual([...RUN_SMALL_SITES].sort());
    const ap = full.sites.find((s) => s['site_id'] === SITE)!;
    expect(ap).toMatchObject({ status: 'ok', n_samples_a: 336, n_samples_b: 336, n_common: 336, d_pct_sun: 5, rank_a: 1, rank_b: 2, d_rank: -1, horizon_method_a: 'flat' });
    const csv = await c.artifact(j, 'compare_runs.csv');
    expect(csv.contentType).toMatch(/text\/csv/);
    const lines = csv.body.trim().split(/\r?\n/);
    expect(lines).toHaveLength(4);
    expect(lines[0]!.split(',')).toEqual([...full.columns, 'error']);
    expectNoPaths(csv.body + JSON.stringify(full) + JSON.stringify(j), [dirA, dirB, ctx.dataDir]);
    expect(j.progress.lines.filter((l) => /^compare: site \d\/3/.test(l))).toHaveLength(3);

    const hit = await c.post({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'cmp_b', name: 'other name' });
    expect(hit.statusCode, hit.body).toBe(200);
    expect(hit.json()).toMatchObject({ job_id: j.job_id });
  });

  it('compares the requested sites only (order and duplicates do not change the job identity)', async () => {
    const j = await c.run({ type: 'compare_runs', run_a: 'cmp_b', run_b: 'cmp_a', site_ids: ['ref_shackleton_rim', SITE, SITE] });
    expect(j.status, JSON.stringify(j.error)).toBe('succeeded');
    const out = CompareRunsJobOutput.parse(j.output);
    expect(out).toMatchObject({ run_a: 'cmp_b', run_b: 'cmp_a', n_sites_compared: 2 });
    expect(out.abs_d_pct_sun.max).toBe(5); // |B - A|
    const same = await c.post({ type: 'compare_runs', run_a: 'cmp_b', run_b: 'cmp_a', site_ids: [SITE, 'ref_shackleton_rim'] });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ job_id: j.job_id });
  });

  it('a re-imported run invalidates the cached comparison', async () => {
    const first = await c.post({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'cmp_b' });
    expect(first.statusCode).toBe(200);
    // (run A: B's files were edited after its import and would no longer pass the importer)
    const manifest = path.join(dirA, 'manifest.json');
    await writeFile(manifest, `${await readFile(manifest, 'utf8')}\n`);
    await reimport(dirA, 'cmp_a');
    const again = await c.accepted({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'cmp_b' });
    expect(again.job_id).not.toBe((first.json() as { job_id: string }).job_id);
    expect((await c.waitDone(again.job_id)).status).toBe('succeeded');
  });

  it('rejects bad requests before Python runs', async () => {
    await c.problem({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'cmp_a' }, 400, 'VALIDATION_ERROR');
    await c.problem({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'nope_run' }, 404, 'RUN_NOT_FOUND');
    await c.problem({ type: 'compare_runs', run_a: 'cmp_a' }, 400, 'VALIDATION_ERROR');
    const p = await c.problem({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'cmp_b', site_ids: [SITE, 'shackleton_nowhere'] }, 404, 'SITE_NOT_FOUND');
    expect(p).toMatchObject({ missing_in_a: ['shackleton_nowhere'], missing_in_b: ['shackleton_nowhere'] });
    await c.problem({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'cmp_b', site_ids: [] }, 400, 'VALIDATION_ERROR');
    const many = Array.from({ length: COMPARE_RUNS_LIMITS.max_sites + 1 }, (_, i) => `s${i}`);
    await c.problem({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'cmp_b', site_ids: many }, 400, 'VALIDATION_ERROR');
    await c.problem({ type: 'compare_runs', run_a: 'cmp_a', run_b: 'cmp_b', dir_a: 'C:/' }, 400, 'VALIDATION_ERROR');
  });
});
