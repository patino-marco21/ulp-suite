# ClickHouse disk-headroom guard — design

**Date:** 2026-09-28
**Status:** Implemented (merged 2026-09-28, commits 85ad9f7/d41dd49/7ebacae); growth projection revised 2026-09-29 to use target-table growth instead of free-space delta (c005ba0)

## Why

This week's dedup-backfill effort filled the host disk to 100% (937GB → 311MB free)
because a scratch table (`ulp.credential_dedup_partial`) grew to 323GB and nothing
in the stack checked its size against real headroom before or during the run. See
`docs/superpowers/specs/2026-09-24-credential-dedup-backfill-design.md` and the
scale audit (published Artifact, "ULP Suite Scale Audit") finding 10 for the full
incident. The audit's own recommendation: "A lightweight pre-flight + circuit-breaker
check for heavy ClickHouse operations — hard disk-headroom floor, checked before
starting and before every iteration, plus a scratch-growth projection after the
first unit of work." This spec is that check.

Scope decision (made 2026-09-28, alongside this design): rather than build this as
an unintegrated utility, it ships with its first real consumer —
`lib/content-dedup.ts`'s populate step — the mechanism this project just decided
to adopt as the long-term dedup path (see
[[project_dormant_content_dedup_cron]] in memory / the 2026-09-28 session). Building
another sophisticated-but-unwired tool would repeat exactly the failure mode finding
8 already found once this week.

## What's out of scope

- `scripts/backfill-credential-dedup.sh` — not wired in. Its approach is being
  retired now that content-dedup is the chosen mechanism; no point integrating a
  guard into code on its way out.
- The `email_domain` `PROJECTION` migration (finding 1) — not built yet. Whoever
  builds it should use this guard, but that's that migration's own work, not this
  spec's.
- content-dedup's stats pass (`buildContentKeyStatsSqlForBucket`) and verify pass
  (`buildVerifyDedupedTableSqlForBucket`) — both read-only, nothing they do can grow
  disk usage. Only the populate step (step 5 of `runContentDedupTick`, which
  `INSERT`s into `AUTO_DEDUP_TABLE`) can.
- A general disk-monitoring dashboard or alerting system. This is specifically a
  gate in front of heavy write operations, not observability infrastructure.
- Multi-disk ClickHouse deployments. `system.disks` can have multiple rows; this
  design assumes the single `name = 'default'` row this project's Docker Compose
  setup actually has (confirmed live 2026-09-28), and picks that row explicitly
  rather than trying to generalize. If this project ever adds a second disk, this
  needs revisiting.

## The module: `lib/clickhouse-disk-guard.ts`

Mirrors `lib/clickhouse-memory-guard.ts`'s shape (query ClickHouse's own system
tables — the `app` container has no direct filesystem access to the ClickHouse data
volume, so this is the only real vantage point) but is a stateful object rather than
memory-guard's stateless functions, because the growth projection needs to remember
readings across calls within one run.

```ts
export interface DiskHeadroom {
  freeBytes: number
  totalBytes: number
  ratio: number  // freeBytes / totalBytes
}

export interface DiskGuardOptions {
  minFreeBytes?: number   // default: DISK_GUARD_MIN_FREE_BYTES env, else 50 GiB
  minFreeRatio?: number   // default: DISK_GUARD_MIN_FREE_RATIO env, else 0.15
}

export interface IterationContext {
  index: number   // 0-based index of the iteration about to run
  total: number   // total planned iterations
}

export class DiskHeadroomError extends Error {
  readonly headroom: DiskHeadroom | null   // null only for reason: 'check-failed'
  readonly effectiveFloorBytes: number | null
  readonly reason: 'floor-breached' | 'projected-breach' | 'check-failed'
}

/** One live snapshot: queries system.disks fresh, every call. No caching. */
export function checkDiskHeadroom(signal: AbortSignal): Promise<DiskHeadroom>

export interface DiskGuard {
  /** Throws DiskHeadroomError if current headroom is already below the floor. */
  preflight(signal: AbortSignal): Promise<void>
  /** Call before each iteration of a multi-step write operation. */
  checkBeforeIteration(signal: AbortSignal, ctx: IterationContext): Promise<void>
}

export function createDiskGuard(opts?: DiskGuardOptions): DiskGuard
```

