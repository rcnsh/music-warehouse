# Setting up music-warehouse

The full version of the README's [Quick start](../README.md#quick-start).

## 1. Create the Spotify app

1. At <https://developer.spotify.com/dashboard>, create an app with the Web API.
2. Add two redirect URIs: `https://<your-worker-host>/callback` for
   ingestion and `https://<your-worker-host>/auth/callback` for
   [signing in](#signing-in-with-spotify). Locally, also add the same two paths
   on `http://127.0.0.1:8787` (Spotify allows plain HTTP only on loopback).
3. Under **User Management**, add your own Spotify account (development mode
   allows five users).
4. Note the **client ID** and **client secret**.

> [!TIP]
> While you're there, request your **Extended streaming history** at
> <https://www.spotify.com/account/privacy/>. Not "Account data", which only
> covers a year. It can take up to 30 days to arrive, and it is the only way to
> get plays from before the Worker existed.

## 2. Configure the deployment

```bash
git clone https://github.com/rcnsh/music-warehouse && cd music-warehouse
npm install
npx wrangler login
cp wrangler.jsonc wrangler.local.jsonc
```

[`wrangler.jsonc`](../wrangler.jsonc) is a template: its database id and redirect
URI are placeholders, so the repository holds nobody's deployment. Your own
values go in `wrangler.local.jsonc`, which is gitignored. `npm run dev`,
`npm run deploy`, `npm run migrate:*` and `npm run wrangler -- <command>` pass
it to Wrangler with `-c` whenever it exists
([`scripts/wrangler.mjs`](../scripts/wrangler.mjs)); deploying without it is
refused. Run Wrangler through those scripts rather than bare `npx wrangler`
for anything that touches the database. When the template changes (a new
cron, a new binding), carry the change into your copy.

In `wrangler.local.jsonc`, set:

| | Key | Set it to |
|---|---|---|
| `[1]` | `database_id` | The id from the [next step](#3-create-the-database). |
| `[2]` | `vars.SPOTIFY_REDIRECT_URI` | The `/callback` redirect URI from step 1, exactly. |
| | `routes` | Optional: `[{ "pattern": "music.example.com", "custom_domain": true }]` for a custom domain. Without it the Worker is on `music-warehouse.<subdomain>.workers.dev`. |

The template also binds `AUTH_RATE_LIMITER`, a
[Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
binding: 20 requests a minute per client address on the unauthenticated
`/auth/*` routes. Delete the `ratelimits` block to go without it; the cap on
pending sign-ins still holds.

Listening stats and Wrapped read local time in one timezone, `TIMEZONE`
(default UTC), and start at your first stored play. If you've lived in more
than one zone, set `ERAS` instead: a JSON list of the stages of your life,
each with its own timezone, for example

```json
[{ "key": "uni", "label": "Uni", "timeZone": "Europe/London", "from": "2024-09-16T00:00:00+01:00", "to": "2026-05-18T00:00:00+01:00" },
 { "key": "abroad", "label": "Abroad", "timeZone": "Asia/Tokyo", "from": "2026-07-28T00:00:00+09:00" }]
```

`key` is lowercase letters, digits and `-`, and appears in stats responses;
`label` is for display. Every era after the first needs `from`; any era can
have `to`, where it ends. Stages needn't cover everything: time before the
first, or between one that ended and the next, is a gap. A gap is read in the
timezone of the stage before it (the first stage's, before the first), counts
in every total, streak and Wrapped, but gets no time-of-day figures of its
own. A holiday isn't a stage: it stays on its stage's clock. The `eras` stat
compares the months since the latest stage began (up to its end, if it has
one) with the same number of months before it. Set `ERAS` as a secret if a
stage's start or end is private: the stats only publish the month. See [`src/eras.ts`](../src/eras.ts). Ingestion and
the other routes don't depend on it.

History starts at your first stored play, or at `HISTORY_FROM` (an ISO
instant) if set, which helps if your first few plays are noise.

## 3. Create the database

```bash
npx wrangler d1 create music_warehouse     # copy the id into wrangler.local.jsonc
npm run migrate:remote
npm run migrate:local                      # for wrangler dev and tests
```

## 4. Deploy and set secrets

```bash
npm run deploy
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN        # paste the output of: openssl rand -hex 32
```

The optional ones are in [Configuration](#configuration). For local work, copy
`.dev.vars.example` to `.dev.vars` and fill it in. It is gitignored; keep it at
mode 600.

## 5. Block unauthenticated traffic (recommended)

Every route but `/callback` and `/auth/*` needs a token, but unauthenticated
requests still reach the Worker. On the Free plan they count against its
100,000 requests a day, which the ingestion cron shares; on Workers Paid they
are only noise. A WAF custom rule (Security → WAF → Custom rules, action
**Block**) on your custom domain's zone stops them at the edge:

```txt
(http.host eq "your-host.example" and http.request.uri.path ne "/callback" and not starts_with(http.request.uri.path, "/auth/") and http.request.method ne "OPTIONS" and not len(http.request.headers["authorization"][0]) > 0)
```

`/callback` stays open for Spotify's redirect, which its single-use `state`
guards. `/auth/*` stays open for [signing in](#signing-in-with-spotify), which
is how a device without a token gets one. The `AUTH_RATE_LIMITER` binding
limits it per client inside the Worker; a WAF rate-limiting rule on `/auth/`
stops a flood before it reaches the Worker at all, and is a sensible extra.
`OPTIONS` stays open for browser clients' CORS preflights, which never carry
the header; drop that clause if you don't set `CORS_ORIGINS`.

Then [authorize](../README.md#authorizing).

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

Keep `ADMIN_TOKEN` in a password manager as the way back in if every device
token is lost.

Don't set `READ_TOKEN`: it is a deprecated shared secret that can't be revoked
for one reader. Each use logs a `read-token-deprecated` warning.

### Signing in with Spotify

A device can also get a **read** token by signing in with the Spotify account
that owns the warehouse (the one that [authorized](../README.md#authorizing) ingestion).
Any other Spotify account is refused. Sign-in never mints admin tokens, and it
never touches the ingestion grant: it asks Spotify for no scopes and discards
what Spotify returns once it has read the account id. Tokens it mints expire
after 90 days and show `created_via: "spotify"` in the list.

Every sign-in starts on a warehouse page that names the device and where its
token will go, with **Allow** and **Cancel**. Only Allow goes on to Spotify,
and Spotify then shows its own consent dialog every time, even for an account
that approved the app before. Both steps happen in the browser, and Spotify
must send it back to the same browser that pressed Allow (a cookie checks it).
That matters because PKCE only proves the code reaches whoever *started* the
sign-in: any program on the machine can listen on `127.0.0.1`, and any mobile
app can register a URL scheme. So read the page, and press Allow only for a
sign-in you started.

Sign-ins in progress are capped at 10 per client address (its /64 for IPv6;
only a keyed hash of it is stored) and 200 overall, for up to 10 minutes each.
Past either, `/auth/login` answers `429`.

**In a browser, for a shell or script:** open
`$WORKER_URL/auth/login?name=laptop`, press Allow, approve at Spotify, and
copy the token from the page. It is shown once.

**From an app:** see [Signing in from an app](api.md#signing-in-from-an-app)
in the API reference.

## Configuration

Secrets are set with `npx wrangler secret put <NAME>`, or in `.dev.vars`
locally. `npx wrangler secret list` shows what is set.

| Name | Required | |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | yes | From the Spotify dashboard. |
| `SPOTIFY_CLIENT_SECRET` | yes | From the Spotify dashboard. |
| `ADMIN_TOKEN` | yes | Full access. `openssl rand -hex 32`. Keep it offline and use [device tokens](#device-tokens) day to day. |
| `SPOTIFY_REDIRECT_URI` | yes | A var in `wrangler.jsonc`, not a secret. `.dev.vars` overrides it locally. |
| `READ_TOKEN` | no | Deprecated: `/api/*` only. Prefer a read [device token](#device-tokens). |
| `CONTROL_TOKEN` | no | [`POST /control/play`](api.md#playback-control) only, for the one client allowed to start playback. `openssl rand -hex 32`. |
| `CORS_ORIGINS` | no | Comma-separated browser origins (or `*`) allowed to call `/api/*`, e.g. `https://wrapped.example.com`. Unset sends no CORS headers. |
| `ALERT_WEBHOOK_URL` | no | Where alerts are POSTed. See [Alerting](operations.md#alerting). |
| `ALERT_MENTION` | no | Prefix for every alert, e.g. a Discord `<@id>`. |
| `HEARTBEAT_URL` | no | A dead-man's switch, e.g. a [healthchecks.io](https://healthchecks.io) ping URL, fetched after every successful poll. See [Heartbeat](operations.md#heartbeat). |
| `SIGN_IN_SCHEMES` | no | Comma-separated custom URL schemes a mobile app may [sign in](#signing-in-with-spotify) to, e.g. `app.remastered`. |
| `TICKETMASTER_API_KEY` | no | A Ticketmaster Discovery API consumer key, from <https://developer.ticketmaster.com>, for [concerts](optional-features.md#setting-up-concerts). The consumer secret isn't needed. Unset turns concerts off: no daily check, and `/api/concerts` answers `404`. |
| `TIMEZONE` | no | IANA timezone the stats read local time in, when `ERAS` is unset. Default `UTC`. Also the zone of the [play-count rollup](#the-play-count-rollup); with only `ERAS` set, the rollup uses the latest era's zone. |
| `ERAS` | no | JSON list of life stages, each read in its own timezone, with gaps allowed between them. See [step 2](#2-configure-the-deployment) and [`src/eras.ts`](../src/eras.ts). |
| `HISTORY_FROM` | no | ISO instant where the stats' history starts; plays before it are ignored. Default: the first stored play. |
| `CONCERT_REGIONS` | no | JSON list of up to five places to look for [concerts](optional-features.md#setting-up-concerts). Set it as a secret: a `geoPoint` can locate you. Unset (or `[]`) turns concerts off, like a missing key. |
| `SPICY_LYRICS_SECRET_KEY` | no | A Spicy Lyrics **secret** key (`sl_sk_…`), from <https://developers.spicylyrics.org>, for [lyrics](optional-features.md#setting-up-lyrics). Unset turns `/api/lyrics` off (it answers `404`). |

### Crons

The crons are in `wrangler.jsonc`:

| Schedule (UTC) | Does |
|---|---|
| `*/30 * * * *` | Polls Spotify for new plays, exactly as `POST /admin/poll` does, then pings the [heartbeat](operations.md#heartbeat) if the poll succeeded and runs the [alert](operations.md#alerting) check. |
| `0 9 * * *` | The daily artist reconcile, search index and song sync; brings the [play-count rollup](#the-play-count-rollup) up to date; computes one Wrapped preset. |
| `23 1 * * *` | The [concert](optional-features.md#setting-up-concerts) check, in its own invocation so it gets a full subrequest budget. |

Polling every 30 minutes is 48 requests a day; tighten it to `*/15` if plays
ever go missing.

### Plan and limits

Either plan works. On Workers Paid, D1 meters reads and writes against a
monthly allowance (25 billion rows read and 50 million written, then billed
per million) and never stops answering. On the Free plan D1 stops answering
for the rest of the UTC day, ingestion included, once 5 million rows have been
read or 100,000 written. The Worker still runs on Free: stats are cached so
their cost doesn't grow with traffic, and the concert check fits Free's 50
subrequests. Every route that reads stored plays reports the D1 rows it read
in an `X-Rows-Read` header; `/api/plays`, `/api/daily` and `/api/top-artists`
also put it in the body's `_meta.rows_read`.

`/api/artist`, `/api/track`, `/api/top-artists`, `/api/top-tracks`,
`/api/daily`, `/api/on-this-day` and `/api/radio` are kept in the Cache API until a new
play or track arrives (three rows read to check), and sent with
`Cache-Control: private, max-age=60`; a kept answer has `X-Cache: hit`, and its
`X-Rows-Read` is the rows the check read, while the body's `_meta.rows_read`
stays what its first computation read. A fresh answer's header matches
`_meta`. An import of older plays can take up to ten minutes to show there. `/api/now-playing` and
`/api/recently-played` share one Spotify answer across every client and colo;
see [Live from Spotify](api.md#live-from-spotify).

### The play-count rollup

`/api/daily`, `/api/top-tracks` and `/api/top-artists` over long ranges read
counts per local day, and per local month and track, from tables that
triggers on `plays` keep up to date, instead of every play. The answers are
identical either way.

The rollup is built in one zone: `TIMEZONE`, else the latest era's zone, else
UTC. A request whose `tz` is that zone uses it; any other `tz` counts plays as
before. The migration builds it in UTC. For any other zone it is rebuilt by
the daily cron, or at once with `POST /admin/rollup` (one large read of every
play). Changing `TIMEZONE` or `ERAS` later rebuilds
it the same way.
