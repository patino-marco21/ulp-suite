# Cursor Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OFFSET-based pagination on `/api/credentials` and `/api/search` with keyset/cursor pagination to eliminate O(offset) scans and remove the 2000-page safety cap.

**Architecture:** A new shared `lib/cursor-pagination.ts` exports SORT_MAP, encodeCursor/decodeCursor, and buildCursorWhere. Both API routes import from this lib and replace `page`/`offset` with a `cursor` token param. The frontend replaces `page` state with a cursor stack enabling next/prev navigation without server-side state.

**Tech Stack:** TypeScript, Next.js App Router API routes, ClickHouse parameterized queries, React useState, Vitest

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `lib/cursor-pagination.ts` | SORT_MAP, encodeCursor, decodeCursor, buildCursorWhere |
| Create | `__tests__/cursor-pagination.test.ts` | Unit tests for all cursor lib exports |
| Modify | `app/api/credentials/route.ts` | Replace page/offset with cursor; import from cursor-pagination |
| Modify | `app/api/search/route.ts` | Same as credentials; variable naming avoids shadowing existing `clause`/`params` |
| Modify | `app/credentials/page.tsx` | Replace page state with cursor stack; next/prev pagination UI |

---

### Task 1: lib/cursor-pagination.ts (TDD)

**Files:**
- Create: `lib/cursor-pagination.ts`
- Create: `__tests__/cursor-pagination.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/cursor-pagination.test.ts`:

