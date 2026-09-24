# Credential Dedup Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and dry-run-verify the tooling that collapses `ulp.credentials`' exact-duplicate rows into one canonical row per group with cross-source lineage preserved in a companion table — through to "this would delete N rows, keep M rows," never past it. The actual `APPLY=1` destructive run is explicitly out of scope for this plan.

**Architecture:** A new companion table `ulp.credential_dedup_meta` (schema-tracked via `lib/clickhouse-migrations.ts`), populated by a script mirroring `scripts/purge-existing-t3.sh`'s exact dry-run/`APPLY=1`/`BACKUP_VERIFIED`-or-`ACCEPT_PERMANENT_DATA_LOSS` gating. Validated on a ~1% sample before ever touching the real 2.78B-row table.

**Tech Stack:** ClickHouse 26.3, bash (mirroring the existing purge-script pattern), TypeScript (`lib/clickhouse-migrations.ts`).

## Global Constraints

- Never run the actual `APPLY=1` delete against production as part of this plan — every task stops at "verified dry-run," matching the spec's explicit scope boundary.
- `groupUniqArray`/`uniqExact`-class aggregations already hit `MEMORY_LIMIT_EXCEEDED` once this session at full table scale — every full-scale query in this plan must use disk-spill settings (`max_bytes_before_external_group_by`, join-algorithm tuning), not assume in-memory execution will just work.
- The companion table is additive schema — it does not modify `ulp.credentials` in any way.
- Mirror `scripts/purge-existing-t3.sh`'s safety pattern exactly for the destructive path (dry-run default, `APPLY=1` + (`BACKUP_VERIFIED=1` or `ACCEPT_PERMANENT_DATA_LOSS=1`), refuse if any mutation is already active, report bytes before/after) — this is a port of an established, already-proven pattern, not new design.

---

### Task 1: Validate the aggregation + delete-matching logic on a sample

**Files:** none — live ClickHouse only, via a throwaway sample table (same pattern as the email_domain projection experiment).

**Interfaces:** none — this task's job is to prove the SQL shape is correct before Task 3 builds it into a script.

- [ ] **Step 1: Build a sample table**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
CREATE TABLE ulp.dedup_test_sample
(
    content_key_hash UInt64,
    source_file String,
    imported_at DateTime,
    url String,
    email String,
    password String
)
ENGINE = MergeTree()
ORDER BY content_key_hash
"
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.dedup_test_sample
SELECT content_key_hash, source_file, imported_at, url, email, password
FROM ulp.credentials
WHERE cityHash64(email, password) % 100 = 0
"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.dedup_test_sample"
```

- [ ] **Step 2: Build the sample companion table using the real aggregation query**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
CREATE TABLE ulp.dedup_test_meta
ENGINE = MergeTree() ORDER BY content_key_hash AS
SELECT
    content_key_hash,
    count() AS source_count,
    groupUniqArray(50)(source_file) AS sources,
    min(imported_at) AS first_seen,
    max(imported_at) AS last_seen,
    argMin(url, (imported_at, url, email, password)) AS canonical_url,
    argMin(email, (imported_at, url, email, password)) AS canonical_email,
    argMin(password, (imported_at, url, email, password)) AS canonical_password,
    argMin(source_file, (imported_at, url, email, password)) AS canonical_source_file
FROM ulp.dedup_test_sample
GROUP BY content_key_hash
"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.dedup_test_meta"
```

- [ ] **Step 3: Manually verify one real duplicated group**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT content_key_hash, source_count, length(sources) AS n_sources, first_seen, last_seen, canonical_source_file
FROM ulp.dedup_test_meta
ORDER BY source_count DESC
LIMIT 5
FORMAT PrettyCompact
"
```

Pick the top group's `content_key_hash` from this output and cross-check it directly against the raw sample:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() AS raw_count, uniqExact(source_file) AS raw_distinct_sources, min(imported_at) AS raw_first_seen
FROM ulp.dedup_test_sample
WHERE content_key_hash = <the top content_key_hash from the previous query>
"
```

Expected: `raw_count` matches `source_count`, `raw_distinct_sources` matches `n_sources` (or `n_sources` is capped at 50 if `raw_distinct_sources` exceeds it), `raw_first_seen` matches `first_seen`. If any of these disagree, the aggregation query has a bug — stop and fix it before continuing.

- [ ] **Step 4: Validate the delete-matching predicate correctly identifies exactly one row per group**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM ulp.dedup_test_sample
WHERE (content_key_hash, imported_at, url, email, password) IN (
    SELECT content_key_hash, first_seen, canonical_url, canonical_email, canonical_password
    FROM ulp.dedup_test_meta
)
"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT uniqExact(content_key_hash) FROM ulp.dedup_test_sample"
```

Expected: these two numbers are equal — exactly one row per distinct `content_key_hash` matches the canonical predicate. (`uniqExact` is safe here — the sample is small, this is the same function that OOM'd only at the full table's 2.78B-row scale.)

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT count() FROM ulp.dedup_test_sample
WHERE (content_key_hash, imported_at, url, email, password) NOT IN (
    SELECT content_key_hash, first_seen, canonical_url, canonical_email, canonical_password
    FROM ulp.dedup_test_meta
)
"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.dedup_test_sample"
```

