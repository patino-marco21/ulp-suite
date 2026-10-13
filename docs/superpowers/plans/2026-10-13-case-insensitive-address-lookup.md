# Case-insensitive exact-address lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (The owner chose inline execution: one check per step, no repeated re-checks.)

**Goal:** Every exact-address lookup finds every stored casing of the address, as fast as the old exact match, through a bloom filter on `lower(email)`.

**Architecture:** One pure module (`lib/address-lookup.ts`) owns the expression, the index name and the SQL fragments. DDL v29 adds the index definition; a supervised script materializes it on the existing parts BEFORE the app that depends on it is deployed. The search builder, `/api/check`, `/api/v1/lookup`, both batch lookups and the related panel build their SQL from that module. No runtime readiness gate and no fallback to the old six-casing probe (spec, "Not doing").

**Tech Stack:** TypeScript, Next.js route handlers, ClickHouse 26.3 (`bloom_filter` skip index on an expression), vitest, bash.

Spec: `docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md` (approved by the owner on 2026-10-13).

## Global Constraints

- Index: `idx_bf_email_lc`, expression exactly `lower(email)`, type `bloom_filter(0.05)`, `GRANULARITY 1` (same type and rate as `idx_bf_email`).
- A query uses the index only when it contains the identical expression: always `lower(email) = lower({p:String})` (or `!=` / `IN (lower({a:String}), ...)`), never `email = ...` for an address.
- Every query that compares `lower(email)` also runs with `optimize_use_projections = 0` (`ADDRESS_LOOKUP_SETTING`): given a projection the planner reads it whole and never uses the index (measured 17 times slower on a full-index scratch copy). Always in the four lookup routes and the by-email related bucket; in the search routes only when the search has an address term (`usesAddressIndex(tokens)`).
- `SYSTEM STOP MERGES` also blocks mutations: never stop merges around a `MATERIALIZE INDEX` (a `mutations_sync = 2` wait would never end).
- `lower` folds ASCII only and is applied to both sides; no Unicode folding.
- Stored logins are never rewritten; results show the login as stored.
- DDL v29 is metadata only; `MATERIALIZE INDEX` is never fired from app start (v23 rule). A failed v29 ADD is not recorded as done (the next start retries).
- `scripts/materialize-address-index.sh`: dry run by default (`APPLY=1` to run); refuses to start under 130 GiB free (`MIN_FREE_GIB`); kills the mutation and stops under 120 GiB free (`ABORT_FREE_GIB`); one partition at a time, smallest first, `mutations_sync = 0` plus polling; ends with an EXPLAIN check that an impossible address selects at most 10% of the granules (`MAX_SELECTED_PCT`).
- The repository is public: tests and docs use only invented addresses on `example.test` / `example.com`; never a real search term or address.
- Gate before every merge: `npx tsc --noEmit` exit 0, eslint 0 on `app lib components` plus every new file, `npx vitest run` all green. Check exit codes explicitly (a `| head` chain hides a failure).
- Rollback tag of the running image BEFORE building; build with `git archive`; recreate only `app`.

---

## Execution notes (2026-10-13, inline)

Executed in this session, one check per step. Deviations from the text below: `usesAddressIndex` and its tests landed in Task 2 with the builder (Task 5 only wires the routes); the guard test was committed with Task 4, when it could first pass; the rehearsal seeds ONE part (`STOP MERGES` blocks mutations, see Global Constraints) and its granule threshold is 25% because the seed has only about 23 granules; `docker logs` returns the app's `console.warn` on stderr, so the rehearsal reads both streams; and after the full-scale measurement the projection setting is described as insurance, not as a fix for the live table (README, spec and the code comment say so). Results: gate green (tsc 0, eslint 0, 234 files / 3,427 tests); rehearsal 27/27; live `scripts/materialize-address-index.sh` 3 min 10 s, +0 GiB net, index 1.18 GiB; deployed image `9f7b454a15b6`; live parity 9/9 (address lookups 703-741 ms, counts equal to the full scan).

## File Structure

- Create `lib/address-lookup.ts`: expression, index name/type, `addressEquals`, `addressDiffers`, `addressIn`, `addressIndexAddSql`, `addressIndexDropSql`. Pure strings, no imports (tsx loads it from the script).
- Modify `lib/search-index-definitions.ts`: the 6th definition.
- Modify `lib/clickhouse-migrations.ts`: DDL v29 and `ddlVersionToRecord(sourcesIdentityFailed, addressIndexFailed)`.
- Modify `lib/ulp-search.ts`: `exactAddressMatch`, `usesAddressIndex`; delete `emailCasings` and `titleCase`.
- Modify `app/api/check/route.ts`, `app/api/v1/lookup/route.ts`, `app/api/lookup/batch/route.ts`, `app/api/v1/lookup/batch/route.ts`, `lib/related-queries.ts`, and (the projection setting) `app/api/credentials/route.ts`, `app/api/search/route.ts`, `app/api/v1/search/credentials/route.ts`, `app/api/export/route.ts`.
- Create `scripts/materialize-address-index.sh`, `scripts/e2e-address-index.ts`.
- Tests: create `__tests__/address-lookup.test.ts`, `__tests__/ulp-search-address.test.ts`, `__tests__/lookup-batch-address-case.test.ts`, `__tests__/address-lookup-guard.test.ts`, `__tests__/materialize-address-index-script.test.ts`; delete `__tests__/ulp-search-casings.test.ts`; modify the tests named in each task.
- Docs: `README.md`, `app/docs/page.tsx`, the login-scope spec note, the new spec's status line.

---

### Task 1: The shared module, the index definition, DDL v29

**Files:**
- Create: `lib/address-lookup.ts`, `__tests__/address-lookup.test.ts`
- Modify: `lib/search-index-definitions.ts`, `__tests__/search-index-definitions.test.ts`, `lib/clickhouse-migrations.ts`, `__tests__/ddl-version-record.test.ts`, `scripts/e2e-alert-rehearsal.ts`

**Interfaces:**
- Produces (used by every later task): from `@/lib/address-lookup`: `ADDRESS_INDEX_NAME = 'idx_bf_email_lc'`, `ADDRESS_INDEX_EXPR = 'lower(email)'`, `ADDRESS_INDEX_TYPE = 'bloom_filter(0.05)'`, `ADDRESS_LOOKUP_SETTING = 'optimize_use_projections = 0'`, `addressEquals(param: string): string`, `addressDiffers(param: string): string`, `addressIn(params: string[]): string`, `addressIndexAddSql(table: string): string`, `addressIndexDropSql(table: string): string`.
- Produces: `ddlVersionToRecord(sourcesIdentityFailed: boolean, addressIndexFailed?: boolean): number`.

- [x] **Step 1: Write the failing tests**

Create `__tests__/address-lookup.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import {
  ADDRESS_INDEX_EXPR, ADDRESS_INDEX_NAME, ADDRESS_LOOKUP_SETTING, addressDiffers, addressEquals, addressIn, addressIndexAddSql, addressIndexDropSql,
} from '@/lib/address-lookup'

describe('address lookup SQL', () => {
  test('the projection setting every address query carries is the one that was measured', () => {
    expect(ADDRESS_LOOKUP_SETTING).toBe('optimize_use_projections = 0')
  })

  test('equality lowers both sides, with the exact expression the index is built on', () => {
    expect(addressEquals('email')).toBe('lower(email) = lower({email:String})')
    expect(addressEquals('exactemail3')).toBe('lower(email) = lower({exactemail3:String})')
  })

  test('inequality is the same expression', () => {
    expect(addressDiffers('email')).toBe('lower(email) != lower({email:String})')
  })

  test('IN lowers every element', () => {
    expect(addressIn(['email0', 'email1'])).toBe('lower(email) IN (lower({email0:String}), lower({email1:String}))')
    expect(addressIn(['email0'])).toBe('lower(email) IN (lower({email0:String}))')
  })

  test('every builder writes ADDRESS_INDEX_EXPR verbatim (a skip index is used only for the identical expression)', () => {
    for (const sql of [addressEquals('p'), addressDiffers('p'), addressIn(['p']), addressIndexAddSql('ulp.credentials')]) {
      expect(sql).toContain(ADDRESS_INDEX_EXPR)
    }
  })

  test('the index DDL is idempotent and takes the table, for a content-dedup clone', () => {
    expect(addressIndexAddSql('ulp.credentials')).toBe(
      'ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_email_lc lower(email) TYPE bloom_filter(0.05) GRANULARITY 1',
    )
    expect(addressIndexDropSql('ulp.credentials_cdedup_auto')).toBe('ALTER TABLE ulp.credentials_cdedup_auto DROP INDEX IF EXISTS idx_bf_email_lc')
    expect(ADDRESS_INDEX_NAME).toBe('idx_bf_email_lc')
  })
})
```

Replace the whole content of `__tests__/ddl-version-record.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ddlVersionToRecord } from '@/lib/clickhouse-migrations'

describe('ddlVersionToRecord', () => {
  it('records v29 when the ulp.sources identity columns and the address index were added', () => {
    expect(ddlVersionToRecord(false)).toBe(29)
    expect(ddlVersionToRecord(false, false)).toBe(29)
  })

  it('keeps the version below v29 when the ADD INDEX failed, so the next start tries it again', () => {
    expect(ddlVersionToRecord(false, true)).toBe(28)
  })

  it('keeps the version below v28 when that ALTER failed, whatever happened to v29', () => {
    expect(ddlVersionToRecord(true)).toBe(27)
    expect(ddlVersionToRecord(true, false)).toBe(27)
    expect(ddlVersionToRecord(true, true)).toBe(27)
  })
})
```

In `__tests__/search-index-definitions.test.ts` change the first test and add one (keep the rest):

```ts
  test('has exactly the 6 indexes search depends on, in a stable order', () => {
    const names = SEARCH_INDEX_DEFINITIONS.map(d => d.name)
    expect(names).toEqual([
      'idx_inv_url',
      'idx_inv_email',
      'idx_inv_password',
      'idx_ngram_url_host',
      'idx_ngram_email_domain',
      'idx_bf_email_lc',
    ])
  })

  test('idx_bf_email_lc is a bloom filter on the lower(email) expression, 0.05 like idx_bf_email', () => {
    const def = SEARCH_INDEX_DEFINITIONS.find(d => d.name === 'idx_bf_email_lc')!
    expect(def.addIndexSql('ulp.credentials')).toBe(
      'ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_email_lc lower(email) TYPE bloom_filter(0.05) GRANULARITY 1',
    )
    expect(def.dropIndexSql('ulp.credentials_cdedup_auto')).toBe('ALTER TABLE ulp.credentials_cdedup_auto DROP INDEX IF EXISTS idx_bf_email_lc')
  })
```

- [x] **Step 2: Run the tests and see them fail**

Run: `npx vitest run __tests__/address-lookup.test.ts __tests__/ddl-version-record.test.ts __tests__/search-index-definitions.test.ts`
Expected: FAIL (`Cannot find module '@/lib/address-lookup'`, version 28 instead of 29, 5 names instead of 6).

- [x] **Step 3: Create the module**

Create `lib/address-lookup.ts`:

```ts
/**
 * Case-insensitive exact-address lookup: docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md.
 *
 * Logins are stored as typed, so `email = lower(value)` cannot see an address stored with a capital. A bloom filter on the EXPRESSION
 * `lower(email)` (idx_bf_email_lc) lets `lower(email) = lower(value)` prune as well as the exact match did. ClickHouse uses a skip index
 * only when the query contains the identical expression, so the expression and the index name live here once: DDL v29, the
 * SEARCH_INDEX_DEFINITIONS list, scripts/materialize-address-index.sh and every query that looks an address up are built from this file.
 *
 * `lower` folds ASCII letters only and leaves every other character alone. It is applied to both sides, so "equal" means "equal ignoring
 * ASCII case", which is exactly what the index stores. Pure strings and no imports: scripts load this file through tsx.
 */

/** The name of the index. */
export const ADDRESS_INDEX_NAME = 'idx_bf_email_lc'

/** The indexed expression, exactly as every query must write it. */
export const ADDRESS_INDEX_EXPR = 'lower(email)'

/** The same type and false-positive rate as idx_bf_email. */
export const ADDRESS_INDEX_TYPE = 'bloom_filter(0.05)'

/**
 * Every query that compares lower(email) must carry this setting. Given a projection to choose from, the planner reads the whole projection
 * (it counts marks and does not credit the skip index's pruning) and never uses idx_bf_email_lc: on a 46M-row copy of the table with all its
 * indexes and projections an absent address took 0.42 s that way and 0.021 s with the setting (about 16 s against 1 s at 1.84B rows).
 */
export const ADDRESS_LOOKUP_SETTING = 'optimize_use_projections = 0'

/** `lower(email) = lower({param:String})`: the login equals the value, ignoring ASCII case. */
export function addressEquals(param: string): string {
  return `${ADDRESS_INDEX_EXPR} = lower({${param}:String})`
}

/** `lower(email) != lower({param:String})`: any other login. */
export function addressDiffers(param: string): string {
  return `${ADDRESS_INDEX_EXPR} != lower({${param}:String})`
}

/** `lower(email) IN (lower({a:String}), lower({b:String}), ...)` for a list of parameter names. */
export function addressIn(params: string[]): string {
  return `${ADDRESS_INDEX_EXPR} IN (${params.map(p => `lower({${p}:String})`).join(', ')})`
}

/** ADD INDEX IF NOT EXISTS: safe to run again. Metadata only; parts written before it need MATERIALIZE INDEX (scripts/materialize-address-index.sh). */
export function addressIndexAddSql(table: string): string {
  return `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS ${ADDRESS_INDEX_NAME} ${ADDRESS_INDEX_EXPR} TYPE ${ADDRESS_INDEX_TYPE} GRANULARITY 1`
}

/** DROP INDEX IF EXISTS: the pair of the above in SEARCH_INDEX_DEFINITIONS. */
export function addressIndexDropSql(table: string): string {
  return `ALTER TABLE ${table} DROP INDEX IF EXISTS ${ADDRESS_INDEX_NAME}`
}
```

