import { WALK_ABOVE_TRACKS, beforeParam, dateRange, filterTrackIds, intParam, playFilterParams, timeZoneParam } from './api';
import type { Env } from './types';

/**
 * GET /api/plays.csv: the plays /api/plays would list, every page of them,
 * as one CSV download.
 *
 * Rows are streamed a page at a time, so the Worker never holds more than one
 * page however long the history. A page reads only the plays' own columns,
 * about one row per play. Each track's names and each context's name are
 * looked up the first time a page meets them and remembered for the rest of
 * the download, a few rows per distinct track rather than per play. The CSV
 * has no play numbers, art, ISRCs or durations, so nothing else is joined.
 * Contexts are written as stored, including the autoplay leftovers that
 * /api/plays reads as none (see CONTEXT_FITS).
 *
 * A page is at most two D1 calls, its plays and one batch of the names it
 * lacks. The Workers Paid plan allows 1,000 per request (the Free plan 50),
 * so at 10,000 rows a page one download can reach five million plays (about
 * 240k on Free). A page holds about 1 MB of rows and CSV in memory at once.
 */

const PAGE_ROWS = 10_000;
const COLUMNS = ['played_at', 'track', 'artists', 'album', 'track_id', 'context_uri', 'context_name', 'source'] as const;

/** RFC 4180: quote a field holding a comma, quote or line break, doubling its quotes. */
export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvLine = (fields: unknown[]) => `${fields.map(csvField).join(',')}\r\n`;

interface PlayRow {
  played_at_ms: number;
  track_id: string;
  context_uri: string | null;
  source: string;
}

interface TrackNames {
  name: string | null;
  album: string | null;
  /** Credited names in credit order, joined as /api/plays' `artists`; null with no credits. */
  artists: string | null;
}

/**
 * A page of plays, newest first, strictly below `upper` in primary-key order
 * and above `after`: selectPlays' paging and track filter, without its joins.
 */
function selectPage(env: Env, ids: string[] | null, upper: [number, string], after: number, limit: number) {
  if (ids === null) {
    return env.DB.prepare(
      `SELECT played_at_ms, track_id, context_uri, source FROM plays
        WHERE (played_at_ms, track_id) < (?, ?) AND played_at_ms > ?
        ORDER BY played_at_ms DESC, track_id DESC LIMIT ?`,
    )
      .bind(...upper, after, limit)
      .all<PlayRow>();
  }
  // As in selectPlays: past WALK_ABOVE_TRACKS tracks, walking the primary key
  // newest first finds a page sooner than seeking each track's plays.
  const trackTerm = ids.length > WALK_ABOVE_TRACKS ? '+track_id' : 'track_id';
  return env.DB.prepare(
    `SELECT played_at_ms, track_id, context_uri, source FROM plays
      WHERE ${trackTerm} IN (SELECT value FROM json_each(?))
        AND (played_at_ms, track_id) < (?, ?) AND played_at_ms > ?
      ORDER BY played_at_ms DESC, track_id DESC LIMIT ?`,
  )
    .bind(JSON.stringify(ids), ...upper, after, limit)
    .all<PlayRow>();
}

/**
 * Names for the page's tracks and contexts not met yet, in one call. A track
 * missing from the catalog gets null names, as the joins it replaces gave.
 */
async function lookUpNames(
  env: Env,
  rows: PlayRow[],
  tracks: Map<string, TrackNames>,
  contexts: Map<string, string | null>,
): Promise<void> {
  const newTracks = [...new Set(rows.map((row) => row.track_id))].filter((id) => !tracks.has(id));
  const newContexts = [...new Set(rows.flatMap((row) => (row.context_uri === null ? [] : [row.context_uri])))].filter(
    (uri) => !contexts.has(uri),
  );
  if (newTracks.length === 0 && newContexts.length === 0) return;
  const [trackResult, contextResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT j.value AS track_id, t.name, al.name AS album,
              (SELECT json_group_array(name)
                 FROM (SELECT a.name FROM track_artists ta JOIN artists a ON a.artist_id = ta.artist_id
                        WHERE ta.track_id = j.value ORDER BY ta.position)) AS artists
         FROM json_each(?) j
         LEFT JOIN tracks t  ON t.track_id = j.value
         LEFT JOIN albums al ON al.album_id = t.album_id`,
    ).bind(JSON.stringify(newTracks)),
    env.DB.prepare('SELECT uri, name FROM contexts WHERE uri IN (SELECT value FROM json_each(?))').bind(
      JSON.stringify(newContexts),
    ),
  ]);
  for (const row of trackResult!.results as Array<{ track_id: string; name: string | null; album: string | null; artists: string }>) {
    const names = JSON.parse(row.artists) as string[];
    tracks.set(row.track_id, { name: row.name, album: row.album, artists: names.length ? names.join(', ') : null });
  }
  for (const uri of newContexts) contexts.set(uri, null);
  for (const row of contextResult!.results as Array<{ uri: string; name: string | null }>) contexts.set(row.uri, row.name);
}

export async function playsCsvRoute(env: Env, url: URL): Promise<Response> {
  // Everything is validated before the first byte, so a bad parameter is
  // still a 400 rather than a broken download.
  // `before` takes /api/plays' next_before cursor as well as epoch-ms.
  let upper = beforeParam(url);
  const after = intParam(url, 'after', -1, -1, Number.MAX_SAFE_INTEGER);
  const filter = playFilterParams(url, { q: true });
  let lower = after;
  // Without from or to, the whole history; with either, a local-date range.
  if (url.searchParams.has('from') || url.searchParams.has('to')) {
    const { fromMs, toMs } = dateRange(url, timeZoneParam(url, env));
    if (toMs <= upper[0]) upper = [toMs, ''];
    lower = Math.max(lower, fromMs - 1);
  }
  const { ids } = await filterTrackIds(env, filter);

  let cursor = upper;
  let done = ids?.length === 0;
  const tracks = new Map<string, TrackNames>();
  const contexts = new Map<string, string | null>();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvLine([...COLUMNS])));
    },
    async pull(controller) {
      if (done) {
        controller.close();
        return;
      }
      const rows = (await selectPage(env, ids, cursor, lower, PAGE_ROWS)).results;
      await lookUpNames(env, rows, tracks, contexts);
      let chunk = '';
      for (const row of rows) {
        const track = tracks.get(row.track_id);
        chunk += csvLine([
          new Date(row.played_at_ms).toISOString(),
          track?.name,
          track?.artists,
          track?.album,
          row.track_id,
          row.context_uri,
          row.context_uri === null ? null : contexts.get(row.context_uri),
          row.source,
        ]);
      }
      if (chunk) controller.enqueue(encoder.encode(chunk));
      const last = rows.at(-1);
      if (rows.length < PAGE_ROWS || !last) done = true;
      else cursor = [last.played_at_ms, last.track_id];
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="plays.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
