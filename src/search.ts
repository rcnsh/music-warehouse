import { BadRequest, intParam, likePattern } from './api';
import { NAME_KEY_PREFIX } from './db';
import { respond, textParam } from './history';
import { PRIMARY_ARTIST_SQL } from './stats/sql';
import type { Env } from './types';

/**
 * Find stored artists and songs by name, so a client holding only a name can
 * reach /api/artist and /api/track. Matches are case-insensitive substrings
 * (ASCII only, as SQLite's LIKE and NOCASE are).
 *
 * Results fold the way the history routes do: an artist's `name:`
 * placeholders from the export join the real id, and a song's editions (same
 * title, same primary artist) count as one. `plays` credits the primary
 * artist only, as /api/artist does, so the two agree.
 *
 * Both tables are a few thousand rows, so the name scan is cheap; play counts
 * are index-only seeks on idx_plays_track.
 */

const MAX_TRACK_MATCHES = 2000;

interface ArtistRow {
  artist_id: string;
  name: string;
  plays: number;
}

interface TrackRow {
  track_id: string;
  name: string;
  artist: string | null;
  plays: number;
}

/** Exact (case-insensitive) name matches first, then most played, then by name. */
function rank<T extends { name: string; plays: number }>(items: T[], q: string): T[] {
  const exact = (item: T) => (item.name.toLowerCase() === q.toLowerCase() ? 0 : 1);
  return items.sort((a, b) => exact(a) - exact(b) || b.plays - a.plays || a.name.localeCompare(b.name));
}

/** GET /api/search?q=&artist=&limit= */
export async function searchRoute(env: Env, url: URL): Promise<Response> {
  const q = textParam(url, 'q');
  if (!q) throw new BadRequest('q is required');
  const artistFilter = textParam(url, 'artist');
  const limit = intParam(url, 'limit', 10, 1, 50);

  const [artistsResult, tracksResult] = await env.DB.batch([
    env.DB.prepare(
      `WITH m AS (SELECT artist_id, name FROM artists WHERE name LIKE ?1 ESCAPE '\\')
       SELECT m.artist_id, m.name,
              (SELECT COUNT(*) FROM track_artists ta JOIN plays p ON p.track_id = ta.track_id
                WHERE ta.artist_id = m.artist_id AND ta.position = 0) AS plays
         FROM m`,
    ).bind(likePattern(q)),
    env.DB.prepare(
      `WITH m AS (SELECT track_id, name FROM tracks WHERE name LIKE ?1 ESCAPE '\\' LIMIT ${MAX_TRACK_MATCHES}),
       r AS (SELECT m.track_id, m.name, ${PRIMARY_ARTIST_SQL('m.track_id')} AS artist FROM m)
       SELECT r.track_id, r.name, r.artist, (SELECT COUNT(*) FROM plays p WHERE p.track_id = r.track_id) AS plays
         FROM r WHERE ?2 IS NULL OR r.artist LIKE ?2 ESCAPE '\\'`,
    ).bind(likePattern(q), artistFilter === null ? null : likePattern(artistFilter)),
  ]);

  // One entry per artist name. The id is the real one where there is one,
  // else null (/api/artist takes the name instead); the shown name is the
  // real artist's spelling, else the most-played placeholder's.
  const artists = new Map<string, { id: string | null; name: string; plays: number; best: number }>();
  for (const row of artistsResult!.results as ArtistRow[]) {
    const key = row.name.toLowerCase();
    const entry = artists.get(key) ?? { id: null, name: row.name, plays: 0, best: -1 };
    entry.plays += row.plays;
    if (!row.artist_id.startsWith(NAME_KEY_PREFIX)) {
      entry.id = row.artist_id;
      entry.name = row.name;
    } else if (entry.id === null && row.plays > entry.best) {
      entry.name = row.name;
      entry.best = row.plays;
    }
    artists.set(key, entry);
  }

  // One entry per song; the id is the most-played edition's.
  const tracks = new Map<string, { id: string; name: string; artist: string | null; plays: number; best: number }>();
  for (const row of tracksResult!.results as TrackRow[]) {
    const key = `${row.name.toLowerCase()}|${row.artist?.toLowerCase() ?? ''}`;
    const entry = tracks.get(key);
    if (!entry) {
      tracks.set(key, { id: row.track_id, name: row.name, artist: row.artist, plays: row.plays, best: row.plays });
      continue;
    }
    entry.plays += row.plays;
    if (row.plays > entry.best) Object.assign(entry, { id: row.track_id, name: row.name, artist: row.artist, best: row.plays });
  }

  return respond(
    {
      q,
      artists: rank([...artists.values()], q)
        .slice(0, limit)
        .map(({ id, name, plays }) => ({ id, name, plays })),
      tracks: rank([...tracks.values()], q)
        .slice(0, limit)
        .map(({ id, name, artist, plays }) => ({ id, name, artist, plays })),
    },
    [artistsResult!, tracksResult!],
  );
}
