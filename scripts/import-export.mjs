#!/usr/bin/env node
/**
 * Backfill the warehouse from a Spotify Extended Streaming History export.
 *
 * The export is the only way to recover listening from before the Worker
 * existed. It is also large: ten years of listening is plausibly 100,000+
 * records, and D1's free plan allows 100,000 row writes per calendar day
 * counting index writes. So this script paces itself against a row-write
 * ceiling, records where it stopped, and resumes the next day.
 *
 *   ADMIN_TOKEN=... node scripts/import-export.mjs \
 *     --dir ./export-data --url https://music-warehouse.<subdomain>.workers.dev
 *
 * It is safe to re-run at any time: the Worker inserts with INSERT OR IGNORE
 * against the (played_at_ms, track_id) primary key, so repeats cost nothing but
 * time.
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
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === 'chunk' || key === 'dailyRowLimit' || key === 'delayMs') args[key] = Number(value);
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
  const response = await fetch(`${args.url.replace(/\/$/, '')}/admin/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Import failed (${response.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const files = await listExportFiles(args.dir);
  if (files.length === 0) {
    console.error(`No Streaming_History_Audio*.json files found in ${args.dir}.`);
    process.exit(1);
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
      await saveState(state);

      process.stdout.write(
        `\r  ${state.recordIndex}/${records.length} | inserted ${state.totalInserted} | ` +
          `rows written today ${state.rowsWrittenToday}/${args.dailyRowLimit}   `,
      );
      await sleep(args.delayMs);
    }

    state.recordIndex = 0;
    await saveState(state);
  }

  console.log(`\n\nDone. ${state.totalInserted} play rows inserted in total.`);
  console.log('Verify: wrangler d1 execute music_warehouse --remote --command "SELECT source, COUNT(*) FROM plays GROUP BY source;"');
}

await main();
