/** Unit tests of the small pure modules: time, problem, naming, config, openapi pruning, db registry. */
import { describe, expect, it } from 'vitest';
import { parseIsoUtc, parseIsoUtcCeil, precisionH, sampleIndex, snapDown, snapRange, snapUp, toIsoUtc } from '../src/lib/time.ts';
import { ApiError, PROBLEM_CODES, problemBody, validationProblem } from '../src/lib/problem.ts';
import { FIELD_CASE, camelToSnake, fromWire, snakeToCamel, toWire } from '../src/lib/naming.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { pruneComponents } from '../src/lib/openapi.ts';
import { registerCollection, registeredCollections } from '../src/db.ts';

const T0 = parseIsoUtc('2026-01-01T00:00:00Z');
const H = 3_600_000;

describe('lib/time', () => {
  it('parseIsoUtcCeil rounds a sub-millisecond remainder up (FE report 14/11)', () => {
    const t = Date.parse('2026-11-19T15:00:00Z');
    expect(parseIsoUtcCeil('2026-11-19T15:00:00Z')).toBe(t);
    expect(parseIsoUtcCeil('2026-11-19T15:00:00.000Z')).toBe(t);
    expect(parseIsoUtcCeil('2026-11-19T15:00:00.000000000Z')).toBe(t);
    expect(parseIsoUtcCeil('2026-11-19T15:00:00.000001Z')).toBe(t + 1);
    expect(parseIsoUtcCeil('2026-11-19T15:00:00.000000001Z')).toBe(t + 1);
    expect(parseIsoUtcCeil('2026-11-19T15:00:00.001Z')).toBe(t + 1);
    expect(parseIsoUtcCeil('2026-11-19T15:00:00.0015Z')).toBe(t + 2);
    expect(parseIsoUtc('2026-11-19T15:00:00.000001Z')).toBe(t); // the floor parser keeps truncating
    // snapped to an hourly grid, any remainder past 15:00 now reaches 16:00
    for (const s of ['2026-11-19T15:00:00.000001Z', '2026-11-19T15:00:00.000000001Z']) {
      expect(snapUp(parseIsoUtcCeil(s), Date.parse('2026-01-01T00:00:00Z'), 3600)).toBe(t + 3_600_000);
    }
  });
  it('formats UTC without milliseconds and rejects non-Z input', () => {
    expect(toIsoUtc(Date.UTC(2026, 0, 1, 5, 30, 0, 999))).toBe('2026-01-01T05:30:00Z');
    expect(parseIsoUtc('2026-01-01T05:30:00.250Z')).toBe(T0 + 5.5 * H + 250);
    expect(() => parseIsoUtc('2026-01-01T05:30:00')).toThrow(RangeError);
    expect(() => parseIsoUtc('2026-01-01T05:30:00+02:00')).toThrow(RangeError);
  });

  it('snaps to the sample grid', () => {
    expect(sampleIndex(T0 + 5.5 * H, T0, 3600)).toBe(5);
    expect(sampleIndex(T0 - 1, T0, 3600)).toBe(-1);
    expect(snapDown(T0 + 5.5 * H, T0, 3600)).toBe(T0 + 5 * H);
    expect(snapUp(T0 + 5.5 * H, T0, 3600)).toBe(T0 + 6 * H);
    expect(snapUp(T0 + 5 * H, T0, 3600)).toBe(T0 + 5 * H);
    expect(precisionH(3600)).toBe(1);
  });

  it('snaps and clamps a range to the run, null when disjoint', () => {
    const end = T0 + 2160 * H;
    expect(snapRange(T0 + 0.5 * H, T0 + 23.2 * H, T0, end, 3600)).toEqual({ startMs: T0, endMs: T0 + 24 * H, i0: 0, n: 24, clampedStart: false, clampedEnd: false });
    expect(snapRange(T0 - 10 * H, end + 10 * H, T0, end, 3600)).toMatchObject({ startMs: T0, endMs: end, n: 2160, clampedStart: true, clampedEnd: true });
    expect(snapRange(end + H, end + 2 * H, T0, end, 3600)).toBeNull();
  });
});

