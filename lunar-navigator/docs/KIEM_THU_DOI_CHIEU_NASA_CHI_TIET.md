# Kiểm thử đối chiếu backend với 3 công cụ NASA (Horizons, Moon Trek, QuickMap)

Tài liệu này dành cho người kiểm thử độc lập. Bạn dùng ba công cụ của đề bài để tự kiểm tra một số trường hợp, rồi so với backend lunarnav.

* **JPL Horizons**: https://ssd.jpl.nasa.gov/horizons/app.html
* **NASA Moon Trek**: https://trek.nasa.gov/moon/
* **LROC QuickMap**: https://quickmap.lroc.asu.edu/ (từ 11/2026 trang tự chuyển sang **https://quickmap.lroc.im-ldi.com/**; địa chỉ cũ hiện vẫn dùng được và tự chuyển hướng)

Backend thử nghiệm: `http://192.168.1.63:8000/api/v1` (Swagger: `http://192.168.1.63:8000/api/v1/docs`). Bạn chỉ cần dán URL vào trình duyệt, kết quả là JSON.

> **Số liệu trong tài liệu được đo thật vào ngày 2026-11-14.** Với mỗi ca Horizons, chúng tôi đã gọi backend trực tiếp và gọi Horizons API với đúng các thiết lập ở mục 1. Một ca (H3-d) còn được làm lại bằng tay trên Horizons web app và cho ra các con số giống hệt. Giao diện Moon Trek và QuickMap mô tả ở mục 2–3 đã được mở và thao tác thử trên trình duyệt.

---

## Quy ước chung (đọc trước khi bắt đầu)

| Mục | Quy ước của backend | Lưu ý khi nhập vào công cụ NASA |
|---|---|---|
| Thời gian | **UTC** ở mọi nơi | Giờ Việt Nam = UTC + 7. Horizons ghi "UT" (= UTC). |
| Bước thời gian | 1 giờ (`step_s = 3600`) | `/instant?t=` **làm tròn xuống** giờ chẵn: `09:40` trả về mẫu `09:00`. Luôn hỏi đúng giờ chẵn. |
| Vĩ độ | độ, planetocentric, âm = Nam | Nhập nguyên giá trị. |
| Kinh độ | **Đông, 0–360°** (`lon_deg`) | Horizons và QuickMap nhận 0–360. **Moon Trek chỉ nhận −180…180**: lấy `lon − 360` nếu lon > 180 (ví dụ 203.97 → −156.03). |
| Độ cao bề mặt | `surface_height_m`, tính bằng mét so với **mặt cầu 1737.4 km** | Moon Trek, QuickMap và Horizons cũng dùng mặt cầu 1737.4 km. |
| Người quan sát | bề mặt + **cột 2 m** | Độ cao nhập vào Horizons = `(surface_height_m + 2) / 1000` km. |
| Phương vị (az) | độ, tính **theo chiều kim đồng hồ từ hướng Bắc địa phương** (N = 0, E = 90) | Giống Horizons. |
| Góc cao (el) | góc cao biểu kiến, **không khí quyển** (airless), có hiệu chỉnh light-time và quang sai; tính từ thiên đỉnh hướng tâm của mặt cầu 1737.4 km | Giống cột `Azimuth_(a-app)__Elevation` của Horizons. |
| Mặt Trời "thấy được" | **mép trên** cao hơn chân trời địa hình: `el + bán kính góc > horizon_el` | Bán kính góc = `Ang-diam / 2 / 3600` (độ). |
| Trái Đất "thấy được" | **tâm** cao hơn chân trời địa hình: `el > horizon_el` | Bản đồ PGDA/QuickMap tính "bất kỳ phần nào của đĩa", nên giá trị của chúng cao hơn một chút. |
| Run (lần chạy) | mặc định **B** = `B_spice_pgda_bruteforce_2026_2030` (ephemeris SPICE + địa hình PGDA LOLA) | Run **A** = `A_horizons_trek_raymarch_2026_2030` (ephemeris Horizons + địa hình Moon Trek LOLA). Thêm `&run_id=A_horizons_trek_raymarch_2026_2030` vào URL để xem run A. |

Các endpoint dùng trong tài liệu:

```
GET /sites                         danh sách site + % nắng/% thấy Trái Đất
GET /sites/{id}                    site.lat_deg, site.lon_deg, site.surface_height_m,
                                   site.observer_height_above_sphere_m (= h + 2 m), metrics
GET /sites/{id}/instant?t=...      sun/earth: az_deg, el_deg, dist_km, horizon_el_deg, visible
GET /sites/{id}/horizon            góc cao chân trời địa hình cho mỗi 0.5° phương vị
GET /sites/{id}/windows?start=&end=  các khoảng nắng/tối, thấy/không thấy Trái Đất
```

---

## 0. Mỗi công cụ kiểm được gì, không kiểm được gì

| Công cụ | Kiểm được | KHÔNG kiểm được |
|---|---|---|
| **JPL Horizons** | Phương vị, góc cao, khoảng cách và bán kính góc của Mặt Trời và Trái Đất nhìn từ một điểm bất kỳ trên Mặt Trăng. Đây là "chuẩn vàng" cho phần thiên văn. | **Địa hình.** Horizons chỉ biết một mặt cầu nhẵn. Ký hiệu `*` (ban ngày: **mép trên** Mặt Trời ở trên chân trời) và `i` (**mép trên**, tức bất kỳ phần nào, của đĩa Trái Đất ở trên chân trời) chỉ so với chân trời của mặt cầu nhẵn nhìn từ độ cao bạn nhập (đã gồm độ hạ chân trời do độ cao đó). Vì vậy chúng chỉ dùng được để kiểm mọc/lặn **hình học** ở site xích đạo (Apollo) hoặc site có chân trời phẳng. Lưu ý: backend xét **tâm** Trái Đất, còn `i` xét mép trên. Ở cực Nam, quyết định "thấy hay không" là `el` (Horizons) so với `horizon_el` (backend). |
| **NASA Moon Trek** | Độ cao LOLA tại một điểm và **mặt cắt độ cao** (elevation profile) dọc một đường. Dùng nó để kiểm `surface_height_m` và để kiểm rằng một ngọn núi theo một phương vị có đúng góc cao mà `/horizon` báo. | Không tính chiếu sáng theo thời gian cho điểm tuỳ ý (các mục "Surface Lighting" và "Line of Sight" trong menu bị mờ, không bấm được, khi chúng tôi thử). Không cho nhập toạ độ chính xác của điểm đầu/cuối đường cắt (phải vẽ bằng chuột). |
| **LROC QuickMap** | Đọc giá trị nhiều lớp dữ liệu tại một điểm (Object Inspector → Inspect): độ cao (LOLA 20 m, LOLA 5 m, DTM động), **Sun Visibility 60 m** (tỉ lệ đĩa Mặt Trời trung bình), **Earth Visibility 60 m**, **SPOLE PSRs** (vùng tối vĩnh viễn, 0/1), "Polar illumination maps" (từ ảnh WAC). | Các bản đồ là **trung bình nhiều năm** (PGDA: 18.6 năm), không phải 2026–2030. Người quan sát của PGDA ở bề mặt DEM 60 m nhưng không bị 1–2 pixel lân cận tự che, nên kết quả gần với cột 2 m của backend (VALIDATION_TERRAIN.md mục 2.3). Vì vậy chỉ so sánh được trong biên độ vài điểm phần trăm. |

**Công thức góc cao của một vật cản** (dùng cho Moon Trek, mục 2.2):

