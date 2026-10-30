import { isNameKey, reconcileArtists } from './artists';
import { insertContexts } from './contexts';
import { songStatements, syncChangedSongs } from './play-numbers';
import { syncSearchIndex } from './search-index';
import type { NormalizedRows, OAuthToken, SyncState } from './types';

/**
 * D1 allows at most 100 bound parameters per statement, and that limit applies
 * to each statement inside a batch (verified: developers.cloudflare.com/d1/platform/limits).
 * Multi-row inserts are therefore chunked to fit the budget. All chunks still
 * go out in a single db.batch() call, so the whole write stays one subrequest (R12).
 */
export const MAX_BOUND_PARAMS = 100;

export function chunkSize(columns: number): number {
  return Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns));
}

/**
 * Build chunked multi-row INSERT statements for `rows`.
 * `conflictClause` is appended verbatim (e.g. "ON CONFLICT(...) DO UPDATE ...").
 */
export function buildInserts<T extends Record<string, unknown>>(
  db: D1Database,
  table: string,
  columns: string[],
  rows: T[],
  options: { verb?: 'INSERT' | 'INSERT OR IGNORE' | 'INSERT OR REPLACE'; conflictClause?: string } = {},
): D1PreparedStatement[] {
  if (rows.length === 0) return [];

  const verb = options.verb ?? 'INSERT OR IGNORE';
  const conflict = options.conflictClause ? ` ${options.conflictClause}` : '';
  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  const perStatement = chunkSize(columns.length);

  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const sql =
      `${verb} INTO ${table} (${columns.join(', ')}) VALUES ` +
      chunk.map(() => rowPlaceholder).join(', ') +
      conflict;
    const binds: unknown[] = [];
    for (const row of chunk) {
      for (const column of columns) binds.push(row[column] ?? null);
    }
    statements.push(db.prepare(sql).bind(...binds));
  }
  return statements;
}

/**
 * The daily catch-all after the writes' own upkeep: reconcile every
 * name-keyed artist, then sync the search text and song keys of the tracks
 * marked changed since the last run (migration 0020), which include those
 * the reconcile just touched, and clear the marks. The syncs follow the
 * reconcile so they see merged artists. One batch, so a mark is cleared only
 * with its track synced.
 */
export function dailyTrackSweep(db: D1Database): D1PreparedStatement[] {
  return [
    ...reconcileArtists(db),
    syncSearchIndex(db, 'changed'),
    ...syncChangedSongs(db),
    db.prepare('DELETE FROM track_changes'),
  ];
}

/**
 * How many of `plays` are already stored, for leading a write batch. The
 * batch is one transaction, so what it inserts is the rest. meta.changes
 * can't say: D1 counts the rollup triggers' writes in it too.
 */
