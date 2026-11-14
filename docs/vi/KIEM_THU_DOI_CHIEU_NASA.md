# Phiếu kiểm thử: so kết quả backend với công cụ NASA

**Dành cho:** người kiểm thử, không cần biết lập trình.
**Cách làm:** mở công cụ NASA, làm theo các bước, đọc con số và ghi vào ô trống. Sau đó so với **số của backend đã ghi sẵn**.
**Thời gian:** khoảng 45–60 phút cho cả 8 ca.

Công cụ dùng:

| Công cụ | Địa chỉ | Dùng để kiểm |
|---|---|---|
| JPL Horizons | https://ssd.jpl.nasa.gov/horizons/app.html | Mặt Trời và Trái Đất nằm ở hướng nào, cao bao nhiêu độ |
| LROC QuickMap | https://quickmap.lroc.asu.edu/ (tự chuyển sang quickmap.lroc.im-ldi.com) | Độ cao mặt đất, % có nắng, hố tối vĩnh viễn |
| NASA Moon Trek | https://trek.nasa.gov/moon/ | Độ cao mặt đất (1 ca) |

## Đọc trước 4 điều

1. **Mọi giờ đều là giờ UTC.** Giờ Việt Nam = UTC + 7. Bạn cứ gõ đúng giờ ghi trong phiếu, không cần đổi.
2. **Toạ độ đã ghi sẵn đúng kiểu mà từng công cụ cần.** Bạn chỉ việc copy và dán.
3. **Số trên màn hình dùng dấu chấm** (ví dụ `36.929`). Phiếu này cũng ghi số theo dấu chấm cho dễ so.
4. **Số backend** lấy từ server thử nghiệm ngày 14/11/2026, run mặc định **B**. Khi số chỉ lệch rất nhỏ (nằm trong mức "Đạt nếu" của từng ca), đó là bình thường, không phải lỗi.

---

## Phần 1. JPL Horizons (4 ca)

### Thiết lập một lần (khoảng 5 phút)

Mở https://ssd.jpl.nasa.gov/horizons/app.html. Trang có 5 mục xếp từ trên xuống.

1. **Ephemeris Type**: chọn **Observer Table**.
2. **Table Settings → Edit**:
   * Bấm nút **None** để bỏ hết các ô đang tick.
   * Tick đúng **một** ô: **4. Apparent AZ & EL**.
   * Kéo xuống phần *Additional Table Settings*:
     * Angle format: **decimal degrees**
     * Refraction model: **no refraction (airless)**
     * Tick **Extra precision**
   * Các mục còn lại để nguyên. Bấm **Use Specified Settings**.

Thiết lập này được giữ lại cho các ca sau. Mỗi ca chỉ cần đổi 3 mục: **Target Body**, **Observer Location** và **Time Specification**.

**Cách nhập Observer Location** (ca nào cũng làm giống nhau):
1. Bấm **Edit** ở mục Observer Location.
2. *Choose a method*: chọn **Specify Coordinates**.
3. *Coordinate Body*: bấm **change** → kéo danh sách, chọn **[id:301] Moon** → **Select Indicated Body**.
4. *Type of coordinates*: chọn **Geodetic Coordinates**. Đơn vị: **kilometers**.
5. Gõ **longitude**, **latitude** và **altitude** theo phiếu → bấm **Use Specified Coordinates**.

**Cách nhập Time Specification:** bấm **Edit**, gõ **Start time**, **Stop time** và **Step size** theo phiếu → bấm **Use Specified Time Span**.

Cuối cùng bấm **Generate Ephemeris**. Bảng kết quả nằm giữa hai dòng `$$SOE` và `$$EOE`. Mỗi dòng có dạng:

```
 2026-Mar-13 16:00 *    36.929480953  -0.214169914
 ^ ngày giờ        ^ dấu * = Mặt Trời đang trên đường chân trời
                        ^ HƯỚNG (độ)   ^ ĐỘ CAO (độ)
```

* **Hướng** (Azimuth): 0 = Bắc, 90 = Đông, 180 = Nam, 270 = Tây.
* **Độ cao** (Elevation): số dương là trên đường chân trời, số âm là dưới.

---