- [x] **Step 4: Add the definition**

In `lib/search-index-definitions.ts`, add the import under the header comment (before `export interface SearchIndexDefinition`):

```ts
import { ADDRESS_INDEX_NAME, addressIndexAddSql, addressIndexDropSql } from '@/lib/address-lookup'
```

and append as the last element of `SEARCH_INDEX_DEFINITIONS` (after the `idx_ngram_email_domain` entry, before the closing `]`):

```ts
  {
    // Case-insensitive exact-address lookup (lib/address-lookup.ts): a bloom filter on lower(email).
    name: ADDRESS_INDEX_NAME,
    dropIndexSql: addressIndexDropSql,
    addIndexSql: addressIndexAddSql,
  },
```

- [x] **Step 5: DDL v29**

In `lib/clickhouse-migrations.ts`:

(a) Under `import { SEARCH_INDEX_DEFINITIONS } from './search-index-definitions'` add:

```ts
import { addressIndexAddSql } from './address-lookup'
```

(b) Replace the lines

```ts
const DDL_VERSION = 28
const DDL_BEFORE_SOURCES_IDENTITY = 27

/** The DDL version to record after a run: a failed v28 ALTER (ulp.sources identity columns) is not recorded as done, so the next start tries it again. */
export function ddlVersionToRecord(sourcesIdentityFailed: boolean): number {
  return sourcesIdentityFailed ? DDL_BEFORE_SOURCES_IDENTITY : DDL_VERSION
}
```

with:

```ts
// v29: idx_bf_email_lc, a bloom filter on lower(email) (docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md). Logins are stored as typed (5.4% have a
//      capital), so `email = lower(value)` missed them; every exact-address lookup now compares `lower(email) = lower(value)` and this index prunes it the way idx_bf_email pruned the
//      exact match. ADD INDEX IF NOT EXISTS is metadata only: parts written from now on carry the index. Existing parts get it with MATERIALIZE INDEX, NOT fired here (see v23: start-up
//      must not be coupled to a mutation): scripts/materialize-address-index.sh, supervised, BEFORE the image whose queries depend on it is deployed. Until then a lookup is correct but scans.
//      The queries depend on the index, so a failed ADD is not recorded as done and the next start tries again.
const DDL_VERSION = 29
const DDL_BEFORE_SOURCES_IDENTITY = 27
const DDL_BEFORE_ADDRESS_INDEX = 28

/** The DDL version to record after a run: a failed v28 ALTER (ulp.sources identity columns) or a failed v29 ADD INDEX is not recorded as done, so the next start tries it again. */
export function ddlVersionToRecord(sourcesIdentityFailed: boolean, addressIndexFailed = false): number {
  if (sourcesIdentityFailed) return DDL_BEFORE_SOURCES_IDENTITY
  return addressIndexFailed ? DDL_BEFORE_ADDRESS_INDEX : DDL_VERSION
}
```

(c) After the v28 block (the `if (lastDdl < 28) { ... }` that ends with the `v28: ulp.sources identity columns -- FAILED` error log) insert:

```ts
  // v29 — idx_bf_email_lc (see DDL_VERSION comment above). ADD INDEX IF NOT EXISTS is metadata only and idempotent (the supervised script may have added it first). The lookup
  // queries depend on the index, so a failure is not recorded as done: the next start runs it again. Existing parts: scripts/materialize-address-index.sh, never from here.
  let addressIndexFailed = false
  if (lastDdl < 29) {
    try {
      await client.exec({ query: addressIndexAddSql('ulp.credentials') })
      console.warn('[ClickHouse migration] DDL v29 applied (idx_bf_email_lc on lower(email) -- existing parts need scripts/materialize-address-index.sh)')
    } catch (err) {
      addressIndexFailed = true
      console.error('[ClickHouse migration] v29: ADD INDEX idx_bf_email_lc -- FAILED (tried again at the next start):', err instanceof Error ? err.message : String(err))
    }
  }
```

(d) Replace `const ddlReached = ddlVersionToRecord(sourcesIdentityFailed)` with `const ddlReached = ddlVersionToRecord(sourcesIdentityFailed, addressIndexFailed)`, and in the comment above it change "A failed v28 keeps the recorded version below it" to "A failed v28 or v29 keeps the recorded version below it".

- [x] **Step 6: The alert rehearsal pins the version**

In `scripts/e2e-alert-rehearsal.ts` replace

```ts
    check('the DDL version recorded in SQLite is 28 (v28: ulp.sources identity columns)', ddl === '28', `got ${ddl}`)
```

with

```ts
    check('the DDL version recorded in SQLite is 29 (v29: the lower(email) index)', ddl === '29', `got ${ddl}`)
    const addressIndex = chQuery("SELECT expr FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_bf_email_lc'")
    check('idx_bf_email_lc exists on a fresh install and indexes lower(email)', addressIndex === 'lower(email)', `got ${addressIndex}`)
```

- [x] **Step 7: Run the tests and see them pass**

Run: `npx vitest run __tests__/address-lookup.test.ts __tests__/ddl-version-record.test.ts __tests__/search-index-definitions.test.ts __tests__/content-dedup.test.ts __tests__/sources-identity.test.ts`
Expected: PASS (content-dedup derives its expectation from `SEARCH_INDEX_DEFINITIONS.length`).

- [x] **Step 8: Commit**

```bash
git add lib/address-lookup.ts __tests__/address-lookup.test.ts lib/search-index-definitions.ts __tests__/search-index-definitions.test.ts lib/clickhouse-migrations.ts __tests__/ddl-version-record.test.ts scripts/e2e-alert-rehearsal.ts
git commit -m "feat(address): DDL v29 adds a bloom filter on lower(email); one module owns the expression"
```

---

### Task 2: The search builder

**Files:**
- Modify: `lib/ulp-search.ts`, `__tests__/ulp-search.test.ts`, `__tests__/credentials-route-login-scope.test.ts`, `__tests__/ulp-search-login-build.test.ts`
- Create: `__tests__/ulp-search-address.test.ts`
- Delete: `__tests__/ulp-search-casings.test.ts`

**Interfaces:**
- Consumes: `addressEquals` from `@/lib/address-lookup` (Task 1).
- Produces: for an `email_full` token (scopes `all` and `login`) `buildULPWhere` returns clause `(lower(email) = lower({exactemailN:String}))` and `params.exactemailN` = the value as typed. `emailCasings` no longer exists.

- [x] **Step 1: Write the failing tests**

Create `__tests__/ulp-search-address.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { buildULPWhere, parseULPQuery } from '@/lib/ulp-search'

describe('buildULPWhere — an address is an exact match that ignores case', () => {
  test('the clause is one lower(email) = lower(param), and the value goes in as typed', () => {
    const { clause, params } = buildULPWhere(parseULPQuery('John.Smith@Example.com'))
    expect(clause).toBe('(lower(email) = lower({exactemail0:String}))')
    expect(params).toEqual({ exactemail0: 'John.Smith@Example.com' })
  })

  test('the same clause in the Login (whole word) scope', () => {
    const { clause, params } = buildULPWhere(parseULPQuery('john@example.com', 'login'))
    expect(clause).toBe('(lower(email) = lower({exactemail0:String}))')
    expect(params.exactemail0).toBe('john@example.com')
  })

  test('negation wraps it, and it never uses LIKE or hasToken', () => {
    const negated = buildULPWhere(parseULPQuery('-john@example.com')).clause
    expect(negated).toBe('NOT (lower(email) = lower({exactemail0:String}))')
    for (const c of [negated, buildULPWhere(parseULPQuery('john@example.com')).clause]) {
      expect(c).not.toContain('LIKE')
      expect(c).not.toContain('hasToken')
    }
  })

  test('Login (contains) keeps its substring match for an address (complete in any case)', () => {
    const { clause } = buildULPWhere(parseULPQuery('john@example.com', 'login_contains'))
    expect(clause).toContain('positionCaseInsensitive(email,')
  })

  test('parameter names of different terms do not collide', () => {
    const { params } = buildULPWhere(parseULPQuery('a@example.com, b@example.com'))
    expect(params).toEqual({ exactemail0: 'a@example.com', exactemail1: 'b@example.com' })
  })
})
```

Then delete the old probe tests: `git rm __tests__/ulp-search-casings.test.ts`.

In `__tests__/ulp-search.test.ts` replace the two tests at the `email_full` description (the one whose title starts `email_full type → exact email IN (...)` and the one titled `email_full puts the lowercased value first ...`) with:

```ts
  test('email_full type → exact lower(email) = lower(value) match (bloom_filter on lower(email) accelerated)', () => {
    const tokens = parseULPQuery('john@gmail.com')
    const { clause, params } = buildULPWhere(tokens)
    expect(clause).toContain('lower(email) = lower(')
    // Must NOT contain LIKE (would bypass index)
    expect(clause).not.toContain('LIKE')
    expect(Object.values(params)).toContain('john@gmail.com')
  })

  test('email_full passes the value as typed; ClickHouse folds the case on both sides', () => {
    const { params } = buildULPWhere(parseULPQuery('JOHN@GMAIL.COM'))
    expect(params.exactemail0).toBe('JOHN@GMAIL.COM')
    expect(Object.keys(params)).toHaveLength(1)
  })
```

and in the integration describe replace the two count tests:

```ts
  test('full email search generates one param', () => {
    const tokens = parseULPQuery('alice@example.com')
    const { params } = buildULPWhere(tokens)
    expect(Object.keys(params)).toHaveLength(1)
  })
```

```ts
  test('three-term AND query generates four params (token type uses two, an address one)', () => {
    // @gmail.com → email_dom  → 1 param
    // hunter2   → token      → 2 params (lowercase value for hasToken, LIKE pattern for url_host/email_domain)
    // alice@…   → email_full → 1 param (the value as typed)
    // Total: 4 params
    const tokens = parseULPQuery('@gmail.com, hunter2, alice@gmail.com')
    const { params } = buildULPWhere(tokens)
    expect(Object.keys(params)).toHaveLength(4)
  })
```

