import { BadRequest, timeZoneParam } from './api';
import { NAME_KEY_PREFIX } from './db';
import { PRIMARY_ARTIST_SQL } from './stats/sql';
import { endOfLocalDayUtcMs, isRealDay, localDayKey, startOfLocalDayUtcMs } from './tz';
import type { Env } from './types';
import { FALLBACK_DURATION_MS, MIN_PLAY_MS } from './wrapped';

/**
 * One artist's or one track's whole history, and "on this day", for a client
 * app. Private like /api/plays: they name days.
 *
 * Artists are matched the way the stats group them: by id, and by lowercased
 * name, so the export's `name:` placeholders fold into the real id. Credit is
 * the primary artist's only, as everywhere else. A track folds the other
 * editions of the same song (same title and primary artist), as Wrapped does.
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
type MetaRow = { track_id: string; name: string; artist: string | null; image: string | null };

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
  for (const play of plays) {
    const month = localDayKey(play.played_at_ms, timeZone).slice(0, 7);
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
  const timeZone = timeZoneParam(url);
  const id = textParam(url, 'id');
  const name = textParam(url, 'name');
  if (!id && !name) throw new BadRequest('id or name is required');

  const known = id
    ? await env.DB.prepare('SELECT name FROM artists WHERE artist_id = ?').bind(id).first<{ name: string }>()
    : null;
  // Fold by the stored name when the id is known, else by the caller's.
  const tracksCte = `a AS (
      SELECT artist_id, name FROM artists WHERE artist_id = ?1
      UNION SELECT artist_id, name FROM artists WHERE name = ?2 COLLATE NOCASE
    ),
    ts AS (SELECT DISTINCT track_id FROM track_artists WHERE position = 0 AND artist_id IN (SELECT artist_id FROM a))`;
  const binds = [id, known?.name ?? name];
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
      top_tracks: rankTracks(countBy(plays), meta, (row) => row.name.toLowerCase())
        .slice(0, TOP_ARTIST_TRACKS)
        .map(({ id, name, plays, image }) => ({ id, name, plays, image })),
    },
    [playsResult!, metaResult!, artistsResult!],
  );
}

/** GET /api/track?id=&tz= */
export async function trackRoute(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url);
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

  // Every edition: the same title, case-insensitively, under the same
  // primary artist (itself folded by name).
  const tracksCte = `a AS (SELECT artist_id FROM artists WHERE name = ?2 COLLATE NOCASE),
    ts AS (
      SELECT ?1 AS track_id
      UNION SELECT ta.track_id FROM track_artists ta JOIN tracks t ON t.track_id = ta.track_id
       WHERE ta.position = 0 AND ta.artist_id IN (SELECT artist_id FROM a) AND t.name = ?3 COLLATE NOCASE
    )`;
  const binds = [id, track.artist, track.name];
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
  const timeZone = timeZoneParam(url);
  const date = url.searchParams.get('date') ?? localDayKey(Date.now(), timeZone);
  if (!isRealDay(date)) throw new BadRequest('date must be a real YYYY-MM-DD date');

  // The same local day in each earlier year; 29 February only in leap years.
  const ranges: Array<[number, number, number]> = [];
  for (let year = Number(date.slice(0, 4)) - 1; year >= FIRST_YEAR; year--) {
    const day = `${year}${date.slice(4)}`;
    if (isRealDay(day)) ranges.push([year, startOfLocalDayUtcMs(day, timeZone), endOfLocalDayUtcMs(day, timeZone)]);
  }
  if (ranges.length === 0) return respond({ date, years: [] }, []);

  // Each range is one seek on the plays primary key.
  const result = await env.DB.prepare(
    `WITH r(y, a, b) AS (VALUES ${ranges.map(() => '(?, ?, ?)').join(', ')}),
     c AS (
       SELECT r.y, p.track_id, COUNT(*) AS plays
         FROM r JOIN plays p ON p.played_at_ms >= r.a AND p.played_at_ms < r.b
        GROUP BY r.y, p.track_id
     )
     SELECT c.y, c.track_id, c.plays, t.name, ${PRIMARY_ARTIST_SQL('c.track_id')} AS artist, al.image_url AS image
       FROM c LEFT JOIN tracks t ON t.track_id = c.track_id LEFT JOIN albums al ON al.album_id = t.album_id`,
  )
    .bind(...ranges.flat())
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
          const songKey = (row: MetaRow) => `${row.name.toLowerCase()}|${row.artist?.toLowerCase() ?? ''}`;
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
