#!/usr/bin/env bash
# Start a disposable, local-only music-warehouse for verification.
#
#   .claude/skills/verify-warehouse/scripts/launch.sh
#
# From an empty scratch dir: applies every migration to a local D1, starts
# `wrangler dev --local` on its own ports with dummy secrets (never .dev.vars),
# imports the synthetic seed export through POST /admin/import, and mints a
# read device token through POST /admin/tokens. Prints the run.env path; the
# other helpers read it. On any failure it tears down what it started.
#
# Env: VERIFY_PORT (default 8797), VERIFY_INSPECTOR_PORT (default 9339). A busy
# port is skipped for the next free one.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"
[ -x node_modules/.bin/wrangler ] || die "node_modules missing: run npm ci in $REPO_ROOT"
# Wrangler's env "test" reads .dev.vars.test instead of .dev.vars. Without the
# file it would fall back to .dev.vars, which holds production secrets.
[ -f .dev.vars.test ] || die ".dev.vars.test is missing; refusing to start (Wrangler would read .dev.vars)."

free_port() {
  local port="$1" tries=0
  while [ -n "$(listeners "$port")" ]; do
    port=$((port + 1)); tries=$((tries + 1))
    [ "$tries" -lt 50 ] || die "no free port near $1"
  done
  echo "$port"
}
PORT="$(free_port "${VERIFY_PORT:-8797}")"
INSPECTOR_PORT="$(free_port "${VERIFY_INSPECTOR_PORT:-9339}")"
[ "$INSPECTOR_PORT" != "$PORT" ] || INSPECTOR_PORT="$(free_port $((PORT + 1)))"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$SCRATCH_ROOT/$RUN_ID"
PERSIST_DIR="$RUN_DIR/persist"
EVIDENCE_DIR="$EVIDENCE_ROOT/$RUN_ID"
BASE_URL="http://127.0.0.1:$PORT"
LOG="$RUN_DIR/wrangler.log"
# Dummy credentials, minted per run. Nothing here is a real secret.
MW_ADMIN_TOKEN="verify-admin-$(openssl rand -hex 16)"
mkdir -p "$PERSIST_DIR" "$EVIDENCE_DIR/launch"

write_env() {
  {
    printf 'RUN_ID=%q\nRUN_DIR=%q\nPERSIST_DIR=%q\nEVIDENCE_DIR=%q\n' "$RUN_ID" "$RUN_DIR" "$PERSIST_DIR" "$EVIDENCE_DIR"
    printf 'PORT=%q\nINSPECTOR_PORT=%q\nBASE_URL=%q\nLOG=%q\n' "$PORT" "$INSPECTOR_PORT" "$BASE_URL" "$LOG"
    printf 'WRANGLER_PID=%q\nWRANGLER_PGID=%q\nGIT_HEAD=%q\n' "${WRANGLER_PID:-}" "${WRANGLER_PGID:-}" "$(git rev-parse HEAD)"
    printf 'MW_ADMIN_TOKEN=%q\nMW_READ_TOKEN=%q\nMW_READ_TOKEN_ID=%q\n' "$MW_ADMIN_TOKEN" "${MW_READ_TOKEN:-}" "${MW_READ_TOKEN_ID:-}"
  } > "$RUN_DIR/run.env"
}
write_env

fail() {
  echo "launch: $*" >&2
  echo "launch: tearing down run $RUN_ID (log copied to $EVIDENCE_DIR/wrangler.log)" >&2
  "$SKILL_DIR/scripts/cleanup.sh" "$RUN_DIR" >&2 || true
  exit 1
}

# Wrangler must never talk to Cloudflare, nor pick up a real .env either.
export WRANGLER_SEND_METRICS=false DO_NOT_TRACK=1 CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false NO_COLOR=1 FORCE_COLOR=0
# -c wrangler.jsonc is explicit, so scripts/wrangler.mjs never swaps in
# wrangler.local.jsonc (the real deployment's config).
WRANGLER=(node scripts/wrangler.mjs)
COMMON=(-c wrangler.jsonc --env test)

echo "launch: run $RUN_ID, port $PORT, inspector $INSPECTOR_PORT"
echo "launch: applying migrations to the local D1 in $PERSIST_DIR"
CI=1 "${WRANGLER[@]}" d1 migrations apply music_warehouse_test --local "${COMMON[@]}" --persist-to "$PERSIST_DIR" \
  > "$EVIDENCE_DIR/launch/migrations.log" 2>&1 < /dev/null || fail "migrations failed; see $EVIDENCE_DIR/launch/migrations.log"

