# Operations

Running a deployment once it is set up.

## Health

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/health"
```

`ok` is `true` while a Spotify grant is stored and still accepted and a poll
has succeeded in the last 3 hours (`minutes_since_last_success` under 180, the
same line as the `ingestion_stalled` alert); `stalled` says when it hasn't.
`action_required` names what to do whenever `ok` is false, and warns 14 days
before the grant expires. It also reports `total_plays`, `plays_last_24h`,
`days_until_token_expiry`, `cursor_iso`, `last_error` and
`consecutive_failures`, and under `concerts` how the daily concert check has
gone (`last_run_ms`, `last_success_ms`, `last_error`, `consecutive_failures`,
and `failing` from two failures in a row). A failing concert check sets
`action_required` but not `ok`, which is about recording plays.

`spotify` is the [shared quota](api.md#live-from-spotify): `paused_until_ms`,
`paused_until_iso` and `pause_kind` while calls are paused after a 429 (else
`null`), and for the last 24 hours `calls_24h` sent to `api.spotify.com`,
`by_source_24h` (`poll`, `contexts`, `now-playing`, `recently-played`, `top`,
`backfill`, `signin`, `admin`) and `rate_limited_24h`, how many were refused.
A stall during a pause stays a stall, as plays can age out meanwhile, but
`action_required` names the pause and when it ends.

`total_plays` is summed from the [play-count rollup](setup.md#the-play-count-rollup),
one row per day, rather than counted play by play, so a call reads a few
thousand rows rather than every play. Its triggers count each play on exactly
one day whatever the zone, so the total is exact.

## Alerting

After every poll the cron POSTs JSON to `ALERT_WEBHOOK_URL` when something
needs you, so a stall is reported within half an hour of crossing 3 hours. The
body carries the message under `content` (Discord), `text` (Slack) and
`message`, plus `title`, `severity` and `key`, so a Discord or Slack webhook
URL, or `https://ntfy.sh/<topic>`, works as-is. Without `ALERT_WEBHOOK_URL`,
conditions are logged but never pushed.

| Key | Severity | Condition |
|---|---|---|
| `not_authorized` | critical | Never authorized. |
| `needs_reauth` | critical | The grant was rejected; ingestion has stopped. |
| `token_expiring` | warning | The grant expires in 14 days or less. |
| `ingestion_stalled` | critical | No successful poll for 3 hours. While Spotify calls are paused after a 429 it says so, and when polling resumes. |
| `concert_check_failing` | warning | The daily concert check failed twice in a row (with `TICKETMASTER_API_KEY` set). |

The first two suppress the other Spotify conditions; the concert alert is
independent of them. A firing condition is re-sent at most once a
day, and alerts again immediately if it clears and comes back. Test it with
`POST /admin/alert-check?force=1`.

## Heartbeat

Alerts come from the Worker, so they cannot report the Worker itself being
down, its crons stopping, or D1 refusing every query. For that, set
`HEARTBEAT_URL` to a dead-man's switch: the cron GETs it (5-second timeout)
after every successful (or paused) poll, and the service alerts you when the pings stop.
A failed ping is logged, never retried, and never fails the poll.

