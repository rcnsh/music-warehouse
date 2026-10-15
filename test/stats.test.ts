import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Era, buildEras, localTimeSql, parseEras, startOfLocalToday, startOfLocalWeek } from '../src/eras';
import { freshForSeconds, statKey } from '../src/stats';
import { streaksFrom } from '../src/stats/rhythm';
import { totalVariation } from '../src/stats/drift';
import { localDayKey } from '../src/tz';
import { edgeRequest } from '../src/snapshots';
import { freezeClock } from './helpers';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const DAY = 86_400_000;
const STATS = ['on-repeat', 'rhythm', 'top-over-time', 'eras', 'albums'];
const ERAS = buildEras(parseEras(env.ERAS, env.TIMEZONE), 0);
const MOVE_MS = ERAS[1]!.fromMs;

function stat(name: string) {
  return SELF.fetch(`${BASE}/api/stats/${name}`, { headers: READ });
}

interface Play {
  ms: number;
  trackId: string;
  artist?: string;
  album?: string;
}

async function seed(plays: Play[]) {
  const statements: D1PreparedStatement[] = [];
  for (const play of plays) {
    const artist = play.artist ?? `Artist ${play.trackId}`;
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO plays (played_at_ms, track_id, context_uri, source) VALUES (?, ?, ?, ?)').bind(
        play.ms,
        play.trackId,
        'spotify:playlist:private-mix',
        'api',
      ),
      env.DB.prepare(
        'INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, album_id, first_seen_ms) VALUES (?, ?, ?, ?, ?)',
      ).bind(play.trackId, `Song ${play.trackId}`, 200_000, play.album ?? `album-${play.trackId}`, play.ms),
      env.DB.prepare('INSERT OR IGNORE INTO albums (album_id, name, image_url) VALUES (?, ?, ?)').bind(
        play.album ?? `album-${play.trackId}`,
        `Album ${play.album ?? play.trackId}`,
        'https://i.scdn.co/image/ab67616d0000b273aaaa',
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

/** `count` plays of one track, a few minutes apart so none read as skips. */
function session(trackId: string, startMs: number, count: number, extra: Partial<Play> = {}): Play[] {
  return Array.from({ length: count }, (_, i) => ({ ms: startMs + i * 4 * 60_000, trackId, ...extra }));
}

describe('stats routes: access', () => {
  it.each(STATS)('requires a token for /api/stats/%s', async (name) => {
    const response = await SELF.fetch(`${BASE}/api/stats/${name}`);
    expect(response.status).toBe(401);
  });

  it('answers 404 for a stat that does not exist', async () => {
    expect((await stat('everything')).status).toBe(404);
  });
});

describe('stats routes: privacy', () => {
  it.each(STATS)('/api/stats/%s carries no play rows, timestamps or context URIs', async (name) => {
    const now = Date.now();
    const plays: Play[] = [];
    for (let day = 0; day < 40; day++) plays.push(...session(`t${day % 3}`, now - day * DAY - 3 * 3_600_000, 6));
    await seed(plays);

    const response = await stat(name);
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).not.toContain('played_at');
    expect(text).not.toContain('context');
    expect(text).not.toContain('spotify:playlist');
    // No raw epoch milliseconds anywhere in the body.
    expect(text).not.toMatch(/\b1[5-9]\d{11}\b/);
    // Full dates appear only as the cut-off; everything else is a month.
    const body = JSON.parse(text) as Record<string, unknown>;
    const { as_of: _, ...rest } = body;
    expect(JSON.stringify(rest)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // No running count of days, which would date its own start.
    expect(text).not.toMatch(/"(current_days|window_days_in_era|days_in_era)"/);
  });
});

describe('local time across eras', () => {
  it('agrees with Intl on local day and hour either side of DST changes and the move', async () => {
    const instants: number[] = [];
    for (const anchor of [Date.parse('2021-03-28T00:00Z'), Date.parse('2023-10-29T00:00Z'), Date.parse('2024-03-31T00:00Z'), MOVE_MS - 12 * 3_600_000]) {
      for (let h = 0; h < 24; h++) instants.push(anchor + h * 3_600_000);
    }
    const { local, era } = localTimeSql(ERAS);
    const values = instants.map(() => '(?)').join(', ');
    const { results } = await env.DB.prepare(
      `SELECT s, ${era} AS era, date(${local}, 'unixepoch') AS day, CAST(strftime('%H', ${local}, 'unixepoch') AS INTEGER) AS hour
         FROM (SELECT column1 AS s, strftime('%Y', column1, 'unixepoch') AS y FROM (VALUES ${values}))`,
    )
      .bind(...instants.map((ms) => ms / 1000))
      .all<{ s: number; era: number; day: string; hour: number }>();

    for (const row of results) {
      const ms = row.s * 1000;
      const zone = ms >= MOVE_MS ? 'Asia/Singapore' : 'Europe/London';
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)),
      );
      expect({ day: row.day, hour: row.hour, era: ERAS[row.era]!.timeZone }).toEqual({
        day: localDayKey(ms, zone),
        hour,
        era: zone,
      });
    }
  });
});

