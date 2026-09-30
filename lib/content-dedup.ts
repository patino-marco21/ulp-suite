/**
 * Content-level deduplication of ulp.credentials — the durable successor to the
 * one-time manual script (scripts/dedup-credentials-content.sh, retired
 * 2026-09-30 -- see git history) it grew out of.
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
 * avoid mutations for large transformations, and the approach the since-retired
 * scripts/dedup-credentials-content.sh proved out). Builds a deduplicated copy of
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
 * (lib/dedup-cron.ts) invokes this routine; operators can trigger the same
 * guarded, bucketed code path by hand with scripts/run-content-dedup-once.ts.
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
 * ZK PATH REUSE: AUTO_DEDUP_TABLE's ReplicatedMergeTree ZooKeeper path
 * includes a per-cycle unique suffix (rewriteCreateTableDdl's third
 * argument, `String(Date.now())` at the call site) rather than being a
 * fixed string derived from the table name alone. Confirmed live
 * 2026-07-19: RENAME TABLE is metadata-only and never moves a table's
 * underlying ZK registration -- so after the first successful swap,
 * whichever physical table becomes ulp.credentials permanently keeps the ZK
 * path it was originally built with. A fixed AUTO_DEDUP_TABLE path
 * therefore collides with the LIVE table on every cycle after the first
 * successful one, not just with a leftover build table -- reproduced on
 * disposable tables and confirmed this is not scale- or data-specific. The
 * per-cycle suffix sidesteps this entirely: each cycle's build table gets a
 * ZK path no prior or future cycle can ever reuse, so this cannot recur
 * regardless of how many cycles run or what state a prior one left behind.
 * Steps 2/3's cleanup and buildRenameSwapSql's RENAME are unaffected --
 * both operate on the fixed SQL table names, not the ZK path, so they work
 * identically regardless of which physical path either name currently
 * points to. A live retry surfaced a second bug from this same root fact:
 * rewriteCreateTableDdl's ZK-path match was a literal-string suffix
 * (`/ulp/credentials'`) that assumed ulp.credentials' own current path
 * always ends that way -- false as soon as the table has ever been through
 * one successful swap, at which point its real path already ends in
 * /ulp/credentials_cdedup_auto. That mismatch made the match silently find
 * nothing and leave the ZK path completely unrewritten (no exception),
 * reproducing REPLICA_ALREADY_EXISTS via a different path than the
 * uniqueSuffix fix targets. Fixed by matching the ZK path structurally
 * (`/ulp/` plus whatever follows to the closing quote) instead of assuming
 * a fixed suffix -- see rewriteCreateTableDdl's own comment. Full design:
 * docs/superpowers/specs/2026-07-19-content-dedup-zk-path-reuse-design.md
 *
 * DISTINCT-COUNT SCALE (superseded 2026-09-29 -- see below): buildStatsSql(),
 * buildCutoffSql(), and buildVerifyDedupedTableSql() (all removed) each ran
 * uniqExact(cityHash64(CONTENT_KEY)) as a single ungrouped aggregate over a
 * large table (ulp.credentials for the first two, AUTO_DEDUP_TABLE for the
 * third -- itself the same order of magnitude once populated, since a
 * successfully-built dedup table has ~one row per distinct content key) --
 * confirmed live 2026-07-19 to hit MEMORY_LIMIT_EXCEEDED at 562M rows /
 * ~470M distinct content keys, right at this server's 16 GiB ceiling.
 * Unlike the populate step's own memory fix below, neither max_threads
 * bounding nor max_bytes_before_external_group_by spilling had any effect
 * at the time (both confirmed live to make no difference, including
 * reshaped into a real multi-group GROUP BY) -- a zero-key uniqExact holds
 * one hash set for the query's whole duration with nothing for either lever
 * to act on. buildCutoffTimestampSql()/buildContentKeyStatsSqlForBucket()/
 * buildVerifyDedupedTableSqlForBucket() (all now ALSO removed, see below)
 * replaced them with a 200-bucket loop, summing per-bucket uniqExact counts
 * for an exact (not approximate) total via the same
 * content-duplicate-group-hashes-to-one-bucket guarantee.
 *
 * SUPERSEDED 2026-09-29: the 200-bucket loop traded the 2026-07-19 memory
 * problem for a severe time problem -- `WHERE cityHash64(CONTENT_KEY) %
 * bucketCount = i` is completely unprunable (the hash has zero correlation
 * with the table's physical (domain, email, imported_at) order), so every
 * bucket cost a full table scan: confirmed live, ~107s/bucket at 2.78B
 * rows, ~6h for one full pass, needed twice per tick before populate even
 * starts. Re-tested the "reshaped into a real multi-group GROUP BY" option
 * the 2026-07-19 note says failed -- it now succeeds, confirmed live TWICE:
 * once grouping on the table's own materialized content_key_hash column
 * (101.76s, 11.42 GiB peak) and once reproducing the exact 2026-07-19 query
 * shape, grouping on the live cityHash64(CONTENT_KEY) expression instead
 * (203.04s, 11.89 GiB peak, slower from the extra regex work but still
 * comfortably under the 16 GiB ceiling) -- both against the real table,
 * both giving the identical correct result
 * (total=2,778,102,283, distinctCreds=1,393,449,551). Since even the more
 * expensive of the two shapes now succeeds, the 2026-07-19 failure wasn't
 * about expression-vs-column; something about ClickHouse's own
 * external-group-by spilling has improved since then (most likely a
 * version upgrade -- this instance runs 26.3.17). buildContentKeyStatsSql()
 * and buildVerifyDedupedTableStatsSql() now do the whole table in one pass
 * each via GROUP BY content_key_hash + max_bytes_before_external_group_by,
 * reading the materialized column directly rather than recomputing
 * CONTENT_KEY's regexes per row. Full design:
 * docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md
 * (superseded) and docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md.
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
 * DEFERRED PROJECTIONS (2026-09-30): the clone is created WITHOUT
 * ulp.credentials' PROJECTIONs (buildDedupedTableCreateDdl) and
 * proj_email_domain_rev and proj_imported_desc are restored on the live table after the swap and
 * catch-up (tick step 9). Projections were 64% of the table's 381 GiB, and
 * building with them cost ~18 GiB per populate bucket against ~6.5 without --
 * enough to trip the disk guard against the real 2.78B-row table three times.
 * Nothing is lost: a projection only re-stores columns the base table already
 * has. Full reasoning, including why proj_domain_reversed is retired rather
 * than restored: lib/credentials-projections.ts.
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
import { createDiskGuard, DiskHeadroomError, type DiskGuard } from '@/lib/clickhouse-disk-guard'
import {
  EMAIL_DOMAIN_REV_PROJECTION_NAME,
  restoreEmailDomainRevProjection,
  restoreImportedDescProjection,
  stripProjectionsFromCreateTableDdl,
} from '@/lib/credentials-projections'

/** Content identity: same destination + same credential (scheme/trailing-slash-insensitive on the URL). */
export const CONTENT_KEY = `${URL_CONTENT_KEY}, email, password`

