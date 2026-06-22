# Pagination and Import Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default credential browsing to 200 globally domain-alphabetized rows and make multi-gigabyte imports survive temporary ClickHouse restarts without cascading queued files into failure.

**Architecture:** Share browser defaults between the client and API, preserving existing keyset cursors. Move ingestion to 100,000-row synchronous inserts and wrap only transient ClickHouse transport failures in a bounded retry helper that recreates identical insert streams and tokens. Remove the concurrent post-import full-table dedup hook while retaining scheduled/manual deduplication.

**Tech Stack:** Next.js 15, React 19, TypeScript, Vitest, `@clickhouse/client`, ClickHouse 26.3, Docker Compose.

## Global Constraints

- Default page size is exactly 200 and remains user-selectable.
- Default global order is `domain_asc`; empty domains remain last.
- Explicit API `limit` and `sort` parameters continue to override defaults.
- Parser batch size is exactly 100,000 rows.
- Credential inserts are synchronous and use `max_insert_threads=2`.
- Identical retry attempts preserve row order and `insert_deduplication_token`.
- Retry only transient transport or HTTP 502/503/504 failures.
- Retry delay starts at 1 second, caps at 30 seconds, and expires after 30 minutes.
- Post-import full-table content dedup does not run; scheduled/manual dedup remains.
- No persistent byte-offset checkpointing or replay-from-start mechanism is added.

---

### Task 1: Shared 200-row Domain A→Z Defaults

**Files:**
- Create: `lib/credential-browse-defaults.ts`
- Create: `__tests__/credential-browse-defaults.test.ts`
- Modify: `app/credentials/page.tsx`
- Modify: `app/api/credentials/route.ts`

**Interfaces:**
- Produces: `DEFAULT_CREDENTIAL_LIMIT: 200`, `MAX_CREDENTIAL_LIMIT: 200`, and `DEFAULT_CREDENTIAL_SORT: 'domain_asc'`.
- Consumes: existing `SortKey`, `SORT_MAP`, and cursor behavior from `lib/cursor-pagination.ts`.

- [ ] **Step 1: Write the failing defaults contract**

Create `__tests__/credential-browse-defaults.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_CREDENTIAL_LIMIT,
  DEFAULT_CREDENTIAL_SORT,
  MAX_CREDENTIAL_LIMIT,
} from '@/lib/credential-browse-defaults'

describe('credential browse defaults', () => {
  test('defaults to 200 rows ordered globally by domain A to Z', () => {
    expect(DEFAULT_CREDENTIAL_LIMIT).toBe(200)
    expect(MAX_CREDENTIAL_LIMIT).toBe(200)
    expect(DEFAULT_CREDENTIAL_SORT).toBe('domain_asc')
  })

  test('the UI and API consume the shared defaults', () => {
    const page = readFileSync('app/credentials/page.tsx', 'utf8')
    const route = readFileSync('app/api/credentials/route.ts', 'utf8')
    expect(page).toContain('useState(DEFAULT_CREDENTIAL_SORT)')
    expect(page).toContain('useState(DEFAULT_CREDENTIAL_LIMIT)')
    expect(route).toContain("sp.get('sort') || DEFAULT_CREDENTIAL_SORT")
    expect(route).toContain("sp.get('limit') || String(DEFAULT_CREDENTIAL_LIMIT)")
  })
})
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
npm test -- __tests__/credential-browse-defaults.test.ts
```

Expected: FAIL because `lib/credential-browse-defaults.ts` does not exist.

- [ ] **Step 3: Add the constants and wire every default/reset path**

Create `lib/credential-browse-defaults.ts`:

```ts
import type { SortKey } from '@/lib/cursor-pagination'

export const DEFAULT_CREDENTIAL_LIMIT = 200
export const MAX_CREDENTIAL_LIMIT = 200
export const DEFAULT_CREDENTIAL_SORT: SortKey = 'domain_asc'
```

In `app/api/credentials/route.ts`, import the constants and replace the hardcoded defaults:

```ts
const limit = Math.min(
  MAX_CREDENTIAL_LIMIT,
  Math.max(1, parseInt(sp.get('limit') || String(DEFAULT_CREDENTIAL_LIMIT), 10)),
)
const sortKey = sp.get('sort') || DEFAULT_CREDENTIAL_SORT
```

In `app/credentials/page.tsx`, import the constants and use them for initial state, Clear All, the hardcoded reset fetch, and `cycleSortKey`'s reset branch:

```ts
const [sortKey, setSortKey] = useState(DEFAULT_CREDENTIAL_SORT)
const [limit, setLimit] = useState(DEFAULT_CREDENTIAL_LIMIT)
```

