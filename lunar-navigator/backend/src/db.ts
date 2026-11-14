/**
 * MongoDB access: one MongoClient per process + an index/collection registry.
 *
 * - `connectDb(uri, dbName)` once at startup (buildApp does it), `getDb()` anywhere afterwards.
 * - Modules declare the collections/indexes they own with `registerCollection({...})` at module
 *   top level (e.g. in their route file); `ensureIndexes(db)` creates them idempotently at startup.
 * - Collection names are the constants in `COLLECTIONS` (plan section 5.3) - never inline strings.
 */
import { MongoClient, type Db, type Document, type Collection, type IndexDescription, type TimeSeriesCollectionOptions } from 'mongodb';
import { ApiError } from './lib/problem.ts';

export const COLLECTIONS = {
  runs: 'runs',
  sites: 'sites',
  site_runs: 'site_runs',
  horizons: 'horizons',
  windows: 'windows',
  series: 'series',
  jobs: 'jobs',
  cache: 'cache',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export interface CollectionSpec {
  name: CollectionName;
  /** Create as a time-series collection (must be created before the first insert). */
  timeseries?: TimeSeriesCollectionOptions;
  indexes?: IndexDescription[];
  /** Module that registered it (for error messages). */
  owner: string;
}

const registry = new Map<CollectionName, CollectionSpec>();

/** Register (or extend) the spec of a collection. Indexes with the same name are de-duplicated. */
export function registerCollection(spec: CollectionSpec): void {
  const prev = registry.get(spec.name);
  if (!prev) {
    registry.set(spec.name, { ...spec, indexes: [...(spec.indexes ?? [])] });
    return;
  }
  if (spec.timeseries && prev.timeseries && JSON.stringify(spec.timeseries) !== JSON.stringify(prev.timeseries)) {
    throw new Error(`collection ${spec.name}: conflicting timeseries options from ${prev.owner} and ${spec.owner}`);
  }
  const indexes = [...(prev.indexes ?? [])];
  for (const ix of spec.indexes ?? []) {
    if (!indexes.some((p) => p.name !== undefined && p.name === ix.name)) indexes.push(ix);
  }
  registry.set(spec.name, { ...prev, timeseries: prev.timeseries ?? spec.timeseries, indexes });
}

export function registeredCollections(): CollectionSpec[] {
  return [...registry.values()];
}

/** Create registered collections (time-series ones with their options) and indexes. Idempotent. */
export async function ensureIndexes(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const spec of registry.values()) {
    if (!existing.has(spec.name)) {
      await db.createCollection(spec.name, spec.timeseries ? { timeseries: spec.timeseries } : {});
    }
    if (spec.indexes && spec.indexes.length > 0) {
      await db.collection(spec.name).createIndexes(spec.indexes);
    }
  }
}

// ---- client singleton ----------------------------------------------------------------------------
let client: MongoClient | null = null;
let database: Db | null = null;

export async function connectDb(uri: string, dbName: string): Promise<Db> {
  if (database) return database;
  const c = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, appName: 'lunarnav-backend' });
  await c.connect();
  client = c;
  database = c.db(dbName);
  return database;
}

export function isDbConnected(): boolean {
  return database !== null;
}

/** The connected Db; throws a 503 problem when the server runs without a database. */
export function getDb(): Db {
  if (!database) throw new ApiError('SERVICE_UNAVAILABLE', 'MongoDB is not connected');
  return database;
}

/** Typed collection accessor: `collection<RunDoc>(COLLECTIONS.runs)`. */
export function collection<T extends Document>(name: CollectionName): Collection<T> {
  return getDb().collection<T>(name);
}

/** Round-trip ping; returns latency in ms or null when not connected / failing. */
export async function pingDb(): Promise<number | null> {
  if (!database) return null;
  const t0 = performance.now();
  try {
    await database.command({ ping: 1 });
    return Math.round((performance.now() - t0) * 10) / 10;
  } catch {
    return null;
  }
}

export async function closeDb(): Promise<void> {
  const c = client;
  client = null;
  database = null;
  if (c) await c.close();
}
