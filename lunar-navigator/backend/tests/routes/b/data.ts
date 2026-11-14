/**
 * Test data for route group B (series / instant / sky / windows / export), written straight into the
 * throw-away MongoDB with the document shapes of src/repos/types.ts (independent of the importer):
 *
 * - buildSyntheticRun(): a small hand-made run with KNOWN transitions (incl. a 1-sample dark blip and
 *   an elevation spike) -> always available, exact expectations.
 * - loadSampleRun(): the real sample precompute output (output/sample_2026Q1_spice_pgda, git-ignored)
 *   -> used for the cross-checks against the files and against Python lunarnav; skipped if absent.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import type { Db } from 'mongodb';
import { SERIES_FIELDS, BOOLEAN_SERIES_FIELDS, type SeriesFieldName } from '../../../src/contract/series.ts';
import { WINDOW_KINDS, type Metrics, type WindowKind } from '../../../src/contract/common.ts';
import { dataCollections } from '../../../src/repos/collections.ts';
import type { HorizonDoc, ManifestFile, RunDoc, SeriesDoc, SeriesSample, SiteDoc, SiteRunDoc, SummaryRow, WindowDoc, SiteRecordDoc } from '../../../src/repos/types.ts';
import { SUMMARY_COLUMNS, summaryColumnKind } from '../../../src/importer/schemas.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');
export { SAMPLE_DIR } from '../../sample.ts';
import { SAMPLE_DIR } from '../../sample.ts';
export const PYTHON_BIN = path.join(REPO_ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const hasSample = (): boolean => existsSync(path.join(SAMPLE_DIR, 'manifest.json'));
export const hasPython = (): boolean => existsSync(PYTHON_BIN);


const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// ---- generic helpers (an independent re-implementation of lunarnav.windows for the synthetic run) ----
export interface PlainWindow {
  start_index: number;
  end_index: number;
  state: boolean;
}

/** Maximal runs of equal state (lunarnav.windows.find_windows, by index). */
export function runsOf(flags: readonly boolean[]): PlainWindow[] {
  const out: PlainWindow[] = [];
  let s = 0;
  for (let i = 1; i <= flags.length; i++) {
    if (i === flags.length || flags[i] !== flags[s]) {
      out.push({ start_index: s, end_index: i, state: flags[s] === true });
      s = i;
    }
  }
  return out;
}

/** lunarnav.windows.hours_until_state: 0 where flags == target, else hours to the next window start; null if none. */
export function hoursUntilState(flags: readonly boolean[], target: boolean, stepS: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(flags.length).fill(null);
  for (const w of runsOf(flags)) {
    for (let i = w.start_index; i < w.end_index; i++) {
      if (w.state === target) out[i] = 0;
      else out[i] = w.end_index === flags.length ? null : ((w.end_index - i) * stepS) / 3600;
    }
  }
  return out;
}

function windowDocs(runId: string, siteId: string, kind: WindowKind, flags: readonly boolean[], t0: number, stepS: number): WindowDoc[] {
  const ws = runsOf(flags);
  return ws.map((w, j) => ({
    _id: `${runId}|${siteId}|${kind}|${w.start_index}`,
    run_id: runId,
    site_id: siteId,
    kind,
    state: w.state,
    start: new Date(t0 + w.start_index * stepS * 1000),
    end: new Date(t0 + w.end_index * stepS * 1000),
    duration_h: ((w.end_index - w.start_index) * stepS) / 3600,
    start_index: w.start_index,
    end_index: w.end_index,
    truncated_start: j === 0,
    truncated_end: j === ws.length - 1,
  }));
}

const ZERO_METRICS: Metrics = {
  duration_h: 0, pct_sun: 0, pct_earth: 0, pct_both: 0, pct_sun_no_earth: 0, longest_dark_h: 0, longest_dark_truncated: false,
  longest_comms_gap_h: 0, longest_comms_gap_truncated: false, longest_sun_h: 0, longest_sun_truncated: false, longest_earth_h: 0,
  longest_earth_truncated: false, n_sun_windows: 0, n_dark_windows: 0, n_earth_windows: 0, n_comms_gaps: 0, mean_sun_el_lit_deg: null,
  mean_power_horizontal: 0, mean_power_tracking: 0,
};

