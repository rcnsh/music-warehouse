# Captured response shape

Captured 2026-09-08 from `GET /v1/me/player/recently-played?limit=50` against
the live account, via `GET /admin/raw`. The dump itself is at
`fixtures/recently-played.json` — gitignored, because it is real listening data.

Sample size: 50 items (a full window).

## Envelope

`href`, `limit`, `next`, `cursors: { after, before }`.

**`total` was not present**, though the brief listed it. Nothing depends on it.
`cursors.after` / `cursors.before` are strings holding millisecond values.

## Item

`{ context, played_at, track }` — assumption **A1 confirmed**.

- `played_at` is ISO-8601 UTC with milliseconds: `2026-09-08T18:51:38.235Z`.
- `context` was `null` on 17 of 50 items (plays started from search or the
  queue rather than a playlist or album). The schema already allows NULL.

## Track

`album`, `artists`, `disc_number`, `duration_ms`, `explicit`, `external_ids`,
`external_urls`, `href`, `id`, `is_local`, `is_playable`, `name`,
`track_number`, `type`, `uri`.

- **`external_ids.isrc` is present on all 50 items** — assumption **A2
  confirmed**. The speculative `isrc` column is real data, not NULLs.
- `duration_ms` present on every item.
- `is_local` exists as an explicit boolean. `normalize()` keys off a null `id`
  instead, which covers local files and unavailable tracks alike; no change
  needed, but `is_local` is there if a more precise signal is ever wanted.
- No `id` was null in this sample, so the skip path stayed untested against
  live data (it is covered by unit tests).

## Album

`album_type`, `artists`, `external_urls`, `href`, `id`, `images`, `is_playable`,
`name`, `release_date`, `release_date_precision`, `total_tracks`, `type`, `uri`.

`release_date` and `images` present on all 18 distinct albums seen.

## Artist

`external_urls`, `href`, `id`, `name`, `type`, `uri`. Ids present throughout.

## First poll, for reference

50 plays → 48 distinct tracks, 18 albums, 16 artists, 52 track-artist credits.
All 48 tracks carried an ISRC; none was missing a duration.
