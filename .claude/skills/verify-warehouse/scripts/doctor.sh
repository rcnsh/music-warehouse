#!/usr/bin/env bash
# Read-only: is this verification instance worth driving?
#
#   .claude/skills/verify-warehouse/scripts/doctor.sh [run-dir | run.env]
#
# Checks the process group is alive, the port belongs to it, the Worker
# answers as music-warehouse with the admin token, the read token works, the
# seed is present, and the log shows dummy vars (.dev.vars.test), not
# .dev.vars. Exit 0 only when every check passes. Writes nothing.
set -uo pipefail
. "$(dirname "$0")/_lib.sh"
load_run "${1:-}"

failures=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*"; failures=$((failures + 1)); }

echo "run $RUN_ID at $BASE_URL"

if [ -n "${WRANGLER_PID:-}" ] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
  ok "wrangler pid $WRANGLER_PID alive (process group $WRANGLER_PGID)"
else
  bad "wrangler pid ${WRANGLER_PID:-<none>} not running"
fi

owner=""
for pid in $(listeners "$PORT"); do
  [ "$(pgid_of "$pid")" = "${WRANGLER_PGID:-x}" ] && owner="$pid"
done
if [ -n "$owner" ]; then ok "port $PORT is held by this run (pid $owner)"; else bad "port $PORT is not held by process group ${WRANGLER_PGID:-<none>}: $(listeners "$PORT" | tr '\n' ' ')"; fi

case "$BASE_URL" in
  http://127.0.0.1:*) ok "base url is loopback" ;;
  *) bad "base url $BASE_URL is not loopback" ;;
esac
case "$PERSIST_DIR" in
  "$SCRATCH_ROOT"/*) [ -d "$PERSIST_DIR" ] && ok "local D1 in scratch dir $PERSIST_DIR" || bad "persist dir $PERSIST_DIR missing" ;;
  *) bad "persist dir $PERSIST_DIR is outside $SCRATCH_ROOT" ;;
esac

root="$(curl -sS --max-time 5 -H "Authorization: Bearer $MW_ADMIN_TOKEN" "$BASE_URL/" 2>/dev/null)"
if [ "$(jq -r '.service // empty' <<<"$root" 2>/dev/null)" = "music-warehouse" ]; then ok "GET / answers service=music-warehouse with the admin token"; else bad "GET / with the admin token: ${root:-no answer}"; fi

health="$(curl -sS --max-time 5 -H "Authorization: Bearer $MW_ADMIN_TOKEN" "$BASE_URL/health" 2>/dev/null)"
plays="$(jq -r '.total_plays // empty' <<<"$health" 2>/dev/null)"
if [ "$plays" = "$SEED_EXPECTED_PLAYS" ]; then ok "/health total_plays=$plays (the seed)"; else bad "/health total_plays=${plays:-?}, expected $SEED_EXPECTED_PLAYS (seed missing or data changed by a drive)"; fi
[ "$(jq -r '.authorized' <<<"$health" 2>/dev/null)" = "false" ] && ok "never authorized with Spotify (expected: no grant, no Spotify calls)" || bad "/health says authorized; this instance should hold no Spotify grant"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Authorization: Bearer ${MW_READ_TOKEN:-none}" "$BASE_URL/api/plays?limit=1")"
[ "$code" = "200" ] && ok "read token ${MW_READ_TOKEN_ID:-?} reaches /api/plays" || bad "read token on /api/plays: HTTP $code"

if grep -Eq 'Using (vars|secrets) defined in \.dev\.vars\.test' "$LOG" 2>/dev/null && \
   ! grep -E 'Using (vars|secrets) defined in \.dev\.vars( |$)|Using (vars|secrets) defined in \.env' "$LOG" >/dev/null 2>&1; then
  ok "log shows .dev.vars.test only (real .dev.vars not loaded)"
else
  bad "log does not prove .dev.vars.test-only vars; inspect $LOG"
fi

head_now="$(git -C "$REPO_ROOT" rev-parse HEAD)"
[ "$head_now" = "$GIT_HEAD" ] && ok "checkout at launch commit ${GIT_HEAD:0:12}" || echo "warn  HEAD moved since launch (${GIT_HEAD:0:12} -> ${head_now:0:12}); wrangler dev reloads source, the seed is unchanged"

echo "evidence dir: $EVIDENCE_DIR"
[ "$failures" -eq 0 ] && { echo "doctor: healthy"; exit 0; }
echo "doctor: $failures check(s) failed"; exit 1
