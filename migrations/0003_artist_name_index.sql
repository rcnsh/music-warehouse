-- Migration 0003: index artists(name).
--
-- reconcileNameKeyedArtists() folds `name:<artist name>` rows into their real
-- id-keyed equivalents by matching on name. Without this index that match is a
-- full scan of `artists` for every name-keyed link — measured at 10.6 million
-- rows read on a 6,088-link table, which is far too much to run on every poll.
CREATE INDEX idx_artists_name ON artists(name);
