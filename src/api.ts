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
import { NAME_KEY_PREFIX } from './db';
import { filterTrackIds, playCursor, playFilterParams, selectPlays, withFirstPlay } from './plays';
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
