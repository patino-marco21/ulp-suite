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
 * MECHANISM: a heavyweight `ALTER TABLE ... DELETE`, chunked into
 * CONTENT_DEDUP_BUCKET_COUNT (default 1024) hash buckets and run one bucket at
 * a time. For each content group it keeps the single row with the smallest
 * full-row hash (FULL_HASH, which includes _part/_part_offset — see its own
 * comment below) and deletes the rest.
 *
 * SAFETY: report-only by default. It logs how many rows it WOULD delete; nothing
 * is removed unless CONTENT_DEDUP_APPLY=true. The scheduled cron
 * (lib/dedup-cron.ts) invokes this routine; operators can also run the verified
 * content-key cleanup script at scripts/dedup-credentials-content.sh, or the
 * bucket-range rollout script at scripts/content-dedup-bucket-run.sh.
 *
 * SCALE: this mechanism went through two prior designs before this one, both
 * confirmed broken live against the real table (neither caught earlier because
 * verification used a `CREATE TABLE ... AS SELECT` disposable clone, which does
 * not carry over projections):
 *   1. Lightweight `DELETE FROM` — rejected outright by the table's
 *      `proj_imported_desc` projection (Code 344 SUPPORT_IS_DISABLED; lightweight
 *      deletes need lightweight_mutation_projection_mode='rebuild'/'drop', and
 *      this table leaves it at the default 'throw'). Confirmed live 2026-07-06.
 *   2. Unchunked heavyweight `ALTER TABLE ... DELETE` — handles projections
 *      natively, and is fast at small scale (3M rows: ~3s), but confirmed live
 *      (twice, from a clean/idle memory baseline) to fail with
 *      MEMORY_LIMIT_EXCEEDED roughly 25 times in a row at 13.2M rows (2.8% of
 *      the real table) before eventually succeeding via ClickHouse's automatic
 *      mutation retry — not an acceptable production behavior at the real
 *      table's 467M-row scale. max_bytes_before_external_group_by (below) only
 *      bounds the GROUP BY aggregation; it does nothing for the separate memory
 *      cost of rewriting parts containing this table's ~9 complex MATERIALIZED
 *      columns, which is what was actually spiking.
 * This version buckets the heavyweight DELETE by
 * `cityHash64(CONTENT_KEY) % bucketCount` (see contentDuplicatePredicateForBucket
 * below), confirmed live to complete a 13.2M-row sample (that failed ~25 times
 * unchunked) across 16 buckets with zero memory errors. Full investigation:
 * docs/superpowers/specs/2026-07-06-content-dedup-bucketed-delete-design.md
 * (supersedes docs/superpowers/specs/2026-07-04-content-dedup-scale-fix-design.md).
 *
 * Uses `mutations_sync = 1` per bucket (block until that one bucket's mutation
 * completes — simpler sequential control flow than polling system.mutations)
 * and `allow_nondeterministic_mutations = 1` (required because the WHERE
 * clause's subquery references the same table being mutated).
 *
 * TWO-PART execution-time fix (confirmed live 2026-07-07 — bucket 0 of a real
 * 1024-bucket run against the real table failed twice with Code 159
 * TIMEOUT_EXCEEDED, both cleanly killed with zero rows affected, before this
 * was understood and fixed):
 *   1. This query's own `max_execution_time = 0` bounds the FOREGROUND
 *      `mutations_sync = 1` wait — without it, the client-side wait for a
 *      slow bucket could itself time out even if the mutation eventually
 *      succeeds.
 *   2. That alone is NOT sufficient: a mutation's BACKGROUND per-part rewrite
 *      work does not inherit `max_execution_time` from this SETTINGS clause
 *      at all — confirmed via live testing (polled a stuck mutation for 5+
 *      minutes; parts_to_do never moved, because some real parts here take
 *      longer than 60s to rewrite their 9 MATERIALIZED columns, and every
 *      retry hit the same 60s wall before finishing) and via the matching,
 *      still-open upstream issue ClickHouse/ClickHouse#61759. The actual fix
 *      for the background half is raising `max_execution_time` in
 *      docker/clickhouse/users/ulp-profiles.xml's default profile (60 -> 3600)
 *      — see that file's comment. The app's own queries are unaffected (its
 *      client already sets max_execution_time=60 explicitly; see
 *      lib/clickhouse.ts).
 * The bucket predicate's `cityHash64(CONTENT_KEY) % bucketCount` filter can't
 * be indexed, so every bucket's mutation still evaluates it across the whole
 * table — bucketing bounds memory (few rows per bucket to GROUP), not
 * scan-plus-part-rewrite time, which is what this two-part fix addresses.
 *
 * Do not set CONTENT_DEDUP_APPLY=true for the full automatic sweep until the
 * design doc's Rollout Plan checkpoint (buckets 0-31 of 1024, run manually via
 * scripts/content-dedup-bucket-run.sh against real data) has completed and
 * been reviewed.
 */
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

