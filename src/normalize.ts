import type { NormalizedRows, RecentlyPlayedItem, RecentlyPlayedResponse } from './types';

/** Pick the largest available cover image, falling back to the first one. */
export function pickImageUrl(images: Array<{ url?: string | null; width?: number | null }> | null | undefined): string | null {
  if (!images || images.length === 0) return null;
  let best = images[0]!;
  for (const image of images) {
    if ((image.width ?? 0) > (best.width ?? 0)) best = image;
  }
  return best.url ?? null;
}

/**
 * Turn a recently-played payload into row sets for one batched write.
 *
 * Pure: no clock, no network, no database. Every timestamp comes from the
 * payload itself, so the same input always produces the same output — which is
 * what makes the fixture tests meaningful.
 *
 * Items whose track has no Spotify id (local files, unavailable tracks) cannot
 * be keyed and are counted in `skipped` rather than stored.
 */
export function normalize(payload: RecentlyPlayedResponse): NormalizedRows {
  const plays = new Map<string, NormalizedRows['plays'][number]>();
  const tracks = new Map<string, NormalizedRows['tracks'][number]>();
  const artists = new Map<string, NormalizedRows['artists'][number]>();
  const trackArtists = new Map<string, NormalizedRows['trackArtists'][number]>();
  const albums = new Map<string, NormalizedRows['albums'][number]>();

  let skipped = 0;
  let maxPlayedAtMs = 0;

  const items: RecentlyPlayedItem[] = payload.items ?? [];

  for (const item of items) {
    const trackId = item.track?.id;
    const playedAt = item.played_at;

    if (!trackId || !playedAt) {
      skipped++;
      continue;
    }

    const playedAtMs = Date.parse(playedAt);
    if (!Number.isFinite(playedAtMs)) {
      skipped++;
      continue;
    }

    if (playedAtMs > maxPlayedAtMs) maxPlayedAtMs = playedAtMs;

    plays.set(`${playedAtMs}:${trackId}`, {
      played_at_ms: playedAtMs,
      track_id: trackId,
      context_uri: item.context?.uri ?? null,
      context_type: item.context?.type ?? null,
    });

    const track = item.track!;
    const existingTrack = tracks.get(trackId);
    tracks.set(trackId, {
      track_id: trackId,
      name: track.name ?? '',
      duration_ms: track.duration_ms ?? null,
      album_id: track.album?.id ?? null,
      // A2: speculative. Absent isrc simply stores NULL.
      isrc: track.external_ids?.isrc ?? null,
      first_seen_ms: existingTrack ? Math.min(existingTrack.first_seen_ms, playedAtMs) : playedAtMs,
    });

    const albumId = track.album?.id;
    if (albumId && !albums.has(albumId)) {
      albums.set(albumId, {
        album_id: albumId,
        name: track.album?.name ?? '',
        release_date: track.album?.release_date ?? null,
        image_url: pickImageUrl(track.album?.images),
      });
    }

    const trackArtistList = track.artists ?? [];
    for (let position = 0; position < trackArtistList.length; position++) {
      const artist = trackArtistList[position]!;
      if (!artist.id) continue;
      if (!artists.has(artist.id)) {
        artists.set(artist.id, { artist_id: artist.id, name: artist.name ?? '' });
      }
      const key = `${trackId}:${artist.id}`;
      // (track_id, artist_id) is the primary key, so an artist credited twice
      // on one track keeps only its first position.
      if (!trackArtists.has(key)) {
        trackArtists.set(key, { track_id: trackId, artist_id: artist.id, position });
      }
    }
  }

  return {
    plays: [...plays.values()],
    tracks: [...tracks.values()],
    artists: [...artists.values()],
    trackArtists: [...trackArtists.values()],
    albums: [...albums.values()],
    skipped,
    maxPlayedAtMs,
  };
}
