/**
 * Content-level deduplication of ulp.credentials — the durable follow-up to the
 * one-time scripts/dedup-credentials-content.sh.
 *
 * WHY this exists (and why OPTIMIZE can't): content duplicates — identical
 * email/password and the same URL once scheme and a trailing slash are
 * ignored (see lib/url-content-key.ts) — arrive across DIFFERENT source files /
 * import times. `OPTIMIZE … DEDUPLICATE BY`
 * cannot collapse them — ClickHouse requires the DEDUPLICATE key to include the
 * ORDER BY + partition columns (domain, email, imported_at), and `imported_at`
 * being mandatory is exactly what keeps cross-import copies distinct. So content
 * dedup must compare only (url,email,password).
 *
 * MECHANISM: insert-select-rename (matching ClickHouse's own guidance to
 * avoid mutations for large transformations, and this codebase's own proven
 * scripts/dedup-credentials-content.sh). Builds a deduplicated copy of
 * ulp.credentials into AUTO_DEDUP_TABLE via `INSERT ... SELECT ... ORDER BY
 * CONTENT_DEDUP_SURVIVOR_ORDER LIMIT 1 BY CONTENT_KEY` (keeps the earliest
 * imported_at per content key — LIMIT 1 BY has no "exact ties" failure mode,
 * unlike a min(hash) predicate), verifies it, atomically RENAMEs it into
 * place, then copies over anything imported during the build window (see
 * "CATCH-UP" below). Full design:
 * docs/superpowers/specs/2026-07-07-content-dedup-rewrite-swap-design.md
 *
 * SAFETY: report-only by default. It logs how many rows it WOULD remove;
 * nothing is touched unless CONTENT_DEDUP_APPLY=true. The scheduled cron
 * (lib/dedup-cron.ts) invokes this routine; operators can also run the
 * separate, manual scripts/dedup-credentials-content.sh (unchanged by this
 * design — it uses its own _cdedup/_predup table names, so the two never
 * collide if both are run around the same time).
 *
 * PRIOR DESIGNS (all superseded — see the design doc above for the full
 * investigation): (1) lightweight `DELETE FROM` — rejected outright by the
 * table's `proj_imported_desc` projection. (2) unchunked heavyweight `ALTER
 * TABLE ... DELETE` — hit MEMORY_LIMIT_EXCEEDED at 2.8% of the real table's
 * scale. (3) the same DELETE chunked into hash buckets — fixed the memory
 * problem, but every bucket still rewrites every physical part regardless of
 * bucket count (content-hash values don't correlate with part boundaries),
 * confirmed live to make a full sweep take on the order of weeks against a
 * real table that had settled into 13 parts (one 315M-row/26GiB). This
 * version (insert-select-rename) replaces (3) entirely rather than patching
 * it further — the part-touching problem is structural, not scale-specific,
 * and recurs for any future incremental use of a mutation-based approach.
 *
 * DISTINCT-COUNT SCALE: buildStatsSql(), buildCutoffSql(), and
 * buildVerifyDedupedTableSql() (all removed) each ran
 * uniqExact(cityHash64(CONTENT_KEY)) as a single ungrouped aggregate over a
 * large table (ulp.credentials for the first two, AUTO_DEDUP_TABLE for the
 * third -- itself the same order of magnitude once populated, since a
 * successfully-built dedup table has ~one row per distinct content key) --
 * confirmed live 2026-07-19 to hit MEMORY_LIMIT_EXCEEDED at 562M rows /
 * ~470M distinct content keys, right at this server's 16 GiB ceiling.
 * Unlike the populate step's own memory fix below, neither max_threads
 * bounding nor max_bytes_before_external_group_by spilling has any effect
 * here (both confirmed live to make no difference, including reshaped into
 * a real multi-group GROUP BY) -- a zero-key uniqExact holds one hash set
 * for the query's whole duration with nothing for either lever to act on.
 * buildCutoffTimestampSql()/buildContentKeyStatsSqlForBucket()/
 * buildVerifyDedupedTableSqlForBucket() replace them, bucketing the
 * distinct-count the same way the populate step below buckets its INSERT --
 * summing per-bucket uniqExact counts is exact, not approximate, via the
 * same content-duplicate-group-hashes-to-one-bucket guarantee.
 * buildContentKeyStatsSqlForBucket() and buildVerifyDedupedTableSqlForBucket()
 * both return count() alongside uniqExact() from the SAME per-bucket query
 * rather than a separate, earlier, unbucketed total query -- an earlier
 * design computed total from one fast query before the (slower,
 * multi-bucket) distinct-count scan, which let ongoing live inserts land
 * between the two, understating (or negating) the reported excess. Since
 * count() >= uniqExact() always holds within one query's single-pass read,
 * summing both from the same buckets keeps excess exact and never negative,
 * by construction. buildVerifyDedupedTableSqlForBucket() was found and
 * fixed in a second pass after the first two -- AUTO_DEDUP_TABLE isn't
 * concurrently written during verify (nothing else writes to it mid-tick),
 * so the timing-skew risk that motivated the combined-query shape for
 * ulp.credentials doesn't strictly apply here, but the same shape is used
 * anyway for consistency and because it costs nothing extra. Full design:
 * docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md
 *
 * POPULATE SCALE: six live attempts against the real table each hit
 * MEMORY_LIMIT_EXCEEDED at roughly the same point regardless of per-block
 * settings tuned (disk-spill sort, thread limiting, and a capped block size
 * each confirmed live -- the first two roughly doubled progress before
 * failure, the third had no measurable effect). Root cause: a single
 * continuously-growing INSERT accumulates background-merge memory pressure
 * over its whole duration, which per-block settings don't address. The
 * populate step is chunked by content-key hash bucket for the same reason
 * the old bucketed-DELETE design chunked its DELETE -- a content-duplicate
 * group always hashes to the same bucket, so chunking cannot affect
 * correctness -- but for a different purpose: giving background merges a
 * real gap to settle between sequential buckets, rather than bounding
 * per-mutation part-rewrite cost. Full design:
 * docs/superpowers/specs/2026-07-08-content-dedup-bucketed-populate-design.md
 *
 * CATCH-UP: ulp.credentials keeps receiving live inserts from the ingest
 * pipeline throughout the (potentially tens-of-minutes) rebuild. A cutoff
 * timestamp captured against ClickHouse's own clock (not Node's — imported_at
 * is a ClickHouse-side DEFAULT now() value; comparing against a Node-clock
 * timestamp risks skew) before the build starts lets a post-swap INSERT pull
 * anything imported after it from the archived original — excluding content
 * keys already present in the new table (INSERT ... SELECT has no strict
 * snapshot isolation, so the main build may have already picked up rows right
 * at the cutoff boundary) and deduplicating the catch-up set against itself.
 *
 * ROLLBACK: the archived original (AUTO_PREDUP_TABLE) is deliberately kept
 * for one full cron interval after each successful run, only dropped at the
 * START of the *next* run — giving an operator the entire interval to notice
 * a problem and manually roll back before it's cleared for the next cycle.
 */
