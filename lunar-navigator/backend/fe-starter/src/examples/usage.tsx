'use client';
/**
 * Usage sketch (not a full app): provider, a site table and the job flow. Server-side fetch: ./server.ts
 * Every number shown comes with its unit / precision (see docs/FE_INTEGRATION.md "assumptions to display").
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiProblem } from '../lib/api/client';
import { useCreateJob, useJob, useSites } from '../lib/api/queries';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 4xx are final (bad id, bad range); retry only network / 5xx / 429.
            retry: (count, err) => !(err instanceof ApiProblem && err.status < 500 && err.status !== 429) && count < 2,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function SiteTable({ runId }: { runId?: string }) {
  const { data, error, isPending } = useSites(runId ? { run_id: runId } : {});
  if (isPending) return <p>Loading...</p>;
  if (error) return <p role="alert">{error.code === 'RUN_NOT_FOUND' ? 'This run no longer exists.' : error.message}</p>;
  return (
    <table>
      <caption>
        Run {data.run_id} - times UTC, boundaries +-{data.precision_h} h
      </caption>
      <thead>
        <tr>
          <th>#</th>
          <th>Site</th>
          <th>Sun %</th>
          <th>Earth %</th>
          <th>Longest night (h)</th>
        </tr>
      </thead>
      <tbody>
        {data.sites.map((s) => (
          <tr key={s.id}>
            <td>{s.rank}</td>
            <td>
              {s.name}
              {s.dem_source.startsWith('none:') ? ' (smooth-sphere horizon)' : ''}
            </td>
            <td>{s.pct_sun.toFixed(1)}</td>
            <td>{s.pct_earth.toFixed(1)}</td>
            <td>{s.longest_dark_h}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CustomSiteJob() {
  const create = useCreateJob();
  const job = useJob(create.data?.job_id ?? null);
  const start = () =>
    create.mutate({
      type: 'custom_site',
      lat_deg: -89.45,
      lon_deg: 222.69,
      start: '2026-01-01T00:00:00Z',
      end: '2026-02-01T00:00:00Z',
    });
  if (create.error) return <p role="alert">{create.error.code === 'QUEUE_FULL' ? 'Server busy, try again later.' : create.error.message}</p>;
  if (!create.data) return <button onClick={start}>Compute this location</button>;
  const j = job.data;
  if (!j || j.status === 'queued' || j.status === 'running') return <p>Computing... {j?.progress.lines.at(-1) ?? ''}</p>;
  if (j.status === 'succeeded' && j.result) return <p>Done: open site {j.result.site_id} with run_id={j.result.run_id}</p>;
  return <p role="alert">Job {j.status}: {j.error?.message ?? ''}</p>;
}
