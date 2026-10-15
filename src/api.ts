import { DEFAULT_TIMEZONE, endOfLocalDayUtcMs, isValidTimeZone, localDayKey, startOfLocalDayUtcMs } from './tz';
import { textParam } from './history';
import { trigramPhrase } from './search-index';
import type { Env } from './types';

export class BadRequest extends Error {}

/** Longest range the day/artist endpoints will scan, to keep D1 row reads bounded. */
const MAX_RANGE_DAYS = 3660;

export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new BadRequest(`${name} must be an integer`);
  }
  if (value < min || value > max) throw new BadRequest(`${name} must be between ${min} and ${max}`);
  return value;
}

export function timeZoneParam(url: URL): string {
  const timeZone = url.searchParams.get('tz') ?? DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timeZone)) throw new BadRequest(`Unknown IANA timezone: ${timeZone}`);
  return timeZone;
}

/** Resolve `from`/`to` local calendar dates into a half-open UTC millisecond range. */
export function dateRange(url: URL, timeZone: string): { fromMs: number; toMs: number; from: string; to: string } {
  const to = url.searchParams.get('to') ?? localDayKey(Date.now(), timeZone);
  const from = url.searchParams.get('from') ?? localDayKey(Date.now() - 29 * 86_400_000, timeZone);

  let fromMs: number;
  let toMs: number;
  try {
    fromMs = startOfLocalDayUtcMs(from, timeZone);
    toMs = endOfLocalDayUtcMs(to, timeZone);
  } catch (error) {
    throw new BadRequest((error as Error).message);
  }

  if (toMs <= fromMs) throw new BadRequest('`to` must not be before `from`');
  if (toMs - fromMs > MAX_RANGE_DAYS * 86_400_000) {
    throw new BadRequest(`Range too large; at most ${MAX_RANGE_DAYS} days`);
  }
  return { fromMs, toMs, from, to };
}

/** `%term%` for LIKE, with the term's own wildcards escaped. */
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Above this many matching tracks, walking plays newest first finds a page
 * sooner than seeking every track's plays and sorting them. Measured on the
 * real warehouse: 4 tracks read 649 rows by seek and 36k by walk; 1,612
 * tracks read 8k by seek and 2k by walk.
 */
const WALK_ABOVE_TRACKS = 500;

const PLAY_COLUMNS = `p.played_at_ms, p.track_id, p.context_uri, p.context_type, p.source,
            t.name AS track_name, t.duration_ms, t.isrc,
            al.name AS album_name, al.image_url,
            (SELECT group_concat(name, ', ')
               FROM (SELECT a.name
                       FROM track_artists ta
                       JOIN artists a ON a.artist_id = ta.artist_id
                      WHERE ta.track_id = p.track_id
                      ORDER BY ta.position)) AS artists`;

/**
 * Ids of tracks whose title, album or any credited artist contains `q`.
 *
 * The trigram index (migration 0011) reads about one row per match and
 * ignores case and accents. It cannot answer fewer than three characters, so
 * those fall back to LIKE scans of the three name tables (about 11k rows,
 * case-insensitive for ASCII only). Artists are read first there so their
 * tracks come from idx_track_artists_artist rather than a scan of
 * track_artists.
 */
async function matchingTrackIds(env: Env, q: string): Promise<{ ids: string[]; rowsRead: number }> {
  const phrase = trigramPhrase(q);
  const result = phrase
    ? await env.DB.prepare(
        `SELECT s.track_id FROM track_search f JOIN track_search_text s ON s.id = f.rowid
          WHERE track_search MATCH ?`,
      )
        .bind(phrase)
        .all<{ track_id: string }>()
    : await env.DB.prepare(
        `SELECT track_id FROM tracks
          WHERE name LIKE ?1 ESCAPE '\\'
             OR album_id IN (SELECT album_id FROM albums WHERE name LIKE ?1 ESCAPE '\\')
         UNION
         SELECT ta.track_id FROM artists a CROSS JOIN track_artists ta ON ta.artist_id = a.artist_id
          WHERE a.name LIKE ?1 ESCAPE '\\'`,
      )
        .bind(likePattern(q))
        .all<{ track_id: string }>();
  return { ids: result.results.map((row) => row.track_id), rowsRead: result.meta?.rows_read ?? 0 };
}

/**
 * Most recent plays, newest first, joined to track, album and artist names.
 * `q` keeps only plays whose track, album or artist name contains it, with
 * the same paging, so a client can search the whole history a page at a time.
 */