The Clear All fetch must interpolate both constants and retain `exclude_noise=1&dedupe=1`.

- [ ] **Step 4: Verify the focused defaults and cursor tests**

Run:

```bash
npm test -- __tests__/credential-browse-defaults.test.ts __tests__/cursor-pagination.test.ts
```

Expected: both files pass; domain cursor tests continue proving empty domains sort last.

- [ ] **Step 5: Commit Task 1**

```bash
git add lib/credential-browse-defaults.ts app/credentials/page.tsx app/api/credentials/route.ts __tests__/credential-browse-defaults.test.ts
git commit -m "feat(credentials): default to 200 domain-sorted rows"
```

---

### Task 2: Transient ClickHouse Retry Primitive

**Files:**
- Create: `lib/clickhouse-retry.ts`
- Create: `__tests__/clickhouse-retry.test.ts`

**Interfaces:**
- Produces: `isTransientClickHouseError(error: unknown): boolean`.
- Produces: `withClickHouseRetry<T>(operation: () => Promise<T>, options?: ClickHouseRetryOptions): Promise<T>`.
- Produces: `ClickHouseRetryExhaustedError` with `attempts` and `lastError` fields.
- `ClickHouseRetryOptions` includes `initialDelayMs`, `maxDelayMs`, `maxElapsedMs`, `sleep`, `now`, and `onRetry` for deterministic tests and production logging.

- [ ] **Step 1: Write failing classification and retry tests**

Create `__tests__/clickhouse-retry.test.ts` with tests that assert:

```ts
expect(isTransientClickHouseError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true)
expect(isTransientClickHouseError({ statusCode: 503, message: 'unavailable' })).toBe(true)
expect(isTransientClickHouseError(Object.assign(new Error('bad query'), { code: '62' }))).toBe(false)
```

Add a fake clock where `sleep(ms)` records the delay and advances `nowMs`. Verify:

- two transient failures followed by success produce delays `[1000, 2000]` and three attempts;
- delays cap at 30,000 ms;
- a semantic failure is thrown after one attempt with no sleep;
- a small `maxElapsedMs` throws `ClickHouseRetryExhaustedError` and retains the last error.

- [ ] **Step 2: Run the retry tests and confirm RED**

Run:

```bash
npm test -- __tests__/clickhouse-retry.test.ts
```

Expected: FAIL because the retry module does not exist.

- [ ] **Step 3: Implement the minimal retry module**

Implement these defaults in `lib/clickhouse-retry.ts`:

```ts
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
])

const DEFAULT_INITIAL_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000
const DEFAULT_MAX_ELAPSED_MS = 30 * 60 * 1_000
```

Inspect `error.code`, `error.cause?.code`, `error.status`, and `error.statusCode`. Treat 502, 503, and 504 as transient. Also recognize transport messages such as `socket hang up`, `fetch failed`, `connection closed`, and `ECONNREFUSED`. Do not match generic ClickHouse memory or SQL errors.

`withClickHouseRetry` must calculate the next delay before sleeping, refuse to sleep past the deadline, invoke `onRetry({ attempt, delayMs, error })`, and then retry the same callback.

- [ ] **Step 4: Verify retry behavior**

Run:

```bash
npm test -- __tests__/clickhouse-retry.test.ts
npm run typecheck
```

Expected: retry tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit Task 2**

```bash
git add lib/clickhouse-retry.ts __tests__/clickhouse-retry.test.ts
git commit -m "feat(import): retry transient ClickHouse outages"
```

---

### Task 3: Bounded Synchronous Batch Inserts

**Files:**
- Modify: `lib/upload-processor.ts`
- Modify: `__tests__/insert-batch-dedup.test.ts`
- Modify: `__tests__/upload-processor.test.ts`
- Modify: `__tests__/upload-skip-imported.test.ts`

**Interfaces:**
- Produces: `UPLOAD_BATCH_SIZE = 100_000` from `lib/upload-processor.ts`.
- Extends: `insertBatch(credentials, breachName, retryOptions?)` so tests can inject zero-cost sleep/clock options.
- Consumes: `withClickHouseRetry` for source checks, source recording, and batch inserts.

- [ ] **Step 1: Write failing insert-setting and stream-policy tests**

Extend `__tests__/insert-batch-dedup.test.ts` to assert:

```ts
expect(settings.async_insert).toBeUndefined()
expect(settings.wait_for_async_insert).toBeUndefined()
expect(settings.async_insert_deduplicate).toBeUndefined()
expect(settings.max_insert_threads).toBe(2)
```

