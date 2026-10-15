import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const MIN = 60_000;
const JAN_10 = Date.UTC(2024, 0, 10, 12);

interface Play {
  trackId: string;
  name: string;
  artistId: string;
  artistName: string;
  position?: number;
}

/** `count` plays of each track, five minutes apart. */
async function seed(tracks: Array<Play & { count: number }>) {
  const statements: D1PreparedStatement[] = [];
  let ms = JAN_10;
  for (const track of tracks) {
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, first_seen_ms) VALUES (?, ?, ?, ?)').bind(
        track.trackId,
        track.name,
        200_000,
        ms,
      ),
      env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind(track.artistId, track.artistName),
      env.DB.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)').bind(
        track.trackId,
        track.artistId,
        track.position ?? 0,
      ),
    );
    for (let i = 0; i < track.count; i++) {
      ms += 5 * MIN;
      statements.push(env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(ms, track.trackId, 'api'));
    }
  }
  await env.DB.batch(statements);
}

interface SearchBody {
  q: string;
  artists: Array<{ id: string | null; name: string; plays: number }>;
  tracks: Array<{ id: string; name: string; artist: string | null; plays: number }>;
}

async function search(query: string): Promise<SearchBody> {
  const response = await SELF.fetch(`${BASE}/api/search?${query}`, { headers: READ });
  expect(response.status).toBe(200);
  return (await response.json()) as SearchBody;
}

describe('/api/search', () => {
  it('needs a token and a query', async () => {
    expect((await SELF.fetch(`${BASE}/api/search?q=x`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/search`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/search?q=%20`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/search?q=x&limit=51`, { headers: READ })).status).toBe(400);
  });

  it('folds export placeholders into the real artist and editions into one song', async () => {
    await seed([
      { trackId: 'live', name: 'Shelter', artistId: 'real-id', artistName: 'Porter Robinson', count: 3 },
      { trackId: 'export', name: 'shelter', artistId: 'name:porter robinson', artistName: 'porter robinson', count: 2 },
      // A feature: matches by name, but credited at position 1, so not his play.
      { trackId: 'feat', name: 'Something', artistId: 'real-id', artistName: 'Porter Robinson', position: 1, count: 4 },
    ]);
    const body = await search('q=porter');
    expect(body.artists).toEqual([{ id: 'real-id', name: 'Porter Robinson', plays: 5 }]);
    expect((await search('q=SHELTER')).tracks).toEqual([{ id: 'live', name: 'Shelter', artist: 'Porter Robinson', plays: 5 }]);
  });

  it('gives a placeholder-only artist a null id and the most-played spelling', async () => {
    await seed([
      { trackId: 'a', name: 'One', artistId: 'name:madeon', artistName: 'madeon', count: 1 },
      { trackId: 'b', name: 'Two', artistId: 'name:Madeon', artistName: 'Madeon', count: 3 },
    ]);
    expect((await search('q=madeon')).artists).toEqual([{ id: null, name: 'Madeon', plays: 4 }]);
  });

  it('ranks exact matches first, then by plays', async () => {
    await seed([
      { trackId: 'long', name: 'Hello World', artistId: 'x', artistName: 'X', count: 9 },
      { trackId: 'exact', name: 'Hello', artistId: 'y', artistName: 'Y', count: 1 },
      { trackId: 'mid', name: 'Hello Again', artistId: 'z', artistName: 'Z', count: 4 },
    ]);
    expect((await search('q=hello')).tracks.map((t) => t.id)).toEqual(['exact', 'long', 'mid']);
    expect((await search('q=hello&limit=1')).tracks.map((t) => t.id)).toEqual(['exact']);
  });

  it('narrows songs by artist, keeping same-titled songs by others apart', async () => {
    await seed([
      { trackId: 'a', name: 'Hit', artistId: 'x', artistName: 'Band X', count: 2 },
      { trackId: 'b', name: 'Hit', artistId: 'y', artistName: 'Band Y', count: 1 },
    ]);
    expect((await search('q=hit')).tracks).toHaveLength(2);
    expect((await search('q=hit&artist=band%20y')).tracks).toEqual([{ id: 'b', name: 'Hit', artist: 'Band Y', plays: 1 }]);
  });

  it('treats LIKE wildcards in the query literally', async () => {
    await seed([
      { trackId: 'a', name: '100% Pure', artistId: 'x', artistName: 'X', count: 1 },
      { trackId: 'b', name: '1000 Pure', artistId: 'y', artistName: 'Y', count: 1 },
    ]);
    expect((await search('q=100%25')).tracks.map((t) => t.id)).toEqual(['a']);
    expect((await search('q=_')).tracks).toEqual([]);
  });

  it('answers no matches with empty lists', async () => {
    expect(await search('q=nothing')).toEqual({ q: 'nothing', artists: [], tracks: [] });
  });
});
