# Live Ingest Health — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Scope:** Add the one missing piece of "item 4" — a live ingestion-bottleneck view:
parser-rows/s vs insert-rows/s (the parse-bound/insert-bound answer) plus
ClickHouse merge-pressure signals (active parts, active merges, memory).

---

## 1. Goal

Surface, live during real imports, the metrics that answer *"is anything the
bottleneck right now, and is it Node parsing or ClickHouse?"* — a comparison the
codebase does not surface anywhere today.

## 2. Context — most of "item 4" already exists

The proposal's "live bottleneck metrics in the Inbox Monitor" is ~80% shipped:

- Queue depth, current file, recent jobs, durations, retry → `/upload`
  `QueueStatusPanel` + `/api/upload/queue-status`; `/inbox` page +
  `/api/inbox/status`.
- Per-import rows imported/skipped, **T3 drop count**, %, elapsed → the SSE job
  store (`lib/upload-jobs.ts`), live during an import.
- Insert throughput + flush ms, mutations, slow queries → existing
  `/api/monitoring/{async-inserts,mutations,slow-queries}` routes.

**The genuine gap** is the live *bottleneck* signal: active ClickHouse parts +
merges + memory (the "too many parts" / merge-pressure indicator), and a live
**parser-rows/s vs insert-rows/s** comparison. That is what this spec adds.

## 3. Scope

**In scope**
- `lib/ingest-metrics.ts` — a single-process module store of the current import's
  rolling rates (same pattern as `getCurrentJob`).
- An `onBatchMetrics` hook in `streamCredentialsToTable` + wiring in
  `processTextStream` (covers HTTP uploads *and* the inbox watcher).
- `GET /api/monitoring/ingest-health` — the store snapshot + live `system.parts` /
  `system.merges` / `system.metrics`.
- `IngestHealthPanel` on `/monitoring`, polling every ~2–3 s.

**Out of scope**
- Persisting rate history (this is a live gauge, not a time series).
- Touching the existing queue/inbox/SSE observability (already built).
- A `/inbox` copy of the panel (could be added later; the panel lives on
  `/monitoring`).
- Per-batch metrics for the benchmark path (the benchmark already measures
  parse/insert via its own `timings`).

## 4. Architecture (Approach A)

Single Next.js process, so a module-level store updated by the import loop and
read by a monitoring route works — identical to how `getCurrentJob`/`setCurrentJob`
is read by `/api/upload/queue-status` today. The benchmark calls
`streamCredentialsToTable` directly with no `onBatchMetrics`, so benchmark runs
never write the store.

## 5. Components

### 5.1 `lib/ingest-metrics.ts`

```ts
export interface IngestMetrics {
  filename: string | null      // current file, or null when idle
  batchSize: number            // rows in the last batch
  parserRowsPerSec: number     // EMA-smoothed
  insertRowsPerSec: number     // EMA-smoothed
  lastBatchInsertMs: number
  imported: number             // cumulative this file
  tierDropped: number          // cumulative this file
  bottleneck: 'parse' | 'insert' | null  // the lower rate while active
  updatedAt: number            // Date.now(); a reader treats >5s old as idle
}

export function startIngest(filename: string): void
export function recordBatch(m: {
  rows: number; parseMs: number; insertMs: number; tierDropped: number
}): void
export function finishIngest(): void
export function getIngestMetrics(): IngestMetrics
```

- `recordBatch` computes the instantaneous per-batch rate as
  `rows / max(ms, 1) * 1000`, capped at a sane maximum (e.g. 1e9) so a near-zero
  `ms` cannot produce `Infinity`, then EMA-smooths (`α = 0.3`):
  `rate = α·instantaneous + (1−α)·prev`. It accumulates `imported`/`tierDropped`,
  sets `batchSize`/`lastBatchInsertMs`, and `updatedAt = Date.now()`.
- `bottleneck` = whichever of the two smoothed rates is lower (the limiter).
- **Pipelining nuance:** with `IMPORT_PIPELINE` on, `parseMs ≈ 0` (the next batch
  was prefetched during the insert), so `parserRowsPerSec` is very high and
  `insertRowsPerSec` is the real throughput → `bottleneck` reads `'insert'`,
  which is correct. The store records the raw (capped) parser rate; the panel
  renders it as "not limiting" above a display cap rather than an absurd number.
- `startIngest` zeroes all fields and sets `filename`. `finishIngest` sets
  `filename = null` (idle). `getIngestMetrics` returns a snapshot copy.

### 5.2 Import core hook (`streamCredentialsToTable`)

`StreamToTableOptions` gains:

```ts
  /** Per-batch metrics callback (live ingest panel). Not passed by the benchmark. */
  onBatchMetrics?: (m: { rows: number; parseMs: number; insertMs: number; tierDropped: number }) => void
```

The loop already times `parseMs` (awaiting the parser) and `insertMs` (awaiting
the insert) — those two `performance.now()` measurements become unconditional
(negligible cost). After each insert it calls
`options.onBatchMetrics?.({ rows: creds.length, parseMs, insertMs, tierDropped: batch.breakdown.tier_dropped })`.
The per-batch T3-drop count is the **parser's** `batch.breakdown.tier_dropped`
(the hard-tier early-drop added in the parser-T3 work) — not the post-batch soft
tier filter (`StreamToTableResult.tierDropped`), which is separate and ~0 under
the default `HARD_DROP_TIERS=T3` config. The benchmark's `timings` accumulator is
unchanged.

