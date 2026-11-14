/**
 * Authentication (src/lib/auth.ts + config rules in src/config.ts):
 * API key on /api/v1/* (except GET /health, OPTIONS), HTTP Basic on /docs + the OpenAPI JSON,
 * per-client rate limiting, the security info in the OpenAPI document, and the production config rules.
 * Every other test file runs with authentication OFF (tests/helpers.ts sets API_KEYS='').
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { Job, JobAccepted } from '../src/contract/jobs.ts';
import { authSettings } from '../src/lib/auth.ts';
import { Problem } from '../src/lib/problem.ts';
import { startTestApp, type TestContext } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ROOT = path.join(here, 'jobs', 'fake_lunarnav');
const HAVE_PY = existsSync(loadConfig({}).PYTHON_BIN);

const API = '/api/v1';
const KEY_FE = 'a'.repeat(24) + '0123456789abcdef0123456789abcdef'; // 56 chars
const KEY_TESTER = 'b'.repeat(64);
const WRONG = 'c'.repeat(64);
const API_KEYS = `fe:${KEY_FE},tester:${KEY_TESTER}`;
const DOCS_USER = 'docs';
const DOCS_PASSWORD = 'correct-horse-battery';
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const AUTH_CONFIG = { API_KEYS, DOCS_USER, DOCS_PASSWORD };

describe('API key + docs authentication', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startTestApp({ db: 'none', config: AUTH_CONFIG });
  });
  afterAll(async () => {
    await ctx?.close();
  });
  const get = (url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: 'GET', url, headers });

  it('no key -> 401 UNAUTHORIZED problem+json with WWW-Authenticate', async () => {
    const res = await get(`${API}/meta`);
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['www-authenticate']).toBe('ApiKey header="X-API-Key"');
    const p = Problem.parse(res.json());
    expect(p).toMatchObject({ status: 401, code: 'UNAUTHORIZED', title: 'Missing or invalid API key', instance: `${API}/meta` });
  });

  it('a wrong key gets exactly the same 401 body as a missing one', async () => {
    const missing = await get(`${API}/meta`);
    const variants: Record<string, string>[] = [
      { 'x-api-key': WRONG },
      { 'x-api-key': KEY_FE.slice(0, -1) },
      { 'x-api-key': `${KEY_FE}x` },
      { authorization: `Bearer ${WRONG}` },
      { authorization: basic('fe', KEY_FE) }, // Basic is not an API key scheme
      { authorization: KEY_FE }, // no scheme
      { 'x-api-key': '' },
    ];
    for (const headers of variants) {
      const res = await get(`${API}/meta`, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
      expect(res.headers['www-authenticate']).toBe('ApiKey header="X-API-Key"');
      expect(res.body).toBe(missing.body);
      expect(res.body).not.toContain(KEY_FE);
    }
  });

  it('the right key via X-API-Key or Authorization: Bearer -> 200', async () => {
    expect((await get(`${API}/meta`, { 'x-api-key': KEY_FE })).statusCode).toBe(200);
    expect((await get(`${API}/meta`, { 'x-api-key': KEY_TESTER })).statusCode).toBe(200);
    expect((await get(`${API}/meta`, { authorization: `Bearer ${KEY_FE}` })).statusCode).toBe(200);
    expect((await get(`${API}/meta`, { authorization: `bearer ${KEY_TESTER}` })).statusCode).toBe(200);
    // X-API-Key wins over a (wrong) Authorization header, e.g. Basic credentials cached by the browser for /docs
    expect((await get(`${API}/meta`, { 'x-api-key': KEY_FE, authorization: basic(DOCS_USER, DOCS_PASSWORD) })).statusCode).toBe(200);
  });

  it('GET /health needs no key; unknown /api/v1 routes need one before they 404', async () => {
    expect((await get(`${API}/health`)).statusCode).toBe(200);
    expect((await get(`${API}/health/`)).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'HEAD', url: `${API}/health` })).statusCode).toBe(200);
    expect((await get(`${API}/health?x=1`)).statusCode).toBe(200);
    expect((await get(`${API}/nothing`)).statusCode).toBe(401);
    const withKey = await get(`${API}/nothing`, { 'x-api-key': KEY_FE });
    expect(withKey.statusCode).toBe(404);
    expect(Problem.parse(withKey.json()).code).toBe('NOT_FOUND');
    // POST routes are checked before body validation / rate limits
    const post = await ctx.app.inject({ method: 'POST', url: `${API}/jobs`, payload: {} });
    expect(post.statusCode).toBe(401);
    // non-API 404s stay 404
    expect((await get('/nothing')).statusCode).toBe(404);
  });

  it('CORS preflight is not blocked, and a 401 still carries the CORS headers', async () => {
    const pre = await ctx.app.inject({
      method: 'OPTIONS',
      url: `${API}/sites`,
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(String(pre.headers['access-control-allow-headers'])).toContain('x-api-key');
    const denied = await get(`${API}/meta`, { origin: 'http://localhost:3000' });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('/docs, /docs/* and the OpenAPI JSON need HTTP Basic auth', async () => {
    for (const url of ['/docs', '/docs/', '/docs/json', '/docs/static/index.html', `${API}/openapi.json`]) {
      const none = await get(url);
      expect(none.statusCode, url).toBe(401);
      expect(none.headers['www-authenticate']).toBe('Basic realm="lunarnav docs"');
      expect(Problem.parse(none.json()).code).toBe('UNAUTHORIZED');
      expect((await get(url, { authorization: basic(DOCS_USER, 'wrong-password') })).statusCode, url).toBe(401);
      expect((await get(url, { authorization: basic('someone', DOCS_PASSWORD) })).statusCode, url).toBe(401);
      expect((await get(url, { 'x-api-key': KEY_FE })).statusCode, `${url} with an API key only`).toBe(401);
    }
    const ok = await get('/docs/', { authorization: basic(DOCS_USER, DOCS_PASSWORD) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/html');
    // staticCSP handling unchanged (no upgrade-insecure-requests)
    expect(String(ok.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
    const init = await get('/docs/static/swagger-initializer.js', { authorization: basic(DOCS_USER, DOCS_PASSWORD) });
    expect(init.statusCode).toBe(200);
    expect(init.body).toContain('persistAuthorization');
    const spec = await get(`${API}/openapi.json`, { authorization: basic(DOCS_USER, DOCS_PASSWORD) });
    expect(spec.statusCode).toBe(200);
    expect(spec.json()).toHaveProperty('openapi', '3.1.0');
  });

  it('the OpenAPI document declares the API key scheme, a global requirement and 401 on every protected operation', () => {
    const doc = ctx.app.swagger() as unknown as {
      security?: unknown;
      components: { securitySchemes?: Record<string, unknown>; schemas: Record<string, { properties?: { code?: { enum?: string[] } } }> };
      paths: Record<string, Record<string, { operationId: string; security?: unknown[]; responses: Record<string, unknown> }>>;
    };
    expect(doc.components.securitySchemes).toEqual({ ApiKeyAuth: expect.objectContaining({ type: 'apiKey', in: 'header', name: 'X-API-Key' }) });
    expect(doc.security).toEqual([{ ApiKeyAuth: [] }]);
    expect(doc.components.schemas['Problem']?.properties?.code?.enum).toContain('UNAUTHORIZED');
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    expect(ops.length).toBe(30);
    for (const op of ops) {
      if (op.operationId === 'getHealth') {
        expect(op.security).toEqual([]);
        expect(op.responses['401']).toBeUndefined();
      } else {
        expect(op.security, op.operationId).toBeUndefined();
        expect(op.responses['401'], op.operationId).toMatchObject({ content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } });
      }
    }
  });
});

describe('rate limiting per API client', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startTestApp({ db: 'none', config: { ...AUTH_CONFIG, RATE_LIMIT_MAX: 2 } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('keys get separate buckets (same IP); rejected requests do not use a bucket', async () => {
    const meta = (headers: Record<string, string>) => ctx.app.inject({ method: 'GET', url: `${API}/meta`, headers });
    for (let k = 0; k < 5; k++) expect((await meta({ 'x-api-key': WRONG })).statusCode).toBe(401);
    expect((await meta({ 'x-api-key': KEY_FE })).statusCode).toBe(200);
    expect((await meta({ authorization: `Bearer ${KEY_FE}` })).statusCode).toBe(200);
    const third = await meta({ 'x-api-key': KEY_FE });
    expect(third.statusCode).toBe(429);
    expect(Problem.parse(third.json()).code).toBe('RATE_LIMITED');
    expect((await meta({ 'x-api-key': KEY_TESTER })).statusCode).toBe(200);
  });
});

describe('logging', () => {
  it('binds the client name to the request log and never logs a key', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(...chunk.toString('utf8').split('\n').filter((l) => l.length > 0));
        cb();
      },
    });
    const app: App = await buildApp({
      db: 'none',
      logger: { level: 'info', stream },
      config: { NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:1', ...AUTH_CONFIG },
    });
    try {
      await app.ready();
      expect((await app.inject({ method: 'GET', url: `${API}/meta`, headers: { 'x-api-key': KEY_TESTER } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `${API}/meta`, headers: { 'x-api-key': WRONG } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: `${API}/meta`, headers: { authorization: `Bearer ${KEY_FE}` } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
    const records = lines.map((l) => JSON.parse(l) as { msg?: string; client?: string; res?: { statusCode?: number } });
    const completed = records.filter((r) => r.msg === 'request completed');
    expect(completed.map((r) => [r.res?.statusCode, r.client])).toEqual([
      [200, 'tester'],
      [401, undefined],
      [200, 'fe'],
    ]);
    const all = lines.join('\n');
    for (const secret of [KEY_FE, KEY_TESTER, WRONG, DOCS_PASSWORD]) expect(all).not.toContain(secret);
  });
});

describe('authentication off (no API_KEYS outside production)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startTestApp({ db: 'none', config: { NODE_ENV: 'development' } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('API and docs are open, with startup warnings', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: `${API}/meta` })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/docs/' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `${API}/openapi.json` })).statusCode).toBe(200);
    const s = authSettings(ctx.app.config);
    expect(s.apiKeys).toBe(false);
    expect(s.docs).toBe(false);
    expect(s.warnings.join('\n')).toMatch(/API_KEYS is empty/);
  });
});

describe('config rules', () => {
  const PROD = { NODE_ENV: 'production', API_KEYS, DOCS_USER, DOCS_PASSWORD };
  const fails = (input: Record<string, unknown>, re: RegExp) => {
    let err: unknown;
    try {
      loadConfig(input);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(re);
    for (const v of Object.values(input)) if (typeof v === 'string' && v.length >= 16) expect((err as Error).message).not.toContain(v);
  };

  it('production refuses to start without API_KEYS or docs credentials', () => {
    fails({ NODE_ENV: 'production' }, /API_KEYS: required when NODE_ENV=production/);
    fails({ ...PROD, API_KEYS: '' }, /API_KEYS: required/);
    fails({ ...PROD, DOCS_USER: undefined, DOCS_PASSWORD: undefined }, /DOCS_USER \/ DOCS_PASSWORD: required/);
    fails({ ...PROD, DOCS_PASSWORD: 'short' }, /DOCS_PASSWORD: must be at least 12/);
    fails({ ...PROD, API_KEYS: `fe:${KEY_FE},short:${'d'.repeat(31)}` }, /client "short" is shorter than 32/);
  });

  it('parses name:key pairs and plain keys', () => {
    const c = loadConfig({ ...PROD, API_KEYS: ` fe:${KEY_FE} , ${KEY_TESTER},` });
    expect(c.API_KEYS).toEqual([
      { name: 'fe', key: KEY_FE },
      { name: 'key2', key: KEY_TESTER },
    ]);
    expect(c.DOCS_USER).toBe(DOCS_USER);
  });

  it('rejects malformed key lists and half-set docs credentials in every environment', () => {
    fails({ API_KEYS: `fe:${KEY_FE},fe:${KEY_TESTER}` }, /duplicate client name "fe"/);
    fails({ API_KEYS: `fe:${KEY_FE},tester:${KEY_FE}` }, /same key as another client/);
    fails({ API_KEYS: `bad name:${KEY_FE}` }, /client name must match/);
    fails({ API_KEYS: 'fe:' }, /key must be non-empty/);
    fails({ DOCS_USER: 'docs' }, /set both/);
    fails({ DOCS_PASSWORD: DOCS_PASSWORD }, /set both/);
  });

  it('development accepts short secrets (with warnings) and no secrets at all', () => {
    expect(loadConfig({}).API_KEYS).toEqual([]);
    const c = loadConfig({ API_KEYS: 'dev:short', DOCS_USER: 'u', DOCS_PASSWORD: 'p' });
    const s = authSettings(c);
    expect(s.apiKeys && s.docs).toBe(true);
    expect(s.warnings.join('\n')).toMatch(/shorter than 32[\s\S]*shorter than 12/);
  });
});

describe.skipIf(!HAVE_PY)('SSE and downloads with an API key (fake lunarnav job)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startTestApp({ config: { ...AUTH_CONFIG, LUNARNAV_ROOT: FAKE_ROOT, JOB_TIMEOUT_S: 60, RATE_LIMIT_POST_MAX: 1000 } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('job events stream and run files download over HTTP with X-API-Key', async () => {
    const key = { 'x-api-key': KEY_FE };
    const post = await ctx.app.inject({
      method: 'POST',
      url: `${API}/jobs`,
      headers: key,
      payload: { type: 'custom_site', site_id: 'apollo11', start: '2027-01-01T00:00:00Z', end: '2027-01-15T00:00:00Z' },
    });
    expect(post.statusCode).toBe(202);
    const { job_id: id } = JobAccepted.parse(post.json());

    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const denied = await fetch(`${address}${API}/jobs/${id}/events`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('ApiKey header="X-API-Key"');

    const res = await fetch(`${address}${API}/jobs/${id}/events`, { headers: key, signal: AbortSignal.timeout(25_000) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text(); // the stream ends after the terminal status
    const last = text.split('\n\n').filter((e) => e.startsWith('event: job')).at(-1) ?? '';
    const job = Job.parse(JSON.parse(last.split('\ndata: ')[1] ?? '{}'));
    expect(job).toMatchObject({ job_id: id, status: 'succeeded' });

    const file = `${address}${API}/runs/job_${id}/files/${encodeURIComponent('sites/apollo11/windows.json')}`;
    expect((await fetch(file)).status).toBe(401);
    const dl = await fetch(file, { headers: { authorization: `Bearer ${KEY_FE}` } });
    expect(dl.status).toBe(200);
    expect(JSON.parse(await dl.text())).toBeTypeOf('object');
    const csv = await fetch(`${address}${API}/export/summary.csv?run_id=job_${id}`, { headers: key });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
  });
});
