# FE handoff: tích hợp Next.js với Lunar Navigator API (production)

> Tài liệu tự đủ cho agent AI của team FE (Next.js App Router, TypeScript). Không cần truy cập repo backend.
> Ngày viết: 14-11-2026. API `v1` (`api_version` 1.0.0). Nguồn sự thật: OpenAPI 3.1 tải từ server (mục 3).
> Không có key/mật khẩu thật trong file này: `<LUNARNAV_API_KEY>`, `<DOCS_USER>`, `<DOCS_PASSWORD>` do team lead gửi riêng.

---

## Gọi nhanh: gọi thẳng `https://api.lunavigator.com` (cập nhật 14-11, 21:45)

API **đã chạy**. FE (chạy local hoặc trên Vercel) gọi **thẳng** base URL thật, kèm header `X-API-Key`:

```
NEXT_PUBLIC_LUNARNAV_API_BASE=https://api.lunavigator.com/api/v1     # base URL (không bí mật)
LUNARNAV_API_KEY=<LUNARNAV_API_KEY>                                   # key do team lead gửi riêng
```

```ts
// gọi từ server (route handler / server component / server action) - key không lộ ra trình duyệt
const res = await fetch(`https://api.lunavigator.com/api/v1/dataset?site_ids=im2_athena&start=2026-11-14T00:00:00Z&end=2026-11-21T00:00:00Z`, {
  headers: { 'X-API-Key': process.env.LUNARNAV_API_KEY! },
  cache: 'no-store',
});
```

- **CORS đã mở** cho trình duyệt từ: `http://localhost:3000`, `http://127.0.0.1:3000`, mọi `https://*.vercel.app`,
  `https://lunavigator.com`, `https://www.lunavigator.com`. Origin khác bị trình duyệt chặn. Cần thêm origin thì báo team lead.
- Gọi thẳng **từ trình duyệt** (client component) cũng chạy được trong giai đoạn test, nhưng khi đó key nằm trong JS
  (ai mở F12 cũng thấy): chỉ dùng khi test, **không** dùng `NEXT_PUBLIC_` cho key ở bản chính thức. Bản chính thức
  nên gọi qua server (mục 2.5) hoặc proxy (mục 2.3).
- Kiểm tra sống: mở `https://api.lunavigator.com/api/v1/health` → `"status":"ok"` và `default_run_id` khác `null`.
- Swagger để thử tay: `https://api.lunavigator.com/docs` (user/mật khẩu team lead gửi riêng; bấm **Authorize**, dán key).
- Giới hạn job/SSE/quyền huỷ job tính **theo API key** (không theo IP), nên Vercel đổi IP vẫn huỷ được job của mình.
- Đã kiểm tra từ Internet lúc 21:45: health, 401 khi thiếu/sai key, `/runs`, `/sites`, `/dataset`, `/instant`, `/windows`,
  `/series`, `/sky`, `/horizon`, `/ranking`, `/compare`, `/alt-dates`, `/export/summary.csv`, `/meta`, `/capabilities`,
  CORS preflight từ `localhost:3000` và `*.vercel.app`, job `custom_site` (202 → SSE → `succeeded`).

---

## 0. TL;DR: checklist cho agent FE

1. Base URL production: `https://api.lunavigator.com/api/v1` (chỉ HTTPS). Server LAN cũ `http://192.168.1.63:8000` **không dùng nữa**.
2. Mọi route `/api/v1/*` trừ `GET /health` cần header `X-API-Key: <key>`. Thiếu/sai key → `401 UNAUTHORIZED`.
3. Gọi thẳng `https://api.lunavigator.com/api/v1` (xem mục "Gọi nhanh" ở trên; CORS mở cho localhost và `*.vercel.app`).
   Khuyến nghị cho bản chính thức: key chỉ nằm trên server Next.js (`LUNARNAV_API_KEY`), gọi qua server (mục 2.5)
   hoặc proxy cùng origin `/api/lunar/...` (mục 2.3).
4. Sinh type TS từ OpenAPI (`openapi-typescript@7.13.0`), không viết tay type response.
5. Không hard-code `run_id`: bỏ trống (= run mặc định) hoặc đọc `GET /runs` (`is_default`). Run mặc định hiện tại:
   `B2_spice_pgda_bruteforce_2026_2030_fix676af9d`.
6. `/dataset` **luôn** gửi `start`/`end` (hoặc `max_points`), nếu không sẽ `422` "Series point limit exceeded".
7. Mọi lỗi là `application/problem+json`. `switch` theo `code`; hiển thị `title`/`detail`/`hint`.
8. Rate limit tính **theo key**: mọi người dùng FE dùng chung một ngân sách (≈3000 req/phút, 120 POST/phút,
   6 job đang chạy, 50 SSE). Bắt buộc cache, debounce, poll ≥ 2 s (ưu tiên SSE), tự throttle theo người dùng.
9. Job toạ độ tuỳ chọn: chỉ dùng `type: "custom_site"`. `200` = đã có sẵn kết quả, `202` = đã xếp hàng; cả hai có `job_id` + `poll`.
10. Thời gian: UTC ISO-8601 có `Z`; khoảng là `[start, end)`; server snap theo lưới 1 giờ và **echo** giá trị thật đã dùng
    → luôn vẽ theo giá trị echo.
11. Route đánh dấu "ĐANG HOÀN THIỆN" (mục 5.3): chưa chốt giao diện.

---

## 1. Môi trường, base URL, health check

| Mục | Giá trị |
|---|---|
| API base (production) | `https://api.lunavigator.com/api/v1` (sau Cloudflare + nginx, chỉ HTTPS) |
| Health (không cần key) | `GET https://api.lunavigator.com/api/v1/health` |
| Swagger UI | `https://api.lunavigator.com/docs`: HTTP Basic auth (`<DOCS_USER>` / `<DOCS_PASSWORD>`), có nút **Authorize** để dán API key và bấm "Try it out" |
| OpenAPI JSON | `https://api.lunavigator.com/api/v1/openapi.json` (cùng Basic auth; `/docs/json` của Swagger UI cũng trả spec) |
| Server LAN cũ | `http://192.168.1.63:8000`: **bỏ**, FE không gọi nữa |

```bash
curl -s https://api.lunavigator.com/api/v1/health
```
```json
{
  "status": "ok", "api_version": "1.0.0", "node_version": "v24.16.0", "time_utc": "2026-11-14T06:05:18Z", "uptime_s": 337.1,
  "mongo": { "ok": true, "latency_ms": 9.9, "db": "lunarnav" },
  "python": { "ok": true, "lunarnav_code_version": "0.1.0" },
  "default_run_id": "B2_spice_pgda_bruteforce_2026_2030_fix676af9d"
}
```
- `status: "degraded"` = API sống nhưng MongoDB hoặc Python không dùng được → hiện banner "dịch vụ gián đoạn".
- `default_run_id` = run dùng khi request không có `run_id`. (Ví dụ trên đã rút gọn `python`; giá trị `db` minh hoạ.)

Dữ liệu trên production:
- **Run B (mặc định)** `B2_spice_pgda_bruteforce_2026_2030_fix676af9d`: ephemeris SPICE + địa hình NASA PGDA LOLA,
  `2026-01-01T00:00:00Z` → `2031-01-01T00:00:00Z` (end exclusive), bước 1 h (43 824 mẫu/site), **23 site** catalogue.
- **Run A** (JPL Horizons + địa hình Moon Trek) sẽ được thêm sau, **không** phải mặc định. Run picker lấy từ `GET /runs`.
- Run custom (`job_<job_id>`) sinh ra từ job `custom_site`, hết hạn sau 30 ngày (`expires_at`).

---

## 2. Xác thực + proxy Next.js

### 2.1 Quy tắc xác thực (server)
- Header: `X-API-Key: <LUNARNAV_API_KEY>` (server cũng nhận `Authorization: Bearer <key>`; dùng một cách là đủ, ưu tiên `X-API-Key`).
- Không cần key: `GET /api/v1/health`, và preflight `OPTIONS` (CORS) không bị chặn.
- Thiếu hoặc sai key (giống hệt nhau) → `401`, header `WWW-Authenticate: ApiKey header="X-API-Key"`:
```json
{
  "type": "https://lunarnav.example/errors/unauthorized",
  "title": "Missing or invalid API key",
  "status": 401,
  "code": "UNAUTHORIZED",
  "detail": "send a valid API key in the X-API-Key header (or Authorization: Bearer <key>)",
  "instance": "/api/v1/sites"
}
```

### 2.2 Biến môi trường và luật bảo mật

`.env.local` (dev) và env của server production (Vercel/VPS), **không commit**:
```bash
LUNARNAV_API_BASE=https://api.lunavigator.com/api/v1
LUNARNAV_API_KEY=<LUNARNAV_API_KEY>
```
Luật bắt buộc:
1. **Không bao giờ** đặt key vào biến `NEXT_PUBLIC_*`, `next.config` `env`, props truyền xuống client component, HTML, log, hay URL/query string.
2. Trình duyệt **không** gọi thẳng `https://api.lunavigator.com`. Chỉ gọi `/api/lunar/...` cùng origin. Không cần CORS.
3. Không dùng `rewrites` của `next.config` để proxy tới API: rewrite không thêm được header bí mật.
4. Server Component / Server Action / route handler có thể gọi thẳng API (mục 2.5) vì chạy trên server.
5. `.gitignore` phải có `.env*.local`. Sau khi build: `grep -r "<một đoạn của key>" .next/static` phải **không** ra gì.
6. Key lộ → báo team lead để thay key (backend đổi `API_KEYS`), không tự "giấu" ở FE.

### 2.3 Proxy: `app/api/lunar/[...path]/route.ts` (copy nguyên file)

Hành vi:
- `/api/lunar/<path>?<query>` → `${LUNARNAV_API_BASE}/<path>?<query>` (path giữ nguyên percent-encoding, query giữ nguyên).
  Cũng nhận dạng `/api/lunar/api/v1/<path>` (tương thích client `openapi-fetch` với `baseUrl: '/api/lunar'`, mục 3).
- Chỉ cho phép các route trong allow-list theo method; chặn `..`, `\`, `//`; body tối đa 1 MiB; tuỳ chọn chỉ cho job `custom_site`.
- Chuyển tiếp header request `content-type`, `accept`, `if-none-match`; thêm `X-API-Key`. Không chuyển cookie/Authorization của trình duyệt.
- Trả lại status + header `content-type`, `etag`, `cache-control`, `retry-after`, `x-ratelimit-*`, `x-lunarnav-cache`,
  `location` (đổi `/api/v1/...` → `/api/lunar/...`), `content-disposition`. Bỏ `content-encoding`/`content-length`
  (Node `fetch` đã giải nén body).
- Stream body (kể cả SSE `text/event-stream` của `/jobs/{id}/events`), huỷ request upstream khi client ngắt kết nối,
  timeout 180 s cho request thường (không áp cho SSE).
- Throttle đơn giản theo người dùng (in-memory). Trên serverless mỗi instance có bộ đếm riêng, nên đây chỉ là lớp bảo vệ thô.

