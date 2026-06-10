/**
 * GET /api/monitoring/mutations
 *
 * Surfaces system.mutations for the ulp database — used to verify that the
 * background MATERIALIZE COLUMN / MATERIALIZE INDEX mutations triggered by
 * lib/clickhouse-migrations.ts (DDL v1-v8, including the idx_inv_url /
 * idx_inv_email / idx_inv_password inverted text indexes) have completed,
 * and to detect stuck mutations that need manual intervention.
 *
 * A mutation still running more than an hour after creation with no
 * progress is almost always stuck (orphaned part, race with a DROP INDEX,
 * etc.) — see system.mutations docs. Stuck mutations can be cleared with:
 *   KILL MUTATION WHERE mutation_id = '<mutation_id>'
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

  try {
    const mutations = await executeQuery(`
      SELECT
        table,
        mutation_id,
        command,
        create_time,
        is_done,
        parts_to_do,
        latest_fail_reason,
        latest_fail_time,
        (is_done = 0 AND create_time < now() - INTERVAL 1 HOUR) AS is_stuck
      FROM system.mutations
      WHERE database = currentDatabase()
      ORDER BY create_time DESC
      LIMIT 50
      SETTINGS
        max_execution_time = 15,
        use_query_cache    = 0
    `) as Array<{
      table: string
      mutation_id: string
      command: string
      create_time: string
      is_done: number | string
      parts_to_do: number | string
      latest_fail_reason: string
      latest_fail_time: string
      is_stuck: number | string
    }>

    const pending = mutations.filter(m => Number(m.is_done) === 0)
    const failed = mutations.filter(m => m.latest_fail_reason)
    const stuck = mutations.filter(m => Number(m.is_stuck) === 1)

    return NextResponse.json({
      success: true,
      healthy: stuck.length === 0 && failed.length === 0,
      total: mutations.length,
      pending: pending.length,
      failed: failed.length,
      stuck: stuck.length,
      mutations: mutations.map(m => ({
        table: m.table,
        mutation_id: m.mutation_id,
        command: m.command.length > 200 ? m.command.slice(0, 200) + '…' : m.command,
        create_time: m.create_time,
        is_done: Number(m.is_done) === 1,
        is_stuck: Number(m.is_stuck) === 1,
        parts_to_do: Number(m.parts_to_do),
        latest_fail_reason: m.latest_fail_reason || null,
        latest_fail_time: m.latest_fail_time || null,
      })),
    })
  } catch (error) {
    const msg = String(error)
    if (msg.includes('UNKNOWN_TABLE') || msg.includes('no element in empty container')) {
      return NextResponse.json({
        success: true,
        healthy: true,
        total: 0,
        pending: 0,
        failed: 0,
        stuck: 0,
        mutations: [],
        note: 'system.mutations is empty or not yet populated',
      })
    }
    console.error('[mutations] monitoring error:', msg.substring(0, 200))
    return NextResponse.json({ success: false, error: 'Failed to query system.mutations' }, { status: 500 })
  }
}
