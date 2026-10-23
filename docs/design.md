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

**The cursor is the whole safety story.** `sync_state.cursor_ms` holds how far
the stored plays are known to be complete. It advances only inside the same
transaction as the writes, and `MAX(cursor_ms, ?)` means it can never move
backwards, whatever ordering Spotify returns. A failed run therefore costs
nothing: the next run asks for the same window again.

**The newest 50, every poll.** A play made offline is listed when the device
syncs, under the time it was played, which can be before the newest play
already stored, so asking only for plays after the cursor would never see it.
Each poll reads the newest 50 without `after` instead and stores them all;
plays are keyed by `(played_at_ms, track_id)` and inserted OR IGNORE, so the
ones already stored are skipped. When even the oldest of the 50 is newer than
the cursor, more plays may have happened since the last poll than the window
holds, so a second request asks for the plays `after` the cursor, and the
cursor advances only as far as that answer reaches. A late play older than
the 50 newest is still out of reach: the endpoint goes back no further.

**`after` only, never `before`.** Paging backwards cannot reach past the
endpoint's hard 50-item ceiling, so `before` has no use here.

**One or two API calls per poll.** The recently-played response embeds the
full track object including album and artists, so no `/tracks` or `/artists`
lookups are needed.

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
no `context_uri`, no timestamp finer than a month, with two exceptions:
`as_of`, the cut-off each body was computed up to, and `on-repeat`'s whole
local days (below).

Nothing may change from one day to the next in a way that isolates a day.
Diffing two days of a count that ticks daily reveals one day's listening. So
`rhythm`, `top-over-time` and `albums` stop at the start of the current local
week, `eras` at the start of the current month, and a running streak is
reported in whole weeks. `on-repeat` is meant to be current, so it is the
exception: it covers complete days up to local midnight, and its per-song
daily counts are only for songs already on repeat.

| Stat | What it holds | Recomputed | D1 rows read per compute |
|---|---|---|---|
| `on-repeat` | Songs with 5+ plays on 3+ days in the last 14, at least twice their usual rate; albums with 4+ such songs | daily | ~47k |
| `rhythm` | Daily-listening streaks (1, 10, 25 plays a day) and plays by local hour, per era, all time and per year | weekly | ~190k |
| `top-over-time` | Top artists and songs per quarter and year, and the seven biggest artists' share per quarter | weekly | ~395k |
| `eras` | Artist drift between the two eras, against the normal churn between windows of the same length | monthly | ~315k |
| `albums` | The ten most-played albums with at least four different songs played, all time and per year | weekly | ~270k |

The row counts are D1's own `rows_read`, measured on about six years of
history. They include temporary B-trees, so they run well above the number of
plays.

**Caching.** Each stat is held in `stats_snapshots` (migration 0004) and in
the Cache API for five minutes. Only a request that wins a claim computes:
inline the first time a stat is asked for, in the background (serving the
stale body) after that. A request that finds a claim held and nothing to serve
gets `503` with `Retry-After`. A failed compute holds its claim for an hour, so
an erroring query does not retry on every request. A stat only changes when
its cut-off moves (local midnight, the local week, the UTC month), so a
snapshot stays fresh until that cut-off has passed and settled for six hours,
long enough for late polls to land; until then the previous period's body is
served. Recompute cost is set by the calendar, not by traffic: all five
together average under 200k rows a day. A history import is the exception:
its plays appear at each stat's next cut-off, or sooner by bumping a key's
version. This deployment is on Workers Paid, where D1 reads are metered
against 25 billion a month rather than capped; the design also keeps a fork on
the Free plan under its 5M a day. The routes take no parameters and
the query string is never part of a cache key, so callers cannot force a
recompute.

