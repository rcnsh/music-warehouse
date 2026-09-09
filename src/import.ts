import { json } from './api';
import { NAME_KEY_PREFIX, buildInserts, reconcileNameKeyedArtists } from './db';
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

/**
 * Import one chunk of export records (R10).
 *
 * Uses the same INSERT OR IGNORE path as the poller against the same
 * (played_at_ms, track_id) primary key, so records that overlap already-polled
 * data are silently dropped instead of duplicated.
 *
 * The export carries artist *names* but no Spotify ids, so artists are stored
 * under a `name:<artist name>` key (see NAME_KEY_PREFIX). That is enough for
 * /api/top-artists to see export-era listening; it is not enough to reconcile
 * with id-keyed artists automatically, so a track that is also polled live has
 * its name-keyed link dropped in favour of the real one. Albums are skipped
 * entirely — `albums.album_id` has no name-keyed equivalent worth inventing.
 * See README, "Known limitations".
 */
export async function importChunk(env: Env, request: Request): Promise<Response> {
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
  if (rows.plays.length === 0) {
    return json({ received: records.length, inserted: 0, skipped: rows.skipped, rows_written: 0 });
  }

  const playStatements = buildInserts(env.DB, 'plays', ['played_at_ms', 'track_id', 'source'], rows.plays);
  const trackStatements = buildInserts(env.DB, 'tracks', ['track_id', 'name', 'first_seen_ms'], rows.tracks);

  const results = await env.DB.batch([
    ...playStatements,
    ...trackStatements,
    ...buildInserts(env.DB, 'artists', ['artist_id', 'name'], rows.artists),
    ...buildInserts(env.DB, 'track_artists', ['track_id', 'artist_id', 'position'], rows.trackArtists),
    // Name keys just written for an artist the poller already knows by id are
    // redundant; fold them in rather than leaving a duplicate behind.
    ...reconcileNameKeyedArtists(env.DB),
  ]);

  let inserted = 0;
  for (let i = 0; i < playStatements.length; i++) inserted += results[i]?.meta?.changes ?? 0;
  const rowsWritten = results.reduce((total, result) => total + (result.meta?.rows_written ?? 0), 0);

  return json({
    received: records.length,
    inserted,
    duplicates: rows.plays.length - inserted,
    skipped: rows.skipped,
    artists: rows.artists.length,
    track_artists: rows.trackArtists.length,
    // Real D1 row-write cost including index writes, so the client script can
    // pace itself against the 100,000/day free-plan ceiling.
    rows_written: rowsWritten,
  });
}
