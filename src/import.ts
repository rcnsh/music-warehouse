import { BadRequest, intParam, json } from './api';
import { nameKey, reconcileArtists } from './artists';
import { buildInserts } from './db';
import { songStatements } from './play-numbers';
import { syncSearchIndex } from './search-index';
import type { Env } from './types';
import { MIN_PLAY_MS } from './listen';

/**
 * How far apart an export record and a stored play of the same track may end
 * and still be the same play.
 *
 * Both timestamps mark the end of playback: the export's `ts` is "when the
 * track stopped playing", and the API's `played_at` is the same moment (see
 * listen.ts). The export truncates it to whole seconds
 * (`2026-09-08T18:51:38Z`) while the API keeps milliseconds
 * (`…:38.235Z`, fixtures/NOTES.md), so one play arrives up to a second apart
 * and an exact key match never sees it; the rest of the margin is for the two
 * being logged by different systems. Two real plays of one track end at least
 * the later one's length apart, and an export record under MIN_PLAY_MS is
 * dropped as a skip, so 5 s cannot merge two genuine plays.
 *
 * This is the one rule for both sources: a re-run of the same export and the
 * poller's copy of a play are matched alike. `match_window_s` overrides it per
 * request, up to MAX_MATCH_WINDOW_S, for checking it with a dry run.
 */
export const DUPLICATE_WINDOW_MS = 5_000;

/** Upper bound for `match_window_s`: past MIN_PLAY_MS a window could merge two genuine plays. */
export const MAX_MATCH_WINDOW_S = 30;

/**
 * True for an element `j` of a json_each over `[played_at_ms, track_id]`
 * pairs when a play of that track is stored within `?2` ms of it. Reads one
 * seek on idx_plays_track(track_id, played_at_ms).
 */
export const NEAR_STORED_PLAY = `EXISTS (SELECT 1 FROM plays p
                 WHERE p.track_id = json_extract(j.value, '$[1]')
                   AND p.played_at_ms BETWEEN json_extract(j.value, '$[0]') - ?2 AND json_extract(j.value, '$[0]') + ?2)`;

/**
 * One record from a Spotify Extended Streaming History export.
 * `endTime`/`trackName` are the older one-year "Account data" export's field
 * names, accepted so a mistakenly-requested export still imports.
 */
export interface ExportRecord {
  ts?: string | null;
  endTime?: string | null;
  ms_played?: number | null;
  msPlayed?: number | null;
  spotify_track_uri?: string | null;
  master_metadata_track_name?: string | null;
  trackName?: string | null;
  master_metadata_album_artist_name?: string | null;
  artistName?: string | null;
}

export interface ImportRows {
  plays: Array<{ played_at_ms: number; track_id: string; source: string }>;
  tracks: Array<{ track_id: string; name: string; first_seen_ms: number }>;
  artists: Array<{ artist_id: string; name: string }>;
  trackArtists: Array<{ track_id: string; artist_id: string; position: number }>;
  skipped: number;
  /** Records dropped as skips: played for under MIN_PLAY_MS. */
  short: number;
}

/**
 * The (played_at_ms, track_id) a record would be stored under, or null when it
 * has no track URI or usable timestamp.
 */
export function exportKey(record: ExportRecord): { played_at_ms: number; track_id: string } | null {
  const uri = record.spotify_track_uri;
  const timestamp = record.ts ?? record.endTime;
  if (!uri || !timestamp || !uri.startsWith('spotify:track:')) return null;
  const playedAtMs = Date.parse(timestamp);
  if (!Number.isFinite(playedAtMs)) return null;
  return { played_at_ms: playedAtMs, track_id: uri.slice('spotify:track:'.length) };
}

/**
 * A skip: played for under MIN_PLAY_MS. The export logs every start, however
 * brief, while the API's recently-played only lists plays that counted, and
 * Wrapped and the histories give anything shorter no minutes. A record
 * without a duration is kept, since nothing says it was short.
 */
export function isShortRecord(record: ExportRecord): boolean {
  const played = record.ms_played ?? record.msPlayed;
  return typeof played === 'number' && played < MIN_PLAY_MS;
}

/**
 * Pure: map export records to row sets. Records without a track URI cannot be
 * keyed, and skips are not plays.
 */
