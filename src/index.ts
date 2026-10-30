import { dailyCounts, json, recentPlays, topArtists } from './api';
import { errorResponse } from './errors';
import { callback, login } from './oauth';
import { backfillAlbums, backfillFromCatalog } from './albums';
import { health } from './health';
import { importChunk } from './import';
import { cleanupOverlapsRoute, cleanupShortGapsRoute, cleanupSkipsRoute } from './cleanup';
import { poll } from './ingest';
import { alertCheckRoute, runPollCron } from './alerts';
import { nowPlaying, play, recentlyPlayed, topMusic } from './live';
import { fetchRecentlyPlayed } from './spotify';
import { getAccessToken } from './tokens';
import { dailyTrackSweep, readState } from './db';
import { ensureRollup } from './rollup';
import { accessFor, clientKey, createTokenRoute, listTokensRoute, listedOrigins, revokeTokenRoute } from './auth';
import { isStatName, statRoute } from './stats';
import { artistRoute, cachedHistory, onThisDayRoute, topTracksRoute, trackRoute } from './history';
import { searchRoute } from './search';
import { homeRoute } from './home';
import { radioRoute } from './radio';
import { lyricsRoute } from './lyrics';
import { playsCsvRoute } from './export';
import {
  concertArtistsRoute,
  concertCheckRoute,
  concertsRoute,
  pinConcertArtistRoute,
  runConcertCheck,
} from './concerts';
import { signInCallback, signInConfirm, signInExchange, signInStart } from './signin';
import { warmWrappedPresets, wrappedRangesRoute, wrappedRoute } from './wrapped';
import type { Env } from './types';
import { log } from './log';

/** The cron expression reserved for the daily sweep; everything else polls. */
const DAILY_CRON = '0 9 * * *';
/** Its own invocation, so its Ticketmaster calls get a full subrequest budget. */
const CONCERT_CRON = '23 1 * * *';

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
  });
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
  const payload = await fetchRecentlyPlayed({ db: env.DB, source: 'admin' }, accessToken, Number.isFinite(after) ? after : 0);
  return json(payload);
}

/** Response headers a cross-origin reader of /api/* may see. */
const EXPOSED_HEADERS = 'Retry-After, X-Cache, X-Stats-Source, X-Stats-Computed-At, WWW-Authenticate';

