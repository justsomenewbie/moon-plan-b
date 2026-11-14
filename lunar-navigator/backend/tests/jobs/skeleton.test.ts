/**
 * Shared skeleton of the Python integration (docs/PYTHON_INTEGRATION.md): job-type registry +
 * placeholders (501), a FAKE job type run end-to-end through POST /jobs (override seam; its "Python" is a
 * `-c` script of the real interpreter), the artifacts store + routes, GET /capabilities (fake lunarnav
 * packages, CLI-help flag detection, Trek file detection) and the argv helpers.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config.ts';
import { Capabilities } from '../../src/contract/capabilities.ts';
import { JOB_TYPES, Job, JobAccepted, JobArtifactsResponse } from '../../src/contract/jobs.ts';
import type { CheckJobRequest } from '../../src/contract/job_types/check.ts';
import { Problem } from '../../src/lib/problem.ts';
import { ArtifactError, artifactPath, collectArtifacts, readJsonFile } from '../../src/jobs/artifacts.ts';
import { JOB_TYPE_REGISTRY, defineJobType, jobTypeDef, listJobTypes, overrideJobType, placeholderJobType } from '../../src/jobs/types/index.ts';
import { getCapabilities } from '../../src/python/capabilities.ts';
import { assertArgValue, bridgeScriptArgs, bridgeScriptPath, flagArg, lunarnavCliArgs } from '../../src/python/scripts.ts';
import { startTestApp, type TestContext } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ROOT = path.join(here, 'fake_lunarnav');
const PY = loadConfig({}).PYTHON_BIN;
const HAVE_PY = existsSync(PY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The fake job's "Python": writes artifacts (two valid, one hidden name, one directory) or fails. */
const SCRIPT = [
  'import json, os, sys',
  'mode, art = sys.argv[1], sys.argv[2]',
  'print("step 1/2", flush=True)',
  'if mode == "fail":',
  '    print("boom: bad thing", flush=True)',
  '    sys.exit(3)',
  'os.makedirs(os.path.join(art, "sub"), exist_ok=True)',
  'with open(os.path.join(art, "report.json"), "w", encoding="utf-8") as f:',
  '    f.write("{" if mode == "badjson" else json.dumps({"violations": 2}))',
  'with open(os.path.join(art, "summary.md"), "w", encoding="utf-8", newline="") as f:',
  '    f.write("# Report\\n\\u00e9t\\u00e9\\n")',
  'with open(os.path.join(art, ".hidden"), "w") as f:',
  '    f.write("x")',
  'print("step 2/2", flush=True)',
].join('\n');

const fakeCheck = defineJobType<CheckJobRequest, { type: 'check'; mode: string }>({
  type: 'check',
  implemented: true,
  owner: 'test',
  summary: 'fake check job',
  label: 'fake check',
  logName: 'check.log',
  pythonStage: 'python',
  limits: { result_ttl_h: 48, public: { max_things: 3 } },
  canonicalize: (req) => ({ type: 'check', mode: req.name ?? 'ok' }),
  siteId: () => null,
  planPython: (p, run) => ({ args: ['-c', SCRIPT, p.mode, run.artifactsDir], timeoutS: 30 }),
  progress: (line, prev) => {
    const m = /^step (\d)\/2/.exec(line);
    return m ? { stage: 'python', pct: 10 + 40 * Number(m[1]) } : prev;
  },
  async onSuccess(_p, run) {
    await run.setProgress('artifacts', 97);
    const rep = await readJsonFile(path.join(run.artifactsDir, 'report.json'), z.object({ violations: z.int() }));
    return { output: { violations: rep.violations } };
  },
});