```
angle ≈ atan( (Δh − d² / (2R)) / d )        R = 1 737 400 m
  Δh = h_vật_cản − (h_site + 2 m)     (m)
  d  = khoảng cách mặt đất từ site tới vật cản (m)
  d²/(2R) = độ cong Mặt Trăng: 10 km → 28.8 m; 50 km → 719 m; 100 km → 2 878 m
Công thức chính xác: tan(angle) = ((R+h)·cos θ − (R+h_obs)) / ((R+h)·sin θ),  θ = d / R
```

Sai số của công thức xấp xỉ phụ thuộc vào **góc**, không chỉ vào khoảng cách. Trong phạm vi 30 km, khi góc < 5° (như T4) nó lệch công thức chính xác < 0.005°. Với góc lớn thì sai số tăng lên (T5, 23.6°: 0.019°; d = 10 km, Δh = 5000 m: 0.066°), nên hãy dùng công thức chính xác.

---

## 1. Ca kiểm thử JPL Horizons (6 site, 23 thời điểm, 46 cặp Mặt Trời/Trái Đất)

### 1.1 Thiết lập Horizons web app từng bước (đã thao tác thử)

Mở https://ssd.jpl.nasa.gov/horizons/app.html. Trang có 5 mục: mục 1 (Ephemeris Type) là danh sách chọn, mục 2–5 có nút **Edit**.

1. **Ephemeris Type**: chọn **Observer Table**.
2. **Target Body → Edit**: gõ `10` (hoặc `Sun`) → chọn **Sun [Sol] (10)**. Làm lại lần hai với `399` → **Earth (399)**. Mỗi vật thể là một lần chạy riêng.
3. **Observer Location → Edit**:
   * *Choose a method*: chọn **Specify Coordinates**.
   * *Coordinate Body*: bấm **change** → kéo danh sách xuống, chọn **[id:301] Moon** → **Select Indicated Body**. Dòng chữ chuyển thành "Coordinate Body: Moon [Luna]".
   * *Type of coordinates*: **Geodetic Coordinates**. Với Moon, Horizons dùng mặt cầu 1737.4 km, nên "geodetic" trùng với planetocentric.
   * **longitude** = `lon_deg` (Đông, 0–360), **latitude** = `lat_deg`, **altitude** = `(surface_height_m + 2) / 1000`, đơn vị **kilometers** (độ cao có thể âm).
   * Bấm **Use Specified Coordinates**. Dòng tóm tắt phải hiện, ví dụ: `Observer Location: 203.97°E, -89.7849°N, 1.73925 km @301 (Moon [Luna])`.
4. **Time Specification → Edit**: giữ *Specify time span*. **Start time** = giờ cần kiểm, ví dụ `2026-03-13 16:00`, **Stop time** = 1 giờ sau, **Step size** = `1` `hours`. Bấm **Use Specified Time Span**. Muốn kiểm nhiều giờ lẻ cùng lúc thì chọn *Specify list of times*.
5. **Table Settings → Edit**:
   * Bấm **None** để bỏ hết, rồi chỉ tick **4. Apparent AZ & EL**, **13. Target angular diameter**, **20. Observer range & range-rate**.
   * *Additional Table Settings*: Reference frame **ICRF**; Date/time format **calendar format**; Time digits **HH:MM** (mặc định; chỉ chọn HH:MM:SS cho ca tuỳ chọn Apollo 11 20:17:40 ở mục 4.3); Angle format **decimal degrees**; Refraction model **no refraction (airless)**; Range units **kilometers (km)**; tick **Suppress range-rate**; tick **Extra precision**; RTS flag **disabled**; để trống mọi cutoff.
   * Bấm **Use Specified Settings**.
6. Bấm **Generate Ephemeris**. Đọc bảng giữa `$$SOE` và `$$EOE`: cột lần lượt là thời gian, ký hiệu `*`/`i`, **Azimuth**, **Elevation**, **Ang-diam** (giây cung), **delta** (km).
7. Kiểm phần đầu kết quả, phải thấy: `Center geodetic : <lon>, <lat>, <alt> {E-lon(deg),Lat(deg),Alt(km)}`, `Center pole/equ : MEAN_ME`, `Center radii : 1737.4, 1737.4, 1737.4 km`, `Atmos refraction: NO (AIRLESS)`.

**Cách nhanh hơn (tuỳ chọn):** dán URL Horizons API này vào trình duyệt. Đây là ca H3-d/H3-e, Mặt Trời; đổi `COMMAND=%2710%27` thành `%27399%27` để lấy Trái Đất:

```
https://ssd.jpl.nasa.gov/api/horizons.api?format=text&OBJ_DATA=NO&MAKE_EPHEM=YES&EPHEM_TYPE=OBSERVER&COMMAND=%2710%27&CENTER=%27coord%40301%27&COORD_TYPE=GEODETIC&SITE_COORD=%27203.97%2C-89.7849%2C1.73925%27&QUANTITIES=%274%2C13%2C20%27&TIME_TYPE=UT&ANG_FORMAT=DEG&APPARENT=AIRLESS&EXTRA_PREC=YES&RANGE_UNITS=KM&SUPPRESS_RANGE_RATE=YES&START_TIME=%272026-03-13+16%3A00%27&STOP_TIME=%272026-03-13+17%3A00%27&STEP_SIZE=%271+h%27
```

Kết quả mong đợi (web app với Time digits HH:MM cho ra đúng các số này; nếu chọn HH:MM:SS, giờ hiện thành `16:00:00`, các số không đổi):

```
 2026-Mar-13 16:00 *    36.929480953  -0.214169914  1932.223  1.4853248230E+08
 2026-Mar-13 17:00 *    36.421422530  -0.213796324  1932.238  1.4853131652E+08
```

### 1.2 Lấy số của backend

```
http://192.168.1.63:8000/api/v1/sites/<site_id>/instant?t=<YYYY-MM-DDTHH:00:00Z>
```

Ví dụ: `http://192.168.1.63:8000/api/v1/sites/ref_shackleton_rim/instant?t=2026-03-13T16:00:00Z`

Các trường cần so: `sun.az_deg`, `sun.el_deg`, `sun.dist_km`, `sun.horizon_el_deg`, `sun.visible`, và tương tự với `earth.*`. Trường `sample_utc` phải trùng với giờ bạn hỏi.

Toạ độ để nhập vào Horizons lấy từ `GET /sites/<site_id>`: các trường nằm trong khối `site` (`site.lat_deg`, `site.lon_deg`, `site.surface_height_m`). `site.observer_height_above_sphere_m` = h + 2 m, chia cho 1000 là ra altitude Horizons (km). Khối `metrics` nằm ở cấp ngoài cùng.

### 1.3 Tiêu chí đạt

| Đại lượng | Ngưỡng ĐẠT | Đo được (46 cặp, run B) |
|---|---|---|
| Phương vị az | \|Δ\| ≤ 0.001° (ngưỡng nới: 0.01°) | max 9.0e-7° |
| Góc cao el | \|Δ\| ≤ 0.001° (ngưỡng nới: 0.01°) | max 4.9e-7° |
| Khoảng cách | \|Δ\| ≤ 1 km | max 0.007 km |
| visible | phải trùng với "visible suy từ Horizons" (Mặt Trời: `el + Ang-diam/7200 > horizon_el`; Trái Đất: `el > horizon_el`) | trùng 46/46 |

Ngưỡng nới 0.01° chỉ dùng khi bạn đối chiếu bằng phần mềm khác hoặc ephemeris DE cũ hơn (ví dụ DE421/DE430); với Horizons và đúng thiết lập mục 1.1 thì dùng ngưỡng 0.001°.

