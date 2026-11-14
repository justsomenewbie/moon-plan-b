/**
 * Job type 'check' (builder B3) through the real POST /jobs route and the real bridge
 * (backend/python/check_json.py) with a FAKE lunarnav.precompute.check_output (tests/jobs/fake_b3:
 * behaviour chosen by marker files in the run directory) on scratch copies of the run_small fixture.
 */
import { existsSync } from 'node:fs';
import { writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { CHECK_OUTPUT_MAX_VIOLATIONS, CheckJobOutput, CheckViolationsFile } from '../../src/contract/job_types/check.ts';
import { JobFailure, type RunContext } from '../../src/jobs/types/define.ts';
import { checkJob } from '../../src/jobs/types/check.ts';
import { startTestApp, type TestContext } from '../helpers.ts';
import { FAKE_B3_ROOT, expectNoPaths, importScratchRun, jobsClient, reimport } from './fake_b3/harness.ts';

const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);

describe.skipIf(!HAVE_PY)('check job (fake lunarnav B3)', () => {
  let ctx: TestContext;
  const c = jobsClient(() => ctx);
  const runs: { dir: string; cleanup: () => Promise<void> }[] = [];
  let okDir = '';
  let badDir = '';

  beforeAll(async () => {
    ctx = await startTestApp({
      config: { LUNARNAV_ROOT: FAKE_B3_ROOT, JOB_CONCURRENCY: 1, JOB_QUEUE_MAX: 20, JOB_TIMEOUT_S: 60, RATE_LIMIT_POST_MAX: 1000, JOB_MAX_ACTIVE_PER_CLIENT: 50 },
    });
    const ok = await importScratchRun('chk_ok', { setDefault: true });
    const bad = await importScratchRun('chk_bad');
    runs.push(ok, bad, await importScratchRun('chk_raise'), await importScratchRun('chk_changed'));
    okDir = ok.dir;
    badDir = bad.dir;
    await writeFile(path.join(bad.dir, 'FAKE_VIOLATIONS'), '60');
    await writeFile(path.join(runs[2]!.dir, 'FAKE_RAISE'), '1');
  });
  afterAll(async () => {
    await ctx?.close();
    for (const r of runs) await r.cleanup();
  });

  it('checks a clean run: ok output + violations.json artifact; never served from the cache', async () => {
    const j = await c.run({ type: 'check', run_id: 'chk_ok', name: 'clean' });
    expect(j.error).toBeNull();
    expect(j).toMatchObject({ status: 'succeeded', type: 'check', site_id: null, result: null });
    const out = CheckJobOutput.parse(j.output);
    expect(out).toEqual({ run_id: 'chk_ok', ok: true, n_violations: 0, n_files: out.n_files, violations: [], truncated: false });
    const manifest = JSON.parse(await readFile(path.join(okDir, 'manifest.json'), 'utf8')) as { files: Record<string, unknown> };
    expect(out.n_files).toBe(Object.keys(manifest.files).length);
    expect(j.artifacts.map((a) => a.name)).toEqual(['violations.json']);
    const art = await c.artifact(j, 'violations.json');
    expect(art.contentType).toMatch(/application\/json/);
    expect(CheckViolationsFile.parse(JSON.parse(art.body))).toMatchObject({ run_id: 'chk_ok', ok: true, n_violations: 0 });
    expect(j.progress.lines.some((l) => l.startsWith('check: 0 violation'))).toBe(true);

    // cacheable: false -> a second identical POST is a new job, not a 200 cache hit
    const again = await c.accepted({ type: 'check', run_id: 'chk_ok' });
    expect(again.job_id).not.toBe(j.job_id);
    await c.waitDone(again.job_id);
  });

  it('uses the default run when run_id is omitted', async () => {
    const j = await c.run({ type: 'check' });
    expect(j.status).toBe('succeeded');
    expect(CheckJobOutput.parse(j.output).run_id).toBe('chk_ok');
  });

  it('reports violations as a SUCCEEDED job (ok false, output truncated, all of them in the artifact, no server paths)', async () => {
    const j = await c.run({ type: 'check', run_id: 'chk_bad' });
    expect(j.status, JSON.stringify(j.error)).toBe('succeeded');
    const out = CheckJobOutput.parse(j.output);
    expect(out).toMatchObject({ ok: false, n_violations: 60, truncated: true });
    expect(out.violations).toHaveLength(CHECK_OUTPUT_MAX_VIOLATIONS);
    expect(out.violations[0]).toMatch(/^<RUN_DIR>[\\/]sites[\\/]apollo11[\\/]visibility\.csv\.gz: fake violation 1$/);
    const art = await c.artifact(j, 'violations.json');
    const file = CheckViolationsFile.parse(JSON.parse(art.body));
    expect(file.violations).toHaveLength(60);
    expect(file.violations[59]).toMatch(/fake violation 60$/);
    expectNoPaths(art.body + JSON.stringify(j), [badDir, ctx.dataDir, FAKE_B3_ROOT]);
  });

  it('fails the job (PYTHON_FAILED, exception text) when the check itself cannot run', async () => {
    const j = await c.run({ type: 'check', run_id: 'chk_raise' });
    expect(j).toMatchObject({ status: 'failed', output: null, artifacts: [] });
    expect(j.error?.code).toBe('PYTHON_FAILED');
    expect(j.error?.message).toMatch(/fake check_output exploded/);
  });

  it('rejects unknown runs, extra keys and bad ids before Python runs', async () => {
    await c.problem({ type: 'check', run_id: 'nope_run' }, 404, 'RUN_NOT_FOUND');
    await c.problem({ type: 'check', run_id: 'chk_ok', dir: 'C:/Windows' }, 400, 'VALIDATION_ERROR');
    await c.problem({ type: 'check', run_id: '../../etc' }, 400, 'VALIDATION_ERROR');
  });

  it('fails with RUN_CHANGED / RUN_NOT_FOUND when the run changed or vanished after submission', async () => {
    const ch = runs[3]!;
    const params = await checkJob.canonicalize({ type: 'check', run_id: 'chk_changed' }, { capabilities: () => Promise.reject(new Error('unused')), catalogIds: () => Promise.resolve(new Set()) } as never);
    const manifestPath = path.join(ch.dir, 'manifest.json');
    await writeFile(manifestPath, `${await readFile(manifestPath, 'utf8')}\n`);
    await reimport(ch.dir, 'chk_changed');
    const runCtx = {} as RunContext;
    await expect(checkJob.planPython(params, runCtx)).rejects.toThrow(JobFailure);
    await expect(checkJob.planPython(params, runCtx)).rejects.toMatchObject({ code: 'RUN_CHANGED' });
    await expect(checkJob.planPython({ ...(params as object), run_id: 'gone_run' } as never, runCtx)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    await rm(path.join(ch.dir, 'FAKE_RAISE'), { force: true });
  });
});
