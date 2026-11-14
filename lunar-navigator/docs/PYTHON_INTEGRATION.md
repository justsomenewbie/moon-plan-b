# Tích hợp toàn bộ công cụ Python vào backend

Tài liệu của **khung chung** (skeleton) và các job type / tool viết trên đó.
Liên quan: `docs/WEB_BACKEND_PLAN.md` §7 (cầu nối Node ↔ Python), `backend/README.md`, `docs/OUTPUT_SPEC.md`.

Trạng thái (2026-11-14, đã tích hợp): khung (registry, artifacts, capabilities, contract union) và **cả 9 job type +
2 tool đồng bộ đã làm xong, có test** (unit với Python giả + 1 e2e thật / nhóm, `npm run test:slow`), đã chạy thử trực
tiếp bằng curl + FE thô tab 6 (mục 10). `custom_site` giữ nguyên hành vi bên ngoài. `placeholderJobType()` vẫn còn
(501 `JOB_TYPE_UNAVAILABLE`) cho type tương lai / test, nhưng hiện không type nào là placeholder.

---

## 1. Bảng API

| Method | Đường dẫn | Kiểu | Việc | Ai làm |
|---|---|---|---|---|
| POST | `/api/v1/jobs` | async | Tạo job; body = `CreateJobRequest` (discriminated union theo `type`) | khung (route), builder (schema + def của type) |
| GET | `/api/v1/jobs/{job_id}` | | Trạng thái / tiến độ / `result` / `output` / `artifacts` | khung |
| DELETE | `/api/v1/jobs/{job_id}` | | Huỷ (gỡ client; kill Python khi không còn ai chờ) | khung |
| GET | `/api/v1/jobs/{job_id}/events` | SSE | Tiến độ trực tiếp (tuỳ chọn) | khung |
| GET | `/api/v1/jobs/{job_id}/artifacts` | | Danh sách file job tạo ra (chỉ khi `succeeded`) | khung |
| GET | `/api/v1/jobs/{job_id}/artifacts/{name}` | | Tải 1 file; ETag = sha256, 304, CSP sandbox, không nén | khung |
| GET | `/api/v1/capabilities` | | Server chạy được gì (provider, DEM, job type, tool, cờ CLI); `?refresh=true` | khung |
| POST | `/api/v1/tools/ephemeris` | **sync** | site hoặc lat/lon (không cả hai), ≤ 200 thời điểm UTC, provider spice\|analytic\|horizons → az/el/dist Mặt Trời / Trái Đất | B4 |
| POST | `/api/v1/tools/horizon` | **sync** | lat/lon hoặc site, dem pgda\|trek\|none, method raymarch\|flat, radius ≤ 60 km, near_exclusion → horizon mask (nặng hơn: job `horizon_mask`, ≤ 300 km, có bruteforce) | B4 |
| POST | `/api/v1/alt-dates` | sync | Giữ nguyên (tính nhanh trên run đã import) | — |

Job type (`type` trong body):

