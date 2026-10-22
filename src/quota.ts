import { log } from './log';

/**
 * The Spotify quota, as this Worker sees it (migration 0021).
 *
 * Since July 2026 a development-mode app's quota is shared by every app on
 * the owner's developer account, so the Android app and this Worker spend
 * one budget. Going over returns 429 with "QUOTA_EXCEEDED" and a Retry-After
 * of hours, and calling again before it passes only extends the penalty.
 *
 * So any 429 pauses every Spotify call from every isolate until its
 * Retry-After has passed (`spotify_pause`), and every request actually sent
 * is counted per hour, by what sent it, for /health (`spotify_calls`). The
 * gate itself is in src/spotify.ts, around the one fetch every call makes.
 */

export type PauseKind = 'rate_limited' | 'quota_exceeded';

/** What sent a call, for the counts in /health. */
export type CallSource =
  | 'poll'
  | 'now-playing'
  | 'recently-played'
  | 'top'
  | 'contexts'
  | 'backfill'
  | 'signin'
  | 'play'
  | 'admin';

export type CallOutcome = '2xx' | '429' | 'other';

export interface SpotifyPause {
  until_ms: number;
  kind: PauseKind;
}

/** A Retry-After longer than this is taken as this. */
export const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;
/** The pause when a 429 carries no Retry-After. */
export const DEFAULT_PAUSE_SECONDS: Record<PauseKind, number> = { rate_limited: 60, quota_exceeded: 60 * 60 };
/** How long an isolate trusts its last read of the pause; one D1 read per Spotify call otherwise. */
const PAUSE_MEMO_MS = 5_000;
/** Call counts older than this are pruned by the poll cron. */
export const CALLS_KEPT_MS = 14 * 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

let memo: { pause: SpotifyPause | null; readMs: number } | null = null;

/** Drop this isolate's copy of the pause, so the next check reads D1. For tests. */
export function forgetPauseMemo(): void {
  memo = null;
}

/** The pause in force at `now`, or null, read from D1. For /health and the alert check. */
export async function storedPause(db: D1Database, now: number = Date.now()): Promise<SpotifyPause | null> {
  return db
    .prepare('SELECT until_ms, kind FROM spotify_pause WHERE id = 1 AND until_ms > ?')
    .bind(now)
    .first<SpotifyPause>();
}

/**
 * The pause in force at `now`, or null, for the gate in front of every call.
 * Read from D1 at most every PAUSE_MEMO_MS per isolate; a pause another
 * isolate records reaches this one within that.
 */
export async function readPause(db: D1Database, now: number = Date.now()): Promise<SpotifyPause | null> {
  if (!memo || now - memo.readMs >= PAUSE_MEMO_MS || now < memo.readMs) {
    const row = await db.prepare('SELECT until_ms, kind FROM spotify_pause WHERE id = 1').first<SpotifyPause>();
    memo = { pause: row ?? null, readMs: now };
  }
  return memo.pause && memo.pause.until_ms > now ? memo.pause : null;
}

/** How long a 429 pauses calls for, in seconds: its Retry-After, or the kind's default, at most a day. */
export function pauseSeconds(kind: PauseKind, retryAfterSeconds: number | null): number {
  const seconds = retryAfterSeconds ?? DEFAULT_PAUSE_SECONDS[kind];
  return Math.min(MAX_PAUSE_MS / 1000, Math.max(1, Math.ceil(seconds)));
}

/**
 * Pause every Spotify call for `seconds` from `now`. A later deadline already
 * stored is kept: one short 429 must not cut a quota penalty short. Returns
 * the pause now in force.
 */
export async function recordPause(
  db: D1Database,
  kind: PauseKind,
  seconds: number,
  now: number = Date.now(),
): Promise<SpotifyPause> {
  const [, current] = await db.batch<SpotifyPause>([
    db
      .prepare(
        `INSERT INTO spotify_pause (id, until_ms, kind, set_ms) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET until_ms = excluded.until_ms, kind = excluded.kind, set_ms = excluded.set_ms
          WHERE excluded.until_ms > spotify_pause.until_ms`,
      )
      .bind(now + seconds * 1000, kind, now),
    db.prepare('SELECT until_ms, kind FROM spotify_pause WHERE id = 1'),
  ]);
  const pause = current?.results[0] ?? { until_ms: now + seconds * 1000, kind };
  memo = { pause, readMs: now };
  return pause;
}

