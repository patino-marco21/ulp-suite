# Imported-after Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every surface of ulp-suite that returns credential rows (or a list derived from them) an `imported_after` / `imported_before` bound that is exact to the second, so repeating a search or an export returns only what arrived since, and first fix the "Newest first" plan that silently drops mixed-case word matches.

**Architecture:** One server helper, `lib/imported-range.ts`, parses the bound (UTC, `after` exclusive, `before` inclusive, the old `date_from` / `date_to` as aliases) and writes the SQL in two forms: a plain predicate that is always correct, and the same bound repeated on `proj_imported_desc`'s key expression, used only for time-ordered or aggregate queries over searches whose predicates mean the same on a projection. Every route calls it. A prerequisite fix (P0) makes the Newest-first windows spell word tokens over `lower(col)`, because a projection has no text index and `hasToken` there is case-sensitive. The Credentials page gets date-time inputs (local time, UTC echo), presets, a "since last export" memory and honest export headers.

**Tech Stack:** Next.js 15 route handlers and React client components, TypeScript, ClickHouse 26.3 (`ulp.credentials`, `proj_imported_desc`), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-10-05-imported-after-filter-design.md` (read it first; its "Measurements" section holds every number this plan relies on).

## Global Constraints

Every task's requirements include this section.

- The bound is `imported_after` (EXCLUSIVE) and `imported_before` (INCLUSIVE): absolute UTC instants, to the second. A bare date (`2026-10-05`) includes its whole UTC day on its own side. Fractional seconds are floored. Years 1970 to 2106-02-07T06:28:15Z only. An invalid value is a 400 `{ success: false, error }` that names the parameter, and no query runs.
- The old `date_from` / `date_to` are the same bounds under their old names (a bare date means exactly what it always did). When both spellings are given, the stricter bound wins.
- PLAIN SQL form, always correct, the column bare on the left: `imported_at > toDateTime({impAfter:Int64})` and `imported_at <= toDateTime({impBefore:Int64})`.
- PROJECTION form = plain + `negate(toUnixTimestamp(imported_at)) < {impKeyHi:Int64}` (= `-lower`) and `>= {impKeyLo:Int64}` (= `-upper`), written exactly as `IMPORTED_KEY_EXPR` in `lib/newest-first.ts`. Used only when ALL hold: a lower bound is set; the query is time-ordered (`imported_desc`, `imported_asc`) or an aggregate; the search is index-neutral (no word token, no LIKE-fallback token, no regex); `getNewestFirstStatus` says ready.
- The helper NEVER adds `use_skip_indexes` or `optimize_use_projections`. (A projection part has no text index, so `hasToken` there is case-sensitive; skip-off also made a rare-word default-sort query 4x slower, 8 s to 31 s.)
- The 10,000-row cap on csv / json / ndjson / ulp / userpass exports stays, but the query asks for 10,001 rows and the response says `X-Export-Truncated: 1` when it was cut. Window headers: `X-Export-Imported-After` / `X-Export-Imported-Before`. File-name suffix: `_after-YYYYMMDDTHHMMSSZ_before-YYYYMMDDTHHMMSSZ` before the extension.
- "Since last export": the cut is remembered in the browser (`localStorage`), is never later than now minus 120 s, and only moves after a COMPLETE export that started at the beginning or exactly at the previous cut.
- No schema, projection, skip-index or data change. Nothing in this plan writes to ClickHouse; live checks are read-only.
- This repository is PUBLIC. Never put the owner's real search terms, query-log excerpts or credential values in code, tests, comments, docs or commit messages. Tests use the generic labels and brand names already in the repo (`binance.com`, `ledger`, `trezor.io`, `@gmail.com`) or synthetic data.
- Every commit message ends with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Next.js route files may only export HTTP handlers and route config: keep helpers and constants in route files un-exported.

## Execution notes (read before Task 1)

**Where to work.** Use a fresh worktree (`EnterWorktree`, name `imported-after-filter`) or work on `main`; either is fine for this repo. If you use a worktree, these four hazards are real and each has cost hours before:

1. `.claude/worktrees/<name>` is nested INSIDE `/home/cole/ulp-suite`. Never `cd /home/cole/ulp-suite` and never use bare `/home/cole/ulp-suite/...` paths for Read/Edit/Write while in the worktree. Before the first git or file operation of a turn that matters, run `git branch --show-current` and `git rev-parse --show-toplevel` and check they name the worktree, not `main` and not `/home/cole/ulp-suite`.
2. `EnterWorktree` branches from `origin/main`. The spec and this plan are committed to local `main` first, so right after entering run `git merge main --ff-only` inside the worktree.
3. A fresh worktree has an empty `node_modules`: run `npm install` once before anything else.
4. `next lint` fails in a nested worktree ("Plugin @next/next was conflicted"). Lint with: `npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .js,.jsx,.ts,.tsx app components lib hooks` (exit 0 = clean). Do not edit `.eslintrc.json`.

**Commands used throughout** (run from the repo or worktree root):

```bash
npx vitest run <file> [<file> ...]      # unit tests; the three *.live.test.ts files are skipped unless their env var is set
npx tsc --noEmit                        # no output = clean
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . <files>   # no output = clean
```

**Docker.** Never run `docker compose` from a subagent or from inside a worktree: the controller deploys from the MAIN checkout after the merge (Task 10). Read-only ClickHouse access from anywhere is `docker exec ulpsuite_clickhouse clickhouse-client --use_query_cache=0 --query "..." < /dev/null` (the live tests find the container's IP themselves). `docker ps` should show `ulpsuite_clickhouse` healthy before Tasks 2 and 10.

**Review loops stay lean.** One fix and one re-review pass per task at most; findings that are only Minor go in the final report, not a loop. Task 10 is mostly verification: run it directly, not through an implementer/reviewer pair.

**Live checks measure, they do not trust the diff.** Where a step says "expected" for a live run, compare with it; a surprise means STOP and report, do not weaken a test.

---

### Task 1: The search helpers (P0 foundation)

Two small additions to `lib/ulp-search.ts`: the rule for which searches mean the same on the table and on a projection, and a case-insensitive spelling of word tokens.

**Files:**
- Modify: `lib/ulp-search.ts` (export `ParsedToken`; add `isIndexNeutralSearch`, `BuildULPWhereOptions`; give `buildULPWhere` an options argument)
- Test: `__tests__/ulp-search.test.ts` (append two `describe` blocks and extend the import)

**Interfaces:**
- Produces: `export interface ParsedToken`; `export function isIndexNeutralSearch(tokens: ParsedToken[], regexMode?: boolean): boolean`; `export interface BuildULPWhereOptions { caseInsensitiveTokens?: boolean }`; `buildULPWhere(tokens, opts?: BuildULPWhereOptions)`. With `caseInsensitiveTokens: true` a word token is written `hasToken(lower(url), {tok0:String}) OR hasToken(lower(email), ...) OR hasToken(lower(password), ...)`; params and every other token type are unchanged.

- [x] **Step 1: Add the tests**

Apply this diff to `__tests__/ulp-search.test.ts`:

```diff
diff --git a/__tests__/ulp-search.test.ts b/__tests__/ulp-search.test.ts
index 37a75ac..bf57293 100644
--- a/__tests__/ulp-search.test.ts
+++ b/__tests__/ulp-search.test.ts
@@ -8,7 +8,7 @@
  */
 
 import { describe, test, expect } from 'vitest'
-import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from '@/lib/ulp-search'
+import { parseULPQuery, buildULPWhere, buildULPWhereRegex, isIndexNeutralSearch } from '@/lib/ulp-search'
 
 // ─────────────────────────────────────────────────────────────────────────────
 // § 1  parseULPQuery — token type detection
@@ -542,3 +542,73 @@ describe('parseULPQuery + buildULPWhere integration', () => {
     expect(paramValues).not.toContain('Ledger')
   })
 })
+
+// ─────────────────────────────────────────────────────────────────────────────
+// § 9  caseInsensitiveTokens + isIndexNeutralSearch (imported-after filter, step 0)
+// ─────────────────────────────────────────────────────────────────────────────
+
+describe('buildULPWhere — caseInsensitiveTokens (for queries that read a projection, which has no text index)', () => {
+  test('a word token writes hasToken over the lowercased column, in all three columns', () => {
+    const { clause } = buildULPWhere(parseULPQuery('hunter2'), { caseInsensitiveTokens: true })
+    expect(clause).toContain('hasToken(lower(url), {tok0:String})')
+    expect(clause).toContain('hasToken(lower(email), {tok0:String})')
+    expect(clause).toContain('hasToken(lower(password), {tok0:String})')
+    expect(clause).not.toContain('hasToken(url,')
+  })
+
+  test('without the option the clause is exactly what it always was', () => {
+    const { clause } = buildULPWhere(parseULPQuery('hunter2'))
+    expect(clause).toContain('hasToken(url, {tok0:String})')
+    expect(clause).not.toContain('lower(url)')
+    expect(buildULPWhere(parseULPQuery('hunter2'), {}).clause).toBe(clause)
+  })
+
+  test('only the hasToken calls change: params, the url_host / email_domain LIKEs and the clause shape are the same', () => {
+    const plain = buildULPWhere(parseULPQuery('hunter2'))
+    const lowered = buildULPWhere(parseULPQuery('hunter2'), { caseInsensitiveTokens: true })
+    expect(lowered.params).toEqual(plain.params)
+    expect(lowered.clause).toBe(plain.clause.replace(/hasToken\((url|email|password),/g, 'hasToken(lower($1),'))
+    expect(lowered.clause).toContain('url_host LIKE {tlk0:String} OR email_domain LIKE {tlk0:String}')
+  })
+
+  test.each(['ledger.com', 'john@gmail.com', '@gmail.com', 'a+b'])('%s: the other token types are unaffected by the option', q => {
+    expect(buildULPWhere(parseULPQuery(q), { caseInsensitiveTokens: true })).toEqual(buildULPWhere(parseULPQuery(q)))
+  })
+
+  test('a negated word token keeps its NOT', () => {
+    const { clause } = buildULPWhere(parseULPQuery('-hunter2'), { caseInsensitiveTokens: true })
+    expect(clause.startsWith('NOT (hasToken(lower(url), {tok0:String})')).toBe(true)
+  })
+})
+
+describe('isIndexNeutralSearch — which searches mean the same on the table and on a projection', () => {
+  const neutral = (q: string, regex = false) => isIndexNeutralSearch(parseULPQuery(q), regex)
+
+  test('no query at all', () => {
+    expect(neutral('')).toBe(true)
+    expect(neutral('   ')).toBe(true)
+    expect(neutral('', true)).toBe(true)
+  })
+
+  test('domain, full email and @domain terms, alone or together, negated or not', () => {
+    expect(neutral('ledger.com')).toBe(true)
+    expect(neutral('john@gmail.com')).toBe(true)
+    expect(neutral('@gmail.com')).toBe(true)
+    expect(neutral('ledger.com,-@gmail.com,john@gmail.com')).toBe(true)
+  })
+
+  test('a word token is not (hasToken is answered from the text index only on the table)', () => {
+    expect(neutral('hunter2')).toBe(false)
+    expect(neutral('ledger.com,hunter2')).toBe(false)
+  })
+
+  test('a LIKE-fallback token is not', () => {
+    expect(neutral('a+b')).toBe(false)
+    expect(neutral('ledger.com/login')).toBe(false)
+  })
+
+  test('regex mode is not, however the terms look', () => {
+    expect(neutral('^admin@', true)).toBe(false)
+    expect(neutral('ledger.com', true)).toBe(false)
+  })
+})
```

- [x] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/ulp-search.test.ts`
Expected: FAIL. The `isIndexNeutralSearch` tests fail with `isIndexNeutralSearch is not a function`, and the `caseInsensitiveTokens` tests fail on `hasToken(lower(url), ...)` not being in the clause. The pre-existing tests still pass.

- [x] **Step 3: Implement**

Apply this diff to `lib/ulp-search.ts`:

```diff
diff --git a/lib/ulp-search.ts b/lib/ulp-search.ts
index 9e23eaf..54e76b0 100644
--- a/lib/ulp-search.ts
+++ b/lib/ulp-search.ts
@@ -55,7 +55,7 @@
  *                → LIKE '%value%' full scan (unavoidable; rare in practice)
  */
 
-interface ParsedToken {
+export interface ParsedToken {
   negate: boolean
   type: 'token' | 'domain' | 'email_full' | 'email_dom' | 'like'
   value: string
@@ -110,11 +110,33 @@ export function parseULPQuery(raw: string): ParsedToken[] {
     .filter(t => t.value.length > 0)
 }
 
-export function buildULPWhere(tokens: ParsedToken[]): { clause: string; params: Record<string, unknown> } {
+/**
+ * True when the search means the same thing whichever of the table's physical copies a query reads (the base table, or a projection
+ * such as proj_imported_desc). Word tokens do not: `hasToken(col, tok)` on the base table is answered from the text index, whose
+ * preprocessor is `lower(col)` (case-INSENSITIVE), but a projection part has no text index, so there it runs as the plain function on the
+ * stored text (case-SENSITIVE) and silently drops mixed-case matches. LIKE-fallback tokens and regexes are not vouched for either.
+ * Domain, email and @domain terms compare whole columns, and no query at all has nothing to differ on.
+ */
+export function isIndexNeutralSearch(tokens: ParsedToken[], regexMode = false): boolean {
+  if (tokens.length === 0) return true
+  if (regexMode) return false
+  return tokens.every(t => t.type === 'domain' || t.type === 'email_full' || t.type === 'email_dom')
+}
+
+export interface BuildULPWhereOptions {
+  /**
+   * Write word-token predicates over the lowercased column (`hasToken(lower(url), tok)`): the same case-insensitive match the text index's
+   * own preprocessor gives on the base table, for a query that reads a projection (which has no text index). Everything else is unchanged.
+   */
+  caseInsensitiveTokens?: boolean
+}
+
+export function buildULPWhere(tokens: ParsedToken[], opts: BuildULPWhereOptions = {}): { clause: string; params: Record<string, unknown> } {
   if (tokens.length === 0) return { clause: '1=1', params: {} }
 
   const conditions: string[] = []
   const params: Record<string, unknown> = {}
+  const col = (name: string) => (opts.caseInsensitiveTokens ? `lower(${name})` : name)
 
   tokens.forEach((token, i) => {
     let match: string
@@ -164,7 +186,7 @@ export function buildULPWhere(tokens: ParsedToken[]): { clause: string; params:
       const lower = token.value.toLowerCase()
       params[p] = lower
       params[lp] = `%${lower.replace(/_/g, '\\_')}%`
-      match = `(hasToken(url, {${p}:String}) OR hasToken(email, {${p}:String}) OR hasToken(password, {${p}:String}) OR url_host LIKE {${lp}:String} OR email_domain LIKE {${lp}:String})`
+      match = `(hasToken(${col('url')}, {${p}:String}) OR hasToken(${col('email')}, {${p}:String}) OR hasToken(${col('password')}, {${p}:String}) OR url_host LIKE {${lp}:String} OR email_domain LIKE {${lp}:String})`
 
     } else if (token.type === 'domain') {
       // Domain-shaped (e.g. "ledger.com"): matches the canonical site column
```

- [x] **Step 4: Run the tests to see them pass**

Run: `npx vitest run __tests__/ulp-search.test.ts`
Expected: PASS, 79 tests.

- [x] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . lib/ulp-search.ts __tests__/ulp-search.test.ts
git add lib/ulp-search.ts __tests__/ulp-search.test.ts
git commit -F - <<'EOF'
feat(search): a case-insensitive spelling of word tokens and the index-neutral search rule

A projection part has no text index, so hasToken(col, tok) read from one is the plain
case-sensitive function, while on the table the text index (preprocessor lower(col)) answers
it case-insensitively. isIndexNeutralSearch says which searches mean the same on both, and
buildULPWhere(..., { caseInsensitiveTokens: true }) spells word tokens over lower(col), which
is the index's own preprocessor.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: P0 - Newest-first returns the table plan's rows

Newest-first runs a word search as windows over `proj_imported_desc` with `use_skip_indexes = 0`, so `hasToken` runs case-sensitively there and mixed-case matches vanish (measured 2026-10-05 over the newest 15 minutes: 0.2% to 11.8% of the matches of eight common words). Fix: a projected window spells word tokens over `lower(col)`. The imported-after browse view runs on these windows, so this comes first.

**Files:**
- Modify: `app/api/credentials/route.ts` (keep the search clause, build `whereProjection`, use it in projected windows, fix the comment above the windows)
- Modify: `__tests__/credentials-route-newest-first.test.ts` (replace the one test that pinned the old behavior; add two)
- Modify: `__tests__/newest-first-parity.live.test.ts` (append a gated `describe` with two live tests)

**Interfaces:**
- Consumes: `buildULPWhere(tokens, { caseInsensitiveTokens: true })` from Task 1.
- Produces: in the route, `whereProjection` (the route's `where` with the search clause replaced by its lowercased spelling; identical when the search has no word token), used by every window whose `projected` flag is true.

- [x] **Step 1: Update the unit tests**

Apply this diff to `__tests__/credentials-route-newest-first.test.ts`:

```diff
diff --git a/__tests__/credentials-route-newest-first.test.ts b/__tests__/credentials-route-newest-first.test.ts
index 9162754..14fd7d0 100644
--- a/__tests__/credentials-route-newest-first.test.ts
+++ b/__tests__/credentials-route-newest-first.test.ts
@@ -88,18 +88,54 @@ describe('GET /api/credentials — "Newest first" runs as time windows over proj
 
   // Measured on the live table 2026-10-01 for a word token ('ledger'): ClickHouse planned the windows on the BASE table (the text
   // and ngram skip indexes made it look cheaper), reading 202M rows for the newest minute (1.96 s) and 500M for the next 15 minutes
-  // (5.23 s). With the skip indexes off it uses the projection and its key range: 0.19 s and 0.93 s. Skip indexes only ever prune, so
-  // the rows are the same; the plain fallback keeps them on.
-  test('the windows turn skip indexes off, so word-token queries are answered from the projection too; the plain query keeps them', async () => {
+  // (5.23 s). With the skip indexes off it uses the projection and its key range: 0.19 s and 0.93 s. Skip indexes do more than prune,
+  // though: the text index ANSWERS hasToken case-insensitively (its preprocessor is lower(col)), and a projection part has no text
+  // index, so there hasToken runs as the plain case-sensitive function. Measured 2026-10-05 on the newest 2.2M rows for a common word:
+  // 27,285 matches from the table, 27,263 from the projection (22 rows holding the word capitalised or in capitals). So a projected
+  // window spells its word tokens over the lowercased column, which is the index's own preprocessor, and returns the table's rows.
+  test('the windows turn skip indexes off and spell word tokens over the lowercased column; the plain query keeps the text index\'s own answer', async () => {
     windowAnswers = [[row(1)]]
     await get('sort=imported_desc&limit=1&q=ledger&skip_totals=1')
     expect(windowCalls()[0].sql).toContain('use_skip_indexes = 0')
+    expect(windowCalls()[0].sql).toContain('hasToken(lower(url), {tok0:String})')
+    expect(windowCalls()[0].sql).toContain('hasToken(lower(email), {tok0:String})')
+    expect(windowCalls()[0].sql).toContain('hasToken(lower(password), {tok0:String})')
+    expect(windowCalls()[0].sql).not.toContain('hasToken(url,')
+    expect(windowCalls()[0].params).toMatchObject({ tok0: 'ledger' })
     readiness = [{ defined: 0, parts: 1, with_projection: 0 }]
     resetNewestFirstReadyCache()
     calls.length = 0
     legacyRows = [row(1)]
     await get('sort=imported_desc&limit=1&q=ledger&skip_totals=1')
     expect(legacyDataCalls()[0].sql).not.toContain('use_skip_indexes')
+    expect(legacyDataCalls()[0].sql).toContain('hasToken(url, {tok0:String})')
+    expect(legacyDataCalls()[0].sql).not.toContain('lower(url)')
+  })
+
+  test('only the word tokens change spelling: a domain search, a regex and the other filters are the same text in the window and in the plain query', async () => {
+    windowAnswers = [[row(1)]]
+    await get('sort=imported_desc&limit=1&q=binance.com&exclude_noise=1&skip_totals=1')
+    const domainWindow = windowCalls()[0].sql
+    expect(domainWindow).toContain('domain = {dom0:String}')
+    expect(domainWindow).not.toContain('lower(url)')
+    calls.length = 0
+    windowAnswers = [[row(1)]]
+    await get(`sort=imported_desc&limit=1&q=${encodeURIComponent('^admin@')}&regex=1&skip_totals=1`)
+    expect(windowCalls()[0].sql).toContain('match(url, {rp0:String})')
+    expect(windowCalls()[0].sql).not.toContain('lower(url)')
+  })
+
+  test('a window that reaches outside the projection\'s coverage keeps skip indexes on and the plain spelling (the table answers it)', async () => {
+    windowAnswers = [[], [], [], [], [], [row(1)]]
+    await get('sort=imported_desc&limit=1&q=ledger&skip_totals=1')
+    const all = windowCalls()
+    expect(all.length).toBe(6)
+    expect(all[0].sql).toContain('use_skip_indexes = 0')
+    expect(all[0].sql).toContain('hasToken(lower(url), {tok0:String})')
+    const last = all[all.length - 1].sql
+    expect(last).not.toContain('use_skip_indexes')
+    expect(last).toContain('hasToken(url, {tok0:String})')
+    expect(last).not.toContain('lower(url)')
   })
 
   test('the outer select still hands back the stored columns under _c_ aliases, so the cursor is built from stored values', async () => {
```

- [x] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/credentials-route-newest-first.test.ts`
Expected: FAIL in the three tests that mention `hasToken(lower(url), ...)` (the window still uses `hasToken(url, ...)`).

- [x] **Step 3: Add the live tests**

Apply this diff to `__tests__/newest-first-parity.live.test.ts` (it appends a second `describe`; the first one is untouched):

```diff
diff --git a/__tests__/newest-first-parity.live.test.ts b/__tests__/newest-first-parity.live.test.ts
index 4057841..fcfe1d0 100644
--- a/__tests__/newest-first-parity.live.test.ts
+++ b/__tests__/newest-first-parity.live.test.ts
@@ -112,3 +112,111 @@ describe.skipIf(!LIVE)(`newest-first parity on ${TABLE}`, () => {
     }
   }, 30 * 60_000)
 })
