import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { EraConfigError, buildEras, loadEras, offsetSqlFor, parseEras } from '../src/eras';
import { RegionConfigError, parseRegions } from '../src/concerts';
import { offsetMsAt } from '../src/tz';

const BASE = 'https://warehouse.test';
const READ = { Authorization: 'Bearer test-read-token' };
const DAY = 86_400_000;

describe('ERAS and TIMEZONE', () => {
  it('defaults to one era in TIMEZONE, or UTC', () => {
    expect(parseEras(undefined, undefined)).toEqual([{ key: 'local', label: 'Local time', timeZone: 'UTC' }]);
    expect(parseEras('', 'America/Chicago')).toEqual([{ key: 'local', label: 'Local time', timeZone: 'America/Chicago' }]);
    expect(() => parseEras(undefined, 'Mars/Olympus')).toThrow(EraConfigError);
  });

  it('names what is wrong with a bad setting', () => {
    const bad = (value: unknown) => () => parseEras(JSON.stringify(value), undefined);
    expect(() => parseEras('{', undefined)).toThrow('ERAS is not valid JSON');
    expect(bad([])).toThrow('non-empty');
    expect(bad([{ key: 'Home', label: 'x', timeZone: 'UTC' }])).toThrow('ERAS[0].key');
    expect(bad([{ key: 'a', label: '', timeZone: 'UTC' }])).toThrow('ERAS[0].label');
    expect(bad([{ key: 'a', label: 'A', timeZone: 'Nowhere/City' }])).toThrow('ERAS[0].timeZone');
    expect(bad([{ key: 'a', label: 'A', timeZone: 'UTC' }, { key: 'b', label: 'B', timeZone: 'UTC' }])).toThrow('ERAS[1].from');
    expect(bad([{ key: 'a', label: 'A', timeZone: 'UTC' }, { key: 'a', label: 'B', timeZone: 'UTC', from: '2024-01-01T00:00:00Z' }])).toThrow('repeats');
    expect(
      bad([
        { key: 'a', label: 'A', timeZone: 'UTC', from: '2024-01-01T00:00:00Z' },
        { key: 'b', label: 'B', timeZone: 'UTC', from: '2023-01-01T00:00:00Z' },
      ]),
    ).toThrow('after the era before it');
    expect(bad([{ key: 'a', label: 'A', timeZone: 'UTC', from: '2024-01-01T00:00:00Z', to: 'soon' }])).toThrow('ERAS[0].to');
    expect(bad([{ key: 'a', label: 'A', timeZone: 'UTC', from: '2024-01-01T00:00:00Z', to: '2024-01-01T00:00:00Z' }])).toThrow(
      'after its from',
    );
    expect(
      bad([
        { key: 'a', label: 'A', timeZone: 'UTC', from: '2024-01-01T00:00:00Z', to: '2024-06-01T00:00:00Z' },
        { key: 'b', label: 'B', timeZone: 'UTC', from: '2024-05-01T00:00:00Z' },
      ]),
    ).toThrow('after the era before it');
  });

  it('lets an era start where the one before it ended', () => {
    const eras = parseEras(
      JSON.stringify([
        { key: 'a', label: 'A', timeZone: 'UTC', to: '2024-06-01T00:00:00Z' },
        { key: 'b', label: 'B', timeZone: 'UTC', from: '2024-06-01T00:00:00Z' },
      ]),
      undefined,
    );
    expect(eras.map((era) => [era.key, era.from, era.to])).toEqual([
      ['a', undefined, '2024-06-01T00:00:00Z'],
      ['b', '2024-06-01T00:00:00Z', undefined],
    ]);
    expect(buildEras(eras, Date.UTC(2020, 0, 1)).map((era) => [era.key, era.gap])).toEqual([
      ['a', false],
      ['b', false],
    ]);
  });

  it('fills time outside every stage with gaps on the stage before', () => {
    const configs = parseEras(
      JSON.stringify([
        { key: 'uni', label: 'Uni', timeZone: 'Europe/London', from: '2024-09-16T00:00:00+01:00', to: '2026-05-18T00:00:00+01:00' },
        { key: 'abroad', label: 'Abroad', timeZone: 'Asia/Singapore', from: '2026-07-28T00:00:00+08:00' },
      ]),
      undefined,
    );
    const history = Date.parse('2020-07-01T00:00:00+01:00');
    const spans = (start: number) => buildEras(configs, start).map(({ key, gap, timeZone, fromMs }) => ({ key, gap, timeZone, fromMs }));
    expect(spans(history)).toEqual([
      { key: 'uni', gap: true, timeZone: 'Europe/London', fromMs: history },
      { key: 'uni', gap: false, timeZone: 'Europe/London', fromMs: Date.parse('2024-09-16T00:00:00+01:00') },
      { key: 'uni', gap: true, timeZone: 'Europe/London', fromMs: Date.parse('2026-05-18T00:00:00+01:00') },
      { key: 'abroad', gap: false, timeZone: 'Asia/Singapore', fromMs: Date.parse('2026-07-28T00:00:00+08:00') },
    ]);
    // History starting after the first stage ended drops it and cuts the gap.
    const late = Date.parse('2026-06-01T00:00:00Z');
    expect(spans(late)).toEqual([
      { key: 'uni', gap: true, timeZone: 'Europe/London', fromMs: late },
      { key: 'abroad', gap: false, timeZone: 'Asia/Singapore', fromMs: Date.parse('2026-07-28T00:00:00+08:00') },
    ]);
  });

  it('starts history at HISTORY_FROM, not at the first era', async () => {
    await env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, 't1', 'api')").bind(Date.UTC(2018, 0, 1)).run();
    const ERAS = JSON.stringify([{ key: 'a', label: 'A', timeZone: 'UTC', from: '2022-01-01T00:00:00Z' }]);
    const eras = await loadEras({ DB: env.DB, ERAS, TIMEZONE: undefined, HISTORY_FROM: '2020-01-01T00:00:00Z' });
    expect(eras.map(({ gap, fromMs }) => ({ gap, fromMs }))).toEqual([
      { gap: true, fromMs: Date.UTC(2020, 0, 1) },
      { gap: false, fromMs: Date.UTC(2022, 0, 1) },
    ]);
    // Without it, history reaches back to the first play, before the first era.
    expect((await loadEras({ DB: env.DB, ERAS, TIMEZONE: undefined }))[0]!.fromMs).toBe(Date.UTC(2018, 0, 1));
    await expect(loadEras({ DB: env.DB, ERAS, TIMEZONE: undefined, HISTORY_FROM: 'July' })).rejects.toThrow('HISTORY_FROM');
  });

  it('starts history at the first stored play when the first era has no start', async () => {
    const first = Date.UTC(2019, 4, 5, 12);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, source) VALUES (?, 't1', 'api'), (?, 't2', 'api')").bind(first, first + DAY),
    ]);
    const eras = await loadEras({ DB: env.DB, ERAS: undefined, TIMEZONE: 'Asia/Tokyo' });
    expect(eras).toHaveLength(1);
    expect(eras[0]).toMatchObject({ key: 'local', timeZone: 'Asia/Tokyo', fromMs: first, offsetSql: '32400' });
  });

  // Southern-hemisphere summer time, a half-hour offset, a zone that dropped
  // summer time, and one with it: the generated SQL must agree with Intl.
  it.each(['Australia/Sydney', 'Asia/Kolkata', 'America/Sao_Paulo', 'America/New_York', 'Europe/London'])(
    'writes out %s offsets that agree with Intl',
    async (timeZone) => {
      const from = Date.UTC(2016, 0, 1);
      const to = Date.UTC(2027, 0, 1);
      const sql = offsetSqlFor(timeZone, from, to);
      // Every 5 days and 7 hours: lands on every time of day and near every transition.
      const samples: number[] = [];
      for (let ms = from; ms < to; ms += 5 * DAY + 7 * 3_600_000) samples.push(Math.floor(ms / 1000));
      const { results } = await env.DB.prepare(
        `SELECT s, ${sql} AS offset FROM (SELECT value AS s FROM json_each(?))`,
      )
        .bind(JSON.stringify(samples))
        .all<{ s: number; offset: number }>();
      const wrong = results.filter((r) => r.offset * 1000 !== offsetMsAt(r.s * 1000, timeZone));
      expect(wrong).toEqual([]);
    },
  );
});

