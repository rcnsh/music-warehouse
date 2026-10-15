import { BadRequest, json } from './api';
import {
  DEFAULT_TOKEN_TTL_DAYS,
  base64url,
  clientKey,
  listedOrigins,
  mintToken,
  randomSecret,
  sha256Hex,
  tokenName,
} from './auth';
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
 *
 * PKCE proves the code reaches whoever started the sign-in, not that the owner
 * meant them to have it: any local process can listen on loopback, and any
 * mobile app can register a scheme. So /auth/login first shows a warehouse
 * page naming the client and its return_to, and goes on to Spotify only when
 * the owner presses Allow, in that browser (a cookie, checked again at
 * /auth/callback). Spotify is asked to show its own dialog every time too,
 * rather than waving an already-approved session through unseen.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
/** Sign-ins in flight at once. The routes are unauthenticated, so this bounds the rows a stranger can create. */
const MAX_PENDING = 200;
/**
 * Of those, how many one client address may hold. Without it, fifty requests
 * from anyone locked the owner out for ten minutes; now a stranger fills only
 * their own allowance. The optional AUTH_RATE_LIMITER binding slows them down
 * before they reach D1 at all.
 */
const MAX_PENDING_PER_CLIENT = 10;

const STALE = 'This sign-in expired, was already used, or was started in another browser. Start again.';

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
  const me = (await spotifyGet({ db, source: 'signin' }, accessToken, '/me')) as { id?: string } | null;
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
export async function signInStart(env: Env, request: Request, url: URL): Promise<Response> {
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
  const browser = randomSecret();
  const client = await clientKey(request, env);
  // `IS`, not `=`: off Cloudflare's edge there is no client address, and those
  // sign-ins share one allowance rather than escaping the cap.
  const [, inserted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM login_state WHERE created_ms < ?').bind(now - STATE_TTL_MS),
    env.DB.prepare(
      'INSERT INTO login_state (state, created_ms, device_name, return_to, code_challenge, client_hash, browser_hash) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM login_state) < ? ' +
        'AND (SELECT COUNT(*) FROM login_state WHERE client_hash IS ?) < ?',
    ).bind(
      state,
      now,
      name,
      returnTo,
      challenge,
      client,
      await sha256Hex(browser),
      MAX_PENDING,
      client,
      MAX_PENDING_PER_CLIENT,
    ),
  ]);
  if (!inserted?.meta.changes) return json({ error: 'Too many sign-ins in progress. Try again in a few minutes.' }, 429);

  const response = confirmPage(name, returnTo, state);
  response.headers.append('Set-Cookie', browserCookie(url, state, browser, STATE_TTL_MS / 1000));
  return response;
}

/**
 * POST /auth/login, form `state` and `decision`: the owner's answer on the
 * confirmation page. Allow goes on to Spotify; Cancel ends the sign-in.
 *
 * Only the browser that was shown the page can answer it: the state is in the
 * page alone, and the cookie set with it must come back. The same cookie is
 * checked again when Spotify redirects back, so a sign-in started by one
 * client and finished in someone else's browser goes nowhere.
 */