Chênh lệch còn lại chỉ là do backend làm tròn đến 6 chữ số thập phân. Run A dùng chính Horizons nên khớp đến 8.5e-7°. Run B dùng SPICE (DE440) nhưng vẫn khớp Horizons (DE441) dưới 1e-6°.

> **Ca gần biên.** Nếu `el` chỉ cách `horizon_el` vài phần nghìn độ, "visible" rất nhạy với sai số DEM. Ví dụ H2-a, Trái Đất: el = −2.0401°, chân trời run B = −2.0387° (thấp hơn chân trời 0.0014°, nên không thấy); run A có chân trời −2.0496° nên báo thấy. Khi chấm điểm ca loại này, ghi "biên" thay vì "trượt".

### 1.4 Các site, toạ độ và độ cao để nhập vào Horizons

| ID | site_id | Nhóm | lon (E) | lat | surface_height_m (B) | **altitude Horizons (km)** | Thời điểm chọn (UTC) |
|---|---|---|---:|---:|---:|---:|---|
| H1 | `apollo11` | xích đạo, chân trời phẳng | 23.47314 | 0.67416 | 0 (*) | **0.002** | 03-01 00:00; hoàng hôn 03-09 09:00→10:00; bình minh 03-24 01:00→02:00 |
| H2 | `ref_connecting_ridge_c1` | sống núi cực Nam | 222.84 | -89.4505 | 1957.291 | **1.959291** | Trái Đất mọc 03-16 18:00→19:00; Mặt Trời lặn 03-28 21:00→22:00 |
| H3 | `ref_shackleton_rim` | mép miệng Shackleton | 203.97 | -89.7849 | 1737.25 | **1.73925** | 03-01 00:00; Trái Đất lặn 03-03 05:00→06:00; Mặt Trời lặn 03-13 16:00→17:00 |
| H4 | `a3_haworth` | vùng Artemis III | 336.328186 | -86.752966 | 1556.432 | **1.558432** | Mặt Trời mọc 03-06 16:00→17:00; Trái Đất mọc 03-19 12:00→13:00 |
| H5 | `change6` | mặt khuất | 206.0148 | -41.6385 | 0 (*) | **0.002** | Mặt Trời mọc 03-09 02:00→03:00; 03-16 12:00 |
| H6 | `psr_shackleton_floor` | đáy PSR Shackleton | 129.78 | -89.67 | -2788.943 | **-2.786943** | 03-01 00:00; 03-13 16:00 |

(*) Apollo và Chang'e-6 nằm ngoài vùng phủ DEM cực, nên backend đặt bề mặt = 0 m (chân trời phẳng). Hãy nhập 0.002 km cho giống backend. Nếu nhập độ cao thật (Apollo 11 khoảng −1928 m theo QuickMap), góc cao Trái Đất lệch tối đa khoảng 3e-4°, vẫn trong ngưỡng 0.001°.

Mọi thời điểm "→" là **một lần đổi trạng thái** do backend báo (`/windows`). Giờ đầu còn trạng thái cũ, giờ sau đã sang trạng thái mới.

### 1.5 Kết quả đo (Horizons API và backend, đo trực tiếp 2026-11-14)

Δ = backend − Horizons (độ). "visible suy từ Horizons" = tính bằng `el` của Horizons với `horizon_el` của backend (run B). Cột cuối là `visible` của run A, chỉ để tham khảo.

### H1 apollo11

| ID | UTC | Vật thể | Az Horizons | Az backend | ΔAz | El Horizons | El backend | ΔEl | Δ khoảng cách (km) | horizon_el backend | visible backend | visible suy từ Horizons | visible run A |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|
| H1-a | 2026-03-01 00:00 | Mặt Trời | 93.075257 | 93.075257 | 1.2e-07 | 78.530859 | 78.530859 | -2.3e-07 | -0.005 | -0.0869 | có | có | có |
| H1-a | 2026-03-01 00:00 | Trái Đất | 258.254180 | 258.254180 | -1.1e-08 | 69.814484 | 69.814484 | -3.9e-07 | -0.000 | -0.0869 | có | có | có |
| H1-b | 2026-03-09 09:00 | Mặt Trời | 270.307059 | 270.307059 | -4.3e-07 | -0.297791 | -0.297791 | 2.4e-07 | +0.007 | -0.0869 | có | có | có |
| H1-b | 2026-03-09 09:00 | Trái Đất | 285.529183 | 285.529183 | 2.6e-07 | 66.615072 | 66.615072 | 2.8e-07 | +0.000 | -0.0869 | có | có | có |
| H1-c | 2026-03-09 10:00 | Mặt Trời | 270.313942 | 270.313942 | -1.6e-07 | -0.804677 | -0.804677 | -1.1e-07 | +0.001 | -0.0869 | không | không | không |
| H1-c | 2026-03-09 10:00 | Trái Đất | 285.528397 | 285.528397 | -2.1e-07 | 66.563524 | 66.563524 | 3.6e-08 | +0.000 | -0.0869 | có | có | có |
| H1-d | 2026-03-24 01:00 | Mặt Trời | 89.355769 | 89.355769 | -1.9e-07 | -0.769749 | -0.769749 | 4.5e-07 | -0.004 | -0.0869 | không | không | không |
| H1-d | 2026-03-24 01:00 | Trái Đất | 251.325217 | 251.325217 | -1.8e-07 | 66.292688 | 66.292688 | -1.1e-07 | -0.000 | -0.0869 | có | có | có |
| H1-e | 2026-03-24 02:00 | Mặt Trời | 89.360545 | 89.360545 | 2.6e-07 | -0.261583 | -0.261583 | -6.4e-08 | -0.004 | -0.0869 | có | có | có |
| H1-e | 2026-03-24 02:00 | Trái Đất | 251.291553 | 251.291553 | 2.8e-07 | 66.342972 | 66.342972 | -4.2e-07 | -0.000 | -0.0869 | có | có | có |

### H2 ref_connecting_ridge_c1

| ID | UTC | Vật thể | Az Horizons | Az backend | ΔAz | El Horizons | El backend | ΔEl | Δ khoảng cách (km) | horizon_el backend | visible backend | visible suy từ Horizons | visible run A |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|
| H2-a | 2026-03-16 18:00 | Mặt Trời | 340.438483 | 340.438483 | -2.7e-07 | 0.071200 | 0.071200 | 1.3e-07 | +0.004 | -0.1920 | có | có | có |
| H2-a | 2026-03-16 18:00 | Trái Đất | 131.342478 | 131.342478 | -4.4e-07 | -2.040052 | -2.040052 | 1.0e-07 | +0.000 | -2.0387 | không | không | có |
| H2-b | 2026-03-16 19:00 | Mặt Trời | 339.929794 | 339.929794 | 3.7e-07 | 0.068656 | 0.068656 | -1.0e-07 | +0.004 | -0.2113 | có | có | có |
| H2-b | 2026-03-16 19:00 | Trái Đất | 131.341781 | 131.341780 | -5.0e-07 | -1.976082 | -1.976082 | 2.6e-07 | +0.000 | -2.0387 | có | có | có |
| H2-c | 2026-03-28 21:00 | Mặt Trời | 192.530851 | 192.530851 | -1.1e-07 | -1.328725 | -1.328725 | 2.4e-07 | -0.001 | -1.1442 | có | có | không |
| H2-c | 2026-03-28 21:00 | Trái Đất | 141.979785 | 141.979784 | -9.0e-07 | 1.708760 | 1.708760 | 8.8e-08 | -0.000 | -0.9836 | có | có | có |
| H2-d | 2026-03-28 22:00 | Mặt Trời | 192.023744 | 192.023744 | -3.8e-07 | -1.331165 | -1.331165 | 1.7e-07 | -0.002 | -1.0579 | không | không | không |
| H2-d | 2026-03-28 22:00 | Trái Đất | 141.989438 | 141.989437 | -8.3e-07 | 1.646774 | 1.646774 | 4.7e-07 | -0.000 | -0.9833 | có | có | có |

