# Live Ingest Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface, live during imports, a parser-rows/s vs insert-rows/s bottleneck verdict plus ClickHouse merge-pressure (active parts, merges, memory).

**Architecture:** A single-process module store (`lib/ingest-metrics.ts`, same pattern as `getCurrentJob`) is updated per batch by the import core via an injected `onBatchMetrics` callback wired in `processTextStream` (covers HTTP + inbox; the benchmark passes no callback). A `GET /api/monitoring/ingest-health` route returns the store snapshot + live `system.parts`/`system.merges`/`system.metrics`. An `IngestHealthPanel` on `/upload` polls it.

**Tech Stack:** Next.js 15, React 19, TypeScript, Vitest (node env), `@clickhouse/client`, lucide-react.

**Spec:** [docs/superpowers/specs/2026-06-24-live-ingest-health-design.md](../specs/2026-06-24-live-ingest-health-design.md)

**Execution isolation:** Run on a branch, e.g. `feat/live-ingest-health` (off current `main`). End commits with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push unless asked. `.worktrees/` is excluded from `npm test` now, so the suite should be fully green.

---

### Task 1: `lib/ingest-metrics.ts` store

**Files:**
- Create: `lib/ingest-metrics.ts`
- Test: `__tests__/ingest-metrics.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/ingest-metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { startIngest, recordBatch, finishIngest, getIngestMetrics } from '@/lib/ingest-metrics'

describe('ingest-metrics', () => {
  it('startIngest sets filename and zeroes counters', () => {
    startIngest('a.txt')
    const m = getIngestMetrics()
    expect(m.filename).toBe('a.txt')
    expect(m.imported).toBe(0)
    expect(m.tierDropped).toBe(0)
    expect(m.bottleneck).toBeNull()
  })

  it('recordBatch computes rates, accumulates, and flags insert-bound', () => {
    startIngest('a.txt')
    recordBatch({ rows: 100_000, parseMs: 50, insertMs: 200, tierDropped: 10 })
    const m = getIngestMetrics()
    expect(m.insertRowsPerSec).toBe(500_000)   // 100k / 200ms * 1000
    expect(m.parserRowsPerSec).toBe(2_000_000) // 100k / 50ms  * 1000
    expect(m.bottleneck).toBe('insert')         // insert rate is lower
    expect(m.imported).toBe(100_000)
    expect(m.tierDropped).toBe(10)
    expect(m.batchSize).toBe(100_000)
    expect(m.lastBatchInsertMs).toBe(200)
  })

  it('treats ~0 parseMs as parser-hidden (insert-bound), never Infinity', () => {
    startIngest('a.txt')
    recordBatch({ rows: 100_000, parseMs: 0, insertMs: 200, tierDropped: 0 })
    const m = getIngestMetrics()
    expect(Number.isFinite(m.parserRowsPerSec)).toBe(true)
    expect(m.bottleneck).toBe('insert')
  })

  it('flags parse-bound when the parser is genuinely slower', () => {
    startIngest('a.txt')
    recordBatch({ rows: 100_000, parseMs: 500, insertMs: 50, tierDropped: 0 })
    expect(getIngestMetrics().bottleneck).toBe('parse')
  })

  it('finishIngest returns to idle', () => {
    startIngest('a.txt')
    recordBatch({ rows: 100_000, parseMs: 50, insertMs: 200, tierDropped: 0 })
    finishIngest()
    const m = getIngestMetrics()
    expect(m.filename).toBeNull()
    expect(m.bottleneck).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm test -- __tests__/ingest-metrics.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the store**

Create `lib/ingest-metrics.ts`:

```ts
/**
 * Live ingest metrics — single-process, in-memory (same pattern as
 * getCurrentJob in lib/upload-queue.ts). Updated per batch by the import core
 * and read by GET /api/monitoring/ingest-health. Holds the CURRENT import's
 * rolling parser/insert rates so the UI can show the bottleneck live.
 */

const EMA_ALPHA = 0.3          // smoothing for the rolling rates
const RATE_CAP = 1e9           // guard so a ~0 ms batch can't yield Infinity
const PARSE_HIDDEN_MS = 2      // below this, the parse was hidden under the insert

export interface IngestMetrics {
  filename: string | null
  batchSize: number
  parserRowsPerSec: number
  insertRowsPerSec: number
  lastBatchInsertMs: number
  imported: number
  tierDropped: number
  bottleneck: 'parse' | 'insert' | null
  updatedAt: number
}

function idle(): IngestMetrics {
  return {
    filename: null, batchSize: 0, parserRowsPerSec: 0, insertRowsPerSec: 0,
    lastBatchInsertMs: 0, imported: 0, tierDropped: 0, bottleneck: null, updatedAt: 0,
  }
}

let state: IngestMetrics = idle()

