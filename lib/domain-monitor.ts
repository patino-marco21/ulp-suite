import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import crypto from 'crypto'

// ─── Fingerprinting ───────────────────────────────────────────────────────────

/**
 * Compute a 32-bit fingerprint for a credential triple (email, password, domain).
 * Used to avoid re-alerting when the same credential appears in a later upload.
 */
function credentialFingerprint(email: string, password: string, domain: string): number {
  const hash = crypto.createHash('sha256')
    .update(email).update('\0')
    .update(password).update('\0')
    .update(domain)
    .digest()
  // First 4 bytes as unsigned 32-bit int — safe as a JS number (< 2^32 < MAX_SAFE_INTEGER)
  return hash.readUInt32BE(0)
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DomainMonitor {
  id: number
  name: string
  domains: string[]
  match_mode: 'credential' | 'url' | 'both'
  is_active: boolean
  created_by: number | null
  last_triggered_at: string | null
  total_alerts: number
  rescan_mode: 'dedup' | 'digest'
  rescan_interval_hours: number
  created_at: string
  updated_at: string
  webhook_count?: number
  webhooks?: MonitorWebhook[]
}

export interface MonitorWebhook {
  id: number
  name: string
  url: string
  secret: string | null
  headers: Record<string, string> | null
  is_active: boolean
  created_by: number | null
  last_triggered_at: string | null
  created_at: string
  updated_at: string
  monitor_count?: number
}

export interface MonitorAlert {
  id: number
  monitor_id: number
  webhook_id: number
  source_file: string | null
  matched_domain: string
  match_type: 'credential_email' | 'url' | 'both'
  credential_match_count: number
  url_match_count: number
  payload_sent: string | null
  status: 'success' | 'failed' | 'retrying'
  http_status: number | null
  error_message: string | null
  retry_count: number
  created_at: string
  monitor_name?: string
  webhook_name?: string
  webhook_url?: string
}

// ─── Row parsers ─────────────────────────────────────────────────────────────

function parseMonitorRow(row: Record<string, unknown>): DomainMonitor {
  let domains: string[] = []
  try { domains = typeof row.domains === 'string' ? JSON.parse(row.domains) : row.domains as string[] } catch { domains = [] }
  return {
    id: row.id as number,
    name: row.name as string,
    domains,
    match_mode: row.match_mode as DomainMonitor['match_mode'],
    is_active: Boolean(row.is_active),
    created_by: (row.created_by as number) ?? null,
    last_triggered_at: (row.last_triggered_at as string) ?? null,
    total_alerts: (row.total_alerts as number) || 0,
    rescan_mode: (row.rescan_mode as 'dedup' | 'digest') ?? 'dedup',
    rescan_interval_hours: (row.rescan_interval_hours as number) ?? 24,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    webhook_count: row.webhook_count as number | undefined,
  }
}

function parseWebhookRow(row: Record<string, unknown>): MonitorWebhook {
  let headers: Record<string, string> | null = null
  try { headers = row.headers ? (typeof row.headers === 'string' ? JSON.parse(row.headers as string) : row.headers as Record<string, string>) : null } catch { headers = null }
  return {
    id: row.id as number,
    name: row.name as string,
    url: row.url as string,
    secret: (row.secret as string) ?? null,
    headers,
    is_active: Boolean(row.is_active),
    created_by: (row.created_by as number) ?? null,
    last_triggered_at: (row.last_triggered_at as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    monitor_count: row.monitor_count as number | undefined,
  }
}

// ─── Monitor CRUD ─────────────────────────────────────────────────────────────

export async function createMonitor(data: {
  name: string
  domains: string[]
  match_mode: 'credential' | 'url' | 'both'
  webhook_ids: number[]
  created_by?: number
  rescan_mode?: 'dedup' | 'digest'
  rescan_interval_hours?: number
}): Promise<number> {
  const { lastId } = dbRun(
    `INSERT INTO domain_monitors (name, domains, match_mode, created_by, rescan_mode, rescan_interval_hours) VALUES (?, ?, ?, ?, ?, ?)`,
    [data.name, JSON.stringify(data.domains), data.match_mode, data.created_by || null, data.rescan_mode ?? 'dedup', data.rescan_interval_hours ?? 24]
  )
  if (data.webhook_ids.length > 0) {
    for (const wid of data.webhook_ids) {
      dbRun(`INSERT OR IGNORE INTO monitor_webhook_map (monitor_id, webhook_id) VALUES (?, ?)`, [lastId, wid])
    }
  }
  return lastId
}

export async function updateMonitor(id: number, data: {
  name?: string
  domains?: string[]
  match_mode?: 'credential' | 'url' | 'both'
  is_active?: boolean
  webhook_ids?: number[]
  rescan_mode?: 'dedup' | 'digest'
  rescan_interval_hours?: number
}): Promise<void> {
  const parts: string[] = []
  const params: unknown[] = []
  if (data.name !== undefined) { parts.push('name = ?'); params.push(data.name) }
  if (data.domains !== undefined) { parts.push('domains = ?'); params.push(JSON.stringify(data.domains)) }
  if (data.match_mode !== undefined) { parts.push('match_mode = ?'); params.push(data.match_mode) }
  if (data.is_active !== undefined) { parts.push('is_active = ?'); params.push(data.is_active ? 1 : 0) }
  if (data.rescan_mode !== undefined) { parts.push('rescan_mode = ?'); params.push(data.rescan_mode) }
  if (data.rescan_interval_hours !== undefined) { parts.push('rescan_interval_hours = ?'); params.push(data.rescan_interval_hours) }
  if (parts.length > 0) {
    parts.push("updated_at = datetime('now')")
    params.push(id)
    dbRun(`UPDATE domain_monitors SET ${parts.join(', ')} WHERE id = ?`, params)
  }
  if (data.webhook_ids !== undefined) {
    dbRun('DELETE FROM monitor_webhook_map WHERE monitor_id = ?', [id])
    for (const wid of data.webhook_ids) {
      dbRun(`INSERT OR IGNORE INTO monitor_webhook_map (monitor_id, webhook_id) VALUES (?, ?)`, [id, wid])
    }
  }
}

export async function deleteMonitor(id: number): Promise<void> {
  dbRun('DELETE FROM domain_monitors WHERE id = ?', [id])
}

export async function getMonitor(id: number): Promise<DomainMonitor | null> {
  const row = dbGet(
    `SELECT dm.*, (SELECT COUNT(*) FROM monitor_webhook_map WHERE monitor_id = dm.id) as webhook_count
     FROM domain_monitors dm WHERE dm.id = ?`,
    [id]
  ) as Record<string, unknown> | undefined
  if (!row) return null
  const monitor = parseMonitorRow(row)
  const webhooks = dbQuery(
    `SELECT mw.* FROM monitor_webhooks mw
     JOIN monitor_webhook_map mwm ON mwm.webhook_id = mw.id WHERE mwm.monitor_id = ?`,
    [id]
  ) as Record<string, unknown>[]
  monitor.webhooks = webhooks.map(parseWebhookRow)
  return monitor
}

export async function listMonitors(options?: {
  activeOnly?: boolean
  limit?: number
  offset?: number
}): Promise<{ monitors: DomainMonitor[]; total: number }> {
  const where = options?.activeOnly ? 'WHERE dm.is_active = 1' : ''
  const total = ((dbGet(`SELECT COUNT(*) as c FROM domain_monitors dm ${where}`) as { c: number }).c)
  const limit = options?.limit || 50
  const offset = options?.offset || 0
  const rows = dbQuery(
    `SELECT dm.*, (SELECT COUNT(*) FROM monitor_webhook_map WHERE monitor_id = dm.id) as webhook_count
     FROM domain_monitors dm ${where} ORDER BY dm.created_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  ) as Record<string, unknown>[]
  return { monitors: rows.map(parseMonitorRow), total }
}

export async function getActiveMonitors(): Promise<DomainMonitor[]> {
  const rows = dbQuery('SELECT * FROM domain_monitors WHERE is_active = 1') as Record<string, unknown>[]
  return rows.map(parseMonitorRow)
}

// ─── Webhook CRUD ─────────────────────────────────────────────────────────────

export async function createWebhook(data: {
  name: string
  url: string
  secret?: string
  headers?: Record<string, string>
  created_by?: number
}): Promise<number> {
  const { lastId } = dbRun(
    `INSERT INTO monitor_webhooks (name, url, secret, headers, created_by) VALUES (?, ?, ?, ?, ?)`,
    [data.name, data.url, data.secret || null, data.headers ? JSON.stringify(data.headers) : null, data.created_by || null]
  )
  return lastId
}

export async function updateWebhook(id: number, data: {
  name?: string
  url?: string
  secret?: string | null
  headers?: Record<string, string> | null
  is_active?: boolean
}): Promise<void> {
  const parts: string[] = []
  const params: unknown[] = []
  if (data.name !== undefined) { parts.push('name = ?'); params.push(data.name) }
  if (data.url !== undefined) { parts.push('url = ?'); params.push(data.url) }
  if (data.secret !== undefined) { parts.push('secret = ?'); params.push(data.secret) }
  if (data.headers !== undefined) { parts.push('headers = ?'); params.push(data.headers ? JSON.stringify(data.headers) : null) }
  if (data.is_active !== undefined) { parts.push('is_active = ?'); params.push(data.is_active ? 1 : 0) }
  if (parts.length > 0) {
    parts.push("updated_at = datetime('now')")
    params.push(id)
    dbRun(`UPDATE monitor_webhooks SET ${parts.join(', ')} WHERE id = ?`, params)
  }
}

export async function deleteWebhook(id: number): Promise<void> {
  dbRun('DELETE FROM monitor_webhooks WHERE id = ?', [id])
}

export async function getWebhook(id: number): Promise<MonitorWebhook | null> {
  const row = dbGet(
    `SELECT mw.*, (SELECT COUNT(*) FROM monitor_webhook_map WHERE webhook_id = mw.id) as monitor_count
     FROM monitor_webhooks mw WHERE mw.id = ?`,
    [id]
  ) as Record<string, unknown> | undefined
  return row ? parseWebhookRow(row) : null
}

export async function listWebhooks(options?: {
  activeOnly?: boolean
  limit?: number
  offset?: number
}): Promise<{ webhooks: MonitorWebhook[]; total: number }> {
  const where = options?.activeOnly ? 'WHERE mw.is_active = 1' : ''
  const total = ((dbGet(`SELECT COUNT(*) as c FROM monitor_webhooks mw ${where}`) as { c: number }).c)
  const limit = options?.limit || 50
  const offset = options?.offset || 0
  const rows = dbQuery(
    `SELECT mw.*, (SELECT COUNT(*) FROM monitor_webhook_map WHERE webhook_id = mw.id) as monitor_count
     FROM monitor_webhooks mw ${where} ORDER BY mw.created_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  ) as Record<string, unknown>[]
  return { webhooks: rows.map(parseWebhookRow), total }
}

// ─── Alert log ───────────────────────────────────────────────────────────────

export async function listAlerts(options?: {
  monitorId?: number
  webhookId?: number
  status?: 'success' | 'failed' | 'retrying'
  limit?: number
  offset?: number
}): Promise<{ alerts: MonitorAlert[]; total: number }> {
  const conds: string[] = []
  const params: unknown[] = []
  if (options?.monitorId) { conds.push('ma.monitor_id = ?'); params.push(options.monitorId) }
  if (options?.webhookId) { conds.push('ma.webhook_id = ?'); params.push(options.webhookId) }
  if (options?.status) { conds.push('ma.status = ?'); params.push(options.status) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = ((dbGet(`SELECT COUNT(*) as c FROM monitor_alerts ma ${where}`, params) as { c: number }).c)
  const limit = options?.limit || 50
  const offset = options?.offset || 0
  const rows = dbQuery(
    `SELECT ma.*, dm.name as monitor_name, mw.name as webhook_name, mw.url as webhook_url
     FROM monitor_alerts ma
     LEFT JOIN domain_monitors dm ON dm.id = ma.monitor_id
     LEFT JOIN monitor_webhooks mw ON mw.id = ma.webhook_id
     ${where} ORDER BY ma.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  ) as Record<string, unknown>[]
  return { alerts: rows.map(r => r as unknown as MonitorAlert), total }
}

export async function getAlertStats(): Promise<{ total: number; today: number; success: number; failed: number }> {
  const row = dbGet(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) as today,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM monitor_alerts
  `) as { total: number; today: number; success: number; failed: number }
  return { total: row.total || 0, today: row.today || 0, success: row.success || 0, failed: row.failed || 0 }
}

// ─── Webhook delivery ─────────────────────────────────────────────────────────

async function deliverWebhook(
  webhook: MonitorWebhook,
  payloadJson: string,
  monitorId: number,
  sourceFile: string,
  matchedDomain: string,
  credCount: number,
  retryCount = 0
): Promise<void> {
  const MAX_RETRIES = 3
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'ULPVault-DomainMonitor/1.0',
    ...(webhook.headers || {}),
  }
  if (webhook.secret) {
    headers['X-Webhook-Signature'] = `sha256=${crypto.createHmac('sha256', webhook.secret).update(payloadJson).digest('hex')}`
  }

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 30_000)
    const res = await fetch(webhook.url, { method: 'POST', headers, body: payloadJson, signal: ctrl.signal })
    clearTimeout(t)

    dbRun(
      `INSERT INTO monitor_alerts (monitor_id, webhook_id, source_file, matched_domain, match_type, credential_match_count, payload_sent, status, http_status, retry_count)
       VALUES (?, ?, ?, ?, 'credential_email', ?, ?, ?, ?, ?)`,
      [monitorId, webhook.id, sourceFile, matchedDomain, credCount, payloadJson, res.ok ? 'success' : 'failed', res.status, retryCount]
    )
    dbRun(`UPDATE monitor_webhooks SET last_triggered_at = datetime('now') WHERE id = ?`, [webhook.id])

    if (!res.ok && res.status >= 500 && retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, Math.pow(2, retryCount) * 1000))
      return deliverWebhook(webhook, payloadJson, monitorId, sourceFile, matchedDomain, credCount, retryCount + 1)
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    dbRun(
      `INSERT INTO monitor_alerts (monitor_id, webhook_id, source_file, matched_domain, match_type, credential_match_count, payload_sent, status, error_message, retry_count)
       VALUES (?, ?, ?, ?, 'credential_email', ?, ?, 'failed', ?, ?)`,
      [monitorId, webhook.id, sourceFile, matchedDomain, credCount, payloadJson, errMsg, retryCount]
    )
    if (retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, Math.pow(2, retryCount) * 1000))
      return deliverWebhook(webhook, payloadJson, monitorId, sourceFile, matchedDomain, credCount, retryCount + 1)
    }
  }
}

