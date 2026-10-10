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
 * The same list is also given for each UTC calendar year (as top-over-time's
 * years are), so the page can switch years without another request.
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
  years: Array<{ year: string; partial: boolean; albums: TopAlbum[] }>;
}

export async function computeTopAlbums(db: D1Database, now: number, eras: readonly Era[]): Promise<TopAlbums> {
  const cutoff = startOfLocalWeek(eras, now);
  // Counts per (year, track) come off the plays primary key first, and the
  // artist lookup runs once per track rather than once per play.
  const { results } = await db
    .prepare(
      `WITH pt AS MATERIALIZED (
         SELECT strftime('%Y', played_at_ms / 1000, 'unixepoch') AS y, track_id, COUNT(*) AS n,
                MIN(played_at_ms) AS first_ms, MAX(played_at_ms) AS last_ms
           FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2 GROUP BY y, track_id
       ),
       tr AS MATERIALIZED (
         SELECT tr.track_id, lower(tr.name) AS song, al.name AS album, al.image_url AS image,
                ${PRIMARY_ARTIST_SQL('tr.track_id')} AS artist
           FROM tracks tr JOIN albums al ON al.album_id = tr.album_id
          WHERE tr.track_id IN (SELECT track_id FROM pt)
       ),
       k AS MATERIALIZED (
         SELECT pt.y, pt.n, pt.first_ms, pt.last_ms, tr.song, tr.album, tr.image, tr.artist,
                lower(tr.album) || '|' || lower(tr.artist) AS k
           FROM pt JOIN tr ON tr.track_id = pt.track_id WHERE tr.artist IS NOT NULL
       ),
       art AS MATERIALIZED (
         SELECT k, image FROM (
           SELECT k, image, ROW_NUMBER() OVER (PARTITION BY k ORDER BY SUM(n) DESC) AS rk FROM k GROUP BY k, image
         ) WHERE rk = 1
       ),
       grouped AS (
         SELECT y, k, MAX(album) AS name, MAX(artist) AS artist, SUM(n) AS plays, COUNT(DISTINCT song) AS songs,
                MIN(first_ms) AS first_ms, MAX(last_ms) AS last_ms
           FROM k GROUP BY y, k HAVING songs >= ?3
         UNION ALL
         SELECT 'all', k, MAX(album), MAX(artist), SUM(n), COUNT(DISTINCT song), MIN(first_ms), MAX(last_ms)
           FROM k GROUP BY k HAVING COUNT(DISTINCT song) >= ?3
       ),
       ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY y ORDER BY plays DESC, name) AS rk FROM grouped
       )
       SELECT r.y, r.name, r.artist, art.image, r.plays, r.songs,
              strftime('%Y-%m', r.first_ms / 1000, 'unixepoch') AS "from",
              strftime('%Y-%m', r.last_ms / 1000, 'unixepoch') AS "to"
         FROM ranked r JOIN art ON art.k = r.k
        WHERE r.rk <= ?4
        ORDER BY r.y, r.rk`,
    )
    .bind(HISTORY_START_MS, cutoff, MIN_SONGS, LIMIT)
    .all<TopAlbum & { y: string }>();

  const strip = ({ y: _, ...album }: TopAlbum & { y: string }): TopAlbum => album;
  const currentYear = new Date(cutoff - 1).getUTCFullYear().toString();
  const yearKeys = [...new Set(results.map((row) => row.y))].filter((y) => y !== 'all').sort();
  return {
    as_of: new Date(cutoff).toISOString(),
    min_songs: MIN_SONGS,
    albums: results.filter((row) => row.y === 'all').map(strip),
    years: yearKeys.map((year) => ({
      year,
      partial: year === currentYear,
      albums: results.filter((row) => row.y === year).map(strip),
    })),
  };
}
