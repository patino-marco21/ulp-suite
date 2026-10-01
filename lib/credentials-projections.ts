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
 * Letting it fall away with the swap therefore retires it. Its job -- a
 * reverse(domain) order for the monitor's suffix match -- is done by the much
 * smaller PARTIAL projection proj_domain_rev below, which the planner can only
 * use as an index, never as a thin covering copy.
 *
 * proj_email_domain_rev IS restored, for all partitions still missing it (it is
 * ~5.9 GiB at 1.39B rows, so the recency window does not apply): a partial
 * projection (`SELECT _part_offset ORDER BY reverse(email_domain)`) that lets the
 * domain monitor's `email_domain = 'x' OR endsWith(email_domain, '.x')` scan range-prune
 * instead of reading the table. See docs/superpowers/specs/2026-09-30-query-perf-wins-design.md.
 *
 * proj_domain_rev is restored the same way (all partitions still missing it), for the
 * monitor's `domain = 'x' OR endsWith(domain, '.x')` scan. See
 * docs/superpowers/specs/2026-09-30-related-panel-and-domain-rev-design.md.
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
  return buildMaterializeSql(PROJECTION_NAME, partition)
}

/** Shared by every projection this file restores; see buildMaterializeProjectionSql for the settings' reasoning. */
function buildMaterializeSql(projectionName: string, partition: string): string {
  return `ALTER TABLE ulp.credentials MATERIALIZE PROJECTION ${projectionName} IN PARTITION '${partition}'
  SETTINGS mutations_sync = 1, max_execution_time = 3300, timeout_overflow_mode = 'throw'`
}

/**
 * One partition at a time, each behind the disk guard, logging progress. Shared by every
 * restore in this file. A guard trip propagates (the table being worked on is the live
 * one, so nothing is ever dropped here).
 */
