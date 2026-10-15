/**
 * Upkeep for the trigram name index behind /api/plays?q= (migration 0011).
 *
 * Each track has one row of text, "title | album | artist | …", kept in
 * track_search_text; triggers mirror it into the FTS5 table. A track's text
 * changes when it is first stored, when a poll fills in its album, or when an
 * artist is renamed or merged, so polls and imports sync the tracks they
 * wrote and the daily cron syncs everything to catch the rest (album
 * backfills, for one).
 */

/** The searchable text of track `t`. Must match the backfill in migration 0011. */
export const searchText = (t: string) =>
  `${t}.name || ' | ' || COALESCE((SELECT al.name FROM albums al WHERE al.album_id = ${t}.album_id), '') || ' | ' ||
   COALESCE((SELECT group_concat(a.name, ' | ')
               FROM track_artists ta JOIN artists a ON a.artist_id = ta.artist_id
              WHERE ta.track_id = ${t}.track_id), '')`;

/**
 * Inserts missing rows and rewrites changed ones, for `trackIds` or, without
 * them, every track. The WHERE guard keeps an unchanged track at zero writes,
 * so syncing a poll's tracks costs a few row reads each in steady state.
 */
export function syncSearchIndex(db: D1Database, trackIds?: string[]): D1PreparedStatement {
  // Always a WHERE: without one SQLite reads ON CONFLICT as a join's ON.
  const scope = trackIds ? 'WHERE t.track_id IN (SELECT value FROM json_each(?1))' : 'WHERE true';
  const statement = db.prepare(
    `INSERT INTO track_search_text (track_id, text)
     SELECT t.track_id, ${searchText('t')} FROM tracks t ${scope}
     ON CONFLICT(track_id) DO UPDATE SET text = excluded.text WHERE text IS NOT excluded.text`,
  );
  return trackIds ? statement.bind(JSON.stringify(trackIds)) : statement;
}

/**
 * The phrase query for a substring, or null when the trigram index cannot
 * answer it (fewer than three characters). Inside double quotes FTS5 treats
 * everything literally except a doubled quote.
 */
export function trigramPhrase(q: string): string | null {
  return [...q].length < 3 ? null : `"${q.replace(/"/g, '""')}"`;
}
