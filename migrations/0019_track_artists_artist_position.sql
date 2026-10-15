-- Migration 0019: index an artist's credits by position, with the track.
--
-- /api/artist, /api/plays?artist_id=, /api/daily?artist_id= and /api/search
-- find an artist's tracks by its primary credits (position 0). Through
-- idx_track_artists_artist(artist_id) each credit is a seek into the table
-- for its position and track, secondary credits included. This index holds
-- both, so the lookup reads the primary credits from the index alone. It
-- serves every lookup by artist_id the old one did, so that one goes.
CREATE INDEX idx_track_artists_artist_pos ON track_artists(artist_id, position, track_id);
DROP INDEX idx_track_artists_artist;
