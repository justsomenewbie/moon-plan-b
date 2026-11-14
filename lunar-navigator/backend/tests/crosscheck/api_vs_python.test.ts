/**
 * CROSS-CHECK: API responses vs the Python precompute files and vs lunarnav's own functions, on the real
 * sample run (tests/fixtures/sample_2026Q1_spice_pgda, 6 sites x 2160 hourly samples). Set LUNARNAV_SAMPLE_DIR to
 * run the same checks on another precompute run, e.g. a custom job's output DATA_DIR/runs/job_<id>.
 *
 * The run is imported by the real importer WITH the real `lunarnav check` gate into a throw-away
 * MongoDB 8.0, then queried over HTTP (app.inject). Expected values come from two independent sources:
 *   - the files themselves, parsed here with csv-parse / JSON.parse (summary.csv, windows.json, horizon_*.csv);
 *   - tests/crosscheck/python_reference.py, which reads visibility.csv.gz with lunarnav.precompute.read_table
 *     and recomputes windows (find_windows), metrics (compute_metrics) and instant answers
 *     (hours_until_state, time_until_sunset / next_sunrise / time_until_earthset / next_earthrise).
 * Every comparison is EXACT (toEqual / toBe on doubles): the API must not lose a single bit.
 * Random timestamps come from a seeded PRNG (reproducible); the seed is printed on failure.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { RankingResponse } from '../../src/contract/analysis.ts';
import type { Metrics } from '../../src/contract/common.ts';
import { InstantResponse, SeriesResponse, SkyResponse, SERIES_FIELDS, type SeriesFieldName } from '../../src/contract/series.ts';
import { HorizonResponse, SiteDetail, SitesResponse } from '../../src/contract/sites.ts';
import { WindowsResponse } from '../../src/contract/windows.ts';
import { getDb } from '../../src/db.ts';
import { importRun, type ImportResult } from '../../src/importer/importRun.ts';
import { startTestApp, type TestContext } from '../helpers.ts';
import { CATALOG_PATH, PYTHON_BIN, REPO_ROOT, SAMPLE_DIR, SAMPLE_RUN_ID, hasPython } from '../sample.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = '/api/v1';
const SEED = 20261114;
const N_ROWS = 40; // random samples per site for the series check (all 24 columns each)
const N_INSTANTS = 25; // random instants per site (arbitrary seconds, not on the grid)

// ---- files of the sample run ----------------------------------------------------------------------
interface SiteFileRecord {
  id: string;
  files: { horizon: string; visibility: string; windows: string };
}
const SITES = (JSON.parse(readFileSync(path.join(SAMPLE_DIR, 'sites.json'), 'utf8')) as { sites: SiteFileRecord[] }).sites;
const MANIFEST = JSON.parse(readFileSync(path.join(SAMPLE_DIR, 'manifest.json'), 'utf8')) as {
  params_fingerprint: string;
  parameters: { start_utc: string; end_utc: string; step_s: number; n_samples: number };
};
/** LUNARNAV_SAMPLE_DIR may point at ANY precompute run (e.g. a custom job's DATA_DIR/runs/job_<id>): same checks. */
const EXPECTED_RUN_ID = process.env['LUNARNAV_SAMPLE_DIR'] === undefined ? SAMPLE_RUN_ID : `pf_${MANIFEST.params_fingerprint}`;
const T0 = Date.parse(MANIFEST.parameters.start_utc);
const T_END = Date.parse(MANIFEST.parameters.end_utc);
const STEP_MS = MANIFEST.parameters.step_s * 1000;
const N = MANIFEST.parameters.n_samples;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

const SUMMARY_STR = new Set(['site_id', 'name', 'group']);
const SUMMARY_BOOL = new Set(['longest_dark_truncated', 'longest_comms_gap_truncated']);
function summaryFromCsv(text: string): Record<string, string | number | boolean | null>[] {
  const rows = parse(text, { columns: true }) as Record<string, string>[];
  return rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, SUMMARY_STR.has(k) ? v : SUMMARY_BOOL.has(k) ? v === '1' || v === 'True' : v === '' ? null : Number(v)])),
  );
}
const SUMMARY = summaryFromCsv(readFileSync(path.join(SAMPLE_DIR, 'summary.csv'), 'utf8'));

interface FileWindow {
  start: string;
  end: string;
  duration_h: number;
  state: boolean;
  truncated_start: boolean;
  truncated_end: boolean;
  start_index: number;
  end_index: number;
}
interface WindowsFile {
  metrics: Metrics;
  sun?: FileWindow[];
  earth?: FileWindow[];
  both?: FileWindow[];
  [k: string]: unknown;
}
const windowsFile = (s: SiteFileRecord) => JSON.parse(readFileSync(path.join(SAMPLE_DIR, s.files.windows), 'utf8')) as WindowsFile;

