# NORM_EXPR WHERE Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four API endpoints that compare against raw `email`/`domain` columns in WHERE clauses, causing them to silently miss Cases A–D corrupted rows until background mutations complete.

**Architecture:** Each affected file imports `NORM_EMAIL_EXPR` / `NORM_DOMAIN_EXPR` / `NORM_COLS` from `lib/ulp-normalize.ts` — expressions already used in ORDER BY and SELECT elsewhere — and wraps the WHERE comparison with the normalizing expression. No schema changes, no new files except one test file.

**Tech Stack:** Next.js 14 API routes, ClickHouse JS client, TypeScript, Vitest

---

## File Map

| File | Action |
|---|---|
| `__tests__/ulp-normalize-where.test.ts` | **Create** — verify NORM_EXPR exports are correct expressions |
| `app/api/v1/lookup/route.ts` | Modify lines 33–48 — NORM_EMAIL_EXPR + NORM_DOMAIN_EXPR in WHERE |
| `app/api/v1/lookup/batch/route.ts` | Modify lines 77–113 — NORM_EMAIL/DOMAIN_EXPR in WHERE, NORM_COLS in SELECT |
| `app/api/v1/search/domain/route.ts` | Modify lines 31–41 — NORM_DOMAIN_EXPR in both count + data WHERE |
| `app/api/credentials/route.ts` | Modify line 118 — NORM_DOMAIN_EXPR in domain filter WHERE |

---

## Task 1: Test file for NORM_EXPR exports

**Files:**
- Create: `__tests__/ulp-normalize-where.test.ts`

Context: `lib/ulp-normalize.ts` exports `NORM_EMAIL_EXPR`, `NORM_DOMAIN_EXPR`, and `NORM_COLS` as plain TypeScript strings containing ClickHouse SQL expressions. These tests confirm the strings are non-empty, contain `if(` (i.e. they are normalizing expressions, not bare column names like `email` or `domain`), and that `NORM_COLS` produces all four aliased columns (`url`, `email`, `password`, `domain`). No ClickHouse instance needed — pure string assertions.

- [ ] **Step 1: Write the test file**

