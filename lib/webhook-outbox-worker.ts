/**
 * Webhook outbox worker.
 *
 * Provides three exports:
 *  - attemptDelivery()        Shared fetch helper with HMAC signing and 30s timeout.
 *  - enqueueFailedDelivery()  Write a pending row to webhook_outbox after a failed inline attempt.
 *  - runWebhookOutboxTick()   Poll due rows and retry; call at the end of each cron tick.
 */

import { dbRun, dbQuery, dbGet } from '@/lib/sqlite'
import crypto from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebhookTarget {
  url: string
  secret: string | null
  headers: Record<string, string> | null
}

export interface DeliveryResult {
  ok: boolean
  status: number | null   // null on network error / timeout
  error: string | null    // null on success
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5   // total attempts: 1 inline + 4 retries

// ─── Core fetch helper ────────────────────────────────────────────────────────

export async function attemptDelivery(
  target: WebhookTarget,
  payloadJson: string,
): Promise<DeliveryResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'ULPSuite-DomainMonitor/1.0',
    ...(target.headers || {}),
  }
  if (target.secret) {
    headers['X-Webhook-Signature'] = `sha256=${crypto
      .createHmac('sha256', target.secret)
      .update(payloadJson)
      .digest('hex')}`
  }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(target.url, { method: 'POST', headers, body: payloadJson, signal: ctrl.signal })
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(t)
  }
}

// ─── Enqueue failed first attempt ─────────────────────────────────────────────

export function enqueueFailedDelivery(
  monitorId: number,
  webhookId: number,
  payloadJson: string,
  sourceFile: string,
  matchedDomain: string,
  credCount: number,
): void {
  dbRun(
    `INSERT INTO webhook_outbox
       (monitor_id, webhook_id, payload, source_file, matched_domain, cred_count,
        status, attempt_count, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now', '+1 minute'))`,
    [monitorId, webhookId, payloadJson, sourceFile, matchedDomain, credCount, 1],
  )
}

// ─── Outbox worker ────────────────────────────────────────────────────────────

interface OutboxRow {
  id: number
  monitor_id: number
  webhook_id: number
  payload: string
  source_file: string
  matched_domain: string
  cred_count: number
  attempt_count: number
}

function deadLetter(row: OutboxRow, result: DeliveryResult): void {
  dbRun(
    `UPDATE webhook_outbox
     SET status='dead_letter', last_error=?, updated_at=datetime('now')
     WHERE id=?`,
    [result.error, row.id],
  )
  dbRun(
    `INSERT INTO monitor_alerts
       (monitor_id, webhook_id, source_file, matched_domain, match_type,
        credential_match_count, payload_sent, status, http_status, error_message, retry_count)
     VALUES (?, ?, ?, ?, 'credential_email', ?, ?, 'failed', ?, ?, ?)`,
    [row.monitor_id, row.webhook_id, row.source_file, row.matched_domain,
     row.cred_count, row.payload, result.status, result.error, row.attempt_count],
  )
}

export async function runWebhookOutboxTick(): Promise<void> {
  const dueRows = dbQuery(
    `SELECT id, monitor_id, webhook_id, payload, source_file, matched_domain, cred_count, attempt_count
     FROM webhook_outbox
     WHERE status IN ('pending', 'retrying')
       AND next_attempt_at <= datetime('now')
     ORDER BY next_attempt_at ASC
     LIMIT 50`,
    [],
  ) as OutboxRow[]

  for (const row of dueRows) {
    // Look up active webhook
    const whRow = dbGet(
      `SELECT url, secret, headers FROM monitor_webhooks WHERE id = ? AND is_active = 1`,
      [row.webhook_id],
    ) as { url: string; secret: string | null; headers: string | null } | undefined

    if (!whRow) {
      dbRun(
        `UPDATE webhook_outbox
         SET status='dead_letter', last_error='webhook not found or inactive', updated_at=datetime('now')
         WHERE id=?`,
        [row.id],
      )
      dbRun(
        `INSERT INTO monitor_alerts
           (monitor_id, webhook_id, source_file, matched_domain, match_type,
            credential_match_count, payload_sent, status, error_message, retry_count)
         VALUES (?, ?, ?, ?, 'credential_email', ?, ?, 'failed', ?, ?)`,
        [row.monitor_id, row.webhook_id, row.source_file, row.matched_domain,
         row.cred_count, row.payload, 'webhook not found or inactive', row.attempt_count],
      )
      continue
    }

    let parsedHeaders: Record<string, string> | null = null
    try { parsedHeaders = whRow.headers ? JSON.parse(whRow.headers) : null } catch {}

    const result = await attemptDelivery(
      { url: whRow.url, secret: whRow.secret, headers: parsedHeaders },
      row.payload,
    )

    const newAttemptCount = row.attempt_count + 1

    if (result.ok) {
      dbRun(
        `UPDATE webhook_outbox SET status='delivered', updated_at=datetime('now') WHERE id=?`,
        [row.id],
      )
      dbRun(
        `INSERT INTO monitor_alerts
           (monitor_id, webhook_id, source_file, matched_domain, match_type,
            credential_match_count, payload_sent, status, http_status, retry_count)
         VALUES (?, ?, ?, ?, 'credential_email', ?, ?, 'success', ?, ?)`,
        [row.monitor_id, row.webhook_id, row.source_file, row.matched_domain,
         row.cred_count, row.payload, result.status, row.attempt_count],
      )
      dbRun(`UPDATE monitor_webhooks SET last_triggered_at = datetime('now') WHERE id = ?`, [row.webhook_id])

    } else if (result.status !== null && result.status >= 400 && result.status < 500) {
      // 4xx — dead-letter immediately, no retry
      deadLetter(row, result)

    } else if (newAttemptCount >= MAX_ATTEMPTS) {
      // Reached max attempts — dead-letter
      deadLetter(row, result)

    } else {
      // Retry with exponential backoff: 2^(newAttemptCount-1) minutes
      const backoffMinutes = Math.pow(2, newAttemptCount - 1)
      dbRun(
        `UPDATE webhook_outbox
         SET status='retrying', attempt_count=?, next_attempt_at=datetime('now', ?), last_error=?, updated_at=datetime('now')
         WHERE id=?`,
        [newAttemptCount, `+${backoffMinutes} minute`, result.error, row.id],
      )
      dbRun(
        `INSERT INTO monitor_alerts
           (monitor_id, webhook_id, source_file, matched_domain, match_type,
            credential_match_count, payload_sent, status, http_status, error_message, retry_count)
         VALUES (?, ?, ?, ?, 'credential_email', ?, ?, 'failed', ?, ?, ?)`,
        [row.monitor_id, row.webhook_id, row.source_file, row.matched_domain,
         row.cred_count, row.payload, result.status, result.error, row.attempt_count],
      )
    }
  }
}