/** Build target for the rewrite+swap cycle. The _auto suffix keeps it distinct from ulp.credentials_cdedup, the name the retired manual script used. */
export const AUTO_DEDUP_TABLE = 'ulp.credentials_cdedup_auto'

/** Archived original after a successful swap -- kept one full cron interval as a rollback safety net (see ROLLBACK above). */
export const AUTO_PREDUP_TABLE = 'ulp.credentials_predup_auto'

/**
 * Deterministic tie-break for LIMIT 1 BY: keeps the earliest imported_at per
 * content key. Mirrored the (since-retired) scripts/dedup-credentials-content.sh's ORDER exactly
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
 *
 * The ZK path is matched structurally -- `/ulp/` followed by whatever comes
 * next up to the closing quote -- and that whole tail is replaced, rather
 * than matching a fixed literal suffix (`/ulp/credentials'`, this function's
 * shape before 2026-07-20). Confirmed live 2026-07-20: after a successful
 * swap, ulp.credentials' REAL current ZK path already ends in
 * /ulp/credentials_cdedup_auto, not /ulp/credentials (RENAME TABLE never
 * moves a table's ZK registration -- see the file's ZK PATH REUSE comment).
 * A literal-suffix match against that shape found no match and silently
 * left the DDL's ZK path completely unrewritten -- no exception, just a
 * no-op `.replace()` -- reproducing REPLICA_ALREADY_EXISTS via a different
 * mechanism than the bug uniqueSuffix (below) exists to fix. The structural
 * match is agnostic to whatever the source's current path actually is: the
 * target path only ever depends on targetTable and uniqueSuffix, confirmed
 * by a unit test asserting identical output from both a never-swapped and
 * an already-swapped source fixture.
 *
 * `uniqueSuffix` is appended to the ZK path so it can never collide with a
 * path any prior or future cycle used -- see the file's ZK PATH REUSE
 * comment for why a fixed path collides with the live table itself, not
 * just a leftover build table. Left as a caller-supplied parameter (not
 * generated internally) so this function stays pure and its existing
 * exact-match unit tests keep working with a fixed value.
 *
 * Throws if the rewrite didn't actually land -- defense in depth per the
 * final review of the 2026-07-19/20 fixes: a "confirmed correct against the
 * real schema" match has already gone silently stale once this session (the
 * literal-suffix match this structural one replaced). Rather than trust the
 * next such assumption to hold forever, a no-op rewrite fails loudly here
 * (caught safely by runContentDedupTick's existing outer try/catch) instead
 * of silently returning DDL that would go on to collide with an existing
 * table's ZK path.
 */
