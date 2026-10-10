import { erasFor } from '../eras';
import { snapshot } from '../snapshots';
import type { Env } from '../types';
import { computeDrift } from './drift';
import { computeObsessions, computeOnRepeat } from './repeat';
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
 * Freshness is per stat, chosen by how fast it moves and what a recompute
 * costs. The figures are D1's own rows_read, measured against the full
 * history (75k plays); they count temporary B-trees, so they run well above
 * the row count. All five together stay near 2M rows a day however much
 * traffic arrives — see README, "Listening stats".
 */
const STATS = {
  'on-repeat': { freshForSeconds: 3 * 60 * 60, compute: computeOnRepeat }, // ~47k rows
  rhythm: { freshForSeconds: 6 * 60 * 60, compute: computeRhythm }, // ~190k rows
  'top-over-time': { freshForSeconds: 24 * 60 * 60, compute: computeTopOverTime }, // ~395k rows
  eras: { freshForSeconds: 24 * 60 * 60, compute: computeDrift }, // ~315k rows
  // Past binges only change when a new one peaks.
  obsessions: { freshForSeconds: 7 * 24 * 60 * 60, compute: computeObsessions }, // ~1.18M rows
} as const;

export type StatName = keyof typeof STATS;

export const STAT_NAMES = Object.keys(STATS) as StatName[];

export function isStatName(name: string): name is StatName {
  return Object.hasOwn(STATS, name);
}

export async function statRoute(env: Env, ctx: ExecutionContext, name: StatName): Promise<Response> {
  const { freshForSeconds, compute } = STATS[name];
  // The version suffix retires every cached body when a shape changes.
  const eras = erasFor(env.MOVED_AT);
  const result = await snapshot(env.DB, ctx, `${name}:v1`, freshForSeconds, () => compute(env.DB, Date.now(), eras));

  return new Response(result.body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      'X-Stats-Source': result.source,
      'X-Stats-Computed-At': new Date(result.computedMs).toISOString(),
    },
  });
}
