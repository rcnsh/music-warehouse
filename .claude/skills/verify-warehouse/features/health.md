# Health

The owner checks whether ingestion is working with `GET /health`: whether a Spotify grant is stored and accepted, when the last poll succeeded, how many plays are stored, and what to do when something needs a human. It is an admin-only route.

## Sub-features

- `health-never-authorized` reports `ok: false`, `authorized: false`, `stalled: true` and `action_required` pointing at `/login`.
- `health-counts` reports `total_plays` (from the rollup) and `plays_last_24h`.
- `health-concerts` reports the concert check's state under `concerts`, `failing: false` without a Ticketmaster key.
- `health-spotify` reports the shared Spotify quota under `spotify` (migration 0021): no pause and no calls on a fresh run.
- `health-auth` answers `401` with `WWW-Authenticate: Bearer` to no token and to a read token.
- `root-routes` lists every route at `GET /` for the admin token.

## How to get to it (user POV)

- Owner: `curl -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/health"` (README "Health").
- Monitoring (the healthchecks heartbeat is separate and not in scope).

## Driving it with api.sh

Preconditions:

- `doctor.sh` healthy. `S=.claude/skills/verify-warehouse/scripts`.

- **Admin read.** Run `$S/api.sh admin health/admin GET /health`. `HTTP 200`; `ok` false, `authorized` false, `needs_reauth` false, `stalled` true, `action_required` `Never authorized. Start at /login — see README "Authorizing".`, `total_plays` 326, `plays_last_24h` 0, `last_success_ms` null, `cursor_ms` 0, `consecutive_failures` 0, `days_until_token_expiry` null, `concerts.failing` false, `spotify` `{"paused_until_ms":null,"paused_until_iso":null,"pause_kind":null,"calls_24h":0,"by_source_24h":{},"rate_limited_24h":0}`.
- **Read token refused.** Run `$S/api.sh read health/read GET /health`. `HTTP 401`, `{"error":"Unauthorized"}`.
- **No token.** Run `$S/api.sh none health/none GET /health`. `HTTP 401` with header `WWW-Authenticate: Bearer`.
- **Route list.** Run `$S/api.sh admin health/root GET /`. `service` is `music-warehouse`; `routes` includes `/health`, `/api/plays`, `/admin/tokens`, `/auth/login`.
- **Proof.** `total_plays` 326 equals the seed import's `inserted` in `launch/import.log`: the rollup (migration 0014's triggers) counted every imported play.

## Gotchas

- `ok: true` needs a stored grant and a poll in the last 3 hours. Neither is possible without Spotify, so `ok: true` is out of scope here; do not insert an `oauth_token` row to fake it.
- `/health` is not under `/api/`, so read tokens get `401`, not `403`.
- Don't call `POST /admin/poll` to move `last_success_ms`: it calls Spotify.
- A non-empty `spotify` (a pause, or calls counted) needs Spotify calls or SQL writes, both out of scope; the pause, the shared answers and the counts are covered by `test/quota.test.ts`.
