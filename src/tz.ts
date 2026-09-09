/**
 * IANA timezone helpers.
 *
 * Every timestamp is stored as UTC milliseconds and never converted at write
 * time (R8). Local-calendar bucketing happens here, at query time, so the same
 * rows can be read as Europe/London days or Asia/Singapore days.
 *
 * SQLite has no timezone database, so the conversion is done in JS with Intl
 * and the resulting UTC bounds are handed to SQL as plain integers.
 */

export const DEFAULT_TIMEZONE = 'UTC';

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

function parts(utcMs: number, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** The zone's UTC offset in ms at the given instant (positive east of Greenwich). */
function offsetMsAt(utcMs: number, timeZone: string): number {
  const p = parts(utcMs, timeZone);
  // en-CA with hour12:false yields hour 24 for midnight in some ICU versions.
  const hour = p.hour === 24 ? 0 : p.hour!;
  const asIfUtc = Date.UTC(p.year!, p.month! - 1, p.day!, hour, p.minute!, p.second!);
  return asIfUtc - utcMs;
}

/** 'YYYY-MM-DD' for the local calendar day containing this instant. */
export function localDayKey(utcMs: number, timeZone: string): string {
  const p = parts(utcMs, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * UTC milliseconds at local midnight starting `dateStr` ('YYYY-MM-DD').
 *
 * Resolved by iteration because the offset that applies depends on the instant
 * being computed — one correction pass settles every real DST transition.
 */
export function startOfLocalDayUtcMs(dateStr: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new RangeError(`Expected a YYYY-MM-DD date, got "${dateStr}"`);
  const [, year, month, day] = match;

  const naiveUtc = Date.UTC(Number(year), Number(month) - 1, Number(day));
  let guess = naiveUtc - offsetMsAt(naiveUtc, timeZone);
  guess = naiveUtc - offsetMsAt(guess, timeZone);
  return guess;
}

/** Exclusive upper bound: UTC ms at local midnight ending `dateStr`. */
export function endOfLocalDayUtcMs(dateStr: string, timeZone: string): number {
  const start = startOfLocalDayUtcMs(dateStr, timeZone);
  // Step a day and a half forward, then snap to that day's local midnight, so
  // 23- and 25-hour DST days both land correctly.
  const nextDayKey = localDayKey(start + 36 * 60 * 60 * 1000, timeZone);
  return startOfLocalDayUtcMs(nextDayKey, timeZone);
}
