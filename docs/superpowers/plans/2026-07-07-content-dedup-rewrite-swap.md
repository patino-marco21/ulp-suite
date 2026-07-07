# Content-Dedup Rewrite+Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `lib/content-dedup.ts`'s bucketed heavyweight-DELETE mechanism (which correctly bounds memory but structurally cannot bound time — every bucket rewrites every physical part regardless of bucket count) with an insert-select-rename ("rewrite+swap") mechanism, matching ClickHouse's own guidance and this codebase's already-proven `scripts/dedup-credentials-content.sh`.

**Architecture:** Build a deduplicated copy of `ulp.credentials` into a side table via `INSERT ... SELECT ... ORDER BY ... LIMIT 1 BY CONTENT_KEY`, verify it, atomically `RENAME` it into place, then copy over anything imported during the build window (a "catch-up" insert, since the ingest pipeline keeps writing to `ulp.credentials` throughout). The archived original is retained as a one-cycle rollback safety net.

**Tech Stack:** TypeScript (Next.js `lib` module), Vitest, ClickHouse (`INSERT ... SELECT ... LIMIT 1 BY`, `RENAME TABLE`).

## Global Constraints

- New table names: `AUTO_DEDUP_TABLE = 'ulp.credentials_cdedup_auto'` (build target), `AUTO_PREDUP_TABLE = 'ulp.credentials_predup_auto'` (archived original) — distinct from `scripts/dedup-credentials-content.sh`'s `_cdedup`/`_predup` names so the two can never collide.
- `CONTENT_DEDUP_SURVIVOR_ORDER = 'url, email, password, imported_at'` exactly — mirrors `scripts/dedup-credentials-content.sh`'s `ORDER` (raw `url` column, not the normalized `URL_CONTENT_KEY` expression; `imported_at ASC` is what decides the survivor among same-content-key rows).
- `CONTENT_KEY` is unchanged: `` `${URL_CONTENT_KEY}, email, password` ``.
- `cutoff` and `expectedRows` must be captured together, in one query, at the very start of the tick, against ClickHouse's own clock — never `Date.now()`/Node's clock (`imported_at` is a ClickHouse-side `DEFAULT now()` value; comparing it against a Node-clock timestamp risks skew-related bugs), and never re-queried later. `ulp.credentials` keeps receiving live inserts throughout the build, so a fresh `uniqExact` count taken at verify time (after the build already ran) would compare against a moving target and spuriously fail verification on a perfectly correct run, simply because more rows landed while the build was running.
- The catch-up `INSERT` must exclude content keys already present in the new table (`NOT IN (SELECT cityHash64(CONTENT_KEY) FROM ulp.credentials)`) and must itself be deduplicated (`LIMIT 1 BY CONTENT_KEY`) — `INSERT ... SELECT` has no strict snapshot isolation, so the main build may already have picked up some rows imported after cutoff.
- `AUTO_PREDUP_TABLE` is dropped only at the **start** of the next run, never at the end of the run that created it — this is the one-cycle rollback safety net described in the design.
- An unattended tick that finds a stale `AUTO_DEDUP_TABLE` (a partial build from a crashed run) always drops and rebuilds from scratch — never tries to resume, unlike the manual script.
- Verification compares the new table's row count against `expectedRows` with `>=`, not `==` (a build that captured a few extra rows landing just after cutoff is a good outcome, not a mismatch — see the point above). The new table's own internal excess (`count() - uniqExact(...)`) stays a strict `== 0` check regardless of timing. If either check fails, the tick drops `AUTO_DEDUP_TABLE` and returns `{ applied: false }` without touching the original table.
- Scope is limited to `lib/content-dedup.ts`, `__tests__/content-dedup.test.ts`, and `.env.example`. `scripts/content-dedup-bucket-run.sh` is deleted (nothing left to roll out by bucket range). `scripts/dedup-credentials-content.sh`, `lib/dedup-cron.ts`, and all `app/api` routes are unchanged.
- `CONTENT_DEDUP_APPLY` stays `false` in the live `.env` for the entire duration of this plan except during Task 3's single supervised invocation, which overrides it only within that invocation's own process, never in the real `.env` file.

---

### Task 1: Rewrite the mechanism, tests, and config

