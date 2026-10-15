import { timeZoneParam } from './api';
import { respond } from './history';
import { localDayKey, offsetMsAt } from './tz';
import type { Env } from './types';

/**
 * GET /api/home?tz=: the rows of a client's home screen, ranked from the history.
 *
 * Spotify's own home is not open to apps, and its recently-played returns 50
 * plays, which one album can fill. This ranks every playlist, album and artist
 * the user has played from, the way Spotify describes its shortcuts: what they
 * play most, favouring lately and this time of day.
 *
 * A play counts toward its context, or toward its track's album when it has
 * none (the export never says). Plays from Liked Songs or anything else that
 * isn't a playlist, album or artist count toward nothing: a client shows Liked
 * Songs on its own.
 *
 * Consecutive plays from one context are one session, so an album played
 * through counts once, a little more than one song from it (WEIGHT). Four rows:
 *
 * - `shortcuts`: frecency, each session halving in weight every
 *   SHORTCUT_HALF_LIFE_MS, raised near the current local hour and on the same
 *   kind of day (weekday or weekend).
 * - `jump_back_in`: newest session first.
 * - `around_now`: what the user plays at this hour, from sessions near it on at
 *   least AROUND_MIN_DAYS days in the last year.
 * - `rediscover`: played on many days, but not in the last REDISCOVER_QUIET_MS.
 *
 * Rows may overlap; a client shows each context once, in this order. At most
 * MAX_PER_ARTIST albums or artist pages of one primary artist per row, except
 * jump back in, which is plain recency.
 *
 * Cost: the last year's plays read one at a time (about three rows each with the
 * track and its primary artist) and older ones aggregated in SQL. The body is
 * held at the edge until the newest play, the local hour or the day changes.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Plays this far back are sessioned; older ones are only counted for rediscover. */
const DETAIL_MS = 365 * DAY_MS;
/** A gap between plays' ends longer than this starts a new session. */
const SESSION_GAP_MS = 40 * 60_000;
/** A play that ended sooner than this after the one before was skipped. */
const MIN_PLAY_MS = 30_000;
const SHORTCUT_HALF_LIFE_MS = 14 * DAY_MS;
const AROUND_HALF_LIFE_MS = 60 * DAY_MS;
const REDISCOVER_HALF_LIFE_MS = 730 * DAY_MS;
/** How much a session at this hour adds to a shortcut, on top of 1. */
const HOUR_BOOST = 1.5;
const SAME_DAY_TYPE_BOOST = 1.15;
/** Spread of the time-of-day match, in hours. */
const HOUR_SIGMA = 2;
const AROUND_SIGMA = 1.25;
/** Within this many hours of now counts as "around now". */
const AROUND_WINDOW_H = 1.5;
const AROUND_MIN_DAYS = 3;
const REDISCOVER_QUIET_MS = 90 * DAY_MS;
const REDISCOVER_MIN_DAYS = 4;
const MAX_PER_ARTIST = 2;
const SHORTCUTS = 8;
const ROW = 20;
const EDGE_TTL_SECONDS = 3600;
const CACHE_ORIGIN = 'https://home.internal';
const VERSION = 1;

/** A play's context key, in SQL: its playlist, album or artist, its track's album without one, or NULL. */
const KEY_SQL = `CASE WHEN p.context_uri IS NULL THEN 'spotify:album:' || t.album_id
                      WHEN p.context_uri GLOB 'spotify:album:*' OR p.context_uri GLOB 'spotify:playlist:*'
                        OR p.context_uri GLOB 'spotify:artist:*' THEN p.context_uri END`;
const LEAD_SQL = `(SELECT ta.artist_id FROM track_artists ta WHERE ta.track_id = p.track_id AND ta.position = 0)`;

export interface HomePlay {
  ms: number;
  key: string | null;
  artist: string | null;
}

export interface OlderContext {
  key: string;
  /** Distinct UTC days with a play. */
  days: number;
  last_ms: number;
  artist: string | null;
}

export interface Session {
  key: string;
  startMs: number;
  endMs: number;
  /** Plays not skipped. */
  tracks: number;
  artist: string | null;
}

/** Plays (oldest first) into sessions: runs from one context with no long gap. Skips count for nothing. */
export function sessions(plays: HomePlay[]): Session[] {
  const out: Session[] = [];
  let current: Session | null = null;
  let prevMs: number | null = null;
  for (const play of plays) {
    const listened = prevMs === null || play.ms - prevMs >= MIN_PLAY_MS;
    const continues = current !== null && play.key === current.key && prevMs !== null && play.ms - prevMs <= SESSION_GAP_MS;
    if (!continues) {
      if (current && current.tracks > 0) out.push(current);
      current = play.key ? { key: play.key, startMs: play.ms, endMs: play.ms, tracks: 0, artist: play.artist } : null;
    }
    if (current) {
      current.endMs = play.ms;
      if (listened) current.tracks++;
    }
    prevMs = play.ms;
  }
  if (current && current.tracks > 0) out.push(current);
  return out;
}

/** An album played through counts a little more than one song from it. */
const weight = (s: Session) => 1 + Math.log(s.tracks);
const decay = (ageMs: number, halfLifeMs: number) => 2 ** (-Math.max(0, ageMs) / halfLifeMs);