/** Content identity: same destination + same credential (scheme/trailing-slash-insensitive on the URL). */
export const CONTENT_KEY = `${URL_CONTENT_KEY}, email, password`

/**
 * Full-row hash — picks one deterministic survivor per content group.
 * Includes ClickHouse's virtual `_part`/`_part_offset` columns so that two
 * rows can never hash equal even when every real column is byte-for-byte
 * identical (every physical row has a unique (_part, _part_offset) pair).
 * Earlier versions of this hash omitted these two columns: exact full-tuple
 * duplicates all shared one hash equal to their own group min, so `NOT IN`
 * was false for all of them and none were deletable — confirmed live
 * 2026-07-06 with 3 deliberately-inserted identical rows (all 3 shared one
 * cityHash64, so none were deletable), quantified at ~3.2% of duplicate rows
 * surviving a "successful" run this way against a 13.2M-row real-data sample.
 * See docs/superpowers/specs/2026-07-06-content-dedup-bucketed-delete-design.md.
 */
export const FULL_HASH =
  'cityHash64(url, email, password, domain, source_file, breach_name, imported_at, _part, _part_offset)'

/**
 * Content-duplicate predicate scoped to one bucket of `bucketCount`.
 * Chunking by `cityHash64(CONTENT_KEY) % bucketCount` bounds each mutation's
 * memory footprint: a content-duplicate group's rows always share the same
 * CONTENT_KEY, so they always hash to the same bucket and can never be split
 * across two — chunking cannot affect correctness. Both the outer WHERE and
 * the inner subquery's GROUP BY are scoped to the same bucket, so the
 * subquery's cardinality (and its memory cost) is bounded to ~1/bucketCount
 * of the table instead of the whole table.
 *
 * IMPORTANT: this must keep the literal substring `GROUP BY ${CONTENT_KEY}`
 * in the emitted SQL — MUTATION_MARKER below matches on it to detect an
 * in-flight bucket mutation across process restarts. Do not restructure the
 * GROUP BY clause without preserving this exact substring.
 */
export function contentDuplicatePredicateForBucket(bucketIndex: number, bucketCount: number): string {
  const bucketFilter = `cityHash64(${CONTENT_KEY}) % ${bucketCount} = ${bucketIndex}`
  return `${bucketFilter} AND ${FULL_HASH} NOT IN (SELECT min(${FULL_HASH}) FROM ulp.credentials WHERE ${bucketFilter} GROUP BY ${CONTENT_KEY})`
}

/** Distinctive substring of the DELETE command, for the in-flight mutation check. */
const MUTATION_MARKER = `GROUP BY ${CONTENT_KEY}`

export function buildStatsSql(): string {
  return `SELECT
    count() AS total,
    uniqExact(cityHash64(${CONTENT_KEY})) AS distinct_creds,
    total - distinct_creds AS excess
  FROM ulp.credentials
  SETTINGS max_execution_time = 300`
}

/**
 * Heavyweight ALTER TABLE DELETE for one bucket — handles the table's
 * projection natively (unlike lightweight DELETE FROM, which this table
 * rejects outright; see the file's SCALE comment).
 */
export function buildDeleteSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `ALTER TABLE ulp.credentials DELETE WHERE ${contentDuplicatePredicateForBucket(bucketIndex, bucketCount)}`
}

