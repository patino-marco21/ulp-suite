# Sources Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Type part of a file name on the Sources page and see whether that file was ingested, processed earlier, held or failed, with its size and date.

**Architecture:** `GET /api/sources?q=` runs a case-insensitive "contains" over `ulp.sources` (ClickHouse) and reads the job log (`processing_jobs`, SQLite); a pure module (`lib/sources-search.ts`) merges them with a fixed priority and the route pages the result. The page adds a debounced search box and a status badge. No DDL, no setting.

**Tech Stack:** Next.js route handler, `@/lib/clickhouse` `executeQuery`, `@/lib/sqlite` `dbQuery`, vitest, shadcn `Input`/`Badge`.

## Global Constraints

- The repository is public: no real file names, search terms or credential values in code, tests, comments or commit messages (use placeholders like `term A`, `file-a.txt`).
- A change to a query ends with a run on a real ClickHouse (a mocked query once passed with two real bugs): the exact statement on the live container and the built image on the isolated rehearsal stack.
- The production build strips `console.log`; use `console.warn` / `console.error` for anything that must reach `docker logs`.
- Alias rule from `app/api/sources/route.ts`: an alias must not equal the column used as the second argument of `argMax` (`imported_at`); use `last_imported`.
- Query rules: trimmed, 2 to 200 characters, `%` and `_` plain, case-insensitive contains; 50 results a page.
- CI gate: `npm run typecheck` (app, `scripts/`, `__tests__/`), `npm test`, `npm run lint`, `npm run build`.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

---

### Task 1: The pure module

**Files:**
- Create: `lib/sources-search.ts`
- Test: `__tests__/sources-search.test.ts`

**Interfaces:**
- Produces:
  - `type SourceStatus = 'ingested' | 'processed' | 'held' | 'failed'`
  - `interface SourceHit { filename: string; status: SourceStatus; size: number; line_count: number; imported_at: string; cred_count: number }`
  - `interface SourceRowInput { filename: string; line_count: number | string; size_bytes: number | string; last_imported: string }`
  - `interface JobRowInput { id: number | string; filename: string; status: string; imported: number | string; created_at: string }`
  - `normalizeQuery(raw: string | null | undefined): string | null`
  - `matchesName(filename: string, query: string): boolean`
  - `mergeHits(sources: SourceRowInput[], jobs: JobRowInput[], query: string): SourceHit[]`
  - `utcDate(stamp: string): Date`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { matchesName, mergeHits, normalizeQuery, utcDate, type JobRowInput, type SourceRowInput } from '@/lib/sources-search'

const src = (filename: string, over: Partial<SourceRowInput> = {}): SourceRowInput =>
  ({ filename, line_count: 10, size_bytes: 1000, last_imported: '2026-11-08 10:00:00', ...over })
const job = (id: number, filename: string, status: string, over: Partial<JobRowInput> = {}): JobRowInput =>
  ({ id, filename, status, imported: 0, created_at: '2026-11-01 00:00:00', ...over })

describe('normalizeQuery', () => {
  it('trims, and returns null under 2 characters or for nothing', () => {
    expect(normalizeQuery('  term A  ')).toBe('term A')
    expect(normalizeQuery('a')).toBeNull()
    expect(normalizeQuery(' a ')).toBeNull()
    expect(normalizeQuery('')).toBeNull()
    expect(normalizeQuery(null)).toBeNull()
    expect(normalizeQuery(undefined)).toBeNull()
  })
  it('cuts a query at 200 characters', () => {
    expect(normalizeQuery('x'.repeat(500))).toHaveLength(200)
  })
})

describe('matchesName', () => {
  it('is a case-insensitive contains', () => {
    expect(matchesName('File-A (2).TXT', 'file-a')).toBe(true)
    expect(matchesName('file-a.txt', '(2)')).toBe(false)
  })
  it('treats % and _ as plain characters', () => {
    expect(matchesName('file-a.txt', '%')).toBe(false)
    expect(matchesName('file_a.txt', '_a')).toBe(true)
    expect(matchesName('fileXa.txt', '_a')).toBe(false)
  })
  it('folds non-ASCII case', () => {
    expect(matchesName('Über-file.txt', 'über')).toBe(true)
  })
})

