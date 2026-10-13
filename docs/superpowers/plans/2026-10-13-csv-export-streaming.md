# CSV Export Beyond 10,000 Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `csv`, `ulp`, `userpass` and `ndjson` exports stream up to 1,000,000 rows with a live row count in the page, `json` keeps 10,000, and the daily dedup stats pass skips itself on a nearly full disk.

**Architecture:** A pure module (`lib/export-stream.ts`) turns ClickHouse's row batches into a pull-based `ReadableStream` (header, one line per row, cap, backpressure, cancel). The export route starts the same SQL through `getClient().query(... JSONEachRow ...)`, answers once ClickHouse has begun to answer, and hands the stream to the browser. A second pure module (`lib/export-stream-client.ts`) reads the stream in the page, counting rows. The dedup tick asks `checkDiskHeadroom()` before its full-table `GROUP BY`.

**Tech Stack:** TypeScript, Next.js route handlers (Web `ReadableStream`), `@clickhouse/client` result-set streaming, vitest.

Spec: `docs/superpowers/specs/2026-10-13-csv-export-streaming-design.md` (read it first; this plan implements it and changes none of its decisions).

## Global Constraints

- Caps, exactly: `EXPORT_ROW_CAP = 1_000_000` (streamed formats), `JSON_EXPORT_ROW_CAP = 10_000` (`json`). The streamed formats are `csv`, `ndjson`, `ulp`, `userpass`; an unknown format has always meant `ulp` and stays so. `emails`, `domains`, `hcmask`, `wordlist` and `spray` are not touched.
- A streamed response carries `X-Export-Cap` and the imported-window headers, and NOT `X-Export-Rows` or `X-Export-Truncated`. The `json` response keeps all its headers.
- Streamed SQL: the same inner/outer query as today with `LIMIT 1000000` and `SETTINGS ..., max_execution_time = 600`; `json` keeps `LIMIT 10001`.
- Every line ends with `\n`, the last one included. `csv` starts with the header line. The CSV formula guard (`csvCell`, `csv_guard: false` to disable) is unchanged.
- The response is created after `getClient().query()` has resolved, so a failing query is HTTP 500 `{ success: false, error: 'Export failed' }`. The request's abort signal is passed to ClickHouse.
- The page counts rows as `newlines - (csv ? 1 : 0)` and treats `rows >= cap` as possibly cut (the mark does not move).
- Dedup guard: `DEDUP_STATS_MIN_FREE_BYTES`, default 40 GiB (42,949,672,960); a failing free-space check also skips; the skip result is `{ total: 0, excess: 0, applied: false, skipped: true }`.
- The repository is public: no real address, file name or search term anywhere. Use `example.com` and generic words.
- No schema change, no migration, no new index.
- One commit per task, tests red before green. `npx tsc --noEmit` and the whole `npx vitest run` must pass before the deploy. Tag the running image as the rollback BEFORE building. Work in a worktree of the branch `csv-export-streaming`; never run `docker compose build` from a worktree.

## File Structure

Create:
- `lib/export-stream.ts`: caps, formats, line formatters, `createExportStream`.
- `lib/export-stream-client.ts`: `readCountedStream` for the page.
- `__tests__/export-stream.test.ts`, `__tests__/export-stream-client.test.ts`
- `__tests__/export-route-stream.test.ts`: the POST handler with a mocked ClickHouse stream.
- `__tests__/credentials-page-export-stream.test.ts`: source-text test in the repo's existing style.
- `__tests__/content-dedup-stats-guard.test.ts`
- `__tests__/export-stream.live.test.ts`: read-only, skipped unless `ECS_LIVE=1`.

Modify:
- `app/api/export/route.ts`: one shared SQL builder, the streamed path, the `json` path on its own cap.
- `app/credentials/page.tsx`: the reader, the running count, the toast.
- `lib/content-dedup.ts`: `dedupStatsMinFreeBytes`, `dedupStatsHeadroomRefusal`, the guard in `runContentDedupTick`.
- `__tests__/export-route.test.ts`, `__tests__/export-route-imported-range.test.ts`, `__tests__/export-route-csv-guard.test.ts`, `__tests__/imported-range-credentials-page.test.ts`: the tests that pinned the old in-memory CSV path.
- `README.md`, `.env.example`, `docker-compose.yml`, `docs/superpowers/specs/2026-10-13-csv-export-streaming-design.md` (status line).

---

### Task 1: The pure stream module

**Files:**
- Create: `lib/export-stream.ts`, `__tests__/export-stream.test.ts`

**Interfaces:**
- Produces: `EXPORT_ROW_CAP`, `JSON_EXPORT_ROW_CAP`, `StreamFormat`, `STREAM_FORMATS`, `ExportRow`, `CSV_COLUMNS`, `csvHeaderLine(): string`, `exportLine(format: StreamFormat, row: ExportRow, guard?: boolean): string`, `createExportStream(batches: AsyncIterable<ExportRow[]>, opts: { format: StreamFormat; guard?: boolean; cap?: number }): ReadableStream<Uint8Array>`.

- [ ] **Step 1: Set up the worktree**

```bash
cd /home/cole/ulp-suite && git fetch -q origin && git switch main && git merge --ff-only origin/main
git worktree add .claude/worktrees/csv-export-streaming -b csv-export-streaming origin/main
cp -al node_modules .claude/worktrees/csv-export-streaming/node_modules
```

Expected: the worktree exists and `ls .claude/worktrees/csv-export-streaming/node_modules | wc -l` prints about 427 (the primary checkout's `node_modules` matches main's lockfile since 2026-10-13). Run every later command from `/home/cole/ulp-suite/.claude/worktrees/csv-export-streaming`. The plan's own `Create` blocks are written out with `node extract-plan.cjs <plan> <path>...` (a ten-line script that writes the fenced block after a `Create \`path\`:` line; the `Script` blocks go to a scratch directory).

- [ ] **Step 2: Write the failing test**

Create `__tests__/export-stream.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import {
  EXPORT_ROW_CAP, JSON_EXPORT_ROW_CAP, STREAM_FORMATS, CSV_COLUMNS, csvHeaderLine, exportLine, createExportStream, type ExportRow,
} from '@/lib/export-stream'

const row = (n: number, over: ExportRow = {}): ExportRow => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`, source_file: 'f.txt',
  breach_name: '', country_tier: '', login_type: 'email', password_length: 4, password_mask: 'alphanumeric', url_scheme: 'https',
  is_corporate_email: 0, email_domain: 'mail.test', url_host: `s${n}.example`, password_entropy_band: 'weak', imported_at: '2026-10-13 01:00:00', ...over,
})

type Log = { pulled: number; closed: boolean }
const fresh = (): Log => ({ pulled: 0, closed: false })

/** A source of batches that counts the batches read and notes when it was closed; failAt throws instead of yielding that batch. */
function source(batches: ExportRow[][], log: Log, failAt = -1): AsyncIterable<ExportRow[]> {
  return (async function* () {
    try {
      for (let i = 0; i < batches.length; i++) {
        if (i === failAt) throw new Error('boom')
        log.pulled++
        yield batches[i]
      }
    } finally {
      log.closed = true
    }
  })()
}
const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

describe('the caps and the formats', () => {
  test('a million rows for the streamed formats, ten thousand for json', () => {
    expect(EXPORT_ROW_CAP).toBe(1_000_000)
    expect(JSON_EXPORT_ROW_CAP).toBe(10_000)
    expect([...STREAM_FORMATS]).toEqual(['csv', 'ndjson', 'ulp', 'userpass'])
  })
})

describe('csvHeaderLine and exportLine', () => {
  test('the csv header names the 16 columns in the export order', () => {
    expect(csvHeaderLine()).toBe(
      'url,email,password,domain,source_file,breach_name,country_tier,login_type,password_length,password_mask,url_scheme,is_corporate_email,email_domain,url_host,password_entropy_band,imported_at\n',
    )
    expect(CSV_COLUMNS).toHaveLength(16)
  })

  test('a csv row quotes every cell, doubles quotes and ends with a newline', () => {
    expect(exportLine('csv', row(1, { password: 'a"b' }))).toBe(
      '"https://s1.example/login","u1@mail.test","a""b","s1.example","f.txt","","","email","4","alphanumeric","https","0","mail.test","s1.example","weak","2026-10-13 01:00:00"\n',
    )
  })

  test('the formula guard puts a quote in front of = + - @, and csv_guard false removes it', () => {
    expect(exportLine('csv', row(1, { password: '=1+1', email: '-5', url: '@x' }))).toContain(`"'=1+1"`)
    expect(exportLine('csv', row(1, { password: '=1+1' }), false)).toContain('"=1+1"')
    expect(exportLine('csv', row(1, { password: '=1+1' }), false)).not.toContain(`"'=1+1"`)
  })

  test('ulp, userpass and ndjson are one newline-terminated line per row', () => {
    const r = row(2)
    expect(exportLine('ulp', r)).toBe('https://s2.example/login:u2@mail.test:pw2\n')
    expect(exportLine('userpass', r)).toBe('u2@mail.test:pw2\n')
    expect(exportLine('ndjson', r)).toBe(JSON.stringify(r) + '\n')
  })

  test('the formula guard is for csv only', () => {
    const r = row(3, { password: '=cmd' })
    expect(exportLine('ulp', r)).toContain(':=cmd\n')
    expect(exportLine('userpass', r)).toBe('u3@mail.test:=cmd\n')
  })
})

