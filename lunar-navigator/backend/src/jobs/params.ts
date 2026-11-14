/**
 * POST /jobs body of type custom_site -> canonical parameters + params_hash (plan 7.2).
 * (Shared by every job type: paramsHash + JOB_PARAMS_VERSION. Type-specific canonicalisation lives in
 * src/jobs/types/<type>.ts.)
 * - lat/lon -> canonical custom id (parity with lunarnav.sites.custom_site_id); site_id must be a
 *   catalog id or an already canonical custom id.
 * - start snaps DOWN and end snaps UP to whole steps (UTC hours); end exclusive; <= JOB_LIMITS.max_range_days.
 * - dem 'none' forces horizon_method 'flat' (what the CLI does), so equivalent requests share a hash.
 * - params_hash = sha256(stable JSON of {params, lunarnav code_version, JOB_PARAMS_VERSION}); `name` is not hashed.
 */
import { JOB_LIMITS, type CreateJobRequest, type CustomSiteJobRequest } from '../contract/jobs.ts';
import { ApiError, catalogSiteNotFound } from '../lib/problem.ts';
import { MS_PER_H, parseIsoUtc, parseIsoUtcCeil, toIsoUtc } from '../lib/time.ts';
import { customSiteId, isCustomSiteId, parseCustomSiteId, roundCustom } from '../python/customSiteId.ts';
import { sha256, stableStringify } from '../python/hash.ts';
import type { AnyJobParams, CanonicalJobParams } from './types.ts';

export const JOB_PARAMS_VERSION = 1;
const DAY_MS = 86_400_000;

export interface CanonicalizeContext {
  /** Catalog ids of lunarnav (null = unknown: catalog ids are then accepted and validated by Python). */
  catalogIds: Set<string> | null;
}

function siteOf(body: CustomSiteJobRequest, ctx: CanonicalizeContext): Pick<CanonicalJobParams, 'site_id' | 'lat_deg' | 'lon_deg'> {
  if (body.lat_deg !== undefined && body.lon_deg !== undefined) {
    try {
      const r = roundCustom(body.lat_deg, body.lon_deg);
      return { site_id: customSiteId(body.lat_deg, body.lon_deg), lat_deg: r.lat, lon_deg: r.lon };
    } catch (e) {
      throw new ApiError('VALIDATION_ERROR', (e as Error).message, { errors: [{ path: 'lon_deg', in: 'body', message: (e as Error).message }] });
    }
  }
  const id = body.site_id ?? '';
  if (isCustomSiteId(id)) {
    try {
      const r = parseCustomSiteId(id);
      return { site_id: id, lat_deg: r.lat, lon_deg: r.lon };
    } catch (e) {
      throw new ApiError('VALIDATION_ERROR', (e as Error).message, {
        errors: [{ path: 'site_id', in: 'body', message: (e as Error).message }],
        hint: 'or send lat_deg + lon_deg and let the server build the id',
      });
    }
  }
  if (ctx.catalogIds && !ctx.catalogIds.has(id)) throw catalogSiteNotFound(id);
  return { site_id: id, lat_deg: null, lon_deg: null };
}

export function canonicalizeJob(body: CreateJobRequest, ctx: CanonicalizeContext): CanonicalJobParams {
  if (body.type !== 'custom_site') throw new ApiError('VALIDATION_ERROR', `canonicalizeJob() handles custom_site requests, not ${body.type}`);
  const site = siteOf(body, ctx);
  const stepMs = body.step_min * 60_000;
  const s0 = parseIsoUtc(body.start);
  const e0 = parseIsoUtcCeil(body.end);
  const start = Math.floor(s0 / stepMs) * stepMs;
  const end = Math.ceil(e0 / stepMs) * stepMs;
  if (end <= start) {
    throw new ApiError('VALIDATION_ERROR', 'end must be after start', { errors: [{ path: 'end', in: 'body', message: 'must be > start' }] });
  }
  const maxEnd = start + JOB_LIMITS.max_range_days * DAY_MS;
  if (end > maxEnd) {
    throw new ApiError('OUT_OF_RANGE', `a job covers at most ${JOB_LIMITS.max_range_days} days`, {
      errors: [{ path: 'end', in: 'body', message: `must be <= ${toIsoUtc(maxEnd)}` }],
      extensions: { max_end: toIsoUtc(maxEnd), max_range_days: JOB_LIMITS.max_range_days },
    });
  }
  return {
    type: 'custom_site',
    ...site,
    start: toIsoUtc(start),
    end: toIsoUtc(end),
    step_min: body.step_min,
    provider: body.provider,
    dem: body.dem,
    horizon_method: body.dem === 'none' ? 'flat' : body.horizon_method,
    observer_height_m: body.observer_height_m,
  };
}

/** Same formula for every job type (params.type is part of params), so custom_site hashes never changed. */
export function paramsHash(params: AnyJobParams, codeVersion: string): string {
  return sha256(stableStringify({ v: JOB_PARAMS_VERSION, code_version: codeVersion, params }));
}

/** Number of samples of a job (for progress / logs). */
export const jobSamples = (p: CanonicalJobParams): number => Math.round((parseIsoUtc(p.end) - parseIsoUtc(p.start)) / (p.step_min * 60_000));
export const jobHours = (p: CanonicalJobParams): number => (parseIsoUtc(p.end) - parseIsoUtc(p.start)) / MS_PER_H;
