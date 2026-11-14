/**
 * Multi-site analysis (plan 6.2 #10, #11) - contract: src/contract/analysis.ts.
 *   POST /api/v1/compare, GET /api/v1/ranking
 *
 * Exactness vs Python (lunarnav):
 * - full run + the run's rank weights -> GET /ranking serves summary.csv verbatim (source=summary);
 * - other weights -> lunarnav.analysis.rank_sites re-implemented on the stored metrics (a/ranking.ts);
 * - sub-ranges -> metrics recomputed like lunarnav.windows.compute_metrics (a/metrics.ts).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CompareRequest, CompareResponse, RankingQuery, RankingResponse } from '../contract/analysis.ts';
import type { RankWeights, RankingRow } from '../contract/common.ts';
import type { SeriesBlock } from '../contract/series.ts';
import type { z } from 'zod';
import { problemResponses, siteNotFound } from '../lib/problem.ts';
import { toIsoUtc } from '../lib/time.ts';
import { chooseBinS, getSeries, getSites, getSummary, getWindows, listSites, resolveRun, type RunDoc, type SeriesColumns } from '../repos/index.ts';
import { applyCache, cacheControlFor, notModified, notModifiedResponse, weakEtag } from './a/http_cache.ts';
import { metricsForRange } from './a/range_metrics.ts';
import { clipByKind, resolveRange, timeRange } from './a/range.ts';
import { normalizeWeights, rankSites, rankingRow, sameWeights } from './a/ranking.ts';
import { apiRankWeights, runVersion } from './runs.ts';
import { recordOf, siteWarnings } from './sites.ts';
import { provenanceOf } from '../lib/provenance.ts';

type SeriesBlockT = z.output<typeof SeriesBlock>;

/** repos columns -> contract SeriesBlock (values are already number | boolean | null per field). */
function seriesBlock(c: SeriesColumns): SeriesBlockT {
  return {
    start: toIsoUtc(c.start_ms),
    end: toIsoUtc(c.end_ms),
    step_s: c.step_s,
    bin_s: c.bin_s,
    n: c.n,
    agg: c.agg,
    fields: c.fields as SeriesBlockT['fields'],
  };
}

/** summary.csv applies verbatim: whole run and the weights the precompute ranked with. */
const summaryApplies = (run: RunDoc, full: boolean, weights: RankWeights): boolean => full && sameWeights(weights, apiRankWeights(run.rank_weights));

export const analysisRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/compare',
    {
      schema: {
        tags: ['analysis'],
        operationId: 'compareSites',
        summary: 'Compare 2-4 sites over a date range',
        description:
          'Full run -> metrics verbatim from the precompute (same numbers as Python); sub-range -> recomputed exactly like lunarnav.windows.compute_metrics. ' +
          'ranking ranks only the compared sites (rank 1..N among them).',
        body: CompareRequest,
        response: { 200: CompareResponse, ...problemResponses(400, 404, 409, 413, 415, 422) },
      },
    },
    async (req) => {
      const body = req.body;
      const run = await resolveRun(body.run_id);
      const views = await getSites(run._id, body.site_ids);
      if (views.length !== body.site_ids.length) {
        const found = new Set(views.map((v) => v.site_run.site_id));
        throw siteNotFound(body.site_ids.find((id) => !found.has(id)) ?? '');
      }
      const range = resolveRange(run, body.start, body.end, 'body');
      const weights = normalizeWeights(body.weights);
      const metrics = await metricsForRange(run, views, range);
      const inputs = views.map((v) => {
        const m = metrics.get(v.site_run.site_id);
        if (!m) throw new Error(`metrics missing for ${v.site_run.site_id}`);
        return { site_id: v.site_run.site_id, name: recordOf(v.site_run).name, group: recordOf(v.site_run).group, metrics: m };
      });
      const include = body.include;
      const sites: CompareResponse['sites'] = {};
      await Promise.all(
        inputs.map(async (inp, k) => {
          const view = views[k];
          if (!view) return;
          const entry: CompareResponse['sites'][string] = { metrics: inp.metrics, warnings: siteWarnings(recordOf(view.site_run)) };
          if (include?.windows) {
            const w = await getWindows(run._id, inp.site_id, { fromMs: range.startMs, toMs: range.endMs, kinds: include.windows });
            entry.windows = clipByKind(w, include.windows, range.startMs, range.endMs);
          }
          if (include?.series) {
            const s = include.series;
            const binS = chooseBinS(range.n, run.step_s, s.max_points);
            entry.series = seriesBlock(await getSeries(inp.site_id, run, range.startMs, range.endMs, s.fields, { bin_s: binS, agg: s.agg }));
          }
          sites[inp.site_id] = entry;
        }),
      );
      // keep the request order of site_ids in the record
      const ordered: CompareResponse['sites'] = {};
      for (const id of body.site_ids) {
        const e = sites[id];
        if (e) ordered[id] = e;
      }
      return { ...provenanceOf(run), range: timeRange(range, run.step_s), weights, ranking: rankSites(inputs, weights), sites: ordered };
    },
  );

  app.get(
    '/ranking',
    {
      schema: {
        tags: ['analysis'],
        operationId: 'getRanking',
        summary: 'Ranking table of all sites',
        description:
          'source=summary: full range + the run\'s rank weights (default 0.4/0.3/0.3) -> summary.csv values verbatim; otherwise recomputed (source=computed) ' +
          'with lunarnav\'s scoring and tie-break (shorter longest_dark_h, then site_id). With `group`, only that group is listed and rank is the position in this table.',
        querystring: RankingQuery,
        response: { 200: RankingResponse, ...notModifiedResponse, ...problemResponses(400, 404, 409, 422) },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const run = await resolveRun(q.run_id);
      const range = resolveRange(run, q.start, q.end, 'querystring');
      const weights = normalizeWeights(q.weights);
      if (applyCache(req, reply, weakEtag('ranking', runVersion(run), req.url), cacheControlFor(q.run_id))) return notModified(reply);
      const groupOpt = q.group === undefined ? {} : { group: q.group };
      const head = { ...provenanceOf(run), range: timeRange(range, run.step_s), weights };

      if (summaryApplies(run, range.full, weights)) {
        const rows = await getSummary(run._id, groupOpt);
        const ranking: RankingRow[] = rows.map((r, i) => rankingRow(i + 1, r.score, { site_id: r.site_id, name: r.name, group: r.group, metrics: r }));
        return { ...head, source: 'summary' as const, ranking };
      }
      const views = await listSites(run._id, groupOpt);
      const metrics = await metricsForRange(run, views, range);
      const inputs = views.map((v) => {
        const m = metrics.get(v.site_run.site_id);
        if (!m) throw new Error(`metrics missing for ${v.site_run.site_id}`);
        return { site_id: v.site_run.site_id, name: recordOf(v.site_run).name, group: recordOf(v.site_run).group, metrics: m };
      });
      return { ...head, source: 'computed' as const, ranking: rankSites(inputs, weights) };
    },
  );
};

export default analysisRoutes;
