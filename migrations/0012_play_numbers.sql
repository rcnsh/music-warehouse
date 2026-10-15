-- Migration 0012: each play's number within its song ("your 12th play").
--
-- Counting a play's predecessors on read costs a row per earlier play of the
-- song: 26k to 38k rows for a page of 50 with editions folded, measured on
-- the real warehouse. These tables hold the answer instead, one row per play,
-- kept current by every write (src/play-numbers.ts).
--
-- A song is the title and primary artist, both lowercased, as /api/track
-- folds editions. track_songs holds the key each track's plays are numbered
-- under. When a track's key changes, the old one stays in `previous` and
-- `dirty` marks the track until both songs have been renumbered.
CREATE TABLE track_songs (
  track_id TEXT PRIMARY KEY,
  song     TEXT NOT NULL,
  previous TEXT,
  dirty    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_track_songs_song ON track_songs(song);
CREATE INDEX idx_track_songs_dirty ON track_songs(dirty) WHERE dirty = 1;

CREATE TABLE play_numbers (
  played_at_ms INTEGER NOT NULL,
  track_id     TEXT    NOT NULL,
  song         TEXT    NOT NULL,
  n            INTEGER NOT NULL,
  PRIMARY KEY (played_at_ms, track_id)
);
CREATE INDEX idx_play_numbers_song ON play_numbers(song, played_at_ms, track_id);

-- Must match songKey() in src/play-numbers.ts. A track without a primary
-- artist folds with nothing, as /api/track's editions don't.
INSERT INTO track_songs (track_id, song)
SELECT t.track_id,
       COALESCE(lower(t.name) || char(31) ||
                lower((SELECT a.name FROM track_artists ta JOIN artists a ON a.artist_id = ta.artist_id
                        WHERE ta.track_id = t.track_id AND ta.position = 0 ORDER BY a.artist_id LIMIT 1)),
                char(30) || t.track_id)
  FROM tracks t;

INSERT INTO play_numbers (played_at_ms, track_id, song, n)
SELECT p.played_at_ms, p.track_id, ts.song,
       ROW_NUMBER() OVER (PARTITION BY ts.song ORDER BY p.played_at_ms, p.track_id)
  FROM plays p JOIN track_songs ts ON ts.track_id = p.track_id;
