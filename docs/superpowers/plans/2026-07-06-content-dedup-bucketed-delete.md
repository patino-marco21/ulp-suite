# Content-Dedup Bucketed Delete + Tie-Break Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `lib/content-dedup.ts`'s DELETE mechanism so `CONTENT_DEDUP_APPLY` can eventually be safely enabled: bucket the heavyweight `ALTER TABLE ... DELETE` so each mutation's memory footprint stays bounded, and extend the tie-break hash so exact full-tuple duplicate rows are no longer left behind.

**Architecture:** Chunk the DELETE by `cityHash64(CONTENT_KEY) % bucketCount` into up to 1024 (configurable) sequential heavyweight `ALTER TABLE ... DELETE` mutations — every row in a content-duplicate group shares one `CONTENT_KEY`, so it always hashes into the same bucket, making chunking correctness-neutral. Both the outer `WHERE` and the inner tie-break subquery are scoped to the same bucket, bounding the subquery's `GROUP BY` cardinality to ~1/bucketCount of the table. Extend `FULL_HASH` with ClickHouse's `_part`/`_part_offset` virtual columns so two physical rows can never hash equal, even when byte-for-byte identical. Roll out against real production data in two stages: buckets 0–31 of 1024 as a supervised checkpoint, then a separate, later decision on the full automatic sweep.

**Tech Stack:** TypeScript (Next.js `lib` module), Vitest, ClickHouse (heavyweight `ALTER TABLE` mutations against a `ReplicatedMergeTree` table with a projection), bash + Docker (rollout script).

## Global Constraints

- Bucket count default is **1024**, env var `CONTENT_DEDUP_BUCKET_COUNT`, read via a new `contentDedupBucketCount(env)` function matching this file's existing `dedupCronHours`/`minExcessToApply`/`dedupCronHourUtc` convention exactly (optional `env: NodeJS.ProcessEnv = process.env` param, `parseInt` with a validated fallback).
- `FULL_HASH` must be exactly: `cityHash64(url, email, password, domain, source_file, breach_name, imported_at, _part, _part_offset)`.
- `CONTENT_KEY` is unchanged: `` `${URL_CONTENT_KEY}, email, password` ``.
- The DELETE mechanism is heavyweight `ALTER TABLE ulp.credentials DELETE WHERE ...` — never lightweight `DELETE FROM` (lightweight deletes are rejected outright by this table's projection; see the file's SCALE comment).
- Every bucket's exec settings are exactly: `mutations_sync = 1, allow_nondeterministic_mutations = 1, max_threads = 2, max_bytes_before_external_group_by = 4294967296` (the last two reuse the existing `CONTENT_DEDUP_MAX_THREADS`/`CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES` constants — do not hand-write their numeric values in new code).
- Every bucket's mutation command text must contain the literal substring `GROUP BY ${CONTENT_KEY}` verbatim — this is what the existing `MUTATION_MARKER`/`system.mutations` overlap-guard in `runContentDedupTick` matches on. Do not restructure the `GROUP BY` clause in a way that breaks this substring match.
- Scope is limited to: `lib/content-dedup.ts`, `__tests__/content-dedup.test.ts`, `.env.example`, and a new `scripts/content-dedup-bucket-run.sh`. Do not touch `lib/dedup-cron.ts`, any `app/api` route, or any other file — none of them import anything this plan removes or renames.
- `CONTENT_DEDUP_APPLY` stays `false` in the live `.env` for the entire duration of this plan. No task here sets it to `true`.
- Rollout is staged: after buckets 0–31 of 1024 run successfully against real data (Task 4), **stop and report back**. Do not run further buckets and do not enable `CONTENT_DEDUP_APPLY=true` without a fresh, separate decision from the user at that point.

---

### Task 1: Bucket-parameterized SQL builders, tie-break fix, and wiring

**Files:**
- Modify (full rewrite): `lib/content-dedup.ts`
- Modify (full rewrite): `__tests__/content-dedup.test.ts`
- Modify: `.env.example:67` (add `CONTENT_DEDUP_BUCKET_COUNT` after the existing `DEDUP_MIN_EXCESS` line)

