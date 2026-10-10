import { HISTORY_START_MS, type Era, startOfLocalWeek } from '../eras';
import { PRIMARY_ARTIST_SQL } from './sql';

/**
 * The most-played albums, counting only albums with at least MIN_SONGS
 * different songs played. Without that floor the list is mostly singles and
 * one song on loop, which on-repeat already covers; this is meant to show
 * records listened to as records.
 *
 * Albums are grouped by lowercased name + lead artist, which folds deluxe,
 * clean and re-release ids together; the art comes from the most-played id.
 * The data stops at the start of this week, like rhythm and top-over-time.
 */

const LIMIT = 10;
const MIN_SONGS = 4;

export interface TopAlbum {
  name: string;
  artist: string;
  image: string | null;
  plays: number;
  songs: number;
  /** Months of the first and latest play. */
  from: string;
  to: string;
}

export interface TopAlbums {
  as_of: string;
  min_songs: number;
  albums: TopAlbum[];
}

export async function computeTopAlbums(db: D1Database, now: number, eras: readonly Era[]): Promise<TopAlbums> {
  const cutoff = startOfLocalWeek(eras, now);
  // Counts per track come off the plays primary key first, so the artist
  // lookup runs once per track rather than once per play.
  const { results } = await db
    .prepare(
      `WITH pt AS MATERIALIZED (
         SELECT track_id, COUNT(*) AS n, MIN(played_at_ms) AS first_ms, MAX(played_at_ms) AS last_ms
           FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2 GROUP BY track_id
       ),
       t AS MATERIALIZED (
         SELECT pt.n, pt.first_ms, pt.last_ms, lower(tr.name) AS song, al.name AS album, al.image_url AS image,
                ${PRIMARY_ARTIST_SQL('pt.track_id')} AS artist
           FROM pt JOIN tracks tr ON tr.track_id = pt.track_id JOIN albums al ON al.album_id = tr.album_id
       ),
       k AS MATERIALIZED (
         SELECT *, lower(album) || '|' || lower(artist) AS k FROM t WHERE artist IS NOT NULL
       ),
       art AS MATERIALIZED (
         SELECT k, image FROM (SELECT k, image, ROW_NUMBER() OVER (PARTITION BY k ORDER BY n DESC) AS rk FROM k)
          WHERE rk = 1
       ),
       grouped AS (
         SELECT k, MAX(album) AS name, MAX(artist) AS artist, SUM(n) AS plays, COUNT(DISTINCT song) AS songs,
                MIN(first_ms) AS first_ms, MAX(last_ms) AS last_ms
           FROM k GROUP BY k HAVING songs >= ?3
       )
       SELECT g.name, g.artist, art.image, g.plays, g.songs,
              strftime('%Y-%m', g.first_ms / 1000, 'unixepoch') AS "from",
              strftime('%Y-%m', g.last_ms / 1000, 'unixepoch') AS "to"
         FROM grouped g JOIN art ON art.k = g.k
        ORDER BY g.plays DESC, g.name
        LIMIT ?4`,
    )
    .bind(HISTORY_START_MS, cutoff, MIN_SONGS, LIMIT)
    .all<TopAlbum>();

  return { as_of: new Date(cutoff).toISOString(), min_songs: MIN_SONGS, albums: results };
}
