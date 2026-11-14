import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { corsOriginMatcher } from '../src/app.ts';
import { requestClientKey } from '../src/lib/client.ts';
import { startTestApp, type TestContext } from './helpers.ts';

describe('CORS origin patterns', () => {
  it('exact entries stay strings, * matches one DNS label', () => {
    expect(corsOriginMatcher('http://localhost:3000')).toBe('http://localhost:3000');
    const re = corsOriginMatcher('https://*.vercel.app') as RegExp;
    expect(re.test('https://my-fe-git-main-team.vercel.app')).toBe(true);
    expect(re.test('https://vercel.app')).toBe(false);
    expect(re.test('https://a.b.vercel.app')).toBe(false);
    expect(re.test('https://evil.vercel.app.attacker.com')).toBe(false);
    expect(re.test('http://my-fe.vercel.app')).toBe(false);
  });
});

describe('requestClientKey', () => {
  it('uses the API-key client name when authenticated, else the IP key', () => {
    expect(requestClientKey({ apiClient: 'fe', ip: '1.2.3.4' })).toBe('key:fe');
    expect(requestClientKey({ apiClient: undefined, ip: '1.2.3.4' })).toBe('1.2.3.4');
    expect(requestClientKey({ ip: '::ffff:1.2.3.4' })).toBe('1.2.3.4');
  });
});

describe('browser call from a Vercel origin with an API key (CORS preflight + request)', () => {
  let ctx: TestContext;
  const KEY = 'k'.repeat(40);
  beforeAll(async () => {
    ctx = await startTestApp({ config: { API_KEYS: `fe:${KEY}`, CORS_ORIGINS: 'http://localhost:3000,https://*.vercel.app' } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('preflight allows x-api-key from https://x.vercel.app and localhost, not from other origins', async () => {
    for (const origin of ['https://lunar-fe-abc123.vercel.app', 'http://localhost:3000']) {
      const pre = await ctx.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/runs',
        headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' },
      });
      expect(pre.statusCode, origin).toBeLessThan(300);
      expect(pre.headers['access-control-allow-origin']).toBe(origin);
      expect(String(pre.headers['access-control-allow-headers']).toLowerCase()).toContain('x-api-key');
    }
    const bad = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/runs',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('GET with the key from a Vercel origin -> 200 with the CORS header; without key -> 401 still with CORS header', async () => {
    const origin = 'https://lunar-fe-abc123.vercel.app';
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/v1/runs', headers: { origin, 'x-api-key': KEY } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(origin);
    const no = await ctx.app.inject({ method: 'GET', url: '/api/v1/runs', headers: { origin } });
    expect(no.statusCode).toBe(401);
    expect(no.headers['access-control-allow-origin']).toBe(origin);
  });
});
