#!/usr/bin/env bash
# Verify the FE starter against the CURRENT contract, in a throw-away directory:
#   1. openapi-typescript generates src/lib/api/schema.d.ts from ../contract/openapi.json
#   2. tsc --strict type-checks every snippet (client, hooks, url-state, examples, next.config)
#   3. a tiny runtime check of openapi-fetch path encoding + unwrap() against canned responses
# Usage (from anywhere):  bash backend/fe-starter/verify.sh [--keep] [--update-schema] [--spec FILE]
#   --update-schema  also copy the regenerated schema.d.ts back into fe-starter/src/lib/api/
#   --spec FILE      check against another openapi.json (default: backend/contract/openapi.json)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
spec="$here/../contract/openapi.json"
keep=0
update=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) keep=1; shift ;;
    --update-schema) update=1; shift ;;
    --spec) spec="$(cd "$(dirname "${2:?--spec needs a file}")" && pwd)/$(basename "$2")"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -f "$spec" ] || { echo "spec not found: $spec" >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/fe-starter-verify.XXXXXX")"
cleanup() { if [ "$keep" -eq 0 ]; then rm -rf "$work"; else echo "kept $work"; fi; }
trap cleanup EXIT

cp -R "$here/src" "$here/next.config.ts" "$work/"
cp "$here/verify.tsconfig.json" "$work/tsconfig.json"
cp "$here/verify.runtime.ts" "$work/verify.runtime.ts"
mkdir -p "$work/examples"
cp "$here"/../contract/examples/*.json "$work/examples/"
cd "$work"
npm init -y >/dev/null
npm pkg set type=module
npm install --no-audit --no-fund --silent --save-exact \
  openapi-typescript@7.13.0 openapi-fetch@0.17.0 @tanstack/react-query@5.107.1 \
  typescript@5.9.3 react@19.3.1 @types/react@19.3.0 @types/node@24.19.2 next@16.4.6

npx --no-install openapi-typescript "$spec" -o src/lib/api/schema.d.ts --default-non-nullable false
npx --no-install tsc -p tsconfig.json
node --experimental-strip-types --no-warnings verify.runtime.ts

if [ "$update" -eq 1 ]; then
  cp src/lib/api/schema.d.ts "$here/src/lib/api/schema.d.ts"
  echo "updated fe-starter/src/lib/api/schema.d.ts"
fi
echo "fe-starter OK"