| `type` | Việc | Python | Kết quả | Owner |
|---|---|---|---|---|
| `custom_site` | 1 site, ≤ 366 ngày, step 60 | `lunarnav.cli precompute --sites <id>` | import run `job_<id>` (kind `custom`) → `result.run_id` | khung |
| `precompute` | site catalog (list \| `all` \| `group:<g>`) và/hoặc `custom_sites`, mọi khoảng/step (snap theo lưới step), đủ ComputeOptions, `run_label` | `lunarnav.cli precompute` | import run mới `job_<id>` (kind `precompute`) + artifact `summary.csv` | **B1** |
| `analyse` | như precompute | `lunarnav.cli analyse --json=<artifacts>/ranking.json` | `output.ranking` + artifact `ranking.json`, không import | **B1** |
| `alt_dates_python` | alt-dates tính thẳng bằng Python, 1 site (site_id hoặc lat/lon), ≤ 366 ngày, đủ ComputeOptions + constraints | `backend/python/alt_dates_python_job.py` (gọi CLI `alt-dates` trong tiến trình; exit 2 = không ngày nào hợp → kết quả rỗng, job vẫn succeeded) | `output` + artifact `alt_dates.json` | **B1** |
| `check` | `check_output` trên file của 1 run đã import | `backend/python/check_json.py` | `output.{ok,violations}` + `violations.json`; không cache; `RUN_CHANGED` nếu run bị import lại | **B3** |
| `validate` | `lunarnav.validate.run_all` quick\|full, offline, no_horizons, no_terrain | `backend/python/validate_json.py` | `output.passed` + `validation_report.{json,md}` (FAIL vẫn là job succeeded) | **B3** |
| `validate_terrain` | quick\|full (quick ~3–4 phút) | `backend/python/validate_terrain_json.py` → `lunarnav.validate_terrain.run(quick, out_path)` | `output` + `validate_terrain_report.json` (NaN → JSON chuẩn) | **B3** |
| `compare_runs` | so 2 run đã import theo từng site (lệch góc ephemeris, horizon p95/max, % lệch cờ, delta metric) trên các mốc thời gian chung | `backend/python/compare_runs.py` (port `D:\UAV\lunarnav_runs\compare_A_B.py`; 0 sai khác trên 23 site × 10 metric) | `output` + `compare_runs.{json,csv}` | **B3** |
| `horizon_mask` | horizon mask nặng (≤ 300 km, az_step 0.05–10°, raymarch\|bruteforce\|flat) | `backend/python/tools_horizon_mask.py` | `output` tóm tắt + artifact `horizon.json` (= response của tool sync) | **B4** |

---

## 2. Job-type registry (`backend/src/jobs/types/`)

- `define.ts` — API: `JobTypeDef`, `defineJobType()`, `placeholderJobType()`, `JobFailure`, các context. **Khung sở hữu.**
- `index.ts` — `JOB_TYPE_REGISTRY` (1 dòng / type), `jobTypeDef()`, `listJobTypes()`, `overrideJobType()` (seam cho test). **Khung sở hữu** — builder KHÔNG cần sửa (đã đăng ký sẵn mọi type).
- `<type>.ts` — 1 file / job type, export đúng tên đã import trong `index.ts` (`precomputeJob`, `analyseJob`, `altDatesPythonJob`, `checkJob`, `validateJob`, `validateTerrainJob`, `compareRunsJob`, `horizonMaskJob`).
- Mẫu tham khảo: `custom_site.ts`. Test mẫu dùng job type giả: `backend/tests/jobs/skeleton.test.ts`.

`JobTypeDef` (xem chú thích trong `define.ts`):

| Trường | Ý nghĩa |
|---|---|
| `type`, `implemented` | `implemented: false` → 501 |
| `label`, `logName`, `pythonStage` | thông báo (`"<label> exceeded N s"`), file log trong job dir, stage khi Python chạy (`python` cho type mới) |
| `limits` | `timeout_s` (mặc định `JOB_TIMEOUT_S`), `result_ttl_h` (mặc định `CUSTOM_RUN_TTL_DAYS*24`), `cacheable` (mặc định true), `artifacts` (giới hạn), `public` (hiện trong `/capabilities`) |
| `available(caps)` | lý do không chạy được trên server này (vd. thiếu module) → 501 |
| `canonicalize(req, ctx)` | request (đã qua zod + default) → params canonical (JSON thuần, có `type`), được hash vào `params_hash`. Lỗi ngữ nghĩa: `throw new ApiError('OUT_OF_RANGE' \| 'JOB_TOO_LARGE' \| 'CAPABILITY_UNAVAILABLE' \| 'RUN_NOT_FOUND' ...)`. `ctx.capabilities()` cho cờ CLI / file Trek; `ctx.catalogIds()` |
| `siteId(params)` | site hiển thị (`null` nếu không phải 1 site) |
| `planPython(params, run)` | `{ args, env?, input?, cwd?, timeoutS? }` — argv sau interpreter |
| `progress(line, prev)` | dòng stdout → `{stage, pct}` |
| `failureReason(lines, code)` | 1 dòng lý do khi exit ≠ 0 |
| `onSuccess(params, run, py)` | đọc kết quả Python (**zod-validate**: `readJsonFile`), ghi artifact vào `run.artifactsDir`, import nếu cần → `{ result?, output?, expiresAt? }`. Ném `JobFailure(code, msg)` để fail với mã riêng; lỗi khác → `RESULT_FAILED` |
| `onDiscard` | job bị huỷ sau onSuccess → dọn (vd. xoá run đã import) |
| `reusable(doc)` | job succeeded còn dùng làm cache hit không (mặc định: run import còn `ready`). Trước đó engine luôn kiểm tra mọi artifact của job còn trên đĩa (đúng kích thước) trong `DATA_DIR` hiện tại; thiếu → tính lại |

