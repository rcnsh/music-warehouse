import { DEFAULT_TIMEZONE, endOfLocalDayUtcMs, isValidTimeZone, localDayKey, startOfLocalDayUtcMs } from './tz';
import { ARTIST_TRACKS_CTE, SONG_TRACKS_CTE, textParam } from './history';
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

/** Joined by every play query, for PLAY_COLUMNS' play number and context name. */
const PLAY_JOINS = `LEFT JOIN play_numbers pn ON pn.played_at_ms = p.played_at_ms AND pn.track_id = p.track_id
       LEFT JOIN contexts cx ON cx.uri = p.context_uri`;

export const PLAY_COLUMNS = `p.played_at_ms, p.track_id, p.context_uri, p.context_type, cx.name AS context_name, p.source,
            pn.n AS play_number,
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

/** How long a search's matching track ids are reused across pages. */
const MATCH_TTL_SECONDS = 300;
const MATCH_CACHE_ORIGIN = 'https://search-matches.internal';

/**
 * matchingTrackIds, reused for a few minutes through the Cache API, so paging
 * through a broad search matches names once rather than once per page.
 *
 * The key carries the newest search-index row id (one row read), so a track
 * stored since the ids were cached starts a new key and shows up at once.
 * Text changes to tracks already indexed (an album filled in, artists merged)
 * can take up to the TTL to change what matches; that is the accepted cost.
 * Both matchers fold ASCII case, so the key does too and "Porter" shares
 * "porter"'s entry; nothing else is folded, since LIKE would not fold it.
 */
async function cachedMatchingTrackIds(env: Env, q: string): Promise<{ ids: string[]; rowsRead: number }> {
  const latest = await env.DB.prepare('SELECT MAX(id) AS id FROM track_search_text').first<{ id: number | null }>();
  const folded = q.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const key = new Request(`${MATCH_CACHE_ORIGIN}/v1/${latest?.id ?? 0}/${encodeURIComponent(folded)}`);
  const cache = await caches.open('search-matches');
  const hit = await cache.match(key);
  if (hit) return { ids: (await hit.json()) as string[], rowsRead: 1 };

  const match = await matchingTrackIds(env, q);
  await cache.put(
    key,
    new Response(JSON.stringify(match.ids), { headers: { 'Cache-Control': `max-age=${MATCH_TTL_SECONDS}` } }),
  );
  return { ids: match.ids, rowsRead: match.rowsRead + 1 };
}

/**
 * `first_play` beside `play_number`, as a boolean. Null when a play has no
 * number yet: one stored by a write that predates migration 0012's upkeep.
 */
export function withFirstPlay(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row, first_play: row.play_number == null ? null : row.play_number === 1 }));
}

/** The filters /api/plays and /api/daily share. Each is echoed in the response when given. */
export interface PlayFilter {
  q?: string;
  track_id?: string;
  artist_id?: string;
  artist_name?: string;
}

export function playFilterParams(url: URL, options: { q: boolean }): PlayFilter {
  const filter: PlayFilter = {};
  for (const name of ['q', 'track_id', 'artist_id', 'artist_name'] as const) {
    if (name === 'q' && !options.q) continue;
    const value = textParam(url, name);
    if (value !== null) filter[name] = value;
  }
  return filter;
}

/**
 * The track ids a filter allows, or null for no filter. Each filter narrows
 * the one before. `track_id` takes every edition of the song, as /api/track
 * folds them, and `artist_id`/`artist_name` every track /api/artist credits
 * (primary artist, `name:` placeholders included). Resolving either reads
 * about one row per track it finds.
 */
export async function filterTrackIds(env: Env, filter: PlayFilter): Promise<{ ids: string[] | null; rowsRead: number }> {
  let ids: string[] | null = null;
  let rowsRead = 0;
  const narrow = (found: string[]) => {
    const allowed = new Set(found);
    ids = ids === null ? found : ids.filter((id) => allowed.has(id));
  };
  if (filter.q !== undefined) {
    const match = await cachedMatchingTrackIds(env, filter.q);
    narrow(match.ids);
    rowsRead += match.rowsRead;
  }
  const lookups: Array<[string, unknown[]]> = [];
  if (filter.track_id !== undefined) lookups.push([SONG_TRACKS_CTE, [filter.track_id]]);
  if (filter.artist_id !== undefined || filter.artist_name !== undefined) {
    lookups.push([ARTIST_TRACKS_CTE, [filter.artist_id ?? null, filter.artist_name ?? null]]);
  }
  if (lookups.length > 0) {
    const results = await env.DB.batch<{ track_id: string }>(
      lookups.map(([cte, binds]) => env.DB.prepare(`WITH ${cte} SELECT track_id FROM ts`).bind(...binds)),
    );
    for (const result of results) {
      narrow(result.results.map((row) => row.track_id));
      rowsRead += result.meta?.rows_read ?? 0;
    }
  }
  return { ids, rowsRead };
}

/**
 * One page of plays, newest first, strictly older than `upper` in the
 * primary key's (played_at_ms, track_id) order and newer than `after`, from
 * `ids`' tracks or, for null, everyone's. Tied timestamps are common in
 * imported history (1.7k on the real warehouse), so a caller that pages
 * every row passes the last row's full key; `[before, '']` means "before
 * that millisecond", as nothing sorts below ''.
 */
export function selectPlays(
  env: Env,
  ids: string[] | null,
  upper: [number, string],
  after: number,
  limit: number,
): Promise<D1Result<Record<string, unknown>>> {
  if (ids === null) {
    // The (played_at_ms, track_id) primary key drives both the range and the
    // ordering, so this reads only the rows it returns.
    return env.DB.prepare(
      `SELECT ${PLAY_COLUMNS}
         FROM plays p
         LEFT JOIN tracks t  ON t.track_id = p.track_id
         LEFT JOIN albums al ON al.album_id = t.album_id
         ${PLAY_JOINS}
        WHERE (p.played_at_ms, p.track_id) < (?, ?) AND p.played_at_ms > ?
        ORDER BY p.played_at_ms DESC, p.track_id DESC
        LIMIT ?`,
    )
      .bind(...upper, after, limit)
      .all();
  }
  // The ids travel as one JSON parameter, since D1 allows only 100 bound
  // parameters. `+p.track_id` stops SQLite using idx_plays_track, which
  // leaves the primary key to walk plays newest first.
  //
  // The page's keys are chosen first and joined to names after: seeking a
  // popular artist's tracks finds thousands of plays, and joining names
  // before the sort read every one of them (25k rows for "porter", now 4k).
  const trackTerm = ids.length > WALK_ABOVE_TRACKS ? '+p.track_id' : 'p.track_id';
  return env.DB.prepare(
    `SELECT ${PLAY_COLUMNS}
       FROM (SELECT p.played_at_ms, p.track_id FROM plays p
              WHERE ${trackTerm} IN (SELECT value FROM json_each(?))
                AND (p.played_at_ms, p.track_id) < (?, ?) AND p.played_at_ms > ?
              ORDER BY p.played_at_ms DESC, p.track_id DESC
              LIMIT ?) page
       JOIN plays p ON p.played_at_ms = page.played_at_ms AND p.track_id = page.track_id
       LEFT JOIN tracks t  ON t.track_id = p.track_id
       LEFT JOIN albums al ON al.album_id = t.album_id
       ${PLAY_JOINS}
      ORDER BY p.played_at_ms DESC, p.track_id DESC`,
  )
    .bind(JSON.stringify(ids), ...upper, after, limit)
    .all();
}

/**
 * Most recent plays, newest first, joined to track, album and artist names.
 * `q` keeps only plays whose track, album or artist name contains it, and
 * `track_id`, `artist_id` and `artist_name` one song's or one artist's, with
 * the same paging, so a client can walk a filtered history a page at a time.
 */
export async function recentPlays(env: Env, url: URL): Promise<Response> {
  const limit = intParam(url, 'limit', 50, 1, 500);
  const before = intParam(url, 'before', Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
  const after = intParam(url, 'after', -1, -1, Number.MAX_SAFE_INTEGER);
  const filter = playFilterParams(url, { q: true });

  const match = await filterTrackIds(env, filter);
  // The filters are echoed, so a client can tell a filtered page from an
  // older Worker that ignored the parameter.
  if (match.ids?.length === 0) {
    return json({ ...filter, plays: [], _meta: { rows_read: match.rowsRead, duration_ms: null } });
  }
  const query = await selectPlays(env, match.ids, [before, ''], after, limit);
  return json({
    ...filter,
    plays: withFirstPlay(query.results),
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

  // Plays are counted per track before artists are credited, so each track's
  // credits are looked up once rather than once per play: half the rows read
  // (49k instead of 100k for a year).
  const query = await env.DB.prepare(
    `WITH c AS (
       SELECT track_id, COUNT(*) AS n
         FROM plays
        WHERE played_at_ms >= ? AND played_at_ms < ?
        GROUP BY track_id
     )
     SELECT a.artist_id, a.name, SUM(c.n) AS plays
       FROM c
       JOIN track_artists ta ON ta.track_id = c.track_id
       JOIN artists a        ON a.artist_id = ta.artist_id
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

  const filter = playFilterParams(url, { q: false });
  const match = await filterTrackIds(env, filter);

  // Filtered, idx_plays_track seeks each track's plays in the range, so the
  // rows read follow the song's or artist's plays rather than everyone's.
  const query = await (match.ids === null
    ? env.DB.prepare(
        'SELECT played_at_ms FROM plays WHERE played_at_ms >= ? AND played_at_ms < ? ORDER BY played_at_ms',
      ).bind(fromMs, toMs)
    : env.DB.prepare(
        `SELECT played_at_ms FROM plays
          WHERE track_id IN (SELECT value FROM json_each(?)) AND played_at_ms >= ? AND played_at_ms < ?`,
      ).bind(JSON.stringify(match.ids), fromMs, toMs)
  ).all<{ played_at_ms: number }>();

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
    ...filter,
    days: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, plays]) => ({ day, plays })),
    _meta: { rows_read: match.rowsRead + (query.meta?.rows_read ?? 0), duration_ms: query.meta?.duration ?? null },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