describe('mergeHits', () => {
  it('lists a ulp.sources row as ingested, with size and lines', () => {
    const [hit] = mergeHits([src('file-a.txt', { size_bytes: '4179297131', line_count: '77' })], [], 'file-a')
    expect(hit).toEqual({ filename: 'file-a.txt', status: 'ingested', size: 4179297131, line_count: 77, imported_at: '2026-11-08 10:00:00', cred_count: 0 })
  })

  it('an unfinished job-log name is Held or Failed (the latest unfinished job decides)', () => {
    const hits = mergeHits([], [job(1, 'file-b.txt', 'failed'), job(2, 'file-b.txt', 'held', { created_at: '2026-11-02 00:00:00' }), job(3, 'file-c.txt', 'failed')], 'file-')
    expect(hits.map(h => [h.filename, h.status])).toEqual([['file-b.txt', 'held'], ['file-c.txt', 'failed']])
    expect(hits[0].imported_at).toBe('2026-11-02 00:00:00')
  })

  it('a finished job beats an earlier failure and gives Processed earlier, summing what it added', () => {
    const [hit] = mergeHits([], [
      job(1, 'file-d.txt', 'failed', { created_at: '2026-06-01 00:00:00' }),
      job(2, 'file-d.txt', 'done', { imported: 100, created_at: '2026-06-02 00:00:00' }),
      job(3, 'file-d.txt', 'done', { imported: '50', created_at: '2026-06-03 00:00:00' }),
    ], 'file-d')
    expect(hit).toMatchObject({ filename: 'file-d.txt', status: 'processed', size: 0, line_count: 150, imported_at: '2026-06-03 00:00:00' })
  })

  it('a ulp.sources row beats the job log for the same name', () => {
    const hits = mergeHits([src('file-e.txt')], [job(1, 'file-e.txt', 'failed')], 'file-e')
    expect(hits).toHaveLength(1)
    expect(hits[0].status).toBe('ingested')
  })

  it('a job named like an archive reference stands for the file it points at', () => {
    const hits = mergeHits([src('file-f.txt')], [job(1, 'file-f.txt.archiveref', 'done', { imported: 5 }), job(2, 'file-g.txt.archiveref', 'done', { imported: 5 })], 'file-')
    expect(hits.map(h => [h.filename, h.status]).sort()).toEqual([['file-f.txt', 'ingested'], ['file-g.txt', 'processed']])
  })

  it('keeps only the job names that match, ignores other job statuses, and sorts newest first', () => {
    const hits = mergeHits(
      [src('file-h.txt', { last_imported: '2026-11-01 00:00:00' }), src('file-i.txt', { last_imported: '2026-11-05 00:00:00' })],
      [job(1, 'other.txt', 'failed'), job(2, 'file-j.txt', 'queued'), job(3, 'file-k.txt', 'held', { created_at: '2026-11-03 00:00:00' })],
      'file-',
    )
    expect(hits.map(h => h.filename)).toEqual(['file-i.txt', 'file-k.txt', 'file-h.txt'])
  })

  it('treats a missing size as 0', () => {
    const [hit] = mergeHits([src('file-l.txt', { size_bytes: '' })], [], 'file-l')
    expect(hit.size).toBe(0)
  })
})

