/**
 * Async Python jobs (plan 6.2 #13, #14; plan 7.2; docs/PYTHON_INTEGRATION.md) - contract: src/contract/jobs.ts,
 * engine: src/jobs/runner.ts (p-queue + execa'd Python + job-type registry src/jobs/types/ + artifacts store).
 *   POST /api/v1/jobs, GET /api/v1/jobs/{job_id}, DELETE /api/v1/jobs/{job_id}, GET /api/v1/jobs/{job_id}/events,
 *   GET /api/v1/jobs/{job_id}/artifacts, GET /api/v1/jobs/{job_id}/artifacts/{name}
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CreateJobRequest, Job, JobAccepted, JobArtifactParams, JobArtifactsResponse, JobParams } from '../contract/jobs.ts';
import { exampleJobCached } from '../fixtures/index.ts';
import { requestClientKey } from '../lib/client.ts';
import { registerResponseExample } from '../lib/openapi.ts';
import { ApiError, problemResponses } from '../lib/problem.ts';
import { COLLECTIONS, isDbConnected, registerCollection } from '../db.ts';
import { artifactPath, isInline, toApiArtifacts } from '../jobs/artifacts.ts';
import { JobRunner, jobSiteId, toApiJob } from '../jobs/runner.ts';
import { etagMatches } from './a/http_cache.ts';
import { isTerminal, type JobDoc } from '../jobs/types.ts';
import { JobWatchers } from '../jobs/watch.ts';

registerCollection({
  name: COLLECTIONS.jobs,
  owner: 'routes/jobs.ts',
  indexes: [
    { key: { params_hash: 1, status: 1 }, name: 'params_hash_1_status_1' },
    { key: { status: 1, created_at: 1 }, name: 'status_1_created_at_1' },
    { key: { expires_at: 1 }, name: 'expires_at_ttl', expireAfterSeconds: 0 },
    // per-client limit (JOB_MAX_ACTIVE_PER_CLIENT) counts the active jobs a client is subscribed to
    { key: { 'subscribers.client': 1 }, name: 'subscribers_client_active', partialFilterExpression: { active: true } },
    // at most one queued/running job per params_hash (identical concurrent POSTs share one job)
    { key: { params_hash: 1 }, name: 'params_hash_active_unique', unique: true, partialFilterExpression: { active: true } },
  ],
});

// Prism serves the lowest 2xx (200) by default: make that a coherent "cache hit" (succeeded, cached true)
registerResponseExample('createJob', 200, exampleJobCached());

export const SSE_MEDIA_TYPE = 'text/event-stream';
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_POLL_MS = 2_000;
/** Artifacts never change once published (the job is immutable after it succeeded). */
export const ARTIFACT_CACHE_CONTROL = 'private, max-age=3600';
const ARTIFACT_MEDIA_TYPES = ['application/json', 'text/markdown', 'text/csv', 'text/plain', 'application/gzip', 'application/zip', 'image/png', 'image/svg+xml', 'application/octet-stream'] as const;
const fileName = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, '_');

