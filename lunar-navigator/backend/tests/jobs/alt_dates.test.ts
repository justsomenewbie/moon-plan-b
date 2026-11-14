/**
 * POST /api/v1/alt-dates: the REAL lunarnav bridge (backend/python/alt_dates_json.py) on the run_small
 * fixture imported into a throw-away MongoDB 8.0, plus failure modes through the FAKE lunarnav
 * (tests/jobs/fake_lunarnav/lunarnav/analysis.py: behaviour chosen by max_results).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { getDb } from '../../src/db.ts';
import { AltDatesRequest, AltDatesResponse } from '../../src/contract/alt_dates.ts';
import { Problem, isApiError } from '../../src/lib/problem.ts';
import { importRun } from '../../src/importer/importRun.ts';
import { AltDatesService } from '../../src/python/altDates.ts';
import { runPython } from '../../src/python/process.ts';
import { startTestApp, type TestContext } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '..', 'importer', 'fixtures', 'run_small');
const FAKE_ROOT = path.join(here, 'fake_lunarnav');
const cfg0 = loadConfig({});
const HAVE_PY = existsSync(cfg0.PYTHON_BIN);
const RUN_ID = 'run_small';
const CUSTOM = 'custom:-89.4500:222.6900';

let ctx: TestContext;

const req = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  site_id: 'apollo11',
  earliest: '2027-01-01T00:00:00Z',
  latest: '2027-01-05T00:00:00Z',
  mission_h: 48,
  max_results: 5,
  ...over,
});

const altDates = (b: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/api/v1/alt-dates', payload: b });

describe.skipIf(!HAVE_PY)('alt-dates', () => {
  beforeAll(async () => {
    ctx = await startTestApp({ config: { RATE_LIMIT_POST_MAX: 1000 } });
    // imported in place (dataDir null): source_dir = the fixture directory
    await importRun(getDb(), { dir: FIXTURE, runId: RUN_ID, check: false, dataDir: null, catalogPath: null, setDefault: true });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('runs find_alternative_dates on the stored visibility series (real lunarnav) and caches the result', async () => {
    const res = await altDates(req({ site_id: CUSTOM, latest: '2027-01-12T00:00:00Z', constraints: { min_sun_pct: 50, objective: 'sun' } }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['x-lunarnav-cache']).toBe('miss');
    const r = AltDatesResponse.parse(res.json());
    expect(r).toMatchObject({ run_id: RUN_ID, step_s: 3600, precision_h: 1, site_id: CUSTOM, earliest_utc: '2027-01-01T00:00:00Z', latest_utc: '2027-01-12T00:00:00Z', mission_duration_h: 48 });
    expect(r.constraints).toMatchObject({ min_sun_pct: 50, objective: 'sun', require_sun_at_landing: true, min_separation_h: 12 });
    expect(r.n_evaluated).toBe(265); // hourly landings 01-01T00 .. 01-12T00 inclusive
    expect(r.n_feasible).toBeLessThanOrEqual(r.n_evaluated);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(5);
    r.candidates.forEach((c, i) => {
      expect(c.rank).toBe(i + 1);
      const land = Date.parse(c.landing_utc);
      expect(land).toBeGreaterThanOrEqual(Date.parse('2027-01-01T00:00:00Z'));
      expect(land).toBeLessThanOrEqual(Date.parse('2027-01-12T00:00:00Z'));
      expect(Date.parse(c.mission_end_utc) - land).toBe(48 * 3_600_000);
      expect(c.slip_h).toBe((land - Date.parse('2027-01-01T00:00:00Z')) / 3_600_000);
      expect(c.sun_pct).toBeGreaterThanOrEqual(50);
      expect(c.sun_at_landing).toBe(true);
      expect(c.score).toBeCloseTo(c.sun_pct, 6); // objective 'sun'
    });
    for (let i = 1; i < r.candidates.length; i++) {
      expect(r.candidates[i - 1]!.score).toBeGreaterThanOrEqual(r.candidates[i]!.score);
    }
    expect(r.cache_id).toMatch(/^[0-9a-f]{64}$/);

    const again = await altDates(req({ site_id: CUSTOM, latest: '2027-01-12T00:00:00Z', constraints: { min_sun_pct: 50, objective: 'sun' } }));
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-lunarnav-cache']).toBe('hit');
    expect(again.json()).toEqual(res.json());
  });

  it('matches a direct lunarnav call on the same file', async () => {
    const res = await altDates(req({ site_id: 'ref_shackleton_rim', mission_h: 24, constraints: { require_earth_at_landing: true } }));
    expect(res.statusCode, res.body).toBe(200);
    const r = AltDatesResponse.parse(res.json());
    const vis = path.join(FIXTURE, 'sites', 'ref_shackleton_rim', 'visibility.csv.gz');
    const script = [
      'import json, sys',
      'from lunarnav.analysis import DateConstraints, find_alternative_dates',
      'from lunarnav.precompute import read_table',
      'from lunarnav.visibility import VisibilitySeries',
      'tab = read_table(sys.argv[1])',
      "kw = {k: v for k, v in tab.items() if k != 'time_utc' and not k.startswith('hours_until')}",
      "vis = VisibilitySeries(site_id='ref_shackleton_rim', times_utc=tab['time_utc'], **kw)",
      "res = find_alternative_dates(vis, '2027-01-01T00:00:00', '2027-01-05T00:00:00', 24.0, DateConstraints(require_earth_at_landing=True), max_results=5)",
      'print(json.dumps(res.to_dict()))',
    ].join('\n');
    const py = await runPython({ bin: cfg0.PYTHON_BIN, args: ['-c', script, vis], cwd: cfg0.LUNARNAV_ROOT, captureStdout: true, timeoutMs: 60_000 });
    expect(py.exitCode, py.stderrTail.join('\n')).toBe(0);
    const direct = JSON.parse(py.stdout) as Record<string, unknown>;
    const { run_id: _r, step_s: _s, precision_h: _p, cache_id: _c, ...bridge } = r;
    expect(bridge).toEqual(direct);
  });

  it('sub-second earliest/latest: candidates stay inside [earliest, latest] (FE report 14/11)', async () => {
    // 00:00:00.500 must not admit the 00:00 sample (it used to be truncated to 00:00:00Z)
    const earliest = '2027-01-01T00:00:00.500Z';
    const latest = '2027-01-01T06:00:00.750Z';
    for (const site of [CUSTOM, 'apollo11']) {
      const res = await altDates(req({ site_id: site, earliest, latest, max_results: 20, constraints: { require_sun_at_landing: false } }));
      expect(res.statusCode, res.body).toBe(200);
      const r = AltDatesResponse.parse(res.json());
      expect(r.earliest_utc).toBe('2027-01-01T01:00:00Z'); // first sample >= earliest
      expect(r.latest_utc).toBe('2027-01-01T06:00:00Z'); // last sample <= latest
      expect(r.n_evaluated).toBe(6); // 01:00 .. 06:00
      for (const c of r.candidates) {
        expect(Date.parse(c.landing_utc)).toBeGreaterThanOrEqual(Date.parse(earliest));
        expect(Date.parse(c.landing_utc)).toBeLessThanOrEqual(Date.parse(latest));
      }
    }
    // the same samples selected with whole seconds share the cache entry
    const whole = await altDates(req({ site_id: CUSTOM, earliest: '2027-01-01T01:00:00Z', latest: '2027-01-01T06:00:00Z', max_results: 20, constraints: { require_sun_at_landing: false } }));
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['x-lunarnav-cache']).toBe('hit');
  });

  it('returns 200 with empty candidates and rejected_by when nothing is feasible', async () => {
    const res = await altDates(req({ constraints: { min_continuous_sun_h: 10_000 } }));
    expect(res.statusCode).toBe(200);
    const r = AltDatesResponse.parse(res.json());
    expect(r.candidates).toEqual([]);
    expect(r.n_feasible).toBe(0);
    expect(r.rejected_by['min_continuous_sun_h']).toBeGreaterThan(0);
  });

  it('rejects bad missions and ranges with problem+json (no Python call)', async () => {
    const bad = await altDates(req({ mission_h: 1.5 }));
    expect(bad.statusCode).toBe(422);
    expect(Problem.parse(bad.json())).toMatchObject({ code: 'BAD_MISSION_LENGTH', step_h: 1 });

    const late = await altDates(req({ latest: '2027-01-14T00:00:00Z' }));
    expect(late.statusCode).toBe(422);
    expect(Problem.parse(late.json())).toMatchObject({ code: 'OUT_OF_RANGE', max_latest: '2027-01-13T00:00:00Z' });
    // exactly max_latest is fine
    expect((await altDates(req({ latest: '2027-01-13T00:00:00Z', earliest: '2027-01-12T00:00:00Z' }))).statusCode).toBe(200);

    const early = await altDates(req({ earliest: '2026-12-31T00:00:00Z' }));
    expect(early.statusCode).toBe(422);
    expect(Problem.parse(early.json())).toMatchObject({ code: 'OUT_OF_RANGE', min_earliest: '2027-01-01T00:00:00Z' });

    const reversed = await altDates(req({ earliest: '2027-01-05T00:00:00Z', latest: '2027-01-01T00:00:00Z' }));
    expect(reversed.statusCode).toBe(400);
    expect(Problem.parse(reversed.json()).code).toBe('VALIDATION_ERROR');

    const noSample = await altDates(req({ earliest: '2027-01-02T00:10:00Z', latest: '2027-01-02T00:50:00Z' }));
    expect(noSample.statusCode).toBe(422);

    const site = await altDates(req({ site_id: 'nowhere' }));
    expect(site.statusCode).toBe(404);
    expect(Problem.parse(site.json()).code).toBe('SITE_NOT_FOUND');
    const run = await altDates(req({ run_id: 'pf_missing' }));
    expect(run.statusCode).toBe(404);
    expect(Problem.parse(run.json()).code).toBe('RUN_NOT_FOUND');
    const extra = await altDates(req({ constraints: { min_sun_pct: 10, bogus: 1 } }));
    expect(extra.statusCode).toBe(400);
    const many = await altDates(req({ max_results: 51 }));
    expect(many.statusCode).toBe(400);
  });

  describe('bridge failure modes (fake lunarnav)', () => {
    const service = () =>
      new AltDatesService({ DATA_DIR: ctx.dataDir, PYTHON_BIN: cfg0.PYTHON_BIN, LUNARNAV_ROOT: FAKE_ROOT, ALTDATES_TIMEOUT_S: 2 });
    const parsed = (over: Record<string, unknown>) => AltDatesRequest.parse(req({ earliest: '2027-01-02T00:00:00Z', ...over }));
    const codeOf = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return 'ok';
      } catch (e) {
        return isApiError(e) ? e.code : `other: ${String(e)}`;
      }
    };

    it('validates the Python output and caches it per lunarnav version', async () => {
      const s = service();
      const a = await s.find(parsed({}));
      expect(a.cache).toBe('miss');
      expect(a.body.candidates[0]).toMatchObject({ rank: 1, landing_utc: '2027-01-02T00:00:00Z', continuous_earth_lower_bound: true });
      expect(a.body.rejected_by).toEqual({ min_sun_pct: 1 });
      expect((await s.find(parsed({}))).cache).toBe('hit');
      // same request through the real lunarnav (other code_version / bridge) is a different cache entry
      const real = await altDates(req({ earliest: '2027-01-02T00:00:00Z' }));
      expect(real.headers['x-lunarnav-cache']).toBe('miss');
      expect(AltDatesResponse.parse(real.json()).cache_id).not.toBe(a.body.cache_id);
    });

    it('coalesces identical in-flight requests', async () => {
      const s = service();
      const [x, y] = await Promise.all([s.find(parsed({ max_results: 7 })), s.find(parsed({ max_results: 7 }))]);
      expect([x.cache, y.cache].sort()).toEqual(['miss', 'shared']);
      expect(x.body).toEqual(y.body);
    });

    it('maps timeout, crash, ValueError and garbage output to problems', async () => {
      const s = service();
      const t0 = Date.now();
      expect(await codeOf(s.find(parsed({ max_results: 41 })))).toBe('PYTHON_TIMEOUT');
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(await codeOf(s.find(parsed({ max_results: 42 })))).toBe('PYTHON_FAILED');
      expect(await codeOf(s.find(parsed({ max_results: 43 })))).toBe('OUT_OF_RANGE');
      expect(await codeOf(s.find(parsed({ max_results: 44 })))).toBe('PYTHON_FAILED');
      // failures are not cached
      expect(await codeOf(s.find(parsed({ max_results: 42 })))).toBe('PYTHON_FAILED');
    });

    it('a missing interpreter is PYTHON_FAILED', async () => {
      const s = new AltDatesService({ DATA_DIR: ctx.dataDir, PYTHON_BIN: path.join(ctx.dataDir, 'nope', 'python.exe'), LUNARNAV_ROOT: FAKE_ROOT, ALTDATES_TIMEOUT_S: 2 });
      expect(await codeOf(s.find(parsed({ max_results: 9 })))).toBe('PYTHON_FAILED');
    });
  });
});
