-- Migration 0005: index tracks(isrc).
--
-- relabelEditions() (live.ts) finds every stored copy of each /api/top track by
-- ISRC. Without this index that match is a full scan of `tracks` for every
-- entry — measured at 360,730 rows read and 254ms for a 50-track list, on every
-- uncached request for the /music page.
CREATE INDEX idx_tracks_isrc ON tracks(isrc);