**Interfaces:**
- Produces (used by Tasks 2–4 and by `scripts/content-dedup-bucket-run.sh`):
  - `CONTENT_KEY: string` (unchanged export)
  - `FULL_HASH: string` (value changes, export name unchanged)
  - `contentDuplicatePredicateForBucket(bucketIndex: number, bucketCount: number): string` (new)
  - `buildDeleteSqlForBucket(bucketIndex: number, bucketCount: number): string` (new)
  - `buildDeleteExecSqlForBucket(bucketIndex: number, bucketCount: number): string` (new)
  - `contentDedupBucketCount(env?: NodeJS.ProcessEnv): number` (new)
  - `buildStatsSql(): string` (unchanged)
  - `CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES: number`, `CONTENT_DEDUP_MAX_THREADS: number` (unchanged)
  - `runContentDedupTick(opts): Promise<DedupTickResult>` (unchanged signature and return shape; internal apply-path behavior changes)
  - Removed: `CONTENT_DUPLICATE_PREDICATE`, `buildDeleteSql()`, `buildDeleteExecSql()` (bucket-unaware versions) — confirmed via repo-wide grep that no file outside `lib/content-dedup.ts` and `__tests__/content-dedup.test.ts` references these, so removing them is safe.

- [ ] **Step 1: Write the new test file (will fail to import — that's expected RED)**

Replace the entire contents of `__tests__/content-dedup.test.ts` with:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import {
  CONTENT_KEY,
  FULL_HASH,
  buildStatsSql,
  contentDuplicatePredicateForBucket,
  buildDeleteSqlForBucket,
  buildDeleteExecSqlForBucket,
  CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

describe('content-dedup', () => {
  test('does not claim that an import-time hook still triggers content dedup', () => {
    const source = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('post-import hook')
  })
  test('CONTENT_KEY ignores url scheme/trailing-slash (email, password stay exact)', () => {
    expect(CONTENT_KEY).toBe(`${URL_CONTENT_KEY}, email, password`)
  })

  describe('FULL_HASH', () => {
    test('includes _part and _part_offset so exact full-tuple duplicates never tie', () => {
      expect(FULL_HASH).toBe(
        'cityHash64(url, email, password, domain, source_file, breach_name, imported_at, _part, _part_offset)',
      )
    })
  })

  describe('contentDuplicatePredicateForBucket', () => {
    const sql = contentDuplicatePredicateForBucket(5, 1024)
    test('scopes the outer filter to the given bucket', () => {
      expect(sql).toContain(`cityHash64(${CONTENT_KEY}) % 1024 = 5`)
    })
    test('scopes the tie-break subquery to the same bucket', () => {
      expect(sql).toContain(
        `NOT IN (SELECT min(${FULL_HASH}) FROM ulp.credentials WHERE cityHash64(${CONTENT_KEY}) % 1024 = 5 GROUP BY ${CONTENT_KEY})`,
      )
    })
    test('preserves the literal "GROUP BY <CONTENT_KEY>" substring the in-flight mutation check matches on', () => {
      expect(sql).toContain(`GROUP BY ${CONTENT_KEY}`)
    })
    test('a different bucket index/count changes both the filter and the subquery scope', () => {
      const other = contentDuplicatePredicateForBucket(0, 8)
      expect(other).toContain(`cityHash64(${CONTENT_KEY}) % 8 = 0`)
      expect(other).not.toContain('% 1024 = 5')
    })
  })

  describe('buildDeleteSqlForBucket', () => {
    const sql = buildDeleteSqlForBucket(2, 16)
    test('is a heavyweight ALTER TABLE DELETE on ulp.credentials, not a lightweight DELETE FROM', () => {
      expect(sql.startsWith('ALTER TABLE ulp.credentials DELETE WHERE')).toBe(true)
      expect(sql).not.toContain('DELETE FROM')
    })
    test('embeds this bucket\'s predicate', () => {
      expect(sql).toContain(`cityHash64(${CONTENT_KEY}) % 16 = 2`)
    })
    test('never includes its own SETTINGS clause', () => {
      // buildDeleteExecSqlForBucket() appends the real SETTINGS clause -- a
      // second one here would make the combined statement invalid SQL.
      expect(sql).not.toContain('SETTINGS')
    })
  })

  describe('CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES', () => {
    test('is 4 GiB', () => {
      expect(CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES).toBe(4_294_967_296)
    })
  })

  describe('CONTENT_DEDUP_MAX_THREADS', () => {
    test('is 2', () => {
      expect(CONTENT_DEDUP_MAX_THREADS).toBe(2)
    })
  })

  describe('buildDeleteExecSqlForBucket', () => {
    test('combines the bucketed delete with mutations_sync, nondeterministic-mutations allowance, bounded threads, and external group-by spill in exactly one SETTINGS clause', () => {
      const sql = buildDeleteExecSqlForBucket(2, 16)
      expect(sql).toContain('ALTER TABLE ulp.credentials DELETE WHERE')
      expect(sql).toContain(
        'SETTINGS mutations_sync = 1, allow_nondeterministic_mutations = 1, max_threads = 2, max_bytes_before_external_group_by = 4294967296',
      )
      expect(sql.match(/SETTINGS/g)?.length).toBe(1)
    })
  })

  describe('buildStatsSql', () => {
    const sql = buildStatsSql()
    test('reports total and excess in one pass without the duplicate subquery', () => {
      expect(sql).toContain(`uniqExact(cityHash64(${URL_CONTENT_KEY}, email, password))`)
      expect(sql).toContain('AS excess')
      expect(sql).not.toContain('AS deletable')
      expect(sql).not.toContain('countIf(')
    })
  })

  describe('contentDedupBucketCount', () => {
    test('defaults to 1024', () => {
      expect(contentDedupBucketCount({})).toBe(1024)
    })
    test('honors a configured count', () => {
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: '256' })).toBe(256)
    })
    test('invalid or non-positive falls back to 1024', () => {
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: '0' })).toBe(1024)
      expect(contentDedupBucketCount({ CONTENT_DEDUP_BUCKET_COUNT: 'nope' })).toBe(1024)
    })
  })

  describe('dedupCronHours', () => {
    test('defaults to 24h', () => {
      expect(dedupCronHours({})).toBe(24)
    })
    test('honors a positive value', () => {
      expect(dedupCronHours({ DEDUP_CRON_HOURS: '6' })).toBe(6)
    })
    test('0 / invalid disables (returns 0)', () => {
      expect(dedupCronHours({ DEDUP_CRON_HOURS: '0' })).toBe(0)
      expect(dedupCronHours({ DEDUP_CRON_HOURS: 'nope' })).toBe(0)
    })
  })

  describe('contentDedupApplyEnabled', () => {
    test('off by default (report-only)', () => {
      expect(contentDedupApplyEnabled({})).toBe(false)
      expect(contentDedupApplyEnabled({ CONTENT_DEDUP_APPLY: 'false' })).toBe(false)
    })
    test('on for "true" or "1"', () => {
      expect(contentDedupApplyEnabled({ CONTENT_DEDUP_APPLY: 'true' })).toBe(true)
      expect(contentDedupApplyEnabled({ CONTENT_DEDUP_APPLY: '1' })).toBe(true)
    })
  })

  describe('minExcessToApply', () => {
    test('defaults to 1000', () => {
      expect(minExcessToApply({})).toBe(1000)
    })
    test('honors a custom threshold', () => {
      expect(minExcessToApply({ DEDUP_MIN_EXCESS: '50' })).toBe(50)
    })
  })

  describe('dedupCronHourUtc', () => {
    test('defaults to 4 (04:00 UTC)', () => {
      expect(dedupCronHourUtc({})).toBe(4)
    })
    test('honors a configured hour', () => {
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: '9' })).toBe(9)
    })
    test('out-of-range or invalid falls back to 4', () => {
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: '24' })).toBe(4)
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: '-1' })).toBe(4)
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: 'nope' })).toBe(4)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- content-dedup`
Expected: FAIL — `content-dedup.ts` has no exported member `contentDuplicatePredicateForBucket` (or similar import error), since the implementation hasn't changed yet.

- [ ] **Step 3: Replace `lib/content-dedup.ts` with the new implementation**

Replace the entire contents of `lib/content-dedup.ts` with:

```ts
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
 * completes — simpler sequential control flow than polling system.mutations,
 * and each bucket is small enough this won't hit a client timeout) and
 * `allow_nondeterministic_mutations = 1` (required because the WHERE clause's
 * subquery references the same table being mutated).
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
  return `${buildDeleteSqlForBucket(bucketIndex, bucketCount)} SETTINGS mutations_sync = 1, allow_nondeterministic_mutations = 1, max_threads = ${CONTENT_DEDUP_MAX_THREADS}, max_bytes_before_external_group_by = ${CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES}`
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- content-dedup`
Expected: PASS — all tests in `__tests__/content-dedup.test.ts` green.

- [ ] **Step 5: Add the new env knob to `.env.example`**

In `.env.example`, immediately after the existing line `DEDUP_MIN_EXCESS=1000` (currently line 67), add:

```
# Number of hash buckets the DELETE mutation is chunked into -- bounds memory
# per mutation (see lib/content-dedup.ts's SCALE comment). Default 1024.
CONTENT_DEDUP_BUCKET_COUNT=1024
```

- [ ] **Step 6: Run the full test suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS — in particular `__tests__/upload-processor.test.ts` (which mocks `@/lib/content-dedup`'s `runContentDedupTick`) and `__tests__/ulp-dedupe.test.ts`/`__tests__/url-content-key.test.ts` (unrelated modules that share `URL_CONTENT_KEY`) must still be green, since neither imports anything removed by this task.

- [ ] **Step 7: Commit**

```bash
git add lib/content-dedup.ts __tests__/content-dedup.test.ts .env.example
git commit -m "$(cat <<'EOF'
fix(content-dedup): bucket the heavyweight DELETE and fix tie-break hash