const hourOf = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/** Count one request sent to api.spotify.com in its hour. */
export function countCall(db: D1Database, source: CallSource, outcome: CallOutcome, now: number = Date.now()) {
  return db
    .prepare(
      `INSERT INTO spotify_calls (hour_ms, source, outcome, calls) VALUES (?, ?, ?, 1)
       ON CONFLICT(hour_ms, source, outcome) DO UPDATE SET calls = calls + 1`,
    )
    .bind(hourOf(now), source, outcome)
    .run();
}

/**
 * Counts held until one write, for a caller that makes several calls and
 * keeps to a subrequest budget (the poll). `flush` writes them all in one
 * statement and never throws.
 */
export class CallTally {
  private readonly counts = new Map<string, number>();

  add(source: CallSource, outcome: CallOutcome): void {
    const key = JSON.stringify([source, outcome]);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  async flush(db: D1Database, now: number = Date.now()): Promise<void> {
    if (this.counts.size === 0) return;
    const rows = [...this.counts].map(([key, calls]) => [...(JSON.parse(key) as [string, string]), calls]);
    this.counts.clear();
    try {
      await db
        .prepare(
          `INSERT INTO spotify_calls (hour_ms, source, outcome, calls)
           SELECT ?1, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]')
             FROM json_each(?2) j
            WHERE true
           ON CONFLICT(hour_ms, source, outcome) DO UPDATE SET calls = calls + excluded.calls`,
        )
        .bind(hourOf(now), JSON.stringify(rows))
        .run();
    } catch (error) {
      log('spotify-count-failed', { rows, error }, 'error');
    }
  }
}

/** Drop counts older than CALLS_KEPT_MS. Run by the poll cron. */
export function pruneCalls(db: D1Database, now: number = Date.now()) {
  return db.prepare('DELETE FROM spotify_calls WHERE hour_ms < ?').bind(now - CALLS_KEPT_MS).run();
}

export interface SpotifyUsage {
  paused_until_ms: number | null;
  paused_until_iso: string | null;
  pause_kind: PauseKind | null;
  /** Requests sent in the last 24 hourly buckets, this one included. */
  calls_24h: number;
  by_source_24h: Partial<Record<CallSource, number>>;
  /** Of those, how many Spotify answered with 429. */
  rate_limited_24h: number;
}

/** The pause and the last day's calls, for /health. Reads D1, not the isolate's memo. */
export async function spotifyUsage(db: D1Database, now: number = Date.now()): Promise<SpotifyUsage> {
  const [pauseRows, callRows] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT until_ms, kind FROM spotify_pause WHERE id = 1 AND until_ms > ?').bind(now),
    db
      .prepare(
        'SELECT source, outcome, SUM(calls) AS calls FROM spotify_calls WHERE hour_ms >= ? GROUP BY source, outcome',
      )
      .bind(hourOf(now) - 23 * HOUR_MS),
  ]);
  const pause = (pauseRows?.results[0] as SpotifyPause | undefined) ?? null;

  const bySource: Partial<Record<CallSource, number>> = {};
  let total = 0;
  let rateLimited = 0;
  for (const row of (callRows?.results ?? []) as Array<{ source: CallSource; outcome: CallOutcome; calls: number }>) {
    bySource[row.source] = (bySource[row.source] ?? 0) + row.calls;
    total += row.calls;
    if (row.outcome === '429') rateLimited += row.calls;
  }

  return {
    paused_until_ms: pause?.until_ms ?? null,
    paused_until_iso: pause ? new Date(pause.until_ms).toISOString() : null,
    pause_kind: pause?.kind ?? null,
    calls_24h: total,
    by_source_24h: bySource,
    rate_limited_24h: rateLimited,
  };
}
