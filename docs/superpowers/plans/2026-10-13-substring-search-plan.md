# Substring search plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (The owner chose inline execution: one check per step, no repeated re-checks.)

**Goal:** A search for one text with a special character in it (a path, a colon pair, a space) answers in 0.4 to 11 seconds instead of 35 to 42 when one of its whole words is rare in the text indexes, with the same rows, order, cursors and totals as today's query, and never more than 1.2 times slower.

**Architecture:** The route's own two SQL templates (data query, totals query) take what a plan adds as parameters (a conjunct, a time limit, planner settings), so a plan IS today's query plus a condition and cannot drift from it. `lib/search-substring-plan.ts` decides eligibility and picks the condition: the rarest whole word of the text, measured by a capped count through the text indexes (`lib/search-plan-gate.ts`, which also holds the kill switch, the gate, the budget and the fallback helper the word plan will reuse). Any plan that is not eligible, over the gate, over its budget or failing falls back to today's query.

**Tech Stack:** TypeScript, Next.js route handlers, ClickHouse 26.3 (`text()` indexes with direct read), vitest.

Spec: `docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md` (approved by the owner on 2026-10-13: "Continue"). This is plan 1 of 2 (B, the substring plan). The word plan (A) gets its own plan after this one ships, and reuses the gate module.

## Global Constraints

