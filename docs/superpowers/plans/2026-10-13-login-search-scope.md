# Login-only Search Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Search in" dropdown (All fields, Login whole word, Login contains) and a `login:` prefix on the credentials search, plus a casing probe that lets the exact e-mail lookup find the common capitalisations.

**Architecture:** Every parsed search term carries a scope (`all`, `login`, `login_contains`). `parseULPQuery` reads the `login:` prefix and takes a default scope; `buildULPWhere` and `buildULPWhereRegex` emit login-only SQL for the two login scopes, so the credentials route, the CSV export, `/api/search` and API v1 all pick the scope up through one code path. The routes validate a `scope` parameter; the page adds a native select. No schema change.

**Tech Stack:** TypeScript, Next.js route handlers, ClickHouse 26.3 (text index and bloom filter on `email`), vitest.

Spec: `docs/superpowers/specs/2026-10-13-login-search-scope-design.md` (read it first; this plan implements it and changes none of its decisions).

## Global Constraints

- Scope names, exactly: `all`, `login`, `login_contains`. The request parameter is `scope`; absent or empty means `all`; anything else is HTTP 400 `{ "success": false, "error": "scope must be all, login or login_contains" }`.
- The prefix is `login:` (case-insensitive, after an optional `-`) and always means a whole word in the login, whatever the default scope is.
- Dropdown labels, exactly: `All fields`, `Login (whole word)`, `Login (contains)`. Placeholders and title: the strings in `lib/search-scope.ts` (Task 1).
- Every user value reaches ClickHouse as a bound `{name:Type}` parameter; nothing is spliced into SQL.
- Login (contains) is `positionCaseInsensitive(email, value) > 0`; it folds ASCII case only.
- The casing probe tries at most six values, the lowercased value first, in `email IN (...)`.
- The repository is public: no real address, file name or search term in code, tests, docs or commit messages. Use `example.com`, `john.smith`, `maria` (a generic given name).
- No schema change, no migration, no new index.
- One commit per task, tests red before green. `npx tsc --noEmit` and the whole `npx vitest run` must pass before the deploy. Tag the running image as the rollback BEFORE building.
- Work in a worktree of the branch `login-search-scope`; never run `docker compose build` from a worktree.

## File Structure

Create:
- `lib/search-scope.ts`: the `SearchScope` type, the allow-list parser, the select options, placeholders and title. Pure, no server code, imported by the builder, both routes and the page.
- `__tests__/search-scope.test.ts`
- `__tests__/ulp-search-login-parse.test.ts`: the `login:` prefix and the default scope.
- `__tests__/ulp-search-login-build.test.ts`: the SQL of the two login scopes, regex, neutrality, `loginWords`.
- `__tests__/ulp-search-casings.test.ts`: the casing probe.
- `__tests__/credentials-route-login-scope.test.ts`: the GET handler with a mocked ClickHouse.
- `__tests__/export-route-scope.test.ts`, `__tests__/credentials-page-scope.test.ts`: source-text tests in the repo's existing style.
- `__tests__/login-scope-parity.live.test.ts`: read-only parity against the real table, skipped unless `LSP_PARITY=1`.

Modify:
- `lib/ulp-search.ts`: `ParsedToken.scope`, `parseULPQuery(raw, defaultScope)`, `loginWords`, `exactAddressMatch`, `buildLoginMatch`, `emailCasings`, the regex builder, `isIndexNeutralSearch`.
- `lib/search-dictionary-plan.ts`: the dictionary applies only to scope `all`.
- `app/api/credentials/route.ts`, `app/api/export/route.ts`: the `scope` parameter.
- `app/credentials/page.tsx`: state, select, request parameters, export body, Clear.
- `__tests__/ulp-search.test.ts`: four tests that assert the old single-address SQL.
- `README.md`, `docs/superpowers/specs/2026-10-13-login-search-scope-design.md` (status line).

---

### Task 1: The scope type and its allow-list

**Files:**
- Create: `lib/search-scope.ts`, `__tests__/search-scope.test.ts`

**Interfaces:**
- Produces: `type SearchScope = 'all' | 'login' | 'login_contains'`; `SEARCH_SCOPES: readonly SearchScope[]`; `parseSearchScope(raw: unknown): SearchScope | null`; `SEARCH_SCOPE_OPTIONS: ReadonlyArray<{ value: SearchScope; label: string }>`; `SEARCH_SCOPE_PLACEHOLDERS: Record<SearchScope, string>`; `SEARCH_SCOPE_TITLE: string`.

- [ ] **Step 1: Set up the worktree**

```bash
cd /home/cole/ulp-suite && git fetch -q origin && git switch main && git merge --ff-only origin/main
git worktree add .claude/worktrees/login-search-scope -b login-search-scope origin/main
cp -al .claude/worktrees/reversible-pipeline/node_modules .claude/worktrees/login-search-scope/node_modules
```

