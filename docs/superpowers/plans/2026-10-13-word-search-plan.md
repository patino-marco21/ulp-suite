# Single-word search plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (The owner chose inline execution: one check per step, no repeated re-checks.)

**Goal:** A search for one word (all fields) gets its totals in 0.3 to 9 seconds instead of 13 to 22, and, when the word is rare, its first rows in 0.1 to 2 seconds instead of 10 to 17, with the same rows, order, cursors and totals as today's query and never more than 1.2 times slower.

**Architecture:** The word's legacy predicate is `P = L or HOST or EMAILDOM`. `L` (the three `hasToken` leaves) is answered by the text indexes in 0.2 to 0.3 s however many rows match; `HOST` and `EMAILDOM` are substring tests on `url_host` and `email_domain` that the domain-search dictionaries can enumerate. The plan splits `P` into three DISJOINT branches over the same dictionaries and the same offset sub-select as the domain plan (`lib/search-dictionary-plan.ts`): T = the route's WHERE with the search replaced by `L`; H = `P and domain in D and not L`; E = `P and domain not in D and not L and the rows of the e-mail-domain candidates`. The route's WHERE and keyset clause stay verbatim in every branch; a gate decides whether the rows request may use the plan (totals always may, within the dictionary caps); a time budget and a fallback to today's query cover everything else. The gate module, the kill switch, `runWithBudget` and the text-index probe come from plan 1 (the substring plan, shipped).

**Tech Stack:** TypeScript, Next.js route handlers, ClickHouse 26.3 (`text()` indexes with direct read, projections, `_part_offset`), vitest, the isolated rehearsal stack.

Spec: `docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md`, section A (approved by the owner on 2026-10-13: "Continue"). This is plan 2 of 2.

## Global Constraints

