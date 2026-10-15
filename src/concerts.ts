import { BadRequest, json, timeZoneParam } from './api';
import { startOfLocalDayUtcMs } from './tz';
import type { Env } from './types';

/**
 * Concert alerts: upcoming Ticketmaster events in the configured regions
 * (CONCERT_REGIONS), for the artists played most over the last year. Pull
 * only: a daily cron fills the `concerts` table and GET /api/concerts reads it.
 *
 * Each run fits the Free plan's 50 subrequests (Workers Paid allows 10,000),
 * so the check works on either plan. Names are matched to Ticketmaster
 * attractions once and the answer kept (no match too), so a run looks up at
 * most MAX_LOOKUPS names; then one events query per region covers every
 * matched artist at once, as `attractionId` takes a list.
 */

const API = 'https://app.ticketmaster.com/discovery/v2';
/** Artists considered: the most played primary artists over the last year. */
const TOP_ARTISTS = 80;
const LOOKBACK_MS = 365 * 86_400_000;
/** New names matched per run; the rest wait for the next day. */
const MAX_LOOKUPS = 25;
/** Re-check a match every quarter and a miss every month, as acts sign up and rename. */
const RECHECK_MATCHED_MS = 90 * 86_400_000;
const RECHECK_UNMATCHED_MS = 30 * 86_400_000;
/** Events per page is at most 200 on the Discovery API. */
const PAGE_SIZE = 200;
const MAX_PAGES = 3;
/** Ticketmaster allows five calls a second. */
const DEFAULT_SPACING_MS = 250;

/** Most regions a run checks, so a run stays inside the Free plan's 50 subrequests. */
const MAX_REGIONS = 5;

/** A place to look for concerts, and the Discovery API filter that finds it. */
export interface Region {
  key: string;
  label: string;
  query: Record<string, string>;
}

/** Thrown for a CONCERT_REGIONS setting that cannot be used, naming what is wrong. */
export class RegionConfigError extends Error {}

/**
 * The configured regions, from CONCERT_REGIONS: a JSON list where each entry
 * has a key, a label, and either a Ticketmaster `countryCode` (e.g. "GB") or
 * a `geoPoint` geohash with `radius` in km, e.g.
 *
 *   [{"key":"london","label":"London","geoPoint":"gcpvj","radius":50}]
 *
 * (geohash gcpvj is central London; 50 km takes in Wembley and the O2).
 * Unset means none, so the check has nothing to do.
 */
export function parseRegions(raw: string | undefined): Region[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RegionConfigError('CONCERT_REGIONS is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new RegionConfigError('CONCERT_REGIONS must be a JSON array');
  if (parsed.length > MAX_REGIONS) throw new RegionConfigError(`CONCERT_REGIONS holds at most ${MAX_REGIONS} regions`);
  const seen = new Set<string>();
  return parsed.map((entry: Record<string, unknown>, i): Region => {
    const where = `CONCERT_REGIONS[${i}]`;
    const { key, label, countryCode, geoPoint, radius } = entry ?? {};
    if (typeof key !== 'string' || !/^[a-z0-9-]{1,32}$/.test(key)) throw new RegionConfigError(`${where}.key must be 1-32 of a-z, 0-9, -`);
    if (seen.has(key)) throw new RegionConfigError(`${where}.key repeats "${key}"`);
    seen.add(key);
    if (typeof label !== 'string' || !label.trim()) throw new RegionConfigError(`${where}.label is required`);
    if (typeof countryCode === 'string' && /^[A-Z]{2}$/.test(countryCode) && geoPoint === undefined) {
      return { key, label, query: { countryCode } };
    }
    if (typeof geoPoint === 'string' && /^[0-9b-hjkmnp-z]{1,12}$/.test(geoPoint) && countryCode === undefined) {
      const km = Number(radius);
      if (!Number.isFinite(km) || km <= 0 || km > 500) throw new RegionConfigError(`${where}.radius must be 1 to 500 km`);
      return { key, label, query: { geoPoint, radius: String(km), unit: 'km' } };
    }
    throw new RegionConfigError(`${where} needs either a two-letter countryCode or a geoPoint geohash with a radius`);
  });
}

interface Attraction {
  id: string;
  name: string;
}

interface TmEvent {
  id: string;
  name: string;
  url?: string;
  dates?: { start?: { localDate?: string; localTime?: string }; status?: { code?: string } };
  _embedded?: {
    venues?: Array<{ name?: string; city?: { name?: string } }>;
    attractions?: Attraction[];
  };
}

interface TmPage<T> {
  _embedded?: T;
  page?: { totalPages?: number };
}

export interface ConcertCheckResult {
  skipped?: string;
  artists: number;
  looked_up: number;
  matched: number;
  regions: Record<string, { events: number } | { error: string }>;
}

/** Case, accents, `&` and spacing don't stop "Beyoncé" matching "Beyonce". */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim();
}

