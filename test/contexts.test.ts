import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOKUPS_PER_POLL, lookupPath } from '../src/contexts';
import { poll } from '../src/ingest';
import type { RecentlyPlayedItem } from '../src/types';
import { freezeClock, jsonResponse, seedAuthorized } from './helpers';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 12);

function item(minute: number, trackId: string, context: { uri: string; type: string } | null): RecentlyPlayedItem {
  return {
    played_at: new Date(T0 + minute * 60_000).toISOString(),
    context,
    track: {
      id: trackId,
      name: `Song ${trackId}`,
      duration_ms: 200_000,
      album: { id: 'alb1', name: 'Local Album', images: [] },
      artists: [{ id: 'art1', name: 'Local Artist' }],
    },
  };
}

/**
 * Serve `items` from recently-played (only those after the cursor), and
 * answer context lookups from `names`: a string names it, a number is an
 * error status. Returns every lookup path asked for.
 */
function stubSpotify(items: RecentlyPlayedItem[], names: Record<string, string | number>) {
  const lookups: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/me/player/recently-played')) {
        const after = Number(url.searchParams.get('after') ?? 0);
        return jsonResponse({ items: items.filter((i) => Date.parse(i.played_at!) > after) });
      }
      const path = url.pathname.replace('/v1', '') + url.search;
      lookups.push(path);
      const answer = names[path];
      if (answer === undefined) throw new Error(`Unexpected lookup ${path}`);
      return typeof answer === 'number' ? new Response('{}', { status: answer }) : jsonResponse({ name: answer });
    }),
  );
  return lookups;
}