- A plan only ADDS to today's query: every branch keeps the route's WHERE, filters, cursor, ordering, de-duplication and limit; the result must equal today's. Any plan that errors, runs over its budget, is not eligible, or whose gate says no, falls back to today's query for that request. The rows request and the totals request decide independently.
- Eligible: exactly one positive, non-regex term of type `token` in scope All fields (no `login:` prefix), made of ASCII letters and digits only (a word with a hyphen or underscore keeps today's query), the dictionary fresh, the caps respected (3,000 candidate domains, 300 candidate e-mail domains, the literal size limits 90,000 and 20,000 bytes), `proj_email_domain_rev` ready when there are e-mail-domain candidates.
- Candidates: `D` from `url_host LIKE %w%` in `ulp.search_host_dict`, `E` from `email_domain LIKE %w%` in `ulp.search_emaildomain_dict`; the patterns are buildULPWhere's own parameters (`tok0`, `tlk0`); the empty `domain` stays in `D` when it is there.
- Branches: T = the route's WHERE with the search clause replaced by the word's three text-index leaves alone; H = legacy WHERE and cursor `and domain in D and not (leaves)`; E = legacy WHERE and cursor `and domain not in D and not (leaves) and (_part, _part_offset) in (rows of E through proj_email_domain_rev)`. `and domain not in D` is left out when `D` is empty; H is left out when `D` is empty; E when `E` is empty; T is always there. Results are merged by the route's ORDER BY, de-duplication and LIMIT; totals combine aggregate states (`dedupeCountPartial`).
- Settings: T and H carry `SETTINGS optimize_use_projections = 0` on the branch (a projection part has no text index, so there `hasToken` is the plain case-SENSITIVE function and `not L` would disagree with T); E keeps projections ON and carries `optimize_move_to_prewhere = 0, query_plan_optimize_lazy_materialization = 0` as in the domain plan; the OUTER query never carries `optimize_use_projections = 0` (it would make branch E 4 to 15 times slower).
- Totals: used whenever eligible, budget 12 s with `timeout_overflow_mode = 'throw'`, then today's query. Rows: used only when `|D|` is at most 300, `|E|` at most 100 and the text indexes have at most 20,000 hits for the word (the capped probe of the gate module), budget 4 s with `'throw'`, then today's query. These three numbers are STARTING values: Task 5 measures about 20 words through the real route and fixes them so that no tested word is more than 1.2 times slower than today.
- Kill switches: `SEARCH_DICTIONARY=0` and `SEARCH_TOKEN_PLANS=0` in `.env`; per request `dictionary=0` and `token_plans=0`. The response's `plan` field says `words` when the word plan answered.
- No DDL, no index, no data. Multi-term searches, negation, regex, the login scopes, addresses, domains, substring texts and the list exports keep their paths; the Newest-first windows still run first for `sort=imported_desc`.
- The repository is public: tests and docs use invented words only (`ledger`, `login`, `example.test`); never a real search term. The owner's words reach the live tests through `SWP_WORDS` in the shell environment.
- Gate before every merge: `npx tsc --noEmit` exit 0, eslint 0 on `app lib components` plus every new file, `npx vitest run` all green. Check exit codes explicitly.
- Rollback tag of the running image BEFORE building; build with `git archive`; recreate only `app`. The image that is rehearsed on the isolated stack is the image that is deployed.

---

## Execution notes (2026-10-13, inline)

Executed in this session, one check per step. Deviations from the text below, all recorded with their evidence in "Calibration result" above: the rows gate is (candidate domains, rows behind the candidate e-mail domains) instead of (domains, e-mail domains, text hits), with its own probe `probeEmailDomainRows` in place of the text-hit probe on the word path, a totals gate was added, the rows budget is 8 s, and `runWithBudget` remembers an overrun per plan and word (the substring plan uses it too); the live test takes `SWP_EXTRA` for extra query parameters and its totals expectation follows the totals gate. Two older route tests pinned the old single-word path and were updated (a word no longer "never touches the dictionary"; the date-range contrast of the login-scope test forces today's query with `token_plans=0`). The first calibration run reported "finished" lines whose pass or fail marker my monitor filter had stripped: 10 of 21 words had in fact FAILED, all on the rows plan's own 4 s budget with the gate deliberately open, each with rows identical to today's (the fallback worked), which is what led to measuring with the budgets raised. The rehearsal's first full run failed 2 of 79 checks: a stack whose app started before ClickHouse accepted connections had NO text indexes (see the spec), and a blank-domain row is junk that Declutter hides; the script now installs and verifies the production text indexes itself and looks for that row with Declutter off (81 of 81). Results: gate green (tsc 0, eslint 0, 241 files / 3,590 tests); live parity 25/25 with the shipped gates, 7/7 (Newest first), 5/5 (cursor page, e-mail sort, Unique off), 6/6 after the deploy; deployed image `24720d7788c3` (main d252e5d), rollback tag `ulp-suite-app:rollback-20261013-2023z` (= `d12d21f8d982`, the substring-plan image).

## Facts measured while writing this plan (2026-10-13, live table, 1.84B rows, dictionary fresh)

- The owner's one-word searches of the last 14 days (`system.query_log`): 17 distinct words. Ten are common words over the dictionary caps (3,001 candidate domains or more): they keep their path (several are answered in 0.3 to 0.9 s by the Newest-first windows). Seven are inside the caps: six of them rare (candidates 0 to 123 domains and 0 to 27 e-mail domains, 0 to 1,532 text hits) with logged times of 26 to 150 s, and one with 1,649 domains, 212 e-mail domains and 3,975 hits (so totals only). Two of the rare ones match nothing at all.
- `EXPLAIN` of the three branches for a word with 123 domains and 27 e-mail domains: all three read `ulp.credentials` (the base table), none a projection; the primary key keeps 1,262 of 28,396 granules for H and 113 for E.
- Settings scope (word with 123 domains, merged rows query, 200 rows, identical result in all variants): no projection setting 2.34 s; `optimize_use_projections = 0` on T and H only (their own `SETTINGS`) 1.90 s; also on E 9.35 s. For a word with 11 domains: 0.42, 0.29 and 0.27 s. So the per-branch setting does not leak into the other branches, and E must keep projections on.
- Totals, three-branch plan against today's totals, both numbers identical on every word: rare words 13.2 to 13.5 s against 0.33 to 1.19 s; the 1,649-domain word 14.9 s against 7.7 s; the heaviest words inside the caps (46,588 / 42,319 / 33,747 unique, 33,747 to 49,718 matching rows) 21 to 22 s against 6.2 to 7.6 s. No word tried made the totals plan slower, so there is no totals gate.
- Common passwords and keyboard patterns (`qwerty`, `123456`, `password`, ...) all exceed the caps (candidate e-mail domains in the hundreds to thousands): they keep today's query.
- The capped probe (`count()` over `LIMIT 50001`) of plan 1 takes 0.13 to 0.6 s and is cached ten minutes per word; it is the rows gate's third number.

## Calibration result (2026-10-13, Task 5) — the gate in this plan's text was replaced

The starting gate below (candidate domains, candidate e-mail domains, text-index hits; rows budget 4 s) did not survive the measurement. 38 words inside the dictionary caps were run through the real route (domain A-Z, page 1, Unique on, cold caches, rows and totals, identical results in every run) with the gates relaxed and both budgets raised to 60 s, then branch by branch: the owner's 7 rare or mid-size words, 16 public brand words, and 16 institution-like words found through the e-mail dictionary to fill the gaps.

- **What does not predict the cost:** the number of candidate e-mail domains (words with 30, 32, 40, 51 and 59 of them won 4-7 times; words with 32, 36 and 37 lost 1.4-2 times) and the text-index hit count (97,000 hits won 2.3 times, 1,800 hits lost). The text probe is gone from the word path.
- **What does:** branch E reads each row of the matching e-mail domains from the base table by position (`proj_email_domain_rev` holds `_part_offset` only), so its cost follows the number of ROWS behind those domains: 0.3-1.0 s for up to about 200 rows (nine words), 2-8 s for 400 to 900, 6-26 s from 1,400 to 7,900. Branches T (0.5-2.6 s) and H (0.1-3.1 s) stayed cheap for every word with at most 300 candidate domains. One probe through the projection counts those rows in 0.1-0.4 s (`probeEmailDomainRows`).
- **Rows gate:** at most 300 candidate domains and at most 300 such rows. 14 of 14 words won, 2.9 to 14 times (plan 1.2-4.6 s, today's rows query 9-19 s). The first loss in the sample is at 1,428 such rows (0.7 times); the worst, at 7,876 rows, took 44.9 s against 11.1 s.
- **Totals gate:** at most 5,000 such rows. Every word tried won, 1.7 to 14.5 times, the slowest plan took 10.1 s; at 6,700-7,900 rows the plan took 8.4-12.6 s against 14-15 s, which is too close to the 12 s budget to be worth it.
- **Budgets:** rows 8 s (the slowest admitted word needs 4.6 s; the 4 s of the spec would have cut off real wins in the first, deliberately relaxed run, which then fell back to today's query with identical rows, as designed), totals 12 s. An overrun is remembered for ten minutes per plan and word (`runWithBudget` with a key), so a page turn or a filter change does not pay the budget again.
- The three limits are tunable by the environment: `SEARCH_WORD_ROWS_MAX_DOMAINS` (300), `SEARCH_WORD_ROWS_MAX_EMAIL_ROWS` (300) and `SEARCH_WORD_TOTALS_MAX_EMAIL_ROWS` (5,000).

## File Structure

- Modify `lib/search-dictionary-plan.ts`: `WordTerm`, `wordTermFromQuery`, `TextBranch`, `wordTextBranch`, `resolveWordCandidates` (the shared end of both lookups becomes `finishCandidates`; the cache becomes `resolveCached`), and `buildDictionaryRowsSql` / `buildDictionaryTotalsSql` take optional `text`, `maxSeconds`, `overflow`.
- Modify `lib/search-plan-gate.ts`: `wordRowsMaxDomains/EmailDomains/TextHits` (environment-tunable), `wordRowsGate`, `WORD_ROWS_BUDGET_SECONDS`, `WORD_TOTALS_BUDGET_SECONDS`.
- Modify `app/api/credentials/route.ts`: the word plan in `runTotals` and `runDataQuery`, `plan: 'words'`.
- Modify `scripts/e2e-search-dictionary.ts`: the word scenarios for the isolated stack. Modify `docker-compose.yml`, `.env.example`, `README.md`, the spec's status line.
- Tests: create `__tests__/search-word-plan.test.ts`, `__tests__/search-word-plan-sql.test.ts`, `__tests__/credentials-route-words.test.ts`, `__tests__/word-plan-parity.live.test.ts`; modify `__tests__/search-plan-gate.test.ts`.

---

### Task 1: The word term, the text branch and the candidates

**Files:**
- Modify: `lib/search-dictionary-plan.ts`
- Test: `__tests__/search-word-plan.test.ts` (create)

**Interfaces:**
- Consumes: `wordLeaves`, `parseULPQuery`, `buildULPWhere` (`lib/ulp-search.ts`); `searchTokenPlansEnabled` (`lib/search-plan-gate.ts`).
- Produces (all exported from `lib/search-dictionary-plan.ts`):
  - `interface WordTerm { word: string; like: string }`
  - `wordTermFromQuery(q: string, regex: boolean, scope?: SearchScope): WordTerm | null`
  - `interface TextBranch { where: string; exclude: string }`
  - `wordTextBranch(base: string, qClause: string): TextBranch | null`
  - `resolveWordCandidates(term: WordTerm, deps?: PlannerDeps): Promise<DictionaryCandidates | null>`

- [x] **Step 1: Write the failing tests**

Create `__tests__/search-word-plan.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  wordTermFromQuery, wordTextBranch, resolveWordCandidates, resolveDictionaryCandidates, resetDictionaryPlanCache, type WordTerm,
} from '@/lib/search-dictionary-plan'
import { buildULPWhere, parseULPQuery, wordLeaves } from '@/lib/ulp-search'
import type { DictionaryStatus } from '@/lib/search-dictionary'

const freshStatus = (fp = 'fp-1'): DictionaryStatus => ({
  state: 'fresh', fingerprint: fp, builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
})
const notFresh = (state: DictionaryStatus['state']): DictionaryStatus => ({ ...freshStatus(), state, fingerprint: null })
const WORD: WordTerm = { word: 'ledger', like: '%ledger%' }
const ready = async () => true

function lookupRun(data: { host?: string[]; email?: string[] }) {
  return vi.fn(async (sql: string, _params: Record<string, unknown> = {}) => {
    if (sql.includes('WHERE url_host LIKE {like:String}')) return (data.host ?? []).map(domain => ({ domain }))
    if (sql.includes('FROM ulp.search_emaildomain_dict')) return (data.email ?? []).map(email_domain => ({ email_domain }))
    return []
  })
}
const deps = (run: ReturnType<typeof lookupRun>, over: Record<string, unknown> = {}) => ({ run, status: async () => freshStatus(), projectionReady: ready, ...over })

beforeEach(() => { resetDictionaryPlanCache() })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('wordTermFromQuery', () => {
  test('one positive word gives the lowercase word and the very LIKE pattern the legacy predicate uses', () => {
    expect(wordTermFromQuery('ledger', false)).toEqual(WORD)
    expect(wordTermFromQuery('Ledger', false)).toEqual(WORD)
    expect(wordTermFromQuery('abc123', false)).toEqual({ word: 'abc123', like: '%abc123%' })
    expect(wordTermFromQuery('  ledger ', false)).toEqual(WORD)
  })

  test('the values are the ones buildULPWhere puts in its parameters, so the two cannot drift apart', () => {
    for (const q of ['ledger', 'Maria', 'x9']) {
      const { params } = buildULPWhere(parseULPQuery(q))
      expect(wordTermFromQuery(q, false)).toEqual({ word: params.tok0, like: params.tlk0 })
    }
  })

  test.each([
    ['a domain', 'ledger.com'],
    ['an address', 'john@example.test'],
    ['an @domain', '@example.test'],
    ['two terms', 'ledger,trezor'],
    ['a negated term', '-ledger'],
    ['a login: prefix', 'login:ledger'],
    ['a word with a hyphen', 'my-ledger'],
    ['a word with an underscore', 'my_ledger'],
    ['a text with a special character', '/ledger/login.php'],
    ['a text with a space', 'my ledger'],
    ['nothing', ''],
  ])('not eligible: %s', (_name, q) => {
    expect(wordTermFromQuery(q, false)).toBeNull()
  })

  test('regex mode and the login scopes are never eligible', () => {
    expect(wordTermFromQuery('ledger', true)).toBeNull()
    expect(wordTermFromQuery('ledger', false, 'login')).toBeNull()
    expect(wordTermFromQuery('ledger', false, 'login_contains')).toBeNull()
    expect(wordTermFromQuery('ledger', false, 'all')).toEqual(WORD)
  })
})

describe('wordTextBranch', () => {
  const LEAVES = wordLeaves('tok0')
  const QCLAUSE = buildULPWhere(parseULPQuery('ledger')).clause
  const WHERE = `1=1 AND (${QCLAUSE}) AND is_noise = 0`

  test('the same WHERE with the search replaced by the three text-index leaves alone, and the exclusion the other branches carry', () => {
    expect(wordTextBranch(WHERE, QCLAUSE)).toEqual({
      where: `1=1 AND (${LEAVES}) AND is_noise = 0`,
      exclude: ` AND NOT (${LEAVES})`,
    })
    expect(wordTextBranch(WHERE, QCLAUSE)!.where).not.toContain('url_host LIKE')
  })

  test('everything else in the WHERE is left exactly as it was, even text that looks like a replacement pattern', () => {
    const base = `1=1 AND (${QCLAUSE}) AND source_file = '$&$1$$' AND password_length >= 8`
    expect(wordTextBranch(base, QCLAUSE)!.where).toBe(`1=1 AND (${LEAVES}) AND source_file = '$&$1$$' AND password_length >= 8`)
  })

  test('null when the search clause is not in the WHERE exactly once: branch T would repeat the others (a row counted twice)', () => {
    expect(wordTextBranch('1=1 AND is_noise = 0', QCLAUSE)).toBeNull()
    expect(wordTextBranch(`(${QCLAUSE}) AND (${QCLAUSE})`, QCLAUSE)).toBeNull()
  })
})

describe('resolveWordCandidates', () => {
  test('two lookups only (hosts and e-mail domains), the word\'s own LIKE pattern, a cap one above each limit; sorted, de-duplicated, the blank domain kept', async () => {
    const run = lookupRun({ host: ['ledger.com', 'coinledger.com', 'ledger.com', ''], email: ['ledger.com', 'a.ledger.com'] })
    const c = await resolveWordCandidates(WORD, deps(run))
    expect(run).toHaveBeenCalledTimes(2)
    const params = run.mock.calls.map(call => call[1])
    expect(params).toEqual(expect.arrayContaining([{ like: '%ledger%', cap: 3001 }, { like: '%ledger%', cap: 301 }]))
    expect(c).toEqual({
      domains: ['', 'coinledger.com', 'ledger.com'],
      emailDomains: ['a.ledger.com', 'ledger.com'],
      empty: false,
      domainsLiteral: "['','coinledger.com','ledger.com']",
      emailRevLiteral: "['moc.regdel.a','moc.regdel']",
    })
  })

  test('every lookup has a time limit and bypasses the ClickHouse result cache', async () => {
    const run = lookupRun({ host: ['ledger.com'] })
    await resolveWordCandidates(WORD, deps(run))
    for (const [sql] of run.mock.calls) {
      expect(sql).toContain('max_execution_time = 8')
      expect(sql).toContain('use_query_cache = 0')
    }
  })

  test.each(['stale', 'missing', 'building', 'unknown', 'disabled'] as const)('a dictionary that is %s means today\'s query, and no lookup runs', async state => {
    const run = lookupRun({ host: ['ledger.com'] })
    expect(await resolveWordCandidates(WORD, { run, status: async () => notFresh(state), projectionReady: ready })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  test('SEARCH_DICTIONARY=0 and SEARCH_TOKEN_PLANS=off: null, and not even the status is read', async () => {
    for (const [name, value] of [['SEARCH_DICTIONARY', '0'], ['SEARCH_TOKEN_PLANS', 'off']]) {
      vi.stubEnv(name, value)
      const status = vi.fn(async () => freshStatus())
      expect(await resolveWordCandidates(WORD, { run: lookupRun({}), status, projectionReady: ready }), name).toBeNull()
      expect(status).not.toHaveBeenCalled()
      vi.unstubAllEnvs()
    }
  })

  test('a repeat reuses the answer; another fingerprint or another word looks again; the domain cache and the word cache are separate', async () => {
    const run = lookupRun({ host: ['ledger.com'] })
    await resolveWordCandidates(WORD, deps(run))
    await resolveWordCandidates(WORD, deps(run))
    expect(run).toHaveBeenCalledTimes(2)
    await resolveWordCandidates(WORD, { run, status: async () => freshStatus('fp-2'), projectionReady: ready })
    expect(run).toHaveBeenCalledTimes(4)
    await resolveWordCandidates({ word: 'trezor', like: '%trezor%' }, { run, status: async () => freshStatus('fp-2'), projectionReady: ready })
    expect(run).toHaveBeenCalledTimes(6)
    // a domain term whose text equals the word never reuses the word's answer
    await resolveDictionaryCandidates({ exact: 'ledger', suffix: '%.ledger', like: '%ledger%' }, { run, status: async () => freshStatus('fp-2'), projectionReady: ready })
    expect(run).toHaveBeenCalledTimes(10)
  })

  test('the rows request and the totals request the page sends together share ONE lookup (the in-flight promise)', async () => {
    const run = lookupRun({ host: ['ledger.com'], email: ['ledger.com'] })
    const [a, b] = await Promise.all([resolveWordCandidates(WORD, deps(run)), resolveWordCandidates(WORD, deps(run))])
    expect(run).toHaveBeenCalledTimes(2)
    expect(a).toBe(b)
  })

  describe('caps: above any of them the answer is "use today\'s query", and that verdict is remembered too', () => {
    test('more candidate domains than SEARCH_DICT_MAX_DOMAINS', async () => {
      vi.stubEnv('SEARCH_DICT_MAX_DOMAINS', '2')
      const run = lookupRun({ host: ['a.com', 'b.com', 'c.com'] })
      expect(await resolveWordCandidates(WORD, deps(run))).toBeNull()
      expect(run.mock.calls.find(c => String(c[0]).includes('search_host_dict'))![1]).toMatchObject({ cap: 3 })
      expect(await resolveWordCandidates(WORD, deps(run))).toBeNull()
      expect(run).toHaveBeenCalledTimes(2)
    })

    test('more e-mail domains than SEARCH_DICT_MAX_EMAIL_DOMAINS', async () => {
      vi.stubEnv('SEARCH_DICT_MAX_EMAIL_DOMAINS', '1')
      expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: ['ledger.com'], email: ['a.ledger.com', 'b.ledger.com'] })))).toBeNull()
    })

    test('a list of D that would not fit the SQL (90,000 bytes) and a list of E above 20,000 bytes', async () => {
      const longD = Array.from({ length: 2000 }, (_, i) => `d${i}.${'x'.repeat(50)}.test`)
      expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: longD })))).toBeNull()
      resetDictionaryPlanCache()
      const longE = Array.from({ length: 290 }, (_, i) => `${'y'.repeat(70)}${i}.ledger.com`)
      expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: ['ledger.com'], email: longE })))).toBeNull()
    })
  })

  test('a lookup that fails or times out means today\'s query, with one warning, and is not retried for a minute', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn().mockRejectedValue(new Error('Code: 159. Timeout exceeded: TIMEOUT_EXCEEDED'))
    let t = 0
    const d = { run, now: () => t, status: async () => freshStatus(), projectionReady: ready }
    expect(await resolveWordCandidates(WORD, d)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const calls = run.mock.calls.length
    t = 59_000
    expect(await resolveWordCandidates(WORD, d)).toBeNull()
    expect(run.mock.calls.length).toBe(calls)
    t = 61_000
    await resolveWordCandidates(WORD, d)
    expect(run.mock.calls.length).toBeGreaterThan(calls)
  })

  test('nothing in either lookup: an answer with empty lists (the text indexes may still match), without consulting the projection', async () => {
    const projectionReady = vi.fn(async () => true)
    const c = await resolveWordCandidates(WORD, { run: lookupRun({}), status: async () => freshStatus(), projectionReady })
    expect(c).toMatchObject({ empty: true, domains: [], emailDomains: [], domainsLiteral: '[]', emailRevLiteral: '[]' })
    expect(projectionReady).not.toHaveBeenCalled()
  })

  test('e-mail domains need proj_email_domain_rev on every part; without it, today\'s query. Without e-mail domains the projection does not matter.', async () => {
    const notReady = vi.fn(async () => false)
    expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: ['ledger.com'], email: ['ledger.com'] }), { projectionReady: notReady }))).toBeNull()
    expect(notReady).toHaveBeenCalledTimes(1)
    resetDictionaryPlanCache()
    const notReady2 = vi.fn(async () => false)
    expect(await resolveWordCandidates(WORD, deps(lookupRun({ host: ['ledger.com'] }), { projectionReady: notReady2 }))).not.toBeNull()
    expect(notReady2).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/search-word-plan.test.ts 2>&1 | tail -12`
Expected: FAIL (`wordTermFromQuery`, `wordTextBranch` and `resolveWordCandidates` are not exported).

- [x] **Step 3: Implement in `lib/search-dictionary-plan.ts`**

(a) Extend the header comment: directly before the line ` * The candidate lists are written into the SQL as literals (lib/clickhouse-literals.ts)` insert:

```
 * The same dictionaries answer a search for ONE WORD (plan 2026-10-13-word-search-plan.md). Its legacy predicate is `P = L or HOST or EMAILDOM`,
 * with L the three text-index leaves (wordLeaves in lib/ulp-search.ts), HOST = url_host LIKE '%w%' and EMAILDOM = email_domain LIKE '%w%'. L alone is
 * answered by the text indexes in 0.2-0.3 s however many rows match, so the plan splits P into three DISJOINT branches, each the route's WHERE and
 * keyset clause with one more conjunct:
 *   T: the search replaced by L                        (the text indexes)
 *   H: P AND domain IN D AND NOT L                     (primary key on `domain`)
 *   E: P AND domain NOT IN D AND NOT L AND offsets     (rows of the e-mail-domain candidates, through proj_email_domain_rev)
 * HOST can only hold inside D (D lists the domain of every dictionary pair whose host contains w), so H and E cover every row P admits that L does not.
 * T and H read the base table only (`optimize_use_projections = 0` on the branch): a projection part has no text index, so there `hasToken` is the
 * plain, case-SENSITIVE function and `NOT L` would disagree with T. E keeps projections ON (turning them off made it 4x slower, 9.4 s against 2.3 s,
 * on 2026-10-13) and every EXPLAIN showed it reading the base table.
 *
```

(b) Imports: change `import { parseULPQuery, buildULPWhere } from '@/lib/ulp-search'` to `import { parseULPQuery, buildULPWhere, wordLeaves } from '@/lib/ulp-search'`, and after the `search-dictionary` import add `import { searchTokenPlansEnabled } from '@/lib/search-plan-gate'`.

(c) After `dictionaryTermFromQuery` (before the `// ── the candidates` banner) add:

```ts
// ── the word ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WordTerm {
  /** The lowercase word, ASCII letters and digits only: buildULPWhere's `tok0`. */
  word: string
  /** `url_host LIKE like` and `email_domain LIKE like`, i.e. `%word%`: buildULPWhere's `tlk0`. */
  like: string
}

/**
 * The word, when the whole search is exactly one positive, non-regex term of the `token` type looked up in every column and made of ASCII letters and
 * digits only; null for everything else (a domain, an address, several terms, negation, regex, a login scope, a text with a special character, a word
 * with a hyphen or underscore), which keeps today's query. The values come out of buildULPWhere's own parameters so they cannot drift from it.
 */
export function wordTermFromQuery(q: string, regex: boolean, scope: SearchScope = 'all'): WordTerm | null {
  if (regex) return null
  const tokens = parseULPQuery(q, scope)
  if (tokens.length !== 1) return null
  const [token] = tokens
  if (token.type !== 'token' || token.negate || token.scope !== 'all') return null
  const { tok0, tlk0 } = buildULPWhere(tokens).params
  if (typeof tok0 !== 'string' || typeof tlk0 !== 'string' || !/^[a-z0-9]+$/.test(tok0) || tlk0 !== `%${tok0}%`) return null
  return { word: tok0, like: tlk0 }
}

export interface TextBranch {
  /** The WHERE with the word's search replaced by its three text-index leaves alone: branch T. */
  where: string
  /** ` AND NOT (leaves)`: the other branches exclude what T reads, which makes the three disjoint. */
  exclude: string
}

/** The parameter buildULPWhere gives the first (here the only) term: the leaves are written over it. */
const WORD_PARAM = 'tok0'

/**
 * The word plan's additions to `base`, the route's `where` or `whereRaw`, whose search is `qClause` (buildULPWhere's clause, which the route wraps in
 * parentheses). null when `base` does not contain that clause exactly once: T would then repeat the other branches and a row would be counted twice, so
 * the caller runs today's query.
 */
export function wordTextBranch(base: string, qClause: string): TextBranch | null {
  const clause = `(${qClause})`
  const at = base.indexOf(clause)
  if (at < 0 || base.indexOf(clause, at + clause.length) >= 0) return null
  const leaves = wordLeaves(WORD_PARAM)
  return { where: base.replace(clause, () => `(${leaves})`), exclude: ` AND NOT (${leaves})` }
}
```

(d) Replace the whole `lookupCandidates` function with the three functions below (the first is the old tail made shared):

```ts
/** The shared end of both lookups: sort, apply the caps, write the literals, check the projection. */
async function finishCandidates(domainRows: string[], emailRows: string[], run: Run, deps: PlannerDeps, now: () => number): Promise<DictionaryCandidates | null> {
  const domains = [...new Set(domainRows)].sort()
  const emailDomains = [...emailRows].sort()
  if (domains.length > searchDictMaxDomains() || emailDomains.length > searchDictMaxEmailDomains()) return null

  const domainsLiteral = chStringArrayLiteral(domains)
  const emailRevLiteral = chReversedArrayLiteral(emailDomains)
  if (Buffer.byteLength(domainsLiteral, 'utf8') > DOMAINS_LITERAL_MAX_BYTES || Buffer.byteLength(emailRevLiteral, 'utf8') > EMAIL_LITERAL_MAX_BYTES) return null

  if (emailDomains.length > 0 && !(await (deps.projectionReady ?? (() => projectionIsReady(run, now)))())) return null
  return { domains, emailDomains, empty: domains.length === 0 && emailDomains.length === 0, domainsLiteral, emailRevLiteral }
}

async function lookupCandidates(term: DictionaryTerm, run: Run, deps: PlannerDeps, now: () => number): Promise<DictionaryCandidates | null> {
  const maxDomains = searchDictMaxDomains()
  const maxEmail = searchDictMaxEmailDomains()
  // one above each cap, so "over the cap" is visible without reading the whole answer
  const [exact, suffix, host, email] = await Promise.all([
    run(SQL_BY_EXACT, { exact: term.exact, cap: maxDomains + 1 }),
    run(SQL_BY_SUFFIX, { suffix: term.suffix, cap: maxDomains + 1 }),
    run(SQL_BY_HOST, { like: term.like, cap: maxDomains + 1 }),
    run(SQL_BY_EMAIL, { like: term.like, cap: maxEmail + 1 }),
  ])
  return finishCandidates([...exact, ...suffix, ...host].map(r => String(r.domain)), email.map(r => String(r.email_domain)), run, deps, now)
}

/** A word has no `domain = x` branch: only the hosts and the e-mail domains that contain it. */
async function lookupWordCandidates(term: WordTerm, run: Run, deps: PlannerDeps, now: () => number): Promise<DictionaryCandidates | null> {
  const [host, email] = await Promise.all([
    run(SQL_BY_HOST, { like: term.like, cap: searchDictMaxDomains() + 1 }),
    run(SQL_BY_EMAIL, { like: term.like, cap: searchDictMaxEmailDomains() + 1 }),
  ])
  return finishCandidates(host.map(r => String(r.domain)), email.map(r => String(r.email_domain)), run, deps, now)
}
```

(e) Replace `resolveDictionaryCandidates` (the whole function, keeping its doc comment) with:

```ts
/** The cached lookup shared by both kinds of term; `termKey` keeps their answers apart. */
async function resolveCached(
  termKey: string,
  lookup: (run: Run, deps: PlannerDeps, now: () => number) => Promise<DictionaryCandidates | null>,
  deps: PlannerDeps,
): Promise<DictionaryCandidates | null> {
  if (!searchDictionaryEnabled()) return null
  const run: Run = deps.run ?? executeQuery
  const now = deps.now ?? Date.now
  const status = await (deps.status ?? (() => getSearchDictionaryStatus(run)))()
  if (status.state !== 'fresh' || !status.fingerprint) return null

  const key = `${status.fingerprint}\u0000${termKey}`
  const t = now()
  const hit = cache.get(key)
  if (hit && t - hit.at < hit.ttl) return hit.value

  const entry: CacheEntry = { at: t, ttl: VERDICT_TTL_MS, value: Promise.resolve(null) }
  entry.value = lookup(run, deps, now).catch((err: unknown) => {
    entry.ttl = FAILURE_TTL_MS
    console.warn('[search-dictionary] candidate lookup failed -- using the plain query:', err instanceof Error ? err.message : String(err))
    return null
  })
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CACHE_MAX_TERMS) cache.delete(cache.keys().next().value as string)
  return entry.value
}

/**
 * The candidates for a term, or null when today's query should run (feature off, dictionary not fresh, a cap exceeded, the projection missing,
 * the lookup failed). Cached per (dictionary fingerprint, term) for ten minutes, a failure for one; concurrent callers share the one lookup.
 */
export function resolveDictionaryCandidates(term: DictionaryTerm, deps: PlannerDeps = {}): Promise<DictionaryCandidates | null> {
  return resolveCached(term.exact, (run, d, now) => lookupCandidates(term, run, d, now), deps)
}

/** The same for a word; also null when the token plans are switched off (SEARCH_TOKEN_PLANS). `empty` then means "no candidate": branch T may still match. */
export function resolveWordCandidates(term: WordTerm, deps: PlannerDeps = {}): Promise<DictionaryCandidates | null> {
  if (!searchTokenPlansEnabled()) return Promise.resolve(null)
  return resolveCached(`word\u0000${term.word}`, (run, d, now) => lookupWordCandidates(term, run, d, now), deps)
}
```

- [x] **Step 4: Run the new tests and the existing dictionary tests**

Run: `npx vitest run __tests__/search-word-plan.test.ts __tests__/search-dictionary-plan.test.ts __tests__/credentials-route-dictionary.test.ts __tests__/search-dictionary.test.ts 2>&1 | tail -10`
Expected: all pass (the refactor must not change the domain plan's behaviour).

- [x] **Step 5: Commit**

```bash
git add lib/search-dictionary-plan.ts __tests__/search-word-plan.test.ts
git commit -m "feat(search): the word term, its text branch and its dictionary candidates" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The three-branch SQL

**Files:**
- Modify: `lib/search-dictionary-plan.ts`
- Test: `__tests__/search-word-plan-sql.test.ts` (create)

**Interfaces:**
- Consumes: `TextBranch`, `wordTextBranch` (Task 1).
- Produces: `RowsSqlInput` gains `text?: TextBranch` and `maxSeconds?: number`; `TotalsSqlInput` gains `text?: TextBranch`, `maxSeconds?: number` and `overflow?: 'break' | 'throw'`. Without them both builders return exactly the SQL they returned before.

- [x] **Step 1: Write the failing tests**

Create `__tests__/search-word-plan-sql.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  buildDictionaryRowsSql, buildDictionaryTotalsSql, wordTextBranch, DICTIONARY_SQL_MAX_CHARS, type DictionaryCandidates,
} from '@/lib/search-dictionary-plan'
import { buildULPWhere, parseULPQuery, wordLeaves } from '@/lib/ulp-search'

const LEAVES = wordLeaves('tok0')
const NOT_LEAVES = ` AND NOT (${LEAVES})`
const QCLAUSE = buildULPWhere(parseULPQuery('ledger')).clause
const WHERE = `1=1 AND (${QCLAUSE}) AND is_noise = 0`
const WHERE_T = `1=1 AND (${LEAVES}) AND is_noise = 0`
const WHERE_RAW = `1=1 AND (${QCLAUSE})`
const WHERE_RAW_T = `1=1 AND (${LEAVES})`
const CURSOR = ' AND (domain, email, imported_at, url, password) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})'
const DOMAIN_ORDER = 'domain ASC,  email ASC, imported_at ASC, url ASC, password ASC'
const EMAIL_ORDER = 'email ASC, domain ASC, imported_at ASC, url ASC, password ASC'
const OFFSET = "(_part, _part_offset) IN (SELECT _part, _part_offset FROM ulp.credentials WHERE reverse(email_domain) IN ['moc.regdel'] SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = 'proj_email_domain_rev')"
const D = "['ledger.com','app.ledger.com']"
const cands = (over: Partial<DictionaryCandidates> = {}): DictionaryCandidates => ({
  domains: ['ledger.com', 'app.ledger.com'], emailDomains: ['ledger.com'], empty: false, domainsLiteral: D, emailRevLiteral: "['moc.regdel']", ...over,
})
const NO_D = { domains: [], domainsLiteral: '[]' }
const NO_E = { emailDomains: [], emailRevLiteral: '[]' }
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

const rowsInput = (over: Record<string, unknown> = {}) => ({
  where: WHERE, cursorClause: CURSOR, orderBy: DOMAIN_ORDER, dedupe: true, dedupeInWindow: false,
  rawCols: 'url, email, password, domain, imported_at', selectList: 'NORMALIZED, url AS _c_url',
  sortMaxMemoryBytes: 4_294_967_296, normColsSetting: 'prefer_column_name_to_alias = 1',
  candidates: cands(), text: wordTextBranch(WHERE, QCLAUSE)!, maxSeconds: 4, ...over,
})
const totalsInput = (over: Record<string, unknown> = {}) => ({
  whereRaw: WHERE_RAW, dedupe: true, hasUserFilter: true, onlyIf: 'is_noise = 0',
  candidates: cands(), text: wordTextBranch(WHERE_RAW, QCLAUSE)!, maxSeconds: 12, overflow: 'throw' as const, ...over,
})

describe('buildDictionaryRowsSql for a word', () => {
  test('three disjoint branches: H and E over the UNCHANGED WHERE and keyset clause with the exclusion, T over the WHERE with the leaves alone', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(sql.split(`WHERE ${WHERE}${CURSOR}`).length - 1).toBe(2) // H and E, verbatim
    expect(sql.split(`WHERE ${WHERE_T}${CURSOR}`).length - 1).toBe(1) // T
    expect(sql).toContain(`${CURSOR} AND domain IN ${D}${NOT_LEAVES}\nORDER BY`)
    expect(sql).toContain(`${CURSOR} AND domain NOT IN ${D}${NOT_LEAVES} AND ${OFFSET}\nORDER BY`)
    expect(count(sql, /UNION ALL/g)).toBe(2)
    const t = sql.split('UNION ALL').find(b => b.includes(`WHERE ${WHERE_T}`))!
    expect(t).not.toContain('url_host LIKE')
    expect(t).not.toContain('NOT (')
    expect(t).not.toContain('domain IN')
  })

  test('the settings: projections off on T and H (the branch), the PREWHERE guards on E only, projections never off on E or on the outer query', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(count(sql, /optimize_use_projections = 0/g)).toBe(2)
    expect(count(sql, /optimize_move_to_prewhere = 0/g)).toBe(1)
    expect(count(sql, /query_plan_optimize_lazy_materialization = 0/g)).toBe(1)
    const branches = sql.split('UNION ALL')
    const [h, e, t] = [branches[0], branches[1], branches[2]]
    expect(h).toContain('LIMIT {limit:UInt32} SETTINGS optimize_use_projections = 0')
    expect(e).toContain('LIMIT {limit:UInt32} SETTINGS optimize_move_to_prewhere = 0, query_plan_optimize_lazy_materialization = 0')
    expect(e).not.toContain('optimize_use_projections = 0')
    expect(t).toContain('SETTINGS optimize_use_projections = 0')
    expect(sql).toContain("SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = 'proj_email_domain_rev')")
    expect(sql.slice(sql.lastIndexOf(') AS t'))).not.toContain('optimize_use_projections')
  })

  test('the plan\'s own time limit goes to the outer query; without one it is today\'s 300 s', () => {
    expect(buildDictionaryRowsSql(rowsInput())!).toMatch(/\) AS t\s+SETTINGS max_execution_time = 4,\s+timeout_overflow_mode = 'throw',\s+http_wait_end_of_query = 1,/)
    expect(buildDictionaryRowsSql(rowsInput({ maxSeconds: undefined }))!).toMatch(/\) AS t\s+SETTINGS max_execution_time = 300,/)
  })

  test('a domain-led sort de-duplicates inside each branch, then again in the merge', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(count(sql, /LIMIT 1 BY content_key_hash/g)).toBe(4)
    expect(count(sql, /LIMIT \{limit:UInt32\}/g)).toBe(4)
    expect(sql).not.toContain('windowLimit')
  })

  test('Unique with a sort not led by domain keeps the legacy window in all three branches and in the cut of the union', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ orderBy: EMAIL_ORDER, dedupeInWindow: true }))!
    expect(count(sql, /LIMIT \{windowLimit:UInt32\}/g)).toBe(4)
    expect(count(sql, /LIMIT 1 BY content_key_hash/g)).toBe(1)
  })

  test('without Unique nothing is de-duplicated anywhere', () => {
    expect(buildDictionaryRowsSql(rowsInput({ dedupe: false }))!).not.toContain('LIMIT 1 BY')
  })

  test('only host candidates: H and T. Only e-mail candidates: E (no domain predicate) and T. Neither: T alone.', () => {
    const onlyD = buildDictionaryRowsSql(rowsInput({ candidates: cands({ ...NO_E }) }))!
    expect(count(onlyD, /UNION ALL/g)).toBe(1)
    expect(onlyD).not.toContain('_part_offset')
    expect(onlyD).not.toContain('NOT IN')
    expect(onlyD).toContain(`AND domain IN ${D}${NOT_LEAVES}`)

    const onlyE = buildDictionaryRowsSql(rowsInput({ candidates: cands({ ...NO_D }) }))!
    expect(count(onlyE, /UNION ALL/g)).toBe(1)
    expect(onlyE).not.toMatch(/domain (NOT )?IN \[/)
    expect(onlyE).toContain(`${CURSOR}${NOT_LEAVES} AND ${OFFSET}`)

    const none = buildDictionaryRowsSql(rowsInput({ candidates: cands({ ...NO_D, ...NO_E, empty: true }) }))!
    expect(none).not.toContain('UNION ALL')
    expect(none).not.toContain('_part_offset')
    expect(none).not.toContain('NOT (')
    expect(none).toContain(`WHERE ${WHERE_T}${CURSOR}`)
    expect(none).toContain('SETTINGS optimize_use_projections = 0')
  })

  test('null when the search was not replaced (T would repeat the other branches), or the SQL would not fit max_query_size', () => {
    expect(buildDictionaryRowsSql(rowsInput({ text: { where: WHERE, exclude: NOT_LEAVES } }))).toBeNull()
    const huge = `['${'a'.repeat(DICTIONARY_SQL_MAX_CHARS / 2)}']`
    expect(buildDictionaryRowsSql(rowsInput({ candidates: cands({ domainsLiteral: huge }) }))).toBeNull()
  })

  test('the only placeholders are the route\'s own, plus the word\'s two', () => {
    const names = new Set([...buildDictionaryRowsSql(rowsInput())!.matchAll(/\{(\w+):/g)].map(m => m[1]))
    expect([...names].sort()).toEqual(['c_d', 'c_e', 'c_ia', 'c_pw', 'c_u', 'limit', 'tlk0', 'tok0'].sort())
  })

  test('a domain term (no text branch) gets exactly the SQL it always got', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ text: undefined, maxSeconds: undefined, where: '1=1 AND ((domain = {dom0:String} OR url_host LIKE {domlk0:String}))' }))!
    expect(sql).not.toContain('NOT (')
    expect(sql).not.toContain('optimize_use_projections = 0')
    expect(count(sql, /UNION ALL/g)).toBe(1)
    expect(sql).toMatch(/\) AS t\s+SETTINGS max_execution_time = 300,/)
  })
})

