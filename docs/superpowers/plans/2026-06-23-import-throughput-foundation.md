# Import Throughput Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Speed up ULP imports by overlapping parsing with inserts (pipelining) and make upload concurrency configurable, plus a benchmark harness — all without raising peak memory beyond one extra batch.

**Architecture:** Extract the parse→insert loop out of `processTextStream` into a side-effect-free core `streamCredentialsToTable` that prefetches the next parser batch while the current batch inserts (max 2 batches resident). `processTextStream` becomes a thin wrapper that keeps the re-upload guard, `recordSource`, and monitor calls. A standalone `scripts/benchmark-import.ts` drives that same core against a throwaway `ulp.bench_*` table.

**Tech Stack:** Next.js 15 / React 19 / TypeScript 5, `@clickhouse/client` 1.19, `p-limit` 7.3, Vitest 4, `tsx` 4.19, ClickHouse 26.x.

**Spec:** [docs/superpowers/specs/2026-06-23-import-throughput-foundation-design.md](../specs/2026-06-23-import-throughput-foundation-design.md)

**Execution isolation:** Run this plan in a dedicated branch/worktree (per superpowers:using-git-worktrees), e.g. `feat/import-throughput-foundation`. All `git commit` steps below assume that branch.

**Invariants that MUST stay green (from the 2026-06-21 resilience plan):** synchronous in-order inserts, one insert in flight, deterministic retry with a stable `insert_deduplication_token`, `max_insert_threads=2`, no `async_insert` in the client call, abort-the-file on insert failure, `UPLOAD_BATCH_SIZE === 100_000`.

---

### Task 1: Configurable upload concurrency

**Files:**
- Modify: `lib/upload-queue.ts`
- Test: `__tests__/upload-queue.test.ts`

**Interface:**
- Produces `parseConcurrency(raw?: string): number` (pure, default 1, clamps invalid/<1 to 1).
- `uploadQueue` is built with `pLimit(parseConcurrency(process.env.UPLOAD_CONCURRENCY))`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/upload-queue.test.ts` (after the existing `describe('uploadQueue', …)` block):

```ts
import { afterEach as afterEachConc, beforeEach as beforeEachConc } from 'vitest'

describe('parseConcurrency', () => {
  it('defaults to 1 for unset, empty, non-numeric, zero, or negative', async () => {
    const { parseConcurrency } = await import('@/lib/upload-queue')
    expect(parseConcurrency(undefined)).toBe(1)
    expect(parseConcurrency('')).toBe(1)
    expect(parseConcurrency('abc')).toBe(1)
    expect(parseConcurrency('0')).toBe(1)
    expect(parseConcurrency('-4')).toBe(1)
  })

  it('parses valid positive integers', async () => {
    const { parseConcurrency } = await import('@/lib/upload-queue')
    expect(parseConcurrency('2')).toBe(2)
    expect(parseConcurrency('3')).toBe(3)
  })
})

describe('uploadQueue concurrency from env', () => {
  const original = process.env.UPLOAD_CONCURRENCY
  afterEachConc(() => {
    if (original === undefined) delete process.env.UPLOAD_CONCURRENCY
    else process.env.UPLOAD_CONCURRENCY = original
    vi.resetModules()
  })

  it('honours UPLOAD_CONCURRENCY when building the limiter', async () => {
    process.env.UPLOAD_CONCURRENCY = '3'
    vi.resetModules()
    const { uploadQueue } = await import('@/lib/upload-queue')
    expect(uploadQueue.concurrency).toBe(3)
  })

  it('defaults the limiter to concurrency 1', async () => {
    delete process.env.UPLOAD_CONCURRENCY
    vi.resetModules()
    const { uploadQueue } = await import('@/lib/upload-queue')
    expect(uploadQueue.concurrency).toBe(1)
  })
})
```

Also add `vi` to the existing import line at the top of the file:

```ts
import { describe, test, it, expect, afterEach, vi } from 'vitest'
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm test -- __tests__/upload-queue.test.ts`
Expected: FAIL — `parseConcurrency` is not exported.

- [ ] **Step 3: Implement parseConcurrency and wire the limiter**

Replace the top of `lib/upload-queue.ts` (the import + `export const uploadQueue = pLimit(1)`) with:

```ts
import pLimit from 'p-limit'

/**
 * Parse UPLOAD_CONCURRENCY into a safe limiter size.
 * Invalid, empty, zero, or negative values fall back to 1.
 *
 * NB: raising this multiplies peak heap — each concurrent file holds its own
 * in-flight batch(es) AND its own ~440 MB-capped dedup Set. Only raise on
 * hardware with memory headroom. getCurrentJob() becomes best-effort ("one of
 * N") when concurrency > 1.
 */