(keep each test's neighbours unchanged; the second replaced test keeps its describe.)

In `__tests__/credentials-route-login-scope.test.ts` replace the test `a full address probes the common casings` with:

```ts
  test('a full address is an exact match that ignores case', async () => {
    await get('q=John.Smith@example.com&skip_totals=1&dedupe=0')
    expect(allSql()).toContain('lower(email) = lower({exactemail0:String})')
    expect(allParams().exactemail0).toBe('John.Smith@example.com')
  })
```

In `__tests__/ulp-search-login-build.test.ts` replace the test `a full address keeps an exact match on the login` with:

```ts
  test('a full address is an exact match on the login that ignores case', () => {
    const { clause, params } = build('john@example.com', 'login')
    expect(clause).toBe('(lower(email) = lower({exactemail0:String}))')
    expect(clause).not.toContain('hasToken')
    expect(params.exactemail0).toBe('john@example.com')
  })
```

- [x] **Step 2: Run the tests and see them fail**

Run: `npx vitest run __tests__/ulp-search-address.test.ts __tests__/ulp-search.test.ts __tests__/credentials-route-login-scope.test.ts __tests__/ulp-search-login-build.test.ts`
Expected: FAIL (the clause is still `email IN (...)`).

- [x] **Step 3: Implement**

In `lib/ulp-search.ts`:

(a) Add under the existing `import type { SearchScope }` lines:

```ts
import { addressEquals } from '@/lib/address-lookup'
```

(b) Replace the header comment block of `email_full`:

```
 *   email_full — full email e.g. john@gmail.com
 *                → email = lower(value)
 *                   Hits the bloom_filter(email) skip index for O(1) granule
 *                   pruning.  No LIKE fallback — substring search on emails
 *                   would bypass the index and scan every granule.
```

with

```
 *   email_full — full email e.g. john@gmail.com
 *                → lower(email) = lower(value)
 *                   Hits the bloom_filter(lower(email)) skip index (idx_bf_email_lc,
 *                   lib/address-lookup.ts) for granule pruning, and finds every stored
 *                   casing of the address (logins are kept as typed).  No LIKE
 *                   fallback — substring search on emails would bypass the index
 *                   and scan every granule.
```

(c) Delete the `titleCase` function with its comment, the `emailCasings` function with its comment, and the old `exactAddressMatch` with its comment (the block from `/** Upper-cases the first letter of every run ...` through the closing brace of `exactAddressMatch`), and put in their place:

```ts
/** A full address as an exact match on the login that ignores case (bloom filter on lower(email), lib/address-lookup.ts). Its parameter is added to `params`. */
function exactAddressMatch(token: ParsedToken, i: number, params: Record<string, unknown>): string {
  const name = `exactemail${i}`
  params[name] = token.value
  return `(${addressEquals(name)})`
}
```

(d) In `buildULPWhere`'s `email_full` branch replace the comment

```
      // Exact match (exactAddressMatch). Hits the bloom_filter(email) skip index — skips granules that can't contain the value without
      // scanning them.  No LIKE fallback: substring search on emails would bypass the index and force a full table scan.
```

with

```
      // Exact match that ignores case (exactAddressMatch). Hits the bloom_filter(lower(email)) skip index — skips granules that can't contain the
      // value without scanning them.  No LIKE fallback: substring search on emails would bypass the index and force a full table scan.
```

- [x] **Step 4: Run the tests and see them pass**

Run: `npx vitest run __tests__/ulp-search-address.test.ts __tests__/ulp-search.test.ts __tests__/credentials-route-login-scope.test.ts __tests__/ulp-search-login-build.test.ts __tests__/ulp-search-login-parse.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A lib/ulp-search.ts __tests__/ulp-search-address.test.ts __tests__/ulp-search.test.ts __tests__/credentials-route-login-scope.test.ts __tests__/ulp-search-login-build.test.ts __tests__/ulp-search-casings.test.ts
git commit -m "feat(search): a full address matches in any case through lower(email); the six-casing probe is gone"
```

---

### Task 3: The lookup routes

**Files:**
- Modify: `app/api/check/route.ts`, `app/api/v1/lookup/route.ts`, `app/api/lookup/batch/route.ts`, `app/api/v1/lookup/batch/route.ts`
- Modify tests: `__tests__/check-route-timeout.test.ts`, `__tests__/lookup-routes-imported-range.test.ts`, `__tests__/v1-lookup-batch-route.test.ts`
- Create: `__tests__/lookup-batch-address-case.test.ts`, `__tests__/address-lookup-guard.test.ts`

**Interfaces:**
- Consumes: `addressEquals`, `addressIn`, `ADDRESS_INDEX_EXPR` from `@/lib/address-lookup`.
- Produces: single lookups use `lower(email) = lower({email:String})`; batch lookups use `lower(email) IN (lower({email0:String}), ...)`, `ORDER BY lower(email) ASC, imported_at DESC`, `LIMIT {cap:UInt32} BY lower(email)`, and the result for each queried address is the rows whose lowercased login equals it.

- [x] **Step 1: Write the failing tests**

Update `__tests__/check-route-timeout.test.ts`: replace `expect(sql).toContain('WHERE email = {email:String}')` with these two lines:

```ts
    expect(sql).toContain('WHERE lower(email) = lower({email:String})')
    expect(sql).toContain('optimize_use_projections = 0')
```

Update `__tests__/lookup-routes-imported-range.test.ts` (four assertions):
- `` `WHERE email = {email:String} AND ${PLAIN_AFTER}` `` → `` `WHERE lower(email) = lower({email:String}) AND ${PLAIN_AFTER}` ``
- `'WHERE email = {email:String}\n'` → `'WHERE lower(email) = lower({email:String})\n'`
- `` `WHERE email IN ({email0:String}) AND ${PLAIN_AFTER} AND ${PLAIN_BEFORE}` `` → `` `WHERE lower(email) IN (lower({email0:String})) AND ${PLAIN_AFTER} AND ${PLAIN_BEFORE}` ``
- `'WHERE email IN ({email0:String})\n'` → `'WHERE lower(email) IN (lower({email0:String}))\n'`

and add this test to its `GET /api/v1/lookup — imported_after / imported_before` describe:

```ts
  test('the email lookup runs with projections off; the domain lookup keeps its settings', async () => {
    await getUrl(v1Lookup, '/api/v1/lookup?email=a@b.co')
    expect(calls[0].sql).toContain('optimize_use_projections = 0')
    calls.length = 0
    await getUrl(v1Lookup, '/api/v1/lookup?domain=b.co')
    expect(calls[0].sql).not.toContain('optimize_use_projections')
  })
```

Update `__tests__/v1-lookup-batch-route.test.ts`:
- in the first test replace the three inner assertions with:

```ts
    expect(inner(sql)).toContain('WHERE lower(email) IN (lower({email0:String}), lower({email1:String}))')
    expect(inner(sql)).toContain('ORDER BY lower(email) ASC, imported_at DESC')
    expect(inner(sql)).toContain('LIMIT {cap:UInt32} BY lower(email)')
    expect(sql).toContain('optimize_use_projections = 0')
```

- in the domain test (`the domain lookup filters, sorts and LIMIT BYs on the stored domain column`) add `expect(sql).not.toContain('optimize_use_projections')` (the domain lookup keeps its settings);
- replace the `test.each` of "the final order is re-stated on the outer select" with:

```ts
  test.each([
    ['emails', ['a@b.co'], 'lower(t.email)'],
    ['domains', ['b.co'], 't.domain'],
  ])('%s: the final order is re-stated on the outer select (a LIMIT BY result order is not relied on)', async (kind, values, key) => {
    await post({ [kind]: values })
    const { sql } = calls[0]
    expect(sql.slice(sql.indexOf(') AS t'))).toContain(`ORDER BY ${key} ASC, t.imported_at DESC`)
  })
```

- in `emails and domains are two queries, one each` replace `'WHERE email IN'` with `'WHERE lower(email) IN'`; in the response-shape test replace `sql.includes('WHERE email IN')` with `sql.includes('WHERE lower(email) IN')`.

Create `__tests__/lookup-batch-address-case.test.ts`:

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

const calls: Array<{ sql: string; params: Record<string, unknown> }> = []
let rows: unknown[] = []
vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown>) => {
    calls.push({ sql, params })
    return rows
  }),
}))

import { NextRequest } from 'next/server'
import { POST as uiBatch } from '@/app/api/lookup/batch/route'
import { POST as v1Batch } from '@/app/api/v1/lookup/batch/route'

const post = (handler: typeof uiBatch, url: string, body: unknown) =>
  handler(new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) }))

const stored = (email: string, imported_at: string) => ({
  email, url: 'https://x.example.test/', password: 'pw', domain: 'x.example.test', source_file: 'f', breach_name: 'B', imported_at,
})

beforeEach(() => {
  calls.length = 0
  rows = []
})

