import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, vi } from 'vitest';
import { freezeClock } from './helpers';
import { edgeRequest } from '../src/snapshots';
import { buildEras, parseEras } from '../src/eras';
import { STAT_NAMES, statKey } from '../src/stats';

// The test settings give the first era a start, so these are the eras every route loads.
const ERAS = buildEras(parseEras(env.ERAS, env.TIMEZONE), 0);

/**
 * Every test starts against the real schema with an empty warehouse. The pool
 * shares one D1 instance across a file, so state is reset explicitly rather
 * than relied on to be isolated.
 */
beforeEach(async () => {
  if (env.TEST_NOW) freezeClock(env.TEST_NOW);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // The stats routes keep bodies in the Cache API as well as D1; a body cached
  // by one test would otherwise answer the next.
  const edge = await caches.open('stats');
  await Promise.all(STAT_NAMES.map((name) => edge.delete(edgeRequest(statKey(name, ERAS)))));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM plays'),
    env.DB.prepare('DELETE FROM tracks'),
    env.DB.prepare('DELETE FROM artists'),
    env.DB.prepare('DELETE FROM track_artists'),
    env.DB.prepare('DELETE FROM albums'),
    env.DB.prepare('DELETE FROM oauth_state'),
    env.DB.prepare('DELETE FROM alerts'),
    env.DB.prepare('DELETE FROM stats_snapshots'),
    env.DB.prepare('DELETE FROM api_tokens'),
    env.DB.prepare('DELETE FROM login_state'),
    env.DB.prepare('DELETE FROM login_codes'),
    env.DB.prepare('DELETE FROM concerts'),
    env.DB.prepare('DELETE FROM concert_artists'),
    env.DB.prepare('DELETE FROM concert_runs'),
    env.DB.prepare('DELETE FROM track_search_text'),
    env.DB.prepare('DELETE FROM track_songs'),
    env.DB.prepare('DELETE FROM play_numbers'),
    env.DB.prepare('DELETE FROM contexts'),
    // The plays' delete trigger has emptied the rollup; put back the
    // migration's UTC state, which a test may have rebuilt for another zone.
    env.DB.prepare('DELETE FROM rollup_days'),
    env.DB.prepare('DELETE FROM rollup_month_tracks'),
    env.DB.prepare('DELETE FROM rollup_offsets'),
    env.DB.prepare('INSERT INTO rollup_offsets (from_ms, offset_ms) VALUES (-8640000000000000, 0)'),
    env.DB.prepare("UPDATE rollup_state SET time_zone = 'UTC', usable = 1, horizon_ms = 8640000000000000 WHERE id = 1"),
    // Search matches are cached under the newest index row id. Without this
    // row ids restart at 1 in every test, and one test's cached matches
    // would answer the next's. Its empty text never matches anything.
    env.DB.prepare("INSERT INTO track_search_text (id, track_id, text) VALUES (?, '', '')").bind(
      Math.floor(Math.random() * 2 ** 40) + 1,
    ),
    env.DB.prepare('UPDATE oauth_token SET access_token = NULL, access_expires_ms = NULL, refresh_token = NULL, authorized_at_ms = 0, needs_reauth = 0, spotify_user_id = NULL WHERE id = 1'),
    env.DB.prepare('UPDATE sync_state SET cursor_ms = 0, last_success_ms = NULL, last_error = NULL, last_error_ms = NULL, consecutive_failures = 0 WHERE id = 1'),
    env.DB.prepare('UPDATE concert_check_state SET last_run_ms = NULL, last_success_ms = NULL, last_error = NULL, last_error_ms = NULL, consecutive_failures = 0 WHERE id = 1'),
  ]);
});

// A test that froze the clock (freezeClock, or TEST_NOW above) gets it back.
afterEach(() => {
  vi.useRealTimers();
});