class Ticketmaster {
  private last = 0;

  constructor(
    private readonly key: string,
    private readonly spacingMs: number,
  ) {}

  async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const wait = this.last + this.spacingMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.last = Date.now();
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries({ ...params, apikey: this.key })) url.searchParams.set(key, value);
    const response = await fetch(url);
    // The key is in the URL, so errors name the path only.
    if (!response.ok) throw new Error(`Ticketmaster ${path}: ${response.status}`);
    return (await response.json()) as T;
  }
}

/** The best exact-name music attraction, or null. Ticketmaster ranks by relevance. */
async function matchAttraction(tm: Ticketmaster, name: string): Promise<Attraction | null> {
  const body = await tm.get<TmPage<{ attractions?: Attraction[] }>>('/attractions.json', {
    keyword: name,
    classificationName: 'music',
    size: '20',
  });
  const wanted = normalizeName(name);
  return body._embedded?.attractions?.find((a) => normalizeName(a.name) === wanted) ?? null;
}

async function topArtists(env: Env, now: number): Promise<Array<{ key: string; name: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT lower(a.name) AS key, max(a.name) AS name, COUNT(*) AS plays
       FROM plays p
       JOIN track_artists ta ON ta.track_id = p.track_id AND ta.position = 0
       JOIN artists a ON a.artist_id = ta.artist_id
      WHERE p.played_at_ms >= ?
      GROUP BY lower(a.name)
      ORDER BY plays DESC, key
      LIMIT ?`,
  )
    .bind(now - LOOKBACK_MS, TOP_ARTISTS)
    .all<{ key: string; name: string }>();
  return results;
}

/** Match names not yet matched, or matched too long ago; returns attraction id to artist name. */
async function resolveArtists(env: Env, tm: Ticketmaster, artists: Array<{ key: string; name: string }>, now: number) {
  const { results: known } = await env.DB.prepare(
    'SELECT name_key, attraction_id, checked_ms, pinned FROM concert_artists WHERE name_key IN (SELECT value FROM json_each(?))',
  )
    .bind(JSON.stringify(artists.map((a) => a.key)))
    .all<{ name_key: string; attraction_id: string | null; checked_ms: number; pinned: number }>();
  const byKey = new Map(known.map((row) => [row.name_key, row]));

  const due = artists.filter(({ key }) => {
    const row = byKey.get(key);
    if (!row) return true;
    if (row.pinned) return false;
    return now - row.checked_ms > (row.attraction_id ? RECHECK_MATCHED_MS : RECHECK_UNMATCHED_MS);
  });

  const writes: D1PreparedStatement[] = [];
  let lookedUp = 0;
  for (const artist of due.slice(0, MAX_LOOKUPS)) {
    let match: Attraction | null;
    try {
      match = await matchAttraction(tm, artist.name);
    } catch (error) {
      // Most likely the rate limit: keep what was learnt and stop for today.
      console.error('concerts: lookup failed', artist.name, (error as Error).message);
      break;
    }
    lookedUp++;
    byKey.set(artist.key, { name_key: artist.key, attraction_id: match?.id ?? null, checked_ms: now, pinned: 0 });
    writes.push(
      env.DB.prepare(
        `INSERT INTO concert_artists (name_key, name, attraction_id, checked_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT (name_key) DO UPDATE SET name = excluded.name, attraction_id = excluded.attraction_id, checked_ms = excluded.checked_ms
         WHERE concert_artists.pinned = 0`,
      ).bind(artist.key, artist.name, match?.id ?? null, now),
    );
  }
  if (writes.length > 0) await env.DB.batch(writes);

  const attractions = new Map<string, string>();
  for (const artist of artists) {
    const id = byKey.get(artist.key)?.attraction_id;
    if (id) attractions.set(id, artist.name);
  }
  return { attractions, lookedUp };
}

async function fetchRegion(tm: Ticketmaster, region: Region, ids: string[]): Promise<TmEvent[]> {
  const events: TmEvent[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await tm.get<TmPage<{ events?: TmEvent[] }>>('/events.json', {
      ...region.query,
      attractionId: ids.join(','),
      classificationName: 'music',
      sort: 'date,asc',
      size: String(PAGE_SIZE),
      page: String(page),
    });
    events.push(...(body._embedded?.events ?? []));
    if (page + 1 >= (body.page?.totalPages ?? 0)) break;
  }
  return events;
}

/** Store a region's events, then drop the ones Ticketmaster no longer lists (past, cancelled, removed). */
async function storeRegion(env: Env, region: string, events: TmEvent[], attractions: Map<string, string>, now: number) {
  const statements = events.map((event) => {
    const billed = event._embedded?.attractions ?? [];
    const ours = billed.filter((a) => attractions.has(a.id)).map((a) => attractions.get(a.id)!);
    const venue = event._embedded?.venues?.[0];
    return env.DB.prepare(
      `INSERT INTO concerts (event_id, region, artists, name, local_date, local_time, venue, city, status, url, first_seen_ms, last_seen_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id, region) DO UPDATE SET
         artists = excluded.artists, name = excluded.name, local_date = excluded.local_date,
         local_time = excluded.local_time, venue = excluded.venue, city = excluded.city,
         status = excluded.status, url = excluded.url, last_seen_ms = excluded.last_seen_ms`,
    ).bind(
      event.id,
      region,
      (ours.length > 0 ? ours : billed.map((a) => a.name)).join(', '),
      event.name,
      event.dates?.start?.localDate ?? null,
      event.dates?.start?.localTime?.slice(0, 5) ?? null,
      venue?.name ?? null,
      venue?.city?.name ?? null,
      event.dates?.status?.code ?? null,
      event.url ?? null,
      now,
      now,
    );
  });
  await env.DB.batch([
    ...statements,
    env.DB.prepare('DELETE FROM concerts WHERE region = ? AND last_seen_ms < ?').bind(region, now),
    env.DB.prepare(
      'INSERT INTO concert_runs (region, checked_ms) VALUES (?, ?) ON CONFLICT (region) DO UPDATE SET checked_ms = excluded.checked_ms',
    ).bind(region, now),
  ]);
}

export async function runConcertCheck(
  env: Env,
  options: { now?: number; spacingMs?: number } = {},
): Promise<ConcertCheckResult> {
  const now = options.now ?? Date.now();
  const result: ConcertCheckResult = { artists: 0, looked_up: 0, matched: 0, regions: {} };
  if (!env.TICKETMASTER_API_KEY) return { ...result, skipped: 'TICKETMASTER_API_KEY is not set' };
  const regions = parseRegions(env.CONCERT_REGIONS);
  // Rows for a region taken out of the settings would otherwise linger forever.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM concerts WHERE region NOT IN (SELECT value FROM json_each(?))').bind(JSON.stringify(regions.map((r) => r.key))),
    env.DB.prepare('DELETE FROM concert_runs WHERE region NOT IN (SELECT value FROM json_each(?))').bind(JSON.stringify(regions.map((r) => r.key))),
  ]);
  if (regions.length === 0) return { ...result, skipped: 'CONCERT_REGIONS is not set' };

  const tm = new Ticketmaster(env.TICKETMASTER_API_KEY, options.spacingMs ?? DEFAULT_SPACING_MS);
  const artists = await topArtists(env, now);
  const { attractions, lookedUp } = await resolveArtists(env, tm, artists, now);
  Object.assign(result, { artists: artists.length, looked_up: lookedUp, matched: attractions.size });

  for (const region of regions) {
    try {
      // With nobody matched there is nothing to list, and an empty attractionId would list everything.
      const events = attractions.size > 0 ? await fetchRegion(tm, region, [...attractions.keys()]) : [];
      await storeRegion(env, region.key, events, attractions, now);
      result.regions[region.key] = { events: events.length };
    } catch (error) {
      // A failed region keeps yesterday's rows rather than being emptied.
      result.regions[region.key] = { error: (error as Error).message };
    }
  }
  return result;
}

/** POST /admin/concert-check?spacingMs= */
export async function concertCheckRoute(env: Env, url: URL): Promise<Response> {
  const spacing = Number(url.searchParams.get('spacingMs') ?? DEFAULT_SPACING_MS);
  if (!Number.isInteger(spacing) || spacing < 0 || spacing > 5000) throw new BadRequest('spacingMs must be 0 to 5000');
  return json(await runConcertCheck(env, { spacingMs: spacing }));
}

/** GET /api/concerts?region=&since=&tz= */
export async function concertsRoute(env: Env, url: URL): Promise<Response> {
  const regions = parseRegions(env.CONCERT_REGIONS);
  const region = url.searchParams.get('region');
  if (region !== null && !regions.some((r) => r.key === region)) {
    throw new BadRequest(regions.length ? `region must be one of ${regions.map((r) => r.key).join(', ')}` : 'no concert regions are configured');
  }
  const since = url.searchParams.get('since');
  let sinceMs = 0;
  if (since !== null) {
    try {
      sinceMs = startOfLocalDayUtcMs(since, timeZoneParam(url));
    } catch (error) {
      if (error instanceof BadRequest) throw error;
      throw new BadRequest('since must be a YYYY-MM-DD date');
    }
  }

  const [concerts, runs] = await env.DB.batch([
    env.DB.prepare(
      `SELECT region, local_date AS date, local_time AS time, artists, name, venue, city, status, url, first_seen_ms
         FROM concerts
        WHERE (?1 IS NULL OR region = ?1) AND first_seen_ms >= ?2
          AND region IN (SELECT value FROM json_each(?3))
        ORDER BY local_date IS NULL, local_date, local_time, name`,
    ).bind(region, sinceMs, JSON.stringify(regions.map((r) => r.key))),
    env.DB.prepare('SELECT region, checked_ms FROM concert_runs'),
  ]);
  const checked = Object.fromEntries(
    (runs!.results as Array<{ region: string; checked_ms: number }>).map((run) => [run.region, new Date(run.checked_ms).toISOString()]),
  );
  // `regions` names each key, so a client can label results without knowing
  // this deployment's places.
  return json({
    regions: regions.map(({ key, label }) => ({ key, label })),
    checked,
    concerts: (concerts!.results as Array<Record<string, unknown> & { first_seen_ms: number }>).map(({ first_seen_ms, ...rest }) => ({
      ...rest,
      first_seen: new Date(first_seen_ms).toISOString(),
    })),
  });
}

/**
 * PUT /admin/concert-artists  { "name": "Kanye West", "attraction_id": "K8vZ9175Oy7" | null }
 *
 * Pin a name to a Ticketmaster attraction when the exact-name match can't find
 * it (an act that renamed), or to null to block a wrong match. The next check
 * uses it; nothing re-matches a pinned name. DELETE with the same name unpins.
 */
export async function pinConcertArtistRoute(env: Env, request: Request): Promise<Response> {
  let body: { name?: unknown; attraction_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new BadRequest('Body must be JSON: { "name": "...", "attraction_id": "..." | null }');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 200) throw new BadRequest('name is required');
  if (request.method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM concert_artists WHERE name_key = lower(?) AND pinned = 1').bind(name).run();
    return json({ name, unpinned: (result.meta.changes ?? 0) > 0 });
  }
  const id = body.attraction_id;
  if (id !== null && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    throw new BadRequest('attraction_id must be a Ticketmaster attraction id, or null to block the name');
  }
  await env.DB.prepare(
    `INSERT INTO concert_artists (name_key, name, attraction_id, checked_ms, pinned) VALUES (lower(?1), ?1, ?2, ?3, 1)
     ON CONFLICT (name_key) DO UPDATE SET name = excluded.name, attraction_id = excluded.attraction_id,
       checked_ms = excluded.checked_ms, pinned = 1`,
  )
    .bind(name, id, Date.now())
    .run();
  return json({ name, attraction_id: id, pinned: true });
}

/** GET /admin/concert-artists?unmatched=1 — what each name matched, pins first. */
export async function concertArtistsRoute(env: Env, url: URL): Promise<Response> {
  const unmatched = url.searchParams.get('unmatched') === '1';
  const { results } = await env.DB.prepare(
    `SELECT name, attraction_id, pinned = 1 AS pinned, checked_ms FROM concert_artists
      WHERE ?1 = 0 OR attraction_id IS NULL ORDER BY pinned DESC, lower(name)`,
  )
    .bind(unmatched ? 1 : 0)
    .all<{ name: string; attraction_id: string | null; pinned: number; checked_ms: number }>();
  return json({
    artists: results.map(({ checked_ms, pinned, ...row }) => ({
      ...row,
      pinned: pinned === 1,
      checked: new Date(checked_ms).toISOString(),
    })),
  });
}