+
+// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
+// A word search on the windowed plan must return what the table plan returns, mixed-case matches included.
+//
+// On the table the text index ANSWERS hasToken (its preprocessor is lower(col), so "Foo", "FOO" and "foo" all match "foo"). A projection
+// part has no text index, so hasToken there is the plain case-sensitive function and drops the capitalised forms. The windows read the
+// projection (skip indexes off), so they spell word tokens over the lowercased column instead. Measured 2026-10-05 on the newest 2.2M rows
+// for a common word: 27,285 matches on the table, 27,263 from the projection with the plain spelling. The 13 scenarios above never caught it:
+// their only word search ("ledger") hands off to the plain plan.
+//
+//   NFW_PARITY=1 npx vitest run __tests__/newest-first-parity.live.test.ts -t "case parity"
+//   NFW_CASE_WORDS=login,admin NFW_CASE_WINDOW_SECONDS=3600 ...     other words / a wider window than the newest 15 minutes
+// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
+
+const CASE_WORDS = (process.env.NFW_CASE_WORDS ?? 'login,admin,account,shop,game,bank,user,test').split(',').map(w => w.trim()).filter(Boolean)
+const CASE_WINDOW_SECONDS = Number(process.env.NFW_CASE_WINDOW_SECONDS ?? 900)
+
+describe.skipIf(!LIVE)(`newest-first case parity on ${TABLE}`, () => {
+  /** The oldest second of the window the checks read: CASE_WINDOW_SECONDS back from the newest row (a projection key-range read, cheap). */
+  async function windowFloor(): Promise<number> {
+    const { getClient } = await import('@/lib/clickhouse')
+    const rs = await getClient().query({ query: `SELECT toUnixTimestamp(max(imported_at)) AS n FROM ${TABLE}`, format: 'JSONEachRow' })
+    const [row] = await rs.json<{ n: string }>()
+    return Number(row.n) - CASE_WINDOW_SECONDS
+  }
+
+  async function countIn(where: string, params: Record<string, unknown>, settings: string, floor: number): Promise<number> {
+    const { getClient } = await import('@/lib/clickhouse')
+    const rs = await getClient().query({
+      query: `SELECT count() AS c FROM ${TABLE} WHERE ${where} AND negate(toUnixTimestamp(imported_at)) < -${floor} SETTINGS use_query_cache = 0, ${settings}`,
+      query_params: params,
+      format: 'JSONEachRow',
+    })
+    const [row] = await rs.json<{ c: string }>()
+    return Number(row.c)
+  }
+
+  test('case parity, term set: the lowercased spelling read without skip indexes equals the table plan (the plain spelling does not always)', async () => {
+    const { buildULPWhere, parseULPQuery } = await import('@/lib/ulp-search')
+    const floor = await windowFloor()
+    const rows: Array<{ word: string; table: number; lowered: number; plainSpelling: number }> = []
+    for (const word of CASE_WORDS) {
+      const tokens = parseULPQuery(word)
+      const plain = buildULPWhere(tokens)
+      const lowered = buildULPWhere(tokens, { caseInsensitiveTokens: true })
+      rows.push({
+        word,
+        // base table, skip indexes on: the text index answers hasToken
+        table: await countIn(plain.clause, plain.params, 'optimize_use_projections = 0', floor),
+        // what a projected window now runs: skip indexes off, word tokens over lower(col)
+        lowered: await countIn(lowered.clause, lowered.params, 'use_skip_indexes = 0', floor),
+        // what it ran before: skip indexes off, plain spelling (function semantics, case-sensitive)
+        plainSpelling: await countIn(plain.clause, plain.params, 'use_skip_indexes = 0', floor),
+      })
+    }
+    console.log('\nword | table plan | lowered spelling, skip off | plain spelling, skip off')
+    for (const r of rows) console.log(`${r.word} | ${r.table} | ${r.lowered} | ${r.plainSpelling}`)
+    for (const r of rows) expect(r.lowered, `word "${r.word}": lowercased spelling vs the table plan`).toBe(r.table)
+    expect(
+      rows.some(r => r.plainSpelling < r.table),
+      'no candidate word has a mixed-case match in the window, so this run proves nothing: widen NFW_CASE_WINDOW_SECONDS or set NFW_CASE_WORDS',
+    ).toBe(true)
+  }, 20 * 60_000)
+
+  test('case parity, end to end: a page that starts on a case-only match is identical on the windowed and the plain plan', async () => {
+    const { getClient } = await import('@/lib/clickhouse')
+    const { GET } = await import('@/app/api/credentials/route')
+    const { NextRequest } = await import('next/server')
+    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')
+    const { encodeCursor } = await import('@/lib/cursor-pagination')
+    const floor = await windowFloor()
+
+    // The newest row that matches a word only when lowercased, for the first candidate word that has one.
+    let target: Record<string, string> | undefined
+    let word = ''
+    for (const w of CASE_WORDS) {
+      const raw = `(hasToken(url,'${w}') OR hasToken(email,'${w}') OR hasToken(password,'${w}') OR url_host LIKE '%${w}%' OR email_domain LIKE '%${w}%')`
+      const low = `(hasToken(lower(url),'${w}') OR hasToken(lower(email),'${w}') OR hasToken(lower(password),'${w}') OR url_host LIKE '%${w}%' OR email_domain LIKE '%${w}%')`
+      const rs = await getClient().query({
+        query: `SELECT toString(imported_at) AS imported_at, domain, email, url, password FROM ${TABLE}
+                WHERE negate(toUnixTimestamp(imported_at)) < -${floor} AND ${low} AND NOT ${raw}
+                ORDER BY imported_at DESC, domain ASC, email ASC, url ASC, password ASC LIMIT 1 SETTINGS use_skip_indexes = 0, use_query_cache = 0`,
+        format: 'JSONEachRow',
+      })
+      const [row] = await rs.json<Record<string, string>>()
+      if (row) { target = row; word = w; break }
+    }
+    expect(target, 'no candidate word has a case-only match in the window: widen NFW_CASE_WINDOW_SECONDS or set NFW_CASE_WORDS').toBeDefined()
+
+    // A cursor that puts exactly that row first: same second, same domain / email / url, an empty password sorts before it.
+    const cursor = encodeCursor('imported_desc', { imported_at: target!.imported_at, domain: target!.domain, email: target!.email, url: target!.url, password: '' })
+    const key = (r: Record<string, unknown>) => `${r.imported_at}|${r.url}|${r.email}|${r.password}`
+    const call = async (plain: boolean) => {
+      forcePlain = plain
+      resetNewestFirstReadyCache()
+      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
+      const res = await GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent(word)}&sort=imported_desc&limit=20&skip_totals=1&cursor=${encodeURIComponent(cursor)}`))
+      const body = await res.json()
+      expect(body.success, `${plain ? 'plain' : 'windowed'}: ${JSON.stringify(body).slice(0, 200)}`).toBe(true)
+      return body as { plan: string; results: Array<Record<string, unknown>> }
+    }
+    const windowed = await call(false)
+    const plain = await call(true)
+    expect(windowed.plan, 'the windowed call must really be answered by windows').toBe('windows')
+    expect(plain.results.map(key), `word "${word}"`).toEqual(windowed.results.map(key))
+    expect(plain.results.some(r => key(r) === key(target!)), 'the plain plan returns the case-only row').toBe(true)
+  }, 15 * 60_000)
+})
```

- [x] **Step 4: RED - the end-to-end live test fails on the unfixed route**

ClickHouse must be running (`docker ps`). This is read-only; it takes about two minutes (the plain plan answers a word query with a cursor in ~100 s).

Run: `NFW_PARITY=1 npx vitest run __tests__/newest-first-parity.live.test.ts -t "end to end"`
Expected: FAIL with `word "login": expected [ ...(20) ] to deeply equal [ ...(20) ]`: the windowed page and the plain page differ by a row that only matches case-insensitively. If it PASSES, the route already has the fix (or the table holds no case-only match in its newest 15 minutes: set `NFW_CASE_WINDOW_SECONDS=3600`); do not continue until you understand which.

- [x] **Step 4b: the term-set test (it does not depend on the route, only on Task 1)**

Run: `NFW_PARITY=1 npx vitest run __tests__/newest-first-parity.live.test.ts -t "term set"`
Expected: PASS (about 65 s), printing a table like this one (counts move with the data; the shape must not):

```
word | table plan | lowered spelling, skip off | plain spelling, skip off
login | 2552268 | 2552268 | 2411277
admin | 141713 | 141713 | 133688
account | 1388320 | 1388320 | 1339140
shop | 75034 | 75034 | 74439
game | 250333 | 250333 | 249887
bank | 42874 | 42874 | 42228
user | 190591 | 190591 | 168161
test | 24990 | 24990 | 23792
```

GATE: the second and third columns must be equal for every word, and at least one word must have a smaller fourth column. If any word's lowercased count differs from the table plan's, STOP and report the table to the controller: the lowercased spelling is then not equivalent to the text index for some tokenization case, and the design falls back to "windows never disable skip indexes when the search has a word token", which changes this task and Task 4's tests. Do not weaken the test.

- [x] **Step 5: Implement the fix**

Apply this diff to `app/api/credentials/route.ts`:

```diff
diff --git a/app/api/credentials/route.ts b/app/api/credentials/route.ts
index 7022225..54d9358 100644
--- a/app/api/credentials/route.ts
+++ b/app/api/credentials/route.ts
@@ -165,13 +165,18 @@ export async function GET(request: NextRequest) {
   const params: Record<string, unknown> = { limit }
 
   // Text search: uses hasToken() / bloom-filter indexes — NOT a LIKE full scan
+  let qClause = ''
+  // The same search with its word tokens written over the lowercased column, for the "Newest first" windows that read
+  // proj_imported_desc: a projection has no text index, so hasToken(url, ...) there is a case-SENSITIVE function, while on the
+  // table the text index (preprocessor lower(col)) answers it case-insensitively. See lib/ulp-search.ts (isIndexNeutralSearch).
+  let projectionQClause = ''
   if (q.trim()) {
     const tokens = parseULPQuery(q.trim())
-    const { clause: qClause, params: qParams } = regex
-      ? buildULPWhereRegex(tokens)
-      : buildULPWhere(tokens)
+    const built = regex ? buildULPWhereRegex(tokens) : buildULPWhere(tokens)
+    qClause = built.clause
     conditions.push(`(${qClause})`)
-    Object.assign(params, qParams)
+    Object.assign(params, built.params)
+    projectionQClause = regex ? qClause : buildULPWhere(tokens, { caseInsensitiveTokens: true }).clause
   }
 
   // Raw column: mutations done, all domain/email values are corrected.
@@ -204,6 +209,8 @@ export async function GET(request: NextRequest) {
   const loginTypeExtra = loginTypeWhere(loginTypes)
   const where    = conditions.join(' AND ') + tierExtra + loginTypeExtra
   const whereRaw = conditionsRaw.join(' AND ') + tierExtra + loginTypeExtra
+  // `where` for the windows that read the projection: the same text except for the word tokens' spelling (identical when there is none).
+  const whereProjection = projectionQClause !== qClause ? where.replace(`(${qClause})`, () => `(${projectionQClause})`) : where
 
   // Anything that narrows the result set. Declutter/Unique/sort/limit/cursor do not.
   // With no filter the Unique tally is a plain count() — see dedupeCountExpr.
@@ -355,7 +362,10 @@ export async function GET(request: NextRequest) {
     // term that is not rare). The same filters, ordering, cursor and de-duplication as the plain query; only a predicate on the
     // projection's key is added per window, and skip indexes are switched off for a window that lies inside the projection's
     // coverage: with them on, ClickHouse plans a word-token window on the base table (202M rows for the newest minute, 1.96 s)
-    // instead of the projection (0.19 s); they only prune, so the rows are the same. A window that reaches the older partition
+    // instead of the projection (0.19 s). Skip indexes only prune, BUT the text index also ANSWERS hasToken (case-insensitively,
+    // through its lower() preprocessor), which a projection part cannot: so a projected window spells its word tokens over the
+    // lowercased column (whereProjection) and returns the same rows as the table plan (2026-10-05: 27,285 matches on the table,
+    // 27,263 from the projection with the plain spelling). A window that reaches the older partition
     // (no projection there) keeps them: without them its base-table scan took 28 s instead of 17 s. Not ready (projection not rebuilt yet) or a window error that is not a timeout:
     // the plain query answers, as it always did. A timeout is not retried: the plain query would take at least as long.
     let plan: 'windows' | 'plain' | 'dictionary' = 'plain'
@@ -399,7 +409,7 @@ export async function GET(request: NextRequest) {
          FROM (
            SELECT ${RAW_COLS}${dedupe ? ', content_key_hash' : ''}
            FROM ulp.credentials
-           WHERE ${where}${cursorClause}${windowSql}
+           WHERE ${projected ? whereProjection : where}${cursorClause}${windowSql}
            ORDER BY ${orderBy}
            LIMIT {nfwLimit:UInt32}
          ) AS t
```

- [x] **Step 6: Run the unit tests**

Run: `npx vitest run __tests__/credentials-route-newest-first.test.ts __tests__/credentials-route.test.ts __tests__/credentials-route-totals.test.ts __tests__/credentials-route-dictionary.test.ts __tests__/credentials-route-dedupe-window.test.ts`
Expected: PASS, 79 tests in 5 files.

- [x] **Step 7: GREEN - both live tests pass on the fixed route**

Run: `NFW_PARITY=1 npx vitest run __tests__/newest-first-parity.live.test.ts -t "case parity"`
Expected: PASS, 2 tests (about 65 s and 108 s).

- [x] **Step 8: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . app/api/credentials/route.ts __tests__/credentials-route-newest-first.test.ts __tests__/newest-first-parity.live.test.ts
git add app/api/credentials/route.ts __tests__/credentials-route-newest-first.test.ts __tests__/newest-first-parity.live.test.ts
git commit -F - <<'EOF'
fix(credentials): Newest-first windows spell word tokens over lower(col) so they return the table plan's rows

The windows read proj_imported_desc with skip indexes off. A projection part has no text index,
so hasToken(col, tok) there was the plain case-sensitive function while the table answers it
case-insensitively from the text index (preprocessor lower(col)). For eight common words the
windowed plan returned 0.2% to 11.8% fewer matches over the newest 15 minutes (a mixed-case
"Word", "WORD" never matched). A projected window now writes word tokens over lower(col); the
live term-set test shows it equals the table plan for all eight words, and the end-to-end live
test (a cursor placed on a case-only match, windows against plain) fails on the old route and
passes on this one.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: The imported-range helper

The one parser and SQL builder every route will call. Pure except for the readiness check it delegates to `lib/newest-first.ts`.

**Files:**
- Create: `lib/imported-range.ts`
- Test: `__tests__/imported-range.test.ts`

**Interfaces:**
- Consumes: `IMPORTED_KEY_EXPR`, `getNewestFirstStatus(run)` from `lib/newest-first.ts`.
- Produces (exact names the later tasks import):
  - `interface ImportedRange { lower: number | null; upper: number | null }` (epoch seconds; `lower` exclusive, `upper` inclusive)
  - `parseImportedRange(input: { imported_after?: unknown; imported_before?: unknown; date_from?: unknown; date_to?: unknown }): { ok: true; range: ImportedRange } | { ok: false; error: string }`
  - `importedRangeFromSearchParams(sp: URLSearchParams)` (same result type), `hasImportedRange(range): boolean`
  - `epochToIso(epoch): string`, `importedRangeEcho(range)`, `importedRangeEchoIfSet(range)` (`{}` when no bound), `importedWindowHeaders(range)`, `importedWindowTag(range)`
  - `interface ImportedRangeSql { conditions: string[]; params: Record<string, number> }`; `importedRangePlain(range)`, `importedRangeProjection(range)`, `importedRangeAndSql(sql): string` (` AND a AND b`)
  - `type ImportedRangeShape = 'time' | 'aggregate' | 'other'`; `planImportedRange(range, { shape, indexNeutral, run }): Promise<ImportedRangeSql>`

- [x] **Step 1: Write the tests**

Create `__tests__/imported-range.test.ts` with exactly this content:

```ts
import { describe, test, expect, beforeEach, vi } from 'vitest'
import {
  parseImportedRange, importedRangeFromSearchParams, hasImportedRange,
  epochToIso, importedRangeEcho, importedRangeEchoIfSet, importedWindowHeaders, importedWindowTag,
  importedRangePlain, importedRangeProjection, importedRangeAndSql, planImportedRange,
  type ImportedRange,
} from '@/lib/imported-range'
import { IMPORTED_KEY_EXPR, resetNewestFirstReadyCache } from '@/lib/newest-first'

// 2026-10-05T14:37:00Z
const T = Date.UTC(2026, 9, 5, 14, 37, 0) / 1000

function range(input: Parameters<typeof parseImportedRange>[0]): ImportedRange {
  const parsed = parseImportedRange(input)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.range
}
const error = (input: Parameters<typeof parseImportedRange>[0]) => {
  const parsed = parseImportedRange(input)
  return parsed.ok ? null : parsed.error
}

describe('parseImportedRange — what each form means', () => {
  test('nothing given: open on both sides', () => {
    expect(range({})).toEqual({ lower: null, upper: null })
    expect(range({ imported_after: '', imported_before: '   ', date_from: null, date_to: undefined })).toEqual({ lower: null, upper: null })
  })

  test('a bare date after: the whole UTC day is included, so the exclusive bound is one second before midnight', () => {
    expect(range({ imported_after: '2026-10-05' }).lower).toBe(Date.UTC(2026, 9, 5) / 1000 - 1)
  })

  test('a bare date before: the whole UTC day is included, to 23:59:59', () => {
    expect(range({ imported_before: '2026-10-05' }).upper).toBe(Date.UTC(2026, 9, 5, 23, 59, 59) / 1000)
  })

  test.each([
    ['space separator, no zone (UTC)', '2026-10-05 14:37:00'],
    ['T separator, no zone (UTC)', '2026-10-05T14:37:00'],
    ['Z', '2026-10-05T14:37:00Z'],
    ['lower-case z', '2026-10-05T14:37:00z'],
    ['+00:00', '2026-10-05T14:37:00+00:00'],
    ['fractional seconds are floored', '2026-10-05T14:37:00.999Z'],
    ['surrounding whitespace is trimmed', '  2026-10-05T14:37:00Z  '],
  ])('an exact instant, %s', (_name, text) => {
    expect(range({ imported_after: text }).lower).toBe(T)
    expect(range({ imported_before: text }).upper).toBe(T)
  })

  test.each([
    ['-05:00', '2026-10-05T09:37:00-05:00'],
    ['-0500 (no colon)', '2026-10-05T09:37:00-0500'],
    ['+02:00', '2026-10-05T16:37:00+02:00'],
    ['+05:30', '2026-10-05T20:07:00+05:30'],
  ])('an offset is converted to the same UTC instant, %s', (_name, text) => {
    expect(range({ imported_after: text }).lower).toBe(T)
  })

  test('an offset can move the instant across a UTC date line', () => {
    expect(range({ imported_after: '2026-10-05T23:30:00-05:00' }).lower).toBe(Date.UTC(2026, 9, 6, 4, 30, 0) / 1000)
  })

  test('the legacy date_from / date_to mean exactly what they always did (whole UTC days)', () => {
    expect(range({ date_from: '2026-10-05' }).lower).toBe(Date.UTC(2026, 9, 5) / 1000 - 1)
    expect(range({ date_to: '2026-10-05' }).upper).toBe(Date.UTC(2026, 9, 5, 23, 59, 59) / 1000)
    // imported_at >= '2026-10-05 00:00:00' (the old SQL) is imported_at > midnight - 1 s for a second-precision column
    expect(range({ date_from: '2026-10-05' })).toEqual(range({ imported_after: '2026-10-05' }))
  })

  test('both spellings given: the stricter bound wins on each side', () => {
    expect(range({ imported_after: '2026-10-05T14:37:00Z', date_from: '2026-10-01' }).lower).toBe(T)
    expect(range({ imported_after: '2026-10-01', date_from: '2026-10-05T14:37:00Z' }).lower).toBe(T)
    expect(range({ imported_before: '2026-10-05T14:37:00Z', date_to: '2026-10-09' }).upper).toBe(T)
    expect(range({ imported_before: '2026-10-09', date_to: '2026-10-05T14:37:00Z' }).upper).toBe(T)
  })

  test('a window with the lower bound at or above the upper bound is valid and simply matches nothing', () => {
    // after the last second of the 5th (exclusive) up to the last second of the 5th (inclusive): the two bounds meet, nothing is inside
    const r = range({ imported_after: '2026-10-06', imported_before: '2026-10-05' })
    expect(r.lower).toBeGreaterThanOrEqual(r.upper!)
  })

  test('chained windows tile: (previous before, next before] has no overlap and no gap', () => {
    const first = range({ imported_before: '2026-10-05T14:35:00Z' })
    const next = range({ imported_after: '2026-10-05T14:35:00Z', imported_before: '2026-10-05T15:00:00Z' })
    expect(next.lower).toBe(first.upper)
  })

  test('a leap day is a real date', () => {
    expect(range({ imported_after: '2028-02-29T00:00:00Z' }).lower).toBe(Date.UTC(2028, 1, 29) / 1000)
  })
})

describe('parseImportedRange — rejects, naming the parameter', () => {
  test.each([
    'yesterday', '2026-10-05T14:37', '2026-10-5', '20261005', '2026-13-01', '2026-02-30', '2026-10-05T24:00:00Z',
    '2026-10-05T14:60:00Z', '2026-10-05T14:37:60Z', '2026-10-05T14:37:00+24:00', '2026-10-05T14:37:00+05:60',
    '2026-10-05T14:37:00 UTC', '0001-01-01', "2026-10-05'; DROP TABLE x", '1787959800',
  ])('not an accepted form: %j', text => {
    const message = error({ imported_after: text })
    expect(message).toMatch(/^imported_after must be a date/)
    expect(message).toContain('2026-10-05T14:37:00-05:00')
  })

  test('the parameter name in the message is the one that was wrong', () => {
    expect(error({ imported_before: 'x' })).toMatch(/^imported_before must be/)
    expect(error({ date_from: 'x' })).toMatch(/^date_from must be/)
    expect(error({ date_to: 'x' })).toMatch(/^date_to must be/)
  })

  test('values that are not strings', () => {
    expect(error({ imported_after: 20261005 })).toMatch(/^imported_after must be/)
    expect(error({ imported_after: ['2026-10-05'] })).toMatch(/^imported_after must be/)
    expect(error({ imported_before: {} })).toMatch(/^imported_before must be/)
    expect(error({ imported_before: true })).toMatch(/^imported_before must be/)
  })

  test('outside the range ClickHouse DateTime can hold', () => {
    expect(error({ imported_after: '1969-12-31T23:59:59Z' })).toMatch(/^imported_after is outside the supported range/)
    expect(error({ imported_before: '2106-02-07T06:28:16Z' })).toMatch(/^imported_before is outside the supported range/)
    expect(range({ imported_before: '2106-02-07T06:28:15Z' }).upper).toBe(4_294_967_295)
  })

  test('edge dates that clamp instead of failing', () => {
    expect(range({ imported_after: '1970-01-01' }).lower).toBeNull() // "one second before 1970" is just "everything"
    expect(range({ imported_before: '2106-02-07' }).upper).toBe(4_294_967_295) // the end of that day is past what DateTime holds
  })

  test('the first bad parameter wins even when a later one is fine', () => {
    expect(error({ imported_after: 'nope', imported_before: '2026-10-05' })).toMatch(/^imported_after/)
  })
})

describe('importedRangeFromSearchParams / hasImportedRange', () => {
  test('reads all four names from a query string', () => {
    const sp = new URLSearchParams('imported_after=2026-10-05T14:37:00Z&imported_before=2026-10-06&date_from=2026-10-01&date_to=2026-10-09')
    const parsed = importedRangeFromSearchParams(sp)
    expect(parsed.ok && parsed.range).toEqual({ lower: T, upper: Date.UTC(2026, 9, 6, 23, 59, 59) / 1000 })
  })

  test('an empty query string is an open range', () => {
    const parsed = importedRangeFromSearchParams(new URLSearchParams(''))
    expect(parsed.ok && hasImportedRange(parsed.range)).toBe(false)
    expect(hasImportedRange({ lower: 1, upper: null })).toBe(true)
    expect(hasImportedRange({ lower: null, upper: 1 })).toBe(true)
  })
})

describe('echo, headers and file-name tag', () => {
  test('epochToIso is second-precision UTC', () => {
    expect(epochToIso(T)).toBe('2026-10-05T14:37:00Z')
  })

  test('the echo is the EFFECTIVE window, so a caller can chain it directly', () => {
    expect(importedRangeEcho({ lower: T, upper: null })).toEqual({ imported_after: '2026-10-05T14:37:00Z', imported_before: null })
    expect(importedRangeEcho(range({ imported_before: '2026-10-05' }))).toEqual({ imported_after: null, imported_before: '2026-10-05T23:59:59Z' })
  })

  test('the echo is left out entirely when no bound was given, so existing response shapes do not change', () => {
    expect(importedRangeEchoIfSet({ lower: null, upper: null })).toEqual({})
    expect(importedRangeEchoIfSet({ lower: T, upper: null })).toEqual({ imported_after: '2026-10-05T14:37:00Z', imported_before: null })
  })

  test('headers only for the bounds that are set', () => {
    expect(importedWindowHeaders({ lower: null, upper: null })).toEqual({})
    expect(importedWindowHeaders({ lower: T, upper: T + 3600 })).toEqual({
      'X-Export-Imported-After': '2026-10-05T14:37:00Z',
      'X-Export-Imported-Before': '2026-10-05T15:37:00Z',
    })
  })

  test('the file-name suffix is empty, one-sided or two-sided, with characters that are safe in a file name', () => {
    expect(importedWindowTag({ lower: null, upper: null })).toBe('')
    expect(importedWindowTag({ lower: T, upper: null })).toBe('_after-20261005T143700Z')
    expect(importedWindowTag({ lower: null, upper: T })).toBe('_before-20261005T143700Z')
    expect(importedWindowTag({ lower: T, upper: T + 3600 })).toBe('_after-20261005T143700Z_before-20261005T153700Z')
    expect(importedWindowTag({ lower: T, upper: T + 3600 })).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('the SQL forms', () => {
  test('plain: the column stays bare on the left, bounds are Int64 parameters, nothing for an open side', () => {
    expect(importedRangePlain({ lower: null, upper: null })).toEqual({ conditions: [], params: {} })
    expect(importedRangePlain({ lower: T, upper: null })).toEqual({
      conditions: ['imported_at > toDateTime({impAfter:Int64})'],
      params: { impAfter: T },
    })
    expect(importedRangePlain({ lower: T, upper: T + 60 })).toEqual({
      conditions: ['imported_at > toDateTime({impAfter:Int64})', 'imported_at <= toDateTime({impBefore:Int64})'],
      params: { impAfter: T, impBefore: T + 60 },
    })
  })

  test('projection: the plain bounds plus the same bounds on proj_imported_desc\'s key expression, negated and swapped', () => {
    const sql = importedRangeProjection({ lower: T, upper: T + 60 })
    expect(sql.conditions).toEqual([
      'imported_at > toDateTime({impAfter:Int64})',
      'imported_at <= toDateTime({impBefore:Int64})',
      `${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`,
      `${IMPORTED_KEY_EXPR} >= {impKeyLo:Int64}`,
    ])
    expect(sql.params).toEqual({ impAfter: T, impBefore: T + 60, impKeyHi: -T, impKeyLo: -(T + 60) })
  })

  test('projection with only a lower bound has no upper key predicate', () => {
    const sql = importedRangeProjection({ lower: T, upper: null })
    expect(sql.conditions).toHaveLength(2)
    expect(sql.params).toEqual({ impAfter: T, impKeyHi: -T })
  })

  test('the key predicate is the exact string lib/newest-first.ts pins as the only form that range-prunes the projection', () => {
    expect(importedRangeProjection({ lower: T, upper: null }).conditions[1]).toBe('negate(toUnixTimestamp(imported_at)) < {impKeyHi:Int64}')
  })

  test('a zero bound does not turn into a negative zero', () => {
    const sql = importedRangeProjection({ lower: 0, upper: 0 })
    expect(Object.is(sql.params.impKeyHi, 0)).toBe(true)
    expect(Object.is(sql.params.impKeyLo, 0)).toBe(true)
  })

  test('neither form ever touches skip indexes or projections settings', () => {
    for (const sql of [importedRangePlain({ lower: T, upper: T + 1 }), importedRangeProjection({ lower: T, upper: T + 1 })]) {
      expect(sql.conditions.join(' ')).not.toMatch(/use_skip_indexes|optimize_use_projections|SETTINGS/i)
    }
  })

  test('importedRangeAndSql prefixes every condition with AND for string-built WHEREs', () => {
    expect(importedRangeAndSql({ conditions: [], params: {} })).toBe('')
    expect(importedRangeAndSql(importedRangePlain({ lower: T, upper: T + 1 }))).toBe(
      ' AND imported_at > toDateTime({impAfter:Int64}) AND imported_at <= toDateTime({impBefore:Int64})',
    )
  })
})

describe('planImportedRange — the projection form only where it is safe and useful', () => {
  const READY = [{ defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }]
  const NOT_READY = [{ defined: 0, parts: 1, with_projection: 0, covered_from: 0 }]
  let run: ReturnType<typeof vi.fn>
  const ctx = (over: Partial<Parameters<typeof planImportedRange>[1]> = {}) => ({ shape: 'time' as const, indexNeutral: true, run, ...over })
  const hasKey = (sql: { conditions: string[] }) => sql.conditions.some(c => c.includes(IMPORTED_KEY_EXPR))

  beforeEach(() => {
    resetNewestFirstReadyCache()
    run = vi.fn().mockResolvedValue(READY)
  })

  test('time-ordered, index-neutral, lower bound set, projection ready: the projection form', async () => {
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx()))).toBe(true)
  })

  test('an aggregate (totals, DISTINCT, GROUP BY) gets it too', async () => {
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx({ shape: 'aggregate' })))).toBe(true)
  })

  test('another order (domain, email, password length) or a key-narrowed lookup: plain, and the readiness query is not even run', async () => {
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx({ shape: 'other' })))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  test('a word, LIKE-fallback or regex search is not index-neutral: plain (a projection part has no text index)', async () => {
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx({ indexNeutral: false })))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  test('no lower bound (only an upper one, or none): plain', async () => {
    expect(hasKey(await planImportedRange({ lower: null, upper: T }, ctx()))).toBe(false)
    expect(hasKey(await planImportedRange({ lower: null, upper: null }, ctx()))).toBe(false)
  })

  test('the projection is not ready: plain, never wrong', async () => {
    run.mockResolvedValue(NOT_READY)
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx()))).toBe(false)
  })

  test('the readiness check fails: plain (it fails closed)', async () => {
    run.mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(hasKey(await planImportedRange({ lower: T, upper: null }, ctx()))).toBe(false)
    warn.mockRestore()
  })

  test('both forms select the same rows: the projection form is the plain one plus an equivalent predicate on the key', async () => {
    const plain = importedRangePlain({ lower: T, upper: T + 60 })
    const projection = await planImportedRange({ lower: T, upper: T + 60 }, ctx())
    expect(projection.conditions.slice(0, plain.conditions.length)).toEqual(plain.conditions)
    expect(projection.params).toMatchObject(plain.params)
  })
})
```

- [x] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/imported-range.test.ts`
Expected: FAIL: `Failed to resolve import "@/lib/imported-range"`.

- [x] **Step 3: Implement**

Create `lib/imported-range.ts` with exactly this content:

```ts
/**
 * The "imported after / imported before" bound shared by every surface that returns rows of ulp.credentials, or a list derived from
 * them (design: docs/superpowers/specs/2026-10-05-imported-after-filter-design.md).
 *
 * Semantics. `imported_after` is EXCLUSIVE and `imported_before` INCLUSIVE, both absolute UTC instants to the second, so windows
 * chained as (previous before, next before] never overlap and never leave a gap. A bare date includes its whole UTC day on its own
 * side. The legacy `date_from` / `date_to` are the same parameters under their old names: a bare date means exactly what it always did.
 *
 * SQL. Two forms of the same predicate. The PLAIN form is always correct and keeps the column bare on the left, so partition pruning
 * and the minmax index still apply. The PROJECTION form adds the same bound written on proj_imported_desc's key expression, the only
 * form that range-prunes that projection (see lib/newest-first.ts); it is used only where the measurements allow (planImportedRange).
 * Neither form ever sets `use_skip_indexes`: a projection part has no text index, so reading it turns `hasToken` case-sensitive and
 * silently drops mixed-case matches the table plan returns.
 */
import { IMPORTED_KEY_EXPR, getNewestFirstStatus } from '@/lib/newest-first'

/** Epoch seconds. `lower` is EXCLUSIVE, `upper` is INCLUSIVE; null leaves that side open. */
export interface ImportedRange {
  lower: number | null
  upper: number | null
}

export interface ImportedRangeInput {
  imported_after?: unknown
  imported_before?: unknown
  date_from?: unknown
  date_to?: unknown
}

export type ParsedImportedRange = { ok: true; range: ImportedRange } | { ok: false; error: string }

/** The top of ClickHouse's DateTime: 2106-02-07T06:28:15Z. */
const MAX_EPOCH = 4_294_967_295
const FORMS = 'a date (2026-10-05), a UTC date-time (2026-10-05 14:37:00) or an ISO-8601 time with an offset (2026-10-05T14:37:00-05:00)'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/i

type Side = 'after' | 'before'
interface Instant { epoch: number; bareDate: boolean }

/** Epoch seconds of a UTC calendar time, or null when the fields are not a real date (Feb 30, hour 25, year 0001, ...). */
function utcEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  if (h > 23 || mi > 59 || s > 59) return null
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(ms)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return Math.floor(ms / 1000)
}

function parseInstant(text: string): Instant | null {
  const date = DATE_RE.exec(text)
  if (date) {
    const epoch = utcEpoch(+date[1], +date[2], +date[3], 0, 0, 0)
    return epoch === null ? null : { epoch, bareDate: true }
  }
  const dt = DATE_TIME_RE.exec(text)
  if (!dt) return null
  let epoch = utcEpoch(+dt[1], +dt[2], +dt[3], +dt[4], +dt[5], +dt[6])
  if (epoch === null) return null
  const zone = dt[7]
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '')
    const hh = +digits.slice(0, 2)
    const mm = +digits.slice(2, 4)
    if (hh > 23 || mm > 59) return null
    epoch -= (zone[0] === '-' ? -1 : 1) * (hh * 3600 + mm * 60)
  }
  return { epoch, bareDate: false }
}

type One = { ok: true; bound: number | null } | { ok: false; error: string }

function parseOne(name: string, value: unknown, side: Side): One {
  if (value === undefined || value === null) return { ok: true, bound: null }
  if (typeof value !== 'string') return { ok: false, error: `${name} must be ${FORMS}` }
  const text = value.trim()
  if (text === '') return { ok: true, bound: null }
  const instant = parseInstant(text)
  if (!instant) return { ok: false, error: `${name} must be ${FORMS}` }
  if (instant.epoch < 0 || instant.epoch > MAX_EPOCH) {
    return { ok: false, error: `${name} is outside the supported range (1970-01-01 to 2106-02-07)` }
  }
  // A bare date includes its whole UTC day: "after" starts one second before midnight (the bound is exclusive), "before" ends at 23:59:59.
  if (side === 'after') {
    const lower = instant.bareDate ? instant.epoch - 1 : instant.epoch
    return { ok: true, bound: lower < 0 ? null : lower }
  }
  return { ok: true, bound: Math.min(MAX_EPOCH, instant.bareDate ? instant.epoch + 86_399 : instant.epoch) }
}

/**
 * Reads the four bound parameters (as strings, from a query string or a JSON body) into one range. `date_from` / `date_to` are the old
 * names of the same bounds; when both spellings are given the stricter bound wins. Absent or empty means open on that side. Anything
 * else that is not one of the accepted forms is an error naming the parameter.
 */
export function parseImportedRange(input: ImportedRangeInput): ParsedImportedRange {
  const lowers: number[] = []
  const uppers: number[] = []
  const fields: Array<[string, Side, unknown]> = [
    ['imported_after', 'after', input.imported_after],
    ['date_from', 'after', input.date_from],
    ['imported_before', 'before', input.imported_before],
    ['date_to', 'before', input.date_to],
  ]
  for (const [name, side, value] of fields) {
    const one = parseOne(name, value, side)
    if (!one.ok) return one
    if (one.bound !== null) (side === 'after' ? lowers : uppers).push(one.bound)
  }
  return {
    ok: true,
    range: {
      lower: lowers.length ? Math.max(...lowers) : null,
      upper: uppers.length ? Math.min(...uppers) : null,
    },
  }
}

/** The bound parameters of a GET request. */
export function importedRangeFromSearchParams(sp: URLSearchParams): ParsedImportedRange {
  return parseImportedRange({
    imported_after: sp.get('imported_after'),
    imported_before: sp.get('imported_before'),
    date_from: sp.get('date_from'),
    date_to: sp.get('date_to'),
  })
}

export function hasImportedRange(range: ImportedRange): boolean {
  return range.lower !== null || range.upper !== null
}

// ── Presentation: JSON echo, response headers, file names ─────────────────────────────────────────────────────────────────────────

/** `2026-08-28T23:30:00Z` */
export function epochToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace('.000Z', 'Z')
}

/** The EFFECTIVE window (exclusive lower, inclusive upper) as ISO instants, for a JSON response to echo. */
export function importedRangeEcho(range: ImportedRange): { imported_after: string | null; imported_before: string | null } {
  return {
    imported_after: range.lower === null ? null : epochToIso(range.lower),
    imported_before: range.upper === null ? null : epochToIso(range.upper),
  }
}

/** The echo when a bound was given, else nothing, so a response to a caller that never uses the bound keeps its exact shape. */
export function importedRangeEchoIfSet(range: ImportedRange): { imported_after?: string | null; imported_before?: string | null } {
  return hasImportedRange(range) ? importedRangeEcho(range) : {}
}

/** `X-Export-Imported-After` / `-Before` headers for the bounds that are set. */
export function importedWindowHeaders(range: ImportedRange): Record<string, string> {
  const headers: Record<string, string> = {}
  if (range.lower !== null) headers['X-Export-Imported-After'] = epochToIso(range.lower)
  if (range.upper !== null) headers['X-Export-Imported-Before'] = epochToIso(range.upper)
  return headers
}

/** A file-name suffix that records the window: `_after-20261003T143700Z_before-20261005T143500Z`, or '' when there is none. */
export function importedWindowTag(range: ImportedRange): string {
  const compact = (epoch: number) => epochToIso(epoch).replace(/[-:]/g, '')
  return `${range.lower === null ? '' : `_after-${compact(range.lower)}`}${range.upper === null ? '' : `_before-${compact(range.upper)}`}`
}

// ── SQL ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImportedRangeSql {
  /** Conditions to AND into a WHERE (no leading AND). */
  conditions: string[]
  /** Int64 query parameters the conditions refer to. */
  params: Record<string, number>
}

