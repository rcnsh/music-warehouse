import { BadRequest, dateRange, fromRollup, intParam, timeZoneParam } from './api';
import { withTrackCounts } from './rollup';
import { NAME_KEY_PREFIX } from './db';
import { songTitle } from './song-title';
import { PRIMARY_ARTIST_SQL } from './stats/sql';
import { endOfLocalDayUtcMs, isRealDay, localCalendar, localDayKey, startOfLocalDayUtcMs } from './tz';
import type { Env } from './types';
import { FALLBACK_DURATION_MS, MIN_PLAY_MS } from './wrapped';

/**
 * One artist's or one track's whole history, and "on this day", for a client
 * app. Private like /api/plays: they name days.
 *
 * Artists are matched the way the stats group them: by id, and by lowercased
 * name, so the export's `name:` placeholders fold into the real id. Credit is
 * the primary artist's only, as everywhere else. A track folds the other
 * editions of the same song (same title, less any edition tag such as
 * "- 2011 Remaster", and primary artist), as Wrapped does.
 *
 * `plays` counts every stored play, as /api/top-artists does. `minutes` uses
 * Wrapped's estimate: a play ran for at most the gap since the play before it
 * (whatever track that was) and at most the track's length, and a play under
 * 30 s by that measure is a skip worth no minutes.
 *
 * Months and days are in the `tz` the caller asks for, as /api/daily's are.
 */

const TOP_ARTIST_TRACKS = 10;
const TOP_DAY_TRACKS = 5;
/** Spotify launched in October 2008; no play can be older. */
const FIRST_YEAR = 2008;

type PlayRow = { played_at_ms: number; track_id: string; ms: number };
type MetaRow = {
  track_id: string;
  name: string;
  artist: string | null;
  image: string | null;
  /** The `track_songs` key, where a query selects it. */
  song?: string;
};

interface Month {
  month: string;
  plays: number;
}

interface History {
  plays: number;
  minutes: number;
  first_played: string | null;
  last_played: string | null;
  months: Month[];
}

/**
 * Per-play listened time for the tracks in a CTE named `ts`. The gap to the
 * play before is one seek on the plays primary key per play, so this reads
 * about two rows per play rather than a window over the whole table.
 */
function playsSql(tracksCte: string): string {
  return `WITH ${tracksCte},
    p AS (
      SELECT p.played_at_ms, p.track_id,
             p.played_at_ms - (SELECT max(q.played_at_ms) FROM plays q WHERE q.played_at_ms < p.played_at_ms) AS gap_ms
        FROM plays p WHERE p.track_id IN (SELECT track_id FROM ts)
    )
    SELECT p.played_at_ms, p.track_id,
           CASE WHEN p.gap_ms IS NULL OR p.gap_ms >= ${MIN_PLAY_MS}
                THEN min(coalesce(p.gap_ms, ${FALLBACK_DURATION_MS}), coalesce(t.duration_ms, ${FALLBACK_DURATION_MS}))
                ELSE 0 END AS ms
      FROM p LEFT JOIN tracks t ON t.track_id = p.track_id
     ORDER BY p.played_at_ms`;
}

/**
 * Every track /api/artist credits to an artist: the tracks whose primary
 * artist is the id (?1) or shares its name, ignoring case, which folds the
 * export's `name:` placeholders in. The name is the stored one when the id is
 * known, else the caller's (?2). Defines `a`, the folded artists, and `ts`.
 */
export const ARTIST_TRACKS_CTE = `n AS (SELECT COALESCE((SELECT name FROM artists WHERE artist_id = ?1), ?2) AS name),
    a AS (
      SELECT artist_id, name FROM artists WHERE artist_id = ?1
      UNION SELECT artist_id, name FROM artists WHERE name = (SELECT name FROM n) COLLATE NOCASE
    ),
    ts AS (SELECT DISTINCT track_id FROM track_artists WHERE position = 0 AND artist_id IN (SELECT artist_id FROM a))`;