describe('buildDictionaryTotalsSql for a word', () => {
  test('one aggregate per branch, combined by merging states, the leaves-only WHERE for T and the exclusion for H and E', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toContain('SELECT uniqIfMerge(part_total) AS total, sum(part_rows) AS raw_total')
    expect(count(sql, /uniqIfState\(content_key_hash, is_noise = 0\) AS part_total, count\(\) AS part_rows/g)).toBe(3)
    expect(count(sql, /UNION ALL/g)).toBe(2)
    expect(sql).toContain(`WHERE ${WHERE_RAW} AND domain IN ${D}${NOT_LEAVES} SETTINGS optimize_use_projections = 0`)
    expect(sql).toContain(`WHERE ${WHERE_RAW} AND domain NOT IN ${D}${NOT_LEAVES} AND ${OFFSET} SETTINGS optimize_move_to_prewhere = 0`)
    expect(sql).toContain(`WHERE ${WHERE_RAW_T} SETTINGS optimize_use_projections = 0`)
    expect(sql).not.toContain('{c_d') // no keyset clause
  })

  test('the budget throws on an overrun (the caller then runs today\'s count); the default is today\'s partial count after 300 s', () => {
    expect(buildDictionaryTotalsSql(totalsInput())!)
      .toMatch(/SETTINGS optimize_trivial_count_query = 1,\s+max_execution_time = 12,\s+timeout_overflow_mode = 'throw',\s+use_query_cache = 0$/)
    expect(buildDictionaryTotalsSql(totalsInput({ maxSeconds: undefined, overflow: undefined }))!)
      .toMatch(/SETTINGS optimize_trivial_count_query = 1,\s+max_execution_time = 300,\s+timeout_overflow_mode = 'break',\s+use_query_cache = 0$/)
  })

  test('neither list: T alone, a single aggregate; the wrong WHERE or an oversize list: null', () => {
    const sql = buildDictionaryTotalsSql(totalsInput({ candidates: cands({ ...NO_D, ...NO_E, empty: true }) }))!
    expect(sql).not.toContain('UNION ALL')
    expect(count(sql, /uniqIfState/g)).toBe(1)
    expect(buildDictionaryTotalsSql(totalsInput({ text: { where: WHERE_RAW, exclude: NOT_LEAVES } }))).toBeNull()
    expect(buildDictionaryTotalsSql(totalsInput({ candidates: cands({ domainsLiteral: `['${'a'.repeat(DICTIONARY_SQL_MAX_CHARS)}']` }) }))).toBeNull()
  })

  test('is recognised by the older route tests as a totals query, and never as a data query', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toMatch(/AS raw_total/)
    expect(sql).not.toMatch(/\) AS t\s/)
  })
})
```

- [x] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/search-word-plan-sql.test.ts 2>&1 | tail -12`
Expected: FAIL (the builders ignore `text`).

