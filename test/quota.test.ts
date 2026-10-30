import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluate, runPollCron } from '../src/alerts';
import { backfillFromCatalog } from '../src/albums';
import { poll } from '../src/ingest';
import { IDLE_FRESH_MS, nowPlayingFreshMs } from '../src/live';
import { nowPlayingKey, sharedAnswerKey } from '../src/spotify-client';
import { CALLS_KEPT_MS, forgetPauseMemo, recordPause, storedPause } from '../src/quota';
import { freezeClock, jsonResponse, seedAuthorized, syncState, testEnv } from './helpers';

const BASE = 'https://warehouse.test';
const ADMIN = { Authorization: 'Bearer test-admin-token' };
const READ = { Authorization: 'Bearer test-read-token' };
const START = Date.parse('2026-10-16T12:00:00Z');
const QUOTA_BODY = '{"error":{"status":429,"message":"API rate limit exceeded","reason":"QUOTA_EXCEEDED"}}';

/** Answer every outbound request with `handler`, recording each URL's host and path. */
function stubFetch(handler: (url: URL) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(url.host + url.pathname);
      return handler(url);
    }),
  );
  return calls;
}

/** As another colo would: no copy of the shared answers at the edge. */
async function forgetEdge() {
  const edge = await caches.open('spotify-answers');
  await Promise.all([edge.delete(nowPlayingKey()), edge.delete(sharedAnswerKey('recently-played'))]);
}

async function pauseRow() {
  return env.DB.prepare('SELECT until_ms, kind FROM spotify_pause WHERE id = 1').first<{ until_ms: number; kind: string }>();
}

async function callRows() {
  const { results } = await env.DB.prepare(
    'SELECT source, outcome, SUM(calls) AS calls FROM spotify_calls GROUP BY source, outcome ORDER BY source, outcome',
  ).all<{ source: string; outcome: string; calls: number }>();
  return results;
}

const nowPlaying = (auth = READ) => SELF.fetch(`${BASE}/api/now-playing`, { headers: auth });

afterEach(() => vi.unstubAllGlobals());

