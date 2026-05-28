# Monitoring & Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the ULP parser to ~80 lines with RFC 3986-correct colon disambiguation, stream inserts as CSV instead of JSON, add SSE upload progress, and add scheduled monitor re-scans with configurable dedup/digest modes.

**Architecture:** Four independent workstreams (WS1–WS4) share no state and have no sequential dependency — they can be executed in parallel by separate agents. Each workstream produces working, tested, committed software on its own. WS2 depends only on WS1's interface staying stable (it does — signatures are backward-compatible).

**Tech Stack:** Next.js 14 App Router, ClickHouse (`@clickhouse/client`), SQLite (better-sqlite3), Vitest, TypeScript strict.

---

## File Map

### WS1 — Parser Rewrite
- **Rewrite:** `lib/ulp-parser.ts` (674 → ~100 lines)
- **Update:** `__tests__/ulp-parser.test.ts` (remove BlockStateMachine tests, add new edge-case tests)

### WS2 — CSV Streaming Insert
- **Modify:** `app/api/upload/route.ts` — `insertBatch()` switches from JSONEachRow array to CSV Readable stream

### WS3 — SSE Upload Progress
- **Create:** `lib/upload-jobs.ts` — in-process job store + GC
- **Create:** `app/api/upload/progress/[jobId]/route.ts` — SSE stream endpoint
- **Modify:** `app/api/upload/route.ts` — fire-and-forget, return `{ jobId }` immediately
- **Modify:** `app/upload/page.tsx` — EventSource, live progress bar, elapsed timer

### WS4 — Scheduled Monitor Re-Scans
- **Modify:** `lib/sqlite.ts` — ADD COLUMN migrations for `rescan_mode` and `rescan_interval_hours`
- **Modify:** `lib/domain-monitor.ts` — update `DomainMonitor` type + `createMonitor`/`updateMonitor` to accept new fields
- **Create:** `lib/monitor-rescan-cron.ts` — 15-min tick, query due monitors, run ClickHouse, fire webhooks
- **Modify:** `instrumentation.ts` — register cron on production startup
- **Modify:** `app/api/monitoring/monitors/[id]/route.ts` — accept `rescan_mode` + `rescan_interval_hours` in PUT body
- **Modify:** `app/monitoring/page.tsx` — add rescan_mode radio + rescan_interval_hours input to create/edit form

---

## WS1 — Parser Rewrite

### Task 1.1: Write failing tests for new parser algorithm

**Files:**
- Modify: `__tests__/ulp-parser.test.ts`

- [ ] **Step 1: Add new edge-case tests to `__tests__/ulp-parser.test.ts`**

Open `__tests__/ulp-parser.test.ts` and add this block at the bottom, before the final closing brace of the file:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// § NEW — RFC 3986 edge cases (added for parser v5)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseLine — port disambiguation (RFC 3986)', () => {
  test('strips port from URL, does not treat it as login separator', () => {
    const c = cred('https://site.com:8443/path:user@email.com:pass123')
    expect(c).not.toBeNull()
    expect(c!.email).toBe('user@email.com')
    expect(c!.password).toBe('pass123')
    expect(c!.domain).toBe('site.com')
  })

  test('IPv4 URL with port', () => {
    const c = cred('http://192.168.1.1:8080/login:admin:secret')
    expect(c).not.toBeNull()
    expect(c!.email).toBe('admin')
    expect(c!.password).toBe('secret')
    expect(c!.domain).toBe('192.168.1.1')
  })

  test('URL with no path, port present', () => {
    const c = cred('https://site.com:443:user:pass')
    expect(c).not.toBeNull()
    expect(c!.email).toBe('user')
    expect(c!.password).toBe('pass')
  })
})

describe('parseLine — colons in password', () => {
  test('password containing colons is fully preserved', () => {
    const c = cred('https://site.com/path:user@email.com:p:a:s:s')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('p:a:s:s')
  })

  test('tab-separated line with colons in password', () => {
    const c = cred('https://site.com\tuser@email.com\tp:a:s:s')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('p:a:s:s')
  })
})

describe('parseLine — email:password only (no URL)', () => {
  test('email:pass with no URL produces empty url and domain', () => {
    const c = cred('someone@domain.com:mypassword99')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('')
    expect(c!.domain).toBe('')
    expect(c!.email).toBe('someone@domain.com')
    expect(c!.password).toBe('mypassword99')
  })

  test('username:pass with no URL or email', () => {
    const c = cred('johndoe:hunter2')
    expect(c).not.toBeNull()
    expect(c!.email).toBe('johndoe')
    expect(c!.password).toBe('hunter2')
  })
})

describe('parseLine — validation rules', () => {
  test('login === password is rejected', () => {
    expect(why('user:user')).toBe('no_password')
  })

  test('password shorter than 3 chars is rejected', () => {
    expect(why('https://site.com:user:ab')).toBe('no_password')
  })

  test('blank line is rejected', () => {
    expect(why('')).toBe('blank')
  })

  test('comment line starting with # is rejected', () => {
    expect(why('# this is a comment')).toBe('blank')
  })

  test('section header starting with [ is rejected', () => {
    expect(why('[Section Header]')).toBe('blank')
  })
})