- [x] **Step 3: Implement in `lib/search-dictionary-plan.ts`**

(a) Replace the `Branch` interface, `branchesFor` and the `union` helper with:

```ts
interface Branch {
  /** Replaces the route's WHERE for this branch (branch T reads the word's text-index leaves alone); absent: the route's WHERE, used verbatim. */
  where?: string
  /** ANDed onto the WHERE. */
  conjunct: string
  /** Appended to the branch's SELECT. */
  settings: string
}

/** The word plan reads the base table in T and H: a projection part has no text index, so `hasToken` there is the case-SENSITIVE plain function. */
const BASE_TABLE_ONLY = ' SETTINGS optimize_use_projections = 0'
/** Branch E: the PREWHERE move fails with a `_part_offset` filter on ClickHouse 26.3; projections stay ON for its sub-select. */
const OFFSET_BRANCH_SETTINGS = ' SETTINGS optimize_move_to_prewhere = 0, query_plan_optimize_lazy_materialization = 0'

function branchesFor(c: DictionaryCandidates, text?: TextBranch): Branch[] {
  const out: Branch[] = []
  const hasDomains = c.domains.length > 0
  const exclude = text?.exclude ?? ''
  if (hasDomains) out.push({ conjunct: ` AND domain IN ${c.domainsLiteral}${exclude}`, settings: text ? BASE_TABLE_ONLY : '' })
  if (c.emailDomains.length > 0) {
    out.push({
      conjunct: `${hasDomains ? ` AND domain NOT IN ${c.domainsLiteral}` : ''}${exclude} AND ${offsetFilter(c)}`,
      settings: OFFSET_BRANCH_SETTINGS,
    })
  }
  if (text) out.push({ where: text.where, conjunct: '', settings: BASE_TABLE_ONLY })
  return out
}

const union = (selects: string[]): string => (selects.length === 1 ? selects[0] : selects.map(s => `(${s})`).join('\nUNION ALL\n'))
```

(b) `RowsSqlInput`: add after `candidates`:

```ts
  /** The word plan: branch T and the exclusion that keeps the three disjoint (wordTextBranch). Absent for a domain term. */
  text?: TextBranch
  /** The plan's own time limit in seconds (it throws over it, and the caller runs today's query); absent: today's 300. */
  maxSeconds?: number
```

In `buildDictionaryRowsSql`: replace `const branches = branchesFor(a.candidates)` with

```ts
  if (a.text && a.text.where === a.where) return null // the search was not replaced: T would repeat the other branches
  const branches = branchesFor(a.candidates, a.text)
```
in the `select` helper change `WHERE ${a.where}${a.cursorClause}${b.conjunct}` to `WHERE ${b.where ?? a.where}${a.cursorClause}${b.conjunct}`, and in `settings` change `max_execution_time = 300,` to `max_execution_time = ${a.maxSeconds ?? 300},`.

(c) `TotalsSqlInput`: add after `candidates`:

```ts
  /** The word plan (wordTextBranch over the route's whereRaw). Absent for a domain term. */
  text?: TextBranch
  /** The plan's own time limit in seconds; absent: today's 300. */
  maxSeconds?: number
  /** What an overrun does: 'break' returns the partial count (today's), 'throw' fails so that the caller can run today's query. */
  overflow?: 'break' | 'throw'
```

In `buildDictionaryTotalsSql`: replace `const branches = branchesFor(a.candidates)` with

```ts
  if (a.text && a.text.where === a.whereRaw) return null
  const branches = branchesFor(a.candidates, a.text)
```
change `WHERE ${a.whereRaw}${b.conjunct}${b.settings}` to `WHERE ${b.where ?? a.whereRaw}${b.conjunct}${b.settings}`, and in the outer SETTINGS replace `max_execution_time = 300,` with `max_execution_time = ${a.maxSeconds ?? 300},` and `timeout_overflow_mode = 'break',` with `timeout_overflow_mode = '${a.overflow ?? 'break'}',`.

- [x] **Step 4: Run the new tests and the existing builder tests**

Run: `npx vitest run __tests__/search-word-plan-sql.test.ts __tests__/search-dictionary-plan.test.ts __tests__/credentials-route-dictionary.test.ts 2>&1 | tail -10`
Expected: all pass.

- [x] **Step 5: Mutation check**

Temporarily change `if (text) out.push({ where: text.where, conjunct: '', settings: BASE_TABLE_ONLY })` to `if (false) ...` and `exclude` to `''` in `branchesFor`; run `npx vitest run __tests__/search-word-plan-sql.test.ts 2>&1 | grep -E "×|Tests "` and confirm the branch, exclusion and count tests FAIL; restore both; re-run: all pass.

- [x] **Step 6: Commit**

```bash
git add lib/search-dictionary-plan.ts __tests__/search-word-plan-sql.test.ts
git commit -m "feat(search): the three-branch SQL of the word plan (text indexes, hosts, e-mail domains)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The rows gate and the budgets

**Files:**
- Modify: `lib/search-plan-gate.ts`
- Modify: `__tests__/search-plan-gate.test.ts`

**Interfaces:**
- Produces: `wordRowsMaxDomains(env?)`, `wordRowsMaxEmailDomains(env?)`, `wordRowsMaxTextHits(env?)` (environment `SEARCH_WORD_ROWS_MAX_DOMAINS`, `SEARCH_WORD_ROWS_MAX_EMAIL_DOMAINS`, `SEARCH_WORD_ROWS_MAX_TEXT_HITS`; defaults 300, 100, 20,000), `wordRowsGate(c: { domains: string[]; emailDomains: string[] }, textHits: number | null, env?): boolean`, `WORD_ROWS_BUDGET_SECONDS = 4`, `WORD_TOTALS_BUDGET_SECONDS = 12`.

- [x] **Step 1: Write the failing tests**

In `__tests__/search-plan-gate.test.ts` add to the import list `wordRowsMaxDomains, wordRowsMaxEmailDomains, wordRowsMaxTextHits, wordRowsGate, WORD_ROWS_BUDGET_SECONDS, WORD_TOTALS_BUDGET_SECONDS`, and append:

```ts
describe('the word plan\'s rows gate and budgets', () => {
  const cands = (d: number, e: number) => ({ domains: Array.from({ length: d }, (_, i) => `d${i}.test`), emailDomains: Array.from({ length: e }, (_, i) => `e${i}.test`) })

  test('the starting values (spec 2026-10-13) and their budgets', () => {
    expect(wordRowsMaxDomains({})).toBe(300)
    expect(wordRowsMaxEmailDomains({})).toBe(100)
    expect(wordRowsMaxTextHits({})).toBe(20_000)
    expect(WORD_ROWS_BUDGET_SECONDS).toBe(4)
    expect(WORD_TOTALS_BUDGET_SECONDS).toBe(12)
  })

  test('the environment moves them; a junk value keeps the default', () => {
    expect(wordRowsMaxDomains({ SEARCH_WORD_ROWS_MAX_DOMAINS: '3000' })).toBe(3000)
    expect(wordRowsMaxEmailDomains({ SEARCH_WORD_ROWS_MAX_EMAIL_DOMAINS: '300' })).toBe(300)
    expect(wordRowsMaxTextHits({ SEARCH_WORD_ROWS_MAX_TEXT_HITS: '50001' })).toBe(50_001)
    for (const junk of ['', 'abc', '-5', 'NaN']) expect(wordRowsMaxDomains({ SEARCH_WORD_ROWS_MAX_DOMAINS: junk }), junk).toBe(300)
  })

  test('the gate: all three numbers at or under their limits', () => {
    expect(wordRowsGate(cands(0, 0), 0, {})).toBe(true)
    expect(wordRowsGate(cands(300, 100), 20_000, {})).toBe(true)
    expect(wordRowsGate(cands(301, 100), 20_000, {})).toBe(false)
    expect(wordRowsGate(cands(300, 101), 20_000, {})).toBe(false)
    expect(wordRowsGate(cands(300, 100), 20_001, {})).toBe(false)
  })

  test('a probe that failed (null) closes the gate: today\'s rows query runs', () => {
    expect(wordRowsGate(cands(1, 1), null, {})).toBe(false)
  })

  test('the gate reads the environment it is given', () => {
    expect(wordRowsGate(cands(1000, 200), 30_000, { SEARCH_WORD_ROWS_MAX_DOMAINS: '3000', SEARCH_WORD_ROWS_MAX_EMAIL_DOMAINS: '300', SEARCH_WORD_ROWS_MAX_TEXT_HITS: '50001' })).toBe(true)
  })
})
```

- [x] **Step 2: Run it to see it fail**

Run: `npx vitest run __tests__/search-plan-gate.test.ts 2>&1 | tail -8`
Expected: FAIL (the new names are not exported).

- [x] **Step 3: Implement**

In `lib/search-plan-gate.ts`, after the `PLAN_PROJECTIONS_OFF` constant add:

```ts
// ── the word plan (plan 2026-10-13-word-search-plan.md) ──────────────────────────────────────────────────────────────────────

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * The rows of a single-word search come from the word plan only for a RARE word: today's rows query stops reading as soon as it has 200 rows, while the
 * plan has to find 200 inside each of its three branches. The three numbers are the largest candidate sets and text-index hit count at which the plan
 * still measured at least as fast as today's query; they are tunable by the environment (the calibration run of the plan raises them to measure).
 */
export const wordRowsMaxDomains = (env: Env = process.env): number => envInt(env.SEARCH_WORD_ROWS_MAX_DOMAINS, 300)
export const wordRowsMaxEmailDomains = (env: Env = process.env): number => envInt(env.SEARCH_WORD_ROWS_MAX_EMAIL_DOMAINS, 100)
export const wordRowsMaxTextHits = (env: Env = process.env): number => envInt(env.SEARCH_WORD_ROWS_MAX_TEXT_HITS, 20_000)
/** The rows plan may take this long (today's rows query takes 10-17 s for a rare word); over it, today's query runs. */
export const WORD_ROWS_BUDGET_SECONDS = 4
/** The totals plan may take this long (the slowest measured took 8.7 s, today's 13-22 s); over it, today's count runs. */
export const WORD_TOTALS_BUDGET_SECONDS = 12

