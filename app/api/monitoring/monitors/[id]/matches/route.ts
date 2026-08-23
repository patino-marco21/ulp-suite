import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getMonitor, getLastViewedAt, recordMonitorViewed } from "@/lib/domain-monitor"
import { executeQuery } from "@/lib/clickhouse"
import { buildDomainSetWhereClause, credentialFingerprint } from "@/lib/domain-match"
import { NORM_DOMAIN_EXPR } from "@/lib/ulp-normalize"
import { dbQuery } from "@/lib/sqlite"

export const dynamic = 'force-dynamic'

// Bounded, unordered "what's currently matching" snapshot — LIMIT lets
// ClickHouse short-circuit the scan instead of evaluating all 91M+ rows.
// Deliberately has no ORDER BY: sorting the filtered set before LIMIT would
// defeat that short-circuit and force a full scan (see app/api/credentials/
// route.ts's SORT_MAX_MEMORY_BYTES comment for the production incident this
// avoids). For deep, sorted, paginated browsing of a single domain, use
// /credentials?domain=X instead — this endpoint is a bounded live snapshot
// across a monitor's whole domain set.
const MATCH_LIMIT = 100

interface MatchRow {
  url: string
  email: string
  password: string
  domain: string
}

/**
 * GET /api/monitoring/monitors/[id]/matches
 * Live saved-search: up to MATCH_LIMIT credentials currently matching this
 * monitor's domains, queried directly against ClickHouse. Independent of
 * webhooks/alerts — works even if the monitor has none configured.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const monitorId = parseInt(id)
  if (isNaN(monitorId)) {
    return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
  }

  const monitor = await getMonitor(monitorId)
  if (!monitor) {
    return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
  }

  if (monitor.domains.length === 0) {
    return NextResponse.json({ success: true, results: [], total_shown: 0, limited: false })
  }

  const { clause, params: domainParams } = buildDomainSetWhereClause(monitor.domains, monitor.match_mode)

  const userId = parseInt(user.userId)

  try {
    const [rows, lastViewedAt] = await Promise.all([
      executeQuery(
        `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
         FROM ulp.credentials
         WHERE ${clause}
         LIMIT {matchLimit:UInt32}
         SETTINGS max_execution_time = 60, timeout_overflow_mode = 'throw'`,
        { ...domainParams, matchLimit: MATCH_LIMIT }
      ) as Promise<MatchRow[]>,
      getLastViewedAt(monitorId, userId),
    ])

    // "New" = not recorded as seen at or before this admin's last view. A
    // fingerprint absent from monitor_credential_seen entirely (e.g. the
    // rescan cron hasn't caught up yet) also counts as new.
    let oldFingerprints = new Set<string>()
    if (lastViewedAt !== null) {
      const seenRows = dbQuery(
        `SELECT fingerprint FROM monitor_credential_seen WHERE monitor_id = ? AND seen_at <= ?`,
        [monitorId, lastViewedAt]
      ) as { fingerprint: string }[]
      oldFingerprints = new Set(seenRows.map(r => r.fingerprint))
    }

    const results = rows.map(row => ({
      ...row,
      is_new: !oldFingerprints.has(credentialFingerprint(row.email, row.password, row.domain)),
    }))
    const newCount = results.filter(r => r.is_new).length

    await recordMonitorViewed(monitorId, userId)

    return NextResponse.json({
      success: true,
      results,
      total_shown: results.length,
      new_count: newCount,
      limited: results.length === MATCH_LIMIT,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Monitor matches query error:', msg)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