### Ca H-1. Mặt Trời nhìn từ mép miệng hố Shackleton

*Mục đích: backend tính hướng Mặt Trời có đúng như NASA không.*

| Nhập vào Horizons | |
|---|---|
| Target Body | gõ `Sun` → chọn **Sun [Sol] (10)** |
| longitude / latitude / altitude | `203.97` / `-89.7849` / `1.73925` |
| Start / Stop / Step | `2026-03-13 16:00` / `2026-03-13 17:00` / `1` hours |

Đọc **dòng 16:00**:

| | Horizons (bạn ghi) | Backend (ghi sẵn) | Đạt nếu |
|---|---|---|---|
| Hướng (độ) | ............ | **36.929481** | chênh ≤ 0.001 |
| Độ cao (độ) | ............ | **−0.214170** | chênh ≤ 0.001 |

Kết quả: ☐ Đạt ☐ Không đạt

### Ca H-2. Trái Đất nhìn từ cùng chỗ đó

*Mục đích: kiểm tương tự H-1, nhưng với Trái Đất.*

Giữ nguyên Observer Location và thời gian của ca H-1. Chỉ đổi **Target Body**: gõ `399` → chọn **Earth (399)** → **Generate Ephemeris**.

Đọc **dòng 16:00**:

| | Horizons (bạn ghi) | Backend (ghi sẵn) | Đạt nếu |
|---|---|---|---|
| Hướng (độ) | ............ | **151.844305** | chênh ≤ 0.001 |
| Độ cao (độ) | ............ | **−5.754085** | chênh ≤ 0.001 |

Kết quả: ☐ Đạt ☐ Không đạt

### Ca H-3. Hoàng hôn ở bãi đáp Apollo 11

*Mục đích: backend báo Mặt Trời lặn ở Apollo 11 trong khoảng 09:00–10:00 UTC ngày 9/3/2026. NASA có cho kết quả như vậy không?*

| Nhập vào Horizons | |
|---|---|
| Target Body | **Sun [Sol] (10)** |
| longitude / latitude / altitude | `23.47314` / `0.67416` / `0.002` |
| Start / Stop / Step | `2026-03-09 09:00` / `2026-03-09 10:00` / `1` hours |

| Dòng | Có dấu `*` không? (bạn ghi) | Độ cao (bạn ghi) | Backend (ghi sẵn) |
|---|---|---|---|
| 09:00 | ☐ có ☐ không | ............ | **còn nắng**, độ cao −0.297791 |
| 10:00 | ☐ có ☐ không | ............ | **đã tối**, độ cao −0.804677 |

**Đạt nếu:** dòng 09:00 **có** `*`, dòng 10:00 **không có** `*`, và độ cao chênh ≤ 0.001.

Ở 09:00, độ cao âm mà vẫn còn nắng là đúng. Lý do: Mặt Trời là một cái đĩa, mép trên của nó vẫn còn ló lên khỏi đường chân trời.

Kết quả: ☐ Đạt ☐ Không đạt

### Ca H-4. Mặt khuất của Mặt Trăng (bãi đáp Chang'e-6): không bao giờ thấy Trái Đất

*Mục đích: backend báo ở đây thấy Trái Đất **0 %** thời gian. Kiểm xem Trái Đất có luôn nằm dưới chân trời không.*

| Nhập vào Horizons | |
|---|---|
| Target Body | **Earth (399)** |
| longitude / latitude / altitude | `206.0148` / `-41.6385` / `0.002` |
| Start / Stop / Step | `2026-01-01 00:00` / `2026-02-01 00:00` / `1` days |

Nhìn cột **độ cao** của cả 32 dòng.

| | Bạn ghi | Backend (ghi sẵn) |
|---|---|---|
| Độ cao cao nhất trong tháng | ............ | khoảng **−35.47** |
| Độ cao thấp nhất trong tháng | ............ | khoảng **−48.90** |
| Có dòng nào độ cao dương không? | ☐ có ☐ không | **không** (thấy Trái Đất 0 %) |

**Đạt nếu:** mọi dòng đều có độ cao âm.

Kết quả: ☐ Đạt ☐ Không đạt

---

## Phần 2. LROC QuickMap (3 ca, đọc cùng một chỗ)

