/**
 * Artist identity: which stored artist rows are one artist, and which of them
 * speaks for it.
 *
 * The Extended Streaming History export carries artist *names* only, and the
 * catalog endpoints that would resolve them to ids are closed to apps in
 * Spotify's development mode. Export-era artists are therefore keyed
 * `name:<artist name>` (a placeholder), unambiguous because a real Spotify id
 * is 22 characters of base62 and can never contain a colon.
 *
 * One rule decides identity everywhere, in the merge and in the reads:
 * **artists are the same when their names are equal ignoring ASCII case.**
 * That is SQLite's NOCASE collation and its lower() without ICU, which D1
 * lacks; A–Z fold, every other character (É, ß, Cyrillic, …) compares
 * exactly. A Unicode fold would be kinder to "Sigur Rós" vs "SIGUR RÓS", but
 * SQL could not apply it, so the reads and the merge would disagree again;
 * one rule everywhere beats a better rule in some places. In SQL write
 * `= … COLLATE NOCASE` (served by idx_artists_name_nocase, migration 0006)
 * or `lower(…)`; in TypeScript use foldArtistName, never toLowerCase().
 *
 * Among the rows of one artist, a real id beats a placeholder however little
 * it was played; then the heavier (more plays or minutes, where the caller
 * has a weight); then the lowest artist_id, so a recompute picks the same.
 * The winner's id and spelling represent the artist.
 */

export const NAME_KEY_PREFIX = 'name:';
/** The first string after every `name:` key, so `>= prefix AND < end` is an index range. */
export const NAME_KEY_END = 'name;';

/** The placeholder key for an artist known only by name. */
export function nameKey(name: string): string {
  return `${NAME_KEY_PREFIX}${name}`;
}

export function isNameKey(artistId: string): boolean {
  return artistId.startsWith(NAME_KEY_PREFIX);
}

/** SQL: whether `column` holds a placeholder key, as a range an index can seek. */
export function isNameKeySql(column: string): string {
  return `(${column} >= '${NAME_KEY_PREFIX}' AND ${column} < '${NAME_KEY_END}')`;
}

/** The identity key of an artist name: ASCII-lowercased, as SQLite's lower() does. */
export function foldArtistName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** SQL ORDER BY terms putting the representative artist row first. */
export function preferredArtistOrderSql(idColumn: string): string {
  return `${isNameKeySql(idColumn)}, ${idColumn}`;
}

/**
 * SQL aggregate: the representative artist_id of a group of rows. Any bare
 * column beside it (e.g. the name) comes from the same row, as SQLite does
 * for a lone min() aggregate.
 */
export function preferredArtistIdSql(idColumn: string): string {
  return `substr(min(CASE WHEN ${isNameKeySql(idColumn)} THEN '1' ELSE '0' END || ${idColumn}), 2)`;
}

/** The representative of one artist's rows, by the rule above; undefined for none. */
export function preferredArtist<T extends { artist_id: string }>(
  rows: Iterable<T>,
  weight: (row: T) => number = () => 0,
): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    const placeholder = Number(isNameKey(row.artist_id)) - Number(isNameKey(best.artist_id));
    const heavier = weight(row) - weight(best);
    if (placeholder < 0 || (placeholder === 0 && (heavier > 0 || (heavier === 0 && row.artist_id < best.artist_id)))) {
      best = row;
    }
  }
  return best;
}

/**
 * Fold placeholders into the real artist sharing their name (by the rule
 * above), so `name:Porter robinson` from the export and the polled
 * `Porter Robinson` become one row once a poll has taught us the real id.
 *
 * Unscoped it sweeps every placeholder, sought as an index range; that runs
 * after an import and once a day. A poll passes `scope`: the names of the
 * real artists it brought and the tracks it credited, since a placeholder only
 * becomes mergeable when a real artist with its name arrives or a track it
 * credits gains a real link, and both happen in the poll that brings them
 * (about 200 rows read instead of 46k). The daily sweep catches anything a
 * poll misses, such as a placeholder orphaned through a track whose live
 * credit is spelled differently. Names and track ids travel as JSON, since D1
 * allows 100 bound parameters.
 *
 * Three set-based statements, in order:
 *   1. Repoint links from a placeholder to the real id. `OR IGNORE` skips rows
 *      where the track already links to that real artist, leaving them for (2).
 *   2. Drop placeholder links on tracks that now carry a real link.
 *   3. Delete placeholders nothing points at any more.
 *
 * Name matches must be indexable: they compare the bare `artists.name`
 * column (idx_artists_name_nocase) against the key's suffix, never
 * `'name:' || name`, which no index can serve. Written the wrong way round
 * this reads 10.6 million rows per call instead of a few thousand.
 */
export function reconcileArtists(
  db: D1Database,
  scope?: { names: Iterable<string>; tracks: Iterable<string> },
): D1PreparedStatement[] {
  const placeholder = isNameKeySql('artist_id');
  // The placeholders in scope: all of them, or those named like a polled artist.
  const placeholders = scope
    ? `(SELECT p.artist_id FROM json_each(?1) j JOIN artists p ON p.name = j.value COLLATE NOCASE
         WHERE ${isNameKeySql('p.artist_id')})`
    : `(SELECT artist_id FROM artists WHERE ${placeholder})`;
  const real = `FROM artists real
                 WHERE real.name = substr(track_artists.artist_id, ${NAME_KEY_PREFIX.length + 1}) COLLATE NOCASE
                   AND NOT ${isNameKeySql('real.artist_id')}`;
  const statements = [
    db.prepare(
      `UPDATE OR IGNORE track_artists
          SET artist_id = (SELECT real.artist_id ${real} ORDER BY real.artist_id LIMIT 1)
        WHERE artist_id IN ${placeholders}
          AND EXISTS (SELECT 1 ${real})`,
    ),
    db.prepare(
      `DELETE FROM track_artists
        WHERE ${placeholder}
          ${scope ? `AND (track_id IN (SELECT value FROM json_each(?2)) OR artist_id IN ${placeholders})` : ''}
          AND EXISTS (SELECT 1 FROM track_artists real
                       WHERE real.track_id = track_artists.track_id
                         AND NOT ${isNameKeySql('real.artist_id')})`,
    ),
    db.prepare(
      `DELETE FROM artists
        WHERE artist_id IN ${placeholders}
          AND NOT EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = artists.artist_id)`,
    ),
  ];
  if (!scope) return statements;
  const names = JSON.stringify([...new Set(scope.names)]);
  const tracks = JSON.stringify([...new Set(scope.tracks)]);
  return [statements[0]!.bind(names), statements[1]!.bind(names, tracks), statements[2]!.bind(names)];
}
