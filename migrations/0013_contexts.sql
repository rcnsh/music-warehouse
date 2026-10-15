-- Migration 0013: a name for each context a play was started from.
--
-- Plays store context_uri ("spotify:playlist:…") but not what it was called.
-- Albums and artists are named from the local tables. Everything else is
-- looked up from Spotify a few at a time by the poll (src/contexts.ts):
-- fetched_ms NULL means not yet asked. Spotify refuses third-party apps many
-- editorial and algorithmic playlists with a 404, so a refusal is kept as a
-- NULL name with its fetched_ms, and asked again only after a long interval.
CREATE TABLE contexts (
  uri        TEXT PRIMARY KEY,
  type       TEXT,
  name       TEXT,
  fetched_ms INTEGER
);
CREATE INDEX idx_contexts_fetched ON contexts(fetched_ms);

-- Must match insertContexts() in src/contexts.ts.
INSERT INTO contexts (uri, type, name, fetched_ms)
SELECT c.uri, c.type, n.name, CASE WHEN n.name IS NULL THEN NULL ELSE 0 END
  FROM (SELECT DISTINCT context_uri AS uri, context_type AS type FROM plays WHERE context_uri IS NOT NULL) c
  LEFT JOIN (
    SELECT 'spotify:album:' || album_id AS uri, name FROM albums
    UNION ALL SELECT 'spotify:artist:' || artist_id, name FROM artists
  ) n ON n.uri = c.uri;
