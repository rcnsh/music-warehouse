-- Migration 0021: share the Spotify development-mode quota carefully.
--
-- Spotify's development-mode quota is one budget for every app on the
-- owner's developer account, so the Android app and this Worker draw on the
-- same calls. A 429 there carries a Retry-After of hours, and calling again
-- before it passes only extends the penalty. These tables let every isolate
-- see one pause, share one answer for the live widgets, and count what is
-- spent (src/quota.ts).
--
-- All three are new and unread by older code, so this applies safely before
-- the code that uses it deploys.

-- No call goes to api.spotify.com before until_ms. A later 429 only ever
-- moves it later. `kind` is the SpotifyError kind blocked calls fail with.
CREATE TABLE spotify_pause (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  until_ms INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  set_ms   INTEGER NOT NULL
);

-- One stored Spotify answer per key ('now-playing', 'recently-played'),
-- shared by every client and colo until fresh_until_ms, and served stale while
-- the pause holds.
CREATE TABLE spotify_answers (
  key            TEXT PRIMARY KEY,
  body           TEXT NOT NULL,
  fetched_ms     INTEGER NOT NULL,
  fresh_until_ms INTEGER NOT NULL
) WITHOUT ROWID;

-- Requests actually sent to api.spotify.com, per UTC hour, by what sent them
-- and how Spotify answered ('2xx', '429' or 'other'). Pruned by the poll cron.
CREATE TABLE spotify_calls (
  hour_ms INTEGER NOT NULL,
  source  TEXT NOT NULL,
  outcome TEXT NOT NULL,
  calls   INTEGER NOT NULL,
  PRIMARY KEY (hour_ms, source, outcome)
) WITHOUT ROWID;
