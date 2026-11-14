/**
 * Regression tests for the final review findings (one block per finding):
 * cache lifetime without run_id, Vary merging, 415 / wrong method, raw-file ETag + media types,
 * ranking weights edge cases, TOO_MANY_POINTS on POST /compare, impossible dates in bodies,
 * run files after a DB move (stale source_dir), Python child env / interpreter / stdio bound,
 * client keys and the shared SSE poller.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb, COLLECTIONS } from '../src/db.ts';
import { importRun } from '../src/importer/importRun.ts';
import { Problem } from '../src/lib/problem.ts';
import { clientKey, expandIPv6 } from '../src/lib/client.ts';
import { isCalendarIsoUtc } from '../src/lib/time.ts';
import { appendVary, cacheControlFor, etagMatches } from '../src/routes/a/http_cache.ts';
import { inheritedPythonEnv, resolveInterpreter, runPython, STDIO_DRAIN_MS } from '../src/python/process.ts';
import { runDirectory } from '../src/python/runFiles.ts';
import { JobWatchers } from '../src/jobs/watch.ts';
import type { JobDoc } from '../src/jobs/types.ts';
import { startTestApp, type TestContext } from './helpers.ts';
import { CATALOG_PATH, PYTHON_BIN, SAMPLE_DIR, SAMPLE_RUN_ID, hasPython } from './sample.ts';

const API = '/api/v1';
const RUN = SAMPLE_RUN_ID;
const OTHER = 'review_b';
const SITE = 'ref_connecting_ridge_c1';

describe('review fixes: units', () => {
  it('cacheControlFor: long only with an explicit run_id', () => {
    expect(cacheControlFor(undefined)).toBe('public, max-age=60');
    expect(cacheControlFor('pf_x')).toBe('public, max-age=3600');
  });

  it('etagMatches handles weak forms, lists and *', () => {
    const e = '"abc"';
    expect(etagMatches('"abc"', e)).toBe(true);
    expect(etagMatches('W/"abc"', e)).toBe(true);
    expect(etagMatches('"x", "abc"', e)).toBe(true);
    expect(etagMatches(['"x"', 'W/"abc"'], e)).toBe(true);
    expect(etagMatches('*', e)).toBe(true);
    expect(etagMatches('"abcd"', e)).toBe(false);
    expect(etagMatches('', e)).toBe(false);
    expect(etagMatches(undefined, e)).toBe(false);
  });

  it('appendVary keeps existing tokens (Origin from @fastify/cors)', () => {
    const headers: Record<string, string> = {};
    const reply = {
      getHeader: (k: string) => headers[k],
      header: (k: string, v: string) => {
        headers[k] = v;
      },
    } as unknown as Parameters<typeof appendVary>[0];
    appendVary(reply, 'accept-encoding');
    expect(headers['vary']).toBe('accept-encoding');
    headers['vary'] = 'Origin';
    appendVary(reply, 'accept-encoding');
    expect(headers['vary']).toBe('Origin, accept-encoding');
    appendVary(reply, 'Accept-Encoding', 'origin');
    expect(headers['vary']).toBe('Origin, accept-encoding');
  });

  it('isCalendarIsoUtc rejects impossible dates', () => {
    expect(isCalendarIsoUtc('2026-05-01T23:00:00Z')).toBe(true);
    expect(isCalendarIsoUtc('2026-05-01T23:00:00.250Z')).toBe(true);
    expect(isCalendarIsoUtc('2024-02-29T00:00:00Z')).toBe(true);
    for (const bad of ['2026-05-01T25:00:00Z', '2026-01-01T99:00:00Z', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01']) {
      expect(isCalendarIsoUtc(bad), bad).toBe(false);
    }
  });

  it('clientKey: IPv4, IPv4-mapped IPv6, IPv6 grouped by /64', () => {
    expect(clientKey('10.0.0.1')).toBe('10.0.0.1');
    expect(clientKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(clientKey('::1')).toBe('::1');
    expect(clientKey('2001:db8:1:2::10')).toBe('2001:0db8:0001:0002::/64');
    expect(clientKey('2001:db8:1:2:ffff:1:2:3')).toBe(clientKey('2001:db8:1:2::10'));
    expect(clientKey('2001:db8:1:3::10')).not.toBe(clientKey('2001:db8:1:2::10'));
    expect(clientKey('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
    expect(clientKey(undefined)).toBe('unknown');
    expect(expandIPv6('1.2.3.4')).toBeNull();
    expect(expandIPv6('64:ff9b::1.2.3.4')?.slice(6)).toEqual(['0102', '0304']);
  });

  it('Python children never see MONGODB_URI (allow-listed env)', () => {
    const env = inheritedPythonEnv({
      MONGODB_URI: 'mongodb://lunarnav_app:S3CRET@127.0.0.1:27017/?authSource=admin',
      MONGODB_DB: 'lunarnav',
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\t',
      LUNARNAV_DATA: '/d',
      PYTHONPATH: '/p',
      LC_ALL: 'C.UTF-8',
      CORS_ORIGINS: 'x',
      RANDOM_SECRET: 'y',
    });
    expect(env).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', LUNARNAV_DATA: '/d', PYTHONPATH: '/p', LC_ALL: 'C.UTF-8' });
  });

  it.runIf(hasPython())('a real child sees neither MONGODB_URI nor other secrets, but is still the venv', async () => {
    const prev = process.env['MONGODB_URI'];
    process.env['MONGODB_URI'] = 'mongodb://lunarnav_app:S3CRET@127.0.0.1:27017/?authSource=admin';
    try {
      const r = await runPython({
        bin: PYTHON_BIN,
        args: ['-c', 'import os,sys,json; print(json.dumps({"uri": os.environ.get("MONGODB_URI"), "prefix": sys.prefix, "lunarnav": __import__("importlib.util").util.find_spec("lunarnav") is not None}))'],
        cwd: os.tmpdir(),
        timeoutMs: 30_000,
        captureStdout: true,
      });
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout) as { uri: string | null; prefix: string; lunarnav: boolean };
      expect(out.uri).toBeNull();
      expect(path.resolve(out.prefix)).toBe(path.resolve(PYTHON_BIN, '..', '..'));
      expect(out.lunarnav).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['MONGODB_URI'];
      else process.env['MONGODB_URI'] = prev;
    }
  });

  it.runIf(process.platform === 'win32' && hasPython())('Windows: the venv launcher is bypassed (no launcher process to orphan the interpreter)', () => {
    const interp = resolveInterpreter(PYTHON_BIN);
    expect(path.resolve(interp.exe)).not.toBe(path.resolve(PYTHON_BIN));
    expect(existsSync(interp.exe)).toBe(true);
    expect(interp.env['__PYVENV_LAUNCHER__']).toBe(PYTHON_BIN);
    // not a venv / not absolute -> unchanged
    expect(resolveInterpreter('python').exe).toBe('python');
    expect(resolveInterpreter(interp.exe).exe).toBe(interp.exe);
  });

  it.runIf(hasPython())(
    'a cancelled run never hangs on a grandchild that keeps the stdio pipes open',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-orphan-'));
      const pidFile = path.join(dir, 'grandchild.pid');
      // parent -> middle (exits at once) -> grandchild that inherits our stdout/stderr and sleeps:
      // the grandchild's parent is dead, so a tree kill of the parent cannot reach it.
      const script = [
        'import subprocess, sys, time',
        'mid = "import subprocess,sys; p = subprocess.Popen([sys.executable, \\"-c\\", \\"import time; time.sleep(120)\\"]); open(sys.argv[1], \\"w\\").write(str(p.pid))"',
        'subprocess.run([sys.executable, "-c", mid, sys.argv[1]])',
        'print("ready", flush=True)',
        'time.sleep(120)',
      ].join('\n');
      const ac = new AbortController();
      const t0 = Date.now();
      const done = runPython({
        bin: PYTHON_BIN,
        args: ['-c', script, pidFile],
        cwd: dir,
        timeoutMs: 120_000,
        signal: ac.signal,
        onStdoutLine: (l) => {
          if (l === 'ready') ac.abort();
        },
      });
      const r = await done;
      const ms = Date.now() - t0;
      const gpid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      try {
        expect(r.canceled).toBe(true);
        // bounded: kill + STDIO_DRAIN_MS (+ spawn/taskkill overhead), far below the 120 s sleeps
        expect(ms).toBeLessThan(STDIO_DRAIN_MS + 20_000);
      } finally {
        if (gpid > 0) {
          if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(gpid), '/F'], { windowsHide: true });
          else {
            try {
              process.kill(gpid, 'SIGKILL');
            } catch {
              // gone
            }
          }
        }
        // Windows may hold the cwd of the just-killed process for a moment (EBUSY): retry.
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    60_000,
  );

  it('JobWatchers: one poll per job for many streams; per-client cap', async () => {
    let loads = 0;
    const doc = { _id: 'j_x', status: 'running' } as unknown as JobDoc;
    const w = new JobWatchers(async () => {
      loads++;
      return doc;
    }, 60_000);
    const seen: number[] = [];
    const offs = [0, 1, 2].map((i) => w.subscribe('j_x', () => seen.push(i)));
    expect(w.polledJobs()).toBe(1);
    w.notify('j_x');
    await new Promise((r) => setTimeout(r, 20));
    expect(loads).toBe(1);
    expect(seen.sort()).toEqual([0, 1, 2]);
    for (const off of offs) off();
    expect(w.polledJobs()).toBe(0);

    expect(w.acquire('a', 2)).toBe(true);
    expect(w.acquire('a', 2)).toBe(true);
    expect(w.acquire('a', 2)).toBe(false);
    expect(w.acquire('b', 2)).toBe(true);
    w.release('a');
    expect(w.acquire('a', 2)).toBe(true);
    w.close();
  });
});

describe('review fixes: routes on the sample run', () => {
  let ctx: TestContext;
  const inject = (opts: InjectOptions): Promise<LightMyRequestResponse> => ctx.app.inject(opts);
  const problem = async (res: LightMyRequestResponse, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const p = Problem.parse(res.json());
    expect(p.code).toBe(code);
    return p;
  };

  beforeAll(async () => {
    ctx = await startTestApp({ config: { RATE_LIMIT_POST_MAX: 1000 } });
    const db = getDb();
    // copied into DATA_DIR/runs/<run_id> like a normal import (raw-file + stale source_dir tests)
    const base = { dir: SAMPLE_DIR, check: false as const, dataDir: ctx.dataDir, catalogPath: CATALOG_PATH };
    await importRun(db, { ...base, setDefault: true });
    await importRun(db, { ...base, runId: OTHER, label: 'other' });
  }, 600_000);
  afterAll(async () => {
    await ctx?.close();
  });

  it('sites / site / horizon / ranking: short max-age without run_id, long with it; ETag follows the default run', async () => {
    const urls = [`${API}/sites`, `${API}/sites/${SITE}`, `${API}/sites/${SITE}/horizon`, `${API}/ranking`];
    const before: string[] = [];
    for (const u of urls) {
      const r = await inject({ method: 'GET', url: u });
      expect(r.statusCode, u).toBe(200);
      expect(r.headers['cache-control'], u).toBe('public, max-age=60');
      before.push(String(r.headers['etag']));
      const pinned = await inject({ method: 'GET', url: `${u}?run_id=${RUN}` });
      expect(pinned.headers['cache-control'], u).toBe('public, max-age=3600');
    }
    // switch the default run: same URL -> other run, new ETag, a stale If-None-Match gets 200
    const runs = getDb().collection<{ _id: string; is_default: boolean }>(COLLECTIONS.runs);
    await runs.updateOne({ _id: RUN }, { $set: { is_default: false } });
    await runs.updateOne({ _id: OTHER }, { $set: { is_default: true } });
    try {
      for (const [i, u] of urls.entries()) {
        const r = await inject({ method: 'GET', url: u, headers: { 'if-none-match': before[i] ?? '' } });
        expect(r.statusCode, u).toBe(200);
        expect((r.json() as { run_id: string }).run_id).toBe(OTHER);
        expect(r.headers['etag']).not.toBe(before[i]);
      }
    } finally {
      await runs.updateOne({ _id: OTHER }, { $set: { is_default: false } });
      await runs.updateOne({ _id: RUN }, { $set: { is_default: true } });
    }
  });

  it('cached routes keep Vary: Origin from CORS and add accept-encoding', async () => {
    for (const u of [`${API}/sites`, `${API}/ranking`, `${API}/sites/${SITE}/series`]) {
      const r = await inject({ method: 'GET', url: u, headers: { origin: 'http://localhost:3000', 'accept-encoding': 'gzip' } });
      expect(r.statusCode).toBe(200);
      expect(r.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      const vary = String(r.headers['vary']).toLowerCase().split(',').map((t) => t.trim());
      expect(vary, u).toContain('origin');
      expect(vary, u).toContain('accept-encoding');
    }
  });

  it('wrong method -> 404 NOT_FOUND; non-JSON bodies (text/plain too) -> 415', async () => {
    await problem(await inject({ method: 'PUT', url: `${API}/sites` }), 404, 'NOT_FOUND');
    for (const ct of ['text/plain', 'application/xml']) {
      for (const u of [`${API}/compare`, `${API}/alt-dates`, `${API}/jobs`]) {
        await problem(await inject({ method: 'POST', url: u, headers: { 'content-type': ct }, payload: 'x' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
      }
    }
    const spec = ctx.app.swagger() as unknown as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    for (const p of ['/api/v1/compare', '/api/v1/alt-dates', '/api/v1/jobs']) expect(Object.keys(spec.paths[p]?.['post']?.responses ?? {})).toContain('415');
  });

  it('raw run files: weak / list If-None-Match -> 304, real media type, never compressed', async () => {
    const url = `${API}/runs/${RUN}/files/${encodeURIComponent(`sites/${SITE}/windows.json`)}`;
    const r = await inject({ method: 'GET', url, headers: { 'accept-encoding': 'br, gzip' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.headers['content-encoding']).toBeUndefined();
    const etag = String(r.headers['etag']);
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Number(r.headers['content-length'])).toBe(r.rawPayload.length);
    for (const inm of [etag, `W/${etag}`, `"x", ${etag}`]) {
      expect((await inject({ method: 'GET', url, headers: { 'if-none-match': inm } })).statusCode, inm).toBe(304);
    }
    const gz = await inject({ method: 'GET', url: `${API}/runs/${RUN}/files/${encodeURIComponent(`sites/${SITE}/visibility.csv.gz`)}`, headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-type']).toBe('application/gzip');
    expect(gz.headers['content-encoding']).toBeUndefined();
    const csv = await inject({ method: 'GET', url: `${API}/runs/${RUN}/files/summary.csv` });
    expect(csv.headers['content-type']).toContain('text/csv');
    const spec = ctx.app.swagger() as unknown as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>> };
    const media = Object.keys(spec.paths['/api/v1/runs/{run_id}/files/{file_path}']?.['get']?.responses['200']?.content ?? {});
    expect(media.sort()).toEqual(['application/gzip', 'application/json', 'application/octet-stream', 'text/csv']);
  });

  it('ranking weights: all-zero and duplicate metrics -> 400; exponent notation accepted', async () => {
    const zero = await problem(await inject({ method: 'GET', url: `${API}/ranking?weights=pct_sun:0,pct_earth:0` }), 400, 'VALIDATION_ERROR');
    expect(zero.detail).toContain('at least one weight must be > 0');
    const dup = await problem(await inject({ method: 'GET', url: `${API}/ranking?weights=pct_sun:0.4,pct_sun:0.6` }), 400, 'VALIDATION_ERROR');
    expect(dup.detail).toContain('pct_sun is given more than once');
    expect(dup.errors?.[0]?.path).toBe('weights');
    const exp = await inject({ method: 'GET', url: `${API}/ranking?weights=pct_sun:0.9999999,pct_both:1e-7` });
    expect(exp.statusCode, exp.body).toBe(200);
    expect((exp.json() as { weights: Record<string, number> }).weights).toEqual({ pct_sun: 0.9999999, pct_both: 1e-7 });
    await problem(await inject({ method: 'GET', url: `${API}/ranking?weights=pct_sun:2e0` }), 400, 'VALIDATION_ERROR');
    const body = { site_ids: ['apollo11', 'change6'], weights: { pct_sun: 0, pct_earth: 0 } };
    await problem(await inject({ method: 'POST', url: `${API}/compare`, payload: body }), 400, 'VALIDATION_ERROR');
  });

  it('POST /compare series limits -> TOO_MANY_POINTS like /series and /sky', async () => {
    const tooMany = await inject({
      method: 'POST',
      url: `${API}/compare`,
      payload: { site_ids: ['apollo11', 'change6'], include: { series: { fields: ['sun_el_deg'], max_points: 9999 } } },
    });
    const p = await problem(tooMany, 400, 'TOO_MANY_POINTS');
    expect(p.errors?.[0]?.path).toBe('include.series.max_points');
    const fields = ['sun_az_deg', 'sun_el_deg', 'sun_dist_km', 'sun_semidiam_deg', 'horizon_el_sun_deg', 'sun_clearance_deg', 'sun_fraction', 'sun_visible', 'power_tracking'];
    await problem(await inject({ method: 'POST', url: `${API}/compare`, payload: { site_ids: ['apollo11', 'change6'], include: { series: { fields } } } }), 400, 'TOO_MANY_POINTS');
    await problem(await inject({ method: 'GET', url: `${API}/sites/${SITE}/sky?max_points=9999` }), 400, 'TOO_MANY_POINTS');
    // other errors in the same body stay VALIDATION_ERROR
    await problem(await inject({ method: 'POST', url: `${API}/compare`, payload: { site_ids: ['apollo11'], include: { series: { fields: ['sun_el_deg'], max_points: 9999 } } } }), 400, 'VALIDATION_ERROR');
  });

  it('impossible dates in request bodies -> 400 VALIDATION_ERROR (not 500)', async () => {
    const job = (start: string) => ({ type: 'custom_site', site_id: 'apollo11', start, end: '2026-06-01T00:00:00Z' });
    for (const bad of ['2026-05-01T25:00:00Z', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z']) {
      const p = await problem(await inject({ method: 'POST', url: `${API}/jobs`, payload: job(bad) }), 400, 'VALIDATION_ERROR');
      expect(p.errors?.[0]).toMatchObject({ path: 'start', in: 'body' });
    }
    const alt = { site_id: SITE, earliest: '2026-01-01T99:00:00Z', latest: '2026-01-10T00:00:00Z', mission_h: 24 };
    const pa = await problem(await inject({ method: 'POST', url: `${API}/alt-dates`, payload: alt }), 400, 'VALIDATION_ERROR');
    expect(pa.errors?.[0]?.path).toBe('earliest');
    await problem(await inject({ method: 'POST', url: `${API}/alt-dates`, payload: { ...alt, earliest: '2026-02-30T00:00:00Z' } }), 400, 'VALIDATION_ERROR');
    await problem(await inject({ method: 'POST', url: `${API}/compare`, payload: { site_ids: ['apollo11', 'change6'], start: '2026-02-30T00:00:00Z' } }), 400, 'VALIDATION_ERROR');
    // GET routes too
    await problem(await inject({ method: 'GET', url: `${API}/sites/${SITE}/series?start=2026-01-01T25:00:00Z` }), 400, 'VALIDATION_ERROR');
  });

  it('run files are found in DATA_DIR/runs/<run_id> even when source_dir is stale (DB moved to another machine)', async () => {
    const runs = getDb().collection<{ _id: string; source_dir: string }>(COLLECTIONS.runs);
    const orig = (await runs.findOne({ _id: RUN }))?.source_dir ?? '';
    expect(path.resolve(orig)).toBe(path.resolve(ctx.dataDir, 'runs', RUN));
    const stale = 'D:\\UAV\\lunar-navigator\\backend\\data\\runs\\nowhere';
    await runs.updateOne({ _id: RUN }, { $set: { source_dir: stale } });
    try {
      expect(runDirectory({ _id: RUN, source_dir: stale }, ctx.dataDir)).toBe(path.resolve(ctx.dataDir, 'runs', RUN));
      const r = await inject({ method: 'GET', url: `${API}/runs/${RUN}/files/manifest.json` });
      expect(r.statusCode, r.body).toBe(200);
      // an in-place (--no-copy) run still uses source_dir
      const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-inplace-'));
      await writeFile(path.join(elsewhere, 'manifest.json'), '{}');
      expect(runDirectory({ _id: 'pf_inplace', source_dir: elsewhere }, ctx.dataDir)).toBe(path.resolve(elsewhere));
      await rm(elsewhere, { recursive: true, force: true });
    } finally {
      await runs.updateOne({ _id: RUN }, { $set: { source_dir: orig } });
    }
  });
});
