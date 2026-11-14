/** `jobs` collection document (plan 5.3) and the canonical job parameters. */
import type { JobArtifact, JobStage, JobStatus, JobType } from '../contract/jobs.ts';

export type { JobStage } from '../contract/jobs.ts';

/** Everything that determines a custom_site computation (hashed into params_hash), after defaults + canonicalisation. */
export interface CanonicalJobParams {
  type: 'custom_site';
  site_id: string;
  /** Rounded coordinates of a custom site (null for catalog sites). */
  lat_deg: number | null;
  lon_deg: number | null;
  /** Snapped to the step grid (UTC hours), `end` exclusive. */
  start: string;
  end: string;
  step_min: 60;
  provider: 'spice' | 'horizons' | 'analytic';
  dem: 'pgda' | 'trek' | 'none';
  horizon_method: 'raymarch' | 'bruteforce' | 'flat';
  observer_height_m: number;
}

/**
 * Canonical parameters of any other job type (src/jobs/types/<type>.ts defines the exact shape).
 * Plain JSON (it is stored in Mongo, hashed and shown in Job.params).
 */
export interface GenericJobParams {
  type: Exclude<JobType, 'custom_site'>;
  [key: string]: unknown;
}

export type AnyJobParams = CanonicalJobParams | GenericJobParams;

export interface JobError {
  code: string;
  message: string;
}

/** A client waiting on a job (identical POSTs from several clients share one job). */
export interface JobSubscriber {
  /** lib/client.ts clientKey() of the request. */
  client: string;
  /** Display name that client sent (not part of the hash). */
  name: string | null;
  at: Date;
}

/** Artifact metadata stored on the job (the file is DATA_DIR/jobs/<id>/artifacts/<name>). */
export type StoredArtifact = Omit<JobArtifact, 'url'>;

export interface JobDoc {
  _id: string;
  type: JobType;
  status: JobStatus;
  /** Present (true) only while queued/running: a unique partial index merges identical active jobs. */
  active?: true;
  params: AnyJobParams;
  /** Display name of the client that created the job (not part of the hash). */
  name: string | null;
  /**
   * Clients waiting on the job while it is queued/running. DELETE removes the caller only; the Python
   * process is killed when the last one leaves. Missing on jobs written before subscriptions existed.
   */
  subscribers?: JobSubscriber[];
  /** clientKey of the client that created the job (storage quota of job runs). Missing on older jobs. */
  creator?: string;
  /** Bytes on disk of the run the job imported (DATA_DIR/runs/job_<id>), measured when it succeeded. */
  run_bytes?: number | null;
  params_hash: string;
  code_version: string;
  progress: { stage: JobStage; pct: number | null; lines: string[] };
  stderr_tail: string[];
  /** Imported run (custom_site / precompute). */
  result: { run_id: string; site_id: string } | null;
  /** Small JSON summary of a succeeded job (type-specific). Missing on jobs written before job types existed. */
  output?: Record<string, unknown> | null;
  /** Files in DATA_DIR/jobs/<id>/artifacts/ registered when the job succeeded. Missing = none. */
  artifacts?: StoredArtifact[];
  error: JobError | null;
  /** Server instance that runs it (informational; recovery fails every job left active at boot). */
  owner: string | null;
  duration_ms: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  /** When the job (and for succeeded jobs, its custom run) is deleted. TTL index + cleanup. */
  expires_at: Date | null;
}

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
export const isTerminal = (s: JobStatus): boolean => TERMINAL_STATUSES.includes(s);

/** Run id of a job's imported result. */
export const jobRunId = (jobId: string): string => `job_${jobId}`;