# Job control gives wrangler (and the workerd it spawns) a process group of its
# own, so cleanup can stop exactly this run and nothing else.
set -m
"${WRANGLER[@]}" dev --local "${COMMON[@]}" --persist-to "$PERSIST_DIR" \
  --ip 127.0.0.1 --port "$PORT" --inspector-port "$INSPECTOR_PORT" --show-interactive-dev-session=false \
  --var "ADMIN_TOKEN:$MW_ADMIN_TOKEN" \
  --var "SPOTIFY_CLIENT_ID:verify-dummy-client-id" \
  --var "SPOTIFY_CLIENT_SECRET:verify-dummy-client-secret" \
  --var "SPOTIFY_REDIRECT_URI:$BASE_URL/callback" \
  > "$LOG" 2>&1 < /dev/null &
WRANGLER_PID=$!
set +m
WRANGLER_PGID="$(pgid_of "$WRANGLER_PID")"
write_env

# Ready = the Worker answers (401 on / without a token), polled in short steps.
echo "launch: waiting for $BASE_URL"
for _ in $(seq 1 120); do
  kill -0 "$WRANGLER_PID" 2>/dev/null || fail "wrangler exited early; see $LOG"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE_URL/" || true)"
  [ "$code" = "401" ] && break
  sleep 0.5
done
[ "${code:-}" = "401" ] || fail "no answer from $BASE_URL after 60 s; see $LOG"

# The instance must have read the dummy .dev.vars.test, not .dev.vars.
grep -Eq 'Using (vars|secrets) defined in \.dev\.vars\.test' "$LOG" || fail "log does not show .dev.vars.test being used"
if grep -E 'Using (vars|secrets) defined in \.dev\.vars( |$)|Using (vars|secrets) defined in \.env' "$LOG" >/dev/null; then
  fail "log shows .dev.vars or .env being read"
fi

admin() { curl -sS --max-time 30 -H "Authorization: Bearer $MW_ADMIN_TOKEN" "$@"; }

echo "launch: importing the synthetic seed export through POST /admin/import"
( cd "$RUN_DIR" && ADMIN_TOKEN="$MW_ADMIN_TOKEN" node "$REPO_ROOT/scripts/import-export.mjs" \
    --dir "$SEED_DIR" --url "$BASE_URL" --state "$RUN_DIR/import-state.json" --delayMs 0 ) \
  > "$EVIDENCE_DIR/launch/import.log" 2>&1 || fail "import failed; see $EVIDENCE_DIR/launch/import.log"

admin "$BASE_URL/health" > "$EVIDENCE_DIR/launch/health.json" || fail "GET /health failed"
total="$(jq -r '.total_plays' < "$EVIDENCE_DIR/launch/health.json")"
[ "$total" = "$SEED_EXPECTED_PLAYS" ] || fail "/health total_plays is $total, expected $SEED_EXPECTED_PLAYS"

echo "launch: minting a read device token through POST /admin/tokens"
minted="$(admin -X POST -H 'Content-Type: application/json' \
  -d '{"name":"verify-warehouse","access":"read","expires_in_days":1}' "$BASE_URL/admin/tokens")" \
  || fail "POST /admin/tokens failed"
MW_READ_TOKEN="$(jq -r '.token // empty' <<<"$minted")"
MW_READ_TOKEN_ID="$(jq -r '.id // empty' <<<"$minted")"
[ -n "$MW_READ_TOKEN" ] || fail "no token in POST /admin/tokens response: $minted"
jq '.token = "<redacted>"' <<<"$minted" > "$EVIDENCE_DIR/launch/token-mint.json"
write_env

# Usable = the read token reads seeded plays, as a client would.
first="$(curl -sS --max-time 10 -H "Authorization: Bearer $MW_READ_TOKEN" "$BASE_URL/api/plays?limit=1")"
[ "$(jq -r '.plays | length' <<<"$first")" = "1" ] || fail "GET /api/plays with the read token returned: $first"

echo "launch: ready"
echo "  base url:  $BASE_URL"
echo "  run env:   $RUN_DIR/run.env   (export VERIFY_RUN=$RUN_DIR)"
echo "  evidence:  $EVIDENCE_DIR"
echo "  wrangler:  pid $WRANGLER_PID, process group $WRANGLER_PGID, log $LOG"
