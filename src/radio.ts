import { BadRequest, intParam } from './api';
import { ARTIST_TRACKS_CTE, SONG_TRACKS_CTE, respond, textParam } from './history';
import { SONG_SQL } from './songs';
import { PRIMARY_ARTIST_PAIR_SQL, PRIMARY_ARTIST_SQL } from './stats/sql';
import type { Env } from './types';
import { MIN_PLAY_MS } from './wrapped';

/**
 * GET /api/radio?track= or ?artist=: songs to queue after a seed, from what
 * the user plays near it.
 *
 * Spotify's Web API no longer gives apps recommendations or related artists,
 * so this stands in from the history: the songs played within WINDOW_MS of
 * the seed's plays (the seed song, every edition folded, or any song whose
 * primary artist is the seed artist, as /api/track and /api/artist match).
 *
 * Seed plays whose windows overlap are one session. A song scores, per
 * session, its best closeness to a seed play (halving every CLOSENESS_MS
 * apart), weighted by how recent that play was (halving every HALF_LIFE_MS),
 * so it counts once per session however often it repeats there. Skips (under
 * 30 s before the next play, as on-repeat measures them) count for nothing.
 * The sum is divided by the song's whole play count to the power
 * POPULARITY_DAMPING, so an all-time favourite that turns up near everything
 * doesn't top every radio.
 *
 * The seed song is left out; an artist seed's own songs are not, so its radio
 * opens with them. At most MAX_PER_ARTIST songs per primary artist (by name,
 * folding the export's placeholders), for variety.
 *
 * Cost: the seed's plays (one index seek each; the newest in each of the
 * latest MAX_SEED_HOURS hours are used), every play inside their windows (about two rows each, with the
 * song key), then one lookup per candidate song for its names and its play
 * count (the latest play number). An unknown or unplayed seed is a 200 with
 * no tracks.
 */

const MIN = 60_000;
const DAY = 86_400_000;
/** A play this close before or after a seed play counts as played near it. */
export const WINDOW_MS = 45 * MIN;
const CLOSENESS_MS = 10 * MIN;
const HALF_LIFE_MS = 365 * DAY;
const HOUR = 60 * MIN;
/**
 * The seed's newest play in each UTC hour stands for that hour, and only the
 * newest MAX_SEED_HOURS are used: an artist's album played through, or one
 * song on repeat, is then a few seeds rather than dozens, and its 300 newest
 * plays don't all come from its last few sessions.
 */
const MAX_SEED_HOURS = 300;
export const MAX_PER_ARTIST = 3;
/** Songs looked up for names and play counts before the artist cap and the cut. */
const CANDIDATES = 200;
const POPULARITY_DAMPING = 0.3;
/** Added to a song's plays before damping, so a song played once isn't lifted above one played near the seed often. */
const PLAYS_PRIOR = 5;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export interface RadioPlay {
  ms: number;
  track_id: string;
  song: string;
}

export interface CoPlayed {
  song: string;
  /** The edition played most near the seed: the id a client queues. */
  track_id: string;
  score: number;
  /** Seed sessions it was played in. */
  sessions: number;
}

/** Each seed play's window, overlapping ones merged, oldest first. */
export function seedWindows(seedMs: number[]): Array<[number, number]> {
  const windows: Array<[number, number]> = [];
  for (const ms of [...seedMs].sort((a, b) => a - b)) {
    const last = windows.at(-1);
    if (last && ms - WINDOW_MS <= last[1]) last[1] = ms + WINDOW_MS;
    else windows.push([ms - WINDOW_MS, ms + WINDOW_MS]);
  }
  return windows;
}

/** Index of the last value at or below `x` in ascending `values`, or -1. */
function floorIndex(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= x) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Songs played near the seed, best first, from the plays inside the seed's
 * windows (oldest first). `exclude` holds song keys left out: the seed song's.
 */