```ts
// app/api/lunar/[...path]/route.ts
// Server-side proxy tới Lunar Navigator API. Key chỉ đọc từ env server, không bao giờ gửi xuống trình duyệt.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 300; // Vercel: giới hạn thời gian function (giây). Bỏ dòng này nếu tự host.

const API_BASE = (process.env.LUNARNAV_API_BASE ?? 'https://api.lunavigator.com/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.LUNARNAV_API_KEY ?? '';
const PROXY_PREFIX = '/api/lunar/';
const UPSTREAM_PREFIX = '/api/v1/';
const TIMEOUT_MS = 180_000; // alt-dates / tools / dataset lớn có thể lâu
const MAX_BODY_BYTES = 1024 * 1024; // = giới hạn của API (413 PAYLOAD_TOO_LARGE)
const ONLY_CUSTOM_SITE_JOBS = true; // FE chỉ dùng job type custom_site (các type khác đang hoàn thiện)

// Throttle theo người dùng (mỗi instance server một bộ đếm). Chỉnh theo nhu cầu.
const USER_WINDOW_MS = 60_000;
const USER_MAX_REQUESTS = 240;
const USER_MAX_POSTS = 10;

type Method = 'GET' | 'POST' | 'DELETE';

const SEG = '[A-Za-z0-9._~:%-]+'; // một segment, vẫn percent-encoded (site id có ':' -> %3A, file_path có %2F)
const SITE_SUB = '(?:/(?:horizon|series|instant|sky|windows|pointing|export/series\\.csv|export/windows\\.csv))?';
const ROUTES: Record<Method, RegExp[]> = {
  GET: [
    /^health$/, /^meta$/, /^capabilities$/, /^runs$/, /^sites$/, /^ranking$/, /^dataset$/, /^export\/summary\.csv$/,
    new RegExp(`^runs/${SEG}$`),
    new RegExp(`^runs/${SEG}/files/${SEG}$`),
    new RegExp(`^sites/${SEG}${SITE_SUB}$`),
    new RegExp(`^jobs/${SEG}(?:/events|/artifacts(?:/${SEG})?)?$`),
  ],
  POST: [/^compare$/, /^alt-dates$/, /^jobs$/, /^mission\/survival$/, /^tools\/(?:ephemeris|horizon)$/],
  DELETE: [new RegExp(`^jobs/${SEG}$`)],
};

const REQUEST_HEADERS = ['content-type', 'accept', 'if-none-match'];
const RESPONSE_HEADERS = [
  'content-type', 'etag', 'cache-control', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'x-ratelimit-reset', 'x-lunarnav-cache', 'location', 'content-disposition',
];
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function problem(status: number, code: string, title: string, detail: string, instance: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title, status, code, detail, instance }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...headers },
  });
}

/** Path sau tiền tố, vẫn percent-encoded; null nếu không hợp lệ. */
function apiPath(rawPathname: string): string | null {
  if (!rawPathname.startsWith(PROXY_PREFIX)) return null;
  let rest = rawPathname.slice(PROXY_PREFIX.length);
  if (rest.startsWith('api/v1/')) rest = rest.slice('api/v1/'.length); // dạng /api/lunar/api/v1/...
  if (rest.length === 0 || rest.length > 600 || rest.includes('//') || rest.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.split('/').some((s) => s === '..' || s === '.') || decoded.includes('\\') || /[\u0000-\u001f]/.test(decoded)) return null;
  return rest;
}

/** Location của API (/api/v1/jobs/j_x) -> URL qua proxy (/api/lunar/jobs/j_x). */
function toProxyLocation(location: string): string {
  try {
    const u = new URL(location, `${API_BASE}/`);
    if (u.pathname.startsWith(UPSTREAM_PREFIX)) return `${PROXY_PREFIX}${u.pathname.slice(UPSTREAM_PREFIX.length)}${u.search}`;
  } catch {
    /* giữ nguyên */
  }
  return location;
}

const buckets = new Map<string, { start: number; all: number; posts: number }>();
function userAllowed(req: Request, method: Method): boolean {
  // Sau Vercel / nginx: x-forwarded-for do hạ tầng đặt. Nếu Next.js lộ trực tiếp ra Internet, header này giả mạo được.
  const key = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'anonymous';
  const now = Date.now();
  if (buckets.size > 10_000) for (const [k, b] of buckets) if (now - b.start > USER_WINDOW_MS) buckets.delete(k);
  let b = buckets.get(key);
  if (!b || now - b.start > USER_WINDOW_MS) {
    b = { start: now, all: 0, posts: 0 };
    buckets.set(key, b);
  }
  b.all += 1;
  if (method === 'POST') b.posts += 1;
  return b.all <= USER_MAX_REQUESTS && b.posts <= USER_MAX_POSTS;
}

async function handle(req: Request, method: Method): Promise<Response> {
  const url = new URL(req.url);
  const instance = url.pathname;
  if (!API_KEY) {
    console.error('[lunar-proxy] LUNARNAV_API_KEY is not set');
    return problem(500, 'PROXY_MISCONFIGURED', 'Proxy misconfigured', 'LUNARNAV_API_KEY is not set on the server', instance);
  }
  const path = apiPath(url.pathname);
  if (path === null || !ROUTES[method].some((re) => re.test(path))) {
    return problem(404, 'NOT_FOUND', 'Route not found', `no proxied route ${method} ${instance}`, instance);
  }
  if (!userAllowed(req, method)) {
    return problem(429, 'RATE_LIMITED', 'Too many requests', 'per-user limit of the FE proxy exceeded', instance, { 'retry-after': '30' });
  }

  let body: ArrayBuffer | undefined;
  if (method === 'POST') {
    if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
      return problem(413, 'PAYLOAD_TOO_LARGE', 'Request body too large', 'body > 1 MiB', instance);
    }
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return problem(413, 'PAYLOAD_TOO_LARGE', 'Request body too large', 'body > 1 MiB', instance);
    if (ONLY_CUSTOM_SITE_JOBS && path === 'jobs') {
      let type: unknown;
      try {
        type = (JSON.parse(new TextDecoder().decode(body)) as { type?: unknown }).type;
      } catch {
        type = undefined; // JSON hỏng: để API trả 400 VALIDATION_ERROR
      }
      if (type !== undefined && type !== 'custom_site') {
        return problem(400, 'VALIDATION_ERROR', 'Invalid request', 'this app only allows job type custom_site', instance);
      }
    }
  }

  const headers = new Headers();
  for (const h of REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  headers.set('x-api-key', API_KEY);
  headers.set('user-agent', 'lunarnav-fe-proxy/1.0');

  const isSse = method === 'GET' && /^jobs\/[^/]+\/events$/.test(path);
  const ac = new AbortController();
  const onClientAbort = () => ac.abort(req.signal.reason);
  if (req.signal.aborted) ac.abort(req.signal.reason);
  else req.signal.addEventListener('abort', onClientAbort, { once: true });
  let timedOut = false;
  const timer = isSse ? undefined : setTimeout(() => { timedOut = true; ac.abort(); }, TIMEOUT_MS);
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    req.signal.removeEventListener('abort', onClientAbort);
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/${path}${url.search}`, {
      method,
      headers,
      body,
      signal: ac.signal,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (e) {
    cleanup();
    if (timedOut) return problem(504, 'UPSTREAM_TIMEOUT', 'Upstream timeout', `API did not answer within ${TIMEOUT_MS / 1000} s`, instance);
    if (req.signal.aborted) return new Response(null, { status: 499 }); // client đã đi, không ai đọc
    console.error('[lunar-proxy] upstream error', e);
    return problem(502, 'UPSTREAM_UNREACHABLE', 'API unreachable', 'the Lunar Navigator API could not be reached', instance);
  }

  if (upstream.status === 401) console.error('[lunar-proxy] API answered 401: check LUNARNAV_API_KEY');

  const out = new Headers();
  for (const h of RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v !== null) out.set(h, h === 'location' ? toProxyLocation(v) : v);
  }
  if (isSse) {
    out.set('cache-control', 'no-cache, no-transform'); // không nén / không buffer SSE
    out.set('x-accel-buffering', 'no'); // nginx đứng trước Next.js: không buffer
  }

  if (NULL_BODY_STATUS.has(upstream.status) || upstream.body === null) {
    cleanup();
    return new Response(null, { status: upstream.status, headers: out });
  }
  // Stream nguyên văn; flush() dọn timer khi body đọc xong. Client ngắt -> Next huỷ stream -> huỷ upstream.
  const stream = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: cleanup }));
  return new Response(stream, { status: upstream.status, headers: out });
}

export function GET(req: Request): Promise<Response> {
  return handle(req, 'GET');
}
export function POST(req: Request): Promise<Response> {
  return handle(req, 'POST');
}
export function DELETE(req: Request): Promise<Response> {
  return handle(req, 'DELETE');
}
export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { allow: 'GET, POST, DELETE, OPTIONS' } });
}
```
Ghi chú proxy:
- Dùng `new URL(req.url).pathname` thay vì `params.path`: `params` đã bị decode (`%2F` → `/`, `%3A` → `:`), làm hỏng
  `GET /runs/{run_id}/files/{file_path}` (cần `%2F`). Cách này cũng chạy trên cả Next 14 và 15 (`params` là Promise ở 15).
- Mã `PROXY_MISCONFIGURED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNREACHABLE` và `429`/`404`/`413`/`400` ở trên do **proxy** sinh
  (không có trong enum `Problem['code']` của OpenAPI) → khai báo thêm trong union code của FE (mục 7).
- Vercel: SSE bị cắt khi function hết `maxDuration`. `EventSource` sẽ tự nối lại, hoặc chuyển sang polling 2 s.

### 2.4 Client component gọi proxy
```ts
// URL tương đối, cùng origin; không có key nào ở đây.
const res = await fetch(
  '/api/lunar/dataset?site_ids=ref_shackleton_rim,a3_haworth&start=2026-03-01T00:00:00Z&end=2026-03-08T00:00:00Z&include=metrics,windows',
  { headers: { accept: 'application/json' } },
);
if (!res.ok) throw await res.json(); // application/problem+json
const data = await res.json();
```
- Site id có `:` (custom) → `encodeURIComponent()` khi đặt vào **path**: `/api/lunar/sites/${encodeURIComponent(id)}`.
  Trong query (`site_ids=`) dùng `URLSearchParams` (tự encode).
- `Location` header của `202 POST /jobs` đã được proxy đổi sang `/api/lunar/jobs/<id>`. Nhưng các URL **trong body**
  (`poll`, `artifacts[].url`, `run.manifest_url`) vẫn là `/api/v1/...` → map bằng `toProxyUrl()` (mục 3.2).
- Link tải CSV: `<a href="/api/lunar/sites/a3_haworth/export/windows.csv?start=...&end=..." download>` (proxy chuyển `content-disposition`).

### 2.5 Server Component / Server Action (gọi thẳng API, không qua proxy)
```ts
// src/lib/lunar/server.ts
import 'server-only';

const BASE = (process.env.LUNARNAV_API_BASE ?? 'https://api.lunavigator.com/api/v1').replace(/\/+$/, '');