Both `preflight` and `checkBeforeIteration` call `checkDiskHeadroom` internally and
catch *any* error it throws (network blip, malformed response, wrong disk name —
anything), re-throwing as `DiskHeadroomError(reason: 'check-failed')` rather than
letting the original error propagate. This is what makes fail-closed (below)
actually uniform: content-dedup's integration code only ever needs to catch
`DiskHeadroomError` — never a raw ClickHouse-client error — to know "the guard
says stop," regardless of whether that's a genuine breach or an inability to check.

### Querying disk state

```sql
SELECT free_space, unreserved_space, total_space
FROM system.disks
WHERE name = 'default'
```

Use `unreserved_space`, not `free_space`, as the "true" free-bytes figure —
`unreserved_space` accounts for ClickHouse's own pending reservations, so it's the
more conservative of the two (as of 2026-09-28 they're numerically identical on
this container since nothing is currently reserved, but they can diverge, and
conservative is the right default for a safety gate). `total_space` is the raw
disk byte count as ClickHouse sees it — confirmed 2026-09-28 this is reported in
decimal bytes (1,005,867,986,944 ≈ 1.01TB), which is *not* the same number `df -h`
prints in binary GiB (937G) — the two are consistent once converted (1,005,867,986,944
÷ 1024³ ≈ 937 GiB), but this module must work entirely in raw bytes internally and
never cross-reference a `df`-style figure, to avoid a unit-mismatch bug.

### The floor: both absolute and percentage, whichever is stricter

```
effectiveFloorBytes = max(minFreeBytes, minFreeRatio × totalBytes)
trip if unreservedBytes < effectiveFloorBytes
```

Taking `max()` of the two floor-in-bytes values is what makes "whichever is
stricter" correct: a larger required-floor is the harder-to-satisfy (stricter) one.
Defaults (50 GiB, 0.15) chosen 2026-09-28 against this container's real numbers —
50 GiB absolute vs. ~140 GiB (15% of ~937 GiB) — meaning the *percentage* floor is
the one that actually gates today. Both configurable via `DISK_GUARD_MIN_FREE_BYTES`
and `DISK_GUARD_MIN_FREE_RATIO`, matching the `<NAME>_GUARD_*` env-var convention
`clickhouse-memory-guard.ts` already established (compare `MEMORY_GUARD_THRESHOLD_RATIO`).

### The growth projection

Audit's own language: "a scratch-growth projection after the first unit of work."
Implemented as a running average rather than trusting the very first sample alone
(hash-bucketed work should be roughly even-sized, but one anomalous first bucket
souldn't be allowed to either falsely trip or falsely clear the projection for
every later one):

```
On preflight(): record startFreeBytes = current unreserved_space.

On checkBeforeIteration(ctx):
  currentFree = current unreserved_space (fresh query, every call)
  effectiveFloorBytes = max(minFreeBytes, minFreeRatio × totalBytes)   -- recomputed
                                                                          each call;
                                                                          totalBytes
                                                                          could
                                                                          theoretically
                                                                          change
  if currentFree < effectiveFloorBytes:
    throw DiskHeadroomError(reason: 'floor-breached')

  if ctx.index > 0:                          -- at least one prior iteration completed
    consumedSoFar = max(0, startFreeBytes - currentFree)   -- clamp: don't let a
                                                               concurrent, unrelated
                                                               free-up read as
                                                               "negative growth"
    avgPerIteration = consumedSoFar / ctx.index
    remaining = ctx.total - ctx.index
    projectedFree = currentFree - (avgPerIteration × remaining)
    if projectedFree < effectiveFloorBytes:
      throw DiskHeadroomError(reason: 'projected-breach')

  -- no state to update beyond startFreeBytes, which is fixed at preflight() time;
  -- the average is always computed from the fixed start point, not a sliding window
```

