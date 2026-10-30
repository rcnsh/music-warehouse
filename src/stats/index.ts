import { type Era, eraDigest, loadEras, startOfLocalToday, startOfLocalWeek } from '../eras';
import { snapshot } from '../snapshots';
import type { Env } from '../types';
import { computeDrift } from './drift';
import { computeTopAlbums } from './albums';
import { computeOnRepeat } from './repeat';
import { computeRhythm } from './rhythm';
import { computeTopOverTime } from './top';

/**
 * Aggregate listening stats for a public page.
 *
 * Still behind READ_TOKEN like the rest of /api/*, but every body here is
 * built to be safe to republish as-is: counts, shares, names and months only —
 * no play rows, no context URIs, no dates finer than a month apart from
 * on-repeat's whole local days (see repeat.ts), and nothing that changes
 * more often than daily.
 *
 * Each stat covers data only up to a cut-off: the start of the local week
 * (rhythm, top-over-time, albums), the start of the UTC month (eras) or local
 * midnight (on-repeat). Between cut-offs a recompute would return the same
 * body, so a snapshot stays fresh until the next cut-off has passed and
 * settled. The figures are D1's own rows_read, measured against the full
 * history (75k plays); they count temporary B-trees, so they run well above
 * the row count. See docs/design.md, "Listening stats".
 */

/**
 * How long after a cut-off a stat waits before recomputing, so plays from just
 * before it that arrive late (a missed poll, a Worker that was down for a few
 * hours) still count. Until then the previous period's body is served.
 *
 * A history import is the one write this cannot see: imported plays show up
 * at each stat's next cut-off, or sooner by bumping the key's version.
 */
const SETTLE_MS = 6 * 60 * 60 * 1000;

/** Start of the UTC month containing `ms`, the cut-off computeDrift uses. */
const startOfUtcMonth = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

type Cutoff = (eras: readonly Era[], now: number) => number;

interface StatDef {
  cutoff: Cutoff;
  compute: (db: D1Database, now: number, eras: readonly Era[]) => Promise<unknown>;
}

const STATS = {
  'on-repeat': { cutoff: startOfLocalToday, compute: computeOnRepeat }, // ~47k rows
  rhythm: { cutoff: startOfLocalWeek, compute: computeRhythm }, // ~190k rows
  'top-over-time': { cutoff: startOfLocalWeek, compute: computeTopOverTime }, // ~395k rows
  eras: { cutoff: (_, now) => startOfUtcMonth(now), compute: computeDrift }, // ~315k rows
  albums: { cutoff: startOfLocalWeek, compute: computeTopAlbums }, // ~270k rows
} satisfies Record<string, StatDef>;

/**
 * Seconds a snapshot computed now-or-earlier stays fresh: anything computed
 * after the latest settled cut-off. During the settle window that is still
 * the previous cut-off, so the last period's body keeps serving.
 */
export function freshForSeconds(cutoff: Cutoff, eras: readonly Era[], now: number): number {
  const settledSince = cutoff(eras, now - SETTLE_MS) + SETTLE_MS;
  return Math.max(0, (now - settledSince) / 1000);
}

export type StatName = keyof typeof STATS;

export const STAT_NAMES = Object.keys(STATS) as StatName[];

export function isStatName(name: string): name is StatName {
  return Object.hasOwn(STATS, name);
}

/**
 * Each stat's body version. Bumping one retires its cached bodies when its
 * shape or its estimate changes: eras moved to generic field names in v2,
 * top-over-time's songs gained `track_id` in v2, and on-repeat counts plays
 * tied on played_at_ms in v2.
 */
const STAT_VERSIONS: Record<StatName, string> = {
  'on-repeat': 'v2',
  rhythm: 'v1',
  'top-over-time': 'v2',
  eras: 'v2',
  albums: 'v1',
};

/**
 * The snapshot key for a stat. The era digest retires bodies cut on eras that
 * have since been reconfigured.
 */
export const statKey = (name: StatName, eras: readonly Era[]) => `${name}:${STAT_VERSIONS[name]}:${eraDigest(eras)}`;

export async function statRoute(env: Env, ctx: ExecutionContext, name: StatName): Promise<Response> {
  const { cutoff, compute }: StatDef = STATS[name];
  // The version suffix retires every cached body when a shape changes.
  const now = Date.now();
  const eras = await loadEras(env, now);
  const result = await snapshot(env.DB, ctx, statKey(name, eras), freshForSeconds(cutoff, eras, now), () =>
    compute(env.DB, Date.now(), eras),
  );

  return new Response(result.body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      'X-Stats-Source': result.source,
      'X-Stats-Computed-At': new Date(result.computedMs).toISOString(),
    },
  });
}
