/**
 * Upkeep for the trigram name index behind /api/plays?q= (migration 0011).
 *
 * Each track has one row of text, "title | album | artist | …", kept in
 * track_search_text; triggers mirror it into the FTS5 table. A track's text
 * changes when it is first stored, when a poll fills in its album, or when an
 * artist is renamed or merged, so polls and imports sync the tracks they
 * wrote and the daily cron syncs the tracks marked changed since its last
 * run to catch the rest (album backfills, for one).
 */

/** The searchable text of track `t`. Must match the backfill in migration 0011. */
export const searchText = (t: string) =>
  `${t}.name || ' | ' || COALESCE((SELECT al.name FROM albums al WHERE al.album_id = ${t}.album_id), '') || ' | ' ||
   COALESCE((SELECT group_concat(a.name, ' | ')
               FROM track_artists ta JOIN artists a ON a.artist_id = ta.artist_id
              WHERE ta.track_id = ${t}.track_id), '')`;

/**
 * Which tracks an upkeep statement covers: these ids, those marked in
 * track_changes since the last daily sweep (migration 0020), or every track.
 */
export type TrackScope = string[] | 'changed' | undefined;

/** Scope `tracks t` to a TrackScope: the WHERE clause, and a statement binder. */
export function trackScope(tracks: TrackScope): { where: string; bind: (s: D1PreparedStatement) => D1PreparedStatement } {
  // Always a WHERE: without one SQLite reads ON CONFLICT as a join's ON.
  if (tracks === undefined) return { where: 'WHERE true', bind: (s) => s };
  if (tracks === 'changed') return { where: 'WHERE t.track_id IN (SELECT track_id FROM track_changes)', bind: (s) => s };
  return { where: 'WHERE t.track_id IN (SELECT value FROM json_each(?1))', bind: (s) => s.bind(JSON.stringify(tracks)) };
}

/**
 * Inserts missing rows and rewrites changed ones, for the scoped tracks. The
 * WHERE guard keeps an unchanged track at zero writes, so syncing a poll's
 * tracks costs a few row reads each in steady state.
 */
export function syncSearchIndex(db: D1Database, tracks?: TrackScope): D1PreparedStatement {
  const scope = trackScope(tracks);
  return scope.bind(
    db.prepare(
      `INSERT INTO track_search_text (track_id, text)
       SELECT t.track_id, ${searchText('t')} FROM tracks t ${scope.where}
       ON CONFLICT(track_id) DO UPDATE SET text = excluded.text WHERE text IS NOT excluded.text`,
    ),
  );
}

/**
 * The phrase query for a substring, or null when the trigram index cannot
 * answer it (fewer than three characters). Inside double quotes FTS5 treats
 * everything literally except a doubled quote.
 */
export function trigramPhrase(q: string): string | null {
  return [...q].length < 3 ? null : `"${q.replace(/"/g, '""')}"`;
}