/** Whether the rows request may use the word plan: the candidates and the text-index hit count (the capped probe; null = the probe failed) are all small. */
export function wordRowsGate(c: { domains: string[]; emailDomains: string[] }, textHits: number | null, env: Env = process.env): boolean {
  return textHits !== null
    && textHits <= wordRowsMaxTextHits(env)
    && c.domains.length <= wordRowsMaxDomains(env)
    && c.emailDomains.length <= wordRowsMaxEmailDomains(env)
}
```

- [x] **Step 4: Run it to see it pass**

Run: `npx vitest run __tests__/search-plan-gate.test.ts 2>&1 | tail -6`
Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add lib/search-plan-gate.ts __tests__/search-plan-gate.test.ts
git commit -m "feat(search): the word plan's rows gate (tunable by the environment) and its budgets" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The route uses the word plan

**Files:**
- Modify: `app/api/credentials/route.ts`
- Test: `__tests__/credentials-route-words.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: `GET /api/credentials` answers with `plan: 'words'` (rows, and `totals_only`) when the word plan answered; `dictionary=0` and `token_plans=0` force today's query.

- [x] **Step 1: Write the failing route tests**

Create `__tests__/credentials-route-words.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
let dataRows: Array<Record<string, unknown>> = []
let totalsRow: Record<string, unknown> = { total: '11', raw_total: '12' }
let hostDomains: string[] = ['ledger.com', 'app.ledger.com']
let emailDomains: string[] = ['ledger.com']
let textHits = 1532
let planDataError: Error | null = null
let planTotalsError: Error | null = null
let plainDataError: Error | null = null
const fresh = (fp = 'fp-1') => ({
  state: 'fresh', fingerprint: fp, builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
})
let dictStatus: Record<string, unknown> = fresh()

// The word plan's branches end `LIMIT {limit:UInt32} SETTINGS optimize_use_projections = 0`; no other rows query of this route has that shape (an address
// search carries the setting in the OUTER settings, the substring plan too).
const isPlanRows = (sql: string) => /LIMIT \{(?:limit|windowLimit):UInt32\} SETTINGS optimize_use_projections = 0/.test(sql)
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/FROM ulp\.search_host_dict/.test(sql)) return hostDomains.map(domain => ({ domain }))
    if (/FROM ulp\.search_emaildomain_dict/.test(sql)) return emailDomains.map(email_domain => ({ email_domain }))
    if (/SELECT count\(\) AS hits FROM/.test(sql)) return [{ hits: String(textHits) }]
    if (/system\.projections/.test(sql)) return [{ defined: 0, parts: 1, with_projection: 0 }] // Newest-first windows NOT ready
    if (/AS raw_total/.test(sql)) {
      if (planTotalsError && /part_total/.test(sql)) throw planTotalsError
      return [totalsRow]
    }
    if (/\) AS t\s/.test(sql)) {
      if (planDataError && isPlanRows(sql)) throw planDataError
      if (plainDataError && !isPlanRows(sql)) throw plainDataError
      return dataRows
    }
    return []
  }),
}))
vi.mock('@/lib/search-dictionary', async () => {
  const actual = await vi.importActual<typeof import('@/lib/search-dictionary')>('@/lib/search-dictionary')
  return { ...actual, getSearchDictionaryStatus: vi.fn(async () => dictStatus) }
})
vi.mock('@/lib/credentials-projections', async () => {
  const actual = await vi.importActual<typeof import('@/lib/credentials-projections')>('@/lib/credentials-projections')
  return { ...actual, isEmailDomainRevProjectionReady: vi.fn(async () => true) }
})

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { encodeCursor } from '@/lib/cursor-pagination'
import { resetDictionaryPlanCache } from '@/lib/search-dictionary-plan'
import { resetSearchPlanGateCache, wordRowsMaxDomains, wordRowsMaxEmailDomains, wordRowsMaxTextHits } from '@/lib/search-plan-gate'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'

const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.test`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4,
})
const lookups = () => calls.filter(c => /FROM ulp\.search_(host|emaildomain)_dict/.test(c.sql))
const probes = () => calls.filter(c => /SELECT count\(\) AS hits FROM/.test(c.sql))
const planRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && isPlanRows(c.sql))
const plainRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && !isPlanRows(c.sql))
const planTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && /part_total/.test(c.sql))
const plainTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && !/part_total/.test(c.sql))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
const names = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}.example`)
const TIMEOUT = () => new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 4.2 seconds, maximum: 4. (TIMEOUT_EXCEEDED)')

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  calls.length = 0
  dataRows = [row(1), row(2)]
  totalsRow = { total: '11', raw_total: '12' }
  hostDomains = ['ledger.com', 'app.ledger.com']
  emailDomains = ['ledger.com']
  textHits = 1532
  planDataError = planTotalsError = plainDataError = null
  dictStatus = fresh()
  resetDictionaryPlanCache()
  resetSearchPlanGateCache()
  resetNewestFirstReadyCache()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
// Not restoreAllMocks: it would also strip the implementations of the mocked auth, ClickHouse and dictionary modules.
afterEach(() => { vi.unstubAllEnvs(); warnSpy.mockRestore() })

describe('GET /api/credentials — a single word, answered through the text indexes and the dictionaries', () => {
  test('the page\'s rows request and totals request are both answered by the plan, share ONE set of lookups and ONE probe', async () => {
    const [rowsRes, totalsRes] = await Promise.all([
      get('q=ledger&skip_totals=1&exclude_noise=1&dedupe=1'),
      get('q=ledger&totals_only=1&exclude_noise=1&dedupe=1'),
    ])
    const rowsBody = await rowsRes.json()
    const totalsBody = await totalsRes.json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'words' })
    expect(rowsBody.results).toHaveLength(2)
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'words' })
    expect(lookups()).toHaveLength(2) // hosts and e-mail domains, once for both requests
    expect(probes()).toHaveLength(1)
    expect(planRows()).toHaveLength(1)
    expect(planTotals()).toHaveLength(1)
    expect(plainRows()).toHaveLength(0)
    expect(plainTotals()).toHaveLength(0)
  })

  test('the rows SQL: H and E keep the legacy predicate and exclude the leaves, T has the leaves alone; the budget is 4 s', async () => {
    await get('q=ledger&skip_totals=1&dedupe=1&exclude_noise=1&limit=50')
    const { sql, params } = planRows()[0]
    expect(sql).toContain('url_host LIKE {tlk0:String}') // the legacy predicate is still there (H and E)
    expect(sql).toContain("AND domain IN ['app.ledger.com','ledger.com'] AND NOT (hasToken(url, {tok0:String}) OR hasToken(email, {tok0:String}) OR hasToken(password, {tok0:String}))")
    expect(sql).toContain("AND domain NOT IN ['app.ledger.com','ledger.com'] AND NOT (hasToken(url, {tok0:String})")
    expect(sql).toContain('AND (hasToken(url, {tok0:String}) OR hasToken(email, {tok0:String}) OR hasToken(password, {tok0:String})) AND is_noise = 0')
    expect(sql).toContain('ORDER BY domain ASC')
    expect(sql).toMatch(/\) AS t\s+SETTINGS max_execution_time = 4,/)
    expect(params).toMatchObject({ tok0: 'ledger', tlk0: '%ledger%', limit: 50 })
    expect(params).not.toHaveProperty('windowLimit')
  })

  test('the totals SQL: three aggregates merged as states, a 12 s budget that throws', async () => {
    await get('q=ledger&totals_only=1&exclude_noise=1&dedupe=1')
    const { sql, params } = planTotals()[0]
    expect(sql).toContain('uniqIfMerge(part_total) AS total')
    expect((sql.match(/uniqIfState/g) ?? []).length).toBe(3)
    expect(sql).toMatch(/max_execution_time = 12,\s+timeout_overflow_mode = 'throw'/)
    expect(sql).not.toContain('{c_d')
    expect(params).toMatchObject({ tok0: 'ledger', tlk0: '%ledger%' })
  })

  test('a cursor page puts the keyset clause in all three branches and neither looks up nor probes again', async () => {
    await get('q=ledger&sort=domain_asc&skip_totals=1&limit=2')
    const cursor = encodeCursor('domain_asc', row(2))
    calls.length = 0
    await get(`q=ledger&sort=domain_asc&limit=2&cursor=${encodeURIComponent(cursor)}`)
    const { sql, params } = planRows()[0]
    expect(sql.split('(domain, email, imported_at, url, password) > ({c_d:String}').length - 1).toBe(3)
    expect(params).toMatchObject({ c_d: 's2.example', c_e: 'u2@mail.test' })
    expect(lookups()).toHaveLength(0)
    expect(probes()).toHaveLength(0)
    expect(planTotals()).toHaveLength(0)
  })

  test('Unique with a sort not led by domain binds windowLimit like the plain query', async () => {
    await get('q=ledger&skip_totals=1&dedupe=1&sort=email_asc&limit=50')
    const { sql, params } = planRows()[0]
    expect(sql).toContain('LIMIT {windowLimit:UInt32}')
    expect(params).toMatchObject({ limit: 50, windowLimit: 150 })
  })

  test('no candidate at all: a single branch, the text indexes alone, still through the plan', async () => {
    hostDomains = []
    emailDomains = []
    textHits = 0
    const body = await (await get('q=ledger&skip_totals=1')).json()
    expect(body.plan).toBe('words')
    const { sql } = planRows()[0]
    expect(sql).not.toContain('UNION ALL')
    expect(sql).not.toContain('url_host LIKE')
    const totals = await (await get('q=ledger&totals_only=1')).json()
    expect(totals.plan).toBe('words')
    expect(planTotals()[0].sql).not.toContain('UNION ALL')
  })

  test('"Newest first" without the projection windows falls to the plan instead of the full scan', async () => {
    const body = await (await get('q=ledger&skip_totals=1&sort=imported_desc&limit=2')).json()
    expect(body.plan).toBe('words')
    expect(plainRows()).toHaveLength(0)
  })
})

describe('GET /api/credentials — the rows gate: totals still use the plan, rows keep today\'s query', () => {
  test.each([
    ['more candidate domains than the gate', () => { hostDomains = names(wordRowsMaxDomains() + 1, 'd') }],
    ['more candidate e-mail domains than the gate', () => { emailDomains = names(wordRowsMaxEmailDomains() + 1, 'e') }],
    ['more text-index hits than the gate', () => { textHits = wordRowsMaxTextHits() + 1 }],
  ])('%s', async (_name, arrange) => {
    arrange()
    const rowsBody = await (await get('q=ledger&skip_totals=1')).json()
    const totalsBody = await (await get('q=ledger&totals_only=1')).json()
    expect(rowsBody.plan).toBe('plain')
    expect(totalsBody).toMatchObject({ plan: 'words', total: 11, raw_total: 12 })
    expect(plainRows()).toHaveLength(1)
    expect(planRows()).toHaveLength(0)
  })

  test('exactly at the three limits the rows plan still runs', async () => {
    hostDomains = names(wordRowsMaxDomains(), 'd')
    emailDomains = names(wordRowsMaxEmailDomains(), 'e')
    textHits = wordRowsMaxTextHits()
    expect((await (await get('q=ledger&skip_totals=1')).json()).plan).toBe('words')
  })

  test('a probe that fails closes the rows gate and nothing else', async () => {
    textHits = Number.NaN // the mock answers hits: 'NaN', which the probe rejects as "not a count"
    const rowsBody = await (await get('q=ledger&skip_totals=1')).json()
    expect(rowsBody.plan).toBe('plain')
    expect((await (await get('q=ledger&totals_only=1')).json()).plan).toBe('words')
  })
})

describe('GET /api/credentials — everything else is today\'s query, untouched', () => {
  test('dictionary=0 and token_plans=0 force the plain query; nothing is looked up or probed', async () => {
    for (const off of ['dictionary=0', 'token_plans=0']) {
      calls.length = 0
      resetDictionaryPlanCache()
      const [rowsBody, totalsBody] = await Promise.all([
        get(`q=ledger&skip_totals=1&${off}`).then(r => r.json()),
        get(`q=ledger&totals_only=1&${off}`).then(r => r.json()),
      ])
      expect(rowsBody.plan, off).toBe('plain')
      expect(totalsBody, off).toMatchObject({ total: 11, raw_total: 12, plan: 'plain' })
      expect(lookups(), off).toHaveLength(0)
      expect(probes(), off).toHaveLength(0)
      expect(plainRows(), off).toHaveLength(1)
      expect(plainTotals(), off).toHaveLength(1)
    }
  })

  test('SEARCH_TOKEN_PLANS=off and SEARCH_DICTIONARY=0 in the environment do the same', async () => {
    for (const name of ['SEARCH_TOKEN_PLANS', 'SEARCH_DICTIONARY']) {
      vi.stubEnv(name, name === 'SEARCH_TOKEN_PLANS' ? 'off' : '0')
      calls.length = 0
      resetDictionaryPlanCache()
      expect((await (await get('q=ledger&skip_totals=1')).json()).plan, name).toBe('plain')
      expect(lookups(), name).toHaveLength(0)
      vi.unstubAllEnvs()
    }
  })

  test.each([
    ['regex mode', 'q=ledger&regex=1'],
    ['an address', 'q=john@example.test'],
    ['an @domain', 'q=@example.test'],
    ['two terms', 'q=ledger,trezor'],
    ['a negated term', 'q=-ledger'],
    ['a login: prefix', 'q=login:ledger'],
    ['the Login scope', 'q=ledger&scope=login'],
    ['the Login (contains) scope', 'q=ledger&scope=login_contains'],
    ['a word with a hyphen', 'q=my-ledger'],
    ['no search', 'exclude_noise=1'],
  ])('%s never asks the dictionary for a word', async (_name, qs) => {
    const body = await (await get(`${qs}&skip_totals=1`)).json()
    expect(body.plan).toBe('plain')
    expect(probes()).toHaveLength(0)
    expect(calls.filter(c => /search_host_dict/.test(c.sql) && c.params.like === '%ledger%')).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test.each(['stale', 'missing', 'building', 'unknown', 'disabled'])('a dictionary that is %s: the plain query answers and no lookup runs', async state => {
    dictStatus = { ...fresh(), state, fingerprint: null }
    const body = await (await get('q=ledger&skip_totals=1')).json()
    expect(body.plan).toBe('plain')
    expect(lookups()).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test('candidates over the dictionary caps: today\'s query for rows and totals', async () => {
    hostDomains = names(3001, 'd')
    expect((await (await get('q=ledger&skip_totals=1')).json()).plan).toBe('plain')
    expect((await (await get('q=ledger&totals_only=1')).json()).plan).toBe('plain')
  })

  test('a plan query that fails falls back to today\'s query, rows and totals alike', async () => {
    planDataError = new Error('Code: 241. DB::Exception: MEMORY_LIMIT_EXCEEDED')
    planTotalsError = new Error('Code: 47. DB::Exception: Not found column _part_offset in block')
    const rowsBody = await (await get('q=ledger&skip_totals=1')).json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(rowsBody.results).toHaveLength(2)
    expect(plainRows()).toHaveLength(1)
    const totalsBody = await (await get('q=ledger&totals_only=1')).json()
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'plain' })
    expect(plainTotals()).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  test('a plan that runs over its budget hands over to today\'s query: no 408, rows and totals alike', async () => {
    planDataError = TIMEOUT()
    planTotalsError = TIMEOUT()
    const rowsRes = await get('q=ledger&skip_totals=1')
    expect(rowsRes.status).toBe(200)
    expect(await rowsRes.json()).toMatchObject({ success: true, plan: 'plain' })
    const totalsRes = await get('q=ledger&totals_only=1')
    expect(totalsRes.status).toBe(200)
    expect(await totalsRes.json()).toMatchObject({ success: true, total: 11, plan: 'plain' })
  })

  test('if today\'s query then also times out, that is the same 408 as without the plan', async () => {
    planDataError = TIMEOUT()
    plainDataError = new Error('Code: 159. DB::Exception: Timeout exceeded: TIMEOUT_EXCEEDED')
    const res = await get('q=ledger&skip_totals=1')
    expect(res.status).toBe(408)
    expect((await res.json()).timed_out).toBe(true)
  })
})
```

