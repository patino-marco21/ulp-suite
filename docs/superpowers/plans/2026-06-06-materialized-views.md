# Materialized Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-aggregate the four highest-cost GROUP BY queries (top_domains, top_passwords, top_url_hosts, reuse_pairs) into ClickHouse SummingMergeTree / AggregatingMergeTree backing tables so the stats dashboard and reuse browser go from 15–120 s full-table scans to <500 ms at 1.46 B rows.

**Architecture:** Four ClickHouse backing tables fed by four materialized views; new inserts update aggregations at write time. A sequential fire-and-forget backfill covers existing rows, gated by SQLite key `ch_mv_backfill_fired`. Routes transparently fall back to original full-scan queries while the MV tables are empty (during the 5–30 minute backfill window); a shared `isMvReady()` helper with 5-minute TTL cache keeps the per-request cost of the readiness check near zero once the tables are warm.

**Tech Stack:** ClickHouse SummingMergeTree, AggregatingMergeTree, MATERIALIZED VIEW, Next.js 15 API routes, SQLite settings gate (same pattern as `ch_repair_mutations_fired`).

**Spec:** `docs/superpowers/specs/2026-06-06-materialized-views-design.md`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `lib/mv-ready.ts` | **Create** | `isMvReady(key, table)` — 5-min TTL in-process cache |
| `lib/clickhouse-migrations.ts` | **Modify** | DDL_VERSION 2→3: 4 tables + 4 MVs + backfill chain |
| `app/api/stats/route.ts` | **Modify** | 4 queries replaced with MV reads + fallback |
| `app/api/reuse/route.ts` | **Modify** | Two-query MV pattern (Query1+count parallel, Query2 serial) |
| `app/api/admin/rebuild-mv/route.ts` | **Create** | Admin POST: TRUNCATE + reset gate + re-fire backfill |

---

## Task 1: `lib/mv-ready.ts` — shared MV readiness helper

**Files:**
- Create: `lib/mv-ready.ts`

- [ ] **Step 1: Create the file**

```typescript
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
      `SELECT count() AS n FROM ${table} LIMIT 1 SETTINGS max_execution_time = 5`
    ) as Array<{ n: string | number }>
    const ready = Number(rows[0]?.n ?? 0) > 0
    cache[key] = { value: ready, checkedAt: Date.now() }
    return ready
  } catch {
    // Conservative: if we can't check, assume not ready → full-scan fallback
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
```

- [ ] **Step 2: Verify TypeScript compiles**

```
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output (or only pre-existing unrelated errors).

- [ ] **Step 3: Commit**

```
git add lib/mv-ready.ts
git commit -m "feat: add isMvReady helper with 5-min TTL cache for MV readiness checks"
```

---

## Task 2: `lib/clickhouse-migrations.ts` — DDL v3

**Files:**
- Modify: `lib/clickhouse-migrations.ts`

Four changes: bump `DDL_VERSION` constant from 2 to 3, add v3 DDL block (4 tables + 4 MVs), add `ch_mv_backfill_fired` gate + sequential backfill chain after the version bump block.

- [ ] **Step 1: Bump DDL_VERSION to 3**

Find and replace the constant at the top of the file:

Old:
```typescript
const DDL_VERSION = 2
```

New:
```typescript
const DDL_VERSION = 3
```

- [ ] **Step 2: Add v3 DDL block**

In `runClickHouseMigrations()`, after the existing `if (lastDdl < 2)` block (which ends with `console.log('[ClickHouse migration] DDL v2 applied')`) and before the final `if (lastDdl < DDL_VERSION)` version-stamp block, insert:

```typescript
  // v3 — materialized view backing tables + MVs.
  // Four SummingMergeTree tables for simple counts, one AggregatingMergeTree
  // for reuse_pairs (stores HyperLogLog state for uniq(domain)).
  // MVs only capture INSERTs after creation — backfill is handled below.
  if (lastDdl < 3) {
    // Backing tables
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.domain_counts (
        domain String,
        count  UInt64
      ) ENGINE = SummingMergeTree(count)
      ORDER BY domain
    `)
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.password_counts (
        password String,
        count    UInt64
      ) ENGINE = SummingMergeTree(count)
      ORDER BY password
    `)
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.url_host_counts (
        url_host String,
        count    UInt64
      ) ENGINE = SummingMergeTree(count)
      ORDER BY url_host
    `)
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.reuse_pairs (
        email      String,
        password   String,
        domain_hll AggregateFunction(uniq, String)
      ) ENGINE = AggregatingMergeTree()
      ORDER BY (email, password)
    `)
    // Materialized views (fire-and-forget — CREATE MV is non-blocking)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_domain_counts
      TO ulp.domain_counts AS
      SELECT domain, count() AS count
      FROM ulp.credentials
      WHERE domain != ''
      GROUP BY domain
    `)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_password_counts
      TO ulp.password_counts AS
      SELECT password, count() AS count
      FROM ulp.credentials
      WHERE length(password) > 0
      GROUP BY password
    `)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_url_host_counts
      TO ulp.url_host_counts AS
      SELECT if(url_host != '', url_host, domain) AS url_host, count() AS count
      FROM ulp.credentials
      WHERE (url_host != '' OR domain != '')
      GROUP BY url_host
    `)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_reuse_pairs
      TO ulp.reuse_pairs AS
      SELECT
        email,
        password,
        uniqState(domain) AS domain_hll
      FROM ulp.credentials
      WHERE login_type = 'email' AND length(password) > 0
      GROUP BY email, password
    `)
    console.log('[ClickHouse migration] DDL v3 applied (4 MV tables + 4 MVs)')
  }