// ---- seeded PRNG (mulberry32) ---------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Python reference -----------------------------------------------------------------------------
interface PyNext {
  hours: number;
  at: string | null;
  state_now: boolean;
  lower_bound: boolean;
}
interface PySite {
  n: number;
  step_s: number;
  rows: Record<string, Record<string, number | boolean | string | null>>;
  windows: Record<'sun' | 'earth' | 'both', FileWindow[]>;
  metrics: Metrics;
  instants: Record<string, { sample_index: number; sample_utc: string; sun_visible: boolean; earth_visible: boolean; hours_until_state: Record<string, number | null>; next: Record<string, PyNext> }>;
}

const rand = rng(SEED);
const PLAN = Object.fromEntries(
  SITES.map((s) => {
    const rows = [0, N - 1, ...Array.from({ length: N_ROWS - 2 }, () => Math.floor(rand() * N))];
    const instants = [iso(T0), iso(T_END - 1000), ...Array.from({ length: N_INSTANTS - 2 }, () => iso(T0 + Math.floor((rand() * (T_END - T0)) / 1000) * 1000))];
    return [s.id, { rows, instants }];
  }),
);

let ctx: TestContext;
let imported: ImportResult;
let PY: Record<string, PySite> = {};
const counts = { series_values: 0, instants: 0, windows: 0, horizon_points: 0, summary_values: 0 };

async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const res = await ctx.app.inject({ method: 'GET', url });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return schema.parse(res.json());
}

