import { songTitleSql } from './song-title';
import { PRIMARY_ARTIST_SQL } from './stats/sql';
import { type TrackScope, trackScope } from './search-index';

/**
 * Upkeep for play numbers (migration 0012): which play of its song each play
 * was, counting every edition of the song, as /api/track folds them.
 *
 * A song's key is its title, lowercased (ASCII only, as SQLite's lower() is)
 * with any edition tag taken off (src/song-title.ts), and its primary
 * artist's name, lowercased. Tracks with two primary credits take the first
 * by id, as PRIMARY_ARTIST_SQL does everywhere. /api/track, /api/top-tracks
 * and on-repeat fold editions by this key.
 *
 * Every write that stores plays runs songStatements, after its tracks and
 * artists are in place: rekey the tracks it wrote, renumber whole any song a
 * rekey touched, then renumber each new play's song from that play on. A
 * poll's plays are newer than everything else, so that last step reads one
 * index seek per song plus the new plays; an import of older plays renumbers
 * the rest of each song it lands in. Keys change when a track's title or
 * primary artist does, which the daily artist reconcile can do to tracks a
 * write never names, so the daily cron rekeys the tracks marked changed
 * since its last run (migration 0020), writing only what changed. When the
 * key itself changes, as it did when edition tags began to be taken off, a
 * migration rekeys every track once (0016_song_edition_tags, generated from
 * syncAllSongs).
 */

/** The song key of track `t`. */
export const songKey = (t: string) =>
  `COALESCE(${songTitleSql(`lower(${t}.name)`)} || char(31) || lower(${PRIMARY_ARTIST_SQL(`${t}.track_id`)}), char(30) || ${t}.track_id)`;

const UPSERT = `ON CONFLICT(played_at_ms, track_id) DO UPDATE SET song = excluded.song, n = excluded.n
     WHERE play_numbers.song IS NOT excluded.song OR play_numbers.n IS NOT excluded.n`;

/** Record each track's current key, keeping the old one when it changes. */
function rekey(db: D1Database, tracks?: TrackScope): D1PreparedStatement {
  const scope = trackScope(tracks);
  return scope.bind(
    db.prepare(
      `INSERT INTO track_songs (track_id, song)
       SELECT t.track_id, ${songKey('t')} FROM tracks t ${scope.where}
       ON CONFLICT(track_id) DO UPDATE
          SET song = excluded.song, previous = COALESCE(track_songs.previous, track_songs.song), dirty = 1
        WHERE track_songs.song IS NOT excluded.song`,
    ),
  );
}

/** Renumber from scratch every song a rekey moved a track into or out of, then clear the marks. */
function renumberRekeyed(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT INTO play_numbers (played_at_ms, track_id, song, n)
       SELECT p.played_at_ms, p.track_id, ts.song,
              ROW_NUMBER() OVER (PARTITION BY ts.song ORDER BY p.played_at_ms, p.track_id)
         FROM track_songs ts JOIN plays p ON p.track_id = ts.track_id
        WHERE ts.song IN (SELECT song FROM track_songs WHERE dirty = 1
                          UNION SELECT previous FROM track_songs WHERE dirty = 1)
       ${UPSERT}`,
    ),
    db.prepare('UPDATE track_songs SET previous = NULL, dirty = 0 WHERE dirty = 1'),
  ];
}

/**
 * Number `plays` and renumber whatever follows them in their songs. Each
 * song continues from the number of its last play before the earliest new
 * one, which is already right, so only that play onwards is read.
 */
function numberPlays(db: D1Database, plays: Array<{ played_at_ms: number; track_id: string }>): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO play_numbers (played_at_ms, track_id, song, n)
       WITH new AS (
              SELECT p.played_at_ms, ts.song FROM json_each(?1) j
                JOIN plays p ON p.played_at_ms = json_extract(j.value, '$[0]') AND p.track_id = json_extract(j.value, '$[1]')
                JOIN track_songs ts ON ts.track_id = p.track_id
            ),
            touched AS (SELECT song, MIN(played_at_ms) AS t0 FROM new GROUP BY song),
            base AS (
              SELECT song, t0,
                     COALESCE((SELECT x.n FROM play_numbers x WHERE x.song = touched.song AND x.played_at_ms < touched.t0
                                ORDER BY x.played_at_ms DESC, x.track_id DESC LIMIT 1), 0) AS b
                FROM touched
            ),
            tail AS (
              SELECT p.played_at_ms, p.track_id, base.song, base.b FROM base
                JOIN track_songs ts ON ts.song = base.song
                JOIN plays p ON p.track_id = ts.track_id AND p.played_at_ms >= base.t0
            )
       SELECT played_at_ms, track_id, song, b + ROW_NUMBER() OVER (PARTITION BY song ORDER BY played_at_ms, track_id)
         FROM tail WHERE true
       ${UPSERT}`,
    )
    .bind(JSON.stringify(plays.map((play) => [play.played_at_ms, play.track_id])));
}

/** Statements that keep play numbers right after a write of these tracks and plays. */
export function songStatements(
  db: D1Database,
  trackIds: string[],
  plays: Array<{ played_at_ms: number; track_id: string }>,
): D1PreparedStatement[] {
  if (plays.length === 0 && trackIds.length === 0) return [];
  return [
    rekey(db, [...new Set([...trackIds, ...plays.map((play) => play.track_id)])]),
    ...renumberRekeyed(db),
    ...(plays.length ? [numberPlays(db, plays)] : []),
  ];
}

/**
 * Renumber whole every song these tracks are in, for after plays are removed:
 * every later play of the song moves down. Delete the removed plays' own
 * play_numbers rows first, since this only rewrites plays that remain.
 */
export function renumberSongsOf(db: D1Database, trackIds: string[]): D1PreparedStatement[] {
  if (trackIds.length === 0) return [];
  return [
    db.prepare('UPDATE track_songs SET dirty = 1 WHERE track_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(trackIds)),
    ...renumberRekeyed(db),
  ];
}

/** Rekey every track and renumber any song that changed. */
export function syncAllSongs(db: D1Database): D1PreparedStatement[] {
  return [rekey(db), ...renumberRekeyed(db)];
}

/** Rekey the tracks marked in track_changes (migration 0017) and renumber any song that changed. */
export function syncChangedSongs(db: D1Database): D1PreparedStatement[] {
  return [rekey(db, 'changed'), ...renumberRekeyed(db)];
}
