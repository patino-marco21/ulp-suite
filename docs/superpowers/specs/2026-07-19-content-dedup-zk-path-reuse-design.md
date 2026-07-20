# Content-Dedup: Unique ZK Path Per Rewrite+Swap Cycle

## Problem

Live verification of the cutoff/stats bucketing fix (`2026-07-19-content-dedup-cutoff-stats-bucketing-design.md`) got further than any attempt tonight — the cutoff step completed cleanly across all 32 buckets, confirming that fix holds at full production scale — but then failed at step 4 (`CREATE TABLE` for `AUTO_DEDUP_TABLE`) with:

```
Code: 253. DB::Exception: Replica /clickhouse/tables/01/ulp/credentials_cdedup_auto/replicas/replica-1 already exists. (REPLICA_ALREADY_EXISTS)
```

This is a different, unrelated bug from anything fixed tonight — it's a structural issue in the rewrite+swap mechanism's ZooKeeper path handling, latent since this mechanism's first successful run and never previously exposed because no second cycle had ever been attempted until tonight.

## Root Cause

`rewriteCreateTableDdl()` always rewrites a cloned table's ZK path to the same fixed string, derived only from the target table's name (`/ulp/credentials_cdedup_auto` for `AUTO_DEDUP_TABLE`, unconditionally). `RENAME TABLE` (used by `buildRenameSwapSql()`) is metadata-only and never moves a table's underlying ZK registration — a table keeps the ZK path it was *created* with, regardless of what name it's later renamed to or from.

Confirmed live tonight via direct inspection (`system.replicas`, `system.zookeeper`, `system.query_log`):

- The live `ulp.credentials` table's actual `zookeeper_path` (per `system.replicas`) is `/clickhouse/tables/01/ulp/credentials_cdedup_auto` — **not** `/clickhouse/tables/01/ulp/credentials`.
- ZK znodes under that path (`pinned_part_uuids`, `metadata`, `columns`, etc.) show `ctime` of `2026-07-08 11:52:02` — matching the date of this session's earlier populate-scale rollout work.
- `ulp.credentials_predup_auto` (found to already exist at the start of tonight's Task 5 attempt, 466,889,579 rows) matches the row count independently recorded in `2026-07-08-content-dedup-bucketed-populate-design.md` ("ulp.credentials itself was independently confirmed untouched (466,889,579 rows)").
- The original `/clickhouse/tables/01/ulp/credentials` ZK path is confirmed empty (no children) as of tonight.

Together, this confirms: a rewrite+swap cycle **actually completed successfully** at some point around 2026-07-08, unnoticed at the time. That swap left the live `ulp.credentials` table physically registered at the ZK path originally built for `credentials_cdedup_auto`, and archived the pre-swap original under `credentials_predup_auto` (466.9M rows at that time) — exactly matching this file's documented `ROLLBACK` behavior, just never cleared because no subsequent cycle ever reached step 2 (which clears the *previous* run's archive) until tonight.

**The bug:** because `AUTO_DEDUP_TABLE`'s ZK path is a fixed string, every cycle after that first successful one tries to `CREATE TABLE` at a path now permanently owned by whatever currently holds the name `ulp.credentials`. This is not a one-time accident — it recurs on every future cycle, forever, since the live table can never simultaneously vacate that path without another full cycle completing, which this same collision prevents.

**Confirmed safe:** the live `ulp.credentials` table was verified untouched (562,400,008 rows, unchanged) throughout. One real, intentional, and irreversible side effect did occur: step 2 correctly `SYNC`-dropped the stale `ulp.credentials_predup_auto` (the archived 07-08 original) as its designed behavior — starting a fresh cycle by clearing the *previous* run's rollback safety net, per the file's own `ROLLBACK` comment. This was not a mistake; it is that step's stated purpose, just triggered for the first time since 07-08.

A first remediation attempt (`SYSTEM DROP REPLICA 'replica-1' FROM ZKPATH '...'`, intended to clear what looked like an orphaned registration) was correctly refused by ClickHouse itself: `There is a local table ulp.credentials ..., which has the same table path in ZooKeeper.` This was a near-miss — that path is not orphaned, it is the live table's actual registration, and the command would have deregistered production's real replica had ClickHouse not blocked it. No further remediation was attempted before this investigation.

## Investigation

All disposable-table testing below never touched `ulp.credentials` or any of its real tables.

| Test | Result |
|---|---|
| Live `system.replicas` query for `ulp.credentials` | `zookeeper_path = /clickhouse/tables/01/ulp/credentials_cdedup_auto` — confirms the live table occupies the build-table's nominal path |
| `system.zookeeper` children of `/clickhouse/tables/01/ulp/credentials_cdedup_auto` | Full replica structure present, `ctime` 2026-07-08, `mutations`/`log` `mtime` as recent as today — an actively-used, non-orphaned registration |
| `system.zookeeper` children of `/clickhouse/tables/01/ulp` | `sources`, `domains`, `credentials_cdedup_auto` only — no plain `credentials` entry; that path is fully free |
| Disposable repro: create table at fixed path, rename it "live", attempt to recreate at the same fixed path | **Fails** — `Code: 253, REPLICA_ALREADY_EXISTS`, byte-for-byte matching the production error |
| Disposable repro: same scenario, second build uses a unique-suffixed path instead | **Succeeds** |
| Disposable repro: `DROP TABLE` by name, regardless of the underlying table's ZK path suffix | **Succeeds** — confirms existing cleanup logic (steps 2/3, both name-based) needs no changes |
| Disposable repro: simulate the swap completing, then a *third* cycle with a third unique suffix | **Succeeds** — confirms the fix holds across arbitrarily many cycles, not just a one-time patch |

