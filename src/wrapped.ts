import { BadRequest, json } from './api';
import { HISTORY_START_MS, type Era, eraAt, erasFor, localTimeSql, startOfLocalWeek } from './eras';
import { peekSnapshot, snapshot } from './snapshots';
import { PRIMARY_ARTIST_SQL } from './stats/sql';
import { endOfLocalDayUtcMs, isRealDay, localDayKey, startOfLocalDayUtcMs } from './tz';
import type { Access } from './auth';
import type { Env } from './types';

/**
 * A year-in-review ("Wrapped") for any closed range of local calendar days.
 *
 * Unlike /api/stats/*, this is private and takes parameters, so it is not
 * held to the public page's month-only rule: it names the biggest day and a
 * streak's dates. Taking parameters also means a caller could mint keys and
 * force scans, so ADMIN_TOKEN computes any range and READ_TOKEN only the
 * presets (see wrappedPresets). READ_TOKEN gets any other body already
 * computed, and a 403 otherwise.
 *
 * Local time is the era's, as everywhere else: a range that spans the move
 * buckets Newcastle plays in London time and Singapore plays in Singapore
 * time.
 *
 * Minutes are estimated. `played_at_ms` is when a play ended, so a play ran
 * for at most the gap since the one before, and at most the track's length.
 * Plays under 30 s by that measure are skips and count for nothing, the same
 * rule on-repeat uses.
 */

const DAY_MS = 86_400_000;
export const MIN_PLAY_MS = 30_000;
/** Used when a track has no stored duration. */
export const FALLBACK_DURATION_MS = 180_000;
const MAX_RANGE_DAYS = 3660;
const TOP_N = 5;
const NEW_ARTISTS = 3;
/** Below this share of minutes with a known release year, listening age is withheld. */
const MIN_RELEASE_COVERAGE = 0.5;
/** Window, in release years, that defines the "formative" era of a listening age. */
const AGE_WINDOW_YEARS = 5;
/** Age at the centre of the window: taste is set around the late teens. */
const FORMATIVE_AGE = 18;
/** A closed range is recomputed if it ended this recently, in case late plays arrive. */
const SETTLE_MS = 2 * DAY_MS;

export interface WrappedArtist {
  name: string;
  minutes: number;
  plays: number;
  /** Share of all minutes in the range. */
  share: number;
  /** Local days with at least one counted play. */
  days: number;
  longest_run_days: number;
  top_song: string | null;
  image: string | null;
}

export interface WrappedSong {
  name: string;
  artist: string;
  album: string | null;
  image: string | null;
  plays: number;
  minutes: number;
  /** 'YYYY-MM' with the most minutes. */
  peak_month: string;
  /** First local day it was played in the range. */
  first_played: string;
}

export interface WrappedAlbum {
  name: string;
  artist: string;
  image: string | null;
  plays: number;
  minutes: number;
  songs: number;
}

export interface WrappedMonth {
  month: string;
  minutes: number;
  top_artist: string | null;
  top_song: string | null;
  image: string | null;
}

export interface Wrapped {
  range: { from: string; to: string; days: number };
  computed_at: string;
  totals: { minutes: number; plays: number; skips: number; days_listened: number; artists: number; songs: number };
  biggest_day: { date: string; minutes: number } | null;
  /** Minutes in each local hour, 0–23. */
  hours: number[];
  /** Minutes on each weekday, Monday first. */
  weekdays: number[];
  top_artists: WrappedArtist[];
  top_songs: WrappedSong[];
  top_albums: WrappedAlbum[];
  months: WrappedMonth[];
  discoveries: {
    /** Artists and songs first played (ever) inside the range. */
    artists: number;
    songs: number;
    /** Share of the range's minutes that went to those new artists. */
    share: number;
    top: Array<{ name: string; minutes: number; image: string | null }>;
  };
  listening_age: {
    age: number;
    median_year: number;
    /** First and last release year of the window with the most minutes. */
    window: [number, number];
    coverage: number;
    decades: Array<{ decade: number; share: number }>;
  } | null;
  streak: { days: number; from: string; to: string } | null;
}