export async function lunarServer<T>(pathAndQuery: string, revalidateS = 60): Promise<T> {
  const res = await fetch(`${BASE}/${pathAndQuery.replace(/^\/+/, '')}`, {
    headers: { 'x-api-key': process.env.LUNARNAV_API_KEY ?? '', accept: 'application/json' },
    next: { revalidate: revalidateS }, // Next data cache: giảm số request vào ngân sách chung
  });
  if (!res.ok) throw new Error(`lunar API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
// const runs = await lunarServer<components['schemas']['RunsResponse']>('runs', 300);
```

---

## 3. Sinh type TypeScript từ OpenAPI

### 3.1 Tải spec + sinh type
```bash
mkdir -p contract
curl -fsS -u "<DOCS_USER>:<DOCS_PASSWORD>" https://api.lunavigator.com/api/v1/openapi.json -o contract/openapi.json
# (tương đương: https://api.lunavigator.com/docs/json, cùng Basic auth)

npm i openapi-fetch@0.17.0 @tanstack/react-query@5
npm i -D openapi-typescript@7.13.0
npx openapi-typescript@7.13.0 contract/openapi.json -o src/lib/lunar/schema.d.ts --default-non-nullable false
```
- `--default-non-nullable false`: field request có default ở server vẫn là optional trong type.
- openapi-typescript 7.13 cần TypeScript 5.x. Commit `contract/openapi.json` + `schema.d.ts`; mỗi khi backend báo đổi contract: tải lại, sinh lại, chạy `tsc`.
- Đừng commit mật khẩu docs (dùng biến shell). Spec có `security: [{ApiKeyAuth: []}]` toàn cục; `/health` có `security: []`.
- Path trong spec đã có tiền tố: `'/api/v1/dataset'`, `'/api/v1/sites/{site_id}'`…

### 3.2 Client có type (client component)
```ts
// src/lib/lunar/client.ts  ('use client' code dùng được; không chứa key)
import createClient from 'openapi-fetch';
import type { components, paths } from './schema';

export type Schemas = components['schemas'];
export type Problem = Schemas['Problem'];
/** Mã do proxy của FE sinh thêm (không có trong OpenAPI). */
export type ProxyCode = 'PROXY_MISCONFIGURED' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNREACHABLE' | 'NETWORK_ERROR';
export type LunarCode = Problem['code'] | ProxyCode;
export type DatasetQuery = NonNullable<paths['/api/v1/dataset']['get']['parameters']['query']>;

export const PROXY_BASE = '/api/lunar';

/** '/api/v1/jobs/j_x' (poll, Location, artifacts[].url, manifest_url) -> '/api/lunar/jobs/j_x'. */
export function toProxyUrl(apiUrl: string): string {
  return apiUrl.replace(/^(?:https?:\/\/[^/]+)?\/api\/v1\//, `${PROXY_BASE}/`);
}

export class LunarApiError extends Error {
  constructor(readonly status: number, readonly code: LunarCode | string, readonly problem: Record<string, unknown>) {
    super(String(problem.detail ?? problem.title ?? `HTTP ${status}`));
    this.name = 'LunarApiError';
  }
}

// openapi-fetch ghép baseUrl + '/api/v1/...' -> '/api/lunar/api/v1/...', proxy nhận dạng này.
export const lunar = createClient<paths>({
  baseUrl: typeof window === 'undefined' ? `http://localhost${PROXY_BASE}` : `${window.location.origin}${PROXY_BASE}`,
});

export async function unwrap<R extends { data?: unknown; error?: unknown; response: Response }>(p: Promise<R>): Promise<NonNullable<R['data']>> {
  let r: R;
  try {
    r = await p;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new LunarApiError(0, 'NETWORK_ERROR', { title: 'Network error', detail: String(e) });
  }
  if (r.response.ok && r.error === undefined) return r.data as NonNullable<R['data']>;
  const prob = (typeof r.error === 'object' && r.error !== null ? r.error : {}) as Record<string, unknown>;
  throw new LunarApiError(r.response.status, typeof prob.code === 'string' ? prob.code : `HTTP_${r.response.status}`, prob);
}
```
Hook React Query:
```ts
'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LunarApiError, lunar, unwrap, type DatasetQuery } from '@/lib/lunar/client';

