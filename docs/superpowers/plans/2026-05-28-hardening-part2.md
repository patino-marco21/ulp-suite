# Hardening Part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three remaining gaps: upload endpoint rate limiting, disk-based ZIP streaming in the inbox watcher, and automatic cleanup of old `inbox/done/` files.

**Architecture:** A shared in-memory rate-limiter helper is added to `lib/rate-limiter.ts` and wired into the upload route (5 uploads / IP / 5 min). `lib/upload-processor.ts` gains a `processZipFile(filepath)` function that opens a ZIP directly from disk via `yauzl.open` — no `readFileSync` buffer needed. `lib/inbox-watcher.ts` switches to `processZipFile` for its ZIP path and runs a `cleanupOldFiles()` pass on `inbox/done/` at startup (deletes files older than 7 days).

**Tech Stack:** Next.js 14, TypeScript, yauzl (already installed), Vitest

---

## File Map

| File | Action |
|---|---|
| `lib/rate-limiter.ts` | **Create** — shared `checkLimit()` and `getClientIP()` helpers |
| `app/api/upload/route.ts` | **Modify** — add IP rate limit (5 req / 5 min) using shared helper |
| `lib/upload-processor.ts` | **Modify** — add `processZipFile(filepath, onEntry)` using `yauzl.open` |
| `lib/inbox-watcher.ts` | **Modify** — use `processZipFile` for ZIP path; add `cleanupOldFiles()` on startup |
| `__tests__/rate-limiter.test.ts` | **Create** — unit tests for checkLimit |

---

### Task 1: lib/rate-limiter.ts + tests

**Files:**
- Create: `lib/rate-limiter.ts`
- Create: `__tests__/rate-limiter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/rate-limiter.test.ts
import { describe, test, expect } from 'vitest'
import { checkLimit } from '@/lib/rate-limiter'

describe('checkLimit', () => {
  test('allows the first request', () => {
    const map = new Map()
    const result = checkLimit(map, 'ip-1', 3, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })

  test('blocks when limit is reached', () => {
    const map = new Map()
    checkLimit(map, 'ip-2', 2, 60_000)
    checkLimit(map, 'ip-2', 2, 60_000)
    const result = checkLimit(map, 'ip-2', 2, 60_000)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  test('resets after window expires', () => {
    const map = new Map()
    // Manually insert an expired entry
    map.set('ip-3', { count: 99, resetAt: Date.now() - 1 })
    const result = checkLimit(map, 'ip-3', 3, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })

  test('different keys are independent', () => {
    const map = new Map()
    checkLimit(map, 'a', 1, 60_000)
    checkLimit(map, 'a', 1, 60_000) // blocked
    const result = checkLimit(map, 'b', 1, 60_000) // different key
    expect(result.allowed).toBe(true)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault && npm test -- __tests__/rate-limiter.test.ts
```

Expected: FAIL — `checkLimit not found`.

- [ ] **Step 3: Create lib/rate-limiter.ts**

```ts
/**
 * Shared in-memory rate limiter.
 *
 * Used by API routes that need to throttle by IP. Single-process only
 * (correct for self-hosted Next.js; reset on restart is acceptable).
 */

import { type NextRequest } from 'next/server'

export interface LimitResult {
  allowed:   boolean
  remaining: number
  resetAt:   number
}

/**
 * Check and increment a rate-limit counter.
 *
 * @param map       Persistent Map<string, { count, resetAt }> (module-level singleton)
 * @param key       Rate-limit key (typically an IP address)
 * @param maxCount  Maximum requests allowed in the window
 * @param windowMs  Window duration in milliseconds
 */
export function checkLimit(
  map:       Map<string, { count: number; resetAt: number }>,
  key:       string,
  maxCount:  number,
  windowMs:  number,
): LimitResult {
  const now = Date.now()

  // Periodic GC: prune expired entries when map grows large
  if (map.size > 5_000) {
    for (const [k, v] of map) {
      if (now > v.resetAt) map.delete(k)
    }
  }

  const entry = map.get(key)

  if (!entry || now > entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: maxCount - 1, resetAt: now + windowMs }
  }

  if (entry.count >= maxCount) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt }
  }

  entry.count++
  return { allowed: true, remaining: maxCount - entry.count, resetAt: entry.resetAt }
}

/** Extract client IP from standard proxy headers. */
export function getClientIP(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}
```

- [ ] **Step 4: Run tests — should pass**

```bash
npm test -- __tests__/rate-limiter.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: 396 tests pass (392 + 4 new).

- [ ] **Step 6: Commit**

```bash
git add lib/rate-limiter.ts __tests__/rate-limiter.test.ts
git commit -m "feat(rate-limiter): add shared in-memory rate limiter helper"
```

---

### Task 2: Upload endpoint rate limiting

**Files:**
- Modify: `app/api/upload/route.ts`

Context: The upload route is admin-only but has no rate limit. Pattern comes from `lib/rate-limiter.ts` (Task 1). Allow 5 uploads per IP per 5 minutes — generous for normal admin use, but blocks runaway automation.

- [ ] **Step 1: Add import and limiter map**

Open `app/api/upload/route.ts`. After the existing imports, add:

```ts
import { checkLimit, getClientIP } from '@/lib/rate-limiter'

