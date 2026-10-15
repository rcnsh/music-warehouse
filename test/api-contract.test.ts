import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildEras, offsetSqlFor, parseEras } from '../src/eras';
import { computeRhythm } from '../src/stats/rhythm';
import { syncSearchIndex } from '../src/search-index';
import { wrappedRange } from '../src/wrapped';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const DAY = 86_400_000;
const T = Date.UTC(2024, 2, 1, 12);

/** Plays at the given instants; every track is credited to `porter`. */
async function seed(plays: Array<[number, string]>) {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("INSERT OR IGNORE INTO artists (artist_id, name) VALUES ('porter', 'Porter Robinson')"),
  ];
  for (const trackId of new Set(plays.map(([, id]) => id))) {
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO tracks (track_id, name, duration_ms, first_seen_ms) VALUES (?, ?, 200000, 0)').bind(
        trackId,
        `Song ${trackId}`,
      ),
      env.DB.prepare("INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, 'porter', 0)").bind(trackId),
    );
  }
  for (const [ms, trackId] of plays) {
    statements.push(
      env.DB.prepare('INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, ?, ?)').bind(ms, trackId, 'export'),
    );
  }
  await env.DB.batch([...statements, syncSearchIndex(env.DB)]);
}

const fetchApi = (path: string) => SELF.fetch(`${BASE}${path}`, { headers: READ });

async function get<T>(path: string): Promise<T> {
  const response = await fetchApi(path);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as T;
}

type PlaysPage = { plays: Array<{ played_at_ms: number; track_id: string }>; next_before: string | null };

/** Every play, a page at a time, following next_before. */
async function walk(query: string): Promise<{ keys: string[]; pages: number }> {
  const keys: string[] = [];
  let before: string | null = null;
  let pages = 0;
  do {
    const page: PlaysPage = await get<PlaysPage>(
      `/api/plays?${query}${before === null ? '' : `&before=${encodeURIComponent(before)}`}`,
    );
    keys.push(...page.plays.map((p) => `${p.played_at_ms}:${p.track_id}`));
    before = page.next_before;
    pages++;
  } while (before !== null && pages < 20);
  return { keys, pages };
}

describe('/api/plays next_before', () => {
  // Five plays share one millisecond, as imported history often does.
  const PLAYS: Array<[number, string]> = [
    [T + 2000, 'z'],
    ...['a', 'b', 'c', 'd', 'e'].map((id): [number, string] => [T + 1000, id]),
    [T, 'y'],
  ];
  const ALL = [...PLAYS]
    .sort((a, b) => b[0] - a[0] || b[1].localeCompare(a[1]))
    .map(([ms, id]) => `${ms}:${id}`);

  it('pages through plays that share a millisecond without dropping or repeating any', async () => {
    await seed(PLAYS);
    for (const limit of [1, 2, 3, 7]) {
      const { keys, pages } = await walk(`limit=${limit}`);
      expect(keys).toEqual(ALL);
      expect(pages).toBe(Math.ceil(ALL.length / limit));
    }
  });

  it('does the same through a filter, which takes a different query', async () => {
    await seed(PLAYS);
    expect((await walk('limit=2&artist_id=porter')).keys).toEqual(ALL);
    expect((await walk('limit=2&q=song')).keys).toEqual(ALL);
  });

  it('is null on the last page, and on an empty one', async () => {
    await seed(PLAYS);
    expect((await get<PlaysPage>('/api/plays?limit=7')).next_before).toBeNull();
    expect((await get<PlaysPage>('/api/plays?limit=6')).next_before).not.toBeNull();
    expect((await get<PlaysPage>('/api/plays?artist_id=nobody')).next_before).toBeNull();
  });

  it('keeps a plain epoch-ms before meaning "older than that millisecond"', async () => {
    await seed(PLAYS);
    const page = await get<PlaysPage>(`/api/plays?before=${T + 2000}`);
    expect(page.plays.map((p) => `${p.played_at_ms}:${p.track_id}`)).toEqual(ALL.slice(1));
    expect(page.next_before).toBeNull();
  });

  it('respects after alongside the cursor', async () => {
    await seed(PLAYS);
    expect((await walk(`limit=2&after=${T}`)).keys).toEqual(ALL.slice(0, -1));
  });

  it('rejects a before that is neither', async () => {
    for (const before of ['x', '-1', '.abc', 'abc.def', '-5.x', '']) {
      const response = await fetchApi(`/api/plays?before=${encodeURIComponent(before)}`);
      expect(response.status, before).toBe(before === '' ? 200 : 400);
    }
  });

  it('lets /api/plays.csv resume from a cursor', async () => {
    await seed(PLAYS);
    const page = await get<PlaysPage>('/api/plays?limit=3');
    const response = await fetchApi(`/api/plays.csv?before=${encodeURIComponent(page.next_before!)}`);
    expect(response.status).toBe(200);
    const rows = (await response.text()).trim().split('\r\n').slice(1);
    expect(rows.map((row) => row.split(',')[4])).toEqual(ALL.slice(3).map((key) => key.split(':')[1]));
  });
});

