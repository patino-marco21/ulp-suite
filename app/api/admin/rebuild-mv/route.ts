/**
 * POST /api/admin/rebuild-mv
 *
 * Truncates the four MV backing tables, resets the ch_mv_backfill_fired SQLite
 * gate, and re-fires the sequential backfill chain as a fire-and-forget IIFE.
 *
 * Use when:
 *   - Initial backfill failed mid-way (check server logs for [MV backfill] entries)
 *   - ulp.credentials was bulk-modified (ALTER TABLE UPDATE mutations that
 *     changed domain / password / url_host / email values at scale)
 *   - MV tables show incorrect counts
 *
 * The endpoint returns immediately after kicking off the backfill; poll
 * GET /api/stats?bust=1 to see when MV data appears in the dashboard.
 *
 * Auth: admin role required.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { getClient } from '@/lib/clickhouse'
import { dbRun } from '@/lib/sqlite'
import { invalidateAllMvCaches } from '@/lib/mv-ready'

export const dynamic = 'force-dynamic'

const MV_TABLES = [
  'ulp.domain_counts',
  'ulp.password_counts',
  'ulp.url_host_counts',
  'ulp.reuse_pairs',
] as const

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const client = getClient()

  // 1. Truncate all four MV tables
  const truncateErrors: string[] = []
  for (const table of MV_TABLES) {
    try {
      await client.exec({ query: `TRUNCATE TABLE ${table}` })
    } catch (err) {
      truncateErrors.push(`${table}: ${String(err).substring(0, 80)}`)
    }
  }

  if (truncateErrors.length > 0) {
    console.error('[rebuild-mv] TRUNCATE errors:', truncateErrors)
    // Invalidate cache so routes immediately fall back to full-scan for any
    // tables that were truncated (rather than serving empty MV results).
    invalidateAllMvCaches()
    return NextResponse.json({
      success: false,
      error: 'Failed to truncate one or more MV tables',
      details: truncateErrors,
    }, { status: 500 })
  }

  // 2. Reset SQLite gate so the backfill chain fires again on next startup
  //    (and so this endpoint's own backfill IIFE below can run)
  try {
    dbRun(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`,
      ['ch_mv_backfill_fired', '0'])
  } catch (err) {
    console.error('[rebuild-mv] SQLite gate reset error:', err)
  }

  // 3. Invalidate in-process isMvReady cache so routes immediately fall back
  //    to full-scan queries (rather than serving stale true from the 5-min TTL)
  invalidateAllMvCaches()

  // 4. Re-fire sequential backfill chain (fire-and-forget)
  // Set gate to '1' BEFORE firing the IIFE so a server restart during backfill
  // does not trigger a second parallel backfill from runClickHouseMigrations.
  try {
    dbRun(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`,
      ['ch_mv_backfill_fired', '1'])
  } catch (err) {
    console.error('[rebuild-mv] SQLite gate set error:', err)
  }
  console.log('[rebuild-mv] re-firing sequential MV backfill')
  ;(async () => {
    try {
      await client.exec({
        query: `INSERT INTO ulp.domain_counts
                SELECT domain, count() AS count
                FROM ulp.credentials
                WHERE domain != ''
                GROUP BY domain
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[rebuild-mv backfill] domain_counts done')

      await client.exec({
        query: `INSERT INTO ulp.password_counts
                SELECT password, count() AS count
                FROM ulp.credentials
                WHERE password != ''
                GROUP BY password
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[rebuild-mv backfill] password_counts done')

      await client.exec({
        query: `INSERT INTO ulp.url_host_counts
                SELECT if(url_host != '', url_host, domain) AS url_host, count() AS count
                FROM ulp.credentials
                WHERE (url_host != '' OR domain != '')
                GROUP BY url_host
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[rebuild-mv backfill] url_host_counts done')

      await client.exec({
        query: `INSERT INTO ulp.reuse_pairs
                SELECT email, password, uniqState(domain) AS domain_hll
                FROM ulp.credentials
                WHERE login_type = 'email' AND length(password) > 0
                GROUP BY email, password
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[rebuild-mv backfill] reuse_pairs done — rebuild complete')
    } catch (err) {
      console.error('[rebuild-mv backfill] Error:', String(err).substring(0, 300))
    }
  })()

  return NextResponse.json({
    success: true,
    truncated: MV_TABLES,
    message: 'MV tables truncated and backfill re-started (fire-and-forget). Poll GET /api/stats?bust=1 to see progress.',
  })
}
