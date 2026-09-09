import { json } from './api';
import { readState } from './db';
import { spotifyGet } from './spotify';
import { getAccessToken } from './tokens';
import type { Env } from './types';

/**
 * Read-through proxies for the two things a warehouse cannot answer from
 * stored rows: what is playing right now, and Spotify's own ranked "top"
 * lists (which carry artist images that `recently-played` never returns).
 *
 * These exist so rcn.sh holds no Spotify credential of its own. The payloads
 * are passed through unmodified — the website keeps its own schemas and
 * decides what to render, and this Worker stays out of presentation.
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

/** `GET /api/top?range=&limit=` → Spotify's top tracks and artists for that range. */
export async function topMusic(env: Env, url: URL): Promise<Response> {
  const requested = url.searchParams.get('range');
  const range = requested && TOP_RANGES.has(requested) ? requested : 'long_term';

  const requestedLimit = Number(url.searchParams.get('limit') ?? 12);
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 50
    ? requestedLimit
    : 12;

  const accessToken = await accessTokenFor(env);
  const [tracks, artists] = await Promise.all([
    spotifyGet(accessToken, `/me/top/tracks?time_range=${range}&limit=${limit}`),
    spotifyGet(accessToken, `/me/top/artists?time_range=${range}&limit=${limit}`),
  ]);

  return json({ range, limit, tracks, artists });
}