type DayRow = { track_id: string; day: string; plays: number; ms: number };
type ClockRow = { dow: number; hour: number; ms: number };
type MetaRow = {
  track_id: string;
  name: string;
  artist: string | null;
  album_id: string | null;
  album: string | null;
  image: string | null;
  release_date: string | null;
  first_ever_ms: number;
};
type PriorRow = { kind: 'artist' | 'song'; k: string };

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const minutes = (ms: number) => Math.round(ms / 60_000);
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/** Longest run of consecutive days in an ascending list of 'YYYY-MM-DD'. */
function longestRun(days: string[]): { days: number; from: string; to: string } | null {
  let best: { days: number; from: string; to: string } | null = null;
  let start = 0;
  for (let i = 0; i < days.length; i++) {
    if (i > 0 && dayNumber(days[i]!) !== dayNumber(days[i - 1]!) + 1) start = i;
    const length = i - start + 1;
    if (!best || length > best.days) best = { days: length, from: days[start]!, to: days[i]! };
  }
  return best;
}

function maxBy<T>(entries: Iterable<[T, number]>): T | null {
  let best: T | null = null;
  let bestValue = -Infinity;
  for (const [key, value] of entries) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

function add<K>(map: Map<K, number>, key: K, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}

/**
 * Per-play listened time, in local time, for plays ending in [?1, ?2).
 * The lag looks a day back so the first play in the range has a predecessor.
 */
function playsCte(eras: readonly Era[]): string {
  const { local } = localTimeSql(eras);
  return `WITH raw AS (
      SELECT p.played_at_ms, p.track_id,
             p.played_at_ms - lag(p.played_at_ms) OVER (ORDER BY p.played_at_ms) AS gap_ms
        FROM plays p
       WHERE p.played_at_ms >= ?1 - ${DAY_MS} AND p.played_at_ms < ?2
    ),
    p AS MATERIALIZED (
      SELECT r.track_id, r.gap_ms,
             min(coalesce(r.gap_ms, ${FALLBACK_DURATION_MS}), coalesce(t.duration_ms, ${FALLBACK_DURATION_MS})) AS ms,
             ${local} AS ls
        FROM (SELECT *, played_at_ms / 1000 AS s, strftime('%Y', played_at_ms / 1000, 'unixepoch') AS y FROM raw) r
        JOIN tracks t ON t.track_id = r.track_id
       WHERE r.played_at_ms >= ?1
    )`;
}

export async function computeWrapped(
  db: D1Database,
  eras: readonly Era[],
  range: { from: string; to: string; fromMs: number; toMs: number },
): Promise<Wrapped> {
  const cte = playsCte(eras);
  const counted = `(gap_ms IS NULL OR gap_ms >= ${MIN_PLAY_MS})`;
  const [days, clock, meta, prior, skips] = await db.batch([
    db
      .prepare(
        `${cte}
         SELECT track_id, date(ls, 'unixepoch') AS day, COUNT(*) AS plays, SUM(ms) AS ms
           FROM p WHERE ${counted} GROUP BY track_id, day`,
      )
      .bind(range.fromMs, range.toMs),
    db
      .prepare(
        `${cte}
         SELECT CAST(strftime('%w', ls, 'unixepoch') AS INTEGER) AS dow,
                CAST(strftime('%H', ls, 'unixepoch') AS INTEGER) AS hour, SUM(ms) AS ms
           FROM p WHERE ${counted} GROUP BY dow, hour`,
      )
      .bind(range.fromMs, range.toMs),
    // One row per track played in the range. The first-ever play comes off
    // idx_plays_track, a single index probe per track.
    db
      .prepare(
        `SELECT t.track_id, t.name, ${PRIMARY_ARTIST_SQL('t.track_id')} AS artist, t.album_id,
                al.name AS album, al.image_url AS image, al.release_date,
                (SELECT min(played_at_ms) FROM plays x WHERE x.track_id = t.track_id) AS first_ever_ms
           FROM tracks t LEFT JOIN albums al ON al.album_id = t.album_id
          WHERE t.track_id IN (SELECT DISTINCT track_id FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2)`,
      )
      .bind(range.fromMs, range.toMs),
    // Artists and songs heard before the range, keyed the same way as below,
    // so a new edition of an old song or a placeholder id of a known artist
    // doesn't count as a discovery.
    db
      .prepare(
        `WITH before AS (
           SELECT t.name, ${PRIMARY_ARTIST_SQL('t.track_id')} AS an
             FROM tracks t WHERE t.track_id IN (SELECT DISTINCT track_id FROM plays WHERE played_at_ms < ?1)
         )
         SELECT DISTINCT 'artist' AS kind, lower(an) AS k FROM before WHERE an IS NOT NULL
         UNION ALL
         SELECT DISTINCT 'song', lower(name) || '|' || lower(an) FROM before WHERE an IS NOT NULL`,
      )
      .bind(range.fromMs),
    db.prepare(`${cte} SELECT COUNT(*) AS n FROM p WHERE NOT ${counted}`).bind(range.fromMs, range.toMs),
  ]);

  return summarize(
    range,
    days!.results as DayRow[],
    clock!.results as ClockRow[],
    meta!.results as MetaRow[],
    prior!.results as PriorRow[],
    (skips!.results[0] as { n: number } | undefined)?.n ?? 0,
  );
}

function summarize(
  range: { from: string; to: string; fromMs: number; toMs: number },
  dayRows: DayRow[],
  clockRows: ClockRow[],
  metaRows: MetaRow[],
  priorRows: PriorRow[],
  skips: number,
): Wrapped {
  const meta = new Map(metaRows.map((row) => [row.track_id, row]));
  const priorArtists = new Set(priorRows.filter((r) => r.kind === 'artist').map((r) => r.k));
  const priorSongs = new Set(priorRows.filter((r) => r.kind === 'song').map((r) => r.k));

  type Song = {
    name: string;
    artist: string;
    artistKey: string;
    album: string | null;
    plays: number;
    ms: number;
    months: Map<string, number>;
    firstDay: string;
    /** Minutes per track id, so the art comes from the edition played most. */
    editions: Map<string, number>;
  };
  type Artist = { name: string; plays: number; ms: number; days: Set<string>; songs: Map<string, number> };
  type Album = { name: string; artist: string; plays: number; ms: number; songs: Set<string>; editions: Map<string, number> };

  const songs = new Map<string, Song>();
  const artists = new Map<string, Artist>();
  const albums = new Map<string, Album>();
  const dayMs = new Map<string, number>();
  const monthArtist = new Map<string, Map<string, number>>();
  const monthSong = new Map<string, Map<string, number>>();
  const yearMs = new Map<number, number>();
  let totalMs = 0;
  let totalPlays = 0;
  let datedMs = 0;

  for (const row of dayRows) {
    const track = meta.get(row.track_id);
    if (!track) continue;
    const month = row.day.slice(0, 7);
    totalMs += row.ms;
    totalPlays += row.plays;
    add(dayMs, row.day, row.ms);

    const year = Number(track.release_date?.slice(0, 4));
    if (Number.isInteger(year) && year > 1900) {
      add(yearMs, year, row.ms);
      datedMs += row.ms;
    }

    if (track.artist === null) continue;
    const artistKey = track.artist.toLowerCase();
    const songKey = `${track.name.toLowerCase()}|${artistKey}`;

    let song = songs.get(songKey);
    if (!song) {
      song = { name: track.name, artist: track.artist, artistKey, album: track.album, plays: 0, ms: 0, months: new Map(), firstDay: row.day, editions: new Map() };
      songs.set(songKey, song);
    }
    song.plays += row.plays;
    song.ms += row.ms;
    add(song.months, month, row.ms);
    add(song.editions, row.track_id, row.ms);
    if (row.day < song.firstDay) song.firstDay = row.day;

    let artist = artists.get(artistKey);
    if (!artist) {
      artist = { name: track.artist, plays: 0, ms: 0, days: new Set(), songs: new Map() };
      artists.set(artistKey, artist);
    }
    artist.plays += row.plays;
    artist.ms += row.ms;
    artist.days.add(row.day);
    add(artist.songs, songKey, row.ms);

    if (track.album) {
      const albumKey = `${track.album.toLowerCase()}|${artistKey}`;
      let album = albums.get(albumKey);
      if (!album) {
        album = { name: track.album, artist: track.artist, plays: 0, ms: 0, songs: new Set(), editions: new Map() };
        albums.set(albumKey, album);
      }
      album.plays += row.plays;
      album.ms += row.ms;
      album.songs.add(songKey);
      add(album.editions, row.track_id, row.ms);
    }

    if (!monthArtist.has(month)) monthArtist.set(month, new Map());
    if (!monthSong.has(month)) monthSong.set(month, new Map());
    add(monthArtist.get(month)!, artistKey, row.ms);
    add(monthSong.get(month)!, songKey, row.ms);
  }

  /** Album art of the most-listened edition that has any. */
  const imageOf = (editions: Map<string, number>): string | null => {
    const ranked = [...editions].sort((a, b) => b[1] - a[1]);
    for (const [trackId] of ranked) {
      const image = meta.get(trackId)?.image;
      if (image) return image;
    }
    return null;
  };
  const songImage = (key: string | null) => (key ? imageOf(songs.get(key)!.editions) : null);
  const byMs = <T extends { ms: number }>(a: [string, T], b: [string, T]) => b[1].ms - a[1].ms || a[0].localeCompare(b[0]);

  const rankedArtists = [...artists].sort(byMs);
  const topArtists: WrappedArtist[] = rankedArtists.slice(0, TOP_N).map(([, artist]) => {
    const topSong = maxBy(artist.songs);
    return {
      name: artist.name,
      minutes: minutes(artist.ms),
      plays: artist.plays,
      share: totalMs ? round(artist.ms / totalMs) : 0,
      days: artist.days.size,
      longest_run_days: longestRun([...artist.days].sort())?.days ?? 0,
      top_song: topSong ? songs.get(topSong)!.name : null,
      image: songImage(topSong),
    };
  });

  // Songs rank by plays, as Spotify's do ("you played it 149 times");
  // artists and albums by minutes.
  const byPlays = (a: [string, Song], b: [string, Song]) => b[1].plays - a[1].plays || b[1].ms - a[1].ms || a[0].localeCompare(b[0]);
  const topSongs: WrappedSong[] = [...songs].sort(byPlays).slice(0, TOP_N).map(([, song]) => ({
    name: song.name,
    artist: song.artist,
    album: song.album,
    image: imageOf(song.editions),
    plays: song.plays,
    minutes: minutes(song.ms),
    peak_month: maxBy(song.months)!,
    first_played: song.firstDay,
  }));

  // An album needs three different songs played, so a single on loop (which
  // Spotify files as a one-track album) doesn't count as an album.
  const topAlbums: WrappedAlbum[] = [...albums]
    .filter(([, album]) => album.songs.size >= 3)
    .sort(byMs)
    .slice(0, TOP_N)
    .map(([, album]) => ({
      name: album.name,
      artist: album.artist,
      image: imageOf(album.editions),
      plays: album.plays,
      minutes: minutes(album.ms),
      songs: album.songs.size,
    }));

  const months: WrappedMonth[] = [...monthArtist.keys()].sort().map((month) => {
    const artistKey = maxBy(monthArtist.get(month)!);
    const songKey = maxBy(monthSong.get(month)!);
    const monthTotal = [...dayMs].filter(([day]) => day.startsWith(month)).reduce((sum, [, ms]) => sum + ms, 0);
    return {
      month,
      minutes: minutes(monthTotal),
      top_artist: artistKey ? artists.get(artistKey)!.name : null,
      top_song: songKey ? songs.get(songKey)!.name : null,
      image: songImage(songKey),
    };
  });

  const newArtists = rankedArtists.filter(([key]) => !priorArtists.has(key));
  const newArtistMs = newArtists.reduce((sum, [, artist]) => sum + artist.ms, 0);

  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  for (const row of clockRows) {
    hours[row.hour] = hours[row.hour]! + row.ms;
    // SQLite's %w is Sunday-first.
    const monday = (row.dow + 6) % 7;
    weekdays[monday] = weekdays[monday]! + row.ms;
  }

  const biggestDay = maxBy(dayMs);
  const listenedDays = [...dayMs.keys()].sort();

  return {
    range: { from: range.from, to: range.to, days: dayNumber(range.to) - dayNumber(range.from) + 1 },
    computed_at: new Date().toISOString(),
    totals: {
      minutes: minutes(totalMs),
      plays: totalPlays,
      skips,
      days_listened: dayMs.size,
      artists: artists.size,
      songs: songs.size,
    },
    biggest_day: biggestDay ? { date: biggestDay, minutes: minutes(dayMs.get(biggestDay)!) } : null,
    hours: hours.map(minutes),
    weekdays: weekdays.map(minutes),
    top_artists: topArtists,
    top_songs: topSongs,
    top_albums: topAlbums,
    months,
    discoveries: {
      artists: newArtists.length,
      songs: [...songs.keys()].filter((key) => !priorSongs.has(key)).length,
      share: totalMs ? round(newArtistMs / totalMs) : 0,
      top: newArtists.slice(0, NEW_ARTISTS).map(([, artist]) => ({
        name: artist.name,
        minutes: minutes(artist.ms),
        image: songImage(maxBy(artist.songs)),
      })),
    },
    listening_age: listeningAge(yearMs, datedMs, totalMs, range.to),
    streak: longestRun(listenedDays),
  };
}

/**
 * Spotify's 2025 idea: the age of someone whose formative years produced the
 * music you played. The five-year span of release years with the most minutes
 * is taken as those years, and its centre as the year that listener turned
 * FORMATIVE_AGE.
 */
export function listeningAge(
  yearMs: Map<number, number>,
  datedMs: number,
  totalMs: number,
  to: string,
): Wrapped['listening_age'] {
  const coverage = totalMs ? datedMs / totalMs : 0;
  if (coverage < MIN_RELEASE_COVERAGE || yearMs.size === 0) return null;

  const years = [...yearMs.keys()].sort((a, b) => a - b);
  let half = datedMs / 2;
  let median = years[0]!;
  for (const year of years) {
    half -= yearMs.get(year)!;
    median = year;
    if (half <= 0) break;
  }

  let bestStart = years[0]!;
  let bestMs = -1;
  for (let start = years[0]!; start <= years[years.length - 1]!; start++) {
    let sum = 0;
    for (let y = start; y < start + AGE_WINDOW_YEARS; y++) sum += yearMs.get(y) ?? 0;
    if (sum > bestMs) {
      bestMs = sum;
      bestStart = start;
    }
  }
  const centre = bestStart + Math.floor(AGE_WINDOW_YEARS / 2);
  const decades = new Map<number, number>();
  for (const [year, ms] of yearMs) add(decades, Math.floor(year / 10) * 10, ms);

  return {
    age: Math.max(FORMATIVE_AGE, Number(to.slice(0, 4)) - centre + FORMATIVE_AGE),
    median_year: median,
    window: [bestStart, bestStart + AGE_WINDOW_YEARS - 1],
    coverage: round(coverage),
    decades: [...decades]
      .sort((a, b) => a[0] - b[0])
      .map(([decade, ms]) => ({ decade, share: round(ms / datedMs) })),
  };
}

export interface WrappedRange {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
}

/** Validate `from`/`to` local dates into a closed range that has already ended. */
export function wrappedRange(eras: readonly Era[], url: URL, now: number): WrappedRange {
  return closedRange(eras, url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '', now);
}

function closedRange(eras: readonly Era[], from: string, to: string, now: number): WrappedRange {
  if (!isRealDay(from) || !isRealDay(to)) throw new BadRequest('from and to must be real YYYY-MM-DD dates');

  const zoneOf = (day: string) => eraAt(eras, Date.parse(`${day}T12:00:00Z`)).timeZone;
  let fromMs: number;
  let toMs: number;
  try {
    fromMs = startOfLocalDayUtcMs(from, zoneOf(from));
    toMs = endOfLocalDayUtcMs(to, zoneOf(to));
  } catch (error) {
    throw new BadRequest((error as Error).message);
  }
  if (toMs <= fromMs) throw new BadRequest('`to` must not be before `from`');
  if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) throw new BadRequest(`Range too large; at most ${MAX_RANGE_DAYS} days`);
  const today = localDayKey(now, eraAt(eras, now).timeZone);
  if (to >= today) throw new BadRequest('`to` must be before today: a range is summarized once it has ended');
  if (toMs <= HISTORY_START_MS) throw new BadRequest('Range ends before the history starts');
  return { from, to, fromMs, toMs };
}