describe('CONCERT_REGIONS', () => {
  it('accepts a country or a point with a radius, and nothing else', () => {
    expect(parseRegions(undefined)).toEqual([]);
    expect(
      parseRegions(
        JSON.stringify([
          { key: 'uk', label: 'United Kingdom', countryCode: 'GB' },
          { key: 'nyc', label: 'New York', geoPoint: 'dr5ru', radius: 40 },
        ]),
      ),
    ).toEqual([
      { key: 'uk', label: 'United Kingdom', query: { countryCode: 'GB' } },
      { key: 'nyc', label: 'New York', query: { geoPoint: 'dr5ru', radius: '40', unit: 'km' } },
    ]);
    const bad = (value: unknown) => () => parseRegions(JSON.stringify(value));
    expect(bad([{ key: 'x', label: 'X' }])).toThrow(RegionConfigError);
    expect(bad([{ key: 'x', label: 'X', countryCode: 'gb' }])).toThrow('countryCode');
    expect(bad([{ key: 'x', label: 'X', geoPoint: 'dr5ru' }])).toThrow('radius');
    expect(bad([{ key: 'x', label: 'X', countryCode: 'GB', geoPoint: 'dr5ru', radius: 5 }])).toThrow(RegionConfigError);
    expect(bad(Array.from({ length: 6 }, (_, i) => ({ key: `r${i}`, label: 'R', countryCode: 'GB' })))).toThrow('at most');
  });

  it('labels the configured regions and hides rows from ones no longer configured', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO concerts (event_id, region, artists, name, local_date, venue, city, status, url, first_seen_ms, last_seen_ms)
         VALUES ('e1', 'london', 'A', 'A live', '2027-01-01', 'V', 'London', 'onsale', 'u', 1, 1),
                ('e2', 'old-place', 'B', 'B live', '2027-01-02', 'V', 'Elsewhere', 'onsale', 'u', 1, 1)`,
      ),
    ]);
    const body = (await (await SELF.fetch(`${BASE}/api/concerts`, { headers: READ })).json()) as {
      regions: Array<{ key: string; label: string }>;
      concerts: Array<{ region: string }>;
    };
    expect(body.regions).toEqual([
      { key: 'singapore', label: 'Singapore' },
      { key: 'london', label: 'London' },
    ]);
    expect(body.concerts.map((c) => c.region)).toEqual(['london']);
    expect((await SELF.fetch(`${BASE}/api/concerts?region=old-place`, { headers: READ })).status).toBe(400);
  });
});
