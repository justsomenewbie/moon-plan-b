#!/usr/bin/env bash
# Live end-to-end check of a RUNNING server with curl: every operation of the API on the default run
# (the 2026-Q1 sample run), then one real custom-coordinate job (lunarnav precompute) polled to the end,
# whose run is read back through the same read endpoints.
#
#   bash scripts/e2e-curl.sh [BASE_URL] [OUT_DIR]
#     BASE_URL  default http://127.0.0.1:3000
#     OUT_DIR   default contract/examples/e2e   (one body file per call + report.tsv + job_timeline.tsv)
#   env: E2E_LAT / E2E_LON / E2E_START / E2E_END   custom job (default -89.60 / 215.00, 2026-01 one month)
#        E2E_DEM   dem of the custom jobs (default pgda; "none" needs no network)
#        E2E_API_KEY     API key (server with API_KEYS set) -> X-API-Key header on every call
#        E2E_DOCS_AUTH   user:password of /docs and /api/v1/openapi.json (server with DOCS_USER set)
#
# Exit 1 on the first unexpected status. Needs curl and node (JSON parsing) on PATH.
set -euo pipefail

BASE="${1:-http://127.0.0.1:3000}"
OUT="${2:-contract/examples/e2e}"
API="$BASE/api/v1"
SITE=ref_connecting_ridge_c1
LAT="${E2E_LAT:--89.60}"
LON="${E2E_LON:-215.00}"
START="${E2E_START:-2026-01-01T00:00:00Z}"
END="${E2E_END:-2026-02-01T00:00:00Z}"
DEM="${E2E_DEM:-pgda}"
AUTH=(); [[ -n "${E2E_API_KEY:-}" ]] && AUTH=(-H "x-api-key: $E2E_API_KEY")
DOCS_AUTH=(); [[ -n "${E2E_DOCS_AUTH:-}" ]] && DOCS_AUTH=(-u "$E2E_DOCS_AUTH")
# ISO instant + N hours (custom-run requests are relative to START/END, so E2E_START/E2E_END can move freely)
plus_h() { node -e "console.log(new Date(Date.parse(process.argv[1]) + Number(process.argv[2]) * 3600e3).toISOString().replace('.000Z', 'Z'))" "$1" "$2"; }

mkdir -p "$OUT"
REPORT="$OUT/report.tsv"
printf 'name\tmethod\turl\texpected\tstatus\tcontent_type\tbytes\ttime_ms\n' > "$REPORT"
N_OK=0

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=(new Function("v","return "+process.argv[1]))(v);process.stdout.write(typeof r==="string"?r:JSON.stringify(r))})' "$1"; }
enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

# call NAME METHOD URL EXPECTED_STATUS [JSON_BODY] [EXTRA_CURL_ARGS...] -> body in $OUT/NAME.<ext>, status in $LAST_STATUS
call() {
  local name=$1 method=$2 url=$3 expected=$4 body=${5:-}
  shift 5 2>/dev/null || shift $#
  local tmp="$OUT/.body" meta
  local args=(-sS -X "$method" -o "$tmp" -w '%{http_code}|%{content_type}|%{size_download}|%{time_total}' ${AUTH[@]+"${AUTH[@]}"} "$@")
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' --data "$body")
  : > "$tmp"
  meta=$(curl "${args[@]}" "$url")
  local status ctype bytes t
  IFS='|' read -r status ctype bytes t <<< "$meta"
  local ext=json
  case "$ctype" in text/csv*) ext=csv ;; text/event-stream*) ext=txt ;; text/html*) ext=html ;; "") ext=empty ;; esac
  mv "$tmp" "$OUT/$name.$ext"
  local ms; ms=$(node -e "process.stdout.write(String(Math.round(${t}*1000)))")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$method" "${url#"$BASE"}" "$expected" "$status" "$ctype" "$bytes" "$ms" >> "$REPORT"
  printf '%-34s %-6s %3s (want %3s) %6s ms %8s B  %s\n' "$name" "$method" "$status" "$expected" "$ms" "$bytes" "${url#"$BASE"}"
  LAST_STATUS=$status
  LAST_FILE="$OUT/$name.$ext"
  if [[ "$status" != "$expected" ]]; then echo "FAIL: $name -> $status (expected $expected); body: $(head -c 400 "$LAST_FILE")" >&2; exit 1; fi
  N_OK=$((N_OK + 1))
}