With [healthchecks.io](https://healthchecks.io) (free for a few checks), make a
check with a period of 30 minutes and a grace of about 3 hours, so it alerts at
the same point as `ingestion_stalled`, then:

```bash
npx wrangler secret put HEARTBEAT_URL      # https://hc-ping.com/<uuid>
```

Any service that alerts on a missing GET works, e.g. Better Stack or Cronitor
heartbeats. A failed poll sends no ping, so a grant Spotify rejects shows up
there too, alongside the `needs_reauth` alert. A poll skipped because Spotify
calls are paused still pings: the Worker is running as it should, and a pause
that outlasts 3 hours raises `ingestion_stalled` instead.

## Checking ingestion

```bash
npx wrangler tail                       # watch the next cron run
npm run wrangler -- d1 execute music_warehouse --remote --command "SELECT COUNT(*) FROM plays;"
```

Play a few songs, wait for the next half hour, and look for them in
`/api/plays`.

## Redeploying

```bash
npm test && npm run typecheck && npm run deploy
```

Apply any new migration with `npm run migrate:remote` first: the code that
needs a new table or column must not go live before it exists, and every
migration so far only adds, so the old code keeps working against the new
schema in between. Note the time before applying one (`date -u +%s`), in case
it has to be undone.

To roll back a bad deploy:

```bash
npx wrangler deployments list              # the versions recently deployed
npx wrangler rollback                      # back to the previous version
npx wrangler rollback <version-id>         # or to a particular one
```

`wrangler secret put` makes a version too, so check the list before taking
"the previous version" on trust; a version carries the secrets it was made
with. A rollback never touches D1, so it does not undo a migration, and D1 has
no down migrations. Undo one of these ways:

- **Write a new migration that reverses it**, e.g. drops the new table. Best
  when it only added things, as all of them have so far: nothing else is lost.
- **Restore the database with Time Travel** to the time noted before applying
  it (see below). Exact, but it also discards every play stored since; the
  next poll recovers those still in Spotify's last 50.

Either way, roll the code back to a version that matches the schema.

## Backups and recovery

D1 holds the only copy of every play older than Spotify's last 50, so the
history needs a copy of its own. There are two layers.

**Time Travel** is always on and free. D1 can restore the database to any
minute in the last 30 days on Workers Paid (7 on Free):

```bash
npm run wrangler -- d1 time-travel info music_warehouse                       # the current bookmark
npm run wrangler -- d1 time-travel info music_warehouse --timestamp=2026-10-01T09:00:00Z
npm run wrangler -- d1 time-travel restore music_warehouse --timestamp=2026-10-01T09:00:00Z
```

A restore overwrites the database in place and cancels queries in flight. It
prints the bookmark from just before, so `time-travel restore
--bookmark=<that>` undoes it. Nothing older than the window survives, so it
cannot recover from a mistake noticed late, or the database being deleted.

**Exports** cover that. `scripts/backup.sh` writes the whole database to
`~/Backups/music-warehouse/music_warehouse-<UTC time>.sql` and keeps the newest
12:

```bash
npx wrangler login                          # once
scripts/backup.sh                           # BACKUP_DIR, BACKUP_KEEP and D1_DATABASE override the defaults
```

It runs Wrangler through `scripts/wrangler.mjs`, so it backs up the database
in `wrangler.local.jsonc`, and refuses to run against `--remote` without one.

`wrangler d1 export` refuses a database holding a virtual table, and the
search index is one. So the script exports every real table
by name, adds the indexes and triggers an export by table leaves out, and ends
the file by recreating the search index and rebuilding it from
`track_search_text`. The file restores as it is. An export blocks other
queries while it runs (seconds at this size); a poll caught by it fails and
the next one catches up.

To run it every Sunday on a Mac, edit the paths in
[`scripts/music-warehouse-backup.plist`](../scripts/music-warehouse-backup.plist)
and load it with launchd, as its comment shows. Copy the backups somewhere off
the Mac as well, e.g. a synced folder; they hold your Spotify refresh token,
so keep them private (the script makes them mode 600).

To restore an export, load it into an empty database and point the Worker at
it:

```bash
npx wrangler d1 create music_warehouse_restored
npx wrangler d1 execute music_warehouse_restored --remote --file ~/Backups/music-warehouse/music_warehouse-<time>.sql
npx wrangler d1 migrations list music_warehouse_restored --remote   # should have none to apply
```

Then put the new `database_name` and `database_id` in `wrangler.local.jsonc` (and
the `migrate:*` scripts in `package.json`), deploy, and check `/health`. The
export carries `d1_migrations`, so later migrations apply on top as normal.
Any plays newer than the export that are still in Spotify's last 50 come back
on the next poll; older ones can be re-imported from a Spotify export
([Importing your history](import.md)). Restoring into the
existing database instead would fail on tables that already exist; drop them
first, or use Time Travel if the moment you want is inside its window.