- A plan only ADDS to today's query: every part of the route's WHERE, filters, cursor, ordering, de-duplication and limit stays; the result must equal today's. Any plan that errors, runs over its budget, is not eligible, or whose gate says no, falls back to today's query for that request. The rows request and the totals request decide independently.
- Eligible: the search is exactly one positive, non-regex term of type `like` in scope All fields (`parseULPQuery`), with no `login:` prefix.
- Whole word: a maximal run of ASCII letters and digits inside the needle with a character on BOTH sides in the needle, both ASCII non-alphanumeric and neither a LIKE metacharacter (`%`, `_`, `\`). Such a run is a whole token of any haystack that contains the needle, so `hasToken(col, lower(run))` is a NECESSARY condition of the legacy predicate (the text index lowercases, LIKE here is case-sensitive: the condition can only be wider). Non-ASCII neighbours are token characters for `splitByNonAlpha` and disqualify a run.
- Choice: one capped count per whole word through the text indexes (up to 8 words, the longest first, in parallel, cached ten minutes per word), take the smallest. Gate: smallest hit count at most 50,000. No whole word, or none under the gate: today's query.
- SQL: the legacy WHERE with `AND (hasToken(url, t) OR hasToken(email, t) OR hasToken(password, t))` appended (the leaves are `wordLeaves` from `lib/ulp-search.ts`, the same function the word search is built from). One query for the rows, one for the totals. Both run with `optimize_use_projections = 0` (a projection part has no text index: there `hasToken` is the plain, case-SENSITIVE function and would drop rows LIKE matches). Budget 15 s (today's query takes 35 s or more) as `max_execution_time` with `timeout_overflow_mode = 'throw'`; an overrun is the fallback, never a 408.
- Kill switch `SEARCH_TOKEN_PLANS=0|false|off|no` in `.env`; per request `token_plans=0` on `/api/credentials` forces today's query (parity scripts). The response's `plan` field says `substring` when the plan answered.
- No DDL, no index, no data. Multi-term searches, negation, regex, login scopes, addresses, domains, single words and the list exports keep their paths. The Newest-first windows still run first for `sort=imported_desc` (a term concentrated in new data fills the page from the first windows); the plan answers in `runDataQuery`, where the dictionary plan does.
- The repository is public: tests and docs use invented words only (`ledger`, `login`, `example.test`); never a real search term. The owner's needles reach the live parity test through `SSP_NEEDLES` in the shell environment.
- Gate before every merge: `npx tsc --noEmit` exit 0, eslint 0 on `app lib components` plus every new file, `npx vitest run` all green. Check exit codes explicitly (a `| head` chain hides a failure).
- Rollback tag of the running image BEFORE building; build with `git archive`; recreate only `app`.

---

## Facts measured while writing this plan (2026-10-13, live table, 1.84B rows)

- The capped probe `SELECT count() FROM (SELECT 1 ... WHERE <three leaves> LIMIT 50001)` takes 0.13 to 0.19 s for a token that matches millions of rows (1.5 billion included) and 0.27 to 0.31 s for a rare one. The unbounded count took 0.28 to 0.60 s, so the cap is for a bounded answer, not for survival.
- The text index has no token-length limit that matters here: runs of 30 to 1,468 characters in `url`, `password` and `email` are all found by `hasToken`.
- On a scratch table with the production `idx_inv_url` DDL, the index separates tokens at exactly the ASCII non-alphanumeric characters (codes 0 to 47, 58 to 64, 91 to 96, 123 to 127, `~` included) and treats every other character, non-ASCII ones included, as part of a token; it agrees with `tokens(lower(s), 'splitByNonAlpha')` on all 138 samples. `tokens()` exists in 26.3 and is what the live test uses as the reference.

## Deviations from the spec's component list

- The spec puts "the two SQL builders" in `lib/search-substring-plan.ts`. Here the route's own two templates take the plan's additions as parameters and the library supplies only the conjunct: the plan is today's query by construction, and the existing tests keep pinning one template.
- The spec's `runWithBudget(run, budgetSeconds)` takes no budget argument: the budget is the `max_execution_time` in the plan's SQL, and the helper turns its timeout into the fallback.

## File Structure

- Modify `lib/ulp-search.ts`: export `wordLeaves(param, col?)`; the word clause is built from it (same SQL text as before).
- Create `lib/search-plan-gate.ts`: kill switch, constants, `PLAN_PROJECTIONS_OFF`, `isTimeoutError`, `runWithBudget`, `probeTokenHits` with its cache.
- Create `lib/search-substring-plan.ts`: `substringNeedleFromQuery`, `wholeTokens`, `resolveSubstringChoice`, `substringConjunct`.
- Modify `app/api/credentials/route.ts`: the two templates take a plan's additions; the substring plan is tried in `runDataQuery` and `runTotals`; `plan` gains `substring`; `token_plans=0`.
- Modify `docker-compose.yml`, `.env.example`, `README.md`, the spec's status line.
- Tests: create `__tests__/ulp-search-word-leaves.test.ts`, `__tests__/search-plan-gate.test.ts`, `__tests__/search-substring-plan.test.ts`, `__tests__/credentials-route-substring.test.ts`, `__tests__/substring-plan-parity.live.test.ts`; modify `__tests__/credentials-route.test.ts` (one source pin).

---

### Task 1: `wordLeaves`, the one spelling of a word's three text-index leaves

**Files:**
- Modify: `lib/ulp-search.ts`
- Test: `__tests__/ulp-search-word-leaves.test.ts` (create)

**Interfaces:**
- Produces: `wordLeaves(param: string, col?: (name: string) => string): string` returns `hasToken(url, {param:String}) OR hasToken(email, {param:String}) OR hasToken(password, {param:String})`, the columns spelled by `col` (default: as is).

- [ ] **Step 1: Write the failing test**

Create `__tests__/ulp-search-word-leaves.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { wordLeaves, buildULPWhere, parseULPQuery } from '@/lib/ulp-search'

describe('wordLeaves', () => {
  test('the three text-index leaves of a word, on the plain columns', () => {
    expect(wordLeaves('w')).toBe('hasToken(url, {w:String}) OR hasToken(email, {w:String}) OR hasToken(password, {w:String})')
  })

  test('over the lowercased column when asked (a projection has no text index)', () => {
    expect(wordLeaves('w', name => `lower(${name})`))
      .toBe('hasToken(lower(url), {w:String}) OR hasToken(lower(email), {w:String}) OR hasToken(lower(password), {w:String})')
  })

  test('the word search is built from it, and its SQL is exactly what it was', () => {
    const { clause } = buildULPWhere(parseULPQuery('ledger'))
    expect(clause).toBe(`(${wordLeaves('tok0')} OR url_host LIKE {tlk0:String} OR email_domain LIKE {tlk0:String})`)
    expect(clause).toBe(
      '(hasToken(url, {tok0:String}) OR hasToken(email, {tok0:String}) OR hasToken(password, {tok0:String}) '
      + 'OR url_host LIKE {tlk0:String} OR email_domain LIKE {tlk0:String})',
    )
    const projected = buildULPWhere(parseULPQuery('ledger'), { caseInsensitiveTokens: true }).clause
    expect(projected).toContain(wordLeaves('tok0', name => `lower(${name})`))
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/ulp-search-word-leaves.test.ts 2>&1 | tail -15`
Expected: FAIL, `wordLeaves is not a function` (3 failed).

- [ ] **Step 3: Implement**

In `lib/ulp-search.ts`, directly above `export interface BuildULPWhereOptions {`, add:

```ts
/**
 * The three text-index leaves of a word: `hasToken` on url, email and password (the `text()` indexes answer them, case-insensitively, through their
 * lower() preprocessor). `col` spells the column: a projection has no text index, so a query that reads one writes `lower(col)`
 * (BuildULPWhereOptions.caseInsensitiveTokens). The word search and the token plans (lib/search-substring-plan.ts) build their leaves here, so the
 * spellings cannot drift apart.
 */
export function wordLeaves(param: string, col: (name: string) => string = name => name): string {
  return `hasToken(${col('url')}, {${param}:String}) OR hasToken(${col('email')}, {${param}:String}) OR hasToken(${col('password')}, {${param}:String})`
}

```

and in `buildULPWhere`'s `token` branch replace the line

```ts
      match = `(hasToken(${col('url')}, {${p}:String}) OR hasToken(${col('email')}, {${p}:String}) OR hasToken(${col('password')}, {${p}:String}) OR url_host LIKE {${lp}:String} OR email_domain LIKE {${lp}:String})`
```

with

```ts
      match = `(${wordLeaves(p, col)} OR url_host LIKE {${lp}:String} OR email_domain LIKE {${lp}:String})`
```

- [ ] **Step 4: Run the new test and every test that pins the search SQL**

Run: `npx vitest run __tests__/ulp-search-word-leaves.test.ts __tests__/ulp-search.test.ts __tests__/ulp-search-address.test.ts __tests__/ulp-search-login-build.test.ts __tests__/login-scope-parity.live.test.ts 2>&1 | tail -12`
Expected: all pass (the live file is skipped without its flag).

- [ ] **Step 5: Commit**

```bash
git add lib/ulp-search.ts __tests__/ulp-search-word-leaves.test.ts
git commit -m "refactor(search): wordLeaves, the one spelling of a word's three text-index leaves" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The gate module (kill switch, constants, probe, budget helper)

**Files:**
- Create: `lib/search-plan-gate.ts`
- Test: `__tests__/search-plan-gate.test.ts` (create)

**Interfaces:**
- Consumes: `wordLeaves` (Task 1), `executeQuery` from `@/lib/clickhouse`, type `Run` from `@/lib/search-dictionary`.
- Produces:
  - `searchTokenPlansEnabled(env?): boolean`
  - constants `SUBSTRING_GATE_HITS = 50_000`, `SUBSTRING_BUDGET_SECONDS = 15`, `SUBSTRING_MAX_PROBES = 8`, `PROBE_CAP_ROWS = 50_001`, `PLAN_PROJECTIONS_OFF = 'optimize_use_projections = 0'`
  - `isTimeoutError(err: unknown): boolean`
  - `runWithBudget<T>(label: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: 'budget' | 'error' }>`
  - `interface GateDeps { run?: Run; now?: () => number }`
  - `probeTokenHits(token: string, deps?: GateDeps): Promise<number | null>` (null = the probe failed; a number is capped at `PROBE_CAP_ROWS`)
  - `resetSearchPlanGateCache(): void`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/search-plan-gate.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  searchTokenPlansEnabled, isTimeoutError, runWithBudget, probeTokenHits, resetSearchPlanGateCache,
  SUBSTRING_GATE_HITS, SUBSTRING_BUDGET_SECONDS, SUBSTRING_MAX_PROBES, PROBE_CAP_ROWS, PLAN_PROJECTIONS_OFF,
} from '@/lib/search-plan-gate'

beforeEach(() => { resetSearchPlanGateCache() })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('the kill switch', () => {
  test('on unless SEARCH_TOKEN_PLANS says no', () => {
    expect(searchTokenPlansEnabled({})).toBe(true)
    expect(searchTokenPlansEnabled({ SEARCH_TOKEN_PLANS: '' })).toBe(true)
    expect(searchTokenPlansEnabled({ SEARCH_TOKEN_PLANS: '1' })).toBe(true)
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' 0 ']) expect(searchTokenPlansEnabled({ SEARCH_TOKEN_PLANS: v }), v).toBe(false)
  })

  test('reads the environment of the process by default', () => {
    vi.stubEnv('SEARCH_TOKEN_PLANS', 'off')
    expect(searchTokenPlansEnabled()).toBe(false)
  })
})

describe('the measured constants (spec 2026-10-13)', () => {
  test('gate 50,000 hits, budget 15 s, 8 probes, a probe counts one above the gate, projections off', () => {
    expect(SUBSTRING_GATE_HITS).toBe(50_000)
    expect(SUBSTRING_BUDGET_SECONDS).toBe(15)
    expect(SUBSTRING_MAX_PROBES).toBe(8)
    expect(PROBE_CAP_ROWS).toBe(SUBSTRING_GATE_HITS + 1)
    expect(PLAN_PROJECTIONS_OFF).toBe('optimize_use_projections = 0')
  })
})

describe('isTimeoutError and runWithBudget', () => {
  const timeout = new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 15.2 seconds, maximum: 15. (TIMEOUT_EXCEEDED)')

  test('recognises the ways a ClickHouse time limit shows up', () => {
    expect(isTimeoutError(timeout)).toBe(true)
    expect(isTimeoutError(new Error('socket timeout'))).toBe(true)
    expect(isTimeoutError(new Error('Request Timeout'))).toBe(true)
    expect(isTimeoutError(new Error('Code: 241. MEMORY_LIMIT_EXCEEDED'))).toBe(false)
    expect(isTimeoutError('TIMEOUT_EXCEEDED')).toBe(true)
    expect(isTimeoutError(undefined)).toBe(false)
  })

  test('hands back the value when the run succeeds', async () => {
    expect(await runWithBudget('x', async () => [1, 2])).toEqual({ ok: true, value: [1, 2] })
  })

  test('a timeout is "over the budget": ok false, reason budget, one warning that names the plan, and it never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runWithBudget('substring rows', async () => { throw timeout })).toEqual({ ok: false, reason: 'budget' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('substring rows')
  })

  test('any other error is a failure: ok false, reason error, one warning with the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runWithBudget('substring totals', async () => { throw new Error('MEMORY_LIMIT_EXCEEDED') })).toEqual({ ok: false, reason: 'error' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0].join(' ')).toContain('MEMORY_LIMIT_EXCEEDED')
  })
})

describe('probeTokenHits', () => {
  const countRun = (hits: number) => vi.fn(async (_sql: string, _params: Record<string, unknown> = {}) => [{ hits: String(hits) }])

  test('a capped count through the three text-index leaves, with a time limit, no result cache and projections off', async () => {
    const run = countRun(1158)
    expect(await probeTokenHits('ledger', { run })).toBe(1158)
    const [sql, params] = run.mock.calls[0]
    expect(sql).toContain('hasToken(url, {tok:String}) OR hasToken(email, {tok:String}) OR hasToken(password, {tok:String})')
    expect(sql).toContain('FROM ulp.credentials')
    expect(sql).toContain('LIMIT {cap:UInt32}')
    expect(sql).toContain('use_query_cache = 0')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).toContain('max_execution_time = 8')
    expect(params).toEqual({ tok: 'ledger', cap: 50_001 })
  })

  test('the answer is kept ten minutes per word; another word looks again; then the first looks again too', async () => {
    const run = countRun(5)
    let t = 1_000
    const deps = { run, now: () => t }
    await probeTokenHits('ledger', deps)
    await probeTokenHits('ledger', deps)
    expect(run).toHaveBeenCalledTimes(1)
    await probeTokenHits('login', deps)
    expect(run).toHaveBeenCalledTimes(2)
    t += 599_000
    await probeTokenHits('ledger', deps)
    expect(run).toHaveBeenCalledTimes(2)
    t += 2_000
    await probeTokenHits('ledger', deps)
    expect(run).toHaveBeenCalledTimes(3)
  })

  test('two callers at once (the rows request and the totals request of one page) share ONE probe', async () => {
    const run = countRun(7)
    const [a, b] = await Promise.all([probeTokenHits('ledger', { run }), probeTokenHits('ledger', { run })])
    expect([a, b]).toEqual([7, 7])
    expect(run).toHaveBeenCalledTimes(1)
  })

  test('a probe that fails is null with one warning, and is not retried for a minute', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn(async () => { throw new Error('boom') })
    let t = 5_000
    const deps = { run, now: () => t }
    expect(await probeTokenHits('ledger', deps)).toBeNull()
    expect(await probeTokenHits('ledger', deps)).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    t += 61_000
    await probeTokenHits('ledger', deps)
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('an answer that is not a count is a failure, not a zero', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await probeTokenHits('ledger', { run: vi.fn(async () => []) })).toBeNull()
    expect(await probeTokenHits('login', { run: vi.fn(async () => [{ hits: 'abc' }]) })).toBeNull()
  })

  test('keeps at most 500 words', async () => {
    const run = countRun(1)
    for (let i = 0; i < 520; i++) await probeTokenHits(`w${i}`, { run })
    expect(run).toHaveBeenCalledTimes(520)
    await probeTokenHits('w519', { run })
    expect(run).toHaveBeenCalledTimes(520)
    await probeTokenHits('w0', { run })
    expect(run).toHaveBeenCalledTimes(521)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/search-plan-gate.test.ts 2>&1 | tail -10`
Expected: FAIL, cannot resolve `@/lib/search-plan-gate`.

- [ ] **Step 3: Implement**

Create `lib/search-plan-gate.ts`:

```ts
/**
 * What the token plans share (docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md): the substring plan
 * (lib/search-substring-plan.ts) today, the word plan next.
 *
 * A token plan ANDs a prunable text-index condition onto today's query and keeps every other part of it, so its answer equals today's. It is only
 * worth running when that condition is selective, which a cheap probe through the text indexes tells (0.13 s for a word that matches 1.5 billion
 * rows once the count is capped, 0.3 s for a rare one: measured on the live table, 2026-10-13); and it is only worth waiting for within a budget well
 * under today's query. So every plan has a kill switch, a gate on the probe's count, a time budget that THROWS (ClickHouse's own max_execution_time on
 * the plan's query) and a fallback that runs today's query whenever the plan is not eligible, over the gate, over its budget or failing.
 */
import { executeQuery } from '@/lib/clickhouse'
import { wordLeaves } from '@/lib/ulp-search'
import type { Run } from '@/lib/search-dictionary'

type Env = Record<string, string | undefined>

/** SEARCH_TOKEN_PLANS=0 (or false, off, no) switches every token plan off; absent or anything else leaves them on. */
export function searchTokenPlansEnabled(env: Env = process.env): boolean {
  const v = (env.SEARCH_TOKEN_PLANS ?? '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(v)
}

// ── the measured constants ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The substring plan runs when the rarest whole word of the text matches at most this many rows. The cost follows how many granules hold a hit:
 * a word with 1,158 hits answered in 0.5 s, 21,643 in 2.5 s, 39,772 in 10.7 s, 96,045 in 19 s (only 2x better than today's 35-42 s).
 */
export const SUBSTRING_GATE_HITS = 50_000
/** The plan's query may take this long (today's takes 35 s or more). Over it, today's query runs. */
export const SUBSTRING_BUDGET_SECONDS = 15
/** At most this many whole words of one text are probed, the longest first (long words are rarer). */
export const SUBSTRING_MAX_PROBES = 8
/** A probe counts up to this many rows and stops: one above the biggest gate, so "over the gate" is visible without counting further. */
export const PROBE_CAP_ROWS = SUBSTRING_GATE_HITS + 1
/**
 * The plans read the base table only. A projection part has no text index, so there `hasToken` runs as the plain function, which is case-SENSITIVE
 * (the index lowercases through its preprocessor), and would silently drop rows that LIKE matches (see isIndexNeutralSearch in lib/ulp-search.ts).
 */
export const PLAN_PROJECTIONS_OFF = 'optimize_use_projections = 0'

const PROBE_TIMEOUT_SECONDS = 8
const VERDICT_TTL_MS = 600_000
const FAILURE_TTL_MS = 60_000
const CACHE_MAX_TOKENS = 500

// ── the budget ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A ClickHouse time limit, however it reaches us (the same test the routes use). */
export function isTimeoutError(err: unknown): boolean {
  const msg = errorMessage(err)
  return msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout') || msg.includes('Timeout')
}

export type Budgeted<T> = { ok: true; value: T } | { ok: false; reason: 'budget' | 'error' }

/**
 * Runs a plan's query. The budget is the max_execution_time in the plan's own SQL; when it is exceeded, or the plan fails for any other reason, the
 * answer is `ok: false` and the caller runs today's query. Never throws, and a plan's timeout is never a 408: today's query has its own 300 s.
 */
export async function runWithBudget<T>(label: string, run: () => Promise<T>): Promise<Budgeted<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (err) {
    const budget = isTimeoutError(err)
    console.warn(`[search-plan] ${label} ${budget ? 'ran over its time budget' : 'failed'} -- using the plain query${budget ? '' : `: ${errorMessage(err)}`}`)
    return { ok: false, reason: budget ? 'budget' : 'error' }
  }
}

// ── the probe ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GateDeps {
  run?: Run
  now?: () => number
}

const PROBE_SQL = `SELECT count() AS hits FROM (SELECT 1 FROM ulp.credentials WHERE ${wordLeaves('tok')} LIMIT {cap:UInt32}) `
  + `SETTINGS use_query_cache = 0, ${PLAN_PROJECTIONS_OFF}, max_execution_time = ${PROBE_TIMEOUT_SECONDS}`

interface ProbeEntry { at: number; ttl: number; value: Promise<number | null> }
const probes = new Map<string, ProbeEntry>()

export function resetSearchPlanGateCache(): void {
  probes.clear()
}

/**
 * How many rows have `word` as a whole token in url, email or password, counted through the text indexes (direct read) and capped at
 * PROBE_CAP_ROWS; null when the probe failed. `word` is lowercase letters and digits. Cached ten minutes per word (a failure for one minute);
 * concurrent callers share the one query.
 */
export function probeTokenHits(word: string, deps: GateDeps = {}): Promise<number | null> {
  const run: Run = deps.run ?? executeQuery
  const now = deps.now ?? Date.now
  const t = now()
  const hit = probes.get(word)
  if (hit && t - hit.at < hit.ttl) return hit.value

  const entry: ProbeEntry = { at: t, ttl: VERDICT_TTL_MS, value: Promise.resolve(null) }
  entry.value = run(PROBE_SQL, { tok: word, cap: PROBE_CAP_ROWS })
    .then(rows => {
      const n = Number(rows[0]?.hits)
      if (rows[0]?.hits === undefined || !Number.isFinite(n) || n < 0) throw new Error('the probe did not return a count')
      return n
    })
    .catch((err: unknown) => {
      entry.ttl = FAILURE_TTL_MS
      console.warn('[search-plan] token probe failed -- using the plain query:', errorMessage(err))
      return null
    })
  probes.delete(word)
  probes.set(word, entry)
  while (probes.size > CACHE_MAX_TOKENS) probes.delete(probes.keys().next().value as string)
  return entry.value
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run __tests__/search-plan-gate.test.ts 2>&1 | tail -12`
Expected: all pass.

- [ ] **Step 5: Mutation check (the cache test must have teeth)**

Temporarily change `VERDICT_TTL_MS = 600_000` to `0` in `lib/search-plan-gate.ts`, run `npx vitest run __tests__/search-plan-gate.test.ts 2>&1 | grep -E "✓|×|FAIL|passed|failed" | head`, confirm the ten-minute and share tests FAIL, then restore the value and re-run: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/search-plan-gate.ts __tests__/search-plan-gate.test.ts
git commit -m "feat(search): the token-plan gate (kill switch, budget helper, capped probe through the text indexes)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The substring plan module

**Files:**
- Create: `lib/search-substring-plan.ts`
- Test: `__tests__/search-substring-plan.test.ts` (create)

**Interfaces:**
- Consumes: `parseULPQuery`, `buildULPWhere`, `wordLeaves` (Task 1); `searchTokenPlansEnabled`, `probeTokenHits`, `SUBSTRING_GATE_HITS`, `SUBSTRING_MAX_PROBES`, `GateDeps` (Task 2).
- Produces:
  - `substringNeedleFromQuery(q: string, regex: boolean, scope?: SearchScope): string | null` (the needle, i.e. what sits between the percent signs of the legacy LIKE parameter)
  - `wholeTokens(needle: string): string[]` (lowercase, de-duplicated, in order of appearance)
  - `interface SubstringChoice { token: string; hits: number }`
  - `resolveSubstringChoice(needle: string, deps?: GateDeps): Promise<SubstringChoice | null>`
  - `SUBSTRING_PARAM = 'sbt'`, `substringConjunct(token: string): { sql: string; params: Record<string, string> }` where `sql` starts with ` AND (` and ends with `)`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/search-substring-plan.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  substringNeedleFromQuery, wholeTokens, resolveSubstringChoice, substringConjunct, SUBSTRING_PARAM,
} from '@/lib/search-substring-plan'
import { resetSearchPlanGateCache } from '@/lib/search-plan-gate'
import { buildULPWhere, parseULPQuery } from '@/lib/ulp-search'

beforeEach(() => { resetSearchPlanGateCache() })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('substringNeedleFromQuery', () => {
  test('one positive text with a special character, looked up in every column, gives the needle of the legacy LIKE', () => {
    expect(substringNeedleFromQuery('/ledger/login.php', false)).toBe('/ledger/login.php')
    expect(substringNeedleFromQuery('a b', false)).toBe('a b')
    expect(substringNeedleFromQuery('  user:pass  ', false)).toBe('user:pass')
  })

  test('the needle is what buildULPWhere puts between the percent signs of its parameter, so the two cannot drift apart', () => {
    for (const q of ['/ledger/login.php', 'user:pass', 'a b c', 'x?y=z', '100%']) {
      const { params } = buildULPWhere(parseULPQuery(q))
      expect(`%${substringNeedleFromQuery(q, false)}%`).toBe(params.lk0)
    }
  })

  test.each([
    ['a word', 'ledger'],
    ['a domain', 'ledger.com'],
    ['an address', 'john@example.test'],
    ['an @domain', '@example.test'],
    ['two terms', '/ledger/a,/ledger/b'],
    ['a negated term', '-/ledger/login.php'],
    ['a login: prefix', 'login:/ledger/login.php'],
    ['nothing', ''],
  ])('not eligible: %s', (_name, q) => {
    expect(substringNeedleFromQuery(q, false)).toBeNull()
  })

  test('regex mode and the login scopes are never eligible', () => {
    expect(substringNeedleFromQuery('/ledger/login.php', true)).toBeNull()
    expect(substringNeedleFromQuery('/ledger/login.php', false, 'login')).toBeNull()
    expect(substringNeedleFromQuery('/ledger/login.php', false, 'login_contains')).toBeNull()
    expect(substringNeedleFromQuery('/ledger/login.php', false, 'all')).toBe('/ledger/login.php')
  })
})

describe('wholeTokens', () => {
  const t = wholeTokens

  test('the words between two separators', () => {
    expect(t('/ledger/login.php')).toEqual(['ledger', 'login'])
    expect(t('a b c d')).toEqual(['b', 'c'])
    expect(t('x?user=ledger&y')).toEqual(['user', 'ledger'])
  })

  test('a word at either end of the needle is not whole: the haystack may continue it', () => {
    expect(t('login.php')).toEqual([])
    expect(t('abc')).toEqual([])
    expect(t('.abc')).toEqual([])
    expect(t('abc.')).toEqual([])
    expect(t('x/login/')).toEqual(['login'])
  })

  test('a LIKE wildcard or the escape beside a word makes it not whole; one further away does not matter', () => {
    expect(t('a/%login/b')).toEqual([])
    expect(t('a/login%/b')).toEqual([])
    expect(t('/login_/')).toEqual([])
    expect(t('/log_in/')).toEqual([])
    expect(t('/\\login/')).toEqual([])
    expect(t('/login\\/')).toEqual([])
    expect(t('/%/login/')).toEqual(['login'])
    expect(t('/_/login/')).toEqual(['login'])
  })

  test('a non-ASCII neighbour continues the token, so the word is not whole', () => {
    expect(t('/éabc/')).toEqual([])
    expect(t('/abcé/')).toEqual([])
    expect(t('/😀abc/x')).toEqual([])
    expect(t('é.login.é')).toEqual(['login'])
  })

  test('lowercased, de-duplicated, in order of appearance', () => {
    expect(t('/Login/PHP/login/')).toEqual(['login', 'php'])
  })

  test('digits and mixed runs are words; hyphens, colons, spaces and control characters are separators', () => {
    expect(t('/a1b2/c3/')).toEqual(['a1b2', 'c3'])
    expect(t('x-abc-y')).toEqual(['abc'])
    expect(t('x:abc:y')).toEqual(['abc'])
    expect(t('x abc y')).toEqual(['abc'])
    expect(t('x\tabc\ny')).toEqual(['abc'])
  })
})

describe('resolveSubstringChoice', () => {
  const counts = (byWord: Record<string, number | null>) => vi.fn(async (_sql: string, params: Record<string, unknown> = {}) => {
    const v = byWord[String(params.tok)]
    if (v === null) throw new Error('probe failed')
    return [{ hits: String(v ?? 50_001) }]
  })

  test('takes the rarest whole word', async () => {
    const run = counts({ ledger: 120, login: 40_000 })
    expect(await resolveSubstringChoice('/ledger/login.php', { run })).toEqual({ token: 'ledger', hits: 120 })
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('the gate: exactly 50,000 hits passes, one more does not', async () => {
    expect(await resolveSubstringChoice('/ledger/zz', { run: counts({ ledger: 50_000 }) })).toEqual({ token: 'ledger', hits: 50_000 })
    resetSearchPlanGateCache()
    expect(await resolveSubstringChoice('/ledger/zz', { run: counts({ ledger: 50_001 }) })).toBeNull()
  })

  test('no whole word: today\'s query, and no probe at all', async () => {
    const run = counts({})
    expect(await resolveSubstringChoice('a b', { run })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  test('probes at most 8 words, the longest first', async () => {
    const needle = '/' + ['aa', 'bbbbbbbbb', 'ccccccc', 'ddd', 'eeeeeeeeee', 'ffff', 'gggggg', 'hhhhh', 'iiiiiiii', 'jjjjjjjjjj'].join('/') + '/x'
    const run = counts({})
    await resolveSubstringChoice(needle, { run })
    const probed = run.mock.calls.map(c => String(c[1]?.tok))
    expect(probed).toHaveLength(8)
    expect(probed).not.toContain('aa')
    expect(probed).not.toContain('ddd')
    expect(probed[0].length).toBeGreaterThanOrEqual(probed[7].length)
  })

  test('a probe that failed is ignored while another word has a count; all failed means today\'s query', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveSubstringChoice('/ledger/login.php', { run: counts({ ledger: null, login: 700 }) })).toEqual({ token: 'login', hits: 700 })
    resetSearchPlanGateCache()
    expect(await resolveSubstringChoice('/ledger/login.php', { run: counts({ ledger: null, login: null }) })).toBeNull()
  })

  test('the kill switch: null, and nothing is probed', async () => {
    vi.stubEnv('SEARCH_TOKEN_PLANS', 'off')
    const run = counts({ ledger: 1 })
    expect(await resolveSubstringChoice('/ledger/zz', { run })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  test('a word seen before (in another text) is not probed again', async () => {
    const run = counts({ ledger: 5, other: 9 })
    await resolveSubstringChoice('/ledger/zz', { run })
    await resolveSubstringChoice('/other/ledger/zz', { run })
    expect(run.mock.calls.map(c => String(c[1]?.tok)).sort()).toEqual(['ledger', 'other'])
  })
})

describe('substringConjunct', () => {
  test('the word search\'s own three leaves on the plain columns, one parameter, ANDed on', () => {
    const c = substringConjunct('ledger')
    expect(SUBSTRING_PARAM).toBe('sbt')
    expect(c.sql).toBe(' AND (hasToken(url, {sbt:String}) OR hasToken(email, {sbt:String}) OR hasToken(password, {sbt:String}))')
    expect(c.params).toEqual({ sbt: 'ledger' })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/search-substring-plan.test.ts 2>&1 | tail -10`
Expected: FAIL, cannot resolve `@/lib/search-substring-plan`.

- [ ] **Step 3: Implement**

Create `lib/search-substring-plan.ts`:

```ts
/**
 * The substring plan (design: docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md).
 *
 * A text with a special character in it (a path, `user:pass`, a space) is searched as `url LIKE '%x%' OR email LIKE '%x%' OR password LIKE '%x%'`
 * (lib/ulp-search.ts, the `like` type), which no skip index prunes: every granule is read, about 95 GiB, 35-42 s warm, 72-82 s as logged. But a
 * WORD inside the text is a necessary condition of the whole text: the word must be a whole token of any haystack that contains the text, and the
 * text indexes answer `hasToken` directly. The plan ANDs the rarest such word onto today's query, which keeps its LIKE predicate verbatim, so the
 * result can only equal today's.
 *
 * Which words are necessary. A run of ASCII letters and digits inside the needle with a character on both sides in the needle, both ASCII
 * non-alphanumeric and neither a LIKE metacharacter (`%`, `_` and the escape `\`). The text index cuts tokens at exactly the ASCII non-alphanumerics
 * and keeps every other character, non-ASCII ones included, inside a token (checked on all 128 ASCII characters and on samples of the rest, with the
 * production DDL). So such a run is a whole token of every haystack that matches the needle; a run at either end of the needle, or beside a wildcard
 * or a non-ASCII character, may be only part of one. The index lowercases (its preprocessor) and LIKE here does not, so lowercasing the word can only
 * widen the condition.
 *
 * The plan is used when the rarest word matches at most SUBSTRING_GATE_HITS rows (lib/search-plan-gate.ts); otherwise, and on any failure or overrun
 * of its budget, today's query runs.
 */
import { parseULPQuery, buildULPWhere, wordLeaves } from '@/lib/ulp-search'
import type { SearchScope } from '@/lib/search-scope'
import {
  searchTokenPlansEnabled, probeTokenHits, SUBSTRING_GATE_HITS, SUBSTRING_MAX_PROBES, type GateDeps,
} from '@/lib/search-plan-gate'

/**
 * The needle, when the whole search is exactly one positive, non-regex term of the `like` type looked up in every column; null for everything else
 * (a word, a domain, an address, several terms, negation, regex, a login scope), which keeps today's query. It comes out of buildULPWhere's own
 * LIKE parameter so the two cannot drift apart.
 */
export function substringNeedleFromQuery(q: string, regex: boolean, scope: SearchScope = 'all'): string | null {
  if (regex) return null
  const tokens = parseULPQuery(q, scope)
  if (tokens.length !== 1) return null
  const [token] = tokens
  if (token.type !== 'like' || token.negate || token.scope !== 'all') return null
  const { lk0 } = buildULPWhere(tokens).params
  if (typeof lk0 !== 'string' || lk0.length < 3 || !lk0.startsWith('%') || !lk0.endsWith('%')) return null
  return lk0.slice(1, -1)
}

/** A character that ends a token in the text index and that a LIKE pattern cannot consume: ASCII, and not `%`, `_` or the escape. (A run is maximal, so its neighbour is never a letter or digit.) */
const isHardSeparator = (c: string): boolean => c.charCodeAt(0) < 128 && c !== '%' && c !== '_' && c !== '\\'

/** The whole words of a needle (see the header): lowercase, without repeats, in order of appearance. */
export function wholeTokens(needle: string): string[] {
  const words: string[] = []
  for (const m of needle.matchAll(/[A-Za-z0-9]+/g)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (start === 0 || end === needle.length) continue
    if (!isHardSeparator(needle[start - 1]) || !isHardSeparator(needle[end])) continue
    words.push(m[0].toLowerCase())
  }
  return [...new Set(words)]
}

export interface SubstringChoice {
  /** The lowercase word to AND on. */
  token: string
  /** How many rows it matches (a probe's count, at most the gate). */
  hits: number
}

/**
 * The rarest whole word of the needle when it passes the gate, else null (today's query). Probes the longest words first, at most
 * SUBSTRING_MAX_PROBES, in parallel; a probe that failed is ignored.
 */
export async function resolveSubstringChoice(needle: string, deps: GateDeps = {}): Promise<SubstringChoice | null> {
  if (!searchTokenPlansEnabled()) return null
  const words = wholeTokens(needle).sort((a, b) => b.length - a.length).slice(0, SUBSTRING_MAX_PROBES)
  if (words.length === 0) return null
  const counts = await Promise.all(words.map(word => probeTokenHits(word, deps)))
  let best: SubstringChoice | null = null
  for (let i = 0; i < words.length; i++) {
    const hits = counts[i]
    if (hits === null || hits > SUBSTRING_GATE_HITS) continue
    if (best === null || hits < best.hits) best = { token: words[i], hits }
  }
  return best
}

/** The name of the plan's one query parameter. */
export const SUBSTRING_PARAM = 'sbt'

/** What the plan ANDs onto today's WHERE: the word's three text-index leaves (the word search's own spelling) and their parameter. */
export function substringConjunct(token: string): { sql: string; params: Record<string, string> } {
  return { sql: ` AND (${wordLeaves(SUBSTRING_PARAM)})`, params: { [SUBSTRING_PARAM]: token } }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run __tests__/search-substring-plan.test.ts 2>&1 | tail -12`
Expected: all pass.

- [ ] **Step 5: Mutation check on the rule**

Temporarily change `if (start === 0 || end === needle.length) continue` to `if (false) continue` and `isHardSeparator` to `c => true`; run the file; confirm the "either end", "wildcard" and "non-ASCII" tests FAIL; restore both; re-run: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/search-substring-plan.ts __tests__/search-substring-plan.test.ts
git commit -m "feat(search): the substring plan (rarest whole word of a LIKE text as a text-index condition)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The route uses the plan

**Files:**
- Modify: `app/api/credentials/route.ts`
- Modify: `__tests__/credentials-route.test.ts` (one source pin)
- Test: `__tests__/credentials-route-substring.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: `GET /api/credentials` answers with `plan: 'substring'` (rows) and `plan: 'substring'` (totals_only) when the plan answered; `token_plans=0` forces today's query.

- [ ] **Step 1: Write the failing route tests**

Create `__tests__/credentials-route-substring.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
let dataRows: Array<Record<string, unknown>> = []
let totalsRow: Record<string, unknown> = { total: '11', raw_total: '12' }
let probeHits: Record<string, number | Error> = {}
let planDataError: Error | null = null
let planTotalsError: Error | null = null
let plainDataError: Error | null = null

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/SELECT count\(\) AS hits FROM/.test(sql)) {
      const v = probeHits[String(params.tok)]
      if (v instanceof Error) throw v
      return [{ hits: String(v ?? 50_001) }]
    }
    if (/system\.projections/.test(sql)) return [{ defined: 0, parts: 1, with_projection: 0 }] // Newest-first windows NOT ready
    if (/AS raw_total/.test(sql)) {
      if (planTotalsError && sql.includes('{sbt:String}')) throw planTotalsError
      return [totalsRow]
    }
    if (/\) AS t\s/.test(sql)) {
      if (planDataError && sql.includes('{sbt:String}')) throw planDataError
      if (plainDataError && !sql.includes('{sbt:String}')) throw plainDataError
      return dataRows
    }
    return []
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { encodeCursor } from '@/lib/cursor-pagination'
import { resetSearchPlanGateCache } from '@/lib/search-plan-gate'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'

const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.test`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4,
})
const isProbe = (c: Call) => /SELECT count\(\) AS hits FROM/.test(c.sql)
const planRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && c.sql.includes('{sbt:String}'))
const plainRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && !c.sql.includes('{sbt:String}'))
const planTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && c.sql.includes('{sbt:String}'))
const plainTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && !c.sql.includes('{sbt:String}'))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
const NEEDLE = encodeURIComponent('/ledger/login.php')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const TIMEOUT = () => new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 15.2 seconds, maximum: 15. (TIMEOUT_EXCEEDED)')

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  calls.length = 0
  dataRows = [row(1), row(2)]
  totalsRow = { total: '11', raw_total: '12' }
  probeHits = { ledger: 120, login: 40_000 }
  planDataError = planTotalsError = plainDataError = null
  resetSearchPlanGateCache()
  resetNewestFirstReadyCache()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
// Not restoreAllMocks: it would also strip the implementations of the mocked auth and ClickHouse modules.
afterEach(() => { vi.unstubAllEnvs(); warnSpy.mockRestore() })

describe('GET /api/credentials — a text with a special character, answered through its rarest whole word', () => {
  test('the page\'s rows request and totals request are both answered by the plan and share ONE set of probes', async () => {
    const [rowsRes, totalsRes] = await Promise.all([
      get(`q=${NEEDLE}&skip_totals=1&exclude_noise=1&dedupe=1`),
      get(`q=${NEEDLE}&totals_only=1&exclude_noise=1&dedupe=1`),
    ])
    const rowsBody = await rowsRes.json()
    const totalsBody = await totalsRes.json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'substring' })
    expect(rowsBody.results).toHaveLength(2)
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'substring' })
    expect(calls.filter(isProbe)).toHaveLength(2) // ledger and login, once each, although two requests asked
    expect(planRows()).toHaveLength(1)
    expect(planTotals()).toHaveLength(1)
    expect(plainRows()).toHaveLength(0)
    expect(plainTotals()).toHaveLength(0)
  })

  test('the rows SQL is today\'s rows SQL plus the conjunct, a 15 s limit and the projection setting; nothing else differs', async () => {
    await get(`q=${NEEDLE}&skip_totals=1&exclude_noise=1&dedupe=1&limit=50`)
    const plan = planRows()[0]
    calls.length = 0
    await get(`q=${NEEDLE}&skip_totals=1&exclude_noise=1&dedupe=1&limit=50&token_plans=0`)
    const plain = plainRows()[0]
    const undone = norm(plan.sql)
      .replace(' AND (hasToken(url, {sbt:String}) OR hasToken(email, {sbt:String}) OR hasToken(password, {sbt:String}))', '')
      .replace('max_execution_time = 15,', 'max_execution_time = 300,')
      .replace('optimize_use_projections = 0, ', '')
    expect(undone).toBe(norm(plain.sql))
    expect(plan.sql).toContain('url LIKE {lk0:String}') // the legacy predicate is still there
    expect(plan.params).toMatchObject({ lk0: '%/ledger/login.php%', sbt: 'ledger', limit: 50 })
    expect(plan.sql).toContain("timeout_overflow_mode = 'throw'")
    expect(plan.sql).toContain('http_wait_end_of_query = 1')
  })

  test('the totals SQL is today\'s totals SQL plus the conjunct, a 15 s limit that THROWS, and the projection setting', async () => {
    await get(`q=${NEEDLE}&totals_only=1&exclude_noise=1&dedupe=1`)
    const plan = planTotals()[0]
    calls.length = 0
    await get(`q=${NEEDLE}&totals_only=1&exclude_noise=1&dedupe=1&token_plans=0`)
    const plain = plainTotals()[0]
    expect(plain.sql).toContain("timeout_overflow_mode = 'break'")
    expect(plain.sql).toContain('max_execution_time = 300')
    expect(plan.sql).toContain("timeout_overflow_mode = 'throw'")
    expect(plan.sql).toContain('max_execution_time = 15')
    expect(plan.sql).toContain('optimize_use_projections = 0')
    const undone = norm(plan.sql)
      .replace(' AND (hasToken(url, {sbt:String}) OR hasToken(email, {sbt:String}) OR hasToken(password, {sbt:String}))', '')
      .replace('max_execution_time = 15,', 'max_execution_time = 300,')
      .replace("timeout_overflow_mode = 'throw'", "timeout_overflow_mode = 'break'")
      .replace(/, optimize_use_projections = 0$/, '')
    expect(undone).toBe(norm(plain.sql).replace(/, optimize_use_projections = 0$/, ''))
  })

  test('the plan\'s query parameters reach the totals too', async () => {
    await get(`q=${NEEDLE}&totals_only=1`)
    expect(planTotals()[0].params).toMatchObject({ lk0: '%/ledger/login.php%', sbt: 'ledger' })
  })

  test('a cursor page puts the keyset clause next to the conjunct and does not probe again', async () => {
    await get(`q=${NEEDLE}&sort=domain_asc&skip_totals=1&limit=2`)
    const cursor = encodeCursor('domain_asc', row(2))
    calls.length = 0
    await get(`q=${NEEDLE}&sort=domain_asc&limit=2&cursor=${encodeURIComponent(cursor)}`)
    const { sql, params } = planRows()[0]
    expect(sql).toContain('(domain, email, imported_at, url, password) > ({c_d:String}')
    expect(sql).toContain('hasToken(url, {sbt:String})')
    expect(params).toMatchObject({ c_d: 's2.example', c_e: 'u2@mail.test', sbt: 'ledger' })
    expect(calls.filter(isProbe)).toHaveLength(0) // the verdict for these words is remembered
    expect(planTotals()).toHaveLength(0) // a cursor page has no totals
  })

  test('Unique with a sort not led by domain keeps the bounded window and binds windowLimit like the plain query', async () => {
    await get(`q=${NEEDLE}&skip_totals=1&dedupe=1&sort=email_asc&limit=50`)
    const { sql, params } = planRows()[0]
    expect(sql).toContain('LIMIT {windowLimit:UInt32}')
    expect(sql).toContain('hasToken(url, {sbt:String})')
    expect(params).toMatchObject({ limit: 50, windowLimit: 150, sbt: 'ledger' })
  })

  test('"Newest first" without the projection windows falls to the plan instead of the full scan', async () => {
    const body = await (await get(`q=${NEEDLE}&skip_totals=1&sort=imported_desc&limit=2`)).json()
    expect(body.plan).toBe('substring')
    expect(plainRows()).toHaveLength(0)
  })
})

describe('GET /api/credentials — everything else is today\'s query, untouched', () => {
  test('every whole word over the gate: today\'s query, rows and totals, and the response says plain', async () => {
    probeHits = { ledger: 50_001, login: 90_000_000 }
    const rowsBody = await (await get(`q=${NEEDLE}&skip_totals=1`)).json()
    const totalsBody = await (await get(`q=${NEEDLE}&totals_only=1`)).json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(totalsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(planRows()).toHaveLength(0)
    expect(planTotals()).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
    expect(plainTotals()).toHaveLength(1)
  })

  test('a text with no whole word (a space-separated pair) is not even probed', async () => {
    await get('q=a%20b&skip_totals=1')
    expect(calls.filter(isProbe)).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test('token_plans=0 forces the plain query for one request; nothing is probed', async () => {
    const [rowsBody, totalsBody] = await Promise.all([
      get(`q=${NEEDLE}&skip_totals=1&token_plans=0`).then(r => r.json()),
      get(`q=${NEEDLE}&totals_only=1&token_plans=0`).then(r => r.json()),
    ])
    expect(rowsBody.plan).toBe('plain')
    expect(totalsBody).toMatchObject({ total: 11, raw_total: 12, plan: 'plain' })
    expect(calls.filter(isProbe)).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
    expect(plainTotals()).toHaveLength(1)
  })

  test('SEARCH_TOKEN_PLANS=off in the environment does the same', async () => {
    vi.stubEnv('SEARCH_TOKEN_PLANS', 'off')
    const body = await (await get(`q=${NEEDLE}&skip_totals=1`)).json()
    expect(body.plan).toBe('plain')
    expect(calls.filter(isProbe)).toHaveLength(0)
  })

  test.each([
    ['regex mode', `q=${NEEDLE}&regex=1`],
    ['a single word', 'q=ledger'],
    ['a domain', 'q=ledger.com'],
    ['an address', 'q=john@example.test'],
    ['two terms', `q=${NEEDLE},${encodeURIComponent('/other/path.php')}`],
    ['a negated term', `q=-${NEEDLE}`],
    ['a login: prefix', `q=login:${NEEDLE}`],
    ['the Login scope', `q=${NEEDLE}&scope=login`],
    ['the Login (contains) scope', `q=${NEEDLE}&scope=login_contains`],
    ['no search', 'exclude_noise=1'],
  ])('%s never probes and never uses the plan', async (_name, qs) => {
    const body = await (await get(`${qs}&skip_totals=1`)).json()
    expect(body.plan).toBe('plain')
    expect(calls.filter(isProbe)).toHaveLength(0)
    expect(planRows()).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test('a probe that fails: today\'s query', async () => {
    probeHits = { ledger: new Error('boom'), login: new Error('boom') }
    const body = await (await get(`q=${NEEDLE}&skip_totals=1`)).json()
    expect(body.plan).toBe('plain')
    expect(plainRows()).toHaveLength(1)
  })

  test('a plan query that fails falls back to today\'s query, rows and totals alike', async () => {
    planDataError = new Error('Code: 241. DB::Exception: MEMORY_LIMIT_EXCEEDED')
    planTotalsError = new Error('Code: 47. DB::Exception: Not found column')
    const rowsBody = await (await get(`q=${NEEDLE}&skip_totals=1`)).json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(rowsBody.results).toHaveLength(2)
    expect(plainRows()).toHaveLength(1)
    const totalsBody = await (await get(`q=${NEEDLE}&totals_only=1`)).json()
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'plain' })
    expect(plainTotals()).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  test('a plan that runs over its budget hands over to today\'s query: no 408, rows and totals alike', async () => {
    planDataError = TIMEOUT()
    planTotalsError = TIMEOUT()
    const rowsRes = await get(`q=${NEEDLE}&skip_totals=1`)
    expect(rowsRes.status).toBe(200)
    expect(await rowsRes.json()).toMatchObject({ success: true, plan: 'plain' })
    expect(plainRows()).toHaveLength(1)
    const totalsRes = await get(`q=${NEEDLE}&totals_only=1`)
    expect(totalsRes.status).toBe(200)
    expect(await totalsRes.json()).toMatchObject({ success: true, total: 11, plan: 'plain' })
    expect(plainTotals()).toHaveLength(1)
  })

  test('if today\'s query then also times out, that is the same 408 as without the plan', async () => {
    planDataError = TIMEOUT()
    plainDataError = new Error('Code: 159. DB::Exception: Timeout exceeded: TIMEOUT_EXCEEDED')
    const res = await get(`q=${NEEDLE}&skip_totals=1`)
    expect(res.status).toBe(408)
    expect((await res.json()).timed_out).toBe(true)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/credentials-route-substring.test.ts 2>&1 | tail -25`
Expected: the "plan" tests FAIL (the route does not know the plan yet: `plan` is `plain`, no `{sbt:String}` query); the "everything else" tests mostly pass already.

- [ ] **Step 3: Update the one source pin that the refactor moves**

In `__tests__/credentials-route.test.ts`, test `does not drop the existing execution-time/timeout settings`, replace

```ts
    expect(getFn).toContain('max_execution_time = 300')
    expect(getFn).toContain(`timeout_overflow_mode = 'throw'`)
```

with

```ts
    // Today's queries keep the 300 s limit; a token plan passes a shorter one through the same template (credentials-route-substring.test.ts).
    expect(getFn).toMatch(/maxSeconds:\s*300/)
    expect(getFn).toContain('max_execution_time = ${x.maxSeconds}')
    expect(getFn).toContain(`timeout_overflow_mode = 'throw'`)
```

- [ ] **Step 4: Implement in the route**

All edits are in `app/api/credentials/route.ts`.

(a) Imports, after the `search-dictionary-plan` import:

```ts
import { substringNeedleFromQuery, resolveSubstringChoice, substringConjunct, type SubstringChoice } from "@/lib/search-substring-plan"
import { runWithBudget, SUBSTRING_BUDGET_SECONDS, PLAN_PROJECTIONS_OFF } from "@/lib/search-plan-gate"
```

(b) In the route's header comment, after the `dictionary` line, add:

```
 *   token_plans   '0'       run the plain query even when a token plan (the substring plan) could answer (parity tests, scripts)
```

(c) After the `getCandidates` block (the line `return (candidatesMemo ??= resolveDictionaryCandidates(dictionaryTerm))` and its closing `}`), add:

```ts
  // Substring plan (lib/search-substring-plan.ts): a search for exactly one text with a special character in it (a path, a colon pair, a space) is a LIKE
  // scan of url, email and password that reads every granule (35-80 s). When one whole word of the text is rare in the text indexes, that word is ANDed
  // on as a prunable condition (the same rows, order, cursors and totals, 0.4-11 s). null = this request keeps today's query. The rows request and the
  // totals request the page sends together share the probes (lib/search-plan-gate.ts).
  const substringNeedle = sp.get('token_plans') === '0' ? null : substringNeedleFromQuery(q.trim(), regex, scope)
  let substringMemo: Promise<SubstringChoice | null> | null = null
  const getSubstringChoice = (): Promise<SubstringChoice | null> => {
    if (!substringNeedle) return Promise.resolve(null)
    return (substringMemo ??= resolveSubstringChoice(substringNeedle))
  }
```

(d) Replace the whole `runPlainTotals` declaration (from `type TotalsRows` through the closing `)` of `runPlainTotals`) with:

```ts
    type TotalsRows = Array<{ total?: unknown; raw_total?: unknown }>
    // The totals query with what a plan may change in it (today's query changes nothing): a conjunct ANDed onto the search, the time limit, whether an
    // overrun breaks (a partial count) or throws (a plan's budget, after which today's query runs), and the planner settings.
    interface TotalsShape { conjunct: string; maxSeconds: number; overflow: 'break' | 'throw'; settingsTail: string }
    const todaysTotals: TotalsShape = {
      conjunct: '',
      maxSeconds: 300,
      overflow: 'break',
      settingsTail: hasImportedRange(importedRange) && !addressSearch ? '' : `,\n                    ${ADDRESS_LOOKUP_SETTING}`,
    }
    const totalsSql = (x: TotalsShape): string => `SELECT ${dedupeCountExpr(dedupe, hasUserFilter, excludeNoise ? NOISE_FILTER : undefined)} AS total,
                  count() AS raw_total
           FROM ulp.credentials WHERE ${whereRaw}${x.conjunct}
           SETTINGS optimize_trivial_count_query = 1,
                    max_execution_time = ${x.maxSeconds},
                    timeout_overflow_mode = '${x.overflow}',
                    use_query_cache = 0${x.settingsTail}`
    const runPlainTotals = (): Promise<TotalsRows> => executeQuery(totalsSql(todaysTotals), params)
```

(e) Change `let totalsPlan: 'dictionary' | 'plain' = 'plain'` to `let totalsPlan: 'dictionary' | 'substring' | 'plain' = 'plain'`, and in `runTotals`, replace the final `return runPlainTotals()` with:

```ts
      const choice = await getSubstringChoice()
      if (choice) {
        const conjunct = substringConjunct(choice.token)
        const outcome = await runWithBudget('substring totals', () => executeQuery(
          totalsSql({ conjunct: conjunct.sql, maxSeconds: SUBSTRING_BUDGET_SECONDS, overflow: 'throw', settingsTail: `,\n                    ${PLAN_PROJECTIONS_OFF}` }),
          { ...params, ...conjunct.params },
        ) as Promise<TotalsRows>)
        if (outcome.ok) {
          totalsPlan = 'substring'
          return outcome.value
        }
      }
      return runPlainTotals()
```

(f) Replace the `runPlainDataQuery` declaration (the whole `const runPlainDataQuery = (): Promise<unknown[]> => executeQuery(...)` through `) as Promise<unknown[]>`) with a SQL template function and the plain runner:

```ts
    // The data query, with what a plan may change in it (today's query changes nothing): a conjunct ANDed onto the WHERE, the time limit and the planner
    // settings. Everything else (the columns, ORDER BY, de-duplication, LIMIT, the other settings) is shared, so a plan cannot drift from today's query.
    //
    // Data query uses throw so a timeout produces a clear error (caught below) rather than silently returning 0 rows (timeout_overflow_mode=break with
    // ORDER BY does not flush the sort buffer -- ClickHouse issue #52234).
    //
    // Split into an inner (raw columns, ORDER BY, LIMIT) and outer (NORM_COLS) query -- see RAW_COLS above for why. Wrapping NORM_COLS around the inner
    // query instead of inlining it keeps proj_imported_desc usable.
    interface DataShape { conjunct: string; maxSeconds: number; settingsLine: string }
    const todaysData: DataShape = { conjunct: '', maxSeconds: 300, settingsLine: addressSettingLine }
    const dataSql = (x: DataShape): string => dedupeInWindow
      ? `SELECT ${SELECT}
         FROM (
           SELECT ${RAW_COLS}
           FROM (
             SELECT ${RAW_COLS}, content_key_hash
             FROM ulp.credentials
             WHERE ${where}${x.conjunct}${cursorClause}
             ORDER BY ${orderBy}
             LIMIT {windowLimit:UInt32}
           )
           ORDER BY ${orderBy}
           ${dedupeLimitBy(true)}
           LIMIT {limit:UInt32}
         ) AS t
         SETTINGS max_execution_time = ${x.maxSeconds},
                  timeout_overflow_mode = 'throw',
                  http_wait_end_of_query = 1,
                  max_bytes_before_external_sort = ${SORT_MAX_MEMORY_BYTES},
                  ${x.settingsLine}
                  ${NORM_COLS_SETTING}`
      : `SELECT ${SELECT}
         FROM (
           SELECT ${RAW_COLS}
           FROM ulp.credentials
           WHERE ${where}${x.conjunct}${cursorClause}
           ORDER BY ${orderBy}
           ${dedupeLimitBy(dedupe)}
           LIMIT {limit:UInt32}
         ) AS t
         SETTINGS max_execution_time = ${x.maxSeconds},
                  timeout_overflow_mode = 'throw',
                  http_wait_end_of_query = 1,
                  max_bytes_before_external_sort = ${SORT_MAX_MEMORY_BYTES},
                  ${x.settingsLine}
                  ${NORM_COLS_SETTING}`
    const dataParams = dedupeInWindow ? { ...allParams, windowLimit: limit * DEDUPE_WINDOW_FACTOR } : allParams
    const runPlainDataQuery = (): Promise<unknown[]> => executeQuery(dataSql(todaysData), dataParams) as Promise<unknown[]>
```

(g) Change `let plan: 'windows' | 'plain' | 'dictionary' = 'plain'` to `let plan: 'windows' | 'plain' | 'dictionary' | 'substring' = 'plain'`, and in `runDataQuery` replace the final `return runPlainDataQuery()` (the one after the `if (candidates) { ... }` block) with:

```ts
      const choice = await getSubstringChoice()
      if (choice) {
        const conjunct = substringConjunct(choice.token)
        const outcome = await runWithBudget('substring rows', () => executeQuery(
          dataSql({ conjunct: conjunct.sql, maxSeconds: SUBSTRING_BUDGET_SECONDS, settingsLine: `${PLAN_PROJECTIONS_OFF},` }),
          { ...dataParams, ...conjunct.params },
        ) as Promise<unknown[]>)
        if (outcome.ok) {
          plan = 'substring'
          return outcome.value
        }
      }
      return runPlainDataQuery()
```

(h) Update the two comments on the `plan` field: the one above `runDataQuery` ("The rows from the dictionary's candidates ...") gets the sentence `After that comes the substring plan (rarest whole word of a LIKE text), with its own 15 s budget; an overrun or failure there is not a 408, the plain query runs.`, and the response comment becomes `// Which plan answered the rows: 'windows' (lib/newest-first.ts), 'dictionary' (lib/search-dictionary-plan.ts), 'substring' (lib/search-substring-plan.ts) or 'plain'.`

- [ ] **Step 5: Run the new tests and every route test**

Run: `npx vitest run __tests__/credentials-route-substring.test.ts __tests__/credentials-route.test.ts __tests__/credentials-route-dictionary.test.ts __tests__/credentials-route-totals.test.ts __tests__/credentials-route-login-scope.test.ts __tests__/credentials-route-newest-first.test.ts __tests__/credentials-route-imported-range.test.ts __tests__/credentials-route-dedupe-window.test.ts __tests__/cursor-raw-columns.test.ts __tests__/ulp-normalize-setting.test.ts __tests__/credential-browse-defaults.test.ts 2>&1 | tail -15`
Expected: all pass. A failure in an older file means the refactor changed today's SQL text: fix the route (not the old test) unless it is the one pin of Step 3.

- [ ] **Step 6: Mutation checks**

(1) In the route temporarily drop the `${x.conjunct}` from the rows template (leave `''`): the "SQL is today's plus the conjunct" and the cursor tests must FAIL; restore. (2) Temporarily change `overflow: 'throw'` in the substring totals call to `'break'`: the totals SQL test must FAIL; restore. Re-run the new file: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/api/credentials/route.ts __tests__/credentials-route.test.ts __tests__/credentials-route-substring.test.ts
git commit -m "feat(search): the credentials route answers a LIKE text through its rarest whole word (substring plan)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The live parity test (real table, real tokenizer)

**Files:**
- Create: `__tests__/substring-plan-parity.live.test.ts`

**Interfaces:**
- Consumes: the route (Task 4), `resolveSubstringChoice`, `wholeTokens`, `SEARCH_INDEX_DEFINITIONS`.

- [ ] **Step 1: Write the test**

Create `__tests__/substring-plan-parity.live.test.ts`:

```ts
import { execSync } from 'node:child_process'
import { describe, expect, test, vi, afterAll } from 'vitest'

/**
 * LIVE parity check for the substring plan (lib/search-substring-plan.ts): the route's answer through the plan must be IDENTICAL to today's plain
 * query, page after page, for rows and for totals, and never more than SSP_MAX_SLOWDOWN (1.2) times slower. Skipped unless SSP_PARITY=1; it talks to
 * the real ClickHouse (the running ulpsuite_clickhouse container) and prints timings. It drives the real GET /api/credentials handler; the plain query
 * is forced with `token_plans=0`, so the SQL it compares against cannot drift from the route's. A text with no whole word under the gate runs today's
 * query in both cases, so it is reported and skipped (nothing to compare, and each run would take 35-80 s).
 *
 *   SSP_PARITY=1 npx vitest run __tests__/substring-plan-parity.live.test.ts
 *   SSP_PARITY=1 SSP_NEEDLES='/a/b.php,c:d' SSP_SORTS=domain_asc,imported_desc SSP_PAGES=1 npx vitest run __tests__/substring-plan-parity.live.test.ts
 *
 *   SSP_NEEDLES   comma list of texts to search (default: three invented ones). Real search terms belong in YOUR environment, never in this file:
 *                 the repository is public.
 *   SSP_SORTS     default domain_asc,imported_desc      SSP_DEDUPES  default 1      SSP_PAGES  default 2      SSP_MAX_SLOWDOWN  default 1.2
 *
 * The second half needs no data: it checks the whole-token rule against ClickHouse itself on two tiny scratch tables (ulp.zz_ssp_*, dropped at the
 * end): the production text index cuts tokens at exactly the ASCII non-alphanumerics, and for thousands of generated (needle, haystack) pairs, every
 * whole word of a needle is a token of every haystack the needle's LIKE matches. It is also the tripwire for a ClickHouse upgrade that changes the
 * tokenizer.
 *
 * The user profile has the query cache on and ClickHouse keeps a per-granule condition cache, so both are dropped before EVERY call.
 */
const LIVE = process.env.SSP_PARITY === '1'
const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(',').map(s => s.trim()).filter(Boolean)
const NEEDLES = list(process.env.SSP_NEEDLES, '/zzqxnonexistent/page.php,index.php?id=,a b')
const SORTS = list(process.env.SSP_SORTS, 'domain_asc,imported_desc')
const DEDUPES = list(process.env.SSP_DEDUPES, '1')
const PAGES = Number(process.env.SSP_PAGES ?? 2)
const MAX_SLOWDOWN = Number(process.env.SSP_MAX_SLOWDOWN ?? 1.2)

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

type Timing = { scenario: string; page: string; plainMs: number; planMs: number; plan: string; rows: number }
const timings: Timing[] = []
const skipped: string[] = []

describe.skipIf(!LIVE)('substring plan parity on the live table', () => {
  afterAll(() => {
    console.log('\nscenario | page | plain ms | plan ms (plan) | rows')
    for (const t of timings) console.log(`${t.scenario} | ${t.page} | ${t.plainMs} | ${t.planMs} (${t.plan}) | ${t.rows}`)
    for (const s of skipped) console.log(s)
  })

  test('a text whose rarest word is absent from the data is answered by the plan, quickly', async () => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const t0 = Date.now()
    const rows = await (await GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent('/zzqxnonexistent/page.php')}&skip_totals=1&sort=domain_asc`))).json()
    const totals = await (await GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent('/zzqxnonexistent/page.php')}&totals_only=1`))).json()
    console.log(`absent word: rows plan=${rows.plan}, totals plan=${totals.plan}, both in ${Date.now() - t0} ms`)
    expect(rows).toMatchObject({ success: true, plan: 'substring', results: [] })
    expect(totals).toMatchObject({ success: true, plan: 'substring', total: 0, raw_total: 0 })
  }, 120_000)

  const matrix = NEEDLES.flatMap((needle, i) => SORTS.flatMap(sort => DEDUPES.map(dedupe => ({ needle, sort, dedupe, label: `text #${i + 1}` }))))

  test.each(matrix)('$label | $sort | Unique=$dedupe', async ({ needle, sort, dedupe, label }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { getClient } = await import('@/lib/clickhouse')
    const { resolveSubstringChoice, substringNeedleFromQuery } = await import('@/lib/search-substring-plan')
    const { resetSearchPlanGateCache } = await import('@/lib/search-plan-gate')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')

    const text = substringNeedleFromQuery(needle, false)
    resetSearchPlanGateCache()
    const choice = text ? await resolveSubstringChoice(text) : null
    if (!choice) {
      skipped.push(`${label}: no whole word under the gate (or not a substring search): today's query runs, nothing to compare`)
      return
    }

    const call = async (qs: string, cold: boolean) => {
      if (cold) resetSearchPlanGateCache()
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
      await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
      const ms = Date.now() - t0
      return { ms, body: await res.json() }
    }
    const base = `q=${encodeURIComponent(needle)}&sort=${sort}&limit=200&exclude_noise=1&dedupe=${dedupe}`
    const scenario = `${label} (rarest word ${choice.hits} hits) ${sort} U${dedupe}`
    const slow = (plan: number, plain: number) => plan <= plain * MAX_SLOWDOWN + 1000

    let cursor = ''
    for (let page = 1; page <= PAGES; page++) {
      const extra = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const plain = await call(`${base}&skip_totals=1&token_plans=0${extra}`, true)
      const planned = await call(`${base}&skip_totals=1${extra}`, page === 1)
      expect(plain.body.success, `page ${page} (plain): ${JSON.stringify(plain.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.success, `page ${page}: ${JSON.stringify(planned.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.results).toEqual(plain.body.results)
      expect(planned.body.next_cursor).toEqual(plain.body.next_cursor)
      // Newest first is answered by the time windows when they can (a term concentrated in new data); the plan only after they hand off.
      expect(sort === 'imported_desc' ? ['substring', 'windows'] : ['substring'], `which plan answered: ${scenario} page ${page}`).toContain(planned.body.plan)
      expect(slow(planned.ms, plain.ms), `${scenario} page ${page}: plan ${planned.ms} ms against plain ${plain.ms} ms`).toBe(true)
      timings.push({ scenario, page: String(page), plainMs: plain.ms, planMs: planned.ms, plan: planned.body.plan, rows: plain.body.results.length })
      if (!plain.body.next_cursor) break
      cursor = plain.body.next_cursor
    }

    const plainTotals = await call(`${base}&totals_only=1&token_plans=0`, true)
    const plannedTotals = await call(`${base}&totals_only=1`, true)
    expect(plannedTotals.body.success).toBe(true)
    expect({ total: plannedTotals.body.total, raw_total: plannedTotals.body.raw_total })
      .toEqual({ total: plainTotals.body.total, raw_total: plainTotals.body.raw_total })
    expect(plannedTotals.body.plan).toBe('substring')
    expect(slow(plannedTotals.ms, plainTotals.ms), `${scenario} totals: plan ${plannedTotals.ms} ms against plain ${plainTotals.ms} ms`).toBe(true)
    timings.push({ scenario, page: 'totals', plainMs: plainTotals.ms, planMs: plannedTotals.ms, plan: plannedTotals.body.plan, rows: Number(plannedTotals.body.total) })
  }, 60 * 60_000)
})