- [x] **Step 2: Run them to see them fail**

Run: `npx vitest run __tests__/credentials-route-words.test.ts 2>&1 | grep -E "×|Tests |Test Files" | head -30`
Expected: the plan tests FAIL (the route does not know the word plan: `plan` is `plain`); most of the "everything else" tests already pass.

- [x] **Step 3: Implement in the route**

All edits are in `app/api/credentials/route.ts`.

(a) Imports: extend the dictionary-plan import and the gate import to

```ts
import {
  dictionaryTermFromQuery, resolveDictionaryCandidates, buildDictionaryRowsSql, buildDictionaryTotalsSql, type DictionaryCandidates,
  wordTermFromQuery, resolveWordCandidates, wordTextBranch,
} from "@/lib/search-dictionary-plan"
```
and
```ts
import {
  runWithBudget, probeTokenHits, wordRowsGate, SUBSTRING_BUDGET_SECONDS, PLAN_PROJECTIONS_OFF, WORD_ROWS_BUDGET_SECONDS, WORD_TOTALS_BUDGET_SECONDS,
} from "@/lib/search-plan-gate"
```

(b) Header comment: replace the two lines

```
 *   dictionary    '0'       run the plain query even when the domain search dictionary could answer (parity tests, scripts)
 *   token_plans   '0'       run the plain query even when a token plan (the substring plan) could answer (parity tests, scripts)
```
with
```
 *   dictionary    '0'       run the plain query even when the domain search dictionary could answer, which also switches the word plan off (parity tests, scripts)
 *   token_plans   '0'       run the plain query even when a token plan (the substring plan, the word plan) could answer (parity tests, scripts)
```

(c) After the `getSubstringChoice` definition (the closing `}` that follows `return (substringMemo ??= resolveSubstringChoice(substringNeedle))`) add:

```ts

  // Word plan (lib/search-dictionary-plan.ts): a search for exactly one word is answered from the two dictionaries of the domain search in three disjoint
  // branches: the text indexes alone (the word as a whole token of the URL, login or password) and the hosts and e-mail domains that merely CONTAIN the
  // word, which the dictionaries list. Totals whenever the candidates fit the dictionary caps; rows only for a rare word (lib/search-plan-gate.ts,
  // wordRowsGate), because today's rows query stops after 200 rows and for a plentiful word the plan has to find 200 in each branch. null = this
  // request keeps today's query. dictionary=0 and token_plans=0 force it.
  const wordTerm = sp.get('dictionary') === '0' || sp.get('token_plans') === '0' ? null : wordTermFromQuery(q.trim(), regex, scope)
  let wordMemo: Promise<DictionaryCandidates | null> | null = null
  const getWordCandidates = (): Promise<DictionaryCandidates | null> => {
    if (!wordTerm) return Promise.resolve(null)
    return (wordMemo ??= resolveWordCandidates(wordTerm))
  }
```

(d) Types: `let totalsPlan: 'dictionary' | 'substring' | 'plain' = 'plain'` becomes `let totalsPlan: 'dictionary' | 'words' | 'substring' | 'plain' = 'plain'`, and `let plan: 'windows' | 'plain' | 'dictionary' | 'substring' = 'plain'` becomes `let plan: 'windows' | 'plain' | 'dictionary' | 'words' | 'substring' = 'plain'`.

(e) In `runTotals`, directly above the line `      // The substring plan: today's count plus the rarest whole word, within its own budget (an overrun throws, so it is today's count that runs).` insert:

```ts
      // The word plan: three disjoint branches merged as aggregate states, within its own budget (an overrun throws, so it is today's count that runs).
      const wordCandidates = await getWordCandidates()
      if (wordCandidates) {
        const text = wordTextBranch(whereRaw, qClause)
        const sql = text && buildDictionaryTotalsSql({
          whereRaw, dedupe, hasUserFilter, onlyIf: excludeNoise ? NOISE_FILTER : undefined, candidates: wordCandidates,
          text, maxSeconds: WORD_TOTALS_BUDGET_SECONDS, overflow: 'throw',
        })
        if (sql) {
          const outcome = await runWithBudget('word totals', () => executeQuery(sql, params) as Promise<TotalsRows>)
          if (outcome.ok) {
            totalsPlan = 'words'
            return outcome.value
          }
        }
      }
```

(f) In `runDataQuery`, directly above the block that starts with `const choice = await getSubstringChoice()` followed by `if (choice) {` and `const conjunct = substringConjunct(choice.token)` and `const outcome = await runWithBudget('substring rows'` (the one inside `runDataQuery`, not the one in `runTotals`), insert:

```ts
      // The word plan, for a rare word only (the gate), within its own budget: an overrun or a failure runs today's query.
      if (wordTerm) {
        const [wordCandidates, wordHits] = await Promise.all([getWordCandidates(), probeTokenHits(wordTerm.word)])
        if (wordCandidates && wordRowsGate(wordCandidates, wordHits)) {
          const text = wordTextBranch(where, qClause)
          const sql = text && buildDictionaryRowsSql({
            where, cursorClause, orderBy, dedupe, dedupeInWindow,
            rawCols: RAW_COLS, selectList: SELECT, sortMaxMemoryBytes: SORT_MAX_MEMORY_BYTES, normColsSetting: NORM_COLS_SETTING, candidates: wordCandidates,
            text, maxSeconds: WORD_ROWS_BUDGET_SECONDS,
          })
          if (sql) {
            const outcome = await runWithBudget('word rows', () => executeQuery(sql, dataParams) as Promise<unknown[]>)
            if (outcome.ok) {
              plan = 'words'
              return outcome.value
            }
          }
        }
      }
```

(g) The comment above the response's `plan`: `'dictionary' (lib/search-dictionary-plan.ts), 'substring' (lib/search-substring-plan.ts) or 'plain'` becomes `'dictionary' and 'words' (lib/search-dictionary-plan.ts), 'substring' (lib/search-substring-plan.ts) or 'plain'`.

- [x] **Step 4: Run the new tests and every route test**

Run: `npx vitest run __tests__/credentials-route-words.test.ts __tests__/credentials-route-substring.test.ts __tests__/credentials-route.test.ts __tests__/credentials-route-dictionary.test.ts __tests__/credentials-route-totals.test.ts __tests__/credentials-route-login-scope.test.ts __tests__/credentials-route-newest-first.test.ts __tests__/credentials-route-imported-range.test.ts __tests__/credentials-route-dedupe-window.test.ts __tests__/cursor-raw-columns.test.ts __tests__/ulp-normalize-setting.test.ts 2>&1 | grep -E "×|FAIL|Tests |Test Files"`
Expected: all pass. A failure in an older file means the route changed today's SQL: fix the route, not the old test.

- [x] **Step 5: Mutation checks**

(1) In the route replace `wordRowsGate(wordCandidates, wordHits)` by `true`: the three rows-gate tests must FAIL; restore. (2) Replace `wordTextBranch(whereRaw, qClause)` in `runTotals` by `wordTextBranch(whereRaw, 'x')`: the totals tests must FAIL (they fall back to the plain count); restore. Re-run the new file: all pass.

- [x] **Step 6: Commit**

```bash
git add app/api/credentials/route.ts __tests__/credentials-route-words.test.ts
git commit -m "feat(search): the credentials route answers a single word through the text indexes and the dictionaries (word plan)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Live parity and the calibration of the rows gate

**Files:**
- Create: `__tests__/word-plan-parity.live.test.ts`
- Modify (after the measurement): `lib/search-plan-gate.ts` and `__tests__/search-plan-gate.test.ts` (the three defaults), the header table of the gate's comment

**Interfaces:**
- Consumes: the route, `wordTermFromQuery`, `resolveWordCandidates`, `probeTokenHits`, `wordRowsGate`.

- [x] **Step 1: Write the live test**

Create `__tests__/word-plan-parity.live.test.ts`:

```ts
import { execSync } from 'node:child_process'
import { describe, expect, test, vi, afterAll } from 'vitest'

/**
 * LIVE parity check for the word plan (lib/search-dictionary-plan.ts, wordTermFromQuery): for a single word the route's answer through the plan must be
 * IDENTICAL to today's plain query, page after page, for rows and for totals, and never more than SWP_MAX_SLOWDOWN (1.2) times slower. Skipped unless
 * SWP_PARITY=1; it talks to the real ClickHouse (the running ulpsuite_clickhouse container) and prints timings. It drives the real GET /api/credentials
 * handler; the plain query is forced with `token_plans=0`, so the SQL it compares against cannot drift from the route's. A word over the dictionary caps
 * (or a stale dictionary) runs today's query in both cases, so it is reported and skipped; a word that fails only the ROWS gate is compared too (its rows
 * must then come from today's query and be identical, its totals from the plan).
 *
 *   SWP_PARITY=1 npx vitest run __tests__/word-plan-parity.live.test.ts
 *   SWP_PARITY=1 SWP_WORDS=ledger,trezor SWP_SORTS=domain_asc,imported_desc SWP_PAGES=1 npx vitest run __tests__/word-plan-parity.live.test.ts
 *
 *   SWP_WORDS     comma list of words (default: two invented/public ones). Real search terms belong in YOUR environment, never in this file: the repository
 *                 is public.
 *   SWP_SORTS     default domain_asc,imported_desc      SWP_DEDUPES  default 1      SWP_PAGES  default 1      SWP_MAX_SLOWDOWN  default 1.2
 *
 * Calibrating the rows gate: raise the three limits so that every word's rows go through the plan and read the timing table (the assertion on speed is
 * then meaningless, so raise SWP_MAX_SLOWDOWN too):
 *   SEARCH_WORD_ROWS_MAX_DOMAINS=3000 SEARCH_WORD_ROWS_MAX_EMAIL_DOMAINS=300 SEARCH_WORD_ROWS_MAX_TEXT_HITS=50001 SWP_MAX_SLOWDOWN=1000 SWP_PARITY=1 ...
 *
 * The user profile has the query cache on and ClickHouse keeps a per-granule condition cache, so both are dropped before EVERY call.
 */
const LIVE = process.env.SWP_PARITY === '1'
const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(',').map(s => s.trim()).filter(Boolean)
const WORDS = list(process.env.SWP_WORDS, 'zzqxnonexistent,ledger')
const SORTS = list(process.env.SWP_SORTS, 'domain_asc,imported_desc')
const DEDUPES = list(process.env.SWP_DEDUPES, '1')
const PAGES = Number(process.env.SWP_PAGES ?? 1)
const MAX_SLOWDOWN = Number(process.env.SWP_MAX_SLOWDOWN ?? 1.2)

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