describe('streaks', () => {
  const days = (list: Array<[string, number]>) => list.map(([day, plays]) => ({ day, plays }));

  it('reports a running streak in whole weeks, never an exact day count', () => {
    const list: Array<[string, number]> = [];
    for (let d = 1; d <= 16; d++) list.push([`2026-09-${String(d).padStart(2, '0')}`, 2]);
    const set = streaksFrom(days(list), 1, '2026-09-16');

    expect(set.current_weeks).toBe(2);
    expect(set.longest).toEqual({ days: null, weeks: 2, from: '2026-09', to: '2026-09', running: true });
  });

  it('keeps the exact length of a finished streak, by month', () => {
    const set = streaksFrom(
      days([
        ['2024-08-30', 1],
        ['2024-08-31', 1],
        ['2024-09-01', 1],
        ['2024-09-05', 1],
      ]),
      1,
      '2024-09-08',
    );
    expect(set.current_weeks).toBe(0);
    expect(set.longest).toEqual({ days: 3, weeks: 0, from: '2024-08', to: '2024-09', running: false });
    expect(set.active_share).toBeCloseTo(4 / 10);
  });

  it('never calls a past year\'s streak running, even one that reaches 31 December', () => {
    const list: Array<[string, number]> = [];
    for (let d = 20; d <= 31; d++) list.push([`2024-12-${d}`, 1]);
    const set = streaksFrom(days(list), 1, '2024-12-31', { live: false, firstDay: '2024-01-01' });

    expect(set.current_weeks).toBe(0);
    expect(set.longest).toEqual({ days: 12, weeks: 1, from: '2024-12', to: '2024-12', running: false });
    expect(set.active_share).toBeCloseTo(12 / 366);
  });

  it('breaks a streak on a day below the threshold', () => {
    const set = streaksFrom(
      days([
        ['2026-09-29', 12],
        ['2026-09-30', 4],
        ['2026-10-01', 15],
      ]),
      10,
      '2026-10-04',
    );
    expect(set.top.map((s) => s.days)).toEqual([1, 1]);
  });
});

describe('rhythm', () => {
  it('stops at the start of this week, so nothing ticks over day to day', async () => {
    const now = Date.now();
    await seed([...session('old', now - 30 * DAY, 3), ...session('today', now - 60_000, 3)]);
    const body = (await (await stat('rhythm')).json()) as { as_of: string };
    const cutoff = Date.parse(body.as_of);

    expect(cutoff).toBeLessThanOrEqual(now);
    expect(now - cutoff).toBeLessThan(8 * DAY);
    // Monday, local midnight in the current era.
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', weekday: 'short' }).format(cutoff)).toBe('Mon');
  });
});

describe('top over time', () => {
  it('names each song by its most-played edition, which /api/track opens as the whole song', async () => {
    // Mid-quarter, so both editions land in the same quarter and year.
    const start = Date.UTC(2025, 4, 15, 12);
    await seed([
      ...session('single', start, 3, { artist: 'Porter Robinson' }),
      ...session('album', start + 60 * 60_000, 5, { artist: 'Porter Robinson' }),
    ]);
    await env.DB.prepare("UPDATE tracks SET name = 'Divinity' WHERE track_id IN ('single', 'album')").run();

    const body = (await (await stat('top-over-time')).json()) as {
      quarters: Array<{ tracks: Array<{ track_id: string; name: string; plays: number }> }>;
      years: Array<{ tracks: Array<{ track_id: string; name: string; plays: number }> }>;
    };
    const songs = [...body.quarters, ...body.years].flatMap((period) => period.tracks);
    expect(songs.length).toBeGreaterThan(0);
    for (const song of songs) expect(song).toMatchObject({ track_id: 'album', name: 'Divinity', plays: 8 });

    const track = (await (await SELF.fetch(`${BASE}/api/track?id=album`, { headers: READ })).json()) as { plays: number };
    expect(track.plays).toBe(8);
  });
});

