/**
 * Job type 'check' (docs/PYTHON_INTEGRATION.md). OWNER: builder B3 (reports; reassigned from B2).
 * lunarnav.precompute.check_output (= `lunarnav check <dir>`, docs/OUTPUT_SPEC.md) on the files of an
 * imported run through backend/python/check_json.py. Violations are a RESULT (output.ok = false), not a
 * job failure. Never served from the cache: the point is to re-read the files on disk.
 */
import path from 'node:path';
import { z } from 'zod';
import { CHECK_OUTPUT_MAX_VIOLATIONS, CheckJobOutput, type CheckJobRequest } from '../../contract/job_types/check.ts';
import { resolveRun } from '../../repos/index.ts';
import { readJsonFile, writeJsonArtifact } from '../artifacts.ts';
import { bridgeFailureReason, bridgePlan, currentRun, needModules, runDir, scrubPairs } from './b3_common.ts';
import { defineJobType } from './define.ts';

export interface CheckParams {
  type: 'check';
  run_id: string;
  /** Import the job was submitted against (a re-import with other files fails the job: RUN_CHANGED). */
  manifest_sha256: string;
  [key: string]: unknown;
}

export const CHECK_SCRIPT = 'check_json.py';
export const CHECK_ARTIFACT = 'violations.json';
const RESULT_FILE = 'check_result.json';

const BridgeResult = z.object({
  violations: z.array(z.string()),
  n_violations: z.int().min(0),
  n_files: z.int().min(0).nullable(),
});

export const checkJob = defineJobType<CheckJobRequest, CheckParams>({
  type: 'check',
  implemented: true,
  owner: 'builder B3 (reports)',
  summary: 'lunarnav check on the files of an imported run -> violations (output + violations.json)',
  label: 'lunarnav check',
  logName: 'check.log',
  pythonStage: 'python',
  limits: { timeout_s: 1800, result_ttl_h: 7 * 24, cacheable: false, public: { max_output_violations: CHECK_OUTPUT_MAX_VIOLATIONS, cached: false } },

  available: (caps) => needModules(caps, ['lunarnav.precompute']),

  async canonicalize(req) {
    const run = await resolveRun(req.run_id); // RUN_NOT_FOUND 404 / RUN_NOT_READY 409
    return { type: 'check', run_id: run._id, manifest_sha256: run.manifest_sha256 };
  },

  siteId: () => null,

  async planPython(p, run) {
    const doc = await currentRun(p.run_id, p.manifest_sha256);
    const dir = runDir(doc, run.cfg);
    return bridgePlan(run, CHECK_SCRIPT, { dir, out: path.join(run.jobDir, RESULT_FILE), scrub: scrubPairs(run.cfg, [[dir, '<RUN_DIR>']]) });
  },

  progress: (line, prev) => (/^check: \d+ violation/.test(line) ? { stage: 'python', pct: 90 } : /^check: verifying/.test(line) ? { stage: 'python', pct: 20 } : prev),

  failureReason: bridgeFailureReason('lunarnav check'),

  async onSuccess(p, run) {
    await run.setProgress('artifacts', 95);
    const r = await readJsonFile(path.join(run.jobDir, RESULT_FILE), BridgeResult);
    const violations = r.violations.map((v) => run.sanitize(v));
    const ok = violations.length === 0;
    await writeJsonArtifact(run.jobDir, CHECK_ARTIFACT, { run_id: p.run_id, ok, n_violations: violations.length, n_files: r.n_files, violations });
    const output = CheckJobOutput.parse({
      run_id: p.run_id,
      ok,
      n_violations: violations.length,
      n_files: r.n_files,
      violations: violations.slice(0, CHECK_OUTPUT_MAX_VIOLATIONS),
      truncated: violations.length > CHECK_OUTPUT_MAX_VIOLATIONS,
    });
    return { output };
  },
});