describe('createExportStream', () => {
  test('csv: the header first, then every row, newline-terminated', async () => {
    const out = await text(createExportStream(source([[row(1), row(2)], [row(3)]], fresh()), { format: 'csv' }))
    const lines = out.split('\n')
    expect(lines).toHaveLength(5) // header + 3 rows + the empty piece after the last newline
    expect(lines[0]).toBe(csvHeaderLine().trimEnd())
    expect(lines[3]).toContain('u3@mail.test')
    expect(out.endsWith('\n')).toBe(true)
  })

  test('the other formats have no header line', async () => {
    const out = await text(createExportStream(source([[row(1), row(2)]], fresh()), { format: 'userpass' }))
    expect(out).toBe('u1@mail.test:pw1\nu2@mail.test:pw2\n')
  })

  test('an empty source gives only the csv header, or nothing', async () => {
    expect(await text(createExportStream(source([], fresh()), { format: 'csv' }))).toBe(csvHeaderLine())
    expect(await text(createExportStream(source([], fresh()), { format: 'ulp' }))).toBe('')
  })

  test('empty batches in between do not stall it', async () => {
    const out = await text(createExportStream(source([[], [], [row(1)], []], fresh()), { format: 'userpass' }))
    expect(out).toBe('u1@mail.test:pw1\n')
  })

  test('the cap stops it exactly, in the middle of a batch, and closes the source', async () => {
    const log = fresh()
    const out = await text(createExportStream(source([[row(1), row(2)], [row(3), row(4)], [row(5)]], log), { format: 'userpass', cap: 3 }))
    expect(out.split('\n').filter(Boolean)).toHaveLength(3)
    expect(out).toContain('u3@mail.test')
    expect(out).not.toContain('u4@mail.test')
    expect(log.closed).toBe(true)
    expect(log.pulled).toBe(2)
  })

  test('cap 0 writes the csv header and reads nothing', async () => {
    const log = fresh()
    expect(await text(createExportStream(source([[row(1)]], log), { format: 'csv', cap: 0 }))).toBe(csvHeaderLine())
    expect(log.pulled).toBe(0)
  })

  test('it reads lazily: one chunk read does not drain a long source', async () => {
    const log = fresh()
    const many = Array.from({ length: 200 }, (_, i) => [row(i)])
    const reader = createExportStream(source(many, log), { format: 'userpass' }).getReader()
    await reader.read()
    expect(log.pulled).toBeLessThan(10)
    await reader.cancel()
  })

  test('cancel stops the source', async () => {
    const log = fresh()
    const reader = createExportStream(source(Array.from({ length: 50 }, (_, i) => [row(i)]), log), { format: 'userpass' }).getReader()
    await reader.read()
    await reader.cancel()
    expect(log.closed).toBe(true)
  })

  test('an error in the source errors the stream', async () => {
    const log = fresh()
    const stream = createExportStream(source([[row(1)], [row(2)], [row(3)]], log, 1), { format: 'userpass' })
    await expect(text(stream)).rejects.toThrow('boom')
    expect(log.closed).toBe(true)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run __tests__/export-stream.test.ts`
Expected: FAIL, "Failed to resolve import @/lib/export-stream".

- [ ] **Step 4: Write the module**

Create `lib/export-stream.ts`:

```ts
/**
 * The row-level exports (csv, ulp, userpass, ndjson) as a stream (docs/superpowers/specs/2026-10-13-csv-export-streaming-design.md).
 *
 * The route used to run one query, hold every row in memory and send one string, which is why an export was capped at 10,000 rows. Now the
 * rows are written as ClickHouse produces them, no faster than the browser reads them, and the cap is a million. Pure code: the route feeds
 * it ClickHouse's batches, the tests feed it generators.
 */
import { csvCell } from '@/lib/csv-safe'

/** Rows a streamed export may hold. The response carries it in X-Export-Cap and the page counts the rows it receives against it. */
export const EXPORT_ROW_CAP = 1_000_000
/** Rows the json export may hold: it is one pretty-printed array built in memory, so it keeps the old cap. */
export const JSON_EXPORT_ROW_CAP = 10_000

export type StreamFormat = 'csv' | 'ndjson' | 'ulp' | 'userpass'
export const STREAM_FORMATS: readonly StreamFormat[] = ['csv', 'ndjson', 'ulp', 'userpass']

export type ExportRow = Record<string, unknown>

export const CSV_COLUMNS = [
  'url', 'email', 'password', 'domain', 'source_file', 'breach_name', 'country_tier', 'login_type', 'password_length', 'password_mask',
  'url_scheme', 'is_corporate_email', 'email_domain', 'url_host', 'password_entropy_band', 'imported_at',
] as const

export const csvHeaderLine = (): string => CSV_COLUMNS.join(',') + '\n'

/** One row as one newline-terminated line of the format. The formula guard (csvCell) is for csv only. */
export function exportLine(format: StreamFormat, r: ExportRow, guard = true): string {
  switch (format) {
    case 'csv': return CSV_COLUMNS.map(c => csvCell(r[c], guard)).join(',') + '\n'
    case 'ndjson': return JSON.stringify(r) + '\n'
    case 'userpass': return `${r.email}:${r.password}\n`
    case 'ulp': return `${r.url}:${r.email}:${r.password}\n`
  }
}

/**
 * The export as a pull-based stream: for csv the header line first, then one line per row, a chunk per batch, nothing queued beyond one chunk,
 * so ClickHouse is read no faster than the consumer reads. It stops after `cap` rows and closes the source (for ClickHouse that destroys the
 * stream); `cancel()` closes it too; an error in the source errors the stream.
 */
export function createExportStream(
  batches: AsyncIterable<ExportRow[]>,
  opts: { format: StreamFormat; guard?: boolean; cap?: number },
): ReadableStream<Uint8Array> {
  const cap = opts.cap ?? EXPORT_ROW_CAP
  const guard = opts.guard !== false
  const encoder = new TextEncoder()
  const iterator = batches[Symbol.asyncIterator]()
  let header = opts.format === 'csv'
  let written = 0
  let sourceDone = false

  /** Stops the source unless it already ended. */
  const closeSource = async () => {
    if (sourceDone) return
    sourceDone = true
    await iterator.return?.()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let text = header ? csvHeaderLine() : ''
        header = false
        // keep reading until there is something to send or the source ends, so an empty batch cannot leave the stream waiting
        while (text === '' && written < cap && !sourceDone) {
          const next = await iterator.next()
          if (next.done) { sourceDone = true; break }
          for (const row of next.value) {
            if (written >= cap) break
            text += exportLine(opts.format, row, guard)
            written++
          }
        }
        if (text !== '') controller.enqueue(encoder.encode(text))
        if (written >= cap || sourceDone) {
          await closeSource()
          controller.close()
        }
      } catch (err) {
        await closeSource().catch(() => {})
        controller.error(err)
      }
    },
    async cancel() {
      await closeSource()
    },
  })
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run __tests__/export-stream.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`.

```bash
git add lib/export-stream.ts __tests__/export-stream.test.ts
git commit -m "feat(export): the streamed row formats as a pull-based stream with a cap"
```

---

### Task 2: The browser reader

**Files:**
- Create: `lib/export-stream-client.ts`, `__tests__/export-stream-client.test.ts`

**Interfaces:**
- Produces: `readCountedStream(body: ReadableStream<Uint8Array>, headerLines: number, onRows?: (rows: number) => void, now?: () => number, everyMs?: number): Promise<{ chunks: Uint8Array[]; rows: number; bytes: number }>`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/export-stream-client.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { readCountedStream } from '@/lib/export-stream-client'

const enc = new TextEncoder()
function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) controller.enqueue(enc.encode(parts[i++]))
      else controller.close()
    },
  })
}
const join = (chunks: Uint8Array[]) => chunks.map(c => new TextDecoder().decode(c)).join('')

describe('readCountedStream', () => {
  test('counts the newline-terminated rows and keeps every byte', async () => {
    const read = await readCountedStream(streamOf(['a\nb\n', 'c\n']), 0)
    expect(read.rows).toBe(3)
    expect(join(read.chunks)).toBe('a\nb\nc\n')
    expect(read.bytes).toBe(6)
  })

  test('the header line of a csv is not a row', async () => {
    expect((await readCountedStream(streamOf(['h1,h2\n', 'x\ny\n']), 1)).rows).toBe(2)
  })

  test('a line split across chunks is counted once', async () => {
    expect((await readCountedStream(streamOf(['ab', 'c\nd', '\n']), 0)).rows).toBe(2)
  })

  test('an empty stream, or a header only, is zero rows and never negative', async () => {
    expect((await readCountedStream(streamOf([]), 0)).rows).toBe(0)
    expect((await readCountedStream(streamOf([]), 1)).rows).toBe(0)
    expect((await readCountedStream(streamOf(['h\n']), 1)).rows).toBe(0)
  })

  test('the progress callback is throttled, never goes down, and ends with the total', async () => {
    let t = 0
    const seen: number[] = []
    const read = await readCountedStream(streamOf(Array.from({ length: 20 }, () => 'x\n')), 0, n => seen.push(n), () => (t += 100), 250)
    expect(read.rows).toBe(20)
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.length).toBeLessThan(20)
    expect(seen[seen.length - 1]).toBe(20)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/export-stream-client.test.ts`
Expected: FAIL, "Failed to resolve import @/lib/export-stream-client".

- [ ] **Step 3: Write the module**

Create `lib/export-stream-client.ts`:

```ts
/**
 * Reads a streamed export in the browser (docs/superpowers/specs/2026-10-13-csv-export-streaming-design.md): keeps the chunks for the file
 * and counts the rows as they arrive. A row is one newline-terminated line; `headerLines` lines (1 for csv, 0 for the others) are not rows.
 * The importer splits on lines, so no field holds a newline; if one ever did the count could only go up, which errs on the safe side of not
 * moving the "since last export" mark.
 */
export interface CountedRead {
  chunks: Uint8Array[]
  rows: number
  bytes: number
}

export async function readCountedStream(
  body: ReadableStream<Uint8Array>,
  headerLines: number,
  onRows?: (rows: number) => void,
  now: () => number = Date.now,
  everyMs = 250,
): Promise<CountedRead> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let newlines = 0
  let bytes = 0
  let last = now()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    bytes += value.length
    for (let i = 0; i < value.length; i++) if (value[i] === 10) newlines++
    if (onRows && now() - last >= everyMs) {
      onRows(Math.max(0, newlines - headerLines))
      last = now()
    }
  }
  const rows = Math.max(0, newlines - headerLines)
  onRows?.(rows)
  return { chunks, rows, bytes }
}
```

- [ ] **Step 4: Run it to verify it passes, type-check, commit**

Run: `npx vitest run __tests__/export-stream-client.test.ts` → PASS. Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`.

```bash
git add lib/export-stream-client.ts __tests__/export-stream-client.test.ts
git commit -m "feat(export): a browser reader that counts the rows of a streamed export"
```

---

### Task 3: The export route

**Files:**
- Modify: `app/api/export/route.ts`, `__tests__/export-route.test.ts`, `__tests__/export-route-imported-range.test.ts`, `__tests__/export-route-csv-guard.test.ts`
- Create: `__tests__/export-route-stream.test.ts`

**Interfaces:**
- Consumes: `EXPORT_ROW_CAP`, `JSON_EXPORT_ROW_CAP`, `STREAM_FORMATS`, `StreamFormat`, `ExportRow`, `createExportStream` (Task 1).
- Produces: `POST /api/export` streams `csv`, `ndjson`, `ulp`, `userpass` with `X-Export-Cap`; `json` unchanged on its own cap.

- [ ] **Step 1: Write the failing route test**

Create `__tests__/export-route-stream.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type StreamCall = { query: string; query_params: Record<string, unknown>; abort_signal?: AbortSignal }
const streamCalls: StreamCall[] = []
let tableRows: Array<Record<string, unknown>> = []
let failQuery: Error | null = null

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async () => []),
  getClient: () => ({
    query: async (opts: StreamCall) => {
      streamCalls.push({ query: opts.query, query_params: opts.query_params ?? {}, abort_signal: opts.abort_signal })
      if (failQuery) throw failQuery
      return { stream: () => (async function* () { yield tableRows.map(r => ({ json: () => r })) })() }
    },
  }),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/export/route'

const request = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/export', { method: 'POST', body: JSON.stringify(body) })
const post = (body: Record<string, unknown>) => POST(request(body))
const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`, source_file: 'f.txt',
  breach_name: '', country_tier: '', login_type: 'email', password_length: 4, password_mask: 'alphanumeric', url_scheme: 'https',
  is_corporate_email: 0, email_domain: 'mail.test', url_host: `s${n}.example`, password_entropy_band: 'weak', imported_at: '2026-10-13 01:00:00',
})

beforeEach(() => {
  streamCalls.length = 0
  tableRows = [row(1), row(2)]
  failQuery = null
})

describe('POST /api/export — the streamed formats', () => {
  test('csv: the header and the rows, the cap header, and no row count or truncation flag', async () => {
    const res = await post({ format: 'csv' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('X-Export-Cap')).toBe('1000000')
    expect(res.headers.get('X-Export-Rows')).toBeNull()
    expect(res.headers.get('X-Export-Truncated')).toBeNull()
    const lines = (await res.text()).split('\n')
    expect(lines).toHaveLength(4) // header + 2 rows + the empty piece after the last newline
    expect(lines[0].startsWith('url,email,password')).toBe(true)
  })

  test('ndjson, ulp and userpass have their own content types and file extensions', async () => {
    const nd = await post({ format: 'ndjson' })
    expect(nd.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8')
    expect(nd.headers.get('Content-Disposition')).toContain('.ndjson"')
    expect((await nd.text()).split('\n').filter(Boolean).map(l => JSON.parse(l).email)).toEqual(['u1@mail.test', 'u2@mail.test'])
    for (const format of ['ulp', 'userpass']) {
      const res = await post({ format })
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
      expect(res.headers.get('Content-Disposition')).toContain('.txt"')
      await res.text()
    }
  })

  test('an unknown format has always been a ulp file', async () => {
    const res = await post({ format: 'whatever' })
    expect(await res.text()).toBe('https://s1.example/login:u1@mail.test:pw1\nhttps://s2.example/login:u2@mail.test:pw2\n')
  })

  test('the query asks for the streaming cap, runs with the longer limit and the external sort, and gets the abort signal', async () => {
    const req = request({ format: 'csv' })
    await POST(req)
    const call = streamCalls[0]
    expect(call.query).toContain('LIMIT 1000000')
    expect(call.query).toContain('max_execution_time = 600')
    expect(call.query).toContain('max_bytes_before_external_sort')
    expect(call.abort_signal).toBeInstanceOf(AbortSignal)
  })

  test('the search scope reaches the streamed SQL', async () => {
    await post({ format: 'csv', query: 'Maria', scope: 'login' })
    expect(streamCalls[0].query).toContain('hasToken(email, {lw0:String})')
    expect(streamCalls[0].query_params.lw0).toBe('maria')
  })

  test('a query that fails is a clean 500, not a broken file', async () => {
    failQuery = new Error('MEMORY_LIMIT_EXCEEDED')
    const res = await post({ format: 'csv' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Export failed' })
  })
})

describe('POST /api/export — json keeps the in-memory path', () => {
  test('it does not stream: no cap header, its own row count and truncation headers, and no ClickHouse stream call', async () => {
    const res = await post({ format: 'json' })
    expect(res.headers.get('X-Export-Cap')).toBeNull()
    expect(res.headers.get('X-Export-Rows')).toBe('0')
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(streamCalls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/export-route-stream.test.ts`
Expected: FAIL (the route still builds one string, so there is no `X-Export-Cap` and no stream call).

- [ ] **Step 3: Apply the route edit**

Create the scratch script (written out with the extractor) `Script task3_route.py`:

Script `task3_route.py`:

```python
"""Task 3 of the CSV-export plan: the export route streams csv, ulp, userpass and ndjson. Every replacement must match exactly once."""
import sys

path = 'app/api/export/route.ts'
t = open(path).read()

def rep(old, new):
    global t
    if t.count(old) != 1:
        sys.exit('expected exactly one match, got %d for: %r' % (t.count(old), old[:90]))
    t = t.replace(old, new)

# 1. imports: the cell guard now lives in lib/export-stream.ts
rep('import { csvCell } from "@/lib/csv-safe"\n', '')
rep('import { parseSearchScope, type SearchScope } from "@/lib/search-scope"\n',
    'import { parseSearchScope, type SearchScope } from "@/lib/search-scope"\n'
    'import { EXPORT_ROW_CAP, JSON_EXPORT_ROW_CAP, STREAM_FORMATS, createExportStream, type ExportRow, type StreamFormat } from "@/lib/export-stream"\n')

# 2. the old cap constant and its comment
start = t.index('// The non-streaming formats (csv, json, ndjson, ulp, userpass) return at most this many rows.')
end_marker = 'const EXPORT_ROW_CAP = 10_000\n'
end = t.index(end_marker, start) + len(end_marker)
t = t[:start] + (
    '// Row caps and the streaming of csv, ulp, userpass and ndjson live in lib/export-stream.ts: EXPORT_ROW_CAP (a million) for the streamed\n'
    '// formats, JSON_EXPORT_ROW_CAP (10,000) for json, which is still one array built in memory. A streamed response cannot carry its row\n'
    '// count or a truncation flag before the body, so it sends X-Export-Cap and the page counts the rows it receives against it.\n'
) + t[end:]

# 3. the in-memory query and its formats -> one SQL builder, the streamed path, and json on its own cap
start = t.index('  try {\n    const fetched = await executeQuery(')
end_marker = "  } catch (error) {\n    console.error('Export error:', error)\n    return NextResponse.json({ success: false, error: 'Export failed' }, { status: 500 })\n  }\n"
end = t.index(end_marker, start) + len(end_marker)
t = t[:start] + '''  // One SQL for every row-level format. Split into an inner (raw columns, ORDER BY, LIMIT) and outer (NORM_COLS) query — see RAW_COLS above
  // for why. exportSortSettings() covers the dedupe + non-domain-sort case — see the comment above SORT_MAP.
  const rowsSql = (limit: number, extraSettings = '') =>
    `SELECT ${SELECT}
       FROM (
         SELECT ${RAW_COLS}
         FROM ulp.credentials
         WHERE ${clause}${allExtras}
         ORDER BY ${orderBy}
         ${dedupeLimitBy(dedupeOn)}
         LIMIT ${limit}
       ) AS t
       ${exportSortSettings()}, ${NORM_COLS_SETTING}${extraSettings}`

  const base = buildFilenameBase(breach_name, domain, incTiers, excTiers, loginTypes)

  // csv, ulp, userpass and ndjson stream up to EXPORT_ROW_CAP rows (an unknown format has always been a ulp file).
  if (format !== 'json') {
    const streamFormat: StreamFormat = (STREAM_FORMATS as readonly string[]).includes(format) ? (format as StreamFormat) : 'ulp'
    const [contentType, ext] = streamFormat === 'csv' ? ['text/csv', 'csv']
      : streamFormat === 'ndjson' ? ['application/x-ndjson', 'ndjson']
      : ['text/plain', 'txt']
    return streamRows(request, streamFormat, rowsSql(EXPORT_ROW_CAP, ', max_execution_time = 600'), mergedParams, csv_guard !== false, {
      'Content-Type': `${contentType}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="${base}${importedWindowTag(importedRange)}.${ext}"`,
      'X-Export-Cap': String(EXPORT_ROW_CAP),
      ...importedWindowHeaders(importedRange),
    })
  }

  try {
    const fetched = await executeQuery(rowsSql(JSON_EXPORT_ROW_CAP + 1), mergedParams) as Array<Record<string, string>>
    // One row more than the cap came back: the export was cut. Hand over the cap and say so.
    const truncated = fetched.length > JSON_EXPORT_ROW_CAP
    const rows = truncated ? fetched.slice(0, JSON_EXPORT_ROW_CAP) : fetched
    return new NextResponse(JSON.stringify(rows, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}${importedWindowTag(importedRange)}.json"`,
        'X-Export-Rows': String(rows.length),
        'X-Export-Truncated': truncated ? '1' : '0',
        ...importedWindowHeaders(importedRange),
      },
    })
  } catch (error) {
    console.error('Export error:', error)
    return NextResponse.json({ success: false, error: 'Export failed' }, { status: 500 })
  }
