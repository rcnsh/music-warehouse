import { SpotifyError, spotifyGet } from './spotify';

/**
 * Names for the contexts plays were started from (migration 0013).
 *
 * Albums and artists are named from the local tables when a poll first sees
 * them. Anything else waits in `contexts` with no fetched_ms, and each poll
 * asks Spotify about a few, oldest first, so the warehouse's whole backlog
 * drains without one poll spending many subrequests.
 *
 * Spotify answers 404 to third-party apps for many editorial and algorithmic
 * playlists, and development-mode apps get 403 from some catalog endpoints.
 * Those refusals are stored as a NULL name and asked again only after
 * RETRY_UNNAMED_MS. Playlists are renamed often, so a named one is refreshed
 * after REFRESH_PLAYLIST_MS, keeping its old name if the refresh fails.
 */

/** At most this many Spotify lookups per poll; each is one subrequest. */
export const LOOKUPS_PER_POLL = 3;
const RETRY_UNNAMED_MS = 30 * 86_400_000;
const REFRESH_PLAYLIST_MS = 7 * 86_400_000;

/** SQL naming `uri` from the local album or artist tables, or NULL. */
const localName = (uri: string) =>
  `CASE WHEN ${uri} LIKE 'spotify:album:%' THEN (SELECT name FROM albums WHERE album_id = substr(${uri}, 15))
        WHEN ${uri} LIKE 'spotify:artist:%' THEN (SELECT name FROM artists WHERE artist_id = substr(${uri}, 16)) END`;

/**
 * Record contexts a write has just seen, naming albums and artists from the
 * local tables (so it runs after their inserts). Existing rows are left as
 * they are. Must match the backfill in migration 0013.
 */
export function insertContexts(
  db: D1Database,
  plays: Array<{ context_uri: string | null; context_type: string | null }>,
  now: number,
): D1PreparedStatement[] {
  const seen = new Map<string, string | null>();
  for (const play of plays) if (play.context_uri) seen.set(play.context_uri, play.context_type);
  if (seen.size === 0) return [];
  return [
    db
      .prepare(
        `INSERT INTO contexts (uri, type, name, fetched_ms)
         SELECT uri, type, name, CASE WHEN name IS NULL THEN NULL ELSE ?2 END
           FROM (SELECT json_extract(j.value, '$[0]') AS uri, json_extract(j.value, '$[1]') AS type,
                        ${localName("json_extract(j.value, '$[0]')")} AS name
                   FROM json_each(?1) j)
          WHERE true
         ON CONFLICT(uri) DO NOTHING`,
      )
      .bind(JSON.stringify([...seen]), now),
  ];
}

/** The Spotify API path that names a context, or null when there is none. */
export function lookupPath(uri: string): string | null {
  const match = /^spotify:(playlist|album|artist|show|audiobook):([A-Za-z0-9]+)$/.exec(uri);
  if (!match) return null;
  const [, type, id] = match;
  // `fields` keeps a playlist's tracks out of the response.
  return type === 'playlist' ? `/playlists/${id}?fields=name` : `/${type}s/${id}`;
}

interface Due {
  uri: string;
  name: string | null;
  local: string | null;
}

/**
 * Name up to LOOKUPS_PER_POLL contexts that are due. Stops early on a rate
 * limit or a dead grant, leaving the rest for a later poll. Returns how many
 * rows it settled.
 */
export async function nameContexts(db: D1Database, accessToken: string, now: number): Promise<number> {
  const due = await db
    .prepare(
      `SELECT uri, name, ${localName('uri')} AS local FROM contexts
        WHERE fetched_ms IS NULL
           OR (name IS NULL AND fetched_ms < ?1)
           OR (name IS NOT NULL AND type = 'playlist' AND fetched_ms < ?2)
        ORDER BY fetched_ms IS NOT NULL, fetched_ms
        LIMIT ?3`,
    )
    .bind(now - RETRY_UNNAMED_MS, now - REFRESH_PLAYLIST_MS, LOOKUPS_PER_POLL)
    .all<Due>();

  const settled: Array<[string, string | null]> = [];
  for (const row of due.results) {
    if (row.local !== null) {
      settled.push([row.uri, row.local]);
      continue;
    }
    const path = lookupPath(row.uri);
    if (path === null) {
      settled.push([row.uri, row.name]);
      continue;
    }
    try {
      const body = (await spotifyGet(accessToken, path)) as { name?: unknown } | null;
      settled.push([row.uri, typeof body?.name === 'string' && body.name ? body.name : row.name]);
    } catch (error) {
      // A refusal is an answer, and is kept. Anything else (a rate limit, a
      // dead grant, an outage) may pass, so this row and the rest stay due.
      if (error instanceof SpotifyError && (error.status === 404 || error.status === 403 || error.status === 400)) {
        settled.push([row.uri, row.name]);
        continue;
      }
      break;
    }
  }

  if (settled.length > 0) {
    await db
      .prepare(
        `UPDATE contexts SET name = json_extract(j.value, '$[1]'), fetched_ms = ?2
           FROM json_each(?1) j WHERE contexts.uri = json_extract(j.value, '$[0]')`,
      )
      .bind(JSON.stringify(settled), now)
      .run();
  }
  return settled.length;
}
