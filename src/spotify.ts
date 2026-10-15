import {
  type CallOutcome,
  type CallSource,
  type CallTally,
  type SpotifyPause,
  countCall,
  pauseSeconds,
  readPause,
  recordPause,
} from './quota';
import type { Env, RecentlyPlayedResponse } from './types';
import { log } from './log';

export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const RECENTLY_PLAYED_URL = 'https://api.spotify.com/v1/me/player/recently-played';
/**
 * `user-read-recently-played` drives ingestion. The next two exist so the
 * Worker can serve a website's live widgets, which keeps the website free of any
 * Spotify credential of its own — one token, one six-month clock, one place to
 * re-authorize. Changing this list requires a fresh /login.
 *
 * `user-library-read` is not used by ingestion at all: it exists solely so the
 * album backfill can read Saved Tracks and Saved Albums. Those are the only
 * endpoints that hand back cover art for tracks that predate the Worker — the
 * catalog endpoints that would otherwise do it (/v1/tracks, /v1/albums) return
 * 403 to apps in development mode. See src/albums.ts.
 */
export const SCOPE = [
  'user-read-recently-played',
  'user-read-currently-playing',
  'user-top-read',
  'user-library-read',
].join(' ');

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
  /** True when the request was never sent, because calls are paused after an earlier 429. */
  readonly paused: boolean;

  constructor(
    kind: SpotifyErrorKind,
    message: string,
    options: { status?: number | null; retryAfterSeconds?: number | null; paused?: boolean } = {},
  ) {
    super(message);
    this.name = 'SpotifyError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.paused = options.paused ?? false;
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

/** `redirectUri` must be the one the authorize request named, character for character. */
export function exchangeCode(env: Env, code: string, redirectUri = env.SPOTIFY_REDIRECT_URI): Promise<TokenResponse> {
  return postToken(
    env,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  );
}

export function refreshAccessToken(env: Env, refreshToken: string): Promise<TokenResponse> {
  return postToken(
    env,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
}

/**
 * An app-only token, via the client credentials grant.
 *
 * Get Track (`/v1/tracks/{id}`) is reachable in development mode where the
 * batch forms (`/v1/tracks?ids=`, `/v1/albums?ids=`) return 403, and it needs
 * no user context at all. Minting an app token for it keeps the catalog
 * backfill off the user grant entirely: no extra scope, and a failure there
 * cannot disturb ingestion.
 */
export function appAccessToken(env: Env): Promise<TokenResponse> {
  return postToken(env, new URLSearchParams({ grant_type: 'client_credentials' }));
}

/**
 * Spotify's consent URL. Defaults to the ingestion grant; sign-in passes its
 * own redirect URI and an empty scope, which asks for identity alone.
 *
 * `showDialog` makes Spotify ask every time, even when the account already
 * approved this app. Without it an approved session redirects straight back,
 * so whoever opened the URL gets the result without the owner seeing a thing.
 */
export function authorizeUrl(
  env: Env,
  state: string,
  options: { redirectUri?: string; scope?: string; showDialog?: boolean } = {},
): string {
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: options.redirectUri ?? env.SPOTIFY_REDIRECT_URI,
    state,
  });
  const scope = options.scope ?? SCOPE;
  if (scope) params.set('scope', scope);
  if (options.showDialog) params.set('show_dialog', 'true');
  return `${AUTHORIZE_URL}?${params}`;
}

/** Who is calling Spotify, for the pause and the call counts (src/quota.ts). */
export interface SpotifyCaller {
  db: D1Database;
  source: CallSource;
  /** Lets the call's count be written after the response; without it the count is awaited. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Holds the count for the caller to write with others, in place of a write per call. */
  tally?: CallTally;
}

function pausedError(pause: SpotifyPause, now: number): SpotifyError {
  return new SpotifyError(
    pause.kind,
    `Spotify calls are paused after a 429 (${pause.kind}) until ${new Date(pause.until_ms).toISOString()}; not sent.`,
    { status: 429, retryAfterSeconds: Math.max(1, Math.ceil((pause.until_ms - now) / 1000)), paused: true },
  );
}

