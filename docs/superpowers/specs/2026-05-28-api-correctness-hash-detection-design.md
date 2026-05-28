# API Correctness + Hash Detection Design

## Goal

Fix two gaps discovered during a gap-analysis research pass on BronVault:

1. **NORM_EXPR in v1 API WHERE clauses** — four external API endpoints compare against raw
   stored columns (`email`, `domain`), which silently misses corrupted rows (Cases A–D) until
   the background ALTER TABLE UPDATE mutations finish rewriting them.
2. **`is_hashed` materialized column + UI filter** — no way to distinguish plaintext passwords
   from MD5/SHA-1/NTLM/bcrypt/Argon2 hashes in the credentials browser or via the API.

---

## Scope

### Not in scope
- Changing the v1 SELECT lists (NORM_COLS already applied in internal browser; mutations
  will eventually fix stored values).
- Typed hash classification (enum of `md5`/`sha1`/`bcrypt` etc.) — boolean flag chosen for
  simplicity; sufficient for the primary use-case (filter out hashes in search results).
- Webhook reliability, compressed file formats, or password pattern analysis — separate specs.

---

## Section 1 — `is_hashed UInt8` materialized column

### ClickHouse expression

```sql
is_hashed UInt8 MATERIALIZED multiIf(
  match(password, '^[0-9a-fA-F]{32}$'),  1,   -- MD5 / NTLM (32 hex chars)
  match(password, '^[0-9a-fA-F]{40}$'),  1,   -- SHA-1 (40 hex chars)
  match(password, '^[0-9a-fA-F]{64}$'),  1,   -- SHA-256 (64 hex chars)
  match(password, '^[0-9a-fA-F]{128}$'), 1,   -- SHA-512 (128 hex chars)
  startsWith(password, '$2'),            1,   -- bcrypt ($2a$/$2b$/$2y$)
  startsWith(password, '$argon2'),       1,   -- Argon2id / Argon2i / Argon2d
  startsWith(password, '$1$'),           1,   -- MD5-crypt (Linux legacy)
  startsWith(password, '$5$'),           1,   -- SHA-256-crypt
  startsWith(password, '$6$'),           1,   -- SHA-512-crypt
  startsWith(password, '$P$'),           1,   -- phpBB / WordPress phpass
  0
)
```

### Delivery

- **`docker/clickhouse/init/01-ulp-tables.sql`** — column added to the `CREATE TABLE` block for
  fresh Docker installs.
- **`lib/clickhouse-migrations.ts`** — idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  followed by a fire-and-forget `ALTER TABLE ... MATERIALIZE COLUMN` mutation. Follows the
  exact same pattern as `password_entropy_band` already in the file.

### Mirror function for testing

A new `lib/password-hashes.ts` exports `isHashedPassword(password: string): boolean`
implementing identical logic in TypeScript. This allows full unit-test coverage without a
running ClickHouse instance.

```ts
export function isHashedPassword(pw: string): boolean {
  if (/^[0-9a-fA-F]{32}$/.test(pw))  return true  // MD5 / NTLM
  if (/^[0-9a-fA-F]{40}$/.test(pw))  return true  // SHA-1
  if (/^[0-9a-fA-F]{64}$/.test(pw))  return true  // SHA-256
  if (/^[0-9a-fA-F]{128}$/.test(pw)) return true  // SHA-512
  if (pw.startsWith('$2'))      return true  // bcrypt
  if (pw.startsWith('$argon2')) return true  // Argon2
  if (pw.startsWith('$1$'))     return true  // MD5-crypt
  if (pw.startsWith('$5$'))     return true  // SHA-256-crypt
  if (pw.startsWith('$6$'))     return true  // SHA-512-crypt
  if (pw.startsWith('$P$'))     return true  // phpass
  return false
}
```

Tests in `__tests__/password-hashes.test.ts` — at least 30 cases covering:
- True positives for each of the 10 hash families
- Boundary cases (31 hex chars → false, 33 hex chars → false)
- Mixed-case hex (uppercase letters → true)
- Short bcrypt prefix without dollar-sign ($2 with 1 char → no match after prefix)
- Plaintext passwords (common words, symbols, numbers) → false

---

## Section 2 — NORM_EXPR in v1 API WHERE clauses

### Problem

Four external API endpoints query the raw `email` or `domain` column directly. Corrupted rows
(Case A–D) have wrong values in these columns until background mutations complete:

| Case | Raw `email` | Raw `domain` |
|---|---|---|
| A (jsessionid) | `jsessionid=TOKEN:SRV:USER:PASS` | wrong (derived from malformed url) |
| B (CC-prefix) | correct | wrong (derived from `CC https://...`) |
| C (scheme-split) | `//host/path username` | `https` |
| D (blank-tab) | contains URL path | empty |

