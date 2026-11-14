#!/usr/bin/env bash
# Deploy / update the lunarnav API on the VPS (see docs/DEPLOY_VPS.md).
#
#   deploy.sh push [user@]host   FROM THE DEV MACHINE (Git Bash / Linux / macOS): upload the working tree
#                                (git-tracked + untracked-not-ignored files, so no node_modules/.venv/data/
#                                output/.env) over ssh+tar, then run `deploy.sh build` on the VPS.
#   deploy.sh pull               ON THE VPS: `git pull --ff-only` in the checkout, then build.
#   deploy.sh build              ON THE VPS: npm ci + build, pip install lunarnav (if pyproject changed),
#                                pm2 startOrReload, wait for /api/v1/health.
#   deploy.sh status             ON THE VPS: pm2 status + health.
#
# Environment: LUNARNAV_HOME (default /opt/lunarnav), LUNARNAV_ENV_FILE (default /etc/lunarnav/api.env),
#              SSH_OPTS (extra ssh options for push, e.g. "-p 2222 -i ~/.ssh/id_ed25519").
set -euo pipefail

LUNARNAV_HOME="${LUNARNAV_HOME:-/opt/lunarnav}"
ENV_FILE="${LUNARNAV_ENV_FILE:-/etc/lunarnav/api.env}"
APP_DIR="$LUNARNAV_HOME/lunar-navigator"
VENV="$LUNARNAV_HOME/py/.venv"
PM2_APP=lunarnav-api

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

env_value() { # env_value KEY [default] - read KEY=value from the API env file
  local v=""
  if [ -r "$ENV_FILE" ]; then v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r')"; fi
  printf '%s' "${v:-${2:-}}"
}

health() {
  local port url body
  port="$(env_value PORT 3000)"
  url="http://127.0.0.1:${port}/api/v1/health"
  for _ in $(seq 1 30); do
    if body="$(curl -fsS --max-time 3 "$url" 2>/dev/null)"; then
      printf '%s\n' "$body"
      case "$body" in *'"status":"ok"'*) ;; *) echo "(health is degraded - check mongo/python above)" ;; esac
      return 0
    fi
    sleep 1
  done
  pm2 logs "$PM2_APP" --lines 40 --nostream || true
  die "API did not answer $url within 30 s"
}

cmd_build() {
  [ "$(id -u)" -ne 0 ] || die "run as the app user (e.g. lunar), not root"
  [ -d "$APP_DIR/backend" ] || die "$APP_DIR/backend not found (push the code first)"
  [ -r "$ENV_FILE" ] || die "$ENV_FILE not readable (run provision-ubuntu.sh)"
  local be="$APP_DIR/backend"
  # Files uploaded from Windows may carry CRLF line endings.
  find "$be/deploy" -maxdepth 1 -type f \( -name '*.sh' -o -name 'Caddyfile' -o -name '*.conf' -o -name '*.example' \) -exec sed -i 's/\r$//' {} +
  # The nightly backup cron only runs backup.sh when it is executable.
  chmod 0755 "$be"/deploy/*.sh

  log "backend: npm ci + build"
  cd "$be"
  # mongodb-memory-server is a test-only devDependency: never download its ~700 MB mongod binary here.
  MONGOMS_DISABLE_POSTINSTALL=1 npm ci --no-audit --no-fund
  rm -rf dist
  npm run build

  log "python: lunarnav in $VENV"
  [ -x "$VENV/bin/python" ] || die "venv missing: $VENV (run provision-ubuntu.sh)"
  local stamp="$VENV/.lunarnav-pyproject.sha256" want have=""
  want="$(sha256sum "$APP_DIR/pyproject.toml" | cut -d' ' -f1)"
  [ -f "$stamp" ] && have="$(cat "$stamp")"
  if [ "$want" != "$have" ]; then
    "$VENV/bin/pip" install --quiet -e "$APP_DIR"
    printf '%s\n' "$want" > "$stamp"
  fi
  "$VENV/bin/python" -c 'import lunarnav; print("lunarnav", lunarnav.__version__)'

  log "pm2: start or reload $PM2_APP"
  LUNARNAV_ENV_FILE="$ENV_FILE" pm2 startOrReload "$be/deploy/ecosystem.config.cjs" --update-env
  pm2 save >/dev/null

  log "health"
  health
}

cmd_pull() {
  [ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout (clone it, or use: deploy.sh push from the dev machine)"
  log "git pull --ff-only"
  git -C "$APP_DIR" pull --ff-only
  git -C "$APP_DIR" log -1 --oneline
  cmd_build
}

cmd_status() {
  pm2 status
  health
}

cmd_push() {
  local target="${1:-}"
  [ -n "$target" ] || die "usage: deploy.sh push [user@]host"
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$root is not a git work tree"
  local -a ssh_opts=()
  # shellcheck disable=SC2206 # intentional word splitting of user-supplied ssh options
  [ -z "${SSH_OPTS:-}" ] || ssh_opts=(${SSH_OPTS})

  local n
  n="$(git -C "$root" ls-files --cached --others --exclude-standard | wc -l | tr -d ' ')"
  log "upload $n files from $root to $target:$APP_DIR"
  # --cached + --others --exclude-standard = what git would commit (honours .gitignore: no node_modules,
  # .venv, data/, output/, dist/, .env). Deleted files are not removed on the VPS (dist/ is rebuilt).
  (cd "$root" && git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do
    [ -f "$f" ] && printf '%s\0' "$f"
  done) | tar -C "$root" --null -T - -czf - |
    ssh ${ssh_opts[@]+"${ssh_opts[@]}"} "$target" "mkdir -p '$APP_DIR' && tar -xzf - -C '$APP_DIR' --no-same-owner"

  log "remote build"
  ssh ${ssh_opts[@]+"${ssh_opts[@]}"} "$target" "sed -i 's/\r\$//' '$APP_DIR/backend/deploy/deploy.sh' && LUNARNAV_HOME='$LUNARNAV_HOME' bash '$APP_DIR/backend/deploy/deploy.sh' build"
}

case "${1:-}" in
  push) shift; cmd_push "$@" ;;
  pull) cmd_pull ;;
  build) cmd_build ;;
  status) cmd_status ;;
  -h | --help | "") usage ;;
  *) die "unknown command: $1 (push | pull | build | status)" ;;
esac