// =================================================================================================
// synthetic run
// =================================================================================================
export const SYN = {
  run_id: 'synth_run',
  site_id: 'synth_a',
  start: '2030-01-01T00:00:00Z',
  step_s: 3600,
  n: 600,
  /** sun dark at index 100 only (1-sample blip) and on [300, 450). */
  sunDark: (i: number) => i === 100 || (i >= 300 && i < 450),
  /** earth hidden on [50, 350). */
  earthHidden: (i: number) => i >= 50 && i < 350,
  /** sun_el spike (culmination) that a regular decimation would miss. */
  spikeIndex: 257,
} as const;

export interface SyntheticRun {
  run: RunDoc;
  t0: number;
  end: number;
  sun: boolean[];
  earth: boolean[];
  both: boolean[];
  samples: SeriesSample[];
  windows: Record<WindowKind, WindowDoc[]>;
  summary: SummaryRow;
  rawFile: { path: string; content: string };
}

function syntheticSample(i: number, sun: boolean, earth: boolean, hu: Record<string, number | null>): SeriesSample {
  const sunEl = i === SYN.spikeIndex ? 5 : 1.5 * Math.sin((2 * Math.PI * i) / 200);
  const frac = sun ? 1 : 0;
  const s: Record<string, number | boolean | null> = {
    sun_az_deg: (i * 0.5) % 360,
    sun_el_deg: Math.round(sunEl * 1e6) / 1e6 + 0,
    sun_dist_km: 147_000_000 + i,
    sun_semidiam_deg: 0.27,
    horizon_el_sun_deg: 0.25,
    sun_clearance_deg: Math.round((sunEl - 0.25) * 1e6) / 1e6 + 0,
    sun_fraction: frac,
    sun_visible: sun,
    power_horizontal: Math.round(frac * Math.max(0, Math.sin((sunEl * Math.PI) / 180)) * 1e6) / 1e6 + 0,
    power_tracking: frac,
    irradiance_tracking_wm2: frac * 1400,
    earth_az_deg: (120 + i * 0.1) % 360,
    earth_el_deg: earth ? 3 : -2,
    earth_dist_km: 380_000 + i,
    earth_semidiam_deg: 0.95,
    horizon_el_earth_deg: 0.5,
    earth_clearance_deg: earth ? 2.5 : -2.5,
    earth_fraction: earth ? 1 : 0,
    earth_visible: earth,
    both_visible: sun && earth,
    hours_until_sunset: hu['sunset'] ?? null,
    hours_until_sunrise: hu['sunrise'] ?? null,
    hours_until_earthset: hu['earthset'] ?? null,
    hours_until_earthrise: hu['earthrise'] ?? null,
  };
  return s as SeriesSample;
}

