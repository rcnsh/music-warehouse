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
