# Site Marks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Site Counts page a person can mark each site Done, Skip or To look at, add a note, and find the mark again whenever the site comes up in a later count; the table can be narrowed and sorted by mark.

**Architecture:** One SQLite table (`site_marks`, keyed by the host the counts name) behind one session route (`POST` reads the marks of a list, `PUT` changes one site); a framework-free client store that orders the saves and puts a failed one back; three small components (the mark cell with its menu, the row, the mark chips) that the page composes. The pure parts (statuses, merge, rank, filter, tooltip words) live in `lib/site-marks-input.ts` and are shared by the server, the store and the page, so the three cannot drift apart.

**Tech Stack:** TypeScript, Next.js 15 route handlers and client components, React 19 (`useSyncExternalStore`), better-sqlite3, Radix Popover (`components/ui/popover.tsx`), Tailwind, vitest (a real SQLite file per worker; `react-dom/server` for render tests), the isolated rehearsal stack.

Spec: `docs/superpowers/specs/2026-10-29-site-marks-design.md` (design approved by the owner on 2026-10-29, spec approved the same day: "Continue").

## Global Constraints

- A mark is a **status** (`done`, `skip`, `todo`; labels `Done`, `Skip`, `To look at`) and a **note**, each optional; a row exists while either is set. "No mark" means no status: a site with a note and no status is "No mark" with a note.
- The key is the host the counts name. The server accepts a host for writing only when `siteEntry(host).host === host` and looks hosts up exactly as given. A row with no host, or whose host the cleaning would change again (three or more leading `www.`), has no mark control.
- A note is at most **500** characters, trimmed; a blank note is no note. A read carries at most **2,000** hosts (`SITE_COUNTS_MAX_PER_LIST`).
- Storage is SQLite: table `site_marks (host PRIMARY KEY, status, note, updated_by, updated_at)`, additive (`CREATE TABLE IF NOT EXISTS`), `CHECK (status IS NOT NULL OR note IS NOT NULL)`; the status is checked in code, not by a `CHECK` on its values. No ClickHouse change and no new setting, so `docker-compose.yml` and `.env.example` stay as they are.
- Interface: `/api/lookup/marks`, session only, any signed-in user (admin or analyst), not on `/api/v1`. `POST { hosts }` reads; `PUT { host, status?, note? }` changes: a field left out keeps its value, `null` clears it, a change that changes nothing writes nothing, and with neither field left the row is deleted. 400 for refused input, 401 without a session, 500 logged with `console.error` (the production build strips `console.log`).
- The mark is shared by everyone who signs in; each keeps who changed it last and when (`updated_at` is returned as SQLite stores it and formatted with `formatRelativeTime`).
- Page: a 48 px cell (`w-12`) between the site name and Rows at every width; the header above it is `Mark`, a sort header. The menu has No mark, Done, Skip, To look at and a note box (500 characters) that is saved when the menu closes (a click away, Esc or Ctrl+Enter); a mark click saves an unsaved note in the same request. Marks that are loading or failed are never shown as "No mark".
- Sort on Mark: To look at, then No mark, then Done, then Skip; a second click reverses it, a third restores the default order; a row that cannot show a mark goes last whichever way.
- Chips: All, Done, Skip, To look at, No mark (a site that can be marked and has no status). The badges and "rows in all" keep describing the whole count; a filtered table says "Showing N of M" with a way back; the filter survives counting again. Export CSV follows the table on screen and reads "Export CSV (N)" while a chip is on; the file has no mark column.
- The repository is public: tests, docs and commit messages use invented hosts (`corp.example`, `shop.example`); never a site, a search term or a note from the owner's lists.
- Gate before every merge (what CI runs): `npm run typecheck` (the app, then `scripts/` and `__tests__/`), `npm test`, `npm run lint`, `npm run build`. Check exit codes explicitly.
- Deploys are local only: tag the running image first, build a candidate under its own tag, rehearse it with `REHEARSAL_APP_IMAGE`, and run `docker compose` from the primary checkout only (from a worktree it blanks `.env` and serves an empty database).

---

## Before you start

- **Work in an isolated worktree** (`superpowers:using-git-worktrees`; this repo keeps them in `.claude/worktrees/`). The spec and this plan are commits on the local `main` that are not pushed, and a new worktree branches from `origin/main`: run `git merge main --ff-only` inside the new worktree first, then check `ls docs/superpowers/plans/2026-10-29-site-marks.md`.
- A fresh worktree has an empty `node_modules`: run `npm install` before anything else.
- In a nested worktree `next lint` fails with "Plugin @next/next was conflicted". Lint with `npx eslint --no-eslintrc -c .eslintrc.json <paths>` instead (it is the same config); in the primary checkout `npm run lint` is fine.
- A worktree session refuses Bash that is "too complex" (variable loops, `bash script.sh`, `$(git ...)`). Keep commands simple, and commit with `git commit -m "<subject>" -m "<trailer>"` as the steps show.
- Use paths relative to the worktree root. Only the deploy in Task 9 runs from the primary checkout (the repository root, not the worktree).
- End every commit message with the attribution trailer your session instructs; the steps show `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Keep the review loops lean: after a task, one round of fixes and one re-review at most.
- Never put a real site, search term or note of the owner's in a test, a doc or a commit.
- **Do not try `next dev` for the browser check.** The app's CSP (`next.config.mjs`) has no `unsafe-eval`, which the dev server's React Refresh needs, so a page served by `next dev` never hydrates. Use the built image on the rehearsal stack (Task 9).

## What was proven before this plan was written

Every file below was first written into a throwaway export of commit `2f96546` (nothing of it is in the repository) and checked there: the new tests (130 of them: the suite went from 4,542 to 4,672 passed, 111 skipped), `tsc` for both configs, eslint on `app lib components hooks`, `next build`, 22 mutations (all caught: see Task 8), and the production build of that copy run in the browser pane against a real SQLite file: the menu, a mark with a note saved in one request, two spellings of one site showing one mark, the chips, the sort in all three states, the "Export CSV (N)" label, a failed marks load (warnings, an alert with the reason, chips and sort off, then Retry), and no page overflow at 1440, 1280, 1100 and 375 px (the site-name column measured 306, 146, 306 and 131 px; the Mark header's content 47 of its 48 px). That is why the code below is complete. It still has to pass this plan's own gates, the rehearsal and the pane check on the built image.

## File structure

| File | Responsibility |
|---|---|
| `lib/site-marks-input.ts` (new) | Pure and importable by a page: the statuses, labels and limits, `isMarkableHost`, `normalizeNote`, `checkMarkPatch`, `mergeMark`, `markStateOf`, `markRank`, the chips' test and counts, the words of a cell |
| `lib/site-counts-input.ts` (edit) | `SiteSortKey` gains `'mark'`; `orderSiteRows` takes the rank of each row's mark |
| `lib/sqlite.ts` (edit) | The `site_marks` table in `initSchema` |
| `lib/site-marks.ts` (new) | The server side: read, change, and the answers of the two verbs |
| `app/api/lookup/marks/route.ts` (new) | Session check, then hands the body to the library |
| `lib/site-marks-client.ts` (new) | The page's store, no React in it: order of saves, rollback, load state |
| `components/site-mark-cell.tsx` (new) | `MarkIcon`, `SiteMarkMenu`, `SiteMarkCell`, `MARK_CELL` |
| `components/site-mark-filter.tsx` (new) | The chips |
| `components/site-count-row.tsx` (new) | `SiteRow`, `COLS`, `fmt`, `CountRow`, moved out of the page so a test can render them |
| `app/counts/page.tsx` (edit) | Composes all of it |
| `README.md`, `scripts/e2e-batch-lookup.ts` (edit) | The feature bullet; rehearsal step 8 |
| `__tests__/` (8 files) | `site-marks-input`, `site-counts-input` (append), `site-marks`, `site-marks-routes`, `site-marks-client`, `site-mark-cell`, `site-count-row`, `site-counts-page` |

---

### Task 1: The pure marks module, and the Mark sort

**Files:**
- Create: `lib/site-marks-input.ts`
- Modify: `lib/site-counts-input.ts` (`SiteSortKey`, `orderSiteRows`)
- Test: create `__tests__/site-marks-input.test.ts`; append to `__tests__/site-counts-input.test.ts`

**Interfaces:**
- Consumes: `siteEntry`, `SITE_COUNTS_MAX_PER_LIST` (`lib/site-counts-input.ts`), `formatRelativeTime` (`lib/format-relative-time.ts`).
- Produces (used by Tasks 2 to 7), all exported from `lib/site-marks-input.ts`:
  - `SITE_MARK_STATUSES` (`['done','skip','todo']`), `type SiteMarkStatus`, `SITE_MARK_LABELS: Record<SiteMarkStatus, string>`, `NO_MARK_LABEL`, `SITE_MARK_NOTE_MAX` (500), `SITE_MARKS_MAX_HOSTS` (2000)
  - `interface SiteMark { status: SiteMarkStatus | null; note: string | null; updated_by: string | null; updated_at: string | null }`, `interface SiteMarkPatch { status?: SiteMarkStatus | null; note?: string | null }`
  - `isMarkableHost(host: string): boolean`, `normalizeNote(note: string | null | undefined): string | null`
  - `checkMarkPatch(body: Record<string, unknown>): { ok: true; patch: SiteMarkPatch } | { ok: false; error: string }`
  - `mergeMark(current: { status; note } | null, patch: SiteMarkPatch): { status: SiteMarkStatus | null; note: string | null } | null`
  - `type MarkState = SiteMarkStatus | 'none' | null`, `markStateOf(host, marks, loaded): MarkState`, `markRank(state): number | null`
  - `type MarkFilter = 'all' | SiteMarkStatus | 'none'`, `MARK_FILTERS`, `MARK_FILTER_LABELS`, `matchesMarkFilter(state, filter): boolean`, `markFilterCounts(states): Record<MarkFilter, number>`
  - `markTitle(mark: SiteMark | null): string`, `markAriaLabel(host: string, mark: SiteMark | null): string`
  - From `lib/site-counts-input.ts`: `SiteSortKey` now includes `'mark'`, and `orderSiteRows(rows, sort, markRankOf?: (row) => number | null)`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/site-marks-input.test.ts`:

```ts
import { describe, test, expect, vi, afterEach } from 'vitest'
import { SITE_COUNTS_MAX_PER_LIST, siteEntry } from '@/lib/site-counts-input'
import {
  MARK_FILTERS,
  MARK_FILTER_LABELS,
  NO_MARK_LABEL,
  SITE_MARKS_MAX_HOSTS,
  SITE_MARK_LABELS,
  SITE_MARK_NOTE_MAX,
  SITE_MARK_STATUSES,
  checkMarkPatch,
  isMarkableHost,
  markAriaLabel,
  markFilterCounts,
  markRank,
  markStateOf,
  markTitle,
  matchesMarkFilter,
  mergeMark,
  normalizeNote,
  type MarkState,
  type SiteMark,
} from '@/lib/site-marks-input'

const mark = (status: SiteMark['status'], note: string | null = null, by: string | null = 'a@example.test', at: string | null = '2026-10-29 10:00:00'): SiteMark => ({
  status, note, updated_by: by, updated_at: at,
})

afterEach(() => vi.useRealTimers())

describe('the statuses', () => {
  test('are done, skip and to look at, in the order the menu lists them, each with a label', () => {
    expect([...SITE_MARK_STATUSES]).toEqual(['done', 'skip', 'todo'])
    expect(SITE_MARK_LABELS).toEqual({ done: 'Done', skip: 'Skip', todo: 'To look at' })
    expect(NO_MARK_LABEL).toBe('No mark')
  })

  test('a note is capped at 500 characters, and a read takes as many hosts as a list may hold', () => {
    expect(SITE_MARK_NOTE_MAX).toBe(500)
    expect(SITE_MARKS_MAX_HOSTS).toBe(SITE_COUNTS_MAX_PER_LIST)
    expect(SITE_MARKS_MAX_HOSTS).toBe(2000)
  })

  test('the filter chips are All, the three statuses, then No mark', () => {
    expect([...MARK_FILTERS]).toEqual(['all', 'done', 'skip', 'todo', 'none'])
    expect(MARK_FILTER_LABELS).toEqual({ all: 'All', done: 'Done', skip: 'Skip', todo: 'To look at', none: 'No mark' })
  })
})

describe('isMarkableHost — the key a mark is kept under', () => {
  test('is a host the cleaning leaves as it is', () => {
    expect(isMarkableHost('corp.example')).toBe(true)
    expect(isMarkableHost('app.corp.example')).toBe(true)
  })

  test('is not text with no host, or a host as it was typed', () => {
    for (const typed of ['', 'localhost', 'https://www.corp.example/login', 'www.corp.example', '*.corp.example', 'Corp.Example', 'corp.example:8443']) {
      expect(isMarkableHost(typed)).toBe(false)
    }
  })

  test('every spelling of a site the counts clean to one host gives a host that can be marked, the same one', () => {
    const spellings = ['corp.example', 'https://www.corp.example/login', '*.corp.example', 'HTTP://WWW.Corp.Example:8443/a?b=1#c', '.corp.example', 'www.www.corp.example', '*.www.corp.example']
    const hosts = spellings.map(s => siteEntry(s).host)
    expect(new Set(hosts)).toEqual(new Set(['corp.example']))
    expect(hosts.every(isMarkableHost)).toBe(true)
  })

  test('three leading www. is the one shape the cleaning still changes on a second pass: such a host cannot be marked', () => {
    expect(isMarkableHost(siteEntry('www.www.corp.example').host)).toBe(true)
    expect(siteEntry('www.www.www.corp.example').host).toBe('www.corp.example')
    expect(isMarkableHost(siteEntry('www.www.www.corp.example').host)).toBe(false)
  })
})

describe('normalizeNote', () => {
  test('trims, and nothing left is null', () => {
    expect(normalizeNote('  looked at it  ')).toBe('looked at it')
    expect(normalizeNote('')).toBeNull()
    expect(normalizeNote('   \n\t ')).toBeNull()
    expect(normalizeNote(null)).toBeNull()
    expect(normalizeNote(undefined)).toBeNull()
  })

  test('keeps the line breaks inside a note', () => {
    expect(normalizeNote(' first\nsecond ')).toBe('first\nsecond')
  })
})

describe('checkMarkPatch — what a PUT body asks for', () => {
  test('a status alone, a note alone, or both; the host in the body is not part of the patch', () => {
    expect(checkMarkPatch({ host: 'corp.example', status: 'done' })).toEqual({ ok: true, patch: { status: 'done' } })
    expect(checkMarkPatch({ note: '  checked  ' })).toEqual({ ok: true, patch: { note: 'checked' } })
    expect(checkMarkPatch({ status: 'todo', note: 'later' })).toEqual({ ok: true, patch: { status: 'todo', note: 'later' } })
  })

  test('null clears a field, and an empty or blank note is null', () => {
    expect(checkMarkPatch({ status: null })).toEqual({ ok: true, patch: { status: null } })
    expect(checkMarkPatch({ note: null })).toEqual({ ok: true, patch: { note: null } })
    expect(checkMarkPatch({ note: '' })).toEqual({ ok: true, patch: { note: null } })
    expect(checkMarkPatch({ note: '   ' })).toEqual({ ok: true, patch: { note: null } })
  })

  test('with neither field it is refused, and an undefined field counts as absent', () => {
    expect(checkMarkPatch({})).toEqual({ ok: false, error: 'Send a status, a note or both' })
    expect(checkMarkPatch({ host: 'corp.example' })).toEqual({ ok: false, error: 'Send a status, a note or both' })
    expect(checkMarkPatch({ status: undefined, note: undefined })).toEqual({ ok: false, error: 'Send a status, a note or both' })
  })

  test('a status outside the list, and a note that is not text, are refused', () => {
    expect(checkMarkPatch({ status: 'finished' })).toEqual({ ok: false, error: 'status must be one of done, skip, todo, or null' })
    expect(checkMarkPatch({ status: 3 })).toMatchObject({ ok: false })
    expect(checkMarkPatch({ status: '' })).toMatchObject({ ok: false })
    expect(checkMarkPatch({ note: 5 })).toEqual({ ok: false, error: 'note must be text, or null' })
  })

  test('a note of 500 characters is kept, 501 is refused, and the cap counts what is left after trimming', () => {
    expect(checkMarkPatch({ note: 'x'.repeat(500) })).toMatchObject({ ok: true })
    expect(checkMarkPatch({ note: 'x'.repeat(501) })).toEqual({ ok: false, error: 'note is at most 500 characters' })
    expect(checkMarkPatch({ note: ` ${'x'.repeat(500)} ` })).toMatchObject({ ok: true })
  })
})

describe('mergeMark — a mark after a change', () => {
  test('a status on a site with no mark', () => {
    expect(mergeMark(null, { status: 'done' })).toEqual({ status: 'done', note: null })
  })

  test('a field left out keeps its value, so a status change keeps the note and a note change keeps the status', () => {
    expect(mergeMark({ status: 'done', note: 'a' }, { status: 'skip' })).toEqual({ status: 'skip', note: 'a' })
    expect(mergeMark({ status: 'done', note: 'a' }, { note: 'b' })).toEqual({ status: 'done', note: 'b' })
  })

  test('null clears a field and a blank note clears the note', () => {
    expect(mergeMark({ status: 'done', note: 'a' }, { note: null })).toEqual({ status: 'done', note: null })
    expect(mergeMark({ status: null, note: 'a' }, { note: '  ' })).toBeNull()
  })

  test('a note alone is a mark with no status, and a status can be added to it', () => {
    expect(mergeMark(null, { note: 'only a note' })).toEqual({ status: null, note: 'only a note' })
    expect(mergeMark({ status: null, note: 'a' }, { status: 'todo' })).toEqual({ status: 'todo', note: 'a' })
  })

  test('with neither a status nor a note left there is no mark', () => {
    expect(mergeMark({ status: 'done', note: null }, { status: null })).toBeNull()
    expect(mergeMark({ status: 'done', note: 'a' }, { status: null, note: null })).toBeNull()
    expect(mergeMark(null, {})).toBeNull()
  })

  test('the note is stored trimmed', () => {
    expect(mergeMark(null, { note: '  x ' })).toEqual({ status: null, note: 'x' })
  })
})

describe('markStateOf — what a row can show', () => {
  const marks = { 'a.example': mark('done'), 'b.example': mark(null, 'a note only'), 'c.example': mark('todo', 'and a note') }

  test('a status, or none for a site that can be marked and has no status (a note alone is not a mark)', () => {
    expect(markStateOf('a.example', marks, true)).toBe('done')
    expect(markStateOf('c.example', marks, true)).toBe('todo')
    expect(markStateOf('b.example', marks, true)).toBe('none')
    expect(markStateOf('d.example', marks, true)).toBe('none')
  })

  test('null when the marks are not loaded: never none, or a person could save over a note they cannot see', () => {
    expect(markStateOf('a.example', marks, false)).toBeNull()
    expect(markStateOf('d.example', {}, false)).toBeNull()
  })

  test('null for a row with no host, and for a host that cannot be marked', () => {
    expect(markStateOf('', marks, true)).toBeNull()
    expect(markStateOf('localhost', marks, true)).toBeNull()
    expect(markStateOf('www.corp.example', marks, true)).toBeNull()
  })
})

describe('markRank — the order of the Mark column', () => {
  test('to look at first, then no mark, then done, then skip', () => {
    expect((['todo', 'none', 'done', 'skip'] as const).map(markRank)).toEqual([3, 2, 1, 0])
  })

  test('a row that cannot show a mark has no rank', () => {
    expect(markRank(null)).toBeNull()
  })
})

describe('matchesMarkFilter and markFilterCounts — the chips', () => {
  const states: MarkState[] = ['done', 'done', 'skip', 'todo', 'none', 'none', 'none', null]

  test('All shows every row, one that cannot show a mark included; the others show their own state only', () => {
    expect(states.filter(s => matchesMarkFilter(s, 'all'))).toHaveLength(8)
    expect(states.filter(s => matchesMarkFilter(s, 'done'))).toEqual(['done', 'done'])
    expect(states.filter(s => matchesMarkFilter(s, 'skip'))).toEqual(['skip'])
    expect(states.filter(s => matchesMarkFilter(s, 'todo'))).toEqual(['todo'])
    expect(states.filter(s => matchesMarkFilter(s, 'none'))).toEqual(['none', 'none', 'none'])
  })

  test('No mark never takes a row that cannot show a mark', () => {
    expect(matchesMarkFilter(null, 'none')).toBe(false)
    expect(matchesMarkFilter(null, 'done')).toBe(false)
    expect(matchesMarkFilter(null, 'all')).toBe(true)
  })

  test('each chip counts the rows it would show', () => {
    expect(markFilterCounts(states)).toEqual({ all: 8, done: 2, skip: 1, todo: 1, none: 3 })
    expect(markFilterCounts([])).toEqual({ all: 0, done: 0, skip: 0, todo: 0, none: 0 })
  })
})

describe('markTitle and markAriaLabel — the words of a cell', () => {
  test('a site with no mark says so', () => {
    expect(markTitle(null)).toBe('No mark')
    expect(markAriaLabel('corp.example', null)).toBe('Mark for corp.example: No mark')
  })

  test('the label, the note and who set it, with the time relative to now', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
    expect(markTitle(mark('skip', 'dead company'))).toBe('Skip\ndead company\na@example.test, 2 hours ago')
    expect(markAriaLabel('corp.example', mark('skip', 'dead company'))).toBe('Mark for corp.example: Skip, has a note')
  })

  test('a note longer than 200 characters is cut in the tooltip', () => {
    const title = markTitle(mark('done', 'n'.repeat(300), null, null))
    expect(title.split('\n')[1]).toBe(`${'n'.repeat(200)}…`)
  })

  test('a mark whose change the server has not answered yet has no who and when', () => {
    expect(markTitle(mark('todo', null, null, null))).toBe('To look at')
  })
})
```

