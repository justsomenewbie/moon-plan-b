/**
 * Job-type definition API (docs/PYTHON_INTEGRATION.md section 2): the interface every
 * src/jobs/types/<type>.ts implements, plus defineJobType() / placeholderJobType() / JobFailure.
 * The registry itself is ./index.ts (kept separate so type files never import the registry: no cycle).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Capabilities } from '../../contract/capabilities.ts';
import type { CreateJobRequest, JobStage, JobType } from '../../contract/jobs.ts';
import { ApiError } from '../../lib/problem.ts';
import type { ArtifactLimits } from '../artifacts.ts';
import type { RunnerConfig } from '../runner.ts';
import type { AnyJobParams, JobDoc } from '../types.ts';

export interface JobTypeLimits {
  /** Python timeout, seconds (default: config JOB_TIMEOUT_S). */
  timeout_s?: number;
  /** Lifetime of a succeeded job + its artifacts / imported run, hours (default: CUSTOM_RUN_TTL_DAYS * 24). */
  result_ttl_h?: number;
  /** Reuse an identical succeeded job (200 cached). Default true; false for results that must be fresh. */
  cacheable?: boolean;
  /** Artifact store limits (defaults: artifacts.ts ARTIFACT_LIMITS). */
  artifacts?: Partial<ArtifactLimits>;
  /** Request limits shown in GET /capabilities job_types[].limits (max sites x samples, max range...). */
  public?: Record<string, unknown>;
  /**
   * The job imports a run into DATA_DIR/runs/job_<id> (custom_site, precompute): a NEW job of this type is
   * checked against the job-run storage budget (JOB_RUNS_MAX_*, DATA_DIR_MIN_FREE_MB) when it is queued.
   */
  creates_run?: boolean;
}

/** Config of JobTypeDef.resultTtlH(). */
export type TtlConfig = Pick<RunnerConfig, 'CUSTOM_RUN_TTL_DAYS'> & Partial<Pick<RunnerConfig, 'PRECOMPUTE_RUN_TTL_DAYS'>>;

/** Given to canonicalize() at POST time. */
export interface SubmitContext {
  cfg: RunnerConfig;
  /** lunarnav catalog ids (null = catalog unreadable: let Python validate). */
  catalogIds: () => Promise<Set<string> | null>;
  /** Cached GET /capabilities document (probes Python / network on first use). */
  capabilities: () => Promise<Capabilities>;
}

/** Given to planPython() / onSuccess() while the job runs. */
export interface RunContext {
  jobId: string;
  createdAt: Date;
  /** Display name of the creator (label of an imported run). */
  name: string | null;
  cfg: RunnerConfig;
  log: FastifyBaseLogger;
  /** DATA_DIR/jobs/<id>/ (exists; = LUNARNAV_OUTPUT of the child; scratch of the type). */
  jobDir: string;
  /** DATA_DIR/jobs/<id>/artifacts/ (exists): files here are published when the job succeeds. */
  artifactsDir: string;
  /** DATA_DIR/runs/job_<id>/ - where import types write the run (removed on failure / cancel). */
  outDir: string;
  /** job_<id> - run id of an imported result. */
  runId: string;
  /** Replace server paths (DATA_DIR, LUNARNAV_ROOT) by placeholders; cut long strings. Use on any text shown to clients. */
  sanitize: (s: string) => string;
  /** Write a progress stage / pct now (e.g. 'import', 95). */
  setProgress: (stage: JobStage, pct: number | null) => Promise<void>;
  /** Aborted when the job is cancelled / the server stops. */
  signal: AbortSignal;
}

export interface PythonPlan {
  /** argv after the interpreter (src/python/scripts.ts lunarnavCliArgs / bridgeScriptArgs). */
  args: string[];
  /** Extra env (src/python/scripts.ts lunarnavEnv). LUNARNAV_DATA / LUNARNAV_OUTPUT default to the job's. */
  env?: Record<string, string>;
  /** Written to stdin (JSON for bridge scripts). */
  input?: string;
  /** Default: cfg.LUNARNAV_ROOT. */
  cwd?: string;
  /** Overrides def.limits.timeout_s for this run. */
  timeoutS?: number;
}