export function rewriteCreateTableDdl(showCreateSql: string, targetTable: string, uniqueSuffix: string): string {
  const targetShortName = targetTable.split('.')[1]
  const lines = showCreateSql.split('\n')
  lines[0] = lines[0].replace('ulp.credentials', targetTable)
  const rewritten = lines.join('\n').replace(/(\/ulp\/)[^']*'/, `$1${targetShortName}_${uniqueSuffix}'`)
  const expectedMarker = `${targetShortName}_${uniqueSuffix}'`
  if (!rewritten.includes(expectedMarker)) {
    throw new Error(`[content-dedup] rewriteCreateTableDdl failed to rewrite the ZK path -- expected to find '${expectedMarker}' in the output but didn't. Refusing to return unrewritten DDL.`)
  }
  return rewritten
}

/**
 * The CREATE TABLE for AUTO_DEDUP_TABLE: rewriteCreateTableDdl's clone with
 * every PROJECTION stripped out -- the DEFERRED PROJECTIONS approach described
 * in the file header. The clone keeps the base table and all skip indexes;
 * proj_imported_desc is restored on the live table after the swap
 * (restoreImportedDescProjection, tick step 9). Pure, so the combination is
 * unit-testable.
 */
export function buildDedupedTableCreateDdl(showCreateSql: string, uniqueSuffix: string): string {
  return stripProjectionsFromCreateTableDdl(rewriteCreateTableDdl(showCreateSql, AUTO_DEDUP_TABLE, uniqueSuffix))
}

/**
 * Trivial single value, captured before the populate step's bucket scan
 * starts (step 5 below) -- the stats query, earlier in the same tick, is
 * fine to precede this. See runContentDedupTick's step 1 comment for why
 * this ordering still keeps the CATCH-UP guarantee intact even though
 * expectedRows (from buildContentKeyStatsSql below) is no longer captured
 * atomically with this value, unlike the old single-query buildCutoffSql().
 */
export function buildCutoffTimestampSql(): string {
  return `SELECT now() AS cutoff`
}

/**
 * REPLACED 2026-09-29 (was buildContentKeyStatsSqlForBucket, a 200-bucket
 * loop -- see git history). That approach existed because a zero-key
 * `uniqExact(cityHash64(CONTENT_KEY))` with no GROUP BY can't spill to disk
 * (confirmed live 2026-07-19: neither max_threads nor
 * max_bytes_before_external_group_by has any effect on that query shape --
 * the spill mechanism only helps multi-group GROUP BY). But bucketing paid
 * for that memory safety with a 200x scan multiplier: `WHERE
 * cityHash64(CONTENT_KEY) % bucketCount = i` is completely unprunable (the
 * hash has zero correlation with the table's physical (domain, email,
 * imported_at) order), so every one of the 200 buckets cost a full table
 * scan -- confirmed live 2026-09-29, ~107s/bucket at 2.78B rows, ~6h for one
 * full pass, and runContentDedupTick needs this twice before populate even
 * starts.
 *
 * An actual multi-group `GROUP BY content_key_hash` (not a zero-key
 * uniqExact) DOES support `max_bytes_before_external_group_by` spilling --
 * this was never tried as an alternative to bucketing, only as a failed
 * mitigation for the zero-key shape. Confirmed live 2026-09-29 against the
 * real 2.78B-row table: 101.76s, 11.42 GiB peak (under the 16 GiB ceiling),
 * exact match against the old bucketed result (total=2,778,102,283,
 * distinctCreds=1,393,449,551). content_key_hash is the table's own
 * MATERIALIZED cityHash64(CONTENT_KEY) column (migration v18) -- reading it
 * directly also skips recomputing the two regexes per row that CONTENT_KEY
 * would otherwise require live.
 */
export function buildContentKeyStatsSql(): string {
  return `SELECT
    sum(c) AS total,
    count() AS distinctCreds
  FROM (
    SELECT content_key_hash, count() AS c
    FROM ulp.credentials
    GROUP BY content_key_hash
  )
  SETTINGS max_bytes_before_external_group_by = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_execution_time = 900`
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
 * Bounds concurrent sort/insert parallelism against this table (also used
 * by buildCatchupInsertSql's small, still-sort-based catch-up query).
 * Raised 2 -> 6 on 2026-09-29 alongside the argMin rewrite below --
 * confirmed live at 6 threads / 16 buckets: 284.6s/bucket, 9.13 GiB peak
 * (51% of the 18 GiB ceiling, real margin remaining) vs 732.8s/bucket at
 * the old value of 2. The original 2026-07-08 constraint (this table's ~9
 * MATERIALIZED columns being recomputed per row on the INSERT side across
 * concurrent threads) still applies in principle, but the argMin rewrite's
 * smaller aggregation-side footprint leaves enough headroom for more
 * threads than the old sort-based shape could safely afford.
 */
export const CONTENT_DEDUP_MAX_THREADS = 6

/**
 * Number of hash buckets the populate step is chunked into. Lowered
 * 200 -> 16 on 2026-09-29 alongside the argMin rewrite below: the old
 * sort-based query needed 200 buckets to bound sort memory at this
 * table's 2.78B-row scale; argMin's per-group state is smaller, and at
 * 16 buckets (1.39B/16 ~= 87M groups/bucket) live-confirmed 2026-09-29 to
 * use only 4.05 GiB for the read-only aggregation (22% of the 18 GiB
 * ceiling) and 9.13 GiB for the real INSERT at max_threads=6 (51%) --
 * comfortable margin at both. Every bucket's hash filter is still
 * unprunable (content_key_hash has zero correlation with the table's
 * physical (domain, email, imported_at) order), so each bucket still
 * costs one full table scan -- fewer buckets directly means fewer
 * re-scans. `.env`'s CONTENT_DEDUP_BUCKET_COUNT=16 overrides this
 * function's fallback default (32, untouched -- not re-validated at
 * smaller table sizes, kept as a conservative default for fresh installs).
 */
export function contentDedupBucketCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.CONTENT_DEDUP_BUCKET_COUNT ?? '32', 10)
  return Number.isFinite(n) && n >= 1 ? n : 32
}

/**
 * Builds AUTO_DEDUP_TABLE's share for one bucket: one row per content key
 * whose hash falls in this bucket, keeping the earliest imported_at. A
 * content-duplicate group's rows always share the same content_key_hash,
 * so they always hash to the same bucket and can never split across two --
 * chunking cannot affect correctness.
 *
 * REWRITTEN 2026-09-29 (was `ORDER BY ... LIMIT 1 BY` -- see git history):
 * that shape needed a full sort of the bucket's rows by
 * CONTENT_DEDUP_SURVIVOR_ORDER before LIMIT 1 BY could pick a survivor --
 * confirmed live 2026-09-29 that even a single-pass (unbucketed) attempt
 * at this hits MEMORY_LIMIT_EXCEEDED for real ("would use 18.18 GiB...
 * maximum: 18.00 GiB"), unlike the stats query's zero-key uniqExact (see
 * buildContentKeyStatsSql's comment) -- sorting is a genuinely heavier
 * operation than hash-grouping at this scale, so bucketing is still
 * required here, just no longer via a sort. `argMin(col, imported_at)` per
 * column picks that column's value from whichever row has the minimum
 * imported_at within its content_key_hash group -- the same "earliest
 * wins" survivor semantic as before, computed via GROUP BY (which can
 * spill to disk, per buildContentKeyStatsSql's finding) instead of a full
 * sort (which, confirmed live, still can't). email and password are
 * argMin'd the same way as every other column even though, as exact-match
 * content-key components, they're already byte-identical within one
 * content_key_hash group -- argMin still returns the correct (only
 * possible) value for them, and using the same aggregate uniformly across
 * every output column is simpler than special-casing the two that happen
 * to be constant.
 *
 * was_duplicated (UInt8 DEFAULT 0, added in migration v21): true if this
 * content key ever had more than one row, this cycle or any prior one.
 * `greatest(max(was_duplicated), if(count() > 1, 1, 0))` is the GROUP BY
 * equivalent of the old window-function version's
 * `greatest(was_duplicated, if(count() OVER (...) > 1, 1, 0))` --
 * max(was_duplicated) across the group catches "some row was already
 * flagged from a prior cycle" the same way the old per-row greatest() did,
 * and count() > 1 catches new duplication in this cycle. Deliberately a
 * boolean, not a count: file-level repackaging in this dataset means a
 * precise "seen N times" number would mostly measure redistribution
 * churn, not genuine independent sightings -- see
 * docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md.
 *
 * Explicit INSERT column list (not `SELECT *`): GROUP BY's aggregate
 * projection can't produce the table's MATERIALIZED columns the way a
 * plain row-selecting SELECT * could -- ClickHouse computes those
 * automatically for the listed real columns on the INSERT side regardless.
 */
export function buildPopulateDedupedTableSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `INSERT INTO ${AUTO_DEDUP_TABLE} (url, email, password, domain, source_file, breach_name, imported_at, was_duplicated)
  SELECT
    argMin(url, imported_at),
    argMin(email, imported_at),
    argMin(password, imported_at),
    argMin(domain, imported_at),
    argMin(source_file, imported_at),
    argMin(breach_name, imported_at),
    min(imported_at),
    greatest(max(was_duplicated), if(count() > 1, 1, 0))
  FROM ulp.credentials
  WHERE content_key_hash % ${bucketCount} = ${bucketIndex}
  GROUP BY content_key_hash
  SETTINGS max_bytes_before_external_group_by = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_execution_time = 1800, timeout_overflow_mode = 'throw'`
}

