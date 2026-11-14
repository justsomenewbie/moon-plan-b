#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 LTS VPS for the lunarnav API (run as root; safe to re-run).
#
#   scp -r backend/deploy root@VPS:/root/lunarnav-deploy
#   ssh root@VPS 'bash /root/lunarnav-deploy/provision-ubuntu.sh --api-domain api.example.org --email you@example.org'
#
# Installs: Node 24 (NodeSource apt) + pm2, MongoDB 8.0 (official apt, auth + bindIp 127.0.0.1),
# Caddy (official apt, automatic HTTPS), Python venv for lunarnav, ufw (22/80/443 only).
# Creates: unix user `lunar`, /opt/lunarnav/*, MongoDB users lunarnav_admin / lunarnav_app / lunarnav_backup,
# /etc/lunarnav/{api.env, mongodump.yaml, mongorestore.yaml, mongo-admin.env}, nightly backup cron, logrotate.
# Does NOT deploy the code (deploy.sh push) or import data (import-run.sh). See docs/DEPLOY_VPS.md.
#
# Options:
#   --api-domain DOMAIN   (required) API host name; its DNS A/AAAA record must point at this VPS
#   --email EMAIL         (required) contact for Let's Encrypt / ZeroSSL
#   --app-domain DOMAIN   also serve a Next.js app (127.0.0.1:3001) same-origin on DOMAIN
#   --cors ORIGINS        comma separated CORS allow-list (default: https://APP_DOMAIN, else http://localhost:3000)
#   --user NAME           unix user owning the app (default: lunar)
#   --ssh-key FILE        public key to authorize for that user (default: copy root's authorized_keys)
#   --swap SIZE           create a swap file if none exists, e.g. 2G (helps npm ci / tsc on 2 GB VPS)
#   --skip-firewall       do not configure ufw
#   --skip-caddy          do not install Caddy (another web server, e.g. nginx, terminates HTTPS and proxies
#                         127.0.0.1:3000); --email is then optional
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR=/opt/lunarnav
ETC_DIR=/etc/lunarnav
LOG_DIR=/var/log/lunarnav
BACKUP_DIR=/var/backups/lunarnav
NODE_MAJOR=24
PM2_VERSION=7.1.2
MONGO_SERIES=8.0

API_DOMAIN=""
APP_DOMAIN=""
ACME_EMAIL=""
CORS=""
APP_USER=lunar
SSH_KEY_FILE=""
SWAP_SIZE=""
SKIP_FIREWALL=0
SKIP_CADDY=0

log() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --api-domain) API_DOMAIN="${2:-}"; shift 2 ;;
    --app-domain) APP_DOMAIN="${2:-}"; shift 2 ;;
    --email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --cors) CORS="${2:-}"; shift 2 ;;
    --user) APP_USER="${2:-}"; shift 2 ;;
    --ssh-key) SSH_KEY_FILE="${2:-}"; shift 2 ;;
    --swap) SWAP_SIZE="${2:-}"; shift 2 ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    --skip-caddy) SKIP_CADDY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ---- checks -------------------------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash $0 ...)"
