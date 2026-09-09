import { json } from './api';
import { readState } from './db';
import { daysUntilTokenExpiry } from './tokens';
import type { Env } from './types';

/**
 * Liveness and token expiry (R6).
 *
 * Note on cost: total_plays is a COUNT(*) over the whole table, so its row
 * reads grow with the warehouse. That is fine at a handful of calls a day
 * against D1's 5M/day free-tier read allowance; do not poll /health in a loop.
 */
export async function health(env: Env, now: number = Date.now()): Promise<Response> {
  const { sync, token } = await readState(env.DB);

  const [totals, recent] = await env.DB.batch<{ n: number }>([
    env.DB.prepare('SELECT COUNT(*) AS n FROM plays'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM plays WHERE played_at_ms >= ?').bind(now - 24 * 60 * 60 * 1000),
  ]);

  const daysUntilExpiry = daysUntilTokenExpiry(token.authorized_at_ms, now);
  const needsReauth = token.needs_reauth === 1;
  const authorized = token.authorized_at_ms > 0;

  return json({
    ok: authorized && !needsReauth,
    authorized,
    needs_reauth: needsReauth,
    // Explicit, human-readable reason for every state that needs a human.
    action_required: !authorized
      ? 'Never authorized. Start at /login — see README "Authorizing".'
      : needsReauth
        ? 'Refresh token is dead or missing. Re-authorize: see README "Re-authorizing".'
        : daysUntilExpiry !== null && daysUntilExpiry <= 14
          ? `Refresh token expires in ${daysUntilExpiry} days. Re-authorize soon.`
          : null,
    last_success_ms: sync.last_success_ms,
    last_success_iso: sync.last_success_ms ? new Date(sync.last_success_ms).toISOString() : null,
    minutes_since_last_success: sync.last_success_ms ? Math.floor((now - sync.last_success_ms) / 60_000) : null,
    total_plays: totals?.results?.[0]?.n ?? 0,
    plays_last_24h: recent?.results?.[0]?.n ?? 0,
    days_until_token_expiry: daysUntilExpiry,
    authorized_at_ms: token.authorized_at_ms || null,
    cursor_ms: sync.cursor_ms,
    cursor_iso: sync.cursor_ms ? new Date(sync.cursor_ms).toISOString() : null,
    last_error: sync.last_error,
    last_error_ms: sync.last_error_ms,
    consecutive_failures: sync.consecutive_failures,
  });
}
