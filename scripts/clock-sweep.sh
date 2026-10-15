#!/usr/bin/env bash
# Run the test suite with the clock frozen at instants that have broken
# date-dependent tests before: either side of Singapore midnight, just before
# UTC midnight, both sides of a UK DST change, a year boundary, and far ahead.
set -u
instants=(
  2026-10-15T15:59:00Z
  2026-10-15T16:01:00Z
  2026-10-15T23:59:00Z
  2027-03-28T00:59:00Z
  2027-03-28T01:01:00Z
  2026-12-31T16:30:00Z
  2027-01-01T00:00:00Z
  2031-06-15T12:00:00Z
)
status=0
for t in "${instants[@]}"; do
  out=$(TEST_NOW="$t" npx vitest run 2>&1)
  summary=$(printf '%s\n' "$out" | grep -E '^ +Tests ' | tail -1)
  echo "$t $summary"
  if printf '%s\n' "$out" | grep -q ' FAIL '; then
    printf '%s\n' "$out" | grep ' FAIL ' | sed 's/^/    /'
    status=1
  fi
done
exit $status
