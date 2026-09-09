export interface Env {
  DB: D1Database;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  SPOTIFY_REDIRECT_URI: string;
  ADMIN_TOKEN: string;
  /**
   * Optional read-only credential for the /api/* routes. Lets a frontend read
   * the warehouse without holding a token that can also trigger polls or
   * import rows. Unset means /api/* is admin-only.
   */
  READ_TOKEN?: string;
  /**
   * Where the daily alert cron POSTs when something needs a human. Optional:
   * unset means conditions are logged but never pushed anywhere.
   */
  ALERT_WEBHOOK_URL?: string;
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