Note the `ctx.index > 0` guard: on the very first call (`index === 0`, before any
iteration has run), there is no consumption data yet, so only the immediate hard-floor
check applies — the projection can only kick in from the second call onward. This is
an easy off-by-one to get wrong in implementation; the plan should include a test
that asserts no projection fires on `index === 0` even with a very low floor.

### Fail-closed, not fail-open — a deliberate deviation from `clickhouse-memory-guard.ts`

`clickhouse-memory-guard.ts`'s `waitForHeadroom` is explicitly fail-open: any error
checking pressure, or exceeding the wait budget, resolves rather than throwing,
documented as "a soft pacing layer, not a correctness dependency." This guard
should be the opposite: if `checkDiskHeadroom`'s query itself fails for any reason
(network blip, ClickHouse under load, wrong disk name), **treat it as a trip**,
not as "proceed anyway." Memory-guard's failure mode when wrong is one query getting
OOM-killed — annoying, and it has its own retry safety net. This guard's failure
mode when wrong is a repeat of this week's entire disk-exhaustion incident. The
stakes are different enough to justify breaking from the established pattern
rather than copying it uncritically.

## Integration into `lib/content-dedup.ts`

Wraps only step 5 (the populate loop) of `runContentDedupTick()`:

```ts
const guard = createDiskGuard()
await guard.preflight(signal)
console.warn(`[content-dedup] ${trigger}: building deduped table across ${bucketCount} buckets...`)
for (let bucket = 0; bucket < bucketCount; bucket++) {
  try {
    await guard.checkBeforeIteration(signal, { index: bucket, total: bucketCount })
  } catch (err) {
    if (err instanceof DiskHeadroomError) {
      // Reclaim space immediately rather than leaving the partial build for the
      // next tick's own step-2/3 cleanup (24h away) to find — the whole point of
      // this guard is not waiting that long once things are already tight.
      await client.exec({ query: `DROP TABLE IF EXISTS ${AUTO_DEDUP_TABLE} SYNC` })
    }
    throw err   // still propagates to runContentDedupTick's existing top-level catch
  }
  await client.exec({ query: buildPopulateDedupedTableSqlForBucket(bucket, bucketCount) })
}
```

The existing top-level `catch` in `runContentDedupTick` already logs and returns
`{ applied: false }` safely on any thrown error — a `DiskHeadroomError` needs no new
top-level handling, only the immediate scratch-table cleanup shown above, which is
specific to content-dedup's own table name and so belongs in `content-dedup.ts`,
not in the generic guard module.

## Testability

Following `content-dedup.ts`'s own established split (pure SQL-builder functions are
directly unit-tested; the orchestrating async function is not, per that file's own
comment: "exercised by Tasks 3-5 instead"), this module should separate:

- **Pure, directly unit-testable:** the `system.disks` query-building, the
  `effectiveFloorBytes` computation, and the projection math (given
  `startFreeBytes`, `currentFreeBytes`, `index`, `total`, `effectiveFloorBytes` →
  does it trip, and with which `reason`). These have no ClickHouse dependency and
  should cover: floor-only trip, projection trip, the `index === 0` no-projection
  case, the negative-consumption clamp, and the "whichever is stricter" `max()`
  logic at both a small-disk and a large-disk scale.
- **Not directly unit-tested, needs live verification instead:** `checkDiskHeadroom`
  itself (the actual ClickHouse query) and the full `DiskGuard` object's async
  behavior — verify against the real `ulpsuite_clickhouse` container as part of
  implementation, same as this design's own `system.disks` schema check was
  verified live today rather than assumed.

## Open items for the implementation plan

- Exact wording/format of `DiskHeadroomError`'s message (should include the actual
  numbers — current free, effective floor, which reason — since this is exactly
  the kind of error someone will be staring at during an incident and needs to be
  self-explanatory without re-deriving the math).
- Whether `preflight()` and `checkBeforeIteration()` should log anything on success
  (quiet-success matches this project's established norm elsewhere, but given
  today's whole `removeConsole` saga, any log this module does emit on its own
  "started/passed" path should use `console.warn`, not `console.log`, from the
  start — not something to retrofit later).
