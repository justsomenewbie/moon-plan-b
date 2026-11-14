/**
 * Facts about the lunarnav installation the bridge talks to (read from LUNARNAV_ROOT, no Python needed),
 * plus a cached `checkPython()` probe for GET /health.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.ts';
import { runPython } from './process.ts';

type PyConfig = Pick<Config, 'PYTHON_BIN' | 'LUNARNAV_ROOT'>;

/** Directory with lunarnav's shared data (SPICE kernels, DEM tiles, caches) = env LUNARNAV_DATA of the children. */
export function lunarnavDataDir(cfg: Pick<Config, 'LUNARNAV_ROOT'>): string {
  const fromEnv = process.env['LUNARNAV_DATA'];
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(cfg.LUNARNAV_ROOT, 'data');
}

/** `__version__` of LUNARNAV_ROOT/lunarnav/__init__.py, or "unknown". */
export async function lunarnavCodeVersion(cfg: Pick<Config, 'LUNARNAV_ROOT'>): Promise<string> {
  try {
    const src = await readFile(path.join(cfg.LUNARNAV_ROOT, 'lunarnav', '__init__.py'), 'utf8');
    return /^__version__\s*=\s*["']([^"']+)["']/m.exec(src)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** lunarnav/catalog/sites.json of the installation. */
export const lunarnavCatalogPath = (cfg: Pick<Config, 'LUNARNAV_ROOT'>): string => path.join(cfg.LUNARNAV_ROOT, 'lunarnav', 'catalog', 'sites.json');

/** Catalog site ids (lunarnav/catalog/sites.json), or null when the catalog file is not readable. */
export async function lunarnavCatalogIds(cfg: Pick<Config, 'LUNARNAV_ROOT'>): Promise<Set<string> | null> {
  try {
    const doc: unknown = JSON.parse(await readFile(lunarnavCatalogPath(cfg), 'utf8'));
    if (typeof doc !== 'object' || doc === null || !('sites' in doc) || !Array.isArray(doc.sites)) return null;
    const ids = new Set<string>();
    for (const s of doc.sites as unknown[]) {
      if (typeof s === 'object' && s !== null && 'id' in s && typeof s.id === 'string') ids.add(s.id);
    }
    return ids;
  } catch {
    return null;
  }
}

export interface PythonCheck {
  ok: boolean;
  python_version: string | null;
  lunarnav_version: string | null;
  latency_ms: number;
  error: string | null;
}

const CHECK_TTL_MS = 60_000;
let cached: { key: string; at: number; value: PythonCheck } | null = null;

/** Start the interpreter and import lunarnav (cached 60 s). Never throws. */
export async function checkPython(cfg: PyConfig, opts: { force?: boolean } = {}): Promise<PythonCheck> {
  const key = `${cfg.PYTHON_BIN}|${cfg.LUNARNAV_ROOT}`;
  if (!opts.force && cached && cached.key === key && Date.now() - cached.at < CHECK_TTL_MS) return cached.value;
  const r = await runPython({
    bin: cfg.PYTHON_BIN,
    args: ['-c', 'import sys, lunarnav; print(sys.version.split()[0]); print(lunarnav.__version__)'],
    cwd: cfg.LUNARNAV_ROOT,
    timeoutMs: 20_000,
    captureStdout: true,
  });
  const [py, ln] = r.stdout.split('\n').map((s) => s.trim());
  const ok = r.exitCode === 0 && !!py && !!ln;
  const value: PythonCheck = {
    ok,
    python_version: ok ? (py ?? null) : null,
    lunarnav_version: ok ? (ln ?? null) : null,
    latency_ms: r.durationMs,
    error: ok ? null : (r.spawnError ?? (r.timedOut ? 'timed out' : (r.stderrTail.at(-1) ?? `exit code ${String(r.exitCode)}`))),
  };
  cached = { key, at: Date.now(), value };
  return value;
}
