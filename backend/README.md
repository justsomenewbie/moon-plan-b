# lunarnav backend (Fastify 5 + TypeScript + zod 4 + MongoDB)

Web API cho Lunar Landing Site Navigator (NASA Space Apps 2026). Kế hoạch: `../docs/WEB_BACKEND_PLAN.md`;
định dạng dữ liệu Python: `../docs/OUTPUT_SPEC.md`; cho dev FE: `../docs/FE_INTEGRATION.md`;
triển khai VPS: `../docs/DEPLOY_VPS.md`; công cụ Python qua API (job type, tool, artifacts, capabilities):
`../docs/PYTHON_INTEGRATION.md`.

## Yêu cầu
- Node >= 24 (dev: 24.16, chạy `.ts` trực tiếp bằng type stripping, không cần tsx), npm 11.
- MongoDB local (dev: service Windows `mongodb://127.0.0.1:27017`, DB `lunarnav_dev`).
- Python venv `..\.venv` (lunarnav cài editable): cổng `lunarnav check` khi import, alt-dates, jobs.

## Cài đặt và chạy lần đầu
```powershell
cd D:\UAV\lunar-navigator\backend
npm install
copy .env.example .env                    # tuỳ chọn; mọi biến được validate trong src/config.ts
npm run import -- ..\output\sample_2026Q1_spice_pgda --default   # nạp 1 run precompute (Colab) vào MongoDB
npm run dev                                # http://127.0.0.1:3000/api/v1/health , docs /docs
```

## Lệnh
| Lệnh | Việc |
|---|---|
| `npm run dev` / `npm start` | Server (watch) / bản build `dist/` |
| `npm run import -- <dir> [--run-id ID] [--label T] [--default] [--force] [--dry-run] [--no-check] [--no-copy] [--kind precompute\|custom] [--stats]` | Import 1 thư mục output Python (idempotent; cổng `lunarnav check` + sha256; copy vào `DATA_DIR/runs/<run_id>/`) |
| `npm test` | vitest, toàn bộ (mongodb-memory-server **MongoDB 8.0.23**, không bao giờ đụng DB dev) |
| `npm run test:slow [-- <file>]` | Mọi `*.slow.test.ts` với lunarnav thật (custom_site, precompute/analyse/alt_dates_python, check/validate/compare_runs, tool + horizon_mask; ~1 phút) |
| `npm run typecheck` (= `lint`) | `tsc --noEmit`, strict |
| `npm run openapi:export` / `openapi:check` | Ghi / kiểm tra `contract/openapi.json` (smoke test cũng kiểm tra) |
| `npm run lint:openapi` | `@redocly/cli lint` trên spec |
| `npm run mock` | Prism 5.15.11 mock từ spec tại http://127.0.0.1:4010 |
| `npm run examples:capture` | Chụp lại `contract/examples/*` (response thật; thêm `-- --base-url http://127.0.0.1:3000` để chụp từ server đang chạy) |
| `bash scripts/e2e-curl.sh [BASE_URL]` | E2E bằng curl trên server đang chạy (env `E2E_START`/`E2E_END` để dùng khoảng chưa có cache, `E2E_DEM=none` khi không có mạng): mọi endpoint + 1 job toạ độ tuỳ chỉnh thật → `contract/examples/e2e/` (`report.tsv`, `job_timeline.tsv`) |
| `npm run fixtures` | Sinh lại `src/fixtures/*.json` (examples của spec) từ `../output/sample_2026Q1_spice_pgda` |

Ghi chú mock: Prism trả **422** khi request sai schema (header `sl-violations`); server thật trả **400** `VALIDATION_ERROR`.
Prism không bắt tham số query lạ, ngày không có thật, `weights` trùng/toàn 0. `POST /jobs` trên mock trả 200 "cache hit"
(mã 2xx nhỏ nhất); luồng chờ: header `Prefer: code=202`.

## Xác thực (API key)
- Mọi route `/api/v1/*` **trừ `GET /api/v1/health`** (và preflight `OPTIONS`) cần `X-API-Key: <key>` (hoặc
  `Authorization: Bearer <key>`). Thiếu / sai key → `401 UNAUTHORIZED` (problem+json, cùng một body cho cả hai,
  header `WWW-Authenticate: ApiKey header="X-API-Key"`). Code: `src/lib/auth.ts` (1 hook `onRequest` gốc, chạy trước
  rate limit; so sánh hằng thời gian trên SHA-256).