export const jobsRoutes: FastifyPluginAsyncZod = async (app) => {
  const runner = new JobRunner(app.config, app.log.child({ module: 'jobs' }));
  // one poll per job id for all its SSE streams + per-client stream cap
  const watchers = new JobWatchers((id) => runner.get(id).catch((): JobDoc | null => null), SSE_POLL_MS);
  runner.events.on('job', (id: string) => watchers.notify(id));
  app.addHook('onReady', async () => {
    if (!isDbConnected()) return; // degraded mode: routes answer 503
    const { recovered } = await runner.start();
    if (recovered > 0) app.log.warn({ recovered }, 'job recovery done');
  });
  app.addHook('onClose', async () => {
    watchers.close();
    await runner.close();
  });

  app.post(
    '/jobs',
    {
      schema: {
        tags: ['jobs'],
        operationId: 'createJob',
        summary: 'Start a Python job (async): custom_site, precompute, analyse, alt_dates_python, check, validate, ...',
        description:
          'Body = CreateJobRequest, discriminated on `type` (one schema per job type; GET /api/v1/capabilities lists the types ' +
          'this server runs - others answer 501 JOB_TYPE_UNAVAILABLE). ' +
          '202 = queued, or an identical job is already queued/running: you are then subscribed to it (cached: true, same job_id; ' +
          'poll `poll` every 1-2 s; `Location` header = the same URL). 200 = an identical job already succeeded (cached: true). ' +
          '429 TOO_MANY_JOBS when this client (IP) already waits on JOB_MAX_ACTIVE_PER_CLIENT (default 2) queued/running jobs; ' +
          '429 QUEUE_FULL when JOB_QUEUE_MAX jobs wait. ' +
          'Job types that import a run (custom_site, precompute) have a storage budget: 429 QUOTA_EXCEEDED beyond JOB_RUNS_MAX_PER_CLIENT ' +
          'live runs of this client, 503 STORAGE_FULL when the server keeps JOB_RUNS_MAX_TOTAL runs / JOB_RUNS_MAX_MB or DATA_DIR is low on ' +
          'space; dem pgda work: 429 QUOTA_EXCEEDED once the daily PGDA download budget is used. ' +
          '409 RUN_NOT_READY when a run the job reads (check, compare_runs, ...) is still importing or failed. ' +
          'start snaps down / end snaps up to whole hours. When succeeded, use result.run_id with the normal endpoints. ' +
          'Measured on the dev machine (1 site, hourly, spice + pgda + raymarch, PGDA tiles of the area already cached): ' +
          'POST -> succeeded in ~14 s for 1 month and ~19 s for 1 year (precompute 11-18 s, import 1-3 s). ' +
          'The first job in a polar area not yet cached also downloads PGDA tiles and can take minutes.',
        body: CreateJobRequest,
        response: {
          200: {
            description: 'Identical job already succeeded (cache hit): status succeeded, cached true',
            content: { 'application/json': { schema: JobAccepted } }, // example: registerResponseExample below
          },
          202: { description: 'Job queued (or identical active job)', content: { 'application/json': { schema: JobAccepted } } },
          ...problemResponses(400, 404, 409, 413, 415, 422, 501, 503),
        },
      },
      config: { rateLimit: { max: app.config.RATE_LIMIT_POST_MAX, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const r = await runner.submit(req.body, requestClientKey(req));
      const poll = `${app.prefix}/jobs/${r.doc._id}`;
      return reply
        .status(r.statusCode)
        .header('location', poll)
        .send({ job_id: r.doc._id, type: r.doc.type, status: r.doc.status, site_id: jobSiteId(r.doc), poll, cached: r.cached });
    },
  );

  app.get(
    '/jobs/:job_id',
    {
      schema: {
        tags: ['jobs'],
        operationId: 'getJob',
        summary: 'Job status / progress / result (poll)',
        params: JobParams,
        response: { 200: Job, ...problemResponses(400, 404, 503) },
      },
      config: { rateLimit: false },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return toApiJob(await runner.get(req.params.job_id), requestClientKey(req), app.prefix);
    },
  );

  app.delete(
    '/jobs/:job_id',
    {
      schema: {
        tags: ['jobs'],
        operationId: 'cancelJob',
        summary: 'Cancel a queued/running job (for this client)',
        description:
          'Removes this client from the job. When no other client waits on it (Job.clients = 0 after the call) the job is cancelled ' +
          '(status cancelled, the Python process is killed); when other clients POSTed the same parameters it keeps running for them ' +
          '(status stays queued/running, clients > 0) - treat the job as cancelled in your UI either way. ' +
          '403 JOB_NOT_YOURS when this client never submitted the job; 409 JOB_NOT_CANCELLABLE when it already finished.',
        params: JobParams,
        response: { 200: Job, ...problemResponses(400, 403, 404, 409, 503) },
      },
    },
    async (req) => {
      const client = requestClientKey(req);
      return toApiJob(await runner.cancel(req.params.job_id, client), client, app.prefix);
    },
  );

  app.get(
    '/jobs/:job_id/events',
    {
      schema: {
        tags: ['jobs'],
        operationId: 'streamJobEvents',
        summary: 'Server-sent events with job progress (optional; polling is the contract)',
        description:
          'Each event: `event: job` + `data: <Job JSON>` (sent on every change); `: ping` comments every 15 s. ' +
          'The stream ends after a terminal status (succeeded / failed / cancelled). ' +
          'At most SSE_MAX_PER_CLIENT (default 5) open streams per client (IP): beyond that 429 TOO_MANY_STREAMS.',
        params: JobParams,
        response: {
          200: {
            description: 'text/event-stream',
            content: {
              [SSE_MEDIA_TYPE]: {
                schema: z.string().meta({ examples: ['event: job\ndata: {"job_id":"j_7f3k2m9q4x1z","status":"running"}\n\n'] }),
              },
            },
          },
          ...problemResponses(400, 404, 503),
        },
      },
      config: { rateLimit: false },
    },
    async (req, reply) => {
      const jobId = req.params.job_id;
      const client = requestClientKey(req);
      const first = await runner.get(jobId); // 404 before the stream starts
      if (!watchers.acquire(client, app.config.SSE_MAX_PER_CLIENT)) {
        throw new ApiError('TOO_MANY_STREAMS', `this client already has ${app.config.SSE_MAX_PER_CLIENT} open event streams`, {
          headers: { 'retry-after': '15' },
          hint: 'close an EventSource you no longer need, or poll GET /api/v1/jobs/{job_id} instead',
          extensions: { max_streams_per_client: app.config.SSE_MAX_PER_CLIENT },
        });
      }
      reply.hijack();
      const raw = reply.raw;
      const headers: Record<string, string | number | string[]> = {};
      for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v;
      raw.writeHead(200, { ...headers, 'content-type': SSE_MEDIA_TYPE, 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });

      let last = '';
      let ended = false;
      let unsubscribe: (() => void) | null = null;
      const ping = setInterval(() => raw.write(': ping\n\n'), SSE_HEARTBEAT_MS);
      function end(): void {
        if (ended) return;
        ended = true;
        clearInterval(ping);
        unsubscribe?.();
        watchers.release(client);
        raw.end();
      }
      const send = (doc: JobDoc | null): void => {
        if (ended) return;
        if (!doc) return end(); // expired / deleted
        const data = JSON.stringify(toApiJob(doc, client, app.prefix));
        if (data !== last) {
          last = data;
          raw.write(`event: job\ndata: ${data}\n\n`);
        }
        if (isTerminal(doc.status)) end();
      };
      req.raw.on('close', end);
      send(first);
      if (!ended) unsubscribe = watchers.subscribe(jobId, send);
    },
  );

  app.get(
    '/jobs/:job_id/artifacts',
    {
      schema: {
        tags: ['jobs'],
        operationId: 'listJobArtifacts',
        summary: 'Files a job produced (reports, JSON results)',
        description:
          'The artifacts of a SUCCEEDED job (same list as Job.artifacts); [] while it is queued/running or when it failed / was cancelled. ' +
          'Artifacts live as long as the job (expires_at).',
        params: JobParams,
        response: { 200: JobArtifactsResponse, ...problemResponses(400, 404, 503) },
      },
      config: { rateLimit: false },
    },
    async (req, reply) => {
      const d = await runner.get(req.params.job_id);
      reply.header('cache-control', 'no-store');
      return { job_id: d._id, type: d.type, status: d.status, artifacts: d.status === 'succeeded' ? toApiArtifacts(app.prefix, d._id, d.artifacts) : [] };
    },
  );

  app.get(
    '/jobs/:job_id/artifacts/:name',
    {
      schema: {
        tags: ['jobs'],
        operationId: 'getJobArtifact',
        summary: 'Download one artifact of a job',
        description:
          'Raw bytes as written by the job (never re-encoded). Content-Type from the extension (.json, .md, .csv, .txt, .gz, .zip, .png, .svg; ' +
          'else application/octet-stream). ETag = "<sha256>" (Job.artifacts[].sha256); If-None-Match -> 304. ' +
          '404 FILE_NOT_FOUND when the job has no artifact of that name.',
        params: JobArtifactParams,
        response: {
          200: {
            description: 'The file',
            content: Object.fromEntries(
              ARTIFACT_MEDIA_TYPES.map((t) => [
                t,
                // .json artifacts are JSON documents (object or array); everything else is raw text / bytes
                { schema: t === 'application/json' ? z.unknown().describe('artifact document (the JSON file as written by the job)') : z.string().describe('raw file bytes') },
              ]),
            ),
          },
          304: z.undefined().describe('Not modified (If-None-Match matched the ETag)'),
          ...problemResponses(400, 404, 503),
        },
      },
      config: { rateLimit: false },
      compress: false,
    },
    async (req, reply) => {
      const { job_id, name } = req.params;
      const d = await runner.get(job_id);
      const art = d.status === 'succeeded' ? d.artifacts?.find((a) => a.name === name) : undefined;
      if (!art) {
        throw new ApiError('FILE_NOT_FOUND', `job ${job_id} has no artifact ${JSON.stringify(name)}`, { hint: `GET ${app.prefix}/jobs/${job_id}/artifacts lists them` });
      }
      const abs = artifactPath(runner.jobDir(job_id), art.name);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) throw new ApiError('FILE_NOT_FOUND', `artifact ${art.name} of job ${job_id} is gone (expired?)`);
      const etag = `"${art.sha256}"`;
      reply
        .header('etag', etag)
        .header('cache-control', ARTIFACT_CACHE_CONTROL)
        // artifacts are data, never active content: no script / plugin / navigation even for .svg or a mis-sniffed type
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('x-content-type-options', 'nosniff');
      if (etagMatches(req.headers['if-none-match'], etag)) return reply.status(304).send();
      return reply
        .type(art.media_type)
        .header('content-length', st.size)
        .header('content-disposition', `${isInline(art.name) ? 'inline' : 'attachment'}; filename="${fileName(art.name)}"`)
        // Binary stream body: the zod response schema (z.string) only documents it; Fastify pipes streams unserialized.
        .send(createReadStream(abs) as unknown as string);
    },
  );
};

export default jobsRoutes;
