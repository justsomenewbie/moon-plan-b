/** Process entry point: `npm run dev` (watch) / `npm start` (dist). Graceful shutdown on SIGINT/SIGTERM. */
import { buildApp, DOCS_PATH, OPENAPI_JSON_PATH } from './app.ts';
import { ConfigError } from './config.ts';

async function main(): Promise<void> {
  const app = await buildApp({ db: process.env['NODE_ENV'] === 'production' ? 'required' : 'optional' });
  const { HOST, PORT } = app.config;

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: HOST, port: PORT });
  app.log.info(`docs: http://${HOST}:${PORT}${DOCS_PATH}  spec: http://${HOST}:${PORT}${OPENAPI_JSON_PATH}`);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(err);
  process.exit(1);
});