Append this to the end of `__tests__/site-counts-input.test.ts` (its imports already have `orderSiteRows`, `nextSiteSort` and `SiteCount`):

```ts

describe('orderSiteRows — the Mark column', () => {
  const counted = (host: string, count: number): SiteCount => ({
    host, found: count > 0, count, host_count: count, subdomain_count: 0, subdomains: 0, top_subdomains: [],
  })
  const row = (site: string, count: number) => ({ site, result: counted(`${site}.tld`, count) })
  const names = (rows: Array<{ site: string }>) => rows.map(r => r.site)

  // In the order pasted, with the rank the page gives each row's mark: 3 to look at, 2 no mark, 1 done, 0 skip, null cannot show a mark.
  const pasted = [row('a', 10), row('b', 50), row('c', 30), row('d', 20), row('e', 40), row('f', 5)]
  const ranks: Record<string, number | null> = { a: 1, b: 3, c: 2, d: null, e: 3, f: 0 }
  const rankOf = (r: { site: string }) => ranks[r.site]

  test('the first click puts what is left to look at on top; rows that tie keep the default order, the most rows first', () => {
    expect(names(orderSiteRows(pasted, { key: 'mark', direction: 'desc' }, rankOf))).toEqual(['b', 'e', 'c', 'a', 'f', 'd'])
  })

  test('the other way reverses the ranks, and a row that cannot show a mark is last both ways, never taken for a rank', () => {
    expect(names(orderSiteRows(pasted, { key: 'mark', direction: 'asc' }, rankOf))).toEqual(['f', 'a', 'c', 'b', 'e', 'd'])
  })

  test('without a rank function every row ties, so the default order stands', () => {
    expect(names(orderSiteRows(pasted, { key: 'mark', direction: 'desc' }))).toEqual(names(orderSiteRows(pasted, null)))
    expect(names(orderSiteRows(pasted, { key: 'mark', direction: 'asc' }))).toEqual(names(orderSiteRows(pasted, null)))
  })

  test('the rank function is not asked about the number columns', () => {
    const asked: string[] = []
    orderSiteRows(pasted, { key: 'count', direction: 'desc' }, r => { asked.push(r.site); return 0 })
    expect(asked).toEqual([])
  })

  test('the Mark header cycles like the number columns: biggest rank first, reversed, then the default order', () => {
    const first = nextSiteSort(null, 'mark')
    expect(first).toEqual({ key: 'mark', direction: 'desc' })
    const second = nextSiteSort(first, 'mark')
    expect(second).toEqual({ key: 'mark', direction: 'asc' })
    expect(nextSiteSort(second, 'mark')).toBeNull()
    expect(nextSiteSort({ key: 'count', direction: 'asc' }, 'mark')).toEqual({ key: 'mark', direction: 'desc' })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/site-marks-input.test.ts __tests__/site-counts-input.test.ts`
Expected: FAIL. `site-marks-input.test.ts` cannot load (`Failed to resolve import "@/lib/site-marks-input"`), and in `site-counts-input.test.ts` the first two tests of "orderSiteRows — the Mark column" fail (2 failed, 40 passed): the other three already hold for the old code.

- [ ] **Step 3: Create the module**

Create `lib/site-marks-input.ts`:

```ts
/**
 * Marks on the Site Counts page, in the parts the page (a client component), its marks store and the routes share (design:
 * docs/superpowers/specs/2026-10-29-site-marks-design.md). The SQLite side is lib/site-marks.ts, which a page cannot import.
 *
 * A mark is a status and a note, each optional, kept per site: the host the counts name. A change names only the fields it touches: a field left out
 * keeps its value, null clears it, and a site with neither left has no mark.
 */
import { formatRelativeTime } from '@/lib/format-relative-time'
import { SITE_COUNTS_MAX_PER_LIST, siteEntry } from '@/lib/site-counts-input'

/** The statuses, in the order the menu lists them. A fourth is one entry here and one in SITE_MARK_LABELS: the column is text, so there is no migration. */
export const SITE_MARK_STATUSES = ['done', 'skip', 'todo'] as const
export type SiteMarkStatus = (typeof SITE_MARK_STATUSES)[number]

export const SITE_MARK_LABELS: Record<SiteMarkStatus, string> = { done: 'Done', skip: 'Skip', todo: 'To look at' }

/** What a site with no status is called. Not "Clear": the list panel already has a Clear, for the pasted list. */
export const NO_MARK_LABEL = 'No mark'

/** A note is a reminder, not a document: this bounds the tooltip, the menu and the answer. */
export const SITE_MARK_NOTE_MAX = 500

/** Hosts one read may carry: a whole list, as many as the page takes. */
export const SITE_MARKS_MAX_HOSTS = SITE_COUNTS_MAX_PER_LIST

/** How much of a note the tooltip of a cell shows. */
const TITLE_NOTE_MAX = 200

/** What the server stores and answers for one site. updated_by and updated_at are null only on the page, for a change the server has not answered yet. */
export interface SiteMark {
  status: SiteMarkStatus | null
  note: string | null
  updated_by: string | null
  updated_at: string | null
}

/** A change to one site: a field left out keeps its stored value, null clears it. */
export interface SiteMarkPatch {
  status?: SiteMarkStatus | null
  note?: string | null
}

/**
 * A host the marks can be kept under: one the counts name and the cleaning leaves as it is. A row with no host (not a site address) has no mark, and
 * neither has the one shape the cleaning still changes on a second pass (three or more leading `www.`), so the page and the server can never disagree
 * about a key.
 */
export function isMarkableHost(host: string): boolean {
  return host !== '' && siteEntry(host).host === host
}

/** A note as it is stored: trimmed, and null when nothing is left. */
export function normalizeNote(note: string | null | undefined): string | null {
  const trimmed = (note ?? '').trim()
  return trimmed === '' ? null : trimmed
}

const isStatus = (value: unknown): value is SiteMarkStatus => (SITE_MARK_STATUSES as readonly unknown[]).includes(value)

export type PatchCheck = { ok: true; patch: SiteMarkPatch } | { ok: false; error: string }

/** The change a request body asks for, or why it is refused. A field that is absent (or undefined) is left out of the patch; the host is the caller's to check. */
export function checkMarkPatch(body: Record<string, unknown>): PatchCheck {
  const patch: SiteMarkPatch = {}
  const status = body.status
  if (status !== undefined) {
    if (status !== null && !isStatus(status)) return { ok: false, error: `status must be one of ${SITE_MARK_STATUSES.join(', ')}, or null` }
    patch.status = status
  }
  const rawNote = body.note
  if (rawNote !== undefined) {
    if (rawNote !== null && typeof rawNote !== 'string') return { ok: false, error: 'note must be text, or null' }
    const note = normalizeNote(rawNote)
    if (note !== null && note.length > SITE_MARK_NOTE_MAX) return { ok: false, error: `note is at most ${SITE_MARK_NOTE_MAX} characters` }
    patch.note = note
  }
  if (patch.status === undefined && patch.note === undefined) return { ok: false, error: 'Send a status, a note or both' }
  return { ok: true, patch }
}

/**
 * A site's mark after a change, or null when neither a status nor a note is left (then the site has no mark and a stored row is deleted). The server
 * writes this and the page shows it before the server has answered, so the two cannot drift apart.
 */
export function mergeMark(
  current: { status: SiteMarkStatus | null; note: string | null } | null,
  patch: SiteMarkPatch,
): { status: SiteMarkStatus | null; note: string | null } | null {
  const status = patch.status !== undefined ? patch.status : (current?.status ?? null)
  const note = patch.note !== undefined ? normalizeNote(patch.note) : (current?.note ?? null)
  return status === null && note === null ? null : { status, note }
}

/**
 * What the table knows about a row's mark: its status, 'none' (it can be marked and has no status), or null (it cannot show one: it has no host, or the
 * marks are not loaded). null is never read as 'none': that would let a person save over a note they cannot see.
 */
export type MarkState = SiteMarkStatus | 'none' | null

export function markStateOf(host: string, marks: Readonly<Record<string, SiteMark>>, loaded: boolean): MarkState {
  if (!loaded || !isMarkableHost(host)) return null
  return marks[host]?.status ?? 'none'
}

/** The order of the Mark column, biggest first (the first click): To look at, then No mark, then Done, then Skip. null: the row goes last whichever way. */
const RANK: Record<SiteMarkStatus | 'none', number> = { todo: 3, none: 2, done: 1, skip: 0 }

export function markRank(state: MarkState): number | null {
  return state === null ? null : RANK[state]
}

export type MarkFilter = 'all' | SiteMarkStatus | 'none'

export const MARK_FILTERS: readonly MarkFilter[] = ['all', ...SITE_MARK_STATUSES, 'none']

export const MARK_FILTER_LABELS: Record<MarkFilter, string> = { all: 'All', ...SITE_MARK_LABELS, none: NO_MARK_LABEL }

/** All shows every row, one that cannot show a mark included; the others show the rows of that state only. */
export function matchesMarkFilter(state: MarkState, filter: MarkFilter): boolean {
  return filter === 'all' || state === filter
}

/** How many rows each chip would show. */
export function markFilterCounts(states: MarkState[]): Record<MarkFilter, number> {
  const counts: Record<MarkFilter, number> = { all: states.length, done: 0, skip: 0, todo: 0, none: 0 }
  for (const state of states) if (state !== null) counts[state] += 1
  return counts
}

/** The tooltip of a cell: the label, the note (its first 200 characters), then who set it and when. */
export function markTitle(mark: SiteMark | null): string {
  const lines = [mark?.status ? SITE_MARK_LABELS[mark.status] : NO_MARK_LABEL]
  if (mark?.note) lines.push(mark.note.length > TITLE_NOTE_MAX ? `${mark.note.slice(0, TITLE_NOTE_MAX)}…` : mark.note)
  if (mark?.updated_by && mark.updated_at) lines.push(`${mark.updated_by}, ${formatRelativeTime(mark.updated_at)}`)
  return lines.join('\n')
}

/** The accessible name of a cell: which site, what mark, and whether a note is there. */
export function markAriaLabel(host: string, mark: SiteMark | null): string {
  const label = mark?.status ? SITE_MARK_LABELS[mark.status] : NO_MARK_LABEL
  return `Mark for ${host}: ${label}${mark?.note ? ', has a note' : ''}`
}
```

- [ ] **Step 4: Teach the sort about the Mark column**

In `lib/site-counts-input.ts` (edit 1 of 2), replace:

```text
/** The numbers of a site's row a person can sort by: the number columns of the Site Counts table. */
export type SiteSortKey = 'count' | 'host_count' | 'subdomain_count' | 'subdomains'
```

with:

```text
/** What a person can sort the Site Counts table by: its number columns, and the Mark column (whose rank the page supplies: see orderSiteRows). */
export type SiteSortKey = 'count' | 'host_count' | 'subdomain_count' | 'subdomains' | 'mark'
```

In `lib/site-counts-input.ts` (edit 2 of 2), replace:

```text
 * way, never as a zero; sites that tie keep the default order, so equal numbers still list the biggest sites first. The list given is not changed.
 */
export function orderSiteRows<T extends { result: SiteCount }>(rows: T[], sort: SiteSort | null): T[] {
  const rank = (r: SiteCount) => (r.error ? 0 : r.count && r.count > 0 ? 1 : 2)
  const byDefault = (a: T, b: T) => rank(a.result) - rank(b.result) || (b.result.count ?? 0) - (a.result.count ?? 0)
  if (sort === null) return [...rows].sort(byDefault)
  const sign = sort.direction === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const x = a.result[sort.key]
    const y = b.result[sort.key]
```

with:

```text
 * way, never as a zero; sites that tie keep the default order, so equal numbers still list the biggest sites first. The list given is not changed.
 * The Mark column has no number in the counts: `markRankOf` gives each row's rank (markRank in lib/site-marks-input.ts), null for a row that cannot show a
 * mark, which goes last like a site with no number. Without it every row ties on the Mark column.
 */
export function orderSiteRows<T extends { result: SiteCount }>(rows: T[], sort: SiteSort | null, markRankOf?: (row: T) => number | null): T[] {
  const rank = (r: SiteCount) => (r.error ? 0 : r.count && r.count > 0 ? 1 : 2)
  const byDefault = (a: T, b: T) => rank(a.result) - rank(b.result) || (b.result.count ?? 0) - (a.result.count ?? 0)
  if (sort === null) return [...rows].sort(byDefault)
  const { key, direction } = sort
  const sign = direction === 'desc' ? -1 : 1
  const valueOf = (row: T): number | null => (key === 'mark' ? (markRankOf?.(row) ?? null) : row.result[key])
  return [...rows].sort((a, b) => {
    const x = valueOf(a)
    const y = valueOf(b)
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run __tests__/site-marks-input.test.ts __tests__/site-counts-input.test.ts`
Expected: PASS: `Test Files  2 passed (2)`, `Tests  74 passed (74)` (32 in `site-marks-input`, 42 in `site-counts-input`).

- [ ] **Step 6: Commit**

```bash
git add lib/site-marks-input.ts lib/site-counts-input.ts __tests__/site-marks-input.test.ts __tests__/site-counts-input.test.ts
git commit -m "feat(marks): the pure marks module, and a sort by mark for the site counts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The `site_marks` table and its store

**Files:**
- Modify: `lib/sqlite.ts` (`initSchema`)
- Create: `lib/site-marks.ts`
- Test: create `__tests__/site-marks.test.ts`

**Interfaces:**
- Consumes (Task 1): `SITE_MARKS_MAX_HOSTS`, `checkMarkPatch`, `isMarkableHost`, `mergeMark`, `SiteMark`, `SiteMarkPatch`, `SiteMarkStatus`; from `lib/sqlite.ts`: `dbGet`, `dbQuery`, `dbRun`, `dbTransaction`.
- Produces (used by Task 3):
  - `readSiteMarks(hosts: string[]): Record<string, SiteMark>`
  - `changeSiteMark(host: string, patch: SiteMarkPatch, by: string | null): SiteMark | null`
  - `interface MarksReply { status: number; json: Record<string, unknown> }`
  - `answerMarksRead(rawBody: unknown): MarksReply`, `answerMarkChange(rawBody: unknown, by: string | null): MarksReply`

- [ ] **Step 1: Write the failing test**

These tests run on the real SQLite file of the vitest worker (`__tests__/setup/`), so the SQL itself is what is proven.

Create `__tests__/site-marks.test.ts`:

```ts
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { dbGet, dbQuery, dbRun } from '@/lib/sqlite'
import { answerMarkChange, answerMarksRead, changeSiteMark, readSiteMarks } from '@/lib/site-marks'

// These run on the real SQLite file of the test worker (see __tests__/setup/), so the SQL itself is what is proven, not a mock of it.
const A = 'a@example.test'
const B = 'b@example.test'
const rowOf = (host: string) => dbGet('SELECT status, note, updated_by, updated_at FROM site_marks WHERE host = ?', [host]) as
  { status: string | null; note: string | null; updated_by: string | null; updated_at: string } | undefined
const count = () => (dbGet('SELECT count(*) AS n FROM site_marks') as { n: number }).n

beforeEach(() => { dbRun('DELETE FROM site_marks') })
afterEach(() => vi.restoreAllMocks())