describe('lib/problem', () => {
  it('builds RFC 9457 bodies with stable codes', () => {
    const b = problemBody('SITE_NOT_FOUND', '/api/v1/sites/x', 'nope', { hint: 'h', extensions: { site_id: 'x' } });
    expect(b).toEqual({ type: 'https://lunarnav.example/errors/site-not-found', title: 'Site not found', status: 404, code: 'SITE_NOT_FOUND', instance: '/api/v1/sites/x', detail: 'nope', hint: 'h', site_id: 'x' });
    const e = new ApiError('QUEUE_FULL');
    expect(e.statusCode).toBe(429);
    expect(e.message).toBe(PROBLEM_CODES.QUEUE_FULL.title);
  });

  it('maps zod issues to VALIDATION_ERROR, or TOO_MANY_POINTS for series limits only', () => {
    const v = validationProblem([{ instancePath: '/start', keyword: 'invalid_format', message: 'bad' }], 'querystring', '/x');
    expect(v.code).toBe('VALIDATION_ERROR');
    expect(v.errors).toEqual([{ path: 'start', in: 'querystring', message: 'bad', code: 'invalid_format' }]);
    expect(validationProblem([{ instancePath: '/max_points', keyword: 'too_big' }], 'querystring', '/x').code).toBe('TOO_MANY_POINTS');
    expect(validationProblem([{ instancePath: '/site_ids', keyword: 'too_big' }], 'body', '/x').code).toBe('VALIDATION_ERROR');
  });
});

describe('lib/naming', () => {
  it('is snake_case (identity) in v1 and the converters are exact', () => {
    expect(FIELD_CASE).toBe('snake_case');
    const o = { sun_el_deg: [1], sites: { a3_haworth: { pct_sun: 1 } } };
    expect(toWire(o)).toBe(o);
    expect(fromWire(o)).toBe(o);
    expect(snakeToCamel('hours_until_sunset')).toBe('hoursUntilSunset');
    expect(camelToSnake('hoursUntilSunset')).toBe('hours_until_sunset');
  });
});

describe('config', () => {
  it('parses env strings with defaults and rejects bad values', () => {
    const c = loadConfig({ PORT: '4000', CORS_ORIGINS: 'http://a, http://b', COMPRESS: 'false', MONGODB_DB: '' });
    expect(c.PORT).toBe(4000);
    expect(c.CORS_ORIGINS).toEqual(['http://a', 'http://b']);
    expect(c.COMPRESS).toBe(false);
    expect(c.MONGODB_DB).toBe('lunarnav_dev');
    expect(c.JOB_TIMEOUT_S).toBe(1200);
    expect(() => loadConfig({ PORT: 'x' })).toThrow(ConfigError);
    expect(() => loadConfig({ MONGODB_URI: 'http://nope' })).toThrow(/MONGODB_URI/);
  });
});

describe('lib/openapi pruneComponents', () => {
  it('drops unreachable schemas and renames input-only ones', () => {
    const doc = {
      paths: { '/a': { post: { requestBody: { $ref: '#/components/schemas/ReqInput' }, responses: { 200: { $ref: '#/components/schemas/Res' } } } } },
      components: { schemas: { Req: {}, ReqInput: { properties: { w: { $ref: '#/components/schemas/WInput' } } }, WInput: {}, Res: { properties: { w: { $ref: '#/components/schemas/W' } } }, W: {}, Unused: {} } },
    };
    const out = pruneComponents(doc);
    expect(Object.keys(out.components.schemas)).toEqual(['Req', 'Res', 'W', 'WInput']);
    expect(out.paths['/a'].post.requestBody.$ref).toBe('#/components/schemas/Req');
  });
});

describe('db registry', () => {
  it('merges index specs per collection and refuses conflicting time-series options', () => {
    registerCollection({ name: 'cache', owner: 'test', indexes: [{ key: { a: 1 }, name: 'a_1' }] });
    registerCollection({ name: 'cache', owner: 'test2', indexes: [{ key: { a: 1 }, name: 'a_1' }, { key: { b: 1 }, name: 'b_1' }] });
    const spec = registeredCollections().find((c) => c.name === 'cache');
    expect(spec?.indexes?.map((i) => i.name)).toEqual(['a_1', 'b_1']);
    registerCollection({ name: 'series', owner: 'test', timeseries: { timeField: 't', metaField: 'meta', granularity: 'hours' } });
    expect(() => registerCollection({ name: 'series', owner: 'test3', timeseries: { timeField: 'time' } })).toThrow(/conflicting timeseries/);
  });
});
