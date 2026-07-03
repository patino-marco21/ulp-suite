# Scaling to Billions of Rows: Tuned Live Table + On-Disk Cold Archive

## Objective

Let the credential pipeline consolidate/aggregate tens to hundreds of billions of raw combolist lines over time, on the current single Ubuntu processing laptop (31GB RAM, 16 CPU, 784GB disk, no planned hardware upgrade), while keeping a bounded working set fully live, indexed, and fast to search (exact-match + full-text/substring) in ClickHouse.

## Confirmed Requirements

- No new hardware. This is a fixed constraint, not a target to optimize toward — designs that assume a second disk, more RAM, or a cluster are out of scope.
- "Tens/hundreds of billions of rows" refers to raw lines processed through import, not rows simultaneously live in ClickHouse — the existing filter/dedup pipeline (T3 hard-drop, noise filtering, exact + scheme/slash-insensitive dedup) already determines what survives into storage, and continues to.
- Search priorities: exact-match lookup and full-text/substring search must remain fast at scale. Aggregate/analytics queries (the removed stats/reuse MV tables) are explicitly not in scope for reintroduction.
- Data that ages out of the live table must not simply be deleted — it must remain recoverable, even if not instantly queryable.
- Every new destructive or semi-destructive mechanism follows this project's existing operator-script conventions: dry-run by default, explicit `APPLY=1` to act, pre/post verification, audit logging, no automatic `git push`.
- **Filter aggressiveness stays exactly as-is** (T3-only hard-drop; T2 is not additionally dropped) — confirmed, not just a default. The row-budget estimates below already reflect this, since they're measured from the live table's current (T3-dropped, T2-kept) density. Consequence worth naming: keeping T2 means more of each raw file survives into the live table than a stricter policy would allow, so the archival job (Design §2) carries more volume per raw line processed and needs to run more proactively to hold the disk budget than it would under a stricter filter.

## Current State / Constraints

Measured today (2026-07-03), on `ulp.credentials` at 16,851,259 rows:
- Base table (existing bloom-filter + set + minmax + ngram/text indexes, i.e. current exact + full-text search capability) — 533.50 MiB compressed, ≈33.2 bytes/row.
- `proj_imported_desc` projection (added this session, DDL v14) — an additional 1.04 GiB, ≈97 bytes/row all-in (≈3x the base table). Confirmed live and genuinely used via `force_optimize_projection=1` (not a cache-warming artifact) — see `scripts/verify-imported-desc-projection.sh`.
- Compression is already near-optimal for this workload: ZSTD(3) on string columns, Delta+ZSTD(1) on timestamp columns.

Reserving ~30% of the 784GB disk as headroom for merges, safety margin, and the archive directory itself (this document assumes a ~550GB live-table budget — flagged as an assumption below, not yet explicitly confirmed), extrapolating current density:

| Config | Bytes/row | Rows that fit in ~550GB |
|---|---|---|
| Full search, no recency projection | ~33 bytes | ~15 billion |
| Full search, recency projection everywhere | ~97 bytes | ~5 billion |

A 414-million-row `ALTER TABLE ... DELETE` previously hit ClickHouse's 20GB memory ceiling (`MEMORY_LIMIT_EXCEEDED`, see `docs/superpowers/specs/2026-06-21-low-memory-t3-purge-design.md`) — any new heavyweight, full-table mutation-style operation at multi-billion-row scale risks repeating that incident and must use the same bounded-memory `DELETE FROM ... SETTINGS lightweight_deletes_sync=2, max_threads=2` pattern, or `DROP PARTITION` (metadata-only, no row-by-row rewrite) wherever partition boundaries allow it.

**Measured ingest throughput (2026-07-03):** 43,880 rows/sec, insert-bound (insert 9.77s vs. parse 0.46s for a 100K-row batch; 449,861 of 500,000 requested rows survived filtering), via `scripts/benchmark-import.ts --rows 500000` run from a throwaway `node:24-bookworm-slim` container on `ulpsuite_network` (peak RSS 461MB, 5 parts, 0 merges). `scripts/benchmark-import.ts` needs the app container's ClickHouse env vars (internal Docker network hostname); the deployed `ulpsuite_app` image doesn't ship `scripts/` or `tsx`, so a throwaway container bind-mounting the repo onto the same network is the working approach — see the implementation plan's Task 1 for the exact command.

At this measured rate, 100 billion raw lines would take roughly 26 days of continuous processing; 500 billion would take roughly 4.3 months. This is a real, sustained-duration undertaking, not a short batch job — worth factoring into any operational planning around "consolidating hundreds of billions of lines."

## Design

### 1. Live table: scope the recency projection to recent partitions

New scheduled task (same shape as the existing `lib/dedup-cron.ts`): for each partition (`toYYYYMM(imported_at)`) older than a configurable window, run

```sql
ALTER TABLE ulp.credentials CLEAR PROJECTION proj_imported_desc IN PARTITION 'YYYYMM'
```

