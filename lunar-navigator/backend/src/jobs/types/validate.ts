/**
 * Job type 'validate' (docs/PYTHON_INTEGRATION.md). OWNER: builder B3 (reports).
 * lunarnav.validate.run_all (quick | full, offline, no_horizons, no_terrain) through
 * backend/python/validate_json.py -> artifacts validation_report.json / .md (+ validate_terrain_report.json
 * when the terrain hook ran) and output = small summary. A failed validation (passed = false) is a
 * SUCCEEDED job; only a validation that cannot run fails the job.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ValidateJobOutput, type ValidateJobRequest } from '../../contract/job_types/validate.ts';
import { ApiError } from '../../lib/problem.ts';
import { artifactPath, readJsonFile } from '../artifacts.ts';
import { bridgeFailureReason, bridgePlan, needModules, scrubPairs } from './b3_common.ts';
import { JobFailure, defineJobType } from './define.ts';

export interface ValidateParams {
  type: 'validate';
  mode: 'quick' | 'full';
  /** false when no_horizons (offline only matters for Horizons): equivalent requests share a hash. */
  offline: boolean;
  no_horizons: boolean;
  no_terrain: boolean;
  [key: string]: unknown;
}

export const VALIDATE_SCRIPT = 'validate_json.py';
export const VALIDATE_ARTIFACTS = { json: 'validation_report.json', md: 'validation_report.md', terrain: 'validate_terrain_report.json' } as const;
const SUMMARY_FILE = 'validate_summary.json';
const TERRAIN_SCRATCH = 'validate_terrain_raw.json';
/** Timeouts, s: quick (2 sites x 1 month, + terrain quick) / full. */
export const VALIDATE_TIMEOUTS = { quick: 3600, full: 4 * 3600 } as const;

/** lunarnav.validate log lines -> pct (the ephemeris part; the terrain hook runs after 'lunar day'). */
const STAGES: [RegExp, number][] = [
  [/^validate: /, 8],
  [/^cross-check:/, 12],
  [/^diagnostics against/, 50],
  [/^Apollo 11/, 65],
  [/^lunar day/, 75],
  [/^validate: writing/, 95],
];

export const validateJob = defineJobType<ValidateJobRequest, ValidateParams>({
  type: 'validate',
  implemented: true,
  owner: 'builder B3 (reports)',
  summary: 'lunarnav.validate (quick or full) -> validation_report.json / .md artifacts',
  label: 'lunarnav validate',
  logName: 'validate.log',
  pythonStage: 'python',
  limits: {
    timeout_s: VALIDATE_TIMEOUTS.quick,
    result_ttl_h: 72,
    public: { timeout_s: VALIDATE_TIMEOUTS, needs: 'SPICE kernels; Horizons network unless no_horizons or offline (cache)' },
  },

  available: (caps) => needModules(caps, ['lunarnav.validate', 'lunarnav.ephem.spice', 'lunarnav.ephem.analytic', 'spiceypy']),

  async canonicalize(req, ctx) {
    const caps = await ctx.capabilities();
    if (!caps.providers.spice.available) {
      throw new ApiError('CAPABILITY_UNAVAILABLE', `validate needs SPICE (Method B): ${caps.providers.spice.reason ?? 'unavailable'}`, {
        extensions: { capability: 'providers.spice' },
      });
    }
    if (!req.no_horizons && !req.offline && caps.network.horizons.reachable === false) {
      throw new ApiError('CAPABILITY_UNAVAILABLE', 'JPL Horizons is not reachable from this server', {
        hint: 'use no_horizons: true (SPICE vs analytic) or offline: true (Horizons disk cache)',
        errors: [{ path: 'no_horizons', in: 'body', message: 'Horizons unreachable' }],
        extensions: { capability: 'network.horizons' },
      });
    }
    return { type: 'validate', mode: req.mode, offline: req.no_horizons ? false : req.offline, no_horizons: req.no_horizons, no_terrain: req.no_terrain };
  },

  siteId: () => null,

  planPython: (p, run) =>
    bridgePlan(
      run,
      VALIDATE_SCRIPT,
      {
        quick: p.mode === 'quick',
        offline: p.offline,
        include_horizons: !p.no_horizons,
        terrain: !p.no_terrain,
        artifacts_dir: run.artifactsDir,
        summary_out: path.join(run.jobDir, SUMMARY_FILE),
        terrain_out: path.join(run.jobDir, TERRAIN_SCRATCH),
        scrub: scrubPairs(run.cfg),
      },
      VALIDATE_TIMEOUTS[p.mode],
    ),

  progress(line, prev) {
    let pct: number | null = null;
    for (const [re, v] of STAGES) if (re.test(line)) pct = v;
    return pct === null || (prev.pct !== null && pct < prev.pct) ? prev : { stage: 'python', pct };
  },

  failureReason: bridgeFailureReason('lunarnav validate'),

  async onSuccess(_p, run) {
    await run.setProgress('artifacts', 97);
    for (const name of [VALIDATE_ARTIFACTS.json, VALIDATE_ARTIFACTS.md]) {
      if (!existsSync(artifactPath(run.jobDir, name))) throw new JobFailure('RESULT_FAILED', `${name} was not written`);
    }
    const output = await readJsonFile(path.join(run.jobDir, SUMMARY_FILE), ValidateJobOutput);
    return { output };
  },
});
