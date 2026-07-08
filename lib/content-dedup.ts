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
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

/** Content identity: same destination + same credential (scheme/trailing-slash-insensitive on the URL). */
export const CONTENT_KEY = `${URL_CONTENT_KEY}, email, password`

export function buildStatsSql(): string {
  return `SELECT
    count() AS total,
    uniqExact(cityHash64(${CONTENT_KEY})) AS distinct_creds,
    total - distinct_creds AS excess
  FROM ulp.credentials
  SETTINGS max_execution_time = 300`
}

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
 * Captures the cutoff timestamp and the distinct content-key count together,
 * in one query, against ClickHouse's own clock, before the build starts.
 * Both values MUST come from here, not be re-queried later: ulp.credentials
 * keeps receiving live inserts throughout the build, so a fresh count taken
 * at verify time would compare against a moving target and spuriously fail
 * verification on a perfectly correct run.
 */
export function buildCutoffSql(): string {
  return `SELECT
    now() AS cutoff,
    uniqExact(cityHash64(${CONTENT_KEY})) AS expected_rows
  FROM ulp.credentials
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
 * AUTO_DEDUP_TABLE's own row count and internal excess -- does not query the
 * original table (that comparison uses buildCutoffSql()'s expectedRows,
 * captured before the build started, via runContentDedupTick's `>=` check --
 * see buildCutoffSql's comment for why a fresh query here would be wrong).
 */
export function buildVerifyDedupedTableSql(): string {
  return `SELECT
    count() AS cdedup_rows,
    count() - uniqExact(cityHash64(${CONTENT_KEY})) AS excess_after
  FROM ${AUTO_DEDUP_TABLE}
  SETTINGS max_execution_time = 300`
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
 * Read duplicate stats, log them, and — only when CONTENT_DEDUP_APPLY is on and
 * excess clears the threshold — run the rewrite+swap cycle. Never throws.
 */
export async function runContentDedupTick(opts: { trigger?: string } = {}): Promise<DedupTickResult> {
  const trigger = opts.trigger ?? 'tick'
  if (tickInFlight) return { total: 0, excess: 0, applied: false }
  tickInFlight = true
  try {
    const client = getClient()
    const statsRes = await client.query({ query: buildStatsSql(), format: 'JSONEachRow' })
    const [stats] = (await statsRes.json()) as Array<{ total: string; excess: string }>
    const total = Number(stats?.total ?? 0)
    const excess = Number(stats?.excess ?? 0)
    const applyOn = contentDedupApplyEnabled()
    const willApply = applyOn && excess >= minExcessToApply()

    console.log(
      `[content-dedup] ${trigger}: total=${total} excess=${excess} willApply=${willApply}` +
        (applyOn ? '' : ' (report-only — set CONTENT_DEDUP_APPLY=true to enable cleanup)'),
    )
    if (!willApply) return { total, excess, applied: false }

    // 1. Capture cutoff AND expectedRows together, against ClickHouse's own
    // clock, before anything else runs (see the file's CATCH-UP comment and
    // buildCutoffSql's comment for why both must come from here, not be
    // re-queried at verify time).
    const cutoffRes = await client.query({ query: buildCutoffSql(), format: 'JSONEachRow' })
    const [cutoffRow] = (await cutoffRes.json()) as Array<{ cutoff: string; expected_rows: string }>
    const cutoff = cutoffRow?.cutoff
    const expectedRows = Number(cutoffRow?.expected_rows ?? -1)
    if (!cutoff) throw new Error('[content-dedup] failed to capture cutoff timestamp')

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

    // 5. Populate, one bucket at a time -- see the file's POPULATE SCALE
    // comment for why this runs as a sequential loop instead of one INSERT.
    const bucketCount = contentDedupBucketCount()
    console.log(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets (~${excess} duplicate rows to remove)`)
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      await client.exec({ query: buildPopulateDedupedTableSqlForBucket(bucket, bucketCount) })
    }

    // 6. Verify before swapping. cdedupRows >= expectedRows (not ==): the
    // build may have picked up a few rows imported just after cutoff in
    // addition to everything that existed at that moment -- a good outcome,
    // not a mismatch (see buildCutoffSql's comment). A count BELOW
    // expectedRows means the build genuinely lost pre-existing content keys,
    // which is the real failure this check exists to catch. excessAfter
    // stays a strict == 0 check regardless of timing -- a LIMIT 1 BY-built
    // table must never have internal duplicates.
    const verifyRes = await client.query({ query: buildVerifyDedupedTableSql(), format: 'JSONEachRow' })
    const [verify] = (await verifyRes.json()) as Array<{ cdedup_rows: string; excess_after: string }>
    const cdedupRows = Number(verify?.cdedup_rows ?? -1)
    const excessAfter = Number(verify?.excess_after ?? -1)
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