describe.each([
  ['POST /api/lookup/batch', uiBatch, '/api/lookup/batch'],
  ['POST /api/v1/lookup/batch', v1Batch, '/api/v1/lookup/batch'],
] as const)('%s — an address matches every stored casing', (_name, handler, url) => {
  test('the query compares lower(email) on both sides, orders and caps per address ignoring case', async () => {
    await post(handler, url, { emails: ['Jane@Example.com', 'bob@example.org'] })
    const { sql, params } = calls[0]
    expect(sql).toContain('lower(email) IN (lower({email0:String}), lower({email1:String}))')
    expect(sql).toContain('ORDER BY lower(email) ASC, imported_at DESC')
    expect(sql).toContain('LIMIT {cap:UInt32} BY lower(email)')
    expect(sql).not.toMatch(/\bemail IN \(/)
    expect(sql).toContain('optimize_use_projections = 0')
    expect(params).toMatchObject({ email0: 'jane@example.com', email1: 'bob@example.org', cap: 50 })
  })

  test('rows stored in different casings are all returned under the address that was asked for', async () => {
    rows = [
      stored('Jane@Example.com', '2026-03-01 00:00:00'),
      stored('jane@example.com', '2026-02-01 00:00:00'),
      stored('JANE@EXAMPLE.COM', '2026-01-01 00:00:00'),
      stored('bob@example.org', '2026-01-01 00:00:00'),
    ]
    const json = await (await post(handler, url, { emails: ['jAnE@example.com', 'nobody@example.com'] })).json()
    expect(json.results['jAnE@example.com'].count).toBe(3)
    expect(json.results['jAnE@example.com'].results.map((r: { email: string }) => r.email)).toEqual([
      'Jane@Example.com', 'jane@example.com', 'JANE@EXAMPLE.COM',
    ])
    expect(json.results['nobody@example.com']).toEqual({ found: false, count: 0, results: [] })
    expect(json.found).toBe(1)
  })
})
```

Create `__tests__/address-lookup-guard.test.ts` (a source-text guard, like the repo's other wiring tests):

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * A skip index on lower(email) is used only when the query writes the identical expression, and a query that compares the
 * raw column to a lowercased value silently misses every address stored with a capital. So no route or library file may
 * compare an address with the raw `email` column again: they build the SQL with lib/address-lookup.ts.
 */
const ROOT = resolve(__dirname, '..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const files = [...sources(join(ROOT, 'app/api')), ...sources(join(ROOT, 'lib'))]

const FORBIDDEN: Array<[string, RegExp]> = [
  ['email = {email:String}', /\bemail = \{email:String\}/],
  ['email != {email:String}', /\bemail != \{email:String\}/],
  ['email IN (${emailList})', /\bemail IN \(\$\{emailList\}\)/],
  ['emailCasings', /\bemailCasings\b/],
  ['exactemail with a plain email column', /\(email = \{exactemail/],
]

describe('no exact-address lookup compares the raw email column', () => {
  test('the source tree has files to check', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  test.each(FORBIDDEN)('nothing writes %s', (_label, re) => {
    const offenders = files.filter(f => re.test(readFileSync(f, 'utf8'))).map(f => f.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })
})
```

- [x] **Step 2: Run the tests and see them fail**

Run: `npx vitest run __tests__/check-route-timeout.test.ts __tests__/lookup-routes-imported-range.test.ts __tests__/v1-lookup-batch-route.test.ts __tests__/lookup-batch-address-case.test.ts __tests__/address-lookup-guard.test.ts`
Expected: FAIL (the routes still compare the raw column; the guard lists check, v1 lookup, both batch routes and `lib/related-queries.ts` is not listed yet because it compares `email = {email:String}` too — see Task 4).

- [x] **Step 3: Implement the four routes**

`app/api/check/route.ts`: add `import { ADDRESS_LOOKUP_SETTING, addressEquals } from "@/lib/address-lookup"` next to the other `@/lib` imports; in the same query's `SETTINGS` change `use_query_cache = 0` to `use_query_cache = 0, ${ADDRESS_LOOKUP_SETTING}`; replace the two comment lines

```
    // email has a bloom_filter skip index — point lookup is fast even at 1.39B rows
    // (measured 2026-09-30: 0.3-1.2 s for ordinary addresses, ~22 s for a very popular one).
```

with

```
    // lower(email) has a bloom_filter skip index (idx_bf_email_lc, lib/address-lookup.ts) — a point lookup is fast even at 1.84B rows
    // (measured 2026-09-30 with the old index on email: 0.3-1.2 s for ordinary addresses, ~22 s for a very popular one) and finds every
    // stored casing of the address.
```

and replace `       WHERE email = {email:String}` with `       WHERE ${addressEquals("email")}`.

`app/api/v1/lookup/route.ts`: add `import { ADDRESS_LOOKUP_SETTING, addressEquals } from '@/lib/address-lookup'` with the other `@/lib` imports; in the EMAIL query only (the domain query below it keeps its settings) replace

```ts
         WHERE email = {email:String}${rangeAnd}
         ORDER BY imported_at DESC LIMIT 100
         ${SETTINGS}`,
```

with

```ts
         WHERE ${addressEquals('email')}${rangeAnd}
         ORDER BY imported_at DESC LIMIT 100
         ${SETTINGS}, ${ADDRESS_LOOKUP_SETTING}`,
```

`app/api/lookup/batch/route.ts`: add `import { ADDRESS_INDEX_EXPR, ADDRESS_LOOKUP_SETTING, addressIn } from "@/lib/address-lookup"` (the email query ends with `${SETTINGS}, ${ADDRESS_LOOKUP_SETTING}`; the domain query keeps `${SETTINGS}`); replace the block from `const emailList = emails.map(...)` through the `for (const email of emails) { ... }` loop of the email lookups with:

```ts
      const emailNames = emails.map((_, i) => `email${i}`)
      const emailParams: Record<string, string | number> = {}
      emails.forEach((e, i) => { emailParams[`email${i}`] = e.toLowerCase() })

      const rows = await executeQuery(
        `SELECT email, password, url, domain, source_file, breach_name, imported_at
         FROM ulp.credentials
         WHERE ${addressIn(emailNames)}${rangeAnd}
         ORDER BY ${ADDRESS_INDEX_EXPR} ASC, imported_at DESC
         LIMIT {cap:UInt32} BY ${ADDRESS_INDEX_EXPR}
         ${SETTINGS}, ${ADDRESS_LOOKUP_SETTING}`,
        { ...emailParams, ...rangeSql.params, cap: RESULTS_CAP }
      ) as Array<{
        email: string; password: string; url: string; domain: string
        source_file: string; breach_name: string; imported_at: string
      }>

      for (const email of emails) {
        const lc   = email.toLowerCase()
        const hits = rows.filter(r => r.email.toLowerCase() === lc)
        results[email] = { found: hits.length > 0, count: hits.length, results: hits }
      }
```

and update the comment above it to: `// Index on lower(email) (idx_bf_email_lc): bloom_filter(0.05) prunes granules and every stored casing of an address matches. NORM_EMAIL_EXPR in WHERE defeated the index. LIMIT {cap} BY lower(email) guarantees up to RESULTS_CAP rows per queried address (any casing), fixing the starvation bug where one hot email filled the global cap.`

`app/api/v1/lookup/batch/route.ts`: add the same import (with `ADDRESS_LOOKUP_SETTING`); replace the email block (from `const emailList = ...` through the loop) with:

```ts
      const emailNames = emails.map((_, i) => `email${i}`)
      const emailParams: Record<string, string> = {}
      emails.forEach((e, i) => { emailParams[`email${i}`] = e.toLowerCase() })

      const rows = await executeQuery(
        `SELECT ${OUTER_COLS}
         FROM (
           SELECT ${RAW_COLS}
           FROM ulp.credentials
           WHERE ${addressIn(emailNames)}${rangeAnd}
           ORDER BY ${ADDRESS_INDEX_EXPR} ASC, imported_at DESC
           LIMIT {cap:UInt32} BY ${ADDRESS_INDEX_EXPR}
         ) AS t
         ORDER BY lower(t.email) ASC, t.imported_at DESC
         ${SETTINGS}, ${ADDRESS_LOOKUP_SETTING}`,
        { ...emailParams, ...rangeSql.params, cap: RESULTS_CAP }
      ) as Array<{ email: string; url: string; password: string; domain: string; source_file: string; breach_name: string; imported_at: string }>

      for (const email of emails) {
        const lc   = email.toLowerCase()
        const hits = rows.filter(r => r.email.toLowerCase() === lc)
        results[email] = { found: hits.length > 0, count: hits.length, results: hits }
      }
```

with the comment above it updated to say `lower(email)` (index idx_bf_email_lc) instead of "bloom_filter(0.05) on email".

- [x] **Step 4: Run the tests and see them pass**

Run: `npx vitest run __tests__/check-route-timeout.test.ts __tests__/check-route-ip-trust.test.ts __tests__/lookup-routes-imported-range.test.ts __tests__/v1-lookup-batch-route.test.ts __tests__/lookup-batch-address-case.test.ts`
Expected: PASS. (`__tests__/address-lookup-guard.test.ts` still fails on `lib/related-queries.ts` until Task 4; that is expected here.)

- [x] **Step 5: Commit**

```bash
git add app/api/check/route.ts app/api/v1/lookup/route.ts app/api/lookup/batch/route.ts app/api/v1/lookup/batch/route.ts __tests__/check-route-timeout.test.ts __tests__/lookup-routes-imported-range.test.ts __tests__/v1-lookup-batch-route.test.ts __tests__/lookup-batch-address-case.test.ts __tests__/address-lookup-guard.test.ts
git commit -m "feat(lookup): check, v1 lookup and both batch lookups match an address in any case"
```

---

### Task 4: The related panel

**Files:**
- Modify: `lib/related-queries.ts`, `__tests__/related-queries.test.ts`

**Interfaces:**
- Consumes: `addressEquals`, `addressDiffers` from `@/lib/address-lookup`.
- Produces: `RELATED_BY_EMAIL_SQL` filters `lower(email) = lower({email:String})`; `RELATED_BY_DOMAIN_SQL` and `RELATED_BY_PASSWORD_SQL` exclude the same login with `lower(email) != lower({email:String})`.

- [x] **Step 1: Update the test expectations (they fail first)**

In `__tests__/related-queries.test.ts` replace the `buckets` array with:

```ts
const buckets = [
  { name: 'by_email', sql: RELATED_BY_EMAIL_SQL, where: 'WHERE lower(email) = lower({email:String})', params: ['email'] },
  { name: 'by_domain', sql: RELATED_BY_DOMAIN_SQL, where: 'WHERE domain = {domain:String} AND lower(email) != lower({email:String})', params: ['domain', 'email'] },
  { name: 'by_password', sql: RELATED_BY_PASSWORD_SQL, where: 'WHERE password = {password:String} AND lower(email) != lower({email:String})', params: ['email', 'password'] },
]
```

and append this describe at the end of the file:

```ts
describe('related queries — the projection setting', () => {
  test('only the same-login bucket carries it (it is the one that uses the lower(email) index)', () => {
    expect(RELATED_BY_EMAIL_SQL).toContain('optimize_use_projections = 0')
    expect(RELATED_BY_DOMAIN_SQL).not.toContain('optimize_use_projections')
    expect(RELATED_BY_PASSWORD_SQL).not.toContain('optimize_use_projections')
  })
})
```

- [x] **Step 2: Run and see it fail**

Run: `npx vitest run __tests__/related-queries.test.ts`
Expected: FAIL on the three `the inner query filters raw stored columns` tests and on the projection-setting test.

- [x] **Step 3: Implement**

In `lib/related-queries.ts` add `import { ADDRESS_LOOKUP_SETTING, addressDiffers, addressEquals } from '@/lib/address-lookup'` under the existing import; change `function relatedQuery(where: string): string {` to `function relatedQuery(where: string, extraSettings = ''): string {` and the last line of its template, `     SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, use_query_cache = 0, ${NORM_COLS_SETTING}\``, to end with `${NORM_COLS_SETTING}${extraSettings}\``; then replace the three exports with:

```ts
/** Same login on other rows -- cross-domain reuse of one account, whatever the letter case it was stored in (idx_bf_email_lc, which needs the base table). */
export const RELATED_BY_EMAIL_SQL = relatedQuery(addressEquals('email'), `, ${ADDRESS_LOOKUP_SETTING}`)

/** Other logins on the same domain -- exposure breadth. The same login in another case is not "other". */
export const RELATED_BY_DOMAIN_SQL = relatedQuery(`domain = {domain:String} AND ${addressDiffers('email')}`)

/** Other accounts using the exact same password. The same login in another case is not "other". */
export const RELATED_BY_PASSWORD_SQL = relatedQuery(`password = {password:String} AND ${addressDiffers('email')}`)
```

Add one sentence to the file's header comment, before `Params:`: `The login comparisons are case-insensitive (lib/address-lookup.ts): lower(email) is the indexed expression, written identically here.` And in the same comment replace the fragment `` `SELECT ${NORM_COLS} ... WHERE email = {email:String}` `` with `` `SELECT ${NORM_COLS} ... WHERE lower(email) = lower({email:String})` `` (the guard test of Task 3 would otherwise flag the old text).

- [x] **Step 4: Run and see it pass**

Run: `npx vitest run __tests__/related-queries.test.ts __tests__/related-route-failures.test.ts __tests__/address-lookup-guard.test.ts`
Expected: PASS (the guard is now clean across `app/api` and `lib`).

- [x] **Step 5: Commit**

```bash
git add lib/related-queries.ts __tests__/related-queries.test.ts
git commit -m "feat(related): the same-login bucket and the exclusions ignore letter case"
```

---

### Task 5: The search routes keep the planner on the base table

**Files:**
- Modify: `lib/ulp-search.ts`, `app/api/credentials/route.ts`, `app/api/search/route.ts`, `app/api/v1/search/credentials/route.ts`, `app/api/export/route.ts`
- Modify tests: `__tests__/ulp-search-address.test.ts`, `__tests__/credentials-route-login-scope.test.ts`, `__tests__/lookup-routes-imported-range.test.ts`, `__tests__/export-route-imported-range.test.ts`

**Interfaces:**
- Consumes: `ADDRESS_LOOKUP_SETTING` from `@/lib/address-lookup` (Task 1).
- Produces: `usesAddressIndex(tokens: ParsedToken[], regexMode?: boolean): boolean` from `@/lib/ulp-search`: true when a term is answered through the `lower(email)` index (an `email_full` term outside Login (contains), not in regex mode).

Why: Task 3 and 4 queries are address queries by construction. A search query is one only when the text has an address term, and a word or domain search must keep today's settings (the Credentials route disables projections only when no imported range is set, and the other three never did).

- [x] **Step 1: Write the failing tests**

In `__tests__/ulp-search-address.test.ts` change the import to `import { buildULPWhere, parseULPQuery, usesAddressIndex } from '@/lib/ulp-search'` and append:

```ts
describe('usesAddressIndex — which searches need the projection setting', () => {
  test.each([
    ['john@example.com', 'all', true],
    ['john@example.com', 'login', true],
    ['-john@example.com', 'all', true],
    ['maria, john@example.com', 'all', true],
    ['john@example.com', 'login_contains', false],
    ['maria', 'all', false],
    ['ledger.com', 'all', false],
    ['@example.com', 'all', false],
    ['', 'all', false],
  ] as const)('%s in scope %s is %s', (q, scope, expected) => {
    expect(usesAddressIndex(parseULPQuery(q, scope))).toBe(expected)
  })

  test('regex mode never uses the address clause', () => {
    expect(usesAddressIndex(parseULPQuery('john@example.com'), true)).toBe(false)
  })
})
```

Append to `__tests__/credentials-route-login-scope.test.ts`:

```ts
describe('GET /api/credentials — an address search keeps the planner on the base table', () => {
  test('rows and totals carry optimize_use_projections = 0', async () => {
    await get('q=john.smith@example.com&skip_totals=1&dedupe=0')
    await get('q=john.smith@example.com&totals_only=1&dedupe=0')
    const queries = calls.map(c => c.sql).filter(s => /FROM ulp\.credentials/.test(s))
    expect(queries.length).toBeGreaterThanOrEqual(2)
    for (const sql of queries) expect(sql).toContain('optimize_use_projections = 0')
  })

  test('the totals keep it when an imported range is set; a word search drops it there', async () => {
    const range = 'imported_after=2026-08-28T23:30:00Z'
    await get(`q=john.smith@example.com&${range}&totals_only=1&dedupe=0`)
    const addressTotals = calls.map(c => c.sql).filter(s => /AS raw_total/.test(s))
    expect(addressTotals.length).toBeGreaterThan(0)
    expect(addressTotals.every(s => s.includes('optimize_use_projections = 0'))).toBe(true)
    calls.length = 0
    await get(`q=maria&${range}&totals_only=1&dedupe=0`)
    expect(calls.map(c => c.sql).filter(s => /AS raw_total/.test(s)).some(s => s.includes('optimize_use_projections'))).toBe(false)
  })

  test("a word search keeps today's settings in its row query", async () => {
    await get('q=maria&skip_totals=1&dedupe=0')
    const rows = calls.map(c => c.sql).filter(s => /\) AS t\s/.test(s))
    expect(rows.length).toBeGreaterThan(0)
    for (const sql of rows) expect(sql).not.toContain('optimize_use_projections')
  })
})
```

Append to `__tests__/lookup-routes-imported-range.test.ts`:

```ts
describe('address searches keep the planner on the base table (v1 search and the legacy search)', () => {
  test.each([
    ['v1 search', v1Search, '/api/v1/search/credentials?q=ADDR'],
    ['legacy search', legacySearch, '/api/search?q=ADDR'],
  ] as const)('%s: both queries carry optimize_use_projections = 0 for an address, neither for a word', async (_name, handler, url) => {
    await getUrl(handler, url.replace('ADDR', 'john@example.com'))
    expect(queryCalls().length).toBeGreaterThanOrEqual(2)
    for (const c of queryCalls()) expect(c.sql).toContain('optimize_use_projections = 0')
    calls.length = 0
    await getUrl(handler, url.replace('ADDR', 'maria'))
    expect(queryCalls().length).toBeGreaterThanOrEqual(2)
    for (const c of queryCalls()) expect(c.sql).not.toContain('optimize_use_projections')
  })
})
```

Append to `__tests__/export-route-imported-range.test.ts`:

```ts
describe('POST /api/export — an address search keeps the planner on the base table', () => {
  test('the row query carries optimize_use_projections = 0 for an address and not for a word', async () => {
    await post({ format: 'csv', query: 'john@example.com' })
    expect(dataCall()!.sql).toContain('optimize_use_projections = 0')
    calls.length = 0
    streamCalls.length = 0
    await post({ format: 'csv', query: 'maria' })
    expect(dataCall()!.sql).not.toContain('optimize_use_projections')
  })
})
```

- [x] **Step 2: Run and see them fail**

Run: `npx vitest run __tests__/ulp-search-address.test.ts __tests__/credentials-route-login-scope.test.ts __tests__/lookup-routes-imported-range.test.ts __tests__/export-route-imported-range.test.ts`
Expected: FAIL (`usesAddressIndex` is not exported; the routes do not carry the setting).

- [x] **Step 3: Implement**

`lib/ulp-search.ts`, right after `isIndexNeutralSearch`:

```ts
/**
 * True when a term of the search is answered through the lower(email) index (idx_bf_email_lc), so the query must also carry
 * ADDRESS_LOOKUP_SETTING (lib/address-lookup.ts): with a projection to choose from the planner reads it whole and never uses the index.
 * Login (contains) is a substring scan of the login column and regex mode has its own clause; neither uses it.
 */
export function usesAddressIndex(tokens: ParsedToken[], regexMode = false): boolean {
  return !regexMode && tokens.some(t => t.type === 'email_full' && t.scope !== 'login_contains')
}
```

`app/api/credentials/route.ts`: add `usesAddressIndex` to the existing `@/lib/ulp-search` import and `import { ADDRESS_LOOKUP_SETTING } from "@/lib/address-lookup"`. Where `searchTokens` and the regex flag are in scope (before the totals and row queries), add:

```ts
    // An address term is answered through idx_bf_email_lc, which only the base table can use (lib/address-lookup.ts).
    const addressSearch = usesAddressIndex(searchTokens, regex)
    const addressSettingLine = addressSearch ? `${ADDRESS_LOOKUP_SETTING},` : ''
```

In the totals query replace

```ts
                    use_query_cache = 0${hasImportedRange(importedRange) ? '' : ',\n                    optimize_use_projections = 0'}`,
```

with

```ts
                    use_query_cache = 0${hasImportedRange(importedRange) && !addressSearch ? '' : `,\n                    ${ADDRESS_LOOKUP_SETTING}`}`,
```

and in BOTH plain row templates (the `dedupeInWindow` one and the other) add a line `                  ${addressSettingLine}` between `max_bytes_before_external_sort = ${SORT_MAX_MEMORY_BYTES},` and `${NORM_COLS_SETTING}`. (If `regex` or `searchTokens` have other names in scope, use those: `tsc` finds a wrong name.)

`app/api/search/route.ts`: import `usesAddressIndex` and `ADDRESS_LOOKUP_SETTING`; after the `{ clause, params: baseParams }` line add `const projectionOff = usesAddressIndex(tokens, regexMode) ? `,\n                  ${ADDRESS_LOOKUP_SETTING}` : ''`; append `${projectionOff}` to the end of the count query's SETTINGS (after `use_query_cache = 0`) and of the rows query's SETTINGS (after `${NORM_COLS_SETTING}`).

`app/api/v1/search/credentials/route.ts`: import both; after `const { clause, params } = buildULPWhere(tokens)` add `const projectionOff = usesAddressIndex(tokens) ? `,\n                      ${ADDRESS_LOOKUP_SETTING}` : ''`; append `${projectionOff}` after `use_query_cache = 0` in the count query and after `http_wait_end_of_query = 1` in the rows query.

`app/api/export/route.ts`: import both; after the `const { clause, params: baseParams } = regex_mode ? ... : buildULPWhere(tokens)` statement add `const projectionOff = usesAddressIndex(tokens, Boolean(regex_mode)) ? `, ${ADDRESS_LOOKUP_SETTING}` : ''`; in `rowsSql` change the last line to `${exportSortSettings()}, ${NORM_COLS_SETTING}${extraSettings}${projectionOff}`.

- [x] **Step 4: Run and see them pass**

Run: `npx vitest run __tests__/ulp-search-address.test.ts __tests__/credentials-route-login-scope.test.ts __tests__/lookup-routes-imported-range.test.ts __tests__/export-route-imported-range.test.ts __tests__/search-route-split.test.ts __tests__/cursor-raw-columns.test.ts __tests__/ulp-normalize-setting.test.ts; npx tsc --noEmit; echo "tsc exit $?"`
Expected: PASS and `tsc exit 0`.

- [x] **Step 5: Commit**

```bash
git add lib/ulp-search.ts app/api/credentials/route.ts app/api/search/route.ts app/api/v1/search/credentials/route.ts app/api/export/route.ts __tests__/ulp-search-address.test.ts __tests__/credentials-route-login-scope.test.ts __tests__/lookup-routes-imported-range.test.ts __tests__/export-route-imported-range.test.ts
git commit -m "feat(address): searches with an address term keep the planner on the base table"
```

---

### Task 6: The supervised materialize script

**Files:**
- Create: `scripts/materialize-address-index.sh` (mode 755), `__tests__/materialize-address-index-script.test.ts`

**Interfaces:**
- Consumes: `addressIndexAddSql`, `ADDRESS_INDEX_EXPR` through `tsx` (Task 1).
- Produces: env `APPLY`, `MIN_FREE_GIB` (130), `ABORT_FREE_GIB` (120), `POLL_SECONDS` (5), `MAX_MINUTES` (60), `MAX_SELECTED_PCT` (10), `CLICKHOUSE_CONTAINER` (`ulpsuite_clickhouse`); exit codes 0 / 2 precondition / 4 disk / 5 timeout / 6 failed or index unused.

- [x] **Step 1: Write the failing test**

Create `__tests__/materialize-address-index-script.test.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * scripts/materialize-address-index.sh adds the lower(email) bloom filter to the existing parts after DDL v29. It is a mutation on a
 * 1.84B-row table, so it is run here for real against a stand-in `docker` that answers from the environment and records every statement:
 * the stub shadows `docker` on PATH and DOCKER_HOST points at a dead socket, so no test can reach a real ClickHouse (run() refuses to
 * start unless `docker` resolves to the stub).
 */

const REPO = resolve(__dirname, '..')

const DEFAULT_EXPLAIN = [
  'ReadFromMergeTree (ulp.credentials)',
  'Indexes:',
  '  PrimaryKey',
  '    Condition: true',
  '    Parts: 18/18',
  '    Granules: 225000/225000',
  '  Skip',
  '    Name: idx_bf_email_lc',
  '    Description: bloom_filter GRANULARITY 1',
  '    Parts: 18/18',
  '    Granules: 11000/225000',
].join('\n')

const STUB_DOCKER = `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  info|inspect) exit 0 ;;
  exec) ;;
  *) exit 0 ;;
