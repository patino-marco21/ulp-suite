# Inbox Monitor — Design Spec

## Goal

Give the `/inbox` folder watcher full GUI visibility: a dedicated `/inbox` page showing which files are waiting, currently processing, completed, and failed — with one-click retry for failed files. Also fixes the missing `./inbox:/app/inbox` bind mount in `docker-compose.yml` so the host can actually drop files into the watcher.

---

## Background

`lib/inbox-watcher.ts` watches `/app/inbox/` inside the Docker container using chokidar v4. Files are processed one at a time through the shared `uploadQueue` (pLimit 1) and moved to `inbox/done/` on success or `inbox/failed/` on failure. Until now:

- The folder was **not bind-mounted** — `docker-compose.yml` only mounted `./uploads` and `./data`. The host could not see or write to `inbox/`.
- There was **no GUI** — the only visibility was `processing_jobs` database rows (shown in the QueueStatusPanel on `/upload`) and Docker logs.

`docker-compose.yml` fix (`./inbox:/app/inbox`) is already committed separately.

---

## Architecture

**Approach:** Filesystem API + polling at 3 s.

`GET /api/inbox/status` reads the three directories with `fs.readdirSync` + `fs.statSync`, merges live queue state (`getCurrentJob()`, `queueSize()`) and last-10 `processing_jobs` rows, and returns a single JSON response. The `/inbox` page polls this endpoint every 3 s in a `useEffect` `setInterval`.

`POST /api/inbox/retry` moves one or all files from `inbox/failed/` back to `inbox/` using `fs.renameSync`. The watcher picks them up within milliseconds.

Both endpoints require admin session auth (same pattern as all other admin routes).

---

## Section 1 — API: GET /api/inbox/status

**File:** `app/api/inbox/status/route.ts`

**Auth:** Admin role required.

**Response shape:**

```ts
{
  watcher_active:  boolean          // true when at least one file is queued or processing
  current_file:    string | null    // from getCurrentJob() — filename being processed right now
  queue_depth:     number           // uploadQueue.activeCount + pendingCount

  waiting: Array<{                  // files in inbox/ (not yet picked up or queued)
    name:       string
    size_bytes: number
    mtime:      string              // ISO datetime
  }>

  failed: Array<{                   // files in inbox/failed/
    name:       string
    size_bytes: number
    mtime:      string
  }>

  done_count:  number               // total files in inbox/done/

  done_recent: Array<{              // last 10 processing_jobs rows with source='inbox', newest first
    id:          number
    filename:    string
    status:      'done' | 'failed'
    imported:    number
    skipped:     number
    duration_ms: number
    error_message: string | null
    created_at:  string
  }>
}
```

**Implementation notes:**
- `waiting` excludes the `done/` and `failed/` subdirectories.
- Files are sorted by `mtime` ascending (oldest first = next to process).
- `done_count` counts entries in `inbox/done/` via `fs.readdirSync().length`. No file details — this folder can contain thousands of entries.
- `done_recent` comes from SQLite (`processing_jobs` WHERE `source='inbox'` ORDER BY `id DESC` LIMIT 10). Richer than filesystem (has row counts + duration).
- If `inbox/` does not exist yet, return empty arrays rather than 500.

---

## Section 2 — API: POST /api/inbox/retry

**File:** `app/api/inbox/retry/route.ts`

**Auth:** Admin role required.

**Request body:**
```ts
{ filename: string }   // retry one file
// OR
{ all: true }          // retry all failed files
```

**Behaviour:**
- Validates `filename` does not contain `/` or `..` (prevent path traversal).
- Moves `inbox/failed/<filename>` → `inbox/<filename>` via `fs.renameSync`.
- For `{ all: true }`, iterates all files in `inbox/failed/` and moves each.
- Returns `{ moved: string[] }` — list of filenames that were actually moved.
- If the source file doesn't exist, skip silently (idempotent).

---

## Section 3 — `/inbox` page

**File:** `app/inbox/page.tsx`

**Auth:** Admin-only (same `useAuth(true)` + `isAdmin` pattern as `/upload`).