### Thao tác (làm một lần cho 5 điểm)

1. Mở https://quickmap.lroc.asu.edu/. Trang sẽ tự chuyển sang `quickmap.lroc.im-ldi.com`. Đóng hộp thông báo bằng dấu **×**.
2. Ở ô tìm kiếm góc trên bên trái, dán toạ độ của điểm (cột "Gõ vào QuickMap" ở bảng dưới) → chọn **Create Point at …**.
3. Bảng **Object Inspector** mở ra bên phải. Chọn tab **Inspect**.
4. **Chỉ làm ở điểm đầu tiên:** bấm **Sources**, tìm và tick 3 nguồn sau. Đóng danh sách, rồi chờ vài giây cho số hiện ra.
   * **LOLA 80S 20M ADJ DEM** (độ cao)
   * **Sun Visibility 60m** (% nắng)
   * **SPOLE PSRs (80S to 90S)** (hố tối vĩnh viễn)
5. Đọc 3 dòng đó và ghi vào bảng các ca Q-1, Q-2, Q-3. Làm lại bước 2–5 cho điểm tiếp theo. Các nguồn đã tick sẽ được giữ, không phải tick lại.

| Điểm | Mô tả | Gõ vào QuickMap |
|---|---|---|
| P1 | Sống núi nối Shackleton (điểm C1) | `-89.4505,222.84` |
| P2 | Mép miệng hố Shackleton | `-89.7849,203.97` |
| P3 | Mép miệng hố de Gerlache | `-88.6646,291.6044` |
| P4 | Vùng Haworth (Artemis III) | `-86.752966,336.328186` |
| P5 | Đáy hố Shackleton (tối vĩnh viễn) | `-89.67,129.78` |

### Ca Q-1. Độ cao mặt đất

*Đọc dòng `LOLA 80S 20M ADJ DEM` (đơn vị mét).*

| Điểm | QuickMap (bạn ghi) | Backend (ghi sẵn) | Đạt nếu |
|---|---|---|---|
| P1 | ............ | **1957.3** | chênh ≤ 5 m |
| P2 | ............ | **1737.3** | chênh ≤ 5 m |
| P3 | ............ | **1815.2** | chênh ≤ 5 m |
| P4 | ............ | **1556.4** | chênh ≤ 5 m |
| P5 | ............ | **−2788.9** | chênh ≤ 5 m |

Lúc thử, chúng tôi đo được chênh lệch không quá 1.1 m ở cả 5 điểm.

Kết quả: ☐ Đạt ☐ Không đạt

### Ca Q-2. Hố tối vĩnh viễn

*Đọc dòng `SPOLE PSRs`. Số 1 nghĩa là chỗ đó tối vĩnh viễn, số 0 nghĩa là không.*

| Điểm | QuickMap PSR (bạn ghi) | Backend (ghi sẵn) |
|---|---|---|
| P5 (đáy hố) | ............ | **nắng 0 %**, tối liên tục cả 5 năm 2026–2030 |
| P2 (mép hố, để đối chứng) | ............ | **nắng khoảng 88 %** |

**Đạt nếu:** P5 = 1 và P2 = 0.

Kết quả: ☐ Đạt ☐ Không đạt

### Ca Q-3. Mức nắng trung bình

*Đọc dòng `Sun Visibility 60m`. Số hiện ở dạng 0–1, bạn nhân 100 để ra %. Ví dụ `0.864` → **86.4 %**.*

| Điểm | QuickMap % (bạn ghi) | Backend % (ghi sẵn) | Đạt nếu |
|---|---|---|---|
| P1 | ............ | **85.6** | chênh ≤ 5 |
| P2 | ............ | **83.2** | chênh ≤ 5 |
| P3 | ............ | **81.4** | chênh ≤ 5 |
| P4 | ............ | **31.8** | chênh ≤ 5 |
| P5 | ............ | **0** | chênh ≤ 5 |

Lúc thử, chúng tôi đo được chênh lệch từ 0.8 đến 2.3 điểm.

**Vì sao không bắt trùng khít?** Bản đồ của NASA là trung bình **18.6 năm**, còn backend tính cho **2026–2030**. Hai bên cũng dùng bản đồ địa hình hơi khác nhau. Vì vậy lệch vài điểm là bình thường.