import type { ClickHouseClient } from '@clickhouse/client'
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
import { SEARCH_INDEX_DEFINITIONS } from '@/lib/search-index-definitions'

/** Content identity: same destination + same credential (scheme/trailing-slash-insensitive on the URL). */
export const CONTENT_KEY = `${URL_CONTENT_KEY}, email, password`

/** Build target for the rewrite+swap cycle. Distinct from scripts/dedup-credentials-content.sh's ulp.credentials_cdedup so the two never collide. */
export const AUTO_DEDUP_TABLE = 'ulp.credentials_cdedup_auto'

/** Archived original after a successful swap -- kept one full cron interval as a rollback safety net (see ROLLBACK above). */
export const AUTO_PREDUP_TABLE = 'ulp.credentials_predup_auto'

/**
 * Deterministic tie-break for LIMIT 1 BY: keeps the earliest imported_at per
 * content key. Mirrors scripts/dedup-credentials-content.sh's ORDER exactly
 * -- the raw url column (not the normalized URL_CONTENT_KEY expression);
 * imported_at ASC is what actually decides the survivor among same-content-key
 * rows once LIMIT 1 BY groups them.
 */
export const CONTENT_DEDUP_SURVIVOR_ORDER = 'url, email, password, imported_at'

/**
 * Rewrites a `SHOW CREATE TABLE` result to target a different table name and
 * ReplicatedMergeTree ZooKeeper path -- a clone with the same ZK path
 * collides with Code REPLICA_ALREADY_EXISTS. Pure function so the rewrite
 * logic is unit-testable without a live database; runContentDedupTick() is
 * responsible for fetching showCreateSql via a live SHOW CREATE TABLE first.
 * Mirrors scripts/dedup-credentials-content.sh's sed rewrite exactly: only
 * the CREATE TABLE line's table name is rewritten (not any other line), and
 * the ZK path is matched by its `/ulp/credentials'` suffix rather than a
 * fixed prefix, so it works regardless of the exact path prefix ClickHouse
 * uses (confirmed live: the real path is `/clickhouse/tables/{shard}/ulp/credentials`,
 * which still ends in exactly that suffix).
 */
