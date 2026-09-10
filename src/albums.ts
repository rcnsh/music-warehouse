import { json } from './api';
import { MAX_BOUND_PARAMS, buildInserts } from './db';
import { pickImageUrl } from './normalize';
import { appAccessToken, spotifyGet } from './spotify';
import { getAccessToken } from './tokens';
import { readState } from './db';
import type { Env, SpotifyAlbum, SpotifyTrack } from './types';

/**
 * Backfill album art for tracks the export could only name.
 *
 * The export carries an album *name* but no album id, and the catalog
 * endpoints keyed by id (/v1/albums, /v1/tracks) return 403 to apps in
 * Spotify's development mode. The way through is that every TrackObject the
 * API returns embeds a SimplifiedAlbumObject — id, name, release_date and
 * images — so any user-scoped endpoint that hands back tracks also hands back
 * cover art, no catalog access required.
 *
 * Three such sources, in descending coverage:
 *   `saved`  — /me/tracks, the whole Liked Songs library, offset-paged.
 *   `albums` — /me/albums, Saved Albums, whose track lists map many ids at once.
 *   `top`    — /me/top/tracks, roughly 50 per time range, but needs no scope
 *              beyond the one ingestion already holds.
 *
 * None is exhaustive: a track played twice in 2021 and never saved appears in
 * none of them, and nothing user-scoped will ever mention it.
 */

export const SOURCES = ['saved', 'top', 'albums'] as const;
export type AlbumSource = (typeof SOURCES)[number];

export const TIME_RANGES = ['short_term', 'medium_term', 'long_term'] as const;

/** Spotify's paging ceiling for all three sources. */
const PAGE_SIZE = 50;
const DEFAULT_PAGES = 4;
const MAX_PAGES = 20;

export interface AlbumCandidate {
  track_id: string;
  album: SpotifyAlbum;
  duration_ms: number | null;
  isrc: string | null;
}

interface SavedTrackPage {
  items?: Array<{ track?: SpotifyTrack | null } | null> | null;
  total?: number | null;
}
interface TopTrackPage {
  items?: Array<SpotifyTrack | null> | null;
  total?: number | null;
}
interface SavedAlbumPage {
  items?: Array<{
    album?: (SpotifyAlbum & { tracks?: { items?: Array<SpotifyTrack | null> | null } | null }) | null;
  } | null> | null;
  total?: number | null;
}

function candidateFrom(track: SpotifyTrack | null | undefined, album: SpotifyAlbum | null | undefined): AlbumCandidate | null {
  if (!track?.id || !album?.id) return null;
  return {
    track_id: track.id,
    album,
    duration_ms: track.duration_ms ?? null,
    isrc: track.external_ids?.isrc ?? null,
  };
}

/**
 * Flatten one page of any of the three sources into track→album pairs.
 *
 * Pure, so the differing envelope of each source is testable without a network.
 * `total` is Spotify's count for the collection, used only to decide when the
 * walk is finished.
 */
export function extractCandidates(
  source: AlbumSource,
  payload: unknown,
): { candidates: AlbumCandidate[]; itemCount: number; total: number | null } {
  const candidates: AlbumCandidate[] = [];
  let itemCount = 0;
  let total: number | null = null;

  if (source === 'saved') {
    const page = (payload ?? {}) as SavedTrackPage;
    total = page.total ?? null;
    for (const item of page.items ?? []) {
      itemCount++;
      const candidate = candidateFrom(item?.track, item?.track?.album);
      if (candidate) candidates.push(candidate);
    }
  } else if (source === 'top') {
    const page = (payload ?? {}) as TopTrackPage;
    total = page.total ?? null;
    for (const track of page.items ?? []) {
      itemCount++;
      const candidate = candidateFrom(track, track?.album);
      if (candidate) candidates.push(candidate);
    }
  } else {
    const page = (payload ?? {}) as SavedAlbumPage;
    total = page.total ?? null;
    for (const item of page.items ?? []) {
      itemCount++;
      const album = item?.album;
      // A saved album maps many track ids to one cover in a single item.
      for (const track of album?.tracks?.items ?? []) {
        const candidate = candidateFrom(track, album);
        if (candidate) candidates.push(candidate);
      }
    }
  }

  return { candidates, itemCount, total };
}

