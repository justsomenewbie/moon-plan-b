# Deploy backend lên Linux VPS qua SSH (runbook)

> Stack: **Ubuntu 24.04 LTS + Node 24 (NodeSource) + MongoDB 8.0 (apt chính thức, auth, bindIp 127.0.0.1) +
> Python venv (lunarnav) + pm2 + reverse proxy HTTPS**. Không Docker. Kế hoạch gốc: `docs/vi/WEB_BACKEND_PLAN.md` §10.
> Reverse proxy có hai cách:
> - **nginx + certbot sau Cloudflare** (đang dùng ở production, xem bảng dưới): VPS đã có nginx phục vụ landing page.
> - **Caddy** (HTTPS tự động): cách thay thế khi **VPS chưa có web server khác**.
>
> Mọi script nằm trong `backend/deploy/`, chạy được lại nhiều lần (idempotent).
> Mục có nhãn **[cập nhật 14/11]** đã được sửa theo đúng cấu hình production ngày 2026-11-14.

### Production hiện tại (2026-11-14) [cập nhật 14/11]

| Mục | Giá trị |
|---|---|
| VPS | Ubuntu 24.04, 6 vCPU, 5,8 GB RAM, swap 2 GB, IP `<VPS_IP>` |
| Domain | `lunavigator.com` trên **Cloudflare** (proxied, đám mây cam) |
| Landing page | `https://lunavigator.com`, nginx (cài bởi `setup.sh` riêng của landing, không thuộc repo này) |
| API | `https://api.lunavigator.com` → nginx (`backend/deploy/nginx-api.conf`) → `127.0.0.1:3000` (pm2 `lunarnav-api`) |
| HTTPS origin | Let's Encrypt qua `certbot --nginx` (HTTP-01 đi qua proxy Cloudflare); Cloudflare SSL mode **Full (strict)** |
| Firewall | **không bật ufw** (cố ý, `--skip-firewall`): MongoDB và API chỉ nghe `127.0.0.1` (§1.1) |
| Auth | `API_KEYS=fe:<key>,team:<key>` + Basic auth `/docs` trong `/etc/lunarnav/api.env` (§1.3) |
| Run mặc định | `B2_spice_pgda_bruteforce_2026_2030_fix676af9d` (run B sau bản sửa terrain O2/O4, commit `676af9d`); run A từ Colab thêm sau, không mặc định (§4) |
| Dữ liệu offline | SPICE kernels + cache PGDA + 3 DEM Moon Trek (~4,6 GB) trong `/opt/lunarnav/data/py` (§3) |
| SSH deploy | key `~/.ssh/lunavigator_vps` (ed25519, comment `lunavigator-deploy`), được phép cho `root` và `lunar` (§2.1) |

| File | Chạy ở đâu | Việc |
|---|---|---|
| `provision-ubuntu.sh` | VPS, **root**, một lần | cài Node 24 + pm2 7.1.2, MongoDB 8.0, Caddy (trừ khi `--skip-caddy`), Python venv, ufw (trừ khi `--skip-firewall`); tạo user `lunar`, thư mục, user MongoDB, file bí mật, cron backup, logrotate |
| `setup-nginx-api.sh <domain> [email]` | VPS, **root** | **[cập nhật 14/11]** đặt API sau nginx có sẵn: real IP Cloudflare, site nginx, `certbot --nginx`, kiểm tra proxy |
| `nginx-api.conf` | `/etc/nginx/sites-available/<domain>` | **[cập nhật 14/11]** mẫu site nginx cho API (SSE không buffer) |
| `deploy.sh push <user@host>` | máy dev (Git Bash) | đóng gói code (theo `.gitignore`) qua `ssh + tar` rồi build trên VPS |
| `deploy.sh pull` / `build` / `status` | VPS, user `lunar` | `git pull` + build / chỉ build / trạng thái |
| `import-run.sh <zip\|dir>` | VPS, user `lunar` | giải nén output Colab (hoặc nhận thư mục run) + chạy importer vào MongoDB |
| `backup.sh` | VPS (cron 03:17 hằng đêm) | `mongodump` + giữ 7 bản |
| `ecosystem.config.cjs` | pm2 | 1 process `lunarnav-api` (fork), env từ `/etc/lunarnav/api.env` |
| `Caddyfile` | `/etc/caddy/Caddyfile` | **chỉ cách Caddy**: reverse proxy `/api/*` + `/docs`, tuỳ chọn Next.js same-origin |
| `mongod.conf` | `/etc/mongod.conf` | `bindIp: 127.0.0.1`, `authorization: enabled` |
| `api.env.example` | `/etc/lunarnav/api.env` | mẫu env production (provision điền MongoDB/CORS; khoá API phải tự điền, §1.3) |

Bố cục trên VPS **[cập nhật 14/11]**:
```
/opt/lunarnav/lunar-navigator/       checkout repo (lunarnav Python + backend/)
/opt/lunarnav/py/.venv/              Python venv (lunarnav cài editable từ checkout)
/opt/lunarnav/data/runs/<run_id>/    bản gốc precompute đã import (DATA_DIR)
/opt/lunarnav/data/py/               LUNARNAV_DATA của Python:
    kernels/                           SPICE kernels (provider=spice, offline)
    cache/                             cache HTTP/Horizons + mảnh PGDA (cache/pgda)
    dem/                               3 DEM Moon Trek cực nam (~4,6 GB, dem=trek, offline)
/opt/lunarnav/fetch_trek.py          script tải DEM Trek trên VPS (log: /opt/lunarnav/fetch_trek.log)
/opt/lunarnav/incoming/              zip Colab / thư mục run tải lên + bản giải nén
/etc/lunarnav/api.env                env của API (640 root:lunar), có API_KEYS + DOCS_*
/etc/lunarnav/mongodump.yaml         URI user backup (640 root:lunar)
/etc/lunarnav/mongo-admin.env, mongorestore.yaml   URI admin (600, chỉ root)
/root/lunarnav-credentials.txt       bản sao khoá API + tài khoản docs (chỉ root)
/etc/nginx/sites-available/api.lunavigator.com     site nginx của API (symlink trong sites-enabled/)
/etc/nginx/conf.d/cloudflare-realip.conf           dải IP Cloudflare + real_ip_header CF-Connecting-IP
/var/log/lunarnav/                   log API (pm2) + backup
/var/backups/lunarnav/               bản mongodump
```

