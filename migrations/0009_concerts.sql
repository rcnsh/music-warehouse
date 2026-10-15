-- Concert alerts: upcoming Ticketmaster events for the artists you play most.

-- One row per artist name looked up, matched or not, so each name costs one
-- Ticketmaster call a month at most. attraction_id is NULL for no match.
CREATE TABLE concert_artists (
  name_key      TEXT    PRIMARY KEY,  -- lower(name)
  name          TEXT    NOT NULL,
  attraction_id TEXT,
  checked_ms    INTEGER NOT NULL
);

-- Upcoming events, one row per event and region. first_seen_ms says what is new.
CREATE TABLE concerts (
  event_id      TEXT    NOT NULL,
  region        TEXT    NOT NULL,     -- 'singapore' or 'london'
  artists       TEXT    NOT NULL,     -- the matched artists on the bill
  name          TEXT    NOT NULL,
  local_date    TEXT,
  local_time    TEXT,
  venue         TEXT,
  city          TEXT,
  status        TEXT,
  url           TEXT,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL,
  PRIMARY KEY (event_id, region)
);
CREATE INDEX idx_concerts_first_seen ON concerts(first_seen_ms);

-- When each region was last fetched in full.
CREATE TABLE concert_runs (
  region     TEXT    PRIMARY KEY,
  checked_ms INTEGER NOT NULL
);