/**
 * REPLACED 2026-09-29 (was buildVerifyDedupedTableSqlForBucket, same
 * 200-bucket-loop shape and same fix as buildContentKeyStatsSql above --
 * see that function's comment for the full reasoning and live numbers).
 * AUTO_DEDUP_TABLE's own row count and internal excess -- does not query
 * the original table (that comparison uses the cutoff step's expectedRows,
 * captured before the build started, via runContentDedupTick's `>=` check).
 * AUTO_DEDUP_TABLE has the same content_key_hash MATERIALIZED column as
 * ulp.credentials (cloned via SHOW CREATE TABLE), so the same single-pass
 * GROUP BY applies directly, and should be faster still: ~half the row
 * count post-dedup, nearly all distinct by construction.
 */
export function buildVerifyDedupedTableStatsSql(): string {
  return `SELECT
    sum(c) AS total,
    count() AS distinctCreds
  FROM (
    SELECT content_key_hash, count() AS c
    FROM ${AUTO_DEDUP_TABLE}
    GROUP BY content_key_hash
  )
  SETTINGS max_bytes_before_external_group_by = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_execution_time = 900`
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

/**
 * DROP for a table this routine manages (AUTO_PREDUP_TABLE / AUTO_DEDUP_TABLE).
 * SYNC for the ZK-path reason given at tick step 2. `max_table_size_to_drop = 0`
 * lifts ClickHouse's size guard: the server default is 50 GB (unchanged here) and
 * a bigger table is refused with Code 359 TABLE_SIZE_EXCEEDS_MAX_DROP_SIZE_LIMIT
 * -- yet the archived original is 381 GiB and even a later cycle's archive is
 * ~185 GiB, so without this the tick's step 2 would throw on every applying run
 * after the first and the cron could never rebuild again. Confirmed live
 * 2026-09-30 (bare DROP under a too-small limit errors and leaves the table; the
 * SETTINGS form drops it). Only ever called with this file's own constants.
 */
export function buildDropTableSql(table: string): string {
  return `DROP TABLE IF EXISTS ${table} SYNC SETTINGS max_table_size_to_drop = 0`
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
 *
 * "Already present" is checked by PROBING the live table with the (tiny) set
 * of candidate keys, never by building a set of the live table's keys --
 * REWRITTEN 2026-09-30. The earlier shape, `NOT IN (SELECT cityHash64(
 * CONTENT_KEY) FROM ulp.credentials)`, makes ClickHouse build an in-memory
 * hash set (no disk spill exists for IN-sets) of every distinct content key:
 * at today's 1.39B keys that is a ~34 GB open-addressing table (8-byte
 * slots, <= 50% fill) against the server's 18 GiB per-query limit. It passed
 * in 2026-07 only because the table then had ~467M keys, and since this step
 * runs AFTER the swap it would have failed at the very end of a ~2h cutover.
 * Reading the table's own MATERIALIZED content_key_hash (== cityHash64(
 * CONTENT_KEY), what populate already groups on) for just the candidate keys
 * is a single-column scan with a few-row result set.
 *
 * Confirmed live 2026-09-30 against the real 2.78B-row table (same 1.39B
 * distinct keys the new table will have), old shape vs this one, each with the
 * table standing in for its own archive: the old shape died after 57s with
 * MEMORY_LIMIT_EXCEEDED ("would use 28.73 GiB (attempt to allocate chunk of
 * 16.00 GiB)... While executing CreatingSetsTransform"); this shape ran the
 * identical probe (1.1M candidate rows) in 77s at a 628 MiB peak. A side-by-side
 * run of both shapes on small tables built from the real schema -- covering a
 * key already present under a different URL spelling, a within-batch duplicate,
 * a pre-cutoff row and a pre-flagged row -- inserted identical rows.
 */