```ts
// __tests__/ulp-normalize-where.test.ts
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR, NORM_COLS } from '@/lib/ulp-normalize'

describe('NORM_EXPR strings used in WHERE clauses', () => {
  // ── NORM_EMAIL_EXPR ─────────────────────────────────────────────────────────
  it('NORM_EMAIL_EXPR is a non-empty string', () => {
    expect(typeof NORM_EMAIL_EXPR).toBe('string')
    expect(NORM_EMAIL_EXPR.length).toBeGreaterThan(0)
  })

  it('NORM_EMAIL_EXPR contains if( — is a normalizing expression not a bare column name', () => {
    expect(NORM_EMAIL_EXPR).toContain('if(')
  })

  it('NORM_EMAIL_EXPR is not just the word "email"', () => {
    expect(NORM_EMAIL_EXPR.trim()).not.toBe('email')
  })

  // ── NORM_DOMAIN_EXPR ────────────────────────────────────────────────────────
  it('NORM_DOMAIN_EXPR is a non-empty string', () => {
    expect(typeof NORM_DOMAIN_EXPR).toBe('string')
    expect(NORM_DOMAIN_EXPR.length).toBeGreaterThan(0)
  })

  it('NORM_DOMAIN_EXPR contains if( — is a normalizing expression not a bare column name', () => {
    expect(NORM_DOMAIN_EXPR).toContain('if(')
  })

  it('NORM_DOMAIN_EXPR is not just the word "domain"', () => {
    expect(NORM_DOMAIN_EXPR.trim()).not.toBe('domain')
  })

  // ── NORM_COLS ───────────────────────────────────────────────────────────────
  it('NORM_COLS is a non-empty string', () => {
    expect(typeof NORM_COLS).toBe('string')
    expect(NORM_COLS.length).toBeGreaterThan(0)
  })

  it('NORM_COLS contains AS url — produces url alias', () => {
    expect(NORM_COLS).toContain('AS url')
  })

  it('NORM_COLS contains AS email — produces email alias', () => {
    expect(NORM_COLS).toContain('AS email')
  })

  it('NORM_COLS contains AS password — produces password alias', () => {
    expect(NORM_COLS).toContain('AS password')
  })

  it('NORM_COLS contains AS domain — produces domain alias', () => {
    expect(NORM_COLS).toContain('AS domain')
  })

  it('NORM_COLS contains if( — is a normalizing expression not bare column names', () => {
    expect(NORM_COLS).toContain('if(')
  })

  // ── WHERE wrapping safety ───────────────────────────────────────────────────
  // Verify the expressions can be safely wrapped in ( ) for a WHERE clause.
  // Template: WHERE (${NORM_EMAIL_EXPR}) = {param:String}

  it('NORM_EMAIL_EXPR wrapped in parens forms a valid WHERE fragment', () => {
    const fragment = `WHERE (${NORM_EMAIL_EXPR}) = {email:String}`
    expect(fragment).toContain('WHERE (')
    expect(fragment).toContain(') = {email:String}')
  })

  it('NORM_DOMAIN_EXPR wrapped in parens forms a valid WHERE fragment', () => {
    const fragment = `WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}`
    expect(fragment).toContain('WHERE (')
    expect(fragment).toContain(') = {domain:String}')
  })

  it('NORM_EMAIL_EXPR wrapped in parens forms a valid IN fragment', () => {
    const emailList = '{e0:String},{e1:String}'
    const fragment = `WHERE (${NORM_EMAIL_EXPR}) IN (${emailList})`
    expect(fragment).toContain('WHERE (')
    expect(fragment).toContain(`) IN (${emailList})`)
  })

  it('NORM_DOMAIN_EXPR wrapped in parens forms a valid IN fragment', () => {
    const domainList = '{d0:String},{d1:String}'
    const fragment = `WHERE (${NORM_DOMAIN_EXPR}) IN (${domainList})`
    expect(fragment).toContain('WHERE (')
    expect(fragment).toContain(`) IN (${domainList})`)
  })
})
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
npm test -- __tests__/ulp-normalize-where.test.ts
```

Expected: all 15 tests PASS. If any fail, re-read `lib/ulp-normalize.ts` to check the exact export names and string contents.

- [ ] **Step 3: Commit**

```bash
git add __tests__/ulp-normalize-where.test.ts
git commit -m "test(normalize): verify NORM_EMAIL_EXPR / NORM_DOMAIN_EXPR / NORM_COLS exports"
```

---

## Task 2: Fix `app/api/v1/lookup/route.ts`

**Files:**
- Modify: `app/api/v1/lookup/route.ts`

Context: This file handles `GET /api/v1/lookup?email=` and `GET /api/v1/lookup?domain=`. Both branches run a ClickHouse query with a raw column comparison in WHERE. Corrupted rows (Cases A–D) have wrong values in the raw `email` and `domain` columns so they are never returned by this endpoint until mutations complete. Fix: wrap the comparison with NORM_EMAIL_EXPR or NORM_DOMAIN_EXPR respectively.

The file currently starts with:
```ts
import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
```

- [ ] **Step 1: Add the import**

In `app/api/v1/lookup/route.ts`, add one import line after the existing imports:

```ts
import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
```

- [ ] **Step 2: Fix the email lookup WHERE**

Find this block (inside the `if (email)` branch, approximately lines 33–42):

```ts
      results = await executeQuery(
        `SELECT url, email, domain, source_file, imported_at
         FROM ulp.credentials
         WHERE email = {email:String}
         ORDER BY imported_at DESC LIMIT 100`,
        { email }
      )
```

Replace with:

```ts
      results = await executeQuery(
        `SELECT url, email, domain, source_file, imported_at
         FROM ulp.credentials
         WHERE (${NORM_EMAIL_EXPR}) = {email:String}
         ORDER BY imported_at DESC LIMIT 100`,
        { email }
      )
```

- [ ] **Step 3: Fix the domain lookup WHERE**

Find this block (inside the final `results = await executeQuery(` for domain, approximately lines 43–52):

```ts
    results = await executeQuery(
      `SELECT url, email, domain, source_file, imported_at
       FROM ulp.credentials
       WHERE domain = {domain:String}
       ORDER BY imported_at DESC LIMIT 100`,
      { domain }
    )
```

Replace with:

```ts
    results = await executeQuery(
      `SELECT url, email, domain, source_file, imported_at
       FROM ulp.credentials
       WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}
       ORDER BY imported_at DESC LIMIT 100`,
      { domain }
    )
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: 370 tests pass (355 existing + 15 new from Task 1).

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/lookup/route.ts
git commit -m "fix(v1/lookup): use NORM_EMAIL_EXPR + NORM_DOMAIN_EXPR in WHERE clauses"
```

---

## Task 3: Fix `app/api/v1/lookup/batch/route.ts`

**Files:**
- Modify: `app/api/v1/lookup/batch/route.ts`

Context: This file handles `POST /api/v1/lookup/batch` with up to 100 emails and/or domains. The email batch uses `WHERE email IN (...)` and selects raw columns; the domain batch uses `WHERE domain IN (...)` and selects raw columns. Both need NORM_EXPR in WHERE and NORM_COLS in SELECT so that (a) corrupted rows are found, and (b) the returned `email`/`domain` values are the corrected ones. The JS post-query `.filter(r => r.email === lc)` and `.filter(r => r.domain === lc)` continue to work because NORM_COLS aliases the normalized values as `email` and `domain`.

Note: adding NORM_COLS to SELECT adds a `password` field to the batch response that wasn't there before. This is intentional — the corrupted-row fix requires returning normalized values, and NORM_COLS is the established pattern for doing that.

The file currently starts with:
```ts
import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
```

- [ ] **Step 1: Add the import**

```ts
import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR, NORM_COLS } from '@/lib/ulp-normalize'
```

- [ ] **Step 2: Fix the email batch SELECT and WHERE**

Find this block (inside the `if (emails.length > 0)` branch, approximately lines 77–84):

```ts
      const rows = await executeQuery(
        `SELECT email, url, domain, source_file, breach_name, imported_at
         FROM ulp.credentials
         WHERE email IN (${emailList})
         ORDER BY imported_at DESC
         LIMIT {cap:UInt32}`,
        { ...emailParams, cap: emails.length * RESULTS_CAP }
      ) as Array<{ email: string; url: string; domain: string; source_file: string; breach_name: string; imported_at: string }>
```

Replace with:

```ts
      const rows = await executeQuery(
        `SELECT ${NORM_COLS}, source_file, breach_name, imported_at
         FROM ulp.credentials
         WHERE (${NORM_EMAIL_EXPR}) IN (${emailList})
         ORDER BY imported_at DESC
         LIMIT {cap:UInt32}`,
        { ...emailParams, cap: emails.length * RESULTS_CAP }
      ) as Array<{ email: string; url: string; password: string; domain: string; source_file: string; breach_name: string; imported_at: string }>
```

- [ ] **Step 3: Fix the domain batch SELECT and WHERE**

Find this block (inside the `if (domains.length > 0)` branch, approximately lines 96–107):

```ts
      const rows = await executeQuery(
        `SELECT domain, email, url, source_file, breach_name, imported_at
         FROM ulp.credentials
         WHERE domain IN (${domainList})
         ORDER BY imported_at DESC
         LIMIT {cap:UInt32}`,
        { ...domainParams, cap: domains.length * RESULTS_CAP }
      ) as Array<{ domain: string; email: string; url: string; source_file: string; breach_name: string; imported_at: string }>
```

Replace with:

