import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { writeStatements } from '../src/db';
import { buildEras, parseEras } from '../src/eras';
import { normalizeExport } from '../src/import';
import { edgeRequest } from '../src/snapshots';
import type { NormalizedRows } from '../src/types';
import { wrappedKey } from '../src/wrapped';

const BASE = 'https://warehouse.test';
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };
const ERAS = buildEras(parseEras(env.ERAS, undefined), 0);
const MIN = 60_000;
const T = Date.parse('2024-03-05T12:00:00Z');

/** Polled plays of "Shelter" by Porter Robinson ending at `times`, written as a poll writes them. */
async function poll(times: number[], trackId = 'shelter') {
  const rows: NormalizedRows = {
    plays: times.map((ms) => ({ played_at_ms: ms, track_id: trackId, context_uri: null, context_type: null })),
    tracks: [{ track_id: trackId, name: 'Shelter', duration_ms: 200_000, album_id: null, isrc: null, first_seen_ms: Math.min(...times) }],
    artists: [{ artist_id: 'porter', name: 'Porter Robinson' }],
    trackArtists: [{ track_id: trackId, artist_id: 'porter', position: 0 }],
    albums: [],
    skipped: 0,
    maxPlayedAtMs: Math.max(...times),
  };
  await env.DB.batch(writeStatements(env.DB, rows));
}

/** An export record of the same song ending at `ms`, which the export truncates to the second. */
function record(ms: number, msPlayed: number | null = 200_000, trackId = 'shelter') {
  return {
    ts: new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
    ms_played: msPlayed,
    spotify_track_uri: `spotify:track:${trackId}`,
    master_metadata_track_name: 'Shelter',
    master_metadata_album_artist_name: 'Porter Robinson',
  };
}

async function post(path: string, body?: unknown) {
  const response = await SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: ADMIN,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status, path).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** Store records as an import before these fixes did: without looking at ms_played. */
async function legacyImport(records: Array<ReturnType<typeof record>>) {
  await post('/admin/import', records.map((r) => ({ ...r, ms_played: null })));
}

async function playsBySource(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare('SELECT source, COUNT(*) AS n FROM plays GROUP BY source').all<{ source: string; n: number }>();
  return Object.fromEntries(results.map((row) => [row.source, row.n]));
}