describe('date ranges', () => {
  /** `from` plus `days - 1` days: a range of `days` calendar days. */
  const span = (from: string, days: number) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + (days - 1) * DAY).toISOString().slice(0, 10);

  it('allows 3,660 local days that run from summer time into winter time', async () => {
    // British Summer Time at the start, GMT at the end: an hour longer than 3,660 × 24 h.
    const from = '2016-10-25';
    expect((await fetchApi(`/api/top-artists?tz=Europe/London&from=${from}&to=${span(from, 3660)}`)).status).toBe(200);
    expect((await fetchApi(`/api/daily?tz=Europe/London&from=${from}&to=${span(from, 3660)}`)).status).toBe(200);
    const tooLong = await fetchApi(`/api/top-artists?tz=Europe/London&from=${from}&to=${span(from, 3661)}`);
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toMatch(/3660 days/);
  });

  it('allows the same in Wrapped', () => {
    const eras = buildEras(
      parseEras(JSON.stringify([{ key: 'uk', label: 'UK', timeZone: 'Europe/London', from: '2010-01-01T00:00:00Z' }]), undefined),
      0,
    );
    const range = (to: string) => new URL(`${BASE}/api/wrapped?from=2010-10-26&to=${to}`);
    expect(wrappedRange(eras, range(span('2010-10-26', 3660)), Date.now()).from).toBe('2010-10-26');
    expect(() => wrappedRange(eras, range(span('2010-10-26', 3661)), Date.now())).toThrow(/3660 days/);
  });

  it('rejects dates that do not exist rather than rolling them over', async () => {
    for (const path of [
      '/api/top-artists?from=2026-02-30&to=2026-03-05',
      '/api/top-tracks?from=2026-02-01&to=2026-02-29',
      '/api/daily?from=2026-04-31&to=2026-05-02',
      '/api/daily?from=2026-01-01&to=2026-13-01',
      '/api/plays.csv?from=2026-02-30',
    ]) {
      const response = await fetchApi(path);
      expect(response.status, path).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/real YYYY-MM-DD/);
    }
    expect((await fetchApi('/api/daily?from=2024-02-29&to=2024-03-01')).status).toBe(200);
  });

  it('defaults tz to the warehouse’s own zone, not UTC', async () => {
    // The test settings have no TIMEZONE; the latest era is Asia/Singapore.
    const body = await get<{ tz: string }>('/api/daily?from=2026-01-01&to=2026-01-02');
    expect(body.tz).toBe('Asia/Singapore');
    expect((await get<{ tz: string }>('/api/top-artists')).tz).toBe('Asia/Singapore');
    expect((await get<{ tz: string }>('/api/daily?from=2026-01-01&to=2026-01-02&tz=UTC')).tz).toBe('UTC');
  });
});