> Lưu ý: số backend ở đây là "**trung bình bao nhiêu phần đĩa Mặt Trời được chiếu tới**", cùng kiểu đo với QuickMap. Nó **không phải** con số "% giờ có nắng" trên giao diện web (ví dụ P1 là 90.25 %). Con số trên giao diện luôn cao hơn vài điểm, vì chỉ cần mép Mặt Trời ló lên là đã tính là có nắng.

Kết quả: ☐ Đạt ☐ Không đạt

---

## Phần 3. NASA Moon Trek (1 ca)

### Ca T-1. Độ cao tại điểm C1

*Mục đích: kiểm độ cao mặt đất bằng một công cụ thứ hai. C1 nằm trên đỉnh sống núi bằng phẳng, nên đặt chuột lệch một chút cũng không sao.*

1. Mở https://trek.nasa.gov/moon/ → bấm **Skip Tutorial**.
2. Chuyển sang bản đồ cực Nam: bấm biểu tượng **quả cầu** ở góc **dưới bên trái** → **Projections** → **South Pole Map**.
3. Bay tới điểm: bấm biểu tượng **máy bay** ở góc dưới bên phải → dán `-89.4505, -137.16` vào ô `Lat, Lon` → Enter.
   (Moon Trek chỉ nhận kinh độ từ −180 đến 180. Nếu ô chuyển màu đỏ là bạn gõ sai kinh độ.)
4. Phóng to bằng nút **+** vài lần. Toạ độ dưới con trỏ chuột hiện ở góc dưới bên phải. Hãy rê chuột tới đúng chỗ có `Lat: -89.450…, Lon: -137.16…`.
5. Bấm menu **☰** ở góc trên bên phải → **Calculate Elevation Profile** → **Line**. **Nhấn giữ chuột tại điểm đó**, kéo ra khoảng 1–2 cm rồi thả → bấm **Submit**.
6. Một biểu đồ hiện ra, có nhiều đường. Rê chuột vào **điểm đầu tiên bên trái** (Distance = 0) của đường **"LRO LOLA DEM 75 deg"** và đọc số Elevation (mét).

| | Moon Trek (bạn ghi) | Backend (ghi sẵn) | Đạt nếu |
|---|---|---|---|
| Độ cao (m) | ............ | **1957.3** | chênh ≤ 3 m |

Lúc thử, chúng tôi đọc được Moon Trek **1958.0** trên đường 75 deg (30 m) và **1957.5** trên đường 87.5 deg (5 m).

Kết quả: ☐ Đạt ☐ Không đạt

---

## Bảng tổng kết (điền rồi gửi lại cho nhóm)

| Ca | Nội dung | Đạt / Không đạt | Ghi chú |
|---|---|---|---|
| H-1 | Hướng Mặt Trời ở Shackleton | | |
| H-2 | Hướng Trái Đất ở Shackleton | | |
| H-3 | Hoàng hôn Apollo 11 | | |
| H-4 | Mặt khuất không thấy Trái Đất | | |
| Q-1 | Độ cao 5 điểm (QuickMap) | | |
| Q-2 | Hố tối vĩnh viễn | | |
| Q-3 | Mức nắng trung bình | | |
| T-1 | Độ cao C1 (Moon Trek) | | |

**Nếu một ca không đạt**, gửi cho nhóm 3 thứ:
1. Mã ca (ví dụ H-1).
2. Ảnh chụp màn hình công cụ NASA, chụp cả chỗ đã nhập lẫn con số đã đọc.
3. Con số bạn đọc được.

Trước khi báo, bạn tự kiểm lại 3 điều:
* Đã dán đúng toạ độ trong phiếu chưa?
* Đã gõ đúng giờ UTC trong phiếu chưa (không phải giờ Việt Nam)?
* Ở Horizons, đã chọn đúng Sun hoặc Earth chưa?

---

*Muốn kiểm sâu hơn (cách tính góc che của núi, giải thích kỹ thuật)? Xem `../VALIDATION.md` và `../VALIDATION_TERRAIN.md` (tiếng Anh). Bản tiếng Anh của phiếu này: `../NASA_TOOLS_CROSSCHECK.md`.*
