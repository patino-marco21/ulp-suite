# Remove Reuse, Similar, and Stats Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unused Password Reuse, Similar Passwords, and Statistics pages/APIs and the ClickHouse materialized-view (MV) backing tables that exist solely to serve them, simplifying the schema and removing per-insert MV write overhead that nothing reads anymore.

**Architecture:** Delete the 3 page components (`/reuse`, `/similar`, `/stats`) and their 3 API routes, plus `app/api/admin/rebuild-mv` and the two shared helper libs (`lib/stats-cache.ts`, `lib/mv-ready.ts`) that exist only to support them. Add ClickHouse DDL v10 to `lib/clickhouse-migrations.ts` that drops the 4 MV backing tables (`ulp.domain_counts`, `ulp.password_counts`, `ulp.url_host_counts`, `ulp.reuse_pairs`) created in v3/v8 and their 4 materialized views, and removes the now-pointless MV backfill block. Remove the 3 sidebar nav entries (and now-unused icon imports) and every `invalidateStatsCache()` call site. The 9 materialized **columns** that `/credentials` search/filter still depends on (`country_tier`, `login_type`, `password_mask`, `password_entropy_band`, `url_scheme`, `email_domain`, `url_host`, `is_corporate_email`, `tld`, `password_length`) are **not** touched — only the 4 standalone MV tables/views and the routes that read them.

**Out of scope:** Breach Catalog removal (`app/breaches/*`, `lib/breach-matcher.ts`, `matchBreach()`, `breach_name` column/index, SQLite `breaches`/`source_breach_map` tables) is a separate future plan — do not touch any breach-related file, column, or table here. `hooks/useStats.ts` is pre-existing dead code (fetches `/api/stats` but is imported by nothing) — also out of scope; leave it as-is.

**Tech Stack:** Next.js 15 App Router, ClickHouse 26.3 (idempotent versioned DDL migration runner in `lib/clickhouse-migrations.ts`), Vitest, SQLite via `better-sqlite3` (`app_settings` gate table).

---

## File Map

| File | Action | Why |
|------|--------|-----|
| `app/similar/page.tsx` | **Delete** | Similar Passwords UI |
| `app/api/similar/route.ts` | **Delete** | Similar Passwords API |
| `app/reuse/page.tsx` | **Delete** | Password Reuse UI |
| `app/api/reuse/route.ts` | **Delete** | Password Reuse API |
| `app/stats/page.tsx` | **Delete** | Statistics UI |
| `app/api/stats/route.ts` | **Delete** | Statistics API |
| `lib/stats-cache.ts` | **Delete** | Only consumed by `/api/stats` and the 3 `invalidateStatsCache()` call sites below |
| `lib/mv-ready.ts` | **Delete** | Only consumed by `/api/reuse`, `/api/stats`, `/api/admin/rebuild-mv` |
| `app/api/admin/rebuild-mv/route.ts` | **Delete** | Admin endpoint to rebuild the 4 MV tables being dropped |
| `components/app-sidebar.tsx` | **Modify** | Remove Reuse/Similar/Stats nav items + unused icon imports |
| `lib/clickhouse-migrations.ts` | **Modify** | DDL v9 → v10: drop 4 MV tables + 4 views, remove dead backfill block |
| `lib/upload-processor.ts` | **Modify** | Remove `invalidateStatsCache` import + call |
| `app/api/admin/dedup/route.ts` | **Modify** | Remove `invalidateStatsCache` import + call |
| `app/api/sources/route.ts` | **Modify** | Remove `invalidateStatsCache` import + call |
| `__tests__/upload-processor.test.ts` | **Modify** | Remove `lib/stats-cache` mock |
| `lib/rate-limiter.ts` | **Modify** | Remove `/api/stats` rate-limit config entry |

---

## Task 1: Delete the Similar Passwords feature

**Files:**
- Delete: `app/similar/page.tsx`
- Delete: `app/api/similar/route.ts`

- [ ] **Step 1: Delete the page and API route**

```bash
git rm app/similar/page.tsx app/api/similar/route.ts
```

(`app/api/similar/` will become an empty directory — that's fine, Next.js ignores empty route dirs. If `git rm` leaves an empty dir behind on disk, it's harmless.)

- [ ] **Step 2: Verify no remaining references**

```bash
grep -rn "/similar\|app/similar\|api/similar" --include="*.ts" --include="*.tsx" .
```

