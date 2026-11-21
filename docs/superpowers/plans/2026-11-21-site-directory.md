# Site Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/directory` page under Site Counts that keeps every site ever counted, ordered by rows like Site Counts, scrolling without end like the Credentials page, refreshing itself after every ingest, and opening a site shows its count and its e-mail / phone / user name / other split.

**Architecture:** A SQLite table `site_directory` is written by `answerSiteCounts` (so the page, a closed tab and the API all feed it) and refreshed by an in-process tick that reuses the search dictionary's live-table fingerprint. The server sorts, searches and pages the directory in SQLite (`LIMIT/OFFSET`); the page is an endless list built on the Credentials page's scroll helpers. The split is a ClickHouse query run when a row with none is opened, at most two at a time.

**Tech Stack:** Next.js 14 app router, TypeScript, better-sqlite3 (`lib/sqlite.ts`), ClickHouse 26.3 (`lib/clickhouse.ts`), vitest, lucide-react, Tailwind. Design: `docs/superpowers/specs/2026-11-21-site-directory-design.md`.

## Global Constraints

- **Work only in the worktree** `/home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory` (branch `feat/site-directory`). Every Bash call starts with `cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory`; every file path is absolute under it. A bare `/home/cole/Desktop/ulp-suite/...` path is the MAIN checkout. Check `git branch --show-current` prints `feat/site-directory` before any commit.
- **The repo is public.** Committed text (code, tests, docs, commit messages) carries numbers and reasons only. Hosts in tests and docs are invented: `corp.example`, `app.corp.example`, `*.example`, `*.test`. Never a real search term, log excerpt, data-file name or credential value. Live checks print labels and counts only.
- A site is keyed by the host the counts name (`siteEntry`, `lib/site-counts-input.ts`); `isMarkableHost` (`lib/site-marks-input.ts`) is the test for a storable key.
- ClickHouse changes are proven on a real ClickHouse: the breakdown SQL gets a live parity test (`BLK_LIVE=1`) and a step in the rehearsal stack. A mocked-SQL test alone is not enough.
- The production build strips `console.log`: anything `docker logs` must show uses `console.warn` / `console.error`.
- The app sees only the variables `docker-compose.yml` forwards by name. The two new settings, `SITE_DIRECTORY_CRON_MINUTES` (default 10, 0 = off) and `SITE_DIRECTORY_SETTLE_SECONDS` (default 120), go in `docker-compose.yml`, `docker-compose.rehearsal.yml`, `.env.example` and `README.md`.
- No ClickHouse DDL change. SQLite change is additive (`CREATE TABLE IF NOT EXISTS`).
- Session-only routes (`validateRequest`), not under `/api/v1`. Any signed-in user, as Site Counts.
- Breakdown: stored `login_type` column (`email`, `phone`, `username`, else other); time limit 20 s; at most 2 breakdown queries at once in the app.
- Tests that touch SQLite run on the per-worker SQLite file (`__tests__/setup/`); they must `DELETE` their own rows in `beforeEach`.
- Lint a worktree with the cascade off: `npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .js,.jsx,.ts,.tsx app components lib hooks`. Do not edit `.eslintrc.json`.
- Never run `docker compose` from this worktree (it blanks `.env` and serves an empty database). Deploy steps run from `/home/cole/Desktop/ulp-suite` only.

## File Structure

| File | Responsibility |
|---|---|
| `lib/sqlite.ts` (modify) | the `site_directory` table |
| `lib/site-counts-input.ts` (modify) | `TOO_BROAD` / `OUT_OF_TIME` strings move here (pure) so the store can tell the two apart |
| `lib/site-counts.ts` (modify) | imports those strings, exports `isTooBroad`, records every count into the directory |
| `lib/site-directory-input.ts` (create) | types, list query parsing, breakdown shares, status line: everything the page may import |
| `lib/site-directory-state.ts` (create) | module state of the refresh (`running`, `lastRefreshedAt`) read by the list and status answers |
| `lib/site-directory.ts` (create) | SQLite store: record, seed, remove, list/sort/search/page, stale queries, breakdown storage, answers |
| `lib/site-directory-breakdown.ts` (create) | the breakdown query, the 2-at-a-time limiter, `answerBreakdown` |
| `lib/site-directory-cron.ts` (create) | the refresh tick, the two settings, the status answer, the starter |
| `lib/site-marks-client.ts` (modify) | `adopt()`: a page that gets its marks with its list hands them to the store |
| `components/list-footer-line.tsx` (create) | the endless list's footer, moved out of the Credentials page (text unchanged for it) |
| `components/site-sort-header.tsx` (create) | `SortHeader`, moved out of the Site Counts page |
| `components/site-count-row.tsx` (modify) | an optional `detail` for the directory; Site Counts is unchanged |
| `components/breakdown-bar.tsx` (create) | the stacked bar and legend |
| `components/site-directory-detail.tsx` (create) | what an opened directory row adds |
| `components/app-sidebar.tsx` (modify) | "Site Directory" under "Site Counts" |
| `app/directory/page.tsx` (create) | the page |
| `app/api/lookup/directory/route.ts`, `.../breakdown/route.ts`, `.../status/route.ts` (create) | thin session routes |
| `instrumentation.ts` (modify) | starts the tick |
| `scripts/e2e-batch-lookup.ts` (modify) | rehearsal step for the directory |
| tests | `__tests__/site-directory-input.test.ts`, `site-directory.test.ts`, `site-directory-order.test.ts`, `site-directory-record.test.ts`, `site-directory-routes.test.ts`, `site-directory-breakdown.test.ts`, `site-directory.live.test.ts`, `site-directory-cron.test.ts`, `site-directory-page.test.ts`, plus edits to `site-counts-routes.test.ts`, `site-marks-client.test.ts`, `credentials-page-endless.test.ts` |

---

### Task 0: Worktree ready

**Files:** none changed.

- [ ] **Step 1: Install and baseline**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && git branch --show-current && npm ci 2>&1 | tail -3
```
Expected: `feat/site-directory`, then npm finishes with no error.

- [ ] **Step 2: Baseline tests and types are green**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-marks.test.ts __tests__/site-counts-routes.test.ts __tests__/search-dictionary-cron.test.ts 2>&1 | tail -6 && npx tsc --noEmit 2>&1 | tail -3
```
Expected: all passed; `tsc` prints nothing.

---

### Task 1: The table, the pure module and the store

**Files:**
- Modify: `lib/sqlite.ts` (after the `site_marks` block, before the `// Add rescan columns` comment)
- Modify: `lib/site-counts-input.ts` (constants), `lib/site-counts.ts` (use them)
- Create: `lib/site-directory-input.ts`, `lib/site-directory-state.ts`, `lib/site-directory.ts`
- Test: `__tests__/site-directory-input.test.ts`, `__tests__/site-directory.test.ts`

**Interfaces:**
- Produces (pure, `lib/site-directory-input.ts`): `DIRECTORY_PAGE_SIZE = 200`; types `BreakdownCounts`, `Breakdown`, `DirectorySite`, `DirectoryListing`, `DirectoryStatus`, `DirectoryQuery`; functions `directoryQueryFromParams(sp)`, `directoryParams(query)`, `BREAKDOWN_PARTS`, `breakdownTotal(b)`, `breakdownShares(b)`, `formatShare(percent)`, `directoryResult(site)`, `needsBreakdown(site)`, `breakdownNote(site)`, `statusLine(status)`.
- Produces (`lib/site-counts-input.ts`): `TOO_BROAD`, `OUT_OF_TIME` strings.
- Produces (`lib/site-directory.ts`): `seedFromMarks(): number`, `recordSites({results, windowed, fingerprint}): void`, `storeCounts(results, fingerprint): void`, `removeSite(host): boolean`, `getSite(host): DirectorySite | null`, `siteExists(host): boolean`, `directoryTotal(): number`, `outOfDateHosts(fp, limit): string[]`, `breakdownTargets(fp, limit): string[]`, `staleCount(fp): number`, `storeBreakdown(host, counts, fp): boolean`, `touchBreakdown(host, fp): void`.

- [ ] **Step 1: Write the failing test for the pure module**

Create `__tests__/site-directory-input.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import {
  DIRECTORY_PAGE_SIZE, breakdownNote, breakdownShares, breakdownTotal, directoryParams, directoryQueryFromParams, directoryResult, formatShare,
  needsBreakdown, statusLine, type DirectorySite,
} from '@/lib/site-directory-input'

const site = (over: Partial<DirectorySite> = {}): DirectorySite => ({
  host: 'corp.example', first_added_at: '2026-11-21 10:00:00', last_counted_at: '2026-11-21 10:00:00', times_counted: 1,
  count: 30, host_count: 10, subdomain_count: 20, subdomains: 2, top_subdomains: [{ domain: 'app.corp.example', count: 15 }],
  counted_at: '2026-11-21 10:00:00', count_error: null, breakdown: null, mark: null, ...over,
})

describe('formatShare', () => {
  test.each([[56.3, '56.3%'], [4, '4%'], [0, '0%'], [0.04, '<0.1%'], [100, '100%'], [39.74, '39.7%']])('%s -> %s', (percent, text) => {
    expect(formatShare(percent)).toBe(text)
  })
})

describe('breakdownShares', () => {
  test('gives each part its count, its share and its label, in the order e-mail, phone, user name, other', () => {
    const shares = breakdownShares({ email: 563, phone: 40, username: 397, other: 0, at: '2026-11-21 10:00:00' })
    expect(shares.map(s => [s.key, s.label, s.count, s.text])).toEqual([
      ['email', 'E-mail', 563, '56.3%'], ['phone', 'Phone', 40, '4%'], ['username', 'User name', 397, '39.7%'], ['other', 'Other', 0, '0%'],
    ])
    expect(breakdownTotal({ email: 563, phone: 40, username: 397, other: 0, at: 'x' })).toBe(1000)
  })
  test('a split over no rows has no shares to divide by zero', () => {
    expect(breakdownShares({ email: 0, phone: 0, username: 0, other: 0, at: 'x' }).every(s => s.percent === 0 && s.text === '0%')).toBe(true)
  })
})

describe('directoryQueryFromParams / directoryParams', () => {
  test('defaults: no sort, no search, all marks, first page of 200', () => {
    expect(directoryQueryFromParams(new URLSearchParams())).toEqual({ sort: null, q: '', mark: 'all', host: null, offset: 0, limit: DIRECTORY_PAGE_SIZE })
  })
  test('reads a sort and its direction, a search, a mark chip, an exact host, an offset and a smaller limit', () => {
    const q = directoryQueryFromParams(new URLSearchParams('sort=subdomains&dir=asc&q=%20Corp%20&mark=todo&host=corp.example&offset=400&limit=7'))
    expect(q).toEqual({ sort: { key: 'subdomains', direction: 'asc' }, q: 'Corp', mark: 'todo', host: 'corp.example', offset: 400, limit: 7 })
  })
  test('refuses what it does not know: an unknown sort is the default, an unknown mark is All, a limit is capped, a negative offset is zero', () => {
    const q = directoryQueryFromParams(new URLSearchParams('sort=drop&mark=maybe&offset=-5&limit=100000'))
    expect(q).toMatchObject({ sort: null, mark: 'all', offset: 0, limit: DIRECTORY_PAGE_SIZE })
    expect(directoryQueryFromParams(new URLSearchParams('limit=abc')).limit).toBe(DIRECTORY_PAGE_SIZE)
  })
  test('the page builds what the route reads', () => {
    const sp = directoryParams({ sort: { key: 'mark', direction: 'desc' }, q: 'corp', mark: 'done', offset: 200 })
    expect(directoryQueryFromParams(sp)).toMatchObject({ sort: { key: 'mark', direction: 'desc' }, q: 'corp', mark: 'done', offset: 200 })
    expect(directoryParams({ sort: null, q: '', mark: 'all' }).toString()).toBe('')
  })
})

describe('directoryResult', () => {
  test('is the Site Counts result of a stored site, so the Site Counts row can show it', () => {
    expect(directoryResult(site())).toEqual({
      host: 'corp.example', found: true, count: 30, host_count: 10, subdomain_count: 20, subdomains: 2, top_subdomains: [{ domain: 'app.corp.example', count: 15 }],
    })
  })
  test('a site not counted yet has no numbers and is not "found"; a stored reason shows as the row error', () => {
    const r = directoryResult(site({ count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [], count_error: 'too broad to count in the time allowed' }))
    expect(r).toMatchObject({ found: false, count: null, error: 'too broad to count in the time allowed' })
    expect(directoryResult(site({ count: 0 })).found).toBe(false)
  })
})

describe('needsBreakdown / breakdownNote', () => {
  test('a split is worked out for a site without one unless the site has no rows', () => {
    expect(needsBreakdown(site())).toBe(true)
    expect(needsBreakdown(site({ count: null }))).toBe(true)
    expect(needsBreakdown(site({ count: 0 }))).toBe(false)
    expect(needsBreakdown(site({ breakdown: { email: 30, phone: 0, username: 0, other: 0, at: 'x' } }))).toBe(false)
  })
  test('says so when the split was made over another number of rows than the site has now', () => {
    const b = { email: 20, phone: 0, username: 0, other: 0, at: 'x' }
    expect(breakdownNote(site({ breakdown: b }))).toBe('Worked out over 20 rows; the site has 30 now.')
    expect(breakdownNote(site({ breakdown: { ...b, email: 30 } }))).toBeNull()
    expect(breakdownNote(site({ breakdown: b, count: null }))).toBeNull()
    expect(breakdownNote(site())).toBeNull()
  })
})

describe('statusLine', () => {
  test.each([
    [{ total: 212, out_of_date: 0, state: 'current', refreshed_at: null }, '212 sites · numbers current'],
    [{ total: 1, out_of_date: 0, state: 'current', refreshed_at: null }, '1 site · numbers current'],
    [{ total: 212, out_of_date: 37, state: 'waiting', refreshed_at: null }, 'waiting for imports to settle: 37 sites will be recounted'],
    [{ total: 212, out_of_date: 1, state: 'refreshing', refreshed_at: null }, 'refreshing: 1 site is older than the last import'],
    [{ total: 212, out_of_date: 37, state: 'refreshing', refreshed_at: null }, 'refreshing: 37 sites are older than the last import'],
  ] as const)('%j', (status, text) => {
    expect(statusLine(status)).toBe(text)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-input.test.ts 2>&1 | tail -8
```
Expected: FAIL, `Failed to resolve import "@/lib/site-directory-input"`.

- [ ] **Step 3: Write the pure module**

Create `lib/site-directory-input.ts`:

```ts
/**
 * The Site Directory in the parts the page (a client component), its routes and its store share (design:
 * docs/superpowers/specs/2026-11-21-site-directory-design.md). The SQLite side is lib/site-directory.ts, which a page cannot import.
 *
 * The directory keeps every site that was counted, under the host the counts name (the key the marks use), with the numbers of its last all-time
 * count and, once asked for, how its logins split into e-mail, phone, user name and other.
 */
import type { SiteCount, SiteSort, SiteSortKey } from '@/lib/site-counts-input'
import { MARK_FILTERS, type MarkFilter, type SiteMark } from '@/lib/site-marks-input'

/** Sites in one page of the list: the page asks for no more and the server never sends more. */
export const DIRECTORY_PAGE_SIZE = 200

export interface BreakdownCounts {
  email: number
  phone: number
  username: number
  other: number
}

export interface Breakdown extends BreakdownCounts {
  /** SQLite UTC text, "YYYY-MM-DD HH:MM:SS". */
  at: string
}

/** One site as the list sends it. The numbers are those of the last all-time count; null where nothing was counted. */
export interface DirectorySite {
  host: string
  first_added_at: string
  last_counted_at: string | null
  times_counted: number
  count: number | null
  host_count: number | null
  subdomain_count: number | null
  subdomains: number | null
  top_subdomains: Array<{ domain: string; count: number }>
  counted_at: string | null
  /** Why the last count of this site gave no number (too broad), for as long as the table has not changed. */
  count_error: string | null
  breakdown: Breakdown | null
  mark: SiteMark | null
}

export interface DirectoryListing {
  sites: DirectorySite[]
  /** The offset of the next page, null at the end. */
  next_offset: number | null
  /** The sites matching the search and the chip; null after the first page, which carries it. */
  total: number | null
  /** The number each chip shows for the current search; null after the first page. */
  marks: Record<MarkFilter, number> | null
  /** When the refresh last finished in this process (ISO), null if it has not. The page offers a reload when it moves. */
  refreshed_at: string | null
}

export interface DirectoryStatus {
  total: number
  out_of_date: number
  state: 'current' | 'waiting' | 'refreshing'
  refreshed_at: string | null
}

export interface DirectoryQuery {
  sort: SiteSort | null
  q: string
  mark: MarkFilter
  /** One exact host (the page re-reads a single row with it). */
  host: string | null
  offset: number
  limit: number
}

const SORT_KEYS: readonly SiteSortKey[] = ['count', 'host_count', 'subdomain_count', 'subdomains', 'mark']
const MAX_SEARCH_LENGTH = 253

/** The list query a request asks for. Whatever it does not know falls back to the default, so a stale bookmark still shows a list. */
export function directoryQueryFromParams(sp: URLSearchParams): DirectoryQuery {
  const key = sp.get('sort')
  const sort: SiteSort | null = SORT_KEYS.includes(key as SiteSortKey)
    ? { key: key as SiteSortKey, direction: sp.get('dir') === 'asc' ? 'asc' : 'desc' }
    : null
  const mark = sp.get('mark') ?? 'all'
  const asked = Math.floor(Number(sp.get('limit')))
  const host = (sp.get('host') ?? '').trim()
  return {
    sort,
    q: (sp.get('q') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
    mark: (MARK_FILTERS as readonly string[]).includes(mark) ? (mark as MarkFilter) : 'all',
    host: host === '' ? null : host,
    offset: Math.max(0, Math.floor(Number(sp.get('offset'))) || 0),
    limit: asked > 0 ? Math.min(asked, DIRECTORY_PAGE_SIZE) : DIRECTORY_PAGE_SIZE,
  }
}

/** The query string of a list request: what directoryQueryFromParams reads. Empty fields are left out. */
export function directoryParams(query: { sort: SiteSort | null; q: string; mark: MarkFilter; host?: string; offset?: number; limit?: number }): URLSearchParams {
  const ps = new URLSearchParams()
  if (query.sort) {
    ps.set('sort', query.sort.key)
    ps.set('dir', query.sort.direction)
  }
  if (query.q) ps.set('q', query.q)
  if (query.mark !== 'all') ps.set('mark', query.mark)
  if (query.host) ps.set('host', query.host)
  if (query.offset) ps.set('offset', String(query.offset))
  if (query.limit) ps.set('limit', String(query.limit))
  return ps
}

export const BREAKDOWN_PARTS = [
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Phone' },
  { key: 'username', label: 'User name' },
  { key: 'other', label: 'Other' },
] as const

export const breakdownTotal = (b: BreakdownCounts): number => b.email + b.phone + b.username + b.other

/** A share as text: one decimal, no trailing zero, and "<0.1%" for a part too small to round to a tenth. */
export function formatShare(percent: number): string {
  if (percent <= 0) return '0%'
  if (percent < 0.1) return '<0.1%'
  return `${Math.round(percent * 10) / 10}%`
}

export interface BreakdownShare {
  key: (typeof BREAKDOWN_PARTS)[number]['key']
  label: string
  count: number
  percent: number
  text: string
}

export function breakdownShares(b: BreakdownCounts): BreakdownShare[] {
  const total = breakdownTotal(b)
  return BREAKDOWN_PARTS.map(({ key, label }) => {
    const percent = total === 0 ? 0 : (b[key] / total) * 100
    return { key, label, count: b[key], percent, text: formatShare(percent) }
  })
}

/** A stored site as the Site Counts row shows a count, so the one row component serves both pages. */
export function directoryResult(site: DirectorySite): SiteCount {
  return {
    host: site.host,
    found: (site.count ?? 0) > 0,
    count: site.count,
    host_count: site.host_count,
    subdomain_count: site.subdomain_count,
    subdomains: site.subdomains,
    top_subdomains: site.top_subdomains,
    ...(site.count_error ? { error: site.count_error } : {}),
  }
}

/** Opening a row works the split out when there is none, unless the site is known to have no rows. */
export function needsBreakdown(site: DirectorySite): boolean {
  return site.breakdown === null && site.count !== 0
}

/** A sentence when the split was made over another number of rows than the site has now; null when they agree or either is unknown. */
export function breakdownNote(site: DirectorySite): string | null {
  if (!site.breakdown || site.count === null) return null
  const was = breakdownTotal(site.breakdown)
  return was === site.count ? null : `Worked out over ${was.toLocaleString('en-US')} rows; the site has ${site.count.toLocaleString('en-US')} now.`
}

/** The line above the list. */
export function statusLine(status: DirectoryStatus): string {
  const sites = (n: number) => `${n.toLocaleString('en-US')} site${n === 1 ? '' : 's'}`
  if (status.state === 'refreshing') return `refreshing: ${sites(status.out_of_date)} ${status.out_of_date === 1 ? 'is' : 'are'} older than the last import`
  if (status.state === 'waiting') return `waiting for imports to settle: ${sites(status.out_of_date)} will be recounted`
  return `${sites(status.total)} · numbers current`
}
```

- [ ] **Step 4: Run it to see it pass**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-input.test.ts 2>&1 | tail -6
```
Expected: all tests pass.

- [ ] **Step 5: Move the two reason strings to the pure module**

In `lib/site-counts-input.ts`, directly after the line `export const NOT_A_SITE = 'not a site address'`, add:

```ts

/**
 * Why a site has no number when the time limit stopped its count. The directory tells the two apart: a site too broad for the limit is not tried again
 * until the table changes, a site the request never reached is tried at the next refresh.
 */
