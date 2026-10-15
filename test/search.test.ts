import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { syncSearchIndex } from '../src/search-index';

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
  // Writes keep the trigram index in step, as polls and imports do.
  await env.DB.batch([...statements, syncSearchIndex(env.DB)]);
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

  it('finds one- and two-character names, which the trigram index cannot', async () => {
    await seed([
      { trackId: 'a', name: 'One', artistId: 'u2', artistName: 'U2', count: 2 },
      { trackId: 'b', name: 'X', artistId: 'y', artistName: 'Someone', count: 1 },
    ]);
    expect((await search('q=u2')).artists).toEqual([{ id: 'u2', name: 'U2', plays: 2 }]);
    expect((await search('q=x')).tracks.map((t) => t.id)).toEqual(['b']);
  });

  it('matches names, not the album or other credits the index also holds', async () => {
    await seed([{ trackId: 'a', name: 'Song', artistId: 'x', artistName: 'Porter Robinson', count: 2 }]);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO albums (album_id, name) VALUES ('al', 'Porter Album')"),
      env.DB.prepare("UPDATE tracks SET album_id = 'al' WHERE track_id = 'a'"),
      syncSearchIndex(env.DB),
    ]);
    const body = await search('q=porter');
    expect(body.artists).toEqual([{ id: 'x', name: 'Porter Robinson', plays: 2 }]);
    expect(body.tracks).toEqual([]);
    expect((await search('q=song&artist=porter')).tracks).toEqual([{ id: 'a', name: 'Song', artist: 'Porter Robinson', plays: 2 }]);
  });

  it('counts a short query’s closest matches as before, and only those', async () => {
    await seed([
      { trackId: 'a1', name: 'Oslo', artistId: 'o1', artistName: 'Oh Wonder', count: 3 },
      { trackId: 'a2', name: 'Drive', artistId: 'o1', artistName: 'Oh Wonder', count: 5 },
      { trackId: 'a3', name: 'Ultralife', artistId: 'name:Oh Wonder', artistName: 'Oh Wonder', count: 2 },
      { trackId: 'a4', name: 'Oslo', artistId: 'o2', artistName: 'Other', count: 4 },
      { trackId: 'a5', name: 'Feat', artistId: 'o1', artistName: 'Oh Wonder', position: 1, count: 7 },
      { trackId: 'a6', name: 'Unknown', artistId: 'o3', artistName: 'Odd', count: 0 },
      // The export's edition of a1's song, under the placeholder: one song, two editions, two artist rows.
      { trackId: 'a7', name: 'oslo', artistId: 'name:Oh Wonder', artistName: 'Oh Wonder', count: 2 },
    ]);

    // What the short path used to count: every play of every matching row.
    const counted = async (sql: string, ...binds: string[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
    const body = await search('q=o&limit=50');
    for (const a of body.artists) {
      expect(a.plays, a.name).toBe(
        await counted(
          `SELECT COUNT(*) AS n FROM artists a JOIN track_artists ta ON ta.artist_id = a.artist_id AND ta.position = 0
             JOIN plays p ON p.track_id = ta.track_id WHERE a.name = ? COLLATE NOCASE`,
          a.name,
        ),
      );
    }
    expect(body.artists).toEqual([
      { id: 'o1', name: 'Oh Wonder', plays: 12 },
      { id: 'o2', name: 'Other', plays: 4 },
      { id: 'o3', name: 'Odd', plays: 0 },
    ]);
    // Oslo by Oh Wonder folds a1 and a7, and takes the id of the edition played most.
    expect(body.tracks.map((t) => [t.id, t.name, t.artist, t.plays])).toEqual([
      ['a1', 'Oslo', 'Oh Wonder', 5],
      ['a4', 'Oslo', 'Other', 4],
      ['a6', 'Unknown', 'Odd', 0],
    ]);
  });

  it('counts only the hundred artist names that match a short query best', async () => {
    await seed([
      { trackId: 'a1', name: 'Song', artistId: 'o1', artistName: 'Oh Wonder', count: 1 },
      { trackId: 'a2', name: 'Hit', artistId: 'big', artistName: 'Zzzzz Big Zoo', count: 9 },
    ]);
    // A hundred short names that merely contain the letter, and so match better than the big one.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
       INSERT INTO artists (artist_id, name) SELECT 'z' || i, 'Zo' || i FROM n`,
    ).run();
    const names = (await search('q=o&limit=50')).artists.map((a) => a.name);
    expect(names[0]).toBe('Oh Wonder');
    expect(names).not.toContain('Zzzzz Big Zoo');
    expect((await search('q=big')).artists).toEqual([{ id: 'big', name: 'Zzzzz Big Zoo', plays: 9 }]);
  });

  it('keeps a short query’s answer a few minutes, whatever its ASCII case', async () => {
    await seed([{ trackId: 'a', name: 'One', artistId: 'u2', artistName: 'U2', count: 2 }]);
    expect((await search('q=u2')).artists).toEqual([{ id: 'u2', name: 'U2', plays: 2 }]);
    await env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(JAN_10 - MIN, 'a', 'api').run();
    const again = await search('q=U2');
    expect(again.q).toBe('U2');
    expect(again.artists).toEqual([{ id: 'u2', name: 'U2', plays: 2 }]);
  });

  it('answers no matches with empty lists', async () => {
    expect(await search('q=nothing')).toEqual({ q: 'nothing', artists: [], tracks: [] });
  });
});
