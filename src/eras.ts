import { isValidTimeZone, localDayKey, offsetMsAt, startOfLocalDayUtcMs } from './tz';
import type { Env } from './types';

/**
 * Stages of the listener's life, and so which clock "local time" means.
 *
 * Plays carry no location, so the timeline is read in the timezone of the
 * stage it falls in. Stages come from the ERAS setting, a JSON list such as
 *
 *   [{"key":"uni","label":"Uni","timeZone":"Europe/London","from":"2024-09-16T00:00:00+01:00","to":"2026-05-18T00:00:00+01:00"},
 *    {"key":"abroad","label":"Abroad","timeZone":"Asia/Tokyo","from":"2026-07-28T00:00:00+09:00"}]
 *
 * Every era after the first needs `from`, an ISO instant; any era may have
 * `to`, the instant it ends. Stages need not cover all of history: time
 * before the first stage, or after one that has ended and before the next,
 * is a gap. A gap is read in the zone of the stage before it (the first
 * stage's, before the first) and counts everywhere, but is never reported
 * by name. A holiday is not a stage: it stays on the clock of the stage it
 * falls in. Without ERAS there is one era in TIMEZONE, or UTC.
 *
 * History starts at HISTORY_FROM, an ISO instant (plays before it are
 * ignored, useful when the first few are noise), or else at the first stored
 * play, never at an era's `from`.
 *
 * Set ERAS as a Worker secret rather than a var if an era's start is private:
 * the stats only ever publish the month an era began, and the exact day would
 * undo that.
 */

export interface Era {
  key: string;
  label: string;
  timeZone: string;
  /** Time outside every stage, on a neighbouring stage's clock; never reported by name. */
  gap: boolean;
  /** Inclusive UTC ms at which this era starts. Eras, gaps included, are contiguous and in order. */
  fromMs: number;
  /**
   * SQL for this era's UTC offset in seconds, in terms of `s` (UTC epoch
   * seconds). SQLite has no zone database, so the zone's transitions are
   * written out as a CASE; the stats tests check it against Intl.
   */
  offsetSql: string;
}

