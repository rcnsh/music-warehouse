# Listening history

A client lists stored plays newest first, pages back through the whole history with the opaque `next_before` cursor without skipping or repeating plays that share a millisecond, narrows the list by text, song or artist, and downloads the same plays as CSV.

## Sub-features

- `history-page` returns the newest plays with track, artist and album fields and a `next_before` cursor.
- `history-cursor` resumes exactly after the last play, including within a shared millisecond.
- `history-bare-ms` documents that a bare `played_at_ms` as `before` skips same-millisecond plays.
- `history-walk` pages to the end (`next_before: null`) and sees every stored play once.
- `history-q` filters by name, ignoring case and accents, and echoes `q`.
- `history-track` filters to one song, every edition folded.
- `history-artist` filters to one artist by `artist_name` or its `name:` placeholder `artist_id`.
- `history-csv` downloads the filtered plays as RFC 4180 CSV.
- `history-errors` rejects a bad `limit` (`400`) and a missing or admin-only token (`401`).

## How to get to it (user POV)

- macOS GUI history view, MCP `get_plays`, Spicetify history: `GET /api/plays` with a read token.
- A spreadsheet or backup: `GET /api/plays.csv`.
- Any client following `next_before` to page.

## Driving it with api.sh

Preconditions:

- `doctor.sh` reports `doctor: healthy` (326 plays).
- `S=.claude/skills/verify-warehouse/scripts`.
- The two newest seed plays share `played_at_ms` `1791579600000` (2026-10-09T21:00:00Z): `Driftwood Telephone` (`mwverify00000000000010`) and `Café Lumière` (`mwverify00000000000004`). The next one is `Fernlight` at `1791398833000`.

- **First page.** Run `$S/api.sh read history/page-1 GET '/api/plays?limit=1'`. `HTTP 200`; `plays[0].track_name` is `Driftwood Telephone`, `source` is `export`, `artist_list[0].id` is `name:Juniper & The Tides`, and `next_before` is `1791579600000.mwverify00000000000010`.
- **Resume inside the tie.** Pass the cursor back. Run `$S/api.sh read history/page-2 GET '/api/plays?limit=1&before=1791579600000.mwverify00000000000010'`. `plays[0].track_name` is `Café Lumière` with the same `played_at_ms` `1791579600000`; `next_before` is `1791579600000.mwverify00000000000004`.
- **Bare millisecond.** Run `$S/api.sh read history/bare-ms GET '/api/plays?limit=1&before=1791579600000'`. `plays[0]` is `Fernlight` at `1791398833000`: both tied plays are skipped, as `docs/api.md` warns.
- **Walk to the end.** Follow `next_before` with `limit=100`, URL-encoding nothing (the cursor is URL-safe), labels `history/walk-1`, `history/walk-2`, …, until `next_before` is `null`. Four pages of 100, 100, 100 and 26; the 326 `played_at_ms`+`track_id` pairs are all distinct (`jq -s` over the `.body` files).
- **Text filter.** Run `$S/api.sh read history/q GET '/api/plays?q=cafe&limit=500'`. `q` is echoed as `cafe`; 43 plays, all `Café Lumière`; `next_before` is `null`.
- **Song filter.** Run `$S/api.sh read history/track GET '/api/plays?track_id=mwverify00000000000001&limit=500'`. 56 plays: 42 of `Harbour Lights` and 14 of `Harbour Lights - Remastered 2024`, the edition folded in. `track_id` is echoed.
- **Artist filter.** Run `$S/api.sh read history/artist-name GET '/api/plays?artist_name=Orla%20Brightwater&limit=500'` and `$S/api.sh read history/artist-id GET '/api/plays?artist_id=name:Orla%20Brightwater&limit=500'`. Both return 56 plays and echo the filter.
- **CSV.** Run `$S/api.sh read history/csv GET '/api/plays.csv?q=cafe'`. `HTTP 200`, a `text/csv` content type, header line `played_at,track,artists,album,track_id,context_uri,context_name,source`, then 43 rows ending `,export` with CRLF line ends.
- **Errors.** Run `$S/api.sh read history/limit-501 GET '/api/plays?limit=501'` (`400`, `limit must be between 1 and 500`), `$S/api.sh none history/no-token GET '/api/plays'` (`401`, `WWW-Authenticate: Bearer`).
- **Proof.** The `history/*.body` and `.headers.txt` files hold every page; the walk's union is 326 distinct plays, matching `/health` `total_plays`.

## Gotchas

- `next_before` is `<ms>.<track_id>`; passing only the ms is legal but skips same-millisecond plays. Assert on the cursor form.
- Order within a millisecond is by `track_id` descending, so `…10` comes before `…04`.
- Export plays have `duration_ms`, `album_name`, `image_url`, `isrc` and every `context_*` field `null`: the export carries none of them. A non-null value would mean polled data, which this instance cannot have.
- `play_number` counts every edition of a song, so `Harbour Lights - Remastered 2024` plays carry numbers up to 56.
- The seed has no real Spotify artist ids; `artist_id` filters use the `name:` placeholder, URL-encoded.
- `GET /api/plays` is not cached; `/api/top-*` and `/api/daily` are (see top-and-daily).
