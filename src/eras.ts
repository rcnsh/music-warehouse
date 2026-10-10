import { localDayKey, startOfLocalDayUtcMs } from './tz';

/**
 * Where the listener lived, and so which clock "local time" means.
 *
 * Plays carry no location. The Singapore era starts at MOVED_AT, an ISO
 * instant held as a Worker secret rather than in this public repo: the stats
 * only ever publish the month of the move, and the exact day would undo that.
 * Without MOVED_AT everything is read as one Newcastle era.
 */

export interface Era {
  key: string;
  label: string;
  timeZone: string;
  /** Inclusive UTC ms at which this era starts. Eras are contiguous and in order. */
  fromMs: number;
  /**
   * SQL for this era's UTC offset in seconds, in terms of `s` (UTC epoch
   * seconds) and `y` (its UTC year as text). SQLite has no zone database, so
   * the rule is spelled out; the stats tests check it against Intl.
   */
  offsetSql: string;
}

/** Before this there are only a few dozen plays, which would read as noise. */
export const HISTORY_START_MS = Date.UTC(2020, 5, 30, 23); // 2020-07-01 00:00 Europe/London

const DAY_MS = 86_400_000;

// UK summer time runs from 01:00 UTC on the last Sunday in March to 01:00 UTC
// on the last Sunday in October (unchanged since 1996).
const LONDON_OFFSET_SQL = `CASE
  WHEN s >= CAST(strftime('%s', date(y || '-03-25', 'weekday 0') || ' 01:00') AS INTEGER)
   AND s <  CAST(strftime('%s', date(y || '-10-25', 'weekday 0') || ' 01:00') AS INTEGER)
  THEN 3600 ELSE 0 END`;

export function erasFor(movedAt: string | undefined): Era[] {
  const eras: Era[] = [
    { key: 'newcastle', label: 'Newcastle', timeZone: 'Europe/London', fromMs: HISTORY_START_MS, offsetSql: LONDON_OFFSET_SQL },
  ];
  const moveMs = movedAt ? Date.parse(movedAt) : Number.NaN;
  if (Number.isFinite(moveMs) && moveMs > HISTORY_START_MS) {
    eras.push({ key: 'singapore', label: 'Singapore', timeZone: 'Asia/Singapore', fromMs: moveMs, offsetSql: '28800' });
  }
  return eras;
}

export function eraAt(eras: readonly Era[], utcMs: number): Era {
  let current = eras[0]!;
  for (const era of eras) if (utcMs >= era.fromMs) current = era;
  return current;
}

/** UTC ms at which the era after `era` begins, or null for the current one. */
export function eraEndMs(eras: readonly Era[], era: Era): number | null {
  const next = eras[eras.indexOf(era) + 1];
  return next ? next.fromMs : null;
}

/**
 * SQL giving local epoch seconds (UTC seconds shifted by the offset in force)
 * plus a 0-based era index, for a row whose UTC seconds are `s` and UTC year
 * text is `y`. `date(local, 'unixepoch')` then yields the local calendar day.
 */
export function localTimeSql(eras: readonly Era[]): { local: string; era: string } {
  const latestFirst = eras.map((era, index) => ({ era, index })).reverse();
  const era = `CASE ${latestFirst.map(({ era, index }) => `WHEN s * 1000 >= ${era.fromMs} THEN ${index}`).join(' ')} ELSE 0 END`;
  const offset = `CASE ${latestFirst.map(({ era }) => `WHEN s * 1000 >= ${era.fromMs} THEN (${era.offsetSql})`).join(' ')} ELSE 0 END`;
  return { local: `s + ${offset}`, era };
}

/** 'YYYY-MM' of a UTC instant in the given zone. */
export function monthOf(utcMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })
    .format(new Date(utcMs))
    .slice(0, 7);
}

/** UTC ms of local midnight starting today, in the era in force now. */
export function startOfLocalToday(eras: readonly Era[], now: number): number {
  const { timeZone } = eraAt(eras, now);
  return startOfLocalDayUtcMs(localDayKey(now, timeZone), timeZone);
}

/**
 * UTC ms of local midnight starting this Monday, in the era in force now.
 *
 * Stats that would otherwise change daily are computed only up to here. A
 * count that ticks over once a day, set beside today's date, dates whatever
 * it counts from — a streak's first day, say — and comparing one day's page
 * with the next isolates a single day's listening. Weekly steps blunt both.
 */
export function startOfLocalWeek(eras: readonly Era[], now: number): number {
  const { timeZone } = eraAt(eras, now);
  const today = localDayKey(now, timeZone);
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const monday = localDayKey(Date.parse(`${today}T12:00:00Z`) - weekday * DAY_MS, 'UTC');
  return startOfLocalDayUtcMs(monday, timeZone);
}
