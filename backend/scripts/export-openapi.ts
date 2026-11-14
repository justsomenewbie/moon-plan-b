/**
 * `npm run openapi:export` -> contract/openapi.json (commit it; every contract change shows in git diff).
 * Boots the app WITHOUT a database, so it runs anywhere (CI included). Output is deterministic.
 * `--check` exits 1 if the committed file differs from the generated one.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'contract', 'openapi.json');

const app = await buildApp({ db: 'none', logger: false, config: { LOG_LEVEL: 'silent', NODE_ENV: 'test' } });
await app.ready();
const spec = `${JSON.stringify(app.swagger(), null, 2)}\n`;
await app.close();

if (process.argv.includes('--check')) {
  const current = await readFile(out, 'utf8').catch(() => '');
  if (current !== spec) {
    console.error(`${out} is out of date - run npm run openapi:export`);
    process.exit(1);
  }
  console.log(`${out} is up to date`);
} else {
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, spec, 'utf8');
  const doc = JSON.parse(spec) as { paths: Record<string, Record<string, unknown>>; components?: { schemas?: Record<string, unknown> } };
  const ops = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(`wrote ${out}: ${Object.keys(doc.paths).length} paths, ${ops} operations, ${Object.keys(doc.components?.schemas ?? {}).length} schemas, ${spec.length} bytes`);
}