/**
 * Every edition of track ?1's song, as play numbers count them: the tracks
 * sharing its `track_songs` key, its title less any edition tag
 * (src/song-title.ts) under the same primary artist name. Defines `ts`; an
 * unknown track is only itself.
 */
export const SONG_TRACKS_CTE = `ts AS (
      SELECT ?1 AS track_id
      UNION SELECT track_id FROM track_songs WHERE song = (SELECT song FROM track_songs WHERE track_id = ?1)
    )`;

function metaSql(tracksCte: string): string {
  return `WITH ${tracksCte}
    SELECT t.track_id, t.name, ${PRIMARY_ARTIST_SQL('t.track_id')} AS artist, al.image_url AS image
      FROM tracks t LEFT JOIN albums al ON al.album_id = t.album_id
     WHERE t.track_id IN (SELECT track_id FROM ts)`;
}

export function textParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)?.trim() ?? '';
  if (value.length > 200) throw new BadRequest(`${name} is too long`);
  return value === '' ? null : value;
}

const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

/** Every month from the first to the last, quiet ones as zero, so a chart has no gaps. */
function monthsOf(plays: PlayRow[], timeZone: string): Month[] {
  const counts = new Map<string, number>();
  if (plays.length === 0) return [];
  // Plays come oldest first, so the first and last bound them.
  const calendar = localCalendar(timeZone, plays[0]!.played_at_ms, plays[plays.length - 1]!.played_at_ms + 1);
  for (const play of plays) {
    const month = calendar.dayOf(play.played_at_ms).slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  const keys = [...counts.keys()].sort();
  if (keys.length === 0) return [];
  const months: Month[] = [];
  let [year, month] = keys[0]!.split('-').map(Number) as [number, number];
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    months.push({ month: key, plays: counts.get(key) ?? 0 });
    if (key >= keys[keys.length - 1]!) break;
    month = month === 12 ? 1 : month + 1;
    if (month === 1) year++;
  }
  return months;
}

function historyOf(plays: PlayRow[], timeZone: string): History {
  return {
    plays: plays.length,
    minutes: Math.round(plays.reduce((sum, play) => sum + play.ms, 0) / 60_000),
    first_played: iso(plays[0]?.played_at_ms),
    last_played: iso(plays[plays.length - 1]?.played_at_ms),
    months: monthsOf(plays, timeZone),
  };
}

interface RankedTrack {
  id: string | null;
  name: string;
  artist: string | null;
  plays: number;
  image: string | null;
}

/**
 * Play counts per song, folding editions that share `key`. The id and the art
 * are the most-played edition's (the art the most-played edition that has any).
 */
function rankTracks(counts: Iterable<[string, number]>, meta: Map<string, MetaRow>, key: (row: MetaRow) => string): RankedTrack[] {
  const songs = new Map<string, { plays: number; editions: Array<[MetaRow, number]> }>();
  for (const [trackId, plays] of counts) {
    const row = meta.get(trackId);
    if (!row) continue;
    const song = songs.get(key(row)) ?? { plays: 0, editions: [] };
    song.plays += plays;
    song.editions.push([row, plays]);
    songs.set(key(row), song);
  }
  return [...songs.values()]
    .map((song) => {
      const editions = song.editions.sort((a, b) => b[1] - a[1] || a[0].track_id.localeCompare(b[0].track_id));
      const top = editions[0]![0];
      return {
        id: top.track_id,
        name: top.name,
        artist: top.artist,
        plays: song.plays,
        image: editions.find(([row]) => row.image)?.[0].image ?? null,
      };
    })
    .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
}

function countBy(plays: PlayRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const play of plays) counts.set(play.track_id, (counts.get(play.track_id) ?? 0) + 1);
  return counts;
}

export function respond(body: unknown, results: D1Result[]): Response {
  // Cost goes in a header rather than the body, so the body is exactly the
  // documented shape.
  const rowsRead = results.reduce((sum, result) => sum + (result.meta?.rows_read ?? 0), 0);
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Rows-Read': String(rowsRead) },
  });
}