''' + t[end:]

# 4. the streaming helpers, at the end of the file
t = t.rstrip('\n') + '''

// ─────────────────────────────────────────────────────────────────────────────
// Stream: the row-level formats (csv, ulp, userpass, ndjson)
// ─────────────────────────────────────────────────────────────────────────────

/** ClickHouse's row batches as plain objects. Stopping the loop (a closed tab, the cap) destroys the ClickHouse stream. */
async function* rowBatches(stream: AsyncIterable<Array<{ json(): unknown }>>): AsyncGenerator<ExportRow[]> {
  for await (const rows of stream) yield rows.map(r => r.json() as ExportRow)
}

/**
 * Starts the query and answers once ClickHouse has begun to answer, so a query that fails (memory, timeout) is a clean 500 and not a broken
 * file; from then on the rows are written as they arrive, no faster than the browser reads them. A closed tab aborts the query.
 */
async function streamRows(
  request: NextRequest, format: StreamFormat, sql: string, params: Record<string, unknown>, guard: boolean, headers: Record<string, string>,
): Promise<NextResponse> {
  try {
    const resultSet = await getClient().query({ query: sql, query_params: params, format: 'JSONEachRow', abort_signal: request.signal })
    return new NextResponse(createExportStream(rowBatches(resultSet.stream<ExportRow>()), { format, guard }), { headers })
  } catch (error) {
    console.error('Export error:', error)
    return NextResponse.json({ success: false, error: 'Export failed' }, { status: 500 })
  }
}
'''
open(path, 'w').write(t)
print('edited', path)
```

Write it out with the extractor (`node extract-plan.cjs <plan> --scripts <scratch dir>` writes every `Script` block of the plan to that directory) and run it from the worktree root: `python3 <scratch dir>/task3_route.py`.
Expected: `edited app/api/export/route.ts`.

- [ ] **Step 4: Update the three existing test files that pinned the in-memory CSV path**

Create the scratch script `Script task3_tests.py`:

Script `task3_tests.py`:

```python
"""Task 3: the existing export tests move to the streaming mock; the 10,000-row cap tests move to the json path that keeps that cap."""
import sys

def edit(path, pairs):
    t = open(path).read()
    for old, new in pairs:
        if t.count(old) != 1:
            sys.exit('%s: expected exactly one match, got %d for: %r' % (path, t.count(old), old[:90]))
        t = t.replace(old, new)
    open(path, 'w').write(t)
    print('edited', path)

# __tests__/export-route.test.ts — the source-text pins on the query
edit('__tests__/export-route.test.ts', [(
"""    // One row more than the cap, so a cut export can say so (X-Export-Truncated); the route trims it back to EXPORT_ROW_CAP.
    expect(inner).toContain('LIMIT ${EXPORT_ROW_CAP + 1}')
    expect(source).toContain('const EXPORT_ROW_CAP = 10_000')
""",
"""    // One SQL builder for every row-level format: the json export asks for one row more than its cap (so a cut file can say so), the
    // streamed formats ask for the streaming cap (both caps live in lib/export-stream.ts).
    expect(inner).toContain('LIMIT ${limit}')
    expect(postFn).toContain('rowsSql(JSON_EXPORT_ROW_CAP + 1)')
    expect(postFn).toContain('rowsSql(EXPORT_ROW_CAP')
    expect(source).not.toContain('const EXPORT_ROW_CAP')
""")])

# __tests__/export-route-csv-guard.test.ts — the csv and ulp rows now come through the client's stream
edit('__tests__/export-route-csv-guard.test.ts', [
("  getClient: () => ({ query: async () => ({ stream: () => (async function* () {})() }) }),\n",
 "  getClient: () => ({ query: async () => ({ stream: () => (async function* () { yield tableRows.map(r => ({ json: () => r })) })() }) }),\n"),
("    expect(ulp).toBe('@cmd:-12345:=HYPERLINK(\"http://x.test\",\"c\")')\n",
 "    expect(ulp).toBe('@cmd:-12345:=HYPERLINK(\"http://x.test\",\"c\")\\n')\n"),
])

# __tests__/export-route-imported-range.test.ts — the mock, the data-call helper, the headers and the cap group
path = '__tests__/export-route-imported-range.test.ts'
edit(path, [
("""      streamCalls.push({ query: opts.query, query_params: opts.query_params ?? {} })
      return { stream: () => (async function* () { yield streamRows.map(r => ({ json: () => r })) })() }
""",
"""      streamCalls.push({ query: opts.query, query_params: opts.query_params ?? {} })
      // the row-level export (csv, ulp, userpass, ndjson) is the one query with the ") AS t" wrapper; the list formats read streamRows
      const rows = /\\) AS t\\s/.test(opts.query) ? tableRows : streamRows
      return { stream: () => (async function* () { yield rows.map(r => ({ json: () => r })) })() }
"""),
("const dataCall = () => calls.find(c => /\\) AS t\\s/.test(c.sql))\n",
"""// The row-level SQL: json goes through executeQuery, the streamed formats through the client's stream.
const dataCall = () => {
  const viaExecute = calls.find(c => /\\) AS t\\s/.test(c.sql))
  if (viaExecute) return viaExecute
  const viaStream = streamCalls.find(c => /\\) AS t\\s/.test(c.query))
  return viaStream ? { sql: viaStream.query, params: viaStream.query_params } : undefined
}
"""),
("""    expect(res.headers.get('X-Export-Imported-Before')).toBeNull()
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('X-Export-Rows')).toBe('1')
""",
"""    expect(res.headers.get('X-Export-Imported-Before')).toBeNull()
    // a streamed export cannot know its row count or truncation before the body: the page counts the rows against the cap
    expect(res.headers.get('X-Export-Cap')).toBe('1000000')
    expect(res.headers.get('X-Export-Truncated')).toBeNull()
    expect(res.headers.get('X-Export-Rows')).toBeNull()
"""),
])
t = open(path).read()
start = t.index("describe('POST /api/export — the 10,000-row cap says so'")
end = t.index("describe('the streaming formats honor the bound too'")
new_group = '''describe('POST /api/export — the json export keeps the 10,000-row cap and says so', () => {
  test('the main query asks for one row more than the cap', async () => {
    await post({ format: 'json' })
    expect(dataCall()!.sql).toContain('LIMIT 10001')
  })

  test('fewer rows than the cap: complete', async () => {
    tableRows = Array.from({ length: 3 }, (_, i) => tableRow(i))
    const res = await post({ format: 'json' })
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('X-Export-Rows')).toBe('3')
    expect(JSON.parse(await res.text())).toHaveLength(3)
  })

  test('exactly the cap: still complete (the extra row never arrived)', async () => {
    tableRows = Array.from({ length: 10_000 }, (_, i) => tableRow(i))
    const res = await post({ format: 'json' })
    expect(res.headers.get('X-Export-Truncated')).toBe('0')
    expect(res.headers.get('X-Export-Rows')).toBe('10000')
  })

  test('one row over the cap: trimmed to the cap and flagged', async () => {
    tableRows = Array.from({ length: 10_001 }, (_, i) => tableRow(i))
    const res = await post({ format: 'json' })
    expect(res.headers.get('X-Export-Truncated')).toBe('1')
    expect(res.headers.get('X-Export-Rows')).toBe('10000')
    expect(JSON.parse(await res.text())).toHaveLength(10_000)
  })
})