- `API_KEYS=fe:<key>,tester:<key>` (hoặc chỉ `<key>,<key>` → tên `key1`, `key2`); tạo key: `openssl rand -hex 32`
  (≥ 32 ký tự). Tên client nằm trong log (`client`) và là khoá rate limit (mọi request của 1 key chung 1 bucket); key
  không bao giờ bị log.
- `/docs`, `/docs/*`, `/api/v1/openapi.json`: HTTP Basic `DOCS_USER` / `DOCS_PASSWORD` (mật khẩu ≥ 12 ký tự). Swagger UI
  có nút **Authorize** để dán API key (nhớ qua reload: `persistAuthorization`).
- `NODE_ENV=production` mà thiếu `API_KEYS` hoặc `DOCS_USER`/`DOCS_PASSWORD` → không khởi động (`ConfigError`).
  Ngoài production, để trống → tắt xác thực (cảnh báo khi khởi động), docs mở; test mặc định chạy như vậy
  (`tests/helpers.ts`), `tests/auth.test.ts` truyền key.
- FE gọi API **từ server Next.js** (route handler giữ key trong env `LUNARNAV_API_KEY`), không bao giờ từ trình duyệt:
  `../docs/FE_INTEGRATION.md` mục "Xác thực (API key)". Kiểm tra server thật: `E2E_API_KEY=<key> E2E_DOCS_AUTH=user:pass bash scripts/e2e-curl.sh <url>`.

## Hành vi cần biết (vận hành)
- **Cache**: data GET có `run_id` → `Cache-Control: public, max-age=3600`; không có `run_id` (đọc run mặc định, đổi
  được bằng `import --default`) → `max-age=60`. Một chỗ quyết định: `cacheControlFor()` trong `src/routes/a/http_cache.ts`.
  `Vary` được nối thêm (giữ `Origin` của CORS). File thô `GET /runs/{id}/files/*`: không nén, ETag mạnh = sha256 manifest.
- **File của run**: đọc từ `DATA_DIR/runs/<run_id>/` nếu có (mọi run import có copy + output job), nếu không thì
  `runs.source_dir` (import `--no-copy`). Nhờ vậy DB chuyển máy (mongodump → mongorestore) vẫn tìm được file.
- **Job dùng chung theo client** (client = IP, IPv6 gộp theo /64; sau Caddy dùng `X-Forwarded-For` nhờ `trustProxy: 'loopback'`):
  POST trùng tham số đăng ký client vào job đang chạy; `DELETE` chỉ gỡ client của mình, Python bị kill khi không còn
  ai chờ; client lạ → `403 JOB_NOT_YOURS`. `JOB_MAX_ACTIVE_PER_CLIENT` (mặc định 2, `0` = tắt) → `429 TOO_MANY_JOBS`.
  Kiểm tra giới hạn + insert + enqueue của job MỚI chạy tuần tự trong process (POST đồng thời không vượt được giới hạn).
  Ngân sách lưu trữ run của job (custom_site, precompute): `JOB_RUNS_MAX_PER_CLIENT` 20 → `429 QUOTA_EXCEEDED`;
  `JOB_RUNS_MAX_TOTAL` 200, `JOB_RUNS_MAX_MB` 10240, `DATA_DIR_MIN_FREE_MB` 2048 → `503 STORAGE_FULL`; run precompute sống
  `PRECOMPUTE_RUN_TTL_DAYS` 7 ngày. PGDA: `PGDA_DOWNLOAD_MAX_MB_PER_DAY` 1024 (→ `429 QUOTA_EXCEEDED` cho việc dem pgda mới),
  `PGDA_CACHE_MAX_MB` 4096 (cache tile bị cắt, block cũ nhất trước).
  SSE: `SSE_MAX_PER_CLIENT` (mặc định 5) stream/client → `429 TOO_MANY_STREAMS`; 1 lần poll Mongo / job cho mọi stream.
- **Tiến trình Python**: env của tiến trình con là **allow-list** (`PATH`, `SYSTEMROOT`, `TEMP`, `HOME`, `PYTHON*`,
  `LUNARNAV_*`, proxy/CA, `LC_*`...) — không bao giờ có `MONGODB_URI`. Trên Windows `.venv\Scripts\python.exe` (launcher)
  được thay bằng interpreter gốc của venv + `__PYVENV_LAUNCHER__` (y như launcher làm) → huỷ job không còn để lại
  python.exe mồ côi giữ pipe; ngoài ra sau khi kill, chờ stdio tối đa `STDIO_DRAIN_MS` (5 s) rồi đóng pipe, nên slot
  hàng đợi không bao giờ bị treo.

