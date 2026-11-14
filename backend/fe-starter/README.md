# fe-starter: code mẫu cho app Next.js

Không phải một app Next.js hoàn chỉnh: chỉ là các file để **copy** vào app của dev FE. Hướng dẫn đầy đủ:
`docs/FE_INTEGRATION.md` (mục 8).

| File | Việc |
|---|---|
| `src/lib/api/schema.d.ts` | types sinh bởi `openapi-typescript` từ `../contract/openapi.json` (sinh lại, đừng sửa tay) |
| `src/lib/api/client.ts` | client `openapi-fetch` + `unwrap()` / `ApiProblem` + helper (`csv`, `weightsParam`, `downloadUrl`) |
| `src/lib/api/queries.ts` | hook TanStack Query (sites, windows, job: tạo / polling / huỷ) |
| `src/lib/url-state.ts` | trạng thái UI trong URL (link chia sẻ) |
| `src/examples/*` | cách dùng (Client Component, Server Component) |
| `src/app/api/lunar/[...path]/route.ts` | proxy phía server: trình duyệt gọi `/api/lunar/api/v1/...`, server thêm `X-API-Key` từ `LUNARNAV_API_KEY` (bắt buộc khi backend bật API key, xem `docs/FE_INTEGRATION.md` mục 15) |
| `next.config.ts` | rewrites `/api/v1/*` → backend (chỉ cho backend **không** bật API key: dev local, Prism mock) |
| `env.local.example` | biến môi trường cho `.env.local` (`API_INTERNAL_URL`, `LUNARNAV_API_KEY`, `NEXT_PUBLIC_API_ORIGIN`) |
| `verify.sh` (+ `verify.runtime.ts`, `verify.tsconfig.json`) | kiểm tra starter với spec hiện tại |

Kiểm tra (cần mạng: cài openapi-typescript 7.13.0, openapi-fetch 0.17.0, @tanstack/react-query, next, react,
typescript 5.9.3 vào một thư mục tạm, không đụng repo):

```bash
bash backend/fe-starter/verify.sh                    # sinh types từ contract/openapi.json + tsc --strict + test runtime
bash backend/fe-starter/verify.sh --update-schema    # và chép schema.d.ts mới vào đây
bash backend/fe-starter/verify.sh --spec /path/openapi.json
```
