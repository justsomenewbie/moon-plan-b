/**
 * Job type 'alt_dates_python' (docs/PYTHON_INTEGRATION.md). OWNER: builder B1 (compute; reassigned from B2).
 * `lunarnav alt-dates` recomputed by Python for ONE site with the full ComputeOptions + DateConstraints,
 * through backend/python/alt_dates_python_job.py (runs the CLI in-process; "no feasible date" = exit 2 of
 * the CLI becomes a successful, empty result). The CLI writes alt_dates.json straight into the artifacts
 * dir; it is zod-validated and copied into Job.output. POST /api/v1/alt-dates (imported runs) is unchanged.
 */
import path from 'node:path';
import type { z } from 'zod';
import type { DateConstraints } from '../../contract/alt_dates.ts';
import {
  ALT_DATES_PYTHON_LIMITS,
  AltDatesPythonFile,
  AltDatesPythonJobOutput,
  type AltDatesPythonJobRequest,
} from '../../contract/job_types/alt_dates_python.ts';
import { ApiError } from '../../lib/problem.ts';
import { MS_PER_H, parseIsoUtc, parseIsoUtcCeil, toIsoUtc } from '../../lib/time.ts';
import { bridgeScriptArgs, flagArg, lunarnavEnv } from '../../python/scripts.ts';
import { readJsonFile } from '../artifacts.ts';
import { defineJobType } from './define.ts';
import { COMMON_FLAGS, canonicalComputeOptions, checkEpochs, cliAvailability, computeFlags, resolveSingleSite, type ComputeParams } from './precompute.ts';

type Constraints = z.output<typeof DateConstraints>;

export type AltDatesPythonParams = {
  type: 'alt_dates_python';
  site_id: string;
  lat_deg: number | null;
  lon_deg: number | null;
  earliest: string;
  latest: string;
  mission_h: number;
  max_results: number;
  constraints: Constraints;
} & ComputeParams;

export const ALT_DATES_ARTIFACT = 'alt_dates.json';
export const ALT_DATES_PYTHON_SCRIPT = 'alt_dates_python_job.py';
const DAY_MS = 86_400_000;

/** DateConstraints -> `lunarnav alt-dates` flags. */
export function constraintFlags(c: Constraints): string[] {
  const f = [
    flagArg('--min-sun-pct', c.min_sun_pct),
    flagArg('--min-earth-pct', c.min_earth_pct),
    flagArg('--min-both-pct', c.min_both_pct),
    flagArg('--min-continuous-sun-h', c.min_continuous_sun_h),
    flagArg('--min-continuous-earth-h', c.min_continuous_earth_h),
    flagArg('--objective', c.objective),
    flagArg('--min-separation-h', c.min_separation_h),
  ];
  if (!c.require_sun_at_landing) f.push('--allow-dark-landing');
  if (c.require_earth_at_landing) f.push('--require-earth-at-landing');
  if (c.max_dark_gap_h !== null) f.push(flagArg('--max-dark-gap-h', c.max_dark_gap_h));
  if (c.max_comms_gap_h !== null) f.push(flagArg('--max-comms-gap-h', c.max_comms_gap_h));
  if (c.min_sun_el_at_landing_deg !== null) f.push(flagArg('--min-sun-el', c.min_sun_el_at_landing_deg));
  return f;
}

/** Samples of the series lunarnav computes (find_alternative_dates_for_site). */
export function altDatesSamples(p: Pick<AltDatesPythonParams, 'earliest' | 'latest' | 'mission_h' | 'constraints' | 'step_min'>): number {
  const stepS = Math.round(p.step_min * 60);
  const extraH = Math.max(p.mission_h, p.constraints.min_continuous_sun_h, p.constraints.min_continuous_earth_h);
  const span = (parseIsoUtc(p.latest) - parseIsoUtc(p.earliest)) / 1000 + Math.ceil(extraH * 3600) + stepS;
  return Math.ceil(span / stepS);
}

