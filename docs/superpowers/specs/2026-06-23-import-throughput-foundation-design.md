# Import Throughput Foundation — Design

**Date:** 2026-06-23
**Status:** Approved (design); pending implementation plan
**Scope:** Sub-project A of a larger import-performance effort. The remaining
sub-projects (B: tuning knobs, C: parser-time T3 drop, D: import observability)
get their own spec → plan → build cycles.

---

## 1. Goal

Make ULP file imports faster **without** increasing peak memory beyond a hard,
predictable bound, and build the measurement tool that lets every later tuning
decision be driven by data instead of guesswork.

Three deliverables:

1. **Parse/insert pipelining** — overlap parsing of the next batch with the
   ClickHouse insert of the current batch, capped at a single look-ahead batch.
2. **Configurable upload concurrency** — an `UPLOAD_CONCURRENCY` env knob,
   default `1` (unchanged behavior).
3. **Benchmark harness** — a standalone script that imports a fixed sample under
   different configurations and reports throughput, peak memory, and ClickHouse
   part/merge pressure against a throwaway table.

## 2. Context and why this is the safe subset

A 10-item import-performance proposal was assessed against the current code and
the ClickHouse docs. Two of its items — bigger batches (proposal item 1) and
async inserts (item 8) — would **partially revert** deliberate decisions made in
[`2026-06-21-pagination-import-resilience.md`](../plans/2026-06-21-pagination-import-resilience.md),
which moved imports from 500K→100K batches and from async→synchronous,
retryable, in-order inserts to survive ClickHouse restarts on multi-GB files
under a tight memory budget. fsync durability (item 9) was likewise enabled
deliberately after a June-2026 corruption incident.

This sub-project deliberately contains **only the items that do not touch those
decisions**: pipelining and concurrency are new, and the benchmark is what will
later let us evaluate the reversal-risk items (batch size, async, fsync,
backpressure) with evidence.

**Operating constraint (confirmed):** the Node.js app process runs under a
**tight memory budget**. Therefore:

- Pipelining is capped at **one** look-ahead batch (≤ 2 batches resident).
- Concurrency **default stays 1**; raising it is opt-in for capable hardware.
- These defaults must be safe on the smallest target machine.

## 3. Scope

**In scope**

- Prefetch-one pipelining in `processTextStream` (`lib/upload-processor.ts`).
- Optional `table` parameter threaded `processTextStream` → `insertBatch`,
  defaulting to `'ulp.credentials'`, so the benchmark exercises the real insert
  path against a throwaway table.
- `IMPORT_PIPELINE` kill-switch env (default on).
- `UPLOAD_CONCURRENCY` env in `lib/upload-queue.ts` (default 1).
- `scripts/benchmark-import.ts` with synthetic-default + `--file` data sources.
- Unit tests for all of the above; full regression suite stays green.

**Out of scope** (each its own later spec)

- Shipping configurable batch size in production (proposal item 1).
- Async-insert mode (8), fsync fast-import mode (9), app-level backpressure (10).
- RowBinary/Native insert format (7).
- Moving the tier/T3 filter into the parser + new drop rules (3).
- Live bottleneck metrics dashboard in the Inbox Monitor (4).

The benchmark **explores** batch sizes via a `--batch` flag, but exploring is not
shipping — production continues to use the hardcoded `UPLOAD_BATCH_SIZE = 100_000`
until sub-project B decides otherwise.

## 4. Invariants to preserve (from the June-21 plan)

1. Exactly one `insertBatch` is in flight at a time, inserted **in order**.
2. Inserts remain **synchronous + retryable** via `withClickHouseRetry`, with a
   stable `insert_deduplication_token` reused across retry attempts and a fresh
   `Readable` per attempt.
3. A batch that fails after retries **aborts the whole file** — no extra partial
   inserts, the parser is stopped, and the stream reader lock is released.
4. Peak heap stays bounded and predictable.