describe('POST /api/export — the streamed formats take up to a million rows', () => {
  test('the query asks for exactly the streaming cap and carries the longer time limit', async () => {
    await post({ format: 'csv' })
    const { sql } = dataCall()!
    expect(sql).toContain('LIMIT 1000000')
    expect(sql).not.toContain('LIMIT 1000001')
    expect(sql).toContain('max_execution_time = 600')
  })

  test('csv is the header line plus every row, and past 10,000 rows nothing is cut', async () => {
    tableRows = Array.from({ length: 10_001 }, (_, i) => tableRow(i))
    const res = await post({ format: 'csv' })
    expect(res.headers.get('X-Export-Cap')).toBe('1000000')
    expect((await res.text()).split('\\n')).toHaveLength(10_003) // header + 10,001 rows + the empty piece after the last newline
  })

  test('ulp and userpass are one newline-terminated line per row', async () => {
    tableRows = Array.from({ length: 3 }, (_, i) => tableRow(i))
    expect(await (await post({ format: 'ulp' })).text()).toBe(tableRows.map(r => `${r.url}:${r.email}:${r.password}\\n`).join(''))
    expect(await (await post({ format: 'userpass' })).text()).toBe(tableRows.map(r => `${r.email}:${r.password}\\n`).join(''))
  })
})