describe('job-type registry', () => {
  it('has one implemented def per JobType; placeholders and overrides go through the seam', () => {
    expect(Object.keys(JOB_TYPE_REGISTRY).sort()).toEqual([...JOB_TYPES].sort());
    for (const t of JOB_TYPES) expect(jobTypeDef(t).type).toBe(t);
    expect(listJobTypes().map((d) => d.type)).toEqual([...JOB_TYPES]);
    expect(jobTypeDef('custom_site')).toMatchObject({ implemented: true, label: 'lunarnav precompute', logName: 'precompute.log', pythonStage: 'precompute' });
    for (const t of JOB_TYPES) expect(jobTypeDef(t).implemented, t).toBe(true);
    const ph = placeholderJobType('validate_terrain', 'test', 'placeholder');
    expect(ph).toMatchObject({ type: 'validate_terrain', implemented: false });
    expect(ph.available?.({} as never)).toBe('not implemented yet');
    overrideJobType('validate_terrain', ph);
    try {
      expect(jobTypeDef('validate_terrain').implemented).toBe(false);
    } finally {
      overrideJobType('validate_terrain', null);
    }
    expect(jobTypeDef('validate_terrain').implemented).toBe(true);
    expect(() => jobTypeDef('nope')).toThrow(/unknown job type/);
  });
});

