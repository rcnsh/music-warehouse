import { describe, expect, it } from 'vitest';
import { normalize } from '../src/normalize';
import { normalizeExport } from '../src/import';
import { loadFixture } from './helpers';

describe('normalize', () => {
  it('maps the documented item shape onto row sets', () => {
    const rows = normalize(loadFixture());

    expect(rows.plays.length).toBeGreaterThan(0);
    for (const play of rows.plays) {
      expect(Number.isInteger(play.played_at_ms)).toBe(true);
      expect(play.track_id).toBeTruthy();
    }
    expect(rows.maxPlayedAtMs).toBe(Math.max(...rows.plays.map((play) => play.played_at_ms)));
  });

  it('skips items whose track has no Spotify id, and counts them', () => {
    const rows = normalize({
      items: [
        { played_at: '2026-09-08T10:00:00Z', track: { id: null, name: 'local file' } },
        { played_at: '2026-09-08T10:05:00Z', track: { id: 'abc', name: 'real' } },
      ],
    });

    expect(rows.skipped).toBe(1);
    expect(rows.plays).toHaveLength(1);
    expect(rows.plays[0]!.track_id).toBe('abc');
  });

  it('skips items with an unparseable played_at', () => {
    const rows = normalize({ items: [{ played_at: 'not-a-date', track: { id: 'abc' } }] });
    expect(rows.skipped).toBe(1);
    expect(rows.plays).toHaveLength(0);
  });

  it('collapses a track and its artists appearing across several plays', () => {
    const rows = normalize({
      items: [
        {
          played_at: '2026-09-08T10:00:00Z',
          track: { id: 't1', name: 'Song', artists: [{ id: 'a1', name: 'Artist' }] },
        },
        {
          played_at: '2026-09-08T11:00:00Z',
          track: { id: 't1', name: 'Song', artists: [{ id: 'a1', name: 'Artist' }] },
        },
      ],
    });

    expect(rows.plays).toHaveLength(2);
    expect(rows.tracks).toHaveLength(1);
    expect(rows.artists).toHaveLength(1);
    expect(rows.trackArtists).toHaveLength(1);
    // first_seen_ms takes the earliest play of that track in the payload.
    expect(rows.tracks[0]!.first_seen_ms).toBe(Date.parse('2026-09-08T10:00:00Z'));
  });

  it('keeps artist credit order and picks the largest cover image', () => {
    const rows = normalize({
      items: [
        {
          played_at: '2026-09-08T10:00:00Z',
          track: {
            id: 't1',
            name: 'Song',
            artists: [
              { id: 'a1', name: 'First' },
              { id: 'a2', name: 'Second' },
            ],
            album: {
              id: 'al1',
              name: 'Album',
              images: [
                { url: 'small.jpg', width: 64 },
                { url: 'big.jpg', width: 640 },
              ],
            },
          },
        },
      ],
    });

    expect(rows.trackArtists.map((row) => [row.artist_id, row.position])).toEqual([
      ['a1', 0],
      ['a2', 1],
    ]);
    expect(rows.albums[0]!.image_url).toBe('big.jpg');
  });

  it('tolerates a missing external_ids block (assumption A2)', () => {
    const rows = normalize({ items: [{ played_at: '2026-09-08T10:00:00Z', track: { id: 't1', name: 'Song' } }] });
    expect(rows.tracks[0]!.isrc).toBeNull();
  });

  it('treats an empty payload as empty, not an error', () => {
    const rows = normalize({ items: [] });
    expect(rows.plays).toHaveLength(0);
    expect(rows.maxPlayedAtMs).toBe(0);
  });
});

describe('normalizeExport artists', () => {
  it('keys export artists by name and links them to the track', () => {
    const rows = normalizeExport([
      {
        ts: '2026-01-01T14:17:20Z',
        spotify_track_uri: 'spotify:track:2XGJUQGZQXr5pHH11AL9oG',
        master_metadata_track_name: 'Battery Death',
        master_metadata_album_artist_name: 'Ninajirachi',
      },
    ]);

    expect(rows.artists).toEqual([{ artist_id: 'name:Ninajirachi', name: 'Ninajirachi' }]);
    expect(rows.trackArtists).toEqual([
      { track_id: '2XGJUQGZQXr5pHH11AL9oG', artist_id: 'name:Ninajirachi', position: 0 },
    ]);
  });

  it('deduplicates an artist heard across many plays and tracks', () => {
    const rows = normalizeExport([
      { ts: '2026-01-01T00:00:00Z', spotify_track_uri: 'spotify:track:aaa', master_metadata_album_artist_name: 'Same' },
      { ts: '2026-01-02T00:00:00Z', spotify_track_uri: 'spotify:track:aaa', master_metadata_album_artist_name: 'Same' },
      { ts: '2026-01-03T00:00:00Z', spotify_track_uri: 'spotify:track:bbb', master_metadata_album_artist_name: 'Same' },
    ]);

    expect(rows.artists).toHaveLength(1);
    expect(rows.trackArtists).toHaveLength(2);
  });

  it('stores a play whose artist name is absent, without an artist link', () => {
    const rows = normalizeExport([
      { ts: '2026-01-01T00:00:00Z', spotify_track_uri: 'spotify:track:aaa', master_metadata_album_artist_name: null },
    ]);

    expect(rows.plays).toHaveLength(1);
    expect(rows.artists).toHaveLength(0);
    expect(rows.trackArtists).toHaveLength(0);
  });
});
