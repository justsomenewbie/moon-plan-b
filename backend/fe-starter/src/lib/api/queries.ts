'use client';
/**
 * TanStack Query hooks (copy into the Next.js app; needs @tanstack/react-query 5 + a QueryClientProvider).
 * Pattern for any endpoint: queryKey = [operation, params]; queryFn = unwrap(api.GET(path, { params, signal })).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap, type ApiProblem, type Schemas } from './client';
import type { paths } from './schema';

type SitesQuery = NonNullable<paths['/api/v1/sites']['get']['parameters']['query']>;
type WindowsQuery = NonNullable<paths['/api/v1/sites/{site_id}/windows']['get']['parameters']['query']>;

/**
 * A run never changes once imported, so a query that NAMES its run (run_id set) can be cached for long.
 * Without run_id the API answers from the DEFAULT run, which changes when a new run is imported with
 * --default: cache that briefly (the API itself sends max-age=60 then, and 3600 with run_id).
 */
const IMMUTABLE = { staleTime: 60 * 60 * 1000, gcTime: 2 * 60 * 60 * 1000 } as const;
const DEFAULT_RUN = { staleTime: 60 * 1000, gcTime: 10 * 60 * 1000 } as const;
const cacheFor = (q: { run_id?: string | undefined }) => (q.run_id ? IMMUTABLE : DEFAULT_RUN);

export const queryKeys = {
  sites: (q: SitesQuery) => ['listSites', q] as const,
  windows: (siteId: string, q: WindowsQuery) => ['getSiteWindows', siteId, q] as const,
  job: (jobId: string) => ['getJob', jobId] as const,
};

/** Site list for the map + table. Pass `{ format: 'json' }` (default); GeoJSON: call api.GET with format 'geojson'. */
export function useSites(query: SitesQuery = {}) {
  return useQuery<Schemas['SitesResponse'], ApiProblem>({
    queryKey: queryKeys.sites(query),
    queryFn: ({ signal }) => unwrap(api.GET('/api/v1/sites', { params: { query: { ...query, format: 'json' } }, signal })) as Promise<Schemas['SitesResponse']>,
    ...cacheFor(query),
  });
}

/** Timeline bands of one site. `kinds` / `start` / `end` as in the API (kinds = 'sun,earth'). */
export function useSiteWindows(siteId: string | null, query: WindowsQuery = {}) {
  return useQuery<Schemas['WindowsResponse'], ApiProblem>({
    queryKey: queryKeys.windows(siteId ?? '', query),
    enabled: siteId !== null,
    queryFn: ({ signal }) =>
      unwrap(api.GET('/api/v1/sites/{site_id}/windows', { params: { path: { site_id: siteId ?? '' }, query }, signal })),
    ...cacheFor(query),
  });
}

// ---- custom-coordinate jobs: POST /jobs -> poll GET /jobs/{id} every 1.5 s until terminal --------------
const TERMINAL: ReadonlySet<Schemas['JobStatus']> = new Set(['succeeded', 'failed', 'cancelled']);
export const isTerminal = (s: Schemas['JobStatus'] | undefined): boolean => s !== undefined && TERMINAL.has(s);

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation<Schemas['JobAccepted'], ApiProblem, Schemas['CreateJobRequest']>({
    mutationFn: (body) => unwrap(api.POST('/api/v1/jobs', { body })),
    // 200 + cached:true = an identical job already succeeded -> useJob() returns it immediately.
    onSuccess: (accepted) => qc.invalidateQueries({ queryKey: queryKeys.job(accepted.job_id) }),
  });
}

/**
 * Poll a job. When `data.status === 'succeeded'`, use `data.result.run_id` + `data.result.site_id`
 * with the normal hooks/endpoints (sites/{site_id}, windows, series, ... with run_id).
 */
export function useJob(jobId: string | null) {
  return useQuery<Schemas['Job'], ApiProblem>({
    queryKey: queryKeys.job(jobId ?? ''),
    enabled: jobId !== null,
    queryFn: ({ signal }) => unwrap(api.GET('/api/v1/jobs/{job_id}', { params: { path: { job_id: jobId ?? '' } }, signal })),
    refetchInterval: (query) => (isTerminal(query.state.data?.status) || query.state.error ? false : 1500),
    refetchIntervalInBackground: false,
  });
}

/**
 * DELETE removes THIS client from the job. If another client POSTed the same parameters, the job keeps
 * running for them (returned status queued/running, `clients` > 0): treat it as cancelled in this UI
 * anyway and forget the job id (stop calling useJob for it). 403 JOB_NOT_YOURS = a job id you never submitted.
 */
export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation<Schemas['Job'], ApiProblem, string>({
    mutationFn: (jobId) => unwrap(api.DELETE('/api/v1/jobs/{job_id}', { params: { path: { job_id: jobId } } })),
    onSuccess: (job) => qc.setQueryData(queryKeys.job(job.job_id), job),
  });
}
