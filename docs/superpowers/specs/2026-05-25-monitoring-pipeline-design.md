# Monitoring & Pipeline Sprint — Design Spec
**Date:** 2026-05-25  
**Status:** Approved  
**Scope:** Four independent workstreams targeting 100B+ row scale

---

## Context

BronVault is a ULP (URL:Login:Password) credential intelligence platform built on Next.js 14 + ClickHouse + SQLite. The system ingests stealer log dumps and exposes search, monitoring, and alerting features.

**Scale target:** tens to hundreds of billions of credential lines.  
**Known problems going in:**
- Parser is 674 lines for a format that is `field:field:field` — over-engineering causes wrong rejections
- Insert pipeline materialises 500K JavaScript objects per batch — GC pressure at sustained ingestion
- No upload progress visibility — blank spinner for minutes on large files
- Domain monitors only fire on upload — no background re-scan between uploads

---

## Workstream 1 — Parser Rewrite

### Goal
Replace the 674-line v4 parser with an ~80-line implementation. Zero regex in the hot path. Five validation rules only.

### Algorithm

**Step 1 — Separator detection (one pass, priority order)**
- `\t` found → split on tab (max 3 parts)
- `;` found → split on semicolon (max 3 parts)
- Otherwise → colon-split (see below)

**Step 2 — Colon-split**
- Scan for `://` to find URL boundary at position P
- If found: next `:` after the first `/` following P is the login separator; everything after second `:` is password (colons preserved)
- If not found: `split(':', 3)` — first two colons are separators, remainder is password

**Step 3 — Field assignment**
- 3 parts → `[url, login, password]`
- 2 parts → `['', parts[0], parts[1]]` (no URL)
- < 2 parts → SKIP

**Step 4 — Validation (5 rules, no heuristics)**
1. Skip blank lines and lines starting with `#` or `[`
2. Skip if login is empty after trim
3. Skip if password is empty after trim
4. Skip if login === password
5. Skip if password length < 3

**Step 5 — Domain extraction**
- URL starts with `http://` or `https://`: take substring between `://` and next `/` or `:`
- URL contains `.`: take up to first `/` or `:`
- Otherwise: leave domain empty

### Removals and rationale

| Removed | Reason |
|---|---|
| `KNOWN_GTLDS` set (300+ entries) | Domain validation at parse time loses valid data. Filter at query time. |
| Android package detection regex | False-positive rate on real ULP dumps >> false-negative rate on actual Android lines. Net negative. |
| Block state machine (URL:/Username:/Password:) | <0.1% of real ULP dumps. Store fails; import edge cases manually. |
| `login_too_short`, `login_is_number` heuristics | Rejects valid short usernames and numeric IDs. Store everything. |
| `login_eq_pass` dedup | `WHERE email != password` at query time costs nothing. |
| In-parser dedup tracking | Move to insert layer. `source_file` column differentiates duplicates. |
| 14-category rejection telemetry | Retain 3: `blank`, `no_fields`, `no_password`. Others are too aggressive. |

### Interface (unchanged — backward compatible)
```typescript
export interface ULPCredential { url: string; email: string; password: string; domain: string; source_file: string }
export interface ParseResult { credentials: ULPCredential[]; skipped: number; errors: number; rejection_breakdown: Record<string, number> }
export function parseULPContent(content: string, sourceFile: string): ParseResult
export async function* parseULPStream(stream: ReadableStream<Uint8Array>, filename: string, batchSize: number): AsyncGenerator<ULPCredential[]>
```

---

## Workstream 2 — Insert Pipeline

### Goal
Eliminate 500K-object JavaScript heap materialisation per batch. True streaming from parse → insert.

### Architecture

```
File stream
  → line splitter (TextDecoderStream + line accumulator)
  → parser (yields one ULPCredential at a time)
  → ring buffer (fills to BATCH_SIZE rows)
  → client.insert(format: 'TabSeparated', stream: Readable)
  → ClickHouse (async_insert=1 server-side buffering)
```

