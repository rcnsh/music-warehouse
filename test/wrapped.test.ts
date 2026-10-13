import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { edgeRequest } from '../src/snapshots';
import { listeningAge, type Wrapped } from '../src/wrapped';

const BASE = 'https://warehouse.test';
const ADMIN = { Authorization: 'Bearer test-admin-token' };
const READ = { Authorization: 'Bearer test-read-token' };
const MIN = 60_000;

interface Play {
  ms: number;
  trackId: string;
  artist?: string;
  album?: string;
  name?: string;
  releaseDate?: string | null;
  durationMs?: number;
}

async function seed(plays: Play[]) {
  const statements: D1PreparedStatement[] = [];
  for (const play of plays) {
    const artist = play.artist ?? `Artist ${play.trackId}`;
    const album = play.album ?? `album-${play.trackId}`;
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(play.ms, play.trackId, 'api'),
      env.DB.prepare(
        'INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, album_id, first_seen_ms) VALUES (?, ?, ?, ?, ?)',
      ).bind(play.trackId, play.name ?? `Song ${play.trackId}`, play.durationMs ?? 200_000, album, play.ms),
      env.DB.prepare('INSERT OR IGNORE INTO albums (album_id, name, release_date, image_url) VALUES (?, ?, ?, ?)').bind(
        album,
        `Album ${album}`,
        play.releaseDate === undefined ? '2015-06-01' : play.releaseDate,
        `https://i.scdn.co/image/${album}`,
      ),
      env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind(`id-${artist}`, artist),
      env.DB.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind(
        play.trackId,
        `id-${artist}`,
      ),
    );
  }
  await env.DB.batch(statements);
}

/** `count` plays of one track, five minutes apart so each counts its full 200 s. */
function session(trackId: string, startMs: number, count: number, extra: Partial<Play> = {}): Play[] {
  return Array.from({ length: count }, (_, i) => ({ ms: startMs + i * 5 * MIN, trackId, ...extra }));
}

async function wrapped(from: string, to: string, headers: Record<string, string> = ADMIN) {
  // setup.ts empties stats_snapshots but not the Cache API, where a body from
  // an earlier test would otherwise answer.
  await (await caches.open('stats')).delete(edgeRequest(`wrapped:v1:${from}:${to}`));
  return SELF.fetch(`${BASE}/api/wrapped?from=${from}&to=${to}`, { headers });
}

// March 2024 is Newcastle-era (GMT); the test MOVED_AT is 2025-03-10.
const MARCH_2 = Date.UTC(2024, 2, 2, 12);
const DAY = 86_400_000;

describe('wrapped: access', () => {
  it('requires a token', async () => {
    const response = await SELF.fetch(`${BASE}/api/wrapped?from=2024-03-01&to=2024-03-31`);
    expect(response.status).toBe(401);
  });

  it('lets READ_TOKEN read a computed range but never compute one', async () => {
    await seed(session('a', MARCH_2, 3));
    expect((await wrapped('2024-03-01', '2024-03-31', READ)).status).toBe(403);
    expect((await wrapped('2024-03-01', '2024-03-31', ADMIN)).status).toBe(200);

    const read = await wrapped('2024-03-01', '2024-03-31', READ);
    expect(read.status).toBe(200);
    expect(((await read.json()) as Wrapped).totals.plays).toBe(3);
  });

  it.each([
    ['2024-03-01', 'soon'],
    ['2024-03-31', '2024-03-01'],
    ['2024-02-30', '2024-03-01'],
    ['2024-02-32', '2024-03-01'],
    ['2010-01-01', '2010-12-31'],
  ])('rejects from=%s to=%s', async (from, to) => {
    expect((await wrapped(from, to)).status).toBe(400);
  });

  it('rejects a range that has not ended', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect((await wrapped('2024-03-01', today)).status).toBe(400);
  });
});

