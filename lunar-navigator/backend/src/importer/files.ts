/**
 * Filesystem helpers of the importer: safe relative paths, sha256, JSON reading, copying a run
 * directory into DATA_DIR/runs/<run_id>/.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';

export class ImportInputError extends Error {
  override name = 'ImportInputError';
}

/**
 * Resolve a manifest/sites.json relative path (always '/'-separated) inside `root`; rejects absolute
 * paths and `..` escapes (a crafted manifest must not make the importer read outside the run).
 */
export function resolveInside(root: string, rel: string): string {
  if (rel.length === 0 || path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((p) => p === '..' || p === '')) {
    throw new ImportInputError(`unsafe relative path in run files: ${JSON.stringify(rel)}`);
  }
  const abs = path.resolve(root, ...rel.split('/'));
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new ImportInputError(`path escapes the run directory: ${rel}`);
  return abs;
}

export const sha256Hex = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');

/** Streaming sha256 of a file (lowercase hex). */
export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Read + JSON.parse + zod-validate a file; errors name the file and the offending path. */
export async function readJsonFile<T extends z.ZodType>(file: string, schema: T): Promise<z.output<T>> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new ImportInputError(`${file}: cannot read JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    const lines = r.error.issues.slice(0, 10).map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ImportInputError(`${file}: invalid content\n${lines.join('\n')}`);
  }
  return r.data;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Total size in bytes of the given files. */
export async function totalSize(files: readonly string[]): Promise<number> {
  let n = 0;
  for (const f of files) n += (await stat(f)).size;
  return n;
}

/** Copy directory `src` to `dest`, replacing whatever `dest` held. */
export async function copyRunDir(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true, errorOnExist: false, force: true, preserveTimestamps: true });
}
