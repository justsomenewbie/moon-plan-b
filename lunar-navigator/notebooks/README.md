# Notebook Google Colab: `lunar_navigator_colab.ipynb`

Notebook chạy toàn bộ pipeline nặng (heavy run) trên Google Colab: lấy code, mount Google Drive, tải Moon Trek
LOLA DEM, chạy test, precompute bằng hai phương pháp độc lập, kiểm tra kết quả, validation, bảng PASS/FAIL, biểu đồ kiểm
tra nhanh và zip kết quả lên Drive.

## 1. Chuẩn bị code

Chọn **một** trong hai cách:

* **Git:** đặt `REPO_URL` (và `REPO_BRANCH` nếu cần) trong ô `PARAMS`. Notebook `git clone` vào `/content/lunar-navigator`.
* **Zip bundle** (khi chưa có repo online): trên máy dev chạy

  ```bash
  ./.venv/Scripts/python scripts/make_colab_bundle.py
  # -> dist/lunarnav_colab_bundle.zip: chỉ code + tests + docs, không có data/, output/, .venv/
  ```

  rồi đặt file vào Drive ở `MyDrive/lunarnav/lunarnav_colab_bundle.zip`, hoặc vào `/content/`, hoặc để trống và
  upload khi notebook hỏi. Zip có tính tất định (deterministic: cùng code thì cùng byte) và chứa `BUNDLE_INFO.json`
  với `code_sha256`. Script từ chối mọi file > 5 MB, để DEM hay cache không lọt vào.

Sau đó notebook chạy `pip install -e ".[dev,notebook]"`. Không cần restart runtime: notebook thêm repo vào `sys.path`,
và mọi subprocess (CLI, pytest) nhận `PYTHONPATH`.

## 2. Các tham số chính (ô PARAMS)

| Tham số | Mặc định (full) | Ý nghĩa |
|---|---|---|
| `LIGHT_MODE` | `True` | `True` = smoke test vài phút; `False` = full run |
| `SITES` | `"all"` | cả catalog: south pole + reference + Apollo + far side (23 sites); hoặc `group:apollo`, danh sách id |
| `START_UTC`, `END_UTC`, `STEP_MIN` | 2026-01-01, 2031-01-01 (exclusive), 60 | 5 năm hàng giờ = 43 824 mẫu / site |
| `PRIMARY` | Horizons + `trek` + `raymarch` | phương pháp A (Resources tab) |
| `CROSSCHECK` | SPICE + `pgda` + `bruteforce` | phương pháp B, DEM khác, thuật toán horizon khác |
| `DEM_FALLBACK` | `flat` | sites ngoài DEM cực nhận horizon mặt cầu nhẵn (ghi trong `dem_source`) |
| `TREK_LABELS` | 3 file Trek (5 m, 30 m, 100 m) | ~4.6 GB tổng |
| `DEM_LOCAL_COPY` | `True` | chép DEM từ Drive sang ổ local `/content` để đọc nhanh |
| `RUN_TESTS`, `TEST_MARKERS` | `True`, `"not slow"` | pytest |
| `RUN_VALIDATION`, `RUN_TERRAIN_VALIDATION` | `True`, `True` | `validate.run_all` + `validate_terrain.run` |
| `RESUME` | `True` | `--resume` cho precompute |
| `FAIL_ON_ERROR` | `True` | ô cuối raise nếu có check bắt buộc FAIL |

`LIGHT_MODE = True` ghi đè (override): 2 sites (`ref_connecting_ridge_c1`, `apollo11`), 3 ngày (2026-01-07..10, có một
lần Earth lặn ở C1), PGDA cho cả A và B, bán kính 60 km, không tải Trek, test `-m "not slow and not network"`, terrain
validation nhẹ (header Trek + Trek ImageServer vs PGDA tại 1 site) thay cho `validate_terrain.run`.

## 3. Bố trí trên Google Drive