export function normalizeExport(records: ExportRecord[]): ImportRows {
  const plays = new Map<string, ImportRows['plays'][number]>();
  const tracks = new Map<string, ImportRows['tracks'][number]>();
  const artists = new Map<string, ImportRows['artists'][number]>();
  const trackArtists = new Map<string, ImportRows['trackArtists'][number]>();
  let skipped = 0;
  let short = 0;

  for (const record of records) {
    // Podcast episodes and local files have no track URI, so there is no
    // primary key to store them under.
    const key = exportKey(record);
    if (!key) {
      skipped++;
      continue;
    }
    if (isShortRecord(record)) {
      short++;
      continue;
    }
    const { played_at_ms: playedAtMs, track_id: trackId } = key;

    plays.set(`${playedAtMs}:${trackId}`, { played_at_ms: playedAtMs, track_id: trackId, source: 'export' });

    const name = record.master_metadata_track_name ?? record.trackName ?? '';
    const existing = tracks.get(trackId);
    tracks.set(trackId, {
      track_id: trackId,
      name,
      first_seen_ms: existing ? Math.min(existing.first_seen_ms, playedAtMs) : playedAtMs,
    });

    // The album artist, which is all the export carries — no per-track credits,
    // so featured artists are absent and compilations collapse to their
    // compilation artist. Position is always 0 for the same reason.
    const artistName = record.master_metadata_album_artist_name ?? record.artistName;
    if (artistName) {
      const artistId = nameKey(artistName);
      if (!artists.has(artistId)) artists.set(artistId, { artist_id: artistId, name: artistName });
      const key = `${trackId}:${artistId}`;
      if (!trackArtists.has(key)) trackArtists.set(key, { track_id: trackId, artist_id: artistId, position: 0 });
    }
  }

  return {
    plays: [...plays.values()],
    tracks: [...tracks.values()],
    artists: [...artists.values()],
    trackArtists: [...trackArtists.values()],
    skipped,
    short,
  };
}

/**
 * Import one chunk of export records (R10).
 *
 * A record is a duplicate when a play of the same track is already stored
 * within DUPLICATE_WINDOW_MS of it, which catches the poller's copy of the
 * same play as well as a re-import, and is dropped rather than stored twice.
 * Skips (under MIN_PLAY_MS) are dropped before that.
 *
 * `dry_run=1` writes nothing and returns the timestamp of every play that
 * would be inserted, plus how far each duplicate was from the stored play it
 * matched, so a client can say where the gaps are and check the window.
 *
 * The export carries artist *names* but no Spotify ids, so artists are stored
 * under a `name:<artist name>` key (see src/artists.ts). That is enough for
 * /api/top-artists to see export-era listening; it is not enough to reconcile
 * with id-keyed artists automatically, so a track that is also polled live has
 * its name-keyed link dropped in favour of the real one. Albums are skipped
 * entirely — `albums.album_id` has no name-keyed equivalent worth inventing.
 * See docs/design.md, "Known limitations".
 */