Trong các lệnh dưới: `VPS` = IP hoặc tên máy (production: `<VPS_IP>`), `api.example.org` = domain API
(production: `api.lunavigator.com`), `$KEY` = một khoá API hợp lệ (§1.3). Chạy lệnh "máy dev" trong **Git Bash** tại
`<repo>` (`cd <repo>`).

---

## 0. Chuẩn bị [cập nhật 14/11]

| Cần | Kiểm tra |
|---|---|
| VPS Ubuntu 24.04 x86_64 (hoặc arm64), quyền root qua SSH key | `ssh root@VPS 'lsb_release -ds; uname -m'` |
| CPU có **AVX** (MongoDB ≥ 5.0 bắt buộc trên x86_64) | `ssh root@VPS 'grep -c avx /proc/cpuinfo'` > 0 |
| RAM ≥ 2 GB (khuyến nghị 4 GB nếu chạy job custom), đĩa trống ≥ 10 GB (**+5 GB** nếu tải DEM Trek, §3) | `ssh root@VPS 'free -h; df -h /'` |
| Domain (hoặc subdomain) có bản ghi **A/AAAA trỏ về IP VPS**. Production: domain trên Cloudflare, bản ghi `api` **proxied** (đám mây cam) | `nslookup api.example.org` (qua Cloudflare sẽ ra IP của Cloudflare, bình thường) |
| Cổng 80 + 443 không bị chặn bởi firewall của nhà cung cấp (certbot/Caddy cần cổng 80) | |
| Máy dev: Git Bash (có `ssh`, `scp`, `tar`), SSH key (`ssh-keygen -t ed25519` nếu chưa có; production dùng `~/.ssh/lunavigator_vps`, §2.1) | `ssh -V` |

Nếu chưa có domain: vẫn chạy được (bỏ reverse proxy/HTTPS), xem §9 "Không có domain".

---

## 1. Provision VPS (một lần, root) [cập nhật 14/11]

Máy dev (copy thư mục script lên VPS):
```bash
scp -r backend/deploy root@VPS:/root/lunarnav-deploy
```

### 1.1 Production: VPS đã có nginx (landing page) + Cloudflare

```bash
ssh root@VPS 'bash /root/lunarnav-deploy/provision-ubuntu.sh --api-domain api.lunavigator.com --skip-caddy --skip-firewall --swap 2G'
```
- `--skip-caddy`: không cài Caddy (nginx đã chiếm cổng 80/443); khi đó `--email` không bắt buộc. Reverse proxy làm ở §2.2.
- `--skip-firewall`: **cố ý** không bật ufw, để không chặn nhầm SSH hay landing page đang chạy. An toàn vì MongoDB
  (`bindIp 127.0.0.1`) và API (`HOST=127.0.0.1`) chỉ nghe trên loopback; kiểm tra bằng `ss -ltnp` (dưới).
- Bật ufw sau này một cách an toàn: **mở cổng trước, bật sau** (nếu SSH chạy cổng khác 22 thì mở cổng đó):
  ```bash
  sshd -T | grep '^port '                 # cổng SSH thật
  ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
  ufw --force enable && ufw status verbose
  ```
  Giữ phiên SSH hiện tại mở và thử `ssh` một phiên mới trước khi thoát. Không mở 27017 và 3000.

### 1.2 Cách thay thế: VPS chưa có web server khác (Caddy)

```bash
ssh root@VPS 'bash /root/lunarnav-deploy/provision-ubuntu.sh --api-domain api.example.org --email you@example.org --swap 2G'
```
Caddy tự lấy chứng chỉ HTTPS cho `api.example.org` (DNS phải trỏ thẳng về VPS hoặc qua proxy cho phép HTTP-01). Bỏ qua §2.2.

Tuỳ chọn chung:
- `--app-domain app.example.org`: (chỉ cách Caddy) Next.js cũng chạy trên VPS này (cổng `127.0.0.1:3001`), cùng origin với API → không cần CORS.
- `--cors https://my-fe.vercel.app`: danh sách origin được phép (mặc định `https://APP_DOMAIN`, không có thì `http://localhost:3000`).
- `--ssh-key /root/key.pub`: key cho user `lunar` (mặc định copy `authorized_keys` của root).
- `--user NAME`, `--skip-firewall`, `--skip-caddy`. Xem hết: `bash provision-ubuntu.sh --help`.

Script làm (theo thứ tự): kiểm tra Ubuntu/AVX/RAM → gói cơ bản (git, unzip, jq, python3-venv, build-essential…) →
swap (nếu xin) → user `lunar` + thư mục → **ufw** (chỉ SSH, 80, 443; **không mở 27017**; bỏ qua nếu `--skip-firewall`) →
Node 24 từ NodeSource + pm2 7.1.2 → MongoDB 8.0 từ repo `repo.mongodb.org` + `/etc/mongod.conf` → tạo 3 user MongoDB với
mật khẩu ngẫu nhiên (`lunarnav_admin` root, `lunarnav_app` readWrite chỉ DB `lunarnav`, `lunarnav_backup` role backup) →
`/etc/lunarnav/api.env` → Caddy từ repo chính thức + `Caddyfile` đã thay domain/email (`caddy validate` trước khi cài;
bỏ qua nếu `--skip-caddy`) → Python venv `/opt/lunarnav/py/.venv` → pm2 systemd unit cho `lunar` → logrotate → cron backup.

Kiểm tra sau provision:
```bash
ssh lunar@VPS 'node -v; pm2 -v; mongod --version | head -1; systemctl is-active mongod'
ssh lunar@VPS 'caddy version; systemctl is-active caddy'                    # chỉ cách Caddy
ssh root@VPS 'ufw status; ss -ltnp | grep -E ":(27017|3000|80|443) "'      # 27017 và 3000 chỉ ở 127.0.0.1
```
Mật khẩu MongoDB **không** in ra màn hình; chúng chỉ nằm trong `/etc/lunarnav/*` (xem bằng `sudo cat`). Chạy lại
provision không đổi mật khẩu và không ghi đè `api.env` đã có.

### 1.3 `api.env`: khoá API, mật khẩu docs, giới hạn (bắt buộc trước §2) [cập nhật 14/11]