Chunk the DELETE by cityHash64(CONTENT_KEY) % bucketCount so each
mutation's memory footprint stays bounded (unchunked heavyweight DELETE
hit MEMORY_LIMIT_EXCEEDED repeatedly at 13.2M rows), and extend
FULL_HASH with _part/_part_offset so exact full-tuple duplicate rows
no longer survive a dedup run.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Disposable-clone verification

**Files:** None (no repository changes — this task is a live verification exercise against a temporary, disposable ClickHouse table, following the same practice used to design this fix). No commit at the end of this task.

**Interfaces:**
- Consumes: the exact SQL shape produced by Task 1's `contentDuplicatePredicateForBucket`/`buildDeleteExecSqlForBucket` (hand-mirrored below in bash, since this verification runs directly against Docker/ClickHouse rather than through the Next.js app).

This task proves the mechanism from Task 1 works correctly against a table that faithfully includes the real `proj_imported_desc` projection (a plain `CREATE TABLE ... AS SELECT` clone does NOT carry projections over — that gap is exactly what let the original lightweight-DELETE bug ship undetected).

- [ ] **Step 1: Create a projection-including disposable clone**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw \
  | sed -e 's/ulp\.credentials/ulp.credentials_buckettest/g' \
        -e "s|/clickhouse/tables/{shard}/ulp/credentials'|/clickhouse/tables/{shard}/ulp/credentials_buckettest'|" \
  | docker exec -i ulpsuite_clickhouse clickhouse-client --multiquery
