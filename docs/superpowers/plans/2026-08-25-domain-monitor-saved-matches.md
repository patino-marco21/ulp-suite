# Domain Monitor Saved Matches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live per-open ClickHouse query behind the monitor "View Matches" panel with a cron-populated SQLite cache plus a manual "Rescan now" escape hatch, and fix the two bugs that made the existing monitor unusable (malformed stored domains; a non-index-prunable predicate causing the rescan cron to silently time out every 15 minutes).

**Architecture:** A new ClickHouse ngram skip index (`idx_ngram_domain`) makes per-monitor domain-suffix matching index-prunable — see the 2026-08-25 correction note on Tasks 3–4 below; the original plan called for a reversed-domain projection, empirically disproven during execution. A shared resolver function (`resolveMonitorMatches`, extracted from the current live route) uses the fixed predicate. The existing rescan cron and a new "Rescan now" endpoint both call that resolver and write results into two new SQLite tables (`monitor_matches`, `monitor_rescan_status`); the "View Matches" panel's GET endpoint becomes a pure SQLite read.

**Tech Stack:** Next.js API routes, ClickHouse (`ALTER TABLE ... ADD PROJECTION`), better-sqlite3, Vitest.

## Global Constraints

- Spec: [docs/superpowers/specs/2026-08-24-domain-monitor-saved-matches-design.md](../specs/2026-08-24-domain-monitor-saved-matches-design.md) — every task below implements a section of it; re-read a section if a step here seems to contradict it.
- `monitor_matches` primary key is `(monitor_id, url, email, password)`, not `(monitor_id, url, email)` — a distinct password for the same url/email must not collapse.
- Timestamps written to `monitor_matches`/`monitor_rescan_status` MUST use SQL `datetime('now')`, never JS `Date.toISOString()` — `lib/format-relative-time.ts:7` parses the SQLite `"YYYY-MM-DD HH:MM:SS"` shape specifically and will silently produce `Invalid Date` on an ISO string with a `T`/`Z` already in it.
- The `email_domain` ClickHouse column is left untouched throughout — it already had the `ngrambf_v1` index that makes its `endsWith()` predicate fast (0.24s); Task 4 gives `domain` the same index type, not a different mechanism (see the correction note below).

---

### Task 1: SQLite cache schema

**Files:**
- Modify: `lib/sqlite.ts` (inside `initSchema`, alongside the existing `monitor_views` table)
- Test: `__tests__/monitor-matches-cache-schema.test.ts` (create)

**Interfaces:**
- Produces: tables `monitor_matches(monitor_id, url, email, password, domain, fetched_at)` and `monitor_rescan_status(monitor_id, status, error, attempted_at, last_success_at)`, both FK'd to `domain_monitors(id) ON DELETE CASCADE`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/monitor-matches-cache-schema.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpFiles: string[] = []
let originalSqlitePath: string | undefined

