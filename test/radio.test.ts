import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { syncAllSongs } from '../src/play-numbers';
import { MAX_PER_ARTIST, type RadioCandidate, type RadioPlay, WINDOW_MS, coPlayed, pickRadio, seedWindows } from '../src/radio';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 14, 20);

/** Plays four minutes apart from `startMs`, one per song key (track id = key). */
function run(startMs: number, songs: string[]): RadioPlay[] {
  return songs.map((song, i) => ({ ms: startMs + i * 4 * MIN, track_id: song, song }));
}

const seedTimes = (plays: RadioPlay[], song: string) => plays.filter((p) => p.song === song).map((p) => p.ms);

describe('seedWindows', () => {
  it('merges overlapping windows and keeps apart ones apart', () => {
    expect(seedWindows([10 * MIN + 2 * WINDOW_MS, 10 * MIN, 1000 * MIN])).toEqual([
      [10 * MIN - WINDOW_MS, 10 * MIN + 3 * WINDOW_MS],
      [1000 * MIN - WINDOW_MS, 1000 * MIN + WINDOW_MS],
    ]);
  });
});

describe('coPlayed', () => {
  it('ranks what is played nearer the seed higher and leaves the seed out', () => {
    const plays = run(NOW - DAY, ['a', 'b', 'seed', 'c', 'd', 'e']);
    const ranked = coPlayed(plays, seedTimes(plays, 'seed'), new Set(['seed']), NOW);
    // Four minutes either side, then eight, then twelve.
    const order = ranked.map((r) => r.song);
    expect(order.slice(0, 2).sort()).toEqual(['b', 'c']);
    expect(order.slice(2, 4).sort()).toEqual(['a', 'd']);
    expect(order[4]).toBe('e');
    expect(ranked.every((r) => r.sessions === 1)).toBe(true);
  });

  it('counts a song once per session but again in another session', () => {
    const plays = [
      ...run(NOW - 2 * DAY, ['seed', 'loop', 'loop', 'loop', 'loop']),
      ...run(NOW - DAY, ['seed', 'twice']),
      ...run(NOW - 3 * DAY, ['seed', 'twice']),
    ].sort((a, b) => a.ms - b.ms);
    const ranked = coPlayed(plays, seedTimes(plays, 'seed'), new Set(['seed']), NOW);
    expect(ranked[0]).toMatchObject({ song: 'twice', sessions: 2 });
    expect(ranked.find((r) => r.song === 'loop')?.sessions).toBe(1);
  });

  it('ignores skips and plays outside the windows', () => {
    const plays = [
      ...run(NOW - DAY, ['seed', 'kept']),
      { ms: NOW - DAY + 8 * MIN, track_id: 'played', song: 'played' },
      // Ended 10 s after the play before it ended, so it ran 10 s at most.
      { ms: NOW - DAY + 8 * MIN + 10_000, track_id: 'skipped', song: 'skipped' },
      { ms: NOW - DAY + 3 * WINDOW_MS, track_id: 'far', song: 'far' },
    ];
    const ranked = coPlayed(plays, seedTimes(plays, 'seed'), new Set(['seed']), NOW);
    expect(ranked.map((r) => r.song)).toEqual(['kept', 'played']);
  });

  it('weights recent sessions above old ones', () => {
    const plays = [...run(NOW - 3 * 365 * DAY, ['seed', 'old']), ...run(NOW - DAY, ['seed', 'new'])];
    const ranked = coPlayed(plays, seedTimes(plays, 'seed'), new Set(['seed']), NOW);
    expect(ranked.map((r) => r.song)).toEqual(['new', 'old']);
  });

  it('picks the edition played most near the seed', () => {
    const plays: RadioPlay[] = [
      { ms: NOW - DAY, track_id: 'seed', song: 'seed' },
      { ms: NOW - DAY + 4 * MIN, track_id: 'remaster', song: 'x' },
      { ms: NOW - DAY + 8 * MIN, track_id: 'original', song: 'x' },
      { ms: NOW - DAY + 12 * MIN, track_id: 'original', song: 'x' },
    ];
    expect(coPlayed(plays, [NOW - DAY], new Set(['seed']), NOW)[0]).toMatchObject({ song: 'x', track_id: 'original' });
  });
});

describe('pickRadio', () => {
  const candidate = (song: string, score: number, artistKey: string | null, plays: number | null = 1): RadioCandidate => ({
    song,
    track_id: song,
    score,
    sessions: 1,
    artistKey,
    plays,
  });

  it('keeps at most MAX_PER_ARTIST of one artist, uncredited tracks uncapped', () => {
    const picked = pickRadio(
      [
        ...Array.from({ length: 5 }, (_, i) => candidate(`same${i}`, 10 - i, 'same')),
        candidate('other', 1, 'other'),
        candidate('u1', 0.5, null),
        candidate('u2', 0.4, null),
        candidate('u3', 0.3, null),
        candidate('u4', 0.2, null),
      ],
      50,
    );
    expect(picked.filter((p) => p.artistKey === 'same')).toHaveLength(MAX_PER_ARTIST);
    expect(picked.map((p) => p.song)).toContain('other');
    expect(picked.filter((p) => p.artistKey === null)).toHaveLength(4);
  });

  it('damps songs played everywhere and cuts to the limit', () => {
    const picked = pickRadio([candidate('favourite', 2, 'a', 5000), candidate('niche', 1, 'b', 3), candidate('c', 0.1, 'c')], 2);
    expect(picked.map((p) => p.song)).toEqual(['niche', 'favourite']);
  });
});