'''
open(path, 'w').write(t[:start] + new_group + t[end:])
print('edited', path, '(cap group)')
```

Run the script from the worktree root. Expected: three `edited ...` lines plus `(cap group)`.

- [ ] **Step 5: Run the export tests**

Run: `npx vitest run __tests__/export-route-stream.test.ts __tests__/export-route.test.ts __tests__/export-route-imported-range.test.ts __tests__/export-route-csv-guard.test.ts __tests__/export-route-scope.test.ts`
Expected: PASS. If a test in `export-route-imported-range.test.ts` fails because it posted `csv` and read `calls`, it needs `dataCall()` (the helper now covers both); fix that one test, do not loosen the new assertions.

- [ ] **Step 6: Type-check, lint the route, commit**

Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`. (If tsc rejects the `rowBatches` parameter type against the client's `StreamReadable<Row[]>`, change only that annotation, for example to `AsyncIterable<Array<{ json(): unknown }>>` as written, or cast at the call site; the behaviour does not change.)
Run: `npx eslint --no-eslintrc -c .eslintrc.json app/api/export/route.ts lib/export-stream.ts lib/export-stream-client.ts; echo "eslint exit $?"` → `eslint exit 0`.

```bash
git add app/api/export/route.ts __tests__/export-route-stream.test.ts __tests__/export-route.test.ts __tests__/export-route-imported-range.test.ts __tests__/export-route-csv-guard.test.ts
git commit -m "feat(export): csv, ulp, userpass and ndjson stream up to a million rows"
```

---

### Task 4: The credentials page

**Files:**
- Modify: `app/credentials/page.tsx`, `__tests__/imported-range-credentials-page.test.ts`
- Create: `__tests__/credentials-page-export-stream.test.ts`

**Interfaces:**
- Consumes: `readCountedStream` (Task 2); the route's `X-Export-Cap` header (Task 3).

- [ ] **Step 1: Write the failing page test**

Create `__tests__/credentials-page-export-stream.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const src = readFileSync(new URL('../app/credentials/page.tsx', import.meta.url), 'utf8')
const doExport = src.slice(src.indexOf('const doExport'), src.indexOf('const hasBasicFilters'))
const exportButton = src.slice(src.indexOf('onClick={doExport}'), src.indexOf('onClick={doExport}') + 800)

describe('Credentials page — the streamed export', () => {
  test('the slices under test were found', () => {
    expect(doExport.length).toBeGreaterThan(800)
    expect(exportButton.length).toBeGreaterThan(300)
  })

  test('a response with X-Export-Cap is read as a stream and counted', () => {
    expect(src).toContain("import { readCountedStream } from '@/lib/export-stream-client'")
    expect(doExport).toContain("Number(res.headers.get('X-Export-Cap') ?? 0) || 0")
    expect(doExport).toContain("readCountedStream(res.body, exportFmt === 'csv' ? 1 : 0, setExportRows)")
    expect(doExport).toContain('const truncated = cap > 0 ? streamedRows >= cap')
    expect(doExport).toContain('const rows = cap > 0 ? streamedRows')
  })

  test('json (no cap header) still reads its row count and truncation flag from the headers, and the mark call is the same', () => {
    expect(doExport).toContain("res.headers.get('X-Export-Truncated') === '1'")
    expect(doExport).toContain("res.headers.get('X-Export-Rows')")
    expect(doExport).toContain('markAfterExport(')
    expect(doExport).toContain('{ truncated, rows },')
  })

  test('the toasts name the real cap and the number of rows exported', () => {
    expect(doExport).toContain("Export stopped at ${(cap > 0 ? cap : 10_000).toLocaleString('en-US')} rows")
    expect(doExport).toContain("`Exported ${rows.toLocaleString('en-US')} rows`")
  })

  test('the button says Preparing… and then the running count, and the count is reset when the export ends', () => {
    expect(src).toMatch(/const \[exportRows, setExportRows\]\s+= useState<number \| null>\(null\)/)
    expect(exportButton).toContain("exportRows === null ? 'Preparing…'")
    expect(exportButton).toContain("toLocaleString('en-US')} rows")
    expect(doExport).toContain('setExportRows(null)')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/credentials-page-export-stream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Apply the page edit**

Script `task4_page.py`:

```python
"""Task 4 of the CSV-export plan: the page reads a streamed export and shows the running count. Every replacement must match exactly once."""
import sys

def edit(path, pairs):
    t = open(path).read()
    for old, new in pairs:
        if t.count(old) != 1:
            sys.exit('%s: expected exactly one match, got %d for: %r' % (path, t.count(old), old[:90]))
        t = t.replace(old, new)
    open(path, 'w').write(t)
    print('edited', path)

edit('app/credentials/page.tsx', [
("import { SEARCH_SCOPE_OPTIONS, SEARCH_SCOPE_PLACEHOLDERS, SEARCH_SCOPE_TITLE, type SearchScope } from '@/lib/search-scope'\n",
 "import { SEARCH_SCOPE_OPTIONS, SEARCH_SCOPE_PLACEHOLDERS, SEARCH_SCOPE_TITLE, type SearchScope } from '@/lib/search-scope'\n"
 "import { readCountedStream } from '@/lib/export-stream-client'\n"),
("  const [exportLoading, setExportLoading] = useState(false)\n",
 "  const [exportLoading, setExportLoading] = useState(false)\n"
 "  // Rows received so far by a streamed export (null until the first rows arrive).\n"
 "  const [exportRows, setExportRows]       = useState<number | null>(null)\n"),
("      if (!res.ok) throw new Error('Export failed')\n      const blob = await res.blob()\n",
 """      if (!res.ok) throw new Error('Export failed')
      // A streamed export (X-Export-Cap) is read chunk by chunk and counted as it arrives; json comes back whole with its row count and
      // truncation flag in headers.
      const cap = Number(res.headers.get('X-Export-Cap') ?? 0) || 0
      let blob: Blob
      let streamedRows = 0
      if (cap > 0 && res.body) {
        const read = await readCountedStream(res.body, exportFmt === 'csv' ? 1 : 0, setExportRows)
        blob = new Blob(read.chunks as BlobPart[], { type: res.headers.get('Content-Type') ?? 'text/plain' })
        streamedRows = read.rows
      } else {
        blob = await res.blob()
      }
"""),
("      const truncated = res.headers.get('X-Export-Truncated') === '1'\n      const rows = Number(res.headers.get('X-Export-Rows') ?? 0) || 0\n",
 "      const truncated = cap > 0 ? streamedRows >= cap : res.headers.get('X-Export-Truncated') === '1'\n"
 "      const rows = cap > 0 ? streamedRows : Number(res.headers.get('X-Export-Rows') ?? 0) || 0\n"),
("          title: 'Export stopped at 10,000 rows',\n",
 "          title: `Export stopped at ${(cap > 0 ? cap : 10_000).toLocaleString('en-US')} rows`,\n"),
("        toast({ title: 'Export started' })\n",
 "        toast({ title: cap > 0 ? `Exported ${rows.toLocaleString('en-US')} rows` : 'Export started' })\n"),
("    } finally {\n      setExportLoading(false)\n    }\n  }, [q, scope, domain, breach, tierInclude,",
 "    } finally {\n      setExportLoading(false)\n      setExportRows(null)\n    }\n  }, [q, scope, domain, breach, tierInclude,"),
("                  : <Download className=\"h-3 w-3\" />\n                }\n                Export\n",
 "                  : <Download className=\"h-3 w-3\" />\n                }\n"
 "                {exportLoading ? (exportRows === null ? 'Preparing…' : `${exportRows.toLocaleString('en-US')} rows`) : 'Export'}\n"),
])

edit('__tests__/imported-range-credentials-page.test.ts', [
("    expect(doExport).toContain('Export stopped at 10,000 rows')\n",
 "    expect(doExport).toContain(\"Export stopped at ${(cap > 0 ? cap : 10_000).toLocaleString('en-US')} rows\")\n"),
])
```

Run it from the worktree root. Expected: two `edited ...` lines.

- [ ] **Step 4: Run the page tests**

Run: `npx vitest run __tests__/credentials-page-export-stream.test.ts __tests__/imported-range-credentials-page.test.ts __tests__/credentials-page-scope.test.ts __tests__/credentials-page-totals.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, lint, commit**

Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`.
Run: `npx eslint --no-eslintrc -c .eslintrc.json app/credentials/page.tsx; echo "eslint exit $?"` → `eslint exit 0`.

```bash
git add app/credentials/page.tsx __tests__/credentials-page-export-stream.test.ts __tests__/imported-range-credentials-page.test.ts
git commit -m "feat(export): the page counts a streamed export as it arrives"
```

---

### Task 5: The dedup stats-pass guard

**Files:**
- Modify: `lib/content-dedup.ts`
- Create: `__tests__/content-dedup-stats-guard.test.ts`

**Interfaces:**
- Consumes: `checkDiskHeadroom(signal?)` and `formatBytes(bytes)` from `lib/clickhouse-disk-guard.ts`.
- Produces: `DEFAULT_STATS_MIN_FREE_BYTES`, `dedupStatsMinFreeBytes(env?)`, `dedupStatsHeadroomRefusal(env?, check?)`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/content-dedup-stats-guard.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'
import { DEFAULT_STATS_MIN_FREE_BYTES, dedupStatsMinFreeBytes, dedupStatsHeadroomRefusal } from '@/lib/content-dedup'

const GiB = 1024 ** 3

describe('dedupStatsMinFreeBytes', () => {
  test('defaults to 40 GiB', () => {
    expect(DEFAULT_STATS_MIN_FREE_BYTES).toBe(40 * GiB)
    expect(dedupStatsMinFreeBytes({} as NodeJS.ProcessEnv)).toBe(40 * GiB)
  })

  test('DEDUP_STATS_MIN_FREE_BYTES overrides it, zero included', () => {
    expect(dedupStatsMinFreeBytes({ DEDUP_STATS_MIN_FREE_BYTES: String(10 * GiB) } as unknown as NodeJS.ProcessEnv)).toBe(10 * GiB)
    expect(dedupStatsMinFreeBytes({ DEDUP_STATS_MIN_FREE_BYTES: '0' } as unknown as NodeJS.ProcessEnv)).toBe(0)
  })

  test.each(['', 'abc', '-5', 'NaN'])('%j is ignored', raw => {
    expect(dedupStatsMinFreeBytes({ DEDUP_STATS_MIN_FREE_BYTES: raw } as unknown as NodeJS.ProcessEnv)).toBe(40 * GiB)
  })
})

describe('dedupStatsHeadroomRefusal', () => {
  const env = {} as NodeJS.ProcessEnv

  test('less free space than needed: a reason that names both sizes', async () => {
    const why = await dedupStatsHeadroomRefusal(env, async () => ({ freeBytes: 21 * GiB }))
    expect(why).toContain('free < ')
    expect(why).toContain('needed')
    expect(why).toMatch(/21(\.0+)? GiB/)
    expect(why).toMatch(/40(\.0+)? GiB/)
  })

  test('enough free space, or exactly the amount: no reason', async () => {
    expect(await dedupStatsHeadroomRefusal(env, async () => ({ freeBytes: 162 * GiB }))).toBeNull()
    expect(await dedupStatsHeadroomRefusal(env, async () => ({ freeBytes: 40 * GiB }))).toBeNull()
  })

  test('a free-space check that fails also refuses', async () => {
    const why = await dedupStatsHeadroomRefusal(env, async () => { throw new Error('system.disks unreachable') })
    expect(why).toBe('the free-space check failed (system.disks unreachable)')
  })

  test('the threshold follows the environment', async () => {
    const small = { DEDUP_STATS_MIN_FREE_BYTES: String(5 * GiB) } as unknown as NodeJS.ProcessEnv
    expect(await dedupStatsHeadroomRefusal(small, async () => ({ freeBytes: 21 * GiB }))).toBeNull()
    expect(await dedupStatsHeadroomRefusal(small, async () => ({ freeBytes: 3 * GiB }))).not.toBeNull()
  })
})

describe('runContentDedupTick — the guard comes before the stats pass', () => {
  const src = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
  const tick = src.slice(src.indexOf('export async function runContentDedupTick'))

  test('it asks first, logs the skip and reports it', () => {
    const ask = tick.indexOf('dedupStatsHeadroomRefusal()')
    const stats = tick.indexOf('queryContentKeyStats(client, buildContentKeyStatsSql())')
    expect(ask).toBeGreaterThan(-1)
    expect(stats).toBeGreaterThan(ask)
    expect(tick).toContain('skipped the stats pass')
    expect(tick.slice(ask, stats)).toContain('skipped: true')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/content-dedup-stats-guard.test.ts`
Expected: FAIL (the helpers are not exported).

- [ ] **Step 3: Implement**

Script `task5_dedup.py`:

```python
"""Task 5 of the CSV-export plan: the daily dedup stats pass refuses to start on a nearly full disk. Every replacement must match exactly once."""
import sys

path = 'lib/content-dedup.ts'
t = open(path).read()

def rep(old, new):
    global t
    if t.count(old) != 1:
        sys.exit('expected exactly one match, got %d for: %r' % (t.count(old), old[:90]))
    t = t.replace(old, new)

rep("import { createDiskGuard, DiskHeadroomError, type DiskGuard } from '@/lib/clickhouse-disk-guard'",
    "import { createDiskGuard, DiskHeadroomError, checkDiskHeadroom, formatBytes, type DiskGuard } from '@/lib/clickhouse-disk-guard'")

rep('''/**
 * Read duplicate stats, log them, and''', '''/**
 * Free space below which the daily stats pass does not start. It is a full GROUP BY over every content key that spilled 13.82 GiB to disk at 1.84B
 * rows (2026-10-13) and had no guard of its own (the disk guard covers only populate and the projection restores), so 40 GiB is about three times
 * that spill. DEDUP_STATS_MIN_FREE_BYTES overrides it.
 */
