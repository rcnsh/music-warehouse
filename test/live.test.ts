import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, seedAuthorized } from './helpers';

const BASE = 'https://warehouse.test';
const ADMIN = { Authorization: 'Bearer test-admin-token' };
const READ = { Authorization: 'Bearer test-read-token' };

function stubSpotify(handler: (url: URL) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(url.pathname + url.search);
      return handler(url);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('read-only token (R11)', () => {
  it('reaches every /api route', async () => {
    await seedAuthorized();
    for (const path of ['/api/plays', '/api/top-artists', '/api/daily']) {
      const response = await SELF.fetch(`${BASE}${path}`, { headers: READ });
      expect(response.status, path).toBe(200);
    }
  });

  it('cannot reach anything that writes, polls, or reveals connection state', async () => {
    for (const [method, path] of [
      ['GET', '/health'],
      ['GET', '/login'],
      ['POST', '/admin/poll'],
      ['POST', '/admin/import'],
      ['GET', '/admin/raw'],
    ] as const) {
      const response = await SELF.fetch(`${BASE}${path}`, { method, headers: READ });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('still rejects an unknown token outright', async () => {
    const response = await SELF.fetch(`${BASE}/api/plays`, { headers: { Authorization: 'Bearer nope' } });
    expect(response.status).toBe(401);
  });
});

describe('GET /api/now-playing', () => {
  it('passes Spotify\'s payload through unmodified', async () => {
    await seedAuthorized();
    const item = { name: 'Kids', artists: [{ name: 'MGMT' }] };
    const calls = stubSpotify(() => jsonResponse({ is_playing: true, progress_ms: 1000, item }));

    const body = (await (await SELF.fetch(`${BASE}/api/now-playing`, { headers: READ })).json()) as {
      item: { is_playing: boolean; item: typeof item };
    };

    expect(calls).toEqual(['/v1/me/player/currently-playing']);
    expect(body.item.item).toEqual(item);
  });

  it('reports idle as null rather than an error when Spotify returns 204', async () => {
    await seedAuthorized();
    stubSpotify(() => new Response(null, { status: 204 }));

    const response = await SELF.fetch(`${BASE}/api/now-playing`, { headers: READ });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ item: null });
  });

  it('returns 503 with needs_reauth when the grant is dead', async () => {
    await seedAuthorized();
    await env.DB.prepare('UPDATE oauth_token SET needs_reauth = 1 WHERE id = 1').run();

    const response = await SELF.fetch(`${BASE}/api/now-playing`, { headers: READ });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ needs_reauth: true });
  });

  it('surfaces a Spotify rate limit as 429, not a blank 500', async () => {
    await seedAuthorized();
    stubSpotify(() => new Response('{}', { status: 429 }));

    const response = await SELF.fetch(`${BASE}/api/now-playing`, { headers: READ });
    expect(response.status).toBe(429);
  });
});

describe('GET /api/top', () => {
  it('fetches both lists for the requested range', async () => {
    await seedAuthorized();
    const calls = stubSpotify((url) =>
      jsonResponse({ items: [{ name: url.pathname.includes('tracks') ? 'a track' : 'an artist' }] }),
    );

    const body = (await (await SELF.fetch(`${BASE}/api/top?range=short_term&limit=5`, { headers: READ })).json()) as {
      range: string;
      limit: number;
      tracks: { items: Array<{ name: string }> };
      artists: { items: Array<{ name: string }> };
    };

    expect(body.range).toBe('short_term');
    expect(body.limit).toBe(5);
    expect(body.tracks.items[0]!.name).toBe('a track');
    expect(body.artists.items[0]!.name).toBe('an artist');
    expect(calls.sort()).toEqual([
      '/v1/me/top/artists?time_range=short_term&limit=5',
      '/v1/me/top/tracks?time_range=short_term&limit=5',
    ].sort());
  });

  it('falls back to long_term and a limit of 12 for junk input', async () => {
    await seedAuthorized();
    const calls = stubSpotify(() => jsonResponse({ items: [] }));

    await SELF.fetch(`${BASE}/api/top?range=last_tuesday&limit=9999`, { headers: READ });
    expect(calls.every((call) => call.includes('time_range=long_term&limit=12'))).toBe(true);
  });
});

describe('authorization scopes', () => {
  it('requests the scopes the live routes depend on', async () => {
    const response = await SELF.fetch(`${BASE}/login`, { headers: ADMIN, redirect: 'manual' });
    const scope = new URL(response.headers.get('Location')!).searchParams.get('scope');

    expect(scope).toContain('user-read-recently-played');
    expect(scope).toContain('user-read-currently-playing');
    expect(scope).toContain('user-top-read');
  });
});
