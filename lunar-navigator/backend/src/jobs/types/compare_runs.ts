/**
 * Job type 'compare_runs' (docs/PYTHON_INTEGRATION.md). OWNER: builder B3 (reports).
 * Compare two imported runs site by site through backend/python/compare_runs.py (port of
 * lunarnav_runs/compare_A_B.py; numpy only) -> artifacts compare_runs.json / compare_runs.csv and
 * output = summary over the sites. Sites, ranges and size are validated here (4xx) before Python runs.
 */
import path from 'node:path';
import { COMPARE_RUNS_LIMITS, CompareRunsJobOutput, type CompareRunsJobRequest } from '../../contract/job_types/compare_runs.ts';
import { ApiError } from '../../lib/problem.ts';
import { toIsoUtc } from '../../lib/time.ts';
import { resolveRun } from '../../repos/index.ts';
import { readJsonFile } from '../artifacts.ts';
import { bridgeFailureReason, bridgePlan, currentRun, fractionProgress, needModules, runDir, runsUnchanged, scrubPairs } from './b3_common.ts';
import { defineJobType } from './define.ts';

export interface CompareRunsParams {
  type: 'compare_runs';
  run_a: string;
  run_b: string;
  manifest_sha256_a: string;
  manifest_sha256_b: string;
  /** Sorted; null = every common site. */
  site_ids: string[] | null;
  [key: string]: unknown;
}

export const COMPARE_RUNS_SCRIPT = 'compare_runs.py';
export const COMPARE_RUNS_ARTIFACTS = { json: 'compare_runs.json', csv: 'compare_runs.csv' } as const;
const SUMMARY_FILE = 'compare_summary.json';
const PySummary = CompareRunsJobOutput.omit({ same_range: true });

export const compareRunsJob = defineJobType<CompareRunsJobRequest, CompareRunsParams>({
  type: 'compare_runs',
  implemented: true,
  owner: 'builder B3 (reports)',
  summary: 'Compare two imported runs site by site -> compare_runs.json / .csv artifacts',
  label: 'compare_runs',
  logName: 'compare_runs.log',
  pythonStage: 'python',
  limits: { timeout_s: 1800, result_ttl_h: 7 * 24, public: { ...COMPARE_RUNS_LIMITS } },

  available: (caps) => needModules(caps, ['numpy']),

  async canonicalize(req) {
    if (req.run_a === req.run_b) {
      throw new ApiError('VALIDATION_ERROR', 'run_a and run_b must be different runs', {
        errors: [{ path: 'run_b', in: 'body', message: 'must differ from run_a' }],
      });
    }
    const a = await resolveRun(req.run_a);
    const b = await resolveRun(req.run_b);
    const inB = new Set(b.site_ids);
    const common = a.site_ids.filter((s) => inB.has(s));
    let sites: string[];
    if (req.site_ids !== null) {
      const wanted = [...new Set(req.site_ids)].sort();
      const inA = new Set(a.site_ids);
      const missingA = wanted.filter((s) => !inA.has(s));
      const missingB = wanted.filter((s) => !inB.has(s));
      if (missingA.length > 0 || missingB.length > 0) {
        throw new ApiError('SITE_NOT_FOUND', `site(s) not in both runs: ${[...new Set([...missingA, ...missingB])].slice(0, 10).join(', ')}`, {
          extensions: { missing_in_a: missingA.slice(0, 50), missing_in_b: missingB.slice(0, 50) },
        });
      }
      sites = wanted;
    } else {
      sites = common;
    }
    if (sites.length === 0) {
      throw new ApiError('OUT_OF_RANGE', `runs ${a._id} and ${b._id} have no site in common`, { extensions: { n_sites_a: a.n_sites, n_sites_b: b.n_sites } });
    }
    const from = Math.max(a.start.getTime(), b.start.getTime());
    const to = Math.min(a.end.getTime(), b.end.getTime());
    if (from >= to) {
      throw new ApiError('OUT_OF_RANGE', `the ranges of ${a._id} (${toIsoUtc(a.start)} .. ${toIsoUtc(a.end)}) and ${b._id} (${toIsoUtc(b.start)} .. ${toIsoUtc(b.end)}) do not overlap`);
    }
    const size = sites.length * Math.max(a.n_samples, b.n_samples);
    if (sites.length > COMPARE_RUNS_LIMITS.max_sites || size > COMPARE_RUNS_LIMITS.max_site_samples) {
      throw new ApiError('JOB_TOO_LARGE', `${sites.length} sites x ${Math.max(a.n_samples, b.n_samples)} samples exceeds the compare_runs limits`, {
        hint: 'pass fewer site_ids',
        extensions: { ...COMPARE_RUNS_LIMITS, n_sites: sites.length, site_samples: size },
      });
    }
    return {
      type: 'compare_runs',
      run_a: a._id,
      run_b: b._id,
      manifest_sha256_a: a.manifest_sha256,
      manifest_sha256_b: b.manifest_sha256,
      site_ids: req.site_ids === null ? null : sites,
    };
  },

  siteId: () => null,

  async planPython(p, run) {
    const a = await currentRun(p.run_a, p.manifest_sha256_a);
    const b = await currentRun(p.run_b, p.manifest_sha256_b);
    const dirA = runDir(a, run.cfg);
    const dirB = runDir(b, run.cfg);
    return bridgePlan(run, COMPARE_RUNS_SCRIPT, {
      run_a: { run_id: a._id, dir: dirA },
      run_b: { run_id: b._id, dir: dirB },
      site_ids: p.site_ids,
      max_sites: COMPARE_RUNS_LIMITS.max_sites,
      out_json: path.join(run.artifactsDir, COMPARE_RUNS_ARTIFACTS.json),
      out_csv: path.join(run.artifactsDir, COMPARE_RUNS_ARTIFACTS.csv),
      summary_out: path.join(run.jobDir, SUMMARY_FILE),
      scrub: scrubPairs(run.cfg, [
        [dirA, '<RUN_A>'],
        [dirB, '<RUN_B>'],
      ]),
    });
  },

  progress(line, prev) {
    const pct = fractionProgress(line, /^compare: site (\d+)\/(\d+)/, 5, 95);
    return pct === null ? prev : { stage: 'python', pct };
  },

  failureReason: bridgeFailureReason('compare_runs'),

  async onSuccess(p, run) {
    await run.setProgress('artifacts', 97);
    const s = await readJsonFile(path.join(run.jobDir, SUMMARY_FILE), PySummary);
    const a = await currentRun(p.run_a, p.manifest_sha256_a);
    const b = await currentRun(p.run_b, p.manifest_sha256_b);
    const same = a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime() && a.step_s === b.step_s;
    return { output: CompareRunsJobOutput.parse({ ...s, same_range: same }) };
  },

  reusable: (doc) => {
    const p = doc.params as CompareRunsParams;
    return runsUnchanged([
      { run_id: p.run_a, manifest_sha256: p.manifest_sha256_a },
      { run_id: p.run_b, manifest_sha256: p.manifest_sha256_b },
    ]);
  },
});