describe('on repeat', () => {
  // On repeat counts whole local days up to the midnight that started today.
  // Plays seeded relative to `now` straddle that midnight for part of each day
  // (late evening in Singapore), so they are placed at local noon instead, and
  // the clock is held so the route sees the same today.
  let localNoon: (daysAgo: number) => number;
  beforeEach(() => {
    const midnight = startOfLocalToday(ERAS, freezeClock(Date.now()));
    localNoon = (daysAgo) => midnight - daysAgo * DAY + 12 * 3_600_000;
  });

  it('lists a song played across several days, not one looped evening', async () => {
    await seed([
      ...session('spread', localNoon(1), 2),
      ...session('spread', localNoon(4), 2),
      ...session('spread', localNoon(8), 2),
      ...session('loop', localNoon(2), 12),
    ]);

    const body = (await (await stat('on-repeat')).json()) as { tracks: Array<{ track_id: string; days: number; plays: number; daily: number[] }> };

    expect(body.tracks.map((t) => t.track_id)).toEqual(['spread']);
    expect(body.tracks[0]).toMatchObject({ plays: 6, days: 3 });
    expect(body.tracks[0]!.daily).toHaveLength(14);
    expect(body.tracks[0]!.daily.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it('ignores plays too short to be listens', async () => {
    // Ten-second gaps: every play after the first ended seconds after the last.
    const skips: Play[] = [];
    for (const day of [1, 3, 5]) {
      for (let i = 0; i < 4; i++) skips.push({ ms: localNoon(day) + i * 10_000, trackId: 'skipped' });
    }
    await seed(skips);

    const body = (await (await stat('on-repeat')).json()) as { tracks: unknown[] };
    expect(body.tracks).toEqual([]);
  });
});

describe('top albums', () => {
  it('ranks albums listened to as albums, not one song on loop', async () => {
    const start = Date.now() - 60 * DAY;
    const record = ['r1', 'r2', 'r3', 'r4'].flatMap((id, i) =>
      session(id, start + i * DAY, 3, { album: 'record', artist: 'Band' }),
    );
    const single = session('single', start, 40, { album: 'single', artist: 'Band' });
    await seed([...record, ...single]);

    const body = (await (await stat('albums')).json()) as {
      min_songs: number;
      albums: Array<{ name: string; artist: string; plays: number; songs: number; from: string; to: string }>;
    };

    expect(body.min_songs).toBe(4);
    expect(body.albums).toEqual([
      expect.objectContaining({ name: 'Album record', artist: 'Band', plays: 12, songs: 4 }),
    ]);
    expect(body.albums[0]!.from).toMatch(/^\d{4}-\d{2}$/);
  });

  it('gives the same list for each calendar year', async () => {
    const year = (y: number) => Date.UTC(y, 5, 1);
    const album = (y: number, plays: number) =>
      ['a', 'b', 'c', 'd'].flatMap((id, i) => session(`${y}${id}`, year(y) + i * DAY, plays, { album: `lp${y}`, artist: 'Band' }));
    await seed([...album(2022, 2), ...album(2023, 5)]);

    const body = (await (await stat('albums')).json()) as {
      years: Array<{ year: string; partial: boolean; albums: Array<{ name: string; plays: number }> }>;
    };
    expect(body.years.map((y) => [y.year, y.partial, y.albums.map((a) => [a.name, a.plays])])).toEqual([
      ['2022', false, [['Album lp2022', 8]]],
      ['2023', false, [['Album lp2023', 20]]],
    ]);
  });
});

describe('artist drift', () => {
  it('measures change as the share of listening that moved', () => {
    const a = new Map([
      ['x', 50],
      ['y', 50],
    ]);
    const b = new Map([
      ['y', 50],
      ['z', 50],
    ]);
    expect(totalVariation(a, a)).toBe(0);
    expect(totalVariation(a, b)).toBeCloseTo(0.5);
  });

  it('compares whole months and leaves the move month out of both sides', async () => {
    const move = new Date(MOVE_MS);
    const moveMonth = move.getUTCFullYear() * 12 + move.getUTCMonth();
    const now = new Date(freezeClock(Date.now()));
    const n = now.getUTCFullYear() * 12 + now.getUTCMonth() - moveMonth - 1;
    const key = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
    await seed([...session('nc', MOVE_MS - 40 * DAY, 3), ...session('sg', MOVE_MS + 40 * DAY, 3)]);

    const body = (await (await stat('eras')).json()) as {
      move_month: string;
      window_months: number;
      latest: { from: string; to: string };
      latest_era: { key: string; label: string };
      previous_era: { key: string; label: string };
      before: { from: string; to: string };
    };
    expect(body.move_month).toBe(key(moveMonth));
    expect(body.window_months).toBe(n);
    expect(body.latest).toEqual({ from: key(moveMonth + 1), to: key(moveMonth + n) });
    expect(body.latest_era).toEqual({ key: 'abroad', label: 'Abroad' });
    expect(body.previous_era).toEqual({ key: 'home', label: 'Home' });
    expect(body.before).toEqual({ from: key(moveMonth - n), to: key(moveMonth - 1) });
  });
});

describe('snapshots', () => {
  it('computes once, then serves the stored body', async () => {
    await seed(session('t1', Date.now() - DAY, 3));

    const first = await stat('rhythm');
    expect(first.headers.get('X-Stats-Source')).toBe('computed');
    const firstBody = await first.text();

    await (await caches.open('stats')).delete(edgeRequest(statKey('rhythm', ERAS)));
    const second = await stat('rhythm');
    expect(second.headers.get('X-Stats-Source')).toBe('snapshot');
    expect(await second.text()).toBe(firstBody);

    const third = await stat('rhythm');
    expect(third.headers.get('X-Stats-Source')).toBe('edge');
  });

  it('serves a stale body at once and lets only one request claim the refresh', async () => {
    // Rhythm stays fresh until its weekly cut-off settles; eight days back is
    // always before the latest one.
    const old = Date.now() - 8 * DAY;
    await env.DB.prepare('INSERT INTO stats_snapshots (key, body, computed_ms) VALUES (?, ?, ?)')
      .bind(statKey('rhythm', ERAS), '{"stale":true}', old)
      .run();

    const response = await stat('rhythm');
    expect(response.headers.get('X-Stats-Source')).toBe('stale');
    expect(await response.json()).toEqual({ stale: true });

    const row = await env.DB.prepare('SELECT claimed_until_ms, computed_ms FROM stats_snapshots WHERE key = ?')
      .bind(statKey('rhythm', ERAS))
      .first<{ claimed_until_ms: number | null; computed_ms: number }>();
    // Either still claimed or already refreshed (the claim clears on store).
    expect(row!.claimed_until_ms !== null || row!.computed_ms > old).toBe(true);
  });

  it('does not compute a key someone else has claimed, even when nothing is cached yet', async () => {
    // Another isolate is mid-compute (or backing off from a failure).
    await env.DB.prepare('INSERT INTO stats_snapshots (key, claimed_until_ms) VALUES (?, ?)')
      .bind(statKey('albums', ERAS), Date.now() + 60_000)
      .run();

    const response = await stat('albums');
    expect(response.status).toBe(503);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    const row = await env.DB.prepare('SELECT body FROM stats_snapshots WHERE key = ?')
      .bind(statKey('albums', ERAS))
      .first<{ body: string | null }>();
    expect(row!.body).toBeNull();
  });

  it('takes over a claim that has lapsed', async () => {
    await env.DB.prepare('INSERT INTO stats_snapshots (key, claimed_until_ms) VALUES (?, ?)')
      .bind(statKey('eras', ERAS), Date.now() - 1)
      .run();
    const response = await stat('eras');
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Stats-Source')).toBe('computed');
  });

  it('ignores the query string, so it cannot force a recompute', async () => {
    await seed(session('t1', Date.now() - DAY, 3));
    await stat('eras');
    const response = await SELF.fetch(`${BASE}/api/stats/eras?bust=${Math.random()}`, { headers: READ });
    expect(response.headers.get('X-Stats-Source')).toBe('edge');
  });
});

describe('stat freshness follows each stat\'s cut-off', () => {
  const HOUR = 3_600_000;
  const singapore = [{ timeZone: 'Asia/Singapore', fromMs: 0 }] as unknown as readonly Era[];
  // Monday 12 Oct 2026, 00:00 in Singapore.
  const monday = Date.UTC(2026, 9, 11, 16);

  it('keeps a weekly stat fresh until six hours after the next Monday', () => {
    const fresh = (now: number) => freshForSeconds(startOfLocalWeek, singapore, now) * 1000;
    // Wednesday: anything computed since Monday 06:00 is fresh.
    const wednesday = monday + 2 * 24 * HOUR;
    expect(wednesday - fresh(wednesday)).toBe(monday + 6 * HOUR);
    // Next Monday 03:00, still settling: last week's cut-off still applies.
    const nextMonday = monday + 7 * 24 * HOUR;
    expect(nextMonday + 3 * HOUR - fresh(nextMonday + 3 * HOUR)).toBe(monday + 6 * HOUR);
    // Next Monday 07:00: settled, so last week's body is now stale.
    expect(nextMonday + 7 * HOUR - fresh(nextMonday + 7 * HOUR)).toBe(nextMonday + 6 * HOUR);
  });

  it('keeps a daily stat fresh until six hours after local midnight', () => {
    const noon = monday + 12 * HOUR;
    expect(noon - freshForSeconds(startOfLocalToday, singapore, noon) * 1000).toBe(monday + 6 * HOUR);
  });
});
