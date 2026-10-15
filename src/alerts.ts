import { json } from './api';
import { readState } from './db';
import { type PollResult, poll } from './ingest';
import { daysUntilTokenExpiry } from './tokens';
import type { Env, OAuthToken, SyncState } from './types';
import { log } from './log';

/**
 * Unattended monitoring.
 *
 * /health reports everything needed to spot a dead collector, but only if
 * something reads it. This is that something: the half-hourly poll cron
 * evaluates the same state after each poll and pushes to a webhook when it
 * needs a human, so a stall is reported within one tick of crossing
 * STALL_AFTER_MS.
 *
 * None of that runs when the Worker or its crons are down, so a successful
 * poll also pings HEARTBEAT_URL: an outside dead-man's switch
 * (healthchecks.io and the like) alerts when the pings stop.
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
      log('alert-no-webhook', { key: alert.key, title: alert.title }, 'warn');
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

/** How long a heartbeat ping may take before it is abandoned. */
const HEARTBEAT_TIMEOUT_MS = 5_000;

/**
 * GET the dead-man's switch. Never throws: a monitor that is down must not
 * fail the poll it reports on, and a missed ping is exactly what the monitor
 * is there to notice. Returns whether the ping was accepted, for the log.
 */
export async function pingHeartbeat(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    if (!response.ok) {
      log('heartbeat-ping-rejected', { status: response.status }, 'warn');
      return false;
    }
    return true;
  } catch (error) {
    log('heartbeat-ping-failed', { error }, 'warn');
    return false;
  }
}

export interface PollCronResult {
  poll: PollResult;
  /** Whether HEARTBEAT_URL accepted the ping; null when none was sent. */
  heartbeat: boolean | null;
  /** Null when the alert check itself failed (logged). */
  alerts: AlertRunResult | null;
}

/**
 * What the half-hourly cron does: poll, ping the heartbeat if the poll
 * succeeded, then run the alert check against the state the poll just left.
 *
 * The check runs every tick, and its resend window keeps each condition to
 * one push a day. It reads two one-row tables and the small alerts table, so
 * 48 runs a day cost next to nothing.
 */
export async function runPollCron(env: Env, now: number = Date.now()): Promise<PollCronResult> {
  const result = await poll(env, now);
  const heartbeat = result.ok && env.HEARTBEAT_URL ? await pingHeartbeat(env.HEARTBEAT_URL) : null;
  let alerts: AlertRunResult | null = null;
  try {
    alerts = await runAlertCheck(env, now);
  } catch (error) {
    log('alert-check-failed', { error }, 'error');
  }
  return { poll: result, heartbeat, alerts };
}