export const DEFAULT_STATS_MIN_FREE_BYTES = 40 * 1024 ** 3

export function dedupStatsMinFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEDUP_STATS_MIN_FREE_BYTES
  if (raw === undefined || raw.trim() === '') return DEFAULT_STATS_MIN_FREE_BYTES
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STATS_MIN_FREE_BYTES
}

/** Why the stats pass should not start, or null when the disk has room. A free-space check that fails counts as no room. */
export async function dedupStatsHeadroomRefusal(
  env: NodeJS.ProcessEnv = process.env,
  check: () => Promise<{ freeBytes: number }> = () => checkDiskHeadroom(),
): Promise<string | null> {
  const need = dedupStatsMinFreeBytes(env)
  try {
    const { freeBytes } = await check()
    return freeBytes < need ? `${formatBytes(freeBytes)} free < ${formatBytes(need)} needed` : null
  } catch (err) {
    return `the free-space check failed (${err instanceof Error ? err.message : String(err)})`
  }
}

/**
 * Read duplicate stats, log them, and''')

rep('''    const { total, distinctCreds } = await queryContentKeyStats(client, buildContentKeyStatsSql())
    const excess = total - distinctCreds''', '''    // The stats pass is a full GROUP BY that spills to disk: do not start it on a nearly full disk.
    const noRoom = await dedupStatsHeadroomRefusal()
    if (noRoom) {
      console.warn(`[content-dedup] ${trigger}: skipped the stats pass, ${noRoom}`)
      return { total: 0, excess: 0, applied: false, skipped: true }
    }

    const { total, distinctCreds } = await queryContentKeyStats(client, buildContentKeyStatsSql())
    const excess = total - distinctCreds''')

open(path, 'w').write(t)
print('edited', path)
```

Run it from the worktree root. Expected: `edited lib/content-dedup.ts`.

- [ ] **Step 4: Run the dedup tests, type-check, commit**

Run: `npx vitest run __tests__/content-dedup-stats-guard.test.ts __tests__/content-dedup.test.ts __tests__/content-dedup-stats-skip.test.ts __tests__/content-dedup-projection-restore.test.ts __tests__/dedup-cron.test.ts` → PASS.
Run: `npx tsc --noEmit; echo "tsc exit $?"` → `tsc exit 0`.
Run: `npx eslint --no-eslintrc -c .eslintrc.json lib/content-dedup.ts; echo "eslint exit $?"` → `eslint exit 0`.

```bash
git add lib/content-dedup.ts __tests__/content-dedup-stats-guard.test.ts
git commit -m "feat(dedup): the daily stats pass skips itself when the disk is nearly full"
```

---

### Task 6: Live check, documentation, the gate and the deploy

**Files:**
- Create: `__tests__/export-stream.live.test.ts`
- Modify: `README.md`, `.env.example`, `docker-compose.yml`, `docs/superpowers/specs/2026-10-13-csv-export-streaming-design.md`

- [ ] **Step 1: The live check**

Create `__tests__/export-stream.live.test.ts`:

```ts
import { execSync } from 'node:child_process'
import { describe, expect, test, vi } from 'vitest'

/**
 * LIVE check of the streamed export (app/api/export/route.ts, lib/export-stream.ts): a big-site export through the real handler against the real
 * ClickHouse container. Skipped unless ECS_LIVE=1. READ-ONLY. It never keeps the file: it counts bytes and rows as they arrive and samples the
 * process memory, so it also shows that the stream does not hold the export in memory. It prints the time to the first byte, the rows, the bytes
 * and the memory growth.
 *
 *   ECS_LIVE=1 npx vitest run __tests__/export-stream.live.test.ts
 *   ECS_LIVE=1 ECS_TERM=some.site npx vitest run __tests__/export-stream.live.test.ts
 *
 * ECS_TERM is the search term (default a public brand). Real search terms belong in YOUR environment, never in this file: the repository is public.
 */
