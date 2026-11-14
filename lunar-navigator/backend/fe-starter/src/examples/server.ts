/**
 * Server Component / route handler usage: the same client; on the server API_ORIGIN = API_INTERNAL_URL
 * (absolute). Next.js caches nothing here by default - precomputed data is immutable per run_id, so
 * pages may use `export const revalidate = 3600`.
 */
import { api, unwrap } from '../lib/api/client';

export async function loadSiteCard(siteId: string, runId?: string) {
  return unwrap(
    api.GET('/api/v1/sites/{site_id}', {
      params: { path: { site_id: siteId }, query: runId ? { run_id: runId } : {} },
    }),
  );
}

/** Example: app/site/[site_id]/page.tsx -> `const card = await loadSiteCard(decodeURIComponent(params.site_id))`. */
export async function loadRanking(weights?: string) {
  return unwrap(api.GET('/api/v1/ranking', { params: { query: weights ? { weights } : {} } }));
}