describe('the Spotify pause', () => {
  it('is set by a 429 for its Retry-After, and blocks every later call until then', async () => {
    freezeClock(START);
    await seedAuthorized({ accessExpiresMs: START + 86_400_000 });
    const calls = stubFetch(() => new Response(QUOTA_BODY, { status: 429, headers: { 'Retry-After': '32400' } }));

    const first = await nowPlaying();
    expect(first.status).toBe(429);
    expect(first.headers.get('Retry-After')).toBe('32400');
    expect(await pauseRow()).toEqual({ until_ms: START + 32_400_000, kind: 'quota_exceeded' });

    // An hour on, nothing is sent from any route: each fails as the 429 did, with the time left.
    vi.setSystemTime(START + 3_600_000);
    for (const req of ['/api/now-playing', '/api/recently-played', '/api/top']) {
      const response = await SELF.fetch(`${BASE}${req}`, { headers: READ });
      expect(response.status, req).toBe(429);
      expect(response.headers.get('Retry-After'), req).toBe('28800');
      expect(await response.json(), req).toEqual({ error: 'Spotify upstream: quota_exceeded', retry_after_seconds: 28800 });
    }
    expect(calls).toEqual(['api.spotify.com/v1/me/player/currently-playing']);

    // Once it has passed, calls go out again.
    vi.setSystemTime(START + 32_400_000 + 1000);
    stubFetch(() => jsonResponse({ is_playing: false }));
    expect((await nowPlaying()).status).toBe(200);
  });

  it('uses a minute for a rate limit and an hour for the quota when Retry-After is absent, and caps it at a day', async () => {
    freezeClock(START);
    await seedAuthorized({ accessExpiresMs: START + 86_400_000 });
    stubFetch(() => new Response('{}', { status: 429 }));
    await nowPlaying();
    expect(await pauseRow()).toEqual({ until_ms: START + 60_000, kind: 'rate_limited' });

    vi.setSystemTime(START + 61_000);
    stubFetch(() => new Response(QUOTA_BODY, { status: 429 }));
    await nowPlaying();
    expect(await pauseRow()).toEqual({ until_ms: START + 61_000 + 3_600_000, kind: 'quota_exceeded' });

    vi.setSystemTime(START + 2 * 3_600_000);
    stubFetch(() => new Response(QUOTA_BODY, { status: 429, headers: { 'Retry-After': '999999' } }));
    await nowPlaying();
    expect((await pauseRow())!.until_ms).toBe(START + 2 * 3_600_000 + 86_400_000);
  });

  it('is never shortened by a later, shorter 429', async () => {
    await recordPause(env.DB, 'quota_exceeded', 9 * 3600, START);
    const kept = await recordPause(env.DB, 'rate_limited', 30, START + 1000);
    expect(kept).toEqual({ until_ms: START + 9 * 3_600_000, kind: 'quota_exceeded' });
    expect(await pauseRow()).toEqual(kept);

    // A longer one moves it later.
    await recordPause(env.DB, 'rate_limited', 10 * 3600, START + 2000);
    expect(await pauseRow()).toEqual({ until_ms: START + 2000 + 10 * 3_600_000, kind: 'rate_limited' });
  });

  it('is read from D1 by every isolate, not only the one that hit the 429', async () => {
    freezeClock(START);
    await seedAuthorized();
    // As if another isolate had recorded it, after this one last looked.
    await env.DB.prepare("INSERT INTO spotify_pause (id, until_ms, kind, set_ms) VALUES (1, ?, 'rate_limited', ?)")
      .bind(START + 600_000, START)
      .run();
    forgetPauseMemo();
    const calls = stubFetch(() => jsonResponse({}));
    expect((await nowPlaying()).status).toBe(429);
    expect(calls).toEqual([]);
  });

  it('does not refresh a token while paused', async () => {
    freezeClock(START);
    // The stored access token has expired, so a call would refresh first.
    await seedAuthorized({ accessExpiresMs: START - 1000 });
    await recordPause(env.DB, 'quota_exceeded', 3600, START);
    const calls = stubFetch(() => jsonResponse({ access_token: 'x', expires_in: 3600 }));
    expect((await nowPlaying()).status).toBe(429);
    expect(calls).toEqual([]);
  });

  it('makes the poll skip cleanly: nothing sent, no failure recorded, the cursor kept', async () => {
    freezeClock(START);
    await seedAuthorized();
    await recordPause(env.DB, 'quota_exceeded', 3600, START);
    const calls = stubFetch(() => jsonResponse({ items: [] }));

    const result = await poll(env);
    expect(result).toMatchObject({ ok: false, paused_until_ms: START + 3_600_000, retry_after_seconds: 3600 });
    expect(calls).toEqual([]);
    expect(await syncState()).toMatchObject({ consecutive_failures: 0, last_error: null });
  });

  it('records the pause when the poll itself is refused, as a failure the alert can explain', async () => {
    freezeClock(START);
    await seedAuthorized();
    stubFetch(() => new Response(QUOTA_BODY, { status: 429, headers: { 'Retry-After': '7200' } }));

    const result = await poll(env);
    expect(result).toMatchObject({ ok: false, retry_after_seconds: 7200 });
    expect(result.error).toContain('quota_exceeded');
    expect(await pauseRow()).toEqual({ until_ms: START + 7_200_000, kind: 'quota_exceeded' });
    expect((await syncState())!.consecutive_failures).toBe(1);
  });

  it('stops the catalog backfill before it mints an app token', async () => {
    freezeClock(START);
    await env.DB.prepare("INSERT INTO tracks (track_id, name, first_seen_ms) VALUES ('t1', 'One', 0)").run();
    await recordPause(env.DB, 'rate_limited', 120, START);
    const calls = stubFetch(() => jsonResponse({}));

    const response = await backfillFromCatalog(env, new Request(`${BASE}/admin/backfill-catalog`, { method: 'POST' }));
    expect(await response.json()).toMatchObject({ rate_limited: true, retry_after_seconds: 120, done: false, examined: 0 });
    expect(calls).toEqual([]);
  });

  it('pauses on a Get Track 429 from the app token too', async () => {
    freezeClock(START);
    await env.DB.prepare("INSERT INTO tracks (track_id, name, first_seen_ms) VALUES ('t1', 'One', 0)").run();
    stubFetch((url) =>
      url.host === 'accounts.spotify.com'
        ? jsonResponse({ access_token: 'app', expires_in: 3600 })
        : new Response('{}', { status: 429, headers: { 'Retry-After': '900' } }),
    );
    const response = await backfillFromCatalog(env, new Request(`${BASE}/admin/backfill-catalog`, { method: 'POST' }));
    expect(await response.json()).toMatchObject({ rate_limited: true, retry_after_seconds: 900 });
    expect(await pauseRow()).toEqual({ until_ms: START + 900_000, kind: 'rate_limited' });
  });

  it('names itself in the stall alert, rather than looking like a broken Worker', async () => {
    const token = { access_token: 'a', access_expires_ms: START + 1, refresh_token: 'r', authorized_at_ms: START, needs_reauth: 0 };
    const sync = { cursor_ms: 0, last_success_ms: START - 4 * 3_600_000, last_error: 'quota_exceeded: …', last_error_ms: START, consecutive_failures: 8 };
    const pause = { until_ms: START + 5 * 3_600_000, kind: 'quota_exceeded' as const };

    const [paused] = evaluate(token as never, sync as never, START, pause);
    expect(paused).toMatchObject({ key: 'ingestion_stalled', title: expect.stringContaining('paused') });
    expect(paused!.message).toContain(new Date(pause.until_ms).toISOString());
    expect(evaluate(token as never, sync as never, START)[0]!.title).toBe('music-warehouse ingestion has stalled');
  });
});