export const TOO_BROAD = 'too broad to count in the time allowed'
export const OUT_OF_TIME = 'not counted: the time limit for one request was reached, send this site again'
```

In `lib/site-counts.ts`: replace the import line

```ts
import { SITE_COUNTS_MAX_PER_REQUEST, planSites, splitRequests, type SiteCount, type SiteEntry } from '@/lib/site-counts-input'
```
with
```ts
import { OUT_OF_TIME, SITE_COUNTS_MAX_PER_REQUEST, TOO_BROAD, planSites, splitRequests, type SiteCount, type SiteEntry } from '@/lib/site-counts-input'
```
delete the two lines
```ts
const TOO_BROAD = 'too broad to count in the time allowed'
const OUT_OF_TIME = 'not counted: the time limit for one request was reached, send this site again'
```
and change `function isTooBroad(err: unknown): boolean {` to `export function isTooBroad(err: unknown): boolean {`.

- [ ] **Step 6: Add the table**

In `lib/sqlite.ts`, immediately before the line `  // Add rescan columns to existing databases (idempotent — catch swallows "duplicate column" errors)`, insert:

```ts
  // The Site Directory (lib/site-directory.ts): every site that was counted, under the host the counts name, with the numbers of its last all-time count,
  // the fingerprint of the live table those numbers were made against (counted_fp: a site is out of date when it is not the present one) and, once asked
  // for, the split of its logins by type. Additive, so an image that does not know the table ignores it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_directory (
      host            TEXT PRIMARY KEY,
      first_added_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_counted_at TEXT,
      times_counted   INTEGER NOT NULL DEFAULT 0,
      row_count       INTEGER,
      host_count      INTEGER,
      subdomain_count INTEGER,
      subdomains      INTEGER,
      top_subdomains  TEXT,
      counted_at      TEXT,
      counted_fp      TEXT,
      count_error     TEXT,
      bd_email        INTEGER,
      bd_phone        INTEGER,
      bd_username     INTEGER,
      bd_other        INTEGER,
      bd_at           TEXT,
      bd_fp           TEXT
    )
  `)

```

- [ ] **Step 7: Write the failing store test**

Create `__tests__/site-directory.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'vitest'
import { dbGet, dbRun } from '@/lib/sqlite'
import { OUT_OF_TIME, TOO_BROAD, type SiteCount } from '@/lib/site-counts-input'
import {
  breakdownTargets, directoryTotal, getSite, outOfDateHosts, recordSites, removeSite, seedFromMarks, siteExists, staleCount, storeBreakdown,
  storeCounts, touchBreakdown,
} from '@/lib/site-directory'

// These run on the real SQLite file of the test worker (see __tests__/setup/), so the SQL itself is what is proven.
const counted = (host: string, over: Partial<SiteCount> = {}): SiteCount => ({
  host, found: true, count: 30, host_count: 10, subdomain_count: 20, subdomains: 2,
  top_subdomains: [{ domain: `app.${host}`, count: 15 }, { domain: `m.${host}`, count: 5 }], ...over,
})
const notCounted = (host: string, error: string): SiteCount => ({
  host, found: false, count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [], error,
})
const rowOf = (host: string) => dbGet('SELECT * FROM site_directory WHERE host = ?', [host]) as Record<string, any> | undefined
const run = (results: Record<string, SiteCount>, extra: { windowed?: boolean; fingerprint?: string | null } = {}) =>
  recordSites({ results, windowed: extra.windowed ?? false, fingerprint: extra.fingerprint === undefined ? 'fp-1' : extra.fingerprint })

beforeEach(() => {
  dbRun('DELETE FROM site_directory')
  dbRun('DELETE FROM site_marks')
  dbRun(`DELETE FROM app_settings WHERE key_name = 'site_directory_seeded'`)
})

describe('recordSites', () => {
  test('a first all-time count adds the site with its numbers, the date and the fingerprint', () => {
    run({ 'corp.example': counted('corp.example') })
    expect(rowOf('corp.example')).toMatchObject({
      times_counted: 1, row_count: 30, host_count: 10, subdomain_count: 20, subdomains: 2, counted_fp: 'fp-1', count_error: null,
      top_subdomains: JSON.stringify([{ domain: 'app.corp.example', count: 15 }, { domain: 'm.corp.example', count: 5 }]),
    })
    expect(rowOf('corp.example')!.counted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(rowOf('corp.example')!.first_added_at).toMatch(/^\d{4}-\d{2}-\d{2} /)
  })

  test('a repeat replaces the numbers and counts one more request', () => {
    run({ 'corp.example': counted('corp.example') })
    run({ 'corp.example': counted('corp.example', { count: 50, host_count: 20, subdomain_count: 30 }) }, { fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ times_counted: 2, row_count: 50, host_count: 20, counted_fp: 'fp-2' })
  })

  test('several spellings of one site in one request are one site counted once', () => {
    run({ 'corp.example': counted('corp.example'), 'https://www.corp.example/login': counted('corp.example'), '*.corp.example': counted('corp.example') })
    expect(directoryTotal()).toBe(1)
    expect(rowOf('corp.example')!.times_counted).toBe(1)
  })

  test('an entry that is not a site (no host) is not recorded', () => {
    run({ localhost: notCounted('', 'not a site address') })
    expect(directoryTotal()).toBe(0)
  })

  test('a count with an imported window adds a new site without numbers and leaves an old site\'s all-time numbers alone', () => {
    run({ 'corp.example': counted('corp.example') })
    run({ 'corp.example': counted('corp.example', { count: 3 }), 'new.example': counted('new.example', { count: 3 }) }, { windowed: true, fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, counted_fp: 'fp-1', times_counted: 2 })
    expect(rowOf('new.example')).toMatchObject({ row_count: null, counted_fp: null, counted_at: null, times_counted: 1 })
  })

  test('a site too broad to count is added, keeps the numbers it had and keeps the reason with the fingerprint', () => {
    run({ 'corp.example': counted('corp.example') })
    run({ 'corp.example': notCounted('corp.example', TOO_BROAD), 'huge.example': notCounted('huge.example', TOO_BROAD) }, { fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, count_error: TOO_BROAD, counted_fp: 'fp-2' })
    expect(rowOf('huge.example')).toMatchObject({ row_count: null, count_error: TOO_BROAD, counted_fp: 'fp-2' })
  })

  test('a site the request ran out of time before reaching is added but not marked as tried', () => {
    run({ 'corp.example': counted('corp.example') })
    run({ 'corp.example': notCounted('corp.example', OUT_OF_TIME) }, { fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, counted_fp: 'fp-1', count_error: null })
  })

  test('a later good count clears the reason', () => {
    run({ 'huge.example': notCounted('huge.example', TOO_BROAD) })
    run({ 'huge.example': counted('huge.example') }, { fingerprint: 'fp-2' })
    expect(rowOf('huge.example')).toMatchObject({ row_count: 30, count_error: null, counted_fp: 'fp-2' })
  })

  test('a host-only result is stored when nothing is, with no fingerprint so the refresh counts it again, and never replaces a complete count', () => {
    const hostOnly = counted('corp.example', { count: 10, subdomain_count: null, subdomains: null, top_subdomains: [] })
    run({ 'corp.example': hostOnly })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 10, subdomain_count: null, counted_fp: null })
    run({ 'corp.example': counted('corp.example') })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, subdomain_count: 20, counted_fp: 'fp-1' })
    run({ 'corp.example': hostOnly }, { fingerprint: 'fp-2' })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, subdomain_count: 20, counted_fp: 'fp-1' })
  })

  test('without a fingerprint (the table could not be read) the numbers are stored and the site is out of date at the next refresh', () => {
    run({ 'corp.example': counted('corp.example') }, { fingerprint: null })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, counted_fp: null })
    expect(staleCount('fp-now')).toBe(1)
  })
})

describe('storeCounts (the refresh)', () => {
  test('stores the numbers without counting a request, under the key it was given', () => {
    run({ 'corp.example': counted('corp.example') })
    storeCounts({ 'corp.example': counted('corp.example', { count: 99 }) }, 'fp-2')
    expect(rowOf('corp.example')).toMatchObject({ row_count: 99, counted_fp: 'fp-2', times_counted: 1 })
  })
  test('a key that is not in the directory is not added', () => {
    storeCounts({ 'ghost.example': counted('ghost.example') }, 'fp-2')
    expect(siteExists('ghost.example')).toBe(false)
  })
})

describe('seedFromMarks', () => {
  test('adds the marked sites once, dated by their mark, with no numbers', () => {
    dbRun(`INSERT INTO site_marks (host, status, updated_at) VALUES ('marked.example', 'done', '2026-10-30 09:00:00')`)
    dbRun(`INSERT INTO site_marks (host, note) VALUES ('noted.example', 'look later')`)
    expect(seedFromMarks()).toBe(2)
    expect(rowOf('marked.example')).toMatchObject({ first_added_at: '2026-10-30 09:00:00', row_count: null, counted_fp: null, times_counted: 0 })
    expect(directoryTotal()).toBe(2)
  })
  test('a removed site is not added again: the flag keeps it from running twice', () => {
    dbRun(`INSERT INTO site_marks (host, status) VALUES ('marked.example', 'done')`)
    seedFromMarks()
    removeSite('marked.example')
    expect(seedFromMarks()).toBe(0)
    expect(siteExists('marked.example')).toBe(false)
  })
})

describe('removeSite / getSite', () => {
  test('removes a site and says whether there was one', () => {
    run({ 'corp.example': counted('corp.example') })
    expect(removeSite('corp.example')).toBe(true)
    expect(removeSite('corp.example')).toBe(false)
  })
  test('a removed site that is counted again starts over', () => {
    run({ 'corp.example': counted('corp.example') })
    removeSite('corp.example')
    run({ 'corp.example': counted('corp.example') })
    expect(rowOf('corp.example')!.times_counted).toBe(1)
  })
  test('getSite gives the site as the list sends it, with its mark and its split', () => {
    run({ 'corp.example': counted('corp.example') })
    dbRun(`INSERT INTO site_marks (host, status, note, updated_by) VALUES ('corp.example', 'todo', 'check', 'a@example.test')`)
    storeBreakdown('corp.example', { email: 20, phone: 1, username: 8, other: 1 }, 'fp-1')
    expect(getSite('corp.example')).toMatchObject({
      host: 'corp.example', count: 30, host_count: 10, subdomain_count: 20, subdomains: 2, count_error: null,
      top_subdomains: [{ domain: 'app.corp.example', count: 15 }, { domain: 'm.corp.example', count: 5 }],
      mark: { status: 'todo', note: 'check', updated_by: 'a@example.test' },
      breakdown: { email: 20, phone: 1, username: 8, other: 1 },
    })
    expect(getSite('nope.example')).toBeNull()
  })
})

describe('out of date', () => {
  test('a site is out of date when it was never counted all-time or was counted against another fingerprint; the biggest come first, never-counted last', () => {
    run({ 'small.example': counted('small.example', { count: 5 }), 'big.example': counted('big.example', { count: 500 }), 'fresh.example': counted('fresh.example') })
    storeCounts({ 'fresh.example': counted('fresh.example') }, 'fp-now')
    run({ 'windowed.example': counted('windowed.example') }, { windowed: true })
    expect(outOfDateHosts('fp-now', 10)).toEqual(['big.example', 'small.example', 'windowed.example'])
    expect(outOfDateHosts('fp-now', 2)).toEqual(['big.example', 'small.example'])
    expect(staleCount('fp-now')).toBe(3)
  })
  test('a site that was too broad is not out of date until the fingerprint changes', () => {
    run({ 'huge.example': notCounted('huge.example', TOO_BROAD) }, { fingerprint: 'fp-now' })
    expect(outOfDateHosts('fp-now', 10)).toEqual([])
    expect(outOfDateHosts('fp-later', 10)).toEqual(['huge.example'])
  })
  test('a stored split is out of date on its own fingerprint, and a site with none never is', () => {
    run({ 'a.example': counted('a.example'), 'b.example': counted('b.example') }, { fingerprint: 'fp-now' })
    storeBreakdown('a.example', { email: 30, phone: 0, username: 0, other: 0 }, 'fp-old')
    expect(breakdownTargets('fp-now', 10)).toEqual(['a.example'])
    expect(staleCount('fp-now')).toBe(1)
    touchBreakdown('a.example', 'fp-now')
    expect(breakdownTargets('fp-now', 10)).toEqual([])
    expect(getSite('a.example')!.breakdown).toMatchObject({ email: 30 })
  })
  test('touching a site with no split does nothing', () => {
    run({ 'b.example': counted('b.example') })
    touchBreakdown('b.example', 'fp-now')
    expect(rowOf('b.example')!.bd_fp).toBeNull()
  })
})

describe('storeBreakdown', () => {
  test('stores the four parts, when and against which fingerprint, and says whether the site was there', () => {
    run({ 'corp.example': counted('corp.example') })
    expect(storeBreakdown('corp.example', { email: 563, phone: 40, username: 397, other: 0 }, 'fp-1')).toBe(true)
    expect(rowOf('corp.example')).toMatchObject({ bd_email: 563, bd_phone: 40, bd_username: 397, bd_other: 0, bd_fp: 'fp-1' })
    expect(rowOf('corp.example')!.bd_at).toMatch(/^\d{4}-\d{2}-\d{2} /)
    expect(storeBreakdown('gone.example', { email: 1, phone: 0, username: 0, other: 0 }, 'fp-1')).toBe(false)
  })
})
```

- [ ] **Step 8: Run it to see it fail**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory.test.ts 2>&1 | tail -8
```
Expected: FAIL, `Failed to resolve import "@/lib/site-directory"`.

- [ ] **Step 9: Write the state module and the store**

Create `lib/site-directory-state.ts`:

```ts
/**
 * What the Site Directory refresh is doing, for the status line and the list's "reload" hint (module state: the app runs as one process). The tick
 * (lib/site-directory-cron.ts) writes it; the answers in lib/site-directory.ts and lib/site-directory-cron.ts read it.
 */
export const refreshState: { running: boolean; lastRefreshedAt: string | null } = { running: false, lastRefreshedAt: null }
```

Create `lib/site-directory.ts` (this task writes the whole file except `listSites` and the answers, which Task 3 adds at the end; the import of `DirectoryQuery`, `DirectoryListing` and `orderBy` is added then):

```ts
/**
 * The store of the Site Directory (design: docs/superpowers/specs/2026-11-21-site-directory-design.md). SQLite, in the same file as the users, the
 * monitors and the marks. Every Site Counts request records its sites here (lib/site-counts.ts), and the refresh tick (lib/site-directory-cron.ts)
 * recounts the ones the table has outgrown. The parts a page can import are in lib/site-directory-input.ts.
 *
 * Rules that hold everywhere below: a number that was not counted is never stored as a zero and never replaces a stored number; a count with an
 * imported window writes no numbers (so "rows" always means all time); a site is "out of date" when it has no fingerprint of its own or the one it has
 * is not the table's present one (lib/search-dictionary.ts: readLiveState).
 */
import { dbGet, dbQuery, dbRun, dbTransaction } from '@/lib/sqlite'
import { OUT_OF_TIME, type SiteCount } from '@/lib/site-counts-input'
import type { SiteMarkStatus } from '@/lib/site-marks-input'
import type { BreakdownCounts, DirectorySite } from '@/lib/site-directory-input'

const SEED_FLAG = 'site_directory_seeded'

/**
 * Adds the sites that carry a mark, once: no search history exists, and a marked site has certainly been looked at. They have no numbers; the first
 * refresh counts them. The flag keeps a site the person removed from coming back at the next start.
 */
export function seedFromMarks(): number {
  if (dbGet(`SELECT 1 AS done FROM app_settings WHERE key_name = ?`, [SEED_FLAG])) return 0
  return dbTransaction(() => {
    const added = dbRun(`INSERT OR IGNORE INTO site_directory (host, first_added_at) SELECT host, updated_at FROM site_marks`).changes
    dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES (?, '1')`, [SEED_FLAG])
    return added
  })
}

/** One site's answer into its row: see the rules above. `fingerprint` null = the table could not be read: stored, but the site stays out of date. */
function storeCount(host: string, result: SiteCount, fingerprint: string | null): void {
  if (result.error === OUT_OF_TIME) return // the request never reached it: the next refresh counts it
  if (result.error !== undefined) {
    // too broad: keep the numbers, remember why, and do not try again until the table changes
    dbRun(`UPDATE site_directory SET count_error = ?, counted_fp = ? WHERE host = ?`, [result.error, fingerprint, host])
    return
  }
  if (result.count === null) return
  const hostOnly = result.subdomain_count === null
  if (hostOnly) {
    const stored = dbGet(`SELECT subdomain_count FROM site_directory WHERE host = ?`, [host]) as { subdomain_count: number | null } | undefined
    if (stored && stored.subdomain_count !== null) return // never replace a complete count with a host-only one
  }
  dbRun(
    `UPDATE site_directory SET row_count = ?, host_count = ?, subdomain_count = ?, subdomains = ?, top_subdomains = ?, counted_at = datetime('now'),
       counted_fp = ?, count_error = NULL WHERE host = ?`,
    [
      result.count, result.host_count, result.subdomain_count, result.subdomains, JSON.stringify(result.top_subdomains),
      hostOnly ? null : fingerprint, // a host-only count is out of date at once: the refresh gets the subdomains when the index is back
      host,
    ],
  )
}

export interface RecordInput {
  /** The answer of a count, keyed by what was pasted. */
  results: Record<string, SiteCount>
  /** The count had an imported window: it adds sites but writes no numbers. */
  windowed: boolean
  /** The fingerprint of the live table read BEFORE the counting; null when it could not be read. */
  fingerprint: string | null
}

/** Records the sites of one Site Counts request: each distinct host once, however many spellings were pasted. */
export function recordSites({ results, windowed, fingerprint }: RecordInput): void {
  const byHost = new Map<string, SiteCount>()
  for (const result of Object.values(results)) if (result.host !== '' && !byHost.has(result.host)) byHost.set(result.host, result)
  if (byHost.size === 0) return
  dbTransaction(() => {
    for (const [host, result] of byHost) {
      dbRun(
        `INSERT INTO site_directory (host, times_counted, last_counted_at) VALUES (?, 1, datetime('now'))
         ON CONFLICT(host) DO UPDATE SET times_counted = times_counted + 1, last_counted_at = datetime('now')`,
        [host],
      )
      if (!windowed) storeCount(host, result, fingerprint)
    }
  })
}

/** The refresh's write: the answers of a recount, keyed by the host that was counted. Adds no site and no request. */
export function storeCounts(results: Record<string, SiteCount>, fingerprint: string): void {
  dbTransaction(() => {
    for (const [host, result] of Object.entries(results)) storeCount(host, result, fingerprint)
  })
}

export function removeSite(host: string): boolean {
  return dbRun(`DELETE FROM site_directory WHERE host = ?`, [host]).changes > 0
}

export function siteExists(host: string): boolean {
  return dbGet(`SELECT 1 AS there FROM site_directory WHERE host = ?`, [host]) !== undefined
}

export function directoryTotal(): number {
  return (dbGet(`SELECT count(*) AS n FROM site_directory`) as { n: number }).n
}

// ── Out of date ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const COUNT_OUT_OF_DATE = `(counted_fp IS NULL OR counted_fp <> ?)`
const SPLIT_OUT_OF_DATE = `(bd_at IS NOT NULL AND (bd_fp IS NULL OR bd_fp <> ?))`
/** The biggest sites first (the ones looked at most), the ones never counted last. */
const BIGGEST_FIRST = `(row_count IS NULL), row_count DESC, host`

export function outOfDateHosts(fingerprint: string, limit: number): string[] {
  const rows = dbQuery(`SELECT host FROM site_directory WHERE ${COUNT_OUT_OF_DATE} ORDER BY ${BIGGEST_FIRST} LIMIT ?`, [fingerprint, limit]) as Array<{ host: string }>
  return rows.map(r => r.host)
}

/** Sites with a stored split that was made against another state of the table. A site with no split is never listed: the split stays on demand. */
export function breakdownTargets(fingerprint: string, limit: number): string[] {
  const rows = dbQuery(`SELECT host FROM site_directory WHERE ${SPLIT_OUT_OF_DATE} ORDER BY ${BIGGEST_FIRST} LIMIT ?`, [fingerprint, limit]) as Array<{ host: string }>
  return rows.map(r => r.host)
}

/** Sites whose count or split is out of date. */
export function staleCount(fingerprint: string): number {
  return (dbGet(`SELECT count(*) AS n FROM site_directory WHERE ${COUNT_OUT_OF_DATE} OR ${SPLIT_OUT_OF_DATE}`, [fingerprint, fingerprint]) as { n: number }).n
}

// ── The split ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function storeBreakdown(host: string, counts: BreakdownCounts, fingerprint: string | null): boolean {
  return dbRun(
    `UPDATE site_directory SET bd_email = ?, bd_phone = ?, bd_username = ?, bd_other = ?, bd_at = datetime('now'), bd_fp = ? WHERE host = ?`,
    [counts.email, counts.phone, counts.username, counts.other, fingerprint, host],
  ).changes > 0
}