```

Expected: no output, no error (`CREATE TABLE` succeeded).

- [ ] **Step 2: Verify the clone has the projection**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials_buckettest" --format TabSeparatedRaw | grep -c "PROJECTION proj_imported_desc"
```

Expected: `1`.

- [ ] **Step 3: Populate with a representative sample of real rows**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_buckettest
SELECT * FROM ulp.credentials LIMIT 3000000
"
```

Expected: completes without a client timeout (this exact row count was already confirmed live to complete in ~3s for the equivalent unchunked mutation, so population should be comparably fast — well under the default 60s client timeout).

- [ ] **Step 4: Insert deliberately-identical tie-break rows**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_buckettest (url, email, password, domain, source_file, breach_name, imported_at)
VALUES
  ('https://tiebreak-verify.test/', 'tiebreak-verify@test.local', 'samepassword123', 'tiebreak-verify.test', '__bucket_test_tiebreak__', 'test_breach', '2026-01-01 00:00:00'),
  ('https://tiebreak-verify.test/', 'tiebreak-verify@test.local', 'samepassword123', 'tiebreak-verify.test', '__bucket_test_tiebreak__', 'test_breach', '2026-01-01 00:00:00'),
  ('https://tiebreak-verify.test/', 'tiebreak-verify@test.local', 'samepassword123', 'tiebreak-verify.test', '__bucket_test_tiebreak__', 'test_breach', '2026-01-01 00:00:00')
"
```

