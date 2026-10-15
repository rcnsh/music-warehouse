#!/usr/bin/env bash
# One HTTP request to the verification instance, recorded as evidence.
#
#   .claude/skills/verify-warehouse/scripts/api.sh <auth> <label> <METHOD> <path> [curl args...]
#
#   auth   read | admin | none   which token to send (the run's read device
#                                token, its dummy admin token, or nothing)
#   label  evidence name, may contain a feature dir: history/page-1
#   path   path and query, e.g. '/api/plays?limit=2' (quote it in zsh)
#
# Writes <evidence>/<label>.request.txt (method, URL, auth kind; never the
# token), .headers.txt and .body, then prints "HTTP <status>" and the body.
# Exits 0 whatever the status; assert on it yourself. Never follows redirects,
# so a 3xx to Spotify is recorded, not fetched. Run selection: $VERIFY_RUN,
# else the newest run.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
[ "$#" -ge 4 ] || die "usage: api.sh <read|admin|none> <label> <METHOD> <path> [curl args...]"
auth="$1" label="$2" method="$3" path="$4"; shift 4
load_run ""

case "$path" in /*) ;; *) die "path must start with /" ;; esac
headers=()
case "$auth" in
  read) headers=(-H "Authorization: Bearer $MW_READ_TOKEN") ;;
  admin) headers=(-H "Authorization: Bearer $MW_ADMIN_TOKEN") ;;
  none) ;;
  *) die "auth must be read, admin or none" ;;
esac

out="$EVIDENCE_DIR/$label"
mkdir -p "$(dirname "$out")"
printf '%s %s\nauth: %s\nextra curl args: %s\nat: %s\n' "$method" "$BASE_URL$path" "$auth" "$*" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out.request.txt"
status="$(curl -sS --max-time 60 -X "$method" ${headers[@]+"${headers[@]}"} -D "$out.headers.txt" -o "$out.body" -w '%{http_code}' "$@" "$BASE_URL$path")"
echo "HTTP $status"
cat "$out.body"
echo
