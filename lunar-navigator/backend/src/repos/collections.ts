/**
 * Collections + indexes of the imported data (plan 5.3 / 5.4), typed accessors.
 *
 * The same specs are also registered by the route files (runs.ts, sites.ts, series.ts, windows.ts);
 * db.ts merges registrations by index name, so the importer CLI (which does not load the routes)
 * gets the identical collections from this module alone.
 */
import type { Collection, Db } from 'mongodb';
import { COLLECTIONS, ensureIndexes, getDb, registerCollection } from '../db.ts';
import type { HorizonDoc, RunDoc, SeriesDoc, SiteDoc, SiteRunDoc, WindowDoc } from './types.ts';

const owner = 'repos/collections.ts';

/** Time-series options of `series` (must equal routes/series.ts). */
export const SERIES_TIMESERIES = { timeField: 't', metaField: 'meta', granularity: 'hours' } as const;

/** Secondary index used by every series query (equality on run + site, range on t). */
export const SERIES_QUERY_INDEX = 'meta.run_id_1_meta.site_id_1_t_1';

registerCollection({
  name: COLLECTIONS.runs,
  owner,
  indexes: [
    { key: { is_default: 1 }, name: 'is_default_1' },
    { key: { kind: 1, imported_at: -1 }, name: 'kind_1_imported_at_-1' },
  ],
});
registerCollection({
  name: COLLECTIONS.sites,
  owner,
  indexes: [
    { key: { group: 1 }, name: 'group_1' },
    { key: { origin: 1 }, name: 'origin_1' },
  ],
});
registerCollection({
  name: COLLECTIONS.site_runs,
  owner,
  indexes: [
    { key: { run_id: 1, site_id: 1 }, name: 'run_id_1_site_id_1', unique: true },
    { key: { run_id: 1, rank: 1 }, name: 'run_id_1_rank_1' },
  ],
});
registerCollection({
  name: COLLECTIONS.horizons,
  owner,
  indexes: [{ key: { run_id: 1, site_id: 1 }, name: 'run_id_1_site_id_1', unique: true }],
});
registerCollection({
  name: COLLECTIONS.windows,
  owner,
  indexes: [{ key: { run_id: 1, site_id: 1, kind: 1, start: 1 }, name: 'run_id_1_site_id_1_kind_1_start_1' }],
});
registerCollection({
  name: COLLECTIONS.series,
  owner,
  timeseries: { ...SERIES_TIMESERIES },
  indexes: [{ key: { 'meta.run_id': 1, 'meta.site_id': 1, t: 1 }, name: SERIES_QUERY_INDEX }],
});

export interface DataCollections {
  runs: Collection<RunDoc>;
  sites: Collection<SiteDoc>;
  site_runs: Collection<SiteRunDoc>;
  horizons: Collection<HorizonDoc>;
  windows: Collection<WindowDoc>;
  series: Collection<SeriesDoc>;
}

/** Typed collections of `db` (default: the connected singleton from db.ts). */
export function dataCollections(db: Db = getDb()): DataCollections {
  return {
    runs: db.collection<RunDoc>(COLLECTIONS.runs),
    sites: db.collection<SiteDoc>(COLLECTIONS.sites),
    site_runs: db.collection<SiteRunDoc>(COLLECTIONS.site_runs),
    horizons: db.collection<HorizonDoc>(COLLECTIONS.horizons),
    windows: db.collection<WindowDoc>(COLLECTIONS.windows),
    series: db.collection<SeriesDoc>(COLLECTIONS.series),
  };
}

/** Create every registered collection/index (series as time-series). Idempotent. */
export async function ensureDataCollections(db: Db): Promise<void> {
  await ensureIndexes(db);
}

export const siteRunId = (runId: string, siteId: string): string => `${runId}|${siteId}`;
export const windowDocId = (runId: string, siteId: string, kind: string, startIndex: number): string => `${runId}|${siteId}|${kind}|${startIndex}`;
