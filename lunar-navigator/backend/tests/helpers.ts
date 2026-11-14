/**
 * Test helpers. Tests NEVER touch the dev database: they start a throw-away mongod with
 * mongodb-memory-server pinned to the VPS major (MongoDB 8.0.x). The binary is cached in
 * ~/.cache/mongodb-binaries after the first download (~765 MB zip).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp, type App, type BuildAppOptions } from '../src/app.ts';

export const MONGOMS_VERSION = '8.0.23';

export interface TestContext {
  app: App;
  mongo: MongoMemoryServer | null;
  dataDir: string;
  close: () => Promise<void>;
}

export async function startTestApp(opts: { db?: BuildAppOptions['db']; config?: BuildAppOptions['config'] } = {}): Promise<TestContext> {
  const dbMode = opts.db ?? 'required';
  const mongo = dbMode === 'none' ? null : await MongoMemoryServer.create({ binary: { version: MONGOMS_VERSION } });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lunarnav-test-'));
  const app = await buildApp({
    db: dbMode,
    logger: false,
    config: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      MONGODB_URI: mongo ? mongo.getUri() : 'mongodb://127.0.0.1:1',
      MONGODB_DB: 'lunarnav_test',
      DATA_DIR: dataDir,
      RATE_LIMIT_MAX: 100_000,
      // Authentication OFF by default (empty = unset, even if the shell exports these); tests/auth.test.ts passes keys.
      API_KEYS: '',
      DOCS_USER: '',
      DOCS_PASSWORD: '',
      ...opts.config,
    },
  });
  await app.ready();
  return {
    app,
    mongo,
    dataDir,
    close: async () => {
      await app.close();
      if (mongo) await mongo.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