export function buildCatchupInsertSql(cutoff: string): string {
  return `INSERT INTO ulp.credentials
  SELECT * REPLACE (greatest(was_duplicated, if(count() OVER (PARTITION BY ${CONTENT_KEY}) > 1, 1, 0)) AS was_duplicated) FROM ${AUTO_PREDUP_TABLE}
  WHERE imported_at > '${cutoff}'
    AND cityHash64(${CONTENT_KEY}) NOT IN (SELECT content_key_hash FROM ulp.credentials WHERE content_key_hash IN (SELECT cityHash64(${CONTENT_KEY}) FROM ${AUTO_PREDUP_TABLE} WHERE imported_at > '${cutoff}'))
  ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}
  LIMIT 1 BY ${CONTENT_KEY}
  SETTINGS max_bytes_before_external_sort = ${CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES}, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_insert_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_execution_time = 1800, timeout_overflow_mode = 'throw'`
}

/**
 * Populates AUTO_DEDUP_TABLE one bucket at a time, guarded by a disk-headroom
 * check before each bucket. On a trip, drops the partial AUTO_DEDUP_TABLE
 * immediately -- rather than leaving it for the next day's tick (step 2/3's
 * own cleanup, 24h away) to find -- before re-throwing. Takes client and guard
 * as parameters (not module-scope state) so it's independently testable with
 * plain fake objects, no ClickHouse-module mocking required.
 * See docs/superpowers/specs/2026-09-28-clickhouse-disk-headroom-guard-design.md.
 */
