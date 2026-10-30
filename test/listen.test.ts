import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildEras, parseEras } from '../src/eras';
import {
  FALLBACK_DURATION_MS,
  MIN_PLAY_MS,
  counted,
  gapSeekSql,
  gapWindowSql,
  gaps,
  listenedMs,
  listenedMsSql,
} from '../src/listen';
import { computeWrapped } from '../src/wrapped';

const ERAS = buildEras(parseEras(env.ERAS, undefined), Date.parse(env.HISTORY_FROM!));
const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const MIN = 60_000;
const T = Date.UTC(2024, 2, 15, 12);

/** Plays of artist `x`, every track five minutes long. */
async function seed(plays: Array<{ ms: number; trackId: string }>) {
  const statements: D1PreparedStatement[] = [env.DB.prepare("INSERT OR IGNORE INTO artists (artist_id, name) VALUES ('x', 'X')")];
  for (const { ms, trackId } of plays) {
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(ms, trackId, 'export'),
      env.DB.prepare(
        'INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, album_id, first_seen_ms) VALUES (?, ?, ?, NULL, ?)',
      ).bind(trackId, `Song ${trackId}`, 5 * MIN, ms),
      env.DB.prepare("INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, 'x', 0)").bind(trackId),
    );
  }
  await env.DB.batch(statements);
}

// The first play ever, a skip, then two plays tied on played_at_ms (two
// export records that ended in the same second), then one after them.
const PLAYS = [
  { ms: T, trackId: 'a' },
  { ms: T + 10_000, trackId: 'b' },
  { ms: T + 4 * MIN, trackId: 'a' },
  { ms: T + 4 * MIN, trackId: 'c' },
  { ms: T + 9 * MIN, trackId: 'a' },
];
const GAPS = [null, 10_000, 4 * MIN - 10_000, 4 * MIN - 10_000, 5 * MIN];

describe('gaps', () => {
  it('measures each play from the latest one that ended strictly before it', () => {
    expect(gaps(PLAYS.map((play) => play.ms))).toEqual(GAPS);
    expect(gaps([])).toEqual([]);
    // Ties at the very start have no play before them.
    expect(gaps([T, T, T + MIN])).toEqual([null, null, MIN]);
  });

  it('agrees with both SQL forms', async () => {
    await seed(PLAYS);
    const { results } = await env.DB.prepare(
      `SELECT ${gapSeekSql('p.played_at_ms')} AS seek, ${gapWindowSql('p.played_at_ms')} AS win
         FROM plays p ORDER BY p.played_at_ms, p.track_id`,
    ).all<{ seek: number | null; win: number | null }>();
    expect(results.map((row) => row.seek)).toEqual(GAPS);
    expect(results.map((row) => row.win)).toEqual(GAPS);
  });
});

describe('listened time', () => {
  const cases: Array<[gap: number | null, duration: number | null, ms: number]> = [
    // No play before: the track's length, or the fallback.
    [null, null, FALLBACK_DURATION_MS],
    [null, 100_000, 100_000],
    // A skip is worth nothing, however long the track.
    [MIN_PLAY_MS - 1, 200_000, 0],
    [0, 200_000, 0],
    // At the threshold it counts, for the gap.
    [MIN_PLAY_MS, null, MIN_PLAY_MS],
    // At most the track's length, however long the gap.
    [4 * MIN, 200_000, 200_000],
    [4 * MIN, null, FALLBACK_DURATION_MS],
  ];

  it('is at most the gap and the track length, and nothing for a skip', () => {
    for (const [gap, duration, ms] of cases) {
      expect(listenedMs(gap, duration), `${gap}, ${duration}`).toBe(ms);
      expect(counted(gap)).toBe(gap === null || gap >= MIN_PLAY_MS);
    }
  });

  it('is the same in SQL', async () => {
    const statements = cases.map(([gap, duration]) =>
      env.DB.prepare(`SELECT ${listenedMsSql('?1', '?2')} AS ms`).bind(gap, duration),
    );
    const results = await env.DB.batch<{ ms: number }>(statements);
    expect(results.map((result) => result.results[0]!.ms)).toEqual(cases.map(([, , ms]) => ms));
  });
});

describe('Wrapped and /api/artist', () => {
  it('estimate the same minutes, tied plays included', async () => {
    await seed(PLAYS);
    const wrapped = await computeWrapped(env.DB, ERAS, {
      from: '2024-03-01',
      to: '2024-03-31',
      fromMs: Date.UTC(2024, 2, 1),
      toMs: Date.UTC(2024, 3, 1),
    });
    const response = await SELF.fetch(`${BASE}/api/artist?id=x`, { headers: READ });
    const artist = (await response.json()) as { plays: number; minutes: number };

    // 3 min (fallback) + 0 (skip) + 3:50 + 3:50 + 5:00.
    const minutes = Math.round((3 * MIN + 2 * (4 * MIN - 10_000) + 5 * MIN) / MIN);
    // Wrapped counts the skip apart; /api/artist counts every stored play.
    expect(wrapped.totals).toMatchObject({ plays: 4, skips: 1, minutes });
    expect(artist).toMatchObject({ plays: 5, minutes });
  });
});
