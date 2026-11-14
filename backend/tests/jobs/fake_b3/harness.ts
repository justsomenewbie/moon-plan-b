/**
 * Shared harness of the B3 report job-type tests (check / validate / validate_terrain / compare_runs):
 * POST /jobs + polling + artifact download against a TestContext, and scratch copies of the run_small
 * fixture (REAL lunarnav output: apollo11, custom:-89.4500:222.6900, ref_shackleton_rim) imported in place.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { getDb } from '../../../src/db.ts';
import { Job, JobAccepted } from '../../../src/contract/jobs.ts';
import { Problem } from '../../../src/lib/problem.ts';
import { importRun } from '../../../src/importer/importRun.ts';
import type { TestContext } from '../../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_B3_ROOT = here;
export const RUN_SMALL = path.resolve(here, '..', '..', 'importer', 'fixtures', 'run_small');
export const RUN_SMALL_SITES = ['apollo11', 'custom:-89.4500:222.6900', 'ref_shackleton_rim'];
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function jobsClient(getCtx: () => TestContext) {
  const post = (b: Record<string, unknown>) => getCtx().app.inject({ method: 'POST', url: '/api/v1/jobs', payload: b });
  const get = (url: string, headers: Record<string, string> = {}) => getCtx().app.inject({ method: 'GET', url, headers });

  async function accepted(b: Record<string, unknown>, status = 202): Promise<JobAccepted> {
    const res = await post(b);
    expect(res.statusCode, res.body).toBe(status);
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
  async function waitDone(id: string, timeoutMs = 30_000): Promise<Job> {
    const t0 = Date.now();
    for (;;) {
      const j = Job.parse((await get(`/api/v1/jobs/${id}`)).json());
      if (TERMINAL.includes(j.status)) return j;
      if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} still ${j.status}`);
      await sleep(100);
    }
  }
  async function run(b: Record<string, unknown>, timeoutMs?: number): Promise<Job> {
    return waitDone((await accepted(b)).job_id, timeoutMs);
  }
  /** Download one artifact of a job (must be listed). */
  async function artifact(j: Job, name: string): Promise<{ body: string; contentType: string }> {
    const a = j.artifacts.find((x) => x.name === name);
    expect(a, `artifact ${name} of ${j.job_id}: ${j.artifacts.map((x) => x.name).join(', ')}`).toBeDefined();
    const res = await get(a?.url ?? '');
    expect(res.statusCode).toBe(200);
    return { body: res.body, contentType: String(res.headers['content-type']) };
  }
  return { post, get, accepted, problem, waitDone, run, artifact };
}

/** Copy run_small to a scratch dir and import it IN PLACE (source_dir = the copy) as `runId`. */
export async function importScratchRun(runId: string, opts: { setDefault?: boolean } = {}): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-b3-run-'));
  const dir = path.join(root, runId);
  await cp(RUN_SMALL, dir, { recursive: true });
  await importRun(getDb(), { dir, runId, check: false, dataDir: null, catalogPath: null, setDefault: opts.setDefault ?? false });
  return { dir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Re-import a scratch run (after changing its files). */
export async function reimport(dir: string, runId: string): Promise<void> {
  await importRun(getDb(), { dir, runId, check: false, dataDir: null, catalogPath: null, force: true });
}

/** No absolute server path may leak into a published text. */
export function expectNoPaths(text: string, paths: readonly string[]): void {
  for (const p of paths) {
    for (const v of new Set([p, p.replaceAll('\\', '/'), p.replaceAll('/', '\\'), JSON.stringify(p).slice(1, -1)])) {
      expect(text.includes(v), `leaks ${v}`).toBe(false);
    }
  }
}