### Fix

Replace raw column references in WHERE with `NORM_EMAIL_EXPR` / `NORM_DOMAIN_EXPR` imported
from `@/lib/ulp-normalize`. The expressions already exist and are used in `ORDER BY` clauses
and the internal `SELECT` list — this extends their use to `WHERE`.

Once mutations rewrite all corrupted rows, the `if(...)` guards in those expressions resolve
to their `else` branches (`email` / `domain`) and the overhead disappears.

### Files changed

#### `app/api/v1/lookup/route.ts`
```ts
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'

// email lookup
WHERE (${NORM_EMAIL_EXPR}) = {email:String}

// domain lookup
WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}
```

#### `app/api/v1/lookup/batch/route.ts`
```ts
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'

// email batch
WHERE (${NORM_EMAIL_EXPR}) IN (${emailList})

// domain batch
WHERE (${NORM_DOMAIN_EXPR}) IN (${domainList})
```

The post-query JS grouping (`rows.filter(r => r.email === lc)`) must also switch to the
normalized value returned in the SELECT. Since NORM_COLS aliases remain `email` and `domain`,
the JS filter is unchanged — but the SELECT must include the normalized column. A NORM_COLS
fragment is added to both SELECT lists in this file.

#### `app/api/v1/search/domain/route.ts`
```ts
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'

WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}   -- applied to both count + data query
```

#### `app/api/credentials/route.ts`
```ts
import { NORM_COLS, NORM_DOMAIN_EXPR, NORM_EMAIL_EXPR } from '@/lib/ulp-normalize'
// (already imported — just extend the existing import)

// domain filter
conditions.push(`(${NORM_DOMAIN_EXPR}) = {domain:String}`)
```

---

## Section 3 — `is_hashed` filter in the credentials browser

### API (`app/api/credentials/route.ts`)

New query param `is_hashed`:
- `is_hashed=1` → `WHERE is_hashed = 1` (hashes only)
- `is_hashed=0` → `WHERE is_hashed = 0` (plaintext only)
- absent / empty → no constraint

`is_hashed` is a stored `UInt8` materialized column. ClickHouse automatically creates a
`set(0)` skip index compatible condition when filtering on low-cardinality UInt8 columns;
no explicit skip index declaration is needed.

### UI (`app/credentials/page.tsx`)

1. Add `is_hashed: number` to the `Credential` interface.
2. Add `isHashed` state: `'' | '1' | '0'`, default `''`.
3. Wire `isHashed` into `buildParams`: `if (isHashed) ps.set('is_hashed', isHashed)`.
4. Add to `clearAll`: reset `isHashed` to `''`.
5. Add a three-state toggle chip in the filter panel (next to the `is_corporate` chip):
   - **All** (isHashed = '') — no badge
   - **Plaintext only** (isHashed = '0') — emerald chip
   - **Hashed only** (isHashed = '1') — amber chip with `KeyRound` icon

The chip cycles on click: `'' → '0' → '1' → ''`. Fires `load(1, { isHashed: next })` using
the same override pattern as all other filter state.

`buildParams` and `load` gain `isHashed` in their `overrides` parameter type.

---

## File Map

| File | Action |
|---|---|
| `docker/clickhouse/init/01-ulp-tables.sql` | Add `is_hashed` to `CREATE TABLE` |
| `lib/clickhouse-migrations.ts` | ADD COLUMN + MATERIALIZE migration |
| `lib/password-hashes.ts` | **New** — `isHashedPassword()` mirror function |
| `__tests__/password-hashes.test.ts` | **New** — 30+ unit tests |
| `app/api/v1/lookup/route.ts` | NORM_EMAIL_EXPR + NORM_DOMAIN_EXPR in WHERE |
| `app/api/v1/lookup/batch/route.ts` | NORM_EMAIL_EXPR + NORM_DOMAIN_EXPR in WHERE + NORM_COLS in SELECT |
| `app/api/v1/search/domain/route.ts` | NORM_DOMAIN_EXPR in WHERE (count + data) |
| `app/api/credentials/route.ts` | NORM_DOMAIN_EXPR in domain WHERE + `is_hashed` param |
| `app/credentials/page.tsx` | `is_hashed` filter chip + interface + buildParams update |

---

## Testing

- `__tests__/password-hashes.test.ts` — unit tests for `isHashedPassword()`; 30+ cases
- Existing 355 tests must continue to pass
- `tsc --noEmit` must pass