**Files:**
- Modify (full rewrite): `lib/content-dedup.ts`
- Modify (full rewrite): `__tests__/content-dedup.test.ts`
- Modify: `.env.example` (remove `CONTENT_DEDUP_BUCKET_COUNT`, change `DEDUP_CRON_HOURS`'s recommended default/comment from 24 to 168)
- Delete: `scripts/content-dedup-bucket-run.sh`

**Interfaces:**
- Produces (used by Tasks 2-3):
  - `CONTENT_KEY: string`, `buildStatsSql(): string` (unchanged exports)
  - `AUTO_DEDUP_TABLE: string`, `AUTO_PREDUP_TABLE: string`, `CONTENT_DEDUP_SURVIVOR_ORDER: string` (new consts)
  - `rewriteCreateTableDdl(showCreateSql: string, targetTable: string): string` (new, pure)
  - `buildCutoffSql(): string`, `buildPopulateDedupedTableSql(): string`, `buildVerifyDedupedTableSql(): string`, `buildRenameSwapSql(): string`, `buildCatchupInsertSql(cutoff: string): string` (new)
  - `runContentDedupTick(opts): Promise<DedupTickResult>` (unchanged signature and return shape; internal apply-path behavior fully replaced)
  - `contentDedupApplyEnabled()`, `minExcessToApply()`, `dedupCronHours()`, `dedupCronHourUtc()` (unchanged)
- Removed: `FULL_HASH`, `contentDuplicatePredicateForBucket`, `buildDeleteSqlForBucket`, `buildDeleteExecSqlForBucket`, `contentDedupBucketCount`, `CONTENT_DEDUP_MAX_THREADS`, `CONTENT_DEDUP_GROUP_BY_MAX_MEMORY_BYTES`, `CONTENT_DEDUP_POLL_INTERVAL_MS`, `CONTENT_DEDUP_BUCKET_MAX_WAIT_MS` — confirmed via repo-wide grep in the prior session that nothing outside `lib/content-dedup.ts` and its test file references any of these.

- [ ] **Step 1: Write the new test file (will fail to import — expected RED)**

Replace the entire contents of `__tests__/content-dedup.test.ts` with:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import {
  CONTENT_KEY,
  buildStatsSql,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffSql,
  buildPopulateDedupedTableSql,
  buildVerifyDedupedTableSql,
  buildRenameSwapSql,
  buildCatchupInsertSql,
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

  describe('buildStatsSql', () => {
    const sql = buildStatsSql()
    test('reports total and excess in one pass without a duplicate subquery', () => {
      expect(sql).toContain(`uniqExact(cityHash64(${URL_CONTENT_KEY}, email, password))`)
      expect(sql).toContain('AS excess')
      expect(sql).not.toContain('AS deletable')
      expect(sql).not.toContain('countIf(')
    })
  })

  describe('AUTO_DEDUP_TABLE / AUTO_PREDUP_TABLE', () => {
    test('are distinct from the manual script\'s _cdedup/_predup table names', () => {
      expect(AUTO_DEDUP_TABLE).toBe('ulp.credentials_cdedup_auto')
      expect(AUTO_PREDUP_TABLE).toBe('ulp.credentials_predup_auto')
    })
  })

  describe('CONTENT_DEDUP_SURVIVOR_ORDER', () => {
    test('mirrors scripts/dedup-credentials-content.sh\'s ORDER exactly', () => {
      expect(CONTENT_DEDUP_SURVIVOR_ORDER).toBe('url, email, password, imported_at')
    })
  })

  describe('rewriteCreateTableDdl', () => {
    const fixture = `CREATE TABLE ulp.credentials
(
    \`url\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`imported_at\` DateTime DEFAULT now() CODEC(Delta(4), ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials', '{replica}')
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)`

    test('rewrites the CREATE TABLE line to the target table name', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE)
      expect(result.split('\n')[0]).toBe(`CREATE TABLE ${AUTO_DEDUP_TABLE}`)
    })

    test('rewrites the ReplicatedMergeTree ZooKeeper path to match', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE)
      expect(result).toContain(`/ulp/credentials_cdedup_auto'`)
      expect(result).not.toContain(`/ulp/credentials'`)
    })

    test('leaves the rest of the DDL unchanged', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE)
      expect(result).toContain('`url` String CODEC(ZSTD(3))')
      expect(result).toContain('PARTITION BY toYYYYMM(imported_at)')
    })

    test('only rewrites the first occurrence of the table name (the CREATE TABLE line), not incidental matches elsewhere', () => {
      const result = rewriteCreateTableDdl(fixture, AUTO_DEDUP_TABLE)
      expect(result.match(/ulp\.credentials_cdedup_auto/g)?.length).toBe(1)
    })
  })

  describe('buildPopulateDedupedTableSql', () => {
    test('inserts a deduped copy keeping the earliest imported_at per content key', () => {
      const sql = buildPopulateDedupedTableSql()
      expect(sql).toContain(`INSERT INTO ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain('SELECT * FROM ulp.credentials')
      expect(sql).toContain(`ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}`)
      expect(sql).toContain(`LIMIT 1 BY ${CONTENT_KEY}`)
    })
  })

  describe('buildCutoffSql', () => {
    test('captures the clock time and the distinct content-key count together, in one query', () => {
      const sql = buildCutoffSql()
      expect(sql).toContain('now() AS cutoff')
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY})) AS expected_rows`)
      expect(sql).toContain('FROM ulp.credentials')
    })
  })

  describe('buildVerifyDedupedTableSql', () => {
    test('reports the deduped table\'s own row count and internal excess only -- does not separately query the original table', () => {
      const sql = buildVerifyDedupedTableSql()
      expect(sql).toContain(`FROM ${AUTO_DEDUP_TABLE}`)
      expect(sql).toContain(`uniqExact(cityHash64(${CONTENT_KEY}))`)
      expect(sql).toContain('AS cdedup_rows')
      expect(sql).toContain('AS excess_after')
      // Exactly one data source (AUTO_DEDUP_TABLE) -- the old design queried
      // the original ulp.credentials too, which is what caused the
      // moving-target verification bug this shape fixes.
      expect(sql.match(/FROM/g)?.length).toBe(1)
      expect(sql).not.toContain('expected_rows')
    })
  })

  describe('buildRenameSwapSql', () => {
    test('atomically renames the original to the predup name and the deduped copy into place', () => {
      const sql = buildRenameSwapSql()
      expect(sql).toBe(`RENAME TABLE ulp.credentials TO ${AUTO_PREDUP_TABLE}, ${AUTO_DEDUP_TABLE} TO ulp.credentials`)
    })
  })

  describe('buildCatchupInsertSql', () => {
    test('copies rows imported after cutoff, excluding content keys already present, deduplicated against itself', () => {
      const sql = buildCatchupInsertSql('2026-07-07 15:07:51')
      expect(sql).toContain('INSERT INTO ulp.credentials')
      expect(sql).toContain(`FROM ${AUTO_PREDUP_TABLE}`)
      expect(sql).toContain("WHERE imported_at > '2026-07-07 15:07:51'")
      expect(sql).toContain(`cityHash64(${CONTENT_KEY}) NOT IN (SELECT cityHash64(${CONTENT_KEY}) FROM ulp.credentials)`)
      expect(sql).toContain(`ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}`)
      expect(sql).toContain(`LIMIT 1 BY ${CONTENT_KEY}`)
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
Expected: FAIL — `content-dedup.ts` has no exported member `AUTO_DEDUP_TABLE` (or similar import error), since the implementation hasn't changed yet.

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

/** Builds AUTO_DEDUP_TABLE: one row per content key, keeping the earliest imported_at. */
export function buildPopulateDedupedTableSql(): string {
  return `INSERT INTO ${AUTO_DEDUP_TABLE}
  SELECT * FROM ulp.credentials
  ORDER BY ${CONTENT_DEDUP_SURVIVOR_ORDER}
  LIMIT 1 BY ${CONTENT_KEY}`
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
  LIMIT 1 BY ${CONTENT_KEY}`
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

    // 2. Drop the previous run's retained rollback safety net.
    await client.exec({ query: `DROP TABLE IF EXISTS ${AUTO_PREDUP_TABLE}` })

    // 3. Drop any partial build left over from a crashed run -- an unattended
    // tick always starts fresh rather than trying to resume.
    await client.exec({ query: `DROP TABLE IF EXISTS ${AUTO_DEDUP_TABLE}` })

    // 4. Create the deduped-table clone (schema + rewritten ZK path).
    const showCreateRes = await client.query({ query: 'SHOW CREATE TABLE ulp.credentials', format: 'JSONEachRow' })
    const [showCreateRow] = (await showCreateRes.json()) as Array<{ statement: string }>
    const showCreateSql = showCreateRow?.statement
    if (!showCreateSql) throw new Error('[content-dedup] SHOW CREATE TABLE returned nothing')
    await client.exec({ query: rewriteCreateTableDdl(showCreateSql, AUTO_DEDUP_TABLE) })

    // 5. Populate.
    console.log(`[content-dedup] ${trigger}: building deduped table (~${excess} duplicate rows to remove)`)
    await client.exec({ query: buildPopulateDedupedTableSql() })

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
      await client.exec({ query: `DROP TABLE IF EXISTS ${AUTO_DEDUP_TABLE}` })
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- content-dedup`
Expected: PASS — all tests in `__tests__/content-dedup.test.ts` green.

- [ ] **Step 5: Update `.env.example`**

Find the `Content deduplication` section of `.env.example`. Remove the
`CONTENT_DEDUP_BUCKET_COUNT` line and its comment entirely. Change the
`DEDUP_CRON_HOURS` line's comment and default value:

Replace:
```
# Cron cadence in hours (0 disables the scheduled job -- there is no separate
# import-time hook; scheduled ticks are the only trigger).
DEDUP_CRON_HOURS=24
```
With:
```
# Cron cadence in hours (0 disables the scheduled job -- there is no separate
# import-time hook; scheduled ticks are the only trigger). Recommended at 168
# (weekly), not daily: each tick rebuilds the whole table via insert-select-
# rename, not a bounded incremental mutation, so it isn't cheap enough to run
# every day.
DEDUP_CRON_HOURS=168
```

And remove this block entirely (it documented the now-deleted bucket-count knob):
```
# Number of hash buckets the DELETE mutation is chunked into -- bounds memory
# per mutation (see lib/content-dedup.ts's SCALE comment). Default 1024.
CONTENT_DEDUP_BUCKET_COUNT=1024
```

- [ ] **Step 6: Delete the now-unneeded rollout script**

```bash
git rm scripts/content-dedup-bucket-run.sh
```

- [ ] **Step 7: Run the full test suite and typecheck to confirm nothing else broke**

Run: `npm test`
Expected: PASS. In particular `__tests__/upload-processor.test.ts` (which mocks `@/lib/content-dedup`'s `runContentDedupTick`) must still be green, since it doesn't import anything removed by this task.

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/content-dedup.ts __tests__/content-dedup.test.ts .env.example
git commit -m "$(cat <<'EOF'
fix(content-dedup): replace bucketed mutations with insert-select-rename

Bucketed heavyweight DELETE correctly bounded memory, but every bucket
still rewrites every physical part regardless of bucket count --
confirmed live, a full 1024-bucket sweep against the real table (13
parts, one 315M-row/26GiB) would take weeks. Replaces the mechanism
entirely with insert-select-rename (matching ClickHouse's own guidance
and this codebase's existing scripts/dedup-credentials-content.sh),
adding a catch-up step so rows imported during the rebuild window
aren't lost. Deletes the now-unneeded bucket-range rollout script.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Disposable-clone verification

**Files:** None (no repository changes — live verification against a temporary, disposable ClickHouse table). No commit at the end of this task.

**Interfaces:**
- Consumes: the exact SQL shapes from Task 1's `buildCutoffSql`, `buildPopulateDedupedTableSql`, `buildVerifyDedupedTableSql`, `buildRenameSwapSql`, `buildCatchupInsertSql` (hand-mirrored below in bash against a clone table, since `runContentDedupTick` hardcodes `ulp.credentials`/`AUTO_DEDUP_TABLE`/`AUTO_PREDUP_TABLE` and cannot be pointed at a different table name — matching this session's established precedent for disposable-clone verification).

This task proves the mechanism works correctly against a table that faithfully includes the real `proj_imported_desc` projection, and specifically exercises the catch-up path (a genuinely-new row, and a row that was already caught by the main build) before this ever touches real production data.

- [ ] **Step 1: Create a projection-including disposable clone**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw \
  | sed -e 's/ulp\.credentials/ulp.credentials_rewritetest/g' \
        -e "s|/clickhouse/tables/{shard}/ulp/credentials'|/clickhouse/tables/{shard}/ulp/credentials_rewritetest'|" \
  | docker exec -i ulpsuite_clickhouse clickhouse-client --multiquery
```

Expected: no output, no error.

- [ ] **Step 2: Verify the clone has the projection**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials_rewritetest" --format TabSeparatedRaw | grep -c "PROJECTION proj_imported_desc"
```

Expected: `1`.

- [ ] **Step 3: Populate with a representative sample plus deliberate duplicates**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_rewritetest
SELECT * FROM ulp.credentials LIMIT 3000000
"
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_rewritetest (url, email, password, domain, source_file, breach_name, imported_at)
VALUES
  ('https://rewritetest-verify.test/', 'rewritetest-verify@test.local', 'samepassword123', 'rewritetest-verify.test', '__rewrite_test_dupe__', 'test_breach', '2026-01-01 00:00:00'),
  ('https://rewritetest-verify.test/', 'rewritetest-verify@test.local', 'samepassword123', 'rewritetest-verify.test', '__rewrite_test_dupe__', 'test_breach', '2026-01-02 00:00:00'),
  ('https://rewritetest-verify.test/', 'rewritetest-verify@test.local', 'samepassword123', 'rewritetest-verify.test', '__rewrite_test_dupe__', 'test_breach', '2026-01-03 00:00:00')
"
```

Expected: both complete without error. The three duplicate rows share a content key but differ in `imported_at`, so the earliest (`2026-01-01`) must be the one that survives.

- [ ] **Step 4: Create the build-target clone, capture cutoff + expectedRows together, then populate**

First, create `ulp.credentials_rewritetest_cdedup` (same technique as Step 1, targeting the `_cdedup` name):

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw \
  | sed -e 's/ulp\.credentials/ulp.credentials_rewritetest_cdedup/g' \
        -e "s|/clickhouse/tables/{shard}/ulp/credentials'|/clickhouse/tables/{shard}/ulp/credentials_rewritetest_cdedup'|" \
  | docker exec -i ulpsuite_clickhouse clickhouse-client --multiquery
```

Then capture `cutoff` and `expectedRows` together, in one query, **before** populating — matching `buildCutoffSql()`'s exact reasoning (both values must come from this one read, not be re-derived later, since the source table keeps changing):

```bash
CUTOFF_ROW=$(docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT now() AS cutoff, uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password)) AS expected_rows
FROM ulp.credentials_rewritetest
FORMAT TSV
")
CUTOFF=$(echo "$CUTOFF_ROW" | cut -f1)
EXPECTED_ROWS=$(echo "$CUTOFF_ROW" | cut -f2)
echo "cutoff=$CUTOFF expected_rows=$EXPECTED_ROWS"
```

Then populate:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_rewritetest_cdedup
SELECT * FROM ulp.credentials_rewritetest
ORDER BY url, email, password, imported_at
LIMIT 1 BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password
"
```

- [ ] **Step 5: Insert two rows simulating imports that happened during the build window**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_rewritetest (url, email, password, domain, source_file, breach_name, imported_at)
VALUES ('https://late-genuine.test/', 'late-genuine@test.local', 'latepass1', 'late-genuine.test', '__rewrite_test_late__', 'test_breach', now())
"
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_rewritetest_cdedup (url, email, password, domain, source_file, breach_name, imported_at)
VALUES ('https://late-already-caught.test/', 'late-already-caught@test.local', 'latepass2', 'late-already-caught.test', '__rewrite_test_late_caught__', 'test_breach', now())
"
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_rewritetest (url, email, password, domain, source_file, breach_name, imported_at)
VALUES ('https://late-already-caught.test/', 'late-already-caught@test.local', 'latepass2', 'late-already-caught.test', '__rewrite_test_late_caught__', 'test_breach', now())
"
```

This creates two scenarios happening after `$CUTOFF`: `late-genuine.test` exists only in the original table (simulating a row the main build never saw), and `late-already-caught.test` exists in **both** the deduped build and the original (simulating a row the main build happened to pick up despite arriving after cutoff).

- [ ] **Step 6: Verify the deduped build, then swap**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT
  count() AS cdedup_rows,
  count() - uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password)) AS excess_after
FROM ulp.credentials_rewritetest_cdedup
FORMAT Vertical
"
```

Expected: `excess_after` is `0` (the build has no internal duplicates). Then check `cdedup_rows` against `$EXPECTED_ROWS` captured in Step 4 — it must be `>=`, matching `buildVerifyDedupedTableSql()`'s exact semantics (the build ran before Step 5's late rows existed, so `cdedup_rows` should equal `$EXPECTED_ROWS` here, not exceed it — this step doesn't yet reflect Step 5's rows, which get handled by the catch-up step, not this verify check):

```bash
CDEDUP_ROWS=$(docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials_rewritetest_cdedup FORMAT TSVRaw")
echo "cdedup_rows=$CDEDUP_ROWS expected_rows=$EXPECTED_ROWS"
[ "$CDEDUP_ROWS" -ge "$EXPECTED_ROWS" ] && echo "PASS: cdedup_rows >= expected_rows" || echo "FAIL: cdedup_rows < expected_rows -- investigate before proceeding"
```

Only proceed to the swap once this prints `PASS`:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
RENAME TABLE ulp.credentials_rewritetest TO ulp.credentials_rewritetest_predup, ulp.credentials_rewritetest_cdedup TO ulp.credentials_rewritetest
"
```

- [ ] **Step 7: Run the catch-up insert**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_rewritetest
SELECT * FROM ulp.credentials_rewritetest_predup
WHERE imported_at > '$CUTOFF'
  AND cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password) NOT IN (
    SELECT cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password) FROM ulp.credentials_rewritetest
  )
ORDER BY url, email, password, imported_at
LIMIT 1 BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password
"
```

- [ ] **Step 8: Verify both catch-up scenarios landed correctly**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT source_file, count() FROM ulp.credentials_rewritetest
WHERE source_file IN ('__rewrite_test_late__', '__rewrite_test_late_caught__')
GROUP BY source_file
FORMAT PrettyCompact
"
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM ulp.credentials_rewritetest WHERE source_file = '__rewrite_test_dupe__'
"
```

Expected: `__rewrite_test_late__` count is exactly `1` (the genuinely-new row was correctly caught up). `__rewrite_test_late_caught__` count is exactly `1`, not `2` (the `NOT IN` guard correctly prevented double-insertion of a row the main build already had). The `__rewrite_test_dupe__` count is exactly `1` (the three deliberate duplicates correctly collapsed to one survivor).

- [ ] **Step 9: Verify the survivor among the deliberate duplicates is the earliest `imported_at`**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT imported_at FROM ulp.credentials_rewritetest WHERE source_file = '__rewrite_test_dupe__'
"
```

Expected: `2026-01-01 00:00:00` (the earliest of the three inserted in Step 3).

- [ ] **Step 10: Verify the projection survived the rename swap**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials_rewritetest" --format TabSeparatedRaw | grep -c "PROJECTION proj_imported_desc"
```

Expected: `1`.

- [ ] **Step 11: Clean up all test tables**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE IF EXISTS ulp.credentials_rewritetest"
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE IF EXISTS ulp.credentials_rewritetest_predup"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials"
```

Expected: the last query returns the real table's unchanged row count, confirming this entire task never touched real data (only tables with the `_rewritetest` prefix).

- [ ] **Step 12: Report results**

No commit for this task. Report: the verification numbers from Steps 6, 8, 9, and 10, and confirmation that Step 11's cleanup completed and the real table is unaffected.

---

### Task 3: Live rollout verification against real data

**Files:**
- Create (uncommitted, scratchpad only — do not `git add` this file): a one-off verification script under this session's scratchpad directory.

**Interfaces:**
- Consumes: `runContentDedupTick` from Task 1's `lib/content-dedup.ts`, invoked directly against real `ulp.credentials` (467M+ rows as of Task 1's implementation).

> **This task rebuilds and renames the real, live `ulp.credentials` table.** Treat it with the same care as any other live production verification in this project: confirm pre-state, read every command's output before proceeding, and confirm post-state independently (not just by trusting the script's own log lines) before considering this task done.

**A note on how this must run, confirmed live before writing this task:** the running `ulpsuite_app` container is a Next.js standalone production build — it has no TypeScript source files at all (only compiled `.next/` output), so a verification script cannot run inside it. It also isn't on the host's network path (`CLICKHOUSE_HOST=http://clickhouse:8123` only resolves inside the compose network). The working approach, verified end-to-end: run the script from this repository checkout (which has the real source, `node_modules`, and a locally-installed `tsx` — `npx tsx` only reliably resolves this project's `@/` path aliases when it finds a *locally installed* `tsx`, not the on-the-fly copy `npx` downloads when none is installed, which was confirmed to fail this exact resolution), while overriding `CLICKHOUSE_HOST` to the ClickHouse container's actual bridge-network IP address (resolved fresh each time, not hardcoded — container IPs can change across restarts) so the connection reaches it without needing the `clickhouse` hostname. Real credentials come from the primary worktree's `.env` (`.env` is gitignored and does not exist in a fresh session worktree).

- [ ] **Step 1: Confirm pre-state**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials"
docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_cdedup_auto"
docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_predup_auto"
```

Expected: the real row count (whatever it is at run time), and both `EXISTS` checks return `0` (neither automated table exists yet — this is the first run).

- [ ] **Step 2: Write the one-off verification script**

Create a file under this session's scratchpad directory with this exact content:

```ts
// One-off verification script for the rewrite+swap redesign of content-dedup.
// NOT committed to the repository. All configuration (CONTENT_DEDUP_APPLY,
// DEDUP_MIN_EXCESS, and the ClickHouse connection) comes from the shell
// invocation's environment -- see the command below.
import { runContentDedupTick } from '@/lib/content-dedup'

async function main() {
  const result = await runContentDedupTick({ trigger: 'manual-verification' })
  console.log('runContentDedupTick result:', JSON.stringify(result))
}

main()
```

Run it from this repository checkout's root (so `npx` finds the locally-installed `tsx`, which is what makes `@/` resolve correctly) with the ClickHouse IP resolved fresh and the real credentials pulled from the primary worktree's `.env`:

```bash
CH_IP=$(docker inspect ulpsuite_clickhouse --format '{{range $k,$v := .NetworkSettings.Networks}}{{$v.IPAddress}}{{end}}')
CH_USER=$(grep '^CLICKHOUSE_USER=' /home/cole/ulp-suite/.env | cut -d= -f2-)
CH_PASSWORD=$(grep '^CLICKHOUSE_PASSWORD=' /home/cole/ulp-suite/.env | cut -d= -f2-)
CH_DATABASE=$(grep -E '^CLICKHOUSE_DATABASE=|^CLICKHOUSE_DB=' /home/cole/ulp-suite/.env | head -1 | cut -d= -f2-)
echo "resolved: CH_IP=$CH_IP CH_USER=$CH_USER CH_DATABASE=$CH_DATABASE"

CLICKHOUSE_HOST="http://$CH_IP:8123" \
CLICKHOUSE_USER="$CH_USER" \
CLICKHOUSE_PASSWORD="$CH_PASSWORD" \
CLICKHOUSE_DATABASE="$CH_DATABASE" \
CONTENT_DEDUP_APPLY=true \
DEDUP_MIN_EXCESS=0 \
npx tsx /path/to/this/scratchpad/file.ts
```

Expected: the script's own `[content-dedup]` log lines print each stage (stats, building, completed rewrite+swap), and the final `runContentDedupTick result:` line shows `applied: true`. A `[WARN][@clickhouse/client][Config] request_timeout is set to...` line is expected and unrelated to this change — it's `lib/clickhouse.ts`'s existing client configuration, not something this task introduces.

- [ ] **Step 3: Confirm post-state independently**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT
  count() AS total,
  uniqExact(cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password)) AS distinct_creds,
  total - distinct_creds AS excess
FROM ulp.credentials
FORMAT Vertical
"
```

Expected: `excess` is `0`.

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw | grep -c "PROJECTION proj_imported_desc"
```

Expected: `1`.

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_predup_auto"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials_predup_auto"
```

Expected: `1` (exists), and its row count matches Step 1's pre-run total exactly — confirming the archived original is intact as the rollback safety net.

- [ ] **Step 4: Confirm `CONTENT_DEDUP_APPLY` is still `false` in the real `.env`**

```bash
grep "^CONTENT_DEDUP_APPLY" /home/cole/ulp-suite/.env || echo "not set (defaults to false)"
```

Expected: not set, or `false`. Step 2's env var overrides were only ever passed as shell-level prefixes to that one `npx tsx` invocation — this confirms they never leaked into the persistent `.env` file.

- [ ] **Step 5: Report and stop**

Report: the pre-state and post-state numbers from Steps 1 and 3, confirmation the projection survived, confirmation `AUTO_PREDUP_TABLE` is intact with the correct row count, and confirmation `CONTENT_DEDUP_APPLY` remains unset in `.env`. There is no committed file to clean up (the verification script from Step 2 was never added to the repository). Do not drop `ulp.credentials_predup_auto` — leave it as the rollback safety net; it will be cleaned up automatically at the start of the next tick once `CONTENT_DEDUP_APPLY=true` is set for ongoing scheduled use, which is a separate, later decision.
