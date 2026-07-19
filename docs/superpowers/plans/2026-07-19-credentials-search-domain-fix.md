# Credentials Search: Missing Indexes & Domain-Shaped Query Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix credential search so dotted/domain-shaped terms (e.g. "ledger.com") are fast and accurate, by adding the search index that was never successfully created, resizing the one that exists but doesn't prune anything, and routing domain-shaped queries at the columns actually built for site lookup.

**Architecture:** One shared TypeScript module defines the 5 ClickHouse skip indexes credential search depends on; both the versioned migration runner (existing table) and the content-dedup rewrite+swap (future clone tables) apply that same definition, so they can't drift apart. `lib/ulp-search.ts` gets a new `'domain'` token classification that queries `domain`/`url_host`/`email_domain` directly instead of the separator-character-intolerant `hasToken()`.

**Tech Stack:** TypeScript, Next.js, ClickHouse 26.3.17.4, vitest.

## Global Constraints

- ClickHouse version is 26.3.17.4 — `text()` index type syntax (`tokenizer = splitByNonAlpha`), not the removed `full_text(0)`.
- Match each file's own existing import convention: `lib/clickhouse-migrations.ts` uses relative imports (`./foo`); `lib/content-dedup.ts` and `__tests__/*.test.ts` use the `@/lib/foo` alias.
- Any new ClickHouse DDL must be verified against a disposable clone table first (never run untested `ALTER TABLE` against the live `ulp.credentials`, which has 562M+ rows) — this is an established, non-negotiable practice in this codebase (see `scripts/dedup-credentials-content.sh` and every recent `docs/superpowers/specs/*content-dedup*` doc).
- Test runner: `npm test` (`vitest run`). Run a single file with `npx vitest run <path>`.
- Full background and every verified number/finding this plan's decisions rest on: `docs/superpowers/specs/2026-07-19-credentials-search-domain-fix-design.md`.

---

### Task 1: Shared search-index definitions module

**Files:**
- Create: `lib/search-index-definitions.ts`
- Test: `__tests__/search-index-definitions.test.ts`

**Interfaces:**
- Produces: `SearchIndexDefinition` interface (`name: string`, `dropIndexSql: (table: string) => string`, `addIndexSql: (table: string) => string`), and `SEARCH_INDEX_DEFINITIONS: SearchIndexDefinition[]` (5 entries: `idx_inv_url`, `idx_inv_email`, `idx_inv_password`, `idx_ngram_url_host`, `idx_ngram_email_domain`). Task 2 and Task 4 both import `SEARCH_INDEX_DEFINITIONS`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/search-index-definitions.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { SEARCH_INDEX_DEFINITIONS } from '@/lib/search-index-definitions'