describe.skipIf(!LIVE)('word plan parity on the live table', () => {
  afterAll(() => {
    console.log('\nscenario | page | plain ms | plan ms (plan) | rows')
    for (const t of timings) console.log(`${t.scenario} | ${t.page} | ${t.plainMs} | ${t.planMs} (${t.plan}) | ${t.rows}`)
    for (const s of skipped) console.log(s)
  })

  test('the dictionary is fresh, so the comparison below measures the plan and not its fallback', async () => {
    const { getSearchDictionaryStatus, resetSearchDictionaryCache } = await import('@/lib/search-dictionary')
    resetSearchDictionaryCache()
    const status = await getSearchDictionaryStatus()
    console.log(`dictionary: ${status.state}, ${status.pairRows} host pairs, ${status.emailRows} email domains, built ${status.builtAt}`)
    expect(status.state, 'run scripts/build-search-dictionary.ts first').toBe('fresh')
  })

  const matrix = WORDS.flatMap((word, i) => SORTS.flatMap(sort => DEDUPES.map(dedupe => ({ word, sort, dedupe, label: `word #${i + 1}` }))))

  test.each(matrix)('$label | $sort | Unique=$dedupe', async ({ word, sort, dedupe, label }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { getClient } = await import('@/lib/clickhouse')
    const { wordTermFromQuery, resolveWordCandidates, resetDictionaryPlanCache } = await import('@/lib/search-dictionary-plan')
    const { probeTokenHits, wordRowsGate, resetSearchPlanGateCache } = await import('@/lib/search-plan-gate')
    const { resetSearchDictionaryCache } = await import('@/lib/search-dictionary')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')

    const term = wordTermFromQuery(word, false)
    resetDictionaryPlanCache(); resetSearchPlanGateCache(); resetSearchDictionaryCache()
    const candidates = term ? await resolveWordCandidates(term) : null
    if (!term || !candidates) {
      skipped.push(`${label}: over the dictionary caps, not a plain word or no fresh dictionary: today's query runs, nothing to compare`)
      return
    }
    const hits = await probeTokenHits(term.word)
    const rowsPlan = wordRowsGate(candidates, hits)

    const call = async (qs: string, cold: boolean) => {
      if (cold) { resetDictionaryPlanCache(); resetSearchPlanGateCache(); resetSearchDictionaryCache() }
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
      await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
      const ms = Date.now() - t0
      return { ms, body: await res.json() }
    }
    const base = `q=${encodeURIComponent(word)}&sort=${sort}&limit=200&exclude_noise=1&dedupe=${dedupe}`
    const scenario = `${label} (|D| ${candidates.domains.length}, |E| ${candidates.emailDomains.length}, ${hits} hits, rows ${rowsPlan ? 'plan' : 'plain'}) ${sort} U${dedupe}`
    const slow = (plan: number, plain: number) => plan <= plain * MAX_SLOWDOWN + 1000
    // Newest first is answered by the time windows when they can (a word concentrated in new data); the plan or the plain query only after they hand off.
    const expectedRows = rowsPlan ? (sort === 'imported_desc' ? ['words', 'windows'] : ['words']) : (sort === 'imported_desc' ? ['plain', 'windows'] : ['plain'])

    let cursor = ''
    for (let page = 1; page <= PAGES; page++) {
      const extra = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const plain = await call(`${base}&skip_totals=1&token_plans=0${extra}`, true)
      const planned = await call(`${base}&skip_totals=1${extra}`, page === 1)
      expect(plain.body.success, `page ${page} (plain): ${JSON.stringify(plain.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.success, `page ${page}: ${JSON.stringify(planned.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.results).toEqual(plain.body.results)
      expect(planned.body.next_cursor).toEqual(plain.body.next_cursor)
      expect(expectedRows, `which plan answered the rows: ${scenario} page ${page}`).toContain(planned.body.plan)
      if (planned.body.plan === 'words') expect(slow(planned.ms, plain.ms), `${scenario} page ${page}: plan ${planned.ms} ms against plain ${plain.ms} ms`).toBe(true)
      timings.push({ scenario, page: String(page), plainMs: plain.ms, planMs: planned.ms, plan: planned.body.plan, rows: plain.body.results.length })
      if (!plain.body.next_cursor) break
      cursor = plain.body.next_cursor
    }

    const plainTotals = await call(`${base}&totals_only=1&token_plans=0`, true)
    const plannedTotals = await call(`${base}&totals_only=1`, true)
    expect(plannedTotals.body.success).toBe(true)
    expect({ total: plannedTotals.body.total, raw_total: plannedTotals.body.raw_total })
      .toEqual({ total: plainTotals.body.total, raw_total: plainTotals.body.raw_total })
    expect(plannedTotals.body.plan, `${scenario}: the totals plan fell back (over its budget or failing)`).toBe('words')
    expect(slow(plannedTotals.ms, plainTotals.ms), `${scenario} totals: plan ${plannedTotals.ms} ms against plain ${plainTotals.ms} ms`).toBe(true)
    timings.push({ scenario, page: 'totals', plainMs: plainTotals.ms, planMs: plannedTotals.ms, plan: plannedTotals.body.plan, rows: Number(plannedTotals.body.total) })
  }, 60 * 60_000)
})
```

- [x] **Step 2: Smoke run with the invented word**

Run: `SWP_PARITY=1 SWP_WORDS=zzqxnonexistent npx vitest run __tests__/word-plan-parity.live.test.ts 2>&1 | grep -aE "✓|×|Tests |scenario|\| words|\| plain|skipped|over the dictionary"`
Expected: the dictionary test and both sort scenarios pass; the table shows `words` for rows and totals with plan times under 1 s against 10 to 17 s plain. If the dictionary is not fresh, build it first (`npx tsx scripts/build-search-dictionary.ts`).

- [x] **Step 3: Choose the calibration words (shell environment only)**

The calibration set is about 20 words: the owner's words that sit inside the caps (from the query log, in the scratchpad file `words.txt`; their statistics come from `wordstats.py`) plus about 12 public or generic words that spread the three numbers. Compute `|D|`, `|E|` and the capped text hits of a candidate list with `python3 /tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad/wordstats2.py w1 w2 ...` and keep words so that the set contains at least: three with `|D|` of 20 or less; three with `|D|` between 100 and 600 and few hits; three with 5,000 to 50,000 hits; two with `|D|` above 600 (up to the 3,000 cap). Write the final comma list into `$SC/calib-words.txt` (never into the repository).

- [x] **Step 4: Run the calibration (read-only, in the background, about 15 minutes)**

```bash
SC=/tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad
SWP_WORDS="$(paste -sd, $SC/calib-words.txt)" SWP_SORTS=domain_asc SWP_PAGES=1 SWP_MAX_SLOWDOWN=1000 \
SEARCH_WORD_ROWS_MAX_DOMAINS=3000 SEARCH_WORD_ROWS_MAX_EMAIL_DOMAINS=300 SEARCH_WORD_ROWS_MAX_TEXT_HITS=50001 SWP_PARITY=1 \
npx vitest run __tests__/word-plan-parity.live.test.ts > $SC/swp-calib.log 2>&1; echo "exit $?" >> $SC/swp-calib.log
```
Expected: every scenario passes (identical rows and totals). The table at the end lists, per word, `|D|`, `|E|`, the hits, the plain and plan milliseconds for the rows page and for the totals.

- [x] **Step 5: Fix the three defaults from the table**

Rule: the gate may admit a word only if the plan's rows were at most 1.2 times today's rows plus one second. Take every row of the table whose rows plan won by that rule; the limits are the largest `|D|` (rounded down to the nearest 50), `|E|` (nearest 25) and hits (nearest 1,000) such that every measured word at or below ALL THREE limits won. If the starting values 300 / 100 / 20,000 already satisfy the rule and the wins extend well beyond them, raise the limits to the measured edge; if a loss sits inside them, lower the limit that excludes it. Write the three new numbers into `wordRowsMaxDomains`, `wordRowsMaxEmailDomains`, `wordRowsMaxTextHits` (and into `Global Constraints` above and the README text of Task 7), update the test `the starting values` in `__tests__/search-plan-gate.test.ts` and the boundary cases of `the gate` test, and add to the comment above the three functions a compact table of the measured points (no words: `|D|`, `|E|`, hits, today's rows seconds, plan rows seconds).

If the new domain limit is 400 or more, raise `GATE_DOMAINS` in Task 6's seed (it must stay above the limit and under the dictionary cap of 3,000), and the `400` in the check label.

If the totals column shows ANY word whose totals plan took more than 1.2 times today's totals plus one second, stop: that is a design change (a totals gate) and goes back to the owner.

- [x] **Step 6: Re-run with the DEFAULT gates on all words, both sorts**

```bash
SC=/tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad
SWP_WORDS="$(paste -sd, $SC/calib-words.txt)" SWP_SORTS=domain_asc,imported_desc SWP_PAGES=1 SWP_PARITY=1 \
npx vitest run __tests__/word-plan-parity.live.test.ts > $SC/swp-final.log 2>&1; echo "exit $?" >> $SC/swp-final.log
```
Expected: exit 0: identical results everywhere, the plan never more than 1.2 times plus one second slower, rows on `words` exactly for the words that pass the gate.

- [x] **Step 7: Commit**

```bash
git add __tests__/word-plan-parity.live.test.ts lib/search-plan-gate.ts __tests__/search-plan-gate.test.ts
git commit -m "test(search): live parity for the word plan; the rows gate calibrated on real words" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The rehearsal scenarios (isolated stack)

**Files:**
- Modify: `scripts/e2e-search-dictionary.ts`

The rehearsal stack has a fresh table whose `proj_imported_desc` covers every part, which is the situation the live table is not in today: it is where a mixed-case row would show a disagreement between the text-index `NOT L` and a case-sensitive plain `hasToken`, and where a planner that chose a projection for T or H would make the branches overlap.

- [x] **Step 1: Add the word scenarios**

In `scripts/e2e-search-dictionary.ts`:

(a) Header: after the line `* Every term is unique per run ...` add `* Sections [8] to [10] rehearse the SINGLE-WORD plan (lib/search-dictionary-plan.ts, wordTermFromQuery) on the same dictionary; --words-only skips [2] to [7].`

(b) After `const BYTES_TERM = ...` add:

```ts
// single words (letters and digits only: they must be eligible for the word plan)
const WORD = `wq${RUN}`
const GATE_WORD = `gw${RUN}`
const CAPW_WORD = `cw${RUN}`
const WORDS_ONLY = process.argv.includes('--words-only')
```

(c) After `function seed(): void { ... }` add:

```ts
function seedWords(): void {
  const src = (name: string) => `'seedw-${RUN}-${name}'`
  const W = WORD
  const U = WORD.toUpperCase()
  // the word as a token of the host (T and D both reach these rows), the same in capitals (the text index finds it, a case-sensitive hasToken would not)
  insert(`SELECT 'https://${W}.test/login', concat('user', toString(number), '@mail-', toString(number % 7), '.test'), concat('Pw-', toString(number), '-Aa1!'), '${W}.test', ${src('host')}, '' FROM numbers(300)`)
  insert(`SELECT 'https://${U}.TEST/Login', concat('mixed', toString(number), '@mail.test'), concat('Mx-', toString(number)), '${W}.test', ${src('mixedurl')}, '' FROM numbers(20)`)
  // the word INSIDE a longer host (not a token: only HOST sees it, so only H), and the same host under a blank domain (the empty domain must stay in D)
  insert(`SELECT 'https://my${W}shop.test/', concat('s', toString(number), '@mail.test'), concat('Sh-', toString(number)), 'my${W}shop.test', ${src('inner')}, '' FROM numbers(20)`)
  insert(`SELECT 'https://my${W}shop.test/', concat('b', toString(number), '@mail.test'), concat('Bd-', toString(number)), '', ${src('blankdomain')}, '' FROM numbers(5)`)
  // the word only as a token of the path, of the password (also in capitals), of the login: T alone
  insert(`SELECT 'https://other-site.test/${W}/signin', concat('pt', toString(number), '@mail.test'), concat('Pt-', toString(number)), 'other-site.test', ${src('path')}, '' FROM numbers(20)`)
  insert(`SELECT 'https://unrelated.test/', concat('p', toString(number), '@mail.test'), 'my-${W}-pass', 'unrelated.test', ${src('pw')}, '' FROM numbers(10)`)
  insert(`SELECT 'https://unrelated.test/', concat('P', toString(number), '@mail.test'), 'MY-${U}-PASS', 'unrelated.test', ${src('pwcaps')}, '' FROM numbers(10)`)
  insert(`SELECT 'https://unrelated.test/', concat('${W}.user', toString(number), '@mail.test'), concat('Lg-', toString(number)), 'unrelated.test', ${src('login')}, '' FROM numbers(10)`)
  // rows only branch E reaches: the word inside an e-mail domain on an unrelated site, a blank domain, a NON-ASCII e-mail domain (reverse() is bytewise)
  insert(`SELECT 'https://other-site.test/', concat('x', toString(number), '@mail-${W}shop.test'), concat('Xe-', toString(number)), 'other-site.test', ${src('email')}, '' FROM numbers(25)`)
  insert(`SELECT '', concat('y', toString(number), '@mail-${W}shop.test'), concat('Ye-', toString(number)), '', ${src('blankemail')}, '' FROM numbers(5)`)
  insert(`SELECT 'https://other-site.test/', concat('z', toString(number), '@${W}shop.пример'), concat('Ze-', toString(number)), 'other-site.test', ${src('nonascii')}, '' FROM numbers(5)`)
  // duplicates (Unique collapses them), noise (Declutter hides it), controls
  insert(`SELECT 'https://${W}.test/login', concat('user', toString(number), '@mail-', toString(number % 7), '.test'), concat('Pw-', toString(number), '-Aa1!'), '${W}.test', ${src('dup')}, '' FROM numbers(10)`)
  insert(`SELECT 'http://192.0.2.9/${W}/admin.php', concat('n', toString(number), '@mail.test'), concat('Nz-', toString(number)), '192.0.2.9', ${src('noise')}, '' FROM numbers(10)`)
  insert(`SELECT 'https://unrelated.test/', concat('c', toString(number), '@mail.test'), concat('Cn-', toString(number)), 'unrelated.test', ${src('control')}, '' FROM numbers(200)`)
  // the gates: GATE_DOMAINS candidate domains (over the rows gate, SEARCH_WORD_ROWS_MAX_DOMAINS, which was 300 when this was written, and under the dictionary
  // cap of 3,000: totals from the plan, rows from today's query; raise it if the gate's limit is ever raised to 400 or more) and 3,200 (over the cap)
  const GATE_DOMAINS = 400
  insert(`SELECT concat('https://g', toString(number), '.${GATE_WORD}.test/'), concat('g', toString(number), '@mail.test'), 'pw', concat('g', toString(number), '.${GATE_WORD}.test'), ${src('gate')}, '' FROM numbers(${GATE_DOMAINS})`)
  insert(`SELECT concat('https://c', toString(number), '.${CAPW_WORD}.test/'), concat('c', toString(number), '@mail.test'), 'pw', concat('c', toString(number), '.${CAPW_WORD}.test'), ${src('capw')}, '' FROM numbers(3200)`)
}
```

(d) In `main()`, four edits (leave the indentation of the existing sections as it is; the guards are the only new lines):

1. Section [1]: after `seed()` add `seedWords()`, and make the wait for the dictionary robust against a stack that already holds a fresh dictionary from an earlier run (the new rows make it stale, but its freshness verdict is cached for 3 s). Replace

```ts
  const first = await waitFresh()
```
with
```ts
  await waitFor(async () => { const d = await dictState(); return d && d.state !== 'fresh' ? d : null }, 30_000, 500) // the inserts make an existing dictionary stale
  await sleep(3500) // past the 3 s freshness cache
  const first = await waitFresh()
```
2. Open a guard before section [2], i.e. insert the line `  if (!WORDS_ONLY) {` directly above `  console.log('\n[2] the dictionary plan returns exactly what the plain query returns')`, and close it directly after the last statement of section [4], the line beginning `  check('2,000 long domains (over the 90,000-byte list cap): today\'s query answers'`, with a line `  }`.
3. Directly after that closing line insert the sections [8], [9] and [10] of step (e) below (they use the first fresh dictionary, before sections [5] to [7] make it stale).
4. Open a second guard: insert `  if (!WORDS_ONLY) {` directly above `  console.log('\n[5] new data: the plan steps aside until the app has rebuilt, and no row is missed')` and close it directly after the line beginning `  check('both plans answered during the run'` with `  }`; the final summary (`const failed = ...`) stays outside both guards.

(e) Add these sections (between [4] and [5]):

```ts
  console.log('\n[8] the single-word plan returns exactly what the plain query returns')
  for (const sort of ['domain_asc', 'email_asc', 'pw_len_desc', 'imported_desc']) {
    for (const dedupe of [1, 0]) {
      const plain = await walk(WORD, sort, dedupe, true)
      const planned = await walk(WORD, sort, dedupe, false)
      const label = `${WORD}: ${sort}, Unique ${dedupe}: ${plain.pages.length} pages`
      if (plain.error || planned.error) { check(label, false, plain.error ?? planned.error ?? ''); continue }
      const same = plain.pages.length === planned.pages.length
        && plain.pages.every((p, i) => JSON.stringify(p.results) === JSON.stringify(planned.pages[i].results) && p.next_cursor === planned.pages[i].next_cursor)
      check(`${label}, rows and cursors identical`, same)
      const expected = sort === 'imported_desc' ? ['words', 'windows'] : ['words']
      check(`${sort}, Unique ${dedupe}: answered by the ${expected.join(' or ')} plan`, expected.includes(planned.pages[0].plan), String(planned.pages[0].plan))
    }
  }
  for (const [dedupe, noise] of [[1, 1], [0, 0], [1, 0]]) {
    const qs = `&dedupe=${dedupe}&exclude_noise=${noise}&totals_only=1`
    const t1 = await api(`/api/credentials?q=${encodeURIComponent(WORD)}${qs}`)
    const t0 = await api(`/api/credentials?q=${encodeURIComponent(WORD)}${qs}&dictionary=0`)
    check(`the totals equal the plain query's, both numbers (Unique ${dedupe}, Declutter ${noise})`, t1.body?.total === t0.body?.total && t1.body?.raw_total === t0.body?.raw_total, `${JSON.stringify(t1.body)} vs ${JSON.stringify(t0.body)}`)
    check('...the plan counted, today\'s query did not', t1.body?.plan === 'words' && t0.body?.plan === 'plain', `${t1.body?.plan} / ${t0.body?.plan}`)
  }

  console.log('\n[9] the rows each branch alone can reach are found, and none is counted twice')
  const everyWord = (await walk(WORD, 'email_asc', 0, false)).pages.flatMap(p => p.results as any[])
  const plainWordTotal = Number((await api(`/api/credentials?q=${encodeURIComponent(WORD)}&exclude_noise=1&dedupe=0&totals_only=1&dictionary=0`)).body?.total)
  check('no row is returned twice or missed: the plan\'s list has exactly as many rows as today\'s count says', everyWord.length === plainWordTotal, `${everyWord.length} rows against today's total ${plainWordTotal}`)
  check('a row whose host holds the word as a token', everyWord.some(r => r.domain === `${WORD}.test`))
  check('a row whose URL has the word in capitals (the text index is case-insensitive, a plain hasToken is not)', everyWord.some(r => String(r.url).includes(WORD.toUpperCase())))
  check('a row whose PASSWORD has the word in capitals', everyWord.some(r => String(r.password) === `MY-${WORD.toUpperCase()}-PASS`))
  check('a row whose host merely CONTAINS the word', everyWord.some(r => r.domain === `my${WORD}shop.test`))
  check('a row with a blank domain whose host contains the word (the empty domain stays in the candidate list)', everyWord.some(r => r.domain === '' && String(r.url).includes(`my${WORD}shop`)))
  check('a row on an unrelated site whose e-mail domain contains the word', everyWord.some(r => r.domain === 'other-site.test' && String(r.email).endsWith(`@mail-${WORD}shop.test`)))
  check('a row with a blank domain and such an e-mail domain', everyWord.some(r => r.domain === '' && String(r.email).endsWith(`@mail-${WORD}shop.test`)))
  check('a row with a non-ASCII e-mail domain (reverse() is bytewise)', everyWord.some(r => String(r.email).endsWith('.пример')))
  check('a row with the word in its path only', everyWord.some(r => r.domain === 'other-site.test' && String(r.url).includes(`/${WORD}/`)))
  check('a row with the word in its login only', everyWord.some(r => String(r.email).startsWith(`${WORD}.user`)))

  console.log('\n[10] the rows gate and the caps')
  const gateRows = await walk(GATE_WORD, 'domain_asc', 1, false)
  check('400 candidate domains (over the rows gate): today\'s query answers the rows', gateRows.pages[0]?.plan === 'plain', String(gateRows.pages[0]?.plan))
  check('...with the same rows', JSON.stringify(gateRows.pages[0]?.results) === JSON.stringify((await walk(GATE_WORD, 'domain_asc', 1, true)).pages[0]?.results))
  const gateTotals = await api(`/api/credentials?q=${encodeURIComponent(GATE_WORD)}&exclude_noise=1&dedupe=1&totals_only=1`)
  const gateTotalsPlain = await api(`/api/credentials?q=${encodeURIComponent(GATE_WORD)}&exclude_noise=1&dedupe=1&totals_only=1&dictionary=0`)
  check('...but the totals come from the plan, with the same numbers', gateTotals.body?.plan === 'words' && gateTotals.body?.total === gateTotalsPlain.body?.total && gateTotals.body?.raw_total === gateTotalsPlain.body?.raw_total, `${JSON.stringify(gateTotals.body)} vs ${JSON.stringify(gateTotalsPlain.body)}`)
  const capRows = await walk(CAPW_WORD, 'domain_asc', 1, false)
  const capTotals = await api(`/api/credentials?q=${encodeURIComponent(CAPW_WORD)}&exclude_noise=1&dedupe=1&totals_only=1`)
  check('3,200 candidate domains (over the dictionary cap): today\'s query answers rows and totals', capRows.pages[0]?.plan === 'plain' && capTotals.body?.plan === 'plain', `${capRows.pages[0]?.plan} / ${capTotals.body?.plan}`)
  const off = await api(`/api/credentials?q=${encodeURIComponent(WORD)}&exclude_noise=1&dedupe=1&totals_only=1&token_plans=0`)
  check('token_plans=0 forces today\'s query', off.body?.plan === 'plain', String(off.body?.plan))
```

- [x] **Step 2: Typecheck and lint the script**

Run: `npx tsc --noEmit; echo "tsc exit $?"; npx eslint scripts/e2e-search-dictionary.ts; echo "eslint exit $?"`
Expected: both exit 0.

- [x] **Step 3: Commit**

```bash
git add scripts/e2e-search-dictionary.ts
git commit -m "test(search): rehearsal scenarios for the single-word plan (mixed case, blank and non-ASCII domains, gates)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docs, configuration, the whole gate, push

**Files:**
- Modify: `README.md`, `.env.example`, `docker-compose.yml`, the spec's status line, this plan's boxes.

- [x] **Step 1: Configuration**

`docker-compose.yml`, after the `SEARCH_TOKEN_PLANS` line of the app service:

```yaml
      # Word plan rows gate (lib/search-plan-gate.ts) -- optional, empty = the defaults in code (the calibrated values).
      SEARCH_WORD_ROWS_MAX_DOMAINS: ${SEARCH_WORD_ROWS_MAX_DOMAINS:-}
      SEARCH_WORD_ROWS_MAX_EMAIL_DOMAINS: ${SEARCH_WORD_ROWS_MAX_EMAIL_DOMAINS:-}
      SEARCH_WORD_ROWS_MAX_TEXT_HITS: ${SEARCH_WORD_ROWS_MAX_TEXT_HITS:-}
```

`.env.example`, extend the "Token plans" block with (using the calibrated numbers of Task 5):

```
# A single-word search is answered by the word plan for its TOTALS whenever the word has at most SEARCH_DICT_MAX_DOMAINS candidate domains and
# SEARCH_DICT_MAX_EMAIL_DOMAINS candidate e-mail domains (the domain search dictionary's caps), and for its first ROWS only when the word is rare: at most
# these many candidate domains, candidate e-mail domains and text-index hits (a plentiful word is faster with the original query). Defaults are the measured values.
# SEARCH_WORD_ROWS_MAX_DOMAINS=300
# SEARCH_WORD_ROWS_MAX_EMAIL_DOMAINS=100
# SEARCH_WORD_ROWS_MAX_TEXT_HITS=20000
```

- [x] **Step 2: README**

(1) In the dictionary section change "(`dictionary`, `windows`, `substring` or `plain`)" to "(`dictionary`, `words`, `windows`, `substring` or `plain`)". (2) Directly above `### Faster substring searches (speed)` add a section `### Faster single-word searches (speed)` that says: what a one-word search looks at (the whole word in URL, login and password, and the word inside hosts and e-mail domains) and why it was slow (an OR of five parts that no index can prune together: 13-22 s for the totals and 10-17 s for the first rows of a rare word, 26-150 s as logged while the machine was busy); what the page does now (three disjoint parts: the text indexes for the word as a token, and the dictionaries of the domain search for the hosts and e-mail domains that contain it; the original test stays in every part, so rows, order, cursors and totals are the same, compared exactly on real searches); the numbers (totals 13 s to 0.3-1.2 s for a rare word and 14-22 s to 6-9 s for words with thousands of matches; rows 10-17 s to 0.1-2 s for a rare word) taken from the calibration table; what stays as it was (rows of a plentiful word, words over the dictionary caps, words with a hyphen or underscore, the Newest-first windows first); the safety net (4 s budget for rows, 12 s for totals, then the original query; any error the same); and the switches (`SEARCH_TOKEN_PLANS=0`, `SEARCH_DICTIONARY=0`, `dictionary=0` and `token_plans=0` per request, the three `SEARCH_WORD_ROWS_*` limits). (3) In the performance table add a row after the substring row: `| Single-word search | totals 13-22 s before; 0.3-9 s inside the dictionary caps. Rows: 10-17 s before; 0.1-2 s for a rare word (the three limits above), otherwise unchanged. The response's `plan` says `words` |`.

- [x] **Step 3: Spec and plan status**

Set the spec's Status line to say that A (the word plan) is implemented per `docs/superpowers/plans/2026-10-13-word-search-plan.md` and, after the roll-out, deployed; add a "A as deployed" paragraph under Rollout with the calibration table's summary and the live numbers. Tick every box in this plan.

- [x] **Step 4: The whole gate (run once)**

```bash
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components scripts/e2e-search-dictionary.ts __tests__/search-word-plan.test.ts __tests__/search-word-plan-sql.test.ts __tests__/credentials-route-words.test.ts __tests__/word-plan-parity.live.test.ts __tests__/search-plan-gate.test.ts; echo "eslint exit $?"
npx vitest run 2>&1 | tail -15
```
Expected: `tsc exit 0`, `eslint exit 0`, vitest: all files passed, 0 failed.

- [x] **Step 5: Commit and push**

```bash
git add README.md .env.example docker-compose.yml docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md docs/superpowers/plans/2026-10-13-word-search-plan.md
git commit -m "docs(search): the single-word plan (README section and perf row, rows-gate limits, spec and plan status)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push origin main
```
Expected: CI (typecheck, test, lint, build) green on the pushed head (`gh run list --limit 1`, once).

---

### Task 8: Rehearse the exact image, then roll out

**Files:** none new.

- [x] **Step 1: Rollback tag, then build the candidate from the pushed commit**

```bash
STAMP=$(date -u +%Y%m%d-%H%Mz)
docker tag "$(docker inspect ulpsuite_app --format '{{.Image}}')" "ulp-suite-app:rollback-$STAMP"
SCRATCH=/tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad
mkdir -p "$SCRATCH/dockercfg" && echo '{}' > "$SCRATCH/dockercfg/config.json"
rm -rf "$SCRATCH/word-build" && mkdir -p "$SCRATCH/word-build" && git archive HEAD | tar -x -C "$SCRATCH/word-build"
DOCKER_CONFIG="$SCRATCH/dockercfg" docker build -t ulp-suite-app:word-candidate "$SCRATCH/word-build"
```
Expected: the image is tagged `ulp-suite-app:word-candidate`; `ulp-suite-app:latest` is untouched.

- [x] **Step 2: Rehearse the candidate on the isolated stack (about 15 minutes)**

```bash
export REHEARSAL_APP_IMAGE=ulp-suite-app:word-candidate
npx tsx scripts/e2e-alert-rehearsal.ts --keep      # brings the stack up and leaves it running (about 4 minutes)
npx tsx scripts/e2e-search-dictionary.ts           # sections [1] to [10]
```
Expected: every check PASS, `N/N checks passed`, exit 0. Then tear the stack down with the `docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v` line from the script header (it wants the four `REHEARSAL_*` variables set to any value). A FAIL is investigated and fixed (new commit, re-push, rebuild the candidate, re-rehearse) before anything touches the live app. `--words-only` re-runs just sections [8] to [10] on a stack that is still up.

- [x] **Step 3: Deploy `app` only**

```bash
export DOCKER_CONFIG=/tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad/dockercfg
docker tag ulp-suite-app:word-candidate ulp-suite-app:latest
docker compose -p ulp-suite -f /home/cole/ulp-suite/docker-compose.yml --project-directory /home/cole/ulp-suite --env-file /home/cole/ulp-suite/.env up -d --no-deps app
```
Expected (after the inbox and ClickHouse are checked idle first): the app container is recreated (about 30 s); `docker inspect ulpsuite_app --format '{{.State.Health.Status}} {{.RestartCount}}'` reads `healthy 0`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login` reads 200; the container env still has `CONTENT_DEDUP_APPLY=false`; the route bundle contains the plan (`docker exec ulpsuite_app sh -c 'grep -rl "word rows" /app/.next/server/app/api/credentials | head -1'` prints a file).

- [x] **Step 4: Live parity at the deployed commit (read-only)**

Run the final form of Task 5 Step 6 on the owner's words that sit inside the caps and on two words over them, one sort, one page, plus the invented absent word. Expected: all pass.

- [x] **Step 5: Record it**

Set the spec's status line to `A implemented and deployed locally on <date>` with the commit, image id and rollback tag; update the memory notes (`project_search_levers_measured_2026_10_13.md`, the ledger, `MEMORY.md`) with what shipped, the calibration table, the live numbers and the follow-ups (the owner trying a one-word search in the browser; the common words that stay on today's query because of the dictionary caps); commit and push the docs (`docs(search): ...`).