/** A split that could not be refreshed keeps its numbers and is not tried again until the table changes. */
export function touchBreakdown(host: string, fingerprint: string): void {
  dbRun(`UPDATE site_directory SET bd_fp = ? WHERE host = ? AND bd_at IS NOT NULL`, [fingerprint, host])
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Row {
  host: string
  first_added_at: string
  last_counted_at: string | null
  times_counted: number
  row_count: number | null
  host_count: number | null
  subdomain_count: number | null
  subdomains: number | null
  top_subdomains: string | null
  counted_at: string | null
  count_error: string | null
  bd_email: number | null
  bd_phone: number | null
  bd_username: number | null
  bd_other: number | null
  bd_at: string | null
  mark_status: string | null
  mark_note: string | null
  mark_by: string | null
  mark_at: string | null
}

export const COLUMNS = `d.host, d.first_added_at, d.last_counted_at, d.times_counted, d.row_count, d.host_count, d.subdomain_count, d.subdomains, d.top_subdomains,
  d.counted_at, d.count_error, d.bd_email, d.bd_phone, d.bd_username, d.bd_other, d.bd_at,
  m.status AS mark_status, m.note AS mark_note, m.updated_by AS mark_by, m.updated_at AS mark_at`
export const FROM = `FROM site_directory d LEFT JOIN site_marks m ON m.host = d.host`

function parseTop(json: string | null): Array<{ domain: string; count: number }> {
  if (!json) return []
  try {
    const value: unknown = JSON.parse(json)
    if (!Array.isArray(value)) return []
    return value.filter((v): v is { domain: string; count: number } => typeof v?.domain === 'string' && typeof v?.count === 'number')
  } catch {
    return []
  }
}

export function toSite(r: Row): DirectorySite {
  return {
    host: r.host,
    first_added_at: r.first_added_at,
    last_counted_at: r.last_counted_at,
    times_counted: r.times_counted,
    count: r.row_count,
    host_count: r.host_count,
    subdomain_count: r.subdomain_count,
    subdomains: r.subdomains,
    top_subdomains: parseTop(r.top_subdomains),
    counted_at: r.counted_at,
    count_error: r.count_error,
    breakdown: r.bd_at === null
      ? null
      : { email: r.bd_email ?? 0, phone: r.bd_phone ?? 0, username: r.bd_username ?? 0, other: r.bd_other ?? 0, at: r.bd_at },
    mark: r.mark_status !== null || r.mark_note !== null
      ? { status: r.mark_status as SiteMarkStatus | null, note: r.mark_note, updated_by: r.mark_by, updated_at: r.mark_at }
      : null,
  }
}

export function getSite(host: string): DirectorySite | null {
  const [row] = dbQuery(`SELECT ${COLUMNS} ${FROM} WHERE d.host = ?`, [host]) as Row[]
  return row ? toSite(row) : null
}
```


- [ ] **Step 10: Run the tests and the types**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-input.test.ts __tests__/site-directory.test.ts __tests__/site-counts.test.ts __tests__/site-counts-routes.test.ts 2>&1 | tail -8 && npx tsc --noEmit 2>&1 | tail -5
```
Expected: all pass; `tsc` prints nothing. (If `site-counts-routes` fails, it is not yet affected: Task 2 changes it.)

- [ ] **Step 11: Commit**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && git add lib/sqlite.ts lib/site-counts-input.ts lib/site-counts.ts lib/site-directory-input.ts lib/site-directory-state.ts lib/site-directory.ts __tests__/site-directory-input.test.ts __tests__/site-directory.test.ts && git commit -q -m "$(cat <<'EOF'
feat(site-directory): the site_directory table, its pure module and the store that records, seeds, removes and finds what is out of date

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

---

### Task 2: Every Site Counts request records its sites

**Files:**
- Modify: `lib/site-counts.ts` (`answerSiteCounts`)
- Modify: `__tests__/site-counts-routes.test.ts` (`isReadiness`)
- Test: `__tests__/site-directory-record.test.ts`

**Interfaces:**
- Consumes: `recordSites`, `readLiveState` (from `lib/search-dictionary`: `Promise<LiveState | null>`, `LiveState.fingerprint`), `hasImportedRange(range)`.
- Produces: after every successful count the directory holds the sites; a failure to record is logged and never fails the count.

- [ ] **Step 1: Write the failing test**

Create `__tests__/site-directory-record.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({ success: true, apiKey: { id: 'k', role: 'admin' }, rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 } }),
  addRateLimitHeaders: vi.fn(response => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))
const calls: string[] = []
let liveRow: Record<string, unknown> | undefined
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string) => {
    calls.push(sql)
    if (sql.includes('system.projection_parts')) return [{ parts: 15, with_projection: 15 }]
    if (sql.includes('system.mutations')) return liveRow ? [liveRow] : []
    return [{ host: 'corp.example', host_count: '10', subdomain_count: '20', subdomains: '2', top_names: ['app.corp.example'], top_counts: ['20'] }]
  }),
}))
vi.mock('@/lib/site-directory', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/site-directory')>()
  return { ...actual, recordSites: vi.fn(actual.recordSites) }
})

import { NextRequest } from 'next/server'
import { dbGet, dbRun } from '@/lib/sqlite'
import { POST as uiCounts } from '@/app/api/lookup/counts/route'
import { POST as v1Counts } from '@/app/api/v1/lookup/counts/route'
import { recordSites } from '@/lib/site-directory'

const post = (handler: (r: NextRequest) => Promise<Response>, url: string, body: unknown) =>
  handler(new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) }))
const rowOf = (host: string) => dbGet('SELECT * FROM site_directory WHERE host = ?', [host]) as Record<string, any> | undefined
const fingerprintOf = (uuid: string, parts: string, mutations: string) => createHash('sha1').update(`${uuid}|${parts}|${mutations}`).digest('hex')

beforeEach(() => {
  calls.length = 0
  liveRow = { table_uuid: 'uuid-1', part_state: '202611:100:1:9', mutation_state: '', mutations_running: 0, builds_running: 0 }
  dbRun('DELETE FROM site_directory')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe.each([
  ['POST /api/lookup/counts', uiCounts, '/api/lookup/counts'],
  ['POST /api/v1/lookup/counts', v1Counts, '/api/v1/lookup/counts'],
] as const)('%s feeds the directory', (_name, handler, url) => {
  test('the counted site is in the directory with its numbers and the fingerprint read before the counting', async () => {
    const res = await post(handler, url, { domains: ['https://www.Corp.example/login', 'corp.example'] })
    expect(res.status).toBe(200)
    expect(rowOf('corp.example')).toMatchObject({
      times_counted: 1, row_count: 30, host_count: 10, subdomain_count: 20, subdomains: 2,
      counted_fp: fingerprintOf('uuid-1', '202611:100:1:9', ''),
    })
    // the table was read first, then counted
    const order = calls.filter(sql => !sql.includes('system.projection_parts')).map(sql => (sql.includes('system.mutations') ? 'live' : 'count'))
    expect(order).toEqual(['live', 'count'])
  })

  test('a count with an imported window adds the site and writes no numbers', async () => {
    await post(handler, url, { domains: ['corp.example'], imported_after: '2026-10-01' })
    expect(rowOf('corp.example')).toMatchObject({ times_counted: 1, row_count: null, counted_fp: null })
  })

  test('when the table cannot be read the numbers are still stored, without a fingerprint', async () => {
    liveRow = undefined
    await post(handler, url, { domains: ['corp.example'] })
    expect(rowOf('corp.example')).toMatchObject({ row_count: 30, counted_fp: null })
  })

  test('a failure to record is logged and the count is answered as before', async () => {
    vi.mocked(recordSites).mockImplementationOnce(() => { throw new Error('database is locked') })
    const res = await post(handler, url, { domains: ['corp.example'] })
    expect(res.status).toBe(200)
    expect((await res.json()).results['corp.example']).toMatchObject({ count: 30 })
    expect(console.error).toHaveBeenCalledWith('site directory record error:', expect.any(Error))
  })

  test('a request that is refused records nothing', async () => {
    await post(handler, url, { domains: [] })
    expect(rowOf('corp.example')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-record.test.ts 2>&1 | tail -10
```
Expected: FAIL (`rowOf('corp.example')` is undefined: nothing records yet).

- [ ] **Step 3: Record in `answerSiteCounts`**

In `lib/site-counts.ts`:

1. Change the import line
```ts
import { importedRangeAndSql, importedRangeEchoIfSet, importedRangePlain, parseImportedRange, type ImportedRange } from '@/lib/imported-range'
```
to
```ts
import { hasImportedRange, importedRangeAndSql, importedRangeEchoIfSet, importedRangePlain, parseImportedRange, type ImportedRange } from '@/lib/imported-range'
```
2. Directly after the import of `@/lib/site-counts-input` add:
```ts
import { readLiveState } from '@/lib/search-dictionary'
import { recordSites } from '@/lib/site-directory'
```
3. In `answerSiteCounts`, replace
```ts
  try {
    const { results, subdomains_counted } = await countSites(domains, parsedRange.range)
    return {
```
with
```ts
  try {
    // The Site Directory marks a count with the state of the table it was made against, read BEFORE counting: rows that arrive meanwhile leave the
    // site out of date for the next refresh. readLiveState answers null instead of throwing.
    const fingerprint = (await readLiveState())?.fingerprint ?? null
    const { results, subdomains_counted } = await countSites(domains, parsedRange.range)
    try {
      recordSites({ results, windowed: hasImportedRange(parsedRange.range), fingerprint })
    } catch (error) {
      console.error('site directory record error:', error)
    }
    return {
```

- [ ] **Step 4: Keep the existing route test counting only the counting queries**

In `__tests__/site-counts-routes.test.ts` change
```ts
const isReadiness = (sql: string) => sql.includes('system.projection_parts')
```
to
```ts
// the projection check, and the read of the table's fingerprint that precedes the counting (the directory's marker): neither is a counting query
const isReadiness = (sql: string) => sql.includes('system.projection_parts') || sql.includes('system.mutations')
```

- [ ] **Step 5: Run the tests**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-record.test.ts __tests__/site-counts-routes.test.ts __tests__/site-counts.test.ts 2>&1 | tail -8 && npx tsc --noEmit 2>&1 | tail -3
```
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && git add lib/site-counts.ts __tests__/site-counts-routes.test.ts __tests__/site-directory-record.test.ts && git commit -q -m "$(cat <<'EOF'
feat(site-directory): every Site Counts request records its sites, against the table's fingerprint read before counting

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

---

### Task 3: The list: sorted, searched and paged in SQLite, and its routes

**Files:**
- Modify: `lib/site-directory.ts` (append `listSites`, `answerDirectoryList`, `answerDirectoryRemove`)
- Create: `app/api/lookup/directory/route.ts`
- Test: `__tests__/site-directory-order.test.ts`, `__tests__/site-directory-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 store; `orderSiteRows`, `SiteSort` (`lib/site-counts-input`), `markRank`, `markStateOf` (`lib/site-marks-input`).
- Produces: `listSites(query: DirectoryQuery): DirectoryListing`; `answerDirectoryList(sp: URLSearchParams)` and `answerDirectoryRemove(body: unknown)` returning `{ status: number; json: Record<string, unknown> }`; `GET` and `DELETE /api/lookup/directory`.

- [ ] **Step 1: Write the failing order and paging test**

Create `__tests__/site-directory-order.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'vitest'
import { dbRun } from '@/lib/sqlite'
import { orderSiteRows, type SiteCount, type SiteSort } from '@/lib/site-counts-input'
import { markRank, type MarkState } from '@/lib/site-marks-input'
import { listSites } from '@/lib/site-directory'
import type { DirectoryQuery } from '@/lib/site-directory-input'

// The directory sorts in SQLite; the Site Counts page sorts with orderSiteRows. This test makes the second the oracle of the first: the same random
// sites, every sort the page offers in both directions, walked page by page, must come out in the same order (the host is the last tie-break).
interface Fixture { host: string; count: number | null; host_count: number | null; subdomain_count: number | null; subdomains: number | null; mark: MarkState }

function fixtures(seed: number, n: number): Fixture[] {
  let s = seed
  const rand = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
  const pick = (values: Array<number | null>) => values[Math.floor(rand() * values.length)]
  const marks: MarkState[] = ['done', 'skip', 'todo', 'none', 'none']
  return Array.from({ length: n }, (_, i) => {
    const counted = rand() > 0.15
    return {
      host: `s${String(i).padStart(3, '0')}.corp.example`,
      count: counted ? pick([0, 1, 5, 5, 40, 40, 900]) : null,
      host_count: counted ? pick([0, 3, 3, 20, null]) : null,
      subdomain_count: counted ? pick([0, 2, 2, 50, null]) : null,
      subdomains: counted ? pick([0, 1, 1, 7]) : null,
      mark: marks[Math.floor(rand() * marks.length)],
    }
  })
}

const toResult = (f: Fixture): SiteCount => ({
  host: f.host, found: (f.count ?? 0) > 0, count: f.count, host_count: f.host_count, subdomain_count: f.subdomain_count, subdomains: f.subdomains, top_subdomains: [],
})

function load(rows: Fixture[]) {
  dbRun('DELETE FROM site_directory')
  dbRun('DELETE FROM site_marks')
  dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES ('site_directory_seeded', '1')`)
  for (const f of rows) {
    dbRun(
      `INSERT INTO site_directory (host, row_count, host_count, subdomain_count, subdomains) VALUES (?, ?, ?, ?, ?)`,
      [f.host, f.count, f.host_count, f.subdomain_count, f.subdomains],
    )
    if (f.mark !== 'none' && f.mark !== null) dbRun(`INSERT INTO site_marks (host, status) VALUES (?, ?)`, [f.host, f.mark])
  }
}

const walk = (query: Omit<DirectoryQuery, 'offset' | 'limit'>, limit: number): string[] => {
  const hosts: string[] = []
  for (let offset: number | null = 0; offset !== null;) {
    const page = listSites({ ...query, offset, limit })
    hosts.push(...page.sites.map(s => s.host))
    offset = page.next_offset
  }
  return hosts
}

const KEYS = ['count', 'host_count', 'subdomain_count', 'subdomains', 'mark'] as const
const SORTS: Array<SiteSort | null> = [null, ...KEYS.flatMap(key => (['desc', 'asc'] as const).map(direction => ({ key, direction })))]

describe.each([1, 2, 3])('listSites order, seed %i', seed => {
  const rows = fixtures(seed, 60)
  beforeEach(() => load(rows))

  test.each(SORTS.map(sort => [sort ? `${sort.key} ${sort.direction}` : 'the default', sort] as const))('%s is the order of the Site Counts page', (_label, sort) => {
    const byHost = [...rows].sort((a, b) => (a.host < b.host ? -1 : 1)).map(f => ({ f, result: toResult(f) }))
    // the directory's default order is "most rows first, the sites with no number last": the page's explicit sort by rows
    const oracle = orderSiteRows(byHost, sort ?? { key: 'count', direction: 'desc' }, row => markRank(row.f.mark)).map(r => r.f.host)
    expect(walk({ sort, q: '', mark: 'all', host: null }, 7)).toEqual(oracle)
  })
})

describe('listSites paging', () => {
  const rows = fixtures(9, 45)
  beforeEach(() => load(rows))

  test('every site comes once, whatever the page size', () => {
    for (const size of [1, 7, 20, 45, 200]) {
      const hosts = walk({ sort: null, q: '', mark: 'all', host: null }, size)
      expect(hosts).toHaveLength(45)
      expect(new Set(hosts).size).toBe(45)
    }
  })

  test('the first page carries the total and the chips, the later ones do not, and the next offset ends with null', () => {
    const first = listSites({ sort: null, q: '', mark: 'all', host: null, offset: 0, limit: 10 })
    expect(first.total).toBe(45)
    expect(first.marks).not.toBeNull()
    expect(first.next_offset).toBe(10)
    const later = listSites({ sort: null, q: '', mark: 'all', host: null, offset: 10, limit: 10 })
    expect(later.total).toBeNull()
    expect(later.marks).toBeNull()
    expect(listSites({ sort: null, q: '', mark: 'all', host: null, offset: 40, limit: 10 }).next_offset).toBeNull()
  })

  test('a page past the end is empty and ends', () => {
    expect(listSites({ sort: null, q: '', mark: 'all', host: null, offset: 500, limit: 10 })).toMatchObject({ sites: [], next_offset: null })
  })
})

