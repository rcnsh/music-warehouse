-- Migration 0004: computed listening stats.
--
-- The /api/stats/* routes each scan most of `plays` (47k-1.2M rows read). One
-- row per route holds the last computed JSON, so traffic costs a single-row
-- read and a recompute happens at most once per freshness window, wherever
-- the requests come from.
--
-- `claimed_until_ms` is how exactly one request gets to compute: a claim is
-- an UPDATE (or, for a key never computed, the INSERT that creates the row)
-- that only succeeds while it is NULL or past. A success clears it; a failure
-- pushes it an hour out, so a compute that keeps failing can't keep spending
-- rows. `body` is NULL until the first compute succeeds.
CREATE TABLE stats_snapshots (
  key              TEXT    PRIMARY KEY,
  body             TEXT,
  computed_ms      INTEGER,
  claimed_until_ms INTEGER
);
