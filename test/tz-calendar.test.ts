import { describe, expect, it } from 'vitest';
import { endOfLocalDayUtcMs, localCalendar, localDayKey, offsetMsAt, startOfLocalDayUtcMs } from '../src/tz';

/**
 * localCalendar against the Intl-per-call code it replaces, in zones chosen
 * for awkward rules: no DST (Singapore, Kolkata's half hour), ordinary DST
 * (London), DST that skips midnight (Santiago, Havana), a half-hour DST
 * (Lord Howe, which also changes mid-way through a UTC hour) and a skipped
 * day (Apia, 30 December 2011).
 */
const ZONES = [
  'Asia/Singapore',
  'Europe/London',
  'America/Santiago',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'America/Havana',
  'Pacific/Apia',
  'UTC',
];

/** dailyCounts' pre-seeding loop as it was: one local day at a time through Intl. */
function oldDays(fromMs: number, toMs: number, timeZone: string): string[] {
  const days: string[] = [];
  for (let cursor = fromMs; cursor < toMs; ) {
    const key = localDayKey(cursor, timeZone);
    days.push(key);
    cursor = endOfLocalDayUtcMs(key, timeZone);
  }
  return days;
}

/** A small deterministic generator, so a failure reproduces. */
function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

/** Instants either side of every offset change in [fromMs, toMs), found by stepping an hour at a time. */
function aroundChanges(timeZone: string, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  let previous = offsetMsAt(fromMs, timeZone);
  for (let at = fromMs; at < toMs; at += 3_600_000) {
    const offset = offsetMsAt(at, timeZone);
    if (offset !== previous) {
      // The change is somewhere in the last hour: probe it densely.
      for (let t = at - 3_600_000; t <= at + 60_000; t += 30_000) out.push(t - 1, t, t + 1, t + 999);
      previous = offset;
    }
  }
  return out;
}

describe('localCalendar', () => {
  it.each(ZONES)('lists the same days as stepping through Intl, in %s', (timeZone) => {
    for (const [from, to] of [
      ['2009-01-01', '2018-12-31'],
      ['2011-12-01', '2012-01-31'],
      ['2016-03-01', '2026-02-28'],
      ['2024-09-01', '2024-09-01'],
    ] as const) {
      const fromMs = startOfLocalDayUtcMs(from, timeZone);
      const toMs = endOfLocalDayUtcMs(to, timeZone);
      expect(localCalendar(timeZone, fromMs, toMs).days(), `${from}..${to}`).toEqual(oldDays(fromMs, toMs, timeZone));
    }
  });

  it.each(ZONES)('puts every instant on the day localDayKey does, in %s', (timeZone) => {
    const fromMs = Date.UTC(2010, 0, 1);
    const toMs = Date.UTC(2026, 0, 1);
    const calendar = localCalendar(timeZone, fromMs, toMs);
    const next = random(42);
    const instants = [
      ...aroundChanges(timeZone, fromMs, toMs),
      ...Array.from({ length: 20_000 }, () => fromMs + Math.floor(next() * (toMs - fromMs))),
    ];
    const differs = instants.filter((ms) => calendar.dayOf(ms) !== localDayKey(ms, timeZone));
    expect(differs.map((ms) => new Date(ms).toISOString())).toEqual([]);
    // Offsets too, where offsetMsAt is exact (whole seconds).
    const seconds = instants.map((ms) => Math.floor(ms / 1000) * 1000);
    expect(seconds.filter((ms) => calendar.offsetAt(ms) !== offsetMsAt(ms, timeZone))).toEqual([]);
  });

  it('stays exact when a later range widens what an earlier one found, and outside any range', () => {
    const timeZone = 'Europe/London';
    const narrow = localCalendar(timeZone, Date.UTC(2020, 5, 1), Date.UTC(2020, 6, 1));
    const wide = localCalendar(timeZone, Date.UTC(2015, 0, 1), Date.UTC(2025, 0, 1));
    for (const ms of [Date.UTC(2016, 2, 27, 0, 59, 59), Date.UTC(2016, 2, 27, 1), Date.UTC(2019, 9, 26, 23, 30), Date.UTC(2024, 9, 27, 0, 59)]) {
      expect(wide.dayOf(ms)).toBe(localDayKey(ms, timeZone));
      expect(narrow.dayOf(ms)).toBe(localDayKey(ms, timeZone));
    }
    expect(narrow.dayOf(Date.UTC(2030, 6, 1, 23, 30))).toBe('2030-07-02');
  });

  it('joins ranges that meet a part-second before a change', () => {
    // Dublin is used by no other test, so its offsets start empty in this isolate.
    const timeZone = 'Europe/Dublin';
    const change = Date.UTC(2024, 2, 31, 1);
    localCalendar(timeZone, change - 3 * 3_600_000, change - 500);
    const calendar = localCalendar(timeZone, change - 3 * 3_600_000, change + 3 * 3_600_000);
    for (const ms of [change - 501, change - 1, change, change + 1, change + 22 * 3_600_000 + 59 * 60_000, change + 2 * 3_600_000]) {
      expect(calendar.offsetAt(ms), new Date(ms).toISOString()).toBe(offsetMsAt(Math.floor(ms / 1000) * 1000, timeZone));
      expect(calendar.dayOf(ms)).toBe(localDayKey(ms, timeZone));
    }
    expect(calendar.days()).toEqual(['2024-03-30', '2024-03-31']);
  });

  it('lists nothing for an empty range and one day for an instant', () => {
    const at = Date.UTC(2024, 0, 1, 12);
    expect(localCalendar('UTC', at, at).days()).toEqual([]);
    expect(localCalendar('Asia/Singapore', at, at + 1).days()).toEqual(['2024-01-01']);
  });
});