describe('argv helpers + artifact store units', () => {
  it('builds safe argv elements', () => {
    expect(flagArg('--start', '2026-01-01T00:00:00Z')).toBe('--start=2026-01-01T00:00:00Z');
    expect(flagArg('--lat', -89.45)).toBe('--lat=-89.45');
    expect(() => flagArg('--x', Number.NaN)).toThrow(RangeError);
    expect(() => flagArg('-x', 'a')).toThrow(RangeError);
    expect(() => assertArgValue('a\nb')).toThrow(RangeError);
    expect(() => assertArgValue('a\0b')).toThrow(RangeError);
    expect(lunarnavCliArgs('check', ['D:/x'])).toEqual(['-u', '-m', 'lunarnav.cli', 'check', 'D:/x']);
    expect(() => lunarnavCliArgs('check; rm', [])).toThrow(RangeError);
    expect(bridgeScriptArgs('capabilities_probe.py')[1]).toBe(bridgeScriptPath('capabilities_probe.py'));
    expect(() => bridgeScriptPath('../x.py')).toThrow(RangeError);
    expect(() => bridgeScriptPath('missing_script.py')).toThrow(/missing/);
  });

  it('resolves artifact names inside the artifacts dir only and enforces limits', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-art-'));
    try {
      expect(path.dirname(artifactPath(dir, 'a.json'))).toBe(path.resolve(dir, 'artifacts'));
      for (const bad of ['../x', '..', '.env', 'a/b.json', 'a\\b.json', '', 'x'.repeat(200)]) expect(() => artifactPath(dir, bad), bad).toThrow(ArtifactError);
      expect(await collectArtifacts(dir)).toEqual({ artifacts: [], skipped: [] });
      await mkdir(path.join(dir, 'artifacts'), { recursive: true });
      await writeFile(path.join(dir, 'artifacts', 'a.json'), '{}');
      await writeFile(path.join(dir, 'artifacts', 'b.csv'), 'x\n1\n');
      const got = await collectArtifacts(dir);
      expect(got.artifacts.map((a) => [a.name, a.media_type, a.bytes])).toEqual([
        ['a.json', 'application/json; charset=utf-8', 2],
        ['b.csv', 'text/csv; charset=utf-8', 4],
      ]);
      expect(got.artifacts[0]?.sha256).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
      await expect(collectArtifacts(dir, { max_files: 1, max_file_bytes: 100, max_total_bytes: 100 })).rejects.toThrow(/more than 1/);
      await expect(collectArtifacts(dir, { max_files: 5, max_file_bytes: 3, max_total_bytes: 100 })).rejects.toThrow(/limit 3/);
      await expect(readJsonFile(path.join(dir, 'artifacts', 'b.csv'), z.object({}))).rejects.toThrow(/not JSON/);
      await expect(readJsonFile(path.join(dir, 'artifacts', 'a.json'), z.object({ n: z.int() }))).rejects.toThrow(/does not match/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAVE_PY)('capabilities probe (fake lunarnav packages)', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) await rm(r, { recursive: true, force: true });
  });
  async function fakeRoot(withFlag: boolean): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-caps-'));
    roots.push(root);
    await mkdir(path.join(root, 'lunarnav'), { recursive: true });
    await writeFile(path.join(root, 'lunarnav', '__init__.py'), '__version__ = "9.9.9"\n');
    const flag = withFlag ? '    pre.add_argument("--near-exclusion-m", default="auto")\n' : '';
    await writeFile(
      path.join(root, 'lunarnav', 'cli.py'),
      'import argparse\n\ndef build_parser():\n    ap = argparse.ArgumentParser(prog="lunarnav")\n    sub = ap.add_subparsers(dest="command")\n' +
        '    pre = sub.add_parser("precompute")\n    pre.add_argument("--sites")\n    pre.add_argument("--dem-fallback")\n' +
        flag +
        '    sub.add_parser("check").add_argument("dir")\n    return ap\n',
    );
    await mkdir(path.join(root, 'data', 'dem'), { recursive: true });
    await writeFile(path.join(root, 'data', 'dem', 'LRO_LOLA_DEM_SPole75_30mp_v04_EQ.tif'), 'II*\0fake');
    await writeFile(path.join(root, 'data', 'dem', 'LRO_LOLA_DEM_SPole875_5mp_v04_EQ.tif.part'), 'partial');
    return root;
  }
  const cfg = (root: string) => ({ PYTHON_BIN: PY, LUNARNAV_ROOT: root, JOB_TIMEOUT_S: 1200, CUSTOM_RUN_TTL_DAYS: 30, NODE_ENV: 'test' as const });

  it('detects --near-exclusion-m from the CLI help output, sub-commands and Trek files', async () => {
    const c = Capabilities.parse(await getCapabilities(cfg(await fakeRoot(true)), { force: true }));
    expect(c.python).toMatchObject({ ok: true, lunarnav_code_version: '9.9.9', error: null });
    expect(c.cli.near_exclusion_m).toBe(true);
    expect(c.cli.subcommands).toEqual(['check', 'precompute']);
    expect(c.cli.flags['precompute']).toEqual(['--dem-fallback', '--near-exclusion-m', '--sites']);
    if (process.env['LUNARNAV_DATA'] === undefined) {
      expect(c.dems.trek.files).toEqual([{ label: 'LRO_LOLA_DEM_SPole75_30mp_v04_EQ', bytes: 8 }]);
    }
    expect(c.network.horizons).toEqual({ reachable: null, latency_ms: null, error: null });
    expect(c.dems.none.available).toBe(true);
  });

  it('reports the flag missing on a CLI without it; a broken lunarnav makes everything unavailable', async () => {
    const c = await getCapabilities(cfg(await fakeRoot(false)), { force: true });
    expect(c.cli.near_exclusion_m).toBe(false);
    // a package that fails to import (shadows the installed lunarnav: PYTHONPATH = LUNARNAV_ROOT first)
    const broken = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-caps-'));
    roots.push(broken);
    await mkdir(path.join(broken, 'lunarnav'), { recursive: true });
    await writeFile(path.join(broken, 'lunarnav', '__init__.py'), 'raise ImportError("broken on purpose")\n');
    const b = await getCapabilities(cfg(broken), { force: true });
    expect(b.python.ok).toBe(false);
    expect(b.python.error).toMatch(/broken on purpose/);
    expect(b.providers.spice.available).toBe(false);
    expect(b.job_types.find((j) => j.type === 'custom_site')).toMatchObject({ implemented: true, available: false });
  });
});

