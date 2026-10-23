import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { concertCheckStatus, normalizeName, retryAfterMs, runConcertCheck, topArtists } from '../src/concerts';
import { ensureRollup } from '../src/rollup';
import worker from '../src/index';
import { jsonResponse } from './helpers';

const BASE = 'https://warehouse.test';
const ADMIN = { Authorization: 'Bearer test-admin-token' };
const READ = { Authorization: 'Bearer test-read-token' };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 1, 23);

/** `count` plays of a track by `artist`, an hour apart, ending a day before NOW. */
async function seedArtist(artist: string, count: number) {
  const id = artist.toLowerCase().replace(/\W/g, '');
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO artists (artist_id, name) VALUES (?, ?)').bind(id, artist),
    env.DB.prepare('INSERT INTO tracks (track_id, name, first_seen_ms) VALUES (?, ?, ?)').bind(`t-${id}`, 'Song', NOW),
    env.DB.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind(`t-${id}`, id),
  ];
  for (let i = 0; i < count; i++) {
    statements.push(
      env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(NOW - DAY - i * 3_600_000, `t-${id}`, 'api'),
    );
  }
  await env.DB.batch(statements);
}

function event(id: string, attraction: { id: string; name: string }, date: string, city = 'Singapore') {
  return {
    id,
    name: `${attraction.name} Live`,
    url: `https://ticketmaster.test/${id}`,
    dates: { start: { localDate: date, localTime: '20:00:00' }, status: { code: 'onsale' } },
    _embedded: { venues: [{ name: 'National Stadium', city: { name: city } }], attractions: [attraction] },
  };
}

const KENDRICK = { id: 'K1', name: 'Kendrick Lamar' };