```typescript
import { describe, test, expect } from 'vitest'
import {
  SORT_MAP,
  encodeCursor,
  decodeCursor,
  buildCursorWhere,
  type SortKey,
} from '@/lib/cursor-pagination'

describe('SORT_MAP', () => {
  test('has all 8 sort keys', () => {
    const keys: SortKey[] = [
      'imported_desc', 'imported_asc',
      'domain_asc', 'domain_desc',
      'email_asc', 'email_desc',
      'pw_len_desc', 'pw_len_asc',
    ]
    for (const k of keys) expect(SORT_MAP[k]).toBeDefined()
  })

  test('domain_asc puts empty domains last', () => {
    expect(SORT_MAP['domain_asc']).toContain("(domain='') ASC")
  })
})

describe('encodeCursor / decodeCursor', () => {
  test('round-trips imported_desc', () => {
    const row = { imported_at: '2024-01-01 00:00:00', domain: 'example.com', email: 'a@b.com', url: 'https://x', password: 'pass' }
    const token = encodeCursor('imported_desc', row)
    const payload = decodeCursor(token)
    expect(payload).not.toBeNull()
    expect(payload!.sort).toBe('imported_desc')
    expect(payload!.v.domain).toBe('example.com')
  })

  test('captures only CURSOR_COLS for each sort', () => {
    const row = { imported_at: '2024-01-01 00:00:00', domain: 'x.com', email: 'a@x.com', url: 'u', password: 'p', password_length: 8, extra_field: 'ignored' }
    const token = encodeCursor('pw_len_desc', row)
    const payload = decodeCursor(token)!
    expect(Object.keys(payload.v)).toEqual(['password_length', 'domain', 'email', 'imported_at', 'url'])
    expect(payload.v).not.toHaveProperty('password')
    expect(payload.v).not.toHaveProperty('extra_field')
  })

  test('decodeCursor returns null on empty string', () => {
    expect(decodeCursor('')).toBeNull()
  })

  test('decodeCursor returns null on malformed base64', () => {
    expect(decodeCursor('not-valid-base64!!!')).toBeNull()
  })

  test('decodeCursor returns null on valid base64 but invalid JSON', () => {
    const bad = Buffer.from('not json').toString('base64')
    expect(decodeCursor(bad)).toBeNull()
  })
})

describe('buildCursorWhere', () => {
  const baseRow = { imported_at: '2024-06-01 12:00:00', domain: 'test.com', email: 'u@test.com', url: 'https://test.com', password: 'abc' }

  test('imported_asc: tuple greater-than clause', () => {
    const payload = { sort: 'imported_asc' as SortKey, v: { ...baseRow } }
    const { clause, params } = buildCursorWhere('imported_asc', payload)
    expect(clause).toContain('(imported_at, domain, email, url, password) >')
    expect(Object.keys(params)).toEqual(expect.arrayContaining(['c_ia', 'c_d', 'c_e', 'c_u', 'c_pw']))
  })

  test('imported_desc: descending OR expansion', () => {
    const payload = { sort: 'imported_desc' as SortKey, v: { ...baseRow } }
    const { clause, params } = buildCursorWhere('imported_desc', payload)
    expect(clause).toContain('imported_at < {c_ia:DateTime}')
    expect(clause).toContain('imported_at = {c_ia:DateTime}')
    expect(params).toHaveProperty('c_ia')
  })

  test('domain_asc with non-empty domain: includes OR domain = empty', () => {
    const payload = { sort: 'domain_asc' as SortKey, v: { ...baseRow, domain: 'test.com' } }
    const { clause } = buildCursorWhere('domain_asc', payload)
    expect(clause).toContain("domain = ''")
    expect(clause).toContain("domain != ''")
  })

  test('domain_asc with empty domain: only empty domain branch', () => {
    const payload = { sort: 'domain_asc' as SortKey, v: { ...baseRow, domain: '' } }
    const { clause } = buildCursorWhere('domain_asc', payload)
    expect(clause).toContain("domain = ''")
    expect(clause).not.toContain("domain != ''")
  })

  test('domain_desc with non-empty domain: includes domain < or OR empty', () => {
    const payload = { sort: 'domain_desc' as SortKey, v: { ...baseRow, domain: 'test.com' } }
    const { clause } = buildCursorWhere('domain_desc', payload)
    expect(clause).toContain('domain < {c_d:String}')
    expect(clause).toContain("domain = ''")
  })

  test('domain_desc with empty domain: only empty domain tiebreaker', () => {
    const payload = { sort: 'domain_desc' as SortKey, v: { ...baseRow, domain: '' } }
    const { clause } = buildCursorWhere('domain_desc', payload)
    expect(clause).toContain("domain = ''")
    expect(clause).not.toContain('domain < {c_d:String}')
  })

  test('email_asc: tuple greater-than', () => {
    const payload = { sort: 'email_asc' as SortKey, v: { ...baseRow } }
    const { clause } = buildCursorWhere('email_asc', payload)
    expect(clause).toContain('(email, domain, imported_at, url, password) >')
  })

  test('email_desc: descending OR expansion', () => {
    const payload = { sort: 'email_desc' as SortKey, v: { ...baseRow } }
    const { clause } = buildCursorWhere('email_desc', payload)
    expect(clause).toContain('email < {c_e:String}')
  })

  test('pw_len_asc: password_length > or equal with tiebreaker', () => {
    const payload = { sort: 'pw_len_asc' as SortKey, v: { ...baseRow, password_length: 8 } }
    const { clause, params } = buildCursorWhere('pw_len_asc', payload)
    expect(clause).toContain('password_length > {c_pl:UInt8}')
    expect(params).toHaveProperty('c_pl', 8)
  })

  test('pw_len_desc: password_length < or equal with tiebreaker', () => {
    const payload = { sort: 'pw_len_desc' as SortKey, v: { ...baseRow, password_length: 12 } }
    const { clause } = buildCursorWhere('pw_len_desc', payload)
    expect(clause).toContain('password_length < {c_pl:UInt8}')
  })

  test('all params use c_ prefix to avoid route param collisions', () => {
    for (const sort of ['imported_asc', 'imported_desc', 'email_asc', 'email_desc'] as SortKey[]) {
      const payload = { sort, v: { ...baseRow } }
      const { params } = buildCursorWhere(sort, payload)
      for (const key of Object.keys(params)) {
        expect(key.startsWith('c_')).toBe(true)
      }
    }
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npx vitest run __tests__/cursor-pagination.test.ts
```

