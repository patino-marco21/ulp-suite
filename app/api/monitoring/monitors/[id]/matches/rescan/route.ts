import { NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import {
  getMonitor,
  writeMonitorMatchCache,
  recordMonitorRescanFailure,
  getMonitorMatchesCache,
  markMatchesNewSinceLastView,
  recordMonitorViewed,
} from "@/lib/domain-monitor"
import { resolveMonitorMatches } from "@/lib/monitor-match-resolver"
import { checkLimit, getClientIP } from "@/lib/rate-limiter"

export const dynamic = 'force-dynamic'

// Mirrors lib/monitor-match-resolver.ts's own MATCH_LIMIT (not exported from
// there), since `limited` here is re-derived from the cache read-back rather
// than trusted off resolveMonitorMatches's return value directly — see the
// comment above the response below for why.
const MATCH_LIMIT = 100

// Rate limit: mirrors app/api/monitoring/monitors/[id]/matches/route.ts's
// matchesLimiter idiom (module-level Map + checkLimit, keyed by IP). Tighter
// than that endpoint's 30/min since every call here does a full ClickHouse
// resolve — there is no cache-hit fast path to fall back on.
const rescanLimiter = new Map<string, { count: number; resetAt: number }>()

// Guards against two overlapping scans of the SAME monitor — an admin
// double-click, or the 15-minute cron firing mid-manual-rescan. A per-IP
// rate limit alone wouldn't catch two different admins hitting one monitor.
//
// The has()-check and the add() below MUST stay adjacent with no `await`
// between them. JS only guarantees run-to-completion across a synchronous
// stretch; a suspension point inserted between the read and the write (e.g.
// moving add() after `await getMonitor(...)`) reopens a check-then-act race
// where two genuinely concurrent requests each observe the set as empty
// before either writes to it.
const inFlightRescans = new Set<number>()

/**
 * POST /api/monitoring/monitors/[id]/matches/rescan
 * On-demand equivalent of the scheduled rescan cron (lib/monitor-rescan-cron.ts):
 * resolves this monitor's current matches against ClickHouse and writes them
 * to the SQLite cache (lib/domain-monitor.ts's writeMonitorMatchCache /
 * recordMonitorRescanFailure), then returns the freshly-cached read — the
 * same shape the GET .../matches endpoint (Task 9) returns, so the "Rescan
 * now" hook (Task 10) can share one handler for both.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const { id } = await params
  const monitorId = parseInt(id)
  if (isNaN(monitorId)) {
    return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
  }

  const ip = getClientIP(request)
  const rlResult = checkLimit(rescanLimiter, ip, 10, 60_000)
  if (!rlResult.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many rescan requests — please wait a moment before retrying.' },
      {
        status: 429,
        headers: {
          'Retry-After':           String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit':     '10',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset':     String(rlResult.resetAt),
        },
      }
    )
  }

  if (inFlightRescans.has(monitorId)) {
    return NextResponse.json(
      { success: false, error: 'A rescan for this monitor is already in progress.' },
      { status: 409 }
    )
  }
  inFlightRescans.add(monitorId)

  try {
    const monitor = await getMonitor(monitorId)
    if (!monitor) {
      return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
    }

    // A blank entry would build `domain = ''`, matching every domain-less row.
    const domains = monitor.domains.map(d => d.toLowerCase().trim()).filter(Boolean)

    // A resolver failure (e.g. a ClickHouse timeout) is recorded, not
    // rethrown: the previous good monitor_matches snapshot stays in place
    // (see recordMonitorRescanFailure's doc comment — a stale cache beats an
    // empty one), and the request still succeeds below, reporting the
    // failure via last_error instead of a 500.
    try {
      const resolved = await resolveMonitorMatches(monitor.match_mode, domains)
      await writeMonitorMatchCache(monitorId, resolved.rows)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await recordMonitorRescanFailure(monitorId, message)
    }

    const userId = parseInt(user.userId)
    const cache = await getMonitorMatchesCache(monitorId)
    const results = await markMatchesNewSinceLastView(monitorId, userId, cache.rows)

    // Best-effort, matching the GET route's pattern: `results` above is
    // already computed and correct, so a failure here must not cost the
    // admin the rescan they just triggered.
    try {
      await recordMonitorViewed(monitorId, userId)
    } catch (viewError) {
      console.error('Failed to record monitor viewed:', viewError instanceof Error ? viewError.message : String(viewError))
    }

    return NextResponse.json({
      success: true,
      results,
      total_shown: results.length,
      new_count: results.filter(r => r.is_new).length,
      limited: results.length === MATCH_LIMIT,
      checked_at: cache.checkedAt,
      last_error: cache.lastError,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Monitor rescan error:', msg)
    return NextResponse.json({ success: false, error: 'Rescan failed' }, { status: 500 })
  } finally {
    inFlightRescans.delete(monitorId)
  }
}
