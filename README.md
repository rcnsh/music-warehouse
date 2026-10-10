# music-warehouse

A Cloudflare Worker that records your own Spotify play history into a D1
database you own, continuously and indefinitely.

Spotify's `recently-played` endpoint only returns your last 50 plays. This
Worker polls it every 30 minutes, stores every play it hasn't seen, and serves
the result through a small read API. It can also import Spotify's Extended
Streaming History export, so the warehouse covers listening from before it
existed. Ingestion, storage and an API only; for a UI, see
[music-warehouse-gui](https://github.com/rcnsh/music-warehouse-gui), a native
macOS app that reads from it.

<!-- TODO: add screenshot/GIF at docs/screenshot.png -->
<!-- ![music-warehouse](docs/screenshot.png) -->

Code layout and design decisions are in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Quickstart

You need Node.js, a Cloudflare account, and a Spotify account with active
Premium.

### 1. Spotify app

These steps need a human with the Spotify account.

1. **Check the account has Premium.** A development-mode app requires the
   owning account to hold Premium. On a free account, continuous polling won't
   work and only the [export importer](#backfilling) is usable.
2. **Create an app** at <https://developer.spotify.com/dashboard>. Register a
   redirect URI of `https://<your-host>/callback`, where `<your-host>` is the
   Worker's custom domain or `workers.dev` hostname. For local development also
   register `http://127.0.0.1:8787/callback`; Spotify allows plain HTTP only on
   the loopback address.
3. **Add your account to the app's user allowlist.** Development mode caps an
   app at five users.
4. **Request the Extended Streaming History export now** from
   <https://www.spotify.com/account/privacy/>. Not "Account data", which covers
   about a year. Spotify quotes up to 30 days.
5. Note the **client ID** and **client secret**.

### 2. Config

Three values in [`wrangler.jsonc`](wrangler.jsonc) belong to one specific
deployment. They are marked `[1]`, `[2]` and `[3]` in that file:

1. **`routes`**: the custom domain. Delete the block to deploy to
   `<name>.<subdomain>.workers.dev` instead.
2. **`database_id`**: replace with your own, from the next step.
3. **`SPOTIFY_REDIRECT_URI`**: must match the Spotify dashboard character for
   character, scheme included.

### 3. D1

```bash
npm install
npx wrangler d1 create music_warehouse   # put the printed id in wrangler.jsonc
npm run migrate:remote
npm run migrate:local
```

### 4. Deploy and set secrets

```bash
npx wrangler deploy
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN          # openssl rand -hex 32
npx wrangler secret put READ_TOKEN           # optional, openssl rand -hex 32
npx wrangler secret put ALERT_WEBHOOK_URL    # optional, see Alerting
npx wrangler secret put ALERT_MENTION        # optional, see Alerting
```

`npx wrangler secret list` shows what is set.

### 5. Authorize

Nothing ingests until a human approves the Spotify consent screen:

```bash
cp .dev.vars.example .dev.vars && chmod 600 .dev.vars   # fill in ADMIN_TOKEN
set -a && . ./.dev.vars && set +a
export WORKER_URL=https://<your-host>
npm run authorize -- --url "$WORKER_URL" --open
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/admin/poll"
```

See [Authorizing](#authorizing) for what that does.

---

## Configuration

### Bindings

| Name | Type | Notes |
|---|---|---|
| `DB` | D1 | Database `music_warehouse`, migrations in `migrations/`. |

### Vars

| Name | Required | Notes |
|---|---|---|
| `SPOTIFY_REDIRECT_URI` | yes | Set in `wrangler.jsonc`. Overridden locally by `.dev.vars` with the loopback URL. |

### Secrets

Set with `npx wrangler secret put <NAME>` in production, and in `.dev.vars`
(gitignored, copied from `.dev.vars.example`) for local development.

| Name | Required | Notes |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | yes | From the Spotify dashboard. |
| `SPOTIFY_CLIENT_SECRET` | yes | From the Spotify dashboard. |
| `ADMIN_TOKEN` | yes | Bearer token for every route. `openssl rand -hex 32`. |
| `READ_TOKEN` | no | Bearer token for `/api/*` only. Unset means `/api/*` is admin-only. |
| `ALERT_WEBHOOK_URL` | no | Where the daily alert sweep POSTs. Unset means alerts are only logged. |
| `ALERT_MENTION` | no | Prefix for every alert body, e.g. a Discord `<@id>`. A secret because it identifies a person. |

### Crons

| Schedule | Does |
|---|---|
| `*/30 * * * *` | Polls Spotify. 48 invocations a day. Tighten to `*/15 * * * *` if gaps appear. |
| `0 9 * * *` | Alert sweep. See [Alerting](#alerting). |

### Spotify scopes

`SCOPE` in `src/spotify.ts`: `user-read-recently-played`,
`user-read-currently-playing`, `user-top-read`, `user-library-read`. Changing
it invalidates the existing grant, so re-authorize afterwards.

### Scripts

The Node scripts read `ADMIN_TOKEN` from the environment and take `--url`
(default `http://127.0.0.1:8787`).

| Command | Does |
|---|---|
| `npm run authorize` | Prints the consent URL, `--open` launches it, then waits for `/health` to confirm. |
| `npm run import` | Imports an export directory (`--dir`, default `./export-data`). |
| `npm run backfill:albums` | Album art from Top Tracks, Liked Songs and Saved Albums (`--source`, default `all`). |
| `npm run backfill:catalog` | Album art one track at a time, for the tail. |

Each keeps progress in a gitignored `.*-state.json` file and is safe to re-run.

---

## Deployment

This project uses Wrangler (`wrangler.jsonc`). The `cf` CLI's `cf dev` and
`cf deploy` need Wrangler 4.136.0 or newer, and this repo pins 4.130.0, so the
commands below use Wrangler.

### Local

```bash
cp .dev.vars.example .dev.vars   # fill in
npm run migrate:local
npm run dev                      # http://127.0.0.1:8787
```

### Production

```bash
npm test && npx wrangler deploy
```

Schema changes:

```bash
npm run migrate:remote
```

### Public exposure

Every route but `/callback` is bearer-authenticated, so the data isn't readable
without a token. What remains is budget: on the Workers free plan, junk requests
still count against the 100,000 requests a day the ingestion cron shares, and a
stalled cron loses plays permanently.

A Cloudflare WAF custom rule turns them away at the edge, before the Worker
runs, and doesn't use up the free plan's single rate limiting rule:

```txt
(http.host eq "your-hostname.example" and http.request.uri.path ne "/callback" and not len(http.request.headers["authorization"][0]) > 0)
```

Action: _Block_. Every legitimate caller sends `Authorization: Bearer …`, so
this is the Worker's own check moved one hop earlier. `/callback` stays open
for Spotify's redirect, guarded by its single-use `state` value.

---

## API

| Route | Purpose |
|---|---|
| `GET /` | Service name and route list. |
| `GET /login` | Start authorization. Returns a 302 to Spotify's consent page. |
| `GET /callback` | OAuth redirect target. The only unauthenticated route. |
| `GET /health` | Liveness, totals, and days left on the refresh token. |
| `GET /api/plays?limit=&before=&after=` | Recent plays with track, album and artist names. |
| `GET /api/top-artists?from=&to=&tz=&limit=` | Artist play counts over a local-calendar range. |
| `GET /api/daily?from=&to=&tz=` | Plays per local calendar day. |
| `GET /api/now-playing` | Live proxy to Spotify's currently-playing. `{ item: null }` when idle. |
| `GET /api/top?range=&limit=` | Live proxy to Spotify's top tracks and artists. `range` is `short_term`, `medium_term` or `long_term`. |
| `POST /admin/poll` | Runs the same code path as the cron. |
| `POST /admin/alert-check?force=1` | Runs the alert sweep now. `force=1` ignores the resend window. |
| `POST /admin/import` | Accepts one chunk of Extended Streaming History records. |
| `POST /admin/backfill-albums?source=&range=&offset=&pages=` | Fills album art from Top Tracks, Liked Songs or Saved Albums. `source` is `top`, `saved` or `albums`. |
| `POST /admin/backfill-catalog?after=&limit=&spacingMs=` | Fills album art one track at a time via Get Track. |
| `GET /admin/raw?after=` | The unmodified upstream payload, for fixtures and diagnosing shape changes. Never touches the cursor. |

### Access

Every route except `/callback` needs `Authorization: Bearer <token>`.

| Token | Reaches |
|---|---|
| `ADMIN_TOKEN` | Everything. |
| `READ_TOKEN` | `/api/*` only. Not `/health`, `/login`, or `/admin/*`. |

`READ_TOKEN` lets a frontend show listening data without a credential that
can trigger a poll or write rows.

### Live routes

`/api/plays`, `/api/top-artists` and `/api/daily` read stored rows and keep
working when the Spotify grant is dead. `/api/now-playing` and `/api/top` proxy
Spotify live, because neither answer exists in the warehouse: nothing stored
says what is playing now, and `recently-played` never returns artist images.

They exist so a website can show live widgets without its own Spotify refresh
token. Failures are explicit:

| Condition | Response |
|---|---|
| Grant needs re-authorization | `503` with `needs_reauth: true` |
| Spotify rate limit or quota | `429` |
| Any other upstream failure | `502` |

---

## Authorizing

`/login` is bearer-authenticated like every other route, so it's driven with
curl rather than opened in a browser. That keeps the admin token in a header
instead of a URL.

```bash
set -a && . ./.dev.vars && set +a
npm run authorize -- --url "$WORKER_URL"
```

That prints the consent URL (`--open` launches it), then polls `/health` until
the callback lands and reports the new expiry. By hand:

```bash
curl -sD - -o /dev/null -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/login" | grep -i '^location:'
```

The `state` value is single-use and expires after 10 minutes, so generate the
URL when you're ready to click it. Approve in the browser; Spotify redirects to
`/callback`, which stores the tokens. Then start a poll:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/admin/poll"
```

### Re-authorizing

Spotify expires refresh tokens six months after the original authorization,
and refreshing doesn't extend that. When it lands, the token endpoint returns
`400 invalid_grant`, the Worker sets `needs_reauth` and stops polling, and
`/health` says so with an `action_required` line. The fix is the same flow
above; the countdown restarts.

`/health` warns from 14 days before expiry, and the alert sweep pushes that
warning to you.

---

## Alerting

The `0 9 * * *` cron evaluates the same state `/health` reports and POSTs to
`ALERT_WEBHOOK_URL` when something needs a human.

Any URL that accepts a JSON POST works. The body repeats the same text under
`content` (Discord), `text` (Slack) and `message` (generic), alongside `title`,
`severity` and `key`:

- **Discord**: a channel webhook URL.
- **Slack**: an incoming-webhook URL.
- **ntfy**: `https://ntfy.sh/<your-topic>`.

`ALERT_MENTION` leads every alert body with whatever syntax the receiver uses
to notify a human: a Discord `<@id>`, a Slack `<@U…>`, an ntfy tag. Discord
parses mentions in `content` by default.

### Conditions

| Key | Severity | Condition |
|---|---|---|
| `not_authorized` | critical | No Spotify grant has ever been stored. |
| `needs_reauth` | critical | The refresh token was rejected. Ingestion has stopped. |
| `token_expiring` | warning | The six-month expiry is 14 days out or less. |
| `ingestion_stalled` | critical | No successful poll for 3 hours. |

`not_authorized` and `needs_reauth` suppress the others. Nothing transient is
alerted on: a single failed poll costs nothing, because the cursor never moved.

### Repeats

A firing condition is re-sent at most once every 24 hours. When it clears, its
record is deleted, so a recurrence alerts immediately. A failed delivery writes
no record, so the next run retries.

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/admin/alert-check?force=1"
```

---

## Verification

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/health"
npx wrangler d1 execute music_warehouse --remote --command "SELECT COUNT(*) FROM plays;"
```

This must return no rows, ever:

```bash
npx wrangler d1 execute music_warehouse --remote --command "SELECT played_at_ms, track_id, COUNT(*) c FROM plays GROUP BY 1,2 HAVING c > 1;"
```

Watch a cron fire. Expect one Spotify request and one D1 batch:

```bash
npx wrangler tail
```

Then the real check: play three tracks, wait for the next tick, and look for
them in `GET /api/plays`.

---

## Backfilling

### Export

The export is the only route to history from before the Worker existed. Unzip
it into `./export-data` and run:

```bash
ADMIN_TOKEN=... npm run import -- --dir ./export-data --url "$WORKER_URL"
```

It posts 500 records at a time, tracks its position in `.import-state.json`,
and stops when it has written 90,000 rows in a UTC day. D1's free plan allows
100,000 row writes a day, counting index writes, so a lifetime export is a
multi-day job. Re-run it after 00:00 UTC to continue. Overlapping records are
ignored, not duplicated.

### Album art

```bash
ADMIN_TOKEN=... npm run backfill:albums -- --url "$WORKER_URL"
ADMIN_TOKEN=... npm run backfill:catalog -- --url "$WORKER_URL"
```

`backfill:albums` walks Top Tracks, Liked Songs and Saved Albums. `saved` and
`albums` need `user-library-read`. `backfill:catalog` covers what those miss,
one Get Track call per track, using an app token rather than the user grant.
See [Known limitations](#known-limitations) for the quota.

---

## Contributing

Issues and PRs are welcome.

### Setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run migrate:local
npm run dev
```

The tests don't need `.dev.vars` or a Spotify account.

### Checks

```bash
npm test             # vitest inside workerd, against a local D1
npm run typecheck    # tsc --noEmit
```

Tests run via `@cloudflare/vitest-pool-workers`, covering idempotent
ingestion, cursor behaviour on failure, the token lifecycle, rate-limit
handling, timezone bucketing, import de-duplication and route auth. They use
`fixtures/recently-played.json` if you have captured one, otherwise the
committed sample. There is no lint script.

`npm audit` reports advisories against `sharp`, pulled in transitively by
`miniflare`. It's a devDependency of the test runner and never reaches the
deployed Worker. Upgrading past it means a breaking
`@cloudflare/vitest-pool-workers` major.

### PRs

- Keep `npm test` and `npm run typecheck` passing, and add tests for behaviour
  changes.
- Schema changes go in a new numbered file in `migrations/`. Don't edit applied
  migrations.
- Never commit `.dev.vars`, export data, or a captured
  `fixtures/recently-played.json`; they contain credentials or real listening
  data.
- Update this README when routes, config or limits change.

---

## Known limitations

- **Export-era artists are keyed by name, not by Spotify ID.** Extended
  Streaming History records carry artist and album names but no IDs, and the
  catalog endpoints that would resolve them (`/v1/tracks`, `/v1/artists`) return
  403 to apps in Spotify's development mode, a restriction Spotify introduced
  on 27 November 2024 and liftable only by an Extended Quota Mode grant. Export
  artists are stored under `name:<artist name>` (`NAME_KEY_PREFIX` in
  `src/db.ts`), which is enough for `/api/top-artists` to see the full history.
  Consequences:
  - Only the album artist is known, so featured artists are missing and
    compilations collapse to their compilation artist.
  - A name-keyed artist is folded into its ID-keyed equivalent by exact name
    once a live poll teaches the Worker that ID (`reconcileNameKeyedArtists`,
    run on every write). An artist heard before and after the Worker existed
    appears once, with both eras counted. Artists never polled stay name-keyed.
    The match is exact, so a punctuation or casing difference leaves two rows.
  - `albums` is not populated from the export.
- **Album art covers most of the history, not all of it.** The export has no
  album IDs, and the catalog endpoints keyed by ID are 403 in development mode.
  Every `TrackObject` the API returns embeds its album, so `backfill:albums`
  fills art from the user-scoped endpoints that return tracks. That covers
  roughly 91% of plays.

  The tail is reachable one track at a time: `GET /v1/tracks/{id}` is the one
  catalog endpoint still open in development mode, while the batch forms
  (`/v1/tracks?ids=`, `/v1/albums?ids=`) return 403. `backfill:catalog` walks
  it.

  Expect about 600 tracks per run, and don't try to go faster. Over two runs
  the walk stopped at 566 and 599 tracks; dropping from ~8 requests a second
  to ~2 bought 33 more. The first 429 carried `Retry-After: 3875` (about an
  hour), the second `86088` (about 24 hours). That reads as a daily quota on
  catalog endpoints for development-mode apps, so a large tail means one run a
  day. The script stops on a 429 and prints when the next window opens.
  Ingestion is unaffected: it uses the user token against `/me/*`, which is
  metered separately.

  At 94.7% of plays covered, the remainder averaged 2.4 plays per track.
- **Listening duration isn't derivable from polled data.** `played_at`'s exact
  meaning is undocumented, and Spotify's own export shows consecutive streams
  overlapping. `ms_played` exists only in the export, and isn't stored, so
  duration statistics are out of scope.
- **Plays shorter than roughly 30 seconds may never appear.** Widely reported,
  not documented. Don't present counts as exhaustive.
- **Downtime is data loss.** Nothing recovers plays that aged out of the
  50-item window during an outage. That's what the 30-minute cadence and the
  `/health` liveness field are for.
- **Local files and podcasts aren't stored.** They have no Spotify track ID.
  The poll counts them as `skipped`.
- **Two plays sharing a `played_at` and `track_id` collapse to one row.** They
  are indistinguishable under the primary key.
- **`/health` counts the whole table.** `total_plays` is a `COUNT(*)`, so its
  row reads grow with the warehouse. Fine a few times a day against D1's 5M/day
  free read allowance; don't poll it in a loop.

## Verified against the live API

Captured 2026-09-08 from the real account and recorded in
[`fixtures/NOTES.md`](fixtures/NOTES.md):

- **A1 confirmed**: items are `{ track, played_at, context }`, with
  `played_at` as ISO-8601 UTC to the millisecond.
- **A2 confirmed**: `external_ids.isrc` is present on every track.
- **A6 confirmed**: every Wrangler flag used here is current in 4.130.0.
- `context` is null on roughly a third of plays (started from search or queue).
- The response envelope has no `total` field. Unused.

Still open: **A4** (whether plays under ~30 seconds are omitted) and **A7**
(whether a 30-minute cadence ever drops plays) both need the export to measure
against.

## Licence

[MIT](LICENSE).

## Terms

Spotify's Developer Terms prohibit using Spotify content to train machine
learning models. A private listening warehouse is fine; feeding it to a model
is not.
