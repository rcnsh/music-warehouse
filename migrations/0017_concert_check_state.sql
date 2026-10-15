-- Migration 0017: how the last concert check went.
--
-- A check that Ticketmaster refused (a 429, a 5xx) used to be logged and
-- nothing more, so a key that had run out of quota went unnoticed. This row
-- records the last run and the last failure, for the health and alert code to
-- read (concertCheckStatus in src/concerts.ts). A run that hit any error,
-- for a lookup or a region, counts as failed; the regions it did fetch are
-- still stored.
CREATE TABLE concert_check_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_ms          INTEGER,
  last_success_ms      INTEGER,
  last_error           TEXT,
  last_error_ms        INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
INSERT INTO concert_check_state (id) VALUES (1);
