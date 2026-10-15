# music-warehouse

A Cloudflare Worker that keeps your Spotify play history in a D1 database you
own, so it outlives Spotify's 50-play `recently-played` window. Every 30
minutes it polls Spotify and stores new plays; a bearer-authenticated JSON API
serves them back, along with stats, a year-in-review and per-artist history.
There is no UI. [music-warehouse-wrapped](https://github.com/rcnsh/music-warehouse-wrapped)
is one client.

- [Requirements](#requirements)
- [Setting it up from scratch](#setting-it-up-from-scratch)
- [Authorizing](#authorizing)
- [Device tokens](#device-tokens)
- [Importing your history](#importing-your-history)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Operations](#operations)
- [Development](#development)
- [Design notes and limitations](docs/design.md)

## Requirements

- A Spotify account with **Premium**. A development-mode Spotify app only works
  for an owner with Premium; without it, only the export import works.
- A Cloudflare account. The free Workers and D1 plans are enough.
- Node.js 20 or later.

## Setting it up from scratch

### 1. Create the Spotify app

1. At <https://developer.spotify.com/dashboard>, create an app with the Web API.
2. Add two redirect URIs: `https://<your-worker-host>/callback` for
   ingestion and `https://<your-worker-host>/auth/callback` for
   [signing in](#signing-in-with-spotify). Locally, also add the same two paths
   on `http://127.0.0.1:8787` (Spotify allows plain HTTP only on loopback).
3. Under **User Management**, add your own Spotify account (development mode
   allows five users).
4. Note the **client ID** and **client secret**.

While you're there, request your **Extended streaming history** at
<https://www.spotify.com/account/privacy/>. Not "Account data", which only
covers a year. It can take up to 30 days to arrive, and it is the only way to
get plays from before the Worker existed.

### 2. Configure the deployment

```bash
git clone https://github.com/rcnsh/music-warehouse && cd music-warehouse
npm install
npx wrangler login
```

Three values in [`wrangler.jsonc`](wrangler.jsonc) belong to the original
deployment. They are marked `[1]` to `[3]` in the file:

1. **`routes`**: your custom domain, or delete the block to deploy to
   `music-warehouse.<subdomain>.workers.dev`.
2. **`database_id`**: from the next step.
3. **`vars.SPOTIFY_REDIRECT_URI`**: the redirect URI from step 1, exactly.

Listening stats and Wrapped read local time in one timezone, `TIMEZONE`
(default UTC), and start at your first stored play. If you've lived in more
than one zone, set `ERAS` instead: a JSON list of periods, each with its own
timezone, for example

```json
[{ "key": "home", "label": "Home", "timeZone": "Europe/London", "from": "2020-07-01T00:00:00+01:00" },
 { "key": "abroad", "label": "Abroad", "timeZone": "Asia/Tokyo", "from": "2024-09-01T00:00:00Z" }]
```

`key` is lowercase letters, digits and `-`, and appears in stats responses;
`label` is for display. Every era after the first needs `from`. On the first,
`from` is optional and also marks where history starts, which helps if your
first few plays are noise. The `eras` stat compares the latest era with the
months before it. Set `ERAS` as a secret if an era's start is private: the
stats only publish the month. See [`src/eras.ts`](src/eras.ts). Ingestion and
the other routes don't depend on it.

### 3. Create the database

```bash
npx wrangler d1 create music_warehouse     # copy the id into wrangler.jsonc
npm run migrate:remote
npm run migrate:local                      # for wrangler dev and tests
```

### 4. Deploy and set secrets

```bash
npx wrangler deploy
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN        # paste the output of: openssl rand -hex 32
npx wrangler secret put READ_TOKEN         # optional, same again
```

The optional ones are in [Configuration](#configuration). For local work, copy
`.dev.vars.example` to `.dev.vars` and fill it in. It is gitignored; keep it at
mode 600.

### 5. Block unauthenticated traffic (recommended)

Every route but `/callback` needs a token, but unauthenticated requests still
reach the Worker. On the Free plan they count against its 100,000 requests a
day, which the ingestion cron shares; on Workers Paid they are only noise. A WAF custom rule (Security → WAF → Custom rules, action **Block**)
stops them at the edge:

```txt
(http.host eq "your-host.example" and http.request.uri.path ne "/callback" and not starts_with(http.request.uri.path, "/auth/") and http.request.method ne "OPTIONS" and not len(http.request.headers["authorization"][0]) > 0)
```

`/callback` stays open for Spotify's redirect, which its single-use `state`
guards. `/auth/*` stays open for [signing in](#signing-in-with-spotify), which
is how a device without a token gets one; a rate-limiting rule on
`/auth/` is a sensible extra. `OPTIONS` stays open for browser clients' CORS preflights, which never
carry the header; drop that clause if you don't set `CORS_ORIGINS`.

Then [authorize](#authorizing).

## Authorizing

Nothing is ingested until you approve Spotify's consent screen. `/login` needs
the admin token, so a script fetches the consent URL for you rather than you
opening `/login` in a browser:

```bash
export WORKER_URL=https://your-host.example
export ADMIN_TOKEN=...                       # or: set -a && . ./.dev.vars && set +a
npm run authorize -- --url "$WORKER_URL" --open
```

| Flag | Default | |
|---|---|---|
| `--url` | `http://127.0.0.1:8787` | The Worker. |
| `--open` | off | Open the consent URL in your browser instead of only printing it. |
| `--waitSeconds` | `300` | How long to poll `/health` for the callback to land. |

Approve in the browser. Spotify redirects to `/callback`, which stores the
grant, and the script reports the new expiry. The consent URL is single-use and
expires after 10 minutes. Then start the first poll rather than waiting for the
cron:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/admin/poll"
```

### Re-authorizing

Spotify expires the grant **six months after authorization**, and refreshing
does not extend it. When it lapses, polling stops, `/health` reports
`needs_reauth` with an `action_required` line, and the [alert](#alerting) fires.
`/health` also warns from 14 days before. Run the same `npm run authorize`
again; the six months restart. Adding a scope to `SCOPE` in `src/spotify.ts`
also needs a re-authorization.

## Device tokens

Give each device or client its own token rather than copying `ADMIN_TOKEN`
around. A lost phone then costs one revocation, and a client that only reads
never holds a credential that can write.

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name": "iPhone Wrapped"}' "$WORKER_URL/admin/tokens"
```

The response holds the token, `mw_` and 43 characters. It is shown **once**;
only a hash is stored.

| Field | Default | |
|---|---|---|
| `name` | required | 1 to 64 characters, to recognise it in the list. |
| `access` | `read` | `read` reaches `/api/*`; `admin` reaches everything. |
| `expires_in_days` | `90` | 1 to 3660, or `null` for a token that never expires. |

`GET /admin/tokens` lists them with when each was last used (to the hour), and
`DELETE /admin/tokens?id=tok_…` revokes one immediately. Revoked tokens stay
in the list.

### Signing in with Spotify

A device can also get a **read** token by signing in with the Spotify account
that owns the warehouse (the one that [authorized](#authorizing) ingestion).
Any other Spotify account is refused. Sign-in never mints admin tokens, and it
never touches the ingestion grant: it asks Spotify for no scopes and discards
what Spotify returns once it has read the account id. Tokens it mints expire
after 90 days and show `created_via: "spotify"` in the list.

**In a browser, for a shell or script:** open
`$WORKER_URL/auth/login?name=laptop`, approve, and copy the token from the
page. It is shown once.

**From an app**, it works like OAuth with PKCE
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
3. Spotify sends it back to `return_to` with `?code=…`, or with `?error=`:
   `access_denied`, `not_owner` or `unavailable`.
4. Within 60 seconds, `POST /auth/token` with `{ "code": "…", "code_verifier": "…" }`. The
   response is the minted token, as from `POST /admin/tokens`.

A code works once, even if the exchange fails, and only alongside the verifier
that produced its challenge. A failed exchange always answers
`400 { "error": "invalid_grant" }`.

A warehouse authorized before sign-in existed learns its owner's account id on
the first sign-in, from the stored grant.

Keep `ADMIN_TOKEN` in a password manager as the way back in if every device
token is lost. Once nothing uses `READ_TOKEN`, delete it with
`npx wrangler secret delete READ_TOKEN`.

## Importing your history

### The export

Unzip the export. The script reads every `Streaming_History_Audio_*.json` in
one directory:

```bash
unzip my_spotify_data.zip -d export
npm run import -- --dir "export/Spotify Extended Streaming History" --url "$WORKER_URL"
```

| Flag | Default | |
|---|---|---|
| `--dir` | `./export-data` | Directory holding `Streaming_History_Audio_*.json`. |
| `--url` | `http://127.0.0.1:8787` | The Worker. |
| `--chunk` | `500` | Records per `POST /admin/import`. |
| `--dailyRowLimit` | `90000` | Stop after writing this many rows in a UTC day. |
| `--state` | `.import-state.json` | Where progress is saved. |
| `--delayMs` | `250` | Pause between chunks. |

On the Free plan D1 allows 100,000 row writes a day, index writes included, so
the script stops at 90,000 and a long history takes several days. Re-run it
after 00:00 UTC and it continues from `.import-state.json`. Workers Paid has no
daily cap (50 million writes a month are included), so there pass a larger
`--dailyRowLimit` to import in one run. Re-running is always safe:
plays already stored are ignored, not duplicated. Podcasts and local files are
skipped.

### Album art

The export names albums but carries no art. Two scripts fill it in, both
resumable and safe to interrupt:

```bash
npm run backfill:albums -- --url "$WORKER_URL"    # most of it, in minutes
npm run backfill:catalog -- --url "$WORKER_URL"   # the rest, ~600 tracks a day
```

`backfill:albums` walks your Top Tracks, Liked Songs and Saved Albums:

| Flag | Default | |
|---|---|---|
| `--source` | `all` | `top`, `saved`, `albums`, or `all` for all three. |
| `--pages` | `4` | Pages of 50 per request (1 to 20). |
| `--state` | `.albums-state.json` | |
| `--delayMs` / `--maxRetries` | `300` / `5` | |

`backfill:catalog` looks tracks up one at a time, which reaches the ones you
never saved. Spotify allows a development-mode app roughly 600 of these a day;
the script stops at the first 429, prints when to try again, and resumes from
`.catalog-state.json`.

| Flag | Default | |
|---|---|---|
| `--limit` | `25` | Tracks per request (1 to 200). |
| `--state` | `.catalog-state.json` | |
| `--delayMs` / `--maxRetries` | `2000` / `6` | |

## Configuration

Secrets are set with `npx wrangler secret put <NAME>`, or in `.dev.vars`
locally. `npx wrangler secret list` shows what is set.

| Name | Required | |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | yes | From the Spotify dashboard. |
| `SPOTIFY_CLIENT_SECRET` | yes | From the Spotify dashboard. |
| `ADMIN_TOKEN` | yes | Full access. `openssl rand -hex 32`. Keep it offline and use [device tokens](#device-tokens) day to day. |
| `READ_TOKEN` | no | Deprecated: `/api/*` only. Prefer a read [device token](#device-tokens). |
| `CORS_ORIGINS` | no | Comma-separated browser origins (or `*`) allowed to call `/api/*`, e.g. `https://wrapped.example.com`. Unset sends no CORS headers. |
| `ALERT_WEBHOOK_URL` | no | Where alerts are POSTed. See [Alerting](#alerting). |
| `ALERT_MENTION` | no | Prefix for every alert, e.g. a Discord `<@id>`. |
| `SIGN_IN_SCHEMES` | no | Comma-separated custom URL schemes a mobile app may [sign in](#signing-in-with-spotify) to, e.g. `app.remastered`. |
| `TICKETMASTER_API_KEY` | no | A Ticketmaster Discovery API consumer key, from <https://developer.ticketmaster.com>, for [concerts](#concerts). The consumer secret isn't needed. Unset turns the concert check off. |
| `TIMEZONE` | no | IANA timezone the stats read local time in, when `ERAS` is unset. Default `UTC`. |
| `ERAS` | no | JSON list of periods, each read in its own timezone. See [step 2](#2-configure-the-deployment) and [`src/eras.ts`](src/eras.ts). |
| `CONCERT_REGIONS` | no | JSON list of places to look for [concerts](#concerts). Unset means none. |
| `SPOTIFY_REDIRECT_URI` | yes | A var in `wrangler.jsonc`, not a secret. |

The crons in `wrangler.jsonc` are `*/30 * * * *` (poll) and `0 9 * * *`
(alerts, plus computing one Wrapped preset). Polling every 30 minutes is 48
requests a day; tighten it to `*/15` if plays ever go missing.

### Plan and limits

This deployment runs on Workers Paid. There D1 meters reads and writes against
a monthly allowance (25 billion rows read and 50 million written, then billed
per million) and never stops answering. On the Free plan D1 stops answering
for the rest of the UTC day, ingestion included, once 5 million rows have been
read or 100,000 written. The Worker still runs on Free: stats are cached so
their cost doesn't grow with traffic, and the concert check fits Free's 50
subrequests. `_meta.rows_read` and the `X-Rows-Read` header report what each
request read.

## API reference

Every route except `/callback` and `/auth/*` takes `Authorization: Bearer <token>`.

| Token | Reaches |
|---|---|
| `ADMIN_TOKEN`, or an `admin` [device token](#device-tokens) | Everything. |
| A `read` device token, or `READ_TOKEN` | `/api/*` only. Wrapped: presets and ranges already computed. |

Responses are JSON. Errors are `{ "error": "..." }` with:

| Status | Meaning |
|---|---|
| `400` | A bad parameter; the message says which. |
| `401` | Missing or wrong token. |
| `403` | A read token asked Wrapped for a range it may not compute. |
| `429` | Spotify rate limit or quota (live routes). |
| `502` | Any other Spotify failure (live routes). |
| `503` | A stat is being computed (retry after `Retry-After`), or `needs_reauth: true`. |

Dates are `YYYY-MM-DD` local calendar days and `tz` is an IANA zone (default
`UTC`). Ranges are inclusive and at most 3,660 days. Timestamps in responses
are UTC.

### Stored plays

These read only D1, so they keep working when the Spotify grant has lapsed.

**`GET /api/plays`**: plays, newest first, with track, album and artist names.

| Param | Default | |
|---|---|---|
| `limit` | `50` | 1 to 500. |
| `before` | none | Only plays before this epoch-ms. Pass the last `played_at_ms` to page. |
| `after` | none | Only plays after this epoch-ms. |
| `q` | none | Only plays whose track, album or any artist name contains this, ignoring case and accents (at most 200 characters). Pages with `before` like the unfiltered list, and the response echoes `q`. |

```json
{ "plays": [ { "played_at_ms": 1760521802000, "track_id": "…", "track_name": "Shelter",
               "artists": "Porter Robinson, Madeon", "album_name": "Shelter", "image_url": "https://i.scdn.co/…",
               "duration_ms": 219000, "isrc": "…", "context_uri": "spotify:playlist:…", "context_type": "playlist",
               "source": "api" } ],
  "_meta": { "rows_read": 50, "duration_ms": 1.2 } }
```

`source` is `api` for polled plays and `export` for imported ones.

With `q`, matching names reads about one row per matching track, from a
trigram index (migration 0011), plus the plays read to fill the page. One- and
two-character queries can't use the index and scan the name tables instead,
about 11k rows, matching case-insensitively for ASCII only.

**`GET /api/top-artists`**: play counts per artist. Params: `from` (default 29
days ago), `to` (default today), `tz`, `limit` (1 to 500, default 50).
Returns `{ from, to, tz, artists: [{ artist_id, name, plays }] }`.

**`GET /api/top-tracks`**: play counts per song, editions folded (same title
and primary artist). Same params as `/api/top-artists`. Returns
`{ from, to, tz, tracks: [{ id, name, artist, plays, image }] }`; `id` is the
most-played edition's.

**`GET /api/daily`**: plays per local day, quiet days as `0`. Params: `from`,
`to`, `tz`, as above.

### History

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
`404`. `minutes` is an estimate (see [design notes](docs/design.md#wrapped)).

### Search

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

### Stats

**`GET /api/stats/{name}`**: aggregates built to be safe to publish: no play
rows and no date finer than a month. No parameters.

| `name` | Holds |
|---|---|
| `on-repeat` | Songs and albums you're playing far more than usual, over the last 14 days. |
| `rhythm` | Listening streaks and plays by hour. |
| `top-over-time` | Top artists and songs per quarter and year. |
| `eras` | How your artists changed between the two eras. |
| `albums` | Most-played albums, all time and per year. |

Each is cached and recomputed in the background every 3 to 24 hours. The first
request for a stat can get `503` with `Retry-After` while it computes.
`X-Stats-Source` and `X-Stats-Computed-At` say where the body came from.

### Wrapped

**`GET /api/wrapped?from=&to=`**: a Spotify-Wrapped-style summary of any
range that has ended (`to` before today): minutes, top artists, songs and
albums, biggest day, streak, listening by hour and weekday, each month's top
artist and song, discoveries, and a listening age. The first request for a
range takes a few seconds; a concurrent one gets `503` with `Retry-After`.
`ADMIN_TOKEN` can wrap any range; `READ_TOKEN` gets `403` for a range that is
neither a preset nor already computed.

**`GET /api/wrapped/ranges`**: the presets, newest first: each year with plays,
and this year up to the last full week.

```json
{ "ranges": [
  { "from": "2026-01-01", "to": "2026-10-11", "label": "2026 so far", "kind": "year_to_date", "computed": true },
  { "from": "2025-01-01", "to": "2025-12-31", "label": "2025", "kind": "year", "computed": false } ] }
```

### Concerts

**`GET /api/concerts?region=&since=&tz=`**: upcoming Ticketmaster music
events in the regions you configure, for the 80 artists you played most over
the last year. Soonest first. `region` is one of the configured keys; `since`
(a local date) keeps only events first seen on or after it, which is how to
ask what's new. `regions` lists the configured keys with their labels.

Regions come from `CONCERT_REGIONS`, a JSON list of up to five. Each has a
`key`, a `label`, and either a Ticketmaster `countryCode` or a `geoPoint`
[geohash](https://www.movable-type.co.uk/scripts/geohash.html) with a
`radius` in km:

```json
[{ "key": "uk", "label": "United Kingdom", "countryCode": "GB" },
 { "key": "nyc", "label": "New York", "geoPoint": "dr5ru", "radius": 40 }]
```

```json
{ "regions": [ { "key": "uk", "label": "United Kingdom" }, { "key": "nyc", "label": "New York" } ],
  "checked": { "uk": "2026-10-15T01:23:04.000Z", "nyc": "2026-10-15T01:23:05.000Z" },
  "concerts": [ { "region": "nyc", "date": "2027-02-12", "time": "20:00", "artists": "Maroon 5",
                  "name": "Maroon 5 2027 Tour", "venue": "Madison Square Garden", "city": "New York",
                  "status": "onsale", "url": "https://www.ticketmaster.com/…", "first_seen": "2026-10-15T01:23:04.000Z" } ] }
```

A daily cron (01:23 UTC) refreshes it; `POST /admin/concert-check` runs it
now. Each artist is matched to a Ticketmaster attraction by exact name
(ignoring case, accents and `&`) at most 25 a day, and the answer kept, so the
first few days fill in gradually. An act whose name Ticketmaster spells
differently is missed rather than guessed at; [pin it](#admin) instead. Events Ticketmaster stops listing
(past, cancelled) drop out, as do rows for a region taken out of
`CONCERT_REGIONS`. Needs `TICKETMASTER_API_KEY` and at least one region; there
are no push alerts.

### Live from Spotify

These proxy Spotify with the stored grant, so a client needs no Spotify
credentials of its own. They fail with `503 { needs_reauth: true }` when the
grant has lapsed.

| Route | |
|---|---|
| `GET /api/now-playing` | `{ item }`, Spotify's currently-playing; `item` is `null` when idle. |
| `GET /api/recently-played?limit=` | Spotify's recently-played, newest first. `limit` 1 to 50, default 1. Includes plays not yet ingested. |
| `GET /api/top?range=&limit=&type=` | `{ tracks, artists }` from Spotify's top lists. `range` is `short_term`, `medium_term` or `long_term`; `limit` 1 to 50, default 12; `type=tracks` or `type=artists` fetches only one (the other is `null`). |

### Admin

`ADMIN_TOKEN` only.

| Route | |
|---|---|
| `GET /` | Lists the routes. |
| `GET /login` | `302` to Spotify's consent page. Use `npm run authorize`. |
| `GET /callback` | Spotify's redirect target. No token; guarded by `state`. |
| `GET /auth/login?name=&return_to=&code_challenge=` | No token. [Sign in with Spotify](#signing-in-with-spotify). |
| `GET /auth/callback` | No token. Spotify's redirect target for sign-in. |
| `POST /auth/token` | No token. Body `{ code, code_verifier }`; exchanges a sign-in code for a read token. |
| `GET /health` | Whether ingestion is working. See [Health](#health). |
| `POST /admin/poll` | Poll now, exactly as the cron does. |
| `POST /admin/import` | Body: an array of export records, or `{ "records": [...] }`. Returns `{ inserted, duplicates, skipped }`. Use `npm run import`. |
| `POST /admin/backfill-albums?source=&range=&offset=&pages=` | One step of `npm run backfill:albums`. |
| `POST /admin/backfill-catalog?after=&limit=&spacingMs=` | One step of `npm run backfill:catalog`. |
| `POST /admin/alert-check?force=1` | Run the alert sweep now. `force=1` ignores the 24-hour resend window. |
| `POST /admin/concert-check?spacingMs=` | Run the [concert](#concerts) check now. `spacingMs` (default 250) spaces Ticketmaster calls. |
| `GET /admin/concert-artists?unmatched=1` | What each top artist matched on Ticketmaster; `unmatched=1` lists only the misses. |
| `PUT /admin/concert-artists` | Body `{ "name": "Kanye West", "attraction_id": "K8vZ9175Oy7" }` pins a name to an attraction (find ids at <https://developer.ticketmaster.com/api-explorer/>); `"attraction_id": null` blocks a wrong match. Pins are never re-matched. `DELETE` with `{ "name" }` unpins. |
| `GET /admin/raw?after=` | Spotify's unmodified recently-played payload. Read-only. |
| `POST /admin/tokens` | Body `{ name, access?, expires_in_days? }`. Mints a [device token](#device-tokens), returned once. |
| `GET /admin/tokens` | Every device token: `id`, `name`, `access`, `created_ms`, `expires_ms`, `last_used_ms`, `revoked_ms`, `active`. |
| `DELETE /admin/tokens?id=` | Revokes a device token. |

## Operations

### Health

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/health"
```

`ok` is `true` while a Spotify grant is stored and still accepted;
`minutes_since_last_success` says whether polling is keeping up. It also
reports `action_required`, `total_plays`, `plays_last_24h`,
`days_until_token_expiry`, `cursor_iso`, `last_error` and
`consecutive_failures`.

### Alerting

The daily cron POSTs JSON to `ALERT_WEBHOOK_URL` when something needs you. The
body carries the message under `content` (Discord), `text` (Slack) and
`message`, plus `title`, `severity` and `key`, so a Discord or Slack webhook
URL, or `https://ntfy.sh/<topic>`, works as-is.

| Key | Severity | Condition |
|---|---|---|
| `not_authorized` | critical | Never authorized. |
| `needs_reauth` | critical | The grant was rejected; ingestion has stopped. |
| `token_expiring` | warning | The grant expires in 14 days or less. |
| `ingestion_stalled` | critical | No successful poll for 3 hours. |

The first two suppress the others. A firing condition is re-sent at most once a
day, and alerts again immediately if it clears and comes back. Test it with
`POST /admin/alert-check?force=1`.

### Checking ingestion

```bash
npx wrangler tail                       # watch the next cron run
npx wrangler d1 execute music_warehouse --remote --command "SELECT COUNT(*) FROM plays;"
```

Play a few songs, wait for the next half hour, and look for them in
`/api/plays`.

### Redeploying

```bash
npm test && npm run typecheck && npx wrangler deploy
```

Apply any new migration with `npm run migrate:remote` first.

## Development

```bash
cp .dev.vars.example .dev.vars          # fill it in
npm run migrate:local
npm run dev                             # http://127.0.0.1:8787
npm test                                # runs against a real local D1
npm run typecheck
```

To authorize locally, register `http://127.0.0.1:8787/callback` with Spotify
and run `npm run authorize` without `--url`.

`npm audit` flags `sharp`, pulled in by the test runner's `miniflare`. It never
reaches the deployed Worker.

How it works, why, and what it can't do: [docs/design.md](docs/design.md).

## Licence

[MIT](LICENSE).

## Terms

Spotify's Developer Terms prohibit using Spotify content to train machine
learning models. A private listening warehouse is fine; feeding it to a model is
not.
