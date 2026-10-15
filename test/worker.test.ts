import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { normalizeExport } from '../src/import';
import { syncSearchIndex } from '../src/search-index';
import { seedAuthorized } from './helpers';

const BASE = 'https://warehouse.test';
const AUTH = { Authorization: 'Bearer test-admin-token' };

function get(path: string, init: RequestInit = {}) {
  return SELF.fetch(`${BASE}${path}`, { headers: AUTH, ...init });
}

/** Insert plays and their track/artist rows directly, bypassing the poller. */
async function seedPlays(plays: Array<{ ms: number; trackId: string; artistId?: string; artistName?: string }>) {
  const statements: D1PreparedStatement[] = [];
  for (const play of plays) {
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(
        play.ms,
        play.trackId,
        'api',
      ),
      env.DB.prepare('INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, first_seen_ms) VALUES (?, ?, ?, ?)').bind(
        play.trackId,
        `Track ${play.trackId}`,
        200_000,
        play.ms,
      ),
    );
    if (play.artistId) {
      statements.push(
        env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind(
          play.artistId,
          play.artistName ?? play.artistId,
        ),
        env.DB.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind(
          play.trackId,
          play.artistId,
        ),
      );
    }
  }
  await env.DB.batch(statements);
}

describe('authorization (R11)', () => {
  const protectedRoutes: Array<[string, string]> = [
    ['GET', '/health'],
    ['GET', '/login'],
    ['GET', '/api/plays'],
    ['GET', '/api/top-artists'],
    ['GET', '/api/daily'],
    ['POST', '/admin/poll'],
    ['POST', '/admin/import'],
  ];

  it.each(protectedRoutes)('rejects an unauthenticated %s %s with 401', async (method, path) => {
    const response = await SELF.fetch(`${BASE}${path}`, { method });
    expect(response.status).toBe(401);
  });

  it.each(protectedRoutes)('rejects a wrong bearer token on %s %s', async (method, path) => {
    const response = await SELF.fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: 'Bearer not-the-admin-token' },
    });
    expect(response.status).toBe(401);
  });

  it('leaves /callback reachable without the admin token', async () => {
    const response = await SELF.fetch(`${BASE}/callback`);
    expect(response.status).toBe(400); // missing code/state, not 401
  });
});

