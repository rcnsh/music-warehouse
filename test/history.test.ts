import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { syncAllSongs } from '../src/play-numbers';

const BASE = 'https://warehouse.test';
const ADMIN = { Authorization: 'Bearer test-admin-token' };
const READ = { Authorization: 'Bearer test-read-token' };
const MIN = 60_000;
const DAY = 86_400_000;

interface Play {
  ms: number;
  trackId: string;
  name?: string;
  /** Artist id; `name:`-prefixed for an export placeholder. */
  artistId?: string;
  artistName?: string;
  /** Credit position; 0 is the primary artist. */
  position?: number;
  album?: string | null;
  durationMs?: number;
}

async function seed(plays: Play[]) {
  const statements: D1PreparedStatement[] = [];
  for (const play of plays) {
    const artistId = play.artistId ?? `id-${play.trackId}`;
    const album = play.album === undefined ? `album-${play.trackId}` : play.album;
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(play.ms, play.trackId, 'api'),
      env.DB.prepare(
        'INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, album_id, first_seen_ms) VALUES (?, ?, ?, ?, ?)',
      ).bind(play.trackId, play.name ?? `Song ${play.trackId}`, play.durationMs ?? 200_000, album, play.ms),
      env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind(artistId, play.artistName ?? artistId),
      env.DB.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)').bind(
        play.trackId,
        artistId,
        play.position ?? 0,
      ),
    );
    if (album !== null) {
      statements.push(
        env.DB.prepare('INSERT OR IGNORE INTO albums (album_id, name, image_url) VALUES (?, ?, ?)').bind(
          album,
          `Album ${album}`,
          `https://i.scdn.co/image/${album}`,
        ),
      );
    }
  }
  // Songs keyed as every write keys them.
  await env.DB.batch([...statements, ...syncAllSongs(env.DB)]);
}

/** `count` plays of one track, five minutes apart so each counts its full 200 s. */
function session(startMs: number, count: number, play: Omit<Play, 'ms'>): Play[] {
  return Array.from({ length: count }, (_, i) => ({ ...play, ms: startMs + i * 5 * MIN }));
}

