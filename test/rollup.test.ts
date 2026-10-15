import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dailyCounts, topArtists } from '../src/api';
import { buildInserts } from '../src/db';
import { topTracksRoute } from '../src/history';
import { datesRunForward, ensureRollup, rollupZone, zoneOffsets } from '../src/rollup';
import { localDayKey, offsetMsAt } from '../src/tz';
import { testEnv } from './helpers';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const HOUR = 3_600_000;
const DAY = 86_400_000;
const START = Date.UTC(2017, 5, 1);
const END = Date.UTC(2019, 6, 1);

/** A small deterministic PRNG, so a failure can be replayed. */
function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

const TRACKS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

async function seedCatalog() {
  await env.DB.batch([
    ...TRACKS.map((id, i) =>
      env.DB.prepare('INSERT INTO tracks (track_id, name, duration_ms, first_seen_ms) VALUES (?, ?, 1, 0)').bind(id, `Song ${i % 5}`),
    ),
    env.DB.prepare("INSERT INTO artists (artist_id, name) VALUES ('x', 'Artist X'), ('y', 'Artist Y'), ('name:Artist X', 'Artist X')"),
    ...TRACKS.map((id, i) =>
      env.DB.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').bind(
        id,
        i % 3 === 0 ? 'x' : i % 3 === 1 ? 'y' : 'name:Artist X',
      ),
    ),
    env.DB.prepare("INSERT INTO track_artists (track_id, artist_id, position) VALUES ('b', 'x', 1)"),
  ]);
}

/**
 * Plays scattered over two years, and packed around the instants where
 * counting goes wrong if anything is off: each offset change, and local
 * midnight at the start of every month. Inserted in shuffled order, as an
 * import of older history would be.
 */
function playsFor(timeZone: string, seed: number): Array<{ played_at_ms: number; track_id: string; source: string }> {
  const rand = random(seed);
  const times: number[] = [];
  for (let i = 0; i < 700; i++) times.push(START + Math.floor(rand() * (END - START)));
  for (const [at] of zoneOffsets(timeZone, END).slice(1)) {
    if (at < START || at > END) continue;
    for (const delta of [-2 * HOUR, -HOUR, -1000, -1, 0, 1, 999, 1000, HOUR, 2 * HOUR, 25 * HOUR]) times.push(at + delta);
  }
  for (let ms = START; ms < END; ms += 27 * DAY) {
    const day = localDayKey(ms, timeZone).slice(0, 8) + '01';
    const midnight = Date.parse(`${day}T00:00:00Z`) - offsetMsAt(Date.parse(`${day}T00:00:00Z`), timeZone);
    for (const delta of [-HOUR, -1, 0, 1, HOUR]) times.push(midnight + delta);
  }
  const rows = new Map<string, { played_at_ms: number; track_id: string; source: string }>();
  for (const ms of times) {
    const track = TRACKS[Math.floor(rand() * TRACKS.length)]!;
    rows.set(`${ms}:${track}`, { played_at_ms: ms, track_id: track, source: 'export' });
  }
  return [...rows.values()].sort(() => rand() - 0.5);
}

async function insertPlays(rows: Array<{ played_at_ms: number; track_id: string; source: string }>) {
  await env.DB.batch(buildInserts(env.DB, 'plays', ['played_at_ms', 'track_id', 'source'], rows));
}

function ranges(rand: () => number): Array<[string, string]> {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const out: Array<[string, string]> = [
    ['2017-06-01', '2019-06-30'],
    ['2018-01-01', '2018-12-31'],
    ['2018-03-01', '2018-03-31'],
    ['2018-03-10', '2018-04-20'],
    ['2018-10-15', '2018-11-15'],
    ['2018-10-28', '2018-10-28'],
    ['2018-11-04', '2018-11-04'],
    ['2018-02-17', '2018-02-18'],
    ['2018-12-31', '2019-02-01'],
    ['2018-04-01', '2018-04-01'],
    ['2018-09-30', '2018-10-01'],
  ];
  for (let i = 0; i < 10; i++) {
    const a = START + Math.floor(rand() * (END - START));
    const b = a + Math.floor(rand() * 400 * DAY);
    out.push([day(a), day(Math.min(b, END - DAY))]);
  }
  return out;
}

const ROUTES = { daily: dailyCounts, 'top-artists': topArtists, 'top-tracks': topTracksRoute };

/**
 * Every range through every route. The handlers are called directly: each
 * SELF.fetch in a file costs more than the last under the test pool, and
 * this makes hundreds.
 */
async function fetchAll(timeZone: string, list: Array<[string, string]>) {
  const bodies: unknown[] = [];
  let fromRollup = 0;
  for (const [from, to] of list) {
    for (const [route, handler] of Object.entries(ROUTES)) {
      const response = await handler(
        env,
        new URL(`${BASE}/api/${route}?from=${from}&to=${to}&tz=${encodeURIComponent(timeZone)}&limit=500`),
      );
      expect(response.status).toBe(200);
      if (response.headers.get('X-Rollup') === '1') fromRollup++;
      const { _meta, ...body } = (await response.json()) as Record<string, unknown>;
      bodies.push({ route, from, to, ...body });
    }
  }
  return { bodies, fromRollup };
}