describe('wrapped: body', () => {
  it('estimates minutes from gaps and drops skips', async () => {
    await seed([
      // First play has no predecessor within a day: the fallback (180 s) is
      // below the 200 s duration, so it counts 180 s.
      ...session('a', MARCH_2, 3),
      // Ten seconds after the last: a skip.
      { ms: MARCH_2 + 10 * MIN + 10_000, trackId: 'b' },
      // Two minutes after that: counts the two minutes it could have run.
      { ms: MARCH_2 + 12 * MIN + 10_000, trackId: 'c' },
    ]);
    const body = (await (await wrapped('2024-03-01', '2024-03-31')).json()) as Wrapped;
    expect(body.totals.plays).toBe(4);
    expect(body.totals.skips).toBe(1);
    expect(body.totals.minutes).toBe(Math.round((180_000 + 200_000 * 2 + 2 * MIN) / MIN));
  });

  it('ranks artists, songs and albums by minutes and finds the biggest day and streak', async () => {
    const plays: Play[] = [
      ...session('t1', MARCH_2, 6, { artist: 'Big', album: 'lp' }),
      ...session('t2', MARCH_2 + DAY, 4, { artist: 'Big', album: 'lp' }),
      ...session('t3', MARCH_2 + 2 * DAY, 2, { artist: 'Big', album: 'lp' }),
      ...session('t4', MARCH_2 + 4 * DAY, 5, { artist: 'Small' }),
    ];
    await seed(plays);
    const body = (await (await wrapped('2024-03-01', '2024-03-31')).json()) as Wrapped;

    expect(body.top_artists.map((a) => a.name)).toEqual(['Big', 'Small']);
    expect(body.top_artists[0]).toMatchObject({ days: 3, longest_run_days: 3, top_song: 'Song t1', plays: 12 });
    expect(body.top_songs[0]).toMatchObject({ name: 'Song t1', artist: 'Big', plays: 6, peak_month: '2024-03', first_played: '2024-03-02' });
    expect(body.top_albums).toHaveLength(1);
    expect(body.top_albums[0]).toMatchObject({ name: 'Album lp', songs: 3, plays: 12 });
    expect(body.biggest_day?.date).toBe('2024-03-02');
    expect(body.streak).toEqual({ days: 3, from: '2024-03-02', to: '2024-03-04' });
    expect(body.totals.days_listened).toBe(4);
    expect(body.months).toEqual([expect.objectContaining({ month: '2024-03', top_artist: 'Big', top_song: 'Song t1' })]);
  });

  it('folds editions of one song and credits the most-played edition art', async () => {
    await seed([
      ...session('single', MARCH_2, 2, { name: 'Hit', artist: 'X', album: 'single-ed' }),
      ...session('lp-ed', MARCH_2 + DAY, 3, { name: 'HIT', artist: 'X', album: 'album-ed' }),
    ]);
    const body = (await (await wrapped('2024-03-01', '2024-03-31')).json()) as Wrapped;
    expect(body.top_songs).toHaveLength(1);
    expect(body.top_songs[0]).toMatchObject({ plays: 5, image: 'https://i.scdn.co/image/album-ed' });
  });

  it('counts only artists and songs never played before the range as discoveries', async () => {
    await seed([
      ...session('old', Date.UTC(2023, 5, 1, 12), 2, { artist: 'Known', name: 'Old song' }),
      ...session('old-again', MARCH_2, 3, { artist: 'Known', name: 'Old song' }),
      ...session('fresh', MARCH_2 + DAY, 2, { artist: 'Known', name: 'New song' }),
      ...session('newbie', MARCH_2 + 2 * DAY, 4, { artist: 'Newcomer' }),
    ]);
    const body = (await (await wrapped('2024-03-01', '2024-03-31')).json()) as Wrapped;
    expect(body.discoveries.artists).toBe(1);
    expect(body.discoveries.songs).toBe(2);
    expect(body.discoveries.top.map((a) => a.name)).toEqual(['Newcomer']);
  });

  it('buckets days and hours in each era’s local time', async () => {
    // 23:30 UTC on 1 June 2025 is 07:30 on 2 June in Singapore.
    await seed([{ ms: Date.UTC(2025, 5, 1, 23, 30), trackId: 'sg' }]);
    const body = (await (await wrapped('2025-06-01', '2025-06-30')).json()) as Wrapped;
    expect(body.biggest_day?.date).toBe('2025-06-02');
    expect(body.hours.findIndex((m) => m > 0)).toBe(7);
    // 2 June 2025 is a Monday.
    expect(body.weekdays.findIndex((m) => m > 0)).toBe(0);
  });

  it('carries no listening outside the range', async () => {
    await seed([...session('in', MARCH_2, 2), ...session('out', Date.UTC(2024, 3, 2, 12), 2)]);
    const body = (await (await wrapped('2024-03-01', '2024-03-31')).json()) as Wrapped;
    expect(body.totals.plays).toBe(2);
    expect(JSON.stringify(body)).not.toContain('Song out');
  });
});

describe('listeningAge', () => {
  it('centres on the busiest five-year span of release years', () => {
    const years = new Map([
      [1985, 10],
      [1986, 30],
      [1987, 30],
      [1988, 20],
      [2020, 15],
    ]);
    const age = listeningAge(years, 105, 120, '2024-12-31');
    expect(age).toMatchObject({ window: [1985, 1989], median_year: 1987, age: 2024 - 1987 + 18 });
    expect(age?.decades).toEqual([
      { decade: 1980, share: round(90 / 105) },
      { decade: 2020, share: round(15 / 105) },
    ]);
  });

  it('withholds an age when too little has a release date', () => {
    expect(listeningAge(new Map([[2000, 10]]), 10, 100, '2024-12-31')).toBeNull();
  });
});

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
