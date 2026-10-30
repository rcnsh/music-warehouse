import { BadRequest, json } from './api';
import { EraConfigError } from './eras';
import { LyricsConfigError } from './lyrics';
import { RegionConfigError } from './concerts';
import { SnapshotPending } from './snapshots';
import { SpotifyError } from './spotify';
import { isRateLimit } from './spotify-client';
import { NeedsReauthError } from './tokens';
import { log } from './log';

/** The response for an error a route threw: what went wrong, without leaking internals. */
export function errorResponse(error: unknown): Response {
  if (error instanceof BadRequest) return json({ error: error.message }, 400);
  // A deployment setting is wrong, not the request: name it so the operator
  // can fix it. The message holds the setting's shape, never its values.
  if (error instanceof EraConfigError || error instanceof RegionConfigError || error instanceof LyricsConfigError) {
    log('config-error', { message: error.message }, 'error');
    return json({ error: `Worker misconfigured: ${error.message}` }, 500);
  }
  if (error instanceof SnapshotPending) {
    const response = json({ error: error.message }, 503);
    response.headers.set('Retry-After', String(error.retryAfterSeconds));
    return response;
  }
  // The live proxy routes depend on a working Spotify grant, unlike the
  // stored-data routes. Say which of the two failed rather than a blank 500.
  if (error instanceof NeedsReauthError) {
    return json({ error: 'Spotify connection needs re-authorization.', needs_reauth: true }, 503);
  }
  if (error instanceof SpotifyError) {
    // The client only ever sees the error *kind*, so without this an
    // upstream failure is undiagnosable after the fact.
    // A call refused by the pause is expected while it lasts, not an error.
    const limited = isRateLimit(error);
    log(
      'spotify-error',
      { kind: error.kind, status: error.status, paused: error.paused, message: error.message },
      limited ? 'warn' : 'error',
    );
    const response = json(
      { error: `Spotify upstream: ${error.kind}`, retry_after_seconds: error.retryAfterSeconds },
      limited ? 429 : 502,
    );
    if (limited && error.retryAfterSeconds !== null) {
      response.headers.set('Retry-After', String(error.retryAfterSeconds));
    }
    return response;
  }
  log('unhandled-error', { error }, 'error');
  return json({ error: 'Internal error' }, 500);
}