Vòng đời (engine `src/jobs/runner.ts`, chung cho mọi type, 1 hàng đợi p-queue `JOB_CONCURRENCY`):
`POST → zod union → implemented? → available? → canonicalize → params_hash → cache hit (200) | gộp job đang chạy (202) | 429 TOO_MANY_JOBS / QUEUE_FULL | xếp hàng (202)`
→ `running` → Python (timeout, kill cây process khi huỷ) → exit 0: `onSuccess` → thu artifact → `succeeded`;
exit ≠ 0 `PYTHON_FAILED`, quá giờ `PYTHON_TIMEOUT`, không chạy được `PYTHON_UNAVAILABLE`, artifact lỗi `ARTIFACTS_FAILED`.

## 3. Contract (`backend/src/contract/`)

- `jobs.ts` (khung): `JOB_TYPES`, `JobType`, `CustomSiteJobRequest`, `CreateJobRequest` = `z.discriminatedUnion('type', [...])`,
  `JobAccepted` (+ `type`, `site_id` nullable), `Job` (+ `output`, `artifacts`, `site_id` nullable, stage thêm `python`/`artifacts`),
  `JobArtifactsResponse`.
- `job_types/common.ts` (khung, chỉ import): `JobName`, `ComputeOptionsShape` (step_min, provider, dem, horizon_method, radius_km,
  az_step_deg, observer_height_m, min_clearance_deg, dem_fallback, near_exclusion_m) + `COMPUTE_LIMITS`, `ArtifactName`, `JobArtifact`.
- `job_types/<type>.ts` (builder): `<Pascal>JobRequest` (giữ `type: z.literal(...)`, `name`, `z.strictObject`, mọi tuỳ chọn có default)
  + `<Pascal>JobOutput` (schema của `Job.output`). Không đổi tên export (đã được `jobs.ts` import).
- `capabilities.ts` (khung), `tools.ts` (B4: schema tool + `TOOLS_IMPLEMENTED`).
- Sau khi đổi schema: `npm run openapi:export` (smoke test so `contract/openapi.json`) và thêm operation mới vào `tests/app.smoke.test.ts` (`covered` + số operation).

### 3.3 Tool đồng bộ (B4)
Route `src/routes/tools.ts`; code dùng chung với job `horizon_mask` ở `src/jobs/types/b4_tools.ts` (tránh vòng import
route → capabilities → registry). Python: `backend/python/{ephemeris_json,horizon_json,tools_common}.py`, request JSON qua stdin.
Giới hạn: ≤ 200 thời điểm, radius ≤ 60 km, timeout = `ALTDATES_TIMEOUT_S` × hệ số của tool, p-queue riêng (429 `QUEUE_FULL`),
rate limit riêng `RATE_LIMIT_TOOLS_MAX` (mặc định 30/phút/IP, mỗi tool 1 bucket). `near_exclusion_m: 'auto'` = mặc định
của lunarnav (không cần cờ CLI); chỉ giá trị số mới cần `capabilities.cli.near_exclusion_m`.

