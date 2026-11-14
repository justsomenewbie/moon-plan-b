# Integrating all Python tools into the backend

Documentation of the **common framework** (skeleton) and of the job types / tools built on it.
Related: `docs/vi/WEB_BACKEND_PLAN.md` §7 (Node ↔ Python bridge, Vietnamese), `backend/README.md`, `docs/OUTPUT_SPEC.md`.

Status (2026-11-14, integrated): the framework (registry, artifacts, capabilities, contract union) and **all 9 job
types + 2 synchronous tools are done and tested** (unit tests with a fake Python + 1 real e2e test per group,
`npm run test:slow`), and have been exercised directly with curl.
`custom_site` keeps its external behaviour. `placeholderJobType()` still exists (501 `JOB_TYPE_UNAVAILABLE`) for
future types / tests, but no type is currently a placeholder.

---

## 1. API table

| Method | Path | Kind | What it does | Owner |
|---|---|---|---|---|
| POST | `/api/v1/jobs` | async | Create a job; body = `CreateJobRequest` (discriminated union on `type`) | framework (route), builder (schema + def of the type) |
| GET | `/api/v1/jobs/{job_id}` | | Status / progress / `result` / `output` / `artifacts` | framework |
| DELETE | `/api/v1/jobs/{job_id}` | | Cancel (detach the client; kill Python when nobody is waiting any more) | framework |
| GET | `/api/v1/jobs/{job_id}/events` | SSE | Live progress (optional) | framework |
| GET | `/api/v1/jobs/{job_id}/artifacts` | | List of the files the job produced (only when `succeeded`) | framework |
| GET | `/api/v1/jobs/{job_id}/artifacts/{name}` | | Download 1 file; ETag = sha256, 304, CSP sandbox, no compression | framework |
| GET | `/api/v1/capabilities` | | What the server can run (providers, DEMs, job types, tools, CLI flags); `?refresh=true` | framework |
| POST | `/api/v1/tools/ephemeris` | **sync** | site or lat/lon (not both), ≤ 200 UTC epochs, provider spice\|analytic\|horizons → az/el/dist of Sun / Earth | B4 |
| POST | `/api/v1/tools/horizon` | **sync** | lat/lon or site, dem pgda\|trek\|none, method raymarch\|flat, radius ≤ 60 km, near_exclusion → horizon mask (heavier: job `horizon_mask`, ≤ 300 km, with bruteforce) | B4 |
| POST | `/api/v1/alt-dates` | sync | Unchanged (fast computation on an imported run) | — |

Job types (`type` in the body):

