# Scale Tiered Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ulp.credentials` scale toward the ~15B-row (or ~5B with the recency projection) disk-budget ceiling calculated in the design spec, by scoping the recency projection to recent partitions and archiving old partitions to compact on-disk files instead of either bloating the live table forever or deleting data outright.

**Architecture:** Two independent additions plus one observability addition. (1) An in-app Node.js cron (`lib/projection-scope.ts` + `lib/projection-scope-cron.ts`, mirroring `lib/content-dedup.ts` + `lib/dedup-cron.ts`) clears `proj_imported_desc` from partitions older than a recency window — pure SQL over the existing ClickHouse client, no new infrastructure. (2) A host-run bash script pair (`scripts/archive-old-partitions.sh` + `scripts/restore-archive.sh`, mirroring `scripts/dedup-credentials-content.sh`) exports old partitions to zstd-compressed Native files and drops them, with a matching restore path — this cannot be an in-app cron because it needs `docker exec` + the `zstd` CLI, and the app container has no Docker socket access to control the ClickHouse container from inside itself. (3) `lib/disk-budget.ts` plus small extensions to the existing Ingest Health route/panel surface the live-table's disk usage against the confirmed ~550GB budget.

**Tech Stack:** TypeScript, ClickHouse 26.x (Native format, `system.parts`/`system.projection_parts`), Vitest, Bash, `zstd`.

## Global Constraints

- No new hardware — every mechanism here operates within the current single-disk, single-node laptop.
- Filter aggressiveness (T3-only hard-drop) is unchanged — confirmed, not part of this plan's scope.
- Every new destructive or semi-destructive mechanism is dry-run/report-only by default; an explicit opt-in (`APPLY=1` for scripts, `ARCHIVE_APPLY`-style env var is not used — see Task 3, scripts use `APPLY=1` directly matching `dedup-credentials-content.sh`) is required to act.
- Nothing is pushed to `origin/main` without explicit user confirmation, per standing project policy.
- `CLEAR PROJECTION IN PARTITION` and `DROP PARTITION` are both metadata-level, partition-scoped operations — never a full-table `ALTER ... DELETE` mutation, to avoid repeating the 414M-row `MEMORY_LIMIT_EXCEEDED` incident (`docs/superpowers/specs/2026-06-21-low-memory-t3-purge-design.md`).

---

### Task 1: Verify Real Ingest Throughput

**Files:** none created or modified — this is a verification task, closing the honesty gap the design spec flagged (no measured ingest rate exists for this pipeline on this hardware).

**Interfaces:** none — informational only, doesn't block Tasks 2-4.

- [ ] **Step 1: Run the benchmark from a throwaway container on the ClickHouse network**

`scripts/benchmark-import.ts` needs `CLICKHOUSE_HOST=http://clickhouse:8123` (the internal Docker network hostname), which only resolves inside `ulpsuite_network`. The deployed `ulpsuite_app` image doesn't ship `scripts/` or `tsx` (confirmed: it's a lean Next.js standalone production image — see `Dockerfile`'s runner stage). Running a throwaway `node:24-bookworm-slim` container on the same network, with the live repo bind-mounted (so it uses the host's own already-installed `node_modules`, which has `tsx` and everything else this repo needs), avoids both problems:

```bash
mkdir -p /tmp/dockercfg-scratch && echo '{}' > /tmp/dockercfg-scratch/config.json
DOCKER_CONFIG=/tmp/dockercfg-scratch docker run --rm --network ulpsuite_network \
  -v "$(pwd):/app" -w /app \
  -e CLICKHOUSE_HOST=http://clickhouse:8123 -e CLICKHOUSE_USER=default \
  -e CLICKHOUSE_PASSWORD= -e CLICKHOUSE_DATABASE=ulp \
  node:24-bookworm-slim npx tsx scripts/benchmark-import.ts --rows 500000
```

The `DOCKER_CONFIG` scratch dir works around this machine's broken global `credsStore` (see `[[project-docker-credstore-workaround]]` in project memory) without touching `~/.docker/config.json`. If this machine doesn't have that issue, the plain `docker run ...` command works the same without the `DOCKER_CONFIG` prefix.

Expected: the script runs `streamCredentialsToTable` against a throwaway `ulp.bench_<timestamp>` table (never `ulp.credentials` — see `assertBenchTable` in the script) and prints a `rows/s` figure at the end.

- [ ] **Step 2: Record the result**

