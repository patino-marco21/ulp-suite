import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getMonitor, markMatchesNewSinceLastView, recordMonitorViewed } from "@/lib/domain-monitor"
import { resolveMonitorMatches } from "@/lib/monitor-match-resolver"
import { checkLimit, getClientIP } from "@/lib/rate-limiter"

export const dynamic = 'force-dynamic'

// Worst measured cold path is phase 1 + phase 2 on a broad-but-enumerable
// monitor, ~20 s (see lib/monitor-match-resolver.ts); the budget keeps real
// headroom over that.
export const maxDuration = 90

// Rate limit: this endpoint's phase-1 cache-miss path is a real full-column
// scan, so it must not be hammerable. Mirrors app/api/upload/route.ts's idiom
// (module-level Map + checkLimit, keyed by IP).
const matchesLimiter = new Map<string, { count: number; resetAt: number }>()

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

  const ip = getClientIP(request)
  const rlResult = checkLimit(matchesLimiter, ip, 30, 60_000)
  if (!rlResult.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many match queries — please wait a moment before retrying.' },
      {
        status: 429,
        headers: {
          'Retry-After':           String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit':     '30',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset':     String(rlResult.resetAt),
        },
      }
    )
  }

  const { id } = await params
  const monitorId = parseInt(id)
  if (isNaN(monitorId)) {
    return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
  }

  const userId = parseInt(user.userId)

  try {
    const monitor = await getMonitor(monitorId)
    if (!monitor) {
      return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
    }

    // A blank entry would build `domain = ''`, matching every domain-less row.
    const domains = monitor.domains.map(d => d.toLowerCase().trim()).filter(Boolean)
    if (domains.length === 0) {
      return NextResponse.json({ success: true, results: [], total_shown: 0, new_count: 0, limited: false })
    }

    const { rows, limited } = await resolveMonitorMatches(monitor.match_mode, domains)

    const results = await markMatchesNewSinceLastView(monitorId, userId, rows)
    const newCount = results.filter(r => r.is_new).length

    // KNOWN LIMITATION (accepted, not an oversight): this advances the
    // "last viewed" cursor to now for every match recorded up to this
    // moment, including matches that exist but fell outside the MATCH_LIMIT
    // rows above. Such a match can later read as not-new even though this
    // admin never actually saw it. Fixing it properly means replacing the
    // time cursor with a row-level monitor_credential_shown(monitor_id,
    // user_id, fingerprint) ledger — a data-model change deliberately out of
    // scope here.
    //
    // Best-effort: `results` above is already computed and correct, so a
    // failure here must not cost the admin the query they just waited on.
    // Worst case the is_new badge is stale on the next view.
    try {
      await recordMonitorViewed(monitorId, userId)
    } catch (viewError) {
      const viewMsg = viewError instanceof Error ? viewError.message : String(viewError)
      console.error('Failed to record monitor viewed:', viewMsg)
    }

    return NextResponse.json({
      success: true,
      results,
      total_shown: results.length,
      new_count: newCount,
      limited,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const isTimeout = msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout') || msg.includes('Timeout')

    if (isTimeout) {
      // timeout_overflow_mode=throw: return a structured timeout response so
      // the dialog can say what happened instead of rendering an empty state
      // that reads as an authoritative "nothing matches".
      return NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Match search timed out — this monitor watches a domain set too broad to scan. Narrow its domains, or browse a single domain in Credentials.',
        results:   [],
      }, { status: 408 })
    }

    console.error('Monitor matches query error:', msg)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