function rate(rows: number, ms: number): number {
  return Math.min(RATE_CAP, Math.round((rows / Math.max(ms, 1)) * 1000))
}

export function startIngest(filename: string): void {
  state = { ...idle(), filename, updatedAt: Date.now() }
}

export function recordBatch(m: {
  rows: number; parseMs: number; insertMs: number; tierDropped: number
}): void {
  const pInst = rate(m.rows, m.parseMs)
  const iInst = rate(m.rows, m.insertMs)
  // First batch (rate still 0) seeds the EMA with the instantaneous value.
  const prevP = state.parserRowsPerSec || pInst
  const prevI = state.insertRowsPerSec || iInst
  const parserRowsPerSec = Math.round(EMA_ALPHA * pInst + (1 - EMA_ALPHA) * prevP)
  const insertRowsPerSec = Math.round(EMA_ALPHA * iInst + (1 - EMA_ALPHA) * prevI)
  // The parser only "limits" when its per-batch time is non-trivial; under
  // pipelining parseMs≈0 means parsing was hidden under the insert → insert-bound.
  const parserLimiting = m.parseMs >= PARSE_HIDDEN_MS
  const bottleneck: 'parse' | 'insert' =
    parserLimiting && parserRowsPerSec < insertRowsPerSec ? 'parse' : 'insert'
  state = {
    filename: state.filename,
    batchSize: m.rows,
    parserRowsPerSec,
    insertRowsPerSec,
    lastBatchInsertMs: Math.round(m.insertMs),
    imported: state.imported + m.rows,
    tierDropped: state.tierDropped + m.tierDropped,
    bottleneck,
    updatedAt: Date.now(),
  }
}

export function finishIngest(): void {
  state = { ...state, filename: null, bottleneck: null, updatedAt: Date.now() }
}

export function getIngestMetrics(): IngestMetrics {
  return { ...state }
}
```

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: `npm test -- __tests__/ingest-metrics.test.ts`
Expected: PASS — all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/ingest-metrics.ts __tests__/ingest-metrics.test.ts
git commit -m "feat(observability): live ingest-metrics store"
```

---

### Task 2: Import-core `onBatchMetrics` + `processTextStream` wiring

**Files:**
- Modify: `lib/upload-processor.ts` (`StreamToTableOptions`, the `streamCredentialsToTable` loop, `processTextStream`)
- Test: `__tests__/import-pipeline.test.ts`, `__tests__/upload-processor.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/import-pipeline.test.ts` (it already mocks `@/lib/clickhouse` and `@/lib/ulp-parser`):

```ts
describe('onBatchMetrics', () => {
  it('fires once per batch with rows/parseMs/insertMs/tierDropped', async () => {
    parser.batches = [
      { credentials: [{ url:'', email:'a@a', password:'p', domain:'a', source_file:'b' }],
        rejected: 0, breakdown: { ...emptyBreakdown(), tier_dropped: 3 } },
    ]
    h.insert.mockResolvedValue(undefined)
    const calls: any[] = []

    const { streamCredentialsToTable } = await import('@/lib/upload-processor')
    await streamCredentialsToTable(webStream(), 'b.txt', {
      table: 'ulp.bench_x', pipeline: true,
      onBatchMetrics: (m) => calls.push(m),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].rows).toBe(1)
    expect(calls[0].tierDropped).toBe(3)
    expect(typeof calls[0].parseMs).toBe('number')
    expect(typeof calls[0].insertMs).toBe('number')
  })
})
```

Append to `__tests__/upload-processor.test.ts`:

```ts
describe('live ingest-metrics wiring', () => {
  it('processTextStream brackets the import with startIngest/finishIngest', async () => {
    vi.resetModules()
    const ig = { startIngest: vi.fn(), recordBatch: vi.fn(), finishIngest: vi.fn(),
                 getIngestMetrics: vi.fn() }
    vi.doMock('@/lib/ingest-metrics', () => ig)
    vi.doMock('@/lib/ulp-parser', async () => {
      const actual = await vi.importActual<typeof import('@/lib/ulp-parser')>('@/lib/ulp-parser')
      return {
        ...actual,
        parseULPStream: async function* () {
          yield { credentials: [], rejected: 0, breakdown: actual.makeRejectionMap() }
        },
      }
    })
    try {
      const { processTextStream } = await import('@/lib/upload-processor')
      const { Readable } = await import('node:stream')
      await processTextStream(Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>, 'live.txt')
      expect(ig.startIngest).toHaveBeenCalledWith('live.txt')
      expect(ig.finishIngest).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('@/lib/ingest-metrics')
      vi.doUnmock('@/lib/ulp-parser')
      vi.resetModules()
    }
  })
})
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm test -- __tests__/import-pipeline.test.ts __tests__/upload-processor.test.ts`
Expected: FAIL — `onBatchMetrics` ignored; `startIngest`/`finishIngest` not called.

