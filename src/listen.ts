/**
 * How long a play lasted, and whether it was a skip: the one estimate behind
 * every minute and every "skips count for nothing" in the warehouse.
 *
 * `played_at_ms` is when a play ended, so a play ran for at most the gap
 * since the play before it ended, and at most the track's length. A gap under
 * MIN_PLAY_MS is a skip, worth no minutes. A play with no play before it
 * can't be checked and counts, for its length up to FALLBACK_DURATION_MS.
 *
 * The play before is the latest one that ended *strictly* earlier, so plays
 * tied on `played_at_ms` share it and each counts. Plays are keyed by
 * (played_at_ms, track_id), so a tie is two different tracks ending in the
 * same millisecond, which one listener's player can't do in sequence. The
 * real warehouse's ~1.7k ties are export records, whose times are truncated
 * to the second (offline plays synced together share one), and every stored
 * export record ran MIN_PLAY_MS or more by its own `ms_played`, or the import
 * would have dropped it. Measuring one tied play against the other would call
 * it a 0 ms skip against that direct evidence. Duplicates don't tie either:
 * the export's copy of a polled play ends a second or so from the poller's,
 * and the import drops it (DUPLICATE_WINDOW_MS, src/import.ts).
 *
 * The estimate comes in three forms, so each query keeps its cost: a
 * correlated seek (about two rows read per play, for a few tracks' plays
 * across all time), a window (for a contiguous range read once), and plain JS
 * (for plays already in memory, oldest first). They agree wherever the rows
 * read include each play's play before; where they don't (the start of a
 * window's lookback), a play is treated as having none.
 */

/** Spotify's own threshold for a stream; anything shorter is a skip. */
export const MIN_PLAY_MS = 30_000;
/** Used when a track has no stored duration, or a play has no play before it. */
export const FALLBACK_DURATION_MS = 180_000;

/**
 * SQL: the gap to the play before `column`'s, by one seek on the plays primary
 * key, or NULL for the first play ever.
 */
export const gapSeekSql = (column: string) =>
  `${column} - (SELECT max(q.played_at_ms) FROM plays q WHERE q.played_at_ms < ${column})`;

/**
 * SQL: the same gap as a window over the rows read, which must include the
 * play before each one that matters (a lookback). The RANGE frame ends at the
 * previous millisecond, which leaves ties out.
 */
export const gapWindowSql = (column: string) =>
  `${column} - max(${column}) OVER (ORDER BY ${column} RANGE BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`;

/**
 * SQL: 1 when a play with gap `gap` counts, 0 for a skip. This and
 * listenedMsSql repeat `gap`, so pass a column, not gapSeekSql's subquery.
 */
export const countedSql = (gap: string) => `(${gap} IS NULL OR ${gap} >= ${MIN_PLAY_MS})`;

/** SQL: a play's listened ms, from its gap and its track's duration; 0 for a skip. */
export const listenedMsSql = (gap: string, durationMs: string) =>
  `CASE WHEN ${countedSql(gap)}
        THEN min(coalesce(${gap}, ${FALLBACK_DURATION_MS}), coalesce(${durationMs}, ${FALLBACK_DURATION_MS}))
        ELSE 0 END`;

/** True when a play with this gap counts; false for a skip. */
export const counted = (gapMs: number | null) => gapMs === null || gapMs >= MIN_PLAY_MS;

/** A play's listened ms, as listenedMsSql. */
export function listenedMs(gapMs: number | null, durationMs: number | null): number {
  if (!counted(gapMs)) return 0;
  return Math.min(gapMs ?? FALLBACK_DURATION_MS, durationMs ?? FALLBACK_DURATION_MS);
}

/** Each play's gap, for end times sorted oldest first; null for the first. */
export function gaps(endsMs: readonly number[]): Array<number | null> {
  const out: Array<number | null> = [];
  let before: number | null = null;
  for (let i = 0; i < endsMs.length; i++) {
    if (i > 0 && endsMs[i]! > endsMs[i - 1]!) before = endsMs[i - 1]!;
    out.push(before === null ? null : endsMs[i]! - before);
  }
  return out;
}