## 4. Artifacts store (`backend/src/jobs/artifacts.ts`)

```
DATA_DIR/jobs/<job_id>/            = LUNARNAV_OUTPUT của tiến trình con (scratch của type)
  <logName>                        stdout/stderr (không bao giờ được phục vụ: chứa đường dẫn tuyệt đối)
  artifacts/<name>                 file công bố — tên PHẲNG khớp ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$
DATA_DIR/runs/job_<job_id>/        run import (custom_site / precompute); xoá khi fail / cancel
```
- Khi job succeeded, engine quét `artifacts/` (bỏ qua thư mục, symlink, tên sai), tính sha256, lưu metadata vào job
  (`Job.artifacts[] = {name, media_type, bytes, sha256, url}`). Route chỉ phục vụ tên có trong danh sách → không thể đọc path tuỳ ý.
- Giới hạn mặc định: 50 file, 100 MB/file, 200 MB tổng (`limits.artifacts` để đổi). Media type theo đuôi: `.json .md .csv .txt .log .gz .zip .png .svg`, còn lại octet-stream (attachment).
- Helper: `writeJsonArtifact(jobDir, name, value)`, `readJsonFile(path, zodSchema)`, `artifactPath()`.
- Vòng đời = vòng đời job (`expires_at`; `cleanup.ts` xoá cả thư mục job mỗi giờ). Failed/cancelled: TTL 24 h, không công bố artifact.

## 5. `GET /api/v1/capabilities` (`src/python/capabilities.ts`)

- Python: `backend/python/capabilities_probe.py` (chỉ import lunarnav): version, module cài được (spiceypy, rasterio, lunarnav.validate...),
  sub-command CLI và **cờ lấy từ help output** (`format_help()` của argparse) → `cli.near_exclusion_m` = precompute có `--near-exclusion-m`.
- File: kernel SPICE trong `LUNARNAV_DATA/kernels`, GeoTIFF Trek `LUNARNAV_DATA/dem/LRO_LOLA_DEM_*.tif` (bỏ `.part`), số sản phẩm PGDA đã cache.
- Mạng (`CAPABILITIES_NETWORK_PROBE`, mặc định bật trừ `NODE_ENV=test`): HEAD tới JPL Horizons và PGDA, timeout 4 s, không gửi dữ liệu người dùng.
- `job_types[]`: `implemented`, `available`, `reason`, `timeout_s`, `result_ttl_h`, `limits` (= `def.limits.public`); `tools{}`.
- Probe lúc server sẵn sàng (nền), cache `CAPABILITIES_TTL_S` (600 s), `?refresh=true` tối đa mỗi 30 s, các lời gọi đồng thời dùng chung 1 probe.
- Trong `canonicalize`: `const caps = await ctx.capabilities()` → `CAPABILITY_UNAVAILABLE` (422) nếu `dem: 'trek'` mà `caps.dems.trek.files` rỗng,
  hoặc `near_exclusion_m` khi `!caps.cli.near_exclusion_m`. **API không bao giờ tải Trek 1–2 GB.**

## 6. Phân công file (người sở hữu từng file, bản đã tích hợp)

