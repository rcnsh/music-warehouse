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