Make the insert mock reject once with `code='ECONNREFUSED'`, then resolve. Call `insertBatch` with retry options whose `sleep` resolves immediately and whose clock advances. Assert two insert calls use the same `insert_deduplication_token`, and assert each call receives a distinct `Readable` object so consumed streams are never reused.

Extend `__tests__/upload-processor.test.ts` with a source contract asserting:

```ts
expect(UPLOAD_BATCH_SIZE).toBe(100_000)
expect(readFileSync('lib/upload-processor.ts', 'utf8')).not.toContain("runContentDedupTick({ trigger: 'import' })")
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
npm test -- __tests__/insert-batch-dedup.test.ts __tests__/upload-processor.test.ts
```

Expected: FAIL because async settings remain, batch size is 500,000, retry is absent, and the import-time dedup hook remains.

- [ ] **Step 3: Convert `insertBatch` to synchronous retryable inserts**

In `lib/upload-processor.ts`:

- export `UPLOAD_BATCH_SIZE = 100_000`;
- remove the `runContentDedupTick` import;
- compute the deterministic token once outside the retry callback;
- construct `Readable.from(...)` inside the retry callback;
- retain `insert_deduplicate=1`, `insert_deduplication_token`, and `max_execution_time=0`;
- remove `async_insert`, `wait_for_async_insert`, and `async_insert_deduplicate`;
- set `max_insert_threads=2`;
- log retry attempt and delay without logging row contents.

The insert shape is:

```ts
await withClickHouseRetry(
  async () => {
    const readable = Readable.from(
      (function* () {
        for (const c of credentials) {
          yield [
            csvField(c.url), csvField(c.email), csvField(c.password),
            csvField(c.domain), csvField(c.source_file), csvField(breach_name),
          ].join(',') + '\n'
        }
      })(),
      { objectMode: false },
    )
    await chClient.insert({
      table: 'ulp.credentials',
      columns: ['url', 'email', 'password', 'domain', 'source_file', 'breach_name'],
      values: readable,
      format: 'CSV',
      clickhouse_settings: {
        max_execution_time: 0,
        insert_deduplicate: 1 as any,
        insert_deduplication_token: token as any,
        max_insert_threads: 2 as any,
      },
    })
  },
  retryOptions,
)
```

- [ ] **Step 4: Apply retry to source checks and source recording**

Wrap `sourceAlreadyImported`'s query/JSON operation and `recordSource`'s insert in `withClickHouseRetry`. Preserve record-source idempotency. Use an `onRetry` logger identifying the operation and filename only.

Change parser iteration to:

```ts
for await (const batch of parseULPStream(stream, filename, UPLOAD_BATCH_SIZE)) {
```

Delete the fire-and-forget post-import content-dedup call and update comments to state that cross-file content dedup remains scheduled/manual.

- [ ] **Step 5: Verify all ingestion tests**

Run:

```bash
npm test -- __tests__/clickhouse-retry.test.ts __tests__/insert-batch-dedup.test.ts __tests__/upload-processor.test.ts __tests__/upload-skip-imported.test.ts __tests__/upload-dedup.test.ts
```

Expected: all focused ingestion tests pass. If the known parallel SQLite `users.email` fixture race appears, run `upload-skip-imported.test.ts` alone and then rerun the focused group.

- [ ] **Step 6: Commit Task 3**

```bash
git add lib/upload-processor.ts __tests__/insert-batch-dedup.test.ts __tests__/upload-processor.test.ts __tests__/upload-skip-imported.test.ts
git commit -m "fix(import): use bounded synchronous retryable batches"
```

---

### Task 4: Operator Documentation and Regression Contract

**Files:**
- Modify: `README.md`
- Create: `__tests__/pagination-import-docs.test.ts`

**Interfaces:**
- Documents: 200-row Domain A→Z defaults, transient retry behavior, 100,000-row synchronous batches, and scheduled/manual content dedup.
- Documents: existing failed files require operator retry after deployment.

- [ ] **Step 1: Write a failing README contract**

Create `__tests__/pagination-import-docs.test.ts` that reads `README.md` and requires these phrases:

```ts
expect(readme).toContain('200 rows per page')
expect(readme).toContain('Domain A→Z')
expect(readme).toContain('100,000-row synchronous batches')
expect(readme).toContain('temporary ClickHouse outages')
expect(readme).toContain('scheduled or manual dedup')
```

- [ ] **Step 2: Run the documentation test and confirm RED**

Run:

```bash
npm test -- __tests__/pagination-import-docs.test.ts
```

Expected: FAIL because the operational behavior is not documented.

- [ ] **Step 3: Update README operations guidance**

Update the Credentials Browser and inbox/import sections to explain:

