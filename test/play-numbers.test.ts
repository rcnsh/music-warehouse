import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { writeStatements } from '../src/db';
import { syncAllSongs } from '../src/play-numbers';
import type { NormalizedRows } from '../src/types';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };
const HOUR = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);

interface Track {
  id: string;
  name: string;
  artistId: string;
  artistName: string;
}

const SHELTER: Track = { id: 'shelter', name: 'Shelter', artistId: 'porter', artistName: 'Porter Robinson' };
const SHELTER_RE: Track = { id: 'shelter-re', name: 'SHELTER', artistId: 'porter', artistName: 'Porter Robinson' };
const SAD: Track = { id: 'sad', name: 'Sad Machine', artistId: 'porter', artistName: 'Porter Robinson' };
const OTHER: Track = { id: 'other', name: 'Shelter', artistId: 'someone', artistName: 'Someone Else' };

/** One poll's worth of plays, written exactly as a poll writes them. */
async function poll(plays: Array<[number, Track]>) {
  const tracks = new Map(plays.map(([, track]) => [track.id, track]));
  const rows: NormalizedRows = {
    plays: plays.map(([hour, track]) => ({ played_at_ms: T0 + hour * HOUR, track_id: track.id, context_uri: null, context_type: null })),
    tracks: [...tracks.values()].map((t) => ({ track_id: t.id, name: t.name, duration_ms: 200_000, album_id: null, isrc: null, first_seen_ms: T0 })),
    artists: [...tracks.values()].map((t) => ({ artist_id: t.artistId, name: t.artistName })),
    trackArtists: [...tracks.values()].map((t) => ({ track_id: t.id, artist_id: t.artistId, position: 0 })),
    albums: [],
    skipped: 0,
    maxPlayedAtMs: 0,
  };
  await env.DB.batch(writeStatements(env.DB, rows));
}

/**
 * What every play's number should be, counted the slow way: plays of the
 * same lowercased title and primary artist up to and including it.
 */
async function expectedNumbers(): Promise<Map<string, number>> {
  const plays = (
    await env.DB.prepare(
      `SELECT p.played_at_ms, p.track_id, t.name,
              (SELECT a.name FROM track_artists ta JOIN artists a ON a.artist_id = ta.artist_id
                WHERE ta.track_id = p.track_id AND ta.position = 0 ORDER BY a.artist_id LIMIT 1) AS artist
         FROM plays p JOIN tracks t ON t.track_id = p.track_id
        ORDER BY p.played_at_ms, p.track_id`,
    ).all<{ played_at_ms: number; track_id: string; name: string; artist: string }>()
  ).results;
  const seen = new Map<string, number>();
  const out = new Map<string, number>();
  for (const play of plays) {
    const song = `${play.name.toLowerCase()}|${play.artist.toLowerCase()}`;
    seen.set(song, (seen.get(song) ?? 0) + 1);
    out.set(`${play.played_at_ms}:${play.track_id}`, seen.get(song)!);
  }
  return out;
}

async function storedNumbers(): Promise<Map<string, number>> {
  const rows = (await env.DB.prepare('SELECT played_at_ms, track_id, n FROM play_numbers').all<{ played_at_ms: number; track_id: string; n: number }>())
    .results;
  return new Map(rows.map((row) => [`${row.played_at_ms}:${row.track_id}`, row.n]));
}

async function expectNumbersRight() {
  const expected = await expectedNumbers();
  expect(expected.size).toBeGreaterThan(0);
  expect(await storedNumbers()).toEqual(expected);
}

interface PlayRow {
  track_id: string;
  played_at_ms: number;
  play_number: number | null;
  first_play: boolean | null;
}

async function plays(query = ''): Promise<PlayRow[]> {
  const response = await SELF.fetch(`${BASE}/api/plays?limit=500${query}`, { headers: READ });
  expect(response.status).toBe(200);
  return ((await response.json()) as { plays: PlayRow[] }).plays;
}

