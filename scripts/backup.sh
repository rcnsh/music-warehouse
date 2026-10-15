#!/usr/bin/env bash
#
# Export the D1 database to a timestamped .sql file and keep the newest few.
#
# D1 is the only copy of every play older than Spotify's 50-item window, and
# Time Travel only reaches back 30 days (7 on Free). This is the copy that
# outlives both. See README, "Backups and recovery".
#
#   scripts/backup.sh              # the production database (--remote)
#   scripts/backup.sh --local      # the wrangler dev database, to try it out
#
# Settings, from the environment:
#   BACKUP_DIR   where exports go       default ~/Backups/music-warehouse
#   BACKUP_KEEP  how many to keep       default 12 (three months, weekly)
#   D1_DATABASE  the database name      default music_warehouse
#
# `wrangler d1 export` refuses a database that holds a virtual table, and
# this one has the FTS5 search index (migration 0011). So it exports every
# real table by name, skipping the index and its shadow tables. The index is
# derived entirely from track_search_text, so the file ends by recreating it
# and rebuilding it from that table, which makes it restorable as it is.
#
# A running export blocks other queries to the database. A poll that lands
# on it fails and the next one catches up, since the cursor never advanced.

set -euo pipefail

where="--remote"
if [[ "${1:-}" == "--local" ]]; then where="--local"; fi

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

db="${D1_DATABASE:-music_warehouse}"
dir="${BACKUP_DIR:-$HOME/Backups/music-warehouse}"
keep="${BACKUP_KEEP:-12}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dir/$db-$stamp.sql"
partial="$out.partial"

mkdir -p "$dir"
chmod 700 "$dir"

# Real tables only: no SQLite or Cloudflare internals, no virtual tables, and
# none of a virtual table's shadow tables (fts5 makes _data, _idx, _docsize,
# _config and, without external content, _content).
tables_sql="SELECT name FROM sqlite_master t
 WHERE type = 'table'
   AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
   AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
   AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
   AND NOT EXISTS (
     SELECT 1 FROM sqlite_master v
      WHERE v.type = 'table' AND v.sql LIKE 'CREATE VIRTUAL TABLE%'
        AND t.name IN (v.name || '_data', v.name || '_idx', v.name || '_docsize', v.name || '_config', v.name || '_content'))
 ORDER BY name"

# An export by table carries tables and rows but no indexes or triggers, so
# those are read here and appended. Triggers come last: the rollup triggers
# must not fire while the rows are loaded (the rollup tables are in the
# export already), and the search ones write to an index created at the end.
extras_sql="SELECT sql FROM sqlite_master
 WHERE type IN ('index', 'trigger') AND sql IS NOT NULL
   AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
   AND tbl_name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
 ORDER BY type = 'trigger', name"

rows() { # print one column of a `wrangler d1 execute --json` result, one row per line
  node -e 'for (const row of JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results) console.log(Object.values(row)[0])'
}

tables=()
while IFS= read -r name; do
  [[ -n "$name" ]] && tables+=("--table=$name")
done < <(npx wrangler d1 execute "$db" "$where" --json --command "$tables_sql" </dev/null | rows)

if [[ ${#tables[@]} -eq 0 ]]; then
  echo "backup: found no tables in $db" >&2
  exit 1
fi

extras="$(npx wrangler d1 execute "$db" "$where" --json --command "$extras_sql" </dev/null |
  node -e 'for (const row of JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results) console.log(row.sql + ";")')"

npx wrangler d1 export "$db" "$where" --output "$partial" "${tables[@]}" </dev/null

# The search index must match migration 0011. It is created after the rows,
# then rebuilt from track_search_text, which holds everything it indexes.
{
  printf '\n-- Appended by scripts/backup.sh. The FTS5 search index (migration 0011),\n'
  printf -- '-- which wrangler d1 export cannot dump, rebuilt from track_search_text.\n'
  cat <<'SQL'
CREATE VIRTUAL TABLE IF NOT EXISTS track_search USING fts5(
  text,
  content = 'track_search_text',
  content_rowid = 'id',
  tokenize = 'trigram remove_diacritics 1'
);
INSERT INTO track_search (track_search) VALUES ('rebuild');
SQL
  printf '\n-- Indexes and triggers, which an export by table leaves out.\n'
  printf '%s\n' "$extras"
} >>"$partial"

if ! grep -q 'INSERT INTO "\{0,1\}plays' "$partial"; then
  echo "backup: $partial has no plays; keeping it for a look, not rotating" >&2
  exit 1
fi

mv "$partial" "$out"
chmod 600 "$out"
echo "backup: wrote $out ($(du -h "$out" | cut -f1))"

# Keep the newest $keep. Names sort by time, so the oldest come first.
# (macOS head has no negative counts, hence the arithmetic.)
all=()
while IFS= read -r file; do all+=("$file"); done < <(ls -1 "$dir"/"$db"-*.sql | sort)
excess=$(( ${#all[@]} - keep ))
for (( i = 0; i < excess; i++ )); do
  rm -f -- "${all[$i]}"
  echo "backup: removed ${all[$i]}"
done
