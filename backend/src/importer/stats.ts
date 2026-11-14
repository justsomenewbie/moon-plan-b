/**
 * Storage measurements of the data collections ($collStats storageStats + dbStats), used by the
 * import CLI (--stats) to report on-disk sizes. For the time-series `series` collection the
 * numbers come from its internal buckets collection (system.buckets.series).
 */
import type { Db, Document } from 'mongodb';
import { COLLECTIONS } from '../db.ts';

export interface CollectionSize {
  name: string;
  count: number;
  /** Uncompressed BSON bytes (buckets for time-series). */
  size: number;
  /** Bytes on disk (WiredTiger, compressed). */
  storageSize: number;
  totalIndexSize: number;
}

export interface DbSizes {
  collections: CollectionSize[];
  db: { name: string; dataSize: number; storageSize: number; indexSize: number };
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

export async function collectionSize(db: Db, name: string): Promise<CollectionSize> {
  const rows = await db.collection(name).aggregate<{ storageStats?: Document }>([{ $collStats: { storageStats: {} } }]).toArray();
  const s = rows[0]?.storageStats ?? {};
  const count = await db.collection(name).estimatedDocumentCount();
  const exact = name === COLLECTIONS.series ? await db.collection(name).countDocuments({}) : count;
  return { name, count: exact, size: num(s['size']), storageSize: num(s['storageSize']), totalIndexSize: num(s['totalIndexSize']) };
}

export async function collectionSizes(db: Db): Promise<DbSizes> {
  const names = [COLLECTIONS.runs, COLLECTIONS.sites, COLLECTIONS.site_runs, COLLECTIONS.horizons, COLLECTIONS.windows, COLLECTIONS.series];
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const collections: CollectionSize[] = [];
  for (const n of names) if (existing.has(n)) collections.push(await collectionSize(db, n));
  const st = await db.command({ dbStats: 1 });
  return { collections, db: { name: db.databaseName, dataSize: num(st['dataSize']), storageSize: num(st['storageSize']), indexSize: num(st['indexSize']) } };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}
