# Top songs, top artists and daily counts

A client asks for the most-played artists or songs in a local date range, with a song's editions counted as one, and for plays per local day, week or month with quiet periods as zero. Answers are cached until new plays arrive.

## Sub-features

- `top-artists` ranks artists in a range, every credited artist counted, with `_meta.rows_read`.
- `top-tracks` ranks songs with editions folded; `id` is the most-played edition's.
- `daily-day` lists every day in the range, quiet days as `0`.
- `daily-week` sums into `weeks` labelled by Monday, which may precede `from`.
- `daily-month` sums into `months` (`YYYY-MM`).
- `daily-filter` charts one song or artist (`track_id`, `artist_id`, `artist_name`, echoed).
- `history-cache` marks a repeated answer `X-Cache: hit` with `Cache-Control: private, max-age=60`.
- `range-errors` rejects impossible dates and unknown `group_by` with `400`.

## How to get to it (user POV)

- MCP `top_tracks`, `top_artists`, `daily_play_counts`; GUI and Spicetify stats pages: `GET /api/top-tracks`, `/api/top-artists`, `/api/daily`.
- Wrapped site: `/api/top` is the live Spotify one and is out of scope; the stored equivalents are these.

## Driving it with api.sh

Preconditions:

- `doctor.sh` reports `doctor: healthy` (326 plays, zone `UTC`).
- `S=.claude/skills/verify-warehouse/scripts`.

- **Top artists for 2025.** Run `$S/api.sh read top-daily/artists-2025 GET '/api/top-artists?from=2025-01-01&to=2025-12-31&tz=UTC&limit=10'`. Five artists in this order and count: `The Paper Lanterns` 46, `Juniper & The Tides` 44, `Kestrel Avenue` 39, `Orla Brightwater` 31, `Mosswood Choir` 23 (sum 183). Each `artist_id` is a `name:` placeholder. `from`, `to`, `tz` echoed; `_meta.rows_read` present.
- **Top songs, editions folded.** Run `$S/api.sh read top-daily/tracks GET '/api/top-tracks?from=2025-01-01&to=2026-10-15&tz=UTC&limit=3'`. `tracks` is `Harbour Lights` 56 (`id` `mwverify00000000000001`, folding the 14 remaster plays), `Café Lumière` 43, `Driftwood Telephone` 40. No `_meta`; `X-Rows-Read` header present.
- **Cache hit.** Repeat the same request as `top-daily/tracks-again`. Headers show `X-Cache: hit` and `Cache-Control: private, max-age=60`; the body is identical.
- **Daily, by day.** Run `$S/api.sh read top-daily/days GET '/api/daily?from=2025-10-01&to=2025-10-05&tz=UTC'`. `days` is five entries, plays `0,0,0,1,0` (2025-10-04 has one).
- **By week.** Run `$S/api.sh read top-daily/weeks GET '/api/daily?from=2025-10-01&to=2025-10-31&tz=UTC&group_by=week'`. `group_by` is `week`; `weeks` is `2025-09-29`:1, `2025-10-06`:5, `2025-10-13`:1, `2025-10-20`:5, `2025-10-27`:1. No `days` key. The first label is before `from`.
- **By month.** Run `$S/api.sh read top-daily/months GET '/api/daily?from=2025-01-01&to=2025-12-31&tz=UTC&group_by=month'`. Twelve `months` summing to 183; `2025-10` is 13.
- **One artist's chart.** Run `$S/api.sh read top-daily/artist-months GET '/api/daily?from=2025-01-01&to=2025-12-31&tz=UTC&group_by=month&artist_name=The%20Paper%20Lanterns'`. `artist_name` echoed; months sum to 46, matching top-artists.
- **Errors.** Run `$S/api.sh read top-daily/bad-date GET '/api/daily?from=2026-02-30&to=2026-03-01'` (`400`, `from must be a real YYYY-MM-DD date`) and `$S/api.sh read top-daily/bad-group GET '/api/daily?group_by=year'` (`400`, `group_by must be day, week or month`).
- **Proof.** The bodies above; the month sums equal the top-artists sum, a second view of the same plays.

## Gotchas

- Defaults (`from` 29 days ago, `to` today) move with the clock; the seed's last play is 2026-10-09, so default ranges get emptier over time. Always pass explicit `from`/`to` for assertions.
- "Today" is the warehouse zone's (`UTC`), not the machine's local date: near midnight they differ by a day.
- `/api/top` (no suffix) is the live Spotify route. Do not call it.
- A cached answer's `X-Rows-Read` is the cache check's cost, not the query's; `_meta.rows_read` keeps the first computation's.
- `top-tracks` folds only listed edition tags (remaster, single version, radio edit); a "Live" title stays separate by design.