export async function populateDedupedTableWithGuard(
  client: ClickHouseClient,
  bucketCount: number,
  guard: DiskGuard,
): Promise<void> {
  await guard.preflight()
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    try {
      await guard.checkBeforeIteration(undefined, { index: bucket, total: bucketCount })
    } catch (err) {
      if (err instanceof DiskHeadroomError) {
        // A failing cleanup must not replace the guard's error -- that is the real
        // reason the run stopped. The next tick's step 3 retries the drop anyway.
        try {
          await client.exec({ query: buildDropTableSql(AUTO_DEDUP_TABLE) })
        } catch (dropErr) {
          console.error('[content-dedup] cleanup DROP of the partial build failed (original error re-thrown):', dropErr instanceof Error ? dropErr.message : String(dropErr))
        }
      }
      throw err
    }
    await client.exec({ query: buildPopulateDedupedTableSqlForBucket(bucket, bucketCount) })
  }
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

/**
 * What the most recent completed, non-applying stats pass saw. In-process, like the
 * project's other single-node caches: a restart costs one full pass, exactly today's
 * cost. Reset to null whenever a tick goes on to rebuild the table.
 */
interface LastStatsPass { rows: number; total: number; excess: number; at: number }
let lastStatsPass: LastStatsPass | null = null

export interface DedupTickResult {
  total: number
  excess: number
  applied: boolean
  /** Only set when applied: whether the deferred projections were restored after the swap (see tick step 9). */
  projectionsRestored?: boolean
  /** Only set on a cron tick that found the table unchanged and skipped the stats scan. */
  skipped?: boolean
}

/** A cron tick runs the full stats pass at least this often, even when the row count never changes. */
export const STATS_FORCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/** Metadata-only (no table scan): rows across the active parts of ulp.credentials. */
export function buildTableRowCountSql(): string {
  return `SELECT sum(rows) AS rows
  FROM system.parts
  WHERE database = 'ulp' AND table = 'credentials' AND active`
}

/**
 * Whether a cron tick may skip the heavy stats scan. Duplicates (excess) can only grow
 * through inserts, and every insert changes the row count; deletes cannot create
 * duplicates. The one blind spot -- an in-place mutation that rewrites key columns
 * without changing the count -- is covered by the forced full pass every
 * STATS_FORCE_INTERVAL_MS. Fails open: an unreadable count (null) or no previous pass
 * never skips.
 */
export function shouldSkipStatsPass(params: {
  rows: number | null
  last: { rows: number; at: number } | null
  now: number
  maxAgeMs?: number
}): boolean {
  const { rows, last, now, maxAgeMs = STATS_FORCE_INTERVAL_MS } = params
  if (rows === null || last === null) return false
  return rows === last.rows && now - last.at < maxAgeMs
}