esac
sql=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--query" ]; then sql="$2"; break; fi
  shift
done
printf '%s\\n-- end of statement --\\n' "$sql" >> "$STUB_CALLS"
case "$sql" in
  *"AS pending_mutations"*)  echo "\${STUB_PENDING:-0}" ;;
  *"AS free_gib"*)           echo "\${STUB_FREE_GIB:-200}" ;;
  *"AS index_defined"*)      echo "\${STUB_DEFINED:-0}" ;;
  *"AS index_expression"*)   echo "\${STUB_INDEX_EXPR:-lower(email)}" ;;
  *"AS partition_id"*)       printf '%b' "\${STUB_PARTITIONS-202608\\\\n202607\\\\n}" ;;
  *"AS mutation_state"*)     printf '%b' "\${STUB_MUTATION_STATE:-1\\\\t0\\\\t\\\\n}" ;;
  *"AS last_mutation"*)      echo "\${STUB_LAST_MUTATION-}" ;;
  *"EXPLAIN indexes"*)       printf '%s\\n' "$STUB_EXPLAIN" ;;
  *"AS index_size"*)         echo "1.20 GiB" ;;
  *)                         : ;;
esac
exit 0
`

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'address-index-'))
  const stubPath = join(dir, 'docker')
  const callsPath = join(dir, 'calls.log')
  writeFileSync(stubPath, STUB_DOCKER)
  chmodSync(stubPath, 0o755)
  writeFileSync(callsPath, '')

  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(APPLY$|STUB_|DOCKER_|CLICKHOUSE_|MIN_FREE|ABORT_|POLL_|MAX_)/.test(k)) base[k] = v
  }
  base.PATH = [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  base.DOCKER_HOST = 'unix:///nonexistent/docker.sock'
  base.STUB_CALLS = callsPath
  base.STUB_EXPLAIN = DEFAULT_EXPLAIN
  base.POLL_SECONDS = '0'

  const probe = spawnSync('bash', ['-c', 'command -v docker'], { env: base, encoding: 'utf8' })
  if (probe.stdout.trim() !== stubPath) throw new Error(`refusing to run: docker resolves to "${probe.stdout.trim()}", not the stub`)

  const r = spawnSync('bash', [join(REPO, 'scripts', 'materialize-address-index.sh')], {
    cwd: REPO,
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), calls: readFileSync(callsPath, 'utf8') }
}

/** Every statement the script sent that is not a read, whitespace collapsed, SETTINGS dropped. */
const writes = (calls: string) =>
  calls.split('-- end of statement --').map(s => s.trim()).filter(s => /^(ALTER|KILL|INSERT|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|SYSTEM)\b/i.test(s))
    .map(s => s.replace(/\s+/g, ' ').replace(/ SETTINGS .*/, ''))

const ADD = 'ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_email_lc lower(email) TYPE bloom_filter(0.05) GRANULARITY 1'

describe('scripts/materialize-address-index.sh', () => {
  test('a dry run checks the preconditions, says what it would do, and changes nothing', () => {
    const r = run({})
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/dry run/i)
    expect(r.out).toContain('not defined yet')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('APPLY=1 adds the definition, materializes one partition at a time (smallest first) and verifies; nothing else is written', () => {
    const r = run({ APPLY: '1' })
    expect(r.status).toBe(0)
    expect(writes(r.calls)).toEqual([
      ADD,
      "ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_bf_email_lc IN PARTITION '202608'",
      "ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_bf_email_lc IN PARTITION '202607'",
    ])
    expect(r.calls).toMatch(/EXPLAIN indexes = 1 SELECT count\(\).*optimize_use_projections = 0/s)
    expect(r.out).toContain('11000 of 225000')
    expect(r.calls).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|KILL MUTATION/i)
  }, 120_000)

  test('an index that is already defined is not added again', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1' })
    expect(r.status).toBe(0)
    expect(writes(r.calls).every(s => !s.includes('ADD INDEX'))).toBe(true)
    expect(writes(r.calls)).toHaveLength(2)
  }, 120_000)

  test('it refuses while another mutation is running', () => {
    const r = run({ APPLY: '1', STUB_PENDING: '2' })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/mutation/i)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses under MIN_FREE_GIB (130 by default)', () => {
    const r = run({ APPLY: '1', STUB_FREE_GIB: '100' })
    expect(r.status).toBe(2)
    expect(r.out).toContain('only 100 GiB free')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses when an index of that name indexes something else', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', STUB_INDEX_EXPR: 'email' })
    expect(r.status).toBe(2)
    expect(r.out).toContain('idx_bf_email_lc')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('free disk falling under ABORT_FREE_GIB while a mutation runs kills it and stops', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', MIN_FREE_GIB: '10', ABORT_FREE_GIB: '150', STUB_FREE_GIB: '120', STUB_MUTATION_STATE: '0\\t3\\t\\n' })
    expect(r.status).toBe(4)
    expect(r.calls).toMatch(/KILL MUTATION WHERE database = 'ulp' AND table = 'credentials'/)
    expect(r.out).toMatch(/killed/i)
  }, 120_000)

  test('a mutation that keeps failing is reported and the script stops', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', STUB_MUTATION_STATE: '0\\t3\\tCode: 999. boom\\n' })
    expect(r.status).toBe(6)
    expect(r.out).toContain('boom')
  }, 120_000)

  test('an index that still selects most granules is rejected (a part without it)', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', STUB_EXPLAIN: DEFAULT_EXPLAIN.replace('11000/225000', '200000/225000') })
    expect(r.status).toBe(6)
    expect(r.out).toContain('200000 of 225000')
  }, 120_000)

  test('an EXPLAIN that never mentions the index is rejected (the expression did not match)', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', STUB_EXPLAIN: 'ReadFromMergeTree (ulp.credentials)\nIndexes:\n  PrimaryKey\n    Granules: 225000/225000' })
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/not used/i)
  }, 120_000)

  test('the verification runs after the last MATERIALIZE', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1' })
    expect(r.calls.lastIndexOf('MATERIALIZE INDEX')).toBeLessThan(r.calls.indexOf('EXPLAIN indexes'))
  }, 120_000)
})
```

