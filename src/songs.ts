import { PRIMARY_ARTIST_SQL } from './stats/sql';

/**
 * Song identity: which tracks are one song. A song is a title with its
 * edition tag taken off, so "Heroes - 2017 Remaster", "Heroes (Single
 * Version)" and "Heroes" count as one, and its primary artist (the first by
 * id, as PRIMARY_ARTIST_SQL takes it), both lowercased ASCII only, as
 * SQLite's lower() does. A track with no primary artist is a song of its own.
 *
 * Play numbers store each track's song in `track_songs` (src/play-numbers.ts),
 * and everything that folds editions reads it there (SONG_SQL) or, for rows
 * already in memory, computes the same key (songKey): /api/track,
 * /api/top-tracks, /api/artist, /api/on-this-day, search, radio, on-repeat,
 * top-over-time, albums and Wrapped. Nothing else builds a key.
 *
 * Tags are taken off conservatively: only tags that name the same
 * recording, re-cut or re-released. A remaster is the same performance; a
 * "single version" or "radio edit" is the album recording shortened for
 * release. "Live", "Acoustic", "Remix", "Demo", "Instrumental" and the like
 * are different performances and stay apart, as do tags not listed here.
 * One tag is taken off, at the very end of the title, after " - " or in
 * round or square brackets; anything before it must be non-empty.
 */

/** `#` stands for a four-digit year. Longer forms before shorter ones that end them. */
const TAGS = [
  '# digital remaster',
  'digital remaster',
  'digitally remastered',
  '# remastered version',
  'remastered # version',
  'remastered version',
  'remastered #',
  '# remastered',
  '# remaster',
  'remastered',
  'remaster',
  'single version',
  'radio edit',
];

/** Each tag as a suffix of a lowercased title, with its separator. */
const SUFFIXES = TAGS.flatMap((tag) => [` - ${tag}`, ` (${tag})`, ` [${tag}]`]);

/** GLOB for a suffix: brackets and `#` become character classes. */
const globOf = (suffix: string) =>
  suffix.replace(/[[\]*?]/g, (c) => `[${c}]`).replace(/#/g, '[0-9][0-9][0-9][0-9]');

const regexOf = (suffix: string) =>
  new RegExp(`^[\\s\\S]+${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/#/g, '[0-9]{4}')}$`);

const MATCHERS = SUFFIXES.map((suffix) => ({ regex: regexOf(suffix), length: suffix.replace(/#/g, '0000').length }));

/** Trailing spaces only, as SQLite's rtrim() takes off. */
const rtrimSpaces = (s: string) => s.replace(/ +$/, '');

/** The song title of an already lowercased track title. Matches songTitleSql. */
function songTitle(lowered: string): string {
  for (const { regex, length } of MATCHERS) {
    if (regex.test(lowered)) return rtrimSpaces(lowered.slice(0, lowered.length - length));
  }
  return lowered;
}

/**
 * SQL for songTitle of `lowered`, an expression already lowercased. `lowered`
 * is repeated in the SQL, so pass a column or a cheap expression.
 */
function songTitleSql(lowered: string): string {
  const arms = SUFFIXES.map(
    (suffix) =>
      `WHEN ${lowered} GLOB '?*${globOf(suffix)}' THEN rtrim(substr(${lowered}, 1, length(${lowered}) - ${suffix.replace(/#/g, '0000').length}), ' ')`,
  );
  return `(CASE ${arms.join(' ')} ELSE ${lowered} END)`;
}

/** Lowercase as SQLite's lower() does: ASCII letters only. */
const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The song key of track `t` (a table alias with `name` and `track_id`),
 * computed from its title and credits. Only play numbers compute it, to
 * store it in `track_songs`; read it with SONG_SQL.
 */
export const SONG_KEY_SQL = (t: string) =>
  `COALESCE(${songTitleSql(`lower(${t}.name)`)} || char(31) || lower(${PRIMARY_ARTIST_SQL(`${t}.track_id`)}), char(30) || ${t}.track_id)`;

/**
 * The stored song of the track in `trackIdColumn`, one primary key seek. A
 * track not keyed yet stands alone, as SONG_KEY_SQL keys one with no artist.
 */
export const SONG_SQL = (trackIdColumn: string) =>
  `COALESCE((SELECT song FROM track_songs WHERE track_id = ${trackIdColumn}), char(30) || ${trackIdColumn})`;

/** SONG_KEY_SQL of a track in memory, `artist` its primary artist's name. */
export function songKey(track: { track_id: string; name: string; artist: string | null }): string {
  if (track.artist === null) return `\x1e${track.track_id}`;
  return `${songTitle(lower(track.name))}\x1f${lower(track.artist)}`;
}
