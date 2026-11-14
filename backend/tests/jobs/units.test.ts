/**
 * Pure units of the Python bridge / jobs (no Mongo): canonical custom ids (incl. parity with
 * lunarnav.sites.custom_site_id through the real interpreter), job parameter canonicalisation,
 * the precompute argv, the text-progress parser and runPython (timeout / cancel / spawn errors).
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import type { CreateJobRequest, CustomSiteJobRequest } from '../../src/contract/jobs.ts';
import { isApiError } from '../../src/lib/problem.ts';
import { canonicalizeJob, paramsHash } from '../../src/jobs/params.ts';
import { customSiteId, normalizeLon, parseCustomSiteId, pyRound } from '../../src/python/customSiteId.ts';
import { failureReason, precomputeArgv, progressFromLine, type ProgressState } from '../../src/python/precompute.ts';
import { runPython } from '../../src/python/process.ts';
import { stableStringify } from '../../src/python/hash.ts';

const cfg = loadConfig({});
const HAVE_PY = existsSync(cfg.PYTHON_BIN);

const job = (over: Partial<CustomSiteJobRequest> = {}): CreateJobRequest => ({
  type: 'custom_site',
  lat_deg: -89.45,
  lon_deg: -137.31,
  start: '2026-01-01T00:30:00Z',
  end: '2026-01-31T23:10:00Z',
  step_min: 60,
  provider: 'spice',
  dem: 'pgda',
  horizon_method: 'raymarch',
  observer_height_m: 2,
  ...over,
});

describe('pyRound / customSiteId', () => {
  it('rounds exact binary ties to even like Python, other values correctly', () => {
    expect(pyRound(0.03125, 4)).toBe(0.0312); // exact tie 312.5 -> even 312
    expect(pyRound(-0.03125, 4)).toBe(-0.0312);
    expect(pyRound(0.09375, 4)).toBe(0.0938); // 937.5 -> 938 (even)
    expect(pyRound(2.675, 2)).toBe(2.67); // 2.675 is 2.67499999... in binary
    expect(pyRound(1.00005, 4)).toBe(1.0001); // binary value is slightly above the half
    expect(Object.is(pyRound(-0.00004, 4), 0)).toBe(true); // -0.0 + 0.0 -> 0.0
  });

  it('builds canonical ids', () => {
    expect(customSiteId(-89.45, 222.69)).toBe('custom:-89.4500:222.6900');
    expect(customSiteId(-89.45, -137.31)).toBe('custom:-89.4500:222.6900');
    expect(customSiteId(0, 359.99996)).toBe('custom:0.0000:0.0000');
    expect(customSiteId(-0.00001, -1e-17)).toBe('custom:0.0000:0.0000');
    expect(customSiteId(90, 360)).toBe('custom:90.0000:0.0000');
    expect(normalizeLon(-360)).toBe(0);
    expect(() => customSiteId(91, 0)).toThrow(RangeError);
    expect(() => customSiteId(0, 361)).toThrow(RangeError);
  });

  it('parses only canonical ids', () => {
    expect(parseCustomSiteId('custom:-89.4500:222.6900')).toEqual({ lat: -89.45, lon: 222.69 });
    expect(() => parseCustomSiteId('custom:-89.45:222.69')).toThrow(/canonical/);
    expect(() => parseCustomSiteId('custom:-89.4500:360.0000')).toThrow(/\[0, 360\)/);
    expect(() => parseCustomSiteId('custom:-0.0000:1.0000')).toThrow(/non-canonical/);
  });

  it.skipIf(!HAVE_PY)('matches lunarnav.sites.custom_site_id for 3000 inputs (real Python)', async () => {
    const inputs: [number, number][] = [
      [0.03125, 0.03125], [-0.03125, -0.03125], [0.09375, 359.96875], [-89.99995, 359.99995], [89.99995, -359.99995],
      [-0.00005, -0.00005], [1.00005, 2.00005], [-45.12345, 123.45675], [90, 360], [-90, -360], [0, -1e-17], [12.5e-5, 7.5e-5],
    ];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 1000; i++) inputs.push([rnd() * 180 - 90, rnd() * 720 - 360]);
    for (let i = 0; i < 1000; i++) inputs.push([Math.round((rnd() * 180 - 90) * 1e5) / 1e5, Math.round((rnd() * 720 - 360) * 1e5) / 1e5]);
    for (let i = 0; i < 988; i++) inputs.push([(Math.floor(rnd() * 2880) - 1440) / 32 / 16, (Math.floor(rnd() * 23040) - 11520) / 32]); // exact dyadic ties
    const script = 'import json,sys\nfrom lunarnav.sites import custom_site_id\nprint(json.dumps([custom_site_id(a,b) for a,b in json.load(sys.stdin)]))';
    const r = await runPython({ bin: cfg.PYTHON_BIN, args: ['-c', script], cwd: cfg.LUNARNAV_ROOT, input: JSON.stringify(inputs), captureStdout: true, timeoutMs: 60_000 });
    expect(r.exitCode, r.stderrTail.join('\n')).toBe(0);
    const py = JSON.parse(r.stdout) as string[];
    const ts = inputs.map(([a, b]) => customSiteId(a, b));
    const diffs = ts.map((t, i) => (t === py[i] ? null : { input: inputs[i], ts: t, py: py[i] })).filter((x) => x !== null);
    expect(diffs).toEqual([]);
    expect(py.length).toBe(3000);
  });
});

describe('job parameters', () => {
  const ctx = { catalogIds: new Set(['apollo11']) };

  it('canonicalises custom coordinates and snaps the range to whole hours', () => {
    const p = canonicalizeJob(job(), ctx);
    expect(p).toEqual({
      type: 'custom_site',
      site_id: 'custom:-89.4500:222.6900',
      lat_deg: -89.45,
      lon_deg: 222.69,
      start: '2026-01-01T00:00:00Z',
      end: '2026-02-01T00:00:00Z',
      step_min: 60,
      provider: 'spice',
      dem: 'pgda',
      horizon_method: 'raymarch',
      observer_height_m: 2,
    });
  });

  it('gives identical hashes for equivalent requests and different ones otherwise', () => {
    const a = paramsHash(canonicalizeJob(job(), ctx), '0.1.0');
    expect(paramsHash(canonicalizeJob(job({ lon_deg: 222.69, name: 'Other name' }), ctx), '0.1.0')).toBe(a);
    expect(paramsHash(canonicalizeJob(job({ site_id: 'custom:-89.4500:222.6900', lat_deg: undefined, lon_deg: undefined }), ctx), '0.1.0')).toBe(a);
    expect(paramsHash(canonicalizeJob(job(), ctx), '0.2.0')).not.toBe(a); // code version is part of the hash
    expect(paramsHash(canonicalizeJob(job({ observer_height_m: 3 }), ctx), '0.1.0')).not.toBe(a);
    const none1 = canonicalizeJob(job({ dem: 'none', horizon_method: 'raymarch' }), ctx);
    expect(none1.horizon_method).toBe('flat');
    expect(paramsHash(none1, 'x')).toBe(paramsHash(canonicalizeJob(job({ dem: 'none', horizon_method: 'bruteforce' }), ctx), 'x'));
  });

  it('accepts catalog ids, rejects unknown / non-canonical ids and long or empty ranges', () => {
    expect(canonicalizeJob(job({ site_id: 'apollo11', lat_deg: undefined, lon_deg: undefined }), ctx).site_id).toBe('apollo11');
    const codeOf = (f: () => unknown): string | undefined => {
      try {
        f();
      } catch (e) {
        return isApiError(e) ? e.code : 'other';
      }
      return undefined;
    };
    expect(codeOf(() => canonicalizeJob(job({ site_id: 'nowhere', lat_deg: undefined, lon_deg: undefined }), ctx))).toBe('SITE_NOT_FOUND');
    expect(codeOf(() => canonicalizeJob(job({ site_id: 'custom:-89.45:222.69', lat_deg: undefined, lon_deg: undefined }), ctx))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => canonicalizeJob(job({ end: '2027-01-03T00:00:00Z' }), ctx))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => canonicalizeJob(job({ start: '2026-01-01T05:00:00Z', end: '2026-01-01T05:00:00Z' }), ctx))).toBe('VALIDATION_ERROR');
    // a full year + 1 day (leap-safe limit of 366 days) is fine
    expect(codeOf(() => canonicalizeJob(job({ start: '2027-01-01T00:00:00Z', end: '2028-01-01T00:00:00Z' }), ctx))).toBeUndefined();
    // unknown catalog (null) -> accepted, Python validates
    expect(canonicalizeJob(job({ site_id: 'nowhere', lat_deg: undefined, lon_deg: undefined }), { catalogIds: null }).site_id).toBe('nowhere');
  });

  it('stableStringify sorts keys and drops undefined', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: undefined }], e: null })).toBe('{"a":[{"d":2}],"b":1,"e":null}');
  });
});

describe('precompute command + progress', () => {
  it('passes the site via --sites (custom ids contain ":"), never via --custom-site', () => {
    const p = canonicalizeJob(job(), { catalogIds: null });
    const argv = precomputeArgv({ params: p, outDir: 'D:/data/runs/job_j_x', runTimestamp: '2026-11-14T10:00:00Z' });
    expect(argv.slice(0, 4)).toEqual(['-u', '-m', 'lunarnav.cli', 'precompute']);
    expect(argv).not.toContain('--custom-site');
    const val = (k: string) => argv[argv.indexOf(k) + 1];
    expect(val('--sites')).toBe('custom:-89.4500:222.6900');
    expect(val('--start')).toBe('2026-01-01T00:00:00Z');
    expect(val('--end')).toBe('2026-02-01T00:00:00Z');
    expect(val('--dem-fallback')).toBe('flat');
    expect(val('--out')).toBe('D:/data/runs/job_j_x');
    expect(val('--run-timestamp')).toBe('2026-11-14T10:00:00Z');
    expect(val('--observer-height')).toBe('2');
  });

  it('turns CLI lines into coarse progress and failure reasons', () => {
    let s: ProgressState = { stage: 'precompute', pct: 5 };
    s = progressFromLine('note: site x: smooth-sphere horizon', s);
    expect(s.pct).toBe(5);
    s = progressFromLine('[1/1] custom:-89.4500:222.6900: horizon + ephemeris + visibility', s);
    expect(s.pct).toBe(10);
    expect(progressFromLine('[2/2] b: horizon', s).pct).toBe(45);
    s = progressFromLine('wrote D:/x', s);
    expect(s.pct).toBe(85);
    expect(progressFromLine('check_output: 0 violation(s)', s).pct).toBe(92);
    expect(failureReason(['wrote x', 'VIOLATION: a', 'VIOLATION: b', 'check_output: 2 violation(s)'], 1)).toBe(
      'check_output failed: 2 violation(s), first: a',
    );
    expect(failureReason(['Traceback (most recent call last):', '  File "x.py", line 1', 'ValueError: boom'], 1)).toBe('ValueError: boom');
    expect(failureReason([], 3)).toBe('lunarnav precompute exited with code 3');
  });
});

describe.skipIf(!HAVE_PY)('runPython (real interpreter)', () => {
  it('captures stdout, stdin and exit code with UTF-8', async () => {
    const r = await runPython({
      bin: cfg.PYTHON_BIN,
      args: ['-c', 'import sys; d=sys.stdin.read(); print("got", d); print("\u00e9t\u00e9 \u2600"); sys.exit(3)'],
      cwd: cfg.LUNARNAV_ROOT,
      input: 'hello',
      captureStdout: true,
      timeoutMs: 20_000,
    });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe('got hello\n\u00e9t\u00e9 \u2600');
    expect(r.timedOut).toBe(false);
  });

  it('kills the process on timeout and on abort', async () => {
    const sleeper = ['-c', 'import time; print("start", flush=True); time.sleep(60)'];
    const t = await runPython({ bin: cfg.PYTHON_BIN, args: sleeper, cwd: cfg.LUNARNAV_ROOT, timeoutMs: 1500 });
    expect(t.timedOut).toBe(true);
    expect(t.exitCode).not.toBe(0);
    expect(t.durationMs).toBeLessThan(15_000);

    const ac = new AbortController();
    const lines: string[] = [];
    const p = runPython({ bin: cfg.PYTHON_BIN, args: sleeper, cwd: cfg.LUNARNAV_ROOT, timeoutMs: 60_000, signal: ac.signal, onStdoutLine: (l) => {
      lines.push(l);
      ac.abort();
    } });
    const c = await p;
    expect(lines).toEqual(['start']);
    expect(c.canceled).toBe(true);
    expect(c.timedOut).toBe(false);
    expect(c.durationMs).toBeLessThan(15_000);
  });

  it('reports a missing interpreter as spawnError', async () => {
    const r = await runPython({ bin: 'Z:/definitely/not/python.exe', args: ['-V'], cwd: cfg.LUNARNAV_ROOT, timeoutMs: 5000 });
    expect(r.spawnError).not.toBeNull();
    expect(r.exitCode).toBeNull();
  });
});