## 5. Architecture

### 5.1 File map

| File | Change |
|---|---|
| `lib/upload-processor.ts` | Extract core `streamCredentialsToTable` (prefetch-one loop); `processTextStream` wraps it; optional `table` (default `'ulp.credentials'`) threaded to `insertBatch`; `importPipelineEnabled()` reading `IMPORT_PIPELINE` |
| `lib/upload-queue.ts` | `parseConcurrency()` + `pLimit(parseConcurrency(process.env.UPLOAD_CONCURRENCY))` |
| `scripts/benchmark-import.ts` | **New** — synthetic/`--file` data, throwaway table lifecycle, config sweep, metrics report |
| `__tests__/import-pipeline.test.ts` | **New** — overlap, memory bound, order, retry/token, abort, kill-switch |
| `__tests__/upload-queue.test.ts` | Extend — concurrency env parsing/clamp |
| `README.md` | Document `IMPORT_PIPELINE`, `UPLOAD_CONCURRENCY`, and the benchmark |

### 5.2 Data flow

```
file/zip-entry stream
  → parseULPStream(stream, filename, batchSize)   # async generator, batches of N
  → [prefetch N+1 while N inserts]                 # pipelining (this spec)
  → tier filter (ingest-filter, unchanged)
  → insertBatch(creds, breach, …, { table })       # one in flight, in order, retryable
  → ClickHouse (ulp.credentials in prod; ulp.bench_* in benchmark)
  → counters + progress (updateJob / onBatch)
```

## 6. Component design

### 6.1 Pipelining (core loop extracted into `streamCredentialsToTable`)

The parse→insert loop currently lives inside `processTextStream`, which also does
re-upload guarding, `recordSource`, and monitor checks. So the benchmark can
exercise the **real** pipelining/insert path without those side effects (it must
never write `ulp.sources` or fire domain monitors), extract the loop into an
exported core:

```
streamCredentialsToTable(stream, filename, {
  table, batchSize, pipeline, filterOn, dropPolicy, onBatch,
}) → { imported, skipped, tierDropped, rejection_breakdown }
```

`processTextStream` becomes a thin wrapper: re-upload guard → `streamCredentialsToTable(…)`
→ `recordSource` + monitors. The benchmark calls `streamCredentialsToTable`
directly against a `bench_*` table. The core replaces the sequential `for await`
loop at [`lib/upload-processor.ts:229-245`](../../lib/upload-processor.ts):

```ts
const gen = parseULPStream(stream, filename, UPLOAD_BATCH_SIZE)
const pipeline = importPipelineEnabled()      // IMPORT_PIPELINE !== 'off'
let pending = gen.next()                        // start parsing batch 0
try {
  while (true) {
    const { value: batch, done } = await pending
    if (done) break
    if (pipeline) pending = gen.next()          // parse N+1 during the insert of N

    let creds = batch.credentials
    if (filterOn) {
      const kept = creds.filter(c => !shouldDropAtIngest(c.email, c.url, c.domain, dropPolicy))
      tierDropped += creds.length - kept.length
      creds = kept
    }
    skipped += batch.rejected
    for (const [k, v] of Object.entries(batch.breakdown)) {
      rejection_breakdown[k as RejectionReason] =
        (rejection_breakdown[k as RejectionReason] ?? 0) + v
    }

    await insertBatch(creds, breach_name, undefined, { table })   // only ever one in flight
    imported += creds.length
    if (jobId)   updateJob(jobId, { imported, skipped })
    if (onBatch) onBatch(imported)

    if (!pipeline) pending = gen.next()          // sequential fallback
  }
} finally {
  await gen.return(undefined).catch(() => {})    // stop parser, release stream lock
  await Promise.resolve(pending).catch(() => {}) // absorb in-flight prefetch
}
```