describe('the site_marks table', () => {
  test('refuses a row with neither a status nor a note, whatever wrote it', () => {
    expect(() => dbRun(`INSERT INTO site_marks (host) VALUES ('corp.example')`)).toThrow(/CHECK constraint/)
    expect(() => dbRun(`INSERT INTO site_marks (host, status, note) VALUES ('corp.example', NULL, NULL)`)).toThrow(/CHECK constraint/)
    expect(count()).toBe(0)
  })

  test('keeps one row per host', () => {
    dbRun(`INSERT INTO site_marks (host, status) VALUES ('corp.example', 'done')`)
    expect(() => dbRun(`INSERT INTO site_marks (host, status) VALUES ('corp.example', 'skip')`)).toThrow(/UNIQUE|PRIMARY KEY/)
  })
})

describe('changeSiteMark', () => {
  test('sets a status alone, and answers with what is stored: who and when in the form SQLite writes UTC', () => {
    const mark = changeSiteMark('corp.example', { status: 'done' }, A)
    expect(mark).toEqual({ status: 'done', note: null, updated_by: A, updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) })
    expect(rowOf('corp.example')).toMatchObject({ status: 'done', note: null, updated_by: A })
  })

  test('sets a note alone, which is a mark with no status', () => {
    expect(changeSiteMark('corp.example', { note: 'login page is behind a captcha' }, A)).toMatchObject({ status: null, note: 'login page is behind a captcha' })
    expect(count()).toBe(1)
  })

  test('a field left out keeps its stored value: a status change keeps the note and a note change keeps the status', () => {
    changeSiteMark('corp.example', { status: 'todo', note: 'first' }, A)
    expect(changeSiteMark('corp.example', { status: 'skip' }, A)).toMatchObject({ status: 'skip', note: 'first' })
    expect(changeSiteMark('corp.example', { note: 'second' }, A)).toMatchObject({ status: 'skip', note: 'second' })
  })

  test('two people changing different fields of one site both keep their change', () => {
    changeSiteMark('corp.example', { status: 'done' }, A)
    changeSiteMark('corp.example', { note: 'checked twice' }, B)
    expect(rowOf('corp.example')).toMatchObject({ status: 'done', note: 'checked twice', updated_by: B })
  })

  test('null clears a field; a blank note clears the note', () => {
    changeSiteMark('corp.example', { status: 'done', note: 'x' }, A)
    expect(changeSiteMark('corp.example', { note: null }, A)).toMatchObject({ status: 'done', note: null })
    changeSiteMark('corp.example', { note: 'again' }, A)
    expect(changeSiteMark('corp.example', { note: '   ' }, A)).toMatchObject({ status: 'done', note: null })
    expect(changeSiteMark('corp.example', { status: null }, A)).toBeNull()
  })

  test('when neither a status nor a note is left the row is deleted, and the answer is null', () => {
    changeSiteMark('corp.example', { status: 'done', note: 'x' }, A)
    expect(changeSiteMark('corp.example', { status: null, note: null }, A)).toBeNull()
    expect(rowOf('corp.example')).toBeUndefined()
    expect(count()).toBe(0)
  })

  test('clearing what is not there succeeds and writes nothing', () => {
    expect(changeSiteMark('corp.example', { status: null, note: null }, A)).toBeNull()
    expect(count()).toBe(0)
  })

  test('a real change takes over who and when', () => {
    changeSiteMark('corp.example', { status: 'done' }, A)
    dbRun(`UPDATE site_marks SET updated_at = '2020-01-01 00:00:00' WHERE host = 'corp.example'`)
    const changed = changeSiteMark('corp.example', { status: 'skip' }, B)
    expect(changed).toMatchObject({ status: 'skip', updated_by: B })
    expect(changed?.updated_at).not.toBe('2020-01-01 00:00:00')
  })

  test('a change that leaves the mark as it was writes nothing: the row keeps whoever last really changed it, and when', () => {
    changeSiteMark('corp.example', { status: 'done', note: 'same' }, A)
    dbRun(`UPDATE site_marks SET updated_at = '2020-01-01 00:00:00' WHERE host = 'corp.example'`)
    const again = changeSiteMark('corp.example', { status: 'done', note: '  same ' }, B)
    expect(again).toEqual({ status: 'done', note: 'same', updated_by: A, updated_at: '2020-01-01 00:00:00' })
    expect(rowOf('corp.example')).toMatchObject({ updated_by: A, updated_at: '2020-01-01 00:00:00' })
  })

  test('keeps each site apart', () => {
    changeSiteMark('corp.example', { status: 'done' }, A)
    changeSiteMark('app.corp.example', { status: 'skip' }, A)
    expect(rowOf('corp.example')?.status).toBe('done')
    expect(rowOf('app.corp.example')?.status).toBe('skip')
  })

  test('no name for who is asking is stored as null', () => {
    expect(changeSiteMark('corp.example', { status: 'done' }, null)).toMatchObject({ updated_by: null })
  })
})

describe('readSiteMarks', () => {
  test('answers only for the hosts that have a mark', () => {
    changeSiteMark('a.example', { status: 'done' }, A)
    changeSiteMark('b.example', { note: 'only a note' }, A)
    const marks = readSiteMarks(['a.example', 'b.example', 'c.example'])
    expect(Object.keys(marks).sort()).toEqual(['a.example', 'b.example'])
    expect(marks['a.example']).toMatchObject({ status: 'done', note: null })
    expect(marks['b.example']).toMatchObject({ status: null, note: 'only a note' })
  })

  test('looks hosts up exactly as given: a spelling the counts would clean is not another name for the site', () => {
    changeSiteMark('corp.example', { status: 'done' }, A)
    expect(readSiteMarks(['https://www.corp.example/login', 'CORP.EXAMPLE', 'www.corp.example'])).toEqual({})
  })

  test('takes a list with repeats, and an empty list', () => {
    changeSiteMark('a.example', { status: 'todo' }, A)
    expect(Object.keys(readSiteMarks(['a.example', 'a.example', 'a.example']))).toEqual(['a.example'])
    expect(readSiteMarks([])).toEqual({})
  })

  test('reads a whole list of 2,000 hosts in one statement', () => {
    changeSiteMark('site0.example', { status: 'done' }, A)
    changeSiteMark('site1999.example', { status: 'skip' }, A)
    const hosts = Array.from({ length: 2000 }, (_, i) => `site${i}.example`)
    const marks = readSiteMarks(hosts)
    expect(Object.keys(marks).sort()).toEqual(['site0.example', 'site1999.example'])
  })

  test('is not fooled by a host written like SQL', () => {
    changeSiteMark('a.example', { status: 'done' }, A)
    expect(readSiteMarks([`x.example' OR '1'='1`])).toEqual({})
    expect(count()).toBe(1)
  })
})

describe('answerMarksRead — POST /api/lookup/marks', () => {
  test('answers 200 with the marks of the hosts asked for', () => {
    changeSiteMark('a.example', { status: 'done', note: 'n' }, A)
    const reply = answerMarksRead({ hosts: ['a.example', 'b.example'] })
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ success: true, marks: { 'a.example': { status: 'done', note: 'n', updated_by: A, updated_at: expect.any(String) } } })
  })

  test('refuses (400) a body that is not an object, no hosts, an empty list, a list that is not text, and more than 2,000', () => {
    for (const body of [null, 'hosts', [], {}, { hosts: 'a.example' }, { hosts: [] }, { hosts: ['a.example', 3] }, { hosts: [null] }]) {
      expect(answerMarksRead(body).status).toBe(400)
    }
    const tooMany = answerMarksRead({ hosts: Array.from({ length: 2001 }, (_, i) => `s${i}.example`) })
    expect(tooMany.status).toBe(400)
    expect(tooMany.json.error).toBe('Too many sites (2001). Maximum is 2000 per request.')
    expect(answerMarksRead({ hosts: Array.from({ length: 2000 }, (_, i) => `s${i}.example`) }).status).toBe(200)
  })

  test('a failure of the database is a 500 for the request, logged, not a quiet empty answer', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    dbRun('ALTER TABLE site_marks RENAME TO site_marks_away')
    try {
      expect(answerMarksRead({ hosts: ['a.example'] })).toEqual({ status: 500, json: { success: false, error: 'Reading the marks failed' } })
      expect(logged).toHaveBeenCalled()
    } finally {
      dbRun('ALTER TABLE site_marks_away RENAME TO site_marks')
    }
  })
})

describe('answerMarkChange — PUT /api/lookup/marks', () => {
  test('answers 200 with the host and the stored mark', () => {
    const reply = answerMarkChange({ host: 'corp.example', status: 'todo', note: ' later ' }, A)
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ success: true, host: 'corp.example', mark: { status: 'todo', note: 'later', updated_by: A, updated_at: expect.any(String) } })
  })

  test('clearing both answers 200 with a null mark, and the row is gone', () => {
    answerMarkChange({ host: 'corp.example', status: 'todo' }, A)
    expect(answerMarkChange({ host: 'corp.example', status: null, note: null }, A)).toEqual({ status: 200, json: { success: true, host: 'corp.example', mark: null } })
    expect(count()).toBe(0)
  })

  test('refuses (400) a body that is not an object, and a host that is missing or is not a site as the counts name it', () => {
    for (const body of [null, 'x', [], {}, { status: 'done' }, { host: 5, status: 'done' }, { host: '', status: 'done' }]) {
      expect(answerMarkChange(body, A).status).toBe(400)
    }
    for (const host of ['https://www.corp.example/login', 'www.corp.example', 'Corp.Example', 'corp.example:8443', 'localhost', '*.corp.example']) {
      expect(answerMarkChange({ host, status: 'done' }, A).status).toBe(400)
    }
    expect(count()).toBe(0)
  })

  test('refuses (400) a status outside the list, a note that is too long or not text, and a change with neither field', () => {
    expect(answerMarkChange({ host: 'corp.example', status: 'finished' }, A).status).toBe(400)
    expect(answerMarkChange({ host: 'corp.example', note: 'x'.repeat(501) }, A).status).toBe(400)
    expect(answerMarkChange({ host: 'corp.example', note: 7 }, A).status).toBe(400)
    expect(answerMarkChange({ host: 'corp.example' }, A)).toEqual({ status: 400, json: { success: false, error: 'Send a status, a note or both' } })
    expect(count()).toBe(0)
  })

  test('a failure of the database is a 500 for the request, logged', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A name that is not text cannot be bound to the statement: the write fails inside the store.
    expect(answerMarkChange({ host: 'corp.example', status: 'done' }, {} as unknown as string)).toEqual({ status: 500, json: { success: false, error: 'Saving the mark failed' } })
    expect(logged).toHaveBeenCalled()
    expect(dbQuery('SELECT host FROM site_marks')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/site-marks.test.ts`
Expected: FAIL: `Failed to resolve import "@/lib/site-marks"`.

- [ ] **Step 3: Add the table**

In `lib/sqlite.ts`, replace:

```text
  // Add rescan columns to existing databases
```

with:

```text
  // Marks on the Site Counts page (lib/site-marks.ts): a status and a note per site, kept under the host the counts name. Additive, so an image that does
  // not know the table ignores it. The status is checked in code, so a fourth one needs no migration; the CHECK only keeps a row from being empty.
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_marks (
      host       TEXT PRIMARY KEY,
      status     TEXT,
      note       TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (status IS NOT NULL OR note IS NOT NULL)
    )
  `)

  // Add rescan columns to existing databases
```

- [ ] **Step 4: Create the store**

Create `lib/site-marks.ts`:

```ts
/**
 * The store of the site marks, and the answers of POST and PUT /api/lookup/marks (design: docs/superpowers/specs/2026-10-29-site-marks-design.md).
 * SQLite, in the same file as the users and the monitors: a mark is small, set by hand and the owner's own. The route only checks the session and hands
 * the body here, as the counts routes do with lib/site-counts.ts. The parts a page can import are in lib/site-marks-input.ts.
 */
import { dbGet, dbQuery, dbRun, dbTransaction } from '@/lib/sqlite'
import {
  SITE_MARKS_MAX_HOSTS,
  checkMarkPatch,
  isMarkableHost,
  mergeMark,
  type SiteMark,
  type SiteMarkPatch,
  type SiteMarkStatus,
} from '@/lib/site-marks-input'

interface MarkRow {
  host: string
  status: string | null
  note: string | null
  updated_by: string | null
  updated_at: string
}

const MARK_COLUMNS = 'host, status, note, updated_by, updated_at'

const toMark = (row: MarkRow): SiteMark => ({
  status: row.status as SiteMarkStatus | null,
  note: row.note,
  updated_by: row.updated_by,
  updated_at: row.updated_at,
})

/** The marks of these hosts, only for the ones that have one, looked up exactly as given (the page sends the hosts the counts named). */
export function readSiteMarks(hosts: string[]): Record<string, SiteMark> {
  const unique = Array.from(new Set(hosts))
  const marks: Record<string, SiteMark> = {}
  if (unique.length === 0) return marks
  // One IN list: this build of SQLite takes 32,766 variables and a read carries at most SITE_MARKS_MAX_HOSTS (2,000), in about 4 ms.
  const rows = dbQuery(`SELECT ${MARK_COLUMNS} FROM site_marks WHERE host IN (${unique.map(() => '?').join(',')})`, unique) as MarkRow[]
  for (const row of rows) marks[row.host] = toMark(row)
  return marks
}

/**
 * Changes one site's mark and answers with what is stored afterwards (null when no mark is left). Only the fields of the patch change, so two people
 * changing different fields of one site both keep their change. A change that leaves the mark as it was writes nothing: the row keeps the name and the
 * time of whoever last really changed it. updated_at is SQLite's UTC text ("YYYY-MM-DD HH:MM:SS"), which lib/format-relative-time.ts reads.
 */
export function changeSiteMark(host: string, patch: SiteMarkPatch, by: string | null): SiteMark | null {
  return dbTransaction(() => {
    const stored = dbGet(`SELECT ${MARK_COLUMNS} FROM site_marks WHERE host = ?`, [host]) as MarkRow | undefined
    const next = mergeMark(stored ? { status: stored.status as SiteMarkStatus | null, note: stored.note } : null, patch)
    if (next === null) {
      if (stored) dbRun(`DELETE FROM site_marks WHERE host = ?`, [host])
      return null
    }
    if (stored && stored.status === next.status && stored.note === next.note) return toMark(stored)
    dbRun(
      `INSERT INTO site_marks (host, status, note, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(host) DO UPDATE SET status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [host, next.status, next.note, by ?? null],
    )
    return toMark(dbGet(`SELECT ${MARK_COLUMNS} FROM site_marks WHERE host = ?`, [host]) as MarkRow)
  })
}