export const altDatesPythonJob = defineJobType<AltDatesPythonJobRequest, AltDatesPythonParams>({
  type: 'alt_dates_python',
  implemented: true,
  owner: 'builder B1 (compute)',
  summary: 'lunarnav alt-dates recomputed by Python for one site with full options (Job.output + artifact alt_dates.json)',
  label: 'lunarnav alt-dates',
  logName: 'alt_dates.log',
  pythonStage: 'python',
  limits: {
    result_ttl_h: 7 * 24,
    public: { ...ALT_DATES_PYTHON_LIMITS },
  },

  available: (caps) =>
    cliAvailability(caps, 'alt-dates', [...COMMON_FLAGS, '--earliest', '--latest', '--mission-h', '--max-results', '--objective', '--json']),

  async canonicalize(req, ctx) {
    const opts = await canonicalComputeOptions(req, ctx);
    const stepMs = Math.round(opts.step_min * 60) * 1000;
    // landing instants are earliest + k * step: keep them inside the requested window
    const earliest = Math.ceil(parseIsoUtcCeil(req.earliest) / stepMs) * stepMs;
    const latest = Math.floor(parseIsoUtc(req.latest) / stepMs) * stepMs;
    if (parseIsoUtc(req.latest) < parseIsoUtc(req.earliest)) {
      throw new ApiError('VALIDATION_ERROR', 'latest must be >= earliest', { errors: [{ path: 'latest', in: 'body', message: 'must be >= earliest' }] });
    }
    if (latest < earliest) {
      throw new ApiError('VALIDATION_ERROR', `[earliest, latest] contains no instant of the ${opts.step_min} min step grid`, {
        errors: [{ path: 'latest', in: 'body', message: 'widen the window or use a smaller step_min' }],
      });
    }
    const maxLatest = earliest + ALT_DATES_PYTHON_LIMITS.max_window_days * DAY_MS;
    if (latest > maxLatest) {
      throw new ApiError('OUT_OF_RANGE', `latest is at most ${ALT_DATES_PYTHON_LIMITS.max_window_days} days after earliest`, {
        errors: [{ path: 'latest', in: 'body', message: `must be <= ${toIsoUtc(maxLatest)}` }],
        extensions: { max_latest: toIsoUtc(maxLatest), max_window_days: ALT_DATES_PYTHON_LIMITS.max_window_days },
      });
    }
    const m = (req.mission_h * 60) / opts.step_min;
    if (Math.abs(m - Math.round(m)) > 1e-6 || Math.round(m) < 1) {
      throw new ApiError('BAD_MISSION_LENGTH', `mission_h ${req.mission_h} is not a positive multiple of the step (${opts.step_min} min)`, {
        errors: [{ path: 'mission_h', in: 'body', message: `must be a multiple of ${opts.step_min / 60} h` }],
        extensions: { step_h: opts.step_min / 60 },
      });
    }
    const site = await resolveSingleSite(req, ctx);
    const params: AltDatesPythonParams = {
      type: 'alt_dates_python',
      ...site,
      earliest: toIsoUtc(earliest),
      latest: toIsoUtc(latest),
      mission_h: req.mission_h,
      max_results: req.max_results,
      constraints: req.constraints,
      ...opts,
    };
    const endMs = latest + Math.ceil(Math.max(req.mission_h, req.constraints.min_continuous_sun_h, req.constraints.min_continuous_earth_h) * MS_PER_H) + stepMs;
    checkEpochs({ earliest, latest: endMs });
    const n = altDatesSamples(params);
    if (n > ALT_DATES_PYTHON_LIMITS.max_samples) {
      const msg = `the series covers ${n} samples (window + mission + continuous constraints) / step; at most ${ALT_DATES_PYTHON_LIMITS.max_samples}`;
      throw new ApiError('JOB_TOO_LARGE', msg, {
        errors: [{ path: 'latest', in: 'body', message: msg }],
        hint: 'shorten the window / mission or use a larger step_min',
        extensions: { n_samples: n, max_samples: ALT_DATES_PYTHON_LIMITS.max_samples },
      });
    }
    return params;
  },

  siteId: (p) => p.site_id,

  planPython: (p, run) => ({
    args: bridgeScriptArgs(ALT_DATES_PYTHON_SCRIPT, [
      flagArg('--sites', p.site_id),
      flagArg('--earliest', p.earliest),
      flagArg('--latest', p.latest),
      flagArg('--mission-h', p.mission_h),
      ...computeFlags(p),
      ...constraintFlags(p.constraints),
      flagArg('--max-results', p.max_results),
      flagArg('--json', path.join(run.artifactsDir, ALT_DATES_ARTIFACT)),
    ]),
    env: lunarnavEnv(run.cfg, { bridge: true }),
  }),

  progress: (line, prev) => (/^site \S+: \d+\/\d+ landing times feasible/.test(line) ? { stage: 'python', pct: Math.max(prev.pct ?? 0, 90) } : prev),

  async onSuccess(p, run) {
    await run.setProgress('artifacts', 95);
    const file = await readJsonFile(path.join(run.artifactsDir, ALT_DATES_ARTIFACT), AltDatesPythonFile);
    if (file.site_id !== p.site_id) throw new Error(`${ALT_DATES_ARTIFACT} is for site ${file.site_id}, not ${p.site_id}`);
    const output = AltDatesPythonJobOutput.parse({
      ...file,
      step_min: p.step_min,
      provider: p.provider,
      dem: p.dem,
      horizon_method: p.horizon_method,
    });
    return { output };
  },
});
