#!/usr/bin/env node
/**
 * Fill album art for tracks no user-scoped endpoint reaches.
 *
 * `GET /v1/tracks/{id}` is the one catalog endpoint still open to an app in
 * development mode, so this closes the long tail the Top Tracks / Liked Songs /
 * Saved Albums walk cannot: tracks played once years ago and never saved.
 *
 *   ADMIN_TOKEN=... npm run backfill:catalog -- --url https://music-api.rcn.sh
 *
 * One Spotify request per track, so it is slower than the user-scoped sources
 * — but it needs no user scope at all, and reaches everything. The defaults
 * hold it near 2 requests/second: fast enough to finish the tail in under an
 * hour, slow enough not to trip Spotify's rolling window, which answers a
 * breach with a Retry-After measured in tens of minutes.
 *
 * Progress is a cursor over track_id in .catalog-state.json; safe to interrupt
 * and safe to re-run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

function parseArgs(argv) {
  const args = { url: 'http://127.0.0.1:8787', limit: 25, state: '.catalog-state.json', delayMs: 2000, maxRetries: 6 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === 'limit' || key === 'delayMs' || key === 'maxRetries') args[key] = Number(value);
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
  if (!existsSync(args.state)) return { cursor: '', examined: 0, updated: 0, missing: 0 };
  return JSON.parse(await readFile(args.state, 'utf8'));
}

async function saveState(state) {
  await writeFile(args.state, `${JSON.stringify(state, null, 2)}\n`);
}

async function callOnce(cursor) {
  const endpoint =
    `${args.url.replace(/\/$/, '')}/admin/backfill-catalog` +
    `?limit=${args.limit}&after=${encodeURIComponent(cursor)}`;
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
    throw new Error(`Catalog backfill failed (${response.status}): ${text.slice(0, 300)}`);
  }
  throw new Error(`Still rate limited after ${args.maxRetries} retries. Re-run later; progress is saved.`);
}

async function main() {
  const state = await loadState();
  if (state.cursor) console.log(`Resuming after track_id ${state.cursor}.`);

  for (;;) {
    const result = await callOnce(state.cursor);
    if (result.examined === 0 && result.done) break;

    state.cursor = result.next_cursor;
    state.examined += result.examined ?? 0;
    state.updated += result.tracks_updated ?? 0;
    state.missing += result.missing ?? 0;
    await saveState(state);

    process.stdout.write(`\r  examined ${state.examined} | album art filled ${state.updated} | unresolved ${state.missing}   `);

    // A rate limit here is measured in tens of minutes, not seconds. Retrying
    // on a short timer makes no progress and adds load to the very window that
    // needs to drain, so stop and let the operator come back.
    if (result.rate_limited) {
      const waitSeconds = result.retry_after_seconds;
      console.log('\n\nRate limited by Spotify. Progress is saved; nothing is lost.');
      if (waitSeconds) {
        const resumeAt = new Date(Date.now() + waitSeconds * 1000);
        console.log(`Retry-After: ${waitSeconds}s — resume after ${resumeAt.toISOString()} (${Math.round(waitSeconds / 60)} min).`);
      } else {
        console.log('No Retry-After header; give it an hour before re-running.');
      }
      console.log(`Re-run the same command to continue from track_id ${state.cursor}.`);
      return;
    }
    await sleep(args.delayMs);
  }

  console.log(`\n\nDone. ${state.examined} tracks examined, ${state.updated} gained album art, ${state.missing} unresolved.`);
}

await main();