export async function signInConfirm(env: Env, request: Request, url: URL): Promise<Response> {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  const origin = request.headers.get('Origin');
  if ((fetchSite && fetchSite !== 'same-origin') || (origin && origin !== url.origin)) {
    return page('Sign-in failed', '<p>That answer did not come from this warehouse’s own page.</p>', 403);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return page('Sign-in failed', '<p>Expected a form. Start again.</p>', 400);
  }
  const state = form.get('state');
  const decision = form.get('decision');
  if (typeof state !== 'string' || (decision !== 'allow' && decision !== 'cancel')) {
    return page('Sign-in failed', '<p>Expected a state and a decision. Start again.</p>', 400);
  }

  const pending = await env.DB.prepare(
    'SELECT created_ms, return_to, browser_hash, confirmed_ms FROM login_state WHERE state = ?',
  )
    .bind(state)
    .first<{ created_ms: number; return_to: string | null; browser_hash: string | null; confirmed_ms: number | null }>();
  if (
    !pending ||
    pending.confirmed_ms !== null ||
    Date.now() - pending.created_ms > STATE_TTL_MS ||
    !(await sameBrowser(request, url, state, pending.browser_hash))
  ) {
    return page('Sign-in failed', `<p>${STALE}</p>`, 400);
  }

  if (decision === 'cancel') {
    await env.DB.prepare('DELETE FROM login_state WHERE state = ?').bind(state).run();
    const response = pending.return_to
      ? backTo(pending.return_to, { error: 'access_denied' })
      : page('Sign-in cancelled', '<p>No token was made. You can close this page.</p>');
    response.headers.append('Set-Cookie', browserCookie(url, state, '', 0));
    return response;
  }

  const confirmed = await env.DB.prepare(
    'UPDATE login_state SET confirmed_ms = ? WHERE state = ? AND confirmed_ms IS NULL',
  )
    .bind(Date.now(), state)
    .run();
  if (!confirmed.meta.changes) return page('Sign-in failed', `<p>${STALE}</p>`, 400);

  // show_dialog: an account that already approved this app would otherwise
  // pass straight through Spotify, and the owner would never see it.
  const location = authorizeUrl(env, state, { redirectUri: signInRedirectUri(env), scope: '', showDialog: true });
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

/** `return_to` with query parameters added, for handing a code or an error back to the app. */
function backTo(returnTo: string, params: Record<string, string>): Response {
  const target = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: target.href, 'Cache-Control': 'no-store' } });
}

/** GET /auth/callback: Spotify's redirect target for sign-in. */
export async function signInCallback(env: Env, request: Request, url: URL): Promise<Response> {
  const state = url.searchParams.get('state');
  if (!state) return page('Sign-in failed', '<p>Missing state. Start again.</p>', 400);
  const response = await finishSignIn(env, request, url, state);
  response.headers.append('Set-Cookie', browserCookie(url, state, '', 0));
  return response;
}