async function contextNames(): Promise<Record<string, string | null>> {
  const rows = (await env.DB.prepare('SELECT uri, name FROM contexts').all<{ uri: string; name: string | null }>()).results;
  return Object.fromEntries(rows.map((row) => [row.uri, row.name]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('context names', () => {
  it('names albums and artists locally and asks Spotify for the rest, caching refusals', async () => {
    await seedAuthorized();
    const lookups = stubSpotify(
      [
        item(0, 't1', { uri: 'spotify:album:alb1', type: 'album' }),
        item(1, 't2', { uri: 'spotify:artist:art1', type: 'artist' }),
        item(2, 't3', { uri: 'spotify:playlist:mine', type: 'playlist' }),
        item(3, 't4', { uri: 'spotify:playlist:editorial', type: 'playlist' }),
        item(4, 't5', null),
      ],
      { '/playlists/mine?fields=name': 'Morning Mix', '/playlists/editorial?fields=name': 404 },
    );

    const result = await poll(env, T0 + DAY);
    expect(result.ok).toBe(true);
    expect(result.contexts_named).toBe(2);
    expect(lookups.sort()).toEqual(['/playlists/editorial?fields=name', '/playlists/mine?fields=name']);
    expect(await contextNames()).toEqual({
      'spotify:album:alb1': 'Local Album',
      'spotify:artist:art1': 'Local Artist',
      'spotify:playlist:mine': 'Morning Mix',
      'spotify:playlist:editorial': null,
    });

    const response = await SELF.fetch(`${BASE}/api/plays`, { headers: READ });
    const plays = ((await response.json()) as { plays: Array<{ track_id: string; context_name: string | null }> }).plays;
    expect(plays.map((p) => [p.track_id, p.context_name])).toEqual([
      ['t5', null],
      ['t4', null],
      ['t3', 'Morning Mix'],
      ['t2', 'Local Artist'],
      ['t1', 'Local Album'],
    ]);

    // The refusal is not asked again the next day, only after the retry interval.
    lookups.length = 0;
    await poll(env, T0 + 2 * DAY);
    expect(lookups).toEqual([]);
    await poll(env, T0 + 32 * DAY);
    expect(lookups).toContain('/playlists/editorial?fields=name');
  });

  it('reads an album or artist the track is not part of as no context, since autoplay leaves it behind', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO albums (album_id, name) VALUES ('alb1', 'Single'), ('alb2', 'Other')"),
      env.DB.prepare("INSERT INTO artists (artist_id, name) VALUES ('art1', 'Singer'), ('art2', 'Other')"),
      env.DB.prepare(
        "INSERT INTO tracks (track_id, name, album_id, first_seen_ms) VALUES ('own', 'Own', 'alb1', 0), ('auto', 'Auto', 'alb2', 0), ('bare', 'Bare', NULL, 0)",
      ),
      env.DB.prepare("INSERT INTO track_artists (track_id, artist_id, position) VALUES ('own', 'art1', 0), ('auto', 'art2', 0)"),
      env.DB.prepare(
        `INSERT INTO contexts (uri, type, name, fetched_ms) VALUES ('spotify:album:alb1', 'album', 'Single', 0),
           ('spotify:artist:art1', 'artist', 'Singer', 0), ('spotify:playlist:p', 'playlist', 'Mix', 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO plays (played_at_ms, track_id, context_uri, context_type) VALUES
           (1, 'own', 'spotify:album:alb1', 'album'), (2, 'auto', 'spotify:album:alb1', 'album'),
           (3, 'own', 'spotify:artist:art1', 'artist'), (4, 'auto', 'spotify:artist:art1', 'artist'),
           (5, 'auto', 'spotify:playlist:p', 'playlist'), (6, 'bare', 'spotify:album:alb1', 'album')`,
      ),
    ]);

    const response = await SELF.fetch(`${BASE}/api/plays`, { headers: READ });
    const plays = ((await response.json()) as {
      plays: Array<{ track_id: string; context_uri: string | null; context_type: string | null; context_name: string | null }>;
    }).plays;
    expect(plays.map((p) => [p.track_id, p.context_uri, p.context_type, p.context_name])).toEqual([
      // A track whose album isn't known keeps its context.
      ['bare', 'spotify:album:alb1', 'album', 'Single'],
      ['auto', 'spotify:playlist:p', 'playlist', 'Mix'],
      ['auto', null, null, null],
      ['own', 'spotify:artist:art1', 'artist', 'Singer'],
      ['auto', null, null, null],
      ['own', 'spotify:album:alb1', 'album', 'Single'],
    ]);
  });

  it('asks at most a few per poll, and stops at a rate limit', async () => {
    await seedAuthorized();
    const items = Array.from({ length: 6 }, (_, i) => item(i, `t${i}`, { uri: `spotify:playlist:p${i}`, type: 'playlist' }));
    const names: Record<string, string | number> = {};
    for (let i = 0; i < 6; i++) names[`/playlists/p${i}?fields=name`] = `Playlist ${i}`;
    names['/playlists/p0?fields=name'] = 429;
    const lookups = stubSpotify(items, names);

    freezeClock(T0 + DAY);
    await poll(env, T0 + DAY);
    // The first lookup was rate limited, so nothing else was asked this poll.
    expect(lookups).toHaveLength(1);
    expect(Object.values(await contextNames()).filter(Boolean)).toHaveLength(0);

    // The 429 paused Spotify calls for a minute (no Retry-After); after it, ask again.
    names['/playlists/p0?fields=name'] = 'Playlist 0';
    lookups.length = 0;
    vi.setSystemTime(T0 + DAY + 61_000);
    await poll(env, T0 + DAY + 61_000);
    expect(lookups).toHaveLength(LOOKUPS_PER_POLL);
    await poll(env, T0 + DAY + 122_000);
    expect(Object.values(await contextNames()).filter(Boolean)).toHaveLength(6);
  });

  it('refreshes a playlist name weekly and keeps it if the refresh fails', async () => {
    await seedAuthorized();
    const names: Record<string, string | number> = { '/playlists/mine?fields=name': 'Old Name' };
    stubSpotify([item(0, 't1', { uri: 'spotify:playlist:mine', type: 'playlist' })], names);
    await poll(env, T0 + DAY);
    names['/playlists/mine?fields=name'] = 'New Name';
    await poll(env, T0 + 3 * DAY);
    expect((await contextNames())['spotify:playlist:mine']).toBe('Old Name');
    await poll(env, T0 + 9 * DAY);
    expect((await contextNames())['spotify:playlist:mine']).toBe('New Name');
    names['/playlists/mine?fields=name'] = 404;
    await poll(env, T0 + 17 * DAY);
    expect((await contextNames())['spotify:playlist:mine']).toBe('New Name');
  });

  it('knows which contexts Spotify can name', () => {
    expect(lookupPath('spotify:playlist:abc123')).toBe('/playlists/abc123?fields=name');
    expect(lookupPath('spotify:show:abc')).toBe('/shows/abc');
    expect(lookupPath('spotify:user:someone:collection')).toBeNull();
    expect(lookupPath('spotify:playlist:../me')).toBeNull();
  });

  it('backfills existing contexts in migration 0013, naming local albums', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO albums (album_id, name) VALUES ('alb1', 'Local Album')"),
      env.DB.prepare(
        "INSERT INTO plays (played_at_ms, track_id, context_uri, context_type) VALUES (1, 't', 'spotify:album:alb1', 'album'), (2, 't', 'spotify:playlist:x', 'playlist'), (3, 't', NULL, NULL)",
      ),
    ]);
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0013'))!;
    await env.DB.batch(migration.queries.filter((sql) => sql.trim().startsWith('INSERT')).map((sql) => env.DB.prepare(sql)));
    expect(await contextNames()).toEqual({ 'spotify:album:alb1': 'Local Album', 'spotify:playlist:x': null });
    const due = await env.DB.prepare("SELECT fetched_ms FROM contexts WHERE uri = 'spotify:playlist:x'").first('fetched_ms');
    expect(due).toBeNull();
  });
});
