import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPIRY_WARNING_DAYS,
  RESEND_AFTER_MS,
  STALL_AFTER_MS,
  evaluate,
  pingHeartbeat,
  runAlertCheck,
  runPollCron,
} from '../src/alerts';
import type { Env, OAuthToken, SyncState } from '../src/types';
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('leads the body with ALERT_MENTION so the receiver pings a human', async () => {
    await env.DB.prepare('UPDATE oauth_token SET authorized_at_ms = ?, needs_reauth = 1 WHERE id = 1')
      .bind(Date.now() - 10 * DAY)
      .run();
    const bodies = stubWebhook();

    await runAlertCheck(
      testEnv({ ALERT_WEBHOOK_URL: 'https://hook.test/x', ALERT_MENTION: '<@123>' }),
    );

    const body = bodies[0]!;
    expect(String(body.content).startsWith('<@123> ')).toBe(true);
    // Every key carries the same text, whichever one the receiver reads.
    expect(body.text).toBe(body.content);
    expect(body.message).toBe(body.content);
    // The title field stays clean, for receivers that render it separately.
    expect(String(body.title)).not.toContain('<@123>');
  });

  it('omits the prefix entirely when no mention is configured', async () => {
    await env.DB.prepare('UPDATE oauth_token SET authorized_at_ms = ?, needs_reauth = 1 WHERE id = 1')
      .bind(Date.now() - 10 * DAY)
      .run();
    const bodies = stubWebhook();

    await runAlertCheck(testEnv({ ALERT_WEBHOOK_URL: 'https://hook.test/x', ALERT_MENTION: undefined }));

    expect(String(bodies[0]!.content).startsWith('🔴')).toBe(true);
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

describe('runPollCron', () => {
  /**
   * Route the cron's outbound calls: Spotify's recently-played, the heartbeat
   * and the alert webhook. Anything else (context lookups) is a 404.
   */
  function stubCron(options: { spotify?: () => Response; heartbeat?: () => Response } = {}) {
    const calls = { heartbeat: [] as string[], webhook: [] as Array<Record<string, unknown>> };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith('/me/player/recently-played')) {
          return (options.spotify ?? (() => new Response(JSON.stringify({ items: [] }))))();
        }
        if (url.host === 'heartbeat.test') {
          calls.heartbeat.push(init?.method ?? 'GET');
          return (options.heartbeat ?? (() => new Response('OK')))();
        }
        if (url.host === 'hook.test') {
          calls.webhook.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response('ok');
        }
        return new Response('{}', { status: 404 });
      }),
    );
    return calls;
  }

  const cronEnv = (overrides: Partial<Env> = {}) =>
    testEnv({ ALERT_WEBHOOK_URL: 'https://hook.test/x', HEARTBEAT_URL: 'https://heartbeat.test/ping', ...overrides });
  const down = () => new Response('down', { status: 503 });

  /** Authorized, with the last successful poll just past the stall line. */
  async function seedStalled(now: number) {
    await seedAuthorized({ authorizedAtMs: now - 10 * DAY });
    await env.DB.prepare('UPDATE sync_state SET last_success_ms = ? WHERE id = 1')
      .bind(now - STALL_AFTER_MS - 60_000)
      .run();
  }

  it('pings the heartbeat with a GET after a successful poll, and alerts on nothing', async () => {
    await seedHealthy();
    const calls = stubCron();

    const result = await runPollCron(cronEnv());

    expect(result.poll.ok).toBe(true);
    expect(result.heartbeat).toBe(true);
    expect(calls.heartbeat).toEqual(['GET']);
    expect(result.alerts?.firing).toEqual([]);
    expect(calls.webhook).toHaveLength(0);
  });

  it('sends no heartbeat when the poll fails, so the outside monitor notices', async () => {
    await seedHealthy();
    const calls = stubCron({ spotify: down });

    const result = await runPollCron(cronEnv());

    expect(result.poll.ok).toBe(false);
    expect(result.heartbeat).toBeNull();
    expect(calls.heartbeat).toEqual([]);
  });

  it('sends no heartbeat when HEARTBEAT_URL is unset', async () => {
    await seedHealthy();
    const calls = stubCron();

    const result = await runPollCron(cronEnv({ HEARTBEAT_URL: undefined }));

    expect(result.poll.ok).toBe(true);
    expect(result.heartbeat).toBeNull();
    expect(calls.heartbeat).toEqual([]);
  });

  it('logs a failed heartbeat rather than failing the poll', async () => {
    await seedHealthy();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubCron({
      heartbeat: () => {
        throw new TypeError('network down');
      },
    });

    const result = await runPollCron(cronEnv());

    expect(result.poll.ok).toBe(true);
    expect(result.heartbeat).toBe(false);
    expect(result.alerts).not.toBeNull();
  });

  it('counts a non-2xx heartbeat response as a failed ping', async () => {
    stubCron({ heartbeat: () => new Response('nope', { status: 500 }) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await pingHeartbeat('https://heartbeat.test/ping')).toBe(false);
  });

  it('pushes a stall from the poll cron, once per resend window', async () => {
    const start = Date.now();
    await seedStalled(start);
    const calls = stubCron({ spotify: down });
    const cron = cronEnv();

    expect((await runPollCron(cron, start)).alerts?.sent).toEqual(['ingestion_stalled']);

    // The next tick, half an hour on and still failing, stays quiet.
    const second = await runPollCron(cron, start + 30 * 60_000);
    expect(second.alerts?.suppressed).toEqual(['ingestion_stalled']);
    expect(calls.webhook.map((body) => body.key)).toEqual(['ingestion_stalled']);
  });

  it('clears the stall as soon as a poll succeeds again', async () => {
    const start = Date.now();
    await seedStalled(start);
    stubCron({ spotify: down });
    await runPollCron(cronEnv(), start);

    vi.unstubAllGlobals();
    stubCron();
    const recovered = await runPollCron(cronEnv(), start + 30 * 60_000);
    expect(recovered.poll.ok).toBe(true);
    expect(recovered.alerts?.cleared).toEqual(['ingestion_stalled']);
  });
});