export function rewriteCreateTableDdl(showCreateSql: string, targetTable: string): string {
  const targetShortName = targetTable.split('.')[1]
  const lines = showCreateSql.split('\n')
  lines[0] = lines[0].replace('ulp.credentials', targetTable)
  return lines.join('\n').replace("/ulp/credentials'", `/ulp/${targetShortName}'`)
}

/**
 * Trivial single value, captured before the populate step's bucket scan
 * starts (step 5 below) -- the stats step's own bucket scan, earlier in the
 * same tick, is fine to precede this. See runContentDedupTick's step 1
 * comment for why this ordering still keeps the CATCH-UP guarantee intact
 * even though expectedRows (from buildContentKeyStatsSqlForBucket below) is
 * no longer captured atomically with this value, unlike the old
 * single-query buildCutoffSql().
 */
export function buildCutoffTimestampSql(): string {
  return `SELECT now() AS cutoff`
}

/**
 * Bounds the row total and distinct content-key count the same way
 * buildPopulateDedupedTableSqlForBucket bounds the populate INSERT --
 * `uniqExact(cityHash64(CONTENT_KEY))` with no GROUP BY forces ClickHouse to
 * hold one exact-cardinality hash set for the whole table's distinct content
 * keys in memory at once (~470M at 562M rows), which sits right at this
 * server's 16 GiB ceiling. Confirmed live 2026-07-19: neither max_threads
 * nor max_bytes_before_external_group_by bounding has ANY effect on this
 * query shape (both tested, identical failure either way -- the spill
 * mechanism only helps multi-group GROUP BY, and a zero-key uniqExact has no
 * groups for it to act on). Only reducing the actual per-query cardinality
 * via bucketing works, and does so exactly: a content-duplicate group always
 * hashes to the same bucket, so sum(uniqExact per disjoint bucket) equals
 * the true whole-table distinct count with zero approximation. Returns
 * `bucket_total` (count()) alongside `bucket_distinct` (uniqExact()) from
 * the SAME query rather than a separate total query, so both are read from
 * identical per-bucket timing -- count() >= uniqExact() always holds within
 * one query's single-pass read, so summing both across buckets keeps the
 * derived excess (total - distinctCreds) exact and never negative, even
 * though ulp.credentials keeps receiving live inserts throughout the
 * multi-bucket scan. Shared by both the stats path (uses bucket_total and
 * bucket_distinct) and the cutoff path (uses bucket_distinct only) in
 * runContentDedupTick -- identical query, two call sites. Full design:
 * docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md
 */
export function buildContentKeyStatsSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `SELECT
    count() AS bucket_total,
    uniqExact(cityHash64(${CONTENT_KEY})) AS bucket_distinct
  FROM ulp.credentials
  WHERE cityHash64(${CONTENT_KEY}) % ${bucketCount} = ${bucketIndex}
  SETTINGS max_execution_time = 300`
}

/**
 * Memory ceiling for the populate/catch-up `INSERT ... SELECT ... ORDER BY
 * ... LIMIT 1 BY` queries. ClickHouse can't push a bounded LIMIT through this
 * shape -- it must fully sort the input before applying LIMIT 1 BY, no matter
 * how small the final result is (same underlying behavior documented in
 * lib/clickhouse-query-limits.ts's EXPORT_SORT_MAX_MEMORY_BYTES, for the
 * export feature's own ORDER BY + LIMIT 1 BY queries). Confirmed live
 * 2026-07-08: without this, the real ~467M-row populate query hit
 * MEMORY_LIMIT_EXCEEDED (16 GiB ceiling) reading a single mid-sized part --
 * never caught earlier because disposable-clone testing only used 3M rows,
 * well under the threshold where this triggers.
 */