const LIVE = process.env.ECS_LIVE === '1'
const TERM = process.env.ECS_TERM ?? 'google.com'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

describe.skipIf(!LIVE)('streamed export on the live table', () => {
  test.each(['csv', 'ndjson'])('%s: a big-site export streams, is complete line by line and does not grow the heap by the file size', async format => {
    const { POST } = await import('@/app/api/export/route')
    const { NextRequest } = await import('next/server')
    const rssBefore = process.memoryUsage().rss
    const t0 = Date.now()
    const res = await POST(new NextRequest('http://localhost/api/export', {
      method: 'POST', body: JSON.stringify({ format, query: TERM, sort: 'domain_asc', dedupe: '0' }),
    }))
    const answeredMs = Date.now() - t0
    expect(res.status).toBe(200)
    const cap = Number(res.headers.get('X-Export-Cap'))
    expect(cap).toBe(1_000_000)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let newlines = 0
    let firstByteMs = -1
    let peakRss = rssBefore
    let head = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (firstByteMs < 0) firstByteMs = Date.now() - t0
      bytes += value.length
      for (let i = 0; i < value.length; i++) if (value[i] === 10) newlines++
      if (head.length < 200_000) head += decoder.decode(value, { stream: true })
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }
    const rows = newlines - (format === 'csv' ? 1 : 0)
    const growthMiB = Math.round((peakRss - rssBefore) / 1048576)
    console.log(`${format} | term ${TERM.length} chars | answered after ${answeredMs} ms, first byte ${firstByteMs} ms, total ${Date.now() - t0} ms | ${rows} rows | ${Math.round(bytes / 1048576)} MiB | memory grew ${growthMiB} MiB`)

    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThanOrEqual(cap)
    const lines = head.split('\n').slice(format === 'csv' ? 1 : 0, 200).filter(Boolean)
    if (format === 'ndjson') for (const l of lines.slice(0, 100)) expect(() => JSON.parse(l)).not.toThrow()
    else for (const l of lines.slice(0, 100)) expect((l.match(/","/g) ?? []).length).toBeGreaterThanOrEqual(15) // 16 quoted cells (a quote pattern inside a value can only add)
    // the file is hundreds of MiB for a million rows; holding it would show here
    expect(growthMiB).toBeLessThan(Math.max(300, Math.round(bytes / 1048576 / 2)))
  }, 30 * 60_000)
})
```

Run (read-only; the first line of output is the timing): `ECS_LIVE=1 nice -n 10 npx vitest run __tests__/export-stream.live.test.ts`
Expected: PASS for `csv` and `ndjson`, and the printed lines show rows, MiB and the memory growth. Run it in the background (it can take a minute or two) and read the result once.

- [ ] **Step 2: Documentation and configuration**

Script `task6_docs.py`:

```python
"""Task 6: the README, .env.example, compose and the spec status. Every replacement must match exactly once."""
import re, sys

def edit(path, pairs):
    t = open(path).read()
    for old, new in pairs:
        if t.count(old) != 1:
            sys.exit('%s: expected exactly one match, got %d for: %r' % (path, t.count(old), old[:90]))
        t = t.replace(old, new)
    open(path, 'w').write(t)
    print('edited', path)

edit('README.md', [
("- **Batch lookup** — paste up to 100 emails and get all matches in one request; CSV export\n",
 "- **Batch lookup** — paste up to 100 emails and get all matches in one request; CSV export\n"
 "- **Export** — CSV, ULP (`url:login:pass`), `login:pass` and NDJSON exports stream up to 1,000,000 rows (about 215 MiB as CSV) with a running row count on the button; JSON keeps 10,000. \"Since last export\" only moves when the file was not cut (a result of exactly 1,000,000 rows counts as possibly cut). A broad newest-first export can take about two minutes to start.\n"),
("DEDUP_MIN_EXCESS=1000      # skip the (heavy) rewrite below this many excess rows (the 1.39B-row deployment uses 14000000, ~1% of the table)\n",
 "DEDUP_MIN_EXCESS=1000      # skip the (heavy) rewrite below this many excess rows (the 1.39B-row deployment uses 14000000, ~1% of the table)\n"
 "DEDUP_STATS_MIN_FREE_BYTES=42949672960   # the daily duplicate count spills to disk (13.8 GiB at 1.84B rows); it skips itself with less free space than this (default 40 GiB)\n"),
])

