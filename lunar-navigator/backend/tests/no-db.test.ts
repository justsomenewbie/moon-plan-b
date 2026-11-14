/**
 * The app without MongoDB (own process: the Mongo client is a per-process singleton):
 * health is degraded, data routes answer 503 SERVICE_UNAVAILABLE, rate limits produce 429 problem+json.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthResponse } from '../src/contract/health.ts';
import { Problem } from '../src/lib/problem.ts';
import { exampleAltDatesRequest } from '../src/fixtures/index.ts';
import { startTestApp, type TestContext } from './helpers.ts';

const API = '/api/v1';

describe('app without a database', () => {
  let small: TestContext;
  beforeAll(async () => {
    small = await startTestApp({ db: 'none', config: { RATE_LIMIT_MAX: 3, RATE_LIMIT_POST_MAX: 2, RATE_LIMIT_TOOLS_MAX: 1 } });
  });
  afterAll(async () => {
    await small?.close();
  });

  it('POST /alt-dates is limited per IP and answers 429 RATE_LIMITED problem+json', async () => {
    const send = () => small.app.inject({ method: 'POST', url: `${API}/alt-dates`, payload: exampleAltDatesRequest() });
    // below the limit the request reaches the handler, which needs MongoDB -> 503 problem+json
    for (let k = 0; k < 2; k++) {
      const r = await send();
      expect(r.statusCode).toBe(503);
      expect(Problem.parse(r.json()).code).toBe('SERVICE_UNAVAILABLE');
    }
    const third = await send();
    expect(third.statusCode).toBe(429);
    expect(third.headers['content-type']).toContain('application/problem+json');
    expect(third.headers['retry-after']).toBeDefined();
    const p = Problem.parse(third.json());
    expect(p.code).toBe('RATE_LIMITED');
  });

  it('POST /tools/* has its own per-tool limit (RATE_LIMIT_TOOLS_MAX)', async () => {
    const send = (tool: string) => small.app.inject({ method: 'POST', url: `${API}/tools/${tool}`, payload: {} });
    expect((await send('ephemeris')).statusCode).toBe(400); // reaches validation
    const second = await send('ephemeris');
    expect(second.statusCode).toBe(429);
    expect(Problem.parse(second.json()).code).toBe('RATE_LIMITED');
    expect((await send('horizon')).statusCode).toBe(400); // separate bucket per tool
  });

  it('health reports degraded without MongoDB', async () => {
    const h = HealthResponse.parse((await small.app.inject({ method: 'GET', url: `${API}/health` })).json());
    expect(h.status).toBe('degraded');
    expect(h.mongo.ok).toBe(false);
    expect(h.default_run_id).toBeNull();
  });
});

describe('database-backed helpers without a database', () => {
  it('getDb() throws a 503 SERVICE_UNAVAILABLE ApiError', async () => {
    const { getDb } = await import('../src/db.ts');
    expect(() => getDb()).toThrowError(expect.objectContaining({ code: 'SERVICE_UNAVAILABLE', statusCode: 503 }));
  });
});