Expected: the worktree exists and `ls .claude/worktrees/login-search-scope/node_modules | wc -l` prints about 427. Run every later command from `/home/cole/ulp-suite/.claude/worktrees/login-search-scope` (the primary checkout's own `node_modules` still matches an older lockfile).

- [ ] **Step 2: Write the failing test**

Create `__tests__/search-scope.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import {
  parseSearchScope, SEARCH_SCOPES, SEARCH_SCOPE_OPTIONS, SEARCH_SCOPE_PLACEHOLDERS, SEARCH_SCOPE_TITLE,
} from '@/lib/search-scope'

describe('parseSearchScope', () => {
  test.each([
    [undefined, 'all'], [null, 'all'], ['', 'all'],
    ['all', 'all'], ['login', 'login'], ['login_contains', 'login_contains'],
  ])('%s -> %s', (raw, want) => {
    expect(parseSearchScope(raw)).toBe(want)
  })

  test.each(['LOGIN', 'Login', 'login ', ' login', 'password', 'url', '1', ' ', 'all,login', 'login_contain'])(
    '%j is refused', raw => {
      expect(parseSearchScope(raw)).toBeNull()
    },
  )

  test('a value that is not a string is refused', () => {
    expect(parseSearchScope(1)).toBeNull()
    expect(parseSearchScope({})).toBeNull()
    expect(parseSearchScope(true)).toBeNull()
    expect(parseSearchScope(['login'])).toBeNull()
  })
})

describe('the select', () => {
  test('one option per scope, in the order of SEARCH_SCOPES, All fields first', () => {
    expect(SEARCH_SCOPE_OPTIONS.map(o => o.value)).toEqual([...SEARCH_SCOPES])
    expect(SEARCH_SCOPE_OPTIONS[0]).toEqual({ value: 'all', label: 'All fields' })
  })

  test('the labels are the ones the owner chose', () => {
    expect(SEARCH_SCOPE_OPTIONS.map(o => o.label)).toEqual(['All fields', 'Login (whole word)', 'Login (contains)'])
  })

  test('every scope has a placeholder and the title explains the prefix', () => {
    for (const s of SEARCH_SCOPES) expect(SEARCH_SCOPE_PLACEHOLDERS[s].length).toBeGreaterThan(5)
    expect(SEARCH_SCOPE_PLACEHOLDERS.all).toBe('Search URL / email / password…')
    expect(SEARCH_SCOPE_TITLE).toContain('login:')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run __tests__/search-scope.test.ts`
Expected: FAIL, "Failed to resolve import @/lib/search-scope".

- [ ] **Step 4: Write the module**

Create `lib/search-scope.ts`:

```ts
/**
 * Where a search term is looked up (docs/superpowers/specs/2026-10-13-login-search-scope-design.md).
 *
 *   all             the url, the login and the password and the host columns: the search as it always was
 *   login           the login as a WHOLE WORD: the text index on `email` answers it (about 0.2 s on 1.8 billion rows)
 *   login_contains  anywhere inside the login: a scan of the login column (about 25 s)
 *
 * Shared by the query builder (lib/ulp-search.ts), the two routes and the credentials page, so it holds no server-only code.
 */
export type SearchScope = 'all' | 'login' | 'login_contains'

export const SEARCH_SCOPES: readonly SearchScope[] = ['all', 'login', 'login_contains']

/** The scope a `scope` request parameter names: absent or empty means 'all'; null when it is anything else. */
export function parseSearchScope(raw: unknown): SearchScope | null {
  if (raw === undefined || raw === null || raw === '') return 'all'
  return typeof raw === 'string' && (SEARCH_SCOPES as readonly string[]).includes(raw) ? (raw as SearchScope) : null
}

/** The options of the "Search in" select, in display order. */
export const SEARCH_SCOPE_OPTIONS: ReadonlyArray<{ value: SearchScope; label: string }> = [
  { value: 'all', label: 'All fields' },
  { value: 'login', label: 'Login (whole word)' },
  { value: 'login_contains', label: 'Login (contains)' },
]

/** The search box placeholder for each scope. */
export const SEARCH_SCOPE_PLACEHOLDERS: Record<SearchScope, string> = {
  all: 'Search URL / email / password…',
  login: 'Search login (whole word)…',
  login_contains: 'Search login (contains)…',
}

/** The tooltip of the select. */
export const SEARCH_SCOPE_TITLE =
  'Search in. Whole word is instant; contains scans the whole login column (about 25 s). Type login:name in the box to look a name up as a whole word in the login, whatever this says.'
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run __tests__/search-scope.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add lib/search-scope.ts __tests__/search-scope.test.ts
git commit -m "feat(search): the search scope type, its allow-list and the select's strings"
```

---

### Task 2: The `login:` prefix and the default scope in the parser

**Files:**
- Modify: `lib/ulp-search.ts` (the header comment, the imports, `ParsedToken`, `parseULPQuery`)
- Create: `__tests__/ulp-search-login-parse.test.ts`

**Interfaces:**
- Consumes: `SearchScope` from Task 1.
- Produces: `ParsedToken.scope: SearchScope` (always set); `parseULPQuery(raw: string, defaultScope?: SearchScope): ParsedToken[]` (default `'all'`); `export type { SearchScope }` re-exported from `lib/ulp-search.ts`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/ulp-search-login-parse.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { parseULPQuery } from '@/lib/ulp-search'

describe('parseULPQuery — scope', () => {
  test('a plain term is in the default scope, which defaults to all', () => {
    expect(parseULPQuery('maria')[0].scope).toBe('all')
    expect(parseULPQuery('maria', 'login')[0].scope).toBe('login')
    expect(parseULPQuery('maria', 'login_contains')[0].scope).toBe('login_contains')
  })

  test('login: sets the scope to login, whatever the default is, and is removed from the value', () => {
    for (const d of ['all', 'login', 'login_contains'] as const) {
      expect(parseULPQuery('login:maria', d)[0]).toMatchObject({ type: 'token', value: 'maria', scope: 'login', negate: false })
    }
  })

  test('the prefix is case-insensitive and may be followed by spaces', () => {
    expect(parseULPQuery('LOGIN:Maria')[0]).toMatchObject({ value: 'Maria', scope: 'login' })
    expect(parseULPQuery('Login:  maria')[0]).toMatchObject({ value: 'maria', scope: 'login' })
  })

  test('-login:name negates; the - comes before the prefix', () => {
    expect(parseULPQuery('-login:test')[0]).toMatchObject({ negate: true, value: 'test', scope: 'login' })
  })

  test('the value after the prefix is classified like any other', () => {
    expect(parseULPQuery('login:john.smith')[0]).toMatchObject({ type: 'domain', value: 'john.smith', scope: 'login' })
    expect(parseULPQuery('login:john@example.com')[0]).toMatchObject({ type: 'email_full', scope: 'login', emailDomain: 'example.com' })
    expect(parseULPQuery('login:@example.com')[0]).toMatchObject({ type: 'email_dom', scope: 'login', emailDomain: 'example.com' })
    expect(parseULPQuery('login:a+b')[0]).toMatchObject({ type: 'like', value: 'a+b', scope: 'login' })
  })

  test('a term that is empty after the prefix is dropped', () => {
    expect(parseULPQuery('login:')).toEqual([])
    expect(parseULPQuery('login:   , maria')).toHaveLength(1)
  })

  test('terms with and without the prefix mix in one query', () => {
    const tokens = parseULPQuery('maria, login:lopez, -login:test', 'login_contains')
    expect(tokens.map(t => [t.value, t.scope, t.negate])).toEqual([
      ['maria', 'login_contains', false],
      ['lopez', 'login', false],
      ['test', 'login', true],
    ])
  })

  test('the word login without a colon is an ordinary term', () => {
    expect(parseULPQuery('login')[0]).toMatchObject({ type: 'token', value: 'login', scope: 'all' })
  })

  test('the classification of an ordinary term is unchanged', () => {
    expect(parseULPQuery('ledger.com')[0]).toMatchObject({ type: 'domain', scope: 'all' })
    expect(parseULPQuery('passw0rd!')[0]).toMatchObject({ type: 'like', scope: 'all' })
    expect(parseULPQuery('John@Gmail.COM')[0]).toMatchObject({ type: 'email_full', emailDomain: 'gmail.com', scope: 'all' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/ulp-search-login-parse.test.ts`
Expected: FAIL (`scope` is undefined, so the first assertions fail).

- [ ] **Step 3: Implement**

In `lib/ulp-search.ts`:

(a) In the header comment, replace the last two lines

```
 *   like       — contains special chars that break token splitting
 *                → LIKE '%value%' full scan (unavoidable; rare in practice)
 */
```

with

```
 *   like       — contains special chars that break token splitting
 *                → LIKE '%value%' full scan (unavoidable; rare in practice)
 *
 * Scopes (lib/search-scope.ts): a term is looked up in every column ('all', the default), as a whole word in the login ('login') or anywhere in the
 * login ('login_contains'). A `login:` prefix on a term always means 'login'. buildLoginMatch has the SQL of the two login scopes.
 */
import type { SearchScope } from '@/lib/search-scope'
export type { SearchScope } from '@/lib/search-scope'
```

(b) Replace everything from the line `export interface ParsedToken {` through the closing `}` of `parseULPQuery` (the line before the `/**` that begins `True when the search means the same thing`) with:

```ts
export interface ParsedToken {
  negate: boolean
  type: 'token' | 'domain' | 'email_full' | 'email_dom' | 'like'
  value: string
  /** For email_full and email_dom: the lowercased domain part after @ */
  emailDomain?: string
  /** Where the term is looked up: every column, a whole word in the login, or anywhere in the login. */
  scope: SearchScope
}

/** A term that starts with this is a whole-word lookup in the login, whatever the default scope is. */
const LOGIN_PREFIX = /^login:/i

/** The type of a term (and the domain of an address) by the shape of its value. The scope is not part of it. */
function classifyTerm(value: string, negate: boolean): Omit<ParsedToken, 'scope'> {
  if (value.includes('@')) {
    const atIdx     = value.indexOf('@')
    const localPart = value.slice(0, atIdx)
    const rawDomain = value.slice(atIdx + 1)
    const emailDomain = rawDomain
      .replace(/^www\./, '')
      .split('/')[0]
      .toLowerCase()

    if (localPart.length > 0 && emailDomain.length > 0) {
      // Full email: john@gmail.com → exact bloom-filter lookup
      return { negate, type: 'email_full', value, emailDomain }
    }
    // Domain-only: @gmail.com → email_domain index
    return { negate, type: 'email_dom', value, emailDomain }
  }

  // Pure word token (alphanumeric + hyphen only) → hasToken()
  if (/^[\w-]+$/.test(value)) return { negate, type: 'token', value }

  // Domain-shaped: two or more dot-separated labels (word chars/hyphens only)
  // → domain/host matching (see buildULPWhere's 'domain' branch for why this
  // is NOT routed through hasToken() -- it throws on any needle containing a
  // separator character, dots included). IP-shaped values like 192.168.1.1
  // also match this pattern and are intentionally included: domain =
  // '192.168.1.1' is a correct, useful lookup for IP-hosted credentials, and
  // this branch never touches hasToken() so there's no separator-character
  // error risk either way.
  if (/^[\w-]+(\.[\w-]+)+$/.test(value)) return { negate, type: 'domain', value }

  return { negate, type: 'like', value }
}

export function parseULPQuery(raw: string, defaultScope: SearchScope = 'all'): ParsedToken[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const negate = s.startsWith('-') && s.length > 1
      let value = (negate ? s.slice(1).trim() : s).trim()
      let scope = defaultScope
      if (LOGIN_PREFIX.test(value)) {
        scope = 'login'
        value = value.replace(LOGIN_PREFIX, '').trim()
      }
      return { ...classifyTerm(value, negate), scope }
    })
    .filter(t => t.value.length > 0)
}
```

- [ ] **Step 4: Run the new test and the existing builder tests**

Run: `npx vitest run __tests__/ulp-search-login-parse.test.ts __tests__/ulp-search.test.ts`
Expected: PASS (the builder still ignores `scope`, so no existing test changes yet).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit; echo "tsc exit $?"`
Expected: `tsc exit 0`.

- [ ] **Step 6: Commit**

```bash
git add lib/ulp-search.ts __tests__/ulp-search-login-parse.test.ts
git commit -m "feat(search): parseULPQuery reads the login: prefix and takes a default scope"
```

---

### Task 3: The SQL of the two login scopes

**Files:**
- Modify: `lib/ulp-search.ts` (helpers before `BuildULPWhereOptions`, the top of `buildULPWhere`'s loop, `buildULPWhereRegex`, `isIndexNeutralSearch`)
- Create: `__tests__/ulp-search-login-build.test.ts`

**Interfaces:**
- Consumes: `ParsedToken.scope`, `SearchScope`.
- Produces: `loginWords(value: string): string[]` (exported); `exactAddressMatch(token, i, params): string` and `buildLoginMatch(token, i, col)` (module-private); `buildULPWhere` and `buildULPWhereRegex` honour `token.scope`; `isIndexNeutralSearch` follows the spec.

- [ ] **Step 1: Write the failing test**

Create `__tests__/ulp-search-login-build.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { parseULPQuery, buildULPWhere, buildULPWhereRegex, isIndexNeutralSearch, loginWords, type SearchScope } from '@/lib/ulp-search'

const build = (q: string, scope: SearchScope = 'all', opts: { caseInsensitiveTokens?: boolean } = {}) =>
  buildULPWhere(parseULPQuery(q, scope), opts)
const neutral = (q: string, scope: SearchScope = 'all', regex = false) => isIndexNeutralSearch(parseULPQuery(q, scope), regex)

describe('buildULPWhere — Login (whole word)', () => {
  test('a word is one hasToken on the login, lowercased', () => {
    const { clause, params } = build('Maria', 'login')
    expect(clause).toBe('(hasToken(email, {lw0:String}))')
    expect(params).toEqual({ lw0: 'maria' })
  })

  test('it never looks at the url, the password or the host columns', () => {
    const { clause } = build('maria, john.smith, a+b', 'login')
    for (const col of ['url', 'password', 'url_host', 'email_domain', 'domain =', 'LIKE']) expect(clause).not.toContain(col)
  })

  test('a dotted name needs every word, then the phrase', () => {
    const { clause, params } = build('John.Smith', 'login')
    expect(clause).toBe('(hasToken(email, {lw0_0:String}) AND hasToken(email, {lw0_1:String}) AND positionCaseInsensitive(email, {lp0:String}) > 0)')
    expect(params).toEqual({ lw0_0: 'john', lw0_1: 'smith', lp0: 'John.Smith' })
  })

  test('a word with an underscore or hyphen is a phrase too, not one token', () => {
    const { clause, params } = build('john_smith', 'login')
    expect(clause).toContain('hasToken(email, {lw0_0:String}) AND hasToken(email, {lw0_1:String}) AND positionCaseInsensitive(email, {lp0:String}) > 0')
    expect(params).toMatchObject({ lw0_0: 'john', lw0_1: 'smith', lp0: 'john_smith' })
  })

  test('a special value uses the words it has and the phrase', () => {
    const { clause } = build('a+b', 'login')
    expect(clause).toBe('(hasToken(email, {lw0_0:String}) AND hasToken(email, {lw0_1:String}) AND positionCaseInsensitive(email, {lp0:String}) > 0)')
  })

  test('a value without any word is only the phrase check', () => {
    expect(build('+++', 'login').clause).toBe('(positionCaseInsensitive(email, {lp0:String}) > 0)')
  })

  test('at most eight words become a hasToken each', () => {
    const { clause } = build('a.b.c.d.e.f.g.h.i.j', 'login')
    expect((clause.match(/hasToken/g) ?? []).length).toBe(8)
    expect(clause).toContain('positionCaseInsensitive(email, {lp0:String}) > 0')
  })

  test('the projection form lowercases the column for the word checks only', () => {
    expect(build('maria', 'login', { caseInsensitiveTokens: true }).clause).toBe('(hasToken(lower(email), {lw0:String}))')
    const dotted = build('john.smith', 'login', { caseInsensitiveTokens: true }).clause
    expect(dotted).toContain('hasToken(lower(email), {lw0_0:String})')
    expect(dotted).toContain('positionCaseInsensitive(email, {lp0:String}) > 0')
  })

  test('@host is the e-mail domain only, without the site clause', () => {
    const { clause, params } = build('@Example.COM', 'login')
    expect(clause).toBe('(email_domain = {edom0:String})')
    expect(params).toEqual({ edom0: 'example.com' })
  })

  test('a full address keeps an exact match on the login', () => {
    const { clause, params } = build('john@example.com', 'login')
    expect(clause).toContain('email')
    expect(clause).not.toContain('hasToken')
    expect(params.exactemail0).toBe('john@example.com')
  })

  test('the login: prefix does the same in the all-fields default', () => {
    expect(build('login:Maria').clause).toBe('(hasToken(email, {lw0:String}))')
  })
})

describe('buildULPWhere — Login (contains)', () => {
  test('a word is a case-insensitive substring check on the login, as typed', () => {
    const { clause, params } = build('Maria', 'login_contains')
    expect(clause).toBe('(positionCaseInsensitive(email, {lc0:String}) > 0)')
    expect(params).toEqual({ lc0: 'Maria' })
  })

  test('a dotted name, a special value and an address are all one substring check', () => {
    for (const q of ['john.smith', 'a+b', 'john@example.com']) {
      expect(build(q, 'login_contains').clause).toBe('(positionCaseInsensitive(email, {lc0:String}) > 0)')
    }
  })

  test('@host is still the e-mail domain', () => {
    expect(build('@example.com', 'login_contains').clause).toBe('(email_domain = {edom0:String})')
  })

  test('the projection option changes nothing', () => {
    expect(build('maria', 'login_contains', { caseInsensitiveTokens: true })).toEqual(build('maria', 'login_contains'))
  })
})

describe('buildULPWhere — negation, mixing and the default scope', () => {
  test('a negated login term is wrapped in NOT', () => {
    expect(build('-login:maria').clause).toBe('NOT (hasToken(email, {lw0:String}))')
    expect(build('-maria', 'login_contains').clause).toBe('NOT (positionCaseInsensitive(email, {lc0:String}) > 0)')
  })

  test('terms of different scopes are ANDed with their own parameter names', () => {
    const { clause, params } = build('maria, login:lopez, ledger.com', 'login_contains')
    expect(clause).toBe('(positionCaseInsensitive(email, {lc0:String}) > 0) AND (hasToken(email, {lw1:String})) AND (positionCaseInsensitive(email, {lc2:String}) > 0)')
    expect(params).toEqual({ lc0: 'maria', lw1: 'lopez', lc2: 'ledger.com' })
  })

  test('the all-fields scope is the search it always was', () => {
    const { clause } = build('maria')
    expect(clause).toContain('hasToken(url, {tok0:String})')
    expect(clause).toContain('url_host LIKE')
    expect(build('ledger.com').clause).toContain('domain = {dom0:String}')
  })
})

describe('buildULPWhereRegex — scope', () => {
  test('a login scope matches the login column only', () => {
    expect(buildULPWhereRegex(parseULPQuery('^adm', 'login')).clause).toBe('(match(email, {rp0:String}))')
    expect(buildULPWhereRegex(parseULPQuery('^adm', 'login_contains')).clause).toBe('(match(email, {rp0:String}))')
    expect(buildULPWhereRegex(parseULPQuery('login:^adm')).clause).toBe('(match(email, {rp0:String}))')
  })

  test('the all-fields scope is unchanged', () => {
    expect(buildULPWhereRegex(parseULPQuery('^adm')).clause).toBe('(match(url, {rp0:String}) OR match(email, {rp0:String}) OR match(password, {rp0:String}))')
  })

  test('negation still wraps the term', () => {
    expect(buildULPWhereRegex(parseULPQuery('-^adm', 'login')).clause).toBe('NOT (match(email, {rp0:String}))')
  })
})

describe('isIndexNeutralSearch — scopes', () => {
  test('contains terms are neutral, whatever their type', () => {
    expect(neutral('maria', 'login_contains')).toBe(true)
    expect(neutral('john.smith, a+b', 'login_contains')).toBe(true)
  })

  test('whole-word terms are not, except an address and @host', () => {
    expect(neutral('maria', 'login')).toBe(false)
    expect(neutral('john.smith', 'login')).toBe(false)
    expect(neutral('a+b', 'login')).toBe(false)
    expect(neutral('john@example.com', 'login')).toBe(true)
    expect(neutral('@example.com', 'login')).toBe(true)
  })

  test('a mixed query is neutral only if every term is', () => {
    expect(neutral('maria, login:lopez', 'login_contains')).toBe(false)
    expect(neutral('maria, @example.com', 'login_contains')).toBe(true)
  })

  test('regex mode is never neutral and the all-fields rules are unchanged', () => {
    expect(neutral('maria', 'login_contains', true)).toBe(false)
    expect(neutral('ledger.com')).toBe(true)
    expect(neutral('hunter2')).toBe(false)
  })
})

describe('loginWords', () => {
  test('cuts a value the way the text index cuts a login, lowercased, without repeats', () => {
    expect(loginWords('John.Smith')).toEqual(['john', 'smith'])
    expect(loginWords('john_smith-88')).toEqual(['john', 'smith', '88'])
    expect(loginWords('a.a.b')).toEqual(['a', 'b'])
  })

  test('only ASCII case is folded; other letters stay as typed', () => {
    expect(loginWords('ИВАН.Smith')).toEqual(['ИВАН', 'smith'])
  })

  test('a value without a word has none', () => {
    expect(loginWords('+++')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/ulp-search-login-build.test.ts`
Expected: FAIL (`loginWords` is not exported; login scopes still produce the all-fields SQL).

- [ ] **Step 3: Implement the helpers**

In `lib/ulp-search.ts`, insert immediately before the line `export interface BuildULPWhereOptions {`:

```ts
/** Most words of a value that become a hasToken each in a whole-word login search; the phrase check enforces the rest. */
const MAX_LOGIN_WORDS = 8

/** Lowercases A-Z only: ClickHouse's lower() and the text index's preprocessor fold ASCII case and leave every other letter as it is. */
const asciiLower = (s: string): string => s.replace(/[A-Z]+/g, m => m.toLowerCase())

/**
 * The words of a value the way the text index cuts a login (splitByNonAlpha): maximal runs of ASCII letters and digits and of non-ASCII
 * characters, ASCII-lowercased, without repeats.
 */
export function loginWords(value: string): string[] {
  return Array.from(new Set(asciiLower(value).match(/[a-z0-9\u0080-￿]+/g) ?? []))
}

/** A full address as an exact match on the login (bloom filter on `email`). Its parameters are added to `params`. */
function exactAddressMatch(token: ParsedToken, i: number, params: Record<string, unknown>): string {
  const ep = `exactemail${i}`
  params[ep] = token.value.toLowerCase()
  return `(email = {${ep}:String})`
}

/**
 * The SQL of a term whose scope is a login scope: only the login column (`email`) is looked at, and for @host its domain column.
 *   login           a word: hasToken on the text index; a dotted or special value: every word of it, then the phrase itself
 *   login_contains  a case-insensitive substring scan of the login column
 *   either          an address keeps the exact match (whole word) or is a substring (contains); @host is email_domain = host
 */
function buildLoginMatch(
  token: ParsedToken, i: number, col: (name: string) => string,
): { match: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {}

  if (token.type === 'email_dom') {
    const p = `edom${i}`
    params[p] = (token.emailDomain ?? '').toLowerCase()
    return { match: `(email_domain = {${p}:String})`, params }
  }

  if (token.scope === 'login_contains') {
    const p = `lc${i}`
    params[p] = token.value
    return { match: `(positionCaseInsensitive(email, {${p}:String}) > 0)`, params }
  }

  if (token.type === 'email_full') return { match: exactAddressMatch(token, i, params), params }

  const words = loginWords(token.value)
  if (words.length === 1 && words[0] === asciiLower(token.value)) {
    const p = `lw${i}`
    params[p] = words[0]
    return { match: `(hasToken(${col('email')}, {${p}:String}))`, params }
  }

  const parts = words.slice(0, MAX_LOGIN_WORDS).map((w, j) => {
    const p = `lw${i}_${j}`
    params[p] = w
    return `hasToken(${col('email')}, {${p}:String})`
  })
  const pp = `lp${i}`
  params[pp] = token.value
  parts.push(`positionCaseInsensitive(email, {${pp}:String}) > 0`)
  return { match: `(${parts.join(' AND ')})`, params }
}

```

- [ ] **Step 4: Route the login scopes through it, and let the address branch use `exactAddressMatch`**

In `buildULPWhere`, replace

```ts
    let match: string

    if (token.type === 'email_full') {
      // Exact match on the lowercased email.
      // Hits bloom_filter(email) skip index — skips granules that can't contain
      // the value without scanning them.  No LIKE fallback: substring search
      // on emails would bypass the index and force a full table scan.
      const ep = `exactemail${i}`
      params[ep] = token.value.toLowerCase()
      match = `(email = {${ep}:String})`

    } else if (token.type === 'email_dom') {
```

with

```ts
    let match: string

    if (token.scope === 'login' || token.scope === 'login_contains') {
      // A login scope: only the login column is looked at (buildLoginMatch).
      const built = buildLoginMatch(token, i, col)
      Object.assign(params, built.params)
      match = built.match

    } else if (token.type === 'email_full') {
      // Exact match (exactAddressMatch). Hits the bloom_filter(email) skip index — skips granules that can't contain the value without
      // scanning them.  No LIKE fallback: substring search on emails would bypass the index and force a full table scan.
      match = exactAddressMatch(token, i, params)

    } else if (token.type === 'email_dom') {
```

- [ ] **Step 5: The regex builder and the neutrality rule**

In `buildULPWhereRegex`, replace

```ts
    const match = `(match(url, {${p}:String}) OR match(email, {${p}:String}) OR match(password, {${p}:String}))`
```

with

```ts
    // A login scope looks at the login column only.
    const match = token.scope === 'all'
      ? `(match(url, {${p}:String}) OR match(email, {${p}:String}) OR match(password, {${p}:String}))`
      : `(match(email, {${p}:String}))`
```

In `isIndexNeutralSearch`, replace the doc sentence ending `Domain, email and @domain terms compare whole columns, and no query at all has nothing to differ on.` with

```
 * Domain, email and @domain terms compare whole columns, and no query at all has nothing to differ on. A Login (contains) term is a plain function of
 * the login column, the same in either copy; a Login (whole word) word or phrase uses hasToken and is not neutral (an address or @host in a login
 * scope is).
```

and replace the line

```ts
  return tokens.every(t => t.type === 'domain' || t.type === 'email_full' || t.type === 'email_dom')
```

with

```ts
  return tokens.every(t => {
    if (t.type === 'email_full' || t.type === 'email_dom') return true
    if (t.scope === 'login_contains') return true
    if (t.scope === 'login') return false
    return t.type === 'domain'
  })
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run __tests__/ulp-search-login-build.test.ts __tests__/ulp-search-login-parse.test.ts __tests__/ulp-search.test.ts`
Expected: PASS. (The exact-address SQL is still `email = {exactemail0:String}`; the casing probe is Task 4.)

- [ ] **Step 7: Type-check and commit**

Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`.

```bash
git add lib/ulp-search.ts __tests__/ulp-search-login-build.test.ts
git commit -m "feat(search): Login (whole word) and Login (contains) in the query builder"
```

---

### Task 4: The e-mail casing probe

**Files:**
- Modify: `lib/ulp-search.ts` (`exactAddressMatch`, new `emailCasings`), `__tests__/ulp-search.test.ts` (four tests)
- Create: `__tests__/ulp-search-casings.test.ts`

**Interfaces:**
- Produces: `emailCasings(value: string): string[]` (exported; lowercased value first, at most six, no repeats). `exactAddressMatch` emits `(email IN ({exactemail<i>:String}, {exactemail<i>c1:String}, ...))`, or `(email = {exactemail<i>:String})` when the value has a single casing.

- [ ] **Step 1: Write the failing test**

Create `__tests__/ulp-search-casings.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { parseULPQuery, buildULPWhere, emailCasings } from '@/lib/ulp-search'

describe('emailCasings', () => {
  test('a dotted address gets all six casings, the lowercased value first', () => {
    expect(emailCasings('John.Smith@Gmail.com')).toEqual([
      'john.smith@gmail.com',
      'JOHN.SMITH@GMAIL.COM',
      'John.smith@gmail.com',
      'John.Smith@gmail.com',
      'JOHN.SMITH@gmail.com',
      'john.smith@Gmail.com',
    ])
  })

  test('repeats are removed (a single-word local part makes Title Case equal First letter)', () => {
    expect(emailCasings('maria@gmail.com')).toEqual([
      'maria@gmail.com', 'MARIA@GMAIL.COM', 'Maria@gmail.com', 'MARIA@gmail.com', 'maria@Gmail.com',
    ])
  })

  test('a value whose casings are all the same gives one', () => {
    expect(emailCasings('1@2.3')).toEqual(['1@2.3'])
  })

  test('a value without an @, or with nothing before it, is just lowercased', () => {
    expect(emailCasings('Maria')).toEqual(['maria'])
    expect(emailCasings('@Example.com')).toEqual(['@example.com'])
  })

  test('never more than six values, always the lowercased one first', () => {
    for (const a of ['a.b.c@d.e.f', 'X@Y.Z', 'name+tag@sub.example.com']) {
      const c = emailCasings(a)
      expect(c.length).toBeLessThanOrEqual(6)
      expect(c[0]).toBe(a.toLowerCase())
      expect(new Set(c).size).toBe(c.length)
    }
  })
})

describe('buildULPWhere — an address probes the common casings', () => {
  test('the clause is email IN (...) with one parameter per casing', () => {
    const { clause, params } = buildULPWhere(parseULPQuery('John.Smith@example.com'))
    expect(clause).toBe('(email IN ({exactemail0:String}, {exactemail0c1:String}, {exactemail0c2:String}, {exactemail0c3:String}, {exactemail0c4:String}, {exactemail0c5:String}))')
    expect(Object.keys(params)).toHaveLength(6)
    expect(params.exactemail0).toBe('john.smith@example.com')
    expect(Object.values(params)).toContain('JOHN.SMITH@EXAMPLE.COM')
    expect(Object.values(params)).toContain('John.Smith@example.com')
  })

  test('a single casing keeps the plain equality', () => {
    const { clause, params } = buildULPWhere(parseULPQuery('1@2.3'))
    expect(clause).toBe('(email = {exactemail0:String})')
    expect(params).toEqual({ exactemail0: '1@2.3' })
  })

  test('it applies in the Login (whole word) scope and under negation, and never uses LIKE or hasToken', () => {
    const login = buildULPWhere(parseULPQuery('john@example.com', 'login')).clause
    expect(login).toContain('email IN (')
    const negated = buildULPWhere(parseULPQuery('-john@example.com')).clause
    expect(negated.startsWith('NOT (email IN (')).toBe(true)
    for (const c of [login, negated]) {
      expect(c).not.toContain('LIKE')
      expect(c).not.toContain('hasToken')
    }
  })

  test('parameter names of different terms do not collide', () => {
    const { params } = buildULPWhere(parseULPQuery('a@example.com, b@example.com'))
    const keys = Object.keys(params)
    expect(new Set(keys).size).toBe(keys.length)
    expect(params.exactemail0).toBe('a@example.com')
    expect(params.exactemail1).toBe('b@example.com')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/ulp-search-casings.test.ts`
Expected: FAIL (`emailCasings` is not exported).

- [ ] **Step 3: Implement**

In `lib/ulp-search.ts`, replace the whole `exactAddressMatch` function (and its one-line doc comment) with:

```ts
/** Upper-cases the first letter of every run of ASCII letters and digits and lower-cases the rest ("john.smith" -> "John.Smith"). */
function titleCase(s: string): string {
  return s.replace(/[A-Za-z0-9]+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

/**
 * The casings an address is commonly stored in. Logins are kept as typed, so about 5% of the e-mail logins have an uppercase letter and
 * `email = lower(value)` cannot see them. The bloom filter on `email` probes all of these at the cost of one: the value lowercased (first);
 * ALL UPPER; First letter only; Title Case local part; UPPER local part; Capitalised domain. Together they cover about two thirds of the
 * mixed-case addresses; "Login (contains)" is the complete route. At most six values, without repeats.
 */
export function emailCasings(value: string): string[] {
  const lower = value.toLowerCase()
  const at = lower.indexOf('@')
  if (at < 1) return [lower]
  const local = lower.slice(0, at)
  const domain = lower.slice(at + 1)
  const first = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  return Array.from(new Set([
    lower,
    lower.toUpperCase(),
    first(lower),
    `${titleCase(local)}@${domain}`,
    `${local.toUpperCase()}@${domain}`,
    `${local}@${first(domain)}`,
  ]))
}

/** A full address as an exact match on the login (bloom filter on `email`) that also tries the common casings. Its parameters are added to `params`. */
function exactAddressMatch(token: ParsedToken, i: number, params: Record<string, unknown>): string {
  const names = emailCasings(token.value).map((casing, j) => {
    const name = j === 0 ? `exactemail${i}` : `exactemail${i}c${j}`
    params[name] = casing
    return `{${name}:String}`
  })
  return names.length === 1 ? `(email = ${names[0]})` : `(email IN (${names.join(', ')}))`
}
```

- [ ] **Step 4: Update the four existing tests that asserted the old SQL**

In `__tests__/ulp-search.test.ts`:

(a) Replace

```ts
  test('email_full type → exact email = {param:String} (bloom_filter accelerated)', () => {
    const tokens = parseULPQuery('john@gmail.com')
    const { clause, params } = buildULPWhere(tokens)
    expect(clause).toContain('email =')
```

with

```ts
  test('email_full type → exact email IN (...) over the common casings (bloom_filter accelerated)', () => {
    const tokens = parseULPQuery('john@gmail.com')
    const { clause, params } = buildULPWhere(tokens)
    expect(clause).toContain('email IN (')
```

(b) Replace

```ts
  test('email_full lowercases the value in params', () => {
    const tokens = parseULPQuery('JOHN@GMAIL.COM')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('john@gmail.com')
    expect(paramValues).not.toContain('JOHN@GMAIL.COM')
  })
```

with

```ts
  test('email_full puts the lowercased value first and probes the common casings after it', () => {
    const tokens = parseULPQuery('JOHN@GMAIL.COM')
    const { params } = buildULPWhere(tokens)
    expect(params.exactemail0).toBe('john@gmail.com')
    // ALL UPPER is one of the deliberate casings; an arbitrary mixed case is not
    expect(Object.values(params)).toContain('JOHN@GMAIL.COM')
    expect(Object.values(params)).not.toContain('jOhN@GmAiL.CoM')
  })
```

(c) In `full email search generates correct params count`, replace `expect(Object.keys(params)).toHaveLength(1)` with `expect(Object.keys(params)).toHaveLength(5)` and add the comment line `// alice@example.com has five distinct casings: lower, UPPER, First, UPPER local, Capitalised domain`.

(d) In `three-term AND query generates four params (token type uses two)`: rename it to `three-term AND query generates eight params (token type uses two, an address five)`, change the comment line `// alice@…   → email_full → 1 param` to `// alice@…   → email_full → 5 params (its distinct casings)`, the line `// Total: 4 params` to `// Total: 8 params`, and `toHaveLength(4)` to `toHaveLength(8)`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run __tests__/ulp-search-casings.test.ts __tests__/ulp-search.test.ts __tests__/ulp-search-login-build.test.ts __tests__/ulp-search-login-parse.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`.

```bash
git add lib/ulp-search.ts __tests__/ulp-search.test.ts __tests__/ulp-search-casings.test.ts
git commit -m "feat(search): an exact address also finds the common capitalisations"
```

---

### Task 5: The credentials route and the dictionary shortcut

**Files:**
- Modify: `lib/search-dictionary-plan.ts` (`dictionaryTermFromQuery`), `app/api/credentials/route.ts`
- Create: `__tests__/credentials-route-login-scope.test.ts`

**Interfaces:**
- Consumes: `parseSearchScope`, `SearchScope` (Task 1); `parseULPQuery(raw, scope)` (Task 2).
- Produces: `dictionaryTermFromQuery(q: string, regex: boolean, scope?: SearchScope)`; `GET /api/credentials?scope=...`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/credentials-route-login-scope.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
const fresh = {
  state: 'fresh', fingerprint: 'fp-1', builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
}
let windowsReadiness: Array<Record<string, unknown>> = [{ defined: 0, parts: 1, with_projection: 0 }] // newest-first windows NOT ready: the plain path answers

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/FROM ulp\.search_host_dict/.test(sql)) return [{ domain: 'ledger.com' }]
    if (/FROM ulp\.search_emaildomain_dict/.test(sql)) return [{ email_domain: 'ledger.com' }]
    if (/system\.projections/.test(sql)) return windowsReadiness
    if (/AS raw_total/.test(sql)) return [{ total: '11', raw_total: '12' }]
    return []
  }),
}))
vi.mock('@/lib/search-dictionary', async () => {
  const actual = await vi.importActual<typeof import('@/lib/search-dictionary')>('@/lib/search-dictionary')
  return { ...actual, getSearchDictionaryStatus: vi.fn(async () => fresh) }
})
vi.mock('@/lib/credentials-projections', async () => {
  const actual = await vi.importActual<typeof import('@/lib/credentials-projections')>('@/lib/credentials-projections')
  return { ...actual, isEmailDomainRevProjectionReady: vi.fn(async () => true) }
})

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { resetDictionaryPlanCache } from '@/lib/search-dictionary-plan'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
const allSql = () => calls.map(c => c.sql).join('\n')
const allParams = () => Object.assign({}, ...calls.map(c => c.params))
const isLookup = (c: Call) => /FROM ulp\.search_(host|emaildomain)_dict/.test(c.sql)

beforeEach(() => {
  calls.length = 0
  windowsReadiness = [{ defined: 0, parts: 1, with_projection: 0 }]
  resetDictionaryPlanCache()
  resetNewestFirstReadyCache()
})

describe('GET /api/credentials — scope', () => {
  test('Login (whole word) looks at the login only, for the rows and for the totals', async () => {
    await get('q=Maria&scope=login&skip_totals=1&dedupe=0')
    await get('q=Maria&scope=login&totals_only=1&dedupe=0')
    const sql = allSql()
    expect(sql).toContain('hasToken(email, {lw0:String})')
    expect(sql).not.toContain('hasToken(url')
    expect(sql).not.toContain('hasToken(password')
    expect(allParams().lw0).toBe('maria')
  })

  test('Login (contains) is a case-insensitive substring check on the login', async () => {
    await get('q=Maria&scope=login_contains&skip_totals=1&dedupe=0')
    expect(allSql()).toContain('positionCaseInsensitive(email, {lc0:String}) > 0')
    expect(allParams().lc0).toBe('Maria')
  })

  test('the login: prefix works without any scope parameter', async () => {
    await get('q=login:Maria&skip_totals=1&dedupe=0')
    expect(allSql()).toContain('hasToken(email, {lw0:String})')
    expect(allSql()).not.toContain('hasToken(url')
  })

  test('without a scope (or with scope=all) the search is the one it always was', async () => {
    await get('q=maria&skip_totals=1&dedupe=0')
    await get('q=maria&scope=all&skip_totals=1&dedupe=0')
    expect(allSql()).toContain('hasToken(url, {tok0:String})')
    expect(allSql()).not.toContain('positionCaseInsensitive')
  })

  test('regex mode in a login scope matches the login column only', async () => {
    await get(`q=${encodeURIComponent('^adm')}&regex=1&scope=login&skip_totals=1&dedupe=0`)
    expect(allSql()).toContain('match(email, {rp0:String})')
    // the SELECT list's own display normalisation contains a literal match(url, ...), so test for the bound search predicate
    expect(allSql()).not.toContain('match(url, {rp0:String})')
  })

  test('a full address probes the common casings', async () => {
    await get('q=john.smith@example.com&skip_totals=1&dedupe=0')
    expect(allSql()).toContain('email IN (')
    expect(Object.values(allParams())).toContain('JOHN.SMITH@EXAMPLE.COM')
  })

  test('an unknown scope is a 400 and runs nothing', async () => {
    const res = await get('q=maria&scope=password')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'scope must be all, login or login_contains' })
    expect(calls).toHaveLength(0)
  })
})

describe('GET /api/credentials — the domain dictionary shortcut stays out of the login scopes', () => {
  test('a domain search with the default scope uses the dictionary (control)', async () => {
    await get('q=ledger.com&skip_totals=1&exclude_noise=1&dedupe=1')
    expect(calls.filter(isLookup).length).toBeGreaterThan(0)
  })

  test.each([
    'q=ledger.com&scope=login&skip_totals=1&exclude_noise=1&dedupe=1',
    'q=ledger.com&scope=login_contains&skip_totals=1&exclude_noise=1&dedupe=1',
    'q=login:ledger.com&skip_totals=1&exclude_noise=1&dedupe=1',
  ])('%s does not', async qs => {
    await get(qs)
    expect(calls.filter(isLookup)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/credentials-route-login-scope.test.ts`
Expected: FAIL (the route ignores `scope`).

- [ ] **Step 3: The dictionary planner**

In `lib/search-dictionary-plan.ts`:

(a) Add to the imports: `import type { SearchScope } from '@/lib/search-scope'`.

(b) Replace

```ts
export function dictionaryTermFromQuery(q: string, regex: boolean): DictionaryTerm | null {
  if (regex) return null
  const tokens = parseULPQuery(q)
  if (tokens.length !== 1) return null
  const [token] = tokens
  if (token.type !== 'domain' || token.negate) return null
```

with

```ts
export function dictionaryTermFromQuery(q: string, regex: boolean, scope: SearchScope = 'all'): DictionaryTerm | null {
  if (regex) return null
  const tokens = parseULPQuery(q, scope)
  if (tokens.length !== 1) return null
  const [token] = tokens
  // A login scope (the dropdown or a login: prefix) is not a site search: the dictionary is about hosts.
  if (token.type !== 'domain' || token.negate || token.scope !== 'all') return null
```

and extend the doc comment sentence `(single word, @email, several terms, negation, regex)` to `(single word, @email, several terms, negation, regex, a login scope)`.

- [ ] **Step 4: The route**

In `app/api/credentials/route.ts`:

(a) Add the import after the `@/lib/ulp-search` import:

```ts
import { parseSearchScope } from "@/lib/search-scope"
```

(b) In the parameter list of the doc comment, after the line ` *   regex         '1'       treat q as RE2 regex` add

```
 *   scope         string    all (default) | login (a whole word in the login) | login_contains (anywhere in the login); else 400
```

(c) After the `parsedRange` check (the block ending `const importedRange = parsedRange.range`), add

```ts
  const scope = parseSearchScope(sp.get('scope'))
  if (scope === null) return NextResponse.json({ success: false, error: 'scope must be all, login or login_contains' }, { status: 400 })
```

(d) Replace `const searchTokens = q.trim() ? parseULPQuery(q.trim()) : []` with `const searchTokens = q.trim() ? parseULPQuery(q.trim(), scope) : []`.

(e) Replace `dictionaryTermFromQuery(q.trim(), regex)` with `dictionaryTermFromQuery(q.trim(), regex, scope)`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run __tests__/credentials-route-login-scope.test.ts __tests__/credentials-route-dictionary.test.ts __tests__/search-dictionary-plan.test.ts __tests__/credentials-route.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`.

```bash
git add lib/search-dictionary-plan.ts app/api/credentials/route.ts __tests__/credentials-route-login-scope.test.ts
git commit -m "feat(search): /api/credentials takes a scope; the dictionary shortcut ignores the login scopes"
```

---

### Task 6: The CSV export

**Files:**
- Modify: `app/api/export/route.ts`
- Create: `__tests__/export-route-scope.test.ts`

**Interfaces:**
- Consumes: `parseSearchScope`, `SearchScope`, `parseULPQuery(raw, scope)`.
- Produces: `POST /api/export` accepts `scope` in the JSON body; `streamSprayList(query, domain, breach_name, incTiers, excTiers, loginTypes, range, scope)`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/export-route-scope.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const source = readFileSync(new URL('../app/api/export/route.ts', import.meta.url), 'utf8')
const postStart = source.indexOf('export async function POST')
const postFn = source.slice(postStart, source.indexOf('// ─────', postStart))
const sprayFn = source.slice(source.indexOf('function streamSprayList'), source.indexOf('function streamSprayList') + 1200)

describe('export route — the search scope', () => {
  test('imports the scope helpers', () => {
    expect(source).toContain('import { parseSearchScope, type SearchScope } from "@/lib/search-scope"')
  })

  test('reads scope from the body and refuses an unknown one with a 400 before any query runs', () => {
    expect(postFn).toMatch(/scope:\s*scopeRaw\s*=\s*'all'/)
    expect(postFn).toContain('const scope = parseSearchScope(scopeRaw)')
    expect(postFn).toContain("error: 'scope must be all, login or login_contains' }, { status: 400 }")
    expect(postFn.indexOf('parseSearchScope(scopeRaw)')).toBeLessThan(postFn.indexOf("format === 'wordlist'"))
  })

  test('the main query and the spray list both parse the search with the scope', () => {
    expect(postFn).toContain('parseULPQuery(query, scope)')
    expect(sprayFn).toContain('parseULPQuery(query, scope)')
    expect(postFn).toMatch(/streamSprayList\(query, domain, breach_name, incTiers, excTiers, loginTypes, importedRange, scope\)/)
    expect(sprayFn).toMatch(/range: ImportedRange,\s*scope: SearchScope,/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/export-route-scope.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `app/api/export/route.ts`:

(a) Add after the `@/lib/ulp-search` import line: `import { parseSearchScope, type SearchScope } from "@/lib/search-scope"`.

(b) In the destructuring of the request body, after the line `    regex_mode   = false,` add `    scope: scopeRaw = 'all',`.

(c) Immediately after the `importedRange` line (`const importedRange = parsedRange.range`) and before `if (format === 'wordlist')`, add

```ts
  const scope = parseSearchScope(scopeRaw)
  if (scope === null) return NextResponse.json({ success: false, error: 'scope must be all, login or login_contains' }, { status: 400 })
```

(d) Replace `if (format === 'spray')    return streamSprayList(query, domain, breach_name, incTiers, excTiers, loginTypes, importedRange)` with

```ts
  if (format === 'spray')    return streamSprayList(query, domain, breach_name, incTiers, excTiers, loginTypes, importedRange, scope)
```

(e) Replace the first `const tokens = parseULPQuery(query)` (in POST) with `const tokens = parseULPQuery(query, scope)`.

(f) In `streamSprayList`, change the last parameter line `  range: ImportedRange,` to

```ts
  range: ImportedRange,
  scope: SearchScope,
```

and its `const tokens         = parseULPQuery(query)` to `const tokens         = parseULPQuery(query, scope)`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run __tests__/export-route-scope.test.ts __tests__/export-route.test.ts __tests__/export-route-imported-range.test.ts __tests__/export-route-csv-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`.

```bash
git add app/api/export/route.ts __tests__/export-route-scope.test.ts
git commit -m "feat(search): the CSV export honours the search scope"
```

---

### Task 7: The credentials page

**Files:**
- Modify: `app/credentials/page.tsx`
- Create: `__tests__/credentials-page-scope.test.ts`

**Interfaces:**
- Consumes: `SearchScope`, `SEARCH_SCOPE_OPTIONS`, `SEARCH_SCOPE_PLACEHOLDERS`, `SEARCH_SCOPE_TITLE` (Task 1); the routes' `scope` parameter.

- [ ] **Step 1: Write the failing test**

Create `__tests__/credentials-page-scope.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const src = readFileSync(new URL('../app/credentials/page.tsx', import.meta.url), 'utf8')
const buildParams = src.slice(src.indexOf('const buildParams'), src.indexOf('const loadAbortRef'))
const clearAll = src.slice(src.indexOf('const clearAll'), src.indexOf('const copy = '))
const doExport = src.slice(src.indexOf('const doExport'), src.indexOf('const hasBasicFilters'))
const filterRow = src.slice(src.indexOf('Filter row 1: text search'), src.indexOf('Filter row 2: chip filters'))

describe('Credentials page — the "Search in" scope', () => {
  test('the slices under test were found', () => {
    expect(buildParams.length).toBeGreaterThan(200)
    expect(clearAll.length).toBeGreaterThan(100)
    expect(doExport.length).toBeGreaterThan(500)
    expect(filterRow.length).toBeGreaterThan(200)
  })

  test('the scope is state that starts at All fields', () => {
    expect(src).toMatch(/const \[scope, setScope\]\s+= useState<SearchScope>\('all'\)/)
    expect(src).toContain("import { SEARCH_SCOPE_OPTIONS, SEARCH_SCOPE_PLACEHOLDERS, SEARCH_SCOPE_TITLE, type SearchScope } from '@/lib/search-scope'")
  })

  test('the request carries scope only when it is not All fields, and the callback depends on it', () => {
    expect(buildParams).toMatch(/if \(scope !== 'all'\)\s+ps\.set\('scope', scope\)/)
    expect(buildParams).toMatch(/\n\s+q, scope, domain, breach,/)
  })

  test('the CSV export sends it', () => {
    expect(doExport).toMatch(/\n\s+scope,\n/)
    expect(doExport).toContain('[q, scope, domain, breach, tierInclude,')
  })

  test('Clear puts it back to All fields', () => {
    expect(clearAll).toContain("setScope('all')")
  })

  test('the select sits beside the search box, lists the three options and sets only state (Apply or Enter runs the search)', () => {
    expect(filterRow).toContain('value={scope}')
    expect(filterRow).toContain('aria-label="Search in"')
    expect(filterRow).toContain('SEARCH_SCOPE_OPTIONS.map')
    expect(filterRow).toContain('title={SEARCH_SCOPE_TITLE}')
    expect(filterRow).toContain('onChange={e => setScope(e.target.value as SearchScope)}')
    expect(filterRow).toContain('SEARCH_SCOPE_PLACEHOLDERS[scope]')
    expect(filterRow.slice(filterRow.indexOf('value={scope}'), filterRow.indexOf('SEARCH_SCOPE_OPTIONS.map'))).not.toContain('load(')
  })

  test('a changed scope counts as an active filter, and the since-last-export memory is per scope without changing the old keys', () => {
    expect(src).toMatch(/const hasBasicFilters = !!\(q \|\| scope !== 'all' \|\|/)
    expect(src).toContain("scope: scope === 'all' ? '' : scope")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/credentials-page-scope.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `app/credentials/page.tsx`:

(a) After the `} from "@/lib/imported-range-client"` line of the import block, add

```ts
import { SEARCH_SCOPE_OPTIONS, SEARCH_SCOPE_PLACEHOLDERS, SEARCH_SCOPE_TITLE, type SearchScope } from '@/lib/search-scope'
```

(b) After `const [q, setQ]                     = useState('')` add

```ts
  const [scope, setScope]               = useState<SearchScope>('all')
```

(c) In `buildParams`, after `if (effectiveQ.trim())     ps.set('q', effectiveQ.trim())` add

```ts
    if (scope !== 'all')       ps.set('scope', scope)
```

and in its dependency array, change `q, domain, breach, loginType, pwMask, isCorporate, urlScheme, tierInclude, tierExclude, excludeNoise, dedupe,` to start `q, scope, domain, breach, ...` (insert `scope,` after `q,`) — keep the rest of the line as it is.

(d) In `clearAll`, change `setQ(''); setDomain('');` to `setQ(''); setScope('all'); setDomain('');`.

(e) In the `searchFingerprint({ ... })` call, change the first line `    q, domain, breach, loginType, pwMask,` to `    q, scope: scope === 'all' ? '' : scope, domain, breach, loginType, pwMask,`.

(f) In `doExport`'s JSON body, after the line `          query:         q,` add

```ts
          scope,
```

and in its dependency array change `[q, domain, breach, tierInclude,` to `[q, scope, domain, breach, tierInclude,`.

(g) In `hasBasicFilters`, change `!!(q || domain || breach ||` to `!!(q || scope !== 'all' || domain || breach ||`.

(h) Replace the search `<Input ... />` of filter row 1

```tsx
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilters()}
            placeholder={regexMode ? 'RE2 regex pattern…' : 'Search URL / email / password…'}
            className="flex-1 font-mono text-sm h-8"
          />
```

with

```tsx
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilters()}
            placeholder={regexMode ? 'RE2 regex pattern…' : SEARCH_SCOPE_PLACEHOLDERS[scope]}
            className="flex-1 font-mono text-sm h-8"
          />
          <select
            value={scope}
            onChange={e => setScope(e.target.value as SearchScope)}
            className={selectCls}
            aria-label="Search in"
            title={SEARCH_SCOPE_TITLE}
          >
            {SEARCH_SCOPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run __tests__/credentials-page-scope.test.ts __tests__/imported-range-credentials-page.test.ts __tests__/credentials-page-totals.test.ts __tests__/imported-range-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, lint the changed files and commit**

Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`.
Run: `npx eslint --no-eslintrc -c .eslintrc.json app/credentials/page.tsx lib/search-scope.ts lib/ulp-search.ts lib/search-dictionary-plan.ts app/api/credentials/route.ts app/api/export/route.ts; echo "eslint exit $?"` → `eslint exit 0`.

```bash
git add app/credentials/page.tsx __tests__/credentials-page-scope.test.ts
git commit -m "feat(search): the credentials page gets a \"Search in\" select"
```

---

### Task 8: Live parity, documentation, the gate and the deploy

**Files:**
- Create: `__tests__/login-scope-parity.live.test.ts`
- Modify: `README.md`, `docs/superpowers/specs/2026-10-13-login-search-scope-design.md` (status line)

- [ ] **Step 1: The live parity test**

Create `__tests__/login-scope-parity.live.test.ts`:

```ts
import { execSync } from 'node:child_process'
import { describe, expect, test, vi } from 'vitest'

/**
 * LIVE parity check for the login search scope (lib/ulp-search.ts): the route's counts must equal references written differently from the code under
 * test. Skipped unless LSP_PARITY=1; it talks to the real ClickHouse (the running ulpsuite_clickhouse container) and prints timings. READ-ONLY.
 * It drives the real GET /api/credentials handler (totals_only, dedupe=0, so raw_total is the plain count of the search).
 *
 *   whole word    has(splitByNonAlpha(lower(email)), w)           the tokenizer as a plain function, no index; within 0.01% (a handful of logins
 *                                                                 with a "~" next to the word are cut differently by the index)
 *   dotted name   every word whole, then position(lower(email), phrase) > 0
 *   contains      position(lower(email), lower(w)) > 0
 *   casing probe  at least what `email = lower(address)` finds, at most what `lower(email) = address` finds (the complete answer)
 *
 *   LSP_PARITY=1 npx vitest run __tests__/login-scope-parity.live.test.ts
 *   LSP_PARITY=1 LSP_TERMS=term1,term2 LSP_DOTTED=a.b LSP_ADDRESSES=5 npx vitest run __tests__/login-scope-parity.live.test.ts
 *
 * Real search terms belong in YOUR environment (LSP_TERMS), never in this file: the repository is public. The addresses are picked from the table
 * itself and never printed.
 */
const LIVE = process.env.LSP_PARITY === '1'
const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(',').map(s => s.trim()).filter(Boolean)
const WORDS = list(process.env.LSP_TERMS, 'maria,smith,zzqxnonexistent')
const DOTTED = list(process.env.LSP_DOTTED, 'john.smith')
const ADDRESSES = Number(process.env.LSP_ADDRESSES ?? 3)

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

const SETTINGS = 'SETTINGS use_query_cache = 0, use_query_condition_cache = 0, max_execution_time = 900'

async function routed(qs: string): Promise<{ rawTotal: number; ms: number }> {
  const { GET } = await import('@/app/api/credentials/route')
  const { NextRequest } = await import('next/server')
  const { getClient } = await import('@/lib/clickhouse')
  await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
  await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
  const t0 = Date.now()
  const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}&totals_only=1&dedupe=0`))
  const ms = Date.now() - t0
  const body = await res.json()
  expect(body.success, JSON.stringify(body).slice(0, 300)).toBe(true)
  return { rawTotal: Number(body.raw_total), ms }
}

async function reference(where: string, params: Record<string, unknown> = {}): Promise<number> {
  const { getClient } = await import('@/lib/clickhouse')
  const rs = await getClient().query({ query: `SELECT count() AS n FROM ulp.credentials WHERE ${where} ${SETTINGS}`, query_params: params, format: 'JSONEachRow' })
  const rows = (await rs.json()) as Array<{ n: string }>
  return Number(rows[0].n)
}

const words = (v: string) => v.replace(/[A-Z]+/g, m => m.toLowerCase()).match(/[a-z0-9\u0080-￿]+/g) ?? []

describe.skipIf(!LIVE)('login search scope parity on the live table', () => {
  test.each(WORDS)('whole word %s equals the plain tokenizer, with the prefix and with the scope', async w => {
    const viaScope = await routed(`q=${encodeURIComponent(w)}&scope=login`)
    const viaPrefix = await routed(`q=${encodeURIComponent('login:' + w)}`)
    const ref = await reference('has(splitByNonAlpha(lower(email)), {w:String})', { w: w.toLowerCase() })
    console.log(`whole word | ${w.length} chars | route ${viaScope.rawTotal} in ${viaScope.ms} ms | reference ${ref}`)
    expect(viaPrefix.rawTotal).toBe(viaScope.rawTotal)
    expect(Math.abs(viaScope.rawTotal - ref)).toBeLessThanOrEqual(Math.ceil(ref * 0.0001))
  }, 30 * 60_000)

  test.each(DOTTED)('dotted name %s equals the whole-words-then-phrase reference', async v => {
    const r = await routed(`q=${encodeURIComponent(v)}&scope=login`)
    const ref = await reference('arrayAll(x -> has(splitByNonAlpha(lower(email)), x), {ws:Array(String)}) AND position(lower(email), lower({v:String})) > 0', { ws: words(v), v })
    console.log(`dotted | route ${r.rawTotal} in ${r.ms} ms | reference ${ref}`)
    expect(r.rawTotal).toBe(ref)
  }, 30 * 60_000)

  test.each(WORDS)('contains %s equals position(lower(email))', async w => {
    const r = await routed(`q=${encodeURIComponent(w)}&scope=login_contains`)
    const ref = await reference('position(lower(email), lower({w:String})) > 0', { w })
    console.log(`contains | ${w.length} chars | route ${r.rawTotal} in ${r.ms} ms | reference ${ref}`)
    expect(r.rawTotal).toBe(ref)
  }, 30 * 60_000)

  test('Login (contains), Newest first: every row of the page really contains the term', async () => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const w = WORDS[0]
    const t0 = Date.now()
    const res = await GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent(w)}&scope=login_contains&sort=imported_desc&limit=50&skip_totals=1&dedupe=0`))
    const body = await res.json()
    console.log(`contains page | plan ${body.plan} | ${body.results?.length} rows in ${Date.now() - t0} ms`)
    expect(body.success).toBe(true)
    for (const row of body.results) expect(String(row.email).toLowerCase()).toContain(w.toLowerCase())
  }, 30 * 60_000)

  test('the address casing probe finds at least the lowercase lookup and at most the complete answer', async () => {
    const { getClient } = await import('@/lib/clickhouse')
    const rs = await getClient().query({
      query: `SELECT DISTINCT lower(email) AS a FROM ulp.credentials WHERE _partition_id = '202610' AND position(email, '@') > 0 AND email != lower(email) AND cityHash64(email) % 20000 = 7 LIMIT {n:UInt32}`,
      query_params: { n: ADDRESSES }, format: 'JSONEachRow',
    })
    const addresses = ((await rs.json()) as Array<{ a: string }>).map(r => r.a)
    expect(addresses.length).toBeGreaterThan(0)
    for (const a of addresses) {
      const before = await reference('email = {a:String}', { a })
      const probe = await routed(`q=${encodeURIComponent(a)}`)
      const complete = await reference('lower(email) = {a:String}', { a })
      console.log(`address | lowercase lookup ${before} | probe ${probe.rawTotal} in ${probe.ms} ms | complete ${complete}`)
      expect(probe.rawTotal).toBeGreaterThanOrEqual(before)
      expect(probe.rawTotal).toBeLessThanOrEqual(complete)
    }
  }, 30 * 60_000)
})
```

Run it (read-only, a few minutes): `LSP_PARITY=1 npx vitest run __tests__/login-scope-parity.live.test.ts`
Expected: PASS, and the printed lines show the route counts equal to the references and the timings (whole word about 0.2 s, contains about 25 s).

- [ ] **Step 2: Documentation**

(a) In `README.md`, replace the bullet

```
- **Credential search** — query by email, domain, URL, password, or breach name; combine terms with AND (`+`), OR (`,`), NOT (`-`)
```

with

```
- **Credential search** — query by email, domain, URL, password, or breach name; separate terms with commas (every term must match) and put `-` in front of a term to exclude it
- **Search in** — a dropdown beside the search box: *All fields* (the default), *Login (whole word)* (about 0.2 s on 1.8 billion rows) or *Login (contains)* (anywhere in the login, a scan of the login column, about 25 s). `login:name` in the box always means a whole word in the login, whatever the dropdown says (`-login:name` excludes). A full address (`name@host`) is an exact match that also tries the common capitalisations (`Name@host`, `NAME@HOST`); *Login (contains)* ignores case completely. Case is folded for ASCII letters only. A search for the literal text `login:…` now means the scope.
```

(b) In `docs/superpowers/specs/2026-10-13-login-search-scope-design.md`, replace the line beginning `Status: **written for the owner's review; nothing is built.**` up to the end of that paragraph with

```
Status: **implemented and deployed locally on 2026-10-13** (plan `docs/superpowers/plans/2026-10-13-login-search-scope.md`; the merge commit and image id are in the memory ledger). The owner chose the behaviour in chat on 2026-10-13 (two login choices; "anywhere in the login" for the slower one) and approved the design, including the e-mail casing probe. The repository is public: this file holds numbers only, never real addresses, file names or search terms.
```

- [ ] **Step 3: The whole gate**

Run, each to a file so a failure cannot hide behind a pipe:

```bash
npx tsc --noEmit > /tmp/claude-1000/gate-tsc.txt 2>&1; echo "tsc exit $?"
npx eslint --no-eslintrc -c .eslintrc.json app lib components __tests__ > /tmp/claude-1000/gate-eslint.txt 2>&1; echo "eslint exit $?"
npx vitest run > /tmp/claude-1000/gate-vitest.txt 2>&1; echo "vitest exit $?"; tail -6 /tmp/claude-1000/gate-vitest.txt
```

Expected: `tsc exit 0`, `eslint exit 0`, `vitest exit 0` with 0 failed (a handful of CLI tests have flaked under heavy load before; rerun a failing file alone before concluding).

Then the production build: `npm run build > /tmp/claude-1000/gate-build.txt 2>&1; echo "build exit $?"` → `build exit 0`.

- [ ] **Step 4: Commit and merge**

```bash
git add __tests__/login-scope-parity.live.test.ts README.md docs/superpowers/specs/2026-10-13-login-search-scope-design.md
git commit -m "docs(search): README, the live parity test and the spec status for the login scope"
git fetch -q origin && git rebase origin/main
git push origin login-search-scope:main
```

Expected: the push is a fast-forward of `main`. CI runs `npm ci`, typecheck, test, lint, build; look at it once with `gh run list --branch main -L 1` (do not poll).

- [ ] **Step 5: Deploy locally (the runbook's procedure)**

```bash
cd /home/cole/ulp-suite && git fetch -q origin && git merge --ff-only origin/main && SHA=$(git rev-parse --short HEAD)
# 1. nothing in flight
ls -A inbox/processing inbox | head
# 2. tag the running image as the rollback FIRST
docker tag "$(docker inspect ulpsuite_app --format '{{.Image}}')" "ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%M)z"
# 3. build from the merged commit, never from a worktree
mkdir -p /tmp/claude-1000/build-$SHA /tmp/claude-1000/dockercfg && echo '{}' > /tmp/claude-1000/dockercfg/config.json
git archive $SHA | tar -x -C /tmp/claude-1000/build-$SHA
DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker build -t ulp-suite-app:latest /tmp/claude-1000/build-$SHA
# 4. recreate only the app, anchored to the stack's directory and .env
DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose -p ulp-suite -f docker-compose.yml --project-directory /home/cole/ulp-suite --env-file /home/cole/ulp-suite/.env up -d --no-deps app
```

Expected: the app container is recreated, `docker ps` shows `ulpsuite_app ... (healthy)` within about a minute, `docker logs ulpsuite_app --since 3m | grep -iE "error|fatal"` prints nothing.

- [ ] **Step 6: Verify the deploy**

```bash
docker inspect ulpsuite_app --format '{{.Config.Image}} {{.State.Health.Status}} restarts={{.RestartCount}}'
docker exec ulpsuite_app sh -c 'grep -rl "Login (whole word)" /app/.next | head -3'
docker exec ulpsuite_app printenv | grep -E '^(CONTENT_DEDUP_APPLY|INGEST_FILTER_HARD_DROP_TIERS|ULP_ARCHIVE_DIR)='
```

Expected: image `ulp-suite-app`, `healthy`, `restarts=0`; at least one built file contains the label; the three environment lines are unchanged (`false`, `T3`, `/archive`). Report the merge sha, the image id and the rollback tag, and ask the owner to try the dropdown (a sign-in is needed; never type the password). Update the memory note `project_login_search_scope_2026_10_13.md` with the sha, the image id and the parity timings.

- [ ] **Step 7: Clean up**

```bash
cd /home/cole/ulp-suite && git worktree remove .claude/worktrees/login-search-scope && git branch -d login-search-scope
```

---

## Self-review against the spec

- Dropdown with three choices, the labels, placeholders, title, Clear, export sends it: Tasks 1 and 7.
- `login:` prefix, `-login:`, empty prefix dropped, mixing in one query: Task 2.
- Matching rules table (word, dotted or special, address, `@host`; both login scopes): Task 3. Regex mode: Task 3. Index neutrality and the projection form: Task 3.
- The casing probe (six values, lowercased first, `IN` list, single casing keeps `=`): Task 4.
- `scope` parameter with 400 on an unknown value, on the credentials route (rows and totals through `totalsParams`, unchanged) and on the export (CSV and spray list): Tasks 5 and 6. The domain dictionary stays out of login scopes: Task 5. `/api/search` and API v1 gain only the prefix, with no code change.
- README, including the corrected operator sentence: Task 8. Live parity (whole word, dotted, contains, Newest first page, casing): Task 8. Gate, rollback tag, deploy: Task 8.
- Not included, as in the spec: password and URL scopes, wildcards, starts-with, a remembered choice, a v1 `scope` parameter, n-gram index, lowercase-login column.
- Names used across tasks: `SearchScope`, `parseSearchScope`, `SEARCH_SCOPE_OPTIONS`, `SEARCH_SCOPE_PLACEHOLDERS`, `SEARCH_SCOPE_TITLE` (Task 1); `ParsedToken.scope`, `parseULPQuery(raw, defaultScope)` (Task 2); `loginWords`, `exactAddressMatch`, `buildLoginMatch` (Task 3); `emailCasings` (Task 4). Parameter names: `lw<i>`, `lw<i>_<j>`, `lp<i>`, `lc<i>`, `edom<i>`, `exactemail<i>`, `exactemail<i>c<j>`, `rp<i>`.
