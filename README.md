# Lunar Landing Site Navigator: computation backend (`lunarnav`)

Backend tính toán cho thử thách **NASA Space Apps 2026 "Lunar Landing Site Navigator"**. Mục tiêu là so sánh các
bãi đáp (landing sites) và ngày đáp trên Mặt Trăng theo vị trí của **Mặt Trời (Sun)** và **Trái Đất (Earth)** so với
**đường chân trời địa hình (terrain horizon)**. Từ đó suy ra:

* **tiềm năng điện mặt trời (solar power)**: phần đĩa Mặt Trời nhìn thấy, công suất tấm pin, thời gian tối dài nhất;
* **cửa sổ liên lạc trực tiếp với Trái Đất (direct-to-Earth, DTE)**: Earth có trên horizon không, khoảng mất liên lạc dài nhất;
* **xếp hạng site (ranking)** và **ngày đáp thay thế (alternative landing dates)** khi lịch bị trễ.

Ở cực nam, Mặt Trời luôn nằm trong khoảng ~1.5° quanh đường chân trời và Trái Đất trong khoảng ~7°, nên **địa hình
quyết định tất cả**: dời site 100 m có thể đổi % nắng từ 85 % xuống 20 % (đã đo, xem `docs/VALIDATION_TERRAIN.md`).

Repo này chỉ có phần **tính trước (precompute)**, các công cụ tính toán và **kiểm chứng (validation)**. Giao diện
(frontend/UI) làm sau và chỉ cần đọc thư mục kết quả mô tả trong [`docs/OUTPUT_SPEC.md`](docs/OUTPUT_SPEC.md).

Nguồn dữ liệu theo **Resources tab** của thử thách: **JPL Horizons System** (ephemeris), **NASA Moon Trek** và
**Quickmap** (địa hình LOLA). Các nguồn NASA độc lập khác (NAIF SPICE generic kernels, NASA GSFC PGDA LOLA DEM) được dùng
làm **phương pháp thứ hai để đối chiếu (cross-check)**.

---

## 1. Cấu trúc (structure)

```
lunar-navigator/
  lunarnav/                 python package
    types.py                hợp đồng dùng chung (shared contract): Site, EphemerisSeries, HorizonMask, DemPatch...
    config.py               hằng số, thư mục data/cache/output (env LUNARNAV_DATA, LUNARNAV_OUTPUT)
    sites.py, catalog/      catalog 23 sites có nguồn trích dẫn (Artemis III, các lần đáp thật, Apollo, far side...)
    ephem/horizons.py       Method A: JPL Horizons API
    ephem/spice.py, kernels.py   Method B: NAIF SPICE (DE440 + MOON_ME)
    ephem/analytic.py       Method C: mô hình giải tích độc lập (ERFA + IAU rotation), offline
    terrain/trek.py         LOLA DEM từ NASA Moon Trek (file đầy đủ 1-2 GB, chỉ tải trên Colab; ImageServer đọc một phần)
    terrain/pgda.py         LOLA DEM từ NASA GSFC PGDA (Cloud-Optimized GeoTIFF, đọc theo block, có cache)
    terrain/common.py       phép chiếu polar stereographic, NestedDem (mịn gần, thô xa)
    horizon.py              horizon mask: raymarch, bruteforce (hai thuật toán độc lập), flat
    visibility.py           luật nhìn thấy (visibility rules): phần đĩa Mặt Trời, công suất, Earth clearance
    windows.py              cửa sổ thời gian (windows), metrics, "còn bao lâu tới hoàng hôn"
    analysis.py             phân tích nhiều site, ranking, alternative landing dates
    precompute.py           pipeline batch, writer có tính tất định (deterministic), check_output
    validate.py             validation ephemeris A/B/C, negative controls, Apollo 11, lunar day
    validate_terrain.py     validation địa hình: raymarch vs bruteforce, so với bản đồ chiếu sáng NASA, Trek vs PGDA
    cli.py                  lệnh `lunarnav precompute | analyse | alt-dates | check | validate`
  tests/                    pytest (marker `network`, `slow`)
  docs/                     ARCHITECTURE, OUTPUT_SPEC, VALIDATION, VALIDATION_TERRAIN, DATA_SOURCES, SITES, HORIZONS_NOTES
  notebooks/                lunar_navigator_colab.ipynb: lần chạy nặng trên Google Colab (+ README)
  scripts/make_colab_bundle.py   đóng gói code (không data) thành zip để upload lên Colab
  data/                     (git-ignored) cache HTTP, SPICE kernels, DEM
  output/                   (git-ignored) kết quả precompute
```