export function coPlayed(plays: RadioPlay[], seedMs: number[], exclude: Set<string>, now: number): CoPlayed[] {
  const seeds = [...seedMs].sort((a, b) => a - b);
  const windows = seedWindows(seeds);
  // Per song: per session its best weight, and how often each edition turned up.
  const songs = new Map<string, { best: Map<number, number>; editions: Map<string, number> }>();
  let w = 0;
  for (let i = 0; i < plays.length; i++) {
    const play = plays[i]!;
    const next = plays[i + 1];
    if (exclude.has(play.song)) continue;
    if (next && next.ms - play.ms < MIN_PLAY_MS) continue;
    while (w < windows.length && windows[w]![1] < play.ms) w++;
    if (w >= windows.length || play.ms < windows[w]![0]) continue;
    const at = floorIndex(seeds, play.ms);
    const nearest = Math.min(
      at >= 0 ? play.ms - seeds[at]! : Infinity,
      at + 1 < seeds.length ? seeds[at + 1]! - play.ms : Infinity,
    );
    const weight = 2 ** (-nearest / CLOSENESS_MS) * 2 ** (-Math.max(0, now - play.ms) / HALF_LIFE_MS);
    let song = songs.get(play.song);
    if (!song) {
      song = { best: new Map(), editions: new Map() };
      songs.set(play.song, song);
    }
    song.best.set(w, Math.max(song.best.get(w) ?? 0, weight));
    song.editions.set(play.track_id, (song.editions.get(play.track_id) ?? 0) + 1);
  }
  return [...songs]
    .map(([key, s]) => ({
      song: key,
      track_id: [...s.editions].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
      score: [...s.best.values()].reduce((sum, x) => sum + x, 0),
      sessions: s.best.size,
    }))
    .sort((a, b) => b.score - a.score || a.song.localeCompare(b.song));
}

export interface RadioCandidate extends CoPlayed {
  /** Lowercased primary artist name, for the cap; null for an uncredited track. */
  artistKey: string | null;
  /** The song's plays in the whole history. */
  plays: number | null;
}