export async function recentPlays(env: Env, url: URL): Promise<Response> {
  const limit = intParam(url, 'limit', 50, 1, 500);
  const before = intParam(url, 'before', Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
  const after = intParam(url, 'after', -1, -1, Number.MAX_SAFE_INTEGER);
  const q = textParam(url, 'q');

  if (q === null) {
    // The (played_at_ms, track_id) primary key drives both the range and the
    // ordering, so this reads only the rows it returns.
    const query = await env.DB.prepare(
      `SELECT ${PLAY_COLUMNS}
         FROM plays p
         LEFT JOIN tracks t  ON t.track_id = p.track_id
         LEFT JOIN albums al ON al.album_id = t.album_id
        WHERE p.played_at_ms < ? AND p.played_at_ms > ?
        ORDER BY p.played_at_ms DESC
        LIMIT ?`,
    )
      .bind(before, after, limit)
      .all();
    return json({
      plays: query.results,
      _meta: { rows_read: query.meta?.rows_read ?? null, duration_ms: query.meta?.duration ?? null },
    });
  }

  const match = await matchingTrackIds(env, q);
  if (match.ids.length === 0) {
    return json({ q, plays: [], _meta: { rows_read: match.rowsRead, duration_ms: null } });
  }
  // The ids travel as one JSON parameter, since D1 allows only 100 bound
  // parameters. `+p.track_id` stops SQLite using idx_plays_track, which
  // leaves the primary key to walk plays newest first.
  const trackTerm = match.ids.length > WALK_ABOVE_TRACKS ? '+p.track_id' : 'p.track_id';
  const query = await env.DB.prepare(
    `SELECT ${PLAY_COLUMNS}
       FROM plays p
       LEFT JOIN tracks t  ON t.track_id = p.track_id
       LEFT JOIN albums al ON al.album_id = t.album_id
      WHERE ${trackTerm} IN (SELECT value FROM json_each(?))
        AND p.played_at_ms < ? AND p.played_at_ms > ?
      ORDER BY p.played_at_ms DESC
      LIMIT ?`,
  )
    .bind(JSON.stringify(match.ids), before, after, limit)
    .all();

  // `q` echoes the filter, so a client can tell a filtered page from an
  // older Worker that ignored the parameter.
  return json({
    q,
    plays: query.results,
    _meta: {
      rows_read: match.rowsRead + (query.meta?.rows_read ?? 0),
      duration_ms: query.meta?.duration ?? null,
    },
  });
}

/** Play counts per artist over a local-calendar date range. */
export async function topArtists(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url);
  const { fromMs, toMs, from, to } = dateRange(url, timeZone);
  const limit = intParam(url, 'limit', 50, 1, 500);

  const query = await env.DB.prepare(
    `SELECT a.artist_id, a.name, COUNT(*) AS plays
       FROM plays p
       JOIN track_artists ta ON ta.track_id = p.track_id
       JOIN artists a        ON a.artist_id = ta.artist_id
      WHERE p.played_at_ms >= ? AND p.played_at_ms < ?
      GROUP BY a.artist_id, a.name
      ORDER BY plays DESC, a.name ASC
      LIMIT ?`,
  )
    .bind(fromMs, toMs, limit)
    .all();

  return json({
    from,
    to,
    tz: timeZone,
    artists: query.results,
    _meta: { rows_read: query.meta?.rows_read ?? null, duration_ms: query.meta?.duration ?? null },
  });
}

/**
 * Plays per local calendar day.
 *
 * SQLite cannot bucket by an IANA zone, so the range is resolved to UTC bounds
 * in SQL and the timestamps are bucketed here. Only the timestamp column is
 * selected, so row reads stay proportional to plays in the window.
 */
export async function dailyCounts(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url);
  const { fromMs, toMs, from, to } = dateRange(url, timeZone);

  const query = await env.DB.prepare(
    'SELECT played_at_ms FROM plays WHERE played_at_ms >= ? AND played_at_ms < ? ORDER BY played_at_ms',
  )
    .bind(fromMs, toMs)
    .all<{ played_at_ms: number }>();

  const counts = new Map<string, number>();
  // Pre-seed every day in the range so quiet days appear as zero rather than a gap.
  for (let cursor = fromMs; cursor < toMs; ) {
    const key = localDayKey(cursor, timeZone);
    counts.set(key, 0);
    cursor = endOfLocalDayUtcMs(key, timeZone);
  }
  for (const row of query.results ?? []) {
    const key = localDayKey(row.played_at_ms, timeZone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return json({
    from,
    to,
    tz: timeZone,
    days: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, plays]) => ({ day, plays })),
    _meta: { rows_read: query.meta?.rows_read ?? null, duration_ms: query.meta?.duration ?? null },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