describe('GET /api/radio', () => {
  interface Seed {
    ms: number;
    track: string;
    name?: string;
    artist?: string;
  }

  async function seed(plays: Seed[]) {
    const statements: D1PreparedStatement[] = [];
    for (const p of plays) {
      const artist = p.artist ?? `artist-${p.track}`;
      statements.push(
        env.DB.prepare('INSERT OR IGNORE INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(p.ms, p.track, 'api'),
        env.DB.prepare('INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, album_id, first_seen_ms) VALUES (?, ?, 200000, ?, ?)').bind(
          p.track,
          p.name ?? `Song ${p.track}`,
          `al-${p.track}`,
          p.ms,
        ),
        env.DB.prepare('INSERT OR IGNORE INTO albums (album_id, name, image_url) VALUES (?, ?, ?)').bind(
          `al-${p.track}`,
          `Album ${p.track}`,
          `https://i.scdn.co/image/${p.track}`,
        ),
        env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind(artist, `Name ${artist}`),
        env.DB.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind(p.track, artist),
      );
    }
    await env.DB.batch([...statements, ...syncAllSongs(env.DB)]);
  }

  /** One session from `startMs`, four minutes a song. */
  const session = (startMs: number, tracks: Array<Omit<Seed, 'ms'>>): Seed[] => tracks.map((t, i) => ({ ...t, ms: startMs + i * 4 * MIN }));

  interface Body {
    seed: { type: string; id: string; name: string | null; artist?: string | null };
    tracks: Array<{ id: string; name: string; artist: string | null; artist_id: string | null; album: string | null; image: string | null; sessions: number; score: number }>;
  }

  const get = async (query: string) => {
    const response = await SELF.fetch(`${BASE}/api/radio?${query}`, { headers: READ });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Body;
  };

  it('lists what is played near a track, every edition of it left out, with names and art', async () => {
    const now = Date.now();
    await seed([
      ...session(now - 2 * DAY, [{ track: 'seed', name: 'Seed', artist: 'sa' }, { track: 'near' }, { track: 'nearer-later' }]),
      ...session(now - DAY, [{ track: 'near' }, { track: 'seed-remaster', name: 'Seed - 2011 Remaster', artist: 'sa' }, { track: 'nearer-later' }]),
      { ms: now - 10 * DAY, track: 'elsewhere' },
    ]);
    const body = await get('track=seed');
    expect(body.seed).toEqual({ type: 'track', id: 'seed', name: 'Seed', artist: 'Name sa' });
    expect(body.tracks.map((t) => t.id)).toEqual(['near', 'nearer-later']);
    expect(body.tracks[0]).toEqual({
      id: 'near',
      name: 'Song near',
      artist: 'Name artist-near',
      artist_id: 'artist-near',
      album: 'Album near',
      image: 'https://i.scdn.co/image/near',
      sessions: 2,
      score: expect.any(Number),
    });
  });

  it("starts an artist's radio with its own songs, at most three, then the rest", async () => {
    const now = Date.now();
    await seed(
      session(now - DAY, [
        ...['a1', 'a2', 'a3', 'a4'].map((track) => ({ track, artist: 'star' })),
        { track: 'friend' },
      ]),
    );
    const body = await get('artist=star');
    expect(body.seed).toEqual({ type: 'artist', id: 'star', name: 'Name star' });
    expect(body.tracks.filter((t) => t.artist_id === 'star')).toHaveLength(3);
    expect(body.tracks.map((t) => t.id)).toContain('friend');
  });

  it('answers an unplayed seed with no tracks, and honours limit', async () => {
    expect((await get('track=never')).tracks).toEqual([]);
    const now = Date.now();
    await seed(session(now - DAY, [{ track: 's' }, { track: 'x' }, { track: 'y' }, { track: 'z' }]));
    expect((await get('track=s&limit=2')).tracks).toHaveLength(2);
  });

  it('reads rows for the seed and its sessions, not the whole history', async () => {
    const now = Date.now();
    // A long history elsewhere, then one session with the seed.
    await seed(Array.from({ length: 600 }, (_, i) => ({ ms: now - 400 * DAY + i * 4 * MIN, track: `other${i % 50}` })));
    await seed(session(now - DAY, [{ track: 's' }, { track: 'x' }, { track: 'y' }]));
    const response = await SELF.fetch(`${BASE}/api/radio?track=s`, { headers: READ });
    expect(((await response.json()) as Body).tracks.map((t) => t.id)).toEqual(['x', 'y']);
    expect(Number(response.headers.get('X-Rows-Read'))).toBeLessThan(100);
  });

  it('needs exactly one seed and a token', async () => {
    expect((await SELF.fetch(`${BASE}/api/radio`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/radio?track=a&artist=b`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/radio?track=a&limit=0`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/radio?track=a`)).status).toBe(401);
  });
});
