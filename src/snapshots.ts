/**
 * Caching for the aggregate /api/stats/* routes.
 *
 * Two layers, because D1 bills by rows read and each stat scans most of
 * `plays`, so compute count must not scale with traffic. This deployment is
 * on Workers Paid, where reads are metered, not capped. On the Free plan,
 * going over 5M reads a day fails D1 for the whole Worker, ingestion
 * included, until 00:00 UTC.
 *
 * 1. `stats_snapshots` in D1 holds the last computed body. Only the request
 *    that wins a claim computes: inline for a key never computed, in the
 *    background (serving the stale body) otherwise. Everyone else reads.
 *    Concurrent cold misses across isolates therefore cost one scan, and a
 *    failing compute backs off instead of retrying on every request.
 * 2. The Cache API, for a few minutes, so most requests skip even that
 *    single-row read.
 *
 * Neither layer keys on the request URL. The stats routes take no parameters,
 * so a junk query string cannot mint a new key and force a scan.
 */

import { log } from './log';

const EDGE_TTL_SECONDS = 300;
/** Longest a compute may hold its claim before another request may take over. */
const CLAIM_MS = 2 * 60 * 1000;
/** How long a failed compute blocks the next attempt. */
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const EDGE_ORIGIN = 'https://stats-snapshot.internal';

/** Another request holds the claim on a key that has never been computed. */
export class SnapshotPending extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Stats are being computed; try again shortly.');
  }
}

/** The Cache API request a snapshot key is held under. */
export function edgeRequest(key: string): Request {
  return new Request(`${EDGE_ORIGIN}/${key}`);
}

export interface Snapshot {
  body: string;
  computedMs: number;
  source: 'edge' | 'snapshot' | 'stale' | 'computed';
}

type Row = { body: string | null; computed_ms: number | null; claimed_until_ms: number | null };

async function computeAndStore(
  db: D1Database,
  key: string,
  compute: () => Promise<unknown>,
): Promise<{ body: string; computedMs: number }> {
  try {
    const body = JSON.stringify(await compute());
    const computedMs = Date.now();
    await db
      .prepare('UPDATE stats_snapshots SET body = ?, computed_ms = ?, claimed_until_ms = NULL WHERE key = ?')
      .bind(body, computedMs, key)
      .run();
    return { body, computedMs };
  } catch (error) {
    await db
      .prepare('UPDATE stats_snapshots SET claimed_until_ms = ? WHERE key = ?')
      .bind(Date.now() + FAILURE_BACKOFF_MS, key)
      .run()
      .catch(() => {
        // D1 itself is failing; the claim lapses after CLAIM_MS regardless.
      });
    throw error;
  }
}

async function fromSnapshotTable(
  db: D1Database,
  ctx: ExecutionContext,
  key: string,
  freshForMs: number,
  compute: () => Promise<unknown>,
  now: number,
): Promise<Snapshot> {
  let row = await db
    .prepare('SELECT body, computed_ms, claimed_until_ms FROM stats_snapshots WHERE key = ?')
    .bind(key)
    .first<Row>();

  if (!row) {
    const created = await db
      .prepare('INSERT INTO stats_snapshots (key, claimed_until_ms) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .bind(key, now + CLAIM_MS)
      .run();
    if ((created.meta?.changes ?? 0) > 0) {
      const { body, computedMs } = await computeAndStore(db, key, compute);
      return { body, computedMs, source: 'computed' };
    }
    // Lost the race to create it; read what the winner left.
    row = await db
      .prepare('SELECT body, computed_ms, claimed_until_ms FROM stats_snapshots WHERE key = ?')
      .bind(key)
      .first<Row>();
  }

  const fresh = row?.body != null && row.computed_ms != null && now - row.computed_ms < freshForMs;
  if (fresh) return { body: row!.body!, computedMs: row!.computed_ms!, source: 'snapshot' };

  const claim = await db
    .prepare(
      'UPDATE stats_snapshots SET claimed_until_ms = ? WHERE key = ? AND (claimed_until_ms IS NULL OR claimed_until_ms < ?)',
    )
    .bind(now + CLAIM_MS, key, now)
    .run();
  const won = (claim.meta?.changes ?? 0) > 0;

  if (row?.body == null || row.computed_ms == null) {
    // Nothing to serve yet: compute inline if we hold the claim, otherwise
    // someone else is computing (or backing off from a failure).
    if (won) {
      const { body, computedMs } = await computeAndStore(db, key, compute);
      return { body, computedMs, source: 'computed' };
    }
    const until = row?.claimed_until_ms ?? now + CLAIM_MS;
    throw new SnapshotPending(Math.max(1, Math.ceil((until - now) / 1000)));
  }

  if (won) {
    ctx.waitUntil(
      computeAndStore(db, key, compute).catch((error) => {
        log('stats-refresh-failed', { key, error }, 'error');
      }),
    );
  }
  return { body: row.body, computedMs: row.computed_ms, source: 'stale' };
}

/** A stored body, if one has been computed, without ever computing one. */
export async function peekSnapshot(db: D1Database, key: string): Promise<{ body: string; computedMs: number } | null> {
  const row = await db
    .prepare('SELECT body, computed_ms FROM stats_snapshots WHERE key = ? AND body IS NOT NULL')
    .bind(key)
    .first<{ body: string; computed_ms: number }>();
  return row ? { body: row.body, computedMs: row.computed_ms } : null;
}

export async function snapshot(
  db: D1Database,
  ctx: ExecutionContext,
  key: string,
  freshForSeconds: number,
  compute: () => Promise<unknown>,
): Promise<Snapshot> {
  const cache = await caches.open('stats');
  const edgeKey = edgeRequest(key);

  const hit = await cache.match(edgeKey);
  if (hit) {
    return { body: await hit.text(), computedMs: Number(hit.headers.get('X-Computed-Ms')), source: 'edge' };
  }

  const result = await fromSnapshotTable(db, ctx, key, freshForSeconds * 1000, compute, Date.now());
  // A stale body is still worth holding at the edge briefly: the refresh is
  // already underway and the next miss after this TTL will pick it up.
  await cache.put(
    edgeKey,
    new Response(result.body, {
      headers: { 'Cache-Control': `max-age=${EDGE_TTL_SECONDS}`, 'X-Computed-Ms': String(result.computedMs) },
    }),
  );
  return result;
}
