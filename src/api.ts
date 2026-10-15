import {
  DEFAULT_TIMEZONE,
  calendarDaysInclusive,
  endOfLocalDayUtcMs,
  isRealDay,
  isValidTimeZone,
  localCalendar,
  localDayKey,
  startOfLocalDayUtcMs,
} from './tz';
import { ARTIST_TRACKS_CTE, SONG_TRACKS_CTE, textParam } from './history';
import { NAME_KEY_PREFIX } from './db';
import { trigramPhrase } from './search-index';
import { ROLLUP_STATE_SQL, type RollupState, beginsDay, endsDay, rollupServes, rollupZone, withTrackCounts } from './rollup';
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

/**
 * The request's `tz`, or without one the warehouse's own zone: `TIMEZONE`,
 * else the latest era's, else UTC (the zone the rollup is built in).
 */
export function timeZoneParam(url: URL, env: Pick<Env, 'TIMEZONE' | 'ERAS'>): string {
  const timeZone = url.searchParams.get('tz') ?? rollupZone(env) ?? DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timeZone)) throw new BadRequest(`Unknown IANA timezone: ${timeZone}`);
  return timeZone;
}

/** Resolve `from`/`to` local calendar dates into a half-open UTC millisecond range. */
export function dateRange(url: URL, timeZone: string): { fromMs: number; toMs: number; from: string; to: string } {
  const to = url.searchParams.get('to') ?? localDayKey(Date.now(), timeZone);
  const from = url.searchParams.get('from') ?? localDayKey(Date.now() - 29 * 86_400_000, timeZone);
  // Date.UTC rolls 2026-02-30 over to 2 March, so the dates are checked first.
  for (const [name, day] of [['from', from], ['to', to]] as const) {
    if (!isRealDay(day)) throw new BadRequest(`${name} must be a real YYYY-MM-DD date`);
  }

  let fromMs: number;
  let toMs: number;
  try {
    fromMs = startOfLocalDayUtcMs(from, timeZone);
    toMs = endOfLocalDayUtcMs(to, timeZone);
  } catch (error) {
    throw new BadRequest((error as Error).message);
  }

  if (toMs <= fromMs) throw new BadRequest('`to` must not be before `from`');
  // Counted in local calendar days rather than ms: a DST change makes a day 23 or 25 hours.
  if (calendarDaysInclusive(from, to) > MAX_RANGE_DAYS) {
    throw new BadRequest(`Range too large; at most ${MAX_RANGE_DAYS} days`);
  }
  return { fromMs, toMs, from, to };
}

/**
 * `before` as the upper bound of a page of plays, in the primary key's
 * (played_at_ms, track_id) order: a `next_before` cursor (`<ms>.<track_id>`)
 * resumes after exactly the last row a page returned, and a plain epoch-ms
 * means "before that millisecond", as `[ms, '']` (nothing sorts below '').
 */
export function beforeParam(url: URL): [number, string] {
  const raw = url.searchParams.get('before');
  const cursor = raw === null ? null : /^(\d{1,16})\.(.+)$/s.exec(raw);
  if (cursor) {
    const ms = Number(cursor[1]);
    if (ms > Number.MAX_SAFE_INTEGER) throw new BadRequest('before is not a valid cursor');
    return [ms, cursor[2]!];
  }
  try {
    return [intParam(url, 'before', Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER), ''];
  } catch {
    throw new BadRequest('before must be an epoch-ms integer or a next_before cursor');
  }
}

/** The cursor for the page after one ending at this row. */
export const playCursor = (row: Record<string, unknown>) => `${row.played_at_ms}.${row.track_id}`;

/** `%term%` for LIKE, with the term's own wildcards escaped. */
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Above this many matching tracks, walking plays newest first finds a page
 * sooner than seeking every track's plays and sorting them. Measured on the
 * real warehouse: 4 tracks read 649 rows by seek and 36k by walk; 1,612
 * tracks read 8k by seek and 2k by walk.
 */
export const WALK_ABOVE_TRACKS = 500;

/** Joined by every play query, for PLAY_COLUMNS' play number and context name. */
const PLAY_JOINS = `LEFT JOIN play_numbers pn ON pn.played_at_ms = p.played_at_ms AND pn.track_id = p.track_id
       LEFT JOIN contexts cx ON cx.uri = p.context_uri`;

export const PLAY_COLUMNS = `p.played_at_ms, p.track_id, p.context_uri, p.context_type, cx.name AS context_name, p.source,
            pn.n AS play_number,
            t.name AS track_name, t.duration_ms, t.isrc,
            al.name AS album_name, al.image_url,
            (SELECT json_group_array(json_object('id', artist_id, 'name', name))
               FROM (SELECT a.artist_id, a.name
                       FROM track_artists ta
                       JOIN artists a ON a.artist_id = ta.artist_id
                      WHERE ta.track_id = p.track_id
                      ORDER BY ta.position)) AS artist_list`;