**Memory:** peak rises from ~1 to ~2 batches of credential objects (≈ +30 MB at
100K rows). The per-file dedup `Set` (≤ ~440 MB, capped at 2M entries) lives
inside the generator and is unchanged. The 2-batch ceiling is structural — there
is no growable queue.

**Overlap rationale:** `await insertBatch` is network I/O wait; during it the
event loop advances `gen.next()`, performing the next batch's CPU-bound parse.
Worst case (insert returns instantly) the behavior degrades to sequential with
one extra resident batch — never slower than today.

**Error handling:** any throw exits via `finally`, which calls `gen.return()` so
the generator runs its `finally { reader.releaseLock() }`, then swallows the
prefetch promise so a late rejection cannot become an unhandled rejection.

`importPipelineEnabled()` returns `process.env.IMPORT_PIPELINE !== 'off'`
(default on; on-by-default is safe because the cost is bounded to one batch).

### 6.2 `insertBatch` table parameter

`insertBatch(credentials, breach_name, retryOptions?, opts?: { table?: string })`,
with `opts.table ?? 'ulp.credentials'` used for the `table:` field. No behavior
change in production (default preserved). This is the seam the benchmark uses to
hit a throwaway table through the real insert code, avoiding a divergent
benchmark-only insert path. `processTextStream` gains a matching optional
`table` that it forwards.

### 6.3 Concurrency knob (`lib/upload-queue.ts`)

```ts
export function parseConcurrency(raw?: string): number {
  const n = parseInt(raw ?? '1', 10)
  return Number.isFinite(n) && n >= 1 ? n : 1   // invalid / <1 → 1
}
export const uploadQueue = pLimit(parseConcurrency(process.env.UPLOAD_CONCURRENCY))
```

- Default `1` → behavior identical to today; shared by HTTP uploads and the
  inbox watcher as before.
- **Documented caveats** (README + code comment): N>1 multiplies peak heap
  (N batches in flight + N dedup Sets) and makes `getCurrentJob()` best-effort
  ("one of N"). Neither matters at the default; raising N is for capable
  hardware only.

### 6.4 Benchmark harness (`scripts/benchmark-import.ts`)

- **Runner:** a TypeScript script executed through the project's existing TS
  tooling (exact runner — `tsx` vs `ts-node` — confirmed in the plan; it must be
  able to import `lib/*` with the `@/` alias).
- **Data sources:**
  - *Synthetic (default):* a **seeded** generator emitting a realistic mix that
    exercises the parser's main branches — `url:login:pass`, `email:pass`,
    tab-separated, block-format — plus a junk fraction that triggers the drop
    rules, so parser cost is honest. Reproducible and contains no real
    credentials.
  - *`--file <path>`:* stream a real local sample for realistic parser stress.