export function useDataset(q: DatasetQuery) {
  return useQuery({
    queryKey: ['lunar', 'dataset', q],
    queryFn: ({ signal }) => unwrap(lunar.GET('/api/v1/dataset', { params: { query: q }, signal })),
    staleTime: q.run_id ? 60 * 60_000 : 60_000, // = Cache-Control của server (3600 s có run_id, 60 s không có)
    gcTime: 30 * 60_000,
    placeholderData: keepPreviousData,
    retry: (n, e) => n < 2 && (!(e instanceof LunarApiError) || e.status >= 500 || e.status === 0),
  });
}
```
- Chỉ gọi `lunar` trong `queryFn`/event handler (chạy ở trình duyệt). Lúc SSR của client component, `baseUrl` không có origin thật.
- Path param được openapi-fetch encode tự động: `lunar.GET('/api/v1/sites/{site_id}', { params: { path: { site_id: 'custom:-89.4500:222.6900' } } })`.

---

## 4. Quy ước chung

| Quy ước | Chi tiết |
|---|---|
| Tên field | **snake_case** ở mọi JSON và query param (`sun_el_deg`, `pct_sun`, `longest_dark_h`). FE tự đổi tên trong lớp API nếu muốn. |
| Query/body strict | Tham số lạ → `400 VALIDATION_ERROR` ("Unrecognized keys"). Ví dụ `kind=` thay vì `kinds=` bị từ chối. Không có alias (`from`, `to`, `resolution_s`). |
| Danh sách trong query | Phân cách bằng dấu phẩy: `fields=sun_el_deg,earth_el_deg`, `kinds=sun,earth`, `weights=pct_sun:0.4,pct_earth:0.3,pct_both:0.3`. |
| Thời gian | UTC ISO-8601 **có `Z`**: `2026-03-14T05:30:00Z`. Input nhận phần thập phân giây tối đa **9 chữ số** (`...05:30:00.123456789Z`). Không nhận offset `+07:00`, không bỏ `Z`. Ngày không có thật (30/02, giờ 25) → `400`. Output luôn là giây nguyên. |
| Khoảng | `[start, end)`: `end` **exclusive**. Lưới 1 giờ (`step_s = 3600`, `precision_h = 1`). |
| Snap | `start` snap **xuống** mẫu giờ; `end` snap **lên** mẫu giờ kế tiếp nếu có **bất kỳ** phần lẻ (`15:00:00.000000001Z` → `16:00:00Z`; `15:00:00Z` giữ nguyên). Giá trị đã snap được echo (`range.start/end`, `start/end`) → vẽ theo echo. |
| Clamp | Khoảng chồng một phần lên run → bị cắt về run. Không chồng chút nào hoặc `end ≤ start` → `422 OUT_OF_RANGE` "Range outside run" (có `run_start_utc`, `run_end_utc`). |
| Instant | `t` của `/instant`, `/pointing`: đọc mẫu `k = floor((t − run start)/1 h)` (mẫu ≤ `t`), trả `sample_utc`. |
| Độ chính xác | Mọi ranh giới cửa sổ / "còn X giờ" chính xác **± `precision_h` giờ** (= 1). Hiển thị kèm "±1 h". |
| `run_id` | Tuỳ chọn ở mọi GET dữ liệu; bỏ trống = run mặc định. Dạng `[A-Za-z0-9_.-]{1,64}` (`B2_...`, `job_j_...`). |
| `site_id` | Catalogue (`a3_haworth`) hoặc custom `custom:<lat 4 số>:<lon 4 số>` (`custom:-89.4500:222.6900`). Có `:` → `encodeURIComponent` trong path. |
| Vĩ độ `lat_deg` | độ, [-90, 90], planetocentric. |
| Kinh độ `lon_deg` | Output luôn **độ Đông [0, 360)**. Input của job/tools (`lon_deg`) nhận [-360, 360], giá trị âm = Tây và được đổi về [0, 360) (`-137.31` → `222.69`). Hiển thị −180…180: `lon > 180 ? lon − 360 : lon`. GeoJSON: `[lon_east, lat]`. |
| Azimuth `*_az_deg` | độ [0, 360), chiều kim đồng hồ từ Bắc địa phương (N=0, E=90, S=180, W=270). |
| Elevation `*_el_deg` | độ, tâm đĩa, không khí quyển. Chân trời địa hình có thể < 0. |
| `*_clearance_deg` | `el − horizon_el` tại azimuth của thiên thể. Âm = bị địa hình che. |
| Độ cao | `surface_height_m`: m trên mặt cầu 1737.4 km; `observer_height_m`: cột cao trên mặt đất (mặc định 2 m). |
| Phần trăm | `pct_*`, `*_pct`: **0..100** (không phải 0..1). `power_*`, `sun_fraction`: 0..1. |
| Giờ | `*_h`, `*_hours`, `duration_h`, `slip_h`: **giờ**. |
| Cận dưới | `*_truncated`, `lower_bound`, `*_clipped`, `value_clipped`: true → giá trị có thể dài hơn (hiện "≥ X h"). |
| Thiếu dữ liệu | `null` (không có NaN / chuỗi rỗng). CSV: ô rỗng; bool CSV là `1`/`0`. |
| Visibility | **Không bao giờ** tự tính "el > 0 ⇒ thấy". Dùng cờ `*_visible`, `windows`, `*_clearance_deg` của backend (chân trời là địa hình). |
| Field lạ | v1 chỉ thêm field; code FE phải chịu được field mới. |

---

## 5. Endpoint reference

Mọi path dưới đây tương đối với base `/api/v1` (qua proxy: `/api/lunar`). "Cache" = `Cache-Control` server trả.
Data GET có `ETag` yếu + `If-None-Match` → `304`. Không có `run_id` → `max-age=60`; có `run_id` → `max-age=3600`.

### 5.1 Đọc dữ liệu: ỔN ĐỊNH (dùng thật được)

| Method + path | Mục đích | Query chính (mặc định, giới hạn) | Response (top-level) |
|---|---|---|---|
| `GET /health` | liveness, `default_run_id` (không cần key) | – | `status, api_version, node_version, time_utc, uptime_s, mongo, python, default_run_id` |
| `GET /meta` | enum + giới hạn + field/đơn vị (cache 300 s) | – | `api_version, field_case, time_format, site_groups, window_kinds, series_fields[{name,unit,type,nullable,description}], rank_metrics, default_rank_weights, alt_date_objectives, limits` |
| `GET /capabilities` | server chạy được gì (providers, DEM, job types) (`no-store`) | `refresh=true\|false` | `checked_at, python, cli, modules, providers, dems, horizon_methods, network, job_types[], tools` |
| `GET /runs` | run picker | `kind=precompute\|custom`, `status=importing\|ready\|failed`, `limit` (50, 1..200), `offset` (0) | `default_run_id, total, limit, offset, runs[RunSummary]` (run mặc định đứng đầu) |
| `GET /runs/{run_id}` | provenance đầy đủ ("về dữ liệu") | – | RunSummary + `manifest` |
| `GET /runs/{run_id}/files/{file_path}` | tải file gốc; `file_path` URL-encode `/` thành `%2F`, phải có trong manifest | – | bytes gốc; `ETag` = sha256, cache bất biến |
| `GET /sites` | danh mục + marker bản đồ | `run_id`, `group=south_pole\|reference\|apollo\|far_side`, `format=json\|geojson` (json) | `run_id, step_s, precision_h, sites[SiteListItem]`; geojson → `application/geo+json` |
| `GET /sites/{site_id}` | thẻ site, metrics toàn run, rank/score | `run_id` | `run_id, step_s, precision_h, site, extra, map, range, metrics, rank, score, warnings[]` |
| `GET /sites/{site_id}/horizon` | silhouette chân trời (bước 0.5°, 720 điểm) | `run_id` | `site_id, method, dem_source, az_step_deg, az_deg[], el_deg[], covered_radius_km[], min_el_deg, max_el_deg` |
| `GET /sites/{site_id}/series` | đường cong timeline dạng cột + sự kiện chính xác | `start`, `end`, `fields` (`sun_el_deg,earth_el_deg,sun_visible,earth_visible`; tối đa 8), `max_points` (2000, 2..5000), `agg=sample\|minmax` | `site_id, start, end, bin_s, n, agg, fields{name: values[]}, events[{t,kind,state}]` |
| `GET /sites/{site_id}/instant` | readout tại thanh trượt | `t` (**bắt buộc**) | `site_id, t, sample_utc, sample_index, sun{az_deg,el_deg,horizon_el_deg,clearance_deg,fraction,visible,power_horizontal,power_tracking,irradiance_tracking_wm2,dist_km}, earth{…}, both_visible, hours_until, next_events` |
| `GET /sites/{site_id}/sky` | sky diagram: vệt Sun/Earth + horizon | `start`, `end`, `max_points` (2000, 16..5000) | `site_id, start, end, n_samples, horizon, sun{t[],az_deg[],el_deg[],visible[],decimated,n_transitions}, earth{…}` |
| `GET /sites/{site_id}/windows` | dải timeline | `start`, `end`, `kinds` (`sun,earth,both`) | `site_id, start, end, sun[], earth[], both[]` (chỉ key đã xin); mỗi cửa sổ `{start,end,duration_h,state,truncated_start,truncated_end,clipped_start,clipped_end}` |
| `GET /ranking` | bảng xếp hạng | `run_id`, `group`, `start`, `end`, `weights` (`pct_sun:0.4,pct_earth:0.3,pct_both:0.3`) | `run_id, step_s, precision_h, range, weights, source (summary\|computed), ranking[RankingRow]` |
| `GET /export/summary.csv` | tải bảng tổng hợp | `run_id` | `text/csv`, `content-disposition: attachment` |
| `GET /sites/{site_id}/export/series.csv` | tải series | `start`, `end`, `fields` (mặc định: mọi cột visibility) | `text/csv` (cột `time_utc` đầu tiên) |
| `GET /sites/{site_id}/export/windows.csv` | tải windows | `start`, `end`, `kinds` | `text/csv` |
| `GET /dataset` | trang so sánh trong MỘT lần gọi | xem 5.1.1 | xem 5.1.1 |

Mọi data GET có `run_id, step_s (3600), precision_h (1)` ở top-level (trừ `/dataset`, xem `range`). Lỗi chung: `400
VALIDATION_ERROR`, `404 SITE_NOT_FOUND / RUN_NOT_FOUND`, `409 RUN_NOT_READY`, `422 OUT_OF_RANGE`, `429`, `503`.

Chi tiết cần biết:
- `/series`: dạng cột, điểm `i` ở `start + i·bin_s`. Khi số mẫu > `max_points`, `bin_s = ceil(n/max_points)·3600`.
  `agg=minmax`: mỗi field số thành `{min:[…],max:[…]}`, bool thành tỉ lệ true 0..1. `events` = chuyển trạng thái chính xác
  trong khoảng, kể cả khi đã downsample → vẽ dải từ `events`/`windows`, không suy ra từ series đã downsample.
  > 8 field hoặc `max_points` > 5000 → `400 TOO_MANY_POINTS`.
- `/instant`: `hours_until.*` tính từ `sample_utc`; `next_events.{sunset,sunrise,earthset,earthrise}` =
  `{hours, at, state_now, lower_bound}` tính từ chính `t` → **hiển thị `next_events`**. `hours: 0` = đang ở trạng thái đó;
  `at: null` / `lower_bound: true` = không xảy ra trước cuối run ("> X h").
- `/sky`: `t[]` không đều (giữ cực trị và hai mẫu quanh mỗi chuyển trạng thái) → vẽ theo `t`, không theo index.
- `/windows`: `truncated_*` = chạm **biên run**; `clipped_*` = bị cắt bởi **khoảng truy vấn**; `duration_h` là độ dài sau khi cắt.
- `/sites/{id}`: `warnings[]` không rỗng (ví dụ `apollo11`: "smooth-sphere horizon …") → hiện badge cảnh báo; `dem_source`
  bắt đầu bằng `none:` = không có địa hình, kết quả lạc quan.
- `/ranking`: `source: "summary"` = toàn run + trọng số mặc định; `"computed"` = tính lại. `reasons[]` cho tooltip.
  `weights`: mỗi metric (`pct_sun|pct_earth|pct_both|pct_sun_no_earth`) tối đa 1 lần, 0..1, ít nhất một > 0.

Ví dụ (trích `backend/contract/examples/`, chụp trên run mẫu 6 site `pf_21c3f3f6dc56b1e1`; production có `run_id` khác,
cùng hình dạng):

`GET /api/lunar/sites?group=reference` (rút gọn còn 1 site)
```json
{
  "run_id": "pf_21c3f3f6dc56b1e1", "step_s": 3600, "precision_h": 1,
  "sites": [
    {
      "id": "ref_connecting_ridge_c1", "name": "Shackleton-de Gerlache connecting ridge, point C1",
      "group": "reference", "origin": "catalog", "lat_deg": -89.4505, "lon_deg": 222.84,
      "map": { "projection": "south_polar_stereographic_R1737.4km", "x_km": -11.33, "y_km": -12.218 },
      "dem_source": "pgda:bands[LDEM_80S_20MPP_ADJ<15km,LDEM_60S_120MPP_ADJ<60km,LDEM_60S_240MPP_ADJ<R]",
      "horizon_method": "raymarch", "rank": 1, "score": 71.162037,
      "pct_sun": 98.564815, "pct_earth": 53.611111, "pct_both": 52.175926, "longest_dark_h": 26, "longest_comms_gap_h": 326
    }
  ]
}
```

`GET /api/lunar/sites/ref_connecting_ridge_c1/instant?t=2026-03-14T05:30:00Z` (rút gọn: `earth` và 3 trong 4 `next_events` bị bỏ)
```json
{
  "run_id": "pf_21c3f3f6dc56b1e1",
  "step_s": 3600,
  "precision_h": 1,
  "site_id": "ref_connecting_ridge_c1",
  "t": "2026-03-14T05:30:00Z",
  "sample_utc": "2026-03-14T05:00:00Z",
  "sample_index": 1733,
  "sun": {
    "az_deg": 11.454255, "el_deg": 0.14242, "horizon_el_deg": -0.499418, "clearance_deg": 0.641838,
    "fraction": 1, "visible": true, "power_horizontal": 0.002486, "power_tracking": 1,
    "irradiance_tracking_wm2": 1380.858, "dist_km": 148518305.766
  },
  "both_visible": false,
  "hours_until": { "sunset": 355, "sunrise": 0, "earthset": 0, "earthrise": 61 },
  "next_events": { "sunset": { "hours": 354.5, "at": "2026-03-29T00:00:00Z", "state_now": true, "lower_bound": false } }
}
```

`GET /api/lunar/ranking?group=reference` (rút gọn còn 1 dòng)
```json
{
  "run_id": "pf_21c3f3f6dc56b1e1",
  "step_s": 3600,
  "precision_h": 1,
  "range": { "start": "2026-01-01T00:00:00Z", "end": "2026-04-01T00:00:00Z", "step_s": 3600, "n_samples": 2160 },
  "weights": { "pct_sun": 0.4, "pct_earth": 0.3, "pct_both": 0.3 },
  "source": "summary",
  "ranking": [
    {
      "rank": 1, "site_id": "ref_connecting_ridge_c1", "name": "Shackleton-de Gerlache connecting ridge, point C1",
      "group": "reference", "score": 71.162037, "pct_sun": 98.564815, "pct_earth": 53.611111, "pct_both": 52.175926,
      "pct_sun_no_earth": 46.388889, "longest_dark_h": 26, "longest_dark_truncated": false, "longest_comms_gap_h": 326,
      "longest_comms_gap_truncated": false, "mean_power_tracking": 0.971631,
      "reasons": ["Sun visible 98.6% of the time", "Earth in view 53.6%", "longest night only 26 h"]
    }
  ]
}
```

#### 5.1.1 `GET /dataset` (operationId `getDataset`): chi tiết

Mọi thứ trang so sánh cần, cho nhiều site, tính trên **khoảng được yêu cầu**: horizon, series Sun/Earth đã thưa hoá
(giữ mọi lần mọc/lặn), windows, metrics, criteria (+ tuỳ chọn pointing, survival_hint).

Query:

| Tham số | Mặc định | Giới hạn / ý nghĩa |
|---|---|---|
| `run_id` | run mặc định | |
| `site_ids` | mọi site của run (thứ tự sites.json) | phẩy, tối đa 100, bỏ trùng, giữ thứ tự gửi; id custom → encode (URLSearchParams) |
| `start` | đầu run | inclusive, snap xuống |
| `end` | cuối run | **exclusive**, snap lên; chồng một phần → clamp (`coverage = partial`); không chồng → `422` |
| `step_s` | 3600 | 3600 … 2 678 400. Server giữ mỗi mẫu thứ `k = floor(step_s/3600)` **cộng** 2 mẫu quanh mỗi lần Sun/Earth đổi trạng thái |
| `max_points` | 10000 | 16 … 10000: trần điểm series **mỗi site** (tính cả mẫu chuyển trạng thái); thiếu chỗ → server tự tăng `k` cho site đó |
| `horizon_step_deg` | 1 | `1` (361 điểm 0..360 khép kín) hoặc `0.5` (721 điểm, khớp tuyệt đối với cờ visibility → nên dùng cho site vành hố) |
| `criteria_hours` | `24,72,168` | ngưỡng giờ > 0, tối đa 30, bỏ trùng, sắp tăng; mỗi ngưỡng so với `longest_both_h` |
| `include` | `horizon,series,windows,metrics,criteria` | tập con của `horizon,series,windows,metrics,criteria,pointing,survival_hint`; phần không xin sẽ **vắng** trong `sites[]` |
| `night_load_w` | – | ≥ 0, ≤ 1e6, chỉ với `include=survival_hint` (ĐANG HOÀN THIỆN) |

Giới hạn payload (quan trọng):
- Tổng điểm series của **mọi site** ≤ **50 000**. Vượt → `422 OUT_OF_RANGE`, title **`Series point limit exceeded`**, kèm
  `limit_total_points`, `requested_total_points`, `n_sites`, `points_per_site`, `max_points_fit`, `errors[{path:"max_points"}]`, `hint`.
- Gọi **không tham số** trên run 23 site × 5 năm → luôn `422` (23 × 10 000 > 50 000), `hint` gợi ý `max_points <= 2173`.
  → FE **luôn** gửi khoảng thời gian hoặc `max_points ≤ floor(50000 / số_site)`.
- Một site có số mẫu chuyển trạng thái > `max_points` → cũng `422` cùng title (có `site_id`, `needed_points`).
- `step_s` lớn chưa chắc đủ (mẫu chuyển trạng thái luôn được giữ): 23 site × cả run × `step_s=86400` vẫn `422`; thêm `max_points=2173` → 200.
- Không có `series` trong `include` → không có giới hạn điểm (cả run, 23 site ≈ 0,7 MB, ~0,2 s).
- Thời gian đo trên máy dev: 23 site × 31 ngày × 1 h ≈ 17 112 điểm, 1,5 MB (gzip 0,4 MB), ~0,25 s; cả run với `max_points=2173`
  ≈ 4,6 MB, **~8 s**. → chỉ xin `series` cho khoảng ≤ 1 năm hoặc ít site; tổng quan cả run gọi không có `series`.
- Lỗi khoảng thật vẫn dùng title `Range outside run` (cùng `code: OUT_OF_RANGE`) → switch theo `code`, hiện `title`/`detail`/`hint`.
- `max_points > 10000` → `400 TOO_MANY_POINTS` (`hint` hiện vẫn ghi "max_points <= 5000" của `/series`; trần của `/dataset` là 10000).

Response (top-level, schema `DatasetResponse`):
```
schema_version 'lunarnav-dataset-1' · dataset_id '<run_id>.<hash lựa chọn>' · evidence 'computed-ephemeris' · attribution
run      {run_id,label,provider,dem,horizon_method,code_version,run_timestamp_utc,observer_height_m,
          min_earth_clearance_deg,git_commit,manifest_sha256,manifest_url}
