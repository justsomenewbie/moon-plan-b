/**
 * Job artifacts store (docs/PYTHON_INTEGRATION.md section 4): the files a job produced, served by
 *   GET /api/v1/jobs/{job_id}/artifacts          (list = JobDoc.artifacts)
 *   GET /api/v1/jobs/{job_id}/artifacts/{name}   (the file)
 *
 * Layout (DATA_DIR/jobs/<job_id>/ = the job dir = LUNARNAV_OUTPUT of the child):
 *   <type>.log            stdout/stderr of the Python process (never served: holds absolute paths)
 *   artifacts/<name>      what a job type wants to publish - FLAT names matching ARTIFACT_NAME_RE
 *   (anything else)       scratch of the job type (Python --out dirs, inputs...), never served
 *
 * A job type writes files into ctx.artifactsDir during/after the Python run; when the job succeeds the
 * runner calls collectArtifacts() which hashes them and stores the metadata on the job. The GET route
 * only serves names present in JobDoc.artifacts, so a request can never name an arbitrary path.
 * The whole job dir is deleted with the job (cleanup.ts: TTL of the job type).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { ARTIFACT_NAME_RE, type JobArtifact } from '../contract/job_types/common.ts';
import type { StoredArtifact } from './types.ts';

export const ARTIFACTS_DIRNAME = 'artifacts';

/** Defaults; a job type may lower / raise them with limits.artifacts. */
export const ARTIFACT_LIMITS = {
  max_files: 50,
  max_file_bytes: 100 * 1024 * 1024,
  max_total_bytes: 200 * 1024 * 1024,
} as const;
export type ArtifactLimits = { max_files: number; max_file_bytes: number; max_total_bytes: number };

/** Media type by extension; unknown -> application/octet-stream (served as attachment). */
const MEDIA_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
/** Types a browser may display inline (served with CSP sandbox + nosniff anyway). */
const INLINE = new Set(['.json', '.md', '.csv', '.txt', '.log', '.png', '.svg']);

export const mediaTypeOf = (name: string): string => MEDIA_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
export const isInline = (name: string): boolean => INLINE.has(path.extname(name).toLowerCase());
export const isArtifactName = (name: string): boolean => ARTIFACT_NAME_RE.test(name) && !name.includes('..');

export class ArtifactError extends Error {
  override name = 'ArtifactError';
}

export const artifactsDirOf = (jobDir: string): string => path.join(jobDir, ARTIFACTS_DIRNAME);

/** Absolute path of an artifact (throws ArtifactError for a bad name; never leaves the artifacts dir). */
export function artifactPath(jobDir: string, name: string): string {
  if (!isArtifactName(name)) throw new ArtifactError(`invalid artifact name ${JSON.stringify(name)}`);
  const dir = path.resolve(artifactsDirOf(jobDir));
  const abs = path.resolve(dir, name);
  if (path.dirname(abs) !== dir) throw new ArtifactError(`artifact ${JSON.stringify(name)} lies outside the artifacts directory`);
  return abs;
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Hash and list the top-level regular files of DATA_DIR/jobs/<id>/artifacts/ (sorted by name).
 * Symlinks, directories and names outside ARTIFACT_NAME_RE are skipped (returned in `skipped`).
 * Throws ArtifactError when the limits are exceeded. A missing directory = no artifacts.
 */
export async function collectArtifacts(
  jobDir: string,
  limits: ArtifactLimits = ARTIFACT_LIMITS,
): Promise<{ artifacts: StoredArtifact[]; skipped: string[] }> {
  const dir = artifactsDirOf(jobDir);
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return { artifacts: [], skipped: [] };
  }
  const artifacts: StoredArtifact[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const name of names) {
    const abs = path.join(dir, name);
    const st = await lstat(abs);
    if (!st.isFile() || !isArtifactName(name)) {
      skipped.push(name);
      continue;
    }
    if (artifacts.length >= limits.max_files) throw new ArtifactError(`more than ${limits.max_files} artifacts`);
    if (st.size > limits.max_file_bytes) throw new ArtifactError(`artifact ${name} is ${st.size} bytes (limit ${limits.max_file_bytes})`);
    total += st.size;
    if (total > limits.max_total_bytes) throw new ArtifactError(`artifacts exceed ${limits.max_total_bytes} bytes in total`);
    artifacts.push({ name, media_type: mediaTypeOf(name), bytes: st.size, sha256: await sha256File(abs) });
  }
  return { artifacts, skipped };
}

/** Relative URL of an artifact (prefix = app.prefix, e.g. /api/v1). */
export const artifactUrl = (prefix: string, jobId: string, name: string): string => `${prefix}/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`;

export const toApiArtifacts = (prefix: string, jobId: string, list: readonly StoredArtifact[] | undefined): JobArtifact[] =>
  (list ?? []).map((a) => ({ ...a, url: artifactUrl(prefix, jobId, a.name) }));

// ---- helpers for job types ----------------------------------------------------------------------------
/** Write a JSON artifact (pretty, UTF-8). Returns its absolute path. */
export async function writeJsonArtifact(jobDir: string, name: string, value: unknown): Promise<string> {
  const abs = artifactPath(jobDir, name);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
  return abs;
}

/**
 * Read + zod-validate a JSON file Python wrote (never trust Python output: plan 7.1).
 * Throws ArtifactError (missing / too big / not JSON / schema mismatch) with a short reason.
 */
export async function readJsonFile<S extends z.ZodType>(file: string, schema: S, maxBytes = 32 * 1024 * 1024): Promise<z.output<S>> {
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile()) throw new ArtifactError(`${path.basename(file)} was not written`);
  if (st.size > maxBytes) throw new ArtifactError(`${path.basename(file)} is ${st.size} bytes (limit ${maxBytes})`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new ArtifactError(`${path.basename(file)} is not JSON: ${(e as Error).message}`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new ArtifactError(`${path.basename(file)} does not match its schema: ${first ? `${first.path.join('.')}: ${first.message}` : 'invalid'}`);
  }
  return r.data;
}
