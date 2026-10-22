import { BadRequest, intParam, json } from './api';
import { readState } from './db';
import type { CallSource } from './quota';
import { SpotifyError, type SpotifyCaller, assertSpotifyOpen, spotifyFetch, spotifyGet, truncate } from './spotify';
import { getAccessToken } from './tokens';
import type { Env } from './types';
import { log } from './log';

/**
 * Read-through proxies for what a warehouse cannot answer from stored rows:
 * what is playing right now, what played last (stored plays lag by up to a
 * cron interval), and Spotify's own ranked "top" lists (which carry artist
 * images that `recently-played` never returns).
 *
 * These exist so a website showing live listening holds no Spotify
 * credential of its own. The payloads are passed through unmodified — the
 * website keeps its own schemas and decides what to render, and this Worker
 * stays out of presentation — with one exception: top tracks are relabelled with the edition actually played
 * (see `relabelEditions`).
 *
 * Neither touches sync_state, so nothing here can disturb ingestion.
 */

const TOP_RANGES = new Set(['short_term', 'medium_term', 'long_term']);

async function accessTokenFor(env: Env): Promise<string> {
  const { token } = await readState(env.DB);
  return getAccessToken(env.DB, env, token, Date.now());
}

function callerFor(env: Env, source: CallSource, ctx?: ExecutionContext): SpotifyCaller {
  return { db: env.DB, source, waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined };
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
  key: string,
  fetchBody: () => Promise<unknown>,
  freshMs: (body: unknown) => number,
): Promise<{ body: string; cache: 'hit' | 'miss' | 'stale' }> {
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
    await assertSpotifyOpen(env.DB);
    fetched = await fetchBody();
  } catch (error) {
    const limited = error instanceof SpotifyError && (error.kind === 'rate_limited' || error.kind === 'quota_exceeded');
    if (limited && stored) {
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

function answer(body: string, cache: 'hit' | 'miss' | 'stale'): Response {
  return new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Cache': cache },
  });
}

/** How long a now-playing answer is shared when nothing is playing. */
export const IDLE_FRESH_MS = 60_000;
/** While a track plays: until just after it should end, but within these bounds. */
export const PLAYING_FRESH_MIN_MS = 10_000;
export const PLAYING_FRESH_MAX_MS = 30_000;
/** Past the track's expected end, so the next answer is the next track. */
const TRACK_END_GRACE_MS = 2_000;

/** How long one currently-playing answer is shared (body as Spotify sent it; null when idle). */
export function nowPlayingFreshMs(payload: unknown): number {
  const playing = payload as { is_playing?: boolean; progress_ms?: number | null; item?: { duration_ms?: number } | null } | null;
  if (!playing || playing.is_playing === false) return IDLE_FRESH_MS;
  const duration = playing.item?.duration_ms;
  const progress = playing.progress_ms;
  if (typeof duration !== 'number' || typeof progress !== 'number') return PLAYING_FRESH_MAX_MS;
  const untilEnd = duration - progress + TRACK_END_GRACE_MS;
  return Math.max(PLAYING_FRESH_MIN_MS, Math.min(PLAYING_FRESH_MAX_MS, untilEnd));
}

/**
 * `GET /api/now-playing` → Spotify's currently-playing payload, or null when
 * idle. One answer serves every client (see sharedAnswer): for a minute when
 * idle, and while playing until just after the track should end, at least 10
 * and at most 30 seconds. It is the same for any token, as there is one
 * Spotify account. Failures are not kept.
 */
export async function nowPlaying(env: Env, ctx?: ExecutionContext): Promise<Response> {
  const { body, cache } = await sharedAnswer(
    env,
    ctx,
    'now-playing',
    async () =>
      // 204 (nothing playing) comes back as null rather than an error.
      spotifyGet(callerFor(env, 'now-playing', ctx), await accessTokenFor(env), '/me/player/currently-playing'),
    nowPlayingFreshMs,
  );
  return answer(`{"item":${body}}`, cache);
}

/** How long one recently-played answer is shared. */
export const RECENTLY_PLAYED_FRESH_MS = 60_000;
/** Spotify's ceiling for one page, which is what is fetched and kept. */
const RECENTLY_PLAYED_MAX = 50;

type PlayHistory = {
  items?: Array<{ played_at?: string }> | null;
  limit?: number;
  href?: string | null;
  next?: string | null;
  cursors?: { after?: string | null; before?: string | null } | null;
};

/** Rewrite the `limit` in one of Spotify's paging URLs. */
function withLimit(link: string | null | undefined, limit: number): string | null | undefined {
  if (!link) return link;
  try {
    const url = new URL(link);
    url.searchParams.set('limit', String(limit));
    return url.href;
  } catch {
    return link;
  }
}

