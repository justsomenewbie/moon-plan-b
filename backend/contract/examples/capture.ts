/**
 * Capture REAL example responses of the API into backend/contract/examples/ (FE handoff kit).
 *
 *   node contract/examples/capture.ts                      in-process app, dev MongoDB (the sample run must be imported)
 *   node contract/examples/capture.ts --db none            in-process, never touch MongoDB
 *   node contract/examples/capture.ts --base-url http://127.0.0.1:3000   capture from a running server instead
 *   node contract/examples/capture.ts --check              exit 1 if a stored example differs (volatile ones skipped)
 *
 * Output: one file per case, body only (`<name>.json`, `.csv`, `.txt`) - usable as MSW / test fixtures -
 * plus `index.json` (request, status, content-type, interesting headers) for every case.
 * Ids and dates come from the real sample run (tests/fixtures/sample_2026Q1_spice_pgda = output/sample_2026Q1_spice_pgda:
 * 6 sites, 2026-01-01..2026-04-01). With --base-url the server must have that run imported as its default run.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp, type App } from '../../src/app.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..', '..');
const SAMPLE_DIR = path.resolve(process.env['LUNARNAV_SAMPLE_DIR'] ?? path.join(BACKEND, 'tests', 'fixtures', 'sample_2026Q1_spice_pgda'));

const RUN_ID = 'pf_21c3f3f6dc56b1e1';
const SITE = 'ref_connecting_ridge_c1';
/** Replaced by the job_id that POST /jobs returned. */
const JOB_ID = '{job_id}';
/** A raw file of the sample run (listed in its manifest) - note the %2F encoding in the URL. */
const RUN_FILE = 'sites/apollo11/windows.json';
const KEPT_HEADERS = ['content-type', 'location', 'x-lunarnav-cache', 'etag', 'cache-control', 'content-disposition', 'retry-after', 'x-ratelimit-limit'];

interface CaseDef {
  /** File base name (also the key in index.json). */
  name: string;
  operation_id: string;
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Values change on every run (clock, latency) -> not compared by --check. */
  volatile?: boolean;
  /** Do not store the body (binary / huge); index.json still records status + headers. */
  body_file?: false;
  note?: string;
}

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface IndexEntry {
  name: string;
  operation_id: string;
  request: { method: string; url: string; body?: unknown; headers?: Record<string, string> };
  status: number;
  content_type: string | null;
  headers: Record<string, string>;
  file: string | null;
  note?: string;
}

const enc = encodeURIComponent;