Note the reported `rows/s` (and whether the run was parse-bound or insert-bound, per the script's own output) in a comment at the top of `docs/superpowers/specs/2026-07-03-scale-tiered-archive-design.md`'s "Current State / Constraints" section — this closes the gap the spec explicitly flagged as open. No code change; this is a documentation update:

```markdown
**Measured ingest throughput (2026-07-03):** <rows/s from Step 1 output> rows/sec, <parse-bound|insert-bound>, via `scripts/benchmark-import.ts --rows 500000` on this hardware.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-03-scale-tiered-archive-design.md
git commit -m "docs(specs): record measured ingest throughput"
```

---

### Task 2: Projection-Scoping Cron

**Files:**
- Create: `lib/projection-scope.ts`
- Create: `lib/projection-scope-cron.ts`
- Test: `__tests__/projection-scope.test.ts`
- Test: `__tests__/projection-scope-cron.test.ts`
- Modify: `instrumentation.ts`

**Interfaces:**
- Consumes: `getClient` from `lib/clickhouse.ts`; `msUntilNextRun` from `lib/dedup-cron.ts` (reused, not duplicated).
- Produces: `runProjectionScopeTick(opts?: { trigger?: string; now?: Date }): Promise<ProjectionScopeTickResult>` and `startProjectionScopeCron(): void`, consumed by `instrumentation.ts`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/projection-scope.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import {
  projectionScopeCronHours,
  projectionScopeWindowMonths,
  cutoffPartition,
  buildEligiblePartitionsSql,
  buildClearProjectionSql,
  PROJECTION_NAME,
} from '@/lib/projection-scope'

describe('projection-scope config', () => {
  test('projectionScopeCronHours defaults to 24', () => {
    expect(projectionScopeCronHours({})).toBe(24)
  })
  test('projectionScopeCronHours honors a positive override', () => {
    expect(projectionScopeCronHours({ PROJECTION_SCOPE_CRON_HOURS: '6' })).toBe(6)
  })
  test('projectionScopeCronHours 0/invalid disables (returns 0)', () => {
    expect(projectionScopeCronHours({ PROJECTION_SCOPE_CRON_HOURS: '0' })).toBe(0)
    expect(projectionScopeCronHours({ PROJECTION_SCOPE_CRON_HOURS: 'nope' })).toBe(0)
  })

  test('projectionScopeWindowMonths defaults to 2', () => {
    expect(projectionScopeWindowMonths({})).toBe(2)
  })
  test('projectionScopeWindowMonths honors an override', () => {
    expect(projectionScopeWindowMonths({ PROJECTION_SCOPE_WINDOW_MONTHS: '3' })).toBe(3)
  })
})

describe('cutoffPartition', () => {
  test('subtracts the window in months, across a year boundary', () => {
    expect(cutoffPartition(2, new Date('2026-01-15T00:00:00Z'))).toBe('202511')
  })
  test('same-year subtraction', () => {
    expect(cutoffPartition(2, new Date('2026-07-03T00:00:00Z'))).toBe('202605')
  })
})

describe('SQL builders', () => {
  test('buildEligiblePartitionsSql filters to partitions older than cutoff', () => {
    const sql = buildEligiblePartitionsSql('202605')
    expect(sql).toContain("partition < '202605'")
    expect(sql).toContain("database = 'ulp'")
    expect(sql).toContain("table = 'credentials'")
  })
  test('buildClearProjectionSql targets the exact projection and partition', () => {
    expect(buildClearProjectionSql('202605')).toBe(
      `ALTER TABLE ulp.credentials CLEAR PROJECTION ${PROJECTION_NAME} IN PARTITION '202605'`,
    )
  })
})
```

Create `__tests__/projection-scope-cron.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('projection-scope-cron source contract', () => {
  const source = readFileSync(new URL('../lib/projection-scope-cron.ts', import.meta.url), 'utf8')

  test('reuses msUntilNextRun from dedup-cron instead of duplicating it', () => {
    expect(source).toContain("import { msUntilNextRun } from '@/lib/dedup-cron'")
  })
  test('anchors the first tick via msUntilNextRun, not a fixed startup delay', () => {
    expect(source).toContain('msUntilNextRun(')
    expect(source).not.toContain('}, 60_000)')
  })
})
```

- [ ] **Step 2: Run the tests and confirm RED**

```bash
npx vitest run __tests__/projection-scope.test.ts __tests__/projection-scope-cron.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/projection-scope'` / `'@/lib/projection-scope-cron'` (neither file exists yet).

- [ ] **Step 3: Write `lib/projection-scope.ts`**

```ts
/**
 * Scopes the proj_imported_desc projection (DDL v14, lib/clickhouse-migrations.ts) to
 * recent partitions only, so the "browse by newest" speedup keeps costing storage
 * only where it's actually used. New inserts always land in the current month's
 * partition (imported_at DEFAULT now()), so recent data keeps the projection
 * automatically; this clears it from partitions once they age out of the window.
 *
 * CLEAR PROJECTION removes only the projection's redundant stored copy for that
 * partition -- the underlying rows in the base table are completely untouched, so
 * unlike lib/archive-old-partitions this needs no apply-gate: nothing unique is
 * ever at risk.
 */
import { getClient } from '@/lib/clickhouse'

export const PROJECTION_NAME = 'proj_imported_desc'

/** Cron interval in hours; 0 (or invalid) disables the scheduled job. Default 24. */
export function projectionScopeCronHours(env: NodeJS.ProcessEnv = process.env): number {
  const h = parseInt(env.PROJECTION_SCOPE_CRON_HOURS ?? '24', 10)
  return Number.isFinite(h) && h > 0 ? h : 0
}

/** How many months of the most recent data keep the projection. Default 2. */
export function projectionScopeWindowMonths(env: NodeJS.ProcessEnv = process.env): number {
  const m = parseInt(env.PROJECTION_SCOPE_WINDOW_MONTHS ?? '2', 10)
  return Number.isFinite(m) && m > 0 ? m : 2
}

/** First partition (YYYYMM string) that should KEEP the projection. Anything older is cleared. */
export function cutoffPartition(windowMonths: number, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - windowMonths, 1))
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function buildEligiblePartitionsSql(cutoff: string): string {
  return `SELECT DISTINCT partition FROM system.parts
    WHERE database = 'ulp' AND table = 'credentials' AND active
      AND partition < '${cutoff}'
    ORDER BY partition`
}

export function buildClearProjectionSql(partition: string): string {
  return `ALTER TABLE ulp.credentials CLEAR PROJECTION ${PROJECTION_NAME} IN PARTITION '${partition}'`
}

let tickInFlight = false

export interface ProjectionScopeTickResult {
  cutoff: string
  cleared: string[]
}

/** Clear proj_imported_desc from every partition older than the recency window. Never throws. */
export async function runProjectionScopeTick(
  opts: { trigger?: string; now?: Date } = {},
): Promise<ProjectionScopeTickResult> {
  const trigger = opts.trigger ?? 'tick'
  const now = opts.now ?? new Date()
  if (tickInFlight) return { cutoff: '', cleared: [] }
  tickInFlight = true
  try {
    const cutoff = cutoffPartition(projectionScopeWindowMonths(), now)
    const client = getClient()
    const res = await client.query({ query: buildEligiblePartitionsSql(cutoff), format: 'JSONEachRow' })
    const rows = (await res.json()) as Array<{ partition: string }>
    const cleared: string[] = []
    for (const { partition } of rows) {
      await client.exec({ query: buildClearProjectionSql(partition) })
      cleared.push(partition)
    }
    console.log(
      `[projection-scope] ${trigger}: cutoff=${cutoff} cleared=[${cleared.join(', ') || 'none'}]`,
    )
    return { cutoff, cleared }
  } catch (err) {
    console.error('[projection-scope] tick failed:', err)
    return { cutoff: '', cleared: [] }
  } finally {
    tickInFlight = false
  }
}
```

Create `lib/projection-scope-cron.ts`:

```ts
/**
 * Scheduled proj_imported_desc scoping.
 *
 * Ticks every PROJECTION_SCOPE_CRON_HOURS hours (default 24; 0 disables) and runs
 * runProjectionScopeTick() to clear the recency projection from partitions that have
 * aged out of the window. Mirrors lib/dedup-cron.ts exactly, including reusing its
 * msUntilNextRun anchor helper -- no reason to duplicate that logic. Anchored to
 * 05:00 UTC (one hour after the dedup cron's 04:00) so the two crons don't compete
 * for ClickHouse resources at the same instant.
 */
import { msUntilNextRun } from '@/lib/dedup-cron'
import { projectionScopeCronHours, runProjectionScopeTick } from '@/lib/projection-scope'

let started = false

export function startProjectionScopeCron(): void {
  if (started) return
  const hours = projectionScopeCronHours()
  if (hours <= 0) {
    console.log('[projection-scope] cron disabled (PROJECTION_SCOPE_CRON_HOURS=0)')
    return
  }
  started = true
  const ms = hours * 60 * 60 * 1000
  const initialDelay = msUntilNextRun(5, new Date())
  console.log(
    `[projection-scope] cron started — first tick in ${Math.round(initialDelay / 60_000)}m ` +
      `(anchored to 05:00 UTC), then every ${hours}h`,
  )
  setTimeout(() => { runProjectionScopeTick({ trigger: 'cron' }).catch(console.error) }, initialDelay)
  setInterval(() => { runProjectionScopeTick({ trigger: 'cron' }).catch(console.error) }, ms)
}
```

- [ ] **Step 4: Run the tests and confirm GREEN**

```bash
npx vitest run __tests__/projection-scope.test.ts __tests__/projection-scope-cron.test.ts
```

Expected: PASS (10 tests across both files).

- [ ] **Step 5: Wire into `instrumentation.ts`**

In `instrumentation.ts`, inside the existing `if (process.env.NODE_ENV === 'production')` block, immediately after the `startDedupCron` try/catch:

```ts
      // Scheduled proj_imported_desc scoping (clears the recency projection from
      // partitions older than the recency window; harmless if it never runs).
      try {
        const { startProjectionScopeCron } = await import('./lib/projection-scope-cron')
        startProjectionScopeCron()
      } catch (err) {
        console.error('[instrumentation] Projection-scope cron failed to start:', err)
      }
```

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit --tsBuildInfoFile /tmp/tsc-scale-plan.tsbuildinfo
```

Expected: clean (no errors). Use a scratch `--tsBuildInfoFile` path if `tsconfig.tsbuildinfo` isn't writable by your user — check with `ls -la tsconfig.tsbuildinfo`; on this machine it is root-owned as of 2026-07-03, blocking writes from the normal user account.

- [ ] **Step 7: Commit**

```bash
git add lib/projection-scope.ts lib/projection-scope-cron.ts \
  __tests__/projection-scope.test.ts __tests__/projection-scope-cron.test.ts \
  instrumentation.ts
git commit -m "feat(scale): scope proj_imported_desc to recent partitions via cron"
```

---

### Task 3: Archive and Restore Scripts

**Files:**
- Create: `scripts/archive-old-partitions.sh`
- Create: `scripts/restore-archive.sh`

**Interfaces:**
- Consumes: `docker exec ulpsuite_clickhouse clickhouse-client`, the `zstd` CLI (both already relied on by every existing `scripts/*.sh` in this project).
- Produces: `<ARCHIVE_DIR>/<partition>.native.zst` files; a `ulp.archive_scratch_<timestamp>` table on restore. No TypeScript interface — these are operator scripts, consistent with `scripts/dedup-credentials-content.sh` having no automated test (this project's tests cover `lib/` and API routes, not operator shell scripts).

- [ ] **Step 1: Write `scripts/archive-old-partitions.sh`**

```bash
#!/bin/bash
# =============================================================================
# archive-old-partitions.sh
#
# Exports partitions of ulp.credentials older than ARCHIVE_AGE_MONTHS (default 3)
# to compact zstd-compressed Native-format files in ARCHIVE_DIR (default ./archive),
# then drops them from the live table -- the on-disk cold-tier half of
# docs/superpowers/specs/2026-07-03-scale-tiered-archive-design.md.
#
# Native format round-trips back into a table later (see scripts/restore-archive.sh)
# with no schema translation, and carries none of the live table's index/projection
# storage overhead, so an archived partition is far denser than its live equivalent.
#
# SAFETY: dry-run by default -- reports candidate partitions and their row counts,
# exports and drops NOTHING unless APPLY=1. A partition is only dropped after its
# row count is re-confirmed unchanged against the live table right before the drop.
#
# Usage:
#   bash scripts/archive-old-partitions.sh                       # dry run (default)
#   APPLY=1 bash scripts/archive-old-partitions.sh                # actually export + drop
#   ARCHIVE_AGE_MONTHS=6 bash scripts/archive-old-partitions.sh   # override the age threshold
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
ARCHIVE_AGE_MONTHS="${ARCHIVE_AGE_MONTHS:-3}"
ARCHIVE_DIR="${ARCHIVE_DIR:-./archive}"
APPLY="${APPLY:-0}"

CUTOFF=$($CH "SELECT formatDateTime(addMonths(today(), -${ARCHIVE_AGE_MONTHS}), '%Y%m')" --format TabSeparated)

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — archive old partitions                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Cutoff partition (older than $ARCHIVE_AGE_MONTHS months): $CUTOFF"
echo "Archive directory: $ARCHIVE_DIR"
echo ""

echo "═══ Candidate partitions ═══"
$CH "
SELECT partition, sum(rows) AS rows, formatReadableSize(sum(data_compressed_bytes)) AS compressed
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
  AND partition < '$CUTOFF'
GROUP BY partition
ORDER BY partition
" --format PrettyCompact

PARTITIONS=$($CH "
SELECT DISTINCT partition FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
  AND partition < '$CUTOFF'
ORDER BY partition
" --format TabSeparated)

if [ -z "$PARTITIONS" ]; then
  echo "No partitions older than $CUTOFF. Nothing to do."
  exit 0
fi

if [ "$APPLY" != "1" ]; then
  echo ""
  echo "Dry-run. Set APPLY=1 to actually export + drop the partitions above."
  exit 0
fi

mkdir -p "$ARCHIVE_DIR"

for PART in $PARTITIONS; do
  FILE="$ARCHIVE_DIR/$PART.native.zst"
  echo ""
  echo "-- Partition $PART: exporting to $FILE --"
  EXPECTED=$($CH "SELECT count() FROM ulp.credentials WHERE toYYYYMM(imported_at) = $PART" --format TabSeparated)

  if ! (docker exec ulpsuite_clickhouse clickhouse-client --query \
    "SELECT * FROM ulp.credentials WHERE toYYYYMM(imported_at) = $PART FORMAT Native" \
    | zstd -q -o "$FILE"); then
    echo "ERROR: export failed for partition $PART. Not dropping. Skipping."
    rm -f "$FILE"
    continue
  fi

  ACTUAL=$($CH "SELECT count() FROM ulp.credentials WHERE toYYYYMM(imported_at) = $PART" --format TabSeparated)

  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "ERROR: row count changed during export ($EXPECTED -> $ACTUAL) for partition $PART."
    echo "Not dropping -- live data may have changed mid-export (e.g. a new import landed)."
    echo "Re-run once imports have quiesced."
    rm -f "$FILE"
    continue
  fi

  echo "Verified: $ACTUAL rows exported and confirmed still $ACTUAL live. Dropping partition."
  $CH "ALTER TABLE ulp.credentials DROP PARTITION '$PART'"
  echo "Dropped partition $PART ($ACTUAL rows archived to $FILE)."
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Done. Archived files are in $ARCHIVE_DIR/ -- restore with scripts/restore-archive.sh."
echo "═══════════════════════════════════════════════════════════════"
```

- [ ] **Step 2: Make it executable and dry-run it**

```bash
chmod +x scripts/archive-old-partitions.sh
bash scripts/archive-old-partitions.sh
```

Expected: prints the candidate-partitions table (likely empty on a freshly-migrated table with only the current month's partition) and exits after "Dry-run." — no files created, nothing dropped. `APPLY=1` is not passed as part of this plan; that is a separate, explicit operator decision, same as every other destructive script in this project.

- [ ] **Step 3: Write `scripts/restore-archive.sh`**

```bash
#!/bin/bash
# =============================================================================
# restore-archive.sh
#
# Loads an archive file (produced by scripts/archive-old-partitions.sh) into an
# isolated ulp.archive_scratch_<timestamp> table for occasional deep dives --
# NEVER ulp.credentials directly, so a restore can never collide with or
# overwrite live production data. Mirrors scripts/benchmark-import.ts's
# assertBenchTable isolation guard, adapted to bash.
#
# Usage:
#   bash scripts/restore-archive.sh ./archive/202601.native.zst
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

ARCHIVE_FILE="${1:-}"
if [ -z "$ARCHIVE_FILE" ] || [ ! -f "$ARCHIVE_FILE" ]; then
  echo "Usage: bash scripts/restore-archive.sh <path-to-archive-file>.native.zst"
  exit 1
fi

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
TABLE="ulp.archive_scratch_$(date +%s)"

# Guard: refuse to operate on anything but a ulp.archive_scratch_* table -- a
# restore must never be able to target ulp.credentials, even by mistake.
if [[ ! "$TABLE" =~ ^ulp\.archive_scratch_[0-9]+$ ]]; then
  echo "ERROR: refusing to use non-scratch table name: $TABLE"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — restore archive into scratch table              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Archive file: $ARCHIVE_FILE"
echo "Target (isolated, never live): $TABLE"
echo ""

echo "═══ Creating scratch table (same shape as ulp.credentials, plain local MergeTree) ═══"
$CH "CREATE TABLE $TABLE AS ulp.credentials ENGINE = MergeTree PARTITION BY toYYYYMM(imported_at) ORDER BY (domain, email, imported_at)"

echo "═══ Loading archive into $TABLE ═══"
if ! (zstd -dc "$ARCHIVE_FILE" | docker exec -i ulpsuite_clickhouse clickhouse-client --query "INSERT INTO $TABLE FORMAT Native"); then
  echo "ERROR: restore failed. $TABLE may be partially populated -- inspect or drop it:"
  echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \"DROP TABLE $TABLE\""
  exit 1
fi

echo "═══ Verify ═══"
$CH "SELECT count() AS rows FROM $TABLE" --format PrettyCompact

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Restored into $TABLE. Query it directly, e.g.:"
echo "  docker exec -it ulpsuite_clickhouse clickhouse-client --query \"SELECT * FROM $TABLE LIMIT 10\""
echo ""
echo "This scratch table is never cleaned up automatically -- drop it when done:"
echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \"DROP TABLE $TABLE\""
echo "═══════════════════════════════════════════════════════════════"
```

- [ ] **Step 4: Make it executable and verify the round-trip against a real (harmless) partition**

```bash
chmod +x scripts/restore-archive.sh
```

If Step 2's dry-run showed at least one real archive-eligible partition, temporarily run `ARCHIVE_AGE_MONTHS=0 APPLY=1 bash scripts/archive-old-partitions.sh` against a **non-production, disposable copy of the data** to confirm export→drop actually leaves a valid `.native.zst` file, then `bash scripts/restore-archive.sh <file>` to confirm it loads and the row count matches. Do **not** run `APPLY=1` against real `ulp.credentials` data as part of this plan — that first real run is a separate, explicit operator decision (same rule as Step 2 of `scripts/archive-old-partitions.sh` above), to be made once this plan's automated pieces (Tasks 2 and 4) are already deployed and the operator has chosen an actual `ARCHIVE_AGE_MONTHS` cutoff for their real data.

- [ ] **Step 5: Commit**

```bash
git add scripts/archive-old-partitions.sh scripts/restore-archive.sh
git commit -m "feat(scale): add archive-old-partitions + restore-archive operator scripts"
```

---

### Task 4: Disk-Budget Monitoring

**Files:**
- Create: `lib/disk-budget.ts`
- Test: `__tests__/disk-budget.test.ts`
- Modify: `app/api/monitoring/ingest-health/route.ts`
- Modify: `components/ingest-health-panel.tsx`
- Modify: `__tests__/ingest-health-route.test.ts`

**Interfaces:**
- Produces: `diskBudgetBytes(env?): number`, `buildLiveBytesSql(): string`, `diskBudgetPct(usedBytes: number, budgetBytes: number): number` from `lib/disk-budget.ts`.
- Modifies: the `GET` handler in `app/api/monitoring/ingest-health/route.ts` to add a `diskBudget: { usedBytes: number; budgetBytes: number; pct: number; note?: string }` field to its JSON response — existing `app`/`clickhouse` fields are unchanged.

- [ ] **Step 1: Write the failing test for `lib/disk-budget.ts`**

Create `__tests__/disk-budget.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { diskBudgetBytes, buildLiveBytesSql, diskBudgetPct } from '@/lib/disk-budget'

describe('diskBudgetBytes', () => {
  test('defaults to 550GB', () => {
    expect(diskBudgetBytes({})).toBe(550 * 1024 ** 3)
  })
  test('honors an override', () => {
    expect(diskBudgetBytes({ DISK_BUDGET_BYTES: '1000' })).toBe(1000)
  })
  test('invalid/zero falls back to the default', () => {
    expect(diskBudgetBytes({ DISK_BUDGET_BYTES: '0' })).toBe(550 * 1024 ** 3)
    expect(diskBudgetBytes({ DISK_BUDGET_BYTES: 'nope' })).toBe(550 * 1024 ** 3)
  })
})

describe('buildLiveBytesSql', () => {
  test('sums both base table and projection compressed bytes', () => {
    const sql = buildLiveBytesSql()
    expect(sql).toContain('system.parts')
    expect(sql).toContain('system.projection_parts')
    expect(sql).toContain('data_compressed_bytes')
  })
})

describe('diskBudgetPct', () => {
  test('computes a rounded percentage', () => {
    expect(diskBudgetPct(275 * 1024 ** 3, 550 * 1024 ** 3)).toBe(50)
  })
  test('returns 0 when budget is 0 (avoids divide-by-zero)', () => {
    expect(diskBudgetPct(100, 0)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test and confirm RED**

```bash
npx vitest run __tests__/disk-budget.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/disk-budget'`.

- [ ] **Step 3: Write `lib/disk-budget.ts`**

```ts
/**
 * Live-table disk-budget check for the credentials store, surfaced on the Ingest
 * Health panel so the ~550GB ceiling (docs/superpowers/specs/2026-07-03-scale-
 * tiered-archive-design.md) is a visible, monitored number rather than something
 * discovered via a failed insert. Counts both the base table and the
 * proj_imported_desc projection -- the projection is a real, separate cost
 * (system.projection_parts), not included in system.parts.
 */

/** Live-table budget in bytes. Default 550GB (~70% of this laptop's 784GB disk). */
export function diskBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const b = parseInt(env.DISK_BUDGET_BYTES ?? '', 10)
  return Number.isFinite(b) && b > 0 ? b : 550 * 1024 ** 3
}

