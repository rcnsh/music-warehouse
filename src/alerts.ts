import { json } from './api';
import { readState } from './db';
import { daysUntilTokenExpiry } from './tokens';
import type { Env, OAuthToken, SyncState } from './types';

/**
 * Unattended monitoring.
 *
 * /health reports everything needed to spot a dead collector, but only if
 * something reads it. This is that something: a daily cron evaluates the same
 * state and pushes to a webhook when it needs a human.
 *
 * Every condition here needs manual intervention. Nothing transient is alerted
 * on — a single failed poll costs nothing, because the cursor never advanced.
 */

/** Warn this far ahead of the six-month refresh-token expiry. */
export const EXPIRY_WARNING_DAYS = 14;

/**
 * How long ingestion may go without a successful poll before it counts as
 * stalled. The cadence is 30 minutes, so this is six consecutive misses —
 * comfortably past a transient Spotify or D1 outage.
 */
export const STALL_AFTER_MS = 3 * 60 * 60 * 1000;

/** A firing condition is re-sent at most this often while it persists. */
export const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;

export type AlertSeverity = 'critical' | 'warning';

export interface Alert {
  key: string;
  severity: AlertSeverity;
  title: string;
  message: string;
}

/**
 * Pure: decide which conditions are firing right now.
 *
 * Ordered most-urgent first, and deliberately exclusive — a connection that
 * needs re-authorization is also stalled, but saying so twice helps nobody.
 */
export function evaluate(
  token: OAuthToken,
  sync: SyncState,
  now: number,
): Alert[] {
  const alerts: Alert[] = [];

  if (!token.authorized_at_ms) {
    return [
      {
        key: 'not_authorized',
        severity: 'critical',
        title: 'music-warehouse is not authorized',
        message: 'No Spotify grant has ever been stored. Nothing is being recorded. Visit /login.',
      },
    ];
  }

  if (token.needs_reauth) {
    return [
      {
        key: 'needs_reauth',
        severity: 'critical',
        title: 'music-warehouse needs re-authorization',
        message:
          'The Spotify refresh token was rejected — most likely its six-month expiry. ' +
          'Ingestion has stopped and plays are ageing out of the 50-item window. Visit /login.',
      },
    ];
  }

  const daysLeft = daysUntilTokenExpiry(token.authorized_at_ms, now);
  if (daysLeft !== null && daysLeft <= EXPIRY_WARNING_DAYS) {
    alerts.push({
      key: 'token_expiring',
      severity: 'warning',
      title: `music-warehouse token expires in ${daysLeft} days`,
      message:
        `The Spotify refresh token expires in ${daysLeft} days and refreshing does not extend it. ` +
        'Re-authorize at /login before then; it takes about thirty seconds.',
    });
  }

  // A collector that has silently stopped is the expensive failure: plays age
  // out of Spotify's 50-item window and are gone for good.
  const sinceSuccess = sync.last_success_ms === null ? null : now - sync.last_success_ms;
  if (sinceSuccess === null || sinceSuccess > STALL_AFTER_MS) {
    const hours = sinceSuccess === null ? null : Math.floor(sinceSuccess / (60 * 60 * 1000));
    alerts.push({
      key: 'ingestion_stalled',
      severity: 'critical',
      title: 'music-warehouse ingestion has stalled',
      message:
        (hours === null
          ? 'No poll has ever succeeded.'
          : `No successful poll for ${hours} hours (${sync.consecutive_failures} consecutive failures).`) +
        ` Last error: ${sync.last_error ?? 'none recorded'}`,
    });
  }

  return alerts;
}

/**
 * POST one alert to the configured webhook.
 *
 * The body carries the same text under several keys so one URL works with
 * Discord (`content`), Slack (`text`) and generic receivers (`message`),
 * alongside structured fields for anything that parses JSON.
 *
 * ALERT_MENTION, when set, leads the text. Discord parses mentions in `content`
 * by default, so a `<@id>` there pings without any allowed_mentions field.
 */
async function send(webhookUrl: string, alert: Alert, mention?: string): Promise<void> {
  const prefix = mention ? `${mention} ` : '';
  const text = `${prefix}${alert.severity === 'critical' ? '🔴' : '🟠'} ${alert.title}\n${alert.message}`;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: text,
      text,
      message: text,
      title: alert.title,
      severity: alert.severity,
      key: alert.key,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}`);
  }
}

export interface AlertRunResult {
  webhook_configured: boolean;
  firing: string[];
  sent: string[];
  suppressed: string[];
  failed: Array<{ key: string; error: string }>;
  cleared: string[];
}

/**
 * Evaluate, then send anything not already sent inside the resend window.
 *
 * Rows for conditions that have cleared are deleted, so if one recurs it
 * alerts straight away instead of waiting out a stale timer.
 */
export async function runAlertCheck(
  env: Env,
  now: number = Date.now(),
  options: { force?: boolean } = {},
): Promise<AlertRunResult> {
  const { token, sync } = await readState(env.DB);
  const firing = evaluate(token, sync, now);
  const firingKeys = new Set(firing.map((alert) => alert.key));

  const previous = await env.DB.prepare('SELECT key, last_sent_ms FROM alerts').all<{
    key: string;
    last_sent_ms: number;
  }>();
  const lastSent = new Map((previous.results ?? []).map((row) => [row.key, row.last_sent_ms]));

  const result: AlertRunResult = {
    webhook_configured: Boolean(env.ALERT_WEBHOOK_URL),
    firing: [...firingKeys],
    sent: [],
    suppressed: [],
    failed: [],
    cleared: [],
  };

  const writes: D1PreparedStatement[] = [];

  for (const [key] of lastSent) {
    if (!firingKeys.has(key)) {
      writes.push(env.DB.prepare('DELETE FROM alerts WHERE key = ?').bind(key));
      result.cleared.push(key);
    }
  }

  for (const alert of firing) {
    const sentAt = lastSent.get(alert.key);
    if (!options.force && sentAt !== undefined && now - sentAt < RESEND_AFTER_MS) {
      result.suppressed.push(alert.key);
      continue;
    }

    if (!env.ALERT_WEBHOOK_URL) {
      // Nothing to send to. Still worth the log line, and no row is written so
      // configuring a webhook later delivers immediately.
      console.warn('alert firing with no ALERT_WEBHOOK_URL set', alert.key, alert.title);
      result.failed.push({ key: alert.key, error: 'ALERT_WEBHOOK_URL is not set' });
      continue;
    }

    try {
      await send(env.ALERT_WEBHOOK_URL, alert, env.ALERT_MENTION);
      result.sent.push(alert.key);
      writes.push(
        env.DB
          .prepare(
            'INSERT INTO alerts (key, last_sent_ms) VALUES (?, ?) ' +
              'ON CONFLICT(key) DO UPDATE SET last_sent_ms = excluded.last_sent_ms',
          )
          .bind(alert.key, now),
      );
    } catch (error) {
      // A failed delivery writes no row, so the next run tries again.
      result.failed.push({ key: alert.key, error: (error as Error).message });
    }
  }

  if (writes.length > 0) await env.DB.batch(writes);
  return result;
}

export async function alertCheckRoute(env: Env, url: URL): Promise<Response> {
  const force = url.searchParams.get('force') === '1';
  return json(await runAlertCheck(env, Date.now(), { force }));
}