edit('.env.example', [
("DEDUP_MIN_EXCESS=1000\n",
 "DEDUP_MIN_EXCESS=1000\n"
 "# The daily duplicate count is a full GROUP BY that spills to disk (13.8 GiB at 1.84B rows). It skips itself, with a log line, when ClickHouse\n"
 "# has less free space than this many bytes. Default 40 GiB; compose forwards whatever you set here.\n"
 "DEDUP_STATS_MIN_FREE_BYTES=42949672960\n"),
])

edit('docker-compose.yml', [
("      DEDUP_MIN_EXCESS: ${DEDUP_MIN_EXCESS:-1000}\n",
 "      DEDUP_MIN_EXCESS: ${DEDUP_MIN_EXCESS:-1000}\n"
 "      DEDUP_STATS_MIN_FREE_BYTES: ${DEDUP_STATS_MIN_FREE_BYTES:-42949672960}\n"),
])

# the spec's status line (a single line)
path = 'docs/superpowers/specs/2026-10-13-csv-export-streaming-design.md'
t = open(path).read()
m = re.search(r"^Status: \*\*written for the owner's review; nothing is built\.\*\*.*$", t, re.M)
if not m: sys.exit('status line not found')
new = ("Status: **implemented on 2026-10-13** (plan `docs/superpowers/plans/2026-10-13-csv-export-streaming.md`). The owner approved the design in chat on 2026-10-13 and chose "
       "the direct streamed download over a background file. One detail is a refinement of what was presented (the response starts when ClickHouse has its first rows, not "
       "before). The repository is public: this file holds numbers only, never real addresses, file names or search terms.")
open(path, 'w').write(t[:m.start()] + new + t[m.end():])
print('edited', path)
```

Run it from the worktree root. Expected: four `edited ...` lines.

- [ ] **Step 3: The whole gate**

Run, each to a file so a failure cannot hide behind a pipe:

```bash
npx tsc --noEmit > /tmp/claude-1000/gate-tsc.txt 2>&1; echo "tsc exit $?"
npx eslint --no-eslintrc -c .eslintrc.json app lib components __tests__/export-stream.test.ts __tests__/export-stream-client.test.ts __tests__/export-route-stream.test.ts __tests__/credentials-page-export-stream.test.ts __tests__/content-dedup-stats-guard.test.ts __tests__/export-stream.live.test.ts __tests__/export-route.test.ts __tests__/export-route-imported-range.test.ts __tests__/export-route-csv-guard.test.ts __tests__/imported-range-credentials-page.test.ts > /tmp/claude-1000/gate-eslint.txt 2>&1; echo "eslint exit $?"
npx vitest run > /tmp/claude-1000/gate-vitest.txt 2>&1; echo "vitest exit $?"; grep -E "Test Files|Tests " /tmp/claude-1000/gate-vitest.txt
```

Expected: `tsc exit 0`, `eslint exit 0` (three older test files outside CI's lint scope have errors of their own and are not listed here), `vitest exit 0` with 0 failed. A test that exercises the compose file or `.env.example` may need the new variable; fix it rather than loosening it. The production build is covered by the image build in Step 5 and by CI.

- [ ] **Step 4: Commit and prepare the image**

```bash
git add __tests__/export-stream.live.test.ts README.md .env.example docker-compose.yml docs/superpowers/specs/2026-10-13-csv-export-streaming-design.md
git commit -m "docs(export): README, configuration, the live check and the spec status for the streamed export"
git fetch -q origin && git rebase origin/main
SHA=$(git rev-parse --short HEAD)
ls -A /home/cole/ulp-suite/inbox/processing; find /home/cole/ulp-suite/inbox -maxdepth 1 -type f
docker tag "$(docker inspect ulpsuite_app --format '{{.Image}}')" "ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%M)z"
mkdir -p /tmp/claude-1000/build-$SHA /tmp/claude-1000/dockercfg && echo '{}' > /tmp/claude-1000/dockercfg/config.json
git archive HEAD | tar -x -C /tmp/claude-1000/build-$SHA
```

Expected: the inbox listing prints nothing (no file in flight), the rollback tag exists (`docker images | grep rollback-` shows it), the build context exists.

- [ ] **Step 5: Build the candidate image from the commit, then push, then deploy**

```bash
cd /tmp/claude-1000/build-$SHA && DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker build -t ulp-suite-app:csv-export-candidate . > /tmp/claude-1000/docker-build.log 2>&1; echo "docker build exit $?"
```

Run it in the background and read the result once. Only when it exits 0:

```bash
cd /home/cole/ulp-suite/.claude/worktrees/csv-export-streaming && git push origin csv-export-streaming:main
cd /home/cole/ulp-suite && git fetch -q origin && git merge --ff-only origin/main
docker tag ulp-suite-app:csv-export-candidate ulp-suite-app:latest
DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose -p ulp-suite -f docker-compose.yml --project-directory /home/cole/ulp-suite --env-file /home/cole/ulp-suite/.env up -d --no-deps app
```

Expected: the push is a fast-forward of `main`; the app container is recreated.

- [ ] **Step 6: Verify the deploy**

```bash
docker inspect ulpsuite_app --format 'image={{.Image}} health={{.State.Health.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}}'
docker exec ulpsuite_app sh -c 'grep -rl "X-Export-Cap" /app/.next/static | head -3'
docker exec ulpsuite_app printenv | grep -E '^(CONTENT_DEDUP_APPLY|INGEST_FILTER_HARD_DROP_TIERS|ULP_ARCHIVE_DIR|DEDUP_STATS_MIN_FREE_BYTES)='
docker logs ulpsuite_app --since 4m 2>&1 | grep -iE "error|fatal|DDL|cron started" | head -8
```

Expected: the new image id, `healthy`, `restarts=0`; at least one built client file contains the `X-Export-Cap` header name; `DEDUP_STATS_MIN_FREE_BYTES=42949672960` is present and the other three unchanged; no error in the start-up log. Look at CI once with `gh run list --branch main -L 1` (do not poll). Update the memory note `project_csv_export_1m_2026_10_13.md` with the sha, the image id, the rollback tag and the live-check timings.

- [ ] **Step 7: Clean up**

```bash
cd /home/cole/ulp-suite && git worktree remove .claude/worktrees/csv-export-streaming && git branch -d csv-export-streaming && rm -rf /tmp/claude-1000/build-$SHA
```

---

## Self-review against the spec

- Streamed csv, ulp, userpass, ndjson up to 1,000,000 rows; json keeps 10,000; other formats untouched: Tasks 1 and 3.
- Same SQL, `LIMIT cap`, `max_execution_time = 600`, external sort kept; abort signal; response after the query answered, clean 500 on failure; headers (`X-Export-Cap`, window headers, no row count or truncation flag): Task 3.
- Backpressure, cap, cancel, error, lazy reading, the header line, the formula guard: Tasks 1 and 3.
- Page: reader with the running count, `Preparing…`, `rows >= cap` as the cut rule, the unchanged `markAfterExport`, the toasts with the real cap, json on its old path: Tasks 2 and 4.
- Dedup stats-pass guard with the 40 GiB default, the environment override, the skip result and log line, compose and `.env.example` wiring: Tasks 5 and 6.
- Tests: formatters and stream (Task 1), reader (Task 2), route with a mocked stream and the three existing export test files moved to it (Task 3), page source tests (Task 4), dedup (Task 5), live check (Task 6). Gate, rollback tag, image from the commit, deploy, verification: Task 6.
- Not included, as in the spec: a background file, streaming the JSON array, the Newest-first windows for exports, percentage progress, Excel or zip, resumable downloads.
- Names used across tasks: `EXPORT_ROW_CAP`, `JSON_EXPORT_ROW_CAP`, `STREAM_FORMATS`, `StreamFormat`, `ExportRow`, `csvHeaderLine`, `exportLine`, `createExportStream` (Task 1); `readCountedStream` (Task 2); `rowsSql`, `streamRows`, `rowBatches` (Task 3); `exportRows`, `setExportRows`, `streamedRows`, `cap` (Task 4); `DEFAULT_STATS_MIN_FREE_BYTES`, `dedupStatsMinFreeBytes`, `dedupStatsHeadroomRefusal` (Task 5).
