/**
 * Shared helpers of the B3 report job types (check, validate, validate_terrain, compare_runs).
 * OWNER: builder B3 (reports). Python bridges: backend/python/{check_json,validate_json,
 * validate_terrain_json,compare_runs}.py (+ b3_common.py).
 *
 * Every bridge reads ONE JSON request on stdin, built here from server-computed paths only (job dir,
 * run directories resolved through src/repos), and writes JSON files that onSuccess zod-validates.
 */
import path from 'node:path';
import { z } from 'zod';
import type { Capabilities } from '../../contract/capabilities.ts';
import { getRun, type RunDoc } from '../../repos/index.ts';
import { bridgeScriptArgs, lunarnavEnv } from '../../python/scripts.ts';
import { runDirectory } from '../../python/runFiles.ts';
import type { RunnerConfig } from '../runner.ts';
import { JobFailure, type PythonPlan, type RunContext } from './define.ts';

/** [absolute path, placeholder] pairs the bridges replace in every string they write (longest first). */
export function scrubPairs(cfg: Pick<RunnerConfig, 'DATA_DIR' | 'LUNARNAV_ROOT'>, extra: readonly (readonly [string, string])[] = []): [string, string][] {
  return [...extra.map(([p, l]): [string, string] => [path.resolve(p), l]), [path.resolve(cfg.DATA_DIR), '<DATA_DIR>'], [path.resolve(cfg.LUNARNAV_ROOT), '<LUNARNAV_ROOT>']];
}

/** Plan of a backend/python/<script> bridge: JSON request on stdin, PYTHONPATH = LUNARNAV_ROOT. */
export function bridgePlan(run: RunContext, script: string, input: Record<string, unknown>, timeoutS?: number): PythonPlan {
  return {
    args: bridgeScriptArgs(script),
    env: lunarnavEnv(run.cfg, { jobDir: run.jobDir, bridge: true }),
    input: JSON.stringify(input),
    ...(timeoutS === undefined ? {} : { timeoutS }),
  };
}

const BridgeError = z.object({ ok: z.literal(false), error: z.object({ type: z.string(), message: z.string() }) });

/**
 * One-line reason of a failed bridge: the `{"ok": false, "error": ...}` line a bridge prints for bad input,
 * else the last meaningful line (exception text of a traceback), else the exit code.
 */
export function bridgeFailureReason(label: string) {
  return (lines: readonly string[], exitCode: number | null): string => {
    for (const l of [...lines].reverse()) {
      const t = l.trim();
      if (!t.startsWith('{')) continue;
      try {
        const r = BridgeError.safeParse(JSON.parse(t));
        if (r.success) return r.data.error.message.slice(0, 500);
      } catch {
        // not JSON
      }
    }
    const meaningful = [...lines].reverse().find((l) => l.trim().length > 0 && !/^\s*(File |Traceback|\^|~)/.test(l) && !l.startsWith('[stderr]'));
    return meaningful ? meaningful.trim().slice(0, 500) : `${label} exited with code ${String(exitCode)}`;
  };
}

/** Reason a bridge needing these Python modules cannot run (null = available). */
export function needModules(caps: Capabilities, modules: readonly string[]): string | null {
  if (!caps.python.ok) return `Python / lunarnav unavailable: ${caps.python.error ?? 'unknown error'}`;
  const missing = modules.filter((m) => caps.modules[m] !== true);
  return missing.length > 0 ? `missing Python module(s): ${missing.join(', ')}` : null;
}

/**
 * The run a queued job reads, as it is NOW: still ready and the same import (manifest sha256) as when
 * the job was submitted. Throws JobFailure RUN_NOT_FOUND / RUN_NOT_READY / RUN_CHANGED.
 */
export async function currentRun(runId: string, manifestSha256: string): Promise<RunDoc> {
  const run = await getRun(runId);
  if (!run) throw new JobFailure('RUN_NOT_FOUND', `run ${runId} was deleted after the job was submitted`);
  if (run.status !== 'ready') throw new JobFailure('RUN_NOT_READY', `run ${runId} is ${run.status}`);
  if (run.manifest_sha256 !== manifestSha256) throw new JobFailure('RUN_CHANGED', `run ${runId} was re-imported with other contents after the job was submitted; submit the job again`);
  return run;
}

/** Whether a cached job's runs are all still there unchanged (JobTypeDef.reusable). */
export async function runsUnchanged(runs: readonly { run_id: string; manifest_sha256: string }[]): Promise<boolean> {
  for (const r of runs) {
    const doc = await getRun(r.run_id);
    if (doc?.status !== 'ready' || doc.manifest_sha256 !== r.manifest_sha256) return false;
  }
  return true;
}

/** Absolute directory of a run's files. */
export const runDir = (run: RunDoc, cfg: Pick<RunnerConfig, 'DATA_DIR'>): string => runDirectory(run, cfg.DATA_DIR);

/** Progress from `<prefix>: site i/n` style lines: pct in [lo, hi]. */
export function fractionProgress(line: string, re: RegExp, lo: number, hi: number): number | null {
  const m = re.exec(line);
  if (!m) return null;
  const i = Number(m[1]);
  const n = Number(m[2]);
  if (!(n > 0)) return null;
  return Math.round(lo + ((hi - lo) * Math.min(i, n)) / n);
}
