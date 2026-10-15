import { BadRequest, json } from './api';
import type { Env } from './types';

/**
 * Access level of the presented bearer token (R11).
 *
 * `admin` unlocks everything. `read` unlocks the /api/* routes only, so a
 * website can render listening data without holding a credential that could
 * also trigger a poll or write rows. Every route still requires one or the
 * other; /callback is the sole exception, and the OAuth `state` guards it.
 */
export type Access = 'admin' | 'read';

/** Prefix of every minted token, so a leaked one is easy to recognise and grep for. */
const TOKEN_PREFIX = 'mw_';

/** `last_used_ms` is written at most this often per token, so reads stay reads. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TOKEN_TTL_DAYS = 90;

/**
 * Compare two secrets without leaking length or content through timing.
 * Both sides are hashed first so the comparison is always over 32 equal bytes.
 */
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `bytes` of CSPRNG output, base64url without padding. */
export function randomSecret(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Resolve the request's bearer token to an access level.
 *
 * ADMIN_TOKEN is the break-glass credential: kept offline, used to mint and
 * revoke device tokens, never carried around. READ_TOKEN predates device
 * tokens and is honoured until every reader has moved off it. Everything else
 * is a row in `api_tokens`, looked up by hash — which leaks nothing useful
 * through timing, since a caller cannot choose what their guess hashes to.
 */
export async function accessFor(request: Request, env: Env, ctx: ExecutionContext): Promise<Access | null> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const presented = match[1]!;

  if (env.ADMIN_TOKEN && (await secretsMatch(presented, env.ADMIN_TOKEN))) return 'admin';
  if (env.READ_TOKEN && (await secretsMatch(presented, env.READ_TOKEN))) return 'read';
  if (!presented.startsWith(TOKEN_PREFIX)) return null;

  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT id, access, last_used_ms FROM api_tokens ' +
      'WHERE token_hash = ? AND revoked_ms IS NULL AND (expires_ms IS NULL OR expires_ms > ?)',
  )
    .bind(await sha256Hex(presented), now)
    .first<{ id: string; access: Access; last_used_ms: number | null }>();
  if (!row) return null;

  if (!row.last_used_ms || now - row.last_used_ms > LAST_USED_RESOLUTION_MS) {
    ctx.waitUntil(env.DB.prepare('UPDATE api_tokens SET last_used_ms = ? WHERE id = ?').bind(now, row.id).run());
  }
  return row.access;
}

export interface MintedToken {
  id: string;
  token: string;
  name: string;
  access: Access;
  expires_ms: number | null;
}

/** Store a new token and return it. The token itself is never readable again. */
export async function mintToken(
  db: D1Database,
  options: { name: string; access: Access; ttlDays: number | null; via: string },
  now = Date.now(),
): Promise<MintedToken> {
  const id = `tok_${randomSecret(9)}`;
  const token = `${TOKEN_PREFIX}${randomSecret()}`;
  const expiresMs = options.ttlDays === null ? null : now + options.ttlDays * DAY_MS;
  await db
    .prepare(
      'INSERT INTO api_tokens (id, token_hash, name, access, created_ms, expires_ms, created_via) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, await sha256Hex(token), options.name, options.access, now, expiresMs, options.via)
    .run();
  return { id, token, name: options.name, access: options.access, expires_ms: expiresMs };
}

/** A device name as given by a caller: trimmed, non-empty, short enough to list. */
export function tokenName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 64) throw new BadRequest('`name` must be 1 to 64 characters.');
  return name;
}

/**
 * POST /admin/tokens `{ name, access?, expires_in_days? }`.
 *
 * `access` defaults to `read`. `expires_in_days` defaults to 90; `null` means
 * the token never expires, which is worth it only for an unattended script.
 */
export async function createTokenRoute(env: Env, request: Request): Promise<Response> {
  let body: { name?: unknown; access?: unknown; expires_in_days?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  if (typeof body !== 'object' || body === null) throw new BadRequest('Body must be a JSON object.');

  const name = tokenName(body.name);
  const access = body.access ?? 'read';
  if (access !== 'read' && access !== 'admin') throw new BadRequest('`access` must be "read" or "admin".');

  const days = body.expires_in_days === undefined ? DEFAULT_TOKEN_TTL_DAYS : body.expires_in_days;
  if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3660)) {
    throw new BadRequest('`expires_in_days` must be an integer from 1 to 3660, or null for never.');
  }

  const minted = await mintToken(env.DB, { name, access, ttlDays: days, via: 'admin' });
  return json({ ...minted, note: 'Store this token now. It cannot be shown again.' }, 201);
}

/** GET /admin/tokens: every token ever minted, newest first. Never the hashes. */
export async function listTokensRoute(env: Env): Promise<Response> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    'SELECT id, name, access, created_ms, expires_ms, last_used_ms, revoked_ms, created_via ' +
      'FROM api_tokens ORDER BY created_ms DESC',
  ).all<{ expires_ms: number | null; revoked_ms: number | null }>();
  return json({
    tokens: results.map((row) => ({
      ...row,
      active: row.revoked_ms === null && (row.expires_ms === null || row.expires_ms > now),
    })),
  });
}

/** DELETE /admin/tokens?id=: revoke, effective on the token's next request. */
export async function revokeTokenRoute(env: Env, url: URL): Promise<Response> {
  const id = url.searchParams.get('id');
  if (!id) throw new BadRequest('`id` is required.');
  const result = await env.DB.prepare(
    'UPDATE api_tokens SET revoked_ms = COALESCE(revoked_ms, ?) WHERE id = ?',
  )
    .bind(Date.now(), id)
    .run();
  if (!result.meta.changes) return json({ error: 'No such token.' }, 404);
  return json({ id, revoked: true });
}
