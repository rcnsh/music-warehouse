# Design notes

The why behind music-warehouse. The [README](../README.md) covers setting it
up and calling it; this is for changing it.

- [Ingestion](#ingestion)
- [Listening stats](#listening-stats)
- [Wrapped](#wrapped)
- [History](#history)
- [Known limitations](#known-limitations)
- [Verified against the live API](#verified-against-the-live-api)

## Ingestion

**One store.** Play data and OAuth tokens both live in D1: one binding, one
consistency model.

**The cursor is the whole safety story.** `sync_state.cursor_ms` holds the
newest `played_at` stored. Each poll asks for everything after it and advances
it only inside the same transaction as the writes. `MAX(cursor_ms, ?)` means it
can never move backwards, whatever ordering Spotify returns. A failed run
therefore costs nothing: the next run asks for exactly the same window again.

**`after` only, never `before`.** Paging backwards cannot reach past the
endpoint's hard 50-item ceiling, so `before` has no use here. On the first ever
run the `after` parameter is omitted entirely rather than sent as `after=0`.

**One API call per poll.** The recently-played response embeds the full track
object including album and artists, so no `/tracks` or `/artists` lookups are
needed.

**Writes are chunked, then batched.** D1 allows at most 100 bound parameters
per statement, and that limit applies to each statement inside a batch. A
50-play multi-row insert would be 200 parameters, so each insert is split into
statements that fit, all still issued in a single `db.batch()` call. A full
poll uses about 4 subrequests against a ceiling of 50.

**Timezones are applied at read time only.** Everything is stored as UTC
milliseconds. SQLite has no timezone database, so `/api/daily` resolves the
requested IANA zone to UTC bounds in JS, selects only the timestamp column over
an indexed range, and buckets the results. A 23-hour and a 25-hour local day
both bucket correctly.

**Export-era artists are keyed by name.** The export carries names, not ids,
so its artists are stored as `name:<artist name>` (`NAME_KEY_PREFIX` in
`src/db.ts`). Every write runs `reconcileNameKeyedArtists`, which folds a
name-keyed artist into its id-keyed twin by exact name once a live poll teaches
the Worker that id.

## Listening stats

`/api/stats/*` is for a public stats page. It sits behind `READ_TOKEN` like the
rest of `/api/*`, but every body is built so it could be republished as-is:
counts, shares, artist and track names, album art, and months. No play rows,
no `context_uri`, no timestamp finer than a month (`as_of`, the cut-off each
body was computed up to, is the one exception).

Nothing may change from one day to the next in a way that isolates a day.
Diffing two days of a count that ticks daily reveals one day's listening. So
`rhythm`, `top-over-time` and `albums` stop at the start of the current local
week, `eras` at the start of the current month, and a running streak is
reported in whole weeks. `on-repeat` is meant to be current, so it is the
exception: it covers complete days up to local midnight, and its per-song
daily counts are only for songs already on repeat.

| Stat | What it holds | Fresh for | D1 rows read per compute |
|---|---|---|---|
| `on-repeat` | Songs with 5+ plays on 3+ days in the last 14, at least twice their usual rate; albums with 4+ such songs | 3 h | ~47k |
| `rhythm` | Daily-listening streaks (1, 10, 25 plays a day) and plays by local hour, per era, all time and per year | 6 h | ~190k |
| `top-over-time` | Top artists and songs per quarter and year, and the seven biggest artists' share per quarter | 24 h | ~395k |
| `eras` | Artist drift between the two eras, against the normal churn between windows of the same length | 24 h | ~315k |
| `albums` | The ten most-played albums with at least four different songs played, all time and per year | 24 h | ~270k |

The row counts are D1's own `rows_read`, measured on about six years of
history. They include temporary B-trees, so they run well above the number of
plays.

**Caching.** Each stat is held in `stats_snapshots` (migration 0004) and in
the Cache API for five minutes. Only a request that wins a claim computes:
inline the first time a stat is asked for, in the background (serving the
stale body) after that. A request that finds a claim held and nothing to serve
gets `503` with `Retry-After`. A failed compute holds its claim for an hour, so
an erroring query does not retry on every request. Recompute cost is set by
the freshness window, not by traffic: all five together read about 2M rows a
day at worst, against the free plan's 5M. The routes take no parameters and
the query string is never part of a cache key, so callers cannot force a
recompute.

**Eras and local time.** Plays carry no location. `src/eras.ts` defines two
eras: Europe/London from `HISTORY_START_MS` (July 2020), then Asia/Singapore
from the `MOVED_AT` secret. `MOVED_AT` is a secret, not a constant, because
this repo is public and the stats publish only the month of the move. Without
it everything is one London era. SQLite has no zone database, so each era's
UTC offset is spelled out in SQL (UK summer time, then a fixed +8), and a test
checks it against `Intl` across DST changes and the move. `eras` compares whole
calendar months, leaving the month of the move out of both sides.

**What counts.** Rankings credit the primary artist only, because export rows
carry nothing else, and group by lowercased name so `name:` placeholders fold
into real ids. On-repeat drops plays shorter than 30 seconds, measured as the
gap since the previous play ended; the export records every skip, and without
the filter a skipping spree outranks what is really on repeat. An era's hour
profile stays `null` until the era spans four weeks, and its weekday-by-hour
grid until 26 weeks.

There is no genre data: Spotify's artist catalogue endpoint is closed to
development-mode apps, so `eras` compares artists, not genres.

## Wrapped

`/api/wrapped` is private, not a public stat: it names days. It also takes
parameters, so a token holder could mint new keys and force scans. That is why
`READ_TOKEN` computes only a preset and reads anything already computed, and
gets `403` otherwise.

A range is stored in `stats_snapshots` under `wrapped:v2:{from}:{to}`. Once it
ended more than two days ago it is never recomputed.

The presets are a bounded list, so a read token can't mint keys: every closed
calendar year that has plays, and this year so far. "So far" ends with the
last complete local week, so it moves once a week rather than daily, for the
same reason the public stats stop at a week boundary. Listing them costs one
primary-key probe per candidate year. The daily cron (`0 9 * * *`) computes one
preset not yet computed, newest first; one compute a day keeps it well inside
the row budget.

Days and hours are in each era's local time. Minutes are estimated: a play ran
for at most the gap since the play before it and at most the track's length,
and plays under 30 seconds are skips worth nothing. Listening age is the age of
someone whose late teens fall in the middle of the five-year span of release
years played most, and is `null` when fewer than half of the minutes have a
release date.

**CORS.** [music-warehouse-wrapped](https://github.com/rcnsh/music-warehouse-wrapped)
runs entirely in the reader's browser and calls the warehouse directly. The
Worker sends CORS headers on `/api/*` only, only to origins in `CORS_ORIGINS`,
and answers their preflights before the token check (a preflight never carries
`Authorization`, and returns no data). `CORS_ORIGINS` is a secret only so this
public repo doesn't name a deployment.

## History

`/api/artist`, `/api/track` and `/api/on-this-day` serve a client app's artist,
song and "on this day" pages. They are private like `/api/plays`, since they
name days, and take the caller's `tz` rather than the eras'.

An artist is matched by id and by lowercased name, as the stats group them, so
export-era `name:` placeholders count; `name` is the fallback for an id the
warehouse has never seen. Credit is the primary artist's only. A track folds
every edition with the same title and primary artist, and its `id` is the one
asked for.

`plays` counts every stored play, as `/api/top-artists` does. `minutes` is
Wrapped's estimate, so a skip is a play worth no minutes. `months` runs from
the first month with a play to the last, quiet months as zero.

Each is index seeks only: an artist or song reads about two rows per play of it
(the play, and the play before it for the minutes estimate), and on this day
one range per year. The artist name match needs migration 0006.

## Known limitations

- **Export-era artists are keyed by name, not id.** The export carries names
  only, and the catalog endpoints that would resolve them (`/v1/tracks`,
  `/v1/artists`) return 403 to development-mode apps since 27 November 2024.
  - Only the album artist is known, so featured artists are missing and
    compilations collapse to their compilation artist.
  - The name-to-id fold is exact on name, so a punctuation or casing difference
    between the export and the API leaves two rows until the same spelling
    arrives again.
  - `albums` is not populated from the export.
- **Album art reaches most of the history, not all.** `npm run backfill:albums`
  walks Top Tracks, Liked Songs and Saved Albums, whose track objects embed the
  album; that covered about 91% of plays here. `npm run backfill:catalog`
  closes the tail one track at a time through `GET /v1/tracks/{id}`, the one
  catalog endpoint still open (the batch forms are 403). Expect about 600
  tracks per run: measured runs stopped at 566 and 599 regardless of pace, and
  the 429s carried `Retry-After` of about an hour and then about 24 hours. That
  reads as a daily quota, so the script stops on a 429 rather than retrying,
  and a large tail is one run a day. Ingestion is unaffected: it uses `/me/*`,
  which is metered separately.
- **Listening duration is not derivable from polled data.** `played_at`'s exact
  meaning is undocumented, and the export shows consecutive streams
  overlapping. `ms_played` exists only in the export and is not stored, so
  minutes everywhere are estimates.
- **Plays shorter than roughly 30 seconds may never appear.** Widely reported,
  not documented. Do not present counts as exhaustive.
- **Downtime is data loss.** Nothing recovers plays that aged out of the
  50-item window during an outage. Tighten the cron to `*/15 * * * *` if gaps
  appear.
- **Local files and podcasts are not stored.** They have no Spotify track id.
  The poll counts them as `skipped`.
- **Two plays sharing a `played_at` and `track_id` collapse to one row.** They
  are indistinguishable under the primary key.
- **`/health` counts the whole table.** `total_plays` is a `COUNT(*)`, so do
  not poll it in a loop.
- **The eras are hard-coded** to London then Singapore (see
  [Listening stats](#listening-stats)). A fork in another zone edits
  `src/eras.ts`.

## Verified against the live API

Captured 2026-09-08 from a real account and recorded in
[`fixtures/NOTES.md`](../fixtures/NOTES.md):

- Items are `{ track, played_at, context }`, with `played_at` as ISO-8601 UTC
  to the millisecond.
- `external_ids.isrc` is present on every track.
- `context` is null on roughly a third of plays (started from search or queue).
- The response envelope has no `total` field.

Still open: whether plays under ~30 seconds are omitted, and whether a
30-minute cadence ever drops plays.