- [x] **Step 2: Run and see it fail**

Run: `npx vitest run __tests__/materialize-address-index-script.test.ts`
Expected: FAIL (the script does not exist).

- [x] **Step 3: Write the script**

Create `scripts/materialize-address-index.sh`:

```bash
#!/usr/bin/env bash
# Add the lower(email) bloom filter (idx_bf_email_lc) to the existing parts of ulp.credentials after DDL v29, supervised.
#
#   bash scripts/materialize-address-index.sh            # dry run: preconditions and what it would do; changes nothing
#   APPLY=1 bash scripts/materialize-address-index.sh    # adds the index if missing, materializes it one partition at a time, verifies
#
# Why: every exact-address lookup compares lower(email) = lower(value) (lib/address-lookup.ts). That finds every stored casing of an
# address, but it is only fast when the parts carry this index. DDL v29 adds the definition (metadata; parts written from then on have
# the index); the existing parts need `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_bf_email_lc`, a mutation that rewrites index
# files only (about 1.2 GiB for 1.84B rows; 2.2 s per 37M rows on a scratch table). Run this BEFORE deploying the image whose queries
# depend on the index. Design: docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md
#
# Refuses (nothing changed) unless: no other mutation is running on the table (exit 2), free disk is at least MIN_FREE_GIB (2), and an
# index named idx_bf_email_lc that already exists indexes lower(email) (2). While it runs it watches free space and kills the mutation
# below ABORT_FREE_GIB (4). It ends by asking ClickHouse (EXPLAIN indexes = 1) how many granules an address that cannot exist would
# read: at most MAX_SELECTED_PCT percent (the bloom filter's own false-positive rate is about 5%), or the index is not doing its job (6).
#
# Exit: 0 ok | 2 precondition | 4 aborted for disk | 5 timed out (the mutation is still running) | 6 the mutation failed, or the index is
#       not used / reads too much.
# Needs `npm ci` in this checkout (tsx). Counts only; never prints a row.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
MIN_FREE_GIB="${MIN_FREE_GIB:-130}"
ABORT_FREE_GIB="${ABORT_FREE_GIB:-120}"
POLL_SECONDS="${POLL_SECONDS:-5}"
MAX_MINUTES="${MAX_MINUTES:-60}"
MAX_SELECTED_PCT="${MAX_SELECTED_PCT:-10}"
CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
TSX_BIN="${TSX_BIN:-$PROJECT_DIR/node_modules/.bin/tsx}"
INDEX="idx_bf_email_lc"

cd "$PROJECT_DIR"

if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  echo "ERROR: Docker is unavailable in this shell." >&2
  exit 1
fi
if ! "$DOCKER_BIN" inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: ClickHouse container '$CONTAINER' is not running." >&2
  exit 1
fi
if [[ ! -x "$TSX_BIN" ]]; then
  echo "ERROR: $TSX_BIN is missing (run 'npm ci' in $PROJECT_DIR)." >&2
  exit 1
fi

ch() {
  # --receive_timeout: the client's default is 300 s of silence; a query that only waits must not be abandoned.
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --receive_timeout=7200 --send_timeout=7200 --query "$1"
}

free_gib() {
  local v
  v="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
  echo "${v:-0}"
}

echo "ULP Suite - lower(email) index backfill (DDL v29)"
echo "APPLY=$APPLY (0 = dry run)"
echo

# The DDL and the expression come from the code the queries are built from, so the two cannot drift.
ADD_SQL="$("$TSX_BIN" -e "import { addressIndexAddSql as s } from './lib/address-lookup'; process.stdout.write(s('ulp.credentials'))")"
EXPR="$("$TSX_BIN" -e "import { ADDRESS_INDEX_EXPR as e } from './lib/address-lookup'; process.stdout.write(e)")"
if [[ -z "$ADD_SQL" || -z "$EXPR" ]]; then
  echo "ERROR: could not read the index definition from lib/address-lookup.ts." >&2
  exit 1
fi

# 1. One mutation at a time on this table.
pending="$(ch "SELECT count() AS pending_mutations FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND NOT is_done FORMAT TSVRaw")"
pending="${pending:-0}"
if (( pending > 0 )); then
  echo "ERROR: $pending mutation(s) are still running on ulp.credentials. Wait for them (system.mutations) and retry." >&2
  exit 2
fi
echo "pending mutations: 0"

# 2. Room: the index files are about 1.2 GiB, but a mutation may briefly keep a second copy of a part's files.
free_now="$(free_gib)"
if (( free_now < MIN_FREE_GIB )); then
  echo "ERROR: only $free_now GiB free; need at least $MIN_FREE_GIB GiB (MIN_FREE_GIB)." >&2
  exit 2
fi
echo "free disk: $free_now GiB (need $MIN_FREE_GIB, abort below $ABORT_FREE_GIB)"

# 3. The index: absent (APPLY=1 adds it) or present and indexing the right expression.
defined="$(ch "SELECT count() AS index_defined FROM system.data_skipping_indices WHERE database = 'ulp' AND table = 'credentials' AND name = '$INDEX' FORMAT TSVRaw")"
if [[ "${defined:-0}" != "0" ]]; then
  live_expr="$(ch "SELECT expr AS index_expression FROM system.data_skipping_indices WHERE database = 'ulp' AND table = 'credentials' AND name = '$INDEX' FORMAT TSVRaw")"
  if [[ "$live_expr" != "$EXPR" ]]; then
    echo "ERROR: an index named $INDEX exists but indexes '$live_expr', not '$EXPR'. Drop it by hand (ALTER TABLE ulp.credentials DROP INDEX $INDEX) and run again." >&2
    exit 2
  fi
  echo "index: defined on $EXPR"
else
  echo "index: not defined yet (APPLY=1 adds it)"
fi

# 4. Partitions, the smallest first, so the first mutation is the cheapest measurement of what it costs.
partitions="$(ch "SELECT partition AS partition_id FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active GROUP BY partition ORDER BY sum(bytes_on_disk) ASC FORMAT TSVRaw")"
echo "partitions (smallest first): $(echo $partitions)"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry run: nothing was changed. Run again with APPLY=1 to add the index and materialize it."
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────

# Newest mutation id whose command matches a LIKE pattern, read BEFORE submitting a new one, so that we only ever wait for a
# mutation NEWER than that (an earlier finished run with the same command must not pass for this one).
last_mutation_id() {
  ch "SELECT max(mutation_id) AS last_mutation FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$1' FORMAT TSVRaw"
}

# wait_for_mutation LIKE_PATTERN LABEL BEFORE_ID: poll system.mutations until the newest matching mutation after BEFORE_ID is done.
# Exit 6 if it is failing or cannot be found, 4 (after killing it) if free disk drops below ABORT_FREE_GIB, 5 on timeout.
# Submitted with mutations_sync = 0 and polled: an ALTER that waits holds a silent connection the client may abandon.
wait_for_mutation() {
  local pattern="$1" label="$2" before="$3"
  local deadline=$(( $(date +%s) + MAX_MINUTES * 60 )) not_found=0 state is_done parts_to_do fail_reason free_here
  while true; do
    state="$(ch "SELECT is_done, parts_to_do, latest_fail_reason AS mutation_state FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$pattern' AND mutation_id > '$before' ORDER BY mutation_id DESC LIMIT 1 FORMAT TSVRaw")"
    if [[ -z "$state" ]]; then
      not_found=$(( not_found + 1 ))
      if (( not_found >= 5 )); then
        echo "ERROR: the $label mutation is not in system.mutations; check it by hand before running this again." >&2
        exit 6
      fi
      sleep "$POLL_SECONDS"
      continue
    fi
    IFS=$'\t' read -r is_done parts_to_do fail_reason <<<"$state"
    if [[ -n "${fail_reason:-}" ]]; then
      echo "ERROR: the $label mutation is failing: $fail_reason" >&2
      echo "       It keeps retrying. To stop it:  docker exec $CONTAINER clickhouse-client --query \"KILL MUTATION WHERE database='ulp' AND table='credentials' AND command LIKE '$pattern' AND mutation_id > '$before'\"" >&2
      exit 6
    fi
    if [[ "${is_done:-0}" == "1" ]]; then
      return 0
    fi
    free_here="$(free_gib)"
    echo "  $(date -u +%H:%M:%S) $label: parts still to rewrite: ${parts_to_do:-?}; free disk ${free_here} GiB"
    if (( free_here < ABORT_FREE_GIB )); then
      ch "KILL MUTATION WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$pattern' AND mutation_id > '$before'" || true
      echo "ERROR: free disk fell to $free_here GiB (< $ABORT_FREE_GIB); the $label mutation was killed. Free space and run again." >&2
      exit 4
    fi
    if (( $(date +%s) > deadline )); then
      echo "ERROR: the $label mutation is still running after $MAX_MINUTES minutes. It was NOT stopped; watch it in system.mutations." >&2
      exit 5
    fi
    sleep "$POLL_SECONDS"
  done
}

if [[ "${defined:-0}" == "0" ]]; then
  echo
  echo "Adding the index definition (metadata only)"
  ch "$ADD_SQL"
fi

for p in $partitions; do
  free_now="$(free_gib)"
  if (( free_now < MIN_FREE_GIB )); then
    echo "ERROR: only $free_now GiB free before partition $p (need $MIN_FREE_GIB). Free space, then run again: finished partitions are skipped by ClickHouse's own bookkeeping, not by this script." >&2
    exit 4
  fi
  echo
  echo "Materializing $INDEX for partition $p"
  started="$(date +%s)"
  PATTERN="%MATERIALIZE INDEX $INDEX IN PARTITION%$p%"
  before="$(last_mutation_id "$PATTERN")"
  ch "ALTER TABLE ulp.credentials MATERIALIZE INDEX $INDEX IN PARTITION '$p' SETTINGS mutations_sync = 0"
  wait_for_mutation "$PATTERN" "partition $p" "$before"
  echo "  partition $p done in $(( $(date +%s) - started )) s; free disk $(free_gib) GiB"
done

# ── verify: an address that cannot exist must read almost no granules ────────────────────────────────────────────────
echo
probe="ulp-address-index-probe-$$-$(date +%s)@invalid.test"
explain="$(ch "EXPLAIN indexes = 1 SELECT count() FROM ulp.credentials WHERE lower(email) = lower('$probe') SETTINGS optimize_use_projections = 0 FORMAT TSVRaw")"
granules="$(awk -v n="$INDEX" '$0 ~ ("Name: " n) { f = 1 } f && /Granules:/ { print $2; exit }' <<<"$explain")"
selected="${granules%/*}"
initial="${granules#*/}"
if [[ ! "$selected" =~ ^[0-9]+$ || ! "$initial" =~ ^[0-9]+$ ]]; then
  echo "ERROR: EXPLAIN does not show $INDEX being used for lower(email) = lower(value): the index is not used." >&2
  echo "$explain" | sed 's/^/       /' >&2
  exit 6
fi
echo "EXPLAIN: an address that cannot exist selects $selected of $initial granules"
if (( initial > 0 )) && (( selected * 100 > MAX_SELECTED_PCT * initial )); then
  echo "ERROR: that is more than $MAX_SELECTED_PCT% of the granules: some part does not carry $INDEX (or the index is ineffective)." >&2
  exit 6
fi

echo "index size: $(ch "SELECT formatReadableSize(data_compressed_bytes) AS index_size FROM system.data_skipping_indices WHERE database = 'ulp' AND table = 'credentials' AND name = '$INDEX' FORMAT TSVRaw")"
echo
echo "$INDEX is materialized on every partition. It is now safe to deploy the image whose lookups compare lower(email)."
```