echo "== default run ($BASE)"
call health GET "$API/health" 200 ''
RUN_ID=$(json 'v.default_run_id' < "$LAST_FILE")
[[ "$RUN_ID" != "null" ]] || { echo "FAIL: no default run imported" >&2; exit 1; }
call meta GET "$API/meta" 200 ''
call runs GET "$API/runs" 200 ''
call run_detail GET "$API/runs/$RUN_ID" 200 ''
call sites GET "$API/sites" 200 ''
call sites_geojson GET "$API/sites?group=south_pole&format=geojson" 200 ''
call site_detail GET "$API/sites/$SITE" 200 ''
call horizon GET "$API/sites/$SITE/horizon" 200 ''
call series GET "$API/sites/$SITE/series?start=2026-03-01T00:00:00Z&end=2026-03-02T00:00:00Z&fields=sun_el_deg,sun_visible,earth_visible" 200 ''
call series_minmax GET "$API/sites/$SITE/series?fields=sun_el_deg,earth_el_deg&max_points=100&agg=minmax" 200 ''
call instant GET "$API/sites/$SITE/instant?t=2026-03-14T05:30:00Z" 200 ''
call sky GET "$API/sites/$SITE/sky?start=2026-03-01T00:00:00Z&end=2026-03-08T00:00:00Z&max_points=64" 200 ''
call windows GET "$API/sites/$SITE/windows?start=2026-03-01T00:00:00Z&kinds=sun,earth" 200 ''
call compare POST "$API/compare" 200 "{\"site_ids\":[\"$SITE\",\"a3_haworth\",\"apollo11\"],\"start\":\"2026-02-01T00:00:00Z\",\"end\":\"2026-03-01T00:00:00Z\",\"include\":{\"windows\":[\"sun\"]}}"
call ranking GET "$API/ranking" 200 ''
call ranking_weights GET "$API/ranking?group=south_pole&weights=pct_sun:0.7,pct_both:0.3" 200 ''
call alt_dates POST "$API/alt-dates" 200 "{\"site_id\":\"$SITE\",\"earliest\":\"2026-01-05T00:00:00Z\",\"latest\":\"2026-02-20T00:00:00Z\",\"mission_h\":336,\"max_results\":3}"
call export_series GET "$API/sites/$SITE/export/series.csv?start=2026-03-01T00:00:00Z&end=2026-03-01T06:00:00Z&fields=sun_el_deg,sun_visible" 200 ''
call export_windows GET "$API/sites/$SITE/export/windows.csv?kinds=sun" 200 ''
call export_summary GET "$API/export/summary.csv" 200 ''
call run_file GET "$API/runs/$RUN_ID/files/$(enc sites/apollo11/windows.json)" 200 ''
ETAG=$(curl -sS -o /dev/null -D - ${AUTH[@]+"${AUTH[@]}"} "$API/runs/$RUN_ID/files/$(enc sites/apollo11/windows.json)" | tr -d '\r' | sed -n 's/^etag: //Ip')
call run_file_304 GET "$API/runs/$RUN_ID/files/$(enc sites/apollo11/windows.json)" 304 '' -H "if-none-match: $ETAG"
call error_site_not_found GET "$API/sites/nope" 404 ''
call error_validation GET "$API/sites/$SITE/series?max_points=abc" 400 ''
call error_out_of_range GET "$API/sites/$SITE/instant?t=2030-01-01T00:00:00Z" 422 ''
call error_route GET "$API/nothing" 404 ''
call openapi_spec GET "$API/openapi.json" 200 '' ${DOCS_AUTH[@]+"${DOCS_AUTH[@]}"}
call docs_ui GET "$BASE/docs" 200 '' ${DOCS_AUTH[@]+"${DOCS_AUTH[@]}"}

echo "== custom job lat=$LAT lon=$LON $START .. $END"
T0=$(node -e 'process.stdout.write(String(Date.now()))')
call job_accepted POST "$API/jobs" 202 "{\"type\":\"custom_site\",\"lat_deg\":$LAT,\"lon_deg\":$LON,\"dem\":\"$DEM\",\"name\":\"E2E custom site\",\"start\":\"$START\",\"end\":\"$END\"}"
JOB_ID=$(json 'v.job_id' < "$LAST_FILE")
CUSTOM=$(json 'v.site_id' < "$LAST_FILE")
TIMELINE="$OUT/job_timeline.tsv"
printf 't_ms\tstatus\tstage\tpct\n' > "$TIMELINE"
STATUS=queued
while :; do
  curl -sS -o "$OUT/.job" ${AUTH[@]+"${AUTH[@]}"} "$API/jobs/$JOB_ID"
  LINE=$(json '[v.status, v.progress ? v.progress.stage : "", v.progress ? v.progress.pct : ""].join("\t")' < "$OUT/.job")
  NOW=$(node -e 'process.stdout.write(String(Date.now()))')
  printf '%s\t%s\n' "$((NOW - T0))" "$LINE" >> "$TIMELINE"
  STATUS=${LINE%%$'\t'*}
  case "$STATUS" in succeeded | failed | cancelled) break ;; esac
  if (( NOW - T0 > 1500000 )); then echo "FAIL: job $JOB_ID still $STATUS after 25 min" >&2; exit 1; fi
  sleep 1
