import { type Era, eraAt, eraEndMs, historyStartMs, localTimeSql, monthOf, startOfLocalWeek } from '../eras';
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
 *   nights rather than a routine. The same floors apply to each era's share
 *   of each calendar year.
 *
 * Everything is also broken down by local calendar year, so the page can
 * switch between years without another request.
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

export interface RhythmYear {
  year: string;
  /** The current year, so far. */
  partial: boolean;
  /** Runs clipped to the year; only the current year can have one still running. */
  streaks: StreakSet[];
  /** Only the eras that cover part of the year. */
  eras: EraRhythm[];
}

export interface Rhythm {
  /** The data runs up to (not including) this instant: local midnight starting this week. */
  as_of: string;
  range: { from: string; to: string };
  streaks: StreakSet[];
  eras: EraRhythm[];
  years: RhythmYear[];
}

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/**
 * Runs of consecutive local days whose play count meets the threshold.
 * `lastDay` is the final day the series covers; a run ending on it is running.
 */
export function streaksFrom(
  days: Array<{ day: string; plays: number }>,
  threshold: number,
  lastDay: string,
  { live = true, firstDay }: { live?: boolean; firstDay?: string } = {},
): StreakSet {
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
    const running = live && run.end === lastDay;
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
  const first = firstDay ?? days[0]?.day ?? lastDay;
  const span = dayNumber(lastDay) - dayNumber(first) + 1;

  return {
    threshold,
    current_weeks: live && latest && latest.end === lastDay ? Math.floor(latest.days / 7) : 0,
    longest: ranked[0] ? toStreak(ranked[0]) : null,
    top: ranked.slice(0, TOP_STREAKS).map(toStreak),
    active_share: span > 0 ? round(active / span) : 0,
  };
}