model    {id 'lunarnav-terrain-horizon-v1', label, definition, limits[]}     <- hiển thị nguyên văn
range    {start, end (exclusive, đã snap + clamp), step_s (3600), n_samples, requested_start, requested_end}
conventions {time,azimuth,longitude,latitude,elevation,distance,height,duration,percent}
criteria_hours[] · include[] · sources[{id,title,url,sha256}] · night_load_w? · assumptions?
sites[]  {id,name,group,lat_deg,lon_deg (Đông 0-360),surface_height_m,coverage,coverage_in_range,
          horizon  {step_deg,az_deg[],el_deg[],min_el_deg,max_el_deg,source_step_deg,method,dem_source},
          series   {t[],sun_az_deg[],sun_el_deg[],sun_visible[],earth_az_deg[],earth_el_deg[],earth_visible[],
                    both_visible[],step_s,decimated,n_transitions},
          windows  {sun[],earth[],both[]: {start,end,duration_h,clipped_start,clipped_end}}   <- CHỈ khoảng nhìn thấy
          metrics  {...} | null,  criteria[] {minimum_hours,metric 'longest_both_h',value_h,value_clipped,result,reason},
          now? (include=pointing), survival_hint? (include=survival_hint)}
```
`metrics` (đơn vị):

| Field | Đơn vị | Ý nghĩa |
|---|---|---|
| `duration_h` | h | độ dài khoảng đã đánh giá |
| `pct_sun`, `pct_earth`, `pct_both` | % (0..100) | phần thời gian có Mặt Trời / thấy Trái Đất / cả hai |
| `sun_hours`, `earth_hours`, `both_hours` | h | tổng giờ tương ứng |
| `longest_sun_h`, `longest_earth_h`, `longest_both_h` | h | đoạn liên tục dài nhất |
| `longest_dark_h` | h | đêm (không Mặt Trời) dài nhất |
| `longest_comms_gap_h` | h | mất Trái Đất dài nhất |
| `mean_power_tracking_pct` | % (0..100) \| null | công suất TB tấm pin bám Mặt Trời, % so với nắng đầy đủ |
| `mean_power_horizontal_pct` | % (0..100) \| null | công suất TB tấm pin nằm ngang (rất nhỏ ở cực) |

Những điểm FE **phải** xử lý:
1. **`end` exclusive**: mẫu cuối = `range.end − range.step_s` (end `2026-01-14T00:00:00Z` → mẫu cuối `2026-01-13T23:00:00Z`). Dùng `range.step_s`, không dùng `series.step_s`.
2. **`series.t` không đều** khi `decimated = true`; `series.step_s` là **của từng site**. Vẽ theo timestamp.
3. **Visibility lấy từ cờ** `*_visible`/`windows`, không tính từ góc (`earth_el_deg = −0.026` vẫn có thể `earth_visible = true`).
4. **Coverage**: `coverage` so với khoảng **yêu cầu**, `coverage_in_range` so với khoảng **thực dùng**. Clamp → `partial` nhưng
   `coverage_in_range = complete` và số liệu vẫn đúng cho `[range.start, range.end)`. Site `missing` có `metrics = null`, `criteria = []`.
5. **Criteria**: `result ∈ meets | below | borderline`. `value_clipped = true` → hiện "có thể dài hơn" cạnh `below`.
6. `run.manifest_url` là `/api/v1/runs/<id>/files/manifest.json` → `toProxyUrl()` trước khi dùng. `sources[].sha256` hiện là `null`.

Ví dụ: hai site, một tuần, chỉ metrics + windows (request nhẹ, khuyến nghị cho bảng so sánh):
```
GET /api/lunar/dataset?site_ids=ref_shackleton_rim,a3_haworth&start=2026-03-01T00:00:00Z&end=2026-03-08T00:00:00Z&include=metrics,windows
```
Response mẫu thật (trích `docs/dataset_sample_response.json`: `site_ids=ref_connecting_ridge_c1,apollo11`, 2026-01-07 → 2026-01-14,
chụp trên run B **trước** khi sửa địa hình, nên `run_id` cũ và chưa có `mean_power_*_pct`; production trả `run_id`
`B2_...`, số có thể lệch nhẹ). Đã rút gọn: `conventions`, `sources`, `horizon`, phần lớn mảng `series`, site thứ hai.
```json
{
  "schema_version": "lunarnav-dataset-1",
  "dataset_id": "B_spice_pgda_bruteforce_2026_2030.e86b9c4e1008",
  "evidence": "computed-ephemeris",
  "run": {
    "run_id": "B_spice_pgda_bruteforce_2026_2030", "provider": "spice", "dem": "pgda", "horizon_method": "bruteforce",
    "observer_height_m": 2, "min_earth_clearance_deg": 0,
    "manifest_url": "/api/v1/runs/B_spice_pgda_bruteforce_2026_2030/files/manifest.json"
  },
  "model": {
    "id": "lunarnav-terrain-horizon-v1",
    "label": "Terrain horizon · Sun upper limb · Earth centre",
    "limits": ["Samples every 1 h: each rise or set time is accurate to +-1 h, and an event shorter than one step can be missed."]
  },
  "range": {
    "start": "2026-01-07T00:00:00Z", "end": "2026-01-14T00:00:00Z", "step_s": 3600, "n_samples": 168,
    "requested_start": "2026-01-07T00:00:00Z", "requested_end": "2026-01-14T00:00:00Z"
  },
  "criteria_hours": [24, 72, 168],
  "include": ["horizon", "series", "windows", "metrics", "criteria"],
  "sites": [
    {
      "id": "ref_connecting_ridge_c1", "name": "Shackleton-de Gerlache connecting ridge, point C1", "group": "reference",
      "lat_deg": -89.4505, "lon_deg": 222.84, "surface_height_m": 1957.291,
      "coverage": "complete", "coverage_in_range": "complete",
      "series": {
        "t": ["2026-01-07T00:00:00Z", "2026-01-07T01:00:00Z"],
        "sun_az_deg": [96.935917, 96.430357],
        "sun_el_deg": [1.176683, 1.180824],
        "sun_visible": [true, true],
        "earth_az_deg": [144.111816, 144.12001],
        "earth_el_deg": [0.038546, -0.026061],
        "earth_visible": [true, true],
        "both_visible": [true, true],
        "step_s": 3600, "decimated": false, "n_transitions": 1
      },
      "windows": {
        "sun": [{ "start": "2026-01-07T00:00:00Z", "end": "2026-01-14T00:00:00Z", "duration_h": 168, "clipped_start": true, "clipped_end": true }],
        "earth": [{ "start": "2026-01-07T00:00:00Z", "end": "2026-01-07T14:00:00Z", "duration_h": 14, "clipped_start": true, "clipped_end": false }],
        "both": [{ "start": "2026-01-07T00:00:00Z", "end": "2026-01-07T14:00:00Z", "duration_h": 14, "clipped_start": true, "clipped_end": false }]
      },
      "metrics": {
        "duration_h": 168, "pct_sun": 100, "pct_earth": 8.333333, "pct_both": 8.333333,
        "sun_hours": 168, "earth_hours": 14, "both_hours": 14,
        "longest_sun_h": 168, "longest_earth_h": 14, "longest_both_h": 14,
        "longest_dark_h": 0, "longest_comms_gap_h": 154
      },
      "criteria": [
        {
          "minimum_hours": 24, "metric": "longest_both_h", "value_h": 14, "value_clipped": true, "result": "below",
          "reason": "Longest simultaneous Sun + Earth interval is 14 h < 24 h; that interval is cut by the range or run boundary, so the full interval may be longer outside the range."
        }
      ]
    }
  ]
}
```
Lỗi `/dataset`: `400 VALIDATION_ERROR` (tham số lạ, ngày sai, `step_s < 3600`, `horizon_step_deg` khác 0.5/1, `include` sai,
`criteria_hours ≤ 0`), `400 TOO_MANY_POINTS` (`max_points > 10000`), `422 OUT_OF_RANGE` (hai title như trên),
`404 SITE_NOT_FOUND` / `RUN_NOT_FOUND`.

Ví dụ 422 khi gọi không tham số (các số minh hoạ theo công thức, không phải bản chụp):
```json
{
  "type": "https://lunarnav.example/errors/out-of-range",
  "title": "Series point limit exceeded",
  "status": 422,
  "code": "OUT_OF_RANGE",
  "detail": "payload too large: 23 sites need 230000 series points (...) > limit 50000 points",
  "instance": "/api/v1/dataset",
  "errors": [{ "path": "max_points", "in": "querystring", "message": "with 23 sites use max_points <= 2173" }],
  "limit_total_points": 50000, "requested_total_points": 230000, "n_sites": 23, "points_per_site": 10000, "max_points_fit": 2173,
  "hint": "lower max_points (<= 2173 for 23 sites), request fewer site_ids, shorten the range, or drop series from include"
}
```

### 5.2 Tính toán: DÙNG ĐƯỢC

#### `POST /compare`: so sánh 2–4 site
Body (`CompareRequest`): `site_ids` (**bắt buộc**, 2–4 id khác nhau), `run_id?`, `start?`, `end?`, `weights?`
(`{pct_sun,pct_earth,pct_both,pct_sun_no_earth}`, mặc định 0.4/0.3/0.3), `include?` = `{windows?: ("sun"|"earth"|"both")[],
series?: {fields (1..8), max_points (1500, 2..5000), agg}}`. Response: `run_id, step_s, precision_h, range, weights,
ranking[RankingRow], sites{<site_id>: {metrics, windows?, series?, warnings}}`. Lỗi: 400, 404, 413, 415, 422, 429.
```bash
curl -s -X POST http://localhost:3000/api/lunar/compare -H 'content-type: application/json' \
  -d '{"site_ids":["ref_shackleton_rim","a3_haworth"],"start":"2026-03-01T00:00:00Z","end":"2026-04-01T00:00:00Z","include":{"windows":["sun"]}}'