### H3 ref_shackleton_rim

| ID | UTC | Vật thể | Az Horizons | Az backend | ΔAz | El Horizons | El backend | ΔEl | Δ khoảng cách (km) | horizon_el backend | visible backend | visible suy từ Horizons | visible run A |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|
| H3-a | 2026-03-01 00:00 | Mặt Trời | 190.955522 | 190.955522 | 2.7e-07 | -0.261393 | -0.261393 | -4.5e-07 | -0.002 | -0.6867 | có | có | có |
| H3-a | 2026-03-01 00:00 | Trái Đất | 159.816275 | 159.816275 | -9.0e-09 | 2.908209 | 2.908209 | 2.2e-07 | -0.000 | -0.5664 | có | có | có |
| H3-b | 2026-03-03 05:00 | Mặt Trời | 164.137702 | 164.137702 | -2.9e-07 | -0.336453 | -0.336453 | -4.1e-07 | -0.001 | -1.3502 | có | có | có |
| H3-b | 2026-03-03 05:00 | Trái Đất | 160.741110 | 160.741110 | -4.6e-07 | -0.523346 | -0.523346 | 3.6e-07 | -0.000 | -0.5768 | có | có | có |
| H3-c | 2026-03-03 06:00 | Mặt Trời | 163.631738 | 163.631738 | -2.2e-07 | -0.337375 | -0.337375 | -4.9e-07 | +0.002 | -1.2152 | có | có | có |
| H3-c | 2026-03-03 06:00 | Trái Đất | 160.747120 | 160.747120 | -2.8e-07 | -0.589748 | -0.589748 | -2.8e-07 | -0.001 | -0.5770 | không | không | không |
| H3-d | 2026-03-13 16:00 | Mặt Trời | 36.929481 | 36.929481 | 4.7e-08 | -0.214170 | -0.214170 | -8.6e-08 | -0.001 | -0.0710 | có | có | không |
| H3-d | 2026-03-13 16:00 | Trái Đất | 151.844305 | 151.844305 | 4.3e-08 | -5.754085 | -5.754085 | -2.7e-07 | +0.001 | -1.0101 | không | không | không |
| H3-e | 2026-03-13 17:00 | Mặt Trời | 36.421423 | 36.421423 | 4.7e-07 | -0.213796 | -0.213796 | 3.2e-07 | +0.004 | 0.0873 | không | không | không |
| H3-e | 2026-03-13 17:00 | Trái Đất | 151.805001 | 151.805001 | -3.1e-07 | -5.715600 | -5.715600 | 9.0e-09 | +0.000 | -1.0193 | không | không | không |

### H4 a3_haworth

| ID | UTC | Vật thể | Az Horizons | Az backend | ΔAz | El Horizons | El backend | ΔEl | Δ khoảng cách (km) | horizon_el backend | visible backend | visible suy từ Horizons | visible run A |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|
| H4-a | 2026-03-06 16:00 | Mặt Trời | 349.760505 | 349.760505 | -3.3e-07 | 2.957072 | 2.957072 | -3.6e-07 | +0.002 | 3.2823 | không | không | không |
| H4-a | 2026-03-06 16:00 | Trái Đất | 27.232292 | 27.232292 | -3.0e-09 | -2.214654 | -2.214654 | -1.5e-07 | -0.000 | 5.5158 | không | không | không |
| H4-b | 2026-03-06 17:00 | Mặt Trời | 349.253544 | 349.253544 | -2.3e-07 | 2.950706 | 2.950706 | 1.3e-07 | -0.001 | 3.1046 | có | có | có |
| H4-b | 2026-03-06 17:00 | Trái Đất | 27.199889 | 27.199889 | 2.5e-07 | -2.257188 | -2.257188 | 7.8e-08 | -0.001 | 5.5142 | không | không | không |
| H4-c | 2026-03-19 12:00 | Mặt Trời | 193.393175 | 193.393175 | -1.3e-07 | -3.669301 | -3.669301 | -4.7e-07 | +0.001 | 2.1646 | không | không | không |
| H4-c | 2026-03-19 12:00 | Trái Đất | 19.168239 | 19.168239 | 8.9e-08 | 5.736928 | 5.736928 | -2.3e-07 | -0.000 | 5.7898 | không | không | không |
| H4-d | 2026-03-19 13:00 | Mặt Trời | 192.883293 | 192.883293 | 4.9e-07 | -3.676896 | -3.676896 | -4.4e-07 | -0.002 | 2.1813 | không | không | không |
| H4-d | 2026-03-19 13:00 | Trái Đất | 19.206900 | 19.206899 | -5.1e-07 | 5.798720 | 5.798720 | 3.0e-07 | -0.000 | 5.7826 | có | có | có |

### H5 change6

| ID | UTC | Vật thể | Az Horizons | Az backend | ΔAz | El Horizons | El backend | ΔEl | Δ khoảng cách (km) | horizon_el backend | visible backend | visible suy từ Horizons | visible run A |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|
| H5-a | 2026-03-09 02:00 | Mặt Trời | 90.246905 | 90.246905 | -3.9e-07 | -0.725695 | -0.725695 | 2.5e-07 | -0.001 | -0.0869 | không | không | không |
| H5-a | 2026-03-09 02:00 | Trái Đất | 141.000717 | 141.000717 | 8.0e-09 | -48.803312 | -48.803312 | -2.0e-08 | +0.000 | -0.0869 | không | không | không |
| H5-b | 2026-03-09 03:00 | Mặt Trời | 89.909440 | 89.909440 | 1.5e-08 | -0.347497 | -0.347497 | -1.7e-07 | +0.002 | -0.0869 | có | có | có |
| H5-b | 2026-03-09 03:00 | Trái Đất | 140.924564 | 140.924564 | -8.0e-08 | -48.794076 | -48.794076 | 2.5e-07 | +0.000 | -0.0869 | không | không | không |
| H5-c | 2026-03-16 12:00 | Mặt Trời | 0.470332 | 0.470332 | 3.7e-07 | 47.919462 | 47.919462 | -4.8e-07 | -0.004 | -0.0869 | có | có | có |
| H5-c | 2026-03-16 12:00 | Trái Đất | 135.764651 | 135.764651 | -2.3e-07 | -41.166933 | -41.166933 | 3.6e-07 | -0.000 | -0.0869 | không | không | không |

### H6 psr_shackleton_floor

| ID | UTC | Vật thể | Az Horizons | Az backend | ΔAz | El Horizons | El backend | ΔEl | Δ khoảng cách (km) | horizon_el backend | visible backend | visible suy từ Horizons | visible run A |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|
| H6-a | 2026-03-01 00:00 | Mặt Trời | 265.145776 | 265.145776 | 5.0e-07 | -0.078137 | -0.078137 | -3.1e-08 | -0.002 | 20.5561 | không | không | không |
| H6-a | 2026-03-01 00:00 | Trái Đất | 233.986735 | 233.986734 | -7.8e-07 | 2.916795 | 2.916795 | 3.0e-07 | -0.000 | 21.6436 | không | không | không |
| H6-b | 2026-03-13 16:00 | Mặt Trời | 111.117766 | 111.117766 | -1.0e-07 | -0.505014 | -0.505014 | 2.7e-07 | -0.002 | 22.6085 | không | không | không |
| H6-b | 2026-03-13 16:00 | Trái Đất | 226.066502 | 226.066502 | -2.3e-07 | -5.792773 | -5.792773 | 2.5e-07 | +0.000 | 22.0705 | không | không | không |

