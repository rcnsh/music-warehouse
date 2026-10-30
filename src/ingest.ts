import { countStoredPlays, readState, writeStatements } from './db';
import { CallTally } from './quota';
import { normalize } from './normalize';
import { nameContexts } from './contexts';
import { SpotifyError } from './spotify';
import { type SpotifyClient, spotifyClient } from './spotify-client';
import { NeedsReauthError } from './tokens';
import type { Env, RecentlyPlayedResponse } from './types';
import { log } from './log';

export interface PollResult {
  ok: boolean;
  /** Items returned by Spotify. */
  received: number;
  /** Play rows actually created (duplicates counted as 0). */
  inserted: number;
  /** Items dropped for having no Spotify track id. */
  skipped: number;
  /** Contexts given a name (or a settled refusal) this run. */
  contexts_named?: number;
  cursor_ms: number;
  needs_reauth: boolean;
  error?: string;
  retry_after_seconds?: number;
  /**
   * Set when the poll was skipped because Spotify calls are paused after a
   * 429 (src/quota.ts): when they may resume. Nothing was asked of Spotify,
   * and nothing is recorded as a failure.
   */
  paused_until_ms?: number;
}

function describe(error: unknown): string {
  if (error instanceof SpotifyError) return `${error.kind}: ${error.message}`;
  if (error instanceof NeedsReauthError) return `needs_reauth: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Record a failure. The cursor is deliberately left untouched (R3), so the next
 * run re-requests exactly the same window and nothing is lost.
 */
async function recordFailure(db: D1Database, message: string, now: number): Promise<void> {
  await db
    .prepare(
      'UPDATE sync_state SET last_error = ?, last_error_ms = ?, consecutive_failures = consecutive_failures + 1 WHERE id = 1',
    )
    .bind(message.slice(0, 1000), now)
    .run();
}

/** Context names are a nicety: a failure there must never fail the poll. */
async function nameContextsSafely(db: D1Database, spotify: SpotifyClient, now: number): Promise<number> {
  try {
    return await nameContexts(db, spotify.as('contexts'), now);
  } catch (error) {
    log('context-naming-failed', { message: describe(error) }, 'error');
    return 0;
  }
}

/**
 * Spotify's newest window of plays, and the plays after the cursor when that
 * window doesn't reach back to it.
 *
 * Asking only for plays after the cursor would miss a play Spotify lists
 * late: one played offline and synced afterwards keeps the time it was
 * played, which can be before the newest play already stored. So each poll
 * reads the newest 50 instead, which includes any such play that is still
 * among them, and stores them all; plays are keyed by (played_at_ms,
 * track_id) and inserted OR IGNORE, so the ones already stored cost nothing.
 *
 * When even the oldest of those 50 is newer than the cursor, more than 50
 * plays may have happened since the last poll, so a second request asks for
 * the plays after the cursor as before, and the cursor moves only as far as
 * that answer reaches. The next poll then picks up from there. The cursor
 * is 0 before the first poll, when there is nothing to catch up from.
 */
async function fetchSince(
  spotify: SpotifyClient,
  cursorMs: number,
): Promise<{ payload: RecentlyPlayedResponse; reachMs: number | null }> {
  const latest = await spotify.recentlyPlayed(0);
  const times = (latest.items ?? []).map((item) => Date.parse(item.played_at ?? '')).filter(Number.isFinite);
  if (cursorMs === 0 || times.length === 0 || Math.min(...times) <= cursorMs) return { payload: latest, reachMs: null };

  const after = await spotify.recentlyPlayed(cursorMs);
  const reach = (after.items ?? []).map((item) => Date.parse(item.played_at ?? '')).filter(Number.isFinite);
  return {
    payload: { ...latest, items: [...(after.items ?? []), ...(latest.items ?? [])] },
    reachMs: reach.length ? Math.max(...reach) : cursorMs,
  };
}

/**
 * One poll cycle: read state, get a live access token, fetch the newest
 * plays (and those after the cursor, when there may be a gap), and write
 * them in a single batch.
 *
 * Subrequest budget (R12, ceiling 50): 1 read + at most 4 for token work +
 * at most 4 recently-played fetches (two, retried once after a 401) + 1 write
 * batch = 10, then context naming: 1 read + LOOKUPS_PER_POLL (3) Spotify
 * calls + 1 write = 15, plus 1 read of the Spotify pause and 1 write of
 * every call's count (src/quota.ts) = 17 in the worst case.
 */
export async function poll(env: Env, now: number = Date.now()): Promise<PollResult> {
  const tally = new CallTally();
  try {
    return await pollOnce(env, now, tally);
  } finally {
    await tally.flush(env.DB);
  }
}

async function pollOnce(env: Env, now: number, tally: CallTally): Promise<PollResult> {
  const db = env.DB;
  const { sync, token } = await readState(db);
  const spotify = spotifyClient(env, 'poll', { grant: token, now, tally });

  let payload: RecentlyPlayedResponse;
  let reachMs: number | null;
  try {
    await spotify.ready();

    try {
      ({ payload, reachMs } = await fetchSince(spotify, sync.cursor_ms));
    } catch (error) {
      if (!(error instanceof SpotifyError) || error.kind !== 'unauthorized') throw error;
      // A 401 on the data call despite a token we believed was live. Force one
      // refresh and retry exactly once; a second 401 aborts the run.
      spotify.refreshToken();
      await spotify.ready();
      ({ payload, reachMs } = await fetchSince(spotify, sync.cursor_ms));
    }
  } catch (error) {
    if (error instanceof SpotifyError && error.paused) {
      // Skipped, not failed: the pause is already the answer, and asking
      // anyway would only extend it. The cursor is untouched, so the first
      // poll after it lifts picks up from here.
      log('poll-skipped', { reason: 'spotify-paused', kind: error.kind, retry_after_seconds: error.retryAfterSeconds }, 'warn');
      return {
        ok: false,
        received: 0,
        inserted: 0,
        skipped: 0,
        cursor_ms: sync.cursor_ms,
        needs_reauth: false,
        error: describe(error),
        retry_after_seconds: error.retryAfterSeconds ?? undefined,
        paused_until_ms: Date.now() + (error.retryAfterSeconds ?? 0) * 1000,
      };
    }
    const message = describe(error);
    await recordFailure(db, message, now);
    return {
      ok: false,
      received: 0,
      inserted: 0,
      skipped: 0,
      cursor_ms: sync.cursor_ms,
      needs_reauth: error instanceof NeedsReauthError,
      error: message,
      ...(error instanceof SpotifyError && error.retryAfterSeconds !== null
        ? { retry_after_seconds: error.retryAfterSeconds }
        : {}),
    };
  }

  const rows = normalize(payload);
  const received = payload.items?.length ?? 0;

  // An empty window is normal, not a failure: the operator simply has not
  // listened to anything since the last poll. Liveness still advances.
  if (rows.plays.length === 0) {
    await db
      .prepare('UPDATE sync_state SET last_success_ms = ?, last_error = NULL, consecutive_failures = 0 WHERE id = 1')
      .bind(now)
      .run();
    return {
      ok: true,
      received,
      inserted: 0,
      skipped: rows.skipped,
      cursor_ms: sync.cursor_ms,
      needs_reauth: false,
      contexts_named: await nameContextsSafely(db, spotify, now),
    };
  }

  const inserts = writeStatements(db, rows, now);
  // As far as the plays fetched are known to be complete.
  const cursorMs = reachMs ?? rows.maxPlayedAtMs;

  try {
    const results = await db.batch([
      // Normalized plays are unique, so the ones not already stored are the
      // ones this batch inserts.
      countStoredPlays(db, rows.plays),
      ...inserts,
      // MAX() so the cursor can never move backwards, whatever clock skew or
      // out-of-order played_at values Spotify hands back.
      db
        .prepare(
          'UPDATE sync_state SET cursor_ms = MAX(cursor_ms, ?), last_success_ms = ?, last_error = NULL, ' +
            'consecutive_failures = 0 WHERE id = 1',
        )
        .bind(cursorMs, now),
    ]);

    const inserted = rows.plays.length - ((results[0]?.results[0] as { n: number } | undefined)?.n ?? 0);

    return {
      ok: true,
      received,
      inserted,
      skipped: rows.skipped,
      cursor_ms: Math.max(sync.cursor_ms, cursorMs),
      needs_reauth: false,
      contexts_named: await nameContextsSafely(db, spotify, now),
    };
  } catch (error) {
    // The batch is a transaction: either every row landed or none did, and the
    // cursor update was inside it, so a failure leaves the cursor where it was.
    const message = describe(error);
    await recordFailure(db, message, now);
    return {
      ok: false,
      received,
      inserted: 0,
      skipped: rows.skipped,
      cursor_ms: sync.cursor_ms,
      needs_reauth: false,
      error: message,
    };
  }
}