/**
 * The first `limit` plays of a 50-play page, as Spotify would have answered
 * for that limit: `limit`, `href` and `next` name it, and `cursors.before`
 * is the oldest play kept, which is where Spotify puts it.
 */
export function slicePlayHistory(payload: unknown, limit: number): unknown {
  const page = payload as PlayHistory | null;
  if (!page || !Array.isArray(page.items)) return payload;
  const items = page.items.slice(0, limit);
  const sliced: PlayHistory = { ...page, items };
  if ('limit' in page) sliced.limit = limit;
  if ('href' in page) sliced.href = withLimit(page.href, limit);
  if ('next' in page) sliced.next = withLimit(page.next, limit);
  const oldest = Date.parse(items.at(-1)?.played_at ?? '');
  if (page.cursors && items.length < page.items.length && Number.isFinite(oldest)) {
    sliced.cursors = { ...page.cursors, before: String(oldest) };
  }
  return sliced;
}

/**
 * `GET /api/recently-played?limit=` → Spotify's recently-played payload, newest first.
 *
 * One page of 50 is fetched and shared for a minute, and each request is
 * given the first `limit` of it. The website asks for 1, the MCP server and
 * Wrapped for more, so one kept page serves them all where a page per limit
 * would cost a call per limit asked for.
 */
export async function recentlyPlayed(env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  // Checked before the token, so a bad parameter is a 400 even with the grant lapsed.
  const limit = intParam(url, 'limit', 1, 1, RECENTLY_PLAYED_MAX);

  const { body, cache } = await sharedAnswer(
    env,
    ctx,
    'recently-played',
    async () =>
      spotifyGet(
        callerFor(env, 'recently-played', ctx),
        await accessTokenFor(env),
        `/me/player/recently-played?limit=${RECENTLY_PLAYED_MAX}`,
      ),
    () => RECENTLY_PLAYED_FRESH_MS,
  );
  return answer(JSON.stringify(slicePlayHistory(JSON.parse(body), limit)), cache);
}

/**
 * `GET /api/top?range=&limit=&type=` → Spotify's top tracks and artists for that
 * range. `type=artists` or `type=tracks` fetches one list and leaves the other
 * null: artists alone skip the edition relabel, the only D1 read here.
 */
export async function topMusic(env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  const range = url.searchParams.get('range') || 'long_term';
  if (!TOP_RANGES.has(range)) throw new BadRequest('range must be short_term, medium_term or long_term');
  const limit = intParam(url, 'limit', 12, 1, 50);
  const type = url.searchParams.get('type') || null;
  if (type !== null && type !== 'tracks' && type !== 'artists') throw new BadRequest('type must be tracks or artists');

  const accessToken = await accessTokenFor(env);
  const caller = callerFor(env, 'top', ctx);
  const [tracks, artists] = await Promise.all([
    type === 'artists' ? null : spotifyGet(caller, accessToken, `/me/top/tracks?time_range=${range}&limit=${limit}`),
    type === 'tracks' ? null : spotifyGet(caller, accessToken, `/me/top/artists?time_range=${range}&limit=${limit}`),
  ]);

  if (tracks) await relabelEditions(env.DB, tracks);
  return json({ range, limit, tracks, artists });
}

type TopTrack = {
  name?: string;
  external_ids?: { isrc?: string | null } | null;
  artists?: Array<{ id?: string | null }>;
  album?: { id?: string; name?: string; images?: unknown } | null;
};

type EditionRow = { i: number; album_id: string; name: string; image_url: string | null; plays: number };

/**
 * Spotify ranks recordings, not releases. A song on both an album and its
 * deluxe edition is one top-list entry, labelled with whichever copy Spotify
 * considers canonical — often not the one listened to, so the cover shown is
 * for a release that was barely played. Relabel each entry with the album its
 * recording was played from most, matched by ISRC or, for tracks stored
 * without one (exports), by name and lead artist.
 *
 * Cosmetic, so a failure here leaves Spotify's labels rather than failing the
 * route.
 */