export const CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES = 4_294_967_296 // 4 GiB

/**
 * Bounds concurrent sort/insert parallelism against this table (mirrors
 * scripts/purge-existing-t3.sh's and the prior bucketed design's
 * max_threads=2 for the same table). Confirmed live 2026-07-08: even with
 * disk-spill sort enabled, the populate query hit a SECOND, later
 * MEMORY_LIMIT_EXCEEDED (a large single allocation, well past the sort
 * phase) -- consistent with this table's ~9 complex MATERIALIZED columns
 * being recomputed per row on the INSERT side across multiple concurrent
 * threads; fewer threads means fewer of those computations happening at
 * once, bounding peak memory at the cost of wall-clock time (acceptable
 * given this runs at most weekly, not on a latency budget).
 */
export const CONTENT_DEDUP_MAX_THREADS = 2

/**
 * Number of hash buckets the populate step is chunked into. Default 32:
 * comfortable safety margin under the ~64M-row point where an unchunked
 * populate reliably hit MEMORY_LIMIT_EXCEEDED (~11M rows/bucket at this
 * table's real scale, ~5.8x margin), while keeping the number of full
 * source-table re-scans modest -- every bucket's hash filter is unprunable,
 * so each bucket costs one full table scan regardless of bucket count.
 */
export function contentDedupBucketCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.CONTENT_DEDUP_BUCKET_COUNT ?? '32', 10)
  return Number.isFinite(n) && n >= 1 ? n : 32
}

/**
 * Builds AUTO_DEDUP_TABLE's share for one bucket: one row per content key
 * whose hash falls in this bucket, keeping the earliest imported_at. A
 * content-duplicate group's rows always share the same CONTENT_KEY, so they
 * always hash to the same bucket and can never split across two --
 * chunking cannot affect correctness. `max_execution_time = 1800,
 * timeout_overflow_mode = 'throw'` mirrors scripts/dedup-credentials-content.sh's
 * own equivalent INSERT step exactly -- the client's default
 * max_execution_time (60s, lib/clickhouse.ts) is far too short at this
 * scale. No max_block_size override (see POPULATE SCALE above): bucketing
 * itself now bounds the operation's scale, and a small block size risks a
 * "too many parts" problem at bucket scale that it didn't at full-table
 * scale.
 */
export function buildPopulateDedupedTableSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `INSERT INTO ${AUTO_DEDUP_TABLE}
  SELECT * FROM ulp.credentials
  WHERE cityHash64(${CONTENT_KEY}) % ${bucketCount} = ${bucketIndex}
  ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}
  LIMIT 1 BY ${CONTENT_KEY}
  SETTINGS max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_execution_time = 1800, timeout_overflow_mode = 'throw'`
}

/**
 * AUTO_DEDUP_TABLE's own row count and internal excess, one bucket at a
 * time -- does not query the original table (that comparison uses the
 * cutoff step's expectedRows, captured before the build started, via
 * runContentDedupTick's `>=` check -- see buildContentKeyStatsSqlForBucket's
 * comment for why a fresh query here would be wrong). Bucketed for the same
 * reason buildContentKeyStatsSqlForBucket is: an ungrouped
 * uniqExact(cityHash64(CONTENT_KEY)) over AUTO_DEDUP_TABLE is the identical
 * memory risk once the table is populated (~470M rows, nearly all distinct
 * by construction -- a successful dedup leaves ~one row per content key, so
 * this table's distinct-to-row ratio is if anything higher than
 * ulp.credentials' was). See the file's DISTINCT-COUNT SCALE comment.
 */
export function buildVerifyDedupedTableSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `SELECT
    count() AS bucket_total,
    uniqExact(cityHash64(${CONTENT_KEY})) AS bucket_distinct
  FROM ${AUTO_DEDUP_TABLE}
  WHERE cityHash64(${CONTENT_KEY}) % ${bucketCount} = ${bucketIndex}
  SETTINGS max_execution_time = 300`
}

