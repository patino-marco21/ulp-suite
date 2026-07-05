# Inbox Status Blind-Spot: globalThis Singleton Fix — Design

## Problem

The Inbox Monitor dashboard (`/inbox`) shows "Idle" and no progress bar even
while a file is genuinely, actively being imported. Confirmed live: while
`DUMP ULP 01.07.2026 Base34 1.txt` was mid-import (ClickHouse actively
inserting, row count climbing, file physically in `inbox/processing/`), an
authenticated call to `GET /api/inbox/status` returned:

```json
{ "watcher_active": false, "current_file": null, "queue_depth": 0,
  "current_progress": null, "in_flight_count": 0, "stale_in_flight": 0 }
```

Every field that should reflect live in-progress state reported empty/idle.
Fields backed by SQLite (`waiting`, `failed`, `done_recent`) were correct and
fresh. This isolates the bug to the in-memory state shared between
`instrumentation.ts` (which starts the background watcher) and the API
routes (which report on it).

## Root Cause

`instrumentation.ts`'s `register()` calls `startInboxWatcher()` once at
server boot. `lib/inbox-watcher.ts` and `lib/upload-queue.ts` hold their
shared state in plain module-scope variables (`let _currentJob`, `let
_currentProgress`, `const inFlight = new Set()`, `const uploadQueue =
pLimit(1)`), exported via getter functions.

This works only if every importer resolves to the *same* module instance.
In this app's production (`output: 'standalone'`) build, Next.js compiles
`instrumentation.ts` and each API route handler as separate webpack
entry points. Confirmed via static inspection of `.next/server/`: the
watcher's code (matched by a distinctive log-string literal) appears
duplicated across at least two different compiled chunk files, and
`instrumentation.js`'s own file-trace lists zero chunk dependencies while
the status route's file-trace lists roughly a dozen. This is documented,
expected Next.js behavior, not a misconfiguration —
[vercel/next.js discussion #68572](https://github.com/vercel/next.js/discussions/68572):
*"with webpack, this will get bundled and duplicated across multiple
chunks — so you'll end up having multiple instances."*

Net effect: `instrumentation.ts`'s copy of these modules is the one that
actually runs `enqueueFile`/`uploadQueue(...)` and does real work. Every API
route holds a separate, never-touched copy whose Sets stay empty and whose
`pLimit(1)` counters stay at zero forever, regardless of what the real
watcher is doing.

## Scope

Checked every route that imports the affected modules:

| Route | Imports | Risk if left broken |
|---|---|---|
| `app/api/inbox/status/route.ts` | `getCurrentJob`, `getInboxJobProgress`, `getInFlightCount`, `uploadQueue` | Dashboard shows wrong status (confirmed) |
| `app/api/inbox/scan/route.ts` | `clearStaleInFlight`, `forceReconcile`, `getInFlightCount` | "Force Scan" reasons about an empty, disconnected `inFlight` Set |
| `app/api/upload/route.ts` | `uploadQueue` | A manual web upload may run through a *different* `pLimit(1)` instance than the inbox watcher's |
| `app/api/upload/queue-status/route.ts` | `uploadQueue` | Same display-accuracy issue as inbox status, for the upload page |

The `app/api/upload/route.ts` case is the highest-severity one: the queue's
entire purpose (per its own header comment) is "the HTTP upload route and
the inbox watcher share this queue so they never compete for memory." If
they're on separate `pLimit(1)` instances, that guarantee silently does not
hold — a manual upload and an inbox-dropped file could run concurrently,
which is exactly the multi-GB-memory-competition scenario the queue exists
to prevent.

Checked the other three jobs `instrumentation.ts` starts
(`runClickHouseMigrations`, `startMonitorRescanCron`, `startDedupCron`,
`startProjectionScopeCron`): none export a getter that any route imports,
so cross-bundle duplication is harmless for them — nothing ever reads their
state from a different copy. Out of scope for this fix.

## Fix

Anchor the shared state to `globalThis` instead of plain module scope.
`globalThis` is one true object per OS process — every webpack-duplicated
copy of the module reads and writes the same underlying object, regardless
of which chunk loaded it. This is the same pattern commonly used for
Prisma Client singletons surviving Next.js dev-mode hot reload, and is
confirmed (same GitHub discussion above) to also fix production
cross-chunk duplication, not just dev-mode reloads.

**`lib/upload-queue.ts`:**
- `uploadQueue` (the `pLimit(1)` instance itself) becomes
  `globalThis.__ulpUploadQueue ??= pLimit(parseConcurrency(...))`.
- `_currentJob` becomes a `globalThis.__ulpCurrentJob` read/write, behind
  the existing `setCurrentJob`/`getCurrentJob` functions (signatures
  unchanged).

**`lib/inbox-watcher.ts`:**
- `inFlight`, `pendingTasks` (currently `Set<string>` module constants) and
  `_currentProgress` (currently `let`) become `globalThis`-backed the same
  way, behind their existing accessor functions
  (`getInboxJobProgress`, `getInFlightCount`, `clearStaleInFlight`,
  `forceReconcile`) — none of those signatures change.
- `started` (the idempotency guard in `startInboxWatcher()`) is left as a
  plain module-scope flag: only `instrumentation.ts` ever calls
  `startInboxWatcher()`, so it never needs to be read from a different
  bundle. Confirmed via grep — no route imports `startInboxWatcher`.

No API route's code changes. No function signature changes. The fix is
entirely inside the two lib files' internal storage mechanism.

### Why not persist to SQLite instead?

Considered, and it's the more "correct" long-term answer if this app ever
runs more than one instance (`globalThis` only shares state within a single
process). But this is a self-hosted, single-instance tool with no
horizontal-scaling plans, and `globalThis` is a much smaller, lower-risk
change confined to two files rather than restructuring how progress is
tracked end-to-end. If multi-instance deployment ever becomes a real
requirement, that's a separate, larger design conversation.

## Testing / Verification

1. **Unit tests** (source-text contract tests, matching this codebase's
   existing pattern for `inbox-watcher.ts`/`dedup-cron.ts`/etc.): assert
   both files declare the `globalThis` type augmentation and that the
   exported getters/state read from `globalThis` rather than a bare module
   variable.
2. **Live verification** (required — this bug was invisible to static
   analysis alone): rebuild the Docker image, redeploy, then repeat the
   exact authenticated-curl check used to originally confirm the bug —
   call `GET /api/inbox/status` while a real or synthetic slow-write file
   is actively being imported, and confirm `watcher_active: true`,
   `current_file` populated, `queue_depth >= 1`, and `current_progress`
   populated with a climbing `rows_imported`.
3. **Queue-sharing verification** (closes the higher-severity concern):
   while an inbox file is processing, attempt a manual upload via
   `app/api/upload/route.ts` (a small synthetic file) and confirm via
   `/api/inbox/status`'s `queue_depth` / the upload's own response timing
   that it queues behind the inbox file rather than running concurrently.

## Error Handling

No new error paths are introduced. `globalThis` property access cannot
throw under normal operation; the `??=` initialization pattern is
race-free for this app's single-threaded Node.js event loop (module
evaluation order already guarantees the first accessor to run creates the
value before any concurrent request can observe it, since there's no
`await` between the check and the assignment).
