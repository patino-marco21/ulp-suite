/**
 * POST /api/admin/dedup
 *
 * One-time (or scheduled) deduplication of the ulp.credentials table.
 *
 * Runs:
 *   OPTIMIZE TABLE ulp.credentials FINAL DEDUPLICATE BY url, email, password
 *
 * This forces ClickHouse to merge ALL parts in every partition into one and
 * then discard rows where (url, email, password) are identical, keeping the
 * first occurrence (lowest imported_at within the merged part).
 *
 * Performance note:
 *   - "FINAL" forces a full merge — expensive on large tables.
 *   - For 3–20 M rows expect 30 s–5 min depending on disk and CPU.
 *   - For very large tables (100 M+) prefer partition-by-partition:
 *       OPTIMIZE TABLE ulp.credentials PARTITION '202401' FINAL DEDUPLICATE BY url, email, password
 *   - The request returns immediately after submitting the mutation.
 *     ClickHouse runs the actual merge asynchronously — poll /api/stats or
 *     check system.merges to track progress.
 *
 * Prevention note:
 *   The ULP parser already deduplicates within each uploaded file using an
 *   in-memory Set.  This endpoint cleans up cross-upload duplicates (the same
 *   file uploaded twice) or legacy data imported before the parser-level dedup
 *   was added.
 *
 * Auth: admin role required.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { getClient } from '@/lib/clickhouse'
import { invalidateStatsCache } from '@/lib/stats-cache'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const body = await request.json().catch(() => ({}))
  // Optional: scope to a specific partition (e.g. "202401") to limit blast radius.
  const partition: string | undefined = typeof body.partition === 'string' ? body.partition : undefined

  const client = getClient()

  // Count rows before so we can report how many were removed.
  let rowsBefore = 0
  try {
    const res = await client.query({
      query: 'SELECT count() AS n FROM ulp.credentials',
      format: 'JSONEachRow',
    })
    const rows: Array<{ n: string }> = await res.json()
    rowsBefore = Number(rows[0]?.n ?? 0)
  } catch {
    // Non-fatal — we'll skip the delta report
  }

  // Build OPTIMIZE query.  FINAL forces all parts in each (scoped) partition
  // to merge; DEDUPLICATE BY restricts the dedup key to (url, email, password)
  // so rows differing only in imported_at or breach_name are still removed.
  const optimizeQuery = partition
    ? `OPTIMIZE TABLE ulp.credentials PARTITION '${partition.replace(/'/g, '')}' FINAL DEDUPLICATE BY url, email, password`
    : `OPTIMIZE TABLE ulp.credentials FINAL DEDUPLICATE BY url, email, password`

  try {
    // OPTIMIZE TABLE is synchronous when mutations_sync = 1, but for large tables
    // we use the default async mode and return immediately.
    await client.exec({ query: optimizeQuery })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[dedup] OPTIMIZE error:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }

  // Count rows after
  let rowsAfter = 0
  try {
    const res = await client.query({
      query: 'SELECT count() AS n FROM ulp.credentials',
      format: 'JSONEachRow',
    })
    const rows: Array<{ n: string }> = await res.json()
    rowsAfter = Number(rows[0]?.n ?? 0)
  } catch {
    // Non-fatal
  }

  // Invalidate stats so the dashboard reflects the new count
  if (rowsAfter < rowsBefore) invalidateStatsCache()

  return NextResponse.json({
    success:        true,
    rows_before:    rowsBefore,
    rows_after:     rowsAfter,
    duplicates_removed: rowsBefore - rowsAfter,
    partition:      partition ?? 'all',
    query:          optimizeQuery,
  })
}
