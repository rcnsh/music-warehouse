import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { type HomePlay, hourDistance, rankHome, sessions } from '../src/home';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// A Wednesday at 20:00 UTC, so London in winter and UTC agree.
const NOW = Date.UTC(2026, 0, 14, 20);

/** `count` plays from `key`, four minutes apart, ending at `startMs` and on. */
function run(startMs: number, key: string | null, count: number, artist: string | null = `by-${key}`): HomePlay[] {
  return Array.from({ length: count }, (_, i) => ({ ms: startMs + i * 4 * MIN, key, artist }));
}

/** Plays oldest first, as the route reads them. */
const asc = (plays: HomePlay[]) => [...plays].sort((a, b) => a.ms - b.ms);

const uris = (rows: Array<{ key: string }>) => rows.map((r) => r.key);

describe('sessions', () => {
  it('folds a run from one context into one session and splits on a gap or a new context', () => {
    const s = sessions([
      ...run(0, 'spotify:album:a', 10),
      ...run(2 * HOUR, 'spotify:album:a', 2),
      ...run(3 * HOUR, 'spotify:playlist:p', 3),
    ]);
    expect(s.map((x) => [x.key, x.tracks])).toEqual([
      ['spotify:album:a', 10],
      ['spotify:album:a', 2],
      ['spotify:playlist:p', 3],
    ]);
  });

  it('counts skips for nothing and drops a session of only skips', () => {
    const s = sessions([
      { ms: 0, key: 'spotify:album:a', artist: null },
      { ms: 10_000, key: 'spotify:album:a', artist: null },
      { ms: 5 * MIN, key: 'spotify:album:b', artist: null },
      { ms: 5 * MIN + 5_000, key: 'spotify:album:c', artist: null },
      { ms: 5 * MIN + 9_000, key: 'spotify:album:d', artist: null },
    ]);
    // a: its first play counts, the skip after it doesn't. c is all skip. d, after
    // only 4 s, too. b's play ran its 5 minutes.
    expect(s.map((x) => [x.key, x.tracks])).toEqual([
      ['spotify:album:a', 1],
      ['spotify:album:b', 1],
    ]);
  });

  it('lets a play from no context break a run', () => {
    const s = sessions([...run(0, 'spotify:album:a', 2), ...run(8 * MIN, null, 1), ...run(12 * MIN, 'spotify:album:a', 2)]);
    expect(s).toHaveLength(2);
  });
});

describe('hourDistance', () => {
  it('goes around midnight', () => {
    expect(hourDistance(23, 1)).toBe(2);
    expect(hourDistance(6, 18)).toBe(12);
  });
});

describe('rankHome', () => {
  it('ranks shortcuts by how often more than how lately', () => {
    const plays = [
      // Five evenings of one playlist last week.
      ...[2, 3, 4, 5, 6].flatMap((d) => run(NOW - d * DAY, 'spotify:playlist:often', 5)),
      // One album, once, an hour ago.
      ...run(NOW - HOUR, 'spotify:album:once', 3),
    ];
    const r = rankHome(asc(plays), [], NOW, 'UTC');
    expect(uris(r.shortcuts)).toEqual(['spotify:playlist:often', 'spotify:album:once']);
    expect(uris(r.jumpBackIn)).toEqual(['spotify:album:once', 'spotify:playlist:often']);
  });

  it('favours what is played at this hour', () => {
    // The same listening, mornings for one and evenings for the other; now is 20:00.
    const mornings = [3, 4, 5].flatMap((d) => run(NOW - d * DAY - 12 * HOUR, 'spotify:album:morning', 5));
    const evenings = [3, 4, 5].flatMap((d) => run(NOW - d * DAY, 'spotify:album:evening', 5));
    const r = rankHome([...mornings, ...evenings].sort((a, b) => a.ms - b.ms), [], NOW, 'UTC');
    expect(uris(r.shortcuts)[0]).toBe('spotify:album:evening');
    expect(uris(r.aroundNow)).toEqual(['spotify:album:evening']);
    expect(r.hour).toBe(20);
  });

  it('reads the hour in the given zone', () => {
    // 20:00 UTC is 04:00 in Singapore, so the morning album is the one near now.
    const morningSg = [3, 4, 5].flatMap((d) => run(NOW - d * DAY, 'spotify:album:x', 5));
    expect(rankHome(asc(morningSg), [], NOW, 'Asia/Singapore').hour).toBe(4);
    expect(uris(rankHome(asc(morningSg), [], NOW, 'Asia/Singapore').aroundNow)).toEqual(['spotify:album:x']);
  });

  it('needs three days near this hour for around now', () => {
    const plays = [3, 4].flatMap((d) => run(NOW - d * DAY, 'spotify:album:twice', 5));
    expect(rankHome(asc(plays), [], NOW, 'UTC').aroundNow).toEqual([]);
  });

  it('keeps at most two of one artist in a row, but playlists are no one', () => {
    const plays = ['a', 'b', 'c', 'd'].flatMap((x, i) => run(NOW - (i + 1) * DAY, `spotify:album:${x}`, 4, 'same-artist'));
    const lists = ['p', 'q', 'r'].flatMap((x, i) => run(NOW - (i + 5) * DAY, `spotify:playlist:${x}`, 4, 'same-artist'));
    const r = rankHome([...lists, ...plays].sort((a, b) => a.ms - b.ms), [], NOW, 'UTC');
    expect(r.shortcuts.filter((s) => s.key.startsWith('spotify:album:'))).toHaveLength(2);
    expect(r.shortcuts.filter((s) => s.key.startsWith('spotify:playlist:'))).toHaveLength(3);
    // Jump back in is plain recency.
    expect(r.jumpBackIn).toHaveLength(7);
  });

  it('rediscovers what was played on many days but not lately', () => {
    const old = [200, 210, 220, 230, 240].flatMap((d) => run(NOW - d * DAY, 'spotify:album:old', 3));
    const stillPlayed = [...[200, 210, 220, 230].flatMap((d) => run(NOW - d * DAY, 'spotify:album:still', 3)), ...run(NOW - DAY, 'spotify:album:still', 3)];
    const rare = run(NOW - 300 * DAY, 'spotify:album:rare', 3);
    const r = rankHome([...old, ...stillPlayed, ...rare].sort((a, b) => a.ms - b.ms), [], NOW, 'UTC');
    expect(uris(r.rediscover)).toEqual(['spotify:album:old']);
    expect(r.rediscover[0]!.sessions).toBe(5);
  });

  it('adds days from before the detailed year', () => {
    const recentDays = [200, 210].flatMap((d) => run(NOW - d * DAY, 'spotify:album:old', 3));
    const older = [{ key: 'spotify:album:old', days: 3, last_ms: NOW - 400 * DAY, artist: 'x' }, { key: 'spotify:album:ancient', days: 9, last_ms: NOW - 3000 * DAY, artist: 'y' }];
    const r = rankHome(asc(recentDays), older, NOW, 'UTC');
    expect(r.rediscover.find((x) => x.key === 'spotify:album:old')?.sessions).toBe(5);
    expect(uris(r.rediscover)).toContain('spotify:album:ancient');
  });
});