```
MyDrive/lunarnav/
  lunarnav_colab_bundle.zip   (nếu dùng bundle)
  data/                        LUNARNAV_DATA (bền): cache/ (Horizons, PGDA, Trek header...), kernels/ (SPICE), dem/ (Trek DEM)
  output/                      LUNARNAV_OUTPUT: <run>_A_..., <run>_B_..., <run>_validation/ (báo cáo, checks.csv, PNG)
  exports/<run>.zip            zip của 3 thư mục trên + RUN_INFO.json
```

Với `DEM_LOCAL_COPY=True`, `LUNARNAV_DATA=/content/lunarnav_data`: `cache/` và `kernels/` là symlink sang Drive, còn
`dem/` là bản sao local (Drive FUSE đọc ngẫu nhiên chậm). DEM tải về được lưu thêm một bản lên Drive, nên phiên sau chỉ
cần chép lại (~1-2 phút) chứ không phải tải lại.

Dung lượng cần: ~4.6 GB DEM trên Drive (và trên ổ local Colab), kết quả khoảng 4-5 MB mỗi site cho 5 năm hàng giờ (A + B
≈ 0.2 GB cho 23 sites).

## 4. Kết quả kiểm tra (PASS/FAIL)

Mỗi kiểm tra là một dòng trong bảng, lưu ở `<run>_validation/checks.csv`:

* `PASS` / `FAIL`: kiểm tra bắt buộc (test suite, precompute exit code, `check_output` 0 violations, A vs B ephemeris,
  validation A/B/C, negative controls, Apollo 11, lunar day, raymarch vs bruteforce, so với bản đồ NASA...).
* `KNOWN`: sai khác đã biết và đã giải thích, không phải lỗi code. Hiện có: chiếu sáng của người quan sát 0 m so với
  bản đồ NASA (xem `docs/VALIDATION_TERRAIN.md` §2.3).
* `REVIEW`: tiêu chí mềm cần người xem (% nắng A vs B ở site có địa hình > 5 pp; Trek vs PGDA vượt 2 m / 0.5° / 3 pp).
* `INFO`, `SKIP`: thông tin, bỏ qua.

## 5. Thời gian dự kiến

* LIGHT_MODE: ~2 phút trên máy dev với cache nóng (smoke run 2026-11-13: ~2 phút, 33 PASS, 0 FAIL); trên Colab cache
  lạnh thêm vài phút (SPICE kernels ~45 MB, block PGDA, header Trek ~16 MB).
* Full: tải DEM 4.6 GB (tuỳ băng thông Moon Trek, không resume được), test ~2-5 phút, terrain validation ~25 phút
  (cache lạnh), precompute A và B nhiều giờ (chưa đo trên Colab). Session Colab có giới hạn thời gian: chạy lại
  *Run all* sau khi mất kết nối, `--resume` bỏ qua các site đã xong.

## 6. Smoke test local (không phải Colab)

Ngoài Colab, notebook tự bỏ qua các ô mount Drive / clone / pip (phát hiện bằng `"google.colab" in sys.modules`),
dùng repo chứa notebook (hoặc env `LUNARNAV_REPO`) và `LUNARNAV_DATA` / `LUNARNAV_OUTPUT` nếu đã đặt (mặc định `data/`,
`output/` của repo). Chạy bằng nbclient:

```bash
cd /d/UAV/lunar-navigator
./.venv/Scripts/python -m pip install -e ".[dev,notebook]"
./.venv/Scripts/python - <<'EOF'
import asyncio, sys, nbformat
from nbclient import NotebookClient
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
nb = nbformat.read("notebooks/lunar_navigator_colab.ipynb", as_version=4)
NotebookClient(nb, timeout=1800, kernel_name="python3", resources={"metadata": {"path": "notebooks"}}).execute()
nbformat.write(nb, "output/lunar_navigator_colab.executed.ipynb")
print("OK")
EOF
```

Notebook phải để `LIGHT_MODE = True` khi chạy local. Ở full mode, `download_product` từ chối tải file Trek > 100 MB ngoài
Colab, và bước tải sẽ ghi `FAIL`.