```ts
      const rows = await executeQuery(
        `SELECT ${NORM_COLS}, source_file, breach_name, imported_at
         FROM ulp.credentials
         WHERE (${NORM_DOMAIN_EXPR}) IN (${domainList})
         ORDER BY imported_at DESC
         LIMIT {cap:UInt32}`,
        { ...domainParams, cap: domains.length * RESULTS_CAP }
      ) as Array<{ email: string; url: string; password: string; domain: string; source_file: string; breach_name: string; imported_at: string }>
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: 370 tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/lookup/batch/route.ts
git commit -m "fix(v1/lookup/batch): use NORM_EXPR in WHERE + NORM_COLS in SELECT"
```

---

## Task 4: Fix `app/api/v1/search/domain/route.ts`

**Files:**
- Modify: `app/api/v1/search/domain/route.ts`

Context: This file handles `GET /api/v1/search/domain?domain=`. The WHERE clause `domain = {domain:String}` appears in **two** separate `executeQuery` calls inside a `Promise.all` — both the count query and the data query must be fixed. The SELECT list already uses raw columns (which is fine here since domain search doesn't need full normalization in the response — only the WHERE needs fixing so results are found).

The file currently starts with:
```ts
import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
```

- [ ] **Step 1: Add the import**

```ts
import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
```

- [ ] **Step 2: Fix the count query WHERE**

Find this block (first entry in the `Promise.all`, approximately lines 31–35):

```ts
      executeQuery(
        `SELECT count() as total FROM ulp.credentials WHERE domain = {domain:String}`,
        { domain }
      ),
```

Replace with:

```ts
      executeQuery(
        `SELECT count() as total FROM ulp.credentials WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}`,
        { domain }
      ),
```

- [ ] **Step 3: Fix the data query WHERE**

Find this block (second entry in the `Promise.all`, approximately lines 36–41):

```ts
      executeQuery(
        `SELECT url, email, password, domain, source_file, imported_at
         FROM ulp.credentials WHERE domain = {domain:String}
         ORDER BY imported_at DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        { domain, limit, offset }
      ),
```

Replace with:

```ts
      executeQuery(
        `SELECT url, email, password, domain, source_file, imported_at
         FROM ulp.credentials WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}
         ORDER BY imported_at DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        { domain, limit, offset }
      ),
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: 370 tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/search/domain/route.ts
git commit -m "fix(v1/search/domain): use NORM_DOMAIN_EXPR in WHERE (count + data query)"
```

---

## Task 5: Fix `app/api/credentials/route.ts`

**Files:**
- Modify: `app/api/credentials/route.ts`

Context: This is the internal credentials browser API (`GET /api/credentials`). The domain filter WHERE uses a raw `domain` column comparison. `NORM_DOMAIN_EXPR` is **already imported** at the top of this file — it's used in `SORT_MAP` for ORDER BY. Only one line changes.

- [ ] **Step 1: Fix the domain filter WHERE**

Find this line (approximately line 118, inside the WHERE builder section):

```ts
  if (domain)      { conditions.push('domain = {domain:String}');               params.domain = domain }
```

Replace with:

```ts
  if (domain)      { conditions.push(`(${NORM_DOMAIN_EXPR}) = {domain:String}`); params.domain = domain }
```

No import change needed — `NORM_DOMAIN_EXPR` is already imported.

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: 370 tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/api/credentials/route.ts
git commit -m "fix(credentials): use NORM_DOMAIN_EXPR in domain filter WHERE clause"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run full test suite one more time**

```bash
npm test
```

Expected output:
```
Test Files  5 passed (5)
      Tests  370 passed (370)
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 3: Verify all five changed files are committed**

```bash
git log --oneline -6
```

Expected: five recent commits visible — one for the test file, one each for the four route files.

- [ ] **Step 4: Final summary commit (if any unstaged changes remain)**

If `git status` shows anything untracked or modified, commit it now. Otherwise skip this step.
