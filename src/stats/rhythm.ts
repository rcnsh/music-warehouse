import { HISTORY_START_MS, type Era, eraAt, eraEndMs, localTimeSql, monthOf, startOfLocalWeek } from '../eras';
import { localDayKey } from '../tz';

/**
 * Listening streaks and time-of-day, in the local time of wherever the
 * listener lived then.
 *
 * Privacy, since this feeds a public page:
 * - Everything is computed only through the end of last week, so nothing
 *   changes day to day (see startOfLocalWeek).
 * - Dates are months. A completed streak keeps its exact length, but a
 *   running one is reported in whole weeks: an exact running count dates
 *   its first day against the cut-off.
 * - An era's hour profile waits for HOURS_MIN_DAYS and its weekday × hour
 *   grid for GRID_MIN_DAYS. Before then each figure describes particular
 *   nights rather than a routine.
 */

const THRESHOLDS = [1, 10, 25] as const;
const TOP_STREAKS = 5;
export const HOURS_MIN_DAYS = 28;
export const GRID_MIN_DAYS = 26 * 7;
const DAY_MS = 86_400_000;

export interface Streak {
  /** Exact length for a finished streak; null while it is still running. */
  days: number | null;
  weeks: number;
  from: string;
  to: string;
  running: boolean;
}

export interface StreakSet {
  threshold: number;
  current_weeks: number;
  longest: Streak | null;
  top: Streak[];
  /** Share of days in the range with at least `threshold` plays. */
  active_share: number;
}

export interface EraRhythm {
  key: string;
  label: string;
  from: string;
  to: string | null;
  /** Share of the era's plays in each local hour, 0–23; null until the era is long enough. */
  hour_share: number[] | null;
  /** Monday-first, 7 × 24 shares of the era's plays; null until the era is long enough. */
  grid: number[][] | null;
  hours_available_from: string | null;
  grid_available_from: string | null;
}

export interface Rhythm {
  /** The data runs up to (not including) this instant: local midnight starting this week. */
  as_of: string;
  range: { from: string; to: string };
  streaks: StreakSet[];
  eras: EraRhythm[];
}

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/**
 * Runs of consecutive local days whose play count meets the threshold.
 * `lastDay` is the final day the series covers; a run ending on it is running.
 */
export function streaksFrom(days: Array<{ day: string; plays: number }>, threshold: number, lastDay: string): StreakSet {
  const runs: Array<{ start: string; end: string; days: number }> = [];
  let active = 0;
  let previous: number | null = null;
  for (const { day, plays } of days) {
    if (plays < threshold) continue;
    active++;
    const n = dayNumber(day);
    const last = runs[runs.length - 1];
    if (last && previous !== null && n === previous + 1) {
      last.end = day;
      last.days++;
    } else {
      runs.push({ start: day, end: day, days: 1 });
    }
    previous = n;
  }

  const toStreak = (run: (typeof runs)[number]): Streak => {
    const running = run.end === lastDay;
    return {
      days: running ? null : run.days,
      weeks: Math.floor(run.days / 7),
      from: run.start.slice(0, 7),
      to: run.end.slice(0, 7),
      running,
    };
  };

  const ranked = [...runs].sort((a, b) => b.days - a.days || b.start.localeCompare(a.start));
  const latest = runs[runs.length - 1];
  const first = days[0]?.day ?? lastDay;
  const span = dayNumber(lastDay) - dayNumber(first) + 1;

  return {
    threshold,
    current_weeks: latest && latest.end === lastDay ? Math.floor(latest.days / 7) : 0,
    longest: ranked[0] ? toStreak(ranked[0]) : null,
    top: ranked.slice(0, TOP_STREAKS).map(toStreak),
    active_share: span > 0 ? round(active / span) : 0,
  };
}

export async function computeRhythm(db: D1Database, now: number, eras: readonly Era[]): Promise<Rhythm> {
  const cutoff = startOfLocalWeek(eras, now);
  const { local, era } = localTimeSql(eras);
  // One pass over the plays primary key. Both zones only ever shift by whole
  // hours, so bucketing by UTC hour first loses nothing.
  const { results } = await db
    .prepare(
      `WITH h AS (
         SELECT played_at_ms / 3600000 * 3600 AS s, COUNT(*) AS n
           FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2 GROUP BY played_at_ms / 3600000
       ),
       loc AS (
         SELECT n, ${era} AS era, ${local} AS ls
           FROM (SELECT n, s, strftime('%Y', s, 'unixepoch') AS y FROM h)
       )
       SELECT 'day' AS kind, NULL AS era, date(ls, 'unixepoch') AS day, NULL AS dow, NULL AS hour, SUM(n) AS plays
         FROM loc GROUP BY day
       UNION ALL
       SELECT 'cell', era, NULL, CAST(strftime('%w', ls, 'unixepoch') AS INTEGER),
              CAST(strftime('%H', ls, 'unixepoch') AS INTEGER), SUM(n)
         FROM loc GROUP BY era, 4, 5`,
    )
    .bind(HISTORY_START_MS, cutoff)
    .all<{ kind: string; era: number | null; day: string | null; dow: number | null; hour: number | null; plays: number }>();

  const lastDay = localDayKey(cutoff - 1, eraAt(eras, cutoff - 1).timeZone);
  const days = results
    .filter((row) => row.kind === 'day')
    .map((row) => ({ day: row.day!, plays: row.plays }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const cells = eras.map(() => Array.from({ length: 7 }, () => new Array<number>(24).fill(0)));
  for (const row of results) {
    if (row.kind !== 'cell') continue;
    // SQLite's %w is Sunday-first; the grid is Monday-first.
    const cellRow = cells[row.era!]![(row.dow! + 6) % 7]!;
    cellRow[row.hour!] = (cellRow[row.hour!] ?? 0) + row.plays;
  }

  const eraRhythms = eras.map((era, index): EraRhythm => {
    const endMs = eraEndMs(eras, era);
    const coveredDays = Math.max(0, ((endMs ?? cutoff) - era.fromMs) / DAY_MS);
    const grid = cells[index]!;
    const total = grid.flat().reduce((sum, n) => sum + n, 0);
    const share = (n: number) => (total ? round(n / total) : 0);
    const hoursReady = coveredDays >= HOURS_MIN_DAYS && total > 0;
    const gridReady = coveredDays >= GRID_MIN_DAYS && total > 0;

    return {
      key: era.key,
      label: era.label,
      from: monthOf(era.fromMs, era.timeZone),
      to: endMs === null ? null : monthOf(endMs - 1, era.timeZone),
      hour_share: hoursReady
        ? Array.from({ length: 24 }, (_, hour) => share(grid.reduce((sum, row) => sum + row[hour]!, 0)))
        : null,
      grid: gridReady ? grid.map((row) => row.map(share)) : null,
      hours_available_from: hoursReady ? null : monthOf(era.fromMs + HOURS_MIN_DAYS * DAY_MS, era.timeZone),
      grid_available_from: gridReady ? null : monthOf(era.fromMs + GRID_MIN_DAYS * DAY_MS, era.timeZone),
    };
  });

  return {
    as_of: new Date(cutoff).toISOString(),
    range: { from: monthOf(HISTORY_START_MS, eras[0]!.timeZone), to: lastDay.slice(0, 7) },
    streaks: THRESHOLDS.map((threshold) => streaksFrom(days, threshold, lastDay)),
    eras: eraRhythms,
  };
}