| Nhóm | File |
|---|---|
| **B1 compute** (precompute, analyse, alt_dates_python) | `src/contract/job_types/{precompute,analyse,alt_dates_python}.ts`, `src/jobs/types/{precompute,analyse,alt_dates_python}.ts`, `backend/python/alt_dates_python_job.py`, `tests/jobs/{precompute,alt_dates_python}.test.ts`, `tests/jobs/precompute.slow.test.ts`, `tests/jobs/fake_b1/` |
| **B3 reports** (check, validate, validate_terrain, compare_runs) | `src/contract/job_types/{check,validate,validate_terrain,compare_runs}.ts`, `src/jobs/types/{check,validate,validate_terrain,compare_runs,b3_common}.ts`, `backend/python/{b3_common,check_json,validate_json,validate_terrain_json,compare_runs}.py`, `tests/jobs/{check,validate,compare_runs}.test.ts`, `tests/jobs/validate_reports.slow.test.ts`, `tests/jobs/fake_b3/` |
| **B4 tools** (ephemeris, horizon, horizon_mask) | `src/contract/tools.ts`, `src/routes/tools.ts`, `src/contract/job_types/horizon_mask.ts`, `src/jobs/types/{horizon_mask,b4_tools}.ts`, `backend/python/{ephemeris_json,horizon_json,tools_common,tools_horizon_mask}.py`, `tests/tools.test.ts`, `tests/tools.horizon_mask.test.ts`, `tests/tools.slow.test.ts`, `tests/jobs/fake_b4/` |
| (không còn B2: `alt_dates_python` chuyển sang B1, `check` sang B3) | |
| **Khung** (không builder nào sửa; cần đổi thì báo coordinator) | `src/jobs/runner.ts`, `src/jobs/types/{define,index,custom_site}.ts`, `src/jobs/artifacts.ts`, `src/jobs/types.ts`, `src/jobs/params.ts`, `src/jobs/importer.ts`, `src/contract/{jobs,capabilities}.ts`, `src/contract/job_types/common.ts`, `src/python/{capabilities,scripts,process}.ts`, `src/routes/{jobs,capabilities}.ts`, `src/app.ts`, `src/lib/problem.ts`, `src/config.ts`, `backend/python/capabilities_probe.py` |
| File dùng chung, sửa tối thiểu | `tests/app.smoke.test.ts` (thêm `covered.add(...)` + số operation), `contract/openapi.json` (sinh lại bằng `npm run openapi:export`) |

**Không sửa** (workflow khác đang làm): `lunarnav/{horizon,precompute,cli,config}.py`, `lunarnav/terrain/trek.py`,
`src/contract/dataset.ts`, `src/routes/dataset*.ts`, `src/repos/dataset*.ts`. Cần thay đổi hành vi lunarnav → viết helper trong `backend/python/`.

## 7. Luật an toàn (bắt buộc)

- Python **luôn** qua `runPython()` (`src/python/process.ts`): không shell, args array, timeout, kill cả cây process, env allow-list
  (không bao giờ có `MONGODB_URI`). Job type chỉ trả `PythonPlan`; engine gọi `runPython`. Tool sync gọi `runPython` trực tiếp.
- Argv bằng `src/python/scripts.ts`: `lunarnavCliArgs(sub, args)`, `bridgeScriptArgs('x.py', args)`, `flagArg('--start', v)` (1 phần tử
  `--flag=value`, giá trị bắt đầu bằng `-` không bị argparse hiểu nhầm), `lunarnavEnv(cfg, {bridge: true})` cho script trong `backend/python/`
  (PYTHONPATH = LUNARNAV_ROOT).
- Đường dẫn đưa cho Python do server tính (job dir, `run.artifactsDir`, thư mục run qua `resolveRunOnDisk()` / `runDirectory()`), **không bao giờ**
  lấy từ request. Id/tên từ request phải qua regex của contract (SiteId, RunId...).
- Mọi output Python (stdout JSON, file JSON) phải `zod`-parse trước khi dùng. Text hiện cho client đi qua `run.sanitize()`.
- Giới hạn kích thước job tại `canonicalize` (vd. B1: tối đa sites × samples / job → `JOB_TOO_LARGE`), không đợi Python.

## 8. Giới hạn hiện có

