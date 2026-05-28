# API Correctness — NORM_EXPR in v1 API WHERE Clauses

## Goal

Fix a correctness bug in four external v1 API endpoints: they compare against raw stored
columns (`email`, `domain`) and silently miss corrupted rows (Cases A–D) until the background
ALTER TABLE UPDATE mutations finish rewriting them.

## What was dropped

`is_hashed` materialized column and UI filter were removed from this spec after querying the
live database: only 31,755 of 58,024,481 rows (0.055%) contain hashed passwords. All source
files are plaintext Telegram-distributed ULP combo lists from infostealers. Hash detection
adds zero value for this ingestion pipeline.

---

## Background — Corrupted Row Cases

| Case | Symptom | Raw `email` | Raw `domain` |
|---|---|---|---|
| A (jsessionid) | Bank session rows | `jsessionid=TOKEN:SRV:USER:PASS` | derived from malformed url |
| B (CC-prefix) | Country-code leaked into url | correct | derived from `CC https://…` |
| C (scheme-split) | URL scheme split from path | `//host/path username` | `https` |
| D (blank-tab) | Empty leading tab field | contains URL path | empty |

`NORM_EMAIL_EXPR` and `NORM_DOMAIN_EXPR` (from `lib/ulp-normalize.ts`) already correct these
at query time and are used in `ORDER BY` and `SELECT` throughout the internal browser. This
spec extends their use to `WHERE` clauses in the v1 API.

Once the background `ALTER TABLE UPDATE` mutations complete, all `if(…)` guards in the NORM
expressions resolve to their `else` branches (`email` / `domain`) — zero long-term overhead.

---

## Files Changed

### `app/api/v1/lookup/route.ts`

Add import:
```ts
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
```

Email lookup WHERE:
```ts
// before
WHERE email = {email:String}

// after
WHERE (${NORM_EMAIL_EXPR}) = {email:String}
```

Domain lookup WHERE:
```ts
// before
WHERE domain = {domain:String}

// after
WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}
```

---

### `app/api/v1/lookup/batch/route.ts`

Add import:
```ts
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
```

Email batch WHERE:
```ts
// before
WHERE email IN (${emailList})

// after
WHERE (${NORM_EMAIL_EXPR}) IN (${emailList})
```

Domain batch WHERE:
```ts
// before
WHERE domain IN (${domainList})

// after
WHERE (${NORM_DOMAIN_EXPR}) IN (${domainList})
```

Post-query JS grouping filters by `r.email` / `r.domain`. The NORM expressions are aliased
`email` and `domain` in NORM_COLS, but these two endpoints don't use NORM_COLS in SELECT —
they select raw columns. After fixing WHERE, add NORM_COLS to both SELECT lists so the
returned `email`/`domain` values are also corrected and the JS `.filter()` grouping matches.

---

### `app/api/v1/search/domain/route.ts`

Add import:
```ts
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
```

Both the count query and the data query:
```ts
// before
WHERE domain = {domain:String}

// after
WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}
```

---

### `app/api/credentials/route.ts` (internal browser)

`NORM_DOMAIN_EXPR` is already imported. Extend to the domain filter WHERE:

```ts
// before
conditions.push('domain = {domain:String}')

// after
conditions.push(`(${NORM_DOMAIN_EXPR}) = {domain:String}`)
```

---

## File Map

| File | Change |
|---|---|
| `app/api/v1/lookup/route.ts` | NORM_EMAIL_EXPR + NORM_DOMAIN_EXPR in WHERE |
| `app/api/v1/lookup/batch/route.ts` | NORM_EMAIL_EXPR + NORM_DOMAIN_EXPR in WHERE + NORM_COLS in SELECT |
| `app/api/v1/search/domain/route.ts` | NORM_DOMAIN_EXPR in WHERE (count + data query) |
| `app/api/credentials/route.ts` | NORM_DOMAIN_EXPR in domain filter WHERE |

No schema changes. No new files. No migration required.

---

## Testing

- All 355 existing tests must continue to pass
- `tsc --noEmit` must pass
- New unit tests in `__tests__/ulp-normalize-where.test.ts` verifying that the NORM_EXPR
  strings produced for each Case (A–D) correctly resolve to the expected email/domain value
