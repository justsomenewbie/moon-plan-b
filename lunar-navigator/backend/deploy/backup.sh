#!/usr/bin/env bash
# MongoDB backup with rotation (cron: /etc/cron.d/lunarnav-backup, written by provision-ubuntu.sh).
#
#   backup.sh [--keep N] [--dir DIR]
#
# - mongodump of database `lunarnav` as one gzip archive: DIR/lunarnav-<UTC timestamp>.archive.gz
#   (credentials of the `backup`-role user come from /etc/lunarnav/mongodump.yaml - never on the command line)
# - plus DATA_DIR/runs/job_* (custom-job output directories, small) as DIR/job-runs-<ts>.tar.gz
#   Imported precompute runs are NOT tarred: they are re-importable from the Colab zip.
# - keeps the newest N of each kind (default 7). Restore: docs/DEPLOY_VPS.md section "Backup / restore".
#
# Environment: LUNARNAV_DUMP_CONFIG, LUNARNAV_BACKUP_DIR, LUNARNAV_BACKUP_KEEP, LUNARNAV_DB, LUNARNAV_DATA_DIR
set -euo pipefail

CONFIG="${LUNARNAV_DUMP_CONFIG:-/etc/lunarnav/mongodump.yaml}"
DIR="${LUNARNAV_BACKUP_DIR:-/var/backups/lunarnav}"
KEEP="${LUNARNAV_BACKUP_KEEP:-7}"
DB="${LUNARNAV_DB:-lunarnav}"
DATA_DIR="${LUNARNAV_DATA_DIR:-/opt/lunarnav/data}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || die "--keep must be a positive integer"
[ -r "$CONFIG" ] || die "$CONFIG not readable (run provision-ubuntu.sh, or run as the app user)"
command -v mongodump >/dev/null || die "mongodump not installed (apt install mongodb-database-tools)"
mkdir -p "$DIR"

exec 9> "$DIR/.lock"
flock -n 9 || die "another backup is running"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
started="$(date +%s)"
echo "$(date -u +%FT%TZ) backup start ($DB -> $DIR, keep $KEEP)"

part="$DIR/.lunarnav-$ts.archive.gz.part"
trap 'rm -f "$part" "$DIR/.job-runs-$ts.tar.gz.part"' EXIT
mongodump --config="$CONFIG" --db="$DB" --archive="$part" --gzip --quiet
mv "$part" "$DIR/lunarnav-$ts.archive.gz"
echo "  $(du -h "$DIR/lunarnav-$ts.archive.gz" | cut -f1)  lunarnav-$ts.archive.gz"

if [ -d "$DATA_DIR/runs" ] && find "$DATA_DIR/runs" -mindepth 1 -maxdepth 1 -type d -name 'job_*' | grep -q .; then
  jpart="$DIR/.job-runs-$ts.tar.gz.part"
  find "$DATA_DIR/runs" -mindepth 1 -maxdepth 1 -type d -name 'job_*' -printf '%f\0' |
    tar -C "$DATA_DIR/runs" --null -T - -czf "$jpart"
  mv "$jpart" "$DIR/job-runs-$ts.tar.gz"
  echo "  $(du -h "$DIR/job-runs-$ts.tar.gz" | cut -f1)  job-runs-$ts.tar.gz"
fi

prune() { # prune <glob> - keep the newest $KEEP (names sort by timestamp)
  local -a files=()
  mapfile -t files < <(find "$DIR" -maxdepth 1 -type f -name "$1" -printf '%f\n' | sort -r)
  local f
  for f in "${files[@]:$KEEP}"; do
    rm -f -- "${DIR:?}/$f"
    echo "  pruned $f"
  done
}
prune 'lunarnav-*.archive.gz'
prune 'job-runs-*.tar.gz'

echo "$(date -u +%FT%TZ) backup done in $(( $(date +%s) - started )) s"