export function buildLiveBytesSql(): string {
  return `SELECT
    (SELECT sum(data_compressed_bytes) FROM system.parts WHERE database = 'ulp' AND active) +
    (SELECT sum(data_compressed_bytes) FROM system.projection_parts WHERE database = 'ulp' AND active) AS bytes`
}

/** Percentage of budget used, rounded. 0 if budget is 0 (avoids divide-by-zero). */
export function diskBudgetPct(usedBytes: number, budgetBytes: number): number {
  return budgetBytes > 0 ? Math.round((usedBytes / budgetBytes) * 100) : 0
}
```

- [ ] **Step 4: Run the test and confirm GREEN**

```bash
npx vitest run __tests__/disk-budget.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Update the failing test for the route (RED)**

Modify `__tests__/ingest-health-route.test.ts` — add a 4th mocked result to both existing tests, and new assertions:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ role: 'admin' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn() }))
vi.mock('@/lib/ingest-metrics', () => ({
  getIngestMetrics: vi.fn().mockReturnValue({
    filename: 'x.txt', batchSize: 100000, parserRowsPerSec: 2_000_000,
    insertRowsPerSec: 500_000, lastBatchInsertMs: 200, imported: 100000,
    tierDropped: 5, bottleneck: 'insert', updatedAt: Date.now(),
  }),
}))

