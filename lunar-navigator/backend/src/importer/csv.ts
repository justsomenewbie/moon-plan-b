/**
 * Streaming CSV reading for the importer: `*.csv` or `*.csv.gz` (node:zlib) -> csv-parse -> records
 * of raw strings, plus strict cell coercion following docs/OUTPUT_SPEC.md section 1:
 * numbers in plain decimal / exponent notation, booleans `1` / `0`, empty field = missing (null),
 * never `nan` / `inf`.
 */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';

export class CsvFormatError extends Error {
  override name = 'CsvFormatError';
}

/**
 * Every record of a CSV file in order - the FIRST one is the header. Gunzips when the name ends
 * in `.gz`. Rows with a different column count than the header are an error (csv-parse).
 */
export async function* csvRecords(file: string): AsyncGenerator<string[]> {
  const raw = createReadStream(file);
  const input: Readable = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const parser = parse({ columns: false, relax_column_count: false, skip_empty_lines: true, bom: true });
  raw.on('error', (e) => parser.destroy(e));
  if (input !== raw) input.on('error', (e) => parser.destroy(e));
  input.pipe(parser);
  let any = false;
  try {
    for await (const rec of parser as AsyncIterable<string[]>) {
      any = true;
      yield rec;
    }
  } finally {
    raw.destroy();
  }
  if (!any) throw new CsvFormatError(`${file}: empty file (no header)`);
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Decimal text -> the nearest double (same as Python float()); '' -> null. */
export function parseNumberCell(s: string, where: string): number | null {
  if (s === '') return null;
  if (!NUMBER_RE.test(s)) throw new CsvFormatError(`${where}: not a finite number: ${JSON.stringify(s)}`);
  return Number(s);
}

/** Like parseNumberCell but the value is mandatory. */
export function parseRequiredNumber(s: string, where: string): number {
  const v = parseNumberCell(s, where);
  if (v === null) throw new CsvFormatError(`${where}: empty value`);
  return v;
}

/** `1` -> true, `0` -> false (OUTPUT_SPEC: booleans are 1/0 in CSV); anything else is an error. */
export function parseBoolCell(s: string, where: string): boolean {
  if (s === '1') return true;
  if (s === '0') return false;
  throw new CsvFormatError(`${where}: expected boolean 1/0, got ${JSON.stringify(s)}`);
}

/** Read a small CSV completely: header + rows as objects keyed by column name. */
export async function readCsvObjects(file: string): Promise<{ header: string[]; rows: Record<string, string>[] }> {
  let header: string[] | null = null;
  const rows: Record<string, string>[] = [];
  for await (const rec of csvRecords(file)) {
    if (header === null) {
      header = rec;
      continue;
    }
    const o: Record<string, string> = {};
    header.forEach((h, i) => {
      o[h] = rec[i] ?? '';
    });
    rows.push(o);
  }
  return { header: header ?? [], rows };
}

/** Throw unless `header` has exactly the `expected` columns (any order); returns column -> index. */
export function columnIndex(header: readonly string[], expected: readonly string[], where: string): Map<string, number> {
  const idx = new Map<string, number>();
  header.forEach((h, i) => idx.set(h, i));
  const missing = expected.filter((c) => !idx.has(c));
  const unknown = header.filter((h) => !expected.includes(h));
  if (missing.length > 0 || unknown.length > 0 || idx.size !== header.length) {
    throw new CsvFormatError(
      `${where}: unexpected columns (missing: [${missing.join(', ')}], unknown: [${unknown.join(', ')}]${idx.size !== header.length ? ', duplicates' : ''})`,
    );
  }
  return idx;
}