describe('listSites search and chips', () => {
  beforeEach(() => {
    load([])
    const add = (host: string, count: number, mark?: 'done' | 'todo') => {
      dbRun(`INSERT INTO site_directory (host, row_count) VALUES (?, ?)`, [host, count])
      if (mark) dbRun(`INSERT INTO site_marks (host, status) VALUES (?, ?)`, [host, mark])
    }
    add('shop.corp.example', 5, 'done')
    add('corp.example', 50, 'todo')
    add('other.example', 7)
    add('under_score.example', 1)
    add('100%.example', 2)
    dbRun(`INSERT INTO site_marks (host, note) VALUES ('other.example', 'note only')`)
  })
  const base = { sort: null, mark: 'all', host: null, offset: 0, limit: 50 } as const

  test('a search is a case-insensitive part of the host', () => {
    expect(listSites({ ...base, q: 'CORP' }).sites.map(s => s.host)).toEqual(['corp.example', 'shop.corp.example'])
  })

  test('% and _ in a search are letters, not wildcards', () => {
    expect(listSites({ ...base, q: '_' }).sites.map(s => s.host)).toEqual(['under_score.example'])
    expect(listSites({ ...base, q: '%' }).sites.map(s => s.host)).toEqual(['100%.example'])
  })

  test('a chip narrows the list; its total is the rows it shows and the chips count the current search, not the chip', () => {
    const done = listSites({ ...base, q: 'corp', mark: 'done' })
    expect(done.sites.map(s => s.host)).toEqual(['shop.corp.example'])
    expect(done.total).toBe(1)
    expect(done.marks).toEqual({ all: 2, done: 1, skip: 0, todo: 1, none: 0 })
    const none = listSites({ ...base, q: '', mark: 'none' })
    expect(none.sites.map(s => s.host).sort()).toEqual(['100%.example', 'other.example', 'under_score.example'])
    expect(none.marks).toEqual({ all: 5, done: 1, skip: 0, todo: 1, none: 3 })
  })

  test('a site with a note and no status is "No mark" and still shows its note', () => {
    const [other] = listSites({ ...base, q: 'other' }).sites
    expect(other.mark).toMatchObject({ status: null, note: 'note only' })
  })

  test('an exact host returns that one site', () => {
    expect(listSites({ ...base, q: '', host: 'corp.example' }).sites.map(s => s.host)).toEqual(['corp.example'])
    expect(listSites({ ...base, q: '', host: 'corp' }).sites).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-order.test.ts 2>&1 | tail -8
```
Expected: FAIL (`listSites is not a function` or an import error).

- [ ] **Step 3: Add the listing and the answers to `lib/site-directory.ts`**

Replace the five `import` lines at the top of `lib/site-directory.ts` (keep the header comment above them and `const SEED_FLAG` below them) with:

```ts
import { dbGet, dbQuery, dbRun, dbTransaction } from '@/lib/sqlite'
import { OUT_OF_TIME, type SiteCount, type SiteSort } from '@/lib/site-counts-input'
import type { MarkFilter, SiteMarkStatus } from '@/lib/site-marks-input'
import { directoryQueryFromParams, type BreakdownCounts, type DirectoryListing, type DirectoryQuery, type DirectorySite } from '@/lib/site-directory-input'
import { refreshState } from '@/lib/site-directory-state'
```

Append to the end of the file:

```ts
// ── The list ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const NUMBER_COLUMN = {
  count: 'd.row_count',
  host_count: 'd.host_count',
  subdomain_count: 'd.subdomain_count',
  subdomains: 'd.subdomains',
} as const

/** The Mark column's order (markRank in lib/site-marks-input.ts): To look at, then No mark, then Done, then Skip. */
const MARK_RANK_SQL = `CASE m.status WHEN 'todo' THEN 3 WHEN 'done' THEN 1 WHEN 'skip' THEN 0 ELSE 2 END`

/** The page's default order among equals (orderSiteRows: sites with rows first, the most rows first), and the host so that a page boundary never moves. */
const TIE_BREAK = `CASE WHEN d.row_count > 0 THEN 0 ELSE 1 END, COALESCE(d.row_count, 0) DESC, d.host`

/**
 * The ORDER BY of a list. No sort is the page's explicit sort by rows, biggest first: the sites with rows, then the sites with none, then the sites with no
 * number at all. A number column puts a site with no number last whichever way, never as a zero; __tests__/site-directory-order.test.ts holds this to
 * orderSiteRows.
 */
function orderBy(sort: SiteSort | null): string {
  if (sort === null) return `(d.row_count IS NULL), d.row_count DESC, d.host`
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC'
  if (sort.key === 'mark') return `${MARK_RANK_SQL} ${direction}, ${TIE_BREAK}`
  const column = NUMBER_COLUMN[sort.key]
  return `(${column} IS NULL), ${column} ${direction}, ${TIE_BREAK}`
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, char => `\\${char}`)

const whereOf = (parts: string[]) => (parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '')

/**
 * One page of the directory: sorted, searched and narrowed by mark chip in SQLite, `limit` sites from `offset`. The first page also carries the total of
 * what matches and the number each chip shows for the current search. LIMIT/OFFSET, not a keyset cursor: the whole directory sorts in milliseconds
 * (171 ms at offset 99,800 of 100,000 sites), and the page ignores a host it already shows, so a site added between two pages cannot appear twice.
 */
export function listSites(query: DirectoryQuery): DirectoryListing {
  seedFromMarks()
  const search: string[] = []
  const searchParams: unknown[] = []
  if (query.host !== null) {
    search.push('d.host = ?')
    searchParams.push(query.host)
  }
  if (query.q !== '') {
    search.push(`d.host LIKE ? ESCAPE '\\'`)
    searchParams.push(`%${escapeLike(query.q.toLowerCase())}%`)
  }
  const where = [...search]
  const params = [...searchParams]
  if (query.mark === 'none') {
    where.push('m.status IS NULL')
  } else if (query.mark !== 'all') {
    where.push('m.status = ?')
    params.push(query.mark)
  }

  const rows = dbQuery(
    `SELECT ${COLUMNS} ${FROM} ${whereOf(where)} ORDER BY ${orderBy(query.sort)} LIMIT ? OFFSET ?`,
    [...params, query.limit + 1, query.offset],
  ) as Row[]
  const sites = rows.slice(0, query.limit).map(toSite)

  let total: number | null = null
  let marks: Record<MarkFilter, number> | null = null
  if (query.offset === 0) {
    const chips = dbQuery(`SELECT COALESCE(m.status, 'none') AS s, count(*) AS n ${FROM} ${whereOf(search)} GROUP BY s`, searchParams) as Array<{ s: string; n: number }>
    marks = { all: 0, done: 0, skip: 0, todo: 0, none: 0 }
    for (const chip of chips) {
      if (chip.s in marks) marks[chip.s as MarkFilter] = chip.n
      marks.all += chip.n
    }
    total = marks[query.mark]
  }
  return { sites, next_offset: rows.length > query.limit ? query.offset + query.limit : null, total, marks, refreshed_at: refreshState.lastRefreshedAt }
}

// ── The answers of the routes ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface DirectoryReply {
  status: number
  json: Record<string, unknown>
}

/** GET /api/lookup/directory: one page of the list. */
export function answerDirectoryList(sp: URLSearchParams): DirectoryReply {
  try {
    return { status: 200, json: { success: true, ...listSites(directoryQueryFromParams(sp)) } }
  } catch (error) {
    console.error('site directory list error:', error)
    return { status: 500, json: { success: false, error: 'Reading the directory failed' } }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** DELETE /api/lookup/directory: `{ host }` takes a site out of the directory (it comes back, with its history reset, if it is counted again). */
export function answerDirectoryRemove(rawBody: unknown): DirectoryReply {
  const host = isObject(rawBody) && typeof rawBody.host === 'string' ? rawBody.host : ''
  if (host === '') return { status: 400, json: { success: false, error: 'Send the host to remove in "host"' } }
  try {
    return removeSite(host)
      ? { status: 200, json: { success: true, host } }
      : { status: 404, json: { success: false, error: 'That site is not in the directory' } }
  } catch (error) {
    console.error('site directory remove error:', error)
    return { status: 500, json: { success: false, error: 'Removing the site failed' } }
  }
}
```

- [ ] **Step 4: Run the order test**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-order.test.ts __tests__/site-directory.test.ts 2>&1 | tail -10
```
Expected: all pass, including the 33 order tests (3 seeds × 11 sorts). If an order test fails, print `walk(...)` next to `oracle` and fix the SQL (never the oracle).

- [ ] **Step 5: Write the failing route test**

Create `__tests__/site-directory-routes.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn() }))

import { NextRequest } from 'next/server'
import { validateRequest, type JWTPayload } from '@/lib/auth'
import { dbRun } from '@/lib/sqlite'
import { DELETE, GET } from '@/app/api/lookup/directory/route'

const analyst: JWTPayload = { userId: '2', username: 'Ana', email: 'ana@example.test', role: 'analyst' }
const get = (query = '') => GET(new NextRequest(`http://localhost/api/lookup/directory${query}`))
const del = (body: unknown) => DELETE(new NextRequest('http://localhost/api/lookup/directory', { method: 'DELETE', body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  vi.mocked(validateRequest).mockResolvedValue(analyst)
  dbRun('DELETE FROM site_directory')
  dbRun('DELETE FROM site_marks')
  dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES ('site_directory_seeded', '1')`)
  dbRun(`INSERT INTO site_directory (host, row_count, host_count, subdomain_count, subdomains) VALUES ('corp.example', 30, 10, 20, 2), ('quiet.example', 0, 0, 0, 0)`)
})

describe.each([['GET', () => get()], ['DELETE', () => del({ host: 'corp.example' })]] as const)('%s /api/lookup/directory', (_verb, call) => {
  test('needs a session: 401 without one, and nothing changes', async () => {
    vi.mocked(validateRequest).mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    vi.mocked(validateRequest).mockResolvedValue(analyst)
    expect((await (await get()).json()).total).toBe(2)
  })
})

describe('GET', () => {
  test('answers a page: the sites, the next offset, the total and the chips', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      success: true, next_offset: null, total: 2, marks: { all: 2, done: 0, skip: 0, todo: 0, none: 2 }, refreshed_at: null,
      sites: [{ host: 'corp.example', count: 30, host_count: 10, subdomain_count: 20, mark: null, breakdown: null }, { host: 'quiet.example', count: 0 }],
    })
  })

  test('reads the sort, the search, the chip and the paging from the query string', async () => {
    const json = await (await get('?sort=count&dir=asc&q=EXAMPLE&limit=1&offset=0')).json()
    expect(json.sites.map((s: { host: string }) => s.host)).toEqual(['quiet.example'])
    expect(json.next_offset).toBe(1)
    const next = await (await get('?sort=count&dir=asc&q=EXAMPLE&limit=1&offset=1')).json()
    expect(next.sites.map((s: { host: string }) => s.host)).toEqual(['corp.example'])
    expect(next.total).toBeNull()
  })

  test('an unknown sort or chip falls back to the default instead of failing', async () => {
    const res = await get('?sort=drop%20table&mark=maybe&offset=abc')
    expect(res.status).toBe(200)
    expect((await res.json()).sites).toHaveLength(2)
  })
})

describe('DELETE', () => {
  test('removes a site', async () => {
    const res = await del({ host: 'corp.example' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, host: 'corp.example' })
    expect((await (await get()).json()).total).toBe(1)
  })
  test('404 for a site that is not there, 400 for a body without a host or that is not JSON', async () => {
    expect((await del({ host: 'ghost.example' })).status).toBe(404)
    expect((await del({})).status).toBe(400)
    expect((await del({ host: 5 })).status).toBe(400)
    const bad = await del('{not json')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ success: false, error: 'Invalid JSON body' })
  })
})
```

- [ ] **Step 6: Run it to see it fail**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-routes.test.ts 2>&1 | tail -6
```
Expected: FAIL, cannot resolve `@/app/api/lookup/directory/route`.

- [ ] **Step 7: Write the route**

Create `app/api/lookup/directory/route.ts`:

```ts
/**
 * Internal Site Directory API (the Site Directory page)
 * GET    /api/lookup/directory?sort=<count|host_count|subdomain_count|subdomains|mark>&dir=desc|asc&q=<text>&mark=all|done|skip|todo|none&offset=<n>&limit=<<=200>&host=<exact>
 *        -> { success, sites[], next_offset, total, marks, refreshed_at }   (total and marks only on the first page)
 * DELETE /api/lookup/directory   body { host }  -> { success, host }
 *
 * Session-authenticated (the same auth as /api/lookup/counts): any signed-in user, admin or analyst. The directory is shared by everyone who signs in and
 * is not on /api/v1: an API key has no person, though an API count still feeds it. The checks, the SQL and the answers are in lib/site-directory.ts.
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { answerDirectoryList, answerDirectoryRemove } from "@/lib/site-directory"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const reply = answerDirectoryList(request.nextUrl.searchParams)
  return NextResponse.json(reply.json, { status: reply.status })
}

export async function DELETE(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const reply = answerDirectoryRemove(body)
  return NextResponse.json(reply.json, { status: reply.status })
}
```

- [ ] **Step 8: Run all tests of the task, the types and the lint**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-routes.test.ts __tests__/site-directory-order.test.ts __tests__/site-directory.test.ts __tests__/site-directory-input.test.ts 2>&1 | tail -6 && npx tsc --noEmit 2>&1 | tail -3 && npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .ts,.tsx lib app/api/lookup/directory 2>&1 | tail -5
```
Expected: all pass; no type errors; eslint prints nothing.

- [ ] **Step 9: Commit**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && git add lib/site-directory.ts app/api/lookup/directory/route.ts __tests__/site-directory-order.test.ts __tests__/site-directory-routes.test.ts && git commit -q -m "$(cat <<'EOF'
feat(site-directory): the list is sorted, searched and paged in SQLite in the order of the Site Counts page, with GET and DELETE routes

The order test sorts random directories and holds the SQL to orderSiteRows.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

---

### Task 4: The breakdown: its query, its limiter and its route

**Files:**
- Create: `lib/site-directory-breakdown.ts`, `app/api/lookup/directory/breakdown/route.ts`
- Test: `__tests__/site-directory-breakdown.test.ts`, `__tests__/site-directory.live.test.ts`
- Modify: `docs/superpowers/specs/2026-11-21-site-directory-design.md` (the measured shape)

**Interfaces:**
- Consumes: `storeBreakdown`, `siteExists`, `getSite` (Task 1), `isTooBroad` (`lib/site-counts.ts`), `isDomainRevProjectionReady` (`lib/credentials-projections.ts`), `readLiveState`, `isMarkableHost`.
- Produces: `BREAKDOWN_QUERY_SECONDS = 20`, `BREAKDOWN_MAX_PARALLEL = 2`, `breakdownSql(host)`, `bucketsFromRows(rows): BreakdownCounts`, `class BreakdownError { kind: 'too_broad' | 'unavailable' }`, `createLimiter(max)`, `breakdownFor(host): Promise<BreakdownCounts>`, `breakdownAndStore(host, fingerprint): Promise<void>`, `answerBreakdown(body): Promise<{status; json}>`, and `POST /api/lookup/directory/breakdown` -> `{ success, site }` or `{ success: false, error }` (400 bad host, 404 not in the directory, 503 index not ready, 504 too broad).

- [ ] **Step 1: Measure the shape of the single-site query on the live table (read-only)**

The spec flags that reading `login_type` made the planner read 4 to 10 times the rows of the plain count (212 M against 49.7 M for 20 sites; 1.22 B against 126.8 M for one broad site). Settle the shape before writing it. Use the session scratchpad directory for every file below; nothing goes in the repo, and the hosts printed stay out of every committed text.

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && SCRATCH=/tmp/claude-1000/-home-cole-Desktop-ulp-suite/83b2456e-d239-40bb-8a34-dc413216c472/scratchpad
PART=$(docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT name FROM system.parts WHERE database='ulp' AND table='credentials' AND active AND rows BETWEEN 5000000 AND 40000000 ORDER BY modification_time DESC LIMIT 1 FORMAT TSV")
docker exec ulpsuite_clickhouse clickhouse-client -q "WITH t AS (SELECT domain, count() n FROM ulp.credentials WHERE _part='$PART' AND position(domain,'.')>1 AND NOT domain LIKE '%:%' GROUP BY domain) SELECT domain FROM (SELECT domain, row_number() OVER (PARTITION BY multiIf(n>=5000,0,n>=1000,1,n>=200,2,n>=50,3,4) ORDER BY cityHash64(domain)) rn FROM t WHERE n>=20) WHERE rn<=1 FORMAT TSV" > $SCRATCH/hosts.tsv
docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT domain FROM ulp.credentials WHERE _part='$PART' AND position(domain,'.')>1 AND NOT domain LIKE '%:%' GROUP BY domain ORDER BY count() DESC LIMIT 1 FORMAT TSV" >> $SCRATCH/hosts.tsv
wc -l $SCRATCH/hosts.tsv
```
Expected: 6 lines (five sites of different sizes and the most frequent domain of the part, the broad one).

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && SCRATCH=/tmp/claude-1000/-home-cole-Desktop-ulp-suite/83b2456e-d239-40bb-8a34-dc413216c472/scratchpad
F="reverse(domain) = reverse('@HOST@') OR startsWith(reverse(domain), reverse(concat('.', '@HOST@')))"
S="SETTINGS max_execution_time = 60, max_projection_rows_to_use_projection_index = 200000000 FORMAT TSV"
echo "SELECT countIf(login_type='email'), countIf(login_type='phone'), countIf(login_type='username'), countIf(login_type NOT IN ('email','phone','username')) FROM ulp.credentials WHERE $F $S" > $SCRATCH/V0.sql
echo "SELECT login_type, count() FROM ulp.credentials WHERE $F GROUP BY login_type ORDER BY login_type $S" > $SCRATCH/V1.sql
echo "SELECT login_type, count() FROM ulp.credentials PREWHERE $F GROUP BY login_type ORDER BY login_type $S" > $SCRATCH/V2.sql
for v in V0 V1 V2 V0 V1 V2; do while read h; do sed "s/@HOST@/$h/g" $SCRATCH/$v.sql | docker exec -i ulpsuite_clickhouse clickhouse-client --log_comment="sdb_$v" > /dev/null; done < $SCRATCH/hosts.tsv; done
docker exec ulpsuite_clickhouse clickhouse-client -q "SYSTEM FLUSH LOGS"
docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT log_comment, count() AS runs, round(avg(query_duration_ms)) AS ms_avg, max(query_duration_ms) AS ms_max, formatReadableQuantity(avg(read_rows)) AS rows_avg, formatReadableSize(avg(read_bytes)) AS bytes_avg FROM system.query_log WHERE type='QueryFinish' AND log_comment LIKE 'sdb_%' AND event_time > now() - INTERVAL 30 MINUTE GROUP BY log_comment ORDER BY log_comment FORMAT TSV"
```
Expected: three lines (`sdb_V0`, `sdb_V1`, `sdb_V2`), 12 runs each. Each variant is the same question: V0 four `countIf` (the shape measured before), V1 a `GROUP BY login_type`, V2 the same with `PREWHERE`. The runs go in the order V0, V1, V2 twice, so a later variant never has the cache to itself.

Decision rule, written down before looking at the numbers: ship **V2 (`PREWHERE`)** if its average rows read is at least 25% below V1's, otherwise ship **V1**. V0 is the control and is not shipped (the code maps `GROUP BY` rows). Whatever wins, keep the three lines of numbers for Step 8. The decision sets the one constant `USE_PREWHERE` in Step 4.

- [ ] **Step 2: Write the failing test**

Create `__tests__/site-directory-breakdown.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn() }))
const calls: Array<{ sql: string; params: Record<string, unknown> }> = []
let answer: (sql: string, params: Record<string, unknown>) => unknown[] | Error = () => []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    const out = answer(sql, params)
    if (out instanceof Error) throw out
    return out
  }),
}))

import { NextRequest } from 'next/server'
import { validateRequest, type JWTPayload } from '@/lib/auth'
import { dbGet, dbRun } from '@/lib/sqlite'
import { POST } from '@/app/api/lookup/directory/breakdown/route'
import {
  BREAKDOWN_MAX_PARALLEL, BREAKDOWN_QUERY_SECONDS, BreakdownError, breakdownFor, breakdownSql, bucketsFromRows, createLimiter,
} from '@/lib/site-directory-breakdown'

const analyst: JWTPayload = { userId: '2', username: 'Ana', email: 'ana@example.test', role: 'analyst' }
const LIVE_ROW = { table_uuid: 'uuid-1', part_state: '202611:100:1:9', mutation_state: '', mutations_running: 0, builds_running: 0 }
const FINGERPRINT = createHash('sha1').update('uuid-1|202611:100:1:9|').digest('hex')
const split = [{ login_type: 'email', n: '563' }, { login_type: 'username', n: '397' }, { login_type: 'phone', n: '40' }]
const rowOf = (host: string) => dbGet('SELECT * FROM site_directory WHERE host = ?', [host]) as Record<string, any> | undefined
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/lookup/directory/breakdown', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
const isBreakdown = (sql: string) => sql.includes('login_type')

beforeEach(() => {
  calls.length = 0
  answer = sql => {
    if (sql.includes('system.projection_parts')) return [{ parts: 15, with_projection: 15 }]
    if (sql.includes('system.mutations')) return [LIVE_ROW]
    return split
  }
  vi.mocked(validateRequest).mockResolvedValue(analyst)
  dbRun('DELETE FROM site_directory')
  dbRun(`INSERT INTO site_directory (host, row_count) VALUES ('corp.example', 1000)`)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('breakdownSql / bucketsFromRows', () => {
  test('asks for the rows of the site and every subdomain by the reversed-domain key, grouped by login type, inside the time limit', () => {
    const { sql, params } = breakdownSql('corp.example')
    expect(params).toEqual({ host: 'corp.example' })
    expect(sql).toContain("reverse(domain) = reverse({host:String}) OR startsWith(reverse(domain), reverse(concat('.', {host:String})))")
    expect(sql).toContain('GROUP BY login_type')
    expect(sql).toContain(`max_execution_time = ${BREAKDOWN_QUERY_SECONDS}`)
    expect(sql).toContain("timeout_overflow_mode = 'throw'")
    expect(sql).toContain('http_wait_end_of_query = 1')
    expect(sql).toContain('max_projection_rows_to_use_projection_index = 200000000')
  })

  test('folds the groups into the four parts; a blank or unknown type is "other"; 64-bit numbers arrive as strings', () => {
    expect(bucketsFromRows(split)).toEqual({ email: 563, phone: 40, username: 397, other: 0 })
    expect(bucketsFromRows([{ login_type: '', n: '3' }, { login_type: 'fax', n: 2 }, { login_type: 'email', n: '5' }])).toEqual({ email: 5, phone: 0, username: 0, other: 5 })
    expect(bucketsFromRows([])).toEqual({ email: 0, phone: 0, username: 0, other: 0 })
  })
})

describe('createLimiter', () => {
  test('runs at most max at once and gives a freed slot to the next waiter in order', async () => {
    const limiter = createLimiter(2)
    const started: number[] = []
    const gates: Array<() => void> = []
    let active = 0
    let peak = 0
    const task = (id: number) => limiter(async () => {
      active += 1
      peak = Math.max(peak, active)
      started.push(id)
      await new Promise<void>(resolve => gates.push(resolve))
      active -= 1
    })
    const runs = [task(1), task(2), task(3), task(4)]
    await flush()
    expect(started).toEqual([1, 2])
    gates[0]()
    await flush()
    expect(started).toEqual([1, 2, 3])
    gates[1]()
    await flush()
    expect(started).toEqual([1, 2, 3, 4])
    gates[2]()
    gates[3]()
    await Promise.all(runs)
    expect(peak).toBe(2)
  })

  test('a task that throws still frees its slot', async () => {
    const limiter = createLimiter(1)
    await expect(limiter(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(limiter(async () => 5)).resolves.toBe(5)
  })

  test('the app runs two breakdowns at once', () => {
    expect(BREAKDOWN_MAX_PARALLEL).toBe(2)
  })
})

describe('breakdownFor', () => {
  test('returns the four parts of the site', async () => {
    expect(await breakdownFor('corp.example')).toEqual({ email: 563, phone: 40, username: 397, other: 0 })
  })
  test('says it is not available when the reversed-domain key is not on every part, and asks nothing else', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 12 }] : [])
    await expect(breakdownFor('corp.example')).rejects.toMatchObject({ kind: 'unavailable' })
    expect(calls.filter(c => isBreakdown(c.sql))).toHaveLength(0)
  })
  test('a query that ran out of time or memory is "too broad"; any other error is the caller\'s', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 15 }] : new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 20.1 seconds (TIMEOUT_EXCEEDED)'))
    await expect(breakdownFor('corp.example')).rejects.toMatchObject({ kind: 'too_broad' })
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 15 }] : new Error('connection refused'))
    await expect(breakdownFor('corp.example')).rejects.toThrow('connection refused')
    await expect(breakdownFor('corp.example')).rejects.not.toBeInstanceOf(BreakdownError)
  })
})

describe('POST /api/lookup/directory/breakdown', () => {
  test('needs a session', async () => {
    vi.mocked(validateRequest).mockResolvedValue(null)
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  test('works the split out, stores it with the fingerprint read before, and answers with the site as the list sends it', async () => {
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.site).toMatchObject({ host: 'corp.example', count: 1000, breakdown: { email: 563, phone: 40, username: 397, other: 0 } })
    expect(rowOf('corp.example')).toMatchObject({ bd_email: 563, bd_phone: 40, bd_username: 397, bd_other: 0, bd_fp: FINGERPRINT })
  })

  test('refuses a body that is not JSON, a host as typed instead of as the counts name it, and a site that is not in the directory', async () => {
    const bad = await post('{not json')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ success: false, error: 'Invalid JSON body' })
    expect((await post({ host: 'https://www.corp.example/login' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    const missing = await post({ host: 'ghost.example' })
    expect(missing.status).toBe(404)
    expect(calls.filter(c => isBreakdown(c.sql))).toHaveLength(0)
  })

  test('a site too broad for the time limit stores nothing and says so (504)', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 15 }] : sql.includes('system.mutations') ? [LIVE_ROW] : new Error('Timeout exceeded (TIMEOUT_EXCEEDED)'))
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ success: false, error: 'too broad to break down in the time allowed' })
    expect(rowOf('corp.example')!.bd_at).toBeNull()
  })

  test('without the reversed-domain key it is not available (503)', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 12 }] : sql.includes('system.mutations') ? [LIVE_ROW] : [])
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(503)
    expect((await res.json()).success).toBe(false)
  })

  test('another failure is a 500 with a sentence, and is logged', async () => {
    answer = sql => (sql.includes('system.projection_parts') ? [{ parts: 15, with_projection: 15 }] : sql.includes('system.mutations') ? [LIVE_ROW] : new Error('connection refused'))
    const res = await post({ host: 'corp.example' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Working out the split failed' })
    expect(console.error).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run it to see it fail**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-breakdown.test.ts 2>&1 | tail -6
```
Expected: FAIL, cannot resolve `@/lib/site-directory-breakdown`.

- [ ] **Step 4: Write the module**

Create `lib/site-directory-breakdown.ts`. Set `USE_PREWHERE` to what Step 1 decided (`true` for V2, `false` for V1):

```ts
/**
 * The split of a site's logins by type, e-mail / phone / user name / other (design: docs/superpowers/specs/2026-11-21-site-directory-design.md). It is a
 * query on the stored `login_type` column over the same rows as the site's count: the host and every subdomain, found by the reversed-domain key
 * (lib/site-counts.ts explains why a suffix match needs it). It is worked out when a directory row with none is opened, and again by the refresh for a
 * split that exists; it is never part of a count, because reading `login_type` made the planner read 4 to 10 times the rows (spec, "Measured").
 *
 * At most BREAKDOWN_MAX_PARALLEL run at once in the app: a closed connection does not stop a ClickHouse query, so a quick run of clicks on broad sites
 * would otherwise pile up reads of 18 GiB each.
 */
import { executeQuery } from '@/lib/clickhouse'
import { isDomainRevProjectionReady } from '@/lib/credentials-projections'
import { readLiveState } from '@/lib/search-dictionary'
import { isTooBroad } from '@/lib/site-counts'
import { getSite, siteExists, storeBreakdown } from '@/lib/site-directory'
import type { BreakdownCounts } from '@/lib/site-directory-input'
import { isMarkableHost } from '@/lib/site-marks-input'

export const BREAKDOWN_QUERY_SECONDS = 20
export const BREAKDOWN_MAX_PARALLEL = 2

/** Chosen by the measurement in the plan (Task 4, Step 1): PREWHERE when it reads at least 25% fewer rows than the plain WHERE. */
const USE_PREWHERE = false

const TOO_BROAD_MESSAGE = 'too broad to break down in the time allowed'
const UNAVAILABLE_MESSAGE = 'The split cannot be worked out right now (the index that finds subdomains is being rebuilt). Try again in a few minutes.'

export class BreakdownError extends Error {
  constructor(message: string, readonly kind: 'too_broad' | 'unavailable') {
    super(message)
    this.name = 'BreakdownError'
  }
}

export function breakdownSql(host: string): { sql: string; params: Record<string, string> } {
  const filter = `reverse(domain) = reverse({host:String}) OR startsWith(reverse(domain), reverse(concat('.', {host:String})))`
  return {
    sql: `SELECT login_type, count() AS n
FROM ulp.credentials
${USE_PREWHERE ? 'PREWHERE' : 'WHERE'} ${filter}
GROUP BY login_type
SETTINGS max_execution_time = ${BREAKDOWN_QUERY_SECONDS}, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, max_projection_rows_to_use_projection_index = 200000000`,
    params: { host },
  }
}

/** 64-bit integers come back from ClickHouse's JSON as strings. A blank or unknown type is "other", so the four parts always add up to the site's rows. */
export function bucketsFromRows(rows: unknown[]): BreakdownCounts {
  const counts: BreakdownCounts = { email: 0, phone: 0, username: 0, other: 0 }
  for (const raw of rows as Array<{ login_type: string; n: string | number }>) {
    const key = raw.login_type === 'email' || raw.login_type === 'phone' || raw.login_type === 'username' ? raw.login_type : 'other'
    counts[key] += Number(raw.n)
  }
  return counts
}

/** At most `max` tasks at once; a freed slot is handed straight to the first waiter, so the count never exceeds `max` for an instant. */
export function createLimiter(max: number) {
  let active = 0
  const waiters: Array<() => void> = []
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < max) active += 1
    else await new Promise<void>(resolve => waiters.push(resolve)) // the slot is handed over: `active` stays as it is
    try {
      return await task()
    } finally {
      const next = waiters.shift()
      if (next) next()
      else active -= 1
    }
  }
}

const limiter = createLimiter(BREAKDOWN_MAX_PARALLEL)

/** The split of one site. Throws BreakdownError('unavailable') without the reversed-domain key on every part, BreakdownError('too_broad') past the time limit. */
export function breakdownFor(host: string): Promise<BreakdownCounts> {
  return limiter(async () => {
    if (!(await isDomainRevProjectionReady(sql => executeQuery(sql)))) throw new BreakdownError(UNAVAILABLE_MESSAGE, 'unavailable')
    const { sql, params } = breakdownSql(host)
    try {
      return bucketsFromRows(await executeQuery(sql, params))
    } catch (err) {
      if (isTooBroad(err)) throw new BreakdownError(TOO_BROAD_MESSAGE, 'too_broad')
      throw err
    }
  })
}

/** For the refresh: works the split out and stores it against the fingerprint the refresh is running at. */
export async function breakdownAndStore(host: string, fingerprint: string | null): Promise<void> {
  storeBreakdown(host, await breakdownFor(host), fingerprint)
}

export interface BreakdownReply {
  status: number
  json: Record<string, unknown>
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** POST /api/lookup/directory/breakdown: `{ host }` of a site that is in the directory; answers with the site as the list sends it. */
export async function answerBreakdown(rawBody: unknown): Promise<BreakdownReply> {
  const host = isObject(rawBody) && typeof rawBody.host === 'string' ? rawBody.host : ''
  if (!isMarkableHost(host)) {
    return { status: 400, json: { success: false, error: '"host" must be a site as the counts name it, for example corp.example (no scheme, path, port or www.)' } }
  }
  if (!siteExists(host)) return { status: 404, json: { success: false, error: 'That site is not in the directory' } }
  try {
    // Read BEFORE working the split out: rows that arrive meanwhile leave it out of date for the next refresh.
    const fingerprint = (await readLiveState())?.fingerprint ?? null
    await breakdownAndStore(host, fingerprint)
    return { status: 200, json: { success: true, site: getSite(host) } }
  } catch (error) {
    if (error instanceof BreakdownError) {
      return { status: error.kind === 'too_broad' ? 504 : 503, json: { success: false, error: error.message } }
    }
    console.error('site directory breakdown error:', error)
    return { status: 500, json: { success: false, error: 'Working out the split failed' } }
  }
}
```

Create `app/api/lookup/directory/breakdown/route.ts`:

```ts
/**
 * Internal Site Directory breakdown API
 * POST /api/lookup/directory/breakdown   body { host }  -> { success, site }   the site as the list sends it, with its split
 *
 * Works out how the logins of one site (its host and every subdomain) split into e-mail, phone, user name and other, stores it, and answers. Called when a
 * directory row with no split is opened. Session-authenticated, any signed-in user; at most two run at once in the app. The query, the limits and the
 * answers are in lib/site-directory-breakdown.ts.
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { answerBreakdown } from "@/lib/site-directory-breakdown"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const reply = await answerBreakdown(body)
  return NextResponse.json(reply.json, { status: reply.status })
}
```

- [ ] **Step 5: Run the test, the types and the lint**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-breakdown.test.ts 2>&1 | tail -6 && npx tsc --noEmit 2>&1 | tail -3 && npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .ts,.tsx lib app/api/lookup/directory 2>&1 | tail -5
```
Expected: all pass; nothing printed by `tsc` and eslint.

- [ ] **Step 6: Write the live parity test**

Create `__tests__/site-directory.live.test.ts`:

```ts
import { execSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

/**
 * LIVE check of the Site Directory's breakdown (lib/site-directory-breakdown.ts) against the real ulp.credentials (the running ulpsuite_clickhouse
 * container); design: docs/superpowers/specs/2026-11-21-site-directory-design.md. READ-ONLY. Skipped unless BLK_LIVE=1:
 *
 *   BLK_LIVE=1 npx vitest run __tests__/site-directory.live.test.ts
 *
 * It needs no values of yours and prints none, only labels, counts and timings. It samples real hosts from the table and checks, for each:
 *   1. PARITY: the split equals what ONE full scan (no projection, no index, `domain = host OR endsWith(domain, '.host')`) gives, worked out in plain code;
 *   2. the four parts add up to the site's count from the counting query (so the split and the count mean the same rows);
 *   3. the query finishes inside its time limit.
 * and that a site with no rows splits into four zeros.
 */
const LIVE = process.env.BLK_LIVE === '1'

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

const SAMPLE = 'SETTINGS max_execution_time = 120'
// No backslashes in the pattern: it goes through a template literal and a ClickHouse string literal.
const HOST = `^[a-z0-9-]+([.][a-z0-9-]+)+$`

/** Hosts by how they are stored: some sampled from recent rows, and the site that contains one of them (it has at least that subdomain). */
async function sampleHosts(): Promise<string[]> {
  const { executeQuery } = await import('@/lib/clickhouse')
  const stored = (await executeQuery(
    `SELECT domain FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND NOT startsWith(domain, 'www.') AND match(domain, '${HOST}')
     GROUP BY domain ORDER BY rand() LIMIT 120 ${SAMPLE}`, {}) as Array<{ domain: string }>).map(r => r.domain)
  const parents = Array.from(new Set(stored.slice(3, 40).map(d => d.split('.').slice(1).join('.')).filter(p => p.includes('.')))).slice(0, 2)
  return [...stored.slice(0, 3), ...parents]
}

/** One full scan with nothing to help it: the split of every listed host, from the rows of every stored domain that is the host or ends with `.host`. */
async function scanSplits(hosts: string[]): Promise<Map<string, { email: number; phone: number; username: number; other: number }>> {
  const { executeQuery } = await import('@/lib/clickhouse')
  const params: Record<string, string> = {}
  const terms: string[] = []
  hosts.forEach((h, i) => {
    params[`h${i}`] = h
    params[`s${i}`] = `.${h}`
    terms.push(`domain = {h${i}:String} OR endsWith(domain, {s${i}:String})`)
  })
  const rows = await executeQuery(
    `SELECT domain, login_type, count() AS n FROM ulp.credentials WHERE (${terms.join(' OR ')}) GROUP BY domain, login_type
     SETTINGS max_execution_time = 280, optimize_use_projections = 0, optimize_use_projection_filtering = 0, use_skip_indexes = 0`, params) as Array<{ domain: string; login_type: string; n: string }>
  const out = new Map<string, { email: number; phone: number; username: number; other: number }>()
  for (const host of hosts) {
    const split = { email: 0, phone: 0, username: 0, other: 0 }
    for (const r of rows) {
      if (r.domain !== host && !r.domain.endsWith(`.${host}`)) continue
      const key = r.login_type === 'email' || r.login_type === 'phone' || r.login_type === 'username' ? r.login_type : 'other'
      split[key] += Number(r.n)
    }
    out.set(host, split)
  }
  return out
}

describe.skipIf(!LIVE)('the Site Directory breakdown on the live table', () => {
  test('PARITY: the split equals a plain full scan, adds up to the site\'s count, and finishes inside the time limit', async () => {
    const { breakdownFor, BREAKDOWN_QUERY_SECONDS } = await import('@/lib/site-directory-breakdown')
    const { countSites } = await import('@/lib/site-counts')
    const hosts = await sampleHosts()
    expect(hosts.length).toBeGreaterThanOrEqual(3)
    const expected = await scanSplits(hosts)
    for (const [i, host] of hosts.entries()) {
      const t = Date.now()
      const split = await breakdownFor(host)
      const ms = Date.now() - t
      const counted = (await countSites([host], { lower: null, upper: null })).results[host]
      const total = split.email + split.phone + split.username + split.other
      console.warn(`  site ${i + 1}/${hosts.length}: ${total.toLocaleString()} rows, ${ms} ms, e-mail ${split.email} phone ${split.phone} user name ${split.username} other ${split.other}`)
      expect(split, `site ${i + 1}: the split equals the full scan`).toEqual(expected.get(host))
      expect(total, `site ${i + 1}: the parts add up to the count`).toBe(counted.count)
      expect(ms, `site ${i + 1}: inside the time limit`).toBeLessThan(BREAKDOWN_QUERY_SECONDS * 1000)
    }
  }, 600_000)

  test('a site with no rows splits into four zeros', async () => {
    const { breakdownFor } = await import('@/lib/site-directory-breakdown')
    expect(await breakdownFor(`zz-absent-${Date.now()}.no-such-host.invalid`)).toEqual({ email: 0, phone: 0, username: 0, other: 0 })
  })
})
```

- [ ] **Step 7: Run the live test (read-only, about 5 minutes) and note the timings**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && BLK_LIVE=1 npx vitest run __tests__/site-directory.live.test.ts 2>&1 | tail -20
```
Expected: 2 tests pass; the `console.warn` lines show rows and milliseconds per sampled site (no host names). If PARITY fails, the SQL (or `USE_PREWHERE`) is wrong: fix it, never the oracle.

- [ ] **Step 8: Record the measurement in the spec**

In `docs/superpowers/specs/2026-11-21-site-directory-design.md`, under "**Not understood, and the first task of the plan:**" replace that paragraph with:

```markdown
**Settled by the build (2026-11-21):** the single-site query is `SELECT login_type, count() ... GROUP BY login_type` over the same reversed-domain ranges (V1) / with the ranges in `PREWHERE` (V2). Measured on the live table, 6 sites from 145 rows to 125 M, 12 runs each: <paste the three lines of Step 1 here: variant, average ms, average rows read>. Shipped: <V1 or V2>, by the rule "PREWHERE if it reads at least 25% fewer rows". Parity (`BLK_LIVE=1 npx vitest run __tests__/site-directory.live.test.ts`): <N> sites, the split equals a plain full scan and the four parts add up to the count. Why reading `login_type` makes the planner read more rows than the plain count is still not understood.
```
Fill the angle-bracket parts from the real output of Step 1 and Step 7 (they are numbers and a variant name, never hosts).

- [ ] **Step 9: Commit**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && git add lib/site-directory-breakdown.ts app/api/lookup/directory/breakdown/route.ts __tests__/site-directory-breakdown.test.ts __tests__/site-directory.live.test.ts docs/superpowers/specs/2026-11-21-site-directory-design.md && git commit -q -m "$(cat <<'EOF'
feat(site-directory): the split of a site's logins by type, two at a time, with a live parity test against a plain full scan

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

---

### Task 5: The refresh: a tick that recounts what the table has outgrown

**Files:**
- Create: `lib/site-directory-cron.ts`, `app/api/lookup/directory/status/route.ts`
- Modify: `instrumentation.ts`, `docker-compose.yml`, `docker-compose.rehearsal.yml`, `.env.example`, `README.md`
- Test: `__tests__/site-directory-cron.test.ts`

**Interfaces:**
- Consumes: `staleCount`, `outOfDateHosts`, `breakdownTargets`, `storeCounts`, `touchBreakdown`, `directoryTotal`, `seedFromMarks` (Tasks 1 and 3), `breakdownAndStore` (Task 4), `countSites` (`lib/site-counts.ts`: `(originals: string[], range: ImportedRange) => Promise<{ results: Record<string, SiteCount>; subdomains_counted: boolean }>`), `readLiveState`, `queueSize` (`lib/upload-queue.ts`), `refreshState`.
- Produces: `siteDirectoryCronMinutes(env?)`, `siteDirectorySettleSeconds(env?)`, `runSiteDirectoryTick(overrides?): Promise<TickOutcome>`, `type TickDeps`, `resetCronState()`, `startSiteDirectoryCron()`, `answerDirectoryStatus(overrides?)`, `GET /api/lookup/directory/status` -> `{ success, total, out_of_date, state, refreshed_at }`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/site-directory-cron.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(async () => []), getClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn() }))

import { NextRequest } from 'next/server'
import { validateRequest, type JWTPayload } from '@/lib/auth'
import { GET as statusRoute } from '@/app/api/lookup/directory/status/route'
import {
  answerDirectoryStatus, resetCronState, runSiteDirectoryTick, siteDirectoryCronMinutes, siteDirectorySettleSeconds, startSiteDirectoryCron, type TickDeps,
} from '@/lib/site-directory-cron'
import { refreshState } from '@/lib/site-directory-state'
import type { LiveState } from '@/lib/search-dictionary'
import type { SiteCount } from '@/lib/site-counts-input'

const live = (over: Partial<LiveState> = {}): LiveState => ({ fingerprint: 'fp-a', mutationsRunning: 0, buildsRunning: 0, ...over })
const counted = (host: string): SiteCount => ({ host, found: true, count: 5, host_count: 5, subdomain_count: 0, subdomains: 0, top_subdomains: [] })

type Mocked = { [K in keyof TickDeps]: TickDeps[K] & ReturnType<typeof vi.fn> }

function deps(over: Partial<TickDeps> = {}): Mocked {
  const batches = [['a.example', 'b.example']]
  return {
    seed: vi.fn(() => 0),
    live: vi.fn(async () => live()),
    importing: vi.fn(() => false),
    sleep: vi.fn(async (_ms: number) => {}),
    now: vi.fn(() => 1_000_000),
    stale: vi.fn(() => 2),
    outOfDate: vi.fn(() => batches.shift() ?? []),
    count: vi.fn(async (hosts: string[]) => ({ results: Object.fromEntries(hosts.map(h => [h, counted(h)])), subdomains_counted: true })),
    store: vi.fn(),
    breakdownTargets: vi.fn(() => []),
    breakdown: vi.fn(async () => {}),
    touchBreakdown: vi.fn(),
    ...over,
  } as unknown as Mocked
}

beforeEach(() => {
  resetCronState()
  refreshState.running = false
  refreshState.lastRefreshedAt = null
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('the settings', () => {
  test('defaults: a tick every 10 minutes, 120 seconds of quiet', () => {
    expect(siteDirectoryCronMinutes({})).toBe(10)
    expect(siteDirectorySettleSeconds({})).toBe(120)
  })
  test('read from the environment; an empty or bad value is the default, 0 is allowed', () => {
    expect(siteDirectoryCronMinutes({ SITE_DIRECTORY_CRON_MINUTES: '0' })).toBe(0)
    expect(siteDirectoryCronMinutes({ SITE_DIRECTORY_CRON_MINUTES: '' })).toBe(10)
    expect(siteDirectorySettleSeconds({ SITE_DIRECTORY_SETTLE_SECONDS: '5' })).toBe(5)
    expect(siteDirectorySettleSeconds({ SITE_DIRECTORY_SETTLE_SECONDS: 'soon' })).toBe(120)
  })
})

describe('runSiteDirectoryTick', () => {
  test('switched off: nothing is read', async () => {
    vi.stubEnv('SITE_DIRECTORY_CRON_MINUTES', '0')
    const d = deps()
    expect(await runSiteDirectoryTick(d)).toBe('disabled')
    expect(d.live).not.toHaveBeenCalled()
  })

  test('the table cannot be read: nothing is done', async () => {
    const d = deps({ live: vi.fn(async () => null) })
    expect(await runSiteDirectoryTick(d)).toBe('unknown')
    expect(d.count).not.toHaveBeenCalled()
  })

  test('nothing out of date: one read and done, no waiting', async () => {
    const d = deps({ stale: vi.fn(() => 0) })
    expect(await runSiteDirectoryTick(d)).toBe('fresh')
    expect(d.sleep).not.toHaveBeenCalled()
    expect(d.count).not.toHaveBeenCalled()
  })

  test('seeds the marked sites before it looks', async () => {
    const d = deps({ stale: vi.fn(() => 0) })
    await runSiteDirectoryTick(d)
    expect(d.seed).toHaveBeenCalledTimes(1)
  })

  test('an import queued or running: it waits for the next tick without sleeping', async () => {
    const d = deps({ importing: vi.fn(() => true) })
    expect(await runSiteDirectoryTick(d)).toBe('importing')
    expect(d.sleep).not.toHaveBeenCalled()
    expect(d.count).not.toHaveBeenCalled()
  })

  test('a content mutation running: waits', async () => {
    const d = deps({ live: vi.fn(async () => live({ mutationsRunning: 1 })) })
    expect(await runSiteDirectoryTick(d)).toBe('mutating')
    expect(d.count).not.toHaveBeenCalled()
  })

  test('the fingerprint moved while it waited (a big file commits minutes apart): it does not count against a table in motion', async () => {
    const reads = [live(), live({ fingerprint: 'fp-b' })]
    const d = deps({ live: vi.fn(async () => reads.shift() ?? null) })
    expect(await runSiteDirectoryTick(d)).toBe('settling')
    expect(d.sleep).toHaveBeenCalledWith(120_000)
    expect(d.count).not.toHaveBeenCalled()
  })

  test('an import claimed while it waited stops it', async () => {
    const importing = [false, true]
    const d = deps({ importing: vi.fn(() => importing.shift() ?? true) })
    expect(await runSiteDirectoryTick(d)).toBe('importing')
    expect(d.count).not.toHaveBeenCalled()
  })

  test('the settle time is configurable', async () => {
    vi.stubEnv('SITE_DIRECTORY_SETTLE_SECONDS', '5')
    const d = deps()
    await runSiteDirectoryTick(d)
    expect(d.sleep).toHaveBeenCalledWith(5_000)
  })

  test('quiet and out of date: recounts the out-of-date sites, 100 at a time, and stores them against the fingerprint read after the wait', async () => {
    const reads = [live(), live()]
    const d = deps({ live: vi.fn(async () => reads.shift() ?? null) })
    expect(await runSiteDirectoryTick(d)).toBe('refreshed')
    expect(d.outOfDate).toHaveBeenCalledWith('fp-a', 100)
    expect(d.count).toHaveBeenCalledWith(['a.example', 'b.example'])
    expect(d.store).toHaveBeenCalledWith({ 'a.example': counted('a.example'), 'b.example': counted('b.example') }, 'fp-a')
    expect(refreshState.lastRefreshedAt).toEqual(expect.any(String))
    expect(refreshState.running).toBe(false)
  })

  test('carries on in batches until nothing is out of date', async () => {
    const batches = [['a.example'], ['b.example'], []]
    const d = deps({ outOfDate: vi.fn(() => batches.shift() ?? []) })
    expect(await runSiteDirectoryTick(d)).toBe('refreshed')
    expect(d.count).toHaveBeenCalledTimes(2)
  })

  test('an import that starts in the middle stops it at once and leaves the rest for the next tick', async () => {
    const importing = [false, false, false, true]
    const batches = [['a.example'], ['b.example']]
    const d = deps({ importing: vi.fn(() => importing.shift() ?? true), outOfDate: vi.fn(() => batches.shift() ?? []) })
    expect(await runSiteDirectoryTick(d)).toBe('importing')
    expect(d.count).toHaveBeenCalledTimes(1)
    expect(refreshState.running).toBe(false)
  })

  test('the same sites again and again (nothing could be stored for them) end the loop instead of spinning', async () => {
    const d = deps({ outOfDate: vi.fn(() => ['a.example']) })
    expect(await runSiteDirectoryTick(d)).toBe('refreshed')
    expect(d.count).toHaveBeenCalledTimes(1)
  })

  test('only the hosts are counted right now (the index is being rebuilt): nothing is stored and the tick says so', async () => {
    const d = deps({ count: vi.fn(async (hosts: string[]) => ({ results: Object.fromEntries(hosts.map(h => [h, counted(h)])), subdomains_counted: false })) })
    expect(await runSiteDirectoryTick(d)).toBe('no-projection')
    expect(d.store).not.toHaveBeenCalled()
  })

  test('a split that exists is worked out again for the out-of-date sites; failures are kept from retrying until the table changes', async () => {
    const targets = ['a.example', 'b.example']
    const d = deps({
      breakdownTargets: vi.fn(() => targets),
      breakdown: vi.fn(async (host: string) => { if (host === 'b.example') throw new Error('too broad') }),
    })
    expect(await runSiteDirectoryTick(d)).toBe('refreshed')
    expect(d.breakdown).toHaveBeenCalledWith('a.example', 'fp-a')
    expect(d.breakdown).toHaveBeenCalledWith('b.example', 'fp-a')
    expect(d.touchBreakdown).toHaveBeenCalledTimes(1)
    expect(d.touchBreakdown).toHaveBeenCalledWith('b.example', 'fp-a')
  })

  test('an import that starts during the splits stops them', async () => {
    // pre-wait, post-wait, the one batch, the empty batch that ends the loop; the fifth look (before the first split) sees the import
    const importing = [false, false, false, false, true]
    const d = deps({ importing: vi.fn(() => importing.shift() ?? true), breakdownTargets: vi.fn(() => ['a.example', 'b.example']) })
    expect(await runSiteDirectoryTick(d)).toBe('importing')
    expect(d.breakdown).not.toHaveBeenCalled()
  })

  test('a failure is logged and counted; three in a row wait an hour', async () => {
    const boom = deps({ count: vi.fn(async () => { throw new Error('connection refused') }) })
    expect(await runSiteDirectoryTick(boom)).toBe('failed')
    expect(console.error).toHaveBeenCalled()
    expect(refreshState.running).toBe(false)
    await runSiteDirectoryTick(deps({ count: boom.count, outOfDate: vi.fn(() => ['a.example']) }))
    await runSiteDirectoryTick(deps({ count: boom.count, outOfDate: vi.fn(() => ['a.example']) }))
    const later = deps({ now: vi.fn(() => 1_000_000 + 60_000) })
    expect(await runSiteDirectoryTick(later)).toBe('backoff')
    expect(later.count).not.toHaveBeenCalled()
    const muchLater = deps({ now: vi.fn(() => 1_000_000 + 3_600_001) })
    expect(await runSiteDirectoryTick(muchLater)).toBe('refreshed')
  })
})

describe('startSiteDirectoryCron', () => {
  test('does not start when switched off', () => {
    vi.stubEnv('SITE_DIRECTORY_CRON_MINUTES', '0')
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setInterval')
    startSiteDirectoryCron()
    expect(spy).not.toHaveBeenCalled()
  })
  test('starts once: a first tick soon, then one every interval', () => {
    vi.stubEnv('SITE_DIRECTORY_CRON_MINUTES', '10')
    vi.useFakeTimers()
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const interval = vi.spyOn(globalThis, 'setInterval')
    startSiteDirectoryCron()
    startSiteDirectoryCron()
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 120_000)
    expect(interval).toHaveBeenCalledTimes(1)
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 600_000)
  })
})

describe('answerDirectoryStatus and its route', () => {
  const analyst: JWTPayload = { userId: '2', username: 'Ana', email: 'ana@example.test', role: 'analyst' }
  const status = (over: Parameters<typeof answerDirectoryStatus>[0] = {}) =>
    answerDirectoryStatus({ live: async () => live(), stale: () => 0, total: () => 12, ...over })

  test('current: nothing is out of date', async () => {
    expect(await status()).toEqual({ status: 200, json: { success: true, total: 12, out_of_date: 0, state: 'current', refreshed_at: null } })
  })
  test('waiting: something is out of date and nothing is running', async () => {
    expect((await status({ stale: () => 4 })).json).toMatchObject({ out_of_date: 4, state: 'waiting' })
  })
  test('refreshing: the tick is running, and the time of the last finished refresh is told', async () => {
    refreshState.running = true
    refreshState.lastRefreshedAt = '2026-11-21T10:00:00.000Z'
    expect((await status({ stale: () => 4 })).json).toMatchObject({ out_of_date: 4, state: 'refreshing', refreshed_at: '2026-11-21T10:00:00.000Z' })
  })
  test('the table cannot be read: it still answers, with nothing counted as out of date', async () => {
    expect((await status({ live: async () => null })).json).toMatchObject({ out_of_date: 0, state: 'current' })
  })
  test('the route needs a session', async () => {
    vi.mocked(validateRequest).mockResolvedValue(null)
    const res = await statusRoute(new NextRequest('http://localhost/api/lookup/directory/status'))
    expect(res.status).toBe(401)
    vi.mocked(validateRequest).mockResolvedValue(analyst)
    const ok = await statusRoute(new NextRequest('http://localhost/api/lookup/directory/status'))
    expect(ok.status).toBe(200)
    expect((await ok.json()).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-cron.test.ts 2>&1 | tail -6
```
Expected: FAIL, cannot resolve `@/lib/site-directory-cron`.

- [ ] **Step 3: Write the tick**

Create `lib/site-directory-cron.ts`:

```ts
/**
 * Keeps the Site Directory current (design: docs/superpowers/specs/2026-11-21-site-directory-design.md, "Staying current"). The signal is the one the
 * search dictionary already uses: the fingerprint of the live table (lib/search-dictionary.ts, readLiveState), which changes on an import, a delete, a
 * dedup or a partition swap and not on a merge. A site is out of date when the fingerprint stored with its numbers is not the present one, or when it was
 * never counted all-time.
 *
 * One tick every SITE_DIRECTORY_CRON_MINUTES (default 10; 0 disables). With nothing out of date a tick costs one SQLite query and one metadata query.
 * Otherwise, like the dictionary's tick: it waits while an import is queued or running (the shared upload queue) or a content mutation runs, reads the
 * fingerprint, waits SITE_DIRECTORY_SETTLE_SECONDS (default 120) and reads it again, so a big file whose commits are minutes apart is never counted against
 * (a quiet moment inside a batch would be out of date on arrival). Then it recounts the out-of-date sites, biggest first, 100 at a time through
 * countSites (so the chunks of 20, the time limit and the too-broad fallback are those of the counts), storing each answer against the fingerprint read
 * after the wait, and works out again the splits that exist. It stops at once when an import starts. Failures back off: three in a row wait an hour.
 *
 * Production only (instrumentation.ts). A tick never overlaps the previous one.
 */
import { readLiveState, type LiveState } from '@/lib/search-dictionary'
import { countSites } from '@/lib/site-counts'
import type { SiteCount } from '@/lib/site-counts-input'
import {
  breakdownTargets, directoryTotal, outOfDateHosts, seedFromMarks, staleCount, storeCounts, touchBreakdown,
} from '@/lib/site-directory'
import { breakdownAndStore } from '@/lib/site-directory-breakdown'
import { refreshState } from '@/lib/site-directory-state'
import { queueSize } from '@/lib/upload-queue'

type Env = Record<string, string | undefined>

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export const siteDirectoryCronMinutes = (env: Env = process.env): number => envInt(env.SITE_DIRECTORY_CRON_MINUTES, 10)
export const siteDirectorySettleSeconds = (env: Env = process.env): number => envInt(env.SITE_DIRECTORY_SETTLE_SECONDS, 120)

export type TickOutcome = 'disabled' | 'fresh' | 'unknown' | 'importing' | 'mutating' | 'settling' | 'no-projection' | 'backoff' | 'refreshed' | 'failed'

export interface TickDeps {
  seed: () => number
  live: () => Promise<LiveState | null>
  /** True while an import (an inbox file or an upload) is queued or running. */
  importing: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Sites whose count or split is out of date against this fingerprint. */
  stale: (fingerprint: string) => number
  outOfDate: (fingerprint: string, limit: number) => string[]
  count: (hosts: string[]) => Promise<{ results: Record<string, SiteCount>; subdomains_counted: boolean }>
  store: (results: Record<string, SiteCount>, fingerprint: string) => void
  breakdownTargets: (fingerprint: string, limit: number) => string[]
  breakdown: (host: string, fingerprint: string) => Promise<void>
  touchBreakdown: (host: string, fingerprint: string) => void
}

const BATCH = 100
const MAX_BATCHES = 200
const TICK_BUDGET_MS = 10 * 60_000
const MAX_BREAKDOWNS = 50
const BACKOFF_AFTER_FAILURES = 3
const BACKOFF_MS = 3_600_000
const FIRST_TICK_MS = 120_000

let failures = 0
let lastFailureAt = 0
let started = false

export function resetCronState(): void {
  failures = 0
  lastFailureAt = 0
  started = false
}

const defaultDeps = (): TickDeps => ({
  seed: seedFromMarks,
  live: () => readLiveState(),
  importing: () => queueSize() > 0,
  sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
  now: Date.now,
  stale: staleCount,
  outOfDate: outOfDateHosts,
  count: hosts => countSites(hosts, { lower: null, upper: null }),
  store: storeCounts,
  breakdownTargets,
  breakdown: (host, fingerprint) => breakdownAndStore(host, fingerprint),
  touchBreakdown,
})

export async function runSiteDirectoryTick(overrides: Partial<TickDeps> = {}): Promise<TickOutcome> {
  if (siteDirectoryCronMinutes() <= 0) return 'disabled'
  const d: TickDeps = { ...defaultDeps(), ...overrides }

  d.seed()
  const first = await d.live()
  if (!first) return 'unknown'
  if (d.stale(first.fingerprint) === 0) return 'fresh'
  if (failures >= BACKOFF_AFTER_FAILURES && d.now() - lastFailureAt < BACKOFF_MS) return 'backoff'
  if (d.importing()) return 'importing'
  if (first.mutationsRunning > 0) return 'mutating'
  await d.sleep(siteDirectorySettleSeconds() * 1000)
  const second = await d.live()
  if (!second) return 'unknown'
  if (second.fingerprint !== first.fingerprint) return 'settling'
  if (second.mutationsRunning > 0) return 'mutating'
  if (d.importing()) return 'importing' // a file was claimed while the tick waited
  return refresh(d, second.fingerprint)
}

async function refresh(d: TickDeps, fingerprint: string): Promise<TickOutcome> {
  refreshState.running = true
  try {
    const startedAt = d.now()
    let previous = ''
    for (let batch = 0; batch < MAX_BATCHES && d.now() - startedAt <= TICK_BUDGET_MS; batch++) {
      if (d.importing()) return 'importing'
      const hosts = d.outOfDate(fingerprint, BATCH)
      if (hosts.length === 0) break
      const key = hosts.join(',')
      if (key === previous) break // nothing could be stored for them: do not spin
      previous = key
      const { results, subdomains_counted } = await d.count(hosts)
      if (!subdomains_counted) return 'no-projection' // hosts only: storing it would put a smaller number in every row
      d.store(results, fingerprint)
    }
    for (const host of d.breakdownTargets(fingerprint, MAX_BREAKDOWNS)) {
      if (d.importing()) return 'importing'
      try {
        await d.breakdown(host, fingerprint)
      } catch {
        d.touchBreakdown(host, fingerprint) // keeps its numbers; tried again when the table changes
      }
    }
    failures = 0
    refreshState.lastRefreshedAt = new Date(d.now()).toISOString()
    console.warn(`[site-directory] tick refreshed the directory (fingerprint ${fingerprint.slice(0, 12)})`)
    return 'refreshed'
  } catch (err) {
    failures += 1
    lastFailureAt = d.now()
    console.error('[site-directory] refresh failed:', err)
    return 'failed'
  } finally {
    refreshState.running = false
  }
}

export function startSiteDirectoryCron(): void {
  if (started) return
  const minutes = siteDirectoryCronMinutes()
  if (minutes <= 0) {
    console.log('[site-directory] cron disabled (SITE_DIRECTORY_CRON_MINUTES=0)')
    return
  }
  started = true
  const everyMs = minutes * 60_000
  const firstMs = Math.min(FIRST_TICK_MS, everyMs)
  let running = false
  const tick = () => {
    if (running) return
    running = true
    runSiteDirectoryTick()
      .catch(err => console.error('[site-directory] tick failed:', err))
      .finally(() => { running = false })
  }
  console.warn(`[site-directory] cron started — first tick in ${Math.round(firstMs / 1000)}s, then every ${minutes}m`)
  setTimeout(tick, firstMs)
  setInterval(tick, everyMs)
}

export interface StatusDeps {
  live: () => Promise<LiveState | null>
  stale: (fingerprint: string) => number
  total: () => number
}

/** GET /api/lookup/directory/status: how many sites are out of date and what the refresh is doing, for the line above the list. */
export async function answerDirectoryStatus(overrides: Partial<StatusDeps> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const d: StatusDeps = { live: () => readLiveState(), stale: staleCount, total: directoryTotal, ...overrides }
  try {
    const live = await d.live()
    const outOfDate = live ? d.stale(live.fingerprint) : 0
    const state = refreshState.running ? 'refreshing' : outOfDate > 0 ? 'waiting' : 'current'
    return { status: 200, json: { success: true, total: d.total(), out_of_date: outOfDate, state, refreshed_at: refreshState.lastRefreshedAt } }
  } catch (error) {
    console.error('site directory status error:', error)
    return { status: 500, json: { success: false, error: 'Reading the status failed' } }
  }
}
```

Create `app/api/lookup/directory/status/route.ts`:

```ts
/**
 * Internal Site Directory status API
 * GET /api/lookup/directory/status -> { success, total, out_of_date, state: 'current' | 'waiting' | 'refreshing', refreshed_at }
 *
 * What the line above the directory list says: how many sites the last import has outgrown and whether the refresh (lib/site-directory-cron.ts) is
 * running. Session-authenticated, any signed-in user.
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { answerDirectoryStatus } from "@/lib/site-directory-cron"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const reply = await answerDirectoryStatus()
  return NextResponse.json(reply.json, { status: reply.status })
}
```

- [ ] **Step 4: Run the test, the types and the lint**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-cron.test.ts 2>&1 | tail -8 && npx tsc --noEmit 2>&1 | tail -3 && npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .ts,.tsx lib app/api/lookup/directory 2>&1 | tail -5
```
Expected: all pass; no output from `tsc` and eslint. In the back-off test the third failing tick is made with `outOfDate` returning one host so `count` runs and throws.

- [ ] **Step 5: Start the tick in production**

In `instrumentation.ts`, directly after

```ts
        console.error('[instrumentation] Search-dictionary cron failed to start:', err)
      }
```
add:

```ts

      // Site Directory: recounts the sites the table has outgrown once no import is running and the data has been quiet (settle wait, mutation check and
      // backoff inside). See lib/site-directory-cron.ts.
      try {
        const { startSiteDirectoryCron } = await import('./lib/site-directory-cron')
        startSiteDirectoryCron()
      } catch (err) {
        console.error('[instrumentation] Site-directory cron failed to start:', err)
      }
```

- [ ] **Step 6: Forward the two settings**

In `docker-compose.yml`, directly after the line `      SEARCH_DICT_SETTLE_SECONDS: ${SEARCH_DICT_SETTLE_SECONDS:-}` add:

```yaml
      # Site Directory refresh (lib/site-directory-cron.ts) -- optional; forwarded explicitly (see above). Empty values use the defaults in code:
      # a tick every 10 minutes (0 switches the refresh off), 120 s of quiet after the last import before it recounts.
      SITE_DIRECTORY_CRON_MINUTES: ${SITE_DIRECTORY_CRON_MINUTES:-}
      SITE_DIRECTORY_SETTLE_SECONDS: ${SITE_DIRECTORY_SETTLE_SECONDS:-}
```
In `docker-compose.rehearsal.yml`, directly after the line `      SEARCH_DICT_SETTLE_SECONDS: "5"` add:

```yaml
      # lib/site-directory-cron.ts: a tick a minute and 5 s of quiet, so that scripts/e2e-batch-lookup.ts can watch the Site Directory refresh itself.
      SITE_DIRECTORY_CRON_MINUTES: "1"
      SITE_DIRECTORY_SETTLE_SECONDS: "5"
```
In `.env.example`, directly after the line `# SEARCH_DICT_SETTLE_SECONDS=120` add:

```bash

# ─── Site Directory refresh ─────────────────────────────────────────────────────
# The Site Directory (page /directory) keeps the numbers of every site that was counted. After an import, a delete or a dedup it recounts the sites the
# table has outgrown, once no import is queued or running and the data has been quiet. SITE_DIRECTORY_CRON_MINUTES is the time between ticks (0 stops
# the refresh; the page then keeps the numbers of the last count). SITE_DIRECTORY_SETTLE_SECONDS is how long the data must stay unchanged first.
# SITE_DIRECTORY_CRON_MINUTES=10
# SITE_DIRECTORY_SETTLE_SECONDS=120
```
In `README.md`, directly after the paragraph that ends `- The tables are derived data: ... dropping them is always safe.` (the last bullet of "### Domain search dictionary (speed)"), add a blank line and:

```markdown
### Site directory refresh

The Site Directory (`/directory`) keeps every site that was counted on Site Counts, with the numbers of its last all-time count. The numbers stay current by themselves: a tick every `SITE_DIRECTORY_CRON_MINUTES` (default 10; 0 switches the refresh off) compares the live table's fingerprint (the one the search dictionary uses: it changes on an import, a delete or a dedup, not on a merge) with the one stored with each site, and when the table has changed it recounts the sites that are out of date, biggest first, once no import is queued or running and the data has been unchanged for `SITE_DIRECTORY_SETTLE_SECONDS` (default 120). It also works out again the splits (e-mail / phone / user name / other) that exist. A directory of 1,000 sites takes about 22 s of reads after a settled batch. The line above the list says what it is doing.
```

- [ ] **Step 7: Run the whole suite for what this task touches, then commit**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-cron.test.ts __tests__/site-directory.test.ts __tests__/site-directory-routes.test.ts 2>&1 | tail -5 && git add lib/site-directory-cron.ts app/api/lookup/directory/status/route.ts instrumentation.ts docker-compose.yml docker-compose.rehearsal.yml .env.example README.md __tests__/site-directory-cron.test.ts && git commit -q -m "$(cat <<'EOF'
feat(site-directory): the directory refreshes itself after an ingest, on the live-table fingerprint, once imports are idle and the data has settled

Two new settings, SITE_DIRECTORY_CRON_MINUTES and SITE_DIRECTORY_SETTLE_SECONDS,
forwarded by name in both compose files, in .env.example and in the README.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

---

### Task 6: Shared pieces: the marks store takes a page's marks, the endless-list footer and the sort header move out

**Files:**
- Modify: `lib/site-marks-client.ts` (`adopt`), `__tests__/site-marks-client.test.ts`
- Create: `components/list-footer-line.tsx`, `components/site-sort-header.tsx`, `__tests__/list-footer-line.test.ts`
- Modify: `app/credentials/page.tsx`, `__tests__/credentials-page-endless.test.ts` (footer moved; the page's text does not change)
- Modify: `app/counts/page.tsx` (`SortHeader` moved)

**Interfaces:**
- Produces: `store.adopt(marks: Readonly<Record<string, SiteMark>>, replace?: boolean): void`; `ListFooterLine({ kind, rows, error, onLoadMore, onStop, noun?, endLabel?, slowHint? })` (defaults are the Credentials page's words); `SortHeader({ label, sortKey, sort, onSort, className, disabled? })`.

- [ ] **Step 1: Write the failing test for `adopt`**

Append to `__tests__/site-marks-client.test.ts`:

```ts
describe('adopt (a list that comes with its marks)', () => {
  test('the store is ready at once and shows the marks it was handed', () => {
    const store = createSiteMarksStore({ fetch: controlledFetch().fetch, onSaveFailed: () => {} })
    store.adopt({ 'a.example': mark('done') })
    expect(store.getSnapshot()).toEqual({ status: 'ready', marks: { 'a.example': mark('done') }, error: null })
  })

  test('the next page is added to what is held; a new list replaces it', () => {
    const store = createSiteMarksStore({ fetch: controlledFetch().fetch, onSaveFailed: () => {} })
    store.adopt({ 'a.example': mark('done') })
    store.adopt({ 'b.example': mark('skip') })
    expect(Object.keys(store.getSnapshot().marks).sort()).toEqual(['a.example', 'b.example'])
    store.adopt({ 'c.example': mark('todo') }, true)
    expect(Object.keys(store.getSnapshot().marks)).toEqual(['c.example'])
  })

  test('a site with a save on its way keeps what the page shows', async () => {
    const net = controlledFetch()
    const store = createSiteMarksStore({ fetch: net.fetch, onSaveFailed: () => {} })
    store.adopt({ 'a.example': mark('todo') })
    void store.change('a.example', { status: 'done' })
    store.adopt({ 'a.example': mark('todo') }) // an older page's word about the same site
    expect(store.getSnapshot().marks['a.example']?.status).toBe('done')
  })

  test('what was adopted is what a failed save goes back to', async () => {
    const net = controlledFetch()
    const failures: string[] = []
    const store = createSiteMarksStore({ fetch: net.fetch, onSaveFailed: message => failures.push(message) })
    store.adopt({ 'a.example': mark('todo') })
    const saving = store.change('a.example', { status: 'done' })
    expect(store.getSnapshot().marks['a.example']?.status).toBe('done')
    await flush() // the request is made a microtask after change()
    net.requests[0].fail(new Error('offline'))
    await saving
    expect(store.getSnapshot().marks['a.example']?.status).toBe('todo')
    expect(failures).toHaveLength(1)
  })

  test('a load that was still in flight is dropped: the list\'s own marks win', async () => {
    const net = controlledFetch()
    const store = createSiteMarksStore({ fetch: net.fetch, onSaveFailed: () => {} })
    const loading = store.load(['a.example'])
    store.adopt({ 'b.example': mark('skip') }, true)
    net.requests[0].answer(reply({ success: true, marks: { 'a.example': mark('done') } }))
    await loading
    expect(Object.keys(store.getSnapshot().marks)).toEqual(['b.example'])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-marks-client.test.ts 2>&1 | tail -8
```
Expected: FAIL, `store.adopt is not a function`.

- [ ] **Step 3: Add `adopt` to the store**

In `lib/site-marks-client.ts`, replace

```ts
  return {
    subscribe(listener: () => void) {
```
with

```ts
  /**
   * For a page whose list comes with its marks (the Site Directory joins them on the server): the marks of a page of the list, taken as what the server
   * last said. `replace` starts over (a new list); without it they are added to what is held (the next page). A site with a save on its way keeps what
   * the page shows, and a load() still in flight is dropped: the list's marks are the newer word.
   */
  function adopt(marks: Readonly<Record<string, SiteMark>>, replace = false): void {
    generation += 1
    if (replace) confirmed.clear()
    const next: Record<string, SiteMark> = replace ? {} : { ...snapshot.marks }
    for (const [host, mark] of Object.entries(marks)) {
      if (pending.has(host)) {
        if (snapshot.marks[host]) next[host] = snapshot.marks[host]
        continue
      }
      confirmed.set(host, mark)
      next[host] = mark
    }
    publish({ status: 'ready', marks: next, error: null })
  }

  return {
    subscribe(listener: () => void) {
```
and replace

```ts
    change,
  }
}

export type SiteMarksStore
```
with

```ts
    change,
    adopt,
  }
}

export type SiteMarksStore
```

- [ ] **Step 4: Run it**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-marks-client.test.ts 2>&1 | tail -6
```
Expected: all pass.

- [ ] **Step 5: Write the failing test for the footer**

Create `__tests__/list-footer-line.test.ts`:

```ts
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect } from 'vitest'
import { ListFooterLine } from '@/components/list-footer-line'

type Props = Parameters<typeof ListFooterLine>[0]
const render = (props: Partial<Props> & Pick<Props, 'kind'>) =>
  renderToStaticMarkup(createElement(ListFooterLine, { rows: 1200, error: null, onLoadMore: () => {}, onStop: () => {}, ...props }))
const text = (html: string) => html.replace(/<[^>]+>/g, '')

// The Credentials page used to hold this component; its words must not change by the move.
describe('ListFooterLine with its defaults (the Credentials page)', () => {
  test('more, end, capped, loading and error say what they said', () => {
    expect(text(render({ kind: 'more' }))).toBe('1,200 rows loaded · scroll for more')
    expect(text(render({ kind: 'end' }))).toBe('1,200 rows · end of the results')
    expect(text(render({ kind: 'capped' }))).toBe('1,200 rows loadedLoad the next rows')
    expect(text(render({ kind: 'loading' }))).toBe('1,200 rows loaded · loading the next rows… 0 sStop')
    expect(text(render({ kind: 'error' }))).toBe('The next rows could not be loaded.Retry')
    expect(text(render({ kind: 'error', error: 'Stopped.' }))).toBe('Stopped.Retry')
  })
})

describe('ListFooterLine with the directory\'s words', () => {
  const words = { noun: 'sites', endLabel: 'end of the directory', slowHint: '' }
  test('names the sites and the end of the directory', () => {
    expect(text(render({ kind: 'more', rows: 212, ...words }))).toBe('212 sites loaded · scroll for more')
    expect(text(render({ kind: 'end', rows: 212, ...words }))).toBe('212 sites · end of the directory')
    expect(text(render({ kind: 'loading', rows: 212, ...words }))).toBe('212 sites loaded · loading the next sites… 0 sStop')
    expect(text(render({ kind: 'capped', rows: 5000, ...words }))).toBe('5,000 sites loadedLoad the next sites')
    expect(text(render({ kind: 'error', ...words }))).toBe('The next sites could not be loaded.Retry')
  })
})
```

- [ ] **Step 6: Run it to see it fail, then write the component**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/list-footer-line.test.ts 2>&1 | tail -5
```
Expected: FAIL, cannot resolve `@/components/list-footer-line`.

Create `components/list-footer-line.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ListFooter } from "@/lib/credential-pages"

/**
 * What an endless list says under its rows: that more comes by scrolling, that a page is loading (with the seconds it has taken: a page of a rare search
 * can take a minute, and a spinner alone does not say whether anything is happening) and a button to stop it, a retry after an error or a stop, a button
 * past the row cap, and the end. It owns the seconds counter, so that the table does not render once a second. The Credentials page and the Site
 * Directory use it; the defaults are the Credentials page's words.
 */
export function ListFooterLine({ kind, rows, error, onLoadMore, onStop, noun = "rows", endLabel = "end of the results", slowHint = " (a rare search scans the whole table; a page can take a minute)" }: {
  kind: ListFooter
  rows: number
  error: string | null
  onLoadMore: () => void
  onStop: () => void
  /** What the rows are called ("rows", "sites"). */
  noun?: string
  /** What the end of the list says after the count. */
  endLabel?: string
  /** Appended to the loading line after 15 s; empty for a list whose pages are quick. */
  slowHint?: string
}) {
  const [seconds, setSeconds] = useState(0)
  const loading = kind === 'loading'
  useEffect(() => {
    if (!loading) { setSeconds(0); return }
    const started = Date.now()
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [loading])

  const count = rows.toLocaleString('en-US')
  return (
    <div className="flex items-center justify-center gap-3 border-t px-4 py-3 text-sm text-muted-foreground" role="status" aria-live="polite">
      {kind === 'loading' && (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="tabular-nums">{count} {noun} loaded · loading the next {noun}… {seconds} s{seconds >= 15 ? slowHint : ''}</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onStop}>Stop</Button>
        </>
      )}
      {kind === 'error' && (
        <>
          <span className="text-amber-600 dark:text-amber-400">{error ?? `The next ${noun} could not be loaded.`}</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onLoadMore}>Retry</Button>
        </>
      )}
      {kind === 'more' && <span className="tabular-nums">{count} {noun} loaded · scroll for more</span>}
      {kind === 'capped' && (
        <>
          <span className="tabular-nums">{count} {noun} loaded</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onLoadMore}>Load the next {noun}</Button>
        </>
      )}
      {kind === 'end' && <span className="tabular-nums">{count} {noun} · {endLabel}</span>}
    </div>
  )
}
```

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/list-footer-line.test.ts 2>&1 | tail -6
```
Expected: pass.

- [ ] **Step 7: Move the footer out of the Credentials page**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && python3 - <<'EOF'
p = 'app/credentials/page.tsx'
s = open(p).read()
a = s.index('// ─── Line under the rows')
b = s.index('// ─── Main page')
assert 'function ListFooterLine' in s[a:b] and a < b
s = s[:a] + s[b:]
old = 'import { appendPage, listFooter, scrollParentOf, shouldAutoLoad, LOAD_AHEAD_PX, type ListFooter } from "@/lib/credential-pages"'
assert s.count(old) == 1
s = s.replace(old, 'import { appendPage, listFooter, scrollParentOf, shouldAutoLoad, LOAD_AHEAD_PX } from "@/lib/credential-pages"\nimport { ListFooterLine } from "@/components/list-footer-line"')
open(p, 'w').write(s)

t = '__tests__/credentials-page-endless.test.ts'
u = open(t).read()
old = "    const footer = between('function ListFooterLine', '// ─── Main page')\n"
assert u.count(old) == 1
u = u.replace(old, "    // the line under the rows is a shared component now (the Site Directory uses it too); the page imports it\n    expect(source).toContain('import { ListFooterLine } from \"@/components/list-footer-line\"')\n    const footer = readFileSync(new URL('../components/list-footer-line.tsx', import.meta.url), 'utf8')\n")
open(t, 'w').write(u)
print('ok')
EOF
npx vitest run __tests__/credentials-page-endless.test.ts __tests__/credentials-page-totals.test.ts __tests__/credential-pages.test.ts __tests__/list-footer-line.test.ts 2>&1 | tail -6 && npx tsc --noEmit 2>&1 | tail -3
```
Expected: `ok`, all tests pass, no type errors. (If `tsc` reports `Loader2` or `Button` unused it does not: both are still used elsewhere in the page.)

- [ ] **Step 8: Move `SortHeader` out of the Site Counts page**

Create `components/site-sort-header.tsx` with the function exactly as it is in `app/counts/page.tsx`:

```tsx
"use client"

import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react"
import type { SiteSort, SiteSortKey } from "@/lib/site-counts-input"

/**
 * The header of a sortable column, as a button: its arrow says whether the table is sorted by the column and which way (the Credentials headers look the
 * same). Off while there is nothing to sort by (the Mark column before the marks are loaded). Used by the Site Counts page and the Site Directory.
 */
export function SortHeader({ label, sortKey, sort, onSort, className, disabled = false }: {
  label: string
  sortKey: SiteSortKey
  sort: SiteSort | null
  onSort: (key: SiteSortKey) => void
  className: string
  disabled?: boolean
}) {
  const current = sort !== null && sort.key === sortKey ? sort : null
  const Arrow = current === null ? ArrowUpDown : current.direction === "desc" ? ChevronDown : ChevronUp
  const state = current === null ? "" : current.direction === "desc" ? ", sorted biggest first" : ", sorted smallest first"
  const hint = current === null ? `Sort by ${label.toLowerCase()}`
    : current.direction === "desc" ? "Biggest first. Click for smallest first"
    : "Smallest first. Click to go back to the default order"
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      disabled={disabled}
      className={`${className} group/th cursor-pointer select-none uppercase transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 ${current ? "text-foreground" : ""}`}
      aria-label={`${label}${state}`}
      title={disabled ? "Not available until the marks are loaded" : hint}
    >
      <span className="inline-flex items-center">
        <Arrow className={`mr-1 h-3 w-3 shrink-0 ${current ? "text-primary" : "opacity-20 transition-opacity group-hover/th:opacity-60"}`} />
        {label}
      </span>
    </button>
  )
}
```

Then patch the Site Counts page:

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && python3 - <<'EOF'
p = 'app/counts/page.tsx'
s = open(p).read()
a = s.index('// ── One column header')
b = s.index('// ── Main page')
assert 'function SortHeader' in s[a:b] and a < b
s = s[:a] + s[b:]
old = '  BarChart3, Loader2, X, Download, Upload, ChevronDown, ChevronUp, ArrowUpDown, AlertTriangle, Square,'
assert s.count(old) == 1
s = s.replace(old, '  BarChart3, Loader2, X, Download, Upload, AlertTriangle, Square,')
old = 'import { SiteMarkFilter } from "@/components/site-mark-filter"'
assert s.count(old) == 1
s = s.replace(old, old + '\nimport { SortHeader } from "@/components/site-sort-header"')
open(p, 'w').write(s)
print('ok')
EOF
npx vitest run __tests__/site-counts-page.test.ts 2>&1 | tail -5 && npx tsc --noEmit 2>&1 | tail -3 && npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .ts,.tsx app/counts app/credentials components 2>&1 | tail -5
```
Expected: `ok`, tests pass, no type or lint output.

- [ ] **Step 9: Commit**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && git add lib/site-marks-client.ts __tests__/site-marks-client.test.ts components/list-footer-line.tsx components/site-sort-header.tsx __tests__/list-footer-line.test.ts app/credentials/page.tsx __tests__/credentials-page-endless.test.ts app/counts/page.tsx && git commit -q -m "$(cat <<'EOF'
refactor(site-directory): the endless-list footer and the sort header become shared components, and the marks store can take the marks a list comes with

The Credentials footer's text is pinned by a test and unchanged.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

---

### Task 7: The row detail, the split bar, the page and the sidebar entry

**Files:**
- Modify (whole file): `components/site-count-row.tsx`
- Create: `components/breakdown-bar.tsx`, `components/site-directory-detail.tsx`, `app/directory/page.tsx`
- Modify: `components/app-sidebar.tsx`
- Test: `__tests__/site-directory-page.test.ts`

**Interfaces:**
- Consumes: everything above. `SiteRow` gains an optional `detail?: SiteRowDetail` (`{ body: ReactNode; cell?: ReactNode; onOpen?: () => void }`); with none it behaves as before (the Site Counts page is untouched).
- Produces: the page at `/directory`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/site-directory-page.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The page is a large client component with no component-test harness in this repo, so its wiring is pinned with source checks; the decisions themselves are
// unit-tested (site-directory-input.test.ts, site-directory-order.test.ts, list-footer-line.test.ts) and the behaviour is checked in a browser on the rehearsal
// app (the plan's Task 9), because only a browser can show that the endless list loads one page at a time.
const root = join(__dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const page = read('app/directory/page.tsx')
const row = read('components/site-count-row.tsx')
const detail = read('components/site-directory-detail.tsx')
const sidebar = read('components/app-sidebar.tsx')
const countsPage = read('app/counts/page.tsx')
const between = (from: string, to: string) => page.slice(page.indexOf(from), page.indexOf(to))
const load = between('const load = useCallback', 'const loadMore = useCallback')
const loadMore = between('const loadMore = useCallback', '// The end of the rows and what scrolls them')
const observer = between('// The end of the rows and what scrolls them', '// What the line above the list says')

describe('the sidebar', () => {
  test('lists Site Directory right under Site Counts, in the Search group, open to every signed-in user', () => {
    const search = sidebar.match(/title: "Search",[\s\S]*?items: \[([\s\S]*?)\]/)![1]
    const titles = [...search.matchAll(/title: "([^"]+)"/g)].map(m => m[1])
    expect(titles.indexOf('Site Directory')).toBe(titles.indexOf('Site Counts') + 1)
    const entry = sidebar.match(/\{\s*title:\s*"Site Directory"[^}]*\}/)![0]
    expect(entry).toContain('url: "/directory"')
    expect(entry).not.toContain('adminOnly')
  })
})

describe('the Site Directory page — one endless list', () => {
  test('is for signed-in users and reads the three session routes', () => {
    expect(page).toContain('useAuth(true)')
    expect(page).toContain('/api/lookup/directory?')
    expect(page).toContain('"/api/lookup/directory/breakdown"')
    expect(page).toContain('"/api/lookup/directory/status"')
    expect(page).toContain('method: "DELETE"')
    expect(page).toContain('"/api/lookup/counts"')
  })

  test('shares the Credentials page\'s machinery instead of copying it', () => {
    expect(page).toContain('import { ListFooterLine } from "@/components/list-footer-line"')
    expect(page).toContain('import { SortHeader } from "@/components/site-sort-header"')
    expect(countsPage).toContain('import { SortHeader } from "@/components/site-sort-header"')
    expect(page).toMatch(/import \{[^}]*LOAD_AHEAD_PX[^}]*\} from "@\/lib\/credential-pages"/)
    expect(page).toMatch(/import \{[^}]*scrollParentOf[^}]*\} from "@\/lib\/credential-pages"/)
    expect(page).toMatch(/import \{[^}]*shouldAutoLoad[^}]*\} from "@\/lib\/credential-pages"/)
    expect(page).toContain('noun="sites"')
    expect(page).toContain('endLabel="end of the directory"')
  })

  test('the next page continues THE LIST ON SCREEN, is appended without a site that is already shown, and is dropped if the list has moved on', () => {
    expect(load).toContain('shownQueryRef.current = base.toString()')
    expect(loadMore).toContain('new URLSearchParams(shownQueryRef.current)')
    expect(loadMore).toContain("ps.set('offset', String(nextOffset))")
    expect(loadMore).toContain('new Set(prev.map(s => s.host))')
    expect(load).toContain('if (id !== searchRef.current) return')
    expect(loadMore).toContain('if (id !== searchRef.current) return')
    expect(page).not.toContain('Show more')
  })

  test('the observer watches the end of the rows against what REALLY scrolls, LOAD_AHEAD_PX early, and is made again after every page', () => {
    expect(observer).toMatch(/if \(!autoLoad \|\| !target \|\| typeof IntersectionObserver === 'undefined'\) return/)
    expect(observer).toContain('{ root: scrollParentOf(target), rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px` }')
    expect(observer).toMatch(/\}, \[autoLoad, rows\.length\]\)/)
    expect(page).toContain('<div ref={sentinelRef} aria-hidden="true" className="h-px" />')
    // rooted on the list's own box it would see the end as visible all the time when the box grows with its rows (the Credentials page's first version did)
    expect(observer).not.toContain('listBoxRef')
  })

  test('a failure or a stop keeps the rows, says so, and nothing retries by itself', () => {
    expect(loadMore).toContain('setMoreError(')
    expect(loadMore).toContain("'Stopped.'")
    expect(page).toContain('error: moreError !== null')
    expect(page).toContain('onStop={() => moreAbortRef.current?.abort()}')
  })

  test('a sort, a chip and the typed search (after a pause) replace the list and scroll back to the top', () => {
    expect(page).toContain('nextSiteSort(')
    expect(page).toContain('}, [sort, applied, markFilter, marksStore])')
    expect(page).toContain('setTimeout(() => setApplied(search.trim()), 300)')
    expect(load).toContain("listBoxRef.current?.scrollTo({ top: 0 })")
  })

  test('the marks come with the list: the store is handed each page\'s marks, and a changed mark reads the chips again', () => {
    expect(load).toContain('marksStore.adopt(marksOf(json.sites), true)')
    expect(loadMore).toContain('marksStore.adopt(marksOf(json.sites))')
    expect(page).toContain('marksStore.change(host, patch).then(')
    expect(page).toContain('refreshChipsRef.current()')
  })

  test('the rows are memoised and fed stable callbacks (thousands of rows must not render again for a poll or a click)', () => {
    expect(page).toContain('const DirectoryRow = memo(function DirectoryRow(')
    expect(page).toContain('const onMarkChange = useCallback(')
    expect(page).toContain('const startBreakdown = useCallback(')
  })

  test('opening a row with no split works it out, one at a time per site; there is no per-row button', () => {
    expect(page).toContain('needsBreakdown(site)')
    expect(page).toContain("if (uiRef.current[host]?.breakdown === \"working\") return")
    expect(page).not.toContain('Break down')
  })

  test('the status line is asked for every 30 s while the tab is visible, and a finished refresh offers a reload instead of moving the rows', () => {
    expect(page).toContain('setInterval(poll, 30_000)')
    expect(page).toContain('document.visibilityState')
    expect(page).toContain('Reload the list')
    expect(page).toContain('statusLine(status)')
  })
})