Sơ đồ module và luồng dữ liệu (data flow): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## 2. Chạy local (development, Windows/Linux)

Máy dev chỉ dùng **dữ liệu nhẹ**. Không bao giờ tải file Moon Trek DEM đầy đủ (> 100 MB) ở đây: `download_product`
từ chối nếu không chạy trên Colab.

```bash
python -m venv .venv
./.venv/Scripts/python -m pip install -e ".[dev,notebook]"      # Linux/macOS: .venv/bin/python

# test offline nhanh (~1-2 phút)
./.venv/Scripts/python -m pytest -q -m "not network and not slow"
# toàn bộ trừ slow (cần internet: Horizons, NAIF, PGDA; response được cache vào data/cache)
./.venv/Scripts/python -m pytest -q -m "not slow"
# từng phần
./.venv/Scripts/python -m pytest -q tests/test_precompute.py
```

Ví dụ CLI (sites ngoài vùng DEM cực, như Apollo, cần `--dem-fallback flat`):

```bash
lunarnav precompute --sites ref_connecting_ridge_c1,apollo11 --start 2026-01-01 --end 2026-02-01 --step-min 60 \
    --provider horizons --dem pgda --horizon-method raymarch --dem-fallback flat --out output/demo
lunarnav check output/demo                     # 0 violations = đúng định dạng và vật lý
lunarnav validate --no-terrain                 # validation ephemeris A/B/C (~5-12 s)
python -m lunarnav.validate_terrain --quick    # validation địa hình (đọc block PGDA, vài phút)
lunarnav alt-dates --custom-site SR:-89.45:222.69 --earliest 2027-03-01 --latest 2027-06-01 \
    --mission-h 336 --min-sun-pct 70 --require-earth-at-landing --provider spice
```

## 3. Chạy trên Google Colab (lần chạy nặng)

Lần chạy đầy đủ (tải ~4.6 GB Moon Trek DEM, precompute 2026-2030 hàng giờ cho cả catalog) chạy trên **Google Colab**
bằng notebook [`notebooks/lunar_navigator_colab.ipynb`](notebooks/lunar_navigator_colab.ipynb). Hướng dẫn chi tiết:
[`notebooks/README.md`](notebooks/README.md). Tóm tắt:

1. Lấy code: đặt `REPO_URL` (git clone) **hoặc** tạo zip code trên máy dev rồi upload:
   ```bash
   ./.venv/Scripts/python scripts/make_colab_bundle.py      # -> dist/lunarnav_colab_bundle.zip (~0.3 MB, không có data)
   ```
   Đặt zip vào Google Drive `MyDrive/lunarnav/lunarnav_colab_bundle.zip` (hoặc upload khi notebook hỏi).
2. Mở notebook trên Colab, chạy với `LIGHT_MODE = True` (smoke test vài phút: 2 sites, 3 ngày, chỉ PGDA, không tải Trek).
3. Đặt `LIGHT_MODE = False`, *Runtime > Run all*. Notebook sẽ mount Drive, đặt `LUNARNAV_DATA` / `LUNARNAV_OUTPUT` lên
   Drive, tải DEM (có progress và kiểm tra kích thước), chạy test, precompute **A** (Horizons + Moon Trek + raymarch) và
   **B** (SPICE + PGDA + bruteforce), `check_output`, so sánh A với B, validation, Trek vs PGDA, in bảng PASS/FAIL, vẽ
   biểu đồ kiểm tra và zip kết quả vào `MyDrive/lunarnav/exports/`.
