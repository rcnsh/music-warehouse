import { CONCERT_FAILURES_TO_ALERT, STALL_AFTER_MS } from './alerts';
import { json } from './api';
import { concertCheckStatus } from './concerts';
import { readState } from './db';
import { daysUntilTokenExpiry } from './tokens';
import type { Env } from './types';

/**
 * Liveness and token expiry (R6).
 *
 * `ok` means a human need not do anything: authorized, the grant accepted,
 * and a poll has succeeded within STALL_AFTER_MS, the same line the
 * `ingestion_stalled` alert draws.
 *
 * total_plays sums rollup_days, one row per local day, rather than counting
 * every play. The rollup's triggers add each stored play to exactly one day
 * and take each removed one away, and a rebuild for a new zone repopulates it
 * from the plays in the same transaction that empties it, so the sum is the
 * play count whatever the zone, and even past the offsets' horizon (where a
 * play may land on the wrong day, but still on one). plays_last_24h stays an
 * indexed range over plays, which reads only the last day's rows.
 *
 * `concerts` is how the daily Ticketmaster check has been going. It does not
 * affect `ok`, which is about recording plays; `concerts.failing` is the same
 * line the `concert_check_failing` alert draws.
 */
export async function health(env: Env, now: number = Date.now()): Promise<Response> {
  const [{ sync, token }, concertStatus] = await Promise.all([readState(env.DB), concertCheckStatus(env.DB)]);

  const [totals, recent] = await env.DB.batch<{ n: number | null }>([
    env.DB.prepare('SELECT SUM(plays) AS n FROM rollup_days'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM plays WHERE played_at_ms >= ?').bind(now - 24 * 60 * 60 * 1000),
  ]);

  const daysUntilExpiry = daysUntilTokenExpiry(token.authorized_at_ms, now);
  const needsReauth = token.needs_reauth === 1;
  const authorized = token.authorized_at_ms > 0;
  const minutesSinceSuccess = sync.last_success_ms ? Math.floor((now - sync.last_success_ms) / 60_000) : null;
  const stalled = sync.last_success_ms === null || now - sync.last_success_ms > STALL_AFTER_MS;
  const concerts = concertStatus && {
    ...concertStatus,
    failing: Boolean(env.TICKETMASTER_API_KEY) && concertStatus.consecutive_failures >= CONCERT_FAILURES_TO_ALERT,
  };

  return json({
    ok: authorized && !needsReauth && !stalled,
    authorized,
    needs_reauth: needsReauth,
    stalled,
    // Explicit, human-readable reason for every state that needs a human.
    action_required: !authorized
      ? 'Never authorized. Start at /login — see README "Authorizing".'
      : needsReauth
        ? 'Refresh token is dead or missing. Re-authorize: see README "Re-authorizing".'
        : stalled
          ? (minutesSinceSuccess === null
              ? 'No poll has succeeded yet.'
              : `No successful poll for ${minutesSinceSuccess} minutes.`) +
            ' See last_error, and README "Checking ingestion".'
          : daysUntilExpiry !== null && daysUntilExpiry <= 14
            ? `Refresh token expires in ${daysUntilExpiry} days. Re-authorize soon.`
            : concerts?.failing
              ? `The concert check has failed ${concerts.consecutive_failures} times in a row. See concerts.last_error.`
              : null,
    last_success_ms: sync.last_success_ms,
    last_success_iso: sync.last_success_ms ? new Date(sync.last_success_ms).toISOString() : null,
    minutes_since_last_success: minutesSinceSuccess,
    total_plays: totals?.results?.[0]?.n ?? 0,
    plays_last_24h: recent?.results?.[0]?.n ?? 0,
    days_until_token_expiry: daysUntilExpiry,
    authorized_at_ms: token.authorized_at_ms || null,
    cursor_ms: sync.cursor_ms,
    cursor_iso: sync.cursor_ms ? new Date(sync.cursor_ms).toISOString() : null,
    last_error: sync.last_error,
    last_error_ms: sync.last_error_ms,
    consecutive_failures: sync.consecutive_failures,
    concerts,
  });
}
