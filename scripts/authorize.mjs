#!/usr/bin/env node
/**
 * Re-authorize the Worker against Spotify.
 *
 * Spotify's refresh token dies after roughly six months, and adding a scope
 * invalidates the existing grant, so both cases need a human at a browser. This
 * script does the awkward half: /login is bearer-authenticated (so the admin
 * token stays in a header, never a URL), which means the consent URL has to be
 * pulled out of a 302 rather than opened directly.
 *
 *   ADMIN_TOKEN=... npm run authorize -- --url https://music-api.rcn.sh
 *
 * Note this is *re-authorization*, not an access-token refresh. Access tokens
 * refresh themselves inside the Worker (see getAccessToken in src/tokens.ts)
 * and never need a human.
 */
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const args = { url: 'http://127.0.0.1:8787', open: 'false', waitSeconds: 300 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === undefined) continue;
    // --open is a bare flag as often as it is a pair.
    if (key === 'open' && (value === undefined || value.startsWith('--'))) {
      args.open = 'true';
      i -= 1;
      continue;
    }
    if (value === undefined) continue;
    if (key === 'waitSeconds') args.waitSeconds = Number(value);
    else if (key in args) args[key] = value;
    else throw new Error(`Unknown option --${key}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const base = args.url.replace(/\/$/, '');

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  console.error('Set ADMIN_TOKEN in the environment (the same value as `wrangler secret put ADMIN_TOKEN`).');
  process.exit(1);
}

const auth = { Authorization: `Bearer ${adminToken}` };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function health() {
  const response = await fetch(`${base}/health`, { headers: auth });
  if (!response.ok) throw new Error(`/health returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function main() {
  const before = await health();
  console.log(
    `Current grant: authorized=${before.authorized}` +
      (before.days_until_token_expiry !== null ? `, ${before.days_until_token_expiry} days until expiry` : '') +
      (before.needs_reauth ? ' — NEEDS REAUTH' : ''),
  );

  // `manual` keeps fetch from chasing the redirect to Spotify with the admin
  // token still attached to the request.
  const response = await fetch(`${base}/login`, { headers: auth, redirect: 'manual' });
  const location = response.headers.get('location');
  if (!location) {
    throw new Error(`Expected a 302 from /login, got ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  console.log('\nOpen this and approve:\n');
  console.log(`  ${location}\n`);

  if (args.open === 'true') {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [location], { detached: true, stdio: 'ignore' }).unref();
  }

  // authorized_at_ms is reset only by a completed /callback, so a change in it
  // is proof the round trip finished rather than merely that a token exists.
  const deadline = Date.now() + args.waitSeconds * 1000;
  process.stdout.write('Waiting for the callback');
  while (Date.now() < deadline) {
    await sleep(3000);
    process.stdout.write('.');
    const now = await health().catch(() => null);
    if (now && now.authorized && now.authorized_at_ms !== before.authorized_at_ms) {
      console.log(`\n\nAuthorized. Refresh token good for ~${now.days_until_token_expiry} days.`);
      return;
    }
  }

  console.log(`\n\nStill not authorized after ${args.waitSeconds}s. The link stays valid for 10 minutes —`);
  console.log('finish it in the browser, then check with:  curl -H "Authorization: Bearer $ADMIN_TOKEN" ' + base + '/health');
  process.exitCode = 1;
}

await main();
