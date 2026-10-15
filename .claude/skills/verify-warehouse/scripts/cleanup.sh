#!/usr/bin/env bash
# Tear down one verification run: stop the processes it started and delete its
# scratch dir (local D1, run.env). Evidence under verify-evidence/<run-id>/ is
# never touched; the wrangler log is copied into it first.
#
#   .claude/skills/verify-warehouse/scripts/cleanup.sh [run-dir | run.env]
#
# Defaults to $VERIFY_RUN, else the newest run. Kills only the process group
# launch.sh recorded, never by name.
set -uo pipefail
. "$(dirname "$0")/_lib.sh"
load_run "${1:-}"

# Never delete anything outside the scratch root.
case "$RUN_DIR" in
  "$SCRATCH_ROOT"/?*) ;;
  *) die "refusing to clean $RUN_DIR: not under $SCRATCH_ROOT" ;;
esac

mkdir -p "$EVIDENCE_DIR"
[ -f "$LOG" ] && cp "$LOG" "$EVIDENCE_DIR/wrangler.log"

if [ -n "${WRANGLER_PGID:-}" ] && [ -n "$(group_pids "$WRANGLER_PGID")" ]; then
  # Only a group launch.sh created: its leader is the wrangler PID it recorded.
  [ "$WRANGLER_PGID" = "$WRANGLER_PID" ] || die "process group $WRANGLER_PGID is not led by wrangler pid $WRANGLER_PID; not killing"
  echo "cleanup: stopping process group $WRANGLER_PGID ($(group_pids "$WRANGLER_PGID" | tr '\n' ' '))"
  kill -TERM -- "-$WRANGLER_PGID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    [ -z "$(group_pids "$WRANGLER_PGID")" ] && break
    sleep 0.5
  done
  if [ -n "$(group_pids "$WRANGLER_PGID")" ]; then
    echo "cleanup: still running after 10 s, sending KILL"
    kill -KILL -- "-$WRANGLER_PGID" 2>/dev/null || true
    sleep 0.5
  fi
fi

status=0
if [ -n "${WRANGLER_PGID:-}" ] && [ -n "$(group_pids "$WRANGLER_PGID")" ]; then
  echo "cleanup: FAIL processes left in group $WRANGLER_PGID: $(group_pids "$WRANGLER_PGID" | tr '\n' ' ')" >&2
  status=1
fi
for port in "$PORT" "$INSPECTOR_PORT"; do
  left="$(listeners "$port")"
  if [ -n "$left" ] && [ -n "${WRANGLER_PGID:-}" ]; then
    for pid in $left; do
      if [ "$(pgid_of "$pid")" = "$WRANGLER_PGID" ]; then
        echo "cleanup: FAIL port $port still held by this run (pid $pid)" >&2
        status=1
      fi
    done
  fi
done

rm -rf -- "$RUN_DIR"
echo "cleanup: removed $RUN_DIR"
echo "cleanup: evidence kept at $EVIDENCE_DIR"
exit "$status"