// ── the whole-token rule against ClickHouse itself ──────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe.skipIf(!LIVE)('the whole-token rule agrees with ClickHouse', () => {
  const INDEX_TABLE = 'ulp.zz_ssp_index'
  const PAIRS_TABLE = 'ulp.zz_ssp_pairs'
  afterAll(async () => {
    const { getClient } = await import('@/lib/clickhouse')
    await getClient().command({ query: `DROP TABLE IF EXISTS ${INDEX_TABLE}` })
    await getClient().command({ query: `DROP TABLE IF EXISTS ${PAIRS_TABLE}` })
  })

  test('the production text index cuts tokens at exactly the ASCII non-alphanumerics; every other character, non-ASCII ones included, is part of a token', async () => {
    const { getClient } = await import('@/lib/clickhouse')
    const { SEARCH_INDEX_DEFINITIONS } = await import('@/lib/search-index-definitions')
    const client = getClient()
    await client.command({ query: `DROP TABLE IF EXISTS ${INDEX_TABLE}` })
    await client.command({ query: `CREATE TABLE ${INDEX_TABLE} (id UInt32, url String) ENGINE = MergeTree ORDER BY id` })
    const def = SEARCH_INDEX_DEFINITIONS.find(d => d.name === 'idx_inv_url')!
    await client.command({ query: def.addIndexSql(INDEX_TABLE) }) // the production DDL, verbatim, on an empty table: inserted rows are indexed
    const sample = [...Array(128).keys()].map(c => String.fromCharCode(c)).concat(['é', '–', ' ', '€', '日', '😀', 'ß', 'À', '·', '“'])
    await client.insert({ table: INDEX_TABLE, format: 'JSONEachRow', values: sample.map((c, id) => ({ id, url: `q${c}Abc${c}q` })) })
    await client.command({ query: `OPTIMIZE TABLE ${INDEX_TABLE} FINAL` })

    const explain = await (await client.query({ query: `EXPLAIN indexes = 1 SELECT id FROM ${INDEX_TABLE} WHERE hasToken(url, 'abc')`, format: 'TSVRaw' })).text()
    expect(explain).toContain('idx_inv_url')
    const found = ((await (await client.query({ query: `SELECT id FROM ${INDEX_TABLE} WHERE hasToken(url, 'abc') ORDER BY id`, format: 'JSONEachRow' })).json()) as Array<{ id: number }>)
      .map(r => Number(r.id))
    const expected = sample.map((c, id) => ({ c, id })).filter(({ c }) => c.charCodeAt(0) < 128 && !/[A-Za-z0-9]/.test(c)).map(({ id }) => id)
    expect(found).toEqual(expected)
  }, 120_000)

  test('property: every whole word of a needle is a token of every haystack the needle matches', async () => {
    const { getClient } = await import('@/lib/clickhouse')
    const { wholeTokens } = await import('@/lib/search-substring-plan')
    const client = getClient()
    await client.command({ query: `DROP TABLE IF EXISTS ${PAIRS_TABLE}` })
    await client.command({ query: `CREATE TABLE ${PAIRS_TABLE} (id UInt32, needle String, haystack String) ENGINE = MergeTree ORDER BY id` })

    const rand = mulberry32(20261013)
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
    const ALPHABET = ['a', 'B', '1', 'x9', '.', '/', '-', '_', '%', 'é', ' ', ':', '~', '\\', '€', '😀', '\t', 'login']
    const FILL = ['a', 'Z', '7', '.', '/', ' ', 'é', '_', '%', '-', '😀', '~', 'ledger']
    const fill = (max: number) => Array.from({ length: Math.floor(rand() * (max + 1)) }, () => pick(FILL)).join('')
    const rows: Array<{ id: number; needle: string; haystack: string }> = []
    for (let n = 0; n < 700; n++) {
      const needle = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => pick(ALPHABET)).join('')
      for (let h = 0; h < 8; h++) {
        // Expand the needle the way a LIKE pattern reads it: % is any string, _ any one character; then put arbitrary text on both sides.
        const expanded = Array.from(needle).map(ch => (ch === '%' ? fill(3) : ch === '_' ? pick(FILL) : ch)).join('')
        rows.push({ id: rows.length, needle, haystack: fill(3) + expanded + fill(3) })
      }
    }
    await client.insert({ table: PAIRS_TABLE, format: 'JSONEachRow', values: rows })
    const answered = (await (await client.query({
      query: `SELECT id, needle, haystack LIKE concat('%', needle, '%') AS m, tokens(lower(haystack), 'splitByNonAlpha') AS toks FROM ${PAIRS_TABLE}`,
      format: 'JSONEachRow',
    })).json()) as Array<{ id: number; needle: string; m: number; toks: string[] }>

    let matched = 0
    let withWords = 0
    const failures: string[] = []
    for (const r of answered) {
      if (!Number(r.m)) continue
      matched++
      const words = wholeTokens(r.needle)
      if (words.length) withWords++
      for (const w of words) if (!r.toks.includes(w)) failures.push(`pair ${r.id}: word ${JSON.stringify(w)} of needle ${JSON.stringify(r.needle)} is not a token`)
    }
    console.log(`property: ${rows.length} pairs, ${matched} matched by LIKE, ${withWords} of those with at least one whole word, ${failures.length} failures`)
    expect(matched).toBeGreaterThan(500)
    expect(withWords).toBeGreaterThan(50)
    expect(failures.slice(0, 5)).toEqual([])
  }, 120_000)
})
```

- [ ] **Step 2: Run the rule checks first (no big queries)**

Run: `SSP_PARITY=1 SSP_NEEDLES='/zzqxnonexistent/page.php' npx vitest run __tests__/substring-plan-parity.live.test.ts -t "token" 2>&1 | tail -25`
Expected: the index test and the property test pass; the property line shows several thousand pairs, over 500 matched, over 50 with a whole word, 0 failures.

- [ ] **Step 3: Mutation check of the property test**

Temporarily change `isHardSeparator` in `lib/search-substring-plan.ts` to `c => true` and drop the end-of-needle check; re-run Step 2: the property test must FAIL with a "is not a token" line; restore both; re-run: pass. (Scratch tables `ulp.zz_ssp_*` are dropped by the test; confirm with `docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT count() FROM system.tables WHERE database='ulp' AND name LIKE 'zz\\_%'"` printing 0.)

