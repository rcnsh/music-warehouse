import { BadRequest, json } from './api';
import { log } from './log';
import type { Env } from './types';

/**
 * GET /api/lyrics?track=<id>: synced lyrics from the Spicy Lyrics API
 * (developers.spicylyrics.org), fetched with this deployment's own secret key
 * so a client needs none. Optional: without SPICY_LYRICS_SECRET_KEY the route
 * answers `404 Not found`, exactly like a route this Worker doesn't have.
 *
 * The upstream body goes back byte for byte, so a client parses it as it
 * would Spicy Lyrics' own answer, attribution included, and the marks Spicy
 * Lyrics puts in each response stay intact (their terms, sections 3 and 5).
 *
 * Kept in the Cache API (per colo, no D1), well inside the terms' 30-day cap
 * on stored responses (section 7): lyrics for LYRICS_TTL_S, "no lyrics" for
 * NOT_FOUND_TTL_S so a new community sync shows up. `Age` says how long ago a
 * kept answer was fetched, so a client that stores it too can keep the total
 * under 30 days.
 *
 * The key never reaches a log or a response. Upstream's own 401 and 403 mean
 * the deployment's key is wrong, not the reader's token, so they become a
 * 502 rather than a 401 that would read as "sign in again".
 */

const UPSTREAM = 'https://api.spicylyrics.org/v1/lyrics/';
const CACHE_ORIGIN = 'https://lyrics.internal';
/** A Spotify track id: 22 base62 characters. Checked before anything is sent. */
const TRACK_ID = /^[0-9A-Za-z]{22}$/;
const LYRICS_TTL_S = 7 * 86_400;
const NOT_FOUND_TTL_S = 86_400;
/** Upstream headers worth passing on: the body's type and the rate-limit state. */
const PASSED_HEADERS = ['Content-Type', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'];
/** When the answer was fetched from upstream (epoch ms), on kept answers only. */
const FETCHED_HEADER = 'X-Lyrics-Fetched-Ms';

/**
 * Until when upstream asked to be left alone (a 429 or 503 with
 * `Retry-After`), in this isolate. Each isolate learns it on its own, which is
 * enough to stop one client's retries reaching Spicy Lyrics during the wait.
 */
let pausedUntilMs = 0;

/** For tests: forget the pause. */
export function forgetLyricsPause(): void {
  pausedUntilMs = 0;
}

export const lyricsCacheKey = (trackId: string) => new Request(`${CACHE_ORIGIN}/v1/${trackId}`);

export class LyricsConfigError extends Error {}

export async function lyricsRoute(env: Env, url: URL): Promise<Response> {
  // Off unless the deployer set a key: the same 404 as a missing route, so a
  // client probing for the feature hides it.
  const key = env.SPICY_LYRICS_SECRET_KEY?.trim();
  if (!key) return json({ error: 'Not found' }, 404);
  // A publishable key is for code shipped to users; on a server Spicy Lyrics
  // asks for the secret one (its Keys page, and terms section 3).
  if (key.startsWith('sl_pk_')) {
    throw new LyricsConfigError('SPICY_LYRICS_SECRET_KEY must be a Spicy Lyrics secret key (sl_sk_…), not a publishable one');
  }

  const track = url.searchParams.get('track');
  if (track === null || track === '') throw new BadRequest('track is required');
  if (!TRACK_ID.test(track)) throw new BadRequest('track must be a Spotify track id (22 letters and digits)');

  const cache = await caches.open('lyrics');
  const cacheKey = lyricsCacheKey(track);
  const hit = await cache.match(cacheKey);
  if (hit) return answer(hit, 'hit');

  const wait = Math.ceil((pausedUntilMs - Date.now()) / 1000);
  if (wait > 0) {
    const response = json({ error: 'Lyrics upstream: rate limited', retry_after_seconds: wait }, 429);
    response.headers.set('Retry-After', String(wait));
    return response;
  }

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM + track, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
  } catch (error) {
    log('lyrics-error', { kind: 'network', message: error instanceof Error ? error.message : String(error) }, 'error');
    return json({ error: 'Lyrics upstream: unavailable' }, 502);
  }

  const status = upstream.status;
  if (status === 200 || status === 404) {
    const body = await upstream.arrayBuffer();
    // The kept copy has no rate-limit headers: they describe this moment only.
    const kept = new Response(body, { status, headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' } });
    kept.headers.set(FETCHED_HEADER, String(Date.now()));
    kept.headers.set('Cache-Control', `max-age=${status === 200 ? LYRICS_TTL_S : NOT_FOUND_TTL_S}`);
    await cache.put(cacheKey, kept.clone());
    const out = answer(kept, 'miss');
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.headers.set(name, value);
    }
    return out;
  }

  const retryAfter = Number(upstream.headers.get('Retry-After'));
  if ((status === 429 || status === 503) && Number.isFinite(retryAfter) && retryAfter > 0) {
    pausedUntilMs = Date.now() + retryAfter * 1000;
  }
  if (status === 429 || status === 503) {
    log('lyrics-error', { kind: 'rate_limited', status, retry_after_seconds: retryAfter || null }, 'warn');
    return new Response(upstream.body, { status, headers: passed(upstream) });
  }

  // Spicy Lyrics' error code (`key_revoked`, `application_paused`, …) is a
  // fixed word from its docs; the message and the key are left out.
  const code = await upstreamErrorCode(upstream);
  log('lyrics-error', { kind: status === 401 || status === 403 ? 'key_rejected' : 'http', status, code }, 'error');
  return json({ error: status === 401 || status === 403 ? 'Lyrics upstream: key rejected' : `Lyrics upstream: ${status}` }, 502);
}

/** A kept or fresh answer for the client: its own headers, the age of the body, no internals. */
function answer(stored: Response, cache: 'hit' | 'miss'): Response {
  const out = new Response(stored.body, { status: stored.status, headers: passed(stored) });
  const fetchedMs = Number(stored.headers.get(FETCHED_HEADER));
  out.headers.set('Age', String(Number.isFinite(fetchedMs) && fetchedMs > 0 ? Math.max(0, Math.floor((Date.now() - fetchedMs) / 1000)) : 0));
  out.headers.set('Cache-Control', 'private, no-store');
  out.headers.set('X-Cache', cache);
  return out;
}

function passed(from: Response): Headers {
  const headers = new Headers();
  for (const name of PASSED_HEADERS) {
    const value = from.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

async function upstreamErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { Body?: { error?: unknown } };
    const code = body?.Body?.error;
    return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}