describe('/api/daily group_by', () => {
  // Monday 2024-03-04 is the start of a week. Days are Singapore's (the default zone).
  const at = (day: string) => Date.parse(`${day}T04:00:00Z`);

  it('sums local days into weeks from Monday, and into months', async () => {
    await seed([
      [at('2024-02-28'), 'a'],
      [at('2024-03-03'), 'a'],
      [at('2024-03-04'), 'a'],
      [at('2024-03-04') + 1, 'b'],
      [at('2024-03-10'), 'a'],
      [at('2024-03-11'), 'a'],
    ]);
    const range = 'from=2024-02-28&to=2024-03-12';
    const weeks = await get<{ group_by: string; weeks: unknown; days?: unknown }>(`/api/daily?${range}&group_by=week`);
    expect(weeks.group_by).toBe('week');
    expect(weeks.days).toBeUndefined();
    expect(weeks.weeks).toEqual([
      { week: '2024-02-26', plays: 2 },
      { week: '2024-03-04', plays: 3 },
      { week: '2024-03-11', plays: 1 },
    ]);
    const months = await get<{ months: unknown }>(`/api/daily?${range}&group_by=month&artist_id=porter`);
    expect(months.months).toEqual([
      { month: '2024-02', plays: 1 },
      { month: '2024-03', plays: 5 },
    ]);
  });

  it('leaves the day shape as it was, and rejects anything else', async () => {
    const plain = await get<Record<string, unknown>>('/api/daily?from=2024-03-01&to=2024-03-02');
    const day = await get<Record<string, unknown>>('/api/daily?from=2024-03-01&to=2024-03-02&group_by=day');
    expect(Object.keys(day).sort()).toEqual(Object.keys(plain).sort());
    expect(plain.group_by).toBeUndefined();
    expect(day.days).toEqual(plain.days);
    expect((await fetchApi('/api/daily?group_by=year')).status).toBe(400);
  });
});

describe('query cost', () => {
  it('sends X-Rows-Read from every stored-data route, keeping _meta where it was', async () => {
    await seed([[T, 'a']]);
    for (const path of ['/api/plays', '/api/daily', '/api/top-artists', '/api/top-tracks', '/api/search?q=song']) {
      const response = await fetchApi(path);
      expect(response.headers.get('X-Rows-Read'), path).toMatch(/^\d+$/);
    }
    // The first loop's answers are kept (cachedHistory), and a kept answer's
    // header is the cache check's reads, so ask with a new query each time.
    for (const path of ['/api/plays?limit=5', '/api/daily?tz=UTC', '/api/top-artists?tz=UTC']) {
      const response = await fetchApi(path);
      expect(response.headers.get('X-Cache'), path).toBeNull();
      const body = (await response.json()) as { _meta: { rows_read: number } };
      expect(String(body._meta.rows_read), path).toBe(response.headers.get('X-Rows-Read'));
    }
  });
});

describe('/api/on-this-day', () => {
  it('reaches back to 2008 however many years that is', async () => {
    // 2060 asks for 52 earlier years: 156 values, past D1's 100 bound parameters.
    await seed([
      [Date.UTC(2010, 9, 15, 6), 'a'],
      [Date.UTC(2059, 9, 15, 6), 'b'],
    ]);
    const body = await get<{ years: Array<{ year: number; plays: number }> }>('/api/on-this-day?date=2060-10-15&tz=UTC');
    expect(body.years.map((y) => [y.year, y.plays])).toEqual([
      [2059, 1],
      [2010, 1],
    ]);
  });
});

describe('local time in half-hour zones', () => {
  it('buckets rhythm by local hour where the offset is not whole hours', async () => {
    const eras = buildEras(
      parseEras(JSON.stringify([{ key: 'in', label: 'India', timeZone: 'Asia/Kolkata', from: '2025-01-01T00:00:00Z' }]), undefined),
      0,
    );
    // 10:15 in India (UTC+5:30) is 04:45 UTC, whose UTC hour starts at 09:30 local.
    await seed(Array.from({ length: 40 }, (_, i): [number, string] => [Date.UTC(2025, 0, 6 + i, 4, 45), 'a']));
    const rhythm = await computeRhythm(env.DB, Date.UTC(2025, 5, 1), eras);
    const share = rhythm.eras[0]!.hour_share!;
    expect(share[10]).toBe(1);
    expect(share[9]).toBe(0);
  });

  it('finds clock changes to the second', () => {
    // London went to summer time at 2024-03-31T01:00:00Z. Starting the search
    // off the minute used to land up to a minute late.
    const sql = offsetSqlFor('Europe/London', Date.UTC(2024, 2, 30, 0, 0, 7), Date.UTC(2024, 3, 2));
    expect(sql).toContain(`WHEN s < ${Date.UTC(2024, 2, 31, 1) / 1000} THEN 0`);
  });
});
