/**
 * GET /api/monitoring/async-inserts
 *
 * Returns a diagnostic snapshot of ClickHouse asynchronous insert health for
 * the last N minutes (default 60).  Queries system.asynchronous_insert_log
 * which ClickHouse updates after every buffer flush.
 *
 * Status values in the log:
 *   Ok           (0) — rows flushed successfully
 *   ParsingError (1) — row values could not be validated against the target schema
 *   FlushError   (2) — flush failed (disk full, Too many parts, etc.)
 *
 * Auth: admin role required (system table access).
 */

import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { executeQuery } from '@/lib/clickhouse'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const minutes = Math.min(
    1440,
    Math.max(1, parseInt(new URL(request.url).searchParams.get('minutes') || '60', 10))
  )

  try {
    // ── Failure summary: any non-Ok status in the last N minutes ────────────
    const failures = await executeQuery(`
      SELECT
        status,
        exception,
        count()            AS occurrences,
        max(event_time)    AS last_seen,
        any(query_id)      AS sample_query_id,
        any(table)         AS table
      FROM system.asynchronous_insert_log
      WHERE event_time >= now() - INTERVAL {m:UInt32} MINUTE
        AND status != 'Ok'
      GROUP BY status, exception, table
      ORDER BY last_seen DESC
      LIMIT 50
      SETTINGS
        max_execution_time = 15,
        use_query_cache    = 0
    `, { m: minutes }) as Array<{
      status: string
      exception: string
      occurrences: number | string
      last_seen: string
      sample_query_id: string
      table: string
    }>

    // ── Throughput summary: flush count + total rows in the last N minutes ──
    const throughput = await executeQuery(`
      SELECT
        table,
        countIf(status = 'Ok')              AS flushes_ok,
        countIf(status != 'Ok')             AS flushes_failed,
        sumIf(rows, status = 'Ok')          AS rows_inserted,
        max(event_time)                     AS last_flush,
        avg(flush_time_microseconds) / 1000 AS avg_flush_ms
      FROM system.asynchronous_insert_log
      WHERE event_time >= now() - INTERVAL {m:UInt32} MINUTE
      GROUP BY table
      ORDER BY rows_inserted DESC
      LIMIT 20
      SETTINGS
        max_execution_time = 15,
        use_query_cache    = 0
    `, { m: minutes }) as Array<{
      table: string
      flushes_ok: number | string
      flushes_failed: number | string
      rows_inserted: number | string
      last_flush: string
      avg_flush_ms: number | string
    }>

    return NextResponse.json({
      success: true,
      window_minutes: minutes,
      healthy: failures.length === 0,
      failures: failures.map(r => ({
        status: r.status,
        exception: r.exception,
        occurrences: Number(r.occurrences),
        last_seen: r.last_seen,
        sample_query_id: r.sample_query_id,
        table: r.table,
      })),
      throughput: throughput.map(r => ({
        table: r.table,
        flushes_ok: Number(r.flushes_ok),
        flushes_failed: Number(r.flushes_failed),
        rows_inserted: Number(r.rows_inserted),
        last_flush: r.last_flush,
        avg_flush_ms: Math.round(Number(r.avg_flush_ms) * 10) / 10,
      })),
    })
  } catch (error) {
    // system.asynchronous_insert_log may be empty on a fresh install or if
    // async_insert was just enabled — treat as healthy (no errors means no log).
    const msg = String(error)
    if (msg.includes('UNKNOWN_TABLE') || msg.includes('no element in empty container')) {
      return NextResponse.json({
        success: true,
        window_minutes: minutes,
        healthy: true,
        failures: [],
        throughput: [],
        note: 'system.asynchronous_insert_log is empty or not yet populated',
      })
    }
    console.error('[async-inserts] monitoring error:', msg.substring(0, 200))
    return NextResponse.json({ success: false, error: 'Failed to query async insert log' }, { status: 500 })
  }
}