export interface MarksReply {
  status: number
  json: Record<string, unknown>
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const refused = (error: string): MarksReply => ({ status: 400, json: { success: false, error } })

/** POST /api/lookup/marks: the marks of the hosts in `{ hosts: string[] }`, only for the sites that have one. */
export function answerMarksRead(rawBody: unknown): MarksReply {
  const hosts = isObject(rawBody) ? rawBody.hosts : undefined
  if (!Array.isArray(hosts) || hosts.length === 0) return refused('Provide at least one site in "hosts"')
  if (hosts.length > SITE_MARKS_MAX_HOSTS) return refused(`Too many sites (${hosts.length}). Maximum is ${SITE_MARKS_MAX_HOSTS} per request.`)
  if (!hosts.every((host): host is string => typeof host === 'string')) return refused('"hosts" must be a list of text')
  try {
    return { status: 200, json: { success: true, marks: readSiteMarks(hosts) } }
  } catch (error) {
    console.error('site marks read error:', error)
    return { status: 500, json: { success: false, error: 'Reading the marks failed' } }
  }
}

/** PUT /api/lookup/marks: `{ host, status?, note? }` changes one site; `by` is who is asking (their e-mail address). */
export function answerMarkChange(rawBody: unknown, by: string | null): MarksReply {
  if (!isObject(rawBody)) return refused('Body must be a JSON object')
  const host = typeof rawBody.host === 'string' ? rawBody.host : ''
  if (!isMarkableHost(host)) return refused('"host" must be a site as the counts name it, for example corp.example (no scheme, path, port or www.)')
  const checked = checkMarkPatch(rawBody)
  if (!checked.ok) return refused(checked.error)
  try {
    return { status: 200, json: { success: true, host, mark: changeSiteMark(host, checked.patch, by) } }
  } catch (error) {
    console.error('site marks change error:', error)
    return { status: 500, json: { success: false, error: 'Saving the mark failed' } }
  }
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `npx vitest run __tests__/site-marks.test.ts`
Expected: PASS: `Tests  26 passed (26)`.

- [ ] **Step 6: Commit**

```bash
git add lib/sqlite.ts lib/site-marks.ts __tests__/site-marks.test.ts
git commit -m "feat(marks): the site_marks table and its store" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The route

**Files:**
- Create: `app/api/lookup/marks/route.ts`
- Test: create `__tests__/site-marks-routes.test.ts`

**Interfaces:**
- Consumes (Task 2): `answerMarksRead`, `answerMarkChange`; `validateRequest` from `lib/auth.ts` (returns `JWTPayload | null`; `email` is optional, `username` is not).
- Produces: `POST` and `PUT` handlers at `/api/lookup/marks` with the bodies and answers in Global Constraints. `PUT` records `user.email ?? user.username` as `updated_by`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/site-marks-routes.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn() }))

import { NextRequest } from 'next/server'
import { validateRequest, type JWTPayload } from '@/lib/auth'
import { dbRun } from '@/lib/sqlite'
import { POST, PUT } from '@/app/api/lookup/marks/route'

const admin: JWTPayload = { userId: '1', username: 'Admin', email: 'admin@example.test', role: 'admin' }
const analyst: JWTPayload = { userId: '2', username: 'Ana', email: 'ana@example.test', role: 'analyst' }

const send = (handler: (request: NextRequest) => Promise<Response>, method: 'POST' | 'PUT', body: unknown) =>
  handler(new NextRequest('http://localhost/api/lookup/marks', { method, body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  vi.mocked(validateRequest).mockResolvedValue(admin)
  dbRun('DELETE FROM site_marks')
})

describe.each([
  ['POST', POST, { hosts: ['corp.example'] }],
  ['PUT', PUT, { host: 'corp.example', status: 'done' }],
] as const)('%s /api/lookup/marks', (method, handler, validBody) => {
  test('needs a session: 401 without one, and nothing is read or written', async () => {
    vi.mocked(validateRequest).mockResolvedValue(null)
    const res = await send(handler, method, validBody)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    vi.mocked(validateRequest).mockResolvedValue(admin)
    const read = await send(POST, 'POST', { hosts: ['corp.example'] })
    expect((await read.json()).marks).toEqual({})
  })

  test('refuses a body that is not JSON (400)', async () => {
    const res = await send(handler, method, '{not json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Invalid JSON body' })
  })
})

describe('the two verbs together', () => {
  test('a mark set with PUT is read back by POST, with who set it', async () => {
    const put = await send(PUT, 'PUT', { host: 'corp.example', status: 'todo', note: 'look at the sign-up page' })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      success: true,
      host: 'corp.example',
      mark: { status: 'todo', note: 'look at the sign-up page', updated_by: 'admin@example.test', updated_at: expect.any(String) },
    })
    const read = await send(POST, 'POST', { hosts: ['corp.example', 'other.example'] })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({
      success: true,
      marks: { 'corp.example': { status: 'todo', note: 'look at the sign-up page', updated_by: 'admin@example.test', updated_at: expect.any(String) } },
    })
  })

  test('an analyst can mark a site too, and the mark then carries the analyst, not the admin', async () => {
    await send(PUT, 'PUT', { host: 'corp.example', status: 'done' })
    vi.mocked(validateRequest).mockResolvedValue(analyst)
    const res = await send(PUT, 'PUT', { host: 'corp.example', status: 'skip' })
    expect(res.status).toBe(200)
    expect((await res.json()).mark).toMatchObject({ status: 'skip', updated_by: 'ana@example.test' })
  })

  test('a session whose token carries no e-mail address is named by its sign-in name', async () => {
    vi.mocked(validateRequest).mockResolvedValue({ userId: '3', username: 'Old Token' })
    const res = await send(PUT, 'PUT', { host: 'corp.example', status: 'done' })
    expect((await res.json()).mark.updated_by).toBe('Old Token')
  })

  test('only the fields sent change, and clearing both removes the mark', async () => {
    await send(PUT, 'PUT', { host: 'corp.example', status: 'done', note: 'n' })
    const noteOnly = await send(PUT, 'PUT', { host: 'corp.example', note: 'changed' })
    expect((await noteOnly.json()).mark).toMatchObject({ status: 'done', note: 'changed' })
    const cleared = await send(PUT, 'PUT', { host: 'corp.example', status: null, note: null })
    expect(await cleared.json()).toEqual({ success: true, host: 'corp.example', mark: null })
    const read = await send(POST, 'POST', { hosts: ['corp.example'] })
    expect((await read.json()).marks).toEqual({})
  })

  test('the checks of the library are the route\'s: a host as typed, a status outside the list and an empty read are 400', async () => {
    expect((await send(PUT, 'PUT', { host: 'https://www.corp.example/login', status: 'done' })).status).toBe(400)
    expect((await send(PUT, 'PUT', { host: 'corp.example', status: 'finished' })).status).toBe(400)
    expect((await send(POST, 'POST', { hosts: [] })).status).toBe(400)
    const read = await send(POST, 'POST', { hosts: ['corp.example'] })
    expect((await read.json()).marks).toEqual({})
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/site-marks-routes.test.ts`
Expected: FAIL: `Failed to resolve import "@/app/api/lookup/marks/route"`.

- [ ] **Step 3: Create the route**

Create `app/api/lookup/marks/route.ts`:

```ts
/**
 * Internal Site Marks API (the Site Counts page)
 * POST /api/lookup/marks   body { hosts: string[] }
 *                          -> { success, marks: { [host]: { status, note, updated_by, updated_at } } }   only the hosts that have a mark
 * PUT  /api/lookup/marks   body { host: string, status?: 'done' | 'skip' | 'todo' | null, note?: string | null }
 *                          -> { success, host, mark: { status, note, updated_by, updated_at } | null }     the mark as stored after the change
 *
 * Session-authenticated (the same auth as /api/lookup/counts): any signed-in user, admin or analyst, as the page itself. A mark is kept under the host
 * the counts name, is shared by everyone who signs in, and is not on /api/v1: an API key has no person to attribute it to. The checks, the SQL and the
 * answers are in lib/site-marks.ts.
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { answerMarkChange, answerMarksRead } from "@/lib/site-marks"

export const dynamic = "force-dynamic"

async function readJson(request: NextRequest): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() }
  } catch {
    return { ok: false }
  }
}

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const parsed = await readJson(request)
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const reply = answerMarksRead(parsed.body)
  return NextResponse.json(reply.json, { status: reply.status })
}

export async function PUT(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const parsed = await readJson(request)
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const reply = answerMarkChange(parsed.body, user.email ?? user.username)
  return NextResponse.json(reply.json, { status: reply.status })
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run __tests__/site-marks-routes.test.ts`
Expected: PASS: `Tests  9 passed (9)`.

- [ ] **Step 5: Commit**

```bash
git add app/api/lookup/marks/route.ts __tests__/site-marks-routes.test.ts
git commit -m "feat(marks): POST and PUT /api/lookup/marks" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The page's marks store

**Files:**
- Create: `lib/site-marks-client.ts`
- Test: create `__tests__/site-marks-client.test.ts`

**Interfaces:**
- Consumes (Task 1): `mergeMark`, `SiteMark`, `SiteMarkPatch`. Talks to the route of Task 3 with `POST { hosts }` and `PUT { host, ...patch }`.
- Produces (used by Task 6):
  - `createSiteMarksStore(deps: { fetch: (input: string, init: RequestInit) => Promise<Response>; onSaveFailed: (message: string) => void })` returning `{ subscribe(listener): () => void; getSnapshot(): MarksSnapshot; load(hosts: string[]): Promise<void>; retry(): Promise<void>; change(host: string, patch: SiteMarkPatch): Promise<void> }`
  - `interface MarksSnapshot { status: 'idle' | 'loading' | 'ready' | 'failed'; marks: Readonly<Record<string, SiteMark>>; error: string | null }`, `SESSION_EXPIRED`, `type SiteMarksStore`

- [ ] **Step 1: Write the failing test**

Create `__tests__/site-marks-client.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest'
import { SESSION_EXPIRED, createSiteMarksStore } from '@/lib/site-marks-client'
import type { SiteMark } from '@/lib/site-marks-input'

const mark = (status: SiteMark['status'], note: string | null = null, by: string | null = 'a@example.test'): SiteMark => ({
  status, note, updated_by: by, updated_at: '2026-10-29 10:00:00',
})
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A fetch that answers when the test says so, and remembers what it was asked. */
function controlledFetch() {
  const requests: Array<{ method: string; body: Record<string, unknown>; answer: (res: Response) => void; fail: (err: Error) => void }> = []
  const fetch = (_input: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      requests.push({ method: String(init.method), body: JSON.parse(String(init.body)), answer: resolve, fail: reject })
    })
  return { fetch, requests }
}

/** A store whose first load is already answered with `initial`. */
async function loadedStore(initial: Record<string, SiteMark> = {}) {
  const net = controlledFetch()
  const failures: string[] = []
  const store = createSiteMarksStore({ fetch: net.fetch, onSaveFailed: message => failures.push(message) })
  const hosts = Object.keys(initial).length > 0 ? Object.keys(initial) : ['placeholder.example']
  const loading = store.load(hosts)
  net.requests[0].answer(reply({ success: true, marks: initial }))
  await loading
  return { ...net, failures, store, shown: (host: string) => store.getSnapshot().marks[host] }
}

function freshStore() {
  const net = controlledFetch()
  const failures: string[] = []
  const store = createSiteMarksStore({ fetch: net.fetch, onSaveFailed: message => failures.push(message) })
  return { ...net, failures, store }
}

describe('load', () => {
  test('asks for the marks of the whole list in one request, and shows them when they arrive', async () => {
    const t = freshStore()
    expect(t.store.getSnapshot()).toEqual({ status: 'idle', marks: {}, error: null })
    const loading = t.store.load(['a.example', 'b.example'])
    expect(t.store.getSnapshot()).toEqual({ status: 'loading', marks: {}, error: null })
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0]).toMatchObject({ method: 'POST', body: { hosts: ['a.example', 'b.example'] } })
    t.requests[0].answer(reply({ success: true, marks: { 'a.example': mark('done') } }))
    await loading
    expect(t.store.getSnapshot()).toEqual({ status: 'ready', marks: { 'a.example': mark('done') }, error: null })
  })

  test('with no host there is nothing to ask: ready, with no marks', async () => {
    const t = freshStore()
    await t.store.load([])
    expect(t.requests).toHaveLength(0)
    expect(t.store.getSnapshot()).toEqual({ status: 'ready', marks: {}, error: null })
  })

  test('a load that fails is failed, with the reason and no marks, never an empty ready: Retry asks again for the same hosts', async () => {
    const t = freshStore()
    const loading = t.store.load(['a.example'])
    t.requests[0].answer(reply({ success: false, error: 'Reading the marks failed' }, 500))
    await loading
    expect(t.store.getSnapshot()).toEqual({ status: 'failed', marks: {}, error: 'Reading the marks failed' })

    const again = t.store.retry()
    expect(t.store.getSnapshot().status).toBe('loading')
    expect(t.requests[1]).toMatchObject({ method: 'POST', body: { hosts: ['a.example'] } })
    t.requests[1].answer(reply({ success: true, marks: { 'a.example': mark('skip') } }))
    await again
    expect(t.store.getSnapshot()).toEqual({ status: 'ready', marks: { 'a.example': mark('skip') }, error: null })
  })

  test('a network failure, an answer that is not JSON and an expired session each fail with a sentence', async () => {
    const t = freshStore()
    const down = t.store.load(['a.example'])
    t.requests[0].fail(new Error('connect ECONNREFUSED'))
    await down
    expect(t.store.getSnapshot()).toMatchObject({ status: 'failed', error: 'Could not reach the server' })

    const html = t.store.load(['a.example'])
    t.requests[1].answer(new Response('<html>502</html>', { status: 502 }))
    await html
    expect(t.store.getSnapshot()).toMatchObject({ status: 'failed', error: 'The server did not answer properly' })

    const expired = t.store.load(['a.example'])
    t.requests[2].answer(reply({}, 401))
    await expired
    expect(t.store.getSnapshot()).toMatchObject({ status: 'failed', error: SESSION_EXPIRED })

    const redirected = t.store.load(['a.example'])
    t.requests[3].answer(Object.defineProperty(new Response('<html>sign in</html>'), 'redirected', { value: true }))
    await redirected
    expect(t.store.getSnapshot()).toMatchObject({ status: 'failed', error: SESSION_EXPIRED })
  })

  test('an older load that answers late is ignored', async () => {
    const t = freshStore()
    const first = t.store.load(['a.example'])
    const second = t.store.load(['b.example'])
    t.requests[1].answer(reply({ success: true, marks: { 'b.example': mark('todo') } }))
    await second
    t.requests[0].answer(reply({ success: true, marks: { 'a.example': mark('done') } }))
    await first
    expect(t.store.getSnapshot().marks).toEqual({ 'b.example': mark('todo') })
  })

  test('listeners hear every change of the snapshot until they unsubscribe', async () => {
    const t = freshStore()
    const heard = vi.fn()
    const unsubscribe = t.store.subscribe(heard)
    await t.store.load([])
    expect(heard).toHaveBeenCalledTimes(1)
    unsubscribe()
    await t.store.load([])
    expect(heard).toHaveBeenCalledTimes(1)
  })

  test('the snapshot is the same object until something changes, which useSyncExternalStore needs', async () => {
    const t = freshStore()
    await t.store.load([])
    expect(t.store.getSnapshot()).toBe(t.store.getSnapshot())
  })
})