4. Mất kết nối thì chạy lại: DEM, cache và kết quả nằm trên Drive, `--resume` bỏ qua các site đã xong. Tên run có mã
   băm của code (code hash), nên code khác sẽ không bao giờ dùng lại kết quả cũ.

## 4. Phương pháp (methods)

### Ephemeris: vị trí Sun / Earth nhìn từ site (azimuth, elevation, distance)

| | Phương pháp | Nguồn | Khung Mặt Trăng (lunar frame) | Vai trò |
|---|---|---|---|---|
| **A** | `HorizonsProvider` | JPL Horizons API (Resources tab), DE441, `coord@301`, airless apparent | MEAN_ME (DE421 mean-Earth) | **primary** |
| **B** | `SpiceProvider` | NAIF SPICE: `de440s.bsp`, `moon_pa_de440_200625.bpc`, `moon_de440_250416.tf`, `CN+S` | MOON_ME | cross-check cùng mô hình JPL |
| **C** | `AnalyticProvider` | ERFA `epv00` + `moon98` (ELP2000-82 rút gọn) + quay IAU WGCCRE, không dùng dữ liệu JPL | IAU_MOON | cross-check độc lập (bắt lỗi quy ước, dấu, thang thời gian) |

### Địa hình (terrain) và horizon

| | Nguồn / thuật toán | Ghi chú |
|---|---|---|
| DEM primary | **NASA Moon Trek** LOLA polar DEMs (`LRO_LOLA_DEM_SPole875_5mp_v04_EQ`, `..._SPole75_30mp_...`, `..._SPole45_100mp_...`) | file 1-2 GB, chỉ tải trên Colab; lưới địa lý `_EQ`, Int16 = nửa mét (half-metres) |
| DEM cross-check | **NASA GSFC PGDA** product 90 (Barker et al. 2023), dải khoảng cách: 20/30/60 m tới 15 km, 120 m tới 60 km, 240 m xa hơn | đọc từng block COG, cache trên đĩa |
| Horizon 1 | `raymarch`: tia great-circle, nội suy bilinear | nhanh (150 km / 25 m trong ~1.7 s) |
| Horizon 2 | `bruteforce`: mọi ô DEM, az/el chính xác bằng vector 3-D | độc lập với raymarch |
| Horizon 3 | `flat`: mặt cầu nhẵn, độ hạ chân trời (dip) giải tích | dùng cho sites ngoài vùng DEM cực (`--dem-fallback flat`) |
| Tham chiếu | Bản đồ chiếu sáng trung bình và bóng tối vĩnh cửu của NASA PGDA (product 69, Mazarico et al.) | dùng để kiểm chứng % chiếu sáng |

Quickmap không có API độ cao thô (raw-elevation API) nên không dùng để tính (`docs/DATA_SOURCES.md`).

## 5. "Kết quả đúng" nghĩa là gì (what correct output means)

1. **Định dạng và vật lý của mọi thư mục precompute:** `lunarnav check DIR` (= `precompute.check_output`) phải báo
   **0 violations**. Hàm này kiểm tra lại mọi invariant trong [`docs/OUTPUT_SPEC.md`](docs/OUTPUT_SPEC.md) §4 bằng code
   tham chiếu **độc lập** với writer: checksum, lưới thời gian, windows lát kín khoảng thời gian, mọi cột suy diễn được
   tính lại từ các cột đã ghi, Sun ở cực nằm trong ±1.65° quanh chân trời, azimuth của Earth ở cực ≈ 360° − lon,
   far side không bao giờ thấy Earth, khoảng cách hợp lý... Mỗi invariant đều có test cố tình làm hỏng output để chứng
   minh lỗi bị bắt.