| `type` | What it does | Python | Result | Owner |
|---|---|---|---|---|
| `custom_site` | 1 site, ≤ 366 days, step 60 | `lunarnav.cli precompute --sites <id>` | imports run `job_<id>` (kind `custom`) → `result.run_id` | framework |
| `precompute` | catalog sites (list \| `all` \| `group:<g>`) and/or `custom_sites`, any span/step (snapped to the step grid), full ComputeOptions, `run_label` | `lunarnav.cli precompute` | imports a new run `job_<id>` (kind `precompute`) + artifact `summary.csv` | **B1** |
| `analyse` | same as precompute | `lunarnav.cli analyse --json=<artifacts>/ranking.json` | `output.ranking` + artifact `ranking.json`, no import | **B1** |
| `alt_dates_python` | alt-dates computed directly in Python, 1 site (site_id or lat/lon), ≤ 366 days, full ComputeOptions + constraints | `backend/python/alt_dates_python_job.py` (calls the CLI `alt-dates` in-process; exit 2 = no matching date → empty result, the job still succeeds) | `output` + artifact `alt_dates.json` | **B1** |
| `check` | `check_output` on the files of 1 imported run | `backend/python/check_json.py` | `output.{ok,violations}` + `violations.json`; not cached; `RUN_CHANGED` if the run was re-imported | **B3** |
| `validate` | `lunarnav.validate.run_all` quick\|full, offline, no_horizons, no_terrain | `backend/python/validate_json.py` | `output.passed` + `validation_report.{json,md}` (a FAIL is still a succeeded job) | **B3** |
| `validate_terrain` | quick\|full (quick ~3–4 minutes) | `backend/python/validate_terrain_json.py` → `lunarnav.validate_terrain.run(quick, out_path)` | `output` + `validate_terrain_report.json` (NaN → standard JSON) | **B3** |
| `compare_runs` | compares 2 imported runs site by site (ephemeris angle difference, horizon p95/max, % flag differences, metric deltas) on the common time stamps | `backend/python/compare_runs.py` (port of the team's offline `compare_A_B.py` script; 0 differences on 23 sites × 10 metrics) | `output` + `compare_runs.{json,csv}` | **B3** |
| `horizon_mask` | heavy horizon mask (≤ 300 km, az_step 0.05–10°, raymarch\|bruteforce\|flat) | `backend/python/tools_horizon_mask.py` | summary `output` + artifact `horizon.json` (= response of the sync tool) | **B4** |

---

## 2. Job-type registry (`backend/src/jobs/types/`)

- `define.ts` — API: `JobTypeDef`, `defineJobType()`, `placeholderJobType()`, `JobFailure`, the contexts. **Owned by the framework.**
- `index.ts` — `JOB_TYPE_REGISTRY` (1 line / type), `jobTypeDef()`, `listJobTypes()`, `overrideJobType()` (test seam). **Owned by the framework** — builders do NOT need to edit it (every type is already registered).
- `<type>.ts` — 1 file / job type, exporting exactly the name imported in `index.ts` (`precomputeJob`, `analyseJob`, `altDatesPythonJob`, `checkJob`, `validateJob`, `validateTerrainJob`, `compareRunsJob`, `horizonMaskJob`).
- Reference example: `custom_site.ts`. Example test with a fake job type: `backend/tests/jobs/skeleton.test.ts`.

`JobTypeDef` (see the comments in `define.ts`):

| Field | Meaning |
|---|---|
| `type`, `implemented` | `implemented: false` → 501 |
| `label`, `logName`, `pythonStage` | messages (`"<label> exceeded N s"`), log file in the job dir, stage while Python runs (`python` for new types) |
| `limits` | `timeout_s` (default `JOB_TIMEOUT_S`), `result_ttl_h` (default `CUSTOM_RUN_TTL_DAYS*24`), `cacheable` (default true), `artifacts` (limits), `public` (shown in `/capabilities`) |
| `available(caps)` | reason why it cannot run on this server (e.g. a missing module) → 501 |
| `canonicalize(req, ctx)` | request (after zod + defaults) → canonical params (plain JSON, with `type`), hashed into `params_hash`. Semantic errors: `throw new ApiError('OUT_OF_RANGE' \| 'JOB_TOO_LARGE' \| 'CAPABILITY_UNAVAILABLE' \| 'RUN_NOT_FOUND' ...)`. `ctx.capabilities()` for CLI flags / Trek files; `ctx.catalogIds()` |
| `siteId(params)` | displayed site (`null` if not a single site) |
| `planPython(params, run)` | `{ args, env?, input?, cwd?, timeoutS? }` — argv after the interpreter |
| `progress(line, prev)` | stdout line → `{stage, pct}` |
| `failureReason(lines, code)` | 1-line reason when exit ≠ 0 |
| `onSuccess(params, run, py)` | reads the Python result (**zod-validated**: `readJsonFile`), writes artifacts to `run.artifactsDir`, imports if needed → `{ result?, output?, expiresAt? }`. Throw `JobFailure(code, msg)` to fail with a specific code; other errors → `RESULT_FAILED` |
| `onDiscard` | job cancelled after onSuccess → clean up (e.g. delete the imported run) |
| `reusable(doc)` | whether a succeeded job can still be used as a cache hit (default: the imported run is still `ready`). Before that, the engine always checks that every artifact of the job is still on disk (with the right size) in the current `DATA_DIR`; if one is missing → recompute |

Lifecycle (engine `src/jobs/runner.ts`, shared by all types, 1 p-queue `JOB_CONCURRENCY`):
`POST → zod union → implemented? → available? → canonicalize → params_hash → cache hit (200) | merge into a running job (202) | 429 TOO_MANY_JOBS / QUEUE_FULL | queued (202)`
→ `running` → Python (timeout, kill the process tree on cancel) → exit 0: `onSuccess` → collect artifacts → `succeeded`;
exit ≠ 0 `PYTHON_FAILED`, timeout `PYTHON_TIMEOUT`, cannot start `PYTHON_UNAVAILABLE`, artifact error `ARTIFACTS_FAILED`.

## 3. Contract (`backend/src/contract/`)

- `jobs.ts` (framework): `JOB_TYPES`, `JobType`, `CustomSiteJobRequest`, `CreateJobRequest` = `z.discriminatedUnion('type', [...])`,
  `JobAccepted` (+ `type`, nullable `site_id`), `Job` (+ `output`, `artifacts`, nullable `site_id`, extra stages `python`/`artifacts`),
  `JobArtifactsResponse`.
- `job_types/common.ts` (framework, import only): `JobName`, `ComputeOptionsShape` (step_min, provider, dem, horizon_method, radius_km,
  az_step_deg, observer_height_m, min_clearance_deg, dem_fallback, near_exclusion_m) + `COMPUTE_LIMITS`, `ArtifactName`, `JobArtifact`.
- `job_types/<type>.ts` (builder): `<Pascal>JobRequest` (keeps `type: z.literal(...)`, `name`, `z.strictObject`, every option has a default)
  + `<Pascal>JobOutput` (schema of `Job.output`). Do not rename the exports (they are imported by `jobs.ts`).
- `capabilities.ts` (framework), `tools.ts` (B4: tool schemas + `TOOLS_IMPLEMENTED`).
- After a schema change: `npm run openapi:export` (the smoke test compares with `contract/openapi.json`) and add the new operation to `tests/app.smoke.test.ts` (`covered` + operation count).

### 3.3 Synchronous tools (B4)
Route `src/routes/tools.ts`; code shared with the `horizon_mask` job lives in `src/jobs/types/b4_tools.ts` (avoids the import cycle
route → capabilities → registry). Python: `backend/python/{ephemeris_json,horizon_json,tools_common}.py`, request JSON over stdin.
Limits: ≤ 200 epochs, radius ≤ 60 km, timeout = `ALTDATES_TIMEOUT_S` × a per-tool factor, a separate p-queue (429 `QUEUE_FULL`),
a separate rate limit `RATE_LIMIT_TOOLS_MAX` (default 30/minute/IP, one bucket per tool). `near_exclusion_m: 'auto'` = the lunarnav
default (no CLI flag needed); only a numeric value requires `capabilities.cli.near_exclusion_m`.

## 4. Artifacts store (`backend/src/jobs/artifacts.ts`)

```
DATA_DIR/jobs/<job_id>/            = LUNARNAV_OUTPUT of the child process (scratch space of the type)
  <logName>                        stdout/stderr (never served: contains absolute paths)
  artifacts/<name>                 published files — FLAT names matching ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$
DATA_DIR/runs/job_<job_id>/        imported run (custom_site / precompute); deleted on fail / cancel
```
- When a job succeeds, the engine scans `artifacts/` (skipping folders, symlinks and invalid names), computes sha256 and stores the
  metadata in the job (`Job.artifacts[] = {name, media_type, bytes, sha256, url}`). The route only serves names on that list → arbitrary paths cannot be read.
- Default limits: 50 files, 100 MB/file, 200 MB in total (change with `limits.artifacts`). Media type by extension: `.json .md .csv .txt .log .gz .zip .png .svg`, anything else octet-stream (attachment).
- Helpers: `writeJsonArtifact(jobDir, name, value)`, `readJsonFile(path, zodSchema)`, `artifactPath()`.
- Lifetime = job lifetime (`expires_at`; `cleanup.ts` deletes the whole job folder every hour). Failed/cancelled: TTL 24 h, no artifacts published.

## 5. `GET /api/v1/capabilities` (`src/python/capabilities.ts`)

- Python: `backend/python/capabilities_probe.py` (only imports lunarnav): version, importable modules (spiceypy, rasterio, lunarnav.validate...),
  CLI sub-commands and **flags taken from the help output** (argparse `format_help()`) → `cli.near_exclusion_m` = precompute has `--near-exclusion-m`.
- Files: SPICE kernels in `LUNARNAV_DATA/kernels`, Trek GeoTIFFs `LUNARNAV_DATA/dem/LRO_LOLA_DEM_*.tif` (ignoring `.part`), number of cached PGDA products.
- Network (`CAPABILITIES_NETWORK_PROBE`, on by default except with `NODE_ENV=test`): HEAD to JPL Horizons and PGDA, 4 s timeout, no user data sent.
- `job_types[]`: `implemented`, `available`, `reason`, `timeout_s`, `result_ttl_h`, `limits` (= `def.limits.public`); `tools{}`.
- Probed when the server becomes ready (in the background), cached for `CAPABILITIES_TTL_S` (600 s), `?refresh=true` at most every 30 s, concurrent calls share 1 probe.
- In `canonicalize`: `const caps = await ctx.capabilities()` → `CAPABILITY_UNAVAILABLE` (422) if `dem: 'trek'` while `caps.dems.trek.files` is empty,
  or `near_exclusion_m` while `!caps.cli.near_exclusion_m`. **The API never downloads the 1–2 GB Trek files.**

## 6. File ownership (owner of each file, integrated version)

| Group | Files |
|---|---|
| **B1 compute** (precompute, analyse, alt_dates_python) | `src/contract/job_types/{precompute,analyse,alt_dates_python}.ts`, `src/jobs/types/{precompute,analyse,alt_dates_python}.ts`, `backend/python/alt_dates_python_job.py`, `tests/jobs/{precompute,alt_dates_python}.test.ts`, `tests/jobs/precompute.slow.test.ts`, `tests/jobs/fake_b1/` |
| **B3 reports** (check, validate, validate_terrain, compare_runs) | `src/contract/job_types/{check,validate,validate_terrain,compare_runs}.ts`, `src/jobs/types/{check,validate,validate_terrain,compare_runs,b3_common}.ts`, `backend/python/{b3_common,check_json,validate_json,validate_terrain_json,compare_runs}.py`, `tests/jobs/{check,validate,compare_runs}.test.ts`, `tests/jobs/validate_reports.slow.test.ts`, `tests/jobs/fake_b3/` |
| **B4 tools** (ephemeris, horizon, horizon_mask) | `src/contract/tools.ts`, `src/routes/tools.ts`, `src/contract/job_types/horizon_mask.ts`, `src/jobs/types/{horizon_mask,b4_tools}.ts`, `backend/python/{ephemeris_json,horizon_json,tools_common,tools_horizon_mask}.py`, `tests/tools.test.ts`, `tests/tools.horizon_mask.test.ts`, `tests/tools.slow.test.ts`, `tests/jobs/fake_b4/` |
| (B2 no longer exists: `alt_dates_python` moved to B1, `check` to B3) | |
| **Framework** (no builder edits these; ask the coordinator if a change is needed) | `src/jobs/runner.ts`, `src/jobs/types/{define,index,custom_site}.ts`, `src/jobs/artifacts.ts`, `src/jobs/types.ts`, `src/jobs/params.ts`, `src/jobs/importer.ts`, `src/contract/{jobs,capabilities}.ts`, `src/contract/job_types/common.ts`, `src/python/{capabilities,scripts,process}.ts`, `src/routes/{jobs,capabilities}.ts`, `src/app.ts`, `src/lib/problem.ts`, `src/config.ts`, `backend/python/capabilities_probe.py` |
| Shared files, minimal edits | `tests/app.smoke.test.ts` (add `covered.add(...)` + operation count), `contract/openapi.json` (regenerated with `npm run openapi:export`) |

**Do not edit** (another workflow owns them): `lunarnav/{horizon,precompute,cli,config}.py`, `lunarnav/terrain/trek.py`,
`src/contract/dataset.ts`, `src/routes/dataset*.ts`, `src/repos/dataset*.ts`. If lunarnav behaviour must change → write a helper in `backend/python/`.

## 7. Safety rules (mandatory)

- Python **always** goes through `runPython()` (`src/python/process.ts`): no shell, args array, timeout, kill of the whole process tree, env allow-list
  (never contains `MONGODB_URI`). A job type only returns a `PythonPlan`; the engine calls `runPython`. Sync tools call `runPython` directly.
- Argv via `src/python/scripts.ts`: `lunarnavCliArgs(sub, args)`, `bridgeScriptArgs('x.py', args)`, `flagArg('--start', v)` (a single
  `--flag=value` element, so a value starting with `-` is not misread by argparse), `lunarnavEnv(cfg, {bridge: true})` for scripts in `backend/python/`
  (PYTHONPATH = LUNARNAV_ROOT).
- Paths given to Python are computed by the server (job dir, `run.artifactsDir`, run folder via `resolveRunOnDisk()` / `runDirectory()`), **never**
  taken from the request. Ids/names from the request must pass the contract regexes (SiteId, RunId...).
- Every Python output (stdout JSON, JSON files) must be `zod`-parsed before use. Text shown to the client goes through `run.sanitize()`.
- Job size limits are enforced in `canonicalize` (e.g. B1: max sites × samples / job → `JOB_TOO_LARGE`), not left to Python.

## 8. Current limits

| Limit | Value | Where |
|---|---|---|
| Concurrent jobs / queue | `JOB_CONCURRENCY` 1, `JOB_QUEUE_MAX` 20 (shared by all types) | config |
| Active jobs / client | `JOB_MAX_ACTIVE_PER_CLIENT` 2 | config |
| Checks when creating a new job | client limit + queue + budget are checked, then insert + enqueue happen **sequentially** in-process (concurrent POSTs cannot slip through) | runner |
| Storage of job runs | custom_site / precompute: `JOB_RUNS_MAX_PER_CLIENT` 20 (→ 429 `QUOTA_EXCEEDED`), `JOB_RUNS_MAX_TOTAL` 200, `JOB_RUNS_MAX_MB` 10240, `DATA_DIR_MIN_FREE_MB` 2048 (→ 503 `STORAGE_FULL`); `Job.run_bytes` measured on completion | config / runner |
| Precompute run TTL | `PRECOMPUTE_RUN_TTL_DAYS` 7 days (custom_site still `CUSTOM_RUN_TTL_DAYS` 30) | config |
| PGDA cache | new downloads ≤ `PGDA_DOWNLOAD_MAX_MB_PER_DAY` 1024 MB/UTC day (measured as cache growth around each job/tool with dem pgda; exhausted → 429 `QUOTA_EXCEEDED`), cache ≤ `PGDA_CACHE_MAX_MB` 4096 (evicts the least recently used blocks, keeps blocks used < 10 minutes ago) | `src/python/pgdaCache.ts` |
| Python timeout | `limits.timeout_s` ?? `JOB_TIMEOUT_S` 1200 s | def |
| Result TTL | `limits.result_ttl_h` ?? 720 h; failed/cancelled 24 h | def / runner |
| custom_site | ≤ 366 days, step 60, observer ≤ 100 m | `JOB_LIMITS` |
| ComputeOptions | step 1–1440 minutes, radius ≤ 300 km, az_step 0.05–10°, observer ≤ 100 m, min_clearance ≤ 10° | `COMPUTE_LIMITS` |
| Artifacts | 50 files, 100 MB/file, 200 MB in total | `ARTIFACT_LIMITS` |
| precompute / analyse | ≤ 30 sites, ≤ 10 custom, ≤ 100 000 samples/site, ≤ 600 000 site×samples (≤ 150 000 with Horizons); Trek only when the files are present | `PRECOMPUTE_LIMITS` → 422 `JOB_TOO_LARGE` / `CAPABILITY_UNAVAILABLE` |
| alt_dates_python | ≤ 366 days, ≤ 200 000 samples, `max_results` ≤ 50 | def |
| compare_runs | ≤ 300 sites, ≤ 15 000 000 site×samples | def |
| Sync tools | ≤ 200 epochs; radius ≤ 60 km (job `horizon_mask` ≤ 300 km); 2 slots, ≤ 8 waiting, ≤ 2 requests/client waiting or running (→ 429 `TOO_MANY_JOBS`); the timeout includes the time waiting for a slot (expiring while still waiting → 429 `QUEUE_FULL`); client disconnect → leaves the queue / Python is killed; lat/lon rounded to 4 decimals as for custom sites | `TOOLS_LIMITS` |
| POST rate limit | `RATE_LIMIT_POST_MAX` 5/minute/IP (`/jobs`, `/alt-dates`) | config |
| Tool rate limit | `RATE_LIMIT_TOOLS_MAX` 30/minute/IP, separate per tool | config |

New error codes: `JOB_TYPE_UNAVAILABLE` (501), `CAPABILITY_UNAVAILABLE` (422), `JOB_TOO_LARGE` (422), `QUOTA_EXCEEDED` (429), `STORAGE_FULL` (503); job errors (`Job.error.code`):
`RESULT_FAILED`, `ARTIFACTS_FAILED` in addition to the existing codes.

## 9. Testing

- Unit (fake Python): `overrideJobType('<type>', def)` or a fake `lunarnav` package in a temporary folder used as `LUNARNAV_ROOT`
  (see `tests/jobs/skeleton.test.ts`, `tests/jobs/fake_lunarnav/`). Every new route has a test.
- 1 real e2e test per job group, named `tests/**/<group>.slow.test.ts`, wrapped in `describe.skipIf(process.env['RUN_SLOW'] !== '1' || !HAVE_PY)`.
  `npm run test:slow` runs **every** `*.slow.test.ts` (4 files: custom_site, B1, B3, B4; ~1 minute); a single file:
  `npm run test:slow -- tests/tools.slow.test.ts`.
- Direct testing: a separate instance on ports 8200–8299, a separate `DATA_DIR` (do NOT use `backend/data`: cleanup would delete the job folders
  of another server) and **1 DB per instance**: at startup the runner marks EVERY `queued`/`running` job in the DB as
  `SERVER_RESTARTED` (designed as 1 server / DB), so 2 instances sharing a DB would break each other's jobs.
- `npm run typecheck`, `npx vitest run`, `npm run openapi:export`.

## 10. Integration results (2026-11-14)

- `npm run typecheck` clean; `npm run openapi:check` up to date (30 operations); `npx vitest run`: every Python-integration test passes (last run 385 passed / 18 skipped; 2
  `tests/routes/dataset/*` tests were red because the `/dataset` workflow was mid-change at the time, not part of this work);
  `npm run test:slow` 17 passed / 1 skipped (the Horizons test only runs with `RUN_NETWORK=1`).
- Real runs (port 8250, DB `lunarnav_pyint`): precompute 3 sites × 3 days spice+pgda (import, `summary.csv`), analyse `group:south_pole`
  (12 sites), alt_dates_python, check (0 violations), compare_runs, validate quick, validate_terrain quick (205 s, 22/26 checks: the scientific
  result of lunarnav), horizon_mask 100 km; tools ephemeris / horizon; artifacts (ETag, 304, CSP sandbox, invalid name 400); cache hit;
  `JOB_TOO_LARGE`, `CAPABILITY_UNAVAILABLE` (trek), `SITE_NOT_FOUND`, `RUN_NOT_FOUND`.
- Also run against a frozen copy of lunarnav (`lunarnav_stable`, the version used by the main API server): every job type runs
  offline; `cli.near_exclusion_m = false`, so a numeric `near_exclusion_m` → 422 (`'auto'` is still accepted).
- Note: `params_hash` includes `lunarnav.__version__` (currently `0.1.0` in both the live and the frozen copy), so changing lunarnav code without
  bumping the version still returns old results on a cache hit: bump `__version__` whenever computed results change.
- Note (fixed after review): lunarnav opens **every** PGDA product through `/vsicurl/` before using the block cache (`PgdaDem.__init__`), so without network access even a fully cached product cannot be opened. Therefore `GET /capabilities` reports `dems.pgda` as unavailable when `network.pgda.reachable = false` (regardless of `cached_products`) → jobs with dem pgda are rejected with 422 `CAPABILITY_UNAVAILABLE`; the tool bridge turns the error `cannot open PGDA product` into 422 `CAPABILITY_UNAVAILABLE` (previously 502). With the network probe disabled (`CAPABILITIES_NETWORK_PROBE=false`) the server cannot know in advance: job → `PYTHON_FAILED`, tool → 422.
