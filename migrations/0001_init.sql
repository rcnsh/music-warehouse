-- Migration 0001: initial warehouse schema.
-- All timestamps are UTC milliseconds since the epoch, stored as INTEGER (R8).

CREATE TABLE plays (
  played_at_ms INTEGER NOT NULL,
  track_id     TEXT    NOT NULL,
  context_uri  TEXT,
  context_type TEXT,
  source       TEXT    NOT NULL DEFAULT 'api',  -- 'api' or 'export'
  PRIMARY KEY (played_at_ms, track_id)
);
CREATE INDEX idx_plays_track ON plays(track_id, played_at_ms);

CREATE TABLE tracks (
  track_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  duration_ms   INTEGER,
  album_id      TEXT,
  isrc          TEXT,
  first_seen_ms INTEGER NOT NULL
);

CREATE TABLE artists (
  artist_id TEXT PRIMARY KEY,
  name      TEXT NOT NULL
);

CREATE TABLE track_artists (
  track_id  TEXT    NOT NULL,
  artist_id TEXT    NOT NULL,
  position  INTEGER NOT NULL,
  PRIMARY KEY (track_id, artist_id)
);
CREATE INDEX idx_track_artists_artist ON track_artists(artist_id);

CREATE TABLE albums (
  album_id     TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  release_date TEXT,
  image_url    TEXT
);

CREATE TABLE oauth_token (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  access_token      TEXT,
  access_expires_ms INTEGER,
  refresh_token     TEXT,
  -- Set on initial authorization and on every re-authorization, never on a
  -- token refresh. Sole purpose: the six-month expiry countdown in /health (R6).
  authorized_at_ms  INTEGER NOT NULL,
  needs_reauth      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_ms            INTEGER NOT NULL DEFAULT 0,
  last_success_ms      INTEGER,
  last_error           TEXT,
  last_error_ms        INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- Not in the brief's schema: the OAuth `state` value has to survive the round
-- trip from /login to /callback, and D1 is the only store this Worker has.
-- Single row, overwritten by each /login.
CREATE TABLE oauth_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  state      TEXT    NOT NULL,
  created_ms INTEGER NOT NULL
);

-- Singleton rows, so every later statement can be a plain UPDATE.
INSERT INTO oauth_token (id, authorized_at_ms, needs_reauth) VALUES (1, 0, 0);
INSERT INTO sync_state (id, cursor_ms, consecutive_failures) VALUES (1, 0, 0);
