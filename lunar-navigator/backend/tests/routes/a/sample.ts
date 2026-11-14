/**
 * Test data of group A: the real sample precompute run (git-ignored, tests skip without it) and the
 * lunarnav reference numbers (fixtures/reference.json, committed, made by make_reference.py).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import type { Metrics, RankWeights } from '../../../src/contract/common.ts';
import { SummaryRow } from '../../../src/importer/schemas.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.resolve(here, '..', '..', '..');
export { SAMPLE_DIR } from '../../sample.ts';
import { SAMPLE_DIR } from '../../sample.ts';
export const CATALOG_PATH = path.resolve(BACKEND_DIR, '..', 'lunarnav', 'catalog', 'sites.json');

export interface ReferenceRange {
  start: string;
  end: string;
  metrics: Record<string, Metrics>;
  rankings: { weights: RankWeights; rows: { rank: number; site_id: string; score: number }[] }[];
}
export const REFERENCE = JSON.parse(readFileSync(path.join(here, 'fixtures', 'reference.json'), 'utf8')) as { run_dir: string; ranges: ReferenceRange[] };

const BOOL = new Set(['longest_dark_truncated', 'longest_comms_gap_truncated']);
const STR = new Set(['site_id', 'name', 'group']);

/** summary.csv of the sample run, typed with Python's semantics (independent of the importer's reader). */
export function summaryRows(): SummaryRow[] {
  const raw = parse(readFileSync(path.join(SAMPLE_DIR, 'summary.csv'), 'utf8'), { columns: true }) as Record<string, string>[];
  return raw.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = STR.has(k) ? v : BOOL.has(k) ? v === '1' : v === '' ? null : Number(v);
    return SummaryRow.parse(o);
  });
}

export function windowsJson(siteId: string): { metrics: Metrics } {
  return JSON.parse(readFileSync(path.join(SAMPLE_DIR, 'sites', siteId, 'windows.json'), 'utf8')) as { metrics: Metrics };
}

export function horizonCsv(siteId: string, method: string): { az: number[]; el: number[] } {
  const rows = parse(readFileSync(path.join(SAMPLE_DIR, 'sites', siteId, `horizon_${method}.csv`), 'utf8'), { columns: true }) as Record<string, string>[];
  return { az: rows.map((r) => Number(r['az_deg'])), el: rows.map((r) => Number(r['el_deg'])) };
}