```

#### `POST /alt-dates`: ngày hạ cánh thay thế ("lịch trượt")
Body (`AltDatesRequest`):

| Field | Bắt buộc | Mặc định / giới hạn |
|---|---|---|
| `site_id` | có | |
| `earliest`, `latest` | có | ISO Z (inclusive); `latest ≥ earliest` |
| `mission_h` | có | > 0, bội của 1 h, `latest + mission_h ≤ run end` |
| `run_id` | | run mặc định (dùng được với `job_...`) |
| `max_results` | | 10 (1..50) |
| `constraints` | | `min_sun_pct` 0, `min_earth_pct` 0, `min_both_pct` 0, `require_sun_at_landing` **true**, `require_earth_at_landing` false, `min_continuous_sun_h` 0, `min_continuous_earth_h` 0, `max_dark_gap_h` null, `max_comms_gap_h` null, `min_sun_el_at_landing_deg` null, `objective` `balanced` (`balanced\|sun\|earth\|both\|energy\|earliest`), `min_separation_h` 12 |

Quy tắc thời gian: `earliest` làm tròn **lên** mẫu giờ kế tiếp, `latest` làm tròn **xuống**; ứng viên luôn nằm trong
`[earliest, latest]`; hai mốc đã làm tròn được echo trong `earliest_utc`/`latest_utc`; `slip_h` tính từ `earliest_utc`.
Ví dụ `05:00:00.500Z..06:00:00.750Z` → chỉ xét mẫu `06:00:00Z`; không có mẫu nào trong khoảng → `422 OUT_OF_RANGE`.

Response: `run_id, step_s, precision_h, cache_id, site_id, earliest_utc, latest_utc, mission_duration_h, constraints (đã điền
mặc định), n_evaluated, n_feasible, rejected_by{<ràng buộc>: số}, candidates[LandingCandidate]`. `candidates: []` vẫn là **200**
→ hiển thị `rejected_by`. Header `x-lunarnav-cache: hit|miss|shared`. Đồng bộ, thường ~0,5–2 s (server timeout 30 s → 504).
Lỗi: `400` (latest < earliest), `422 BAD_MISSION_LENGTH`, `422 OUT_OF_RANGE` (+ `min_earliest` hoặc `max_latest` → dùng làm
giới hạn date picker), `429 QUEUE_FULL` (đang có nhiều phép tính), `502 PYTHON_FAILED`, `504 PYTHON_TIMEOUT`.
```bash
curl -s -X POST http://localhost:3000/api/lunar/alt-dates -H 'content-type: application/json' -d '{
  "site_id":"ref_connecting_ridge_c1","earliest":"2026-01-05T00:00:00Z","latest":"2026-02-20T00:00:00Z",
  "mission_h":336,"max_results":3,
  "constraints":{"min_sun_pct":70,"require_sun_at_landing":true,"require_earth_at_landing":true,"objective":"balanced"}}'
```
```json
{
  "run_id": "pf_21c3f3f6dc56b1e1",
  "step_s": 3600,
  "precision_h": 1,
  "cache_id": "074448f752df8c1122bbb15744f89151b205fda17e9ea6eedccdedc3bc438d3b",
  "site_id": "ref_connecting_ridge_c1",
  "earliest_utc": "2026-01-05T00:00:00Z",
  "latest_utc": "2026-02-20T00:00:00Z",
  "mission_duration_h": 336,
  "constraints": {
    "min_sun_pct": 70, "min_earth_pct": 0, "min_both_pct": 0, "require_sun_at_landing": true,
    "require_earth_at_landing": true, "min_continuous_sun_h": 0, "min_continuous_earth_h": 0,
    "max_dark_gap_h": null, "max_comms_gap_h": null, "min_sun_el_at_landing_deg": null,
    "objective": "balanced", "min_separation_h": 12
  },
  "n_evaluated": 1105,
  "n_feasible": 456,
  "rejected_by": { "min_sun_pct": 0, "require_sun_at_landing": 0, "require_earth_at_landing": 649 },
  "candidates": [
    {
      "rank": 1, "landing_utc": "2026-02-17T11:00:00Z", "mission_end_utc": "2026-03-03T11:00:00Z", "slip_h": 1043,
      "score": 99.702381, "sun_pct": 100, "earth_pct": 99.404762, "both_pct": 99.404762,
      "longest_dark_h": 0, "longest_comms_gap_h": 2, "continuous_sun_h": 949, "continuous_sun_lower_bound": false,
      "continuous_earth_h": 334, "continuous_earth_lower_bound": false, "sun_at_landing": true, "earth_at_landing": true,
      "sun_el_at_landing_deg": 0.696018, "earth_el_at_landing_deg": -1.946834,
      "mean_power_horizontal": 0.002281, "mean_power_tracking": 1
    }
  ]
}
```
(Ví dụ chụp trên run mẫu; `rejected_by` đã rút gọn.)

#### `POST /jobs` + `/jobs/{job_id}*`: toạ độ tuỳ chọn (chỉ `type: "custom_site"`)
Xem mục 6.

### 5.3 ĐANG HOÀN THIỆN (chưa chốt giao diện, số liệu/field có thể đổi)

| Method + path | Mục đích | Ghi chú |
|---|---|---|
| `POST /mission/survival` | cân bằng năng lượng pin theo giờ, `verdict{vi,en}`, `required_battery_wh`… | body bắt buộc `site_id, landing_utc, mission_h (≤ 8760), battery_wh, night_load_w, panel_peak_w`; tuỳ chọn `panel_mode` (`tracking`), `day_load_w`, `initial_soc_pct` (100), `min_soc_pct` (0), `max_points` (1000) |
| `GET /sites/{site_id}/pointing?t=` | hướng tấm pin / ăng-ten (la bàn 16 hướng, `summary{vi,en}`) | có ETag; `t` bắt buộc |
| `GET /dataset?include=pointing,survival_hint&night_load_w=` | `sites[].now`, `sites[].survival_hint` | phần mở rộng tương thích ngược của `/dataset` |
| `POST /tools/ephemeris` | az/el/khoảng cách Sun/Earth tại ≤ 200 thời điểm (đồng bộ) | `provider` mặc định `horizons`; rate limit riêng mỗi tool |
| `POST /tools/horizon` | mặt nạ chân trời một điểm (bán kính ≤ 60 km) | đồng bộ, có thể lâu (proxy timeout 180 s) |
| `POST /jobs` với `type ≠ custom_site` | `precompute`, `analyse`, `alt_dates_python`, `check`, `validate`, `validate_terrain`, `compare_runs`, `horizon_mask` | proxy mẫu chặn sẵn (`ONLY_CUSTOM_SITE_JOBS`) |

Có thể dựng prototype, nhưng đừng chốt UI/type phụ thuộc vào các route này. Khi FE vẽ "có nắng / sống sót", vẫn lấy kết
luận từ backend, không tự tính.

---

## 6. Luồng job `custom_site`

### 6.1 Tạo job
Body (`CustomSiteJobRequest`, strict):

| Field | Bắt buộc | Mặc định / giới hạn |
|---|---|---|
| `type` | có | `"custom_site"` |
| `lat_deg` + `lon_deg` | XOR với `site_id` | lat [-90, 90]; lon [-360, 360], Đông dương, giá trị âm (Tây) được đổi về [0, 360) |
| `site_id` | XOR với lat/lon | id catalogue, để tính khoảng ngày ngoài run |
| `start`, `end` | có | ISO Z, `end` exclusive, tối đa **366 ngày**; start snap xuống, end snap lên giờ nguyên |
| `name` | | 1..80 ký tự |
| `step_min` | | `60` (chỉ 60) |
| `provider` | | **`horizons`** (JPL Horizons online); cũng có `spice`, `analytic` |
| `dem` | | **`pgda`**; cũng có `trek`, `none` |
| `horizon_method` | | `raymarch` (`bruteforce`, `flat`) |
| `observer_height_m` | | 2 (0..100) |

```bash
curl -s -i -X POST http://localhost:3000/api/lunar/jobs -H 'content-type: application/json' \
  -d '{"type":"custom_site","lat_deg":-89.45,"lon_deg":-137.31,"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z","name":"My ridge"}'
