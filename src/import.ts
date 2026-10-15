import { BadRequest, intParam, json } from './api';
import { NAME_KEY_PREFIX, buildInserts, countStoredPlays, reconcileNameKeyedArtists } from './db';
import { songStatements } from './play-numbers';
import { syncSearchIndex } from './search-index';
import type { Env } from './types';

/**
 * One record from a Spotify Extended Streaming History export.
 * `endTime`/`trackName` are the older one-year "Account data" export's field
 * names, accepted so a mistakenly-requested export still imports.
 */
export interface ExportRecord {
  ts?: string | null;
  endTime?: string | null;
  ms_played?: number | null;
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
}

/** Pure: map export records to row sets. Records without a track URI cannot be keyed. */
export function normalizeExport(records: ExportRecord[]): ImportRows {
  const plays = new Map<string, ImportRows['plays'][number]>();
  const tracks = new Map<string, ImportRows['tracks'][number]>();
  const artists = new Map<string, ImportRows['artists'][number]>();
  const trackArtists = new Map<string, ImportRows['trackArtists'][number]>();
  let skipped = 0;

  for (const record of records) {
    const uri = record.spotify_track_uri;
    const timestamp = record.ts ?? record.endTime;

    // Podcast episodes and local files have no track URI, so there is no
    // primary key to store them under.
    if (!uri || !timestamp) {
      skipped++;
      continue;
    }

    const trackId = uri.startsWith('spotify:track:') ? uri.slice('spotify:track:'.length) : null;
    const playedAtMs = Date.parse(timestamp);
    if (!trackId || !Number.isFinite(playedAtMs)) {
      skipped++;
      continue;
    }

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
      const artistId = `${NAME_KEY_PREFIX}${artistName}`;
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
  };
}

/** Default for `match_window_s`: how far apart an export record and a polled play of the same track can be and still be one listen. */
export const DEFAULT_MATCH_WINDOW_S = 600;

interface Classified {
  stored: boolean;
  /** The nearest polled play of the same track inside the window, if any. */
  polledMs: number | null;
}

/**
 * Sort a chunk's plays into exact repeats and plays already captured by the
 * poller, in one read.
 *
 * Exact repeats are what a re-run of the same export produces, and the primary
 * key would ignore them anyway. Polled plays need the window: `played_at` is
 * stored to the millisecond and `ts` only to the second, and the two are not
 * documented to mark the same instant of a listen, so the same listen never
 * shares a key across the two sources. Only `api` rows are matched by window;
 * two export rows near each other are separate listens the export recorded.
 */
async function classify(env: Env, plays: ImportRows['plays'], windowMs: number): Promise<Classified[]> {
  // The nearest polled play on each side, each one index seek on
  // (track_id, played_at_ms); the closer of the two is picked below.
  const nearest = (aggregate: 'MAX' | 'MIN', bounds: string) =>
    `(SELECT ${aggregate}(p.played_at_ms) FROM plays p
       WHERE c.track_id = p.track_id AND p.source = 'api' AND p.played_at_ms ${bounds})`;
  const query = await env.DB.prepare(
    `WITH c AS (
       SELECT key, json_extract(value, '$[0]') AS played_at_ms, json_extract(value, '$[1]') AS track_id
         FROM json_each(?1))
     SELECT
        EXISTS (SELECT 1 FROM plays p WHERE p.played_at_ms = c.played_at_ms AND p.track_id = c.track_id) AS stored,
        ${nearest('MAX', 'BETWEEN c.played_at_ms - ?2 AND c.played_at_ms')} AS before_ms,
        ${nearest('MIN', 'BETWEEN c.played_at_ms AND c.played_at_ms + ?2')} AS after_ms
       FROM c
      ORDER BY c.key`,
  )
    .bind(JSON.stringify(plays.map((play) => [play.played_at_ms, play.track_id])), windowMs)
    .all<{ stored: number; before_ms: number | null; after_ms: number | null }>();

  return query.results.map((row, i) => {
    const at = plays[i]!.played_at_ms;
    const candidates = windowMs > 0 ? [row.before_ms, row.after_ms].filter((ms): ms is number => ms !== null) : [];
    const polledMs = candidates.sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0] ?? null;
    return { stored: row.stored === 1, polledMs };
  });
}

