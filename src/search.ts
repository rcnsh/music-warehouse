import { BadRequest, intParam } from './api';
import { likePattern } from './plays';
import { NAME_KEY_PREFIX } from './db';
import { respond, textParam } from './history';
import { trigramPhrase } from './search-index';
import { songTitle } from './song-title';
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
 * Queries of three or more characters find candidates in the trigram index
 * (migration 0011), which holds each track's title, album and artist names,
 * and only then apply the LIKE match to those candidates. The index folds
 * case and accents on both sides, so its matches are a superset of LIKE's and
 * the results are exactly what scanning the name tables gave, for about one
 * row read per candidate track instead of a scan of both tables (6k + 2k
 * rows). An artist whose name contains `q` is credited on some track, so its
 * tracks are candidates. Play counts are index-only seeks on idx_plays_track.
 *
 * Shorter queries can't use the index ("U2" must still be findable): they
 * scan the names and count only the closest matches (see scannedMatches).
 * Their answers are kept for SHORT_TTL_SECONDS, so `plays` there can lag a
 * poll or two.
 */

const MAX_TRACK_MATCHES = 2000;
/** How many of a one- or two-character query's matches are counted (see scannedMatches). */
const MAX_SHORT_ARTIST_NAMES = 100;
const MAX_SHORT_TRACK_MATCHES = 200;
const SHORT_TTL_SECONDS = 300;
const SHORT_CACHE_ORIGIN = 'https://search-short.internal';

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

type Matches = { artists: ArtistRow[]; tracks: TrackRow[]; results: D1Result[] };

/**
 * The matching artists and tracks with their play counts, for a query the
 * trigram index can answer: candidates from the index, counts by index-only
 * seeks on idx_plays_track.
 */
async function indexedMatches(env: Env, phrase: string, name: string, artist: string | null): Promise<Matches> {
  // ?1 and ?2 are the name and artist patterns and the phrase is ?3, so the
  // scope reads the same in both statements.
  const scope = `c AS (SELECT s.track_id FROM track_search f JOIN track_search_text s ON s.id = f.rowid
              WHERE track_search MATCH ?3),
       ca AS (SELECT DISTINCT a.artist_id, a.name FROM c
                JOIN track_artists ta ON ta.track_id = c.track_id
                JOIN artists a ON a.artist_id = ta.artist_id),
       ct AS (SELECT t.track_id, t.name FROM c JOIN tracks t ON t.track_id = c.track_id),`;
  const [artistsResult, tracksResult] = await env.DB.batch([
    env.DB.prepare(
      `WITH ${scope}
       m AS (SELECT artist_id, name FROM ca WHERE name LIKE ?1 ESCAPE '\\')
       SELECT m.artist_id, m.name,
              (SELECT COUNT(*) FROM track_artists ta JOIN plays p ON p.track_id = ta.track_id
                WHERE ta.artist_id = m.artist_id AND ta.position = 0) AS plays
         FROM m`,
    ).bind(name, null, phrase),
    env.DB.prepare(
      `WITH ${scope}
       m AS (SELECT track_id, name FROM ct WHERE name LIKE ?1 ESCAPE '\\' LIMIT ${MAX_TRACK_MATCHES}),
       r AS (SELECT m.track_id, m.name, ${PRIMARY_ARTIST_SQL('m.track_id')} AS artist FROM m)
       SELECT r.track_id, r.name, r.artist, (SELECT COUNT(*) FROM plays p WHERE p.track_id = r.track_id) AS plays
         FROM r WHERE ?2 IS NULL OR r.artist LIKE ?2 ESCAPE '\\'`,
    ).bind(name, artist, phrase),
  ]);
  return {
    artists: artistsResult!.results as ArtistRow[],
    tracks: tracksResult!.results as TrackRow[],
    results: [artistsResult!, tracksResult!],
  };
}

/**
 * How well a name (column `n`) matches, for choosing which of a short
 * query's matches to count: the query itself (?3), then names starting with
 * it (?4), then a word starting with it (?5), then the rest.
 */
const CLOSENESS_SQL = (n: string) =>
  `CASE WHEN ${n} = ?3 COLLATE NOCASE THEN 0 WHEN ${n} LIKE ?4 ESCAPE '\\' THEN 1 WHEN ${n} LIKE ?5 ESCAPE '\\' THEN 2 ELSE 3 END`;

