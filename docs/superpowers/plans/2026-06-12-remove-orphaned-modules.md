# Remove Orphaned Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead/orphaned hooks, components, and lib utility modules left over from earlier iterations of the app (pre-ClickHouse MVP scaffolding, an abandoned analytics/perf-monitoring integration, and an abandoned date-range UI), delete an uncalled admin recovery route, prune the two npm dependencies that become unused as a result, and document three previously-undocumented ClickHouse diagnostic endpoints in the README.

**Architecture:** This is a pure dead-code removal sweep, found via repo-wide grep for import references to each candidate file. Each task deletes one cohesive group of files (verified to have zero external references), runs the full test suite + production build to confirm nothing breaks, and commits. The final task does a full verification pass (test/build/lint/grep) across everything removed.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, Vitest, npm

---

## Background

This is a follow-up to `docs/superpowers/plans/2026-06-12-remove-reuse-similar-stats.md` (Plan A, already completed), which removed the Reuse/Similar/Stats feature set. While auditing the codebase for similar dead code, the following were found to have **zero references anywhere** (verified via `grep -rn` across `*.ts`/`*.tsx`, excluding `node_modules` and `.next`):

| File | What it was |
|---|---|
| `hooks/useStats.ts` | Hook for the now-deleted `/stats` page (`/api/stats` no longer exists either — Plan A removed the route, this hook was already dead before Plan A and explicitly called out as out-of-scope there) |
| `components/auth-guard.tsx` | Auth-wrapper component; the app uses `hooks/useAuth.ts` + middleware instead |
| `components/change-password-modal.tsx` | Password-change modal; `/user-settings` has its own inline form instead |
| `lib/accessibility.ts` | Focus-trap/ARIA utility library — its only consumer is `useFocusTrap`, which is only used by `change-password-modal.tsx` |
| `lib/api-helpers.ts` | Request-abort-handling helpers, never adopted |
| `lib/memory-storage.ts` | Pre-ClickHouse in-memory MVP storage scaffold (`MemoryStorage` class), superseded by ClickHouse |
| `lib/date-filter-utils.ts` | Date-filter builders for legacy `devices`/`systeminformation` ClickHouse tables that don't exist in this schema |
| `lib/date-range-utils.ts` | Date-range preset utilities for a date-picker UI that doesn't exist |
| `lib/url-parser.ts` | URL parser superseded by `lib/ulp-parser.ts` / `lib/ulp-search.ts` |
| `lib/performance.ts` | Web Vitals client that posts to `/api/analytics/performance`, which doesn't exist |
| `app/api/admin/rebuild-sources/route.ts` | Admin recovery endpoint (rebuilds `ulp.sources` from `ulp.credentials`), no callers and not documented (unlike `/api/admin/dedup`, which IS documented in the README) |

Two npm packages become unused once their only consumers are removed:
- `date-fns` (only used by `lib/date-range-utils.ts`)
- `web-vitals` (only used by `lib/performance.ts`)

Additionally, three diagnostic API routes exist with no UI and no README mention, but ARE legitimate curl-able ops tools (same pattern as the documented `/api/admin/dedup`):
- `app/api/monitoring/async-inserts/route.ts`
- `app/api/monitoring/mutations/route.ts`
- `app/api/monitoring/slow-queries/route.ts`

These should be **documented**, not removed.

---

## Task 1: Remove orphaned hook and auth-guard component

**Files:**
- Delete: `hooks/useStats.ts`
- Delete: `components/auth-guard.tsx`

- [ ] **Step 1: Verify zero references to useStats**

```bash
grep -rn "useStats" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next"
```

Expected: only `hooks/useStats.ts` itself (its own `export function useStats` declaration).

- [ ] **Step 2: Verify zero references to AuthGuard**

```bash
grep -rn "auth-guard\|AuthGuard" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next"
```

Expected: only `components/auth-guard.tsx` itself.

- [ ] **Step 3: Delete both files**

```bash
git rm hooks/useStats.ts components/auth-guard.tsx
```

- [ ] **Step 4: Run the test suite**

```bash
npm test
```

Expected: all 428 tests pass (same as before — neither file had tests).

- [ ] **Step 5: Run the production build**

```bash
npm run build
```

Expected: build succeeds, no missing-module errors.

- [ ] **Step 6: Commit**

```bash
git commit -m "chore: remove orphaned useStats hook and AuthGuard component"
```

---