describe('the shared now-playing answer', () => {
  it('keeps a minute when idle', () => {
    expect(nowPlayingFreshMs(null)).toBe(IDLE_FRESH_MS);
    expect(nowPlayingFreshMs({ is_playing: false, progress_ms: 1000, item: { duration_ms: 200_000 } })).toBe(60_000);
  });

  it('keeps until just after the track ends while playing, between 10 and 30 seconds', () => {
    const playing = (left: number) => ({ is_playing: true, progress_ms: 200_000 - left, item: { duration_ms: 200_000 } });
    expect(nowPlayingFreshMs(playing(150_000))).toBe(30_000);
    expect(nowPlayingFreshMs(playing(20_000))).toBe(22_000);
    expect(nowPlayingFreshMs(playing(3_000))).toBe(10_000);
    expect(nowPlayingFreshMs({ is_playing: true, item: null })).toBe(30_000);
  });

  it('serves every colo from one Spotify call until it goes stale, then asks again', async () => {
    freezeClock(START);
    await seedAuthorized();
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    const miss = await nowPlaying();
    expect(miss.headers.get('X-Cache')).toBe('miss');
    expect(await miss.json()).toEqual({ item: null });

    // Another colo, 59 s later: D1 still has it.
    vi.setSystemTime(START + 59_000);
    await forgetEdge();
    const hit = await nowPlaying(ADMIN);
    expect(hit.headers.get('X-Cache')).toBe('hit');
    expect(await hit.json()).toEqual({ item: null });
    expect(calls).toHaveLength(1);

    vi.setSystemTime(START + 61_000);
    await forgetEdge();
    expect((await nowPlaying()).headers.get('X-Cache')).toBe('miss');
    expect(calls).toHaveLength(2);
  });

  it('asks again soon after the playing track should end', async () => {
    freezeClock(START);
    await seedAuthorized();
    const payload = { is_playing: true, progress_ms: 195_000, item: { name: 'Kids', duration_ms: 200_000 } };
    const calls = stubFetch(() => jsonResponse(payload));
    await nowPlaying();

    vi.setSystemTime(START + 9_000);
    await forgetEdge();
    expect((await nowPlaying()).headers.get('X-Cache')).toBe('hit');
    // 5 s left plus the grace is 7 s, raised to the 10 s floor.
    vi.setSystemTime(START + 10_500);
    await forgetEdge();
    expect((await nowPlaying()).headers.get('X-Cache')).toBe('miss');
    expect(calls).toHaveLength(2);
  });

  it('serves the last answer, stale, while paused, and the 429 when there is none', async () => {
    freezeClock(START);
    await seedAuthorized();
    const payload = { is_playing: true, progress_ms: 1000, item: { name: 'Kids', duration_ms: 200_000 } };
    stubFetch(() => jsonResponse(payload));
    await nowPlaying();

    vi.setSystemTime(START + 120_000);
    await forgetEdge();
    await recordPause(env.DB, 'quota_exceeded', 3600, START + 120_000);
    const calls = stubFetch(() => jsonResponse({}));
    const stale = await nowPlaying();
    expect(stale.status).toBe(200);
    expect(stale.headers.get('X-Cache')).toBe('stale');
    expect(await stale.json()).toEqual({ item: payload });
    expect(calls).toEqual([]);

    await env.DB.prepare('DELETE FROM spotify_answers').run();
    await forgetEdge();
    expect((await nowPlaying()).status).toBe(429);
  });

  it('serves the last answer, stale, when its own call is the one refused', async () => {
    freezeClock(START);
    await seedAuthorized();
    stubFetch(() => jsonResponse({ is_playing: false }));
    await nowPlaying();

    vi.setSystemTime(START + 61_000);
    await forgetEdge();
    stubFetch(() => new Response(QUOTA_BODY, { status: 429, headers: { 'Retry-After': '600' } }));
    const stale = await nowPlaying();
    expect(stale.headers.get('X-Cache')).toBe('stale');
    expect(await stale.json()).toEqual({ item: { is_playing: false } });
  });

  it('keeps no failure other than a rate limit, and serves no stale copy for one', async () => {
    freezeClock(START);
    await seedAuthorized();
    stubFetch(() => jsonResponse({ is_playing: false }));
    await nowPlaying();
    vi.setSystemTime(START + 61_000);
    await forgetEdge();
    stubFetch(() => new Response('oops', { status: 500 }));
    expect((await nowPlaying()).status).toBe(502);
  });
});