```
- **`202`** = mới xếp hàng, hoặc đã có job giống hệt đang chạy (`cached: true`, cùng `job_id`). Header `Location` (qua proxy: `/api/lunar/jobs/<id>`).
- **`200`** = job giống hệt đã `succeeded` (`cached: true`, `status: "succeeded"`) → nhảy thẳng sang kết quả (gọi `GET /jobs/{id}` để lấy `result`).
- Cả hai đều có body `JobAccepted`:
```json
{
  "job_id": "j_289fibj8v5zz",
  "type": "custom_site",
  "status": "queued",
  "site_id": "custom:-89.4500:222.6900",
  "poll": "/api/v1/jobs/j_289fibj8v5zz",
  "cached": false
}
```
- `site_id` trả ngay (canonical, 4 chữ số thập phân) → dùng làm key UI. Type: `site_id` là `string | null` (null với job
  type không gắn một site); với `custom_site` luôn có giá trị. `type` là enum nhiều loại (`JobType`), FE chỉ tạo `custom_site`.
- `poll` là `/api/v1/...` → `toProxyUrl(poll)`.

### 6.2 Theo dõi: polling (contract) hoặc SSE (tuỳ chọn)
`GET /jobs/{job_id}` (`no-store`, không tính vào rate limit) → `Job`:
`job_id, type, status (queued|running|succeeded|failed|cancelled), site_id|null, params, progress{stage, pct|null, lines[]},
result{run_id, site_id}|null, output|null, artifacts[], error{code,message}|null, clients, created_at, started_at, finished_at, expires_at`.
- `progress.stage` ∈ `queued | precompute | python | import | artifacts | done`. Đừng hard-code thứ tự; hiện `stage` + `pct`
  (có thể `null` → thanh tiến độ không xác định) + dòng cuối của `lines`.
- Thời gian: vài chục giây cho 1 site × 1 tháng khi tile địa hình đã có cache; lần đầu ở vùng cực mới (tải tile PGDA) hoặc
  khi JPL Horizons chậm có thể **vài phút** → UI "đang tính" chịu được lâu.
- Polling: mỗi **≥ 2 s**, dừng khi `succeeded | failed | cancelled`.
```ts
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const job = useQuery({
  queryKey: ['lunar', 'job', jobId],
  queryFn: ({ signal }) => unwrap(lunar.GET('/api/v1/jobs/{job_id}', { params: { path: { job_id: jobId } }, signal })),
  refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.status) ? false : 2000),
  enabled: !!jobId,
});
```
- SSE: `GET /jobs/{job_id}/events` → `event: job` + `data: <Job JSON>` mỗi khi đổi; `: ping` mỗi 15 s; server đóng stream sau
  trạng thái cuối. Tối đa 50 stream mở cho FE (vượt → `429 TOO_MANY_STREAMS`).
```ts
useEffect(() => {
  if (!jobId) return;
  const es = new EventSource(`/api/lunar/jobs/${encodeURIComponent(jobId)}/events`);
  // Tên event là 'job' -> phải addEventListener('job'), es.onmessage KHÔNG nhận được.
  es.addEventListener('job', (ev) => {
    const j = JSON.parse((ev as MessageEvent<string>).data) as Schemas['Job'];
    setJob(j);
    if (TERMINAL.has(j.status)) es.close(); // nếu không close, EventSource sẽ tự nối lại
  });
  es.onerror = () => {
    es.close();
    setUsePolling(true); // 429 / mất mạng / function bị cắt: chuyển sang polling 2 s
  };
  return () => es.close(); // unmount: luôn đóng (giải phóng 1 trong 50 stream)
}, [jobId]);
```

### 6.3 Dùng kết quả
`succeeded` → `result = {run_id: "job_<job_id>", site_id}` → gọi **các endpoint bình thường** với `run_id = result.run_id`:
```
GET /api/lunar/sites/custom%3A-89.4500%3A222.6900?run_id=job_j_289fibj8v5zz
GET /api/lunar/dataset?run_id=job_j_289fibj8v5zz&site_ids=custom%3A-89.4500%3A222.6900&include=horizon,series,windows,metrics,criteria
```
(`run_id` thật lấy từ `result.run_id`, đừng tự ghép.) Run custom chỉ chứa khoảng ngày của job và hết hạn sau 30 ngày
(`expires_at`) → sau đó `404 RUN_NOT_FOUND` → thông báo "kết quả đã hết hạn, chạy lại".

### 6.4 Lỗi, huỷ, artifacts
- Job lỗi **không** trả HTTP lỗi: `GET /jobs/{id}` vẫn `200` với `status: "failed"`, `error: {code, message}`
  (ví dụ `SERVER_RESTARTED`, `IMPORT_FAILED`) → hiện `message` + nút "chạy lại" (POST lại cùng body).
- Huỷ: `DELETE /jobs/{job_id}` → `200 Job`. Nếu còn client khác chờ, job tiếp tục (`status` vẫn `queued|running`,
  `clients > 0`) → UI coi như đã huỷ và ngừng theo dõi. Đã xong → `409 JOB_NOT_CANCELLABLE` (`job_status`).
  **Chỉ gọi DELETE khi người dùng bấm "Huỷ"**; khi unmount/rời trang chỉ ngừng poll (xem mục 11 về danh tính client).
- Artifacts: `GET /jobs/{id}/artifacts` → `{job_id, type, status, artifacts[{name, media_type, bytes, sha256, url}]}`;
  với `custom_site` là `[]`. Tải: `toProxyUrl(artifact.url)`.
- Job failed/cancelled giữ 24 h; quá hạn → `404 JOB_NOT_FOUND`.

---

## 7. Bảng lỗi (`application/problem+json`, RFC 9457)

Body: `{type, title, status, code, detail?, instance?, errors?[{path, in, message, code}], hint?, ...extra}`.
Luôn `switch (err.code)`; hiển thị `title` + `detail` (tiếng Anh) + `hint` nếu có; gắn `errors[].path` vào ô form
(`start`, `constraints.min_sun_pct`, `fields.1`…). Extra có thể có: `retry_after_s`, `max_latest`, `min_earliest`,
`run_start_utc`, `run_end_utc`, `max_points_fit`, `job_status`, `max_mission_h`.

| HTTP | `code` | Khi nào | UI nên làm |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | sai schema, tham số lạ, ngày không có thật, `latest < earliest`, weights sai | lỗi form: hiện `errors[]` cạnh ô nhập; nếu do code → log |
| 400 | `TOO_MANY_POINTS` | > 8 fields / `max_points` quá trần (`/series`, `/sky`, CSV, `compare.include.series`, `/dataset` > 10000) | giảm field / `max_points` (đọc `GET /meta` limits) |
| 401 | `UNAUTHORIZED` | thiếu/sai API key (lỗi cấu hình proxy) | thông báo chung "lỗi cấu hình", log server; **không** retry |
| 403 | `JOB_NOT_YOURS` | `DELETE` job từ client không tạo nó | bỏ job id, ngừng theo dõi |
| 404 | `SITE_NOT_FOUND` | site không có trong run | "không có dữ liệu cho site này" + chọn lại site |
| 404 | `RUN_NOT_FOUND` | run không tồn tại / run custom đã hết hạn | "dữ liệu đã hết hạn" + nút quay về run mặc định / chạy lại job |
| 404 | `JOB_NOT_FOUND`, `FILE_NOT_FOUND` | id không tồn tại / hết hạn | như trên |
| 404 | `NOT_FOUND` | route không tồn tại (kể cả sai method), hoặc proxy chặn path | lỗi lập trình |
| 409 | `RUN_NOT_READY` | run đang import / lỗi | thử lại sau vài giây |
| 409 | `JOB_NOT_CANCELLABLE` | huỷ job đã xong | refetch job |
| 413 | `PAYLOAD_TOO_LARGE` | body > 1 MiB | lỗi lập trình |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | POST không có `Content-Type: application/json` | luôn gửi header này |
| 422 | `OUT_OF_RANGE` title `Range outside run` | khoảng ngoài run, `end ≤ start`, landing ngoài run | chỉnh date picker theo `run_start_utc/run_end_utc`, `min_earliest`, `max_latest` |
| 422 | `OUT_OF_RANGE` title `Series point limit exceeded` | `/dataset` vượt 50 000 điểm / mẫu chuyển trạng thái > `max_points` | thu hẹp khoảng, bớt site, dùng `max_points_fit`, hoặc bỏ `series` |
| 422 | `BAD_MISSION_LENGTH` | `mission_h` không phải bội 1 h | làm tròn input về giờ nguyên |
| 422 | `CAPABILITY_UNAVAILABLE`, `JOB_TOO_LARGE` | tuỳ chọn job/tool server không chạy được / job quá lớn | hiện `detail`, đổi tuỳ chọn |
| 429 | `RATE_LIMITED` | vượt rate limit của key (hoặc throttle của proxy) | disable nút, đếm ngược theo header `retry-after` / `retry_after_s`, rồi thử lại |
| 429 | `QUEUE_FULL` | hàng đợi job (hoặc alt-dates) đầy | "server bận", thử lại sau `retry-after` |
| 429 | `TOO_MANY_JOBS` | FE đã có 6 job queued/running | "đang có quá nhiều phép tính, chờ một job xong" |
| 429 | `TOO_MANY_STREAMS` | FE đã mở 50 SSE | đóng EventSource cũ, chuyển sang polling |
| 429 | `QUOTA_EXCEEDED` | hết hạn mức lưu run custom / tải dữ liệu địa hình trong ngày | "hết hạn mức hôm nay", thử lại sau |
| 500 | `INTERNAL` | lỗi server | thông báo chung + retry (tối đa 2 lần) |
| 501 | `JOB_TYPE_UNAVAILABLE` | job type server không chạy được | ẩn tính năng |
| 502 | `PYTHON_FAILED` | Python lỗi (alt-dates, tools) | thông báo + cho thử lại |
| 503 | `SERVICE_UNAVAILABLE` | DB chưa sẵn sàng / server đang tắt | banner "dịch vụ tạm gián đoạn", retry có backoff |
| 503 | `STORAGE_FULL` | hết ngân sách lưu trữ run job (có `retry-after`) | "server hết chỗ lưu kết quả, thử lại sau" |
| 504 | `PYTHON_TIMEOUT` | alt-dates/tools quá thời gian | thu hẹp khoảng `earliest..latest` |
| 500 | `PROXY_MISCONFIGURED` (proxy FE) | thiếu `LUNARNAV_API_KEY` trên server Next | lỗi deploy |
| 502 | `UPSTREAM_UNREACHABLE` (proxy FE) | không kết nối được API | banner + retry |
| 504 | `UPSTREAM_TIMEOUT` (proxy FE) | API không trả lời trong 180 s | thu hẹp request |
| 0 | `NETWORK_ERROR` (client FE) | trình duyệt mất mạng | retry |

Enum `Problem['code']` đầy đủ trong OpenAPI còn có `METHOD_NOT_ALLOWED` (405, dự phòng). Thêm code mới chỉ là thay đổi
"additive" → code FE phải có nhánh `default`.

---

## 8. Cache, ETag, rate limit

Ngân sách chung của key FE (cấu hình server; giá trị sống: `GET /meta` → `limits.rate_limit_per_min`,
`limits.rate_limit_post_per_min`):

| Giới hạn | Giá trị cho FE |
|---|---|
| Request/phút (mọi route trừ `/health`, `GET /jobs/{id}`, `/jobs/{id}/events`) | ≈ 3000 |
| `POST /jobs`, `POST /alt-dates` | ≈ 120/phút |
| `POST /tools/*` | giới hạn riêng mỗi tool (ĐANG HOÀN THIỆN) |
| Job queued/running cùng lúc | 6 |
| SSE mở cùng lúc | 50 |

Header trả về: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`; khi `429` có `retry-after` (giây) và `retry_after_s` trong body.

Việc FE phải làm:
1. **Cache GET theo query**: React Query `staleTime` = 60 s (không `run_id`) / 1 h (có `run_id`); cùng query key → không gọi lại.
   Dữ liệu precompute **bất biến theo `run_id`**: lấy `default_run_id` một lần (`GET /runs` hoặc `/health`) rồi gửi
   `run_id` ở các request sau → cache 1 h và nhất quán nếu backend đổi run mặc định. (Lấy id từ API, không hard-code.)
2. **ETag**: proxy chuyển `etag`/`cache-control` xuống và `if-none-match` lên → HTTP cache của trình duyệt tự gửi
   `If-None-Match` và nhận `304` (không cần code). Ở server (RSC) dùng `next: { revalidate }` hoặc tự lưu ETag.
3. **Debounce** mọi request do người dùng kéo/gõ (slider thời gian, date picker, ô toạ độ): 250–400 ms, hoặc chỉ gọi khi thả
   chuột. Với slider, ưu tiên nội suy từ `series` đã tải; chỉ gọi `/instant` khi dừng.
4. **Polling ≥ 2 s**, ưu tiên SSE; dừng hẳn khi trạng thái cuối; không poll job của tab ẩn (`refetchIntervalInBackground: false`).
5. **Throttle theo người dùng** ở proxy (mục 2.3) và disable nút POST khi đang chờ.
6. Gộp request: một `GET /dataset` thay vì N × (`/sites/{id}` + `/windows` + `/series`).
7. `429` → tôn trọng `retry-after`, không retry dồn dập; `retry` của React Query chỉ cho 5xx/mạng.

---

## 9. Thay đổi gần đây FE phải xử lý

1. **Base URL mới** `https://api.lunavigator.com/api/v1`; bỏ `http://192.168.1.63:8000`. Swagger `/docs` cần Basic auth.
2. **API key bắt buộc** (trừ `/health`) → chuyển mọi call trình duyệt sang proxy `/api/lunar`. Các tài liệu cũ ghi "không có
   xác thực", "rate limit 300/phút/IP, 5 POST/phút/IP" và cấu hình `rewrites`/`NEXT_PUBLIC_API_ORIGIN` **đã lỗi thời**.
3. **Run mặc định mới** `B2_spice_pgda_bruteforce_2026_2030_fix676af9d` (SPICE + PGDA LOLA, 2026-01-01..2031-01-01, 23 site).
   Số liệu lệch nhẹ so với server LAN cũ do sửa địa hình, ví dụ `ref_shackleton_rim` pct_sun 87.64 → **88.05 %**,
   `im1_odysseus` 37.23 → **39.45 %**. Test snapshot của FE phải cập nhật; không hard-code `run_id`.
4. **Job custom mặc định** `provider: "horizons"` (JPL Horizons online), `dem: "pgda"`. (File ví dụ cũ ghi `spice`.)
5. **Quy tắc thời gian** (đã sửa): nhận tối đa 9 chữ số thập phân giây; `end` snap lên nếu có **bất kỳ** phần lẻ
   (`15:00:00.000000001Z` → `16:00:00Z`); alt-dates làm tròn `earliest` lên, `latest` xuống, ứng viên luôn trong
   `[earliest, latest]`; giá trị đã snap được echo. `precision_h = 1`.
6. **`/dataset` không tham số** trên run 23 site × 5 năm → `422 OUT_OF_RANGE` title `Series point limit exceeded`
   (giới hạn 50 000 điểm, `hint` gợi ý `max_points <= 2173`). Lỗi khoảng thật giữ title `Range outside run`.
7. **Job**: `Job.site_id` và `JobAccepted.site_id` có thể `null`; `type` là enum nhiều loại; `progress.stage` có thêm
   `python` và `artifacts`; chỉ `custom_site` là ổn định cho FE. `200` (cache) / `202` (xếp hàng) đều có `job_id` + `poll`.
8. **Rate limit theo key** (dùng chung cho mọi người dùng FE) thay vì theo IP người dùng.
9. `/dataset` `metrics` có thêm `mean_power_tracking_pct`, `mean_power_horizontal_pct` (bắt buộc trong contract).

---

## 10. Kế hoạch test cho agent FE

```bash
export BASE=https://api.lunavigator.com/api/v1
export LUNARNAV_API_KEY='<LUNARNAV_API_KEY>'   # chỉ trong shell, không commit
H="X-API-Key: $LUNARNAV_API_KEY"
```

| # | Lệnh | Mong đợi |
|---|---|---|
| 1 | `curl -s $BASE/health` | `200`, `status: "ok"`, `default_run_id` = `B2_spice_pgda_bruteforce_2026_2030_fix676af9d` |
| 2 | `curl -s -o /dev/null -w '%{http_code}\n' $BASE/runs` | `401` (không key) |
| 3 | `curl -s -i -H 'X-API-Key: wrong' $BASE/runs \| head -20` | `401`, `www-authenticate: ApiKey header="X-API-Key"`, `code: UNAUTHORIZED` |
| 4 | `curl -s -H "$H" $BASE/runs` | `200`, `runs[0].is_default: true`, `n_sites: 23`, `end_utc: 2031-01-01T00:00:00Z` |
| 5 | `curl -s -H "$H" $BASE/sites \| jq '.sites \| length'` | `23` |
| 6 | `curl -s --compressed -H "$H" "$BASE/dataset?site_ids=ref_shackleton_rim,a3_haworth&start=2026-03-01T00:00:00Z&end=2026-03-08T00:00:00Z&include=metrics,windows"` | `200`, 2 site, `range.n_samples: 168`, không có `series`/`horizon` |
| 7 | `curl -s -H "$H" $BASE/dataset \| jq '{status,code,title,hint}'` | `422`, `OUT_OF_RANGE`, `Series point limit exceeded`, hint `<= 2173` |
| 8 | `curl -s -H "$H" "$BASE/dataset?site_ids=a3_haworth&include=metrics&start=2035-01-01T00:00:00Z&end=2035-02-01T00:00:00Z" \| jq .title` | `"Range outside run"` |
| 9 | `curl -s -H "$H" "$BASE/sites/ref_shackleton_rim/instant?t=2026-03-14T05:30:00Z"` | `200`, `sample_utc: 2026-03-14T05:00:00Z`, có `next_events` |
| 10 | `curl -s -H "$H" "$BASE/sites/a3_haworth/windows?start=2026-01-01T00:00:00Z&end=2026-01-01T15:00:00.000000001Z&kinds=sun" \| jq .end` | `"2026-01-01T16:00:00Z"` |
| 11 | `curl -s -i -X POST -H "$H" -H 'content-type: application/json' $BASE/alt-dates -d '{"site_id":"ref_connecting_ridge_c1","earliest":"2026-01-05T00:00:00.500Z","latest":"2026-02-20T00:00:00Z","mission_h":336,"max_results":3}'` | `200`, header `x-lunarnav-cache`, `earliest_utc: 2026-01-05T01:00:00Z`, mọi `landing_utc` trong khoảng |
| 12 | `curl -s -X POST -H "$H" -H 'content-type: application/json' $BASE/alt-dates -d '{"site_id":"ref_connecting_ridge_c1","earliest":"2026-01-05T00:00:00Z","latest":"2026-02-20T00:00:00Z","mission_h":1.5}'` | `422 BAD_MISSION_LENGTH` |
| 13 | `curl -s -i -X POST -H "$H" -H 'content-type: application/json' $BASE/jobs -d '{"type":"custom_site","lat_deg":-89.45,"lon_deg":-137.31,"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z"}'` | `202` (hoặc `200` nếu đã có), `site_id: custom:-89.4500:222.6900`, `location: /api/v1/jobs/j_...` |
| 14 | `curl -s -H "$H" $BASE/jobs/<job_id> \| jq '{status,progress,result}'` (lặp mỗi 2 s) | tới `succeeded`, `result.run_id` = `job_<job_id>` |
| 15 | `curl -s -N -H "$H" $BASE/jobs/<job_id>/events` | các khối `event: job` / `data: {...}`, `: ping`, đóng sau trạng thái cuối |
| 16 | `curl -s -H "$H" "$BASE/sites/custom%3A-89.4500%3A222.6900?run_id=<result.run_id>"` | `200`, `site.origin: custom` |
| 17 | `curl -s -X POST -H "$H" -H 'content-type: text/plain' $BASE/compare -d '{}'` | `415 UNSUPPORTED_MEDIA_TYPE` |
| 18 | `ET=$(curl -s -D - -o /dev/null -H "$H" $BASE/sites \| grep -i '^etag' \| cut -d' ' -f2- \| tr -d '\r'); curl -s -o /dev/null -w '%{http_code}\n' -H "$H" -H "If-None-Match: $ET" $BASE/sites` | `304` |

Qua proxy (dev: `npm run dev`, `.env.local` có hai biến ở mục 2.2):

| # | Lệnh | Mong đợi |
|---|---|---|
| P1 | `curl -s http://localhost:3000/api/lunar/health` | `200` |
| P2 | `curl -s "http://localhost:3000/api/lunar/dataset?site_ids=ref_shackleton_rim,a3_haworth&start=2026-03-01T00:00:00Z&end=2026-03-08T00:00:00Z&include=metrics,windows"` | `200` như #6 (không cần key ở client) |
| P3 | `curl -s "http://localhost:3000/api/lunar/api/v1/meta"` | `200` (dạng openapi-fetch) |
| P4 | `curl -s -i -X POST http://localhost:3000/api/lunar/jobs -H 'content-type: application/json' -d '{...như #13...}'` | `location: /api/lunar/jobs/j_...` |
| P5 | `curl -s -N http://localhost:3000/api/lunar/jobs/<job_id>/events` | stream đến **ngay** (không bị buffer) |
| P6 | `curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3000/api/lunar/%2e%2e/docs"` | `404` |
| P7 | `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/lunar/jobs -H 'content-type: application/json' -d '{"type":"precompute"}'` | `400` (proxy chặn) |
| P8 | `curl -s http://localhost:3000/api/lunar/runs/<run_id>/files/manifest.json \| head -c 200` | JSON manifest (`%2F` trong `file_path` giữ nguyên) |
| P9 | `npm run build && grep -rl "<8 ký tự đầu của key>" .next/static \|\| echo OK` | `OK` (key không có trong bundle client) |

Test UI tối thiểu: (a) bảng so sánh 23 site không có `series` + zoom 1 tuần có `series`; (b) mất mạng/429 hiện thông báo
đúng `code`; (c) job custom 202 → tiến độ → kết quả, và trường hợp 200 cache hit; (d) huỷ job; (e) site id có `:` trong URL.

---

## 11. Known gaps / lưu ý

1. **Route đang hoàn thiện** (mục 5.3): `/mission/survival`, `/sites/{id}/pointing`, `/tools/*`, `/dataset` `include=pointing,survival_hint`,
   job type khác `custom_site`. Field/câu chữ có thể đổi.
2. **Danh tính client của job/SSE** (đã sửa 14-11 21:45): giới hạn job đang chạy, số stream SSE, quyền `DELETE` job và hạn
   mức run custom tính **theo API key** (mọi người dùng FE dùng chung key FE = **một** client). Vercel đổi IP ra không còn
   gây `403 JOB_NOT_YOURS`. Vì mọi người dùng FE là một client, một người bấm Huỷ có thể huỷ job mà người dùng khác (gửi cùng
   tham số) đang chờ: chỉ DELETE khi người dùng bấm Huỷ rõ ràng.
3. **Hạn mức run custom**: mỗi client (key) giữ tối đa 100 run custom còn hạn (hết hạn 30 ngày); vượt →
   `429 QUOTA_EXCEEDED`. Job trùng tham số dùng lại kết quả (`200`, không tốn hạn mức) → khuyến khích làm tròn toạ độ người dùng nhập (4 chữ số thập phân).
4. **File ví dụ** trong contract chụp trên run mẫu 6 site (`pf_21c3f3f6dc56b1e1`, 2026-Q1) hoặc run B cũ: `run_id` và số liệu khác
   production; `examples/job_accepted.json` thiếu `type` (bản chụp cũ, contract bắt buộc có); `examples/job.json` ghi `provider: spice` (mặc định cũ).
5. `/dataset`: `hint` của `TOO_MANY_POINTS` vẫn ghi giới hạn của `/series` (5000); `sources[].sha256` là `null`; không có
   `version`/`retrievedAtUtc` cho từng nguồn (dùng `run.manifest_url` làm bằng chứng).
6. **Run A** (Horizons + Moon Trek) chưa có; khi có sẽ xuất hiện trong `GET /runs` với `is_default: false`.
7. SSE là tuỳ chọn; polling `GET /jobs/{id}` mới là contract. Cloudflare/Vercel có thể cắt stream dài: luôn có đường lùi polling.
8. Không có tài khoản người dùng ở backend: throttle/quyền theo người dùng là việc của FE.
9. Swagger "Try it out" với key FE tiêu vào **cùng** ngân sách rate limit của production → chỉ dùng để thử, không load-test.
10. Thời gian xử lý job custom phụ thuộc JPL Horizons (online) và việc tải tile PGDA lần đầu; chưa có SLA.