async function finishSignIn(env: Env, request: Request, url: URL, state: string): Promise<Response> {
  // Single use: consumed before anything else, whatever happens next.
  const pending = await env.DB.prepare(
    'DELETE FROM login_state WHERE state = ? ' +
      'RETURNING created_ms, device_name, return_to, code_challenge, browser_hash, confirmed_ms',
  )
    .bind(state)
    .first<{
      created_ms: number;
      device_name: string;
      return_to: string | null;
      code_challenge: string | null;
      browser_hash: string | null;
      confirmed_ms: number | null;
    }>();
  if (!pending || Date.now() - pending.created_ms > STATE_TTL_MS) {
    return page('Sign-in failed', `<p>${STALE}</p>`, 400);
  }

  const fail = (error: string, message: string, status: number) =>
    pending.return_to ? backTo(pending.return_to, { error }) : page('Sign-in failed', `<p>${message}</p>`, status);

  // Never confirmed on the warehouse's page, or finished in a browser other
  // than the one that confirmed it: someone else's sign-in, so nothing to give.
  if (pending.confirmed_ms === null || !(await sameBrowser(request, url, state, pending.browser_hash))) {
    return fail('access_denied', STALE, 400);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    // Spotify's own error code when it looks like one, never free text.
    const error = url.searchParams.get('error');
    const known = error && /^[a-z_]{1,64}$/.test(error) ? error : 'access_denied';
    return fail(known, 'Spotify did not approve the sign-in.', 400);
  }

  let signedIn: string;
  let owner: string | null;
  try {
    const identity = await exchangeCode(env, code, signInRedirectUri(env));
    const me = (await spotifyGet({ db: env.DB, source: 'signin' }, identity.access_token, '/me')) as { id?: string } | null;
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

/** Inline styles only: no scripts, no frames, nothing fetched. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** `body` is HTML: escape anything in it that came from a request. */
function page(title: string, body: string, status = 200, csp = PAGE_CSP, referrer = 'no-referrer'): Response {
  const html =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}` +
    `code{display:block;word-break:break-all;padding:1rem;background:#8882;border-radius:.5rem}` +
    `button{font:inherit;padding:.5rem 1.25rem;margin-right:.5rem;border-radius:.5rem;border:1px solid #8888;cursor:pointer}` +
    `button[value=allow]{background:#1db954;border-color:#1db954;color:#000}</style>` +
    `<h1>${escapeHtml(title)}</h1>${body}`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': csp,
      'Referrer-Policy': referrer,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * The warehouse's own question, asked before Spotify's: who is asking, and
 * where the token will go. Spotify's page names only the warehouse, so this is
 * the one place the owner sees `return_to` before saying yes.
 */
function confirmPage(name: string, returnTo: string | null, state: string): Response {
  const where = returnTo
    ? `<p>It will be handed to:</p><code>${escapeHtml(returnTo)}</code>` +
      `<p>Allow only if you started signing in from that app just now.</p>`
    : `<p>It will be shown on a page in this browser, once.</p>`;
  const body =
    `<p><strong>${escapeHtml(name)}</strong> is asking for a read token for this warehouse. ` +
    `It can read your whole listening history for ${DEFAULT_TOKEN_TTL_DAYS} days.</p>` +
    where +
    `<p>Spotify will ask you to confirm it is you next.</p>` +
    `<form method="post" action="/auth/login">` +
    `<input type="hidden" name="state" value="${escapeHtml(state)}">` +
    `<button type="submit" name="decision" value="allow">Allow</button>` +
    `<button type="submit" name="decision" value="cancel">Cancel</button></form>`;
  // The form posts here, and its answer redirects on to Spotify, or back to
  // return_to on Cancel; browsers hold redirects after a form to form-action.
  // The page's own origin is sent with the post (`same-origin`), and nothing
  // is sent to Spotify.
  const targets = ["'self'", 'https://accounts.spotify.com'];
  if (returnTo) targets.push(returnToSource(new URL(returnTo)));
  const csp = PAGE_CSP.replace("form-action 'none'", `form-action ${targets.join(' ')}`);
  return page('Allow sign-in?', body, 200, csp, 'same-origin');
}

/** `return_to` as a CSP source: its origin, or a custom scheme on its own. */
function returnToSource(returnTo: URL): string {
  return returnTo.protocol === 'http:' || returnTo.protocol === 'https:' ? returnTo.origin : returnTo.protocol;
}

/**
 * The cookie that ties a sign-in to the browser that confirmed it, one per
 * sign-in so two at once do not clash. `__Host-` and Secure wherever the
 * warehouse is on HTTPS; `wrangler dev` on plain HTTP gets neither. Lax, not
 * Strict: Spotify's redirect back is a cross-site navigation, and Strict
 * would leave the cookie behind.
 */
function browserCookie(url: URL, state: string, value: string, maxAgeSeconds: number): string {
  const secure = url.protocol === 'https:';
  return (
    `${cookieName(url, state)}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax` +
    (secure ? '; Secure' : '')
  );
}

function cookieName(url: URL, state: string): string {
  return `${url.protocol === 'https:' ? '__Host-' : ''}mw_signin_${state.slice(0, 16)}`;
}

/** Whether the request carries the cookie this sign-in was confirmed with. */
async function sameBrowser(request: Request, url: URL, state: string, browserHash: string | null): Promise<boolean> {
  if (!browserHash) return false;
  const name = cookieName(url, state);
  const value = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return !!value && (await sha256Hex(value)) === browserHash;
}

function tokenPage(name: string, token: string, expiresMs: number): Response {
  return page(
    'Signed in',
    `<p>A read token for <strong>${escapeHtml(name)}</strong>, valid until ` +
      `${new Date(expiresMs).toISOString().slice(0, 10)}. It is shown only once.</p><code>${escapeHtml(token)}</code>`,
  );
}
