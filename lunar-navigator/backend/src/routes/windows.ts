/**
 * GET /api/v1/sites/{site_id}/windows (plan 6.2 #8) - contract: src/contract/windows.ts.
 * Data: `windows` collection (one doc per window = Python windows.json), clipped to the query range.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SiteParams, type ClippedWindow, type WindowKind } from '../contract/common.ts';
import { WindowsQuery, WindowsResponse } from '../contract/windows.ts';
import { problemResponses } from '../lib/problem.ts';
import { MS_PER_H, toIsoUtc } from '../lib/time.ts';
import { getWindows, resolveRun, type WindowDoc } from '../repos/index.ts';
import { requireSite, resolveRange, setCacheHeaders } from './series.ts';
import { provenanceOf } from '../lib/provenance.ts';

/**
 * Intersect windows with [startMs, endMs): keeps windows with start < end_q AND end > start_q,
 * clips their bounds, recomputes duration_h and flags clipped_start / clipped_end (query boundary),
 * keeping truncated_start / truncated_end (RUN boundary) as stored.
 */
export function clipWindowDocs(docs: readonly WindowDoc[], startMs: number, endMs: number): ClippedWindow[] {
  const out: ClippedWindow[] = [];
  for (const w of docs) {
    const ws = w.start.getTime();
    const we = w.end.getTime();
    if (!(ws < endMs && we > startMs)) continue;
    const s = Math.max(ws, startMs);
    const e = Math.min(we, endMs);
    out.push({
      start: toIsoUtc(s),
      end: toIsoUtc(e),
      duration_h: (e - s) / MS_PER_H,
      state: w.state,
      truncated_start: w.truncated_start,
      truncated_end: w.truncated_end,
      clipped_start: s > ws,
      clipped_end: e < we,
    });
  }
  return out;
}

/** Clipped windows of the requested kinds (only those keys present), each list sorted by start. */
export async function clippedWindowsByKind(
  runId: string,
  siteId: string,
  kinds: readonly WindowKind[],
  startMs: number,
  endMs: number,
): Promise<Partial<Record<WindowKind, ClippedWindow[]>>> {
  const byKind = await getWindows(runId, siteId, { fromMs: startMs, toMs: endMs, kinds });
  const out: Partial<Record<WindowKind, ClippedWindow[]>> = {};
  for (const k of kinds) out[k] = clipWindowDocs(byKind[k] ?? [], startMs, endMs);
  return out;
}

export const windowsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/sites/:site_id/windows',
    {
      schema: {
        tags: ['windows'],
        operationId: 'getSiteWindows',
        summary: 'Visibility windows (timeline bands) clipped to [start, end)',
        description:
          'Windows of each requested kind tile [start, end) without gaps (states alternate). Range partly outside the run -> clamped; ' +
          'no overlap -> 422 OUT_OF_RANGE. Boundaries are accurate to +- precision_h.',
        params: SiteParams,
        querystring: WindowsQuery,
        response: { 200: WindowsResponse, ...problemResponses(400, 404, 409, 422, 503) },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const siteId = req.params.site_id;
      const run = await resolveRun(q.run_id);
      const r = resolveRange(run, q.start, q.end);
      const kinds = [...new Set(q.kinds)];
      const [, byKind] = await Promise.all([requireSite(run._id, siteId), clippedWindowsByKind(run._id, siteId, kinds, r.startMs, r.endMs)]);
      setCacheHeaders(reply, q.run_id);
      return { ...provenanceOf(run), site_id: siteId, start: toIsoUtc(r.startMs), end: toIsoUtc(r.endMs), ...byKind };
    },
  );
};

export default windowsRoutes;