**Eras and local time.** Plays carry no location. `src/eras.ts` reads eras
from the `ERAS` setting: periods, each with its own IANA timezone and start.
Without it there is one era in `TIMEZONE` (default UTC). History starts at the
first era's `from`, or at the first stored play. A deployment whose era starts
are private sets `ERAS` as a secret; the stats publish only the month an era
began. SQLite has no zone database, so each era's UTC offset is written out in
SQL as the zone's transitions over the era (found with `Intl`, to the minute),
and tests check it against `Intl` across DST changes, southern-hemisphere
zones, half-hour offsets and a change of era. Snapshot keys carry a digest of
the eras, so changing them recomputes. `eras` compares the latest era with the
same number of whole calendar months before it, leaving the month it began
out of both sides.

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
preset not yet computed, newest first; one compute a day keeps its reads
small and predictable.

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
every edition with the same title (less a remaster, "single version" or "radio
edit" tag; src/song-title.ts) and primary artist, and its `id` is the one
asked for.

`plays` counts every stored play, as `/api/top-artists` does. `minutes` is
Wrapped's estimate, so a skip is a play worth no minutes. `months` runs from
the first month with a play to the last, quiet months as zero.

**Play numbers.** Counting a play's predecessors on read costs a row per
earlier play of its song: 26k to 38k rows for a page of 50 with editions
folded (411 to 6.4k even per track id), against about 100 for the page. So
`play_numbers` (migration 0012) stores each play's number, and
`track_songs` the song key each track was numbered under. Every write rekeys
the tracks it wrote, renumbers whole any song a key change touched (the old
key waits in `previous` until then), and numbers its own plays from the last
correct number before the earliest of them, which for a poll is one index seek
per song. The daily cron rekeys, and re-indexes for search, the tracks marked
in `track_changes` since its last run (migration 0020: triggers mark a track
when it is stored or its name, album or credits change), for changes no write
names, such as the artist reconcile repointing a credit or an album backfill.
It used to rekey every track (about 31k rows read, writing nothing unless a
key changed). Nothing deletes plays, so numbers only ever
need renumbering forwards.

Each is index seeks only: an artist or song reads about two rows per play of it
(the play, and the play before it for the minutes estimate), and on this day
one range per year. The artist name match needs migration 0006.

**The play-count rollup.** `/api/daily` read one row per play and the top
routes counted every play: a year cost 15k and about 40k rows. Migration
0014 keeps counts per local day and per local month and track. Triggers on
`plays` maintain them, so every way a play arrives or leaves (polls, imports of
older history, a manual `DELETE`) keeps them right without each write path
remembering to. SQL has no zone database, so `rollup_offsets` lists the
zone's offset from each transition, found to the second as Intl resolves
time, and the trigger looks up the one in force.

The rollup must answer exactly as counting plays does, so it is only read
where its buckets provably hold the request's plays: the request's `tz` is
the rollup's, each boundary used is exactly where its local day begins (not
so on a day whose midnight a DST change skips), and the zone's dates never run
backwards. The top routes take whole months from it and count the plays in
the partial months either side; `/api/daily` takes every day. Tests compare
both paths across eight zones, DST changes, partial months, out-of-order
inserts and deletes.

The offsets are written out two years ahead. The daily cron extends them, and
rebuilds every count when the configured zone or its rules change. If the cron
stops for two years, reads stop trusting the rollup rather than misplace a
play.

## Home

`/api/home` ranks what a client's home screen shows, since Spotify's own home
is closed to apps and its recently-played holds 50 plays, which one album can
fill. Spotify describes its shortcuts as what you play most, changing through
the day; this does the same from the history (src/home.ts).

A play counts toward its context if that is a playlist, album or artist, toward
its track's album if it has no context (the export never has one), and toward
nothing otherwise (Liked Songs, which a client shows anyway). Consecutive plays
from one context with under 40 minutes between them are one session, so an
album played through counts once, worth 1 + ln(tracks); skips (under 30 s, as
on-repeat measures them) count for nothing.

- **Shortcuts**: each session's weight halves every 14 days, and is raised up
  to 2.5x by how near its start was to the current local hour (Gaussian, 2 h)
  and 1.15x on the same kind of day (weekday or weekend). Eight.
- **Jump back in**: newest session first.
- **Around now**: sessions within 1.5 h of this hour, on at least three days in
  the last year, halving every 60 days.
- **Rediscover**: contexts played on at least four days but not in the last 90,
  by days played, halving every two years since the last.

At most two albums or artist pages of one primary artist per row, except jump
back in. Rows may overlap; a client shows each item once, in row order.

