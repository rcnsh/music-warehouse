import { describe, expect, it } from 'vitest';
import { extractCandidates } from '../src/albums';

const album = {
  id: 'alb1',
  name: 'Clancy',
  release_date: '2024-05-24',
  images: [
    { url: 'small.jpg', width: 64 },
    { url: 'big.jpg', width: 640 },
  ],
};

describe('extractCandidates', () => {
  it('unwraps the Liked Songs envelope', () => {
    const { candidates, itemCount, total } = extractCandidates('saved', {
      total: 812,
      items: [{ added_at: 'x', track: { id: 't1', duration_ms: 1000, external_ids: { isrc: 'I1' }, album } }],
    });

    expect(total).toBe(812);
    expect(itemCount).toBe(1);
    expect(candidates).toEqual([{ track_id: 't1', album, duration_ms: 1000, isrc: 'I1' }]);
  });

  it('reads top tracks, which are bare track objects', () => {
    const { candidates, itemCount } = extractCandidates('top', {
      items: [{ id: 't2', album }, { id: 't3', album }],
    });

    expect(itemCount).toBe(2);
    expect(candidates.map((c) => c.track_id)).toEqual(['t2', 't3']);
  });

  it('maps every track of a saved album onto that album', () => {
    const { candidates, itemCount } = extractCandidates('albums', {
      items: [{ album: { ...album, tracks: { items: [{ id: 't4' }, { id: 't5' }] } } }],
    });

    // One item, but two track ids — that is why saved albums are worth walking.
    expect(itemCount).toBe(1);
    expect(candidates.map((c) => c.track_id)).toEqual(['t4', 't5']);
    expect(candidates[0]!.album.id).toBe('alb1');
  });

  it('drops entries with no track id or no album id', () => {
    const { candidates } = extractCandidates('saved', {
      items: [
        { track: { id: null, album } },
        { track: { id: 't6', album: { id: null, name: 'local' } } },
        { track: { id: 't7', album } },
        null,
      ],
    });

    expect(candidates.map((c) => c.track_id)).toEqual(['t7']);
  });

  it('tolerates an empty page', () => {
    expect(extractCandidates('saved', {})).toEqual({ candidates: [], itemCount: 0, total: null });
  });
});