export function parseConcurrency(raw?: string): number {
  const n = parseInt(raw ?? '1', 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

export const uploadQueue = pLimit(parseConcurrency(process.env.UPLOAD_CONCURRENCY))
```

Leave `queueSize()` and the current-job helpers below unchanged.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: `npm test -- __tests__/upload-queue.test.ts`
Expected: PASS — all existing serialization tests plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add lib/upload-queue.ts __tests__/upload-queue.test.ts
git commit -m "feat(import): make upload concurrency configurable via UPLOAD_CONCURRENCY (default 1)"
```

---

### Task 2: `insertBatch` target-table parameter

**Files:**
- Modify: `lib/upload-processor.ts:113-161` (the `insertBatch` function)
- Test: `__tests__/insert-batch-dedup.test.ts`

**Interface:**
- `insertBatch(credentials, breach_name, retryOptions?, opts?: { table?: string })`.
- `opts.table` defaults to `'ulp.credentials'` — existing 3-arg calls are unchanged.

- [ ] **Step 1: Write the failing test**

Append this test inside the `describe('insertBatch deduplication settings', …)` block in `__tests__/insert-batch-dedup.test.ts`:

```ts
  it('defaults to ulp.credentials and honours an explicit target table', async () => {
    const { insertBatch } = await import('@/lib/upload-processor')
    const batch = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', domain: 'a.com' })]

    await insertBatch(batch, 'breachX')
    expect(insertSpy.mock.calls[0][0].table).toBe('ulp.credentials')

    insertSpy.mockClear()

    await insertBatch(batch, 'breachX', undefined, { table: 'ulp.bench_123' })
    expect(insertSpy.mock.calls[0][0].table).toBe('ulp.bench_123')
  })
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- __tests__/insert-batch-dedup.test.ts`
Expected: FAIL — second call still targets `ulp.credentials` (the param does not exist yet).

- [ ] **Step 3: Add the optional table parameter**

In `lib/upload-processor.ts`, change the `insertBatch` signature from:

```ts
export async function insertBatch(
  credentials: ULPCredential[],
  breach_name: string,
  retryOptions: ClickHouseRetryOptions = {},
): Promise<void> {
```

to:

```ts
export async function insertBatch(
  credentials: ULPCredential[],
  breach_name: string,
  retryOptions: ClickHouseRetryOptions = {},
  opts: { table?: string } = {},
): Promise<void> {
```

Then change the insert's `table:` line from:

```ts
      await chClient.insert({
        table: 'ulp.credentials',
```

to:

```ts
      await chClient.insert({
        table: opts.table ?? 'ulp.credentials',
```

Leave everything else in `insertBatch` (token, Readable generator, `clickhouse_settings`, retry wrapper) untouched.

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `npm test -- __tests__/insert-batch-dedup.test.ts`
Expected: PASS — all three tests, including the new one.

- [ ] **Step 5: Commit**

```bash
git add lib/upload-processor.ts __tests__/insert-batch-dedup.test.ts
git commit -m "feat(import): allow insertBatch to target a benchmark table (default ulp.credentials)"
```

---

### Task 3: Extract `streamCredentialsToTable` core with prefetch-one pipelining

**Files:**
- Modify: `lib/upload-processor.ts` (add `node:perf_hooks` import, `importPipelineEnabled`, `streamCredentialsToTable`; rewrite `processTextStream`'s loop)
- Test: `__tests__/import-pipeline.test.ts` (create)

**Interface:**
- `importPipelineEnabled(): boolean` — `process.env.IMPORT_PIPELINE !== 'off'`.
- `streamCredentialsToTable(stream, filename, options) → { imported, skipped, tierDropped, rejection_breakdown }`.

- [ ] **Step 1: Write the failing pipelining tests**

Create `__tests__/import-pipeline.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'stream'

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  query: vi.fn().mockResolvedValue({ json: async () => [{ c: 0 }] }),
}))
vi.mock('@/lib/clickhouse', () => ({
  getClient: () => ({ insert: h.insert, query: h.query }),
}))

// Controllable parser: yields the prebuilt batches and records each pull index.
const parser = vi.hoisted(() => ({ pulls: [] as number[], batches: [] as any[] }))
vi.mock('@/lib/ulp-parser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ulp-parser')>('@/lib/ulp-parser')
  return {
    ...actual,
    parseULPStream: async function* () {
      for (let i = 0; i < parser.batches.length; i++) {
        parser.pulls.push(i)
        yield parser.batches[i]
      }
    },
  }
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))
const emptyBreakdown = () => ({ blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 })
const oneCred = (pw: string) => ({
  credentials: [{ url: '', email: `u@${pw}.com`, password: pw, domain: `${pw}.com`, source_file: 'b.txt' }],
  rejected: 0,
  breakdown: emptyBreakdown(),
})
const webStream = () => Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>

beforeEach(() => {
  parser.pulls = []
  parser.batches = []
  h.insert.mockReset()
})

describe('streamCredentialsToTable pipelining', () => {
  it('parses the next batch while the current insert is in flight (pipeline on)', async () => {
    parser.batches = [oneCred('a'), oneCred('b')]
    let gateOpen = false
    const waiters: Array<() => void> = []
    h.insert.mockImplementation(() =>
      gateOpen ? Promise.resolve() : new Promise<void>(res => waiters.push(res)))

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    const done = streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: true })

    await tick()
    expect(h.insert).toHaveBeenCalledTimes(1)   // inserting batch a
    expect(parser.pulls).toContain(1)           // batch b parsed DURING insert a

    gateOpen = true
    waiters.forEach(r => r())
    await done
  })

  it('does not prefetch the next batch when pipeline is off', async () => {
    parser.batches = [oneCred('a'), oneCred('b')]
    let gateOpen = false
    const waiters: Array<() => void> = []
    h.insert.mockImplementation(() =>
      gateOpen ? Promise.resolve() : new Promise<void>(res => waiters.push(res)))

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    const done = streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: false })

    await tick()
    expect(h.insert).toHaveBeenCalledTimes(1)
    expect(parser.pulls).not.toContain(1)       // batch b NOT parsed until insert a resolves

    gateOpen = true
    waiters.forEach(r => r())
    await done
    expect(parser.pulls).toContain(1)
  })

  it('inserts batches in order and sums the imported count', async () => {
    parser.batches = [oneCred('a'), oneCred('b'), oneCred('c')]
    const seen: string[] = []
    h.insert.mockImplementation(async (opts: any) => {
      const chunks: Buffer[] = []
      for await (const ch of opts.values as Readable)
        chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(String(ch)))
      seen.push(Buffer.concat(chunks).toString('utf8'))
    })

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    const res = await streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: true })

    expect(res.imported).toBe(3)
    expect(seen).toHaveLength(3)
    expect(seen[0]).toContain('"a"')
    expect(seen[1]).toContain('"b"')
    expect(seen[2]).toContain('"c"')
  })

  it('aborts the file and stops the parser when an insert fails', async () => {
    parser.batches = [oneCred('a'), oneCred('b'), oneCred('c')]
    h.insert.mockRejectedValue(Object.assign(new Error('refused'), { code: '62' })) // non-transient

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    await expect(
      streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: true })
    ).rejects.toThrow('refused')

    expect(parser.pulls).not.toContain(2)       // batch c never parsed — parser stopped
  })

  it('accumulates parse/insert timings when a timings accumulator is provided', async () => {
    parser.batches = [oneCred('a')]
    h.insert.mockResolvedValue(undefined)
    const timings = { parseMs: 0, insertMs: 0 }

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    await streamCredentialsToTable(webStream(), 'b.txt', { table: 'ulp.bench_x', pipeline: true, timings })

    expect(timings.parseMs).toBeGreaterThanOrEqual(0)
    expect(timings.insertMs).toBeGreaterThanOrEqual(0)
    expect(timings.parseMs + timings.insertMs).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm test -- __tests__/import-pipeline.test.ts`
Expected: FAIL — `streamCredentialsToTable` is not exported.

- [ ] **Step 3: Add the perf_hooks import, `importPipelineEnabled`, and the core function**

In `lib/upload-processor.ts`, add to the imports at the top:

```ts
import { performance } from 'node:perf_hooks'
```

Add this helper just above `processTextStream`:

```ts
/**
 * Pipelining is ON unless explicitly disabled. It overlaps parsing of the next
 * batch with the insert of the current one, costing at most one extra resident
 * batch (~30 MB at 100K rows). Set IMPORT_PIPELINE=off to fall back to strictly
 * sequential parse→insert (kill-switch / benchmark comparison).
 */
export function importPipelineEnabled(): boolean {
  return process.env.IMPORT_PIPELINE !== 'off'
}

export interface StreamToTableOptions {
  /** Target table. Default 'ulp.credentials'. Benchmark passes a 'ulp.bench_*' table. */
  table?: string
  /** Rows per parser batch. Default UPLOAD_BATCH_SIZE. */
  batchSize?: number
  /** Overlap parse(N+1) with insert(N). Default importPipelineEnabled(). */
  pipeline?: boolean
  /** Apply the ingest tier filter. Default false. */
  filterOn?: boolean
  /** Drop policy used when filterOn. */
  dropPolicy?: ReturnType<typeof parseIngestPolicy>
  /** Breach label for inserted rows. Default matchBreach(filename). */
  breachName?: string
  /** Called after each batch inserts, with cumulative counts. */
  onProgress?: (imported: number, skipped: number) => void
  /** Optional accumulator (benchmark): time awaiting parse vs awaiting insert. */
  timings?: { parseMs: number; insertMs: number }
}

export interface StreamToTableResult {
  imported: number
  skipped: number
  tierDropped: number
  rejection_breakdown: Record<RejectionReason, number>
}

/**
 * Core parse→insert loop, free of source-recording and monitor side effects so
 * the benchmark can drive the real path against a throwaway table.
 *
 * Prefetch-one pipelining: when `pipeline`, the next parser batch is requested
 * BEFORE awaiting the current insert, so the parser's CPU work fills the insert's
 * I/O wait. At most two batches are ever resident. Exactly one insert is awaited
 * at a time, in order — preserving synchronous, retryable, dedup-token semantics.
 * On any insert failure the finally stops the generator (releasing the stream
 * reader lock) and absorbs the in-flight prefetch so it cannot become an
 * unhandled rejection; the original error propagates and aborts the file.
 */
export async function streamCredentialsToTable(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  options: StreamToTableOptions = {},
): Promise<StreamToTableResult> {
  const table       = options.table ?? 'ulp.credentials'
  const batchSize   = options.batchSize ?? UPLOAD_BATCH_SIZE
  const pipeline    = options.pipeline ?? importPipelineEnabled()
  const filterOn    = options.filterOn ?? false
  const dropPolicy  = options.dropPolicy
  const breach_name = options.breachName ?? matchBreach(filename)
  const timings     = options.timings

  let imported = 0
  let skipped = 0
  let tierDropped = 0
  const rejection_breakdown = makeRejectionMap()

  const gen = parseULPStream(stream, filename, batchSize)
  let pending = gen.next()
  try {
    while (true) {
      const tParse = timings ? performance.now() : 0
      const { value: batch, done } = await pending
      if (timings) timings.parseMs += performance.now() - tParse
      if (done) break

      // Kick off parsing of the NEXT batch before blocking on this insert.
      if (pipeline) pending = gen.next()

      let creds = batch.credentials
      if (filterOn && dropPolicy) {
        const kept = creds.filter(c => !shouldDropAtIngest(c.email, c.url, c.domain, dropPolicy))
        tierDropped += creds.length - kept.length
        creds = kept
      }
      skipped += batch.rejected
      for (const [k, v] of Object.entries(batch.breakdown)) {
        rejection_breakdown[k as RejectionReason] =
          (rejection_breakdown[k as RejectionReason] ?? 0) + v
      }

      const tInsert = timings ? performance.now() : 0
      await insertBatch(creds, breach_name, undefined, { table })
      if (timings) timings.insertMs += performance.now() - tInsert

      imported += creds.length
      options.onProgress?.(imported, skipped)

      // Sequential fallback: only fetch the next batch after the insert is done.
      if (!pipeline) pending = gen.next()
    }
  } finally {
    await gen.return(undefined).catch(() => {})
    await Promise.resolve(pending).catch(() => {})
  }

  return { imported, skipped, tierDropped, rejection_breakdown }
}
```

- [ ] **Step 4: Run the pipelining tests and confirm GREEN**

Run: `npm test -- __tests__/import-pipeline.test.ts`
Expected: PASS — all five tests.

- [ ] **Step 5: Rewrite `processTextStream` to wrap the core**

Replace the **entire** existing `processTextStream` function (re-upload guard, counters, and the `for await` loop) with this version — it keeps the guard, `recordSource`, and monitor call but delegates the parse/insert loop to the core:

```ts
export async function processTextStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  jobId?: string,
  onBatch?: (imported: number) => void,
): Promise<ProcessResult> {
  const breach_name = matchBreach(filename)

  // Durable re-upload guard (unchanged): a filename already in ulp.sources was
  // fully imported before, so skip re-reading/inserting it entirely.
  if (await sourceAlreadyImported(filename)) {
    console.log(`[upload-processor] ${filename} already in ulp.sources — skipping re-import`)
    return {
      imported: 0, skipped: 0, errors: 0, filename, breach_name,
      rejection_breakdown: makeRejectionMap(), alreadyImported: true, tierDropped: 0,
    }
  }

  // Ingest tier filter — off unless INGEST_FILTER_* is configured.
  const dropPolicy = parseIngestPolicy()
  const filterOn   = policyActive(dropPolicy)

  const { imported, skipped, tierDropped, rejection_breakdown } =
    await streamCredentialsToTable(stream, filename, {
      table:      'ulp.credentials',
      batchSize:  UPLOAD_BATCH_SIZE,
      pipeline:   importPipelineEnabled(),
      filterOn,
      dropPolicy,
      breachName: breach_name,
      onProgress: (imp, skp) => {
        if (jobId)   updateJob(jobId, { imported: imp, skipped: skp })
        if (onBatch) onBatch(imp)
      },
    })

  if (filterOn && tierDropped > 0) {
    console.log(`[ingest-filter] ${filename}: dropped ${tierDropped} low-tier rows pre-insert`)
  }

  if (imported > 0) {
    await recordSource(filename, imported)
    checkMonitorsForULPUpload(filename).catch(err =>
      console.error('Domain monitor check error:', err)
    )
    // Cross-file content dedup remains scheduled/manual — imports no longer
    // trigger a full-table dedup hook here.
  }

  return { imported, skipped, errors: 0, filename, breach_name, rejection_breakdown, alreadyImported: false, tierDropped }
}
```

- [ ] **Step 6: Run the full upload-processor + parser test group and confirm GREEN**

Run: `npm test -- __tests__/upload-processor.test.ts __tests__/import-pipeline.test.ts __tests__/insert-batch-dedup.test.ts __tests__/ulp-parser-stream.test.ts`
Expected: PASS — including `passes UPLOAD_BATCH_SIZE to parseULPStream during text imports` and all `processZipBuffer` insert-failure tests (they exercise the new wrapper → core path).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add lib/upload-processor.ts __tests__/import-pipeline.test.ts
git commit -m "feat(import): prefetch-one parse/insert pipelining via streamCredentialsToTable core"
```

---

### Task 4: Benchmark building blocks (pure, unit-tested)

**Files:**
- Create: `scripts/benchmark-import.ts`
- Test: `__tests__/benchmark-import.test.ts`

**Interface (exports):**
- `mulberry32(seed: number): () => number`
- `makeSyntheticLine(rnd: () => number): string`
- `assertBenchTable(name: string): void`
- `parseArgs(argv: string[]): BenchArgs`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/benchmark-import.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mulberry32, makeSyntheticLine, assertBenchTable, parseArgs } from '../scripts/benchmark-import'
import { parseLine } from '@/lib/ulp-parser'

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42), b = mulberry32(42)
    for (let i = 0; i < 10; i++) expect(a()).toBe(b())
  })
  it('differs across seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })
})

describe('makeSyntheticLine', () => {
  it('is deterministic for a given seed', () => {
    expect(makeSyntheticLine(mulberry32(7))).toBe(makeSyntheticLine(mulberry32(7)))
  })
  it('produces mostly parseable credential lines', () => {
    const rnd = mulberry32(123)
    let credentials = 0
    const total = 500
    for (let i = 0; i < total; i++) {
      const { credential } = parseLine(makeSyntheticLine(rnd), 'bench.txt')
      if (credential) credentials++
    }
    expect(credentials / total).toBeGreaterThan(0.5)
  })
})

describe('assertBenchTable', () => {
  it('accepts ulp.bench_* names', () => {
    expect(() => assertBenchTable('ulp.bench_1719_123')).not.toThrow()
  })
  it('rejects any non-benchmark table', () => {
    expect(() => assertBenchTable('ulp.credentials')).toThrow()
    expect(() => assertBenchTable('ulp.sources')).toThrow()
    expect(() => assertBenchTable('bench_1')).toThrow()
  })
})

describe('parseArgs', () => {
  it('applies defaults', () => {
    const a = parseArgs([])
    expect(a.rows).toBe(200000)
    expect(a.batch).toBe(100000)
    expect(a.pipeline).toBe(true)
    expect(a.concurrency).toBe(1)
    expect(a.sweep).toBe(false)
  })
  it('parses overrides', () => {
    const a = parseArgs(['--rows', '50000', '--batch', '250000', '--pipeline', 'off', '--concurrency', '2', '--sweep'])
    expect(a.rows).toBe(50000)
    expect(a.batch).toBe(250000)
    expect(a.pipeline).toBe(false)
    expect(a.concurrency).toBe(2)
    expect(a.sweep).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm test -- __tests__/benchmark-import.test.ts`
Expected: FAIL — `scripts/benchmark-import.ts` does not exist.

- [ ] **Step 3: Create the building blocks**

Create `scripts/benchmark-import.ts`:

```ts
/**
 * Import throughput benchmark.
 *
 * Drives the REAL streamCredentialsToTable core against a throwaway
 * ulp.bench_<ts> table (cloned from ulp.credentials but forced to a plain local
 * MergeTree — never the production Replicated table). Never writes ulp.sources.
 *
 * Run (requires local ClickHouse — `npm run docker:infra`):
 *   npx tsx scripts/benchmark-import.ts --rows 200000
 *   npx tsx scripts/benchmark-import.ts --sweep --rows 200000 --json bench.json
 *   npx tsx scripts/benchmark-import.ts --file ./sample.txt --batch 250000
 */

/** Seeded PRNG (deterministic synthetic data). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TLDS = ['com', 'net', 'org', 'co.uk', 'de', 'ru', 'com.br']
const WORDS = ['shop', 'mail', 'login', 'portal', 'acme', 'globex', 'umbrella', 'initech']

/** One synthetic ULP line exercising the parser's main single-line branches. */
export function makeSyntheticLine(rnd: () => number): string {
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]
  const user = `user${Math.floor(rnd() * 100000)}`
  const dom = `${pick(WORDS)}.${pick(TLDS)}`
  const pass = `Pa55_${Math.floor(rnd() * 1e8).toString(36)}`
  const r = rnd()
  if (r < 0.45) return `https://${dom}/account:${user}:${pass}`       // url:login:pass
  if (r < 0.75) return `${user}@${dom}:${pass}`                       // email:pass
  if (r < 0.9) return `https://${dom}/x\t${user}\t${pass}`            // tab-separated
  return `# ${pick(WORDS)} note ${Math.floor(rnd() * 1000)}`          // junk (dropped)
}

/** Guard: refuse to operate on anything but a ulp.bench_* table. */
export function assertBenchTable(name: string): void {
  if (!/^ulp\.bench_[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to use non-benchmark table: ${name}`)
  }
}

export interface BenchArgs {
  rows: number
  batch: number
  pipeline: boolean
  concurrency: number
  file?: string
  seed: number
  sweep: boolean
  json?: string
}

export function parseArgs(argv: string[]): BenchArgs {
  const val = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (k: string): boolean => argv.includes(`--${k}`)
  return {
    rows: Number(val('rows') ?? 200000),
    batch: Number(val('batch') ?? 100000),
    pipeline: (val('pipeline') ?? 'on') !== 'off',
    concurrency: Number(val('concurrency') ?? 1),
    file: val('file'),
    seed: Number(val('seed') ?? 1),
    sweep: has('sweep'),
    json: val('json'),
  }
}
```

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: `npm test -- __tests__/benchmark-import.test.ts`
Expected: PASS — all building-block tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/benchmark-import.ts __tests__/benchmark-import.test.ts
git commit -m "feat(bench): seeded synthetic data, bench-table guard, and arg parsing"
```

---

### Task 5: Benchmark orchestration + runnable entrypoint

**Files:**
- Modify: `scripts/benchmark-import.ts` (add streams, `runBenchmark`, report, `main`)

**Interface:**
- `runBenchmark(cfg): Promise<BenchResult>` — creates `concurrency` bench tables, runs the core into each in parallel, snapshots ClickHouse, drops the tables.
- `main()` runs only when the file is executed directly (not when imported by tests).

- [ ] **Step 1: Append the orchestration code**

First add these imports directly **below the opening doc-comment block at the top** of `scripts/benchmark-import.ts` (before `export function mulberry32`), so they satisfy the `import/first` lint rule:

```ts
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import { getClient, executeQuery } from '@/lib/clickhouse'
import { streamCredentialsToTable } from '@/lib/upload-processor'
```

Then append the rest to the **bottom** of the file:

```ts
interface BenchConfig {
  rows: number
  batch: number
  pipeline: boolean
  concurrency: number
  file?: string
  seed: number
}

interface BenchResult extends BenchConfig {
  imported: number
  wallMs: number
  rowsPerSec: number
  peakRssMb: number
  parseMs: number
  insertMs: number
  activeParts: number
  activeMerges: number
}

/** A finite ReadableStream of `rows` synthetic lines. */
function syntheticStream(rows: number, seed: number): ReadableStream<Uint8Array> {
  const rnd = mulberry32(seed)
  let produced = 0
  const node = new Readable({
    read() {
      if (produced >= rows) { this.push(null); return }
      let chunk = ''
      for (let i = 0; i < 2000 && produced < rows; i++, produced++) {
        chunk += makeSyntheticLine(rnd) + '\n'
      }
      this.push(Buffer.from(chunk, 'utf8'))
    },
  })
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>
}

function makeStream(cfg: BenchConfig): ReadableStream<Uint8Array> {
  if (cfg.file) {
    return Readable.toWeb(fs.createReadStream(cfg.file)) as unknown as ReadableStream<Uint8Array>
  }
  return syntheticStream(cfg.rows, cfg.seed)
}

async function snapshot(tableNames: string[]): Promise<{ activeParts: number; activeMerges: number }> {
  const bare = tableNames.map(t => t.split('.')[1])
  const parts = await executeQuery(
    `SELECT count() AS c FROM system.parts WHERE database = 'ulp' AND table IN {t:Array(String)} AND active`,
    { t: bare },
  ) as Array<{ c: number | string }>
  const merges = await executeQuery(
    `SELECT count() AS c FROM system.merges WHERE database = 'ulp' AND table IN {t:Array(String)}`,
    { t: bare },
  ) as Array<{ c: number | string }>
  return { activeParts: Number(parts[0]?.c ?? 0), activeMerges: Number(merges[0]?.c ?? 0) }
}

export async function runBenchmark(cfg: BenchConfig): Promise<BenchResult> {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const tables = Array.from({ length: cfg.concurrency }, (_, i) => `ulp.bench_${stamp}_${i}`)
  tables.forEach(assertBenchTable)

  for (const t of tables) {
    await executeQuery(
      `CREATE TABLE ${t} AS ulp.credentials ` +
      `ENGINE = MergeTree PARTITION BY toYYYYMM(imported_at) ORDER BY (domain, email, imported_at)`,
    )
  }

  let peakRss = 0
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 250)
  const timings = { parseMs: 0, insertMs: 0 }
  const t0 = performance.now()

  try {
    const runs = tables.map(t =>
      streamCredentialsToTable(makeStream(cfg), cfg.file ?? `bench-${cfg.rows}.txt`, {
        table: t,
        batchSize: cfg.batch,
        pipeline: cfg.pipeline,
        timings,
      }),
    )
    const results = await Promise.all(runs)
    const imported = results.reduce((s, r) => s + r.imported, 0)
    const wallMs = performance.now() - t0
    const snap = await snapshot(tables)
    return {
      ...cfg,
      imported,
      wallMs: Math.round(wallMs),
      rowsPerSec: Math.round(imported / (wallMs / 1000)),
      peakRssMb: Math.round(peakRss / 2 ** 20),
      parseMs: Math.round(timings.parseMs),
      insertMs: Math.round(timings.insertMs),
      ...snap,
    }
  } finally {
    clearInterval(sampler)
    for (const t of tables) {
      await executeQuery(`DROP TABLE IF EXISTS ${t}`).catch(() => {})
    }
  }
}

function sweepConfigs(a: BenchArgs): BenchConfig[] {
  const out: BenchConfig[] = []
  for (const batch of [100000, 250000, 500000]) {
    for (const pipeline of [true, false]) {
      out.push({ rows: a.rows, batch, pipeline, concurrency: 1, file: a.file, seed: a.seed })
    }
  }
  return out
}

function printReport(results: BenchResult[]): void {
  console.table(results.map(r => ({
    batch: r.batch,
    pipeline: r.pipeline ? 'on' : 'off',
    conc: r.concurrency,
    imported: r.imported,
    'rows/s': r.rowsPerSec,
    'wall(ms)': r.wallMs,
    'peakRSS(MB)': r.peakRssMb,
    'parse(ms)': r.parseMs,
    'insert(ms)': r.insertMs,
    parts: r.activeParts,
    merges: r.activeMerges,
  })))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const configs: BenchConfig[] = args.sweep
    ? sweepConfigs(args)
    : [{ rows: args.rows, batch: args.batch, pipeline: args.pipeline, concurrency: args.concurrency, file: args.file, seed: args.seed }]

  const results: BenchResult[] = []
  for (const cfg of configs) {
    console.log(`▶ batch=${cfg.batch} pipeline=${cfg.pipeline ? 'on' : 'off'} concurrency=${cfg.concurrency} rows=${cfg.rows}${cfg.file ? ` file=${cfg.file}` : ''}`)
    results.push(await runBenchmark(cfg))
  }

  printReport(results)
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(results, null, 2))
    console.log(`Wrote ${args.json}`)
  }
  await getClient().close()
}

// Run main() only when executed directly (`npx tsx scripts/benchmark-import.ts`),
// not when imported by the test suite.
if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main().catch(err => { console.error(err); process.exit(1) })
}
```

- [ ] **Step 2: Typecheck and re-run the benchmark unit tests**

Run: `npm run typecheck`
Expected: exits 0.

Run: `npm test -- __tests__/benchmark-import.test.ts`
Expected: PASS — importing the file still does not run `main()` (the `pathToFileURL` guard is false under Vitest).

- [ ] **Step 3: Verify the `@/` alias resolves under tsx (spec §9 risk)**

Run: `npx tsx -e "import('@/lib/upload-processor').then(m => console.log('ok', typeof m.streamCredentialsToTable))"`
Expected: prints `ok function`.

If instead it errors with `Cannot find module '@/lib/...'`, apply the fallback: install `vite-node` (`npm i -D vite-node`) and run the benchmark with `npx vite-node scripts/benchmark-import.ts -- <flags>` (Vite + the existing `vite-tsconfig-paths` resolve `@/`). Note whichever runner works in the README task below.

- [ ] **Step 4: Manual smoke run against local ClickHouse**

Pre-req: `npm run docker:infra` (ClickHouse up and healthy) and a `.env.local` with `CLICKHOUSE_*` set.

Run: `npx tsx scripts/benchmark-import.ts --rows 50000`
Expected: a one-row `console.table` with non-zero `rows/s` and `imported ≈ 45000` (synthetic mix drops ~10% junk). Afterward confirm cleanup:

Run: `docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM system.tables WHERE database='ulp' AND name LIKE 'bench_%'"`
Expected: `0` (the bench table was dropped).

If ClickHouse is not available in this environment, record that Step 4 is deferred to a machine with the stack up and proceed.

- [ ] **Step 5: Commit**

```bash
git add scripts/benchmark-import.ts
git commit -m "feat(bench): runnable import benchmark with throwaway table, sweep, and metrics"
```

---

### Task 6: Document the new knobs and benchmark

**Files:**
- Modify: `README.md`
- Test: `__tests__/import-throughput-docs.test.ts` (create)

- [ ] **Step 1: Write the failing docs contract**

Create `__tests__/import-throughput-docs.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

describe('README import throughput docs', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

  it('documents the pipelining kill-switch', () => {
    expect(readme).toContain('IMPORT_PIPELINE')
  })
  it('documents configurable upload concurrency', () => {
    expect(readme).toContain('UPLOAD_CONCURRENCY')
  })
  it('documents the benchmark script', () => {
    expect(readme).toContain('scripts/benchmark-import.ts')
  })
})
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- __tests__/import-throughput-docs.test.ts`
Expected: FAIL — the README does not mention these yet.

- [ ] **Step 3: Add a README section**

Add this section to `README.md` (under the import/operations documentation):

```markdown
### Import throughput tuning

Imports overlap parsing with ClickHouse inserts (pipelining) to cut idle wait
without raising peak memory beyond one extra batch. Two environment knobs:

- `IMPORT_PIPELINE` — `off` disables pipelining and reverts to strictly
  sequential parse→insert (kill-switch / A-B testing). Default: on.
- `UPLOAD_CONCURRENCY` — number of files processed at once. Default `1`.
  Raising it multiplies peak memory (each file holds its own in-flight batch and
  its own dedup set), so only raise it on hardware with memory headroom.

Batch size stays a fixed 100,000 rows; inserts remain synchronous, in-order, and
retryable (unchanged from the resilience work).

**Benchmark** (needs local ClickHouse — `npm run docker:infra`):

    npx tsx scripts/benchmark-import.ts --rows 200000          # one run
    npx tsx scripts/benchmark-import.ts --sweep --json b.json  # batch × pipeline matrix
    npx tsx scripts/benchmark-import.ts --file ./sample.txt    # real local sample

It imports into a throwaway `ulp.bench_*` table (dropped after each run) and
never touches `ulp.credentials` or `ulp.sources`.
```

(If Task 5 Step 3 required the `vite-node` fallback, replace `npx tsx` with `npx vite-node` in the three commands above.)

- [ ] **Step 4: Run the docs test and confirm GREEN**

Run: `npm test -- __tests__/import-throughput-docs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md __tests__/import-throughput-docs.test.ts
git commit -m "docs: document IMPORT_PIPELINE, UPLOAD_CONCURRENCY, and the import benchmark"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all prior tests plus the new `import-pipeline`, `benchmark-import`, `import-throughput-docs`, and extended `upload-queue` / `insert-batch-dedup` tests pass. If the known parallel SQLite `users.email` fixture race appears, re-run the offending file alone, then re-run the suite.

- [ ] **Step 2: Typecheck, lint, build**

```bash
npm run typecheck
npm run lint
npm run build
```
Expected: all exit 0.

- [ ] **Step 3: Confirm the resilience invariants are intact**

Run: `npm test -- __tests__/insert-batch-dedup.test.ts __tests__/upload-processor.test.ts`
Expected: PASS — `async_insert`/`wait_for_async_insert` still `undefined`, `max_insert_threads === 2`, `UPLOAD_BATCH_SIZE === 100_000`, and `parseULPStream` still receives `UPLOAD_BATCH_SIZE` as its third argument.

- [ ] **Step 4: Review the diff**

```bash
git diff --stat origin/main...HEAD
git diff --check
```
Expected: only `lib/upload-queue.ts`, `lib/upload-processor.ts`, `scripts/benchmark-import.ts`, the four test files, `README.md`, and the spec/plan docs changed; no whitespace errors.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(import): verification fixups for throughput foundation"
```

---

## Self-review notes (author)

- **Spec coverage:** pipelining (Task 3), `UPLOAD_CONCURRENCY` (Task 1), benchmark synthetic+`--file` with throwaway table & guard (Tasks 4–5), `IMPORT_PIPELINE` kill-switch (Task 3), `insertBatch` table param (Task 2), parse/insert timing split (Task 3 `timings` + Task 5), peak-heap sampling + parts/merges snapshot (Task 5), docs (Task 6), success criteria verified (Task 7). All spec §3 in-scope items map to a task; all §3 out-of-scope items are absent.
- **Invariant safety:** Tasks 2–3 keep the insert settings and `UPLOAD_BATCH_SIZE` assertions green; the `processZipBuffer` failure-propagation tests cover the new wrapper→core abort path.
- **Type consistency:** `streamCredentialsToTable` / `StreamToTableOptions` / `StreamToTableResult` names and the `insertBatch(creds, breach, retryOptions?, { table })` 4-arg shape are identical across Tasks 2, 3, and 5.
```