export async function importChunk(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dry_run') === '1';
  let windowMs: number;
  try {
    windowMs = intParam(url, 'match_window_s', DUPLICATE_WINDOW_MS / 1000, 0, MAX_MATCH_WINDOW_S) * 1000;
  } catch (error) {
    if (error instanceof BadRequest) return json({ error: error.message }, 400);
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }

  const records = Array.isArray(body)
    ? (body as ExportRecord[])
    : ((body as { records?: ExportRecord[] })?.records ?? null);

  if (!Array.isArray(records)) {
    return json({ error: 'Expected an array of records, or { "records": [...] }.' }, 400);
  }
  if (records.length > 2000) {
    return json({ error: 'Chunk too large; send at most 2000 records per request.' }, 400);
  }

  const rows = normalizeExport(records);
  // One JSON parameter rather than chunked VALUES, so each statement below
  // can test every record against what is stored.
  const pairs = JSON.stringify(rows.plays.map((play) => [play.played_at_ms, play.track_id]));

  if (dryRun) return json(await dryRunChunk(env, records.length, rows, pairs, windowMs));
  if (rows.plays.length === 0) {
    return json({ received: records.length, inserted: 0, duplicates: 0, skipped: rows.skipped, short: rows.short, rows_written: 0 });
  }

  const results = await env.DB.batch([
    // normalizeExport keeps one row per key, and SQLite reads the whole
    // SELECT before an INSERT … SELECT on the same table writes, so the ones
    // not already near a stored play are the ones this batch inserts.
    env.DB.prepare(`SELECT COUNT(*) AS n FROM json_each(?1) j WHERE ${NEAR_STORED_PLAY}`).bind(pairs, windowMs),
    // Stats and Wrapped bodies are cached for days to years; one cut before
    // these plays existed would never change. Only when something will land,
    // so re-running an import doesn't throw them away.
    env.DB
      .prepare(`DELETE FROM stats_snapshots WHERE EXISTS (SELECT 1 FROM json_each(?1) j WHERE NOT ${NEAR_STORED_PLAY})`)
      .bind(pairs, windowMs),
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO plays (played_at_ms, track_id, source)
         SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), 'export' FROM json_each(?1) j
          WHERE NOT ${NEAR_STORED_PLAY}`,
      )
      .bind(pairs, windowMs),
    // An older play moves a known track's first sighting earlier, as a poll's does.
    ...buildInserts(env.DB, 'tracks', ['track_id', 'name', 'first_seen_ms'], rows.tracks, {
      verb: 'INSERT',
      conflictClause:
        'ON CONFLICT(track_id) DO UPDATE SET first_seen_ms = excluded.first_seen_ms ' +
        'WHERE excluded.first_seen_ms < tracks.first_seen_ms',
    }),
    ...buildInserts(env.DB, 'artists', ['artist_id', 'name'], rows.artists),
    ...buildInserts(env.DB, 'track_artists', ['track_id', 'artist_id', 'position'], rows.trackArtists),
    // Name keys just written for an artist the poller already knows by id are
    // redundant; fold them in rather than leaving a duplicate behind.
    ...reconcileArtists(env.DB),
    syncSearchIndex(env.DB, rows.tracks.map((track) => track.track_id)),
    ...songStatements(env.DB, rows.tracks.map((track) => track.track_id), rows.plays),
  ]);

  const inserted = rows.plays.length - ((results[0]?.results[0] as { n: number } | undefined)?.n ?? 0);
  const rowsWritten = results.reduce((total, result) => total + (result.meta?.rows_written ?? 0), 0);

  return json({
    received: records.length,
    inserted,
    duplicates: rows.plays.length - inserted,
    skipped: rows.skipped,
    short: rows.short,
    artists: rows.artists.length,
    track_artists: rows.trackArtists.length,
    // Real D1 row-write cost including index writes, so the client script can
    // pace itself against a daily ceiling (the Free plan's is 100,000).
    rows_written: rowsWritten,
  });
}

/**
 * What importChunk would do with a chunk, writing nothing: the same rule, read
 * per record so each new play's timestamp and each duplicate's distance from
 * the stored play it matched can be reported.
 */
async function dryRunChunk(env: Env, received: number, rows: ImportRows, pairs: string, windowMs: number) {
  const matches =
    rows.plays.length === 0
      ? []
      : (
          await env.DB.prepare(
            `SELECT (SELECT p.played_at_ms FROM plays p
                      WHERE p.track_id = json_extract(j.value, '$[1]')
                        AND p.played_at_ms BETWEEN json_extract(j.value, '$[0]') - ?2 AND json_extract(j.value, '$[0]') + ?2
                      ORDER BY ABS(p.played_at_ms - json_extract(j.value, '$[0]')) LIMIT 1) AS stored_ms
               FROM json_each(?1) j
              ORDER BY j.key`,
          )
            .bind(pairs, windowMs)
            .all<{ stored_ms: number | null }>()
        ).results;

  const newPlaysMs: number[] = [];
  const duplicateOffsetsMs: number[] = [];
  rows.plays.forEach((play, i) => {
    const storedMs = matches[i]?.stored_ms ?? null;
    if (storedMs === null) newPlaysMs.push(play.played_at_ms);
    else duplicateOffsetsMs.push(storedMs - play.played_at_ms);
  });

  return {
    dry_run: true,
    received,
    duplicates: duplicateOffsetsMs.length,
    skipped: rows.skipped,
    short: rows.short,
    new: newPlaysMs.length,
    new_plays_ms: newPlaysMs,
    // Stored minus export, in ms: positive when the stored timestamp is later.
    duplicate_offsets_ms: duplicateOffsetsMs,
  };
}
