import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { NAME_KEY_PREFIX, dailyTrackSweep, reconcileArtistsInPoll, reconcileNameKeyedArtists } from '../src/db';
import type { NormalizedRows } from '../src/types';

const NAME_KEY = `${NAME_KEY_PREFIX}Porter Robinson`;

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM track_artists"),
    env.DB.prepare("DELETE FROM artists"),
    env.DB.prepare("DELETE FROM tracks"),
    // 'exportOnly' came from the export alone; 'bothSeen' was also polled live.
    env.DB.prepare("INSERT INTO tracks (track_id, name, first_seen_ms) VALUES ('exportOnly', 'Sad Machine', 1), ('bothSeen', 'Musician', 2)"),
    env.DB.prepare(`INSERT INTO artists (artist_id, name) VALUES ('${NAME_KEY}', 'Porter Robinson'), ('realPorterId', 'Porter Robinson')`),
    env.DB.prepare(`INSERT INTO track_artists (track_id, artist_id, position) VALUES
       ('exportOnly', '${NAME_KEY}', 0),
       ('bothSeen',   '${NAME_KEY}', 0),
       ('bothSeen',   'realPorterId', 0)`),
  ]);
}

async function links(): Promise<Array<{ track_id: string; artist_id: string }>> {
  const query = await env.DB.prepare('SELECT track_id, artist_id FROM track_artists ORDER BY track_id, artist_id').all();
  return query.results as Array<{ track_id: string; artist_id: string }>;
}

describe('reconcileNameKeyedArtists', () => {
  beforeEach(seed);

  it('repoints an export-only track onto the real artist id', async () => {
    await env.DB.batch(reconcileNameKeyedArtists(env.DB));

    expect(await links()).toEqual([
      { track_id: 'bothSeen', artist_id: 'realPorterId' },
      { track_id: 'exportOnly', artist_id: 'realPorterId' },
    ]);
  });

  it('deletes the orphaned name-keyed artist row', async () => {
    await env.DB.batch(reconcileNameKeyedArtists(env.DB));

    const remaining = await env.DB.prepare('SELECT artist_id FROM artists').all();
    expect(remaining.results).toEqual([{ artist_id: 'realPorterId' }]);
  });

  it('counts each play once after merging', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, source) VALUES (100, 'bothSeen', 'api')"),
      ...reconcileNameKeyedArtists(env.DB),
    ]);

    const query = await env.DB.prepare(
      `SELECT a.name, COUNT(*) AS plays
         FROM plays p JOIN track_artists ta ON ta.track_id = p.track_id
         JOIN artists a ON a.artist_id = ta.artist_id
        GROUP BY a.name`,
    ).all();

    expect(query.results).toEqual([{ name: 'Porter Robinson', plays: 1 }]);
  });

  it('leaves a name-keyed artist alone when no real id shares its name', async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM track_artists WHERE artist_id = 'realPorterId'"),
      env.DB.prepare("DELETE FROM artists WHERE artist_id = 'realPorterId'"),
      ...reconcileNameKeyedArtists(env.DB),
    ]);

    expect(await links()).toEqual([
      { track_id: 'bothSeen', artist_id: NAME_KEY },
      { track_id: 'exportOnly', artist_id: NAME_KEY },
    ]);
  });
});

/** A poll's rows as normalize() produces them, holding only what the scoped reconcile reads. */
function poll(artists: NormalizedRows['artists'], trackArtists: NormalizedRows['trackArtists']): NormalizedRows {
  return { plays: [], tracks: [], albums: [], artists, trackArtists } as unknown as NormalizedRows;
}