/** A fake Ticketmaster: attractions by exact keyword, events per region. */
function stubTicketmaster(events: { singapore?: unknown[]; london?: unknown[] }, attractions: Record<string, Array<{ id: string; name: string }>>) {
  const calls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(url);
      expect(url.searchParams.get('apikey')).toBe('test-tm-key');
      if (url.pathname.endsWith('/attractions.json')) {
        return jsonResponse({ _embedded: { attractions: attractions[url.searchParams.get('keyword')!] ?? [] } });
      }
      const list = url.searchParams.get('countryCode') === 'SG' ? events.singapore : events.london;
      return jsonResponse({ _embedded: { events: list ?? [] }, page: { totalPages: 1 } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('normalizeName', () => {
  it('ignores case, accents, & and spacing', () => {
    expect(normalizeName('Beyoncé')).toBe(normalizeName('BEYONCE'));
    expect(normalizeName('Simon  & Garfunkel')).toBe('simon and garfunkel');
  });
});

describe('concert check', () => {
  it('matches top artists by exact name and stores their events per region', async () => {
    await seedArtist('Kendrick Lamar', 5);
    await seedArtist('Porter Robinson', 3);
    const calls = stubTicketmaster(
      { singapore: [event('e1', KENDRICK, '2027-02-12')], london: [event('e2', KENDRICK, '2027-03-01', 'London')] },
      // A near-miss name must not match.
      { 'Kendrick Lamar': [KENDRICK], 'Porter Robinson': [{ id: 'P9', name: 'Porter Robinson Tribute' }] },
    );

    const result = await runConcertCheck(env, { now: NOW, spacingMs: 0 });
    expect(result).toEqual({ artists: 2, looked_up: 2, matched: 1, regions: { singapore: { events: 1 }, london: { events: 1 } } });
    const eventCalls = calls.filter((url) => url.pathname.endsWith('/events.json'));
    expect(eventCalls.map((url) => url.searchParams.get('attractionId'))).toEqual(['K1', 'K1']);
    expect(eventCalls[1]!.searchParams.get('geoPoint')).toBe('gcpvj');

    const response = await SELF.fetch(`${BASE}/api/concerts`, { headers: READ });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { checked: Record<string, string>; concerts: Array<Record<string, unknown>> };
    expect(Object.keys(body.checked).sort()).toEqual(['london', 'singapore']);
    expect(body.concerts).toEqual([
      {
        region: 'singapore',
        date: '2027-02-12',
        time: '20:00',
        artists: 'Kendrick Lamar',
        artist_list: [{ id: 'kendricklamar', name: 'Kendrick Lamar' }],
        name: 'Kendrick Lamar Live',
        venue: 'National Stadium',
        city: 'Singapore',
        status: 'onsale',
        url: 'https://ticketmaster.test/e1',
        first_seen: new Date(NOW).toISOString(),
      },
      expect.objectContaining({ region: 'london', date: '2027-03-01', city: 'London' }),
    ]);
  });

  it('lists each billed artist whole, with our id, or null for a name only Ticketmaster knows', async () => {
    await seedArtist('Tyler, The Creator', 5);
    // Export-era plays carry only a placeholder; the real id wins when both exist.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artists (artist_id, name) VALUES ('name:tyler, the creator', 'Tyler, The Creator')"),
      env.DB.prepare("INSERT INTO tracks (track_id, name, first_seen_ms) VALUES ('t-old', 'Old', ?)").bind(NOW),
      env.DB.prepare("INSERT INTO track_artists (track_id, artist_id, position) VALUES ('t-old', 'name:tyler, the creator', 0)"),
      env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, 't-old', 'import')").bind(NOW - 2 * DAY),
    ]);
    await seedArtist('Placeholder Only', 2);
    await env.DB.batch([
      env.DB.prepare("UPDATE artists SET artist_id = 'name:placeholder only' WHERE artist_id = 'placeholderonly'"),
      env.DB.prepare("UPDATE track_artists SET artist_id = 'name:placeholder only' WHERE artist_id = 'placeholderonly'"),
    ]);
    const tyler = { id: 'T1', name: 'Tyler, The Creator' };
    const placeholder = { id: 'P1', name: 'Placeholder Only' };
    const support = { id: 'S1', name: 'Support Act' };
    const both = event('e1', tyler, '2027-02-12');
    both._embedded.attractions = [tyler, support, placeholder];
    const theirs = event('e2', support, '2027-02-13');
    stubTicketmaster({ singapore: [both, theirs] }, { 'Tyler, The Creator': [tyler], 'Placeholder Only': [placeholder] });

    await runConcertCheck(env, { now: NOW, spacingMs: 0 });
    const body = (await (await SELF.fetch(`${BASE}/api/concerts?region=singapore`, { headers: READ })).json()) as {
      concerts: Array<{ artists: string; artist_list: Array<{ id: string | null; name: string }> | null }>;
    };
    expect(body.concerts.map(({ artists, artist_list }) => ({ artists, artist_list }))).toEqual([
      {
        artists: 'Tyler, The Creator, Placeholder Only',
        artist_list: [
          { id: 'tylerthecreator', name: 'Tyler, The Creator' },
          { id: 'name:placeholder only', name: 'Placeholder Only' },
        ],
      },
      { artists: 'Support Act', artist_list: [{ id: null, name: 'Support Act' }] },
    ]);
  });

  it('gives a null artist_list for a row stored before the list was', async () => {
    await env.DB.prepare(
      `INSERT INTO concerts (event_id, region, artists, name, first_seen_ms, last_seen_ms)
       VALUES ('old', 'singapore', 'Someone', 'Someone Live', ?, ?)`,
    )
      .bind(NOW, NOW)
      .run();
    const body = (await (await SELF.fetch(`${BASE}/api/concerts`, { headers: READ })).json()) as {
      concerts: Array<{ artists: string; artist_list: unknown }>;
    };
    expect(body.concerts).toEqual([expect.objectContaining({ artists: 'Someone', artist_list: null })]);
  });

  it('remembers matches, keeps first_seen, and drops events no longer listed', async () => {
    await seedArtist('Kendrick Lamar', 5);
    stubTicketmaster({ singapore: [event('e1', KENDRICK, '2027-02-12'), event('gone', KENDRICK, '2027-02-13')] }, { 'Kendrick Lamar': [KENDRICK] });
    await runConcertCheck(env, { now: NOW, spacingMs: 0 });

    vi.unstubAllGlobals();
    const calls = stubTicketmaster({ singapore: [event('e1', KENDRICK, '2027-02-12'), event('new', KENDRICK, '2027-05-01')] }, {});
    const result = await runConcertCheck(env, { now: NOW + DAY, spacingMs: 0 });
    // The match was kept, so no second lookup.
    expect(result.looked_up).toBe(0);
    expect(calls.some((url) => url.pathname.endsWith('/attractions.json'))).toBe(false);

    const all = (await (await SELF.fetch(`${BASE}/api/concerts?region=singapore`, { headers: READ })).json()) as {
      concerts: Array<{ url: string; first_seen: string }>;
    };
    expect(all.concerts.map((c) => [c.url.split('/').pop(), c.first_seen])).toEqual([
      ['e1', new Date(NOW).toISOString()],
      ['new', new Date(NOW + DAY).toISOString()],
    ]);
    // `since` is what is new: only the event first seen on the second day.
    const fresh = (await (await SELF.fetch(`${BASE}/api/concerts?since=2026-10-16&tz=UTC`, { headers: READ })).json()) as {
      concerts: Array<{ url: string }>;
    };
    expect(fresh.concerts.map((c) => c.url.split('/').pop())).toEqual(['new']);
  });

  it('keeps a region’s rows when Ticketmaster fails for it', async () => {
    await seedArtist('Kendrick Lamar', 5);
    stubTicketmaster({ singapore: [event('e1', KENDRICK, '2027-02-12')] }, { 'Kendrick Lamar': [KENDRICK] });
    await runConcertCheck(env, { now: NOW, spacingMs: 0 });

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const result = await runConcertCheck(env, { now: NOW + DAY, spacingMs: 0 });
    expect(result.regions.singapore).toEqual({ error: 'Ticketmaster /events.json: 500' });
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM concerts').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('does nothing without a key, and never lists everything when nobody matched', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await runConcertCheck({ ...env, TICKETMASTER_API_KEY: undefined }, { now: NOW })).skipped).toMatch(/not set/);
    expect(fetch).not.toHaveBeenCalled();

    await seedArtist('Nobody Famous', 2);
    vi.unstubAllGlobals();
    const calls = stubTicketmaster({ singapore: [event('x', KENDRICK, '2027-01-01')] }, {});
    const result = await runConcertCheck(env, { now: NOW, spacingMs: 0 });
    expect(result.matched).toBe(0);
    expect(calls.some((url) => url.pathname.endsWith('/events.json'))).toBe(false);
  });

  it('guards its routes', async () => {
    expect((await SELF.fetch(`${BASE}/api/concerts`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/concerts?region=mars`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/concerts?since=soon`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/admin/concert-check`, { method: 'POST', headers: READ })).status).toBe(401);
    stubTicketmaster({}, {});
    expect((await SELF.fetch(`${BASE}/admin/concert-check?spacingMs=0`, { method: 'POST', headers: ADMIN })).status).toBe(200);
  });
});

describe('concert check: paging, rate limits and status', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      'UPDATE concert_check_state SET last_run_ms = NULL, last_success_ms = NULL, last_error = NULL, last_error_ms = NULL, consecutive_failures = 0',
    ).run();
  });

  /** A fake Ticketmaster for Singapore only, answering `respond` per call. */
  function stubCalls(respond: (url: URL, n: number) => Response) {
    const calls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        calls.push(url);
        return respond(url, calls.length);
      }),
    );
    return calls;
  }
  const singaporeOnly = { ...env, CONCERT_REGIONS: JSON.stringify([{ key: 'singapore', label: 'Singapore', countryCode: 'SG' }]) };
  const stored = async () =>
    (await env.DB.prepare('SELECT event_id, first_seen_ms FROM concerts ORDER BY local_date').all<{ event_id: string; first_seen_ms: number }>())
      .results;

  it('keeps the events past the last page it fetched, and their first_seen', async () => {
    await seedArtist('Kendrick Lamar', 5);
    stubTicketmaster({ singapore: [event('early', KENDRICK, '2027-01-01'), event('late', KENDRICK, '2028-06-01')] }, { 'Kendrick Lamar': [KENDRICK] });
    await runConcertCheck(singaporeOnly, { now: NOW, spacingMs: 0 });

    // Next day: more events than three pages hold. The pages reach 2027-03-01;
    // `early` is gone from them, `late` lies beyond them.
    vi.unstubAllGlobals();
    const calls = stubCalls((url) => {
      const page = Number(url.searchParams.get('page'));
      const events = [event(`p${page}`, KENDRICK, `2027-0${page + 1}-01`)];
      return jsonResponse({ _embedded: { events }, page: { totalPages: 5 } });
    });
    const result = await runConcertCheck(singaporeOnly, { now: NOW + DAY, spacingMs: 0 });
    expect(calls.map((url) => url.searchParams.get('page'))).toEqual(['0', '1', '2']);
    expect(result.regions).toEqual({ singapore: { events: 3 } });
    expect(await stored()).toEqual([
      { event_id: 'p0', first_seen_ms: NOW + DAY },
      { event_id: 'p1', first_seen_ms: NOW + DAY },
      { event_id: 'p2', first_seen_ms: NOW + DAY },
      { event_id: 'late', first_seen_ms: NOW },
    ]);

    // A run that gets every page drops what it no longer lists.
    vi.unstubAllGlobals();
    stubTicketmaster({ singapore: [event('p0', KENDRICK, '2027-01-01')] }, {});
    await runConcertCheck(singaporeOnly, { now: NOW + 2 * DAY, spacingMs: 0 });
    expect((await stored()).map((row) => row.event_id)).toEqual(['p0']);
  });

  it('waits out a short Retry-After and records a clean run', async () => {
    await seedArtist('Kendrick Lamar', 5);
    const calls = stubCalls((url, n) => {
      if (n === 1) return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
      if (url.pathname.endsWith('/attractions.json')) return jsonResponse({ _embedded: { attractions: [KENDRICK] } });
      return jsonResponse({ _embedded: { events: [event('e1', KENDRICK, '2027-02-12')] }, page: { totalPages: 1 } });
    });
    const result = await runConcertCheck(singaporeOnly, { now: NOW, spacingMs: 0 });
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ looked_up: 1, matched: 1, regions: { singapore: { events: 1 } } });
    expect(await concertCheckStatus(env.DB)).toEqual({
      last_run_ms: NOW,
      last_success_ms: NOW,
      last_error: null,
      last_error_ms: null,
      consecutive_failures: 0,
    });
  });

  it('gives up on a long Retry-After, keeps the rows, and records the failure until a run succeeds', async () => {
    await seedArtist('Kendrick Lamar', 5);
    stubTicketmaster({ singapore: [event('e1', KENDRICK, '2027-02-12')] }, { 'Kendrick Lamar': [KENDRICK] });
    await runConcertCheck(singaporeOnly, { now: NOW, spacingMs: 0 });

    vi.unstubAllGlobals();
    const calls = stubCalls(() => new Response('quota', { status: 429, headers: { 'Retry-After': '3600' } }));
    const result = await runConcertCheck(singaporeOnly, { now: NOW + DAY, spacingMs: 0, maxRetryWaitMs: 1000 });
    expect(calls).toHaveLength(1);
    expect(result.regions).toEqual({ singapore: { error: 'Ticketmaster /events.json: 429 (Retry-After: 3600)' } });
    expect(await stored()).toHaveLength(1);
    expect(await concertCheckStatus(env.DB)).toEqual({
      last_run_ms: NOW + DAY,
      last_success_ms: NOW,
      last_error: 'singapore: Ticketmaster /events.json: 429 (Retry-After: 3600)',
      last_error_ms: NOW + DAY,
      consecutive_failures: 1,
    });

    // A failed lookup counts too.
    await env.DB.prepare("UPDATE concert_artists SET checked_ms = 0").run();
    await runConcertCheck(singaporeOnly, { now: NOW + 2 * DAY, spacingMs: 0, maxRetryWaitMs: 0 });
    expect(await concertCheckStatus(env.DB)).toMatchObject({
      consecutive_failures: 2,
      last_error: expect.stringContaining('lookup: Ticketmaster /attractions.json: 429'),
    });

    vi.unstubAllGlobals();
    stubTicketmaster({ singapore: [] }, { 'Kendrick Lamar': [KENDRICK] });
    await runConcertCheck(singaporeOnly, { now: NOW + 3 * DAY, spacingMs: 0 });
    expect(await concertCheckStatus(env.DB)).toMatchObject({ last_success_ms: NOW + 3 * DAY, consecutive_failures: 0 });
  });

  it('stays inside the Free plan’s subrequests, however many names are due', async () => {
    for (let i = 0; i < 40; i++) await seedArtist(`Artist ${i}`, 1);
    const calls = stubTicketmaster({}, {});
    const result = await runConcertCheck(env, { now: NOW, spacingMs: 0 });
    // 50 less six D1 calls and one per region, less three pages a region.
    expect(result.looked_up).toBe(25);
    expect(calls.length).toBeLessThanOrEqual(50 - 6 - 2);
  });

  it('ranks the year’s top artists the same from the rollup as from the plays', async () => {
    const statements: D1PreparedStatement[] = [];
    // Plays spread over the past year, so whole months and both ends count.
    for (const [artist, count] of [['Alpha', 30], ['Beta', 20], ['Gamma', 25]] as const) {
      const id = artist.toLowerCase();
      statements.push(
        env.DB.prepare('INSERT INTO artists (artist_id, name) VALUES (?, ?)').bind(id, artist),
        env.DB.prepare('INSERT INTO tracks (track_id, name, first_seen_ms) VALUES (?, ?, 0)').bind(`t-${id}`, 'Song'),
        env.DB.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind(`t-${id}`, id),
      );
      for (let i = 0; i < count; i++) {
        statements.push(
          env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(NOW - (i * 12 + 1) * DAY - i * 1000, `t-${id}`, 'api'),
        );
      }
    }
    // Older than a year, and today: neither counts.
    for (let i = 0; i < 40; i++) {
      statements.push(env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, 't-beta', 'api')").bind(NOW - 400 * DAY - i));
      statements.push(env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, 't-beta', 'api')").bind(NOW - i));
    }
    await env.DB.batch(statements);

    // The rollup is in UTC, which can't answer for the deployment's zone.
    const fromPlays = await topArtists(env, NOW);
    await ensureRollup(env, { now: NOW });
    const fromRollup = await topArtists(env, NOW);
    expect(fromRollup).toEqual(fromPlays);
    expect(fromRollup.map((a) => [a.name, a.plays])).toEqual([
      ['Alpha', 30],
      ['Gamma', 25],
      ['Beta', 20],
    ]);
  });
});

describe('retryAfterMs', () => {
  it('reads seconds and dates, and ignores junk', () => {
    expect(retryAfterMs('2', 0)).toBe(2000);
    expect(retryAfterMs(new Date(5000).toUTCString(), 0)).toBe(5000);
    expect(retryAfterMs('soon', 0)).toBeNull();
    expect(retryAfterMs(null, 0)).toBeNull();
  });
});

describe('concert artist pins', () => {
  const YE = { id: 'K8vZ9175Oy7', name: 'Ye' };
  const pin = (body: unknown, method = 'PUT') =>
    SELF.fetch(`${BASE}/admin/concert-artists`, { method, headers: { ...ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('pins a renamed act, which the daily check uses and never re-matches', async () => {
    await seedArtist('Kanye West', 5);
    // Ticketmaster knows him only as Ye, so the exact-name match misses.
    stubTicketmaster({ singapore: [event('e1', YE, '2027-04-01')] }, { 'Kanye West': [YE] });
    expect((await runConcertCheck(env, { now: NOW, spacingMs: 0 })).matched).toBe(0);

    expect((await pin({ name: 'kanye west', attraction_id: YE.id })).status).toBe(200);
    // Long past the recheck window: a pinned name is still never looked up.
    vi.unstubAllGlobals();
    const calls = stubTicketmaster({ singapore: [event('e1', YE, '2027-04-01')] }, {});
    const result = await runConcertCheck(env, { now: NOW + 200 * DAY, spacingMs: 0 });
    expect(result).toMatchObject({ matched: 1, looked_up: 0, regions: { singapore: { events: 1 } } });
    expect(calls.some((url) => url.pathname.endsWith('/attractions.json'))).toBe(false);
    const body = (await (await SELF.fetch(`${BASE}/api/concerts`, { headers: READ })).json()) as { concerts: Array<{ artists: string }> };
    // Billed under the name you listen to.
    expect(body.concerts.map((c) => c.artists)).toEqual(['Kanye West']);
  });

  it('blocks a wrong match with null, lists pins first, and unpins', async () => {
    await seedArtist('Collage', 3);
    expect((await pin({ name: 'Collage', attraction_id: null })).status).toBe(200);
    stubTicketmaster({}, { Collage: [{ id: 'WRONG', name: 'Collage' }] });
    expect((await runConcertCheck(env, { now: NOW, spacingMs: 0 })).matched).toBe(0);

    const listed = (await (await SELF.fetch(`${BASE}/admin/concert-artists?unmatched=1`, { headers: ADMIN })).json()) as {
      artists: Array<{ name: string; attraction_id: string | null; pinned: boolean }>;
    };
    expect(listed.artists).toEqual([expect.objectContaining({ name: 'Collage', attraction_id: null, pinned: true })]);

    expect(await (await pin({ name: 'collage' }, 'DELETE')).json()).toEqual({ name: 'collage', unpinned: true });
    // Unpinned, the next check matches it again.
    expect((await runConcertCheck(env, { now: NOW + DAY, spacingMs: 0 })).matched).toBe(1);
  });

  it('validates and is admin-only', async () => {
    expect((await pin({ attraction_id: 'x' })).status).toBe(400);
    expect((await pin({ name: 'X', attraction_id: 'bad id!' })).status).toBe(400);
    expect((await pin({ name: 'X', attraction_id: 7 })).status).toBe(400);
    const read = await SELF.fetch(`${BASE}/admin/concert-artists`, { method: 'PUT', headers: READ, body: '{}' });
    expect(read.status).toBe(401);
    expect((await SELF.fetch(`${BASE}/admin/concert-artists`, { headers: READ })).status).toBe(401);
  });
});

describe('/api/concerts when concerts are off', () => {
  const get = (bindings: Cloudflare.Env) =>
    worker.fetch(new Request(`${BASE}/api/concerts`, { headers: READ }), bindings, createExecutionContext());

  it('is a plain 404 without a Ticketmaster key or without a region', async () => {
    for (const off of [{ ...env, TICKETMASTER_API_KEY: undefined }, { ...env, CONCERT_REGIONS: undefined }, { ...env, CONCERT_REGIONS: '[]' }]) {
      const response = await get(off);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found' });
    }
  });
});
