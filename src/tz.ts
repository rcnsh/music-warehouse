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
export function offsetMsAt(utcMs: number, timeZone: string): number {
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
 * UTC milliseconds at which local day `dateStr` ('YYYY-MM-DD') begins:
 * usually its midnight.
 *
 * Resolved by iteration because the offset that applies depends on the instant
 * being computed — one correction pass settles a DST change at any other hour.
 * Where a change skips midnight itself (Havana, Santiago and Beirut spring
 * forward from 00:00 to 01:00), that midnight does not exist and the day
 * begins at the change, so the first instant of the day is searched for.
 */
export function startOfLocalDayUtcMs(dateStr: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new RangeError(`Expected a YYYY-MM-DD date, got "${dateStr}"`);
  const [, year, month, day] = match;

  const naiveUtc = Date.UTC(Number(year), Number(month) - 1, Number(day));
  let guess = naiveUtc - offsetMsAt(naiveUtc, timeZone);
  guess = naiveUtc - offsetMsAt(guess, timeZone);
  if (localDayKey(guess, timeZone) === dateStr && localDayKey(guess - 1, timeZone) < dateStr) return guess;

  // The first instant whose local date is `dateStr` or later. No offset
  // changes by more than a day, so it lies within a day either side.
  let lo = guess - 86_400_000;
  let hi = guess + 86_400_000;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDayKey(mid, timeZone) >= dateStr) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Exclusive upper bound: UTC ms at local midnight ending `dateStr`. */
export function endOfLocalDayUtcMs(dateStr: string, timeZone: string): number {
  const start = startOfLocalDayUtcMs(dateStr, timeZone);
  // Step a day and a half forward, then snap to that day's local midnight, so
  // 23- and 25-hour DST days both land correctly.
  const nextDayKey = localDayKey(start + 36 * 60 * 60 * 1000, timeZone);
  return startOfLocalDayUtcMs(nextDayKey, timeZone);
}

/** Whether `day` is a real 'YYYY-MM-DD' calendar date (not 02-30, say, which Date.UTC rolls over). */
export function isRealDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(day);
}

/** Calendar days from `from` to `to` ('YYYY-MM-DD'), both counted: 1 for the same day. */
export function calendarDaysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

const DAY_MS = 86_400_000;
/** No zone changes its offset twice in this long, so sampling at this step finds every change (as zoneOffsets does). */
const SAMPLE_MS = 12 * 3_600_000;

/** A zone's offsets over [fromMs, toMs): offsets[i] applies from starts[i], and starts[0] is fromMs. */
interface Span {
  fromMs: number;
  toMs: number;
  starts: number[];
  offsets: number[];
}

/**
 * Offsets over [fromMs, toMs), sampled every SAMPLE_MS with each change found
 * to the second, which is as fine as Intl resolves an instant. Samples fall
 * on whole seconds, where offsetMsAt is exact.
 */
function spanOf(timeZone: string, fromMs: number, toMs: number): Span {
  const offsetAt = (seconds: number) => offsetMsAt(seconds * 1000, timeZone);
  const last = Math.ceil(toMs / 1000);
  let at = Math.floor(fromMs / 1000);
  let offset = offsetAt(at);
  const starts = [fromMs];
  const offsets = [offset];
  while (at < last) {
    const next = Math.min(at + SAMPLE_MS / 1000, last);
    const nextOffset = offsetAt(next);
    if (nextOffset !== offset) {
      let lo = at;
      let hi = next;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (offsetAt(mid) === offset) lo = mid;
        else hi = mid;
      }
      // A change in the last part-second after toMs belongs to the span that
      // follows, which finds it: recording it here would leave starts unsorted
      // once the two are joined.
      if (hi * 1000 >= toMs) break;
      starts.push(hi * 1000);
      offsets.push(nextOffset);
      offset = nextOffset;
    }
    at = next;
  }
  return { fromMs, toMs, starts, offsets };
}

/** Two spans that meet (a.toMs === b.fromMs) as one. */
function join(a: Span, b: Span): Span {
  const starts = [...a.starts];
  const offsets = [...a.offsets];
  b.starts.forEach((start, i) => {
    if (offsets[offsets.length - 1] === b.offsets[i]) return;
    starts.push(start);
    offsets.push(b.offsets[i]!);
  });
  return { fromMs: a.fromMs, toMs: b.toMs, starts, offsets };
}

/** Each zone's offsets found so far in this isolate, grown to cover whatever is asked of it. */
const spans = new Map<string, Span>();

function spanCovering(timeZone: string, fromMs: number, toMs: number): Span {
  let span = spans.get(timeZone) ?? spanOf(timeZone, fromMs, toMs);
  if (fromMs < span.fromMs) span = join(spanOf(timeZone, fromMs, span.fromMs), span);
  if (toMs > span.toMs) span = join(span, spanOf(timeZone, span.toMs, toMs));
  spans.set(timeZone, span);
  return span;
}

const dayKeys = new Map<number, string>();

/** 'YYYY-MM-DD' for a day number (days since 1970-01-01). */
function dayKeyOf(dayNumber: number): string {
  let key = dayKeys.get(dayNumber);
  if (key === undefined) {
    key = new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
    dayKeys.set(dayNumber, key);
  }
  return key;
}

export interface LocalCalendar {
  /** The zone's offset at an instant (the second it falls in). */
  offsetAt(utcMs: number): number;
  /** localDayKey, without Intl inside the range. */
  dayOf(utcMs: number): string;
  /** Every local date some instant of the range falls on, ascending. */
  days(): string[];
}

/**
 * Local days and offsets over [fromMs, toMs) by arithmetic, for code that
 * buckets many instants or walks many days. The zone's offsets are found once
 * (about two Intl calls per day of range) and kept for the isolate; after
 * that an instant's day is a binary search and a division, where localDayKey
 * is an Intl call each time. Answers exactly as localDayKey does, and falls
 * back to it outside the range.
 */
export function localCalendar(timeZone: string, fromMs: number, toMs: number): LocalCalendar {
  const span = spanCovering(timeZone, fromMs, Math.max(toMs, fromMs + 1));
  const { starts, offsets } = span;
  const index = (utcMs: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= utcMs) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const inside = (utcMs: number) => utcMs >= span.fromMs && utcMs < span.toMs;
  const offsetAt = (utcMs: number) =>
    inside(utcMs) ? offsets[index(utcMs)]! : offsetMsAt(Math.floor(utcMs / 1000) * 1000, timeZone);
  return {
    offsetAt,
    dayOf: (utcMs) => (inside(utcMs) ? dayKeyOf(Math.floor((utcMs + offsetAt(utcMs)) / DAY_MS)) : localDayKey(utcMs, timeZone)),
    days() {
      const numbers = new Set<number>();
      for (let i = index(fromMs); i < starts.length && starts[i]! < toMs; i++) {
        const segmentFrom = Math.max(starts[i]!, fromMs);
        const segmentTo = Math.min(starts[i + 1] ?? Infinity, toMs);
        if (segmentFrom >= segmentTo) continue;
        const last = Math.floor((segmentTo - 1 + offsets[i]!) / DAY_MS);
        for (let day = Math.floor((segmentFrom + offsets[i]!) / DAY_MS); day <= last; day++) numbers.add(day);
      }
      return [...numbers].sort((a, b) => a - b).map(dayKeyOf);
    },
  };
}