2. **Các phương pháp độc lập phải khớp nhau trong giới hạn có lý do (justified limits):**
   [`docs/VALIDATION.md`](docs/VALIDATION.md) (ephemeris) và [`docs/VALIDATION_TERRAIN.md`](docs/VALIDATION_TERRAIN.md)
   (địa hình).
3. **Negative controls:** cố tình tính sai (sai khung, sai thang thời gian, bỏ aberration, kinh độ West...) thì giới hạn
   phải bắt được.

Số đo thực tế (measured, tóm tắt từ docs và các lần chạy):

| Kiểm tra | Kết quả đo | Giới hạn |
|---|---|---|
| A (Horizons) vs B (SPICE), 8652 mẫu, 6 sites | Sun 0.0017", Earth 0.0020" (góc lớn nhất); khoảng cách Earth 0.20 m | 0.02" |
| A/B vs C (giải tích) | Sun 0.0040°, Earth 0.0034° | 0.02° (ngân sách sai số của C ~0.011°) |
| Negative controls (10 lỗi phải bắt) | tất cả bị bắt: MOON_PA 104", IAU_MOON 8-10", lệch 69 s 35", bỏ aberration 21", kinh độ West ~48°, azimuth ngược 179° | phải vượt giới hạn A-B |
| Apollo 11 hạ cánh 1969-07-20 20:17:40 UTC | Sun elevation 10.703° (A và B), 10.702° (C) | tài liệu 10.8 ± 0.5° |
| Ngày Mặt Trăng tại Apollo 11 (2026) | ban ngày 357.13 h; hoàng hôn tới hoàng hôn 709.94 h | công thức Kepler 356.65 h / 710.02 h |
| Precompute end-to-end SPICE vs Horizons (744 mẫu, 3 sites) | mọi metric trong summary.csv giống hệt; hướng lệch ≤ 0.007" | - |
| Horizon raymarch vs bruteforce, địa hình thật (ngoài 2 km) | p95 0.015-0.070° | 0.1° |
| Mặt cầu phẳng, mast 2 m (tổng hợp) | cả hai thuật toán trong 1e-4° của dip −0.086937° | 0.01° |
| Chiếu sáng vs bản đồ NASA PGDA, 30 pixel bóng tối vĩnh cửu (PSR) | 0.000 % cho cả 30 | < 1 % |
| Chiếu sáng vs NASA PGDA, 30 pixel sáng, mast 2 m | bias +1.6 pp, median abs 3.9 pp, p90 6.3 pp, tương quan 0.90 | 5 / 5 / 12 pp |
| Earth visibility vs NASA PGDA, 60 pixel | sai khác trung bình 0.7-1.1 pp | 10 pp |
| Moon Trek vs PGDA (30 m, 10 km quanh 2 sites) | độ cao median 0.14-0.27 m, std 2.1 / 9.2 m; mask ngoài 1 km p95 0.15-0.30°; chiếu sáng lệch 0.1-0.8 pp | tiêu chí mềm |
| Header Moon Trek (không tải cả file) | scale Int16 = 0.50009 (nửa mét), Float32 = 0.99912 | trong 1 % |

**Smoke run của notebook (LIGHT_MODE, máy dev, 2026-11-13, nbclient, từ zip bundle đã giải nén):** chạy trọn notebook
trong ~2 phút với dữ liệu nhẹ: 33 PASS, 0 FAIL (2 INFO, 2 SKIP). Gồm: pytest offline 369 passed; `check_output`
0 violations cho A và B; A vs B ephemeris ≤ 0.0051" (giới hạn 0.025"); validation quick PASS (A-B 0.0018", 10/10 negative
controls bị bắt, Apollo 11 10.703°); header Trek PASS; Trek ImageServer vs PGDA tại ridge C1: Δh median +0.13 m, mask p95
0.15°. Lần chạy đầy đủ (full) chưa thực hiện: nó dành cho Colab.

