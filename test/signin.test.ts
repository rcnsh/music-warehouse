import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64url, randomSecret } from '../src/auth';
import { jsonResponse, oauthToken, seedAuthorized } from './helpers';

const BASE = 'https://warehouse.test';
const WRAPPED = 'https://wrapped.test';
const OWNER = 'owner-spotify-id';

/**
 * Spotify, as far as sign-in sees it. The token endpoint hands out an identity
 * token; /v1/me answers per access token, so the identity token and the stored
 * ingestion grant can belong to different accounts.
 */
function stubSpotify(options: { signedInAs?: string; ownerViaGrant?: string } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(url.href);
      if (url.href === 'https://accounts.spotify.com/api/token') {
        return jsonResponse({ access_token: 'identity-token', token_type: 'Bearer', expires_in: 3600 });
      }
      if (url.href === 'https://api.spotify.com/v1/me') {
        const auth = new Headers(init?.headers).get('Authorization');
        if (auth === 'Bearer identity-token') return jsonResponse({ id: options.signedInAs ?? OWNER });
        if (auth === 'Bearer live-access-token') return jsonResponse({ id: options.ownerViaGrant ?? OWNER });
      }
      return new Response('unexpected', { status: 500 });
    }),
  );
  return calls;
}

async function pkce() {
  const verifier = randomSecret(48);
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function start(params: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await SELF.fetch(`${BASE}/auth/login?${new URLSearchParams(params)}`, { redirect: 'manual', headers });
  return response;
}

/** What a browser keeps from the confirmation page: the form's state and the cookie set with it. */
async function confirmation(page: Response) {
  expect(page.status).toBe(200);
  const html = await page.text();
  const state = /name="state" value="([^"]+)"/.exec(html)![1]!;
  const cookie = page.headers.get('Set-Cookie')!.split(';')[0]!;
  return { html, state, cookie };
}