Expected: All tests fail with "Cannot find module '@/lib/cursor-pagination'"

- [ ] **Step 3: Create lib/cursor-pagination.ts**

Create `lib/cursor-pagination.ts`:

```typescript
export type SortKey =
  | 'imported_desc' | 'imported_asc'
  | 'domain_asc'    | 'domain_desc'
  | 'email_asc'     | 'email_desc'
  | 'pw_len_desc'   | 'pw_len_asc'

export const SORT_MAP: Record<SortKey, string> = {
  imported_desc: 'imported_at DESC, domain ASC, email ASC, url ASC, password ASC',
  imported_asc:  'imported_at ASC,  domain ASC, email ASC, url ASC, password ASC',
  domain_asc:    "(domain='') ASC, domain ASC, email ASC, imported_at ASC, url ASC, password ASC",
  domain_desc:   "(domain='') ASC, domain DESC, email ASC, imported_at ASC, url ASC, password ASC",
  email_asc:     'email ASC, domain ASC, imported_at ASC, url ASC, password ASC',
  email_desc:    'email DESC, domain ASC, imported_at ASC, url ASC, password ASC',
  pw_len_desc:   'password_length DESC, domain ASC, email ASC, imported_at ASC, url ASC',
  pw_len_asc:    'password_length ASC,  domain ASC, email ASC, imported_at ASC, url ASC',
}

const CURSOR_COLS: Record<SortKey, string[]> = {
  imported_desc: ['imported_at', 'domain', 'email', 'url', 'password'],
  imported_asc:  ['imported_at', 'domain', 'email', 'url', 'password'],
  domain_asc:    ['domain', 'email', 'imported_at', 'url', 'password'],
  domain_desc:   ['domain', 'email', 'imported_at', 'url', 'password'],
  email_asc:     ['email', 'domain', 'imported_at', 'url', 'password'],
  email_desc:    ['email', 'domain', 'imported_at', 'url', 'password'],
  pw_len_desc:   ['password_length', 'domain', 'email', 'imported_at', 'url'],
  pw_len_asc:    ['password_length', 'domain', 'email', 'imported_at', 'url'],
}

type CursorPayload = { sort: SortKey; v: Record<string, unknown> }

export function encodeCursor(sort: SortKey, row: Record<string, unknown>): string {
  const cols = CURSOR_COLS[sort]
  const v: Record<string, unknown> = {}
  for (const col of cols) v[col] = row[col]
  return Buffer.from(JSON.stringify({ sort, v })).toString('base64')
}

export function decodeCursor(token: string): CursorPayload | null {
  if (!token) return null
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as CursorPayload
  } catch {
    return null
  }
}

export function buildCursorWhere(
  sort: SortKey,
  cursor: CursorPayload,
): { clause: string; params: Record<string, unknown> } {
  const { v } = cursor
  switch (sort) {
    case 'imported_asc':
      return {
        clause: `(imported_at, domain, email, url, password) > ({c_ia:DateTime}, {c_d:String}, {c_e:String}, {c_u:String}, {c_pw:String})`,
        params: { c_ia: v.imported_at, c_d: v.domain, c_e: v.email, c_u: v.url, c_pw: v.password },
      }
    case 'imported_desc':
      return {
        clause: `(imported_at < {c_ia:DateTime} OR (imported_at = {c_ia:DateTime} AND (domain, email, url, password) > ({c_d:String}, {c_e:String}, {c_u:String}, {c_pw:String})))`,
        params: { c_ia: v.imported_at, c_d: v.domain, c_e: v.email, c_u: v.url, c_pw: v.password },
      }
    case 'domain_asc': {
      const isEmpty = (v.domain as string) === ''
      const p = { c_d: v.domain, c_e: v.email, c_ia: v.imported_at, c_u: v.url, c_pw: v.password }
      if (isEmpty) {
        return {
          clause: `(domain = '' AND (email, imported_at, url, password) > ({c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String}))`,
          params: p,
        }
      }
      return {
        clause: `((domain != '' AND (domain, email, imported_at, url, password) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})) OR domain = '')`,
        params: p,
      }
    }
    case 'domain_desc': {
      const isEmpty = (v.domain as string) === ''
      const p = { c_d: v.domain, c_e: v.email, c_ia: v.imported_at, c_u: v.url, c_pw: v.password }
      if (isEmpty) {
        return {
          clause: `(domain = '' AND (email, imported_at, url, password) > ({c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String}))`,
          params: p,
        }
      }
      return {
        clause: `((domain != '' AND (domain < {c_d:String} OR (domain = {c_d:String} AND (email, imported_at, url, password) > ({c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})))) OR domain = '')`,
        params: p,
      }
    }
    case 'email_asc':
      return {
        clause: `(email, domain, imported_at, url, password) > ({c_e:String}, {c_d:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})`,
        params: { c_e: v.email, c_d: v.domain, c_ia: v.imported_at, c_u: v.url, c_pw: v.password },
      }
    case 'email_desc':
      return {
        clause: `(email < {c_e:String} OR (email = {c_e:String} AND (domain, imported_at, url, password) > ({c_d:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})))`,
        params: { c_e: v.email, c_d: v.domain, c_ia: v.imported_at, c_u: v.url, c_pw: v.password },
      }
    case 'pw_len_asc':
      return {
        clause: `(password_length > {c_pl:UInt8} OR (password_length = {c_pl:UInt8} AND (domain, email, imported_at, url) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String})))`,
        params: { c_pl: v.password_length, c_d: v.domain, c_e: v.email, c_ia: v.imported_at, c_u: v.url },
      }
    case 'pw_len_desc':
      return {
        clause: `(password_length < {c_pl:UInt8} OR (password_length = {c_pl:UInt8} AND (domain, email, imported_at, url) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String})))`,
        params: { c_pl: v.password_length, c_d: v.domain, c_e: v.email, c_ia: v.imported_at, c_u: v.url },
      }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npx vitest run __tests__/cursor-pagination.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/cursor-pagination.ts __tests__/cursor-pagination.test.ts
git commit -m "feat: add cursor-pagination shared lib with tests"
```

