import { dbQuery, dbGet, dbRun, dbTransaction } from '@/lib/sqlite'
import { attemptDelivery, enqueueFailedDelivery } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, credentialFingerprint, type MatchedCredential, type MatchRow } from '@/lib/domain-match'
import crypto from 'crypto'

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

// ─── ULP monitoring ───────────────────────────────────────────────────────────

/**
 * Fire webhook alerts for credentials matched in-process during an upload
 * (see lib/upload-processor.ts, lib/domain-match.ts's matchCredentialsAgainstIndex).
 * Groups matches by monitor, applies the same dedup-fingerprint/webhook/alert-log
 * flow checkMonitorsForULPUpload used to run per ClickHouse-queried domain.
 */
export async function fireMonitorAlertsFromMatches(
  sourceFile: string,
  matches: MatchedCredential[],
  monitorsById: Map<number, DomainMonitor>,
  logFn?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void,
): Promise<void> {
  const log = logFn || (() => {})
  if (matches.length === 0) return

  const byMonitor = new Map<number, MatchedCredential[]>()
  for (const m of matches) {
    const list = byMonitor.get(m.monitorId)
    if (list) list.push(m)
    else byMonitor.set(m.monitorId, [m])
  }

  for (const [monitorId, monitorMatches] of byMonitor) {
    const monitor = monitorsById.get(monitorId)
    if (!monitor) continue
    try {
      // Batch N+1 fix (mirrors lib/monitor-rescan-cron.ts's runTick): compute
      // all fingerprints, then query the seen set in one IN-query instead of
      // one dbGet per match. better-sqlite3 is synchronous, so a per-match
      // dbGet call blocks the event loop once per match — potentially
      // thousands of times for a single broadly-matching upload.
      const fingerprintMap = new Map(
        monitorMatches.map(row => [
          credentialFingerprint(row.email, row.password, row.domain),
          row,
        ])
      )
      const fps = Array.from(fingerprintMap.keys())
      const placeholders = fps.map(() => '?').join(',')
      const seenRows = dbQuery(
        `SELECT fingerprint FROM monitor_credential_seen WHERE monitor_id = ? AND fingerprint IN (${placeholders})`,
        [monitorId, ...fps]
      ) as { fingerprint: string }[]
      const seenSet = new Set(seenRows.map(r => r.fingerprint))

      const unseenRows = monitorMatches.filter(row => {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        return !seenSet.has(fp)
      })

      if (unseenRows.length === 0) {
        log(`Monitor "${monitor.name}": all ${monitorMatches.length} matched credential(s) already alerted — skipping`, 'info')
        continue
      }

      log(`Monitor "${monitor.name}" matched ${unseenRows.length} new credential(s) (${monitorMatches.length - unseenRows.length} already seen)`, 'success')

      const webhookRows = dbQuery(
        `SELECT mw.* FROM monitor_webhooks mw
         JOIN monitor_webhook_map mwm ON mwm.webhook_id = mw.id
         WHERE mwm.monitor_id = ? AND mw.is_active = 1`,
        [monitorId]
      ) as Record<string, unknown>[]

      // Record fingerprints regardless of whether any webhook exists to
      // deliver to — this is what lets a webhook-less monitor's matches
      // still show up in the live saved-search / unread-tracking views.
      for (const row of unseenRows) {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        dbRun(
          `INSERT OR IGNORE INTO monitor_credential_seen (monitor_id, fingerprint) VALUES (?, ?)`,
          [monitorId, fp]
        )
      }

      if (webhookRows.length === 0) {
        // No webhook to deliver to, but the monitor was still checked and
        // its matches recorded above — bump last_triggered_at so the rescan
        // cron doesn't treat it as never-checked, without touching
        // total_alerts (that column counts webhook deliveries, not matches).
        dbRun(`UPDATE domain_monitors SET last_triggered_at = datetime('now') WHERE id = ?`, [monitorId])
        log(`Monitor "${monitor.name}" matched ${unseenRows.length} new credential(s) — no active webhooks, recorded only`, 'info')
        continue
      }

      const payload = {
        monitor_name: monitor.name,
        source_file: sourceFile,
        matched_domains: monitor.domains,
        matches: unseenRows.slice(0, 50).map(({ url, email, password, domain }) => ({ url, email, password, domain })),
        total_matches: unseenRows.length,
      }
      const payloadJson = JSON.stringify(payload)
      const matchedDomain = monitor.domains.join(',')
      const matchType = matchModeToMatchType(monitor.match_mode)

      // Sequential delivery is intentional: inline attempt + outbox enqueue must not race.
      for (const wr of webhookRows) {
        const webhook = parseWebhookRow(wr)
        const result = await attemptDelivery(webhook, payloadJson)
        dbRun(
          `INSERT INTO monitor_alerts
             (monitor_id, webhook_id, source_file, matched_domain, match_type,
              credential_match_count, payload_sent, status, http_status, retry_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [monitorId, webhook.id, sourceFile, matchedDomain, matchType,
           unseenRows.length, payloadJson, result.ok ? 'success' : 'failed', result.status ?? null],
        )
        dbRun(`UPDATE monitor_webhooks SET last_triggered_at = datetime('now') WHERE id = ?`, [webhook.id])
        if (!result.ok) {
          if (result.status !== null && result.status >= 400 && result.status < 500) {
            // 4xx — permanent client error, don't retry
            log(`Webhook delivery permanently failed (4xx, not queued): ${result.error}`, 'warning')
          } else {
            // Network error or 5xx — queue for retry
            enqueueFailedDelivery(monitorId, webhook.id, payloadJson, sourceFile, matchedDomain, unseenRows.length)
            log(`Webhook delivery failed (queued for retry): ${result.error}`, 'warning')
          }
        }
      }

      dbRun(
        `UPDATE domain_monitors SET last_triggered_at = datetime('now'), total_alerts = total_alerts + ? WHERE id = ?`,
        [webhookRows.length, monitorId]
      )
    } catch (err) {
      // logFn currently has no callers anywhere in the codebase (verified via
      // grep), so `log` silently no-ops in production without this — a SQLite
      // failure or any other error while processing one monitor's alerts would
      // otherwise be completely invisible. Mirrors lib/monitor-rescan-cron.ts's
      // equivalent catch block, which already logs to console for this class
      // of error.
      console.error(`[domain-monitor] error processing alerts for monitor "${monitor.name}": ${err}`)
      log(`Error processing monitor alerts for monitor "${monitor.name}": ${err}`, 'error')
    }
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
    'User-Agent': 'ULPSuite-DomainMonitor/1.0',
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

// ─── Per-admin view tracking ─────────────────────────────────────────────────────

export async function getLastViewedAt(monitorId: number, userId: number): Promise<string | null> {
  const row = dbGet(
    `SELECT last_viewed_at FROM monitor_views WHERE monitor_id = ? AND user_id = ?`,
    [monitorId, userId]
  ) as { last_viewed_at: string } | undefined
  return row?.last_viewed_at ?? null
}

export async function recordMonitorViewed(monitorId: number, userId: number): Promise<void> {
  dbRun(
    `INSERT INTO monitor_views (monitor_id, user_id, last_viewed_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(monitor_id, user_id) DO UPDATE SET last_viewed_at = datetime('now')`,
    [monitorId, userId]
  )
}

export async function attachLastViewedAt<T extends { id: number }>(
  monitors: T[],
  userId: number
): Promise<Array<T & { last_viewed_at: string | null }>> {
  return Promise.all(
    monitors.map(async monitor => ({
      ...monitor,
      last_viewed_at: await getLastViewedAt(monitor.id, userId),
    }))
  )
}

/**
 * Flag which of `rows` are new since this admin last viewed the monitor.
 *
 * "New" = the credential's fingerprint is NOT recorded in
 * monitor_credential_seen at or before this admin's monitor_views cursor. A
 * fingerprint absent from monitor_credential_seen entirely (e.g. the rescan
 * cron hasn't caught up with a freshly uploaded credential yet) also counts as
 * new — never-recorded is not the same as already-seen.
 *
 * Extracted from app/api/monitoring/monitors/[id]/matches/route.ts so the
 * cross-referencing can be exercised against a real database
 * (__tests__/monitor-is-new.test.ts) rather than only grepped for in the route
 * source. MUST be called before recordMonitorViewed advances the cursor.
 *
 * KNOWN LIMITATION — this is the authoritative explanation; the GET
 * .../matches/route.ts and POST .../matches/rescan/route.ts call sites (both
 * advance the same per-user view cursor) point here rather than each
 * carrying their own copy: recordMonitorViewed advances this admin's cursor
 * to "now" for the WHOLE monitor on every call, not per credential.
 * monitor_credential_seen can record a fingerprint as seen (e.g. via the
 * upload-triggered check in fireMonitorAlertsFromMatches, or a prior rescan)
 * before that same credential ever appears in this admin's actual result
 * page — including a match sitting outside the resolver's MATCH_LIMIT window
 * (lib/monitor-match-resolver.ts) at the time of a given rescan. If this
 * admin's cursor advances during that gap, the credential can later render
 * with no "new" badge on its first real appearance to them, even though they
 * never actually saw it. Fixing this properly needs a row-level
 * `monitor_credential_shown` ledger (which credential, which admin, first
 * shown when) instead of one cursor per (monitor, admin) — out of scope here.
 */
export async function markMatchesNewSinceLastView<
  T extends { email: string; password: string; domain: string },
>(monitorId: number, userId: number, rows: T[]): Promise<Array<T & { is_new: boolean }>> {
  const lastViewedAt = await getLastViewedAt(monitorId, userId)

  let oldFingerprints = new Set<string>()
  if (lastViewedAt !== null && rows.length > 0) {
    const seenRows = dbQuery(
      `SELECT fingerprint FROM monitor_credential_seen WHERE monitor_id = ? AND seen_at <= ?`,
      [monitorId, lastViewedAt]
    ) as { fingerprint: string }[]
    oldFingerprints = new Set(seenRows.map(r => r.fingerprint))
  }

  return rows.map(row => ({
    ...row,
    is_new: !oldFingerprints.has(credentialFingerprint(row.email, row.password, row.domain)),
  }))
}

// ─── Match cache (saved, not live) ─────────────────────────────────────────

export interface MonitorMatchesCacheEntry {
  rows: Array<{ url: string; email: string; password: string; domain: string }>
  status: 'never_scanned' | 'ok' | 'failed'
  checkedAt: string | null
  lastError: string | null
}

/**
 * Replace a monitor's cached "current matches" snapshot and mark the rescan
 * that produced it as successful. Delete-then-insert in one transaction so a
 * reader never sees a partially-replaced set. Timestamps use SQL
 * datetime('now'), not JS Date — lib/format-relative-time.ts parses the
 * SQLite "YYYY-MM-DD HH:MM:SS" shape specifically.
 */
export async function writeMonitorMatchCache(monitorId: number, rows: MatchRow[]): Promise<void> {
  dbTransaction(() => {
    dbRun('DELETE FROM monitor_matches WHERE monitor_id = ?', [monitorId])
    for (const row of rows) {
      dbRun(
        `INSERT INTO monitor_matches (monitor_id, url, email, password, domain, fetched_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [monitorId, row.url, row.email, row.password, row.domain]
      )
    }
    dbRun(
      `INSERT INTO monitor_rescan_status (monitor_id, status, error, attempted_at, last_success_at)
       VALUES (?, 'ok', NULL, datetime('now'), datetime('now'))
       ON CONFLICT(monitor_id) DO UPDATE SET status = 'ok', error = NULL, attempted_at = datetime('now'), last_success_at = datetime('now')`,
      [monitorId]
    )
  })
}

/**
 * Record a failed rescan attempt without touching the previous good
 * monitor_matches snapshot — a stale cache is more useful than an empty one.
 * This is the fix for the bug where a timeout was only ever console.error'd:
 * lib/monitor-rescan-cron.ts's runTick previously had no persisted trace of
 * a monitor failing every single tick.
 */
export async function recordMonitorRescanFailure(monitorId: number, error: string): Promise<void> {
  dbRun(
    `INSERT INTO monitor_rescan_status (monitor_id, status, error, attempted_at, last_success_at)
     VALUES (?, 'failed', ?, datetime('now'), NULL)
     ON CONFLICT(monitor_id) DO UPDATE SET status = 'failed', error = ?, attempted_at = datetime('now')`,
    [monitorId, error, error]
  )
}

/** Read the current cached matches + rescan health for a monitor. */
export async function getMonitorMatchesCache(monitorId: number): Promise<MonitorMatchesCacheEntry> {
  const statusRow = dbGet(
    `SELECT status, error, last_success_at FROM monitor_rescan_status WHERE monitor_id = ?`,
    [monitorId]
  ) as { status: 'ok' | 'failed'; error: string | null; last_success_at: string | null } | undefined

  if (!statusRow) {
    return { rows: [], status: 'never_scanned', checkedAt: null, lastError: null }
  }

  const rows = dbQuery(
    `SELECT url, email, password, domain FROM monitor_matches WHERE monitor_id = ? ORDER BY domain, email`,
    [monitorId]
  ) as Array<{ url: string; email: string; password: string; domain: string }>

  return {
    rows,
    status: statusRow.status,
    checkedAt: statusRow.last_success_at,
    lastError: statusRow.status === 'failed' ? statusRow.error : null,
  }
}
