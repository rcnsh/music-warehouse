import { BadRequest, json } from './api';
import { DEFAULT_TOKEN_TTL_DAYS, base64url, listedOrigins, mintToken, sha256Hex, randomSecret, tokenName } from './auth';
import { readState } from './db';
import { SpotifyError, authorizeUrl, exchangeCode, spotifyGet } from './spotify';
import { NeedsReauthError, getAccessToken } from './tokens';
import type { Env } from './types';
import { log } from './log';

/**
 * Sign in with Spotify, to mint a read device token without copying one.
 *
 * Deliberately separate from /login and /callback, which hold the ingestion
 * grant: different routes, a different redirect URI, no scopes, and the
 * Spotify token it gets is used for one /v1/me call and dropped. A sign-in
 * can never overwrite the grant polling depends on.
 *
 * A sign-in only ever mints a `read` token. Admin tokens come from
 * POST /admin/tokens, so a hijacked Spotify session cannot import or poll.
 *
 * An app signs in like an OAuth public client with PKCE: it sends a
 * code_challenge to /auth/login, gets a one-time code back on its return_to
 * URL, and exchanges code plus verifier at /auth/token. The code in the URL is
 * worthless alone, and expires within a minute anyway. Without return_to, the
 * token is shown once on a page, for a shell or script.
 *
 * return_to is one of three kinds (RFC 8252 for the native two):
 * - a web page on an origin in CORS_ORIGINS, which must also be the Origin of
 *   the exchange;
 * - http://127.0.0.1 or http://[::1] on any port, for a desktop app or CLI
 *   listening on loopback;
 * - a custom scheme in SIGN_IN_SCHEMES, for a mobile app.
 * A native app's exchange carries no Origin, so for those PKCE alone binds the
 * code to the app that started the sign-in.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
/** Sign-ins in flight at once. The routes are unauthenticated, so this bounds the rows a stranger can create. */
const MAX_PENDING = 50;

/** Stored as a code's origin when its exchange is not checked against one. */
const NATIVE = 'native';

/** Base64url SHA-256, the only code_challenge_method accepted (RFC 7636 S256). */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** The sign-in redirect URI: /auth/callback on the same host as the ingestion one. */
export function signInRedirectUri(env: Env): string {
  return new URL('/auth/callback', env.SPOTIFY_REDIRECT_URI).href;
}

/** Store the Spotify user id an access token belongs to as the warehouse's owner. */
export async function recordOwner(db: D1Database, accessToken: string): Promise<string> {
  const me = (await spotifyGet(accessToken, '/me')) as { id?: string } | null;
  if (!me?.id) throw new SpotifyError('http', '/me returned no user id.');
  await db.prepare('UPDATE oauth_token SET spotify_user_id = ? WHERE id = 1').bind(me.id).run();
  return me.id;
}

/**
 * The owner's Spotify user id, or null before ingestion was ever authorized.
 * A warehouse authorized before this was recorded asks Spotify once, with the
 * stored grant.
 */
async function ownerId(env: Env): Promise<string | null> {
  const { token } = await readState(env.DB);
  if (token.spotify_user_id) return token.spotify_user_id;
  if (!token.refresh_token) return null;
  return recordOwner(env.DB, await getAccessToken(env.DB, env, token, Date.now()));
}

/**
 * Who may exchange a code sent to `returnTo`: its web origin, NATIVE, or null
 * when it is not somewhere a code may be sent at all.
 */
function exchangeOrigin(env: Env, returnTo: URL): string | null {
  // Exact origins only. A `*` in CORS_ORIGINS opens reads, never sign-in:
  // that would hand a code to any page that asked.
  if (listedOrigins(env).includes(returnTo.origin)) return returnTo.origin;
  // IP literals, not `localhost`, which a hosts file or resolver can point
  // elsewhere (RFC 8252 section 8.3).
  if (returnTo.protocol === 'http:' && (returnTo.hostname === '127.0.0.1' || returnTo.hostname === '[::1]')) {
    return NATIVE;
  }
  const schemes = (env.SIGN_IN_SCHEMES ?? '').split(',').map((scheme) => scheme.trim().toLowerCase()).filter(Boolean);
  if (schemes.includes(returnTo.protocol.slice(0, -1))) return NATIVE;
  return null;
}

function returnToParam(env: Env, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequest('`return_to` must be an absolute URL.');
  }
  if (!exchangeOrigin(env, parsed)) {
    throw new BadRequest(
      '`return_to` must be on an origin in CORS_ORIGINS, on http://127.0.0.1, or use a scheme in SIGN_IN_SCHEMES.',
    );
  }
  parsed.hash = '';
  return parsed.href;
}

/** GET /auth/login?name=&return_to=&code_challenge=&code_challenge_method=S256 */
export async function signInStart(env: Env, url: URL): Promise<Response> {
  const name = tokenName(url.searchParams.get('name'));
  const rawReturnTo = url.searchParams.get('return_to');
  const returnTo = rawReturnTo ? returnToParam(env, rawReturnTo) : null;

  let challenge: string | null = null;
  if (returnTo) {
    challenge = url.searchParams.get('code_challenge');
    if (!challenge || !CHALLENGE.test(challenge)) {
      throw new BadRequest('`code_challenge` is required with `return_to`: base64url SHA-256 of the verifier.');
    }
    const method = url.searchParams.get('code_challenge_method') ?? 'S256';
    if (method !== 'S256') throw new BadRequest('`code_challenge_method` must be S256.');
  }

  const now = Date.now();
  const state = randomSecret();
  const [, inserted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM login_state WHERE created_ms < ?').bind(now - STATE_TTL_MS),
    env.DB.prepare(
      'INSERT INTO login_state (state, created_ms, device_name, return_to, code_challenge) ' +
        'SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM login_state) < ?',
    ).bind(state, now, name, returnTo, challenge, MAX_PENDING),
  ]);
  if (!inserted?.meta.changes) return json({ error: 'Too many sign-ins in progress. Try again in a few minutes.' }, 429);

  const location = authorizeUrl(env, state, { redirectUri: signInRedirectUri(env), scope: '' });
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

