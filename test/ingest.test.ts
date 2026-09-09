import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { poll } from '../src/ingest';
import {
  countPlays,
  countingDb,
  expectedFromFixture,
  jsonResponse,
  loadFixture,
  oauthToken,
  seedAuthorized,
  syncState,
  testEnv,
} from './helpers';

const TOKEN_HOST = 'https://accounts.spotify.com';

/** Route stubbed responses by URL, and record every outbound call. */
function stubFetch(handlers: {
  token?: () => Response | Promise<Response>;
  recentlyPlayed?: (url: URL) => Response | Promise<Response>;
}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === TOKEN_HOST) {
      calls.push('token');
      if (!handlers.token) throw new Error('Unexpected token request');
      return handlers.token();
    }
    calls.push(`recently-played${url.searchParams.has('after') ? `?after=${url.searchParams.get('after')}` : ''}`);
    if (!handlers.recentlyPlayed) throw new Error('Unexpected recently-played request');
    return handlers.recentlyPlayed(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('poll', () => {
  it('stores every play exactly once, and a replay of the same payload inserts nothing (R1, R2)', async () => {
    await seedAuthorized();
    const fixture = loadFixture();
    const expected = expectedFromFixture(fixture);
    stubFetch({ recentlyPlayed: () => jsonResponse(fixture) });

    const first = await poll(env);
    expect(first.ok).toBe(true);
    expect(first.inserted).toBe(expected.plays);
    // Items with no Spotify track id (local files) cannot be keyed.
    expect(first.skipped).toBe(expected.skipped);
    expect(await countPlays()).toBe(expected.plays);

    const second = await poll(env);
    expect(second.ok).toBe(true);
    expect(second.inserted).toBe(0);
    expect(await countPlays()).toBe(expected.plays);

    const duplicates = await env.DB.prepare(
      'SELECT played_at_ms, track_id, COUNT(*) c FROM plays GROUP BY 1, 2 HAVING c > 1',
    ).all();
    expect(duplicates.results).toHaveLength(0);
  });

  it('advances the cursor to the newest play, and sends it as `after` next time', async () => {
    await seedAuthorized();
    const fixture = loadFixture();
    const calls = stubFetch({ recentlyPlayed: () => jsonResponse(fixture) });

    const result = await poll(env);
    const newest = Math.max(...(fixture.items ?? []).filter((i) => i.track?.id).map((i) => Date.parse(i.played_at!)));
    expect(result.cursor_ms).toBe(newest);

    await poll(env);
    // First ever call omits `after` entirely rather than sending after=0.
    expect(calls[0]).toBe('recently-played');
    expect(calls[1]).toBe(`recently-played?after=${newest}`);
  });

  it('treats an empty window as success without moving the cursor', async () => {
    await seedAuthorized();
    stubFetch({ recentlyPlayed: () => jsonResponse({ items: [] }) });

    const result = await poll(env);
    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(0);

    const state = await syncState();
    expect(state!.cursor_ms).toBe(0);
    expect(state!.last_success_ms).not.toBeNull();
    expect(state!.consecutive_failures).toBe(0);
  });

  it('leaves the cursor untouched when the Spotify call fails (R3)', async () => {
    await seedAuthorized();
    const fixture = loadFixture();
    stubFetch({ recentlyPlayed: () => jsonResponse(fixture) });
    await poll(env);
    const cursorBefore = (await syncState())!.cursor_ms;
    expect(cursorBefore).toBeGreaterThan(0);

    vi.unstubAllGlobals();
    stubFetch({
      recentlyPlayed: () => {
        throw new Error('connection reset');
      },
    });

    const failed = await poll(env);
    expect(failed.ok).toBe(false);
    const state = await syncState();
    expect(state!.cursor_ms).toBe(cursorBefore);
    expect(state!.last_error).toContain('connection reset');
    expect(state!.consecutive_failures).toBe(1);
  });

  it('respects Retry-After and abandons the run on 429 (R7)', async () => {
    await seedAuthorized();
    stubFetch({
      recentlyPlayed: () =>
        new Response('{"error":{"status":429}}', { status: 429, headers: { 'Retry-After': '30' } }),
    });

    const result = await poll(env);
    expect(result.ok).toBe(false);
    expect(result.retry_after_seconds).toBe(30);
    expect((await syncState())!.cursor_ms).toBe(0);
  });

  it('records a quota-exceeded 429 distinctly from ordinary rate limiting', async () => {
    await seedAuthorized();
    stubFetch({
      recentlyPlayed: () =>
        new Response('{"error":{"status":429,"reason":"QUOTA_EXCEEDED"}}', { status: 429 }),
    });

    const result = await poll(env);
    expect(result.error).toContain('quota_exceeded');
    expect((await syncState())!.last_error).toContain('quota_exceeded');
  });

  it('records a 403 verbatim and does not retry it', async () => {
    await seedAuthorized();
    const calls = stubFetch({
      recentlyPlayed: () => new Response('{"error":{"status":403,"message":"User not registered"}}', { status: 403 }),
    });

    const result = await poll(env);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('forbidden');
    expect(calls.filter((call) => call.startsWith('recently-played'))).toHaveLength(1);
  });

  it('refreshes an expired access token and keeps the old refresh token when none is returned (R4)', async () => {
    await seedAuthorized({ accessExpiresMs: Date.now() - 1000 });
    stubFetch({
      token: () => jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 }),
      recentlyPlayed: () => jsonResponse({ items: [] }),
    });

    const result = await poll(env);
    expect(result.ok).toBe(true);

    const token = await oauthToken();
    expect(token!.access_token).toBe('fresh-access-token');
    // Spotify often omits refresh_token on a refresh; the stored one must survive.
    expect(token!.refresh_token).toBe('stored-refresh-token');
  });

  it('persists a rotated refresh token when one is returned (R4)', async () => {
    const authorizedAt = Date.now() - 10 * 86_400_000;
    await seedAuthorized({ accessExpiresMs: Date.now() - 1000, authorizedAtMs: authorizedAt });
    stubFetch({
      token: () => jsonResponse({ access_token: 'fresh', expires_in: 3600, refresh_token: 'rotated-refresh-token' }),
      recentlyPlayed: () => jsonResponse({ items: [] }),
    });

    await poll(env);

    const token = await oauthToken();
    expect(token!.refresh_token).toBe('rotated-refresh-token');
    // A refresh must not restart the six-month clock.
    expect(token!.authorized_at_ms).toBe(authorizedAt);
  });

  it('marks the connection as needing re-authorization on invalid_grant (R5)', async () => {
    await seedAuthorized({ accessExpiresMs: Date.now() - 1000 });
    stubFetch({
      token: () => new Response('{"error":"invalid_grant","error_description":"Refresh token revoked"}', { status: 400 }),
    });

    const result = await poll(env);
    expect(result.ok).toBe(false);
    expect(result.needs_reauth).toBe(true);

    const token = await oauthToken();
    expect(token!.needs_reauth).toBe(1);
    expect(token!.access_token).toBeNull();
  });

  it('stops polling once the connection is marked needs_reauth', async () => {
    await seedAuthorized();
    await env.DB.prepare('UPDATE oauth_token SET needs_reauth = 1 WHERE id = 1').run();
    const calls = stubFetch({});

    const result = await poll(env);
    expect(result.needs_reauth).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refreshes once and retries once after a 401 on the data call', async () => {
    await seedAuthorized();
    let dataCalls = 0;
    const calls = stubFetch({
      token: () => jsonResponse({ access_token: 'second-access-token', expires_in: 3600 }),
      recentlyPlayed: () => {
        dataCalls++;
        return dataCalls === 1 ? new Response('{}', { status: 401 }) : jsonResponse({ items: [] });
      },
    });

    const result = await poll(env);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['recently-played', 'token', 'recently-played']);
  });

  it('aborts after a second 401', async () => {
    await seedAuthorized();
    stubFetch({
      token: () => jsonResponse({ access_token: 'second-access-token', expires_in: 3600 }),
      recentlyPlayed: () => new Response('{}', { status: 401 }),
    });

    const result = await poll(env);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unauthorized');
  });

  it('writes every row in one batch and stays inside the subrequest budget (R12)', async () => {
    await seedAuthorized();
    const fixture = loadFixture();
    const fetchCalls = stubFetch({ recentlyPlayed: () => jsonResponse(fixture) });
    const { db, calls } = countingDb(env.DB);

    const result = await poll(testEnv({ DB: db }));
    expect(result.ok).toBe(true);

    // One batch for the write path — not one call per row.
    const batches = calls.filter((call) => call.startsWith('batch('));
    expect(batches).toHaveLength(2); // readState's paired SELECT, plus the write
    expect(calls.filter((call) => call.startsWith('INSERT') || call.startsWith('UPDATE'))).toHaveLength(0);

    const subrequests = calls.length + fetchCalls.length;
    expect(subrequests).toBeLessThanOrEqual(10);
  });

  it('never moves the cursor backwards when Spotify returns an older play', async () => {
    await seedAuthorized();
    stubFetch({
      recentlyPlayed: () =>
        jsonResponse({ items: [{ played_at: '2026-09-08T12:00:00Z', track: { id: 'later', name: 'Later' } }] }),
    });
    await poll(env);
    const cursorBefore = (await syncState())!.cursor_ms;

    vi.unstubAllGlobals();
    stubFetch({
      recentlyPlayed: () =>
        jsonResponse({ items: [{ played_at: '2026-09-08T09:00:00Z', track: { id: 'earlier', name: 'Earlier' } }] }),
    });
    await poll(env);

    expect((await syncState())!.cursor_ms).toBe(cursorBefore);
    expect(await countPlays()).toBe(2); // the older play is still stored
  });
});
