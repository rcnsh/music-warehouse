# Architecture

One Cloudflare Worker, one D1 database, no other state. Setup and operation are
in the [README](README.md); this file is for reading the code.

## Components

| Piece | What it is |
|---|---|
| Worker | `src/index.ts`. A `fetch` handler for the HTTP routes and a `scheduled` handler for both crons. |
| D1 | Binding `DB`, database `music_warehouse`. Holds plays, catalog rows, OAuth tokens and sync state. |
| Crons | `*/30 * * * *` polls Spotify. `0 9 * * *` runs the alert sweep. Both in `wrangler.jsonc`. |
| Scripts | `scripts/*.mjs`. Node CLIs that drive the admin routes over HTTP: authorize, export import, album backfills. |
| Spotify | Web API. User grant for `/me/*`; a client-credentials app token for the catalog backfill only. |

## Data flow

Ingestion, every 30 minutes (`poll` in `src/ingest.ts`):

```txt
cron */30  ->  scheduled()            src/index.ts
           ->  readState()            src/db.ts       sync_state + oauth_token, one round trip
           ->  getAccessToken()       src/tokens.ts   refreshes if within 60 s of expiry
           ->  fetchRecentlyPlayed()  src/spotify.ts  GET /v1/me/player/recently-played?after=<cursor>
           ->  normalize()            src/normalize.ts
           ->  db.batch([...inserts, cursor update])  one transaction
```

`POST /admin/poll` calls the same `poll()`.

Failure handling:

- Any error before or during the batch leaves `cursor_ms` untouched and
  increments `consecutive_failures`. The next run asks for the same window.
- A 401 on the data call forces one token refresh and one retry.
- `400 invalid_grant` from the token endpoint sets `needs_reauth`. Polling stops
  until a human re-runs `/login`.

Alert sweep, daily at 09:00 UTC (`runAlertCheck` in `src/alerts.ts`): evaluates
the same state `/health` reports, POSTs to `ALERT_WEBHOOK_URL` for anything
firing, and records sends in `alerts` to limit repeats to one per 24 hours.

Export import (`scripts/import-export.mjs` -> `POST /admin/import` ->
`src/import.ts`): 500 records per request, same `INSERT OR IGNORE` path and
primary key as the poller, so overlaps are dropped rather than duplicated.

## Schema

Migrations live in `migrations/` and are applied with Wrangler's D1 migrations.

| Table | Key | Notes |
|---|---|---|
| `plays` | `(played_at_ms, track_id)` | `source` is `api` or `export`. |
| `tracks` | `track_id` | `album_id`, `isrc`, `duration_ms` may be null. |
| `artists` | `artist_id` | Export artists use `name:<artist name>` as the id. |
| `track_artists` | `(track_id, artist_id)` | `position` preserves credit order. |
| `albums` | `album_id` | Filled by polls and the album backfills, never by the export. |
| `oauth_token` | `id = 1` | Singleton. `authorized_at_ms` drives the six-month expiry countdown. |
| `oauth_state` | `id = 1` | Singleton. The `/login` state value, valid 10 minutes. |
| `sync_state` | `id = 1` | Singleton. `cursor_ms`, last success, last error, failure count. |
| `alerts` | `key` | Last send time per firing alert. Deleted when the condition clears. |

| Migration | Adds |
|---|---|
| `0001_init.sql` | Everything above except `alerts`, plus singleton rows. |
| `0002_alerts.sql` | `alerts`. |
| `0003_artist_name_index.sql` | `idx_artists_name`, for name-key reconciliation. |

All timestamps are UTC milliseconds stored as `INTEGER`.

## API

Routes are dispatched in a single `switch` in `src/index.ts`; the full list is
in the [README](README.md#api). Handlers by file:

| File | Routes |
|---|---|
| `src/index.ts` | `/login`, `/callback`, `/admin/poll`, `/admin/raw`, auth |
| `src/health.ts` | `/health` |
| `src/api.ts` | `/api/plays`, `/api/top-artists`, `/api/daily` |
| `src/live.ts` | `/api/now-playing`, `/api/top` |
| `src/alerts.ts` | `/admin/alert-check`, the daily cron |
| `src/import.ts` | `/admin/import` |
| `src/albums.ts` | `/admin/backfill-albums`, `/admin/backfill-catalog` |

Auth: every route except `/callback` needs `Authorization: Bearer <token>`.
`ADMIN_TOKEN` reaches everything; `READ_TOKEN` reaches `/api/*` only. Tokens
are compared by hashing both sides and using `timingSafeEqual`.

## Key files

| Path | Purpose |
|---|---|
| `src/index.ts` | Entry point, routing, auth, OAuth callback, cron dispatch. |
| `src/ingest.ts` | The poll cycle. |
| `src/spotify.ts` | Spotify HTTP calls, `SCOPE`, error classification. |
| `src/tokens.ts` | Access-token refresh, token persistence, expiry maths. |
| `src/normalize.ts` | Recently-played payload to row sets. |
| `src/db.ts` | Chunked insert builder, name-key reconciliation, state reads. |
| `src/tz.ts` | IANA zone to UTC day bounds, for `/api/daily` and `/api/top-artists`. |
| `src/types.ts` | `Env` and Spotify payload types. |
| `test/` | Vitest suites run inside workerd against a local D1. |
| `fixtures/` | Sample recently-played payload and notes on the captured shape. |

## Decisions

- **D1 for everything.** Tokens and data share one binding and one consistency
  model. There is no KV or Durable Object.
- **The cursor is the safety mechanism.** It advances inside the same batch as
  the writes, via `MAX(cursor_ms, ?)`, so it can't move backwards and can't
  advance without the rows.
- **`after` only.** `recently-played` is capped at 50 items, so paging back with
  `before` gains nothing. The first run omits `after` entirely.
- **One Spotify call per poll.** The response embeds full track, album and
  artist objects, so no follow-up lookups.
- **Chunked inserts in one batch.** D1 allows 100 bound parameters per
  statement (`MAX_BOUND_PARAMS` in `src/db.ts`), so multi-row inserts are split
  to fit and all issued in a single `db.batch()`.
- **UTC at rest, zones at read time.** SQLite has no timezone database, so
  `src/tz.ts` resolves local-day bounds in JS, including DST days.
- **Name-keyed export artists.** The export has names but no ids, and the batch
  catalog endpoints are 403 in development mode. `reconcileNameKeyedArtists`
  folds `name:` rows into real ids by exact name on every write.
- **Live routes are pass-through.** `/api/now-playing` and `/api/top` return
  Spotify's payloads unmodified and never touch `sync_state`, so a frontend
  needs no Spotify credential of its own and can't disturb ingestion.
