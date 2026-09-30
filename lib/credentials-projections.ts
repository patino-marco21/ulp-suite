/**
 * ulp.credentials' PROJECTIONs, as they relate to content-dedup's rewrite+swap:
 * stripping them from the cloned CREATE TABLE so the build stays small, and
 * restoring the one that matters on the live table once the swap is done.
 *
 * WHY (measured live 2026-09-30): projections are 64% of ulp.credentials'
 * 381.20 GiB -- proj_imported_desc 157.55 GiB + proj_domain_reversed 85.21 GiB,
 * against 82.33 GiB of column data and 56.10 GiB of skip indexes. Building the
 * deduped copy with them in place cost ~18 GiB per populate bucket (x16 buckets
 * = ~288 GiB) against ~252 GiB of usable headroom above the disk guard's floor,
 * so the real cutover tripped the guard repeatedly. A projection is a derived,
 * redundant copy of columns the base table already holds, so a table built
 * without one and materialized afterwards loses no data -- only query speed
 * until MATERIALIZE finishes (parts without it fall back to the pre-projection
 * scan, no error -- see DDL v14's comment in lib/clickhouse-migrations.ts).
 *
 * WHICH ONE: only proj_imported_desc is restored, and only for partitions
 * inside lib/projection-scope.ts's recency window (that cron clears it from
 * older partitions daily, so materializing them here would be wasted work).
 * proj_domain_reversed is deliberately NOT restored -- it is an orphan:
 *   - No migration defines it. DDL v19 replaced the reverse(domain) projection
 *     with idx_ngram_domain (see that version's comment), so a fresh install
 *     never has it; only this instance does, left over from an abandoned
 *     2026-08-25 experiment.
 *   - It is counterproductive. Confirmed live 2026-09-30: the domain monitor's
 *     `SELECT DISTINCT email_domain ... LIMIT 1001` (max_execution_time = 90)
 *     makes the planner pick it as a thin covering copy and scan all 2.78B of
 *     its rows -- 41s / 21.12 GiB (76s in the app's own run) -- where the base
 *     table's ngram skip index prunes to 404M rows: 7s / 3.39 GiB, with an
 *     identical result set (same row count and value hash).
 * Letting it fall away with the swap therefore retires it. If it is ever wanted
 * back: ADD PROJECTION ... ORDER BY reverse(domain), then MATERIALIZE.
 */
import type { ClickHouseClient } from '@clickhouse/client'
import type { DiskGuard } from '@/lib/clickhouse-disk-guard'
import { PROJECTION_NAME, cutoffPartition, projectionScopeWindowMonths } from '@/lib/projection-scope'

/**
 * proj_imported_desc's definition -- the text between the parentheses of ADD
 * PROJECTION. Shared by DDL v14 and restoreImportedDescProjection (same
 * pattern as lib/search-index-definitions.ts), so the migration that first
 * created it and the restore that re-creates it after every swap cannot drift
 * apart. A projection's ORDER BY can't use DESC, so negate(toUnixTimestamp(
 * imported_at)) stands in for "imported_at DESC" -- see DDL v14's comment.
 */
export const IMPORTED_DESC_PROJECTION_BODY = `SELECT url, email, password, source_file, breach_name, country_tier, login_type,
               password_length, password_mask, url_scheme, is_corporate_email, email_domain,
               url_host, password_entropy_band, imported_at, domain
        ORDER BY negate(toUnixTimestamp(imported_at)), domain, email, url, password`

/**
 * Removes every PROJECTION definition from a `SHOW CREATE TABLE` result, so the
 * clone content-dedup builds carries the base table and its skip indexes but no
 * projections (see the file comment). Pure -- runContentDedupTick fetches the
 * DDL live. Line-based: ClickHouse prints each projection as
 * `    PROJECTION <name>` / `    (` / body / `    )` (trailing comma unless it
 * is the last entry), which is what the live 26.3 output showed 2026-09-30.
 *
 * Throws if a PROJECTION is still present afterwards -- defense in depth, same
 * rationale as rewriteCreateTableDdl's check: a future ClickHouse that prints
 * projections differently must fail loudly here, not silently return DDL that
 * rebuilds the full-size table this exists to avoid.
 */
