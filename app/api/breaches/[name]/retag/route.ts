import { type NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import { dbGet } from "@/lib/sqlite"
import { assignBreachToSource } from "@/lib/breach-matcher"
import { getClient } from "@/lib/clickhouse"

export const dynamic = 'force-dynamic'

// POST /api/breaches/[name]/retag
// Body: { source_files: string[] }
//
// Assigns the breach tag to all listed source files in ClickHouse via an async
// mutation (ALTER TABLE ... UPDATE). Also updates source_breach_map so future
// uploads of the same filename auto-tag correctly.
//
// ClickHouse mutations are asynchronous — the endpoint returns immediately and
// the mutation runs in the background. Use system.mutations to track progress.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const { name } = await params
  const breachName = decodeURIComponent(name)
  const breach = dbGet(`SELECT id FROM breaches WHERE breach_name = ?`, [breachName])
  if (!breach) return NextResponse.json({ success: false, error: "Breach not found" }, { status: 404 })

  const { source_files } = await request.json()
  if (!Array.isArray(source_files) || source_files.length === 0) {
    return NextResponse.json({ success: false, error: 'source_files array is required' }, { status: 400 })
  }

  const client = getClient()
  const mutations: string[] = []

  for (const sf of source_files) {
    if (typeof sf !== 'string' || !sf.trim()) continue

    // Update source_breach_map (SQLite) for future uploads
    assignBreachToSource(sf.trim(), breachName)

    // Fire ClickHouse mutation to re-tag historical credentials
    try {
      await client.exec({
        query: `ALTER TABLE ulp.credentials
                UPDATE breach_name = {bn:String}
                WHERE source_file = {sf:String}`,
        query_params: { bn: breachName, sf: sf.trim() },
      })
      mutations.push(sf.trim())
    } catch (err) {
      console.error(`Retag mutation failed for ${sf}:`, err)
    }
  }

  return NextResponse.json({
    success: true,
    breach_name: breachName,
    mutations_fired: mutations.length,
    source_files: mutations,
    note: 'ClickHouse mutations are asynchronous — credentials will be updated in the background.',
  })
}
