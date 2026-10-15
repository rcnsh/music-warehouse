import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeName, runConcertCheck } from '../src/concerts';
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