/** The key is -seconds, so the bounds swap and negate; `-0` would print as "0" but keep it a plain 0. */
const negate = (n: number) => (n === 0 ? 0 : -n)

/** PLAIN predicates. Always correct. The column is bare on the left so partition pruning and idx_mm_imported_at apply. */
export function importedRangePlain(range: ImportedRange): ImportedRangeSql {
  const conditions: string[] = []
  const params: Record<string, number> = {}
  if (range.lower !== null) {
    conditions.push('imported_at > toDateTime({impAfter:Int64})')
    params.impAfter = range.lower
  }
  if (range.upper !== null) {
    conditions.push('imported_at <= toDateTime({impBefore:Int64})')
    params.impBefore = range.upper
  }
  return { conditions, params }
}

/** PLAIN plus the same bound on proj_imported_desc's key expression (ts > lower  <=>  -ts < -lower;  ts <= upper  <=>  -ts >= -upper). */
export function importedRangeProjection(range: ImportedRange): ImportedRangeSql {
  const sql = importedRangePlain(range)
  if (range.lower !== null) {
    sql.conditions.push(`${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`)
    sql.params.impKeyHi = negate(range.lower)
  }
  if (range.upper !== null) {
    sql.conditions.push(`${IMPORTED_KEY_EXPR} >= {impKeyLo:Int64}`)
    sql.params.impKeyLo = negate(range.upper)
  }
  return sql
}

/** ` AND a AND b` for the routes that build their WHERE by string concatenation. */
export function importedRangeAndSql(sql: ImportedRangeSql): string {
  return sql.conditions.map(c => ` AND ${c}`).join('')
}

export type ImportedRangeShape =
  /** ORDER BY imported_at (either direction) with a LIMIT: the shape proj_imported_desc serves. */
  | 'time'
  /** count() / uniq() / DISTINCT / GROUP BY over the range: order does not matter, only which rows are read. */
  | 'aggregate'
  /** Any other order (domain, email, password length) or a lookup that a key already narrows: the projection is not chosen. */
  | 'other'

export interface ImportedRangePlanContext {
  shape: ImportedRangeShape
  /** isIndexNeutralSearch(...) of the search; false for word, LIKE-fallback and regex searches. */
  indexNeutral: boolean
  /** Runs a read-only metadata query (the readiness check); routes pass `sql => executeQuery(sql)`. */
  run: (sql: string) => Promise<Array<Record<string, unknown>>>
}

/**
 * Chooses the form. The projection form only when ALL hold: a lower bound is set (it is what prunes), the shape is `time` or
 * `aggregate`, the search is index-neutral (its predicates mean the same on a projection part, which has no text index), and
 * Newest-first's readiness check says the projection is current (it fails closed). Everything else gets the plain form.
 */
export async function planImportedRange(range: ImportedRange, ctx: ImportedRangePlanContext): Promise<ImportedRangeSql> {
  if (range.lower === null || !ctx.indexNeutral || ctx.shape === 'other') return importedRangePlain(range)
  const status = await getNewestFirstStatus(ctx.run)
  return status.ready ? importedRangeProjection(range) : importedRangePlain(range)
}
```

- [x] **Step 4: Run the tests to see them pass**

Run: `npx vitest run __tests__/imported-range.test.ts`
Expected: PASS, 62 tests.

- [x] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . lib/imported-range.ts __tests__/imported-range.test.ts
git add lib/imported-range.ts __tests__/imported-range.test.ts
git commit -F - <<'EOF'
feat(imported-range): one parser and SQL builder for an imported-after / imported-before bound

imported_after is exclusive and imported_before inclusive, both UTC instants to the second, so
chained windows tile; a bare date includes its whole UTC day; date_from / date_to are the same
bounds under their old names. The SQL comes in a plain form (always correct, the column bare on
the left) and a projection form that repeats the bound on proj_imported_desc's key expression,
used only for a time-ordered or aggregate query over an index-neutral search while the
projection is ready. It never sets use_skip_indexes.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: The browse route and Newest-first take the bound

`GET /api/credentials` reads `imported_after` / `imported_before` (and the old names), plans the bound separately for the rows and for the totals, and bounds the Newest-first windows with epoch seconds instead of date strings.

**Files:**
- Modify: `lib/newest-first.ts` (`readAnchors` and `runNewestFirst` take `floorTs` / `ceilTs` in epoch seconds instead of `dateFrom` / `dateTo` strings)
- Modify: `app/api/credentials/route.ts`
- Modify: `__tests__/newest-first.test.ts` (three tests move to the new arguments)
- Create: `__tests__/credentials-route-imported-range.test.ts`

**Interfaces:**
- Consumes: from Task 3 `importedRangeFromSearchParams`, `importedRangePlain`, `hasImportedRange`, `planImportedRange`; from Task 1 `isIndexNeutralSearch`.
- Produces: `readAnchors(run, { cursorImportedAt?, floorTs?, ceilTs? })` where `floorTs` is the oldest second wanted and `ceilTs` the newest, both INCLUSIVE and passed straight through (no SQL for them); `runNewestFirst({ ..., floorTs?, ceilTs? })`. The route passes `floorTs = lower + 1` and `ceilTs = upper`.

- [x] **Step 1: Move the Newest-first tests to the new arguments**

Apply this diff to `__tests__/newest-first.test.ts`:

```diff
diff --git a/__tests__/newest-first.test.ts b/__tests__/newest-first.test.ts
index 50a9a76..6cbd5c4 100644
--- a/__tests__/newest-first.test.ts
+++ b/__tests__/newest-first.test.ts
@@ -272,16 +272,18 @@ describe('readAnchors', () => {
     expect(params).toEqual({ nfwCursor: '2026-08-16 20:40:54' })
   })
 
