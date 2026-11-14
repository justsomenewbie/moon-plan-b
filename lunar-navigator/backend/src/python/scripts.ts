/**
 * argv / env builders for Python children (docs/PYTHON_INTEGRATION.md section 7). Every job type and
 * tool builds its command line with these and runs it through runPython() (process.ts: no shell, args
 * array, timeout, kill tree, env allow-list).
 *
 * Rules
 *  - Values never go through a shell; still, build options as ONE element `--flag=value` (flagArg) so a
 *    value starting with '-' (latitudes, ids) can never be parsed as an option by argparse.
 *  - Paths given to Python are computed by the server (job dir, run dir resolved through src/repos), never
 *    taken from the request. assertArgValue() rejects NUL / newlines / over-long values as a last guard.
 *  - Bridge scripts live in backend/python/ and only IMPORT lunarnav (PYTHONPATH = LUNARNAV_ROOT).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BACKEND_ROOT, type Config } from '../config.ts';
import { lunarnavDataDir } from './lunarnav.ts';
import { pythonPathWith } from './process.ts';

export const BACKEND_PYTHON_DIR = path.join(BACKEND_ROOT, 'python');
const SCRIPT_RE = /^[a-z][a-z0-9_]{0,63}\.py$/;
const SUBCOMMAND_RE = /^[a-z][a-z-]{0,31}$/;
const FLAG_RE = /^--[a-z][a-z0-9-]{0,63}$/;
export const MAX_ARG_LENGTH = 8192;

/** Throws when a value is unsafe as one argv element (NUL, CR/LF, too long). Returns it unchanged. */
export function assertArgValue(v: string): string {
  if (v.length > MAX_ARG_LENGTH) throw new RangeError(`argument longer than ${MAX_ARG_LENGTH} characters`);
  if (/[\0\r\n]/.test(v)) throw new RangeError('argument contains NUL or a line break');
  return v;
}

/** `--flag=value` as one argv element (numbers via String(); booleans are not values: use a bare flag). */
export function flagArg(flag: string, value: string | number): string {
  if (!FLAG_RE.test(flag)) throw new RangeError(`bad flag ${flag}`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`${flag}: value must be finite`);
  return `${flag}=${assertArgValue(String(value))}`;
}

/** Absolute path of backend/python/<name> (validated name, must exist). */
export function bridgeScriptPath(name: string): string {
  if (!SCRIPT_RE.test(name)) throw new RangeError(`bad bridge script name ${name}`);
  const p = path.join(BACKEND_PYTHON_DIR, name);
  if (!existsSync(p)) throw new Error(`bridge script missing: backend/python/${name}`);
  return p;
}

/** `-u backend/python/<script> ...args` */
export const bridgeScriptArgs = (script: string, args: readonly string[] = []): string[] => ['-u', bridgeScriptPath(script), ...args.map(assertArgValue)];

/** `-u -m lunarnav.cli <subcommand> ...args` (cwd must be LUNARNAV_ROOT, see lunarnavCwd). */
export function lunarnavCliArgs(subcommand: string, args: readonly string[] = []): string[] {
  if (!SUBCOMMAND_RE.test(subcommand)) throw new RangeError(`bad lunarnav sub-command ${subcommand}`);
  return ['-u', '-m', 'lunarnav.cli', subcommand, ...args.map(assertArgValue)];
}

/** cwd of every lunarnav child: LUNARNAV_ROOT (so `-m lunarnav...` imports that package). */
export const lunarnavCwd = (cfg: Pick<Config, 'LUNARNAV_ROOT'>): string => cfg.LUNARNAV_ROOT;

/**
 * Extra env of a child (merged over the allow-listed server env by runPython): LUNARNAV_DATA always,
 * PYTHONPATH = LUNARNAV_ROOT for bridge scripts (their sys.path[0] is backend/python), LUNARNAV_OUTPUT
 * = the job dir when given.
 */
export function lunarnavEnv(
  cfg: Pick<Config, 'LUNARNAV_ROOT'>,
  opts: { jobDir?: string; bridge?: boolean; extra?: Record<string, string> } = {},
): Record<string, string> {
  const env: Record<string, string> = { LUNARNAV_DATA: lunarnavDataDir(cfg) };
  if (opts.jobDir !== undefined) env['LUNARNAV_OUTPUT'] = opts.jobDir;
  if (opts.bridge) env['PYTHONPATH'] = pythonPathWith(cfg.LUNARNAV_ROOT);
  return { ...env, ...(opts.extra ?? {}) };
}
