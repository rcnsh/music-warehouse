import { SpotifyError, type TokenResponse, authorizeUrl, exchangeCode } from './spotify';
import { spotifyClient } from './spotify-client';
import { persistTokenResponse } from './tokens';
import { recordOwner } from './signin';
import type { Env } from './types';
import { log } from './log';

/**
 * The owner's Spotify grant: GET /login starts it and GET /callback, where
 * Spotify sends the owner back, stores it. Sign-in for devices is signin.ts.
 */

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    // nosniff: a browser must never read this as anything but text.
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

/**
 * Begin authorization. Returns a 302 whose Location is Spotify's consent page.
 *
 * This route is bearer-authenticated like every other, which means it is driven
 * with curl rather than opened directly in a browser — the admin token stays in
 * a header instead of a URL. See README, "Authorizing".
 */
export async function login(env: Env): Promise<Response> {
  const state = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO oauth_state (id, state, created_ms) VALUES (1, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET state = excluded.state, created_ms = excluded.created_ms',
  )
    .bind(state, Date.now())
    .run();

  return new Response(null, { status: 302, headers: { Location: authorizeUrl(env, state) } });
}

/** OAuth redirect target. Unauthenticated by necessity — the `state` value is what proves provenance. */
export async function callback(env: Env, url: URL): Promise<Response> {
  // Spotify's error is a short code such as `access_denied`. Anything else in
  // the query string is someone else's text, and is not repeated back.
  const error = url.searchParams.get('error');
  if (error) return text(`Spotify refused authorization: ${/^[a-z_]{1,64}$/.test(error) ? error : 'unknown'}`, 400);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return text('Missing code or state.', 400);

  const stored = await env.DB.prepare('SELECT state, created_ms FROM oauth_state WHERE id = 1').first<{
    state: string;
    created_ms: number;
  }>();

  if (!stored || stored.state !== state) return text('State mismatch. Start again at /login.', 400);
  if (Date.now() - stored.created_ms > 10 * 60 * 1000) {
    return text('Authorization request expired. Start again at /login.', 400);
  }

  // Single use: consume the state before spending the code.
  await env.DB.prepare('DELETE FROM oauth_state WHERE id = 1').run();

  let token: TokenResponse;
  try {
    token = await exchangeCode(env, code);
    // A fresh authorization restarts the six-month refresh-token clock.
    await persistTokenResponse(env.DB, token, Date.now(), { resetAuthorizedAt: true });
  } catch (cause) {
    // The message can hold Spotify's response body: the log gets it, the page
    // does not.
    log('callback-token-exchange-failed', { error: cause instanceof SpotifyError ? cause.message : cause }, 'error');
    return text('Token exchange with Spotify failed; the Worker log has the details. Start again at /login.', 502);
  }

  // Whose warehouse this is, for sign-in. Not worth failing the grant over:
  // sign-in asks again with the stored grant if it is missing.
  try {
    await recordOwner(env.DB, spotifyClient(env, 'signin', { auth: { accessToken: token.access_token } }));
  } catch (cause) {
    log('owner-error', { error: cause instanceof Error ? cause.message : cause }, 'error');
  }

  return text('Authorized. Ingestion will resume on the next cron tick; POST /admin/poll to start now.');
}