describe('the row and its detail', () => {
  test('SiteRow takes an optional detail that opens every row; Site Counts passes none', () => {
    expect(row).toContain('export interface SiteRowDetail')
    expect(row).toContain('const expandable = detail !== undefined || (result.count ?? 0) > 0')
    expect(row).toContain('detail?.onOpen?.()')
    expect(row).toContain('{detail?.body}')
    expect(countsPage).not.toContain('detail=')
  })

  test('the detail shows the split with its counts and shares, a stale note, Try again, Recount and a two-step Remove', () => {
    for (const text of ['Logins by type', 'Working out the split…', 'Try again', 'Recount', 'Remove', 'Click again to remove', 'No rows, so nothing to split', 'Not counted yet']) {
      expect(detail).toContain(text)
    }
    expect(detail).toContain('breakdownNote(site)')
    expect(detail).toContain('<BreakdownLegend')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-page.test.ts 2>&1 | tail -6
```
Expected: FAIL (`ENOENT ... app/directory/page.tsx`).

- [ ] **Step 3: Give `SiteRow` an optional detail**

Replace the whole of `components/site-count-row.tsx` with:

```tsx
"use client"

import { useState, type ReactNode } from "react"
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react"
import { MARK_CELL, SiteMarkCell } from "@/components/site-mark-cell"
import type { SiteCount } from "@/lib/site-counts-input"
import { isMarkableHost, type SiteMark, type SiteMarkPatch } from "@/lib/site-marks-input"

export interface CountRow {
  site: string
  result: SiteCount
}

export const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString())

/**
 * The columns after the site name. The mark cell is on screen at every width. The breakdown columns need a wide window (xl); below it the same numbers are
 * in the row's detail. The headers of the number columns and of the mark column are sort buttons, and their widths leave room for the arrow in front of
 * the label. `split` is the Site Directory's column for the bar of a stored split of logins by type.
 */
export const COLS = {
  mark: MARK_CELL,
  rows: "w-20 text-right shrink-0",
  host: "hidden xl:block w-24 text-right shrink-0",
  subs: "hidden xl:block w-28 text-right shrink-0",
  distinct: "hidden xl:block w-24 text-right shrink-0",
  split: "hidden xl:flex w-28 items-center shrink-0",
  chevron: "w-3.5 shrink-0",
}

/**
 * What the Site Directory adds to a row (the Site Counts page passes none): it opens every row, not only those with rows, shows `cell` in the row at
 * wide widths and `body` under the numbers of the detail, and is told when the row is opened.
 */
export interface SiteRowDetail {
  body: ReactNode
  cell?: ReactNode
  onOpen?: () => void
}

interface SiteRowProps {
  row: CountRow
  /** The site's stored mark, null when it has none. */
  mark: SiteMark | null
  availability: "loading" | "ready" | "failed"
  onMarkChange: (host: string, patch: SiteMarkPatch) => void
  detail?: SiteRowDetail
}

export function SiteRow({ row, mark, availability, onMarkChange, detail }: SiteRowProps) {
  const [open, setOpen] = useState(false)
  const { site, result } = row
  const expandable = detail !== undefined || (result.count ?? 0) > 0
  const muted = !result.error && result.count === 0
  const toggle = () => {
    if (!expandable) return
    if (!open) detail?.onOpen?.()
    setOpen(o => !o)
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* A div, not a button: the mark's own button sits inside this row, and a button in a button is not valid HTML. A click anywhere on the row opens its
          detail for the mouse; the chevron is the real button, for the keyboard and for assistive tools. */}
      <div
        onClick={toggle}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          expandable ? "hover:bg-muted/40 cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className={`block font-mono text-xs truncate ${muted ? "text-muted-foreground" : ""}`} title={site}>{site}</span>
          {result.searched_as && (
            <span className="block text-[10px] text-muted-foreground truncate" title={`Counted as ${result.searched_as}`}>
              counted as {result.searched_as}
            </span>
          )}
          {result.error && (
            <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3 shrink-0" />{result.error}
            </span>
          )}
        </span>
        {isMarkableHost(result.host) ? (
          <SiteMarkCell host={result.host} mark={mark} availability={availability} onChange={patch => onMarkChange(result.host, patch)} />
        ) : (
          <span className={COLS.mark} />
        )}
        <span className={`${COLS.rows} text-sm font-semibold tabular-nums ${muted ? "text-muted-foreground font-normal" : ""}`}>{fmt(result.count)}</span>
        <span className={`${COLS.host} text-xs tabular-nums text-muted-foreground`}>{fmt(result.host_count)}</span>
        <span className={`${COLS.subs} text-xs tabular-nums text-muted-foreground`}>{fmt(result.subdomain_count)}</span>
        <span className={`${COLS.distinct} text-xs tabular-nums text-muted-foreground`}>{fmt(result.subdomains)}</span>
        {detail && <span className={COLS.split}>{detail.cell}</span>}
        <span className={COLS.chevron}>
          {expandable && (
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                toggle()
              }}
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} the details of ${site}`}
              className="flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {open ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
          )}
        </span>
      </div>

      {open && expandable && (
        <div className="border-t bg-muted/20 px-4 py-2 space-y-2">
          {result.count !== null && (
            <p className="text-xs text-muted-foreground">
              <span className="tabular-nums">{fmt(result.host_count)}</span> on the site itself
              {result.subdomain_count === null
                ? " · subdomains not counted"
                : <>{" · "}<span className="tabular-nums">{fmt(result.subdomain_count)}</span> on {fmt(result.subdomains)} subdomain{result.subdomains === 1 ? "" : "s"}</>}
            </p>
          )}
          {result.top_subdomains.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Subdomains with the most rows{result.subdomains !== null && result.subdomains > result.top_subdomains.length
                  ? ` (${result.top_subdomains.length} of ${result.subdomains.toLocaleString()})` : ""}
              </p>
              <ul className="text-xs font-mono">
                {result.top_subdomains.map(s => (
                  <li key={s.domain} className="flex justify-between gap-4 py-0.5">
                    <span className="truncate" title={s.domain}>{s.domain}</span>
                    <span className="tabular-nums text-muted-foreground">{s.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail?.body}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: The split bar and the detail**

Create `components/breakdown-bar.tsx`:

```tsx
import { breakdownShares, type BreakdownCounts } from "@/lib/site-directory-input"

/** A fill per part. Colour is never the only signal: the legend names every part with its count and share, and the bar's accessible name lists them. */
const PART_COLORS: Record<string, string> = {
  email: "bg-sky-500",
  phone: "bg-amber-500",
  username: "bg-emerald-500",
  other: "bg-slate-400",
}

/** The split of a site's logins as one thin stacked bar. */
export function BreakdownBar({ breakdown, className = "h-2" }: { breakdown: BreakdownCounts; className?: string }) {
  const shares = breakdownShares(breakdown)
  const label = shares.map(s => `${s.label} ${s.text}`).join(", ")
  return (
    <div role="img" aria-label={label} title={label} className={`flex w-full overflow-hidden rounded-full bg-muted ${className}`}>
      {shares.filter(s => s.count > 0).map(s => (
        <div key={s.key} className={PART_COLORS[s.key]} style={{ flexGrow: s.count, flexBasis: 0 }} />
      ))}
    </div>
  )
}

/** The four parts with their counts and shares, as text. */
export function BreakdownLegend({ breakdown }: { breakdown: BreakdownCounts }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
      {breakdownShares(breakdown).map(s => (
        <div key={s.key} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${PART_COLORS[s.key]}`} aria-hidden />
          <dt className="text-muted-foreground">{s.label}</dt>
          <dd className="ml-auto tabular-nums sm:ml-1">
            <span className="font-medium">{s.count.toLocaleString()}</span> <span className="text-muted-foreground">{s.text}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}
```

Create `components/site-directory-detail.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BreakdownBar, BreakdownLegend } from "@/components/breakdown-bar"
import { formatRelativeTime } from "@/lib/format-relative-time"
import { breakdownNote, type DirectorySite } from "@/lib/site-directory-input"

/** What the page knows about one row beyond the site: whether its split is being worked out or failed, and whether it is being counted again. */
export interface RowUi {
  breakdown: "idle" | "working" | "failed"
  error: string | null
  recounting: boolean
}

export const IDLE_UI: RowUi = { breakdown: "idle", error: null, recounting: false }

/** The wait for a split. A very broad site takes several seconds, so after four the note says so; it owns its timer so the page does not render for it. */
function WorkingNote() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 4000)
    return () => clearTimeout(id)
  }, [])
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />Working out the split…{slow ? " A very broad site takes several seconds." : ""}
    </p>
  )
}

interface SiteDirectoryDetailProps {
  site: DirectorySite
  ui: RowUi
  onBreakdown: () => void
  onRecount: () => void
  onRemove: () => void
}

/** What an opened directory row adds to the Site Counts detail: when the numbers were taken, the split by login type, the site's history and its actions. */
export function SiteDirectoryDetail({ site, ui, onBreakdown, onRecount, onRemove }: SiteDirectoryDetailProps) {
  const [armed, setArmed] = useState(false)
  const note = breakdownNote(site)
  const { breakdown } = site

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        {site.counted_at ? `Counted ${formatRelativeTime(site.counted_at)}` : "Not counted yet. The next refresh counts it."}
        {site.count_error && !site.counted_at ? ` (${site.count_error})` : ""}
      </p>

      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Logins by type</p>
        {site.count === 0 && <p className="text-xs text-muted-foreground">No rows, so nothing to split.</p>}
        {site.count !== 0 && ui.breakdown === "working" && <WorkingNote />}
        {site.count !== 0 && ui.breakdown !== "working" && breakdown && (
          <div className="space-y-2">
            <BreakdownBar breakdown={breakdown} className="h-2.5" />
            <BreakdownLegend breakdown={breakdown} />
            <p className="text-[11px] text-muted-foreground">
              Worked out {formatRelativeTime(breakdown.at)}.{note ? ` ${note}` : ""}
            </p>
          </div>
        )}
        {ui.breakdown === "failed" && (
          <div className="flex flex-wrap items-center gap-2" role="alert">
            <span className="text-xs text-amber-600 dark:text-amber-400">{ui.error ?? "The split could not be worked out."}</span>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={onBreakdown}>Try again</Button>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Added {formatRelativeTime(site.first_added_at)} · counted {site.times_counted.toLocaleString()} time{site.times_counted === 1 ? "" : "s"}
        {site.last_counted_at ? ` · last ${formatRelativeTime(site.last_counted_at)}` : ""}
      </p>

      {site.mark?.note && (
        <p className="text-xs"><span className="text-muted-foreground">Note: </span>{site.mark.note}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={ui.recounting} onClick={onRecount}>
          {ui.recounting && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}Recount
        </Button>
        {armed ? (
          <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={onRemove} onBlur={() => setArmed(false)} autoFocus>Click again to remove</Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => setArmed(true)}>Remove</Button>
        )}
      </div>
    </div>
  )
}
```
(The "No rows, so nothing to split" and "Not counted yet" strings are what the test pins; `Recount`, `Remove`, `Try again`, `Click again to remove`, `Logins by type` and `Working out the split…` as above.)

- [ ] **Step 5: The page**

Create `app/directory/page.tsx`:

```tsx
"use client"
export const dynamic = "force-dynamic"

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { AlertTriangle, Library, Loader2, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/hooks/useAuth"
import { BreakdownBar } from "@/components/breakdown-bar"
import { ListFooterLine } from "@/components/list-footer-line"
import { COLS, SiteRow } from "@/components/site-count-row"
import { IDLE_UI, SiteDirectoryDetail, type RowUi } from "@/components/site-directory-detail"
import { SiteMarkFilter } from "@/components/site-mark-filter"
import { SortHeader } from "@/components/site-sort-header"
import { LOAD_AHEAD_PX, listFooter, scrollParentOf, shouldAutoLoad } from "@/lib/credential-pages"
import { nextSiteSort, type SiteSort, type SiteSortKey } from "@/lib/site-counts-input"
import {
  directoryParams, directoryResult, needsBreakdown, statusLine, type DirectoryListing, type DirectorySite, type DirectoryStatus,
} from "@/lib/site-directory-input"
import { createSiteMarksStore } from "@/lib/site-marks-client"
import type { MarkFilter, SiteMark, SiteMarkPatch } from "@/lib/site-marks-input"

const SESSION_EXPIRED = "Your session has expired. Sign in again, then reload."
const ZERO_CHIPS: Record<MarkFilter, number> = { all: 0, done: 0, skip: 0, todo: 0, none: 0 }

type Answer<T> = T & { success?: boolean; error?: string }

/** A JSON answer of a session route. An expired session is redirected to the sign-in page, which is not JSON. */
async function getJson<T>(url: string, init?: RequestInit): Promise<Answer<T>> {
  const res = await fetch(url, init)
  if (res.redirected || res.status === 401) throw new Error(SESSION_EXPIRED)
  return await res.json()
}

const marksOf = (sites: DirectorySite[]): Record<string, SiteMark> =>
  Object.fromEntries(sites.filter(s => s.mark !== null).map(s => [s.host, s.mark as SiteMark]))

// ── One row ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface DirectoryRowProps {
  site: DirectorySite
  mark: SiteMark | null
  ui: RowUi
  onMarkChange: (host: string, patch: SiteMarkPatch) => void
  onOpen: (host: string) => void
  onBreakdown: (host: string) => void
  onRecount: (host: string) => void
  onRemove: (host: string) => void
}

/** Memoised: the list is endless and can hold thousands of rows, and a poll of the status, a click on another row or a page appended must not render them all. */
const DirectoryRow = memo(function DirectoryRow({ site, mark, ui, onMarkChange, onOpen, onBreakdown, onRecount, onRemove }: DirectoryRowProps) {
  const row = useMemo(() => ({ site: site.host, result: directoryResult(site) }), [site])
  const detail = useMemo(() => ({
    onOpen: () => onOpen(site.host),
    cell: site.breakdown ? <BreakdownBar breakdown={site.breakdown} /> : null,
    body: (
      <SiteDirectoryDetail
        site={site}
        ui={ui}
        onBreakdown={() => onBreakdown(site.host)}
        onRecount={() => onRecount(site.host)}
        onRemove={() => onRemove(site.host)}
      />
    ),
  }), [site, ui, onOpen, onBreakdown, onRecount, onRemove])
  return <SiteRow row={row} mark={mark} availability="ready" onMarkChange={onMarkChange} detail={detail} />
})

// ── Main page ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export default function SiteDirectoryPage() {
  useAuth(true)
  const { toast } = useToast()

  const [rows, setRows] = useState<DirectorySite[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [chips, setChips] = useState<Record<MarkFilter, number> | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [moreError, setMoreError] = useState<string | null>(null)
  // The way the list is looked at. A change of any of the three replaces the list and goes back to the top.
  const [sort, setSort] = useState<SiteSort | null>(null)
  const [markFilter, setMarkFilter] = useState<MarkFilter>("all")
  const [search, setSearch] = useState("")
  const [applied, setApplied] = useState("")
  const [status, setStatus] = useState<DirectoryStatus | null>(null)
  const [loadedRefreshedAt, setLoadedRefreshedAt] = useState<string | null>(null)
  const [uiByHost, setUiByHost] = useState<Record<string, RowUi>>({})

  const searchRef = useRef(0) // which list is on screen: an answer for another one is dropped
  const loadAbortRef = useRef<AbortController | null>(null)
  const moreAbortRef = useRef<AbortController | null>(null)
  const moreInFlightRef = useRef(false)
  const shownQueryRef = useRef("") // the query string of the list on screen, without an offset: the next page continues THIS list
  const rowsRef = useRef<DirectorySite[]>([])
  const uiRef = useRef<Record<string, RowUi>>({})
  const listBoxRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // The marks come with the list (a join on the server); the store orders the saves of a change and puts a failed one back.
  const marksStore = useMemo(
    () => createSiteMarksStore({
      fetch: (input, init) => fetch(input, init),
      onSaveFailed: message => toast({ title: "The mark was not saved", description: message, variant: "destructive" }),
    }),
    [toast],
  )
  const marksSnap = useSyncExternalStore(marksStore.subscribe, marksStore.getSnapshot, marksStore.getSnapshot)

  useEffect(() => { rowsRef.current = rows }, [rows])
  useEffect(() => {
    const id = setTimeout(() => setApplied(search.trim()), 300)
    return () => clearTimeout(id)
  }, [search])

  const load = useCallback(async () => {
    const id = ++searchRef.current
    loadAbortRef.current?.abort()
    moreAbortRef.current?.abort()
    moreInFlightRef.current = false
    const controller = new AbortController()
    loadAbortRef.current = controller
    setLoading(true)
    setLoadingMore(false)
    setMoreError(null)
    setLoadError(null)
    const base = directoryParams({ sort, q: applied, mark: markFilter })
    shownQueryRef.current = base.toString()
    try {
      const json = await getJson<Partial<DirectoryListing>>(`/api/lookup/directory?${base.toString()}`, { signal: controller.signal })
      if (id !== searchRef.current) return
      if (!json.success || !json.sites) throw new Error(json.error || "The directory could not be loaded")
      setRows(json.sites)
      setNextOffset(json.next_offset ?? null)
      setTotal(json.total ?? null)
      setChips(json.marks ?? null)
      setLoadedRefreshedAt(json.refreshed_at ?? null)
      marksStore.adopt(marksOf(json.sites), true)
      listBoxRef.current?.scrollTo({ top: 0 })
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      if (id !== searchRef.current) return
      setLoadError(err instanceof Error ? err.message : "The directory could not be loaded")
    } finally {
      if (id === searchRef.current) setLoading(false)
    }
  }, [sort, applied, markFilter, marksStore])
  useEffect(() => { void load() }, [load])

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loading || moreInFlightRef.current) return
    moreInFlightRef.current = true
    const id = searchRef.current
    const controller = new AbortController()
    moreAbortRef.current = controller
    setLoadingMore(true)
    setMoreError(null)
    try {
      const ps = new URLSearchParams(shownQueryRef.current)
      ps.set('offset', String(nextOffset))
      const json = await getJson<Partial<DirectoryListing>>(`/api/lookup/directory?${ps.toString()}`, { signal: controller.signal })
      if (id !== searchRef.current) return
      if (!json.success || !json.sites) throw new Error(json.error || "The next sites could not be loaded.")
      // a site added between two pages can shift the offset: one that is already shown is not shown twice
      setRows(prev => {
        const seen = new Set(prev.map(s => s.host))
        return [...prev, ...json.sites!.filter(s => !seen.has(s.host))]
      })
      setNextOffset(json.next_offset ?? null)
      marksStore.adopt(marksOf(json.sites))
    } catch (err) {
      if (id !== searchRef.current) return
      setMoreError(err instanceof DOMException && err.name === "AbortError" ? 'Stopped.' : err instanceof Error ? err.message : "The next sites could not be loaded.")
    } finally {
      moreInFlightRef.current = false
      if (id === searchRef.current) setLoadingMore(false)
    }
  }, [nextOffset, loading, marksStore])

  // The end of the rows and what scrolls them: when the end comes within LOAD_AHEAD_PX of the bottom of the scroller, the next page is fetched. The observer
  // is made again after every page (and every list), so that a page that does not fill the screen is followed by the next at once.
  const loadMoreRef = useRef(loadMore)
  useEffect(() => { loadMoreRef.current = loadMore }, [loadMore])
  const listState = { rows: rows.length, hasMore: nextOffset !== null, loading, loadingMore, error: moreError !== null }
  const autoLoad = shouldAutoLoad(listState)
  const footerKind = listFooter(listState)
  useEffect(() => {
    const target = sentinelRef.current
    if (!autoLoad || !target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) void loadMoreRef.current() },
      { root: scrollParentOf(target), rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px` },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [autoLoad, rows.length])

  // What the line above the list says: asked for every 30 s while the tab is visible. New numbers never move under the cursor: a finished refresh offers a
  // reload.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const json = await getJson<Partial<DirectoryStatus>>("/api/lookup/directory/status")
        if (!cancelled && json.success) setStatus(json as DirectoryStatus)
      } catch {
        // the line keeps its last words
      }
    }
    void poll()
    const id = setInterval(poll, 30_000)
    const onVisible = () => { if (document.visibilityState === "visible") void poll() }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])
  const reloadNeeded = status !== null && status.state === "current" && status.refreshed_at !== loadedRefreshedAt

  // ── Edits that change a row on screen and nothing else ──
  const refreshChips = useCallback(async () => {
    try {
      const json = await getJson<Partial<DirectoryListing>>(`/api/lookup/directory?${directoryParams({ sort, q: applied, mark: markFilter, limit: 1 }).toString()}`)
      if (json.success) {
        setChips(json.marks ?? null)
        setTotal(json.total ?? null)
      }
    } catch {
      // the chips keep their numbers until the next load
    }
  }, [sort, applied, markFilter])
  const refreshChipsRef = useRef(refreshChips)
  useEffect(() => { refreshChipsRef.current = refreshChips }, [refreshChips])

  const patchUi = useCallback((host: string, patch: Partial<RowUi>) => {
    uiRef.current = { ...uiRef.current, [host]: { ...(uiRef.current[host] ?? IDLE_UI), ...patch } }
    setUiByHost(uiRef.current)
  }, [])
  const replaceSite = useCallback((site: DirectorySite) => {
    setRows(prev => prev.map(s => (s.host === site.host ? site : s)))
  }, [])

  const onMarkChange = useCallback((host: string, patch: SiteMarkPatch) => {
    void marksStore.change(host, patch).then(() => refreshChipsRef.current())
  }, [marksStore])

  const startBreakdown = useCallback(async (host: string) => {
    if (uiRef.current[host]?.breakdown === "working") return
    patchUi(host, { breakdown: "working", error: null })
    try {
      const json = await getJson<{ site?: DirectorySite }>("/api/lookup/directory/breakdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host }),
      })
      if (!json.success || !json.site) throw new Error(json.error || "The split could not be worked out")
      replaceSite(json.site)
      patchUi(host, { breakdown: "idle", error: null })
    } catch (err) {
      patchUi(host, { breakdown: "failed", error: err instanceof Error ? err.message : "The split could not be worked out" })
    }
  }, [patchUi, replaceSite])

  // Opening a row with no split works it out: the click is the demand.
  const onOpen = useCallback((host: string) => {
    const site = rowsRef.current.find(s => s.host === host)
    if (site && needsBreakdown(site)) void startBreakdown(host)
  }, [startBreakdown])

  const recount = useCallback(async (host: string) => {
    patchUi(host, { recounting: true })
    try {
      const counted = await getJson<unknown>("/api/lookup/counts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: [host] }),
      })
      if (!counted.success) throw new Error(counted.error || "Counting failed")
      const one = await getJson<Partial<DirectoryListing>>(`/api/lookup/directory?${directoryParams({ sort: null, q: "", mark: "all", host }).toString()}`)
      const site = one.sites?.[0]
      if (site) replaceSite(site)
      if (site?.breakdown) await startBreakdown(host)
    } catch (err) {
      toast({ title: "The recount failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    } finally {
      patchUi(host, { recounting: false })
    }
  }, [patchUi, replaceSite, startBreakdown, toast])

  const removeSiteRow = useCallback(async (host: string) => {
    try {
      const json = await getJson<unknown>("/api/lookup/directory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host }),
      })
      if (!json.success) throw new Error(json.error || "The site was not removed")
      setRows(prev => prev.filter(s => s.host !== host))
      setTotal(t => (t === null ? t : Math.max(0, t - 1)))
      void refreshChipsRef.current()
    } catch (err) {
      toast({ title: "The site was not removed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    }
  }, [toast])

  const onSort = (key: SiteSortKey) => setSort(current => nextSiteSort(current, key))
  const filtered = applied !== "" || markFilter !== "all"

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-5">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Library className="h-5 w-5 text-primary" />
          Site Directory
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Every site you have counted, most rows first. Open one to see its count and how its logins split into e-mail, phone, user name and other
        </p>
      </div>

      <div className="border-b px-6 py-3 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64 max-w-full">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sites"
              aria-label="Search the directory"
              className="h-8 pl-7 text-xs"
              spellCheck={false}
            />
          </div>
          <SiteMarkFilter value={markFilter} counts={chips ?? ZERO_CHIPS} disabled={chips === null} onChange={setMarkFilter} />
          {total !== null && (
            <span className="text-xs tabular-nums text-muted-foreground">{total.toLocaleString()} site{total === 1 ? "" : "s"}{filtered ? " match" : ""}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
          {status && <span>{statusLine(status)}</span>}
          {reloadNeeded && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void load()}>Reload the list</Button>
          )}
        </div>
      </div>

      <div ref={listBoxRef} className="flex-1 overflow-auto p-4">
        {loadError && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2 mb-3" role="alert">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
            <p className="flex-1 text-[11px] text-amber-700 dark:text-amber-400">{loadError}</p>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void load()}>Retry</Button>
          </div>
        )}

        {loading && rows.length === 0 && !loadError && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />Loading the directory…
          </div>
        )}

        {!loading && !loadError && rows.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {filtered ? "No sites match." : "No sites yet. Count a list on Site Counts and every site lands here."}
          </p>
        )}

        {rows.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 px-4 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span className="min-w-0 flex-1">Site</span>
              <SortHeader label="Mark" sortKey="mark" sort={sort} onSort={onSort} className={COLS.mark} />
              <SortHeader label="Rows" sortKey="count" sort={sort} onSort={onSort} className={COLS.rows} />
              <SortHeader label="On the site" sortKey="host_count" sort={sort} onSort={onSort} className={COLS.host} />
              <SortHeader label="On subdomains" sortKey="subdomain_count" sort={sort} onSort={onSort} className={COLS.subs} />
              <SortHeader label="Subdomains" sortKey="subdomains" sort={sort} onSort={onSort} className={COLS.distinct} />
              <span className={COLS.split}>Split</span>
              <span className={COLS.chevron} />
            </div>

            <div className="flex flex-col gap-2">
              {rows.map(site => (
                <DirectoryRow
                  key={site.host}
                  site={site}
                  mark={marksSnap.marks[site.host] ?? null}
                  ui={uiByHost[site.host] ?? IDLE_UI}
                  onMarkChange={onMarkChange}
                  onOpen={onOpen}
                  onBreakdown={startBreakdown}
                  onRecount={recount}
                  onRemove={removeSiteRow}
                />
              ))}
            </div>

            <div ref={sentinelRef} aria-hidden="true" className="h-px" />
            <ListFooterLine
              kind={footerKind}
              rows={rows.length}
              error={moreError}
              onLoadMore={loadMore}
              onStop={() => moreAbortRef.current?.abort()}
              noun="sites"
              endLabel="end of the directory"
              slowHint=""
            />
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: The sidebar entry**

In `components/app-sidebar.tsx`: change the lucide import line to add `Library` (append `, Library` before the closing `} from "lucide-react"` of the first import), and after the line

```ts
      { title: "Site Counts",   url: "/counts",      icon: BarChart3 },
```
add

```ts
      { title: "Site Directory", url: "/directory",  icon: Library },
```

- [ ] **Step 7: Run the tests, the types and the lint**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx vitest run __tests__/site-directory-page.test.ts __tests__/site-counts-page.test.ts 2>&1 | tail -8 && npx tsc --noEmit 2>&1 | tail -5 && npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .ts,.tsx app components lib 2>&1 | tail -8
```
Expected: all pass; no output from `tsc` and eslint. Fix a pin only if the page's text is right and the pin is wrong; fix the page if a pin names a real requirement.

- [ ] **Step 8: Commit**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && git add components/site-count-row.tsx components/breakdown-bar.tsx components/site-directory-detail.tsx components/app-sidebar.tsx app/directory/page.tsx __tests__/site-directory-page.test.ts && git commit -q -m "$(cat <<'EOF'
feat(site-directory): the Site Directory page: an endless list in the order of Site Counts, a detail with the count and the split by login type, a status line

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

---

### Task 8: Docs, the rehearsal step and the spec brought in line

**Files:**
- Modify: `README.md`, `app/docs/page.tsx`, `scripts/e2e-batch-lookup.ts`, `docs/superpowers/specs/2026-11-21-site-directory-design.md`

- [ ] **Step 1: README and API docs**

In `README.md`, directly after the paragraph that starts `- **Site counts** —` (line 23) add a new bullet:

```markdown
- **Site directory** — a running directory of every site that was counted on Site Counts (the page, a tab closed mid-run and `POST /api/v1/lookup/counts` all feed it), under the host the counts name, so every spelling of a site is one entry. Sorted most rows first like Site Counts (click a number column or Mark to sort; a search box and the mark chips narrow it), it scrolls without end like the Credentials list: 200 sites at a time, the server sorting, searching and paging in SQLite. Opening a site shows its count (on the site, on subdomains, the top subdomains) and how its logins split into e-mail, phone, user name and other; the split is worked out when you open a site that has none, stored, and kept current. The numbers stay current by themselves after an import, a delete or a dedup (see "Site directory refresh"). A count with an imported window adds sites but never overwrites the all-time numbers. A site can be recounted or removed from its detail; a removed site comes back, with its history reset, if it is counted again (`lib/site-directory.ts`, page `/directory`)
```

In `app/docs/page.tsx`, replace the sentence

```
The same counts are on the Site Counts page, which takes a pasted or uploaded list.
```
with

```
The same counts are on the Site Counts page, which takes a pasted or uploaded list. Every site counted here, by the page or by this route, is also kept in the Site Directory page for everyone who signs in (a count with an imported window adds the site but leaves its all-time numbers alone).
```
(use a Python replace with an assertion that the original appears exactly once).

- [ ] **Step 2: The rehearsal step**

In `scripts/e2e-batch-lookup.ts`:

1. In the header comment, after `survive recreating only the app (its data volume is kept).` add (inside the same ` * ` comment block, as a new sentence on the next lines):

```
 * The site directory (docs/superpowers/specs/2026-11-21-site-directory-design.md) is checked after them: it is fed by the counts, the split by login type
 * of a site seeded with 4 e-mail, 3 phone, 2 user name and 1 blank login is exactly that, a mark shows in it, new rows make it recount the site and work
 * the stored split out again by itself (the rehearsal app ticks every minute with 5 s of quiet), and Remove takes a site out.
```

2. Immediately before the line `    // Last, because it changes the table: without the reversed-domain projection on every part only hosts can be counted, and the answer says so.` insert:

```ts
    console.log('9. Site directory: fed by the counts, the split by login type, kept current after new rows, GET and DELETE /api/lookup/directory')
    const directory = {
      list: (query = '') => asSession('GET', `/api/lookup/directory${query}`),
      remove: (host: string) => asSession('DELETE', '/api/lookup/directory', { host }),
      breakdown: (host: string) => asSession('POST', '/api/lookup/directory/breakdown', { host }),
      status: () => asSession('GET', '/api/lookup/directory/status'),
    }
    const anonList = await call('GET', '/api/lookup/directory')
    const anonSplit = await call('POST', '/api/lookup/directory/breakdown', { host: COUNTS_SITE })
    check('the directory routes need a session (401 without one)', anonList.status === 401 && anonSplit.status === 401, `${anonList.status} / ${anonSplit.status}`)

    const fed = (await directory.list(`?host=${COUNTS_SITE}`)).json?.sites?.[0]
    check('the site the counts named is in the directory with the numbers of its last all-time count (23 rows: 7 on the site, 16 on 5 subdomains)',
      fed?.host === COUNTS_SITE && fed.count === 23 && fed.host_count === 7 && fed.subdomain_count === 16 && fed.subdomains === 5, JSON.stringify(fed).slice(0, 260))
    check('and it was counted more than once (every run of steps 7 and 8 carried it)', (fed?.times_counted ?? 0) >= 2, `times_counted ${fed?.times_counted}`)
    const order = ((await directory.list('')).json?.sites ?? []).map((s: { count: number | null }) => s.count ?? -1)
    check('the list is ordered by rows, biggest first, sites with no number last', order.length > 1 && order.every((c: number, i: number) => i === 0 || order[i - 1] >= c), order.slice(0, 8).join(','))

    // A site with every kind of login: 4 e-mail addresses, 3 phone numbers, 2 user names and 1 blank login, all under the one host.
    const SPLIT_SITE = `split-${RUN}.example.test`
    const splitRows = (n: number, email: string) => `SELECT 'https://${SPLIT_SITE}/x', ${email}, 'pw', '${SPLIT_SITE}', 'seed-${RUN}', '' FROM numbers(${n})`
    chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name)
      ${splitRows(4, `concat('m', toString(number), '-${RUN}@example.test')`)} UNION ALL ${splitRows(3, `concat('+4479111', lpad(toString(number), 5, '0'))`)}
      UNION ALL ${splitRows(2, `concat('user', toString(number), '${RUN}')`)} UNION ALL ${splitRows(1, `''`)}`)
    const splitCounted = await counts({ domains: [SPLIT_SITE] })
    check('a new site is counted (10 rows) and lands in the directory', splitCounted.json?.results?.[SPLIT_SITE]?.count === 10 && (await directory.list(`?host=${SPLIT_SITE}`)).json?.sites?.[0]?.count === 10)
    const split = await directory.breakdown(SPLIT_SITE)
    const parts = split.json?.site?.breakdown
    check('its split is 4 e-mail, 3 phone, 2 user name and 1 other, and it is stored on the site',
      split.status === 200 && parts?.email === 4 && parts.phone === 3 && parts.username === 2 && parts.other === 1, JSON.stringify(split.json).slice(0, 240))
    const kept = (await directory.list(`?host=${SPLIT_SITE}`)).json?.sites?.[0]?.breakdown
    check('and the list gives it back', kept?.email === 4 && kept.other === 1, JSON.stringify(kept))
    const ghost = await directory.breakdown(`ghost-${RUN}.example.test`)
    const typed = await directory.breakdown(`https://www.${SPLIT_SITE}/x`)
    check('a site that is not in the directory is 404 and a host as typed is 400', ghost.status === 404 && typed.status === 400, `${ghost.status} / ${typed.status}`)

    await marks.change({ host: SPLIT_SITE, status: 'todo' })
    const todo = await directory.list('?mark=todo')
    check('a mark set on the Site Counts side shows in the directory, and the chip finds it', todo.json?.sites?.some((s: { host: string }) => s.host === SPLIT_SITE) && todo.json.marks?.todo >= 1, JSON.stringify(todo.json?.marks))
    await marks.change({ host: SPLIT_SITE, status: null, note: null })
    const found = await directory.list(`?q=${encodeURIComponent(SPLIT_SITE.slice(0, 12).toUpperCase())}`)
    check('a search finds a site by a part of its host, whatever the case', found.json?.sites?.some((s: { host: string }) => s.host === SPLIT_SITE))

    // New rows arrive. The table's fingerprint changes; within a tick (a minute) and the settle time (5 s) the directory recounts the site and works the stored split out again.
    chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name) ${splitRows(5, `concat('late', toString(number), '-${RUN}@example.test')`)}`)
    const refreshed = await waitFor('the directory follows the new rows', async () => {
      const site = (await directory.list(`?host=${SPLIT_SITE}`)).json?.sites?.[0]
      return site?.count === 15 && site.breakdown?.email === 9 && site.breakdown.phone === 3 ? site : null
    }, 300_000, 5000)
    check('after new rows arrive the directory recounts the site (15 rows) and works its stored split out again (9 e-mail), by itself', !!refreshed)
    const current = await waitFor('every site current', async () => {
      const s = (await directory.status()).json
      return s?.state === 'current' && s.out_of_date === 0 ? s : null
    }, 180_000, 5000)
    check('and the status line says every site is current', !!current)

    const removed = await directory.remove(SPLIT_SITE)
    const gone = await directory.list(`?host=${SPLIT_SITE}`)
    const removedAgain = await directory.remove(SPLIT_SITE)
    check('Remove takes the site out (a second time: 404)', removed.status === 200 && gone.json?.sites?.length === 0 && removedAgain.status === 404, `${removed.status} / ${removedAgain.status}`)
    await counts({ domains: [SPLIT_SITE] })
    const back = (await directory.list(`?host=${SPLIT_SITE}`)).json?.sites?.[0]
    check('counted again, the site is back with its history reset (counted once, no split) and 15 rows', back?.times_counted === 1 && back.breakdown === null && back.count === 15, JSON.stringify(back).slice(0, 200))
    const directoryPage = await asSession('GET', '/directory')
    check('the Site Directory page is served', directoryPage.status === 200 && /Site Directory/.test(directoryPage.text), `status ${directoryPage.status}`)

```

