/**
 * Spawn the Python interpreter (lunarnav) safely: execa WITHOUT a shell, args array, explicit cwd,
 * an ALLOW-LISTED environment, timeout + cancellation that kill the whole process tree, line-by-line
 * stdout/stderr callbacks.
 *
 * Windows: `.venv\Scripts\python.exe` is only a launcher that starts the base interpreter as a child.
 * Killing the launcher in the few ms before it resumed that child left a suspended orphan holding our
 * stdio pipes (so the job never finished and the queue slot stayed taken). resolveInterpreter() therefore
 * starts the BASE interpreter of the venv directly, with `__PYVENV_LAUNCHER__` = the venv python (exactly
 * what the launcher does, so sys.prefix / site-packages / sys.executable are the venv's). Killing uses
 * `taskkill /T /F` (lunarnav only spawns `git`). POSIX: SIGTERM, then SIGKILL after KILL_GRACE_MS (the
 * child is NOT detached, so a Ctrl-C of the server's process group also stops it).
 * Belt and braces: once a kill was requested, the wait for the child + stdio EOF is bounded
 * (STDIO_DRAIN_MS); after it the pipes are destroyed so the caller (and the job queue slot) never hangs.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { execa } from 'execa';

export const KILL_GRACE_MS = 3000;
/** After a kill: how long to wait for exit + stdio EOF before the pipes are destroyed. */
export const STDIO_DRAIN_MS = 5000;
const STDERR_TAIL_LINES = 40;

export interface RunPythonOptions {
  /** Interpreter (config.PYTHON_BIN). */
  bin: string;
  args: readonly string[];
  cwd: string;
  /** Extra environment, merged over the ALLOW-LISTED server env (inheritedPythonEnv: never MONGODB_URI). PYTHONUNBUFFERED / PYTHONIOENCODING are always set. */
  env?: Record<string, string>;
  /** Hard limit; the process tree is killed when it is exceeded. */
  timeoutMs: number;
  /** Abort = cancel (process tree killed, result.canceled = true). */
  signal?: AbortSignal;
  /** Written to stdin then stdin is closed (JSON for the bridge scripts). */
  input?: string;
  /** Keep the whole stdout in result.stdout (bridge scripts); off for long-running jobs. */
  captureStdout?: boolean;
  /** Upper bound for captured stdout (bytes); beyond it the process is killed and the run fails. */
  maxStdoutBytes?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface RunPythonResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  canceled: boolean;
  /** stdout exceeded maxStdoutBytes */
  overflow: boolean;
  /** The interpreter could not be started (ENOENT, EACCES...). */
  spawnError: string | null;
  stdout: string;
  stderrTail: string[];
  durationMs: number;
  pid: number | null;
}

/**
 * Variables of the server environment a Python child may see (least privilege: never MONGODB_URI or
 * other secrets). Matched case-insensitively (Windows env names are case-insensitive).
 */
const ENV_ALLOW = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'LANG', 'LANGUAGE', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_MAX_THREADS',
]);
const ENV_ALLOW_PREFIXES = ['LC_', 'PYTHON', 'LUNARNAV_', 'XDG_'];

/** Allow-listed part of `env` (default process.env). */
export function inheritedPythonEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (ENV_ALLOW.has(up) || ENV_ALLOW_PREFIXES.some((p) => up.startsWith(p))) out[k] = v;
  }
  return out;
}

export const pythonEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PYTHONUNBUFFERED: '1',
  PYTHONIOENCODING: 'utf-8', // Windows pipes default to the ANSI code page
  PYTHONUTF8: '1',
  ...extra,
});

export interface Interpreter {
  /** Executable actually spawned. */
  exe: string;
  /** Extra environment needed by that executable. */
  env: Record<string, string>;
}

const interpreterCache = new Map<string, Interpreter>();

/**
 * Windows venv launcher -> its base interpreter (see the header). Anything else (POSIX, a base
 * interpreter, a venv whose pyvenv.cfg cannot be read) is returned unchanged.
 */
export function resolveInterpreter(bin: string, platform: NodeJS.Platform = process.platform): Interpreter {
  const key = `${platform}|${bin}`;
  const hit = interpreterCache.get(key);
  if (hit) return hit;
  let res: Interpreter = { exe: bin, env: {} };
  if (platform === 'win32' && path.isAbsolute(bin) && /^pythonw?\.exe$/i.test(path.basename(bin)) && existsSync(bin)) {
    const cfgPath = path.join(path.dirname(path.dirname(bin)), 'pyvenv.cfg');
    try {
      const home = /^\s*home\s*=\s*(.+?)\s*$/im.exec(readFileSync(cfgPath, 'utf8'))?.[1];
      const base = home === undefined ? null : path.join(home, path.basename(bin));
      if (base !== null && existsSync(base) && path.resolve(base) !== path.resolve(bin)) {
        res = { exe: base, env: { __PYVENV_LAUNCHER__: bin } };
      }
    } catch {
      // not a venv (no pyvenv.cfg): spawn bin itself
    }
  }
  interpreterCache.set(key, res);
  return res;
}

