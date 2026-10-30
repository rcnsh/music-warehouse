import { type Era, historyStartMs, startOfLocalWeek } from '../eras';
import { SONG_SQL } from '../songs';
import { PRIMARY_ARTIST_SQL } from './sql';

/**
 * Who led each quarter and each year.
 *
 * Attribution is the primary artist only (position 0): export-era rows carry
 * nothing else, so crediting features would inflate the recent API era
 * against six years of history, and primary-only makes a period's shares add
 * up to one. Artists are grouped by lowercased name, which folds the export's
 * `name:` placeholder ids into their real-id twins; songs by title + artist,
 * which folds single/album/re-release ids of the same recording.
 *
 * Periods are UTC calendar quarters. At that size an era's local offset moves
 * a few hours of plays across a boundary at most. The data stops
 * at the start of this week, so the current quarter's total can't be diffed
 * day to day into a daily play count.
 */

const ARTISTS_PER_PERIOD = 5;
const TRACKS_PER_PERIOD = 3;
const LEADERS = 7;

export interface RankedArtist {
  name: string;
  plays: number;
  share: number;
}

export interface RankedTrack {
  /**
   * The song's most-played edition in the period. /api/track folds editions
   * the same way (title and primary artist), so it opens the whole song.
   */
  track_id: string;
  name: string;
  artist: string;
  plays: number;
  image: string | null;
}

export interface Period {
  period: string;
  partial: boolean;
  plays: number;
  artists: RankedArtist[];
  tracks: RankedTrack[];
}

export interface TopOverTime {
  as_of: string;
  attribution: 'primary-artist';
  quarters: Period[];
  years: Period[];
  /** The most-played artists overall, ordered by when they peaked; `share` lines up with `quarters`. */
  leaders: Array<{ name: string; plays: number; share: number[] }>;
}

type Row = {
  kind: 'total' | 'artist' | 'track';
  period: string;
  k: string;
  name: string;
  artist: string | null;
  track_id: string | null;
  plays: number;
  image: string | null;
  leader: number;
};

const round = (value: number) => Math.round(value * 1000) / 1000;

function quarterOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

