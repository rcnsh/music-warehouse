import { buildInserts } from './db';
import { parseEras } from './eras';
import { isValidTimeZone, localDayKey, offsetMsAt, startOfLocalDayUtcMs } from './tz';
import type { Env } from './types';

/**
 * The play-count rollup (migration 0014): plays per local day, and per local
 * month and track, kept by triggers on `plays` in one timezone.
 *
 * /api/daily, /api/top-tracks and /api/top-artists read it when the request's
 * `tz` is the rollup's, and must then answer exactly as counting the plays
 * would. So it is read only where its buckets provably hold the same plays as
 * the request's UTC range: each boundary used must be exactly where its local
 * day begins (not so where a DST change skips midnight), and the zone's local
 * dates must never run backwards (they do where clocks fall back across
 * midnight). Anything else counts the plays, as before.
 *
 * The zone is TIMEZONE, or else the latest era's (ERAS replaces TIMEZONE),
 * or UTC. The daily cron calls ensureRollup, which extends the offsets
 * table a little further each day and rebuilds everything when the zone, or
 * the zone's rules, changed.
 */

const DAY_MS = 86_400_000;
/** Offsets are written out from here; Spotify launched in 2008, so no play is older. */
const FIRST_MS = Date.UTC(2006, 0, 1);
/** The first offset row's key: before every play, so every play finds a row. */
export const BEFORE_ALL_MS = -8_640_000_000_000_000;
/** How far past now the offsets are written out. */
const HORIZON_AHEAD_MS = 2 * 366 * DAY_MS;

/** SQL for the local day (YYYY-MM-DD) of a play at `ms`. Must match migration 0014's triggers. */
export const localDaySql = (ms: string) =>
  `date((${ms} + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= ${ms} ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch')`;

export interface RollupState {
  time_zone: string;
  usable: number;
  horizon_ms: number;
}

export const ROLLUP_STATE_SQL = 'SELECT time_zone, usable, horizon_ms FROM rollup_state WHERE id = 1';

/** The zone the rollup should be built in, or null when the settings name none that works. */
export function rollupZone(env: Pick<Env, 'TIMEZONE' | 'ERAS'>): string | null {
  const configured = env.TIMEZONE?.trim();
  if (configured) return isValidTimeZone(configured) ? configured : null;
  try {
    return parseEras(env.ERAS, undefined).at(-1)!.timeZone;
  } catch {
    return null;
  }
}

/**
 * The zone's offset from each transition on, as [from_ms, offset_ms] rows,
 * written out to `untilMs`. Offsets are sampled every 12 hours (no zone
 * changes twice in that time) and each change found to the second, which is
 * as fine as Intl resolves an instant, so the SQL day of a play matches
 * localDayKey's exactly.
 */
export function zoneOffsets(timeZone: string, untilMs: number): Array<[number, number]> {
  const offsetAt = (seconds: number) => offsetMsAt(seconds * 1000, timeZone);
  const step = (12 * 3_600_000) / 1000;
  let at = FIRST_MS / 1000;
  let offset = offsetAt(at);
  const rows: Array<[number, number]> = [[BEFORE_ALL_MS, offset]];
  while (at * 1000 < untilMs) {
    const next = at + step;
    const nextOffset = offsetAt(next);
    if (nextOffset !== offset) {
      let lo = at;
      let hi = next;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (offsetAt(mid) === offset) lo = mid;
        else hi = mid;
      }
      rows.push([hi * 1000, nextOffset]);
      offset = nextOffset;
    }
    at = next;
  }
  return rows;
}

/** Whether local dates only ever move forward: no change of offset takes a clock back across midnight. */
export function datesRunForward(timeZone: string, offsets: Array<[number, number]>): boolean {
  return offsets.every(([fromMs], i) => i === 0 || localDayKey(fromMs - 1, timeZone) <= localDayKey(fromMs, timeZone));
}

/** Whether a stored rollup can answer for `timeZone` now. */
export function rollupServes(state: RollupState | null | undefined, timeZone: string, now: number): boolean {
  return state?.usable === 1 && state.time_zone === timeZone && state.horizon_ms > now;
}

/** Whether `ms` is exactly where local day `day` begins: it is that day, and the instant before is not. */
export function beginsDay(ms: number, day: string, timeZone: string): boolean {
  return localDayKey(ms, timeZone) === day && localDayKey(ms - 1, timeZone) < day;
}