describe('SEARCH_INDEX_DEFINITIONS', () => {
  test('has exactly the 5 indexes search depends on, in a stable order', () => {
    const names = SEARCH_INDEX_DEFINITIONS.map(d => d.name)
    expect(names).toEqual([
      'idx_inv_url',
      'idx_inv_email',
      'idx_inv_password',
      'idx_ngram_url_host',
      'idx_ngram_email_domain',
    ])
  })

  test('idx_inv_* use the text() type with splitByNonAlpha, on their matching column', () => {
    const byName = Object.fromEntries(SEARCH_INDEX_DEFINITIONS.map(d => [d.name, d]))
    expect(byName['idx_inv_url'].addIndexSql('ulp.credentials'))
      .toContain('url TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(url))')
    expect(byName['idx_inv_email'].addIndexSql('ulp.credentials'))
      .toContain('email TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(email))')
    expect(byName['idx_inv_password'].addIndexSql('ulp.credentials'))
      .toContain('password TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(password))')
  })

  test('idx_ngram_* use the resized ngrambf_v1(4, 8192, 4, 0), not the old (4, 1024, 1, 0)', () => {
    const byName = Object.fromEntries(SEARCH_INDEX_DEFINITIONS.map(d => [d.name, d]))
    expect(byName['idx_ngram_url_host'].addIndexSql('ulp.credentials'))
      .toContain('url_host TYPE ngrambf_v1(4, 8192, 4, 0)')
    expect(byName['idx_ngram_email_domain'].addIndexSql('ulp.credentials'))
      .toContain('email_domain TYPE ngrambf_v1(4, 8192, 4, 0)')
  })

  test('every dropIndexSql uses IF EXISTS and every addIndexSql uses IF NOT EXISTS (safe to re-run)', () => {
    for (const def of SEARCH_INDEX_DEFINITIONS) {
      expect(def.dropIndexSql('ulp.credentials')).toContain('DROP INDEX IF EXISTS')
      expect(def.addIndexSql('ulp.credentials')).toContain('ADD INDEX IF NOT EXISTS')
    }
  })

  test('both dropIndexSql and addIndexSql parameterize by table name, for use against a swap clone', () => {
    const def = SEARCH_INDEX_DEFINITIONS.find(d => d.name === 'idx_inv_url')!
    expect(def.dropIndexSql('ulp.credentials_cdedup_auto'))
      .toBe('ALTER TABLE ulp.credentials_cdedup_auto DROP INDEX IF EXISTS idx_inv_url')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/search-index-definitions.test.ts`
Expected: FAIL — `Cannot find module '@/lib/search-index-definitions'`

- [ ] **Step 3: Write the implementation**

Create `lib/search-index-definitions.ts`:

```ts
/**
 * Single source of truth for the ClickHouse skip indexes credential search
 * depends on. Two independent callers need the exact same DDL:
 *  - lib/clickhouse-migrations.ts (DDL v17): applies these to the live,
 *    already-populated ulp.credentials table, with MATERIALIZE INDEX to
 *    backfill existing parts.
 *  - lib/content-dedup.ts: applies these to a freshly-created, still-empty
 *    rewrite+swap clone table BEFORE it's populated, so the indexes are
 *    built for free as rows are written (no MATERIALIZE needed) -- and so a
 *    future swap can never silently carry forward a search-index gap.
 * Keeping one definition list (rather than two copies of the same DDL)
 * means the two callers can't drift out of sync as indexes change over time.
 *
 * See docs/superpowers/specs/2026-07-19-credentials-search-domain-fix-design.md
 * for why each index exists and how its parameters were chosen.
 */

export interface SearchIndexDefinition {
  /** Index name, matching the name used in the CREATE/ALTER TABLE statement. */
  name: string
  /**
   * DROP INDEX IF EXISTS -- always run before addIndexSql. Harmless no-op on
   * a table where the index doesn't exist yet (a fresh swap clone); required
   * on one where it exists with stale parameters (ADD INDEX IF NOT EXISTS
   * alone would no-op on a name match, even if the TYPE(...) params differ).
   */
  dropIndexSql: (table: string) => string
  /** ADD INDEX IF NOT EXISTS with the current, correct definition. */
  addIndexSql: (table: string) => string
}

export const SEARCH_INDEX_DEFINITIONS: SearchIndexDefinition[] = [
  {
    name: 'idx_inv_url',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_inv_url`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_inv_url
      url TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(url)) GRANULARITY 1`,
  },
  {
    name: 'idx_inv_email',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_inv_email`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_inv_email
      email TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(email)) GRANULARITY 1`,
  },
  {
    name: 'idx_inv_password',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_inv_password`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_inv_password
      password TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(password)) GRANULARITY 1`,
  },
  {
    name: 'idx_ngram_url_host',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_ngram_url_host`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_ngram_url_host
      url_host TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1`,
  },
  {
    name: 'idx_ngram_email_domain',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_ngram_email_domain`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_ngram_email_domain
      email_domain TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1`,
  },
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/search-index-definitions.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/search-index-definitions.ts __tests__/search-index-definitions.test.ts
git commit -m "feat(search): add shared search-index definitions module"
```

---

### Task 2: DDL v17 — apply the index fixes to the live table

**Files:**
- Modify: `lib/clickhouse-migrations.ts:6-11` (imports), `:118` (`DDL_VERSION`), `:705-720` (new version block)

**Interfaces:**
- Consumes: `SEARCH_INDEX_DEFINITIONS` from Task 1 (`lib/search-index-definitions.ts`).
- Produces: nothing new consumed by later tasks — this task's effect is entirely on the live ClickHouse schema via the existing `runClickHouseMigrations()` mechanism.

There is no existing unit-test file for `lib/clickhouse-migrations.ts` (it's DDL-orchestration code with real side effects; this codebase's established pattern is to verify it via live `EXPLAIN`/`system.query_log` checks instead — see Task 5). This task has no vitest step; its verification is Task 5's disposable-clone check plus Task 6's live rollout check.

- [ ] **Step 1: Add the import**

In `lib/clickhouse-migrations.ts`, find:

```ts
import { getClient } from './clickhouse'
import { buildCountryTierExpression } from './country-tiers'
import { buildLoginTypeExpression } from './login-type'
import { buildFreeWebmailInClause } from './webmail-providers'
import { NOISE_EXPR } from './ulp-noise'
import { dbGet, dbRun } from './sqlite'
```

Replace with:

```ts
import { getClient } from './clickhouse'
import { buildCountryTierExpression } from './country-tiers'
import { buildLoginTypeExpression } from './login-type'
import { buildFreeWebmailInClause } from './webmail-providers'
import { NOISE_EXPR } from './ulp-noise'
import { dbGet, dbRun } from './sqlite'
import { SEARCH_INDEX_DEFINITIONS } from './search-index-definitions'
```

- [ ] **Step 2: Document v17 and bump DDL_VERSION**

Find:

```ts
//     exempt). Same MODIFY COLUMN + MATERIALIZE COLUMN pattern as v12/v13/v15.
const DDL_VERSION = 16
```

Replace with:

```ts
//     exempt). Same MODIFY COLUMN + MATERIALIZE COLUMN pattern as v12/v13/v15.
// v17 — two independent fixes to the search-box index infrastructure, found via
//     live investigation of why credential search performance/recall didn't match
//     the code's own assumptions (full write-up:
//     docs/superpowers/specs/2026-07-19-credentials-search-domain-fix-design.md):
//
//     (a) idx_inv_url / idx_inv_email / idx_inv_password — the text() indexes meant
//         to accelerate hasToken() (intended by v6/v7) were never successfully
//         applied to this table. system.query_log shows exactly one historical
//         attempt, and it used v5's broken `full_text(0)` syntax (Code 80, Unknown
//         Index type) rather than v6/v7's corrected `text(tokenizer =
//         splitByNonAlpha, ...)` syntax — the corrected syntax had never actually
//         run against this table. Without it, hasToken() is an unindexed
//         full-column scan (confirmed live: 11+ seconds for a single term over
//         562M rows).
//
//     (b) idx_ngram_url_host / idx_ngram_email_domain — exist and are materialized
//         (added directly against clickhouse-client on 2026-07-09, outside this
//         migration runner — ch_ddl_version was already at 16 by then, so the
//         version gate never re-fired v9 to do it), but EXPLAIN indexes=1 shows 0 of
//         8833 granules pruned for a real search term even with the index fully
//         built: ngrambf_v1(4, 1024, 1, 0) — an 8192-bit filter with 1 hash function
//         — is undersized for this table's real cardinality (34M+ distinct
//         url_host values) and saturates to a near-100% false-positive rate.
//         ngrambf_v1 can't be resized in place; DROP + re-ADD with a larger filter
//         (8192 bytes, 4 hash functions) is required. Confirmed live: strictly more
//         pruning than the old size, and bloom filters can't produce false
//         negatives by construction.
//
//     Both changes pull their exact DDL from lib/search-index-definitions.ts, the
//     single source of truth shared with lib/content-dedup.ts's rewrite+swap clone
//     (see that file for why: a swap clones the live table's DDL as-is, so a
//     future swap could otherwise silently carry forward a search-index gap the
//     same way this one did).
const DDL_VERSION = 17
```

- [ ] **Step 3: Add the v17 migration block**

Find:

```ts
  if (lastDdl < 16) {
    await runMigration(
      `ALTER TABLE ulp.credentials MODIFY COLUMN is_noise UInt8 MATERIALIZED toUInt8(${NOISE_EXPR})`,
      `ALTER TABLE ulp.credentials MATERIALIZE COLUMN is_noise`
    )
    console.warn('[ClickHouse migration] DDL v16 applied (broadened is_noise blank-domain check — MATERIALIZE running in background)')
  }

  if (lastDdl < DDL_VERSION) {
```

Replace with:

```ts
  if (lastDdl < 16) {
    await runMigration(
      `ALTER TABLE ulp.credentials MODIFY COLUMN is_noise UInt8 MATERIALIZED toUInt8(${NOISE_EXPR})`,
      `ALTER TABLE ulp.credentials MATERIALIZE COLUMN is_noise`
    )
    console.warn('[ClickHouse migration] DDL v16 applied (broadened is_noise blank-domain check — MATERIALIZE running in background)')
  }

  // v17 — see the DDL_VERSION comment above for the full investigation. Drop-then-add
  // every definition (not just the ngram ones) so this block is correct whether an
  // index is missing entirely, present with stale parameters, or already correct --
  // DROP INDEX IF EXISTS is a harmless no-op in the last case.
  if (lastDdl < 17) {
    for (const def of SEARCH_INDEX_DEFINITIONS) {
      await runMigration(def.dropIndexSql('ulp.credentials'))
      await runMigration(
        def.addIndexSql('ulp.credentials'),
        `ALTER TABLE ulp.credentials MATERIALIZE INDEX ${def.name}`,
      )
    }
    console.warn('[ClickHouse migration] DDL v17 applied (hasToken text indexes added; ngram bloom filters resized — MATERIALIZE running in background)')
  }

  if (lastDdl < DDL_VERSION) {
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors referencing `lib/clickhouse-migrations.ts` or `lib/search-index-definitions.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/clickhouse-migrations.ts
git commit -m "fix(clickhouse): DDL v17 -- add missing hasToken index, resize ngram bloom filters"
```

---

### Task 3: Domain-shaped search classification and query building

**Files:**
- Modify: `lib/ulp-search.ts:1-35` (doc comment), `:37-43` (`ParsedToken`), `:71-77` (`parseULPQuery`), `:107-140` (`buildULPWhere`)
- Test: `__tests__/ulp-search.test.ts`

**Interfaces:**
- Produces: `ParsedToken.type` gains `'domain'` as a valid value. `buildULPWhere` handles it. No other file imports these internals directly (only `parseULPQuery`/`buildULPWhere`/`buildULPWhereRegex`, whose signatures are unchanged), so no other production file needs changes.

- [ ] **Step 1: Write the failing tests**

In `__tests__/ulp-search.test.ts`, find this test (inside `describe('parseULPQuery — token type detection', ...)`):

```ts
  test('word with dot → type: like', () => {
    const tokens = parseULPQuery('pass.word')
    expect(tokens[0].type).toBe('like')
  })
```

Replace with:

```ts
  test('two-label dotted word → type: domain (not like)', () => {
    // "pass.word" fits the domain shape (word.word) even though it isn't a real
    // TLD -- the classifier recognizes the shape, it doesn't validate TLDs.
    const tokens = parseULPQuery('pass.word')
    expect(tokens[0].type).toBe('domain')
  })

  test('dotted word with a path segment → type: like (unchanged)', () => {
    const tokens = parseULPQuery('pass.word/path')
    expect(tokens[0].type).toBe('like')
  })
```

Then, immediately after the `describe('parseULPQuery — token type detection', ...)` block's closing `})` (before the `§ 2 parseULPQuery — negation` section comment), add a new describe block:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// § 1b  parseULPQuery — domain-shaped token type detection
// ─────────────────────────────────────────────────────────────────────────────

describe('parseULPQuery — domain-shaped token type detection', () => {
  test('two-label domain → type: domain', () => {
    const tokens = parseULPQuery('ledger.com')
    expect(tokens[0].type).toBe('domain')
    expect(tokens[0].value).toBe('ledger.com')
  })

  test('another two-label domain → type: domain', () => {
    const tokens = parseULPQuery('trezor.io')
    expect(tokens[0].type).toBe('domain')
  })

  test('three-label domain (subdomain) → type: domain', () => {
    const tokens = parseULPQuery('mail.google.com')
    expect(tokens[0].type).toBe('domain')
  })

  test('IP address → type: domain (intentional; the domain branch never calls hasToken(), so there is no separator-character error risk)', () => {
    const tokens = parseULPQuery('192.168.1.1')
    expect(tokens[0].type).toBe('domain')
  })

  test('trailing dot → type: like (not domain)', () => {
    const tokens = parseULPQuery('ledger.')
    expect(tokens[0].type).toBe('like')
  })

  test('leading dot → type: like (not domain)', () => {
    const tokens = parseULPQuery('.com')
    expect(tokens[0].type).toBe('like')
  })

  test('double dot (empty label) → type: like (not domain)', () => {
    const tokens = parseULPQuery('ledger..com')
    expect(tokens[0].type).toBe('like')
  })

  test('domain with a path → type: like (not domain)', () => {
    const tokens = parseULPQuery('ledger.com/login')
    expect(tokens[0].type).toBe('like')
  })

  test('domain with a space → type: like (not domain)', () => {
    const tokens = parseULPQuery('ledger .com')
    expect(tokens[0].type).toBe('like')
  })
})
```

Then, immediately after the `describe('buildULPWhere — token type SQL generation', ...)` block's closing `})` (before the `§ 7 buildULPWhere — negation` section comment), add:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// § 6b  buildULPWhere — domain type → SQL expression
// ─────────────────────────────────────────────────────────────────────────────

describe('buildULPWhere — domain type SQL generation', () => {
  test('domain type → exact match, subdomain suffix, url_host, and email_domain LIKE, OR-joined', () => {
    const tokens = parseULPQuery('ledger.com')
    const { clause } = buildULPWhere(tokens)
    expect(clause).toContain('domain =')
    expect(clause).toContain('domain LIKE')
    expect(clause).toContain('url_host LIKE')
    expect(clause).toContain('email_domain LIKE')
    expect(clause).not.toContain('hasToken')
  })

  test('domain type params: exact value, subdomain suffix pattern, substring pattern', () => {
    const tokens = parseULPQuery('ledger.com')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('ledger.com')
    expect(paramValues).toContain('%.ledger.com')
    expect(paramValues).toContain('%ledger.com%')
  })

  test('domain type lowercases the value', () => {
    const tokens = parseULPQuery('Ledger.COM')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('ledger.com')
    expect(paramValues.some(v => typeof v === 'string' && v.includes('Ledger'))).toBe(false)
  })

  test('domain type escapes underscores in the LIKE patterns', () => {
    const tokens = parseULPQuery('my_site.com')
    const { params } = buildULPWhere(tokens)
    const paramValues = Object.values(params)
    expect(paramValues).toContain('%my\\_site.com%')
  })

  test('negated domain term produces NOT (...)', () => {
    const tokens = parseULPQuery('-ledger.com')
    const { clause } = buildULPWhere(tokens)
    expect(clause).toMatch(/^NOT\s+\(/)
  })

  test('domain clause is valid ClickHouse parameter syntax (no string literals)', () => {
    const tokens = parseULPQuery('ledger.com')
    const { clause } = buildULPWhere(tokens)
    const literalStrings = clause.match(/'[^']*'/g) ?? []
    expect(literalStrings).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/ulp-search.test.ts`
Expected: FAIL — the new/changed tests report `type` as `'like'` instead of `'domain'`, and the domain SQL-generation tests fail because the `'domain'` branch doesn't exist yet.

- [ ] **Step 3: Update the `ParsedToken` type**

In `lib/ulp-search.ts`, find:

```ts
interface ParsedToken {
  negate: boolean
  type: 'token' | 'email_full' | 'email_dom' | 'like'
  value: string
  /** For email_full and email_dom: the lowercased domain part after @ */
  emailDomain?: string
}
```

Replace with:

```ts
interface ParsedToken {
  negate: boolean
  type: 'token' | 'domain' | 'email_full' | 'email_dom' | 'like'
  value: string
  /** For email_full and email_dom: the lowercased domain part after @ */
  emailDomain?: string
}
```

- [ ] **Step 4: Update `parseULPQuery`'s classification**

Find:

```ts
      // Pure word token (alphanumeric + hyphen only) → hasToken()
      const isCleanToken = /^[\w-]+$/.test(value)
      return { negate, type: isCleanToken ? 'token' as const : 'like' as const, value }
    })
```

Replace with:

```ts
      // Pure word token (alphanumeric + hyphen only) → hasToken()
      const isCleanToken = /^[\w-]+$/.test(value)
      if (isCleanToken) return { negate, type: 'token' as const, value }

      // Domain-shaped: two or more dot-separated labels (word chars/hyphens only)
      // → domain/host matching (see buildULPWhere's 'domain' branch for why this
      // is NOT routed through hasToken() -- it throws on any needle containing a
      // separator character, dots included). IP-shaped values like 192.168.1.1
      // also match this pattern and are intentionally included: domain =
      // '192.168.1.1' is a correct, useful lookup for IP-hosted credentials, and
      // this branch never touches hasToken() so there's no separator-character
      // error risk either way.
      const isDomainShaped = /^[\w-]+(\.[\w-]+)+$/.test(value)
      if (isDomainShaped) return { negate, type: 'domain' as const, value }

      return { negate, type: 'like' as const, value }
    })
```

- [ ] **Step 5: Add the `'domain'` branch to `buildULPWhere`**

Find:

```ts
      match = `(hasToken(url, {${p}:String}) OR hasToken(email, {${p}:String}) OR hasToken(password, {${p}:String}) OR url_host LIKE {${lp}:String} OR email_domain LIKE {${lp}:String})`

    } else {
      // LIKE fallback for tokens with special characters (no skip index)
      const p = `lk${i}`
      params[p] = `%${token.value}%`
      match = `(url LIKE {${p}:String} OR email LIKE {${p}:String} OR password LIKE {${p}:String})`
    }
```

Replace with:

```ts
      match = `(hasToken(url, {${p}:String}) OR hasToken(email, {${p}:String}) OR hasToken(password, {${p}:String}) OR url_host LIKE {${lp}:String} OR email_domain LIKE {${lp}:String})`

    } else if (token.type === 'domain') {
      // Domain-shaped (e.g. "ledger.com"): matches the canonical site column
      // directly rather than hasToken(), which throws (BAD_ARGUMENTS, "Needle
      // must not contain whitespace or separator characters" -- confirmed live)
      // on a needle containing a separator character. `domain = ` is
      // accelerated by the table's own primary key (domain is the leading
      // ORDER BY column) -- confirmed live: 11/8833 granules via binary search,
      // ~100ms. The LIKE '%.value' suffix condition is NOT a prefix condition
      // (leading wildcard), so it does not get that same acceleration, but
      // scanning the compact `domain` column alone is cheap regardless.
      // url_host / email_domain LIKE reuse the same ngrambf_v1-accelerated
      // mechanism as the 'token' branch above. '_' is escaped in the LIKE
      // patterns for the same reason as the 'token' branch.
      const lowerExact = token.value.toLowerCase()
      const lowerEscaped = lowerExact.replace(/_/g, '\\_')
      const ep = `dom${i}`
      const sp = `domsuf${i}`
      const lp2 = `domlk${i}`
      params[ep] = lowerExact
      params[sp] = `%.${lowerEscaped}`
      params[lp2] = `%${lowerEscaped}%`
      match = `(domain = {${ep}:String} OR domain LIKE {${sp}:String} OR url_host LIKE {${lp2}:String} OR email_domain LIKE {${lp2}:String})`

    } else {
      // LIKE fallback for tokens with special characters (no skip index)
      const p = `lk${i}`
      params[p] = `%${token.value}%`
      match = `(url LIKE {${p}:String} OR email LIKE {${p}:String} OR password LIKE {${p}:String})`
    }
```

(Note: `lp2`, not `lp` — the `'token'` branch above already declares a `const lp` in the same `forEach` callback scope; reusing the name would be a `SyntaxError: Identifier 'lp' has already been declared`.)

- [ ] **Step 6: Update the file's top doc comment**

Find:

```ts
 *                → email_domain LIKE '%' || lower(value) || '%'
 *                   Same logic for the email domain column (idx_ngram_email_domain).
 *
 *   email_full — full email e.g. john@gmail.com
```

Replace with:

```ts
 *                → email_domain LIKE '%' || lower(value) || '%'
 *                   Same logic for the email domain column (idx_ngram_email_domain).
 *
 *   domain     — 2+ dot-separated labels e.g. ledger.com, trezor.io, mail.google.com
 *                → domain = lower(value)
 *                   Exact site match. `domain` is the table's own leading ORDER BY
 *                   column, so this is accelerated by the primary key itself, not a
 *                   skip index (confirmed live: 11/8833 granules read via binary
 *                   search, ~100ms).
 *                → domain LIKE '%.' || lower(value)
 *                   Subdomains (beta.ledger.com). Not primary-key accelerated (the
 *                   leading wildcard defeats prefix binary search), but scanning the
 *                   compact `domain` column alone is cheap even unindexed.
 *                → url_host LIKE '%' || lower(value) || '%'
 *                   Compound/embedded matches (coinledger.io, or a phishing domain
 *                   that embeds the target string) — same ngrambf_v1-accelerated
 *                   mechanism as the token type's url_host clause above.
 *                → email_domain LIKE '%' || lower(value) || '%'
 *                   Credentials with a matching email domain.
 *                   Deliberately does NOT use hasToken(): it throws
 *                   (BAD_ARGUMENTS, "Needle must not contain whitespace or separator
 *                   characters") on any needle containing a separator character —
 *                   confirmed live — so a dotted value can never be passed to it.
 *
 *   email_full — full email e.g. john@gmail.com
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run __tests__/ulp-search.test.ts`
Expected: PASS (all tests, including the new/changed ones)

- [ ] **Step 8: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS (no other file imports `ParsedToken`'s internals or depends on the old dot-handling behavior)

- [ ] **Step 9: Commit**

```bash
git add lib/ulp-search.ts __tests__/ulp-search.test.ts
git commit -m "feat(search): classify dotted/domain-shaped terms and query domain/url_host/email_domain directly"
```

---

### Task 4: Content-dedup swap-safety

**Files:**
- Modify: `lib/content-dedup.ts:75-76` (imports), `:339` area (new step 4b + new function)
- Test: `__tests__/content-dedup.test.ts`

**Interfaces:**
- Consumes: `SEARCH_INDEX_DEFINITIONS` from Task 1, and this file's own existing `AUTO_DEDUP_TABLE` export.
- Produces: `buildEnsureSearchIndexesSql(): string[]`, called by `runContentDedupTick` between its existing steps 4 and 5.

- [ ] **Step 1: Write the failing test**

In `__tests__/content-dedup.test.ts`, find the import block:

```ts
import {
  CONTENT_KEY,
  buildStatsSql,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffSql,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
  buildPopulateDedupedTableSqlForBucket,
  buildVerifyDedupedTableSql,
  buildRenameSwapSql,
  buildCatchupInsertSql,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
```

Replace with:

```ts
import {
  CONTENT_KEY,
  buildStatsSql,
  AUTO_DEDUP_TABLE,
  AUTO_PREDUP_TABLE,
  CONTENT_DEDUP_SURVIVOR_ORDER,
  rewriteCreateTableDdl,
  buildCutoffSql,
  CONTENT_DEDUP_SORT_MAX_MEMORY_BYTES,
  CONTENT_DEDUP_MAX_THREADS,
  contentDedupBucketCount,
  buildPopulateDedupedTableSqlForBucket,
  buildEnsureSearchIndexesSql,
  buildVerifyDedupedTableSql,
  buildRenameSwapSql,
  buildCatchupInsertSql,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
import { SEARCH_INDEX_DEFINITIONS } from '@/lib/search-index-definitions'
```

Then, immediately after the `describe('buildPopulateDedupedTableSqlForBucket', ...)` block's closing `})` (before `describe('buildCutoffSql', ...)`), add:

```ts
  describe('buildEnsureSearchIndexesSql', () => {
    test('targets AUTO_DEDUP_TABLE (the still-empty clone), not the live table', () => {
      const stmts = buildEnsureSearchIndexesSql()
      expect(stmts.length).toBeGreaterThan(0)
      for (const stmt of stmts) {
        expect(stmt).toContain(AUTO_DEDUP_TABLE)
      }
    })

    test('emits a DROP then an ADD for every index in SEARCH_INDEX_DEFINITIONS', () => {
      const stmts = buildEnsureSearchIndexesSql()
      expect(stmts).toHaveLength(SEARCH_INDEX_DEFINITIONS.length * 2)
      for (const def of SEARCH_INDEX_DEFINITIONS) {
        expect(stmts).toContain(def.dropIndexSql(AUTO_DEDUP_TABLE))
        expect(stmts).toContain(def.addIndexSql(AUTO_DEDUP_TABLE))
      }
    })

    test('never includes MATERIALIZE INDEX (the clone is empty; the populate insert builds each index as it writes rows)', () => {
      const stmts = buildEnsureSearchIndexesSql()
      expect(stmts.every(s => !s.includes('MATERIALIZE'))).toBe(true)
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/content-dedup.test.ts`
Expected: FAIL — `buildEnsureSearchIndexesSql` is not exported from `@/lib/content-dedup`

- [ ] **Step 3: Add the import to `lib/content-dedup.ts`**

Find:

```ts
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
```

Replace with:

```ts
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
import { SEARCH_INDEX_DEFINITIONS } from '@/lib/search-index-definitions'
```

- [ ] **Step 4: Add `buildEnsureSearchIndexesSql`**

Find:

```ts
/** Atomic, metadata-only swap: the deduped copy becomes ulp.credentials; the original is archived under AUTO_PREDUP_TABLE. */
export function buildRenameSwapSql(): string {
```

Replace with:

```ts
/**
 * DDL to ensure AUTO_DEDUP_TABLE has the full search-index set BEFORE it's
 * populated. Run against the still-empty clone right after it's created (see
 * runContentDedupTick's step 4b) -- ADD INDEX on an empty table is
 * metadata-only, and the populate INSERT that follows computes each index as
 * it writes rows, so no MATERIALIZE backfill is ever needed here (contrast
 * lib/clickhouse-migrations.ts's DDL v17, which DOES need MATERIALIZE because
 * it applies to the live, already-populated table).
 *
 * Exists because a rewrite+swap clones the live table's DDL via `SHOW CREATE
 * TABLE` as-is (see rewriteCreateTableDdl) -- if the source table were ever
 * missing one of these indexes again, the swap would otherwise silently carry
 * that gap forward into the new live table with no automatic re-check. Pulls
 * from lib/search-index-definitions.ts, the same source DDL v17 uses, so the
 * two callers can't drift apart.
 */
export function buildEnsureSearchIndexesSql(): string[] {
  return SEARCH_INDEX_DEFINITIONS.flatMap(def => [
    def.dropIndexSql(AUTO_DEDUP_TABLE),
    def.addIndexSql(AUTO_DEDUP_TABLE),
  ])
}

/** Atomic, metadata-only swap: the deduped copy becomes ulp.credentials; the original is archived under AUTO_PREDUP_TABLE. */
export function buildRenameSwapSql(): string {
```

- [ ] **Step 5: Call it from `runContentDedupTick`, between steps 4 and 5**

Find:

```ts
    await client.exec({ query: rewriteCreateTableDdl(showCreateSql, AUTO_DEDUP_TABLE) })

    // 5. Populate, one bucket at a time -- see the file's POPULATE SCALE
```

Replace with:

```ts
    await client.exec({ query: rewriteCreateTableDdl(showCreateSql, AUTO_DEDUP_TABLE) })

    // 4b. Ensure the still-empty clone has the full search-index set before it's
    // populated (see buildEnsureSearchIndexesSql's comment for why this exists
    // and why it never needs MATERIALIZE here).
    for (const stmt of buildEnsureSearchIndexesSql()) {
      await client.exec({ query: stmt })
    }

    // 5. Populate, one bucket at a time -- see the file's POPULATE SCALE
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run __tests__/content-dedup.test.ts`
Expected: PASS (all tests)

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add lib/content-dedup.ts __tests__/content-dedup.test.ts
git commit -m "fix(content-dedup): ensure search indexes exist on the swap clone before populating"
```

---

### Task 5: Disposable-clone verification against real data

**Files:** none (verification only — no code changes; requires the `ulpsuite_clickhouse` container from `docker-compose.yml`)

**Interfaces:** none — this task validates Tasks 1-4's DDL against real production data before Task 6 applies it to the live table. If any expected result doesn't match, stop and fix the code before proceeding to Task 6.

- [ ] **Step 1: Create a scratch table with the new index definitions**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE IF EXISTS ulp.search_verify_test"
docker exec ulpsuite_clickhouse clickhouse-client --query "
CREATE TABLE ulp.search_verify_test (
  url String,
  url_host String,
  INDEX idx_inv_url url TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(url)) GRANULARITY 1,
  INDEX idx_ngram_url_host url_host TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1
) ENGINE = MergeTree ORDER BY tuple() SETTINGS index_granularity = 65536"
```

Expected: both commands complete with no error output.

- [ ] **Step 2: Populate with a real, long-tail-heavy sample**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.search_verify_test
SELECT url, url_host FROM ulp.credentials ORDER BY domain LIMIT 5000000 OFFSET 300000000
SETTINGS max_execution_time=120"
docker exec ulpsuite_clickhouse clickhouse-client --query "OPTIMIZE TABLE ulp.search_verify_test FINAL"
```

Expected: both commands complete with no error output (may take up to ~30s for the insert).

- [ ] **Step 3: Verify `hasToken()` is now correct with the index active**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM ulp.search_verify_test WHERE hasToken(url, 'ledger')"
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM ulp.search_verify_test WHERE hasToken(url, 'ledger') SETTINGS use_skip_indexes=0"
```

Expected: **both commands print the identical number.** The index-assisted result must match the forced-full-scan ground truth exactly — if they differ, the index definition is wrong. Do not proceed to Task 6 until they match.

- [ ] **Step 4: Verify the resized ngram index prunes**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
EXPLAIN indexes=1 SELECT count() FROM ulp.search_verify_test WHERE url_host LIKE '%ledger%'
FORMAT PrettyCompact" | grep -A3 "Name: idx_ngram_url_host"
```

Expected: a `Granules: X/77` line where X is less than 77 (some pruning occurs). This session measured 66/77 remaining at the *old* `(4,1024,1,0)` size vs. 46/66 at the *new* `(4,8192,4,0)` size on an equivalent sample — expect a similar improvement, not identical numbers (sample offset/table state may differ slightly).

- [ ] **Step 5: Clean up**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE IF EXISTS ulp.search_verify_test"
```

Expected: completes with no error output.

---

### Task 6: Deploy and live verification

**Files:** none (deployment only)

**Interfaces:** none — final task, confirms Tasks 1-5 work end-to-end against the real running app and live 562M+ row table.

- [ ] **Step 1: Run the full test suite one more time**

```bash
npm test
```

Expected: PASS, all files including `search-index-definitions.test.ts`, `ulp-search.test.ts`, `content-dedup.test.ts`.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Rebuild and restart the app container**

Migrations run automatically at server startup via `instrumentation.ts`'s `register()` hook (confirmed live: `grep -rn runClickHouseMigrations` shows the call site is `instrumentation.ts`, not just the upload route — the upload route's own call, per its comment, is now just a redundant safety net). ClickHouse itself doesn't need rebuilding, only the app:

```bash
docker compose build app
docker compose up -d app
```

Expected: container reports healthy within ~1 minute (`docker compose ps` shows `Up ... (healthy)`).

- [ ] **Step 4: Confirm DDL v17 applied**

```bash
docker compose logs app --since 3m | grep -i "ClickHouse migration"
```

Expected: a line reading `[ClickHouse migration] DDL v17 applied (hasToken text indexes added; ngram bloom filters resized — MATERIALIZE running in background)`.

- [ ] **Step 5: Confirm the live table has the new indexes**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SHOW CREATE TABLE ulp.credentials FORMAT TabSeparatedRaw" | grep -E "idx_inv_url|idx_inv_email|idx_inv_password|idx_ngram_url_host|idx_ngram_email_domain"
```

Expected: all 5 index names appear, with `idx_ngram_url_host`/`idx_ngram_email_domain` showing `ngrambf_v1(4, 8192, 4, 0)` (not the old `(4, 1024, 1, 0)`).

- [ ] **Step 6: Spot-check real searches directly against ClickHouse**

```bash
# Exact domain — should be fast and correct
time docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM ulp.credentials WHERE (domain = 'ledger.com' OR domain LIKE '%.ledger.com' OR url_host LIKE '%ledger.com%' OR email_domain LIKE '%ledger.com%')"

# Plain bare word (regression check — the existing, unchanged 'token' path)
time docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM ulp.credentials WHERE (hasToken(url, 'ledger') OR hasToken(email, 'ledger') OR hasToken(password, 'ledger') OR url_host LIKE '%ledger%' OR email_domain LIKE '%ledger%')"
```

Expected: both complete in well under the ~10s+ this session measured for the equivalent *unfixed* queries at the start of this investigation — note the exact time for your own records, since MATERIALIZE INDEX runs in the background and may still be catching up on some parts immediately after step 3, so times may keep improving for a few minutes after deploy.

- [ ] **Step 7: Confirm via the credentials browser UI**

Open `http://localhost:3000` in a browser, sign in, navigate to the credentials browser, and run a few searches: an exact domain from your own data (e.g. one of `ledger.com`, `trezor.io`, `safepal.com`), a subdomain if you know one exists, and a plain bare word. Confirm results appear, look correct, and the page doesn't show a "query timed out" error (the `timed_out` response field / UI message documented in `app/api/credentials/route.ts`'s catch block).

- [ ] **Step 8: Confirm swap-safety by exercising a rewrite+swap tick against a disposable clone**

The existing content-dedup design already establishes this exact pattern (`docs/superpowers/specs/2026-07-07-content-dedup-rewrite-swap-design.md`'s "Live rollout verification" section) — a small, uncommitted `tsx`-run script that imports `runContentDedupTick` directly and calls it once, with `CONTENT_DEDUP_APPLY` overridden to `'true'` only within that script's own process. Confirm the resulting new live table has all 5 search indexes (repeat Step 5's `SHOW CREATE TABLE` check) before considering swap-safety verified. Do not enable `CONTENT_DEDUP_APPLY=true` in the real `.env` as part of this check — that's a separate, later decision, unrelated to this fix.
