/**
 * Import gate (plan section 8 step 2): `PYTHON_BIN -u -m lunarnav.cli check <dir>` must exit 0.
 * Spawned with execa (argument array, no shell). Output lines `VIOLATION: ...` are collected.
 */
import { execa } from 'execa';
import { inheritedPythonEnv, pythonEnv, resolveInterpreter } from '../python/process.ts';

export interface PythonCheckOptions {
  pythonBin: string;
  /** Working directory (the lunarnav checkout, LUNARNAV_ROOT). */
  cwd: string;
  timeoutMs?: number;
}

export interface PythonCheckResult {
  /** true = exit 0 and no violation lines. */
  ok: boolean;
  exitCode: number | null;
  violations: string[];
  /** Last line printed (e.g. "<dir>: 0 violation(s)"). */
  summary: string;
  /** Spawn failure / timeout reason, else null. */
  failure: string | null;
  duration_ms: number;
}

export async function runPythonCheck(dir: string, opts: PythonCheckOptions): Promise<PythonCheckResult> {
  const t0 = performance.now();
  const interp = resolveInterpreter(opts.pythonBin);
  const r = await execa(interp.exe, ['-u', '-m', 'lunarnav.cli', 'check', dir], {
    cwd: opts.cwd,
    // allow-listed env only (no MONGODB_URI), like every other Python child (src/python/process.ts)
    env: { ...inheritedPythonEnv(), ...interp.env, ...pythonEnv() },
    extendEnv: false,
    timeout: opts.timeoutMs ?? 600_000,
    reject: false,
    all: true,
    stdin: 'ignore',
  });
  const out = typeof r.all === 'string' ? r.all : '';
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const violations = lines.filter((l) => l.startsWith('VIOLATION:')).map((l) => l.slice('VIOLATION:'.length).trim());
  const exitCode = typeof r.exitCode === 'number' ? r.exitCode : null;
  let failure: string | null = null;
  if (r.timedOut) failure = `lunarnav check timed out after ${opts.timeoutMs ?? 600_000} ms`;
  else if (r.failed && exitCode === null) failure = `cannot run ${opts.pythonBin}: ${r.shortMessage}`;
  else if (exitCode !== 0 && violations.length === 0) failure = `lunarnav check exited with ${String(exitCode)}: ${lines.slice(-5).join(' | ')}`;
  return {
    ok: failure === null && exitCode === 0 && violations.length === 0,
    exitCode,
    violations,
    summary: lines.at(-1) ?? '',
    failure,
    duration_ms: Math.round(performance.now() - t0),
  };
}