- [ ] **Step 5: Record baseline stats**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() AS total, uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password)) AS distinct_creds, total - distinct_creds AS excess
FROM ulp.credentials_buckettest
FORMAT Vertical
"
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM ulp.credentials_buckettest WHERE source_file = '__bucket_test_tiebreak__'
"
```

Expected: `excess` > 0 (the 3 tie-break rows contribute 2 to it, plus whatever natural content-duplication exists in the sampled real rows); tie-break count is `3`.

- [ ] **Step 6: Run the bucketed DELETE across all buckets (bucketCount=8)**

This mirrors Task 1's `contentDuplicatePredicateForBucket`/`buildDeleteExecSqlForBucket` exactly, with `ulp.credentials_buckettest` substituted for `ulp.credentials`:

```bash
CONTENT_KEY="replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password"
FULL_HASH="cityHash64(url, email, password, domain, source_file, breach_name, imported_at, _part, _part_offset)"
BUCKET_COUNT=8

for BUCKET in $(seq 0 7); do
  echo "Bucket $BUCKET..."
  docker exec ulpsuite_clickhouse clickhouse-client --query "
    ALTER TABLE ulp.credentials_buckettest
    DELETE WHERE cityHash64($CONTENT_KEY) % $BUCKET_COUNT = $BUCKET
      AND $FULL_HASH NOT IN (
        SELECT min($FULL_HASH) FROM ulp.credentials_buckettest
        WHERE cityHash64($CONTENT_KEY) % $BUCKET_COUNT = $BUCKET
        GROUP BY $CONTENT_KEY
      )
    SETTINGS mutations_sync = 1, allow_nondeterministic_mutations = 1, max_threads = 2, max_bytes_before_external_group_by = 4294967296
  "
done
```

Expected: all 8 buckets complete without a `MEMORY_LIMIT_EXCEEDED` or any other error.

- [ ] **Step 7: Verify post-run stats**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() AS total, uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password)) AS distinct_creds, total - distinct_creds AS excess
FROM ulp.credentials_buckettest
FORMAT Vertical
"
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM ulp.credentials_buckettest WHERE source_file = '__bucket_test_tiebreak__'
"
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials_buckettest" --format TabSeparatedRaw | grep -c "PROJECTION proj_imported_desc"
```

Expected: `excess` is exactly `0` (buckets 0–7 with bucketCount=8 cover the entire keyspace with no gaps, so this is a full sweep of the clone); tie-break count is exactly `1`; projection count is still `1`.

- [ ] **Step 8: Clean up the clone**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE ulp.credentials_buckettest"
```

- [ ] **Step 9: Report results**

No commit for this task (no repository files changed). Report: baseline excess/tie-break counts, post-run excess/tie-break counts, confirmation of zero memory errors, and confirmation the projection survived. This is the "Disposable-clone verification" the spec's Testing section requires before proceeding to Task 3.

---

### Task 3: One-off bucket-range rollout script

**Files:**
- Create: `scripts/content-dedup-bucket-run.sh`

**Interfaces:**
- Consumes: no TypeScript imports (bash cannot import TS — this hand-mirrors `CONTENT_KEY`/`FULL_HASH`/the bucket predicate shape from Task 1, matching this codebase's existing precedent in `scripts/dedup-credentials-content.sh` of hand-copying `URL_CONTENT_KEY`'s exact expression into bash with an explicit "must stay byte-identical" comment).
- Produces: a script Task 4 invokes directly against real production data.

- [ ] **Step 1: Write the script**

Create `scripts/content-dedup-bucket-run.sh`:

```bash
#!/usr/bin/env bash
# One-off / re-runnable bucketed content-dedup DELETE against a bucket range.
#
# Mirrors lib/content-dedup.ts's contentDuplicatePredicateForBucket /
# buildDeleteExecSqlForBucket exactly -- bash can't import TS, so this
# hand-copies the same expressions (matching scripts/dedup-credentials-content.sh's
# existing precedent for this table). Keep CONTENT_KEY/FULL_HASH below
# byte-identical to lib/url-content-key.ts's URL_CONTENT_KEY and
# lib/content-dedup.ts's CONTENT_KEY / FULL_HASH.
#
# Dry-run by default (reports current duplicate scope only, submits nothing).
# Set APPLY=1 to actually run the DELETE mutations for the configured bucket
# range.
#
#   bash scripts/content-dedup-bucket-run.sh                                        # dry-run, buckets 0-31 of 1024
#   BUCKET_START=0 BUCKET_END=31 APPLY=1 bash scripts/content-dedup-bucket-run.sh    # apply buckets 0-31
#   BUCKET_START=32 BUCKET_END=63 APPLY=1 bash scripts/content-dedup-bucket-run.sh   # apply the next range
#
# See docs/superpowers/specs/2026-07-06-content-dedup-bucketed-delete-design.md
# for why this exists (Rollout Plan) and lib/content-dedup.ts's SCALE comment
# for why the DELETE is bucketed at all.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
APPLY="${APPLY:-0}"
BUCKET_START="${BUCKET_START:-0}"
BUCKET_END="${BUCKET_END:-31}"
BUCKET_COUNT="${BUCKET_COUNT:-1024}"

