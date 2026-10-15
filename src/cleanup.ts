import { json } from './api';
import { DUPLICATE_WINDOW_MS, type ExportRecord, exportKey, isShortRecord } from './import';
import { renumberSongsOf } from './play-numbers';
import type { Env } from './types';
import { MIN_PLAY_MS } from './wrapped';

/**
 * One-off repairs for export rows stored before the import learned to drop
 * them (scripts/clean-export.mjs drives both):
 *
 * - POST /admin/cleanup/overlaps: export copies of plays the poller also
 *   stored, a second or so apart (see DUPLICATE_WINDOW_MS). The poller's copy
 *   is kept: it has the context and the exact time.
 * - POST /admin/cleanup/skips: export records under MIN_PLAY_MS. The stored
 *   row doesn't say how long a play ran, so the export files themselves are
 *   sent back, a chunk at a time, to name them.
 * - POST /admin/cleanup/short-gaps: the same skips, guessed without the
 *   files, for when they are gone. A heuristic: see the route.
 *
 * Both report only unless `apply=1`. Removal goes through removeExportPlays,
 * which keeps every table derived from plays right.
 */

type Key = { played_at_ms: number; track_id: string };

const MAX_PAGE = 2000;
/** Widest gap the overlap report buckets, to show where the matches fall. */
const REPORT_WINDOW_MS = 30_000;
const GAP_BUCKETS_MS = [1_000, 2_000, 5_000, 10_000, REPORT_WINDOW_MS];

/**
 * Statements that delete these export plays and everything derived from them,
 * in one batch:
 *
 * - rollup_days and rollup_month_tracks follow by the plays delete trigger
 *   (migration 0014).
 * - play_numbers loses the plays' rows, and their songs are renumbered whole.
 * - tracks.first_seen_ms moves to the track's earliest remaining play.
 * - Every stats and Wrapped snapshot is dropped, to be recomputed on demand.
 *
 * Only `source = 'export'` rows are deleted, whatever the keys name.
 */
export function removeExportPlays(db: D1Database, keys: Key[]): D1PreparedStatement[] {
  if (keys.length === 0) return [];
  const pairs = JSON.stringify(keys.map((key) => [key.played_at_ms, key.track_id]));
  const trackIds = [...new Set(keys.map((key) => key.track_id))];
  const tracks = JSON.stringify(trackIds);
  const listed = `(played_at_ms, track_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))`;
  const earliest = '(SELECT MIN(p.played_at_ms) FROM plays p WHERE p.track_id = tracks.track_id)';
  return [
    db.prepare(
      `DELETE FROM play_numbers WHERE ${listed}
          AND EXISTS (SELECT 1 FROM plays p WHERE p.played_at_ms = play_numbers.played_at_ms
                                              AND p.track_id = play_numbers.track_id AND p.source = 'export')`,
    ).bind(pairs),
    db.prepare(`DELETE FROM plays WHERE source = 'export' AND ${listed}`).bind(pairs),
    ...renumberSongsOf(db, trackIds),
    db.prepare(
      `UPDATE tracks SET first_seen_ms = ${earliest}
        WHERE track_id IN (SELECT value FROM json_each(?1)) AND first_seen_ms < ${earliest}`,
    ).bind(tracks),
    db.prepare('DELETE FROM stats_snapshots'),
  ];
}

function pageSize(url: URL): number {
  const limit = Number(url.searchParams.get('limit') ?? 1000);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE) : 1000;
}

/**
 * POST /admin/cleanup/overlaps?apply=1&after=<ms>&after_track=<id>&limit=<n>
 *
 * One page of export plays, in key order after the cursor, with a play of the
 * same track from any other source within REPORT_WINDOW_MS. `gaps` counts them
 * by how far apart the two are, which is the evidence for
 * DUPLICATE_WINDOW_MS; only those within it are `matched`, and removed when
 * applying. Reads one pass over plays from the cursor on, plus one index seek
 * per export play, so the whole table is read once across all pages.
 */
export async function cleanupOverlapsRoute(env: Env, url: URL): Promise<Response> {
  const apply = url.searchParams.get('apply') === '1';
  const after = Number(url.searchParams.get('after') ?? -1);
  const afterTrack = url.searchParams.get('after_track') ?? '';
  const limit = pageSize(url);

  const { results } = await env.DB.prepare(
    `SELECT played_at_ms, track_id, gap FROM (
       SELECT e.played_at_ms, e.track_id,
              (SELECT MIN(ABS(o.played_at_ms - e.played_at_ms)) FROM plays o
                WHERE o.track_id = e.track_id AND o.source <> 'export'
                  AND o.played_at_ms BETWEEN e.played_at_ms - ?3 AND e.played_at_ms + ?3) AS gap
         FROM plays e
        WHERE e.source = 'export' AND (e.played_at_ms, e.track_id) > (?1, ?2))
      WHERE gap IS NOT NULL
      ORDER BY played_at_ms, track_id
      LIMIT ?4`,
  )
    .bind(Number.isFinite(after) ? after : -1, afterTrack, REPORT_WINDOW_MS, limit)
    .all<Key & { gap: number }>();

  const gaps: Record<string, number> = {};
  for (const bound of GAP_BUCKETS_MS) gaps[`<=${bound}`] = 0;
  for (const row of results) {
    const bound = GAP_BUCKETS_MS.find((b) => row.gap <= b)!;
    gaps[`<=${bound}`]!++;
  }

  const matched = results.filter((row) => row.gap <= DUPLICATE_WINDOW_MS);
  let removed = 0;
  if (apply && matched.length > 0) {
    await env.DB.batch(removeExportPlays(env.DB, matched));
    removed = matched.length;
  }

  const last = results.length === limit ? results[results.length - 1]! : null;
  return json({
    apply,
    window_ms: DUPLICATE_WINDOW_MS,
    examined: results.length,
    matched: matched.length,
    removed,
    gaps,
    // Pass both back as after / after_track for the next page; null when done.
    next: last ? { after: last.played_at_ms, after_track: last.track_id } : null,
  });
}

