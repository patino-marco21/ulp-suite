# Cursor Pagination Design

**Date:** 2026-06-06
**Status:** Approved

## Goal

Replace OFFSET-based pagination on `/api/credentials` and `/api/search` with keyset/cursor
pagination to eliminate O(offset) scans at deep pages and fully remove the 2000-page
safety cap.

## Problem Statement

Both routes compute `OFFSET = (page - 1) * limit` and pass it to ClickHouse:

```sql
ORDER BY imported_at DESC
LIMIT 50 OFFSET 9950   -- page 200: ClickHouse reads and discards 9,950 rows
```

For a 1.46B-row table this is acceptable at shallow pages, but:
- Page 200 at limit 200 requires ClickHouse to read and sort-discard 40,000 rows before
  returning results.
- The current hard cap (`page <= 2000`) prevents the worst cases but is an arbitrary limit
  that breaks legitimate workflows.
- Cursor pagination eliminates this entirely: the WHERE condition skips directly to the
  cursor row, and ClickHouse uses its primary key / skip indexes to prune granules.

---

## Architecture

Four layers of change, one new shared file:

| Layer | Change |
|---|---|
| `lib/cursor-pagination.ts` (new) | Unified SORT_MAP, cursor encode/decode, `buildCursorWhere` per sort |
| `app/api/credentials/route.ts` | `page`/`offset` → `cursor` param; `next_cursor` in response |
| `app/api/search/route.ts` | Same as credentials |
| `app/credentials/page.tsx` | Replace `page` state with cursor stack; next/prev navigation |

**What does NOT change:** reuse, related, stats, export, similar, lookup, check — none use
OFFSET in a user-facing page-navigation pattern.

---

## API Contract Delta

```
// Before
GET /api/credentials?page=3&limit=50&sort=domain_asc
← { results, total, page: 3, pages: 40, sort, query_ms }

// After
GET /api/credentials?cursor=<token>&limit=50&sort=domain_asc
← { results, total, next_cursor: "<token>" | null, sort, query_ms }
// cursor absent = first page; next_cursor null = last page
```

- `total` is kept — counts the full matching result set regardless of cursor position
- `page` and `pages` are removed from the response
- Back-navigation is managed client-side via a cursor stack (no `prev_cursor` in the response)
- Cursor is an opaque base64(JSON) token — the frontend never parses it

---

## Section 1: `lib/cursor-pagination.ts`

New shared file. Both routes import everything cursor-related from here.

### Exports

```typescript
export type SortKey =
  | 'imported_desc' | 'imported_asc'
  | 'domain_asc'    | 'domain_desc'
  | 'email_asc'     | 'email_desc'
  | 'pw_len_desc'   | 'pw_len_asc'

// Unified ORDER BY expressions with full tiebreaker chains.
// Replaces the per-route SORT_MAPs in both route files.
// credentials/route.ts currently has incomplete tiebreakers on several sorts;
// this unification adds them for cursor stability. The primary sort column is
// unchanged — only tie-breaking among rows with identical leading values is
// affected (not user-visible).
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

// Cursor payload: sort key + last-row values for each sort's tiebreaker chain
type CursorPayload = { sort: SortKey; v: Record<string, unknown> }

// Columns captured per sort (must match tiebreaker chain above)
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

export function encodeCursor(sort: SortKey, row: Record<string, unknown>): string
export function decodeCursor(token: string): CursorPayload | null  // null on malformed
export function buildCursorWhere(sort: SortKey, cursor: CursorPayload): { clause: string; params: Record<string, unknown> }
```

### `buildCursorWhere` logic per sort

Each case returns a parenthesised clause with `c_`-prefixed params (no collision with route params).