## Task 2: Remove change-password-modal and its only-consumer accessibility lib

**Files:**
- Delete: `components/change-password-modal.tsx`
- Delete: `lib/accessibility.ts`

- [ ] **Step 1: Verify zero references to ChangePasswordModal**

```bash
grep -rn "change-password-modal\|ChangePasswordModal" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next"
```

Expected: only `components/change-password-modal.tsx` itself.

- [ ] **Step 2: Verify every export of lib/accessibility.ts has zero external references**

```bash
for fn in trapFocus useFocusTrap useFocusRestore KEYBOARD_KEYS generateId announceToScreenReader getContrastRatio meetsWCAGContrast hideFromScreenReader showToScreenReader createSkipLink prefersReducedMotion useReducedMotion getFormErrorId getFormDescriptionId createFormFieldProps; do
  echo "$fn:"
  grep -rn "$fn" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next" | grep -v "lib/accessibility.ts" | grep -v "components/change-password-modal.tsx"
done
```

Expected: no output for any function (every export is either unused, or used only by `useFocusTrap` from `change-password-modal.tsx`, which is also being deleted in this task).

- [ ] **Step 3: Delete both files**

```bash
git rm components/change-password-modal.tsx lib/accessibility.ts
```

- [ ] **Step 4: Run the test suite**

```bash
npm test
```

Expected: all 428 tests pass.

- [ ] **Step 5: Run the production build**

```bash
npm run build
```

Expected: build succeeds, no missing-module errors (in particular, no error about `@/lib/accessibility` from `/user-settings` or anywhere else).

- [ ] **Step 6: Commit**

```bash
git commit -m "chore: remove orphaned change-password modal and accessibility lib"
```

---

## Task 3: Remove orphaned standalone lib utilities (api-helpers, url-parser, memory-storage)

**Files:**
- Delete: `lib/api-helpers.ts`
- Delete: `lib/url-parser.ts`
- Delete: `lib/memory-storage.ts`

- [ ] **Step 1: Verify zero references to lib/api-helpers exports**

```bash
for fn in isRequestAborted throwIfAborted getRequestSignal withAbortCheck handleAbortError; do
  echo "$fn:"
  grep -rn "$fn" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next" | grep -v "lib/api-helpers.ts"
done
```

Expected: no output for any function.

- [ ] **Step 2: Verify zero references to lib/url-parser exports**

```bash
for fn in parseUrl extractPath extractHostname ParsedUrl; do
  echo "$fn:"
  grep -rn "$fn" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next" | grep -v "lib/url-parser.ts"
done
```

Expected: no output for any function.

- [ ] **Step 3: Verify zero references to lib/memory-storage exports**

```bash
for fn in memoryStorage MemoryStorage StoredDevice StoredFile SearchMatch; do
  echo "$fn:"
  grep -rn "$fn" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next" | grep -v "lib/memory-storage.ts"
done
```

Expected: no output for any function.

- [ ] **Step 4: Delete all three files**

```bash
git rm lib/api-helpers.ts lib/url-parser.ts lib/memory-storage.ts
```

- [ ] **Step 5: Run the test suite**

```bash
npm test
```

Expected: all 428 tests pass.

- [ ] **Step 6: Run the production build**

```bash
npm run build
```

Expected: build succeeds, no missing-module errors.

- [ ] **Step 7: Commit**

```bash
git commit -m "chore: remove orphaned api-helpers, url-parser, and memory-storage lib modules"
```

---

## Task 4: Remove date-range/date-filter lib modules and the date-fns dependency

**Files:**
- Delete: `lib/date-filter-utils.ts`
- Delete: `lib/date-range-utils.ts`
- Modify: `package.json` (remove `date-fns` dependency)
- Modify: `package-lock.json` (regenerated by `npm install`)

- [ ] **Step 1: Verify zero references to lib/date-filter-utils exports**

```bash
for fn in buildDeviceDateFilter buildSystemInfoDateFilter buildCombinedDateFilter parseDateFilterFromRequest DateFilterParams; do
  echo "$fn:"
  grep -rn "$fn" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next" | grep -v "lib/date-filter-utils.ts"
done
```

Expected: no output for any function.

- [ ] **Step 2: Verify zero references to lib/date-range-utils exports**

```bash
for fn in getPresetDateRange getPresetLabel dateRangeToQueryParams parseDateRangeFromQuery formatDateRangeLabel DateRangePreset DateRangeType DateRange; do
  echo "$fn:"
  grep -rn "$fn" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next" | grep -v "lib/date-range-utils.ts"
done
```