const CASES: CaseDef[] = [
  { name: 'health', operation_id: 'getHealth', method: 'GET', url: '/api/v1/health', volatile: true },
  { name: 'meta', operation_id: 'getMeta', method: 'GET', url: '/api/v1/meta' },
  { name: 'runs', operation_id: 'listRuns', method: 'GET', url: '/api/v1/runs' },
  { name: 'run_detail', operation_id: 'getRun', method: 'GET', url: `/api/v1/runs/${RUN_ID}` },
  { name: 'sites', operation_id: 'listSites', method: 'GET', url: '/api/v1/sites' },
  { name: 'sites_south_pole', operation_id: 'listSites', method: 'GET', url: '/api/v1/sites?group=south_pole' },
  { name: 'sites_geojson', operation_id: 'listSites', method: 'GET', url: '/api/v1/sites?format=geojson' },
  { name: 'site_detail', operation_id: 'getSite', method: 'GET', url: `/api/v1/sites/${SITE}` },
  { name: 'site_detail_apollo11', operation_id: 'getSite', method: 'GET', url: '/api/v1/sites/apollo11', note: 'smooth-sphere horizon -> warnings[]' },
  { name: 'horizon', operation_id: 'getSiteHorizon', method: 'GET', url: `/api/v1/sites/${SITE}/horizon` },
  {
    name: 'series_week',
    operation_id: 'getSiteSeries',
    method: 'GET',
    url: `/api/v1/sites/${SITE}/series?start=2026-03-01T00:00:00Z&end=2026-03-08T00:00:00Z&fields=sun_el_deg,earth_el_deg,sun_visible,earth_visible`,
  },
  {
    name: 'series_minmax',
    operation_id: 'getSiteSeries',
    method: 'GET',
    url: `/api/v1/sites/${SITE}/series?fields=sun_el_deg,power_tracking,sun_visible&max_points=90&agg=minmax`,
    note: 'full run (2160 samples) downsampled to <= 90 bins',
  },
  { name: 'instant', operation_id: 'getSiteInstant', method: 'GET', url: `/api/v1/sites/${SITE}/instant?t=2026-03-14T05:30:00Z` },
  {
    name: 'sky',
    operation_id: 'getSiteSky',
    method: 'GET',
    url: `/api/v1/sites/${SITE}/sky?start=2026-03-01T00:00:00Z&end=2026-03-03T00:00:00Z&max_points=16`,
    note: 'sky diagram: decimated Sun/Earth az-el tracks (transitions kept) + full horizon silhouette',
  },
  { name: 'runs_ready', operation_id: 'listRuns', method: 'GET', url: '/api/v1/runs?status=ready&limit=10' },
  { name: 'windows', operation_id: 'getSiteWindows', method: 'GET', url: `/api/v1/sites/${SITE}/windows` },
  {
    name: 'windows_march_sun_earth',
    operation_id: 'getSiteWindows',
    method: 'GET',
    url: `/api/v1/sites/${SITE}/windows?start=2026-03-01T00:00:00Z&end=2026-04-01T00:00:00Z&kinds=sun,earth`,
  },
  { name: 'ranking', operation_id: 'getRanking', method: 'GET', url: '/api/v1/ranking' },
  {
    name: 'ranking_custom_weights',
    operation_id: 'getRanking',
    method: 'GET',
    url: '/api/v1/ranking?group=south_pole&weights=pct_sun:0.7,pct_both:0.3',
  },
  {
    name: 'compare',
    operation_id: 'compareSites',
    method: 'POST',
    url: '/api/v1/compare',
    body: {
      site_ids: [SITE, 'a3_haworth', 'apollo11'],
      start: '2026-01-01T00:00:00Z',
      end: '2026-04-01T00:00:00Z',
      weights: { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 },
      include: { windows: ['sun'], series: { fields: ['sun_el_deg'], max_points: 24 } },
    },
  },
  {
    name: 'alt_dates',
    operation_id: 'findAltDates',
    method: 'POST',
    url: '/api/v1/alt-dates',
    body: {
      site_id: SITE,
      earliest: '2026-01-05T00:00:00Z',
      latest: '2026-02-20T00:00:00Z',
      mission_h: 336,
      max_results: 3,
      constraints: { min_sun_pct: 70, require_sun_at_landing: true, require_earth_at_landing: true, objective: 'balanced' },
    },
  },
  {
    name: 'job_accepted',
    operation_id: 'createJob',
    method: 'POST',
    url: '/api/v1/jobs',
    body: { type: 'custom_site', lat_deg: -89.45, lon_deg: 222.69, name: 'My ridge', start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' },
    volatile: true,
    note: 'starts a REAL Python job on a real server; the capture cancels it right after (job_cancelled)',
  },
  { name: 'job', operation_id: 'getJob', method: 'GET', url: `/api/v1/jobs/${JOB_ID}`, volatile: true, note: 'polled right after POST: queued or running' },
  { name: 'job_cancelled', operation_id: 'cancelJob', method: 'DELETE', url: `/api/v1/jobs/${JOB_ID}`, volatile: true },
  {
    name: 'job_events',
    operation_id: 'streamJobEvents',
    method: 'GET',
    url: `/api/v1/jobs/${JOB_ID}/events`,
    volatile: true,
    note: 'after the cancel: one terminal event, then the stream ends',
  },
  {
    name: 'export_series',
    operation_id: 'exportSiteSeriesCsv',
    method: 'GET',
    url: `/api/v1/sites/${SITE}/export/series.csv?start=2026-03-01T00:00:00Z&end=2026-03-01T06:00:00Z&fields=sun_el_deg,earth_el_deg,sun_visible`,
  },
  { name: 'export_windows', operation_id: 'exportSiteWindowsCsv', method: 'GET', url: `/api/v1/sites/${SITE}/export/windows.csv?kinds=sun` },
  { name: 'export_summary', operation_id: 'exportSummaryCsv', method: 'GET', url: '/api/v1/export/summary.csv' },
  {
    name: 'run_file',
    operation_id: 'getRunFile',
    method: 'GET',
    url: `/api/v1/runs/${RUN_ID}/files/${enc(RUN_FILE)}`,
    body_file: false,
    note: 'raw file download; ETag = sha256 from the manifest (body not stored)',
  },
  // ---- errors (application/problem+json) ----
  { name: 'error_site_not_found', operation_id: 'getSite', method: 'GET', url: `/api/v1/sites/${enc('custom:-89.4500:222.6900')}` },
  { name: 'error_run_not_found', operation_id: 'listSites', method: 'GET', url: '/api/v1/sites?run_id=pf_0000000000000000' },
  { name: 'error_validation', operation_id: 'getSiteSeries', method: 'GET', url: `/api/v1/sites/${SITE}/series?start=2026-03-01&fields=sun_el_deg,bogus` },
  { name: 'error_too_many_points', operation_id: 'getSiteSeries', method: 'GET', url: `/api/v1/sites/${SITE}/series?max_points=9999` },
  { name: 'error_unknown_param', operation_id: 'getSiteWindows', method: 'GET', url: `/api/v1/sites/${SITE}/windows?kind=sun`, note: 'strict query: unknown parameter' },
  {
    name: 'error_compare_body',
    operation_id: 'compareSites',
    method: 'POST',
    url: '/api/v1/compare',
    body: { site_ids: [SITE] },
  },
  { name: 'error_job_not_found', operation_id: 'getJob', method: 'GET', url: '/api/v1/jobs/j_doesnotexist0' },
  { name: 'error_route_not_found', operation_id: '(none)', method: 'GET', url: '/api/v1/site' },
];

/** Same request twice against an app with RATE_LIMIT_POST_MAX=1 -> the 2nd answer is 429. */
const RATE_LIMIT_CASE: CaseDef = {
  name: 'error_rate_limited',
  operation_id: 'findAltDates',
  method: 'POST',
  url: '/api/v1/alt-dates',
  body: CASES.find((c) => c.name === 'alt_dates')?.body,
  volatile: true,
  note: 'second POST within a minute with RATE_LIMIT_POST_MAX=1 (default limit is 5/min/IP)',
};

type Sender = (c: CaseDef) => Promise<Captured>;

function injectSender(app: App): Sender {
  return async (c) => {
    const res = await app.inject({
      method: c.method,
      url: c.url,
      headers: { ...(c.body === undefined ? {} : { 'content-type': 'application/json' }), ...c.headers },
      ...(c.body === undefined ? {} : { payload: JSON.stringify(c.body) }),
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    return { status: res.statusCode, headers, body: res.body };
  };
}

function fetchSender(baseUrl: string): Sender {
  return async (c) => {
    const res = await fetch(new URL(c.url, baseUrl), {
      method: c.method,
      headers: { 'accept-encoding': 'identity', ...(c.body === undefined ? {} : { 'content-type': 'application/json' }), ...c.headers },
      ...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, body: await res.text() };
  };
}

function fileFor(c: CaseDef, contentType: string | null): string | null {
  if (c.body_file === false) return null;
  if (contentType?.startsWith('text/csv')) return `${c.name}.csv`;
  if (contentType?.startsWith('text/event-stream')) return `${c.name}.txt`;
  return `${c.name}.json`;
}

function render(file: string, body: string): string {
  if (!file.endsWith('.json')) return body;
  return `${JSON.stringify(JSON.parse(body) as unknown, null, 2)}\n`;
}

/** Keys whose values legitimately change between captures (re-import time, opaque cache key): ignored by --check. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set(['imported_at', 'cache_id']);

/** --check comparison form: LF line endings; for JSON, volatile keys blanked at any depth. */
function comparable(file: string, text: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  if (!file.endsWith('.json')) return lf;
  return JSON.stringify(JSON.parse(lf) as unknown, (key: string, value: unknown) => (VOLATILE_KEYS.has(key) ? null : value));
}

async function prepareDataDir(): Promise<string> {
  // The raw-file route serves DATA_DIR/runs/<run_id>/<path>: give it one real file of the sample run.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-examples-'));
  const src = path.join(SAMPLE_DIR, ...RUN_FILE.split('/'));
  if (await stat(src).catch(() => null)) {
    const dst = path.join(dir, 'runs', RUN_ID, ...RUN_FILE.split('/'));
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(src, dst);
  } else {
    console.warn(`(sample run not found at ${SAMPLE_DIR}: run_file will be a 404)`);
  }
  return dir;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      db: { type: 'string', default: 'optional' },
      check: { type: 'boolean', default: false },
      out: { type: 'string', default: HERE },
    },
  });
  const outDir = path.resolve(values.out);
  const dbMode = values.db === 'none' || values.db === 'required' ? values.db : 'optional';

  let send: Sender;
  const cleanups: (() => Promise<void>)[] = [];
  let rateLimitSend: Sender | null = null;
  if (values['base-url']) {
    send = fetchSender(values['base-url']);
  } else {
    const dataDir = await prepareDataDir();
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    // Default rate limits (300/min, POST 5/min) so meta.json and the x-ratelimit-* headers show real values;
    // the ~40 requests below stay under them (2 rate-limited POSTs).
    const common = { NODE_ENV: 'development' as const, LOG_LEVEL: 'silent' as const, DATA_DIR: dataDir, COMPRESS: false };
    const app = await buildApp({ db: dbMode, logger: false, config: { ...common, RATE_LIMIT_MAX: 300, RATE_LIMIT_POST_MAX: 5 } });
    await app.ready();
    cleanups.push(() => app.close());
    send = injectSender(app);
    // Second app without MongoDB (the client is a process singleton; 'none' leaves it alone).
    const limited = await buildApp({ db: 'none', logger: false, config: { ...common, RATE_LIMIT_POST_MAX: 1 } });
    await limited.ready();
    cleanups.push(() => limited.close());
    rateLimitSend = injectSender(limited);
  }

  const index: IndexEntry[] = [];
  const diffs: string[] = [];
  let jobId = 'j_none';
  const run = async (template: CaseDef, sender: Sender): Promise<void> => {
    const c: CaseDef = { ...template, url: template.url.replaceAll(JOB_ID, jobId) };
    const r = await sender(c);
    if (c.operation_id === 'createJob' && r.status < 300) {
      const id: unknown = (JSON.parse(r.body) as { job_id?: unknown }).job_id;
      if (typeof id === 'string') jobId = id;
    }
    const contentType = r.headers['content-type'] ?? null;
    const file = fileFor(c, contentType);
    const headers: Record<string, string> = {};
    for (const h of KEPT_HEADERS) if (r.headers[h] !== undefined) headers[h] = r.headers[h];
    const entry: IndexEntry = {
      name: c.name,
      operation_id: c.operation_id,
      request: { method: c.method, url: c.url, ...(c.body === undefined ? {} : { body: c.body }), ...(c.headers ? { headers: c.headers } : {}) },
      status: r.status,
      content_type: contentType,
      headers,
      file,
      ...(c.note ? { note: c.note } : {}),
    };
    index.push(entry);
    console.log(`${String(r.status).padEnd(4)}${c.method.padEnd(7)}${c.url}  -> ${file ?? '(index only)'}`);
    if (file === null) return;
    const text = render(file, r.body);
    const target = path.join(outDir, file);
    if (values.check) {
      if (c.volatile) return;
      const old = await readFile(target, 'utf8').catch(() => null);
      if (old === null || comparable(file, old) !== comparable(file, text)) diffs.push(file);
    } else {
      await writeFile(target, text, 'utf8');
    }
  };

  try {
    if (!values.check) await mkdir(outDir, { recursive: true });
    for (const c of CASES) await run(c, send);
    if (rateLimitSend) {
      await rateLimitSend(RATE_LIMIT_CASE);
      await run(RATE_LIMIT_CASE, rateLimitSend);
    } else {
      // live server (POST limit RATE_LIMIT_POST_MAX per minute and IP): repeat until the limiter answers 429
      for (let k = 0; k < 20; k++) {
        const r = await send(RATE_LIMIT_CASE);
        if (r.status === 429) {
          await run(RATE_LIMIT_CASE, async () => r);
          break;
        }
      }
    }
    // ETag round trip: If-None-Match with the ETag just returned -> 304.
    const fileEntry = index.find((e) => e.name === 'run_file');
    const etag = fileEntry?.headers['etag'];
    if (etag) {
      await run(
        { name: 'run_file_not_modified', operation_id: 'getRunFile', method: 'GET', url: fileEntry.request.url, headers: { 'if-none-match': etag }, body_file: false, note: 'If-None-Match = previous ETag -> 304' },
        send,
      );
    }
  } finally {
    for (const f of cleanups.reverse()) await f();
  }

  const indexText = `${JSON.stringify(
    {
      description: 'Real responses captured by contract/examples/capture.ts from the 2026-Q1 sample run (6 sites).',
      run_id: RUN_ID,
      source: values['base-url'] ?? 'in-process app.inject()',
      cases: index,
    },
    null,
    2,
  )}\n`;
  if (values.check) {
    if (diffs.length > 0) {
      console.error(`examples out of date: ${diffs.join(', ')} - run: node contract/examples/capture.ts`);
      process.exitCode = 1;
    } else {
      console.log('examples up to date');
    }
    return;
  }
  await writeFile(path.join(outDir, 'index.json'), indexText, 'utf8');
  console.log(`wrote ${index.length} cases to ${path.relative(BACKEND, outDir) || '.'}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