-  test('date_from becomes a floor and date_to a ceiling; the upper bound is the smaller of the ceiling and the cursor', async () => {
-    const run = vi.fn(async () => [{ newest: 100, oldest: 1, cursor_ts: 60, date_from_ts: 20, date_to_ts: 80 }])
-    const a = await readAnchors(run, { cursorImportedAt: 'c', dateFrom: '2026-08-01 00:00:00', dateTo: '2026-08-20 23:59:59' })
+  test('the floor and the ceiling arrive as epoch seconds and cost no SQL; the upper bound is the smaller of the ceiling and the cursor', async () => {
+    const run = vi.fn(async () => [{ newest: 100, oldest: 1, cursor_ts: 60 }])
+    const a = await readAnchors(run, { cursorImportedAt: 'c', floorTs: 20, ceilTs: 80 })
     expect(a).toEqual({ newest: 100, oldest: 1, upperTs: 60, floorTs: 20 })
     const [sql, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
-    expect(sql).toMatch(/\{nfwDateFrom:String\}/)
-    expect(sql).toMatch(/\{nfwDateTo:String\}/)
-    expect(params).toEqual({ nfwCursor: 'c', nfwDateFrom: '2026-08-01 00:00:00', nfwDateTo: '2026-08-20 23:59:59' })
-    const b = await readAnchors(async () => [{ newest: 100, oldest: 1, date_to_ts: 80 }], { dateTo: 'x' })
+    expect(sql).not.toMatch(/nfwDate/)
+    expect(params).toEqual({ nfwCursor: 'c' })
+    const b = await readAnchors(async () => [{ newest: 100, oldest: 1 }], { ceilTs: 80 })
     expect(b!.upperTs).toBe(80)
+    expect(b!.floorTs).toBeNull()
+    const c = await readAnchors(async () => [{ newest: 100, oldest: 1 }], { floorTs: 20, ceilTs: Number.NaN })
+    expect(c).toEqual({ newest: 100, oldest: 1, upperTs: null, floorTs: 20 })
   })
 
   test('numbers that come back as strings are converted', async () => {
@@ -407,12 +409,9 @@ describe('runNewestFirst', () => {
     expect(first.params).toMatchObject({ nfwKeyLo: -1_787_000_000, nfwKeyHi: -(1_787_000_000 - 60) })
   })
 
-  test('a date range bounds the windows: nothing newer than date_to, nothing older than date_from is ever scanned', async () => {
-    const { run, log } = fakeRun({
-      anchors: { ...ANCHORS, date_from_ts: 1_786_000_000, date_to_ts: 1_787_000_000 },
-      windowAnswers: [[], [], [], [], [], []],
-    })
-    await runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 5, dateFrom: '2026-08-01 00:00:00', dateTo: '2026-08-20 23:59:59' })
+  test('a floor and a ceiling bound the windows: nothing newer than the ceiling, nothing older than the floor is ever scanned', async () => {
+    const { run, log } = fakeRun({ windowAnswers: [[], [], [], [], [], []] })
+    await runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 5, floorTs: 1_786_000_000, ceilTs: 1_787_000_000 })
     const windowCalls = log.filter(c => c.sql.startsWith('SELECT 1'))
     expect(windowCalls[0].params.nfwKeyLo).toBe(-1_787_000_000)
     const last = windowCalls[windowCalls.length - 1]
@@ -435,8 +434,8 @@ describe('runNewestFirst', () => {
   })
 
   test('a range that lies wholly older than the projection\'s coverage is not tried at all: null, and no window query runs', async () => {
-    const { run, log } = fakeRun({ anchors: { ...ANCHORS, date_to_ts: 1_784_000_000 } })
-    const out = await runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 5, dateTo: '2026-07-10 23:59:59' })
+    const { run, log } = fakeRun()
+    const out = await runNewestFirst({ run, buildWindowSql: build, baseParams: {}, want: 5, ceilTs: 1_784_000_000 })
     expect(out).toBeNull()
     expect(log.filter(c => c.sql.startsWith('SELECT 1'))).toHaveLength(0)
   })
```

- [x] **Step 2: Write the browse-route tests**

Create `__tests__/credentials-route-imported-range.test.ts` with exactly this content:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
const READY = { defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }
let readiness: Array<Record<string, unknown>> = [READY]
let windowAnswers: Array<Array<Record<string, unknown>>> = []

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/system\.projections/.test(sql)) return readiness
    if (/toUnixTimestamp\(max\(imported_at\)\)/.test(sql)) return [{ newest: 1_787_960_054, oldest: 1_782_000_000 }]
    if (/AS raw_total/.test(sql)) return [{ total: '9', raw_total: '9' }]
    if (sql.includes('{nfwLimit:UInt32}')) return windowAnswers.shift() ?? []
    return []
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { resetNewestFirstReadyCache, IMPORTED_KEY_EXPR } from '@/lib/newest-first'

// The data runs 1_782_000_000 .. 1_787_960_054 (2026-08-28T23:34:14Z); the projection covers it from 1_786_000_000.
const AFTER = '2026-08-28T23:30:00Z'
const AFTER_EPOCH = 1_787_959_800
const BEFORE = '2026-08-28T23:33:00Z'
const BEFORE_EPOCH = 1_787_959_980
const PLAIN_AFTER = 'imported_at > toDateTime({impAfter:Int64})'
const PLAIN_BEFORE = 'imported_at <= toDateTime({impBefore:Int64})'
const KEY_HI = `${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`

const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.com`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.com`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4,
})
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
const windowCalls = () => calls.filter(c => c.sql.includes('{nfwLimit:UInt32}'))
const plainRowCalls = () => calls.filter(c => /\) AS t\s/.test(c.sql) && !c.sql.includes('{nfwLimit:UInt32}'))
const totalsCalls = () => calls.filter(c => /AS raw_total/.test(c.sql))
const metaCalls = () => calls.filter(c => /system\.projections/.test(c.sql))

beforeEach(() => {
  calls.length = 0
  readiness = [READY]
  windowAnswers = []
  resetNewestFirstReadyCache()
})

describe('GET /api/credentials — imported_after / imported_before', () => {
  test('an invalid bound is a 400 that names the parameter, and nothing reaches ClickHouse', async () => {
    for (const qs of ['imported_after=yesterday', 'imported_before=2026-02-30', 'date_from=nope']) {
      const res = await get(qs)
      expect(res.status, qs).toBe(400)
      expect((await res.json()).error).toMatch(/^(imported_after|imported_before|date_from) must be/)
    }
    expect(calls).toHaveLength(0)
  })

  test('Newest first, a domain search, a lower bound: both forms of the bound in every window, and the windows stop at the floor', async () => {
    windowAnswers = [[], [row(1)]]
    const body = await (await get(`sort=imported_desc&limit=1&skip_totals=1&q=binance.com&imported_after=${AFTER}`)).json()
    expect(body.success).toBe(true)
    expect(body.plan).toBe('windows')
    const [first, second] = windowCalls()
    for (const w of [first, second]) {
      expect(w.sql).toContain(PLAIN_AFTER)
      expect(w.sql).toContain(KEY_HI)
      expect(w.params).toMatchObject({ impAfter: AFTER_EPOCH, impKeyHi: -AFTER_EPOCH })
    }
    // the last window closes at the bound (exclusive), so nothing older is ever read
    expect(second.params.nfwKeyHi).toBe(-AFTER_EPOCH)
  })

  test('a closed window: the ceiling is the top of the first window, and the upper bound is in the SQL', async () => {
    windowAnswers = [[row(1)]]
    await get(`sort=imported_desc&limit=1&skip_totals=1&q=binance.com&imported_after=${AFTER}&imported_before=${BEFORE}`)
    const w = windowCalls()[0]
    expect(w.sql).toContain(PLAIN_BEFORE)
    expect(w.sql).toContain(`${IMPORTED_KEY_EXPR} >= {impKeyLo:Int64}`)
    expect(w.params).toMatchObject({ impBefore: BEFORE_EPOCH, impKeyLo: -BEFORE_EPOCH })
    expect(w.params.nfwKeyLo).toBe(-BEFORE_EPOCH)
  })

  test('a word search: the rows keep the plain bound only; the window still reads the projection, with the word tokens over lower(col)', async () => {
    windowAnswers = [[row(1)]]
    await get(`sort=imported_desc&limit=1&skip_totals=1&q=hunter2&imported_after=${AFTER}`)
    const w = windowCalls()[0]
    expect(w.sql).toContain(PLAIN_AFTER)
    expect(w.sql).not.toContain('{impKeyHi:Int64}')
    expect(w.sql).toContain('hasToken(lower(url), {tok0:String})')
    expect(w.sql).toContain('use_skip_indexes = 0')
    expect(w.sql).not.toContain('use_skip_indexes = 0, use_skip_indexes') // set once
  })

  test('a sort that is not by time gets the plain bound, and asks nothing about the projection', async () => {
    await get(`sort=domain_asc&limit=5&skip_totals=1&q=binance.com&imported_after=${AFTER}`)
    expect(plainRowCalls()[0].sql).toContain(PLAIN_AFTER)
    expect(plainRowCalls()[0].sql).not.toContain(IMPORTED_KEY_EXPR)
    expect(metaCalls()).toHaveLength(0)
  })

  test('imported_asc is time-ordered: a domain search gets the projection form on the plain query', async () => {
    await get(`sort=imported_asc&limit=5&skip_totals=1&q=binance.com&imported_after=${AFTER}`)
    expect(plainRowCalls()[0].sql).toContain(KEY_HI)
  })

  test('the projection is not ready: plain bound only, and the plain query answers', async () => {
    readiness = [{ defined: 0, parts: 1, with_projection: 0 }]
    await get(`sort=imported_asc&limit=5&skip_totals=1&q=binance.com&imported_after=${AFTER}`)
    expect(plainRowCalls()[0].sql).toContain(PLAIN_AFTER)
    expect(plainRowCalls()[0].sql).not.toContain(IMPORTED_KEY_EXPR)
  })
})

describe('GET /api/credentials — the totals', () => {
  test('a domain search: the aggregate gets the projection form', async () => {
    await get(`totals_only=1&q=binance.com&imported_after=${AFTER}`)
    const sql = totalsCalls()[0].sql
    expect(sql).toContain(PLAIN_AFTER)
    expect(sql).toContain(KEY_HI)
    // projections stay available to the planner exactly when the bound can prune them
    expect(sql).not.toContain('optimize_use_projections')
  })

  test('a word search or a regex: plain bound only', async () => {
    await get(`totals_only=1&q=hunter2&imported_after=${AFTER}`)
    expect(totalsCalls()[0].sql).toContain(PLAIN_AFTER)
    expect(totalsCalls()[0].sql).not.toContain(IMPORTED_KEY_EXPR)
    calls.length = 0
    await get(`totals_only=1&q=${encodeURIComponent('^admin@')}&regex=1&imported_after=${AFTER}`)
    expect(totalsCalls()[0].sql).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('no query at all: the projection form too', async () => {
    await get(`totals_only=1&imported_after=${AFTER}`)
    expect(totalsCalls()[0].sql).toContain(KEY_HI)
  })

  test('with no bound the totals are what they were: no bound SQL, projections off, and no readiness query', async () => {
    await get('totals_only=1&q=binance.com')
    expect(totalsCalls()[0].sql).not.toContain('impAfter')
    expect(totalsCalls()[0].sql).toContain('optimize_use_projections = 0')
    expect(metaCalls()).toHaveLength(0)
  })

  test('hasUserFilter: a bound alone counts as a filter (the Unique tally is uniq(), not the unfiltered count())', async () => {
    await get(`totals_only=1&dedupe=1&imported_after=${AFTER}`)
    expect(totalsCalls()[0].sql).toContain('uniq(content_key_hash)')
  })

  test('only the queries a request runs are planned: skip_totals asks nothing for the totals, totals_only nothing for the rows', async () => {
    await get(`sort=domain_asc&skip_totals=1&q=binance.com&imported_after=${AFTER}`)
    expect(metaCalls()).toHaveLength(0)
    calls.length = 0
    await get(`sort=imported_asc&totals_only=1&q=binance.com&imported_after=${AFTER}`)
    expect(plainRowCalls()).toHaveLength(0)
    expect(metaCalls()).toHaveLength(1)
  })
})

describe('GET /api/credentials — the old date_from / date_to', () => {
  test('still work, as whole UTC days, on the rows and on the totals', async () => {
    await get('sort=domain_asc&limit=5&q=binance.com&date_from=2026-08-28&date_to=2026-08-28')
    const dayStart = Date.UTC(2026, 7, 28) / 1000
    for (const c of [plainRowCalls()[0], totalsCalls()[0]]) {
      expect(c.sql).toContain(PLAIN_AFTER)
      expect(c.sql).toContain(PLAIN_BEFORE)
      expect(c.params).toMatchObject({ impAfter: dayStart - 1, impBefore: dayStart + 86_399 })
    }
    expect(calls.some(c => c.sql.includes('{dateFrom:DateTime}'))).toBe(false)
  })

  test('with both spellings the stricter bound wins', async () => {
    await get(`sort=domain_asc&limit=5&skip_totals=1&date_from=2026-08-01&imported_after=${AFTER}`)
    expect(plainRowCalls()[0].params.impAfter).toBe(AFTER_EPOCH)
  })

  test('a Newest-first request with date_from still bounds its windows at the day start', async () => {
    // the data's last 4 windows (60 s, 16 min, 4 h, then the rest) reach the day start; the last one closes there
    windowAnswers = [[], [], [], [row(1)]]
    await get('sort=imported_desc&limit=1&skip_totals=1&date_from=2026-08-28')
    const dayStart = Date.UTC(2026, 7, 28) / 1000
    expect(windowCalls()).toHaveLength(4)
    expect(windowCalls().at(-1)!.params.nfwKeyHi).toBe(-(dayStart - 1))
  })
})

describe('GET /api/credentials — no bound is a no-op', () => {
  test('no bound SQL, no bound parameters, and the same windows as before', async () => {
    windowAnswers = [[row(1)]]
    await get('sort=imported_desc&limit=1&skip_totals=1&q=binance.com')
    const sql = windowCalls()[0].sql
    expect(sql).not.toContain('impAfter')
    expect(sql).not.toContain('{impKeyHi:Int64}')
    expect(windowCalls()[0].params).not.toHaveProperty('impAfter')
  })
})
```

- [x] **Step 3: Run them to see them fail**

Run: `npx vitest run __tests__/newest-first.test.ts __tests__/credentials-route-imported-range.test.ts`
Expected: FAIL. The Newest-first tests that now pass `floorTs` / `ceilTs` fail (the old code ignores them), and most of the route tests fail (no 400, no `imported_at > toDateTime(...)` in the SQL).

- [x] **Step 4: Implement the library change**

Apply this diff to `lib/newest-first.ts`:

```diff
diff --git a/lib/newest-first.ts b/lib/newest-first.ts
index f8566d7..55af473 100644
--- a/lib/newest-first.ts
+++ b/lib/newest-first.ts
@@ -54,8 +54,8 @@ type Row = Record<string, unknown>
 
 /**
  * The windows to try, newest first. `upTo` is where the range tops out when something bounds it -- the cursor's second when
- * paging, a date_to ceiling -- and is INCLUSIVE (rows of the same second that sort after the cursor row are still wanted; the
- * route's own keyset clause removes the rest); null leaves the top open. `floor` is a date_from: no row older than it can match,
+ * paging, an imported-range ceiling -- and is INCLUSIVE (rows of the same second that sort after the cursor row are still wanted; the
+ * route's own keyset clause removes the rest); null leaves the top open. `floor` is the imported-range floor (INCLUSIVE): no row older than it can match,
  * so the last window closes just above it instead of staying open. Without a floor the last window is open below, so nothing
  * older than `oldest` is ever skipped.
  */
@@ -152,14 +152,15 @@ type Run = (sql: string, params: Record<string, unknown>) => Promise<Array<Recor
 
 /**
  * Where the data starts and ends, in epoch seconds, from the partitions' min/max (answered from metadata, milliseconds), plus
- * the cursor's second when paging and the date range's ends. Converting them in ClickHouse keeps the table's own time zone out
- * of this file, and parses the date strings exactly as the route's own `imported_at >= {dateFrom:DateTime}` does.
- * `upperTs` is the smaller of the cursor and the date_to ceiling; `floorTs` is date_from. null when there is nothing usable
+ * the cursor's second when paging. Converting the cursor in ClickHouse keeps the table's own time zone out of this file, and parses
+ * it exactly as the route's own `imported_at < {c_ia:DateTime}` does. The imported-range bound arrives already as epoch seconds
+ * (lib/imported-range.ts): `ceilTs` is the newest second wanted and `floorTs` the oldest, both INCLUSIVE.
+ * `upperTs` is the smaller of the cursor and the ceiling; `floorTs` is passed through. null when there is nothing usable
  * (empty table, junk answer): the caller runs the plain query.
  */
 export async function readAnchors(
   run: Run,
-  opts: { cursorImportedAt?: string | null; dateFrom?: string | null; dateTo?: string | null } = {},
+  opts: { cursorImportedAt?: string | null; floorTs?: number | null; ceilTs?: number | null } = {},
 ): Promise<{ newest: number; oldest: number; upperTs: number | null; floorTs: number | null } | null> {
   const given = (v: string | null | undefined): v is string => typeof v === 'string' && v !== ''
   const params: Record<string, unknown> = {}
@@ -168,14 +169,6 @@ export async function readAnchors(
     sql += `, toUnixTimestamp(toDateTime({nfwCursor:String})) AS cursor_ts`
     params.nfwCursor = opts.cursorImportedAt
   }
-  if (given(opts.dateFrom)) {
-    sql += `, toUnixTimestamp(toDateTime({nfwDateFrom:String})) AS date_from_ts`
-    params.nfwDateFrom = opts.dateFrom
-  }
-  if (given(opts.dateTo)) {
-    sql += `, toUnixTimestamp(toDateTime({nfwDateTo:String})) AS date_to_ts`
-    params.nfwDateTo = opts.dateTo
-  }
   sql += ` FROM ulp.credentials`
 
   const [row] = await run(sql, params)
@@ -185,12 +178,11 @@ export async function readAnchors(
   if (newest === null || oldest === null) return null
 
   const cursorTs = given(opts.cursorImportedAt) ? num(row?.cursor_ts) : null
-  const dateToTs = given(opts.dateTo) ? num(row?.date_to_ts) : null
-  const floorTs = given(opts.dateFrom) ? num(row?.date_from_ts) : null
-  if ((given(opts.cursorImportedAt) && cursorTs === null) || (given(opts.dateTo) && dateToTs === null) || (given(opts.dateFrom) && floorTs === null)) return null
+  if (given(opts.cursorImportedAt) && cursorTs === null) return null
+  const bound = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
 
-  const uppers = [cursorTs, dateToTs].filter((v): v is number => v !== null)
-  return { newest, oldest, upperTs: uppers.length ? Math.min(...uppers) : null, floorTs }
+  const uppers = [cursorTs, bound(opts.ceilTs)].filter((v): v is number => v !== null)
+  return { newest, oldest, upperTs: uppers.length ? Math.min(...uppers) : null, floorTs: bound(opts.floorTs) }
 }
 
 /** What a route needs to run its query newest-first: everything else (readiness, anchors, windows, the time budget) is here. */
@@ -204,9 +196,9 @@ export async function runNewestFirst(a: {
   want: number
   /** The cursor's imported_at when paging. */
   cursorImportedAt?: string | null
-  /** The route's date_from / date_to as it passes them to ClickHouse ("YYYY-MM-DD HH:MM:SS"); they bound the windows. */
-  dateFrom?: string | null
-  dateTo?: string | null
+  /** The imported-range bound as epoch seconds (lib/imported-range.ts): the oldest and the newest second wanted, both INCLUSIVE. They bound the windows. */
+  floorTs?: number | null
+  ceilTs?: number | null
   /** Hard limit for every window together (their max_execution_time); default 280 s, like the plain query's 300 s. */
   deadlineMs?: number
   /** Soft limit: when the windows are predicted to run past it, give up and return null (default HANDOFF_MS). */
@@ -217,10 +209,10 @@ export async function runNewestFirst(a: {
   const status = await getNewestFirstStatus(sql => a.run(sql))
   if (!status.ready) return null
   const anchors = await readAnchors((sql, params) => a.run(sql, params), {
-    cursorImportedAt: a.cursorImportedAt, dateFrom: a.dateFrom, dateTo: a.dateTo,
+    cursorImportedAt: a.cursorImportedAt, floorTs: a.floorTs, ceilTs: a.ceilTs,
   })
   if (!anchors) return null
-  // A range that lies wholly older than the projection (a date_to in July, say) is the plain query's: every window would run on the
+  // A range that lies wholly older than the projection (a ceiling in July, say) is the plain query's: every window would run on the
   // base table, with nothing to prune them but the minmax index, and then hand off anyway.
   if (anchors.upperTs !== null && status.coveredFrom !== null && anchors.upperTs < status.coveredFrom) return null
 
```

- [x] **Step 5: Implement the route change**

Apply this diff to `app/api/credentials/route.ts` (it applies on top of Task 2's change):

```diff
--- a/app/api/credentials/route.ts
+++ b/app/api/credentials/route.ts
@@ -1,7 +1,8 @@
 import { type NextRequest, NextResponse } from "next/server"
 import { executeQuery } from "@/lib/clickhouse"
 import { validateRequest } from "@/lib/auth"
-import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
+import { parseULPQuery, buildULPWhere, buildULPWhereRegex, isIndexNeutralSearch } from "@/lib/ulp-search"
+import { importedRangeFromSearchParams, hasImportedRange, importedRangePlain, planImportedRange } from "@/lib/imported-range"
 import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
 import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
 import { NORM_COLS, NORM_COLS_SETTING } from "@/lib/ulp-normalize"
@@ -101,8 +102,10 @@
  *   tier_exclude  string    comma-separated tiers to exclude
  *   pw_len_min    number    minimum password length
  *   pw_len_max    number    maximum password length
- *   date_from     string    ISO date e.g. 2024-01-01
- *   date_to       string    ISO date e.g. 2024-12-31
+ *   imported_after   string  only rows imported AFTER this instant (exclusive; UTC): a date (2026-10-05, the whole day), a date-time
+ *                            (2026-10-05 14:37:00) or ISO-8601 with an offset (2026-10-05T14:37:00-05:00); anything else is a 400
+ *   imported_before  string  only rows imported up to and INCLUDING this instant; same forms (lib/imported-range.ts)
+ *   date_from, date_to       the old names of the two above; a bare date means the whole UTC day
  *   exclude_noise '1'       hide low-signal rows: IP-host / :port / .php / localhost URLs
  *   dedupe        '1'       collapse exact (url,email,password) duplicates (one row each)
  *   skip_totals   '1'       data query only: total / raw_total come back null
@@ -136,8 +139,9 @@
   const isCorporate = sp.get('is_corporate')  || ''
   const pwLenMin    = sp.get('pw_len_min')  ? parseInt(sp.get('pw_len_min')!) : null
   const pwLenMax    = sp.get('pw_len_max')  ? parseInt(sp.get('pw_len_max')!) : null
-  const dateFrom    = sp.get('date_from')     || ''
-  const dateTo      = sp.get('date_to')       || ''
+  const parsedRange = importedRangeFromSearchParams(sp)
+  if (!parsedRange.ok) return NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 })
+  const importedRange = parsedRange.range
   const tierInclude = sp.get('tier_include')  || ''
   const tierExclude = sp.get('tier_exclude')  || ''
   // Declutter: hide low-signal rows (IP-host / :port / .php / localhost URLs).
@@ -170,13 +174,13 @@
   // proj_imported_desc: a projection has no text index, so hasToken(url, ...) there is a case-SENSITIVE function, while on the
   // table the text index (preprocessor lower(col)) answers it case-insensitively. See lib/ulp-search.ts (isIndexNeutralSearch).
   let projectionQClause = ''
+  const searchTokens = q.trim() ? parseULPQuery(q.trim()) : []
   if (q.trim()) {
-    const tokens = parseULPQuery(q.trim())
-    const built = regex ? buildULPWhereRegex(tokens) : buildULPWhere(tokens)
+    const built = regex ? buildULPWhereRegex(searchTokens) : buildULPWhere(searchTokens)
     qClause = built.clause
     conditions.push(`(${qClause})`)
     Object.assign(params, built.params)
-    projectionQClause = regex ? qClause : buildULPWhere(tokens, { caseInsensitiveTokens: true }).clause
+    projectionQClause = regex ? qClause : buildULPWhere(searchTokens, { caseInsensitiveTokens: true }).clause
   }
 
   // Raw column: mutations done, all domain/email values are corrected.
@@ -190,15 +194,38 @@
   if (isCorporate === '1') conditions.push('is_corporate_email = 1')
   if (pwLenMin !== null) { conditions.push('password_length >= {pwLenMin:UInt8}'); params.pwLenMin = pwLenMin }
   if (pwLenMax !== null) { conditions.push('password_length <= {pwLenMax:UInt8}'); params.pwLenMax = pwLenMax }
-  if (dateFrom) { conditions.push('imported_at >= {dateFrom:DateTime}'); params.dateFrom = `${dateFrom} 00:00:00` }
-  if (dateTo)   { conditions.push('imported_at <= {dateTo:DateTime}');   params.dateTo   = `${dateTo} 23:59:59` }
   if (pwMasks.length) {
     conditions.push(`password_mask IN (${pwMasks.map(m => `'${m}'`).join(',')})`)
   }
+  // Which queries this request runs.
+  // The total only changes when the result SET changes (new filters/sort), not
+  // when paging through it. The first page is always cursor-less, so the totals run
+  // there; on deeper cursor pages we skip them entirely (total = null) and the client
+  // carries the page-1 total forward. At billions of rows a filtered search can
+  // match tens of millions, and counting them has no LIMIT -- re-counting all of them on
+  // every page turn is the single most expensive avoidable part of the request.
+  const wantData   = !totalsOnly
+  const wantTotals = totalsOnly || (!cursorToken && !skipTotals)
+
+  // The imported-range bound (lib/imported-range.ts), in the form that suits each query, planned only for the queries this request runs: the
+  // rows query is time-ordered only for the imported_* sorts, the totals are an aggregate. The projection form (a predicate on
+  // proj_imported_desc's key) is used only for an index-neutral search and a projection that is ready; with no lower bound this costs
+  // nothing (no readiness query).
+  const runMeta = (sql: string) => executeQuery(sql) as Promise<Array<Record<string, unknown>>>
+  const indexNeutral = isIndexNeutralSearch(searchTokens, regex)
+  const rowsRange = wantData
+    ? await planImportedRange(importedRange, { shape: /^imported_at\b/.test(orderBy) ? 'time' : 'other', indexNeutral, run: runMeta })
+    : importedRangePlain(importedRange)
+  const totalsRange = wantTotals
+    ? await planImportedRange(importedRange, { shape: 'aggregate', indexNeutral, run: runMeta })
+    : importedRangePlain(importedRange)
+  Object.assign(params, rowsRange.params, totalsRange.params)
+
   // Captured before the noise filter below, so whereRaw (raw_total) reflects
   // "how many rows match your search" without the Declutter/Unique view-only
   // restrictions — see raw_total below.
-  const conditionsRaw = [...conditions]
+  const conditionsRaw = [...conditions, ...totalsRange.conditions]
+  conditions.push(...rowsRange.conditions)
 
   // Non-destructive: hides the row from this result set, never deletes it.
   // Filters the precomputed is_noise column (cheap UInt8 → PREWHERE), NOT a
@@ -248,15 +275,6 @@
   try {
     const t0 = Date.now()
 
-    // The total only changes when the result SET changes (new filters/sort), not
-    // when paging through it. The first page is always cursor-less, so the totals run
-    // there; on deeper cursor pages we skip them entirely (total = null) and the client
-    // carries the page-1 total forward. At billions of rows a filtered search can
-    // match tens of millions, and counting them has no LIMIT -- re-counting all of them on
-    // every page turn is the single most expensive avoidable part of the request.
-    const wantData   = !totalsOnly
-    const wantTotals = totalsOnly || (!cursorToken && !skipTotals)
-
     // BOTH totals in ONE scan of the search predicate: `total` (the Declutter/Unique view) and `raw_total`
     // (the same search without those view-only restrictions, so the header can say "X of Y total imported"
     // instead of a bare filtered number that looks like missing data). They used to be two separate
@@ -269,7 +287,7 @@
     // total = distinct credentials via uniq() (HLL); with no filter it is a plain count() -- storage is
     // deduped at rest (see dedupeCountExpr for the measured cost and error bound).
     //
-    // optimize_use_projections = 0 unless the search is bounded by a date range: otherwise the planner
+    // optimize_use_projections = 0 unless the search is bounded by an imported range: otherwise the planner
     // takes proj_imported_desc as a "thin covering copy" and scans all of it -- 32.6 s against 11.0 s on
     // the base table, whose domain / url_host / email_domain columns are sorted and compress far better.
     // A date range is the one predicate that projection genuinely prunes, so it keeps the planner's choice.
@@ -288,7 +306,7 @@
            SETTINGS optimize_trivial_count_query = 1,
                     max_execution_time = 300,
                     timeout_overflow_mode = 'break',
-                    use_query_cache = 0${dateFrom || dateTo ? '' : ',\n                    optimize_use_projections = 0'}`,
+                    use_query_cache = 0${hasImportedRange(importedRange) ? '' : ',\n                    optimize_use_projections = 0'}`,
           params
         )
     // The same two numbers from the dictionary's candidates: one aggregate per disjoint branch, merged as aggregate states so the figure equals the
@@ -403,8 +421,9 @@
           baseParams,
           want: dedupe ? limit * DEDUPE_WINDOW_FACTOR : limit,
           cursorImportedAt,
-          dateFrom: dateFrom ? `${dateFrom} 00:00:00` : null,
-          dateTo: dateTo ? `${dateTo} 23:59:59` : null,
+          // The windows stop at the range: the oldest second wanted is one past the exclusive lower bound, the newest is the inclusive upper one.
+          floorTs: importedRange.lower === null ? null : importedRange.lower + 1,
+          ceilTs: importedRange.upper,
           buildWindowSql: (windowSql, budgetSeconds, { projected }) => `SELECT ${SELECT}${dedupe ? ', content_key_hash AS _c_hash' : ''}
          FROM (
            SELECT ${RAW_COLS}${dedupe ? ', content_key_hash' : ''}
```

- [x] **Step 6: Run the tests to see them pass**

Run: `npx vitest run __tests__/newest-first.test.ts __tests__/credentials-route-imported-range.test.ts __tests__/credentials-route-newest-first.test.ts __tests__/credentials-route.test.ts __tests__/credentials-route-totals.test.ts __tests__/credentials-route-dictionary.test.ts __tests__/credentials-route-dedupe-window.test.ts`
Expected: PASS, 150 tests in 7 files (54 + 17 + 79 across the five existing route files).

- [x] **Step 7: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . lib/newest-first.ts app/api/credentials/route.ts __tests__/newest-first.test.ts __tests__/credentials-route-imported-range.test.ts
git add lib/newest-first.ts app/api/credentials/route.ts __tests__/newest-first.test.ts __tests__/credentials-route-imported-range.test.ts
git commit -F - <<'EOF'
feat(credentials): imported_after / imported_before on the browse route, windows bounded by epoch seconds

The rows and the totals each get the form of the bound that suits them (the projection form
only for an index-neutral search while the projection is ready, planned only for the queries the
request runs); Newest-first windows stop at the bound, now passed as epoch seconds so no date
string is parsed and no time zone assumed. date_from / date_to keep their meaning. An invalid
bound is a 400 before anything runs.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: The export route

Every export format honors the bound (spray and wordlist stop ignoring it), a cut-off export says so, and the window is recorded in headers and in the file name.

**Files:**
- Modify: `app/api/export/route.ts`
- Modify: `__tests__/export-route.test.ts` (the source-slice test that pinned `LIMIT 10000`)
- Create: `__tests__/export-route-imported-range.test.ts`

**Interfaces:**
- Consumes: from Task 3 `importedRangeFromSearchParams`, `parseImportedRange`, `planImportedRange`, `importedRangeAndSql`, `importedWindowHeaders`, `importedWindowTag`, `ImportedRange`; from Task 1 `isIndexNeutralSearch`.
- Produces: `POST /api/export` body keys `imported_after` / `imported_before` (the old `date_from` / `date_to` still work); `GET /api/export?format=wordlist|spray` query params of the same names. Response headers `X-Export-Rows`, `X-Export-Truncated` (the five non-streaming formats), `X-Export-Imported-After`, `X-Export-Imported-Before` (when set, every format). `streamSprayList(..., range)` and `streamWordlist(..., range)` take an `ImportedRange` (spray's old unused `_extra` argument is gone).

- [x] **Step 1: Update the source-slice test and write the behavior tests**

Apply this diff to `__tests__/export-route.test.ts`:

```diff
diff --git a/__tests__/export-route.test.ts b/__tests__/export-route.test.ts
index d048d09..85fb9aa 100644
--- a/__tests__/export-route.test.ts
+++ b/__tests__/export-route.test.ts
@@ -47,10 +47,12 @@ describe('export route — POST main query avoids inlining NORM_COLS with ORDER
     expect(inner).toContain('RAW_COLS')
     expect(inner).not.toContain('NORM_COLS')
     expect(inner).toContain('ORDER BY')
-    expect(inner).toContain('LIMIT 10000')
+    // One row more than the cap, so a cut export can say so (X-Export-Truncated); the route trims it back to EXPORT_ROW_CAP.
+    expect(inner).toContain('LIMIT ${EXPORT_ROW_CAP + 1}')
+    expect(source).toContain('const EXPORT_ROW_CAP = 10_000')
 
     // NORM_COLS must appear in the outer SELECT (before the inner subquery starts),
-    // applied only to the already-bounded LIMIT 10000 result — not evaluated
+    // applied only to the already-bounded (LIMIT cap + 1) result — not evaluated
     // per-scanned-row alongside the sort/limit like the pre-fix version did.
     const outer = postFn.slice(0, innerStart)
     expect(outer).toContain('NORM_COLS')
```

Create `__tests__/export-route-imported-range.test.ts` with exactly this content:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
const streamCalls: Array<{ query: string; query_params: Record<string, unknown> }> = []
const READY = { defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }
let readiness: Array<Record<string, unknown>> = [READY]
let tableRows: Array<Record<string, string>> = []
let streamRows: Array<Record<string, string>> = []

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/system\.projections/.test(sql)) return readiness
    return tableRows
  }),
  getClient: () => ({
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
      streamCalls.push({ query: opts.query, query_params: opts.query_params ?? {} })
      return { stream: () => (async function* () { yield streamRows.map(r => ({ json: () => r })) })() }
    },
  }),
}))

import { NextRequest } from 'next/server'
import { GET, POST } from '@/app/api/export/route'
import { resetNewestFirstReadyCache, IMPORTED_KEY_EXPR } from '@/lib/newest-first'

// 2026-08-28T23:30:00Z .. 2026-08-29T00:30:00Z
const AFTER = '2026-08-28T23:30:00Z'
const BEFORE = '2026-08-29T00:30:00Z'
const AFTER_EPOCH = 1_787_959_800
const BEFORE_EPOCH = AFTER_EPOCH + 3600
const KEY_HI = `${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/export', { method: 'POST', body: JSON.stringify(body) }))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/export?${qs}`))
const dataCall = () => calls.find(c => /\) AS t\s/.test(c.sql))
const tableRow = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.com`, password: `pw${n}`, domain: `s${n}.example`,
  source_file: 'f.txt', breach_name: '', country_tier: '', login_type: 'email', password_length: '4', password_mask: 'alphanumeric',
  url_scheme: 'https', is_corporate_email: '0', email_domain: 'mail.com', url_host: `s${n}.example`, password_entropy_band: 'weak',
  imported_at: '2026-08-28 23:40:00',
})

beforeEach(() => {
  calls.length = 0
  streamCalls.length = 0
  readiness = [READY]
  tableRows = [tableRow(1)]
  streamRows = [{ email: 'a@b.co', domain: 'b.co', username: 'a', password: 'pw' }]
  resetNewestFirstReadyCache()
})

describe('POST /api/export — the imported-range bound', () => {
  test('an invalid bound is a 400 that names the parameter, and nothing reaches ClickHouse', async () => {
    const res = await post({ format: 'csv', imported_after: 'yesterday' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/^imported_after must be/)
    expect(calls).toHaveLength(0)
    expect(streamCalls).toHaveLength(0)
  })

  test('the bound is rejected before ANY format runs, spray and wordlist included', async () => {
    for (const format of ['spray', 'wordlist', 'hcmask', 'emails', 'domains', 'json']) {
      expect((await post({ format, imported_before: 'nope' })).status, format).toBe(400)
    }
    expect(calls).toHaveLength(0)
    expect(streamCalls).toHaveLength(0)
  })

  test('csv: the SQL carries both bounds as Int64 parameters', async () => {
    await post({ format: 'csv', imported_after: AFTER, imported_before: BEFORE })
    const { sql, params } = dataCall()!
    expect(sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(sql).toContain('imported_at <= toDateTime({impBefore:Int64})')
    expect(params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH })
  })

  test('the old date_from / date_to still work and mean whole UTC days', async () => {
    await post({ format: 'csv', date_from: '2026-08-28', date_to: '2026-08-28' })
    const { sql, params } = dataCall()!
    expect(sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(params).toMatchObject({ impAfter: Date.UTC(2026, 7, 28) / 1000 - 1, impBefore: Date.UTC(2026, 7, 28, 23, 59, 59) / 1000 })
    expect(sql).not.toContain('{dateFrom:DateTime}')
  })

  test('no bound at all: no bound SQL, no readiness query, and a plain file name and headers', async () => {
    const res = await post({ format: 'csv', query: 'binance.com' })
    expect(dataCall()!.sql).not.toContain('impAfter')
    expect(calls.some(c => /system\.projections/.test(c.sql))).toBe(false)
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="ulp-export.csv"')
    expect(res.headers.get('X-Export-Imported-After')).toBeNull()
    expect(res.headers.get('X-Export-Imported-Before')).toBeNull()
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('X-Export-Rows')).toBe('1')
  })

  test('the file name and headers record the window', async () => {
    const res = await post({ format: 'csv', imported_after: AFTER, imported_before: BEFORE })
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="ulp-export_after-20260828T233000Z_before-20260829T003000Z.csv"')
    expect(res.headers.get('X-Export-Imported-After')).toBe(AFTER)
    expect(res.headers.get('X-Export-Imported-Before')).toBe(BEFORE)
  })
})

describe('POST /api/export — which searches get the projection form', () => {
  test('a domain search, newest first, projection ready: plain bound plus the key predicate', async () => {
    await post({ format: 'csv', query: 'binance.com', imported_after: AFTER })
    const { sql, params } = dataCall()!
    expect(sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(sql).toContain(KEY_HI)
    expect(params).toMatchObject({ impKeyHi: -AFTER_EPOCH })
  })

  test('no query at all, newest first: the key predicate too', async () => {
    await post({ format: 'json', imported_after: AFTER })
    expect(dataCall()!.sql).toContain(KEY_HI)
  })

  test('a word search: plain bound only (a projection part has no text index, so hasToken would turn case-sensitive)', async () => {
    await post({ format: 'csv', query: 'ledger', imported_after: AFTER })
    expect(dataCall()!.sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
    expect(dataCall()!.sql).not.toContain('use_skip_indexes')
  })

  test('a regex search: plain bound only', async () => {
    await post({ format: 'csv', query: '^admin@', regex_mode: true, imported_after: AFTER })
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('a sort that is not by time: plain bound only', async () => {
    await post({ format: 'csv', query: 'binance.com', sort: 'domain_asc', imported_after: AFTER })
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
    expect(calls.some(c => /system\.projections/.test(c.sql))).toBe(false)
  })

  test('the projection is not ready: plain bound only, never wrong', async () => {
    readiness = [{ defined: 0, parts: 1, with_projection: 0 }]
    await post({ format: 'csv', query: 'binance.com', imported_after: AFTER })
    expect(dataCall()!.sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('only an upper bound: plain', async () => {
    await post({ format: 'csv', query: 'binance.com', imported_before: BEFORE })
    expect(dataCall()!.sql).toContain('imported_at <= toDateTime({impBefore:Int64})')
    expect(dataCall()!.sql).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('hcmask is an aggregate: it gets the key predicate for a domain search', async () => {
    await post({ format: 'hcmask', query: 'binance.com', imported_after: AFTER })
    const hc = calls.find(c => /GROUP BY password/.test(c.sql))!
    expect(hc.sql).toContain(KEY_HI)
  })
})

describe('POST /api/export — the 10,000-row cap says so', () => {
  test('the main query asks for one row more than the cap', async () => {
    await post({ format: 'csv' })
    expect(dataCall()!.sql).toContain('LIMIT 10001')
  })

  test('fewer rows than the cap: complete', async () => {
    tableRows = Array.from({ length: 3 }, (_, i) => tableRow(i))
    const res = await post({ format: 'ulp' })
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('X-Export-Rows')).toBe('3')
    expect((await res.text()).split('\n')).toHaveLength(3)
  })

  test('exactly the cap: still complete (the extra row never arrived)', async () => {
    tableRows = Array.from({ length: 10_000 }, (_, i) => tableRow(i))
    const res = await post({ format: 'userpass' })
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('X-Export-Rows')).toBe('10000')
  })

  test('one row over the cap: trimmed to the cap and flagged', async () => {
    tableRows = Array.from({ length: 10_001 }, (_, i) => tableRow(i))
    const res = await post({ format: 'userpass' })
    expect(res.headers.get('X-Export-Truncated')).toBe('1')
    expect(res.headers.get('X-Export-Rows')).toBe('10000')
    expect((await res.text()).split('\n')).toHaveLength(10_000)
  })

  test('csv: the header line plus the capped rows', async () => {
    tableRows = Array.from({ length: 10_001 }, (_, i) => tableRow(i))
    const text = await (await post({ format: 'csv' })).text()
    expect(text.split('\n')).toHaveLength(10_001) // header + 10,000
  })
})

describe('the streaming formats honor the bound too', () => {
  // The list formats start their query inside the stream (after the planner's await), so read the body before looking at what ran.
  test('emails: the DISTINCT query carries the bound and the window is in the file name and headers', async () => {
    const res = await post({ format: 'emails', query: 'binance.com', imported_after: AFTER, imported_before: BEFORE })
    const body = await res.text()
    const q = streamCalls[0]
    expect(q.query).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(q.query).toContain(KEY_HI) // an aggregate over an index-neutral search
    expect(q.query_params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH })
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="ulp-export-emails_after-20260828T233000Z_before-20260829T003000Z.txt"')
    expect(res.headers.get('X-Export-Imported-After')).toBe(AFTER)
    expect(body).toBe('a@b.co\n')
  })

  test('domains with no bound: untouched file name, no window headers, no readiness query', async () => {
    const res = await post({ format: 'domains', query: 'binance.com' })
    await res.text()
    expect(streamCalls[0].query).not.toContain('impAfter')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="ulp-export-domains.txt"')
    expect(res.headers.get('X-Export-Imported-After')).toBeNull()
    expect(calls.some(c => /system\.projections/.test(c.sql))).toBe(false)
  })

  test('spray (it used to ignore every extra filter, this one included) now applies the bound', async () => {
    const res = await post({ format: 'spray', query: 'binance.com', imported_after: AFTER, imported_before: BEFORE })
    const body = await res.text()
    const q = streamCalls[0]
    expect(q.query).toContain('SELECT DISTINCT arrayElement(splitByChar')
    expect(q.query).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(q.query).toContain('imported_at <= toDateTime({impBefore:Int64})')
    expect(q.query_params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH })
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="spray-list_after-20260828T233000Z_before-20260829T003000Z.txt"')
    expect(body).toBe('a\n')
  })

  test('spray with a word search keeps the plain bound', async () => {
    await (await post({ format: 'spray', query: 'ledger', imported_after: AFTER })).text()
    expect(streamCalls[0].query).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(streamCalls[0].query).not.toContain(IMPORTED_KEY_EXPR)
  })

  test('wordlist (it ignored the query and every filter) now applies the bound, on GET and on POST', async () => {
    streamRows = [{ password: 'hunter2' }]
    const viaGet = await get(`format=wordlist&imported_after=${encodeURIComponent(AFTER)}`)
    const text = await viaGet.text()
    expect(streamCalls[0].query).toContain('FROM ulp.credentials WHERE 1=1 AND imported_at > toDateTime({impAfter:Int64})')
    expect(streamCalls[0].query_params).toMatchObject({ impAfter: AFTER_EPOCH })
    expect(viaGet.headers.get('Content-Disposition')).toBe('attachment; filename="wordlist_after-20260828T233000Z.txt"')
    expect(text).toBe('hunter2\n')
    await (await post({ format: 'wordlist', imported_before: BEFORE })).text()
    expect(streamCalls[1].query).toContain('imported_at <= toDateTime({impBefore:Int64})')
  })

  test('wordlist with no bound and no filter has no WHERE at all, as before', async () => {
    await (await get('format=wordlist')).text()
    expect(streamCalls[0].query).toMatch(/FROM ulp\.credentials\s+GROUP BY password/)
  })

  test('GET: an invalid bound is a 400 and no query runs', async () => {
    const res = await get('format=spray&imported_after=garbage')
    expect(res.status).toBe(400)
    expect(streamCalls).toHaveLength(0)
  })

  test('GET without a bound: spray and wordlist are unchanged', async () => {
    await (await get('format=spray&domain=binance.com')).text()
    expect(streamCalls[0].query).not.toContain('impAfter')
    expect(streamCalls[0].query_params).toMatchObject({ sprayDomain: 'binance.com' })
  })
})
```

- [x] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/export-route.test.ts __tests__/export-route-imported-range.test.ts`
Expected: FAIL (the route has no bound, no cap flag, no headers).

- [x] **Step 3: Implement**

Apply this diff to `app/api/export/route.ts`:

```diff
diff --git a/app/api/export/route.ts b/app/api/export/route.ts
index b780e3a..9232e23 100644
--- a/app/api/export/route.ts
+++ b/app/api/export/route.ts
@@ -1,13 +1,17 @@
 import { type NextRequest, NextResponse } from "next/server"
 import { executeQuery, getClient } from "@/lib/clickhouse"
 import { validateRequest } from "@/lib/auth"
-import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
+import { parseULPQuery, buildULPWhere, buildULPWhereRegex, isIndexNeutralSearch } from "@/lib/ulp-search"
 import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
 import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
 import { NORM_COLS, NORM_COLS_SETTING } from "@/lib/ulp-normalize"
 import { noiseWhere } from "@/lib/ulp-noise"
 import { dedupeLimitBy } from "@/lib/ulp-dedupe"
 import { exportGroupBySettings, exportSortSettings } from "@/lib/clickhouse-query-limits"
+import {
+  importedRangeFromSearchParams, parseImportedRange, planImportedRange, importedRangeAndSql,
+  importedWindowHeaders, importedWindowTag, type ImportedRange,
+} from "@/lib/imported-range"
 
 export const dynamic = 'force-dynamic'
 
@@ -65,6 +69,14 @@ const SELECT = `${NORM_COLS},
   url_scheme, is_corporate_email, email_domain,
   url_host, password_entropy_band, imported_at`
 
+// The non-streaming formats (csv, json, ndjson, ulp, userpass) return at most this many rows. The query asks for ONE MORE, so an export that
+// was cut can say so (X-Export-Truncated) instead of looking complete: an incremental workflow that moves its imported-after cutoff past a
+// silently cut export loses the rows in between.
+const EXPORT_ROW_CAP = 10_000
+
+/** Metadata-only queries (the imported-range planner's readiness check). */
+const runMeta = (sql: string) => executeQuery(sql) as Promise<Array<Record<string, unknown>>>
+
 // GET /api/export?format=wordlist&tier_include=T1
 export async function GET(request: NextRequest) {
   const user = await validateRequest(request)
@@ -79,9 +91,11 @@ export async function GET(request: NextRequest) {
 
   const { include: incTiers, exclude: excTiers } = parseTierParams(tierInclude, tierExclude)
   const loginTypes = parseLoginTypeParam(loginType)
+  const parsedRange = importedRangeFromSearchParams(sp)
+  if (!parsedRange.ok) return NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 })
 
-  if (format === 'wordlist') return streamWordlist(incTiers, excTiers, loginTypes)
-  if (format === 'spray')    return streamSprayList('', domain, '', incTiers, excTiers, loginTypes)
+  if (format === 'wordlist') return streamWordlist(incTiers, excTiers, loginTypes, parsedRange.range)
+  if (format === 'spray')    return streamSprayList('', domain, '', incTiers, excTiers, loginTypes, parsedRange.range)
 
   return NextResponse.json({ success: false, error: "Use POST for other formats" }, { status: 400 })
 }
@@ -107,6 +121,8 @@ export async function POST(request: NextRequest) {
     pw_len_max   = null,
     date_from    = '',
     date_to      = '',
+    imported_after  = '',
+    imported_before = '',
     email_domain = '',
     source_file  = '',
     sort         = 'imported_desc',
@@ -118,9 +134,13 @@ export async function POST(request: NextRequest) {
 
   const { include: incTiers, exclude: excTiers } = parseTierParams(tier_include, tier_exclude)
   const loginTypes = parseLoginTypeParam(login_type)
+  // imported_after / imported_before (and the old date_from / date_to): lib/imported-range.ts. An invalid bound is a 400 before anything runs.
+  const parsedRange = parseImportedRange({ imported_after, imported_before, date_from, date_to })
+  if (!parsedRange.ok) return NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 })
+  const importedRange = parsedRange.range
 
-  if (format === 'wordlist') return streamWordlist(incTiers, excTiers, loginTypes)
-  if (format === 'spray')    return streamSprayList(query, domain, breach_name, incTiers, excTiers, loginTypes, { pw_mask, url_scheme, is_corporate, pw_len_min, pw_len_max, date_from, date_to, email_domain, regex_mode })
+  if (format === 'wordlist') return streamWordlist(incTiers, excTiers, loginTypes, importedRange)
+  if (format === 'spray')    return streamSprayList(query, domain, breach_name, incTiers, excTiers, loginTypes, importedRange)
 
   // Build WHERE for non-streaming formats
   const tokens = parseULPQuery(query)
@@ -144,13 +164,19 @@ export async function POST(request: NextRequest) {
   const pwLenMaxNum = pw_len_max !== null && pw_len_max !== '' ? parseInt(String(pw_len_max), 10) : null
   if (pwLenMinNum !== null && !isNaN(pwLenMinNum)) { extras.push(' AND password_length >= {pwLenMin:UInt8}'); mergedParams.pwLenMin = pwLenMinNum }
   if (pwLenMaxNum !== null && !isNaN(pwLenMaxNum)) { extras.push(' AND password_length <= {pwLenMax:UInt8}'); mergedParams.pwLenMax = pwLenMaxNum }
-  if (date_from) { extras.push(' AND imported_at >= {dateFrom:DateTime}'); mergedParams.dateFrom = `${date_from} 00:00:00` }
-  if (date_to)   { extras.push(' AND imported_at <= {dateTo:DateTime}');   mergedParams.dateTo   = `${date_to} 23:59:59` }
   if (pw_mask) {
     const masks = String(pw_mask).split(',').map(m => `'${m.trim()}'`).filter(Boolean)
     if (masks.length) extras.push(` AND password_mask IN (${masks.join(',')})`)
   }
 
+  // The imported-range bound. The projection form (a predicate on proj_imported_desc's key) is only for a time-ordered or aggregate query over
+  // an index-neutral search; everything else gets the plain bound. See lib/imported-range.ts (planImportedRange).
+  const orderBy = SORT_MAP[sort] ?? SORT_MAP['imported_desc']
+  const shape = format === 'hcmask' || format === 'emails' || format === 'domains' ? 'aggregate' : /^imported_at\b/.test(orderBy) ? 'time' : 'other'
+  const rangeSql = await planImportedRange(importedRange, { shape, indexNeutral: isIndexNeutralSearch(tokens, Boolean(regex_mode)), run: runMeta })
+  Object.assign(mergedParams, rangeSql.params)
+  extras.push(importedRangeAndSql(rangeSql))
+
   const tierExtra      = tierWhereMulti(incTiers, excTiers)
   const loginTypeExtra = loginTypeWhere(loginTypes)
   // Declutter parity with the browser view — append last so it flows into every
@@ -160,20 +186,19 @@ export async function POST(request: NextRequest) {
 
   // For hcmask, we only need passwords — handled specially
   if (format === 'hcmask') {
-    return exportHcmask(clause, allExtras, mergedParams, breach_name, domain, incTiers, excTiers, loginTypes)
+    return exportHcmask(clause, allExtras, mergedParams, breach_name, domain, incTiers, excTiers, loginTypes, importedRange)
   }
 
   // For emails-only and domains-only — dedicated streaming-friendly queries
   if (format === 'emails') {
-    return streamUniqueList('email', clause, allExtras, mergedParams, breach_name, domain, incTiers, excTiers, loginTypes)
+    return streamUniqueList('email', clause, allExtras, mergedParams, breach_name, domain, incTiers, excTiers, loginTypes, importedRange)
   }
   if (format === 'domains') {
-    return streamUniqueList('domain', clause, allExtras, mergedParams, breach_name, domain, incTiers, excTiers, loginTypes)
+    return streamUniqueList('domain', clause, allExtras, mergedParams, breach_name, domain, incTiers, excTiers, loginTypes, importedRange)
   }
 
   try {
-    const orderBy = SORT_MAP[sort] ?? SORT_MAP['imported_desc']
-    const rows = await executeQuery(
+    const fetched = await executeQuery(
       // Split into an inner (raw columns, ORDER BY, LIMIT) and outer (NORM_COLS)
       // query — see RAW_COLS above for why. exportSortSettings() covers the
       // dedupe + non-domain-sort case — see the comment above SORT_MAP.
@@ -184,11 +209,14 @@ export async function POST(request: NextRequest) {
          WHERE ${clause}${allExtras}
          ORDER BY ${orderBy}
          ${dedupeLimitBy(dedupeOn)}
-         LIMIT 10000
+         LIMIT ${EXPORT_ROW_CAP + 1}
        ) AS t
        ${exportSortSettings()}, ${NORM_COLS_SETTING}`,
       mergedParams
     ) as Array<Record<string, string>>
+    // One row more than the cap came back: the export was cut. Hand over the cap and say so.
+    const truncated = fetched.length > EXPORT_ROW_CAP
+    const rows = truncated ? fetched.slice(0, EXPORT_ROW_CAP) : fetched
 
     let content: string
     let contentType: string
@@ -228,7 +256,10 @@ export async function POST(request: NextRequest) {
     return new NextResponse(content, {
       headers: {
         'Content-Type': `${contentType}; charset=utf-8`,
-        'Content-Disposition': `attachment; filename="${base}.${ext}"`,
+        'Content-Disposition': `attachment; filename="${base}${importedWindowTag(importedRange)}.${ext}"`,
+        'X-Export-Rows': String(rows.length),
+        'X-Export-Truncated': truncated ? '1' : '0',
+        ...importedWindowHeaders(importedRange),
       },
     })
   } catch (error) {
@@ -252,7 +283,7 @@ function toHcMask(password: string): string {
 
 async function exportHcmask(
   clause: string, allExtras: string, mergedParams: Record<string, unknown>,
-  breach_name: string, domain: string, incTiers: string[], excTiers: string[], loginTypes: string[],
+  breach_name: string, domain: string, incTiers: string[], excTiers: string[], loginTypes: string[], range: ImportedRange,
 ): Promise<NextResponse> {
   try {
     const rows = await executeQuery(
@@ -289,7 +320,8 @@ async function exportHcmask(
     return new NextResponse(lines.join('\n'), {
       headers: {
         'Content-Type': 'text/plain; charset=utf-8',
-        'Content-Disposition': `attachment; filename="${base}.hcmask"`,
+        'Content-Disposition': `attachment; filename="${base}${importedWindowTag(range)}.hcmask"`,
+        ...importedWindowHeaders(range),
       },
     })
   } catch (_error) {
@@ -304,7 +336,7 @@ async function exportHcmask(
 function streamUniqueList(
   field: 'email' | 'domain',
   clause: string, allExtras: string, mergedParams: Record<string, unknown>,
-  breach_name: string, domain: string, incTiers: string[], excTiers: string[], loginTypes: string[],
+  breach_name: string, domain: string, incTiers: string[], excTiers: string[], loginTypes: string[], range: ImportedRange,
 ): NextResponse {
   const encoder = new TextEncoder()
   const readable = new ReadableStream({
@@ -338,7 +370,8 @@ function streamUniqueList(
   return new NextResponse(readable, {
     headers: {
       'Content-Type': 'text/plain; charset=utf-8',
-      'Content-Disposition': `attachment; filename="${base}-${field}s.txt"`,
+      'Content-Disposition': `attachment; filename="${base}-${field}s${importedWindowTag(range)}.txt"`,
+      ...importedWindowHeaders(range),
     },
   })
 }
@@ -347,20 +380,22 @@ function streamUniqueList(
 // Stream: password wordlist (sorted by frequency)
 // ─────────────────────────────────────────────────────────────────────────────
 
-function streamWordlist(incTiers: string[], excTiers: string[], loginTypes: string[]): NextResponse {
+function streamWordlist(incTiers: string[], excTiers: string[], loginTypes: string[], range: ImportedRange): NextResponse {
   const encoder        = new TextEncoder()
   const tierExtra      = tierWhereMulti(incTiers, excTiers)
   const loginTypeExtra = loginTypeWhere(loginTypes)
-  const where          = tierExtra || loginTypeExtra
-    ? `WHERE 1=1${tierExtra}${loginTypeExtra}`
-    : ''
 
   const readable = new ReadableStream({
     async start(controller) {
       try {
+        // The wordlist has no search of its own, so it is always index-neutral; the date bound is the only thing it adds.
+        const rangeSql = await planImportedRange(range, { shape: 'aggregate', indexNeutral: true, run: runMeta })
+        const rangeExtra = importedRangeAndSql(rangeSql)
+        const where = tierExtra || loginTypeExtra || rangeExtra ? `WHERE 1=1${tierExtra}${loginTypeExtra}${rangeExtra}` : ''
         const chClient = getClient()
         const resultSet = await chClient.query({
           query: `SELECT password, count() AS freq FROM ulp.credentials ${where} GROUP BY password ORDER BY freq DESC LIMIT 5000000 ${exportGroupBySettings(120)}`,
+          query_params: rangeSql.params,
           format: 'JSONEachRow',
         })
         const stream = resultSet.stream<{ password: string; freq: string }>()
@@ -379,7 +414,8 @@ function streamWordlist(incTiers: string[], excTiers: string[], loginTypes: stri
   return new NextResponse(readable, {
     headers: {
       'Content-Type': 'text/plain; charset=utf-8',
-      'Content-Disposition': `attachment; filename="wordlist${suffix}.txt"`,
+      'Content-Disposition': `attachment; filename="wordlist${suffix}${importedWindowTag(range)}.txt"`,
+      ...importedWindowHeaders(range),
     },
   })
 }
@@ -391,7 +427,7 @@ function streamWordlist(incTiers: string[], excTiers: string[], loginTypes: stri
 function streamSprayList(
   query: string, domain: string, breach_name: string,
   incTiers: string[], excTiers: string[], loginTypes: string[],
-  _extra: Record<string, unknown> = {},
+  range: ImportedRange,
 ): NextResponse {
   const encoder        = new TextEncoder()
   const tokens         = parseULPQuery(query)
@@ -409,14 +445,15 @@ function streamSprayList(
   const readable = new ReadableStream({
     async start(controller) {
       try {
+        const rangeSql = await planImportedRange(range, { shape: 'aggregate', indexNeutral: isIndexNeutralSearch(tokens), run: runMeta })
         const chClient = getClient()
         const resultSet = await chClient.query({
           query: `SELECT DISTINCT arrayElement(splitByChar('@', email), 1) AS username
                   FROM ulp.credentials
-                  WHERE ${clause}${domainExtra}${breachExtra}${tierExtra}${loginTypeExtra}
+                  WHERE ${clause}${domainExtra}${breachExtra}${tierExtra}${loginTypeExtra}${importedRangeAndSql(rangeSql)}
                   ORDER BY username
                   SETTINGS max_execution_time = 120`,
-          query_params: mergedParams,
+          query_params: { ...mergedParams, ...rangeSql.params },
           format: 'JSONEachRow',
         })
         const stream = resultSet.stream<{ username: string }>()
@@ -432,11 +469,13 @@ function streamSprayList(
   })
 
   const base = buildFilenameBase(breach_name, domain, incTiers, excTiers, loginTypes)
-  const filename = domain ? `spray-${base}.txt` : `spray-list${base.replace('ulp-export', '')}.txt`
+  const tag = importedWindowTag(range)
+  const filename = domain ? `spray-${base}${tag}.txt` : `spray-list${base.replace('ulp-export', '')}${tag}.txt`
   return new NextResponse(readable, {
     headers: {
       'Content-Type': 'text/plain; charset=utf-8',
       'Content-Disposition': `attachment; filename="${filename}"`,
+      ...importedWindowHeaders(range),
     },
   })
 }
```

- [x] **Step 4: Run the tests to see them pass**

Run: `npx vitest run __tests__/export-route.test.ts __tests__/export-route-imported-range.test.ts`
Expected: PASS, 35 tests (8 + 27).

- [x] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . app/api/export/route.ts __tests__/export-route.test.ts __tests__/export-route-imported-range.test.ts
git add app/api/export/route.ts __tests__/export-route.test.ts __tests__/export-route-imported-range.test.ts
git commit -F - <<'EOF'
feat(export): the imported-range bound on every format, a reported 10,000-row cap, window headers and file names

csv, json, ndjson, ulp, userpass, hcmask, emails, domains, spray and wordlist all honor
imported_after / imported_before (spray used to receive the filters and drop them; wordlist
ignored the query and every filter). The non-streaming formats ask for one row more than the cap
and send X-Export-Truncated when it was cut, so an incremental workflow cannot move its cutoff
past a silently cut export. The window is in X-Export-Imported-After / -Before and in the file
name.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: The remaining server routes

`/api/search` (legacy), `/api/v1/search/credentials`, `/api/v1/search/domain`, `/api/v1/lookup`, `/api/v1/lookup/batch` and `/api/lookup/batch`.

**Files:**
- Modify: `app/api/search/route.ts`, `app/api/v1/search/credentials/route.ts`, `app/api/v1/search/domain/route.ts`, `app/api/v1/lookup/route.ts`, `app/api/v1/lookup/batch/route.ts`, `app/api/lookup/batch/route.ts`
- Create: `__tests__/lookup-routes-imported-range.test.ts`

**Interfaces:**
- Consumes: from Task 3 `importedRangeFromSearchParams`, `parseImportedRange`, `importedRangePlain`, `planImportedRange`, `importedRangeAndSql`, `importedRangeEchoIfSet`; from Task 1 `isIndexNeutralSearch`.
- Produces: query params `imported_after` / `imported_before` on the four GET routes (the old `date_from` / `date_to` too); body keys of the same two names on the two batch routes (they never had the old names). Responses echo the effective window (`imported_after`, `imported_before`) only when a bound was given, so existing response shapes do not change. Only `/api/v1/search/credentials` uses the projection form (rows: `time`, count: `aggregate`); the others use the plain bound, because `domain = X`, `email = X` and `... IN (...)` are already narrowed by the key (measured 18-175 ms with or without the key predicate).

- [x] **Step 1: Write the tests**

Create `__tests__/lookup-routes-imported-range.test.ts` with exactly this content:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: vi.fn().mockResolvedValue({
    success: true,
    apiKey: { id: 'test-key', role: 'admin' },
    rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 },
  }),
  addRateLimitHeaders: vi.fn(response => response),
  logApiRequest: vi.fn().mockResolvedValue(undefined),
}))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
const READY = { defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }
let readiness: Array<Record<string, unknown>> = [READY]
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/system\.projections/.test(sql)) return readiness
    if (/count\(\) AS total/i.test(sql)) return [{ total: '5' }]
    return []
  }),
}))

import { NextRequest } from 'next/server'
import { GET as v1Search } from '@/app/api/v1/search/credentials/route'
import { GET as v1Domain } from '@/app/api/v1/search/domain/route'
import { GET as v1Lookup } from '@/app/api/v1/lookup/route'
import { POST as v1Batch } from '@/app/api/v1/lookup/batch/route'
import { POST as uiBatch } from '@/app/api/lookup/batch/route'
import { GET as legacySearch } from '@/app/api/search/route'
import { resetNewestFirstReadyCache, IMPORTED_KEY_EXPR } from '@/lib/newest-first'

const AFTER = '2026-08-28T23:30:00Z'
const BEFORE = '2026-08-29T00:30:00Z'
const AFTER_EPOCH = 1_787_959_800
const BEFORE_EPOCH = AFTER_EPOCH + 3600
const WINDOW_PARAMS = `imported_after=${encodeURIComponent(AFTER)}&imported_before=${encodeURIComponent(BEFORE)}`
const PLAIN_AFTER = 'imported_at > toDateTime({impAfter:Int64})'
const PLAIN_BEFORE = 'imported_at <= toDateTime({impBefore:Int64})'
const KEY_HI = `${IMPORTED_KEY_EXPR} < {impKeyHi:Int64}`

const getUrl = (handler: (r: NextRequest) => Promise<Response>, url: string) => handler(new NextRequest(`http://localhost${url}`))
const postJson = (handler: (r: NextRequest) => Promise<Response>, url: string, body: unknown) =>
  handler(new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) }))