describe('change', () => {
  test('shows the change at once, sends only what changed, then shows what the server stored', async () => {
    const t = await loadedStore({ 'a.example': mark('done', 'old') })
    const saving = t.store.change('a.example', { status: 'skip' })
    // at once, with the name and time of the last real change until the server answers
    expect(t.shown('a.example')).toEqual({ status: 'skip', note: 'old', updated_by: 'a@example.test', updated_at: '2026-10-29 10:00:00' })
    await flush()
    expect(t.requests).toHaveLength(2)
    expect(t.requests[1]).toMatchObject({ method: 'PUT', body: { host: 'a.example', status: 'skip' } })
    expect(t.requests[1].body).not.toHaveProperty('note')
    t.requests[1].answer(reply({ success: true, host: 'a.example', mark: mark('skip', 'old', 'b@example.test') }))
    await saving
    expect(t.shown('a.example')).toEqual(mark('skip', 'old', 'b@example.test'))
  })

  test('a note alone keeps the status on screen, and clearing both takes the mark away at once', async () => {
    const t = await loadedStore({ 'a.example': mark('done') })
    void t.store.change('a.example', { note: '  looked at it ' })
    expect(t.shown('a.example')).toMatchObject({ status: 'done', note: 'looked at it' })
    void t.store.change('a.example', { status: null, note: null })
    expect(t.shown('a.example')).toBeUndefined()
  })

  test('a site with no mark gets one at once, with no name or time until the server answers', async () => {
    const t = await loadedStore({})
    void t.store.change('new.example', { status: 'todo' })
    expect(t.shown('new.example')).toEqual({ status: 'todo', note: null, updated_by: null, updated_at: null })
  })

  test('a save that fails puts back what the server last said, and tells the person why', async () => {
    const t = await loadedStore({ 'a.example': mark('done') })
    const saving = t.store.change('a.example', { status: 'skip' })
    await flush()
    t.requests[1].answer(reply({ success: false, error: 'Saving the mark failed' }, 500))
    await saving
    expect(t.shown('a.example')).toEqual(mark('done'))
    expect(t.failures).toEqual(['Saving the mark failed'])
  })

  test('a save that fails for a site that had no mark takes the mark it showed away again', async () => {
    const t = await loadedStore({})
    const saving = t.store.change('new.example', { status: 'todo' })
    await flush()
    t.requests[1].fail(new Error('offline'))
    await saving
    expect(t.shown('new.example')).toBeUndefined()
    expect(t.failures).toEqual(['Could not reach the server'])
  })

  test('an expired session says so', async () => {
    const t = await loadedStore({ 'a.example': mark('done') })
    const saving = t.store.change('a.example', { status: 'skip' })
    await flush()
    t.requests[1].answer(reply({}, 401))
    await saving
    expect(t.failures).toEqual([SESSION_EXPIRED])
    expect(t.shown('a.example')).toEqual(mark('done'))
  })

  test('the changes to one site go one after the other, and the answer of an earlier one does not put its state back over a later click', async () => {
    const t = await loadedStore({})
    const first = t.store.change('a.example', { status: 'done' })
    const second = t.store.change('a.example', { status: 'skip' })
    await flush()
    // only the first is on its way; the second waits for it
    expect(t.requests.slice(1).map(r => r.body)).toEqual([{ host: 'a.example', status: 'done' }])
    expect(t.shown('a.example')?.status).toBe('skip')

    t.requests[1].answer(reply({ success: true, host: 'a.example', mark: mark('done') }))
    await flush()
    expect(t.requests.slice(1).map(r => r.body)).toEqual([{ host: 'a.example', status: 'done' }, { host: 'a.example', status: 'skip' }])
    expect(t.shown('a.example')?.status).toBe('skip') // not 'done': the later click has replaced it

    t.requests[2].answer(reply({ success: true, host: 'a.example', mark: mark('skip', null, 'b@example.test') }))
    await Promise.all([first, second])
    expect(t.shown('a.example')).toEqual(mark('skip', null, 'b@example.test'))
  })

  test('a change that failed does not roll back a later one still on its way; the later answer settles the site', async () => {
    const t = await loadedStore({})
    const first = t.store.change('a.example', { status: 'done' })
    const second = t.store.change('a.example', { note: 'n' })
    await flush()
    t.requests[1].answer(reply({ success: false, error: 'Saving the mark failed' }, 500))
    await flush()
    expect(t.failures).toEqual(['Saving the mark failed'])
    expect(t.shown('a.example')).toMatchObject({ status: 'done', note: 'n' }) // still what the person last did
    t.requests[2].answer(reply({ success: true, host: 'a.example', mark: mark(null, 'n') })) // the first never reached the server
    await Promise.all([first, second])
    expect(t.shown('a.example')).toEqual(mark(null, 'n'))
  })

  test('changes to different sites are not held up by one another', async () => {
    const t = await loadedStore({})
    void t.store.change('a.example', { status: 'done' })
    void t.store.change('b.example', { status: 'skip' })
    await flush()
    expect(t.requests.slice(1).map(r => r.body)).toEqual([{ host: 'a.example', status: 'done' }, { host: 'b.example', status: 'skip' }])
  })

  test('nothing is sent before the marks are loaded, while they load, or after they failed', async () => {
    const t = freshStore()
    await t.store.change('a.example', { status: 'done' })
    expect(t.requests).toHaveLength(0)
    expect(t.store.getSnapshot().marks).toEqual({})

    const loading = t.store.load(['a.example'])
    await t.store.change('a.example', { status: 'done' })
    expect(t.requests).toHaveLength(1) // only the load
    t.requests[0].answer(reply({ success: false, error: 'boom' }, 500))
    await loading
    await t.store.change('a.example', { status: 'done' })
    expect(t.requests).toHaveLength(1)
    expect(t.store.getSnapshot().marks).toEqual({})
  })

  test('loading again forgets what the server last said about the old list: a failed save goes back to the new answer', async () => {
    const t = await loadedStore({ 'a.example': mark('done') })
    const reload = t.store.load(['a.example'])
    t.requests[1].answer(reply({ success: true, marks: { 'a.example': mark('skip') } }))
    await reload
    const saving = t.store.change('a.example', { status: 'todo' })
    await flush()
    t.requests[2].answer(reply({ success: false, error: 'Saving the mark failed' }, 500))
    await saving
    expect(t.shown('a.example')).toEqual(mark('skip'))
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/site-marks-client.test.ts`
Expected: FAIL: `Failed to resolve import "@/lib/site-marks-client"`.

- [ ] **Step 3: Create the store**

Create `lib/site-marks-client.ts`:

```ts
/**
 * The page's side of the site marks: what it knows, what it asked for and what it is still saving (design: docs/superpowers/specs/2026-10-29-site-marks-design.md).
 * Plain TypeScript with no React in it, so the order of the saves and the way back from a failed one are tested with a fake `fetch`; the page reads it
 * with useSyncExternalStore.
 *
 * - load(hosts) asks once for the marks of a whole list. Until the answer the status is 'loading', and a failure is 'failed': the page never shows a
 *   mark it could not load as "No mark" (a person could save over a note they cannot see), and nothing is saved before the marks are loaded.
 * - change(host, patch) shows the change at once and sends it. The changes to one site go one after the other, so the stored state is the last click's;
 *   the answer of the last one replaces what is shown (the server's word, not the page's guess), and if it fails the site goes back to what the server
 *   last said and onSaveFailed tells the person. An earlier answer of a site that has a later change on its way is not shown: it would put back a
 *   state the later click has already replaced.
 */
import { mergeMark, type SiteMark, type SiteMarkPatch } from '@/lib/site-marks-input'

export type MarksStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface MarksSnapshot {
  status: MarksStatus
  /** Only the sites that have a mark. */
  marks: Readonly<Record<string, SiteMark>>
  /** Why the marks did not load, when the status is 'failed'. */
  error: string | null
}

export interface SiteMarksStoreDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  /** A save did not go through: a sentence for the person. */
  onSaveFailed: (message: string) => void
}

const ENDPOINT = '/api/lookup/marks'
export const SESSION_EXPIRED = 'Your session has expired. Sign in again, then try again.'

interface MarksAnswer {
  success?: boolean
  marks?: Record<string, SiteMark>
  mark?: SiteMark | null
  error?: string
}

async function ask(send: SiteMarksStoreDeps['fetch'], method: 'POST' | 'PUT', body: unknown): Promise<MarksAnswer> {
  let res: Response
  try {
    res = await send(ENDPOINT, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error('Could not reach the server')
  }
  // An expired session is redirected to the sign-in page, which is not JSON.
  if (res.redirected || res.status === 401) throw new Error(SESSION_EXPIRED)
  let json: MarksAnswer
  try {
    json = await res.json()
  } catch {
    throw new Error('The server did not answer properly')
  }
  if (!json.success) throw new Error(json.error || 'The request failed')
  return json
}

export function createSiteMarksStore(deps: SiteMarksStoreDeps) {
  let snapshot: MarksSnapshot = { status: 'idle', marks: {}, error: null }
  let generation = 0 // a load that is not the latest one is ignored
  let lastHosts: string[] = []
  const listeners = new Set<() => void>()
  const confirmed = new Map<string, SiteMark>() // what the server last said, per site: only the sites that have a mark
  const pending = new Map<string, number>() // changes of a site that are being sent or are waiting
  const tails = new Map<string, Promise<void>>() // the last of them: the next one waits for it

  const publish = (next: MarksSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }

  const setMark = (host: string, mark: SiteMark | null) => {
    const marks = { ...snapshot.marks }
    if (mark === null) delete marks[host]
    else marks[host] = mark
    publish({ ...snapshot, marks })
  }

  async function load(hosts: string[]): Promise<void> {
    const mine = ++generation
    lastHosts = hosts
    confirmed.clear()
    if (hosts.length === 0) {
      publish({ status: 'ready', marks: {}, error: null })
      return
    }
    publish({ status: 'loading', marks: {}, error: null })
    try {
      const answer = await ask(deps.fetch, 'POST', { hosts })
      if (mine !== generation) return
      const marks = answer.marks ?? {}
      for (const [host, mark] of Object.entries(marks)) confirmed.set(host, mark)
      publish({ status: 'ready', marks, error: null })
    } catch (error) {
      if (mine !== generation) return
      publish({ status: 'failed', marks: {}, error: error instanceof Error ? error.message : 'The marks could not be loaded' })
    }
  }

  function change(host: string, patch: SiteMarkPatch): Promise<void> {
    if (snapshot.status !== 'ready') return Promise.resolve()
    const current = snapshot.marks[host] ?? null
    const merged = mergeMark(current, patch)
    // Shown at once; the server's answer replaces it. Who and when stay those of the last real change until the server says otherwise.
    setMark(host, merged === null ? null : { ...merged, updated_by: current?.updated_by ?? null, updated_at: current?.updated_at ?? null })
    pending.set(host, (pending.get(host) ?? 0) + 1)
    /** Counts this change as done; true when it was the last one of the site. */
    const finish = () => {
      const left = (pending.get(host) ?? 1) - 1
      if (left === 0) pending.delete(host)
      else pending.set(host, left)
      return left === 0
    }

    const run = (tails.get(host) ?? Promise.resolve()).then(async () => {
      try {
        const answer = await ask(deps.fetch, 'PUT', { host, ...patch })
        const stored = answer.mark ?? null
        if (stored === null) confirmed.delete(host)
        else confirmed.set(host, stored)
        if (finish()) setMark(host, stored)
      } catch (error) {
        if (finish()) setMark(host, confirmed.get(host) ?? null)
        deps.onSaveFailed(error instanceof Error ? error.message : 'The mark was not saved')
      }
    })
    tails.set(host, run)
    void run.then(() => {
      if (tails.get(host) === run) tails.delete(host)
    })
    return run
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    load,
    /** Asks again for the hosts of the last load: the Retry of a failed one. */
    retry: () => load(lastHosts),
    change,
  }
}

export type SiteMarksStore = ReturnType<typeof createSiteMarksStore>
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run __tests__/site-marks-client.test.ts`
Expected: PASS: `Tests  18 passed (18)`.

- [ ] **Step 5: Commit**

```bash
git add lib/site-marks-client.ts __tests__/site-marks-client.test.ts
git commit -m "feat(marks): the page's marks store: saves in order, a failed one put back" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The mark cell, its menu and the chips

**Files:**
- Create: `components/site-mark-cell.tsx`, `components/site-mark-filter.tsx`
- Test: create `__tests__/site-mark-cell.test.ts`

**Interfaces:**
- Consumes (Task 1): `NO_MARK_LABEL`, `SITE_MARK_LABELS`, `SITE_MARK_NOTE_MAX`, `SITE_MARK_STATUSES`, `markAriaLabel`, `markTitle`, `normalizeNote`, `MARK_FILTERS`, `MARK_FILTER_LABELS`, `SiteMark`, `SiteMarkPatch`, `SiteMarkStatus`, `MarkFilter`; `Popover`, `Textarea` from `components/ui`; `formatRelativeTime`.
- Produces (used by Task 6):
  - `components/site-mark-cell.tsx`: `MARK_CELL` (the 48 px box classes), `MarkIcon({ status, className? })`, `SiteMarkMenu(props)`, `SiteMarkCell({ host, mark, availability: 'loading' | 'ready' | 'failed', onChange: (patch: SiteMarkPatch) => void })`
  - `components/site-mark-filter.tsx`: `SiteMarkFilter({ value: MarkFilter, counts: Record<MarkFilter, number>, disabled: boolean, onChange: (next: MarkFilter) => void })`

- [ ] **Step 1: Write the failing test**

These render with `react-dom/server` (as `__tests__/imported-window-filter.test.ts` does), so no DOM is needed.

Create `__tests__/site-mark-cell.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect, vi, afterEach } from 'vitest'
import { MARK_CELL, MarkIcon, SiteMarkCell, SiteMarkMenu } from '@/components/site-mark-cell'
import { SiteMarkFilter } from '@/components/site-mark-filter'
import type { SiteMark } from '@/lib/site-marks-input'

const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8')
const mark = (status: SiteMark['status'], note: string | null = null, by: string | null = 'a@example.test', at: string | null = '2026-10-29 10:00:00'): SiteMark => ({
  status, note, updated_by: by, updated_at: at,
})

afterEach(() => vi.useRealTimers())

const cell = (props: Partial<ComponentProps<typeof SiteMarkCell>> = {}) =>
  renderToStaticMarkup(createElement(SiteMarkCell, { host: 'corp.example', mark: null, availability: 'ready', onChange: () => {}, ...props }))

describe('SiteMarkCell — what a row shows before anything is clicked', () => {
  test('while the marks load it is a pulsing dot that cannot be clicked, and it does not say "No mark"', () => {
    const out = cell({ availability: 'loading' })
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-label="Loading the mark"')
    expect(out).toContain('animate-pulse')
    expect(out).not.toContain('<button')
    expect(out).not.toContain('No mark')
  })

  test('when the marks could not be loaded it is a warning that cannot be clicked, and it does not say "No mark"', () => {
    const out = cell({ availability: 'failed' })
    expect(out).toContain('title="Marks could not be loaded"')
    expect(out).toContain('aria-label="Marks could not be loaded"')
    expect(out).not.toContain('<button')
    expect(out).not.toContain('No mark')
  })

  test('a site with no mark is a button with its words, and a faint outline that shows on hover, on focus and on touch screens', () => {
    const out = cell()
    expect(out).toContain('<button')
    expect(out).toContain('aria-label="Mark for corp.example: No mark"')
    expect(out).toContain('title="No mark"')
    expect(out).toContain('aria-haspopup="dialog"')
    expect(out).toContain('opacity-0')
    expect(out).toContain('group-hover/mark:opacity-60')
    expect(out).toContain('group-focus-visible/mark:opacity-60')
    expect(out).toContain('[@media(hover:none)]:opacity-40')
    expect(out).not.toContain('bg-primary')
  })

  test('each status has its own shape and colour, and is not faint', () => {
    const done = cell({ mark: mark('done') })
    expect(done).toContain('text-green-600')
    expect(done).toContain('aria-label="Mark for corp.example: Done"')
    const skip = cell({ mark: mark('skip') })
    expect(skip).toContain('text-red-600')
    expect(skip).toContain('aria-label="Mark for corp.example: Skip"')
    const todo = cell({ mark: mark('todo') })
    expect(todo).toContain('fill-current')
    expect(todo).toContain('text-blue-600')
    expect(todo).toContain('aria-label="Mark for corp.example: To look at"')
    for (const out of [done, skip, todo]) expect(out).not.toContain('opacity-0')
    // three different shapes, not only three colours
    const shapes = [done, skip, todo].map(out => /lucide lucide-([a-z-]+)/.exec(out)?.[1])
    expect(new Set(shapes).size).toBe(3)
  })

  test('a note puts a dot on the icon, and keeps the icon of a site with no status visible', () => {
    const noteOnly = cell({ mark: mark(null, 'behind a captcha') })
    expect(noteOnly).toContain('bg-primary')
    expect(noteOnly).toContain('opacity-60')
    expect(noteOnly).not.toContain('opacity-0')
    expect(noteOnly).toContain('aria-label="Mark for corp.example: No mark, has a note"')
    expect(noteOnly).toContain('behind a captcha')
    expect(cell({ mark: mark('done', 'x') })).toContain('bg-primary')
    expect(cell({ mark: mark('done') })).not.toContain('bg-primary')
  })

  test('the menu is not in the markup until it is opened', () => {
    const out = cell({ mark: mark('done', 'x') })
    expect(out).not.toContain('Optional: why')
    expect(out).not.toContain('Saved when this closes')
  })

  test('every state is as wide as the header above it, so the columns line up', () => {
    expect(MARK_CELL).toContain('w-12')
    for (const availability of ['loading', 'ready', 'failed'] as const) expect(cell({ availability })).toContain(MARK_CELL)
  })

  test('its clicks stop at the cell: the menu is in a portal, whose clicks React would bubble to the row and open its detail', () => {
    expect(source('components/site-mark-cell.tsx')).toContain('onClick={event => event.stopPropagation()}')
  })
})

describe('MarkIcon', () => {
  test('no status is a dashed circle, in the muted colour', () => {
    const out = renderToStaticMarkup(createElement(MarkIcon, { status: null }))
    expect(out).toContain('lucide-circle-dashed')
    expect(out).toContain('text-muted-foreground')
  })
})

const menu = (props: Partial<ComponentProps<typeof SiteMarkMenu>> = {}) =>
  renderToStaticMarkup(createElement(SiteMarkMenu, {
    host: 'corp.example', mark: null, draft: '', onDraftChange: () => {}, onChoose: () => {}, onNoteKeyDown: () => {}, ...props,
  }))

describe('SiteMarkMenu — what the cell opens', () => {
  test('four choices in order, No mark first (not "Clear": the list panel already has one)', () => {
    const out = menu()
    const labels = ['No mark', 'Done', 'Skip', 'To look at'].map(label => out.indexOf(`</svg>${label}</button>`))
    expect(labels.every(i => i > 0)).toBe(true)
    expect([...labels].sort((a, b) => a - b)).toEqual(labels)
    expect(out).not.toContain('Clear')
  })

  test('the current mark is the pressed one, and with no mark it is No mark', () => {
    const pressed = (out: string) => [...out.matchAll(/aria-pressed="true"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?([^<]+)</g)].map(m => m[1])
    expect(pressed(menu())).toEqual(['No mark'])
    expect(pressed(menu({ mark: mark('skip') }))).toEqual(['Skip'])
    expect(pressed(menu({ mark: mark(null, 'a note only') }))).toEqual(['No mark'])
  })

  test('has a note box of at most 500 characters, labelled, with the text of the draft', () => {
    const out = menu({ draft: 'looked at the login page' })
    expect(out).toContain('maxLength="500"')
    expect(out).toContain('>Note</label>')
    expect(out).toContain('>looked at the login page</textarea>')
    expect(out).toContain('Saved when this closes. Ctrl+Enter closes it.')
  })

  test('shows the counter from 400 characters on, not before', () => {
    expect(menu({ draft: 'x'.repeat(399) })).not.toContain('/ 500')
    expect(menu({ draft: 'x'.repeat(400) })).toContain('400 / 500')
    expect(menu({ draft: 'x'.repeat(500) })).toContain('500 / 500')
  })

  test('says who set the mark and when, once the server has said so', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
    expect(menu({ mark: mark('done') })).toContain('Set by a@example.test, 2 hours ago')
    expect(menu({ mark: mark('done', null, null, null) })).not.toContain('Set by')
    expect(menu()).not.toContain('Set by')
  })

  test('names the site it is for', () => {
    expect(menu({ host: 'app.corp.example' })).toContain('title="app.corp.example"')
  })
})

describe('SiteMarkFilter — the chips', () => {
  const counts = { all: 12, done: 3, skip: 2, todo: 1, none: 6 }
  const chips = (props: Partial<ComponentProps<typeof SiteMarkFilter>> = {}) =>
    renderToStaticMarkup(createElement(SiteMarkFilter, { value: 'all', counts, disabled: false, onChange: () => {}, ...props }))

  test('All, Done, Skip, To look at, No mark, each with its count', () => {
    const out = chips()
    const order = ['All', 'Done', 'Skip', 'To look at', 'No mark'].map(label => out.indexOf(label))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect([...out.matchAll(/tabular-nums text-muted-foreground">(\d+)</g)].map(m => m[1])).toEqual(['12', '3', '2', '1', '6'])
  })

  test('the chip that is on is pressed and outlined, the others are not', () => {
    const out = chips({ value: 'todo' })
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(4)
    expect(/aria-pressed="true"[^>]*class="[^"]*border-primary/.test(out) || /class="[^"]*border-primary[^"]*"[^>]*aria-pressed="true"/.test(out)).toBe(true)
  })

  test('until the marks are loaded every chip but All is off', () => {
    const out = chips({ disabled: true })
    expect(out.match(/disabled=""/g)).toHaveLength(4)
    expect(chips().match(/disabled=""/g)).toBeNull()
    const all = /<button[^>]*>(?:(?!<\/button>).)*>All</.exec(out)?.[0] ?? ''
    expect(all).not.toContain('disabled=""')
  })

  test('is a group with a name for assistive tools', () => {
    expect(chips()).toContain('role="group"')
    expect(chips()).toContain('aria-label="Show sites by mark"')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/site-mark-cell.test.ts`
Expected: FAIL: `Failed to resolve import "@/components/site-mark-cell"`.

- [ ] **Step 3: Create the cell and the menu**

Create `components/site-mark-cell.tsx`:

```tsx
"use client"

import { useId, useRef, useState, type KeyboardEvent } from "react"
import { AlertTriangle, Circle, CircleCheck, CircleDashed, CircleX } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { formatRelativeTime } from "@/lib/format-relative-time"
import {
  NO_MARK_LABEL, SITE_MARK_LABELS, SITE_MARK_NOTE_MAX, SITE_MARK_STATUSES, markAriaLabel, markTitle, normalizeNote,
  type SiteMark, type SiteMarkPatch, type SiteMarkStatus,
} from "@/lib/site-marks-input"

/** The cell's box: one width for the header, the loading and failed states and the cell itself, so the columns line up. */
export const MARK_CELL = "w-12 shrink-0 flex items-center justify-center"

/** The note box shows its counter from here to the limit. */
const COUNTER_FROM = SITE_MARK_NOTE_MAX - 100

/** The icon of a status. Shape tells the statuses apart as well as colour; no status is a faint dashed circle. */
export function MarkIcon({ status, className = "h-4 w-4" }: { status: SiteMarkStatus | null; className?: string }) {
  if (status === "done") return <CircleCheck className={`${className} text-green-600 dark:text-green-400`} aria-hidden />
  if (status === "skip") return <CircleX className={`${className} text-red-600 dark:text-red-400`} aria-hidden />
  if (status === "todo") return <Circle className={`${className} fill-current text-blue-600 dark:text-blue-400`} aria-hidden />
  return <CircleDashed className={`${className} text-muted-foreground`} aria-hidden />
}

/** The four choices of the menu, in the order shown: No mark first, then the statuses. */
const MENU_OPTIONS: Array<{ status: SiteMarkStatus | null; label: string }> = [
  { status: null, label: NO_MARK_LABEL },
  ...SITE_MARK_STATUSES.map(status => ({ status, label: SITE_MARK_LABELS[status] })),
]

interface SiteMarkMenuProps {
  host: string
  mark: SiteMark | null
  /** The text of the note box. */
  draft: string
  onDraftChange: (text: string) => void
  onChoose: (status: SiteMarkStatus | null) => void
  onNoteKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/** What the cell opens: the four choices, the note, and who set the mark and when. */
export function SiteMarkMenu({ host, mark, draft, onDraftChange, onChoose, onNoteKeyDown }: SiteMarkMenuProps) {
  const noteId = useId()
  const current = mark?.status ?? null
  return (
    <div className="space-y-3">
      <p className="truncate font-mono text-xs" title={host}>{host}</p>
      <div className="grid grid-cols-2 gap-1" role="group" aria-label="Mark">
        {MENU_OPTIONS.map(({ status, label }) => (
          <button
            key={label}
            type="button"
            aria-pressed={current === status}
            onClick={() => onChoose(status)}
            className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted ${
              current === status ? "border-primary bg-muted font-medium" : ""
            }`}
          >
            <MarkIcon status={status} className="h-3.5 w-3.5 shrink-0" />
            {label}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        <label htmlFor={noteId} className="text-[10px] uppercase tracking-wider text-muted-foreground">Note</label>
        <Textarea
          id={noteId}
          value={draft}
          maxLength={SITE_MARK_NOTE_MAX}
          onChange={event => onDraftChange(event.target.value)}
          onKeyDown={onNoteKeyDown}
          placeholder="Optional: why, or what you found"
          className="min-h-[72px] resize-none text-xs"
        />
        <p className="flex justify-between gap-2 text-[10px] text-muted-foreground">
          <span>Saved when this closes. Ctrl+Enter closes it.</span>
          {draft.length >= COUNTER_FROM && <span className="tabular-nums">{draft.length} / {SITE_MARK_NOTE_MAX}</span>}
        </p>
      </div>
      {mark?.updated_by && mark.updated_at && (
        <p className="text-[10px] text-muted-foreground">Set by {mark.updated_by}, {formatRelativeTime(mark.updated_at)}</p>
      )}
    </div>
  )
}

interface SiteMarkCellProps {
  /** The key the mark is kept under: the host the counts name. */
  host: string
  mark: SiteMark | null
  /** Loading: the marks have not arrived; failed: they could not be loaded. Neither is ever shown as "No mark". */
  availability: "loading" | "ready" | "failed"
  onChange: (patch: SiteMarkPatch) => void
}

/** The cell between a site's name and its Rows: the icon of its status, a dot when it has a note, and a menu to change both. */
export function SiteMarkCell({ host, mark, availability, onChange }: SiteMarkCellProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  // The note as last stored or sent: the box is saved when its text differs from this.
  const savedNote = useRef("")

  if (availability === "loading") {
    return (
      <span className={MARK_CELL} role="status" aria-label="Loading the mark">
        <span className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground/30" />
      </span>
    )
  }
  if (availability === "failed") {
    return (
      <span className={MARK_CELL} title="Marks could not be loaded">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-label="Marks could not be loaded" />
      </span>
    )
  }

  const status = mark?.status ?? null
  // With no status the icon is a faint outline that shows on hover and keyboard focus, and always on a touch screen; a note keeps it on.
  const iconVisibility = status !== null ? ""
    : mark?.note ? "opacity-60"
    : "opacity-0 group-hover/mark:opacity-60 group-focus-visible/mark:opacity-60 [@media(hover:none)]:opacity-40"

  const noteChanged = () => normalizeNote(draft) !== normalizeNote(savedNote.current)

  const flushNote = () => {
    if (!noteChanged()) return
    onChange({ note: draft })
    savedNote.current = draft
  }

  const handleOpenChange = (next: boolean) => {
    if (next) {
      const text = mark?.note ?? ""
      setDraft(text)
      savedNote.current = text
    } else {
      flushNote()
    }
    setOpen(next)
  }

  /** A mark button: saves the status, and an unsaved note with it in the same request, so nothing typed is lost. */
  const choose = (next: SiteMarkStatus | null) => {
    const withNote = noteChanged()
    if (next !== status || withNote) onChange(withNote ? { status: next, note: draft } : { status: next })
    savedNote.current = draft
    setOpen(false)
  }

  const onNoteKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      flushNote()
      setOpen(false)
    }
  }

  return (
    // The menu renders in a portal, but React still bubbles a click in a portal to the row's handler, which would open the row's detail: stop it here.
    <div className={MARK_CELL} onClick={event => event.stopPropagation()}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={markTitle(mark)}
            aria-label={markAriaLabel(host, mark)}
            className="group/mark relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className={`flex transition-opacity ${iconVisibility}`}>
              <MarkIcon status={status} />
            </span>
            {mark?.note && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-3">
          <SiteMarkMenu host={host} mark={mark} draft={draft} onDraftChange={setDraft} onChoose={choose} onNoteKeyDown={onNoteKeyDown} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
```

- [ ] **Step 4: Create the chips**

Create `components/site-mark-filter.tsx`:

```tsx
"use client"

import { MarkIcon } from "@/components/site-mark-cell"
import { MARK_FILTERS, MARK_FILTER_LABELS, type MarkFilter } from "@/lib/site-marks-input"

interface SiteMarkFilterProps {
  value: MarkFilter
  /** How many rows each chip would show. */
  counts: Record<MarkFilter, number>
  /** The marks are not loaded: every chip but All is off, since nothing can be told apart yet. */
  disabled: boolean
  onChange: (next: MarkFilter) => void
}

/** The chips above the Site Counts table: All, Done, Skip, To look at, No mark, each with the number of rows it shows. */
export function SiteMarkFilter({ value, counts, disabled, onChange }: SiteMarkFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show sites by mark">
      {MARK_FILTERS.map(filter => {
        const active = value === filter
        return (
          <button
            key={filter}
            type="button"
            disabled={disabled && filter !== "all"}
            aria-pressed={active}
            onClick={() => onChange(filter)}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              active ? "border-primary bg-muted font-medium" : "hover:bg-muted"
            }`}
          >
            {filter !== "all" && <MarkIcon status={filter === "none" ? null : filter} className="h-3 w-3 shrink-0" />}
            {MARK_FILTER_LABELS[filter]}
            <span className="tabular-nums text-muted-foreground">{counts[filter].toLocaleString()}</span>
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `npx vitest run __tests__/site-mark-cell.test.ts`
Expected: PASS: `Tests  19 passed (19)`.

- [ ] **Step 6: Commit**

```bash
git add components/site-mark-cell.tsx components/site-mark-filter.tsx __tests__/site-mark-cell.test.ts
git commit -m "feat(marks): the mark cell, its menu and the mark chips" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The row, and the page

The row moves out of the page into its own file, because a page module cannot export it for a test and its header has to change anyway (a button in a button is not valid HTML). Review this task as three things in one file pair: the row's structure, the marks shown and saved, and the chips, the sort and the export.

**Files:**
- Create: `components/site-count-row.tsx`
- Modify: `app/counts/page.tsx` (replace the whole file)
- Test: create `__tests__/site-count-row.test.ts`; replace `__tests__/site-counts-page.test.ts` (whole file: four existing assertions change because the code they read moved or changed, and nine are new)

**Interfaces:**
- Consumes: Task 1 (`markFilterCounts`, `markRank`, `markStateOf`, `matchesMarkFilter`, `isMarkableHost`, the types), Task 4 (`createSiteMarksStore`), Task 5 (`SiteMarkCell`, `MARK_CELL`, `SiteMarkFilter`); `planSites`, `orderSiteRows` from `lib/site-counts-input.ts`.
- Produces: the page. `components/site-count-row.tsx` exports `CountRow`, `fmt`, `COLS` (now with `mark`), and `SiteRow({ row, mark, availability, onMarkChange })`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/site-count-row.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect } from 'vitest'
import { COLS, SiteRow, fmt } from '@/components/site-count-row'
import type { SiteCount } from '@/lib/site-counts-input'
import type { SiteMark } from '@/lib/site-marks-input'

const counted = (over: Partial<SiteCount> = {}): SiteCount => ({
  host: 'corp.example', found: true, count: 30, host_count: 20, subdomain_count: 10, subdomains: 2,
  top_subdomains: [{ domain: 'app.corp.example', count: 10 }], ...over,
})
const notASite: SiteCount = {
  host: '', found: false, count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [], error: 'not a site address',
}
const mark = (status: SiteMark['status'], note: string | null = null): SiteMark => ({ status, note, updated_by: 'a@example.test', updated_at: '2026-10-29 10:00:00' })

const row = (props: Partial<ComponentProps<typeof SiteRow>> & { result?: SiteCount; site?: string } = {}) => {
  const { result = counted(), site = 'https://www.corp.example/login', ...rest } = props
  return renderToStaticMarkup(createElement(SiteRow, { row: { site, result }, mark: null, availability: 'ready', onMarkChange: () => {}, ...rest }))
}

/** How deep buttons nest in a piece of HTML: 1 when none is inside another, which is the only valid case. */
function buttonDepth(html: string): number {
  let depth = 0
  let deepest = 0
  for (const tag of html.matchAll(/<(\/?)button\b[^>]*>/g)) {
    depth += tag[1] === '/' ? -1 : 1
    deepest = Math.max(deepest, depth)
  }
  return deepest
}
const buttons = (html: string) => (html.match(/<button\b/g) ?? []).length

describe('SiteRow — the row of a counted site', () => {
  test('its header is a div, not a button: the mark has a button of its own inside it, and a button in a button is not valid', () => {
    const out = row()
    expect(out).not.toMatch(/<button[^>]*class="w-full flex/)
    expect(out).toContain('<div class="w-full flex items-center gap-3 px-4 py-2.5')
    expect(buttonDepth(out)).toBe(1)
    expect(buttonDepth(row({ result: counted({ count: 0, found: false }) }))).toBeLessThanOrEqual(1)
  })

  test('a site with rows has two buttons, the mark and a chevron that says whether the detail is open, with the site in its name', () => {
    const out = row()
    expect(buttons(out)).toBe(2)
    // the mark's own trigger says whether its menu is open as well, so there are two
    expect(out.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(out).toContain('aria-label="Show the details of https://www.corp.example/login"')
    expect(out).toContain('cursor-pointer')
  })

  test('a site with no rows has only the mark button, and nothing to open', () => {
    const out = row({ result: counted({ count: 0, found: false, host_count: 0, subdomain_count: 0, subdomains: 0, top_subdomains: [] }) })
    expect(buttons(out)).toBe(1)
    expect(out).not.toContain('Show the details of')
    expect(out.match(/aria-expanded=/g)).toHaveLength(1) // the mark's trigger only
    expect(out).toContain('cursor-default')
    expect(out).toContain('text-muted-foreground font-normal')
  })

  test('an entry that is not a site has no mark control, only a spacer of the width of the column, so the numbers stay in line', () => {
    const out = row({ site: 'localhost', result: notASite })
    expect(buttons(out)).toBe(0)
    expect(out).toContain('not a site address')
    expect(out).toContain(`<span class="${COLS.mark}"></span>`)
  })

  test('a host the cleaning would change again (three leading www.) has no mark control either', () => {
    const out = row({ result: counted({ host: 'www.corp.example' }) })
    expect(out).not.toContain('aria-label="Mark for')
    expect(out).toContain(`<span class="${COLS.mark}"></span>`)
  })

  test('the mark is for the host the counts named, not for what was typed', () => {
    const out = row()
    expect(out).toContain('aria-label="Mark for corp.example: No mark"')
    expect(out).not.toContain('Mark for https://')
    expect(row({ result: counted({ searched_as: 'corp.example' }) })).toContain('counted as corp.example')
  })

  test('the chevron stops its click, or the row\'s own handler would toggle the detail a second time', () => {
    expect(readFileSync(join(__dirname, '..', 'components/site-count-row.tsx'), 'utf8')).toMatch(/event\.stopPropagation\(\)\s+toggle\(\)/)
  })

  test('the mark sits between the name and the Rows number', () => {
    const out = row()
    const name = out.indexOf('title="https://www.corp.example/login"')
    const markButton = out.indexOf('aria-label="Mark for')
    const rows = out.indexOf('>30</span>')
    expect(name).toBeGreaterThan(0)
    expect(markButton).toBeGreaterThan(name)
    expect(rows).toBeGreaterThan(markButton)
  })

  test('shows what it is given of the mark: a status, a loading state or a failed one', () => {
    expect(row({ mark: mark('done') })).toContain('aria-label="Mark for corp.example: Done"')
    expect(row({ availability: 'loading' })).toContain('aria-label="Loading the mark"')
    expect(row({ availability: 'failed' })).toContain('title="Marks could not be loaded"')
    expect(row({ availability: 'failed' })).not.toContain('No mark')
  })

  test('the numbers and the closed detail are as they were: the rows, and the breakdown for wide windows', () => {
    const out = row()
    expect(out).toContain('>30</span>')
    expect(out).toContain('>20</span>')
    expect(out).toContain('>10</span>')
    expect(out).not.toContain('Subdomains with the most rows')
  })
})

describe('the columns', () => {
  test('the mark column is on screen at every width and as wide as its header; every number column from the xl breakpoint, as before', () => {
    expect(COLS.mark).toContain('w-12')
    expect(COLS.mark).not.toContain('hidden')
    expect(COLS.host).toMatch(/hidden xl:block/)
    expect(COLS.subs).toMatch(/hidden xl:block/)
    expect(COLS.distinct).toMatch(/hidden xl:block/)
    expect(COLS.rows).not.toContain('hidden')
  })

  test('a number that was not counted is a dash, never a zero', () => {
    expect(fmt(null)).toBe('—')
    expect(fmt(0)).toBe('0')
    expect(fmt(1234)).toBe((1234).toLocaleString())
  })
})
```

Replace the whole of `__tests__/site-counts-page.test.ts` with:

```ts
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const page = readFileSync(join(root, 'app/counts/page.tsx'), 'utf8')
const row = readFileSync(join(root, 'components/site-count-row.tsx'), 'utf8')
const sidebar = readFileSync(join(root, 'components/app-sidebar.tsx'), 'utf8')

describe('Site Counts page', () => {
  test('is in the Search group of the sidebar, open to every signed-in user, and points at /counts', () => {
    const entry = sidebar.match(/\{\s*title:\s*"Site Counts"[^}]*\}/)
    expect(entry).toBeTruthy()
    expect(entry![0]).toContain('url: "/counts"')
    expect(entry![0]).not.toContain('adminOnly')
    const searchGroup = sidebar.match(/title: "Search",[\s\S]*?items: \[([\s\S]*?)\]/)
    expect(searchGroup![1]).toContain('"Site Counts"')
  })

  test('asks the session route, in requests of the size the library names, and shows progress', () => {
    expect(page).toContain('"/api/lookup/counts"')
    expect(page).toContain('splitRequests(sites, SITE_COUNTS_REQUEST_SIZE)')
    expect(page).toContain('Counted ')
    expect(page).toContain('AbortController')
    expect(page).toContain('Stopped after ')
  })

  test('takes a pasted list or an uploaded file, and exports what it shows', () => {
    expect(page).toContain('type="file"')
    expect(page).toContain('siteCountsCsv(')
    expect(page).toContain('onDrop')
  })

  test('sorts by a column when its header is clicked, and exports in the order and the content it shows', () => {
    expect(page).toContain('nextSiteSort(')
    expect(page).toContain('orderSiteRows(rows, sort, ')
    expect(page).toContain('siteCountsCsv(shown)')
    for (const key of ['count', 'host_count', 'subdomain_count', 'subdomains', 'mark']) expect(page).toContain(`sortKey="${key}"`)
  })

  test('every sortable number column is on screen from the xl breakpoint, so each can be clicked at a laptop width', () => {
    expect(row).toMatch(/host: "hidden xl:block/)
    expect(row).toMatch(/subs: "hidden xl:block/)
    expect(row).toMatch(/distinct: "hidden xl:block/)
  })

  test('says when only hosts could be counted, and never shows a failed count as a zero', () => {
    expect(page).toContain('subdomains_counted === false')
    expect(row).toContain('fmt = (n: number | null) => (n === null ? "—"')
  })

  test('requires a signed-in user like the other pages', () => {
    expect(page).toContain('useAuth(true)')
  })
})

describe('Site Counts page — how its rows relate to the Credentials page', () => {
  test('says that Declutter and Unique are not applied here, so a search on the Credentials page can show fewer rows', () => {
    expect(page).toContain('Declutter and Unique are not applied')
    expect(page).toContain('.php pages')
  })
})

describe('Site Counts page — the marks', () => {
  test('asks for the marks of the whole list once per count, before the first request, through the store', () => {
    expect(page).toContain('void marksStore.load(planSites(sites).hosts)')
    expect(page.indexOf('marksStore.load(')).toBeLessThan(page.indexOf('splitRequests(sites, SITE_COUNTS_REQUEST_SIZE)'))
    expect(page).toContain('useSyncExternalStore(marksStore.subscribe, marksStore.getSnapshot, marksStore.getSnapshot)')
  })

  test('the page does not talk to the marks route itself: the store does, with its order of saves and its way back from a failed one', () => {
    expect(page).not.toContain('/api/lookup/marks')
    expect(page).toContain('createSiteMarksStore(')
    expect(page).toContain('onSaveFailed:')
    expect(page).toContain('void marksStore.change(host, patch)')
  })

  test('until the marks are loaded no row reads as "No mark" and nothing is filtered by mark, or the table would empty itself', () => {
    expect(page).toContain('markStateOf(row.result.host, marksSnap.marks, marksLoaded)')
    expect(page).toContain('const effectiveFilter: MarkFilter = marksLoaded ? markFilter : "all"')
    expect(page).toContain('disabled={!marksLoaded}')
  })

  test('the Mark column sorts by the rank of each row, and the table is the sorted rows narrowed by the chip', () => {
    expect(page).toContain('orderSiteRows(rows, sort, row => markRank(markStateOfRow(row)))')
    expect(page).toContain('const shown = ordered.filter(row => matchesMarkFilter(markStateOfRow(row), effectiveFilter))')
    expect(page).toContain('shown.map(row => (')
    expect(page).not.toContain('ordered.map(')
  })

  test('a failed load says so, with a Retry, and the counts stay as they are', () => {
    expect(page).toContain('marksSnap.status === "failed"')
    expect(page).toContain('The marks could not be loaded')
    expect(page).toContain('marksStore.retry()')
  })

  test('the chips say how many rows are shown of how many, and a chip that matches nothing offers the way back', () => {
    expect(page).toContain('Showing {shown.length.toLocaleString()} of {rows.length.toLocaleString()}')
    expect(page).toContain('No sites with this mark.')
    expect(page).toContain('onClick={() => setMarkFilter("all")}')
  })

  test('Export CSV follows the table on screen and carries the number of rows while a chip is on', () => {
    expect(page).toContain('siteCountsCsv(shown)')
    expect(page).toContain('Export CSV{effectiveFilter !== "all" ? ` (${shown.length.toLocaleString()})` : ""}')
  })

  test('each row is given its stored mark, how available the marks are, and the way to change them', () => {
    expect(page).toContain('mark={marksSnap.marks[row.result.host] ?? null}')
    expect(page).toContain('availability={markAvailability}')
    expect(page).toContain('onMarkChange={onMarkChange}')
  })

  test('the row lives in its own file, as a div with a real chevron button', () => {
    expect(page).not.toContain('function SiteRow(')
    expect(row).toContain('export function SiteRow(')
    expect(row).toContain('aria-expanded={open}')
    expect(row).not.toMatch(/<button\s+onClick=\{\(\) => expandable/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/site-count-row.test.ts __tests__/site-counts-page.test.ts`
Expected: FAIL: `site-count-row.test.ts` cannot load (`Failed to resolve import "@/components/site-count-row"`); in `site-counts-page.test.ts` the updated and the new assertions fail (the page still holds the old code).

- [ ] **Step 3: Create the row**

Create `components/site-count-row.tsx`:

```tsx
"use client"

import { useState } from "react"
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
 * the label.
 */
export const COLS = {
  mark: MARK_CELL,
  rows: "w-20 text-right shrink-0",
  host: "hidden xl:block w-24 text-right shrink-0",
  subs: "hidden xl:block w-28 text-right shrink-0",
  distinct: "hidden xl:block w-24 text-right shrink-0",
  chevron: "w-3.5 shrink-0",
}

interface SiteRowProps {
  row: CountRow
  /** The site's stored mark, null when it has none. */
  mark: SiteMark | null
  availability: "loading" | "ready" | "failed"
  onMarkChange: (host: string, patch: SiteMarkPatch) => void
}

export function SiteRow({ row, mark, availability, onMarkChange }: SiteRowProps) {
  const [open, setOpen] = useState(false)
  const { site, result } = row
  const expandable = (result.count ?? 0) > 0
  const muted = !result.error && result.count === 0
  const toggle = () => {
    if (expandable) setOpen(o => !o)
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
          <p className="text-xs text-muted-foreground">
            <span className="tabular-nums">{fmt(result.host_count)}</span> on the site itself
            {result.subdomain_count === null
              ? " · subdomains not counted"
              : <>{" · "}<span className="tabular-nums">{fmt(result.subdomain_count)}</span> on {fmt(result.subdomains)} subdomain{result.subdomains === 1 ? "" : "s"}</>}
          </p>
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
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Replace the page**

Replace the whole of `app/counts/page.tsx` with:

```tsx
"use client"
export const dynamic = "force-dynamic"

import { useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  BarChart3, Loader2, X, Download, Upload, ChevronDown, ChevronUp, ArrowUpDown, AlertTriangle, Square,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/hooks/useAuth"
import { localToUtcIso } from "@/lib/imported-window"
import { ImportedWindowFilter, EMPTY_IMPORTED_WINDOW, type ImportedWindowValue } from "@/components/imported-window-filter"
import { parseBatchText } from "@/lib/batch-input"
import {
  SITE_COUNTS_MAX_PER_LIST, SITE_COUNTS_REQUEST_SIZE, nextSiteSort, orderSiteRows, planSites, siteCountsCsv, splitRequests,
  type SiteCount, type SiteSort, type SiteSortKey,
} from "@/lib/site-counts-input"
import { markFilterCounts, markRank, markStateOf, matchesMarkFilter, type MarkFilter, type MarkState, type SiteMarkPatch } from "@/lib/site-marks-input"
import { createSiteMarksStore } from "@/lib/site-marks-client"
import { COLS, SiteRow, type CountRow } from "@/components/site-count-row"
import { SiteMarkFilter } from "@/components/site-mark-filter"

// ── Types ─────────────────────────────────────────────────────────────────────

interface CountsResponse {
  success: boolean
  subdomains_counted?: boolean
  results?: Record<string, SiteCount>
  error?: string
}

/** The biggest list file the page reads: a list of sites is a few KB, this only stops a wrong file from freezing the tab. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

// ── One column header ─────────────────────────────────────────────────────────

/**
 * The header of a sortable column, as a button: its arrow says whether the table is sorted by the column and which way (the Credentials headers look the
 * same). Off while there is nothing to sort by (the Mark column before the marks are loaded).
 */
function SortHeader({ label, sortKey, sort, onSort, className, disabled = false }: {
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SiteCountsPage() {
  useAuth(true)
  const { toast } = useToast()

  const [rawInput, setRawInput] = useState("")
  const [fileName, setFileName] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [rows, setRows] = useState<CountRow[]>([])
  const [subdomainsCounted, setSubdomainsCounted] = useState(true)
  const [stopped, setStopped] = useState(false)
  const [importedWindow, setImportedWindow] = useState<ImportedWindowValue>(EMPTY_IMPORTED_WINDOW)
  // The column the table is sorted by (null: the default order). It is a way of looking at the rows, so counting again keeps it.
  const [sort, setSort] = useState<SiteSort | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // The marks (design: docs/superpowers/specs/2026-10-29-site-marks-design.md): kept per site on the server, shown beside the counts, and read here
  // through a store that orders the saves and puts a failed one back.
  const marksStore = useMemo(
    () => createSiteMarksStore({
      fetch: (input, init) => fetch(input, init),
      onSaveFailed: message => toast({ title: "The mark was not saved", description: message, variant: "destructive" }),
    }),
    [toast],
  )
  const marksSnap = useSyncExternalStore(marksStore.subscribe, marksStore.getSnapshot, marksStore.getSnapshot)
  // The chip that narrows the table by mark. Like the sort, it is a way of looking at the rows, so counting again keeps it.
  const [markFilter, setMarkFilter] = useState<MarkFilter>("all")

  const sites = parseBatchText(rawInput)
  const overLimit = sites.length > SITE_COUNTS_MAX_PER_LIST
  const importedAfterIso = localToUtcIso(importedWindow.after)
  const importedBeforeIso = localToUtcIso(importedWindow.before)
  // What each row can show of its mark. While the marks are not loaded none can, and nothing is filtered by mark, or the table would empty itself.
  const marksLoaded = marksSnap.status === "ready"
  const markStateOfRow = (row: CountRow): MarkState => markStateOf(row.result.host, marksSnap.marks, marksLoaded)
  const effectiveFilter: MarkFilter = marksLoaded ? markFilter : "all"
  const markAvailability = marksSnap.status === "ready" ? "ready" : marksSnap.status === "failed" ? "failed" : "loading"
  // The rows as the table shows them, which is also the order and the content of the CSV: sorted, then narrowed by the mark chip.
  const ordered = orderSiteRows(rows, sort, row => markRank(markStateOfRow(row)))
  const shown = ordered.filter(row => matchesMarkFilter(markStateOfRow(row), effectiveFilter))
  const chipCounts = markFilterCounts(rows.map(markStateOfRow))
  const onSort = (key: SiteSortKey) => setSort(current => nextSiteSort(current, key))
  const onMarkChange = (host: string, patch: SiteMarkPatch) => { void marksStore.change(host, patch) }

  async function readFile(file: File) {
    if (running) return
    if (file.size > MAX_FILE_BYTES) {
      toast({ title: "That file is too big for a list of sites", description: `Up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`, variant: "destructive" })
      return
    }
    setRawInput(await file.text())
    setFileName(file.name)
    setRows([])
  }

  async function runCount() {
    if (sites.length === 0 || overLimit || running) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setStopped(false)
    setRows([])
    setSubdomainsCounted(true)
    setProgress({ done: 0, total: sites.length })
    // The marks of the whole list, asked for once alongside the first request, so a row arrives with its mark.
    void marksStore.load(planSites(sites).hosts)
    const bound = {
      ...(importedAfterIso ? { imported_after: importedAfterIso } : {}),
      ...(importedBeforeIso ? { imported_before: importedBeforeIso } : {}),
    }
    try {
      let done = 0
      for (const run of splitRequests(sites, SITE_COUNTS_REQUEST_SIZE)) {
        const res = await fetch("/api/lookup/counts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: run, ...bound }),
          signal: controller.signal,
        })
        // An expired session is redirected to the sign-in page, which is not JSON.
        if (res.redirected || res.status === 401) throw new Error("Your session has expired. Sign in again, then count again.")
        const json: CountsResponse = await res.json()
        if (!json.success || !json.results) throw new Error(json.error || "Counting failed")
        const results = json.results
        setRows(prev => [...prev, ...run.map(site => ({ site, result: results[site] }))])
        if (json.subdomains_counted === false) setSubdomainsCounted(false)
        done += run.length
        setProgress({ done, total: sites.length })
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setStopped(true)
      } else {
        toast({
          title: "Counting failed",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        })
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function downloadCSV() {
    const blob = new Blob([siteCountsCsv(shown)], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `site-counts-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Two spellings of one site are two lines but one site: the totals count each host once.
  const byHost = new Map<string, number>()
  for (const { result } of rows) if (result.host && result.count !== null) byHost.set(result.host, result.count)
  const totalRows = Array.from(byHost.values()).reduce((a, b) => a + b, 0)
  const withRows = rows.filter(r => r.result.found).length
  const notCounted = rows.filter(r => r.result.error).length
  const none = rows.length - withRows - notCounted

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-5">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          Site Counts
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Paste or upload a list of sites and see how many rows there are for each: the site itself and its subdomains, told apart
        </p>
      </div>

      {/* Side by side from 1024 px; below it the list sits above the counts, so the site names keep their width. */}
      <div className="flex flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
        {/* ── Left panel: the list ── */}
        <div
          className="w-full shrink-0 border-b lg:w-80 lg:border-b-0 lg:border-r flex flex-col p-4 gap-3"
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault()
            const file = e.dataTransfer.files?.[0]
            if (file) void readFile(file)
          }}
        >
          <div className="flex-1 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="site-list" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Sites or URLs (one per line)
              </label>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => fileRef.current?.click()} disabled={running}>
                <Upload className="mr-1 h-3 w-3" />Upload a list
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.csv,.tsv,.list,text/plain,text/csv"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) void readFile(file)
                  e.target.value = ""
                }}
              />
            </div>
            <Textarea
              id="site-list"
              value={rawInput}
              onChange={e => { setRawInput(e.target.value); setFileName(null) }}
              placeholder={"example.com\nhttps://www.corp.io/login\n*.bank.example\n..."}
              className="flex-1 resize-none font-mono text-xs min-h-[200px]"
              spellCheck={false}
              disabled={running}
            />
            <div className="flex items-center justify-between">
              <span className={`text-[10px] ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                {sites.length.toLocaleString()} site{sites.length === 1 ? "" : "s"}
                {fileName && ` · ${fileName}`}
                {overLimit && ` — at most ${SITE_COUNTS_MAX_PER_LIST.toLocaleString()}`}
              </span>
              {rawInput && !running && (
                <button
                  onClick={() => { setRawInput(""); setFileName(null); setRows([]); setStopped(false) }}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                >
                  <X className="h-2.5 w-2.5" />Clear
                </button>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Only imported in a window (optional)</label>
            <div><ImportedWindowFilter value={importedWindow} onChange={setImportedWindow} /></div>
          </div>

          {running ? (
            <Button variant="outline" onClick={stop} className="w-full">
              <Square className="mr-2 h-3.5 w-3.5" />Stop
            </Button>
          ) : (
            <Button onClick={runCount} disabled={sites.length === 0 || overLimit} className="w-full">
              <BarChart3 className="mr-2 h-4 w-4" />Count {sites.length > 0 ? sites.length.toLocaleString() : ""} site{sites.length === 1 ? "" : "s"}
            </Button>
          )}
          <p className="text-[10px] text-muted-foreground">
            A site is its host and every subdomain. A path in an entry is ignored. A count is rows, so a login seen in two files counts twice.
            Declutter and Unique are not applied, so a search on the Credentials page can show fewer rows (Declutter hides .php pages, IP hosts and ports).
          </p>
        </div>

        {/* ── Right panel: the counts ── */}
        <div className="flex-1 p-4 lg:overflow-auto">
          {rows.length === 0 && !running && (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              Paste or upload a list on the left and click Count
            </div>
          )}

          {(rows.length > 0 || running) && (
            <div className="flex flex-col gap-3">
              {running && (
                <div className="space-y-1" role="status" aria-live="polite">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Counted {progress.done.toLocaleString()} of {progress.total.toLocaleString()}…
                  </div>
                  <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} />
                </div>
              )}

              {stopped && (
                <p className="text-xs text-muted-foreground">
                  Stopped after {progress.done.toLocaleString()} of {progress.total.toLocaleString()} sites. Count again to finish the list.
                </p>
              )}

              {!subdomainsCounted && (
                <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    Only each site&apos;s own host could be counted right now (the index that finds subdomains is being rebuilt), so these numbers leave subdomains out. Count again in a few minutes.
                  </p>
                </div>
              )}

              {marksSnap.status === "failed" && (
                <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2" role="alert">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <p className="flex-1 text-[11px] text-amber-700 dark:text-amber-400">
                    The marks could not be loaded ({marksSnap.error}). The counts are fine; marking, the mark filter and the sort by mark are off until they load.
                  </p>
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void marksStore.retry()}>Retry</Button>
                </div>
              )}

              {rows.length > 0 && (
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary">{rows.length.toLocaleString()} counted</Badge>
                    <Badge variant={withRows > 0 ? "destructive" : "outline"}>{withRows.toLocaleString()} with rows</Badge>
                    <Badge variant="outline">{none.toLocaleString()} with none</Badge>
                    {notCounted > 0 && <Badge variant="outline" className="text-amber-600 border-amber-500/50">{notCounted.toLocaleString()} not counted</Badge>}
                    <span className="text-xs text-muted-foreground">{totalRows.toLocaleString()} rows in all</span>
                  </div>
                  <Button size="sm" variant="outline" onClick={downloadCSV}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />Export CSV{effectiveFilter !== "all" ? ` (${shown.length.toLocaleString()})` : ""}
                  </Button>
                </div>
              )}

              {rows.length > 0 && (
                <div className="flex items-center gap-3 flex-wrap">
                  <SiteMarkFilter value={effectiveFilter} counts={chipCounts} disabled={!marksLoaded} onChange={setMarkFilter} />
                  {effectiveFilter !== "all" && (
                    <span className="text-xs text-muted-foreground">
                      Showing {shown.length.toLocaleString()} of {rows.length.toLocaleString()} ·{" "}
                      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setMarkFilter("all")}>Show all</button>
                    </span>
                  )}
                </div>
              )}

              {rows.length > 0 && (
                <div className="flex items-center gap-3 px-4 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <span className="min-w-0 flex-1">Site</span>
                  <SortHeader label="Mark" sortKey="mark" sort={sort} onSort={onSort} className={COLS.mark} disabled={!marksLoaded} />
                  <SortHeader label="Rows" sortKey="count" sort={sort} onSort={onSort} className={COLS.rows} />
                  <SortHeader label="On the site" sortKey="host_count" sort={sort} onSort={onSort} className={COLS.host} />
                  <SortHeader label="On subdomains" sortKey="subdomain_count" sort={sort} onSort={onSort} className={COLS.subs} />
                  <SortHeader label="Subdomains" sortKey="subdomains" sort={sort} onSort={onSort} className={COLS.distinct} />
                  <span className={COLS.chevron} />
                </div>
              )}

              <div className="flex flex-col gap-2">
                {shown.map(row => (
                  <SiteRow
                    key={row.site}
                    row={row}
                    mark={marksSnap.marks[row.result.host] ?? null}
                    availability={markAvailability}
                    onMarkChange={onMarkChange}
                  />
                ))}
                {rows.length > 0 && shown.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No sites with this mark.{" "}
                    <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setMarkFilter("all")}>Show all</button>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run the tests to see them pass, and typecheck**

Run: `npx vitest run __tests__/site-count-row.test.ts __tests__/site-counts-page.test.ts`
Expected: PASS: `Test Files  2 passed (2)`, `Tests  29 passed (29)` (12 in the row test, 17 in the page test).

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add components/site-count-row.tsx app/counts/page.tsx __tests__/site-count-row.test.ts __tests__/site-counts-page.test.ts
git commit -m "feat(counts): marks, a mark filter and a sort by mark on the Site Counts page" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The README, and the rehearsal step

**Files:**
- Modify: `README.md` (the Site counts bullet), `scripts/e2e-batch-lookup.ts` (header and a new step 8)

**Interfaces:**
- Consumes: the route of Task 3 and the page's `/counts`, on the built image of Task 9. Uses what the script already has in scope: `asSession`, `call`, `check`, `compose`, `counts`, `appHealthy`, `login`, `waitFor`, `secrets`, `COUNTS_SITE`.
- Produces: 11 new checks; the script's total becomes the earlier total plus 11 (90 of 90 before, so 101 of 101).

- [ ] **Step 1: The README bullet**

In `README.md`, replace:

```text
and a path is ignored. The reversed-domain projection finds the subdomains
```

with:

```text
and a path is ignored. A site can be marked Done, Skip or To look at, with a note, and the mark stays with the site: it is kept in SQLite under the host the counts name, so every spelling of a site shows one mark, and it is shared by everyone who signs in. Chips narrow the table by mark, the Mark header sorts by it, and Export CSV follows what is shown (`lib/site-marks.ts`, `POST` and `PUT /api/lookup/marks`). The reversed-domain projection finds the subdomains
```

- [ ] **Step 2: The rehearsal step**

Step 8 goes right before the existing step that clears the projection ("Last, because it changes the table"), so the marks are checked while the projection is intact. It recreates only the app (the way `scripts/e2e-disk-gate.ts` does, keeping the data volume) and reads the mark back.

In `scripts/e2e-batch-lookup.ts` (edit 1 of 2), replace:

```text
 * fallback: with the projection cleared the answer says only hosts were counted, and after MATERIALIZE it counts subdomains again.
```

with:

```text
 * fallback: with the projection cleared the answer says only hosts were counted, and after MATERIALIZE it counts subdomains again.
 * The site marks (docs/superpowers/specs/2026-10-29-site-marks-design.md) are checked on the same site: POST and PUT /api/lookup/marks with a session, one
 * mark for every spelling of the site, the refusals, and that a mark and its note survive recreating only the app (its data volume is kept).
```

In `scripts/e2e-batch-lookup.ts` (edit 2 of 2), replace:

```text
    // Last, because it changes the table: without the reversed-domain projection on every part only hosts can be counted, and the answer says so.
```

with:

```text
    console.log('8. Site marks: POST and PUT /api/lookup/marks (session), kept when only the app container is recreated')
    const marks = {
      read: (hosts: string[]) => asSession('POST', '/api/lookup/marks', { hosts }),
      change: (body: unknown) => asSession('PUT', '/api/lookup/marks', body),
    }
    const anonRead = await call('POST', '/api/lookup/marks', { hosts: [COUNTS_SITE] })
    const anonChange = await call('PUT', '/api/lookup/marks', { host: COUNTS_SITE, status: 'done' })
    check('the marks route needs a session (401 without one, both verbs)', anonRead.status === 401 && anonChange.status === 401, `${anonRead.status} / ${anonChange.status}`)
    const unmarked = await marks.read([COUNTS_SITE])
    check('a site nobody marked has no mark', unmarked.status === 200 && unmarked.json?.success === true && Object.keys(unmarked.json.marks ?? {}).length === 0, JSON.stringify(unmarked.json).slice(0, 160))
    const setTodo = await marks.change({ host: COUNTS_SITE, status: 'todo' })
    check('PUT sets a status, and answers with what is stored and who set it',
      setTodo.status === 200 && setTodo.json?.mark?.status === 'todo' && setTodo.json.mark.note === null && setTodo.json.mark.updated_by === secrets.REHEARSAL_ADMIN_EMAIL, JSON.stringify(setTodo.json).slice(0, 220))
    // The page keeps a mark under the host the counts name, so the three spellings below must all be counted under one host and show the one mark.
    const spellings = [COUNTS_SITE, `https://www.${COUNTS_SITE}/login`, `*.${COUNTS_SITE}`]
    const spelled = await counts({ domains: spellings })
    const spelledHosts = spellings.map(s => spelled.json?.results?.[s]?.host as string)
    check('three spellings of the site are counted under one host', spelledHosts.every(h => h === COUNTS_SITE), JSON.stringify(spelledHosts))
    const shared = await marks.read(spelledHosts)
    check('and show the one mark', Object.keys(shared.json?.marks ?? {}).length === 1 && shared.json.marks[COUNTS_SITE]?.status === 'todo', JSON.stringify(shared.json).slice(0, 200))
    const noted = await marks.change({ host: COUNTS_SITE, note: '  looked at the login page  ' })
    check('a note is trimmed and the status stays', noted.json?.mark?.note === 'looked at the login page' && noted.json.mark.status === 'todo', JSON.stringify(noted.json).slice(0, 220))
    const refusals = await Promise.all([
      marks.change({ host: `https://www.${COUNTS_SITE}/login`, status: 'done' }), // a host as typed, not as the counts name it
      marks.change({ host: COUNTS_SITE, status: 'finished' }),
      marks.change({ host: COUNTS_SITE, note: 'x'.repeat(501) }),
      marks.change({ host: COUNTS_SITE }),
      marks.read([]),
    ])
    check('a host as typed, a status outside the list, a note over 500 characters, an empty change and an empty read are all refused (400)', refusals.every(r => r.status === 400), refusals.map(r => r.status).join(','))
    const unchanged = await marks.read([COUNTS_SITE])
    check('and none of them changed the mark', unchanged.json?.marks?.[COUNTS_SITE]?.status === 'todo' && unchanged.json.marks[COUNTS_SITE].note === 'looked at the login page', JSON.stringify(unchanged.json).slice(0, 220))

    // The data volume outlives the container: recreate only the app (as scripts/e2e-disk-gate.ts does) and read the mark back.
    compose(['up', '-d', '--no-deps', '--force-recreate', 'app'])
    const appBack = await waitFor('the recreated app healthy', appHealthy, 300_000)
    check('the app was recreated and came back healthy', !!appBack)
    if (appBack) {
      await login()
      const afterRecreate = await marks.read([COUNTS_SITE])
      const kept = afterRecreate.json?.marks?.[COUNTS_SITE]
      check('after the recreate the status and the note are still there', kept?.status === 'todo' && kept.note === 'looked at the login page', JSON.stringify(afterRecreate.json).slice(0, 220))
      const cleared = await marks.change({ host: COUNTS_SITE, status: null, note: null })
      const gone = await marks.read([COUNTS_SITE])
      check('clearing both removes the mark', cleared.status === 200 && cleared.json?.mark === null && Object.keys(gone.json?.marks ?? {}).length === 0, JSON.stringify(cleared.json).slice(0, 160))
    }

    // Last, because it changes the table: without the reversed-domain projection on every part only hosts can be counted, and the answer says so.
```

- [ ] **Step 3: Typecheck the scripts and the tests**

Run: `npm run typecheck:tests`
Expected: exit 0, no output.

- [ ] **Step 4: Commit**

```bash
git add README.md scripts/e2e-batch-lookup.ts
git commit -m "docs(counts): the marks in the README, and rehearsal step 8" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The gates, and the mutation checks

**Files:** none new. Fix whatever a gate shows, in the file that owns it, with a test first.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (the app, then `scripts/` and `__tests__/`).

- [ ] **Step 2: The whole suite**

Run: `npm test`
Expected: exit 0. At commit `2f96546` the suite was `Test Files  276 passed | 14 skipped (290)`, `Tests  4542 passed | 111 skipped (4653)`; with this work it is `282 passed | 14 skipped (296)` and `4672 passed | 111 skipped (4783)` (6 new files, 130 new tests). If `main` has moved, the totals move with it, but the difference is 6 files and 130 tests.

- [ ] **Step 3: Lint**

In the primary checkout: `npm run lint`. In a nested worktree: `npx eslint --no-eslintrc -c .eslintrc.json app lib components hooks __tests__/site-marks-input.test.ts __tests__/site-marks.test.ts __tests__/site-marks-routes.test.ts __tests__/site-marks-client.test.ts __tests__/site-mark-cell.test.ts __tests__/site-count-row.test.ts __tests__/site-counts-page.test.ts __tests__/site-counts-input.test.ts`
Expected: exit 0, no output.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0; `Compiled successfully`; the route table lists `/api/lookup/marks` and `/counts`.

- [ ] **Step 5: The mutation checks**

The tests are only worth what they catch. This script (keep it outside the repository, for example in the session's scratch directory) applies each of 22 mistakes to a file, runs the eight test files, and restores the file. Run it from the worktree root: `python3 <where you saved it>/mutations.py`. A mutation that survives means a test is missing: write it first, see it fail, then fix the code or the test.

```python
"""Applies each of 22 mistakes to one file, runs the marks tests, and restores the file: every mutation must be KILLED (a test fails)."""
import pathlib, re, subprocess, sys
WT = pathlib.Path.cwd()  # run it from the root of the worktree
TESTS = ['__tests__/site-marks-input.test.ts', '__tests__/site-marks.test.ts', '__tests__/site-marks-routes.test.ts', '__tests__/site-marks-client.test.ts',
         '__tests__/site-mark-cell.test.ts', '__tests__/site-count-row.test.ts', '__tests__/site-counts-page.test.ts', '__tests__/site-counts-input.test.ts']

M = [
 ('M1', 'an emptied row is kept', 'lib/site-marks.ts', "      if (stored) dbRun(`DELETE FROM site_marks WHERE host = ?`, [host])\n", ""),
 ('M2', 'a field left out is read as null', 'lib/site-marks-input.ts', "const status = patch.status !== undefined ? patch.status : (current?.status ?? null)", "const status = patch.status ?? null"),
 ('M3', 'no status check', 'lib/site-marks-input.ts', "    if (status !== null && !isStatus(status)) return { ok: false, error: `status must be one of ${SITE_MARK_STATUSES.join(', ')}, or null` }\n", ""),
 ('M4', 'no note cap', 'lib/site-marks-input.ts', "    if (note !== null && note.length > SITE_MARK_NOTE_MAX) return { ok: false, error: `note is at most ${SITE_MARK_NOTE_MAX} characters` }\n", ""),
 ('M5', 'a host is not required to be unchanged by the cleaning', 'lib/site-marks-input.ts', "  return host !== '' && siteEntry(host).host === host", "  return host !== ''"),
 ('M6', 'PUT has no session check', 'app/api/lookup/marks/route.ts', "export async function PUT(request: NextRequest) {\n  const user = await validateRequest(request)\n  if (!user) {\n    return NextResponse.json({ success: false, error: \"Unauthorized\" }, { status: 401 })\n  }\n", "export async function PUT(request: NextRequest) {\n  const user = (await validateRequest(request))!\n"),
 ('M7', 'the sort ranks are flipped', 'lib/site-marks-input.ts', "{ todo: 3, none: 2, done: 1, skip: 0 }", "{ todo: 0, none: 1, done: 2, skip: 3 }"),
 ('M8', 'a row whose marks are not loaded is read as No mark', 'lib/site-marks-input.ts', "  if (!loaded || !isMarkableHost(host)) return null", "  if (!isMarkableHost(host)) return null"),
 ('M9', 'the No mark count includes rows that cannot be marked', 'lib/site-marks-input.ts', "  for (const state of states) if (state !== null) counts[state] += 1", "  for (const state of states) counts[state ?? 'none'] += 1"),
 ('M10a', 'a failed load is shown as the normal cell (the cell)', 'components/site-mark-cell.tsx', '  if (availability === "failed") {', '  if (availability === "failed" && false) {'),
 ('M10b', 'a failed load is stored as ready and empty (the store)', 'lib/site-marks-client.ts', "      publish({ status: 'failed', marks: {}, error: error instanceof Error ? error.message : 'The marks could not be loaded' })", "      publish({ status: 'ready', marks: {}, error: null })"),
 ('M11', 'Export CSV ignores the filter', 'app/counts/page.tsx', "siteCountsCsv(shown)", "siteCountsCsv(ordered)"),
 ('M12', 'a click in the menu reaches the row', 'components/site-mark-cell.tsx', "<div className={MARK_CELL} onClick={event => event.stopPropagation()}>", "<div className={MARK_CELL}>"),
 ('M13', 'no per-site queue for saves', 'lib/site-marks-client.ts', "    const run = (tails.get(host) ?? Promise.resolve()).then(async () => {", "    const run = Promise.resolve().then(async () => {"),
 ('M14', 'a change that changes nothing rewrites who and when', 'lib/site-marks.ts', "    if (stored && stored.status === next.status && stored.note === next.note) return toMark(stored)\n", ""),
 ('M15', 'an earlier answer is shown over a later click', 'lib/site-marks-client.ts', "        if (finish()) setMark(host, stored)", "        finish()\n        setMark(host, stored)"),
 ('M16', 'a failed save is not put back', 'lib/site-marks-client.ts', "        if (finish()) setMark(host, confirmed.get(host) ?? null)", "        finish()"),
 ('M17', 'a row that cannot show a mark is ranked 0 in the sort', 'lib/site-counts-input.ts', "(markRankOf?.(row) ?? null)", "(markRankOf?.(row) ?? 0)"),
 ('M18', 'the mark chip stays on while the marks are not loaded', 'app/counts/page.tsx', 'const effectiveFilter: MarkFilter = marksLoaded ? markFilter : "all"', 'const effectiveFilter: MarkFilter = markFilter'),
 ('M19', 'an entry that is not a site gets a mark control', 'components/site-count-row.tsx', "{isMarkableHost(result.host) ? (", "{true ? ("),
 ('M20', 'an older load that answers late is not ignored', 'lib/site-marks-client.ts', "      if (mine !== generation) return\n      const marks = answer.marks ?? {}", "      const marks = answer.marks ?? {}"),
 ('M21', "the chevron does not stop its click (the row toggles twice)", 'components/site-count-row.tsx', "                event.stopPropagation()\n                toggle()", "                toggle()"),
]

def run():
    r = subprocess.run(['npx', 'vitest', 'run', *TESTS], cwd=WT, capture_output=True, text=True, timeout=600)
    out = r.stdout + r.stderr
    failed = sorted(set(re.findall(r'^\s*(?:×|FAIL)\s+(__tests__/[\w.-]+) > (.*?)(?: \d+ms)?$', out, re.M)))
    summary = re.search(r'Tests\s+(.*)', out)
    return r.returncode, (summary.group(1).strip() if summary else '?'), failed

code, summary, _ = run()
print(f'baseline: exit {code}, {summary}')
assert code == 0, 'the baseline must pass before mutating'
survivors = []
for mid, what, rel, old, new in M:
    p = WT / rel
    original = p.read_text()
    assert original.count(old) == 1, (mid, original.count(old))
    p.write_text(original.replace(old, new))
    try:
        code, summary, failed = run()
    finally:
        p.write_text(original)
    killed = code != 0
    first = failed[0][1][:95] if failed else ''
    files = sorted({f[0].replace('__tests__/', '') for f in failed})
    print(f'{mid:5} {"KILLED  " if killed else "SURVIVED"} {what:62} {summary:22} {",".join(files)}')
    if not killed: survivors.append(mid)
print('survivors:', survivors or 'none')
```

Expected: `baseline: exit 0, 175 passed (175)`, then 22 lines that all say `KILLED`, then `survivors: none`. (At commit `2f96546` the last full run killed all 22; the files that caught each one are printed on its line.)

- [ ] **Step 6: Commit any fix**

Only if a gate or a mutation needed a change:

```bash
git add <the files you changed>
git commit -m "fix(marks): <what the gate showed>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The candidate image, the rehearsal, the pane check, and the local deploy

This follows `CLAUDE.md`: tag the running image first, build a candidate under its own tag, rehearse it, deploy from the primary checkout. Deploying is local only (this laptop); nothing is pushed to a registry. The commands that touch the running stack run from the primary checkout; the build and the rehearsal can run from the worktree.

- [ ] **Step 1: Check the stack is quiet**

No import is running and `inbox/processing` is empty (`ls inbox/processing` in the primary checkout prints nothing). Check the Inbox page, or `docker logs --since 10m ulpsuite_app | tail -20`, for an import in progress; if one is running, wait for it.

- [ ] **Step 2: Tag the running image BEFORE building anything**

containerd drops an image when its tag moves, so the rollback tag comes first:

```bash
docker tag "$(docker inspect -f '{{.Image}}' ulpsuite_app)" ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz)
docker images ulp-suite-app --format '{{.Tag}} {{.ID}}' | head -5
```
Expected: a `rollback-<UTC time>` tag whose id is the one `latest` has now. If `docker` fails with a credsStore error, scope a config to the command: `CFG=$(mktemp -d) && echo '{}' > $CFG/config.json` and prefix the docker commands with `DOCKER_CONFIG=$CFG` (this laptop's global Docker config is broken; do not edit it).

- [ ] **Step 3: Build the candidate under its own tag**

From the worktree, with the feature branch's tip commit:

```bash
git rev-parse --short HEAD
git archive HEAD | DOCKER_CONFIG=$CFG docker build -t ulp-suite-app:marks-candidate -
```
Expected: the build ends with the image tagged `ulp-suite-app:marks-candidate`. It takes a few minutes. The image that is rehearsed is the image that is deployed.

- [ ] **Step 4: Rehearse it on the isolated stack**

```bash
CANDIDATE_IMAGE=ulp-suite-app:marks-candidate npx tsx scripts/e2e-batch-lookup.ts --keep
```
Expected: about 4 to 5 minutes, ending `101/101 checks passed` (the earlier total plus the 11 of step 8) and exit 0. `--keep` leaves the stack running on `http://127.0.0.1:3101`. If a check fails, the script prints why: fix the code with a test first, rebuild the candidate (Step 3) and run again after removing the stack (Step 6 shows how).

- [ ] **Step 5: Look at the page in the browser pane, on that stack**

Open `http://127.0.0.1:3101/login` in the Browser pane and sign in with the rehearsal admin: its address and password are in the app container's environment (`docker exec ulprehearsal_app printenv ADMIN_EMAIL`, `... ADMIN_PASSWORD`); they are throwaway, type them with real key events, and never repeat them in a reply. Find the seeded site with `docker exec ulprehearsal_clickhouse clickhouse-client --query "SELECT DISTINCT domain FROM ulp.credentials WHERE domain LIKE 'counts-%' LIMIT 5"`, then open `/counts`, paste that site in three spellings (the bare host, `https://www.<host>/login`, `*.<host>`) plus a few invented sites and `localhost`, and count. Check, and note what you see:

1. Every row has a mark cell except `localhost` ("not a site address"); the three spellings show one mark once one is set.
2. The cell of a site with no mark is invisible until hover or keyboard focus (always faint on a touch screen); the four states look right: Done (green check), Skip (red X), To look at (blue dot), a note (a small dot on the icon).
3. A click on the cell opens the menu and does not open the row's detail; Esc, a click away and Ctrl+Enter each close it and save a changed note; a mark button with a typed note saves both (reopen to see them).
4. The chips count rows and narrow the table; "Showing N of M" and "Show all" appear; "Export CSV (N)" carries the number; filter to "No mark", mark a row, and it leaves the table.
5. The Mark header sorts To look at, No mark, Done, Skip; a second click reverses it; a third restores the default order.
6. A failed load: in the page's console override `window.fetch` so the `POST` to `/api/lookup/marks` answers HTTP 500, count again: warnings in the cells (never "No mark"), the alert with the reason, the chips (but All) and the Mark header off. Restore `fetch`, click Retry: the marks are back. A failed save: make the `PUT` answer HTTP 500, click Done: the cell goes back and a toast says the mark was not saved.
7. Keyboard only: Tab reaches the cell, Enter opens it, the buttons and the note box are reachable, the chevron is a button that opens the detail.
8. No horizontal overflow at 1440, 1280, 1100 and 375 px; measure the site-name column and the Mark header (`getBoundingClientRect()`). The earlier measurement: name column 306 / 146 / 306 / 131 px, header content 47 of 48 px. If a different font clips the header, widen `MARK_CELL` to `w-14`, which `COLS.mark` and the header follow.

Reset the viewport (`resize_window` with the `desktop` preset) when you are done.

- [ ] **Step 6: Take the rehearsal stack down**

```bash
REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
```

- [ ] **Step 7: Deploy locally**

Check again that `inbox/processing` is empty. Then, from the PRIMARY checkout:

```bash
docker tag ulp-suite-app:marks-candidate ulp-suite-app:latest
docker compose up -d --no-deps --no-build app
```
Verify: `docker inspect -f '{{.State.Health.Status}} {{.RestartCount}}' ulpsuite_app` says `healthy 0` after the start; `docker logs --since 3m ulpsuite_app` shows no error and the same "DDL v... already applied" line as before the deploy (there is no ClickHouse work); the table exists:

```bash
docker exec ulpsuite_app node -e "const D=require('better-sqlite3');const d=new D('/app/data/ulp.db',{readonly:true});console.log(d.prepare(\"select name from sqlite_master where name='site_marks'\").all())"
```
Expected: `[ { name: 'site_marks' } ]`. Without credentials, `POST` and `PUT` on the published port (see `docker port ulpsuite_app`) answer 401 and `GET /counts` redirects to the sign-in page. The owner's session survives the restart: ask them to open `/counts`, mark a site and reload.

Rollback, if anything is wrong: `docker tag ulp-suite-app:rollback-<the time you tagged> ulp-suite-app:latest`, then the same `docker compose up -d --no-deps --no-build app` from the primary checkout. The `site_marks` table stays in `ulp.db` and the image that ran before ignores it.

- [ ] **Step 8: Close the spec, merge, remember**

1. Update `docs/superpowers/specs/2026-10-29-site-marks-design.md` the way the earlier specs were closed: replace the Status line with `**implemented, verified and deployed locally on <date>**` plus the commit and the image id, change "Proof (how it will be shown)" and "Rollout (planned)" to what was done (the real numbers: tests, the 22 mutations, the rehearsal's `101/101`, the widths measured on the built image, the deploy checks), and keep "Not done" as it is. Commit it as `docs(specs): site marks: what shipped and what it measured`.
2. Merge the branch into `main` fast-forward and push `origin/main` (the owner's standing permission once verified); use `superpowers:finishing-a-development-branch`, then leave the worktree.
3. Save a project memory for the feature (its commit, the image, the rollback tag, what the owner has not tried yet), as the earlier features have.
