#!/usr/bin/env node
/**
 * Fill in album art for tracks the export could only name.
 *
 * Walks the user-scoped endpoints that return whole TrackObjects — Liked
 * Songs, Saved Albums, Top Tracks — because each embeds its album's cover art.
 * The catalog endpoints that would do this directly are 403 in Spotify's
 * development mode. See src/albums.ts.
 *
 *   ADMIN_TOKEN=... node scripts/backfill-albums.mjs --url https://music-api.rcn.sh
 *
 * `--source top` needs no scope beyond the one ingestion already holds;
 * `saved` and `albums` need `user-library-read`, so a fresh /login first.
 *
 * Safe to re-run and safe to interrupt: it only ever fills an album in where
 * one is missing, and progress is kept in .albums-state.json.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const TIME_RANGES = ['short_term', 'medium_term', 'long_term'];

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:8787',
    source: 'all',
    pages: 4,
    state: '.albums-state.json',
    delayMs: 300,
    maxRetries: 5,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === 'pages' || key === 'delayMs' || key === 'maxRetries') args[key] = Number(value);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadState() {
  if (!existsSync(args.state)) return { done: {}, tracksUpdated: 0, albumsWritten: 0 };
  return JSON.parse(await readFile(args.state, 'utf8'));
}

async function saveState(state) {
  await writeFile(args.state, `${JSON.stringify(state, null, 2)}\n`);
}

/** One /admin/backfill-albums call, retrying only 429 and 5xx. */
async function callOnce(params) {
  const query = new URLSearchParams({ ...params, pages: String(args.pages) });
  const endpoint = `${args.url.replace(/\/$/, '')}/admin/backfill-albums?${query}`;

  for (let attempt = 0; attempt <= args.maxRetries; attempt++) {
    let response;
    let text;
    try {
      response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
      text = await response.text();
    } catch (cause) {
      // A dropped connection or DNS blip is transient in exactly the way a 5xx
      // is. Left uncaught it aborts a walk that is otherwise resumable.
      const waitSeconds = 2 ** attempt;
      console.log(`\n  ${cause.code ?? cause.name} — waiting ${waitSeconds}s (attempt ${attempt + 1}/${args.maxRetries})`);
      await sleep(waitSeconds * 1000);
      continue;
    }
    if (response.ok) return JSON.parse(text);

    if (response.status === 429 || response.status >= 500) {
      let waitSeconds = 2 ** attempt;
      try {
        waitSeconds = JSON.parse(text).retry_after_seconds ?? waitSeconds;
      } catch {
        /* non-JSON body; fall back to the backoff */
      }
      console.log(`\n  ${response.status} — waiting ${waitSeconds}s (attempt ${attempt + 1}/${args.maxRetries})`);
      await sleep(waitSeconds * 1000);
      continue;
    }
    throw new Error(`Backfill failed (${response.status}): ${text.slice(0, 300)}`);
  }
  throw new Error(`Still rate limited after ${args.maxRetries} retries. Re-run later; progress is saved.`);
}

/** Walk one collection to exhaustion. `range` applies to the `top` source only. */
async function walk(state, source, range) {
  const key = range ? `${source}:${range}` : source;
  if (state.done[key]) {
    console.log(`${key}: already complete, skipping.`);
    return;
  }

  let offset = 0;
  for (;;) {
    const params = { source, offset: String(offset) };
    if (range) params.range = range;
    const result = await callOnce(params);

    offset = result.next_offset;
    state.tracksUpdated += result.tracks_updated ?? 0;
    state.albumsWritten += result.albums_written ?? 0;

    process.stdout.write(
      `\r  ${key}: scanned ${offset}${result.total ? `/${result.total}` : ''} | ` +
        `albums filled ${state.tracksUpdated} tracks   `,
    );

    if (result.done) break;
    await saveState(state);
    await sleep(args.delayMs);
  }

  state.done[key] = true;
  await saveState(state);
  console.log('');
}

async function main() {
  const state = await loadState();
  const sources = args.source === 'all' ? ['top', 'saved', 'albums'] : [args.source];
  console.log(`Backfilling album art from: ${sources.join(', ')}\n`);

  for (const source of sources) {
    if (source === 'top') {
      for (const range of TIME_RANGES) await walk(state, 'top', range);
    } else {
      await walk(state, source, null);
    }
  }

  console.log(`\nDone. ${state.tracksUpdated} tracks gained an album, ${state.albumsWritten} album rows written.`);
}

await main();