// ─── ULP monitoring ───────────────────────────────────────────────────────────

export async function checkMonitorsForULPUpload(
  sourceFile: string,
  logFn?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void
): Promise<void> {
  const log = logFn || (() => {})
  try {
    const monitors = await getActiveMonitors()
    if (monitors.length === 0) return

    log(`Checking ${monitors.length} domain monitor(s) against: ${sourceFile}`, 'info')

    for (const monitor of monitors) {
      try {
        const matchedRows: Array<{ url: string; email: string; password: string; domain: string }> = []

        for (const domain of monitor.domains) {
          const d = domain.toLowerCase().trim()
          const rows = await executeClickHouseQuery(
            `SELECT url, email, password, domain
             FROM ulp.credentials
             WHERE source_file = {sourceFile:String}
               AND (domain = {domain:String} OR endsWith(lower(email), {emailSuffix:String}))
             LIMIT 100`,
            { sourceFile, domain: d, emailSuffix: `@${d}` }
          ) as Array<{ url: string; email: string; password: string; domain: string }>
          matchedRows.push(...rows)
        }

        if (matchedRows.length === 0) continue

        // Dedup: filter credentials whose fingerprint has already triggered an alert
        // for this monitor — prevents duplicate notifications on re-uploads.
        const unseenRows = matchedRows.filter(row => {
          const fp = credentialFingerprint(row.email, row.password, row.domain)
          return !dbGet(
            `SELECT 1 FROM monitor_credential_seen WHERE monitor_id = ? AND fingerprint = ?`,
            [monitor.id, fp]
          )
        })

        if (unseenRows.length === 0) {
          log(`Monitor "${monitor.name}": all ${matchedRows.length} matched credential(s) already alerted — skipping`, 'info')
          continue
        }

        log(`Monitor "${monitor.name}" matched ${unseenRows.length} new credential(s) (${matchedRows.length - unseenRows.length} already seen)`, 'success')

        const webhookRows = dbQuery(
          `SELECT mw.* FROM monitor_webhooks mw
           JOIN monitor_webhook_map mwm ON mwm.webhook_id = mw.id
           WHERE mwm.monitor_id = ? AND mw.is_active = 1`,
          [monitor.id]
        ) as Record<string, unknown>[]

        if (webhookRows.length === 0) continue

        const payload = {
          monitor_name: monitor.name,
          source_file: sourceFile,
          matched_domains: monitor.domains,
          matches: unseenRows.slice(0, 50),
          total_matches: unseenRows.length,
        }
        const payloadJson = JSON.stringify(payload)

        for (const wr of webhookRows) {
          const webhook = parseWebhookRow(wr)
          deliverWebhook(webhook, payloadJson, monitor.id, sourceFile, monitor.domains.join(','), unseenRows.length)
            .catch(err => log(`Webhook delivery error: ${err}`, 'error'))
        }

        // Record fingerprints so future uploads of the same credentials don't re-alert
        for (const row of unseenRows) {
          const fp = credentialFingerprint(row.email, row.password, row.domain)
          dbRun(
            `INSERT OR IGNORE INTO monitor_credential_seen (monitor_id, fingerprint) VALUES (?, ?)`,
            [monitor.id, fp]
          )
        }

        dbRun(
          `UPDATE domain_monitors SET last_triggered_at = datetime('now'), total_alerts = total_alerts + ? WHERE id = ?`,
          [webhookRows.length, monitor.id]
        )
      } catch (err) {
        log(`Error processing monitor "${monitor.name}": ${err}`, 'error')
      }
    }
  } catch (err) {
    log(`ULP monitor check error: ${err}`, 'error')
  }
}

// ─── Webhook test ─────────────────────────────────────────────────────────────

export async function testWebhook(webhookId: number): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const webhook = await getWebhook(webhookId)
  if (!webhook) return { success: false, error: 'Webhook not found' }

  const testPayload = JSON.stringify({
    monitor_name: '[TEST] Sample Monitor',
    source_file: 'test.txt',
    matched_domains: ['example.com'],
    matches: [{ url: 'https://example.com', email: 'user@example.com', password: 'test123', domain: 'example.com' }],
    total_matches: 1,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'ULPVault-DomainMonitor/1.0',
    'X-Webhook-Test': 'true',
    ...(webhook.headers || {}),
  }
  if (webhook.secret) {
    headers['X-Webhook-Signature'] = `sha256=${crypto.createHmac('sha256', webhook.secret).update(testPayload).digest('hex')}`
  }

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15_000)
    const res = await fetch(webhook.url, { method: 'POST', headers, body: testPayload, signal: ctrl.signal })
    clearTimeout(t)
    return { success: res.ok, statusCode: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