describe('the shared recently-played answer', () => {
  it('keeps one page for a minute, and serves it stale while paused', async () => {
    freezeClock(START);
    await seedAuthorized();
    const items = [{ played_at: '2026-10-16T11:59:00.000Z', track: { name: 'Kids' } }];
    const calls = stubFetch(() => jsonResponse({ items }));

    expect((await SELF.fetch(`${BASE}/api/recently-played`, { headers: READ })).headers.get('X-Cache')).toBe('miss');
    vi.setSystemTime(START + 59_000);
    await forgetEdge();
    expect((await SELF.fetch(`${BASE}/api/recently-played?limit=5`, { headers: READ })).headers.get('X-Cache')).toBe('hit');
    expect(calls).toHaveLength(1);

    vi.setSystemTime(START + 61_000);
    await forgetEdge();
    await recordPause(env.DB, 'rate_limited', 60, START + 61_000);
    const stale = await SELF.fetch(`${BASE}/api/recently-played`, { headers: READ });
    expect(stale.headers.get('X-Cache')).toBe('stale');
    expect(await stale.json()).toEqual({ items });
    expect(calls).toHaveLength(1);

    vi.setSystemTime(START + 122_000);
    await forgetEdge();
    expect((await SELF.fetch(`${BASE}/api/recently-played`, { headers: READ })).headers.get('X-Cache')).toBe('miss');
    expect(calls).toHaveLength(2);
  });
});

describe('counting Spotify calls', () => {
  it('counts every request sent, by source and outcome, and none the pause blocked', async () => {
    freezeClock(START);
    await seedAuthorized();
    stubFetch((url) =>
      url.pathname.endsWith('/currently-playing') ? new Response(null, { status: 204 }) : jsonResponse({ items: [] }),
    );
    await nowPlaying();
    await SELF.fetch(`${BASE}/api/top?type=artists`, { headers: READ });
    await poll(env);

    vi.setSystemTime(START + 61_000);
    await forgetEdge();
    stubFetch(() => new Response('{}', { status: 429 }));
    await nowPlaying();
    // Blocked by the pause that 429 set: not sent, not counted.
    await SELF.fetch(`${BASE}/api/recently-played`, { headers: READ });

    // The routes count after answering (waitUntil); the poll before it returns.
    await vi.waitFor(async () =>
      expect(await callRows()).toEqual([
        { source: 'now-playing', outcome: '2xx', calls: 1 },
        { source: 'now-playing', outcome: '429', calls: 1 },
        { source: 'poll', outcome: '2xx', calls: 1 },
        { source: 'top', outcome: '2xx', calls: 1 },
      ]),
    );

    const health = (await (await SELF.fetch(`${BASE}/health`, { headers: ADMIN })).json()) as Record<string, any>;
    expect(health.spotify).toEqual({
      paused_until_ms: START + 61_000 + 60_000,
      paused_until_iso: new Date(START + 121_000).toISOString(),
      pause_kind: 'rate_limited',
      calls_24h: 4,
      by_source_24h: { 'now-playing': 2, poll: 1, top: 1 },
      rate_limited_24h: 1,
    });
  });

  it('reports no pause and no calls on a quiet warehouse, and leaves out what is older than a day', async () => {
    freezeClock(START);
    await env.DB.prepare("INSERT INTO spotify_calls (hour_ms, source, outcome, calls) VALUES (?, 'poll', '2xx', 7)")
      .bind(START - 25 * 3_600_000)
      .run();
    const health = (await (await SELF.fetch(`${BASE}/health`, { headers: ADMIN })).json()) as Record<string, any>;
    expect(health.spotify).toEqual({
      paused_until_ms: null,
      paused_until_iso: null,
      pause_kind: null,
      calls_24h: 0,
      by_source_24h: {},
      rate_limited_24h: 0,
    });
  });

  it('is pruned by the poll cron, which still pings the heartbeat while paused', async () => {
    freezeClock(START);
    await seedAuthorized();
    await recordPause(env.DB, 'quota_exceeded', 3600, START);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO spotify_calls (hour_ms, source, outcome, calls) VALUES (?, 'poll', '2xx', 3)").bind(
        START - CALLS_KEPT_MS - 3_600_000,
      ),
      env.DB.prepare("INSERT INTO spotify_calls (hour_ms, source, outcome, calls) VALUES (?, 'poll', '2xx', 2)").bind(
        START - 3_600_000,
      ),
    ]);
    const calls = stubFetch(() => new Response('ok'));

    const result = await runPollCron(testEnv({ HEARTBEAT_URL: 'https://hc.test/ping' }), START);
    expect(result.poll.paused_until_ms).toBe(START + 3_600_000);
    expect(result.heartbeat).toBe(true);
    expect(calls).toEqual(['hc.test/ping']);
    expect(await callRows()).toEqual([{ source: 'poll', outcome: '2xx', calls: 2 }]);
    expect(await storedPause(env.DB, START)).not.toBeNull();
  });
});