/** `return_to` with query parameters added, for handing a code or an error back to the app. */
function backTo(returnTo: string, params: Record<string, string>): Response {
  const target = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: target.href, 'Cache-Control': 'no-store' } });
}

/** GET /auth/callback: Spotify's redirect target for sign-in. */
export async function signInCallback(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get('state');
  if (!state) return page('Sign-in failed', 'Missing state. Start again.', 400);

  // Single use: consumed before anything else, whatever happens next.
  const pending = await env.DB.prepare(
    'DELETE FROM login_state WHERE state = ? RETURNING created_ms, device_name, return_to, code_challenge',
  )
    .bind(state)
    .first<{ created_ms: number; device_name: string; return_to: string | null; code_challenge: string | null }>();
  if (!pending || Date.now() - pending.created_ms > STATE_TTL_MS) {
    return page('Sign-in failed', 'This sign-in expired or was already used. Start again.', 400);
  }

  const fail = (error: string, message: string, status: number) =>
    pending.return_to ? backTo(pending.return_to, { error }) : page('Sign-in failed', message, status);

  const code = url.searchParams.get('code');
  if (!code) return fail(url.searchParams.get('error') ?? 'access_denied', 'Spotify did not approve the sign-in.', 400);

  let signedIn: string;
  let owner: string | null;
  try {
    const identity = await exchangeCode(env, code, signInRedirectUri(env));
    const me = (await spotifyGet(identity.access_token, '/me')) as { id?: string } | null;
    if (!me?.id) throw new SpotifyError('http', '/me returned no user id.');
    signedIn = me.id;
    owner = await ownerId(env);
  } catch (error) {
    if (!(error instanceof SpotifyError || error instanceof NeedsReauthError)) throw error;
    log('sign-in-error', { message: error.message }, 'error');
    return fail('unavailable', 'Could not confirm your Spotify account. Try again later.', 502);
  }

  if (!owner) return fail('unavailable', 'This warehouse has not been authorized with Spotify yet.', 503);
  if (signedIn !== owner) return fail('not_owner', 'That Spotify account does not own this warehouse.', 403);

  if (!pending.return_to) {
    const minted = await mintToken(env.DB, {
      name: pending.device_name,
      access: 'read',
      ttlDays: DEFAULT_TOKEN_TTL_DAYS,
      via: 'spotify',
    });
    return tokenPage(minted.name, minted.token, minted.expires_ms!);
  }

  const now = Date.now();
  const oneTimeCode = randomSecret();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_codes WHERE created_ms < ?').bind(now - CODE_TTL_MS),
    env.DB.prepare(
      'INSERT INTO login_codes (code_hash, created_ms, device_name, origin, code_challenge) VALUES (?, ?, ?, ?, ?)',
    ).bind(
      await sha256Hex(oneTimeCode),
      now,
      pending.device_name,
      // Validated at /auth/login. If the config has since dropped it, the
      // strictest reading: only the page's own origin may exchange.
      exchangeOrigin(env, new URL(pending.return_to)) ?? new URL(pending.return_to).origin,
      pending.code_challenge,
    ),
  ]);
  return backTo(pending.return_to, { code: oneTimeCode });
}

/**
 * POST /auth/token `{ code, code_verifier }`, from the origin that started the
 * sign-in, or from a native app. Returns a read device token. Every failure is the same
 * `invalid_grant`, so a caller learns nothing about which check failed, and
 * the code is spent by the first attempt either way.
 */
export async function signInExchange(env: Env, request: Request): Promise<Response> {
  const invalid = () => json({ error: 'invalid_grant' }, 400);

  let body: { code?: unknown; code_verifier?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  if (typeof body !== 'object' || body === null) return json({ error: 'Body must be a JSON object.' }, 400);
  const { code, code_verifier: verifier } = body;
  if (typeof code !== 'string' || typeof verifier !== 'string' || !VERIFIER.test(verifier)) {
    return json({ error: '`code` and `code_verifier` (43 to 128 characters) are required.' }, 400);
  }

  const pending = await env.DB.prepare(
    'DELETE FROM login_codes WHERE code_hash = ? RETURNING created_ms, device_name, origin, code_challenge',
  )
    .bind(await sha256Hex(code))
    .first<{ created_ms: number; device_name: string; origin: string; code_challenge: string }>();
  if (!pending || Date.now() - pending.created_ms > CODE_TTL_MS) return invalid();
  if (pending.origin !== NATIVE && request.headers.get('Origin') !== pending.origin) return invalid();

  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  if (challenge !== pending.code_challenge) return invalid();

  const minted = await mintToken(env.DB, {
    name: pending.device_name,
    access: 'read',
    ttlDays: DEFAULT_TOKEN_TTL_DAYS,
    via: 'spotify',
  });
  return json(minted);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string, status = 200): Response {
  const html =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}` +
    `code{display:block;word-break:break-all;padding:1rem;background:#8882;border-radius:.5rem}</style>` +
    `<h1>${escapeHtml(title)}</h1>${body}`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Inline styles only: no scripts, no frames, nothing fetched.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function tokenPage(name: string, token: string, expiresMs: number): Response {
  return page(
    'Signed in',
    `<p>A read token for <strong>${escapeHtml(name)}</strong>, valid until ` +
      `${new Date(expiresMs).toISOString().slice(0, 10)}. It is shown only once.</p><code>${escapeHtml(token)}</code>`,
  );
}