describe('GET /api/home', () => {
  async function seed(plays: Array<{ ms: number; track: string; context?: string | null; album?: string | null }>) {
    const statements: D1PreparedStatement[] = [];
    for (const p of plays) {
      const album = p.album === undefined ? `al-${p.track}` : p.album;
      statements.push(
        env.DB.prepare('INSERT OR IGNORE INTO plays (played_at_ms, track_id, context_uri, context_type, source) VALUES (?, ?, ?, ?, ?)').bind(
          p.ms,
          p.track,
          p.context ?? null,
          p.context ? p.context.split(':')[1] : null,
          'api',
        ),
        env.DB.prepare('INSERT OR IGNORE INTO tracks (track_id, name, album_id, first_seen_ms) VALUES (?, ?, ?, ?)').bind(p.track, `Song ${p.track}`, album, p.ms),
        env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind(`ar-${album}`, `Artist ${album}`),
        env.DB.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind(p.track, `ar-${album}`),
      );
      if (album) {
        statements.push(env.DB.prepare('INSERT OR IGNORE INTO albums (album_id, name, image_url) VALUES (?, ?, ?)').bind(album, `Album ${album}`, `https://i.scdn.co/image/${album}`));
      }
    }
    await env.DB.batch(statements);
  }

  interface Item {
    uri: string;
    type: string | null;
    name: string | null;
    image: string | null;
    artist: string | null;
    sessions: number;
    last_played_ms: number;
  }
  interface Body {
    tz: string;
    hour: number;
    shortcuts: Item[];
    jump_back_in: Item[];
    around_now: Item[];
    rediscover: Item[];
  }

  it('names contexts, falls back to the track album, and leaves out Liked Songs', async () => {
    const now = Date.now();
    await env.DB.prepare('INSERT OR REPLACE INTO contexts (uri, type, name, fetched_ms) VALUES (?, ?, ?, ?)')
      .bind('spotify:playlist:pl', 'playlist', 'Road trip', now)
      .run();
    await seed([
      { ms: now - 3 * HOUR, track: 't1', context: 'spotify:playlist:pl' },
      { ms: now - 3 * HOUR + 4 * MIN, track: 't2', context: 'spotify:playlist:pl' },
      { ms: now - 2 * HOUR, track: 't3', context: null, album: 'exported' },
      { ms: now - HOUR, track: 't4', context: 'spotify:user:me:collection' },
    ]);
    const response = await SELF.fetch(`${BASE}/api/home?tz=Europe/London`, { headers: READ });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    expect(body.tz).toBe('Europe/London');
    expect(body.jump_back_in.map((i) => i.uri)).toEqual(['spotify:album:exported', 'spotify:playlist:pl']);
    const [album, playlist] = body.jump_back_in;
    expect(album).toMatchObject({ type: 'album', name: 'Album exported', image: 'https://i.scdn.co/image/exported', artist: 'Artist exported', sessions: 1 });
    expect(playlist).toMatchObject({ type: 'playlist', name: 'Road trip', image: null, artist: null });
    expect(body.shortcuts).toHaveLength(2);
  });

  it('answers an empty warehouse with empty rows', async () => {
    const body = (await (await SELF.fetch(`${BASE}/api/home?tz=UTC`, { headers: READ })).json()) as Body;
    expect(body).toMatchObject({ shortcuts: [], jump_back_in: [], around_now: [], rediscover: [] });
  });

  it('refuses an unknown zone and needs a token', async () => {
    expect((await SELF.fetch(`${BASE}/api/home?tz=Mars/Base`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/home`)).status).toBe(401);
  });
});
