/**
 * Scheduled domain monitor re-scanner.
 *
 * Runs every 15 minutes (setInterval — no external dependency).
 * For each active monitor whose rescan_interval_hours has elapsed since
 * last_triggered_at, re-runs the ClickHouse domain query across ALL source
 * files and fires webhooks according to rescan_mode:
 *   'dedup'  — only new credentials (not already in monitor_credential_seen)
 *   'digest' — all current matches regardless of prior alerts
 *
 * NODE_ENV guard in instrumentation.ts prevents dev hot-reload double-registration.
 */

import { dbQuery, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
import { attemptDelivery, enqueueFailedDelivery, runWebhookOutboxTick } from '@/lib/webhook-outbox-worker'
import crypto from 'crypto'

const TICK_MS = 15 * 60 * 1000  // 15 minutes

let started = false

export function startMonitorRescanCron(): void {
  if (started) return
  started = true
  console.log('[monitor-rescan] cron started — tick every 15 minutes')
  // First tick after 30s (let server warm up)
  setTimeout(() => { runTick().catch(console.error) }, 30_000)
  setInterval(() => { runTick().catch(console.error) }, TICK_MS)
}

// ─── Fingerprinting (mirrors lib/domain-monitor.ts) ─────────────────────────

function credentialFingerprint(email: string, password: string, domain: string): string {
  return crypto.createHash('sha256')
    .update(email).update('\0')
    .update(password).update('\0')
    .update(domain)
    .digest()
    .slice(0, 8)
    .toString('hex')
}

// ─── Tick ────────────────────────────────────────────────────────────────────

interface DueMonitorRow {
  id: number
  name: string
  domains: string
  rescan_mode: 'dedup' | 'digest'
  rescan_interval_hours: number
}

interface WebhookRow {
  id: number
  name: string
  url: string
  secret: string | null
  headers: string | null
  is_active: number
}

interface CredentialRow {
  url: string
  email: string
  password: string
  domain: string
}

async function runTick(): Promise<void> {
  // Query SQLite for active monitors whose rescan interval has elapsed
  const dueMonitors = dbQuery(`
    SELECT id, name, domains, rescan_mode, rescan_interval_hours
    FROM domain_monitors
    WHERE is_active = 1
      AND (
        last_triggered_at IS NULL
        OR (unixepoch('now') - unixepoch(last_triggered_at)) >= rescan_interval_hours * 3600
      )
  `) as DueMonitorRow[]

  if (dueMonitors.length === 0) {
    console.log('[monitor-rescan] tick: due=0 fired=0')
    await runWebhookOutboxTick()
    return
  }

  let fired = 0

  for (const monitorRow of dueMonitors) {
    try {
      let domains: string[] = []
      try { domains = JSON.parse(monitorRow.domains) } catch { domains = [] }
      if (domains.length === 0) continue

      // For digest mode, clear prior seen fingerprints so all matches re-fire
      if (monitorRow.rescan_mode === 'digest') {
        dbRun('DELETE FROM monitor_credential_seen WHERE monitor_id = ?', [monitorRow.id])
      }

      // Query ClickHouse using NORM_DOMAIN_EXPR so Cases A-D corrupted rows match
      const matchedRows: CredentialRow[] = []
      for (const domain of domains) {
        const d = domain.toLowerCase().trim()
        const rows = await executeClickHouseQuery(
          `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
           FROM ulp.credentials
           WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}
              OR endsWith(lower(${NORM_EMAIL_EXPR}), {emailSuffix:String})
           LIMIT 100`,
          { domain: d, emailSuffix: `@${d}` }
        ) as CredentialRow[]
        matchedRows.push(...rows)
      }

      if (matchedRows.length === 0) {
        dbRun(`UPDATE domain_monitors SET last_triggered_at = datetime('now') WHERE id = ?`, [monitorRow.id])
        continue
      }

      // Batch N+1 fix: compute all fingerprints, query seen set in one call
      const fingerprintMap = new Map(
        matchedRows.map(row => [
          credentialFingerprint(row.email, row.password, row.domain),
          row,
        ])
      )
      const fps = Array.from(fingerprintMap.keys())
      const placeholders = fps.map(() => '?').join(',')
      const seenRows = dbQuery(
        `SELECT fingerprint FROM monitor_credential_seen WHERE monitor_id = ? AND fingerprint IN (${placeholders})`,
        [monitorRow.id, ...fps]
      ) as { fingerprint: string }[]
      const seenSet = new Set(seenRows.map(r => r.fingerprint))

      const unseenRows = matchedRows.filter(row => {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        return !seenSet.has(fp)
      })

      if (unseenRows.length === 0) {
        // All already seen — still stamp last_triggered_at so we don't re-query every tick
        dbRun(`UPDATE domain_monitors SET last_triggered_at = datetime('now') WHERE id = ?`, [monitorRow.id])
        continue
      }

      // Fetch active webhooks for this monitor
      const webhookRows = dbQuery(
        `SELECT mw.* FROM monitor_webhooks mw
         JOIN monitor_webhook_map mwm ON mwm.webhook_id = mw.id
         WHERE mwm.monitor_id = ? AND mw.is_active = 1`,
        [monitorRow.id]
      ) as WebhookRow[]

      if (webhookRows.length === 0) {
        // Still update last_triggered_at so we don't hammer ClickHouse
        dbRun(`UPDATE domain_monitors SET last_triggered_at = datetime('now') WHERE id = ?`, [monitorRow.id])
        continue
      }

      const payload = {
        monitor_name: monitorRow.name,
        source_file: '[scheduled-rescan]',
        matched_domains: domains,
        matches: unseenRows.slice(0, 50),
        total_matches: unseenRows.length,
        rescan_mode: monitorRow.rescan_mode,
      }
      const payloadJson = JSON.stringify(payload)

      // Sequential delivery is intentional: inline attempt + outbox enqueue must not race.
      const matchedDomain = domains.join(',')
      for (const wr of webhookRows) {
        let parsedHeaders: Record<string, string> | null = null
        try { parsedHeaders = wr.headers ? JSON.parse(wr.headers) : null } catch {}
        const result = await attemptDelivery({ url: wr.url, secret: wr.secret, headers: parsedHeaders }, payloadJson)
        dbRun(
          `INSERT INTO monitor_alerts
             (monitor_id, webhook_id, source_file, matched_domain, match_type,
              credential_match_count, payload_sent, status, http_status, retry_count)
           VALUES (?, ?, '[scheduled-rescan]', ?, 'credential_email', ?, ?, ?, ?, 0)`,
          [monitorRow.id, wr.id, matchedDomain,
           unseenRows.length, payloadJson, result.ok ? 'success' : 'failed', result.status ?? null],
        )
        dbRun(`UPDATE monitor_webhooks SET last_triggered_at = datetime('now') WHERE id = ?`, [wr.id])
        if (!result.ok) {
          if (result.status !== null && result.status >= 400 && result.status < 500) {
            // 4xx — permanent client error, don't retry
            console.error(`[monitor-rescan] webhook delivery permanently failed (4xx, not queued): ${result.error}`)
          } else {
            // Network error or 5xx — queue for retry
            enqueueFailedDelivery(monitorRow.id, wr.id, payloadJson, '[scheduled-rescan]', matchedDomain, unseenRows.length)
            console.error(`[monitor-rescan] webhook delivery failed (queued for retry): ${result.error}`)
          }
        }
      }

      // Record seen fingerprints (dedup mode) or after re-clear (digest mode)
      for (const row of unseenRows) {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        dbRun(
          'INSERT OR IGNORE INTO monitor_credential_seen (monitor_id, fingerprint) VALUES (?, ?)',
          [monitorRow.id, fp]
        )
      }

      dbRun(
        `UPDATE domain_monitors SET last_triggered_at = datetime('now'), total_alerts = total_alerts + ? WHERE id = ?`,
        [webhookRows.length, monitorRow.id]
      )

      fired++
    } catch (err) {
      console.error(`[monitor-rescan] error processing monitor "${monitorRow.name}": ${err}`)
    }
  }

  console.log(`[monitor-rescan] tick: due=${dueMonitors.length} fired=${fired}`)

  // Process any pending outbox retries from previous failed deliveries
  await runWebhookOutboxTick()
}

