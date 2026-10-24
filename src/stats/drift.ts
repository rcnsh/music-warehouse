import { type Era, eraEndMs, historyStartMs, monthOf } from '../eras';
import { PRIMARY_ARTIST_SQL } from './sql';

/**
 * Artist drift into the latest stage (see src/eras.ts), usually a move.
 * Gaps between stages count as history but are never the latest or previous
 * stage. A latest stage that has ended is measured up to its end.
 *
 * The latest era is usually far shorter than everything before it, so it is
 * compared with the same number of months immediately before it began, not
 * with all of history. To say whether that change is unusual, history is cut into
 * back-to-back blocks of the same length and the change between each
 * neighbouring pair is measured the same way. Without that baseline any
 * two-month slice looks like a reinvention.
 *
 * Everything is in whole UTC calendar months, and the month of the move
 * belongs to neither side. A window counted in days would date the move:
 * "73 days since moving" beside today's date names the day.
 *
 * There is no genre data in the warehouse, so this is artists only. Change is
 * total variation distance between the two artist mixes: the share of
 * listening that would have to move to turn one into the other.
 */

const LIST = 8;

export interface ArtistShare {
  artist: string;
  share: number;
}

export interface EraName {
  key: string;
  label: string;
}

export interface Drift {
  as_of: string;
  /** The latest stage, and the stage before it; null when nothing comes before it. */
  latest_era: EraName | null;
  previous_era: EraName | null;
  /** The UTC month the latest era began. */
  move_month: string | null;
  /** Complete months on each side of the move; 0 until the first one ends. */
  window_months: number;
  latest: { from: string; to: string } | null;
  before: { from: string; to: string } | null;
  ready: boolean;
  summary: {
    /** Share of the latest era's plays that went to artists already played before it. */
    known_artist_share: number;
    new_artists: number;
    artists: number;
    change: number;
    typical_change: { median: number; min: number; max: number; windows: number; exceeded_by: number };
  } | null;
  /** `earlier` is all history before the latest era began. */
  top: { earlier: ArtistShare[]; before: ArtistShare[]; latest: ArtistShare[] };
  risers: Array<{ artist: string; before: number; after: number }>;
  fallers: Array<{ artist: string; before: number; after: number }>;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

type Mix = Map<string, number>;

function shares(mix: Mix): Mix {
  const total = [...mix.values()].reduce((sum, n) => sum + n, 0);
  return new Map([...mix].map(([k, n]) => [k, total ? n / total : 0]));
}

export function totalVariation(a: Mix, b: Mix): number {
  const sa = shares(a);
  const sb = shares(b);
  let sum = 0;
  for (const k of new Set([...sa.keys(), ...sb.keys()])) sum += Math.abs((sa.get(k) ?? 0) - (sb.get(k) ?? 0));
  return sum / 2;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Months as an integer count since year 0, so arithmetic is plain subtraction. */
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const monthKey = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

function merge(mixes: Array<Mix | undefined>): Mix {
  const out: Mix = new Map();
  for (const mix of mixes) for (const [k, n] of mix ?? []) out.set(k, (out.get(k) ?? 0) + n);
  return out;
}

export async function computeDrift(db: D1Database, now: number, eras: readonly Era[]): Promise<Drift> {
  const currentMonth = monthIndex(monthOf(now, 'UTC'));
  const startOfMonth = Date.UTC(Math.floor(currentMonth / 12), currentMonth % 12, 1);

  // Plays per (UTC month, primary artist) through the last complete month.
  const { results } = await db
    .prepare(
      `WITH pm AS MATERIALIZED (
         SELECT strftime('%Y-%m', played_at_ms / 1000, 'unixepoch') AS m, track_id, COUNT(*) AS n
           FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2 GROUP BY m, track_id
       )
       SELECT m, lower(an) AS k, MAX(an) AS name, SUM(n) AS plays
         FROM (SELECT m, n, ${PRIMARY_ARTIST_SQL('pm.track_id')} AS an FROM pm)
        WHERE an IS NOT NULL
        GROUP BY m, k`,
    )
    .bind(historyStartMs(eras), startOfMonth)
    .all<{ m: string; k: string; name: string; plays: number }>();

  const names = new Map<string, string>();
  const months = new Map<number, Mix>();
  for (const row of results) {
    names.set(row.k, row.name);
    const index = monthIndex(row.m);
    if (!months.has(index)) months.set(index, new Map());
    months.get(index)!.set(row.k, row.plays);
  }

  const stages = eras.filter((era) => !era.gap);
  const move = stages.at(-1) !== eras[0] ? stages.at(-1) : undefined;
  const previous = move ? stages.at(-2) : undefined;
  const name = (era: Era | undefined): EraName | null => (era ? { key: era.key, label: era.label } : null);
  const empty = {
    as_of: new Date(startOfMonth).toISOString(),
    latest_era: name(move),
    previous_era: name(previous),
    move_month: move ? monthOf(move.fromMs, 'UTC') : null,
    window_months: 0,
    latest: null,
    before: null,
    ready: false,
    summary: null,
    top: { earlier: [], before: [], latest: [] },
    risers: [],
    fallers: [],
  } satisfies Drift;
  if (!move) return empty;

  const moveMonth = monthIndex(monthOf(move.fromMs, 'UTC'));
  const firstMonth = monthIndex(monthOf(historyStartMs(eras), 'UTC'));
  // A stage that has ended stops at its last complete month, as the current one does.
  const endMs = eraEndMs(eras, move);
  const endMonth = endMs === null ? currentMonth : Math.min(currentMonth, monthIndex(monthOf(endMs, 'UTC')));
  const n = endMonth - moveMonth - 1;
  if (n < 1) return empty;

  const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
  const latestMonths = range(moveMonth + 1, n);
  const beforeMonths = range(moveMonth - n, n);
  const latest = merge(latestMonths.map((m) => months.get(m)));
  const before = merge(beforeMonths.map((m) => months.get(m)));
  const earlier = merge(range(firstMonth, moveMonth - firstMonth + 1).map((m) => months.get(m)));

  // Back-to-back blocks of n months ending where `before` ends, each compared
  // with the one before it.
  const blocks: Mix[] = [];
  for (let end = moveMonth; end - n >= firstMonth; end -= n) {
    blocks.push(merge(range(end - n, n).map((m) => months.get(m))));
  }
  const changes: number[] = [];
  for (let i = 0; i + 1 < blocks.length; i++) changes.push(totalVariation(blocks[i + 1]!, blocks[i]!));

  const topOf = (mix: Mix): ArtistShare[] =>
    [...shares(mix)]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LIST)
      .map(([k, share]) => ({ artist: names.get(k) ?? k, share: round(share) }));

  const sBefore = shares(before);
  const sAfter = shares(latest);
  const deltas = [...new Set([...sBefore.keys(), ...sAfter.keys()])].map((k) => ({
    artist: names.get(k) ?? k,
    before: round(sBefore.get(k) ?? 0),
    after: round(sAfter.get(k) ?? 0),
    delta: (sAfter.get(k) ?? 0) - (sBefore.get(k) ?? 0),
  }));
  const strip = ({ artist, before, after }: (typeof deltas)[number]) => ({ artist, before, after });

  const change = totalVariation(before, latest);
  const latestPlays = [...latest.values()].reduce((sum, v) => sum + v, 0);
  const knownPlays = [...latest].filter(([k]) => earlier.has(k)).reduce((sum, [, v]) => sum + v, 0);
  const ready = latestPlays > 0 && changes.length > 0;

  return {
    ...empty,
    window_months: n,
    latest: { from: monthKey(latestMonths[0]!), to: monthKey(latestMonths.at(-1)!) },
    before: { from: monthKey(beforeMonths[0]!), to: monthKey(beforeMonths.at(-1)!) },
    ready,
    summary: ready
      ? {
          known_artist_share: round(knownPlays / latestPlays),
          new_artists: [...latest.keys()].filter((k) => !earlier.has(k)).length,
          artists: latest.size,
          change: round(change),
          typical_change: {
            median: round(median(changes)),
            min: round(Math.min(...changes)),
            max: round(Math.max(...changes)),
            windows: changes.length,
            exceeded_by: changes.filter((c) => c > change).length,
          },
        }
      : null,
    top: { earlier: topOf(earlier), before: topOf(before), latest: topOf(latest) },
    risers: deltas
      .filter((d) => d.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, LIST)
      .map(strip),
    fallers: deltas
      .filter((d) => d.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, LIST)
      .map(strip),
  };
}
