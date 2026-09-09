import type { Env, RecentlyPlayedResponse } from './types';

export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const RECENTLY_PLAYED_URL = 'https://api.spotify.com/v1/me/player/recently-played';
/**
 * `user-read-recently-played` drives ingestion. The other two exist so the
 * Worker can serve rcn.sh's live widgets, which keeps the website free of any
 * Spotify credential of its own — one token, one six-month clock, one place to
 * re-authorize. Changing this list requires a fresh /login.
 */
export const SCOPE = ['user-read-recently-played', 'user-read-currently-playing', 'user-top-read'].join(' ');

export type SpotifyErrorKind =
  /** HTTP 429. Back off; do not advance the cursor (R7). */
  | 'rate_limited'
  /** HTTP 429 with "reason": "QUOTA_EXCEEDED" — the daily dev-mode quota is spent. */
  | 'quota_exceeded'
  /** Token endpoint returned 400 invalid_grant. Only a human can fix this (R5). */
  | 'invalid_grant'
  /** HTTP 401 on a data call. Refresh and retry once. */
  | 'unauthorized'
  /** HTTP 403 — allowlist or Premium problem. Not retryable. */
  | 'forbidden'
  | 'http'
  | 'network';

export class SpotifyError extends Error {
  readonly kind: SpotifyErrorKind;
  readonly status: number | null;
  /** Seconds from the Retry-After header, when present. */
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: SpotifyErrorKind,
    message: string,
    options: { status?: number | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = 'SpotifyError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
  /** Present on the code exchange; may or may not be present on a refresh. */
  refresh_token?: string;
}

function basicAuth(env: Env): string {
  return btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
}

/** Truncate untrusted upstream text before it goes anywhere near a log or a column. */
export function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function postToken(env: Env, body: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth(env)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (cause) {
    throw new SpotifyError('network', `Token request failed: ${(cause as Error).message}`);
  }

  const text = await response.text();

  if (!response.ok) {
    // Spotify signals a dead refresh token as 400 invalid_grant. This is the
    // six-month expiry landing, and it is the only error that needs a human.
    if (response.status === 400 && text.includes('invalid_grant')) {
      throw new SpotifyError('invalid_grant', `Token endpoint rejected the grant: ${truncate(text)}`, {
        status: 400,
      });
    }
    throw new SpotifyError('http', `Token endpoint returned ${response.status}: ${truncate(text)}`, {
      status: response.status,
    });
  }

  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new SpotifyError('http', `Token endpoint returned unparseable JSON: ${truncate(text)}`, {
      status: response.status,
    });
  }
  if (!parsed.access_token) {
    throw new SpotifyError('http', 'Token endpoint returned no access_token.', { status: response.status });
  }
  return parsed;
}

export function exchangeCode(env: Env, code: string): Promise<TokenResponse> {
  return postToken(
    env,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.SPOTIFY_REDIRECT_URI,
    }),
  );
}

export function refreshAccessToken(env: Env, refreshToken: string): Promise<TokenResponse> {
  return postToken(
    env,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
}

export function authorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    scope: SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/**
 * A plain authenticated GET against the Spotify API, returning the parsed body
 * verbatim. Used by the read-through proxy routes; deliberately does no
 * normalization, so the caller keeps its own view of the response shape.
 *
 * Returns null for 204 (Spotify's "nothing is playing").
 */
export async function spotifyGet(accessToken: string, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (cause) {
    throw new SpotifyError('network', `${path} request failed: ${(cause as Error).message}`);
  }

  if (response.status === 204) return null;
  if (response.status === 401) throw new SpotifyError('unauthorized', `${path} returned 401.`, { status: 401 });
  if (response.status === 429) {
    // Same Retry-After handling as fetchRecentlyPlayed: a long-running backfill
    // needs to know how long to wait, not just that it was refused.
    const header = response.headers.get('Retry-After');
    const retryAfterSeconds =
      header !== null && header.trim() !== '' && Number.isFinite(Number(header)) ? Number(header) : null;
    const body = truncate(await response.text(), 300);
    const quotaExceeded = body.includes('QUOTA_EXCEEDED');
    throw new SpotifyError(
      quotaExceeded ? 'quota_exceeded' : 'rate_limited',
      `${path} was rate limited (Retry-After: ${retryAfterSeconds ?? 'absent'}): ${body}`,
      { status: 429, retryAfterSeconds },
    );
  }
  if (!response.ok) {
    throw new SpotifyError('http', `${path} returned ${response.status}: ${truncate(await response.text(), 300)}`, {
      status: response.status,
    });
  }

  const body = await response.text();
  return body.trim() ? JSON.parse(body) : null;
}

/**
 * Fetch plays strictly after `afterMs`.
 *
 * `afterMs` of 0 means "first ever run" — the `after` parameter is omitted
 * entirely rather than sent as 0, and Spotify returns its most recent window.
 */
export async function fetchRecentlyPlayed(
  accessToken: string,
  afterMs: number,
): Promise<RecentlyPlayedResponse> {
  const url = new URL(RECENTLY_PLAYED_URL);
  url.searchParams.set('limit', '50');
  // `after` and `before` are mutually exclusive; this Worker never sends `before`,
  // because `before` cannot reach past the endpoint's hard 50-item ceiling.
  if (afterMs > 0) url.searchParams.set('after', String(afterMs));

  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (cause) {
    throw new SpotifyError('network', `recently-played request failed: ${(cause as Error).message}`);
  }

  if (response.status === 429) {
    const header = response.headers.get('Retry-After');
    const retryAfterSeconds = header !== null && header.trim() !== '' && Number.isFinite(Number(header))
      ? Number(header)
      : null;
    const body = truncate(await response.text(), 300);
    const quotaExceeded = body.includes('QUOTA_EXCEEDED');
    throw new SpotifyError(
      quotaExceeded ? 'quota_exceeded' : 'rate_limited',
      `${quotaExceeded ? 'Development-mode quota exceeded' : 'Rate limited'} (Retry-After: ${
        retryAfterSeconds ?? 'absent'
      }): ${body}`,
      { status: 429, retryAfterSeconds },
    );
  }

  if (response.status === 401) {
    throw new SpotifyError('unauthorized', 'recently-played returned 401.', { status: 401 });
  }

  if (response.status === 403) {
    // Usually the account fell off the app's allowlist, or the owner's Premium lapsed.
    throw new SpotifyError('forbidden', `recently-played returned 403: ${truncate(await response.text(), 300)}`, {
      status: 403,
    });
  }

  if (!response.ok) {
    throw new SpotifyError('http', `recently-played returned ${response.status}: ${truncate(await response.text(), 300)}`, {
      status: response.status,
    });
  }

  return (await response.json()) as RecentlyPlayedResponse;
}