New inserts always land in the current month's partition (`imported_at DEFAULT now()`), so recent data automatically keeps the projection and stays fast to browse by newest; partitions that age out shed it and fall back to the table's native `(domain, email, imported_at)` sort for that data. Exact-match and full-text search are untouched either way — only "browse by newest" is time-boxed.

**Confirmed:** recency window defaults to 2 months.

### 2. Archival job (new)

Trigger: partitions past a configurable age threshold. **Confirmed:** age-based only, default 3 months — no tier-based triggering (e.g. archiving T3 sooner than T1/T2) for this pass.

Mechanics:
1. `SELECT * FROM ulp.credentials WHERE <partition predicate> FORMAT Native` piped through `zstd`, written to `archive/<partition>.native.zst` on the same disk. Native format is ClickHouse's own binary format — it round-trips back into a table later with no schema translation, and carries none of the live table's index/projection storage overhead, so it is substantially denser per row than the live table.
2. Verify: capture the row count the export step reports writing, then separately re-run `SELECT count() FROM ulp.credentials WHERE <partition predicate>` immediately before the drop and compare the two. This avoids needing to decompress/re-parse the archive file just to verify it.
3. `ALTER TABLE ulp.credentials DROP PARTITION 'YYYYMM'` — metadata-level, not a row-by-row mutation, so it doesn't carry the memory risk described above.
4. Log the action (partition, row count, archive file path/size, timestamp) to the existing audit/processing-log mechanism.

Safety, matching every existing destructive script in this project: dry-run by default (report which partitions would be archived and their sizes), `APPLY=1` required to actually export+drop, refuses to run if a previous archival run's mutation/export is still in flight.

### 3. Restore script (new)

Loads an archive file back into an isolated `ulp.archive_scratch_<timestamp>` table — never `ulp.credentials` directly — mirroring `scripts/benchmark-import.ts`'s `assertBenchTable`-style guard so a restore can never collide with or overwrite live production data. Not instant (this is the explicit trade-off for staying under the disk ceiling without new hardware), but nothing archived is ever unrecoverable.

### 4. Disk-budget monitoring (new)

Extend the existing `IngestHealthPanel`/diagnose-script family with a check comparing current live-table compressed bytes (`system.parts`) against the target budget, surfaced before ingestion, so the budget is a visible, monitored number rather than something discovered via a failed insert.

**Confirmed:** budget = 70% of 784GB (~550GB). This is the single number every other estimate in this document scales from.

## Error Handling and Data Safety

- No change to any existing safety gate (`CONTENT_DEDUP_APPLY`, `minExcessToApply`, dry-run defaults) — this design adds new gated mechanisms, it doesn't loosen existing ones.
- `DROP PARTITION` and `CLEAR PROJECTION IN PARTITION` are both metadata-level operations bounded by partition, not full-table mutations — chosen specifically to avoid repeating the 414M-row `MEMORY_LIMIT_EXCEEDED` incident.
- An archival run that fails verification (exported row count ≠ source row count) must not proceed to `DROP PARTITION` — the live partition is the source of truth until the archive is confirmed complete.
- Nothing is pushed to `origin/main` without explicit user confirmation, per standing project policy.

## Testing

- Archival trigger logic (age threshold → candidate partition list) and dry-run reporting: unit-testable in isolation, same pattern as `lib/content-dedup.ts`'s `dedupCronHours`/`minExcessToApply` config-function tests.
- Export/verify/drop sequence: no automated test against real ClickHouse (consistent with this project's existing convention for `scripts/*.sh` operator scripts) — verified via dry-run output review before any `APPLY=1` run, same as `scripts/dedup-credentials-content.sh`.
- Restore script: tested against a throwaway archive + `ulp.archive_scratch_*` table, never live data.

## Deployment and Operations

Sequencing recommendation: (1) get a real ingest-throughput benchmark working end-to-end, (2) ship the projection-scoping cron, (3) ship the archival job in dry-run/report-only mode first and watch its output for at least one full trigger cycle before enabling `APPLY=1`, (4) ship the restore script, (5) add the disk-budget panel. Each is independently useful and independently revertible — no reason to ship them as one big-bang change.

## Out of Scope

- Approach C (aggressive real-time dedup against existing content before insert) — a real follow-on once this design is proven, not part of this pass. YAGNI until B's ceiling is actually being approached in practice.
- Changing filter aggressiveness — resolved during brainstorming (see Confirmed Requirements): stays T3-only, not revisited here.
- Multi-disk ClickHouse storage policies (`TTL ... TO VOLUME`) — the textbook ClickHouse answer for hot/cold tiering, but requires a second physical volume this laptop doesn't have. Worth revisiting if that constraint ever changes.
- Reintroducing the removed stats/reuse materialized views.
- Any code change to the ingestion/parser pipeline itself beyond what's already shipped.