---

### Task 2: app/api/credentials/route.ts

**Files:**
- Modify: `app/api/credentials/route.ts`

- [ ] **Step 1: Replace import block and remove local SORT_MAP**

Find the top of the file. The current import block (lines 1–8) plus the local `SORT_MAP` (lines 19–28) must be updated.

Replace:
```typescript
import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
import { NORM_COLS } from "@/lib/ulp-normalize"
```

With:
```typescript
import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
import { NORM_COLS } from "@/lib/ulp-normalize"
import { SORT_MAP, type SortKey, encodeCursor, decodeCursor, buildCursorWhere } from "@/lib/cursor-pagination"
```

Then delete the local `SORT_MAP` block entirely (lines 19–28 in the current file):
```typescript
const SORT_MAP: Record<string, string> = {
  imported_desc: 'imported_at DESC',
  imported_asc:  'imported_at ASC',
  domain_asc:    `(domain='') ASC, domain ASC, imported_at DESC`,
  domain_desc:   `(domain='') ASC, domain DESC, imported_at DESC`,
  email_asc:     `email ASC, imported_at DESC`,
  email_desc:    `email DESC, imported_at DESC`,
  pw_len_desc:   'password_length DESC, imported_at DESC',
  pw_len_asc:    'password_length ASC, imported_at DESC',
}
```

- [ ] **Step 2: Replace page/offset with cursor token**

Find and replace in the GET handler:
```typescript
  // Cap at page 2000 (max offset = 2000 × 200 = 400 000 rows).
  // Deep OFFSET scans over 100B+ rows are O(offset) even with primary-key
  // pruning.  Almost no legitimate use case goes beyond page ~50.
  const page  = Math.min(2_000, Math.max(1, parseInt(sp.get('page')  || '1')))
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50')))
  const offset = (page - 1) * limit
```

