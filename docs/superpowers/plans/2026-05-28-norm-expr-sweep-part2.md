# NORM_EXPR Sweep Part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two remaining raw `domain =` WHERE comparisons that miss Cases A–D corrupted rows in live-upload monitor checks and credential exports.

**Architecture:** Two one-line edits in existing files, plus one new test file. `lib/domain-monitor.ts` needs a new import (`NORM_DOMAIN_EXPR`) as well as the WHERE fix. `app/api/export/route.ts` already imports `NORM_DOMAIN_EXPR` — only the WHERE line changes. Both files' fixes follow the identical pattern used in the previous NORM_EXPR cycle.

**Tech Stack:** Next.js 14, ClickHouse SQL template literals, Vitest (`npm test`), TypeScript (`npx tsc --noEmit`)

---

## File Map

| File | Action |
|---|---|
| `__tests__/norm-expr-sweep-part2.test.ts` | Create — verifies WHERE fragments use NORM_DOMAIN_EXPR |
| `lib/domain-monitor.ts` | Modify — add NORM_DOMAIN_EXPR import + fix WHERE clause (line ~395) |
| `app/api/export/route.ts` | Modify — fix domain filter WHERE clause (line ~88) |

---

### Task 1: Test file

**Files:**
- Create: `__tests__/norm-expr-sweep-part2.test.ts`

- [ ] **Step 1: Write the test file**

```ts
/**
 * Tests for NORM_EXPR sweep part 2.
 *
 * Coverage:
 *  - domain-monitor WHERE fragment uses NORM_DOMAIN_EXPR, not raw 'domain'
 *  - export route WHERE fragment uses NORM_DOMAIN_EXPR, not raw 'domain'
 */

import { describe, test, expect } from 'vitest'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'

// ─────────────────────────────────────────────────────────────────────────────
// § 1  domain-monitor live-upload WHERE fragment
// ─────────────────────────────────────────────────────────────────────────────

describe('domain-monitor WHERE fragment', () => {
  const whereFragment = `(${NORM_DOMAIN_EXPR}) = {domain:String} OR endsWith(lower(${NORM_DOMAIN_EXPR}), {emailSuffix:String})`

  test('contains if( — uses normalizing expression not raw column', () => {
    expect(whereFragment).toContain('if(')
  })

  test('does not start with bare "domain ="', () => {
    expect(whereFragment.trimStart()).not.toMatch(/^domain\s*=/)
  })

  test('contains {domain:String} parameter placeholder', () => {
    expect(whereFragment).toContain('{domain:String}')
  })

  test('contains {emailSuffix:String} parameter placeholder', () => {
    expect(whereFragment).toContain('{emailSuffix:String}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// § 2  export route domain filter WHERE fragment
// ─────────────────────────────────────────────────────────────────────────────

describe('export route domain filter WHERE fragment', () => {
  const whereFragment = ` AND (${NORM_DOMAIN_EXPR}) = {exportDomain:String}`

  test('contains if( — uses normalizing expression not raw column', () => {
    expect(whereFragment).toContain('if(')
  })

  test('does not contain bare "domain ="', () => {
    expect(whereFragment).not.toMatch(/\bdomain\s*=\s*\{/)
  })

  test('contains {exportDomain:String} parameter placeholder', () => {
    expect(whereFragment).toContain('{exportDomain:String}')
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
npm test -- __tests__/norm-expr-sweep-part2.test.ts
```

Expected output:
```
✓ domain-monitor WHERE fragment > contains if( — uses normalizing expression not raw column
✓ domain-monitor WHERE fragment > does not start with bare "domain ="
✓ domain-monitor WHERE fragment > contains {domain:String} parameter placeholder
✓ domain-monitor WHERE fragment > contains {emailSuffix:String} parameter placeholder
✓ export route domain filter WHERE fragment > contains if( — uses normalizing expression not raw column
✓ export route domain filter WHERE fragment > does not contain bare "domain ="
✓ export route domain filter WHERE fragment > contains {exportDomain:String} parameter placeholder

Test Files  1 passed (1)
     Tests  7 passed (7)
```