/**
 * DDL to ensure AUTO_DEDUP_TABLE has the full search-index set BEFORE it's
 * populated. Run against the still-empty clone right after it's created (see
 * runContentDedupTick's step 4b) -- ADD INDEX on an empty table is
 * metadata-only, and the populate INSERT that follows computes each index as
 * it writes rows, so no MATERIALIZE backfill is ever needed here (contrast
 * lib/clickhouse-migrations.ts's DDL v17, which DOES need MATERIALIZE because
 * it applies to the live, already-populated table).
 *
 * Exists because a rewrite+swap clones the live table's DDL via `SHOW CREATE
 * TABLE` as-is (see rewriteCreateTableDdl) -- if the source table were ever
 * missing one of these indexes again, the swap would otherwise silently carry
 * that gap forward into the new live table with no automatic re-check. Pulls
 * from lib/search-index-definitions.ts, the same source DDL v17 uses, so the
 * two callers can't drift apart.
 */
export function buildEnsureSearchIndexesSql(): string[] {
  return SEARCH_INDEX_DEFINITIONS.flatMap(def => [
    def.dropIndexSql(AUTO_DEDUP_TABLE),
    def.addIndexSql(AUTO_DEDUP_TABLE),
  ])
}

/** Atomic, metadata-only swap: the deduped copy becomes ulp.credentials; the original is archived under AUTO_PREDUP_TABLE. */
export function buildRenameSwapSql(): string {
  return `RENAME TABLE ulp.credentials TO ${AUTO_PREDUP_TABLE}, ${AUTO_DEDUP_TABLE} TO ulp.credentials`
}

/**
 * Copies rows imported after `cutoff` from the archived original into the
 * now-live ulp.credentials -- anything imported during the build window
 * would otherwise be silently lost (see CATCH-UP above). Excludes content
 * keys already present (the main build may have already picked up rows right
 * at the cutoff boundary) and deduplicates the catch-up set against itself.
 * `cutoff` must be a ClickHouse-clock timestamp string (e.g. from `SELECT
 * now()`), not a Node-clock value -- see the file's CATCH-UP comment.
 */
export function buildCatchupInsertSql(cutoff: string): string {
  return `INSERT INTO ulp.credentials
  SELECT * FROM ${AUTO_PREDUP_TABLE}
  WHERE imported_at > '${cutoff}'
    AND cityHash64(${CONTENT_KEY}) NOT IN (SELECT cityHash64(${CONTENT_KEY}) FROM ulp.credentials)
  ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}
  LIMIT 1 BY ${CONTENT_KEY}
  SETTINGS max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_execution_time = 1800, timeout_overflow_mode = 'throw'`
}

// ── env knobs (pure, testable) ──────────────────────────────────────────────────

/** Cron interval in hours; 0 (or invalid) disables the scheduled job. Default 24. */
export function dedupCronHours(env: NodeJS.ProcessEnv = process.env): number {
  const h = parseInt(env.DEDUP_CRON_HOURS ?? '24', 10)
  return Number.isFinite(h) && h > 0 ? h : 0
}

/** Whether the destructive rebuild is allowed to run. Default false (report-only). */
export function contentDedupApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTENT_DEDUP_APPLY === 'true' || env.CONTENT_DEDUP_APPLY === '1'
}

/** Don't rebuild the table unless at least this many excess rows exist. Default 1000. */
export function minExcessToApply(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.DEDUP_MIN_EXCESS ?? '1000', 10)
  return Number.isFinite(n) && n >= 0 ? n : 1000
}

/**
 * UTC hour (0-23) the cron tick is anchored to. Default 4 (04:00 UTC).
 * Previously the first tick fired 60s after whatever moment the app container
 * happened to start, so its recurrence landed at an arbitrary wall-clock
 * time — including, on 2026-06-27, the middle of a heavy-query window. Anchor
 * it to an explicit hour instead; tune DEDUP_CRON_HOUR_UTC to your actual
 * low-traffic window.
 */
export function dedupCronHourUtc(env: NodeJS.ProcessEnv = process.env): number {
  const h = parseInt(env.DEDUP_CRON_HOUR_UTC ?? '4', 10)
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 4
}

// ── tick (report, and optionally apply) ─────────────────────────────────────────