export interface PythonRunInfo {
  /** Last <= 50 non-empty stdout/stderr lines (sanitized). */
  lines: string[];
  stderrTail: string[];
  durationMs: number;
}

export interface JobOutcome {
  /** Imported run (custom_site / precompute); omitted = null. */
  result?: { run_id: string; site_id: string } | null;
  /** Small JSON summary (validate it with the type's output schema before returning). */
  output?: Record<string, unknown> | null;
  /** Default: now + result_ttl_h. */
  expiresAt?: Date;
}

export interface ProgressState {
  stage: JobStage;
  pct: number | null;
}

/** Throw from onSuccess to fail the job with a specific error code (e.g. IMPORT_FAILED). */
export class JobFailure extends Error {
  override name = 'JobFailure';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * One job type. Methods use method syntax on purpose (bivariant parameters): a def typed for its own
 * request / params is stored in the registry as JobTypeDef<CreateJobRequest, AnyJobParams>.
 */
export interface JobTypeDef<Req extends CreateJobRequest = CreateJobRequest, P extends AnyJobParams = AnyJobParams> {
  type: JobType;
  /** false = placeholder: POST answers 501 JOB_TYPE_UNAVAILABLE. */
  implemented: boolean;
  /** Who owns the file (docs). */
  owner: string;
  summary: string;
  /** Used in messages, e.g. 'lunarnav precompute' -> "lunarnav precompute exceeded 1200 s". */
  label: string;
  /** Log file in the job dir. */
  logName: string;
  /** Progress stage while Python runs. */
  pythonStage: JobStage;
  limits: JobTypeLimits;
  /** Config-dependent lifetime of a succeeded job, hours (wins over limits.result_ttl_h). */
  resultTtlH?(cfg: TtlConfig): number;
  /** Server-side availability (Trek files, modules, CLI flags...); return a reason when unavailable. */
  available?(caps: Capabilities): string | null;
  /** Request (after zod defaults) -> canonical params (hashed; plain JSON). Throw ApiError for 4xx. */
  canonicalize(req: Req, ctx: SubmitContext): P | Promise<P>;
  /** Site shown in JobAccepted / Job.site_id (null: no single site). */
  siteId(params: P): string | null;
  planPython(params: P, run: RunContext): PythonPlan | Promise<PythonPlan>;
  /** stdout line -> progress (default: keep stage, pct unchanged). */
  progress?(line: string, prev: ProgressState): ProgressState;
  /** One-line reason of a failed run (default: last meaningful line). */
  failureReason?(lines: readonly string[], exitCode: number | null): string;
  onSuccess(params: P, run: RunContext, py: PythonRunInfo): Promise<JobOutcome>;
  /** The job was cancelled after onSuccess (e.g. drop an imported run). */
  onDiscard?(params: P, run: RunContext, outcome: JobOutcome): Promise<void>;
  /** Whether a succeeded job may still be served as a cache hit (default: its imported run is ready, if any). */
  reusable?(doc: JobDoc): Promise<boolean>;
}

export type AnyJobTypeDef = JobTypeDef<CreateJobRequest, AnyJobParams>;

/** Identity helper that erases the def's own request / params types for the registry. */
export function defineJobType<Req extends CreateJobRequest, P extends AnyJobParams>(def: JobTypeDef<Req, P>): AnyJobTypeDef {
  return def as unknown as AnyJobTypeDef;
}

/** A registered, not yet implemented job type (the builder replaces the whole def in its own file). */
export function placeholderJobType(type: Exclude<JobType, 'custom_site'>, owner: string, summary: string): AnyJobTypeDef {
  const unavailable = (): never => {
    throw new ApiError('JOB_TYPE_UNAVAILABLE', `job type ${type} is not implemented yet`, {
      hint: 'GET /api/v1/capabilities lists the job types this server runs',
      extensions: { job_type: type },
    });
  };
  return {
    type,
    implemented: false,
    owner,
    summary,
    label: `job ${type}`,
    logName: `${type}.log`,
    pythonStage: 'python',
    limits: {},
    available: () => 'not implemented yet',
    canonicalize: unavailable,
    siteId: () => null,
    planPython: unavailable,
    onSuccess: unavailable,
  };
}