function freshDbPath(): string {
  const p = path.join(os.tmpdir(), `ulp-monitor-matches-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  tmpFiles.push(p)
  return p
}

async function loadAgainstFreshDb() {
  process.env.SQLITE_PATH = freshDbPath()
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  const { default: viMod } = { default: await import('vitest') }
  viMod.resetModules()
  return import('@/lib/sqlite')
}

beforeEach(() => {
  originalSqlitePath = process.env.SQLITE_PATH
})

afterEach(async () => {
  const db = (globalThis as unknown as { _sqliteDb?: { close(): void } })._sqliteDb
  if (db) db.close()
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  if (originalSqlitePath === undefined) delete process.env.SQLITE_PATH
  else process.env.SQLITE_PATH = originalSqlitePath
  for (const p of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true })
  }
  const { vi } = await import('vitest')
  vi.resetModules()
})

describe('monitor_matches / monitor_rescan_status schema', () => {
  test('both tables exist with the expected columns after initSchema runs', async () => {
    const { dbQuery } = await loadAgainstFreshDb()

    const matchesCols = (dbQuery(`PRAGMA table_info(monitor_matches)`) as Array<{ name: string }>).map(c => c.name)
    expect(matchesCols).toEqual(['monitor_id', 'url', 'email', 'password', 'domain', 'fetched_at'])

    const statusCols = (dbQuery(`PRAGMA table_info(monitor_rescan_status)`) as Array<{ name: string }>).map(c => c.name)
    expect(statusCols).toEqual(['monitor_id', 'status', 'error', 'attempted_at', 'last_success_at'])
  })

  test('monitor_matches allows two rows with the same (monitor_id, url, email) but different password', async () => {
    const { dbRun, dbQuery } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Test', '["aave.com"]')`)

    dbRun(`INSERT INTO monitor_matches (monitor_id, url, email, password, domain, fetched_at) VALUES (1, 'https://aave.com', 'u@aave.com', 'pw1', 'aave.com', datetime('now'))`)
    dbRun(`INSERT INTO monitor_matches (monitor_id, url, email, password, domain, fetched_at) VALUES (1, 'https://aave.com', 'u@aave.com', 'pw2', 'aave.com', datetime('now'))`)

    const rows = dbQuery(`SELECT password FROM monitor_matches WHERE monitor_id = 1 ORDER BY password`) as Array<{ password: string }>
    expect(rows.map(r => r.password)).toEqual(['pw1', 'pw2'])
  })

  test('deleting a monitor cascades to both new tables', async () => {
    const { dbRun, dbGet } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Test', '["aave.com"]')`)
    dbRun(`INSERT INTO monitor_matches (monitor_id, url, email, password, domain, fetched_at) VALUES (1, 'https://aave.com', 'u@aave.com', 'pw1', 'aave.com', datetime('now'))`)
    dbRun(`INSERT INTO monitor_rescan_status (monitor_id, status, error, attempted_at, last_success_at) VALUES (1, 'ok', NULL, datetime('now'), datetime('now'))`)

    dbRun(`DELETE FROM domain_monitors WHERE id = 1`)

    expect(dbGet(`SELECT * FROM monitor_matches WHERE monitor_id = 1`)).toBeUndefined()
    expect(dbGet(`SELECT * FROM monitor_rescan_status WHERE monitor_id = 1`)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/monitor-matches-cache-schema.test.ts`
Expected: FAIL — `monitor_matches`/`monitor_rescan_status` don't exist (`PRAGMA table_info` returns `[]`, so the first assertion fails).

- [ ] **Step 3: Add the tables to `initSchema`**

In `lib/sqlite.ts`, immediately after the existing `monitor_views` table's `CREATE TABLE` block (the one ending around line 170), add:

```sql
    CREATE TABLE IF NOT EXISTS monitor_matches (
      monitor_id  INTEGER NOT NULL,
      url         TEXT NOT NULL,
      email       TEXT NOT NULL,
      password    TEXT NOT NULL,
      domain      TEXT NOT NULL,
      fetched_at  TEXT NOT NULL,
      PRIMARY KEY (monitor_id, url, email, password),
      FOREIGN KEY (monitor_id) REFERENCES domain_monitors(id) ON DELETE CASCADE
    );

    -- Tracks the most recent rescan attempt per monitor, independent of
    -- domain_monitors.last_triggered_at (which only ever advances on
    -- success). last_success_at is separate from attempted_at so a monitor
    -- with zero genuine matches still has a timestamp to show — there are no
    -- monitor_matches rows to read one off in that case.
    CREATE TABLE IF NOT EXISTS monitor_rescan_status (
      monitor_id      INTEGER PRIMARY KEY,
      status          TEXT NOT NULL CHECK(status IN ('ok', 'failed')),
      error           TEXT,
      attempted_at    TEXT NOT NULL,
      last_success_at TEXT,
      FOREIGN KEY (monitor_id) REFERENCES domain_monitors(id) ON DELETE CASCADE
    );
```

(This must be inside the same `db.exec(...)` template literal the other `CREATE TABLE IF NOT EXISTS` statements are in, not a separate call — check the surrounding code to match.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/monitor-matches-cache-schema.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/sqlite.ts __tests__/monitor-matches-cache-schema.test.ts
git commit -m "feat(monitoring): add monitor_matches/monitor_rescan_status cache tables"
```

---

### Task 2: Domain normalization

**Files:**
- Modify: `lib/domain-match.ts` (add `normalizeDomainInput`)
- Modify: `app/api/monitoring/monitors/route.ts:87`
- Modify: `app/api/monitoring/monitors/[id]/route.ts:77`
- Modify: `lib/sqlite.ts` (startup fixup pass)
- Test: `__tests__/domain-match.test.ts` (extend), `__tests__/monitor-matches-cache-schema.test.ts` (extend, for the fixup pass)

**Interfaces:**
- Produces: `normalizeDomainInput(raw: string): string`, exported from `lib/domain-match.ts` — pure, no dependencies (matches this file's existing character; putting it in `lib/domain-monitor.ts` instead would create a circular import since `lib/sqlite.ts` needs to call it too, and `lib/domain-monitor.ts` already imports from `lib/sqlite.ts`).

- [ ] **Step 1: Write the failing test**

Add to `__tests__/domain-match.test.ts`:

```typescript
import { normalizeDomainInput } from '@/lib/domain-match'

describe('normalizeDomainInput', () => {
  test('strips a trailing slash', () => {
    expect(normalizeDomainInput('trezor.io/')).toBe('trezor.io')
  })

  test('strips a path after the domain', () => {
    expect(normalizeDomainInput('blockstream.com/jade/')).toBe('blockstream.com')
    expect(normalizeDomainInput('foundation.xyz/passport/')).toBe('foundation.xyz')
  })

  test('strips a leading https:// or http:// scheme', () => {
    expect(normalizeDomainInput('https://ledger.com')).toBe('ledger.com')
    expect(normalizeDomainInput('http://ledger.com')).toBe('ledger.com')
  })

  test('trims whitespace and lowercases', () => {
    expect(normalizeDomainInput('  Ledger.COM  ')).toBe('ledger.com')
  })

  test('is a no-op on an already-clean domain', () => {
    expect(normalizeDomainInput('coldcard.com')).toBe('coldcard.com')
  })

  test('handles scheme + path together', () => {
    expect(normalizeDomainInput('https://gridplus.io/some/path')).toBe('gridplus.io')
  })

  // The exact 17 values stored for the "Dedicated / general hardware
  // wallets" monitor as of 2026-08-24 — see the design doc's §"Problem".
  test('normalizes every real stored domain for the existing monitor', () => {
    const raw = [
      'bitbox.team/', 'bitkey.world/', 'blockstream.com/jade/', 'coldcard.com/',
      'cypherock.com/', 'dcentwallet.com/', 'ellipal.com/', 'foundation.xyz/passport/',
      'gridplus.io/', 'keepkey.com/', 'keyst.one/', 'ledger.com/', 'ngrave.io/',
      'onekey.so/', 'safepal.com/', 'tangem.com/', 'trezor.io/',
    ]
    const expected = [
      'bitbox.team', 'bitkey.world', 'blockstream.com', 'coldcard.com',
      'cypherock.com', 'dcentwallet.com', 'ellipal.com', 'foundation.xyz',
      'gridplus.io', 'keepkey.com', 'keyst.one', 'ledger.com', 'ngrave.io',
      'onekey.so', 'safepal.com', 'tangem.com', 'trezor.io',
    ]
    expect(raw.map(normalizeDomainInput)).toEqual(expected)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/domain-match.test.ts -t normalizeDomainInput`
Expected: FAIL with "normalizeDomainInput is not a function" / import error.

- [ ] **Step 3: Implement `normalizeDomainInput`**

Add to `lib/domain-match.ts`, near `domainSuffixChain` (both are small pure string-shape helpers):

```typescript
/**
 * Normalize a user-entered domain into the bare-hostname shape
 * ulp.credentials.domain/email_domain store, so domainMatches/SQL predicates
 * can ever compare equal. Strips a leading scheme and everything from the
 * first '/' onward — "https://trezor.io/" and "trezor.io/some/path" both
 * become "trezor.io". A stored value with an unstripped trailing slash or
 * path can never match anything: see the design doc's §"Problem".
 */
export function normalizeDomainInput(raw: string): string {
  let d = raw.trim().toLowerCase()
  d = d.replace(/^https?:\/\//, '')
  const slashIdx = d.indexOf('/')
  if (slashIdx !== -1) d = d.slice(0, slashIdx)
  return d.trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/domain-match.test.ts -t normalizeDomainInput`
Expected: PASS (7 tests)

- [ ] **Step 5: Wire it into both monitor routes**

In `app/api/monitoring/monitors/route.ts`, add the import and replace line 87:

```typescript
import { normalizeDomainInput } from "@/lib/domain-match"
```

```typescript
      domains: domains.map((d: string) => normalizeDomainInput(d)),
```

In `app/api/monitoring/monitors/[id]/route.ts`, add the same import and replace line 77:

```typescript
      updates.domains = body.domains.map((d: string) => normalizeDomainInput(d))
```

- [ ] **Step 6: Write the failing test for the startup fixup pass**

Add to `__tests__/monitor-matches-cache-schema.test.ts`:

```typescript
describe('startup domain normalization fixup', () => {
  test('re-normalizes a previously-stored monitor whose domains have trailing slashes', async () => {
    process.env.SQLITE_PATH = freshDbPath()
    ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
    const { vi } = await import('vitest')
    vi.resetModules()

    // First load: insert a monitor the way the OLD (buggy) route code would
    // have — trailing slashes intact — bypassing normalizeDomainInput
    // entirely, simulating data written before this fix existed.
    const sqlite1 = await import('@/lib/sqlite')
    sqlite1.dbRun(
      `INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', ?)`,
      [JSON.stringify(['trezor.io/', 'ledger.com/'])]
    )
    const db1 = (globalThis as unknown as { _sqliteDb?: { close(): void } })._sqliteDb
    if (db1) db1.close()
    ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
    vi.resetModules()

    // Second load re-runs initSchema (and the fixup pass) against the same
    // file, the way a real process restart would.
    const sqlite2 = await import('@/lib/sqlite')
    const row = sqlite2.dbGet(`SELECT domains FROM domain_monitors WHERE id = 1`) as { domains: string }
    expect(JSON.parse(row.domains)).toEqual(['trezor.io', 'ledger.com'])
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run __tests__/monitor-matches-cache-schema.test.ts -t "startup domain normalization"`
Expected: FAIL — domains still `['trezor.io/', 'ledger.com/']`.

- [ ] **Step 8: Implement the fixup pass**

In `lib/sqlite.ts`, add the import at the top:

```typescript
import { normalizeDomainInput } from '@/lib/domain-match'
```

Add this right after the existing `rescan_mode`/`rescan_interval_hours` `ALTER TABLE` try/catch block (around line 274), inside the same function `initSchema` runs in:

```typescript
  // One-time-in-effect, idempotent: re-normalize any monitor domains stored
  // before normalizeDomainInput existed (trailing slash/path/scheme). No-op
  // once a monitor's domains are already normalized — safe to run every
  // startup, matches this file's existing un-gated-idempotent-ALTER style.
  {
    const monitorRows = db.prepare(`SELECT id, domains FROM domain_monitors`).all() as Array<{ id: number; domains: string }>
    for (const row of monitorRows) {
      let domains: string[]
      try { domains = JSON.parse(row.domains) } catch { continue }
      const normalized = domains.map(normalizeDomainInput)
      if (JSON.stringify(normalized) !== JSON.stringify(domains)) {
        db.prepare(`UPDATE domain_monitors SET domains = ? WHERE id = ?`).run(JSON.stringify(normalized), row.id)
      }
    }
  }
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run __tests__/monitor-matches-cache-schema.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 10: Run the full existing monitor-routes test suite to check for regressions**

Run: `npx vitest run __tests__/domain-monitor.test.ts`
Expected: PASS (no existing test asserts the raw `.trim().toLowerCase()` behavior in a way `normalizeDomainInput` would break — it's a strict superset of that normalization)

- [ ] **Step 11: Commit**

```bash
git add lib/domain-match.ts lib/sqlite.ts app/api/monitoring/monitors/route.ts app/api/monitoring/monitors/[id]/route.ts __tests__/domain-match.test.ts __tests__/monitor-matches-cache-schema.test.ts
git commit -m "fix(monitoring): normalize monitor domains (strip scheme/path/slash), fix up existing rows"
```

---

### Task 3: Reversed-domain predicate

> **⚠️ SUPERSEDED (2026-08-25), during Task 4's execution.** The reversed-prefix
> predicate below was implemented and reviewed as written, but the ClickHouse
> mechanism it depends on (Task 4's projection) turned out not to work — see the
> correction note on Task 4. The fix that actually works (an `ngrambf_v1` index on
> `domain`) needs no predicate change at all: `buildCandidateColumnWhereClause` was
> reverted to its original `endsWith(domain, ...)` form, identical in shape to the
> `email_domain` branch. Everything below this point in Task 3 describes work that
> was done and then undone — kept for the historical record (and because the
> false-positive regression test it introduced, adapted to check the dot-boundary
> on the reverted code, is still real coverage — see
> `__tests__/domain-match.test.ts`'s `buildCandidateColumnWhereClause` describe
> block for the current version). Do not redo this task's steps.

**Files:**
- Modify: `lib/domain-match.ts:240-254` (`buildCandidateColumnWhereClause`)
- Test: `__tests__/domain-match.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildCandidateColumnWhereClause` unchanged signature, changed SQL shape for `column === 'domain'` only.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/domain-match.test.ts`:

```typescript
describe('buildCandidateColumnWhereClause — domain column uses reversed-prefix matching', () => {
  test('domain column: emits startsWith(reverse(domain), ...) instead of endsWith(domain, ...)', () => {
    const { clause, params } = buildCandidateColumnWhereClause('domain', ['trezor.io'])
    expect(clause).toContain('startsWith(reverse(domain)')
    expect(clause).not.toContain('endsWith(domain')
    // reverse('.trezor.io') = 'oi.rozert.'
    expect(Object.values(params)).toContain('oi.rozert.')
  })

  test('domain column: keeps the cheap exact-equality branch alongside the reversed suffix branch', () => {
    const { clause, params } = buildCandidateColumnWhereClause('domain', ['trezor.io'])
    expect(clause).toContain('domain = {domainEq0:String}')
    expect(params.domainEq0).toBe('trezor.io')
  })

  test('email_domain column is unchanged (already fast via its ngram index — see design doc §1)', () => {
    const { clause } = buildCandidateColumnWhereClause('email_domain', ['trezor.io'])
    expect(clause).toContain('endsWith(email_domain')
    expect(clause).not.toContain('reverse(')
  })

  test('regression: the reversed predicate must not false-match a domain that merely ends with the same letters', () => {
    // eviltrezor.io must NOT be treated as a subdomain of trezor.io. Prove it
    // the same way the SQL will be evaluated: build both sides' reversed
    // strings and check the JS equivalent of startsWith(reverse(x), reverse(y)).
    const { params } = buildCandidateColumnWhereClause('domain', ['trezor.io'])
    const reversedSuffix = Object.values(params).find(v => typeof v === 'string' && v.startsWith('oi.'))
    const reverseStr = (s: string) => s.split('').reverse().join('')
    expect(reverseStr('eviltrezor.io').startsWith(reversedSuffix as string)).toBe(false)
    expect(reverseStr('mail.trezor.io').startsWith(reversedSuffix as string)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/domain-match.test.ts -t "reversed-prefix"`
Expected: FAIL — current clause contains `endsWith(domain`, not `startsWith(reverse(domain)`.

- [ ] **Step 3: Implement the predicate change**

Replace `buildCandidateColumnWhereClause` in `lib/domain-match.ts:240-254` with:

```typescript
function reverseString(s: string): string {
  return s.split('').reverse().join('')
}

/**
 * Phase 1: which values of ONE raw stored column could belong to a row
 * matching this domain set. Same domain-or-subdomain semantics as
 * domainConditionSQL, but evaluated against a bare column rather than
 * NORM_DOMAIN_EXPR/NORM_EMAIL_EXPR, so ClickHouse reads only that one column
 * instead of the whole (url, email, password) row.
 *
 * The `domain` column additionally rewrites the suffix half as
 * startsWith(reverse(domain), reverse(suffix)) instead of
 * endsWith(domain, suffix) — semantically identical (a prefix match on the
 * reversed string IS a suffix match on the original), but prunable by
 * proj_domain_reversed (lib/clickhouse-migrations.ts DDL v19), where the
 * forward endsWith() form is prunable by no index at all: EXPLAIN indexes=1
 * showed 37350/37350 granules either way (see the design doc §1 and
 * app/api/monitoring/monitors/[id]/matches/route.ts's doc comment for the
 * measured numbers this replaces). email_domain is left as endsWith() —
 * measured already fast (0.24s) via its existing ngram index.
 */
export function buildCandidateColumnWhereClause(
  column: CandidateColumn,
  domains: string[],
): { clause: string; params: Record<string, string> } {
  const params: Record<string, string> = {}
  const parts = domains.map((domain, i) => {
    const d = domain.toLowerCase().trim()
    const eqParam = `${column}Eq${i}`
    params[eqParam] = d
    if (column === 'domain') {
      const suffixParam = `${column}SuffixRev${i}`
      params[suffixParam] = reverseString(`.${d}`)
      return `(${column} = {${eqParam}:String} OR startsWith(reverse(${column}), {${suffixParam}:String}))`
    }
    const suffixParam = `${column}Suffix${i}`
    params[suffixParam] = `.${d}`
    return `(${column} = {${eqParam}:String} OR endsWith(${column}, {${suffixParam}:String}))`
  })
  return { clause: parts.length ? `(${parts.join(' OR ')})` : '0', params }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/domain-match.test.ts`
Expected: PASS (all tests in the file, including the pre-existing `buildCandidateColumnWhereClause`/`buildCandidateValueBranches` coverage — the `email_domain` behavior and `buildCandidateValueBranches`' consumption of the returned `params`/`clause` shape are both unaffected by this change)

- [ ] **Step 5: Commit**

```bash
git add lib/domain-match.ts __tests__/domain-match.test.ts
git commit -m "perf(monitor-matches): make the domain-column candidate scan reversed-prefix, not endsWith"
```

---

### Task 4: ClickHouse index migration (`idx_ngram_domain`)

> **What actually shipped, and why it differs from the original plan
> (2026-08-25):** this task originally called for the projection described in
> Steps 1-6 further below in this history (kept for the record, not for
> execution). Two approaches were tried and empirically disproven against the
> live 2.4B-row table before landing on the real fix — full account in the
> design doc §1. Summary: a projection ordered by `reverse(domain)` is never
> selected by ClickHouse's planner for this predicate shape (confirmed via
> `force_optimize_projection`, which raised `PROJECTION_NOT_USED`); a
> `domain_reversed` materialized column + `minmax` index on it *is* selected,
> but only prunes ~35% of granules on the real table (vs. 24/25 on a
> favorably-ordered scratch table) because `minmax` needs the indexed value to
> correlate with physical storage order, and a reversed string doesn't
> correlate with forward-domain sort order. **The fix that actually works:** an
> `ngrambf_v1` skip index on `domain` — the same index type/parameters
> `email_domain` already had, which is what made *its* `endsWith()` predicate
> fast all along (0.24s) while `domain`'s plain `bloom_filter` index couldn't
> help at all (bloom filters only accelerate equality). No predicate rewrite
> needed; the original `domain = {d} OR endsWith(domain, {'.'+d})` shape is
> unchanged — only a second index is added.

**Files:**
- Modify: `lib/clickhouse-migrations.ts` (bump `DDL_VERSION`, add v19 block)

**Interfaces:**
- Produces: ClickHouse index `idx_ngram_domain` on `ulp.credentials.domain`, `ngrambf_v1(4, 8192, 4, 0)` — same type/params as the existing `idx_ngram_email_domain`.

- [ ] **Step 1: Bump the version constant**

In `lib/clickhouse-migrations.ts:159`, change:

```typescript
const DDL_VERSION = 19
```

- [ ] **Step 2: Add the v19 migration block**

Immediately after the existing `if (lastDdl < 18) { ... }` block, add:

```typescript
  // v19 — idx_ngram_domain: an ngram skip index on `domain`, same type/params
  // as the existing idx_ngram_email_domain. Makes the phase-1 candidate scan
  // in lib/domain-match.ts's buildCandidateColumnWhereClause prunable for the
  // `domain` column: endsWith(domain, '.x') is prunable by no index on this
  // table today (idx_bf_domain, a plain bloom_filter, originally measured
  // 37350->37350 granules for this predicate before this index existed —
  // bloom filters only help equality). `email_domain` already had this exact
  // problem solved: it
  // carries both a bloom_filter AND an ngrambf_v1 index, and the ngram one is
  // what actually prunes its endsWith() predicate (measured 0.24s). This
  // gives `domain` the same second index `email_domain` already had.
  //
  // This DDL_VERSION went through two other approaches first, both empirically
  // disproven against this table on 2026-08-25 — see
  // docs/superpowers/specs/2026-08-24-domain-monitor-saved-matches-design.md §1
  // for the full history: (1) a PROJECTION ordered by reverse(domain), never
  // selected by the planner for this predicate shape even forced; (2) a
  // materialized domain_reversed column + minmax index, which the planner
  // does select but which only prunes ~35% of granules on this table because
  // minmax needs the indexed value to correlate with physical row order, and
  // a reversed string doesn't correlate with this table's forward-domain sort
  // order. ngram indexes don't have that ordering dependency (they hash
  // per-granule content), which is why this predicate prunes well on both
  // columns once each has one.
  if (lastDdl < 19) {
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_ngram_domain domain TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_ngram_domain`
    )
    console.warn('[ClickHouse migration] DDL v19 applied (added idx_ngram_domain — MATERIALIZE running in background)')
  }
```

- [ ] **Step 3: Rebuild and redeploy the app container so the migration actually runs**

```bash
docker compose -f /home/cole/ulp-suite/docker-compose.yml --project-directory /home/cole/ulp-suite --env-file /home/cole/ulp-suite/.env build app
docker compose -f /home/cole/ulp-suite/docker-compose.yml --project-directory /home/cole/ulp-suite --env-file /home/cole/ulp-suite/.env up -d app
```

Use a scoped `DOCKER_CONFIG` per [[project-docker-credstore-workaround]] if needed. **Always anchor with `--project-directory`/`--env-file` pointed at the main checkout, even when running from a worktree** — see [[project-worktree-docker-env-hazard]]: without it, Docker resolves `.env` and the `./data`/`./uploads`/`./inbox` bind mounts relative to the invocation directory, which silently blanks secrets and/or points the live app at an empty database instead of the real one. Verify the fix, don't assume it: `docker inspect ulpsuite_app --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'` should show `/home/cole/ulp-suite/...` sources.

Expected: container recreated and healthy (`docker ps --filter name=ulpsuite_app`).

- [ ] **Step 4: Verify the migration applied**

```bash
docker logs ulpsuite_app 2>&1 | grep "DDL v19"
```

Expected: `[ClickHouse migration] DDL v19 applied (added idx_ngram_domain — MATERIALIZE running in background)`. If this doesn't appear, check directly against `system.mutations` rather than waiting indefinitely on app logs — migrations run via the app's HTTP ClickHouse client, and a multi-hour DDL over this HTTP connection can silently hang forever without ever logging an error (see [lib/clickhouse.ts](../../../lib/clickhouse.ts)'s `send_progress_in_http_headers` fix, added this same session, and its comment for the full mechanism). Track progress directly instead:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT is_done, parts_to_do, latest_fail_reason FROM system.mutations WHERE database='ulp' AND table='credentials' AND command LIKE '%idx_ngram_domain%' ORDER BY create_time DESC LIMIT 1 FORMAT Vertical"
```

- [ ] **Step 5: Empirically verify the index prunes the (unchanged) predicate — do not assume, measure**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
EXPLAIN indexes=1
SELECT DISTINCT domain FROM ulp.credentials
WHERE (domain = 'trezor.io' OR endsWith(domain, '.trezor.io'))
   OR (domain = 'ledger.com' OR endsWith(domain, '.ledger.com'))
SETTINGS use_query_cache = 0
"
```

Expected: `idx_ngram_domain` appears in the `Skip` indexes list with a granule count well below `idx_bf_domain`'s within that same combined plan (measured 2026-08-25 for this exact trezor.io+ledger.com query, with both indexes present: `idx_bf_domain` itself contributed 37350→36605, `idx_ngram_domain` narrowed the rest to 6710 — this 36605 is `idx_bf_domain`'s showing *within a plan that also has the ngram index*, not a from-scratch bloom-filter-only re-measurement, so don't be alarmed if it doesn't match the original, separately-measured "37350→37350, prunes nothing alone" finding cited elsewhere — that finding predates this index and used a different domain pair; see design doc §1 for the full disambiguation). Also time the actual query against the monitor's full real domain list (all 17 — a 2-domain query undersells how much pruning degrades as the OR list grows; measured 2.75s for 2 domains vs. 24.9s for the real 17-domain monitor, both comfortably under the 45s phase-1 budget, both down from the 50.76s baseline that motivated this task). If not meaningfully faster than baseline, STOP and re-open the design rather than layering on a third attempt blindly.

- [ ] **Step 6: Commit**

```bash
git add lib/clickhouse-migrations.ts
git commit -m "perf(monitoring): add idx_ngram_domain ClickHouse index (DDL v19)"
```

---

<details>
<summary>Original Task 4 text (superseded, kept for the record — do not execute)</summary>

**Files:**
- Modify: `lib/clickhouse-migrations.ts` (bump `DDL_VERSION`, add v19 block)

**Interfaces:**
- Produces: ClickHouse projection `proj_domain_reversed` on `ulp.credentials`, ordered by `reverse(domain)`, that Task 3's rewritten predicate can be pruned by.

- [ ] **Step 1: Bump the version constant**

In `lib/clickhouse-migrations.ts:159`, change:

```typescript
const DDL_VERSION = 19
```

- [ ] **Step 2: Add the v19 migration block**

Immediately after the existing `if (lastDdl < 18) { ... }` block (around line 786), add:

```typescript
  // v19 — proj_domain_reversed projection. Makes the phase-1 candidate scan
  // in lib/domain-match.ts's buildCandidateColumnWhereClause prunable for the
  // `domain` column: endsWith(domain, '.x') is prunable by no index on this
  // table (idx_bf_domain measured 37350->37350 granules); the rewritten
  // startsWith(reverse(domain), reverse('.x')) against this projection is a
  // prefix match, which range-pruning CAN use. Same ADD PROJECTION +
  // MATERIALIZE PROJECTION shape as v14's proj_imported_desc above.
  // See docs/superpowers/specs/2026-08-24-domain-monitor-saved-matches-design.md §1.
  if (lastDdl < 19) {
    await runMigration(
      `ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS proj_domain_reversed (
        SELECT url, email, password, domain, email_domain, imported_at
        ORDER BY reverse(domain)
      )`,
      `ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_domain_reversed`
    )
    console.warn('[ClickHouse migration] DDL v19 applied (added proj_domain_reversed projection — MATERIALIZE running in background)')
  }
```

(Remaining original steps 3-6 omitted — same shape as the corrected Steps 3-6 above, just against the projection instead of the index. Not reproduced twice.)

</details>

---

### Task 5: Extract `resolveMonitorMatches`

**Files:**
- Create: `lib/monitor-match-resolver.ts`
- Modify: `app/api/monitoring/monitors/[id]/matches/route.ts` (GET calls the extracted function; behavior unchanged — still a live query for now, cache read comes in Task 9)
- Test: `__tests__/monitor-match-resolver.test.ts` (create)

**Interfaces:**
- Produces: `resolveMonitorMatches(mode: MatchMode, domains: string[]): Promise<{ rows: MatchRow[]; limited: boolean }>` from `lib/monitor-match-resolver.ts`.
- Consumes: `buildCandidateColumnWhereClause`, `buildCandidateValueBranches`, `buildDomainSetWhereClause`, `compareMatches`, `mergeMatchPages`, `type CandidateColumn`, `type MatchMode`, `type MatchRow` from `lib/domain-match.ts`; `executeQuery` from `lib/clickhouse.ts`; `NORM_DOMAIN_EXPR` from `lib/ulp-normalize.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/monitor-match-resolver.test.ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/ulp-normalize', () => ({
  NORM_DOMAIN_EXPR: 'domain',
}))

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn().mockResolvedValue([]),
}))

import { resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { executeQuery } from '@/lib/clickhouse'

const mockExecuteQuery = vi.mocked(executeQuery)

beforeEach(() => {
  vi.clearAllMocks()
  mockExecuteQuery.mockResolvedValue([])
})

describe('resolveMonitorMatches', () => {
  test('returns empty, not limited, when phase 1 finds nothing', async () => {
    mockExecuteQuery.mockResolvedValue([])
    const result = await resolveMonitorMatches('both', ['nomatch.example'])
    expect(result).toEqual({ rows: [], limited: false })
  })

  test('phase 1 domain-column scan uses the index-backed endsWith predicate (idx_ngram_domain, Task 4)', async () => {
    await resolveMonitorMatches('url', ['trezor.io'])
    const domainScanCall = mockExecuteQuery.mock.calls.find(
      ([sql]) => (sql as string).includes('SELECT DISTINCT domain')
    )
    expect(domainScanCall).toBeDefined()
    const [sql] = domainScanCall as [string]
    expect(sql).toContain('endsWith(domain')
  })

  test('mode "url" only scans the domain column, not email_domain', async () => {
    await resolveMonitorMatches('url', ['trezor.io'])
    const emailDomainScan = mockExecuteQuery.mock.calls.find(
      ([sql]) => (sql as string).includes('SELECT DISTINCT email_domain')
    )
    expect(emailDomainScan).toBeUndefined()
  })

  test('fetches and returns rows when phase 1 resolves a candidate value', async () => {
    const row = { url: 'https://trezor.io/login', email: 'user@trezor.io', password: 'hunter2', domain: 'trezor.io' }
    mockExecuteQuery.mockImplementation(async (sql: unknown) => {
      const s = sql as string
      if (s.includes('SELECT DISTINCT domain')) return [{ value: 'trezor.io' }]
      if (s.includes('domain IN {legacyDomains')) return []
      if (s.includes('FROM ulp.credentials')) return [row]
      return []
    })

    const result = await resolveMonitorMatches('url', ['trezor.io'])
    expect(result.rows).toEqual([row])
    expect(result.limited).toBe(false)
  })

  test('limited is true when the result hits the 100-row cap', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      url: `https://trezor.io/${i}`, email: `u${i}@trezor.io`, password: 'x', domain: 'trezor.io',
    }))
    mockExecuteQuery.mockImplementation(async (sql: unknown) => {
      const s = sql as string
      if (s.includes('SELECT DISTINCT domain')) return [{ value: 'trezor.io' }]
      if (s.includes('domain IN {legacyDomains')) return []
      if (s.includes('FROM ulp.credentials')) return rows
      return []
    })

    const result = await resolveMonitorMatches('url', ['trezor.io'])
    expect(result.rows.length).toBe(100)
    expect(result.limited).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/monitor-match-resolver.test.ts`
Expected: FAIL — `lib/monitor-match-resolver.ts` doesn't exist.

- [ ] **Step 3: Create `lib/monitor-match-resolver.ts`**

Lift-and-shift from `app/api/monitoring/monitors/[id]/matches/route.ts` (the `CandidateResolution` interface, `NORMALIZED_LEGACY_DOMAINS`, `CANDIDATE_LIMIT`, `PHASE1_MAX_EXECUTION_TIME`, `PHASE2_MAX_EXECUTION_TIME`, `FALLBACK_MAX_EXECUTION_TIME`, `MATCH_ORDER_BY`, `MATCH_LIMIT`, `CANDIDATE_TTL_MS`, `candidateCache`, `candidateCacheKey`, `resolveCandidates`, `getCandidates`, `selectMatches`), plus the merge logic currently inline in the route's `GET` handler, combined into one exported function:

```typescript
/**
 * Shared "resolve current matches for a monitor's domain set" logic —
 * extracted from app/api/monitoring/monitors/[id]/matches/route.ts so the
 * rescan cron (lib/monitor-rescan-cron.ts) and the manual rescan endpoint
 * (app/api/monitoring/monitors/[id]/matches/rescan/route.ts) use the exact
 * same query strategy the live-matches endpoint was already tuned for,
 * instead of each maintaining their own. See
 * docs/superpowers/specs/2026-08-24-domain-monitor-saved-matches-design.md.
 */

import { executeQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
import {
  buildDomainSetWhereClause,
  buildCandidateColumnWhereClause,
  buildCandidateValueBranches,
  compareMatches,
  mergeMatchPages,
  type CandidateColumn,
  type MatchMode,
  type MatchRow,
} from '@/lib/domain-match'

const MATCH_LIMIT = 100
const CANDIDATE_LIMIT = 1000
const PHASE1_MAX_EXECUTION_TIME = 45
const PHASE2_MAX_EXECUTION_TIME = 30
const FALLBACK_MAX_EXECUTION_TIME = 30
const MATCH_ORDER_BY = 'domain, email'
const NORMALIZED_LEGACY_DOMAINS = ['', 'http', 'https']
const CANDIDATE_TTL_MS = 10 * 60_000

interface CandidateResolution {
  columns: Array<{ column: CandidateColumn; values: string[] }>
  legacyRows: MatchRow[]
  overflowed: boolean
}

const candidateCache = new Map<string, { expiresAt: number; resolution: Promise<CandidateResolution> }>()

function candidateCacheKey(mode: MatchMode, domains: string[]): string {
  return JSON.stringify([mode, [...domains].sort()])
}

function selectMatches(where: string, params: Record<string, unknown>, maxExecutionTime: number) {
  return executeQuery(
    `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
     FROM (
       SELECT url, email, password, domain
       FROM ulp.credentials
       WHERE ${where}
       ORDER BY ${MATCH_ORDER_BY}
       LIMIT {matchLimit:UInt32}
     ) AS t
     SETTINGS max_execution_time = ${maxExecutionTime}, timeout_overflow_mode = 'throw'`,
    { ...params, matchLimit: MATCH_LIMIT }
  ) as Promise<MatchRow[]>
}

async function resolveCandidates(mode: MatchMode, domains: string[]): Promise<CandidateResolution> {
  const columns: CandidateColumn[] = []
  if (mode === 'url' || mode === 'both') columns.push('domain')
  if (mode === 'credential' || mode === 'both') columns.push('email_domain')

  const scans = columns.map(async column => {
    const { clause, params } = buildCandidateColumnWhereClause(column, domains)
    const rows = await executeQuery(
      `SELECT DISTINCT ${column} AS value
       FROM ulp.credentials
       WHERE ${clause}
       LIMIT {candidateLimit:UInt32}
       SETTINGS max_execution_time = ${PHASE1_MAX_EXECUTION_TIME}, timeout_overflow_mode = 'throw'`,
      { ...params, candidateLimit: CANDIDATE_LIMIT + 1 }
    ) as { value: string }[]
    return { column, values: rows.map(r => r.value) }
  })

  const { clause: exactClause, params: exactParams } = buildDomainSetWhereClause(domains, mode)
  const legacyScan = selectMatches(
    `domain IN {legacyDomains:Array(String)} AND ${exactClause}`,
    { ...exactParams, legacyDomains: NORMALIZED_LEGACY_DOMAINS },
    PHASE1_MAX_EXECUTION_TIME,
  )

  const [scanResults, legacyRows] = await Promise.all([Promise.all(scans), legacyScan])

  let overflowed = false
  for (const entry of scanResults) {
    if (entry.values.length > CANDIDATE_LIMIT) overflowed = true
    entry.values = entry.values.filter(v => !NORMALIZED_LEGACY_DOMAINS.includes(v))
  }

  scanResults.sort((a, b) => (a.column === 'domain' ? -1 : b.column === 'domain' ? 1 : 0))

  return { columns: scanResults, legacyRows, overflowed }
}

function getCandidates(mode: MatchMode, domains: string[]): Promise<CandidateResolution> {
  const key = candidateCacheKey(mode, domains)
  const cached = candidateCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.resolution

  const resolution = resolveCandidates(mode, domains)
  candidateCache.set(key, { expiresAt: Date.now() + CANDIDATE_TTL_MS, resolution })
  resolution.catch(() => {
    if (candidateCache.get(key)?.resolution === resolution) candidateCache.delete(key)
  })
  return resolution
}

export interface ResolvedMatches {
  rows: MatchRow[]
  limited: boolean
}

/** Resolve up to MATCH_LIMIT credentials currently matching this domain set. */
export async function resolveMonitorMatches(mode: MatchMode, domains: string[]): Promise<ResolvedMatches> {
  if (domains.length === 0) return { rows: [], limited: false }

  const candidates = await getCandidates(mode, domains)
  const { clause, params: domainParams } = buildDomainSetWhereClause(domains, mode)
  const candidateBranches = buildCandidateValueBranches(candidates.columns, NORMALIZED_LEGACY_DOMAINS)

  let rows: MatchRow[]
  if (candidates.overflowed) {
    const page = await selectMatches(clause, domainParams, FALLBACK_MAX_EXECUTION_TIME)
    rows = page.sort(compareMatches)
  } else {
    const pages = await Promise.all(
      candidateBranches.map(branch => selectMatches(
        `${branch.clause} AND ${clause}`,
        { ...branch.params, ...domainParams },
        PHASE2_MAX_EXECUTION_TIME,
      ))
    )
    rows = mergeMatchPages([...pages, candidates.legacyRows], MATCH_LIMIT)
  }

  return { rows, limited: rows.length === MATCH_LIMIT }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/monitor-match-resolver.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Wire the live route to use it (no behavior change yet)**

In `app/api/monitoring/monitors/[id]/matches/route.ts`, remove the now-duplicated private implementation (the `CandidateResolution` interface, constants, `candidateCache`/`candidateCacheKey`/`resolveCandidates`/`getCandidates`/`selectMatches`, and the doc-comment block above them — keep the doc comment's numbers by moving it to `lib/monitor-match-resolver.ts` as a comment above `resolveMonitorMatches`, since that's where the logic it explains now lives), replace the import block with:

```typescript
import { resolveMonitorMatches } from "@/lib/monitor-match-resolver"
```

Replace the GET handler's body from `const domains = ...` through the `rows = ...` assignment with:

```typescript
    const domains = monitor.domains.map(d => d.toLowerCase().trim()).filter(Boolean)
    if (domains.length === 0) {
      return NextResponse.json({ success: true, results: [], total_shown: 0, new_count: 0, limited: false })
    }

    const { rows, limited } = await resolveMonitorMatches(monitor.match_mode, domains)
```

And change the final response's `limited: results.length === MATCH_LIMIT` to `limited` (the value just destructured). Remove the now-unused `MATCH_LIMIT` constant and `buildDomainSetWhereClause`/`buildCandidateColumnWhereClause`/`buildCandidateValueBranches`/`compareMatches`/`mergeMatchPages`/`CandidateColumn`/`NORM_DOMAIN_EXPR` imports from this file (they moved to the resolver).

- [ ] **Step 6: Run the existing route test suite to confirm the refactor is behavior-preserving**

Run: `npx vitest run __tests__/monitor-matches-route.test.ts __tests__/monitor-matches-route-error-handling.test.ts __tests__/monitor-matches-shared.test.ts`
Expected: PASS. If any test asserted on the private function names/constants directly (rather than the route's observable request/response behavior), update the test to import from `lib/monitor-match-resolver` instead — do not weaken the assertion.

- [ ] **Step 7: Commit**

```bash
git add lib/monitor-match-resolver.ts app/api/monitoring/monitors/[id]/matches/route.ts __tests__/monitor-match-resolver.test.ts __tests__/monitor-matches-route.test.ts __tests__/monitor-matches-route-error-handling.test.ts __tests__/monitor-matches-shared.test.ts
git commit -m "refactor(monitoring): extract resolveMonitorMatches so the cron can share it"
```

---

### Task 6: Cache read/write helpers

**Files:**
- Modify: `lib/domain-monitor.ts` (add cache helpers)
- Test: `__tests__/monitor-matches-cache.test.ts` (create)

**Interfaces:**
- Consumes: `dbRun`, `dbQuery`, `dbTransaction` from `lib/sqlite.ts`; `type MatchRow` from `lib/domain-match.ts`.
- Produces: `writeMonitorMatchCache(monitorId: number, rows: MatchRow[]): Promise<void>`, `recordMonitorRescanFailure(monitorId: number, error: string): Promise<void>`, `getMonitorMatchesCache(monitorId: number): Promise<MonitorMatchesCacheEntry>`, `type MonitorMatchesCacheEntry` — all exported from `lib/domain-monitor.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/monitor-matches-cache.test.ts
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpFiles: string[] = []
let originalSqlitePath: string | undefined

function freshDbPath(): string {
  const p = path.join(os.tmpdir(), `ulp-monitor-matches-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  tmpFiles.push(p)
  return p
}

async function loadAgainstFreshDb() {
  process.env.SQLITE_PATH = freshDbPath()
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  vi.resetModules()
  const sqlite = await import('@/lib/sqlite')
  const dm = await import('@/lib/domain-monitor')
  return { ...sqlite, ...dm }
}

beforeEach(() => {
  originalSqlitePath = process.env.SQLITE_PATH
})

afterEach(() => {
  const db = (globalThis as unknown as { _sqliteDb?: { close(): void } })._sqliteDb
  if (db) db.close()
  ;(globalThis as unknown as { _sqliteDb?: unknown })._sqliteDb = undefined
  if (originalSqlitePath === undefined) delete process.env.SQLITE_PATH
  else process.env.SQLITE_PATH = originalSqlitePath
  for (const p of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true })
  }
  vi.resetModules()
})

const ROW_A = { url: 'https://trezor.io/a', email: 'a@trezor.io', password: 'pw1', domain: 'trezor.io' }
const ROW_B = { url: 'https://trezor.io/b', email: 'b@trezor.io', password: 'pw2', domain: 'trezor.io' }

describe('getMonitorMatchesCache', () => {
  test('never_scanned when no rescan has ever run', async () => {
    const { dbRun, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    const cache = await getMonitorMatchesCache(1)
    expect(cache).toEqual({ rows: [], status: 'never_scanned', checkedAt: null, lastError: null })
  })

  test('writeMonitorMatchCache stores rows and marks status ok', async () => {
    const { dbRun, writeMonitorMatchCache, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    await writeMonitorMatchCache(1, [ROW_A, ROW_B])
    const cache = await getMonitorMatchesCache(1)

    expect(cache.status).toBe('ok')
    expect(cache.lastError).toBeNull()
    expect(cache.checkedAt).not.toBeNull()
    expect(cache.rows).toEqual(
      expect.arrayContaining([expect.objectContaining(ROW_A), expect.objectContaining(ROW_B)])
    )
    expect(cache.rows.length).toBe(2)
  })

  test('writeMonitorMatchCache fully replaces the previous snapshot (delete-then-insert)', async () => {
    const { dbRun, writeMonitorMatchCache, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    await writeMonitorMatchCache(1, [ROW_A])
    await writeMonitorMatchCache(1, [ROW_B])
    const cache = await getMonitorMatchesCache(1)

    expect(cache.rows).toEqual([expect.objectContaining(ROW_B)])
  })

  test('recordMonitorRescanFailure marks status failed but does not touch monitor_matches', async () => {
    const { dbRun, writeMonitorMatchCache, recordMonitorRescanFailure, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    await writeMonitorMatchCache(1, [ROW_A])
    const firstCheckedAt = (await getMonitorMatchesCache(1)).checkedAt

    await recordMonitorRescanFailure(1, 'Timeout exceeded: elapsed 60049ms, maximum: 60000ms.')
    const cache = await getMonitorMatchesCache(1)

    expect(cache.status).toBe('failed')
    expect(cache.lastError).toBe('Timeout exceeded: elapsed 60049ms, maximum: 60000ms.')
    // The last GOOD snapshot survives a subsequent failure — a cache is more
    // useful stale than empty.
    expect(cache.rows).toEqual([expect.objectContaining(ROW_A)])
    expect(cache.checkedAt).toBe(firstCheckedAt)
  })

  test('a monitor with zero genuine matches after a successful scan still has a checkedAt', async () => {
    const { dbRun, writeMonitorMatchCache, getMonitorMatchesCache } = await loadAgainstFreshDb()
    dbRun(`INSERT INTO domain_monitors (id, name, domains) VALUES (1, 'Wallets', '["trezor.io"]')`)

    await writeMonitorMatchCache(1, [])
    const cache = await getMonitorMatchesCache(1)

    expect(cache.status).toBe('ok')
    expect(cache.rows).toEqual([])
    expect(cache.checkedAt).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/monitor-matches-cache.test.ts`
Expected: FAIL — `writeMonitorMatchCache`/`recordMonitorRescanFailure`/`getMonitorMatchesCache` don't exist.

- [ ] **Step 3: Implement the helpers**

Add to `lib/domain-monitor.ts`. Add `dbTransaction` to the existing `lib/sqlite` import and `type MatchRow` to the existing `lib/domain-match` import at the top of the file, then add:

```typescript
// ─── Match cache (saved, not live) ─────────────────────────────────────────

export interface MonitorMatchesCacheEntry {
  rows: Array<{ url: string; email: string; password: string; domain: string }>
  status: 'never_scanned' | 'ok' | 'failed'
  checkedAt: string | null
  lastError: string | null
}

/**
 * Replace a monitor's cached "current matches" snapshot and mark the rescan
 * that produced it as successful. Delete-then-insert in one transaction so a
 * reader never sees a partially-replaced set. Timestamps use SQL
 * datetime('now'), not JS Date — lib/format-relative-time.ts parses the
 * SQLite "YYYY-MM-DD HH:MM:SS" shape specifically.
 */
export async function writeMonitorMatchCache(monitorId: number, rows: MatchRow[]): Promise<void> {
  dbTransaction(() => {
    dbRun('DELETE FROM monitor_matches WHERE monitor_id = ?', [monitorId])
    for (const row of rows) {
      dbRun(
        `INSERT INTO monitor_matches (monitor_id, url, email, password, domain, fetched_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [monitorId, row.url, row.email, row.password, row.domain]
      )
    }
    dbRun(
      `INSERT INTO monitor_rescan_status (monitor_id, status, error, attempted_at, last_success_at)
       VALUES (?, 'ok', NULL, datetime('now'), datetime('now'))
       ON CONFLICT(monitor_id) DO UPDATE SET status = 'ok', error = NULL, attempted_at = datetime('now'), last_success_at = datetime('now')`,
      [monitorId]
    )
  })
}

/**
 * Record a failed rescan attempt without touching the previous good
 * monitor_matches snapshot — a stale cache is more useful than an empty one.
 * This is the fix for the bug where a timeout was only ever console.error'd:
 * lib/monitor-rescan-cron.ts's runTick previously had no persisted trace of
 * a monitor failing every single tick.
 */
export async function recordMonitorRescanFailure(monitorId: number, error: string): Promise<void> {
  dbRun(
    `INSERT INTO monitor_rescan_status (monitor_id, status, error, attempted_at, last_success_at)
     VALUES (?, 'failed', ?, datetime('now'), NULL)
     ON CONFLICT(monitor_id) DO UPDATE SET status = 'failed', error = ?, attempted_at = datetime('now')`,
    [monitorId, error, error]
  )
}

/** Read the current cached matches + rescan health for a monitor. */
export async function getMonitorMatchesCache(monitorId: number): Promise<MonitorMatchesCacheEntry> {
  const statusRow = dbGet(
    `SELECT status, error, last_success_at FROM monitor_rescan_status WHERE monitor_id = ?`,
    [monitorId]
  ) as { status: 'ok' | 'failed'; error: string | null; last_success_at: string | null } | undefined

  if (!statusRow) {
    return { rows: [], status: 'never_scanned', checkedAt: null, lastError: null }
  }

  const rows = dbQuery(
    `SELECT url, email, password, domain FROM monitor_matches WHERE monitor_id = ? ORDER BY domain, email`,
    [monitorId]
  ) as Array<{ url: string; email: string; password: string; domain: string }>

  return {
    rows,
    status: statusRow.status,
    checkedAt: statusRow.last_success_at,
    lastError: statusRow.status === 'failed' ? statusRow.error : null,
  }
}
```

Update the top-of-file imports:

```typescript
import { dbQuery, dbGet, dbRun, dbTransaction } from '@/lib/sqlite'
import { matchModeToMatchType, credentialFingerprint, type MatchedCredential, type MatchRow } from '@/lib/domain-match'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/monitor-matches-cache.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/domain-monitor.ts __tests__/monitor-matches-cache.test.ts
git commit -m "feat(monitoring): add monitor match-cache read/write helpers"
```

---

### Task 7: Cron rewire

**Files:**
- Modify: `lib/monitor-rescan-cron.ts`
- Test: `__tests__/monitor-rescan-cron.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveMonitorMatches` from `lib/monitor-match-resolver.ts`; `writeMonitorMatchCache`, `recordMonitorRescanFailure` from `lib/domain-monitor.ts`.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/monitor-rescan-cron.test.ts`. First add these mocks alongside the existing `vi.mock` calls at the top of the file:

```typescript
vi.mock('@/lib/monitor-match-resolver', () => ({
  resolveMonitorMatches: vi.fn().mockResolvedValue({ rows: [], limited: false }),
}))

vi.mock('@/lib/domain-monitor', () => ({
  writeMonitorMatchCache: vi.fn().mockResolvedValue(undefined),
  recordMonitorRescanFailure: vi.fn().mockResolvedValue(undefined),
}))
```

And add the corresponding imports below the existing ones:

```typescript
import { resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { writeMonitorMatchCache, recordMonitorRescanFailure } from '@/lib/domain-monitor'

const mockResolveMonitorMatches = vi.mocked(resolveMonitorMatches)
const mockWriteMonitorMatchCache = vi.mocked(writeMonitorMatchCache)
const mockRecordMonitorRescanFailure = vi.mocked(recordMonitorRescanFailure)
```

Add to the `beforeEach`:

```typescript
  mockResolveMonitorMatches.mockResolvedValue({ rows: [], limited: false })
```

Then add:

```typescript
describe('runTick — match cache (saved, not live)', () => {
  test('writes the cache with resolveMonitorMatches\' rows on success', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow()])  // due monitors
    mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [MATCHED_ROW], limited: false })

    await runTick()

    expect(mockWriteMonitorMatchCache).toHaveBeenCalledWith(1, [MATCHED_ROW])
  })

  test('calls resolveMonitorMatches once per monitor, not once per domain', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow({ domains: JSON.stringify(['aave.com', 'lido.fi', 'trezor.io']) })])
    mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [], limited: false })

    await runTick()

    expect(mockResolveMonitorMatches).toHaveBeenCalledTimes(1)
    expect(mockResolveMonitorMatches).toHaveBeenCalledWith('both', ['aave.com', 'lido.fi', 'trezor.io'])
  })

  test('records a rescan failure (not just console.error) when resolveMonitorMatches throws', async () => {
    mockDbQuery.mockReturnValueOnce([dueMonitorRow()])
    mockResolveMonitorMatches.mockRejectedValueOnce(new Error('Timeout exceeded: elapsed 60049ms, maximum: 60000ms.'))

    await runTick()

    expect(mockRecordMonitorRescanFailure).toHaveBeenCalledWith(1, 'Timeout exceeded: elapsed 60049ms, maximum: 60000ms.')
    // The bug being fixed: previously this was ONLY console.error'd, with no
    // trace anywhere queryable — last_triggered_at must not silently advance
    // on a failed attempt either.
    const lastTriggeredCall = mockDbRun.mock.calls.find(([sql]) => (sql as string).includes('UPDATE domain_monitors SET last_triggered_at'))
    expect(lastTriggeredCall).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/monitor-rescan-cron.test.ts -t "match cache"`
Expected: FAIL — `runTick` doesn't call `resolveMonitorMatches`/`writeMonitorMatchCache` yet (still does its own per-domain `executeClickHouseQuery` loop).

- [ ] **Step 3: Rewire `runTick`**

In `lib/monitor-rescan-cron.ts`, replace the imports:

```typescript
import { dbQuery, dbRun } from '@/lib/sqlite'
import { attemptDelivery, enqueueFailedDelivery, runWebhookOutboxTick } from '@/lib/webhook-outbox-worker'
import { matchModeToMatchType, credentialFingerprint, type MatchMode } from '@/lib/domain-match'
import { resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { writeMonitorMatchCache, recordMonitorRescanFailure } from '@/lib/domain-monitor'
```

Replace the per-domain query loop (currently lines 91-103: the `const matchedRows: CredentialRow[] = []` block through `matchedRows.push(...rows)`) with:

```typescript
      const { rows: matchedRows } = await resolveMonitorMatches(monitorRow.match_mode, domains)
      await writeMonitorMatchCache(monitorRow.id, matchedRows)
```

Remove the now-unused `NORM_DOMAIN_EXPR`/`matchConditionSQL`/`executeQuery as executeClickHouseQuery` imports and the `CredentialRow` interface stays (still used as the shape of `matchedRows`/`unseenRows` downstream).

Change the outer `catch` block (currently just `console.error`) to:

```typescript
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[monitor-rescan] error processing monitor "${monitorRow.name}": ${err}`)
      try {
        await recordMonitorRescanFailure(monitorRow.id, message)
      } catch (statusErr) {
        console.error(`[monitor-rescan] failed to record rescan status for monitor "${monitorRow.name}": ${statusErr}`)
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/monitor-rescan-cron.test.ts`
Expected: PASS (all tests in the file — the pre-existing tests construct their SQL-shape assertions against `mockExecuteQuery`, which `resolveMonitorMatches` no longer touches directly since it's mocked at the module level now; re-check each pre-existing test still makes sense against the new call shape and update any that asserted on the removed per-domain-loop SQL text specifically, per Step 5)

- [ ] **Step 5: Reconcile pre-existing tests that asserted on the old per-domain query**

The two `describe('runTick — query construction', ...)` tests and the `'runTick — email-domain false-match guard'` test (lines 60-135 of the original file) assert directly on `mockExecuteQuery`'s call args — those calls no longer happen in `runTick` itself (they now happen inside the mocked `resolveMonitorMatches`). Move this coverage to `__tests__/monitor-match-resolver.test.ts` instead (Task 5's file) if it isn't already covered there, and delete the now-inapplicable assertions from `monitor-rescan-cron.test.ts`. The `'runTick — match_type persistence'` and `'runTick — match recording without webhooks'` tests should switch their `mockExecuteQuery.mockResolvedValueOnce([MATCHED_ROW])` setup to `mockResolveMonitorMatches.mockResolvedValueOnce({ rows: [MATCHED_ROW], limited: false })` instead.

Run: `npx vitest run __tests__/monitor-rescan-cron.test.ts __tests__/monitor-match-resolver.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/monitor-rescan-cron.ts __tests__/monitor-rescan-cron.test.ts __tests__/monitor-match-resolver.test.ts
git commit -m "fix(monitoring): rescan cron shares resolveMonitorMatches, records failures instead of only logging"
```

---

### Task 8: "Rescan now" endpoint

**Files:**
- Create: `app/api/monitoring/monitors/[id]/matches/rescan/route.ts`
- Test: `__tests__/monitor-matches-rescan-route.test.ts` (create)

**Interfaces:**
- Consumes: `getMonitor`, `writeMonitorMatchCache`, `recordMonitorRescanFailure`, `getMonitorMatchesCache`, `markMatchesNewSinceLastView`, `recordMonitorViewed` from `lib/domain-monitor.ts`; `resolveMonitorMatches` from `lib/monitor-match-resolver.ts`; `validateRequest`, `requireAdminRole` from `lib/auth.ts`; `checkLimit`, `getClientIP` from `lib/rate-limiter.ts`.
- Produces: `POST /api/monitoring/monitors/[id]/matches/rescan` → `{ success: true, results, total_shown, new_count, limited, checked_at, last_error }` on success, matching the GET endpoint's (Task 9) response shape so the hook (Task 10) can share one handler for both.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/monitor-matches-rescan-route.test.ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn(),
  requireAdminRole: vi.fn(),
}))

vi.mock('@/lib/monitor-match-resolver', () => ({
  resolveMonitorMatches: vi.fn(),
}))

vi.mock('@/lib/domain-monitor', () => ({
  getMonitor: vi.fn(),
  writeMonitorMatchCache: vi.fn().mockResolvedValue(undefined),
  recordMonitorRescanFailure: vi.fn().mockResolvedValue(undefined),
  getMonitorMatchesCache: vi.fn(),
  markMatchesNewSinceLastView: vi.fn(async (_id: number, _uid: number, rows: unknown[]) =>
    (rows as Record<string, unknown>[]).map(r => ({ ...r, is_new: false }))),
  recordMonitorViewed: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/rate-limiter', () => ({
  checkLimit: vi.fn().mockReturnValue({ allowed: true, resetAt: 0 }),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}))

import { POST } from '@/app/api/monitoring/monitors/[id]/matches/rescan/route'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { getMonitor, writeMonitorMatchCache, recordMonitorRescanFailure, getMonitorMatchesCache } from '@/lib/domain-monitor'
import { checkLimit } from '@/lib/rate-limiter'
import { NextRequest } from 'next/server'

const mockValidateRequest = vi.mocked(validateRequest)
const mockRequireAdminRole = vi.mocked(requireAdminRole)
const mockResolveMonitorMatches = vi.mocked(resolveMonitorMatches)
const mockGetMonitor = vi.mocked(getMonitor)
const mockWriteMonitorMatchCache = vi.mocked(writeMonitorMatchCache)
const mockRecordMonitorRescanFailure = vi.mocked(recordMonitorRescanFailure)
const mockGetMonitorMatchesCache = vi.mocked(getMonitorMatchesCache)
const mockCheckLimit = vi.mocked(checkLimit)

const ADMIN_USER = { userId: '1', role: 'admin' }
const MONITOR = { id: 1, name: 'Wallets', domains: ['trezor.io'], match_mode: 'url' as const, is_active: true }

function req() {
  return new NextRequest('http://localhost/api/monitoring/monitors/1/matches/rescan', { method: 'POST' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateRequest.mockResolvedValue(ADMIN_USER as never)
  mockRequireAdminRole.mockReturnValue(null as never)
  mockCheckLimit.mockReturnValue({ allowed: true, resetAt: 0 })
  mockGetMonitor.mockResolvedValue(MONITOR as never)
  mockGetMonitorMatchesCache.mockResolvedValue({ rows: [], status: 'ok', checkedAt: '2026-08-25 00:00:00', lastError: null })
})

describe('POST .../matches/rescan', () => {
  test('non-admin is rejected before any ClickHouse call', async () => {
    mockRequireAdminRole.mockReturnValue(new Response(null, { status: 403 }) as never)

    await POST(req(), { params: Promise.resolve({ id: '1' }) })

    expect(mockResolveMonitorMatches).not.toHaveBeenCalled()
  })

  test('on success, writes the cache and returns the fresh cache read', async () => {
    mockResolveMonitorMatches.mockResolvedValue({ rows: [{ url: 'u', email: 'e', password: 'p', domain: 'trezor.io' }], limited: false })
    mockGetMonitorMatchesCache.mockResolvedValue({
      rows: [{ url: 'u', email: 'e', password: 'p', domain: 'trezor.io' }],
      status: 'ok', checkedAt: '2026-08-25 00:00:01', lastError: null,
    })

    const res = await POST(req(), { params: Promise.resolve({ id: '1' }) })
    const data = await res.json()

    expect(mockWriteMonitorMatchCache).toHaveBeenCalledWith(1, [{ url: 'u', email: 'e', password: 'p', domain: 'trezor.io' }])
    expect(data.success).toBe(true)
    expect(data.results).toHaveLength(1)
    expect(data.checked_at).toBe('2026-08-25 00:00:01')
  })

  test('on resolver failure, records the failure and still returns success:true with last_error (a stale/empty cache read is not itself a request failure)', async () => {
    mockResolveMonitorMatches.mockRejectedValue(new Error('Timeout exceeded'))
    mockGetMonitorMatchesCache.mockResolvedValue({ rows: [], status: 'failed', checkedAt: null, lastError: 'Timeout exceeded' })

    const res = await POST(req(), { params: Promise.resolve({ id: '1' }) })
    const data = await res.json()

    expect(mockRecordMonitorRescanFailure).toHaveBeenCalledWith(1, 'Timeout exceeded')
    expect(data.success).toBe(true)
    expect(data.last_error).toBe('Timeout exceeded')
  })

  test('two concurrent rescans of the same monitor: the second is rejected with 409, not a duplicate ClickHouse query', async () => {
    let resolveFirst!: (v: { rows: never[]; limited: boolean }) => void
    mockResolveMonitorMatches.mockReturnValueOnce(new Promise(r => { resolveFirst = r }))

    const first = POST(req(), { params: Promise.resolve({ id: '1' }) })
    // Let the first request's synchronous setup (including acquiring the lock) run.
    await new Promise(r => setTimeout(r, 0))

    const second = await POST(req(), { params: Promise.resolve({ id: '1' }) })
    expect(second.status).toBe(409)

    resolveFirst({ rows: [], limited: false })
    await first
    expect(mockResolveMonitorMatches).toHaveBeenCalledTimes(1)
  })

  test('rate limited returns 429', async () => {
    mockCheckLimit.mockReturnValue({ allowed: false, resetAt: Date.now() + 5000 })

    const res = await POST(req(), { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(429)
    expect(mockResolveMonitorMatches).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/monitor-matches-rescan-route.test.ts`
Expected: FAIL — the route file doesn't exist.

- [ ] **Step 3: Implement the route**

```typescript
// app/api/monitoring/monitors/[id]/matches/rescan/route.ts
import { NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import {
  getMonitor,
  writeMonitorMatchCache,
  recordMonitorRescanFailure,
  getMonitorMatchesCache,
  markMatchesNewSinceLastView,
  recordMonitorViewed,
} from "@/lib/domain-monitor"
import { resolveMonitorMatches } from "@/lib/monitor-match-resolver"
import { checkLimit, getClientIP } from "@/lib/rate-limiter"

export const dynamic = 'force-dynamic'

const MATCH_LIMIT = 100

const rescanLimiter = new Map<string, { count: number; resetAt: number }>()

// Guards against two overlapping scans of the SAME monitor — an admin
// double-click, or the 15-minute cron firing mid-manual-rescan. A per-IP
// rate limit alone wouldn't catch two different admins hitting one monitor.
const inFlightRescans = new Set<number>()

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const { id } = await params
  const monitorId = parseInt(id)
  if (isNaN(monitorId)) {
    return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
  }

  const ip = getClientIP(request)
  const rlResult = checkLimit(rescanLimiter, ip, 10, 60_000)
  if (!rlResult.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many rescan requests — please wait a moment before retrying.' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)) },
      }
    )
  }

  if (inFlightRescans.has(monitorId)) {
    return NextResponse.json(
      { success: false, error: 'A rescan for this monitor is already in progress.' },
      { status: 409 }
    )
  }

  try {
    const monitor = await getMonitor(monitorId)
    if (!monitor) {
      return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
    }

    const domains = monitor.domains.map(d => d.toLowerCase().trim()).filter(Boolean)

    inFlightRescans.add(monitorId)
    try {
      const resolved = await resolveMonitorMatches(monitor.match_mode, domains)
      await writeMonitorMatchCache(monitorId, resolved.rows)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await recordMonitorRescanFailure(monitorId, message)
    } finally {
      inFlightRescans.delete(monitorId)
    }

    const userId = parseInt(user!.userId)
    const cache = await getMonitorMatchesCache(monitorId)
    const results = await markMatchesNewSinceLastView(monitorId, userId, cache.rows)

    try {
      await recordMonitorViewed(monitorId, userId)
    } catch (viewError) {
      console.error('Failed to record monitor viewed:', viewError instanceof Error ? viewError.message : String(viewError))
    }

    return NextResponse.json({
      success: true,
      results,
      total_shown: results.length,
      new_count: results.filter(r => r.is_new).length,
      limited: results.length === MATCH_LIMIT,
      checked_at: cache.checkedAt,
      last_error: cache.lastError,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Monitor rescan error:', msg)
    return NextResponse.json({ success: false, error: 'Rescan failed' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/monitor-matches-rescan-route.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add "app/api/monitoring/monitors/[id]/matches/rescan/route.ts" __tests__/monitor-matches-rescan-route.test.ts
git commit -m "feat(monitoring): add POST .../matches/rescan for on-demand cache refresh"
```

---

### Task 9: GET route switches to the cache

**Files:**
- Modify: `app/api/monitoring/monitors/[id]/matches/route.ts`
- Test: `__tests__/monitor-matches-route.test.ts`, `__tests__/monitor-matches-route-error-handling.test.ts` (update)

**Interfaces:**
- Consumes: `getMonitorMatchesCache` from `lib/domain-monitor.ts` (Task 6).
- Produces: `GET .../matches` response shape gains `checked_at`, `never_scanned`, `last_error`; `results`/`total_shown`/`new_count`/`limited`/`success` unchanged so existing hook consumers keep working until Task 10.

- [ ] **Step 1: Update the route test expectations first**

In `__tests__/monitor-matches-route.test.ts`, this route no longer calls ClickHouse — mocks of `@/lib/clickhouse`/`@/lib/monitor-match-resolver` should be replaced with a mock of `@/lib/domain-monitor`'s `getMonitorMatchesCache`. Read the existing file's mock setup and adjust it to mock:

```typescript
vi.mock('@/lib/domain-monitor', () => ({
  getMonitor: vi.fn(),
  getMonitorMatchesCache: vi.fn(),
  markMatchesNewSinceLastView: vi.fn(async (_id: number, _uid: number, rows: unknown[]) =>
    (rows as Record<string, unknown>[]).map(r => ({ ...r, is_new: false }))),
  recordMonitorViewed: vi.fn().mockResolvedValue(undefined),
}))
```

Add a new test:

```typescript
test('response includes checked_at, never_scanned, and last_error from the cache', async () => {
  const { getMonitor, getMonitorMatchesCache } = await import('@/lib/domain-monitor')
  vi.mocked(getMonitor).mockResolvedValue({ id: 1, name: 'Wallets', domains: ['trezor.io'], match_mode: 'url' } as never)
  vi.mocked(getMonitorMatchesCache).mockResolvedValue({
    rows: [], status: 'never_scanned', checkedAt: null, lastError: null,
  })

  const { GET } = await import('@/app/api/monitoring/monitors/[id]/matches/route')
  const res = await GET(
    new (await import('next/server')).NextRequest('http://localhost/api/monitoring/monitors/1/matches'),
    { params: Promise.resolve({ id: '1' }) }
  )
  const data = await res.json()

  expect(data.never_scanned).toBe(true)
  expect(data.checked_at).toBeNull()
})
```

Run: `npx vitest run __tests__/monitor-matches-route.test.ts`
Expected: FAIL (route still queries ClickHouse via `resolveMonitorMatches`).

- [ ] **Step 2: Rewrite the GET handler**

Replace the full contents of `app/api/monitoring/monitors/[id]/matches/route.ts` with:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getMonitor, getMonitorMatchesCache, markMatchesNewSinceLastView, recordMonitorViewed } from "@/lib/domain-monitor"

export const dynamic = 'force-dynamic'

const MATCH_LIMIT = 100

/**
 * GET /api/monitoring/monitors/[id]/matches
 * Saved-search: the monitor's cached "current matches" snapshot, populated by
 * the rescan cron (lib/monitor-rescan-cron.ts) or a manual
 * POST .../matches/rescan — never queries ClickHouse directly. See
 * docs/superpowers/specs/2026-08-24-domain-monitor-saved-matches-design.md.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const monitorId = parseInt(id)
  if (isNaN(monitorId)) {
    return NextResponse.json({ success: false, error: "Invalid monitor ID" }, { status: 400 })
  }

  const userId = parseInt(user.userId)

  try {
    const monitor = await getMonitor(monitorId)
    if (!monitor) {
      return NextResponse.json({ success: false, error: "Monitor not found" }, { status: 404 })
    }

    const cache = await getMonitorMatchesCache(monitorId)
    const results = await markMatchesNewSinceLastView(monitorId, userId, cache.rows)
    const newCount = results.filter(r => r.is_new).length

    // Best-effort, matches the prior live-query endpoint's behavior: a
    // failure here must not cost the admin the read they just made.
    try {
      await recordMonitorViewed(monitorId, userId)
    } catch (viewError) {
      const viewMsg = viewError instanceof Error ? viewError.message : String(viewError)
      console.error('Failed to record monitor viewed:', viewMsg)
    }

    return NextResponse.json({
      success: true,
      results,
      total_shown: results.length,
      new_count: newCount,
      limited: results.length === MATCH_LIMIT,
      checked_at: cache.checkedAt,
      never_scanned: cache.status === 'never_scanned',
      last_error: cache.lastError,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Monitor matches cache read error:', msg)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run __tests__/monitor-matches-route.test.ts __tests__/monitor-matches-route-error-handling.test.ts __tests__/monitor-matches-shared.test.ts`
Expected: PASS. `monitor-matches-route-error-handling.test.ts` likely asserted on the old ClickHouse-timeout 408 path (`timed_out: true`) — that path no longer exists (a cache read has no ClickHouse-shaped failure mode); replace those specific assertions with the new `status: 500` generic-SQLite-error path, or with the `last_error`-carrying-but-`success:true` stale-cache path, whichever the test was actually trying to protect. Do not delete coverage without replacing it with the equivalent for the new architecture.

- [ ] **Step 4: Manual end-to-end verification**

Rebuild/redeploy per Task 4 Step 3, then check the actual monitor:

```bash
curl -s -b <admin session cookie> http://localhost:3000/api/monitoring/monitors/1/matches | head -c 500
```

Expected: fast (<200ms), and `never_scanned: true` if Task 7's cron hasn't ticked yet on this deploy — not an error, not a hang.

- [ ] **Step 5: Commit**

```bash
git add "app/api/monitoring/monitors/[id]/matches/route.ts" __tests__/monitor-matches-route.test.ts __tests__/monitor-matches-route-error-handling.test.ts
git commit -m "feat(monitoring): serve matches from the cache instead of querying ClickHouse live"
```

---

### Task 10: Hook — checkedAt/rescanNow

**Files:**
- Modify: `hooks/useMonitorMatches.ts`

**Interfaces:**
- Produces: hook return value gains `checkedAt: string | null`, `neverScanned: boolean`, `lastError: string | null`, `rescanning: boolean`, `rescanNow: () => Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/use-monitor-matches.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useMonitorMatches } from '@/hooks/useMonitorMatches'

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const originalFetch = global.fetch

beforeEach(() => {
  global.fetch = vi.fn()
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('useMonitorMatches — rescanNow', () => {
  test('rescanNow POSTs to the rescan endpoint and applies the response', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      json: async () => ({ success: true, results: [], limited: false, new_count: 0, checked_at: null, never_scanned: true, last_error: null }),
    } as Response)

    const { result } = renderHook(() => useMonitorMatches())
    await act(async () => {
      await result.current.openMatches({ id: 1, name: 'Wallets' })
    })

    vi.mocked(global.fetch).mockResolvedValueOnce({
      json: async () => ({
        success: true,
        results: [{ url: 'u', email: 'e', password: 'p', domain: 'trezor.io', is_new: false }],
        limited: false, new_count: 0, checked_at: '2026-08-25 00:00:00', never_scanned: false, last_error: null,
      }),
    } as Response)

    await act(async () => {
      await result.current.rescanNow()
    })

    expect(global.fetch).toHaveBeenLastCalledWith('/api/monitoring/monitors/1/matches/rescan', { method: 'POST' })
    expect(result.current.matches).toHaveLength(1)
    expect(result.current.checkedAt).toBe('2026-08-25 00:00:00')
    expect(result.current.neverScanned).toBe(false)
  })

  test('rescanning is true only while the POST is in flight', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      json: async () => ({ success: true, results: [], limited: false, new_count: 0, checked_at: null, never_scanned: true, last_error: null }),
    } as Response)
    const { result } = renderHook(() => useMonitorMatches())
    await act(async () => { await result.current.openMatches({ id: 1, name: 'Wallets' }) })

    let resolveFetch!: (v: unknown) => void
    vi.mocked(global.fetch).mockReturnValueOnce(new Promise(r => { resolveFetch = r }) as never)

    act(() => { result.current.rescanNow() })
    await waitFor(() => expect(result.current.rescanning).toBe(true))

    resolveFetch({ json: async () => ({ success: true, results: [], limited: false, new_count: 0, checked_at: '2026-08-25 00:00:01', never_scanned: false, last_error: null }) })
    await waitFor(() => expect(result.current.rescanning).toBe(false))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/use-monitor-matches.test.ts`
Expected: FAIL — `rescanNow`/`checkedAt`/`neverScanned`/`rescanning` don't exist on the hook's return value.

- [ ] **Step 3: Implement the hook changes**

Replace `hooks/useMonitorMatches.ts` with:

```typescript
"use client"

import { useState, useRef } from "react"
import { useToast } from "@/hooks/use-toast"

export interface MonitorMatchTarget {
  id: number
  name: string
}

export interface MonitorMatchRow {
  url: string
  email: string
  password: string
  domain: string
  is_new: boolean
}

interface MatchesApiResponse {
  success: boolean
  results?: MonitorMatchRow[]
  limited?: boolean
  new_count?: number
  checked_at?: string | null
  never_scanned?: boolean
  last_error?: string | null
  error?: string
}

export function useMonitorMatches() {
  const { toast } = useToast()

  const [matchesMonitor, setMatchesMonitor] = useState<MonitorMatchTarget | null>(null)
  const [matches, setMatches] = useState<MonitorMatchRow[]>([])
  const [matchesLoading, setMatchesLoading] = useState(false)
  const [matchesLimited, setMatchesLimited] = useState(false)
  const [matchesNewCount, setMatchesNewCount] = useState(0)
  // Distinct from "loaded, zero rows" on purpose — see the dialog's render
  // branches. An empty table must never stand in for a failed request.
  const [matchesError, setMatchesError] = useState<string | null>(null)
  // Cache metadata (this endpoint reads a cache now, see Task 9) — distinct
  // from matchesError, which is for the GET/POST request itself failing.
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [neverScanned, setNeverScanned] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const [rescanning, setRescanning] = useState(false)
  // Only the newest request may write state. A cold phase-1 cache used to
  // make this seconds long; now a rescan does, so the guard still matters.
  const matchesRequestId = useRef(0)

  const applyResult = (data: MatchesApiResponse) => {
    setMatches(data.results || [])
    setMatchesLimited(Boolean(data.limited))
    setMatchesNewCount(data.new_count || 0)
    setCheckedAt(data.checked_at ?? null)
    setNeverScanned(Boolean(data.never_scanned))
    setLastError(data.last_error ?? null)
  }

  const openMatches = async (monitor: MonitorMatchTarget) => {
    const requestId = ++matchesRequestId.current
    setMatchesMonitor(monitor)
    setMatchesLoading(true)
    setMatches([])
    setMatchesLimited(false)
    setMatchesNewCount(0)
    setMatchesError(null)
    setCheckedAt(null)
    setNeverScanned(false)
    setLastError(null)
    try {
      const res = await fetch(`/api/monitoring/monitors/${monitor.id}/matches`)
      const data: MatchesApiResponse = await res.json()
      if (requestId !== matchesRequestId.current) return
      if (data.success) {
        applyResult(data)
      } else {
        const message = data.error || "The match query failed. Results below are unavailable — this is not a confirmation that nothing matches."
        setMatchesError(message)
        toast({ title: "Failed to load matches", description: message, variant: "destructive" })
      }
    } catch {
      if (requestId !== matchesRequestId.current) return
      setMatchesError("Could not reach the server. Results are unavailable — this is not a confirmation that nothing matches.")
      toast({ title: "Failed to load matches", variant: "destructive" })
    } finally {
      if (requestId === matchesRequestId.current) setMatchesLoading(false)
    }
  }

  const rescanNow = async () => {
    if (!matchesMonitor) return
    const requestId = ++matchesRequestId.current
    setRescanning(true)
    try {
      const res = await fetch(`/api/monitoring/monitors/${matchesMonitor.id}/matches/rescan`, { method: 'POST' })
      const data: MatchesApiResponse = await res.json()
      if (requestId !== matchesRequestId.current) return
      if (data.success) {
        setMatchesError(null)
        applyResult(data)
      } else {
        const message = data.error || "The rescan failed."
        toast({ title: "Rescan failed", description: message, variant: "destructive" })
      }
    } catch {
      if (requestId !== matchesRequestId.current) return
      toast({ title: "Rescan failed", description: "Could not reach the server.", variant: "destructive" })
    } finally {
      if (requestId === matchesRequestId.current) setRescanning(false)
    }
  }

  const closeMatches = () => setMatchesMonitor(null)

  return {
    matchesMonitor,
    matches,
    matchesLoading,
    matchesLimited,
    matchesNewCount,
    matchesError,
    checkedAt,
    neverScanned,
    lastError,
    rescanning,
    openMatches,
    closeMatches,
    rescanNow,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/use-monitor-matches.test.ts`
Expected: PASS (2 tests). If `@testing-library/react`'s `renderHook`/`waitFor` aren't already a project dependency, check `package.json` first — if absent, adapt the test to drive the hook via a minimal test component and `@testing-library/react`'s `render`/`act` instead of adding a new dependency.

- [ ] **Step 5: Commit**

```bash
git add hooks/useMonitorMatches.ts __tests__/use-monitor-matches.test.ts
git commit -m "feat(monitoring): add rescanNow + cache-freshness state to useMonitorMatches"
```

---

### Task 11: Dialog — freshness header + Rescan button

**Files:**
- Modify: `components/monitor-matches-dialog.tsx`
- Modify: `app/monitoring/page.tsx` (pass the new props through — it's the current consumer of both the hook and the dialog)
- Modify: `app/saved-searches/page.tsx` (same, per the shared-component design from `2026-08-24-saved-searches-hub-design.md`)

**Interfaces:**
- Consumes: `checkedAt`, `neverScanned`, `lastError`, `rescanning`, `rescanNow` from `useMonitorMatches()` (Task 10).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/monitor-matches-dialog.test.ts
import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const source = fs.readFileSync(path.join(__dirname, '../components/monitor-matches-dialog.tsx'), 'utf-8')

describe('monitor-matches-dialog.tsx — source shape', () => {
  test('accepts the new freshness/rescan props', () => {
    expect(source).toMatch(/checkedAt/)
    expect(source).toMatch(/neverScanned/)
    expect(source).toMatch(/lastError/)
    expect(source).toMatch(/rescanning/)
    expect(source).toMatch(/onRescan/)
  })

  test('no longer claims results are "queried live"', () => {
    expect(source).not.toMatch(/queried live/)
  })

  test('renders a rescan trigger', () => {
    expect(source).toMatch(/Rescan now/)
  })

  test('never-scanned state is distinguished from a genuinely empty result set', () => {
    expect(source).toMatch(/Not yet scanned/)
  })

  test('the error-before-empty branch order is preserved (existing invariant)', () => {
    const errorIdx = source.indexOf('error ?')
    const emptyIdx = source.indexOf('matches.length === 0')
    expect(errorIdx).toBeGreaterThan(-1)
    expect(emptyIdx).toBeGreaterThan(-1)
    expect(errorIdx).toBeLessThan(emptyIdx)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/monitor-matches-dialog.test.ts`
Expected: FAIL (new props/copy don't exist yet).

- [ ] **Step 3: Update the dialog**

Replace `components/monitor-matches-dialog.tsx` with:

```typescript
"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { formatRelativeTime } from "@/lib/format-relative-time"
import type { MonitorMatchTarget, MonitorMatchRow } from "@/hooks/useMonitorMatches"

interface MonitorMatchesDialogProps {
  monitor: MonitorMatchTarget | null
  matches: MonitorMatchRow[]
  loading: boolean
  limited: boolean
  newCount: number
  error: string | null
  checkedAt: string | null
  neverScanned: boolean
  lastError: string | null
  rescanning: boolean
  onRescan: () => void
  onClose: () => void
}

function freshnessText(checkedAt: string | null, neverScanned: boolean, lastError: string | null): string {
  if (neverScanned) return "Not yet scanned."
  if (lastError) {
    return checkedAt
      ? `Last check failed: ${lastError} — showing results from ${formatRelativeTime(checkedAt)}.`
      : `Last check failed: ${lastError}`
  }
  return checkedAt ? `Last checked ${formatRelativeTime(checkedAt)}.` : ""
}

export function MonitorMatchesDialog({
  monitor, matches, loading, limited, newCount, error,
  checkedAt, neverScanned, lastError, rescanning, onRescan, onClose,
}: MonitorMatchesDialogProps) {
  return (
    <Dialog open={monitor !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-4">
            <DialogTitle>Matches — {monitor?.name}</DialogTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={onRescan}
              disabled={rescanning || loading}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${rescanning ? 'animate-spin' : ''}`} />
              Rescan now
            </Button>
          </div>
          <DialogDescription>
            {!error && freshnessText(checkedAt, neverScanned, lastError)}
            {!error && newCount > 0 && ` ${newCount} new since your last view.`}
            {!error && limited && ` Showing first ${matches.length} — more may exist.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            /* Must come before the empty-state branch: a failed request is not
               evidence of zero matches, and rendering "No current matches"
               for one is an authoritative false negative. */
            <Alert variant="destructive" className="my-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : neverScanned ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Not yet scanned — click &quot;Rescan now&quot; to check.
            </p>
          ) : matches.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No current matches.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background border-b">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2 font-medium">URL</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Password</th>
                  <th className="px-3 py-2 font-medium">Domain</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m, i) => (
                  <tr key={i} className="border-b hover:bg-muted/40">
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-muted-foreground" title={m.url}>{m.url}</td>
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-xs" title={m.email}>{m.email}</td>
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-xs font-medium" title={m.password}>{m.password}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className="text-xs font-normal">{m.domain}</Badge>
                      {m.is_new && (
                        <Badge className="text-xs font-normal ml-1.5 bg-primary/10 text-primary border-primary/20">NEW</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/monitor-matches-dialog.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Update both callers**

In `app/monitoring/page.tsx` and `app/saved-searches/page.tsx`, find the `<MonitorMatchesDialog ... />` usage (both destructure `useMonitorMatches()`'s return value already) and add the five new props, pulling from the hook's now-extended return value:

```typescript
<MonitorMatchesDialog
  monitor={matchesMonitor}
  matches={matches}
  loading={matchesLoading}
  limited={matchesLimited}
  newCount={matchesNewCount}
  error={matchesError}
  checkedAt={checkedAt}
  neverScanned={neverScanned}
  lastError={lastError}
  rescanning={rescanning}
  onRescan={rescanNow}
  onClose={closeMatches}
/>
```

(Match the exact existing prop-passing style/indentation in each file — this is additive to an existing JSX block, not a new one.) Update each file's destructuring of `useMonitorMatches()` to include `checkedAt, neverScanned, lastError, rescanning, rescanNow` alongside the fields it already pulls out.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS across the whole suite — this is the last task, so this is the first point a full clean run confirms nothing earlier broke silently.

- [ ] **Step 7: Manual verification in the browser**

Rebuild/redeploy (Task 4 Step 3 commands), then open `/saved-searches`, click into the "Dedicated / general hardware wallets" monitor, confirm: the dialog opens instantly (no multi-minute wait), shows either "Not yet scanned" or real matches with a "Last checked" timestamp, and clicking "Rescan now" shows the spin state then updates the timestamp/results without closing the dialog.

- [ ] **Step 8: Commit**

```bash
git add components/monitor-matches-dialog.tsx app/monitoring/page.tsx app/saved-searches/page.tsx __tests__/monitor-matches-dialog.test.ts
git commit -m "feat(monitoring): show cache freshness + Rescan now button in the matches dialog"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (query fix) → Tasks 3–4. §2 (schema) → Task 1. §3 (cron) → Task 7. §4 (API) → Tasks 8–9. §5 (UI) → Tasks 10–11. §6 (normalization) → Task 2. All six spec sections have a task.
- **Type consistency checked:** `ResolvedMatches`/`resolveMonitorMatches` (Task 5) is consumed identically by the live route (Task 5), the cron (Task 7), and the rescan route (Task 8) — same `{ mode, domains } -> { rows, limited }` shape throughout. `MonitorMatchesCacheEntry` (Task 6) is consumed identically by the GET route (Task 9) and the rescan route (Task 8). `MatchesApiResponse` (Task 10) matches the field names both `route.ts` (Task 9) and `rescan/route.ts` (Task 8) actually return (`checked_at`, `never_scanned`, `last_error` — snake_case over the wire, camelCase in hook state, consistent with the existing `new_count`/`total_shown` precedent already in this API).
- **No placeholders:** every step above has complete code, not a description of code.
