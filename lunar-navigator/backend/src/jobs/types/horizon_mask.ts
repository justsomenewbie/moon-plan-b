/**
 * Job type 'horizon_mask' (docs/PYTHON_INTEGRATION.md). OWNER: builder B4 (tools).
 * Async version of POST /tools/horizon (src/routes/tools.ts) for masks that may exceed the sync timeout:
 * radius up to 300 km, az step down to 0.05 deg, bruteforce, Trek (local GeoTIFFs only).
 *
 * POST: site resolved like the tool (run site record / catalog / custom id / lat-lon) -> canonical params
 * (the resolved site reference is hashed, so a re-imported default run gives a new job); DEM / CLI flag
 * checked against GET /capabilities (422 CAPABILITY_UNAVAILABLE). Python: backend/python/tools_horizon_mask.py
 * (= horizon_json.compute, lunarnav.precompute.make_horizon_fn) writes DATA_DIR/jobs/<id>/horizon_raw.json;
 * onSuccess zod-validates it and publishes the artifact horizon.json (a HorizonToolResponse document,
 * server paths replaced) + output = summary.
 */
import path from 'node:path';
import { z } from 'zod';
import { HORIZON_MASK_ARTIFACT, HORIZON_MASK_LIMITS, HorizonMaskJobOutput, type HorizonMaskJobRequest } from '../../contract/job_types/horizon_mask.ts';
import type { ToolSite } from '../../contract/tools.ts';
import { ApiError } from '../../lib/problem.ts';
import { lunarnavDataDir } from '../../python/lunarnav.ts';
import { bridgeScriptArgs, lunarnavEnv } from '../../python/scripts.ts';
import type { RunnerConfig } from '../runner.ts';
import { readJsonFile, writeJsonArtifact } from '../artifacts.ts';
import { PyError, PyHorizon, checkHorizonCapabilities, horizonResponse, resolveToolSite, sanitizeToolText, toolSite, type SiteRef } from './b4_tools.ts';
import { JobFailure, defineJobType } from './define.ts';

export const HORIZON_MASK_SCRIPT = 'tools_horizon_mask.py';
const RAW_FILE = 'horizon_raw.json';

export interface HorizonMaskParams {
  type: 'horizon_mask';
  site: SiteRef;
  /** ToolSite fields known before Python runs. */
  requested_site_id: string | null;
  site_source: ToolSite['source'];
  site_run_id: string | null;
  dem: 'pgda' | 'trek' | 'none';
  method: 'raymarch' | 'bruteforce' | 'flat';
  radius_km: number;
  az_step_deg: number;
  observer_height_m: number;
  /** null = lunarnav default ('auto') or not applicable (flat). */
  near_exclusion_m: number | 'auto' | null;
  dem_fallback: 'flat' | 'error';
  rounding: 'run_files' | 'none';
  [key: string]: unknown;
}