- [ ] **Step 3: Add `onBatchMetrics` to the core**

In `lib/upload-processor.ts`, add to `StreamToTableOptions` (next to `onProgress`):

```ts
  /** Per-batch live metrics (ingest-health panel). Not passed by the benchmark. */
  onBatchMetrics?: (m: { rows: number; parseMs: number; insertMs: number; tierDropped: number }) => void
```

In `streamCredentialsToTable`, replace the loop's timing so per-batch values are always available and the callback fires. The loop becomes:

```ts
  try {
    while (true) {
      const tParse = performance.now()
      const { value: batch, done } = await pending
      const batchParseMs = performance.now() - tParse
      if (timings) timings.parseMs += batchParseMs
      if (done) break

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

      const tInsert = performance.now()
      await insertBatch(creds, breach_name, undefined, { table })
      const batchInsertMs = performance.now() - tInsert
      if (timings) timings.insertMs += batchInsertMs

      imported += creds.length
      options.onProgress?.(imported, skipped)
      options.onBatchMetrics?.({
        rows: creds.length,
        parseMs: batchParseMs,
        insertMs: batchInsertMs,
        tierDropped: batch.breakdown.tier_dropped ?? 0,
      })

      if (!pipeline) pending = gen.next()
    }
  } finally {
    await gen.return(undefined).catch(() => {})
    await Promise.resolve(pending).catch(() => {})
  }
```

(The only changes from the current loop: the two `performance.now()` measurements are now unconditional and stored in `batchParseMs`/`batchInsertMs`, still added to `timings` when present, and the new `onBatchMetrics?.(...)` call after `onProgress`.)

- [ ] **Step 4: Wire `processTextStream`**

In `lib/upload-processor.ts`, add the import:

```ts
import { startIngest, recordBatch, finishIngest } from '@/lib/ingest-metrics'
```

In `processTextStream`, wrap the `streamCredentialsToTable` call so the live store is bracketed (after the re-upload guard, so skipped re-imports don't start a phantom ingest):

```ts
  startIngest(filename)
  let result
  try {
    result = await streamCredentialsToTable(stream, filename, {
      table:      'ulp.credentials',
      batchSize:  UPLOAD_BATCH_SIZE,
      pipeline:   importPipelineEnabled(),
      filterOn,
      dropPolicy: softPolicy,
      breachName: breach_name,
      shouldHardDrop,
      onProgress: (imp, skp) => {
        if (jobId)   updateJob(jobId, { imported: imp, skipped: skp })
        if (onBatch) onBatch(imp)
      },
      onBatchMetrics: recordBatch,
    })
  } finally {
    finishIngest()
  }

  const { imported, skipped, tierDropped, rejection_breakdown } = result
```

(This replaces the existing `const { imported, skipped, tierDropped, rejection_breakdown } = await streamCredentialsToTable(stream, filename, { … })` call — keep the same options it already passed, add `onBatchMetrics: recordBatch`, and bracket with `startIngest`/`finishIngest`.)

- [ ] **Step 5: Run the tests and confirm GREEN**

Run: `npm test -- __tests__/import-pipeline.test.ts __tests__/upload-processor.test.ts __tests__/insert-batch-dedup.test.ts`
Expected: PASS — including the existing pipelining/processor/dedup suites.

Run: `npm run typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/upload-processor.ts __tests__/import-pipeline.test.ts __tests__/upload-processor.test.ts
git commit -m "feat(observability): emit per-batch metrics to the live ingest store"
```

---

### Task 3: `GET /api/monitoring/ingest-health` route

**Files:**
- Create: `app/api/monitoring/ingest-health/route.ts`
- Test: `__tests__/ingest-health-route.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/ingest-health-route.test.ts`:

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
beforeEach(() => mockEQ.mockReset())

describe('GET /api/monitoring/ingest-health', () => {
  it('returns the store snapshot + clickhouse parts/merges/memory', async () => {
    mockEQ
      .mockResolvedValueOnce([{ c: 42 }])    // parts
      .mockResolvedValueOnce([{ c: 3 }])     // merges
      .mockResolvedValueOnce([{ v: 8_000_000_000 }]) // memory
    const res = await GET({} as any)
    const json = await res.json()
    expect(json.app.bottleneck).toBe('insert')
    expect(json.clickhouse.activeParts).toBe(42)
    expect(json.clickhouse.partsThreshold).toBe(1000)
    expect(json.clickhouse.activeMerges).toBe(3)
    expect(json.clickhouse.memoryBytes).toBe(8_000_000_000)
  })

  it('degrades to zeros + note when system tables are unavailable', async () => {
    mockEQ.mockRejectedValue(new Error('UNKNOWN_TABLE'))
    const res = await GET({} as any)
    const json = await res.json()
    expect(json.clickhouse.activeParts).toBe(0)
    expect(json.clickhouse.note).toBeTruthy()
    expect(json.app.filename).toBe('x.txt')
  })
})
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm test -- __tests__/ingest-health-route.test.ts`
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Create the route**

Create `app/api/monitoring/ingest-health/route.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { executeQuery } from '@/lib/clickhouse'
import { getIngestMetrics } from '@/lib/ingest-metrics'

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

  try {
    const [parts, merges, mem] = [
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
    ]
    clickhouse = {
      activeParts:    Number(parts[0]?.c ?? 0),
      partsThreshold: PARTS_THRESHOLD,
      activeMerges:   Number(merges[0]?.c ?? 0),
      memoryBytes:    Number(mem[0]?.v ?? 0),
    }
  } catch (error) {
    const msg = String(error)
    clickhouse.note = msg.includes('UNKNOWN_TABLE')
      ? 'ClickHouse system tables unavailable'
      : 'failed to read ClickHouse metrics'
  }

  return NextResponse.json({ app: getIngestMetrics(), clickhouse })
}
```

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: `npm test -- __tests__/ingest-health-route.test.ts`
Expected: PASS — both tests.

Run: `npm run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/api/monitoring/ingest-health/route.ts __tests__/ingest-health-route.test.ts
git commit -m "feat(observability): ingest-health route (store + parts/merges/memory)"
```

---

### Task 4: `IngestHealthPanel` on `/upload`

**Files:**
- Create: `components/ingest-health-panel.tsx`
- Modify: `app/upload/page.tsx` (mount it next to `QueueStatusPanel`)

Note: Vitest runs in the `node` environment with no React renderer, so — exactly like the existing `QueueStatusPanel` — this panel has no unit test. It is verified by typecheck + build; its data is already covered by Tasks 1 and 3.

- [ ] **Step 1: Create the panel component**

Create `components/ingest-health-panel.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity, Database, GitMerge, Gauge } from "lucide-react"

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
  const { app, clickhouse } = data
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
          {clickhouse.note && <span className="text-xs text-muted-foreground">({clickhouse.note})</span>}
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Mount it on the upload page**

