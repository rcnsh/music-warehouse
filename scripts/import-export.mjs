#!/usr/bin/env node
/**
 * Backfill the warehouse from a Spotify Extended Streaming History export.
 *
 * The export is the only way to recover listening from before the Worker
 * existed. It is also large: ten years of listening is plausibly 100,000+
 * records, and on the Free plan D1 allows 100,000 row writes per calendar day
 * counting index writes. So this script paces itself against a row-write
 * ceiling, records where it stopped, and resumes the next day. Workers Paid
 * has no daily cap; raise --dailyRowLimit there to import in one run.
 *
 *   ADMIN_TOKEN=... node scripts/import-export.mjs \
 *     --dir ./export-data --url https://music-warehouse.<subdomain>.workers.dev
 *
 * It is safe to re-run at any time: the Worker drops a record when a play of
 * the same track is already stored within --matchWindow seconds of it (5 by
 * default), which catches a re-run and the poller's copy of the same play
 * alike. It also drops skips (ms_played under 30 s).
 *
 * --dryRun writes nothing and reports where the export would add plays, by
 * local month and day, without touching the saved progress or the row budget:
 *
 *   ADMIN_TOKEN=... node scripts/import-export.mjs --dryRun --dir ./export-data --url ...
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    dir: './export-data',
    url: 'http://127.0.0.1:8787',
    chunk: 500,
    dailyRowLimit: 90_000,
    state: '.import-state.json',
    delayMs: 250,
    matchWindow: 5,
    dryRun: false,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    report: 'import-report.json',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key === 'dryRun') {
      args.dryRun = true;
      i--;
      continue;
    }
    const value = argv[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === 'chunk' || key === 'dailyRowLimit' || key === 'delayMs' || key === 'matchWindow') args[key] = Number(value);
    else if (key in args) args[key] = value;
    else throw new Error(`Unknown option --${key}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  console.error('Set ADMIN_TOKEN in the environment (the same value as `wrangler secret put ADMIN_TOKEN`).');
  process.exit(1);
}

/** Audio streams only. The export also ships video files, which hold no track URIs. */
async function listExportFiles(dir) {
  const entries = await readdir(dir);
  return entries
    .filter((name) => /^Streaming_History_Audio.*\.json$/i.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

async function loadState() {
  if (!existsSync(args.state)) return { fileIndex: 0, recordIndex: 0, day: today(), rowsWrittenToday: 0, totalInserted: 0 };
  const state = JSON.parse(await readFile(args.state, 'utf8'));
  // The D1 daily allowance resets at 00:00 UTC.
  if (state.day !== today()) {
    state.day = today();
    state.rowsWrittenToday = 0;
  }
  return state;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function saveState(state) {
  await writeFile(args.state, `${JSON.stringify(state, null, 2)}\n`);
}

async function postChunk(records) {
  const query = new URLSearchParams({ match_window_s: String(args.matchWindow) });
  if (args.dryRun) query.set('dry_run', '1');
  const response = await fetch(`${args.url.replace(/\/$/, '')}/admin/import?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Import failed (${response.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: args.tz, year: 'numeric', month: '2-digit', day: '2-digit' });

function percentile(sorted, p) {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Walk every file without writing, then say where the new plays would land. */
async function dryRun(files) {
  const byDay = new Map();
  const offsets = [];
  const totals = { received: 0, new: 0, duplicates: 0, skipped: 0, short: 0 };

  // A Worker from before dry runs would ignore the flag and import for real.
  // An empty chunk writes nothing either way, so ask with one first.
  if ((await postChunk([])).dry_run !== true) {
    console.error('This Worker does not support dry runs yet. Deploy it first; nothing was sent.');
    process.exit(1);
  }

  for (const file of files) {
    const records = JSON.parse(await readFile(file, 'utf8'));
    console.log(`${path.basename(file)}: ${records.length} records`);
    for (let start = 0; start < records.length; start += args.chunk) {
      const result = await postChunk(records.slice(start, start + args.chunk));
      for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0;
      for (const ms of result.new_plays_ms ?? []) {
        const day = dayFormat.format(new Date(ms));
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
      }
      offsets.push(...(result.duplicate_offsets_ms ?? []));
      await sleep(args.delayMs);
    }
  }

  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const byMonth = new Map();
  for (const [day, n] of days) byMonth.set(day.slice(0, 7), (byMonth.get(day.slice(0, 7)) ?? 0) + n);

  console.log(
    `\n${totals.received} records: ${totals.new} new, ${totals.duplicates} already stored (within ±${args.matchWindow}s), ` +
      `${totals.short} skips under 30 s, ${totals.skipped} skipped (podcasts, local files).`,
  );

  if (offsets.length > 0) {
    const signed = [...offsets].sort((a, b) => a - b);
    const abs = offsets.map(Math.abs).sort((a, b) => a - b);
    console.log(`\nStored minus export timestamp over ${offsets.length} matches (window ±${args.matchWindow}s):`);
    console.log(`  median ${seconds(percentile(signed, 0.5))}, |p95| ${seconds(percentile(abs, 0.95))}, |max| ${seconds(abs.at(-1))}`);
    // The same listen should land at a steady offset, well inside the window.
    // Matches near its edge suggest copies of polled plays just outside it:
    // compare with a dry run at a wider --matchWindow before the real run.
    if (abs.at(-1) > args.matchWindow * 500) {
      console.log('  Some matches sit in the outer half of the window: try a dry run with a wider --matchWindow.');
    }
  }

  if (days.length === 0) {
    console.log('\nNothing to add: the warehouse already holds every play in this export.');
    return;
  }

  console.log(`\nNew plays by month (${args.tz}):`);
  for (const [month, n] of byMonth) console.log(`  ${month}  ${String(n).padStart(6)}`);

  const report = { tz: args.tz, matchWindowS: args.matchWindow, totals, byMonth: Object.fromEntries(byMonth), byDay: Object.fromEntries(days) };
  await writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nPer-day counts written to ${args.report}. Nothing was imported.`);
}

async function main() {
  const files = await listExportFiles(args.dir);
  if (files.length === 0) {
    console.error(`No Streaming_History_Audio*.json files found in ${args.dir}.`);
    process.exit(1);
  }

  if (args.dryRun) {
    await dryRun(files);
    return;
  }

  const state = await loadState();
  console.log(`${files.length} export file(s); resuming at file ${state.fileIndex}, record ${state.recordIndex}.`);
  console.log(`Row-write budget left today: ${args.dailyRowLimit - state.rowsWrittenToday}.`);

  for (; state.fileIndex < files.length; state.fileIndex++) {
    const file = files[state.fileIndex];
    const records = JSON.parse(await readFile(file, 'utf8'));
    console.log(`\n${path.basename(file)}: ${records.length} records`);

    while (state.recordIndex < records.length) {
      if (state.rowsWrittenToday >= args.dailyRowLimit) {
        await saveState(state);
        console.log(
          `\nDaily row-write ceiling reached (${state.rowsWrittenToday}). ` +
            'Stopping cleanly — re-run after 00:00 UTC to continue.',
        );
        return;
      }

      const chunk = records.slice(state.recordIndex, state.recordIndex + args.chunk);
      const result = await postChunk(chunk);

      state.recordIndex += chunk.length;
      state.rowsWrittenToday += result.rows_written ?? 0;
      state.totalInserted += result.inserted ?? 0;
      state.totalDuplicates = (state.totalDuplicates ?? 0) + (result.duplicates ?? 0);
      state.totalShort = (state.totalShort ?? 0) + (result.short ?? 0);
      await saveState(state);

      process.stdout.write(
        `\r  ${state.recordIndex}/${records.length} | inserted ${state.totalInserted} | already stored ${state.totalDuplicates} | ` +
          `rows written today ${state.rowsWrittenToday}/${args.dailyRowLimit}   `,
      );
      await sleep(args.delayMs);
    }

    state.recordIndex = 0;
    await saveState(state);
  }

  console.log(
    `\n\nDone. ${state.totalInserted} play rows inserted in total; ${state.totalDuplicates ?? 0} records were already stored; ` +
      `${state.totalShort ?? 0} skips (under 30 s) dropped.`,
  );
  console.log('Verify: npm run wrangler -- d1 execute music_warehouse --remote --command "SELECT source, COUNT(*) FROM plays GROUP BY source;"');
}

await main();