Provision **không** tạo khoá API. Với `NODE_ENV=production`, API **từ chối khởi động** (`ConfigError: Invalid
configuration`, xem `pm2 logs`) nếu thiếu `API_KEYS`, thiếu `DOCS_USER`/`DOCS_PASSWORD`, khoá ngắn hơn 32 ký tự hoặc
mật khẩu docs ngắn hơn 12 ký tự (`backend/src/config.ts`).

Tạo khoá trên VPS (root):
```bash
openssl rand -hex 32                    # 64 ký tự hex
echo "lnv_fe_$(openssl rand -hex 24)"   # hoặc dạng có tiền tố, 55 ký tự
openssl rand -hex 16                    # mật khẩu docs
```
Sửa `/etc/lunarnav/api.env` (root, `nano`; giá trị không ngoặc kép, không dấu cách, không `#`):
```
API_KEYS=fe:<khoá FE>,team:<khoá team>
DOCS_USER=<tên>
DOCS_PASSWORD=<>= 12 ký tự>
```
- Mỗi cặp `tên:khoá`; `tên` hiện trong log (trường `client`) và là khoá rate limit. `fe` = server proxy của frontend,
  `team` = thành viên/tester gọi trực tiếp.
- Mọi route `/api/v1/*` trừ `GET /api/v1/health` cần header `X-API-Key: <khoá>` (hoặc `Authorization: Bearer <khoá>`);
  thiếu hoặc sai khoá đều trả `401 UNAUTHORIZED`. `/docs` và `/api/v1/openapi.json` dùng HTTP Basic (`DOCS_USER`/`DOCS_PASSWORD`).
- Bản sao chỉ-root của các giá trị này: `/root/lunarnav-credentials.txt` (`chmod 600`). Cập nhật file này mỗi khi đổi khoá;
  nên lưu thêm vào trình quản lý mật khẩu của nhóm.

**Đổi (rotate) một khoá:**
1. Tạo khoá mới, sửa dòng `API_KEYS` (muốn không gián đoạn: thêm tạm `fe2:<khoá mới>` bên cạnh `fe:<khoá cũ>`).
2. `ssh lunar@VPS 'pm2 reload lunarnav-api'` (env được đọc lại khi process khởi động qua `node --env-file`).
3. Báo FE cập nhật khoá (biến môi trường server của FE), rồi xoá khoá cũ khỏi `API_KEYS` và `pm2 reload` lần nữa.
4. Cập nhật `/root/lunarnav-credentials.txt`.

**Giới hạn cho FE dùng server-side proxy.** FE gọi API từ server của nó (khoá không xuống trình duyệt), nên **mọi người
dùng FE chung một khoá (`fe`) và một IP** (IP server FE). Rate limit tính theo tên khoá; giới hạn job/SSE/dung lượng tính
theo IP client (IPv6 gộp /64). Giá trị mặc định (dành cho từng người dùng riêng lẻ) sẽ chặn cả FE sau vài người, nên
production đặt:

| Biến | Production | Mặc định | Vì sao |
|---|---|---|---|
| `RATE_LIMIT_MAX` | `3000` | 300 | request/phút của **cả** khoá `fe` (tất cả người dùng FE cộng lại) |
| `RATE_LIMIT_POST_MAX` | `120` | 5 | POST/phút (tạo job) của cả FE; 5 chỉ hợp với một người |
| `JOB_CONCURRENCY` | `2` | 1 | 6 vCPU / 5,8 GB đủ cho 2 process Python song song; nhiều hơn dễ thiếu RAM |
| `JOB_MAX_ACTIVE_PER_CLIENT` | `6` | 2 | job đang chờ/chạy của "một client" = cả FE; vẫn nhỏ hơn `JOB_QUEUE_MAX=20` để client khác còn chỗ |
| `SSE_MAX_PER_CLIENT` | `50` | 5 | mỗi trang FE đang theo dõi job mở một stream SSE qua proxy |
| `JOB_RUNS_MAX_PER_CLIENT` | `100` | 20 | run custom còn hạn của cả FE; tổng toàn server vẫn bị chặn bởi `JOB_RUNS_MAX_TOTAL=200` / `JOB_RUNS_MAX_MB` |

Nếu FE gọi `/api/v1/tools/*` nhiều, cân nhắc tăng `RATE_LIMIT_TOOLS_MAX` (mặc định 30/phút). Sửa xong:
`pm2 reload lunarnav-api` (user `lunar`); mọi biến được zod kiểm lúc khởi động (sai → process thoát, xem `pm2 logs`).

---

## 2. Đưa code lên và build [cập nhật 14/11]

**Cách A: push từ máy dev** (không cần GitHub; dùng được khi repo chưa có remote). Production:
```bash
SSH_OPTS="-i ~/.ssh/lunavigator_vps" bash backend/deploy/deploy.sh push lunar@<VPS_IP>
# tổng quát: bash backend/deploy/deploy.sh push lunar@VPS
# SSH khác cổng / key khác: SSH_OPTS="-p 2222 -i ~/.ssh/id_ed25519" bash backend/deploy/deploy.sh push lunar@VPS
```
Gói gồm các file git đang theo dõi + file chưa track nhưng không bị ignore → **không** có `node_modules`, `.venv`,
`data/`, `output/`, `dist/`, `.env`. File đã xoá ở máy dev không bị xoá trên VPS (vô hại; `dist/` luôn build lại).

**Cách B: git trên VPS** (khi repo có remote):
```bash
ssh lunar@VPS 'git clone <repo-url> /opt/lunarnav/lunar-navigator'   # lần đầu; thư mục phải rỗng
ssh lunar@VPS 'bash /opt/lunarnav/lunar-navigator/backend/deploy/deploy.sh pull'
```
Repo private: tạo deploy key (read-only) cho user `lunar` trên VPS (`ssh-keygen -t ed25519`, thêm `.pub` vào repo).

Cả hai cách đều chạy `deploy.sh build` trên VPS: đổi CRLF→LF cho script → `npm ci` (với `MONGOMS_DISABLE_POSTINSTALL=1`:
không tải binary MongoDB ~700 MB của test) → `npm run build` (`dist/`) → `pip install -e` lunarnav vào venv (chỉ khi
`pyproject.toml` đổi) → `pm2 startOrReload backend/deploy/ecosystem.config.cjs` + `pm2 save` → đợi `/api/v1/health`.
Nếu `api.env` chưa có khoá (§1.3), bước đợi health sẽ thất bại với `ConfigError` trong log.

### 2.1 SSH key deploy [cập nhật 14/11]