Expected: no output (the sidebar still has a `/similar` reference at this point — that's fixed in Task 5, so a hit there is expected until then; re-run this check again after Task 5).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Remove Similar Passwords page and API route"
```

---

## Task 2: Delete the Password Reuse feature

**Files:**
- Delete: `app/reuse/page.tsx`
- Delete: `app/api/reuse/route.ts`

- [ ] **Step 1: Delete the page and API route**

```bash
git rm app/reuse/page.tsx app/api/reuse/route.ts
```

- [ ] **Step 2: Verify no remaining references**

```bash
grep -rn "/reuse\|app/reuse\|api/reuse\|ulp.reuse_pairs\|mv_reuse_pairs" --include="*.ts" --include="*.tsx" .
```

Expected at this point: hits in `components/app-sidebar.tsx` (fixed in Task 5) and `lib/clickhouse-migrations.ts` (fixed in Task 6). No other hits.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Remove Password Reuse page and API route"
```

---

## Task 3: Delete the Statistics feature and its cache helper

**Files:**
- Delete: `app/stats/page.tsx`
- Delete: `app/api/stats/route.ts`
- Delete: `lib/stats-cache.ts`

- [ ] **Step 1: Delete the page, API route, and cache helper**

```bash
git rm app/stats/page.tsx app/api/stats/route.ts lib/stats-cache.ts
```

- [ ] **Step 2: Verify no remaining references**

```bash
grep -rn "stats-cache\|StatsResult\|StatsData\|getStatsCache\|setStatsCache\|invalidateStatsCache\|/api/stats\b" --include="*.ts" --include="*.tsx" .
```

Expected at this point: hits in `components/app-sidebar.tsx` (Task 5), `lib/clickhouse-migrations.ts` MV table/view names if any (Task 6), `lib/upload-processor.ts`, `app/api/admin/dedup/route.ts`, `app/api/sources/route.ts` (all Task 7), `__tests__/upload-processor.test.ts` (Task 8), `lib/rate-limiter.ts` (Task 9), and `hooks/useStats.ts` (intentionally out of scope — pre-existing dead code, leave it).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Remove Statistics page, API route, and stats-cache helper"
```

---

## Task 4: Delete the MV-ready helper and rebuild-mv admin route

**Files:**
- Delete: `lib/mv-ready.ts`
- Delete: `app/api/admin/rebuild-mv/route.ts`

- [ ] **Step 1: Delete both files**

```bash
git rm lib/mv-ready.ts app/api/admin/rebuild-mv/route.ts
```

- [ ] **Step 2: Verify no remaining references**

```bash
grep -rn "mv-ready\|isMvReady\|invalidateMvCache\|invalidateAllMvCaches\|rebuild-mv\|MV_TABLES" --include="*.ts" --include="*.tsx" .
```

Expected: no output. (All three former consumers — `/api/reuse`, `/api/stats`, `/api/admin/rebuild-mv` — were deleted in Tasks 1–4.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Remove mv-ready helper and rebuild-mv admin route"
```

---

## Task 5: Update the sidebar — remove Reuse/Similar/Stats nav items

**Files:**
- Modify: `components/app-sidebar.tsx:3` (icon imports)
- Modify: `components/app-sidebar.tsx:37-47` (Search menu group)

- [ ] **Step 1: Remove the now-unused icon imports**

`AlertTriangle` (Reuse), `Layers` (Similar), and `BarChart2` (Stats) are imported only for the three menu items being removed. `ShieldAlert` (Breaches) stays — Breaches is out of scope for this plan.

Find (line 3):

```tsx
import { Upload, Database, Settings, Users, LucideIcon, Key, BookOpen, ClipboardList, FileText, Radio, BarChart2, AlertTriangle, Layers, ShieldAlert, Search, Shield, Inbox } from "lucide-react"
```

Replace with:

```tsx
import { Upload, Database, Settings, Users, LucideIcon, Key, BookOpen, ClipboardList, FileText, Radio, ShieldAlert, Search, Shield, Inbox } from "lucide-react"
```

- [ ] **Step 2: Remove the Reuse, Similar, and Stats menu items**

Find (lines 37-47):

```tsx
  {
    title: "Search",
    items: [
      { title: "Credentials", url: "/credentials", icon: Database },
      { title: "Batch Lookup",  url: "/lookup",      icon: Search },
      { title: "Reuse", url: "/reuse", icon: AlertTriangle },
      { title: "Similar", url: "/similar", icon: Layers },
      { title: "Breaches", url: "/breaches", icon: ShieldAlert },
      { title: "Stats", url: "/stats", icon: BarChart2 },
    ],
  },
```

Replace with:

```tsx
  {
    title: "Search",
    items: [
      { title: "Credentials", url: "/credentials", icon: Database },
      { title: "Batch Lookup",  url: "/lookup",      icon: Search },
      { title: "Breaches", url: "/breaches", icon: ShieldAlert },
    ],
  },
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors (any pre-existing unrelated errors are fine).

- [ ] **Step 4: Re-run the Task 1/2/3 reference checks**

```bash
grep -rn "/similar\|/reuse\|/stats\|AlertTriangle\|Layers\|BarChart2" components/app-sidebar.tsx
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add components/app-sidebar.tsx
git commit -m "Remove Reuse/Similar/Stats from sidebar nav"
```

---

## Task 6: ClickHouse DDL v10 — drop the Reuse/Stats MV tables and views

**Files:**
- Modify: `lib/clickhouse-migrations.ts:15-43` (version-history comment + `DDL_VERSION`)
- Modify: `lib/clickhouse-migrations.ts:528-547` (insert new v10 block after the v9 block)
- Modify: `lib/clickhouse-migrations.ts:556-628` (delete the dead MV backfill block)

This task drops the 4 tables/views created by the v3/v8 migrations (`ulp.domain_counts`, `ulp.password_counts`, `ulp.url_host_counts`, `ulp.reuse_pairs` + `mv_domain_counts`, `mv_password_counts`, `mv_url_host_counts`, `mv_reuse_pairs`). These existed solely to serve `/api/reuse`, `/api/stats`, and `/api/admin/rebuild-mv`, all deleted in Tasks 1-4. It also removes the MV backfill block (lines 556-628), which only ever wrote to these 4 tables and would otherwise become dead/error-logging code once they're dropped.

- [ ] **Step 1: Add the v10 entry to the version-history comment and bump `DDL_VERSION`**

Find (lines 34-43):

```typescript
// v9: idx_ngram_url_host / idx_ngram_email_domain (from v4) never took effect on
//     installs where ch_ddl_version was already >= 4 — the `lastDdl < 4` gate is
//     permanently closed for those installs. Without these, position(url_host,...)
//     / position(email_domain,...) in lib/ulp-search.ts have no skip index, and
//     since they're OR'd with the hasToken() conditions, NO pruning happens at all
//     (verified via EXPLAIN: "Combined skip indexes: 800/800" even for a unique
//     token). v9 unconditionally (re)adds both ngram indexes, and drops the legacy
//     tokenbf_v1 indexes (idx_url/idx_email/idx_password) + idx_email_ngram that v5
//     intended to remove but — for the same gate reason — never did on some installs.
const DDL_VERSION = 9
```

Replace with:

```typescript
// v9: idx_ngram_url_host / idx_ngram_email_domain (from v4) never took effect on
//     installs where ch_ddl_version was already >= 4 — the `lastDdl < 4` gate is
//     permanently closed for those installs. Without these, position(url_host,...)
//     / position(email_domain,...) in lib/ulp-search.ts have no skip index, and
//     since they're OR'd with the hasToken() conditions, NO pruning happens at all
//     (verified via EXPLAIN: "Combined skip indexes: 800/800" even for a unique
//     token). v9 unconditionally (re)adds both ngram indexes, and drops the legacy
//     tokenbf_v1 indexes (idx_url/idx_email/idx_password) + idx_email_ngram that v5
//     intended to remove but — for the same gate reason — never did on some installs.
// v10: Reuse/Similar/Stats pages and APIs removed from the app. Drops the 4 MV
//     backing tables from v3/v8 (ulp.domain_counts, ulp.password_counts,
//     ulp.url_host_counts, ulp.reuse_pairs) and their 4 materialized views
//     (mv_domain_counts, mv_password_counts, mv_url_host_counts, mv_reuse_pairs),
//     which were only read by the now-deleted /api/reuse, /api/stats, and
//     /api/admin/rebuild-mv. Views are dropped before their backing tables to
//     avoid a race where a view tries to write to an already-dropped table.
//     The materialized COLUMNS these MVs read from (country_tier, login_type,
//     password_mask, etc.) are untouched — /credentials still filters on them.
const DDL_VERSION = 10
```

- [ ] **Step 2: Add the v10 migration block after the v9 block**

Find (lines 542-547 — the end of the v9 block):

```typescript
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_url`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_password`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email_ngram`)
    console.warn('[ClickHouse migration] DDL v9 applied (added idx_ngram_url_host/idx_ngram_email_domain — MATERIALIZE running in background; dropped redundant legacy indexes)')
  }
```

Replace with:

```typescript
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_url`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_password`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email_ngram`)
    console.warn('[ClickHouse migration] DDL v9 applied (added idx_ngram_url_host/idx_ngram_email_domain — MATERIALIZE running in background; dropped redundant legacy indexes)')
  }

  // v10 — Reuse/Similar/Stats pages and APIs removed from the app. Drop the 4 MV
  // backing tables + their materialized views (v3/v8) that were ONLY read by
  // the now-deleted /api/reuse, /api/stats, and /api/admin/rebuild-mv. Views
  // first, then backing tables, to avoid a race where a view tries to write to
  // an already-dropped table.
  if (lastDdl < 10) {
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_domain_counts`)
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_password_counts`)
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_url_host_counts`)
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_reuse_pairs`)
    await runMigration(`DROP TABLE IF EXISTS ulp.domain_counts`)
    await runMigration(`DROP TABLE IF EXISTS ulp.password_counts`)
    await runMigration(`DROP TABLE IF EXISTS ulp.url_host_counts`)
    await runMigration(`DROP TABLE IF EXISTS ulp.reuse_pairs`)
    console.warn('[ClickHouse migration] DDL v10 applied (dropped stats/reuse MV tables + views)')
  }
