import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { syncAllSongs } from '../src/play-numbers';
import { songTitle, songTitleSql } from '../src/song-title';

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
  // Only the last tag, and only at the very end.
  ['heroes (feat. x) - 2017 remaster', 'heroes (feat. x)'],
  ['heroes - remastered - live', 'heroes - remastered - live'],
  // Different performances, or not a tag at all: kept apart.
  ['heroes - live', 'heroes - live'],
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
];

describe('songTitle', () => {
  it.each(CASES)('%j is the song %j', (title, song) => {
    expect(songTitle(title)).toBe(song);
  });

  it('agrees with its SQL form on every case', async () => {
    const { results } = await env.DB.prepare(
      `SELECT j.value AS title, ${songTitleSql('j.value')} AS song FROM json_each(?) j`,
    )
      .bind(JSON.stringify(CASES.map(([title]) => title)))
      .all<{ title: string; song: string }>();
    expect(results.map((row) => [row.title, row.song])).toEqual(CASES);
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