const metaCalls = () => calls.filter(c => /system\.projections/.test(c.sql))
const queryCalls = () => calls.filter(c => !/system\.projections/.test(c.sql))

beforeEach(() => {
  calls.length = 0
  readiness = [READY]
  resetNewestFirstReadyCache()
})

describe('GET /api/v1/search/credentials — imported_after / imported_before', () => {
  test('an invalid bound is a 400 that names the parameter, and nothing reaches ClickHouse (even with no query text)', async () => {
    for (const qs of ['q=binance.com&imported_after=yesterday', 'imported_before=nope']) {
      const res = await getUrl(v1Search, `/api/v1/search/credentials?${qs}`)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/^imported_(after|before) must be/)
    }
    expect(calls).toHaveLength(0)
  })

  test('a domain search: the rows (ORDER BY imported_at DESC) and the count both carry the bound; both may use the projection form', async () => {
    const res = await getUrl(v1Search, `/api/v1/search/credentials?q=binance.com&${WINDOW_PARAMS}`)
    const body = await res.json()
    const count = calls.find(c => /count\(\) as total/i.test(c.sql))!
    const rows = calls.find(c => /ORDER BY imported_at DESC/.test(c.sql))!
    for (const c of [count, rows]) {
      expect(c.sql).toContain(PLAIN_AFTER)
      expect(c.sql).toContain(PLAIN_BEFORE)
      expect(c.sql).toContain(KEY_HI)
      expect(c.params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH, impKeyHi: -AFTER_EPOCH })
    }
    expect(body.imported_after).toBe(AFTER)
    expect(body.imported_before).toBe(BEFORE)
  })

  test('a word search keeps the plain bound only (a projection has no text index)', async () => {
    await getUrl(v1Search, `/api/v1/search/credentials?q=ledger&imported_after=${encodeURIComponent(AFTER)}`)
    for (const c of queryCalls()) {
      expect(c.sql).toContain(PLAIN_AFTER)
      expect(c.sql).not.toContain(IMPORTED_KEY_EXPR)
      expect(c.sql).not.toContain('use_skip_indexes')
    }
    expect(metaCalls()).toHaveLength(0)
  })

  test('the old date_from works here too, as a whole UTC day', async () => {
    await getUrl(v1Search, '/api/v1/search/credentials?q=ledger&date_from=2026-08-28')
    expect(queryCalls()[0].params).toMatchObject({ impAfter: Date.UTC(2026, 7, 28) / 1000 - 1 })
  })

  test('no bound: nothing added to the SQL, no readiness query, and the response keeps its exact shape', async () => {
    const res = await getUrl(v1Search, '/api/v1/search/credentials?q=binance.com')
    const body = await res.json()
    for (const c of queryCalls()) expect(c.sql).not.toContain('impAfter')
    expect(metaCalls()).toHaveLength(0)
    expect(body).not.toHaveProperty('imported_after')
    expect(body).not.toHaveProperty('imported_before')
    expect(Object.keys(body).sort()).toEqual(['next_cursor', 'page', 'pages', 'query', 'results', 'success', 'total'])
  })

  test('a keyset cursor and a bound compose, and the count is still skipped on a cursor page', async () => {
    const cursor = Buffer.from(JSON.stringify({ sort: 'imported_desc', v: { imported_at: '2026-08-28 23:40:00', domain: 'a', email: 'b', url: 'u', password: 'p' } })).toString('base64')
    await getUrl(v1Search, `/api/v1/search/credentials?q=binance.com&imported_after=${encodeURIComponent(AFTER)}&cursor=${encodeURIComponent(cursor)}`)
    expect(calls.some(c => /count\(\) as total/i.test(c.sql))).toBe(false)
    const rows = calls.find(c => /ORDER BY imported_at DESC/.test(c.sql))!
    expect(rows.sql).toContain('imported_at < {c_ia:DateTime}')
    expect(rows.sql).toContain(PLAIN_AFTER)
    expect(rows.sql).not.toContain('OFFSET')
  })
})

