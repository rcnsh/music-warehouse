# Shared by the verify-warehouse helpers. Sourced, never run.
# shellcheck shell=bash

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
# Scratch state for every run lives outside the repo; evidence lives inside it
# (gitignored) so it outlives cleanup.
SCRATCH_ROOT="${TMPDIR:-/tmp}"
SCRATCH_ROOT="${SCRATCH_ROOT%/}/verify-warehouse"
EVIDENCE_ROOT="$REPO_ROOT/verify-evidence"
SEED_DIR="$SKILL_DIR/seed"
# Plays the seed export stores: 328 records, less one skip (<30 s) and one podcast.
SEED_EXPECTED_PLAYS=326

die() { echo "verify-warehouse: $*" >&2; exit 1; }

# The run to act on: $1, else $VERIFY_RUN, else the newest run. Accepts a run
# directory or its run.env. Sets RUN_ENV and sources it.
load_run() {
  local target="${1:-${VERIFY_RUN:-}}"
  if [ -z "$target" ]; then
    target="$(ls -1dt "$SCRATCH_ROOT"/*/ 2>/dev/null | head -n 1)"
    [ -n "$target" ] || die "no run found under $SCRATCH_ROOT. Run launch.sh first."
  fi
  case "$target" in
    */run.env) RUN_ENV="$target" ;;
    *) RUN_ENV="${target%/}/run.env" ;;
  esac
  [ -f "$RUN_ENV" ] || die "no run.env at $RUN_ENV"
  # shellcheck disable=SC1090
  . "$RUN_ENV"
}

# PIDs listening on a TCP port (empty when free).
listeners() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

# Process group of a PID, trimmed.
pgid_of() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }

# Every PID in a process group.
group_pids() { ps -A -o pid=,pgid= | awk -v g="$1" '$2 == g { print $1 }'; }