- [ ] **Step 3: Bring the spec in line with what was built**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && python3 - <<'EOF'
p = 'docs/superpowers/specs/2026-11-21-site-directory-design.md'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a[:70]
    s = s.replace(a, b)
rep("and the chip numbers update at once.", "and the chip numbers are read again when the save is done.")
rep("While anything is out of date the page asks `GET /api/lookup/directory/status` every 30 s (the visible tab only).", "The page asks `GET /api/lookup/directory/status` every 30 s while its tab is visible.")
open(p, 'w').write(s)
print('ok')
EOF
python3 - <<'EOF'
p = '/home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory/app/docs/page.tsx'
s = open(p).read()
a = "The same counts are on the Site Counts page, which takes a pasted or uploaded list."
assert s.count(a) == 1
s = s.replace(a, a + " Every site counted here, by the page or by this route, is also kept in the Site Directory page for everyone who signs in (a count with an imported window adds the site but leaves its all-time numbers alone).")
open(p, 'w').write(s)
print('ok')
EOF
```
Expected: `ok` twice.

- [ ] **Step 4: Check the script compiles and nothing else broke**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npm run typecheck 2>&1 | tail -5 && npx vitest run __tests__/site-counts-page.test.ts __tests__/site-directory-page.test.ts 2>&1 | tail -4
```
Expected: no type errors (this includes `scripts/` and `__tests__/`); tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && git add README.md app/docs/page.tsx scripts/e2e-batch-lookup.ts docs/superpowers/specs/2026-11-21-site-directory-design.md && git commit -q -m "$(cat <<'EOF'
docs(site-directory): README and API docs say what the directory holds; the rehearsal drives it end to end; the spec matches what was built

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