done
rm -f "$OUT/.job"
T_DONE=$(node -e 'process.stdout.write(String(Date.now()))')
call job_final GET "$API/jobs/$JOB_ID" 200 ''
[[ "$STATUS" == succeeded ]] || { echo "FAIL: job $JOB_ID ended $STATUS: $(cat "$LAST_FILE")" >&2; exit 1; }
JOB_RUN=$(json 'v.result.run_id' < "$LAST_FILE")
echo "job $JOB_ID succeeded in $((T_DONE - T0)) ms -> run $JOB_RUN, site $CUSTOM"
C=$(enc "$CUSTOM")
call job_events GET "$API/jobs/$JOB_ID/events" 200 ''
call job_again POST "$API/jobs" 200 "{\"type\":\"custom_site\",\"lat_deg\":$LAT,\"lon_deg\":$LON,\"dem\":\"$DEM\",\"start\":\"$START\",\"end\":\"$END\"}"
call job_cancel_finished DELETE "$API/jobs/$JOB_ID" 409 ''
call custom_run GET "$API/runs/$JOB_RUN" 200 ''
call custom_runs_list GET "$API/runs?kind=custom" 200 ''
call custom_sites GET "$API/sites?run_id=$JOB_RUN" 200 ''
call custom_site_detail GET "$API/sites/$C?run_id=$JOB_RUN" 200 ''
call custom_horizon GET "$API/sites/$C/horizon?run_id=$JOB_RUN" 200 ''
call custom_series GET "$API/sites/$C/series?run_id=$JOB_RUN&fields=sun_el_deg,sun_visible,earth_visible&max_points=200" 200 ''
call custom_instant GET "$API/sites/$C/instant?run_id=$JOB_RUN&t=$(plus_h "$START" 348)" 200 ''
call custom_sky GET "$API/sites/$C/sky?run_id=$JOB_RUN&max_points=64" 200 ''
call custom_windows GET "$API/sites/$C/windows?run_id=$JOB_RUN" 200 ''
call custom_ranking GET "$API/ranking?run_id=$JOB_RUN" 200 ''
call custom_alt_dates POST "$API/alt-dates" 200 "{\"run_id\":\"$JOB_RUN\",\"site_id\":\"$CUSTOM\",\"earliest\":\"$(plus_h "$START" 24)\",\"latest\":\"$(plus_h "$START" 456)\",\"mission_h\":168,\"max_results\":3}"
call custom_export_series GET "$API/sites/$C/export/series.csv?run_id=$JOB_RUN&end=$(plus_h "$START" 6)" 200 ''
call custom_export_windows GET "$API/sites/$C/export/windows.csv?run_id=$JOB_RUN" 200 ''
call custom_export_summary GET "$API/export/summary.csv?run_id=$JOB_RUN" 200 ''

echo "== cancel a running job (same site, other range: no new DEM tiles to download)"
call job2_accepted POST "$API/jobs" 202 "{\"type\":\"custom_site\",\"lat_deg\":$LAT,\"lon_deg\":$LON,\"dem\":\"$DEM\",\"start\":\"$START\",\"end\":\"$(plus_h "$START" 8000)\"}"
JOB2=$(json 'v.job_id' < "$LAST_FILE")
sleep 2
call job2_cancel DELETE "$API/jobs/$JOB2" 200 ''
call job2_final GET "$API/jobs/$JOB2" 200 ''
[[ "$(json 'v.status' < "$LAST_FILE")" == cancelled ]] || { echo "FAIL: job $JOB2 not cancelled: $(cat "$LAST_FILE")" >&2; exit 1; }

echo "== $N_OK calls OK; job $JOB_ID ($CUSTOM) $((T_DONE - T0)) ms; report $REPORT"
