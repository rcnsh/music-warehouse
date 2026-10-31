---
name: verify-warehouse
description: Launch a disposable, local-only music-warehouse Worker (wrangler dev --local, scratch D1, dummy secrets, synthetic seed history) and drive its HTTP API (/api/*, /admin/*, /auth/*, /health) the way clients do, capturing evidence. Use to prove a change to the Worker works end to end against the real routes, or whenever someone asks to run, check or verify music-warehouse behaviour without touching production.
---

# Verify music-warehouse

The warehouse is a Cloudflare Worker over D1. Its user surface is the HTTP API; every client (below) reads `/api/*` with a device token. This skill starts a throwaway copy of the Worker on loopback, seeds it through the real import path, and drives routes with `curl`, saving each request and response as evidence. The feature map in [`features/`](features/README.md) holds the per-feature recipes.

All helpers live in `.claude/skills/verify-warehouse/scripts/` and run from any directory. Paths below are relative to the repo root.

## Safety rules (hard)

- **Local only.** Only `wrangler dev --local` with this run's own `--persist-to` scratch dir, `--port` and `--inspector-port`. Never `--remote`, never `npm run dev`/`deploy`/`migrate:remote`, never the production D1 or the production URL, never `wrangler.local.jsonc`. `launch.sh` passes `-c wrangler.jsonc --env test` explicitly so `scripts/wrangler.mjs` cannot swap in `wrangler.local.jsonc`.
- **No real secrets.** The repo's `.dev.vars` (if present) holds production secrets. The instance runs Wrangler env `test`, which reads the committed dummy `.dev.vars.test` instead, and gets per-run dummy `ADMIN_TOKEN`/Spotify values via `--var`. `launch.sh` refuses to start without `.dev.vars.test` and fails unless the log says `Using secrets defined in .dev.vars.test`. Never copy, source or print `.dev.vars`.
- **No Spotify or Ticketmaster calls.** The owner's Spotify developer quota is shared and exhausted. Out of scope for proofs: `/api/now-playing`, `/api/recently-played`, `/api/top`, `/login`, `/callback`, `POST /admin/poll`, `/admin/raw`, `/admin/backfill-*`, `/admin/concert-check`, any cron (`/__scheduled`, or the Local Explorer's `…/local/scheduled` route that `wrangler dev` advertises in its log) and the Spotify leg of sign-in. Sign-in is driven up to the boundary: the confirmation page, Cancel, and Allow's `303` to `accounts.spotify.com` recorded **without following it**. `api.sh` never follows redirects; do not add `-L`, and do not open a sign-in page in a browser past the warehouse's own page.
- **Kill only what you started.** Cleanup stops the process group `launch.sh` recorded, never by name; other `wrangler dev`/`workerd` processes on this machine belong to other projects.
- **Never double-drive.** Each `launch.sh` makes a new instance on free ports; drive only a run whose `run.env` you have. Two runs can coexist; pass `VERIFY_RUN` to pick one.

## Launch

```bash
.claude/skills/verify-warehouse/scripts/launch.sh
export VERIFY_RUN=<run dir it prints>     # optional: helpers default to the newest run
```

From an empty scratch dir (`$TMPDIR/verify-warehouse/<run-id>/`) it:

1. applies every migration to a local D1 (`d1 migrations apply music_warehouse_test --local --env test --persist-to …`);
2. starts `wrangler dev --local --env test` on `127.0.0.1`, port 8797 and inspector 9339 by default, or the next free ones (`VERIFY_PORT`, `VERIFY_INSPECTOR_PORT` override), in its own process group;
3. waits, in 0.5 s steps up to 60 s, until `GET /` answers `401`, then checks the log shows `.dev.vars.test` and no `.dev.vars`/`.env`;
4. imports `seed/Streaming_History_Audio_verify.json` (328 synthetic export records, fictional artists) with the repo's own `scripts/import-export.mjs`, i.e. `POST /admin/import`, and requires `/health` `total_plays` = 326;
5. mints a `read` device token with `POST /admin/tokens` and requires it to read `GET /api/plays?limit=1`.

Ready means step 5 passed and it prints `launch: ready`. On any failure it runs cleanup itself and copies the wrangler log into the evidence dir. `run.env` holds `BASE_URL`, `PORT`, `MW_ADMIN_TOKEN` (dummy), `MW_READ_TOKEN`, `MW_READ_TOKEN_ID`, `WRANGLER_PID`/`WRANGLER_PGID`, `PERSIST_DIR`, `EVIDENCE_DIR`, `LOG`.

The instance has no Spotify grant (`/health` `authorized: false`), no `TICKETMASTER_API_KEY`, no alert or heartbeat URL, no `CORS_ORIGINS`/`SIGN_IN_SCHEMES`, no `ERAS`, and `TIMEZONE` unset, so the warehouse zone is `UTC`. Crons are off in env `test`.

## Doctor

```bash
.claude/skills/verify-warehouse/scripts/doctor.sh [run-dir]
```

Read-only. Run it first, and again whenever anything looks off. It checks the wrangler PID is alive, the port is held by this run's process group, the URL is loopback, the D1 is in the scratch dir, `GET /` with the admin token says `service: music-warehouse`, `/health` `total_plays` is 326 and `authorized` is false, the read token reaches `/api/plays`, the log shows `.dev.vars.test` only, and HEAD is the launch commit. `doctor: healthy` and exit 0, or a `FAIL` line per problem. A drive that imports or deletes plays changes `total_plays`; relaunch rather than repair.

## Drive

```bash
S=.claude/skills/verify-warehouse/scripts
$S/api.sh <read|admin|none> <label> <METHOD> '<path?query>' [extra curl args]
$S/db.sh <label> "SELECT …"        # read-only SQL on this run's local D1
```

- `api.sh` sends the run's read device token (`read`, how clients call `/api/*`), its dummy admin token (`admin`, for `/admin/*` and `/health`), or nothing (`none`, for `/auth/*`). It prints `HTTP <status>` and the body, and saves `<label>.request.txt`, `.headers.txt` and `.body` under the evidence dir. It exits 0 whatever the status: assert on it. Quote paths with `?` in zsh.
- Forms and cookies pass through as curl args, e.g. `-c "$EVIDENCE_DIR/signin/cookies.txt"` then `-b … --data-urlencode decision=cancel`.
- `db.sh` accepts one `SELECT`/`WITH` statement and saves the SQL and rows. Use it to prove side effects (a token row, a pending sign-in), never to set state up: preconditions come from the seed or from user-facing routes.
- To read `run.env` values in your shell: `. "$VERIFY_RUN/run.env"` (or the newest run dir).
- The agent shell is zsh. Never name a variable `path` (it is tied to `$PATH`; assigning it breaks every command after it); use `req` or similar when looping over pages.

Route behaviour, parameters and errors are documented in `docs/api.md` and `docs/openapi.yaml`. The feature files give exact commands and the seed's expected values.

## Evidence

Everything lands in `verify-evidence/<run-id>/` at the repo root (gitignored, kept by cleanup):

- `launch/`: `migrations.log`, `import.log` (inserted 326, 1 skip), `health.json`, `token-mint.json` (token redacted).
- one `<label>.*` triple per `api.sh` call, and `<label>.sql`/`.json` per `db.sh` call, grouped by the label's directory (use the feature name: `history/…`, `top-daily/…`).
- `wrangler.log`, copied in by cleanup: the Worker's request log, including `Using secrets defined in .dev.vars.test`.

Proof standards:

- Drive the real user path: `/api/*` with the read device token as clients do, `/admin/*` with the admin token as the owner does. No test-only endpoints, no SQL writes, no calling Worker internals.
- Capture the action and the resulting state: the request, its status and body, and a second read that shows the effect (a list after a mint, a `401` after a revoke, a `db.sh` row count after a sign-in step).
- Assert against the seed's known values (in each feature file), not just a `200`.
- A journey the seed cannot satisfy is reported as a failure with the reason, never weakened to pass. Record which entry point each artifact proves; a skipped one is reported as skipped.
- Mocks: none. The only external systems (Spotify, Ticketmaster) are excluded, not faked.
- Admin-token responses from `POST /admin/tokens` contain the minted token in `.body`. It is a local throwaway, but don't paste it into reports.

## Cleanup

```bash
.claude/skills/verify-warehouse/scripts/cleanup.sh [run-dir]
```

Copies `wrangler.log` into the evidence dir, sends `TERM` (then `KILL` after 10 s) to the recorded process group only, checks no process of that group and no listener of its ports remain, and deletes the scratch run dir (local D1 and `run.env`). It refuses to delete anything outside `$TMPDIR/verify-warehouse/`. Exit 1 means something survived: report it. Run it after every attempt, failed or not. Evidence is never deleted; remove `verify-evidence/<run-id>/` by hand when no longer needed.

Wrangler also writes build output to `.wrangler/tmp/` in the repo (gitignored, shared with normal dev); cleanup leaves it.

## Helpers

| Script | Use |
|---|---|
| `scripts/launch.sh` | Start and seed a run. Env `VERIFY_PORT`, `VERIFY_INSPECTOR_PORT`. |
| `scripts/doctor.sh [run]` | Read-only health of a run. |
| `scripts/api.sh <auth> <label> <METHOD> <path> [curl args]` | One recorded HTTP request. |
| `scripts/db.sh <label> "SELECT …"` | One recorded read-only query on the run's local D1. |
| `scripts/cleanup.sh [run]` | Tear down a run, keep its evidence. |
| `seed/Streaming_History_Audio_verify.json` | Verification scaffolding: synthetic export, fictional artists and track ids `mwverify…`. Never real listening data. |

`[run]` is a run dir or its `run.env`; default `$VERIFY_RUN`, else the newest run under `$TMPDIR/verify-warehouse/`. Needs `node` (repo deps installed with `npm ci`), `curl`, `jq`, `lsof`, `openssl`.

## Secondary surfaces (no harness here)

These clients live in separate repos under `~/dev/` and read this API with a device token. Verify them in their own repos; from here, prove the API contract they depend on (`docs/api.md` "Clients" lists the routes each reads):

- `music-warehouse-gui`: native macOS app.
- `music-warehouse-mcp`: MCP server.
- `music-warehouse-spicetify`: Spicetify custom app inside Spotify (browser origin, needs `CORS_ORIGINS`).
- `music-warehouse-wrapped`: Wrapped site (browser origin, needs `CORS_ORIGINS`).
- the Android app (signs in with a `SIGN_IN_SCHEMES` custom scheme).

The run sets no `CORS_ORIGINS` or `SIGN_IN_SCHEMES`, so `/api/*` sends no CORS headers and only loopback `return_to` works for sign-in. Proving CORS or a mobile scheme needs a launch variant adding `--var CORS_ORIGINS:…`/`--var SIGN_IN_SCHEMES:…`, which this skill does not ship yet; report those paths as not covered.

## How this was proved

On 2026-10-16 (Wrangler 4.151.0, macOS), launch → doctor → every step of `features/listening-history.md` → cleanup ran from an empty scratch dir and passed; afterwards the evidence dir was intact and no process or port of the run remained. A decoy `.dev.vars` with a canary `ADMIN_TOKEN` sat in the checkout throughout: the canary got `401` and the log showed only `.dev.vars.test`. The other feature files' expected values were checked on separate runs; their full journeys have not been run end to end as one proof. Maintain the map with `/maintain-verification-skill` as routes change.