(These tests verify the NORM_DOMAIN_EXPR shape — they pass as soon as the file exists because the expression is correct. The WHERE fragments are built in-test, not from production code — this validates the expression has the right shape before we wire it in.)

- [ ] **Step 3: Commit**

```bash
git add __tests__/norm-expr-sweep-part2.test.ts
git commit -m "test(normalize): add WHERE fragment tests for domain-monitor + export route"
```

---

### Task 2: Fix lib/domain-monitor.ts

**Files:**
- Modify: `lib/domain-monitor.ts` (top of file + line ~395)

Context: `lib/domain-monitor.ts` currently has no import from `@/lib/ulp-normalize`. The query on line ~395 checks `domain = {domain:String}` and `endsWith(lower(email), ...)` using raw columns. Both must be replaced with `NORM_DOMAIN_EXPR`.

- [ ] **Step 1: Add import at top of file**

Current top of file:
```ts
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import crypto from 'crypto'
```

Change to:
```ts
import { dbQuery, dbGet, dbRun } from '@/lib/sqlite'
import { executeQuery as executeClickHouseQuery } from '@/lib/clickhouse'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
import crypto from 'crypto'
```

- [ ] **Step 2: Fix the WHERE clause**

Find this block (inside `checkMonitorsForULPUpload`, inside the `for (const domain of monitor.domains)` loop):
```ts
          const rows = await executeClickHouseQuery(
            `SELECT url, email, password, domain
             FROM ulp.credentials
             WHERE source_file = {sourceFile:String}
               AND (domain = {domain:String} OR endsWith(lower(email), {emailSuffix:String}))
             LIMIT 100`,
            { sourceFile, domain: d, emailSuffix: `@${d}` }
          ) as Array<{ url: string; email: string; password: string; domain: string }>
```

Replace with:
```ts
          const rows = await executeClickHouseQuery(
            `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
             FROM ulp.credentials
             WHERE source_file = {sourceFile:String}
               AND ((${NORM_DOMAIN_EXPR}) = {domain:String} OR endsWith(lower(${NORM_DOMAIN_EXPR}), {emailSuffix:String}))
             LIMIT 100`,
            { sourceFile, domain: d, emailSuffix: `@${d}` }
          ) as Array<{ url: string; email: string; password: string; domain: string }>
```

Note: The SELECT also changes from `domain` to `(${NORM_DOMAIN_EXPR}) AS domain` so the returned `domain` field is the normalized value, consistent with the rest of the codebase.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: `Tests 380 passed (380)` (373 existing + 7 new)

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 5: Commit**

```bash
git add lib/domain-monitor.ts
git commit -m "fix(domain-monitor): use NORM_DOMAIN_EXPR in live-upload monitor WHERE clause"
```

---

### Task 3: Fix app/api/export/route.ts

**Files:**
- Modify: `app/api/export/route.ts` (line ~88)

Context: `NORM_DOMAIN_EXPR` is already imported at the top of this file. Only one line changes in the POST handler's domain filter.

- [ ] **Step 1: Fix the domain filter line**

Find (inside the POST handler, around line 88):
```ts
  if (domain)      { extras.push(' AND domain = {exportDomain:String}');     mergedParams.exportDomain = domain }
```

Replace with:
```ts
  if (domain)      { extras.push(` AND (${NORM_DOMAIN_EXPR}) = {exportDomain:String}`);     mergedParams.exportDomain = domain }
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: `Tests 380 passed (380)`

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 4: Commit**

```bash
git add app/api/export/route.ts
git commit -m "fix(export): use NORM_DOMAIN_EXPR in domain filter WHERE clause"
```

---

### Task 4: Final verification

**Files:** None modified.

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected:
```
Test Files  6 passed (6)
     Tests  380 passed (380)
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 3: Verify commits**

```bash
git log --oneline -5
```

Expected (most recent first):
```
<sha>  fix(export): use NORM_DOMAIN_EXPR in domain filter WHERE clause
<sha>  fix(domain-monitor): use NORM_DOMAIN_EXPR in live-upload monitor WHERE clause
<sha>  test(normalize): add WHERE fragment tests for domain-monitor + export route
<sha>  docs: add NORM_EXPR sweep part 2 spec (domain-monitor + export route)
```