/** Damped by each song's overall plays, at most MAX_PER_ARTIST per artist, `limit` long. */
export function pickRadio(candidates: RadioCandidate[], limit: number): RadioCandidate[] {
  const damped = candidates
    .map((c) => ({ ...c, score: c.score / ((c.plays ?? c.sessions) + PLAYS_PRIOR) ** POPULARITY_DAMPING }))
    .sort((a, b) => b.score - a.score || a.song.localeCompare(b.song));
  const perArtist = new Map<string, number>();
  const out: RadioCandidate[] = [];
  for (const c of damped) {
    if (c.artistKey !== null) {
      const n = perArtist.get(c.artistKey) ?? 0;
      if (n >= MAX_PER_ARTIST) continue;
      perArtist.set(c.artistKey, n + 1);
    }
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

interface MetaRow {
  track_id: string;
  name: string;
  album: string | null;
  image: string | null;
  artist_pair: string | null;
  song_plays: number | null;
}

/** GET /api/radio?track=&artist=&limit= */
export async function radioRoute(env: Env, url: URL): Promise<Response> {
  const track = textParam(url, 'track');
  const artist = textParam(url, 'artist');
  if ((track === null) === (artist === null)) throw new BadRequest('give exactly one of track or artist');
  const limit = intParam(url, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);

  const cte = track !== null ? SONG_TRACKS_CTE : ARTIST_TRACKS_CTE;
  const binds = track !== null ? [track] : [artist, null];
  const [seedPlays, seedSongs, seedName] = await env.DB.batch([
    env.DB.prepare(
      `WITH ${cte} SELECT MAX(played_at_ms) AS played_at_ms FROM plays WHERE track_id IN (SELECT track_id FROM ts)
        GROUP BY played_at_ms / ${HOUR} ORDER BY 1 DESC LIMIT ${MAX_SEED_HOURS}`,
    ).bind(...binds),
    // An artist's songs stay in its radio, so only a track seed excludes any.
    track !== null
      ? env.DB.prepare(
          `WITH ${SONG_TRACKS_CTE} SELECT ${SONG_SQL('ts.track_id')} AS song FROM ts`,
        ).bind(track)
      : env.DB.prepare('SELECT NULL AS song WHERE 0'),
    track !== null
      ? env.DB.prepare(`SELECT t.name, ${PRIMARY_ARTIST_SQL('t.track_id')} AS artist FROM tracks t WHERE t.track_id = ?`).bind(track)
      : env.DB.prepare('SELECT name, NULL AS artist FROM artists WHERE artist_id = ?').bind(artist),
  ]);
  const named = seedName!.results[0] as { name: string; artist: string | null } | undefined;
  const seed =
    track !== null
      ? { type: 'track', id: track, name: named?.name ?? null, artist: named?.artist ?? null }
      : { type: 'artist', id: artist, name: named?.name ?? null };
  const seedMs = (seedPlays!.results as Array<{ played_at_ms: number }>).map((r) => r.played_at_ms);
  if (seedMs.length === 0) return respond({ seed, tracks: [] }, [seedPlays!, seedSongs!, seedName!]);

  // Each window is one range seek on the plays primary key; CROSS JOIN keeps
  // that order (joined plainly, SQLite scanned plays once per window: 2M rows
  // read on the real warehouse). The windows travel as one JSON parameter,
  // since D1 allows only 100 bound parameters.
  const near = await env.DB.prepare(
    `WITH r(a, b) AS (SELECT value ->> 0, value ->> 1 FROM json_each(?))
     SELECT p.played_at_ms AS ms, p.track_id, ${SONG_SQL('p.track_id')} AS song
       FROM r CROSS JOIN plays p ON p.played_at_ms >= r.a AND p.played_at_ms <= r.b
      ORDER BY p.played_at_ms, p.track_id`,
  )
    .bind(JSON.stringify(seedWindows(seedMs)))
    .all<RadioPlay>();
  const exclude = new Set((seedSongs!.results as Array<{ song: string }>).map((r) => r.song));
  const ranked = coPlayed(near.results, seedMs, exclude, Date.now()).slice(0, CANDIDATES);

  // The latest play number of a song is its play count, editions folded.
  const meta = await env.DB.prepare(
    `SELECT t.track_id, t.name, al.name AS album, al.image_url AS image,
            ${PRIMARY_ARTIST_PAIR_SQL('t.track_id')} AS artist_pair,
            (SELECT pn.n FROM play_numbers pn WHERE pn.song = s.song ORDER BY pn.played_at_ms DESC LIMIT 1) AS song_plays
       FROM json_each(?) j JOIN tracks t ON t.track_id = j.value
       LEFT JOIN albums al ON al.album_id = t.album_id
       LEFT JOIN track_songs s ON s.track_id = t.track_id`,
  )
    .bind(JSON.stringify(ranked.map((r) => r.track_id)))
    .all<MetaRow>();
  const byId = new Map(meta.results.map((m) => [m.track_id, m]));
  const pair = (m: MetaRow | undefined): [string, string] | null => (m?.artist_pair ? JSON.parse(m.artist_pair) : null);

  const picked = pickRadio(
    ranked.flatMap((r) => {
      const m = byId.get(r.track_id);
      // A track the warehouse has no name for can't be shown.
      if (!m) return [];
      return [{ ...r, artistKey: pair(m)?.[1].toLowerCase() ?? null, plays: m.song_plays }];
    }),
    limit,
  );

  return respond(
    {
      seed,
      tracks: picked.map((c) => {
        const m = byId.get(c.track_id)!;
        const [artistId, artistName] = pair(m) ?? [null, null];
        return {
          id: c.track_id,
          name: m.name,
          artist: artistName,
          artist_id: artistId,
          album: m.album,
          image: m.image,
          sessions: c.sessions,
          score: Math.round(c.score * 1000) / 1000,
        };
      }),
    },
    [seedPlays!, seedSongs!, seedName!, near, meta],
  );
}
