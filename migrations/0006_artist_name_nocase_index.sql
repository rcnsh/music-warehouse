-- Migration 0006: index artists(name) case-insensitively.
--
-- /api/artist and /api/track fold artists by lowercased name, as the stats
-- do, so a `name:` placeholder from the export and the real id are one
-- artist. idx_artists_name is BINARY and cannot serve `name = ? COLLATE
-- NOCASE`, which would otherwise scan all of `artists` on every request.
-- NOCASE folds ASCII only, exactly as SQLite's lower() does without ICU.
CREATE INDEX idx_artists_name_nocase ON artists(name COLLATE NOCASE);