Production dùng key riêng `~/.ssh/lunavigator_vps` (ed25519, comment `lunavigator-deploy`) trên máy dev, được thêm vào
`/root/.ssh/authorized_keys` và `/home/lunar/.ssh/authorized_keys`. Tiện dùng: thêm vào `~/.ssh/config` của máy dev
```
Host lunavigator
    HostName <VPS_IP>
    IdentityFile ~/.ssh/lunavigator_vps
    IdentitiesOnly yes
```
Thu hồi key (máy dev bị mất / người rời nhóm), chạy bằng một key **khác** còn hiệu lực hoặc console của nhà cung cấp VPS:
```bash
ssh root@VPS "sed -i '/ lunavigator-deploy\$/d' /root/.ssh/authorized_keys /home/lunar/.ssh/authorized_keys"
```
Trước khi thu hồi, chắc chắn đã có key khác đăng nhập được, nếu không sẽ tự khoá mình ra ngoài.

### 2.2 Reverse proxy nginx + Cloudflare (production) [cập nhật 14/11]

Bỏ qua mục này nếu dùng Caddy (§1.2). Trên VPS, root, **sau khi** API đã chạy ở `127.0.0.1:3000` (§2):
```bash
bash /opt/lunarnav/lunar-navigator/backend/deploy/setup-nginx-api.sh api.lunavigator.com [email]
# hoặc bản đã scp: bash /root/lunarnav-deploy/setup-nginx-api.sh api.lunavigator.com [email]
```
Script (chạy lại được):
1. Cài `nginx`, `certbot` + `python3-certbot-nginx` nếu thiếu.
2. Ghi `/etc/nginx/conf.d/cloudflare-realip.conf`: các dải IP từ `cloudflare.com/ips-v4|v6` (`set_real_ip_from`) +
   `real_ip_header CF-Connecting-IP` → nginx biết IP thật của client và chuyển cho API qua `X-Forwarded-For`
   (API `trustProxy: loopback`). Tải lỗi thì giữ file cũ.
3. Ghi site `/etc/nginx/sites-available/api.lunavigator.com` từ `nginx-api.conf` (symlink vào `sites-enabled/`):
   `/` → 302 `/docs`; `location ~ /api/v1/jobs/<id>/events` (SSE) với `proxy_buffering off`, `proxy_read_timeout 1h`;
   mọi thứ khác proxy tới `127.0.0.1:3000` với timeout 180 s. `nginx -t` lỗi → khôi phục cấu hình cũ.
4. `certbot --nginx -d <domain> --redirect --keep-until-expiring` (không có email thì `--register-unsafely-without-email`).
   HTTP-01 chạy được qua proxy Cloudflare. Certbot lỗi → chỉ cảnh báo, API tạm ở HTTP.
5. Kiểm tra `http://127.0.0.1:3000/api/v1/health` và proxy HTTPS (`curl --resolve <domain>:443:127.0.0.1`).

Cloudflare (dashboard của `lunavigator.com`):
- DNS: bản ghi `A api → <VPS_IP>`, **Proxied**.
- SSL/TLS mode: **Full (strict)** khi origin đã có chứng chỉ (sau bước 4). Không dùng **Flexible**: nginx đã
  `--redirect` HTTP→HTTPS nên Flexible gây vòng lặp redirect.
- Cloudflare cắt request nếu origin không trả lời trong **100 s** → `HTTP 524`. Lệnh đồng bộ dài (tools, alt-dates,
  nginx cho phép tới 180 s) có thể dính 524: việc dài nên chạy bằng job (`POST /api/v1/jobs` + poll/SSE). SSE không bị
  ảnh hưởng (header gửi ngay, `: ping` mỗi 15 s).
- Cloudflare nén response tới client → giữ `COMPRESS=false` trong `api.env`.

Gia hạn chứng chỉ: timer `certbot.timer` của gói certbot (`systemctl list-timers | grep certbot`;
thử: `certbot renew --dry-run`).

### 2.3 Kiểm tra sức khoẻ / smoke test [cập nhật 14/11]

```bash
ssh lunar@VPS 'bash /opt/lunarnav/lunar-navigator/backend/deploy/deploy.sh status'
curl -s https://api.lunavigator.com/api/v1/health                               # không cần khoá; "mongo":{"ok":true...}
curl -s -o /dev/null -w '%{http_code}\n' https://api.lunavigator.com/api/v1/runs  # 401 (thiếu khoá)
curl -s -H "X-API-Key: $KEY" https://api.lunavigator.com/api/v1/runs | jq '.runs[] | {run_id, label, status, is_default}'
curl -s -H "X-API-Key: $KEY" https://api.lunavigator.com/api/v1/dataset | head -c 300; echo
curl -s -o /dev/null -w '%{http_code}\n' https://api.lunavigator.com/docs        # 401 (hỏi Basic auth)
curl -sL -o /dev/null -w '%{http_code}\n' -u "$DOCS_USER:$DOCS_PASSWORD" https://api.lunavigator.com/docs  # 200
```
`default_run_id` = `null` cho tới khi import (§4). Cách Caddy: lần đầu truy cập HTTPS có thể mất ~10–30 s để Caddy lấy
chứng chỉ (`journalctl -u caddy -f`).

---

## 3. Dữ liệu cho Python (job toạ độ tuỳ chỉnh, alt-dates) [cập nhật 14/11]

**Chế độ online (mặc định từ 14/11).** Job, precompute và `/tools/ephemeris` mặc định dùng `provider=horizons`
(JPL Horizons API) và `dem=pgda` (đọc mảnh LOLA PGDA qua HTTP, lưu vào cache). Vì vậy VPS **phải ra được Internet**
tới `ssd.jpl.nasa.gov` và `pgda.gsfc.nasa.gov`. Kiểm tra ngay sau khi cài:
```bash
curl -sI https://ssd.jpl.nasa.gov/api/horizons.api | head -1
curl -sI https://pgda.gsfc.nasa.gov/ | head -1
```
Dữ liệu không lấy online được (hoặc để chạy offline) được **lưu sẵn trên VPS** trong `LUNARNAV_DATA=/opt/lunarnav/data/py`:
`provider=spice` và `dem=trek` chạy hoàn toàn offline từ các file này.