describe.runIf(hasPython())(`API vs Python on the sample run (seed ${SEED})`, () => {
  beforeAll(async () => {
    ctx = await startTestApp();
    imported = await importRun(getDb(), {
      dir: SAMPLE_DIR,
      check: { pythonBin: PYTHON_BIN, cwd: REPO_ROOT, timeoutMs: 180_000 },
      dataDir: ctx.dataDir,
      catalogPath: CATALOG_PATH,
      setDefault: true,
    });
    const py = spawnSync(PYTHON_BIN, ['-I', path.join(here, 'python_reference.py')], {
      cwd: REPO_ROOT,
      input: JSON.stringify({ run_dir: SAMPLE_DIR, sites: PLAN }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    });
    expect(py.status, py.stderr).toBe(0);
    PY = JSON.parse(py.stdout) as Record<string, PySite>;
  }, 600_000);

  afterAll(async () => {
    console.info(`[crosscheck] seed ${SEED}: ${JSON.stringify(counts)}`);
    await ctx?.close();
  });

  it('imports the run through the real lunarnav check gate (0 violations, every checksum matches)', () => {
    expect(imported.run_id).toBe(EXPECTED_RUN_ID);
    expect(imported.run_id).toBe(`pf_${MANIFEST.params_fingerprint}`);
    expect(imported.outcome).toBe('imported');
    expect(imported.check?.violations).toEqual([]);
    expect(imported.checksum_problems).toEqual([]);
    expect(imported.counts.series).toBe(SITES.length * N);
  });

  it('GET /ranking (default weights, full run) = summary.csv row by row, field by field', async () => {
    const r = await getJson(`${API}/ranking`, RankingResponse);
    expect(r.source).toBe('summary');
    expect(r.ranking.map((x) => x.site_id)).toEqual(SUMMARY.map((s) => s['site_id']));
    r.ranking.forEach((row, i) => {
      const file = SUMMARY[i] ?? {};
      for (const [k, v] of Object.entries(row)) {
        if (k === 'reasons') continue;
        expect(k in file, `summary.csv has no column ${k}`).toBe(true);
        expect(v, `${row.site_id}.${k}`).toBe(file[k]);
        counts.summary_values++;
      }
    });
  });

  it('GET /export/summary.csv = summary.csv (every value) and GET /sites rank/score = summary.csv', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `${API}/export/summary.csv` });
    expect(res.statusCode).toBe(200);
    expect(summaryFromCsv(res.body)).toEqual(SUMMARY);
    const sites = await getJson(`${API}/sites`, SitesResponse);
    expect(sites.sites.map((s) => [s.id, s.rank, s.score])).toEqual(SUMMARY.map((s) => [s['site_id'], s['rank'], s['score']]));
  });

  it('GET /sites/{id}.metrics = windows.json metrics = lunarnav compute_metrics(visibility.csv.gz)', async () => {
    for (const s of SITES) {
      const d = await getJson(`${API}/sites/${s.id}`, SiteDetail);
      expect(d.metrics, s.id).toEqual(windowsFile(s).metrics);
      expect(d.metrics, `${s.id} vs compute_metrics`).toEqual(PY[s.id]?.metrics);
    }
  });

  it('GET /sites/{id}/windows (full run) = windows.json = lunarnav find_windows(visibility.csv.gz)', async () => {
    for (const s of SITES) {
      const api = await getJson(`${API}/sites/${s.id}/windows`, WindowsResponse);
      const file = windowsFile(s);
      for (const kind of ['sun', 'earth', 'both'] as const) {
        const got = (api[kind] ?? []).map((w) => {
          expect(w.clipped_start || w.clipped_end, `${s.id} ${kind} clipped on the full run`).toBe(false);
          const { clipped_start: _a, clipped_end: _b, ...rest } = w;
          return rest;
        });
        const strip = (w: FileWindow) => ({ start: w.start, end: w.end, duration_h: w.duration_h, state: w.state, truncated_start: w.truncated_start, truncated_end: w.truncated_end });
        const fromFile = (file[kind] as FileWindow[] | undefined) ?? [];
        expect(fromFile.length, `${s.id} windows.json ${kind}`).toBeGreaterThan(0);
        expect(got, `${s.id} ${kind} vs windows.json`).toEqual(fromFile.map(strip));
        expect(got, `${s.id} ${kind} vs find_windows`).toEqual((PY[s.id]?.windows[kind] ?? []).map(strip));
        counts.windows += got.length;
      }
    }
  });

  it('GET /sites/{id}/series at random timestamps = visibility.csv.gz (all 24 columns, bit-exact)', async () => {
    const chunks: SeriesFieldName[][] = [];
    for (let i = 0; i < SERIES_FIELDS.length; i += 8) chunks.push(SERIES_FIELDS.slice(i, i + 8));
    const r2 = rng(SEED + 1);
    for (const s of SITES) {
      const ref = PY[s.id];
      expect(ref?.n).toBe(N);
      for (const k of PLAN[s.id]?.rows ?? []) {
        const row = ref?.rows[String(k)];
        expect(row, `${s.id} row ${k}`).toBeDefined();
        // an arbitrary instant inside sample k: the range snaps down to the sample
        const t = T0 + k * STEP_MS + Math.floor(r2() * 3600) * 1000;
        const start = iso(t);
        const end = iso(Math.min(t + 1000, T_END));
        for (const fields of chunks) {
          const b = await getJson(`${API}/sites/${s.id}/series?start=${start}&end=${end}&fields=${fields.join(',')}`, SeriesResponse);
          expect(b.start, `${s.id} ${start}`).toBe(row?.['time_utc']);
          expect(b.n).toBe(1);
          for (const f of fields) {
            const col = b.fields[f];
            expect(Array.isArray(col), f).toBe(true);
            expect((col as unknown[])[0], `${s.id} k=${k} ${f}`).toBe(row?.[f]);
            counts.series_values++;
          }
        }
      }
    }
    expect(counts.series_values).toBe(SITES.length * N_ROWS * SERIES_FIELDS.length);
  });

  it('GET /sites/{id}/instant at random instants = lunarnav.windows (hours_until_state + NextEvent functions)', async () => {
    for (const s of SITES) {
      for (const t of PLAN[s.id]?.instants ?? []) {
        const e = PY[s.id]?.instants[t];
        expect(e, `${s.id} ${t}`).toBeDefined();
        if (!e) continue;
        const b = await getJson(`${API}/sites/${s.id}/instant?t=${t}`, InstantResponse);
        expect(b.sample_utc, `${s.id} ${t}`).toBe(e.sample_utc);
        expect(b.sample_index).toBe(e.sample_index);
        expect(b.sun.visible, `${s.id} ${t} sun`).toBe(e.sun_visible);
        expect(b.earth.visible, `${s.id} ${t} earth`).toBe(e.earth_visible);
        expect(b.hours_until, `${s.id} ${t} hours_until`).toEqual(e.hours_until_state);
        expect(b.next_events, `${s.id} ${t} next_events`).toEqual(e.next);
        // the instant readout is the stored sample: same values as the series row of that sample
        const row = PY[s.id]?.rows[String(e.sample_index)];
        if (row) expect(b.sun.el_deg).toBe(row['sun_el_deg']);
        counts.instants++;
      }
    }
    expect(counts.instants).toBe(SITES.length * N_INSTANTS);
  });

  it('GET /sites/{id}/horizon and /sky horizon = horizon_<method>.csv (every azimuth, bit-exact)', async () => {
    for (const s of SITES) {
      const rows = parse(readFileSync(path.join(SAMPLE_DIR, s.files.horizon), 'utf8'), { columns: true }) as Record<string, string>[];
      const az = rows.map((r) => Number(r['az_deg']));
      const el = rows.map((r) => Number(r['el_deg']));
      const rad = rows.map((r) => Number(r['covered_radius_km']));
      const h = await getJson(`${API}/sites/${s.id}/horizon`, HorizonResponse);
      expect(h.az_deg, s.id).toEqual(az);
      expect(h.el_deg, s.id).toEqual(el);
      expect(h.covered_radius_km, s.id).toEqual(rad);
      expect(h.min_el_deg).toBe(Math.min(...el));
      expect(h.max_el_deg).toBe(Math.max(...el));
      expect(s.files.horizon).toContain(`horizon_${h.method}.csv`);
      const sky = await getJson(`${API}/sites/${s.id}/sky?max_points=64`, SkyResponse);
      expect(sky.horizon.az_deg).toEqual(az);
      expect(sky.horizon.el_deg).toEqual(el);
      counts.horizon_points += az.length;
    }
  });
});