/** Whether `ms` is exactly where local day `day` ends: the instant before is that day, and `ms` is later. */
export function endsDay(ms: number, day: string, timeZone: string): boolean {
  return localDayKey(ms - 1, timeZone) === day && localDayKey(ms, timeZone) > day;
}

const monthAfter = (month: string) => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * The whole local months inside [from, to], and the UTC instants they span,
 * or null when there are none, or when either end is not exactly where its
 * local day begins.
 */
export function wholeMonths(
  from: string,
  to: string,
  timeZone: string,
): { first: string; last: string; startMs: number; endMs: number } | null {
  const first = from.endsWith('-01') ? from.slice(0, 7) : monthAfter(from.slice(0, 7));
  // The last month is whole if `to` is its last day, that is, the next day is the 1st.
  const dayAfterTo = localDayKey(Date.parse(`${to}T12:00:00Z`) + DAY_MS, 'UTC');
  const end = dayAfterTo.endsWith('-01') ? dayAfterTo.slice(0, 7) : to.slice(0, 7);
  if (first >= end) return null;
  let startMs: number;
  let endMs: number;
  try {
    startMs = startOfLocalDayUtcMs(`${first}-01`, timeZone);
    endMs = startOfLocalDayUtcMs(`${end}-01`, timeZone);
  } catch {
    return null;
  }
  if (!beginsDay(startMs, `${first}-01`, timeZone) || !beginsDay(endMs, `${end}-01`, timeZone)) return null;
  // The month before `end`, as a string compare bound.
  const [year, m] = end.split('-').map(Number) as [number, number];
  const last = m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
  return { first, last, startMs, endMs };
}

/**
 * `c(track_id, <column>)`: plays per track in [fromMs, toMs), taking the
 * whole months from the rollup and the plays either side of them. Binds, in
 * order: first month, last month, fromMs, months' startMs, months' endMs, toMs.
 */
export const rollupTrackCountsCte = (column: string) => `c AS (
       SELECT track_id, SUM(n) AS ${column} FROM (
         SELECT track_id, plays AS n FROM rollup_month_tracks WHERE month >= ? AND month <= ? AND plays > 0
         UNION ALL SELECT track_id, 1 FROM plays WHERE played_at_ms >= ? AND played_at_ms < ?
         UNION ALL SELECT track_id, 1 FROM plays WHERE played_at_ms >= ? AND played_at_ms < ?
       ) GROUP BY track_id
     )`;

/** The counting-plays equivalent of rollupTrackCountsCte. Binds fromMs, toMs. */
export const plainTrackCountsCte = (column: string) => `c AS (
       SELECT track_id, COUNT(*) AS ${column} FROM plays
        WHERE played_at_ms >= ? AND played_at_ms < ? GROUP BY track_id
     )`;

/**
 * Run `sql(cte)` with per-track counts for [fromMs, toMs): from the rollup
 * when it can answer exactly, else from the plays. The rollup's state is
 * read in the same batch as the rollup query, so the common case is still
 * one round trip. `binds` follow the CTE's.
 */
export async function withTrackCounts<T>(
  env: Env,
  range: { from: string; to: string; fromMs: number; toMs: number; timeZone: string },
  column: string,
  sql: (cte: string) => string,
  binds: unknown[],
): Promise<{ result: D1Result<T>; all: D1Result[]; rollup: boolean }> {
  const months = wholeMonths(range.from, range.to, range.timeZone);
  if (months && months.startMs >= range.fromMs && months.endMs <= range.toMs) {
    const [state, result] = await env.DB.batch([
      env.DB.prepare(ROLLUP_STATE_SQL),
      env.DB.prepare(sql(rollupTrackCountsCte(column))).bind(
        months.first,
        months.last,
        range.fromMs,
        months.startMs,
        months.endMs,
        range.toMs,
        ...binds,
      ),
    ]);
    if (rollupServes(state!.results[0] as RollupState | undefined, range.timeZone, Date.now())) {
      return { result: result as D1Result<T>, all: [state!, result!], rollup: true };
    }
  }
  const result = await env.DB.prepare(sql(plainTrackCountsCte(column)))
    .bind(range.fromMs, range.toMs, ...binds)
    .all<T>();
  return { result, all: [result], rollup: false };
}

/**
 * Plays per local day over [from, to] from the rollup, or null when it cannot
 * answer exactly: only when the range runs from local midnight to local
 * midnight in the rollup's zone, so its days are the range's, and the rollup
 * serves that zone now. Days without plays are left out.
 */