Expected: `NOT IN` count + `IN` count (from above) = total sample row count. If they don't sum correctly, some rows are matching neither or both predicates — a real bug, stop and fix before continuing.

- [ ] **Step 5: Clean up the sample tables**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE ulp.dedup_test_sample"
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE ulp.dedup_test_meta"
```

No commit for this task — it's pure live-database validation, nothing in the repo changes.

---

### Task 2: Add `credential_dedup_meta` to the schema

**Files:**
- Modify: `lib/clickhouse-migrations.ts`
- Modify: `docker/clickhouse/init/01-ulp-tables.sql`

**Interfaces:**
- Produces: table `ulp.credential_dedup_meta`, consumed by Task 3's backfill script.

- [ ] **Step 1: Add the v20 summary line**

In `lib/clickhouse-migrations.ts`, after the `// v19: idx_ngram_domain...` line (and its continuation lines), add:

```ts
// v20: credential_dedup_meta companion table — captures cross-source
//      duplicate lineage (source_count, sources, first/last seen, canonical
//      row) for the dedup backfill. Empty until the backfill script (see
//      docs/superpowers/specs/2026-09-24-credential-dedup-backfill-design.md)
//      populates it; creating the table here is schema-only.
```

- [ ] **Step 2: Bump DDL_VERSION**

Change:
```ts
const DDL_VERSION = 19
```
to:
```ts
const DDL_VERSION = 20
```

- [ ] **Step 3: Add the v20 migration block**

Immediately before the final `if (lastDdl < DDL_VERSION) { setSetting(...) ... }` block, add:

```ts
  // v20 — credential_dedup_meta companion table (see DDL_VERSION comment
  // above). Plain CREATE TABLE, no MATERIALIZE step needed — it starts empty;
  // the backfill script populates it separately and explicitly.
  if (lastDdl < 20) {
    await runMigration(
      `CREATE TABLE IF NOT EXISTS ulp.credential_dedup_meta
       (
           content_key_hash    UInt64,
           source_count         UInt32,
           sources               Array(String),
           first_seen            DateTime,
           last_seen             DateTime,
           canonical_url         String,
           canonical_email       String,
           canonical_password    String,
           canonical_source_file String
       )
       ENGINE = MergeTree()
       ORDER BY content_key_hash`
    )
    console.warn('[ClickHouse migration] DDL v20 applied (created credential_dedup_meta companion table)')
  }
```

- [ ] **Step 4: Mirror into the init SQL for fresh installs**

In `docker/clickhouse/init/01-ulp-tables.sql`, after the `ulp.credentials` table definition (after its closing `SETTINGS` clause and semicolon), add:

```sql
-- credential_dedup_meta: companion table for the dedup backfill (see
-- lib/clickhouse-migrations.ts DDL v20 and
-- docs/superpowers/specs/2026-09-24-credential-dedup-backfill-design.md).
-- Starts empty; populated by scripts/backfill-credential-dedup.sh.
CREATE TABLE IF NOT EXISTS ulp.credential_dedup_meta
(
    content_key_hash    UInt64,
    source_count         UInt32,
    sources               Array(String),
    first_seen            DateTime,
    last_seen             DateTime,
    canonical_url         String,
    canonical_email       String,
    canonical_password    String,
    canonical_source_file String
)
ENGINE = MergeTree()
ORDER BY content_key_hash;
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Create the real table directly (don't wait for an app redeploy)**

`runClickHouseMigrations()` only runs when the upload route is hit, and the running `ulpsuite_app` container has its own baked-in `node_modules`/build from whenever it was last deployed — it won't pick up this source change until its next rebuild. Rather than forcing an app container rebuild/restart just to exercise this one migration, create the table directly with the identical DDL (the migration will no-op via `IF NOT EXISTS` whenever the app does next redeploy, so there's no drift risk):

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
CREATE TABLE IF NOT EXISTS ulp.credential_dedup_meta
(
    content_key_hash    UInt64,
    source_count         UInt32,
    sources               Array(String),
    first_seen            DateTime,
    last_seen             DateTime,
    canonical_url         String,
    canonical_email       String,
    canonical_password    String,
    canonical_source_file String
)
ENGINE = MergeTree()
ORDER BY content_key_hash
"
docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credential_dedup_meta"
```

Expected: `1`.

- [ ] **Step 7: Commit**