export function stripProjectionsFromCreateTableDdl(showCreateSql: string): string {
  const kept: string[] = []
  let inProjection = false
  let removedAny = false
  for (const line of showCreateSql.split('\n')) {
    if (inProjection) {
      // The body is indented deeper; the projection's own closing paren is the
      // first line at exactly the projection's indent level.
      if (/^ {4}\),?$/.test(line)) inProjection = false
      continue
    }
    if (/^ {4}PROJECTION \S+$/.test(line)) {
      inProjection = true
      removedAny = true
      continue
    }
    kept.push(line)
  }
  if (removedAny) {
    // Projections are the last entries in the definition list, so removing them
    // can leave the entry before them ending in a comma -- invalid right
    // before the closing paren.
    const closeIdx = kept.indexOf(')')
    if (closeIdx > 0) kept[closeIdx - 1] = kept[closeIdx - 1].replace(/,$/, '')
  }
  const result = kept.join('\n')
  if (/\bPROJECTION\b/.test(result)) {
    throw new Error('[credentials-projections] stripProjectionsFromCreateTableDdl failed to remove every PROJECTION -- refusing to return DDL that still carries them.')
  }
  return result
}

/** Metadata-only and idempotent: new inserts get the projection immediately, existing parts need MATERIALIZE. */
export function buildAddImportedDescProjectionSql(): string {
  return `ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS ${PROJECTION_NAME} (${IMPORTED_DESC_PROJECTION_BODY})`
}

/**
 * Partitions that keep the projection -- the complement of lib/projection-scope.ts's
 * buildEligiblePartitionsSql. Newest first: that is the data "browse newest first"
 * reads, so it gets the speedup soonest, and newer partitions are usually the
 * smaller ones, which keeps the disk guard's linear projection (average growth so
 * far x iterations remaining) from over-projecting after one big partition.
 */
export function buildRecentPartitionsSql(cutoff: string): string {
  return `SELECT DISTINCT partition FROM system.parts
    WHERE database = 'ulp' AND table = 'credentials' AND active
      AND partition >= '${cutoff}'
    ORDER BY partition DESC`
}

/**
 * One partition at a time, blocking until that partition's projection is built
 * (same pattern as scripts/add-imported-desc-projection.sh). max_execution_time
 * stays under lib/clickhouse.ts's 1h request_timeout so a slow partition fails
 * as a clean ClickHouse error rather than a dropped socket -- the mutation
 * itself keeps running server-side either way, and re-running the restore is
 * safe.
 */
export function buildMaterializeProjectionSql(partition: string): string {
  return `ALTER TABLE ulp.credentials MATERIALIZE PROJECTION ${PROJECTION_NAME} IN PARTITION '${partition}'
  SETTINGS mutations_sync = 1, max_execution_time = 3300, timeout_overflow_mode = 'throw'`
}

/**
 * Re-creates proj_imported_desc on the live ulp.credentials after a swap:
 * ADD it (so new inserts carry it straight away), then materialize each
 * in-window partition, guarded by a disk-headroom check before each. Takes
 * client and guard as parameters, like content-dedup's
 * populateDedupedTableWithGuard, so it is testable with plain fakes.
 *
 * Unlike that function, a guard trip here must NOT drop anything: the table
 * being worked on is the live one, and is fully correct without the projection
 * (just slower for the "newest first" default sort on partitions still waiting).
 * The error propagates; re-run via `scripts/run-content-dedup-once.ts
 * --restore-projections` once there is headroom.
 */
export async function restoreImportedDescProjection(
  client: ClickHouseClient,
  guard: DiskGuard,
  opts: { now?: Date } = {},
): Promise<{ partitions: string[] }> {
  await client.exec({ query: buildAddImportedDescProjectionSql() })

  const cutoff = cutoffPartition(projectionScopeWindowMonths(), opts.now ?? new Date())
  const res = await client.query({ query: buildRecentPartitionsSql(cutoff), format: 'JSONEachRow' })
  const partitions = ((await res.json()) as Array<{ partition: string }>).map(row => row.partition)
  if (partitions.length === 0) return { partitions }

  await guard.preflight()
  for (let i = 0; i < partitions.length; i++) {
    await guard.checkBeforeIteration(undefined, { index: i, total: partitions.length })
    const startedAt = Date.now()
    await client.exec({ query: buildMaterializeProjectionSql(partitions[i]) })
    console.warn(
      `[credentials-projections] materialized ${PROJECTION_NAME} for partition ${partitions[i]} ` +
        `(${i + 1}/${partitions.length}) in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    )
  }
  return { partitions }
}