async function rollupTables() {
  const [days, months] = await env.DB.batch([
    env.DB.prepare('SELECT day, plays FROM rollup_days ORDER BY day'),
    env.DB.prepare('SELECT month, track_id, plays FROM rollup_month_tracks ORDER BY month, track_id'),
  ]);
  return { days: days!.results, months: months!.results };
}

describe('the play-count rollup', () => {
  const zones = [
    'UTC',
    'Europe/London',
    'America/New_York',
    'Australia/Lord_Howe',
    'Asia/Kathmandu',
    'Pacific/Auckland',
    // Spring forward at midnight: that day has no 00:00.
    'America/Havana',
    // Until 2019, fall back at midnight to 23:00 the day before, so an hour
    // of one date happens twice. Dates repeat but never run backwards.
    'America/Sao_Paulo',
  ];

  for (const [i, timeZone] of zones.entries()) {
    it(`answers exactly as counting the plays does, in ${timeZone}`, async () => {
      const rand = random(1000 + i);
      await seedCatalog();
      const plays = playsFor(timeZone, 2000 + i);
      const later = plays.splice(0, 150);
      await insertPlays(plays);
      const built = await ensureRollup(testEnv({ TIMEZONE: timeZone }), { rebuild: true });
      expect(built).toMatchObject({ time_zone: timeZone, rebuilt: true, usable: true });

      // After the build, the triggers keep up: more plays out of order, and some removed.
      await insertPlays(later);
      const doomed = plays.slice(0, 60);
      await env.DB.batch(
        doomed.map((p) => env.DB.prepare('DELETE FROM plays WHERE played_at_ms = ? AND track_id = ?').bind(p.played_at_ms, p.track_id)),
      );

      const list = ranges(rand);
      const withRollup = await fetchAll(timeZone, list);
      await env.DB.prepare('UPDATE rollup_state SET usable = 0').run();
      const counted = await fetchAll(timeZone, list);
      expect(counted.fromRollup).toBe(0);
      expect(withRollup.bodies).toEqual(counted.bodies);

      expect(withRollup.fromRollup).toBeGreaterThan(list.length);

      // What the triggers kept is what a rebuild from scratch gives.
      const kept = await rollupTables();
      await ensureRollup(testEnv({ TIMEZONE: timeZone }), { rebuild: true });
      expect(await rollupTables()).toEqual(kept);
    }, 60_000);
  }

  it('only rebuilds when the zone changes or its offsets ran out', async () => {
    await seedCatalog();
    await insertPlays(playsFor('Europe/London', 7).slice(0, 50));
    const london = testEnv({ TIMEZONE: 'Europe/London' });
    expect((await ensureRollup(london)).rebuilt).toBe(true);
    expect((await ensureRollup(london)).rebuilt).toBe(false);
    expect((await ensureRollup(testEnv({ TIMEZONE: 'Asia/Tokyo' }))).rebuilt).toBe(true);
    const state = await env.DB.prepare('SELECT horizon_ms FROM rollup_state').first<{ horizon_ms: number }>();
    expect((await ensureRollup(testEnv({ TIMEZONE: 'Asia/Tokyo' }), { now: state!.horizon_ms + 1 })).rebuilt).toBe(true);
  });

  it('stops answering once its offsets have run out, or for another zone', async () => {
    await seedCatalog();
    await insertPlays(playsFor('UTC', 9));
    const query = '/api/daily?from=2018-01-01&to=2018-12-31';
    const rollup = async (q: string) => (await SELF.fetch(`${BASE}${q}`, { headers: READ })).headers.get('X-Rollup');
    expect(await rollup(query)).toBe('1');
    expect(await rollup(`${query}&tz=Europe/London`)).toBeNull();
    await env.DB.prepare('UPDATE rollup_state SET horizon_ms = ?').bind(Date.now() - 1).run();
    expect(await rollup(query)).toBeNull();
  });

  it('finds that dates run forward where clocks repeat an hour of the day before', () => {
    expect(datesRunForward('Europe/London', zoneOffsets('Europe/London', END))).toBe(true);
    expect(datesRunForward('America/Sao_Paulo', zoneOffsets('America/Sao_Paulo', END))).toBe(true);
  });

  it('builds in TIMEZONE, else the latest era’s zone, else UTC', () => {
    expect(rollupZone({ TIMEZONE: 'Europe/Berlin', ERAS: env.ERAS })).toBe('Europe/Berlin');
    expect(rollupZone({ ERAS: env.ERAS })).toBe('Asia/Singapore');
    expect(rollupZone({})).toBe('UTC');
    expect(rollupZone({ TIMEZONE: 'Not/AZone' })).toBeNull();
  });

  it('is filled by migration 0014 from the plays already stored', async () => {
    await seedCatalog();
    await insertPlays(playsFor('UTC', 11));
    const kept = await rollupTables();
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0014'))!;
    const backfill = migration.queries.filter((sql) => /^INSERT INTO rollup_(days|month_tracks)/.test(sql.trim()));
    expect(backfill).toHaveLength(2);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM rollup_days'),
      env.DB.prepare('DELETE FROM rollup_month_tracks'),
      ...backfill.map((sql) => env.DB.prepare(sql)),
    ]);
    expect(await rollupTables()).toEqual(kept);
  });
});
