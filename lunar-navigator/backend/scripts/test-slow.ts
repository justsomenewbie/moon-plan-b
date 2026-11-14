/**
 * `npm run test:slow`: the opt-in real end-to-end tests (every tests/**\/*.slow.test.ts: custom_site,
 * precompute / analyse / alt_dates_python, check / validate / compare_runs, tools + horizon_mask; real
 * lunarnav, ~1-2 min), cross-platform (sets RUN_SLOW=1 without cross-env).
 * Arguments are vitest file filters / flags and replace the default filter, e.g.
 * `npm run test:slow -- tests/tools.slow.test.ts`.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const filters = args.some((a) => !a.startsWith('-')) ? [] : ['.slow.test.ts'];
const r = spawnSync('npx', ['vitest', 'run', ...filters, ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, RUN_SLOW: '1' },
});
process.exit(r.status ?? 1);