Expected: no output for any function.

- [ ] **Step 3: Verify date-fns has no other consumers**

```bash
grep -rln "date-fns" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next"
```

Expected: only `lib/date-range-utils.ts`.

- [ ] **Step 4: Delete both files**

```bash
git rm lib/date-filter-utils.ts lib/date-range-utils.ts
```

- [ ] **Step 5: Remove date-fns from package.json**

In `package.json`, find this line in `dependencies` (currently around line 59):

```json
    "date-fns": "^3.6.0",
```

Delete the entire line.

- [ ] **Step 6: Update the lockfile**

```bash
npm install
```

Expected: `package-lock.json` updates to remove `date-fns` and its sub-dependencies; no errors.

- [ ] **Step 7: Run the test suite**

```bash
npm test
```

Expected: all 428 tests pass.

- [ ] **Step 8: Run the production build**

```bash
npm run build
```

Expected: build succeeds, no missing-module errors.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove orphaned date-range/date-filter lib modules and date-fns dependency"
```

---

## Task 5: Remove performance monitoring lib module and the web-vitals dependency

**Files:**
- Delete: `lib/performance.ts`
- Modify: `package.json` (remove `web-vitals` dependency)
- Modify: `package-lock.json` (regenerated by `npm install`)

- [ ] **Step 1: Verify zero references to lib/performance exports**

```bash
for fn in performanceMonitor measureAsyncOperation measureSyncOperation usePerformanceMonitor PerformanceMonitor; do
  echo "$fn:"
  grep -rn "$fn" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next" | grep -v "lib/performance.ts"
done
```

Expected: no output for any function.

- [ ] **Step 2: Verify web-vitals has no other consumers**

```bash
grep -rln "web-vitals" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next"
```

Expected: only `lib/performance.ts`.

- [ ] **Step 3: Delete the file**

```bash
git rm lib/performance.ts
```

- [ ] **Step 4: Remove web-vitals from package.json**

In `package.json`, find this line in `dependencies` (currently around line 79):

```json
    "web-vitals": "^3.5.2",
```

Delete the entire line.

- [ ] **Step 5: Update the lockfile**

```bash
npm install
```

Expected: `package-lock.json` updates to remove `web-vitals`; no errors.

- [ ] **Step 6: Run the test suite**

```bash
npm test
```

Expected: all 428 tests pass.

- [ ] **Step 7: Run the production build**

```bash
npm run build
```

Expected: build succeeds, no missing-module errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove orphaned performance monitoring lib and web-vitals dependency"
```

---

## Task 6: Remove uncalled admin rebuild-sources route

**Files:**
- Delete: `app/api/admin/rebuild-sources/route.ts` (and its now-empty parent directory)

- [ ] **Step 1: Verify zero callers of /api/admin/rebuild-sources**

```bash
grep -rn "rebuild-sources" --include="*.ts" --include="*.tsx" --include="*.md" . | grep -v node_modules | grep -v ".next"
```

Expected: only `app/api/admin/rebuild-sources/route.ts` itself (its own comments/log lines), plus historical mentions in `docs/superpowers/plans/2026-06-06-materialized-views.md` (a point-in-time record, not updated).

- [ ] **Step 2: Delete the route file and its directory**

```bash
git rm app/api/admin/rebuild-sources/route.ts
rmdir app/api/admin/rebuild-sources
```