| Sort | WHERE condition |
|---|---|
| `imported_asc` | `(imported_at, domain, email, url, password) > (c_ia, c_d, c_e, c_u, c_pw)` |
| `imported_desc` | `imported_at < c_ia OR (imported_at = c_ia AND (domain,email,url,password) > (...))` |
| `domain_asc` — cursor on non-empty domain | `(domain != '' AND (domain,email,imported_at,url,password) > (...)) OR domain = ''` |
| `domain_asc` — cursor on empty domain | `domain = '' AND (email,imported_at,url,password) > (...)` |
| `domain_desc` — cursor on non-empty domain | `(domain != '' AND (domain < c_d OR (domain = c_d AND (email,imported_at,url,password) > (...)))) OR domain = ''` |
| `domain_desc` — cursor on empty domain | `domain = '' AND (email,imported_at,url,password) > (...)` |
| `email_asc` | `(email, domain, imported_at, url, password) > (...)` |
| `email_desc` | `email < c_e OR (email = c_e AND (domain,imported_at,url,password) > (...))` |
| `pw_len_asc` | `password_length > c_pl OR (password_length = c_pl AND (domain,email,imported_at,url) > (...))` |
| `pw_len_desc` | `password_length < c_pl OR (password_length = c_pl AND (domain,email,imported_at,url) > (...))` |

**`domain_asc`/`domain_desc` empty-domain branch note:** `(domain='') ASC` in the ORDER BY
puts non-empty domains first (evaluates to 0) and empty domains last (evaluates to 1).
When the cursor row is on a non-empty domain, all empty-domain rows sort after it, so the
cursor condition must include `OR domain = ''` to not miss them. When the cursor row is
itself an empty-domain row, only other empty-domain rows with higher tiebreakers follow.

### `next_cursor` generation in routes

```typescript
const nextCursor = (rows as unknown[]).length === limit
  ? encodeCursor(sortKey as SortKey, (rows as Record<string, unknown>[])[rows.length - 1])
  : null
```

If `rows.length < limit`, this is the last page — `next_cursor: null`.
If the next request returns 0 rows, the UI treats that as end-of-results.

---

## Section 2: Route Changes

### Changes common to both `app/api/credentials/route.ts` and `app/api/search/route.ts`

**Remove:**
- `const page = Math.min(2_000, Math.max(1, parseInt(...)))`
- `const offset = (page - 1) * limit`
- `const SORT_MAP = {...}` (replaced by import from `lib/cursor-pagination`)
- `{ page, pages }` from response

**Add:**
- `import { SORT_MAP, SortKey, encodeCursor, decodeCursor, buildCursorWhere } from '@/lib/cursor-pagination'`
- `const cursorToken = sp.get('cursor') || ''`
- Cursor decode + WHERE injection block (see below)
- `next_cursor: nextCursor` in response

**Cursor decode + WHERE injection** (inserted after existing WHERE conditions are built):

```typescript
let cursorClause = ''
let cursorParams: Record<string, unknown> = {}

if (cursorToken) {
  const cursor = decodeCursor(cursorToken)
  // If cursor.sort !== sortKey, user changed sort mid-navigation — treat as first page
  if (cursor && cursor.sort === sortKey) {
    const { clause, params: cp } = buildCursorWhere(sortKey as SortKey, cursor)
    cursorClause = ` AND ${clause}`
    cursorParams = cp
  }
}

const allParams = { ...params, ...cursorParams }
```

**Count query:** unchanged — no cursor condition. `total` = full result set size regardless of
cursor position. This is intentional: "N total results" remains accurate even when browsing
to page 50.

**Data query:** cursor WHERE appended, `OFFSET` removed:

```sql
SELECT ... FROM ulp.credentials
WHERE ${where}${cursorClause}
ORDER BY ${orderBy}
LIMIT {limit:UInt32}
SETTINGS ...
```

**Invalid cursor handling:**
- `decodeCursor` returns `null` on malformed base64 or JSON → no cursor WHERE injected,
  first page is returned silently (graceful degradation)
- `cursor.sort !== sortKey` → same treatment; user changed sort, start from page 1

**Per-route differences:**

| | credentials | search |
|---|---|---|
| `limit` cap | 200 | 1000 |
| Extra response fields kept | `sort`, `timed_out` | `query`, `breach_filter`, `tier_*`, `login_type_filter`, `regex_mode`, `timed_out` |
| `email_desc` sort | Yes (in SORT_MAP) | No (not offered in search UI) |

---

## Section 3: Frontend — `app/credentials/page.tsx`

### `ApiResult` type

```typescript
interface ApiResult {
  success:     boolean
  results:     Credential[]
  total:       number
  next_cursor: string | null   // new
  query_ms?:   number
  timed_out?:  boolean
  sort?:       string
  // page, pages: removed
}
```

### New state

