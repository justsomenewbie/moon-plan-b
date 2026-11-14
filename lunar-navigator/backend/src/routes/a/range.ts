/**
 * Query ranges of group-A routes: snap [start, end) to the run grid (lib/time.ts snapRange) or
 * answer 422 OUT_OF_RANGE, plus window clipping to that range.
 */
import type { ClippedWindow, WindowKind } from '../../contract/common.ts';
import { ApiError } from '../../lib/problem.ts';
import { parseIsoUtc, parseIsoUtcCeil, snapRange, toIsoUtc, type SnappedRange } from '../../lib/time.ts';
import type { RunDoc, WindowDoc } from '../../repos/index.ts';

export interface RunRange extends SnappedRange {
  /** EXCLUSIVE end sample index (= i0 + n). */
  i1: number;
  /** true when the range is the whole run (stored metrics / summary.csv apply verbatim). */
  full: boolean;
}

export function resolveRange(run: Pick<RunDoc, 'start' | 'end' | 'step_s'>, start: string | undefined, end: string | undefined, where: 'querystring' | 'body'): RunRange {
  const runStart = run.start.getTime();
  const runEnd = run.end.getTime();
  const s = start === undefined ? runStart : parseIsoUtc(start);
  const e = end === undefined ? runEnd : parseIsoUtcCeil(end);
  const runSpan = `[${toIsoUtc(runStart)}, ${toIsoUtc(runEnd)})`;
  const outside = (path: 'start' | 'end', t: number): ApiError =>
    new ApiError('OUT_OF_RANGE', `${path} ${toIsoUtc(t)} is outside the run ${runSpan}`, {
      errors: [{ path, in: where, message: path === 'start' ? `must be < ${toIsoUtc(runEnd)}` : `must be > ${toIsoUtc(runStart)}` }],
      extensions: { run_start_utc: toIsoUtc(runStart), run_end_utc: toIsoUtc(runEnd) },
    });
  if (start !== undefined && s >= runEnd) throw outside('start', s);
  if (end !== undefined && e <= runStart) throw outside('end', e);
  if (e <= s) {
    throw new ApiError('OUT_OF_RANGE', `end ${toIsoUtc(e)} must be after start ${toIsoUtc(s)}`, {
      errors: [{ path: 'end', in: where, message: 'must be after start' }],
    });
  }
  const r = snapRange(s, e, runStart, runEnd, run.step_s);
  if (!r) {
    throw new ApiError('OUT_OF_RANGE', `range [${toIsoUtc(s)}, ${toIsoUtc(e)}) does not overlap the run ${runSpan}`, {
      errors: [{ path: s >= runEnd ? 'start' : 'end', in: where, message: `must overlap ${runSpan}` }],
      extensions: { run_start_utc: toIsoUtc(runStart), run_end_utc: toIsoUtc(runEnd) },
    });
  }
  return { ...r, i1: r.i0 + r.n, full: r.startMs === runStart && r.endMs === runEnd };
}

export const timeRange = (r: RunRange, stepS: number) => ({
  start: toIsoUtc(r.startMs),
  end: toIsoUtc(r.endMs),
  step_s: stepS,
  n_samples: r.n,
});

/** Windows overlapping [startMs, endMs) intersected with it (clipped_* vs truncated_* = run boundary). */
export function clipWindows(list: readonly WindowDoc[], startMs: number, endMs: number): ClippedWindow[] {
  const out: ClippedWindow[] = [];
  for (const w of list) {
    const ws = w.start.getTime();
    const we = w.end.getTime();
    if (!(ws < endMs && we > startMs)) continue;
    const s = Math.max(ws, startMs);
    const e = Math.min(we, endMs);
    out.push({
      start: toIsoUtc(s),
      end: toIsoUtc(e),
      duration_h: (e - s) / 3_600_000,
      state: w.state,
      truncated_start: w.truncated_start,
      truncated_end: w.truncated_end,
      clipped_start: s > ws,
      clipped_end: e < we,
    });
  }
  return out;
}

export function clipByKind(byKind: Partial<Record<WindowKind, WindowDoc[]>>, kinds: readonly WindowKind[], startMs: number, endMs: number): Partial<Record<WindowKind, ClippedWindow[]>> {
  const out: Partial<Record<WindowKind, ClippedWindow[]>> = {};
  for (const k of kinds) out[k] = clipWindows(byKind[k] ?? [], startMs, endMs);
  return out;
}
