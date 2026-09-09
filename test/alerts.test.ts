import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPIRY_WARNING_DAYS,
  RESEND_AFTER_MS,
  STALL_AFTER_MS,
  evaluate,
  runAlertCheck,
} from '../src/alerts';
import type { OAuthToken, SyncState } from '../src/types';
import { seedAuthorized, testEnv } from './helpers';

const NOW = Date.parse('2026-09-09T09:00:00Z');
const DAY = 86_400_000;

function token(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    access_token: 'live',
    access_expires_ms: NOW + 3600_000,
    refresh_token: 'refresh',
    authorized_at_ms: NOW - 10 * DAY,
    needs_reauth: 0,
    ...overrides,
  };
}

function sync(overrides: Partial<SyncState> = {}): SyncState {
  return {
    cursor_ms: NOW - 60_000,
    last_success_ms: NOW - 60_000,
    last_error: null,
    last_error_ms: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

/** Capture webhook deliveries without leaving the test. */
function stubWebhook(response: () => Response = () => new Response('ok')) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response();
    }),
  );
  return bodies;
}

/** Authorized, and polling successfully — the state where nothing should fire. */
async function seedHealthy(options: { authorizedAtMs?: number } = {}) {
  await seedAuthorized(options);
  await env.DB.prepare(
    'UPDATE sync_state SET last_success_ms = ?, last_error = NULL, consecutive_failures = 0 WHERE id = 1',
  )
    .bind(Date.now())
    .run();
}

afterEach(() => vi.unstubAllGlobals());

describe('evaluate', () => {
  it('stays quiet when everything is healthy', () => {
    expect(evaluate(token(), sync(), NOW)).toEqual([]);
  });

  it('reports a never-authorized warehouse, and nothing else', () => {
    const alerts = evaluate(token({ authorized_at_ms: 0 }), sync({ last_success_ms: null }), NOW);
    expect(alerts.map((a) => a.key)).toEqual(['not_authorized']);
  });

  it('reports needs_reauth alone, without also crying "stalled"', () => {
    const alerts = evaluate(
      token({ needs_reauth: 1 }),
      sync({ last_success_ms: NOW - 5 * DAY }),
      NOW,
    );
    expect(alerts.map((a) => a.key)).toEqual(['needs_reauth']);
    expect(alerts[0]!.severity).toBe('critical');
  });

  it('warns inside the expiry window but not outside it', () => {
    const inside = token({ authorized_at_ms: NOW - (183 - EXPIRY_WARNING_DAYS) * DAY });
    expect(evaluate(inside, sync(), NOW).map((a) => a.key)).toContain('token_expiring');

    const outside = token({ authorized_at_ms: NOW - (183 - EXPIRY_WARNING_DAYS - 2) * DAY });
    expect(evaluate(outside, sync(), NOW).map((a) => a.key)).not.toContain('token_expiring');
  });

  it('flags a stalled collector once past the threshold', () => {
    const justInside = sync({ last_success_ms: NOW - (STALL_AFTER_MS - 60_000) });
    expect(evaluate(token(), justInside, NOW)).toEqual([]);

    const stalled = sync({
      last_success_ms: NOW - (STALL_AFTER_MS + 60_000),
      consecutive_failures: 7,
      last_error: 'rate_limited: Rate limited',
    });
    const alerts = evaluate(token(), stalled, NOW);
    expect(alerts.map((a) => a.key)).toEqual(['ingestion_stalled']);
    expect(alerts[0]!.message).toContain('rate_limited');
  });

  it('can fire the expiry warning and the stall together', () => {
    const alerts = evaluate(
      token({ authorized_at_ms: NOW - 180 * DAY }),
      sync({ last_success_ms: NOW - 2 * DAY }),
      NOW,
    );
    expect(alerts.map((a) => a.key)).toEqual(['token_expiring', 'ingestion_stalled']);
  });
});