### Key changes

**`parseULPStream`**: interface unchanged — still yields `ULPCredential[]` batches of `batchSize` rows. The internal accumulation loop is simplified by the leaner parser (fewer branches per line).

**`insertBatch`**: signature unchanged externally, but internally builds a Node.js `Readable` of CSV rows and passes it directly to `client.insert()` with `format: 'CSV'` (confirmed faster than TabSeparated for streaming bulk inserts per ClickHouse JS docs). The 500K array is streamed out to ClickHouse row-by-row rather than `JSON.stringify`-d in one shot.

```typescript
// pattern: stream array as CSV to ClickHouse
const readable = Readable.from(credentials.map(c =>
  `"${esc(c.url)}","${esc(c.email)}","${esc(c.password)}","${esc(c.domain)}","${esc(c.source_file)}","${breach_name}"\n`
))
await client.insert({ table: 'ulp.credentials', values: readable, format: 'CSV' })
```

**Batch size**: remains 500K rows. With `async_insert = 1` the server buffers and merges — correct at this scale.

**Peak heap**: drops from ~400MB (500K parsed objects + JSON serialisation) to ~2MB (constant, one line at a time).

**Settings unchanged**: `async_insert = 1`, `wait_for_async_insert = 1`, `async_insert_max_data_size`, `async_insert_busy_timeout_ms` — all stay as tuned.

---

## Workstream 3 — SSE Upload Progress

### Goal
Replace the blank spinner with live line counters and a progress bar during upload.

### API changes

**`POST /api/upload`** returns immediately:
```json
{ "success": true, "jobId": "abc123", "streamUrl": "/api/upload/progress/abc123" }
```

**`GET /api/upload/progress/:jobId`** — Server-Sent Events stream:
```
Content-Type: text/event-stream
Cache-Control: no-cache

data: {"imported":1240000,"skipped":3200,"pct":24.8,"elapsed_ms":4200,"status":"running"}

data: {"imported":4980000,"skipped":9100,"pct":100,"elapsed_ms":17800,"status":"done","rejection_breakdown":{"blank":120,"no_fields":45,"no_password":31}}
```

### In-process job store (`lib/upload-jobs.ts`)

```typescript
interface UploadJob {
  id: string
  status: 'running' | 'done' | 'error'
  imported: number
  skipped: number
  total_lines: number    // estimated: file_size_bytes / 60
  breach_name: string
  started_at: number
  result?: ParseResult
  error?: string
}

const jobs = new Map<string, UploadJob>()
// Jobs expire after 10 minutes (GC via setInterval)
```

### SSE implementation constraint
Next.js App Router buffers the entire response body until the route handler returns. The SSE route **must** use a `TransformStream` whose writer is passed into the upload job, written to during ingestion, and closed on completion. The route handler returns `new Response(readable, { headers })` immediately — the upload runs asynchronously and pushes events through the stream writer.

```typescript
// GET /api/upload/progress/:jobId
const { readable, writable } = new TransformStream()
job.writer = writable.getWriter()  // stored on the job; upload pipeline writes to it
return new Response(readable, {
  headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
})
```

### Frontend changes (`app/upload/page.tsx`)

1. On submit: `POST /api/upload` → receive `{ jobId }`
2. Open `new EventSource("/api/upload/progress/" + jobId)`
3. Render: progress bar (`pct`), imported counter, skipped counter, elapsed timer
4. On `status: done`: close EventSource, show final stat cards (same as today)
5. On `status: error`: close EventSource, show destructive toast

### Edge cases

| Case | Handling |
|---|---|
| User navigates away mid-upload | Upload continues server-side; result stored 10min |
| Browser drops SSE connection | Client `EventSource` auto-reconnects; server replays last state |
| Multiple concurrent uploads | Each gets unique `jobId`; `Map` supports N concurrent |
| File size unknown (streaming) | Estimate `total_lines = content_length / 60`; show `?` if no Content-Length |