let tickInFlight = false

export interface DedupTickResult {
  total: number
  excess: number
  applied: boolean
}

/**
 * Sums a bucketed query's row totals and distinct-content-key counts
 * sequentially -- shared by the stats step, the cutoff step, and the verify
 * step below, each passing its own per-bucket SQL builder
 * (buildContentKeyStatsSqlForBucket or buildVerifyDedupedTableSqlForBucket).
 * Both builders alias their two aggregates identically (`bucket_total`,
 * `bucket_distinct`) specifically so this loop can stay generic across
 * tables. Not exported/unit-tested separately: this file only unit-tests
 * pure SQL builders, matching the existing convention that the populate
 * step's own bucket loop (inside runContentDedupTick) isn't unit-tested
 * either, only its SQL-builder function is. Exercised by Tasks 3-5 of this
 * plan instead.
 */
async function sumBucketedTotalAndDistinct(
  client: ClickHouseClient,
  bucketCount: number,
  buildBucketSql: (bucketIndex: number, bucketCount: number) => string,
): Promise<{ total: number; distinctCreds: number }> {
  let total = 0
  let distinctCreds = 0
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const res = await client.query({ query: buildBucketSql(bucket, bucketCount), format: 'JSONEachRow' })
    const [row] = (await res.json()) as Array<{ bucket_total: string; bucket_distinct: string }>
    total += Number(row?.bucket_total ?? 0)
    distinctCreds += Number(row?.bucket_distinct ?? 0)
  }
  return { total, distinctCreds }
}

/**
 * Read duplicate stats, log them, and — only when CONTENT_DEDUP_APPLY is on and
 * excess clears the threshold — run the rewrite+swap cycle. Never throws.
 */
