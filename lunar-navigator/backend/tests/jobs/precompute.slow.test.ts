/**
 * SLOW end-to-end tests of the B1 compute job types with the REAL lunarnav (SPICE + PGDA + raymarch):
 *  - precompute: 2 catalog sites x 1 week, imported as a run of kind 'precompute';
 *  - analyse: the same sites / week -> ranking (same pct_* as the imported run's metrics);
 *  - alt_dates_python: 1 site, compared with the fast POST /alt-dates on the imported run.
 * Opt-in: RUN_SLOW=1 npx vitest run tests/jobs/precompute.slow.test.ts  (about 1 min on the dev machine
 * when the PGDA tiles around the south-pole sites are cached under LUNARNAV_ROOT/data; longer the first time).
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { AltDatesResponse } from '../../src/contract/alt_dates.ts';
import { Job, JobAccepted } from '../../src/contract/jobs.ts';
import { AltDatesPythonJobOutput } from '../../src/contract/job_types/alt_dates_python.ts';
import { AnalyseJobOutput } from '../../src/contract/job_types/analyse.ts';
import { PrecomputeJobOutput } from '../../src/contract/job_types/precompute.ts';
import { COLLECTIONS, getDb } from '../../src/db.ts';
import { startTestApp, type TestContext } from '../helpers.ts';

const SLOW = process.env['RUN_SLOW'] === '1';
const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);
const SITES = ['ref_connecting_ridge_c1', 'ref_shackleton_rim'];
const START = '2027-01-01T00:00:00Z';
const END = '2027-01-08T00:00:00Z';
const N = 7 * 24;
const OPTS = { provider: 'spice', dem: 'pgda', horizon_method: 'raymarch' } as const;

let ctx: TestContext;
let runId = '';

async function runJob(body: Record<string, unknown>): Promise<{ acc: JobAccepted; job: Job; ms: number }> {
  const t0 = Date.now();
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/jobs', payload: body });
  expect(res.statusCode, res.body).toBe(202);
  const acc = JobAccepted.parse(res.json());
  let job: Job;
  for (;;) {
    job = Job.parse((await ctx.app.inject({ method: 'GET', url: acc.poll })).json());
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const ms = Date.now() - t0;
  console.info(`[b1 e2e] ${String(body['type'])} job ${acc.job_id} ${job.status} in ${ms} ms`);
  return { acc, job, ms };
}

describe.skipIf(!SLOW || !HAVE_PY)('slow e2e: B1 compute job types (real lunarnav, spice + pgda + raymarch)', () => {
  beforeAll(async () => {
    ctx = await startTestApp({ config: { JOB_TIMEOUT_S: 1200, RATE_LIMIT_POST_MAX: 1000 } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('precompute: 2 catalog sites x 1 week -> imported run (kind precompute)', { timeout: 1_300_000 }, async () => {
    const { acc, job } = await runJob({ type: 'precompute', sites: SITES, start: START, end: END, ...OPTS, run_label: 'b1 e2e' });
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    runId = `job_${acc.job_id}`;
    expect(job.result).toEqual({ run_id: runId, site_id: SITES[0] });
    expect(job.progress.lines.some((l) => l.startsWith('check_output: 0 violation'))).toBe(true);
    const out = PrecomputeJobOutput.parse(job.output);
    expect(out).toMatchObject({ run_id: runId, run_label: 'b1 e2e', n_sites: 2, n_samples: N, step_min: 60 });
    for (const s of out.sites) {
      expect(s.horizon_method).toBe('raymarch');
      expect(s.dem_fallback).toBe(false);
      expect(s.dem_source ?? '').toMatch(/pgda|LDEM/i);
    }
    expect(job.artifacts.map((a) => a.name)).toEqual(['summary.csv']);

    const db = getDb();
    const run = await db
      .collection<{ _id: string; kind: string; status: string; provider: string; dem: string; horizon_method: string; n_samples: number; label: string }>(COLLECTIONS.runs)
      .findOne({ _id: runId });
    expect(run).toMatchObject({ kind: 'precompute', status: 'ready', provider: 'spice', dem: 'pgda', horizon_method: 'raymarch', n_samples: N, label: 'b1 e2e' });
    for (const site of SITES) {
      expect(await db.collection(COLLECTIONS.series).countDocuments({ 'meta.run_id': runId, 'meta.site_id': site })).toBe(N);
      const r = await ctx.app.inject({ method: 'GET', url: `/api/v1/sites/${site}?run_id=${runId}` });
      expect(r.statusCode, r.body).toBe(200);
    }
  });

  it('analyse: same sites / week -> ranking.json (agrees with the imported run)', { timeout: 1_300_000 }, async () => {
    const { job } = await runJob({ type: 'analyse', sites: SITES, start: START, end: END, ...OPTS });
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    expect(job.result).toBeNull();
    const out = AnalyseJobOutput.parse(job.output);
    expect(out).toMatchObject({ n_sites: 2, n_samples: N, provider: 'spice', dem: 'pgda', horizon_method: 'raymarch' });
    expect(out.ranking.map((r) => r.site_id).sort()).toEqual(SITES);
    expect(out.ranking.map((r) => r.rank)).toEqual([1, 2]);
    expect(job.artifacts.map((a) => a.name)).toEqual(['ranking.json']);

    // same computation as precompute: the pct_* of the ranking match the imported site_runs metrics
    if (runId) {
      const db = getDb();
      for (const row of out.ranking) {
        const sr = await db.collection<{ metrics?: Record<string, unknown> }>(COLLECTIONS.site_runs).findOne({ run_id: runId, site_id: row.site_id });
        const m = (sr?.metrics ?? {}) as Record<string, unknown>;
        expect(m['pct_sun'] as number).toBeCloseTo(row.pct_sun, 1);
        expect(m['pct_earth'] as number).toBeCloseTo(row.pct_earth, 1);
        expect(m['pct_both'] as number).toBeCloseTo(row.pct_both, 1);
      }
    }
  });

  it('alt_dates_python: 1 site recomputed by Python = POST /alt-dates on the imported run', { timeout: 1_300_000 }, async () => {
    const window = { earliest: START, latest: '2027-01-04T00:00:00Z', mission_h: 48 };
    const { job } = await runJob({ type: 'alt_dates_python', site_id: SITES[0], ...window, ...OPTS, constraints: { require_sun_at_landing: false } });
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    const out = AltDatesPythonJobOutput.parse(job.output);
    expect(out).toMatchObject({ site_id: SITES[0], n_evaluated: 3 * 24 + 1, provider: 'spice', dem: 'pgda', horizon_method: 'raymarch' });
    expect(job.artifacts.map((a) => a.name)).toEqual(['alt_dates.json']);

    if (runId) {
      const fast = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/alt-dates',
        payload: { run_id: runId, site_id: SITES[0], ...window, constraints: { require_sun_at_landing: false } },
      });
      expect(fast.statusCode, fast.body).toBe(200);
      const a = AltDatesResponse.parse(fast.json());
      expect(a.n_evaluated).toBe(out.n_evaluated);
      expect(a.n_feasible).toBe(out.n_feasible);
      expect(a.candidates.map((c) => c.landing_utc)).toEqual(out.candidates.map((c) => c.landing_utc));
      a.candidates.forEach((c, i) => expect(c.score).toBeCloseTo(out.candidates[i]?.score ?? NaN, 1));
    }
  });
});
