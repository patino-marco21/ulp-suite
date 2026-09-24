# v1 API Cursor Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional keyset (cursor) pagination to `/api/v1/search/credentials`, reusing the existing tested `lib/cursor-pagination.ts` primitive the internal Credentials Browser already relies on, without changing any existing behavior for callers that don't opt in.

**Architecture:** One route file changes. `cursor` absent → byte-for-byte identical to today. `cursor` present → keyset `WHERE` instead of `OFFSET`, `count()` skipped, `page`/`pages` become `null`. Both modes gain an additive `next_cursor` field so any caller can discover and switch to cheap deep paging from page 1 onward.

**Tech Stack:** Next.js route handler, `lib/cursor-pagination.ts` (existing, unmodified), ClickHouse via `lib/clickhouse.ts`'s `executeQuery`.

## Global Constraints

- `lib/cursor-pagination.ts` is NOT modified — only consumed, exactly as `app/api/credentials/route.ts` already consumes it.
- Offset-mode behavior (no `cursor` param) must be byte-for-byte unchanged for existing response fields — only new, additive fields may appear.
- Only `'imported_desc'` is a valid sort for this endpoint (it has never offered a sort choice) — an invalid or foreign-sort cursor token falls back to offset mode, mirroring the internal route's own `if (cursor && cursor.sort === sortKey)` convention, not a hard error.
- This codebase tests Next.js route files via source-text assertions against the raw file content (see `__tests__/credentials-route.test.ts`), not full request/response mocking — follow that same convention for the new test.
- Do NOT edit `app/docs/page.tsx` as part of this plan — it already documents this endpoint incorrectly as `POST` with body params `query`/`type`/`includePasswords`, a pre-existing mismatch with the real `GET` + query-string (`q`/`page`/`limit`) implementation, unrelated to this change and out of scope here. Flag it separately instead of touching it.

---

### Task 1: Add cursor pagination to the route, with a source-text test

**Files:**
- Modify: `app/api/v1/search/credentials/route.ts`
- Test: `__tests__/v1-credentials-cursor-pagination.test.ts`

**Interfaces:**
- Consumes: `decodeCursor`, `buildCursorWhere`, `encodeCursor` from `@/lib/cursor-pagination` (all pre-existing, unmodified).
- Produces: response now includes `next_cursor: string | null` in every case; `page`/`pages`/`total` become `null` specifically when a cursor was used.

- [ ] **Step 1: Write the failing test**

Create `__tests__/v1-credentials-cursor-pagination.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('v1 search route — cursor pagination (keyset, additive)', () => {
  const source = readFileSync(new URL('../app/api/v1/search/credentials/route.ts', import.meta.url), 'utf8')
  const getFn = source.slice(source.indexOf('export async function GET'))

  test('imports the shared cursor-pagination primitives', () => {
    expect(source).toMatch(/from ["']@\/lib\/cursor-pagination["']/)
    expect(source).toContain('decodeCursor')
    expect(source).toContain('buildCursorWhere')
    expect(source).toContain('encodeCursor')
  })

  test('reads an optional cursor query param', () => {
    expect(getFn).toMatch(/searchParams\.get\(['"]cursor['"]\)/)
  })

  test('an invalid or foreign-sort cursor token falls back to offset mode instead of erroring', () => {
    expect(getFn).toMatch(/cursor\s*&&\s*cursor\.sort\s*===\s*SORT_KEY/)
  })

  test('skips the count() query when a cursor is present', () => {
    expect(getFn).toMatch(/usingCursor[\s\S]{0,40}\?\s*Promise\.resolve\(null\)/)
  })

  test('drops OFFSET from the data query when a cursor is present', () => {
    expect(getFn).toContain("usingCursor ? '' : ' OFFSET {offset:UInt32}'")
  })

  test('computes next_cursor from the last row only when a full page was returned', () => {
    expect(getFn).toMatch(/rowsArr\.length === limit/)
    expect(getFn).toContain('encodeCursor(SORT_KEY')
  })

  test('response always includes next_cursor, additive to the existing shape', () => {
    expect(getFn).toContain('next_cursor')
    expect(getFn).toContain('results: rows')
    expect(getFn).toContain('query: q')
  })

  test('page/pages become null specifically in cursor mode, not removed from the response', () => {
    expect(getFn).toMatch(/page:\s*usingCursor \? null : page/)
    expect(getFn).toMatch(/pages:\s*usingCursor \? null : Math\.ceil/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/v1-credentials-cursor-pagination.test.ts`
Expected: FAIL — none of these patterns exist in the current source yet.

- [ ] **Step 3: Implement the route change**

Replace the full contents of `app/api/v1/search/credentials/route.ts` with:

```ts
/**
 * Search API v1 - ULP Credentials Search
 * GET /api/v1/search/credentials?q=<query>&page=1&limit=100
 * GET /api/v1/search/credentials?q=<query>&cursor=<token>&limit=100  (keyset pagination — recommended for deep paging; see next_cursor in the response)
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { parseULPQuery, buildULPWhere } from "@/lib/ulp-search"
import { decodeCursor, buildCursorWhere, encodeCursor } from "@/lib/cursor-pagination"

export const dynamic = 'force-dynamic'

// This endpoint has never offered a sort choice — it has always been a
// fixed ORDER BY imported_at DESC. Kept as a named constant so the cursor
// encode/decode calls below read the same as the internal browse route's,
// which does support multiple sorts.
const SORT_KEY = 'imported_desc' as const

export async function GET(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/search/credentials')

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q') || ''
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '100')))
  const offset = (page - 1) * limit
  const cursorToken = searchParams.get('cursor') || ''

  if (!q.trim()) {
    const response = NextResponse.json({ success: true, results: [], total: 0, page: 1, pages: 0, next_cursor: null })
    return addRateLimitHeaders(response, authResult.rateLimit)
  }

  try {
    const { clause, params } = buildULPWhere(parseULPQuery(q))

    // Keyset pagination: reuses the same tested primitive the internal
    // Credentials Browser already uses (lib/cursor-pagination.ts). An
    // invalid or foreign-sort cursor is treated the same as no cursor —
    // falls back to offset mode — matching that route's own convention.
    let cursorClause = ''
    let cursorParams: Record<string, unknown> = {}
    if (cursorToken) {
      const cursor = decodeCursor(cursorToken)
      if (cursor && cursor.sort === SORT_KEY) {
        const { clause: cc, params: cp } = buildCursorWhere(SORT_KEY, cursor)
        cursorClause = ` AND ${cc}`
        cursorParams = cp
      }
    }
    const usingCursor = cursorClause !== ''

    const [countResult, rows] = await Promise.all([
      // Count: break mode returns a partial count rather than throwing on
      // timeout. Skipped entirely on cursor pages — the matched set doesn't
      // change as you page through it, so re-counting on every page is pure
      // waste at this table's scale; the client keeps the first page's total.
      usingCursor
        ? Promise.resolve(null)
        : executeQuery(
            `SELECT count() as total FROM ulp.credentials WHERE ${clause}
             SETTINGS optimize_trivial_count_query = 1,
                      max_execution_time = 300,
                      timeout_overflow_mode = 'break',
                      use_query_cache = 0`,
            params
          ),
      // Data: throw mode on timeout so we return a 408 instead of silent 0 rows
      // (timeout_overflow_mode=break with ORDER BY does not flush sort buffer —
      // ClickHouse issue #52234).
      executeQuery(
        `SELECT url, email, password, domain, source_file, imported_at
         FROM ulp.credentials WHERE ${clause}${cursorClause}
         ORDER BY imported_at DESC LIMIT {limit:UInt32}${usingCursor ? '' : ' OFFSET {offset:UInt32}'}
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw',
                  http_wait_end_of_query = 1`,
        { ...params, ...cursorParams, limit, ...(usingCursor ? {} : { offset }) }
      ),
    ])

    const rowsArr = rows as Record<string, unknown>[]
    const nextCursor = rowsArr.length === limit
      ? encodeCursor(SORT_KEY, rowsArr[rowsArr.length - 1])
      : null

    const total = countResult ? Number((countResult as Array<{ total?: unknown }>)[0]?.total || 0) : null
    const response = NextResponse.json({
      success: true,
      results: rows,
      total,
      page: usingCursor ? null : page,
      pages: usingCursor ? null : Math.ceil((total ?? 0) / limit),
      next_cursor: nextCursor,
      query: q,
    })
    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const isTimeout = msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout') || msg.includes('Timeout')

    if (isTimeout) {
      const response = NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Query timed out — use a more specific search term (exact email, domain, or breach name) for fast results at this data size.',
        results:   [],
        total:     0,
        pages:     0,
      }, { status: 408 })
      return addRateLimitHeaders(response, authResult.rateLimit)
    }

    console.error('v1 search error:', msg)
    return NextResponse.json({ success: false, error: 'Search failed' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/v1-credentials-cursor-pagination.test.ts`
Expected: PASS, 7/7 tests.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean — no type errors from the new imports or the `Record<string, unknown>` cast.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all tests pass, including the pre-existing `cursor-pagination.test.ts` (untouched) and any other v1-route tests.

- [ ] **Step 7: Commit**

```bash
git add app/api/v1/search/credentials/route.ts __tests__/v1-credentials-cursor-pagination.test.ts
git commit -m "feat(api): add cursor pagination to v1 search, additive and backward-compatible

Reuses lib/cursor-pagination.ts exactly as the internal Credentials
Browser already does. Callers that never send 'cursor' see byte-for-
byte identical page/pages/total behavior; every response now also
carries next_cursor so any caller can switch to cheap keyset paging
from page 1 onward without an opt-in flag."
```

---

### Task 2: Manual smoke test against a live key (optional but recommended)

**Files:** none — verification only.

**Interfaces:** none.

- [ ] **Step 1: Confirm offset mode is unchanged**

With a real admin/analyst API key and the app running against live ClickHouse:

```bash
curl -s "http://localhost:3000/api/v1/search/credentials?q=gmail.com&page=1&limit=5" \
  -H "X-API-Key: <your key>" | python3 -m json.tool
```

Expected: same shape as before this change (`success, results, total, page, pages, query`), plus a new `next_cursor` field.

- [ ] **Step 2: Follow next_cursor into cursor mode**

Take the `next_cursor` value from Step 1's response and issue a follow-up request:

```bash
curl -s "http://localhost:3000/api/v1/search/credentials?q=gmail.com&cursor=<next_cursor from step 1>&limit=5" \
  -H "X-API-Key: <your key>" | python3 -m json.tool
```

Expected: `page: null`, `pages: null`, `total: null`, `results` continuing where Step 1's page left off (no overlap, no gap), and its own `next_cursor` for the page after that.

- [ ] **Step 3: Confirm an invalid cursor degrades gracefully**

```bash
curl -s "http://localhost:3000/api/v1/search/credentials?q=gmail.com&cursor=not-a-real-token&limit=5" \
  -H "X-API-Key: <your key>" | python3 -m json.tool
```

Expected: behaves exactly like plain offset-mode page 1 (falls back silently, no 500/400).