## 6. Giới hạn đã biết (known limitations)

* **Lần chạy nặng chưa chạy:** tải Moon Trek DEM 1-2 GB và precompute nhiều năm chỉ chạy trên Colab. `TrekDem` trên file
  thật mới được kiểm bằng file tổng hợp (synthetic) mô phỏng header thật; trên Colab, `download_product(verify=True)` mở
  file và kiểm lại CRS/dtype/kích thước. Thời gian raymarch trên `NestedDem` Trek 5 m (≈37 triệu lần đọc độ cao mỗi site ở
  150 km) chưa được đo.
* **File Trek `_EQ`** là lưới địa lý (lat/lon); độ phân giải theo phương bán kính thực tế là 35.7 / 86.6 / 155.7 m cho các
  file "5 / 30 / 100 m". Lưới cực gốc 5/30/100 m chỉ có qua Trek ImageServer (backend không có tài liệu).
* **Người quan sát 0 m** trên DEM tự che bóng mình: so với bản đồ NASA tối hơn 7.6 pp (đã biết, do khác định nghĩa).
  Precompute dùng mast mặc định 2 m (khớp bản đồ NASA); không nên báo cáo kết quả 0 m nếu không có quy tắc vùng gần.
* **Rất nhạy với vị trí:** trên đỉnh núi, dời 100 m có thể đổi % nắng tới 65 pp; tọa độ các vùng Artemis III là tâm vùng
  (region centres), không phải điểm đáp, có 3 vùng đo trên bản đồ raster (sai số ước tính < 2 km).
* **Sites ngoài DEM cực** (Apollo, far side, Chang'e-4/6 với PGDA) dùng horizon mặt cầu nhẵn (`dem_source`
  `none:outside-...`); cần DEM toàn cầu (global DEM) nếu muốn địa hình ở đó.
* **Near field của horizon:** trong vài chục pixel quanh site, raymarch và bruteforce lệch tới 1-2° trên địa hình gồ ghề
  (do cách mô hình hoá DEM, không phải bug).
* Giả định không có giây nhuận (leap second) sau 2017 (như Horizons và naif0012). Horizons dùng khung MEAN_ME chỉ cho năm
  1550-2650.
* Phần đĩa Mặt Trời coi horizon là đường thẳng qua đĩa, bỏ qua limb darkening.
* Trek ImageServer và Horizons GET URL limit (~2 kB) được tìm bằng thực nghiệm, có thể thay đổi phía server.
* `--resume` dựa vào `__version__` và git commit; khi không có git (zip bundle) notebook đưa code hash vào tên run để
  không dùng lại kết quả của code khác.

## 7. Tài liệu (docs)

| File | Nội dung |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | module map, data flow, thuật toán chính, công thức Colab |
| [`docs/OUTPUT_SPEC.md`](docs/OUTPUT_SPEC.md) | định dạng thư mục kết quả, mọi cột, đơn vị, quy ước, invariants |
| [`docs/VALIDATION.md`](docs/VALIDATION.md) | validation ephemeris A/B/C, negative controls, giải thích sai khác |
| [`docs/VALIDATION_TERRAIN.md`](docs/VALIDATION_TERRAIN.md) | validation địa hình, chiếu sáng, Trek vs PGDA, độ nhạy |
| [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) | phát hiện về Moon Trek / Quickmap / PGDA (định dạng, đơn vị, nodata) |
| [`docs/HORIZONS_NOTES.md`](docs/HORIZONS_NOTES.md) | hành vi của JPL Horizons API (khung, bán kính, giới hạn) |
| [`docs/SITES.md`](docs/SITES.md) | catalog sites và nguồn tọa độ |
| [`notebooks/README.md`](notebooks/README.md) | hướng dẫn notebook Colab và smoke test local |
