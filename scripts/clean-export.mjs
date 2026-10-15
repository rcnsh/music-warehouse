#!/usr/bin/env node
/**
 * Remove export rows an earlier import should never have stored. Reports only,
 * unless --apply is given.
 *
 *   ADMIN_TOKEN=... node scripts/clean-export.mjs <mode> --url "$WORKER_URL" [--apply]
 *
 * Modes:
 *   skips       Skips (ms_played under 30 s), named exactly by the export
 *               files: pass --dir as for `npm run import`.
 *   short-gaps  The same skips guessed without the files: export plays that
 *               ended under 30 s after the play before. A heuristic that never
 *               removes a counted play but misses a skip after a pause.
 *   overlaps    Export copies of plays the poller also stored, a few seconds
 *               apart. The report buckets every pair within 30 s by its gap.
 *
 * Every removal also repairs the rollup, play numbers and first sightings,
 * and drops the cached stats and Wrapped bodies (see src/cleanup.ts). Run
 * `skips` before `short-gaps` if you have the files: once the exact skips are
 * gone, the heuristic has less to guess.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const [mode, ...rest] = process.argv.slice(2);
const MODES = ['skips', 'short-gaps', 'overlaps'];
if (!MODES.includes(mode)) {
  console.error(`Usage: clean-export.mjs <${MODES.join('|')}> --url <worker> [--dir <export>] [--apply] [--limit 1000] [--chunk 500]`);
  process.exit(1);
}

const args = { url: 'http://127.0.0.1:8787', dir: './export-data', apply: false, limit: 1000, chunk: 500 };
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, '');
  if (key === 'apply') args.apply = true;
  else if (key in args) args[key] = key === 'limit' || key === 'chunk' ? Number(rest[++i]) : rest[++i];
  else throw new Error(`Unknown option --${key}`);
}

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  console.error('Set ADMIN_TOKEN in the environment.');
  process.exit(1);
}

async function post(route, params = {}, body) {
  const query = new URLSearchParams({ ...params, ...(args.apply ? { apply: '1' } : {}) });
  const response = await fetch(`${args.url.replace(/\/$/, '')}/admin/cleanup/${route}?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} failed (${response.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function addInto(total, gaps) {
  for (const [bucket, n] of Object.entries(gaps)) total[bucket] = (total[bucket] ?? 0) + n;
}

/** Page through a cursor route until it reports no next page. */
async function pages(route) {
  let cursor = {};
  const total = { matched: 0, removed: 0, gaps: {} };
  for (;;) {
    const page = await post(route, { ...cursor, limit: String(args.limit) });
    total.matched += page.matched;
    total.removed += page.removed;
    addInto(total.gaps, page.gaps);
    process.stdout.write(`\r  matched ${total.matched} | removed ${total.removed}   `);
    if (!page.next) break;
    cursor = Object.fromEntries(Object.entries(page.next).map(([k, v]) => [k, String(v)]));
  }
  return total;
}

async function skips() {
  const files = (await readdir(args.dir))
    .filter((name) => /^Streaming_History_Audio.*\.json$/i.test(name))
    .sort()
    .map((name) => path.join(args.dir, name));
  if (files.length === 0) throw new Error(`No Streaming_History_Audio*.json files found in ${args.dir}.`);
  const total = { short: 0, stored: 0, removed: 0 };
  for (const file of files) {
    const records = JSON.parse(await readFile(file, 'utf8'));
    console.log(`\n${path.basename(file)}: ${records.length} records`);
    for (let start = 0; start < records.length; start += args.chunk) {
      const result = await post('skips', {}, records.slice(start, start + args.chunk));
      total.short += result.short;
      total.stored += result.stored;
      total.removed += result.removed;
      process.stdout.write(`\r  short ${total.short} | stored ${total.stored} | removed ${total.removed}   `);
    }
  }
  return total;
}

const result = mode === 'skips' ? await skips() : await pages(mode);
console.log(`\n\n${args.apply ? 'Applied' : 'Dry run (pass --apply to remove)'}: ${JSON.stringify(result, null, 2)}`);