```

- [ ] **Step 3: Delete the dead MV backfill block**

This block (originally lines 556-628) only ever populated the 4 tables dropped in Step 2. Find it — it starts right after the `if (lastDdl < DDL_VERSION) { ... }` version-bump block and ends right before the `// ── Data-repair mutations ...` comment:

```typescript
  // ── MV backfill (fire-and-forget, sequential, run exactly once) ──────────
  // Placed BEFORE the repairFired early return so it runs on all deployments,
  // including existing ones where ch_repair_mutations_fired is already '1'.
  // MVs only capture inserts after creation; this covers the existing 1.46 B rows.
  // Sequential (not parallel) to avoid OOM in a 6 GB container:
  //   each GROUP BY at 1.46 B rows uses 2–4 GB with disk spill.
  //
  // Gate: ch_mv_backfill_fired = '1' once the chain starts.
  // Reset to '0' by POST /api/admin/rebuild-mv to allow re-backfill.
  const mvBackfillFired = getSettingInt('ch_mv_backfill_fired', 0)
  if (mvBackfillFired >= 1) {
    console.warn('[MV backfill] already fired — skipping')
    // No early return here: let the repairFired guard below run normally.
  } else {
    setSetting('ch_mv_backfill_fired', '1')
    console.warn('[MV backfill] starting sequential backfill (fire-and-forget)')

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
        console.warn('[MV backfill] domain_counts done')

        await client.exec({
          query: `INSERT INTO ulp.password_counts
                  SELECT password, count() AS count
                  FROM ulp.credentials
                  WHERE password != ''
                  GROUP BY password
                  SETTINGS max_bytes_before_external_group_by = 4294967296,
                           max_execution_time = 3600`,
        })
        console.warn('[MV backfill] password_counts done')

        await client.exec({
          query: `INSERT INTO ulp.url_host_counts
                  SELECT if(url_host != '', url_host, domain) AS url_host, count() AS count
                  FROM ulp.credentials
                  WHERE (url_host != '' OR domain != '')
                  GROUP BY url_host
                  SETTINGS max_bytes_before_external_group_by = 4294967296,
                           max_execution_time = 3600`,
        })
        console.warn('[MV backfill] url_host_counts done')

        await client.exec({
          query: `INSERT INTO ulp.reuse_pairs
                  SELECT email, password, uniqState(domain) AS domain_hll
                  FROM ulp.credentials
                  WHERE login_type = 'email' AND length(password) > 0
                  GROUP BY email, password
                  SETTINGS max_bytes_before_external_group_by = 4294967296,
                           max_execution_time = 3600`,
        })
        console.warn('[MV backfill] reuse_pairs done')

        console.warn('[MV backfill] All four MV tables backfilled successfully')
      } catch (err) {
        console.error('[MV backfill] Error:', String(err).substring(0, 300))
        // ch_mv_backfill_fired stays '1' to prevent infinite retry.
        // Use POST /api/admin/rebuild-mv to reset and retry.
      }
    })()
  }

```