describe('CORS', () => {
  const WRAPPED = 'https://wrapped.test';

  it('answers a preflight from a listed origin without a token', async () => {
    const response = await SELF.fetch(`${BASE}/api/wrapped`, {
      method: 'OPTIONS',
      headers: { Origin: WRAPPED, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(WRAPPED);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization');
  });

  it('matches a listed origin written with a trailing slash', async () => {
    const response = await get('/api/plays', { headers: { ...AUTH, Origin: 'https://other.test' } });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://other.test');
  });

  it('marks an authenticated /api response readable by a listed origin', async () => {
    const response = await get('/api/plays', { headers: { ...AUTH, Origin: WRAPPED } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(WRAPPED);
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
  });

  it('still requires the token from a listed origin', async () => {
    const response = await SELF.fetch(`${BASE}/api/plays`, { headers: { Origin: WRAPPED } });
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(WRAPPED);
  });

  it('says nothing to an origin that is not listed', async () => {
    const preflight = await SELF.fetch(`${BASE}/api/plays`, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } });
    expect(preflight.status).toBe(401);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const response = await get('/api/plays', { headers: { ...AUTH, Origin: 'https://evil.test' } });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('never opens the admin routes to another origin', async () => {
    const response = await get('/health', { headers: { ...AUTH, Origin: WRAPPED } });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('/health (R6)', () => {
  it('reports liveness, totals and token expiry', async () => {
    const now = Date.now();
    await seedAuthorized({ authorizedAtMs: now - 10 * 86_400_000 });
    await seedPlays([
      { ms: now - 3 * 3_600_000, trackId: 't1' },
      { ms: now - 40 * 86_400_000, trackId: 't2' },
    ]);
    await env.DB.prepare('UPDATE sync_state SET last_success_ms = ? WHERE id = 1').bind(now - 60_000).run();

    const body = (await (await get('/health')).json()) as Record<string, unknown>;

    expect(body.last_success_ms).toBe(now - 60_000);
    expect(body.total_plays).toBe(2);
    expect(body.plays_last_24h).toBe(1);
    // 183-day lifetime, 10 days elapsed, floored — so 172 or 173 depending on
    // where the few milliseconds of test runtime fall.
    expect(body.days_until_token_expiry as number).toBeGreaterThanOrEqual(172);
    expect(body.days_until_token_expiry as number).toBeLessThan(183);
    expect(body.needs_reauth).toBe(false);
  });

  it('states needs_reauth explicitly, with an action to take (R5)', async () => {
    await seedAuthorized();
    await env.DB.prepare('UPDATE oauth_token SET needs_reauth = 1 WHERE id = 1').run();
    const body = (await (await get('/health')).json()) as Record<string, unknown>;

    expect(body.needs_reauth).toBe(true);
    expect(body.ok).toBe(false);
    expect(String(body.action_required)).toContain('Re-authorize');
  });

  it('says so plainly before the first authorization', async () => {
    const body = (await (await get('/health')).json()) as Record<string, unknown>;
    expect(body.days_until_token_expiry).toBeNull();
    expect(body.authorized).toBe(false);
    expect(body.ok).toBe(false);
    expect(String(body.action_required)).toContain('/login');
  });
});

describe('read endpoints (R9)', () => {
  it('returns recent plays newest first with track and artist names', async () => {
    const base = Date.parse('2026-09-08T12:00:00Z');
    await seedPlays([
      { ms: base, trackId: 't1', artistId: 'a1', artistName: 'Alpha' },
      { ms: base + 60_000, trackId: 't2', artistId: 'a2', artistName: 'Beta' },
    ]);

    const body = (await (await get('/api/plays?limit=10')).json()) as {
      plays: Array<{ played_at_ms: number; track_name: string; artists: string }>;
    };

    expect(body.plays.map((play) => play.played_at_ms)).toEqual([base + 60_000, base]);
    expect(body.plays[0]!.track_name).toBe('Track t2');
    expect(body.plays[0]!.artists).toBe('Beta');
  });

  it('lists a track\'s artists in credit order', async () => {
    const ms = Date.parse('2026-09-08T12:00:00Z');
    await seedPlays([{ ms, trackId: 't1', artistId: 'a2', artistName: 'Second' }]);
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind('a1', 'First'),
      // Credited first, but inserted second — only `position` decides the order.
      env.DB.prepare('UPDATE track_artists SET position = 1 WHERE track_id = ? AND artist_id = ?').bind('t1', 'a2'),
      env.DB.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind('t1', 'a1'),
    ]);

    const body = (await (await get('/api/plays')).json()) as { plays: Array<{ artists: string }> };
    expect(body.plays[0]!.artists).toBe('First, Second');
  });

  it('buckets the same rows into different local days per timezone', async () => {
    // 16:30 UTC: the 8th in London, already the 9th in Singapore.
    await seedPlays([{ ms: Date.parse('2026-09-08T16:30:00Z'), trackId: 't1' }]);

    const london = (await (await get('/api/daily?from=2026-09-07&to=2026-09-10&tz=Europe/London')).json()) as {
      days: Array<{ day: string; plays: number }>;
    };
    const singapore = (await (await get('/api/daily?from=2026-09-07&to=2026-09-10&tz=Asia/Singapore')).json()) as {
      days: Array<{ day: string; plays: number }>;
    };

    expect(london.days.find((day) => day.plays > 0)!.day).toBe('2026-09-08');
    expect(singapore.days.find((day) => day.plays > 0)!.day).toBe('2026-09-09');
    // Quiet days are present as zeroes, not gaps.
    expect(london.days.map((day) => day.day)).toEqual(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']);
  });

  it('ranks artists by play count over a range, and respects the range bounds', async () => {
    const inRange = Date.parse('2026-09-08T12:00:00Z');
    const outOfRange = Date.parse('2026-08-01T12:00:00Z');
    await seedPlays([
      { ms: inRange, trackId: 't1', artistId: 'a1', artistName: 'Alpha' },
      { ms: inRange + 1000, trackId: 't2', artistId: 'a1', artistName: 'Alpha' },
      { ms: inRange + 2000, trackId: 't3', artistId: 'a2', artistName: 'Beta' },
      { ms: outOfRange, trackId: 't4', artistId: 'a3', artistName: 'Gamma' },
    ]);

    const body = (await (await get('/api/top-artists?from=2026-09-01&to=2026-09-30&tz=UTC')).json()) as {
      artists: Array<{ name: string; plays: number }>;
    };

    expect(body.artists).toEqual([
      { artist_id: 'a1', name: 'Alpha', plays: 2 },
      { artist_id: 'a2', name: 'Beta', plays: 1 },
    ]);
  });

  it('reports rows_read so query cost can be checked against D1 usage', async () => {
    await seedPlays([{ ms: Date.parse('2026-09-08T12:00:00Z'), trackId: 't1' }]);
    const body = (await (await get('/api/plays')).json()) as { _meta: { rows_read: number | null } };
    expect(body._meta.rows_read).not.toBeNull();
  });

  it('rejects an unknown timezone and a malformed date with 400', async () => {
    expect((await get('/api/daily?tz=Middle/Earth')).status).toBe(400);
    expect((await get('/api/daily?from=08-09-2026&tz=UTC')).status).toBe(400);
    expect((await get('/api/plays?limit=99999')).status).toBe(400);
  });
});

describe('searching plays with q', () => {
  const base = Date.parse('2026-05-01T12:00:00Z');

  /** Tracks with real names, an album and artists, so every searchable column has a value. */
  async function seedCatalog() {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO albums (album_id, name) VALUES (?, ?), (?, ?)').bind('al1', 'Worlds', 'al2', '100% Pure'),
      env.DB.prepare(
        'INSERT INTO tracks (track_id, name, duration_ms, album_id, first_seen_ms) VALUES (?, ?, 1, ?, 0), (?, ?, 1, ?, 0), (?, ?, 1, ?, 0), (?, ?, 1, NULL, 0)',
      ).bind('div', 'Divinity', 'al1', 'sad', 'Sad Machine', 'al1', 'pct', 'Under_score', 'al2', 'exp', 'Export Song'),
      env.DB.prepare('INSERT INTO artists (artist_id, name) VALUES (?, ?), (?, ?), (?, ?)').bind(
        'por',
        'Porter Robinson',
        'ami',
        'Amy Millan',
        'odd',
        'Odd Artist',
      ),
      env.DB.prepare(
        'INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0), (?, ?, 1), (?, ?, 0), (?, ?, 0), (?, ?, 0)',
      ).bind('div', 'por', 'div', 'ami', 'sad', 'por', 'pct', 'odd', 'exp', 'odd'),
    ]);
    // Six days of plays: Divinity on even days, the rest in between.
    const plays: D1PreparedStatement[] = [];
    for (let day = 0; day < 6; day++) {
      const ms = base + day * 86_400_000;
      plays.push(env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(ms, day % 2 ? 'sad' : 'div', 'api'));
      plays.push(env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(ms + 1, day % 2 ? 'pct' : 'exp', 'export'));
    }
    // Seeded straight into the tables, so build the name index as the daily sync would.
    await env.DB.batch([...plays, syncSearchIndex(env.DB)]);
  }

  async function search(query: string) {
    const response = await get(`/api/plays?${query}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { plays: Array<{ played_at_ms: number; track_id: string; artists: string }> }).plays;
  }

  it('matches track titles case-insensitively, newest first', async () => {
    await seedCatalog();
    const plays = await search('q=DIVINITY');
    expect(plays.map((p) => p.track_id)).toEqual(['div', 'div', 'div']);
    expect(plays.map((p) => p.played_at_ms)).toEqual([base + 4 * 86_400_000, base + 2 * 86_400_000, base]);
    // Rows keep the full shape, every credited artist included.
    expect(plays[0]!.artists).toBe('Porter Robinson, Amy Millan');
  });

  it('matches any credited artist and the album name', async () => {
    await seedCatalog();
    expect(new Set((await search('q=amy')).map((p) => p.track_id))).toEqual(new Set(['div']));
    expect(new Set((await search('q=porter')).map((p) => p.track_id))).toEqual(new Set(['div', 'sad']));
    expect(new Set((await search('q=worlds')).map((p) => p.track_id))).toEqual(new Set(['div', 'sad']));
  });

  it('finds export rows that have no album', async () => {
    await seedCatalog();
    expect((await search('q=export')).map((p) => p.track_id)).toEqual(['exp', 'exp', 'exp']);
  });

  it('pages through matches with before', async () => {
    await seedCatalog();
    const first = await search('q=porter&limit=4');
    expect(first).toHaveLength(4);
    const rest = await search(`q=porter&limit=4&before=${first.at(-1)!.played_at_ms}`);
    expect(rest).toHaveLength(2);
    expect(rest[0]!.played_at_ms).toBeLessThan(first.at(-1)!.played_at_ms);
  });

  it('treats % and _ in the query as literal characters', async () => {
    await seedCatalog();
    expect(new Set((await search('q=100%25')).map((p) => p.track_id))).toEqual(new Set(['pct']));
    expect(new Set((await search('q=r_s')).map((p) => p.track_id))).toEqual(new Set(['pct']));
    expect(await search('q=%25%25%25x')).toEqual([]);
  });

  it('returns an empty page for no match, and ignores a blank q', async () => {
    await seedCatalog();
    expect(await search('q=nothing-like-this')).toEqual([]);
    expect(await search('q=%20%20&limit=500')).toHaveLength(12);
  });

  it('walks plays newest first when many tracks match', async () => {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 600; i++) {
      statements.push(
        env.DB.prepare('INSERT INTO tracks (track_id, name, duration_ms, first_seen_ms) VALUES (?, ?, 1, 0)').bind(`m${i}`, `Common ${i}`),
        env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(base + i, `m${i}`, 'api'),
      );
    }
    await env.DB.batch([...statements, syncSearchIndex(env.DB)]);
    const plays = await search('q=common&limit=3');
    expect(plays.map((p) => p.track_id)).toEqual(['m599', 'm598', 'm597']);
  });

  it('echoes q so a client can tell the filter was applied', async () => {
    await seedCatalog();
    const body = (await (await get('/api/plays?q=porter')).json()) as { q?: string };
    expect(body.q).toBe('porter');
    const none = (await (await get('/api/plays?q=zzzzz')).json()) as { q?: string };
    expect(none.q).toBe('zzzzz');
    const plain = (await (await get('/api/plays')).json()) as { q?: string };
    expect(plain.q).toBeUndefined();
  });

  it('ignores accents and case beyond ASCII', async () => {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO tracks (track_id, name, duration_ms, first_seen_ms) VALUES (?, ?, 1, 0)').bind('apt', 'APT.'),
      env.DB.prepare('INSERT INTO artists (artist_id, name) VALUES (?, ?)').bind('rose', 'ROSÉ'),
      env.DB.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind('apt', 'rose'),
      env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(base, 'apt', 'api'),
      syncSearchIndex(env.DB),
    ]);
    expect((await search('q=rose')).map((p) => p.track_id)).toEqual(['apt']);
    expect((await search('q=ros%C3%A9')).map((p) => p.track_id)).toEqual(['apt']);
  });

  it('matches one and two character queries without the index', async () => {
    await seedCatalog();
    expect(new Set((await search('q=sa')).map((p) => p.track_id))).toEqual(new Set(['sad']));
  });

  it('treats a double quote in the query literally', async () => {
    await seedCatalog();
    expect(await search('q=%22porter')).toEqual([]);
  });

  it('rejects an overlong q', async () => {
    expect((await get(`/api/plays?q=${'x'.repeat(201)}`)).status).toBe(400);
  });
});

describe('export import (R10)', () => {
  it('maps export records and skips podcast/local rows without a track URI', () => {
    const rows = normalizeExport([
      { ts: '2024-03-01T10:00:00Z', spotify_track_uri: 'spotify:track:abc', master_metadata_track_name: 'Song' },
      { ts: '2024-03-01T11:00:00Z', spotify_track_uri: null, master_metadata_track_name: null },
      { ts: '2024-03-01T12:00:00Z', spotify_track_uri: 'spotify:episode:xyz' },
    ]);

    expect(rows.plays).toEqual([
      { played_at_ms: Date.parse('2024-03-01T10:00:00Z'), track_id: 'abc', source: 'export' },
    ]);
    expect(rows.skipped).toBe(2);
  });

  it('imports without creating duplicates against already-polled data', async () => {
    const overlapMs = Date.parse('2026-09-08T12:00:00Z');
    await seedPlays([{ ms: overlapMs, trackId: 'shared' }]);

    const records = [
      { ts: '2026-09-08T12:00:00Z', spotify_track_uri: 'spotify:track:shared', master_metadata_track_name: 'Shared' },
      { ts: '2024-01-01T09:00:00Z', spotify_track_uri: 'spotify:track:older', master_metadata_track_name: 'Older' },
      { ts: '2024-01-01T09:00:00Z', spotify_track_uri: 'spotify:track:older', master_metadata_track_name: 'Older' },
    ];

    const body = (await (await get('/admin/import', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    })).json()) as { received: number; inserted: number; duplicates: number };

    expect(body.received).toBe(3);
    // Only the genuinely new play lands: the overlap is ignored, and the two
    // identical records collapse to one row before the write.
    expect(body.inserted).toBe(1);

    const duplicates = await env.DB.prepare(
      'SELECT played_at_ms, track_id, COUNT(*) c FROM plays GROUP BY 1, 2 HAVING c > 1',
    ).all();
    expect(duplicates.results).toHaveLength(0);

    const bySource = await env.DB.prepare('SELECT source, COUNT(*) n FROM plays GROUP BY source').all<{
      source: string;
      n: number;
    }>();
    expect(bySource.results).toEqual([
      { source: 'api', n: 1 },
      { source: 'export', n: 1 },
    ]);
  });

  it('rejects an oversized chunk', async () => {
    const records = Array.from({ length: 2001 }, (_, i) => ({
      ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      spotify_track_uri: `spotify:track:t${i}`,
    }));
    const response = await get('/admin/import', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    });
    expect(response.status).toBe(400);
  });
});

describe('/login', () => {
  it('redirects to Spotify with the right scope and a stored state', async () => {
    // manual, or the test fetch would follow the redirect out to Spotify.
    const response = await get('/login', { redirect: 'manual' });
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(location.searchParams.get('scope')).toContain('user-read-recently-played');
    expect(location.searchParams.get('response_type')).toBe('code');

    const stored = await env.DB.prepare('SELECT state FROM oauth_state WHERE id = 1').first<{ state: string }>();
    expect(location.searchParams.get('state')).toBe(stored!.state);
  });

  it('refuses a callback whose state does not match', async () => {
    await get('/login');
    const response = await SELF.fetch(`${BASE}/callback?code=abc&state=wrong-state`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('State mismatch');
  });
});