- default display is 200 rows, globally Domain A→Z;
- page size and sort remain selectable;
- imports use 100,000-row synchronous batches;
- temporary ClickHouse outages pause/retry the active batch for up to 30 minutes;
- permanent/semantic failures still move the file to `inbox/failed`;
- post-file full-table dedup is removed, while scheduled or manual dedup remains;
- after deployment, existing failed files must be retried from the Inbox Monitor.

- [ ] **Step 4: Verify documentation and focused behavior**

Run:

```bash
npm test -- __tests__/pagination-import-docs.test.ts __tests__/credential-browse-defaults.test.ts __tests__/clickhouse-retry.test.ts
git diff --check
```

Expected: all focused tests pass and no whitespace errors are reported.

- [ ] **Step 5: Commit Task 4**

```bash
git add README.md __tests__/pagination-import-docs.test.ts
git commit -m "docs: explain resilient large-file imports"
```

---

### Task 5: Full Verification, Runtime Exercise, and Integration

**Files:**
- Verify only; no expected production file changes.

**Interfaces:**
- Verifies the complete branch and local Docker deployment before PR integration.

- [ ] **Step 1: Run the full automated suite sequentially**

```bash
npm test
npm run lint
npm run typecheck
npm run build
bash -n scripts/purge-existing-t3.sh
git diff --check origin/main...HEAD
```

Expected: 618 existing tests plus the new tests pass; lint, typecheck, build, Bash syntax, and diff checks exit zero. Handle only the known parallel SQLite fixture race by isolating that test and rerunning the full suite.

- [ ] **Step 2: Verify local ClickHouse insert behavior**

With local Compose healthy, run a small integration probe that imports 100,001 generated non-sensitive rows into a temporary MergeTree test table using two synchronous inserts:

```bash
BEFORE_RESTARTS=$(docker inspect ulpsuite_clickhouse --format '{{.RestartCount}}')
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE IF EXISTS ulp.import_resilience_probe"
docker exec ulpsuite_clickhouse clickhouse-client --query "CREATE TABLE ulp.import_resilience_probe (id UInt64, value String) ENGINE=MergeTree ORDER BY id"
docker exec ulpsuite_clickhouse clickhouse-client --query "INSERT INTO ulp.import_resilience_probe SELECT number, concat('probe-', toString(number)) FROM numbers(60000) SETTINGS async_insert=0, max_insert_threads=2"
docker exec ulpsuite_clickhouse clickhouse-client --query "INSERT INTO ulp.import_resilience_probe SELECT number + 60000, concat('probe-', toString(number + 60000)) FROM numbers(40001) SETTINGS async_insert=0, max_insert_threads=2"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.import_resilience_probe"
docker exec ulpsuite_clickhouse clickhouse-client --query "SYSTEM FLUSH LOGS"
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM system.query_log WHERE type='QueryFinish' AND query LIKE 'INSERT INTO ulp.import_resilience_probe%'"
docker inspect ulpsuite_clickhouse --format 'Health={{.State.Health.Status}} RestartCount={{.RestartCount}}'
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE ulp.import_resilience_probe"
```

Verify:

- at least two insert calls complete;
- the final count equals the generated count;
- no async-insert failure appears in `system.asynchronous_insert_log` for the probe;
- ClickHouse remains healthy and its restart count does not increase.

Drop only the temporary test table after verification. Do not insert generated rows into `ulp.credentials`.

- [ ] **Step 3: Review branch diff and repository status**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: clean worktree and only specification, plan, defaults, retry, ingestion, tests, and README changes.

- [ ] **Step 4: Push, open, and merge the pull request**

```bash
git push -u origin fix/pagination-import-resilience
gh pr create --base main --head fix/pagination-import-resilience \
  --title "Make credential paging and large imports resilient" \
  --body "Defaults credentials to 200 Domain A→Z rows and makes large imports use bounded synchronous batches with transient ClickHouse retry. Removes the concurrent post-import full-table dedup scan. Verified with tests, lint, typecheck, build, and local ClickHouse probes."
```

After the PR is mergeable and checks pass, merge it. Fast-forward the primary checkout to `origin/main` and rerun the root test suite with any stale nested worktrees excluded.

- [ ] **Step 5: Deploy locally and provide the Ubuntu command**

Rebuild the local app container without recreating ClickHouse:

```bash
docker compose up -d --build app
docker compose ps
docker compose logs app --tail=100
```

Provide the Ubuntu operator command:

```bash
cd ~/ulp-suite
git pull
docker compose up -d --build app
```

Then instruct the operator to confirm ClickHouse is healthy and use Retry All (or selected retries) in the Inbox Monitor for the existing failed files.
