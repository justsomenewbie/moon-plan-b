# Trạng thái các route backend cho FE (14/11/2026)

Base URL: `http://192.168.1.63:8000/api/v1`. Swagger: http://192.168.1.63:8000/docs. Run mặc định: **B**.

## Hàng 1: đọc dữ liệu (đã chốt, dùng thật được)

| Method | Route |
|---|---|
| GET | `/dataset` |
| GET | `/sites` |
| GET | `/sites/{site_id}` |
| GET | `/sites/{site_id}/instant` |
| GET | `/sites/{site_id}/windows` |
| GET | `/sites/{site_id}/series` |
| GET | `/sites/{site_id}/sky` |
| GET | `/sites/{site_id}/horizon` |
| GET | `/ranking` |
| GET | `/runs` |
| GET | `/runs/{run_id}` |
| GET | `/runs/{run_id}/files/{file_path}` |
| GET | `/export/summary.csv` |
| GET | `/sites/{site_id}/export/series.csv` |
| GET | `/sites/{site_id}/export/windows.csv` |
| GET | `/meta` |
| GET | `/capabilities` |
| GET | `/health` |

## Hàng 2: tìm ngày, so sánh, toạ độ tuỳ chọn (dùng được)

| Method | Route | Ghi chú |
|---|---|---|
| POST | `/alt-dates` | |
| POST | `/compare` | |
| POST | `/jobs` | chỉ dùng `type = custom_site` |
| GET | `/jobs/{job_id}` | |
| DELETE | `/jobs/{job_id}` | |
| GET | `/jobs/{job_id}/events` | |
| GET | `/jobs/{job_id}/artifacts` | |
| GET | `/jobs/{job_id}/artifacts/{name}` | |

## Chưa nên chốt giao diện (đang hoàn thiện, số liệu có thể đổi)

| Method | Route |
|---|---|
| POST | `/mission/survival` |
| GET | `/sites/{site_id}/pointing` |
| POST | `/tools/ephemeris` |
| POST | `/tools/horizon` |
| POST | `/jobs` với `type` khác `custom_site` (precompute, kiểm chứng, ...) |