describe('GET /api/v1/search/domain — imported_after / imported_before', () => {
  test('an invalid bound is a 400 and no query runs', async () => {
    const res = await getUrl(v1Domain, '/api/v1/search/domain?domain=binance.com&imported_before=2026-13-45')
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('the count and the rows carry the plain bound (the primary key narrows the read), and the response echoes the window', async () => {
    const body = await (await getUrl(v1Domain, `/api/v1/search/domain?domain=binance.com&${WINDOW_PARAMS}`)).json()
    expect(queryCalls()).toHaveLength(2)
    for (const c of queryCalls()) {
      expect(c.sql).toContain(`WHERE domain = {domain:String} AND ${PLAIN_AFTER} AND ${PLAIN_BEFORE}`)
      expect(c.sql).not.toContain(IMPORTED_KEY_EXPR)
      expect(c.params).toMatchObject({ domain: 'binance.com', impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH })
    }
    expect(metaCalls()).toHaveLength(0)
    expect(body).toMatchObject({ imported_after: AFTER, imported_before: BEFORE })
  })

  test('no bound: unchanged SQL and response shape', async () => {
    const body = await (await getUrl(v1Domain, '/api/v1/search/domain?domain=binance.com')).json()
    for (const c of queryCalls()) expect(c.sql).toContain('WHERE domain = {domain:String}\n')
    expect(body).not.toHaveProperty('imported_after')
  })
})

describe('GET /api/v1/lookup — imported_after / imported_before', () => {
  test('an invalid bound is a 400', async () => {
    expect((await getUrl(v1Lookup, '/api/v1/lookup?email=a@b.co&imported_after=bad')).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('by email and by domain', async () => {
    const byEmail = await (await getUrl(v1Lookup, `/api/v1/lookup?email=a@b.co&imported_after=${encodeURIComponent(AFTER)}`)).json()
    expect(calls[0].sql).toContain(`WHERE email = {email:String} AND ${PLAIN_AFTER}`)
    expect(calls[0].params).toMatchObject({ email: 'a@b.co', impAfter: AFTER_EPOCH })
    expect(byEmail.imported_after).toBe(AFTER)
    calls.length = 0
    await getUrl(v1Lookup, `/api/v1/lookup?domain=b.co&imported_before=${encodeURIComponent(BEFORE)}`)
    expect(calls[0].sql).toContain(`WHERE domain = {domain:String} AND ${PLAIN_BEFORE}`)
    expect(calls[0].params).toMatchObject({ domain: 'b.co', impBefore: BEFORE_EPOCH })
  })

  test('no bound: unchanged', async () => {
    await getUrl(v1Lookup, '/api/v1/lookup?email=a@b.co')
    expect(calls[0].sql).toContain('WHERE email = {email:String}\n')
    expect(calls[0].sql).not.toContain('impAfter')
  })
})

describe.each([
  ['POST /api/v1/lookup/batch', v1Batch, '/api/v1/lookup/batch'],
  ['POST /api/lookup/batch', uiBatch, '/api/lookup/batch'],
] as const)('%s — imported_after / imported_before', (_name, handler, url) => {
  test('an invalid bound is a 400 and no query runs', async () => {
    const res = await postJson(handler, url, { emails: ['a@b.co'], imported_after: 'whenever' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/^imported_after must be/)
    expect(calls).toHaveLength(0)
  })

  test('both the email lookup and the domain lookup carry the bound beside the key, and the result echoes it', async () => {
    const body = await (await postJson(handler, url, { emails: ['A@b.co'], domains: ['b.co'], imported_after: AFTER, imported_before: BEFORE })).json()
    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toContain(`WHERE email IN ({email0:String}) AND ${PLAIN_AFTER} AND ${PLAIN_BEFORE}`)
    expect(calls[1].sql).toContain(`WHERE domain IN ({domain0:String}) AND ${PLAIN_AFTER} AND ${PLAIN_BEFORE}`)
    for (const c of calls) expect(c.params).toMatchObject({ impAfter: AFTER_EPOCH, impBefore: BEFORE_EPOCH, cap: 50 })
    expect(calls[0].params).toMatchObject({ email0: 'a@b.co' })
    expect(body).toMatchObject({ imported_after: AFTER, imported_before: BEFORE })
  })

  test('no bound: the SQL and the response shape are what they were', async () => {
    const body = await (await postJson(handler, url, { emails: ['a@b.co'] })).json()
    expect(calls[0].sql).toContain('WHERE email IN ({email0:String})\n')
    expect(calls[0].sql).not.toContain('impAfter')
    expect(body).not.toHaveProperty('imported_after')
  })

  test('the date_from / date_to names are not part of this body (only the two new keys)', async () => {
    await postJson(handler, url, { emails: ['a@b.co'], date_from: '2026-08-28' })
    expect(calls[0].sql).not.toContain('impAfter')
  })
})

describe('GET /api/search (legacy, no UI caller) — imported_after / imported_before', () => {
  test('a bound alone counts as a filter, and carries the plain bound into the count and the rows', async () => {
    const res = await getUrl(legacySearch, `/api/search?${WINDOW_PARAMS}`)
    expect(res.status).toBe(200)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) {
      expect(c.sql).toContain(PLAIN_AFTER)
      expect(c.sql).toContain(PLAIN_BEFORE)
      expect(c.sql).not.toContain(IMPORTED_KEY_EXPR)
    }
    expect(metaCalls()).toHaveLength(0)
  })

  test('the old date_from alone is still a filter', async () => {
    const res = await getUrl(legacySearch, '/api/search?date_from=2026-08-28')
    expect(res.status).toBe(200)
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  test('an invalid bound is a 400', async () => {
    expect((await getUrl(legacySearch, '/api/search?q=x&imported_after=2026-02-30')).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('no filter at all is still the empty answer with no query', async () => {
    const body = await (await getUrl(legacySearch, '/api/search')).json()
    expect(body.results).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
```

- [x] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/lookup-routes-imported-range.test.ts`
Expected: FAIL (no route reads the new parameters yet).

- [x] **Step 3: Implement the six routes**

Apply these six diffs.

`app/api/search/route.ts`:

```diff
diff --git a/app/api/search/route.ts b/app/api/search/route.ts
index a4bd890..f35cc4d 100644
--- a/app/api/search/route.ts
+++ b/app/api/search/route.ts
@@ -2,6 +2,7 @@ import { type NextRequest, NextResponse } from "next/server"
 import { executeQuery } from "@/lib/clickhouse"
 import { validateRequest } from "@/lib/auth"
 import { parseULPQuery, buildULPWhere, buildULPWhereRegex } from "@/lib/ulp-search"
+import { importedRangeFromSearchParams, hasImportedRange, importedRangePlain, importedRangeAndSql } from "@/lib/imported-range"
 import { tierWhereMulti, parseTierParams } from "@/lib/country-tiers"
 import { loginTypeWhere, parseLoginTypeParam } from "@/lib/login-type"
 import { NORM_COLS, NORM_COLS_SETTING } from "@/lib/ulp-normalize"
@@ -55,8 +56,9 @@ export async function GET(request: NextRequest) {
   const isCorporate = searchParams.get('is_corporate') || ''
   const pwLenMin    = searchParams.get('pw_len_min') ? parseInt(searchParams.get('pw_len_min')!) : null
   const pwLenMax    = searchParams.get('pw_len_max') ? parseInt(searchParams.get('pw_len_max')!) : null
-  const dateFrom    = searchParams.get('date_from') || ''
-  const dateTo      = searchParams.get('date_to')   || ''
+  const parsedRange = importedRangeFromSearchParams(searchParams)
+  if (!parsedRange.ok) return NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 })
+  const importedRange = parsedRange.range
   const emailDomain = searchParams.get('email_domain') || ''
   const sourceFile  = searchParams.get('source_file')  || ''
   const regexMode   = searchParams.get('regex') === '1'
@@ -74,7 +76,7 @@ export async function GET(request: NextRequest) {
   // Require at least one filter
   const hasFilter = q.trim() || breach || tierInclude || tierExclude || loginType ||
                     pwMasks.length || urlScheme || isCorporate || pwLenMin !== null ||
-                    pwLenMax !== null || dateFrom || dateTo || emailDomain || sourceFile
+                    pwLenMax !== null || hasImportedRange(importedRange) || emailDomain || sourceFile
   if (!hasFilter) {
     return NextResponse.json({ success: true, results: [], total: 0, next_cursor: null, query: '' })
   }
@@ -99,8 +101,10 @@ export async function GET(request: NextRequest) {
   if (isCorporate === '1') extras.push(' AND is_corporate_email = 1')
   if (pwLenMin !== null) { extras.push(' AND password_length >= {pwLenMin:UInt8}'); mergedParams.pwLenMin = pwLenMin }
   if (pwLenMax !== null) { extras.push(' AND password_length <= {pwLenMax:UInt8}'); mergedParams.pwLenMax = pwLenMax }
-  if (dateFrom) { extras.push(' AND imported_at >= {dateFrom:DateTime}'); mergedParams.dateFrom = `${dateFrom} 00:00:00` }
-  if (dateTo)   { extras.push(' AND imported_at <= {dateTo:DateTime}');   mergedParams.dateTo   = `${dateTo} 23:59:59` }
+  // imported_after / imported_before (and the old date_from / date_to): lib/imported-range.ts. This legacy route has no UI caller and gets the plain bound.
+  const rangeSql = importedRangePlain(importedRange)
+  Object.assign(mergedParams, rangeSql.params)
+  extras.push(importedRangeAndSql(rangeSql))
 
   // Password mask: already sanitised to known values — safe to interpolate
   if (pwMasks.length) {
```

`app/api/v1/search/credentials/route.ts`:

```diff
diff --git a/app/api/v1/search/credentials/route.ts b/app/api/v1/search/credentials/route.ts
index 9b2d8ef..f5934f8 100644
--- a/app/api/v1/search/credentials/route.ts
+++ b/app/api/v1/search/credentials/route.ts
@@ -2,12 +2,15 @@
  * Search API v1 - ULP Credentials Search
  * GET /api/v1/search/credentials?q=<query>&page=1&limit=100
  * GET /api/v1/search/credentials?q=<query>&cursor=<token>&limit=100  (keyset pagination — recommended for deep paging; see next_cursor in the response)
+ * Optional: &imported_after=<instant>&imported_before=<instant> (UTC; exclusive / inclusive; a date, a date-time or ISO-8601 with an offset), so a
+ * caller that polls with the last window's imported_before only ever sees what arrived since. The response echoes the effective window.
  */
 
 import { NextRequest, NextResponse } from "next/server"
 import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
 import { executeQuery } from "@/lib/clickhouse"
-import { parseULPQuery, buildULPWhere } from "@/lib/ulp-search"
+import { parseULPQuery, buildULPWhere, isIndexNeutralSearch } from "@/lib/ulp-search"
+import { importedRangeFromSearchParams, importedRangeEchoIfSet, planImportedRange, importedRangeAndSql } from "@/lib/imported-range"
 import { decodeCursor, buildCursorWhere, encodeCursor } from "@/lib/cursor-pagination"
 
 export const dynamic = 'force-dynamic'
@@ -33,13 +36,26 @@ export async function GET(request: NextRequest) {
   const offset = (page - 1) * limit
   const cursorToken = searchParams.get('cursor') || ''
 
+  const parsedRange = importedRangeFromSearchParams(searchParams)
+  if (!parsedRange.ok) {
+    return addRateLimitHeaders(NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 }), authResult.rateLimit)
+  }
+  const importedRange = parsedRange.range
+
   if (!q.trim()) {
     const response = NextResponse.json({ success: true, results: [], total: 0, page: 1, pages: 0, next_cursor: null })
     return addRateLimitHeaders(response, authResult.rateLimit)
   }
 
   try {
-    const { clause, params } = buildULPWhere(parseULPQuery(q))
+    const tokens = parseULPQuery(q)
+    const { clause, params } = buildULPWhere(tokens)
+    // The rows are ORDER BY imported_at DESC (a time-ordered query) and the count is an aggregate: both may use proj_imported_desc, but
+    // only for a search whose predicates mean the same on a projection (lib/imported-range.ts, planImportedRange).
+    const indexNeutral = isIndexNeutralSearch(tokens)
+    const runMeta = (sql: string) => executeQuery(sql) as Promise<Array<Record<string, unknown>>>
+    const rowsRange = await planImportedRange(importedRange, { shape: 'time', indexNeutral, run: runMeta })
+    const totalRange = await planImportedRange(importedRange, { shape: 'aggregate', indexNeutral, run: runMeta })
 
     // Keyset pagination: reuses the same tested primitive the internal
     // Credentials Browser already uses (lib/cursor-pagination.ts). An
@@ -65,24 +81,24 @@ export async function GET(request: NextRequest) {
       usingCursor
         ? Promise.resolve(null)
         : executeQuery(
-            `SELECT count() as total FROM ulp.credentials WHERE ${clause}
+            `SELECT count() as total FROM ulp.credentials WHERE ${clause}${importedRangeAndSql(totalRange)}
              SETTINGS optimize_trivial_count_query = 1,
                       max_execution_time = 300,
                       timeout_overflow_mode = 'break',
                       use_query_cache = 0`,
-            params
+            { ...params, ...totalRange.params }
           ),
       // Data: throw mode on timeout so we return a 408 instead of silent 0 rows
       // (timeout_overflow_mode=break with ORDER BY does not flush sort buffer —
       // ClickHouse issue #52234).
       executeQuery(
         `SELECT url, email, password, domain, source_file, imported_at
-         FROM ulp.credentials WHERE ${clause}${cursorClause}
+         FROM ulp.credentials WHERE ${clause}${cursorClause}${importedRangeAndSql(rowsRange)}
          ORDER BY imported_at DESC LIMIT {limit:UInt32}${usingCursor ? '' : ' OFFSET {offset:UInt32}'}
          SETTINGS max_execution_time = 300,
                   timeout_overflow_mode = 'throw',
                   http_wait_end_of_query = 1`,
-        { ...params, ...cursorParams, limit, ...(usingCursor ? {} : { offset }) }
+        { ...params, ...cursorParams, ...rowsRange.params, limit, ...(usingCursor ? {} : { offset }) }
       ),
     ])
 
@@ -100,6 +116,7 @@ export async function GET(request: NextRequest) {
       pages: usingCursor ? null : Math.ceil((total ?? 0) / limit),
       next_cursor: nextCursor,
       query: q,
+      ...importedRangeEchoIfSet(importedRange),
     })
     return addRateLimitHeaders(response, authResult.rateLimit)
   } catch (error) {
```

`app/api/v1/search/domain/route.ts`:

```diff
diff --git a/app/api/v1/search/domain/route.ts b/app/api/v1/search/domain/route.ts
index 0778fca..63dbf7d 100644
--- a/app/api/v1/search/domain/route.ts
+++ b/app/api/v1/search/domain/route.ts
@@ -1,11 +1,13 @@
 /**
  * Search API v1 - Domain Search
  * GET /api/v1/search/domain?domain=example.com&page=1&limit=100
+ * Optional: &imported_after=<instant>&imported_before=<instant> (UTC; exclusive / inclusive), see lib/imported-range.ts.
  */
 
 import { NextRequest, NextResponse } from "next/server"
 import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
 import { executeQuery } from "@/lib/clickhouse"
+import { importedRangeFromSearchParams, importedRangeEchoIfSet, importedRangePlain, importedRangeAndSql } from "@/lib/imported-range"
 
 export const dynamic = 'force-dynamic'
 
@@ -27,25 +29,35 @@ export async function GET(request: NextRequest) {
     return NextResponse.json({ success: false, error: 'domain parameter is required' }, { status: 400 })
   }
 
+  // `domain = X` already narrows the read by the primary key, so the plain bound is all it needs (measured 2026-10-05: 18-175 ms for a
+  // popular domain with or without a predicate on the projection's key).
+  const parsedRange = importedRangeFromSearchParams(searchParams)
+  if (!parsedRange.ok) {
+    return addRateLimitHeaders(NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 }), authResult.rateLimit)
+  }
+  const importedRange = parsedRange.range
+  const rangeSql = importedRangePlain(importedRange)
+  const rangeAnd = importedRangeAndSql(rangeSql)
+
   try {
     // Raw domain column: all data-repair mutations done, bloom_filter index used.
     const [countResult, rows] = await Promise.all([
       executeQuery(
-        `SELECT count() as total FROM ulp.credentials WHERE domain = {domain:String}
+        `SELECT count() as total FROM ulp.credentials WHERE domain = {domain:String}${rangeAnd}
          SETTINGS optimize_trivial_count_query = 1, max_execution_time = 30, timeout_overflow_mode = 'break', use_query_cache = 0`,
-        { domain }
+        { domain, ...rangeSql.params }
       ),
       executeQuery(
         `SELECT url, email, password, domain, source_file, imported_at
-         FROM ulp.credentials WHERE domain = {domain:String}
+         FROM ulp.credentials WHERE domain = {domain:String}${rangeAnd}
          ORDER BY imported_at DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}
          SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1`,
-        { domain, limit, offset }
+        { domain, ...rangeSql.params, limit, offset }
       ),
     ])
 
     const total = Number(countResult[0]?.total || 0)
-    const response = NextResponse.json({ success: true, domain, results: rows, total, page, pages: Math.ceil(total / limit) })
+    const response = NextResponse.json({ success: true, domain, results: rows, total, page, pages: Math.ceil(total / limit), ...importedRangeEchoIfSet(importedRange) })
     return addRateLimitHeaders(response, authResult.rateLimit)
   } catch (error) {
     const msg = error instanceof Error ? error.message : String(error)
```

`app/api/v1/lookup/route.ts`:

```diff
diff --git a/app/api/v1/lookup/route.ts b/app/api/v1/lookup/route.ts
index 3c75e66..fc959ac 100644
--- a/app/api/v1/lookup/route.ts
+++ b/app/api/v1/lookup/route.ts
@@ -2,6 +2,7 @@
  * Quick Lookup API v1
  * GET /api/v1/lookup?email=john@example.com
  * GET /api/v1/lookup?domain=example.com
+ * Optional on both: &imported_after=<instant>&imported_before=<instant> (UTC; exclusive / inclusive), see lib/imported-range.ts.
  *
  * Performance: queries raw domain/email columns (indexed) instead of
  * NORM_*_EXPR wrappers.  All background data-repair mutations are done
@@ -11,6 +12,7 @@
 import { NextRequest, NextResponse } from "next/server"
 import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
 import { executeQuery } from "@/lib/clickhouse"
+import { importedRangeFromSearchParams, importedRangeEchoIfSet, importedRangePlain, importedRangeAndSql } from "@/lib/imported-range"
 
 export const dynamic = 'force-dynamic'
 
@@ -38,6 +40,15 @@ export async function GET(request: NextRequest) {
     return NextResponse.json({ success: false, error: 'Provide email or domain parameter' }, { status: 400 })
   }
 
+  // An exact email or domain is narrowed by the key and the bloom filter, so the plain bound is all it needs.
+  const parsedRange = importedRangeFromSearchParams(searchParams)
+  if (!parsedRange.ok) {
+    return addRateLimitHeaders(NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 }), authResult.rateLimit)
+  }
+  const importedRange = parsedRange.range
+  const rangeSql = importedRangePlain(importedRange)
+  const rangeAnd = importedRangeAndSql(rangeSql)
+
   try {
     let results: any[]
 
@@ -45,24 +56,24 @@ export async function GET(request: NextRequest) {
       results = await executeQuery(
         `SELECT url, email, domain, source_file, imported_at
          FROM ulp.credentials
-         WHERE email = {email:String}
+         WHERE email = {email:String}${rangeAnd}
          ORDER BY imported_at DESC LIMIT 100
          ${SETTINGS}`,
-        { email }
+        { email, ...rangeSql.params }
       )
-      const response = NextResponse.json({ success: true, found: results.length > 0, email, count: results.length, results })
+      const response = NextResponse.json({ success: true, found: results.length > 0, email, count: results.length, results, ...importedRangeEchoIfSet(importedRange) })
       return addRateLimitHeaders(response, authResult.rateLimit)
     }
 
     results = await executeQuery(
       `SELECT url, email, domain, source_file, imported_at
        FROM ulp.credentials
-       WHERE domain = {domain:String}
+       WHERE domain = {domain:String}${rangeAnd}
        ORDER BY imported_at DESC LIMIT 100
        ${SETTINGS}`,
-      { domain }
+      { domain, ...rangeSql.params }
     )
-    const response = NextResponse.json({ success: true, found: results.length > 0, domain, count: results.length, results })
+    const response = NextResponse.json({ success: true, found: results.length > 0, domain, count: results.length, results, ...importedRangeEchoIfSet(importedRange) })
     return addRateLimitHeaders(response, authResult.rateLimit)
   } catch (error) {
     const msg = error instanceof Error ? error.message : String(error)
```

`app/api/v1/lookup/batch/route.ts`:

```diff
diff --git a/app/api/v1/lookup/batch/route.ts b/app/api/v1/lookup/batch/route.ts
index a65e2b1..d1af2a6 100644
--- a/app/api/v1/lookup/batch/route.ts
+++ b/app/api/v1/lookup/batch/route.ts
@@ -6,7 +6,8 @@
  * Returns a result map keyed by the original query string.
  *
  * Body (JSON):
- *   { emails?: string[], domains?: string[] }
+ *   { emails?: string[], domains?: string[], imported_after?: string, imported_before?: string }
+ *   imported_after / imported_before (UTC; exclusive / inclusive; see lib/imported-range.ts) keep only rows imported in that window.
  *
  * Each email lookup: exact email match (bloom-filter accelerated)
  * Each domain lookup: exact domain match
@@ -18,6 +19,7 @@ import { NextRequest, NextResponse } from "next/server"
 import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
 import { executeQuery } from "@/lib/clickhouse"
 import { NORM_COLS, NORM_COLS_SETTING } from '@/lib/ulp-normalize'
+import { parseImportedRange, importedRangeEchoIfSet, importedRangePlain, importedRangeAndSql } from "@/lib/imported-range"
 
 export const dynamic = "force-dynamic"
 
@@ -53,13 +55,22 @@ export async function POST(request: NextRequest) {
 
   await logApiRequest(authResult.apiKey!, request, "v1/lookup/batch")
 
-  let body: { emails?: unknown; domains?: unknown }
+  let body: { emails?: unknown; domains?: unknown; imported_after?: unknown; imported_before?: unknown }
   try {
     body = await request.json()
   } catch {
     return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
   }
 
+  // An exact email or domain list is narrowed by the key and the bloom filter, so the plain bound is all it needs.
+  const parsedRange = parseImportedRange({ imported_after: body.imported_after, imported_before: body.imported_before })
+  if (!parsedRange.ok) {
+    return NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 })
+  }
+  const importedRange = parsedRange.range
+  const rangeSql = importedRangePlain(importedRange)
+  const rangeAnd = importedRangeAndSql(rangeSql)
+
   const emails  = Array.isArray(body.emails)  ? (body.emails  as unknown[]).filter(e => typeof e === "string" && e.trim()) as string[] : []
   const domains = Array.isArray(body.domains) ? (body.domains as unknown[]).filter(d => typeof d === "string" && d.trim()) as string[] : []
 
@@ -96,13 +107,13 @@ export async function POST(request: NextRequest) {
          FROM (
            SELECT ${RAW_COLS}
            FROM ulp.credentials
-           WHERE email IN (${emailList})
+           WHERE email IN (${emailList})${rangeAnd}
            ORDER BY email ASC, imported_at DESC
            LIMIT {cap:UInt32} BY email
          ) AS t
          ORDER BY t.email ASC, t.imported_at DESC
          ${SETTINGS}`,
-        { ...emailParams, cap: RESULTS_CAP }
+        { ...emailParams, ...rangeSql.params, cap: RESULTS_CAP }
       ) as Array<{ email: string; url: string; password: string; domain: string; source_file: string; breach_name: string; imported_at: string }>
 
       for (const email of emails) {
@@ -123,13 +134,13 @@ export async function POST(request: NextRequest) {
          FROM (
            SELECT ${RAW_COLS}
            FROM ulp.credentials
-           WHERE domain IN (${domainList})
+           WHERE domain IN (${domainList})${rangeAnd}
            ORDER BY domain ASC, imported_at DESC
            LIMIT {cap:UInt32} BY domain
          ) AS t
          ORDER BY t.domain ASC, t.imported_at DESC
          ${SETTINGS}`,
-        { ...domainParams, cap: RESULTS_CAP }
+        { ...domainParams, ...rangeSql.params, cap: RESULTS_CAP }
       ) as Array<{ email: string; url: string; password: string; domain: string; source_file: string; breach_name: string; imported_at: string }>
 
       for (const domain of domains) {
@@ -144,6 +155,7 @@ export async function POST(request: NextRequest) {
       queried: totalQueries,
       found:   Object.values(results).filter(r => r.found).length,
       results,
+      ...importedRangeEchoIfSet(importedRange),
     })
     return addRateLimitHeaders(response, authResult.rateLimit)
   } catch (error) {
```

`app/api/lookup/batch/route.ts`:

```diff
diff --git a/app/api/lookup/batch/route.ts b/app/api/lookup/batch/route.ts
index 22793c7..af2092d 100644
--- a/app/api/lookup/batch/route.ts
+++ b/app/api/lookup/batch/route.ts
@@ -6,13 +6,15 @@
  * Accepts up to 100 emails and/or domains, returns a results map keyed
  * by the original query string.
  *
- * Body: { emails?: string[], domains?: string[], mode?: "email"|"domain"|"both" }
+ * Body: { emails?: string[], domains?: string[], mode?: "email"|"domain"|"both", imported_after?: string, imported_before?: string }
+ *   imported_after / imported_before (UTC; exclusive / inclusive; see lib/imported-range.ts) keep only rows imported in that window.
  * Response: { success, queried, found, results: { [query]: { found, count, results[] } } }
  */
 
 import { NextRequest, NextResponse } from "next/server"
 import { validateRequest } from "@/lib/auth"
 import { executeQuery } from "@/lib/clickhouse"
+import { parseImportedRange, importedRangeEchoIfSet, importedRangePlain, importedRangeAndSql } from "@/lib/imported-range"
 export const dynamic = "force-dynamic"
 
 const MAX_QUERIES  = 100
@@ -30,13 +32,22 @@ export async function POST(request: NextRequest) {
     return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
   }
 
-  let body: { emails?: unknown; domains?: unknown }
+  let body: { emails?: unknown; domains?: unknown; imported_after?: unknown; imported_before?: unknown }
   try {
     body = await request.json()
   } catch {
     return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
   }
 
+  // An exact email or domain list is narrowed by the key and the bloom filter, so the plain bound is all it needs.
+  const parsedRange = parseImportedRange({ imported_after: body.imported_after, imported_before: body.imported_before })
+  if (!parsedRange.ok) {
+    return NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 })
+  }
+  const importedRange = parsedRange.range
+  const rangeSql = importedRangePlain(importedRange)
+  const rangeAnd = importedRangeAndSql(rangeSql)
+
   const emails  = Array.isArray(body.emails)
     ? (body.emails  as unknown[]).filter(e => typeof e === "string" && e.trim()) as string[]
     : []
@@ -76,11 +87,11 @@ export async function POST(request: NextRequest) {
       const rows = await executeQuery(
         `SELECT email, password, url, domain, source_file, breach_name, imported_at
          FROM ulp.credentials
-         WHERE email IN (${emailList})
+         WHERE email IN (${emailList})${rangeAnd}
          ORDER BY email ASC, imported_at DESC
          LIMIT {cap:UInt32} BY email
          ${SETTINGS}`,
-        { ...emailParams, cap: RESULTS_CAP }
+        { ...emailParams, ...rangeSql.params, cap: RESULTS_CAP }
       ) as Array<{
         email: string; password: string; url: string; domain: string
         source_file: string; breach_name: string; imported_at: string
@@ -104,11 +115,11 @@ export async function POST(request: NextRequest) {
       const rows = await executeQuery(
         `SELECT domain, email, password, url, source_file, breach_name, imported_at
          FROM ulp.credentials
-         WHERE domain IN (${domainList})
+         WHERE domain IN (${domainList})${rangeAnd}
          ORDER BY domain ASC, imported_at DESC
          LIMIT {cap:UInt32} BY domain
          ${SETTINGS}`,
-        { ...domainParams, cap: RESULTS_CAP }
+        { ...domainParams, ...rangeSql.params, cap: RESULTS_CAP }
       ) as Array<{
         domain: string; email: string; password: string; url: string
         source_file: string; breach_name: string; imported_at: string
@@ -126,6 +137,7 @@ export async function POST(request: NextRequest) {
       queried: totalQueries,
       found:   Object.values(results).filter(r => r.found).length,
       results,
+      ...importedRangeEchoIfSet(importedRange),
     })
   } catch (error) {
     const msg = error instanceof Error ? error.message : String(error)
```

- [x] **Step 4: Run the tests to see them pass**

Run: `npx vitest run __tests__/lookup-routes-imported-range.test.ts __tests__/v1-lookup-batch-route.test.ts __tests__/search-route-split.test.ts __tests__/v1-credentials-cursor-pagination.test.ts`
Expected: PASS, 59 tests in 4 files (24 + 13 + 14 + 8).

- [x] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . app/api/search app/api/v1 app/api/lookup __tests__/lookup-routes-imported-range.test.ts
git add app/api/search/route.ts app/api/v1/search/credentials/route.ts app/api/v1/search/domain/route.ts app/api/v1/lookup/route.ts app/api/v1/lookup/batch/route.ts app/api/lookup/batch/route.ts __tests__/lookup-routes-imported-range.test.ts
git commit -F - <<'EOF'
feat(api): imported_after / imported_before on v1 search, v1 domain, v1 lookup, both batch lookups and the legacy search

A client that polls with the previous response's imported_before as the next imported_after
only ever sees what arrived since, with no overlap and no gap. v1 search uses the projection
form for an index-neutral search (rows time-ordered, count an aggregate); the key-narrowed
lookups use the plain bound. Responses echo the effective window only when a bound was given.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: The browser helpers

Pure functions for the pages: local date-time inputs to UTC instants, the "since last export" memory and the rule that keeps its chain gap-free. No React, no `window`, so they are tested directly. (Do not import `lib/imported-range.ts` from a client component: it pulls in server-only code.)

**Files:**
- Create: `lib/imported-range-client.ts`
- Test: `__tests__/imported-range-client.test.ts`

**Interfaces:**
- Produces: `EXPORT_CUT_LAG_SECONDS = 120`; `epochSecondsToIso(epoch)`; `localInputToUtcIso(value, offsetMinutes): string | null` (`offsetMinutes` is `new Date(value).getTimezoneOffset()`, 300 for UTC-5); `utcEpochToLocalInput(epochSeconds, offsetMinutes): string`; `utcIsoToDisplay(iso)`; `searchFingerprint(fields): string`; `interface ExportMark { through: number; rows: number; at: number }`; `markStorageKey(fingerprint)`; `readMark(storage, key): ExportMark | null`; `writeMark(storage, key, mark)` (both swallow storage errors); `sinceLastExportWindow(mark, nowMs): { ok: true; after: string; before: string } | { ok: false; reason: 'no-mark' | 'too-soon' }`; `markAfterExport(prev, sent: { lower, upper }, outcome: { truncated, rows }, nowMs): ExportMark | null`; `IMPORTED_PRESETS` (`last-24h`, `last-7d`).

- [x] **Step 1: Write the tests**

Create `__tests__/imported-range-client.test.ts` with exactly this content:

```ts
import { describe, test, expect } from 'vitest'
import {
  EXPORT_CUT_LAG_SECONDS, epochSecondsToIso, localInputToUtcIso, utcEpochToLocalInput, utcIsoToDisplay,
  searchFingerprint, readMark, writeMark, markStorageKey, sinceLastExportWindow, markAfterExport, IMPORTED_PRESETS,
  type ExportMark,
} from '@/lib/imported-range-client'

const T = Date.UTC(2026, 9, 5, 19, 37, 0) / 1000 // 2026-10-05T19:37:00Z
const NOW_MS = (T + 3600) * 1000

describe('local date-time input <-> UTC instant', () => {
  test('UTC-5 (offset 300): 14:37 local is 19:37 UTC', () => {
    expect(localInputToUtcIso('2026-10-05T14:37', 300)).toBe('2026-10-05T19:37:00Z')
    expect(localInputToUtcIso('2026-10-05T14:37:15', 300)).toBe('2026-10-05T19:37:15Z')
  })

  test('UTC+2 (offset -120) and UTC (offset 0)', () => {
    expect(localInputToUtcIso('2026-10-05T21:37', -120)).toBe('2026-10-05T19:37:00Z')
    expect(localInputToUtcIso('2026-10-05T19:37', 0)).toBe('2026-10-05T19:37:00Z')
  })

  test('crossing midnight in either direction', () => {
    expect(localInputToUtcIso('2026-10-05T22:30', 300)).toBe('2026-10-06T03:30:00Z')
    expect(localInputToUtcIso('2026-10-06T01:30', -120)).toBe('2026-10-05T23:30:00Z')
  })

  test.each(['', 'x', '2026-10-05', '2026-10-05T14', '2026-02-30T10:00', '2026-10-05T24:00', '2026-10-05T14:60', '2026-10-05T14:37:60'])(
    'an empty or impossible value is null: %j', value => {
      expect(localInputToUtcIso(value, 300)).toBeNull()
    },
  )

  test('the reverse conversion fills an input in local time', () => {
    expect(utcEpochToLocalInput(T, 300)).toBe('2026-10-05T14:37:00')
    expect(utcEpochToLocalInput(T, -120)).toBe('2026-10-05T21:37:00')
  })

  test('the two directions round-trip', () => {
    for (const offset of [300, 0, -120, -330]) {
      const local = utcEpochToLocalInput(T, offset)
      expect(localInputToUtcIso(local, offset)).toBe(epochSecondsToIso(T))
    }
  })

  test('the UTC echo shown beside an input', () => {
    expect(utcIsoToDisplay('2026-10-05T19:37:00Z')).toBe('2026-10-05 19:37:00 UTC')
  })
})

describe('searchFingerprint — the same search gets the same key, whatever the date, sort or order of the fields', () => {
  test('is stable and ignores empty values', () => {
    const a = searchFingerprint({ q: 'term', domain: '', tierInclude: [], dedupe: true, excludeNoise: false })
    const b = searchFingerprint({ excludeNoise: false, dedupe: true, tierInclude: [], domain: '', q: 'term', unused: undefined })
    expect(a).toBe(b)
  })

  test('differs when any narrowing field differs', () => {
    const base = { q: 'term', domain: '', tierInclude: ['T1'] }
    expect(searchFingerprint(base)).not.toBe(searchFingerprint({ ...base, q: 'term2' }))
    expect(searchFingerprint(base)).not.toBe(searchFingerprint({ ...base, tierInclude: ['T2'] }))
    expect(searchFingerprint(base)).not.toBe(searchFingerprint({ ...base, domain: 'x.example' }))
  })

  test('a list and a string of the same text are the same field value', () => {
    expect(searchFingerprint({ tiers: ['T1', 'T2'] })).toBe(searchFingerprint({ tiers: 'T1,T2' }))
  })

  test('is safe as a storage key suffix', () => {
    expect(markStorageKey(searchFingerprint({ q: 'a b&c=d' }))).toMatch(/^ulp:last-export:[0-9a-z]+-[0-9a-z]+$/)
  })
})

describe('the remembered mark survives only when it is well formed', () => {
  const mark: ExportMark = { through: T, rows: 12, at: 1 }

  test('round trip', () => {
    const store = new Map<string, string>()
    writeMark({ setItem: (k, v) => void store.set(k, v) }, 'k', mark)
    expect(readMark({ getItem: k => store.get(k) ?? null }, 'k')).toEqual(mark)
  })

  test.each([[null], [undefined]])('no storage at all reads as nothing remembered: %s', storage => {
    expect(readMark(storage, 'k')).toBeNull()
    expect(() => writeMark(storage, 'k', mark)).not.toThrow()
  })

  test('junk, a missing field, a wrong type and a throwing storage all read as nothing remembered', () => {
    const read = (raw: string | null) => readMark({ getItem: () => raw }, 'k')
    expect(read(null)).toBeNull()
    expect(read('')).toBeNull()
    expect(read('not json')).toBeNull()
    expect(read('{"through":"x","rows":1,"at":1}')).toBeNull()
    expect(read('{"through":1}')).toBeNull()
    expect(readMark({ getItem: () => { throw new Error('blocked') } }, 'k')).toBeNull()
  })

  test('a throwing setItem (quota, private window) is swallowed', () => {
    expect(() => writeMark({ setItem: () => { throw new Error('quota') } }, 'k', mark)).not.toThrow()
  })
})

describe('sinceLastExportWindow — (remembered cut, now minus the lag]', () => {
  const mark: ExportMark = { through: T, rows: 5, at: 1 }

  test('nothing remembered', () => {
    expect(sinceLastExportWindow(null, NOW_MS)).toEqual({ ok: false, reason: 'no-mark' })
  })

  test('starts exactly at the remembered cut and ends the lag before now', () => {
    expect(sinceLastExportWindow(mark, NOW_MS)).toEqual({
      ok: true,
      after: epochSecondsToIso(T),
      before: epochSecondsToIso(T + 3600 - EXPORT_CUT_LAG_SECONDS),
    })
  })

  test('asked again inside the lag, the window would be empty or backwards: too soon', () => {
    expect(sinceLastExportWindow(mark, (T + EXPORT_CUT_LAG_SECONDS) * 1000)).toEqual({ ok: false, reason: 'too-soon' })
    expect(sinceLastExportWindow(mark, (T + 10) * 1000)).toEqual({ ok: false, reason: 'too-soon' })
  })
})

describe('markAfterExport — the chain has no gaps', () => {
  const prev: ExportMark = { through: T, rows: 5, at: 1 }
  const complete = { truncated: false, rows: 40 }
  const latestSafe = Math.floor(NOW_MS / 1000) - EXPORT_CUT_LAG_SECONDS

  test('a truncated export never moves the mark', () => {
    expect(markAfterExport(prev, { lower: T, upper: T + 600 }, { truncated: true, rows: 10_000 }, NOW_MS)).toBeNull()
    expect(markAfterExport(null, { lower: null, upper: null }, { truncated: true, rows: 10_000 }, NOW_MS)).toBeNull()
  })

  test('the first export (no lower bound, nothing remembered) records the cut: now minus the lag when no upper bound was sent', () => {
    expect(markAfterExport(null, { lower: null, upper: null }, complete, NOW_MS)).toEqual({ through: latestSafe, rows: 40, at: NOW_MS })
  })

  test('a full export (no lower bound) records its cut even when a mark exists', () => {
    expect(markAfterExport(prev, { lower: null, upper: null }, complete, NOW_MS)?.through).toBe(latestSafe)
  })

  test('the preset export (lower bound equal to the remembered cut) moves the mark to its upper bound', () => {
    expect(markAfterExport(prev, { lower: T, upper: T + 600 }, complete, NOW_MS)).toEqual({ through: T + 600, rows: 40, at: NOW_MS })
  })

  test('a hand-typed lower bound that is not the remembered cut leaves the mark alone', () => {
    expect(markAfterExport(prev, { lower: T + 5, upper: T + 600 }, complete, NOW_MS)).toBeNull()
    expect(markAfterExport(prev, { lower: T - 5, upper: T + 600 }, complete, NOW_MS)).toBeNull()
    expect(markAfterExport(null, { lower: T, upper: T + 600 }, complete, NOW_MS)).toBeNull()
  })

  test('an upper bound in the future, or inside the lag, is clamped to now minus the lag', () => {
    expect(markAfterExport(prev, { lower: T, upper: T + 999_999 }, complete, NOW_MS)?.through).toBe(latestSafe)
    expect(markAfterExport(prev, { lower: T, upper: latestSafe + 30 }, complete, NOW_MS)?.through).toBe(latestSafe)
  })

  test('the mark never moves backwards', () => {
    expect(markAfterExport(prev, { lower: null, upper: T - 1000 }, complete, NOW_MS)).toBeNull()
    expect(markAfterExport(prev, { lower: T, upper: T }, complete, NOW_MS)?.through).toBe(T) // an empty window leaves it where it was
  })
})

describe('presets', () => {
  test('the lower-bound presets, in seconds before now', () => {
    expect(IMPORTED_PRESETS.map(p => [p.key, p.seconds])).toEqual([['last-24h', 86_400], ['last-7d', 604_800]])
  })
})
```

- [x] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/imported-range-client.test.ts`
Expected: FAIL: `Failed to resolve import "@/lib/imported-range-client"`.

- [x] **Step 3: Implement**

Create `lib/imported-range-client.ts` with exactly this content:

```ts
/**
 * Browser-side helpers for the imported-after filter. Pure (no React, no `window`), so they are tested directly.
 *
 *  - date-time inputs <-> the UTC instants the API takes (the server reads every bound as UTC; the operator thinks in local time);
 *  - the "since last export" memory and the chain rule that keeps it gap-free.
 *
 * Design: docs/superpowers/specs/2026-10-05-imported-after-filter-design.md ("UI", "Since last export").
 */

/**
 * Rows are stamped with `now()` when their insert block starts being processed and become visible when it commits (p95 3.6 s per 100k-row
 * block), so a cut taken "now" can fall inside a block that is still landing. Cutting this far back makes that impossible in practice.
 */
export const EXPORT_CUT_LAG_SECONDS = 120

const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/** `2026-10-05T19:37:00Z` for epoch seconds. */
export function epochSecondsToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace('.000Z', 'Z')
}

/**
 * An `<input type="datetime-local">` value ("2026-10-05T14:37", seconds optional), read as the browser's local time, as a UTC ISO instant.
 * `offsetMinutes` is `new Date(value).getTimezoneOffset()` at that moment (minutes the local clock is BEHIND UTC; 300 for UTC-5), passed in
 * so this stays pure and testable. null for an empty or impossible value.
 */
export function localInputToUtcIso(value: string, offsetMinutes: number): string | null {
  const m = LOCAL_INPUT_RE.exec(value.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]]
  const s = m[6] === undefined ? 0 : +m[6]
  if (h > 23 || mi > 59 || s > 59) return null
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(asUtc)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return epochSecondsToIso(Math.floor(asUtc / 1000) + offsetMinutes * 60)
}

/** The reverse, for presets that set an input: epoch seconds as a `datetime-local` value in local time ("2026-10-05T14:37:00"). */
export function utcEpochToLocalInput(epochSeconds: number, offsetMinutes: number): string {
  return new Date((epochSeconds - offsetMinutes * 60) * 1000).toISOString().slice(0, 19)
}

/** `2026-10-05T19:37:00Z` -> `2026-10-05 19:37:00 UTC`, shown beside an input so the operator sees what the server will use. */
export function utcIsoToDisplay(iso: string): string {
  return iso.replace('T', ' ').replace('Z', ' UTC')
}

/** A short stable key for "the same search": every field that narrows the rows, none of date, sort, format or page size. */
export function searchFingerprint(fields: Record<string, string | number | boolean | string[] | null | undefined>): string {
  const parts = Object.keys(fields)
    .sort()
    .map(k => [k, fields[k]] as const)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
  const text = parts.join('&')
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  return `${hash.toString(36)}-${text.length.toString(36)}`
}

/** What the page remembers about the last complete export of one search. `through` is epoch seconds, the INCLUSIVE upper bound it covered. */
export interface ExportMark {
  through: number
  rows: number
  /** epoch milliseconds when it was recorded */
  at: number
}

export const markStorageKey = (fingerprint: string) => `ulp:last-export:${fingerprint}`

type ReadableStorage = { getItem(key: string): string | null }
type WritableStorage = { setItem(key: string, value: string): void }

/** Storage can be missing, blocked or hold junk (private windows, cleared site data): every failure is "nothing remembered". */
export function readMark(storage: ReadableStorage | null | undefined, key: string): ExportMark | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<ExportMark>
    if (typeof v.through !== 'number' || !Number.isFinite(v.through) || typeof v.rows !== 'number' || typeof v.at !== 'number') return null
    return { through: v.through, rows: v.rows, at: v.at }
  } catch {
    return null
  }
}

export function writeMark(storage: WritableStorage | null | undefined, key: string, mark: ExportMark): void {
  try {
    storage?.setItem(key, JSON.stringify(mark))
  } catch {
    // The memory is a convenience: the file name of the export still records its window.
  }
}

export type SinceLastExport =
  | { ok: true; after: string; before: string }
  | { ok: false; reason: 'no-mark' | 'too-soon' }

/** The window a "Since last export" export sends: (the remembered cut, now minus the lag]. */
export function sinceLastExportWindow(mark: ExportMark | null, nowMs: number): SinceLastExport {
  if (!mark) return { ok: false, reason: 'no-mark' }
  const before = Math.floor(nowMs / 1000) - EXPORT_CUT_LAG_SECONDS
  if (before <= mark.through) return { ok: false, reason: 'too-soon' }
  return { ok: true, after: epochSecondsToIso(mark.through), before: epochSecondsToIso(before) }
}

/**
 * What to remember after an export that came back OK, or null to leave the stored mark alone. `sent` is the window the request carried
 * (epoch seconds, null = open). The chain stays gap-free because a mark is only written when:
 *  - the export was complete (a truncated one hides rows between its last row and its upper bound), and
 *  - it started at the beginning (no lower bound: it covered everything up to its cut) or exactly at the previous cut, and
 *  - the new cut does not move backwards.
 * The cut is the explicit upper bound, but never later than now minus the lag (a future or very recent bound would otherwise skip rows
 * that are still landing). A hand-typed range that starts somewhere else never moves the mark.
 */
export function markAfterExport(
  prev: ExportMark | null,
  sent: { lower: number | null; upper: number | null },
  outcome: { truncated: boolean; rows: number },
  nowMs: number,
): ExportMark | null {
  if (outcome.truncated) return null
  const chains = sent.lower === null || (prev !== null && sent.lower === prev.through)
  if (!chains) return null
  const latestSafe = Math.floor(nowMs / 1000) - EXPORT_CUT_LAG_SECONDS
  const through = sent.upper === null ? latestSafe : Math.min(sent.upper, latestSafe)
  if (prev !== null && through < prev.through) return null
  return { through, rows: outcome.rows, at: nowMs }
}

/** Presets for the lower bound, as seconds before now. */
export const IMPORTED_PRESETS = [
  { key: 'last-24h', label: 'Last 24 h', seconds: 24 * 3600 },
  { key: 'last-7d', label: 'Last 7 days', seconds: 7 * 24 * 3600 },
] as const
```

- [x] **Step 4: Run the tests to see them pass**

Run: `npx vitest run __tests__/imported-range-client.test.ts`
Expected: PASS, 34 tests.

- [x] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . lib/imported-range-client.ts __tests__/imported-range-client.test.ts
git add lib/imported-range-client.ts __tests__/imported-range-client.test.ts
git commit -F - <<'EOF'
feat(imported-range): browser helpers - local time to UTC, the since-last-export memory and its chain rule

The server reads every bound as UTC; the operator thinks in local time. The since-last-export
cut is only ever written after a complete export that started at the beginning or exactly at the
previous cut, is never later than now minus 120 s (rows are stamped a few seconds before they
become visible) and never moves backwards, so a truncated, hand-typed or racing export cannot
skip rows.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: The Credentials page

Replace the two date-only pickers with date-time inputs in local time (the UTC instant shown under each), add presets and "Since last export", switch a non-time sort to Newest first when a lower bound is set, send the new parameters on the browse request and the export, and tell the operator when the 10,000-row cap cut an export.

**Files:**
- Modify: `app/credentials/page.tsx`
- Test: `__tests__/imported-range-credentials-page.test.ts` (source-level guard, the repo's pattern for pages)

**Interfaces:**
- Consumes: everything from Task 7; the `imported_after` / `imported_before` parameters of Task 4 and Task 5; the `X-Export-Truncated` / `X-Export-Rows` headers of Task 5.
- Produces: state `importedAfter` / `importedBefore` (`datetime-local` values), `exportMark`; helper `localToUtcIso`; the "Imported after" / "Imported before" inputs, the presets row and the since-last-export button in the Advanced Filters panel.

- [x] **Step 1: Write the guard tests**

Create `__tests__/imported-range-credentials-page.test.ts` with exactly this content:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Credentials page — the imported window', () => {
  const src = read('app/credentials/page.tsx')
  const buildParams = src.slice(src.indexOf('const buildParams'), src.indexOf('const loadAbortRef'))
  const doExport = src.slice(src.indexOf('const doExport'), src.indexOf('const hasBasicFilters'))

  test('the slices under test were found', () => {
    expect(buildParams.length).toBeGreaterThan(200)
    expect(doExport.length).toBeGreaterThan(500)
  })

  test('the filter is a pair of local date-time inputs, not date-only pickers', () => {
    expect(src).toContain('type="datetime-local"')
    expect(src).toContain('Imported after')
    expect(src).toContain('Imported before')
    expect(src).not.toContain('From date')
    expect(src).not.toContain('type="date"')
  })

  test('local time is converted to a UTC instant before it is sent: the browse request and the export carry imported_after / imported_before', () => {
    expect(src).toContain('localInputToUtcIso(value, new Date(value).getTimezoneOffset())')
    expect(buildParams).toContain("ps.set('imported_after', afterIso)")
    expect(buildParams).toContain("ps.set('imported_before', beforeIso)")
    expect(doExport).toContain("imported_after:  afterIso ?? ''")
    expect(doExport).toContain("imported_before: beforeIso ?? ''")
    expect(src).not.toContain("ps.set('date_from'")
    expect(src).not.toContain('date_from:')
  })

  test('an export reads the truncation header, tells the operator, and only then moves the since-last-export mark', () => {
    expect(doExport).toContain("res.headers.get('X-Export-Truncated') === '1'")
    expect(doExport).toContain('markAfterExport(')
    expect(doExport).toContain('writeMark(browserStorage(), markKey, next)')
    expect(doExport).toContain('Export stopped at 10,000 rows')
  })

  test('the since-last-export memory is keyed by the search, not by dates, sort or format', () => {
    const fingerprint = src.slice(src.indexOf('const markKey'), src.indexOf('useEffect(() => { setExportMark'))
    expect(fingerprint).toContain('searchFingerprint({')
    for (const field of ['q', 'domain', 'breach', 'tierInclude', 'excludeNoise', 'dedupe']) expect(fingerprint).toContain(field)
    for (const field of ['importedAfter', 'importedBefore', 'sortKey', 'exportFmt', 'limit']) expect(fingerprint).not.toContain(field)
  })

  test('setting a lower bound switches a non-time sort to Newest first (the plan with the fast path)', () => {
    expect(src).toContain("if (sortKey !== 'imported_desc' && sortKey !== 'imported_asc') setSortKey('imported_desc')")
  })

  test('the detail view labels imported_at as UTC, so the number matches what the filter takes', () => {
    expect(src).toContain('{cred.imported_at} UTC')
  })

  test('the operator is told what "added" means', () => {
    expect(src).toContain('a credential imported again later counts as added')
  })
})
```

- [x] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/imported-range-credentials-page.test.ts`
Expected: FAIL (the page still has "From date" / `type="date"` and sends `date_from`).

- [x] **Step 3: Implement**

Apply this diff to `app/credentials/page.tsx`:

```diff
diff --git a/app/credentials/page.tsx b/app/credentials/page.tsx
index febc41c..5e01804 100644
--- a/app/credentials/page.tsx
+++ b/app/credentials/page.tsx
@@ -27,6 +27,10 @@ import {
 } from "@/lib/credential-browse-defaults"
 import type { SortKey } from "@/lib/cursor-pagination"
 import { parseTotals, recordsLabel, resultsLabel, totalsParams, withPendingTotals, withTotals } from "@/lib/credential-totals"
+import {
+  IMPORTED_PRESETS, epochSecondsToIso, localInputToUtcIso, utcEpochToLocalInput, utcIsoToDisplay,
+  searchFingerprint, readMark, writeMark, markStorageKey, sinceLastExportWindow, markAfterExport, type ExportMark,
+} from "@/lib/imported-range-client"
 
 // ─── Types ────────────────────────────────────────────────────────────────────
 
@@ -127,6 +131,14 @@ const EXPORT_FORMATS = [
 
 const PAGE_SIZES = [25, 50, 100, 200]
 
+/** A datetime-local value (the browser's local time) as the UTC instant the API takes; null when empty or not a real time. */
+const localToUtcIso = (value: string): string | null => (value ? localInputToUtcIso(value, new Date(value).getTimezoneOffset()) : null)
+
+/** localStorage can be blocked (private windows, site data cleared): the "since last export" memory is a convenience, so null is fine. */
+const browserStorage = (): Storage | null => {
+  try { return window.localStorage } catch { return null }
+}
+
 // ─── CopyButton ───────────────────────────────────────────────────────────────
 
 function CopyButton({ text, label }: { text: string; label?: string }) {
@@ -472,7 +484,7 @@ function CredentialDetailSheet({
                 <Clock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                 <div className="flex-1 min-w-0">
                   <p className="text-xs text-muted-foreground">Imported</p>
-                  <p className="text-xs font-mono">{cred.imported_at}</p>
+                  <p className="text-xs font-mono">{cred.imported_at} UTC</p>
                 </div>
               </div>
             )}
@@ -662,8 +674,11 @@ export default function CredentialsPage() {
 
   // Advanced filters (hidden behind toggle)
   const [advOpen, setAdvOpen]               = useState(false)
-  const [dateFrom, setDateFrom]             = useState('')
-  const [dateTo, setDateTo]                 = useState('')
+  // Imported window: <input type="datetime-local"> values in the browser's LOCAL time; the API takes UTC instants (localToUtcIso).
+  const [importedAfter, setImportedAfter]   = useState('')
+  const [importedBefore, setImportedBefore] = useState('')
+  // The cut of the last complete export of THIS search, kept in the browser (lib/imported-range-client.ts).
+  const [exportMark, setExportMark]         = useState<ExportMark | null>(null)
   const [pwLenMin, setPwLenMin]             = useState('')
   const [pwLenMax, setPwLenMax]             = useState('')
   const [emailDomainFilter, setEmailDomainFilter] = useState('')
@@ -699,8 +714,10 @@ export default function CredentialsPage() {
     if (effectiveExcludeNoise) ps.set('exclude_noise', '1')
     if (effectiveDedupe)       ps.set('dedupe', '1')
     // Advanced
-    if (dateFrom)           ps.set('date_from', dateFrom)
-    if (dateTo)             ps.set('date_to', dateTo)
+    const afterIso  = localToUtcIso(importedAfter)
+    const beforeIso = localToUtcIso(importedBefore)
+    if (afterIso)           ps.set('imported_after', afterIso)
+    if (beforeIso)          ps.set('imported_before', beforeIso)
     if (pwLenMin)           ps.set('pw_len_min', pwLenMin)
     if (pwLenMax)           ps.set('pw_len_max', pwLenMax)
     if (emailDomainFilter)  ps.set('email_domain', emailDomainFilter)
@@ -710,7 +727,7 @@ export default function CredentialsPage() {
     return ps
   }, [
     q, domain, breach, loginType, pwMask, isCorporate, urlScheme, tierInclude, tierExclude, excludeNoise, dedupe,
-    dateFrom, dateTo, pwLenMin, pwLenMax, emailDomainFilter, sourceFileFilter, urlHostFilter, regexMode,
+    importedAfter, importedBefore, pwLenMin, pwLenMax, emailDomainFilter, sourceFileFilter, urlHostFilter, regexMode,
     sortKey, limit,
   ])
 
@@ -784,7 +801,7 @@ export default function CredentialsPage() {
   const clearAll = () => {
     setQ(''); setDomain(''); setBreach(''); setLoginType(''); setPwMask([])
     setIsCorporate(false); setUrlScheme(''); setTierInclude([]); setTierExclude([])
-    setDateFrom(''); setDateTo(''); setPwLenMin(''); setPwLenMax('')
+    setImportedAfter(''); setImportedBefore(''); setPwLenMin(''); setPwLenMax('')
     setEmailDomainFilter(''); setSourceFileFilter(''); setUrlHostFilter('')
     setRegexMode(false)
     setExcludeNoise(true)
@@ -845,9 +862,48 @@ export default function CredentialsPage() {
     return <ArrowUpDown className="h-3.5 w-3.5 ml-0.5 shrink-0 opacity-20 group-hover/th:opacity-60 transition-opacity" />
   }
 
+  // "The same search" for the since-last-export memory: every field that narrows the rows, none of date, sort, format or page size.
+  const markKey = markStorageKey(searchFingerprint({
+    q, domain, breach, loginType, pwMask, isCorporate, urlScheme, tierInclude, tierExclude, pwLenMin, pwLenMax,
+    emailDomainFilter, sourceFileFilter, urlHostFilter, regexMode, excludeNoise, dedupe,
+  }))
+  useEffect(() => { setExportMark(readMark(browserStorage(), markKey)) }, [markKey])
+
+  const importedAfterIso  = localToUtcIso(importedAfter)
+  const importedBeforeIso = localToUtcIso(importedBefore)
+
+  /** A lower bound makes the time-ordered plan the right one (the fast path), so switch to Newest first unless a time sort is already on. */
+  const ensureTimeSort = () => { if (sortKey !== 'imported_desc' && sortKey !== 'imported_asc') setSortKey('imported_desc') }
+
+  /** "Last 24 h" / "Last 7 days": fills the lower bound with now minus that many seconds. Press Search to apply. */
+  const applyPreset = (seconds: number) => {
+    const epoch = Math.floor(Date.now() / 1000) - seconds
+    setImportedAfter(utcEpochToLocalInput(epoch, new Date(epoch * 1000).getTimezoneOffset()))
+    setImportedBefore('')
+    ensureTimeSort()
+  }
+
+  /** Fills the window with (the last complete export's cut, now minus the lag]. Press Export (or Search) to use it. */
+  const fillSinceLastExport = () => {
+    const w = sinceLastExportWindow(exportMark, Date.now())
+    if (!w.ok) {
+      toast(w.reason === 'no-mark'
+        ? { title: 'No earlier export of this search is remembered yet', description: 'Run an export first; the next one can then start where it ended.' }
+        : { title: 'Exported moments ago', description: 'Give it a couple of minutes: rows are stamped a little before they become visible.' })
+      return
+    }
+    const after = Date.parse(w.after) / 1000
+    const before = Date.parse(w.before) / 1000
+    setImportedAfter(utcEpochToLocalInput(after, new Date(after * 1000).getTimezoneOffset()))
+    setImportedBefore(utcEpochToLocalInput(before, new Date(before * 1000).getTimezoneOffset()))
+    ensureTimeSort()
+  }
+
   const doExport = useCallback(async () => {
     setExportLoading(true)
     try {
+      const afterIso  = localToUtcIso(importedAfter)
+      const beforeIso = localToUtcIso(importedBefore)
       const res = await fetch('/api/export', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
@@ -863,8 +919,8 @@ export default function CredentialsPage() {
           url_scheme:    urlScheme,
           is_corporate:  isCorporate ? '1' : '',
           sort:          sortKey,
-          date_from:     dateFrom,
-          date_to:       dateTo,
+          imported_after:  afterIso ?? '',
+          imported_before: beforeIso ?? '',
           pw_len_min:    pwLenMin !== '' ? parseInt(pwLenMin, 10) : null,
           pw_len_max:    pwLenMax !== '' ? parseInt(pwLenMax, 10) : null,
           email_domain:  emailDomainFilter,
@@ -887,14 +943,35 @@ export default function CredentialsPage() {
       a.click()
       document.body.removeChild(a)
       URL.revokeObjectURL(url)
-      toast({ title: 'Export started' })
+
+      // Remember how far this search has been exported, but only when that keeps the chain gap-free (markAfterExport), and say so when the
+      // 10,000-row cap cut the file: the rows between its last row and the window's end are not in it.
+      const truncated = res.headers.get('X-Export-Truncated') === '1'
+      const rows = Number(res.headers.get('X-Export-Rows') ?? 0) || 0
+      const next = markAfterExport(
+        exportMark,
+        { lower: afterIso ? Date.parse(afterIso) / 1000 : null, upper: beforeIso ? Date.parse(beforeIso) / 1000 : null },
+        { truncated, rows },
+        Date.now(),
+      )
+      if (next) { writeMark(browserStorage(), markKey, next); setExportMark(next) }
+      if (truncated) {
+        toast({
+          title: 'Export stopped at 10,000 rows',
+          description: 'Narrow the imported window (or the search) to get the rest. "Since last export" was not moved.',
+          variant: 'destructive',
+        })
+      } else {
+        toast({ title: 'Export started' })
+      }
     } catch {
       toast({ title: 'Export failed', variant: 'destructive' })
     } finally {
       setExportLoading(false)
     }
   }, [q, domain, breach, tierInclude, tierExclude, loginType, pwMask, urlScheme, isCorporate, sortKey, exportFmt,
-      dateFrom, dateTo, pwLenMin, pwLenMax, emailDomainFilter, sourceFileFilter, urlHostFilter, regexMode, excludeNoise, dedupe,
+      importedAfter, importedBefore, exportMark, markKey,
+      pwLenMin, pwLenMax, emailDomainFilter, sourceFileFilter, urlHostFilter, regexMode, excludeNoise, dedupe,
       toast])
 
   const tierBadgeClass = (t: string) =>
@@ -903,11 +980,12 @@ export default function CredentialsPage() {
     t === 'T3' ? 'bg-amber-500/10 text-amber-600 border-amber-500/20' : ''
 
   const hasBasicFilters = !!(q || domain || breach || loginType || pwMask.length || isCorporate || urlScheme || tierInclude.length || tierExclude.length)
-  const hasAdvFilters   = !!(dateFrom || dateTo || pwLenMin || pwLenMax || emailDomainFilter || sourceFileFilter || urlHostFilter || regexMode)
+  const hasAdvFilters   = !!(importedAfter || importedBefore || pwLenMin || pwLenMax || emailDomainFilter || sourceFileFilter || urlHostFilter || regexMode)
   const hasFilters      = hasBasicFilters || hasAdvFilters
 
   const selectCls = "h-8 text-xs border border-border rounded-md bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
   const advInputCls = "h-7 text-xs font-mono"
+  const presetCls   = "rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
 
   return (
     <div className="flex h-full flex-col">
@@ -1225,24 +1303,30 @@ export default function CredentialsPage() {
             </p>
 
             <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
-              {/* Date range */}
+              {/* Imported window: your local time here, UTC on the server (shown under each field) */}
               <div className="space-y-1">
-                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">From date</label>
+                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Imported after</label>
                 <Input
-                  type="date"
-                  value={dateFrom}
-                  onChange={e => setDateFrom(e.target.value)}
+                  type="datetime-local"
+                  step={1}
+                  value={importedAfter}
+                  onChange={e => { setImportedAfter(e.target.value); if (e.target.value) ensureTimeSort() }}
+                  onKeyDown={e => e.key === 'Enter' && applyFilters()}
                   className={advInputCls}
                 />
+                {importedAfterIso && <p className="text-[10px] font-mono text-muted-foreground">= {utcIsoToDisplay(importedAfterIso)}</p>}
               </div>
               <div className="space-y-1">
-                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">To date</label>
+                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Imported before</label>
                 <Input
-                  type="date"
-                  value={dateTo}
-                  onChange={e => setDateTo(e.target.value)}
+                  type="datetime-local"
+                  step={1}
+                  value={importedBefore}
+                  onChange={e => setImportedBefore(e.target.value)}
+                  onKeyDown={e => e.key === 'Enter' && applyFilters()}
                   className={advInputCls}
                 />
+                {importedBeforeIso && <p className="text-[10px] font-mono text-muted-foreground">= {utcIsoToDisplay(importedBeforeIso)}</p>}
               </div>
 
               {/* Password length range */}
@@ -1272,6 +1356,37 @@ export default function CredentialsPage() {
               </div>
             </div>
 
+            {/* Imported presets and the since-last-export memory */}
+            <div className="space-y-1.5">
+              <div className="flex flex-wrap items-center gap-2">
+                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Imported</span>
+                {IMPORTED_PRESETS.map(p => (
+                  <button key={p.key} onClick={() => applyPreset(p.seconds)} className={presetCls}>{p.label}</button>
+                ))}
+                <button onClick={fillSinceLastExport} className={presetCls} title="Start where the last complete export of this search ended">
+                  Since last export
+                </button>
+                {(importedAfter || importedBefore) && (
+                  <button
+                    onClick={() => { setImportedAfter(''); setImportedBefore('') }}
+                    className="text-[10px] text-muted-foreground underline hover:text-foreground"
+                  >
+                    clear
+                  </button>
+                )}
+                {exportMark && (
+                  <span className="text-[10px] text-muted-foreground">
+                    last export of this search ended {utcIsoToDisplay(epochSecondsToIso(exportMark.through))}
+                    {exportMark.rows ? ` · ${exportMark.rows.toLocaleString()} rows` : ''}
+                  </span>
+                )}
+              </div>
+              <p className="text-[10px] text-muted-foreground">
+                Matches rows added to the database after this time; a credential imported again later counts as added. These fields are your
+                local time; the server works in UTC (shown under each field).
+              </p>
+            </div>
+
             <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
               {/* Email domain */}
               <div className="space-y-1">
```

- [x] **Step 4: Run the tests to see them pass**

Run: `npx vitest run __tests__/imported-range-credentials-page.test.ts`
Expected: PASS, 8 tests.

- [x] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . app/credentials/page.tsx __tests__/imported-range-credentials-page.test.ts
git add app/credentials/page.tsx __tests__/imported-range-credentials-page.test.ts
git commit -F - <<'EOF'
feat(credentials-ui): imported-after / imported-before inputs, presets, since-last-export and an honest export toast

The date-only pickers meant 00:00 UTC (the evening before, for an operator west of UTC) and
could not say "after 2:37 pm". The inputs are now local date-time with the UTC instant shown
beneath, a lower bound switches a non-time sort to Newest first (the plan with the fast path),
and a cut-off export says so and never moves the since-last-export mark. The detail view labels
imported_at as UTC.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

The visual check of this page happens in Task 10 (Step 7), against the deployed app.

---

### Task 9: The Lookup page, the breach export and the API docs

One optional "Only imported after" input on the Lookup page and on the breach-page export, and the four v1 parameter tables.

**Files:**
- Modify: `app/lookup/page.tsx`, `app/breaches/[name]/page.tsx`, `app/docs/page.tsx`
- Test: `__tests__/imported-range-lookup-pages.test.ts`

**Interfaces:**
- Consumes: `localInputToUtcIso`, `utcIsoToDisplay` from Task 7; the batch route's `imported_after` body key (Task 6) and the export route's (Task 5) and its `Content-Disposition` / `X-Export-Truncated` headers.

- [x] **Step 1: Write the guard tests**

Create `__tests__/imported-range-lookup-pages.test.ts` with exactly this content:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Lookup page and breach export — one optional imported-after input each', () => {
  test('Lookup sends imported_after in the batch body only when it is set', () => {
    const src = read('app/lookup/page.tsx')
    expect(src).toContain('type="datetime-local"')
    expect(src).toContain("const bound = importedAfterIso ? { imported_after: importedAfterIso } : {}")
    expect(src).toContain('{ emails: queries, ...bound }')
    expect(src).toContain('{ domains: queries, ...bound }')
  })

  test('the breach export sends it, names the file from the server, and reports a cut-off export', () => {
    const src = read('app/breaches/[name]/page.tsx')
    expect(src).toContain('type="datetime-local"')
    expect(src).toContain("imported_after: importedAfterIso ?? ''")
    expect(src).toContain("res.headers.get('Content-Disposition')")
    expect(src).toContain("res.headers.get('X-Export-Truncated') === '1'")
  })
})

describe('API docs — the new parameters are documented on all four v1 lookups', () => {
  const src = read('app/docs/page.tsx')
  test('imported_after and imported_before appear in the search, domain, lookup and batch tables', () => {
    expect(src.match(/name: "imported_after"/g)).toHaveLength(4)
    expect(src.match(/name: "imported_before"/g)).toHaveLength(4)
  })
})
```

- [x] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/imported-range-lookup-pages.test.ts`
Expected: FAIL (3 tests).

- [x] **Step 3: Implement**

Apply these three diffs.

`app/lookup/page.tsx`:

```diff
diff --git a/app/lookup/page.tsx b/app/lookup/page.tsx
index db827c8..7545a6c 100644
--- a/app/lookup/page.tsx
+++ b/app/lookup/page.tsx
@@ -8,9 +8,11 @@ import {
 } from "lucide-react"
 import { Button } from "@/components/ui/button"
 import { Badge } from "@/components/ui/badge"
+import { Input } from "@/components/ui/input"
 import { Textarea } from "@/components/ui/textarea"
 import { useToast } from "@/hooks/use-toast"
 import { useAuth } from "@/hooks/useAuth"
+import { localInputToUtcIso, utcIsoToDisplay } from "@/lib/imported-range-client"
 
 // ── Types ─────────────────────────────────────────────────────────────────────
 
@@ -155,15 +157,19 @@ export default function LookupPage() {
 
   const queries = parseLines(rawInput)
   const overLimit = queries.length > 100
+  // Optional: only matches imported after this time. The field is local time; the API takes the UTC instant shown beneath it.
+  const [importedAfter, setImportedAfter] = useState("")
+  const importedAfterIso = importedAfter ? localInputToUtcIso(importedAfter, new Date(importedAfter).getTimezoneOffset()) : null
 
   async function runLookup() {
     if (queries.length === 0 || loading) return
     setLoading(true)
     setResponse(null)
     try {
+      const bound = importedAfterIso ? { imported_after: importedAfterIso } : {}
       const body = mode === "email"
-        ? { emails: queries }
-        : { domains: queries }
+        ? { emails: queries, ...bound }
+        : { domains: queries, ...bound }
 
       const res  = await fetch("/api/lookup/batch", {
         method: "POST",
@@ -301,6 +307,18 @@ export default function LookupPage() {
             </div>
           </div>
 
+          <div className="space-y-1">
+            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Only imported after (optional)</label>
+            <Input
+              type="datetime-local"
+              step={1}
+              value={importedAfter}
+              onChange={e => setImportedAfter(e.target.value)}
+              className="h-8 text-xs font-mono"
+            />
+            {importedAfterIso && <p className="text-[10px] font-mono text-muted-foreground">= {utcIsoToDisplay(importedAfterIso)}</p>}
+          </div>
+
           {overLimit && (
             <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 p-2">
               <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
```

`app/breaches/[name]/page.tsx`:

```diff
diff --git a/app/breaches/[name]/page.tsx b/app/breaches/[name]/page.tsx
index 6e2ba28..5bf386c 100644
--- a/app/breaches/[name]/page.tsx
+++ b/app/breaches/[name]/page.tsx
@@ -9,10 +9,12 @@ import {
 } from "lucide-react"
 import { Button } from "@/components/ui/button"
 import { Badge } from "@/components/ui/badge"
+import { Input } from "@/components/ui/input"
 import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
 import { useToast } from "@/hooks/use-toast"
 import { useAuth, isAdmin } from "@/hooks/useAuth"
 import Link from "next/link"
+import { localInputToUtcIso, utcIsoToDisplay } from "@/lib/imported-range-client"
 
 interface BreachRecord {
   breach_name: string
@@ -58,6 +60,9 @@ export default function BreachDetailPage() {
   const [retagFile, setRetagFile] = useState('')
   const [retagging, setRetagging] = useState(false)
   const [exporting, setExporting] = useState(false)
+  // Optional: export only what was imported after this time (local time here; the API takes the UTC instant shown beneath the field).
+  const [importedAfter, setImportedAfter] = useState('')
+  const importedAfterIso = importedAfter ? localInputToUtcIso(importedAfter, new Date(importedAfter).getTimezoneOffset()) : null
 
   const userIsAdmin = user ? isAdmin(user) : false
 
@@ -88,16 +93,21 @@ export default function BreachDetailPage() {
       const res = await fetch('/api/export', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
-        body: JSON.stringify({ format, query: '', domain: '', breach_name: breachName }),
+        body: JSON.stringify({ format, query: '', domain: '', breach_name: breachName, imported_after: importedAfterIso ?? '' }),
       })
       if (!res.ok) throw new Error('Export failed')
       const blob = await res.blob()
       const url = URL.createObjectURL(blob)
       const a = document.createElement('a')
       a.href = url
-      a.download = `breach-${breachName}.${format === 'csv' ? 'csv' : 'txt'}`
+      // The server's file name records the imported window; fall back to the plain name.
+      const named = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)
+      a.download = named?.[1] || `breach-${breachName}.${format === 'csv' ? 'csv' : 'txt'}`
       a.click()
       URL.revokeObjectURL(url)
+      if (res.headers.get('X-Export-Truncated') === '1') {
+        toast({ title: 'Export stopped at 10,000 rows', description: 'Set "Only imported after" to a later time to get the rest.', variant: 'destructive' })
+      }
     } catch {
       toast({ title: "Export failed", variant: "destructive" })
     } finally {
@@ -336,7 +346,18 @@ export default function BreachDetailPage() {
             <p className="text-sm text-muted-foreground">
               Export <strong className="text-foreground">{stats.credential_count.toLocaleString()}</strong> credentials from this breach
             </p>
-            <div className="flex gap-2">
+            <div className="flex items-end gap-2">
+              <div className="space-y-1">
+                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Only imported after (optional)</label>
+                <Input
+                  type="datetime-local"
+                  step={1}
+                  value={importedAfter}
+                  onChange={e => setImportedAfter(e.target.value)}
+                  className="h-8 text-xs font-mono"
+                />
+                {importedAfterIso && <p className="text-[10px] font-mono text-muted-foreground">= {utcIsoToDisplay(importedAfterIso)}</p>}
+              </div>
               <Button size="sm" variant="outline" onClick={() => exportBreachCredentials('csv')} disabled={exporting}>
                 <Download className="mr-1 h-3 w-3" />CSV
               </Button>
```

`app/docs/page.tsx`:

```diff
diff --git a/app/docs/page.tsx b/app/docs/page.tsx
index e01c1f8..1544a59 100644
--- a/app/docs/page.tsx
+++ b/app/docs/page.tsx
@@ -317,6 +317,8 @@ export default function DocsPage() {
                     { name: "page", type: "number", required: false, description: "Page number for pagination", default: "1" },
                     { name: "limit", type: "number", required: false, description: "Number of results per page (max 1000)", default: "100" },
                     { name: "cursor", type: "string", required: false, description: "Keyset pagination token from a previous response's next_cursor (recommended for deep paging)" },
+                    { name: "imported_after", type: "string", required: false, description: "Only rows imported after this UTC instant (exclusive). A date (2026-10-05, the whole day), a date-time (2026-10-05 14:37:00, read as UTC) or ISO-8601 with an offset (2026-10-05T14:37:00-05:00). Anything else is a 400. The response echoes the effective window." },
+                    { name: "imported_before", type: "string", required: false, description: "Only rows imported up to and including this UTC instant (inclusive); same forms. Poll without gaps or overlap by passing the previous response's imported_before as the next imported_after." },
                   ]} />
                 </div>
 
@@ -426,6 +428,8 @@ export default function DocsPage() {
                     { name: "domain", type: "string", required: true, description: "The domain to search for (e.g., example.com)" },
                     { name: "page", type: "number", required: false, description: "Page number for pagination", default: "1" },
                     { name: "limit", type: "number", required: false, description: "Number of results per page (max 1000)", default: "100" },
+                    { name: "imported_after", type: "string", required: false, description: "Only rows imported after this UTC instant (exclusive). A date (2026-10-05, the whole day), a date-time (2026-10-05 14:37:00, read as UTC) or ISO-8601 with an offset (2026-10-05T14:37:00-05:00). Anything else is a 400. The response echoes the effective window." },
+                    { name: "imported_before", type: "string", required: false, description: "Only rows imported up to and including this UTC instant (inclusive); same forms. Poll without gaps or overlap by passing the previous response's imported_before as the next imported_after." },
                   ]} />
                 </div>
 
@@ -526,6 +530,8 @@ export default function DocsPage() {
                   <ParameterTable params={[
                     { name: "email", type: "string", required: false, description: "Email address to lookup (use this OR domain)" },
                     { name: "domain", type: "string", required: false, description: "Domain to lookup (use this OR email)" },
+                    { name: "imported_after", type: "string", required: false, description: "Only rows imported after this UTC instant (exclusive). A date (2026-10-05, the whole day), a date-time (2026-10-05 14:37:00, read as UTC) or ISO-8601 with an offset (2026-10-05T14:37:00-05:00). Anything else is a 400. The response echoes the effective window." },
+                    { name: "imported_before", type: "string", required: false, description: "Only rows imported up to and including this UTC instant (inclusive); same forms. Poll without gaps or overlap by passing the previous response's imported_before as the next imported_after." },
                   ]} />
                   <p className="text-sm text-amber-500 mt-3 flex items-center gap-2">
                     <AlertCircle className="h-4 w-4" />
@@ -682,6 +688,8 @@ export default function DocsPage() {
                   <ParameterTable params={[
                     { name: "emails", type: "string[]", required: false, description: "Array of email addresses to look up (exact match). Max 100 total queries." },
                     { name: "domains", type: "string[]", required: false, description: "Array of domains to look up (exact match). Max 100 total queries." },
+                    { name: "imported_after", type: "string", required: false, description: "Only rows imported after this UTC instant (exclusive). A date (2026-10-05, the whole day), a date-time (2026-10-05 14:37:00, read as UTC) or ISO-8601 with an offset (2026-10-05T14:37:00-05:00). Anything else is a 400. The response echoes the effective window." },
+                    { name: "imported_before", type: "string", required: false, description: "Only rows imported up to and including this UTC instant (inclusive); same forms. Poll without gaps or overlap by passing the previous response's imported_before as the next imported_after." },
                   ]} />
                 </div>
 
```

- [x] **Step 4: Run the tests to see them pass**

Run: `npx vitest run __tests__/imported-range-lookup-pages.test.ts`
Expected: PASS, 3 tests.

- [x] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . app/lookup/page.tsx "app/breaches/[name]/page.tsx" app/docs/page.tsx __tests__/imported-range-lookup-pages.test.ts
git add app/lookup/page.tsx "app/breaches/[name]/page.tsx" app/docs/page.tsx __tests__/imported-range-lookup-pages.test.ts
git commit -F - <<'EOF'
feat(ui): imported-after on the Lookup page and the breach export, API docs for the new parameters

Lookup answers "which of these addresses appeared since I last looked" with one optional
input; the breach export names its file from the server (which records the window) and says
when the 10,000-row cap cut it; the four v1 tables document imported_after / imported_before.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 10: Live parity, release checks and deploy

Prove on the real table that the helper's plan returns row for row what the plain bound returns, run everything once, record the result in the spec, merge, deploy locally and look at the page. This task is verification: run it yourself, do not hand it to an implementer/reviewer pair, and do not run docker from a subagent.

**Files:**
- Create: `__tests__/imported-range-parity.live.test.ts`
- Modify: `docs/superpowers/specs/2026-10-05-imported-after-filter-design.md` (status line and a "Result" note)

- [x] **Step 1: Add the live parity test**

Create `__tests__/imported-range-parity.live.test.ts` with exactly this content:

```ts
import { execSync } from 'node:child_process'
import { describe, expect, test, vi, afterAll } from 'vitest'

/**
 * LIVE parity check for the imported-range bound (lib/imported-range.ts): for several cutoffs, searches and sorts, the route's answer with
 * the helper's plan (the projection form where it is allowed, the windows over proj_imported_desc) must be ROW FOR ROW what the PLAIN bound
 * returns, page after page, and the totals must match too. Skipped unless IRP_PARITY=1; it talks to a real ClickHouse, prints timings and
 * is READ-ONLY.
 *
 *   IRP_PARITY=1 npx vitest run __tests__/imported-range-parity.live.test.ts                  # the live table (30-60 min: the plain plan is slow)
 *   IRP_PARITY=1 IRP_ONLY="oldest first" npx vitest run __tests__/imported-range-parity.live.test.ts   # scenarios whose name contains the text
 *   IRP_PARITY=1 IRP_TABLE=ulp.zz_irp npx vitest run ...                                      # a sandbox copy
 *
 * It drives the real GET /api/credentials handler. The plain plan is forced by answering the readiness check "not ready", which makes
 * planImportedRange emit the plain bound and Newest-first hand off to the plain query. The user profile has the query cache on, so it is
 * dropped before EVERY call (a cached answer would look like a speedup and hide a difference). Re-run it after anything that rebuilds the table
 * or the projection, and after a ClickHouse upgrade.
 */

const LIVE = process.env.IRP_PARITY === '1'
const TABLE = process.env.IRP_TABLE ?? 'ulp.credentials'
const SHORT = TABLE.split('.')[1]
const ONLY = process.env.IRP_ONLY ?? ''
const PAGES = Number(process.env.IRP_PAGES ?? 2)

let forcePlain = false
const timings: Array<{ scenario: string; what: string; plainMs: number; helperMs: number; plan: string }> = []

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))
vi.mock('@/lib/clickhouse', async () => {
  const actual = await vi.importActual<typeof import('@/lib/clickhouse')>('@/lib/clickhouse')
  const rewrite = (sql: string) => sql.replaceAll('ulp.credentials', TABLE).replaceAll("table = 'credentials'", `table = '${SHORT}'`)
  return {
    ...actual,
    executeQuery: async (sql: string, params?: Record<string, unknown>) => {
      if (forcePlain && /system\.projections/.test(sql)) return [{ defined: 0, parts: 1, with_projection: 0 }]
      return actual.executeQuery(rewrite(sql), params)
    },
  }
})

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

// The data runs 2026-07-03 .. 2026-08-28. Cutoffs: the newest ~2.2M rows, the whole newest burst (143M rows), the newest partition, both partitions.
const NEWEST = '2026-08-28T23:30:00Z'
const BURST = '2026-08-28T20:00:00Z'
const PARTITION = '2026-08-16T00:00:00Z'
const BOTH = '2026-07-10T00:00:00Z'
const VIEW = 'exclude_noise=1&dedupe=1'

const scenarios: Array<{ name: string; qs: string; plainExtra?: string }> = [
  { name: 'no query, newest first, newest rows', qs: `imported_after=${NEWEST}&sort=imported_desc&${VIEW}` },
  { name: 'no query, newest first, the whole burst', qs: `imported_after=${BURST}&sort=imported_desc&${VIEW}` },
  { name: 'domain term, newest first, newest rows', qs: `q=binance.com&imported_after=${NEWEST}&sort=imported_desc&${VIEW}` },
  { name: 'domain term, newest first, the whole burst', qs: `q=binance.com&imported_after=${BURST}&sort=imported_desc&${VIEW}` },
  { name: 'domain term, oldest first (projection form on the plain query)', qs: `q=binance.com&imported_after=${BURST}&sort=imported_asc&${VIEW}` },
  { name: 'domain term, default sort (plain bound)', qs: `q=binance.com&imported_after=${PARTITION}&${VIEW}` },
  { name: 'domain term, closed window', qs: `q=binance.com&imported_after=${BURST}&imported_before=2026-08-28T22:00:00Z&sort=imported_desc&${VIEW}` },
  { name: 'domain term, upper bound only', qs: `q=binance.com&imported_before=2026-08-20T00:00:00Z&sort=imported_desc&${VIEW}` },
  { name: 'domain term, range spanning both partitions', qs: `q=binance.com&imported_after=${BOTH}&sort=imported_desc&${VIEW}` },
  { name: '@domain term, newest first', qs: `q=${encodeURIComponent('@gmail.com')}&imported_after=${NEWEST}&sort=imported_desc&${VIEW}` },
  { name: 'word term, newest first (plain bound; windows over lower(col))', qs: `q=ledger&imported_after=${BURST}&sort=imported_desc&${VIEW}` },
  { name: 'word term that has mixed-case matches, newest first', qs: `q=login&imported_after=${NEWEST}&sort=imported_desc` },
  { name: 'regex, newest first', qs: `q=${encodeURIComponent('^admin@')}&regex=1&imported_after=${NEWEST}&sort=imported_desc&${VIEW}` },
  { name: 'legacy date_from (a whole UTC day), newest first', qs: `date_from=2026-08-28&sort=imported_desc&${VIEW}` },
  {
    name: 'one domain term + a bound, dictionary on against off',
    qs: `q=trezor.io&imported_after=${BOTH}&sort=domain_asc&${VIEW}`,
    plainExtra: '&dictionary=0',
  },
]

describe.skipIf(!LIVE)(`imported-range parity on ${TABLE}`, () => {
  afterAll(() => {
    console.log('\nscenario | what | plain plan ms | helper plan ms (plan)')
    for (const t of timings) console.log(`${t.scenario} | ${t.what} | ${t.plainMs} | ${t.helperMs} (${t.plan})`)
  })

  test.each(scenarios.filter(s => !ONLY || s.name.includes(ONLY)))('$name', async ({ name, qs, plainExtra }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')
    const { getClient } = await import('@/lib/clickhouse')

    const call = async (extra: string, plain: boolean) => {
      forcePlain = plain
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}&limit=50${plain ? plainExtra ?? '' : ''}${extra}`))
      const ms = Date.now() - t0
      return { ms, status: res.status, body: await res.json() }
    }

    // Totals first: the same search, no rows.
    const plainTotals = await call('&totals_only=1', true)
    const helperTotals = await call('&totals_only=1', false)
    expect(helperTotals.body.success, `totals: ${JSON.stringify(helperTotals.body).slice(0, 300)}`).toBe(true)
    expect(plainTotals.body.success, 'totals (plain)').toBe(true)
    expect({ total: helperTotals.body.total, raw_total: helperTotals.body.raw_total }).toEqual({ total: plainTotals.body.total, raw_total: plainTotals.body.raw_total })
    timings.push({ scenario: name, what: 'totals', plainMs: plainTotals.ms, helperMs: helperTotals.ms, plan: helperTotals.body.plan ?? '-' })

    let cursor = ''
    for (let page = 1; page <= PAGES; page++) {
      const extra = `&skip_totals=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const plain = await call(extra, true)
      const helper = await call(extra, false)
      expect(helper.body.success, `page ${page}: ${JSON.stringify(helper.body).slice(0, 300)}`).toBe(true)
      expect(plain.body.success, `page ${page} (plain)`).toBe(true)
      expect(helper.body.results).toEqual(plain.body.results)
      expect(helper.body.next_cursor).toEqual(plain.body.next_cursor)
      timings.push({ scenario: name, what: `page ${page} (${plain.body.results.length} rows)`, plainMs: plain.ms, helperMs: helper.ms, plan: helper.body.plan })
      if (!plain.body.next_cursor) break
      cursor = plain.body.next_cursor
    }
  }, 40 * 60_000)
})
```

- [x] **Step 2: Run the key scenarios (read-only, about 15 minutes in all)**

ClickHouse must be running. Each command drives the real `GET /api/credentials` handler twice per page (helper plan, then forced-plain plan) and compares rows and totals.

```bash
for f in "newest rows" "oldest first" "mixed-case" "dictionary on" "closed window" "spanning both" "upper bound only" "legacy date_from"; do
  echo "=== $f"; IRP_PARITY=1 IRP_PAGES=1 IRP_ONLY="$f" npx vitest run __tests__/imported-range-parity.live.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests |AssertionError|→|\| [0-9]+ \|"
done
```

Expected: every scenario PASSES (identical rows, identical totals). The printed `scenario | what | plain ms | helper ms (plan)` rows on the 2026-10-05 data looked like this (milliseconds; the plan column says which plan answered the rows):

```
no query, newest first, newest rows | totals | 109 | 53
no query, newest first, newest rows | page 1 (50 rows) | 416 | 70 (windows)
domain term, newest first, newest rows | totals | 12738 | 140
domain term, newest first, newest rows | page 1 (50 rows) | 11104 | 279 (windows)
domain term, oldest first (projection form on the plain query) | totals | 13293 | 5341
domain term, oldest first (projection form on the plain query) | page 1 (50 rows) | 17371 | 10022 (plain)
word term that has mixed-case matches, newest first | totals | 5053 | 5379
word term that has mixed-case matches, newest first | page 1 (50 rows) | 17283 | 96 (windows)
one domain term + a bound, dictionary on against off | totals | 18519 | 2249 (dictionary)
one domain term + a bound, dictionary on against off | page 1 (50 rows) | 7149 | 159 (dictionary)
domain term, closed window | totals | 12841 | 2605
domain term, closed window | page 1 (50 rows) | 14115 | 145 (windows)
domain term, range spanning both partitions | totals | 28037 | 29012
domain term, range spanning both partitions | page 1 (50 rows) | 48371 | 1169 (windows)
domain term, upper bound only | totals | 24979 | 24384
domain term, upper bound only | page 1 (50 rows) | 42185 | 43474 (windows)
legacy date_from (a whole UTC day), newest first | totals | 988 | 1047
legacy date_from (a whole UTC day), newest first | page 1 (50 rows) | 7930 | 94 (windows)
```

Only a lower bound speeds a search up; an upper-bound-only range is the plain query (the windows hand off), so it costs about a second more than before, and that is expected.

A failure is a real difference between the two plans: STOP, keep the printed scenario, and report it; do not loosen the comparison.

- [x] **Step 3: Run the Newest-first live parity file once (the spec's acceptance for P0; 30-60 minutes)**

Run: `NFW_PARITY=1 npx vitest run __tests__/newest-first-parity.live.test.ts`
Expected: PASS, 15 tests (the 13 original scenarios plus the two case-parity tests).

- [x] **Step 4: Run everything once**

```bash
npx vitest run
npx tsc --noEmit
npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . --ext .js,.jsx,.ts,.tsx app components lib hooks __tests__/imported-range-parity.live.test.ts
npm run build
```

Expected: every test file passes (the three `*.live.test.ts` files are skipped; on the pristine dry-run of this plan the summary was `Test Files  149 passed | 3 skipped (152)` and `Tests  2306 passed | 57 skipped (2363)`), `tsc` and `eslint` print nothing, `next build` finishes without errors (a "multiple lockfiles" warning from a nested worktree is benign). `next build` needs about 6 GB of heap: check `free -m` first (this laptop's swap is often full) and close anything heavy before running it.

- [x] **Step 5: Record the result in the spec**

In `docs/superpowers/specs/2026-10-05-imported-after-filter-design.md` replace exactly this text (the start of the first paragraph):

```
Status: **design approved in chat on 2026-10-05; this written spec awaits the owner's read; not implemented.** One rule changed after approval,
because a measurement disproved it: the helper never switches skip indexes off (see "The plan rule" and "Measurements"), and a prerequisite fix
(P0) was added.
```

with:

```
Status: **implemented on 2026-10-05 (plan `docs/superpowers/plans/2026-10-05-imported-after-filter.md`).** One rule changed after the design was approved,
because a measurement disproved it: the helper never switches skip indexes off (see "The plan rule" and "Measurements"), and a prerequisite fix
(P0) shipped first. `__tests__/imported-range-parity.live.test.ts` returns row for row what the plain bound returns for every scenario it carries, and
`__tests__/newest-first-parity.live.test.ts` carries the two case-parity tests.
```

Leave everything after it (the reference table and how the timings were taken) as it is. Then:

```bash
git add __tests__/imported-range-parity.live.test.ts docs/superpowers/specs/2026-10-05-imported-after-filter-design.md
git commit -F - <<'EOF'
test(imported-range): live parity of the helper's plan against the plain bound; mark the spec implemented

Drives the real browse handler for 15 scenarios (no query, a domain, an @domain, a word that has
mixed-case matches, a regex, the dictionary path, closed and one-sided windows, a range across
both partitions, the old date_from) and compares rows, cursors and totals of the helper's plan
with the forced-plain plan on the live table, read-only, with timings.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

- [x] **Step 6: Merge and push (the owner's standing permission, once Steps 2-4 are green)**

Use `superpowers:finishing-a-development-branch` and choose "merge locally", then push `origin main` without asking again (the owner granted this once work is verified). If you worked directly on `main`, just `git push origin main`. Do not push if any step above failed.

- [ ] **Step 7: Deploy locally and look at it (controller only, from the MAIN checkout)**

> **Status (2026-10-05):** deployed locally from `d6aaa06` (image `defbce7a277e`; rollback tag `ulp-suite-app:rollback-20261005-2326z` = the previous image
> `0b49178e2916`). The infrastructure checks passed: both services healthy, the JWT secret set, mounts under `/home/cole/ulp-suite`, `imported_after` present in
> the shipped build and the new UI strings in the credentials-page bundle, a clean startup log, and the new routes still answer 401 without a session. The four
> Browser-pane checks below were NOT run: the pane was not signed in, and only the owner can sign in. Tick this box once they have been.

The app and ClickHouse run in Docker on this laptop; deploying here is covered by the owner's standing permission, anything beyond this laptop is not. This global Docker config is broken (`credsStore`), so scope around it per command and never edit it. The previous image gets a rollback tag first, because the old image is gone after the rebuild.

```bash
cd /home/cole/ulp-suite
git branch --show-current                      # must print main
git status --short                             # must show no source changes
mkdir -p /tmp/ulp-dockercfg && echo '{}' > /tmp/ulp-dockercfg/config.json
docker tag ulp-suite-app:latest ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz)
DOCKER_CONFIG=/tmp/ulp-dockercfg docker compose build app
DOCKER_CONFIG=/tmp/ulp-dockercfg docker compose up -d --no-deps app
```

Verify, in this order:

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep ulpsuite            # both healthy
docker exec ulpsuite_app printenv JWT_SECRET | wc -c                    # non-zero
docker inspect ulpsuite_app --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'   # sources under /home/cole/ulp-suite, never .claude/worktrees
docker exec ulpsuite_app sh -c "grep -rl 'imported_after' .next/server | head -3"                         # the new code is inside the build
docker logs ulpsuite_app --tail 20                                      # no errors on startup
```

Then in the Browser pane open `http://localhost:3000/credentials` (the compose file publishes the app on loopback only). If the pane is not signed in, ask the owner to sign in; never type a password. Check:
1. Advanced Filters shows "Imported after" and "Imported before" (date-time inputs), the presets row and "Since last export".
2. Enter an "Imported after" of `2026-08-28 18:30` (local time): the line under it reads `= 2026-08-28 23:30:00 UTC` for an operator at UTC-5, the sort switches to "Newest first", and Search returns the newest rows quickly (the spec measured 0.1 to 0.3 s for a domain search).
3. Search a small domain with no bounds, Export CSV: the toast says "Export started" and the page now shows "last export of this search ended ...". Wait two minutes, click "Since last export": both fields fill; Search returns nothing new (the table has had no import since 2026-08-28).
4. With `read_network_requests`, the export response carries `X-Export-Truncated: 0`, `X-Export-Rows` and, when a bound was sent, `X-Export-Imported-After` / `-Before`, and the file name ends `_after-...Z_before-...Z.csv`.

If anything is wrong, roll back with `docker tag ulp-suite-app:rollback-<stamp> ulp-suite-app:latest` and the same `up -d --no-deps app`.

- [x] **Step 8: Report**

Tell the owner, in a few lines: what shipped; the Newest-first fix and how big the gap was (0.2% to 11.8% of the matches for eight common words); that "imported after" means rows ADDED after the cutoff, so a credential re-imported later counts until a dedup pass or the novelty-aware importer (decision D1); and the known limits below.

---

## Known limits (state them, do not hide them)

- **"Added after" is not "new content".** Until a dedup pass removes them (it runs once about 14M excess rows pile up) or the novelty-aware importer exists (`docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md`), a credential re-imported after the cutoff is returned again. Today it is exact: none of the newest 2.2M rows had an older twin.
- **Word searches get no speed-up from the bound.** The projection form needs an index-neutral search; a word search costs what it cost without the bound (about 8 to 11 s for the newest delta, and `Newest first` still answers it in about 0.1 s through the windows).
- **A word search's totals with a bound leave the planner free to read the projection**, exactly as date ranges always did. Every measurement chose the base table, and the live parity file compares those totals with the forced-plain plan; if it ever shows a difference, add `optimize_use_projections = 0` for non-index-neutral searches there.
- **`imported_asc` gains less**: 13.3 s to 5.3 s for the totals and 17.4 s to 10.0 s for a page over the 143M-row delta (it is not windowed).
- **The presets and "Since last export" go through local `datetime-local` strings.** In the one hour a year when the local clock repeats, the round trip can land an hour earlier: duplicates, never gaps.
- **The 10,000-row cap stays.** It is reported now; raising it or streaming those formats is a separate piece of work.
