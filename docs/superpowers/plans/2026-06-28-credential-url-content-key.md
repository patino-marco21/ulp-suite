# Credential URL Content-Key Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the credential content-dedup key — used by the browser's Unique view and by the two storage-level purge mechanisms — treat URL scheme (`http`/`https`/none) and a trailing slash as equivalent, so the same credential captured with different transport/path-formatting artifacts is recognized as one duplicate everywhere it's checked.

**Architecture:** One new shared primitive, `lib/url-content-key.ts`, exports the normalized URL expression. Both TypeScript consumers (`lib/ulp-dedupe.ts` for the view, `lib/content-dedup.ts` for the destructive daily cron) import it instead of using the bare `url` column. The bash-only `scripts/dedup-credentials-content.sh` gets the identical expression hand-copied, since it can't import TS. Survivor-selection logic, every existing safety gate, and every other column comparison (`email`, `password`) are untouched.

**Tech Stack:** TypeScript, ClickHouse 26.x (RE2 regex engine), Vitest, Bash.

## Global Constraints

- Only the `url` column's comparison changes; `email` and `password` remain byte-exact.
- Only URL scheme and a single trailing slash are normalized — path, query string, and other case are untouched.
- All three existing consumers (`lib/ulp-dedupe.ts`, `lib/content-dedup.ts`, `scripts/dedup-credentials-content.sh`) use the identical normalization expression.
- Survivor-selection logic in both destructive surfaces is unchanged.
- No existing safety gate changes: `CONTENT_DEDUP_APPLY` default, `minExcessToApply` threshold, the script's dry-run-by-default behavior.
- Production deployment of the cron change requires confirming the live `CONTENT_DEDUP_APPLY` value first (Task 6).
- Nothing is pushed to `origin/main` without explicit user confirmation, per standing project policy.

---

### Task 1: Shared URL Content-Key Primitive

**Files:**
- Create: `lib/url-content-key.ts`
- Test: `__tests__/url-content-key.test.ts`

**Interfaces:**
- Produces: `URL_CONTENT_KEY: string` — a ClickHouse SQL expression fragment.
- Consumes: nothing (pure constant).

- [x] **Step 1: Write the failing test**

Create `__tests__/url-content-key.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

describe('url-content-key', () => {
  test('strips a leading http:// or https:// (case-insensitive) and one trailing slash from url', () => {
    expect(URL_CONTENT_KEY).toBe(
      `replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '')`
    )
  })
})
```

- [x] **Step 2: Run the test and confirm RED**

Run:

```bash
npm test -- __tests__/url-content-key.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/url-content-key'` (the file does not exist yet).

- [x] **Step 3: Write the minimal implementation**

Create `lib/url-content-key.ts`:

```ts
/**
 * Scheme- and trailing-slash-insensitive form of a credential's `url` column.
 * This is the URL component of the content-identity key shared by:
 *  - lib/ulp-dedupe.ts                     (view-level browser dedupe, reversible)
 *  - lib/content-dedup.ts                  (daily cron, destructive ALTER TABLE DELETE)
 *  - scripts/dedup-credentials-content.sh  (manual purge, destructive — hand-copy this
 *    exact expression there too; bash can't import TS)
 *
 * The same physical credential is often captured with a different or missing
 * scheme, or a trailing slash, depending on what the logging tool recorded at
 * capture time — not a deliberate distinction in the credential itself.
 * url_scheme remains its own column for anyone who wants it; this key never
 * touches it. Path, query string, and case elsewhere in the URL are untouched.
 *
 * (?i:...) is RE2's scoped case-insensitive non-capturing group. If a future
 * ClickHouse upgrade ever rejects this syntax, drop the (?i:...) and match
 * '^https?://' alone — every example seen in this dataset already uses a
 * lowercase scheme.
 */
export const URL_CONTENT_KEY =
  `replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '')`
```

- [x] **Step 4: Run the test and confirm GREEN**

Run:

```bash
npm test -- __tests__/url-content-key.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 5: Verify the regex semantics against real ClickHouse** — NOT DONE: no Docker daemon reachable from the dev machine that implemented Tasks 1-5 (confirmed twice, by me and independently by the Task 1 implementer subagent). Still required before Task 4's `APPLY=1` is ever considered, and before fully trusting the `(?i:...)` syntax in production. Do this on a host with ClickHouse access before going further than the dry-run.

This requires Docker/ClickHouse access. If unavailable in your current environment, leave this checkbox open and do it before Task 4's dry-run (Task 4 depends on this syntax being confirmed).

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT replaceRegexpOne(replaceRegexpOne('HTTPS://Example.com/Login/', '^(?i:https?://)', ''), '/\$', '') AS mixed_case_with_slash, replaceRegexpOne(replaceRegexpOne('Example.com/Login', '^(?i:https?://)', ''), '/\$', '') AS already_bare"
```

Expected: both columns return `Example.com/Login` — proving a mixed-case scheme plus trailing slash collapses to the same key as the already-bare form.

If this errors instead (RE2 rejects the `(?i:...)` syntax): open `lib/url-content-key.ts`, replace `'^(?i:https?://)'` with `'^https?://'`, re-run the query above using `'https://Example.com/Login/'` (lowercase scheme) in place of the mixed-case literal, confirm it now returns `Example.com/Login`, then redo Steps 1–4 with the lowercase-only pattern (update the test's expected string to match) before continuing to Task 2.

- [x] **Step 6: Commit** — `4b3d821`

```bash
git add lib/url-content-key.ts __tests__/url-content-key.test.ts
git commit -m "feat(dedupe): add shared scheme/slash-insensitive URL content key"
```

---

### Task 2: View-Level Dedupe (`lib/ulp-dedupe.ts`)

**Files:**
- Modify: `lib/ulp-dedupe.ts`
- Modify: `__tests__/ulp-dedupe.test.ts`

**Interfaces:**
- Consumes: `URL_CONTENT_KEY` from `lib/url-content-key.ts`.
- Produces: unchanged exports `DEDUPE_BY: string`, `dedupeLimitBy(dedupe: boolean): string`, `dedupeCountExpr(dedupe: boolean): string` — same names and signatures, new underlying value. No caller (e.g. `app/api/credentials/route.ts`) needs to change.

- [x] **Step 1: Update the test to expect the new key (RED)**

Replace `__tests__/ulp-dedupe.test.ts` entirely:

```ts
import { describe, test, expect } from 'vitest'
import { DEDUPE_BY, dedupeLimitBy, dedupeCountExpr } from '@/lib/ulp-dedupe'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

describe('ulp-dedupe', () => {
  test('DEDUPE_BY is the content key (scheme/slash-insensitive url, email, password)', () => {
    expect(DEDUPE_BY).toBe(`${URL_CONTENT_KEY}, email, password`)
  })

  describe('dedupeLimitBy', () => {
    test('emits `LIMIT 1 BY <content key>` when deduping', () => {
      expect(dedupeLimitBy(true)).toBe(`LIMIT 1 BY ${URL_CONTENT_KEY}, email, password`)
    })
    test('emits nothing when not deduping (keep every copy)', () => {
      expect(dedupeLimitBy(false)).toBe('')
    })
  })

  describe('dedupeCountExpr', () => {
    test('counts distinct credentials via uniq() when deduping', () => {
      expect(dedupeCountExpr(true)).toBe(`uniq(${URL_CONTENT_KEY}, email, password)`)
    })
    test('plain count() when not deduping', () => {
      expect(dedupeCountExpr(false)).toBe('count()')
    })
  })
})
```

- [x] **Step 2: Run the test and confirm RED**

Run:

```bash
npm test -- __tests__/ulp-dedupe.test.ts
```

Expected: FAIL — `DEDUPE_BY` still equals the old literal `'url, email, password'`, not the new expression.

- [x] **Step 3: Update the implementation**

In `lib/ulp-dedupe.ts`, add the import at the top and replace the `DEDUPE_BY` export:

```ts
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
```

```ts
export const DEDUPE_BY = `${URL_CONTENT_KEY}, email, password`
```

`dedupeLimitBy` and `dedupeCountExpr` are unchanged — they already just interpolate `DEDUPE_BY`.

Also update the file's top-of-file doc comment — change:

```
 * "Exact duplicate" = same destination + same credential: identical
 * (url, email, password). These survive in storage because every storage-level
```

to:

```
 * "Exact duplicate" = same destination + same credential: identical
 * (url, email, password), where url is compared scheme- and
 * trailing-slash-insensitively (see lib/url-content-key.ts) — http://,
 * https://, and no-scheme captures of the same host+path collapse to one row.
 * These survive in storage because every storage-level
```

- [x] **Step 4: Run the test and confirm GREEN**

Run:

```bash
npm test -- __tests__/ulp-dedupe.test.ts
```

Expected: PASS (5 tests).

- [x] **Step 5: Commit** — `e2f648f` (plus a tiny follow-up `e47909d` fixing two stale inline comments the code-quality reviewer caught)

```bash
git add lib/ulp-dedupe.ts __tests__/ulp-dedupe.test.ts
git commit -m "fix(credentials): ignore url scheme/trailing-slash in browser dedupe view"
```

---

### Task 3: Storage-Level Cron (`lib/content-dedup.ts`)

**Files:**
- Modify: `lib/content-dedup.ts`
- Modify: `__tests__/content-dedup.test.ts`

**Interfaces:**
- Consumes: `URL_CONTENT_KEY` from `lib/url-content-key.ts`.
- Produces: unchanged exports `CONTENT_KEY: string`, `buildStatsSql()`, `buildDeleteSql()` — same names and signatures, new underlying value. `FULL_HASH`, `CONTENT_DUPLICATE_PREDICATE`, `MUTATION_MARKER`, and every cron-config function (`dedupCronHours`, `contentDedupApplyEnabled`, `minExcessToApply`, `dedupCronHourUtc`, `runContentDedupTick`) are untouched — they already derive from `CONTENT_KEY`.

- [x] **Step 1: Update the test to expect the new key (RED)**

Replace `__tests__/content-dedup.test.ts` entirely:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import {
  CONTENT_KEY,
  buildStatsSql,
  buildDeleteSql,
  dedupCronHours,
  dedupCronHourUtc,
  contentDedupApplyEnabled,
  minExcessToApply,
} from '@/lib/content-dedup'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

describe('content-dedup', () => {
  test('does not claim that an import-time hook still triggers content dedup', () => {
    const source = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('post-import hook')
  })
  test('CONTENT_KEY ignores url scheme/trailing-slash (email, password stay exact)', () => {
    expect(CONTENT_KEY).toBe(`${URL_CONTENT_KEY}, email, password`)
  })

  describe('buildDeleteSql', () => {
    const sql = buildDeleteSql()
    test('is an ALTER TABLE … DELETE on ulp.credentials', () => {
      expect(sql.startsWith('ALTER TABLE ulp.credentials DELETE WHERE')).toBe(true)
    })
    test('keeps one survivor per content group (min full-hash, grouped by content)', () => {
      expect(sql).toContain('NOT IN (SELECT min(')
      expect(sql).toContain(`GROUP BY ${URL_CONTENT_KEY}, email, password`)
    })
  })

  describe('buildStatsSql', () => {
    const sql = buildStatsSql()
    test('reports total and excess in one pass without the duplicate subquery', () => {
      expect(sql).toContain(`uniqExact(cityHash64(${URL_CONTENT_KEY}, email, password))`)
      expect(sql).toContain('AS excess')
      expect(sql).not.toContain('AS deletable')
      expect(sql).not.toContain('countIf(')
    })
  })

  describe('dedupCronHours', () => {
    test('defaults to 24h', () => {
      expect(dedupCronHours({})).toBe(24)
    })
    test('honors a positive value', () => {
      expect(dedupCronHours({ DEDUP_CRON_HOURS: '6' })).toBe(6)
    })
    test('0 / invalid disables (returns 0)', () => {
      expect(dedupCronHours({ DEDUP_CRON_HOURS: '0' })).toBe(0)
      expect(dedupCronHours({ DEDUP_CRON_HOURS: 'nope' })).toBe(0)
    })
  })

  describe('contentDedupApplyEnabled', () => {
    test('off by default (report-only)', () => {
      expect(contentDedupApplyEnabled({})).toBe(false)
      expect(contentDedupApplyEnabled({ CONTENT_DEDUP_APPLY: 'false' })).toBe(false)
    })
    test('on for "true" or "1"', () => {
      expect(contentDedupApplyEnabled({ CONTENT_DEDUP_APPLY: 'true' })).toBe(true)
      expect(contentDedupApplyEnabled({ CONTENT_DEDUP_APPLY: '1' })).toBe(true)
    })
  })

  describe('minExcessToApply', () => {
    test('defaults to 1000', () => {
      expect(minExcessToApply({})).toBe(1000)
    })
    test('honors a custom threshold', () => {
      expect(minExcessToApply({ DEDUP_MIN_EXCESS: '50' })).toBe(50)
    })
  })

  describe('dedupCronHourUtc', () => {
    test('defaults to 4 (04:00 UTC)', () => {
      expect(dedupCronHourUtc({})).toBe(4)
    })
    test('honors a configured hour', () => {
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: '9' })).toBe(9)
    })
    test('out-of-range or invalid falls back to 4', () => {
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: '24' })).toBe(4)
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: '-1' })).toBe(4)
      expect(dedupCronHourUtc({ DEDUP_CRON_HOUR_UTC: 'nope' })).toBe(4)
    })
  })
})
```

- [x] **Step 2: Run the test and confirm RED**

Run:

```bash
npm test -- __tests__/content-dedup.test.ts
```

Expected: FAIL on the `CONTENT_KEY`, `buildDeleteSql`, and `buildStatsSql` assertions — `CONTENT_KEY` still equals the old literal `'url, email, password'`.

- [x] **Step 3: Update the implementation**

In `lib/content-dedup.ts`, add the import alongside the existing one and replace the `CONTENT_KEY` export:

```ts
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
```

```ts
/** Content identity: same destination + same credential (scheme/trailing-slash-insensitive on the URL). */
export const CONTENT_KEY = `${URL_CONTENT_KEY}, email, password`
```

Also update the file's header doc comment — change:

```
 * WHY this exists (and why OPTIMIZE can't): exact (url,email,password) duplicates
 * arrive across DIFFERENT source files / import times. `OPTIMIZE … DEDUPLICATE BY`
```

to:

```
 * WHY this exists (and why OPTIMIZE can't): content duplicates — identical
 * email/password and the same URL once scheme and a trailing slash are
 * ignored (see lib/url-content-key.ts) — arrive across DIFFERENT source files /
 * import times. `OPTIMIZE … DEDUPLICATE BY`
```

Everything else in the file (`FULL_HASH`, `CONTENT_DUPLICATE_PREDICATE`, `MUTATION_MARKER`, `buildStatsSql`, `buildDeleteSql`, all cron-config functions, `runContentDedupTick`) is unchanged — they already derive from `CONTENT_KEY`.

- [x] **Step 4: Run the test and confirm GREEN**

Run:

```bash
npm test -- __tests__/content-dedup.test.ts
```

Expected: PASS (same test count as before this task).

- [x] **Step 5: Commit** — `bfd4107`

```bash
git add lib/content-dedup.ts __tests__/content-dedup.test.ts
git commit -m "fix(dedup-cron): ignore url scheme/trailing-slash in storage content-dedup key"
```

---

### Task 4: Manual Purge Script (`scripts/dedup-credentials-content.sh`)

**Files:**
- Modify: `scripts/dedup-credentials-content.sh`

**Interfaces:**
- Consumes: the same expression as `URL_CONTENT_KEY`, hand-copied (bash cannot import TypeScript).
- Produces: nothing — this is an operator script, not a module.

- [x] **Step 1: Update the `KEY=` line and header comment**

Change:

```bash
# Removes EXACT (url, email, password) duplicates from ulp.credentials —
```

to:

```bash
# Removes content duplicates from ulp.credentials -- identical email/password
# and the same url once scheme and a trailing slash are ignored (see
# lib/url-content-key.ts) —
```

Change:

```bash
KEY="url, email, password"                       # content dedup key
```

to:

```bash
# Content dedup key. Must stay byte-identical to URL_CONTENT_KEY in
# lib/url-content-key.ts (bash can't import TS) -- email/password are exact,
# only the url comparison ignores scheme and one trailing slash. The `\$`
# below is bash-escaping for a literal `$`; Step 2 proves the stored value
# matches the TS expression exactly.
KEY="replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password"
```

`ORDER="url, email, password, imported_at"` stays exactly as-is — survivor selection (earliest `imported_at` per group) is unchanged; only which rows count as "the same group" changes.

- [x] **Step 2: Sanity-check the constructed query string**

```bash
KEY="replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password"
echo "GROUP BY $KEY"
```

Expected output (confirms bash is not mangling the `$` or quotes):

```
GROUP BY replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''), email, password
```

- [ ] **Step 3: Run the script's dry-run against real ClickHouse** — NOT DONE: same Docker-unreachable limitation as Task 1 Step 5. The script ran and exited cleanly through the dry-run banner before failing on the `docker exec` calls, confirming the bash logic itself is sound, but no actual `excess_rows` comparison against real data happened. `APPLY=1` was never used. Run this for real wherever ClickHouse is reachable, after Task 1 Step 5 is confirmed.

This requires Docker/ClickHouse access and depends on Task 1 Step 5 having confirmed the `(?i:...)` syntax. There is no automated test for this script — this dry-run output is the only verification.

```bash
bash scripts/dedup-credentials-content.sh
```

Expected: the "Exact-duplicate scope" table reports a **larger** `excess_rows` than a pre-change run (scheme/slash variants now count toward it), and the script exits after printing "Dry-run." — no table is created, nothing is changed.

Do not pass `APPLY=1` as part of this plan. That is a separate, explicit operator decision made after reviewing this output, not an automated step.

- [x] **Step 4: Commit** — `d412700`, plus two follow-ups: `bcbf313` (a second hardcoded occurrence of the old key found in the "worst offenders" diagnostic, missed by this plan) and `6eafdca` (header comment clarification from code review)

```bash
git add scripts/dedup-credentials-content.sh
git commit -m "fix(dedup-script): ignore url scheme/trailing-slash in manual purge key"
```

---

### Task 5: README and Docs Contract

**Files:**
- Modify: `README.md`
- Create: `__tests__/url-content-key-docs.test.ts`

**Interfaces:**
- Documents: the dedupe key is scheme/trailing-slash-insensitive on `url`, exact on `email`/`password`.

- [ ] **Step 1: Write the failing docs contract**

Create `__tests__/url-content-key-docs.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('url-content-key docs', () => {
  const readme = readFileSync('README.md', 'utf8')

  test('README describes the dedupe key as scheme/slash-insensitive, not exact', () => {
    expect(readme).toContain('ignoring URL scheme and a trailing slash')
  })
})
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
npm test -- __tests__/url-content-key-docs.test.ts
```

Expected: FAIL — README still describes the key as "exact" everywhere.

- [ ] **Step 3: Update README**

Change:

```
- **Unique** — collapses exact `(url, email, password)` duplicates to one row each (`LIMIT 1 BY`).
```

to:

```
- **Unique** — collapses `(url, email, password)` duplicates to one row each (`LIMIT 1 BY`), ignoring URL scheme and a trailing slash — `http://`, `https://`, and no-scheme captures of the same host+path count as the same row; email/password stay exact.
```

Change:

```
Exact `(url,email,password)` duplicates accumulate when the same credential arrives across different combolist files. To remove them from storage:
```

to:

```
`(url,email,password)` duplicates accumulate when the same credential arrives across different combolist files — ignoring URL scheme and a trailing slash, same as the browser's Unique toggle above; email/password stay exact. To remove them from storage:
```

- [ ] **Step 4: Run the test and confirm GREEN**

Run:

```bash
npm test -- __tests__/url-content-key-docs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md __tests__/url-content-key-docs.test.ts
git commit -m "docs: describe dedupe key as scheme/slash-insensitive, not exact"
```

---

### Task 6: Full Verification and Rollout

**Files:**
- Verify only; no expected file changes.

**Interfaces:**
- Verifies the complete branch before deployment.

- [ ] **Step 1: Run the full automated suite**

```bash
npm test
npx tsc --noEmit
npm run lint
```

Expected: every test passes (existing suite plus the new `url-content-key` and `url-content-key-docs` files; `ulp-dedupe` and `content-dedup` keep the same test counts, just updated assertions); typecheck and lint exit zero.

- [ ] **Step 2: Review the branch**

```bash
git status --short --branch
git log --oneline c4d3fd2..HEAD
git diff --stat c4d3fd2..HEAD
```

Expected: clean worktree; only the five task commits touching `lib/url-content-key.ts`, `lib/ulp-dedupe.ts`, `lib/content-dedup.ts`, `scripts/dedup-credentials-content.sh`, `README.md`, and their test files.

- [ ] **Step 3: Operator pre-flight check — do not skip**

Check what `CONTENT_DEDUP_APPLY` is actually set to on the Ubuntu production host:

```bash
ssh <prod-host> "grep CONTENT_DEDUP_APPLY ~/ulp-suite/.env"
```

- If it prints `CONTENT_DEDUP_APPLY=false`, or the line is absent: safe to deploy on the normal schedule — the cron stays report-only either way.
- If it prints `CONTENT_DEDUP_APPLY=true`: the next scheduled cron tick after deploy will run a real `ALTER TABLE ... DELETE` against a meaningfully larger duplicate set than before. Stop here and decide with the user whether to deploy during a window they can watch, or temporarily raise `DEDUP_MIN_EXCESS` in `.env` (then restart the app container to pick it up) before deploying.

This step needs a human with production access — it cannot be completed from this plan alone.

- [ ] **Step 4: Deploy**

Tasks 1, 2, 3, and 5 all live in the `app` container's codebase, committed sequentially to the same branch — `git pull` always fetches every commit up to `HEAD`, so there is no way to rebuild the container with only the Task 2 (view) change while excluding Task 3 (cron). The spec's "ship the view fix first" recommendation only has a real mechanism if you deploy from a pinned commit instead of `HEAD`. Pick one:

**Default — deploy everything together** (use this if Step 3's pre-flight check came back clean, i.e. `CONTENT_DEDUP_APPLY=false` or unset):

```bash
cd ~/ulp-suite
git pull
docker compose up -d --build app
docker compose ps
docker compose logs app --tail=50
```

**Staged — view fix only first** (use this if Step 3 found `CONTENT_DEDUP_APPLY=true` and you want to see the view-level fix land before exposing the cron to a bigger duplicate set). Find the Task 2 commit hash with `git log --oneline --grep="ignore url scheme/trailing-slash in browser dedupe view"`, then:

```bash
cd ~/ulp-suite
git fetch origin
git checkout <task-2-commit-hash>
docker compose up -d --build app
docker compose ps
```

Confirm the browser's Unique toggle now collapses the scheme/slash duplicates as expected. Then move to the cron change once you've decided how to handle Step 3's finding (watched window, or a raised `DEDUP_MIN_EXCESS`):

```bash
git checkout main
docker compose up -d --build app
docker compose ps
docker compose logs app --tail=50
```

- [ ] **Step 5: Stop before pushing**

Do not push automatically. Confirm with the user first, per the standing project push policy. Once approved:

```bash
git push origin main
```