```bash
git add lib/clickhouse-migrations.ts docker/clickhouse/init/01-ulp-tables.sql
git commit -m "feat(clickhouse): add credential_dedup_meta companion table (DDL v20)

Empty schema addition — captures cross-source duplicate lineage
(source_count, sources, first/last seen, canonical row) for the
dedup backfill. No change to ulp.credentials. Also created directly
in the live container since the app won't pick up this migration
until its next redeploy."
```

---

### Task 3: Build the backfill script

**Files:**
- Create: `scripts/backfill-credential-dedup.sh`

**Interfaces:**
- Consumes: `ulp.credential_dedup_meta` (Task 2).
- Produces: populated `ulp.credential_dedup_meta`, and (only under `APPLY=1`) a mutated `ulp.credentials`.

- [ ] **Step 1: Write the script**

Create `scripts/backfill-credential-dedup.sh`:

```bash
#!/usr/bin/env bash
# Collapse ulp.credentials' exact-duplicate rows (by content_key_hash) into
# one canonical row per group, preserving cross-source lineage in
# ulp.credential_dedup_meta. Dry-run by default. Destructive modes:
#   BACKUP_VERIFIED=1 APPLY=1 bash scripts/backfill-credential-dedup.sh
#   ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/backfill-credential-dedup.sh
#
# See docs/superpowers/specs/2026-09-24-credential-dedup-backfill-design.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
BACKUP_VERIFIED="${BACKUP_VERIFIED:-0}"
ACCEPT_PERMANENT_DATA_LOSS="${ACCEPT_PERMANENT_DATA_LOSS:-0}"
CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"

cd "$PROJECT_DIR"

if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  if command -v docker.exe >/dev/null 2>&1 && docker.exe info >/dev/null 2>&1; then
    DOCKER_BIN="docker.exe"
  else
    echo "ERROR: Docker is unavailable in this shell." >&2
    exit 1
  fi
fi

if ! "$DOCKER_BIN" inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: ClickHouse container '$CONTAINER' is not running." >&2
  exit 1
fi

ch() {
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "$1"
}

echo "ULP Suite - credential dedup backfill"
echo "APPLY=$APPLY (0 = dry-run)"
echo

echo "Building ulp.credential_dedup_meta (this reads the full credentials table once)..."
ch "TRUNCATE TABLE ulp.credential_dedup_meta"
ch "
INSERT INTO ulp.credential_dedup_meta
SELECT
    content_key_hash,
    count() AS source_count,
    groupUniqArray(50)(source_file) AS sources,
    min(imported_at) AS first_seen,
    max(imported_at) AS last_seen,
    argMin(url, (imported_at, url, email, password)) AS canonical_url,
    argMin(email, (imported_at, url, email, password)) AS canonical_email,
    argMin(password, (imported_at, url, email, password)) AS canonical_password,
    argMin(source_file, (imported_at, url, email, password)) AS canonical_source_file
FROM ulp.credentials
GROUP BY content_key_hash
SETTINGS max_bytes_before_external_group_by = 10000000000,
         max_execution_time = 0,
         max_threads = 4
"

echo
echo "Integrity check: sum(source_count) must equal ulp.credentials' total row count."
total_credentials="$(ch "SELECT count() FROM ulp.credentials FORMAT TSVRaw")"
sum_source_count="$(ch "SELECT sum(source_count) FROM ulp.credential_dedup_meta FORMAT TSVRaw")"
echo "  ulp.credentials total:            $total_credentials"
echo "  sum(source_count) in companion:   $sum_source_count"
if [[ "$total_credentials" != "$sum_source_count" ]]; then
  echo "ERROR: integrity check failed -- these must match exactly. Not proceeding." >&2
  exit 1
fi
echo "  OK: integrity check passed."

canonical_rows="$(ch "SELECT count() FROM ulp.credential_dedup_meta FORMAT TSVRaw")"
would_delete=$((total_credentials - canonical_rows))
echo
echo "Companion table has $canonical_rows canonical groups."
echo "This would delete $would_delete duplicate rows, keeping $canonical_rows."

echo
echo "Sample of duplicate groups by source_count (top 10):"
ch "
SELECT content_key_hash, source_count, length(sources) AS distinct_sources_seen, first_seen, last_seen
FROM ulp.credential_dedup_meta
ORDER BY source_count DESC
LIMIT 10
FORMAT PrettyCompact
"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry-run complete; no deletion submitted."
  echo "ulp.credential_dedup_meta is populated and ready to query."
  echo "After verifying an off-host backup, run:"
  echo "  BACKUP_VERIFIED=1 APPLY=1 bash scripts/backfill-credential-dedup.sh"
  echo "Or, to proceed irreversibly without a backup:"
  echo "  ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/backfill-credential-dedup.sh"
  exit 0
fi

if [[ "$BACKUP_VERIFIED" != "1" && "$ACCEPT_PERMANENT_DATA_LOSS" != "1" ]]; then
  echo "ERROR: refusing permanent deletion without an explicit acknowledgement." >&2
  echo "Use BACKUP_VERIFIED=1 after backup verification, or ACCEPT_PERMANENT_DATA_LOSS=1 to proceed without recovery." >&2
  exit 1
fi

if [[ "$BACKUP_VERIFIED" != "1" ]]; then
  echo "WARNING: no verified backup; permanent duplicate-row data loss explicitly accepted." >&2
fi

active="$(ch "
SELECT count() FROM system.mutations
WHERE database = 'ulp' AND table = 'credentials' AND is_done = 0
FORMAT TSVRaw
")"
if [[ "$active" != "0" ]]; then
  echo "ERROR: $active credential-table mutation(s) are already active; wait before purging." >&2
  exit 1
fi

bytes_before="$(ch "
SELECT formatReadableSize(sum(bytes_on_disk))
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
FORMAT TSVRaw
")"

echo
echo "Submitting bounded-memory lightweight duplicate-row deletion..."
ch "
DELETE FROM ulp.credentials
WHERE (content_key_hash, imported_at, url, email, password) NOT IN (
    SELECT content_key_hash, first_seen, canonical_url, canonical_email, canonical_password
    FROM ulp.credential_dedup_meta
)
SETTINGS lightweight_deletes_sync = 2,
         max_threads = 2,
         max_execution_time = 0,
         join_algorithm = 'auto'
"

remaining="$(ch "SELECT count() FROM ulp.credentials FORMAT TSVRaw")"
if [[ "$remaining" != "$canonical_rows" ]]; then
  echo "ERROR: post-delete row count ($remaining) does not match expected canonical row count ($canonical_rows)." >&2
  exit 1
fi

bytes_after="$(ch "
SELECT formatReadableSize(sum(bytes_on_disk))
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
FORMAT TSVRaw
")"

echo "Dedup purge complete; ulp.credentials now has $remaining rows (was $total_credentials)."
echo "Active-part storage: $bytes_before before, $bytes_after immediately after."
echo "Physical disk is reclaimed gradually by normal background merges; no OPTIMIZE FINAL is run."
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/backfill-credential-dedup.sh
```

