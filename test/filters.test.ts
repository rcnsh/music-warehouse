import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { syncSearchIndex } from '../src/search-index';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const HOUR = 3_600_000;
const DAY = 86_400_000;
const START = Date.UTC(2024, 2, 1, 12);

interface Track {
  id: string;
  name: string;
  artistId: string;
  artistName: string;
  position?: number;
}

/**
 * One song in three editions (a live id, a differently-cased re-release, and
 * an export copy under a `name:` placeholder), a feature by the same artist,
 * and someone else's song of the same title.
 */
const TRACKS: Track[] = [
  { id: 'shelter', name: 'Shelter', artistId: 'porter', artistName: 'Porter Robinson' },
  { id: 'shelter-re', name: 'SHELTER', artistId: 'porter', artistName: 'Porter Robinson' },
  { id: 'shelter-exp', name: 'shelter', artistId: 'name:porter robinson', artistName: 'porter robinson' },
  { id: 'sad', name: 'Sad Machine', artistId: 'porter', artistName: 'Porter Robinson' },
  { id: 'feat', name: 'Feature', artistId: 'porter', artistName: 'Porter Robinson', position: 1 },
  { id: 'other', name: 'Shelter', artistId: 'someone', artistName: 'Someone Else' },
];

/** Plays an hour apart, in the order given. */
async function seed(order: string[]) {
  const statements: D1PreparedStatement[] = [];
  for (const track of TRACKS) {
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, first_seen_ms) VALUES (?, ?, 200000, 0)').bind(
        track.id,
        track.name,
      ),
      env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind(track.artistId, track.artistName),
      env.DB.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)').bind(
        track.id,
        track.artistId,
        track.position ?? 0,
      ),
    );
  }
  order.forEach((trackId, i) => {
    statements.push(
      env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(START + i * HOUR, trackId, 'api'),
    );
  });
  await env.DB.batch([...statements, syncSearchIndex(env.DB)]);
}

async function get<T>(path: string): Promise<T> {
  const response = await SELF.fetch(`${BASE}${path}`, { headers: READ });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

type PlaysBody = Record<string, unknown> & { plays: Array<{ played_at_ms: number; track_id: string }> };
const ids = (body: PlaysBody) => body.plays.map((play) => play.track_id);

const ORDER = ['shelter', 'sad', 'shelter-re', 'feat', 'shelter-exp', 'other', 'shelter'];

describe('/api/plays filtered to one song or artist', () => {
  it('takes every edition of the song, as /api/track folds them', async () => {
    await seed(ORDER);
    const body = await get<PlaysBody>('/api/plays?track_id=shelter');
    expect(ids(body)).toEqual(['shelter', 'shelter-exp', 'shelter-re', 'shelter']);
    expect(body.track_id).toBe('shelter');
    // Any edition's id names the same song.
    expect(ids(await get<PlaysBody>('/api/plays?track_id=shelter-exp'))).toEqual(ids(body));
    const track = await get<{ plays: number }>('/api/track?id=shelter');
    expect(track.plays).toBe(body.plays.length);
  });

  it('takes the artist’s plays as /api/artist credits them: primary only, placeholders folded', async () => {
    await seed(ORDER);
    const body = await get<PlaysBody>('/api/plays?artist_id=porter');
    expect(ids(body)).toEqual(['shelter', 'shelter-exp', 'shelter-re', 'sad', 'shelter']);
    expect(body.artist_id).toBe('porter');
    const artist = await get<{ plays: number }>('/api/artist?id=porter');
    expect(artist.plays).toBe(body.plays.length);
    // The export-only spelling reaches the same plays by name.
    expect(ids(await get<PlaysBody>('/api/plays?artist_name=PORTER%20ROBINSON'))).toEqual(ids(body));
  });

  it('pages with before and after, and combines with q and with each other', async () => {
    await seed(ORDER);
    const first = await get<PlaysBody>('/api/plays?artist_id=porter&limit=2');
    expect(ids(first)).toEqual(['shelter', 'shelter-exp']);
    const next = await get<PlaysBody>(`/api/plays?artist_id=porter&limit=2&before=${first.plays[1]!.played_at_ms}`);
    expect(ids(next)).toEqual(['shelter-re', 'sad']);
    expect(ids(await get<PlaysBody>(`/api/plays?artist_id=porter&after=${START + 3 * HOUR}`))).toEqual(['shelter', 'shelter-exp']);

    const both = await get<PlaysBody>('/api/plays?artist_id=porter&q=machine');
    expect(ids(both)).toEqual(['sad']);
    expect(both).toMatchObject({ q: 'machine', artist_id: 'porter' });
    expect(ids(await get<PlaysBody>('/api/plays?track_id=other&artist_id=porter'))).toEqual([]);
  });

  it('answers an unknown song or artist with no plays, echoing the filter', async () => {
    await seed(ORDER);
    expect(await get<PlaysBody>('/api/plays?track_id=nope')).toMatchObject({ track_id: 'nope', plays: [] });
    expect(await get<PlaysBody>('/api/plays?artist_id=nope')).toMatchObject({ artist_id: 'nope', plays: [] });
  });
});

describe('/api/daily filtered to one song or artist', () => {
  it('counts only that song’s or artist’s plays per local day', async () => {
    // Plays a day apart, so each lands on its own day.
    const statements: D1PreparedStatement[] = [];
    await seed([]);
    ORDER.forEach((trackId, i) => {
      statements.push(
        env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(START + i * DAY, trackId, 'api'),
      );
    });
    await env.DB.batch(statements);

    type Daily = Record<string, unknown> & { days: Array<{ day: string; plays: number }> };
    const range = 'from=2024-03-01&to=2024-03-07&tz=Asia/Singapore';
    const song = await get<Daily>(`/api/daily?${range}&track_id=shelter`);
    expect(song.track_id).toBe('shelter');
    expect(song.days.map((d) => d.plays)).toEqual([1, 0, 1, 0, 1, 0, 1]);
    const artist = await get<Daily>(`/api/daily?${range}&artist_id=porter`);
    expect(artist.days.map((d) => d.plays)).toEqual([1, 1, 1, 0, 1, 0, 1]);
    const all = await get<Daily>(`/api/daily?${range}`);
    expect(all.days.map((d) => d.plays)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(all.track_id).toBeUndefined();
  });
});