async function materializeEachPartition(
  client: ClickHouseClient,
  guard: DiskGuard,
  projectionName: string,
  partitions: string[],
): Promise<void> {
  if (partitions.length === 0) return
  await guard.preflight()
  for (let i = 0; i < partitions.length; i++) {
    await guard.checkBeforeIteration(undefined, { index: i, total: partitions.length })
    const startedAt = Date.now()
    await client.exec({ query: buildMaterializeSql(projectionName, partitions[i]) })
    console.warn(
      `[credentials-projections] materialized ${projectionName} for partition ${partitions[i]} ` +
        `(${i + 1}/${partitions.length}) in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    )
  }
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
  await materializeEachPartition(client, guard, PROJECTION_NAME, partitions)
  return { partitions }
}

// ── Reversed-key partial projections: proj_email_domain_rev, proj_domain_rev ──────

/**
 * A PARTIAL projection (projection index) stores only the sort key and each row's position,
 * ~4.5 bytes/row. Ordering by the REVERSED value turns a suffix match into a prefix range --
 * `endsWith(v, '.x')` == `startsWith(reverse(v), reverse('.x'))`, byte-for-byte -- which
 * ClickHouse can range-prune on. The two below share every builder in this section; only the
 * name and the column differ. Each body is shared by its DDL migration, the init SQL mirror and
 * its restore function so they cannot drift apart.
 */
interface ReversedKeyProjection {
  name: string
  body: string
}

/** Metadata-only and idempotent: new inserts get the projection immediately, existing parts need MATERIALIZE. */
function buildAddReversedKeyProjectionSql(projection: ReversedKeyProjection): string {
  return `ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS ${projection.name} (${projection.body})`
}

/**
 * Partitions that still have at least one active part without the projection -- so a
 * re-run after a finished restore finds nothing to do. Newest first: newer partitions are
 * usually the smaller ones, which keeps the disk guard's linear projection from
 * over-projecting after one big partition.
 */
function buildPartitionsMissingProjectionSql(projectionName: string): string {
  return `SELECT DISTINCT partition FROM system.parts
    WHERE database = 'ulp' AND table = 'credentials' AND active
      AND name NOT IN (
        SELECT parent_name FROM system.projection_parts
        WHERE database = 'ulp' AND table = 'credentials'
          AND name = '${projectionName}' AND active
      )
    ORDER BY partition DESC`
}

/** Active parts vs active parts carrying the projection, in one metadata-only query. */
function buildProjectionReadySql(projectionName: string): string {
  return `SELECT
    (SELECT count() FROM system.parts
      WHERE database = 'ulp' AND table = 'credentials' AND active) AS parts,
    (SELECT count() FROM system.projection_parts
      WHERE database = 'ulp' AND table = 'credentials'
        AND name = '${projectionName}' AND active) AS with_projection`
}

/**
 * Ready only when there are parts and EVERY one carries the projection. A mixed state
 * would run the rewritten predicate over parts without the index -- measured worse than
 * today's plan (a full read).
 */
export function reversedKeyProjectionReady(counts: { parts: number; withProjection: number }): boolean {
  return Number.isFinite(counts.parts) && counts.parts > 0 && counts.parts === counts.withProjection
}

/**
 * Fails CLOSED: any error means "not ready", so the caller runs the original plan. `run` is
 * injected (the resolver passes executeQuery) so this stays unit-testable.
 */
async function isReversedKeyProjectionReady(
  projectionName: string,
  run: (sql: string) => Promise<Array<{ parts?: unknown; with_projection?: unknown }>>,
): Promise<boolean> {
  try {
    const [row] = await run(buildProjectionReadySql(projectionName))
    return reversedKeyProjectionReady({ parts: Number(row?.parts), withProjection: Number(row?.with_projection) })
  } catch (err) {
    console.warn(
      `[credentials-projections] ${projectionName} readiness check failed -- using the original scan:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Re-creates a reversed-key projection on the live ulp.credentials: ADD it (new inserts carry it
 * at once), then materialize each partition that still has a part without it, behind the
 * disk guard. Idempotent: when nothing is missing it is just the IF NOT EXISTS ADD. Like
 * restoreImportedDescProjection, a guard trip must NOT drop anything -- the table is live and
 * correct without the projection (the monitor falls back to its original scan).
 */
async function restoreReversedKeyProjection(
  client: ClickHouseClient,
  guard: DiskGuard,
  projection: ReversedKeyProjection,
): Promise<{ partitions: string[] }> {
  await client.exec({ query: buildAddReversedKeyProjectionSql(projection) })

  const res = await client.query({ query: buildPartitionsMissingProjectionSql(projection.name), format: 'JSONEachRow' })
  const partitions = ((await res.json()) as Array<{ partition: string }>).map(row => row.partition)
  await materializeEachPartition(client, guard, projection.name, partitions)
  return { partitions }
}

// ── proj_email_domain_rev ────────────────────────────────────────────────────

export const EMAIL_DOMAIN_REV_PROJECTION_NAME = 'proj_email_domain_rev'

/** Orders by reverse(email_domain): see the section comment above. Shared by DDL v23, the init SQL mirror and the restore. */
export const EMAIL_DOMAIN_REV_PROJECTION_BODY = `SELECT _part_offset
        ORDER BY reverse(email_domain)`

const EMAIL_DOMAIN_REV: ReversedKeyProjection = {
  name: EMAIL_DOMAIN_REV_PROJECTION_NAME,
  body: EMAIL_DOMAIN_REV_PROJECTION_BODY,
}

export function buildAddEmailDomainRevProjectionSql(): string {
  return buildAddReversedKeyProjectionSql(EMAIL_DOMAIN_REV)
}

export function buildPartitionsMissingEmailDomainRevSql(): string {
  return buildPartitionsMissingProjectionSql(EMAIL_DOMAIN_REV_PROJECTION_NAME)
}

export function buildMaterializeEmailDomainRevProjectionSql(partition: string): string {
  return buildMaterializeSql(EMAIL_DOMAIN_REV_PROJECTION_NAME, partition)
}

export function buildEmailDomainRevProjectionReadySql(): string {
  return buildProjectionReadySql(EMAIL_DOMAIN_REV_PROJECTION_NAME)
}

export const emailDomainRevProjectionReady = reversedKeyProjectionReady

export function isEmailDomainRevProjectionReady(
  run: (sql: string) => Promise<Array<{ parts?: unknown; with_projection?: unknown }>>,
): Promise<boolean> {
  return isReversedKeyProjectionReady(EMAIL_DOMAIN_REV_PROJECTION_NAME, run)
}

export function restoreEmailDomainRevProjection(
  client: ClickHouseClient,
  guard: DiskGuard,
): Promise<{ partitions: string[] }> {
  return restoreReversedKeyProjection(client, guard, EMAIL_DOMAIN_REV)
}

// ── proj_domain_rev ──────────────────────────────────────────────────────────

export const DOMAIN_REV_PROJECTION_NAME = 'proj_domain_rev'

/**
 * Orders by reverse(domain): see the section comment above. Serves the monitor's `domain`
 * candidate scan (`domain = 'x' OR endsWith(domain, '.x')`), which no index on the table can
 * prune: it ran 42.7 s / 666M rows cold for 17 domains (measured 2026-09-30), and only the
 * per-granule query condition cache ever made it fast. Shared by DDL v24, the init SQL mirror
 * and restoreDomainRevProjection.
 */
export const DOMAIN_REV_PROJECTION_BODY = `SELECT _part_offset
        ORDER BY reverse(domain)`

const DOMAIN_REV: ReversedKeyProjection = {
  name: DOMAIN_REV_PROJECTION_NAME,
  body: DOMAIN_REV_PROJECTION_BODY,
}

export function buildAddDomainRevProjectionSql(): string {
  return buildAddReversedKeyProjectionSql(DOMAIN_REV)
}

export function buildPartitionsMissingDomainRevSql(): string {
  return buildPartitionsMissingProjectionSql(DOMAIN_REV_PROJECTION_NAME)
}

export function buildMaterializeDomainRevProjectionSql(partition: string): string {
  return buildMaterializeSql(DOMAIN_REV_PROJECTION_NAME, partition)
}

export function buildDomainRevProjectionReadySql(): string {
  return buildProjectionReadySql(DOMAIN_REV_PROJECTION_NAME)
}

export function isDomainRevProjectionReady(
  run: (sql: string) => Promise<Array<{ parts?: unknown; with_projection?: unknown }>>,
): Promise<boolean> {
  return isReversedKeyProjectionReady(DOMAIN_REV_PROJECTION_NAME, run)
}

export function restoreDomainRevProjection(
  client: ClickHouseClient,
  guard: DiskGuard,
): Promise<{ partitions: string[] }> {
  return restoreReversedKeyProjection(client, guard, DOMAIN_REV)
}
