import { readState } from './db';
import type { CallSource, CallTally } from './quota';
import { SpotifyError, assertSpotifyOpen, appAccessToken, spotifyFetch, truncate } from './spotify';
import { getAccessToken } from './tokens';
import type { Env, OAuthToken, RecentlyPlayedResponse } from './types';
import { log } from './log';

/**
 * The one way the Worker asks Spotify for something, made once per request
 * for one call source (src/quota.ts counts calls by it).
 *
 * The client finds its own token, maps every failure to a SpotifyError in one
 * place, and keeps the shared answers that let many readers cost one call.
 * Underneath is a transport: the real one sends through spotifyFetch, so the
 * pause after a 429 and the call counts hold for every call; tests swap in a
 * fake with setSpotifyTransport.
 */
export interface SpotifyClient {
  readonly source: CallSource;
  /** GET a path under /v1, parsed as sent; null for 204 ("nothing playing"). */
  get(path: string): Promise<unknown>;
  /** PUT a JSON body to a path under /v1. */
  put(path: string, body: unknown): Promise<void>;
  /** One page of up to 50 plays strictly after `afterMs`; 0 asks for Spotify's newest window. */
  recentlyPlayed(afterMs: number): Promise<RecentlyPlayedResponse>;
  /** A GET whose answer every reader shares until `freshMs` of it has passed (see sharedAnswer). */
  shared(key: string, path: string, freshMs: (body: unknown) => number): Promise<SharedAnswer>;
  /** Drop a shared answer from D1 and this colo, so the next reader asks Spotify. */
  forgetShared(key: string): Promise<void>;
  /** Throw the pause's SpotifyError while Spotify calls are paused. */
  assertOpen(): Promise<void>;
  /** Get the token now, so a dead grant fails before any other work. */
  ready(): Promise<void>;
  /** Refresh the token before the next call, as after a 401 on one believed live. */
  refreshToken(): void;
  /** The same client, token and counts under another call source. */
  as(source: CallSource): SpotifyClient;
}

export interface SharedAnswer {
  body: string;
  cache: 'hit' | 'miss' | 'stale';
}

export interface SpotifyClientOptions {
  /** Lets call counts and shared-answer writes finish after the response. */
  ctx?: ExecutionContext;
  /** Holds call counts for one write, in place of a write per call. */
  tally?: CallTally;
  /** How the client is authorized: the stored grant (default), an app token, or a token in hand. */
  auth?: 'grant' | 'app' | { accessToken: string };
  /** The stored grant when the caller has already read it, saving a D1 read. */
  grant?: OAuthToken;
  /** The time the grant's expiry is judged at; now by default. */
  now?: number;
}

export interface SpotifyCall {
  source: CallSource;
  method: 'GET' | 'PUT';
  /** Under /v1, with any query. */
  path: string;
  body?: unknown;
}

/**
 * What the client sends through. `send` returns any response but a 429; a
 * 429, or a call refused while paused, throws as `rate_limited` or
 * `quota_exceeded`. A transport failure is thrown as it came.
 */
export interface SpotifyTransport {
  send(call: SpotifyCall): Promise<Response>;
  assertOpen(): Promise<void>;
  ready(): Promise<void>;
  refreshToken(): void;
}

/** True for a 429 from Spotify, or a call refused because of an earlier one. */
export function isRateLimit(error: unknown): error is SpotifyError {
  return error instanceof SpotifyError && (error.kind === 'rate_limited' || error.kind === 'quota_exceeded');
}

const API = 'https://api.spotify.com/v1';

