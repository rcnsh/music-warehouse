import { env } from 'cloudflare:test';
import type { Env, RecentlyPlayedResponse } from '../src/types';

/**
 * The fixture is loaded by vitest.config.ts and injected as a binding, because
 * tests run inside workerd where there is no filesystem to read it from.
 */
export function loadFixture(): RecentlyPlayedResponse {
  return structuredClone(env.TEST_FIXTURE);
}

/**
 * What a fixture should produce once stored: unique (played_at_ms, track_id)
 * pairs, and items dropped for having no usable track id or timestamp. Derived
 * rather than hardcoded, so the suite gives the same answer against the
 * synthetic sample and against a real captured dump.
 */
export function expectedFromFixture(fixture: RecentlyPlayedResponse): { plays: number; skipped: number } {
  const keys = new Set<string>();
  let skipped = 0;
  for (const item of fixture.items ?? []) {
    const playedAtMs = Date.parse(item.played_at ?? '');
    if (!item.track?.id || !Number.isFinite(playedAtMs)) {
      skipped++;
      continue;
    }
    keys.add(`${playedAtMs}:${item.track.id}`);
  }
  return { plays: keys.size, skipped };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

/** Put the stored connection into a known-good, already-authorized state. */
export async function seedAuthorized(options: { accessExpiresMs?: number; authorizedAtMs?: number } = {}) {
  const now = Date.now();
  await env.DB.prepare(
    'UPDATE oauth_token SET access_token = ?, access_expires_ms = ?, refresh_token = ?, authorized_at_ms = ?, needs_reauth = 0 WHERE id = 1',
  )
    .bind(
      'live-access-token',
      options.accessExpiresMs ?? now + 60 * 60 * 1000,
      'stored-refresh-token',
      options.authorizedAtMs ?? now,
    )
    .run();
}

export async function syncState() {
  return env.DB.prepare('SELECT * FROM sync_state WHERE id = 1').first<{
    cursor_ms: number;
    last_success_ms: number | null;
    last_error: string | null;
    consecutive_failures: number;
  }>();
}

export async function oauthToken() {
  return env.DB.prepare('SELECT * FROM oauth_token WHERE id = 1').first<{
    access_token: string | null;
    access_expires_ms: number | null;
    refresh_token: string | null;
    authorized_at_ms: number;
    needs_reauth: number;
  }>();
}

export async function countPlays(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM plays').first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Wrap the D1 binding so a test can count how many binding calls a code path
 * makes. Each call is one subrequest against the Worker's budget of 50.
 */
export function countingDb(db: D1Database): { db: D1Database; calls: string[] } {
  const calls: string[] = [];
  const wrapped = {
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return wrapStatement(statement, sql, calls);
    },
    batch: (statements: D1PreparedStatement[]) => {
      calls.push(`batch(${statements.length})`);
      return db.batch(statements);
    },
    exec: (sql: string) => {
      calls.push('exec');
      return db.exec(sql);
    },
    dump: () => db.dump(),
    withSession: (...args: unknown[]) => (db as unknown as Record<string, Function>).withSession!(...args),
  } as unknown as D1Database;
  return { db: wrapped, calls };
}

function wrapStatement(statement: D1PreparedStatement, sql: string, calls: string[]): D1PreparedStatement {
  const label = sql.trim().split(/\s+/).slice(0, 2).join(' ');
  return new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'bind') {
        return (...args: unknown[]) => wrapStatement(target.bind(...args), sql, calls);
      }
      if (property === 'run' || property === 'all' || property === 'first' || property === 'raw') {
        return (...args: unknown[]) => {
          calls.push(label);
          return (value as Function).apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides } as Env;
}