/**
 * POST /admin/cleanup/skips?apply=1 with a chunk of export records, as
 * /admin/import takes them.
 *
 * Names the stored export plays that these records show to be skips. A key
 * that also has a record long enough to count in the same chunk is kept.
 */
export async function cleanupSkipsRoute(env: Env, request: Request, url: URL): Promise<Response> {
  const apply = url.searchParams.get('apply') === '1';
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  const records = Array.isArray(body) ? (body as ExportRecord[]) : ((body as { records?: ExportRecord[] })?.records ?? null);
  if (!Array.isArray(records)) {
    return json({ error: 'Expected an array of records, or { "records": [...] }.' }, 400);
  }
  if (records.length > MAX_PAGE) {
    return json({ error: `Chunk too large; send at most ${MAX_PAGE} records per request.` }, 400);
  }

  const short = new Map<string, Key>();
  const counted = new Set<string>();
  for (const record of records) {
    const key = exportKey(record);
    if (!key) continue;
    const id = `${key.played_at_ms}:${key.track_id}`;
    if (isShortRecord(record)) short.set(id, key);
    else counted.add(id);
  }
  const candidates = [...short].filter(([id]) => !counted.has(id)).map(([, key]) => key);
  if (candidates.length === 0) return json({ apply, received: records.length, short: 0, stored: 0, removed: 0 });

  const { results: stored } = await env.DB.prepare(
    `SELECT p.played_at_ms, p.track_id FROM json_each(?1) j
       JOIN plays p ON p.played_at_ms = json_extract(j.value, '$[0]') AND p.track_id = json_extract(j.value, '$[1]')
      WHERE p.source = 'export'`,
  )
    .bind(JSON.stringify(candidates.map((key) => [key.played_at_ms, key.track_id])))
    .all<Key>();

  if (apply && stored.length > 0) await env.DB.batch(removeExportPlays(env.DB, stored));

  return json({
    apply,
    received: records.length,
    short: candidates.length,
    stored: stored.length,
    removed: apply ? stored.length : 0,
  });
}

/** Buckets for the short-gap report, up to MIN_PLAY_MS. */
const SHORT_GAP_BUCKETS_MS = [5_000, 10_000, 20_000, MIN_PLAY_MS];

/**
 * POST /admin/cleanup/short-gaps?apply=1&before=<ms>&before_track=<id>&limit=<n>
 *
 * One page of export plays that ended less than MIN_PLAY_MS after the play
 * before them (of any track, from any source), newest first, before the
 * cursor. A play's stored time is when it ended, so that gap is at most how
 * long it ran: a play this close to the one before cannot have counted.
 *
 * A heuristic, and a one-sided one. It never removes a play that ran 30 s or
 * more, but it misses a skip that followed a pause, since its gap includes
 * the pause. The export files, through /admin/cleanup/skips, are exact.
 *
 * Pages run newest first so that applying one never changes the gaps of the
 * next: a play's gap depends only on the plays before it.
 */
export async function cleanupShortGapsRoute(env: Env, url: URL): Promise<Response> {
  const apply = url.searchParams.get('apply') === '1';
  const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
  const beforeTrack = url.searchParams.get('before_track') ?? '';
  const limit = pageSize(url);

  const { results } = await env.DB.prepare(
    `SELECT played_at_ms, track_id, gap FROM (
       SELECT e.played_at_ms, e.track_id,
              e.played_at_ms - (SELECT MAX(q.played_at_ms) FROM plays q WHERE q.played_at_ms < e.played_at_ms) AS gap
         FROM plays e
        WHERE e.source = 'export' AND (e.played_at_ms, e.track_id) < (?1, ?2))
      WHERE gap < ?3
      ORDER BY played_at_ms DESC, track_id DESC
      LIMIT ?4`,
  )
    .bind(Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER, beforeTrack, MIN_PLAY_MS, limit)
    .all<Key & { gap: number }>();

  const gaps: Record<string, number> = {};
  for (const bound of SHORT_GAP_BUCKETS_MS) gaps[`<${bound}`] = 0;
  for (const row of results) gaps[`<${SHORT_GAP_BUCKETS_MS.find((b) => row.gap < b)!}`]!++;

  if (apply && results.length > 0) await env.DB.batch(removeExportPlays(env.DB, results));

  const last = results.length === limit ? results[results.length - 1]! : null;
  return json({
    apply,
    matched: results.length,
    removed: apply ? results.length : 0,
    gaps,
    // Pass both back as before / before_track for the next page; null when done.
    next: last ? { before: last.played_at_ms, before_track: last.track_id } : null,
  });
}