With:
```typescript
  const cursorToken = sp.get('cursor') || ''
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50')))
```

- [ ] **Step 3: Remove offset from params, add cursor decode block**

Find:
```typescript
  const params: Record<string, unknown> = { limit, offset }
```

Replace with:
```typescript
  const params: Record<string, unknown> = { limit }
```

Then find the block that ends with:
```typescript
  const where = conditions.join(' AND ') + tierExtra + loginTypeExtra
```

After that line, add:
```typescript

  let cursorClause = ''
  let cursorParams: Record<string, unknown> = {}

  if (cursorToken) {
    const cursor = decodeCursor(cursorToken)
    if (cursor && cursor.sort === sortKey) {
      const { clause, params: cp } = buildCursorWhere(sortKey as SortKey, cursor)
      cursorClause = ` AND ${clause}`
      cursorParams = cp
    }
  }

  const allParams = { ...params, ...cursorParams }
```

- [ ] **Step 4: Update both queries**

Find the count query (uses `params`). The count query stays unchanged — it must use `params` (not `allParams`) so the total is always the full result set count regardless of cursor position. No change needed there.

Find the data query:
```typescript
        `SELECT ${SELECT}
         FROM ulp.credentials
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT {limit:UInt32} OFFSET {offset:UInt32}
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw'`,
        params
```

Replace with:
```typescript
        `SELECT ${SELECT}
         FROM ulp.credentials
         WHERE ${where}${cursorClause}
         ORDER BY ${orderBy}
         LIMIT {limit:UInt32}
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw'`,
        allParams
```

- [ ] **Step 5: Update the success response**

Find:
```typescript
    return NextResponse.json({
      success:  true,
      results:  rows,
      total,
      page,
      pages:    Math.ceil(total / limit),
      query_ms,
      timed_out,
      sort:     sortKey,
    })
```

Replace with:
```typescript
    const nextCursor = (rows as unknown[]).length === limit
      ? encodeCursor(sortKey as SortKey, (rows as Record<string, unknown>[])[rows.length - 1])
      : null

    return NextResponse.json({
      success:     true,
      results:     rows,
      total,
      next_cursor: nextCursor,
      query_ms,
      timed_out,
      sort:        sortKey,
    })
```

- [ ] **Step 6: Update the timeout error response**

Find:
```typescript
      return NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Query timed out — add a more specific filter (exact domain, email, or breach name) for faster results.',
        results:   [],
        total:     0,
        pages:     0,
      }, { status: 408 })
```

Replace with:
```typescript
      return NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Query timed out — add a more specific filter (exact domain, email, or breach name) for faster results.',
        results:   [],
        total:     0,
      }, { status: 408 })
```

- [ ] **Step 7: Verify no OFFSET remains in file**

```
npx tsc --noEmit
```

And confirm `OFFSET` no longer appears in `app/api/credentials/route.ts`.

- [ ] **Step 8: Commit**

```bash
git add app/api/credentials/route.ts
git commit -m "feat: replace OFFSET pagination with cursor in credentials route"
```

---

### Task 3: app/api/search/route.ts

**Files:**
- Modify: `app/api/search/route.ts`

**Note:** `search/route.ts` already has a `clause` and `params` variable in scope from the ULP search builder. Cursor variables must use distinct names: `cursorClause`, `cursorParams`. Also, `search/route.ts` uses `mergedParams` instead of `params` for query execution.

- [ ] **Step 1: Add cursor-pagination import and remove local SORT_MAP**

Add to the import block:
```typescript
import { SORT_MAP, type SortKey, encodeCursor, decodeCursor, buildCursorWhere } from "@/lib/cursor-pagination"
```

Delete the local `SORT_MAP` block (lines 27–35 in current file):
```typescript
const SORT_MAP: Record<string, string> = {
  'imported_desc': `imported_at DESC, domain ASC, email ASC, url ASC, password ASC`,
  'imported_asc':  `imported_at ASC,  domain ASC, email ASC, url ASC, password ASC`,
  'domain_asc':    `(domain='') ASC, domain ASC,  email ASC, imported_at ASC, url ASC, password ASC`,
  'domain_desc':   `(domain='') ASC, domain DESC, email ASC, imported_at ASC, url ASC, password ASC`,
  'email_asc':     `email ASC, domain ASC, imported_at ASC, url ASC, password ASC`,
  'pw_len_desc':   `password_length DESC, domain ASC, email ASC, imported_at ASC, url ASC`,
  'pw_len_asc':    `password_length ASC,  domain ASC, email ASC, imported_at ASC, url ASC`,
}
```

- [ ] **Step 2: Replace page/offset with cursor token**

Find:
```typescript
  // Cap at page 2000 (max offset = 2000 × 1000 = 2 000 000 rows).
  // Deep OFFSET over 100B+ rows is O(offset) — almost no use case needs page > 50.
  const page        = Math.min(2_000, Math.max(1, parseInt(searchParams.get('page')  || '1')))
  const limit       = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '50')))
  const offset      = (page - 1) * limit