import { executeQuery } from '@/lib/clickhouse'
import { GET } from '@/app/api/monitoring/ingest-health/route'

const mockEQ = executeQuery as ReturnType<typeof vi.fn>
beforeEach(() => {
  mockEQ.mockReset()
  mockEQ.mockResolvedValue([])
})

describe('GET /api/monitoring/ingest-health', () => {
  it('returns the store snapshot + clickhouse parts/merges/memory + disk budget', async () => {
    mockEQ
      .mockResolvedValueOnce([{ c: 42 }])                          // parts
      .mockResolvedValueOnce([{ c: 3 }])                           // merges
      .mockResolvedValueOnce([{ v: 8_000_000_000 }])                // memory
      .mockResolvedValueOnce([{ bytes: 275 * 1024 ** 3 }])          // disk budget
    const res = await GET({} as any)
    const json = await res.json()
    expect(json.app.bottleneck).toBe('insert')
    expect(json.clickhouse.activeParts).toBe(42)
    expect(json.clickhouse.partsThreshold).toBe(1000)
    expect(json.clickhouse.activeMerges).toBe(3)
    expect(json.clickhouse.memoryBytes).toBe(8_000_000_000)
    expect(json.diskBudget.usedBytes).toBe(275 * 1024 ** 3)
    expect(json.diskBudget.budgetBytes).toBe(550 * 1024 ** 3)
    expect(json.diskBudget.pct).toBe(50)
  })

  it('degrades to zeros + note when system tables are unavailable', async () => {
    mockEQ.mockRejectedValue(new Error('UNKNOWN_TABLE'))
    const res = await GET({} as any)
    const json = await res.json()
    expect(json.clickhouse.activeParts).toBe(0)
    expect(json.clickhouse.note).toBeTruthy()
    expect(json.diskBudget.usedBytes).toBe(0)
    expect(json.diskBudget.note).toBeTruthy()
    expect(json.app.filename).toBe('x.txt')
  })
})
```

- [ ] **Step 6: Run the test and confirm RED**

```bash
npx vitest run __tests__/ingest-health-route.test.ts
```

Expected: FAIL — `json.diskBudget` is `undefined` (route doesn't produce it yet).

- [ ] **Step 7: Update `app/api/monitoring/ingest-health/route.ts`**

Add the import and extend the query batch and response:

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { executeQuery } from '@/lib/clickhouse'
import { getIngestMetrics } from '@/lib/ingest-metrics'
import { diskBudgetBytes, buildLiveBytesSql, diskBudgetPct } from '@/lib/disk-budget'

export const dynamic = 'force-dynamic'

// ulp.credentials parts_to_throw_insert (docker/clickhouse/init/01-ulp-tables.sql)
const PARTS_THRESHOLD = 1000

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  let clickhouse: {
    activeParts: number; partsThreshold: number; activeMerges: number
    memoryBytes: number; note?: string
  } = { activeParts: 0, partsThreshold: PARTS_THRESHOLD, activeMerges: 0, memoryBytes: 0 }

  let diskBudget: { usedBytes: number; budgetBytes: number; pct: number; note?: string } =
    { usedBytes: 0, budgetBytes: diskBudgetBytes(), pct: 0 }

  try {
    const [parts, merges, mem, disk] = [
      await executeQuery(
        `SELECT count() AS c FROM system.parts
         WHERE database = 'ulp' AND table = 'credentials' AND active
         SETTINGS max_execution_time = 15, use_query_cache = 0`,
      ) as Array<{ c: number | string }>,
      await executeQuery(
        `SELECT count() AS c FROM system.merges
         WHERE database = 'ulp'
         SETTINGS max_execution_time = 15, use_query_cache = 0`,
      ) as Array<{ c: number | string }>,
      await executeQuery(
        `SELECT value AS v FROM system.metrics
         WHERE metric = 'MemoryTracking'
         SETTINGS max_execution_time = 15, use_query_cache = 0`,
      ) as Array<{ v: number | string }>,
      await executeQuery(buildLiveBytesSql()) as Array<{ bytes: number | string | null }>,
    ]
    clickhouse = {
      activeParts:    Number(parts[0]?.c ?? 0),
      partsThreshold: PARTS_THRESHOLD,
      activeMerges:   Number(merges[0]?.c ?? 0),
      memoryBytes:    Number(mem[0]?.v ?? 0),
    }
    const usedBytes = Number(disk[0]?.bytes ?? 0)
    diskBudget = { usedBytes, budgetBytes: diskBudgetBytes(), pct: diskBudgetPct(usedBytes, diskBudgetBytes()) }
  } catch (error) {
    const msg = String(error)
    const note = msg.includes('UNKNOWN_TABLE')
      ? 'ClickHouse system tables unavailable'
      : 'failed to read ClickHouse metrics'
    clickhouse.note = note
    diskBudget.note = note
  }

  return NextResponse.json({ app: getIngestMetrics(), clickhouse, diskBudget })
}
```

