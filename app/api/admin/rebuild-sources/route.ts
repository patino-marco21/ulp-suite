/**
 * POST /api/admin/rebuild-sources
 *
 * Reconstructs ulp.sources from ulp.credentials.
 *
 * Use when the sources table is empty or corrupted (e.g. an ALTER TABLE DELETE
 * with a self-referencing subquery wiped it).  The credentials data is always
 * the source of truth; sources is derived metadata.
 *
 * The GROUP BY source_file with ~100-200 unique values is very cheap even on
 * 1B+ row tables — ClickHouse only needs 100-200 aggregation states in memory.
 *
 * Auth: admin role required.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { getClient } from '@/lib/clickhouse'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const client = getClient()

  // Count existing source rows first
  let rowsBefore = 0
  try {
    const res = await client.query({ query: 'SELECT count() AS n FROM ulp.sources', format: 'JSONEachRow' })
    const rows: Array<{ n: string }> = await res.json()
    rowsBefore = Number(rows[0]?.n ?? 0)
  } catch { /* non-fatal */ }

  // Truncate and rebuild from credentials.
  // TRUNCATE is instant; the INSERT SELECT aggregates by source_file which
  // typically has <200 unique values — safe even at 1B+ credential rows.
  try {
    await client.exec({ query: 'TRUNCATE TABLE ulp.sources' })
    await client.exec({
      query: `INSERT INTO ulp.sources (filename, line_count)
              SELECT source_file, count()
              FROM ulp.credentials
              GROUP BY source_file
              SETTINGS max_bytes_before_external_group_by = 4294967296,
                       max_execution_time = 600`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[rebuild-sources] error:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }

  // Count rebuilt rows
  let rowsAfter = 0
  try {
    const res = await client.query({ query: 'SELECT count() AS n FROM ulp.sources', format: 'JSONEachRow' })
    const rows: Array<{ n: string }> = await res.json()
    rowsAfter = Number(rows[0]?.n ?? 0)
  } catch { /* non-fatal */ }

  return NextResponse.json({
    success:       true,
    rows_before:   rowsBefore,
    rows_after:    rowsAfter,
    message:       `Rebuilt ${rowsAfter} source records from credentials table.`,
  })
}