---

### Task 9: Verify, rehearse, look at it in a browser, roll out

**Files:** none changed unless a check fails (then fix, re-run the failing check, and commit the fix on its own).

- [ ] **Step 1: The same gate CI runs**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npm run typecheck 2>&1 | tail -3 && npm test 2>&1 | tail -8
```
Expected: no type errors; every test file passes (the live tests are skipped without `BLK_LIVE=1`). Then:

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .js,.jsx,.ts,.tsx app components lib hooks 2>&1 | tail -5 && npm run build 2>&1 | tail -12
```
Expected: eslint prints nothing; the build ends with the route table including `/directory`, `/api/lookup/directory`, `/api/lookup/directory/breakdown`, `/api/lookup/directory/status`. (A "multiple lockfiles" warning is the nested-worktree artifact and is benign.)

- [ ] **Step 2: The live parity once more on the final commit (read-only, about 5 minutes)**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && BLK_LIVE=1 npx vitest run __tests__/site-directory.live.test.ts __tests__/site-counts.live.test.ts 2>&1 | tail -12
```
Expected: both files pass (the counts live test is the guard that the recording hook did not change a number).

- [ ] **Step 3: Build the candidate image and run the rehearsal on the isolated stack**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && D=$(mktemp -d) && echo '{}' > $D/config.json && git archive HEAD | DOCKER_CONFIG=$D docker build -t ulp-suite-app:directory-candidate - 2>&1 | tail -3
```
Expected: the build ends with the image written (`naming to docker.io/library/ulp-suite-app:directory-candidate`).

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && COOKIE_FILE=/tmp/claude-1000/-home-cole-Desktop-ulp-suite/83b2456e-d239-40bb-8a34-dc413216c472/scratchpad/rehearsal.cookie CANDIDATE_IMAGE=ulp-suite-app:directory-candidate npx tsx scripts/e2e-batch-lookup.ts --keep 2>&1 | tail -40
```
Expected: about 8 to 12 minutes; every line `PASS`; the last line `N/N checks passed` with N = 90 plus the new step-9 checks (about 20). The stack is left running (`--keep`). If a step-9 check fails, read the check's detail, fix the code, rebuild the candidate and run again from a clean stack (`REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v`, with a scoped `DOCKER_CONFIG`).

- [ ] **Step 4: Seed a directory of 1,000 sites on the rehearsal stack, to see the endless list**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && python3 - <<'EOF'
import json, urllib.request
scratch = '/tmp/claude-1000/-home-cole-Desktop-ulp-suite/83b2456e-d239-40bb-8a34-dc413216c472/scratchpad/rehearsal.cookie'
cookie = open(scratch).read().strip()
if not cookie.startswith('auth='): cookie = 'auth=' + cookie
for start in range(0, 1000, 100):
    domains = [f'bulk{n:04d}.corp.example' for n in range(start, start + 100)]
    req = urllib.request.Request('http://127.0.0.1:3101/api/lookup/counts', data=json.dumps({'domains': domains}).encode(),
                                 headers={'content-type': 'application/json', 'cookie': cookie})
    out = json.load(urllib.request.urlopen(req))
    assert out['success'], out
print('1,000 synthetic sites counted')
EOF
```
Expected: `1,000 synthetic sites counted`. (Invented hosts with no rows; they sort among the sites with none, by host.)

