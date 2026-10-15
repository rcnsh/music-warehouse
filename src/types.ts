export interface Env {
  DB: D1Database;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  SPOTIFY_REDIRECT_URI: string;
  ADMIN_TOKEN: string;
  /**
   * Deprecated. Optional read-only credential for the /api/* routes, from
   * before device tokens: one shared secret that never expires and cannot be
   * revoked per reader. Every use logs a warning. Readers should sign in (or
   * be given a device token from POST /admin/tokens) instead; once none uses
   * it, delete the secret. Unset means only device tokens and ADMIN_TOKEN work.
   */
  READ_TOKEN?: string;
  /**
   * Where the alert check POSTs when something needs a human. Optional:
   * unset means conditions are logged but never pushed anywhere.
   */
  ALERT_WEBHOOK_URL?: string;
  /**
   * Optional dead-man's switch, e.g. a healthchecks.io ping URL, fetched with
   * a GET after every successful poll. An outside service alerts when the
   * pings stop, which covers the Worker or its crons being down, where
   * ALERT_WEBHOOK_URL cannot.
   */
  HEARTBEAT_URL?: string;
  /**
   * Optional prefix for every alert body, for whatever syntax the receiver
   * uses to notify a human — a Discord `<@id>`, a Slack `<@U…>`, an ntfy tag.
   * Every condition alerted on needs manual intervention, so it applies to all
   * of them rather than only the critical ones.
   */
  ALERT_MENTION?: string;
  /**
   * JSON list of eras, each read in its own timezone: key, label, IANA
   * timeZone, and `from` (an ISO instant; optional on the first, where it also
   * marks where history starts). See src/eras.ts. Optional: unset means one
   * era in TIMEZONE. Set it as a secret if an era's exact start is private.
   */
  ERAS?: string;
  /** IANA timezone for the single era used when ERAS is unset. Default UTC. */
  TIMEZONE?: string;
  /**
   * Comma-separated browser origins allowed to call /api/* cross-origin, e.g.
   * a Wrapped app the reader points at this warehouse. Optional: unset means
   * no CORS headers at all, so only same-origin and non-browser callers work.
   * The bearer token is still required; this only lets a browser carry it.
   */
  CORS_ORIGINS?: string;
  /**
   * Optional comma-separated custom URL schemes a mobile app may use as a
   * sign-in `return_to`, e.g. `app.remastered`. Loopback HTTP needs no entry.
   */
  SIGN_IN_SCHEMES?: string;
  /**
   * Optional Workers Rate Limiting binding for the unauthenticated /auth/*
   * routes, keyed by a hash of the client address. See `ratelimits` in
   * wrangler.jsonc. Unset means no per-minute limit, only the cap on pending
   * sign-ins.
   */
  AUTH_RATE_LIMITER?: RateLimit;
  /**
   * Ticketmaster Discovery API consumer key, for concert alerts. Optional:
   * unset means the concert cron does nothing and /api/concerts stays empty.
   */
  TICKETMASTER_API_KEY?: string;
  /**
   * JSON list of places to look for concerts: key, label, and either a
   * Ticketmaster `countryCode` or a `geoPoint` geohash with `radius` in km.
   * See src/concerts.ts. Optional: unset means no regions, so no checks.
   */
  CONCERT_REGIONS?: string;
}

/**
 * Shape of a `recently-played` item, as far as this Worker relies on it.
 * Everything is optional-ish on purpose: Spotify has changed field
 * availability before (external_ids was removed in Feb 2026 and reverted in
 * Mar 2026), so normalize() tolerates absence rather than throwing.
 */
export interface SpotifyArtist {
  id?: string | null;
  name?: string | null;
}

export interface SpotifyAlbum {
  id?: string | null;
  name?: string | null;
  release_date?: string | null;
  images?: Array<{ url?: string | null; width?: number | null }> | null;
}

export interface SpotifyTrack {
  id?: string | null;
  name?: string | null;
  duration_ms?: number | null;
  album?: SpotifyAlbum | null;
  artists?: SpotifyArtist[] | null;
  external_ids?: { isrc?: string | null } | null;
}

export interface RecentlyPlayedItem {
  track?: SpotifyTrack | null;
  played_at?: string | null;
  context?: { uri?: string | null; type?: string | null } | null;
}

export interface RecentlyPlayedResponse {
  items?: RecentlyPlayedItem[] | null;
  cursors?: { after?: string | null; before?: string | null } | null;
  next?: string | null;
  limit?: number;
  href?: string;
}

export interface SyncState {
  cursor_ms: number;
  last_success_ms: number | null;
  last_error: string | null;
  last_error_ms: number | null;
  consecutive_failures: number;
}

export interface OAuthToken {
  access_token: string | null;
  access_expires_ms: number | null;
  refresh_token: string | null;
  authorized_at_ms: number;
  needs_reauth: number;
  /** The Spotify account that authorized ingestion; sign-in must match it. */
  spotify_user_id?: string | null;
}

/** Rows produced by normalize(), ready for a single batched write. */
export interface NormalizedRows {
  plays: Array<{
    played_at_ms: number;
    track_id: string;
    context_uri: string | null;
    context_type: string | null;
  }>;
  tracks: Array<{
    track_id: string;
    name: string;
    duration_ms: number | null;
    album_id: string | null;
    isrc: string | null;
    first_seen_ms: number;
  }>;
  artists: Array<{ artist_id: string; name: string }>;
  trackArtists: Array<{ track_id: string; artist_id: string; position: number }>;
  albums: Array<{
    album_id: string;
    name: string;
    release_date: string | null;
    image_url: string | null;
  }>;
  /** Items dropped because the track had no Spotify id (local files, unavailable tracks). */
  skipped: number;
  /** Highest played_at seen in this payload, or 0 when the payload was empty. */
  maxPlayedAtMs: number;
}