Delete this entire block (including the blank line after it). The next line after deletion should be the `// ── Data-repair mutations (fire-and-forget, run exactly once) ────────────` comment, which becomes the start of the next section unchanged.

- [ ] **Step 4: Verify `getSettingInt` and `client` are still used elsewhere in the file**

```bash
grep -n "getSettingInt\|client\.exec\|client\.query" lib/clickhouse-migrations.ts
```

Expected: `getSettingInt` still has a call for `ch_repair_mutations_fired` (in the data-repair section just below where the deleted block was), and `client` is still used by the v1-v9 migrations and the data-repair mutations. Both stay — only the `ch_mv_backfill_fired` call site and its IIFE are removed.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/clickhouse-migrations.ts
git commit -m "Add ClickHouse DDL v10: drop Reuse/Stats MV tables and views"
```

---

## Task 7: Remove `invalidateStatsCache` call sites

**Files:**
- Modify: `lib/upload-processor.ts:20` (import), `lib/upload-processor.ts:146` (call)
- Modify: `app/api/admin/dedup/route.ts:25` (import), `app/api/admin/dedup/route.ts:70` (call)
- Modify: `app/api/sources/route.ts:4` (import), `app/api/sources/route.ts:119` (call)

- [ ] **Step 1: `lib/upload-processor.ts` — remove the import**

Find:

```typescript
import { parseULPStream, makeRejectionMap, type ULPCredential, type RejectionReason } from '@/lib/ulp-parser'
import { getClient } from '@/lib/clickhouse'
import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'
import { matchBreach } from '@/lib/breach-matcher'
import { invalidateStatsCache } from '@/lib/stats-cache'
import { updateJob } from '@/lib/upload-jobs'
```

Replace with:

```typescript
import { parseULPStream, makeRejectionMap, type ULPCredential, type RejectionReason } from '@/lib/ulp-parser'
import { getClient } from '@/lib/clickhouse'
import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'
import { matchBreach } from '@/lib/breach-matcher'
import { updateJob } from '@/lib/upload-jobs'
```

- [ ] **Step 2: `lib/upload-processor.ts` — remove the call**

Find:

```typescript
  if (imported > 0) {
    await recordSource(filename, imported)
    invalidateStatsCache()
    checkMonitorsForULPUpload(filename).catch(err =>
      console.error('Domain monitor check error:', err)
    )
  }