- [ ] **Step 5: Look at it in the Browser pane (the endless list can only be checked here)**

Follow the repo's procedure (memory note "Rehearsal UI check"): open the rehearsal as `http://localhost:3101` (not `127.0.0.1`: the live app shares that cookie jar), set its cookie from the cookie file with `javascript_tool` (`document.cookie = 'auth=<value>; path=/'`), reload, and clear the cookie when done. Drive inputs with the `computer` tool, not with dispatched events; read the DOM with `read_page`/`get_page_text`; a hidden pane does not paint, so `tabs_select` the tab first. Check, at 1440 px and again at 800 px (`resize_window`), and write down each result:

1. `/directory` shows the title, the search box, the mark chips with numbers, the status line ("N sites · numbers current") and the first 200 rows; the footer reads "200 sites loaded · scroll for more".
2. **One page per scroll, not all at once.** With `javascript_tool`, count the rows (`document.querySelectorAll('[aria-label^="Show the details of"], [aria-label^="Hide the details of"]').length`), scroll the list box to the bottom once, wait 2 s, count again: 400, then 600. After a long scroll to the end the footer reads "N sites · end of the directory" and N equals the total in the toolbar.
3. Sorting: click Rows (biggest first, then smallest first, then back); the list reloads and the box scrolls to the top; the row count is 200 again.
4. Search: type part of a host in lower case and upper case; the list narrows, the toolbar says "N sites match"; clearing it restores all.
5. Chips: set a mark on a row (the popover), the chip numbers change within a moment; the Todo chip finds it; clear the mark.
6. Open a row for a site that has rows (the seeded counts site from the rehearsal: `counts-*.example.test`): the detail shows the host/subdomain split, the top subdomains, "Working out the split…" then a bar and a legend of four parts that add up to the site's rows (all e-mail for that site), "Worked out … ago", the history line, Recount and Remove. Close and reopen: no second query (the split is stored). Open a bulk site (0 rows): "No rows, so nothing to split."
7. Recount works; Remove needs two clicks and the row disappears and the total drops by one.
8. At 800 px the page has no horizontal scroll, the wide columns are hidden and the numbers are in the detail.
9. Console: no errors (`read_console_messages`, errors only). Network: opening a row sent exactly one `POST /api/lookup/directory/breakdown`.
10. Open the Credentials page once: its footer still reads as it did ("N rows loaded · scroll for more").

If any check fails, fix it in code, rebuild the candidate (Step 3) and repeat the check; do not mark a check done from a unit test.

- [ ] **Step 6: Tear the rehearsal stack down**

```bash
cd /home/cole/Desktop/ulp-suite/.claude/worktrees/site-directory && D=$(mktemp -d) && echo '{}' > $D/config.json && DOCKER_CONFIG=$D REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v 2>&1 | tail -3
```
Expected: the `ulprehearsal_*` containers and volumes are removed (`docker ps -a --filter name=ulprehearsal_ -q` prints nothing). This `compose` call is the rehearsal project only, not the real stack.

- [ ] **Step 7: Merge, push, and deploy locally (the owner's standing permission: local only)**

Use `superpowers:finishing-a-development-branch` for the merge. In short: from the PRIMARY checkout, on `main`, fast-forward to the branch (a worktree branch cannot be merged from inside the worktree), then push:

```bash
cd /home/cole/Desktop/ulp-suite && git status -sb | head -3 && git merge --ff-only feat/site-directory 2>&1 | tail -3 && git push origin main 2>&1 | tail -2
```
Expected: clean tree before; fast-forward; push accepted. If `main` moved and the merge cannot fast-forward, rebase the branch onto `main` in the worktree, re-run Task 9 Steps 1 and 3, then merge. Then wait for CI once (`gh run list --branch main --limit 1`), do not poll.

Deploy exactly as the repo's convention says (rollback tag first, the candidate that was rehearsed, `compose` from the primary checkout only):

```bash
cd /home/cole/Desktop/ulp-suite && docker tag ulp-suite-app:latest ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz) && docker image inspect ulp-suite-app:directory-candidate --format '{{.Id}}' | cut -c1-19 && git rev-parse --short HEAD
```
Check that the candidate was built from the commit now at `HEAD` (same tree: `git diff --stat feat/site-directory HEAD` prints nothing, and the candidate was built from `git archive HEAD` of that tree). Then:

```bash
cd /home/cole/Desktop/ulp-suite && docker tag ulp-suite-app:directory-candidate ulp-suite-app:latest && D=$(mktemp -d) && echo '{}' > $D/config.json && DOCKER_CONFIG=$D docker compose up -d --no-deps --no-build app 2>&1 | tail -3
```
Expected: the `ulpsuite_app` container is recreated. Then verify, with evidence, before saying it is done:

```bash
cd /home/cole/Desktop/ulp-suite && docker inspect ulpsuite_app --format '{{.State.Health.Status}} {{.Image}}' && docker logs --since 5m ulpsuite_app 2>&1 | grep -i -E "site-directory|migration" | tail -8
```
Expected: `healthy`, the new image id, and a `[site-directory] cron started` line. Unauthenticated, `/directory` redirects to `/login` and `/api/lookup/directory` answers 401. Do not sign in as the owner; ask them to open the page.

- [ ] **Step 8: Record it**

Update `/home/cole/.claude/projects/-home-cole-Desktop-ulp-suite/memory/project_site_directory_design_2026_11_21.md` (state: BUILT + DEPLOYED, the commit, the image ids, the rollback tag, the rehearsal count, the measured breakdown shape) and its `MEMORY.md` line; set the spec's `Status:` line to implemented and deployed with the commit and image ids; commit that spec change on `main` and push.
