import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillFromCatalog } from '../src/albums';

const TOKEN_HOST = 'https://accounts.spotify.com';

function trackBody(id: string) {
  return {
    id,
    name: `Track ${id}`,
    duration_ms: 180_000,
    external_ids: { isrc: `ISRC${id}` },
    album: { id: `alb-${id}`, name: `Album ${id}`, release_date: '2020-01-01', images: [{ url: `${id}.jpg`, width: 640 }] },
  };
}

/** Serve app tokens, then answer each Get Track from `plan` in order. */
function stubSpotify(plan: Array<{ status: number; id?: string; retryAfter?: string }>) {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (href.startsWith(TOKEN_HOST)) {
        return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
      }
      const step = plan[call++] ?? { status: 200 };
      if (step.status !== 200) {
        return new Response(`{"error":{"status":${step.status}}}`, {
          status: step.status,
          headers: step.retryAfter ? { 'Retry-After': step.retryAfter } : {},
        });
      }
      const id = href.split('/').pop()!;
      return new Response(JSON.stringify(trackBody(id)), { status: 200 });
    }),
  );
}

const post = (query: string) => new Request(`https://example.com/admin/backfill-catalog?${query}`, { method: 'POST' });

describe('backfillFromCatalog', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM tracks'),
      env.DB.prepare('DELETE FROM albums'),
      env.DB.prepare(
        "INSERT INTO tracks (track_id, name, first_seen_ms) VALUES ('aaa','A',1), ('bbb','B',2), ('ccc','C',3)",
      ),
    ]);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fills album art and advances the cursor', async () => {
    stubSpotify([{ status: 200 }, { status: 200 }, { status: 200 }]);

    const body = (await (await backfillFromCatalog(env, post('spacingMs=0'))).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ examined: 3, tracks_updated: 3, missing: 0, next_cursor: 'ccc', rate_limited: false });
    const row = await env.DB.prepare("SELECT album_id, isrc FROM tracks WHERE track_id='bbb'").first();
    expect(row).toMatchObject({ album_id: 'alb-bbb', isrc: 'ISRCbbb' });
  });

  it('surfaces Retry-After instead of swallowing it', async () => {
    // The bug this pins: a 429 was reported as `rate_limited: true` with no
    // duration, so the driver fell back to a blind few-second retry against a
    // limit that was actually an hour long.
    stubSpotify([{ status: 200 }, { status: 429, retryAfter: '3875' }]);

    const body = (await (await backfillFromCatalog(env, post('spacingMs=0'))).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ rate_limited: true, retry_after_seconds: 3875, done: false });
  });

  it('keeps the work done before a rate limit, and stops the cursor there', async () => {
    stubSpotify([{ status: 200 }, { status: 429, retryAfter: '60' }]);

    const body = (await (await backfillFromCatalog(env, post('spacingMs=0'))).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ examined: 1, tracks_updated: 1, next_cursor: 'aaa' });
    const done = await env.DB.prepare("SELECT album_id FROM tracks WHERE track_id='aaa'").first();
    expect(done).toMatchObject({ album_id: 'alb-aaa' });
    // The track it never reached must stay untouched, so the re-run picks it up.
    const untouched = await env.DB.prepare("SELECT album_id FROM tracks WHERE track_id='bbb'").first();
    expect(untouched).toMatchObject({ album_id: null });
  });

  it('counts a withdrawn track as missing and keeps walking past it', async () => {
    stubSpotify([{ status: 404 }, { status: 200 }, { status: 200 }]);

    const body = (await (await backfillFromCatalog(env, post('spacingMs=0'))).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ examined: 3, tracks_updated: 2, missing: 1, next_cursor: 'ccc' });
  });
});