/** GET /api/artist?id=&name=&tz= */
export async function artistRoute(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url, env);
  const id = textParam(url, 'id');
  const name = textParam(url, 'name');
  if (!id && !name) throw new BadRequest('id or name is required');

  const known = id
    ? await env.DB.prepare('SELECT name FROM artists WHERE artist_id = ?').bind(id).first<{ name: string }>()
    : null;
  const tracksCte = ARTIST_TRACKS_CTE;
  const binds = [id, name];
  const [playsResult, metaResult, artistsResult] = await env.DB.batch([
    env.DB.prepare(playsSql(tracksCte)).bind(...binds),
    env.DB.prepare(metaSql(tracksCte)).bind(...binds),
    env.DB.prepare(`WITH ${tracksCte} SELECT artist_id, name FROM a ORDER BY artist_id`).bind(...binds),
  ]);
  const plays = playsResult!.results as PlayRow[];
  const meta = new Map((metaResult!.results as MetaRow[]).map((row) => [row.track_id, row]));
  const artists = artistsResult!.results as Array<{ artist_id: string; name: string }>;
  const real = artists.find((artist) => !artist.artist_id.startsWith(NAME_KEY_PREFIX));

  return respond(
    {
      artist: { id: id ?? real?.artist_id ?? null, name: known?.name ?? real?.name ?? artists[0]?.name ?? name ?? '' },
      ...historyOf(plays, timeZone),
      top_tracks: rankTracks(countBy(plays), meta, (row) => songTitle(row.name.toLowerCase()))
        .slice(0, TOP_ARTIST_TRACKS)
        .map(({ id, name, plays, image }) => ({ id, name, plays, image })),
    },
    [playsResult!, metaResult!, artistsResult!],
  );
}

/** GET /api/track?id=&tz= */
export async function trackRoute(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url, env);
  const id = textParam(url, 'id');
  if (!id) throw new BadRequest('id is required');

  const track = await env.DB.prepare(
    `SELECT t.track_id, t.name, ${PRIMARY_ARTIST_SQL('t.track_id')} AS artist, al.image_url AS image
       FROM tracks t LEFT JOIN albums al ON al.album_id = t.album_id WHERE t.track_id = ?`,
  )
    .bind(id)
    .first<MetaRow>();
  if (!track) {
    return respond({ track: { id, name: null, artist: null, image: null }, ...historyOf([], timeZone) }, []);
  }

  const tracksCte = SONG_TRACKS_CTE;
  const binds = [id];
  const [playsResult, metaResult] = await env.DB.batch([
    env.DB.prepare(playsSql(tracksCte)).bind(...binds),
    env.DB.prepare(metaSql(tracksCte)).bind(...binds),
  ]);
  const plays = playsResult!.results as PlayRow[];
  const meta = new Map((metaResult!.results as MetaRow[]).map((row) => [row.track_id, row]));
  const image = track.image ?? rankTracks(countBy(plays), meta, () => 'song')[0]?.image ?? null;

  return respond(
    { track: { id, name: track.name, artist: track.artist, image }, ...historyOf(plays, timeZone) },
    [playsResult!, metaResult!],
  );
}