| Giới hạn | Giá trị | Nơi |
|---|---|---|
| Job đồng thời / hàng đợi | `JOB_CONCURRENCY` 1, `JOB_QUEUE_MAX` 20 (chung mọi type) | config |
| Job active / client | `JOB_MAX_ACTIVE_PER_CLIENT` 2 | config |
| Kiểm tra khi tạo job mới | client limit + queue + ngân sách được kiểm tra rồi insert + enqueue **tuần tự** trong process (POST đồng thời không lọt) | runner |
| Lưu trữ run của job | custom_site / precompute: `JOB_RUNS_MAX_PER_CLIENT` 20 (→ 429 `QUOTA_EXCEEDED`), `JOB_RUNS_MAX_TOTAL` 200, `JOB_RUNS_MAX_MB` 10240, `DATA_DIR_MIN_FREE_MB` 2048 (→ 503 `STORAGE_FULL`); `Job.run_bytes` đo lúc xong | config / runner |
| TTL run precompute | `PRECOMPUTE_RUN_TTL_DAYS` 7 ngày (custom_site vẫn `CUSTOM_RUN_TTL_DAYS` 30) | config |
| Cache PGDA | tải mới ≤ `PGDA_DOWNLOAD_MAX_MB_PER_DAY` 1024 MB/ngày UTC (đo tăng trưởng cache quanh mỗi job/tool dem pgda; hết → 429 `QUOTA_EXCEEDED`), cache ≤ `PGDA_CACHE_MAX_MB` 4096 (xoá block dùng lâu nhất, giữ block dùng < 10 phút) | `src/python/pgdaCache.ts` |
| Timeout Python | `limits.timeout_s` ?? `JOB_TIMEOUT_S` 1200 s | def |
| TTL kết quả | `limits.result_ttl_h` ?? 720 h; failed/cancelled 24 h | def / runner |
| custom_site | ≤ 366 ngày, step 60, observer ≤ 100 m | `JOB_LIMITS` |
| ComputeOptions | step 1–1440 phút, radius ≤ 300 km, az_step 0.05–10°, observer ≤ 100 m, min_clearance ≤ 10° | `COMPUTE_LIMITS` |
| Artifacts | 50 file, 100 MB/file, 200 MB tổng | `ARTIFACT_LIMITS` |
| precompute / analyse | ≤ 30 site, ≤ 10 custom, ≤ 100 000 mẫu/site, ≤ 600 000 site×mẫu (≤ 150 000 với Horizons); Trek chỉ khi có file | `PRECOMPUTE_LIMITS` → 422 `JOB_TOO_LARGE` / `CAPABILITY_UNAVAILABLE` |
| alt_dates_python | ≤ 366 ngày, ≤ 200 000 mẫu, `max_results` ≤ 50 | def |
| compare_runs | ≤ 300 site, ≤ 15 000 000 site×mẫu | def |
| Tool sync | ≤ 200 thời điểm; radius ≤ 60 km (job `horizon_mask` ≤ 300 km); 2 slot, ≤ 8 chờ, ≤ 2 request/client đang chờ hoặc chạy (→ 429 `TOO_MANY_JOBS`); timeout tính cả thời gian chờ slot (hết khi còn chờ → 429 `QUEUE_FULL`); client ngắt kết nối → rời hàng đợi / Python bị kill; lat/lon làm tròn 4 chữ số như custom site | `TOOLS_LIMITS` |
| Rate limit POST | `RATE_LIMIT_POST_MAX` 5/phút/IP (`/jobs`, `/alt-dates`) | config |
| Rate limit tool | `RATE_LIMIT_TOOLS_MAX` 30/phút/IP, riêng từng tool | config |

Mã lỗi mới: `JOB_TYPE_UNAVAILABLE` (501), `CAPABILITY_UNAVAILABLE` (422), `JOB_TOO_LARGE` (422), `QUOTA_EXCEEDED` (429), `STORAGE_FULL` (503); lỗi job (`Job.error.code`):
`RESULT_FAILED`, `ARTIFACTS_FAILED` ngoài các mã cũ.

## 9. Kiểm thử

- Unit (Python giả): `overrideJobType('<type>', def)` hoặc một package `lunarnav` giả trong thư mục tạm làm `LUNARNAV_ROOT`
  (xem `tests/jobs/skeleton.test.ts`, `tests/jobs/fake_lunarnav/`). Mỗi route mới có test.