/** The version suffix retires every stored body when the shape changes. */
export const wrappedKey = (range: { from: string; to: string }) => `wrapped:v2:${range.from}:${range.to}`;

/**
 * A range that ended a while ago will never change; one that just ended might
 * still gain plays from a late poll, so it settles first.
 */
const freshForSeconds = (range: WrappedRange, now: number) =>
  now - range.toMs > SETTLE_MS ? 10 * 365 * 86_400 : 60 * 60;

export interface WrappedPreset {
  from: string;
  to: string;
  label: string;
  kind: 'year' | 'year_to_date';
  computed: boolean;
}

/** Most closed years a preset list will offer, which also bounds its bound parameters. */
const MAX_PRESET_YEARS = 30;

/**
 * The ranges READ_TOKEN may compute: every closed calendar year that has
 * plays, and this year so far. A bounded, enumerated set, so a read-only
 * caller cannot mint keys and force scans the way an arbitrary range would.
 *
 * "So far" ends with the last complete local week, not yesterday. It then
 * changes weekly, so there is one new key a week rather than one a day, and
 * diffing two days of it cannot isolate a day's listening.
 *
 * Years are in each era's local time, like the ranges themselves. Two cheap
 * reads: one existence probe per candidate off the plays primary key, and the
 * candidates' rows in stats_snapshots.
 */
