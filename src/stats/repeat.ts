import { type Era, startOfLocalToday } from '../eras';
import { countedSql, gapWindowSql } from '../listen';
import { SONG_SQL } from '../songs';

/**
 * What's on repeat now.
 *
 * Skips (src/listen.ts) are dropped. The export carries every skip (22% of
 * its rows are provably short), and without this a 2020 skipping spree
 * outranks songs actually on repeat.
 *
 * Songs are keyed as play numbers key them (src/songs.ts): the title less
 * any edition tag, and the lead artist's name. That folds
 * single, album, remastered and clean/explicit ids of the same recording,
 * and an export-era copy (artist keyed `name:`) with its live one.
 *
 * Privacy: on-repeat counts whole local days, ending at the midnight that
 * started today, so its per-day counts change once a day and never say when
 * within a day anything was played.
 */

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 14;
const BASELINE_DAYS = 90;
const TRACK_LIMIT = 10;
const ALBUM_LIMIT = 5;

export interface RepeatTrack {
  track_id: string;
  name: string;
  artists: string;
  album: string | null;
  image: string | null;
  plays: number;
  days: number;
  /** Plays per local day over the window, oldest first; the last is yesterday. */
  daily: number[];
}

export interface RepeatAlbum {
  name: string;
  artist: string;
  image: string | null;
  tracks_on_repeat: number;
  plays: number;
}

export interface OnRepeat {
  as_of: string;
  window_days: number;
  tracks: RepeatTrack[];
  albums: RepeatAlbum[];
}



const ARTISTS_OF = (column: string) =>
  `(SELECT group_concat(name, ', ') FROM (SELECT a.name FROM track_artists ta JOIN artists a ON a.artist_id = ta.artist_id
     WHERE ta.track_id = ${column} ORDER BY ta.position))`;

// The window plus the baseline before it, read off the plays primary key, so
// the cost follows recent listening rather than the size of the history.
// D1 binds JS numbers as REAL, and day arithmetic needs integer division,
// hence the cast.
const CURRENT_CTE = `
  WITH params AS (SELECT CAST(?1 AS INTEGER) AS now_ms),
  recent AS (
    SELECT played_at_ms, track_id,
           ${gapWindowSql('played_at_ms')} AS gap_ms
      FROM plays
     WHERE played_at_ms >= (SELECT now_ms FROM params) - ${(WINDOW_DAYS + BASELINE_DAYS) * DAY_MS}
       AND played_at_ms < (SELECT now_ms FROM params)
  ),
  counted AS (
    SELECT r.played_at_ms, r.track_id, ((SELECT now_ms FROM params) - r.played_at_ms) / ${DAY_MS} AS day_ago,
           ${SONG_SQL('r.track_id')} AS song
      FROM recent r JOIN tracks t ON t.track_id = r.track_id
     WHERE ${countedSql('r.gap_ms')}
  ),
  agg AS (
    SELECT song, max(played_at_ms) AS last_ms,
           track_id,  -- bare column: the track_id of the max(played_at_ms) row
           sum(day_ago < ${WINDOW_DAYS}) AS plays,
           count(DISTINCT CASE WHEN day_ago < ${WINDOW_DAYS} THEN day_ago END) AS days,
           sum(day_ago >= ${WINDOW_DAYS}) AS base_plays,
           json_array(${Array.from({ length: WINDOW_DAYS }, (_, i) => `sum(day_ago = ${WINDOW_DAYS - 1 - i})`).join(', ')}) AS daily
      FROM counted GROUP BY song
  ),
  ranked AS (
    -- A track with no album stands alone rather than sharing one NULL partition.
    SELECT a.*, coalesce(t.album_id, 'track:' || a.track_id) AS album_key, t.album_id,
           row_number() OVER (PARTITION BY coalesce(t.album_id, 'track:' || a.track_id)
                              ORDER BY a.plays DESC, a.days DESC, a.last_ms DESC) AS album_rank
      FROM agg a JOIN tracks t ON t.track_id = a.track_id
     -- At least five plays across three separate days (one looped evening
     -- isn't an obsession), and twice the song's own usual rate (+1 so a new
     -- song has a baseline to beat).
     WHERE a.plays >= 5 AND a.days >= 3
       AND a.plays >= 2 * (a.base_plays + 1) * ${WINDOW_DAYS}.0 / ${BASELINE_DAYS}
  )`;

export async function computeOnRepeat(db: D1Database, now: number, eras: readonly Era[]): Promise<OnRepeat> {
  const asOf = startOfLocalToday(eras, now);

  // A discography run would fill the list with one album, so tracks are one
  // per album and albums with several songs on repeat are listed apart. Both
  // lists come from one statement so the window is scanned once.
  const { results } = await db
    .prepare(
      `${CURRENT_CTE}
       SELECT * FROM (
         SELECT 'track' AS kind, r.track_id, t.name, ${ARTISTS_OF('r.track_id')} AS artists,
                al.name AS album, al.image_url AS image, r.plays, r.days, r.daily, NULL AS tracks_on_repeat
           FROM ranked r JOIN tracks t ON t.track_id = r.track_id LEFT JOIN albums al ON al.album_id = r.album_id
          WHERE r.album_rank = 1
          ORDER BY r.plays DESC, r.days DESC, r.last_ms DESC
          LIMIT ${TRACK_LIMIT}
       )
       UNION ALL
       SELECT * FROM (
         SELECT 'album', NULL, al.name,
                (SELECT group_concat(a.name, ', ') FROM track_artists ta JOIN artists a ON a.artist_id = ta.artist_id
                  WHERE ta.track_id = min(r.track_id) AND ta.position = 0),
                NULL, al.image_url, sum(r.plays), NULL, NULL, count(*)
           FROM ranked r JOIN albums al ON al.album_id = r.album_id
          GROUP BY r.album_id HAVING count(*) >= 4
          ORDER BY sum(r.plays) DESC LIMIT ${ALBUM_LIMIT}
       )`,
    )
    .bind(asOf)
    .all<{
      kind: 'track' | 'album';
      track_id: string;
      name: string;
      artists: string | null;
      album: string | null;
      image: string | null;
      plays: number;
      days: number;
      daily: string;
      tracks_on_repeat: number;
    }>();

  return {
    as_of: new Date(asOf).toISOString(),
    window_days: WINDOW_DAYS,
    tracks: results
      .filter((row) => row.kind === 'track')
      .map((row) => ({
        track_id: row.track_id,
        name: row.name,
        artists: row.artists ?? '',
        album: row.album,
        image: row.image,
        plays: row.plays,
        days: row.days,
        daily: JSON.parse(row.daily) as number[],
      })),
    albums: results
      .filter((row) => row.kind === 'album')
      .map((row) => ({
        name: row.name,
        artist: row.artists ?? '',
        image: row.image,
        tracks_on_repeat: row.tracks_on_repeat,
        plays: row.plays,
      })),
  };
}