function pageUrl(source: AlbumSource, offset: number, range: string): string {
  if (source === 'saved') return `/me/tracks?limit=${PAGE_SIZE}&offset=${offset}`;
  if (source === 'albums') return `/me/albums?limit=${PAGE_SIZE}&offset=${offset}`;
  return `/me/top/tracks?time_range=${range}&limit=${PAGE_SIZE}&offset=${offset}`;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Walk one slice of one source and fill in whatever albums it reveals.
 *
 * Only tracks already in `plays` history get touched: a Liked Song never
 * actually played has no row here, and inventing one would put a track in the
 * warehouse that was never listened to.
 */
export async function backfillAlbums(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requestedSource = url.searchParams.get('source') ?? 'saved';
  if (!SOURCES.includes(requestedSource as AlbumSource)) {
    return json({ error: `source must be one of ${SOURCES.join(', ')}` }, 400);
  }
  const source = requestedSource as AlbumSource;

  const requestedRange = url.searchParams.get('range') ?? 'long_term';
  const range = (TIME_RANGES as readonly string[]).includes(requestedRange) ? requestedRange : 'long_term';
  const startOffset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const pages = clampInt(url.searchParams.get('pages'), DEFAULT_PAGES, 1, MAX_PAGES);

  const { token } = await readState(env.DB);
  const accessToken = await getAccessToken(env.DB, env, token, Date.now());

  const candidates = new Map<string, AlbumCandidate>();
  let offset = startOffset;
  let total: number | null = null;
  let exhausted = false;

  for (let page = 0; page < pages; page++) {
    const payload = await spotifyGet(accessToken, pageUrl(source, offset, range));
    const extracted = extractCandidates(source, payload);
    total = extracted.total ?? total;

    for (const candidate of extracted.candidates) {
      if (!candidates.has(candidate.track_id)) candidates.set(candidate.track_id, candidate);
    }

    offset += extracted.itemCount;
    // A short page is the end of the collection; Spotify sends no more.
    if (extracted.itemCount < PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }

  // Which of these do we actually have plays for, and still lack an album on?
  const ids = [...candidates.keys()];
  const needing = new Set<string>();
  for (let start = 0; start < ids.length; start += MAX_BOUND_PARAMS) {
    const chunk = ids.slice(start, start + MAX_BOUND_PARAMS);
    const query = await env.DB.prepare(
      `SELECT track_id FROM tracks
        WHERE album_id IS NULL AND track_id IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(...chunk)
      .all<{ track_id: string }>();
    for (const row of query.results ?? []) needing.add(row.track_id);
  }

  const matched = [...needing].map((id) => candidates.get(id)!);

  // Only albums we are about to reference, so the dimension stays free of rows
  // for music that was never played.
  const albums = new Map<string, { album_id: string; name: string; release_date: string | null; image_url: string | null }>();
  for (const candidate of matched) {
    const id = candidate.album.id!;
    if (albums.has(id)) continue;
    albums.set(id, {
      album_id: id,
      name: candidate.album.name ?? '',
      release_date: candidate.album.release_date ?? null,
      image_url: pickImageUrl(candidate.album.images),
    });
  }

  let tracksUpdated = 0;
  let rowsWritten = 0;

  if (matched.length > 0) {
    const statements = [
      ...buildInserts(env.DB, 'albums', ['album_id', 'name', 'release_date', 'image_url'], [...albums.values()]),
      ...matched.map((candidate) =>
        env.DB
          .prepare(
            `UPDATE tracks
                SET album_id    = ?,
                    duration_ms = COALESCE(duration_ms, ?),
                    isrc        = COALESCE(isrc, ?)
              WHERE track_id = ? AND album_id IS NULL`,
          )
          .bind(candidate.album.id, candidate.duration_ms, candidate.isrc, candidate.track_id),
      ),
    ];

    const results = await env.DB.batch(statements);
    for (const result of results) {
      rowsWritten += result.meta?.rows_written ?? 0;
    }
    tracksUpdated = matched.length;
  }

  return json({
    source,
    range: source === 'top' ? range : null,
    scanned: offset - startOffset,
    next_offset: offset,
    total,
    candidates: candidates.size,
    tracks_updated: tracksUpdated,
    albums_written: albums.size,
    rows_written: rowsWritten,
    done: exhausted || (total !== null && offset >= total),
  });
}

/**
 * Fill album art straight from the catalog, one track at a time.
 *
 * `GET /v1/tracks/{id}` is the one catalog endpoint still open to an app in
 * development mode — the batch forms it would be natural to reach for
 * (`/v1/tracks?ids=`, `/v1/albums?ids=`) both return 403. One request per
 * track is the cost of that, roughly 120ms each, which is cheap enough for the
 * few thousand tracks the user-scoped sources cannot reach.
 *
 * Paged by a cursor over `track_id` rather than by re-querying "still missing
 * an album": tracks Spotify 404s stay missing forever, and a not-yet-done
 * predicate would hand them back on every call and never terminate.
 */
export async function backfillFromCatalog(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('after') ?? '';
  const limit = clampInt(url.searchParams.get('limit'), 25, 1, 200);
  // Spacing is politeness, not a workaround: measured across two runs, a
  // development-mode app gets ~600 catalog requests before a 429, whether they
  // are fired at 8/s or at 2/s. What changes is the penalty — the second
  // breach returned Retry-After: 86088, almost exactly 24 hours — so this
  // looks like a daily quota rather than a rolling window. Do not raise the
  // rate expecting to finish sooner; there is nothing to outrun.
  const spacingMs = clampInt(url.searchParams.get('spacingMs'), 350, 0, 2000);

  const query = await env.DB.prepare(
    `SELECT track_id FROM tracks
      WHERE track_id > ? AND album_id IS NULL
      ORDER BY track_id LIMIT ?`,
  )
    .bind(cursor, limit)
    .all<{ track_id: string }>();

  const pending = (query.results ?? []).map((row) => row.track_id);
  if (pending.length === 0) {
    return json({ done: true, examined: 0, tracks_updated: 0, missing: 0, next_cursor: cursor, rows_written: 0 });
  }

  const { access_token: appToken } = await appAccessToken(env);

  const candidates: AlbumCandidate[] = [];
  let missing = 0;
  let examined = 0;
  let rateLimited = false;
  let retryAfterSeconds: number | null = null;

  for (const trackId of pending) {
    if (examined > 0 && spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));

    let response: Response;
    try {
      response = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${appToken}` },
      });
    } catch {
      // A transport failure mid-walk: keep what we have and let the cursor
      // stop here, rather than losing the whole batch.
      break;
    }

    // Stop on a rate limit but still write what this call already gathered.
    // Retry-After is the only thing that says how long the wait actually is —
    // Spotify has returned an hour here — so it has to reach the caller rather
    // than leaving it to guess with a blind exponential backoff.
    if (response.status === 429) {
      rateLimited = true;
      const header = response.headers.get('Retry-After');
      retryAfterSeconds =
        header !== null && header.trim() !== '' && Number.isFinite(Number(header)) ? Number(header) : null;
      break;
    }
    examined++;
    // 404 is a track withdrawn from the catalog. Nothing to fetch, ever.
    if (response.status === 404) {
      missing++;
      continue;
    }
    if (!response.ok) {
      missing++;
      continue;
    }

    const track = (await response.json()) as SpotifyTrack;
    const candidate = candidateFrom(track, track.album);
    if (candidate) candidates.push(candidate);
    else missing++;
  }

  const albums = new Map<string, { album_id: string; name: string; release_date: string | null; image_url: string | null }>();
  for (const candidate of candidates) {
    const id = candidate.album.id!;
    if (albums.has(id)) continue;
    albums.set(id, {
      album_id: id,
      name: candidate.album.name ?? '',
      release_date: candidate.album.release_date ?? null,
      image_url: pickImageUrl(candidate.album.images),
    });
  }

  let rowsWritten = 0;
  if (candidates.length > 0) {
    const results = await env.DB.batch([
      ...buildInserts(env.DB, 'albums', ['album_id', 'name', 'release_date', 'image_url'], [...albums.values()]),
      ...candidates.map((candidate) =>
        env.DB
          .prepare(
            `UPDATE tracks
                SET album_id    = ?,
                    duration_ms = COALESCE(duration_ms, ?),
                    isrc        = COALESCE(isrc, ?)
              WHERE track_id = ? AND album_id IS NULL`,
          )
          .bind(candidate.album.id, candidate.duration_ms, candidate.isrc, candidate.track_id),
      ),
    ]);
    for (const result of results) rowsWritten += result.meta?.rows_written ?? 0;
  }

  return json({
    // Advances past everything examined, resolved or not, so the walk ends.
    next_cursor: examined > 0 ? pending[examined - 1] : cursor,
    examined,
    tracks_updated: candidates.length,
    missing,
    albums_written: albums.size,
    rows_written: rowsWritten,
    rate_limited: rateLimited,
    retry_after_seconds: retryAfterSeconds,
    done: !rateLimited && pending.length < limit && examined === pending.length,
  });
}