```typescript
// Replace: const [page, setPage] = useState(1)
const [cursorStack, setCursorStack]     = useState<Array<string | null>>([])
const [currentCursor, setCurrentCursor] = useState<string | null>(null)
// next_cursor is read from data.next_cursor — no separate state variable

const resetCursor = () => { setCursorStack([]); setCurrentCursor(null) }
```

`cursorStack` semantics: each entry is the cursor that was passed to `load()` for that
historical page, in order. `cursorStack[cursorStack.length - 1]` is the cursor for
the page immediately before the current one.

### `buildParams` and `load` signature changes

```typescript
// Before: buildParams(p: number, overrides?)
// After:
const buildParams = useCallback((cursor: string | null, overrides?: {...}) => {
  const ps = new URLSearchParams({ limit: ..., sort: ... })
  if (cursor) ps.set('cursor', cursor)
  // ... all other params unchanged
  return ps
}, [...deps, no page])

// Before: load(p: number, overrides?)
// After:
const load = useCallback(async (cursor: string | null, overrides?: {...}) => {
  const res = await fetch(`/api/credentials?${buildParams(cursor, overrides)}`)
  if (json.success) {
    setData(json)
    setCurrentCursor(cursor)  // replaces setPage(p)
  }
  // ... error handling unchanged
}, [buildParams, toast])
```

### Call site updates

Every existing `load(1, ...)` or `load(page ± 1)` call is updated:

| Call site | Before | After |
|---|---|---|
| `applyFilters` | `load(1)` | `resetCursor(); load(null)` |
| `clearAll` | `setPage(1); fetch('...?page=1...')` | `resetCursor(); fetch('...') // no page param` |
| Sort select `onChange` | `load(1, { sort: s })` | `resetCursor(); load(null, { sort: s })` |
| Limit select `onChange` | `load(1, { limit: l })` | `resetCursor(); load(null, { limit: l })` |
| `cycleSortKey` | `load(1, { sort: next })` | `resetCursor(); load(null, { sort: next })` |
| `handleSearchEmail` | `load(1, { q: email })` | `resetCursor(); load(null, { q: email })` |
| `handleSearchDomain` | `load(1, { domain: dom })` | `resetCursor(); load(null, { domain: dom })` |

### Pagination UI

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

**Hides entirely** when on the first page with no next results (empty dataset or single page).

### Timed-out error message update

```tsx
// Before:
"couldn't be loaded on page {page}. Try page 1, reduce the page size..."
// After:
"couldn't be loaded — go back to the first page or add a more specific filter."
```

---

## Testing

### Manual verification for cursor pagination

```sql
-- After enabling cursor pagination, check that OFFSET no longer appears in query_log
SELECT query, read_rows, query_duration_ms
FROM system.query_log
WHERE query LIKE '%credentials%'
  AND query NOT LIKE '%OFFSET%'
  AND type = 'QueryFinish'
ORDER BY event_time DESC
LIMIT 10
```

Confirm `read_rows` for page 10 (with a cursor) is approximately equal to `read_rows` for
page 1 — not 10× larger as it was with OFFSET.

### Functional checklist (manual browser test)

- [ ] First page loads without cursor param
- [ ] Next button is disabled when `next_cursor` is null (last page / single page)
- [ ] Clicking Next advances to next page; prev cursor appears on stack
- [ ] Clicking Back returns to correct previous page (same rows)
- [ ] Changing sort resets to page 1 (cursor stack cleared)
- [ ] Changing limit resets to page 1
- [ ] Applying filters resets to page 1
- [ ] Clear All resets to page 1
- [ ] "Search this email" / "Search this domain" from detail sheet resets to page 1
- [ ] Total count `N results` is unchanged between pages for the same filter set
- [ ] Passing a garbage `cursor` param returns page 1 without error
- [ ] Passing a cursor with mismatched sort returns page 1 without error

---

## What This Does NOT Change

- No schema changes to any ClickHouse table
- No changes to export, related, similar, lookup, reuse, stats, or check routes
- No changes to `lib/ulp-search.ts`, `lib/ulp-normalize.ts`, or any other lib
- The response shape of both routes changes only in removing `page`/`pages` and adding
  `next_cursor` — all other fields (`total`, `results`, `sort`, `timed_out`, etc.) are unchanged
- `/api/search` has no current frontend consumer — its frontend migration is deferred
- The 2000-page safety cap is removed from both routes as it is no longer needed