---

## Workstream 4 — Scheduled Monitor Re-Scans

### Goal
Make domain monitors fire on a schedule, not only on upload.

### Schema changes

```sql
-- SQLite: domain_monitors table
ALTER TABLE domain_monitors
  ADD COLUMN rescan_mode TEXT NOT NULL DEFAULT 'dedup'
    CHECK(rescan_mode IN ('dedup','digest'));

ALTER TABLE domain_monitors
  ADD COLUMN rescan_interval_hours INTEGER NOT NULL DEFAULT 24;
```

**`rescan_mode = 'dedup'`**: fire webhooks only for credentials not already in `monitor_credential_seen`.  
**`rescan_mode = 'digest'`**: fire webhooks for all current matches (periodic summary).  
**`rescan_interval_hours`**: 1–168, enforced at API layer. Default: 24.

### Cron registration (`instrumentation.ts`)

```typescript
if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NODE_ENV === 'production') {
  const { startMonitorRescanCron } = await import('./lib/monitor-rescan-cron')
  startMonitorRescanCron()
}
```

NODE_ENV guard prevents double-registration on dev hot-reload.

### Scheduler logic (`lib/monitor-rescan-cron.ts`)

**Tick interval**: 15 minutes (`setInterval` — no new dependency).

**Per tick:**
1. Query SQLite for active monitors where `last_triggered_at IS NULL OR (unixepoch('now') - unixepoch(last_triggered_at)) >= rescan_interval_hours * 3600`
2. For each due monitor:
   - Run ClickHouse query against `ulp.credentials` filtered to monitor's domains
   - If `rescan_mode = 'dedup'`: exclude fingerprints in `monitor_credential_seen`
   - If `rescan_mode = 'digest'`: include all matches
   - Fire webhooks via existing `triggerMonitorAlerts()`
   - Update `last_triggered_at = datetime('now')` in SQLite
3. Log: `[monitor-rescan] tick: due=N fired=M skipped=K elapsed=Xms`

### UI changes (`app/monitoring/page.tsx` — monitor edit form)

Two new fields on the create/edit monitor form:
- **Re-scan mode**: radio group — `Deduplicated` / `Digest`
- **Re-scan every**: number input (1–168) + "hours" label

---

## Non-goals (explicitly out of scope)

- Email/SMS notifications (deferred — webhook-only remains)
- k-Anonymity password hash endpoint (deferred)
- Redis / BullMQ queue (single-process setInterval is sufficient)
- ClickHouse schema changes (existing schema already optimised for 100B+ rows)
- Parser dedup (move to query layer, not parse layer)
- Block-format log parsing (`URL:\nUsername:\nPassword:`) — user confirmed format is `url:login:password`; block logs imported manually if needed

## Future features (tracked, not in scope)

- **Session token / cookie monitoring** — 2025–2026 differentiator across SpyCloud, Hudson Rock, Intel 471. Requires storing cookie/session fields from infostealer logs, not just ULP triples.
- **APT-to-infostealer attribution** — link credential dumps to specific malware families / threat actors.
- **Email notifications for monitors** — deferred pending SMTP infrastructure decision.

---

## Implementation order

These four workstreams are **independent** — no shared state, no sequential dependency. They will be executed as parallel agents:

1. **Parser rewrite** (`lib/ulp-parser.ts`) — highest impact, touches only one file
2. **Insert pipeline** (`app/api/upload/route.ts` + parser stream interface) — depends on parser interface staying stable (it does)
3. **SSE progress** (`lib/upload-jobs.ts` + new SSE route + upload page) — fully independent
4. **Cron re-scanner** (`lib/monitor-rescan-cron.ts` + SQLite migration + monitor UI) — fully independent

All existing Vitest tests must pass. New tests required for parser rewrite (property-based: valid lines must parse, blank/short lines must be rejected).
