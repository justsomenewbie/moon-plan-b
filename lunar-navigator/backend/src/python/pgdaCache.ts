/**
 * Budget of the PGDA tile cache (LUNARNAV_DATA/cache/pgda/<product>/*.npz) that lunarnav fills when a job or
 * tool reads PGDA blocks over /vsicurl/ that are not cached yet. lunarnav itself never limits or evicts it,
 * and every new custom coordinate can pull new ~0.85 MB blocks (a full product is 2.6-4.8 GB), so:
 *
 *   - download budget: the cache growth measured around every PGDA job / tool call is summed per UTC day;
 *     once PGDA_DOWNLOAD_MAX_MB_PER_DAY is used, NEW dem-pgda work answers 429 QUOTA_EXCEEDED until 00:00 UTC
 *     (checkPgdaBudget, at POST time). Concurrent PGDA runs may count a block twice: conservative.
 *   - size cap: after each PGDA job / tool call the cache is trimmed to PGDA_CACHE_MAX_MB, oldest-used block
 *     first (max(atime, mtime)); blocks used in the last EVICT_MIN_AGE_MS are never removed (a running
 *     Python may be reading them). Only `*.npz` files directly inside a product directory are deleted.
 *
 * The counter is per process (a restart resets the day's budget). 0 disables either limit.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.ts';
import { ApiError } from '../lib/problem.ts';
import { lunarnavDataDir } from './lunarnav.ts';

export type PgdaBudgetConfig = Pick<Config, 'LUNARNAV_ROOT'> & Partial<Pick<Config, 'PGDA_DOWNLOAD_MAX_MB_PER_DAY' | 'PGDA_CACHE_MAX_MB'>>;

export const EVICT_MIN_AGE_MS = 10 * 60_000;
const MB = 1024 * 1024;
const DAY_MS = 86_400_000;

export const pgdaCacheDir = (cfg: Pick<Config, 'LUNARNAV_ROOT'>): string => path.join(lunarnavDataDir(cfg), 'cache', 'pgda');

interface BlockFile {
  path: string;
  bytes: number;
  usedMs: number;
}

/** Every cached block (`<cache>/<product>/*.npz`) with its size and last use. */
export async function listPgdaBlocks(dir: string): Promise<BlockFile[]> {
  let products: string[];
  try {
    products = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: BlockFile[] = [];
  for (const p of products) {
    let names: string[];
    try {
      names = await readdir(path.join(dir, p));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.npz')) continue;
      const full = path.join(dir, p, n);
      const st = await stat(full).catch(() => null);
      if (st?.isFile()) out.push({ path: full, bytes: st.size, usedMs: Math.max(st.atimeMs, st.mtimeMs) });
    }
  }
  return out;
}

export async function pgdaCacheBytes(dir: string): Promise<number> {
  return (await listPgdaBlocks(dir)).reduce((s, b) => s + b.bytes, 0);
}

/** Remove the oldest-used blocks until the cache holds at most maxBytes (blocks used recently are kept). */
export async function trimPgdaCache(dir: string, maxBytes: number, now: number = Date.now()): Promise<{ removed: number; bytes_removed: number; bytes_left: number }> {
  const blocks = await listPgdaBlocks(dir);
  let total = blocks.reduce((s, b) => s + b.bytes, 0);
  let removed = 0;
  let bytesRemoved = 0;
  if (total <= maxBytes) return { removed, bytes_removed: 0, bytes_left: total };
  blocks.sort((a, b) => a.usedMs - b.usedMs);
  for (const b of blocks) {
    if (total <= maxBytes) break;
    if (now - b.usedMs < EVICT_MIN_AGE_MS) break; // sorted: every later block is newer still
    try {
      await rm(b.path, { force: true });
      total -= b.bytes;
      bytesRemoved += b.bytes;
      removed += 1;
    } catch {
      // in use (Windows) / already gone: skip it
    }
  }
  return { removed, bytes_removed: bytesRemoved, bytes_left: total };
}

const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);

class PgdaBudget {
  private day = utcDay(Date.now());
  private grown = 0;

  private roll(now: number): void {
    const d = utcDay(now);
    if (d !== this.day) {
      this.day = d;
      this.grown = 0;
    }
  }

  downloadedToday(now: number = Date.now()): number {
    this.roll(now);
    return this.grown;
  }

  add(bytes: number, now: number = Date.now()): void {
    this.roll(now);
    if (bytes > 0) this.grown += bytes;
  }

  reset(): void {
    this.day = utcDay(Date.now());
    this.grown = 0;
  }
}

const budgets = new Map<string, PgdaBudget>();
function budgetOf(dir: string): PgdaBudget {
  const key = path.resolve(dir);
  let b = budgets.get(key);
  if (!b) {
    b = new PgdaBudget();
    budgets.set(key, b);
  }
  return b;
}

/** Bytes of new PGDA blocks counted today (UTC) for this cache. */
export function pgdaDownloadedToday(cfg: PgdaBudgetConfig): number {
  return budgetOf(pgdaCacheDir(cfg)).downloadedToday();
}

/** 429 QUOTA_EXCEEDED when today's PGDA download budget is used up (call before queueing dem-pgda work). */
export function checkPgdaBudget(cfg: PgdaBudgetConfig, now: number = Date.now()): void {
  const maxMb = cfg.PGDA_DOWNLOAD_MAX_MB_PER_DAY ?? 0;
  if (maxMb <= 0) return;
  const used = budgetOf(pgdaCacheDir(cfg)).downloadedToday(now);
  if (used < maxMb * MB) return;
  const retryS = Math.max(60, Math.ceil(((utcDay(now) + 1) * DAY_MS - now) / 1000));
  throw new ApiError('QUOTA_EXCEEDED', `today's PGDA download budget (${maxMb} MB of new DEM tiles) is used up; dem pgda work resumes at 00:00 UTC`, {
    headers: { 'retry-after': String(retryS) },
    hint: 'use dem none, or a site / area whose PGDA tiles are already cached, or retry tomorrow',
    extensions: { quota: 'pgda_download_mb_per_day', limit_mb: maxMb, used_mb: Math.round((used / MB) * 10) / 10 },
  });
}

/**
 * Run `fn` (a Python call that may read PGDA), count the cache growth into today's budget, then trim the
 * cache to PGDA_CACHE_MAX_MB. Never throws for budget bookkeeping; `fn`'s own result / error is passed on.
 */
export async function trackPgda<T>(cfg: PgdaBudgetConfig, fn: () => Promise<T>, onError?: (err: unknown) => void): Promise<T> {
  const dir = pgdaCacheDir(cfg);
  const before = await pgdaCacheBytes(dir).catch(() => null);
  try {
    return await fn();
  } finally {
    try {
      const after = await pgdaCacheBytes(dir);
      if (before !== null) budgetOf(dir).add(after - before);
      const maxMb = cfg.PGDA_CACHE_MAX_MB ?? 0;
      if (maxMb > 0 && after > maxMb * MB) await trimPgdaCache(dir, maxMb * MB);
    } catch (err) {
      onError?.(err);
    }
  }
}

/** Test seam. */
export function resetPgdaBudgets(): void {
  for (const b of budgets.values()) b.reset();
  budgets.clear();
}