async function relabelEditions(db: D1Database, payload: unknown): Promise<void> {
  const items = (payload as { items?: TopTrack[] } | null)?.items;
  if (!items?.length) return;

  const wanted = items.map((item) => ({
    isrc: item.external_ids?.isrc ?? null,
    name: item.name ?? null,
    artist: item.artists?.[0]?.id ?? null,
  }));

  let rows: EditionRow[];
  try {
    // One JSON parameter rather than four per track: D1 caps bound parameters at 100.
    ({ results: rows } = await db
      .prepare(
        `WITH wanted AS (
           SELECT CAST(key AS INTEGER) AS i,
                  json_extract(value, '$.isrc') AS isrc,
                  json_extract(value, '$.name') AS name,
                  json_extract(value, '$.artist') AS artist
             FROM json_each(?)
         ),
         -- Two indexed lookups, not one OR join, which scans every track per entry.
         candidates AS (
           SELECT w.i, t.track_id, t.album_id
             FROM wanted w JOIN tracks t ON t.isrc = w.isrc
           UNION
           -- The unary + keeps this branch on the artist index: idx_tracks_isrc would
           -- otherwise serve the IS NULL, walking every ISRC-less track per entry.
           SELECT w.i, t.track_id, t.album_id
             FROM wanted w
             JOIN track_artists ta ON ta.artist_id = w.artist AND ta.position = 0
             JOIN tracks t ON t.track_id = ta.track_id AND t.name = w.name AND +t.isrc IS NULL
         ),
         -- Counted per candidate so each is an index seek, not a scan of every play.
         -- Materialized so the count runs once: inline, SELECT, HAVING and ORDER BY
         -- each re-ran it, reading every play of every candidate three times.
         counted AS MATERIALIZED (
           SELECT c.i, c.album_id, (SELECT COUNT(*) FROM plays p WHERE p.track_id = c.track_id) AS plays
             FROM candidates c
         )
         SELECT c.i, a.album_id, a.name, a.image_url, SUM(c.plays) AS plays
           FROM counted c JOIN albums a ON a.album_id = c.album_id
          GROUP BY c.i, a.album_id
         HAVING SUM(c.plays) > 0
          ORDER BY c.i, plays DESC`,
      )
      .bind(JSON.stringify(wanted))
      .all<EditionRow>());
  } catch (error) {
    log('top-track-relabel-failed', { error }, 'error');
    return;
  }

  const byItem = new Map<number, EditionRow[]>();
  for (const row of rows) {
    const list = byItem.get(row.i) ?? [];
    list.push(row);
    byItem.set(row.i, list);
  }

  items.forEach((item, i) => {
    const editions = byItem.get(i);
    if (!editions || !item.album) return;
    const best = editions[0]!;
    // Ties keep Spotify's own choice.
    const current = editions.find((e) => e.album_id === item.album!.id)?.plays ?? 0;
    if (best.album_id === item.album.id || best.plays <= current) return;
    item.album = { ...item.album, id: best.album_id, name: best.name, images: albumImages(best.image_url) };
  });
}

/**
 * Stored covers are the 640px rendition. Spotify's CDN serves 300px and 64px
 * under a different prefix, so rebuild the set the website expects to choose from.
 */
function albumImages(url: string | null): Array<{ url: string; height: number | null; width: number | null }> {
  if (!url) return [];
  const large = '/image/ab67616d0000b273';
  if (!url.includes(large)) return [{ url, height: null, width: null }];
  return [
    { url, height: 640, width: 640 },
    { url: url.replace(large, '/image/ab67616d00001e02'), height: 300, width: 300 },
    { url: url.replace(large, '/image/ab67616d00004851'), height: 64, width: 64 },
  ];
}

const TRACK_ID = /^[0-9A-Za-z]{22}$/;

/**
 * POST /control/play `{ track_id }`: start that track on whichever device is
 * already playing or last played (Spotify Connect). Nothing plays in the
 * Worker. Spotify answers 404 when no device is active, and 403 without
 * Premium or without the user-modify-playback-state scope, which a grant from
 * before the scope was added lacks until it is re-authorised at /login.
 */
export async function play(env: Env, request: Request, ctx?: ExecutionContext): Promise<Response> {
  let body: { track_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new BadRequest('Body must be JSON.');
  }
  const trackId = typeof body === 'object' && body !== null ? body.track_id : undefined;
  if (typeof trackId !== 'string' || !TRACK_ID.test(trackId)) {
    throw new BadRequest('`track_id` must be a Spotify track id.');
  }

  const path = '/me/player/play';
  const accessToken = await accessTokenFor(env);
  let response: Response;
  try {
    response = await spotifyFetch(callerFor(env, 'play', ctx), `https://api.spotify.com/v1${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [`spotify:track:${trackId}`] }),
    });
  } catch (cause) {
    if (cause instanceof SpotifyError) throw cause;
    throw new SpotifyError('network', `${path} request failed: ${(cause as Error).message}`);
  }

  if (response.ok) return json({ playing: trackId });
  if (response.status === 401) throw new SpotifyError('unauthorized', `${path} returned 401.`, { status: 401 });
  const detail = truncate(await response.text(), 300);
  if (response.status === 404) {
    return json({ error: 'No Spotify device is active. Start playing on one first.', reason: 'no_active_device' }, 409);
  }
  if (response.status === 403) {
    log('play-forbidden', { detail }, 'warn');
    const reason = detail.includes('PREMIUM_REQUIRED') ? 'premium_required' : /scope/i.test(detail) ? 'missing_scope' : 'forbidden';
    return json({ error: `Spotify refused playback (${reason}).`, reason }, 403);
  }
  throw new SpotifyError('http', `${path} returned ${response.status}: ${detail}`, { status: response.status });
}
