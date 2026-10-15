/**
 * A song's title with its edition tag taken off, so "Heroes - 2017
 * Remaster", "Heroes (Single Version)" and "Heroes" count as one song.
 *
 * Every place that folds editions keys a song on this title (lowercased)
 * and its primary artist: play numbers and their `track_songs` key,
 * /api/track, /api/top-tracks, /api/artist, /api/on-this-day, search,
 * on-repeat, top-over-time, albums and Wrapped. The SQL and JS forms are
 * built from one list, so they strip exactly the same tags.
 *
 * Conservative on purpose: only tags that name the same recording, re-cut
 * or re-released, are taken off. A remaster is the same performance; a
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
export function songTitle(lowered: string): string {
  for (const { regex, length } of MATCHERS) {
    if (regex.test(lowered)) return rtrimSpaces(lowered.slice(0, lowered.length - length));
  }
  return lowered;
}

/**
 * SQL for songTitle of `lowered`, an expression already lowercased. `lowered`
 * is repeated in the SQL, so pass a column or a cheap expression.
 */
export function songTitleSql(lowered: string): string {
  const arms = SUFFIXES.map(
    (suffix) =>
      `WHEN ${lowered} GLOB '?*${globOf(suffix)}' THEN rtrim(substr(${lowered}, 1, length(${lowered}) - ${suffix.replace(/#/g, '0000').length}), ' ')`,
  );
  return `(CASE ${arms.join(' ')} ELSE ${lowered} END)`;
}
