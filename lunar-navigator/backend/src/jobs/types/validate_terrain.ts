/**
 * Job type 'validate_terrain' (docs/PYTHON_INTEGRATION.md). OWNER: builder B3 (reports).
 * lunarnav.validate_terrain.run(quick, out_path) through backend/python/validate_terrain_json.py ->
 * artifact validate_terrain_report.json (strict JSON, no server paths) and output = small summary.
 * Reads PGDA tiles / NASA illumination rasters (cached under LUNARNAV_DATA) and a few Moon Trek
 * ImageServer blocks; never downloads a full Moon Trek file.
 */
import path from 'node:path';
import { z } from 'zod';
import { ValidateTerrainJobOutput, type ValidateTerrainJobRequest } from '../../contract/job_types/validate_terrain.ts';
import { readJsonFile } from '../artifacts.ts';
import { bridgeFailureReason, bridgePlan, needModules, scrubPairs } from './b3_common.ts';
import { defineJobType } from './define.ts';

export interface ValidateTerrainParams {
  type: 'validate_terrain';
  mode: 'quick' | 'full';
  [key: string]: unknown;
}

export const VALIDATE_TERRAIN_SCRIPT = 'validate_terrain_json.py';
export const VALIDATE_TERRAIN_ARTIFACT = 'validate_terrain_report.json';
const SUMMARY_FILE = 'validate_terrain_summary.json';
const RAW_FILE = 'validate_terrain_raw.json';
const ValidateTerrainReportShape = z.looseObject({ generated_by: z.string(), quick: z.boolean() });
/** Timeouts, s (full took ~7 min on the dev machine with warm caches; cold caches download rasters). */
export const VALIDATE_TERRAIN_TIMEOUTS = { quick: 3600, full: 4 * 3600 } as const;

export const validateTerrainJob = defineJobType<ValidateTerrainJobRequest, ValidateTerrainParams>({
  type: 'validate_terrain',
  implemented: true,
  owner: 'builder B3 (reports)',
  summary: 'lunarnav.validate_terrain.run (quick or full) -> validate_terrain_report.json artifact',
  label: 'lunarnav validate_terrain',
  logName: 'validate_terrain.log',
  pythonStage: 'python',
  limits: {
    timeout_s: VALIDATE_TERRAIN_TIMEOUTS.quick,
    result_ttl_h: 72,
    public: { timeout_s: VALIDATE_TERRAIN_TIMEOUTS, needs: 'SPICE kernels, rasterio; PGDA + Moon Trek ImageServer network unless cached' },
  },

  available: (caps) => {
    const r = needModules(caps, ['lunarnav.validate_terrain', 'lunarnav.terrain.pgda', 'spiceypy', 'rasterio']);
    if (r !== null) return r;
    return caps.providers.spice.available ? null : `SPICE unavailable: ${caps.providers.spice.reason ?? 'unknown'}`;
  },

  canonicalize: (req) => ({ type: 'validate_terrain', mode: req.mode }),

  siteId: () => null,

  planPython: (p, run) =>
    bridgePlan(
      run,
      VALIDATE_TERRAIN_SCRIPT,
      {
        quick: p.mode === 'quick',
        raw_out: path.join(run.jobDir, RAW_FILE),
        artifacts_dir: run.artifactsDir,
        summary_out: path.join(run.jobDir, SUMMARY_FILE),
        scrub: scrubPairs(run.cfg),
      },
      VALIDATE_TERRAIN_TIMEOUTS[p.mode],
    ),

  // no machine-readable progress in lunarnav.validate_terrain: keep the stage, show the log lines
  progress: (line, prev) => (/^validate_terrain: writing/.test(line) ? { stage: 'python', pct: 95 } : prev),

  failureReason: bridgeFailureReason('lunarnav validate_terrain'),

  async onSuccess(_p, run) {
    await run.setProgress('artifacts', 97);
    const output = await readJsonFile(path.join(run.jobDir, SUMMARY_FILE), ValidateTerrainJobOutput);
    // the report itself must be strict JSON (it is published as-is)
    await readJsonFile(path.join(run.artifactsDir, VALIDATE_TERRAIN_ARTIFACT), ValidateTerrainReportShape, 100 * 1024 * 1024);
    return { output };
  },
});