/** Narrow row sets to the given plays, dropping tracks and artists only they referenced. */
export function keepPlays(rows: ImportRows, plays: ImportRows['plays']): ImportRows {
  const trackIds = new Set(plays.map((play) => play.track_id));
  const trackArtists = rows.trackArtists.filter((link) => trackIds.has(link.track_id));
  const artistIds = new Set(trackArtists.map((link) => link.artist_id));
  return {
    plays,
    tracks: rows.tracks.filter((track) => trackIds.has(track.track_id)),
    artists: rows.artists.filter((artist) => artistIds.has(artist.artist_id)),
    trackArtists,
    skipped: rows.skipped,
  };
}

/**
 * Import one chunk of export records (R10).
 *
 * A record is left out when the same (played_at_ms, track_id) is already
 * stored, or when a polled play of the same track lies within
 * `match_window_s` seconds of it (see classify). Everything else is written
 * with the same INSERT OR IGNORE path as the poller.
 *
 * `dry_run=1` writes nothing and returns the timestamp of every play that
 * would be inserted, plus how far each matched polled play was from its export
 * record, so a client can say where the gaps are and check the window.
 *
 * The export carries artist *names* but no Spotify ids, so artists are stored
 * under a `name:<artist name>` key (see NAME_KEY_PREFIX). That is enough for
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
    windowMs = intParam(url, 'match_window_s', DEFAULT_MATCH_WINDOW_S, 0, 3600) * 1000;
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

  const all = normalizeExport(records);
  const classified = all.plays.length > 0 ? await classify(env, all.plays, windowMs) : [];
  const fresh: ImportRows['plays'] = [];
  const polledOffsetsMs: number[] = [];
  let duplicates = 0;
  all.plays.forEach((play, i) => {
    const { stored, polledMs } = classified[i]!;
    if (stored) duplicates++;
    else if (polledMs !== null) polledOffsetsMs.push(polledMs - play.played_at_ms);
    else fresh.push(play);
  });
  const counts = {
    received: records.length,
    duplicates,
    matched_polled: polledOffsetsMs.length,
    skipped: all.skipped,
  };

  if (dryRun) {
    return json({
      dry_run: true,
      ...counts,
      new: fresh.length,
      new_plays_ms: fresh.map((play) => play.played_at_ms),
      // Polled minus export, in ms: positive when the poll's timestamp is later.
      polled_offsets_ms: polledOffsetsMs,
    });
  }

  const rows = keepPlays(all, fresh);
  if (rows.plays.length === 0) {
    return json({ ...counts, inserted: 0, rows_written: 0 });
  }

  const playStatements = buildInserts(env.DB, 'plays', ['played_at_ms', 'track_id', 'source'], rows.plays);
  const trackStatements = buildInserts(env.DB, 'tracks', ['track_id', 'name', 'first_seen_ms'], rows.tracks);

  const results = await env.DB.batch([
    // Anything stored since classify ran is ignored by the insert; counting
    // inside the batch keeps `inserted` exact all the same.
    countStoredPlays(env.DB, rows.plays),
    ...playStatements,
    ...trackStatements,
    ...buildInserts(env.DB, 'artists', ['artist_id', 'name'], rows.artists),
    ...buildInserts(env.DB, 'track_artists', ['track_id', 'artist_id', 'position'], rows.trackArtists),
    // Name keys just written for an artist the poller already knows by id are
    // redundant; fold them in rather than leaving a duplicate behind.
    ...reconcileNameKeyedArtists(env.DB),
    syncSearchIndex(env.DB, rows.tracks.map((track) => track.track_id)),
    ...songStatements(env.DB, rows.tracks.map((track) => track.track_id), rows.plays),
  ]);

  const raced = (results[0]?.results[0] as { n: number } | undefined)?.n ?? 0;
  const rowsWritten = results.reduce((total, result) => total + (result.meta?.rows_written ?? 0), 0);

  return json({
    ...counts,
    inserted: rows.plays.length - raced,
    duplicates: duplicates + raced,
    artists: rows.artists.length,
    track_artists: rows.trackArtists.length,
    // Real D1 row-write cost including index writes, so the client script can
    // pace itself against a daily ceiling (the Free plan's is 100,000).
    rows_written: rowsWritten,
  });
}
