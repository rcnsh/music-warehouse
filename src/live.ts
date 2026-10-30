import { BadRequest, intParam, json } from './api';
import { SpotifyError } from './spotify';
import { type SpotifyClient, isRateLimit, spotifyClient } from './spotify-client';
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
 * idle. One answer serves every client (see SpotifyClient.shared): for a minute when
 * idle, and while playing until just after the track should end, at least 10
 * and at most 30 seconds. It is the same for any token, as there is one
 * Spotify account. Failures are not kept.
 */
export async function nowPlaying(env: Env, ctx?: ExecutionContext): Promise<Response> {
  const { body, cache } = await sharedNowPlaying(spotifyClient(env, 'now-playing', { ctx }));
  return answer(`{"item":${body}}`, cache);
}

function sharedNowPlaying(spotify: SpotifyClient) {
  // 204 (nothing playing) comes back as null rather than an error.
  return spotify.shared('now-playing', '/me/player/currently-playing', nowPlayingFreshMs);
}

/** How long Spotify takes to report a track started through the API. */
export const PLAY_SETTLE_MS = 2_000;

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

  const { body, cache } = await spotifyClient(env, 'recently-played', { ctx }).shared(
    'recently-played',
    `/me/player/recently-played?limit=${RECENTLY_PLAYED_MAX}`,
    () => RECENTLY_PLAYED_FRESH_MS,
  );
  return answer(JSON.stringify(slicePlayHistory(JSON.parse(body), limit)), cache);
}

/** How long one top list is shared. Spotify recomputes them about daily. */
export const TOP_FRESH_MS = 3_600_000;
/** Spotify's ceiling for one page, which is what is fetched and kept. */
const TOP_MAX = 50;

type TopPage = { items?: unknown[] | null; limit?: number; offset?: number; href?: string | null; next?: string | null };

/** The first `limit` entries of a 50-entry top page, as Spotify would have answered for that limit. */
export function sliceTopPage(payload: unknown, limit: number): unknown {
  const page = payload as TopPage | null;
  if (!page || !Array.isArray(page.items)) return payload;
  const sliced: TopPage = { ...page, items: page.items.slice(0, limit) };
  if ('limit' in page) sliced.limit = limit;
  if ('href' in page) sliced.href = withLimit(page.href, limit);
  if ('offset' in page) sliced.offset = 0;
  // The next page starts after the entries kept, not after the 50 fetched.
  if ('next' in page) sliced.next = page.next || page.items.length > limit ? pageAt(page.href, limit) : null;
  return sliced;
}

/** One of Spotify's paging URLs moved to start at `offset`, `limit` long. */
function pageAt(link: string | null | undefined, offset: number): string | null {
  const limited = withLimit(link, offset);
  if (!limited) return null;
  try {
    const url = new URL(limited);
    url.searchParams.set('offset', String(offset));
    return url.href;
  } catch {
    return null;
  }
}

/** One top list for a range, fetched as a full page and shared (see SpotifyClient.shared). */
async function sharedTop(spotify: SpotifyClient, list: 'tracks' | 'artists', range: string) {
  const { body, cache } = await spotify.shared(
    `top-${list}:${range}`,
    `/me/top/${list}?time_range=${range}&limit=${TOP_MAX}`,
    () => TOP_FRESH_MS,
  );
  return { page: JSON.parse(body) as unknown, cache };
}

/**
 * `GET /api/top?range=&limit=&type=` → Spotify's top tracks and artists for that
 * range. `type=artists` or `type=tracks` fetches one list and leaves the other
 * null: artists alone skip the edition relabel, the only D1 read here.
 *
 * Each list is fetched as one page of 50 and shared for an hour, and each
 * request is given the first `limit` of it, so polling clients and every
 * limit asked for cost one call per list and range, not one per request.
 */
