import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// READ_API is a service binding to this Worker's ReadApi entrypoint
// (miniflare.serviceBindings in vitest.config.ts), so these calls take the
// same path another Worker's would: no Authorization header at all.
const BASE = 'https://warehouse.test';

async function seed() {
  const ms = Date.UTC(2026, 0, 15, 12);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(ms, 't1', 'api'),
    env.DB.prepare('INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, first_seen_ms) VALUES (?, ?, ?, ?)').bind(
      't1',
      'Track t1',
      200_000,
      ms,
    ),
    env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind('a1', 'Artist a1'),
    env.DB.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind('t1', 'a1'),
  ]);
}

describe('ReadApi entrypoint', () => {
  it('serves /api/* without a token', async () => {
    await seed();
    const response = await env.READ_API.fetch(`${BASE}/api/plays?limit=5`);
    expect(response.status).toBe(200);
    const body = await response.json<{ plays: Array<{ track_id: string }> }>();
    expect(body.plays.map((play) => play.track_id)).toContain('t1');
  });

  it('answers the same as a bearer read', async () => {
    await seed();
    const query = '/api/top-artists?from=2026-01-01&to=2026-01-31';
    const viaBinding = await env.READ_API.fetch(`${BASE}${query}`);
    const viaToken = await SELF.fetch(`${BASE}${query}`, { headers: { Authorization: 'Bearer test-read-token' } });
    expect(viaBinding.status).toBe(200);
    expect(await viaBinding.json()).toEqual(await viaToken.json());
  });

  it('serves the stats routes as a read token does', async () => {
    await seed();
    const viaBinding = await env.READ_API.fetch(`${BASE}/api/stats/rhythm`);
    const viaToken = await SELF.fetch(`${BASE}/api/stats/rhythm`, { headers: { Authorization: 'Bearer test-read-token' } });
    expect(viaBinding.status).not.toBe(404);
    expect(viaBinding.status).toBe(viaToken.status);
    expect((await env.READ_API.fetch(`${BASE}/api/stats/no-such-stat`)).status).toBe(404);
  });

  it('holds Wrapped to read access: no computing a new range', async () => {
    await seed();
    const response = await env.READ_API.fetch(`${BASE}/api/wrapped?from=2026-01-03&to=2026-01-17`);
    expect(response.status).toBe(403);
  });

  it.each(['/api/now-playing', '/api/recently-played', '/api/top'])(
    'refuses the live Spotify route %s, which a read token reaches',
    async (route) => {
      const response = await env.READ_API.fetch(`${BASE}${route}`);
      expect(response.status).toBe(404);
    },
  );

  it.each([
    ['GET', '/health'],
    ['GET', '/admin/tokens'],
    ['POST', '/admin/tokens'],
    ['POST', '/admin/poll'],
    ['POST', '/control/play'],
    ['GET', '/auth/login'],
    ['GET', '/login'],
    ['GET', '/'],
  ])('does not reach %s %s', async (method, route) => {
    await seed();
    const before = await env.DB.prepare('SELECT * FROM sync_state').all();
    const response = await env.READ_API.fetch(`${BASE}${route}`, { method });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    const counts = await env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM api_tokens) AS tokens, (SELECT COUNT(*) FROM plays) AS plays',
    ).first<{ tokens: number; plays: number }>();
    expect(counts).toEqual({ tokens: 0, plays: 1 });
    expect((await env.DB.prepare('SELECT * FROM sync_state').all()).results).toEqual(before.results);
  });

  it('turns a bad request into a 400, as the bearer path does', async () => {
    const response = await env.READ_API.fetch(`${BASE}/api/top-artists?from=not-a-date`);
    expect(response.status).toBe(400);
  });
});