export async function wrappedPresets(db: D1Database, eras: readonly Era[], now: number): Promise<WrappedPreset[]> {
  const { timeZone } = eraAt(eras, now);
  const thisYear = Number(localDayKey(now, timeZone).slice(0, 4));
  const firstYear = Math.max(new Date(HISTORY_START_MS).getUTCFullYear(), thisYear - MAX_PRESET_YEARS);

  const candidates: Array<Omit<WrappedPreset, 'computed'> & WrappedRange> = [];
  const lastSunday = localDayKey(startOfLocalWeek(eras, now) - 1, timeZone);
  if (lastSunday.startsWith(`${thisYear}-`)) {
    const range = closedRange(eras, `${thisYear}-01-01`, lastSunday, now);
    candidates.push({ ...range, label: `${thisYear} so far`, kind: 'year_to_date' });
  }
  for (let year = thisYear - 1; year >= firstYear; year--) {
    const range = closedRange(eras, `${year}-01-01`, `${year}-12-31`, now);
    candidates.push({ ...range, label: String(year), kind: 'year' });
  }
  if (candidates.length === 0) return [];

  const [played, stored] = await db.batch([
    db
      .prepare(
        `WITH r(i, a, b) AS (VALUES ${candidates.map(() => '(?, ?, ?)').join(', ')})
         SELECT i FROM r WHERE EXISTS (SELECT 1 FROM plays WHERE played_at_ms >= r.a AND played_at_ms < r.b)`,
      )
      .bind(...candidates.flatMap((c, i) => [i, c.fromMs, c.toMs])),
    db
      .prepare(`SELECT key FROM stats_snapshots WHERE body IS NOT NULL AND key IN (${candidates.map(() => '?').join(', ')})`)
      .bind(...candidates.map(wrappedKey)),
  ]);
  const withPlays = new Set((played!.results as Array<{ i: number }>).map((row) => row.i));
  const computed = new Set((stored!.results as Array<{ key: string }>).map((row) => row.key));

  return candidates
    .filter((_, i) => withPlays.has(i))
    .map((c) => ({ from: c.from, to: c.to, label: c.label, kind: c.kind, computed: computed.has(wrappedKey(c)) }));
}