Then `chmod +x scripts/materialize-address-index.sh`.

- [x] **Step 4: Run and see it pass**

Run: `npx vitest run __tests__/materialize-address-index-script.test.ts`
Expected: PASS (11 tests; each runs the script against the stub).

- [x] **Step 5: Commit**

```bash
git add scripts/materialize-address-index.sh __tests__/materialize-address-index-script.test.ts
git commit -m "feat(address): supervised script that materializes the lower(email) index partition by partition"
```

---

### Task 7: Docs, the live parity test, the spec notes

**Files:**
- Modify: `README.md`, `app/docs/page.tsx`, `docs/superpowers/specs/2026-10-13-login-search-scope-design.md`, `__tests__/login-scope-parity.live.test.ts`

- [x] **Step 1: README**

(a) In the *Search in* bullet (README line 21) replace "A full address (`name@host`) is an exact match that also tries the common capitalisations (`Name@host`, `NAME@HOST`); *Login (contains)* ignores case completely. Case is folded for ASCII letters only." with "A full address (`name@host`) is an exact match that ignores letter case, so every stored casing of it is found (about 0.4-2 s). Case is folded for ASCII letters only."

(b) After the "Domain search dictionary (speed)" subsection (before the next `###` heading) add:

```markdown
### Case-insensitive address lookup

Logins are stored as typed (about 5% of e-mail logins contain a capital), so an exact match on the raw column would miss them. Every exact-address lookup (a full address in the search box, `/api/check`, `/api/v1/lookup`, both batch lookups and the related panel) compares `lower(email) = lower(value)`, which finds every stored casing; each row is shown as stored, so one address can come back in several casings. A bloom-filter index on `lower(email)` (`idx_bf_email_lc`, DDL v29, about 1.2 GiB on 1.8 billion rows) keeps it as fast as the old exact match (0.4-2 s). Case is folded for ASCII letters only.

DDL v29 adds the index definition; parts written before it need `bash scripts/materialize-address-index.sh` (a dry run unless `APPLY=1`; one partition at a time, a few minutes, with a free-disk watchdog that kills the mutation under 120 GiB). Run it before deploying a version that depends on the index. An install without it still answers correctly but scans the table (13-30 s; `/api/check` can time out).
```

(c) In the performance table row `Exact domain / email lookup` change the first cell to `Exact domain / email lookup (an address matches in any letter case)`.

- [x] **Step 2: API docs page**

In `app/docs/page.tsx`:
- line 523: after `Quick lookup to check if an email or domain exists. Returns summary statistics without full credential data.` append ` An email matches in any letter case; each returned row shows the login as stored.`
- line 681: replace `Each email lookup uses the bloom-filter skip index for fast exact matching.` with `Each email lookup uses a bloom-filter skip index for fast exact matching that ignores letter case.`
- line 757: replace `Email addresses are lowercased automatically before matching` with `Email addresses match in any letter case (rows come back as stored)`.

- [x] **Step 3: The login-scope spec note**

At the top of the section `## The e-mail casing probe (included; the owner can strike this section)` of `docs/superpowers/specs/2026-10-13-login-search-scope-design.md` add the line: `> **Superseded 2026-10-13 (later the same day):** an index on lower(email) makes the exact match complete and just as fast, so the probe was removed; see docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md.`

- [x] **Step 4: Tighten the live parity test**

In `__tests__/login-scope-parity.live.test.ts` update the header line

```
 *   casing probe  at least what `email = lower(address)` finds, at most what `lower(email) = address` finds (the complete answer)
```

to

```
 *   address       exactly what `lower(email) = lower(address)` finds with the skip indexes switched off (the complete answer), and more than `email = lower(address)`
```

Give the helper `reference` an optional third argument so the complete answer can be computed with the skip indexes switched off (replace its signature and query line):

```ts
async function reference(where: string, params: Record<string, unknown> = {}, extraSettings = ''): Promise<number> {
  const { getClient } = await import('@/lib/clickhouse')
  const rs = await getClient().query({ query: `SELECT count() AS n FROM ulp.credentials WHERE ${where} ${SETTINGS}${extraSettings}`, query_params: params, format: 'JSONEachRow' })
```

and replace the last test of the file (`the address casing probe finds at least the lowercase lookup and at most the complete answer`) with:

```ts
  test('a full address finds every stored casing, exactly the complete answer, through the index', async () => {
    const { getClient } = await import('@/lib/clickhouse')
    const rs = await getClient().query({
      query: `SELECT DISTINCT lower(email) AS a FROM ulp.credentials WHERE _partition_id = '202610' AND position(email, '@') > 0 AND email != lower(email) AND cityHash64(email) % 20000 = 7 LIMIT {n:UInt32}`,
      query_params: { n: ADDRESSES }, format: 'JSONEachRow',
    })
    const addresses = ((await rs.json()) as Array<{ a: string }>).map(r => r.a)
    expect(addresses.length).toBeGreaterThan(0)
    for (const a of addresses) {
      const before = await reference('email = {a:String}', { a })
      const viaRoute = await routed(`q=${encodeURIComponent(a)}`)
      // The complete answer is computed WITHOUT the skip indexes, so the index cannot vouch for itself.
      const complete = await reference('lower(email) = lower({a:String})', { a }, ', use_skip_indexes = 0')
      const explain = await (await getClient().query({
        query: 'EXPLAIN indexes = 1 SELECT count() FROM ulp.credentials WHERE lower(email) = lower({a:String})',
        query_params: { a }, format: 'TSVRaw',
      })).text()
      const lines = explain.split('\n')
      const g = /Granules:\s*(\d+)\/(\d+)/.exec(lines.slice(lines.findIndex(l => l.includes('Name: idx_bf_email_lc'))).find(l => /Granules:/.test(l)) ?? '')
      console.log(`address | lowercase lookup ${before} | route ${viaRoute.rawTotal} in ${viaRoute.ms} ms | complete ${complete} | granules ${g?.[1]}/${g?.[2]}`)
      expect(viaRoute.rawTotal).toBe(complete)
      expect(viaRoute.rawTotal).toBeGreaterThanOrEqual(before)
      expect(viaRoute.ms).toBeLessThan(3000)
      expect(explain).toContain('idx_bf_email_lc')
      expect(Number(g?.[1]) * 10).toBeLessThanOrEqual(Number(g?.[2]))
    }
  }, 30 * 60_000)
```

- [x] **Step 5: Run what can run offline**

Run: `npx vitest run __tests__/address-lookup-guard.test.ts __tests__/ulp-search-address.test.ts && npx tsc --noEmit; echo "tsc exit $?"`
Expected: tests PASS; `tsc exit 0` (the live test is skipped without `LSP_PARITY=1`, but it must still compile).

- [x] **Step 6: Commit**

```bash
git add README.md app/docs/page.tsx docs/superpowers/specs/2026-10-13-login-search-scope-design.md __tests__/login-scope-parity.live.test.ts
git commit -m "docs(address): README, API docs and the live parity test for the case-insensitive lookup"
```

---

### Task 8: The upgrade-path rehearsal

**Files:**
- Create: `scripts/e2e-address-index.ts`

**Interfaces:**
- Consumes: `scripts/materialize-address-index.sh` (Task 6), the rehearsal stack `docker-compose.rehearsal.yml`, env `PREVIOUS_IMAGE` (required, a pre-v29 image), `CANDIDATE_IMAGE` (default `ulp-suite-app:address-candidate`).

- [x] **Step 1: Write the script**

Create `scripts/e2e-address-index.ts`:

