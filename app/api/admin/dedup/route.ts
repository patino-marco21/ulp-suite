/**
 * POST /api/admin/dedup
 *
 * Deduplication of the ulp.credentials table.
 *
 * Table schema: ORDER BY (domain, email, imported_at)
 *               PARTITION BY toYYYYMM(imported_at)
 *
 * DEDUPLICATE BY must include ALL ORDER BY / PRIMARY KEY / PARTITION BY columns.
 * We include them plus url, password, source_file so only truly identical
 * credential rows are removed (not rows that happen to share domain+email+time).
 *
 * Performance:
 *   - FINAL forces a full partition merge — expensive on large tables.
 *   - For 1B+ rows prefer partition-by-partition (pass { "partition": "202405" }).
 *   - Returns immediately; ClickHouse merges asynchronously.
 *     Monitor via system.merges or system.processes.
 *
 * Auth: admin role required.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { getClient } from '@/lib/clickhouse'

export const dynamic = 'force-dynamic'

// Columns used in ORDER BY + PRIMARY KEY + PARTITION BY MUST be included.
// Additional content columns narrow the dedup key so only truly identical
// rows are removed.
const DEDUP_BY = 'domain, email, imported_at, url, password, source_file'

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const body = await request.json().catch(() => ({}))
  const partition: string | undefined = typeof body.partition === 'string' ? body.partition : undefined

  const client = getClient()

  let rowsBefore = 0
  try {
    const res = await client.query({ query: 'SELECT count() AS n FROM ulp.credentials', format: 'JSONEachRow' })
    const rows: Array<{ n: string }> = await res.json()
    rowsBefore = Number(rows[0]?.n ?? 0)
  } catch { /* non-fatal */ }

  const optimizeQuery = partition
    ? `OPTIMIZE TABLE ulp.credentials PARTITION '${partition.replace(/'/g, '')}' FINAL DEDUPLICATE BY ${DEDUP_BY}`
    : `OPTIMIZE TABLE ulp.credentials FINAL DEDUPLICATE BY ${DEDUP_BY}`

  try {
    await client.exec({ query: optimizeQuery })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[dedup] OPTIMIZE error:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }

  let rowsAfter = 0
  try {
    const res = await client.query({ query: 'SELECT count() AS n FROM ulp.credentials', format: 'JSONEachRow' })
    const rows: Array<{ n: string }> = await res.json()
    rowsAfter = Number(rows[0]?.n ?? 0)
  } catch { /* non-fatal */ }

  return NextResponse.json({
    success:            true,
    rows_before:        rowsBefore,
    rows_after:         rowsAfter,
    duplicates_removed: rowsBefore - rowsAfter,
    partition:          partition ?? 'all',
    query:              optimizeQuery,
  })
}
