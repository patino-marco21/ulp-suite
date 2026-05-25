import { NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import { createMonitor, listMonitors } from "@/lib/domain-monitor"

export const dynamic = 'force-dynamic'

/**
 * GET /api/monitoring/monitors
 * List all domain monitors
 */
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const activeOnly = searchParams.get("active_only") === "true"
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = parseInt(searchParams.get("offset") || "0")

    const result = await listMonitors({ activeOnly, limit, offset })

    return NextResponse.json({
      success: true,
      data: result.monitors,
      total: result.total,
    })
  } catch (error) {
    console.error("Error listing monitors:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to list monitors" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/monitoring/monitors
 * Create a new domain monitor
 */
export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  try {
    const body = await request.json()
    const { name, domains, match_mode, webhook_ids, rescan_mode, rescan_interval_hours } = body

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: "Monitor name is required" },
        { status: 400 }
      )
    }

    if (!domains || !Array.isArray(domains) || domains.length === 0) {
      return NextResponse.json(
        { success: false, error: "At least one domain is required" },
        { status: 400 }
      )
    }

    if (!["credential", "url", "both"].includes(match_mode)) {
      return NextResponse.json(
        { success: false, error: "match_mode must be 'credential', 'url', or 'both'" },
        { status: 400 }
      )
    }

    if (rescan_mode !== undefined && !['dedup', 'digest'].includes(rescan_mode)) {
      return NextResponse.json({ success: false, error: "rescan_mode must be 'dedup' or 'digest'" }, { status: 400 })
    }

    if (rescan_interval_hours !== undefined) {
      const h = parseInt(String(rescan_interval_hours))
      if (isNaN(h) || h < 1 || h > 168) {
        return NextResponse.json({ success: false, error: "rescan_interval_hours must be 1–168" }, { status: 400 })
      }
    }

    const monitorId = await createMonitor({
      name: name.trim(),
      domains: domains.map((d: string) => d.trim().toLowerCase()),
      match_mode,
      webhook_ids: webhook_ids || [],
      created_by: user ? parseInt(user.userId) : undefined,
      rescan_mode: rescan_mode ?? 'dedup',
      rescan_interval_hours: rescan_interval_hours ? parseInt(String(rescan_interval_hours)) : 24,
    })

    return NextResponse.json({
      success: true,
      data: { id: monitorId },
      message: "Monitor created successfully",
    })
  } catch (error) {
    console.error("Error creating monitor:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create monitor" },
      { status: 500 }
    )
  }
}
