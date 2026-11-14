/**
 * Importer CLI (plan section 8):
 *
 *   node --env-file-if-exists=.env scripts/import-run.ts <output_dir> [options]
 *
 *   --run-id <id>     run id (default pf_<params_fingerprint>)
 *   --label "<text>"  label shown in the run picker
 *   --default         make this the default run (is_default)
 *   --force           import despite check violations / checksum mismatches, re-import an unchanged run
 *   --dry-run         validate + parse everything, write nothing
 *   --no-check        skip `python -m lunarnav.cli check` (not recommended)
 *   --no-copy         import in place instead of copying to DATA_DIR/runs/<run_id>/
 *   --kind <k>        precompute (default) | custom
 *   --stats           print collection sizes (collStats / dbStats) after the import
 *
 * Env (src/config.ts): MONGODB_URI, MONGODB_DB, DATA_DIR, PYTHON_BIN, LUNARNAV_ROOT.
 * Exit codes: 0 ok / skipped, 1 error, 2 refused by the gate, 3 post-import verification failed.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { closeDb, connectDb } from '../src/db.ts';
import { ImportRefusedError, ImportVerificationError, importRun, type ImportLogger } from '../src/importer/importRun.ts';
import { collectionSizes, formatBytes } from '../src/importer/stats.ts';

const USAGE = 'usage: npm run import -- <output_dir> [--run-id ID] [--label TEXT] [--default] [--force] [--dry-run] [--no-check] [--no-copy] [--kind precompute|custom] [--stats]';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'run-id': { type: 'string' },
      label: { type: 'string' },
      default: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'no-check': { type: 'boolean', default: false },
      'no-copy': { type: 'boolean', default: false },
      kind: { type: 'string', default: 'precompute' },
      stats: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const dir = positionals[0];
  if (dir === undefined || positionals.length > 1) {
    console.error(USAGE);
    return 1;
  }
  if (values.kind !== 'precompute' && values.kind !== 'custom') {
    console.error(`--kind must be precompute or custom (got ${values.kind})`);
    return 1;
  }
  const config = loadConfig();
  const t0 = performance.now();
  const stamp = (): string => `[import +${((performance.now() - t0) / 1000).toFixed(1)}s]`;
  const log: ImportLogger = {
    info: (m) => console.log(`${stamp()} ${m}`),
    warn: (m) => console.warn(`${stamp()} WARN ${m}`),
  };

  const dryRun = values['dry-run'];
  let db = null;
  try {
    db = await connectDb(config.MONGODB_URI, config.MONGODB_DB);
    log.info(`MongoDB ${config.MONGODB_URI} db=${config.MONGODB_DB}`);
  } catch (e) {
    if (!dryRun) throw e;
    log.warn(`MongoDB not reachable (${e instanceof Error ? e.message : String(e)}); dry run continues without idempotency info`);
  }

  try {
    const res = await importRun(db, {
      dir: path.resolve(dir),
      ...(values['run-id'] !== undefined ? { runId: values['run-id'] } : {}),
      ...(values.label !== undefined ? { label: values.label } : {}),
      kind: values.kind,
      setDefault: values.default,
      force: values.force,
      dryRun,
      check: values['no-check'] ? false : { pythonBin: config.PYTHON_BIN, cwd: config.LUNARNAV_ROOT },
      dataDir: values['no-copy'] ? null : config.DATA_DIR,
      catalogPath: path.join(config.LUNARNAV_ROOT, 'lunarnav', 'catalog', 'sites.json'),
      log,
    });
    console.log(JSON.stringify({ run_id: res.run_id, outcome: res.outcome, counts: res.counts, duration_ms: res.duration_ms, source_dir: res.source_dir, warnings: res.warnings.length }, null, 1));
    if (values.stats && db) {
      const sizes = await collectionSizes(db);
      for (const c of sizes.collections) {
        console.log(`  ${c.name.padEnd(10)} docs=${String(c.count).padStart(9)}  data=${formatBytes(c.size).padStart(9)}  storage=${formatBytes(c.storageSize).padStart(9)}  indexes=${formatBytes(c.totalIndexSize).padStart(9)}`);
      }
      console.log(`  db ${sizes.db.name}: dataSize=${formatBytes(sizes.db.dataSize)} storageSize=${formatBytes(sizes.db.storageSize)} indexSize=${formatBytes(sizes.db.indexSize)}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof ImportRefusedError) {
      console.error(`REFUSED: ${e.message}`);
      for (const r of e.reasons.slice(0, 50)) console.error(`  ${r}`);
      if (e.reasons.length > 50) console.error(`  ... ${e.reasons.length - 50} more`);
      return 2;
    }
    if (e instanceof ImportVerificationError) {
      console.error(e.message);
      return 3;
    }
    throw e;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exitCode = 1;
  },
);