**Polling:** `useEffect` with `setInterval(poll, 3_000)` + immediate first call. Cleanup on unmount. Same `cancelled` flag pattern as `QueueStatusPanel`.

**Layout:**

```
Page title: "Inbox Monitor"
Subtitle: "Drop files into ./inbox/ to process them automatically."

┌─ Status bar ──────────────────────────────────────────────────┐
│  ● Running  /  ○ Idle    Queue: N active · N waiting           │
│  Current: <filename>  (or "—" when idle)                       │
└───────────────────────────────────────────────────────────────┘

┌─ Waiting (N files) ─────────────────────────────────────────── │
│  📄 filename.txt      12.4 MB    added 3s ago                   │
│  📄 archive.zip        892 MB    added 8s ago                   │
│  (empty state: "No files waiting — drop .txt/.csv/.zip files    │
│   into ./inbox/ to start processing")                           │
└───────────────────────────────────────────────────────────────┘

┌─ Failed (N files) ───────────────────────── [Retry All] button ┐
│  ✗ corrupt_file.zip     error message preview    [Retry] button │
│  (error from processing_jobs if available, else "processing     │
│   error — check Docker logs")                                   │
│  (empty state: "No failed files")                               │
└───────────────────────────────────────────────────────────────┘

┌─ Completed (N total) ───────────────────────────────────────── │
│  ✓ batch_001.txt   4.2M rows   89%   2m14s                      │
│  ✓ batch_002.txt   3.1M rows   94%   1m58s                      │
│  (last 10 shown — full history in the Processing Queue panel    │
│   on /upload)                                                   │
│  (empty state: "No files processed yet")                        │
└───────────────────────────────────────────────────────────────┘
```

**Retry flow:**
- Clicking `[Retry]` on one file: `POST /api/inbox/retry { filename }` → optimistic UI update (remove from failed list) → refetch on next poll.
- Clicking `[Retry All]`: `POST /api/inbox/retry { all: true }` → same.
- Both show a loading spinner on the button while the request is in flight.

**File sizes:** Displayed as human-readable (MB/GB). Files over 1 GB show in red to warn about processing time.

**Timestamps:** "added Xs ago" using relative time from `mtime`.

---

## Section 4 — Sidebar

**File:** `components/app-sidebar.tsx`

Add `Inbox` to the **Import** group, after `Upload`:

```ts
{ title: "Inbox",  url: "/inbox",  icon: Inbox,  adminOnly: true },
```

Import `Inbox` from `lucide-react` (already installed).

---

## Section 5 — Tests

**File:** `__tests__/inbox-status.test.ts`

Unit tests (mocked fs):

```ts
// Helper: buildInboxStatus(inboxDir, doneDir, failedDir) → InboxStatus
```

Tests:
- Returns correct `waiting` array from mocked `readdirSync` + `statSync`
- Excludes `done/` and `failed/` subdirectories from `waiting`
- Returns correct `failed` array
- Returns `done_count` as the correct length
- Path traversal: `../../../etc/passwd` filename rejected by retry endpoint
- `{ all: true }` moves all files (mocked `renameSync`)
- Empty directories return empty arrays without throwing

---

## File Map

| File | Action |
|---|---|
| `app/api/inbox/status/route.ts` | **Create** |
| `app/api/inbox/retry/route.ts` | **Create** |
| `app/inbox/page.tsx` | **Create** |
| `components/app-sidebar.tsx` | **Modify** — add Inbox nav item |
| `__tests__/inbox-status.test.ts` | **Create** |

`docker-compose.yml` — already modified (committed separately).

---

## Usage after deployment

```bash
# On Ubuntu laptop — after git pull + docker compose up -d --build:

# Drop files in (the folder is now visible on the host)
cp /path/to/dumps/*.txt ~/ulp-suite/inbox/

# Watch progress at http://localhost:3000/inbox
# Or from terminal:
docker compose logs -f app | grep inbox-watcher

# Retry failed files — either via GUI [Retry All] button
# or from terminal:
mv ~/ulp-suite/inbox/failed/* ~/ulp-suite/inbox/
```