[ -n "$API_DOMAIN" ] || die "--api-domain is required"
[ -n "$ACME_EMAIL" ] || [ "$SKIP_CADDY" = 1 ] || die "--email is required (or --skip-caddy)"
domain_re='^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
[[ "$API_DOMAIN" =~ $domain_re ]] || die "invalid --api-domain: $API_DOMAIN"
[ -z "$APP_DOMAIN" ] || [[ "$APP_DOMAIN" =~ $domain_re ]] || die "invalid --app-domain: $APP_DOMAIN"
[ -z "$ACME_EMAIL" ] || [[ "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die "invalid --email: $ACME_EMAIL"
[[ "$APP_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "invalid --user: $APP_USER"
if [ -z "$CORS" ]; then
  if [ -n "$APP_DOMAIN" ]; then CORS="https://$APP_DOMAIN"; else CORS="http://localhost:3000"; fi
fi
[[ "$CORS" =~ ^[A-Za-z0-9:/.,*_-]+$ ]] || die "invalid --cors: $CORS"
for f in mongod.conf Caddyfile api.env.example; do
  [ -f "$SCRIPT_DIR/$f" ] || die "missing $SCRIPT_DIR/$f (copy the whole backend/deploy directory)"
done

# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this script targets Ubuntu (found ${ID:-unknown})"
[ "${VERSION_ID:-}" = "24.04" ] || warn "tested on Ubuntu 24.04; found ${VERSION_ID:-?} (MongoDB repo uses codename ${VERSION_CODENAME:-?})"
CODENAME="${VERSION_CODENAME:?}"
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  amd64) grep -qw avx /proc/cpuinfo || die "CPU has no AVX: MongoDB >= 5.0 cannot run on this VPS" ;;
  arm64) ;;
  *) die "unsupported architecture $ARCH" ;;
esac
MEM_MB="$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)"
[ "$MEM_MB" -ge 1800 ] || warn "only ${MEM_MB} MB RAM: use --swap 2G and keep JOB_CONCURRENCY=1"

export DEBIAN_FRONTEND=noninteractive
APT_GET=(apt-get -y -o Dpkg::Options::=--force-confold)

# ---- base packages -------------------------------------------------------------------------------------
log "base packages"
"${APT_GET[@]}" update
"${APT_GET[@]}" install ca-certificates curl gnupg git unzip jq rsync ufw logrotate openssl \
  python3 python3-venv python3-dev build-essential debian-keyring debian-archive-keyring apt-transport-https
install -d -m 0755 /etc/apt/keyrings

if [ -n "$SWAP_SIZE" ]; then
  if swapon --show --noheadings | grep -q .; then
    log "swap already present - skipping --swap"
  else
    log "swap file $SWAP_SIZE"
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi

# ---- user + directories --------------------------------------------------------------------------------
log "user $APP_USER and directories"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$APP_USER"
fi
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$APP_HOME/.ssh"
AUTH_KEYS="$APP_HOME/.ssh/authorized_keys"
if [ -n "$SSH_KEY_FILE" ]; then
  [ -f "$SSH_KEY_FILE" ] || die "--ssh-key file not found: $SSH_KEY_FILE"
  touch "$AUTH_KEYS"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    grep -qxF "$key" "$AUTH_KEYS" || printf '%s\n' "$key" >> "$AUTH_KEYS"
  done < "$SSH_KEY_FILE"
elif [ ! -s "$AUTH_KEYS" ] && [ -s /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "$AUTH_KEYS"
fi
if [ -f "$AUTH_KEYS" ]; then
  chown "$APP_USER:$APP_USER" "$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"
else
  warn "no SSH key for $APP_USER yet: add one to $AUTH_KEYS before logging in as $APP_USER"
fi

for d in "$HOME_DIR" "$HOME_DIR/lunar-navigator" "$HOME_DIR/py" "$HOME_DIR/data" "$HOME_DIR/data/runs" \
  "$HOME_DIR/data/py" "$HOME_DIR/data/py-output" "$HOME_DIR/incoming" "$LOG_DIR" "$BACKUP_DIR"; do
  install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$d"
done
chmod 0750 "$BACKUP_DIR"
install -d -m 0750 -o root -g "$APP_USER" "$ETC_DIR"

# ---- firewall ------------------------------------------------------------------------------------------
if [ "$SKIP_FIREWALL" -eq 0 ]; then
  log "firewall (ssh, 80, 443 - never 27017)"
  ssh_ports="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -u)"
  [ -n "$ssh_ports" ] || ssh_ports=22
  for p in $ssh_ports; do ufw allow "$p/tcp" >/dev/null; done
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
  ufw status verbose
fi

# ---- Node 24 + pm2 ------------------------------------------------------------------------------------
log "Node.js $NODE_MAJOR (NodeSource) + pm2 $PM2_VERSION"
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs
"${APT_GET[@]}" update
"${APT_GET[@]}" install nodejs
node --version | grep -q "^v${NODE_MAJOR}\." || die "expected Node ${NODE_MAJOR}.x, got $(node --version)"
if [ "$(pm2 --version 2>/dev/null || true)" != "$PM2_VERSION" ]; then
  npm install -g --no-audit --no-fund "pm2@$PM2_VERSION"
fi

# ---- MongoDB 8.0 ---------------------------------------------------------------------------------------
log "MongoDB $MONGO_SERIES (official apt repo)"
curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_SERIES}.asc" | gpg --dearmor --yes -o "/usr/share/keyrings/mongodb-server-${MONGO_SERIES}.gpg"
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-${MONGO_SERIES}.gpg ] https://repo.mongodb.org/apt/ubuntu ${CODENAME}/mongodb-org/${MONGO_SERIES} multiverse" \
  > "/etc/apt/sources.list.d/mongodb-org-${MONGO_SERIES}.list"