export async function buildSyntheticRun(db: Db, dataDir: string): Promise<SyntheticRun> {
  const { run_id, site_id, step_s, n } = SYN;
  const t0 = Date.parse(SYN.start);
  const end = t0 + n * step_s * 1000;
  const sun = Array.from({ length: n }, (_v, i) => !SYN.sunDark(i));
  const earth = Array.from({ length: n }, (_v, i) => !SYN.earthHidden(i));
  const both = sun.map((s, i) => s && earth[i] === true);
  const hu = {
    sunset: hoursUntilState(sun, false, step_s),
    sunrise: hoursUntilState(sun, true, step_s),
    earthset: hoursUntilState(earth, false, step_s),
    earthrise: hoursUntilState(earth, true, step_s),
  };
  const samples = Array.from({ length: n }, (_v, i) =>
    syntheticSample(i, sun[i] === true, earth[i] === true, {
      sunset: hu.sunset[i] ?? null, sunrise: hu.sunrise[i] ?? null, earthset: hu.earthset[i] ?? null, earthrise: hu.earthrise[i] ?? null,
    }),
  );
  const windows = {
    sun: windowDocs(run_id, site_id, 'sun', sun, t0, step_s),
    earth: windowDocs(run_id, site_id, 'earth', earth, t0, step_s),
    both: windowDocs(run_id, site_id, 'both', both, t0, step_s),
  };

  // a raw file on disk for the files route
  const runDir = path.join(dataDir, 'runs', run_id);
  const rel = `sites/${site_id}/windows.json`;
  const content = JSON.stringify({ site_id, note: 'synthetic' });
  await mkdir(path.join(runDir, 'sites', site_id), { recursive: true });
  await writeFile(path.join(runDir, ...rel.split('/')), content);
  const manifestText = JSON.stringify({ synthetic: true });
  await writeFile(path.join(runDir, 'manifest.json'), manifestText);

  const manifest = {
    format: 'lunarnav-precompute',
    format_version: 1,
    code_version: 'test',
    git_commit: null,
    run_timestamp_utc: '2030-01-01T00:00:00Z',
    params_fingerprint: '0123456789abcdef',
    parameters: {
      start_utc: SYN.start, end_utc: new Date(end).toISOString().replace('.000Z', 'Z'), step_s, n_samples: n, provider: 'synthetic', dem: 'none',
      horizon_method: 'flat', observer_height_m: 2, min_earth_clearance_deg: 0, rank_weights: { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 }, site_ids: [site_id],
    },
    data_sources: [],
    conventions: {},
    files: { [rel]: sha256(content), 'sites/synth_a/visibility.csv.gz': sha256('missing') },
  } as ManifestFile;

  const run: RunDoc = {
    _id: run_id, kind: 'precompute', is_default: true, label: 'synthetic', status: 'ready', error: null, manifest,
    manifest_sha256: sha256(manifestText), params_fingerprint: manifest.params_fingerprint, code_version: 'test', git_commit: null,
    run_timestamp_utc: manifest.run_timestamp_utc, provider: 'synthetic', dem: 'none', horizon_method: 'flat', start: new Date(t0), end: new Date(end),
    step_s, n_samples: n, observer_height_m: 2, min_earth_clearance_deg: 0, rank_weights: { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 },
    site_ids: [site_id], n_sites: 1, source_dir: runDir, started_at: new Date(), imported_at: new Date(), expires_at: null, stats: null,
  };
  const record: SiteRecordDoc = {
    id: site_id, name: 'Synthetic A', lat_deg: -89, lon_deg: 10, origin: 'catalog', group: 'test', source: null, note: null, height_m_input: null,
    surface_height_m: 1000, observer_height_m: 2, observer_height_above_sphere_m: 1002, horizon_method: 'flat', dem_source: 'none', horizon_radius_km: null,
    horizon_min_el_deg: -0.1, horizon_max_el_deg: 0.9,
  } as SiteRecordDoc;
  const summary: SummaryRow = {
    rank: 1, site_id, name: 'Synthetic A, "quoted"', group: 'test', lat_deg: -89, lon_deg: 10, surface_height_m: 1000, score: 50.5, pct_sun: 74.833333,
    pct_earth: 50, pct_both: 33.333333, pct_sun_no_earth: 41.5, longest_dark_h: 150, longest_dark_truncated: false, longest_comms_gap_h: 300,
    longest_comms_gap_truncated: false, longest_sun_h: 199, longest_earth_h: 250, n_sun_windows: 3, n_dark_windows: 2, n_earth_windows: 2,
    n_comms_gaps: 1, mean_sun_el_lit_deg: null, mean_power_horizontal: 0.01, mean_power_tracking: 0.748333, horizon_min_el_deg: -0.1, horizon_max_el_deg: 0.9,
  };
  const siteRun: SiteRunDoc = {
    _id: `${run_id}|${site_id}`, run_id, site_id, record, files: { horizon: 'h', ephemeris: 'e', visibility: 'v', windows: rel }, metrics: ZERO_METRICS,
    rank: 1, score: 50.5, summary, range_start: new Date(t0), range_end: new Date(end), n_samples: n, step_s, min_earth_clearance_deg: 0,
    n_windows: { sun: windows.sun.length, earth: windows.earth.length, both: windows.both.length },
  };
  const site: SiteDoc = {
    _id: site_id, name: record.name, group: 'test', origin: 'catalog', lat_deg: -89, lon_deg: 10, source: null, note: null, extra: null, map: null, updated_at: new Date(),
  };
  const az = Array.from({ length: 72 }, (_v, i) => i * 5);
  const horizon: HorizonDoc = {
    _id: `${run_id}|${site_id}`, run_id, site_id, method: 'flat', dem_source: 'none', az_step_deg: 5, az_deg: az,
    el_deg: az.map((a) => Math.round(Math.sin((a * Math.PI) / 180) * 1e6) / 1e6 + 0), covered_radius_km: az.map(() => 2.6), min_el_deg: -1, max_el_deg: 1,
  };

  const c = dataCollections(db);
  await c.runs.insertOne(run);
  await c.sites.insertOne(site);
  await c.site_runs.insertOne(siteRun);
  await c.horizons.insertOne(horizon);
  await c.windows.insertMany([...windows.sun, ...windows.earth, ...windows.both]);
  await c.series.insertMany(samples.map((s, i): SeriesDoc => ({ t: new Date(t0 + i * step_s * 1000), meta: { run_id, site_id }, ...s })));
  return { run, t0, end, sun, earth, both, samples, windows, summary, rawFile: { path: rel, content } };
}

