import { SpotifyError, refreshAccessToken, type TokenResponse } from './spotify';
import type { Env, OAuthToken } from './types';

/** Refresh this long before the access token actually expires. */
export const REFRESH_MARGIN_MS = 60_000;

/** Spotify expires a refresh token six months after the original authorization. */
export const REFRESH_TOKEN_LIFETIME_MS = 183 * 24 * 60 * 60 * 1000;

export class NeedsReauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsReauthError';
  }
}

/**
 * Persist a token response.
 *
 * Spotify may or may not return a new refresh token on a refresh; when it does
 * not, the existing one stays valid. So the refresh token is overwritten only
 * when one is actually present — never blindly, and never with undefined.
 */
export async function persistTokenResponse(
  db: D1Database,
  token: TokenResponse,
  now: number,
  options: { resetAuthorizedAt?: boolean } = {},
): Promise<void> {
  const expiresMs = now + token.expires_in * 1000;

  if (options.resetAuthorizedAt) {
    // Fresh authorization: the six-month clock restarts here, and a refresh
    // token is always present on a code exchange.
    await db
      .prepare(
        'UPDATE oauth_token SET access_token = ?, access_expires_ms = ?, refresh_token = COALESCE(?, refresh_token), ' +
          'authorized_at_ms = ?, needs_reauth = 0 WHERE id = 1',
      )
      .bind(token.access_token, expiresMs, token.refresh_token ?? null, now)
      .run();
    return;
  }

  // Plain refresh: authorized_at_ms must NOT move — refreshing does not extend
  // the six-month clock, and /health's countdown depends on that.
  await db
    .prepare(
      'UPDATE oauth_token SET access_token = ?, access_expires_ms = ?, refresh_token = COALESCE(?, refresh_token), ' +
        'needs_reauth = 0 WHERE id = 1',
    )
    .bind(token.access_token, expiresMs, token.refresh_token ?? null)
    .run();
}

export async function markNeedsReauth(db: D1Database): Promise<void> {
  await db
    .prepare('UPDATE oauth_token SET needs_reauth = 1, access_token = NULL, access_expires_ms = NULL WHERE id = 1')
    .run();
}

/**
 * Return a usable access token, refreshing first if the stored one is missing
 * or within REFRESH_MARGIN_MS of expiry (R4).
 *
 * Throws NeedsReauthError when the connection is dead — the caller must stop
 * polling rather than retry, because only a human visiting /login can fix it.
 */
export async function getAccessToken(
  db: D1Database,
  env: Env,
  stored: OAuthToken,
  now: number,
): Promise<string> {
  if (stored.needs_reauth) {
    throw new NeedsReauthError('Connection is marked needs_reauth; visit /login to re-authorize.');
  }

  if (stored.access_token && stored.access_expires_ms && stored.access_expires_ms > now + REFRESH_MARGIN_MS) {
    return stored.access_token;
  }

  if (!stored.refresh_token) {
    await markNeedsReauth(db);
    throw new NeedsReauthError('No refresh token stored; visit /login to authorize.');
  }

  try {
    const refreshed = await refreshAccessToken(env, stored.refresh_token);
    await persistTokenResponse(db, refreshed, now);
    return refreshed.access_token;
  } catch (error) {
    if (error instanceof SpotifyError && error.kind === 'invalid_grant') {
      await markNeedsReauth(db);
      throw new NeedsReauthError(
        'Refresh token rejected (invalid_grant) — it has most likely hit its six-month expiry. Visit /login.',
      );
    }
    throw error;
  }
}

/** Days left on the six-month refresh-token clock; null when never authorized. */
export function daysUntilTokenExpiry(authorizedAtMs: number, now: number): number | null {
  if (!authorizedAtMs) return null;
  const remainingMs = authorizedAtMs + REFRESH_TOKEN_LIFETIME_MS - now;
  return Math.floor(remainingMs / (24 * 60 * 60 * 1000));
}