/**
 * Turns PLAY_COLUMNS' JSON `artist_list` into an array and derives the older
 * `artists` string from it. One read of the credits serves both, so a page
 * costs what it did when the string came straight from SQL. A track with no
 * credits keeps `artists: null`, as group_concat gave.
 */
export function withArtistList(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const raw = row.artist_list;
    const list: Array<{ id: string; name: string }> = typeof raw === 'string' ? JSON.parse(raw) : [];
    const { artist_list: _, ...rest } = row;
    return { ...rest, artists: list.length ? list.map((a) => a.name).join(', ') : null, artist_list: list };
  });
}

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
      .all()
      .then(withArtists);
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
    .all()
    .then(withArtists);
}

const withArtists = (result: D1Result<Record<string, unknown>>) => ({ ...result, results: withArtistList(result.results) });

/**
 * Most recent plays, newest first, joined to track, album and artist names.
 * `q` keeps only plays whose track, album or artist name contains it, and
 * `track_id`, `artist_id` and `artist_name` one song's or one artist's, with
 * the same paging, so a client can walk a filtered history a page at a time.
 */
export async function recentPlays(env: Env, url: URL): Promise<Response> {
  const limit = intParam(url, 'limit', 50, 1, 500);
  const before = beforeParam(url);
  const after = intParam(url, 'after', -1, -1, Number.MAX_SAFE_INTEGER);
  const filter = playFilterParams(url, { q: true });

  const match = await filterTrackIds(env, filter);
  // The filters are echoed, so a client can tell a filtered page from an
  // older Worker that ignored the parameter.
  if (match.ids?.length === 0) {
    return withRowsRead(
      json({ ...filter, plays: [], next_before: null, _meta: { rows_read: match.rowsRead, duration_ms: null } }),
      match.rowsRead,
    );
  }
  // One row past the page says whether another page follows, so the last
  // page's next_before is null rather than a cursor to an empty page.
  const query = await selectPlays(env, match.ids, before, after, limit + 1);
  const plays = query.results.slice(0, limit);
  const rowsRead = match.rowsRead + (query.meta?.rows_read ?? 0);
  return withRowsRead(
    json({
      ...filter,
      plays: withFirstPlay(plays),
      next_before: query.results.length > limit ? playCursor(plays.at(-1)!) : null,
      _meta: { rows_read: rowsRead, duration_ms: query.meta?.duration ?? null },
    }),
    rowsRead,
  );
}

/** Play counts per artist over a local-calendar date range. */
export async function topArtists(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url, env);
  const { fromMs, toMs, from, to } = dateRange(url, timeZone);
  const limit = intParam(url, 'limit', 50, 1, 500);

  // Plays are counted per track before artists are credited, so each track's
  // credits are looked up once rather than once per play: half the rows read
  // (49k instead of 100k for a year). Over whole months the counts come from
  // the rollup (src/rollup.ts).
  //
  // Artists are grouped by lowercased name, as /api/artist, search and the
  // concerts fold them, so the export's `name:` placeholders count with the
  // real id: one row per artist, with the real id and spelling where there is
  // one. A track counts once per name even if it credits both. Ties are
  // broken by the key, so both ways of counting list them in the same order.
  const { result: query, all, rollup } = await withTrackCounts(
    env,
    { from, to, fromMs, toMs, timeZone },
    'n',
    (cte) =>
      `WITH ${cte},
       credits AS (
         SELECT DISTINCT ta.track_id, lower(a.name) AS k
           FROM c JOIN track_artists ta ON ta.track_id = c.track_id JOIN artists a ON a.artist_id = ta.artist_id
       ),
       top AS (
         SELECT cr.k, SUM(c.n) AS plays FROM credits cr JOIN c ON c.track_id = cr.track_id
          GROUP BY cr.k ORDER BY plays DESC, cr.k LIMIT ?
       ),
       named AS (
         SELECT top.k, top.plays,
                (SELECT json_array(a.artist_id, a.name) FROM artists a WHERE a.name = top.k COLLATE NOCASE
                  ORDER BY instr(a.artist_id, '${NAME_KEY_PREFIX}') = 1, a.artist_id LIMIT 1) AS pair
           FROM top
       )
       SELECT json_extract(pair, '$[0]') AS artist_id, json_extract(pair, '$[1]') AS name, plays
         FROM named ORDER BY plays DESC, k`,
    [limit],
  );

  const rowsRead = all.reduce((sum, r) => sum + (r.meta?.rows_read ?? 0), 0);
  return fromRollup(
    withRowsRead(
      json({ from, to, tz: timeZone, artists: query.results, _meta: { rows_read: rowsRead, duration_ms: query.meta?.duration ?? null } }),
      rowsRead,
    ),
    rollup,
  );
}