describe('play numbers', () => {
  it('counts each song’s plays across its editions, oldest first', async () => {
    await poll([[0, SHELTER], [1, SAD], [2, OTHER]]);
    await poll([[3, SHELTER_RE], [4, SHELTER], [5, SAD]]);
    await poll([[6, SHELTER], [6, SHELTER_RE]]);
    await expectNumbersRight();

    const rows = await plays();
    expect(rows.map((row) => [row.track_id, row.play_number, row.first_play])).toEqual([
      ['shelter-re', 5, false],
      ['shelter', 4, false],
      ['sad', 2, false],
      ['shelter', 3, false],
      ['shelter-re', 2, false],
      ['other', 1, true],
      ['sad', 1, true],
      ['shelter', 1, true],
    ]);
  });

  it('renumbers the rest of a song when older plays are imported', async () => {
    await poll([[10, SHELTER], [11, SAD], [12, SHELTER]]);
    const response = await SELF.fetch(`${BASE}/admin/import`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify([
        { ts: new Date(T0 + 1 * HOUR).toISOString(), spotify_track_uri: 'spotify:track:shelter-exp', master_metadata_track_name: 'shelter', master_metadata_album_artist_name: 'porter robinson' },
        { ts: new Date(T0 + 11.5 * HOUR).toISOString(), spotify_track_uri: 'spotify:track:shelter', master_metadata_track_name: 'Shelter', master_metadata_album_artist_name: 'Porter Robinson' },
      ]),
    });
    expect(response.status).toBe(200);
    await expectNumbersRight();
    const first = (await plays()).filter((row) => row.first_play);
    expect(first.map((row) => row.track_id).sort()).toEqual(['sad', 'shelter-exp']);
  });

  it('moves a track’s plays to its new song when its title changes', async () => {
    // An export stub, renamed when a poll first fills it in.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tracks (track_id, name, first_seen_ms) VALUES ('stub', 'Shelter (Live)', 0)"),
      env.DB.prepare("INSERT INTO artists (artist_id, name) VALUES ('porter', 'Porter Robinson')"),
      env.DB.prepare("INSERT INTO track_artists (track_id, artist_id, position) VALUES ('stub', 'porter', 0)"),
      env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(T0, 'stub', 'export'),
      ...syncAllSongs(env.DB),
    ]);
    await poll([[1, SHELTER], [2, { ...SHELTER, id: 'stub' }]]);
    await expectNumbersRight();
    expect((await plays()).map((row) => row.play_number)).toEqual([3, 2, 1]);
  });

  it('catches a primary artist change the daily sweep finds', async () => {
    await poll([[0, SHELTER], [1, OTHER], [2, OTHER]]);
    // As the artist reconcile can: the track's credit now names someone else.
    await env.DB.prepare("UPDATE track_artists SET artist_id = 'someone' WHERE track_id = 'shelter'").run();
    await env.DB.batch(syncAllSongs(env.DB));
    await expectNumbersRight();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM track_songs WHERE dirty = 1').first('n')).toBe(0);
  });

  it('is unchanged by a repeated poll and writes nothing the second time', async () => {
    await poll([[0, SHELTER], [1, SHELTER]]);
    const before = await storedNumbers();
    const tracks = [SHELTER];
    const rows: NormalizedRows = {
      plays: [{ played_at_ms: T0 + HOUR, track_id: 'shelter', context_uri: null, context_type: null }],
      tracks: tracks.map((t) => ({ track_id: t.id, name: t.name, duration_ms: 200_000, album_id: null, isrc: null, first_seen_ms: T0 })),
      artists: tracks.map((t) => ({ artist_id: t.artistId, name: t.artistName })),
      trackArtists: tracks.map((t) => ({ track_id: t.id, artist_id: t.artistId, position: 0 })),
      albums: [],
      skipped: 0,
      maxPlayedAtMs: 0,
    };
    const results = await env.DB.batch(writeStatements(env.DB, rows));
    expect(results.reduce((sum, r) => sum + (r.meta?.rows_written ?? 0), 0)).toBe(0);
    expect(await storedNumbers()).toEqual(before);
  });

  it('backfills the same numbers in migration 0012', async () => {
    await poll([[0, SHELTER], [1, SAD], [2, SHELTER_RE], [3, OTHER], [4, SHELTER]]);
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0012'))!;
    const backfill = migration.queries.filter((sql) => sql.trim().startsWith('INSERT'));
    expect(backfill).toHaveLength(2);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM play_numbers'),
      env.DB.prepare('DELETE FROM track_songs'),
      ...backfill.map((sql) => env.DB.prepare(sql)),
    ]);
    await expectNumbersRight();
    // And it keys songs exactly as the upkeep does: a sweep finds nothing to change.
    const results = await env.DB.batch(syncAllSongs(env.DB));
    expect(results.reduce((sum, r) => sum + (r.meta?.rows_written ?? 0), 0)).toBe(0);
  });

  it('numbers filtered and searched pages too', async () => {
    await poll([[0, SHELTER], [1, SAD], [2, SHELTER_RE]]);
    expect((await plays('&track_id=shelter')).map((row) => row.play_number)).toEqual([2, 1]);
    expect((await plays('&q=machine')).map((row) => [row.play_number, row.first_play])).toEqual([[1, true]]);
  });
});
