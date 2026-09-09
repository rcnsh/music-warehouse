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
| `POST /admin/poll` | Runs the same code path as the cron trigger. |
| `POST /admin/import` | Accepts one chunk of Extended Streaming History records. |
| `GET /api/now-playing` | Live proxy to Spotify's currently-playing. `{ item: null }` when idle. |
| `GET /api/top?range=&limit=` | Live proxy to Spotify's top tracks and artists. `range` is `short_term`, `medium_term` or `long_term`. |
| `POST /admin/alert-check?force=1` | Runs the daily alert sweep on demand. `force=1` ignores the resend window. |
| `GET /admin/raw?after=` | The unmodified upstream payload, for capturing fixtures and diagnosing shape changes. Read-only; never touches the cursor. |

## Access tiers

Every route except `/callback` requires a bearer token.

| Token | Reaches |
|---|---|
| `ADMIN_TOKEN` | Everything. |
| `READ_TOKEN` | `/api/*` only — not `/health`, `/login`, or any `/admin/*` route. |

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

Already deployed and configured:

- **Worker**: `music-warehouse`, on the account `31e51704ff7169c03d7014c3a1e5f110`
- **URL**: <https://music-api.rcn.sh> (custom domain on the `rcn.sh` zone;
  Wrangler manages the DNS record)
- **Database**: D1 `music_warehouse`, id `cd50aaf2-62d6-47cf-a5bd-ae99a8d32556`,
  region WEUR, migration `0001_init.sql` applied
- **Cron**: `*/30 * * * *` (ingest) and `0 9 * * *` (alert sweep)
- **Secrets set**: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `ADMIN_TOKEN`,
  `READ_TOKEN`. `ALERT_WEBHOOK_URL` is optional and currently unset.

`ADMIN_TOKEN` and `READ_TOKEN` are also in `.dev.vars` (gitignored, mode 600) —
that is the only local copy, so keep it.

To redeploy after a change:

```bash
npm test && npx wrangler deploy
```

### Setting it up again from scratch

```bash
npm install
npx wrangler d1 create music_warehouse       # put the id in wrangler.jsonc
npx wrangler d1 migrations apply music_warehouse --remote
npx wrangler d1 migrations apply music_warehouse --local
npx wrangler deploy
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN          # openssl rand -hex 32
npx wrangler secret put READ_TOKEN           # openssl rand -hex 32
npx wrangler secret put ALERT_WEBHOOK_URL    # optional, see Alerting
```

`SPOTIFY_REDIRECT_URI` lives in `wrangler.jsonc` (production) and is overridden
by `.dev.vars` for `wrangler dev`. Either value must match the Spotify dashboard
entry character for character, scheme included.

---

## Authorizing

`/login` is bearer-authenticated like every other route, so it is driven with
curl rather than opened in a browser — that keeps the admin token in a header
instead of a URL.

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

55 tests run against a real local D1 instance via `@cloudflare/vitest-pool-workers`,
covering idempotent ingestion, cursor behaviour on failure, the token lifecycle,
rate-limit handling, timezone bucketing, import de-duplication, and route auth.

```bash
npm run typecheck
```

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
- **The export has no album art or track durations.** Both come from the API,
  so export-only tracks have `duration_ms`, `album_id` and `isrc` NULL. A track
  later caught by a live poll is upgraded in place by the `tracks` upsert.
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

## Terms

Spotify's Developer Terms prohibit using Spotify content to train machine
learning models. A private listening warehouse is fine; feeding it to a model is
not.