/**
 * Memory ceiling for each bucket's DELETE mutation inline subquery (see
 * contentDuplicatePredicateForBucket). Confirmed live 2026-07-04: without an
 * equivalent bound, the unchunked version of this subquery exceeded 4 GiB in
 * ~1.6s; with it, it succeeds via disk spill. No max_memory_usage override is
 * set alongside this anywhere it's used — that pairing made spilling
 * unreachable in an unrelated query profile (lib/clickhouse-query-limits.ts's
 * exportGroupBySettings()), so it's deliberately avoided here too.
 */
export const CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES = 4_294_967_296 // 4 GiB

/**
 * Bounds concurrent subquery re-evaluation across the background merge pool
 * (mirrors scripts/purge-existing-t3.sh's max_threads=2).
 */
export const CONTENT_DEDUP_MAX_THREADS = 2

/** Full statement runContentDedupTick() submits per bucket — exported so its exact shape is testable. */
export function buildDeleteExecSqlForBucket(bucketIndex: number, bucketCount: number): string {
  return `${buildDeleteSqlForBucket(bucketIndex, bucketCount)} SETTINGS mutations_sync = 1, allow_nondeterministic_mutations = 1, max_execution_time = 0, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_bytes_before_external_group_by = ${CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES}`
}

// ── env knobs (pure, testable) ──────────────────────────────────────────────────

/** Cron interval in hours; 0 (or invalid) disables the scheduled job. Default 24. */
export function dedupCronHours(env: NodeJS.ProcessEnv = process.env): number {
  const h = parseInt(env.DEDUP_CRON_HOURS ?? '24', 10)
  return Number.isFinite(h) && h > 0 ? h : 0
}

/** Whether the destructive DELETE is allowed to run. Default false (report-only). */
export function contentDedupApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTENT_DEDUP_APPLY === 'true' || env.CONTENT_DEDUP_APPLY === '1'
}

/** Don't fire a (heavy) mutation unless at least this many excess rows exist. Default 1000. */
export function minExcessToApply(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.DEDUP_MIN_EXCESS ?? '1000', 10)
  return Number.isFinite(n) && n >= 0 ? n : 1000
}

/**
 * Number of hash buckets the DELETE mutation is chunked into (bounds each
 * mutation's memory footprint — see the file's SCALE comment). Default 1024.
 */
export function contentDedupBucketCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.CONTENT_DEDUP_BUCKET_COUNT ?? '1024', 10)
  return Number.isFinite(n) && n >= 1 ? n : 1024
}

/**
 * UTC hour (0-23) the daily cron tick is anchored to. Default 4 (04:00 UTC).
 * Previously the first tick fired 60s after whatever moment the app container
 * happened to start, so its daily recurrence landed at an arbitrary wall-clock
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
 * excess clears the threshold — submit the bucketed DELETE sweep. Never throws.
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

    // Don't stack mutations: skip if a content-dedup DELETE is already running.
    const mutRes = await client.query({
      query: `SELECT count() AS c FROM system.mutations
              WHERE database='ulp' AND table='credentials' AND is_done=0
                AND command LIKE {marker:String}`,
      query_params: { marker: `%${MUTATION_MARKER}%` },
      format: 'JSONEachRow',
    })
    const [mut] = (await mutRes.json()) as Array<{ c: string }>
    if (Number(mut?.c ?? 0) > 0) {
      console.log('[content-dedup] a dedup mutation is already running — skipping')
      return { total, excess, applied: false }
    }

    const bucketCount = contentDedupBucketCount()
    console.log(`[content-dedup] submitting bucketed DELETE across ${bucketCount} buckets (~${excess} duplicate rows total)`)
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      await client.exec({ query: buildDeleteExecSqlForBucket(bucket, bucketCount) })
    }
    console.log(`[content-dedup] completed bucketed DELETE (${bucketCount} buckets, ~${excess} duplicate rows)`)
    return { total, excess, applied: true }
  } catch (err) {
    console.error('[content-dedup] tick error:', err instanceof Error ? err.message : String(err))
    return { total: 0, excess: 0, applied: false }
  } finally {
    tickInFlight = false
  }
}