- **Công cụ Python** (`../docs/PYTHON_INTEGRATION.md`): `POST /jobs` nhận `type` = `custom_site`, `precompute`, `analyse`,
  `alt_dates_python`, `check`, `validate`, `validate_terrain`, `compare_runs`, `horizon_mask` (cùng 1 hàng đợi, giới hạn kích thước
  kiểm tra ngay lúc POST → `422 JOB_TOO_LARGE`); file kết quả ở `GET /jobs/{id}/artifacts[/{name}]` (chỉ tên đã đăng ký, ETag sha256);
  tool đồng bộ `POST /tools/ephemeris`, `POST /tools/horizon` (rate limit riêng `RATE_LIMIT_TOOLS_MAX`, mặc định 30/phút/IP);
  `GET /capabilities` cho biết provider / DEM / job type / cờ CLI (`--near-exclusion-m`) nào chạy được (probe lúc khởi động, cache
  `CAPABILITIES_TTL_S`, `?refresh=true`; `CAPABILITIES_NETWORK_PROBE=false` tắt HEAD tới JPL/PGDA). API không bao giờ tải DEM Trek;
  `dem: trek` chỉ chạy khi GeoTIFF có sẵn trong `LUNARNAV_DATA/dem`.
- **1 DB cho 1 server**: lúc khởi động runner đánh dấu mọi job `queued`/`running` trong DB là `SERVER_RESTARTED`; đừng cho 2 instance
  dùng chung `MONGODB_DB` (hay `DATA_DIR`).

## Kiểm thử
- `tests/fixtures/sample_2026Q1_spice_pgda/`: bản sao byte-exact của run mẫu thật (6 site, 2026-Q1, SPICE + PGDA,
  1.6 MB; `tests/.gitattributes` cấm git đổi xuống dòng vì manifest chứa sha256) → test dữ liệu thật không bao giờ bị skip.
- `tests/crosscheck/api_vs_python.test.ts`: API so với file Python và hàm lunarnav (summary.csv, windows.json,
  visibility.csv.gz tại thời điểm ngẫu nhiên, horizon_*.csv, `lunarnav.windows` cho instant) — so sánh **chính xác**.
  Chạy cùng các kiểm tra trên run khác (vd. output của một job tuỳ chỉnh):
  `LUNARNAV_SAMPLE_DIR=data/runs/job_<id> npx vitest run tests/crosscheck`.
- `tests/app.smoke.test.ts`: mọi operation của OpenAPI trên run mẫu đã import; jobs/alt-dates dùng lunarnav giả
  (`tests/jobs/fake_lunarnav`).
- `tests/review_fixes.test.ts`: test hồi quy cho các lỗi của review cuối (cache/Vary, 415, ETag file thô, weights,
  TOO_MANY_POINTS ở compare, ngày không có thật trong body, source_dir cũ, env Python, cháu mồ côi giữ pipe, SSE poller).

## Cấu trúc
```
src/config.ts          env (zod)               src/db.ts          MongoClient + registry collection/index
src/app.ts             buildApp(opts)          src/server.ts      listen + graceful shutdown
src/contract/*.ts      zod schemas = CONTRACT (1 file / nhóm endpoint)
src/routes/*.ts        1 plugin / nhóm (routes/a/: ranking/metrics/range helper của nhóm A)
src/repos/             LỚP TRUY CẬP DỮ LIỆU DUY NHẤT (đọc runs/sites/site_runs/horizons/windows/series)
src/importer/          output Python -> MongoDB (CLI: scripts/import-run.ts)
src/python/            cầu nối Python (execa): runPython, argv/env an toàn, alt-dates, capabilities probe
python/                bridge script (JSON qua stdin/stdout) cho job type / tool: *_json.py, compare_runs.py ...
src/jobs/              hàng đợi job (p-queue + collection jobs), artifacts, dọn dẹp TTL; types/ = 1 file / job type
src/lib/               problem (RFC 9457), naming (snake_case, 1 chỗ), time, provenance, openapi
src/fixtures/          JSON trích từ output thật -> examples của openapi.json (không route nào dùng)
```

## Đổi contract
1. Sửa schema trong `src/contract/` và handler trong `src/routes/<nhóm>.ts`; đọc dữ liệu qua `src/repos/index.ts`.
2. Lỗi: `throw new ApiError('CODE', detail)` hoặc `siteNotFound()/runNotFound()/jobNotFound()`.
3. `npm run openapi:export`, commit `contract/openapi.json`, `npm run examples:capture`, báo dev FE.
   Luật v1: **chỉ thêm** field/endpoint tuỳ chọn; thay đổi phá vỡ => `/api/v2`.