/** The transport over spotifyFetch, authorized as `options.auth` says. */
function httpTransport(env: Env, options: SpotifyClientOptions): SpotifyTransport {
  const waitUntil = options.ctx ? (promise: Promise<unknown>) => options.ctx!.waitUntil(promise) : undefined;
  let grant = options.grant;
  let token: Promise<string> | null = null;
  let stale = false;

  const obtain = async (): Promise<string> => {
    const auth = options.auth ?? 'grant';
    if (typeof auth === 'object') return auth.accessToken;
    if (auth === 'app') return (await appAccessToken(env)).access_token;
    grant ??= (await readState(env.DB)).token;
    const stored = stale ? { ...grant, access_token: null, access_expires_ms: null } : grant;
    const accessToken = await getAccessToken(env.DB, env, stored, options.now ?? Date.now());
    stale = false;
    return accessToken;
  };
  const accessToken = () => {
    // Shared by the client's calls; a failure is not kept, so the next call tries again.
    token ??= obtain().catch((error) => {
      token = null;
      throw error;
    });
    return token;
  };

  return {
    async send(call) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}` };
      if (call.body !== undefined) headers['Content-Type'] = 'application/json';
      return spotifyFetch({ db: env.DB, source: call.source, waitUntil, tally: options.tally }, `${API}${call.path}`, {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
      });
    },
    assertOpen: () => assertSpotifyOpen(env.DB),
    ready: async () => {
      await accessToken();
    },
    refreshToken: () => {
      token = null;
      stale = true;
    },
  };
}

let transportOverride: ((env: Env, options: SpotifyClientOptions) => SpotifyTransport) | null = null;

/** Send every client's calls through `make` in place of Spotify; null restores the real transport. For tests. */
export function setSpotifyTransport(make: typeof transportOverride): void {
  transportOverride = make;
}

/** A client for one request's calls from `source`. */
export function spotifyClient(env: Env, source: CallSource, options: SpotifyClientOptions = {}): SpotifyClient {
  return clientOver(env, source, options, (transportOverride ?? httpTransport)(env, options));
}

/** Map a Spotify response that isn't a success to the error callers see. */
async function failure(response: Response, label: string, forbiddenKind: 'forbidden' | 'http'): Promise<SpotifyError> {
  if (response.status === 401) return new SpotifyError('unauthorized', `${label} returned 401.`, { status: 401 });
  const detail = truncate(await response.text(), 300);
  const kind = response.status === 403 ? forbiddenKind : 'http';
  return new SpotifyError(kind, `${label} returned ${response.status}: ${detail}`, { status: response.status, detail });
}

function clientOver(env: Env, source: CallSource, options: SpotifyClientOptions, transport: SpotifyTransport): SpotifyClient {
  /** Send, and turn anything but a success into a SpotifyError named by `label`. */
  const call = async (
    request: Omit<SpotifyCall, 'source'>,
    label: string,
    forbiddenKind: 'forbidden' | 'http' = 'http',
  ): Promise<Response> => {
    // Outside the catch below: a dead grant is not a network failure.
    await transport.ready();
    let response: Response;
    try {
      response = await transport.send({ ...request, source });
    } catch (cause) {
      if (cause instanceof SpotifyError) throw cause;
      throw new SpotifyError('network', `${label} request failed: ${(cause as Error).message}`);
    }
    if (!response.ok) throw await failure(response, label, forbiddenKind);
    return response;
  };

  const client: SpotifyClient = {
    source,
    async get(path) {
      const response = await call({ method: 'GET', path }, path);
      if (response.status === 204) return null;
      const body = await response.text();
      return body.trim() ? JSON.parse(body) : null;
    },
    async put(path, body) {
      await call({ method: 'PUT', path, body }, path);
    },
    async recentlyPlayed(afterMs) {
      const params = new URLSearchParams({ limit: '50' });
      // `after` and `before` are mutually exclusive; this Worker never sends `before`,
      // because `before` cannot reach past the endpoint's hard 50-item ceiling.
      if (afterMs > 0) params.set('after', String(afterMs));
      // A 403 here usually means the account fell off the app's allowlist, or the owner's Premium lapsed.
      const response = await call({ method: 'GET', path: `/me/player/recently-played?${params}` }, 'recently-played', 'forbidden');
      return (await response.json()) as RecentlyPlayedResponse;
    },
    shared: (key, path, freshMs) => sharedAnswer(env, options.ctx, transport, key, () => client.get(path), freshMs),
    forgetShared: (key) => forgetAnswer(env, key),
    assertOpen: () => transport.assertOpen(),
    ready: () => transport.ready(),
    refreshToken: () => transport.refreshToken(),
    as: (other) => clientOver(env, other, options, transport),
  };
  return client;
}

/** The longest a colo keeps a shared answer before asking D1 again. */
const EDGE_TTL_SECONDS = 10;
/** The Cache API request a shared answer is kept under in each colo. */
export const sharedAnswerKey = (key: string) => new Request(`https://spotify-answers.internal/v1/${key}`);
/** The now-playing answer's colo key, which tests clear. */
export const nowPlayingKey = () => sharedAnswerKey('now-playing');

interface StoredAnswer {
  body: string;
  fetched_ms: number;
  fresh_until_ms: number;
}

/**
 * One Spotify answer shared by every client in every colo (migration 0021).
 *
 * The development-mode quota is shared with the owner's other apps, so a
 * client polling every 20 seconds from several devices must not cost a call
 * each. The answer is kept in D1 until its `freshMs` has passed, with each
 * colo keeping its own copy for up to EDGE_TTL_SECONDS in front, and after
 * that the next request asks Spotify again. While Spotify calls are paused
 * after a 429, the last answer is served however old (`X-Cache: stale`);
 * with none kept, the 429 goes through as before. Other failures are never
 * kept, and never answered from a stale copy.
 *
 * Concurrent misses can each ask Spotify; with one owner's few clients that
 * costs at most a call or two, and is not worth a lock.
 */
async function sharedAnswer(
  env: Env,
  ctx: ExecutionContext | undefined,
  transport: SpotifyTransport,
  key: string,
  fetchBody: () => Promise<unknown>,
  freshMs: (body: unknown) => number,
): Promise<SharedAnswer> {
  const edge = await caches.open('spotify-answers');
  const edgeKey = sharedAnswerKey(key);
  const kept = await edge.match(edgeKey);
  if (kept) return { body: await kept.text(), cache: 'hit' };

  const now = Date.now();
  const stored = await env.DB.prepare('SELECT body, fetched_ms, fresh_until_ms FROM spotify_answers WHERE key = ?')
    .bind(key)
    .first<StoredAnswer>();

  const keepAtEdge = (body: string, freshUntilMs: number) => {
    const seconds = Math.min(EDGE_TTL_SECONDS, Math.floor((freshUntilMs - Date.now()) / 1000));
    if (seconds <= 0) return;
    const put = edge.put(
      edgeKey,
      new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${seconds}` } }),
    );
    if (ctx) ctx.waitUntil(put);
    return put;
  };

  if (stored && stored.fresh_until_ms > now) {
    await keepAtEdge(stored.body, stored.fresh_until_ms);
    return { body: stored.body, cache: 'hit' };
  }

  let fetched: unknown;
  try {
    // Checked before the token, so a paused Worker reads no grant and refreshes nothing.
    await transport.assertOpen();
    fetched = await fetchBody();
  } catch (error) {
    if (isRateLimit(error) && stored) {
      log('spotify-answer-stale', { key, fetched_ms: stored.fetched_ms, kind: error.kind }, 'warn');
      return { body: stored.body, cache: 'stale' };
    }
    throw error;
  }

  const body = JSON.stringify(fetched);
  const fetchedMs = Date.now();
  const freshUntilMs = fetchedMs + freshMs(fetched);
  const write = env.DB.prepare(
    `INSERT INTO spotify_answers (key, body, fetched_ms, fresh_until_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_ms = excluded.fetched_ms,
                                    fresh_until_ms = excluded.fresh_until_ms
      WHERE excluded.fetched_ms >= spotify_answers.fetched_ms`,
  )
    .bind(key, body, fetchedMs, freshUntilMs)
    .run()
    .catch((error) => log('spotify-answer-store-failed', { key, error }, 'error'));
  if (ctx) ctx.waitUntil(write);
  else await write;
  await keepAtEdge(body, freshUntilMs);
  return { body, cache: 'miss' };
}

async function forgetAnswer(env: Env, key: string): Promise<void> {
  await Promise.all([
    env.DB.prepare('DELETE FROM spotify_answers WHERE key = ?').bind(key).run(),
    caches.open('spotify-answers').then((edge) => edge.delete(sharedAnswerKey(key))),
  ]);
}
