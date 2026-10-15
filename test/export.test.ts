import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { csvField } from '../src/export';
import { syncSearchIndex } from '../src/search-index';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const HEADER = 'played_at,track,artists,album,track_id,context_uri,context_name,source';

async function csv(query = ''): Promise<string[]> {
  const response = await SELF.fetch(`${BASE}/api/plays.csv${query}`, { headers: READ });
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
  const text = await response.text();
  expect(text.endsWith('\r\n')).toBe(true);
  return text.slice(0, -2).split('\r\n');
}

async function seedCatalog() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO albums (album_id, name) VALUES ('al', 'Worlds, Deluxe')"),
    env.DB.prepare(
      `INSERT INTO tracks (track_id, name, duration_ms, album_id, first_seen_ms) VALUES
         ('div', 'Divinity', 1, 'al', 0), ('odd', 'Say "Hi"', 1, NULL, 0), ('nl', 'Line' || char(10) || 'Break', 1, NULL, 0)`,
    ),
    env.DB.prepare("INSERT INTO artists (artist_id, name) VALUES ('por', 'Porter Robinson'), ('ami', 'Amy Millan')"),
    env.DB.prepare(
      "INSERT INTO track_artists (track_id, artist_id, position) VALUES ('div', 'por', 0), ('div', 'ami', 1), ('odd', 'ami', 0), ('nl', 'ami', 0)",
    ),
    env.DB.prepare("INSERT INTO contexts (uri, type, name, fetched_ms) VALUES ('spotify:playlist:p', 'playlist', 'Mix, Vol. 1', 0)"),
    env.DB.prepare(
      `INSERT INTO plays (played_at_ms, track_id, context_uri, context_type, source) VALUES
         (${Date.UTC(2026, 0, 1, 12)}, 'div', 'spotify:playlist:p', 'playlist', 'api'),
         (${Date.UTC(2026, 0, 2, 12)}, 'odd', NULL, NULL, 'export'),
         (${Date.UTC(2026, 0, 3, 12)}, 'nl', NULL, NULL, 'api')`,
    ),
    syncSearchIndex(env.DB),
  ]);
}

describe('/api/plays.csv', () => {
  it('needs a read token and checks its parameters before streaming', async () => {
    expect((await SELF.fetch(`${BASE}/api/plays.csv`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/plays.csv?before=x`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/plays.csv?from=2026-02-01&to=2026-01-01`, { headers: READ })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/plays.csv?tz=Nowhere/Else&from=2026-01-01`, { headers: READ })).status).toBe(400);
  });

  it('writes every play newest first, quoting what needs it', async () => {
    await seedCatalog();
    expect(await csv()).toEqual([
      HEADER,
      '2026-01-03T12:00:00.000Z,"Line\nBreak",Amy Millan,,nl,,,api',
      '2026-01-02T12:00:00.000Z,"Say ""Hi""",Amy Millan,,odd,,,export',
      '2026-01-01T12:00:00.000Z,Divinity,"Porter Robinson, Amy Millan","Worlds, Deluxe",div,spotify:playlist:p,"Mix, Vol. 1",api',
    ]);
  });

  it('takes the same filters as /api/plays, and a local-date range', async () => {
    await seedCatalog();
    expect((await csv('?q=divinity')).slice(1).map((line) => line.split(',')[0])).toEqual(['2026-01-01T12:00:00.000Z']);
    expect(await csv('?track_id=nope')).toEqual([HEADER]);
    expect((await csv('?artist_id=ami')).length).toBe(3);
    expect((await csv(`?before=${Date.UTC(2026, 0, 3)}`)).length).toBe(3);
    // 2 January in Auckland (UTC+13) runs from 1 January 11:00 to 2 January 11:00 UTC.
    const day = await csv('?from=2026-01-02&to=2026-01-02&tz=Pacific/Auckland');
    expect(day.slice(1).map((line) => line.slice(0, 24))).toEqual(['2026-01-01T12:00:00.000Z']);
  });

  it('streams past a page, including plays that share a timestamp across the page break', async () => {
    // 2,100 timestamps with two plays each: the 2,000-row page ends mid-pair.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2099)
       INSERT INTO plays (played_at_ms, track_id, source)
       SELECT 1700000000000 + i * 1000, t.id, 'api' FROM n, (SELECT 'a' AS id UNION ALL SELECT 'b') t`,
    ).run();
    const lines = (await csv()).slice(1);
    expect(lines).toHaveLength(4200);
    const keys = lines.map((line) => line.split(',').slice(0, 5).join('|'));
    expect(new Set(keys).size).toBe(4200);
    expect(lines[0]!.startsWith(new Date(1700000000000 + 2099 * 1000).toISOString())).toBe(true);
    expect(lines.at(-1)!.startsWith(new Date(1700000000000).toISOString())).toBe(true);
  });

  it('quotes per RFC 4180', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(null)).toBe('');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "x"')).toBe('"say ""x"""');
    expect(csvField('cr\rlf')).toBe('"cr\rlf"');
  });
});
