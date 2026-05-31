import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest, isAdmin } from "@/lib/auth"
import { invalidateStatsCache } from "@/lib/stats-cache"

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50')))
  const offset = (page - 1) * limit

  try {
    // Deduplicate sources: ulp.sources is a plain MergeTree with no uniqueness
    // constraint.  If a file was processed twice (e.g. container OOM mid-rename),
    // it appears twice.  argMax picks the most-recent row per filename so the
    // count and UI show each file exactly once.
    const [countResult, rows, credCounts] = await Promise.all([
      executeQuery(
        `SELECT count() AS total FROM (SELECT DISTINCT filename FROM ulp.sources)`
      ),
      executeQuery(
        `SELECT filename,
                argMax(line_count,  imported_at) AS line_count,
                max(imported_at)                 AS imported_at
         FROM ulp.sources
         GROUP BY filename
         ORDER BY max(imported_at) DESC
         LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        { limit, offset }
      ),
      // Credential count per source file — fast because source_file is in ORDER BY
      executeQuery(
        `SELECT source_file, count() AS cred_count
         FROM ulp.credentials
         GROUP BY source_file
         SETTINGS max_execution_time = 30`
      ),
    ])

    const total = Number(countResult[0]?.total || 0)

    // Build a lookup map: source_file → credential count
    const credMap = new Map<string, number>()
    for (const row of credCounts as any[]) {
      credMap.set(String(row.source_file), Number(row.cred_count))
    }

    const sources = (rows as any[]).map(r => ({
      filename:    String(r.filename),
      line_count:  Number(r.line_count),
      imported_at: String(r.imported_at),
      cred_count:  credMap.get(String(r.filename)) ?? 0,
    }))

    return NextResponse.json({
      success: true,
      sources,
      total,
      page,
      pages: Math.ceil(total / limit),
    })
  } catch (error) {
    console.error('Sources error:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch sources' }, { status: 500 })
  }
}

/** DELETE /api/sources?filename=…&imported_at=…
 *  Admin-only. Removes the specific source record.
 *  If it was the last (or only) import of that filename, credentials
 *  for that source_file are also queued for deletion.
 *  If other imports of the same filename still exist, credentials are
 *  left intact (shared across imports).
 */
export async function DELETE(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  if (!isAdmin(user)) {
    return NextResponse.json({ success: false, error: "Admin access required" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const filename   = searchParams.get('filename')
  const importedAt = searchParams.get('imported_at')

  if (!filename || !importedAt) {
    return NextResponse.json(
      { success: false, error: "filename and imported_at are required" },
      { status: 400 }
    )
  }

  try {
    // 1. Delete the specific source record
    await executeQuery(
      `ALTER TABLE ulp.sources DELETE
       WHERE filename = {filename:String} AND imported_at = {imported_at:DateTime}`,
      { filename, imported_at: importedAt }
    )

    // 2. Count remaining source entries for this filename
    const remaining = await executeQuery(
      `SELECT count() AS c FROM ulp.sources WHERE filename = {filename:String}`,
      { filename }
    )
    const remainingCount = Number((remaining as any[])[0]?.c ?? 0)

    let deletedCredentials = false
    if (remainingCount === 0) {
      // Last import of this file — also purge its credentials
      await executeQuery(
        `ALTER TABLE ulp.credentials DELETE WHERE source_file = {source_file:String}`,
        { source_file: filename }
      )
      deletedCredentials = true
      invalidateStatsCache()
    }

    return NextResponse.json({
      success: true,
      deleted_source:      true,
      deleted_credentials: deletedCredentials,
      remaining_sources:   remainingCount,
    })
  } catch (error) {
    console.error('Source delete error:', error)
    return NextResponse.json({ success: false, error: 'Failed to delete source' }, { status: 500 })
  }
}
