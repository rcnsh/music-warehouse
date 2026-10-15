# Stats and Wrapped

A client reads cached, publishable aggregates (`/api/stats/{name}`) and a Spotify-Wrapped-style summary of any finished date range (`/api/wrapped`). Read tokens may only compute the preset ranges `/api/wrapped/ranges` lists; anything else must already be computed. A body that is still being computed answers `503` with `Retry-After`.

## Sub-features

- `stats-names` serves `on-repeat`, `rhythm`, `top-over-time`, `eras`, `albums`, each with `as_of` and `X-Stats-Source`/`X-Stats-Computed-At`.
- `stats-unknown` answers `404` for any other name.
- `wrapped-ranges` lists presets newest first with `computed` flags.
- `wrapped-preset` computes a preset for a read token, then serves the stored body.
- `wrapped-read-403` refuses a read token a non-preset range nobody computed.
- `wrapped-admin` lets the admin token compute any finished range, after which a read token can read it.
- `wrapped-unfinished` refuses a range ending today or later (`400`).
- `still-computing-503` answers `503` + `Retry-After` while another request holds the compute.

## How to get to it (user POV)

- Wrapped site and Spicetify: `GET /api/wrapped/ranges`, then `GET /api/wrapped?from=&to=`.
- MCP `get_stat`, `get_wrapped`, `list_wrapped_ranges`; GUI stats pages: `GET /api/stats/{name}`.

## Driving it with api.sh

Preconditions:

- A fresh launch (no Wrapped or stats body computed yet), `doctor.sh` healthy.
- `S=.claude/skills/verify-warehouse/scripts`.

- **Presets.** Run `$S/api.sh read stats-wrapped/ranges GET '/api/wrapped/ranges'`. Two ranges: `2026 so far` (`kind` `year_to_date`, `from` `2026-01-01`, `to` the last Sunday before today) and `2025` (`kind` `year`, `2025-01-01`–`2025-12-31`), both `computed: false`.
- **Read token, non-preset.** Run `$S/api.sh read stats-wrapped/march-read-403 GET '/api/wrapped?from=2025-03-01&to=2025-03-31'`. `HTTP 403`, error names `/api/wrapped/ranges`.
- **Read token, preset.** Run `$S/api.sh read stats-wrapped/2025 GET '/api/wrapped?from=2025-01-01&to=2025-12-31'`. `HTTP 200`, `X-Stats-Source: computed`. `totals` is `plays` 183, `minutes` 549, `days_listened` 92, `artists` 5, `songs` 11, `skips` 0; `top_songs[0]` is `Harbour Lights`, 32 plays, `track_id` `mwverify00000000000001`; `top_artists[0]` is `The Paper Lanterns` with `id` `name:The Paper Lanterns`.
- **Stored now.** Repeat as `stats-wrapped/2025-again`: same `X-Stats-Computed-At`, `X-Stats-Source: snapshot`. Run `$S/api.sh read stats-wrapped/ranges-after GET '/api/wrapped/ranges'`: `2025` now `computed: true`.
- **Admin computes any range.** Run `$S/api.sh admin stats-wrapped/march-admin GET '/api/wrapped?from=2025-03-01&to=2025-03-31'` (`200`, `totals.plays` 15), then `$S/api.sh read stats-wrapped/march-read-after GET '/api/wrapped?from=2025-03-01&to=2025-03-31'` (`200`, same body).
- **Unfinished range.** Run `$S/api.sh read stats-wrapped/unfinished GET '/api/wrapped?from=2026-10-01&to=2030-01-01'`. `HTTP 400`, `` `to` must be before today… ``.
- **Stats.** For each of `on-repeat rhythm top-over-time eras albums`, run `$S/api.sh read stats-wrapped/stat-<name> GET '/api/stats/<name>'`. All `200` with `as_of`; first call `X-Stats-Source: computed`. `top-over-time.quarters[0]` is `2025-Q1` with 45 plays. `$S/api.sh read stats-wrapped/stat-bogus GET '/api/stats/bogus'` is `404`.
- **Still computing (503).** Fire six concurrent first requests for one uncomputed stat, e.g. `for i in 1 2 3 4 5 6; do $S/api.sh read stats-wrapped/race-$i GET '/api/stats/rhythm' & done; wait` on a fresh run. A pass shows one `computed` and the rest `edge`/`snapshot`, or a `503` whose headers carry `Retry-After` and whose body is `{"error":"Stats are being computed; try again shortly."}`. Report which happened.
- **Proof.** The ranges before and after, the 403 and the later 200 for the same range, and the stat headers.

## Gotchas

- The `503` needs a compute slow enough for a second request to land while the first holds the claim. On this 326-play seed every compute finishes in milliseconds, so the race did not produce a `503` (six concurrent first requests for `on-repeat`, and again for `rhythm`: one `computed`, five `edge` each time). Report `still-computing-503` as not reproduced; do not fake it by writing to `stats_snapshots`.
- A read token never computes a stored range again: its second read reports `X-Stats-Source: snapshot` (from D1), where the admin token's would come from `edge`.
- `on-repeat` covers the last 14 days, which the seed (ending 2026-10-09) has little or nothing in; `eras` is `ready: false` (no `ERAS` configured); `albums` is empty (export plays carry no albums). Empty bodies there are correct, not failures.
- Wrapped `minutes` are estimated from `ms_played`-less export plays, so they are not `plays × duration`.
- `/api/wrapped` caches per range; re-running a step on the same run sees the stored body. Relaunch for a cold start.
