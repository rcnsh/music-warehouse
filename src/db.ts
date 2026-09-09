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
  options: { verb?: 'INSERT' | 'INSERT OR IGNORE'; conflictClause?: string } = {},
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
 * Prefix marking an artist row keyed by name rather than by Spotify id.
 *
 * The Extended Streaming History export carries artist *names* only, and the
 * catalog endpoints that would resolve them to ids are closed to apps in
 * Spotify's development mode. Export-era artists are therefore keyed
 * `name:<artist name>` — unambiguous, because a real Spotify id is 22
 * characters of base62 and can never contain a colon.
 */
export const NAME_KEY_PREFIX = 'name:';

/**
 * Fold name-keyed artists into their real id-keyed equivalents, by exact name.
 *
 * The export can only key an artist by name, so an artist heard both before and
 * after the Worker existed ends up as two rows — `name:Porter Robinson` and the
 * real Spotify id — and shows up twice in /api/top-artists. Once a live poll has
 * taught us the real id for a name, every name-keyed row for it is redundant.
 *
 * Three set-based statements, in order:
 *   1. Repoint links from the name key to the real id. `OR IGNORE` skips rows
 *      where the track already links to that real artist, leaving them for (2).
 *   2. Drop name-keyed links on tracks that now carry a real link.
 *   3. Delete name-keyed artist rows nothing points at any more.
 *
 * Runs on every write, so the name match must be indexable: it compares the
 * bare `artists.name` column (covered by idx_artists_name) against the key's
 * suffix, never `'name:' || name`, which no index can serve. Written the wrong
 * way round this reads 10.6 million rows per call instead of a few thousand.
 */
export function reconcileNameKeyedArtists(db: D1Database): D1PreparedStatement[] {
  // The name carried by a key, as a value the index on artists(name) can seek to.
  const nameOfKey = `substr(track_artists.artist_id, ${NAME_KEY_PREFIX.length + 1})`;
  return [
    db.prepare(
      `UPDATE OR IGNORE track_artists
          SET artist_id = (SELECT real.artist_id FROM artists real
                            WHERE real.name = ${nameOfKey}
                              AND real.artist_id NOT LIKE '${NAME_KEY_PREFIX}%')
        WHERE artist_id LIKE '${NAME_KEY_PREFIX}%'
          AND EXISTS (SELECT 1 FROM artists real
                       WHERE real.name = ${nameOfKey}
                         AND real.artist_id NOT LIKE '${NAME_KEY_PREFIX}%')`,
    ),
    db.prepare(
      `DELETE FROM track_artists
        WHERE artist_id LIKE '${NAME_KEY_PREFIX}%'
          AND EXISTS (SELECT 1 FROM track_artists real
                       WHERE real.track_id = track_artists.track_id
                         AND real.artist_id NOT LIKE '${NAME_KEY_PREFIX}%')`,
    ),
    db.prepare(
      `DELETE FROM artists
        WHERE artist_id LIKE '${NAME_KEY_PREFIX}%'
          AND NOT EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = artists.artist_id)`,
    ),
  ];
}

/** Read both singleton rows in one round trip (one subrequest). */
export async function readState(db: D1Database): Promise<{ sync: SyncState; token: OAuthToken }> {
  const [syncResult, tokenResult] = await db.batch<Record<string, unknown>>([
    db.prepare(
      'SELECT cursor_ms, last_success_ms, last_error, last_error_ms, consecutive_failures FROM sync_state WHERE id = 1',
    ),
    db.prepare(
      'SELECT access_token, access_expires_ms, refresh_token, authorized_at_ms, needs_reauth FROM oauth_token WHERE id = 1',
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
 * `tracks` upserts rather than ignoring so that an API poll upgrades a stub row
 * left behind by the export importer (which knows a track's name but not its
 * duration, album or ISRC). The WHERE guard means a track that is already
 * complete is not rewritten, keeping steady-state row writes near zero.
 */
export function writeStatements(db: D1Database, rows: NormalizedRows): D1PreparedStatement[] {
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
          'WHERE tracks.duration_ms IS NULL OR tracks.first_seen_ms > excluded.first_seen_ms',
      }),

    ...buildInserts(db, 'artists', ['artist_id', 'name'], rows.artists),
    ...buildInserts(db, 'track_artists', ['track_id', 'artist_id', 'position'], rows.trackArtists),
    ...buildInserts(db, 'albums', ['album_id', 'name', 'release_date', 'image_url'], rows.albums),

    // Runs last, after the real artists and links are in place: a poll that
    // teaches us an artist's real id retires every name-keyed row for it.
    ...reconcileNameKeyedArtists(db),
  ];
}
