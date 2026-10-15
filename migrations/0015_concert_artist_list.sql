-- Each event's matched artists as a JSON list of {id, name}, so a client can
-- link them without splitting `artists` on ", " (which breaks "Tyler, The
-- Creator"). NULL on rows stored before this column, until the next daily
-- check rewrites them.
ALTER TABLE concerts ADD COLUMN artist_list TEXT;
