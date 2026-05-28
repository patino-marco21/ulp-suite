# Processing Queue Observability — Design Spec

## Goal

Give full visibility into both upload paths (HTTP multi-file queue and inbox folder watcher) for long-running batch processing — persistent audit trail, live queue state API, and a always-visible status panel on the upload page.

---

## Background — Current Gaps

| Path | What works | What's missing |
|---|---|---|
| HTTP multi-file upload | SSE per-file progress, File N/M badge, aggregate results | `queue_position` returned but not shown; no persistent history |
| Inbox watcher | Processes files one-at-a-time, moves to done/failed | Console-only output; no SQLite audit; no API; no UI presence |

If you drop 500 files into `inbox/` at 11 pm and come back at 8 am, there is currently no way to know what ran, how many rows were imported, or which files failed — unless you have Docker logs open.

---

## Architecture

Three layers added on top of the existing queue:

1. **`processing_jobs` SQLite table** — one row written per completed file by both upload paths
2. **`GET /api/upload/queue-status`** — single endpoint returning live queue state + recent history + lifetime totals
3. **`QueueStatusPanel` React component** — always-visible card on `/upload` that polls the endpoint every 3 s

Plus two tiny changes to the existing modules:
- `lib/upload-queue.ts` gains `setCurrentJob` / `getCurrentJob` (module-level variable)
- `lib/processing-log.ts` (new) — shared helper that writes to `processing_jobs`

---

## Section 1 — `processing_jobs` SQLite Table

Add to `lib/sqlite.ts` `initSchema()`:

```sql
CREATE TABLE IF NOT EXISTS processing_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT    NOT NULL,          -- 'http' | 'inbox'
  filename      TEXT    NOT NULL,
  status        TEXT    NOT NULL,          -- 'done' | 'failed'
  imported      INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  breach_name   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
)
```

**Index for the status panel query** (recent jobs, newest first):
```sql
CREATE INDEX IF NOT EXISTS idx_processing_jobs_created
  ON processing_jobs (created_at DESC)
```

One row per completed file — both successful and failed. The table is kept indefinitely (rows are tiny: ~200 bytes each; 10,000 files ≈ 2 MB).

---

## Section 2 — lib/processing-log.ts

New shared helper. Both `lib/inbox-watcher.ts` and `app/api/upload/route.ts` call this.

```ts
export interface JobLogEntry {
  source:        'http' | 'inbox'
  filename:      string
  status:        'done' | 'failed'
  imported:      number
  skipped:       number
  duration_ms:   number
  error_message?: string
  breach_name?:   string
}

export function logJob(entry: JobLogEntry): void
```

Calls `dbRun` to insert into `processing_jobs`. Silent on error (logging must never crash the upload pipeline).

---

## Section 3 — lib/upload-queue.ts additions

Two exports added (module-level variable, no external deps):

```ts
let _currentJob: string | null = null

export function setCurrentJob(name: string | null): void {
  _currentJob = name
}

export function getCurrentJob(): string | null {
  return _currentJob
}
```

**Call sites:**
- `lib/inbox-watcher.ts`: `setCurrentJob(filename)` before processing, `setCurrentJob(null)` in the `finally` block
- `app/api/upload/route.ts`: `setCurrentJob(file.name)` inside the `uploadQueue()` wrapper before `processTextStream`; `setCurrentJob(null)` when done/error

---

## Section 4 — GET /api/upload/queue-status

New route: `app/api/upload/queue-status/route.ts`

**Auth:** Admin role required (same pattern as all other admin routes).

**Response shape:**

```ts
{
  queue: {
    active:       number        // 0 or 1
    pending:      number        // waiting in queue
    current_file: string | null // filename currently processing
  }
  recent: Array<{               // last 20 rows from processing_jobs, newest first
    id:            number
    source:        'http' | 'inbox'
    filename:      string
    status:        'done' | 'failed'
    imported:      number
    skipped:       number
    duration_ms:   number
    error_message: string | null
    breach_name:   string | null
    created_at:    string
  }>
  totals: {
    files_done:    number
    files_failed:  number
    rows_imported: number
    rows_skipped:  number
  }
}
```