// =================================================================================================
// real sample run
// =================================================================================================
export interface SampleSite {
  id: string;
  times: number[];
  /** Parsed visibility.csv.gz columns (CSV text kept too, for exact comparisons). */
  columns: Record<SeriesFieldName, (number | boolean | null)[]>;
  windowsJson: Record<WindowKind, { start: string; end: string; duration_h: number; state: boolean; truncated_start: boolean; truncated_end: boolean }[]>;
}
export interface SampleRun {
  run_id: string;
  run: RunDoc;
  sites: Map<string, SampleSite>;
  summaryText: string;
}

const parseCell = (field: SeriesFieldName, v: string): number | boolean | null =>
  BOOLEAN_SERIES_FIELDS.has(field) ? v === '1' : v === '' ? null : Number(v);

export async function loadSampleRun(db: Db, dir = SAMPLE_DIR): Promise<SampleRun> {
  const manifestText = await readFile(path.join(dir, 'manifest.json'));
  const manifest = JSON.parse(manifestText.toString('utf8')) as ManifestFile;
  const p = manifest.parameters;
  const run_id = `pf_${manifest.params_fingerprint}`;
  const sitesFile = JSON.parse(await readFile(path.join(dir, 'sites.json'), 'utf8')) as { sites: (SiteRecordDoc & { files: Record<string, string> })[] };
  const summaryText = await readFile(path.join(dir, 'summary.csv'), 'utf8');
  const summaryRows = (parse(summaryText, { columns: true }) as Record<string, string>[]).map((r) => {
    const o: Record<string, unknown> = {};
    for (const c of SUMMARY_COLUMNS) {
      const v = r[c] ?? '';
      const kind = summaryColumnKind(c);
      o[c] = kind === 'string' ? v : kind === 'bool' ? v === '1' : kind === 'nullable_number' && v === '' ? null : Number(v);
    }
    return o as unknown as SummaryRow;
  });
  const t0 = Date.parse(p.start_utc);
  const run: RunDoc = {
    _id: run_id, kind: 'precompute', is_default: true, label: 'sample', status: 'ready', error: null, manifest, manifest_sha256: sha256(manifestText),
    params_fingerprint: manifest.params_fingerprint, code_version: manifest.code_version, git_commit: manifest.git_commit, run_timestamp_utc: manifest.run_timestamp_utc,
    provider: p.provider, dem: p.dem, horizon_method: p.horizon_method, start: new Date(t0), end: new Date(Date.parse(p.end_utc)), step_s: p.step_s,
    n_samples: p.n_samples, observer_height_m: p.observer_height_m, min_earth_clearance_deg: p.min_earth_clearance_deg, rank_weights: p.rank_weights,
    site_ids: p.site_ids, n_sites: p.site_ids.length, source_dir: dir, started_at: new Date(), imported_at: new Date(), expires_at: null, stats: null,
  };
  const c = dataCollections(db);
  await c.runs.insertOne(run);
  const sites = new Map<string, SampleSite>();
  for (const rec of sitesFile.sites) {
    const { files, ...record } = rec;
    const csvText = gunzipSync(await readFile(path.join(dir, files['visibility'] ?? ''))).toString('utf8');
    const rows = parse(csvText, { columns: true }) as Record<string, string>[];
    const times = rows.map((r) => Date.parse(r['time_utc'] ?? ''));
    const columns = {} as SampleSite['columns'];
    for (const f of SERIES_FIELDS) columns[f] = rows.map((r) => parseCell(f, r[f] ?? ''));
    const wj = JSON.parse(await readFile(path.join(dir, files['windows'] ?? ''), 'utf8')) as SampleSite['windowsJson'] & { metrics: Metrics };
    const hz = parse(await readFile(path.join(dir, files['horizon'] ?? ''), 'utf8'), { columns: true }) as Record<string, string>[];
    const summary = summaryRows.find((s) => s.site_id === rec.id);
    if (!summary) throw new Error(`summary row missing for ${rec.id}`);
    await c.sites.insertOne({ _id: rec.id, name: rec.name, group: rec.group, origin: rec.origin, lat_deg: rec.lat_deg, lon_deg: rec.lon_deg, source: rec.source, note: rec.note, extra: null, map: null, updated_at: new Date() });
    await c.site_runs.insertOne({
      _id: `${run_id}|${rec.id}`, run_id, site_id: rec.id, record, files: files as SiteRunDoc['files'], metrics: wj.metrics, rank: summary.rank, score: summary.score, summary,
      range_start: run.start, range_end: run.end, n_samples: p.n_samples, step_s: p.step_s, min_earth_clearance_deg: p.min_earth_clearance_deg,
      n_windows: { sun: wj.sun.length, earth: wj.earth.length, both: wj.both.length },
    });
    const elv = hz.map((r) => Number(r['el_deg']));
    await c.horizons.insertOne({
      _id: `${run_id}|${rec.id}`, run_id, site_id: rec.id, method: rec.horizon_method, dem_source: rec.dem_source, az_step_deg: Number(hz[1]?.['az_deg'] ?? 0),
      az_deg: hz.map((r) => Number(r['az_deg'])), el_deg: elv, covered_radius_km: hz.map((r) => Number(r['covered_radius_km'])),
      min_el_deg: Math.min(...elv), max_el_deg: Math.max(...elv),
    });
    const wdocs: WindowDoc[] = [];
    for (const kind of WINDOW_KINDS) {
      for (const w of wj[kind] as (SampleSite['windowsJson']['sun'][number] & { start_index: number; end_index: number })[]) {
        wdocs.push({ _id: `${run_id}|${rec.id}|${kind}|${w.start_index}`, run_id, site_id: rec.id, kind, state: w.state, start: new Date(Date.parse(w.start)),
          end: new Date(Date.parse(w.end)), duration_h: w.duration_h, start_index: w.start_index, end_index: w.end_index, truncated_start: w.truncated_start, truncated_end: w.truncated_end });
      }
    }
    await c.windows.insertMany(wdocs);
    await c.series.insertMany(
      times.map((t, i): SeriesDoc => {
        const s = {} as SeriesSample;
        for (const f of SERIES_FIELDS) s[f] = columns[f][i] ?? null;
        return { t: new Date(t), meta: { run_id, site_id: rec.id }, ...s };
      }),
    );
    sites.set(rec.id, { id: rec.id, times, columns, windowsJson: wj });
  }
  return { run_id, run, sites, summaryText };
}

