/**
 * HTTP caching of read endpoints (plan 6.8): imported runs are immutable, so a response is fully
 * determined by (run identity, route, query). ETag = weak hash of those -> a revalidation costs one
 * `runs` lookup and no data query. Weak because @fastify/compress may re-encode the body.
 *
 * Lifetime: only a request that names its run (`run_id=...`) can be cached for long. Without run_id the
 * response follows the DEFAULT run, which changes when another run is imported with --default, so it
 * gets a short max-age (the ETag keeps the revalidation cheap). cacheControlFor() is the one place
 * that decides this for every data GET.
 */
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export const CACHE_IMMUTABLE = 'public, max-age=3600';
/** Responses that follow the mutable default run (no run_id in the request). */
export const CACHE_DEFAULT_RUN = 'public, max-age=60';
/** Lists that change when runs are imported / jobs finish. */
export const CACHE_SHORT = 'public, max-age=30';

/** Cache-Control of a data GET: long only when the request pinned its run with run_id. */
export function cacheControlFor(explicitRunId: string | undefined): string {
  return explicitRunId === undefined ? CACHE_DEFAULT_RUN : CACHE_IMMUTABLE;
}

export function weakEtag(...parts: readonly string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\u0000');
  return `W/"${h.digest('hex').slice(0, 32)}"`;
}

/** RFC 9110 If-None-Match (weak comparison, `*`, comma lists). */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const joined = Array.isArray(header) ? header.join(',') : header;
  if (joined.length === 0) return false;
  const bare = (t: string): string => t.trim().replace(/^W\//, '');
  const want = bare(etag);
  return joined.split(',').some((t) => t.trim() === '*' || bare(t) === want);
}

/**
 * Add tokens to the Vary header WITHOUT dropping what is already there (@fastify/cors sets
 * `Vary: Origin`; overwriting it would let a shared cache hand one origin's ACAO to another).
 */
export function appendVary(reply: FastifyReply, ...tokens: readonly string[]): void {
  const cur = reply.getHeader('vary');
  const have = (Array.isArray(cur) ? cur.join(',') : cur === undefined ? '' : String(cur))
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (have.includes('*')) return;
  const lower = new Set(have.map((t) => t.toLowerCase()));
  for (const t of tokens) {
    if (!lower.has(t.toLowerCase())) {
      have.push(t);
      lower.add(t.toLowerCase());
    }
  }
  reply.header('vary', have.join(', '));
}

/**
 * Set ETag + Cache-Control (+ Vary: accept-encoding, appended). Returns true when the client copy is
 * fresh: the caller must then `return notModified(reply)`.
 */
export function applyCache(req: FastifyRequest, reply: FastifyReply, etag: string, cacheControl: string): boolean {
  reply.header('etag', etag);
  reply.header('cache-control', cacheControl);
  appendVary(reply, 'accept-encoding');
  return etagMatches(req.headers['if-none-match'], etag);
}

/** OpenAPI entry for the 304 of a cacheable GET: `response: { 200: X, ...notModifiedResponse, ... }`. */
export const notModifiedResponse = {
  // type 'null' -> @fastify/swagger documents a response without content
  304: z.null().describe('Not Modified: the ETag sent in If-None-Match is current (empty body)'),
};

/** Answer 304 with an empty body (call after applyCache() returned true): `return notModified(reply)`. */
export function notModified(reply: FastifyReply): FastifyReply {
  return reply.code(304).send();
}