/** GET /api/on-this-day?date=&tz= */
export async function onThisDayRoute(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url, env);
  const date = url.searchParams.get('date') ?? localDayKey(Date.now(), timeZone);
  if (!isRealDay(date)) throw new BadRequest('date must be a real YYYY-MM-DD date');

  // The same local day in each earlier year; 29 February only in leap years.
  const ranges: Array<[number, number, number]> = [];
  for (let year = Number(date.slice(0, 4)) - 1; year >= FIRST_YEAR; year--) {
    const day = `${year}${date.slice(4)}`;
    if (isRealDay(day)) ranges.push([year, startOfLocalDayUtcMs(day, timeZone), endOfLocalDayUtcMs(day, timeZone)]);
  }
  if (ranges.length === 0) return respond({ date, years: [] }, []);

  // Each range is one seek on the plays primary key. The ranges travel as one
  // JSON parameter: three bound per year would pass D1's 100 from 2042.
  const result = await env.DB.prepare(
    `WITH r(y, a, b) AS (
       SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?)
     ),
     c AS (
       SELECT r.y, p.track_id, COUNT(*) AS plays
         FROM r JOIN plays p ON p.played_at_ms >= r.a AND p.played_at_ms < r.b
        GROUP BY r.y, p.track_id
     )
     SELECT c.y, c.track_id, c.plays, t.name, ${PRIMARY_ARTIST_SQL('c.track_id')} AS artist, al.image_url AS image
       FROM c LEFT JOIN tracks t ON t.track_id = c.track_id LEFT JOIN albums al ON al.album_id = t.album_id`,
  )
    .bind(JSON.stringify(ranges))
    .all<MetaRow & { y: number; plays: number; name: string | null }>();

  const years = new Map<number, typeof result.results>();
  for (const row of result.results) years.set(row.y, [...(years.get(row.y) ?? []), row]);

  return respond(
    {
      date,
      years: [...years]
        .sort((a, b) => b[0] - a[0])
        .map(([year, rows]) => {
          const meta = new Map(rows.filter((row) => row.name !== null).map((row) => [row.track_id, row]));
          const songKey = (row: MetaRow) => `${songTitle(row.name.toLowerCase())}|${row.artist?.toLowerCase() ?? ''}`;
          return {
            year,
            plays: rows.reduce((sum, row) => sum + row.plays, 0),
            top_tracks: rankTracks(rows.map((row) => [row.track_id, row.plays]), meta, songKey)
              .slice(0, TOP_DAY_TRACKS)
              .map(({ id, name, artist, image, plays }) => ({ id, name, artist, image, plays })),
          };
        }),
    },
    [result],
  );
}

/**
 * GET /api/top-tracks?from=&to=&tz=&limit=
 *
 * The /api/top-artists of songs: plays per song between two local dates, with
 * editions folded by their `track_songs` key (same title less any edition
 * tag, same primary artist), as play numbers and /api/track fold them.
 */
export async function topTracksRoute(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url, env);
  const { fromMs, toMs, from, to } = dateRange(url, timeZone);
  const limit = intParam(url, 'limit', 50, 1, 500);

  // Songs are ranked and cut to `limit` in SQL, so names, artists and art are
  // looked up for the editions of those songs only, not for every track
  // played in the range. Over whole months the counts come from the rollup
  // (src/rollup.ts). A tie at the cut goes to the lower key, either way.
  const { result, all, rollup } = await withTrackCounts<MetaRow & { plays: number }>(
    env,
    { from, to, fromMs, toMs, timeZone },
    'plays',
    (cte) =>
      `WITH ${cte},
       -- A track the song sweep hasn't keyed yet stands alone, as songKey() keys a track with no artist.
       e AS (SELECT COALESCE(ts.song, char(30) || c.track_id) AS song, c.track_id, c.plays
               FROM c LEFT JOIN track_songs ts ON ts.track_id = c.track_id),
       top AS (SELECT song FROM e GROUP BY song ORDER BY SUM(plays) DESC, song LIMIT ?)
       SELECT e.song, e.track_id, e.plays, t.name, ${PRIMARY_ARTIST_SQL('e.track_id')} AS artist, al.image_url AS image
         FROM top JOIN e ON e.song = top.song
         JOIN tracks t ON t.track_id = e.track_id LEFT JOIN albums al ON al.album_id = t.album_id
        ORDER BY e.track_id`,
    [limit],
  );

  const meta = new Map(result.results.map((row) => [row.track_id, row]));
  return fromRollup(
    respond(
      {
        from,
        to,
        tz: timeZone,
        tracks: rankTracks(result.results.map((row) => [row.track_id, row.plays]), meta, (row) => row.song!),
      },
      all,
    ),
    rollup,
  );
}
