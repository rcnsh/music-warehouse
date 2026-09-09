import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { normalizeExport } from '../src/import';
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

  it('reports rows_read so query cost can be checked against D1 free-tier limits', async () => {
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