export interface EraConfig {
  key: string;
  label: string;
  timeZone: string;
  from?: string;
  to?: string;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Thrown for an ERAS or TIMEZONE setting that cannot be used, naming what is wrong. */
export class EraConfigError extends Error {}

/**
 * The configured eras, validated. Keys are lowercase words so they can stand
 * as JSON keys and CSS hooks in a client.
 */
export function parseEras(raw: string | undefined, timeZone: string | undefined): EraConfig[] {
  if (!raw?.trim()) {
    const zone = timeZone?.trim() || 'UTC';
    if (!isValidTimeZone(zone)) throw new EraConfigError(`TIMEZONE is not an IANA timezone: ${zone}`);
    return [{ key: 'local', label: 'Local time', timeZone: zone }];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EraConfigError('ERAS is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new EraConfigError('ERAS must be a non-empty JSON array');
  const seen = new Set<string>();
  // The last instant taken: an era's start, or its end if it has one. The
  // next era may start where one ended, but not where one started.
  let previous = -Infinity;
  let previousEnded = false;
  return parsed.map((entry: Record<string, unknown>, i): EraConfig => {
    const where = `ERAS[${i}]`;
    const { key, label, timeZone: zone, from, to } = entry ?? {};
    if (typeof key !== 'string' || !/^[a-z0-9-]{1,32}$/.test(key)) throw new EraConfigError(`${where}.key must be 1-32 of a-z, 0-9, -`);
    if (seen.has(key)) throw new EraConfigError(`${where}.key repeats "${key}"`);
    seen.add(key);
    if (typeof label !== 'string' || !label.trim()) throw new EraConfigError(`${where}.label is required`);
    if (typeof zone !== 'string' || !isValidTimeZone(zone)) throw new EraConfigError(`${where}.timeZone is not an IANA timezone`);
    const config: EraConfig = { key, label, timeZone: zone };
    if (from !== undefined || i > 0) {
      const ms = typeof from === 'string' ? Date.parse(from) : Number.NaN;
      if (!Number.isFinite(ms)) throw new EraConfigError(`${where}.from must be an ISO instant`);
      if (ms < previous || (ms === previous && !previousEnded)) throw new EraConfigError(`${where}.from must be after the era before it`);
      previous = ms;
      config.from = from as string;
    }
    previousEnded = false;
    if (to !== undefined) {
      const ms = typeof to === 'string' ? Date.parse(to) : Number.NaN;
      if (!Number.isFinite(ms)) throw new EraConfigError(`${where}.to must be an ISO instant`);
      if (ms <= previous) throw new EraConfigError(`${where}.to must be after its from`);
      previous = ms;
      previousEnded = true;
      config.to = to as string;
    }
    return config;
  });
}

/**
 * Transitions of `timeZone` in [fromMs, toMs) as [instant, offset after] pairs.
 * Offsets are sampled every 12 hours (no zone changes twice in that time) and
 * each change is found to the second, as zoneOffsets does: that is as fine as
 * Intl resolves an instant, and the SQL compares whole seconds. Narrowing to
 * the minute left up to a minute after each change on the old offset.
 * Sampling is in whole seconds, since offsetMsAt of a mid-second instant is
 * off by its milliseconds.
 */
function transitions(timeZone: string, fromMs: number, toMs: number): Array<[number, number]> {
  const offsetAt = (seconds: number) => offsetMsAt(seconds * 1000, timeZone);
  const out: Array<[number, number]> = [];
  const end = Math.ceil(toMs / 1000);
  let at = Math.floor(fromMs / 1000);
  let offset = offsetAt(at);
  while (at < end) {
    const next = Math.min(at + (12 * HOUR_MS) / 1000, end);
    const nextOffset = offsetAt(next);
    if (nextOffset !== offset) {
      let lo = at;
      let hi = next;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (offsetAt(mid) === offset) lo = mid;
        else hi = mid;
      }
      out.push([hi * 1000, nextOffset]);
      offset = nextOffset;
    }
    at = next;
  }
  return out;
}

const offsetSqlCache = new Map<string, string>();

/** SQL for `timeZone`'s offset in seconds, valid for `s` within [fromMs, toMs). */
export function offsetSqlFor(timeZone: string, fromMs: number, toMs: number): string {
  const cacheKey = `${timeZone}|${fromMs}|${toMs}`;
  let sql = offsetSqlCache.get(cacheKey);
  if (sql === undefined) {
    const first = offsetMsAt(fromMs, timeZone) / 1000;
    const changes = transitions(timeZone, fromMs, toMs);
    sql = changes.length
      ? `CASE ${changes
          .map(([ms], i) => `WHEN s < ${Math.floor(ms / 1000)} THEN ${i === 0 ? first : changes[i - 1]![1] / 1000}`)
          .join(' ')} ELSE ${changes.at(-1)![1] / 1000} END`
      : String(first);
    offsetSqlCache.set(cacheKey, sql);
  }
  return sql;
}

/**
 * Stages and the gaps between them, with start instants and offset SQL, from
 * `historyStartMs` on. The first stage starts there when it has no `from`; a
 * stage or gap that ends by then is dropped, and the first one kept is cut to
 * start there. The current era's offsets are written out to a year past
 * today, rounded to the day so the SQL (and its cache entry) changes once a
 * day at most.
 */
export function buildEras(configs: EraConfig[], historyStartMs: number, now = Date.now()): Era[] {
  const spans: Array<{ fromMs: number; config: EraConfig; gap: boolean }> = [];
  configs.forEach((config, i) => {
    const fromMs = config.from ? Date.parse(config.from) : historyStartMs;
    if (i === 0 && fromMs > historyStartMs) spans.push({ fromMs: historyStartMs, config, gap: true });
    spans.push({ fromMs, config, gap: false });
    const next = configs[i + 1];
    if (config.to && (!next || Date.parse(next.from!) > Date.parse(config.to))) {
      spans.push({ fromMs: Date.parse(config.to), config, gap: true });
    }
  });
  let first = 0;
  while (first + 1 < spans.length && spans[first + 1]!.fromMs <= historyStartMs) first++;
  const kept = spans.slice(first);
  kept[0] = { ...kept[0]!, fromMs: Math.max(kept[0]!.fromMs, historyStartMs) };

  const horizon = Math.ceil((now + 366 * DAY_MS) / DAY_MS) * DAY_MS;
  return kept.map(({ fromMs, config, gap }, i) => {
    const toMs = kept[i + 1]?.fromMs ?? horizon;
    return { key: config.key, label: config.label, timeZone: config.timeZone, gap, fromMs, offsetSql: offsetSqlFor(config.timeZone, fromMs, toMs) };
  });
}

/**
 * The deployment's eras. Without HISTORY_FROM, history starts at the first
 * stored play: one primary-key read.
 */
export async function loadEras(env: Pick<Env, 'DB' | 'ERAS' | 'TIMEZONE' | 'HISTORY_FROM'>, now = Date.now()): Promise<Era[]> {
  const configs = parseEras(env.ERAS, env.TIMEZONE);
  const historyFrom = env.HISTORY_FROM?.trim();
  if (historyFrom) {
    const ms = Date.parse(historyFrom);
    if (!Number.isFinite(ms)) throw new EraConfigError('HISTORY_FROM must be an ISO instant');
    return buildEras(configs, ms, now);
  }
  const first = await env.DB.prepare('SELECT played_at_ms FROM plays ORDER BY played_at_ms LIMIT 1').first<{ played_at_ms: number }>();
  return buildEras(configs, first?.played_at_ms ?? now, now);
}

/**
 * A short stable tag for the era settings, for snapshot keys: stats cut on
 * one set of eras must not be served after the settings change.
 */
export function eraDigest(eras: readonly Era[]): string {
  const text = eras.map((era) => `${era.key}|${era.label}|${era.timeZone}|${era.gap ? 'gap|' : ''}${era.fromMs}`).join(';');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

/** Where the stats' history starts: the first era's (or gap's) start. */
export const historyStartMs = (eras: readonly Era[]) => eras[0]!.fromMs;

export function eraAt(eras: readonly Era[], utcMs: number): Era {
  let current = eras[0]!;
  for (const era of eras) if (utcMs >= era.fromMs) current = era;
  return current;
}

/** UTC ms at which the era or gap after `era` begins, or null for the last one. */
export function eraEndMs(eras: readonly Era[], era: Era): number | null {
  const next = eras[eras.indexOf(era) + 1];
  return next ? next.fromMs : null;
}

/**
 * SQL giving local epoch seconds (UTC seconds shifted by the offset in force)
 * plus a 0-based era index, for a row whose UTC seconds are `s`.
 * `date(local, 'unixepoch')` then yields the local calendar day.
 */
export function localTimeSql(eras: readonly Era[]): { local: string; era: string } {
  const latestFirst = eras.map((era, index) => ({ era, index })).reverse();
  const era = `CASE ${latestFirst.map(({ era, index }) => `WHEN s * 1000 >= ${era.fromMs} THEN ${index}`).join(' ')} ELSE 0 END`;
  const offset = `CASE ${latestFirst.map(({ era }) => `WHEN s * 1000 >= ${era.fromMs} THEN (${era.offsetSql})`).join(' ')} ELSE 0 END`;
  return { local: `s + ${offset}`, era };
}

/** 'YYYY-MM' of a UTC instant in the given zone. */
export function monthOf(utcMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })
    .format(new Date(utcMs))
    .slice(0, 7);
}

/** UTC ms of local midnight starting today, in the era in force now. */
export function startOfLocalToday(eras: readonly Era[], now: number): number {
  const { timeZone } = eraAt(eras, now);
  return startOfLocalDayUtcMs(localDayKey(now, timeZone), timeZone);
}

/**
 * UTC ms of local midnight starting this Monday, in the era in force now.
 *
 * Stats that would otherwise change daily are computed only up to here. A
 * count that ticks over once a day, set beside today's date, dates whatever
 * it counts from — a streak's first day, say — and comparing one day's page
 * with the next isolates a single day's listening. Weekly steps blunt both.
 */
export function startOfLocalWeek(eras: readonly Era[], now: number): number {
  const { timeZone } = eraAt(eras, now);
  const today = localDayKey(now, timeZone);
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const monday = localDayKey(Date.parse(`${today}T12:00:00Z`) - weekday * DAY_MS, 'UTC');
  return startOfLocalDayUtcMs(monday, timeZone);
}