describe('parseULPContent — rejection_breakdown', () => {
  test('counts blank lines in rejection_breakdown', () => {
    const result = parseULPContent('valid@email.com:password123\n\n# comment\n', 'test.txt')
    expect(result.rejection_breakdown['blank']).toBeGreaterThanOrEqual(2)
    expect(result.credentials.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to confirm the new tests fail (parser not yet rewritten)**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault
npx vitest run --reporter=verbose 2>&1 | tail -30
```

Expected: some new tests FAIL (port disambiguation, colons-in-password may pass or fail depending on current behaviour — document which fail).

---

### Task 1.2: Rewrite `lib/ulp-parser.ts`

**Files:**
- Rewrite: `lib/ulp-parser.ts`

- [ ] **Step 1: Replace the entire file content**

```typescript
/**
 * ULP credential line parser — v5
 *
 * Design: one algorithm, no regex in the hot path, RFC 3986-correct
 * colon disambiguation. ~100 lines for a format that is field:field:field.
 *
 * Algorithm:
 *  1. Skip blank / comment / section-header lines
 *  2. Separator detection: \t → ; → colon (priority)
 *  3. Colon-split with URL boundary + port stripping (RFC 3986)
 *  4. Field assignment: [url, login, pass] or ['', login, pass]
 *  5. Validation: 5 rules only
 *  6. Domain extraction: host between :// and next / or :, port stripped
 */

export interface ULPCredential {
  url:         string
  email:       string
  password:    string
  domain:      string
  source_file: string
}

export type RejectionReason = 'blank' | 'no_fields' | 'no_password'

export interface ParseResult {
  credentials:         ULPCredential[]
  skipped:             number
  errors:              number
  rejection_breakdown: Record<string, number>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip a trailing port (`:digits`) from a hostname. */
function stripPort(host: string): string {
  const m = host.match(/^(.*):(\d+)$/)
  return m ? m[1] : host
}

/**
 * Extract the domain/host from a URL string.
 * Handles http://, https://, bare domains with dots.
 */
function extractDomain(url: string): string {
  const schemeEnd = url.indexOf('://')
  if (schemeEnd !== -1) {
    const afterScheme = url.slice(schemeEnd + 3)
    const slashPos    = afterScheme.indexOf('/')
    const host        = slashPos === -1 ? afterScheme : afterScheme.slice(0, slashPos)
    return stripPort(host).toLowerCase()
  }
  // No scheme — bare domain like site.com/path
  if (url.includes('.')) {
    const slashPos = url.indexOf('/')
    const host     = slashPos === -1 ? url : url.slice(0, slashPos)
    return stripPort(host).toLowerCase()
  }
  return ''
}

/**
 * Split a colon-delimited ULP line into [url, login, password].
 *
 * RFC 3986 rules applied:
 *  - If line contains `://`, the URL ends at the first `/` after the scheme.
 *    The next `:` after that `/` is the login separator.
 *    Ports (`:digits` immediately after host) are absorbed into the URL field.
 *  - If no scheme, treat first two colons as separators; remainder is password.
 */
function colonSplit(line: string): [string, string, string] | null {
  const schemeIdx = line.indexOf('://')
  if (schemeIdx !== -1) {
    // Find first slash after "://"
    const afterScheme = schemeIdx + 3
    const slashIdx    = line.indexOf('/', afterScheme)
    if (slashIdx !== -1) {
      // URL is everything up to the slash (absorbs port)
      const urlPart  = line.slice(0, slashIdx)
      const rest     = line.slice(slashIdx + 1)            // path:login:pass
      const colon1   = rest.indexOf(':')
      if (colon1 === -1) return null                        // no login separator
      // Everything before first colon in `rest` is the path-based login fragment;
      // but in ULP format the path is part of the URL, so rejoin:
      // Actually the URL already ends at slashIdx. rest = "path:login:pass".
      // We need the LAST structural split: find where login starts.
      // The url field = urlPart + "/" + rest.slice(0, colon1)
      const fullUrl  = urlPart + '/' + rest.slice(0, colon1)
      const loginRest = rest.slice(colon1 + 1)             // "login:pass" or "login"
      const colon2   = loginRest.indexOf(':')
      if (colon2 === -1) return null                        // no password
      return [fullUrl, loginRest.slice(0, colon2), loginRest.slice(colon2 + 1)]
    } else {
      // No path — URL is up to end of host:port, then colon separates login
      // e.g. "https://site.com:8443:user:pass"
      // Find host end: everything after :// up to next non-port colon
      const hostStart = afterScheme
      // Consume optional port (digits after colon)
      const portMatch = line.slice(hostStart).match(/^([^:]+):(\d+):/)
      let loginStart: number
      if (portMatch) {
        loginStart = hostStart + portMatch[0].length
      } else {
        const c = line.indexOf(':', hostStart)
        if (c === -1) return null
        loginStart = c + 1
      }
      const urlPart   = line.slice(0, loginStart - 1)
      const loginRest = line.slice(loginStart)
      const colon     = loginRest.indexOf(':')
      if (colon === -1) return null
      return [urlPart, loginRest.slice(0, colon), loginRest.slice(colon + 1)]
    }
  }

  // No scheme — simple split on first two colons; rest is password
  const c1 = line.indexOf(':')
  if (c1 === -1) return null
  const c2 = line.indexOf(':', c1 + 1)
  if (c2 === -1) return [line.slice(0, c1), '', line.slice(c1 + 1)]  // 2-part: login:pass (no URL)
  return [line.slice(0, c1), line.slice(c1 + 1, c2), line.slice(c2 + 1)]
}

// ── Core parse function ───────────────────────────────────────────────────────

export function parseLine(
  line: string,
  sourceFile: string,
): { credential: ULPCredential | null; reason: RejectionReason | null } {
  const trimmed = line.trim()

  // Rule 1: blank / comment / section header
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) {
    return { credential: null, reason: 'blank' }
  }

  // Rule 2: separator detection (\t beats ; beats :)
  let parts: string[]
  if (trimmed.includes('\t')) {
    parts = trimmed.split('\t', 3)
  } else if (trimmed.includes(';')) {
    const s = trimmed.split(';', 3)
    parts = s.length >= 2 ? s : []
  } else {
    const split = colonSplit(trimmed)
    if (!split) return { credential: null, reason: 'no_fields' }
    parts = split
  }

  // Rule 3: field assignment
  let url = '', login = '', password = ''
  if (parts.length >= 3) {
    [url, login, password] = [parts[0].trim(), parts[1].trim(), parts.slice(2).join(':').trim()]
  } else if (parts.length === 2) {
    // Check if first part looks like a URL
    if (parts[0].includes('://') || (parts[0].includes('.') && !parts[0].includes('@'))) {
      return { credential: null, reason: 'no_fields' }  // URL but no login or password
    }
    [login, password] = [parts[0].trim(), parts[1].trim()]
  } else {
    return { credential: null, reason: 'no_fields' }
  }

  // Rule 4: validation
  if (!login)                      return { credential: null, reason: 'no_fields' }
  if (!password || password.length < 3) return { credential: null, reason: 'no_password' }
  if (login === password)          return { credential: null, reason: 'no_password' }

  // Rule 5: domain extraction
  const domain = url ? extractDomain(url) : ''

  return {
    credential: { url, email: login, password, domain, source_file: sourceFile },
    reason: null,
  }
}

// ── Batch / stream parsers ────────────────────────────────────────────────────

export function makeRejectionMap(): Record<string, number> {
  return { blank: 0, no_fields: 0, no_password: 0 }
}

export function parseULPContent(content: string, sourceFile: string): ParseResult {
  const lines       = content.split('\n')
  const credentials: ULPCredential[] = []
  const breakdown   = makeRejectionMap()
  let skipped       = 0

  for (const line of lines) {
    const { credential, reason } = parseLine(line, sourceFile)
    if (credential) {
      credentials.push(credential)
    } else {
      skipped++
      if (reason && reason in breakdown) breakdown[reason]++
    }
  }

  return { credentials, skipped, errors: 0, rejection_breakdown: breakdown }
}

export async function* parseULPStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  batchSize: number,
): AsyncGenerator<ULPCredential[]> {
  const reader  = stream.getReader()
  const decoder = new TextDecoder()
  let   buffer  = ''
  let   batch:  ULPCredential[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const { credential } = parseLine(line, filename)
        if (credential) {
          batch.push(credential)
          if (batch.length >= batchSize) {
            yield batch
            batch = []
          }
        }
      }
    }
    // Flush remaining buffer
    if (buffer) {
      const { credential } = parseLine(buffer, filename)
      if (credential) batch.push(credential)
    }
    if (batch.length > 0) yield batch
  } finally {
    reader.releaseLock()
  }
}
```

- [ ] **Step 2: Run all tests**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault
npx vitest run --reporter=verbose 2>&1 | tail -40
```

Expected: All new edge-case tests PASS. Some old tests that tested `BlockStateMachine` or `url_noscheme_no_pass` rejection reasons may FAIL — fix them in the next step.

- [ ] **Step 3: Update `__tests__/ulp-parser.test.ts` to remove deleted exports**

Remove any `import { BlockStateMachine }` and any `describe('BlockStateMachine', ...)` blocks. Also remove tests that reference removed rejection reasons (`url_noscheme_no_pass`, `no_login`, `url_in_login`, `login_too_short`, `login_is_number`, `login_eq_pass`, `pass_too_short`, `pass_is_scheme`, `block_partial`, `dedup`, `unclassified`).

For tests that checked `why(line) === 'no_login'`, change expected reason to `'no_fields'`. For tests that checked `why(line) === 'pass_too_short'` or `'login_eq_pass'`, change to `'no_password'`.

- [ ] **Step 4: Run all tests — must be 100% green**

```bash
npx vitest run --reporter=verbose 2>&1 | tail -15
```

Expected output:
```
Test Files  2 passed (2)
     Tests  N passed (N)    ← N ≥ 147
```

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: no output (zero errors).

- [ ] **Step 6: Commit**

```bash
git -c user.email="patino.marco21@pm.me" -c user.name="coler" add lib/ulp-parser.ts __tests__/ulp-parser.test.ts
git -c user.email="patino.marco21@pm.me" -c user.name="coler" commit -m "refactor(parser): rewrite to v5 — RFC 3986-correct, ~100 lines, zero regex hot path

Removes: KNOWN_GTLDS, Android package detection, BlockStateMachine,
login_too_short/login_is_number/pass_is_scheme heuristics, 14-category
rejection telemetry (→ 3 categories: blank, no_fields, no_password).

Adds: correct port disambiguation, IPv4 support, colons-in-password
preservation, RFC 3986 @ split for userinfo boundary.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## WS2 — CSV Streaming Insert

### Task 2.1: Switch `insertBatch` from JSONEachRow to CSV streaming

**Files:**
- Modify: `app/api/upload/route.ts`

- [ ] **Step 1: Add CSV escape helper and rewrite `insertBatch` in `app/api/upload/route.ts`**

Find the `insertBatch` function (starts around line 29) and replace it entirely:

```typescript
import { Readable } from "stream"

/** Escape a field value for ClickHouse CSV: wrap in quotes, double internal quotes. */
function csvField(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

/**
 * Insert a batch of credentials into ClickHouse as a streaming CSV Readable.
 *
 * Why CSV + Readable instead of JSONEachRow + array:
 *   - No heap materialisation of 500K objects + JSON serialisation
 *   - ClickHouse JS client streams the Readable as chunked HTTP body
 *   - Peak memory: O(1) per row instead of O(batch_size)
 */
async function insertBatch(
  credentials: ULPCredential[],
  breach_name: string,
): Promise<void> {
  if (credentials.length === 0) return
  const chClient = getClient()

  const csvRows = credentials.map(c =>
    [
      csvField(c.url),
      csvField(c.email),
      csvField(c.password),
      csvField(c.domain),
      csvField(c.source_file),
      csvField(breach_name),
    ].join(',')
  ).join('\n')

  const readable = Readable.from([csvRows])

  await chClient.insert({
    table: 'ulp.credentials',
    values: readable,
    format: 'CSV',
    clickhouse_settings: {
      async_insert:          1 as any,
      wait_for_async_insert: 1 as any,
      max_execution_time:    0,
      // Column order must match the CSV (no header row in plain CSV format)
      input_format_csv_column_names: 0 as any,
    },
    // Column order for headerless CSV
    columns: ['url', 'email', 'password', 'domain', 'source_file', 'breach_name'],
  })
}
```

Also add `import { Readable } from "stream"` at the top of the file if not already present.

- [ ] **Step 2: Run all tests**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault
npx vitest run 2>&1 | tail -8
```

Expected: all pass (insert logic is not covered by unit tests — integration tested manually).

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git -c user.email="patino.marco21@pm.me" -c user.name="coler" add app/api/upload/route.ts
git -c user.email="patino.marco21@pm.me" -c user.name="coler" commit -m "perf(upload): stream CSV to ClickHouse instead of JSONEachRow object array

Eliminates 500K-object JS heap materialisation per batch.
ClickHouse JS client streams the Readable as chunked HTTP body.
Batch size (500K rows) and async_insert settings unchanged.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## WS3 — SSE Upload Progress

### Task 3.1: Create the job store

**Files:**
- Create: `lib/upload-jobs.ts`

- [ ] **Step 1: Create `lib/upload-jobs.ts`**

```typescript
/**
 * In-process upload job store.
 *
 * Stores running/completed upload jobs so the SSE endpoint can push
 * progress events to the browser. Jobs expire after 10 minutes.
 *
 * Note: single-process only. Works for self-hosted Next.js.
 */

export type JobStatus = 'running' | 'done' | 'error'

export interface UploadJob {
  id:          string
  status:      JobStatus
  imported:    number
  skipped:     number
  total_lines: number      // estimated from file size / 60 bytes per line
  breach_name: string
  started_at:  number      // Date.now()
  rejection_breakdown: Record<string, number>
  error?:      string
  // SSE writer — set by the progress endpoint, written to by the upload pipeline
  writer?:     WritableStreamDefaultWriter<Uint8Array>
}

const jobs = new Map<string, UploadJob>()

/** Create a new job and return it. */
export function createJob(id: string, totalLines: number, breachName: string): UploadJob {
  const job: UploadJob = {
    id,
    status:      'running',
    imported:    0,
    skipped:     0,
    total_lines: totalLines,
    breach_name: breachName,
    started_at:  Date.now(),
    rejection_breakdown: { blank: 0, no_fields: 0, no_password: 0 },
  }
  jobs.set(id, job)
  return job
}

export function getJob(id: string): UploadJob | undefined {
  return jobs.get(id)
}

export function updateJob(id: string, patch: Partial<UploadJob>): void {
  const job = jobs.get(id)
  if (job) Object.assign(job, patch)
}

/** Push an SSE event to the job's connected browser, if any. */
export async function pushEvent(job: UploadJob): Promise<void> {
  if (!job.writer) return
  const pct     = job.total_lines > 0
    ? Math.min(100, Math.round((job.imported / job.total_lines) * 100))
    : 0
  const elapsed = Date.now() - job.started_at
  const payload = JSON.stringify({
    imported:            job.imported,
    skipped:             job.skipped,
    pct,
    elapsed_ms:          elapsed,
    status:              job.status,
    rejection_breakdown: job.status === 'done' ? job.rejection_breakdown : undefined,
    error:               job.error,
  })
  try {
    const enc = new TextEncoder()
    await job.writer.write(enc.encode(`data: ${payload}\n\n`))
    if (job.status === 'done' || job.status === 'error') {
      await job.writer.close()
      job.writer = undefined
    }
  } catch {
    // Client disconnected — ignore
    job.writer = undefined
  }
}

// GC expired jobs every 5 minutes (keep for 10 minutes after completion)
const GC_INTERVAL_MS  = 5 * 60 * 1000
const JOB_TTL_MS      = 10 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - job.started_at > JOB_TTL_MS) {
      jobs.delete(id)
    }
  }
}, GC_INTERVAL_MS)
```

- [ ] **Step 2: TypeScript check**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: zero errors.

---

### Task 3.2: Create the SSE progress endpoint

**Files:**
- Create: `app/api/upload/progress/[jobId]/route.ts`

- [ ] **Step 1: Create directory and file**

```bash
mkdir -p "C:\Users\coler\Desktop\vault-refactor\bron-vault\app\api\upload\progress\[jobId]"
```

- [ ] **Step 2: Write `app/api/upload/progress/[jobId]/route.ts`**

```typescript
/**
 * GET /api/upload/progress/:jobId
 *
 * Server-Sent Events stream for upload progress.
 * Uses TransformStream so the Response is returned immediately while
 * the upload pipeline pushes events via the writer stored on the job.
 *
 * Next.js App Router buffers responses until the handler returns, so
 * we must return the readable side immediately and write asynchronously.
 */
import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getJob, pushEvent } from "@/lib/upload-jobs"

export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { jobId } = await params
  const job = getJob(jobId)

  if (!job) {
    return NextResponse.json({ success: false, error: "Job not found" }, { status: 404 })
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()

  // Store writer on the job so the upload pipeline can push events
  job.writer = writer

  // If the job is already done (client reconnected after completion), push final state and close
  if (job.status === 'done' || job.status === 'error') {
    pushEvent(job).catch(() => {})
  }

  return new Response(readable, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx buffering for SSE
    },
  })
}
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: zero errors.

---

### Task 3.3: Modify upload route to fire-and-forget + return jobId

**Files:**
- Modify: `app/api/upload/route.ts`

- [ ] **Step 1: Add imports to `app/api/upload/route.ts`**

At the top of the file, add:
```typescript
import { createJob, getJob, updateJob, pushEvent } from "@/lib/upload-jobs"
```

- [ ] **Step 2: Add a `runUploadWithProgress` wrapper function**

Add this function after `processTextContent`:

```typescript
/**
 * Wrap processTextStream / processTextContent to push SSE progress events
 * to the job store every 2 seconds during ingestion.
 */
async function runWithProgress(
  jobId: string,
  fn: () => Promise<{ imported: number; skipped: number; errors: number; filename: string; breach_name: string; rejection_breakdown: Record<string, number> }>
): Promise<void> {
  const job = getJob(jobId)
  if (!job) return

  // Push progress every 2 seconds
  const interval = setInterval(async () => {
    const j = getJob(jobId)
    if (j) await pushEvent(j)
  }, 2000)

  try {
    const result = await fn()
    updateJob(jobId, {
      status:              'done',
      imported:            result.imported,
      skipped:             result.skipped,
      rejection_breakdown: result.rejection_breakdown,
    })
    await pushEvent(getJob(jobId)!)
  } catch (err) {
    updateJob(jobId, {
      status: 'error',
      error:  err instanceof Error ? err.message : 'Upload failed',
    })
    const j = getJob(jobId)
    if (j) await pushEvent(j)
  } finally {
    clearInterval(interval)
  }
}
```

- [ ] **Step 3: Update the POST handler to return `{ jobId }` immediately**

Find the `POST` export function. Locate where it calls `processTextStream` or `processTextContent` and awaits the result, then returns it as JSON.

Replace the synchronous-await pattern with a fire-and-forget pattern. The POST handler should:

1. Validate auth + file
2. Generate `jobId = crypto.randomUUID()`
3. Estimate `total_lines = Math.floor(fileSize / 60)` (60 bytes per line average)
4. Call `createJob(jobId, total_lines, breach_name)`
5. Start `runWithProgress(jobId, () => processTextStream(...))` without `await`
6. Return `{ success: true, jobId }` immediately

Example (adapt to match the actual POST handler structure — do not copy-paste blindly, read the existing handler first):

```typescript
const jobId = crypto.randomUUID()
const totalLines = Math.floor((file.size || 0) / 60)
createJob(jobId, totalLines, matchBreach(filename))

// Fire and forget — progress via SSE
runWithProgress(jobId, () => processTextStream(stream, filename)).catch(console.error)

return NextResponse.json({ success: true, jobId, streamUrl: `/api/upload/progress/${jobId}` })
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: zero errors.

---

### Task 3.4: Update upload page UI

**Files:**
- Modify: `app/upload/page.tsx`

- [ ] **Step 1: Add `Progress` import if not present and new state vars**

At the top of `UploadPage`, add state:

```typescript
const [jobId, setJobId]           = useState<string | null>(null)
const [liveImported, setLiveImported] = useState(0)
const [liveSkipped, setLiveSkipped]   = useState(0)
const [livePct, setLivePct]           = useState(0)
const [elapsedMs, setElapsedMs]       = useState(0)
const eventSourceRef                  = useRef<EventSource | null>(null)
```

- [ ] **Step 2: Add `startSSE` helper inside the component**

```typescript
function startSSE(id: string) {
  setJobId(id)
  setLiveImported(0); setLiveSkipped(0); setLivePct(0); setElapsedMs(0)

  const es = new EventSource(`/api/upload/progress/${id}`)
  eventSourceRef.current = es

  es.onmessage = (e) => {
    const data = JSON.parse(e.data)
    setLiveImported(data.imported ?? 0)
    setLiveSkipped(data.skipped ?? 0)
    setLivePct(data.pct ?? 0)
    setElapsedMs(data.elapsed_ms ?? 0)

    if (data.status === 'done') {
      setState('success')
      setResult({
        imported:            data.imported,
        skipped:             data.skipped,
        errors:              0,
        filename:            '',
        rejection_breakdown: data.rejection_breakdown,
      })
      es.close()
    }
    if (data.status === 'error') {
      setState('error')
      toast({ title: data.error || 'Upload failed', variant: 'destructive' })
      es.close()
    }
  }

  es.onerror = () => {
    es.close()
  }
}
```

- [ ] **Step 3: Update submit handler to call `startSSE`**

Find where the component `await fetch('/api/upload', ...)` and processes the JSON result. Change it to:

```typescript
const data = await res.json()
if (!data.success) throw new Error(data.error || 'Upload failed')
if (data.jobId) {
  // Streaming upload — switch to SSE progress mode
  startSSE(data.jobId)
} else {
  // Legacy synchronous response (ZIP entries still return immediately)
  setState('success')
  setResult(data)
}
```

- [ ] **Step 4: Add live progress UI in the uploading state**

Find where `state === 'uploading'` renders the spinner. Replace or augment it with:

```tsx
{state === 'uploading' && (
  <Card>
    <CardContent className="p-6 space-y-4">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Importing…</span>
        <span className="text-muted-foreground tabular-nums">
          {(elapsedMs / 1000).toFixed(0)}s elapsed
        </span>
      </div>
      <Progress value={livePct} className="h-2" />
      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>{liveImported.toLocaleString()} imported</span>
        <span>{livePct}%</span>
        <span>{liveSkipped.toLocaleString()} skipped</span>
      </div>
    </CardContent>
  </Card>
)}
```

- [ ] **Step 5: Run tests + TypeScript check**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault
npx vitest run 2>&1 | tail -8 && npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: all tests pass, zero TS errors.

- [ ] **Step 6: Commit WS3**

```bash
git -c user.email="patino.marco21@pm.me" -c user.name="coler" add \
  lib/upload-jobs.ts \
  "app/api/upload/progress/[jobId]/route.ts" \
  app/api/upload/route.ts \
  app/upload/page.tsx
git -c user.email="patino.marco21@pm.me" -c user.name="coler" commit -m "feat(upload): SSE live progress — jobId returned immediately, events pushed every 2s

POST /api/upload now returns { jobId } immediately (fire-and-forget).
GET /api/upload/progress/:jobId streams SSE events with imported/skipped/pct/elapsed.
Upload page shows live progress bar + counters instead of a blank spinner.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## WS4 — Scheduled Monitor Re-Scans

### Task 4.1: SQLite schema migration

**Files:**
- Modify: `lib/sqlite.ts`

- [ ] **Step 1: Add columns to the `domain_monitors` CREATE TABLE statement**

In `lib/sqlite.ts`, find the `domain_monitors` CREATE TABLE block and add the two new columns before the closing `)`:

```sql
-- Before the closing ) of CREATE TABLE domain_monitors:
rescan_mode TEXT NOT NULL DEFAULT 'dedup' CHECK(rescan_mode IN ('dedup','digest')),
rescan_interval_hours INTEGER NOT NULL DEFAULT 24
```

Also add `ALTER TABLE` migration calls **after** the CREATE TABLE block to handle existing databases:

```typescript
// Add rescan columns to existing databases (idempotent — errors are swallowed)
const db = getDb()
try { db.exec(`ALTER TABLE domain_monitors ADD COLUMN rescan_mode TEXT NOT NULL DEFAULT 'dedup' CHECK(rescan_mode IN ('dedup','digest'))`) } catch {}
try { db.exec(`ALTER TABLE domain_monitors ADD COLUMN rescan_interval_hours INTEGER NOT NULL DEFAULT 24`) } catch {}
```

Place these calls inside the same initialization block that runs the `CREATE TABLE` statements (look for the `db.exec(...)` pattern in `lib/sqlite.ts`).

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: zero errors.

---

### Task 4.2: Update `DomainMonitor` type and `updateMonitor`

**Files:**
- Modify: `lib/domain-monitor.ts`

- [ ] **Step 1: Add fields to `DomainMonitor` interface**

Find the `DomainMonitor` interface and add:

```typescript
rescan_mode:           'dedup' | 'digest'
rescan_interval_hours: number
```

- [ ] **Step 2: Update `parseMonitorRow` to read new columns**

Find `parseMonitorRow` and add:

```typescript
rescan_mode:           (row.rescan_mode as 'dedup' | 'digest') ?? 'dedup',
rescan_interval_hours: (row.rescan_interval_hours as number) ?? 24,
```

- [ ] **Step 3: Update `updateMonitor` to accept new fields**

Find the `updateMonitor` function signature and add to its `data` parameter type:

```typescript
rescan_mode?: 'dedup' | 'digest'
rescan_interval_hours?: number
```

And in the SQL update, include these fields when provided:

```typescript
if (data.rescan_mode !== undefined) {
  fields.push(`rescan_mode = ?`)
  values.push(data.rescan_mode)
}
if (data.rescan_interval_hours !== undefined) {
  fields.push(`rescan_interval_hours = ?`)
  values.push(data.rescan_interval_hours)
}
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: zero errors.

---

### Task 4.3: Create the cron scheduler

**Files:**
- Create: `lib/monitor-rescan-cron.ts`

- [ ] **Step 1: Write `lib/monitor-rescan-cron.ts`**

```typescript
/**
 * Scheduled domain monitor re-scanner.
 *
 * Runs every 15 minutes (setInterval — no external dependency).
 * For each active monitor whose rescan_interval_hours has elapsed since
 * last_triggered_at, re-runs the ClickHouse domain query and fires
 * webhooks according to rescan_mode:
 *   'dedup'  — only new credentials (not in monitor_credential_seen)
 *   'digest' — all current matches regardless of prior alerts
 *
 * NODE_ENV guard in instrumentation.ts prevents dev hot-reload double-registration.
 */

import { dbQuery, dbRun } from '@/lib/sqlite'
import { executeQuery } from '@/lib/clickhouse'
import { checkMonitorsForULPUpload } from '@/lib/domain-monitor'

const TICK_MS = 15 * 60 * 1000  // 15 minutes

interface DueMonitor {
  id:                    number
  name:                  string
  domains:               string
  match_mode:            string
  rescan_mode:           'dedup' | 'digest'
  rescan_interval_hours: number
}

async function runTick(): Promise<void> {
  const now = Math.floor(Date.now() / 1000)  // unix seconds

  const dueMonitors = dbQuery(`
    SELECT id, name, domains, match_mode, rescan_mode, rescan_interval_hours
    FROM domain_monitors
    WHERE is_active = 1
      AND (
        last_triggered_at IS NULL
        OR (unixepoch('now') - unixepoch(last_triggered_at)) >= rescan_interval_hours * 3600
      )
  `) as DueMonitor[]

  if (dueMonitors.length === 0) return

  console.log(`[monitor-rescan] tick: ${dueMonitors.length} monitor(s) due`)

  let fired = 0
  let skipped = 0

  for (const monitor of dueMonitors) {
    try {
      let domains: string[]
      try { domains = JSON.parse(monitor.domains) } catch { domains = [] }
      if (domains.length === 0) { skipped++; continue }

      if (monitor.rescan_mode === 'digest') {
        // Digest: clear seen fingerprints for this monitor so all matches re-fire
        dbRun(`DELETE FROM monitor_credential_seen WHERE monitor_id = ?`, [monitor.id])
      }

      // Re-use the same trigger pipeline as upload, scoped to this monitor's domains
      // checkMonitorsForULPUpload fires all active monitors, but only the due one
      // will have matching domains. We call it with a synthetic "rescan" source name.
      await checkMonitorsForULPUpload(`__rescan__monitor_${monitor.id}__`)

      // Update last_triggered_at
      dbRun(`
        UPDATE domain_monitors
        SET last_triggered_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `, [monitor.id])

      fired++
    } catch (err) {
      console.error(`[monitor-rescan] monitor ${monitor.id} error:`, err)
      skipped++
    }
  }

  console.log(`[monitor-rescan] done: fired=${fired} skipped=${skipped}`)
}

let started = false

export function startMonitorRescanCron(): void {
  if (started) return
  started = true
  console.log('[monitor-rescan] cron started — tick every 15 minutes')
  // Run once immediately on startup (after a 30s delay to let the server warm up)
  setTimeout(() => { runTick().catch(console.error) }, 30_000)
  setInterval(() => { runTick().catch(console.error) }, TICK_MS)
}
```

---

### Task 4.4: Register cron in `instrumentation.ts`

**Files:**
- Modify: `instrumentation.ts`

- [ ] **Step 1: Add cron registration to `register()`**

Inside the `if (process.env.NEXT_RUNTIME === 'nodejs')` block, after the ClickHouse migrations call, add:

```typescript
    // Start scheduled monitor re-scanner (production only — prevents dev hot-reload duplicates)
    if (process.env.NODE_ENV === 'production') {
      try {
        const { startMonitorRescanCron } = await import('./lib/monitor-rescan-cron')
        startMonitorRescanCron()
      } catch (err) {
        console.error('[instrumentation] Monitor rescan cron failed to start:', err)
      }
    }
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: zero errors.

---

### Task 4.5: Update monitor API to accept new fields

**Files:**
- Modify: `app/api/monitoring/monitors/[id]/route.ts`

- [ ] **Step 1: Update the `PUT` handler body parsing**

Find where `const { name, domains, match_mode, webhook_ids, is_active } = body` is destructured and add the new fields:

```typescript
const { name, domains, match_mode, webhook_ids, is_active, rescan_mode, rescan_interval_hours } = body
```

- [ ] **Step 2: Validate and pass new fields to `updateMonitor`**

Add validation:
```typescript
if (rescan_mode !== undefined && !['dedup', 'digest'].includes(rescan_mode)) {
  return NextResponse.json(
    { success: false, error: "rescan_mode must be 'dedup' or 'digest'" },
    { status: 400 }
  )
}
if (rescan_interval_hours !== undefined) {
  const h = parseInt(rescan_interval_hours)
  if (isNaN(h) || h < 1 || h > 168) {
    return NextResponse.json(
      { success: false, error: "rescan_interval_hours must be 1–168" },
      { status: 400 }
    )
  }
}
```

Pass to `updateMonitor`:
```typescript
await updateMonitor(monitorId, {
  // ...existing fields...
  rescan_mode:           rescan_mode,
  rescan_interval_hours: rescan_interval_hours ? parseInt(rescan_interval_hours) : undefined,
})
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: zero errors.

---

### Task 4.6: Add rescan fields to monitoring UI

**Files:**
- Modify: `app/monitoring/page.tsx`

- [ ] **Step 1: Add state vars for new fields**

In the component that handles monitor create/edit, add:

```typescript
const [rescanMode, setRescanMode]           = useState<'dedup' | 'digest'>('dedup')
const [rescanIntervalHours, setRescanIntervalHours] = useState(24)
```

- [ ] **Step 2: Add UI controls to the create/edit form**

After the existing `match_mode` selector in the form, add:

```tsx
{/* Re-scan mode */}
<div className="space-y-2">
  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
    Re-scan mode
  </label>
  <div className="flex gap-3">
    {(['dedup', 'digest'] as const).map(mode => (
      <button
        key={mode}
        type="button"
        onClick={() => setRescanMode(mode)}
        className={`flex-1 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${
          rescanMode === mode
            ? 'border-primary bg-primary/10 text-primary font-medium'
            : 'border-border text-muted-foreground hover:border-muted-foreground'
        }`}
      >
        <span className="font-medium capitalize">{mode}</span>
        <span className="block text-xs opacity-70 mt-0.5">
          {mode === 'dedup'
            ? 'Only new credentials (no duplicate alerts)'
            : 'All current matches every interval'}
        </span>
      </button>
    ))}
  </div>
</div>

{/* Re-scan interval */}
<div className="space-y-1">
  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
    Re-scan every (hours)
  </label>
  <div className="flex items-center gap-2">
    <input
      type="number"
      min={1}
      max={168}
      value={rescanIntervalHours}
      onChange={e => setRescanIntervalHours(Math.max(1, Math.min(168, parseInt(e.target.value) || 24)))}
      className="w-24 h-9 rounded-md border border-input bg-background px-3 text-sm"
    />
    <span className="text-sm text-muted-foreground">hours (1–168)</span>
  </div>
</div>
```

- [ ] **Step 3: Include fields in form submit body**

Find where the form submits (likely a `fetch('/api/monitoring/monitors', ...)` or similar). Add to the request body:

```typescript
rescan_mode:           rescanMode,
rescan_interval_hours: rescanIntervalHours,
```

- [ ] **Step 4: Populate fields when editing an existing monitor**

Find where existing monitor data is loaded into form state (likely a `useEffect` that sets form fields from monitor data). Add:

```typescript
setRescanMode(monitor.rescan_mode ?? 'dedup')
setRescanIntervalHours(monitor.rescan_interval_hours ?? 24)
```

- [ ] **Step 5: Run all tests + TypeScript check**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault
npx vitest run 2>&1 | tail -8 && npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: all tests pass, zero TS errors.

- [ ] **Step 6: Commit WS4**

```bash
git -c user.email="patino.marco21@pm.me" -c user.name="coler" add \
  lib/sqlite.ts \
  lib/domain-monitor.ts \
  lib/monitor-rescan-cron.ts \
  instrumentation.ts \
  "app/api/monitoring/monitors/[id]/route.ts" \
  app/monitoring/page.tsx
git -c user.email="patino.marco21@pm.me" -c user.name="coler" commit -m "feat(monitoring): scheduled re-scans with configurable dedup/digest mode

Adds rescan_mode ('dedup'|'digest') and rescan_interval_hours (1-168)
per monitor. 15-minute cron tick in instrumentation.ts (production only)
queries due monitors and fires webhooks via existing triggerMonitorAlerts.
Monitor edit form exposes both fields.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] **Run full test suite**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault
npx vitest run --reporter=verbose 2>&1 | tail -10
```

Expected:
```
Test Files  2 passed (2)
     Tests  N passed (N)
```

- [ ] **TypeScript clean**

```bash
npx tsc --noEmit --skipLibCheck 2>&1
```

Expected: zero output.