export async function wrappedRangesRoute(env: Env): Promise<Response> {
  return json({ ranges: await wrappedPresets(env.DB, erasFor(env.MOVED_AT), Date.now()) });
}

/**
 * Compute presets nobody has asked for yet, newest first, so a reader rarely
 * waits on a cold compute. Run from the daily cron, `limit` at a time: each
 * compute reads a year of plays several times over, and D1 meters every row
 * read. Returns the keys computed.
 */
export async function warmWrappedPresets(env: Env, ctx: ExecutionContext, now = Date.now(), limit = 1): Promise<string[]> {
  const eras = erasFor(env.MOVED_AT);
  const pending = (await wrappedPresets(env.DB, eras, now)).filter((preset) => !preset.computed).slice(0, limit);
  const warmed: string[] = [];
  for (const preset of pending) {
    const range = closedRange(eras, preset.from, preset.to, now);
    await snapshot(env.DB, ctx, wrappedKey(range), freshForSeconds(range, now), () => computeWrapped(env.DB, eras, range));
    warmed.push(wrappedKey(range));
  }
  return warmed;
}

export async function wrappedRoute(env: Env, ctx: ExecutionContext, url: URL, access: Access): Promise<Response> {
  const now = Date.now();
  const eras = erasFor(env.MOVED_AT);
  const range = wrappedRange(eras, url, now);
  const key = wrappedKey(range);

  let result: { body: string; computedMs: number; source: string } | null = null;
  if (access === 'read') {
    // READ_TOKEN reads whatever is stored, and computes only a preset.
    const stored = await peekSnapshot(env.DB, key);
    if (stored) {
      result = { ...stored, source: 'snapshot' };
    } else {
      const presets = await wrappedPresets(env.DB, eras, now);
      if (!presets.some((preset) => preset.from === range.from && preset.to === range.to)) {
        return json(
          { error: 'This range has not been computed. A read token computes only the ranges at /api/wrapped/ranges.' },
          403,
        );
      }
    }
  }
  result ??= await snapshot(env.DB, ctx, key, freshForSeconds(range, now), () => computeWrapped(env.DB, eras, range));

  return new Response(result.body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      'X-Stats-Source': result.source,
      'X-Stats-Computed-At': new Date(result.computedMs).toISOString(),
    },
  });
}
