# Credentials Dedupe/Count Materialized Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the Credentials Browser's 58-63s default-view load by replacing a live, unbounded, per-row double-regex `uniq()` count with one over a precomputed `MATERIALIZED` column.

**Architecture:** Add a `content_key_hash UInt64 MATERIALIZED cityHash64(...)` column to `ulp.credentials` (computed once at insert, backfilled for existing rows via `MATERIALIZE COLUMN`), then repoint `lib/ulp-dedupe.ts`'s `DEDUPE_BY` constant at it. `app/api/credentials/route.ts` and `app/api/export/route.ts` need no changes — they already call `dedupeLimitBy()`/`dedupeCountExpr()` as black boxes.

**Tech Stack:** ClickHouse 26.3, TypeScript, Next.js 15.5.23, Vitest.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-08-15-credentials-dedupe-materialized-key-design.md` — read it if anything below is ambiguous.
- Do NOT modify `app/api/credentials/route.ts` or `app/api/export/route.ts` — both already call the right helper functions.
- Do NOT modify `lib/content-dedup.ts`, `scripts/dedup-credentials-content.sh`, or `lib/url-content-key.ts` — out of scope (separate, currently-inactive pipelines; see design doc).
- Current DDL version is 17 (`lib/clickhouse-migrations.ts`); this plan adds v18.
- Live table is `ulp.credentials`, 1.48B rows at time of writing — treat all live ClickHouse commands as touching production data. Never run destructive SQL (only `ADD COLUMN` / `MATERIALIZE COLUMN`, both additive).

---

### Task 1: Update `lib/ulp-dedupe.ts` and its test (TDD)

**Files:**
- Modify: `__tests__/ulp-dedupe.test.ts`
- Modify: `lib/ulp-dedupe.ts`

**Interfaces:**
- Produces: `DEDUPE_BY: string` (now `'content_key_hash'`), `dedupeLimitBy(dedupe: boolean): string`, `dedupeCountExpr(dedupe: boolean): string` — same signatures as today, only the emitted SQL text changes. Consumed by `app/api/credentials/route.ts` and `app/api/export/route.ts` (unchanged call sites).

- [ ] **Step 1: Write the failing test**

Replace the full contents of `__tests__/ulp-dedupe.test.ts`:

```typescript
import { describe, test, expect } from 'vitest'
import { DEDUPE_BY, dedupeLimitBy, dedupeCountExpr } from '@/lib/ulp-dedupe'

