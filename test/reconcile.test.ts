import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { NAME_KEY_PREFIX, reconcileArtistsInPoll, reconcileNameKeyedArtists } from '../src/db';
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