/**
 * The same for a query of one or two characters, which the index cannot
 * answer, so every artist and track name is scanned. Such a query matches
 * most names, and counting every match's plays read every play of every
 * matching artist (about 200k rows for "a"). So only the closest matches are
 * counted: the MAX_SHORT_ARTIST_NAMES artist names and the
 * MAX_SHORT_TRACK_MATCHES titles that match best (exact, then prefix, then a
 * word's prefix, then shortest), counted exactly as before. Ranking by plays
 * then happens among those, so a much-played artist whose name merely
 * contains the letters can rank below a less-played one whose name starts
 * with them.
 */
async function scannedMatches(env: Env, q: string, name: string, artist: string | null): Promise<Matches> {
  const bare = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const [artistsResult, tracksResult] = await env.DB.batch([
    env.DB.prepare(
      `WITH ma AS MATERIALIZED (SELECT artist_id, name, lower(name) AS k FROM artists WHERE name LIKE ?1 ESCAPE '\\'),
            pick AS (SELECT k FROM ma GROUP BY k ORDER BY MIN(${CLOSENESS_SQL('name')}), MIN(length(name)), k
                      LIMIT ${MAX_SHORT_ARTIST_NAMES})
       SELECT ma.artist_id, ma.name,
              (SELECT COUNT(*) FROM track_artists ta JOIN plays p ON p.track_id = ta.track_id
                WHERE ta.artist_id = ma.artist_id AND ta.position = 0) AS plays
         FROM ma WHERE ma.k IN (SELECT k FROM pick)`,
    ).bind(name, null, q, `${bare}%`, `% ${bare}%`),
    env.DB.prepare(
      `WITH m AS (SELECT track_id, name FROM tracks WHERE name LIKE ?1 ESCAPE '\\'
                   ORDER BY ${CLOSENESS_SQL('name')}, length(name), track_id LIMIT ${MAX_SHORT_TRACK_MATCHES}),
            r AS (SELECT m.track_id, m.name, ${PRIMARY_ARTIST_SQL('m.track_id')} AS artist FROM m)
       SELECT r.track_id, r.name, r.artist, (SELECT COUNT(*) FROM plays p WHERE p.track_id = r.track_id) AS plays
         FROM r WHERE ?2 IS NULL OR r.artist LIKE ?2 ESCAPE '\\'`,
    ).bind(name, artist, q, `${bare}%`, `% ${bare}%`),
  ]);
  return {
    artists: artistsResult!.results as ArtistRow[],
    tracks: tracksResult!.results as TrackRow[],
    results: [artistsResult!, tracksResult!],
  };
}

/** GET /api/search?q=&artist=&limit= */
export async function searchRoute(env: Env, url: URL): Promise<Response> {
  const q = textParam(url, 'q');
  if (!q) throw new BadRequest('q is required');
  const artistFilter = textParam(url, 'artist');
  const limit = intParam(url, 'limit', 10, 1, 50);
  const name = likePattern(q);
  const artist = artistFilter === null ? null : likePattern(artistFilter);
  const phrase = trigramPhrase(q);
  if (phrase) return answer(q, limit, await indexedMatches(env, phrase, name, artist));

  // A short query scans every name whatever it is, and a client sends one as
  // the user starts typing, so its answer is kept a few minutes. The key
  // carries the newest search-index row id, as cachedMatchingTrackIds' does,
  // so a new track starts a new key; counts can lag by up to the TTL.
  const latest = await env.DB.prepare('SELECT MAX(id) AS id FROM track_search_text').first<{ id: number | null }>();
  const fold = (text: string | null) => encodeURIComponent((text ?? '').replace(/[A-Z]/g, (c) => c.toLowerCase()));
  const key = new Request(`${SHORT_CACHE_ORIGIN}/v1/${latest?.id ?? 0}/${limit}/${fold(q)}/${fold(artistFilter)}`);
  const cache = await caches.open('search-short');
  const hit = await cache.match(key);
  // The answer folds ASCII case, as LIKE does, but echoes the query as asked.
  if (hit) return respond({ ...((await hit.json()) as object), q }, []);
  const response = answer(q, limit, await scannedMatches(env, q, name, artist));
  const stored = response.clone();
  stored.headers.set('Cache-Control', `max-age=${SHORT_TTL_SECONDS}`);
  await cache.put(key, stored);
  return response;
}

/** Fold and rank the matches into the response. */
function answer(q: string, limit: number, match: Matches): Response {
  // One entry per artist name. The id is the real one where there is one,
  // else null (/api/artist takes the name instead); the shown name is the
  // real artist's spelling, else the most-played placeholder's.
  const artists = new Map<string, { id: string | null; name: string; plays: number; best: number }>();
  for (const row of match.artists) {
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
  for (const row of match.tracks) {
    const key = `${songTitle(row.name.toLowerCase())}|${row.artist?.toLowerCase() ?? ''}`;
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
    match.results,
  );
}
