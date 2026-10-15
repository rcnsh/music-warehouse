import { readFileSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Migrations and fixtures are read here, on the Node side, and handed to the
// test Worker as bindings — tests run inside workerd and have no filesystem.
const migrations = await readD1Migrations('./migrations');

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
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_FIXTURE: loadFixture() as never,
          SPOTIFY_CLIENT_ID: 'test-client-id',
          SPOTIFY_CLIENT_SECRET: 'test-client-secret',
          SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:8787/callback',
          ADMIN_TOKEN: 'test-admin-token',
          READ_TOKEN: 'test-read-token',
          // Synthetic eras and regions: a deployment's own live in its secrets.
          // Two zones with different rules, one with summer time, so local-time
          // SQL is exercised across a change of era and a change of offset.
          ERAS: JSON.stringify([
            { key: 'home', label: 'Home', timeZone: 'Europe/London', from: '2020-07-01T00:00:00+01:00' },
            { key: 'abroad', label: 'Abroad', timeZone: 'Asia/Singapore', from: '2025-03-10T00:00:00Z' },
          ]),
          CONCERT_REGIONS: JSON.stringify([
            { key: 'singapore', label: 'Singapore', countryCode: 'SG' },
            { key: 'london', label: 'London', geoPoint: 'gcpvj', radius: 50 },
          ]),
          CORS_ORIGINS: 'https://wrapped.test, https://other.test/',
          TICKETMASTER_API_KEY: 'test-tm-key',
          SIGN_IN_SCHEMES: 'app.test',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