describe('utcDate', () => {
  it('reads a ClickHouse / SQLite timestamp as UTC', () => {
    expect(utcDate('2026-11-09 02:11:01').toISOString()).toBe('2026-11-09T02:11:01.000Z')
  })
  it('leaves an ISO string with a zone alone', () => {
    expect(utcDate('2026-11-09T02:11:01Z').toISOString()).toBe('2026-11-09T02:11:01.000Z')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run __tests__/sources-search.test.ts`
Expected: FAIL, `Failed to resolve import "@/lib/sources-search"`.

- [ ] **Step 3: Write the module**

```ts
/**
 * Search of the Sources page (docs/superpowers/specs/2026-11-08-sources-search-design.md): "has a file with this name been ingested or processed?". The answer
 * comes from two places, because ulp.sources is not the whole story: the job log also knows files processed before the ledger existed, files the quality gate held
 * and files whose import failed. This module is pure; app/api/sources/route.ts reads the two sources and hands the rows here.
 */

export type SourceStatus = 'ingested' | 'processed' | 'held' | 'failed'

export interface SourceHit {
  filename: string
  status: SourceStatus
  /** Bytes, 0 when not recorded (older ledger rows, job-log-only names). */
  size: number
  line_count: number
  /** "YYYY-MM-DD HH:MM:SS", UTC (ClickHouse and SQLite both write it that way); utcDate() reads it. */
  imported_at: string
  /** Never filled while searching (the per-name credential count scans ulp.credentials); present so a hit fits the list's row type. */
  cred_count: number
}

export interface SourceRowInput { filename: string; line_count: number | string; size_bytes: number | string; last_imported: string }
export interface JobRowInput { id: number | string; filename: string; status: string; imported: number | string; created_at: string }

export const MIN_QUERY_LENGTH = 2
export const MAX_QUERY_LENGTH = 200

/** The query to search for, or null when the list should be shown (nothing typed, or under 2 characters). */
export function normalizeQuery(raw: string | null | undefined): string | null {
  const q = (raw ?? '').trim().slice(0, MAX_QUERY_LENGTH).trim()
  return q.length >= MIN_QUERY_LENGTH ? q : null
}

/** Case-insensitive "contains"; every character, % and _ included, stands for itself. */
export function matchesName(filename: string, query: string): boolean {
  return filename.toLowerCase().includes(query.toLowerCase())
}

const ARCHIVE_REF = '.archiveref'

/**
 * Merges the rows for `query`. Per name: a ulp.sources row (Ingested) beats a finished job (Processed earlier) beats the latest unfinished job (Held or Failed). A job named
 * like an archive reference stands for the file it points at (lib/ledger-export.ts does the same). Newest first.
 */
export function mergeHits(sources: SourceRowInput[], jobs: JobRowInput[], query: string): SourceHit[] {
  const hits = new Map<string, SourceHit>()
  for (const s of sources) {
    hits.set(s.filename, {
      filename: s.filename, status: 'ingested', size: Number(s.size_bytes) || 0, line_count: Number(s.line_count) || 0, imported_at: String(s.last_imported), cred_count: 0,
    })
  }

  const byName = new Map<string, JobRowInput[]>()
  for (const j of jobs) {
    const name = j.filename.endsWith(ARCHIVE_REF) ? j.filename.slice(0, -ARCHIVE_REF.length) : j.filename
    if (hits.has(name) || !matchesName(name, query)) continue
    const rows = byName.get(name) ?? []
    rows.push(j)
    byName.set(name, rows)
  }
  for (const [name, rows] of byName) {
    const done = rows.filter(r => r.status === 'done')
    if (done.length > 0) {
      hits.set(name, {
        filename: name, status: 'processed', size: 0, line_count: done.reduce((n, r) => n + (Number(r.imported) || 0), 0),
        imported_at: done.map(r => r.created_at).sort().at(-1)!, cred_count: 0,
      })
      continue
    }
    const open = rows.filter(r => r.status === 'held' || r.status === 'failed')
    if (open.length === 0) continue
    const last = open.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a))
    hits.set(name, { filename: name, status: last.status as 'held' | 'failed', size: 0, line_count: 0, imported_at: last.created_at, cred_count: 0 })
  }

  return [...hits.values()].sort((a, b) => (a.imported_at === b.imported_at ? a.filename.localeCompare(b.filename) : a.imported_at < b.imported_at ? 1 : -1))
}

/** ClickHouse and SQLite write "YYYY-MM-DD HH:MM:SS" in UTC; `new Date()` would read that as local time. A string that already names its zone is left alone. */
export function utcDate(stamp: string): Date {
  return /[zZ]$|[+-]\d\d:?\d\d$/.test(stamp) ? new Date(stamp) : new Date(`${stamp.replace(' ', 'T')}Z`)
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run __tests__/sources-search.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sources-search.ts __tests__/sources-search.test.ts
git commit -m "feat(sources): pure search merge — ingested, processed earlier, held, failed"
```

---

### Task 2: The route

**Files:**
- Modify: `app/api/sources/route.ts` (GET only; DELETE untouched)
- Test: `__tests__/sources-search-route.test.ts`

**Interfaces:**
- Consumes: `normalizeQuery`, `mergeHits`, `SourceRowInput`, `JobRowInput` from Task 1; `executeQuery(sql, params)` from `@/lib/clickhouse`; `dbQuery(sql, params): unknown[]` from `@/lib/sqlite`.
- Produces: `GET /api/sources?q=…&page=…&limit=…` → `{ success, sources: SourceHit[], total, page, pages, query }`; without a usable `q` the response is the list as before.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }), isAdmin: () => true }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
let sourceRows: Array<Record<string, unknown>> = []
let jobRows: Array<Record<string, unknown>> = []
let jobsThrow = false

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/count\(\) AS total/.test(sql)) return [{ total: '2' }]
    if (/positionCaseInsensitiveUTF8/.test(sql)) return sourceRows
    if (/FROM ulp\.credentials/.test(sql)) return []
    return [{ filename: 'list-a.txt', line_count: '5', last_imported: '2026-11-08 10:00:00' }]
  }),
}))
vi.mock('@/lib/sqlite', () => ({
  dbQuery: vi.fn(() => {
    if (jobsThrow) throw new Error('database is locked')
    return jobRows
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/sources/route'

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/sources${qs}`))

beforeEach(() => {
  calls.length = 0
  jobsThrow = false
  sourceRows = [{ filename: 'term-a one.txt', line_count: '9', size_bytes: '123', last_imported: '2026-11-08 10:00:00' }]
  jobRows = [
    { id: 1, filename: 'term-a two.txt', status: 'held', imported: 0, created_at: '2026-11-02 00:00:00' },
    { id: 2, filename: 'unrelated.txt', status: 'failed', imported: 0, created_at: '2026-11-01 00:00:00' },
  ]
})

describe('GET /api/sources?q=', () => {
  test('searches ulp.sources case-insensitively with the query as a parameter and merges the job log', async () => {
    const res = await get('?q=%20Term-A%20')
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.query).toBe('Term-A')
    expect(json.sources.map((s: { filename: string; status: string }) => [s.filename, s.status])).toEqual([['term-a one.txt', 'ingested'], ['term-a two.txt', 'held']])
    expect(json.total).toBe(2)
    const search = calls.find(c => /positionCaseInsensitiveUTF8/.test(c.sql))!
    expect(search.params.q).toBe('Term-A')
    expect(search.sql).toMatch(/positionCaseInsensitiveUTF8\(filename, \{q:String\}\) > 0/)
    expect(search.sql).toContain('max(imported_at)                AS last_imported')
  })

  test('does not scan ulp.credentials while searching', async () => {
    await get('?q=term')
    expect(calls.some(c => /FROM ulp\.credentials/.test(c.sql))).toBe(false)
  })

  test('pages the merged result', async () => {
    sourceRows = Array.from({ length: 5 }, (_, i) => ({ filename: `term-a ${i}.txt`, line_count: 1, size_bytes: 1, last_imported: `2026-11-0${i + 1} 00:00:00` }))
    jobRows = []
    const json = await (await get('?q=term-a&limit=2&page=3')).json()
    expect(json).toMatchObject({ total: 5, page: 3, pages: 3 })
    expect(json.sources.map((s: { filename: string }) => s.filename)).toEqual(['term-a 0.txt'])
  })

  test('nothing matching is a success with an empty list', async () => {
    sourceRows = []
    jobRows = []
    const json = await (await get('?q=zzz')).json()
    expect(json).toMatchObject({ success: true, sources: [], total: 0, pages: 0, query: 'zzz' })
  })

  test('a query under 2 characters is the plain list (with credential counts)', async () => {
    const json = await (await get('?q=a')).json()
    expect(json.query).toBeUndefined()
    expect(calls.some(c => /positionCaseInsensitiveUTF8/.test(c.sql))).toBe(false)
    expect(calls.some(c => /count\(\) AS total/.test(c.sql))).toBe(true)
  })

  test('an unreadable job log is an error, not a quiet "not found"', async () => {
    jobsThrow = true
    const res = await get('?q=term')
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run __tests__/sources-search-route.test.ts`
Expected: FAIL (the first test: `json.query` undefined / sources not merged).

- [ ] **Step 3: Edit the route**

In `app/api/sources/route.ts` add the imports below the existing ones:

```ts
import { dbQuery } from "@/lib/sqlite"
import { mergeHits, normalizeQuery, type JobRowInput, type SourceRowInput } from "@/lib/sources-search"
```

Add above `export async function GET`:

```ts
/** Names a search can return from ulp.sources. The table holds about a thousand; the cap only guards a table that grows far beyond that. */
const SEARCH_SOURCE_CAP = 5000

/**
 * ?q=: "has a file with this name been ingested or processed?" (docs/superpowers/specs/2026-11-08-sources-search-design.md). ulp.sources answers for what the ledger
 * holds; the job log adds files from before the ledger, held files and failed files. Both are about a thousand names, so the merge and the paging happen here.
 * The per-name credential count is skipped: it scans ulp.credentials (7 s for 50 names) and the question is whether the file was ingested.
 */
async function searchSources(q: string, page: number, limit: number) {
  const offset = (page - 1) * limit
  const [sourceRows, jobRows] = await Promise.all([
    // Aliases follow the list query below: 'last_imported' because an alias equal to imported_at turns argMax(x, imported_at) into a nested aggregate.
    executeQuery(
      `SELECT filename,
              argMax(line_count, imported_at) AS line_count,
              argMax(size, imported_at)       AS size_bytes,
              max(imported_at)                AS last_imported
       FROM ulp.sources
       WHERE positionCaseInsensitiveUTF8(filename, {q:String}) > 0
       GROUP BY filename
       ORDER BY last_imported DESC
       LIMIT {cap:UInt32}`,
      { q, cap: SEARCH_SOURCE_CAP }
    ),
    Promise.resolve(dbQuery('SELECT id, filename, status, imported, created_at FROM processing_jobs')),
  ])
  const hits = mergeHits(sourceRows as SourceRowInput[], jobRows as JobRowInput[], q)
  return {
    success: true,
    sources: hits.slice(offset, offset + limit),
    total: hits.length,
    page,
    pages: Math.ceil(hits.length / limit),
    query: q,
  }
}
```

In `GET`, directly after `const offset = (page - 1) * limit` and before `try {` insert:

```ts
  const q = normalizeQuery(searchParams.get('q'))
  if (q) {
    try {
      return NextResponse.json(await searchSources(q, page, limit))
    } catch (error) {
      console.error('Sources search error:', error)
      return NextResponse.json({ success: false, error: 'Failed to search sources' }, { status: 500 })
    }
  }
```

- [ ] **Step 4: Run it and see it pass; run the neighbours**

Run: `npx vitest run __tests__/sources-search-route.test.ts __tests__/sources-search.test.ts __tests__/sources-identity.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/sources/route.ts __tests__/sources-search-route.test.ts
git commit -m "feat(sources): GET /api/sources?q= searches ulp.sources and the job log"
```

---

### Task 3: The page and the README

**Files:**
- Modify: `app/sources/page.tsx`
- Modify: `README.md` (Search & Discovery list)

**Interfaces:**
- Consumes: `normalizeQuery`, `utcDate`, `SourceStatus` from Task 1; `GET /api/sources?q=` from Task 2; `formatBytes` from `@/lib/utils`; `Input` from `@/components/ui/input`.

- [ ] **Step 1: Edit the imports and types**

Replace the `lucide-react` import line block and add imports:

```tsx
import {
  ChevronLeft, ChevronRight, Loader2, FileText, Upload, Trash2, AlertTriangle, Search, X,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { formatBytes } from "@/lib/utils"
import { normalizeQuery, utcDate, type SourceStatus } from "@/lib/sources-search"
```

Replace the `Source` and `ApiResult` interfaces:

```tsx
interface Source {
  filename: string
  line_count: number
  imported_at: string
  cred_count: number
  /** Only in a search answer. */
  status?: SourceStatus
  size?: number
}

interface ApiResult {
  success: boolean
  sources: Source[]
  total: number
  page: number
  pages: number
  query?: string
}

const STATUS_BADGE: Record<SourceStatus, { label: string; variant: "outline" | "destructive"; className: string; hint: string }> = {
  ingested:  { label: "Ingested", variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", hint: "This file is in the source list" },
  processed: { label: "Processed earlier", variant: "outline", className: "", hint: "Imported before the file ledger existed: the name is known, the size is not" },
  held:      { label: "Held", variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", hint: "The quality gate stopped this file; it was not ingested" },
  failed:    { label: "Failed", variant: "destructive", className: "", hint: "The import failed and no later run finished it" },
}
```

- [ ] **Step 2: Replace the loading logic**

Replace the `data`/`loading`/`page`/`load`/`useEffect` block (the lines from `const [data, setData]` through `useEffect(() => { load(1) }, [load])`) with:

```tsx
  const [data, setData]         = useState<ApiResult | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [page, setPage]         = useState(1)
  const [query, setQuery]       = useState("")
  const [toDelete, setToDelete] = useState<Source | null>(null)
  const [deleting, setDeleting] = useState(false)

  // The query the list is showing: under 2 characters is the plain list.
  const activeQuery = normalizeQuery(query) ?? ""

  const load = useCallback(async (p: number, q: string, signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(p), limit: "50" })
      if (q) params.set("q", q)
      const res  = await fetch(`/api/sources?${params}`, { signal })
      const json = await res.json()
      if (json.success) {
        setData(json)
        setPage(p)
      } else {
        setError(q ? "The search failed. Try again." : "The list could not be loaded.")
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(q ? "The search failed. Try again." : "The list could not be loaded.")
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  // Typing waits 300 ms; clearing the box shows the list at once. A newer request cancels the older one, so a slow answer never overwrites a newer one.
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => { load(1, activeQuery, controller.signal) }, activeQuery ? 300 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [activeQuery, load])
```

- [ ] **Step 3: Pass the query on delete-refresh and paging**

In `handleDelete`, change `load(page)` to `load(page, activeQuery)`. In the pagination buttons change `load(page - 1)` to `load(page - 1, activeQuery)` and `load(page + 1)` to `load(page + 1, activeQuery)`.

- [ ] **Step 4: Header, search box, count line**

Replace the header block's `<p>` count line and add the search box under the header row. The `<div className="border-b px-6 py-4">` block becomes:

```tsx
      <div className="border-b px-6 py-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Sources</h1>
            <p className="text-sm text-muted-foreground">
              {data?.query
                ? `${data.total.toLocaleString()} match${data.total !== 1 ? 'es' : ''} for “${data.query}”`
                : `${data?.total.toLocaleString() ?? 0} file${data?.total !== 1 ? 's' : ''} imported`}
            </p>
          </div>
          <Button asChild size="sm">
            <Link href="/upload">
              <Upload className="mr-2 h-4 w-4" />Upload
            </Link>
          </Button>
        </div>
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Check a file name before you download it"
            aria-label="Search sources by file name"
            className="pl-9 pr-9"
            maxLength={200}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setQuery("")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {loading && data && <Loader2 className="absolute right-9 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
        </div>
        {query.trim().length === 1 && (
          <p className="text-xs text-muted-foreground">Type at least 2 characters to search.</p>
        )}
      </div>
```

- [ ] **Step 5: Error line, empty state, cards**

Directly inside the list container (`<div className="flex-1 overflow-auto p-4">`) add before the ternary:

```tsx
        {error && (
          <p role="alert" className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}
```

Replace the empty-state branch condition `!data || data.sources.length === 0 ? (...)` so a search with no match shows its own message. The empty-state `<div>` becomes:

```tsx
          data?.query ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Search className="h-10 w-10 opacity-30" />
              <p className="text-foreground">No file with “{data.query}” in its name has been ingested or processed.</p>
              <p className="max-w-md text-sm">A different name does not make a file new: the importer also compares what is inside and adds only credentials it has not seen.</p>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
              <FileText className="h-12 w-12 opacity-30" />
              <p>No sources yet. Upload a ULP file to get started.</p>
              <Button asChild variant="outline">
                <Link href="/upload">Upload credentials</Link>
              </Button>
            </div>
          )
```

In each card, replace the date line and add the badge and size:

```tsx
                      <p className="text-xs text-muted-foreground">
                        {utcDate(source.imported_at).toLocaleString()}
                        {source.status === 'ingested' || source.status === 'processed'
                          ? source.size
                            ? <> · <span title={`${source.size.toLocaleString()} bytes`}>{formatBytes(source.size)}</span> ({source.size.toLocaleString()} bytes)</>
                            : ' · size not recorded'
                          : null}
                      </p>
```

and, at the top of the right-hand `<div className="flex flex-col items-end gap-1">`:

```tsx
                      {source.status && (
                        <Badge variant={STATUS_BADGE[source.status].variant} className={STATUS_BADGE[source.status].className} title={STATUS_BADGE[source.status].hint}>
                          {STATUS_BADGE[source.status].label}
                        </Badge>
                      )}
```

In the delete dialog change `new Date(toDelete.imported_at).toLocaleString()` to `utcDate(toDelete.imported_at).toLocaleString()`.

The delete button must only show for rows that have a `ulp.sources` row (a job-log-only name has nothing to delete): change `{userIsAdmin && (` to `{userIsAdmin && (!source.status || source.status === 'ingested') && (`.

- [ ] **Step 6: README**

In `README.md`, under `### Search & Discovery`, after the **Breach explorer** line add:

```md
- **Sources search** — the *Sources* tab has a search box: type part of a file name to see whether it was already ingested before you download it. A match shows *Ingested*, *Processed earlier* (the job log finished it before the file ledger existed), *Held* (the quality gate stopped it) or *Failed*, with the size (to compare with the size the chat client shows) and the date. It reads `ulp.sources` and the job log (a few milliseconds); the per-file credential count of the plain list is left out while searching
```

- [ ] **Step 7: Type-check, run the tests, commit**

Run: `npm run typecheck`
Expected: exit 0 (app, tests and scripts).

Run: `npx vitest run __tests__/sources-search.test.ts __tests__/sources-search-route.test.ts`
Expected: PASS.

```bash
git add app/sources/page.tsx README.md
git commit -m "feat(sources): search box, status badge, size and UTC dates on the Sources page"
```

---

### Task 4: Gates and the real ClickHouse

**Files:** none changed unless a gate fails.

- [ ] **Step 1: The CI gate**

Run: `npm run typecheck && npm test && npm run lint && npm run build`
Expected: every command exits 0; the full suite passes. Fix anything that fails before moving on.

- [ ] **Step 2: The exact statement on the live ClickHouse**

Run (placeholder term; the real term stays on the owner's machine):

```bash
export DOCKER_CONFIG=<scratch>/dockercfg
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT filename, argMax(line_count, imported_at) AS line_count, argMax(size, imported_at) AS size_bytes, max(imported_at) AS last_imported FROM ulp.sources WHERE positionCaseInsensitiveUTF8(filename, {q:String}) > 0 GROUP BY filename ORDER BY last_imported DESC LIMIT 5000" --param_q="term-a" | head -5
```

Expected: rows, no `Code:` error (no nested-aggregate error); the same statement with an uppercase `--param_q` returns the same row count; `--param_q="%"` returns 0 rows. Record the elapsed time.

---

### Task 5: Candidate image, rehearsal UI check, deploy, push

**Files:** none.

- [ ] **Step 1: Tag the running image, build the candidate**

```bash
docker tag "$(docker inspect -f '{{.Image}}' ulpsuite_app)" ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz)
git archive HEAD | DOCKER_CONFIG=<scratch>/dockercfg docker build -t ulp-suite-app:sources-search-candidate -
```

Expected: build succeeds; `docker images` lists both tags.

- [ ] **Step 2: Rehearsal stack and the page**

Follow `reference_rehearsal_ui_check`: `REHEARSAL_APP_IMAGE=ulp-suite-app:sources-search-candidate npx tsx scripts/e2e-alert-rehearsal.ts --keep`, seed `ulp.sources` rows (two names with a shared term, one with size 0, one differing only in case) and two `processing_jobs` rows (one held, one done) with placeholder names, log in on 127.0.0.1:3101, open `/sources` and check in the Browser pane: type a term (badge, size and date show; the date is the local time of the UTC stamp), the uppercase form finds the same rows, a one-character box shows the list and the hint, clear returns the list, a no-match term shows the message, a held name shows *Held* and no delete button, and a fast second query is not overwritten by a slow first one (override `window.fetch`). Tear the stack down.

- [ ] **Step 3: Deploy**

`docker tag ulp-suite-app:sources-search-candidate ulp-suite-app:latest`, check `inbox/processing` is empty, then from the primary checkout `docker compose up -d --no-build app`. Expected: `ulpsuite_app` healthy; on `http://localhost:3000/sources` the search answers for a real name.

- [ ] **Step 4: Push and close**

After CI is green on the pushed commit: `git push origin main`. Update the spec status line to "Built and deployed 2026-11-08".