/** Hours between two times of day, around the clock. */
export function hourDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

const closeness = (a: number, b: number, sigma: number) => Math.exp(-(hourDistance(a, b) ** 2) / (2 * sigma * sigma));

/** Local time of day (fractional hours) and whether it's a weekend, offsets looked up once per UTC hour. */
function clock(timeZone: string) {
  const offsets = new Map<number, number>();
  return (utcMs: number) => {
    const bucket = Math.floor(utcMs / HOUR_MS);
    let offset = offsets.get(bucket);
    if (offset === undefined) offsets.set(bucket, (offset = offsetMsAt(utcMs, timeZone)));
    const local = utcMs + offset;
    const day = new Date(local).getUTCDay();
    return { hour: (((local % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS, weekend: day === 0 || day === 6 };
  };
}

export interface Ranked {
  key: string;
  artist: string | null;
  sessions: number;
  lastMs: number;
}

export interface HomeRanking {
  hour: number;
  shortcuts: Ranked[];
  jumpBackIn: Ranked[];
  aroundNow: Ranked[];
  rediscover: Ranked[];
}

/** Best first, at most MAX_PER_ARTIST per primary artist (playlists have none), [limit] long. */
function pick(scored: Array<Ranked & { score: number }>, limit: number, capArtists = true): Ranked[] {
  const perArtist = new Map<string, number>();
  const out: Ranked[] = [];
  for (const item of scored.sort((a, b) => b.score - a.score || b.lastMs - a.lastMs || a.key.localeCompare(b.key))) {
    const artist = item.key.startsWith('spotify:playlist:') ? null : item.artist;
    if (capArtists && artist) {
      const n = perArtist.get(artist) ?? 0;
      if (n >= MAX_PER_ARTIST) continue;
      perArtist.set(artist, n + 1);
    }
    out.push({ key: item.key, artist: item.artist, sessions: item.sessions, lastMs: item.lastMs });
    if (out.length >= limit) break;
  }
  return out;
}

/** The four rows from the last year's plays (oldest first) and older contexts, as of [now] in [timeZone]. */
export function rankHome(plays: HomePlay[], older: OlderContext[], now: number, timeZone: string): HomeRanking {
  const at = clock(timeZone);
  const today = at(now);
  const all = sessions(plays);

  interface Acc {
    key: string;
    artist: string | null;
    sessions: number;
    lastMs: number;
    frecency: number;
    around: number;
    aroundDays: Set<string>;
    recent: boolean;
    pastDays: Set<number>;
  }
  const byKey = new Map<string, Acc>();
  for (const s of all) {
    let acc = byKey.get(s.key);
    if (!acc) {
      acc = { key: s.key, artist: s.artist, sessions: 0, lastMs: 0, frecency: 0, around: 0, aroundDays: new Set(), recent: false, pastDays: new Set() };
      byKey.set(s.key, acc);
    }
    const when = at(s.startMs);
    const age = now - s.endMs;
    acc.sessions++;
    acc.lastMs = Math.max(acc.lastMs, s.endMs);
    acc.artist ??= s.artist;
    const timeOfDay = 1 + HOUR_BOOST * closeness(when.hour, today.hour, HOUR_SIGMA);
    acc.frecency += weight(s) * decay(age, SHORTCUT_HALF_LIFE_MS) * timeOfDay * (when.weekend === today.weekend ? SAME_DAY_TYPE_BOOST : 1);
    if (hourDistance(when.hour, today.hour) <= AROUND_WINDOW_H) {
      acc.around += weight(s) * closeness(when.hour, today.hour, AROUND_SIGMA) * decay(age, AROUND_HALF_LIFE_MS);
      acc.aroundDays.add(localDayKey(s.startMs, timeZone));
    }
    if (age < REDISCOVER_QUIET_MS) acc.recent = true;
    else acc.pastDays.add(Math.floor(s.startMs / DAY_MS));
  }

  const accs = [...byKey.values()];
  const shortcuts = pick(accs.map((a) => ({ ...a, score: a.frecency })), SHORTCUTS);
  const jumpBackIn = pick(accs.map((a) => ({ ...a, score: a.lastMs })), ROW, false);
  const aroundNow = pick(
    accs.filter((a) => a.aroundDays.size >= AROUND_MIN_DAYS).map((a) => ({ ...a, score: a.around })),
    ROW,
  );

  // Days played: before the detailed year counted by SQL, within it from the
  // sessions. The two ranges never share a day. Anything played lately is out.
  const past = new Map<string, { key: string; artist: string | null; days: number; lastMs: number }>();
  for (const o of older) past.set(o.key, { key: o.key, artist: o.artist, days: o.days, lastMs: o.last_ms });
  for (const a of accs) {
    if (a.recent || a.pastDays.size === 0) continue;
    const prior = past.get(a.key);
    past.set(a.key, {
      key: a.key,
      artist: a.artist ?? prior?.artist ?? null,
      days: a.pastDays.size + (prior?.days ?? 0),
      lastMs: a.lastMs,
    });
  }
  const rediscover = pick(
    [...past.values()]
      .filter((p) => !byKey.get(p.key)?.recent && p.days >= REDISCOVER_MIN_DAYS)
      .map((p) => ({ ...p, sessions: p.days, score: p.days * decay(now - p.lastMs, REDISCOVER_HALF_LIFE_MS) })),
    ROW,
  );

  return { hour: Math.floor(today.hour), shortcuts, jumpBackIn, aroundNow, rediscover };
}

interface Meta {
  uri: string;
  name: string | null;
  image: string | null;
}

const TYPE = /^spotify:(album|playlist|artist):/;

/** GET /api/home?tz= */
export async function homeRoute(env: Env, url: URL): Promise<Response> {
  const timeZone = timeZoneParam(url, env);
  const now = Date.now();
  const latest = await env.DB.prepare('SELECT MAX(played_at_ms) AS ms FROM plays').first<{ ms: number | null }>();
  const hour = Math.floor(((now + offsetMsAt(now, timeZone)) % DAY_MS) / HOUR_MS);
  const key = new Request(
    `${CACHE_ORIGIN}/v${VERSION}/${encodeURIComponent(timeZone)}/${localDayKey(now, timeZone)}/${hour}/${latest?.ms ?? 0}`,
  );
  const cache = await caches.open('home');
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), 'Cache-Control': 'no-store', 'X-Cache': 'hit' } });

  const [recent, older] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.played_at_ms AS ms, ${KEY_SQL} AS key, ${LEAD_SQL} AS artist
         FROM plays p LEFT JOIN tracks t ON t.track_id = p.track_id
        WHERE p.played_at_ms >= ? AND p.played_at_ms <= ?
        ORDER BY p.played_at_ms`,
    ).bind(now - DETAIL_MS, now),
    env.DB.prepare(
      `SELECT key, COUNT(DISTINCT day) AS days, MAX(ms) AS last_ms, MAX(artist) AS artist
         FROM (SELECT p.played_at_ms AS ms, p.played_at_ms / ${DAY_MS} AS day, ${KEY_SQL} AS key, ${LEAD_SQL} AS artist
                 FROM plays p LEFT JOIN tracks t ON t.track_id = p.track_id
                WHERE p.played_at_ms < ?)
        WHERE key IS NOT NULL
        GROUP BY key HAVING COUNT(DISTINCT day) >= 2`,
    ).bind(now - DETAIL_MS),
  ]);
  const ranking = rankHome(recent!.results as unknown as HomePlay[], older!.results as unknown as OlderContext[], now, timeZone);

  const rows = [ranking.shortcuts, ranking.jumpBackIn, ranking.aroundNow, ranking.rediscover];
  const uris = [...new Set(rows.flat().map((r) => r.key))];
  const artists = [...new Set(rows.flat().flatMap((r) => (r.artist ? [r.artist] : [])))];
  const [meta, names] = await env.DB.batch([
    env.DB.prepare(
      `SELECT j.value AS uri,
              COALESCE(CASE WHEN j.value GLOB 'spotify:album:*' THEN (SELECT name FROM albums WHERE album_id = substr(j.value, 15))
                            WHEN j.value GLOB 'spotify:artist:*' THEN (SELECT name FROM artists WHERE artist_id = substr(j.value, 16)) END,
                       (SELECT name FROM contexts WHERE uri = j.value)) AS name,
              CASE WHEN j.value GLOB 'spotify:album:*' THEN (SELECT image_url FROM albums WHERE album_id = substr(j.value, 15)) END AS image
         FROM json_each(?) j`,
    ).bind(JSON.stringify(uris)),
    env.DB.prepare('SELECT artist_id, name FROM artists WHERE artist_id IN (SELECT value FROM json_each(?))').bind(
      JSON.stringify(artists),
    ),
  ]);
  const metaByUri = new Map((meta!.results as unknown as Meta[]).map((m) => [m.uri, m]));
  const artistName = new Map((names!.results as Array<{ artist_id: string; name: string }>).map((a) => [a.artist_id, a.name]));
  const item = (r: Ranked) => ({
    uri: r.key,
    type: TYPE.exec(r.key)?.[1] ?? null,
    name: metaByUri.get(r.key)?.name ?? null,
    image: metaByUri.get(r.key)?.image ?? null,
    // Whose it is, for an album's subtitle; a playlist has none.
    artist: r.key.startsWith('spotify:playlist:') || !r.artist ? null : (artistName.get(r.artist) ?? null),
    sessions: r.sessions,
    last_played_ms: r.lastMs,
  });

  const response = respond(
    {
      tz: timeZone,
      hour: ranking.hour,
      shortcuts: ranking.shortcuts.map(item),
      jump_back_in: ranking.jumpBackIn.map(item),
      around_now: ranking.aroundNow.map(item),
      rediscover: ranking.rediscover.map(item),
    },
    [recent!, older!, meta!, names!],
  );
  const stored = response.clone();
  await cache.put(key, new Response(stored.body, { headers: { ...Object.fromEntries(stored.headers), 'Cache-Control': `max-age=${EDGE_TTL_SECONDS}` } }));
  return response;
}
