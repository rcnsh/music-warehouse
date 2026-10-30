import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { syncAllSongs } from '../src/play-numbers';
import { SONG_SQL, songKey } from '../src/songs';

const CASES: Array<[string, string]> = [
  // Same recording, re-released or re-cut: folded.
  ['heroes - 2017 remaster', 'heroes'],
  ['heroes - remastered 2011', 'heroes'],
  ['heroes - 2011 remastered', 'heroes'],
  ['heroes - remastered', 'heroes'],
  ['heroes - remaster', 'heroes'],
  ['heroes (remastered)', 'heroes'],
  ['heroes [2009 remaster]', 'heroes'],
  ['heroes - 2003 digital remaster', 'heroes'],
  ['heroes - digitally remastered', 'heroes'],
  ['heroes - remastered 1999 version', 'heroes'],
  ['heroes - 1999 remastered version', 'heroes'],
  ['heroes - single version', 'heroes'],
  ['heroes (single version)', 'heroes'],
  ['heroes - radio edit', 'heroes'],
  ['heroes (radio edit)', 'heroes'],
  ['Heroes - 2017 Remaster', 'heroes'],
  ['HEROES (Single Version)', 'heroes'],
  // Only the last tag, and only at the very end.
  ['heroes (feat. x) - 2017 remaster', 'heroes (feat. x)'],
  ['heroes - remastered - live', 'heroes - remastered - live'],
  // Different performances, or not a tag at all: kept apart.
  ['heroes - live', 'heroes - live'],
  ['Heroes - Live', 'heroes - live'],
  ['heroes - acoustic', 'heroes - acoustic'],
  ['heroes - remix', 'heroes - remix'],
  ['heroes - live / remastered 2011', 'heroes - live / remastered 2011'],
  ['heroes - 17 remaster', 'heroes - 17 remaster'],
  ['remastered', 'remastered'],
  [' - remastered', ' - remastered'],
  ['radio edit', 'radio edit'],
  ['the remaster', 'the remaster'],
  ['heroes', 'heroes'],
  ['', ''],
  // ASCII letters are lowercased, others kept, as SQLite's lower() does.
  ['Ára Bátur - 2020 Remaster', 'Ára bátur'],
  ['ÁRA BÁTUR', 'Ára bÁtur'],
];

const ARTISTS = ['David Bowie', 'Ólafur Arnalds'];

const key = (song: string, artist: string) => `${song}\x1f${artist}`;

async function seed(tracks: Array<{ track_id: string; name: string; artist: string | null }>) {
  await env.DB.batch(
    tracks.flatMap(({ track_id, name, artist }) => [
      env.DB.prepare('INSERT INTO tracks (track_id, name, duration_ms, first_seen_ms) VALUES (?, ?, 200000, 0)').bind(track_id, name),
      ...(artist === null
        ? []
        : [
            env.DB.prepare('INSERT OR IGNORE INTO artists (artist_id, name) VALUES (?, ?)').bind(`id-${artist}`, artist),
            env.DB.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind(track_id, `id-${artist}`),
          ]),
    ]),
  );
}

describe('songKey', () => {
  it.each(CASES)('%j is the song %j', (title, song) => {
    expect(songKey({ track_id: 't', name: title, artist: 'David Bowie' })).toBe(key(song, 'david bowie'));
  });

  it('keeps a remaster with its song and a live take apart', () => {
    const song = (name: string) => songKey({ track_id: name, name, artist: 'David Bowie' });
    expect(song('Heroes - 2017 Remaster')).toBe(song('Heroes'));
    expect(song('Heroes - Live')).not.toBe(song('Heroes'));
  });

  it('lowercases ASCII only, so a non-ASCII capital is its own spelling', () => {
    const song = (artist: string) => songKey({ track_id: 't', name: 'Ára bátur', artist });
    expect(song('Ólafur Arnalds')).toBe(song('ÓLAFUR ARNALDS'));
    expect(song('Ólafur Arnalds')).not.toBe(song('ólafur arnalds'));
  });

  it('keeps a track with no primary artist to itself', () => {
    expect(songKey({ track_id: 'a', name: 'Intro', artist: null })).not.toBe(songKey({ track_id: 'b', name: 'Intro', artist: null }));
  });

  it('is the key play numbers store, which SONG_SQL reads', async () => {
    const tracks = [
      ...ARTISTS.flatMap((artist, i) => CASES.map(([name], j) => ({ track_id: `t${i}-${j}`, name, artist }))),
      { track_id: 'solo', name: 'Intro', artist: null },
    ];
    await seed(tracks);
    await env.DB.batch(syncAllSongs(env.DB));
    const { results } = await env.DB.prepare(`SELECT t.track_id, ${SONG_SQL('t.track_id')} AS song FROM tracks t`).all<{
      track_id: string;
      song: string;
    }>();
    const stored = new Map(results.map((row) => [row.track_id, row.song]));
    expect(tracks.map((track) => [track.track_id, stored.get(track.track_id)])).toEqual(
      tracks.map((track) => [track.track_id, songKey(track)]),
    );
  });

  it('stands a track not keyed yet alone in SQL, as songKey does a track with no artist', async () => {
    await seed([{ track_id: 'new', name: 'Heroes', artist: 'David Bowie' }]);
    const row = await env.DB.prepare(`SELECT ${SONG_SQL('?1')} AS song`).bind('new').first<{ song: string }>();
    expect(row!.song).toBe(songKey({ track_id: 'new', name: 'Heroes', artist: null }));
  });
});

describe('migration 0016', () => {
  it('is the daily song sweep', () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0016_'));
    const squash = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
    const fake = { prepare: (sql: string) => ({ sql, bind: () => ({ sql }) }) } as unknown as D1Database;
    const sweep = syncAllSongs(fake).map((statement) => squash((statement as unknown as { sql: string }).sql));
    expect(migration!.queries.map(squash)).toEqual(sweep);
  });
});
