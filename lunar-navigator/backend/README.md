# lunarnav backend (Fastify 5 + TypeScript + zod 4 + MongoDB)

Web API of the Lunar Landing Site Navigator (team Moon Plan B, NASA Space Apps Challenge 2026). It serves the
precomputed Sun / Earth visibility runs of the Python package `lunarnav` (in the parent folder) to the team web app,
and runs `lunarnav` as background jobs for custom coordinates.

* Live: https://api.lunavigator.com/api/v1 (`/health` is public; other routes need an API key, given privately to
  the frontend team; Swagger UI at `/docs` behind HTTP Basic auth).
* Contract: [`contract/openapi.json`](contract/openapi.json) (OpenAPI 3, generated from the zod schemas in `src/contract/`).
* Input data format (the Python run folders): [`../docs/OUTPUT_SPEC.md`](../docs/OUTPUT_SPEC.md).
* Python tools through the API (job types, tools, artifacts, capabilities): [`../docs/PYTHON_INTEGRATION.md`](../docs/PYTHON_INTEGRATION.md).
* Frontend integration guide and deployment runbook (Vietnamese team notes): [`../docs/vi/`](../docs/vi/).

## Requirements

* Node.js ≥ 24 (runs `.ts` files directly with Node's type stripping, no tsx) and npm ≥ 11.
* MongoDB 8 on `mongodb://127.0.0.1:27017` without auth for development: a local install, or
  `docker run -d --name lunarnav-mongo -p 27017:27017 mongo:8`.
* The Python venv `../.venv` with `lunarnav` installed (`pip install -e ".[dev]"` in the parent folder, see the
  [Run it locally](../docs/RUN_LOCALLY.md#1-python-package)). It is used by the import gate (`lunarnav check`), alternative dates,
  jobs and tools.

## First run

Linux / macOS:

```bash
cd backend
npm ci
cp .env.example .env
npm run import -- tests/fixtures/sample_2026Q1_spice_pgda --default
npm run dev                  # http://127.0.0.1:8000/api/v1/health , Swagger UI http://127.0.0.1:8000/docs
```

Windows PowerShell:

```powershell
cd backend
npm ci
Copy-Item .env.example .env
npm run import -- tests/fixtures/sample_2026Q1_spice_pgda --default
npm run dev
```

* `.env.example` is a development setup: `NODE_ENV=development`, port 8000 (the Next.js dev server uses 3000),
  database `lunarnav_local`, no API keys (authentication off, one warning at startup), docs open. The Python paths
  are left unset; their defaults are computed from the backend folder and work on every OS.
* `tests/fixtures/sample_2026Q1_spice_pgda/` is a small real run tracked in git (6 sites, 2026-01-01 to 2026-04-01,
  hourly, SPICE + PGDA, 1.6 MB). The import gate runs `lunarnav check`, verifies 26 sha256 checksums and loads 12 960
  series documents in about 3 s.
* Environment variables already set win over `.env`. These steps were verified on a fresh clone with
  `PORT=3199` and `MONGODB_DB=lunarnav_readme_check` set in the environment.
* Production-style run: `npm run build` then `npm start` (runs `dist/src/server.js`).

Check it (in Windows PowerShell write `curl.exe`):

```bash
curl -s http://127.0.0.1:8000/api/v1/health      # "status":"ok", mongo.ok and python.ok true, default_run_id
curl -s http://127.0.0.1:8000/api/v1/runs
curl -s "http://127.0.0.1:8000/api/v1/dataset?site_ids=ref_connecting_ridge_c1&start=2026-01-07T00:00:00Z&end=2026-01-14T00:00:00Z"
curl -s http://127.0.0.1:8000/api/v1/ranking
```

### Import a real precompute

Any folder written by `lunarnav precompute` (locally, or one run folder of a Google Colab export zip after unzipping):

```bash
npm run import -- ../output/demo --label "Local demo run"
npm run import -- /path/to/<run>_B_... --default --label "Run B"
npm run import -- <dir> --dry-run          # validate and parse only, write nothing
```

The import is idempotent (an unchanged run is skipped). It copies the folder to `DATA_DIR/runs/<run_id>/`, so the
source can be deleted afterwards. `--default` makes the run the one served when a request has no `run_id`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | Server with file watching (`src/`) / built server (`dist/`, after `npm run build`) |
| `npm run build` | `tsc` build into `dist/` |
| `npm run import -- <dir> [--run-id ID] [--label T] [--default] [--force] [--dry-run] [--no-check] [--no-copy] [--kind precompute\|custom] [--stats]` | Import one Python run folder (gate: `lunarnav check` + sha256; copy to `DATA_DIR/runs/<run_id>/`). Exit codes: 0 ok / skipped, 1 error, 2 refused by the gate, 3 verification failed |
| `npm test` | Full vitest suite. Uses mongodb-memory-server (MongoDB 8.0.23, downloaded on first use), never your database |
| `npm run test:slow [-- <file>]` | The `*.slow.test.ts` files, which run the real `lunarnav` (custom sites, precompute, analyse, alt dates, check, validate, compare runs, tools; about 1 min) |
| `npm run typecheck` (= `npm run lint`) | `tsc --noEmit`, strict |
| `npm run openapi:export` / `npm run openapi:check` | Write / verify `contract/openapi.json` |
| `npm run lint:openapi` | `@redocly/cli lint` on the spec |
| `npm run mock` | Prism mock server from the spec at http://127.0.0.1:4010 (no MongoDB or Python needed) |
| `npm run examples:capture` / `examples:check` | Re-capture / verify `contract/examples/*` from real responses (`-- --base-url <url>` to use a running server). Both write to the configured `MONGODB_DB` (they POST and cancel one real `custom_site` job), so point them at a scratch DB holding only the imported sample run |
| `bash scripts/e2e-curl.sh [BASE_URL]` | End-to-end curl test of a running server: every endpoint plus one real custom-coordinate job. Output goes to `contract/examples/e2e/` (git-ignored). Env: `E2E_API_KEY`, `E2E_DOCS_AUTH=user:pass`, `E2E_START`/`E2E_END`, `E2E_DEM=none` when offline |
| `npm run fixtures` | Regenerate `src/fixtures/*.json` (spec examples) from `../output/sample_2026Q1_spice_pgda` (Windows venv path; that folder is not in git) |

Mock notes: Prism answers **422** for a request that breaks the schema (header `sl-violations`); the real server
answers **400** `VALIDATION_ERROR`. Prism does not catch unknown query parameters, impossible dates or duplicate / all-zero
`weights`. `POST /jobs` on the mock returns 200 "cache hit"; send `Prefer: code=202` to get the queued flow.

## Configuration

All variables are parsed and validated once in [`src/config.ts`](src/config.ts) (zod). Empty values count as unset.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production` (production requires `API_KEYS` and `DOCS_USER`/`DOCS_PASSWORD`) |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Listen address (`.env.example` uses port 8000) |
| `LOG_LEVEL` | `info` | pino level |
| `MONGODB_URI`, `MONGODB_DB` | `mongodb://127.0.0.1:27017`, `lunarnav_dev` | Database. One database per server instance |
| `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Allowed browser origins, comma separated, `*` = any |
| `PYTHON_BIN` | `../.venv/bin/python` (Windows `..\.venv\Scripts\python.exe`), absolute | Python with `lunarnav` installed |
| `LUNARNAV_ROOT` | the parent folder, absolute | `lunarnav` checkout, working directory of Python children |
| `DATA_DIR` | `backend/data`, absolute | Imported runs (`runs/<run_id>/`) and job folders (`jobs/<id>/`) |
| `JOB_TIMEOUT_S`, `JOB_CONCURRENCY`, `JOB_QUEUE_MAX` | 1200, 1, 20 | Python job queue |
| `JOB_MAX_ACTIVE_PER_CLIENT` | 2 | Queued + running jobs per client (IP, IPv6 /64); 0 = no limit (`429 TOO_MANY_JOBS`) |
| `SSE_MAX_PER_CLIENT` | 5 | Concurrent job event streams per client (`429 TOO_MANY_STREAMS`) |
| `ALTDATES_TIMEOUT_S` | 30 | Synchronous alternative-dates call |
| `CUSTOM_RUN_TTL_DAYS`, `PRECOMPUTE_RUN_TTL_DAYS` | 30, 7 | Lifetime of runs created by jobs |
| `JOB_RUNS_MAX_PER_CLIENT`, `JOB_RUNS_MAX_TOTAL`, `JOB_RUNS_MAX_MB`, `DATA_DIR_MIN_FREE_MB` | 20, 200, 10240, 2048 | Storage budget for job runs (`429 QUOTA_EXCEEDED`, `503 STORAGE_FULL`); 0 = no limit |
| `PGDA_DOWNLOAD_MAX_MB_PER_DAY`, `PGDA_CACHE_MAX_MB` | 1024, 4096 | PGDA tile downloads per UTC day and cache size cap |
| `CAPABILITIES_NETWORK_PROBE`, `CAPABILITIES_TTL_S` | on (off in tests), 600 | `GET /capabilities`: probe JPL Horizons / PGDA reachability, cache time |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_POST_MAX`, `RATE_LIMIT_TOOLS_MAX` | 300, 5, 30 | Requests per minute per client: all routes, `POST /alt-dates` + `POST /jobs`, `POST /tools/*` |
| `COMPRESS` | `true` | Response compression in Node (turn off if the reverse proxy compresses) |
| `API_KEYS` | empty | `name:key,name:key` (or plain `key,key`), keys ≥ 32 chars in production |
| `DOCS_USER`, `DOCS_PASSWORD` | unset | HTTP Basic auth of `/docs` and `/api/v1/openapi.json`; both or neither; password ≥ 12 chars in production |

If you override `PYTHON_BIN`, `LUNARNAV_ROOT` or `DATA_DIR`, use absolute paths: Python children run with the
working directory `LUNARNAV_ROOT`. The Python side also reads `LUNARNAV_DATA` (kernels, DEM cache) from the
environment.

## Authentication

* Every `/api/v1/*` route **except `GET /api/v1/health`** (and CORS preflight) needs `X-API-Key: <key>` or
  `Authorization: Bearer <key>`. A missing or wrong key gives `401 UNAUTHORIZED` (problem+json, same body in both
  cases, `WWW-Authenticate: ApiKey header="X-API-Key"`). Keys are compared in constant time on SHA-256 digests
  ([`src/lib/auth.ts`](src/lib/auth.ts)); the client name appears in logs and is the rate-limit key, the key itself is
  never logged.
* `/docs`, `/docs/*` and `/api/v1/openapi.json` use HTTP Basic `DOCS_USER` / `DOCS_PASSWORD`. The Swagger UI has an
  **Authorize** button for the API key.
* With `NODE_ENV=production` the server refuses to start without `API_KEYS` and docs credentials. Elsewhere, empty
  values turn authentication off.
* The frontend calls the API from its Next.js server (the key stays in a server-side env variable), never from the
  browser.

Try it locally (verified with `PORT=3199`):

```bash
KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")   # or: openssl rand -hex 32
API_KEYS="dev:$KEY" DOCS_USER=dev DOCS_PASSWORD=local-docs-pass npm run dev
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:8000/api/v1/runs      # 200; without the header: 401
curl -s -u dev:local-docs-pass http://127.0.0.1:8000/api/v1/openapi.json
```

```powershell
$KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$env:API_KEYS = "dev:$KEY"; npm run dev
curl.exe -s -H "X-API-Key: $KEY" http://127.0.0.1:8000/api/v1/runs
# afterwards: Remove-Item Env:API_KEYS
```

Test a remote server end to end: `E2E_API_KEY=<key> E2E_DOCS_AUTH=user:pass bash scripts/e2e-curl.sh <url>`.

## Behaviour worth knowing

* **HTTP cache:** data GETs with a `run_id` send `Cache-Control: public, max-age=3600`; without one (default run)
  `max-age=60`. Raw run files (`GET /runs/{id}/files/*`) are not compressed and carry a strong ETag = manifest sha256.
* **Run files** are read from `DATA_DIR/runs/<run_id>/` when present, otherwise from the run's `source_dir`
  (`--no-copy` imports), so a database moved to another machine (mongodump / mongorestore) still finds its files.
* **Jobs are shared per client** (IP; IPv6 grouped by /64; behind a local reverse proxy `X-Forwarded-For` is trusted):
  a duplicate POST joins the running job; `DELETE` only detaches the caller, and Python is killed when nobody waits;
  another client gets `403 JOB_NOT_YOURS`.
* **Python tools** (`POST /jobs` types `custom_site`, `precompute`, `analyse`, `alt_dates_python`, `check`, `validate`,
  `validate_terrain`, `compare_runs`, `horizon_mask`; synchronous `POST /tools/ephemeris` and `POST /tools/horizon`;
  `GET /capabilities`): see [`../docs/PYTHON_INTEGRATION.md`](../docs/PYTHON_INTEGRATION.md). The API never downloads
  Moon Trek DEMs; `dem: trek` only works when the GeoTIFFs are already in `LUNARNAV_DATA/dem`.
* **Python child processes** get an allow-listed environment (never `MONGODB_URI`). On Windows the venv launcher is
  replaced by the base interpreter so a cancelled job cannot leave an orphan `python.exe`.
* **One database per server:** at startup, jobs left `queued`/`running` are marked `SERVER_RESTARTED`. Do not let two
  instances share `MONGODB_DB` or `DATA_DIR`.

## Tests

* `npm test`: on the test machine `35 passed | 4 skipped` test files, `426 passed | 18 skipped` tests in about 85 s.
* `tests/fixtures/sample_2026Q1_spice_pgda/`: byte-exact copy of a real run (`tests/.gitattributes` keeps git from
  changing line endings, since the manifest holds sha256 checksums), so real-data tests never skip.
* `tests/crosscheck/api_vs_python.test.ts`: API answers compared **exactly** with the Python files and `lunarnav`
  functions. Run it on another run folder with `LUNARNAV_SAMPLE_DIR=<dir> npx vitest run tests/crosscheck`.
* `tests/app.smoke.test.ts`: every OpenAPI operation on the imported sample run; jobs use a fake `lunarnav`
  (`tests/jobs/fake_lunarnav`).
* `tests/auth.test.ts`: API key and docs authentication.

## Code layout

```
src/config.ts       environment (zod)                src/db.ts        MongoClient, collections, indexes
src/app.ts          buildApp(opts)                   src/server.ts    listen + graceful shutdown
src/contract/       zod schemas = the API contract (one file per endpoint group)
src/routes/         one Fastify plugin per endpoint group
src/repos/          the only data-access layer (runs, sites, site_runs, horizons, windows, series)
src/importer/       Python run folder -> MongoDB (CLI: scripts/import-run.ts)
src/python/         Python bridge (execa): safe argv/env, alt dates, capabilities probe
python/             bridge scripts (JSON over stdin/stdout) for job types and tools
src/jobs/           job queue (p-queue + jobs collection), artifacts, TTL cleanup; types/ = one file per job type
src/lib/            problem+json (RFC 9457), naming, time, provenance, OpenAPI, auth
src/fixtures/       JSON extracted from a real run, used as OpenAPI examples
deploy/             VPS provisioning, deploy, nginx/Caddy, pm2, backup scripts
```

Changing the contract: edit the schema in `src/contract/` and the handler in `src/routes/`, read data through
`src/repos/index.ts`, run `npm run openapi:export` and `npm run examples:capture`, and tell the frontend team. Rule for
v1: only add optional fields or endpoints; breaking changes go to `/api/v2`.

## Deployment (summary)

The full runbook is Vietnamese: [`../docs/vi/DEPLOY_VPS.md`](../docs/vi/DEPLOY_VPS.md). In short:

1. `deploy/provision-ubuntu.sh` (root, once) installs Node 24, pm2, MongoDB 8 (auth on, bound to 127.0.0.1), the Python venv and backups.
2. Secrets go in `/etc/lunarnav/api.env` (template [`deploy/api.env.example`](deploy/api.env.example)): `NODE_ENV=production`, `API_KEYS`, `DOCS_USER`/`DOCS_PASSWORD`, MongoDB URI.
3. `bash deploy/deploy.sh push <user@host>` from a dev machine (or `deploy.sh pull` on the server) uploads the code, runs `npm ci`, builds and reloads pm2.
4. `deploy/setup-nginx-api.sh <domain>` puts the API behind nginx with HTTPS (Caddy alternative: `deploy/Caddyfile`).
5. `deploy/import-run.sh <zip|dir>` imports a Colab export on the server; check with `curl https://<domain>/api/v1/health`.