- 1 e2e thật / nhóm job, đặt tên `tests/**/<nhóm>.slow.test.ts`, bọc bằng `describe.skipIf(process.env['RUN_SLOW'] !== '1' || !HAVE_PY)`.
  `npm run test:slow` chạy **mọi** `*.slow.test.ts` (4 file: custom_site, B1, B3, B4; ~1 phút); 1 file:
  `npm run test:slow -- tests/tools.slow.test.ts`.
- Kiểm tra trực tiếp: instance riêng cổng 8200–8299, `DATA_DIR` riêng (KHÔNG dùng `backend/data`: cleanup sẽ xoá thư mục job
  của server khác) và **1 DB cho mỗi instance**: lúc khởi động, runner đánh dấu MỌI job `queued`/`running` trong DB là
  `SERVER_RESTARTED` (thiết kế 1 server / DB), nên 2 instance dùng chung DB sẽ làm hỏng job của nhau.
- `npm run typecheck`, `npx vitest run`, `npm run openapi:export`.

## 10. Kết quả tích hợp (2026-11-14)

- `npm run typecheck` sạch; `npm run openapi:check` cập nhật (30 operation); `npx vitest run`: mọi test của tích hợp Python pass (lần chạy cuối 385 pass / 18 skip; 2 test
  `tests/routes/dataset/*` đỏ do workflow `/dataset` đang sửa dở, không thuộc phần này);
  `npm run test:slow` 17 pass / 1 skip (test Horizons chỉ chạy với `RUN_NETWORK=1`).
- Chạy thật (cổng 8250, DB `lunarnav_pyint`): precompute 3 site × 3 ngày spice+pgda (import, `summary.csv`), analyse `group:south_pole`
  (12 site), alt_dates_python, check (0 vi phạm), compare_runs, validate quick, validate_terrain quick (205 s, 22/26 check: kết quả
  khoa học của lunarnav), horizon_mask 100 km; tool ephemeris / horizon; artifacts (ETag, 304, CSP sandbox, tên lạ 400); cache hit;
  `JOB_TOO_LARGE`, `CAPABILITY_UNAVAILABLE` (trek), `SITE_NOT_FOUND`, `RUN_NOT_FOUND`. FE thô tab 6 (`?api=`): capabilities, form job
  sinh từ OpenAPI, job check, ephemeris (bảng + biểu đồ), horizon (360 phương vị), nút chuyển sang job `horizon_mask`.
- Cũng chạy với bản lunarnav đóng băng `D:\UAV\lunarnav_runs\lunarnav_stable` (bản server 8000 dùng): mọi job type chạy được
  offline; `cli.near_exclusion_m = false` nên `near_exclusion_m` dạng số → 422 (`'auto'` vẫn được).
- Lưu ý: `params_hash` chứa `lunarnav.__version__` (hiện là `0.1.0` ở cả bản sống lẫn bản đóng băng), nên đổi code lunarnav mà không
  tăng version thì cache hit vẫn trả kết quả cũ: tăng `__version__` khi kết quả tính thay đổi.
- Lưu ý (sửa sau review): lunarnav mở **mọi** sản phẩm PGDA qua `/vsicurl/` trước khi dùng cache block (`PgdaDem.__init__`), nên mất mạng thì kể cả sản phẩm đã cache đủ cũng không mở được. Vì vậy `GET /capabilities` báo `dems.pgda` unavailable khi `network.pgda.reachable = false` (bất kể `cached_products`) → job dem pgda bị từ chối 422 `CAPABILITY_UNAVAILABLE`; bridge tool đổi lỗi `cannot open PGDA product` thành 422 `CAPABILITY_UNAVAILABLE` (trước đây 502). Khi tắt probe mạng (`CAPABILITIES_NETWORK_PROBE=false`) server không biết trước: job → `PYTHON_FAILED`, tool → 422.
