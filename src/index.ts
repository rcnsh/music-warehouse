import { BadRequest, dailyCounts, json, recentPlays, topArtists } from './api';
import { backfillAlbums } from './albums';
import { health } from './health';
import { importChunk } from './import';
import { poll } from './ingest';
import { alertCheckRoute, runAlertCheck } from './alerts';
import { nowPlaying, topMusic } from './live';
import { SpotifyError, authorizeUrl, exchangeCode, fetchRecentlyPlayed } from './spotify';
import { NeedsReauthError, getAccessToken, persistTokenResponse } from './tokens';
import { readState } from './db';
import type { Env } from './types';

/** The cron expression reserved for the alert sweep; everything else polls. */
const ALERT_CRON = '0 9 * * *';

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

/**
 * Access level of the presented bearer token (R11).
 *
 * `admin` unlocks everything. `read` unlocks the /api/* routes only, so a
 * website can render listening data without holding a credential that could
 * also trigger a poll or write rows. Every route still requires one or the
 * other; /callback is the sole exception, and the OAuth `state` guards it.
 */
type Access = 'admin' | 'read';

async function accessFor(request: Request, env: Env): Promise<Access | null> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const presented = match[1]!;

  if (env.ADMIN_TOKEN && (await secretsMatch(presented, env.ADMIN_TOKEN))) return 'admin';
  if (env.READ_TOKEN && (await secretsMatch(presented, env.READ_TOKEN))) return 'read';
  return null;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/**
 * Begin authorization. Returns a 302 whose Location is Spotify's consent page.
 *
 * This route is bearer-authenticated like every other, which means it is driven
 * with curl rather than opened directly in a browser — the admin token stays in
 * a header instead of a URL. See README, "Authorizing".
 */
async function login(env: Env): Promise<Response> {
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
async function callback(env: Env, url: URL): Promise<Response> {
  const error = url.searchParams.get('error');
  if (error) return text(`Spotify refused authorization: ${error}`, 400);

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

  try {
    const token = await exchangeCode(env, code);
    // A fresh authorization restarts the six-month refresh-token clock.
    await persistTokenResponse(env.DB, token, Date.now(), { resetAuthorizedAt: true });
  } catch (cause) {
    const message = cause instanceof SpotifyError ? cause.message : String(cause);
    return text(`Token exchange failed: ${message}`, 502);
  }

  return text('Authorized. Ingestion will resume on the next cron tick; POST /admin/poll to start now.');
}

/**
 * The unmodified upstream payload, for capturing fixtures and for diagnosing a
 * shape change if Spotify alters the response. Read-only: it never touches the
 * cursor or sync_state, so it cannot disturb ingestion.
 */
async function rawRecentlyPlayed(env: Env, url: URL): Promise<Response> {
  const { token } = await readState(env.DB);
  const accessToken = await getAccessToken(env.DB, env, token, Date.now());
  const after = Number(url.searchParams.get('after') ?? 0);
  const payload = await fetchRecentlyPlayed(accessToken, Number.isFinite(after) ? after : 0);
  return json(payload);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/callback') return await callback(env, url);

    const access = await accessFor(request, env);
    if (access === null) return unauthorized();

    const route = `${request.method} ${path}`;
    // A read-only token reaches the data routes and nothing else.
    if (access === 'read' && !path.startsWith('/api/')) return unauthorized();

    try {
      switch (route) {
        case 'GET /':
          return json({
            service: 'music-warehouse',
            routes: [
              '/login',
              '/callback',
              '/health',
              '/api/plays',
              '/api/top-artists',
              '/api/daily',
              '/api/now-playing',
              '/api/top',
              '/admin/poll',
              '/admin/alert-check',
              '/admin/import',
              '/admin/backfill-albums',
              '/admin/raw',
            ],
          });
        case 'GET /login':
          return await login(env);
        case 'GET /health':
          return await health(env);
        case 'GET /api/plays':
          return await recentPlays(env, url);
        case 'GET /api/top-artists':
          return await topArtists(env, url);
        case 'GET /api/daily':
          return await dailyCounts(env, url);
        case 'GET /api/now-playing':
          return await nowPlaying(env);
        case 'GET /api/top':
          return await topMusic(env, url);
        case 'POST /admin/poll':
          return json(await poll(env));
        case 'POST /admin/alert-check':
          return await alertCheckRoute(env, url);
        case 'POST /admin/import':
          return await importChunk(env, request);
        case 'POST /admin/backfill-albums':
          return await backfillAlbums(env, request);
        case 'GET /admin/raw':
          return await rawRecentlyPlayed(env, url);
        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      // The live proxy routes depend on a working Spotify grant, unlike the
      // stored-data routes. Say which of the two failed rather than a blank 500.
      if (error instanceof NeedsReauthError) {
        return json({ error: 'Spotify connection needs re-authorization.', needs_reauth: true }, 503);
      }
      if (error instanceof SpotifyError) {
        // The client only ever sees the error *kind*, so without this an
        // upstream failure is undiagnosable after the fact.
        console.error('spotify', error.kind, error.status, error.message);
        const status = error.kind === 'rate_limited' || error.kind === 'quota_exceeded' ? 429 : 502;
        return json(
          { error: `Spotify upstream: ${error.kind}`, retry_after_seconds: error.retryAfterSeconds },
          status,
        );
      }
      console.error('Unhandled error', error);
      return json({ error: 'Internal error' }, 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // The daily alert sweep shares the scheduled handler, dispatched on which
    // cron expression fired.
    if (event.cron === ALERT_CRON) {
      ctx.waitUntil(
        runAlertCheck(env)
          .then((result) => {
            console.log('alert-check', JSON.stringify(result));
          })
          .catch((error) => {
            console.error('alert-check failed', error);
          }),
      );
      return;
    }

    // Same code path as POST /admin/poll, so the manual route really does
    // exercise what the cron does.
    ctx.waitUntil(
      poll(env)
        .then((result) => {
          console.log('poll', JSON.stringify(result));
        })
        .catch((error) => {
          // Reaching here means D1 itself is unavailable — most likely the free
          // plan's daily row limit, which resets at 00:00 UTC. The cursor never
          // advanced, so the next run recovers on its own.
          console.error('poll failed before any state could be recorded', error);
        }),
    );
  },
} satisfies ExportedHandler<Env>;

export default worker;
