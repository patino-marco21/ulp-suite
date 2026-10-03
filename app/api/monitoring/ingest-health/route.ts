import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { executeQuery } from '@/lib/clickhouse'
import { getIngestMetrics } from '@/lib/ingest-metrics'
import { diskBudgetBytes, buildLiveBytesSql, diskBudgetPct } from '@/lib/disk-budget'
import { readDisk } from '@/lib/disk-watch'
import { readBackupStatus } from '@/lib/backup-status'
import { getSearchDictionaryStatus } from '@/lib/search-dictionary'

export const dynamic = 'force-dynamic'

// ulp.credentials parts_to_throw_insert (docker/clickhouse/init/01-ulp-tables.sql)
const PARTS_THRESHOLD = 1000

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  let clickhouse: {
    activeParts: number; partsThreshold: number; activeMerges: number
    memoryBytes: number; note?: string
  } = { activeParts: 0, partsThreshold: PARTS_THRESHOLD, activeMerges: 0, memoryBytes: 0 }

  let diskBudget: { usedBytes: number; budgetBytes: number; pct: number; note?: string } =
    { usedBytes: 0, budgetBytes: diskBudgetBytes(), pct: 0 }

  try {
    const [parts, merges, mem, disk] = [
      await executeQuery(
        `SELECT count() AS c FROM system.parts
         WHERE database = 'ulp' AND table = 'credentials' AND active
         SETTINGS max_execution_time = 15, use_query_cache = 0`,
      ) as Array<{ c: number | string }>,
      await executeQuery(
        `SELECT count() AS c FROM system.merges
         WHERE database = 'ulp'
         SETTINGS max_execution_time = 15, use_query_cache = 0`,
      ) as Array<{ c: number | string }>,
      await executeQuery(
        `SELECT value AS v FROM system.metrics
         WHERE metric = 'MemoryTracking'
         SETTINGS max_execution_time = 15, use_query_cache = 0`,
      ) as Array<{ v: number | string }>,
      await executeQuery(buildLiveBytesSql()) as Array<{ bytes: number | string | null }>,
    ]
    clickhouse = {
      activeParts:    Number(parts[0]?.c ?? 0),
      partsThreshold: PARTS_THRESHOLD,
      activeMerges:   Number(merges[0]?.c ?? 0),
      memoryBytes:    Number(mem[0]?.v ?? 0),
    }
    const usedBytes = Number(disk[0]?.bytes ?? 0)
    diskBudget = { usedBytes, budgetBytes: diskBudgetBytes(), pct: diskBudgetPct(usedBytes, diskBudgetBytes()) }
  } catch (error) {
    const msg = String(error)
    const note = msg.includes('UNKNOWN_TABLE')
      ? 'ClickHouse system tables unavailable'
      : 'failed to read ClickHouse metrics'
    clickhouse.note = note
    diskBudget.note = note
  }

  // Free space on the ClickHouse data disk (the number the dedup/projection guard and the passive
  // watcher in lib/disk-watch.ts act on) -- diskBudget above is the table's own size against its budget.
  const disk = await readDisk()

  // The derived tables behind the fast domain search (lib/search-dictionary.ts). Never throws: 'unknown' when ClickHouse cannot say.
  const dict = await getSearchDictionaryStatus()
  const searchDictionary = {
    state: dict.state, builtAt: dict.builtAt, pairRows: dict.pairRows, emailRows: dict.emailRows, bytes: dict.bytes,
    lastError: dict.lastError, lastBuildMs: dict.lastBuildMs,
  }

  return NextResponse.json({ app: getIngestMetrics(), clickhouse, diskBudget, disk, backup: readBackupStatus(), searchDictionary })
}