"${APT_GET[@]}" update
"${APT_GET[@]}" install mongodb-org
[ -f /etc/mongod.conf.orig ] || cp /etc/mongod.conf /etc/mongod.conf.orig
install -m 0644 "$SCRIPT_DIR/mongod.conf" /etc/mongod.conf
sed -i 's/\r$//' /etc/mongod.conf
systemctl enable mongod >/dev/null
systemctl restart mongod
for _ in $(seq 1 60); do
  mongosh --quiet --norc --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1 && break
  sleep 1
done
mongosh --quiet --norc --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null || die "mongod did not start (journalctl -u mongod)"

ADMIN_ENV="$ETC_DIR/mongo-admin.env"
if [ ! -f "$ADMIN_ENV" ]; then
  log "MongoDB users (localhost exception: first user = admin)"
  MDB_ADMIN_PW="$(openssl rand -hex 24)"
  MDB_APP_PW="$(openssl rand -hex 24)"
  MDB_BACKUP_PW="$(openssl rand -hex 24)"
  export MDB_ADMIN_PW MDB_APP_PW MDB_BACKUP_PW
  js="$(mktemp)"
  chmod 600 "$js"
  cat > "$js" <<'JS'
const admin = db.getSiblingDB('admin');
admin.createUser({ user: 'lunarnav_admin', pwd: process.env.MDB_ADMIN_PW, roles: [{ role: 'root', db: 'admin' }] });
admin.auth('lunarnav_admin', process.env.MDB_ADMIN_PW);
admin.createUser({ user: 'lunarnav_app', pwd: process.env.MDB_APP_PW, roles: [{ role: 'readWrite', db: 'lunarnav' }] });
admin.createUser({ user: 'lunarnav_backup', pwd: process.env.MDB_BACKUP_PW, roles: [{ role: 'backup', db: 'admin' }] });
print('users created');
JS
  if ! mongosh --quiet --norc --file "$js"; then
    rm -f "$js"
    die "creating MongoDB users failed (users may already exist: restore $ADMIN_ENV or drop them manually)"
  fi
  rm -f "$js"
  umask 077
  printf 'MDB_ADMIN_URI=mongodb://lunarnav_admin:%s@127.0.0.1:27017/?authSource=admin\n' "$MDB_ADMIN_PW" > "$ADMIN_ENV"
  printf 'uri: mongodb://lunarnav_admin:%s@127.0.0.1:27017/?authSource=admin\n' "$MDB_ADMIN_PW" > "$ETC_DIR/mongorestore.yaml"
  printf 'uri: mongodb://lunarnav_backup:%s@127.0.0.1:27017/?authSource=admin\n' "$MDB_BACKUP_PW" > "$ETC_DIR/mongodump.yaml"
  printf 'mongodb://lunarnav_app:%s@127.0.0.1:27017/?authSource=admin\n' "$MDB_APP_PW" > "$ETC_DIR/.app-uri"
  umask 022
  chown root:root "$ADMIN_ENV" "$ETC_DIR/mongorestore.yaml" "$ETC_DIR/.app-uri"
  chmod 600 "$ADMIN_ENV" "$ETC_DIR/mongorestore.yaml" "$ETC_DIR/.app-uri"
  chown root:"$APP_USER" "$ETC_DIR/mongodump.yaml"
  chmod 640 "$ETC_DIR/mongodump.yaml"
  unset MDB_ADMIN_PW MDB_APP_PW MDB_BACKUP_PW
else
  log "MongoDB users already created ($ADMIN_ENV exists)"
fi

