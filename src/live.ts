import { BadRequest, intParam, json } from './api';
import { readState } from './db';
import { spotifyGet } from './spotify';
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

/** `GET /api/now-playing` → Spotify's currently-playing payload, or null when idle. */
export async function nowPlaying(env: Env): Promise<Response> {
  const accessToken = await accessTokenFor(env);
  // 204 (nothing playing) comes back as null rather than an error.
  return json({ item: await spotifyGet(accessToken, '/me/player/currently-playing') });
}

/** `GET /api/recently-played?limit=` → Spotify's recently-played payload, newest first. */
export async function recentlyPlayed(env: Env, url: URL): Promise<Response> {
  // Checked before the token, so a bad parameter is a 400 even with the grant lapsed.
  const limit = intParam(url, 'limit', 1, 1, 50);

  const accessToken = await accessTokenFor(env);
  return json(await spotifyGet(accessToken, `/me/player/recently-played?limit=${limit}`));
}

/**
 * `GET /api/top?range=&limit=&type=` → Spotify's top tracks and artists for that
 * range. `type=artists` or `type=tracks` fetches one list and leaves the other
 * null: artists alone skip the edition relabel, the only D1 read here.
 */
export async function topMusic(env: Env, url: URL): Promise<Response> {
  const range = url.searchParams.get('range') || 'long_term';
  if (!TOP_RANGES.has(range)) throw new BadRequest('range must be short_term, medium_term or long_term');
  const limit = intParam(url, 'limit', 12, 1, 50);
  const type = url.searchParams.get('type') || null;
  if (type !== null && type !== 'tracks' && type !== 'artists') throw new BadRequest('type must be tracks or artists');

  const accessToken = await accessTokenFor(env);
  const [tracks, artists] = await Promise.all([
    type === 'artists' ? null : spotifyGet(accessToken, `/me/top/tracks?time_range=${range}&limit=${limit}`),
    type === 'tracks' ? null : spotifyGet(accessToken, `/me/top/artists?time_range=${range}&limit=${limit}`),
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