/** The request's Origin, if CORS_ORIGINS lists it (or is `*`). */
function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = listedOrigins(env);
  return allowed.includes('*') || allowed.includes(origin) ? origin : null;
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const route = `${request.method} ${path}`;

  try {
    // Sign-in is open to anyone, so when the deployment has a rate limiter
    // bound, each client address gets a few requests a minute before D1 is
    // touched. Without the binding, the per-client cap in signin.ts still holds.
    if (path.startsWith('/auth/') && env.AUTH_RATE_LIMITER) {
      const key = await clientKey(request, env);
      if (key && !(await env.AUTH_RATE_LIMITER.limit({ key })).success) {
        const response = json({ error: 'Too many sign-in requests. Try again in a minute.' }, 429);
        response.headers.set('Retry-After', '60');
        return response;
      }
    }

    // Unauthenticated by necessity: Spotify's redirects carry no token, and
    // sign-in is how a device gets one. Each is guarded by its own single-use
    // state or code instead.
    switch (route) {
      case 'GET /callback':
        return await callback(env, url);
      case 'GET /auth/login':
        return await signInStart(env, request, url);
      case 'POST /auth/login':
        return await signInConfirm(env, request, url);
      case 'GET /auth/callback':
        return await signInCallback(env, request, url);
      case 'POST /auth/token':
        return await signInExchange(env, request);
    }

    const access = await accessFor(request, env, ctx);
    if (access === null) return unauthorized();
    // A read-only token reaches the data routes and nothing else; a control
    // token, playback alone.
    if (access === 'read' && !path.startsWith('/api/')) return unauthorized();
    if (access === 'control' && route !== 'POST /control/play') return unauthorized();

    switch (route) {
      case 'GET /':
        return json({
          service: 'music-warehouse',
          routes: [
            '/login',
            '/callback',
            '/auth/login',
            '/auth/callback',
            '/auth/token',
            '/health',
            '/api/plays',
            '/api/plays.csv',
            '/api/top-artists',
            '/api/top-tracks',
            '/api/daily',
            '/api/now-playing',
            '/api/recently-played',
            '/api/top',
            '/api/stats/{on-repeat,rhythm,top-over-time,eras,albums}',
            '/api/wrapped',
            '/api/wrapped/ranges',
            '/api/artist',
            '/api/track',
            '/api/on-this-day',
            '/api/home',
            '/api/radio',
            '/api/search',
            '/api/concerts',
            '/api/lyrics',
            '/control/play',
            '/admin/poll',
            '/admin/alert-check',
            '/admin/concert-check',
            '/admin/concert-artists',
            '/admin/import',
            '/admin/cleanup/{overlaps,skips,short-gaps}',
            '/admin/backfill-albums',
            '/admin/backfill-catalog',
            '/admin/raw',
            '/admin/rollup',
            '/admin/tokens',
          ],
        });
      case 'GET /login':
        return await login(env);
      case 'GET /health':
        return await health(env);
      case 'GET /api/plays':
        return await recentPlays(env, url);
      case 'GET /api/plays.csv':
        return await playsCsvRoute(env, url);
      case 'GET /api/top-artists':
        return await cachedHistory(env, url, () => topArtists(env, url));
      case 'GET /api/top-tracks':
        return await cachedHistory(env, url, () => topTracksRoute(env, url));
      case 'GET /api/daily':
        return await cachedHistory(env, url, () => dailyCounts(env, url));
      case 'GET /api/now-playing':
        return await nowPlaying(env, ctx);
      case 'GET /api/recently-played':
        return await recentlyPlayed(env, url, ctx);
      case 'GET /api/top':
        return await topMusic(env, url, ctx);
      case 'GET /api/wrapped':
        return await wrappedRoute(env, ctx, url, access);
      case 'GET /api/wrapped/ranges':
        return await wrappedRangesRoute(env);
      case 'GET /api/artist':
        return await cachedHistory(env, url, () => artistRoute(env, url));
      case 'GET /api/track':
        return await cachedHistory(env, url, () => trackRoute(env, url));
      case 'GET /api/on-this-day':
        return await cachedHistory(env, url, () => onThisDayRoute(env, url));
      case 'GET /api/home':
        return await homeRoute(env, ctx, url);
      case 'GET /api/radio':
        return await cachedHistory(env, url, () => radioRoute(env, url));
      case 'GET /api/concerts':
        return await concertsRoute(env, url);
      case 'GET /api/search':
        return await searchRoute(env, url);
      case 'GET /api/lyrics':
        return await lyricsRoute(env, url);
      case 'POST /control/play':
        return await play(env, request, ctx);
      case 'POST /admin/poll':
        return json(await poll(env));
      case 'GET /admin/concert-artists':
        return await concertArtistsRoute(env, url);
      case 'PUT /admin/concert-artists':
      case 'DELETE /admin/concert-artists':
        return await pinConcertArtistRoute(env, request);
      case 'POST /admin/concert-check':
        return await concertCheckRoute(env, url);
      case 'POST /admin/alert-check':
        return await alertCheckRoute(env, url);
      case 'POST /admin/import':
        return await importChunk(env, request);
      case 'POST /admin/cleanup/overlaps':
        return await cleanupOverlapsRoute(env, url);
      case 'POST /admin/cleanup/skips':
        return await cleanupSkipsRoute(env, request, url);
      case 'POST /admin/cleanup/short-gaps':
        return await cleanupShortGapsRoute(env, url);
      case 'POST /admin/backfill-albums':
        return await backfillAlbums(env, request);
      case 'POST /admin/backfill-catalog':
        return await backfillFromCatalog(env, request);
      case 'GET /admin/raw':
        return await rawRecentlyPlayed(env, url);
      case 'POST /admin/rollup':
        return json(await ensureRollup(env, { rebuild: url.searchParams.get('rebuild') === '1' }));
      case 'POST /admin/tokens':
        return await createTokenRoute(env, request);
      case 'GET /admin/tokens':
        return await listTokensRoute(env);
      case 'DELETE /admin/tokens':
        return await revokeTokenRoute(env, url);
      default: {
        const stat = /^GET \/api\/stats\/([a-z-]+)$/.exec(route)?.[1];
        if (stat && isStatName(stat)) return await statRoute(env, ctx, stat);
        return json({ error: 'Not found' }, 404);
      }
    }
  } catch (error) {
    return errorResponse(error);
  }
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS covers the /api/* routes, so a browser app on another origin can
    // read them with the reader's own token, and /auth/token, so that app can
    // finish signing in. Admin routes never get it.
    const path = new URL(request.url).pathname;
    const exchange = path === '/auth/token';
    const origin = path.startsWith('/api/') || exchange ? allowedOrigin(request, env) : null;
    if (!origin) return await handle(request, env, ctx);

    // A preflight carries no Authorization header, by design, so it is
    // answered before the token check. It grants nothing on its own.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': exchange ? 'POST' : 'GET',
          'Access-Control-Allow-Headers': exchange ? 'Content-Type' : 'Authorization',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }
    // Copied, because a Response built elsewhere may have immutable headers.
    const handled = await handle(request, env, ctx);
    const response = new Response(handled.body, handled);
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    response.headers.append('Vary', 'Origin');
    return response;
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // The daily sweep shares the scheduled handler, dispatched on which cron
    // expression fired. So does warming one Wrapped preset a day: one compute,
    // so its row reads stay small and predictable.
    if (event.cron === CONCERT_CRON) {
      ctx.waitUntil(
        runConcertCheck(env)
          .then((result) => {
            log('concert-check', { result });
          })
          .catch((error) => {
            log('concert-check-failed', { error }, 'error');
          }),
      );
      return;
    }
    if (event.cron === DAILY_CRON) {
      // The alert check is not here: it runs after every poll (runPollCron),
      // and the poll cron fires at 09:00 too, so a second check here could
      // race it and push the same alert twice.
      //
      // Polls only reconcile, index and key songs for what they touched; this
      // catches the rest.
      ctx.waitUntil(
        env.DB.batch(dailyTrackSweep(env.DB)).catch((error) => {
          log('daily-sync-failed', { step: 'artist-reconcile, search-index or song sync', error }, 'error');
        }),
      );
      // Writes out the rollup zone's offsets a day further, or rebuilds the
      // rollup when its zone has changed.
      ctx.waitUntil(
        ensureRollup(env)
          .then((result) => {
            log('rollup', { result });
          })
          .catch((error) => {
            log('rollup-failed', { error }, 'error');
          }),
      );
      ctx.waitUntil(
        warmWrappedPresets(env, ctx)
          .then((warmed) => {
            log('wrapped-warm', { result: warmed });
          })
          .catch((error) => {
            log('wrapped-warm-failed', { error }, 'error');
          }),
      );
      return;
    }

    // The poll is the same code path as POST /admin/poll, so the manual route
    // really does exercise what the cron does. The cron then pings
    // HEARTBEAT_URL and runs the alert check; see src/alerts.ts.
    ctx.waitUntil(
      runPollCron(env)
        .then((result) => {
          log('poll', { result: result.poll });
          if (result.heartbeat !== null) log('heartbeat', { ok: result.heartbeat }, result.heartbeat ? 'info' : 'warn');
          if (result.alerts) log('alert-check', { result: result.alerts });
        })
        .catch((error) => {
          // Reaching here means D1 itself is unavailable — most likely the free
          // plan's daily row limit, which resets at 00:00 UTC. The cursor never
          // advanced, so the next run recovers on its own.
          log('poll-failed', { note: 'before any state could be recorded', error }, 'error');
        }),
    );
  },
} satisfies ExportedHandler<Env>;

export default worker;
