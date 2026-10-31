# API reference

> [!TIP]
> The read API is also described as an OpenAPI 3.1 spec in
> [`docs/openapi.yaml`](openapi.yaml). Clients can generate types from it,
> e.g. `npx openapi-typescript docs/openapi.yaml -o api.d.ts`. Its
> `info.version` goes up with every change to a response's shape.

Every route except `/callback` and `/auth/*` takes `Authorization: Bearer <token>`.

| Token | Reaches |
|---|---|
| `ADMIN_TOKEN`, or an `admin` [device token](setup.md#device-tokens) | Everything. |
| A `read` device token, or `READ_TOKEN` | `/api/*` only. Wrapped: presets and ranges already computed. |
| `CONTROL_TOKEN` | [`POST /control/play`](#playback-control) only. Not a device token: it reads nothing. |

Responses are JSON. Errors are `{ "error": "..." }` with:

| Status | Meaning |
|---|---|
| `400` | A bad parameter; the message says which. |
| `401` | Missing or wrong token, or a read token on a route outside `/api/*`. |
| `403` | A read token asked Wrapped for a range it may not compute. |
| `404` | `Not found`: no such route, or an optional one this deployment has switched off ([lyrics](#lyrics)). `/api/lyrics` also passes on Spicy Lyrics' own `404` for a song with no lyrics. |
| `429` | Spotify rate limit or quota (live routes), Spicy Lyrics' rate limit ([lyrics](#lyrics)), `Too many sign-ins in progress` from `/auth/login`, or `Too many sign-in requests` from any `/auth/*` route when `AUTH_RATE_LIMITER` is bound. |
| `500` | `Worker misconfigured: …` when a setting such as `ERAS` or `CONCERT_REGIONS` is malformed (the message names the setting, never its value); otherwise `Internal error`. |
| `502` | Any other Spotify failure (live routes), or a Spicy Lyrics failure ([lyrics](#lyrics)). |
| `503` | Either a stat or Wrapped range is still being computed, or (live routes only) the Spotify grant has lapsed. See below. |

Spotify failures (`429`, `502`) also carry `retry_after_seconds` when Spotify
gave one.

The two `503`s need different handling:

| | Still computing | Grant lapsed |
|---|---|---|
| Routes | `/api/stats/*`, `/api/wrapped` | `/api/now-playing`, `/api/recently-played`, `/api/top` |
| Headers | `Retry-After: <seconds>` | none |
| Body | `{ "error": "..." }` | `{ "error": "Spotify connection needs re-authorization.", "needs_reauth": true }` |
| What to do | Retry after `Retry-After` seconds. | Don't retry: the owner must [re-authorize](../README.md#re-authorizing). Stored-data routes keep working. |

Tell them apart by `needs_reauth` in the body (or a `Retry-After` header).

Dates are `YYYY-MM-DD` local calendar days; a date that doesn't exist
(`2026-02-30`) is a `400`. `tz` is an IANA zone, by default the warehouse's
own: `TIMEZONE`, else the latest era's zone, else `UTC` (the response's `tz`
says which). Ranges are inclusive and at most 3,660 local calendar days.
Timestamps in responses are UTC.

## Clients

These read the API, so a change to a response's shape can break them. Check
this table first, and bump `info.version` in [`openapi.yaml`](openapi.yaml).

| Repo | Routes it reads |
|---|---|
| [music-warehouse-gui](https://github.com/rcnsh/music-warehouse-gui) | Nearly all of `/api/*` |
| [music-warehouse-mcp](https://github.com/rcnsh/music-warehouse-mcp) | Nearly all of `/api/*` |
| [music-warehouse-spicetify](https://github.com/rcnsh/music-warehouse-spicetify) | `/api/plays`, `/api/home`, `/api/stats/*`, `/api/top-*`, `/api/wrapped`, `/api/wrapped/ranges`, `/api/concerts`, `/api/track`, `/api/artist`, `/api/on-this-day` |
| [music-warehouse-wrapped](https://github.com/rcnsh/music-warehouse-wrapped) | `/api/wrapped`, `/api/wrapped/ranges`, `/api/top` |

Browser clients (Spicetify, Wrapped) need their origin in
[`CORS_ORIGINS`](setup.md#configuration).

## Endpoints at a glance

| Method | Path | Purpose |
|---|---|---|
| `GET` | [`/api/plays`](#stored-plays) | Stored plays, newest first, with filters and paging. |
| `GET` | [`/api/plays.csv`](#stored-plays) | The same plays as one CSV download. |
| `GET` | [`/api/top-artists`](#stored-plays) | Play counts per artist over a date range. |
| `GET` | [`/api/top-tracks`](#stored-plays) | Play counts per song over a date range. |
| `GET` | [`/api/daily`](#stored-plays) | Plays per local day, week or month, optionally for one song or artist. |
| `GET` | [`/api/artist`](#history) | One artist's whole history. |
| `GET` | [`/api/track`](#history) | One song's whole history, editions folded. |
| `GET` | [`/api/on-this-day`](#history) | Top songs on this date in earlier years. |
| `GET` | [`/api/home`](#home) | Home-screen rows ranked from the history. |
| `GET` | [`/api/radio`](#radio) | Songs to queue after a song or artist, from what you play near it. |
| `GET` | [`/api/search`](#search) | Stored artists and songs by name. |
| `GET` | [`/api/stats/{name}`](#stats) | Cached aggregates safe to publish. |
| `GET` | [`/api/wrapped`](#wrapped) | A Wrapped-style summary of any finished range. |
| `GET` | [`/api/wrapped/ranges`](#wrapped) | The Wrapped presets. |
| `GET` | [`/api/concerts`](#concerts) | Upcoming Ticketmaster events for your top artists. |
| `GET` | [`/api/lyrics`](#lyrics) | Synced lyrics for a song, from Spicy Lyrics. Optional. |
| `GET` | [`/api/now-playing`](#live-from-spotify) | Spotify's currently-playing, live. |
| `GET` | [`/api/recently-played`](#live-from-spotify) | Spotify's recently-played, live. |
| `GET` | [`/api/top`](#live-from-spotify) | Spotify's top tracks and artists, live. |
| `POST` | [`/control/play`](#playback-control) | Start a track on the active Spotify device. |
| | [`/login`, `/callback`, `/auth/*`](#sign-in-and-authorization) | Authorizing ingestion and signing in. |
| | [`/health`, `/admin/*`](#admin) | Health, polling, imports, tokens and maintenance. Admin only. |

## Stored plays

These read only D1, so they keep working when the Spotify grant has lapsed.

**`GET /api/plays`**: plays, newest first, with track, album and artist names.

| Param | Default | |
|---|---|---|
| `limit` | `50` | 1 to 500. |
| `before` | none | The previous page's `next_before`, to page; or an epoch-ms, for plays strictly before that millisecond. |
| `after` | none | Only plays after this epoch-ms. |
| `q` | none | Only plays whose track, album or any artist name contains this, ignoring case and accents (at most 200 characters). Pages with `before` like the unfiltered list, and the response echoes `q`. |
| `track_id` | none | Only plays of this song: every edition, folded as `/api/track` folds them (same title less any remaster, "single version" or "radio edit" tag, and same primary artist). Any edition's id works. |
| `artist_id` | none | Only plays credited to this artist as `/api/artist` credits them: primary artist only, export `name:` placeholders with the same name included. |
| `artist_name` | none | The artist by name, as `/api/artist`'s `name`: a fallback for an artist the warehouse has no id for (`/api/search` gives `id: null`). |

To page, pass each response's `next_before` back as `before` (URL-encoded)
until it is `null`. It is an opaque cursor that resumes after exactly the last
play returned, ordered by time and then track id, so plays sharing a
millisecond are neither skipped nor repeated.
Passing the last `played_at_ms` still works, but skips any plays that share
its millisecond and didn't fit on the page.

The filters combine (each narrows the last) and work with `before`, `after`
and `limit`. Each one given is echoed at the top level of the response, as
`q` is:

```json
GET /api/plays?artist_id=4NJhFmfw43RLBLjQvxDuRS&q=shelter&limit=1
{ "q": "shelter", "artist_id": "4NJhFmfw43RLBLjQvxDuRS",
  "plays": [ { "played_at_ms": 1760521802000, "track_id": "…", "track_name": "Shelter", "…": "…" } ],
  "next_before": "1760521802000.4cOdK2wGLETKBW3PvgPWqT",
  "_meta": { "rows_read": 1507, "duration_ms": 18.4 } }
```

`track_id` and `artist_id` sort only that song's or artist's plays rather
than walking everyone's.

```json
{ "plays": [ { "played_at_ms": 1760521802000, "track_id": "…", "track_name": "Shelter",
               "artists": "Porter Robinson, Madeon", "album_name": "Shelter", "image_url": "https://i.scdn.co/…",
               "duration_ms": 219000, "isrc": "…", "context_uri": "spotify:playlist:…", "context_type": "playlist",
               "context_name": "Morning Mix", "source": "api", "play_number": 96, "first_play": false,
               "artist_list": [ { "id": "3dz0NnIZhtKKeXZxLOxCam", "name": "Porter Robinson" },
                                { "id": "5LhTec3c7dcqBvpLRWbMcf", "name": "Madeon" } ] } ],
  "next_before": "1760521802000.4cOdK2wGLETKBW3PvgPWqT",
  "_meta": { "rows_read": 50, "duration_ms": 1.2 } }
```

<details>
<summary>Field notes: <code>artist_list</code>, <code>source</code>, <code>context_name</code>, <code>play_number</code>, and the cost of <code>q</code></summary>

`artist_list` holds every credited artist in credit order, each with its id,
so a client can link them without splitting `artists` (which is the same
names joined with `, `, and so can't tell "Tyler, The Creator" from two
artists). An id may be an imported play's `name:` placeholder, which
`/api/artist?id=` accepts. A track with no stored credits has
`"artists": null` and `"artist_list": []`. Both come from the same read of
the credits, so they cost no more than `artists` did alone.

`source` is `api` for polled plays and `export` for imported ones.

`context_name` is the name of the album, artist or playlist the play was
started from, or `null` when there was none or it isn't known (yet). Albums
and artists are named from the warehouse's own tables. Everything else is
asked of Spotify by the poll, three a poll, so a backlog drains over a few
polls; a playlist name is refreshed weekly. Spotify refuses third-party apps
many editorial and algorithmic playlists ("Discover Weekly", "Daily Mix"):
those stay `null` and are asked again every 30 days, as do private playlists
if the grant lacks `playlist-read-private` (the Worker doesn't ask for it).
Migration 0013 lists every context already stored. Export plays carry no
context.

When an album or artist runs out, Spotify autoplay carries on and Spotify
keeps reporting the old album or artist as the context of what it picks. So
a play whose album context isn't the track's album, or whose artist context
isn't one of its artists, has all three `context_*` fields `null` here, and
`/api/home` counts it under the track's own album. `/api/plays.csv` keeps
the stored context. Playlist contexts can't be checked and are kept.

`play_number` says which play of its song this was, counting every edition
the way `/api/track` folds them (same title and primary artist, ignoring
ASCII case), and `first_play` is `true` for a song's first ever play. Both are
`null` for a play that has no row in that table, such as one with no stored
track. They come from a table kept up to date by every poll and import
so they cost one row read per play; an import of older plays renumbers the
later plays of each song it touches. A track whose title or primary artist changes (the daily artist
reconcile can do this) moves to its new song by the next daily sweep.

With `q`, names are matched through a trigram index. One- and two-character
queries can't use the index and scan the name tables instead, matching
case-insensitively for ASCII only. The matching
track ids are cached at the edge for five minutes per query, so the pages
after the first skip that step. A track stored since
then shows up at once; a renamed one can take those five minutes.

</details>

**`GET /api/plays.csv`**: the same plays as one CSV download, newest first,
for a spreadsheet or a backup. Takes `/api/plays`' filters (`q`, `track_id`,
`artist_id`, `artist_name`, `before` as an epoch-ms or a `next_before` cursor,
`after`) and a local-date range: `from`
and `to` with `tz`, as `/api/daily` takes them. Give neither for the whole
history; with only one, the other takes `/api/daily`'s default. No `limit`:
it streams every matching play, 10,000 per D1 query, so the Worker holds one
page at a time, and looks up each track's names once per download. At most
two queries per page means the Workers Paid plan (1,000 queries a request)
reaches five million plays, the Free plan (50) about 240,000.

```csv
played_at,track,artists,album,track_id,context_uri,context_name,source
2026-10-15T09:50:02.000Z,Shelter,"Porter Robinson, Madeon",Shelter,4cOdK2wGLETKBW3PvgPWqT,spotify:playlist:…,"Mix, Vol. 1",api
```

Quoting follows RFC 4180 and lines end in CRLF. `played_at` is UTC; `artists`
lists every credited artist. A bad parameter is a `400` before anything
streams. It reads about seven rows per play (the joins to names).

**`GET /api/top-artists`**: play counts per artist, every credited artist on
a track getting the play. Artists are grouped by name, ignoring case, so an
export placeholder (`name:` id) counts with the real artist; `artist_id` is
the real id where one is known. Params: `from` (default 29 days ago), `to`
(default today), `tz`, `limit` (1 to 500, default 50).

```json
GET /api/top-artists?from=2026-10-01&to=2026-10-14&tz=Europe/London&limit=1
{ "from": "2026-10-01", "to": "2026-10-14", "tz": "Europe/London",
  "artists": [ { "artist_id": "3dz0NnIZhtKKeXZxLOxCam", "name": "Porter Robinson", "plays": 41 } ],
  "_meta": { "rows_read": 1212, "duration_ms": 3.4 } }
```

**`GET /api/top-tracks`**: play counts per song, editions folded (same title,
less a remaster, "single version" or "radio edit" tag, and same primary
artist). Same params as `/api/top-artists`. Returns
`{ from, to, tz, tracks: [{ id, name, artist, plays, image }] }`; `id` is the
most-played edition's. It has no `_meta`: the rows it read are in the
`X-Rows-Read` header.

**`GET /api/daily`**: plays per local day, quiet days as `0`. Params: `from`,
`to`, `tz`, as above, and `track_id`, `artist_id` and `artist_name` as on
`/api/plays`, for one song's or one artist's daily chart. A filter given is
echoed. `group_by=week` sums the days into `weeks` (`{ week, plays }`, local
weeks from Monday, each labelled with its Monday, which may fall before
`from`) and `group_by=month` into `months` (`{ month: "YYYY-MM", plays }`);
either replaces `days` and echoes `group_by`. The default, `day`, leaves the
body as below. Filtered, it reads only that song's or artist's plays in the
range.

```json
GET /api/daily?from=2026-10-01&to=2026-10-02&tz=Europe/London&track_id=…
{ "from": "2026-10-01", "to": "2026-10-02", "tz": "Europe/London", "track_id": "…",
  "days": [ { "day": "2026-10-01", "plays": 3 }, { "day": "2026-10-02", "plays": 0 } ],
  "_meta": { "rows_read": 214, "duration_ms": 1.1 } }
```

## History

**`GET /api/artist?id=&name=&tz=`**: one artist's whole history. Give `id`, `name`
or both; `name` catches plays imported from the export.

**`GET /api/track?id=&tz=`**: the same for one song, all editions folded together.

**`GET /api/on-this-day?date=&tz=`**: the top songs on this date in each
earlier year. `date` defaults to today in `tz`.

```json
GET /api/artist?id=4NJhFmfw43RLBLjQvxDuRS&tz=Europe/London
{ "artist": { "id": "4NJhFmfw43RLBLjQvxDuRS", "name": "Porter Robinson" },
  "plays": 812, "minutes": 2410,
  "first_played": "2020-07-03T21:14:02.000Z", "last_played": "2026-10-12T13:40:11.000Z",
  "months": [ { "month": "2020-07", "plays": 14 } ],
  "top_tracks": [ { "id": "…", "name": "Shelter", "plays": 96, "image": "https://i.scdn.co/…" } ] }

GET /api/on-this-day?date=2026-10-13&tz=Europe/London
{ "date": "2026-10-13",
  "years": [ { "year": 2025, "plays": 41,
               "top_tracks": [ { "id": "…", "name": "…", "artist": "…", "image": "…", "plays": 6 } ] } ] }
```

An unknown artist or song is a `200` with zero plays and `null` dates, never a
`404`. `minutes` is an estimate (see [design notes](design.md#wrapped)).

## Home

**`GET /api/home?tz=`**: the rows of a client's home screen, ranked from the
whole history: `shortcuts` (played most, lately and at this time of day),
`jump_back_in` (newest first), `around_now` (what you play at this hour) and
`rediscover` (played on many days, but not in the last 90). Each item is a
playlist, album or artist; plays with no context count toward their track's
album, and Liked Songs toward nothing. Rows can overlap: show each item once,
in this order. How it ranks: [design notes](design.md#home).

```json
GET /api/home?tz=Europe/London
{ "tz": "Europe/London", "hour": 20,
  "shortcuts": [ { "uri": "spotify:album:…", "type": "album", "name": "…", "image": "https://i.scdn.co/…",
                   "artist": "…", "sessions": 14, "last_played_ms": 1760554020000 } ],
  "jump_back_in": [], "around_now": [], "rediscover": [] }
```

`name` and `image` are `null` when the warehouse doesn't know them (playlists
and artists have no image here, and some playlists no name), so a client looks
those up itself. `artist` is an album's or artist page's primary artist.
`sessions` is how many times it was played from (for `rediscover`, on how many
days).

## Radio

**`GET /api/radio?track=&limit=`** or **`?artist=&limit=`**: songs to queue
after a seed song or artist, ranked from what you play near it, since
Spotify's Web API no longer gives apps recommendations or related artists.
Give exactly one of `track` (any edition's id; every edition counts as the
seed and is left out) or `artist` (an id; its own songs stay in, so its radio
opens with them). `limit` is 1 to 100, default 40.

```json
GET /api/radio?track=4Ko4nB4mGsDH4W9ocqCVvA
{ "seed": { "type": "track", "id": "4Ko4nB4mGsDH4W9ocqCVvA", "name": "…", "artist": "…" },
  "tracks": [ { "id": "…", "name": "…", "artist": "…", "artist_id": "…", "album": "…",
                "image": "https://i.scdn.co/…", "sessions": 12, "score": 1.874 } ] }
```

Songs played within 45 minutes of the seed's plays score by how close and how
recent, once per listening session, damped by how much they're played
overall; at most three per primary artist. `sessions` is how many of the
seed's sessions the song was played in; `score` only orders the list. `id` is
the edition played most near the seed. An artist seed's `seed` has no
`artist`. A seed never played (or unknown) is a `200` with no tracks, never a
`404`. How it ranks: [design notes](design.md#radio).

## Search

**`GET /api/search?q=&artist=&limit=`**: stored artists and songs whose name
contains `q`, case-insensitively, to find the `id` or `name` the history
routes take. `artist` narrows songs to a primary artist whose name contains
it. `limit` is 1 to 50 per list, default 10. Exact matches come first, then
the most played.

```json
GET /api/search?q=shelter
{ "q": "shelter",
  "artists": [],
  "tracks": [ { "id": "…", "name": "Shelter", "artist": "Porter Robinson", "plays": 96 } ] }
```

Results fold as the history routes do: an artist's plays from the export join
the real id (`id` is `null` when only the export knows the artist, so pass the
`name` to `/api/artist`), and a song's editions count once. `plays` credits
the primary artist only. Matching is ASCII-case-insensitive, as SQLite's is.

Queries of three or more characters take their candidates from the trigram
index. One- and two-character queries scan the name tables, so short names
such as "U2" are still found, but count plays only for the 100 artist names
and 200 titles that match best (exact, then prefix, then a word's prefix,
then shortest), and rank those by plays; their answers are kept for five
minutes, so their `plays` can lag a poll or two.

## Stats

**`GET /api/stats/{name}`**: aggregates built to be safe to publish: no play
rows, and no date finer than a month except on-repeat's whole local days.
Each body's `as_of` is the cut-off its data runs up to. No parameters.

| `name` | Holds |
|---|---|
| `on-repeat` | Songs and albums you're playing far more than usual, over the last 14 days. |
| `rhythm` | Listening streaks and plays by hour. |
| `top-over-time` | Top artists and songs per quarter and year. Each song has a `track_id`: its most-played edition in that period, which `/api/track` opens as the whole song. |
| `eras` | How your artists changed between the two eras. |
| `albums` | Most-played albums, all time and per year. |

Each covers data up to a cut-off and is recomputed in the background about six
hours after the next one passes, so late plays still count:

| Stat | Cut-off |
|---|---|
| `on-repeat` | Local midnight (daily) |
| `rhythm`, `top-over-time`, `albums` | Start of the local week (weekly) |
| `eras` | Start of the UTC month (monthly) |

Imported history shows up at each stat's next cut-off. The first
request for a stat can get `503` with `Retry-After` while it computes.
`X-Stats-Source` and `X-Stats-Computed-At` say where the body came from.

## Wrapped

**`GET /api/wrapped?from=&to=`**: a Spotify-Wrapped-style summary of any
range that has ended (`to` before today): minutes, top artists, songs and
albums, biggest day, streak, listening by hour and weekday, each month's top
artist and song, discoveries, and a listening age. The first request for a
range takes a few seconds; a concurrent one gets `503` with `Retry-After`.
An admin token can wrap any range; a read token (or `READ_TOKEN`) gets `403`
for a range that is neither a preset nor already computed.

Songs and artists carry ids for `/api/track` and `/api/artist`. A song's
`track_id` is its most-listened edition, which `/api/track` folds back into
the whole song. An artist's id is a real Spotify id when any of its plays has
one, else the import's `name:` placeholder.

| Field | Id fields added |
|---|---|
| `top_artists[]` | `id`, `top_song_id` |
| `top_songs[]` | `track_id`, `artist_id` |
| `top_albums[]` | `artist_id` |
| `months[]` | `top_artist_id`, `top_song_id` (null when `top_artist`/`top_song` is) |
| `discoveries.top[]` | `id` |

```json
{ "top_songs": [ { "track_id": "6PCUP3dWmTjcTtXY02oFdT", "name": "Castle on the Hill", "artist": "Ed Sheeran",
                   "artist_id": "6eUKZXaKkcviH0Ku9w2n3V", "album": "÷", "plays": 149, "…": "…" } ],
  "months": [ { "month": "2025-01", "minutes": 2210, "top_artist": "Ed Sheeran", "top_artist_id": "6eUKZXaKkcviH0Ku9w2n3V",
                "top_song": "Castle on the Hill", "top_song_id": "6PCUP3dWmTjcTtXY02oFdT", "image": "https://i.scdn.co/…" } ] }
```

**`GET /api/wrapped/ranges`**: the presets, newest first: each year with plays,
and this year up to the last full week.

```json
{ "ranges": [
  { "from": "2026-01-01", "to": "2026-10-11", "label": "2026 so far", "kind": "year_to_date", "computed": true },
  { "from": "2025-01-01", "to": "2025-12-31", "label": "2025", "kind": "year", "computed": false } ] }
```

## Concerts

Optional, and off until you set a Ticketmaster key and at least one region
(see [Setting up concerts](optional-features.md#setting-up-concerts)). While it's off,
`/api/concerts` answers `404 { "error": "Not found" }`, the same as a route the
Worker doesn't have, so a client can hide concerts rather than show an empty
list, and the daily check doesn't run. A client can probe with
`GET /api/concerts?region=-`: `400` means on, `404` off, and neither reads the
database.

**`GET /api/concerts?region=&since=&tz=`**: upcoming Ticketmaster music
events in the regions you configure, for the 80 artists you played most over
the last year. Soonest first. `region` is one of the configured keys; `since`
(a local date, in `tz`) keeps only events first seen on or after it, which is
how to ask what's new. `tz` is read only alongside `since`. `regions` lists
the configured keys with their labels.

Regions come from `CONCERT_REGIONS` ([format](optional-features.md#setting-up-concerts)).

```json
{ "regions": [ { "key": "uk", "label": "United Kingdom" }, { "key": "nyc", "label": "New York" } ],
  "checked": { "uk": "2026-10-15T01:23:04.000Z", "nyc": "2026-10-15T01:23:05.000Z" },
  "concerts": [ { "region": "nyc", "date": "2027-02-12", "time": "20:00", "artists": "Maroon 5",
                  "artist_list": [ { "id": "04gDigrS5kc9YWfZHwBETP", "name": "Maroon 5" } ],
                  "name": "Maroon 5 2027 Tour", "venue": "Madison Square Garden", "city": "New York",
                  "status": "onsale", "url": "https://www.ticketmaster.com/…", "first_seen": "2026-10-15T01:23:04.000Z" } ] }
```

`artists` names the billed artists you play, joined with `, `; `artist_list`
holds the same artists one by one with their ids for `/api/artist` (a real
Spotify id where one is stored, else the import's `name:` placeholder). When
the bill Ticketmaster returns names none of your matched artists, both list
Ticketmaster's names instead, with `"id": null`.

A daily cron (01:23 UTC) refreshes it; `POST /admin/concert-check` runs it
now. Each artist is matched to a Ticketmaster attraction by exact name
(ignoring case, accents and `&`) at most 25 a day, and the answer kept, so the
first few days fill in gradually. An act whose name Ticketmaster spells
differently is missed rather than guessed at; [pin it](#admin) instead. Events
Ticketmaster stops listing (past, cancelled) drop out, as do rows for a region
taken out of `CONCERT_REGIONS`. A region with more than 600 events is read up
to the date its third page reaches, and later events keep their rows (and
`first_seen`) until a run reaches them. A 429 is retried after its
`Retry-After` when that is short (30 s a run in all); the last run, and the
last failure, are kept, shown under
`concerts` in `/health`, and two failed runs in a row raise the
`concert_check_failing` [alert](operations.md#alerting). New events themselves are not
pushed.

## Lyrics

Optional, and off until you [set a key](optional-features.md#setting-up-lyrics). **`GET /api/lyrics?track=<Spotify track id>`**
fetches the song's synced lyrics from the [Spicy Lyrics API](https://developers.spicylyrics.org)
with your deployment's secret key, so a client needs no
lyrics key of its own, and nothing that can be lifted out of an app.

The answer is Spicy Lyrics' own, passed through byte for byte with its status:

| Status | Body | Means |
|---|---|---|
| `200` | Spicy Lyrics' `{ "Body": { "Type", "Content", "source", "UploadAttribution"?, … }, "Status": 200 }` | The lyrics. Parse it as Spicy Lyrics documents it. |
| `404` | Spicy Lyrics' `{ "Body": { "error": "lyrics_not_found", … } }` | No lyrics for this song. |
| `404` | `{ "error": "Not found" }` | Lyrics are off on this deployment (no key), the same answer as a route it doesn't have. Tell the two `404`s apart by the body. |
| `400` | `{ "error": "…" }` | `track` is missing or isn't a 22-character Spotify id. Checked before Spicy Lyrics is asked. |
| `429`, `503` | Spicy Lyrics' error, with its `Retry-After` | Spicy Lyrics asked for a pause. Until it passes, the Worker answers `429` itself without asking again. |
| `502` | `{ "error": "Lyrics upstream: key rejected" }` or another `Lyrics upstream: …` | Spicy Lyrics refused the key (revoked, paused application) or failed. Its error code is in the Worker log; the key never is. |
| `500` | `{ "error": "Worker misconfigured: SPICY_LYRICS_SECRET_KEY …" }` | The key is a publishable one (`sl_pk_…`). |

Responses also carry `X-Cache` (`hit` or `miss`), `Age` (seconds since the
Worker fetched the body; a client that keeps lyrics should count it toward the
30-day cap in [Spicy Lyrics' terms](optional-features.md#setting-up-lyrics)) and Spicy Lyrics' `RateLimit-*` headers on a miss. A client
can probe for the feature with `GET /api/lyrics` and no `track`: `400` means
on, `404` off, and neither calls Spicy Lyrics.

**Caching.** Lyrics are kept in the Cache API for 7 days and "no lyrics" for
1 day, per Cloudflare location (a colo may drop them sooner). Only `200` and
Spicy Lyrics' `404` are kept; errors never are.

## Live from Spotify

These proxy Spotify with the stored grant, so a client needs no Spotify
credentials of its own. They fail with `503 { needs_reauth: true }` when the
grant has lapsed.

| Route | |
|---|---|
| `GET /api/now-playing` | `{ item }`, Spotify's currently-playing; `item` is `null` when idle. |
| `GET /api/recently-played?limit=` | Spotify's recently-played, newest first. `limit` 1 to 50, default 1. Includes plays not yet ingested. |
| `GET /api/top?range=&limit=&type=` | `{ tracks, artists }` from Spotify's top lists. `range` is `short_term`, `medium_term` or `long_term` (default); `limit` 1 to 50, default 12; `type=tracks` or `type=artists` fetches only one (the other is `null`). |

A bad `limit`, `range` or `type` is a `400`, as on the other routes, checked
before Spotify is asked.

Spotify's development-mode quota is shared by every app on the owner's
developer account, so these spend it carefully:

- **One answer for everyone.** `/api/now-playing` keeps Spotify's answer in D1
  for a minute when nothing is playing, and while a track plays until about
  2 s after it should end, at least 10 s and at most 30 s.
  `/api/recently-played` keeps one page of 50 for a minute and gives each
  request its first `limit` (with `limit`, `href`, `next` and `cursors.before`
  to match). `/api/top` does the same per list and range, for an hour, as
  Spotify recomputes top lists about daily. Each colo keeps a copy for up to
  10 s in front of D1. `X-Cache` says `hit`, `miss` or `stale`.
- **One pause after a 429.** Any 429 from Spotify, on any route, the poll,
  context names or a backfill, pauses every Spotify call until its
  `Retry-After` has passed (a minute without one, an hour for
  `quota_exceeded`, a day at most); a later 429 only ever extends it. Until
  then nothing is sent and no token is refreshed: these routes answer `429`
  with `Retry-After` set to the time left, except that a route with a kept
  answer serves it with `X-Cache: stale`. The
  poll is skipped, not failed, and the cursor waits.
- **Every call counted.** Each request sent to `api.spotify.com` is counted
  per hour by what sent it and how Spotify answered, kept 14 days, and summed
  under `spotify` in [`/health`](operations.md#health).

## Playback control

`POST /control/play` with `{ "track_id": "<22-character Spotify id>" }` starts
that track, inside its album, on whichever Spotify device is playing or last
played, through Spotify Connect. Only `CONTROL_TOKEN` and the admin token reach it; a read
token gets `401`, so handing out read tokens never hands out control of the
owner's speakers. It is outside `/api/*`, so it never gets CORS headers: call
it from a server.

| Status | Body |
|---|---|
| `200` | `{ "playing": "<track_id>" }` |
| `400` | Not JSON, or no valid `track_id`. Spotify is not asked. |
| `409` | `{ "reason": "no_active_device" }`: open Spotify somewhere first. |
| `403` | `{ "reason": "premium_required" \| "missing_scope" \| "forbidden" }`. `missing_scope` means the grant lacks `user-modify-playback-state`: [re-authorize](../README.md#re-authorizing). |
| `429`, `502`, `503` | As for the [live routes](#live-from-spotify): paused after a 429, Spotify failed, grant lapsed. |

The track starts inside its album, which plays on after it: Spotify accepts a
bare track and then plays nothing. The album is the stored one, or for a track
stored without one, asked of Spotify first. Each Spotify request is counted as
`play` in `/health`.

A play drops the shared `/api/now-playing` answer, which still names the old
track, and 2 s later, once Spotify reports the new one, fetches it again (one
more call, counted as `now-playing`).

## Sign-in and authorization

These take no token.

| Route | |
|---|---|
| `GET /callback` | Spotify's redirect target for [authorizing](../README.md#authorizing) ingestion. Guarded by its single-use `state`. |
| `GET /auth/login?name=&return_to=&code_challenge=` | [Sign in with Spotify](#signing-in-from-an-app): the confirmation page. |
| `POST /auth/login` | Form `state`, `decision` (`allow` or `cancel`), from the confirmation page's own form. |
| `GET /auth/callback` | Spotify's redirect target for sign-in. |
| `POST /auth/token` | Body `{ code, code_verifier }`; exchanges a sign-in code for a read token. |

## Signing in from an app

A client gets a read token by [signing in with Spotify](setup.md#signing-in-with-spotify)
as the warehouse's owner. It works like OAuth with PKCE
([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)). `return_to` can be:

| Kind | `return_to` | Exchange |
|---|---|---|
| Web app | A URL on an origin listed in `CORS_ORIGINS` | From that origin, in the browser. |
| Desktop app or CLI | `http://127.0.0.1:<any port>/…` or `http://[::1]:<any port>/…`, where the app listens | From the app; no `Origin`. |
| Mobile app | `<scheme>://…`, with the scheme listed in `SIGN_IN_SCHEMES` | From the app; no `Origin`. |

`localhost` is refused; use the IP literal
([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252#section-8.3)).

1. Generate a random `code_verifier` (43 to 128 characters of
   `A-Z a-z 0-9 - . _ ~`) and keep it, e.g. in `sessionStorage`.
   `code_challenge` is base64url(SHA-256(verifier)), without padding.
2. Send the browser to
   `/auth/login?name=<device>&return_to=<url on your origin>&code_challenge=<challenge>`.
   It shows the confirmation page; the owner presses Allow and approves at
   Spotify.
3. The browser comes back to `return_to` with `?code=…`, or with `?error=`:
   `access_denied` (Cancel, a refusal at Spotify, or a sign-in finished in
   another browser), `not_owner` or `unavailable`.
4. Within 60 seconds, `POST /auth/token` with
   `{ "code": "…", "code_verifier": "…" }`. The response is the minted token,
   as from `POST /admin/tokens`.

A code works once, even if the exchange fails, and only alongside the verifier
that produced its challenge. A failed exchange always answers
`400 { "error": "invalid_grant" }`.

## Admin

`ADMIN_TOKEN` (or an `admin` device token) only.

| Route | |
|---|---|
| `GET /` | Lists the routes. |
| `GET /login` | `302` to Spotify's consent page. Use `npm run authorize`. |
| `GET /health` | Whether ingestion is working. See [Health](operations.md#health). |
| `POST /admin/poll` | Poll now, exactly as the cron does. |
| `POST /admin/import` | Body: an array of export records, or `{ "records": [...] }`. Returns `{ inserted, duplicates, skipped, short }`. `match_window_s` (default 5, 0 to 30) sets how close a stored play of the same track must be to count as the same play. `dry_run=1` writes nothing and returns `new`, `new_plays_ms` and `duplicate_offsets_ms` instead. Use `npm run import`. |
| `POST /admin/cleanup/skips?apply=1` | Body: export records, as for `/admin/import`. Removes the stored export plays they show to be skips. Use `npm run clean:export`. |
| `POST /admin/cleanup/short-gaps?apply=1&before=&before_track=&limit=` | One page of export plays that ended under 30 s after the play before, newest first. |
| `POST /admin/cleanup/overlaps?apply=1&after=&after_track=&limit=` | One page of export plays within 5 s of a polled play of the same track; `gaps` buckets every pair within 30 s. |
| `POST /admin/backfill-albums?source=&range=&offset=&pages=` | One step of `npm run backfill:albums`. |
| `POST /admin/backfill-catalog?after=&limit=&spacingMs=` | One step of `npm run backfill:catalog`. |
| `POST /admin/alert-check?force=1` | Run the alert sweep now. `force=1` ignores the 24-hour resend window. |
| `POST /admin/concert-check?spacingMs=` | Run the [concert](#concerts) check now. `spacingMs` (default 250) spaces Ticketmaster calls. |
| `GET /admin/concert-artists?unmatched=1` | What each top artist matched on Ticketmaster; `unmatched=1` lists only the misses. |
| `PUT /admin/concert-artists` | Body `{ "name": "Kanye West", "attraction_id": "K8vZ9175Oy7" }` pins a name to an attraction (find ids at <https://developer.ticketmaster.com/api-explorer/>); `"attraction_id": null` blocks a wrong match. Pins are never re-matched. `DELETE` with `{ "name" }` unpins. |
| `GET /admin/raw?after=` | Spotify's unmodified recently-played payload. Read-only. |
| `POST /admin/rollup?rebuild=1` | Bring the [play-count rollup](setup.md#the-play-count-rollup) up to date with the configured zone now, as the daily cron does; `rebuild=1` rebuilds it even if nothing changed. Returns `{ time_zone, rebuilt, usable, horizon_ms }`. |
| `POST /admin/tokens` | Body `{ name, access?, expires_in_days? }`. Mints a [device token](setup.md#device-tokens), returned once. |
| `GET /admin/tokens` | Every device token: `id`, `name`, `access`, `created_ms`, `expires_ms`, `last_used_ms`, `revoked_ms`, `active`. |
| `DELETE /admin/tokens?id=` | Revokes a device token. |
