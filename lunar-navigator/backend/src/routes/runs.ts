/**
 * GET /api/v1/runs, GET /api/v1/runs/{run_id} - contract: src/contract/runs.ts (plan 6.2 #3).
 * Reads the `runs` collection written by the importer (repos/index.ts).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { RunDetail, RunParams, RunsQuery, RunsResponse, type RunSummary } from '../contract/runs.ts';
import { RANK_METRICS, type RankWeights } from '../contract/common.ts';
import { problemResponses, runNotFound } from '../lib/problem.ts';
import { toIsoUtc } from '../lib/time.ts';
import { getDefaultRunId, getRun, listRuns, type RunDoc } from '../repos/index.ts';
import { CACHE_SHORT, applyCache, notModified, notModifiedResponse, weakEtag } from './a/http_cache.ts';

/** Only the rank metrics known to the API (RankWeights is a strict object). */
export function apiRankWeights(w: Record<string, number>): RankWeights {
  const out: RankWeights = {};
  for (const k of RANK_METRICS) {
    const v = w[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const isoOrNull = (d: Date | null): string | null => (d ? toIsoUtc(d) : null);

export function runSummary(r: RunDoc, defaultRunId: string | null): RunSummary {
  return {
    run_id: r._id,
    kind: r.kind,
    // is_default reports the run actually used without run_id (flagged, or latest ready precompute run)
    is_default: r._id === defaultRunId,
    label: r.label,
    status: r.status,
    imported_at: isoOrNull(r.imported_at),
    expires_at: isoOrNull(r.expires_at),
    params_fingerprint: r.params_fingerprint,
    code_version: r.code_version,
    git_commit: r.git_commit,
    run_timestamp_utc: r.run_timestamp_utc,
    provider: r.provider,
    dem: r.dem,
    horizon_method: r.horizon_method,
    start_utc: toIsoUtc(r.start),
    end_utc: toIsoUtc(r.end),
    step_s: r.step_s,
    n_samples: r.n_samples,
    observer_height_m: r.observer_height_m,
    min_earth_clearance_deg: r.min_earth_clearance_deg,
    rank_weights: apiRankWeights(r.rank_weights),
    site_ids: r.site_ids,
    n_sites: r.n_sites,
  };
}

export function runDetail(r: RunDoc, defaultRunId: string | null): RunDetail {
  const m = r.manifest;
  return {
    ...runSummary(r, defaultRunId),
    manifest: {
      format: m.format,
      format_version: m.format_version,
      parameters: m.parameters,
      data_sources: m.data_sources.map((d) => ({ ...d, url: d.url ?? null, sha256: d.sha256 ?? null })),
      conventions: m.conventions,
      files: Object.entries(m.files)
        .map(([path, sha256]) => ({ path, sha256 }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    },
  };
}

/** Identity of a run's imported content (changes on re-import / status change). */
export const runVersion = (r: RunDoc): string => `${r._id}|${r.manifest_sha256}|${r.status}|${r.imported_at?.getTime() ?? ''}`;

export const runsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/runs',
    {
      schema: {
        tags: ['runs'],
        operationId: 'listRuns',
        summary: 'List imported runs (run picker)',
        description: 'Default run first, then most recently imported first; paginated with limit/offset.',
        querystring: RunsQuery,
        response: { 200: RunsResponse, ...notModifiedResponse, ...problemResponses(400) },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const [all, defaultRunId] = await Promise.all([
        listRuns({ ...(q.kind ? { kind: q.kind } : {}), ...(q.status ? { status: q.status } : {}) }),
        getDefaultRunId(),
      ]);
      // the effective default first (getDefaultRunId may pick an unflagged run)
      const ordered = [...all.filter((r) => r._id === defaultRunId), ...all.filter((r) => r._id !== defaultRunId)];
      const page = ordered.slice(q.offset, q.offset + q.limit);
      const etag = weakEtag('runs', req.url, String(defaultRunId), ...ordered.map(runVersion));
      if (applyCache(req, reply, etag, CACHE_SHORT)) return notModified(reply);
      return {
        default_run_id: defaultRunId,
        total: ordered.length,
        limit: q.limit,
        offset: q.offset,
        runs: page.map((r) => runSummary(r, defaultRunId)),
      };
    },
  );

  app.get(
    '/runs/:run_id',
    {
      schema: {
        tags: ['runs'],
        operationId: 'getRun',
        summary: 'One run with its manifest ("about the data")',
        description: 'Any status (importing / failed runs too: data routes answer 409 RUN_NOT_READY for them).',
        params: RunParams,
        response: { 200: RunDetail, ...notModifiedResponse, ...problemResponses(400, 404) },
      },
    },
    async (req, reply) => {
      const [run, defaultRunId] = await Promise.all([getRun(req.params.run_id), getDefaultRunId()]);
      if (!run) throw runNotFound(req.params.run_id);
      const etag = weakEtag('run', runVersion(run), String(defaultRunId === run._id));
      // short max-age: is_default / status of a run can change; the ETag makes revalidation cheap
      if (applyCache(req, reply, etag, run.status === 'ready' ? CACHE_SHORT : 'no-cache')) return notModified(reply);
      return runDetail(run, defaultRunId);
    },
  );
};

export default runsRoutes;
