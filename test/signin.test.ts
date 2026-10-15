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

async function start(params: Record<string, string>) {
  const response = await SELF.fetch(`${BASE}/auth/login?${new URLSearchParams(params)}`, { redirect: 'manual' });
  return response;
}

/** /auth/login then Spotify's redirect back to /auth/callback. Returns the callback response. */
async function signIn(params: Record<string, string>, callbackParams: Record<string, string> = { code: 'spotify-code' }) {
  const started = await start(params);
  expect(started.status).toBe(302);
  const state = new URL(started.headers.get('Location')!).searchParams.get('state')!;
  return SELF.fetch(`${BASE}/auth/callback?${new URLSearchParams({ ...callbackParams, state })}`, { redirect: 'manual' });
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

  it('asks Spotify for identity only, on its own redirect URI', async () => {
    const { challenge } = await pkce();
    const response = await start({ name: 'iPhone', return_to: WRAPPED, code_challenge: challenge });
    const location = new URL(response.headers.get('Location')!);

    expect(location.origin + location.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(location.searchParams.has('scope')).toBe(false);
    expect(location.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/auth/callback');
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

  it('caps sign-ins in flight', async () => {
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 50 }, (_, i) =>
        env.DB.prepare('INSERT INTO login_state (state, created_ms, device_name) VALUES (?, ?, ?)').bind(`s${i}`, now, 'x'),
      ),
    );
    expect((await start({ name: 'iPhone' })).status).toBe(429);
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
    const started = await start({ name: 'laptop' });
    const state = new URL(started.headers.get('Location')!).searchParams.get('state')!;
    await SELF.fetch(`${BASE}/auth/callback?code=c&state=${state}`);
    const again = await SELF.fetch(`${BASE}/auth/callback?code=c&state=${state}`);
    expect(again.status).toBe(400);
    expect(await tokenCount()).toBe(1);
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
