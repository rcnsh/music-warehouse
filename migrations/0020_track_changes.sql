-- Migration 0020: mark the tracks whose search text or song key may change.
--
-- The daily cron used to rebuild every track's search text (migration 0011)
-- and song key (0012) to catch what the writes themselves miss, such as
-- album backfills and the artist reconcile: 150k to 200k rows read a day
-- with nothing changed. Both depend only on a track's name and album and on
-- its credits, so these triggers mark a track when any of those changes, and
-- the cron syncs the marked tracks and clears the marks.
--
-- Albums and artists are only ever inserted, never renamed, so their rows
-- need no trigger: a track gains an album's name by its album_id changing.
--
-- ON CONFLICT DO NOTHING rather than INSERT OR IGNORE: an outer statement's
-- conflict algorithm (the default ABORT) overrides a trigger's OR clause.
CREATE TABLE track_changes (
  track_id TEXT PRIMARY KEY
) WITHOUT ROWID;

CREATE TRIGGER tracks_changes_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO track_changes (track_id) VALUES (NEW.track_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER tracks_changes_au AFTER UPDATE OF name, album_id ON tracks
  WHEN OLD.name IS NOT NEW.name OR OLD.album_id IS NOT NEW.album_id BEGIN
  INSERT INTO track_changes (track_id) VALUES (NEW.track_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER track_artists_changes_ai AFTER INSERT ON track_artists BEGIN
  INSERT INTO track_changes (track_id) VALUES (NEW.track_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER track_artists_changes_au AFTER UPDATE ON track_artists BEGIN
  INSERT INTO track_changes (track_id) VALUES (OLD.track_id), (NEW.track_id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER track_artists_changes_ad AFTER DELETE ON track_artists BEGIN
  INSERT INTO track_changes (track_id) VALUES (OLD.track_id) ON CONFLICT DO NOTHING;
END;

-- The first sweep after this migration covers every track once, as before.
INSERT INTO track_changes (track_id) SELECT track_id FROM tracks;