describe('runAlertCheck', () => {
  it('sends nothing when healthy', async () => {
    await seedHealthy();
    const bodies = stubWebhook();

    const result = await runAlertCheck(testEnv({ ALERT_WEBHOOK_URL: 'https://hook.test/x' }), Date.now());
    expect(result.firing).toEqual([]);
    expect(bodies).toHaveLength(0);
  });

  it('posts a payload Discord, Slack and generic receivers all understand', async () => {
    await env.DB.prepare('UPDATE oauth_token SET authorized_at_ms = ?, needs_reauth = 1 WHERE id = 1')
      .bind(Date.now() - 10 * DAY)
      .run();
    const bodies = stubWebhook();

    const result = await runAlertCheck(testEnv({ ALERT_WEBHOOK_URL: 'https://hook.test/x' }));

    expect(result.sent).toEqual(['needs_reauth']);
    const body = bodies[0]!;
    expect(body.content).toContain('needs re-authorization');
    expect(body.text).toBe(body.content);
    expect(body.message).toBe(body.content);
    expect(body.severity).toBe('critical');
  });

  it('suppresses a repeat inside the resend window, then sends again after it', async () => {
    await env.DB.prepare('UPDATE oauth_token SET authorized_at_ms = ?, needs_reauth = 1 WHERE id = 1')
      .bind(Date.now() - 10 * DAY)
      .run();
    const bodies = stubWebhook();
    const alertEnv = testEnv({ ALERT_WEBHOOK_URL: 'https://hook.test/x' });
    const start = Date.now();

    expect((await runAlertCheck(alertEnv, start)).sent).toEqual(['needs_reauth']);
    expect((await runAlertCheck(alertEnv, start + 60_000)).suppressed).toEqual(['needs_reauth']);
    expect((await runAlertCheck(alertEnv, start + RESEND_AFTER_MS + 1000)).sent).toEqual(['needs_reauth']);
    expect(bodies).toHaveLength(2);
  });

  it('clears the record when a condition resolves, so a recurrence alerts at once', async () => {
    const authorizedAt = Date.now() - 10 * DAY;
    await seedHealthy({ authorizedAtMs: authorizedAt });
    await env.DB.prepare('UPDATE oauth_token SET needs_reauth = 1 WHERE id = 1').run();
    const bodies = stubWebhook();
    const alertEnv = testEnv({ ALERT_WEBHOOK_URL: 'https://hook.test/x' });

    await runAlertCheck(alertEnv);

    // Re-authorized: the condition clears.
    await seedHealthy({ authorizedAtMs: authorizedAt });
    const cleared = await runAlertCheck(alertEnv);
    expect(cleared.cleared).toContain('needs_reauth');

    // It breaks again immediately — no waiting out the 24h window.
    await env.DB.prepare('UPDATE oauth_token SET needs_reauth = 1 WHERE id = 1').run();
    expect((await runAlertCheck(alertEnv)).sent).toEqual(['needs_reauth']);
    expect(bodies).toHaveLength(2);
  });

  it('writes no record when delivery fails, so the next run retries', async () => {
    await env.DB.prepare('UPDATE oauth_token SET authorized_at_ms = ?, needs_reauth = 1 WHERE id = 1')
      .bind(Date.now() - 10 * DAY)
      .run();
    stubWebhook(() => new Response('nope', { status: 500 }));
    const alertEnv = testEnv({ ALERT_WEBHOOK_URL: 'https://hook.test/x' });

    const first = await runAlertCheck(alertEnv);
    expect(first.sent).toEqual([]);
    expect(first.failed[0]!.key).toBe('needs_reauth');

    vi.unstubAllGlobals();
    const bodies = stubWebhook();
    expect((await runAlertCheck(alertEnv)).sent).toEqual(['needs_reauth']);
    expect(bodies).toHaveLength(1);
  });

  it('reports the missing webhook rather than failing silently', async () => {
    await env.DB.prepare('UPDATE oauth_token SET authorized_at_ms = ?, needs_reauth = 1 WHERE id = 1')
      .bind(Date.now() - 10 * DAY)
      .run();

    const result = await runAlertCheck(testEnv({ ALERT_WEBHOOK_URL: undefined }));
    expect(result.webhook_configured).toBe(false);
    expect(result.failed[0]!.error).toContain('ALERT_WEBHOOK_URL');
  });
});

describe('POST /admin/alert-check', () => {
  it('is admin-only', async () => {
    const read = await SELF.fetch('https://warehouse.test/admin/alert-check', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-read-token' },
    });
    expect(read.status).toBe(401);
  });

  it('reports what is firing', async () => {
    await seedHealthy();
    const response = await SELF.fetch('https://warehouse.test/admin/alert-check', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ firing: [], sent: [] });
  });
});
