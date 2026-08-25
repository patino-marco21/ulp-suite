import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getMonitor, getMonitorMatchesCache, markMatchesNewSinceLastView, recordMonitorViewed } from "@/lib/domain-monitor"
import { MATCH_LIMIT } from "@/lib/monitor-match-resolver"

export const dynamic = 'force-dynamic'

/**
 * GET /api/monitoring/monitors/[id]/matches
 * Saved-search: the monitor's cached "current matches" snapshot, populated by
 * the rescan cron (lib/monitor-rescan-cron.ts) or a manual
 * POST .../matches/rescan — never queries ClickHouse directly. See
 * docs/superpowers/specs/2026-08-24-domain-monitor-saved-matches-design.md.
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

  const userId = parseInt(user.userId)

  try {
    const monitor = await getMonitor(monitorId)
    if (!monitor) {
      return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
    }

    const cache = await getMonitorMatchesCache(monitorId)
    // See markMatchesNewSinceLastView's doc comment (lib/domain-monitor.ts)
    // for the known limitation where a match can render without a "new"
    // badge on its first real appearance to this admin.
    const results = await markMatchesNewSinceLastView(monitorId, userId, cache.rows)
    const newCount = results.filter(r => r.is_new).length

    // Best-effort, matches the prior live-query endpoint's behavior: a
    // failure here must not cost the admin the read they just made.
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
      limited: results.length === MATCH_LIMIT,
      checked_at: cache.checkedAt,
      never_scanned: cache.status === 'never_scanned',
      last_error: cache.lastError,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Monitor matches cache read error:', msg)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
