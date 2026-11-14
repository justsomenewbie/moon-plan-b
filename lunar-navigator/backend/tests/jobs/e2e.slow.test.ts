/**
 * SLOW end-to-end test (real lunarnav, real SPICE + PGDA + raymarch): POST /jobs for a custom coordinate,
 * poll until succeeded, check the imported run, then POST /alt-dates on the job's run.
 * Opt-in: RUN_SLOW=1 npx vitest run tests/jobs/e2e.slow.test.ts  (~15-20 s on the dev machine when the
 * PGDA tiles around the site are cached under LUNARNAV_ROOT/data; much longer the first time).
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { COLLECTIONS, getDb } from '../../src/db.ts';
import { AltDatesResponse } from '../../src/contract/alt_dates.ts';
import { Job, JobAccepted } from '../../src/contract/jobs.ts';
import { startTestApp, type TestContext } from '../helpers.ts';

const SLOW = process.env['RUN_SLOW'] === '1';
const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);
const SITE = 'custom:-89.4500:222.6900';
/** E2E_END=2028-01-01T00:00:00Z measures a 1-year job instead of 1 month. */
const END = process.env['E2E_END'] ?? '2027-02-01T00:00:00Z';
const N = (Date.parse(END) - Date.parse('2027-01-01T00:00:00Z')) / 3_600_000;

let ctx: TestContext;

describe.skipIf(!SLOW || !HAVE_PY)('slow e2e: real custom job (spice + pgda + raymarch)', () => {
  beforeAll(async () => {
    ctx = await startTestApp({ config: { JOB_TIMEOUT_S: 1200, RATE_LIMIT_POST_MAX: 1000 } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('computes, imports and serves a custom run (1 month by default)', { timeout: 1_300_000 }, async () => {
    const t0 = Date.now();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      // provider pinned: the API default is horizons (network) since 14/11
      payload: { type: 'custom_site', lat_deg: -89.45, lon_deg: -137.31, name: 'e2e ridge', start: '2027-01-01T00:00:00Z', end: END, provider: 'spice' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const acc = JobAccepted.parse(res.json());
    expect(acc.site_id).toBe(SITE);

    let job: Job;
    const seen = new Set<string>();
    for (;;) {
      const g = await ctx.app.inject({ method: 'GET', url: acc.poll });
      job = Job.parse(g.json());
      seen.add(`${job.status}/${job.progress.stage}`);
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const ms = Date.now() - t0;
    console.info(`[e2e] job ${acc.job_id} ${job.status} in ${ms} ms; states seen: ${[...seen].join(', ')}`);
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');
    expect(job.result).toEqual({ run_id: `job_${acc.job_id}`, site_id: SITE });
    expect(job.progress.lines.some((l) => l.startsWith('check_output: 0 violation'))).toBe(true);

    const runId = `job_${acc.job_id}`;
    const db = getDb();
    const run = await db.collection<{ _id: string; kind: string; status: string; provider: string; dem: string; horizon_method: string; n_samples: number }>(COLLECTIONS.runs).findOne({ _id: runId });
    expect(run).toMatchObject({ kind: 'custom', status: 'ready', provider: 'spice', dem: 'pgda', horizon_method: 'raymarch', n_samples: N });
    expect(await db.collection(COLLECTIONS.series).countDocuments({ 'meta.run_id': runId, 'meta.site_id': SITE })).toBe(N);
    expect(await db.collection(COLLECTIONS.site_runs).countDocuments({ run_id: runId, site_id: SITE })).toBe(1);

    const alt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/alt-dates',
      payload: { run_id: runId, site_id: SITE, earliest: '2027-01-01T00:00:00Z', latest: '2027-01-17T00:00:00Z', mission_h: 336 },
    });
    expect(alt.statusCode, alt.body).toBe(200);
    const a = AltDatesResponse.parse(alt.json());
    expect(a.run_id).toBe(runId);
    expect(a.n_evaluated).toBe(16 * 24 + 1);
  });
});
