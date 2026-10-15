-- A pinned row was set by hand (PUT /admin/concert-artists): the daily check
-- never re-matches it. attraction_id NULL with pinned = 1 blocks a name.
ALTER TABLE concert_artists ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
