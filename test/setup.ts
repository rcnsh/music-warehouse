import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

/**
 * Every test starts against the real schema with an empty warehouse. The pool
 * shares one D1 instance across a file, so state is reset explicitly rather
 * than relied on to be isolated.
 */
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM plays'),
    env.DB.prepare('DELETE FROM tracks'),
    env.DB.prepare('DELETE FROM artists'),
    env.DB.prepare('DELETE FROM track_artists'),
    env.DB.prepare('DELETE FROM albums'),
    env.DB.prepare('DELETE FROM oauth_state'),
    env.DB.prepare('DELETE FROM alerts'),
    env.DB.prepare('UPDATE oauth_token SET access_token = NULL, access_expires_ms = NULL, refresh_token = NULL, authorized_at_ms = 0, needs_reauth = 0 WHERE id = 1'),
    env.DB.prepare('UPDATE sync_state SET cursor_ms = 0, last_success_ms = NULL, last_error = NULL, last_error_ms = NULL, consecutive_failures = 0 WHERE id = 1'),
  ]);
});