(If `rmdir` fails because the directory still has other files in it, list the directory contents with `ls app/api/admin/rebuild-sources` and stop — that means there's more here than this plan accounted for; otherwise it should be empty after the `git rm`.)

- [ ] **Step 3: Run the test suite**

```bash
npm test
```

Expected: all 428 tests pass.

- [ ] **Step 4: Run the production build**

```bash
npm run build
```

Expected: build succeeds. The route list printed by the build must NOT contain `/api/admin/rebuild-sources`.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore: remove uncalled admin rebuild-sources route"
```

---

## Task 7: Document the three undocumented monitoring diagnostic endpoints in README

**Files:**
- Modify: `README.md`

These three endpoints exist, work, are admin-only, and are useful for ops — they just aren't documented anywhere, unlike `/api/admin/dedup`. Add them to the "Useful Commands" section using the same `curl -b cookies.txt` pattern as the existing dedup entry.

- [ ] **Step 1: Add the three commands to the Useful Commands section**

In `README.md`, find the "Useful Commands" code block (currently lines 165-184), which ends with:

```bash
# Run dedup after large imports
curl -s -b cookies.txt -X POST http://localhost:3000/api/admin/dedup | jq
```
```

Replace that ending (the two lines above, plus the closing ` ``` `) with:

```bash
# Run dedup after large imports
curl -s -b cookies.txt -X POST http://localhost:3000/api/admin/dedup | jq

# Check ClickHouse async-insert health (failures + throughput, last 60 min)
curl -s -b cookies.txt http://localhost:3000/api/monitoring/async-inserts | jq

# Check ClickHouse mutation status (MATERIALIZE COLUMN/INDEX progress, stuck mutations)
curl -s -b cookies.txt http://localhost:3000/api/monitoring/mutations | jq

# Find slow/failed queries (last 60 min, duration >= 200ms)
curl -s -b cookies.txt http://localhost:3000/api/monitoring/slow-queries | jq
```
```

(i.e. add the three new commands after the existing dedup command, inside the same fenced code block — do not close and reopen the block.)

- [ ] **Step 2: Verify the README renders sensibly**

```bash
grep -n "monitoring/async-inserts\|monitoring/mutations\|monitoring/slow-queries" README.md
```

Expected: three lines, one per new `curl` command.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document async-inserts, mutations, slow-queries diagnostic endpoints"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all 428 tests pass (no count change — none of the removed files had tests).

- [ ] **Step 2: Run the production build**

```bash
npm run build
```

Expected: build succeeds. The printed route list must NOT contain `/api/admin/rebuild-sources`.

- [ ] **Step 3: Run the linter**

```bash
npm run lint
```

Expected: same 4 pre-existing errors as before this plan (in `app/api/v1/upload/route.ts`, `app/credentials/page.tsx`, `app/inbox/page.tsx`, `app/upload/page.tsx` — all pre-existing and out of scope). No NEW errors, and specifically no "unused import" errors caused by this plan's deletions (none of the deleted files were imported anywhere, so there should be no leftover imports to clean up).

- [ ] **Step 4: Final repo-wide grep for stragglers**

```bash
grep -rn "useStats\|AuthGuard\|auth-guard\|ChangePasswordModal\|change-password-modal\|lib/accessibility\|useFocusTrap\|lib/api-helpers\|isRequestAborted\|lib/url-parser\|parseUrl\b\|lib/memory-storage\|memoryStorage\|MemoryStorage\|lib/date-filter-utils\|lib/date-range-utils\|getPresetDateRange\|lib/performance\|performanceMonitor\|rebuild-sources" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next"
```

Expected: **no output**. (Unlike Plan A, none of these names have legitimate remaining uses elsewhere — every file in this plan was either fully deleted or, for `lib/accessibility.ts`'s `useFocusTrap`, deleted along with its only consumer.)

- [ ] **Step 5: Confirm removed npm packages are gone**

```bash
grep -n "\"date-fns\"\|\"web-vitals\"" package.json
```

Expected: no output.

---

## Self-Review

**Spec coverage:**
- Remove `hooks/useStats.ts` — Task 1 ✓
- Remove `components/auth-guard.tsx` — Task 1 ✓
- Remove `components/change-password-modal.tsx` — Task 2 ✓
- Remove `lib/accessibility.ts` (only consumer is the modal above) — Task 2 ✓
- Remove `lib/api-helpers.ts` — Task 3 ✓
- Remove `lib/url-parser.ts` — Task 3 ✓
- Remove `lib/memory-storage.ts` — Task 3 ✓
- Remove `lib/date-filter-utils.ts` — Task 4 ✓
- Remove `lib/date-range-utils.ts` + `date-fns` dependency — Task 4 ✓
- Remove `lib/performance.ts` + `web-vitals` dependency — Task 5 ✓
- Remove `app/api/admin/rebuild-sources/route.ts` — Task 6 ✓
- Document `async-inserts`/`mutations`/`slow-queries` in README — Task 7 ✓
- Full test/build/lint/grep verification — Task 8 ✓

**Placeholder scan:** no TBD/TODO/"add appropriate"/"similar to Task N" patterns — every step shows the literal grep command, file list, or README diff.

**Type consistency:** no new types/functions introduced; this plan is purely deletions + two package.json dependency removals + a README documentation addition. No signatures to keep consistent across tasks.