// 5 uploads per IP per 5 minutes.  Generous for admin use; blocks runaway loops.
const uploadLimiter = new Map<string, { count: number; resetAt: number }>()
```

- [ ] **Step 2: Add rate-limit check inside POST handler**

Inside the `POST` handler, immediately after the `requireAdminRole` check (before `runClickHouseMigrations()`), add:

```ts
  // Rate limit: 5 uploads per IP per 5 minutes
  const ip       = getClientIP(request)
  const rlResult = checkLimit(uploadLimiter, ip, 5, 5 * 60_000)
  if (!rlResult.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many uploads — please wait before uploading again.' },
      {
        status: 429,
        headers: {
          'Retry-After':          String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit':    '5',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset':    String(rlResult.resetAt),
        },
      }
    )
  }
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: 396 tests pass.

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/api/upload/route.ts
git commit -m "feat(upload): add IP rate limiting (5 req / 5 min)"
```

---

### Task 3: processZipFile + inbox ZIP streaming + done/ cleanup

**Files:**
- Modify: `lib/upload-processor.ts`
- Modify: `lib/inbox-watcher.ts`

Context: The inbox watcher currently calls `fs.readFileSync(filePath)` to get a Buffer before calling `processZipBuffer`. With `yauzl.open(filepath)` we can skip the buffer entirely — yauzl streams directly from disk. We also add `cleanupOldFiles(dir, maxAgeMs)` called at watcher startup to prune stale `done/` files.

- [ ] **Step 1: Add processZipFile to lib/upload-processor.ts**

Open `lib/upload-processor.ts`. After the existing `processZipBuffer` function (at the end of the file), add:

```ts
/**
 * Process a ZIP file on disk by streaming its .txt/.csv entries one at a time.
 *
 * Uses yauzl.open — reads lazily from disk, no Buffer needed.
 * Ideal for the inbox watcher where we already have a file path.
 *
 * onEntry is called after each successfully processed entry.
 */
export async function processZipFile(
  filepath: string,
  onEntry:  (result: ProcessResult) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)

      zipfile.readEntry()

      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return }

        const lp = entry.fileName.toLowerCase()
        if (!lp.endsWith('.txt') && !lp.endsWith('.csv')) {
          zipfile.readEntry()
          return
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) { reject(streamErr); return }

          const entryName = entry.fileName.split('/').pop() || entry.fileName
          const webStream = Readable.toWeb(readStream) as ReadableStream<Uint8Array>

          processTextStream(webStream, entryName)
            .then(result => { onEntry(result); zipfile.readEntry() })
            .catch(reject)
        })
      })

      zipfile.on('end', resolve)
      zipfile.on('error', reject)
    })
  })
}
```

- [ ] **Step 2: Update lib/inbox-watcher.ts**

Replace the current ZIP branch (the `if (ext === '.zip') { ... }` block inside `uploadQueue(async () => { ... })`) with:

```ts
            if (ext === '.zip') {
              // processZipFile reads directly from disk — no readFileSync buffer
              await processZipFile(filePath, result => {
                if (result.imported > 0) {
                  console.log(
                    `[inbox-watcher]   ${result.filename}: ` +
                    `imported=${result.imported} skipped=${result.skipped}`
                  )
                }
              })
```

Also add the import for `processZipFile` at the top of `lib/inbox-watcher.ts`:

```ts
import { processTextStream, processZipBuffer, processZipFile } from '@/lib/upload-processor'
```

(Replace the existing import that only imports `processTextStream` and `processZipBuffer`.)

- [ ] **Step 3: Add cleanupOldFiles to lib/inbox-watcher.ts**

Add this function before `startInboxWatcher()`:

```ts
const DONE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

/** Delete files in dir that are older than maxAgeMs. Silent on errors. */
function cleanupOldFiles(dir: string, maxAgeMs: number): void {
  try {
    const now    = Date.now()
    const cutoff = now - maxAgeMs
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const filePath = path.join(dir, entry.name)
      try {
        const { mtimeMs } = fs.statSync(filePath)
        if (mtimeMs < cutoff) {
          fs.unlinkSync(filePath)
          console.log(`[inbox-watcher] cleanup: deleted old done file ${entry.name}`)
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore if dir doesn't exist yet
  }
}
```

Then, inside `startInboxWatcher()`, after the `mkdirSync` calls and before the `console.log('[inbox-watcher] started...')`, add:

```ts
  // Prune stale done/ files on startup
  cleanupOldFiles(DONE, DONE_MAX_AGE_MS)
```

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: 396 tests pass.

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add lib/upload-processor.ts lib/inbox-watcher.ts
git commit -m "feat(inbox): disk-based ZIP streaming + auto-cleanup of done/ files older than 7 days"
```

---

### Task 4: Final verification + push

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected:
```
Test Files  9 passed (9)
     Tests  396 passed (396)
```
(392 existing + 4 rate-limiter tests)

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Verify git log**

```bash
git log --oneline -5
```

Expected:
```
<sha>  feat(inbox): disk-based ZIP streaming + auto-cleanup of done/ files older than 7 days
<sha>  feat(upload): add IP rate limiting (5 req / 5 min)
<sha>  feat(rate-limiter): add shared in-memory rate limiter helper
<sha>  chore(hardening): Node 22, SQLite busy_timeout+synchronous, gitignore inbox/
```

- [ ] **Step 4: Push**

```bash
git push
```