/** PYTHONPATH with `dir` first (keeps an inherited PYTHONPATH after it). */
export function pythonPathWith(dir: string): string {
  const inherited = process.env['PYTHONPATH'];
  return inherited && inherited.length > 0 ? `${dir}${path.delimiter}${inherited}` : dir;
}

/** Kill a process and its children. Never throws. */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execa('taskkill', ['/PID', String(pid), '/T', '/F'], { reject: false, windowsHide: true, timeout: 10_000 });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already gone
  }
  await new Promise((r) => setTimeout(r, KILL_GRACE_MS));
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // exited after SIGTERM
  }
}

function readLines(stream: Readable | null | undefined, onLine: (line: string) => void): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (l) => onLine(l));
    rl.on('close', () => resolve());
    stream.on('error', () => resolve());
    stream.on('close', () => resolve()); // destroy() (STDIO_DRAIN_MS) emits close without end
  });
}

export async function runPython(opts: RunPythonOptions): Promise<RunPythonResult> {
  const t0 = performance.now();
  const maxStdout = opts.maxStdoutBytes ?? 16 * 1024 * 1024;
  let timedOut = false;
  let canceled = false;
  let overflow = false;
  let killing: Promise<void> | null = null;
  // On Windows a missing executable does not fail the spawn cleanly (exit code 1), so check absolute paths first.
  if (path.isAbsolute(opts.bin) && !existsSync(opts.bin)) {
    return { exitCode: null, signal: null, timedOut, canceled, overflow, spawnError: `interpreter not found: ${opts.bin}`, stdout: '', stderrTail: [], durationMs: 0, pid: null };
  }

  const interp = resolveInterpreter(opts.bin);
  const sub = execa(interp.exe, [...opts.args], {
    cwd: opts.cwd,
    env: { ...inheritedPythonEnv(), ...interp.env, ...pythonEnv(opts.env) },
    extendEnv: false,
    shell: false,
    reject: false,
    windowsHide: true,
    buffer: false,
    stdin: opts.input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    encoding: 'utf8',
  });
  const pid = sub.pid ?? null;

  let drainTimer: NodeJS.Timeout | null = null;
  /** Bound the wait after a kill: destroy the pipes if exit + EOF did not happen within STDIO_DRAIN_MS. */
  const armDrain = (): void => {
    if (drainTimer) return;
    drainTimer = setTimeout(() => {
      for (const st of [sub.stdout, sub.stderr, sub.stdin]) st?.destroy();
    }, STDIO_DRAIN_MS);
    drainTimer.unref();
  };
  const kill = (): void => {
    if (killing) return;
    killing = pid !== null ? killTree(pid) : Promise.resolve();
    void killing.then(armDrain);
    if (process.platform === 'win32') {
      try {
        sub.kill(); // fallback for the direct child (no-op if already dead)
      } catch {
        // ignore
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  const onAbort = (): void => {
    canceled = true;
    kill();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  if (opts.input !== undefined && sub.stdin) {
    sub.stdin.on('error', () => undefined); // EPIPE when the child exits early
    sub.stdin.end(opts.input, 'utf8');
  }

  const out: string[] = [];
  let outBytes = 0;
  const stderrTail: string[] = [];
  const stdoutDone = readLines(sub.stdout, (line) => {
    if (opts.captureStdout) {
      outBytes += Buffer.byteLength(line, 'utf8') + 1;
      if (outBytes > maxStdout) {
        if (!overflow) {
          overflow = true;
          kill();
        }
      } else {
        out.push(line);
      }
    }
    opts.onStdoutLine?.(line);
  });
  const stderrDone = readLines(sub.stderr, (line) => {
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    opts.onStderrLine?.(line);
  });

  const result = await sub;
  await Promise.all([stdoutDone, stderrDone]);
  clearTimeout(timer);
  if (drainTimer) clearTimeout(drainTimer);
  opts.signal?.removeEventListener('abort', onAbort);
  if (killing) await killing;

  const failed = result.failed && result.exitCode === undefined && !result.isTerminated && !timedOut && !canceled;
  return {
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut,
    canceled,
    overflow,
    spawnError: failed ? (result.originalMessage || result.shortMessage || 'spawn failed') : null,
    stdout: out.join('\n'),
    stderrTail,
    durationMs: Math.round(performance.now() - t0),
    pid,
  };
}