### 5.3 Wiring (`processTextStream`)

`processTextStream` (the shared path for HTTP uploads **and** the inbox watcher):
calls `startIngest(filename)` before the core, passes
`onBatchMetrics: m => recordBatch(m)`, and `finishIngest()` in a `finally`. The
benchmark calls `streamCredentialsToTable` directly, so it stays untouched.

### 5.4 Route — `GET /api/monitoring/ingest-health`

Admin-auth, `dynamic = 'force-dynamic'`, same structure as
`app/api/monitoring/async-inserts/route.ts`:

```ts
{
  app: getIngestMetrics(),
  clickhouse: {
    activeParts:    number,   // SELECT count() FROM system.parts
                              //   WHERE database='ulp' AND table='credentials' AND active
    partsThreshold: 1000,     // ulp.credentials parts_to_throw_insert (static, from schema)
    activeMerges:   number,   // SELECT count() FROM system.merges WHERE database='ulp'
    memoryBytes:    number,   // SELECT value FROM system.metrics WHERE metric='MemoryTracking'
  }
}
```

Queries use `max_execution_time: 15`, `use_query_cache: 0`. As with the
async-inserts route, empty/unknown system tables (fresh install, restricted user)
degrade to zeros + a `note`, never a 500.

### 5.5 Panel — `IngestHealthPanel` on `/upload`

Polls `/api/monitoring/ingest-health` every 2–3 s (the `QueueStatusPanel` polling
pattern: immediate call + `setInterval` + `cancelled` cleanup). Rendered as a
`Card` on the `/upload` page **next to the existing `QueueStatusPanel`** — the
established home for live processing panels (the `/monitoring` page is the
unrelated domain-monitor/webhook UI). Vitest runs in the `node` environment, so —
like `QueueStatusPanel` — the panel has no render test; its display logic is
trivial and the data it shows is covered by the store and route tests. Shows:

- **App:** current file (or *Idle* when `app.filename` is null / `updatedAt` stale);
  **parser rows/s vs insert rows/s** side by side, the lower highlighted with an
  **"insert-bound" / "parse-bound"** verdict badge; last-batch insert ms; batch
  size; cumulative imported / T3-dropped.
- **ClickHouse:** **active parts as `N / 1000`**, color-graded as it approaches the
  throw threshold; active merges; memory (GB).

## 6. Data flow

```
import (HTTP or inbox) → processTextStream
   → startIngest(filename)
   → streamCredentialsToTable(onBatchMetrics: recordBatch)
        per batch: recordBatch({rows, parseMs, insertMs, tierDropped})  → ingest-metrics store
   → finishIngest()                                                     (idle)

/monitoring IngestHealthPanel ──poll 2–3s──▶ GET /api/monitoring/ingest-health
   → getIngestMetrics()  +  system.parts / system.merges / system.metrics
```

## 7. Error handling

- ClickHouse system-table queries are wrapped like the async-inserts route:
  on `UNKNOWN_TABLE` / empty results, return zeros + `note`, not a 500.
- The store is pure in-memory; a reader on a fresh process gets the idle default
  (`filename: null`, zeros).
- Metrics recording must never throw into the import path — `recordBatch` is
  trivial arithmetic, but the call site treats it as best-effort.

## 8. Testing (TDD)

| Test (file) | Asserts |
|---|---|
| `ingest-metrics` | instantaneous-rate math + cap; EMA smoothing; `bottleneck` = lower rate; `parseMs≈0` → parser non-limiting (insert is bottleneck); `startIngest` zeroes; `finishIngest` → `filename:null` |
| Import core (`import-pipeline`) | `onBatchMetrics` fires once per batch with `{rows,parseMs,insertMs,tierDropped}`; the no-callback path (benchmark) is unaffected |
| `processTextStream` (`upload-processor`) | calls `startIngest` / `recordBatch` / `finishIngest` (spy on `@/lib/ingest-metrics`) |
| Route (`ingest-health`) | mocks `executeQuery` + `getIngestMetrics`; correct shape; empty system tables → zeros + note, no 500 |
| Panel | renders rates + verdict + `parts/threshold` from mock data (light smoke test) |

## 9. Success criteria

- During imports the panel shows parser-rows/s vs insert-rows/s with a
  bottleneck verdict, last-batch ms, and active parts (vs 1000) / merges / memory,
  refreshing every ~2–3 s.
- Idle when no import is running.
- The benchmark is unaffected (no `onBatchMetrics` → store never written).
- All existing tests pass; typecheck / lint / build clean.

## 10. Open questions / planning notes

- Placement confirmed by reading the page: `/monitoring` is the
  domain-monitor/webhook UI, not a system-health dashboard. Mount
  `IngestHealthPanel` on `/upload` next to `QueueStatusPanel`, mirroring its
  polling + `Card` pattern.
- Confirm the memory metric: `system.metrics` `MemoryTracking` (server-tracked
  allocation) vs `system.asynchronous_metrics` `OSMemoryResident` (RSS). Default
  to `MemoryTracking`; switch if the monitoring page already standardizes on one.
- `partsThreshold` is shown as the static `1000` from the `ulp.credentials`
  schema (`parts_to_throw_insert`). If a dynamic value is wanted later, query
  `system.merge_tree_settings`, but the table override is the authoritative number
  and is fixed in the schema.
