/**
 * GET /api/monitoring/slow-queries
 *
 * Surfaces slow and failed queries from system.query_log for the last N
 * minutes (default 60) — the first place to look when investigating search
 * latency regressions or MEMORY_LIMIT_EXCEEDED errors.
 *
 * Query params:
 *   minutes      — lookback window, default 60, max 1440 (24h)
 *   threshold_ms — minimum query_duration_ms to include, default 200
 *                  (matches query_cache_min_query_duration in
 *                  ulp-profiles.xml — anything faster isn't worth surfacing)
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

  const url = new URL(request.url)
  const minutes = Math.min(1440, Math.max(1, parseInt(url.searchParams.get('minutes') || '60', 10)))
  const thresholdMs = Math.max(0, parseInt(url.searchParams.get('threshold_ms') || '200', 10))

  try {
    const queries = await executeQuery(`
      SELECT
        event_time,
        type,
        query_duration_ms,
        memory_usage,
        read_rows,
        read_bytes,
        exception,
        left(query, 200) AS query_preview
      FROM system.query_log
      WHERE event_time >= now() - INTERVAL {m:UInt32} MINUTE
        AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
        AND is_initial_query = 1
        AND (query_duration_ms >= {threshold:UInt32} OR exception != '')
        AND query NOT LIKE '%system.query_log%'
        AND query NOT LIKE '%system.mutations%'
        AND query NOT LIKE '%asynchronous_insert_log%'
      ORDER BY event_time DESC
      LIMIT 50
      SETTINGS
        max_execution_time = 15,
        use_query_cache    = 0
    `, { m: minutes, threshold: thresholdMs }) as Array<{
      event_time: string
      type: string
      query_duration_ms: number | string
      memory_usage: number | string
      read_rows: number | string
      read_bytes: number | string
      exception: string
      query_preview: string
    }>

    return NextResponse.json({
      success: true,
      window_minutes: minutes,
      threshold_ms: thresholdMs,
      count: queries.length,
      queries: queries.map(q => ({
        event_time: q.event_time,
        type: q.type,
        duration_ms: Number(q.query_duration_ms),
        memory_bytes: Number(q.memory_usage),
        read_rows: Number(q.read_rows),
        read_bytes: Number(q.read_bytes),
        exception: q.exception || null,
        query_preview: q.query_preview,
      })),
    })
  } catch (error) {
    const msg = String(error)
    if (msg.includes('UNKNOWN_TABLE') || msg.includes('no element in empty container')) {
      return NextResponse.json({
        success: true,
        window_minutes: minutes,
        threshold_ms: thresholdMs,
        count: 0,
        queries: [],
        note: 'system.query_log is empty or not yet populated',
      })
    }
    console.error('[slow-queries] monitoring error:', msg.substring(0, 200))
    return NextResponse.json({ success: false, error: 'Failed to query system.query_log' }, { status: 500 })
  }
}
