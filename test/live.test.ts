import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSpotify } from './fake-spotify';
import { jsonResponse, seedAuthorized } from './helpers';

const BASE = 'https://warehouse.test';
const ADMIN = { Authorization: 'Bearer test-admin-token' };
const READ = { Authorization: 'Bearer test-read-token' };

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
});

describe('GET /api/now-playing', () => {
  it('passes Spotify\'s payload through unmodified', async () => {
    const item = { name: 'Kids', artists: [{ name: 'MGMT' }] };
    const calls = fakeSpotify(() => jsonResponse({ is_playing: true, progress_ms: 1000, item })).paths;

    const body = (await (await SELF.fetch(`${BASE}/api/now-playing`, { headers: READ })).json()) as {
      item: { is_playing: boolean; item: typeof item };
    };

    expect(calls).toEqual(['/me/player/currently-playing']);
    expect(body.item.item).toEqual(item);
  });

  it('shares one Spotify call between polls a few seconds apart, but not a failure', async () => {
    let status = 429;
    const calls = fakeSpotify(() => (status === 429 ? new Response('{}', { status }) : jsonResponse({ is_playing: true, item: { name: 'Kids' } }))).paths;
    expect((await SELF.fetch(`${BASE}/api/now-playing`, { headers: READ })).status).toBe(429);
    // The fake sets no pause, so the next request asks again: the 429 was not kept.
    status = 200;
    const first = await SELF.fetch(`${BASE}/api/now-playing`, { headers: READ });
    const second = await SELF.fetch(`${BASE}/api/now-playing`, { headers: ADMIN });
    expect(calls).toHaveLength(2);
    expect(second.headers.get('X-Cache')).toBe('hit');
    expect(second.headers.get('Cache-Control')).toBe('no-store');
    expect(await second.json()).toEqual(await first.json());
  });

  it('reports idle as null rather than an error when Spotify returns 204', async () => {
    fakeSpotify(() => new Response(null, { status: 204 }));

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
});

describe('GET /api/recently-played', () => {
  it('asks Spotify for the latest play only, by default', async () => {
    const items = [{ played_at: '2026-01-01T00:00:00.000Z', track: { name: 'Kids' } }];
    const calls = fakeSpotify(() => jsonResponse({ items })).paths;

    const response = await SELF.fetch(`${BASE}/api/recently-played`, { headers: READ });

    // One page of 50 is fetched and kept; the client gets the first.
    expect(calls).toEqual(['/me/player/recently-played?limit=50']);
    expect(await response.json()).toEqual({ items });
  });

  it('rejects a bad limit with 400, as the stored-data routes do, without asking Spotify', async () => {
    const calls = fakeSpotify(() => jsonResponse({ items: [] })).paths;

    for (const limit of ['500', '0', 'abc', '2.5']) {
      const response = await SELF.fetch(`${BASE}/api/recently-played?limit=${limit}`, { headers: READ });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/limit/);
    }
    expect(calls).toEqual([]);
  });

  it('serves every limit from one kept page, sliced as Spotify would have answered', async () => {
    const played = (i: number) => new Date(Date.UTC(2026, 9, 16, 12) - i * 60_000).toISOString();
    const items = Array.from({ length: 50 }, (_, i) => ({ played_at: played(i), track: { name: `Song ${i}` } }));
    const page = {
      items,
      limit: 50,
      href: 'https://api.spotify.com/v1/me/player/recently-played?limit=50',
      next: 'https://api.spotify.com/v1/me/player/recently-played?before=1&limit=50',
      cursors: { after: String(Date.parse(played(0))), before: String(Date.parse(played(49))) },
    };
    const calls = fakeSpotify(() => jsonResponse(page)).paths;

    const one = await SELF.fetch(`${BASE}/api/recently-played?limit=1`, { headers: READ });
    expect(one.headers.get('X-Cache')).toBe('miss');
    expect(await one.json()).toEqual({
      items: items.slice(0, 1),
      limit: 1,
      href: 'https://api.spotify.com/v1/me/player/recently-played?limit=1',
      next: 'https://api.spotify.com/v1/me/player/recently-played?before=1&limit=1',
      cursors: { after: page.cursors.after, before: String(Date.parse(played(0))) },
    });

    const ten = await SELF.fetch(`${BASE}/api/recently-played?limit=10`, { headers: READ });
    expect(ten.headers.get('X-Cache')).toBe('hit');
    expect(((await ten.json()) as { items: unknown[] }).items).toEqual(items.slice(0, 10));
    const all = await SELF.fetch(`${BASE}/api/recently-played?limit=50`, { headers: READ });
    expect(await all.json()).toEqual(page);
    expect(calls).toHaveLength(1);
  });
});

describe('GET /api/top', () => {
  it('fetches both lists for the requested range', async () => {
    const calls = fakeSpotify((call) =>
      jsonResponse({ items: [{ name: call.path.includes('tracks') ? 'a track' : 'an artist' }] }),
    ).paths;

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
      '/me/top/artists?time_range=short_term&limit=50',
      '/me/top/tracks?time_range=short_term&limit=50',
    ].sort());
  });

  it('fetches only artists for type=artists', async () => {
    const calls = fakeSpotify(() => jsonResponse({ items: [{ name: 'an artist' }] })).paths;

    const body = (await (await SELF.fetch(`${BASE}/api/top?range=medium_term&limit=50&type=artists`, { headers: READ })).json()) as {
      tracks: unknown;
      artists: { items: Array<{ name: string }> };
    };

    expect(body.tracks).toBeNull();
    expect(body.artists.items[0]!.name).toBe('an artist');
    expect(calls).toEqual(['/me/top/artists?time_range=medium_term&limit=50']);
  });

  it('defaults to long_term and a limit of 12', async () => {
    const calls = fakeSpotify(() => jsonResponse({ items: Array.from({ length: 50 }, (_, i) => ({ name: `#${i}` })) })).paths;

    const body = (await (await SELF.fetch(`${BASE}/api/top`, { headers: READ })).json()) as {
      limit: number;
      tracks: { items: unknown[] };
    };
    expect(calls.length).toBe(2);
    expect(calls.every((call) => call.includes('time_range=long_term&limit=50'))).toBe(true);
    expect(body.limit).toBe(12);
    expect(body.tracks.items).toHaveLength(12);
  });

  it('serves every limit and repeat from one kept page per list and range', async () => {
    const href = (limit: number, offset = 0) =>
      `https://api.spotify.com/v1/me/top/artists?time_range=short_term&limit=${limit}&offset=${offset}`;
    const items = Array.from({ length: 50 }, (_, i) => ({ name: `Artist ${i}` }));
    const page = { items, limit: 50, offset: 0, total: 80, href: href(50), next: href(50, 50), previous: null };
    const calls = fakeSpotify(() => jsonResponse(page)).paths;

    const five = await SELF.fetch(`${BASE}/api/top?range=short_term&type=artists&limit=5`, { headers: READ });
    expect(five.headers.get('X-Cache')).toBe('miss');
    expect(((await five.json()) as { artists: unknown }).artists).toEqual({
      ...page,
      items: items.slice(0, 5),
      limit: 5,
      href: href(5),
      next: href(5, 5),
    });

    for (let n = 0; n < 5; n++) {
      const again = await SELF.fetch(`${BASE}/api/top?range=short_term&type=artists&limit=20`, { headers: READ });
      expect(again.headers.get('X-Cache')).toBe('hit');
      expect(((await again.json()) as { artists: { items: unknown[] } }).artists.items).toEqual(items.slice(0, 20));
    }
    expect(calls).toEqual(['/me/top/artists?time_range=short_term&limit=50']);
  });

  it('rejects a bad range, limit or type with 400 without asking Spotify', async () => {
    const calls = fakeSpotify(() => jsonResponse({ items: [] })).paths;

    for (const [query, field] of [
      ['range=last_tuesday', /range/],
      ['limit=9999', /limit/],
      ['limit=x', /limit/],
      ['type=albums', /type/],
    ] as const) {
      const response = await SELF.fetch(`${BASE}/api/top?${query}`, { headers: READ });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(field);
    }
    expect(calls).toEqual([]);
  });
});

