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
import { attemptDelivery, enqueueFailedDelivery, runWebhookOutboxTick } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, credentialFingerprint, type MatchMode } from '@/lib/domain-match'
import { resolveMonitorMatches, tryAcquireRescanLock, releaseRescanLock } from '@/lib/monitor-match-resolver'
import { writeMonitorMatchCache, recordMonitorRescanFailure } from '@/lib/domain-monitor'

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

// ─── Tick ────────────────────────────────────────────────────────────────────

interface DueMonitorRow {
  id: number
  name: string
  domains: string
  match_mode: MatchMode
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

export async function runTick(): Promise<void> {
  // Query SQLite for active monitors whose rescan interval has elapsed
  const dueMonitors = dbQuery(`
    SELECT id, name, domains, match_mode, rescan_mode, rescan_interval_hours
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
    let domains: string[] = []
    try { domains = JSON.parse(monitorRow.domains) } catch { domains = [] }
    if (domains.length === 0) continue

    // Guards against racing a manual rescan of the SAME monitor
    // (app/api/monitoring/monitors/[id]/matches/rescan/route.ts). Without
    // this, an overlapping cron tick + manual rescan could both run phase 2
    // concurrently, and whichever writeMonitorMatchCache call commits LAST
    // would stamp last_success_at, independent of which one actually ran
    // more recently — misreported freshness, not data corruption (the
    // transactional write keeps rows/status consistent either way). See
    // tryAcquireRescanLock's doc comment in lib/monitor-match-resolver.ts.
    // Skipped here, not failed: a rescan already in flight for this monitor
    // will itself refresh the cache, and this monitor stays due until then,
    // so the next tick picks it up if it's still stale.
    if (!tryAcquireRescanLock(monitorRow.id)) {
      console.log(`[monitor-rescan] monitor "${monitorRow.name}" skipped this tick — a rescan is already in flight for it (manual rescan or another tick)`)
      continue
    }

    let cacheWritten = false
    try {
      let matchedRows: CredentialRow[]
      try {
        // For digest mode, clear prior seen fingerprints so all matches
        // re-fire. Deliberately INSIDE this try (not just inside the outer
        // one): dbRun throws synchronously on SQLITE_READONLY/SQLITE_BUSY/
        // SQLITE_FULL (see lib/sqlite.ts), a real failure mode here, and this
        // try's `finally` below is the ONLY place that releases the rescan
        // lock acquired above. A throw from this DELETE landing outside this
        // try (as it used to) would skip that `finally` and leak the lock
        // permanently — every future tick and manual "Rescan now" for this
        // monitor would then see tryAcquireRescanLock return false forever.
        if (monitorRow.rescan_mode === 'digest') {
          dbRun('DELETE FROM monitor_credential_seen WHERE monitor_id = ?', [monitorRow.id])
        }

        // MATCH_LIMIT (100, defined in lib/monitor-match-resolver.ts) is now
        // shared between two use cases that used to have separate limits.
        // Before this cache rewire, alerting queried ClickHouse once PER
        // MONITORED DOMAIN with its own `LIMIT 100`, so a 17-domain monitor
        // could alert on up to ~1700 rows total; display (the live
        // .../matches panel) was the only caller with a 100-row cap. Now both
        // share this one resolveMonitorMatches call and its single 100-row
        // cap. For a monitor with more than 100 genuine matches, that's a
        // fixed window (the lexicographically-lowest 100 by (domain, email,
        // url, password) — see mergeMatchPages in lib/domain-match.ts): once
        // those fingerprints are recorded into monitor_credential_seen below,
        // a domain that sorts after the window can never trigger a webhook
        // alert, no matter how many new credentials arrive for it.
        //
        // This is NOT a regression against actual prior behavior — the old
        // per-domain loop was timing out on every tick for the one real
        // monitor in this system, so it wasn't alerting on anything either —
        // and reusing this single resolver call is exactly what buys the
        // reduced ClickHouse round-trips the design called for (see
        // docs/superpowers/specs/2026-08-24-domain-monitor-saved-matches-design.md
        // §3). But nobody has deliberately decided "100 total is fine for
        // alerting too" — that's accepted for now as a known tradeoff, worth
        // revisiting (e.g. giving the cron's call its own higher limit) if
        // domain-starvation on a >100-match monitor becomes a real problem.
        const resolved = await resolveMonitorMatches(monitorRow.match_mode, domains)
        matchedRows = resolved.rows
        await writeMonitorMatchCache(monitorRow.id, matchedRows)
        cacheWritten = true
      } finally {
        releaseRescanLock(monitorRow.id)
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

      const unseenRows: CredentialRow[] = matchedRows.filter(row => {
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

      // Record seen fingerprints regardless of webhook count — see
      // lib/domain-monitor.ts's mirrored comment for why a webhook-less
      // monitor still needs its matches recorded.
      for (const row of unseenRows) {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        dbRun(
          'INSERT OR IGNORE INTO monitor_credential_seen (monitor_id, fingerprint) VALUES (?, ?)',
          [monitorRow.id, fp]
        )
      }

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
           VALUES (?, ?, '[scheduled-rescan]', ?, ?, ?, ?, ?, ?, 0)`,
          [monitorRow.id, wr.id, matchedDomain, matchModeToMatchType(monitorRow.match_mode),
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

      dbRun(
        `UPDATE domain_monitors SET last_triggered_at = datetime('now'), total_alerts = total_alerts + ? WHERE id = ?`,
        [webhookRows.length, monitorRow.id]
      )

      fired++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[monitor-rescan] error processing monitor "${monitorRow.name}": ${err}`)
      // Only a failure that happened BEFORE the cache write succeeded counts
      // as a rescan failure. Once resolveMonitorMatches + writeMonitorMatchCache
      // both succeed, the scan itself worked — a later throw (e.g. a SQLite
      // write failure in the webhook/alert-logging step below) is a separate,
      // alerting-pipeline problem and must not flip this monitor's cache
      // status to 'failed'; that would mislabel a successful scan and show
      // a self-contradictory "Last check failed ... showing results from
      // just now" in the dialog. Still logged above either way — a
      // downstream failure is worth knowing about even when it isn't
      // attributed to the rescan's own status.
      if (!cacheWritten) {
        try {
          await recordMonitorRescanFailure(monitorRow.id, message)
        } catch (statusErr) {
          console.error(`[monitor-rescan] failed to record rescan status for monitor "${monitorRow.name}": ${statusErr}`)
        }
      }
    }
  }

  console.log(`[monitor-rescan] tick: due=${dueMonitors.length} fired=${fired}`)

  // Process any pending outbox retries from previous failed deliveries
  await runWebhookOutboxTick()
}