```

Replace with:
```typescript
  const cursorToken = searchParams.get('cursor') || ''
  const limit       = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '50')))
```

- [ ] **Step 3: Remove offset from mergedParams**

Find:
```typescript
  const mergedParams: Record<string, unknown> = { ...baseParams, limit, offset }
```

Replace with:
```typescript
  const mergedParams: Record<string, unknown> = { ...baseParams, limit }
```

- [ ] **Step 4: Add cursor decode block after allExtras is built**

Find:
```typescript
  const allExtras      = extras.join('') + tierExtra + loginTypeExtra
```

After that line, add:
```typescript

  let cursorClause = ''
  let cursorParams: Record<string, unknown> = {}

  if (cursorToken) {
    const cur = decodeCursor(cursorToken)
    if (cur && cur.sort === sortKey) {
      const { clause: cc, params: cp } = buildCursorWhere(sortKey as SortKey, cur)
      cursorClause = ` AND ${cc}`
      cursorParams = cp
    }
  }

  const allParams = { ...mergedParams, ...cursorParams }
```

- [ ] **Step 5: Update the data query**

Find the data query (NOT the count query — count stays as-is using `mergedParams`):
```typescript
        `SELECT ${SELECT}
         FROM ulp.credentials
         WHERE ${clause}${allExtras}
         ORDER BY ${orderBy}
         LIMIT {limit:UInt32} OFFSET {offset:UInt32}
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw'`,
        mergedParams
```

Replace with:
```typescript
        `SELECT ${SELECT}
         FROM ulp.credentials
         WHERE ${clause}${allExtras}${cursorClause}
         ORDER BY ${orderBy}
         LIMIT {limit:UInt32}
         SETTINGS max_execution_time = 300,
                  timeout_overflow_mode = 'throw'`,
        allParams
```

- [ ] **Step 6: Update the success response**

Find:
```typescript
    return NextResponse.json({
      success:           true,
      results:           rows,
      total,
      page,
      pages:             Math.ceil(total / limit),
      query:             q,
      query_ms,
      timed_out,
      sort:              sortKey,
      breach_filter:     breach,
      tier_include:      tierInclude,
      tier_exclude:      tierExclude,
      login_type_filter: loginType,
      regex_mode:        regexMode,
    })
```

Replace with:
```typescript
    const nextCursor = (rows as unknown[]).length === limit
      ? encodeCursor(sortKey as SortKey, (rows as Record<string, unknown>[])[rows.length - 1])
      : null

    return NextResponse.json({
      success:           true,
      results:           rows,
      total,
      next_cursor:       nextCursor,
      query:             q,
      query_ms,
      timed_out,
      sort:              sortKey,
      breach_filter:     breach,
      tier_include:      tierInclude,
      tier_exclude:      tierExclude,
      login_type_filter: loginType,
      regex_mode:        regexMode,
    })