- [ ] **Step 8: Run the test and confirm GREEN**

```bash
npx vitest run __tests__/ingest-health-route.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 9: Extend `components/ingest-health-panel.tsx`**

Add `HardDrive` to the lucide-react import, add `diskBudget` to the `IngestHealth` interface, and add a new indicator alongside the existing parts/merges/memory row:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity, Database, GitMerge, Gauge, HardDrive } from "lucide-react"

interface IngestHealth {
  app: {
    filename: string | null
    batchSize: number
    parserRowsPerSec: number
    insertRowsPerSec: number
    lastBatchInsertMs: number
    imported: number
    tierDropped: number
    bottleneck: "parse" | "insert" | null
    updatedAt: number
  }
  clickhouse: {
    activeParts: number
    partsThreshold: number
    activeMerges: number
    memoryBytes: number
    note?: string
  }
  diskBudget: {
    usedBytes: number
    budgetBytes: number
    pct: number
    note?: string
  }
}

const fmtRate = (n: number) =>
  n >= 1e8 ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M/s` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K/s` : `${n}/s`
const fmtRows = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n)
const fmtGB = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`

export function IngestHealthPanel() {
  const [data, setData] = useState<IngestHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch("/api/monitoring/ingest-health", { credentials: "include", cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as IngestHealth
        if (!cancelled) setData(json)
      } catch {
        /* transient — keep last value */
      }
    }
    poll()
    const id = setInterval(poll, 2_500)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!data) return null
  const { app, clickhouse, diskBudget } = data
  const active = app.filename !== null && Date.now() - app.updatedAt < 5_000
  const partsPct = Math.min(100, Math.round((clickhouse.activeParts / clickhouse.partsThreshold) * 100))

  return (
    <Card className="mt-6">
      <CardHeader className="py-3">
        <div className="flex items-center gap-2">
          <Activity className={`h-4 w-4 ${active ? "text-green-500 animate-pulse" : "text-muted-foreground"}`} />
          <CardTitle className="text-base">Ingest Health</CardTitle>
          {active && app.bottleneck && (
            <Badge
              variant="outline"
              className={app.bottleneck === "insert" ? "text-amber-600 border-amber-500/40" : "text-blue-600 border-blue-500/40"}
            >
              {app.bottleneck === "insert" ? "insert-bound" : "parse-bound"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 pb-4 space-y-3 text-sm">
        <div className="flex gap-6 flex-wrap">
          <div>
            <p className="text-xs text-muted-foreground">Parser</p>
            <p className={`font-semibold tabular-nums ${active && app.bottleneck === "parse" ? "text-blue-600" : ""}`}>
              {active ? fmtRate(app.parserRowsPerSec) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Insert</p>
            <p className={`font-semibold tabular-nums ${active && app.bottleneck === "insert" ? "text-amber-600" : ""}`}>
              {active ? fmtRate(app.insertRowsPerSec) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Last batch insert</p>
            <p className="font-semibold tabular-nums">{active ? `${app.lastBatchInsertMs}ms` : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Imported / T3-dropped</p>
            <p className="font-semibold tabular-nums">{fmtRows(app.imported)} / {fmtRows(app.tierDropped)}</p>
          </div>
        </div>
        {app.filename && (
          <p className="text-xs font-mono text-muted-foreground truncate" title={app.filename}>{app.filename}</p>
        )}
        <div className="flex gap-6 flex-wrap border-t pt-3">
          <div className="flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            <span className={partsPct >= 70 ? "text-red-600 font-medium" : ""}>
              {clickhouse.activeParts} / {clickhouse.partsThreshold} parts
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <GitMerge className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{clickhouse.activeMerges} merges</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{fmtGB(clickhouse.memoryBytes)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
            <span className={diskBudget.pct >= 70 ? "text-red-600 font-medium" : ""}>
              {fmtGB(diskBudget.usedBytes)} / {fmtGB(diskBudget.budgetBytes)} ({diskBudget.pct}%)
            </span>
          </div>
          {clickhouse.note && <span className="text-xs text-muted-foreground">({clickhouse.note})</span>}
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 10: Typecheck and lint**

```bash
npx tsc --noEmit --tsBuildInfoFile /tmp/tsc-scale-plan.tsbuildinfo
npm run lint
```

Expected: both clean.

- [ ] **Step 11: Commit**

```bash
git add lib/disk-budget.ts __tests__/disk-budget.test.ts \
  app/api/monitoring/ingest-health/route.ts components/ingest-health-panel.tsx \
  __tests__/ingest-health-route.test.ts
git commit -m "feat(scale): surface live-table disk budget on the Ingest Health panel"
```

---

### Task 5: Full Verification and Rollout

**Files:** verify only; no expected file changes.

**Interfaces:** verifies the complete branch before deployment.

- [ ] **Step 1: Run the full automated suite**

```bash
npm test
npx tsc --noEmit --tsBuildInfoFile /tmp/tsc-scale-plan.tsbuildinfo
npm run lint
```

Expected: every test passes (existing suite plus the new `projection-scope`, `projection-scope-cron`, and `disk-budget` files; `ingest-health-route` keeps updated assertions); typecheck and lint exit zero. If `import-pipeline`, `upload-processor`, or `upload-skip-imported` fail with `SQLITE_READONLY`, that is a pre-existing environment issue unrelated to this plan (same root-owned-file pattern as `tsconfig.tsbuildinfo` above) — confirm it by running `git stash` and re-running `npm test`: if the same tests fail identically with your changes removed, it's pre-existing, not a regression from this plan.

- [ ] **Step 2: Review the branch**

```bash
git status --short --branch
git log --oneline --all -- docs/superpowers/plans/2026-07-03-scale-tiered-archive.md | tail -1
git diff --stat HEAD
```

Expected: clean worktree; only this plan's task commits touching `lib/projection-scope.ts`, `lib/projection-scope-cron.ts`, `lib/disk-budget.ts`, `scripts/archive-old-partitions.sh`, `scripts/restore-archive.sh`, `instrumentation.ts`, `app/api/monitoring/ingest-health/route.ts`, `components/ingest-health-panel.tsx`, their test files, and the design spec's throughput note.

- [ ] **Step 3: Operator pre-flight — choose real values before enabling anything destructive**

This plan ships `PROJECTION_SCOPE_CRON_HOURS`/`PROJECTION_SCOPE_WINDOW_MONTHS` active by default once deployed (CLEAR PROJECTION is non-destructive of unique data, per Task 2's design). It does **not** enable any automatic archival — `scripts/archive-old-partitions.sh` only ever runs when a human invokes it with `APPLY=1`, on whatever schedule (cron, systemd timer, or manual) the operator sets up on the host, separate from this app's own process. Before setting up that host-level schedule:

- Confirm `ARCHIVE_AGE_MONTHS` (default 3) and `ARCHIVE_DIR` (default `./archive`, on the same 784GB disk — factor its growth into the disk-budget math) match what you actually want.
- Watch the Ingest Health panel's new disk-budget indicator for at least a few days of real ingestion before trusting it under load.

This step needs a human decision — it cannot be completed from this plan alone.

- [ ] **Step 4: Deploy**

```bash
cd ~/ulp-suite
git pull
docker compose up -d --build app
docker compose ps
docker compose logs app --tail=50
```

Expected logs include both new cron start messages: `[projection-scope] cron started — first tick in ...` alongside the existing `[content-dedup] cron started ...` line.

- [ ] **Step 5: Stop before pushing**

Do not push automatically. Confirm with the user first, per the standing project push policy. Once approved:

```bash
git push origin main
```