/** Press a button on the confirmation page, as the browser that was shown it. */
function answer(
  state: string,
  cookie: string | null,
  decision = 'allow',
  headers: Record<string, string> = { Origin: BASE, 'Sec-Fetch-Site': 'same-origin' },
) {
  return SELF.fetch(`${BASE}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: new URLSearchParams({ state, decision }),
  });
}

/** /auth/login, Allow, then Spotify's redirect back to /auth/callback. Returns the callback response. */
async function signIn(params: Record<string, string>, callbackParams: Record<string, string> = { code: 'spotify-code' }) {
  const { state, cookie } = await confirmation(await start(params));
  const allowed = await answer(state, cookie);
  expect(allowed.status).toBe(303);
  expect(new URL(allowed.headers.get('Location')!).searchParams.get('state')).toBe(state);
  return SELF.fetch(`${BASE}/auth/callback?${new URLSearchParams({ ...callbackParams, state })}`, {
    redirect: 'manual',
    headers: { Cookie: cookie },
  });
}

function exchange(body: Record<string, unknown>, origin = WRAPPED) {
  return SELF.fetch(`${BASE}/auth/token`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function ownerSet(id = OWNER) {
  await seedAuthorized();
  await env.DB.prepare('UPDATE oauth_token SET spotify_user_id = ? WHERE id = 1').bind(id).run();
}

async function tokenCount() {
  return (await env.DB.prepare('SELECT COUNT(*) n FROM api_tokens').first<{ n: number }>())!.n;
}

beforeEach(() => {
  stubSpotify();
});
afterEach(() => vi.unstubAllGlobals());

describe('sign in with Spotify, from an app', () => {
  it('hands the app a one-time code that exchanges for a read token', async () => {
    await ownerSet();
    const { verifier, challenge } = await pkce();

    const callback = await signIn({ name: 'iPhone', return_to: `${WRAPPED}/signin?x=1`, code_challenge: challenge });
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(`${WRAPPED}/signin`);
    expect(location.searchParams.get('x')).toBe('1');
    const code = location.searchParams.get('code')!;
    expect(code).toBeTruthy();

    const response = await exchange({ code, code_verifier: verifier });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(WRAPPED);
    const minted = (await response.json()) as { token: string; access: string; name: string };
    expect(minted).toMatchObject({ access: 'read', name: 'iPhone' });

    const auth = { Authorization: `Bearer ${minted.token}` };
    expect((await SELF.fetch(`${BASE}/api/plays`, { headers: auth })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/health`, { headers: auth })).status).toBe(401);

    const row = await env.DB.prepare('SELECT created_via FROM api_tokens').first<{ created_via: string }>();
    expect(row!.created_via).toBe('spotify');
  });

  it('asks Spotify for identity only, on its own redirect URI, and always with its dialog', async () => {
    const { challenge } = await pkce();
    const { state, cookie } = await confirmation(await start({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge }));
    const response = await answer(state, cookie);
    const location = new URL(response.headers.get('Location')!);

    expect(location.origin + location.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(location.searchParams.has('scope')).toBe(false);
    expect(location.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/auth/callback');
    expect(location.searchParams.get('show_dialog')).toBe('true');
  });

  it('never touches the ingestion grant', async () => {
    await ownerSet();
    const before = await oauthToken();
    const { challenge } = await pkce();
    await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    expect(await oauthToken()).toEqual(before);
  });

  it('refuses a Spotify account that does not own the warehouse', async () => {
    await ownerSet();
    stubSpotify({ signedInAs: 'someone-else' });
    const { challenge } = await pkce();

    const callback = await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    const location = new URL(callback.headers.get('Location')!);
    expect(location.searchParams.get('error')).toBe('not_owner');
    expect(location.searchParams.has('code')).toBe(false);
    expect(await tokenCount()).toBe(0);
  });

  it('learns the owner from the stored grant when it was never recorded', async () => {
    await seedAuthorized();
    const { challenge } = await pkce();

    const callback = await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    expect(new URL(callback.headers.get('Location')!).searchParams.has('code')).toBe(true);
    const row = await env.DB.prepare('SELECT spotify_user_id FROM oauth_token WHERE id = 1').first<{ spotify_user_id: string }>();
    expect(row!.spotify_user_id).toBe(OWNER);
  });

  it('refuses everyone before ingestion is authorized', async () => {
    const { challenge } = await pkce();
    const callback = await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    expect(new URL(callback.headers.get('Location')!).searchParams.get('error')).toBe('unavailable');
  });

  it('passes a refusal at Spotify back to the app', async () => {
    const { challenge } = await pkce();
    const callback = await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge }, { error: 'access_denied' });
    expect(new URL(callback.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('spends a code on its first exchange, even a failed one', async () => {
    await ownerSet();
    const { verifier, challenge } = await pkce();
    const callback = await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    const code = new URL(callback.headers.get('Location')!).searchParams.get('code')!;

    expect((await exchange({ code, code_verifier: randomSecret(48) })).status).toBe(400);
    expect((await exchange({ code, code_verifier: verifier })).status).toBe(400);
    expect(await tokenCount()).toBe(0);
  });

  it('cannot exchange a code twice', async () => {
    await ownerSet();
    const { verifier, challenge } = await pkce();
    const callback = await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    const code = new URL(callback.headers.get('Location')!).searchParams.get('code')!;

    expect((await exchange({ code, code_verifier: verifier })).status).toBe(200);
    const again = await exchange({ code, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'invalid_grant' });
  });

  it('only exchanges from the origin that started the sign-in', async () => {
    await ownerSet();
    const { verifier, challenge } = await pkce();
    const callback = await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    const code = new URL(callback.headers.get('Location')!).searchParams.get('code')!;

    expect((await exchange({ code, code_verifier: verifier }, 'https://other.test')).status).toBe(400);
  });

  it('does not exchange a code older than a minute', async () => {
    await ownerSet();
    const { verifier, challenge } = await pkce();
    const callback = await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    const code = new URL(callback.headers.get('Location')!).searchParams.get('code')!;
    await env.DB.prepare('UPDATE login_codes SET created_ms = ?').bind(Date.now() - 61_000).run();

    expect((await exchange({ code, code_verifier: verifier })).status).toBe(400);
  });

  it('answers the exchange preflight from a listed origin', async () => {
    const response = await SELF.fetch(`${BASE}/auth/token`, {
      method: 'OPTIONS',
      headers: { Origin: WRAPPED, 'Access-Control-Request-Method': 'POST' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
  });

  it.each([
    [{ name: 'iPhone', return_to: 'https://evil.test/', code_challenge: 'x'.repeat(43) }],
    [{ name: 'iPhone', return_to: 'not a url', code_challenge: 'x'.repeat(43) }],
    [{ name: 'iPhone', return_to: WRAPPED }],
    [{ name: 'iPhone', return_to: WRAPPED, code_challenge: 'short' }],
    [{ name: 'iPhone', return_to: WRAPPED, code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' }],
    [{ return_to: WRAPPED, code_challenge: 'x'.repeat(43) }],
  ])('refuses to start %j', async (params) => {
    expect((await start(params)).status).toBe(400);
  });

  it('caps sign-ins in flight across every client', async () => {
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 200 }, (_, i) =>
        env.DB.prepare('INSERT INTO login_state (state, created_ms, device_name, client_hash) VALUES (?, ?, ?, ?)').bind(
          `s${i}`,
          now,
          'x',
          `client-${i}`,
        ),
      ),
    );
    expect((await start({ name: 'iPhone' }, { 'CF-Connecting-IP': '198.51.100.7' })).status).toBe(429);
  });

  it('caps the sign-ins one client may hold, without locking out anyone else', async () => {
    const stranger = { 'CF-Connecting-IP': '203.0.113.9' };
    for (let i = 0; i < 10; i += 1) expect((await start({ name: 'spam' }, stranger)).status).toBe(200);
    expect((await start({ name: 'spam' }, stranger)).status).toBe(429);
    // Elsewhere in the same IPv6 /64 counts as the same client.
    const v6 = (host: string) => ({ 'CF-Connecting-IP': `2001:db8:1:2::${host}` });
    for (let i = 0; i < 10; i += 1) expect((await start({ name: 'spam' }, v6(String(i + 1)))).status).toBe(200);
    expect((await start({ name: 'spam' }, v6('ffff'))).status).toBe(429);

    expect((await start({ name: 'iPhone' }, { 'CF-Connecting-IP': '198.51.100.7' })).status).toBe(200);
  });

  it('stores a hash of the client address, never the address', async () => {
    await start({ name: 'iPhone' }, { 'CF-Connecting-IP': '198.51.100.7' });
    const rows = await env.DB.prepare('SELECT * FROM login_state').all();
    expect(JSON.stringify(rows.results)).not.toContain('198.51.100');
    expect((rows.results[0] as { client_hash: string }).client_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sign in with Spotify, from a native app', () => {
  /** Run a sign-in to `returnTo` and return the code handed back, plus the verifier. */
  async function codeFor(returnTo: string) {
    await ownerSet();
    const { verifier, challenge } = await pkce();
    const callback = await signIn({ name: 'native', return_to: returnTo, code_challenge: challenge });
    const location = new URL(callback.headers.get('Location')!);
    return { location, code: location.searchParams.get('code')!, verifier };
  }

  /** As a native app sends it: no Origin header. */
  function nativeExchange(body: Record<string, unknown>) {
    return SELF.fetch(`${BASE}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it.each(['http://127.0.0.1:53682/done', 'http://[::1]:8000/', 'app.test://warehouse-auth'])(
    'hands a code to %s, exchangeable without an Origin',
    async (returnTo) => {
      const { location, code, verifier } = await codeFor(returnTo);
      expect(location.href.startsWith(returnTo.replace(/\/$/, ''))).toBe(true);
      const response = await nativeExchange({ code, code_verifier: verifier });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { access: string }).access).toBe('read');
    },
  );

  it('still needs the verifier', async () => {
    const { code } = await codeFor('http://127.0.0.1:53682/');
    expect((await nativeExchange({ code, code_verifier: randomSecret(48) })).status).toBe(400);
  });

  it('still requires the Origin for a web return_to', async () => {
    await ownerSet();
    const { verifier, challenge } = await pkce();
    const callback = await signIn({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    const code = new URL(callback.headers.get('Location')!).searchParams.get('code')!;
    expect((await nativeExchange({ code, code_verifier: verifier })).status).toBe(400);
  });

  it.each([
    'http://localhost:53682/',
    'http://127.0.0.2:53682/',
    'https://127.0.0.1:53682/',
    'evil.app://warehouse-auth',
    'javascript://alert(1)',
  ])('refuses %s as a return_to', async (returnTo) => {
    const { challenge } = await pkce();
    expect((await start({ name: 'native', return_to: returnTo, code_challenge: challenge })).status).toBe(400);
  });
});

describe('sign in with Spotify, for a shell', () => {
  it('shows the token once on a page when there is no return_to', async () => {
    await ownerSet();
    const callback = await signIn({ name: 'laptop <script>' });

    expect(callback.status).toBe(200);
    expect(callback.headers.get('Content-Type')).toContain('text/html');
    expect(callback.headers.get('Cache-Control')).toBe('no-store');
    const html = await callback.text();
    expect(html).not.toContain('<script>');
    const token = /mw_[A-Za-z0-9_-]{43}/.exec(html)![0];
    expect((await SELF.fetch(`${BASE}/api/plays`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('refuses a state that was already used', async () => {
    await ownerSet();
    const { state, cookie } = await confirmation(await start({ name: 'laptop' }));
    await answer(state, cookie);
    const first = await SELF.fetch(`${BASE}/auth/callback?code=c&state=${state}`, { headers: { Cookie: cookie } });
    expect(first.status).toBe(200);
    const again = await SELF.fetch(`${BASE}/auth/callback?code=c&state=${state}`, { headers: { Cookie: cookie } });
    expect(again.status).toBe(400);
    expect(await tokenCount()).toBe(1);
  });
});

describe('sign-in confirmation', () => {
  it('names the client and where its token goes before anything is sent to Spotify', async () => {
    const calls = stubSpotify();
    const { challenge } = await pkce();
    const page = await start({ name: 'Remastered <b>', return_to: 'http://127.0.0.1:53682/done', code_challenge: challenge });

    expect(page.headers.get('Location')).toBeNull();
    expect(page.headers.get('Content-Type')).toContain('text/html');
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(page.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const csp = page.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://accounts.spotify.com http://127.0.0.1:53682");
    expect(csp).not.toContain('script-src');
    const cookie = page.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(/^__Host-mw_signin_[A-Za-z0-9_-]{16}=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);

    const { html } = await confirmation(page);
    expect(html).toContain('Remastered &#60;b&#62;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('http://127.0.0.1:53682/done');
    expect(html).toMatch(/<form method="post" action="\/auth\/login">/);
    expect(calls).toEqual([]);
  });

  it('lets a custom scheme be the form target', async () => {
    const { challenge } = await pkce();
    const page = await start({ name: 'Android', return_to: 'app.test://warehouse-auth', code_challenge: challenge });
    expect(page.headers.get('Content-Security-Policy')).toContain('https://accounts.spotify.com app.test:');
  });

  it('hands nothing out for a sign-in that skipped the page', async () => {
    await ownerSet();
    const { challenge } = await pkce();
    const { state, cookie } = await confirmation(
      await start({ name: 'iPhone', return_to: 'http://127.0.0.1:53682/', code_challenge: challenge }),
    );
    // Straight to Spotify with the state, never pressing Allow.
    const callback = await SELF.fetch(`${BASE}/auth/callback?code=c&state=${state}`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    expect(new URL(callback.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM login_codes').first('n')).toBe(0);
  });

  it('hands nothing out when Spotify redirects back to a different browser', async () => {
    await ownerSet();
    const { challenge } = await pkce();
    const { state, cookie } = await confirmation(
      await start({ name: 'iPhone', return_to: 'http://127.0.0.1:53682/', code_challenge: challenge }),
    );
    expect((await answer(state, cookie)).status).toBe(303);
    const elsewhere = await SELF.fetch(`${BASE}/auth/callback?code=c&state=${state}`, { redirect: 'manual' });
    expect(new URL(elsewhere.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM login_codes').first('n')).toBe(0);
  });

  it('only takes the answer from the browser that was shown the page', async () => {
    const { state, cookie } = await confirmation(await start({ name: 'laptop' }));
    expect((await answer(state, null)).status).toBe(400);
    expect((await answer(state, `${cookie.split('=')[0]}=${randomSecret()}`)).status).toBe(400);
    expect((await answer(state, cookie)).status).toBe(303);
    // And only once.
    expect((await answer(state, cookie)).status).toBe(400);
  });

  it.each([
    [{ Origin: 'https://evil.test' }],
    [{ 'Sec-Fetch-Site': 'cross-site' }],
    [{ Origin: BASE, 'Sec-Fetch-Site': 'same-site' }],
  ])('refuses an answer posted from another site: %j', async (headers) => {
    const { state, cookie } = await confirmation(await start({ name: 'laptop' }));
    expect((await answer(state, cookie, 'allow', headers)).status).toBe(403);
    expect((await answer(state, cookie)).status).toBe(303);
  });

  it('sends Cancel back to the app as access_denied, and ends the sign-in', async () => {
    const { challenge } = await pkce();
    const { state, cookie } = await confirmation(
      await start({ name: 'iPhone', return_to: 'http://127.0.0.1:53682/done', code_challenge: challenge }),
    );
    const cancelled = await answer(state, cookie, 'cancel');
    expect(cancelled.status).toBe(302);
    const location = new URL(cancelled.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe('http://127.0.0.1:53682/done');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(cancelled.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM login_state').first('n')).toBe(0);
  });

  it('shows Cancel as a page when there is no app to go back to', async () => {
    const { state, cookie } = await confirmation(await start({ name: 'laptop' }));
    const cancelled = await answer(state, cookie, 'cancel');
    expect(cancelled.status).toBe(200);
    expect(await cancelled.text()).toContain('No token was made');
  });

  it('refuses an answer that is not a form with a known decision', async () => {
    const { state, cookie } = await confirmation(await start({ name: 'laptop' }));
    expect((await answer(state, cookie, 'maybe')).status).toBe(400);
    const notForm = await SELF.fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ state, decision: 'allow' }),
    });
    expect(notForm.status).toBe(400);
  });

  it('clears the browser cookie once Spotify redirects back', async () => {
    await ownerSet();
    const callback = await signIn({ name: 'laptop' });
    expect(callback.headers.get('Set-Cookie')).toMatch(/^__Host-mw_signin_[A-Za-z0-9_-]{16}=; Path=\/; Max-Age=0;/);
  });

  it('passes on only an error code from Spotify, never free text', async () => {
    const { challenge } = await pkce();
    const callback = await signIn(
      { name: 'iPhone', return_to: WRAPPED, code_challenge: challenge },
      { error: '<script>alert(1)</script>' },
    );
    expect(new URL(callback.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
  });
});

describe('sign-in rate limiting', () => {
  it('limits each client address once the binding is configured', async () => {
    const client = { 'CF-Connecting-IP': '192.0.2.44' };
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      statuses.push((await SELF.fetch(`${BASE}/auth/token`, { method: 'POST', headers: client, body: '{}' })).status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 400)).toBe(true);
    const limited = await SELF.fetch(`${BASE}/auth/token`, { method: 'POST', headers: client, body: '{}' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    // Someone else is unaffected.
    const other = await SELF.fetch(`${BASE}/auth/token`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '192.0.2.45' },
      body: '{}',
    });
    expect(other.status).toBe(400);
  });
});

describe('owner recording', () => {
  it('records the owner when ingestion is authorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith('https://accounts.spotify.com/api/token')) {
          return jsonResponse({ access_token: 'grant-token', refresh_token: 'r', expires_in: 3600 });
        }
        if (url === 'https://api.spotify.com/v1/me') return jsonResponse({ id: OWNER });
        return new Response('unexpected', { status: 500 });
      }),
    );
    const login = await SELF.fetch(`${BASE}/login`, { headers: { Authorization: 'Bearer test-admin-token' }, redirect: 'manual' });
    const state = new URL(login.headers.get('Location')!).searchParams.get('state')!;

    const response = await SELF.fetch(`${BASE}/callback?code=c&state=${state}`);
    expect(response.status).toBe(200);
    const row = await env.DB.prepare('SELECT spotify_user_id FROM oauth_token WHERE id = 1').first<{ spotify_user_id: string }>();
    expect(row!.spotify_user_id).toBe(OWNER);
  });
});