if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  if command -v docker.exe >/dev/null 2>&1 && docker.exe info >/dev/null 2>&1; then
    DOCKER_BIN="docker.exe"
  else
    echo "ERROR: Docker is unavailable in this shell." >&2
    exit 1
  fi
fi

if ! "$DOCKER_BIN" inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: ClickHouse container '$CONTAINER' is not running." >&2
  exit 1
fi

if [[ "$BUCKET_START" -lt 0 || "$BUCKET_END" -lt "$BUCKET_START" || "$BUCKET_END" -ge "$BUCKET_COUNT" ]]; then
  echo "ERROR: invalid bucket range BUCKET_START=$BUCKET_START BUCKET_END=$BUCKET_END BUCKET_COUNT=$BUCKET_COUNT" >&2
  exit 1
fi

ch() {
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "$1"
}

# Must stay byte-identical to lib/url-content-key.ts's URL_CONTENT_KEY and
# lib/content-dedup.ts's CONTENT_KEY / FULL_HASH. The `\$` below is
# bash-escaping for a literal `$` (RE2 end-of-string anchor).
CONTENT_KEY="replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password"
FULL_HASH="cityHash64(url, email, password, domain, source_file, breach_name, imported_at, _part, _part_offset)"
# Distinctive substring of the mutation command, for the in-flight check below --
# must match lib/content-dedup.ts's MUTATION_MARKER exactly.
MUTATION_MARKER="GROUP BY $CONTENT_KEY"

echo "ULP Suite - bucketed content-dedup DELETE"
echo "APPLY=$APPLY (0 = dry-run)"
echo "Buckets: $BUCKET_START..$BUCKET_END of $BUCKET_COUNT"
echo

active="$(ch "
SELECT count()
FROM system.mutations
WHERE database = 'ulp' AND table = 'credentials' AND is_done = 0
  AND command LIKE '%$MUTATION_MARKER%'
FORMAT TSVRaw
")"
if [[ "$active" != "0" ]]; then
  echo "ERROR: $active content-dedup mutation(s) already in flight; wait before running more buckets." >&2
  exit 1
fi

echo "Duplicate stats before this run (whole table):"
ch "
SELECT
  count() AS total,
  uniqExact(cityHash64($CONTENT_KEY)) AS distinct_creds,
  total - distinct_creds AS excess
FROM ulp.credentials
FORMAT Vertical
"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry-run complete; no mutation submitted."
  echo "To apply buckets $BUCKET_START-$BUCKET_END, run:"
  echo "  BUCKET_START=$BUCKET_START BUCKET_END=$BUCKET_END APPLY=1 bash scripts/content-dedup-bucket-run.sh"
  exit 0
fi

for BUCKET in $(seq "$BUCKET_START" "$BUCKET_END"); do
  echo
  echo "-- Bucket $BUCKET / $((BUCKET_COUNT - 1)) --"
  BUCKET_FILTER="cityHash64($CONTENT_KEY) % $BUCKET_COUNT = $BUCKET"
  start_ts=$(date +%s)
  ch "
    ALTER TABLE ulp.credentials
    DELETE WHERE $BUCKET_FILTER
      AND $FULL_HASH NOT IN (
        SELECT min($FULL_HASH) FROM ulp.credentials
        WHERE $BUCKET_FILTER
        GROUP BY $CONTENT_KEY
      )
    SETTINGS mutations_sync = 1,
             allow_nondeterministic_mutations = 1,
             max_threads = 2,
             max_bytes_before_external_group_by = 4294967296
  "
  elapsed=$(( $(date +%s) - start_ts ))
  echo "Bucket $BUCKET done in ${elapsed}s."
done

