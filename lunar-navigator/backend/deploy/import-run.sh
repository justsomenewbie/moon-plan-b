#!/usr/bin/env bash
# Import a Colab precompute output into the VPS database (run as the app user, e.g. lunar).
#
#   import-run.sh <colab-run.zip | precompute-dir> [--pick TEXT] [--default] [--label TEXT] [--dry-run] [--stats]
#                 [--force]
#
# A Colab zip (notebook step 14) holds <RUN_NAME>/<RUN_NAME>_A_<provider>_<dem>_<method>/ (+ _B_..., _validation/);
# every directory containing manifest.json is a precompute run (docs/OUTPUT_SPEC.md).
# For each run directory (optionally only those whose name contains --pick TEXT) this runs the backend
# importer (backend/scripts/import-run.ts, plan section 8), which:
#   - gates on `python -m lunarnav.cli check <dir>` and the manifest sha256 list,
#   - uses run_id = pf_<params_fingerprint>, skips a run already imported with the same manifest,
#   - copies the directory to DATA_DIR/runs/<run_id>/ (kept: raw downloads + alt-dates bridge read it),
#   - fills MongoDB and verifies the counts.
# --default   marks the FIRST selected run as the default run (used when the FE omits run_id)
# --force     DANGEROUS: imports even when `lunarnav check` or the checksums fail, and re-imports unchanged runs
# --dry-run   parse + validate everything, write nothing
#
# Environment: LUNARNAV_HOME (default /opt/lunarnav), LUNARNAV_ENV_FILE (default /etc/lunarnav/api.env)
set -euo pipefail

LUNARNAV_HOME="${LUNARNAV_HOME:-/opt/lunarnav}"
ENV_FILE="${LUNARNAV_ENV_FILE:-/etc/lunarnav/api.env}"
BACKEND="$LUNARNAV_HOME/lunar-navigator/backend"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }

SRC=""
PICK=""
LABEL=""
MAKE_DEFAULT=0
FORCE=0
DRY=0
STATS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pick) PICK="${2:?--pick needs a value}"; shift 2 ;;
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --default) MAKE_DEFAULT=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --stats) STATS=1; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$SRC" ] || die "only one source"; SRC="$1"; shift ;;
  esac
done
[ -n "$SRC" ] || die "usage: import-run.sh <colab-run.zip | precompute-dir> [options] (--help)"
[ -e "$SRC" ] || die "not found: $SRC"
[ "$(id -u)" -ne 0 ] || die "run as the app user (sudo -u lunar -H ...), not root: files in DATA_DIR must belong to it"
[ -r "$ENV_FILE" ] || die "$ENV_FILE not readable"

IMPORTER="$BACKEND/scripts/import-run.ts"
[ -f "$IMPORTER" ] || die "importer not found: $IMPORTER (deploy the backend first: deploy.sh push)"

# ---- 1. unpack a zip into incoming/ ----------------------------------------------------------------------
case "$SRC" in
  *.zip)
    command -v unzip >/dev/null || die "unzip not installed"
    if unzip -Z1 "$SRC" | grep -Eq '(^/|^\\|(^|/)\.\.(/|$))'; then die "unsafe paths in $SRC"; fi
    base="$(basename "$SRC" .zip)"
    ROOT="$LUNARNAV_HOME/incoming/$base"
    if [ -d "$ROOT" ]; then
      echo "already unpacked: $ROOT"
    else
      log "unzip $SRC -> $ROOT"
      rm -rf "$ROOT.part"
      mkdir -p "$ROOT.part"
      unzip -q "$SRC" -d "$ROOT.part"
      mv "$ROOT.part" "$ROOT"
    fi
    ;;
  *)
    [ -d "$SRC" ] || die "$SRC is neither a .zip nor a directory"
    ROOT="$(cd "$SRC" && pwd)"
    ;;
esac

# ---- 2. find run directories ------------------------------------------------------------------------------
mapfile -t RUN_DIRS < <(find "$ROOT" -maxdepth 4 -type f -name manifest.json -printf '%h\n' | sort)
[ "${#RUN_DIRS[@]}" -gt 0 ] || die "no manifest.json under $ROOT"
SELECTED=()
for d in "${RUN_DIRS[@]}"; do
  if [ -z "$PICK" ] || [[ "$(basename "$d")" == *"$PICK"* ]]; then SELECTED+=("$d"); fi
done
[ "${#SELECTED[@]}" -gt 0 ] || die "no run directory name contains '$PICK': ${RUN_DIRS[*]}"
echo "run directories: ${SELECTED[*]}"

# ---- 3. importer, one run at a time ------------------------------------------------------------------------
first=1
for d in "${SELECTED[@]}"; do
  log "import $(basename "$d")"
  args=("$d")
  [ -z "$LABEL" ] || args+=(--label "$LABEL")
  if [ "$MAKE_DEFAULT" -eq 1 ] && [ "$first" -eq 1 ]; then args+=(--default); fi
  [ "$FORCE" -eq 0 ] || args+=(--force)
  [ "$DRY" -eq 0 ] || args+=(--dry-run)
  [ "$STATS" -eq 0 ] || args+=(--stats)
  echo "node scripts/import-run.ts ${args[*]}"
  (cd "$BACKEND" && node --env-file="$ENV_FILE" scripts/import-run.ts "${args[@]}")
  first=0
done

port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r')"
log "done - check: curl -s http://127.0.0.1:${port:-3000}/api/v1/runs"