/** [absolute path, placeholder], longest path first (LUNARNAV_DATA may lie inside LUNARNAV_ROOT / DATA_DIR). */
function scrubPairs(cfg: Pick<RunnerConfig, 'DATA_DIR' | 'LUNARNAV_ROOT'>): [string, string][] {
  const pairs: [string, string][] = [
    [path.resolve(lunarnavDataDir(cfg)), '<LUNARNAV_DATA>'],
    [path.resolve(cfg.DATA_DIR), '<DATA_DIR>'],
    [path.resolve(cfg.LUNARNAV_ROOT), '<LUNARNAV_ROOT>'],
  ];
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

const ProtocolLine = z.object({ ok: z.literal(false), error: PyError });

export const horizonMaskJob = defineJobType<HorizonMaskJobRequest, HorizonMaskParams>({
  type: 'horizon_mask',
  implemented: true,
  owner: 'builder B4 (tools)',
  summary: 'Terrain horizon mask of one point (async POST /tools/horizon: radius <= 300 km, az step >= 0.05 deg, bruteforce, trek) -> artifact horizon.json',
  label: 'horizon mask',
  logName: 'horizon_mask.log',
  pythonStage: 'python',
  limits: {
    timeout_s: HORIZON_MASK_LIMITS.timeout_s,
    result_ttl_h: 72,
    public: {
      radius_km_max: HORIZON_MASK_LIMITS.radius_km_max,
      az_step_deg_min: HORIZON_MASK_LIMITS.az_step_deg_min,
      az_step_deg_max: HORIZON_MASK_LIMITS.az_step_deg_max,
      observer_height_m_max: HORIZON_MASK_LIMITS.observer_height_m_max,
      artifact: HORIZON_MASK_ARTIFACT,
    },
  },

  available: (caps) => {
    if (!caps.python.ok) return `Python / lunarnav unavailable: ${caps.python.error ?? 'unknown error'}`;
    return null;
  },

  async canonicalize(req, ctx) {
    const method = req.dem === 'none' ? 'flat' : req.method;
    if (method === 'bruteforce' && typeof req.near_exclusion_m === 'number' && req.near_exclusion_m > 0) {
      // lunarnav.precompute.make_horizon_fn rejects it (like the CLI): a 400 now instead of a failed job
      const msg = "near_exclusion_m applies to method raymarch only (bruteforce rejects it, like the CLI); use 'auto' or 0";
      throw new ApiError('VALIDATION_ERROR', msg, { errors: [{ path: 'near_exclusion_m', in: 'body', message: msg }] });
    }
    const caps = await ctx.capabilities();
    checkHorizonCapabilities(caps, req);
    const rs = await resolveToolSite(ctx.cfg, req);
    return {
      type: 'horizon_mask',
      site: rs.ref,
      requested_site_id: req.site_id ?? null,
      site_source: rs.source,
      site_run_id: rs.runId,
      dem: req.dem,
      method,
      radius_km: req.radius_km,
      az_step_deg: req.az_step_deg,
      observer_height_m: req.observer_height_m,
      // 'auto' / omitted = the lunarnav default; meaningless for flat: one hash for equivalent requests
      near_exclusion_m: method === 'flat' || req.near_exclusion_m === undefined || req.near_exclusion_m === 'auto' ? null : req.near_exclusion_m,
      dem_fallback: req.dem_fallback,
      rounding: req.rounding,
    };
  },

  siteId: (p) => (p.site.kind === 'coordinates' ? null : p.site.site_id),

  planPython: (p, run) => ({
    args: bridgeScriptArgs(HORIZON_MASK_SCRIPT),
    env: lunarnavEnv(run.cfg, { jobDir: run.jobDir, bridge: true }),
    input: JSON.stringify({
      site: p.site,
      dem: p.dem,
      method: p.method,
      radius_km: p.radius_km,
      az_step_deg: p.az_step_deg,
      observer_height_m: p.observer_height_m,
      ...(p.near_exclusion_m === null ? {} : { near_exclusion_m: p.near_exclusion_m }),
      dem_fallback: p.dem_fallback,
      rounding: p.rounding,
      out_path: path.join(run.jobDir, RAW_FILE),
      scrub: scrubPairs(run.cfg),
    }),
  }),

  progress: (line, prev) => {
    if (line.startsWith('horizon_mask: computing')) return { stage: 'python', pct: 10 };
    if (line.startsWith('horizon_mask: writing')) return { stage: 'python', pct: 90 };
    return prev;
  },

  failureReason: (lines, exitCode) => {
    for (const l of [...lines].reverse()) {
      const t = l.trim();
      if (!t.startsWith('{')) continue;
      try {
        const r = ProtocolLine.safeParse(JSON.parse(t));
        if (r.success) return `${r.data.error.type}: ${r.data.error.message}`.slice(0, 500);
      } catch {
        // not JSON
      }
    }
    const meaningful = [...lines].reverse().find((l) => l.trim().length > 0 && !/^\s*(File |Traceback|\^|~)/.test(l.replace(/^\[stderr\] /, '')));
    return meaningful ? meaningful.trim().slice(0, 500) : `horizon mask exited with code ${String(exitCode)}`;
  },

  async onSuccess(p, run) {
    await run.setProgress('artifacts', 95);
    const py = await readJsonFile(path.join(run.jobDir, RAW_FILE), PyHorizon, 64 * 1024 * 1024);
    let doc;
    try {
      const site = toolSite(p.requested_site_id, p.site_source, p.site_run_id, py.site);
      doc = horizonResponse(site, py, p.rounding, (s) => sanitizeToolText(run.cfg, s));
    } catch (e) {
      throw new JobFailure('RESULT_FAILED', (e as Error).message);
    }
    await writeJsonArtifact(run.jobDir, HORIZON_MASK_ARTIFACT, doc);
    const output = HorizonMaskJobOutput.parse({
      site: doc.site,
      method: doc.method,
      dem_source: doc.dem_source,
      radius_km: doc.radius_km,
      az_step_deg: doc.az_step_deg,
      observer_height_m: doc.observer_height_m,
      surface_height_m: doc.surface_height_m,
      near_exclusion_m: doc.near_exclusion_m,
      dem_fallback: doc.dem_fallback,
      n_az: doc.n_az,
      min_el_deg: doc.min_el_deg,
      max_el_deg: doc.max_el_deg,
      elapsed_ms: doc.elapsed_ms,
      artifact: HORIZON_MASK_ARTIFACT,
    });
    return { output };
  },
});