export async function computeRhythm(db: D1Database, now: number, eras: readonly Era[]): Promise<Rhythm> {
  const cutoff = startOfLocalWeek(eras, now);
  const { local, era } = localTimeSql(eras);
  // One pass over the plays primary key, counted per UTC quarter hour before
  // shifting to local time. Every zone's offset since Spotify began is a whole
  // number of quarter hours (India's +5:30, Nepal's +5:45), so no quarter hour
  // straddles a local hour; bucketing by UTC hour would split India's at :30.
  const { results } = await db
    .prepare(
      `WITH h AS (
         SELECT played_at_ms / 900000 * 900 AS s, COUNT(*) AS n
           FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2 GROUP BY played_at_ms / 900000
       ),
       loc AS (
         SELECT n, ${era} AS era, ${local} AS ls
           FROM (SELECT n, s FROM h)
       )
       SELECT 'day' AS kind, NULL AS era, date(ls, 'unixepoch') AS day, NULL AS dow, NULL AS hour, SUM(n) AS plays
         FROM loc GROUP BY day
       UNION ALL
       SELECT 'cell', era, strftime('%Y', ls, 'unixepoch'), CAST(strftime('%w', ls, 'unixepoch') AS INTEGER),
              CAST(strftime('%H', ls, 'unixepoch') AS INTEGER), SUM(n)
         FROM loc GROUP BY era, 3, 4, 5`,
    )
    .bind(historyStartMs(eras), cutoff)
    .all<{ kind: string; era: number | null; day: string | null; dow: number | null; hour: number | null; plays: number }>();

  const lastDay = localDayKey(cutoff - 1, eraAt(eras, cutoff - 1).timeZone);
  const days = results
    .filter((row) => row.kind === 'day')
    .map((row) => ({ day: row.day!, plays: row.plays }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const range = { from: monthOf(historyStartMs(eras), eras[0]!.timeZone), to: lastDay.slice(0, 7) };

  type Grid = number[][];
  const emptyGrid = (): Grid => Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  // Per era, per local year ('YYYY'), plays in each weekday × hour cell.
  const cells = eras.map(() => new Map<string, Grid>());
  for (const row of results) {
    if (row.kind !== 'cell') continue;
    const byYear = cells[row.era!]!;
    if (!byYear.has(row.day!)) byYear.set(row.day!, emptyGrid());
    // SQLite's %w is Sunday-first; the grid is Monday-first.
    const cellRow = byYear.get(row.day!)![(row.dow! + 6) % 7]!;
    cellRow[row.hour!] = (cellRow[row.hour!] ?? 0) + row.plays;
  }

  const sumGrids = (grids: Grid[]): Grid => {
    const out = emptyGrid();
    for (const grid of grids) grid.forEach((row, d) => row.forEach((n, h) => (out[d]![h]! += n)));
    return out;
  };

  /** One era's figures over [fromMs, toMs), gated on how much of the era that span covers. */
  const eraRhythm = (index: number, grid: Grid, fromMs: number, toMs: number, live: boolean): EraRhythm => {
    const era = eras[index]!;
    const endMs = eraEndMs(eras, era);
    const coveredFrom = Math.max(era.fromMs, fromMs);
    const coveredTo = Math.min(endMs ?? cutoff, toMs, cutoff);
    const coveredDays = Math.max(0, (coveredTo - coveredFrom) / DAY_MS);
    const total = grid.flat().reduce((sum, n) => sum + n, 0);
    const share = (n: number) => (total ? round(n / total) : 0);
    const hoursReady = coveredDays >= HOURS_MIN_DAYS && total > 0;
    const gridReady = coveredDays >= GRID_MIN_DAYS && total > 0;
    // "Available from" only means something while the span is still growing,
    // and only if it will get there before the span ends.
    const availableFrom = (minDays: number, ready: boolean) => {
      const at = coveredFrom + minDays * DAY_MS;
      return ready || !live || at >= toMs ? null : monthOf(at, era.timeZone);
    };

    return {
      key: era.key,
      label: era.label,
      from: monthOf(coveredFrom, era.timeZone),
      to: live && endMs === null ? null : monthOf(coveredTo - 1, era.timeZone),
      hour_share: hoursReady
        ? Array.from({ length: 24 }, (_, hour) => share(grid.reduce((sum, row) => sum + row[hour]!, 0)))
        : null,
      grid: gridReady ? grid.map((row) => row.map(share)) : null,
      hours_available_from: availableFrom(HOURS_MIN_DAYS, hoursReady),
      grid_available_from: availableFrom(GRID_MIN_DAYS, gridReady),
    };
  };

  const eraRhythms = eras.map((_, index) =>
    eraRhythm(index, sumGrids([...cells[index]!.values()]), historyStartMs(eras), Infinity, true),
  );

  const currentYear = lastDay.slice(0, 4);
  const yearKeys = [...new Set(days.map((d) => d.day.slice(0, 4)))].sort();
  const years = yearKeys.map((year): RhythmYear => {
    const live = year === currentYear;
    const yearDays = days.filter((d) => d.day.startsWith(year));
    const yearLast = live ? lastDay : `${year}-12-31`;
    const firstDay = year === range.from.slice(0, 4) ? yearDays[0]?.day : `${year}-01-01`;
    // Local years differ from UTC by hours at most; the gate only needs days.
    const fromMs = Date.UTC(Number(year), 0, 1);
    const toMs = Date.UTC(Number(year) + 1, 0, 1);
    return {
      year,
      partial: live,
      streaks: THRESHOLDS.map((threshold) => streaksFrom(yearDays, threshold, yearLast, { live, firstDay })),
      eras: eras.flatMap((_, index) => {
        const grid = cells[index]!.get(year);
        return grid ? [eraRhythm(index, grid, fromMs, toMs, live)] : [];
      }),
    };
  });

  return {
    as_of: new Date(cutoff).toISOString(),
    range,
    streaks: THRESHOLDS.map((threshold) => streaksFrom(days, threshold, lastDay)),
    eras: eraRhythms,
    years,
  };
}
