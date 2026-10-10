/**
 * The credited lead artist of a track, as a correlated subquery.
 *
 * A handful of tracks carry two position-0 rows (a soundtrack credited to
 * both the franchise and the singer); taking one keeps every play counted
 * exactly once.
 */
export const PRIMARY_ARTIST_SQL = (trackIdColumn: string) =>
  `(SELECT a.name FROM track_artists ta JOIN artists a ON a.artist_id = ta.artist_id
     WHERE ta.track_id = ${trackIdColumn} AND ta.position = 0 ORDER BY a.artist_id LIMIT 1)`;
