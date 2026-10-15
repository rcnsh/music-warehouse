import { beforeParam, dateRange, filterTrackIds, intParam, playFilterParams, selectPlays, timeZoneParam } from './api';
import type { Env } from './types';

/**
 * GET /api/plays.csv: the plays /api/plays would list, every page of them,
 * as one CSV download.
 *
 * Rows are streamed a page at a time, so the Worker never holds more than one
 * page however long the history. Each page is one D1 query: the Workers Paid
 * plan allows 1,000 per request (the Free plan 50), so at 2,000 rows a page
 * one download can reach two million plays (100k on Free).
 */

const PAGE_ROWS = 2000;
const COLUMNS = ['played_at', 'track', 'artists', 'album', 'track_id', 'context_uri', 'context_name', 'source'] as const;

/** RFC 4180: quote a field holding a comma, quote or line break, doubling its quotes. */
export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvLine = (fields: unknown[]) => `${fields.map(csvField).join(',')}\r\n`;

interface Row {
  played_at_ms: number;
  track_id: string;
  track_name: string | null;
  artists: string | null;
  album_name: string | null;
  context_uri: string | null;
  context_name: string | null;
  source: string;
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
      const page = await selectPlays(env, ids, cursor, lower, PAGE_ROWS);
      const rows = page.results as unknown as Row[];
      let chunk = '';
      for (const row of rows) {
        chunk += csvLine([
          new Date(row.played_at_ms).toISOString(),
          row.track_name,
          row.artists,
          row.album_name,
          row.track_id,
          row.context_uri,
          row.context_name,
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