/** Every table kept from plays agrees with plays itself. */
async function expectDerivedRight() {
  const [counts, numbers] = await env.DB.batch([
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM plays) AS plays,
              (SELECT COALESCE(SUM(plays), 0) FROM rollup_days) AS days,
              (SELECT COALESCE(SUM(plays), 0) FROM rollup_month_tracks) AS months,
              (SELECT COUNT(*) FROM play_numbers) AS numbered`,
    ),
    env.DB.prepare(
      `SELECT pn.n,
              (SELECT COUNT(*) FROM plays p JOIN track_songs ts ON ts.track_id = p.track_id
                WHERE ts.song = pn.song AND (p.played_at_ms, p.track_id) <= (pn.played_at_ms, pn.track_id)) AS expected,
              EXISTS (SELECT 1 FROM plays p WHERE p.played_at_ms = pn.played_at_ms AND p.track_id = pn.track_id) AS stored
         FROM play_numbers pn`,
    ),
  ]);
  const count = counts!.results[0] as { plays: number; days: number; months: number; numbered: number };
  expect({ days: count.days, months: count.months, numbered: count.numbered }).toEqual({
    days: count.plays,
    months: count.plays,
    numbered: count.plays,
  });
  for (const row of numbers!.results as Array<{ n: number; expected: number; stored: number }>) {
    expect(row.stored).toBe(1);
    expect(row.n).toBe(row.expected);
  }
}

describe('importing plays the poller already stored', () => {
  it('treats a record a few seconds from a polled play of the same track as that play', async () => {
    // The API keeps milliseconds; the export truncates the same instant.
    await poll([T + 235, T + 10 * MIN + 900]);
    const body = await post('/admin/import', [
      record(T + 235),
      // A few seconds out, as two logging systems may be.
      { ...record(T + 10 * MIN), ts: new Date(T + 10 * MIN + 3000).toISOString() },
      // A different play, a track-length later.
      record(T + 20 * MIN),
    ]);

    expect(body).toMatchObject({ received: 3, inserted: 1, duplicates: 2 });
    expect(await playsBySource()).toEqual({ api: 2, export: 1 });
    await expectDerivedRight();
  });

  it('reports a re-import of the same records as all duplicates', async () => {
    const records = [record(T), record(T + 10 * MIN)];
    expect(await post('/admin/import', records)).toMatchObject({ inserted: 2, duplicates: 0 });
    expect(await post('/admin/import', records)).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(await playsBySource()).toEqual({ export: 2 });
  });

  it('moves a known track’s first sighting earlier', async () => {
    await poll([T + 30 * 24 * 60 * MIN]);
    await post('/admin/import', [record(T)]);
    const track = await env.DB.prepare("SELECT first_seen_ms FROM tracks WHERE track_id = 'shelter'").first<{ first_seen_ms: number }>();
    expect(track?.first_seen_ms).toBe(T);
  });
});

describe('importing skips', () => {
  it('drops records played for under 30 s, in either export’s field name', () => {
    const rows = normalizeExport([
      record(T, 29_999),
      { ...record(T + MIN, null), msPlayed: 5_000 },
      record(T + 2 * MIN, 30_000),
      // No duration at all: nothing says it was short.
      record(T + 3 * MIN, null),
    ]);
    expect(rows.short).toBe(2);
    expect(rows.plays.map((play) => play.played_at_ms)).toEqual([T + 2 * MIN, T + 3 * MIN]);
  });

  it('stores none of them, nor a track heard only in skips', async () => {
    const body = await post('/admin/import', [record(T, 4_000, 'skipped-only'), record(T + MIN)]);
    expect(body).toMatchObject({ received: 2, inserted: 1, short: 1 });
    expect(await playsBySource()).toEqual({ export: 1 });
    expect(await env.DB.prepare("SELECT 1 FROM tracks WHERE track_id = 'skipped-only'").first()).toBeNull();
    await expectDerivedRight();
  });
});

describe('cached bodies after an import', () => {
  async function wrappedPlays(): Promise<number> {
    // The edge copy lives a few minutes whatever happens; this is about the stored body.
    await (await caches.open('stats')).delete(edgeRequest(wrappedKey(ERAS, { from: '2024-03-01', to: '2024-03-31' })));
    const response = await SELF.fetch(`${BASE}/api/wrapped?from=2024-03-01&to=2024-03-31`, { headers: ADMIN });
    expect(response.status).toBe(200);
    return ((await response.json()) as { totals: { plays: number } }).totals.plays;
  }

  it('recomputes a Wrapped cut before the imported plays existed', async () => {
    await poll([T]);
    expect(await wrappedPlays()).toBe(1);

    await post('/admin/import', [record(T + 10 * MIN), record(T + 20 * MIN)]);
    expect(await wrappedPlays()).toBe(3);
  });

  it('keeps them when an import stores nothing new', async () => {
    await poll([T]);
    await wrappedPlays();
    await post('/admin/import', [record(T + 400), record(T + MIN, 1_000)]);
    const stored = await env.DB.prepare('SELECT COUNT(*) AS n FROM stats_snapshots WHERE body IS NOT NULL').first<{ n: number }>();
    expect(stored?.n).toBe(1);
  });
});

describe('POST /admin/cleanup/overlaps', () => {
  async function seedOverlap() {
    // Export rows, then the poller's copies of two of them: the order the
    // import now catches, the other way round, is what the old one let in.
    await legacyImport([record(T), record(T + 10 * MIN), record(T + 20 * MIN)]);
    await poll([T + 235, T + 10 * MIN + 1800]);
  }

  it('reports by default and changes nothing', async () => {
    await seedOverlap();
    const body = await post('/admin/cleanup/overlaps');
    expect(body).toMatchObject({ apply: false, matched: 2, removed: 0, gaps: { '<=1000': 1, '<=2000': 1 }, next: null });
    expect(await playsBySource()).toEqual({ api: 2, export: 3 });
  });

  it('removes the export copy a page at a time and repairs what is kept from plays', async () => {
    await seedOverlap();
    await env.DB.prepare("INSERT INTO stats_snapshots (key, body, computed_ms) VALUES ('wrapped:x', '{}', 1)").run();

    const first = await post('/admin/cleanup/overlaps?apply=1&limit=1');
    expect(first).toMatchObject({ removed: 1, next: { after: T, after_track: 'shelter' } });
    const second = await post(`/admin/cleanup/overlaps?apply=1&limit=1&after=${T}&after_track=shelter`);
    expect(second).toMatchObject({ removed: 1 });

    expect(await playsBySource()).toEqual({ api: 2, export: 1 });
    expect(await env.DB.prepare('SELECT 1 FROM stats_snapshots').first()).toBeNull();
    await expectDerivedRight();
  });
});

describe('POST /admin/cleanup/skips', () => {
  it('removes the stored export rows the export files show to be skips', async () => {
    const records = [record(T, 3_000), record(T + MIN), record(T + 2 * MIN, 10_000)];
    await legacyImport(records);
    await poll([T + 3 * MIN]);
    expect(await playsBySource()).toEqual({ api: 1, export: 3 });

    expect(await post('/admin/cleanup/skips', records)).toMatchObject({ short: 2, stored: 2, removed: 0 });
    expect(await playsBySource()).toEqual({ api: 1, export: 3 });

    expect(await post('/admin/cleanup/skips?apply=1', records)).toMatchObject({ short: 2, stored: 2, removed: 2 });
    expect(await playsBySource()).toEqual({ api: 1, export: 1 });
    await expectDerivedRight();
  });

  it('keeps a key that also has a counted record', async () => {
    await legacyImport([record(T)]);
    expect(await post('/admin/cleanup/skips?apply=1', [record(T, 1_000), record(T)])).toMatchObject({ short: 0, removed: 0 });
    expect(await playsBySource()).toEqual({ export: 1 });
  });
});

describe('POST /admin/cleanup/short-gaps', () => {
  it('removes export plays that ended under 30 s after the play before, newest page first', async () => {
    // A full play, two quick skips after it, a full play, then a skip after a
    // long pause, which the heuristic cannot see.
    await legacyImport([record(T), record(T + 10_000), record(T + 25_000), record(T + 25_000 + 4 * MIN), record(T + 60 * MIN)]);
    // A polled play is never removed, however close.
    await poll([T + 25_000 + 4 * MIN + 5_000], 'polled');

    const report = await post('/admin/cleanup/short-gaps');
    expect(report).toMatchObject({ matched: 2, removed: 0, gaps: { '<5000': 0, '<10000': 0, '<20000': 2, '<30000': 0 } });

    const first = await post('/admin/cleanup/short-gaps?apply=1&limit=1');
    expect(first).toMatchObject({ removed: 1, next: { before: T + 25_000, before_track: 'shelter' } });
    // Removing a later play leaves the earlier ones' gaps as they were.
    const second = await post(`/admin/cleanup/short-gaps?apply=1&limit=1&before=${T + 25_000}&before_track=shelter`);
    expect(second).toMatchObject({ removed: 1 });
    expect(await post(`/admin/cleanup/short-gaps?limit=1&before=${T + 10_000}&before_track=shelter`)).toMatchObject({
      matched: 0,
      next: null,
    });

    expect(await playsBySource()).toEqual({ api: 1, export: 3 });
    await expectDerivedRight();
  });
});