```

- [ ] **Step 7: Fix early-exit no-filter response**

Find the early-exit response that fires when there's no filter:
```typescript
    return NextResponse.json({ success: true, results: [], total: 0, page: 1, pages: 0, query: '' })
```

Replace with:
```typescript
    return NextResponse.json({ success: true, results: [], total: 0, next_cursor: null, query: '' })
```

- [ ] **Step 8: Update the timeout error response**

Find:
```typescript
      return NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Query timed out — use an exact domain, email, or breach name for fast results at this data size.',
        results:   [],
        total:     0,
        pages:     0,
      }, { status: 408 })
```

Replace with:
```typescript
      return NextResponse.json({
        success:   false,
        timed_out: true,
        error:     'Query timed out — use an exact domain, email, or breach name for fast results at this data size.',
        results:   [],
        total:     0,
      }, { status: 408 })
```

- [ ] **Step 9: Type-check and verify no OFFSET remains**

```
npx tsc --noEmit
```

Confirm `OFFSET` does not appear in `app/api/search/route.ts`.

- [ ] **Step 10: Commit**

```bash
git add app/api/search/route.ts
git commit -m "feat: replace OFFSET pagination with cursor in search route"
```

---

### Task 4: app/credentials/page.tsx

**Files:**
- Modify: `app/credentials/page.tsx`

This file is 1342 lines. Changes are localized: the `ApiResult` type, the `page` state block, `buildParams`, `load`, call sites, and the pagination UI block. Make each edit precisely.

- [ ] **Step 1: Update ApiResult type**

Find:
```typescript
interface ApiResult {
```

Locate the `page` and `pages` fields inside that interface and remove them, then add `next_cursor`. The interface currently looks like (exact content may vary — read the file to find the actual shape):
```typescript
  page:        number
  pages:       number
```

Remove both lines and add:
```typescript
  next_cursor: string | null
```

- [ ] **Step 2: Replace page state with cursor stack**

Find the line:
```typescript
  const [page, setPage] = useState(1)
```

Replace with:
```typescript
  const [cursorStack, setCursorStack]     = useState<Array<string | null>>([])
  const [currentCursor, setCurrentCursor] = useState<string | null>(null)
  const resetCursor = () => { setCursorStack([]); setCurrentCursor(null) }
```

- [ ] **Step 3: Update buildParams signature and body**

Find the `buildParams` useCallback. It currently has signature `(p: number, overrides?)` and includes `page: String(p)` in the URLSearchParams construction.

Change the signature from `(p: number,` to `(cursor: string | null,`.

Remove the line that adds `page` to params:
```typescript
  // something like: ps.set('page', String(p))
  // or: page: String(p) in an object
```

Add after limit/sort are set:
```typescript
  if (cursor) ps.set('cursor', cursor)
```

Also remove `page` from the deps array of the useCallback.

- [ ] **Step 4: Update load signature and body**

Find the `load` useCallback. It currently has signature `(p: number, overrides?)` and includes `setPage(p)`.

Change signature from `(p: number,` to `(cursor: string | null,`.

Replace `setPage(p)` with `setCurrentCursor(cursor)`.

- [ ] **Step 5: Update all call sites**

Each occurrence of `load(1, ...)` or `load(page ± 1, ...)` must be updated. Search for `load(` in the file.

| Pattern | Replace with |
|---|---|
| `load(1)` | `resetCursor(); load(null)` |
| `load(1, { sort: s })` | `resetCursor(); load(null, { sort: s })` |
| `load(1, { limit: l })` | `resetCursor(); load(null, { limit: l })` |
| `load(1, { sort: next })` | `resetCursor(); load(null, { sort: next })` |
| `load(1, { q: email })` | `resetCursor(); load(null, { q: email })` |
| `load(1, { domain: dom })` | `resetCursor(); load(null, { domain: dom })` |

Also find `clearAll` — it likely has `setPage(1)` and a `fetch('...?page=1...')`. Remove the `page=1` fragment from the fetch URL and replace `setPage(1)` with `setCurrentCursor(null)`. Add `resetCursor()` call.

- [ ] **Step 6: Update timed-out error message**

Find (approximate — exact wording may differ slightly):
```typescript
"couldn't be loaded on page {page}"
// or similar reference to page number in error text
```

Replace with text that does not reference a page number:
```typescript
"couldn't be loaded — go back to the first page or add a more specific filter."
```

- [ ] **Step 7: Replace pagination UI block**

Find the existing pagination UI. It will contain prev/next buttons and a page counter using `page` and `pages`. It occupies roughly lines 1317–1330 in the current file (verify exact range by reading).

Replace the entire block with:
```tsx
{(cursorStack.length > 0 || data?.next_cursor) && (
  <div className="flex items-center justify-center gap-3 border-t px-4 py-3">
    <Button
      size="sm" variant="outline"
      disabled={cursorStack.length === 0 || loading}
      onClick={() => {
        const prev = cursorStack[cursorStack.length - 1] ?? null
        setCursorStack(s => s.slice(0, -1))
        load(prev)
      }}
    >
      <ChevronLeft className="h-4 w-4" />
    </Button>
    <span className="text-sm text-muted-foreground tabular-nums">
      {data?.total.toLocaleString()} results
    </span>
    <Button
      size="sm" variant="outline"
      disabled={!data?.next_cursor || loading}
      onClick={() => {
        const next = data!.next_cursor!
        setCursorStack(s => [...s, currentCursor])
        load(next)
      }}
    >
      <ChevronRight className="h-4 w-4" />
    </Button>
  </div>
)}
```

- [ ] **Step 8: Type-check**

```
npx tsc --noEmit
```

Fix any remaining type errors (likely leftover `page` references).

- [ ] **Step 9: Commit**

```bash
git add app/credentials/page.tsx
git commit -m "feat: replace page state with cursor stack in credentials UI"
```

---

### Task 5: Verification

**Files:** None created. Verification only.

- [ ] **Step 1: Run full test suite**

```
npx vitest run
```

Expected: All tests pass including the cursor-pagination tests from Task 1.

- [ ] **Step 2: Type-check entire project**

```
npx tsc --noEmit
```

Expected: Zero errors.

- [ ] **Step 3: Confirm OFFSET is gone from both routes**

```
grep -n "OFFSET" app/api/credentials/route.ts app/api/search/route.ts
```

Expected: No matches.

- [ ] **Step 4: Confirm page/pages are gone from route responses**

```
grep -n "page:" app/api/credentials/route.ts app/api/search/route.ts
grep -n "pages:" app/api/credentials/route.ts app/api/search/route.ts
```

Expected: No matches (the old `page` and `pages` fields must be absent from JSON responses).

- [ ] **Step 5: Confirm next_cursor is present in route responses**

```
grep -n "next_cursor" app/api/credentials/route.ts app/api/search/route.ts
```

Expected: At least one match per file (in the success response and optionally in the early-exit / timeout fallback).

- [ ] **Step 6: Manual browser checklist**

Start the dev server and verify manually:

```
npm run dev
```

- [ ] First page loads without `cursor` param in URL
- [ ] Next button disabled when `next_cursor` is null (single-page or last page result)
- [ ] Clicking Next advances to next page; cursor appears in network request
- [ ] Clicking Back returns to previous page (same rows)
- [ ] Changing sort resets to page 1 (cursor stack cleared)
- [ ] Changing limit resets to page 1
- [ ] Applying any filter resets to page 1
- [ ] "Clear All" resets to page 1
- [ ] Total `N results` count is stable across pages for the same filter set
- [ ] Passing `?cursor=garbage` in the URL returns page 1 without an error

- [ ] **Step 7: Final commit (if any straggler changes)**

If there were any minor fixes during verification:
```bash
git add -p
git commit -m "fix: cursor pagination cleanup from verification"
```
