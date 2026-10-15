# music-warehouse

A Cloudflare Worker that records your own Spotify play history into a D1 database
you own, continuously and indefinitely — so your history outlives Spotify's
50-item `recently-played` window.

Ingestion and storage, plus a small read API. No UI.

---

## What it does

A cron trigger fires every 30 minutes. The Worker asks Spotify for every play
after a stored cursor, writes normalized rows in a single batched transaction,
and advances the cursor only once that transaction has resolved. A failed run
therefore costs nothing: the next run asks for exactly the same window again.

| Route | Purpose |
|---|---|
| `GET /login` | Start authorization. Returns a 302 to Spotify's consent page. |
| `GET /callback` | OAuth redirect target. The only unauthenticated route. |
| `GET /health` | Liveness, totals, and days left on the refresh token. |
| `GET /api/plays?limit=&before=&after=` | Recent plays with track, album and artist names. |
| `GET /api/top-artists?from=&to=&tz=&limit=` | Artist play counts over a local-calendar range. |
| `GET /api/daily?from=&to=&tz=` | Plays per local calendar day. |
| `GET /api/stats/{on-repeat,rhythm,top-over-time,eras,albums}` | Aggregate listening stats, built to be republished. See [Listening stats](#listening-stats). |
| `GET /api/wrapped?from=&to=` | A year-in-review for any closed range of local days. `READ_TOKEN` computes only the presets. See [Wrapped](#wrapped). |
| `GET /api/wrapped/ranges` | The preset Wrapped ranges, newest first, and whether each is computed yet. |
| `GET /api/artist?id=&name=&tz=` | One artist's whole history: plays, minutes, first and last play, plays per month, top songs. See [History](#history). |
| `GET /api/track?id=&tz=` | The same for one song, every edition folded together. |
| `GET /api/on-this-day?date=&tz=` | What was played on this day in each earlier year. |
| `POST /admin/poll` | Runs the same code path as the cron trigger. |
| `POST /admin/import` | Accepts one chunk of Extended Streaming History records. |
| `POST /admin/backfill-albums?source=&range=&offset=&pages=` | Fills album art from Top Tracks, Liked Songs or Saved Albums. `source` is `top`, `saved` or `albums`. |
| `POST /admin/backfill-catalog?after=&limit=&spacingMs=` | Fills album art one track at a time via Get Track, for the tail no user-scoped endpoint reaches. |
| `GET /api/now-playing` | Live proxy to Spotify's currently-playing. `{ item: null }` when idle. |
| `GET /api/recently-played?limit=` | Live proxy to Spotify's recently-played, newest first. `limit` is 1–50, default 1. Unlike `/api/plays`, it doesn't wait for the next ingest. |
| `GET /api/top?range=&limit=&type=` | Live proxy to Spotify's top tracks and artists. `range` is `short_term`, `medium_term` or `long_term`; `type=artists` or `type=tracks` fetches just one list (the other comes back `null`), and `type=artists` reads nothing from D1. |
| `POST /admin/alert-check?force=1` | Runs the daily alert sweep on demand. `force=1` ignores the resend window. |
| `GET /admin/raw?after=` | The unmodified upstream payload, for capturing fixtures and diagnosing shape changes. Read-only; never touches the cursor. |

## Access tiers

Every route except `/callback` requires a bearer token.

| Token | Reaches |
|---|---|
| `ADMIN_TOKEN` | Everything. |
| `READ_TOKEN` | `/api/*` only — not `/health`, `/login`, or any `/admin/*` route. Of Wrapped ranges not yet computed, only the presets. |

`READ_TOKEN` exists so a frontend can render listening data without holding a
credential that could trigger a poll or write rows. It is optional; leave it
unset and `/api/*` becomes admin-only.

### The two live routes

`/api/plays`, `/api/top-artists` and `/api/daily` read stored rows and keep
working even when the Spotify grant is dead. `/api/now-playing` and `/api/top`
proxy Spotify live, because neither answer exists in the warehouse: nothing
stored says what is playing *now*, and `recently-played` never returns artist
images, so Spotify's own ranked lists cannot be reconstructed from it.

They exist so a website can show live widgets without holding its own Spotify
refresh token — one credential, one six-month clock, one place to re-authorize.
Their failure modes are explicit rather than a blank 500:

| Condition | Response |
|---|---|
| Grant needs re-authorization | `503` with `needs_reauth: true` |
| Spotify rate limit or quota | `429` |
| Any other upstream failure | `502` |

Both require the `user-read-currently-playing` and `user-top-read` scopes, so
widening `SCOPE` means re-authorizing once via `/login`.

### Listening stats

`/api/stats/*` is for a public stats page. It sits behind `READ_TOKEN` like the
rest of `/api/*`, but every body is built so it could be republished as-is:
counts, shares, artist and track names, album art, and months. No play rows,
no `context_uri`, no timestamp finer than a month (`as_of`, the cut-off each
body was computed up to, is the one exception).

Nothing may change from one day to the next in a way that isolates a day.
A count that ticks daily, set beside today's date, dates whatever it counts
from, and diffing two days of the page reveals one day's listening. So
`rhythm`, `top-over-time` and `albums` stop at the start of the current
local week, `eras` at the start of the current month, and a running streak is
reported in whole weeks. `on-repeat` is meant to be current, so it is the
exception: it covers complete days up to local midnight, and its per-song
daily counts are only for songs already on repeat.

| Route | What it holds | Fresh for | D1 rows read per compute |
|---|---|---|---|
| `on-repeat` | Songs with 5+ plays on 3+ days in the last 14, at least twice their usual rate; albums with 4+ such songs | 3 h | ~47k |
| `rhythm` | Daily-listening streaks (1, 10, 25 plays a day) and plays by local hour, per era, all time and per year | 6 h | ~190k |
| `top-over-time` | Top artists and songs per quarter and year, and the seven biggest artists' share per quarter | 24 h | ~395k |
| `eras` | Artist drift between the Newcastle and Singapore eras, against the normal churn between windows of the same length | 24 h | ~315k |
| `albums` | The ten most-played albums with at least four different songs played, so a single on loop doesn't count, all time and per year | 24 h | ~270k |

**Caching.** Each stat is held in `stats_snapshots` (migration 0004) and in
the Cache API for five minutes. Only a request that wins a claim computes:
inline the first time a stat is asked for, in the background (serving the
stale body) after that. A request that finds a claim held and nothing yet to
serve gets `503` with `Retry-After`. A failed compute holds its claim for an
hour, so an erroring query does not retry on every request.
Recompute cost is therefore set by the freshness window, not by traffic or the
number of colos: all five together read about 2M rows a day at worst, against
the free plan's 5M. The rows-read figures are D1's own `rows_read`, measured
on the full history. They count temporary B-trees, so they run well above the
number of plays. The routes take no parameters, and the query string is never
part of a cache key, so it cannot force a recompute.

**Eras and local time.** Plays carry no location. The move from Newcastle to
Singapore is the `MOVED_AT` secret, an ISO instant read off the data (the
nightly gap in listening jumps seven hours across the move). It is a secret,
not a constant, because this repo is public and the stats publish only the
month. Without it everything is one Newcastle era. `eras` compares whole
calendar months, leaving the month of the move out of both sides. SQLite has no zone database, so each era's UTC offset is
spelled out in SQL (UK summer time, then a fixed +8), and a test checks it
against `Intl` across DST changes and the move. The public bodies name the
month of the move, never the day.

**What counts.** Rankings credit the primary artist only, because export rows
carry nothing else, and group by lowercased name so `name:` placeholders fold
into real ids. On-repeat drops plays shorter than 30 seconds,
measured as the gap since the previous play ended. The export records every
skip, and without the filter a 2020 skipping spree outranks what is really on repeat.
An era's hour profile stays `null` until the era spans four weeks, and its
weekday-by-hour grid until 26 weeks. Before that, each figure describes
particular nights rather than a routine.

There is no genre data: Spotify's artist catalogue endpoint is closed to this
app, so `eras` compares artists, not genres.

### Wrapped

`/api/wrapped?from=YYYY-MM-DD&to=YYYY-MM-DD` summarizes a range the way
Spotify Wrapped does: estimated minutes, top artists, songs and albums,
biggest day, longest streak, listening by hour and weekday, the top artist and
song of each month, discoveries (artists and songs first played inside the
range), and a listening age. It feeds
[music-warehouse-wrapped](https://github.com/rcnsh/music-warehouse-wrapped),
which turns it into a story and an MP4.

That app holds no link to any warehouse: its reader types in their own
warehouse URL and token, and the browser calls the warehouse directly. For
that, list the app's origin in the `CORS_ORIGINS` secret (comma-separated, or
`*`), and let preflights past the WAF rule (see
[Before exposing the URL publicly](#before-exposing-the-url-publicly)):

```bash
npx wrangler secret put CORS_ORIGINS   # e.g. https://wrapped.example.workers.dev
```

It is a secret rather than a var only so that this public repo doesn't name
the deployment. CORS covers `/api/*` and nothing else, and every request still
needs a token; unset, the Worker sends no CORS headers at all.

It is private, not a public stat: it names days. It also takes parameters, so
anyone holding a token could mint new keys and force scans. `ADMIN_TOKEN`
computes any range. `READ_TOKEN` reads any range already computed, computes
only a preset, and gets `403` otherwise. `to` must be before today, and a
range is stored in `stats_snapshots` under `wrapped:v2:{from}:{to}`. Once it
ended more than two days ago it is never recomputed.

The presets are a bounded list, so a read token can't mint keys: every closed
calendar year that has plays, and this year so far. "So far" ends with the
last complete local week, so it moves once a week rather than daily, for the
same reason the public stats stop at a week boundary. `/api/wrapped/ranges`
lists them, newest first:

```json
{ "ranges": [
  { "from": "2026-01-01", "to": "2026-10-11", "label": "2026 so far", "kind": "year_to_date", "computed": true },
  { "from": "2025-01-01", "to": "2025-12-31", "label": "2025", "kind": "year", "computed": false }
] }
```

Listing them costs one primary-key probe per candidate year. The daily cron
(`0 9 * * *`) computes one preset not yet computed, newest first, so most are
ready before anyone asks; one compute a day keeps it well inside the row budget.

Days and hours are in each era's local time. Minutes are estimated: a play
ran for at most the gap since the play before it and at most the track's
length, and plays under 30 seconds are skips that count for nothing.
Listening age is the age of someone whose late teens fall in the middle of
the five-year span of release years you played most, and is `null` when
fewer than half of the minutes have a release date.

### History

`/api/artist`, `/api/track` and `/api/on-this-day` are for a client app's
artist, song and "on this day" pages. They are private like `/api/plays`:
they name days. `tz` is an IANA zone (default `UTC`) used for months and days,
as in `/api/daily`; these take the caller's zone rather than the eras'.

```json
GET /api/artist?id=4NJhFmfw43RLBLjQvxDuRS&name=Porter%20Robinson&tz=Asia/Singapore
{ "artist": { "id": "4NJhFmfw43RLBLjQvxDuRS", "name": "Porter Robinson" },
  "plays": 812, "minutes": 2410,
  "first_played": "2020-07-03T21:14:02.000Z", "last_played": "2026-10-12T13:40:11.000Z",
  "months": [ { "month": "2020-07", "plays": 14 }, … ],
  "top_tracks": [ { "id": "…", "name": "Shelter", "plays": 96, "image": "https://i.scdn.co/…" }, … ] }

GET /api/track?id=…&tz=…
{ "track": { "id": "…", "name": "Shelter", "artist": "Porter Robinson", "image": "…" },
  "plays": 96, "minutes": 301, "first_played": "…", "last_played": "…", "months": [ … ] }

GET /api/on-this-day?date=2026-10-13&tz=Asia/Singapore
{ "date": "2026-10-13",
  "years": [ { "year": 2025, "plays": 41,
               "top_tracks": [ { "id": "…", "name": "…", "artist": "…", "image": "…", "plays": 6 } ] } ] }
```

An artist is matched by id and by lowercased name, as the stats group them,
so export-era `name:` placeholders count; `name` is the fallback for an id
the warehouse has never seen. Credit is the primary artist's only. A track
folds every edition with the same title and primary artist, and its `id` is
the one asked for. An unknown artist or track is a `200` with zero plays, empty
lists, `null` dates (and a `null` track name, artist and art), never a `404`.

`plays` counts every stored play, as `/api/top-artists` does. `minutes` is
Wrapped's estimate, so a skip is a play worth no minutes. `months` runs from
the first month with a play to the last, quiet months as zero. `top_tracks`
is up to ten songs for an artist and five for a day, editions folded, with the
id and art of the most-played edition. On this day covers each earlier year
with plays on that local date, newest first; 29 February looks only at leap
years.

Each is index seeks only: an artist or song reads about two rows per play of
it (the play, and the play before it for the minutes estimate), and on this
day one range per year. The `X-Rows-Read` header carries D1's count. The
artist name match needs migration 0006.

---

## Phase 0 — before any of this works

**These steps need a human with the Spotify account. Nothing else runs until
they are done.**

1. **Check the Spotify account has active Premium.** A development-mode app
   requires the *owning* account to hold Premium. If the account is free-tier,
   stop: continuous polling is off the table, and only the export importer
   (Phase 6) is usable.
2. **Create the app** at <https://developer.spotify.com/dashboard>. Register
   the redirect URI exactly: `https://music-api.rcn.sh/callback`.
   Optionally also register `http://127.0.0.1:8787/callback` if you want the
   authorization flow to work under `wrangler dev` (Spotify permits plain HTTP
   only on the loopback address).
3. **Add your own account to the app's user allowlist** (development mode caps
   an app at five users).
4. **Request the Extended Streaming History export today** from
   <https://www.spotify.com/account/privacy/> — *not* "Account data", which
   covers only about a year. Spotify quotes up to 30 days. Requesting it now
   means it arrives around the time you need it.
5. Note the **client ID** and **client secret**.

---

## Deployment

### Setting it up from scratch

Three values in [`wrangler.jsonc`](wrangler.jsonc) belong to one specific
deployment and must be replaced first. They are marked `[1]`, `[2]` and `[3]`
in that file:

1. **`routes`** — the custom domain. Delete the block entirely to deploy to
   `<name>.<subdomain>.workers.dev` instead; nothing here needs a custom domain.
2. **`database_id`** — filled in by the second command below.
3. **`SPOTIFY_REDIRECT_URI`** — must match the Spotify dashboard character for
   character, scheme included.

Then:

```bash
npm install
npx wrangler d1 create music_warehouse       # put the id in wrangler.jsonc
npx wrangler d1 migrations apply music_warehouse --remote
npx wrangler d1 migrations apply music_warehouse --local
npx wrangler deploy
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN          # openssl rand -hex 32
npx wrangler secret put READ_TOKEN           # optional, openssl rand -hex 32
npx wrangler secret put ALERT_WEBHOOK_URL    # optional, see Alerting
npx wrangler secret put ALERT_MENTION        # optional, see Alerting
npx wrangler secret put MOVED_AT             # optional, see Listening stats
npx wrangler secret put CORS_ORIGINS         # optional, see Wrapped
```

`npx wrangler secret list` shows what is set. For local work, copy
`.dev.vars.example` to `.dev.vars` — it is gitignored, and worth keeping at
mode 600, since it is the only copy of those tokens outside Cloudflare.

Nothing ingests until a human approves the Spotify consent screen: finish at
[Authorizing](#authorizing).

### Before exposing the URL publicly

Every route but `/callback` is bearer-authenticated, so the data is not
readable without a token. What remains is a budget exposure: on the Workers
free plan, unauthenticated junk still counts against the 100,000 requests/day
that the ingestion cron shares, and a stalled cron loses plays permanently.

A Cloudflare WAF **custom rule** turns that away at the edge, before the Worker
is invoked — and it uses a different quota from the single rate limiting rule
the free plan allows:

```txt
(http.host eq "your-hostname.example" and http.request.uri.path ne "/callback" and http.request.method ne "OPTIONS" and not len(http.request.headers["authorization"][0]) > 0)
```

Action: _Block_. Every legitimate caller sends `Authorization: Bearer …`, so
this is the same check the Worker already makes, moved one hop earlier.
`/callback` stays open for Spotify's browser redirect, guarded by its
single-use `state` value. `OPTIONS` stays open because a browser's CORS
preflight never carries the header; the Worker answers it only for an origin
in `CORS_ORIGINS`, and it returns no data. Without `CORS_ORIGINS`, drop that
clause.

### Redeploying

```bash
npm test && npx wrangler deploy
```

---

## Authorizing

`/login` is bearer-authenticated like every other route, so it is driven with
curl rather than opened in a browser — that keeps the admin token in a header
instead of a URL.

```bash
set -a && . ./.dev.vars && set +a
npm run authorize -- --url https://music-api.rcn.sh
```

That prints the consent URL (add `--open` to launch it), then polls `/health`
until the callback lands and reports the new expiry. By hand it is:

```bash
export WORKER_URL=https://music-api.rcn.sh
export ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' .dev.vars | cut -d= -f2)
curl -sD - -o /dev/null -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/login" | grep -i '^location:'
```

The `state` value is single-use and expires after 10 minutes, so generate the
URL when you are ready to click it.

Open the printed URL in a browser, approve, and Spotify redirects to
`/callback`, which stores the tokens and confirms in plain text. Then:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/admin/poll"
```

### Re-authorizing

Spotify expires refresh tokens **six months after the original authorization**,
and refreshing does not extend that clock. When it lands, the token endpoint
returns `400 invalid_grant`, the Worker sets `needs_reauth`, stops polling, and
`/health` says so with an `action_required` line. The fix is the same `/login`
flow above; `authorized_at_ms` resets and the countdown restarts.

`/health` warns from 14 days before expiry, and the daily alert cron pushes
that warning to you — see [Alerting](#alerting). A calendar reminder five months
out is still a cheap backstop.

---

## Alerting

A second cron (`0 9 * * *`) evaluates the same state `/health` reports and
POSTs to `ALERT_WEBHOOK_URL` when something needs a human. Without it, `/health`
only helps if someone remembers to look.

```bash
npx wrangler secret put ALERT_WEBHOOK_URL
```

Any URL that accepts a JSON POST works. The body repeats the same text under
`content` (Discord), `text` (Slack) and `message` (generic), alongside `title`,
`severity` and `key` for anything that parses JSON:

- **Discord** — a channel webhook URL, verbatim.
- **Slack** — an incoming-webhook URL, verbatim.
- **ntfy** — `https://ntfy.sh/<your-topic>`.

Leave it unset and conditions are logged but never pushed.

`ALERT_MENTION` leads every alert body with whatever syntax the receiver uses
to notify a human — a Discord `<@id>`, a Slack `<@U…>`, an ntfy tag. It is a
secret rather than a var in `wrangler.jsonc`, because it names a specific
person on a specific service:

```bash
npx wrangler secret put ALERT_MENTION
```

Discord parses mentions in `content` by default, so no `allowed_mentions`
field is needed. It applies to every condition rather than only the critical
ones, because every condition here needs manual intervention.

### What fires

| Key | Severity | Condition |
|---|---|---|
| `not_authorized` | critical | No Spotify grant has ever been stored. |
| `needs_reauth` | critical | The refresh token was rejected — ingestion has stopped. |
| `token_expiring` | warning | The six-month expiry is 14 days out or less. |
| `ingestion_stalled` | critical | No successful poll for 3 hours (six missed cycles). |

`not_authorized` and `needs_reauth` suppress the others — a dead connection is
also a stalled one, and saying so twice helps nobody.

Nothing transient is alerted on. A single failed poll costs nothing, because
the cursor never advanced.

### Repeats

A firing condition is re-sent at most once every 24 hours. When it clears, its
record is deleted, so a recurrence alerts immediately rather than waiting out a
stale timer. A failed delivery writes no record either, so the next run retries.

Test it end to end without waiting for the cron:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/admin/alert-check?force=1"
```

---

## Verification

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/health"
```

```bash
npx wrangler d1 execute music_warehouse --remote --command "SELECT COUNT(*) FROM plays;"
```

This must return no rows, ever:

```bash
npx wrangler d1 execute music_warehouse --remote --command "SELECT played_at_ms, track_id, COUNT(*) c FROM plays GROUP BY 1,2 HAVING c > 1;"
```

Watch a cron fire — expect exactly one Spotify request and one D1 batch:

```bash
npx wrangler tail
```

Then the real check: play three tracks, wait for the next tick, and look for
them in `GET /api/plays`.

---

## Backfilling from the export

The export is the only route to history from before the Worker existed. Unzip it
next to the project (the script defaults to `./export-data`) and run:

```bash
ADMIN_TOKEN=... node scripts/import-export.mjs --dir ./export-data --url "$WORKER_URL"
```

It posts 500 records at a time, tracks its position in `.import-state.json`, and
**stops cleanly when it has written 90,000 rows in a UTC day** — D1's free plan
allows 100,000 row writes per day, counting index writes. A lifetime export is
therefore a multi-day job. Re-run it after 00:00 UTC and it picks up where it
left off. Re-running it at any point is safe; overlapping records are ignored,
not duplicated.

---

## Testing

```bash
npm test
```

179 tests run against a real local D1 instance via `@cloudflare/vitest-pool-workers`,
covering idempotent ingestion, cursor behaviour on failure, the token lifecycle,
rate-limit handling, timezone bucketing, import de-duplication, route auth, and
the stats routes (era local time against `Intl`, streaks, on-repeat rules,
snapshot caching, and that no body carries play rows or exact dates), Wrapped
and its presets, and the history routes.

```bash
npm run typecheck
```

`npm audit` reports advisories against `sharp`, pulled in transitively by
`miniflare` for local image transforms. It is a devDependency of the test
runner and never reaches the deployed Worker, whose bundle is `src/` plus
nothing. Upgrading past it means a breaking `@cloudflare/vitest-pool-workers`
major.

---

## Design notes

**One store.** Play data and OAuth tokens both live in D1 — one binding, one
consistency model.

**The cursor is the whole safety story.** `sync_state.cursor_ms` holds the
newest `played_at` stored. Each poll asks for everything after it and advances
it only inside the same transaction as the writes. `MAX(cursor_ms, ?)` means it
can never move backwards, whatever ordering Spotify returns.

**`after` only, never `before`.** Paging backwards cannot reach past the
endpoint's hard 50-item ceiling, so `before` has no use here. On the first ever
run the `after` parameter is omitted entirely rather than sent as `after=0`.

**One API call per poll.** The recently-played response embeds the full track
object including album and artists, so no `/tracks` or `/artists` lookups are
needed. Adding them would cost subrequests and quota for data already in hand.

**Writes are chunked, then batched.** D1 allows at most **100 bound parameters
per statement**, and that limit applies to each statement inside a batch. A
50-play multi-row insert would be 200 parameters, so each insert is split into
statements that fit — all still issued in a single `db.batch()` call. A full
poll uses about 4 subrequests against a ceiling of 50, and never one call per
row.

**Timezones are applied at read time only.** Everything is stored as UTC
milliseconds with no conversion at write time. SQLite has no timezone database,
so `/api/daily` resolves the requested IANA zone to UTC bounds in JS, selects
only the timestamp column over an indexed range, and buckets the results. DST
transitions are handled: a 23-hour and a 25-hour local day both bucket correctly.

---

## Known limitations

- **Export-era artists are keyed by name, not by Spotify ID.** Extended
  Streaming History records carry artist and album *names* but no IDs, and the
  catalog endpoints that would resolve them (`/v1/tracks`, `/v1/artists`) return
  403 to apps in Spotify's development mode — a restriction Spotify introduced
  on 27 November 2024, liftable only by an Extended Quota Mode grant. Export
  artists are therefore stored under `name:<artist name>` (`NAME_KEY_PREFIX` in
  `src/db.ts`), which is enough for `/api/top-artists` to see the full history.
  Three consequences:
  - Only the *album* artist is known, so featured artists are missing and
    compilations collapse to their compilation artist.
  - A name-keyed artist is folded into its ID-keyed equivalent by exact name as
    soon as a live poll teaches the Worker that ID (`reconcileNameKeyedArtists`,
    run as part of every write). So an artist heard both before and after the
    Worker existed appears once, under the real ID, with both eras counted.
    Artists never yet polled stay name-keyed, which is why most rows still are.
    The match is exact on name, so a punctuation or casing difference between
    the export and the API leaves two rows — rare, and self-correcting the next
    time the same spelling arrives.
  - `albums` is not populated from the export at all; there is no name-keyed
    album ID worth inventing.
- **Album art reaches most of the history, but not all of it.** The export has
  no album ids, and the catalog endpoints keyed by id (`/v1/albums`,
  `/v1/tracks`) are 403 in development mode. The way through is that every
  `TrackObject` the API returns embeds its album — id, name, release date and
  images — so `npm run backfill:albums` walks the user-scoped endpoints that
  return tracks (Top Tracks, Liked Songs, Saved Albums) and fills album art and
  durations in from there. See `src/albums.ts`.

  That covers roughly 91% of plays. The tail beyond it — tracks played once or
  twice and never saved — is reachable too, but only one track at a time:
  `GET /v1/tracks/{id}` is the single catalog endpoint still open in
  development mode, while the batch forms it would be natural to use
  (`/v1/tracks?ids=`, `/v1/albums?ids=`) both return 403. `npm run
  backfill:catalog` walks it.

  **Expect ~600 tracks per run, and do not try to go faster.** Measured over
  two runs, the walk stopped at 566 and 599 tracks; dropping the rate from ~8
  requests/second to ~2 bought 33 extra tracks. The first 429 carried
  `Retry-After: 3875` (about an hour), the second `86088` (about 24 hours).
  That reads as a daily quota on catalog endpoints for a development-mode app
  rather than a rolling window — so pacing is politeness, not a workaround, and
  a large tail means one run per day.

  The script stops on a 429 and prints when the next window opens, rather than
  retrying into it; progress is a saved cursor, so re-running continues where
  it left off. Ingestion is unaffected throughout: it runs on the user token
  against `/me/*`, which is metered separately, and a 429 there never advances
  the cursor.

  Whether finishing the tail is worth it is a judgement call. At 94.7% of plays
  covered, the remainder averages 2.4 plays per track — and closing it means
  hitting the catalog quota ceiling on consecutive days.
- **Listening duration is not derivable from polled data.** `played_at`'s exact
  meaning is undocumented, and analysis of Spotify's own export data shows
  consecutive streams overlapping. Never compute duration from the gap between
  timestamps. `ms_played` exists only in the export, and this schema does not
  store it, so duration statistics are out of scope entirely.
- **Plays shorter than roughly 30 seconds may never appear.** Widely reported,
  not documented. Do not present counts as exhaustive.
- **Downtime is data loss.** Nothing recovers plays that aged out of the 50-item
  window during an outage. That is what the 30-minute cadence and the `/health`
  liveness field are for. Tighten to `*/15 * * * *` if gaps appear.
- **Local files and podcasts are not stored.** They have no Spotify track ID, so
  there is no key to store them under. The poll counts them as `skipped`.
- **Two plays sharing a `played_at` and `track_id` collapse to one row.** They
  are indistinguishable under the chosen primary key. Accepted.
- **`/health` counts the whole table.** `total_plays` is a `COUNT(*)`, so its row
  reads grow with the warehouse. Fine at a few calls a day against D1's 5M/day
  free-tier read allowance; do not poll it in a loop.

## Verified against the live API

Captured 2026-09-08 from the real account and recorded in
[`fixtures/NOTES.md`](fixtures/NOTES.md):

- **A1 confirmed** — items really are `{ track, played_at, context }`, with
  `played_at` as ISO-8601 UTC to the millisecond.
- **A2 confirmed** — `external_ids.isrc` is present on every track, so the
  `isrc` column carries real data rather than NULLs.
- **A6 confirmed** — every Wrangler flag used here is current in 4.130.0.
- `context` is null on roughly a third of plays (started from search or queue).
- The response envelope has no `total` field, contrary to the brief. Unused.

Still open: **A4** (whether plays under ~30 seconds are omitted) and **A7**
(whether a 30-minute cadence ever drops plays) both need the export to arrive
before they can be measured against real overlapping days.

## Licence

[MIT](LICENSE).

## Terms

Spotify's Developer Terms prohibit using Spotify content to train machine
learning models. A private listening warehouse is fine; feeding it to a model is
not.