```

Replace with:

```typescript
  if (imported > 0) {
    await recordSource(filename, imported)
    checkMonitorsForULPUpload(filename).catch(err =>
      console.error('Domain monitor check error:', err)
    )
  }
```

- [ ] **Step 3: `app/api/admin/dedup/route.ts` — remove the import**

Find:

```typescript
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { getClient } from '@/lib/clickhouse'
import { invalidateStatsCache } from '@/lib/stats-cache'
```

Replace with:

```typescript
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { getClient } from '@/lib/clickhouse'
```

- [ ] **Step 4: `app/api/admin/dedup/route.ts` — remove the call**

Find:

```typescript
  if (rowsAfter < rowsBefore) invalidateStatsCache()

  return NextResponse.json({
```

Replace with:

```typescript
  return NextResponse.json({
```

- [ ] **Step 5: `app/api/sources/route.ts` — remove the import**

Find:

```typescript
import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest, isAdmin } from "@/lib/auth"
import { invalidateStatsCache } from "@/lib/stats-cache"
```

Replace with:

```typescript
import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest, isAdmin } from "@/lib/auth"
```

- [ ] **Step 6: `app/api/sources/route.ts` — remove the call**

Find:

```typescript
    // 2. Purge the credentials for this source file as well.
    await executeQuery(
      `ALTER TABLE ulp.credentials DELETE WHERE source_file = {source_file:String}`,
      { source_file: filename }
    )
    invalidateStatsCache()

    return NextResponse.json({
```

Replace with:

```typescript
    // 2. Purge the credentials for this source file as well.
    await executeQuery(
      `ALTER TABLE ulp.credentials DELETE WHERE source_file = {source_file:String}`,
      { source_file: filename }
    )

    return NextResponse.json({
```

- [ ] **Step 7: Verify no remaining references**

```bash
grep -rn "invalidateStatsCache\|@/lib/stats-cache" --include="*.ts" --include="*.tsx" .
```

Expected: no output (the `__tests__/upload-processor.test.ts` mock is removed in Task 8).

- [ ] **Step 8: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 9: Commit**

```bash
git add lib/upload-processor.ts app/api/admin/dedup/route.ts app/api/sources/route.ts
git commit -m "Remove invalidateStatsCache call sites"
```

---

## Task 8: Remove the `stats-cache` mock from the upload-processor test

**Files:**
- Modify: `__tests__/upload-processor.test.ts:17`

- [ ] **Step 1: Remove the mock**

Find:

```typescript
vi.mock('@/lib/domain-monitor', () => ({
  checkMonitorsForULPUpload: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/stats-cache', () => ({ invalidateStatsCache: vi.fn() }))
vi.mock('@/lib/upload-jobs', () => ({ updateJob: vi.fn() }))
```

Replace with:

```typescript
vi.mock('@/lib/domain-monitor', () => ({
  checkMonitorsForULPUpload: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/upload-jobs', () => ({ updateJob: vi.fn() }))
```

- [ ] **Step 2: Run the test file**

```bash
npx vitest run __tests__/upload-processor.test.ts
```

Expected: both tests in `describe('processZipBuffer', ...)` still pass (`PASS` for both `it(...)` blocks). The mock removal is safe because `lib/upload-processor.ts` no longer imports `@/lib/stats-cache` (Task 7) — without that edit, this test run would fail with a module-resolution error since the mocked module no longer exists.

- [ ] **Step 3: Commit**

```bash
git add __tests__/upload-processor.test.ts
git commit -m "Remove stats-cache mock from upload-processor test"
```

---

## Task 9: Remove the `/api/stats` rate-limit config

**Files:**
- Modify: `lib/rate-limiter.ts:67-73`

- [ ] **Step 1: Remove the `/api/stats` entry**

Find:

```typescript
  private configs: Record<string, RateLimitConfig> = {
    '/api/search': { requests: 30, window: 60000 }, // 30 requests per minute
    '/api/stats': { requests: 10, window: 60000 },   // 10 requests per minute
    '/api/upload': { requests: 5, window: 300000 },  // 5 uploads per 5 minutes
    '/api/auth': { requests: 5, window: 300000 },    // 5 auth attempts per 5 minutes
    'default': { requests: 20, window: 60000 }       // Default: 20 requests per minute
  }
```

Replace with:

```typescript
  private configs: Record<string, RateLimitConfig> = {
    '/api/search': { requests: 30, window: 60000 }, // 30 requests per minute
    '/api/upload': { requests: 5, window: 300000 },  // 5 uploads per 5 minutes
    '/api/auth': { requests: 5, window: 300000 },    // 5 auth attempts per 5 minutes
    'default': { requests: 20, window: 60000 }       // Default: 20 requests per minute
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/rate-limiter.ts
git commit -m "Remove /api/stats rate-limit config"
```

---

## Task 10: Apply DDL v10 to the running stack and verify

**Files:** none (operational step — applies the migration written in Task 6 to the live containers)

The migration runner in `lib/clickhouse-migrations.ts` runs once at app startup, gated by `ch_ddl_version` in SQLite (`app_settings`). Restarting the `app` container re-runs it; since `ch_ddl_version` is currently `9` and `DDL_VERSION` is now `10`, the `lastDdl < 10` block from Task 6 will fire.

- [ ] **Step 1: Rebuild and restart the app container**

The code change from Task 6 needs to be in the running container's image/volume. If the app container runs from a bind-mounted source (dev mode), a restart is enough; if it runs from a built image, rebuild first:

```bash
docker compose up -d --build app
```

- [ ] **Step 2: Watch the startup logs for the v10 migration message**

```bash
docker compose logs app --tail=100 | grep -i "DDL v10\|ClickHouse migration"
```

Expected: a line containing `DDL v10 applied (dropped stats/reuse MV tables + views)`, followed by `DDL now at v10`.

- [ ] **Step 3: Verify `ch_ddl_version` is now 10 in SQLite**

```bash
docker exec ulpsuite_app node -e "const db=require('better-sqlite3')('/app/data/ulp.db'); console.log(JSON.stringify(db.prepare(\"SELECT key_name, value FROM app_settings WHERE key_name LIKE 'ch_%'\").all()))"
```

Expected: `ch_ddl_version` is `"10"`.

- [ ] **Step 4: Verify the 4 tables and 4 views are gone from ClickHouse**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT name FROM system.tables WHERE database = 'ulp' AND name IN ('domain_counts','password_counts','url_host_counts','reuse_pairs','mv_domain_counts','mv_password_counts','mv_url_host_counts','mv_reuse_pairs')"
```

Expected: empty output (zero rows).

- [ ] **Step 5: Verify `ulp.credentials` is unaffected**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials"
```

Expected: `52339303` (or higher, if new imports landed) — same table, same row count as before, no data loss.

---

## Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all tests pass (including the two `processZipBuffer` tests from Task 8).

- [ ] **Step 2: Run the production build**

```bash
npm run build
```

Expected: build succeeds with no errors about missing modules (`@/lib/stats-cache`, `@/lib/mv-ready`) or missing routes (`/reuse`, `/similar`, `/stats`, `/api/admin/rebuild-mv`).

- [ ] **Step 3: Run the linter**

```bash
npm run lint
```

Expected: no new errors (in particular, no "unused import" warnings for `AlertTriangle`, `Layers`, `BarChart2` in `components/app-sidebar.tsx`).

- [ ] **Step 4: Final repo-wide grep for stragglers**

```bash
grep -rn "stats-cache\|mv-ready\|rebuild-mv\|isMvReady\|invalidateStatsCache\|invalidateMvCache\|invalidateAllMvCaches\|ulp\.domain_counts\|ulp\.password_counts\|ulp\.url_host_counts\|ulp\.reuse_pairs\|mv_domain_counts\|mv_password_counts\|mv_url_host_counts\|mv_reuse_pairs\|app/reuse\|app/similar\|app/stats\|/api/reuse\|/api/similar\|/api/stats\b" --include="*.ts" --include="*.tsx" .
```

Expected: no output, **except** `hooks/useStats.ts` (pre-existing dead code referencing `/api/stats`, explicitly out of scope) and the historical plan/spec docs under `docs/superpowers/plans/` and `docs/superpowers/specs/` (e.g. `2026-06-06-materialized-views.md`), which are point-in-time records and not updated.

- [ ] **Step 5: Manually verify the app**

Start the dev server (or use the running `ulpsuite_app` container) and check in a browser:
1. Sidebar shows only **Credentials**, **Batch Lookup**, **Breaches** under "Search" — no Reuse, Similar, or Stats links.
2. Navigating directly to `/reuse`, `/similar`, or `/stats` returns a 404 (page no longer exists).
3. `/credentials` search still works — run a token search (e.g. a common domain fragment) and confirm results return with the existing filter dropdowns (country tier, login type, etc.) populated and functional.
4. `/sources` page loads and the delete-source action (admin) still works without errors (exercises the edited `app/api/sources/route.ts`).

---

## Self-Review

**Spec coverage:**
- Delete Similar (page + API) — Task 1 ✓
- Delete Reuse (page + API) — Task 2 ✓
- Delete Stats (page + API + stats-cache) — Task 3 ✓
- Delete mv-ready + rebuild-mv admin route — Task 4 ✓
- Sidebar nav cleanup — Task 5 ✓
- ClickHouse DDL v10 (drop 4 MV tables + 4 views + dead backfill block) — Task 6 ✓
- Remove `invalidateStatsCache` call sites (upload-processor, dedup, sources) — Task 7 ✓
- Remove stats-cache test mock — Task 8 ✓
- Remove `/api/stats` rate-limit config — Task 9 ✓
- Apply + verify DDL v10 on the live stack — Task 10 ✓
- Full test/build/lint/manual verification — Task 11 ✓
- Materialized columns used by `/credentials` (country_tier, login_type, password_mask, password_entropy_band, url_scheme, email_domain, url_host, is_corporate_email, tld, password_length) — confirmed untouched throughout ✓
- Breach Catalog and `hooks/useStats.ts` — explicitly out of scope, called out in Tasks 3 and 11 ✓

**Placeholder scan:** no TBD/TODO/"add appropriate"/"similar to Task N" patterns — every step shows the literal find/replace code or exact command.

**Type consistency:** no new types/functions introduced; this plan is purely deletions + import/config edits. `runMigration`, `getSettingInt`, `setSetting`, `client` signatures in `lib/clickhouse-migrations.ts` are unchanged — verified their other call sites remain intact in Task 6 Step 4.
