import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { writeStatements } from '../src/db';
import type { NormalizedRows } from '../src/types';

/** A payload shaped like one poll of a single track. */
function payload(track: Partial<NormalizedRows['tracks'][number]>): NormalizedRows {
  return {
    plays: [],
    tracks: [{ track_id: 't1', name: 'Sad Machine', duration_ms: null, album_id: null, isrc: null, first_seen_ms: 5_000, ...track }],
    artists: [],
    trackArtists: [],
    albums: [],
    skipped: 0,
    maxPlayedAtMs: 0,
  };
}

async function trackRow() {
  return env.DB.prepare('SELECT duration_ms, album_id, isrc FROM tracks WHERE track_id = ?').bind('t1').first();
}

async function applyAndCountWrites(rows: NormalizedRows): Promise<number> {
  const results = await env.DB.batch(writeStatements(env.DB, rows));
  return results.reduce((total, r) => total + (r.meta?.rows_written ?? 0), 0);
}

describe('tracks upsert guard', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM track_artists'),
      env.DB.prepare('DELETE FROM tracks'),
    ]);
  });

  it('fills an ISRC on a row that already has a duration and album', async () => {
    // The shape the Saved Albums backfill leaves behind: simplified tracks
    // carry a duration but no external_ids, so isrc stays NULL.
    await env.DB.prepare(
      "INSERT INTO tracks (track_id, name, duration_ms, album_id, isrc, first_seen_ms) VALUES ('t1','Sad Machine',180000,'alb1',NULL,5000)",
    ).run();

    await applyAndCountWrites(payload({ duration_ms: 180_000, album_id: 'alb1', isrc: 'ISRC1' }));

    expect(await trackRow()).toMatchObject({ isrc: 'ISRC1', album_id: 'alb1', duration_ms: 180_000 });
  });

  it('upgrades an export stub in one pass', async () => {
    await env.DB.prepare(
      "INSERT INTO tracks (track_id, name, first_seen_ms) VALUES ('t1','Sad Machine',9000)",
    ).run();

    await applyAndCountWrites(payload({ duration_ms: 180_000, album_id: 'alb1', isrc: 'ISRC1' }));

    expect(await trackRow()).toMatchObject({ duration_ms: 180_000, album_id: 'alb1', isrc: 'ISRC1' });
  });

  it('writes nothing when the row is already complete', async () => {
    await env.DB.prepare(
      "INSERT INTO tracks (track_id, name, duration_ms, album_id, isrc, first_seen_ms) VALUES ('t1','Sad Machine',180000,'alb1','ISRC1',5000)",
    ).run();

    const written = await applyAndCountWrites(payload({ duration_ms: 180_000, album_id: 'alb1', isrc: 'ISRC1' }));

    expect(written).toBe(0);
  });

  it('writes nothing for a track that genuinely has no ISRC upstream', async () => {
    // The regression the paired `excluded.<column> IS NOT NULL` conditions
    // prevent: a bare `isrc IS NULL` guard would rewrite this on every poll.
    await env.DB.prepare(
      "INSERT INTO tracks (track_id, name, duration_ms, album_id, isrc, first_seen_ms) VALUES ('t1','Sad Machine',180000,'alb1',NULL,5000)",
    ).run();

    const written = await applyAndCountWrites(payload({ duration_ms: 180_000, album_id: 'alb1', isrc: null }));

    expect(written).toBe(0);
  });
});
