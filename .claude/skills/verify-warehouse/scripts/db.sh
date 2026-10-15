#!/usr/bin/env bash
# Read-only SQL against this run's local D1, for side-effect proof (rows a
# route wrote). Never the remote database: --local and the run's persist dir.
#
#   .claude/skills/verify-warehouse/scripts/db.sh <label> "SELECT ..."
#
# Saves <evidence>/<label>.sql and <label>.json and prints the rows as JSON.
# Only a single SELECT (or WITH) statement is accepted.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
[ "$#" -eq 2 ] || die 'usage: db.sh <label> "SELECT ..."'
label="$1" sql="$2"
load_run ""

trimmed="$(printf '%s' "$sql" | tr '[:lower:]' '[:upper:]' | sed -E 's/^[[:space:]]+//')"
case "$trimmed" in SELECT*|WITH*) ;; *) die "only SELECT/WITH statements" ;; esac
case "$sql" in *\;*) die "one statement, no semicolons" ;; esac

out="$EVIDENCE_DIR/$label"
mkdir -p "$(dirname "$out")"
printf '%s\n' "$sql" > "$out.sql"
cd "$REPO_ROOT"
WRANGLER_SEND_METRICS=false DO_NOT_TRACK=1 node scripts/wrangler.mjs d1 execute music_warehouse_test \
  --local -c wrangler.jsonc --env test --persist-to "$PERSIST_DIR" --json --command "$sql" 2>/dev/null \
  | jq '.[0].results' | tee "$out.json"