export async function topMusic(env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  const range = url.searchParams.get('range') || 'long_term';
  if (!TOP_RANGES.has(range)) throw new BadRequest('range must be short_term, medium_term or long_term');
  const limit = intParam(url, 'limit', 12, 1, TOP_MAX);
  const type = url.searchParams.get('type') || null;
  if (type !== null && type !== 'tracks' && type !== 'artists') throw new BadRequest('type must be tracks or artists');

  const spotify = spotifyClient(env, 'top', { ctx });
  const [tracks, artists] = await Promise.all([
    type === 'artists' ? null : sharedTop(spotify, 'tracks', range),
    type === 'tracks' ? null : sharedTop(spotify, 'artists', range),
  ]);
  const trackPage = tracks && sliceTopPage(tracks.page, limit);
  const artistPage = artists && sliceTopPage(artists.page, limit);

  if (trackPage) await relabelEditions(env.DB, trackPage);
  const caches = [tracks?.cache, artists?.cache];
  const cache = caches.includes('miss') ? 'miss' : caches.includes('stale') ? 'stale' : 'hit';
  return answer(JSON.stringify({ range, limit, tracks: trackPage, artists: artistPage }), cache);
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
 * Spotify answers a bare `uris` list with 204 and then plays nothing, at
 * least on the desktop app, so the track is started inside its album. That
 * also lets the album carry on after it, rather than playback stopping.
 */
export function playBody(trackId: string, albumId: string | null): Record<string, unknown> {
  const uri = `spotify:track:${trackId}`;
  return albumId ? { context_uri: `spotify:album:${albumId}`, offset: { uri } } : { uris: [uri] };
}

/** The stored album, else Spotify's; null only if Spotify cannot say either. */
async function albumOf(env: Env, spotify: SpotifyClient, trackId: string): Promise<string | null> {
  const stored = await env.DB.prepare('SELECT album_id FROM tracks WHERE track_id = ?')
    .bind(trackId)
    .first<{ album_id: string | null }>();
  if (stored?.album_id) return stored.album_id;
  try {
    const track = (await spotify.get(`/tracks/${trackId}`)) as { album?: { id?: unknown } } | null;
    return typeof track?.album?.id === 'string' ? track.album.id : null;
  } catch (error) {
    if (isRateLimit(error)) throw error;
    log('play-album-lookup-failed', { error }, 'warn');
    return null;
  }
}

/**
 * POST /control/play `{ track_id }`: start that track, inside its album, on
 * whichever device is already playing or last played (Spotify Connect). Nothing plays in the
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

  const spotify = spotifyClient(env, 'play', { ctx });
  // Before the album lookup, so a dead grant fails here rather than in it.
  await spotify.ready();
  const albumId = await albumOf(env, spotify, trackId);
  try {
    await spotify.put('/me/player/play', playBody(trackId, albumId));
  } catch (error) {
    if (!(error instanceof SpotifyError) || error.kind !== 'http') throw error;
    if (error.status === 404) {
      return json({ error: 'No Spotify device is active. Start playing on one first.', reason: 'no_active_device' }, 409);
    }
    if (error.status === 403) {
      const detail = error.detail ?? '';
      log('play-forbidden', { detail }, 'warn');
      const reason = detail.includes('PREMIUM_REQUIRED') ? 'premium_required' : /scope/i.test(detail) ? 'missing_scope' : 'forbidden';
      return json({ error: `Spotify refused playback (${reason}).`, reason }, 403);
    }
    throw error;
  }

  // The shared now-playing answer still names the old track, for up to 30s.
  // Dropped now, and fetched again once Spotify reports the new one, so a
  // reader polling in between cannot leave its stale answer behind.
  await spotify.forgetShared('now-playing');
  const refresh = new Promise((resolve) => setTimeout(resolve, PLAY_SETTLE_MS))
    .then(() => spotify.forgetShared('now-playing'))
    .then(() => sharedNowPlaying(spotify.as('now-playing')))
    .catch((error) => log('play-now-playing-refresh-failed', { error }, 'warn'));
  if (ctx) ctx.waitUntil(refresh);
  return json({ playing: trackId });
}
