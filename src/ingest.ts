import { chunkSize, readState, writeStatements } from './db';
import { normalize } from './normalize';
import { SpotifyError, fetchRecentlyPlayed } from './spotify';
import { NeedsReauthError, getAccessToken } from './tokens';
import type { Env, RecentlyPlayedResponse } from './types';

export interface PollResult {
  ok: boolean;
  /** Items returned by Spotify. */
  received: number;
  /** Play rows actually created (duplicates counted as 0). */
  inserted: number;
  /** Items dropped for having no Spotify track id. */
  skipped: number;
  cursor_ms: number;
  needs_reauth: boolean;
  error?: string;
  retry_after_seconds?: number;
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

/**
 * One poll cycle: read state, get a live access token, fetch everything after
 * the cursor, and write it in a single batch.
 *
 * Subrequest budget (R12, ceiling 10): 1 read + at most 4 for token work +
 * at most 2 recently-played fetches + 1 write batch = 8 in the worst case.
 */
export async function poll(env: Env, now: number = Date.now()): Promise<PollResult> {
  const db = env.DB;
  const { sync, token } = await readState(db);

  let payload: RecentlyPlayedResponse;
  try {
    const accessToken = await getAccessToken(db, env, token, now);

    try {
      payload = await fetchRecentlyPlayed(accessToken, sync.cursor_ms);
    } catch (error) {
      if (!(error instanceof SpotifyError) || error.kind !== 'unauthorized') throw error;
      // A 401 on the data call despite a token we believed was live. Force one
      // refresh and retry exactly once; a second 401 aborts the run.
      const refreshed = await getAccessToken(db, env, { ...token, access_token: null, access_expires_ms: null }, now);
      payload = await fetchRecentlyPlayed(refreshed, sync.cursor_ms);
    }
  } catch (error) {
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
    };
  }

  const inserts = writeStatements(db, rows);
  // The play inserts lead the batch; count them so meta.changes can be summed
  // over exactly those statements. `plays` has 5 columns.
  const playStatementCount = Math.ceil(rows.plays.length / chunkSize(5));

  try {
    const results = await db.batch([
      ...inserts,
      // MAX() so the cursor can never move backwards, whatever clock skew or
      // out-of-order played_at values Spotify hands back.
      db
        .prepare(
          'UPDATE sync_state SET cursor_ms = MAX(cursor_ms, ?), last_success_ms = ?, last_error = NULL, ' +
            'consecutive_failures = 0 WHERE id = 1',
        )
        .bind(rows.maxPlayedAtMs, now),
    ]);

    let inserted = 0;
    for (let i = 0; i < playStatementCount; i++) {
      inserted += results[i]?.meta?.changes ?? 0;
    }

    return {
      ok: true,
      received,
      inserted,
      skipped: rows.skipped,
      cursor_ms: Math.max(sync.cursor_ms, rows.maxPlayedAtMs),
      needs_reauth: false,
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

