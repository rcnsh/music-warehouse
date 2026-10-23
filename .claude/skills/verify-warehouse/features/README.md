# music-warehouse verification map

This directory is the maintained source for verifying the user-facing behaviour of the music-warehouse HTTP API. Read this index before driving, then follow the matching feature file as the recipe.

## Baseline preconditions

- A run started by `.claude/skills/verify-warehouse/scripts/launch.sh` from a clean scratch dir, and `doctor.sh` reporting `doctor: healthy`.
- The seed is loaded: 326 stored plays from `seed/Streaming_History_Audio_verify.json`, all `source: "export"`, from 2025-01-01 to 2026-10-09 (UTC), five fictional artists, twelve tracks with ids `mwverify000000000000NN`.
- The warehouse zone is `UTC`. Pass `tz=UTC` (or omit `tz`) so the expected values below hold.
- Never drive an instance this run did not start, and never the production Worker.

## Driving conventions

- `S=.claude/skills/verify-warehouse/scripts`. Every request goes through `$S/api.sh <auth> <label> <METHOD> '<path>'`; every state check through `$S/db.sh <label> "SELECT …"`.
- `read` auth for `/api/*` (as clients call it), `admin` for `/admin/*` and `/health`, `none` for `/auth/*`.
- Labels start with the feature's directory name: `history/`, `top-daily/`, `stats-wrapped/`, `tokens-signin/`, `health/`.
- Quote every path containing `?` or `&` (zsh).
- Commands are literal. Keep names, ids and flags unchanged.
- Drives here write tokens and sign-ins, never plays. Anything that would import or remove plays needs a fresh launch afterwards, since the expected values assume exactly the seed.

## Proof and skip reporting

- Proof is the saved request, status, headers and body, plus a second read showing the effect.
- Assert exact seed values from the feature file, not only the status.
- Report the feature file, sub-feature IDs and labels used with every artifact.
- An unreachable path is reported with the attempted command and the unmet precondition. A route excluded by the safety rules (Spotify, Ticketmaster, crons) is reported as out of scope, never as verified.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behaviour, then exactly four H2 sections in this order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every client entry point.
3. `Driving it with api.sh`: starts with `Preconditions:`, then labelled bullets pairing each action with an exact command and the observable result.
4. `Gotchas`: traps that waste or invalidate a run.

## Features

- [Listening history](./listening-history.md): `/api/plays` paging with `next_before`, ties within a millisecond, `q`/`track_id`/`artist_name` filters, `/api/plays.csv`, auth errors.
- [Top songs, top artists and daily counts](./top-and-daily.md): `/api/top-artists`, `/api/top-tracks` with edition folding, `/api/daily` with `group_by` day/week/month, the history cache.
- [Stats and Wrapped](./stats-and-wrapped.md): `/api/stats/{name}`, `/api/wrapped` and `/api/wrapped/ranges`, read-token limits, the still-computing `503`.
- [Device tokens and sign-in](./device-tokens-and-sign-in.md): `/admin/tokens` mint, list and revoke; the `/auth/login` confirmation page, Cancel, and Allow up to Spotify; `/auth/token`.
- [Health](./health.md): `/health` for a never-authorized warehouse, and who may read it.

## Not mapped yet

`/api/artist`, `/api/track`, `/api/search` (answer on the seed, e.g. `/api/artist?name=The%20Paper%20Lanterns` has 82 plays and `/api/search?q=harbour` finds `Harbour Lights` with 56), `/api/on-this-day` and `/api/home` (both empty on this seed), `/api/radio` (the seed's plays are mostly hours apart, so most songs have an empty radio; `?track=mwverify00000000000004` lists one, `mwverify00000000000010`), `/api/concerts`, `/admin/cleanup/*`, `/admin/rollup`, `/admin/alert-check`, `POST /admin/import?dry_run=1`.
