import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest, isAdmin } from "@/lib/auth"

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
    const [countResult, rows] = await Promise.all([
      executeQuery(
        `SELECT count() AS total FROM (SELECT DISTINCT filename FROM ulp.sources)`
      ),
      // Note: alias 'imported_at' must NOT match the column name or ClickHouse
      // treats argMax(line_count, imported_at) as argMax(line_count, max(imported_at))
      // → nested aggregate error.  Use 'last_imported' to avoid the collision.
      executeQuery(
        `SELECT filename,
                argMax(line_count, imported_at) AS line_count,
                max(imported_at)                AS last_imported
         FROM ulp.sources
         GROUP BY filename
         ORDER BY last_imported DESC
         LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        { limit, offset }
      ),
    ])

    const total = Number(countResult[0]?.total || 0)
    const filenames = (rows as any[]).map(r => String(r.filename))

    // Credential count per source file. Scoped to this page's filenames (≤100)
    // so idx_bf_source_file (bloom filter) can skip granules — an unscoped
    // `GROUP BY source_file` over ulp.credentials reads the whole table and
    // times out past 30s once it's in the billions of rows (Code 159
    // TIMEOUT_EXCEEDED, observed 2026-06-13 after reading 1.1B rows).
    const credCounts = filenames.length
      ? await executeQuery(
          `SELECT source_file, count() AS cred_count
           FROM ulp.credentials
           WHERE source_file IN ({filenames:Array(String)})
           GROUP BY source_file
           SETTINGS max_execution_time = 30`,
          { filenames }
        )
      : []

    // Build a lookup map: source_file → credential count
    const credMap = new Map<string, number>()
    for (const row of credCounts as any[]) {
      credMap.set(String(row.source_file), Number(row.cred_count))
    }

    const sources = (rows as any[]).map(r => ({
      filename:    String(r.filename),
      line_count:  Number(r.line_count),
      imported_at: String(r.last_imported),   // alias is now 'last_imported'
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
    // 1. Delete ALL source rows for this filename (handles duplicates too).
    //    The (filename, imported_at) key may match multiple rows when a file was
    //    double-processed.  Deleting by filename alone removes all of them.
    await executeQuery(
      `ALTER TABLE ulp.sources DELETE WHERE filename = {filename:String}`,
      { filename }
    )

    // 2. Purge the credentials for this source file as well.
    await executeQuery(
      `ALTER TABLE ulp.credentials DELETE WHERE source_file = {source_file:String}`,
      { source_file: filename }
    )

    return NextResponse.json({
      success:             true,
      deleted_source:      true,
      deleted_credentials: true,
      remaining_sources:   0,
    })
  } catch (error) {
    console.error('Source delete error:', error)
    return NextResponse.json({ success: false, error: 'Failed to delete source' }, { status: 500 })
  }
}