- [ ] **Step 3: Shellcheck it (matches this codebase's script quality bar)**

```bash
shellcheck scripts/backfill-credential-dedup.sh 2>&1 || echo "shellcheck not installed, skipping — not a blocker"
```

Fix anything shellcheck flags, unless it's unavailable (non-fatal — the existing `purge-existing-t3.sh` this mirrors would show the same baseline warnings, if any).

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-credential-dedup.sh
git commit -m "feat(scripts): add credential dedup backfill script

Mirrors scripts/purge-existing-t3.sh's exact safety pattern: dry-run
by default, requires APPLY=1 plus BACKUP_VERIFIED=1 or
ACCEPT_PERMANENT_DATA_LOSS=1 for the actual deletion, refuses to run
while another mutation is active, reports bytes before/after.

Dry-run path populates ulp.credential_dedup_meta for real (safe,
non-destructive) and previews the would-be deletion; only the
DELETE itself is gated behind APPLY=1."
```

---

### Task 4: Run the dry-run against production and report

**Files:** none — this task runs the script built in Task 3 against real data, dry-run only.

**Interfaces:** none.

- [ ] **Step 1: Run the script with no APPLY (dry-run)**

```bash
bash scripts/backfill-credential-dedup.sh 2>&1 | tee /tmp/claude-1000/-home-cole-ulp-suite/6364c04d-7775-41cf-be68-60474496dd89/scratchpad/dedup-dryrun-output.txt
```

This will take real time — it reads the full `ulp.credentials` table once for the aggregation. Let it run to completion; do not interrupt.

- [ ] **Step 2: Confirm the integrity check passed**

Check the script's own output for "OK: integrity check passed." If it printed the ERROR instead and exited non-zero, stop here — do not proceed to Task 3's Step 3/4 rework blind; re-examine the aggregation query against a fresh sample (repeat Task 1's validation) before touching the script again.

- [ ] **Step 3: Record the real numbers**

From the script's output, note: total `ulp.credentials` row count, canonical row count, would-delete count, and the top-10 duplicate groups by `source_count`. These are the real, current numbers — likely different from the 2026-09-24 sampled estimates in the spec, since the table keeps growing under live ingest.

- [ ] **Step 4: Report to the user**

Summarize the dry-run results (row counts, storage-reduction estimate, a couple of the most-duplicated groups as concrete examples) and stop. Do **not** run `APPLY=1` — that is explicitly a separate, later, human-confirmed action, not part of this plan.