- [ ] **Step 4: Run the full parity on the owner's real texts (read-only, in the background)**

The owner's texts come from the shell environment (the 13 distinct LIKE texts of the last 14 days are in the scratchpad file `needles.txt`, one per line, in LIKE form with the percent signs; strip those):

```bash
SSP_NEEDLES="$(sed -e 's/^%//' -e 's/%$//' /tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad/needles.txt | paste -sd, -)" \
SSP_PARITY=1 SSP_SORTS=domain_asc,imported_desc SSP_PAGES=1 \
npx vitest run __tests__/substring-plan-parity.live.test.ts > /tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad/ssp-live.log 2>&1
```
Expected: it takes about 30 minutes (each eligible text is compared against today's 35 to 42 s query, rows and totals, in two sorts; texts with no word under the gate are skipped and listed). End state: every test passes, the timing table shows the plan between 0.4 and about 11 s with `plan` = `substring`, the skipped lines list the texts that keep today's query. A FAIL (a different page, a different total, a plan slower than 1.2 times plain plus 1 s) is a bug in the plan or its gate: stop and fix before going on.

- [ ] **Step 5: Commit**

```bash
git add __tests__/substring-plan-parity.live.test.ts
git commit -m "test(search): live parity for the substring plan, and the whole-token rule checked against the real tokenizer" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, configuration, the whole gate, push

**Files:**
- Modify: `README.md`, `.env.example`, `docker-compose.yml`, the spec's status line, this plan's boxes.

- [ ] **Step 1: Configuration**

`docker-compose.yml`, after `SEARCH_DICT_SETTLE_SECONDS: ${SEARCH_DICT_SETTLE_SECONDS:-}` in the app service:

```yaml
      # Token plans (lib/search-plan-gate.ts) -- optional. Empty = on. SEARCH_TOKEN_PLANS=0 runs every search with the original query.
      SEARCH_TOKEN_PLANS: ${SEARCH_TOKEN_PLANS:-}
```

`.env.example`, after the `SEARCH_DICT_SETTLE_SECONDS` block:

```
# ─── Token plans (substring searches, later single words) ───────────────────────
# A search for one text with a special character in it (a path, user:pass, a space) used to read every row (35-80 s). When one whole word of the
# text is rare in the text indexes the page asks for that word as well: the same rows, order and totals, 0.4-11 s. See the README, "Faster substring
# searches". SEARCH_TOKEN_PLANS=0 runs every search with the original query (no rebuild needed).
# SEARCH_TOKEN_PLANS=1
```

- [ ] **Step 2: README**

In `README.md`:

(1) In the dictionary section, change "(`dictionary`, `windows` or `plain`)" to "(`dictionary`, `windows`, `substring` or `plain`)".

(2) Directly above `### Content deduplication (storage)` add:

```markdown
### Faster substring searches (speed)

A search for one text that contains a special character (a path such as `/ledger/login.php`, a pair such as `user:pass`, anything with a space) cannot use a word index: it is a plain substring scan of the URL, the login and the password, which read about 95 GiB (35-80 s). The page now takes the whole words inside the text (`ledger` and `login` in the example; a word at either end of the text could be part of a longer one, so it does not count), counts each one through the text indexes in about 0.3 s, and when the rarest has at most 50,000 hits it adds that word as one more condition to the same query. The original substring test stays in the query, so the rows, order, cursors and totals are the same (compared exactly on real searches); only rows that cannot match are skipped: 0.4-11 s instead of 35-42 s in the measurements. A text with no whole word, or whose words are all common, runs the original query.

- A plan query has a 15 s budget; over it, or on any error, the original query runs (the page never shows a time-out because of the plan).
- `SEARCH_TOKEN_PLANS=0` switches it off (no rebuild needed). `/api/credentials?...&token_plans=0` forces the original query for one request, and the response's `plan` says `substring` when the plan answered.
- Design and measurements: `docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md`.
```

(3) In the performance table, after the row that starts `| Exact domain / email lookup`, add:

```markdown
| Substring search (one text with a special character, such as a path) | 35-42 s before; 0.4-11 s when a whole word of the text matches at most 50,000 rows, otherwise unchanged. The response's `plan` says `substring` |
```

- [ ] **Step 3: Spec and plan status**

At the top of `docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md` change the Status line to say: B (the substring plan) implemented in `docs/superpowers/plans/2026-10-13-substring-search-plan.md`, A (the word plan) still design only; add under "Components" one sentence that the route's SQL templates take the plan's additions (the deviation above). Tick every box in this plan.

- [ ] **Step 4: The whole gate (run once)**

```bash
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components __tests__/ulp-search-word-leaves.test.ts __tests__/search-plan-gate.test.ts __tests__/search-substring-plan.test.ts __tests__/credentials-route-substring.test.ts __tests__/substring-plan-parity.live.test.ts; echo "eslint exit $?"
npx vitest run 2>&1 | tail -15
```
Expected: `tsc exit 0`, `eslint exit 0`, vitest: all files passed, 0 failed. Any failure: fix it before going on (a test that pinned the old behaviour is updated; nothing is skipped).

- [ ] **Step 5: Commit and push**

```bash
git add README.md .env.example docker-compose.yml docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md docs/superpowers/plans/2026-10-13-substring-search-plan.md
git commit -m "docs(search): the substring plan (README, env switch, spec and plan status)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push origin main
```
Expected: CI (typecheck, test, lint, build) green on the pushed head (`gh run list --limit 1`, once).

---

### Task 7: Roll out

**Files:** none new.

- [ ] **Step 1: Rollback tag, then build the candidate from the merged commit**

```bash
STAMP=$(date -u +%Y%m%d-%H%Mz)
docker tag "$(docker inspect ulpsuite_app --format '{{.Image}}')" "ulp-suite-app:rollback-$STAMP"
SCRATCH=/tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad
mkdir -p "$SCRATCH/dockercfg" && echo '{}' > "$SCRATCH/dockercfg/config.json"
rm -rf "$SCRATCH/ssp-build" && mkdir -p "$SCRATCH/ssp-build" && git archive HEAD | tar -x -C "$SCRATCH/ssp-build"
DOCKER_CONFIG="$SCRATCH/dockercfg" docker build -t ulp-suite-app:substring-candidate "$SCRATCH/ssp-build"
```
Expected: the build ends with the image tagged `ulp-suite-app:substring-candidate`; `ulp-suite-app:latest` is untouched (production keeps running the old image).

- [ ] **Step 2: Deploy `app` only**

```bash
export DOCKER_CONFIG=/tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad/dockercfg
docker tag ulp-suite-app:substring-candidate ulp-suite-app:latest
docker compose -p ulp-suite -f /home/cole/ulp-suite/docker-compose.yml --project-directory /home/cole/ulp-suite --env-file /home/cole/ulp-suite/.env up -d --no-deps app
```
Expected: the app container is recreated (about 30 s); `docker inspect ulpsuite_app --format '{{.State.Health.Status}} {{.RestartCount}}'` reads `healthy 0`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login` reads 200; the container env has `SEARCH_TOKEN_PLANS=` empty (on) and still `CONTENT_DEDUP_APPLY=false`; the deployed bundle contains the plan (`docker exec ulpsuite_app sh -c 'grep -rl token_plans /app/.next/server/app/api/credentials | head -1'` prints a file).

- [ ] **Step 3: Live parity at the deployed commit (read-only)**

Re-run the quick form of Task 5 Step 4 on three of the owner's texts (one near the gate, one rare, one that is skipped) with `SSP_PAGES=1 SSP_SORTS=domain_asc`, and the two rule checks of Task 5 Step 2. Expected: all pass.

- [ ] **Step 4: Record it**

Set the spec's status line to `B implemented and deployed locally on 2026-10-13` with the commit, image id and rollback tag; update the memory notes (`project_search_levers_measured_2026_10_13.md`, the ledger, `MEMORY.md`) with what shipped, the live numbers and the follow-ups (lever A, the word plan; the owner trying a substring search in the browser); commit and push the docs (`docs(search): ...`).