| Dữ liệu | Cách dùng | Trên VPS production |
|---|---|---|
| JPL Horizons | gọi API online (mặc định) | không cần file |
| PGDA LOLA DEM | đọc mảnh online (mặc định), cache trong `cache/pgda` | cache đã copy từ máy dev (`cache/`) |
| SPICE kernels | offline, `provider=spice` | `kernels/` (~46 MB) |
| Moon Trek DEM | offline, `dem=trek` | `dem/`: 3 file cực nam, ~4,6 GB, **tải trực tiếp trên VPS** |
| Kết quả run A/B | import vào MongoDB | §4 |

Đo thử trên máy dev (14/11): một toạ độ mới chưa có cache, 7 ngày, Horizons + PGDA online → **91 s**. Cùng điểm C1
đã có cache, 2 ngày → **8 s**. JPL hoặc PGDA sập, hay VPS mất mạng → job báo `502 PYTHON_FAILED`. Khi đó gửi lại job
với `provider=spice` (và `dem=trek`), còn các route đọc dữ liệu đã tính sẵn vẫn chạy bình thường.

**Kernels + cache PGDA**: copy từ máy dev để job đầu tiên nhanh (~10 s). Máy dev:
```bash
du -sh data/kernels data/cache/pgda          # dev hiện tại: ~46 MB + ~342 MB
tar -C data -czf - kernels cache/pgda | ssh lunar@VPS 'mkdir -p /opt/lunarnav/data/py && tar -xzf - -C /opt/lunarnav/data/py'
```
(`LUNARNAV_DATA=/opt/lunarnav/data/py` trong `api.env`; Node truyền biến này cho process Python.)

**DEM Moon Trek**: tải thẳng trên VPS (nhanh hơn upload 4,6 GB từ máy dev) bằng `/opt/lunarnav/fetch_trek.py`, script
gọi `lunarnav.terrain.trek.download_product` cho 3 sản phẩm `TREK_SOUTH_PRODUCTS` (`lunarnav/precompute.py`) với
`LUNARNAV_ALLOW_LARGE_DOWNLOADS=1` (file > 100 MB bị từ chối nếu thiếu biến này). Mỗi file được kiểm size với catalogue
và ghi SHA-256 vào `<file>.json`; chạy lại thì bỏ qua file đã đủ. Log: `/opt/lunarnav/fetch_trek.log`. Chạy lại / tiếp tục:
```bash
ssh lunar@VPS 'cd /opt/lunarnav && LUNARNAV_DATA=/opt/lunarnav/data/py LUNARNAV_ALLOW_LARGE_DOWNLOADS=1 \
  nohup /opt/lunarnav/py/.venv/bin/python /opt/lunarnav/fetch_trek.py >> /opt/lunarnav/fetch_trek.log 2>&1 &'
ssh lunar@VPS 'tail -n 20 /opt/lunarnav/fetch_trek.log; ls -lh /opt/lunarnav/data/py/dem'
```

Kiểm tra Python trên VPS:
```bash
ssh lunar@VPS '/opt/lunarnav/py/.venv/bin/python -m lunarnav.cli --help | head -3'
```

---

## 4. Import output precompute [cập nhật 14/11]

### 4.0 Production: run mặc định B2

Run mặc định là thư mục `B2_spice_pgda_bruteforce_2026_2030_fix676af9d` (run B: SPICE + PGDA bruteforce 2026–2030, tính
lại sau bản sửa terrain O2/O4, commit `676af9d`). Thư mục run (có `manifest.json`) được copy lên `/opt/lunarnav/incoming/`
rồi import trực tiếp (không cần zip). Máy dev:
```bash
tar -C output -czf - B2_spice_pgda_bruteforce_2026_2030_fix676af9d | \
  ssh -i ~/.ssh/lunavigator_vps lunar@<VPS_IP> 'tar -xzf - -C /opt/lunarnav/incoming'
```
Trên VPS (user `lunar`):
```bash
cd /opt/lunarnav/lunar-navigator/backend/deploy
bash import-run.sh /opt/lunarnav/incoming/B2_spice_pgda_bruteforce_2026_2030_fix676af9d --dry-run
bash import-run.sh /opt/lunarnav/incoming/B2_spice_pgda_bruteforce_2026_2030_fix676af9d --default \
  --label "2026-2030 B: SPICE + PGDA bruteforce (fix 676af9d)" --stats
```
(Đường dẫn nguồn trên máy dev và nhãn ở trên là ví dụ; nhãn hiển thị cho FE trong `/runs`.)
**Run A** từ Colab (Horizons + Trek raymarch) sẽ thêm sau theo §4.1–4.2 **không** kèm `--default`, để B2 vẫn là mặc định.

### 4.1 Lấy zip từ Colab
Notebook `notebooks/lunar_navigator_colab.ipynb` bước 14 ghi `MyDrive/lunarnav/exports/<RUN_NAME>.zip`, bên trong:
```
<RUN_NAME>/<RUN_NAME>_A_horizons_trek_raymarch/    run A (primary)      -> có manifest.json
<RUN_NAME>/<RUN_NAME>_B_spice_pgda_bruteforce/     run B (cross-check)  -> có manifest.json
<RUN_NAME>/<RUN_NAME>_validation/                  báo cáo validation (không import)
<RUN_NAME>/RUN_INFO.json
```
Tải zip từ Google Drive về máy dev (trình duyệt), rồi kiểm tra nhanh:
```bash
unzip -l ~/Downloads/<RUN_NAME>.zip | grep manifest.json
sha256sum ~/Downloads/<RUN_NAME>.zip          # so với sha256 notebook in ra ở bước 14
```

### 4.2 Copy lên VPS và import
```bash
scp ~/Downloads/<RUN_NAME>.zip lunar@VPS:/opt/lunarnav/incoming/
ssh lunar@VPS
# --- trên VPS (user lunar) ---
cd /opt/lunarnav/lunar-navigator/backend/deploy
bash import-run.sh /opt/lunarnav/incoming/<RUN_NAME>.zip --pick _A_ --dry-run                      # chỉ kiểm tra
# production: run A KHÔNG làm mặc định (B2 là mặc định, §4.0)
bash import-run.sh /opt/lunarnav/incoming/<RUN_NAME>.zip --pick _A_ --label "2026-2030 A: Horizons + Trek raymarch" --stats
# VPS mới chưa có run nào: thêm --default vào lệnh của run muốn làm mặc định
bash import-run.sh /opt/lunarnav/incoming/<RUN_NAME>.zip --pick _B_ --label "2026-2030 B: SPICE + PGDA bruteforce"
```
- Script giải nén vào `/opt/lunarnav/incoming/<RUN_NAME>/` (từ chối zip có đường dẫn `..`/tuyệt đối), tìm mọi thư mục
  có `manifest.json` (lọc bằng `--pick`), rồi chạy importer `backend/scripts/import-run.ts` cho từng run. Nguồn là thư
  mục (như §4.0) thì không giải nén.