Open `app/upload/page.tsx`. Add the import near the top (with the other component imports):

```ts
import { IngestHealthPanel } from "@/components/ingest-health-panel"
```

Find where `<QueueStatusPanel />` is rendered in the JSX and add `<IngestHealthPanel />` immediately after it:

```tsx
      <QueueStatusPanel />
      <IngestHealthPanel />
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck` → exit 0.
Run: `npx eslint components/ingest-health-panel.tsx app/upload/page.tsx` → clean. (If `Activity`/`Database`/`GitMerge`/`Gauge` are reported missing from `lucide-react`, confirm names with `node -e "console.log(Object.keys(require('lucide-react')).filter(n=>/Activity|Database|GitMerge|Gauge/.test(n)))"` and substitute the closest existing icon.)

- [ ] **Step 4: Commit**

```bash
git add components/ingest-health-panel.tsx app/upload/page.tsx
git commit -m "feat(observability): IngestHealthPanel (parser/insert rates + parts/merges/memory) on /upload"
```

---

### Task 5: Full verification

**Files:** none.

- [ ] **Step 1: Full suite + typecheck + lint + build**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```
Expected: all green (the suite no longer collects `.worktrees/`, so 0 failures), build compiles.

- [ ] **Step 2: Review the diff**

```bash
git diff --stat main...HEAD
git diff --check main...HEAD
```
Expected: only `lib/ingest-metrics.ts`, `lib/upload-processor.ts`, `app/api/monitoring/ingest-health/route.ts`, `components/ingest-health-panel.tsx`, `app/upload/page.tsx`, the test files, and the spec/plan docs changed; no whitespace errors.

---

## Self-review notes (author)

- **Spec coverage:** store (Task 1), per-batch hook + benchmark-safe wiring (Task 2), route with graceful degradation (Task 3), panel on `/upload` (Task 4), verification (Task 5). All §3 in-scope items map to a task; §3 out-of-scope items (history persistence, touching existing observability, `/inbox` copy, benchmark metrics) are absent.
- **Type consistency:** the `onBatchMetrics` payload `{ rows, parseMs, insertMs, tierDropped }`, the `IngestMetrics` shape, and the route's `{ app, clickhouse }` response are identical across the store, the core, the route, and the panel.
- **Benchmark safety:** `streamCredentialsToTable` only touches the store via the injected `onBatchMetrics`; the benchmark passes none, asserted by the existing benchmark/pipelining tests staying green.
- **Pipelining nuance:** Task 1's `parseMs≈0 → insert-bound` test and the panel's `fmtRate` `1e8 → "—"` cap together handle the hidden-parse case.