Nhận xét:

* **H3-d (Shackleton rim, 2026-03-13 16:00)**: run B báo Mặt Trời thấy được (mép trên −0.214 + 0.268 = +0.054° > chân trời −0.071°), run A báo không thấy (chân trời run A +0.115°). Đây là lỗi đã biết của run A ở site mép miệng, xem mục 4.4.
* **H6 (PSR)**: chân trời 20–23° nên Mặt Trời (el ≤ khoảng 2° ở cực Nam) **không bao giờ** thấy được, dù Horizons vẫn in `*` (vì Horizons không biết vách miệng núi lửa).
* **H5 (Chang'e-6)**: Trái Đất luôn ở el −41° đến −49°.

### 1.6 (Tuỳ chọn) Kiểm thời điểm mọc/lặn chính xác đến phút

Backend chỉ có độ phân giải 1 giờ. Thời điểm `end` của một cửa sổ là **mẫu đầu tiên** đã ở trạng thái mới, nên sự kiện thật nằm trong khoảng (giờ trước, `end`].

Ví dụ H3: backend báo Mặt Trời lặn ở `2026-03-13T17:00Z`. Chạy Horizons với Start `2026-03-13 16:00`, Stop `17:00`, Step `1 minutes`. Với mỗi phút, tính `el + Ang-diam/7200` và so với `horizon_el` tại phương vị đó: lấy từ `/sites/ref_shackleton_rim/horizon`, nội suy tuyến tính giữa hai bước 0.5°. Phương vị chỉ đổi từ 36.93° xuống 36.42° trong giờ đó. Kết quả đo: mép trên xuống dưới chân trời lúc **16:47 UTC**, nằm trong (16:00, 17:00]. **ĐẠT.**

---

## 2. Ca kiểm thử NASA Moon Trek (đã mở và thao tác thử giao diện)

### 2.1 Thao tác trên Moon Trek

1. Mở https://trek.nasa.gov/moon/ → **Skip Tutorial**.
2. Đổi phép chiếu: biểu tượng quả cầu ở góc **dưới bên trái** → **Projections** → **South Pole Map**.
3. Bay tới site: biểu tượng **máy bay** ở góc dưới bên phải → ô `Lat, Lon` → gõ `vĩ độ, kinh độ` với **kinh độ −180…180** (ví dụ `-89.7849, -156.03`) → Enter. Nếu gõ 203.97, ô chuyển đỏ và không bay. Phóng to bằng nút `+`/con lăn. Toạ độ dưới con trỏ hiện ở góc dưới bên phải (`Lat: …, Lon: …`, kinh độ −180…180).
4. Mặt cắt độ cao: menu **☰** (góc trên bên phải) → **Calculate Elevation Profile** → **Line** → **nhấn giữ chuột tại điểm đầu, kéo tới điểm cuối, thả** → hộp thoại hiện *Distance* → **Submit**.
5. Cửa sổ **Elevation Chart** vẽ đồng thời nhiều DEM: *LRO LOLA DEM 87.5 deg v4, S Pole* (5 m), *75 deg v4* (30 m), *45 deg v4* (100 m), *128ppd*. Trục Y là **Elevation (Meters)**, trục X là **Distance from Start (Meters)**. Rê chuột lên đường cong để đọc giá trị.
6. **Export** → CSV hoặc JSON, *Number of points on the curve* 10–400 → **Export Profile** để lấy số liệu. Lưu ý: tối đa 400 điểm, nên đường 10 km cho bước khoảng 25 m.

**Độ cao tại một điểm:** Moon Trek không có ô đọc độ cao tại con trỏ. Hãy vẽ một đường ngắn (khoảng 200 m) **bắt đầu đúng tại site** (phóng to tối đa), rồi đọc giá trị ở `Distance = 0` trên đường *87.5 deg* (5 m) hoặc *75 deg* (30 m).

### 2.2 Các ca và kết quả mong đợi

Giá trị "Trek" bên dưới được đọc trực tiếp từ dịch vụ ImageServer của Moon Trek, cũng là nguồn mà công cụ profile của Trek dùng (`LRO_LOLA_DEM_SPole875_5mp_v04` = đường "87.5 deg", `..._SPole75_30mp_v04` = "75 deg", `..._SPole45_100mp_v04` = "45 deg"), tại đúng toạ độ site.

**T1–T3: độ cao bề mặt tại site**

| ID | site_id | lat, lon (Trek) | Backend B (PGDA 20 m) | Backend A (Trek) | Trek 5 m | Trek 30 m | Trek 100 m | Ngưỡng |
|---|---|---|---:|---:|---:|---:|---:|---|
| T1 | `ref_connecting_ridge_c1` | -89.4505, -137.16 | 1957.29 | 1957.26 | 1957.5 | 1958.0 | 1956.0 | ±3 m (đỉnh sống núi phẳng) |
| T2 | `ref_shackleton_rim` | -89.7849, -156.03 | 1737.25 | 1734.17 | 1735.0 | 1736.5 | 1735.0 | ±5 m (mép dốc) |
| T3 | `psr_shackleton_floor` | -89.67, 129.78 | -2788.94 | -2786.44 | -2788.0 | -2787.0 | -2788.5 | ±5 m |
| (T3b) | `a3_haworth` | -86.752966, -23.671814 | 1556.43 | 1553.71 | (ngoài vùng 5 m) | 1551.5 | 1552.0 | ±6 m (sườn dốc khoảng 9°) |

* Run A lấy độ cao từ Moon Trek nên phải khớp Trek đến vài mét. Run B lấy từ PGDA (Barker 2023, nhiều quỹ đạo LOLA hơn và đã hiệu chỉnh crossover). Trong bán kính 10 km quanh site, độ lệch chuẩn giữa hai nguồn là 2.1 m (C1) đến 9.2 m (mép Shackleton) (VALIDATION_TERRAIN.md mục 3.2), lớn nhất ở mép miệng dốc. Trên lưới 30 m: trung bình lệch khoảng 0.8 m, độ lệch chuẩn khoảng 4 m, p99 khoảng 16 m (DATA_SOURCES.md mục 2.3 và 7).
* DEM 5 m của Trek lưu theo **nửa mét**, nên giá trị luôn là bội của 0.5 m.
* Vẽ đường bằng chuột thường lệch vài chục mét so với toạ độ chính xác. Trên mép dốc, sai lệch 20 m có thể đổi độ cao 5–10 m. Vì vậy hãy ưu tiên T1 (mặt sống núi phẳng) để chấm đạt/trượt.

**T4: mặt cắt theo phương vị của điểm chân trời cao nhất (mép Shackleton)**

* Backend: `GET /sites/ref_shackleton_rim/horizon` → giá trị lớn nhất **1.0356° tại az = 30.5°** (run B). Run A cho 1.0520° ở cùng az, nhưng đỉnh lớn nhất của run A là 19.06° ở az 282°, đây là lỗi đã biết (mục 4.4).
* Hướng này nhìn từ mép Shackleton về **sống núi nối Shackleton–de Gerlache** (gần điểm C1).
* Vật cản (tính lại từ DEM Trek 30 m dọc az 30.5°, bước 30 m, ra tới 150 km): **d = 9.94 km**, đỉnh cao **1947 m** tại **(-89.4753, 222.46 E)** = Trek `-89.4753, -137.54`.
* Kiểm bằng tay:

  ```
  h_obs = 1737.25 + 2 = 1739.25 m;   Δh = 1947 − 1739.25 = 207.75 m
  cong  = 9941² / (2·1737400) = 28.4 m
  angle ≈ atan((207.75 − 28.4) / 9941) = atan(0.01804) = 1.033°   (chính xác: 1.032°)
  backend B: 1.0356°   backend A: 1.0520°   → chênh 0.004° / 0.020°
  ```

* Trên Moon Trek: Fly To `-89.7849, -156.03`, phóng to, vẽ **Line** từ site tới khoảng `-89.3788, -135.65` (điểm cách 13 km, cùng hướng), Submit. Mong đợi: trên đường **75 deg (30 m)** của Elevation Chart, đường cong đi lên tới đỉnh khoảng **1945–1950 m ở khoảng 9.9 km**. Ở vật cản này ba DEM gần như trùng nhau (5 m: 1947, 30 m: 1947, 100 m: 1946.5 m). Đọc `h` và `d` của đỉnh trên đường 75 deg rồi tính `angle` theo công thức. **ĐẠT nếu \|angle − horizon_el(30.5°)\| ≤ 0.1°** (5 m sai số độ cao ở 10 km tương ứng 0.03°; vẽ lệch hướng 1° chỉ thay đổi vài phần trăm độ).

**T5 (tuỳ chọn, rõ hơn T4): vách miệng nhìn từ đáy PSR Shackleton**

* Backend: `/sites/psr_shackleton_floor/horizon` → lớn nhất **23.586° tại az = 144.5°** (B), 23.608° (A).
* Vật cản (Trek 30 m): **d = 9.92 km**, **h = 1582.5 m** tại (-89.7996, 201.25 E) = Trek `-89.7996, -158.75` (chính là mép Shackleton).
* `Δh = 1582.5 − (−2786.94) = 4369.4 m`, cong = 28.3 m → `angle ≈ atan(4341.1/9920) = 23.635°`. Góc lớn nên **dùng công thức chính xác: 23.616°** (công thức xấp xỉ lệch 0.019° ở đây). Chênh với backend theo công thức chính xác: 0.03° (B), 0.01° (A); theo công thức xấp xỉ: 0.05° (B), 0.03° (A).
* **ĐẠT nếu ≤ 0.3°.** Lý do: ở 10 km và góc 23.6°, 1 m sai số độ cao đổi góc khoảng 0.005°, nên 0.3° chứa được khoảng 50 m sai số độ cao trên vách dốc (vẽ lệch vài chục mét trên vách đổi độ cao rất nhiều) cộng sai lệch khi vẽ đường bằng chuột.
* Đọc đường **75 deg (30 m)**. Tại vật cản này các DEM khác nhau: 5 m: 1577.5 m, 30 m: 1582.5 m, 100 m: 1593 m. Nếu đọc đường 5 m, góc thấp hơn khoảng 0.025°.
* Trên Moon Trek: vẽ Line từ `-89.67, 129.78` tới khoảng `-89.7525, -136.46` (13 km). Đường cong phải leo từ khoảng −2790 m lên khoảng +1580 m ở khoảng 9.9 km.

---

## 3. Ca kiểm thử LROC QuickMap (đã mở và thao tác thử giao diện)

### 3.1 Thao tác

1. Mở https://quickmap.lroc.asu.edu/ (tự chuyển sang `quickmap.lroc.im-ldi.com`) → đóng hộp thoại thông báo (dấu ×).
2. Ô tìm kiếm góc trên bên trái (`Type a lat,lon(,height) or search...`): gõ `vĩ độ,kinh độ`, kinh độ **0–360** (ví dụ `-89.7849,203.97`) → chọn **Create Point at …**.
3. Bảng **Object Inspector** mở bên phải → tab **Inspect** (BOX SIZE `1x1`).
4. Bấm **Sources** để bật thêm các nguồn (lần đầu chỉ 10/180 nguồn được bật): **Sun Visibility 60m**, **Earth Visibility 60m**, **SPOLE PSRs (80S to 90S)**, **LOLA 80S 20M ADJ DEM**, **LOLA_SPOLE 5M [DEM]**, **Polar illumination maps**. Đóng danh sách, chờ vài giây cho giá trị hiện. Nguồn đã bật được giữ lại cho các điểm sau.
5. Đọc các dòng: `TerrainHeight` (m), `LOLA 80S 20M ADJ DEM` (m), `LOLA_SPOLE 5M [DEM]` (m), `Sun Visibility 60m` (0–1), `Earth Visibility 60m` (0–1), `SPOLE PSRs … (boolean)` (1 = tối vĩnh viễn), `Polar illumination maps` (%).

Ý nghĩa: *Sun/Earth Visibility 60m* là bản đồ PGDA của Mazarico et al. 2011 (cập nhật 2016): trung bình 18.6 năm, mỗi giờ một mẫu. Người quan sát ở bề mặt DEM 60 m nhưng không bị 1–2 pixel lân cận tự che, nên kết quả gần với cột 2 m của backend (VALIDATION_TERRAIN.md mục 2.3). Sun = **tỉ lệ đĩa Mặt Trời thấy được, lấy trung bình**. Earth = thấy **bất kỳ phần nào** của đĩa. *Polar illumination maps* (LROC WAC) được tính từ ảnh chụp trong khoảng 1 năm, định nghĩa khác hẳn, **chỉ để tham khảo**, không chấm.

### 3.2 Kết quả đo trên QuickMap (2026-11-14) và giá trị backend

**Q1: độ cao tại điểm**

| ID | site | QuickMap TerrainHeight | QuickMap LOLA 80S 20M ADJ | QuickMap LOLA_SPOLE 5M | Backend B | Backend A | Ngưỡng |
|---|---|---:|---:|---:|---:|---:|---|
| Q1-a | `ref_connecting_ridge_c1` (-89.4505, 222.84) | 1957.53 | 1957.49 | 1957.22 | 1957.29 | 1957.26 | ±3 m |
| Q1-b | `ref_shackleton_rim` (-89.7849, 203.97) | 1736.82 | 1736.27 | 1735.67 | 1737.25 | 1734.17 | ±5 m |
| Q1-c | `psr_shackleton_floor` (-89.67, 129.78) | -2788.47 | -2789.23 | – | -2788.94 | -2786.44 | ±5 m |
| Q1-d | `a3_haworth` (-86.752966, 336.328186) | 1556.64 | 1555.37 | 1558.46 | 1556.43 | 1553.71 | ±6 m |
| Q1-e | `ref_de_gerlache_rim` (-88.6646, 291.6044) | 1816.90 | 1814.17 | 1813.89 | 1815.15 | 1813.79 | ±5 m |

*LOLA 80S 20M ADJ* là đúng sản phẩm PGDA mà run B dùng. B và lớp này lệch nhau không quá 1.1 m ở cả 5 site, vì backend nội suy giữa các pixel.

**Q2: PSR có tối vĩnh viễn không**

| site | QuickMap SPOLE PSRs | QuickMap Sun Visibility 60m | Backend B/A `pct_sun` | Backend `longest_dark_h` |
|---|---:|---:|---:|---:|
| `psr_shackleton_floor` | **1** | 0.000 | **0 / 0** | 43824 (cả 5 năm) |
| `ref_shackleton_rim` (đối chứng) | 0 | 0.855 | 87.6 / 55.0 | 157 / 426 |

ĐẠT nếu PSR = 1 ⇔ backend `pct_sun = 0`. Có thể kiểm thêm `psr_haworth_floor` (-87.45, 354.83).

**Q3: % nắng trung bình so với backend**

So **đúng đại lượng** với nhau: QuickMap *Sun Visibility* (tỉ lệ đĩa trung bình) ↔ backend `metrics.mean_power_tracking × 100` (tỉ lệ đĩa trung bình, `GET /sites/{id}`). Còn `pct_sun` là % thời gian **mép trên** ló lên, luôn cao hơn tỉ lệ đĩa trung bình khoảng 1–5 điểm %.

| site | QuickMap Sun Vis. 60m | Backend B tỉ lệ đĩa TB | Δ (B − QM) | Backend B `pct_sun` | Backend A `pct_sun` | QuickMap Earth Vis. 60m | Backend B `pct_earth` | Văn liệu (SITES.md) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `ref_connecting_ridge_c1` | 86.4 % | 85.56 % | −0.8 pp | 90.25 % | 89.16 % | 57.9 % | 54.03 % | Gläser 2018: 76.0 % (0 m), 88.0 % (2 m); Mazarico 2011: 89.0 %; Speyerer 2013: 64.2 % |
| `ref_shackleton_rim` | 85.5 % | 83.19 % | −2.3 pp | 87.64 % | **54.99 % (lỗi run A)** | 56.7 % | 52.58 % | Gläser: 81.0 % (0 m), 85.5 % (2 m); Mazarico: 86.7 %; Speyerer: 71.6 % |
| `ref_de_gerlache_rim` | 82.7 % | 81.36 % | −1.3 pp | 84.28 % | **63.21 % (lỗi run A)** | 61.4 % | 57.11 % | PGDA pixel 82.7 % |
| `a3_haworth` | 32.7 % | 31.82 % | −0.9 pp | 32.57 % | 32.53 % | 40.8 % | 36.34 % | PGDA 32.6 % |
| `psr_shackleton_floor` | 0.0 % | 0.00 % | 0 | 0 % | 0 % | 0.0 % | 0 % | 0 % |

(QuickMap "Polar illumination maps" (WAC) đọc được: C1 28.0 %, Shackleton rim 57.2 %, de Gerlache rim 45.3 %, PSR 0 %. Không dùng để chấm.)

**Tiêu chí:** run B, \|Δ\| tỉ lệ đĩa ≤ **5 pp** → ĐẠT (cả 5 site đạt). Lý do chọn 5 pp: trên 30 pixel sáng, cột 2 m của backend lệch bản đồ PGDA với trung vị 3.9 pp (VALIDATION_TERRAIN.md mục 2.3; khác phiên bản DEM, pixel 60 m trung bình so với giá trị tại điểm), cộng khác giai đoạn tối đa khoảng 1.2 pp (mục 2.2).

Trái Đất của backend thấp hơn QuickMap khoảng 4 pp (đo được 3.9–4.5 pp) vì hai lý do: backend tính theo **tâm** đĩa còn PGDA tính **bất kỳ phần nào** (đĩa Trái Đất rộng khoảng 1.8–2°, nên mép trên ló lên trước tâm, và ở cực Trái Đất lên xuống rất chậm); và giai đoạn khác nhau (2026–2030 so với 18.6 năm, tối đa khoảng 1.2 pp). Chiều cao cột hầu như không ảnh hưởng % Trái Đất (C1: 58.06 % với cột 2 m, 58.08 % với cột 10 m, VALIDATION_TERRAIN.md mục 4.1); khi cùng định nghĩa "bất kỳ phần nào" và cùng 18.6 năm, cột 2 m của backend khớp PGDA trung bình 1.05 pp (mục 2.3). Cho phép tới **8 pp**. Văn liệu dao động hơn 10 pp tại cùng một điểm (tuỳ độ phân giải DEM, giai đoạn, độ cao người quan sát), nên chỉ dùng văn liệu để kiểm "cùng cỡ", không chấm chặt.

---

## 4. Các trường hợp đặc biệt

### 4.1 Mặt khuất (Chang'e-6 `change6`, Chang'e-4 `change4`): Trái Đất không bao giờ thấy

* Backend: `pct_earth = 0`, `earth.visible = false` ở mọi thời điểm. Mọi cửa sổ `earth` trong `/windows` đều `state: false`.
* Horizons: chạy Earth (399) ở `206.0148, -41.6385, 0.002` với Step 1 ngày trong 1 tháng → góc cao luôn từ khoảng −35° đến −49°, không có ký hiệu `i`. (Tháng 1/2026, bước 1 ngày từ 2026-01-01 đến 2026-02-01: −48.90 … −35.47°.)
* Mặt Trời vẫn mọc lặn bình thường: `pct_sun` khoảng 50.3 %.

### 4.2 PSR (`psr_shackleton_floor`, `psr_haworth_floor`): Mặt Trời không bao giờ thấy

* Ở cực Nam, Mặt Trời không bao giờ cao quá khoảng 2°. Chân trời trong đáy Shackleton là 19.8–23.6° ở mọi hướng, nên mép trên luôn ở dưới vách.
* Horizons vẫn in `*` (ban ngày) cho nhiều giờ, vì nó không có địa hình. Đây **không phải** lỗi backend.
* QuickMap SPOLE PSRs = 1, Sun Visibility = 0 (mục 3).

### 4.3 Xích đạo / Apollo (`apollo11`, `apollo15`, `apollo17`): chân trời phẳng

* Ngoài vùng DEM cực nên backend dùng **chân trời phẳng** (`horizon_method = flat`, `surface_height_m = 0`). `horizon_el = −0.0869°` ở mọi phương vị. Đây là độ hạ chân trời do cột 2 m: `acos(R/(R+2 m))`.
* Kỳ vọng: `pct_sun` khoảng **50 %** (50.13 %), đêm dài nhất khoảng 354 h (khoảng 14.75 ngày); `pct_earth = 100 %` (Trái Đất ở el khoảng 58–74° trong 2026–2030, không bao giờ lặn).
* Ở đây ký hiệu `*` của Horizons dùng được để kiểm mọc/lặn hình học. Vì bạn đã nhập altitude = (h + 2)/1000 km, `*` **đã gồm** độ hạ chân trời của cột 2 m (−0.0869°), nên `*` phải trùng `sun.visible` của backend ở từng giờ tại site chân trời phẳng. Ví dụ H1-b: mép trên = −0.2978 + 0.2681 = −0.0297° (dưới 0° nhưng trên −0.0869°), Horizons vẫn in `*` và backend báo thấy; H5-b tương tự (mép trên khoảng −0.079°).
* Kiểm tra thêm chỉ bằng Horizons (backend chỉ có dữ liệu 2026–2030, hỏi năm 1969 sẽ trả **HTTP 422 OUT_OF_RANGE**): Apollo 11 hạ cánh 1969-07-20 20:17:40 UTC (với ca này chọn Time digits **HH:MM:SS**) → Horizons cho Mặt Trời el = **10.703°**, az = 88.805° (tài liệu sứ mệnh: khoảng 10.8°).

### 4.4 Lỗi đã biết của run A ở site mép miệng (ĐANG ĐƯỢC SỬA)

* Ở `ref_shackleton_rim`, `ref_de_gerlache_rim`, `a3_nobile_rim_1`, **% nắng của run A SAI** (thấp quá):

  | site | run A `pct_sun` | run B `pct_sun` | QuickMap Sun Vis. |
  |---|---:|---:|---:|
  | `ref_shackleton_rim` | 54.99 % | 87.64 % | 85.5 % |
  | `ref_de_gerlache_rim` | 63.21 % | 84.28 % | 82.7 % |
  | `a3_nobile_rim_1` | 25.63 % | 28.82 % | – |

* Nguyên nhân (VALIDATION_TERRAIN.md mục 7): DEM 5 m của Moon Trek có các "u" cao 4–7 m cách site 12–60 m, nên cột 2 m bị che giả. Ví dụ `/horizon` run A của Shackleton rim có **19.06° tại az 282°**, trong khi run B chỉ có −1.65°. Ngoài ra, các file Trek `*_EQ` thưa theo phương bán kính gần cực. Bản sửa đã được kiểm (Shackleton A 55.0 → 87.0 %) nhưng **run A trên server chưa được chạy lại**.
* Khi kiểm thử: **dùng run B (mặc định)** cho mọi kết luận về % nắng ở site mép miệng. Nếu bạn thấy run A lệch ở các site này, ghi "lỗi đã biết run A", không cần báo lại. Phần thiên văn của run A (az/el/dist) vẫn đúng (mục 1).

### 4.5 Ảnh hưởng chiều cao cột (2 m)

* Đối với **hướng** Mặt Trời/Trái Đất: gần như không. Đổi độ cao vài mét làm góc cao thay đổi dưới 1e-6°. Vì vậy nhập `+2 m` vào Horizons chỉ để khớp chính xác.
* Đối với **chân trời** (quyết định thấy/không thấy): rất lớn ở cực Nam, vì Mặt Trời chỉ cao 0–1.5°:
  * Ridge C1 (DEM 20 m): người quan sát 0 m → khoảng 44 % nắng; cột 2 m → khoảng 85 %; cột 10 m → khoảng 92 % (VALIDATION_TERRAIN.md).
  * Đây là lý do văn liệu "0 m" (Gläser 76 %) thấp hơn backend (cột 2 m) và bản đồ PGDA.
* Ở site phẳng (Apollo), cột 2 m chỉ hạ chân trời 0.087°.

### 4.6 Độ chính xác thời gian ±1 h của mọc/lặn

* Mọi chuỗi đều là mẫu mỗi giờ. `/instant?t=` lấy **mẫu giờ chẵn liền trước** (`09:40` → `09:00`).
* Trong `/windows`, `end` của một cửa sổ (= `start` của cửa sổ kế) là **mẫu đầu tiên** ở trạng thái mới. Sự kiện thật nằm trong 1 giờ **trước** mốc đó (ví dụ mục 1.6: báo 17:00, thật 16:47).
* `next_events.*.at` trong `/instant` theo cùng quy ước. Ngoại lệ: nếu `state_now` đúng (ví dụ hỏi `sunrise` khi đang có nắng), `at` = đúng thời điểm `t` bạn hỏi và `hours = 0`. `hours` luôn tính từ `t` bạn nhập, không phải từ `sample_utc` (ví dụ `apollo11`, `t=2026-03-09T09:40:00Z`: `sample_utc` 09:00, `sunset.at` 10:00, `sunset.hours` = 0.333). Khi so với một nguồn có độ phân giải phút, cho phép **±1 h** (đúng hơn: sự kiện thật thuộc khoảng (at − 1 h, at]).
* `precision_h: 1` trong mọi phản hồi nhắc điều này.

### 4.7 Múi giờ

* Backend, Horizons (Time Type UT) và tài liệu này đều dùng **UTC**. Nếu bạn đọc giờ trên máy (giờ Việt Nam), hãy trừ 7 giờ. Ví dụ `2026-03-13 23:00` giờ VN = `2026-03-13 16:00 UTC`.
* Trong URL backend luôn ghi `Z` ở cuối (`2026-03-13T16:00:00Z`).

---

## 5. Mẫu bảng kết quả cho người kiểm thử

Sao chép bảng này vào báo cáo. Mỗi ca ghi một dòng. Ở ca Horizons, mỗi vật thể (Mặt Trời/Trái Đất) và mỗi đại lượng ghi một dòng.

| Ca (ID) | Công cụ | Site / thời điểm UTC | Đại lượng | Giá trị công cụ NASA | Giá trị backend (run) | Chênh lệch | Ngưỡng | Đạt / Trượt / Biên | Ghi chú |
|---|---|---|---|---|---|---|---|---|---|
| H3-d | Horizons web app | ref_shackleton_rim / 2026-03-13 16:00 | Sun el (°) | | (B) | | ≤ 0.001° | | |
| H3-d | Horizons web app | ref_shackleton_rim / 2026-03-13 16:00 | Sun visible | el + AngDiam/7200 = … vs horizon_el = … | (B) | – | phải trùng | | |
| T2 | Moon Trek | ref_shackleton_rim | độ cao (m) | | (B) / (A) | | ±5 m | | |
| T4 | Moon Trek | ref_shackleton_rim, az 30.5° | góc cao vật cản (°) | d = … m, h = … m → angle = … | (B) | | ≤ 0.1° | | |
| Q3 | QuickMap | ref_connecting_ridge_c1 | Sun Visibility (%) | | mean_power_tracking×100 (B) | | ≤ 5 pp | | |
| … | | | | | | | | | |

### Cách báo cáo khi kết quả không khớp

Gửi cho nhóm phát triển các thông tin sau:

1. **ID ca** và **URL backend đầy đủ** đã gọi, ví dụ
   `http://192.168.1.63:8000/api/v1/sites/ref_shackleton_rim/instant?t=2026-03-13T16:00:00Z&run_id=B_spice_pgda_bruteforce_2026_2030`
2. **Toàn bộ JSON trả về**: copy nguyên văn. Đặc biệt cần `run_id`, `sample_utc`, `sun`/`earth`, `warnings`.
3. **Thiết lập công cụ NASA**:
   * Horizons: copy phần đầu kết quả (các dòng `Center geodetic`, `Center pole/equ`, `Atmos refraction`, `Start time`) và dòng số liệu giữa `$$SOE`/`$$EOE`, hoặc URL API.
   * Moon Trek: ảnh chụp Elevation Chart và file CSV export, kèm toạ độ hai đầu đường.
   * QuickMap: ảnh chụp tab Inspect, kèm URL thanh địa chỉ.
4. **Bạn đã kiểm trước chưa**: kinh độ Đông 0–360 (Horizons, QuickMap) hay −180…180 (Moon Trek)? Độ cao km = (surface_height_m + 2)/1000? Giờ UTC, giờ chẵn? Run A hay B (mục 4.4)?
5. Phân loại: **lệch thiên văn** (az/el/dist, mục 1, rất nghiêm trọng vì kỳ vọng < 0.001°), **lệch địa hình** (độ cao, chân trời), hay **lệch thống kê** (% nắng/Trái Đất so với bản đồ nhiều năm).

---

*Tài liệu tham chiếu trong repo:* `docs/HORIZONS_NOTES.md` (thiết lập Horizons chính xác), `docs/OUTPUT_SPEC.md` (định nghĩa các trường), `docs/SITES.md` (toạ độ và văn liệu chiếu sáng), `docs/DATA_SOURCES.md` (sản phẩm Moon Trek/PGDA/QuickMap), `docs/VALIDATION.md`, `docs/VALIDATION_TERRAIN.md`.