- Importer: chặn nếu `python -m lunarnav.cli check` báo vi phạm hoặc sha256 trong manifest không khớp → `run_id =
  pf_<params_fingerprint>` → copy thư mục vào `DATA_DIR/runs/<run_id>/` → ghi MongoDB (series dạng time-series, ~1 triệu
  document cho 23 site × 5 năm) → hậu kiểm số lượng. Chạy lại với cùng manifest = bỏ qua (idempotent).
- `--default`: run này thành run mặc định (FE không gửi `run_id`). Đổi run mặc định sau này: import lại run đó với `--default`.
- `--force` **chỉ** khi chắc chắn: bỏ qua cổng kiểm tra `lunarnav check` / checksum và import lại cả run không đổi.
- Import xong có thể xoá bản giải nén: `rm -rf /opt/lunarnav/incoming/<RUN_NAME>` (bản dùng thật nằm ở `DATA_DIR/runs/`).
- Dữ liệu mẫu nhỏ để thử (máy dev): `tar -C output -czf - sample_2026Q1_spice_pgda | ssh lunar@VPS 'tar -xzf - -C /opt/lunarnav/incoming'`
  rồi `bash import-run.sh /opt/lunarnav/incoming/sample_2026Q1_spice_pgda --default`.

Kiểm tra (cần khoá API, §1.3):
```bash
curl -s -H "X-API-Key: $KEY" https://api.example.org/api/v1/runs | jq '.runs[] | {run_id, label, status, is_default}'
curl -s -H "X-API-Key: $KEY" 'https://api.example.org/api/v1/ranking' | jq '.ranking[0:3][] | {rank, site_id, score}'
```

### 4.3 Cách khác: chuyển DB đã import trên Windows (mongodump → mongorestore)
Dùng khi đã import trên máy dev và không muốn import lại. Phải copy **cả** `backend/data/runs/` (file gốc dùng cho tải
file thô và alt-dates). Máy dev (PowerShell hoặc Git Bash; Database Tools: `winget install -e --id MongoDB.DatabaseTools`):
```bash
"/c/Program Files/MongoDB/Tools/100/bin/mongodump.exe" --uri=mongodb://127.0.0.1:27017 --db=lunarnav_dev --archive=lunarnav_dev.archive.gz --gzip
scp lunarnav_dev.archive.gz lunar@VPS:/opt/lunarnav/incoming/
tar -C backend/data -czf - runs | ssh lunar@VPS 'tar -xzf - -C /opt/lunarnav/data'
ssh root@VPS "mongorestore --config=/etc/lunarnav/mongorestore.yaml --archive=/opt/lunarnav/incoming/lunarnav_dev.archive.gz --gzip --nsFrom='lunarnav_dev.*' --nsTo='lunarnav.*' --drop"
ssh lunar@VPS 'pm2 reload lunarnav-api'
```
Ghi chú: run tạo bởi job trên máy dev (`job_*`) cũng đi theo; `source_dir` trong DB vẫn trỏ đường dẫn Windows nhưng API
đọc file ở `DATA_DIR/runs/<run_id>/` khi thư mục đó có `manifest.json` (`runDirectory()` trong
`backend/src/python/runFiles.ts`; `source_dir` chỉ dùng cho run import `--no-copy`) → bắt buộc copy `backend/data/runs/`
như lệnh `tar` ở trên. Kiểm tra sau restore:
`curl -sI -H "X-API-Key: $KEY" https://api.example.org/api/v1/runs/<run_id>/files/manifest.json` phải là `200`. Run import
`--no-copy` trên Windows **không** chuyển được kiểu này (import lại trên VPS). Cách này **chưa được chạy thử** với collection
time-series `series` khi đổi tên DB (`--nsFrom/--nsTo`); nếu `mongorestore` báo lỗi ở `series`, dùng cách §4.2 (import lại
trên VPS, kết quả như nhau).

---

## 5. Nối Frontend [cập nhật 14/11]

- **Production: FE gọi qua server-side proxy.** Server của FE (route handler / Server Components) giữ khoá `fe` trong biến
  môi trường **server** (không dùng tiền tố `NEXT_PUBLIC_`), gửi `X-API-Key` tới `https://api.lunavigator.com`; trình duyệt
  chỉ nói chuyện với FE nên không cần CORS cho luồng này (vẫn để `CORS_ORIGINS` khác rỗng). Vì mọi người dùng FE chung một
  khoá và một IP, giới hạn ở §1.3 đã được nâng. Đổi khoá: §1.3.
- **FE ở nơi khác gọi thẳng từ trình duyệt (Vercel, máy dev)**: sửa `CORS_ORIGINS` (phân cách bằng dấu phẩy, không dấu cách)
  rồi restart. Lưu ý khoá API khi đó lộ ra trình duyệt; chỉ dùng cho dev/demo.
  ```bash
  ssh root@VPS "sed -i 's|^CORS_ORIGINS=.*|CORS_ORIGINS=https://my-fe.vercel.app,http://localhost:3001|' /etc/lunarnav/api.env"
  ssh lunar@VPS 'pm2 reload lunarnav-api'      # env đọc lại khi process khởi động (node --env-file)
  ```
  FE đặt `NEXT_PUBLIC_API_ORIGIN=https://api.example.org` (xem `docs/vi/FE_INTEGRATION.md` §9).
- **Next.js trên cùng VPS (same-origin, chỉ cách Caddy)**: provision với `--app-domain app.example.org` (hoặc bỏ tiền tố
  `#APP# ` trong `/etc/caddy/Caddyfile`, thay domain, `sudo systemctl reload caddy`). Build app Next.js và chạy ở `127.0.0.1:3001`:
  ```bash
  # trên VPS, user lunar, trong thư mục app Next.js
  npm ci && npm run build
  pm2 start npm --name lunarnav-web -- start -- -p 3001 -H 127.0.0.1 && pm2 save
  ```
  Caddy gửi `/api/*`, `/docs` thẳng tới backend (3000) và mọi thứ khác tới Next.js (3001): FE gọi `/api/v1/...` cùng origin.
  Server Components trên VPS dùng `API_INTERNAL_URL=http://127.0.0.1:3000`. (Với nginx cần tự viết site tương tự.)