describe.skipIf(!HAVE_PY)('jobs skeleton through the API (fake lunarnav + fake job type)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    // every real type is implemented now: keep one placeholder (before the startup probe) to cover the 501 path
    overrideJobType('validate_terrain', placeholderJobType('validate_terrain', 'test', 'placeholder for the 501 path'));
    ctx = await startTestApp({ config: { LUNARNAV_ROOT: FAKE_ROOT, JOB_CONCURRENCY: 1, JOB_QUEUE_MAX: 5, JOB_TIMEOUT_S: 60, RATE_LIMIT_POST_MAX: 1000 } });
  });
  afterAll(async () => {
    overrideJobType('check', null);
    overrideJobType('validate_terrain', null);
    await ctx?.close();
  });
  const post = (b: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/api/v1/jobs', payload: b });
  const get = (url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: 'GET', url, headers });
  async function waitDone(id: string): Promise<Job> {
    const t0 = Date.now();
    for (;;) {
      const j = Job.parse((await get(`/api/v1/jobs/${id}`)).json());
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
      if (Date.now() - t0 > 20_000) throw new Error(`job ${id} still ${j.status}`);
      await sleep(100);
    }
  }

  it('GET /capabilities lists every job type (a placeholder is unavailable) and validates ?refresh', async () => {
    const res = await get('/api/v1/capabilities');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const c = Capabilities.parse(res.json());
    expect(c.job_types.map((j) => j.type)).toEqual([...JOB_TYPES]);
    expect(c.job_types[0]).toMatchObject({ type: 'custom_site', implemented: true, available: true, reason: null, timeout_s: 60, result_ttl_h: 720 });
    expect(c.job_types[0]?.limits).toMatchObject({ max_range_days: 366 });
    expect(c.job_types.find((j) => j.type === 'validate_terrain')).toMatchObject({ implemented: false, available: false, reason: 'not implemented yet' });
    for (const j of c.job_types.filter((x) => x.type !== 'validate_terrain')) expect(j.implemented, j.type).toBe(true);
    expect(c.python.lunarnav_code_version).toBe('0.0.0-fake');
    expect(c.cli.near_exclusion_m).toBe(false); // the fake CLI has no build_parser
    expect(Object.keys(c.tools).sort()).toEqual(['ephemeris', 'horizon']);
    expect((await get('/api/v1/capabilities?refresh=true')).statusCode).toBe(200);
    const bad = await get('/api/v1/capabilities?refresh=maybe');
    expect(bad.statusCode).toBe(400);
    expect(Problem.parse(bad.json()).code).toBe('VALIDATION_ERROR');
  });

  it('placeholder types answer 501 JOB_TYPE_UNAVAILABLE; unknown types / unknown keys 400', async () => {
    const res = await post({ type: 'validate_terrain' });
    expect(res.statusCode).toBe(501);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(Problem.parse(res.json())).toMatchObject({ code: 'JOB_TYPE_UNAVAILABLE', job_type: 'validate_terrain' });
    expect((await post({ type: 'precompute' })).statusCode).toBe(400); // implemented: start/end are required
    expect((await post({ type: 'nope' })).statusCode).toBe(400);
    expect((await post({ type: 'validate', bogus: 1 })).statusCode).toBe(400);
  });

  it('runs a registered job type: progress, output, artifacts list + download (ETag, 304, CSP), cache hit', async () => {
    overrideJobType('check', fakeCheck);
    const res = await post({ type: 'check' });
    expect(res.statusCode).toBe(202);
    const acc = JobAccepted.parse(res.json());
    expect(acc).toMatchObject({ type: 'check', site_id: null, status: 'queued', cached: false });
    const j = await waitDone(acc.job_id);
    expect(j.error).toBeNull();
    expect(j).toMatchObject({ type: 'check', status: 'succeeded', site_id: null, result: null, output: { violations: 2 } });
    expect(j.progress).toMatchObject({ stage: 'done', pct: 100 });
    expect(j.progress.lines).toEqual(['step 1/2', 'step 2/2']);
    expect(Date.parse(j.expires_at ?? '') - Date.parse(j.finished_at ?? '')).toBe(48 * 3_600_000);
    // only valid top-level files are published; the log and scratch never are
    expect(j.artifacts.map((a) => a.name)).toEqual(['report.json', 'summary.md']);
    const md = j.artifacts[1];
    expect(md).toMatchObject({ media_type: 'text/markdown; charset=utf-8', url: `/api/v1/jobs/${acc.job_id}/artifacts/summary.md` });
    expect(existsSync(path.join(ctx.dataDir, 'jobs', acc.job_id, 'check.log'))).toBe(true);

    const list = JobArtifactsResponse.parse((await get(`/api/v1/jobs/${acc.job_id}/artifacts`)).json());
    expect(list).toMatchObject({ job_id: acc.job_id, type: 'check', status: 'succeeded' });
    expect(list.artifacts).toEqual(j.artifacts);

    const file = await get(md?.url ?? '');
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(file.body).toBe('# Report\n\u00e9t\u00e9\n');
    expect(file.headers['etag']).toBe(`"${md?.sha256 ?? ''}"`);
    expect(file.headers['content-disposition']).toBe('inline; filename="summary.md"');
    expect(file.headers['content-security-policy']).toMatch(/sandbox/);
    expect(file.headers['content-encoding']).toBeUndefined();
    expect((await get(md?.url ?? '', { 'if-none-match': file.headers['etag'] as string })).statusCode).toBe(304);

    const missing = await get(`/api/v1/jobs/${acc.job_id}/artifacts/nothere.json`);
    expect(missing.statusCode).toBe(404);
    expect(Problem.parse(missing.json()).code).toBe('FILE_NOT_FOUND');
    for (const bad of ['.hidden', '..%2Fcheck.log', 'sub%2Fx']) {
      expect((await get(`/api/v1/jobs/${acc.job_id}/artifacts/${bad}`)).statusCode, bad).toBe(400);
    }
    expect((await get('/api/v1/jobs/j_doesnotexist1/artifacts')).statusCode).toBe(404);

    // identical request -> the succeeded job (200 cached)
    const again = await post({ type: 'check' });
    expect(again.statusCode).toBe(200);
    expect(JobAccepted.parse(again.json())).toMatchObject({ job_id: acc.job_id, cached: true, status: 'succeeded' });

    // an artifact gone from this DATA_DIR (shared DB, other DATA_DIR, manual cleanup) -> no cache hit, recompute
    await rm(path.join(ctx.dataDir, 'jobs', acc.job_id, 'artifacts', 'report.json'));
    const fresh = await post({ type: 'check' });
    expect(fresh.statusCode).toBe(202);
    const fr = JobAccepted.parse(fresh.json());
    expect(fr.job_id).not.toBe(acc.job_id);
    expect(fr.cached).toBe(false);
    expect((await waitDone(fr.job_id)).status).toBe('succeeded');
  });

  it('a failed Python run publishes nothing (PYTHON_FAILED); a bad result file fails with RESULT_FAILED', async () => {
    overrideJobType('check', fakeCheck);
    const f = JobAccepted.parse((await post({ type: 'check', name: 'fail' })).json());
    const jf = await waitDone(f.job_id);
    expect(jf).toMatchObject({ status: 'failed', error: { code: 'PYTHON_FAILED', message: 'boom: bad thing' }, artifacts: [], output: null });
    expect(JobArtifactsResponse.parse((await get(`/api/v1/jobs/${f.job_id}/artifacts`)).json()).artifacts).toEqual([]);

    const b = JobAccepted.parse((await post({ type: 'check', name: 'badjson' })).json());
    const jb = await waitDone(b.job_id);
    expect(jb.status).toBe('failed');
    expect(jb.error?.code).toBe('RESULT_FAILED');
    expect(jb.error?.message).toMatch(/report\.json is not JSON/);
    expect(jb.error?.message).not.toContain(ctx.dataDir);
    expect((await get(`/api/v1/jobs/${b.job_id}/artifacts/report.json`)).statusCode).toBe(404);
  });

  it('custom_site jobs keep their shape (type, site_id, no artifacts)', async () => {
    const res = await post({ type: 'custom_site', lat_deg: -10, lon_deg: 77, start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' });
    expect(res.statusCode).toBe(202);
    const acc = JobAccepted.parse(res.json());
    expect(acc).toMatchObject({ type: 'custom_site', site_id: 'custom:-10.0000:77.0000' });
    const j = await waitDone(acc.job_id);
    expect(j).toMatchObject({ status: 'succeeded', site_id: 'custom:-10.0000:77.0000', output: null, artifacts: [] });
    expect(j.result).toEqual({ run_id: `job_${acc.job_id}`, site_id: 'custom:-10.0000:77.0000' });
  });
});