describe('reconcileArtistsInPoll', () => {
  beforeEach(seed);

  it('merges the name-keyed rows of an artist the poll brought', async () => {
    await env.DB.batch(
      reconcileArtistsInPoll(env.DB, poll([{ artist_id: 'realPorterId', name: 'Porter Robinson' }], [
        { track_id: 'bothSeen', artist_id: 'realPorterId', position: 0 },
      ])),
    );

    expect(await links()).toEqual([
      { track_id: 'bothSeen', artist_id: 'realPorterId' },
      { track_id: 'exportOnly', artist_id: 'realPorterId' },
    ]);
    const remaining = await env.DB.prepare('SELECT artist_id FROM artists').all();
    expect(remaining.results).toEqual([{ artist_id: 'realPorterId' }]);
  });

  it('drops a name-keyed credit on a polled track that now has a real one under another name', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artists (artist_id, name) VALUES ('realOther', 'Porter Robinson & Friends')"),
      env.DB.prepare("DELETE FROM track_artists WHERE artist_id = 'realPorterId'"),
      env.DB.prepare("INSERT INTO track_artists (track_id, artist_id, position) VALUES ('bothSeen', 'realOther', 0)"),
      ...reconcileArtistsInPoll(env.DB, poll([{ artist_id: 'realOther', name: 'Porter Robinson & Friends' }], [
        { track_id: 'bothSeen', artist_id: 'realOther', position: 0 },
      ])),
    ]);

    expect(await links()).toEqual([
      { track_id: 'bothSeen', artist_id: 'realOther' },
      { track_id: 'exportOnly', artist_id: NAME_KEY },
    ]);
  });

  it('leaves artists and tracks outside the poll for the daily sweep', async () => {
    await env.DB.batch(
      reconcileArtistsInPoll(env.DB, poll([{ artist_id: 'someoneElse', name: 'Madeon' }], [
        { track_id: 'otherTrack', artist_id: 'someoneElse', position: 0 },
      ])),
    );

    expect(await links()).toEqual([
      { track_id: 'bothSeen', artist_id: NAME_KEY },
      { track_id: 'bothSeen', artist_id: 'realPorterId' },
      { track_id: 'exportOnly', artist_id: NAME_KEY },
    ]);
  });

  it('copes with an empty poll and names that need quoting', async () => {
    await env.DB.batch(reconcileArtistsInPoll(env.DB, poll([], [])));
    await env.DB.batch(reconcileArtistsInPoll(env.DB, poll([{ artist_id: 'x', name: "Guns N' Roses \"live\"" }], [])));
    expect(await links()).toHaveLength(3);
  });
});

describe('dailyTrackSweep', () => {
  const text = async (id: string) =>
    (await env.DB.prepare('SELECT text FROM track_search_text WHERE track_id = ?').bind(id).first<{ text: string }>())?.text;
  const song = async (id: string) =>
    (await env.DB.prepare('SELECT song FROM track_songs WHERE track_id = ?').bind(id).first<{ song: string }>())?.song;
  const marked = async () =>
    (await env.DB.prepare('SELECT track_id FROM track_changes ORDER BY track_id').all<{ track_id: string }>()).results.map((r) => r.track_id);

  beforeEach(async () => {
    await seed();
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
         INSERT INTO tracks (track_id, name, first_seen_ms) SELECT 'other' || i, 'Other ' || i, 0 FROM n`,
      ),
      env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, source) VALUES (100, 'exportOnly', 'export'), (200, 'bothSeen', 'api')"),
    ]);
    // Everything stored so far is marked, so the first sweep covers it all.
    expect(await marked()).toContain('other7');
    await env.DB.batch(dailyTrackSweep(env.DB));
    expect(await marked()).toEqual([]);
  });

  it('syncs what an album backfill changed, and reads only that', async () => {
    expect(await text('exportOnly')).toBe('Sad Machine |  | Porter Robinson');
    await env.DB.batch([
      env.DB.prepare("INSERT INTO albums (album_id, name) VALUES ('worlds', 'Worlds')"),
      env.DB.prepare("UPDATE tracks SET album_id = 'worlds' WHERE track_id = 'exportOnly'"),
    ]);
    expect(await marked()).toEqual(['exportOnly']);

    const results = await env.DB.batch(dailyTrackSweep(env.DB));
    expect(await text('exportOnly')).toBe('Sad Machine | Worlds | Porter Robinson');
    expect(await marked()).toEqual([]);
    // About the marked track's rows, not all 202 tracks'.
    const [, , , search, rekey] = results;
    expect(search!.meta.rows_read + rekey!.meta.rows_read).toBeLessThan(60);
  });

  it('rekeys and reindexes a track whose credit the reconcile moved', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artists (artist_id, name) VALUES ('madeon', 'Madeon'), ('name:Madeon', 'Madeon')"),
      env.DB.prepare("INSERT INTO track_artists (track_id, artist_id, position) VALUES ('other3', 'name:Madeon', 0)"),
      // As a poll leaves it: synced already, while still credited to the placeholder.
      env.DB.prepare('DELETE FROM track_changes'),
    ]);
    await env.DB.batch(dailyTrackSweep(env.DB));
    expect(await env.DB.prepare("SELECT artist_id FROM track_artists WHERE track_id = 'other3'").first('artist_id')).toBe('madeon');
    expect(await song('other3')).toBe(`other 3${String.fromCharCode(31)}madeon`);
    expect(await text('other3')).toBe('Other 3 |  | Madeon');
    expect(await marked()).toEqual([]);
  });

  it('reads almost nothing when nothing changed', async () => {
    const results = await env.DB.batch(dailyTrackSweep(env.DB));
    expect(results.reduce((sum, r) => sum + r.meta.rows_read, 0)).toBeLessThan(40);
  });
});