## Approaches Considered

**A — Detect which of two known ZK path "slots" is currently free, alternate between them.** Since exactly two tables are ever in play (live + being-built), and `RENAME` only swaps names, the live table's path alternates between exactly two fixed strings across successive *successful* cycles. Rejected: requires querying the live table's current path at the start of each cycle and branching on it, and the "exactly two slots" assumption is fragile — a crashed cycle, manual intervention, or any state this session hasn't anticipated could leave a third table in play, and this approach has no way to reason about that case. Harder to verify exhaustively than B.

**B — Unique ZK path suffix per cycle (chosen).** Each cycle's build table gets a ZK path no prior or future cycle can ever reuse (validated live tonight, disposable tables, three simulated cycles). Doesn't require detecting or reasoning about prior state at all — it sidesteps the reuse problem entirely rather than managing it. Existing cleanup (`DROP TABLE IF EXISTS ${AUTO_PREDUP_TABLE}/${AUTO_DEDUP_TABLE} SYNC`) and the swap itself (`RENAME TABLE`) both operate purely on SQL table names, confirmed live to work identically regardless of the underlying ZK path's suffix — so neither needs to change.

## Decision

Ship B.

## Architecture

`rewriteCreateTableDdl(showCreateSql, targetTable)` gains a third parameter, `uniqueSuffix: string`, appended to the rewritten ZK path:

```ts
export function rewriteCreateTableDdl(showCreateSql: string, targetTable: string, uniqueSuffix: string): string {
  const targetShortName = targetTable.split('.')[1]
  const lines = showCreateSql.split('\n')
  lines[0] = lines[0].replace('ulp.credentials', targetTable)
  return lines.join('\n').replace("/ulp/credentials'", `/ulp/${targetShortName}_${uniqueSuffix}'`)
}
```

Kept pure (no internal clock access) so the existing exact-match unit tests keep working with a fixed, caller-supplied suffix — matching this file's established `rewriteCreateTableDdl` testing style.

`runContentDedupTick()`'s step 4 passes `String(Date.now())`:

```ts
await client.exec({ query: rewriteCreateTableDdl(showCreateSql, AUTO_DEDUP_TABLE, String(Date.now())) })
```

**Why `Date.now()` (Node clock) here, despite this file's general caution against Node-clock values:** the existing `CATCH-UP` comment warns against comparing a Node-clock timestamp *against* a ClickHouse-side `imported_at` value, where skew could cause a real correctness bug (rows silently missed or duplicated). This use is different in kind: the value is never compared to anything, numerically or otherwise — it only needs to be *different* from any suffix a prior or future cycle could produce. Millisecond resolution is far finer than this mechanism's cadence (default weekly, minimum practical interval far above one millisecond), so collision is not a realistic concern, and clock skew (which affects *comparisons* between two clocks) has no bearing on a value that's never compared.

**No other function changes.** `buildRenameSwapSql()`, the `DROP TABLE IF EXISTS ... SYNC` calls (steps 2/3), and `buildCatchupInsertSql()` all reference `AUTO_DEDUP_TABLE`/`AUTO_PREDUP_TABLE` by their fixed SQL table names — confirmed live tonight (disposable repro) that none of this depends on or needs to know the underlying ZK path.

## Interfaces Changed

`lib/content-dedup.ts`:

- `rewriteCreateTableDdl(showCreateSql: string, targetTable: string, uniqueSuffix: string): string` — signature gains the third parameter (breaking change to this exported function's signature; both call sites, in `runContentDedupTick` and the test file, must be updated).
- `runContentDedupTick()`'s step 4 passes `String(Date.now())`.

Unchanged: `AUTO_DEDUP_TABLE`, `AUTO_PREDUP_TABLE`, `buildRenameSwapSql()`, `buildCatchupInsertSql()`, steps 2/3's cleanup, the file's other bucketed stats/cutoff/verify functions from tonight's earlier fix.

A new header-comment paragraph (`ZK PATH REUSE`) documents this, matching the file's established practice of recording root causes and confirmed-live evidence inline.

## Rollout Plan

1. Implement the signature change, update both call sites, add/update unit tests.
2. **Disposable-table verification is already complete** — the three-cycle repro above (Investigation table) *is* this step; no further disposable testing is needed before a live retry, since the mechanism under test (ZK path uniqueness, table-name-based cleanup) has no scale dependency the way the memory-bucketing fixes did.
3. Retry Task 5 (live full-tick verification) against real `ulp.credentials` — this is both the live verification for *this* fix and the original, still-incomplete verification for the cutoff/stats/verify bucketing fix from earlier tonight. Confirm: step 4 succeeds without `REPLICA_ALREADY_EXISTS`, the full populate/verify/swap sequence completes, and independent post-state checks (per the existing plan's Task 5) pass.

## Testing

1. **Unit tests**: update all four existing `rewriteCreateTableDdl` tests to pass a fixed third argument and assert the suffixed ZK path. Add a new test asserting two different `uniqueSuffix` values produce two different ZK paths for the same `targetTable` — this is the specific property that fixes tonight's bug, and should be encoded as a regression test the same way this session has encoded every other load-bearing invariant discovered tonight.
2. **Disposable verification**: complete (see Rollout Plan step 2).
3. **Live verification**: Task 5 retry, as above.

## Error Handling

No new error paths. `rewriteCreateTableDdl` remains a pure function with no failure modes of its own. A `CREATE TABLE` failure at step 4 (for any reason, including a suffix collision in the astronomically unlikely case of one) is already caught by `runContentDedupTick`'s existing outer `try`/`catch` — logged, `{ applied: false }`, original table untouched, unchanged from tonight's actual behavior when this bug was hit for the first time.