describe('GET /api/top edition relabelling', () => {
  const COVER = (id: string) => `https://i.scdn.co/image/ab67616d0000b273${id}`;

  async function seedPlays(rows: Array<{ track: string; album: string; isrc: string | null; plays: number }>) {
    const statements = [
      env.DB.prepare("INSERT OR IGNORE INTO artists (artist_id, name) VALUES ('kdot', 'Kendrick Lamar')"),
    ];
    let at = 1;
    for (const row of rows) {
      statements.push(
        env.DB.prepare('INSERT OR IGNORE INTO albums (album_id, name, image_url) VALUES (?, ?, ?)').bind(
          row.album,
          row.album === 'std' ? 'gkmc' : 'gkmc (Deluxe)',
          COVER(row.album),
        ),
        env.DB.prepare('INSERT INTO tracks (track_id, name, album_id, isrc, first_seen_ms) VALUES (?, ?, ?, ?, 0)').bind(
          row.track,
          'Money Trees',
          row.album,
          row.isrc,
        ),
        env.DB.prepare("INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, 'kdot', 0)").bind(row.track),
      );
      for (let n = 0; n < row.plays; n++) {
        statements.push(env.DB.prepare('INSERT INTO plays (played_at_ms, track_id) VALUES (?, ?)').bind(at++, row.track));
      }
    }
    await env.DB.batch(statements);
  }

  async function topTrack(item: object) {
    fakeSpotify((call) => jsonResponse({ items: call.path.includes('tracks') ? [item] : [] }));
    const body = (await (await SELF.fetch(`${BASE}/api/top`, { headers: READ })).json()) as {
      tracks: { items: Array<{ album: { id: string; name: string; images: Array<{ url: string; width: number }> } }> };
    };
    return body.tracks.items[0]!;
  }

  const deluxeEntry = {
    name: 'Money Trees',
    external_ids: { isrc: 'USUM71210785' },
    artists: [{ id: 'kdot' }],
    album: { id: 'dlx', name: 'gkmc (Deluxe)', images: [{ url: COVER('dlx'), width: 640 }] },
  };

  it('labels a track with the edition it was played from most', async () => {
    await seedPlays([
      { track: 't-std', album: 'std', isrc: 'USUM71210785', plays: 5 },
      { track: 't-dlx', album: 'dlx', isrc: 'USUM71210785', plays: 1 },
    ]);

    const track = await topTrack(deluxeEntry);
    expect(track.album.id).toBe('std');
    expect(track.album.name).toBe('gkmc');
    expect(track.album.images.map((i) => i.width)).toEqual([640, 300, 64]);
    expect(track.album.images[2]!.url).toBe('https://i.scdn.co/image/ab67616d00004851std');
  });

  it('matches by name and lead artist when the stored track has no ISRC', async () => {
    await seedPlays([{ track: 't-std', album: 'std', isrc: null, plays: 3 }]);

    expect((await topTrack(deluxeEntry)).album.id).toBe('std');
  });

  it('does not count a same-named copy of a different recording', async () => {
    await seedPlays([{ track: 't-std', album: 'std', isrc: 'USUM71299999', plays: 3 }]);

    expect((await topTrack(deluxeEntry)).album.id).toBe('dlx');
  });

  it("keeps Spotify's label when that edition is played as much", async () => {
    await seedPlays([
      { track: 't-std', album: 'std', isrc: 'USUM71210785', plays: 2 },
      { track: 't-dlx', album: 'dlx', isrc: 'USUM71210785', plays: 2 },
    ]);

    expect((await topTrack(deluxeEntry)).album.id).toBe('dlx');
  });
});

