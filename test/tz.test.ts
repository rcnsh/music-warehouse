import { describe, expect, it } from 'vitest';
import { endOfLocalDayUtcMs, isValidTimeZone, localDayKey, startOfLocalDayUtcMs } from '../src/tz';

describe('timezone bucketing', () => {
  it('rejects timezones that are not IANA names', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Asia/Singapore')).toBe(true);
    expect(isValidTimeZone('Middle/Earth')).toBe(false);
  });

  it('puts the same instant on different local days in different zones (R9)', () => {
    // 16:30 UTC on 8 Sept: still the 8th in London (UTC+1 in summer),
    // already 00:30 on the 9th in Singapore (UTC+8).
    const instant = Date.parse('2026-09-08T16:30:00Z');
    expect(localDayKey(instant, 'Europe/London')).toBe('2026-09-08');
    expect(localDayKey(instant, 'Asia/Singapore')).toBe('2026-09-09');
    expect(localDayKey(instant, 'UTC')).toBe('2026-09-08');
  });

  it('resolves local midnight to the right UTC instant either side of a DST change', () => {
    // British Summer Time: London is UTC+1 in July, UTC+0 in January.
    expect(startOfLocalDayUtcMs('2026-07-15', 'Europe/London')).toBe(Date.parse('2026-07-14T23:00:00Z'));
    expect(startOfLocalDayUtcMs('2026-01-15', 'Europe/London')).toBe(Date.parse('2026-01-15T00:00:00Z'));
    expect(startOfLocalDayUtcMs('2026-09-08', 'Asia/Singapore')).toBe(Date.parse('2026-09-07T16:00:00Z'));
  });

  it('handles 23- and 25-hour DST days', () => {
    const HOUR = 3_600_000;
    // 2026-03-29: clocks go forward in London, so the local day is 23 hours.
    const shortDay = endOfLocalDayUtcMs('2026-03-29', 'Europe/London') - startOfLocalDayUtcMs('2026-03-29', 'Europe/London');
    expect(shortDay).toBe(23 * HOUR);

    // 2026-10-25: clocks go back, so the local day is 25 hours.
    const longDay = endOfLocalDayUtcMs('2026-10-25', 'Europe/London') - startOfLocalDayUtcMs('2026-10-25', 'Europe/London');
    expect(longDay).toBe(25 * HOUR);
  });

  it('rejects a malformed date', () => {
    expect(() => startOfLocalDayUtcMs('08/09/2026', 'UTC')).toThrow(RangeError);
  });
});
