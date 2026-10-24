import { readFileSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';

// Migrations and fixtures are read here, on the Node side, and handed to the
// test Worker as bindings — tests run inside workerd and have no filesystem.
// @cloudflare/vitest-plugin keeps the comment lines above a statement as part
// of it; strip them so tests can pick statements out by their first keyword.
const migrations = (await readD1Migrations('./migrations')).map((m) => ({
  ...m,
  queries: m.queries.map((sql) => sql.replace(/^(?:\s*--[^\n]*\n)+/, '')),
}));

// Prefer the real Phase 1 capture; fall back to the synthetic sample so the
// suite runs before anyone has authorized against Spotify.
function loadFixture(): Record<string, unknown> {
  for (const path of ['fixtures/recently-played.json', 'fixtures/recently-played.sample.json']) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('No recently-played fixture found.');
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The "test" environment makes Wrangler load .dev.vars.test (dummy
      // values, committed) in place of .dev.vars, so real secrets stay out of
      // tests and CI needs no .dev.vars.
      wrangler: { configPath: './wrangler.jsonc', environment: 'test' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_FIXTURE: loadFixture() as never,
          SPOTIFY_CLIENT_ID: 'test-client-id',
          SPOTIFY_CLIENT_SECRET: 'test-client-secret',
          SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:8787/callback',
          ADMIN_TOKEN: 'test-admin-token',
          READ_TOKEN: 'test-read-token',
          CONTROL_TOKEN: 'test-control-token',
          // Synthetic eras and regions: a deployment's own live in its secrets.
          // Two zones with different rules, one with summer time, so local-time
          // SQL is exercised across a change of era and a change of offset.
          ERAS: JSON.stringify([
            { key: 'home', label: 'Home', timeZone: 'Europe/London', from: '2020-07-01T00:00:00+01:00' },
            { key: 'abroad', label: 'Abroad', timeZone: 'Asia/Singapore', from: '2025-03-10T00:00:00Z' },
          ]),
          HISTORY_FROM: '2020-07-01T00:00:00+01:00',
          CONCERT_REGIONS: JSON.stringify([
            { key: 'singapore', label: 'Singapore', countryCode: 'SG' },
            { key: 'london', label: 'London', geoPoint: 'gcpvj', radius: 50 },
          ]),
          CORS_ORIGINS: 'https://wrapped.test, https://other.test/',
          TICKETMASTER_API_KEY: 'test-tm-key',
          SIGN_IN_SCHEMES: 'app.test',
          // Set TEST_NOW (any Date.parse-able instant) to run the whole suite
          // with the clock frozen there, to check no test depends on when it runs.
          TEST_NOW: process.env.TEST_NOW ?? '',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    // Agent worktrees under .claude/ hold whole copies of the repo; without
    // this their tests run too, doubling the suite.
    exclude: [...configDefaults.exclude, '.claude/**', 'node_modules/**'],
  },
});