echo
echo "Duplicate stats after this run (whole table):"
ch "
SELECT
  count() AS total,
  uniqExact(cityHash64($CONTENT_KEY)) AS distinct_creds,
  total - distinct_creds AS excess
FROM ulp.credentials
FORMAT Vertical
"

echo
PROJ_COUNT="$(ch "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw | grep -c "proj_imported_desc" || true)"
echo "Projection present: $PROJ_COUNT (should be 1)"

echo
echo "Bucket range $BUCKET_START-$BUCKET_END of $BUCKET_COUNT complete."
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/content-dedup-bucket-run.sh
```

- [ ] **Step 3: Dry-run it against real data (no mutation submitted — safe)**

```bash
bash scripts/content-dedup-bucket-run.sh
```

Expected: prints current whole-table duplicate stats, then "Dry-run complete; no mutation submitted." Exit code 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/content-dedup-bucket-run.sh
git commit -m "$(cat <<'EOF'
feat(scripts): add bucket-range rollout script for content-dedup DELETE

One-off, re-runnable script to apply the bucketed content-dedup DELETE
against a specific bucket range of ulp.credentials -- dry-run by
default, matching this codebase's existing purge-script conventions.
Used for the buckets-0-31 rollout checkpoint described in
docs/superpowers/specs/2026-07-06-content-dedup-bucketed-delete-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

**Note on deployment:** neither this task's script nor Task 2's disposable-clone verification nor Task 4's rollout checkpoint touches the running app container — they all talk directly to ClickHouse via `docker exec` (confirmed live: the running `ulpsuite_app`/`ulpsuite_clickhouse` containers are anchored to the primary worktree at `/home/cole/ulp-suite`, a different directory than this branch's worktree, so rebuilding the app mid-plan would require pushing and merging first). None of Tasks 1–4 require `lib/content-dedup.ts`'s new code to be live in the running app — `runContentDedupTick`'s report-only path (`buildStatsSql()`) is unchanged between old and new code, and `CONTENT_DEDUP_APPLY` stays `false` throughout. Getting the code itself deployed is naturally handled whenever this branch is finished (`superpowers:finishing-a-development-branch`'s merge option rebuilds from the primary worktree); it isn't a prerequisite for any task here.

---

### Task 4: Rollout checkpoint — buckets 0–31 against real data, then stop

**Files:** None (no repository changes — this is the live rollout checkpoint itself). No commit at the end of this task.

**Interfaces:**
- Consumes: `scripts/content-dedup-bucket-run.sh` from Task 3, run against the real `ulp.credentials` table (467,106,345 rows as of this design).

> **This task runs a real heavyweight mutation against live production data.** Treat it with the same care as any other live production verification in this project: read every command's output before proceeding to the next step, and do not skip the dry-run in Step 1.

- [ ] **Step 1: Dry-run to confirm current scope**

```bash
bash scripts/content-dedup-bucket-run.sh
```

Expected: exit 0, prints `total`/`distinct_creds`/`excess` for the real table, "Dry-run complete; no mutation submitted."

- [ ] **Step 2: Apply buckets 0–31 of 1024 against real data**

```bash
BUCKET_START=0 BUCKET_END=31 APPLY=1 bash scripts/content-dedup-bucket-run.sh
```

Expected: 32 sequential "Bucket N / 1023" lines, each completing without a `MEMORY_LIMIT_EXCEEDED` or other error, followed by post-run stats and "Projection present: 1".

- [ ] **Step 3: Spot-check for any failed mutations**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT mutation_id, command, latest_fail_reason
FROM system.mutations
WHERE database = 'ulp' AND table = 'credentials' AND latest_fail_reason != ''
ORDER BY create_time DESC
LIMIT 10
FORMAT Vertical
"
```

Expected: no rows (no failures), or only failures with a `create_time` clearly predating this run.

- [ ] **Step 4: Stop and report**

Do not proceed to buckets 32–1023 and do not set `CONTENT_DEDUP_APPLY=true`. Report to the user:
- Before/after `excess` for the whole table (from Step 1 and Step 2's output).
- Confirmation of zero memory errors across the 32 buckets and their approximate total elapsed time.
- Confirmation the projection is still present.
- That enabling `CONTENT_DEDUP_APPLY=true` (which would run the full 1024-bucket sweep on every future cron tick) is a separate decision, not taken by this plan.
