// AI-assisted build preparation; source contract is shared with the backend reviewer.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
await mkdir(new URL('public/api/v1/', root), { recursive: true });
await copyFile(new URL('../../contracts/openapi.draft.json', import.meta.url), new URL('public/api/v1/openapi.json', root));
await mkdir(new URL('public/api-contract/', root), { recursive: true });
await copyFile(new URL('../../contracts/openapi.dataset.json', import.meta.url), new URL('public/api-contract/lunarnav.json', root));
await mkdir(new URL('public/swagger/', root), { recursive: true });
const swagger = dirname(require.resolve('swagger-ui-dist/package.json'));
for (const name of ['swagger-ui-bundle.js', 'swagger-ui-bundle.js.LICENSE.txt', 'swagger-ui.css', 'LICENSE', 'NOTICE']) await copyFile(join(swagger, name), new URL(`public/swagger/${name}`, root));
const msw = dirname(require.resolve('msw/package.json'));
await copyFile(join(msw, 'lib/mockServiceWorker.js'), new URL('public/mockServiceWorker.js', root));
