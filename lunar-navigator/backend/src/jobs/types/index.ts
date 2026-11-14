/**
 * Job-type registry (docs/PYTHON_INTEGRATION.md section 2). ONE file per job type under src/jobs/types/,
 * each exporting a `JobTypeDef` built with defineJobType(); the engine (src/jobs/runner.ts) knows nothing
 * type-specific: it validates (CreateJobRequest union, src/contract/jobs.ts), canonicalizes + hashes
 * (def.canonicalize), queues, runs Python (def.planPython -> runPython), then def.onSuccess (import a run
 * and/or write artifacts + a small output summary), and the artifacts store (src/jobs/artifacts.ts)
 * registers DATA_DIR/jobs/<id>/artifacts/*.
 *
 * Lifecycle of one job (all types):
 *   POST -> zod (union) -> def.implemented? (501 JOB_TYPE_UNAVAILABLE) -> def.available(caps)? (501)
 *        -> def.canonicalize(req) (ApiError 4xx) -> params_hash = sha256(v, code_version, params)
 *        -> cache hit (def.limits.cacheable, def.reusable) | join active | queue (429 limits)
 *   run  -> status running, stage def.pythonStage -> runPython(def.planPython(...)) with timeout
 *           def.limits.timeout_s ?? JOB_TIMEOUT_S, stdout/stderr -> <logName> + progress (def.progress)
 *        -> exit 0: def.onSuccess(...) -> collectArtifacts() -> succeeded {result, output, artifacts}
 *           exit != 0 / timeout / spawn error -> failed {PYTHON_FAILED | PYTHON_TIMEOUT | PYTHON_UNAVAILABLE}
 *           onSuccess throws JobFailure(code) -> failed {code}; any other error -> failed RESULT_FAILED
 */
import { JOB_TYPES, type JobType } from '../../contract/jobs.ts';
import { ApiError } from '../../lib/problem.ts';
import type { AnyJobTypeDef } from './define.ts';
import { altDatesPythonJob } from './alt_dates_python.ts';
import { analyseJob } from './analyse.ts';
import { checkJob } from './check.ts';
import { compareRunsJob } from './compare_runs.ts';
import { customSiteJob } from './custom_site.ts';
import { horizonMaskJob } from './horizon_mask.ts';
import { precomputeJob } from './precompute.ts';
import { validateJob } from './validate.ts';
import { validateTerrainJob } from './validate_terrain.ts';

export * from './define.ts';

export const JOB_TYPE_REGISTRY: Readonly<Record<JobType, AnyJobTypeDef>> = {
  custom_site: customSiteJob,
  precompute: precomputeJob,
  analyse: analyseJob,
  alt_dates_python: altDatesPythonJob,
  check: checkJob,
  validate: validateJob,
  validate_terrain: validateTerrainJob,
  compare_runs: compareRunsJob,
  horizon_mask: horizonMaskJob,
};

const overrides = new Map<JobType, AnyJobTypeDef>();

/**
 * Test seam: replace the def of a type (null = back to the registry). Per process (vitest forks per
 * file). Lets engine tests run a fake job type through the real POST /jobs route.
 */
export function overrideJobType(type: JobType, def: AnyJobTypeDef | null): void {
  if (def === null) overrides.delete(type);
  else overrides.set(type, def);
}

/** Def of a type (throws JOB_TYPE_UNAVAILABLE for a type that is not registered, e.g. an old document). */
export function jobTypeDef(type: string): AnyJobTypeDef {
  const def = overrides.get(type as JobType) ?? (JOB_TYPE_REGISTRY as Record<string, AnyJobTypeDef | undefined>)[type];
  if (!def || def.type !== type) throw new ApiError('JOB_TYPE_UNAVAILABLE', `unknown job type ${type}`);
  return def;
}

export const listJobTypes = (): AnyJobTypeDef[] => JOB_TYPES.map((t) => overrides.get(t) ?? JOB_TYPE_REGISTRY[t]);