```

- [ ] **Step 3: Add backfill gate + sequential backfill chain**

After the final `if (lastDdl < DDL_VERSION)` block (the version-stamp `setSetting` call), append:

```typescript
  // ── MV backfill (fire-and-forget, sequential, run exactly once) ──────────
  // MVs only capture inserts after creation; this covers the existing 1.46 B rows.
  // Sequential (not parallel) to avoid OOM in a 6 GB container:
  //   each GROUP BY at 1.46 B rows uses 2–4 GB with disk spill.
  //
  // Gate: ch_mv_backfill_fired = '1' once the chain starts.
  // Reset to '0' by POST /api/admin/rebuild-mv to allow re-backfill.
  const mvBackfillFired = getSettingInt('ch_mv_backfill_fired', 0)
  if (mvBackfillFired >= 1) {
    console.log('[MV backfill] already fired — skipping')
    return
  }
  setSetting('ch_mv_backfill_fired', '1')
  console.log('[MV backfill] starting sequential backfill (fire-and-forget)')

  // Fire-and-forget: do NOT await — this takes 5–30 min at 1.46 B rows.
  // The server continues serving requests normally during the backfill.
  ;(async () => {
    try {
      await client.exec({
        query: `INSERT INTO ulp.domain_counts
                SELECT domain, count() AS count
                FROM ulp.credentials
                WHERE domain != ''
                GROUP BY domain
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[MV backfill] domain_counts done')

      await client.exec({
        query: `INSERT INTO ulp.password_counts
                SELECT password, count() AS count
                FROM ulp.credentials
                WHERE length(password) > 0
                GROUP BY password
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[MV backfill] password_counts done')

      await client.exec({
        query: `INSERT INTO ulp.url_host_counts
                SELECT if(url_host != '', url_host, domain) AS url_host, count() AS count
                FROM ulp.credentials
                WHERE (url_host != '' OR domain != '')
                GROUP BY url_host
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[MV backfill] url_host_counts done')

      await client.exec({
        query: `INSERT INTO ulp.reuse_pairs
                SELECT email, password, uniqState(domain) AS domain_hll
                FROM ulp.credentials
                WHERE login_type = 'email' AND length(password) > 0
                GROUP BY email, password
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[MV backfill] reuse_pairs done')

      console.log('[MV backfill] All four MV tables backfilled successfully')
    } catch (err) {
      console.error('[MV backfill] Error:', String(err).substring(0, 300))
      // ch_mv_backfill_fired stays '1' to prevent infinite retry.
      // Use POST /api/admin/rebuild-mv to reset and retry.
    }
  })()
```

The full end of `runClickHouseMigrations()` after Task 2 edits will look like:

```typescript
  // ... (existing v1 block, v2 block) ...

  // v3 — four MV tables + four MVs
  if (lastDdl < 3) {
    // ... (inserted above)
    console.log('[ClickHouse migration] DDL v3 applied (4 MV tables + 4 MVs)')
  }

  // Version stamp — only written once all DDL blocks for this version ran
  if (lastDdl < DDL_VERSION) {
    setSetting('ch_ddl_version', String(DDL_VERSION))
    console.log(`[ClickHouse migration] DDL now at v${DDL_VERSION}`)
  } else {
    console.log(`[ClickHouse migration] DDL v${DDL_VERSION} already applied — skipping`)
  }

  // Data-repair mutations (existing unchanged block)
  const repairFired = getSettingInt('ch_repair_mutations_fired', 0)
  if (repairFired >= 1) { ... }
  setSetting('ch_repair_mutations_fired', '1')
  // ... existing mutation code ...

  // MV backfill (NEW — appended after the data-repair block)
  const mvBackfillFired = getSettingInt('ch_mv_backfill_fired', 0)
  // ... (inserted above)
})()
```

- [ ] **Step 4: Verify TypeScript compiles**

```
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 5: Commit**

```
git add lib/clickhouse-migrations.ts
git commit -m "feat: add DDL v3 migration — 4 MV tables, 4 MVs, sequential backfill with SQLite gate"
```

---

## Task 3: `app/api/stats/route.ts` — MV queries

**Files:**
- Modify: `app/api/stats/route.ts`

Two changes: add `isMvReady` import, then add the readiness check + swap 4 queries inside the existing `try` block.

- [ ] **Step 1: Add import**

Replace the existing import block at the top:

Old:
```typescript
import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import {
  type StatsResult,
  getStatsCache,
  setStatsCache,
  invalidateStatsCache,
} from "@/lib/stats-cache"
```

New:
```typescript
import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import {
  type StatsResult,
  getStatsCache,
  setStatsCache,
  invalidateStatsCache,
} from "@/lib/stats-cache"
import { isMvReady } from "@/lib/mv-ready"
```

- [ ] **Step 2: Add MV readiness check inside the try block**

Replace the opening of the `try` block. Old:

```typescript
  try {
    const [
      totalCount,
```

New:

```typescript
  try {
    // ── MV readiness: cheap cache check (5-min TTL, no DB hit once warm) ────
    const [domainReady, passwordReady, urlHostReady, reuseReady] = await Promise.all([
      isMvReady('domain',   'ulp.domain_counts'),
      isMvReady('password', 'ulp.password_counts'),
      isMvReady('urlHost',  'ulp.url_host_counts'),
      isMvReady('reuse',    'ulp.reuse_pairs'),
    ])

    const [
      totalCount,
```

- [ ] **Step 3: Replace topDomains query (4th element in the Promise.all)**

Old:
```typescript
      // domain is the first column in the primary key → GROUP BY domain is index-aligned
      executeQuery(`
        SELECT domain, count() AS count
        FROM ulp.credentials
        WHERE domain != ''
        GROUP BY domain
        ORDER BY count DESC
        LIMIT 15
        SETTINGS max_execution_time = 30
      `),
```

New:
```typescript
      // top_domains — MV path: sum(count) over SummingMergeTree partials (<50 ms)
      // Fallback: full GROUP BY on credentials (30 s at 1.46 B rows)
      domainReady
        ? executeQuery(`
            SELECT domain, sum(count) AS count
            FROM ulp.domain_counts
            WHERE domain != ''
            GROUP BY domain
            ORDER BY count DESC
            LIMIT 15
            SETTINGS max_execution_time = 10
          `)
        : executeQuery(`
            SELECT domain, count() AS count
            FROM ulp.credentials
            WHERE domain != ''
            GROUP BY domain
            ORDER BY count DESC
            LIMIT 15
            SETTINGS max_execution_time = 30
          `),
```

- [ ] **Step 4: Replace topPasswords query (5th element)**

Old:
```typescript
      // Standard GROUP BY — fast for current scale (< 100 M rows).
      // At 100 B+ rows, ClickHouse will use the skip index on password and
      // the 30-second cap (max_execution_time) returns partial results rather
      // than hanging. SAMPLE BY requires schema-level SAMPLE BY clause;
      // since the table doesn't define one we use plain GROUP BY here.
      executeQuery(`
        SELECT password, count() AS count
        FROM ulp.credentials
        WHERE length(password) > 0
        GROUP BY password
        ORDER BY count DESC
        LIMIT 50
        SETTINGS max_execution_time = 30
      `),
```

New:
```typescript
      // top_passwords — MV path (<50 ms); fallback full scan (30 s)
      passwordReady
        ? executeQuery(`
            SELECT password, sum(count) AS count
            FROM ulp.password_counts
            WHERE password != ''
            GROUP BY password
            ORDER BY count DESC
            LIMIT 50
            SETTINGS max_execution_time = 10
          `)
        : executeQuery(`
            SELECT password, count() AS count
            FROM ulp.credentials
            WHERE length(password) > 0
            GROUP BY password
            ORDER BY count DESC
            LIMIT 50
            SETTINGS max_execution_time = 30
          `),
```

- [ ] **Step 5: Replace reuseStats query (14th element)**

Old:
```typescript
      // Password reuse rate — most expensive query: double GROUP BY.
      // uniq(domain) instead of count(DISTINCT domain) is ~5× faster (HyperLogLog).
      // LIMIT on inner query caps it at 5 M unique pairs — sufficient for a rate estimate.
      executeQuery(`
        SELECT
          countIf(domain_count > 1) AS reused_pairs,
          count()                   AS total_pairs
        FROM (
          SELECT email, password, uniq(domain) AS domain_count
          FROM ulp.credentials
          WHERE login_type = 'email' AND length(password) > 0
          GROUP BY email, password
          LIMIT 5000000
        )
        SETTINGS max_execution_time = 60
      `),
```

New:
```typescript
      // reuse_stats — MV path: uniqMerge over AggregatingMergeTree (~200 ms)
      // Fallback: double GROUP BY on credentials (45–120 s at 1.46 B rows)
      reuseReady
        ? executeQuery(`
            SELECT
              countIf(dc > 1) AS reused_pairs,
              count()         AS total_pairs
            FROM (
              SELECT email, password, uniqMerge(domain_hll) AS dc
              FROM ulp.reuse_pairs
              GROUP BY email, password
            )
            SETTINGS max_execution_time = 30
          `)
        : executeQuery(`
            SELECT
              countIf(domain_count > 1) AS reused_pairs,
              count()                   AS total_pairs
            FROM (
              SELECT email, password, uniq(domain) AS domain_count
              FROM ulp.credentials
              WHERE login_type = 'email' AND length(password) > 0
              GROUP BY email, password
              LIMIT 5000000
            )
            SETTINGS max_execution_time = 60
          `),
```

- [ ] **Step 6: Replace topUrlHosts query (last element, 19th)**

Old:
```typescript
      // Top URL hosts — url_host has a bloom_filter skip index
      executeQuery(`
        SELECT
          if(url_host != '', url_host, domain) AS host,
          count()                               AS count
        FROM ulp.credentials
        WHERE (url_host != '' OR domain != '')
        GROUP BY host
        ORDER BY count DESC
        LIMIT 15
        SETTINGS max_execution_time = 30
      `).catch(() => [] as any[]),
```

New:
```typescript
      // top_url_hosts — MV path (<50 ms); fallback full scan (10–20 s)
      // MV aliases url_host AS host to match existing result-map key.
      urlHostReady
        ? executeQuery(`
            SELECT url_host AS host, sum(count) AS count
            FROM ulp.url_host_counts
            WHERE url_host != ''
            GROUP BY url_host
            ORDER BY count DESC
            LIMIT 15
            SETTINGS max_execution_time = 10
          `).catch(() => [] as any[])
        : executeQuery(`
            SELECT
              if(url_host != '', url_host, domain) AS host,
              count()                               AS count
            FROM ulp.credentials
            WHERE (url_host != '' OR domain != '')
            GROUP BY host
            ORDER BY count DESC
            LIMIT 15
            SETTINGS max_execution_time = 30
          `).catch(() => [] as any[]),
```

- [ ] **Step 7: Verify TypeScript compiles**

```
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 8: Commit**

```
git add app/api/stats/route.ts
git commit -m "feat: stats route uses MV tables for top_domains, top_passwords, top_url_hosts, reuse_stats with live fallback"
```

---

## Task 4: `app/api/reuse/route.ts` — two-query MV pattern

**Files:**
- Modify: `app/api/reuse/route.ts`

Replace the entire GET handler body with the MV two-query pattern. Query 1 (paginated MV list) + count run via `Promise.all`; Query 2 (domain samples from credentials, up to 8 per pair) runs serially after Query 1 returns the page's pairs.

- [ ] **Step 1: Replace the entire file**

```typescript
import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { isMvReady } from "@/lib/mv-ready"

export const dynamic = 'force-dynamic'

// GET /api/reuse?page=1&limit=50&email=&password=
// Returns email:password pairs that appear across more than one domain.
// Uses ulp.reuse_pairs MV (AggregatingMergeTree) when warm;
// falls back to direct full-scan of ulp.credentials during backfill.
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const page        = Math.max(1, parseInt(searchParams.get('page')     || '1',  10))
  const limit       = Math.min(100, Math.max(10, parseInt(searchParams.get('limit') || '50', 10)))
  const offset      = (page - 1) * limit
  const emailFilter = (searchParams.get('email')    || '').trim().toLowerCase()
  const pwFilter    = (searchParams.get('password') || '').trim()

  try {
    const ready = await isMvReady('reuse', 'ulp.reuse_pairs')

    if (!ready) {
      // ── Fallback: full scan of credentials (no MV data yet) ───────────────
      const whereParts: string[] = [`login_type = 'email'`, `length(password) > 0`]
      const queryParams: Record<string, unknown> = { limit, offset }

      if (emailFilter) {
        whereParts.push(`position(lower(email), {emailFilter:String}) > 0`)
        queryParams.emailFilter = emailFilter
      }
      if (pwFilter) {
        whereParts.push(`position(password, {pwFilter:String}) > 0`)
        queryParams.pwFilter = pwFilter
      }

      const BASE_WHERE = whereParts.join(' AND ')

      const rows = await executeQuery(`
        SELECT
          email,
          password,
          uniq(domain)           AS domain_count,
          groupUniqArray(domain) AS domains
        FROM ulp.credentials
        WHERE ${BASE_WHERE}
        GROUP BY email, password
        HAVING domain_count > 1
        ORDER BY domain_count DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 120, timeout_overflow_mode = 'break'
      `, queryParams)

      const countResult = await executeQuery(`
        SELECT count() AS total
        FROM (
          SELECT email, password
          FROM ulp.credentials
          WHERE ${BASE_WHERE}
          GROUP BY email, password
          HAVING uniq(domain) > 1
        )
        SETTINGS max_execution_time = 120, timeout_overflow_mode = 'break'
      `, { emailFilter: emailFilter || '', pwFilter: pwFilter || '' })

      const total = Number((countResult as any[])[0]?.total || 0)
      return NextResponse.json({
        success: true,
        results: rows,
        total,
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
      })
    }

    // ── MV path: two-query pattern ────────────────────────────────────────
    // Build WHERE for the MV table (login_type + length conditions are baked
    // into the MV definition; only optional user filters remain).
    const mvWhereParts: string[] = []
    if (emailFilter) mvWhereParts.push(`position(lower(email), {emailFilter:String}) > 0`)
    if (pwFilter)    mvWhereParts.push(`position(password, {pwFilter:String}) > 0`)
    const mvWhere = mvWhereParts.length ? `WHERE ${mvWhereParts.join(' AND ')}` : ''

    const mvQueryParams: Record<string, unknown> = { limit, offset }
    if (emailFilter) mvQueryParams.emailFilter = emailFilter
    if (pwFilter)    mvQueryParams.pwFilter    = pwFilter

    const mvCountParams: Record<string, unknown> = {}
    if (emailFilter) mvCountParams.emailFilter = emailFilter
    if (pwFilter)    mvCountParams.pwFilter    = pwFilter

    // Query 1 (paginated list) + count run in parallel
    const [mvRows, countResult] = await Promise.all([
      executeQuery(`
        SELECT email, password, uniqMerge(domain_hll) AS domain_count
        FROM ulp.reuse_pairs
        ${mvWhere}
        GROUP BY email, password
        HAVING domain_count > 1
        ORDER BY domain_count DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break'
      `, mvQueryParams),
      executeQuery(`
        SELECT count() AS total
        FROM (
          SELECT email, password
          FROM ulp.reuse_pairs
          ${mvWhere}
          GROUP BY email, password
          HAVING uniqMerge(domain_hll) > 1
        )
        SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break'
      `, mvCountParams),
    ])

    // Query 2 — domain samples for current page (serial: depends on Query 1 rows)
    // Fetches up to 8 sample domains per pair from ulp.credentials.
    // Uses email bloom_filter index for fast granule pruning.
    const domainsMap = new Map<string, string[]>()
    if ((mvRows as any[]).length > 0) {
      const pairParams: Record<string, string> = {}
      const pairList = (mvRows as any[]).map((r, i) => {
        pairParams[`e${i}`] = String(r.email)
        pairParams[`p${i}`] = String(r.password)
        return `({e${i}:String}, {p${i}:String})`
      }).join(', ')

      const domainRows = await executeQuery(`
        SELECT email, password, groupUniqArray(8)(domain) AS domains
        FROM ulp.credentials
        WHERE (email, password) IN (${pairList})
          AND login_type = 'email'
        GROUP BY email, password
        SETTINGS max_execution_time = 10
      `, pairParams) as Array<{ email: string; password: string; domains: string[] }>

      for (const r of domainRows) {
        domainsMap.set(`${r.email}:${r.password}`, r.domains)
      }
    }

    const total = Number((countResult as any[])[0]?.total || 0)
    const results = (mvRows as any[]).map(r => ({
      email:        String(r.email),
      password:     String(r.password),
      domain_count: Number(r.domain_count),
      domains:      domainsMap.get(`${r.email}:${r.password}`) || [],
    }))

    return NextResponse.json({
      success: true,
      results,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    })
  } catch (error) {
    console.error('Reuse query error:', error)
    return NextResponse.json({ success: false, error: 'Reuse query failed' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 3: Commit**

```
git add app/api/reuse/route.ts
git commit -m "feat: reuse route uses MV two-query pattern (Query1+count parallel, Query2 serial) with fallback"
```

---

## Task 5: `app/api/admin/rebuild-mv/route.ts` — admin rebuild endpoint

**Files:**
- Create: `app/api/admin/rebuild-mv/route.ts`

Follows the same structure as `app/api/admin/rebuild-sources/route.ts`. TRUNCATEs all four MV tables, resets the SQLite gate to `'0'`, invalidates the in-process `isMvReady` cache, then re-fires the sequential backfill chain (fire-and-forget).

- [ ] **Step 1: Create the file**

```typescript
/**
 * POST /api/admin/rebuild-mv
 *
 * Truncates the four MV backing tables, resets the ch_mv_backfill_fired SQLite
 * gate, and re-fires the sequential backfill chain as a fire-and-forget IIFE.
 *
 * Use when:
 *   - Initial backfill failed mid-way (check server logs)
 *   - ulp.credentials was bulk-modified (ALTER TABLE UPDATE mutations that
 *     changed domain / password / url_host / email values at scale)
 *   - MV tables show incorrect counts
 *
 * The endpoint returns immediately after kicking off the backfill; poll
 * GET /api/stats?bust=1 to see when MV data appears in the dashboard.
 *
 * Auth: admin role required.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { getClient } from '@/lib/clickhouse'
import { dbRun } from '@/lib/sqlite'
import { invalidateAllMvCaches } from '@/lib/mv-ready'

export const dynamic = 'force-dynamic'

const MV_TABLES = [
  'ulp.domain_counts',
  'ulp.password_counts',
  'ulp.url_host_counts',
  'ulp.reuse_pairs',
] as const

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const client = getClient()

  // 1. Truncate all four MV tables
  const truncateErrors: string[] = []
  for (const table of MV_TABLES) {
    try {
      await client.exec({ query: `TRUNCATE TABLE ${table}` })
    } catch (err) {
      truncateErrors.push(`${table}: ${String(err).substring(0, 80)}`)
    }
  }

  if (truncateErrors.length > 0) {
    console.error('[rebuild-mv] TRUNCATE errors:', truncateErrors)
    return NextResponse.json({
      success: false,
      error: 'Failed to truncate one or more MV tables',
      details: truncateErrors,
    }, { status: 500 })
  }

  // 2. Reset SQLite gate so runClickHouseMigrations backfill block fires again
  try {
    dbRun(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`,
      ['ch_mv_backfill_fired', '0'])
  } catch (err) {
    console.error('[rebuild-mv] SQLite gate reset error:', err)
  }

  // 3. Invalidate in-process isMvReady cache so routes fall back to full-scan
  //    immediately (not after the 5-min TTL expires)
  invalidateAllMvCaches()

  // 4. Re-fire sequential backfill chain (fire-and-forget)
  console.log('[rebuild-mv] re-firing sequential MV backfill')
  ;(async () => {
    try {
      await client.exec({
        query: `INSERT INTO ulp.domain_counts
                SELECT domain, count() AS count
                FROM ulp.credentials
                WHERE domain != ''
                GROUP BY domain
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[rebuild-mv backfill] domain_counts done')

      await client.exec({
        query: `INSERT INTO ulp.password_counts
                SELECT password, count() AS count
                FROM ulp.credentials
                WHERE length(password) > 0
                GROUP BY password
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[rebuild-mv backfill] password_counts done')

      await client.exec({
        query: `INSERT INTO ulp.url_host_counts
                SELECT if(url_host != '', url_host, domain) AS url_host, count() AS count
                FROM ulp.credentials
                WHERE (url_host != '' OR domain != '')
                GROUP BY url_host
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[rebuild-mv backfill] url_host_counts done')

      await client.exec({
        query: `INSERT INTO ulp.reuse_pairs
                SELECT email, password, uniqState(domain) AS domain_hll
                FROM ulp.credentials
                WHERE login_type = 'email' AND length(password) > 0
                GROUP BY email, password
                SETTINGS max_bytes_before_external_group_by = 4294967296,
                         max_execution_time = 3600`,
      })
      console.log('[rebuild-mv backfill] reuse_pairs done — rebuild complete')
    } catch (err) {
      console.error('[rebuild-mv backfill] Error:', String(err).substring(0, 300))
    }
  })()

  return NextResponse.json({
    success: true,
    truncated: MV_TABLES,
    message: 'MV tables truncated and backfill re-started (fire-and-forget). Poll GET /api/stats?bust=1 to see progress.',
  })
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 3: Commit**

```
git add app/api/admin/rebuild-mv/route.ts
git commit -m "feat: add POST /api/admin/rebuild-mv — truncate MV tables, reset SQLite gate, re-fire backfill"
```

---

## Task 6: Final verification + push

- [ ] **Step 1: Full tsc check**

```
npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 2: Confirm new files exist**

```
ls lib/mv-ready.ts app/api/admin/rebuild-mv/route.ts
```

Expected: both files listed.

- [ ] **Step 3: Confirm migration version in source**

```
grep "DDL_VERSION" lib/clickhouse-migrations.ts
```

Expected: `const DDL_VERSION = 3`

- [ ] **Step 4: Push**

```
git push
```

Expected: branch pushed cleanly.

---

## Self-Review Checklist

**Spec coverage:**

| Spec requirement | Covered in |
|---|---|
| 4 backing tables (domain_counts, password_counts, url_host_counts, reuse_pairs) | Task 2 Step 2 |
| 4 materialized views (mv_domain_counts, mv_password_counts, mv_url_host_counts, mv_reuse_pairs) | Task 2 Step 2 |
| Sequential backfill with `max_bytes_before_external_group_by` | Task 2 Step 3 |
| SQLite gate `ch_mv_backfill_fired` | Task 2 Step 3 |
| `isMvReady()` with 5-min TTL | Task 1 |
| Stats route — 4 MV queries with fallback | Task 3 Steps 3–6 |
| Reuse route — Query1+count parallel, Query2 serial | Task 4 |
| Admin rebuild endpoint — TRUNCATE + reset gate + re-fire | Task 5 |
| `invalidateAllMvCaches()` called in rebuild-mv | Task 5 Step 1 |

**No placeholders found.**

**Type consistency:**
- `isMvReady(key: string, table: string): Promise<boolean>` — used as `isMvReady('domain', 'ulp.domain_counts')` in Task 3 and Task 4. Consistent.
- `invalidateAllMvCaches(): void` — exported from Task 1, imported and called in Task 5. Consistent.
- `executeQuery` return type is `any[]` throughout — consistent with rest of codebase.
- `mvRows as any[]` — consistent with existing `rows` handling elsewhere.
- `client.exec({ query: ... })` — matches existing pattern in `rebuild-sources/route.ts` and `clickhouse-migrations.ts`. Consistent.