export function countStoredPlays(db: D1Database, plays: Array<{ played_at_ms: number; track_id: string }>): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM json_each(?) j
         JOIN plays p ON p.played_at_ms = json_extract(j.value, '$[0]') AND p.track_id = json_extract(j.value, '$[1]')`,
    )
    .bind(JSON.stringify(plays.map((play) => [play.played_at_ms, play.track_id])));
}

/** Read both singleton rows in one round trip (one subrequest). */
export async function readState(db: D1Database): Promise<{ sync: SyncState; token: OAuthToken }> {
  const [syncResult, tokenResult] = await db.batch<Record<string, unknown>>([
    db.prepare(
      'SELECT cursor_ms, last_success_ms, last_error, last_error_ms, consecutive_failures FROM sync_state WHERE id = 1',
    ),
    db.prepare(
      'SELECT access_token, access_expires_ms, refresh_token, authorized_at_ms, needs_reauth, spotify_user_id FROM oauth_token WHERE id = 1',
    ),
  ]);

  const sync = syncResult?.results?.[0] as unknown as SyncState | undefined;
  const token = tokenResult?.results?.[0] as unknown as OAuthToken | undefined;

  if (!sync || !token) {
    throw new Error('Singleton rows missing — run `wrangler d1 migrations apply` first.');
  }
  return { sync, token };
}

/**
 * Statements that write one normalized payload.
 *
 * Artists and albums take the payload's name, release date and cover when
 * they differ, so a rename or a new cover reaches the warehouse. The search
 * text and song keys of the poll's own tracks follow at once; other tracks
 * of a renamed artist or album catch up in the daily sweep.
 *
 * `tracks` upserts rather than ignoring so that an API poll upgrades a stub row
 * left behind by the export importer (which knows a track's name but not its
 * duration, album or ISRC) or by the album backfill (Saved Albums return
 * simplified tracks, which carry a duration but no ISRC). The WHERE guard
 * means a row is rewritten only when the payload fills a hole in it, keeping
 * steady-state row writes at zero.
 */
export function writeStatements(db: D1Database, rows: NormalizedRows, now = Date.now()): D1PreparedStatement[] {
  return [
    ...buildInserts(db, 'plays', ['played_at_ms', 'track_id', 'context_uri', 'context_type', 'source'],
      rows.plays.map((play) => ({ ...play, source: 'api' }))),

    ...buildInserts(db, 'tracks', ['track_id', 'name', 'duration_ms', 'album_id', 'isrc', 'first_seen_ms'],
      rows.tracks, {
        verb: 'INSERT',
        conflictClause:
          'ON CONFLICT(track_id) DO UPDATE SET ' +
          'name = excluded.name, ' +
          'duration_ms = COALESCE(excluded.duration_ms, tracks.duration_ms), ' +
          'album_id = COALESCE(excluded.album_id, tracks.album_id), ' +
          'isrc = COALESCE(excluded.isrc, tracks.isrc), ' +
          'first_seen_ms = MIN(tracks.first_seen_ms, excluded.first_seen_ms) ' +
          // Fire only when this payload actually supplies something the row
          // lacks. Testing `tracks.isrc IS NULL` alone would rewrite every
          // track that genuinely has no ISRC on every single poll; pairing it
          // with `excluded.<column> IS NOT NULL` keeps steady state at zero
          // writes while still healing a partially-filled row.
          'WHERE tracks.first_seen_ms > excluded.first_seen_ms ' +
          'OR (tracks.duration_ms IS NULL AND excluded.duration_ms IS NOT NULL) ' +
          'OR (tracks.album_id IS NULL AND excluded.album_id IS NOT NULL) ' +
          'OR (tracks.isrc IS NULL AND excluded.isrc IS NOT NULL)',
      }),

    // Artists and albums are renamed and re-covered on Spotify, so a poll
    // brings each up to date. A value the payload lacks never blanks a
    // stored one, and the WHERE guards keep an unchanged row at zero writes.
    // Rows the export importer keys by name (`name:`) never come from a poll.
    ...buildInserts(db, 'artists', ['artist_id', 'name'], rows.artists, {
      verb: 'INSERT',
      conflictClause:
        "ON CONFLICT(artist_id) DO UPDATE SET name = excluded.name WHERE excluded.name <> '' AND artists.name IS NOT excluded.name",
    }),
    ...buildInserts(db, 'track_artists', ['track_id', 'artist_id', 'position'], rows.trackArtists),
    ...buildInserts(db, 'albums', ['album_id', 'name', 'release_date', 'image_url'], rows.albums, {
      verb: 'INSERT',
      conflictClause:
        'ON CONFLICT(album_id) DO UPDATE SET ' +
        "name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE albums.name END, " +
        'release_date = COALESCE(excluded.release_date, albums.release_date), ' +
        'image_url = COALESCE(excluded.image_url, albums.image_url) ' +
        "WHERE (excluded.name <> '' AND albums.name IS NOT excluded.name) " +
        'OR (excluded.release_date IS NOT NULL AND albums.release_date IS NOT excluded.release_date) ' +
        'OR (excluded.image_url IS NOT NULL AND albums.image_url IS NOT excluded.image_url)',
    }),
    // After the albums and artists, which name those contexts.
    ...insertContexts(db, rows.plays, now),

    // Runs last, after the real artists and links are in place: a poll that
    // teaches us an artist's real id retires every name-keyed row for it.
    ...reconcileArtists(db, {
      names: rows.artists.filter((a) => !isNameKey(a.artist_id)).map((a) => a.name),
      tracks: rows.trackArtists.map((link) => link.track_id),
    }),
    // After the reconcile, so the text names the artists the track ends up with.
    ...(rows.tracks.length ? [syncSearchIndex(db, [...new Set(rows.tracks.map((t) => t.track_id))])] : []),
    // Also after the reconcile: a song's key is its primary artist's name.
    ...songStatements(db, rows.tracks.map((t) => t.track_id), rows.plays),
  ];
}
