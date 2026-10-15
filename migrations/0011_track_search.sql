-- Migration 0011: a trigram full-text index over each track's searchable names.
--
-- /api/plays?q= used to find matching tracks with LIKE scans of tracks,
-- albums and artists: about 11k rows read per search page, whatever the
-- query. A trigram FTS5 index answers the same substring match by lookup,
-- reading about one row per matching track (4 rows for "divinity").
--
-- track_search_text holds one row per track: "title | album | artist | …".
-- Its INTEGER PRIMARY KEY gives the index a rowid that VACUUM cannot
-- renumber, and track_id is UNIQUE so the Worker can upsert by it. The
-- triggers keep the external-content index in step with it.
--
-- remove_diacritics folds accents ("rose" finds "ROSÉ"), and the trigram
-- tokenizer folds case beyond ASCII, which LIKE cannot. Queries shorter than
-- three characters find nothing in a trigram index; the Worker uses LIKE for
-- those.
CREATE TABLE track_search_text (
  id       INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL UNIQUE,
  text     TEXT NOT NULL
);

CREATE VIRTUAL TABLE track_search USING fts5(
  text,
  content = 'track_search_text',
  content_rowid = 'id',
  tokenize = 'trigram remove_diacritics 1'
);

CREATE TRIGGER track_search_text_ai AFTER INSERT ON track_search_text BEGIN
  INSERT INTO track_search (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER track_search_text_ad AFTER DELETE ON track_search_text BEGIN
  INSERT INTO track_search (track_search, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER track_search_text_au AFTER UPDATE ON track_search_text BEGIN
  INSERT INTO track_search (track_search, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO track_search (rowid, text) VALUES (new.id, new.text);
END;

-- Must match searchText() in src/search-index.ts.
INSERT INTO track_search_text (track_id, text)
SELECT t.track_id,
       t.name || ' | ' || COALESCE((SELECT al.name FROM albums al WHERE al.album_id = t.album_id), '') || ' | ' ||
       COALESCE((SELECT group_concat(a.name, ' | ')
                   FROM track_artists ta JOIN artists a ON a.artist_id = ta.artist_id
                  WHERE ta.track_id = t.track_id), '')
  FROM tracks t;