# ---- API environment file ------------------------------------------------------------------------------
API_ENV="$ETC_DIR/api.env"
if [ ! -f "$API_ENV" ]; then
  log "writing $API_ENV"
  [ -f "$ETC_DIR/.app-uri" ] || die "$ETC_DIR/.app-uri missing: cannot fill MONGODB_URI (edit $API_ENV by hand)"
  app_uri="$(cat "$ETC_DIR/.app-uri")"
  tpl="$(tr -d '\r' < "$SCRIPT_DIR/api.env.example")"
  tpl="${tpl//__MONGODB_URI__/"$app_uri"}"   # bash substitution: the password never appears in a process argv
  tpl="${tpl//__CORS_ORIGINS__/"$CORS"}"
  umask 027
  printf '%s\n' "$tpl" > "$API_ENV"
  umask 022
  unset tpl app_uri
  chown root:"$APP_USER" "$API_ENV"
  chmod 640 "$API_ENV"
else
  log "$API_ENV exists - not touched"
fi

# ---- Caddy ---------------------------------------------------------------------------------------------
if [ "$SKIP_CADDY" = 1 ]; then
  log "Caddy skipped (--skip-caddy): configure your own reverse proxy to 127.0.0.1:3000"
else
log "Caddy (official apt repo)"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
"${APT_GET[@]}" update
"${APT_GET[@]}" install caddy
[ -f /etc/caddy/Caddyfile.orig ] || cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
caddy_tmp="$(mktemp)"
sed -e 's/\r$//' -e "s|api\.example\.org|${API_DOMAIN}|g" -e "s|admin@example\.org|${ACME_EMAIL}|g" "$SCRIPT_DIR/Caddyfile" > "$caddy_tmp"
if [ -n "$APP_DOMAIN" ]; then
  sed -i -e 's/^#APP# //' -e "s|app\.example\.org|${APP_DOMAIN}|g" "$caddy_tmp"
fi
caddy validate --adapter caddyfile --config "$caddy_tmp" >/dev/null || die "generated Caddyfile is invalid: $caddy_tmp"
install -m 0644 "$caddy_tmp" /etc/caddy/Caddyfile
rm -f "$caddy_tmp"
# `caddy validate` ran as root and may have created the log files: give them back to the caddy user.
chown -R caddy:caddy /var/log/caddy
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

# ---- Python venv for lunarnav (the package itself is installed by deploy.sh build) ----------------------
log "Python venv $HOME_DIR/py/.venv"
if [ ! -x "$HOME_DIR/py/.venv/bin/python" ]; then
  sudo -u "$APP_USER" -H python3 -m venv "$HOME_DIR/py/.venv"
fi
sudo -u "$APP_USER" -H "$HOME_DIR/py/.venv/bin/python" -m pip install --quiet --upgrade pip setuptools wheel

# ---- pm2 at boot, logrotate, backup cron ---------------------------------------------------------------
log "pm2 systemd unit for $APP_USER"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
systemctl enable "pm2-$APP_USER" >/dev/null 2>&1 || true

cat > /etc/logrotate.d/lunarnav <<EOF
$LOG_DIR/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su $APP_USER $APP_USER
}
EOF

cat > /etc/cron.d/lunarnav-backup <<EOF
# Nightly MongoDB dump (03:17 server time), keeps 7 (backend/deploy/backup.sh)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * $APP_USER test -x $HOME_DIR/lunar-navigator/backend/deploy/backup.sh && $HOME_DIR/lunar-navigator/backend/deploy/backup.sh >> $LOG_DIR/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/lunarnav-backup

# ---- summary -------------------------------------------------------------------------------------------
log "done"
cat <<EOF
Node     $(node --version), pm2 $(pm2 --version), $(mongod --version | head -n 1), $(command -v caddy >/dev/null && caddy version | cut -d' ' -f1 || echo "caddy: skipped")
User     $APP_USER (home $APP_HOME)   App dir $HOME_DIR/lunar-navigator   Data $HOME_DIR/data
Secrets  $API_ENV (640 root:$APP_USER), $ETC_DIR/mongodump.yaml (backup user), $ADMIN_ENV + mongorestore.yaml (root only)
Domains  https://$API_DOMAIN/api/v1/health ${APP_DOMAIN:+ and https://$APP_DOMAIN (Next.js on 127.0.0.1:3001)}

Next (from your dev machine, Git Bash):
  bash backend/deploy/deploy.sh push $APP_USER@<vps-ip>
then import data on the VPS:
  bash $HOME_DIR/lunar-navigator/backend/deploy/import-run.sh $HOME_DIR/incoming/<colab-run>.zip --pick _A_ --default
EOF