```ts
/**
 * Upgrade-path rehearsal for the case-insensitive address lookup (docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md),
 * against the ISOLATED rehearsal stack (docker-compose.rehearsal.yml: its own ClickHouse, app and volumes; it shares nothing with the real stack).
 *
 * It starts the stack on the PREVIOUS image (before DDL v29), seeds one address stored in five casings plus 1.5M filler rows (one part, about 23
 * granules), upgrades the app to the CANDIDATE image (DDL v29 adds the index definition; the parts written before it do not carry the index),
 * shows that a lookup is already correct but reads everything, runs scripts/materialize-address-index.sh against the rehearsal ClickHouse, and
 * drives the HTTP routes with the address typed in different cases.
 *
 *   docker build -t ulp-suite-app:address-candidate <git archive of the commit under test>
 *   PREVIOUS_IMAGE=ulp-suite-app:latest npx tsx scripts/e2e-address-index.ts       # about 4 minutes; --keep leaves the stack running
 *
 * PREVIOUS_IMAGE must be an image from before DDL v29 (it is required, with no default, so a re-run after the deploy cannot pass vacuously).
 * Exit 0 when every check passes, 1 when one fails, 2 when the rehearsal cannot start.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT = 'ulp-rehearsal'
const COMPOSE_FILE = 'docker-compose.rehearsal.yml'
const BASE = 'http://127.0.0.1:3101'
const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_') || !BASE.endsWith(':3101')) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

const PREVIOUS_IMAGE = process.env.PREVIOUS_IMAGE ?? ''
const CANDIDATE_IMAGE = process.env.CANDIDATE_IMAGE ?? 'ulp-suite-app:address-candidate'
const keep = process.argv.includes('--keep')
const RUN = randomBytes(4).toString('hex')
// One address, typed here in three ways, stored in five rows with four distinct casings (two rows share one).
const LOWER = `mixed.case.${RUN}@example.test`
const STORED = [LOWER, LOWER, `Mixed.Case.${RUN}@Example.test`, `MIXED.CASE.${RUN}@EXAMPLE.TEST`, `mIxEd.cAsE.${RUN}@example.test`]
const TYPED = [LOWER, `MIXED.CASE.${RUN}@EXAMPLE.TEST`, `Mixed.Case.${RUN}@example.test`]

const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}
const info = (label: string, value: unknown) => console.log(`  INFO  ${label}: ${value}`)

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-6).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

async function waitFor<T>(label: string, fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 2000): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* not yet */ }
    await sleep(intervalMs)
  }
  console.log(`  ... gave up waiting for: ${label}`)
  return null
}

async function main(): Promise<number> {
  if (!PREVIOUS_IMAGE) {
    console.error('Set PREVIOUS_IMAGE to an image from before DDL v29 (before the deploy: ulp-suite-app:latest).')
    return 2
  }
  for (const image of [PREVIOUS_IMAGE, CANDIDATE_IMAGE]) {
    try { sh('docker', ['image', 'inspect', image]) } catch { console.error(`The image ${image} is missing.`); return 2 }
  }
  if (sh('docker', ['ps', '-aq', '--filter', 'name=ulprehearsal_']) !== '') {
    console.error(`A rehearsal stack already exists. Remove it first:  docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`)
    return 2
  }
  const memAvailKb = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0)
  if (memAvailKb < 6 * 1024 * 1024) {
    console.error(`Only ${(memAvailKb / 1048576).toFixed(1)} GiB of memory is available; the rehearsal needs about 6 GiB.`)
    return 2
  }

  const dockerCfg = mkdtempSync(join(tmpdir(), 'rehearsal-docker-'))
  writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop's global Docker config has a broken credsStore
  const secrets = {
    REHEARSAL_JWT_SECRET: randomBytes(32).toString('hex'),
    REHEARSAL_ADMIN_EMAIL: 'admin@rehearsal.test',
    REHEARSAL_ADMIN_PASSWORD: randomBytes(18).toString('base64url') + 'Aa1!',
    REHEARSAL_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  }
  const envFor = (image: string): NodeJS.ProcessEnv => ({ ...process.env, DOCKER_CONFIG: dockerCfg, REHEARSAL_APP_IMAGE: image, ...secrets })
  const compose = (image: string, args: string[]) => sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], envFor(image))
  // --async_insert=0: the default profile buffers inserts, and this script reads what it wrote straight away.
  const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', sql])
  const chOrEmpty = (sql: string) => { try { return chQuery(sql) } catch { return '' } }
  const appHealthy = () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy'
  /** Selected and initial granules the index reads for an address that cannot exist (EXPLAIN, text form). */
  const granules = (): { selected: number; initial: number } | null => {
    const text = chQuery(`EXPLAIN indexes = 1 SELECT count() FROM ulp.credentials WHERE lower(email) = lower('nobody-${RUN}@invalid.test') SETTINGS optimize_use_projections = 0`)
    const line = text.split('\n').slice(text.split('\n').findIndex(l => l.includes('Name: idx_bf_email_lc'))).find(l => /Granules:/.test(l))
    const m = /Granules:\s*(\d+)\/(\d+)/.exec(line ?? '')
    return m ? { selected: Number(m[1]), initial: Number(m[2]) } : null
  }

  let cookie = ''
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers }
  }
  const login = async () => {
    const res = await api('POST', '/api/auth/login', { email: secrets.REHEARSAL_ADMIN_EMAIL, password: secrets.REHEARSAL_ADMIN_PASSWORD })
    const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
    const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
    if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
    cookie = `auth=${auth}`
  }

  try {
    console.log(`1. Stack on the previous image (${PREVIOUS_IMAGE})`)
    compose(PREVIOUS_IMAGE, ['up', '-d'])
    const chUp = await waitFor('ClickHouse healthy', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', CH]) === 'healthy', 240_000)
    const chStable = await waitFor('ClickHouse on its native port', async () => {
      for (let i = 0; i < 3; i++) { if (chOrEmpty('SELECT 1') !== '1') return false; await sleep(2000) }
      return true
    }, 180_000, 1000)
    check('ClickHouse started from the production init SQL', !!chUp && !!chStable)
    if (!chUp || !chStable) return 1
    sh('docker', ['restart', APP], envFor(PREVIOUS_IMAGE))
    const up1 = await waitFor('app healthy', appHealthy, 300_000)
    check('the previous app started and ran its migrations', !!up1)
    if (!up1) return 1
    const before = chQuery("SELECT count() FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_bf_email_lc'")
    check('the previous image has no idx_bf_email_lc (this really is the upgrade path)', before === '0', `count ${before}`)
    if (before !== '0') return 2

    console.log('2. Seed: one address in five rows and four casings, plus 1.5M filler rows, as ONE insert = one part (a single part has nothing to merge with, so it stays exactly as written until the script runs)')
    const seedRows = STORED.map((email, i) => `SELECT 'https://site${i}.example.test/login' AS url, '${email}' AS email, 'pw-${i}' AS password, 'site${i}.example.test' AS domain, 'seed-${RUN}' AS source_file, 'Breach-${RUN}-${i}' AS breach_name`).join(' UNION ALL ')
    const filler = `SELECT concat('https://f', toString(number % 50), '.filler.test/'), concat('filler', toString(number), '-${RUN}@mail.test'), 'pw', concat('f', toString(number % 50), '.filler.test'), 'seed-filler-${RUN}', '' FROM numbers(1500000)`
    chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name) ${seedRows} UNION ALL ${filler} SETTINGS max_insert_threads = 1, max_insert_block_size = 5000000, min_insert_block_size_rows = 5000000, min_insert_block_size_bytes = 1000000000`)
    const partCount = chQuery("SELECT count() FROM system.parts WHERE database='ulp' AND table='credentials' AND active")
    check('the seed is one part', partCount === '1', `parts ${partCount}`)
    if (partCount !== '1') return 2

    console.log(`3. Upgrade the app to the candidate image (${CANDIDATE_IMAGE})`)
    compose(CANDIDATE_IMAGE, ['up', '-d', '--no-deps', 'app'])
    const up2 = await waitFor('candidate app healthy', appHealthy, 300_000)
    check('the candidate app started', !!up2)
    if (!up2) return 1
    const logs = sh('docker', ['logs', APP], envFor(CANDIDATE_IMAGE))
    check('the log says DDL v29 applied', /DDL v29 applied/.test(logs))
    check('idx_bf_email_lc is now defined on lower(email)', chQuery("SELECT expr FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_bf_email_lc'") === 'lower(email)')
    await login()
    const g0 = granules()
    check('the part written before the upgrade does not carry the index: an impossible address still reads every granule (and there are enough granules to tell)', !!g0 && g0.initial >= 20 && g0.selected === g0.initial, JSON.stringify(g0))
    const early = await api('GET', `/api/check?email=${encodeURIComponent(TYPED[1])}`)
    check('already correct (it scans): /api/check finds all five rows (five breaches) for the UPPERCASE spelling', early.json?.found === true && early.json?.breach_count === 5, JSON.stringify(early.json).slice(0, 200))

    console.log('4. scripts/materialize-address-index.sh against the rehearsal ClickHouse')
    // 25%: the rehearsal table has about 23 granules, so the filter's own 5% false positives are noisy; unmaterialized is still 100%.
    const scriptEnv = { ...process.env, CLICKHOUSE_CONTAINER: CH, MIN_FREE_GIB: '1', ABORT_FREE_GIB: '0', POLL_SECONDS: '2', MAX_SELECTED_PCT: '25', DOCKER_CONFIG: dockerCfg }
    const dry = sh('bash', ['scripts/materialize-address-index.sh'], scriptEnv)
    check('the dry run says so and changes nothing', /dry run/i.test(dry))
    const applied = sh('bash', ['scripts/materialize-address-index.sh'], { ...scriptEnv, APPLY: '1' })
    check('APPLY=1 materializes the index and its own EXPLAIN check passes', /is materialized on every partition/.test(applied), applied.split('\n').slice(-4).join(' | '))
    const g1 = granules()
    check('an impossible address now reads at most 25% of the granules (about 5% is the filter itself)', !!g1 && g1.initial >= 20 && g1.selected * 4 <= g1.initial, JSON.stringify(g1))

    console.log('5. The routes, with the address typed in three ways')
    for (const typed of TYPED) {
      const check1 = await api('GET', `/api/check?email=${encodeURIComponent(typed)}`)
      check(`/api/check finds all five rows (five breaches) for ${typed === LOWER ? 'lowercase' : typed === TYPED[1] ? 'UPPERCASE' : 'Mixed'}`, check1.json?.found === true && check1.json?.breach_count === 5, JSON.stringify(check1.json).slice(0, 160))
      const batch = await api('POST', '/api/lookup/batch', { emails: [typed] })
      const hit = batch.json?.results?.[typed]
      check('/api/lookup/batch returns all five rows in four casings', hit?.count === 5 && new Set(hit.results.map((r: { email: string }) => r.email)).size === 4, JSON.stringify(hit).slice(0, 160))
      const found = await api('GET', `/api/credentials?q=${encodeURIComponent(typed)}&totals_only=1&dedupe=0`)
      check('/api/credentials (all fields) counts five rows', Number(found.json?.raw_total) === 5, JSON.stringify(found.json).slice(0, 160))
      const inLogin = await api('GET', `/api/credentials?q=${encodeURIComponent(typed)}&scope=login&totals_only=1&dedupe=0`)
      check('/api/credentials (Login scope) counts five rows', Number(inLogin.json?.raw_total) === 5, JSON.stringify(inLogin.json).slice(0, 160))
    }
    const related = await api('GET', `/api/related?email=${encodeURIComponent(STORED[3])}&domain=site0.example.test`)
    check('the related panel lists the same login in every casing', related.json?.success === true && related.json?.by_email?.length === 5, JSON.stringify(related.json).slice(0, 200))
    check('the same account is not its own "other" on the domain', related.json?.by_domain?.every((r: { email: string }) => r.email.toLowerCase() !== LOWER) === true)
    const none = await api('GET', `/api/check?email=${encodeURIComponent(`nobody-${RUN}@example.test`)}`)
    check('an address that is not stored is not found', none.json?.found === false)
  } catch (err) {
    check('the rehearsal ran to the end', false, err instanceof Error ? err.message : String(err))
  } finally {
    if (keep) {
      console.log(`\nStack left running (--keep). App: ${BASE}. Remove it with:\n  REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`)
    } else {
      try { compose(CANDIDATE_IMAGE, ['down', '-v', '--remove-orphans']) } catch (err) { console.error('teardown failed:', err instanceof Error ? err.message : String(err)) }
    }
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  return failed.length === 0 ? 0 : 1
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1) })
```

- [x] **Step 2: Type-check and lint it**

Run: `npx tsc --noEmit; echo "tsc exit $?"; npx eslint scripts/e2e-address-index.ts; echo "eslint exit $?"`
Expected: both exit 0.

- [x] **Step 3: Commit**

```bash
git add scripts/e2e-address-index.ts
git commit -m "test(address): upgrade-path rehearsal of the lower(email) index on the isolated stack"
```

---

### Task 9: Gate, rehearse, roll out

**Files:** none new; this task runs the rollout of the spec.

- [x] **Step 1: The whole local gate (run once)**

```bash
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components __tests__/address-lookup.test.ts __tests__/ulp-search-address.test.ts __tests__/lookup-batch-address-case.test.ts __tests__/address-lookup-guard.test.ts __tests__/materialize-address-index-script.test.ts scripts/e2e-address-index.ts; echo "eslint exit $?"
npx vitest run 2>&1 | tail -15
```
Expected: `tsc exit 0`, `eslint exit 0`, vitest: all files passed, 0 failed. Any failure: fix it before going on (a test that pinned the old behaviour is updated; nothing is skipped).

- [x] **Step 2: Merge and push**

```bash
git push origin main
```
Expected: CI (typecheck, test, lint, build) green on the pushed head (`gh run list --limit 1`).

- [x] **Step 3: Rollback tag, then build the candidate from the merged commit**

```bash
STAMP=$(date -u +%Y%m%d-%H%Mz)
docker tag "$(docker inspect ulpsuite_app --format '{{.Image}}')" "ulp-suite-app:rollback-$STAMP"
SCRATCH=/tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad
mkdir -p "$SCRATCH/dockercfg" "$SCRATCH/addr-build" && echo '{}' > "$SCRATCH/dockercfg/config.json"
rm -rf "$SCRATCH/addr-build" && mkdir -p "$SCRATCH/addr-build" && git archive HEAD | tar -x -C "$SCRATCH/addr-build"
DOCKER_CONFIG="$SCRATCH/dockercfg" docker build -t ulp-suite-app:address-candidate "$SCRATCH/addr-build"
```
Expected: the build ends with the image tagged `ulp-suite-app:address-candidate`; `ulp-suite-app:latest` is untouched (production keeps running the old image).

- [x] **Step 4: Rehearse the upgrade path on the isolated stack**

```bash
PREVIOUS_IMAGE=ulp-suite-app:latest npx tsx scripts/e2e-address-index.ts
```
Expected: every check PASS, `N/N checks passed`, exit 0, the stack torn down. A FAIL is investigated and fixed (new commit, re-merge, rebuild) before touching the live table.

- [x] **Step 5: Materialize on the live table (supervised)**

```bash
bash scripts/materialize-address-index.sh            # dry run: reads the state, changes nothing
df -h / | tail -1                                      # free space before
APPLY=1 bash scripts/materialize-address-index.sh      # about 2 minutes expected; watch the per-partition lines
df -h / | tail -1                                      # free space after
```
Expected: the dry run exits 0; the apply ends with `is materialized on every partition`, the EXPLAIN line selects at most 10% of the granules, the index size is about 1.2 GiB, and free disk dips by no more than a few GiB. Stop and investigate on any non-zero exit.

- [x] **Step 6: Deploy `app` only**

```bash
export DOCKER_CONFIG=/tmp/claude-1000/-home-cole-ulp-suite/396dc453-5b14-4986-b7f4-a8869a04bbb3/scratchpad/dockercfg
docker tag ulp-suite-app:address-candidate ulp-suite-app:latest
docker compose -p ulp-suite -f /home/cole/ulp-suite/docker-compose.yml --project-directory /home/cole/ulp-suite --env-file /home/cole/ulp-suite/.env up -d --no-deps app
```
Expected: the app container is recreated (about 30 s); `docker logs ulpsuite_app 2>&1 | grep -E "DDL v29|DDL now at"` shows `DDL v29 applied` and `DDL now at v29`; `docker inspect ulpsuite_app --format '{{.State.Health.Status}} {{.RestartCount}}'` reads `healthy 0`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login` reads 200; the container env still has `CONTENT_DEDUP_APPLY=false`.

- [x] **Step 7: Live parity and timing (read-only)**

```bash
LSP_PARITY=1 npx vitest run __tests__/login-scope-parity.live.test.ts 2>&1 | tail -25
```
Expected: all tests pass, including `a full address finds every stored casing, exactly the complete answer, through the index` (each lookup under 3 s, the EXPLAIN selects at most 10% of the granules).

- [x] **Step 8: Record it**

Set the spec's status line to `implemented and deployed locally on 2026-10-13` with the commit, image id and rollback tag; add the plan's boxes as ticked; commit and push the docs (`docs(address): ...`). Update the memory notes (`project_search_levers_measured_2026_10_13.md`, the ledger) with what shipped, the live numbers and the follow-ups (search levers A and B, the owner trying the address lookups in the browser).