---

## 6. Cập nhật (deploy lại) và rollback [cập nhật 14/11]

```bash
SSH_OPTS="-i ~/.ssh/lunavigator_vps" bash backend/deploy/deploy.sh push lunar@<VPS_IP>   # cách A (production)
ssh lunar@VPS 'bash /opt/lunarnav/lunar-navigator/backend/deploy/deploy.sh pull'              # cách B
```
`pm2 reload` khởi động lại process API (vài giây gián đoạn với 1 instance; request đang chạy được đóng êm trong 10 s).
Job Python đang chạy lúc restart → `failed` (`SERVER_RESTARTED`), người dùng gửi lại.

Rollback:
- Cách B: `ssh lunar@VPS 'cd /opt/lunarnav/lunar-navigator && git checkout <commit-cũ> && bash backend/deploy/deploy.sh build'`
  (quay về nhánh: `git checkout main && bash backend/deploy/deploy.sh pull`).
- Cách A: checkout commit cũ ở máy dev (`git stash; git checkout <commit>`), `deploy.sh push`, rồi quay lại.

Đổi file cấu hình hệ thống sau khi sửa trong repo:
- `nginx-api.conf` (production) → deploy code rồi chạy lại `setup-nginx-api.sh api.lunavigator.com` (root; giữ chứng chỉ,
  certbot chèn lại khối 443).