The last year is read play by play (about three rows each, with the track's
album and primary artist: some 60k rows for 19k plays; the year starts at a
UTC midnight, so it runs a year and up to a day). Anything older is counted
per context and day in SQL once per UTC day and kept in `stats_snapshots`,
since only an import of old plays changes it. Bodies are held in the Cache
API under the zone, local day and local hour, so a new play can take up to an
hour to show: keyed on the newest play as well, every poll missed.

## Radio

`/api/radio` stands in for the recommendations and related artists Spotify's
Web API no longer gives apps: a song's radio is what the user plays near it
(src/radio.ts). The seed is a song, every edition folded as `/api/track` folds
them, or an artist's songs as `/api/artist` credits them.

The seed's newest play in each UTC hour stands for that hour, for the newest
300 hours, so a song on repeat or an album played through is a few seeds, not
dozens. Every play within 45 minutes of a seed is near it; overlapping windows
are one session. Per session a song scores its best `2^(-minutes from the
nearest seed / 10) × 2^(-age / 1 year)`, so repeating it there adds nothing,
and skips (under 30 s before the next play) count for nothing. The sum is
divided by `(the song's plays + 5)^0.3`, its play count read as its latest
play number (one seek), so an all-time favourite doesn't top every radio and
one played once isn't lifted above one played near the seed often. At most
three songs per primary artist name. A track seed leaves its own editions out;
an artist seed keeps its songs, which then open the list.

Each window is one range seek on the plays primary key (`CROSS JOIN` keeps
SQLite from scanning plays once per window, which read 2M rows on the real
warehouse; now about 2k for a song and 11k for a much-played artist). Answers
are kept like the history routes'.

## Lyrics

`/api/lyrics` is a thin, optional proxy to the [Spicy Lyrics
API](https://developers.spicylyrics.org) (src/lyrics.ts), so a client app can
show synced lyrics without carrying a key of its own. A publishable key baked
into an app can be read out of it; the deployment's secret key stays in a
Worker secret.

- **Off by default.** Without `SPICY_LYRICS_SECRET_KEY` the route is the same
  `404 Not found` as a route the Worker lacks, before the `track` check, so a
  client's feature probe (no `track`) hides lyrics. With a key, no `track` is a
  `400`; neither calls upstream.
- **The body passes through unchanged.** Spicy Lyrics' terms require the
  provider, and for community syncs the uploader and maker, shown with the
  lyrics, and forbid altering the marks each response carries, so the Worker
  neither parses nor rewrites a `200` or `404`. A client parses it as Spicy
  Lyrics' own answer. Its "no lyrics" `404` is told from the Worker's own by
  the body.
- **Upstream key errors are not the reader's.** Spicy Lyrics' `401` and `403`
  are about the deployment's key; passed on, they would read as the reader's
  token being rejected. They become `502 Lyrics upstream: key rejected`, with
  Spicy Lyrics' error code (never the key) in the log.
- **Cache within the terms' 30 days.** The Cache API, not D1, so no migration
  and no row costs: lyrics 7 days, "no lyrics" 1 day (new community syncs
  appear), errors never. A kept answer's `Age` lets a client that stores it
  count the time already spent here.
- **`Retry-After` is honoured.** A `429` or `503` from upstream is passed on,
  and the isolate sends nothing more until its `Retry-After` passes, answering
  `429` itself meanwhile. The pause is per isolate, not shared through D1 like
  Spotify's: lyrics traffic is one request per new song.
- **Only the owner's clients.** The terms allow a server serving its own users
  and forbid re-exposing the API to anyone else. The route sits behind the
  read token like the rest of `/api/*`, and sign-in mints tokens only for the
  warehouse's owner.

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
  minutes everywhere are estimates. The import uses it only to drop skips
  (under 30 s), so export plays count the way polled ones do.
- **Plays shorter than roughly 30 seconds may never appear.** Widely reported,
  not documented. Do not present counts as exhaustive.
- **Downtime is data loss.** Nothing recovers plays that aged out of the
  50-item window during an outage. Tighten the cron to `*/15 * * * *` if gaps
  appear. The alert check runs after every poll and `HEARTBEAT_URL` covers the
  Worker itself stopping, so an outage is noticed within hours, not days.
- **Local files and podcasts are not stored.** They have no Spotify track id.
  The poll counts them as `skipped`.
- **Two plays sharing a `played_at` and `track_id` collapse to one row.** They
  are indistinguishable under the primary key.

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
