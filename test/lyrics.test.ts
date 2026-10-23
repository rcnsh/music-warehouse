import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { forgetLyricsPause, lyricsCacheKey } from '../src/lyrics';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const KEY = 'sl_sk_test-lyrics-key';
const TRACK = '0aBcDeFgHiJkLmNoPqRsTu';
const OTHER = '1aBcDeFgHiJkLmNoPqRsTu';

/** Made-up lyrics in Spicy Lyrics' envelope, with a community credit. */
const LYRICS = JSON.stringify({
  Body: {
    Type: 'Line',
    id: TRACK,
    source: 'spicy_lyrics',
    Content: [{ Type: 'Vocal', Text: 'Test line one', StartTime: 1, EndTime: 2 }],
    UploadAttribution: { Uploader: { id: '1', username: 'uploader', url: 'https://spicylyrics.test/uid/1' } },
  },
  Status: 200,
  Type: 'object',
});
const NO_LYRICS = JSON.stringify({ Body: { error: 'lyrics_not_found', message: 'No lyrics.' }, Status: 404, Type: 'object' });

/** The Worker with the key set; the test deployment itself has none. */
const keyed = { ...env, SPICY_LYRICS_SECRET_KEY: KEY };
const get = (query: string, bindings: Cloudflare.Env = keyed, headers: Record<string, string> = READ) =>
  worker.fetch(new Request(`${BASE}/api/lyrics${query}`, { headers }), bindings, createExecutionContext());

/** A fake Spicy Lyrics answering with `reply` for every request, recording what was asked. */
function stubUpstream(reply: () => Response) {
  const calls: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return reply();
    }),
  );
  return calls;
}

beforeEach(async () => {
  forgetLyricsPause();
  const cache = await caches.open('lyrics');
  await Promise.all([cache.delete(lyricsCacheKey(TRACK)), cache.delete(lyricsCacheKey(OTHER))]);
});
afterEach(() => vi.unstubAllGlobals());

describe('/api/lyrics', () => {
  it('is a plain 404 when the deployment has no key, without calling upstream', async () => {
    const calls = stubUpstream(() => new Response(LYRICS));
    const response = await SELF.fetch(`${BASE}/api/lyrics?track=${TRACK}`, { headers: READ });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    // Even without a track, so a client's probe reads it as a missing route.
    expect((await SELF.fetch(`${BASE}/api/lyrics`, { headers: READ })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('needs a token like every /api route', async () => {
    const calls = stubUpstream(() => new Response(LYRICS));
    expect((await get(`?track=${TRACK}`, keyed, {})).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('refuses a missing or malformed track id before calling upstream', async () => {
    const calls = stubUpstream(() => new Response(LYRICS));
    for (const query of ['', '?track=', '?track=short', `?track=${TRACK}x`, '?track=../../v1/admin%2F%2F%2F%2F%2F%2F%2F%2F%2F']) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('passes the lyrics through unchanged with the secret key, then keeps them', async () => {
    const calls = stubUpstream(
      () => new Response(LYRICS, { headers: { 'Content-Type': 'application/json', 'RateLimit-Remaining': '99', 'X-Internal': 'x' } }),
    );
    const first = await get(`?track=${TRACK}`);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(LYRICS);
    expect(first.headers.get('Content-Type')).toBe('application/json');
    expect(first.headers.get('RateLimit-Remaining')).toBe('99');
    expect(first.headers.get('X-Internal')).toBeNull();
    expect(first.headers.get('X-Cache')).toBe('miss');
    expect(first.headers.get('Age')).toBe('0');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.spicylyrics.org/v1/lyrics/${TRACK}`);
    expect(calls[0]!.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    // The reader's token never goes upstream.
    expect(calls[0]!.headers.get('Authorization')).not.toContain('test-read-token');

    const second = await get(`?track=${TRACK}`);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(LYRICS);
    expect(second.headers.get('X-Cache')).toBe('hit');
    expect(second.headers.get('X-Lyrics-Fetched-Ms')).toBeNull();
    expect(second.headers.get('RateLimit-Remaining')).toBeNull();
    expect(Number(second.headers.get('Age'))).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
  });

  it('keeps "no lyrics" too, and passes its body through', async () => {
    const calls = stubUpstream(() => new Response(NO_LYRICS, { status: 404, headers: { 'Content-Type': 'application/json' } }));
    const first = await get(`?track=${OTHER}`);
    expect(first.status).toBe(404);
    expect(await first.text()).toBe(NO_LYRICS);
    const second = await get(`?track=${OTHER}`);
    expect(second.status).toBe(404);
    expect(second.headers.get('X-Cache')).toBe('hit');
    expect(calls).toHaveLength(1);
  });

  it('passes a 429 and its Retry-After on, and leaves upstream alone until it passes', async () => {
    const calls = stubUpstream(
      () => new Response('{"Body":{"error":"rate_limited"}}', { status: 429, headers: { 'Retry-After': '20', 'Content-Type': 'application/json' } }),
    );
    const first = await get(`?track=${TRACK}`);
    expect(first.status).toBe(429);
    expect(first.headers.get('Retry-After')).toBe('20');
    expect(await first.text()).toBe('{"Body":{"error":"rate_limited"}}');

    const second = await get(`?track=${OTHER}`);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
  });

  it('turns upstream refusing the key into a 502, never a 401, and logs no key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubUpstream(() => new Response('{"Body":{"error":"key_revoked","message":"…"}}', { status: 401 }));
    const response = await get(`?track=${TRACK}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Lyrics upstream: key rejected' });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('key_revoked');
    expect(logged).not.toContain(KEY);
    // Not kept: the next request asks again.
    expect(await (await caches.open('lyrics')).match(lyricsCacheKey(TRACK))).toBeUndefined();
  });

  it('is a 502 when upstream cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    expect((await get(`?track=${TRACK}`)).status).toBe(502);
  });

  it('names a publishable key as a misconfiguration', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = stubUpstream(() => new Response(LYRICS));
    const response = await get(`?track=${TRACK}`, { ...env, SPICY_LYRICS_SECRET_KEY: 'sl_pk_public' });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/^Worker misconfigured: SPICY_LYRICS_SECRET_KEY/);
    expect(body.error).not.toContain('sl_pk_public');
    expect(calls).toHaveLength(0);
  });
});