export async function rollupDayCounts(
  env: Env,
  range: { from: string; to: string; fromMs: number; toMs: number; timeZone: string },
): Promise<{ days: Array<{ day: string; plays: number }>; rowsRead: number; durationMs: number | null } | null> {
  if (!beginsDay(range.fromMs, range.from, range.timeZone) || !endsDay(range.toMs, range.to, range.timeZone)) return null;
  const [state, days] = await env.DB.batch([
    env.DB.prepare(ROLLUP_STATE_SQL),
    env.DB.prepare('SELECT day, plays FROM rollup_days WHERE day >= ? AND day <= ? AND plays > 0').bind(range.from, range.to),
  ]);
  if (!rollupServes(state!.results[0] as RollupState | undefined, range.timeZone, Date.now())) return null;
  return {
    days: days!.results as Array<{ day: string; plays: number }>,
    rowsRead: (state!.meta?.rows_read ?? 0) + (days!.meta?.rows_read ?? 0),
    durationMs: days!.meta?.duration ?? null,
  };
}

/**
 * Make the rollup match the configured zone. Each day this writes out a
 * little more of the zone's offsets; when the zone changed, its rules
 * changed (a new tzdata), or the offsets ran out before a poll, it rebuilds
 * every count from the plays, in one transaction. Also POST /admin/rollup.
 */
export async function ensureRollup(
  env: Env,
  options: { now?: number; rebuild?: boolean } = {},
): Promise<{ time_zone: string | null; rebuilt: boolean; usable: boolean; horizon_ms: number | null }> {
  const now = options.now ?? Date.now();
  const zone = rollupZone(env);
  if (zone === null) return { time_zone: null, rebuilt: false, usable: false, horizon_ms: null };

  const db = env.DB;
  const horizon = Math.ceil((now + HORIZON_AHEAD_MS) / DAY_MS) * DAY_MS;
  const offsets = zoneOffsets(zone, horizon);
  const usable = datesRunForward(zone, offsets);
  const [stateResult, storedResult] = await db.batch([
    db.prepare(ROLLUP_STATE_SQL),
    db.prepare('SELECT from_ms, offset_ms FROM rollup_offsets ORDER BY from_ms'),
  ]);
  const state = stateResult!.results[0] as RollupState | undefined;
  const stored = storedResult!.results as Array<{ from_ms: number; offset_ms: number }>;

  // The stored offsets are still right if they agree with today's
  // computation everywhere up to their horizon, which has not yet passed.
  const known = (rows: Array<[number, number]>) => rows.filter(([fromMs]) => fromMs < state!.horizon_ms).join(';');
  const intact =
    !options.rebuild &&
    state !== undefined &&
    state.time_zone === zone &&
    state.horizon_ms > now &&
    known(stored.map((row) => [row.from_ms, row.offset_ms])) === known(offsets);

  const offsetInserts = (rows: Array<[number, number]>) =>
    buildInserts(db, 'rollup_offsets', ['from_ms', 'offset_ms'], rows.map(([from_ms, offset_ms]) => ({ from_ms, offset_ms })), {
      verb: 'INSERT OR REPLACE',
    });
  const setState = db
    .prepare(
      `INSERT INTO rollup_state (id, time_zone, usable, horizon_ms) VALUES (1, ?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET time_zone = ?1, usable = ?2, horizon_ms = ?3`,
    )
    .bind(zone, usable ? 1 : 0, horizon);

  if (intact) {
    await db.batch([...offsetInserts(offsets.filter(([fromMs]) => fromMs >= state!.horizon_ms)), setState]);
    return { time_zone: zone, rebuilt: false, usable, horizon_ms: horizon };
  }

  await db.batch([
    db.prepare('DELETE FROM rollup_offsets'),
    ...offsetInserts(offsets),
    db.prepare('DELETE FROM rollup_days'),
    db.prepare('DELETE FROM rollup_month_tracks'),
    db.prepare(
      `INSERT INTO rollup_days (day, plays)
       SELECT day, COUNT(*) FROM (SELECT ${localDaySql('p.played_at_ms')} AS day FROM plays p) GROUP BY day`,
    ),
    db.prepare(
      `INSERT INTO rollup_month_tracks (month, track_id, plays)
       SELECT substr(day, 1, 7), track_id, COUNT(*)
         FROM (SELECT ${localDaySql('p.played_at_ms')} AS day, p.track_id FROM plays p) GROUP BY 1, 2`,
    ),
    setState,
  ]);
  return { time_zone: zone, rebuilt: true, usable, horizon_ms: horizon };
}