/** null = could not be read; callers then fall through to the full pass (fail open). */
async function queryTableRowCount(client: ClickHouseClient): Promise<number | null> {
  try {
    const res = await client.query({ query: buildTableRowCountSql(), format: 'JSONEachRow' })
    const [row] = (await res.json()) as Array<{ rows: string }>
    const n = Number(row?.rows)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Runs each deferred-projection restore on its own, so one failing (most likely a disk-guard
 * trip) never blocks the others. True only if every restorer succeeded. A failure is reported
 * with the re-run command but never turns the tick into applied: false -- the swap and
 * catch-up are already done and ulp.credentials is correct without the projections.
 */
export async function restoreDeferredProjections(
  trigger: string,
  restorers: Array<{ name: string; run: () => Promise<unknown> }>,
): Promise<boolean> {
  let allRestored = true
  for (const { name, run } of restorers) {
    try {
      await run()
    } catch (err) {
      allRestored = false
      console.error(
        `[content-dedup] ${trigger}: swap and catch-up succeeded, but restoring ${name} failed -- ` +
          `ulp.credentials is live and correct, just without the projection for some partitions. ` +
          `Re-run with: npx tsx scripts/run-content-dedup-once.ts --restore-projections. Cause:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  return allRestored
}

/**
 * Runs a single-pass total/distinct stats query -- shared by the stats
 * step, the cutoff step, and the verify step below, each passing its own
 * SQL (buildContentKeyStatsSql or buildVerifyDedupedTableStatsSql). Both
 * alias their two aggregates identically (`total`, `distinctCreds`)
 * specifically so this stays generic across the two call sites. Not
 * exported/unit-tested separately: this file only unit-tests pure SQL
 * builders, matching the existing convention that the populate step's own
 * bucket loop (inside runContentDedupTick) isn't unit-tested either, only
 * its SQL-builder function is.
 */
async function queryContentKeyStats(
  client: ClickHouseClient,
  sql: string,
): Promise<{ total: number; distinctCreds: number }> {
  const res = await client.query({ query: sql, format: 'JSONEachRow' })
  const [row] = (await res.json()) as Array<{ total: string; distinctCreds: string }>
  return { total: Number(row?.total ?? 0), distinctCreds: Number(row?.distinctCreds ?? 0) }
}

/**
 * Read duplicate stats, log them, and — only when CONTENT_DEDUP_APPLY is on and
 * excess clears the threshold — run the rewrite+swap cycle. Never throws.
 */
export async function runContentDedupTick(
  opts: { trigger?: string; skipIfUnchanged?: boolean } = {},
): Promise<DedupTickResult> {
  const trigger = opts.trigger ?? 'tick'
  if (tickInFlight) return { total: 0, excess: 0, applied: false }
  tickInFlight = true
  try {
    const client = getClient()
    const bucketCount = contentDedupBucketCount()

    // Idle short-circuit (cron ticks only). The stats pass below is a full GROUP BY over
    // every content key -- measured 2026-09-30 at 1.39B rows: 71 s, 9.3 GiB peak RAM and
    // 10.4 GiB spilled to temp disk -- and duplicates can only appear through inserts,
    // which change the row count. The count is read BEFORE the pass so rows imported while
    // it runs make the next tick measure again. See
    // docs/superpowers/specs/2026-09-30-query-perf-wins-design.md.
    const rowsBefore = opts.skipIfUnchanged ? await queryTableRowCount(client) : null
    const prior = lastStatsPass
    if (prior !== null && shouldSkipStatsPass({ rows: rowsBefore, last: prior, now: Date.now() })) {
      console.warn(
        `[content-dedup] ${trigger}: rows unchanged since the last stats pass (rows=${prior.rows}, ` +
          `${Math.round((Date.now() - prior.at) / 3_600_000)}h ago) -- skipping the stats scan`,
      )
      return { total: prior.total, excess: prior.excess, applied: false, skipped: true }
    }

    const { total, distinctCreds } = await queryContentKeyStats(client, buildContentKeyStatsSql())
    const excess = total - distinctCreds
    const applyOn = contentDedupApplyEnabled()
    const willApply = applyOn && excess >= minExcessToApply()

    console.warn(
      `[content-dedup] ${trigger}: total=${total} excess=${excess} willApply=${willApply}` +
        (applyOn ? '' : ' (report-only — set CONTENT_DEDUP_APPLY=true to enable cleanup)'),
    )
    if (!willApply) {
      if (rowsBefore !== null) lastStatsPass = { rows: rowsBefore, total, excess, at: Date.now() }
      return { total, excess, applied: false }
    }

    // Applying: forget what the last pass saw. The table is about to be rebuilt, so the
    // next tick must measure again (re-verifying excess = 0) rather than skip.
    lastStatsPass = null

    // 1. Capture cutoff BEFORE the populate step's bucket scan starts (step
    // 5 below), for CATCH-UP's own correctness (unchanged -- see the file's
    // CATCH-UP comment). The stats query above already ran once before this
    // point, which is fine -- CATCH-UP only requires cutoff to precede
    // POPULATE specifically. expectedRows is no longer captured atomically
    // with cutoff (see docs/superpowers/specs/2026-07-19-content-dedup-cutoff-stats-bucketing-design.md,
    // superseded but still the source of this reasoning) -- the query below
    // can pick up rows imported during its own scan window on top of what
    // existed at cutoff, but since ulp.credentials only ever gains rows here
    // (no concurrent deletes), that only ever makes expectedRows
    // equal-or-higher than the true cutoff-instant count, never lower -- so
    // the `cdedupRows >= expectedRows` check in step 6 below stays exactly
    // as conservative as it was when this was one atomic query.
    const cutoffRes = await client.query({ query: buildCutoffTimestampSql(), format: 'JSONEachRow' })
    const [cutoffRow] = (await cutoffRes.json()) as Array<{ cutoff: string }>
    const cutoff = cutoffRow?.cutoff
    if (!cutoff) throw new Error('[content-dedup] failed to capture cutoff timestamp')
    const { distinctCreds: expectedRows } = await queryContentKeyStats(client, buildContentKeyStatsSql())

    // 2. Drop the previous run's retained rollback safety net. SYNC matters:
    // ClickHouse's Atomic database engine (the default) doesn't drop a
    // ReplicatedMergeTree table's ZooKeeper replica registration immediately
    // -- it's deferred by database_atomic_delay_before_drop_table_sec
    // (default 480s). Without SYNC, a CREATE TABLE reusing this ZK path
    // moments later can race the still-pending cleanup and fail with
    // REPLICA_ALREADY_EXISTS -- confirmed live 2026-07-08, retrying this
    // exact tick right after a prior drop hit exactly that.
    await client.exec({ query: buildDropTableSql(AUTO_PREDUP_TABLE) })

    // 3. Drop any partial build left over from a crashed run -- an unattended
    // tick always starts fresh rather than trying to resume. SYNC for the
    // same reason as step 2: this table's ZK path is about to be reused by
    // step 4's CREATE TABLE moments later.
    await client.exec({ query: buildDropTableSql(AUTO_DEDUP_TABLE) })

    // 4. Create the deduped-table clone (schema + rewritten ZK path, unique
    // to this cycle -- see the file's ZK PATH REUSE comment for why a fixed
    // path eventually collides with the live table itself).
    const showCreateRes = await client.query({ query: 'SHOW CREATE TABLE ulp.credentials', format: 'JSONEachRow' })
    const [showCreateRow] = (await showCreateRes.json()) as Array<{ statement: string }>
    const showCreateSql = showCreateRow?.statement
    if (!showCreateSql) throw new Error('[content-dedup] SHOW CREATE TABLE returned nothing')
    await client.exec({ query: buildDedupedTableCreateDdl(showCreateSql, String(Date.now())) })

    // 4b. Ensure the still-empty clone has the full search-index set before it's
    // populated (see buildEnsureSearchIndexesSql's comment for why this exists
    // and why it never needs MATERIALIZE here).
    for (const stmt of buildEnsureSearchIndexesSql()) {
      await client.exec({ query: stmt })
    }

    // 5. Populate, one bucket at a time -- see the file's POPULATE SCALE
    // comment for why this runs as a sequential loop instead of one INSERT
    // (a real sort + per-row materialized-column recomputation on the write
    // path -- unlike the read-only stats/verify queries above and below,
    // still needs bucketing; see DISTINCT-COUNT SCALE's SUPERSEDED note).
    console.log(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets (~${excess} duplicate rows to remove)`)
    await populateDedupedTableWithGuard(client, bucketCount, createDiskGuard(AUTO_DEDUP_TABLE))

    // 6. Verify before swapping -- single-pass, see DISTINCT-COUNT SCALE's
    // SUPERSEDED note for why AUTO_DEDUP_TABLE no longer needs the bucketing
    // ulp.credentials' own stats/cutoff queries used to.
    // cdedupRows >= expectedRows (not ==): the build may have picked up a
    // few rows imported just after cutoff in addition to everything that
    // existed at that moment -- a good outcome, not a mismatch. A count
    // BELOW expectedRows means the build genuinely lost pre-existing
    // content keys, which is the real failure this check exists to catch.
    // excessAfter stays a strict == 0 check regardless of timing -- a
    // LIMIT 1 BY-built table must never have internal duplicates.
    const { total: cdedupRows, distinctCreds: cdedupDistinct } = await queryContentKeyStats(client, buildVerifyDedupedTableStatsSql())
    const excessAfter = cdedupRows - cdedupDistinct
    if (cdedupRows < expectedRows || excessAfter !== 0) {
      console.error(
        `[content-dedup] verification failed (cdedup_rows=${cdedupRows} expected_rows=${expectedRows} excess_after=${excessAfter}) -- aborting, original table untouched`,
      )
      await client.exec({ query: buildDropTableSql(AUTO_DEDUP_TABLE) })
      return { total, excess, applied: false }
    }

    // 7. Swap.
    await client.exec({ query: buildRenameSwapSql() })

    // 8. Catch up anything imported during the build window.
    await client.exec({ query: buildCatchupInsertSql(cutoff) })

    // 9. Restore the projections deferred out of the build (see DEFERRED
    // PROJECTIONS in the file header). The swap and catch-up are already done
    // and ulp.credentials is correct without them -- the "newest first" default
    // sort and the monitor's email_domain scan are merely slower (the resolver
    // falls back on its own) -- so a failure here (most likely a disk-guard trip
    // while the archived original is still on disk) is reported but must NOT turn
    // this into applied: false. The small email_domain one goes first.
    const projectionsRestored = await restoreDeferredProjections(trigger, [
      { name: EMAIL_DOMAIN_REV_PROJECTION_NAME, run: () => restoreEmailDomainRevProjection(client, createDiskGuard('ulp.credentials')) },
      { name: 'proj_imported_desc', run: () => restoreImportedDescProjection(client, createDiskGuard('ulp.credentials')) },
    ])

    console.log(`[content-dedup] ${trigger}: completed rewrite+swap (~${excess} duplicate rows removed, projectionsRestored=${projectionsRestored})`)
    return { total, excess, applied: true, projectionsRestored }
  } catch (err) {
    console.error('[content-dedup] tick error:', err instanceof Error ? err.message : String(err))
    return { total: 0, excess: 0, applied: false }
  } finally {
    tickInFlight = false
  }
}