describe('ulp-dedupe', () => {
  test('DEDUPE_BY is the precomputed content-key hash column', () => {
    expect(DEDUPE_BY).toBe('content_key_hash')
  })

  describe('dedupeLimitBy', () => {
    test('emits `LIMIT 1 BY content_key_hash` when deduping', () => {
      expect(dedupeLimitBy(true)).toBe('LIMIT 1 BY content_key_hash')
    })
    test('emits nothing when not deduping (keep every copy)', () => {
      expect(dedupeLimitBy(false)).toBe('')
    })
  })

  describe('dedupeCountExpr', () => {
    test('counts distinct credentials via uniq() over the hash column when deduping', () => {
      expect(dedupeCountExpr(true)).toBe('uniq(content_key_hash)')
    })
    test('plain count() when not deduping', () => {
      expect(dedupeCountExpr(false)).toBe('count()')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/ulp-dedupe.test.ts`
Expected: FAIL — `DEDUPE_BY` is still `` `${URL_CONTENT_KEY}, email, password` `` in the current code, not `'content_key_hash'`.

- [ ] **Step 3: Write minimal implementation**

In `lib/ulp-dedupe.ts`, remove the now-unused import and change `DEDUPE_BY`'s definition. The full file becomes:

```typescript
/**
 * View-level exact-duplicate collapsing for the credential browser/search.
 *
 * "Exact duplicate" = same destination + same credential: identical
 * (url, email, password), where url is compared scheme- and
 * trailing-slash-insensitively. These survive in storage because every
 * storage-level dedup keys on source_file + imported_at to preserve
 * provenance (see app/api/admin/dedup/route.ts and lib/upload-dedup.ts), so
 * the same credential arriving in multiple combolist files shows up 2-3x in
 * results.
 *
 * scripts/dedup-credentials-content.sh removes the existing copies from storage;
 * this keeps the VIEW unique going forward (a new overlapping import can't make
 * the browser show dupes before the next storage pass), without another rewrite.
 *
 * Implementation: `content_key_hash` is a MATERIALIZED UInt64 column
 * (cityHash64 of the same scheme/slash-insensitive url + email + password —
 * see docker/clickhouse/init/01-ulp-tables.sql and DDL v18 in
 * lib/clickhouse-migrations.ts), computed once at insert instead of live per
 * query. `LIMIT 1 BY <hash>` on the data query (one row per unique credential,
 * in the active sort order) + `uniq(<hash>)` for the count (HyperLogLog —
 * cheap/low-memory at any scale; ~0.5% error is fine for a result tally,
 * unchanged from before — this is the same hash uniq() already computed
 * internally, just relocated from query-time to insert-time). The identifiers
 * resolve to the SELECT's normalized url/email/password aliases, so dedup
 * matches what the user actually sees.
 *
 * Semantics: with keyset cursor pagination the LIMIT BY collapses dupes within
 * each page window. After the storage dedup that's effectively all of them; a
 * brand-new dupe split across a page boundary is the only gap, and the next
 * storage pass closes it. Storage stays the source of truth — nothing is deleted.
 */
export const DEDUPE_BY = 'content_key_hash'

/** `LIMIT 1 BY <content key>` (place between ORDER BY and LIMIT) or ''. */
export function dedupeLimitBy(dedupe: boolean): string {
  return dedupe ? `LIMIT 1 BY ${DEDUPE_BY}` : ''
}

/**
 * Count expression for the result tally: distinct credentials when deduping
 * (`uniq` — approximate but fast/low-memory), else plain `count()`.
 */
export function dedupeCountExpr(dedupe: boolean): string {
  return dedupe ? `uniq(${DEDUPE_BY})` : 'count()'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/ulp-dedupe.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Confirm no other test broke and typecheck is clean**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck emits nothing (clean); full suite shows the same pass count as the pre-existing baseline (873/890 — the 17 pre-existing failures are the unrelated `SQLITE_READONLY` test-isolation gap, not this change. If that number changes, stop and investigate before continuing).

- [ ] **Step 6: Commit**

```bash
git add __tests__/ulp-dedupe.test.ts lib/ulp-dedupe.ts
git commit -m "$(cat <<'EOF'
perf(credentials): point view-level dedupe at content_key_hash

DEDUPE_BY was a live double-regex URL-normalization expression,
evaluated per row with no bound in the "Unique" count query
(uniq(DEDUPE_BY) over ulp.credentials, no LIMIT) -- confirmed live at
58-63s against 1.48B rows. Repoints both dedupeLimitBy() and
dedupeCountExpr() at content_key_hash, the MATERIALIZED column landing
in the next commit (DDL v18). Callers (app/api/credentials/route.ts,
app/api/export/route.ts) already call these as black boxes -- no
changes needed there.
EOF
)"
```

---

### Task 2: Add `content_key_hash` to the fresh-deploy schema

**Files:**
- Modify: `docker/clickhouse/init/01-ulp-tables.sql`

**Interfaces:**
- Produces: the `content_key_hash` column definition for brand-new deployments (no existing data volume). Existing deployments get this column via Task 3's migration instead — this file is only read when ClickHouse initializes an empty data directory.

- [ ] **Step 1: Add the column definition**

In `docker/clickhouse/init/01-ulp-tables.sql`, the `is_noise` column definition currently ends with:

```sql
        OR match(domain, '^[^\p{L}\p{N}]')
        OR match(domain, '[ @]')
    ),

    -- ── Skip indexes ──────────────────────────────────────────────────────────
```

Insert a new column definition between the `is_noise` column's closing `),` and the `-- ── Skip indexes ──` comment:

```sql
        OR match(domain, '^[^\p{L}\p{N}]')
        OR match(domain, '[ @]')
    ),

    -- content_key_hash: precomputed dedupe/count identity for the browser's
    -- default-on "Unique" filter (see lib/ulp-dedupe.ts DEDUPE_BY). Computed
    -- ONCE here instead of live per query -- the "Unique" count previously ran
    -- an unbounded uniq() over a live double-regex URL expression across the
    -- whole table (58-63s at 1.48B rows). Mirrors is_noise's MATERIALIZED
    -- pattern above. See DDL v18 in lib/clickhouse-migrations.ts and
    -- docs/superpowers/specs/2026-08-15-credentials-dedupe-materialized-key-design.md.
    content_key_hash UInt64 MATERIALIZED cityHash64(
        replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''),
        email, password
    ),

    -- ── Skip indexes ──────────────────────────────────────────────────────────
```

- [ ] **Step 2: Verify the SQL is well-formed**

This file is only exercised on a true fresh deploy (empty data volume), which we are not doing against the live 1.48B-row instance. Verify structurally instead:

Run: `grep -c "content_key_hash" docker/clickhouse/init/01-ulp-tables.sql`
Expected: `2` (the column name appears in the comment and the column definition)

Run: `docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT cityHash64(replaceRegexpOne(replaceRegexpOne('https://example.com/path/', '^(?i:https?://)', ''), '/\$', ''), 'a@b.com', 'pw')"`
Expected: a single UInt64 number, no error — confirms the expression itself is syntactically valid ClickHouse SQL (run standalone, not against the init file).

- [ ] **Step 3: Commit**

```bash
git add docker/clickhouse/init/01-ulp-tables.sql
git commit -m "$(cat <<'EOF'
feat(clickhouse): add content_key_hash to fresh-deploy schema

Companion to the DDL v18 migration (next commit) -- this is the same
column definition for brand-new deployments that init from an empty
data volume rather than migrating an existing one.
EOF
)"
```

---

### Task 3: Add DDL v18 migration for existing deployments

**Files:**
- Modify: `lib/clickhouse-migrations.ts`

**Interfaces:**
- Consumes: nothing new (uses existing `runMigration` helper and `lastDdl`/`DDL_VERSION` pattern already in this file).
- Produces: on next app startup against an existing database, adds `content_key_hash` and kicks off its backfill.

- [ ] **Step 1: Bump `DDL_VERSION`**

In `lib/clickhouse-migrations.ts`, change:

```typescript
const DDL_VERSION = 17
```

to:

```typescript
const DDL_VERSION = 18
```

- [ ] **Step 2: Add the v18 migration block**

Immediately after the existing `if (lastDdl < 12) { ... }` block (the `is_noise` migration — do not modify that block), add:

```typescript
  // v18 — content_key_hash materialized column for the "Unique" dedupe/count
  // filter. Same shape as v12 (is_noise): ADD COLUMN is metadata-only/instant;
  // new inserts compute it for free. MATERIALIZE COLUMN backfills existing
  // parts as a background mutation -- until it finishes, content_key_hash is
  // computed on the fly for old parts (i.e. dedupe/count stays slow for rows
  // in those parts), so monitor system.mutations and expect the speedup once
  // it completes. This table has grown substantially since the v12 backfill
  // ran (1.48B rows at time of writing) -- expect this to take meaningfully
  // longer; do not assume a duration.
  if (lastDdl < 18) {
    await runMigration(
      `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS content_key_hash UInt64 MATERIALIZED cityHash64(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''), email, password)`,
      `ALTER TABLE ulp.credentials MATERIALIZE COLUMN content_key_hash`
    )
    console.warn('[ClickHouse migration] DDL v18 applied (added content_key_hash column — MATERIALIZE running in background)')
  }
```

- [ ] **Step 3: Confirm typecheck is clean**

Run: `npm run typecheck`
Expected: no output (clean)

- [ ] **Step 4: Commit**

```bash
git add lib/clickhouse-migrations.ts
git commit -m "$(cat <<'EOF'
feat(clickhouse): DDL v18 -- add content_key_hash materialized column

ADD COLUMN + MATERIALIZE COLUMN for existing deployments, mirroring
the v12 is_noise pattern exactly. Not yet applied to this instance --
that happens on next app rebuild/restart (next task).
EOF
)"
```

---

### Task 4: Apply the migration to the live instance and verify it started correctly

**Files:** none (deployment + verification task, no new file changes)

**Interfaces:**
- Consumes: the DDL v18 migration from Task 3, baked into the app image on rebuild.

- [ ] **Step 1: Rebuild and restart the app container**

The migration code is compiled into the Docker image, so a plain restart won't pick it up.

Run: `docker compose up -d --build`
Expected: build completes, both `ulpsuite_app` and `ulpsuite_clickhouse` show `Up ... (healthy)` in `docker compose ps` within ~30s of the build finishing.

- [ ] **Step 2: Confirm the migration actually ran**

Run: `docker compose logs app --tail 50 | grep -i "DDL v18"`
Expected: a line containing `[ClickHouse migration] DDL v18 applied (added content_key_hash column — MATERIALIZE running in background)`. If this line is absent, check for a migration error instead: `docker compose logs app --tail 100 | grep -iE "migration|error"`.

- [ ] **Step 3: Confirm the column exists and the mutation is registered**

Run:
```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "DESCRIBE TABLE ulp.credentials" | grep content_key_hash
```
Expected: a row showing `content_key_hash	UInt64	MATERIALIZED	cityHash64(...)`.

Run:
```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT mutation_id, command, is_done, parts_to_do FROM system.mutations WHERE table = 'credentials' AND command LIKE '%content_key_hash%' ORDER BY create_time DESC LIMIT 5"
```
Expected: at least one row for the `MATERIALIZE COLUMN content_key_hash` mutation, with `is_done = 0` and `parts_to_do > 0` (still running) or `is_done = 1` (already finished, on a fast box).

- [ ] **Step 4: Confirm correctness is maintained regardless of backfill progress**

Run:
```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials WHERE content_key_hash = 0"
```
Expected: `0` — every row (whether backfilled yet or computed on-the-fly for old parts) produces a real, non-zero hash. A large non-zero count here would mean something is wrong with the expression and must be investigated before continuing (do not proceed to Task 5 if this fails).

No commit for this task — it's a deployment/verification step, not a code change.

---

### Task 5: Add the diagnostic script

**Files:**
- Create: `scripts/diagnose-dedupe-count-perf.sh`

**Interfaces:** none (standalone read-only operational script, not imported by application code).

- [ ] **Step 1: Write the script**

Create `scripts/diagnose-dedupe-count-perf.sh`:

```bash
#!/bin/bash
# =============================================================================
# diagnose-dedupe-count-perf.sh
#
# Verifies the "Unique" dedupe/count filter's performance fix (DDL v18).
#
# The Credentials Browser's default view ("Unique" on) counts distinct
# credentials via uniq() over (normalized url, email, password). It shipped
# as a LIVE double-regex expression evaluated per row with no LIMIT --
# confirmed at 58-63s against 1.48B rows. DDL v18 precomputes it into a
# MATERIALIZED content_key_hash column so the count becomes uniq(content_key_hash)
# instead -- see docs/superpowers/specs/2026-08-15-credentials-dedupe-materialized-key-design.md.
#
# This script is READ-ONLY. It (1) confirms the column + backfill state, and
# (2) TIMES the old inline expression vs the new column to prove the fix.
#
#   bash scripts/diagnose-dedupe-count-perf.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  content_key_hash backfill status                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
$CH "SELECT mutation_id, is_done, parts_to_do FROM system.mutations WHERE table = 'credentials' AND command LIKE '%content_key_hash%' ORDER BY create_time DESC LIMIT 5 FORMAT PrettyCompact"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  OLD: live double-regex uniq() over the full table (is_noise=0)║"
echo "╚══════════════════════════════════════════════════════════════╝"
time $CH "
SELECT uniq(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password) AS total
FROM ulp.credentials
WHERE is_noise = 0
SETTINGS max_execution_time = 300
"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  NEW: uniq() over the materialized content_key_hash column     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
time $CH "
SELECT uniq(content_key_hash) AS total
FROM ulp.credentials
WHERE is_noise = 0
SETTINGS max_execution_time = 300
"

echo ""
echo "Both totals above should match (or be within ~0.5% -- both are the same"
echo "HyperLogLog algorithm, just fed via a live expression vs. a precomputed"
echo "column). The NEW query's wall-clock time is the number that matters --"
echo "it should drop sharply once the backfill (checked above) reaches is_done=1"
echo "for all parts. Before that, rows in not-yet-rewritten parts still compute"
echo "content_key_hash on the fly, so the speedup is partial until backfill completes."
```

- [ ] **Step 2: Make it executable and run it**

Run: `chmod +x scripts/diagnose-dedupe-count-perf.sh && bash scripts/diagnose-dedupe-count-perf.sh`
Expected: both `uniq()` totals print and are within ~0.5% of each other (same algorithm, same data). Note the NEW query's wall-clock time — if the backfill (Task 4) hasn't finished yet, it may still be slow for now; that's expected and documented in the script's own output. Re-run this script later (after the mutation's `is_done` flips to `1` for all parts) to confirm the NEW query has dropped to low seconds.

- [ ] **Step 3: Commit**

```bash
git add scripts/diagnose-dedupe-count-perf.sh
git commit -m "$(cat <<'EOF'
test(clickhouse): add diagnose-dedupe-count-perf.sh

Read-only script mirroring diagnose-noise-rows.sh's pattern: checks
the content_key_hash backfill (DDL v18) status and times the old live
double-regex uniq() against the new materialized-column version, so
the fix (and its rollout progress) stays independently verifiable.
EOF
)"
```

---

### Task 6: Confirm the fix from the actual application, end to end

**Files:** none (verification-only task)

**Interfaces:** none.

- [ ] **Step 1: Check backfill completion**

Run:
```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM system.mutations WHERE table = 'credentials' AND command LIKE '%content_key_hash%' AND NOT is_done"
```
Expected: `0` once the backfill is complete. If non-zero, wait and re-check later (no fixed duration — see Task 3's migration comment) before proceeding to Step 2, since the full speedup only lands once every part is rewritten.

- [ ] **Step 2: Hit the real API endpoint the Credentials Browser uses**

Run:
```bash
curl -s -w "\ntime_total: %{time_total}s\n" -b cookies.txt "http://localhost:3000/api/credentials?limit=200&sort=domain_asc&exclude_noise=1&dedupe=1" -o /tmp/credentials-response.json
cat /tmp/credentials-response.json | head -c 300
echo ""
grep -o '"total":[0-9]*' /tmp/credentials-response.json
grep -o '"query_ms":[0-9]*' /tmp/credentials-response.json
```
(If `cookies.txt` doesn't exist or the request returns `Unauthorized`, log in via the UI first at `http://localhost:3000/login` with a browser, or check `README.md`'s "Useful Commands" section for the existing cookie-auth pattern used by the other `curl` examples there.)

Expected: `total` is present and roughly matches the last count observed (~843M, or higher if new data has been imported since), and `query_ms` is dramatically lower than the original ~58,000-63,000ms — low single-digit-seconds range (matching Task 5's diagnostic script once backfill is complete).

- [ ] **Step 3: Visually confirm in the browser**

Open `http://localhost:3000/credentials` (or use the Browser tool if verifying interactively), confirm the page loads with the record count and a load time far under the original 58.5s, and that rows render correctly with "Decluttered"/"Unique" both showing as active (default-on).

- [ ] **Step 4: Final full-suite check**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; same 873/890 baseline as Task 1 (no new failures introduced by this plan).

No commit for this task (verification-only). If all steps pass, this plan is complete.
