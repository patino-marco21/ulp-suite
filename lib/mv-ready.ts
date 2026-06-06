/**
 * isMvReady — checks whether a ClickHouse MV backing table has been populated.
 *
 * Returns true once the table contains at least one row, then caches that result
 * for TTL_MS (5 minutes) so every subsequent call in the same process is free
 * (a plain boolean read — no ClickHouse round-trip).
 *
 * Cache is invalidated automatically by TTL. The rebuild-mv admin endpoint
 * resets `ch_mv_backfill_fired` in SQLite; the 5-min TTL means routes will
 * fall back to full-scan queries for up to 5 minutes during a rebuild, then
 * switch back to MV queries once the table is re-populated.
 *
 * Returns false on any ClickHouse error (conservative — caller falls back to
 * full-scan rather than serving an error).
 *
 * @param key   Short cache key, e.g. 'domain'. Must be unique per table across all callers.
 * @param table ClickHouse table name, e.g. 'ulp.domain_counts'.
 *              MUST be a hard-coded string literal at every call site.
 *              Never pass a value derived from user input — no quoting or validation is done.
 */
import { executeQuery } from './clickhouse'

interface CacheEntry {
  value: boolean
  checkedAt: number
}

const cache: Record<string, CacheEntry> = {}
const TTL_MS = 5 * 60 * 1000   // 5 minutes

export async function isMvReady(key: string, table: string): Promise<boolean> {
  const hit = cache[key]
  if (hit && Date.now() - hit.checkedAt < TTL_MS) return hit.value

  try {
    const rows = await executeQuery(
      `SELECT 1 AS n FROM ${table} LIMIT 1 SETTINGS max_execution_time = 5`
    ) as Array<{ n: number }>
    const ready = rows.length > 0
    cache[key] = { value: ready, checkedAt: Date.now() }
    return ready
  } catch {
    // Conservative: cache false for the full TTL to avoid retry storms on a struggling server.
    // Use invalidateMvCache(key) or wait for TTL to expire for the next probe to retry.
    cache[key] = { value: false, checkedAt: Date.now() }
    return false
  }
}

/** Force-invalidate a single cache entry (used by rebuild-mv endpoint). */
export function invalidateMvCache(key: string): void {
  delete cache[key]
}

/** Invalidate all MV cache entries. */
export function invalidateAllMvCaches(): void {
  for (const key of Object.keys(cache)) delete cache[key]
}