- **Isolation:** at start,
  `CREATE TABLE ulp.bench_<timestamp> AS ulp.credentials ENGINE = MergeTree PARTITION BY toYYYYMM(imported_at) ORDER BY (domain, email, imported_at)`.
  `AS ulp.credentials` copies the columns (including every MATERIALIZED column and
  skip index, so insert-time compute/index cost is realistic); the explicit
  `ENGINE = MergeTree` override is **mandatory** — a bare `AS` clone copies the
  real table's `ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials', …)`
  Keeper path and collides with the production table. The bench table is a plain,
  local, non-replicated MergeTree. `DROP TABLE` runs in a `finally`; a hard guard
  refuses any target name not prefixed `bench_`.
  - *Known limitations:* replication overhead and any materialized **views** on
    `ulp.credentials` are not reproduced on the bench table. Base-table insert
    cost — materialized columns, skip indexes, parts/merges — is, which is what
    pipelining targets.
- **Flags:** `--rows <n>`, `--batch <n>` (per-run batch size — exploration only),
  `--pipeline on|off`, `--concurrency <n>`, `--sweep` (runs the
  100K/250K/500K × pipeline-on/off × concurrency-1/2 matrix), `--json <path>`.
- **Drives `streamCredentialsToTable`** with `{ table }` — the same core loop
  production uses — so results reflect the real parse/insert path without the
  `recordSource`/monitor side effects.
- **Metrics per run:**
  - overall rows/s and wall-clock duration;
  - **peak Node heapUsed + RSS** (sampled ~every 250 ms, report max);
  - **parse-bound vs insert-bound split** — cumulative time awaiting `insertBatch`
    vs time spent in parse, the diagnostic that says whether the next lever is
    pipelining, batch size, or async;
  - end-of-run ClickHouse snapshot — bench-table parts (`system.parts`), active
    merges (`system.merges`), CH memory (`system.metrics`/
    `system.asynchronous_metrics`). These primarily serve sub-project B but are
    cheap to capture now.
- **Output:** a formatted comparison table to stdout; optional JSON for diffing.

## 7. Testing strategy (TDD — write the failing test first)

| Test (file) | Asserts |
|---|---|
| Overlap (`import-pipeline`) | with a deferred mock insert, `gen.next()` for N+1 is called before insert N resolves |
| Memory bound (`import-pipeline`) | generator never pulled >1 ahead — no N+2 fetch until insert N completes |
| Order (`import-pipeline`) | batches insert in order 0,1,2,… |
| Retry/token (`import-pipeline`) | reuse `insert-batch-dedup` harness: same dedup token on retry, distinct `Readable` per attempt |
| Abort (`import-pipeline`) | insert rejects → loop throws, `gen.return()` called, no unhandled rejection from prefetch |
| Kill-switch (`import-pipeline`) | `IMPORT_PIPELINE=off` → strict sequential order |
| Concurrency (`upload-queue`) | `parseConcurrency` default/clamp/invalid; `uploadQueue.concurrency === N` |
| Benchmark (`benchmark-import`) | seeded synthetic generator emits parseable lines; table-name guard rejects non-`bench_` |
| Regression | full `npm test` + `npm run typecheck` + `npm run build` stay green |

Notes: pipelining tests inject a mock async generator and a mock `insertBatch`
with a controllable deferred, so overlap/order/abort are deterministic with no
ClickHouse. Concurrency tests cover the pure `parseConcurrency` and assert
p-limit's `.concurrency` getter reflects the env (confirm getter availability in
the installed `p-limit` during planning; fall back to asserting via the factory
if absent).

## 8. Success criteria

- Benchmark shows pipeline-on rows/s **≥** pipeline-off (never slower) with peak
  heap increase **≤ ~1 batch**.
- All existing tests pass; the four June-21 invariants (§4) are asserted by new
  tests.
- Benchmark is reproducible (seeded synthetic), self-cleaning, and provably never
  writes to `ulp.credentials` / `ulp.sources`.
- Concurrency default remains `1`; the memory cost of raising it is documented.

## 9. Resolved planning notes

- **Runner:** `tsx@4.19.2` is already a devDependency; the benchmark runs via
  `npx tsx scripts/benchmark-import.ts`. The one risk is `@/` alias resolution
  outside Next.js — Plan Task 1 verifies `tsx` honors the tsconfig `paths`;
  fallback is `vite-node` (Vite + `vite-tsconfig-paths` are already present) or a
  `tsconfig-paths` register hook.
- **Concurrency assert:** `p-limit@7.3.0` exposes a `.concurrency` getter, so
  `uploadQueue.concurrency === N` is directly assertable; no factory needed
  (`parseConcurrency` stays a pure, separately-tested function).
- **Bench table:** created via
  `CREATE TABLE … AS ulp.credentials ENGINE = MergeTree …` — the engine override
  is mandatory to avoid the Replicated Keeper-path collision (see §6.4).
- **System metrics:** the end-of-run `system.parts`/`system.merges` snapshot needs
  admin access, already used by `app/api/monitoring/async-inserts/route.ts`.