- `Caddyfile` (cách Caddy) → chạy lại provision (giữ nguyên bí mật) hoặc
  `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.
- `mongod.conf` → `sudo systemctl restart mongod`.

---

## 7. Backup và restore

- Cron `/etc/cron.d/lunarnav-backup` chạy `backend/deploy/backup.sh` lúc 03:17 mỗi đêm (giờ VPS) với user `lunar`:
  `/var/backups/lunarnav/lunarnav-<UTC>.archive.gz` (mongodump DB `lunarnav`, user `lunarnav_backup`) + `job-runs-<UTC>.tar.gz`
  (thư mục output của job custom). Giữ 7 bản mỗi loại. Log: `/var/log/lunarnav/backup.log`.
- Chạy tay: `ssh lunar@VPS 'bash /opt/lunarnav/lunar-navigator/backend/deploy/backup.sh --keep 7'`.
- Kéo bản backup về máy dev (nên làm định kỳ, backup trên cùng VPS không chống được mất VPS):
  `scp 'lunar@VPS:/var/backups/lunarnav/lunarnav-*.archive.gz' backups/`
- Run precompute **không** cần backup riêng: dựng lại được từ zip Colab / thư mục run + `import-run.sh`.
- Kernels / cache / DEM Trek trong `/opt/lunarnav/data/py` không nằm trong backup: tải lại được (§3).

Restore (ghi đè các collection có trong bản backup):
```bash
ssh root@VPS
sudo -u lunar -H pm2 stop lunarnav-api
mongorestore --config=/etc/lunarnav/mongorestore.yaml --archive=/var/backups/lunarnav/lunarnav-<UTC>.archive.gz --gzip --drop --nsInclude='lunarnav.*'
sudo -u lunar -H tar -xzf /var/backups/lunarnav/job-runs-<UTC>.tar.gz -C /opt/lunarnav/data/runs      # nếu có
sudo -u lunar -H pm2 start lunarnav-api
```

---

## 8. Vận hành hằng ngày [cập nhật 14/11]

| Việc | Lệnh (trên VPS) |
|---|---|
| Trạng thái + health | `bash /opt/lunarnav/lunar-navigator/backend/deploy/deploy.sh status` |
| Log API | `pm2 logs lunarnav-api` · file: `/var/log/lunarnav/api.{out,err}.log` (logrotate 14 ngày) |
| Log nginx (production) | `/var/log/nginx/api.lunavigator.com.{access,error}.log`, `journalctl -u nginx`, `nginx -t` |
| Log Caddy (cách Caddy) | `/var/log/caddy/lunarnav-api.log`, `journalctl -u caddy` |
| Log MongoDB | `journalctl -u mongod`, `/var/log/mongodb/mongod.log` |
| Restart API | `pm2 reload lunarnav-api` (`api.env` được đọc lại mỗi lần process khởi động qua `node --env-file`) |
| Đổi khoá API | §1.3 (sửa `API_KEYS` → `pm2 reload lunarnav-api` → báo FE → cập nhật `/root/lunarnav-credentials.txt`) |
| Process Python mồ côi sau restart | `pgrep -af lunarnav` (không nên còn gì khi không có job) |
| Dung lượng | `du -sh /opt/lunarnav/data/* /opt/lunarnav/data/py/* /var/backups/lunarnav`; `mongosh` (admin): `db.getSiblingDB('lunarnav').stats()` |
| Mở mongosh (admin) | `sudo bash -c '. /etc/lunarnav/mongo-admin.env && mongosh "$MDB_ADMIN_URI"'` |
| Compass từ máy dev | `ssh -N -L 27018:127.0.0.1:27017 lunar@VPS` rồi kết nối `mongodb://lunarnav_admin:<pw>@127.0.0.1:27018/?authSource=admin` |
| Đổi tham số (rate limit, job) | sửa `/etc/lunarnav/api.env` (root) → `pm2 reload lunarnav-api`; mọi biến được kiểm bằng zod lúc khởi động (sai → process thoát, xem `pm2 logs`) |

Các biến production quan trọng (`/etc/lunarnav/api.env`): `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3000`,
`MONGODB_URI` (user `lunarnav_app`), `MONGODB_DB=lunarnav`, `CORS_ORIGINS`, `PYTHON_BIN=/opt/lunarnav/py/.venv/bin/python`,
`LUNARNAV_ROOT=/opt/lunarnav/lunar-navigator`, `LUNARNAV_DATA=/opt/lunarnav/data/py`, `DATA_DIR=/opt/lunarnav/data`,
`API_KEYS`, `DOCS_USER`, `DOCS_PASSWORD` (§1.3), `JOB_CONCURRENCY=2`, `JOB_TIMEOUT_S=1200`, `RATE_LIMIT_MAX=3000`,
`RATE_LIMIT_POST_MAX=120`, `JOB_MAX_ACTIVE_PER_CLIENT=6`, `SSE_MAX_PER_CLIENT=50`, `JOB_RUNS_MAX_PER_CLIENT=100`
(lý do: §1.3; mặc định trong `api.env.example` thấp hơn), `COMPRESS=false` (Cloudflare/Caddy nén).

---

## 9. Sự cố thường gặp [cập nhật 14/11]

Lỗi hay gặp ở production (nginx + Cloudflare):

| Triệu chứng | Nguyên nhân / cách sửa |
|---|---|
| `401 UNAUTHORIZED` | thiếu/sai header `X-API-Key` (mọi route trừ `/api/v1/health`); `/docs` thì thiếu Basic auth. Kiểm tra khoá với `API_KEYS` (§1.3) |
| `502 Bad Gateway` (trang nginx) | API không chạy: `pm2 status`, `pm2 logs lunarnav-api --lines 100` (lỗi env zod in rõ tên biến) |
| Cloudflare `521` / `522` | Cloudflare không tới được origin: nginx dừng (`systemctl status nginx`), VPS sập, hoặc firewall (ufw / nhà cung cấp) chặn 80/443 |
| Cloudflare `525` / `526` | lỗi SSL giữa Cloudflare và origin: SSL mode Full/Full (strict) nhưng origin chưa có chứng chỉ hợp lệ trên 443 → chạy lại `setup-nginx-api.sh` (certbot), `certbot certificates` |
| Cloudflare `524` | origin trả lời quá 100 s (giới hạn proxy Cloudflare): lệnh đồng bộ dài → dùng job + poll/SSE (§2.2) |
| `ConfigError: Invalid configuration` lúc khởi động | thiếu `API_KEYS` / `DOCS_USER` / `DOCS_PASSWORD`, khoá < 32 ký tự hoặc mật khẩu docs < 12 ký tự → sửa `api.env` (§1.3), `pm2 reload lunarnav-api` |
| `setup-nginx-api.sh`: certbot thất bại | DNS `api` chưa trỏ đúng (bản ghi A trên Cloudflare), cổng 80 bị chặn, hoặc Cloudflare "Always Use HTTPS" + Full (strict) chặn HTTP-01 lần đầu → tạm chuyển bản ghi sang DNS only (đám mây xám) hoặc tắt "Always Use HTTPS", chạy lại script, rồi bật lại. Log: `/var/log/letsencrypt/letsencrypt.log` |
| Cloudflare vòng lặp redirect (`ERR_TOO_MANY_REDIRECTS`) | SSL mode đang là Flexible → đổi sang Full (strict) |

Lỗi chung:

| Triệu chứng | Nguyên nhân / cách sửa |
|---|---|
| `provision`: "CPU has no AVX" | VPS không chạy được MongoDB ≥ 5.0 → đổi gói VPS |
| `mongod` không chạy sau provision | `journalctl -u mongod -n 50`; thiếu RAM → bật `cacheSizeGB` trong `/etc/mongod.conf` (có sẵn dòng comment) |
| Caddy không lấy được chứng chỉ (cách Caddy) | DNS chưa trỏ đúng IP / cổng 80, 443 bị chặn ở firewall của nhà cung cấp; `journalctl -u caddy -f` |
| `deploy.sh build`: `npm ci` bị kill | thiếu RAM khi build → provision lại với `--swap 2G` |
| Health `"status":"degraded"`, `mongo.ok:false` | sai `MONGODB_URI` trong `api.env` hoặc mongod dừng (`systemctl status mongod`) |
| 502 từ Caddy (cách Caddy) | API không chạy: `pm2 status`, `pm2 logs lunarnav-api --lines 100` |
| `429 TOO_MANY_JOBS` / `TOO_MANY_STREAMS` / `RATE_LIMITED` với FE | giới hạn theo client bị cả FE dùng chung → xem bảng giới hạn §1.3 |
| Trình duyệt báo lỗi CORS | origin của FE không có trong `CORS_ORIGINS` (phải khớp tuyệt đối: scheme + host + port) → §5 |
| `import-run.sh`: `REFUSED: lunarnav check failed` | output Colab lỗi/thiếu file → xem các dòng `VIOLATION:`; chạy lại notebook hoặc copy lại zip |
| Job custom luôn `failed` | `GET /api/v1/jobs/<id>` → `error.message`; thường là Python không tải được tile DEM (VPS không có Internet) → §3 |
| Không có domain | bỏ reverse proxy: đặt `HOST=0.0.0.0` trong `api.env`, `sudo ufw allow 3000/tcp`, gọi `http://VPS:3000` (không HTTPS; chỉ để demo) |

---

## 10. Checklist bảo mật [cập nhật 14/11]
- [ ] Đăng nhập SSH bằng key; sau khi `ssh lunar@VPS` chạy được, cân nhắc tắt mật khẩu/đăng nhập root
      (`PasswordAuthentication no`, `PermitRootLogin prohibit-password` trong `/etc/ssh/sshd_config`).
- [ ] Key deploy `lunavigator-deploy` chỉ nằm trên máy cần deploy; biết cách thu hồi (§2.1).
- [ ] `ss -ltnp`: **27017 và 3000 chỉ ở 127.0.0.1**. ufw hiện tắt có chủ đích; nếu bật thì chỉ SSH, 80, 443 (§1.1).
- [ ] `API_KEYS`, `DOCS_USER`, `DOCS_PASSWORD` đã đặt (production không khởi động nếu thiếu); `/root/lunarnav-credentials.txt` quyền 600.
- [ ] Khoá `fe` chỉ nằm trong env server của FE, không xuống trình duyệt.
- [ ] Cloudflare SSL mode Full (strict); `nginx -t` sạch; `certbot renew --dry-run` chạy được.
- [ ] MongoDB có `authorization: enabled`; API dùng user `lunarnav_app` (readWrite chỉ DB `lunarnav`).
- [ ] `/etc/lunarnav/api.env` quyền 640 `root:lunar`; `mongo-admin.env`, `mongorestore.yaml` quyền 600 root.
- [ ] Không commit `.env` / bí mật; `deploy.sh push` không gửi `.env` của máy dev.
- [ ] Rate limit bật (production 3000/phút, POST 120/phút cho mỗi khoá); hàng đợi job tối đa 20; job timeout 20 phút.
- [ ] Backup chạy (`ls -l /var/backups/lunarnav`) và có bản sao ngoài VPS.
