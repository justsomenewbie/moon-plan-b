/**
 * `lunarnav precompute` for one job (plan 7.1): argv builder + text-progress parser.
 *
 * The site is passed as `--sites <id>` (catalog id or canonical `custom:<lat>:<lon>`): the CLI's
 * `--custom-site ID:LAT:LON` form splits on ':' and its id regex rejects ':' (plan 7.1 workaround).
 * `--dem-fallback flat` gives a smooth-sphere horizon (recorded in dem_source) outside DEM coverage
 * instead of failing. The CLI runs check_output at the end; exit != 0 = failed job.
 */
import type { CanonicalJobParams, JobStage } from '../jobs/types.ts';

export interface PrecomputeArgs {
  params: CanonicalJobParams;
  outDir: string;
  /** Written to the manifest (run_timestamp_utc) - the job's created_at keeps reruns reproducible. */
  runTimestamp: string;
}

/** Python argv after the interpreter (no shell; every value is its own element). */
export function precomputeArgv(a: PrecomputeArgs): string[] {
  const p = a.params;
  return [
    '-u',
    '-m',
    'lunarnav.cli',
    'precompute',
    '--sites',
    p.site_id,
    '--start',
    p.start,
    '--end',
    p.end,
    '--step-min',
    String(p.step_min),
    '--provider',
    p.provider,
    '--dem',
    p.dem,
    '--horizon-method',
    p.horizon_method,
    '--observer-height',
    String(p.observer_height_m),
    '--dem-fallback',
    'flat',
    '--out',
    a.outDir,
    '--run-timestamp',
    a.runTimestamp,
  ];
}

export interface ProgressState {
  stage: JobStage;
  pct: number | null;
}

/**
 * Coarse progress from the CLI's text lines (lunarnav prints no JSON progress):
 *   started 5 -> "[k/n] <site>: horizon + ephemeris + visibility" 10..80 -> "wrote <dir>" 85
 *   -> "check_output: ..." 92 -> import 95 -> done 100.
 */
export function progressFromLine(line: string, prev: ProgressState): ProgressState {
  const site = /^\[(\d+)\/(\d+)\]\s/.exec(line);
  if (site) {
    const k = Number(site[1]);
    const n = Math.max(1, Number(site[2]));
    return { stage: 'precompute', pct: Math.max(prev.pct ?? 0, Math.round(10 + (70 * (k - 1)) / n)) };
  }
  if (line.startsWith('wrote ')) return { stage: 'precompute', pct: Math.max(prev.pct ?? 0, 85) };
  if (line.startsWith('check_output:')) return { stage: 'precompute', pct: Math.max(prev.pct ?? 0, 92) };
  return prev;
}

/** Most useful one-line reason from a failed run's output. */
export function failureReason(lines: readonly string[], exitCode: number | null): string {
  const violations = lines.filter((l) => l.startsWith('VIOLATION:'));
  if (violations.length > 0) return `check_output failed: ${violations.length} violation(s), first: ${violations[0]?.slice(10).trim() ?? ''}`;
  const meaningful = [...lines].reverse().find((l) => l.trim().length > 0 && !/^\s*(File |Traceback|\^)/.test(l));
  return meaningful ? meaningful.trim().slice(0, 500) : `lunarnav precompute exited with code ${String(exitCode)}`;
}