describe('authorization scopes', () => {
  it('requests the scopes the live routes depend on', async () => {
    const response = await SELF.fetch(`${BASE}/login`, { headers: ADMIN, redirect: 'manual' });
    const scope = new URL(response.headers.get('Location')!).searchParams.get('scope');

    expect(scope).toContain('user-read-recently-played');
    expect(scope).toContain('user-read-currently-playing');
    expect(scope).toContain('user-top-read');
    expect(scope).toContain('user-modify-playback-state');
  });
});

describe('POST /control/play', () => {
  const CONTROL = { Authorization: 'Bearer test-control-token' };
  const TRACK = '6PCUP3dWmTjcTtXY02oFdT';

  function playRequest(headers: Record<string, string>, body: unknown = { track_id: TRACK }) {
    return SELF.fetch(`${BASE}/control/play`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** `response` answers the play command; a track lookup gets `track` (default: none). */
  function stubPlayer(response: () => Response, track: () => Response = () => new Response('{}', { status: 404 })) {
    return fakeSpotify((call) => (call.path.startsWith('/tracks/') ? track() : response())).calls;
  }

  async function storeTrack(albumId: string | null) {
    await env.DB.prepare('INSERT INTO tracks (track_id, name, duration_ms, album_id, first_seen_ms) VALUES (?, ?, ?, ?, ?)')
      .bind(TRACK, 'Kids', 200_000, albumId, Date.now())
      .run();
  }

  it('starts the track inside its stored album, asking Spotify nothing else', async () => {
    await storeTrack('1V8Qu6CwkBfYucnCWxynq8');
    const sent = stubPlayer(() => new Response(null, { status: 204 }));

    const response = await playRequest(CONTROL);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ playing: TRACK });
    expect(sent).toEqual([
      {
        source: 'play',
        method: 'PUT',
        path: '/me/player/play',
        body: { context_uri: 'spotify:album:1V8Qu6CwkBfYucnCWxynq8', offset: { uri: `spotify:track:${TRACK}` } },
      },
    ]);
  });

  it('drops the shared now-playing answer, which still names the old track', async () => {
    await storeTrack('1V8Qu6CwkBfYucnCWxynq8');
    const now = Date.now();
    await env.DB.prepare('INSERT INTO spotify_answers (key, body, fetched_ms, fresh_until_ms) VALUES (?, ?, ?, ?)')
      .bind('now-playing', '{"is_playing":true,"item":{"name":"Old"}}', now, now + 30_000)
      .run();
    stubPlayer(() => new Response(null, { status: 204 }));

    expect((await playRequest(CONTROL)).status).toBe(200);
    const kept = await env.DB.prepare("SELECT body FROM spotify_answers WHERE key = 'now-playing'").first();
    expect(kept).toBeNull();
  });

  it('asks Spotify for the album of a track stored without one', async () => {
    await storeTrack(null);
    const sent = stubPlayer(
      () => new Response(null, { status: 204 }),
      () => jsonResponse({ id: TRACK, album: { id: '0Oq3mWfexhsjUh0aNNBB5u' } }),
    );

    expect((await playRequest(CONTROL)).status).toBe(200);
    expect(sent.map((call) => call.path)).toEqual([`/tracks/${TRACK}`, '/me/player/play']);
    expect(sent[1]!.body).toMatchObject({ context_uri: 'spotify:album:0Oq3mWfexhsjUh0aNNBB5u' });
  });

  it('falls back to the bare track when no album can be found', async () => {
    const sent = stubPlayer(() => new Response(null, { status: 204 }));

    expect((await playRequest(CONTROL)).status).toBe(200);
    expect(sent.at(-1)).toEqual({ source: 'play', method: 'PUT', path: '/me/player/play', body: { uris: [`spotify:track:${TRACK}`] } });
  });

  it('is refused to a read token, and is all a control token reaches', async () => {
    const sent = stubPlayer(() => new Response(null, { status: 204 }));

    expect((await playRequest(READ)).status).toBe(401);
    for (const [method, path] of [
      ['GET', '/api/plays'],
      ['GET', '/api/now-playing'],
      ['GET', '/health'],
      ['POST', '/admin/poll'],
      ['GET', '/admin/tokens'],
    ] as const) {
      const response = await SELF.fetch(`${BASE}${path}`, { method, headers: CONTROL });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(sent).toEqual([]);
  });

  it('is open to the admin token', async () => {
    stubPlayer(() => new Response(null, { status: 204 }));
    expect((await playRequest(ADMIN)).status).toBe(200);
  });

  it.each([{}, { track_id: 'spotify:track:abc' }, { track_id: 42 }, null])('refuses %j without calling Spotify', async (body) => {
    const sent = stubPlayer(() => new Response(null, { status: 204 }));
    expect((await playRequest(CONTROL, body)).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('says when no device is active', async () => {
    stubPlayer(() => jsonResponse({ error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }, { status: 404 }));

    const response = await playRequest(CONTROL);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'no_active_device' });
  });

  it.each([
    ['Player command failed: Premium required', 'PREMIUM_REQUIRED', 'premium_required'],
    ['Insufficient client scope', undefined, 'missing_scope'],
  ])('names a 403 (%s)', async (message, spotifyReason, reason) => {
    stubPlayer(() => jsonResponse({ error: { status: 403, message, reason: spotifyReason } }, { status: 403 }));

    const response = await playRequest(CONTROL);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason });
  });

  it('returns 503 with needs_reauth when the grant is dead', async () => {
    await seedAuthorized();
    await env.DB.prepare('UPDATE oauth_token SET needs_reauth = 1 WHERE id = 1').run();
    // The real transport, so the stored grant is read.
    const sent = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', sent);

    const response = await playRequest(CONTROL);
    expect(response.status).toBe(503);
    expect(sent).not.toHaveBeenCalled();
  });
});