async function get<T>(path: string, headers: Record<string, string> = READ): Promise<T> {
  const response = await SELF.fetch(`${BASE}${path}`, { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

interface ArtistBody {
  artist: { id: string | null; name: string };
  plays: number;
  minutes: number;
  first_played: string | null;
  last_played: string | null;
  months: Array<{ month: string; plays: number }>;
  top_tracks: Array<{ id: string | null; name: string; plays: number; image: string | null }>;
}

interface TrackBody extends Omit<ArtistBody, 'artist' | 'top_tracks'> {
  track: { id: string; name: string | null; artist: string | null; image: string | null };
}

interface OnThisDayBody {
  date: string;
  years: Array<{
    year: number;
    plays: number;
    top_tracks: Array<{ id: string | null; name: string; artist: string | null; image: string | null; plays: number }>;
  }>;
}

const JAN_10 = Date.UTC(2024, 0, 10, 12);

describe('history routes: access', () => {
  it.each(['/api/artist?id=x', '/api/track?id=x', '/api/on-this-day?date=2026-03-02'])('%s needs a token', async (path) => {
    expect((await SELF.fetch(`${BASE}${path}`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}${path}`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}${path}`, { headers: READ })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}${path}`, { headers: ADMIN })).status).toBe(200);
  });

  it.each([
    '/api/artist',
    '/api/track',
    '/api/artist?id=x&tz=Mars/Base',
    '/api/on-this-day?date=2026-02-30',
    '/api/on-this-day?date=soon',
  ])('rejects %s with 400', async (path) => {
    expect((await SELF.fetch(`${BASE}${path}`, { headers: READ })).status).toBe(400);
  });
});

describe('history routes: caching', () => {
  const ROUTES = [
    '/api/artist?id=por&tz=Europe/London',
    '/api/track?id=t1',
    '/api/on-this-day?date=2025-01-10',
    '/api/top-tracks?from=2024-01-01&to=2024-12-31',
    '/api/top-artists?from=2024-01-01&to=2024-12-31',
    '/api/daily?from=2024-01-01&to=2024-01-31&tz=Asia/Singapore',
  ];

  it.each(ROUTES)('keeps %s until a new play, for any token, and lets a client reuse it briefly', async (path) => {
    await seed(session(JAN_10, 3, { trackId: 't1', artistId: 'por', artistName: 'Porter Robinson' }));
    const first = await SELF.fetch(`${BASE}${path}`, { headers: READ });
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(first.headers.get('X-Cache')).toBeNull();
    const body = await first.text();

    // Another token, the parameters in another order: the same answer, kept.
    const reordered = `${path.split('?')[0]}?${new URLSearchParams([...new URL(`${BASE}${path}`).searchParams].reverse())}`;
    const second = await SELF.fetch(`${BASE}${reordered}`, { headers: ADMIN });
    expect(second.headers.get('X-Cache')).toBe('hit');
    expect(second.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(await second.text()).toBe(body);
    // A hit reports what it read itself, the cache check: a handful of rows.
    const hitRows = Number(second.headers.get('X-Rows-Read'));
    expect(hitRows).toBeGreaterThan(0);
    expect(hitRows).toBeLessThan(10);

    await seed([{ ms: JAN_10 + 3 * DAY, trackId: 't1', artistId: 'por', artistName: 'Porter Robinson' }]);
    const third = await SELF.fetch(`${BASE}${path}`, { headers: READ });
    expect(third.headers.get('X-Cache')).toBeNull();
  });

  it('keys every parameter, so group_by gets its own answer', async () => {
    await seed(session(JAN_10, 3, { trackId: 't1', artistId: 'por', artistName: 'Porter Robinson' }));
    const path = '/api/daily?from=2024-01-01&to=2024-01-31&tz=Asia/Singapore';
    await SELF.fetch(`${BASE}${path}`, { headers: READ });
    const weekly = await SELF.fetch(`${BASE}${path}&group_by=week`, { headers: READ });
    expect(weekly.headers.get('X-Cache')).toBeNull();
    expect(((await weekly.json()) as { group_by: string }).group_by).toBe('week');
  });

  it('keeps no errors, and adds CORS headers to a kept answer per request', async () => {
    const bad = await SELF.fetch(`${BASE}/api/track`, { headers: READ });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('Cache-Control')).toBe('no-store');
    expect((await SELF.fetch(`${BASE}/api/track`, { headers: READ })).headers.get('X-Cache')).toBeNull();

    const path = '/api/track?id=t9';
    await SELF.fetch(`${BASE}${path}`, { headers: READ });
    const plain = await SELF.fetch(`${BASE}${path}`, { headers: READ });
    expect(plain.headers.get('X-Cache')).toBe('hit');
    expect(plain.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const cors = await SELF.fetch(`${BASE}${path}`, { headers: { ...READ, Origin: 'https://wrapped.test' } });
    expect(cors.headers.get('X-Cache')).toBe('hit');
    expect(cors.headers.get('Access-Control-Allow-Origin')).toBe('https://wrapped.test');
    expect(cors.headers.get('Vary')).toBe('Origin');
    expect((await SELF.fetch(`${BASE}${path}`)).status).toBe(401);
  });
});

describe('/api/artist', () => {
  it('folds name placeholders into the real id and credits the primary artist only', async () => {
    await seed([
      ...session(JAN_10, 3, { trackId: 'live', name: 'Shelter', artistId: 'real-id', artistName: 'Porter Robinson' }),
      // The export's copy of the same song, under a placeholder with other casing.
      ...session(JAN_10 + DAY, 2, { trackId: 'export', name: 'shelter', artistId: 'name:porter robinson', artistName: 'porter robinson' }),
      ...session(JAN_10 + 2 * DAY, 1, { trackId: 'other', name: 'Language', artistId: 'real-id', artistName: 'Porter Robinson' }),
      // A feature: credited at position 1, so not this artist's play.
      ...session(JAN_10 + 3 * DAY, 4, { trackId: 'feat', artistId: 'real-id', artistName: 'Porter Robinson', position: 1 }),
    ]);
    const body = await get<ArtistBody>('/api/artist?id=real-id');
    expect(body.artist).toEqual({ id: 'real-id', name: 'Porter Robinson' });
    expect(body.plays).toBe(6);
    expect(body.first_played).toBe(new Date(JAN_10).toISOString());
    expect(body.last_played).toBe(new Date(JAN_10 + 2 * DAY).toISOString());
    expect(body.top_tracks).toEqual([
      { id: 'live', name: 'Shelter', plays: 5, image: 'https://i.scdn.co/image/album-live' },
      { id: 'other', name: 'Language', plays: 1, image: 'https://i.scdn.co/image/album-other' },
    ]);
  });

  it('falls back to the name when the id is unknown', async () => {
    await seed(session(JAN_10, 2, { trackId: 'export', artistId: 'name:Madeon', artistName: 'Madeon' }));
    const body = await get<ArtistBody>('/api/artist?id=spotify-id-never-polled&name=MADEON');
    expect(body.artist).toEqual({ id: 'spotify-id-never-polled', name: 'Madeon' });
    expect(body.plays).toBe(2);
    expect((await get<ArtistBody>('/api/artist?name=madeon')).artist).toEqual({ id: null, name: 'Madeon' });
  });

  it('answers an unknown artist with zeros, not 404', async () => {
    expect(await get<ArtistBody>('/api/artist?id=nobody')).toEqual({
      artist: { id: 'nobody', name: '' },
      plays: 0,
      minutes: 0,
      first_played: null,
      last_played: null,
      months: [],
      top_tracks: [],
    });
  });

  it('estimates minutes as Wrapped does, with skips worth nothing', async () => {
    await seed([
      // The first play ever has no predecessor: 180 s fallback, under the 200 s length.
      ...session(JAN_10, 2, { trackId: 'a', artistId: 'x' }),
      // Ten seconds after another artist's play: a skip, but still a play.
      { ms: JAN_10 + 20 * MIN, trackId: 'other', artistId: 'y' },
      { ms: JAN_10 + 20 * MIN + 10_000, trackId: 'a', artistId: 'x' },
      // Two minutes after that: counts the two minutes it could have run.
      { ms: JAN_10 + 22 * MIN + 10_000, trackId: 'a', artistId: 'x' },
    ]);
    const body = await get<ArtistBody>('/api/artist?id=x');
    expect(body.plays).toBe(4);
    expect(body.minutes).toBe(Math.round((180_000 + 200_000 + 2 * MIN) / MIN));
  });

  it('buckets months in the requested zone and fills quiet months with zero', async () => {
    await seed([
      // 20:00 UTC on 31 January is 04:00 on 1 February in Singapore.
      { ms: Date.UTC(2024, 0, 31, 20), trackId: 'a', artistId: 'x' },
      { ms: Date.UTC(2024, 3, 2, 12), trackId: 'a', artistId: 'x' },
    ]);
    expect((await get<ArtistBody>('/api/artist?id=x&tz=UTC')).months).toEqual([
      { month: '2024-01', plays: 1 },
      { month: '2024-02', plays: 0 },
      { month: '2024-03', plays: 0 },
      { month: '2024-04', plays: 1 },
    ]);
    expect((await get<ArtistBody>('/api/artist?id=x&tz=Asia/Singapore')).months[0]).toEqual({ month: '2024-02', plays: 1 });
  });

  it('reports its row reads in a header, and reads only this artist’s plays', async () => {
    await seed([
      ...session(JAN_10, 3, { trackId: 'a', artistId: 'x' }),
      ...Array.from({ length: 50 }, (_, i) => ({ ms: JAN_10 + DAY + i * 5 * MIN, trackId: `n${i}`, artistId: 'noise' })),
    ]);
    const response = await SELF.fetch(`${BASE}/api/artist?id=x`, { headers: READ });
    const rowsRead = Number(response.headers.get('X-Rows-Read'));
    expect(rowsRead).toBeGreaterThan(0);
    // Every play of the other artist read once would already be 50.
    expect(rowsRead).toBeLessThan(50);
  });
});

describe('/api/track', () => {
  it('folds editions of the same song under the same artist', async () => {
    await seed([
      ...session(JAN_10, 2, { trackId: 'single', name: 'Hit', artistId: 'real', artistName: 'X', album: null }),
      ...session(JAN_10 + DAY, 3, { trackId: 'lp', name: 'HIT', artistId: 'name:x', artistName: 'x', album: 'lp' }),
      // Same title, different artist: a different song.
      ...session(JAN_10 + 2 * DAY, 4, { trackId: 'cover', name: 'Hit', artistId: 'other', artistName: 'Y' }),
    ]);
    const body = await get<TrackBody>('/api/track?id=single');
    // The requested edition has no art, so the art comes from the one played that has.
    expect(body.track).toEqual({ id: 'single', name: 'Hit', artist: 'X', image: 'https://i.scdn.co/image/lp' });
    expect(body.plays).toBe(5);
    expect(body.minutes).toBe(Math.round((180_000 + 4 * 200_000) / MIN));
    expect(body.first_played).toBe(new Date(JAN_10).toISOString());
    expect(body.months).toEqual([{ month: '2024-01', plays: 5 }]);
  });

  it('folds a remastered or single edition, but not a live one', async () => {
    await seed([
      ...session(JAN_10, 2, { trackId: 'orig', name: 'Heroes', artistId: 'bowie', artistName: 'David Bowie' }),
      ...session(JAN_10 + DAY, 3, { trackId: 'remaster', name: 'Heroes - 2017 Remaster', artistId: 'bowie', artistName: 'David Bowie' }),
      ...session(JAN_10 + 2 * DAY, 1, { trackId: 'single', name: 'Heroes (Single Version)', artistId: 'bowie', artistName: 'David Bowie' }),
      ...session(JAN_10 + 3 * DAY, 4, { trackId: 'live', name: 'Heroes - Live', artistId: 'bowie', artistName: 'David Bowie' }),
    ]);
    expect((await get<TrackBody>('/api/track?id=remaster')).plays).toBe(6);
    expect((await get<TrackBody>('/api/track?id=live')).plays).toBe(4);
  });

  it('answers an unknown track with nulls and zeros, not 404', async () => {
    expect(await get<TrackBody>('/api/track?id=nothing')).toEqual({
      track: { id: 'nothing', name: null, artist: null, image: null },
      plays: 0,
      minutes: 0,
      first_played: null,
      last_played: null,
      months: [],
    });
  });
});

describe('/api/on-this-day', () => {
  it('lists earlier years with plays on the same local day, newest first', async () => {
    await seed([
      ...session(Date.UTC(2024, 2, 2, 12), 3, { trackId: 'a', name: 'A', artistId: 'ax', artistName: 'Ax' }),
      ...session(Date.UTC(2024, 2, 2, 14), 1, { trackId: 'b', artistId: 'bx' }),
      ...session(Date.UTC(2022, 2, 2, 9), 2, { trackId: 'c', artistId: 'cx' }),
      // A day either side, and the requested year itself: none of these count.
      { ms: Date.UTC(2023, 2, 1, 12), trackId: 'd', artistId: 'dx' },
      { ms: Date.UTC(2023, 2, 3, 12), trackId: 'd', artistId: 'dx' },
      { ms: Date.UTC(2026, 2, 2, 8), trackId: 'd', artistId: 'dx' },
    ]);
    const body = await get<OnThisDayBody>('/api/on-this-day?date=2026-03-02&tz=UTC');
    expect(body.date).toBe('2026-03-02');
    expect(body.years.map((y) => [y.year, y.plays])).toEqual([
      [2024, 4],
      [2022, 2],
    ]);
    expect(body.years[0]!.top_tracks[0]).toEqual({ id: 'a', name: 'A', artist: 'Ax', image: 'https://i.scdn.co/image/album-a', plays: 3 });
    expect(body.years[0]!.top_tracks).toHaveLength(2);
  });

  it('reads the day in the requested zone', async () => {
    // 20:00 UTC on 1 March is 2 March in Singapore.
    await seed([{ ms: Date.UTC(2024, 2, 1, 20), trackId: 'a', artistId: 'x' }]);
    expect((await get<OnThisDayBody>('/api/on-this-day?date=2026-03-02&tz=UTC')).years).toEqual([]);
    expect((await get<OnThisDayBody>('/api/on-this-day?date=2026-03-02&tz=Asia/Singapore')).years[0]?.year).toBe(2024);
  });

  it('looks for 29 February only in leap years', async () => {
    await seed([
      { ms: Date.UTC(2024, 1, 29, 12), trackId: 'a', artistId: 'x' },
      { ms: Date.UTC(2023, 2, 1, 12), trackId: 'a', artistId: 'x' },
    ]);
    const body = await get<OnThisDayBody>('/api/on-this-day?date=2028-02-29&tz=UTC');
    expect(body.years.map((y) => y.year)).toEqual([2024]);
  });

  it('caps top tracks at five and folds editions', async () => {
    const start = Date.UTC(2024, 2, 2, 1);
    await seed([
      ...Array.from({ length: 7 }, (_, i) => session(start + i * 2 * 60 * MIN, 7 - i, { trackId: `t${i}`, artistId: 'x', artistName: 'X' })).flat(),
      ...session(start + 16 * 60 * MIN, 1, { trackId: 't0-lp', name: 'Song t0', artistId: 'x', artistName: 'X' }),
    ]);
    const [year] = (await get<OnThisDayBody>('/api/on-this-day?date=2026-03-02&tz=UTC')).years;
    expect(year!.top_tracks).toHaveLength(5);
    expect(year!.top_tracks[0]).toMatchObject({ id: 't0', plays: 8 });
  });
});

describe('/api/top-tracks', () => {
  it('counts songs in the range, editions folded, most played first', async () => {
    await seed([
      ...session(JAN_10, 3, { trackId: 'single', name: 'Hit', artistId: 'real', artistName: 'X' }),
      ...session(JAN_10 + DAY, 1, { trackId: 'lp', name: 'HIT', artistId: 'name:x', artistName: 'x' }),
      ...session(JAN_10 + 2 * DAY, 3, { trackId: 'cover', name: 'Hit', artistId: 'other', artistName: 'Y' }),
      // Outside the range.
      ...session(JAN_10 + 40 * DAY, 9, { trackId: 'later', artistId: 'z' }),
    ]);
    const body = await get<{ from: string; tracks: Array<{ id: string; name: string; artist: string; plays: number }> }>(
      '/api/top-tracks?from=2024-01-01&to=2024-01-31&tz=UTC',
    );
    expect(body.from).toBe('2024-01-01');
    expect(body.tracks.map(({ id, artist, plays }) => ({ id, artist, plays }))).toEqual([
      { id: 'single', artist: 'X', plays: 4 },
      { id: 'cover', artist: 'Y', plays: 3 },
    ]);
    const limited = await get<{ tracks: unknown[] }>('/api/top-tracks?from=2024-01-01&to=2024-01-31&tz=UTC&limit=1');
    expect(limited.tracks).toHaveLength(1);
  });

  it('folds remasters, takes the art from an edition that has it, and cuts to the limit in SQL', async () => {
    await seed([
      ...session(JAN_10, 2, { trackId: 'orig', name: 'Heroes', artistId: 'bowie', artistName: 'David Bowie', album: null }),
      ...session(JAN_10 + DAY, 3, { trackId: 'remaster', name: 'Heroes - 2017 Remaster', artistId: 'bowie', artistName: 'David Bowie', album: null }),
      ...session(JAN_10 + 2 * DAY, 1, { trackId: 'radio', name: 'Heroes (Radio Edit)', artistId: 'name:david bowie', artistName: 'david bowie' }),
      ...session(JAN_10 + 3 * DAY, 4, { trackId: 'live', name: 'Heroes - Live', artistId: 'bowie', artistName: 'David Bowie' }),
      ...session(JAN_10 + 4 * DAY, 1, { trackId: 'quiet', name: 'Quiet', artistId: 'q' }),
    ]);
    type Body = { tracks: Array<{ id: string; name: string; artist: string; plays: number; image: string | null }> };
    // A whole month (from the rollup) and a part of one (from the plays) agree.
    for (const range of ['from=2024-01-01&to=2024-01-31', 'from=2024-01-02&to=2024-01-30']) {
      const body = await get<Body>(`/api/top-tracks?${range}&tz=UTC&limit=2`);
      expect(body.tracks).toEqual([
        { id: 'remaster', name: 'Heroes - 2017 Remaster', artist: 'David Bowie', plays: 6, image: 'https://i.scdn.co/image/album-radio' },
        { id: 'live', name: 'Heroes - Live', artist: 'David Bowie', plays: 4, image: 'https://i.scdn.co/image/album-live' },
      ]);
    }
    // Names and art are looked up for the songs listed only.
    const response = await SELF.fetch(`${BASE}/api/top-tracks?from=2024-01-02&to=2024-01-30&tz=UTC&limit=1`, { headers: READ });
    const rowsOne = Number(response.headers.get('X-Rows-Read'));
    const all = await SELF.fetch(`${BASE}/api/top-tracks?from=2024-01-02&to=2024-01-30&tz=UTC&limit=10`, { headers: READ });
    expect(((await all.json()) as Body).tracks).toHaveLength(3);
    expect(rowsOne).toBeLessThan(Number(all.headers.get('X-Rows-Read')));
  });

  it('needs a token and validates the range', async () => {
    expect((await SELF.fetch(`${BASE}/api/top-tracks`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/top-tracks?from=2024-02-01&to=2024-01-01`, { headers: READ })).status).toBe(400);
  });
});