export async function computeTopOverTime(db: D1Database, now: number, eras: readonly Era[]): Promise<TopOverTime> {
  const cutoff = startOfLocalWeek(eras, now);
  // Counts per (quarter, track) come off the plays primary key first, so the
  // name joins run once per pair (~10k) rather than once per play (~75k).
  const { results } = await db
    .prepare(
      `WITH pq AS MATERIALIZED (
         SELECT strftime('%Y', played_at_ms / 1000, 'unixepoch') || '-Q' ||
                ((CAST(strftime('%m', played_at_ms / 1000, 'unixepoch') AS INTEGER) + 2) / 3) AS q,
                track_id, COUNT(*) AS n
           FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?5 GROUP BY q, track_id
       ),
       pt AS MATERIALIZED (
         SELECT pq.q, substr(pq.q, 1, 4) AS y, pq.n, pq.track_id, t.name AS tn, ${SONG_SQL('pq.track_id')} AS song, t.album_id,
                ${PRIMARY_ARTIST_SQL('pq.track_id')} AS an
           FROM pq JOIN tracks t ON t.track_id = pq.track_id
       ),
       aq AS MATERIALIZED (
         SELECT q, lower(an) AS k, MAX(an) AS name, SUM(n) AS plays FROM pt WHERE an IS NOT NULL GROUP BY q, k
       ),
       leaders AS (
         SELECT k FROM aq GROUP BY k ORDER BY SUM(plays) DESC LIMIT ?2
       ),
       aq_ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY q ORDER BY plays DESC, k) AS rk FROM aq
       ),
       ay AS (
         SELECT substr(q, 1, 4) AS y, k, MAX(name) AS name, SUM(plays) AS plays FROM aq GROUP BY y, k
       ),
       ay_ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY y ORDER BY plays DESC, k) AS rk FROM ay
       ),
       -- With MAX() the bare columns come from the row that holds the maximum,
       -- so title, art and track_id are all the most-played edition's.
       songs AS (
         SELECT 'q' AS grain, q AS period, song AS k, tn AS name, an AS artist, album_id, track_id,
                MAX(n) AS best, SUM(n) AS plays
           FROM pt WHERE an IS NOT NULL GROUP BY q, k
         UNION ALL
         SELECT 'y', y, song, tn, an, album_id, track_id, MAX(n), SUM(n)
           FROM pt WHERE an IS NOT NULL GROUP BY y, song
       ),
       songs_ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY grain, period ORDER BY plays DESC, k) AS rk FROM songs
       )
       SELECT 'total' AS kind, q AS period, '' AS k, '' AS name, NULL AS artist, NULL AS track_id, SUM(n) AS plays,
              NULL AS image, 0 AS leader
         FROM pt GROUP BY q
       UNION ALL
       SELECT 'artist', q, k, name, NULL, NULL, plays, NULL, k IN (SELECT k FROM leaders)
         FROM aq_ranked WHERE rk <= ?3 OR k IN (SELECT k FROM leaders)
       UNION ALL
       SELECT 'artist', y, k, name, NULL, NULL, plays, NULL, 0 FROM ay_ranked WHERE rk <= ?3
       UNION ALL
       SELECT 'track', s.period, s.k, s.name, s.artist, s.track_id, s.plays, al.image_url, 0
         FROM songs_ranked s LEFT JOIN albums al ON al.album_id = s.album_id
        WHERE s.rk <= ?4`,
    )
    .bind(historyStartMs(eras), LEADERS, ARTISTS_PER_PERIOD, TRACKS_PER_PERIOD, cutoff)
    .all<Row>();

  const quarterTotals = new Map<string, number>();
  for (const row of results) if (row.kind === 'total') quarterTotals.set(row.period, row.plays);
  const quarterKeys = [...quarterTotals.keys()].sort();
  const yearTotals = new Map<string, number>();
  for (const [quarter, plays] of quarterTotals) {
    yearTotals.set(quarter.slice(0, 4), (yearTotals.get(quarter.slice(0, 4)) ?? 0) + plays);
  }

  const currentQuarter = quarterOf(cutoff - 1);
  const currentYear = currentQuarter.slice(0, 4);

  const periods = (keys: string[], totals: Map<string, number>, isPartial: (key: string) => boolean): Period[] =>
    keys.map((key) => {
      const plays = totals.get(key) ?? 0;
      const artists = results
        .filter((row) => row.kind === 'artist' && row.period === key)
        .sort((a, b) => b.plays - a.plays || a.k.localeCompare(b.k))
        .slice(0, ARTISTS_PER_PERIOD)
        .map((row) => ({ name: row.name, plays: row.plays, share: plays ? round(row.plays / plays) : 0 }));
      const tracks = results
        .filter((row) => row.kind === 'track' && row.period === key)
        .sort((a, b) => b.plays - a.plays || a.k.localeCompare(b.k))
        .map((row) => ({ track_id: row.track_id!, name: row.name, artist: row.artist ?? '', plays: row.plays, image: row.image }));
      return { period: key, partial: isPartial(key), plays, artists, tracks };
    });

  const leaderRows = results.filter((row) => row.kind === 'artist' && row.leader === 1);
  const leaderKeys = [...new Set(leaderRows.map((row) => row.k))];
  const leaders = leaderKeys.map((k) => {
    const rows = leaderRows.filter((row) => row.k === k);
    const share = quarterKeys.map((quarter) => {
      const plays = rows.find((row) => row.period === quarter)?.plays ?? 0;
      return round(plays / (quarterTotals.get(quarter) || 1));
    });
    return { name: rows[0]!.name, plays: rows.reduce((sum, row) => sum + row.plays, 0), share };
  });
  // Ordered by peak quarter, so a stacked chart reads in the order the
  // artists peaked and colour follows the artist, not their rank.
  const peakIndex = (share: number[]) => share.indexOf(Math.max(...share));
  leaders.sort((a, b) => peakIndex(a.share) - peakIndex(b.share));

  return {
    as_of: new Date(cutoff).toISOString(),
    attribution: 'primary-artist',
    quarters: periods(quarterKeys, quarterTotals, (key) => key === currentQuarter),
    years: periods([...yearTotals.keys()].sort(), yearTotals, (key) => key === currentYear),
    leaders,
  };
}
