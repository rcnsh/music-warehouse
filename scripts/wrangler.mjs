#!/usr/bin/env node
/**
 * Run Wrangler against this deployment's own config.
 *
 * wrangler.jsonc is a template with placeholders, so the repository stays free
 * of anyone's database id and hostname. The real values live in
 * wrangler.local.jsonc, which is gitignored; when it exists, every command run
 * through here gets `-c wrangler.local.jsonc`. Without it, Wrangler reads the
 * template, which is fine for `wrangler dev` and the tests and nothing else.
 *
 *   node scripts/wrangler.mjs deploy
 *   node scripts/wrangler.mjs d1 migrations apply music_warehouse --remote
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(root, 'wrangler.local.jsonc');
const args = process.argv.slice(2);
const explicit = args.some((arg) => arg === '-c' || arg === '--config' || arg.startsWith('--config='));

if (!explicit && existsSync(local)) {
  args.push('-c', local);
} else if (!explicit && (args[0] === 'deploy' || args.includes('--remote'))) {
  // The template's placeholders would only fail further in, less clearly.
  console.error('No wrangler.local.jsonc. Copy wrangler.jsonc to it and fill in your own values (see docs/setup.md).');
  process.exit(1);
} else if (!explicit) {
  console.error('scripts/wrangler.mjs: no wrangler.local.jsonc, so using the wrangler.jsonc template.');
}

const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const result = spawnSync(bin, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