/**
 * Throw the pause's own SpotifyError while Spotify calls are paused: the same
 * kind, and a Retry-After of the time left, so a blocked call maps to the 429
 * a sent one would have. spotifyFetch runs this before every request, and
 * getAccessToken before a refresh, so a paused Worker doesn't refresh a
 * token it cannot use.
 */
export async function assertSpotifyOpen(db: D1Database, now: number = Date.now()): Promise<void> {
  const pause = await readPause(db, now);
  if (pause) throw pausedError(pause, now);
}

function retryAfterOf(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  return header !== null && header.trim() !== '' && Number.isFinite(Number(header)) ? Number(header) : null;
}

/**
 * The one way a request reaches api.spotify.com. Refused without sending
 * while calls are paused; counted once sent; and a 429 pauses every caller
 * until its Retry-After has passed, then throws as `rate_limited` or, for the
 * development-mode quota, `quota_exceeded`. Any other response is returned
 * for the caller to read. A transport failure is rethrown as it came.
 */
export async function spotifyFetch(caller: SpotifyCaller, url: string | URL, init: RequestInit): Promise<Response> {
  await assertSpotifyOpen(caller.db);

  const count = async (outcome: CallOutcome) => {
    if (caller.tally) return caller.tally.add(caller.source, outcome);
    const counted = countCall(caller.db, caller.source, outcome).then(
      () => undefined,
      (error) => log('spotify-count-failed', { source: caller.source, outcome, error }, 'error'),
    );
    if (caller.waitUntil) caller.waitUntil(counted);
    else await counted;
  };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    // It may or may not have reached Spotify, so it may have cost a call.
    await count('other');
    throw error;
  }

  if (response.status !== 429) {
    await count(response.ok ? '2xx' : 'other');
    return response;
  }

  await count('429');
  const path = new URL(url).pathname.replace(/^\/v1/, '');
  // Retry-After is the only thing that says how long the wait actually is:
  // a long-running backfill needs it, and so does everything sharing the quota.
  const retryAfterSeconds = retryAfterOf(response);
  const body = truncate(await response.text(), 300);
  const kind = body.includes('QUOTA_EXCEEDED') ? 'quota_exceeded' : 'rate_limited';
  const pause = await recordPause(caller.db, kind, pauseSeconds(kind, retryAfterSeconds));
  log(
    'spotify-paused',
    { source: caller.source, kind, retry_after_seconds: retryAfterSeconds, until_ms: pause.until_ms },
    'warn',
  );
  throw new SpotifyError(
    kind,
    `${kind === 'quota_exceeded' ? 'Development-mode quota exceeded' : 'Rate limited'} on ${path} (Retry-After: ${
      retryAfterSeconds ?? 'absent'
    }): ${body}`,
    { status: 429, retryAfterSeconds },
  );
}

/**
 * A plain authenticated GET against the Spotify API, returning the parsed body
 * verbatim. Used by the read-through proxy routes; deliberately does no
 * normalization, so the caller keeps its own view of the response shape.
 *
 * Returns null for 204 (Spotify's "nothing is playing").
 */
export async function spotifyGet(caller: SpotifyCaller, accessToken: string, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await spotifyFetch(caller, `https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (cause) {
    if (cause instanceof SpotifyError) throw cause;
    throw new SpotifyError('network', `${path} request failed: ${(cause as Error).message}`);
  }

  if (response.status === 204) return null;
  if (response.status === 401) throw new SpotifyError('unauthorized', `${path} returned 401.`, { status: 401 });
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
  caller: SpotifyCaller,
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
    response = await spotifyFetch(caller, url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (cause) {
    if (cause instanceof SpotifyError) throw cause;
    throw new SpotifyError('network', `recently-played request failed: ${(cause as Error).message}`);
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
