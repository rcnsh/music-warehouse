# Importing your history

All the scripts below read `ADMIN_TOKEN` from the environment, as
`npm run authorize` does.

## The export

Unzip the export. The script reads every `Streaming_History_Audio_*.json` in
one directory:

```bash
unzip my_spotify_data.zip -d export
npm run import -- --dir "export/Spotify Extended Streaming History" --url "$WORKER_URL"
```

| Flag | Default | |
|---|---|---|
| `--dir` | `./export-data` | Directory holding `Streaming_History_Audio_*.json`. |
| `--url` | `http://127.0.0.1:8787` | The Worker. |
| `--chunk` | `500` | Records per `POST /admin/import`. |
| `--dailyRowLimit` | `90000` | Stop after writing this many rows in a UTC day. |
| `--state` | `.import-state.json` | Where progress is saved. |
| `--delayMs` | `250` | Pause between chunks. |
| `--matchWindow` | `5` | Seconds within which an export record and a stored play of the same track count as one play. `0` matches exact timestamps only. |
| `--dryRun` | off | Write nothing; report where the export would add plays. |
| `--tz` | this machine's zone | Zone for the dry run's months and days. |
| `--report` | `import-report.json` | Where the dry run writes per-day counts. |

On the Free plan D1 allows 100,000 row writes a day, index writes included, so
the script stops at 90,000 and a long history takes several days. Re-run it
after 00:00 UTC and it continues from `.import-state.json`. Workers Paid has no
daily cap (50 million writes a month are included), so there pass a larger
`--dailyRowLimit` to import in one run. Re-running is always safe: a record
is ignored when a play of the same track is already stored within 5 seconds
of it, which also catches the poller's copy of the same play (the export
rounds times down to the second, the API keeps milliseconds). Skips, records
with `ms_played` under 30 seconds, are dropped, as are podcasts and local
files. An import clears the cached stats and Wrapped bodies, which recompute
on their next request.

### Finding gaps first

A dry run walks the whole export, writes nothing (no plays, no progress, no row
budget) and prints how many plays each month would gain, with per-day counts in
`import-report.json`:

```bash
npm run import -- --dryRun --dir "export/Spotify Extended Streaming History" --url "$WORKER_URL"
```

It also prints how far apart matched stored and export timestamps were. The
same play should land at a steady offset well inside the 5-second window
(`--matchWindow`). If many new plays fall in months the poller already covered,
compare with a dry run at a wider `--matchWindow` before the real run; two
genuine plays of a track end at least 30 seconds apart, so keep it under that.

### Cleaning up an older import

`npm run clean:export` removes skips and duplicate copies that an older
version of the importer let in. It reports by default; `--apply` removes:

```bash
npm run clean:export -- skips --dir "export/Spotify Extended Streaming History" --url "$WORKER_URL"
npm run clean:export -- short-gaps --url "$WORKER_URL"   # without the files: a heuristic
npm run clean:export -- overlaps --url "$WORKER_URL"     # export copies of polled plays
```

`skips` is exact: the files name each skip. `short-gaps` removes export plays
that ended under 30 seconds after the play before, which never removes a play
that counted but misses a skip that followed a pause. Every removal repairs the
rollup and play numbers and clears the cached bodies.

## Album art

The export names albums but carries no art. Two scripts fill it in, both
resumable and safe to interrupt:

```bash
npm run backfill:albums -- --url "$WORKER_URL"    # most of it, in minutes
npm run backfill:catalog -- --url "$WORKER_URL"   # the rest, ~600 tracks a day
```

`backfill:albums` walks your Top Tracks, Liked Songs and Saved Albums:

| Flag | Default | |
|---|---|---|
| `--source` | `all` | `top`, `saved`, `albums`, or `all` for all three. |
| `--pages` | `4` | Pages of 50 per request (1 to 20). |
| `--state` | `.albums-state.json` | |
| `--delayMs` / `--maxRetries` | `300` / `5` | |

`backfill:catalog` looks tracks up one at a time, which reaches the ones you
never saved. Spotify allows a development-mode app roughly 600 of these a day;
the script stops at the first 429, prints when to try again, and resumes from
`.catalog-state.json`.

| Flag | Default | |
|---|---|---|
| `--limit` | `25` | Tracks per request (1 to 200). |
| `--state` | `.catalog-state.json` | |
| `--delayMs` / `--maxRetries` | `2000` / `6` | |

Both also take `--url` (default `http://127.0.0.1:8787`).