export async function runContentDedupTick(opts: { trigger?: string } = {}): Promise<DedupTickResult> {
  const trigger = opts.trigger ?? 'tick'
  if (tickInFlight) return { total: 0, excess: 0, applied: false }
  tickInFlight = true
  try {
    const client = getClient()
    const bucketCount = contentDedupBucketCount()
    const { total, distinctCreds } = await sumBucketedTotalAndDistinct(client, bucketCount, buildContentKeyStatsSqlForBucket)
    const excess = total - distinctCreds
    const applyOn = contentDedupApplyEnabled()
    const willApply = applyOn && excess >= minExcessToApply()

    console.log(
      `[content-dedup] ${trigger}: total=${total} excess=${excess} willApply=${willApply}` +
        (applyOn ? '' : ' (report-only — set CONTENT_DEDUP_APPLY=true to enable cleanup)'),
    )
    if (!willApply) return { total, excess, applied: false }

    // 1. Capture cutoff BEFORE the populate step's bucket scan starts (step
    // 5 below), for CATCH-UP's own correctness (unchanged -- see the file's
    // CATCH-UP comment). The stats step above already ran its own bucket
    // scan before this point, which is fine -- CATCH-UP only requires cutoff
    // to precede POPULATE specifically. expectedRows is no longer captured
    // atomically with cutoff (see buildContentKeyStatsSqlForBucket's comment
    // and docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md)
    // -- the bucketed sum below can pick up rows imported during its own scan
    // window on top of what existed at cutoff, but since ulp.credentials only
    // ever gains rows here (no concurrent deletes), that only ever makes
    // expectedRows equal-or-higher than the true cutoff-instant count, never
    // lower -- so the `cdedupRows >= expectedRows` check in step 6 below
    // stays exactly as conservative as it was when this was one atomic query.
    const cutoffRes = await client.query({ query: buildCutoffTimestampSql(), format: 'JSONEachRow' })
    const [cutoffRow] = (await cutoffRes.json()) as Array<{ cutoff: string }>
    const cutoff = cutoffRow?.cutoff
    if (!cutoff) throw new Error('[content-dedup] failed to capture cutoff timestamp')
    const { distinctCreds: expectedRows } = await sumBucketedTotalAndDistinct(client, bucketCount, buildContentKeyStatsSqlForBucket)

    // 2. Drop the previous run's retained rollback safety net. SYNC matters:
    // ClickHouse's Atomic database engine (the default) doesn't drop a
    // ReplicatedMergeTree table's ZooKeeper replica registration immediately
    // -- it's deferred by database_atomic_delay_before_drop_table_sec
    // (default 480s). Without SYNC, a CREATE TABLE reusing this ZK path
    // moments later can race the still-pending cleanup and fail with
    // REPLICA_ALREADY_EXISTS -- confirmed live 2026-07-08, retrying this
    // exact tick right after a prior drop hit exactly that.
    await client.exec({ query: `DROP TABLE IF EXISTS ${AUTO_PREDUP_TABLE} SYNC` })

    // 3. Drop any partial build left over from a crashed run -- an unattended
    // tick always starts fresh rather than trying to resume. SYNC for the
    // same reason as step 2: this table's ZK path is about to be reused by
    // step 4's CREATE TABLE moments later.
    await client.exec({ query: `DROP TABLE IF EXISTS ${AUTO_DEDUP_TABLE} SYNC` })

    // 4. Create the deduped-table clone (schema + rewritten ZK path).
    const showCreateRes = await client.query({ query: 'SHOW CREATE TABLE ulp.credentials', format: 'JSONEachRow' })
    const [showCreateRow] = (await showCreateRes.json()) as Array<{ statement: string }>
    const showCreateSql = showCreateRow?.statement
    if (!showCreateSql) throw new Error('[content-dedup] SHOW CREATE TABLE returned nothing')
    await client.exec({ query: rewriteCreateTableDdl(showCreateSql, AUTO_DEDUP_TABLE) })

    // 4b. Ensure the still-empty clone has the full search-index set before it's
    // populated (see buildEnsureSearchIndexesSql's comment for why this exists
    // and why it never needs MATERIALIZE here).
    for (const stmt of buildEnsureSearchIndexesSql()) {
      await client.exec({ query: stmt })
    }

    // 5. Populate, one bucket at a time -- see the file's POPULATE SCALE
    // comment for why this runs as a sequential loop instead of one INSERT.
    // bucketCount was already captured in step 0 above (shared with the
    // stats/cutoff distinct-count buckets -- see CUTOFF/STATS SCALE).
    console.log(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets (~${excess} duplicate rows to remove)`)
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      await client.exec({ query: buildPopulateDedupedTableSqlForBucket(bucket, bucketCount) })
    }

    // 6. Verify before swapping, one bucket at a time -- see the file's
    // DISTINCT-COUNT SCALE comment for why AUTO_DEDUP_TABLE needs the same
    // bucketing treatment as ulp.credentials' own stats/cutoff queries.
    // cdedupRows >= expectedRows (not ==): the build may have picked up a
    // few rows imported just after cutoff in addition to everything that
    // existed at that moment -- a good outcome, not a mismatch (see
    // buildContentKeyStatsSqlForBucket's comment). A count BELOW
    // expectedRows means the build genuinely lost pre-existing content
    // keys, which is the real failure this check exists to catch.
    // excessAfter stays a strict == 0 check regardless of timing -- a
    // LIMIT 1 BY-built table must never have internal duplicates.
    const { total: cdedupRows, distinctCreds: cdedupDistinct } = await sumBucketedTotalAndDistinct(client, bucketCount, buildVerifyDedupedTableSqlForBucket)
    const excessAfter = cdedupRows - cdedupDistinct
    if (cdedupRows < expectedRows || excessAfter !== 0) {
      console.error(
        `[content-dedup] verification failed (cdedup_rows=${cdedupRows} expected_rows=${expectedRows} excess_after=${excessAfter}) -- aborting, original table untouched`,
      )
      await client.exec({ query: `DROP TABLE IF EXISTS ${AUTO_DEDUP_TABLE} SYNC` })
      return { total, excess, applied: false }
    }

    // 7. Swap.
    await client.exec({ query: buildRenameSwapSql() })

    // 8. Catch up anything imported during the build window.
    await client.exec({ query: buildCatchupInsertSql(cutoff) })

    console.log(`[content-dedup] ${trigger}: completed rewrite+swap (~${excess} duplicate rows removed)`)
    return { total, excess, applied: true }
  } catch (err) {
    console.error('[content-dedup] tick error:', err instanceof Error ? err.message : String(err))
    return { total: 0, excess: 0, applied: false }
  } finally {
    tickInFlight = false
  }
}