**Implementation:**
- `queue` fields from `uploadQueue.activeCount`, `uploadQueue.pendingCount`, `getCurrentJob()`
- `recent` from `SELECT * FROM processing_jobs ORDER BY id DESC LIMIT 20`
- `totals` from `SELECT COUNT(*) ... GROUP BY status` + `SELECT SUM(imported), SUM(skipped)`

---

## Section 5 — QueueStatusPanel React Component

Added to `app/upload/page.tsx` as a collapsible card rendered **below the drop zone and above the Format Reference card** — always mounted for admins, regardless of upload state.

**Behaviour:**
- Polls `/api/upload/queue-status` every 3 seconds via `setInterval` in `useEffect`
- Collapses/expands with a chevron toggle (default: **expanded**)
- Shows a `● Live` / `○ Idle` indicator that pulses green while queue is active
- While collapsed: shows one-line summary (`● 1 processing · 4 pending · 2.4M rows total`)

**Expanded layout:**

```
┌─ Processing Queue ──────────────────────── ● Live ──┐
│  Status:   ● Processing                              │
│  Current:  stealer_2026_batch3.txt  [inbox]          │
│  Queue:    1 running · 4 waiting                     │
│                                                       │
│  Lifetime: 2.4M imported · 847 files · 3 failed      │
│                                                       │
│  ✓ [http]  batch_1.txt     4.2M rows  89%  2m14s     │
│  ✓ [inbox] mega_dump.txt  12.1M rows  94%  8m02s     │
│  ✗ [inbox] corrupt.zip    FAILED: unexpected EOF     │
│  ...up to 20 rows...                                 │
└──────────────────────────────────────────────────────┘
```

**Wire-up in upload route:**

The route must call `setCurrentJob` and `logJob` at the right moments:

```ts
// txt/csv path:
setCurrentJob(file.name)
runWithProgress(jobId, () =>
  uploadQueue(() => processTextStream(file.stream(), file.name, jobId))
    .finally(() => setCurrentJob(null))
).catch(console.error)

// In runWithProgress success:
logJob({ source: 'http', filename, status: 'done', imported, skipped, duration_ms, breach_name })

// In runWithProgress error:
logJob({ source: 'http', filename, status: 'failed', imported: 0, skipped: 0, duration_ms, error_message })
```

**Wire-up in inbox-watcher:**

```ts
setCurrentJob(filename)
try {
  // ... process ...
  logJob({ source: 'inbox', filename, status: 'done', ... })
} catch (err) {
  logJob({ source: 'inbox', filename, status: 'failed', error_message: String(err), ... })
} finally {
  setCurrentJob(null)
}
```

---

## File Map

| File | Action |
|---|---|
| `lib/sqlite.ts` | Add `processing_jobs` table + index to `initSchema()` |
| `lib/processing-log.ts` | **Create** — `logJob()` helper |
| `lib/upload-queue.ts` | Add `setCurrentJob` / `getCurrentJob` |
| `app/api/upload/queue-status/route.ts` | **Create** — admin-auth GET endpoint |
| `app/api/upload/route.ts` | Call `setCurrentJob` + `logJob` in txt/csv and ZIP paths |
| `lib/inbox-watcher.ts` | Call `setCurrentJob` + `logJob` in queue callback |
| `app/upload/page.tsx` | Add `QueueStatusPanel` component + mount below drop zone |
| `__tests__/processing-log.test.ts` | **Create** — unit tests for `logJob` (mocked SQLite) |

---

## Testing

All 396 existing tests must pass. New tests in `__tests__/processing-log.test.ts`:
- `logJob` with `status='done'` calls `dbRun` with correct fields
- `logJob` with `status='failed'` includes `error_message`
- `logJob` is silent (does not throw) when `dbRun` throws

`QueueStatusPanel` rendering and polling are not unit-tested (UI component, no logic to test in isolation). Manual verification: drop a file, confirm row appears in the panel within 3 s.
