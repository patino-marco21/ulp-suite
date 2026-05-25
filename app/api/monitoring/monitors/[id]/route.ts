import { NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import { getMonitor, updateMonitor, deleteMonitor } from "@/lib/domain-monitor"

export const dynamic = 'force-dynamic'

/**
 * GET /api/monitoring/monitors/[id]
 * Get a specific monitor by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { id } = await params
    const monitorId = parseInt(id)
    if (isNaN(monitorId)) {
      return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
    }

    const monitor = await getMonitor(monitorId)
    if (!monitor) {
      return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
    }

    return NextResponse.json({ success: true, data: monitor })
  } catch (error) {
    console.error("Error getting monitor:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to get monitor" },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/monitoring/monitors/[id]
 * Update a monitor
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  try {
    const { id } = await params
    const monitorId = parseInt(id)
    if (isNaN(monitorId)) {
      return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
    }

    const existing = await getMonitor(monitorId)
    if (!existing) {
      return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
    }

    const body = await request.json()
    const updates: any = {}

    if (body.name !== undefined) updates.name = body.name.trim()
    if (body.domains !== undefined) {
      if (!Array.isArray(body.domains) || body.domains.length === 0) {
        return NextResponse.json(
          { success: false, error: "At least one domain is required" },
          { status: 400 }
        )
      }
      updates.domains = body.domains.map((d: string) => d.trim().toLowerCase())
    }
    if (body.match_mode !== undefined) {
      if (!["credential", "url", "both"].includes(body.match_mode)) {
        return NextResponse.json(
          { success: false, error: "match_mode must be 'credential', 'url', or 'both'" },
          { status: 400 }
        )
      }
      updates.match_mode = body.match_mode
    }
    if (body.is_active !== undefined) updates.is_active = body.is_active
    if (body.webhook_ids !== undefined) updates.webhook_ids = body.webhook_ids
    if (body.rescan_mode !== undefined) {
      if (!['dedup', 'digest'].includes(body.rescan_mode)) {
        return NextResponse.json({ success: false, error: "rescan_mode must be 'dedup' or 'digest'" }, { status: 400 })
      }
      updates.rescan_mode = body.rescan_mode
    }
    if (body.rescan_interval_hours !== undefined) {
      const h = parseInt(String(body.rescan_interval_hours))
      if (isNaN(h) || h < 1 || h > 168) {
        return NextResponse.json({ success: false, error: "rescan_interval_hours must be 1–168" }, { status: 400 })
      }
      updates.rescan_interval_hours = h
    }

    await updateMonitor(monitorId, updates)

    return NextResponse.json({
      success: true,
      message: "Monitor updated successfully",
    })
  } catch (error) {
    console.error("Error updating monitor:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to update monitor" },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/monitoring/monitors/[id]
 * Delete a monitor
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  try {
    const { id } = await params
    const monitorId = parseInt(id)
    if (isNaN(monitorId)) {
      return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
    }

    const existing = await getMonitor(monitorId)
    if (!existing) {
      return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
    }

    await deleteMonitor(monitorId)

    return NextResponse.json({
      success: true,
      message: "Monitor deleted successfully",
    })
  } catch (error) {
    console.error("Error deleting monitor:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to delete monitor" },
      { status: 500 }
    )
  }
}