export type DailyGroup = 'day' | 'week' | 'month';

/**
 * Days' counts summed into the local week (from Monday, labelled with that
 * Monday's date, which may fall before the range) or month ('YYYY-MM') each
 * day belongs to. Days come in date order, so buckets do too.
 */
export function groupDays(days: Array<{ day: string; plays: number }>, by: 'week' | 'month') {
  const buckets = new Map<string, number>();
  for (const { day, plays } of days) {
    let key = day.slice(0, 7);
    if (by === 'week') {
      const date = new Date(`${day}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      key = date.toISOString().slice(0, 10);
    }
    buckets.set(key, (buckets.get(key) ?? 0) + plays);
  }
  return [...buckets].map(([key, plays]) => ({ [by]: key, plays }));
}

/**
 * Plays per local calendar day, or per local week or month with `group_by`.
 *
 * SQLite cannot bucket by an IANA zone, so the range is resolved to UTC bounds
 * in SQL and the timestamps are bucketed here. Only the timestamp column is
 * selected, so row reads stay proportional to plays in the window.
 */
export async function dailyCounts(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url, env);
  const { fromMs, toMs, from, to } = dateRange(url, timeZone);
  const groupBy = (url.searchParams.get('group_by') || 'day') as DailyGroup;
  if (!['day', 'week', 'month'].includes(groupBy)) throw new BadRequest('group_by must be day, week or month');

  const filter = playFilterParams(url, { q: false });
  const match = await filterTrackIds(env, filter);

  // Pre-seed every day in the range so quiet days appear as zero rather than a gap.
  const calendar = localCalendar(timeZone, fromMs, toMs);
  const counts = new Map<string, number>(calendar.days().map((day) => [day, 0]));
  const days = () => [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, plays]) => ({ day, plays }));
  // With the default grouping the body is exactly what it was before group_by.
  const buckets = () =>
    groupBy === 'day' ? { days: days() } : { group_by: groupBy, [`${groupBy}s`]: groupDays(days(), groupBy) };

  // Unfiltered, the rollup holds each day's count: one row a day instead of
  // one a play. It answers only when the range runs exactly from local
  // midnight to local midnight in its zone, so its days are the range's.
  if (match.ids === null && beginsDay(fromMs, from, timeZone) && endsDay(toMs, to, timeZone)) {
    const [state, rollup] = await env.DB.batch([
      env.DB.prepare(ROLLUP_STATE_SQL),
      env.DB.prepare('SELECT day, plays FROM rollup_days WHERE day >= ? AND day <= ? AND plays > 0').bind(from, to),
    ]);
    if (rollupServes(state!.results[0] as RollupState | undefined, timeZone, Date.now())) {
      for (const row of rollup!.results as Array<{ day: string; plays: number }>) counts.set(row.day, row.plays);
      const rowsRead = (state!.meta?.rows_read ?? 0) + (rollup!.meta?.rows_read ?? 0);
      return fromRollup(
        withRowsRead(
          json({
            from,
            to,
            tz: timeZone,
            ...filter,
            ...buckets(),
            _meta: { rows_read: rowsRead, duration_ms: rollup!.meta?.duration ?? null },
          }),
          rowsRead,
        ),
        true,
      );
    }
  }

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

  for (const row of query.results ?? []) {
    const key = calendar.dayOf(row.played_at_ms);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const rowsRead = match.rowsRead + (query.meta?.rows_read ?? 0);
  return withRowsRead(
    json({
      from,
      to,
      tz: timeZone,
      ...filter,
      ...buckets(),
      _meta: { rows_read: rowsRead, duration_ms: query.meta?.duration ?? null },
    }),
    rowsRead,
  );
}

/**
 * D1's rows read for the request, as `X-Rows-Read`. Every stored-data route
 * sends it; /api/plays, /api/daily and /api/top-artists also keep it in their
 * body's `_meta`, as they always have.
 */
export function withRowsRead(response: Response, rowsRead: number): Response {
  response.headers.set('X-Rows-Read', String(rowsRead));
  return response;
}

/** Marks a response the rollup answered, for checking the rollup is in use. */
export function fromRollup(response: Response, rollup: boolean): Response {
  if (rollup) response.headers.set('X-Rollup', '1');
  return response;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
