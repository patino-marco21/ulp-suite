# Novelty-Aware Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An import only inserts credentials that are not already in `ulp.credentials`, says how many were new, how many were already known and how many repeated inside the file, and can be retried at any point without duplicating a row.

**Architecture:** Every import is parsed into a private per-file stage table (`ulp.zz_import_stage_<id>`). A commit phase then works one hash slab at a time: it asks the live table which of the slab's `content_key_hash` values it already holds (one scan of one column), inserts only the rest with `INSERT ... SELECT ... LIMIT 1 BY`, checks ClickHouse's written-rows count against `distinct - known`, and matches monitors on the stage. Slabs are serialised by a process-wide lock; the SP1 disk gate and the memory guard run before each slab.

**Tech Stack:** Next.js 15 (App Router), TypeScript, ClickHouse 26.3 (`@clickhouse/client` 1.23), better-sqlite3, Vitest 4 (node environment, `globals: true`), Docker Compose.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md` (revision commit ed96a82). Where this plan and the spec differ, the plan's "Deltas from the spec" below win (they come from the 2026-10-11 spike, Task 1) and Task 1 writes them into the spec.
- Stage tables are `ulp.zz_import_stage_<12 hex>` and `ulp.zz_import_known_<12 hex>`: plain `MergeTree`, never replicated, never partitioned. The backup script already excludes `^(credentials_|zz_|search_)`.
- The stage's `content_key_hash` is `cityHash64(<URL_CONTENT_KEY>, email, password)` built from `lib/url-content-key.ts`: the same expression as DDL v18 and `docker/clickhouse/init/01-ulp-tables.sql` (a drift test pins them together).
- Slabs: `K = max(1, ceil(stageRows / slabRows))`, a slab is the stage rows with `content_key_hash % K = k`. `INGEST_NOVELTY_SLAB_ROWS` default 20,000,000, minimum 1,000. `INGEST_NOVELTY_CHECK` default on; `off|0|false` keeps the direct path (vitest turns it off for every suite through a setup file).
- Every commit statement carries `max_execution_time = 3300`, `insert_deduplicate = 0`, `async_insert = 0`, `use_query_cache = 0` as `@clickhouse/client` `clickhouse_settings` (the client's default `max_execution_time` is 60 s and a trailing SQL `SETTINGS` clause is not relied on).
- Written-rows check: `summary.written_rows` of the slab insert must equal `slabDistinct - slabKnown`. A missing summary skips the check (with a warning); a mismatch fails the job with `NoveltyAccountingError`.
- Per slab, in this order: disk gate, memory guard, process-wide lock (`globalThis.__ulpNoveltyLock`), statements, release. A heartbeat (`beat`) follows every statement. A failed or aborted statement is `KILL QUERY ... SYNC`ed before the lock is released.
- `imported` means NEW rows. A finished file is recorded in `ulp.sources` even with 0 new rows (novelty path only; the direct path is unchanged). `ulp.sources.line_count` stays "rows this file added".
- Monitor alerts on the novelty path: SQL on the stage with `buildNormalizedDomainSetMatch`, capped in total by `MAX_INPROCESS_MATCHES`; `fireMonitorAlertsFromMatches` and its SQLite ledger are unchanged.
- No DDL on any `ulp.*` table that exists today. SQLite gains only `processing_jobs.known INTEGER NOT NULL DEFAULT 0`.
- Nothing is ever inserted into the real `ulp.credentials` by a test or a rehearsal. The pile in `~/Downloads` is NOT imported by this plan.
- `.env` gets `CONTENT_DEDUP_APPLY=false` (decision D6) at deploy time, in Task 18, not before.
- Work happens on branch `sp2-novelty-aware-ingest` in `/home/cole/ulp-suite` (no worktree). Use absolute paths.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (pass it as the last `-m`).
- The repository is public: no operator search terms, download file names, channel names or credential values in code, tests, docs or commit messages. Test data uses `.test` domains and made-up passwords.
- Docker on this laptop: use a scoped `DOCKER_CONFIG` directory containing `{}` for `build` and `compose up`. Never run `docker system|container|image prune`: an unrelated stack shares the daemon.

## Deltas from the spec (settled by the 2026-10-11 spike)

1. **`distinct` is counted per slab, not once for the whole stage.** `K` comes from the stage's row count (`count()` is free) instead of `uniqExact` over the whole stage, which would need several GB for a 300M-row file. Each slab runs `uniqExact(content_key_hash)` over its own rows.
2. **Settings travel as client settings**, not as a trailing SQL `SETTINGS` clause (see Global Constraints).
3. **Monitor SQL uses `buildNormalizedDomainSetMatch`** (per-row normalisation computed once, `arrayExists` over the domain set), not `buildDomainSetWhereClause`: measured 0.53 s vs 1.21 s per 1M rows with 17 domains, and the cost stops growing with the number of domains. Both returned identical sets to the in-process matcher on parser-shaped rows.
4. **Config lives in `lib/ingest-novelty-config.ts`** (the inbox watcher and tests read it without loading the ClickHouse client); the commit phase is `lib/ingest-novelty.ts`.
5. **The stage has `non_replicated_deduplication_window = 10000`** so that a retried batch insert (same dedup token) cannot add rows to the stage; accounting does not depend on it (`inFileDuplicates = parsedRows - distinct`).

---

### Task 0: Branch and baseline

**Files:** none.

- [ ] **Step 1: Create the branch**

```bash
cd /home/cole/ulp-suite && git status -sb && git fetch -q origin && git switch -c sp2-novelty-aware-ingest
```
Expected: `## main...origin/main` with nothing else, then `Switched to a new branch 'sp2-novelty-aware-ingest'`.

- [ ] **Step 2: Baseline typecheck**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Baseline tests**

Run: `cd /home/cole/ulp-suite && npx vitest run 2>&1 | tail -8`
Expected: every file passes. Write down the `Test Files` and `Tests` counts as the BASELINE (last recorded 2026-10-11 after SP1: 159 files, 2,380 tests; the `*.live.test.ts` files are skipped).

---

### Task 1: Record the spike in the spec

**Files:**
- Modify: `/home/cole/ulp-suite/docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md`

The two unconfirmed items of the spec were measured on 2026-10-11 against the live server, on throwaway `ulp.zz_spike_*` tables (a clone of the live DDL with 19 skip indexes and 3 projections as a plain `MergeTree`, a 6,000,000-row stage holding 5,000,000 distinct real rows plus 1,000,000 in-file repeats, all dropped afterwards; live row counts unchanged).

- [ ] **Step 1: Add the results section**

Insert this block immediately before the line `## Approaches`:

```markdown
### Spike results (2026-10-11, live server, throwaway tables)

| Question | Result |
|---|---|
| Hash parity: the stage's `content_key_hash` against the live table's, on real rows | 5,000,000 of 5,000,000 distinct stage hashes found in `ulp.credentials` (probe 10.1 s cold, 541 MiB) |
| `INSERT ... SELECT ... LIMIT 1 BY` throughput into the live-DDL clone | 6.0M stage rows -> 5.0M written in 45.2 s = **110.6k rows/s**, 1.87 GiB peak; the same insert without `LIMIT 1 BY` 117.2k rows/s, 1.48 GiB (cost of `LIMIT 1 BY` about 6%) |
| Is `written_rows` exact with 3 projections and 19 skip indexes? | **Yes.** The real client's `command()` returns `summary.written_rows` (a string) even with `send_progress_in_http_headers` on: 5,000,000 (all new), 0 (all known), 2,452,248 (half known, exactly `distinct - known`) |
| Known-set fill against the empty clone / the 5M-row clone | 0.19 s / 0.9 s |
| Slabs by `content_key_hash % 4` | 1,273,421 + 1,274,832 + 1,274,331 + 1,177,416 = 5,000,000 distinct (exact) |
| Monitor SQL on the stage vs the in-process matcher (17 domains, 1M rows, 489,534 new) | identical for `url`; `credential` and `both` differ by exactly 1 row, a legacy blank-first-tab row that `NORM_EMAIL_EXPR` repairs and the JS matcher cannot (the current parser never produces that shape). `buildNormalizedDomainSetMatch` 0.53 s vs `buildDomainSetWhereClause` 1.21 s per 1M rows |

Consequences, all adopted in the implementation plan: the settings of the commit statements are passed as client settings (the client's default `max_execution_time` is 60 s, and the 20M-row slab takes minutes), `K` is derived from the stage's row count and `distinct` is counted per slab, and monitors are matched with `buildNormalizedDomainSetMatch`.
```

- [ ] **Step 2: Mark the two risks as settled**

In the "Risks" list, replace the bullet that begins `- **\`INSERT ... SELECT ... LIMIT 1 BY\` throughput is unmeasured**` (it runs for three lines) with:

```markdown
- **`INSERT ... SELECT ... LIMIT 1 BY` throughput and the written-rows summary: settled by the spike above** (110.6k rows/s; `written_rows` exact), so
  no second probe per slab is needed. The check still skips with a warning if a future server version stops sending the summary.
```

- [ ] **Step 3: Commit**

```bash
cd /home/cole/ulp-suite && git add docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md && git commit -m "docs(specs): record the novelty-commit spike (throughput, written-rows summary, hash parity, monitor SQL)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Expected: one file changed.

---

### Task 2: The settings module and the vitest default

**Files:**
- Create: `/home/cole/ulp-suite/lib/ingest-novelty-config.ts`
- Create: `/home/cole/ulp-suite/__tests__/setup/ingest-novelty-off.ts`
- Modify: `/home/cole/ulp-suite/vitest.config.ts`
- Test: `/home/cole/ulp-suite/__tests__/ingest-novelty-config.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `DEFAULT_NOVELTY_SLAB_ROWS: number` (20_000_000), `MIN_NOVELTY_SLAB_ROWS: number` (1_000), `COMMIT_MAX_EXECUTION_S: number` (3300)
  - `interface NoveltyConfig { enabled: boolean; slabRows: number }`
  - `noveltyConfig(env?: NodeJS.ProcessEnv): NoveltyConfig`
  - `slabCount(stageRows: number, slabRows: number): number`

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/ingest-novelty-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  COMMIT_MAX_EXECUTION_S,
  DEFAULT_NOVELTY_SLAB_ROWS,
  MIN_NOVELTY_SLAB_ROWS,
  noveltyConfig,
  slabCount,
} from '@/lib/ingest-novelty-config'

const env = (extra: Record<string, string> = {}) => ({ ...extra }) as NodeJS.ProcessEnv

describe('noveltyConfig', () => {
  it('is on with a 20,000,000-row slab by default', () => {
    expect(noveltyConfig(env())).toEqual({ enabled: true, slabRows: 20_000_000 })
    expect(DEFAULT_NOVELTY_SLAB_ROWS).toBe(20_000_000)
    expect(MIN_NOVELTY_SLAB_ROWS).toBe(1_000)
    expect(COMMIT_MAX_EXECUTION_S).toBe(3300)
  })

  it.each(['off', 'OFF', '0', 'false', ' False '])('INGEST_NOVELTY_CHECK=%j switches it off', raw => {
    expect(noveltyConfig(env({ INGEST_NOVELTY_CHECK: raw })).enabled).toBe(false)
  })

  it.each(['', 'on', '1', 'true', 'yes'])('INGEST_NOVELTY_CHECK=%j leaves it on', raw => {
    expect(noveltyConfig(env({ INGEST_NOVELTY_CHECK: raw })).enabled).toBe(true)
  })

  it('honours INGEST_NOVELTY_SLAB_ROWS and rounds it down to an integer', () => {
    expect(noveltyConfig(env({ INGEST_NOVELTY_SLAB_ROWS: '5000000' })).slabRows).toBe(5_000_000)
    expect(noveltyConfig(env({ INGEST_NOVELTY_SLAB_ROWS: '2500.9' })).slabRows).toBe(2500)
    expect(noveltyConfig(env({ INGEST_NOVELTY_SLAB_ROWS: '1000' })).slabRows).toBe(1000)
  })

  it.each(['', '  ', 'abc', '-5', '999', '0', 'NaN'])('falls back to the default slab for INGEST_NOVELTY_SLAB_ROWS=%j', raw => {
    expect(noveltyConfig(env({ INGEST_NOVELTY_SLAB_ROWS: raw })).slabRows).toBe(20_000_000)
  })
})

describe('slabCount', () => {
  it('is always at least one slab', () => {
    expect(slabCount(0, 20_000_000)).toBe(1)
    expect(slabCount(1, 20_000_000)).toBe(1)
    expect(slabCount(Number.NaN, 20_000_000)).toBe(1)
  })

  it('rounds up', () => {
    expect(slabCount(20_000_000, 20_000_000)).toBe(1)
    expect(slabCount(20_000_001, 20_000_000)).toBe(2)
    expect(slabCount(2_500, 1_000)).toBe(3)
    expect(slabCount(300_000_000, 20_000_000)).toBe(15)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-novelty-config.test.ts 2>&1 | tail -12`
Expected: FAIL, `Failed to resolve import "@/lib/ingest-novelty-config"`.

- [ ] **Step 3: Write the module**

Create `/home/cole/ulp-suite/lib/ingest-novelty-config.ts`:

```ts
/**
 * Settings for novelty-aware ingest (docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md), kept apart from the
 * commit code so that the inbox watcher and the tests can read them without loading the ClickHouse client.
 *
 *   INGEST_NOVELTY_CHECK      default on. off | 0 | false imports straight into ulp.credentials, exactly as before this feature.
 *   INGEST_NOVELTY_SLAB_ROWS  default 20,000,000, at least 1,000. A file is committed in slabs of about this many staged rows.
 */

export const DEFAULT_NOVELTY_SLAB_ROWS = 20_000_000
export const MIN_NOVELTY_SLAB_ROWS = 1_000

/** Every commit statement may run this long, in seconds. The client's own default is 60, far too short for a slab. */
export const COMMIT_MAX_EXECUTION_S = 3300

export interface NoveltyConfig {
  enabled: boolean
  slabRows: number
}

export function noveltyConfig(env: NodeJS.ProcessEnv = process.env): NoveltyConfig {
  const flag = (env.INGEST_NOVELTY_CHECK ?? '').trim().toLowerCase()
  const enabled = !(flag === 'off' || flag === '0' || flag === 'false')
  const raw = env.INGEST_NOVELTY_SLAB_ROWS
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Math.floor(Number(raw))
  const slabRows = Number.isFinite(parsed) && parsed >= MIN_NOVELTY_SLAB_ROWS ? parsed : DEFAULT_NOVELTY_SLAB_ROWS
  return { enabled, slabRows }
}

/** How many slabs a stage of `stageRows` rows is committed in (always at least one). */
export function slabCount(stageRows: number, slabRows: number): number {
  if (!Number.isFinite(stageRows) || stageRows <= 0) return 1
  return Math.max(1, Math.ceil(stageRows / slabRows))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-novelty-config.test.ts 2>&1 | tail -8`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Turn the feature off for every existing suite**

Many suites run `processTextStream` against a mocked ClickHouse client that has no `command()` and no stage tables. They test the direct path, so they get it by default, exactly like the disk gate (`__tests__/setup/ingest-gate-off.ts`).

Create `/home/cole/ulp-suite/__tests__/setup/ingest-novelty-off.ts`:

```ts
// Novelty-aware ingest (lib/ingest-novelty.ts) stages every file in ClickHouse tables, which the many suites that run the import
// loop against a mocked client cannot answer. They test the direct path. The feature has its own suites (they pass `env`
// explicitly or stub it) and scripts/e2e-novelty-ingest.ts exercises it for real on the rehearsal stack.
process.env.INGEST_NOVELTY_CHECK = 'off'
```

In `/home/cole/ulp-suite/vitest.config.ts` change the `setupFiles` line to:

```ts
    setupFiles: ['./__tests__/setup/sqlite-worker-setup.ts', './__tests__/setup/ingest-gate-off.ts', './__tests__/setup/ingest-novelty-off.ts'],
```

- [ ] **Step 6: Run the whole suite**

Run: `cd /home/cole/ulp-suite && npx vitest run 2>&1 | tail -6`
Expected: BASELINE files + 1, BASELINE tests + the new ones, all passing.

- [ ] **Step 7: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/ingest-novelty-config.ts __tests__/ingest-novelty-config.test.ts __tests__/setup/ingest-novelty-off.ts vitest.config.ts && git commit -m "feat(ingest): settings for novelty-aware ingest, off by default in the test environment" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The parser can leave in-file dedup to the stage

**Files:**
- Modify: `/home/cole/ulp-suite/lib/ulp-parser.ts` (`parseULPStream`, about lines 886-947)
- Test: `/home/cole/ulp-suite/__tests__/ulp-parser-stream.test.ts`

**Interfaces:**
- Produces: `interface ParseStreamOptions { dedupInFile?: boolean }`; `parseULPStream(stream, filename, batchSize, shouldHardDrop?, options?: ParseStreamOptions)`. Default behaviour (`dedupInFile` true) is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `/home/cole/ulp-suite/__tests__/ulp-parser-stream.test.ts`:

```ts
describe('parseULPStream: dedupInFile option', () => {
  const line = 'https://dup.example.test:user1@dup.example.test:pass1\n'

  async function run(options?: { dedupInFile?: boolean }) {
    let rows = 0
    let dedup = 0
    for await (const batch of parseULPStream(streamFromChunks([line + line + line]), FILE, 10, undefined, options)) {
      rows += batch.credentials.length
      dedup += batch.breakdown.dedup
    }
    return { rows, dedup }
  }

  test('keeps the in-file dedup by default', async () => {
    expect(await run()).toEqual({ rows: 1, dedup: 2 })
    expect(await run({})).toEqual({ rows: 1, dedup: 2 })
    expect(await run({ dedupInFile: true })).toEqual({ rows: 1, dedup: 2 })
  })

  test('dedupInFile: false lets repeated lines through and counts none as dedup', async () => {
    expect(await run({ dedupInFile: false })).toEqual({ rows: 3, dedup: 0 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ulp-parser-stream.test.ts -t "dedupInFile" 2>&1 | tail -15`
Expected: FAIL, the `dedupInFile: false` case gets `{ rows: 1, dedup: 2 }`.

- [ ] **Step 3: Implement**

In `/home/cole/ulp-suite/lib/ulp-parser.ts`, replace

```ts
export async function* parseULPStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  batchSize: number,
  shouldHardDrop?: (email: string, url: string) => boolean,
): AsyncGenerator<StreamBatch> {
```

with

```ts
export interface ParseStreamOptions {
  /**
   * Drop a line that repeats an earlier line of the same file (default true). Novelty-aware ingest turns it off: its stage table
   * removes in-file repeats exactly, for a file of any size, where this per-file Set stops at STREAM_SEEN_CAP entries.
   */
  dedupInFile?: boolean
}

export async function* parseULPStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  batchSize: number,
  shouldHardDrop?: (email: string, url: string) => boolean,
  options: ParseStreamOptions = {},
): AsyncGenerator<StreamBatch> {
```

and, inside `parseULPStream`, replace

```ts
  function streamSeenCheck(fp: string): boolean {
    // Returns true if credential should be skipped (duplicate)
    if (seen.size >= STREAM_SEEN_CAP) {
```

with

```ts
  function streamSeenCheck(fp: string): boolean {
    // Returns true if credential should be skipped (duplicate)
    if (options.dedupInFile === false) return false
    if (seen.size >= STREAM_SEEN_CAP) {
```

- [ ] **Step 4: Run the parser suites**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ulp-parser-stream.test.ts __tests__/ulp-parser.test.ts __tests__/ulp-parser-block.test.ts __tests__/ulp-parser-extended.test.ts 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/ulp-parser.ts __tests__/ulp-parser-stream.test.ts && git commit -m "feat(parser): parseULPStream can leave in-file dedup to the caller" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The stage tables

**Files:**
- Create: `/home/cole/ulp-suite/lib/ingest-stage.ts`
- Test: `/home/cole/ulp-suite/__tests__/ingest-stage.test.ts`

**Interfaces:**
- Consumes: `getClient()` from `@/lib/clickhouse`; `URL_CONTENT_KEY` from `@/lib/url-content-key`; `withClickHouseRetry`, `ClickHouseRetryOptions` from `@/lib/clickhouse-retry`.
- Produces (later tasks rely on these exact names):
  - `interface StageTables { id: string; stage: string; known: string }` (`stage` and `known` are fully qualified, e.g. `ulp.zz_import_stage_0123456789ab`)
  - `newStageId(): string`, `stageTables(id: string): StageTables` (throws on a malformed id)
  - `stageDdl(t: StageTables): string`, `knownDdl(t: StageTables): string`
  - `createStage(t: StageTables, retry?: ClickHouseRetryOptions): Promise<void>`
  - `dropStage(t: StageTables): Promise<void>`
  - `registerStage(id: string): void`, `unregisterStage(id: string): void`, `activeStageIds(): string[]`
  - `interface StageSweepDb { list(minAgeSeconds: number): Promise<string[]>; drop(table: string): Promise<void> }`
  - `sweepOrphanStages(opts?: { minAgeSeconds?: number; db?: StageSweepDb }): Promise<string[]>` (returns the dropped table names)
  - `startStageSweeper(opts?: { intervalMs?: number }): Promise<void>` (resolves when the startup sweep has finished or failed; never rejects)

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/ingest-stage.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ command: vi.fn().mockResolvedValue({}), query: vi.fn() }))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ command: h.command, query: h.query }) }))

import {
  activeStageIds,
  createStage,
  dropStage,
  knownDdl,
  newStageId,
  registerStage,
  stageDdl,
  stageTables,
  startStageSweeper,
  sweepOrphanStages,
  unregisterStage,
  type StageSweepDb,
} from '@/lib/ingest-stage'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

const squash = (s: string) => s.replace(/\s+/g, '')

beforeEach(() => {
  h.command.mockReset()
  h.command.mockResolvedValue({})
  h.query.mockReset()
  for (const id of activeStageIds()) unregisterStage(id)
})

describe('names', () => {
  it('makes a 12-hex-character id that differs between calls', () => {
    const a = newStageId()
    const b = newStageId()
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(b).toMatch(/^[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })

  it('derives both fully qualified table names from the id', () => {
    expect(stageTables('0123456789ab')).toEqual({
      id: '0123456789ab',
      stage: 'ulp.zz_import_stage_0123456789ab',
      known: 'ulp.zz_import_known_0123456789ab',
    })
  })

  it.each(['', 'ABCDEF012345', '0123456789a', '0123456789abc', '../etc/passwd', "x'; DROP TABLE a; --"])('rejects the malformed id %j', id => {
    expect(() => stageTables(id)).toThrow(/invalid stage id/)
  })
})

describe('DDL', () => {
  const t = stageTables('0123456789ab')

  it('makes a plain, unpartitioned MergeTree stage with the six insert columns and the shared hash expression', () => {
    const ddl = stageDdl(t)
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ulp.zz_import_stage_0123456789ab')
    expect(ddl).toContain('ENGINE = MergeTree ORDER BY tuple()')
    expect(ddl).not.toMatch(/Replicated|PARTITION BY|INDEX|PROJECTION/)
    for (const column of ['url String', 'email String', 'password String', 'domain String', 'source_file String', 'breach_name String']) {
      expect(ddl).toContain(column)
    }
    expect(squash(ddl)).toContain(squash(`content_key_hash UInt64 MATERIALIZED cityHash64(${URL_CONTENT_KEY}, email, password)`))
    expect(ddl).toContain('non_replicated_deduplication_window = 10000')
  })

  it('makes a small known table ordered by the hash', () => {
    expect(knownDdl(t)).toBe(
      'CREATE TABLE IF NOT EXISTS ulp.zz_import_known_0123456789ab (content_key_hash UInt64) ENGINE = MergeTree ORDER BY content_key_hash',
    )
  })

  it('computes the hash exactly as the live table does (drift test)', () => {
    const expected = squash(`cityHash64(${URL_CONTENT_KEY}, email, password)`)
    const initSql = readFileSync(new URL('../docker/clickhouse/init/01-ulp-tables.sql', import.meta.url), 'utf8')
    const migrations = readFileSync(new URL('../lib/clickhouse-migrations.ts', import.meta.url), 'utf8')
    expect(squash(initSql)).toContain(`content_key_hashUInt64MATERIALIZED${expected}`)
    expect(squash(migrations)).toContain(squash('cityHash64(${URL_CONTENT_KEY}, email, password)'))
    expect(squash(stageDdl(t))).toContain(expected)
  })
})

describe('createStage / dropStage', () => {
  const t = stageTables('0123456789ab')

  it('creates the stage first and the known table second', async () => {
    await createStage(t)
    expect(h.command).toHaveBeenCalledTimes(2)
    expect(h.command.mock.calls[0][0].query).toBe(stageDdl(t))
    expect(h.command.mock.calls[1][0].query).toBe(knownDdl(t))
  })

  it('drops both tables synchronously, so the space is freed at once', async () => {
    await dropStage(t)
    expect(h.command.mock.calls.map(c => c[0].query)).toEqual([
      'DROP TABLE IF EXISTS ulp.zz_import_stage_0123456789ab SYNC',
      'DROP TABLE IF EXISTS ulp.zz_import_known_0123456789ab SYNC',
    ])
  })

  it('still tries the second drop when the first fails, then reports the failure', async () => {
    h.command.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({})
    await expect(dropStage(t)).rejects.toThrow('boom')
    expect(h.command).toHaveBeenCalledTimes(2)
  })
})

describe('registry', () => {
  it('tracks the stages this process is using', () => {
    expect(activeStageIds()).toEqual([])
    registerStage('aaaaaaaaaaaa')
    registerStage('bbbbbbbbbbbb')
    expect(activeStageIds().sort()).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
    unregisterStage('aaaaaaaaaaaa')
    expect(activeStageIds()).toEqual(['bbbbbbbbbbbb'])
  })
})

describe('startStageSweeper', () => {
  it('sweeps once at start, says so, and does not start a second sweeper', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.query.mockResolvedValue({ json: async () => [] })
    try {
      await startStageSweeper({ intervalMs: 3_600_000 })
      expect(warn).toHaveBeenCalledWith('[ingest-stage] start-up sweep: no orphan stage tables')
      expect(h.query).toHaveBeenCalledTimes(1)
      await startStageSweeper({ intervalMs: 3_600_000 })
      expect(h.query).toHaveBeenCalledTimes(1)
    } finally {
      clearInterval(globalThis.__ulpStageSweeper)
      globalThis.__ulpStageSweeper = undefined
    }
  })

  it('reports what it dropped, and never rejects when ClickHouse is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.query.mockRejectedValue(new Error('connection refused'))
    try {
      await expect(startStageSweeper({ intervalMs: 3_600_000 })).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('orphan sweep failed: connection refused'))
    } finally {
      clearInterval(globalThis.__ulpStageSweeper)
      globalThis.__ulpStageSweeper = undefined
    }
  })
})

describe('sweepOrphanStages', () => {
  function fakeDb(names: string[], failOn: string[] = []): StageSweepDb & { dropped: string[]; ages: number[] } {
    const dropped: string[] = []
    const ages: number[] = []
    return {
      dropped,
      ages,
      list: async age => { ages.push(age); return names },
      drop: async name => {
        if (failOn.includes(name)) throw new Error(`cannot drop ${name}`)
        dropped.push(name)
      },
    }
  }

  it('drops every stage and known table that no running import owns', async () => {
    registerStage('aaaaaaaaaaaa')
    const db = fakeDb([
      'zz_import_stage_aaaaaaaaaaaa',
      'zz_import_known_aaaaaaaaaaaa',
      'zz_import_stage_bbbbbbbbbbbb',
      'zz_import_known_bbbbbbbbbbbb',
    ])
    const dropped = await sweepOrphanStages({ db, minAgeSeconds: 1800 })
    expect(dropped).toEqual(['zz_import_stage_bbbbbbbbbbbb', 'zz_import_known_bbbbbbbbbbbb'])
    expect(db.dropped).toEqual(dropped)
    expect(db.ages).toEqual([1800])
  })

  it('keeps going when one drop fails and does not report it as dropped', async () => {
    const db = fakeDb(['zz_import_stage_cccccccccccc', 'zz_import_known_cccccccccccc'], ['zz_import_stage_cccccccccccc'])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dropped = await sweepOrphanStages({ db })
    expect(dropped).toEqual(['zz_import_known_cccccccccccc'])
    expect(db.ages).toEqual([0])
  })

  it('ignores any name that is not one of ours', async () => {
    const db = fakeDb(['credentials', 'zz_import_stage_xyz', 'zz_import_stage_dddddddddddd'])
    expect(await sweepOrphanStages({ db })).toEqual(['zz_import_stage_dddddddddddd'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-stage.test.ts 2>&1 | tail -10`
Expected: FAIL, `Failed to resolve import "@/lib/ingest-stage"`.

- [ ] **Step 3: Write the module**

Create `/home/cole/ulp-suite/lib/ingest-stage.ts`:

```ts
/**
 * Per-import stage tables for novelty-aware ingest (docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md).
 *
 * Every file being imported is parsed into its own stage table, `ulp.zz_import_stage_<id>`, a plain MergeTree with the six insert
 * columns and the same `content_key_hash` the live table materialises. `ulp.zz_import_known_<id>` holds, one slab at a time, the
 * hashes of the stage that the live table already has. Both are dropped when the import ends; if the process dies first, the
 * sweeper drops what it left (at start-up, before the inbox starts, and hourly). The names start with `zz_`, which the backup
 * script already excludes.
 *
 * The registry of ids in use lives on globalThis: instrumentation.ts (the sweeper, the inbox watcher) and the route handlers are
 * separate webpack chunks, so plain module state would not be shared.
 */
import { randomBytes } from 'node:crypto'
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
import { withClickHouseRetry, type ClickHouseRetryOptions } from '@/lib/clickhouse-retry'

const DB = 'ulp'
const STAGE_PREFIX = 'zz_import_stage_'
const KNOWN_PREFIX = 'zz_import_known_'
const ID_PATTERN = /^[0-9a-f]{12}$/
const OWN_TABLE_PATTERN = /^zz_import_(stage|known)_[0-9a-f]{12}$/
const SWEEP_AFTER_MS = 30 * 60_000

export interface StageTables {
  id: string
  /** Fully qualified, e.g. ulp.zz_import_stage_0123456789ab. */
  stage: string
  known: string
}

export function newStageId(): string {
  return randomBytes(6).toString('hex')
}

export function stageTables(id: string): StageTables {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid stage id: ${JSON.stringify(id)}`)
  return { id, stage: `${DB}.${STAGE_PREFIX}${id}`, known: `${DB}.${KNOWN_PREFIX}${id}` }
}

/**
 * The stage. No skip indexes and no projections (it is written once and read a few times), `ORDER BY tuple()` so an insert does
 * not sort. `non_replicated_deduplication_window` makes a retried batch insert (same dedup token) a no-op; the accounting does not
 * depend on it. The part limits are raised so that a very large file cannot trip TOO_MANY_PARTS before the merges catch up.
 */
export function stageDdl(t: StageTables): string {
  return `CREATE TABLE IF NOT EXISTS ${t.stage} (
  url String,
  email String,
  password String,
  domain String,
  source_file String,
  breach_name String,
  content_key_hash UInt64 MATERIALIZED cityHash64(${URL_CONTENT_KEY}, email, password)
) ENGINE = MergeTree ORDER BY tuple()
SETTINGS non_replicated_deduplication_window = 10000, parts_to_delay_insert = 3000, parts_to_throw_insert = 6000`
}

export function knownDdl(t: StageTables): string {
  return `CREATE TABLE IF NOT EXISTS ${t.known} (content_key_hash UInt64) ENGINE = MergeTree ORDER BY content_key_hash`
}

/** Idempotent (`IF NOT EXISTS`), so it is safe inside the transient-error retry loop. */
export async function createStage(t: StageTables, retry: ClickHouseRetryOptions = {}): Promise<void> {
  await withClickHouseRetry(async signal => {
    const client = getClient()
    await client.command({ query: stageDdl(t), abort_signal: signal })
    await client.command({ query: knownDdl(t), abort_signal: signal })
  }, retry)
}

/** SYNC: in an Atomic database a plain DROP keeps the data for minutes, and a stage can be gigabytes. Tries both even if one fails. */
export async function dropStage(t: StageTables): Promise<void> {
  const client = getClient()
  let firstError: unknown
  for (const table of [t.stage, t.known]) {
    try {
      await client.command({ query: `DROP TABLE IF EXISTS ${table} SYNC` })
    } catch (err) {
      firstError ??= err
    }
  }
  if (firstError !== undefined) throw firstError
}

// ── registry of stages in use ───────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __ulpActiveStages: Set<string> | undefined
}

const active = () => (globalThis.__ulpActiveStages ??= new Set<string>())

/** Call BEFORE createStage: the sweeper must never see a table of ours that is not registered. */
export function registerStage(id: string): void {
  active().add(id)
}

export function unregisterStage(id: string): void {
  active().delete(id)
}

export function activeStageIds(): string[] {
  return [...active()]
}

// ── orphan sweeper ──────────────────────────────────────────────────────────────────────────────────

export interface StageSweepDb {
  /** Names (without the database) of stage / known tables older than `minAgeSeconds`. */
  list(minAgeSeconds: number): Promise<string[]>
  drop(table: string): Promise<void>
}

function clickhouseSweepDb(): StageSweepDb {
  return {
    async list(minAgeSeconds) {
      const res = await getClient().query({
        query: `SELECT name FROM system.tables
                WHERE database = '${DB}' AND match(name, '^zz_import_(stage|known)_[0-9a-f]{12}$')
                  AND metadata_modification_time <= now() - toIntervalSecond({age:UInt32})
                ORDER BY name`,
        query_params: { age: Math.max(0, Math.floor(minAgeSeconds)) },
        format: 'JSONEachRow',
        clickhouse_settings: { use_query_cache: 0 },
      })
      return ((await res.json()) as Array<{ name: string }>).map(r => r.name)
    },
    async drop(table) {
      if (!OWN_TABLE_PATTERN.test(table)) throw new Error(`refusing to drop ${table}`)
      await getClient().command({ query: `DROP TABLE IF EXISTS ${DB}.${table} SYNC` })
    },
  }
}

/** Drops the stage and known tables that no import running in this process owns. Returns the names it dropped. */
export async function sweepOrphanStages(opts: { minAgeSeconds?: number; db?: StageSweepDb } = {}): Promise<string[]> {
  const db = opts.db ?? clickhouseSweepDb()
  const owned = new Set(activeStageIds())
  const dropped: string[] = []
  for (const name of await db.list(opts.minAgeSeconds ?? 0)) {
    if (!OWN_TABLE_PATTERN.test(name)) continue
    if (owned.has(name.slice(name.lastIndexOf('_') + 1))) continue
    try {
      await db.drop(name)
      dropped.push(name)
    } catch (err) {
      console.warn(`[ingest-stage] could not drop ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return dropped
}

declare global {
  // eslint-disable-next-line no-var
  var __ulpStageSweeper: ReturnType<typeof setInterval> | undefined
}

/**
 * Sweeps once now (nothing a previous process started can still be running) and then hourly, leaving anything younger than 30
 * minutes alone. The returned promise settles when the first sweep is done so that start-up can wait for it before the inbox
 * watcher begins; it never rejects.
 */
export async function startStageSweeper(opts: { intervalMs?: number } = {}): Promise<void> {
  if (globalThis.__ulpStageSweeper) return
  // console.warn, not console.log: the production build strips console.log (next.config removeConsole keeps error and warn).
  const run = async (minAgeSeconds: number, announce: boolean) => {
    try {
      const dropped = await sweepOrphanStages({ minAgeSeconds })
      if (dropped.length > 0) console.warn(`[ingest-stage] dropped ${dropped.length} orphan stage table(s): ${dropped.join(', ')}`)
      else if (announce) console.warn('[ingest-stage] start-up sweep: no orphan stage tables')
    } catch (err) {
      console.warn(`[ingest-stage] orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const timer = setInterval(() => void run(SWEEP_AFTER_MS / 1000, false), opts.intervalMs ?? 60 * 60_000)
  timer.unref?.()
  globalThis.__ulpStageSweeper = timer
  await run(0, true)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-stage.test.ts 2>&1 | tail -12`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/ingest-stage.ts __tests__/ingest-stage.test.ts && git commit -m "feat(ingest): per-import stage tables, a registry of those in use and an orphan sweeper" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 5: The commit module, part 1: SQL builders, the ClickHouse executor and the lock

**Files:**
- Create: `/home/cole/ulp-suite/lib/ingest-novelty.ts`
- Test: `/home/cole/ulp-suite/__tests__/ingest-novelty-sql.test.ts`

**Interfaces:**
- Consumes: `StageTables` from `@/lib/ingest-stage`; `COMMIT_MAX_EXECUTION_S`, `slabCount` from `@/lib/ingest-novelty-config`; `buildNormalizedDomainSetMatch`, `MatchMode` from `@/lib/domain-match`; `getClient` from `@/lib/clickhouse`.
- Produces (Task 6 and later tasks rely on these exact names):
  - SQL builders (all pure, all return a `string` unless noted): `slabPredicate(K, k)`, `stageCountSql(t)`, `slabDistinctSql(t, K, k)`, `knownResetSql(t)`, `knownFillSql(t, against, K, k)`, `knownCountSql(t)`, `commitInsertSql(t, target, K, k)`, `monitorStageSql(t, K, k, monitor, limit): { sql: string; params: Record<string, unknown> } | null`
  - `interface NoveltyDb { exec(sql, o: { queryId: string; signal: AbortSignal }): Promise<{ writtenRows: number | null }>; select<T>(sql, o: { queryId: string; signal: AbortSignal; params?: Record<string, unknown> }): Promise<T[]>; kill(queryId: string): Promise<void> }`
  - `clickhouseNoveltyDb(): NoveltyDb`
  - `acquireCommitLock(signal: AbortSignal): Promise<() => void>` (the returned release function is idempotent), `resetCommitLock(): void` (test seam)

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/ingest-novelty-sql.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ command: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ command: h.command, query: h.query }) }))

import {
  acquireCommitLock,
  clickhouseNoveltyDb,
  commitInsertSql,
  knownCountSql,
  knownFillSql,
  knownResetSql,
  monitorStageSql,
  resetCommitLock,
  slabDistinctSql,
  slabPredicate,
  stageCountSql,
} from '@/lib/ingest-novelty'
import { stageTables } from '@/lib/ingest-stage'

const t = stageTables('0123456789ab')
const never = new AbortController().signal

beforeEach(() => {
  h.command.mockReset()
  h.query.mockReset()
  resetCommitLock()
})

describe('SQL builders', () => {
  it('slabPredicate selects the rows whose hash falls in slab k of K', () => {
    expect(slabPredicate(1, 0)).toBe('content_key_hash % 1 = 0')
    expect(slabPredicate(15, 14)).toBe('content_key_hash % 15 = 14')
  })

  it.each([[0, 0], [3, 3], [3, -1], [2.5, 0], [3, 0.5], [Number.NaN, 0]])('slabPredicate rejects slab %s of %s', (K, k) => {
    expect(() => slabPredicate(K as number, k as number)).toThrow(/bad slab/)
  })

  it('counts the stage and the slab\'s distinct hashes', () => {
    expect(stageCountSql(t)).toBe('SELECT count() AS c FROM ulp.zz_import_stage_0123456789ab')
    expect(slabDistinctSql(t, 3, 1)).toBe(
      'SELECT uniqExact(content_key_hash) AS c FROM ulp.zz_import_stage_0123456789ab WHERE content_key_hash % 3 = 1',
    )
  })

  it('resets and fills the known table by probing the table with the slab\'s hashes (the small side)', () => {
    expect(knownResetSql(t)).toBe('TRUNCATE TABLE ulp.zz_import_known_0123456789ab')
    expect(knownFillSql(t, 'ulp.credentials', 3, 1)).toBe(
      'INSERT INTO ulp.zz_import_known_0123456789ab\n' +
      'SELECT DISTINCT content_key_hash FROM ulp.credentials\n' +
      'WHERE content_key_hash IN (SELECT content_key_hash FROM ulp.zz_import_stage_0123456789ab WHERE content_key_hash % 3 = 1)',
    )
    expect(knownCountSql(t)).toBe('SELECT count() AS c FROM ulp.zz_import_known_0123456789ab')
  })

  it('inserts one row per new hash, in the six insert columns only', () => {
    expect(commitInsertSql(t, 'ulp.credentials', 3, 1)).toBe(
      'INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name)\n' +
      'SELECT url, email, password, domain, source_file, breach_name FROM ulp.zz_import_stage_0123456789ab\n' +
      'WHERE content_key_hash % 3 = 1 AND content_key_hash NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)\n' +
      'LIMIT 1 BY content_key_hash',
    )
  })

  it.each(['credentials', 'ulp.credentials; DROP TABLE ulp.sources', 'ulp.', '.credentials', 'a.b.c', "ulp.x'y"])('refuses the table name %j', name => {
    expect(() => commitInsertSql(t, name, 1, 0)).toThrow(/invalid table name/)
    expect(() => knownFillSql(t, name, 1, 0)).toThrow(/invalid table name/)
  })

  describe('monitorStageSql', () => {
    it('matches the not-yet-known rows of the slab with one normalisation per row', () => {
      const q = monitorStageSql(t, 3, 1, { domains: [' Example.test ', 'other.test'], match_mode: 'both' }, 50)!
      expect(q.sql).toContain('FROM ulp.zz_import_stage_0123456789ab')
      expect(q.sql).toContain('WHERE content_key_hash % 3 = 1 AND content_key_hash NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)')
      expect(q.sql).toContain('arrayExists')
      expect(q.sql).toMatch(/LIMIT 1 BY content_key_hash\nLIMIT 50$/)
      expect(q.params).toEqual({ matchDomains: ['example.test', 'other.test'], matchSuffixes: ['.example.test', '.other.test'] })
    })

    it('has no match to make for an empty domain list or an exhausted cap', () => {
      expect(monitorStageSql(t, 1, 0, { domains: [], match_mode: 'url' }, 10)).toBeNull()
      expect(monitorStageSql(t, 1, 0, { domains: ['  '], match_mode: 'url' }, 10)).toBeNull()
      expect(monitorStageSql(t, 1, 0, { domains: ['a.test'], match_mode: 'url' }, 0)).toBeNull()
    })

    it.each(['url', 'credential', 'both'] as const)('builds a query for the %s mode', mode => {
      const q = monitorStageSql(t, 1, 0, { domains: ['a.test'], match_mode: mode }, 5)!
      expect(q.sql).toMatch(/SELECT url, email, password, domain, content_key_hash, \S/)
    })
  })
})

describe('clickhouseNoveltyDb', () => {
  it('runs a statement with the commit settings (not the client default of 60 s) and reports the written rows', async () => {
    h.command.mockResolvedValue({ query_id: 'q', summary: { written_rows: '2452248', read_rows: '1' } })
    const db = clickhouseNoveltyDb()
    const out = await db.exec('INSERT INTO ulp.x SELECT 1', { queryId: 'novelty-q1', signal: never })
    expect(out).toEqual({ writtenRows: 2452248 })
    const call = h.command.mock.calls[0][0]
    expect(call.query).toBe('INSERT INTO ulp.x SELECT 1')
    expect(call.query_id).toBe('novelty-q1')
    expect(call.abort_signal).toBe(never)
    expect(call.clickhouse_settings).toEqual({ max_execution_time: 3300, insert_deduplicate: 0, async_insert: 0, use_query_cache: 0 })
  })

  it('reports no written-rows count when the server sent no summary or a malformed one', async () => {
    const db = clickhouseNoveltyDb()
    h.command.mockResolvedValueOnce({ query_id: 'q' })
    expect(await db.exec('TRUNCATE TABLE ulp.x', { queryId: 'novelty-q2', signal: never })).toEqual({ writtenRows: null })
    h.command.mockResolvedValueOnce({ query_id: 'q', summary: { written_rows: 'n/a' } })
    expect(await db.exec('TRUNCATE TABLE ulp.x', { queryId: 'novelty-q3', signal: never })).toEqual({ writtenRows: null })
  })

  it('selects rows as JSON with the same settings and the query parameters', async () => {
    const json = vi.fn().mockResolvedValue([{ c: '7' }])
    h.query.mockResolvedValue({ json, close: vi.fn() })
    const db = clickhouseNoveltyDb()
    const rows = await db.select<{ c: string }>('SELECT {a:UInt8} AS c', { queryId: 'novelty-q4', signal: never, params: { a: 1 } })
    expect(rows).toEqual([{ c: '7' }])
    const call = h.query.mock.calls[0][0]
    expect(call.format).toBe('JSONEachRow')
    expect(call.query_params).toEqual({ a: 1 })
    expect(call.query_id).toBe('novelty-q4')
    expect(call.clickhouse_settings.max_execution_time).toBe(3300)
    expect(call.clickhouse_settings.use_query_cache).toBe(0)
  })

  it('closes a result set whose signal aborts instead of waiting for the body', async () => {
    const ctrl = new AbortController()
    const close = vi.fn()
    h.query.mockResolvedValue({ json: () => new Promise(() => {}), close })
    const db = clickhouseNoveltyDb()
    const pending = db.select('SELECT 1', { queryId: 'novelty-q5', signal: ctrl.signal })
    await new Promise(r => setTimeout(r, 10))
    ctrl.abort(new Error('stalled'))
    expect(close).toHaveBeenCalled()
    pending.catch(() => {}) // the unresolved body promise is the fake's; nothing more to wait for
  })

  it('kills a statement by its query id, synchronously, and refuses any other id', async () => {
    h.command.mockResolvedValue({ query_id: 'k' })
    const db = clickhouseNoveltyDb()
    await db.kill('novelty-0123abcd-0123-4abc-8abc-0123456789ab')
    expect(h.command.mock.calls[0][0].query).toBe("KILL QUERY WHERE query_id = 'novelty-0123abcd-0123-4abc-8abc-0123456789ab' SYNC")
    expect(h.command.mock.calls[0][0].abort_signal).toBeInstanceOf(AbortSignal) // bounded: a frozen server must not hold the lock
    await expect(db.kill("novelty-x' OR 1=1 --")).rejects.toThrow(/invalid query id/)
    await expect(db.kill('something-else')).rejects.toThrow(/invalid query id/)
  })
})

describe('acquireCommitLock', () => {
  it('hands the lock to one holder at a time, in arrival order', async () => {
    const order: string[] = []
    const first = await acquireCommitLock(never)
    const second = acquireCommitLock(never).then(release => { order.push('second'); return release })
    const third = acquireCommitLock(never).then(release => { order.push('third'); return release })
    await new Promise(r => setTimeout(r, 10))
    expect(order).toEqual([])
    first()
    const secondRelease = await second
    expect(order).toEqual(['second'])
    secondRelease()
    ;(await third)()
    expect(order).toEqual(['second', 'third'])
  })

  it('release is idempotent', async () => {
    const release = await acquireCommitLock(never)
    release()
    release()
    const next = await Promise.race([acquireCommitLock(never), new Promise<null>(r => setTimeout(() => r(null), 100))])
    expect(next).not.toBeNull()
  })

  it('a waiter that is aborted gives up its place without blocking those behind it', async () => {
    const holder = await acquireCommitLock(never)
    const ctrl = new AbortController()
    const abandoned = acquireCommitLock(ctrl.signal)
    const behind = acquireCommitLock(never)
    ctrl.abort(new Error('stalled'))
    await expect(abandoned).rejects.toThrow('stalled')
    holder()
    const release = await Promise.race([behind, new Promise<null>(r => setTimeout(() => r(null), 200))])
    expect(release).not.toBeNull()
  })

  it('refuses at once when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort(new Error('already'))
    await expect(acquireCommitLock(ctrl.signal)).rejects.toThrow('already')
    const release = await Promise.race([acquireCommitLock(never), new Promise<null>(r => setTimeout(() => r(null), 100))])
    expect(release).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-novelty-sql.test.ts 2>&1 | tail -10`
Expected: FAIL, `Failed to resolve import "@/lib/ingest-novelty"`.

- [ ] **Step 3: Write the module (without `commitStage`, which is Task 6)**

Create `/home/cole/ulp-suite/lib/ingest-novelty.ts`:

```ts
/**
 * Novelty-aware ingest, commit phase (docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md).
 *
 * A file has been parsed into a stage table (lib/ingest-stage.ts). This module moves its rows into the real table one slab at a
 * time, so that only credentials the table does not hold yet are written:
 *
 *   known  = the slab's hashes that the table already has        (one scan of one column: about 10 s at 1.4B rows)
 *   insert = the slab's rows whose hash is not in `known`, one row per hash (LIMIT 1 BY), in one INSERT ... SELECT
 *
 * Retrying is therefore safe at any point. A retry recomputes `known`, which by then includes whatever an interrupted attempt
 * wrote, and inserts only the rest. That is also why the insert runs with insert_deduplicate = 0: a dedup token is only sound
 * for deterministic block formation, and a parallel read of the stage is not deterministic.
 *
 * The table is probed with the SMALL side (the slab's hashes), never `NOT IN (SELECT ... FROM <the big table>)`, which would
 * build a set of the whole table in memory (the lesson recorded in lib/content-dedup.ts).
 *
 * Settings travel as client settings: the client's default max_execution_time is 60 s and a slab takes minutes.
 */
import { randomUUID } from 'node:crypto'
import type { ClickHouseSettings } from '@clickhouse/client'
import { getClient } from '@/lib/clickhouse'
import { buildNormalizedDomainSetMatch, type MatchMode } from '@/lib/domain-match'
import { COMMIT_MAX_EXECUTION_S } from '@/lib/ingest-novelty-config'
import type { StageTables } from '@/lib/ingest-stage'

// ── SQL builders (pure) ─────────────────────────────────────────────────────────────────────────────

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/

function qualified(name: string): string {
  if (!TABLE_NAME.test(name)) throw new Error(`invalid table name: ${JSON.stringify(name)}`)
  return name
}

/** The stage rows of slab `k` of `K`: the hash decides, so a credential always lands in the same slab. */
export function slabPredicate(K: number, k: number): string {
  if (!Number.isInteger(K) || !Number.isInteger(k) || K < 1 || k < 0 || k >= K) throw new Error(`bad slab ${k} of ${K}`)
  return `content_key_hash % ${K} = ${k}`
}

export const stageCountSql = (t: StageTables) => `SELECT count() AS c FROM ${t.stage}`

export const slabDistinctSql = (t: StageTables, K: number, k: number) =>
  `SELECT uniqExact(content_key_hash) AS c FROM ${t.stage} WHERE ${slabPredicate(K, k)}`

export const knownResetSql = (t: StageTables) => `TRUNCATE TABLE ${t.known}`

export const knownFillSql = (t: StageTables, against: string, K: number, k: number) =>
  `INSERT INTO ${t.known}\n` +
  `SELECT DISTINCT content_key_hash FROM ${qualified(against)}\n` +
  `WHERE content_key_hash IN (SELECT content_key_hash FROM ${t.stage} WHERE ${slabPredicate(K, k)})`

export const knownCountSql = (t: StageTables) => `SELECT count() AS c FROM ${t.known}`

export const commitInsertSql = (t: StageTables, target: string, K: number, k: number) =>
  `INSERT INTO ${qualified(target)} (url, email, password, domain, source_file, breach_name)\n` +
  `SELECT url, email, password, domain, source_file, breach_name FROM ${t.stage}\n` +
  `WHERE ${slabPredicate(K, k)} AND content_key_hash NOT IN (SELECT content_key_hash FROM ${t.known})\n` +
  `LIMIT 1 BY content_key_hash`

/**
 * The new rows of slab k that one monitor matches. The normalisation (lib/ulp-normalize.ts) is computed once per row in the inner
 * query and the domain set is tested with one arrayExists, so the cost does not grow with the number of monitored domains
 * (buildDomainSetWhereClause repeats the expression per domain: 2.3x slower at 17 domains). Same semantics as the in-process matcher.
 * Returns null when there is nothing to ask.
 */
export function monitorStageSql(
  t: StageTables,
  K: number,
  k: number,
  monitor: { domains: string[]; match_mode: MatchMode },
  limit: number,
): { sql: string; params: Record<string, unknown> } | null {
  const domains = monitor.domains.map(d => d.trim()).filter(d => d !== '')
  const cap = Math.floor(limit)
  if (domains.length === 0 || !(cap > 0)) return null
  const match = buildNormalizedDomainSetMatch(domains, monitor.match_mode)
  const sql =
    `SELECT url, email, password, domain FROM (\n` +
    `  SELECT url, email, password, domain, content_key_hash, ${match.normalizedColumns}\n` +
    `  FROM ${t.stage}\n` +
    `  WHERE ${slabPredicate(K, k)} AND content_key_hash NOT IN (SELECT content_key_hash FROM ${t.known})\n` +
    `) WHERE ${match.clause}\n` +
    `LIMIT 1 BY content_key_hash\n` +
    `LIMIT ${cap}`
  return { sql, params: match.params }
}

// ── the ClickHouse executor ─────────────────────────────────────────────────────────────────────────

export interface NoveltyDb {
  /** Runs a statement that returns no rows. `writtenRows` is the server's own count, or null when it sent none. */
  exec(sql: string, o: { queryId: string; signal: AbortSignal }): Promise<{ writtenRows: number | null }>
  select<T>(sql: string, o: { queryId: string; signal: AbortSignal; params?: Record<string, unknown> }): Promise<T[]>
  /** Best-effort KILL QUERY of a statement this module started. */
  kill(queryId: string): Promise<void>
}

const COMMIT_SETTINGS = {
  max_execution_time: COMMIT_MAX_EXECUTION_S,
  insert_deduplicate: 0,
  async_insert: 0,
  use_query_cache: 0,
} as unknown as ClickHouseSettings

const QUERY_ID = /^novelty-[0-9a-f-]{36}$/
const KILL_TIMEOUT_MS = 15_000

export const newQueryId = () => `novelty-${randomUUID()}`

export function clickhouseNoveltyDb(): NoveltyDb {
  return {
    async exec(sql, { queryId, signal }) {
      const res = await getClient().command({
        query: sql,
        query_id: queryId,
        abort_signal: signal,
        clickhouse_settings: COMMIT_SETTINGS,
      })
      const written = res.summary ? Number(res.summary.written_rows) : Number.NaN
      return { writtenRows: Number.isFinite(written) ? written : null }
    },

    async select<T>(sql: string, { queryId, signal, params }: { queryId: string; signal: AbortSignal; params?: Record<string, unknown> }) {
      const res = await getClient().query({
        query: sql,
        query_params: params,
        query_id: queryId,
        abort_signal: signal,
        format: 'JSONEachRow',
        clickhouse_settings: COMMIT_SETTINGS,
      })
      // Same guard as lib/upload-processor.ts: an abort while the body is being read must not leave the promise hanging.
      const closeOnAbort = () => res.close()
      signal.addEventListener('abort', closeOnAbort, { once: true })
      try {
        if (signal.aborted) {
          closeOnAbort()
          throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
        }
        return (await res.json()) as T[]
      } finally {
        signal.removeEventListener('abort', closeOnAbort)
      }
    },

    async kill(queryId) {
      // Interpolated, not a query parameter: the id is generated here and checked against a fixed shape.
      if (!QUERY_ID.test(queryId)) throw new Error(`invalid query id: ${JSON.stringify(queryId)}`)
      // Bounded: the kill runs while the commit lock is still held, and a ClickHouse that is frozen or unreachable must not keep
      // every other import waiting for the lock for as long as the client's own one-hour request timeout.
      await getClient().command({
        query: `KILL QUERY WHERE query_id = '${queryId}' SYNC`,
        abort_signal: AbortSignal.timeout(KILL_TIMEOUT_MS),
        clickhouse_settings: { max_execution_time: 60 } as unknown as ClickHouseSettings,
      })
    },
  }
}

// ── the process-wide commit lock ────────────────────────────────────────────────────────────────────

interface LockStore {
  tail: Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __ulpNoveltyLock: LockStore | undefined
}

const lockStore = () => (globalThis.__ulpNoveltyLock ??= { tail: Promise.resolve() })

/** Test seam. */
export function resetCommitLock(): void {
  globalThis.__ulpNoveltyLock = undefined
}

function waitOrAbort(p: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    void p.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}

/**
 * One slab at a time across all imports in this process (the uploadQueue may run two files at once), so two imports never both
 * read "unknown" for the same new credential. First come, first served. The state lives on globalThis: instrumentation.ts (the
 * inbox watcher) and the route handlers are separate webpack chunks, so a module-level mutex would be two mutexes.
 * Resolves with an idempotent release function; rejects, without keeping its place, when `signal` aborts first.
 */
export async function acquireCommitLock(signal: AbortSignal): Promise<() => void> {
  const store = lockStore()
  const previous = store.tail
  let released = false
  let release!: () => void
  const mine = new Promise<void>(resolve => {
    release = () => {
      if (released) return
      released = true
      resolve()
    }
  })
  store.tail = previous.then(() => mine)
  try {
    await waitOrAbort(previous, signal)
  } catch (err) {
    release() // we never held it: let the chain move on
    throw err
  }
  return release
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-novelty-sql.test.ts 2>&1 | tail -14`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/ingest-novelty.ts __tests__/ingest-novelty-sql.test.ts && git commit -m "feat(ingest): the commit SQL, a ClickHouse executor with the commit settings, and the process-wide commit lock" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The commit module, part 2: `commitStage`

**Files:**
- Modify: `/home/cole/ulp-suite/lib/ingest-novelty.ts` (append)
- Test: `/home/cole/ulp-suite/__tests__/ingest-novelty-commit.test.ts`

**Interfaces:**
- Consumes: everything Task 5 produced; `waitForDiskSpace` from `@/lib/ingest-disk-gate`; `waitForHeadroom` from `@/lib/clickhouse-memory-guard`; `MatchedCredential` from `@/lib/domain-match`; `slabCount` from `@/lib/ingest-novelty-config`.
- Produces:
  - `class NoveltyAccountingError extends Error`
  - `interface CommitMonitor { id: number; domains: string[]; match_mode: MatchMode }`
  - `interface CommitGates { disk(signal, o: { onPoll?: () => void }): Promise<void>; memory(signal, o: { onPoll?: () => void }): Promise<void> }`
  - `interface CommitOptions { tables: StageTables; target: string; noveltyAgainst: string; parsedRows: number; slabRows: number; signal: AbortSignal; beat?: () => void; onPhase?: (e: { phase: 'checking' | 'inserting'; slab: number; slabs: number }) => void; onSlab?: (e: { slab: number; slabs: number; known: number; inserted: number }) => void; monitors?: CommitMonitor[]; matchCap?: number; db?: NoveltyDb; gates?: CommitGates; newQueryId?: () => string }`
  - `interface CommitResult { rows: number; distinct: number; known: number; inserted: number; inFileDuplicates: number; slabs: number; matches: MatchedCredential[] }`
  - `commitStage(opts: CommitOptions): Promise<CommitResult>`

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/ingest-novelty-commit.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ getClient: vi.fn() }))

import {
  acquireCommitLock,
  commitStage,
  NoveltyAccountingError,
  resetCommitLock,
  type CommitGates,
  type CommitOptions,
  type NoveltyDb,
} from '@/lib/ingest-novelty'
import { stageTables } from '@/lib/ingest-stage'

const tables = stageTables('0123456789ab')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Call { kind: 'select' | 'exec' | 'kill'; sql: string; queryId: string }

interface FakeConfig {
  stageRows: number
  distinct: number[]
  known: number[]
  written?: (k: number, expected: number) => number | null
  monitorRows?: Array<{ url: string; email: string; password: string; domain: string }>
  monitorError?: Error
  execDelayMs?: number
  hang?: RegExp
  onSlabStart?: () => void
  onSlabEnd?: () => void
}

function makeDb(cfg: FakeConfig) {
  const calls: Call[] = []
  let slab = 0
  const slabOf = (sql: string) => Number(/% \d+ = (\d+)/.exec(sql)?.[1] ?? 0)
  const db: NoveltyDb & { calls: Call[] } = {
    calls,
    async select<T>(sql: string) {
      const typed = (rows: unknown) => rows as T[]
      calls.push({ kind: 'select', sql, queryId: '' })
      if (cfg.execDelayMs) await sleep(cfg.execDelayMs)
      if (sql.startsWith('SELECT count() AS c FROM ulp.zz_import_stage_')) return typed([{ c: String(cfg.stageRows) }])
      if (sql.startsWith('SELECT uniqExact')) return typed([{ c: String(cfg.distinct[slabOf(sql)]) }])
      if (sql.startsWith('SELECT count() AS c FROM ulp.zz_import_known_')) return typed([{ c: String(cfg.known[slab]) }])
      if (sql.startsWith('SELECT url, email, password, domain FROM (')) {
        if (cfg.monitorError) throw cfg.monitorError
        return typed(cfg.monitorRows ?? [])
      }
      throw new Error(`unexpected select: ${sql}`)
    },
    async exec(sql, { queryId, signal }) {
      calls.push({ kind: 'exec', sql, queryId })
      if (cfg.execDelayMs) await sleep(cfg.execDelayMs)
      if (cfg.hang?.test(sql)) {
        await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      if (sql.startsWith('TRUNCATE TABLE')) return { writtenRows: null }
      if (sql.startsWith('INSERT INTO ulp.zz_import_known_')) {
        slab = slabOf(sql)
        cfg.onSlabStart?.()
        return { writtenRows: cfg.known[slab] }
      }
      if (sql.startsWith('INSERT INTO ulp.')) {
        const k = slabOf(sql)
        const expected = cfg.distinct[k] - cfg.known[k]
        const out = { writtenRows: cfg.written ? cfg.written(k, expected) : expected }
        cfg.onSlabEnd?.()
        return out
      }
      throw new Error(`unexpected exec: ${sql}`)
    },
    async kill(queryId) {
      calls.push({ kind: 'kill', sql: '', queryId })
    },
  }
  return db
}

const gates = (events: string[]): CommitGates => ({
  disk: async () => { events.push('disk') },
  memory: async () => { events.push('memory') },
})

let counter = 0
const options = (db: NoveltyDb, extra: Partial<CommitOptions> = {}): CommitOptions => ({
  tables,
  target: 'ulp.credentials',
  noveltyAgainst: 'ulp.credentials',
  parsedRows: 0,
  slabRows: 20_000_000,
  signal: new AbortController().signal,
  db,
  gates: gates([]),
  newQueryId: () => `novelty-test-${++counter}`,
  ...extra,
})

const shape = (db: { calls: Call[] }) =>
  db.calls.map(c => (c.kind === 'kill' ? 'kill' : `${c.kind}: ${c.sql.split('\n')[0].slice(0, 46)}`))

beforeEach(() => {
  counter = 0
  resetCommitLock()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('commitStage', () => {
  it('writes a file of new rows in one slab and accounts for every parsed row', async () => {
    const db = makeDb({ stageRows: 1000, distinct: [900], known: [0] })
    const out = await commitStage(options(db, { parsedRows: 1000 }))
    expect(out).toMatchObject({ rows: 1000, distinct: 900, known: 0, inserted: 900, inFileDuplicates: 100, slabs: 1, matches: [] })
    expect(out.rows).toBe(out.inserted + out.known + out.inFileDuplicates)
    expect(shape(db)).toEqual([
      'select: SELECT count() AS c FROM ulp.zz_import_stage_',
      'select: SELECT uniqExact(content_key_hash) AS c FROM u',
      'exec: TRUNCATE TABLE ulp.zz_import_known_0123456789ab',
      'exec: INSERT INTO ulp.zz_import_known_0123456789ab',
      'select: SELECT count() AS c FROM ulp.zz_import_known_',
      'exec: INSERT INTO ulp.credentials (url, email, passwo',
    ])
  })

  it('writes only what the table does not hold', async () => {
    const db = makeDb({ stageRows: 1000, distinct: [1000], known: [400] })
    const out = await commitStage(options(db, { parsedRows: 1000 }))
    expect(out).toMatchObject({ distinct: 1000, known: 400, inserted: 600, inFileDuplicates: 0 })
    expect(out.rows).toBe(out.inserted + out.known + out.inFileDuplicates)
    const insert = db.calls.find(c => c.sql.startsWith('INSERT INTO ulp.credentials'))!
    expect(insert.sql).toContain('NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)')
    expect(insert.sql).toContain('LIMIT 1 BY content_key_hash')
  })

  it('reads one table and writes another when they differ (the read-only parity check)', async () => {
    const db = makeDb({ stageRows: 10, distinct: [10], known: [0] })
    await commitStage(options(db, { parsedRows: 10, target: 'ulp.zz_clone', noveltyAgainst: 'ulp.credentials' }))
    const fill = db.calls.find(c => c.sql.startsWith('INSERT INTO ulp.zz_import_known_'))!
    expect(fill.sql).toContain('FROM ulp.credentials\n')
    expect(db.calls.some(c => c.sql.startsWith('INSERT INTO ulp.zz_clone (url'))).toBe(true)
    expect(db.calls.some(c => c.sql.startsWith('INSERT INTO ulp.credentials'))).toBe(false)
  })

  it('commits in slabs by hash, skips the insert of a slab that is entirely known, and reports running totals', async () => {
    const db = makeDb({ stageRows: 2500, distinct: [800, 850, 850], known: [0, 100, 850] })
    const slabs: Array<{ slab: number; slabs: number; known: number; inserted: number }> = []
    const phases: string[] = []
    const out = await commitStage(options(db, {
      parsedRows: 2600,
      slabRows: 1000,
      onSlab: e => slabs.push(e),
      onPhase: e => phases.push(`${e.slab}/${e.slabs} ${e.phase}`),
    }))
    expect(out).toMatchObject({ slabs: 3, distinct: 2500, known: 950, inserted: 1550, inFileDuplicates: 100 })
    expect(slabs).toEqual([
      { slab: 1, slabs: 3, known: 0, inserted: 800 },
      { slab: 2, slabs: 3, known: 100, inserted: 1550 },
      { slab: 3, slabs: 3, known: 950, inserted: 1550 },
    ])
    expect(phases).toEqual(['1/3 checking', '1/3 inserting', '2/3 checking', '2/3 inserting', '3/3 checking'])
    const inserts = db.calls.filter(c => c.sql.startsWith('INSERT INTO ulp.credentials'))
    expect(inserts).toHaveLength(2) // slab 3 is entirely known
    expect(inserts[0].sql).toContain('content_key_hash % 3 = 0')
    expect(inserts[1].sql).toContain('content_key_hash % 3 = 1')
    expect(db.calls.filter(c => c.sql.startsWith('TRUNCATE')).length).toBe(3)
  })

  it('does nothing, and asks nothing of the gates, for an empty stage', async () => {
    const events: string[] = []
    const db = makeDb({ stageRows: 0, distinct: [], known: [] })
    const out = await commitStage(options(db, { parsedRows: 0, gates: gates(events) }))
    expect(out).toMatchObject({ rows: 0, distinct: 0, known: 0, inserted: 0, inFileDuplicates: 0, slabs: 1 })
    expect(shape(db)).toEqual(['select: SELECT count() AS c FROM ulp.zz_import_stage_'])
    expect(events).toEqual([])
  })

  it('waits for the disk gate and the memory guard before every slab, and before taking the lock', async () => {
    const events: string[] = []
    const db = makeDb({ stageRows: 2000, distinct: [1000, 1000], known: [0, 0], onSlabStart: () => events.push('slab-sql') })
    await commitStage(options(db, { parsedRows: 2000, slabRows: 1000, gates: gates(events) }))
    expect(events).toEqual(['disk', 'memory', 'slab-sql', 'disk', 'memory', 'slab-sql'])
  })

  it('asks the gates before it waits for the lock, so a paused import never holds the lock', async () => {
    const events: string[] = []
    const holder = await acquireCommitLock(new AbortController().signal)
    const db = makeDb({ stageRows: 10, distinct: [10], known: [0], onSlabStart: () => events.push('slab-sql') })
    const run = commitStage(options(db, { parsedRows: 10, gates: gates(events) }))
    await sleep(30)
    expect(events).toEqual(['disk', 'memory']) // the gates are done, the import is still waiting for the lock
    holder()
    await run
    expect(events).toEqual(['disk', 'memory', 'slab-sql'])
  })

  it('passes the heartbeat to the gates and beats after every statement', async () => {
    const beat = vi.fn()
    let polled: (() => void) | undefined
    const db = makeDb({ stageRows: 10, distinct: [10], known: [0] })
    await commitStage(options(db, {
      parsedRows: 10,
      beat,
      gates: { disk: async (_s, o) => { polled = o.onPoll }, memory: async () => {} },
    }))
    expect(polled).toBe(beat)
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(6) // one per statement
  })

  it('fails the job, keeping the rows already written, when ClickHouse reports a different count', async () => {
    const db = makeDb({ stageRows: 1000, distinct: [1000], known: [400], written: (_k, expected) => expected + 1 })
    await expect(commitStage(options(db, { parsedRows: 1000 }))).rejects.toThrow(NoveltyAccountingError)
    await expect(commitStage(options(db, { parsedRows: 1000 }))).rejects.toThrow(/reported 601 rows written but 600 were expected \(1000 distinct - 400 known\)/)
    // the lock is free again
    const release = await Promise.race([acquireCommitLock(new AbortController().signal), sleep(100).then(() => null)])
    expect(release).not.toBeNull()
  })

  it('skips the check, with a warning, when the server sent no written-rows count', async () => {
    const db = makeDb({ stageRows: 100, distinct: [100], known: [0], written: () => null })
    const out = await commitStage(options(db, { parsedRows: 100 }))
    expect(out.inserted).toBe(100)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no written-rows count'))
  })

  it('refuses a known count larger than the slab itself', async () => {
    const db = makeDb({ stageRows: 100, distinct: [100], known: [101] })
    await expect(commitStage(options(db, { parsedRows: 100 }))).rejects.toThrow(NoveltyAccountingError)
  })

  it('kills the running statement and frees the lock when the import is aborted mid-insert', async () => {
    const ctrl = new AbortController()
    const db = makeDb({ stageRows: 100, distinct: [100], known: [0], hang: /^INSERT INTO ulp\.credentials/ })
    const run = commitStage(options(db, { parsedRows: 100, signal: ctrl.signal }))
    run.catch(() => {})
    await sleep(20)
    ctrl.abort(new Error('stalled'))
    await expect(run).rejects.toThrow('stalled')
    const killed = db.calls.find(c => c.kind === 'kill')!
    const commitInsert = db.calls.find(c => c.sql.startsWith('INSERT INTO ulp.credentials'))!
    expect(killed.queryId).toBe(commitInsert.queryId)
    const release = await Promise.race([acquireCommitLock(new AbortController().signal), sleep(100).then(() => null)])
    expect(release).not.toBeNull()
  })

  it('does not start a slab once the signal has aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort(new Error('already'))
    const db = makeDb({ stageRows: 100, distinct: [100], known: [0] })
    await expect(commitStage(options(db, { parsedRows: 100, signal: ctrl.signal }))).rejects.toThrow('already')
    expect(db.calls.some(c => c.sql.startsWith('TRUNCATE'))).toBe(false)
  })

  it('never lets two files commit a slab at the same time', async () => {
    let inSlab = 0
    let maxInSlab = 0
    const probe = {
      onSlabStart: () => { inSlab++; maxInSlab = Math.max(maxInSlab, inSlab) },
      onSlabEnd: () => { inSlab-- },
    }
    const a = makeDb({ stageRows: 2000, distinct: [1000, 1000], known: [0, 0], execDelayMs: 3, ...probe })
    const b = makeDb({ stageRows: 2000, distinct: [1000, 1000], known: [0, 0], execDelayMs: 3, ...probe })
    const [ra, rb] = await Promise.all([
      commitStage(options(a, { parsedRows: 2000, slabRows: 1000 })),
      commitStage(options(b, { parsedRows: 2000, slabRows: 1000 })),
    ])
    expect(ra.inserted).toBe(2000)
    expect(rb.inserted).toBe(2000)
    expect(maxInSlab).toBe(1)
  })

  describe('monitors', () => {
    const monitor = (id: number) => ({ id, domains: ['example.test'], match_mode: 'both' as const })
    const row = (n: number) => ({ url: `https://example.test/${n}`, email: `u${n}@example.test`, password: `pw${n}`, domain: 'example.test' })

    it('matches the new rows of each slab on the stage, tagged with the monitor, within the cap', async () => {
      const db = makeDb({ stageRows: 100, distinct: [100], known: [10], monitorRows: [row(1), row(2), row(3)] })
      const out = await commitStage(options(db, { parsedRows: 100, monitors: [monitor(7)], matchCap: 5 }))
      expect(out.matches).toEqual([
        { monitorId: 7, ...row(1) },
        { monitorId: 7, ...row(2) },
        { monitorId: 7, ...row(3) },
      ])
      const q = db.calls.find(c => c.sql.startsWith('SELECT url, email, password, domain FROM ('))!
      expect(q.sql).toContain('NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)')
      expect(q.sql).toMatch(/LIMIT 5$/)
    })

    it('asks the next monitor only for what is left of the cap, and stops at the cap', async () => {
      const db = makeDb({ stageRows: 100, distinct: [100], known: [0], monitorRows: [row(1), row(2), row(3)] })
      const out = await commitStage(options(db, { parsedRows: 100, monitors: [monitor(1), monitor(2), monitor(3)], matchCap: 4 }))
      const limits = db.calls.filter(c => c.sql.startsWith('SELECT url, email')).map(c => /LIMIT (\d+)$/.exec(c.sql)![1])
      expect(limits).toEqual(['4', '1'])
      expect(out.matches).toHaveLength(4)
    })

    it('makes no monitor query when nothing is new, when there is no cap, or when no monitor has a domain', async () => {
      const allKnown = makeDb({ stageRows: 100, distinct: [100], known: [100], monitorRows: [row(1)] })
      await commitStage(options(allKnown, { parsedRows: 100, monitors: [monitor(1)], matchCap: 5 }))
      const noCap = makeDb({ stageRows: 100, distinct: [100], known: [0], monitorRows: [row(1)] })
      await commitStage(options(noCap, { parsedRows: 100, monitors: [monitor(1)], matchCap: 0 }))
      const noDomains = makeDb({ stageRows: 100, distinct: [100], known: [0], monitorRows: [row(1)] })
      await commitStage(options(noDomains, { parsedRows: 100, monitors: [{ id: 1, domains: [' '], match_mode: 'url' }], matchCap: 5 }))
      for (const db of [allKnown, noCap, noDomains]) {
        expect(db.calls.some(c => c.sql.startsWith('SELECT url, email, password, domain FROM ('))).toBe(false)
      }
    })

    it('does not fail an import that already wrote its rows because a monitor query failed', async () => {
      const db = makeDb({ stageRows: 100, distinct: [100], known: [0], monitorError: new Error('Code: 241. memory limit') })
      const out = await commitStage(options(db, { parsedRows: 100, monitors: [monitor(1)], matchCap: 5 }))
      expect(out).toMatchObject({ inserted: 100, matches: [] })
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('monitor 1'))
      expect(db.calls.some(c => c.kind === 'kill')).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-novelty-commit.test.ts 2>&1 | tail -12`
Expected: FAIL, `commitStage` / `NoveltyAccountingError` are not exported.

- [ ] **Step 3: Append the implementation**

First replace the import block at the top of `/home/cole/ulp-suite/lib/ingest-novelty.ts` with:

```ts
import { randomUUID } from 'node:crypto'
import type { ClickHouseSettings } from '@clickhouse/client'
import { getClient } from '@/lib/clickhouse'
import { waitForHeadroom } from '@/lib/clickhouse-memory-guard'
import { buildNormalizedDomainSetMatch, type MatchedCredential, type MatchMode } from '@/lib/domain-match'
import { waitForDiskSpace } from '@/lib/ingest-disk-gate'
import { COMMIT_MAX_EXECUTION_S, slabCount } from '@/lib/ingest-novelty-config'
import type { StageTables } from '@/lib/ingest-stage'
```

Then append this to the end of the file (after `acquireCommitLock`):

```ts
// ── the commit ──────────────────────────────────────────────────────────────────────────────────────

export class NoveltyAccountingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoveltyAccountingError'
  }
}

export interface CommitMonitor {
  id: number
  domains: string[]
  match_mode: MatchMode
}

export interface CommitGates {
  disk(signal: AbortSignal, o: { onPoll?: () => void }): Promise<void>
  memory(signal: AbortSignal, o: { onPoll?: () => void }): Promise<void>
}

export interface CommitOptions {
  tables: StageTables
  /** Table the new rows are written to. */
  target: string
  /** Table probed for rows already held. The same table in production; a probe may read the live table and write a clone. */
  noveltyAgainst: string
  /** Rows the parser kept and sent to the stage: the file's importable lines. */
  parsedRows: number
  slabRows: number
  signal: AbortSignal
  /** Progress heartbeat for the stall watchdog (lib/import-runner.ts): after every statement and on every gate poll. */
  beat?: () => void
  onPhase?: (e: { phase: 'checking' | 'inserting'; slab: number; slabs: number }) => void
  onSlab?: (e: { slab: number; slabs: number; known: number; inserted: number }) => void
  monitors?: CommitMonitor[]
  /** Most monitor matches to collect in total; 0 or absent = none. */
  matchCap?: number
  /** Test seams. */
  db?: NoveltyDb
  gates?: CommitGates
  newQueryId?: () => string
}

export interface CommitResult {
  /** Rows the parser kept. */
  rows: number
  /** Distinct credentials among them. */
  distinct: number
  /** Distinct credentials that the table already held. */
  known: number
  /** New rows written. */
  inserted: number
  /** Rows that repeat an earlier row of the same file: rows - distinct. */
  inFileDuplicates: number
  slabs: number
  matches: MatchedCredential[]
}

interface MonitorRow {
  url: string
  email: string
  password: string
  domain: string
}

async function countRows(db: NoveltyDb, sql: string, o: { queryId: string; signal: AbortSignal }): Promise<number> {
  const rows = await db.select<{ c: string | number }>(sql, o)
  return Number(rows[0]?.c ?? 0)
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Moves the stage's rows into `target`, one slab at a time. See the module comment. On any failure or abort the statement that
 * was running is killed before the lock is released, so no statement of ours is still writing while another import computes its
 * `known`. Rows an interrupted attempt already wrote are not rolled back: a retry counts them as known.
 */
export async function commitStage(opts: CommitOptions): Promise<CommitResult> {
  const db = opts.db ?? clickhouseNoveltyDb()
  const gates: CommitGates = opts.gates ?? { disk: waitForDiskSpace, memory: waitForHeadroom }
  const queryId = opts.newQueryId ?? newQueryId
  const beat = opts.beat ?? (() => {})
  const { signal, tables: t } = opts
  const monitors = (opts.monitors ?? []).filter(m => m.domains.some(d => d.trim() !== ''))
  const matchCap = Math.max(0, Math.floor(opts.matchCap ?? 0))
  const matches: MatchedCredential[] = []

  const stageRows = await countRows(db, stageCountSql(t), { queryId: queryId(), signal })
  beat()
  const slabs = slabCount(stageRows, opts.slabRows)
  let distinct = 0
  let known = 0
  let inserted = 0

  for (let k = 0; stageRows > 0 && k < slabs; k++) {
    signal.throwIfAborted()
    // Room first, THEN the lock: an import that is paused for disk or memory must not hold up another file's commit.
    await gates.disk(signal, { onPoll: beat })
    await gates.memory(signal, { onPoll: beat })
    const release = await acquireCommitLock(signal)

    let running: string | null = null
    // `running` is cleared only on success, so the catch below still knows which statement to kill.
    const step = async <T>(fn: (id: string) => Promise<T>): Promise<T> => {
      const id = queryId()
      running = id
      const out = await fn(id)
      running = null
      beat()
      return out
    }

    try {
      signal.throwIfAborted()
      const slabDistinct = await step(id => countRows(db, slabDistinctSql(t, slabs, k), { queryId: id, signal }))
      if (slabDistinct > 0) {
        opts.onPhase?.({ phase: 'checking', slab: k + 1, slabs })
        await step(id => db.exec(knownResetSql(t), { queryId: id, signal }))
        await step(id => db.exec(knownFillSql(t, opts.noveltyAgainst, slabs, k), { queryId: id, signal }))
        const slabKnown = await step(id => countRows(db, knownCountSql(t), { queryId: id, signal }))
        if (slabKnown > slabDistinct) {
          throw new NoveltyAccountingError(
            `slab ${k + 1}/${slabs}: ${slabKnown} known hashes for ${slabDistinct} distinct ones; the stage and the table disagree`,
          )
        }
        const expected = slabDistinct - slabKnown

        if (expected > 0) {
          opts.onPhase?.({ phase: 'inserting', slab: k + 1, slabs })
          const { writtenRows } = await step(id => db.exec(commitInsertSql(t, opts.target, slabs, k), { queryId: id, signal }))
          if (writtenRows === null) {
            console.warn(`[ingest-novelty] slab ${k + 1}/${slabs}: the server sent no written-rows count; the accounting check was skipped`)
          } else if (writtenRows !== expected) {
            throw new NoveltyAccountingError(
              `slab ${k + 1}/${slabs}: ClickHouse reported ${writtenRows} rows written but ${expected} were expected ` +
              `(${slabDistinct} distinct - ${slabKnown} known). Rows already written are kept; Retry is safe, they will count as already known.`,
            )
          }

          // Monitors see only rows that are new. A failed match query must not fail an import whose rows are already written
          // (a retry would count them as known, so their alerts could never fire): skip that monitor for this slab instead.
          for (const monitor of monitors) {
            const room = matchCap - matches.length
            if (room <= 0) break
            const q = monitorStageSql(t, slabs, k, monitor, room)
            if (!q) continue
            try {
              const rows = await step(id => db.select<MonitorRow>(q.sql, { queryId: id, signal, params: q.params }))
              for (const r of rows.slice(0, room)) matches.push({ monitorId: monitor.id, url: r.url, email: r.email, password: r.password, domain: r.domain })
            } catch (err) {
              if (signal.aborted) throw err
              running = null
              console.warn(`[ingest-novelty] monitor ${monitor.id}: its match query failed, so its alerts for slab ${k + 1}/${slabs} are skipped (${errorText(err)})`)
            }
          }
        }

        distinct += slabDistinct
        known += slabKnown
        inserted += expected
      }
      opts.onSlab?.({ slab: k + 1, slabs, known, inserted })
    } catch (err) {
      if (running !== null) await db.kill(running).catch(() => {})
      throw err
    } finally {
      release()
    }
  }

  return {
    rows: opts.parsedRows,
    distinct,
    known,
    inserted,
    inFileDuplicates: Math.max(0, opts.parsedRows - distinct),
    slabs,
    matches,
  }
}
```

- [ ] **Step 4: Run both commit suites**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-novelty-commit.test.ts __tests__/ingest-novelty-sql.test.ts 2>&1 | tail -16`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/ingest-novelty.ts __tests__/ingest-novelty-commit.test.ts && git commit -m "feat(ingest): commitStage, the slab-by-slab commit with the written-rows check, the gates and the kill on failure" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 7: The job model: phases, known counts, the SQLite column

**Files:**
- Modify: `/home/cole/ulp-suite/lib/import-runner.ts` (types only)
- Modify: `/home/cole/ulp-suite/lib/upload-jobs.ts` (replace the file)
- Modify: `/home/cole/ulp-suite/lib/sqlite.ts` (one additive column)
- Modify: `/home/cole/ulp-suite/lib/processing-log.ts` (replace the file)
- Test: `/home/cole/ulp-suite/__tests__/upload-jobs-novelty.test.ts`
- Test: `/home/cole/ulp-suite/__tests__/processing-log-known.test.ts`

**Interfaces:**
- Produces (Tasks 8-12 rely on these exact names):
  - `type ImportPhase = 'parsing' | 'checking' | 'inserting'`
  - `interface ImportProgressEvent { phase: ImportPhase; staged: number; skipped: number; known: number; inserted: number; slab?: number; slabs?: number }`
  - `type ImportHooks = Partial<ImportContext> & { onImportProgress?: (event: ImportProgressEvent) => void }`
  - `UploadJob` gains `known: number`, `inFileDuplicates: number`, `staged: number`, `phase?: ImportPhase`, `slab?: number`, `slabs?: number`; `pushEvent` sends all of them
  - `JobLogEntry` gains `known?: number`; `processing_jobs.known INTEGER NOT NULL DEFAULT 0`

- [ ] **Step 1: Write the failing tests**

Create `/home/cole/ulp-suite/__tests__/upload-jobs-novelty.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createJob, getJob, pushEvent, updateJob } from '@/lib/upload-jobs'

function fakeWriter() {
  const sent: string[] = []
  const decoder = new TextDecoder()
  let closed = false
  const writer = {
    write: async (chunk: Uint8Array) => { sent.push(decoder.decode(chunk)) },
    close: async () => { closed = true },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>
  const events = () => sent.map(s => JSON.parse(s.replace(/^data: /, '').trim()))
  return { writer, events, isClosed: () => closed }
}

describe('upload job: novelty-aware ingest fields', () => {
  it('starts with nothing known, staged or repeated and no phase', () => {
    const job = createJob('job-a', 1000, 'Breach')
    expect(job).toMatchObject({ known: 0, inFileDuplicates: 0, staged: 0, imported: 0 })
    expect(job.phase).toBeUndefined()
  })

  it('reports the phase and the staged rows while parsing, and takes the percentage from the staged rows', async () => {
    const job = createJob('job-b', 1000, 'Breach')
    const out = fakeWriter()
    job.writer = out.writer
    updateJob('job-b', { phase: 'parsing', staged: 250, skipped: 3 })
    await pushEvent(getJob('job-b')!)
    expect(out.events()[0]).toMatchObject({ phase: 'parsing', staged: 250, skipped: 3, imported: 0, known: 0, pct: 25, status: 'running' })
  })

  it('reports the slab, the new rows and the known rows while committing', async () => {
    const job = createJob('job-c', 1000, 'Breach')
    const out = fakeWriter()
    job.writer = out.writer
    updateJob('job-c', { phase: 'inserting', staged: 1000, imported: 300, known: 200, slab: 2, slabs: 5 })
    await pushEvent(getJob('job-c')!)
    expect(out.events()[0]).toMatchObject({ phase: 'inserting', imported: 300, known: 200, slab: 2, slabs: 5, pct: 100 })
  })

  it('without a phase (the direct path) the percentage still comes from imported', async () => {
    const job = createJob('job-d', 1000, 'Breach')
    const out = fakeWriter()
    job.writer = out.writer
    updateJob('job-d', { imported: 500 })
    await pushEvent(getJob('job-d')!)
    expect(out.events()[0]).toMatchObject({ pct: 50, known: 0, inFileDuplicates: 0 })
    expect(out.events()[0].phase).toBeUndefined()
  })

  it('the final event carries the totals and closes the stream', async () => {
    const job = createJob('job-e', 1000, 'Breach')
    const out = fakeWriter()
    job.writer = out.writer
    updateJob('job-e', { status: 'done', phase: undefined, imported: 600, known: 300, inFileDuplicates: 100, skipped: 7 })
    await pushEvent(getJob('job-e')!)
    expect(out.events()[0]).toMatchObject({ status: 'done', imported: 600, known: 300, inFileDuplicates: 100, skipped: 7 })
    expect(out.isClosed()).toBe(true)
  })
})
```

Create `/home/cole/ulp-suite/__tests__/processing-log-known.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { dbGet, dbQuery } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

describe('processing_jobs.known', () => {
  it('exists in the application database, as an integer that defaults to 0', () => {
    const cols = dbQuery('PRAGMA table_info(processing_jobs)') as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    expect(cols.find(c => c.name === 'known')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })
  })

  it('logJob stores the known count, and 0 when the caller has none', () => {
    logJob({ source: 'http', filename: 'known-roundtrip-a.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10, known: 42 })
    logJob({ source: 'http', filename: 'known-roundtrip-b.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10 })
    expect(dbGet('SELECT known, imported FROM processing_jobs WHERE filename = ?', ['known-roundtrip-a.txt'])).toEqual({ known: 42, imported: 5 })
    expect(dbGet('SELECT known FROM processing_jobs WHERE filename = ?', ['known-roundtrip-b.txt'])).toEqual({ known: 0 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/upload-jobs-novelty.test.ts __tests__/processing-log-known.test.ts 2>&1 | tail -20`
Expected: FAIL (`known` is not on the job; `processing_jobs` has no `known` column).

- [ ] **Step 3: The hook types**

In `/home/cole/ulp-suite/lib/import-runner.ts` replace

```ts
/** What the pipeline functions accept: both parts optional, so existing callers and tests need no change. */
export type ImportHooks = Partial<ImportContext>
```

with

```ts
/** Where an import is, for the progress lines of the Upload page and the Inbox (novelty-aware ingest). */
export type ImportPhase = 'parsing' | 'checking' | 'inserting'

export interface ImportProgressEvent {
  phase: ImportPhase
  /** Rows the parser has kept and put on the stage so far. */
  staged: number
  /** Lines the parser has rejected so far. */
  skipped: number
  /** Distinct credentials found already in the table, over the slabs finished so far. */
  known: number
  /** New rows written, over the slabs finished so far. */
  inserted: number
  slab?: number
  slabs?: number
}

/** What the pipeline functions accept: every part optional, so existing callers and tests need no change. */
export type ImportHooks = Partial<ImportContext> & {
  /** Novelty-aware ingest reports where it is: parsing, checking against the table, inserting. */
  onImportProgress?: (event: ImportProgressEvent) => void
}
```

- [ ] **Step 4: The job store**

Replace `/home/cole/ulp-suite/lib/upload-jobs.ts` with:

```ts
/**
 * In-process upload job store.
 *
 * Stores running/completed upload jobs so the SSE endpoint can push
 * progress events to the browser. Jobs expire after 10 minutes.
 *
 * Note: single-process only. Works for self-hosted Next.js.
 */

import { makeRejectionMap } from '@/lib/ulp-parser'
import type { ImportPhase } from '@/lib/import-runner'

export type JobStatus = 'running' | 'done' | 'error'

export interface UploadJob {
  id:          string
  status:      JobStatus
  /** Rows written. With novelty-aware ingest (lib/ingest-novelty.ts) this is NEW rows only, and stays 0 until a slab is committed. */
  imported:    number
  skipped:     number
  tierDropped: number      // rows dropped pre-insert by the ingest tier filter
  /** Distinct credentials of the file that the table already held (novelty-aware ingest; 0 on the direct path). */
  known:            number
  /** Rows that repeat an earlier row of the same file (novelty-aware ingest; the direct path counts them in `skipped`). */
  inFileDuplicates: number
  /** Rows parsed and staged so far (novelty-aware ingest). */
  staged:      number
  /** Set while novelty-aware ingest is working; cleared when the job ends. Absent on the direct path. */
  phase?:      ImportPhase
  slab?:       number
  slabs?:      number
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
    tierDropped: 0,
    known:            0,
    inFileDuplicates: 0,
    staged:      0,
    total_lines: totalLines,
    breach_name: breachName,
    started_at:  Date.now(),
    rejection_breakdown: makeRejectionMap(),
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
  // While novelty-aware ingest is working, progress is the rows read and staged; on the direct path it is the rows inserted.
  const rowsDone = job.phase ? job.staged : job.imported
  const pct     = job.total_lines > 0
    ? Math.min(100, Math.round((rowsDone / job.total_lines) * 100))
    : 0
  const elapsed = Date.now() - job.started_at
  const payload = JSON.stringify({
    imported:            job.imported,
    skipped:             job.skipped,
    tierDropped:         job.tierDropped,
    known:               job.known,
    inFileDuplicates:    job.inFileDuplicates,
    staged:              job.staged,
    phase:               job.phase,
    slab:                job.slab,
    slabs:               job.slabs,
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

- [ ] **Step 5: The SQLite column and the job log**

In `/home/cole/ulp-suite/lib/sqlite.ts`, immediately after

```ts
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_created
      ON processing_jobs (id DESC)
  `)
```

insert:

```ts

  // Novelty-aware ingest: distinct credentials of a file that the table already held. Additive, so older rows read 0
  // (idempotent -- the catch swallows "duplicate column", like the ALTERs below).
  try { db.exec(`ALTER TABLE processing_jobs ADD COLUMN known INTEGER NOT NULL DEFAULT 0`) } catch {}
```

Replace `/home/cole/ulp-suite/lib/processing-log.ts` with:

```ts
/**
 * Persistent audit log for upload pipeline jobs.
 *
 * One row per completed file — written by the HTTP upload route and the
 * inbox watcher.  Silent on error so logging never crashes a pipeline.
 */

import { dbRun } from '@/lib/sqlite'

export interface JobLogEntry {
  source:         'http' | 'inbox'
  filename:       string
  status:         'done' | 'failed'
  /** Rows written. With novelty-aware ingest, NEW rows only. */
  imported:       number
  skipped:        number
  duration_ms:    number
  error_message?: string
  breach_name?:   string
  /** Distinct credentials of the file that the table already held (novelty-aware ingest). */
  known?:         number
}

export function logJob(entry: JobLogEntry): void {
  try {
    dbRun(
      `INSERT INTO processing_jobs
         (source, filename, status, imported, skipped, duration_ms, error_message, breach_name, known)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.source,
        entry.filename,
        entry.status,
        entry.imported,
        entry.skipped,
        entry.duration_ms,
        entry.error_message ?? null,
        entry.breach_name   ?? null,
        entry.known         ?? 0,
      ],
    )
  } catch {
    // Logging must never crash the upload pipeline
  }
}
```

- [ ] **Step 6: Run the tests, the typecheck and the neighbouring suites**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/upload-jobs-novelty.test.ts __tests__/processing-log-known.test.ts __tests__/processing-log.test.ts 2>&1 | tail -12 && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/import-runner.ts lib/upload-jobs.ts lib/sqlite.ts lib/processing-log.ts __tests__/upload-jobs-novelty.test.ts __tests__/processing-log-known.test.ts && git commit -m "feat(ingest): phases and known counts in the import hooks, the job store, the SSE event and processing_jobs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `processTextStream` stages, commits and counts

**Files:**
- Modify: `/home/cole/ulp-suite/lib/upload-processor.ts`
- Modify: `/home/cole/ulp-suite/__tests__/upload-route-spool.test.ts` and `/home/cole/ulp-suite/__tests__/upload-v1-route-spool.test.ts` (the `ProcessResult` literals gain two fields)
- Test: `/home/cole/ulp-suite/__tests__/upload-processor-novelty.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 6, 7 (`noveltyConfig`, `stageTables`/`newStageId`/`createStage`/`dropStage`/`registerStage`/`unregisterStage`, `commitStage`, `ImportProgressEvent`, `UploadJob` fields).
- Produces: `ProcessResult` gains `known: number` and `inFileDuplicates: number` (both always present; 0 on the direct path); `StreamToTableOptions` gains `dedupInFile?: boolean`; `processTextStream` takes the staged path unless `INGEST_NOVELTY_CHECK` is `off|0|false`.

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/upload-processor-novelty.test.ts`:

```ts
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  query: vi.fn(),
  createStage: vi.fn(),
  dropStage: vi.fn(),
  registerStage: vi.fn(),
  unregisterStage: vi.fn(),
  commitStage: vi.fn(),
  updateJob: vi.fn(),
}))
const dm = vi.hoisted(() => ({
  getActiveMonitors: vi.fn(),
  fireMonitorAlertsFromMatches: vi.fn(),
}))

vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))
vi.mock('@/lib/domain-monitor', () => dm)
vi.mock('@/lib/upload-jobs', () => ({ updateJob: h.updateJob }))
vi.mock('@/lib/ingest-novelty', () => ({ commitStage: h.commitStage }))
vi.mock('@/lib/ingest-stage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ingest-stage')>('@/lib/ingest-stage')
  return {
    ...actual,
    createStage: h.createStage,
    dropStage: h.dropStage,
    registerStage: h.registerStage,
    unregisterStage: h.unregisterStage,
  }
})

import { MAX_INPROCESS_MATCHES, processTextStream } from '@/lib/upload-processor'

const LINES =
  'https://shop.example.com:alice@example.com:pw-one\n' +
  'https://shop.example.com:bob@example.com:pw-two\n' +
  'https://shop.example.org:carol@example.org:pw-three\n'
const stream = (text = LINES) => Readable.toWeb(Readable.from([Buffer.from(text)])) as ReadableStream<Uint8Array>

const commitResult = (extra: Record<string, unknown> = {}) => ({
  rows: 3, distinct: 3, known: 1, inserted: 2, inFileDuplicates: 0, slabs: 1, matches: [], ...extra,
})
const insertedTables = () => h.insert.mock.calls.map(c => c[0].table as string)
const sourceRows = () => h.insert.mock.calls.filter(c => c[0].table === 'ulp.sources').map(c => c[0].values)

beforeEach(() => {
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  for (const fn of Object.values(h)) fn.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
  h.createStage.mockResolvedValue(undefined)
  h.dropStage.mockResolvedValue(undefined)
  h.commitStage.mockResolvedValue(commitResult())
  dm.getActiveMonitors.mockReset()
  dm.getActiveMonitors.mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset()
  dm.fireMonitorAlertsFromMatches.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('processTextStream with novelty-aware ingest', () => {
  it('stages the file, commits it, and returns the new / known / repeated counts', async () => {
    h.commitStage.mockResolvedValue(commitResult({ rows: 3, distinct: 3, known: 1, inserted: 2, inFileDuplicates: 0 }))
    const out = await processTextStream(stream(), 'novelty-a.txt')
    expect(out).toMatchObject({ imported: 2, known: 1, inFileDuplicates: 0, skipped: 0, errors: 0, alreadyImported: false, filename: 'novelty-a.txt' })

    // The rows went to the stage, never straight into the real table.
    const stageTable = insertedTables().find(t => /^ulp\.zz_import_stage_[0-9a-f]{12}$/.test(t))
    expect(stageTable).toBeDefined()
    expect(insertedTables()).not.toContain('ulp.credentials')

    const commit = h.commitStage.mock.calls[0][0]
    expect(commit).toMatchObject({ target: 'ulp.credentials', noveltyAgainst: 'ulp.credentials', parsedRows: 3, slabRows: 20_000_000, matchCap: MAX_INPROCESS_MATCHES })
    expect(commit.tables.stage).toBe(stageTable)
  })

  it('leaves in-file dedup to the stage: a repeated line is staged, then counted, not skipped', async () => {
    const line = 'https://shop.example.com:alice@example.com:pw-one\n'
    h.commitStage.mockResolvedValue(commitResult({ rows: 3, distinct: 1, known: 0, inserted: 1, inFileDuplicates: 2 }))
    const out = await processTextStream(stream(line + line + line), 'novelty-repeat.txt')
    expect(h.commitStage.mock.calls[0][0].parsedRows).toBe(3)
    expect(out).toMatchObject({ imported: 1, inFileDuplicates: 2, skipped: 0 })
  })

  it('registers the stage before creating it, and drops and unregisters it after the commit', async () => {
    await processTextStream(stream(), 'novelty-order.txt')
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]
    expect(order(h.registerStage)).toBeLessThan(order(h.createStage))
    expect(order(h.createStage)).toBeLessThan(order(h.insert))
    expect(order(h.commitStage)).toBeLessThan(order(h.dropStage))
    expect(order(h.dropStage)).toBeLessThan(order(h.unregisterStage))
    expect(h.registerStage.mock.calls[0][0]).toBe(h.unregisterStage.mock.calls[0][0])
  })

  it('remembers the file in ulp.sources with the rows it added, even when it added none', async () => {
    h.commitStage.mockResolvedValue(commitResult({ known: 3, inserted: 0 }))
    await processTextStream(stream(), 'novelty-known.txt')
    expect(sourceRows()).toEqual([[{ filename: 'novelty-known.txt', line_count: 0 }]])
  })

  it('records the rows added when there are some', async () => {
    await processTextStream(stream(), 'novelty-added.txt')
    expect(sourceRows()).toEqual([[{ filename: 'novelty-added.txt', line_count: 2 }]])
  })

  it('does not remember a file that had no importable line', async () => {
    h.commitStage.mockResolvedValue(commitResult({ rows: 0, distinct: 0, known: 0, inserted: 0 }))
    const out = await processTextStream(stream('this is not a credential\n'), 'novelty-garbage.txt')
    expect(sourceRows()).toEqual([])
    expect(out).toMatchObject({ imported: 0, known: 0, skipped: 1 })
  })

  it('passes the active monitors to the commit and alerts only for the matches it returns', async () => {
    const monitor = { id: 7, name: 'm', domains: ['example.com'], match_mode: 'both' }
    dm.getActiveMonitors.mockResolvedValue([monitor])
    const matches = [{ monitorId: 7, url: 'https://shop.example.com', email: 'alice@example.com', password: 'pw-one', domain: 'shop.example.com' }]
    h.commitStage.mockResolvedValue(commitResult({ matches }))
    await processTextStream(stream(), 'novelty-monitor.txt')
    expect(h.commitStage.mock.calls[0][0].monitors).toEqual([{ id: 7, domains: ['example.com'], match_mode: 'both' }])
    expect(dm.fireMonitorAlertsFromMatches).toHaveBeenCalledWith('novelty-monitor.txt', matches, expect.any(Map))

    dm.fireMonitorAlertsFromMatches.mockClear()
    h.commitStage.mockResolvedValue(commitResult({ matches: [] }))
    await processTextStream(stream(), 'novelty-monitor-none.txt')
    expect(dm.fireMonitorAlertsFromMatches).not.toHaveBeenCalled()
  })

  it('drops and unregisters the stage, and rethrows, when the commit fails', async () => {
    h.commitStage.mockRejectedValue(new Error('commit failed'))
    await expect(processTextStream(stream(), 'novelty-fail-commit.txt')).rejects.toThrow('commit failed')
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    expect(h.unregisterStage).toHaveBeenCalledTimes(1)
    expect(sourceRows()).toEqual([])
  })

  it('drops and unregisters the stage, and rethrows, when staging fails', async () => {
    h.insert.mockRejectedValue(new Error('Syntax error: bad query'))
    await expect(processTextStream(stream(), 'novelty-fail-stage.txt')).rejects.toThrow(/Syntax error/)
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    expect(h.unregisterStage).toHaveBeenCalledTimes(1)
  })

  it('a stage that cannot be dropped does not mask the result of the import', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.dropStage.mockRejectedValue(new Error('drop failed'))
    const out = await processTextStream(stream(), 'novelty-drop-fails.txt')
    expect(out.imported).toBe(2)
    expect(h.unregisterStage).toHaveBeenCalledTimes(1)
  })

  it('reports parsing, checking and inserting to the job and to the progress hook', async () => {
    h.commitStage.mockImplementation(async (o: any) => {
      o.onPhase({ phase: 'checking', slab: 1, slabs: 2 })
      o.onSlab({ slab: 1, slabs: 2, known: 1, inserted: 1 })
      o.onPhase({ phase: 'checking', slab: 2, slabs: 2 })
      o.onSlab({ slab: 2, slabs: 2, known: 1, inserted: 2 })
      return commitResult()
    })
    const events: Array<{ phase: string }> = []
    const batches: number[] = []
    await processTextStream(stream(), 'novelty-progress.txt', 'job-1', n => batches.push(n), { onImportProgress: e => events.push(e) })

    expect(events.map(e => e.phase)).toEqual(['parsing', 'parsing', 'checking', 'inserting', 'checking', 'inserting'])
    expect(batches).toEqual([1, 2]) // onBatch carries the running count of NEW rows, after each slab
    const patches = h.updateJob.mock.calls.map(c => c[1])
    expect(patches[0]).toMatchObject({ phase: 'parsing', staged: 0, imported: 0 })
    expect(patches.at(-1)).toMatchObject({ phase: 'inserting', staged: 3, imported: 2, known: 1, slab: 2, slabs: 2 })
    expect(h.updateJob.mock.calls.every(c => c[0] === 'job-1')).toBe(true)
  })

  it('INGEST_NOVELTY_SLAB_ROWS reaches the commit', async () => {
    vi.stubEnv('INGEST_NOVELTY_SLAB_ROWS', '5000')
    await processTextStream(stream(), 'novelty-slab.txt')
    expect(h.commitStage.mock.calls[0][0].slabRows).toBe(5000)
  })

  it('INGEST_NOVELTY_CHECK=off keeps the direct path: no stage, rows straight into ulp.credentials', async () => {
    vi.stubEnv('INGEST_NOVELTY_CHECK', 'off')
    const out = await processTextStream(stream(), 'direct.txt')
    expect(h.registerStage).not.toHaveBeenCalled()
    expect(h.createStage).not.toHaveBeenCalled()
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(insertedTables()).toContain('ulp.credentials')
    expect(out).toMatchObject({ imported: 3, known: 0, inFileDuplicates: 0 })
  })

  it('a file already in ulp.sources is skipped before any stage exists, with zero known / repeated', async () => {
    h.query.mockResolvedValue({ json: async () => [{ c: 1 }] })
    const out = await processTextStream(stream(), 'again.txt')
    expect(out).toMatchObject({ alreadyImported: true, imported: 0, known: 0, inFileDuplicates: 0 })
    expect(h.registerStage).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/upload-processor-novelty.test.ts 2>&1 | tail -20`
Expected: FAIL (the staged path does not exist; `known` is undefined).

- [ ] **Step 3: The imports, `ProcessResult`, and the parser option**

In `/home/cole/ulp-suite/lib/upload-processor.ts` replace

```ts
import type { ImportHooks } from '@/lib/import-runner'
```

with

```ts
import type { ImportHooks, ImportProgressEvent } from '@/lib/import-runner'
import { noveltyConfig } from '@/lib/ingest-novelty-config'
import { commitStage } from '@/lib/ingest-novelty'
import { createStage, dropStage, newStageId, registerStage, stageTables, unregisterStage } from '@/lib/ingest-stage'
```

Replace

```ts
export interface ProcessResult {
  imported:            number
  skipped:             number
```

with

```ts
export interface ProcessResult {
  /** Rows written. With novelty-aware ingest (lib/ingest-novelty.ts) this is NEW rows only. */
  imported:            number
  /** Distinct credentials of the file that the table already held (0 on the direct path). */
  known:               number
  /** Rows that repeat an earlier row of the same file (0 on the direct path, which counts them in `skipped`). */
  inFileDuplicates:    number
  skipped:             number
```

In `StreamToTableOptions`, after the `shouldHardDrop?: (email: string, url: string) => boolean` line, add:

```ts
  /** Drop a line that repeats an earlier line of the file inside the parser (default true). The staged path turns it off: the stage does it exactly. */
  dedupInFile?: boolean
```

Replace

```ts
  const gen = parseULPStream(stream, filename, batchSize, options.shouldHardDrop)
```

with

```ts
  const gen = parseULPStream(stream, filename, batchSize, options.shouldHardDrop, { dedupInFile: options.dedupInFile })
```

- [ ] **Step 4: The other `ProcessResult` constructors**

In `processTextStream`, replace

```ts
    return {
      imported: 0, skipped: 0, errors: 0, filename, breach_name,
      rejection_breakdown: makeRejectionMap(), alreadyImported: true, tierDropped: 0,
    }
```

with

```ts
    return {
      imported: 0, known: 0, inFileDuplicates: 0, skipped: 0, errors: 0, filename, breach_name,
      rejection_breakdown: makeRejectionMap(), alreadyImported: true, tierDropped: 0,
    }
```

Replace

```ts
  return { imported, skipped, errors: 0, filename, breach_name, rejection_breakdown, alreadyImported: false, tierDropped }
```

with

```ts
  return { imported, known: 0, inFileDuplicates: 0, skipped, errors: 0, filename, breach_name, rejection_breakdown, alreadyImported: false, tierDropped }
```

In `processZipEntries`' `skipEntry`, replace

```ts
        onEntry({
          imported:            0,
          skipped:             0,
```

with

```ts
        onEntry({
          imported:            0,
          known:               0,
          inFileDuplicates:    0,
          skipped:             0,
```

- [ ] **Step 5: The staged path**

Insert this block immediately before the line `// ─── Text stream processor ───` (the whole line starts with those characters):

```ts
// ─── Novelty-aware path ───────────────────────────────────────────────────────

interface StagedImport {
  stream:         ReadableStream<Uint8Array>
  filename:       string
  jobId?:         string
  onBatch?:       (imported: number) => void
  hooks:          ImportHooks
  breach_name:    string
  filterOn:       boolean
  softPolicy:     ReturnType<typeof parseIngestPolicy>
  shouldHardDrop: ReturnType<typeof makeHardDropPredicate>
  monitors:       DomainMonitor[]
  monitorsById:   Map<number, DomainMonitor>
  slabRows:       number
}

/**
 * Parse the file into its own stage table, then write only the credentials the table does not hold yet
 * (docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md). Nothing reaches ulp.credentials until the commit, so a file
 * that fails while staging leaves no trace in it, and a retry after a failed commit counts what was already written as known.
 */
async function importThroughStage(a: StagedImport): Promise<ProcessResult> {
  const { filename, jobId, hooks } = a
  const tables = stageTables(newStageId())

  let known = 0
  let inserted = 0
  let staged = 0
  let skipped = 0
  const report = (event: ImportProgressEvent) => {
    if (jobId) {
      updateJob(jobId, {
        phase:    event.phase,
        staged:   event.staged,
        skipped:  event.skipped,
        imported: event.inserted,
        known:    event.known,
        slab:     event.slab,
        slabs:    event.slabs,
      })
    }
    hooks.onImportProgress?.(event)
  }

  // Register BEFORE creating: the orphan sweeper (lib/ingest-stage.ts) must never see a table of ours that is not registered.
  registerStage(tables.id)
  try {
    await createStage(tables, { signal: hooks.signal, onRetry: () => hooks.beat?.() })
    hooks.beat?.()

    report({ phase: 'parsing', staged: 0, skipped: 0, known: 0, inserted: 0 })
    startIngest(filename)
    let streamed: StreamToTableResult
    try {
      streamed = await streamCredentialsToTable(a.stream, filename, {
        table:          tables.stage,
        batchSize:      UPLOAD_BATCH_SIZE,
        pipeline:       importPipelineEnabled(),
        filterOn:       a.filterOn,
        dropPolicy:     a.softPolicy,
        breachName:     a.breach_name,
        shouldHardDrop: a.shouldHardDrop,
        dedupInFile:    false,
        signal:         hooks.signal,
        onBeat:         hooks.beat,
        onProgress: (n, skp) => {
          staged = n
          skipped = skp
          report({ phase: 'parsing', staged, skipped, known: 0, inserted: 0 })
        },
        onBatchMetrics: recordBatch,
      })
    } finally {
      finishIngest()
    }
    staged = streamed.imported
    skipped = streamed.skipped
    if (a.filterOn && streamed.tierDropped > 0) {
      console.log(`[ingest-filter] ${filename}: dropped ${streamed.tierDropped} low-tier rows pre-insert`)
    }

    const commit = await commitStage({
      tables,
      target:         'ulp.credentials',
      noveltyAgainst: 'ulp.credentials',
      parsedRows:     streamed.imported,
      slabRows:       a.slabRows,
      signal:         hooks.signal ?? new AbortController().signal,
      beat:           hooks.beat,
      monitors:       a.monitors.map(m => ({ id: m.id, domains: m.domains, match_mode: m.match_mode })),
      matchCap:       MAX_INPROCESS_MATCHES,
      onPhase: e => report({ phase: e.phase, staged, skipped, known, inserted, slab: e.slab, slabs: e.slabs }),
      onSlab: e => {
        known = e.known
        inserted = e.inserted
        a.onBatch?.(e.inserted)
        report({ phase: 'inserting', staged, skipped, known, inserted, slab: e.slab, slabs: e.slabs })
      },
    })

    // A file that had importable lines is remembered even when it added nothing, so the same-name guard stops its re-upload.
    if (streamed.imported > 0) await recordSource(filename, commit.inserted, hooks)
    if (commit.matches.length > 0) {
      fireMonitorAlertsFromMatches(filename, commit.matches, a.monitorsById).catch(err =>
        console.error('Domain monitor alert error:', err)
      )
    }

    return {
      imported:            commit.inserted,
      known:               commit.known,
      inFileDuplicates:    commit.inFileDuplicates,
      skipped,
      errors:              0,
      filename,
      breach_name:         a.breach_name,
      rejection_breakdown: streamed.rejection_breakdown,
      alreadyImported:     false,
      tierDropped:         streamed.tierDropped,
    }
  } finally {
    try {
      await dropStage(tables)
    } catch (err) {
      console.warn(`[upload-processor] could not drop the stage tables of ${filename}; the sweeper will: ${err instanceof Error ? err.message : String(err)}`)
    }
    unregisterStage(tables.id)
  }
}

```

Then, in `processTextStream`, replace

```ts
  const monitorMatches: MatchedCredential[] = []
  let matchCapWarned = false

  startIngest(filename)
```

with

```ts
  const monitorMatches: MatchedCredential[] = []
  let matchCapWarned = false

  // Novelty-aware ingest: stage the file, then write only what the table does not hold yet (lib/ingest-novelty.ts). Monitors are
  // matched in ClickHouse on the stage in that path, so the in-process matcher above is not used by it.
  const novelty = noveltyConfig()
  if (novelty.enabled) {
    return importThroughStage({
      stream, filename, jobId, onBatch, hooks, breach_name, filterOn, softPolicy, shouldHardDrop,
      monitors, monitorsById, slabRows: novelty.slabRows,
    })
  }

  startIngest(filename)
```

- [ ] **Step 6: The two route tests that build `ProcessResult` literals**

In `/home/cole/ulp-suite/__tests__/upload-route-spool.test.ts` (two places, lines about 30 and 184) and `/home/cole/ulp-suite/__tests__/upload-v1-route-spool.test.ts` (two places, lines about 31 and 128), every literal ending `rejection_breakdown: {}, alreadyImported: false, tierDropped: 0` gains `known: 0, inFileDuplicates: 0,` before `rejection_breakdown`. Use:

```bash
cd /home/cole/ulp-suite && sed -i 's/rejection_breakdown: {}, alreadyImported: false, tierDropped: 0/known: 0, inFileDuplicates: 0, rejection_breakdown: {}, alreadyImported: false, tierDropped: 0/' __tests__/upload-route-spool.test.ts __tests__/upload-v1-route-spool.test.ts && grep -c "known: 0, inFileDuplicates: 0" __tests__/upload-route-spool.test.ts __tests__/upload-v1-route-spool.test.ts
```
Expected: `2` for each file.

- [ ] **Step 7: Run the processor suites, the typecheck, and everything that touches the importer**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/upload-processor-novelty.test.ts __tests__/upload-processor.test.ts __tests__/upload-processor-disk-gate.test.ts __tests__/upload-skip-imported.test.ts __tests__/zip-bomb-guard.test.ts __tests__/upload-route-spool.test.ts __tests__/upload-v1-route-spool.test.ts __tests__/insert-batch-dedup.test.ts 2>&1 | tail -14 && npx tsc --noEmit`
Expected: PASS, tsc exit 0. If `tsc` reports a `ProcessResult` literal elsewhere, add the two fields there too.

- [ ] **Step 8: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/upload-processor.ts __tests__/upload-processor-novelty.test.ts __tests__/upload-route-spool.test.ts __tests__/upload-v1-route-spool.test.ts && git commit -m "feat(ingest): import through a stage table and write only the credentials the table does not hold" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 9: The routes report new / known / repeated

**Files:**
- Modify: `/home/cole/ulp-suite/app/api/upload/route.ts`
- Modify: `/home/cole/ulp-suite/app/api/v1/upload/route.ts`
- Modify: `/home/cole/ulp-suite/app/api/upload/queue-status/route.ts`
- Modify: `/home/cole/ulp-suite/app/docs/page.tsx`
- Modify: `/home/cole/ulp-suite/__tests__/upload-route-spool.test.ts`, `/home/cole/ulp-suite/__tests__/upload-v1-route-spool.test.ts`
- Test: `/home/cole/ulp-suite/__tests__/queue-status-known.test.ts`

**Interfaces:**
- Consumes: `ProcessResult.known`, `ProcessResult.inFileDuplicates` (Task 8); `logJob({ known })`, `updateJob` fields (Task 7).
- Produces: the HTTP upload reply gains `known`, `inFileDuplicates` and `files[].known`; `import_pct` becomes kept / (kept + skipped) with kept = imported + known + inFileDuplicates (identical to before on the direct path); `/api/v1/upload` replies gain `known`, `inFileDuplicates` and `files[].known`; `/api/upload/queue-status` rows gain `known` and `totals.rows_known`. A ZIP entry that added nothing but had known rows is listed.

- [ ] **Step 1: Update and extend the route tests**

In `/home/cole/ulp-suite/__tests__/upload-route-spool.test.ts`:

1. Add to the imports (next to the existing `import { POST } from '@/app/api/upload/route'`): `import { getJob } from '@/lib/upload-jobs'`.
2. In the first zip test replace
   `expect(json.files).toEqual([{ filename: 'inner.txt', breach_name: 'test', imported: 2 }])`
   with
   `expect(json.files).toEqual([{ filename: 'inner.txt', breach_name: 'test', imported: 2, known: 0 }])`.
3. In the `describe('POST /api/upload: receive first, then reply'` block add this test after the one named `preserves the original filename casing ...`:

```ts
  it('carries the known and repeated counts into the job, the job log and the audit log', async () => {
    mockProcessTextFile.mockImplementationOnce(async (_path: string, filename: string) => ({
      imported: 3, known: 7, inFileDuplicates: 2, skipped: 1, errors: 0, filename, breach_name: 'test',
      rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
    }))

    const res = await post('known.txt', 'https://a.com:user@a.com:pass\n')
    const { jobId } = await res.json()

    await vi.waitFor(() => expect(getJob(jobId)?.status).toBe('done'))
    expect(getJob(jobId)).toMatchObject({ imported: 3, known: 7, inFileDuplicates: 2, skipped: 1 })
    expect(getJob(jobId)?.phase).toBeUndefined()
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ source: 'http', status: 'done', imported: 3, known: 7 }))
    await vi.waitFor(() => expect(mockAudit).toHaveBeenCalledWith(
      'upload.complete', admin, jobId, expect.objectContaining({ filename: 'known.txt', imported: 3, known: 7 }),
    ))
  })
```

4. In the `describe('POST /api/upload: zip archives'` block add:

```ts
  it('lists an entry that added nothing but had known rows, and counts it in the totals', async () => {
    mockProcessZipFile.mockImplementationOnce(async (_path: string, onEntry: (r: unknown) => void) => {
      onEntry(entry('fresh.txt', 2, { skipped: 3, known: 1 }))
      onEntry(entry('seen.txt', 0, { known: 5, inFileDuplicates: 1 }))
      onEntry(entry('empty.txt', 0))
    })

    const res = await post('archive.zip', 'pretend zip bytes')

    const json = await res.json()
    expect(json).toMatchObject({ imported: 2, known: 6, inFileDuplicates: 1, skipped: 3, errors: 0 })
    expect(json.files).toEqual([
      { filename: 'fresh.txt', breach_name: 'test', imported: 2, known: 1 },
      { filename: 'seen.txt', breach_name: 'test', imported: 0, known: 5 },
    ])
    expect(json.import_pct).toBe(75) // kept 9 of 12 lines: 2 + 6 + 1 kept, 3 skipped
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ source: 'http', status: 'done', imported: 2, known: 6 }))
  })
```

In the same file, the helper `entry` (inside the zip `describe`) already spreads `...extra`, so `known` and `inFileDuplicates` in `extra` override the zeros that Task 8 added.

In `/home/cole/ulp-suite/__tests__/upload-v1-route-spool.test.ts`:

1. Replace `expect(await res.json()).toEqual({ success: true, imported: 1, skipped: 0, errors: 0, filename: 'dump.txt' })` with
   `expect(await res.json()).toEqual({ success: true, imported: 1, known: 0, inFileDuplicates: 0, skipped: 0, errors: 0, filename: 'dump.txt' })`.
2. Replace the zip expectation
```ts
    expect(await res.json()).toEqual({
      success: true, imported: 2, skipped: 0, errors: 0,
      files: [{ filename: 'inner.txt', imported: 2 }], filename: 'archive.zip',
    })
```
   with
```ts
    expect(await res.json()).toEqual({
      success: true, imported: 2, known: 0, inFileDuplicates: 0, skipped: 0, errors: 0,
      files: [{ filename: 'inner.txt', imported: 2, known: 0 }], filename: 'archive.zip',
    })
```
3. Add this test after `imports a zip from the spool file and lists its entries`:

```ts
  it('reports known and repeated rows, for a text upload and for a zip entry that added nothing', async () => {
    mockProcessTextFile.mockImplementationOnce(async (_path: string, filename: string) => ({
      imported: 3, known: 7, inFileDuplicates: 2, skipped: 1, errors: 0, filename, breach_name: 'test',
      rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
    }))
    const text = await post('known.txt', 'https://a.com:user@a.com:pass\n')
    expect(await text.json()).toEqual({ success: true, imported: 3, known: 7, inFileDuplicates: 2, skipped: 1, errors: 0, filename: 'known.txt' })
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ imported: 3, known: 7 }))

    mockProcessZipFile.mockImplementationOnce(async (_path: string, onEntry: (r: unknown) => void) => {
      onEntry({
        imported: 0, known: 4, inFileDuplicates: 0, skipped: 0, errors: 0, filename: 'seen.txt', breach_name: 'test',
        rejection_breakdown: {}, alreadyImported: false, tierDropped: 0,
      })
    })
    const zip = await post('archive.zip', 'pretend zip bytes')
    expect(await zip.json()).toMatchObject({ imported: 0, known: 4, files: [{ filename: 'seen.txt', imported: 0, known: 4 }] })
  })
```

Create `/home/cole/ulp-suite/__tests__/queue-status-known.test.ts`:

```ts
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ dbQuery: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/sqlite', () => ({ dbQuery: h.dbQuery }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: { activeCount: 0, pendingCount: 0 }, getCurrentJob: () => null }))

import { GET } from '@/app/api/upload/queue-status/route'

beforeEach(() => h.dbQuery.mockReset())

describe('GET /api/upload/queue-status: known rows', () => {
  it('selects the known column and totals it', async () => {
    h.dbQuery
      .mockReturnValueOnce([{ id: 1, source: 'http', filename: 'a.txt', status: 'done', imported: 5, known: 9, skipped: 0, duration_ms: 1, error_message: null, breach_name: null, created_at: 'x' }])
      .mockReturnValueOnce([{ status: 'done', file_count: 1, total_imported: 5, total_known: 9, total_skipped: 0 }])

    const res = await GET(new NextRequest('http://localhost/api/upload/queue-status'))
    const json = await res.json()

    expect(h.dbQuery.mock.calls[0][0]).toMatch(/SELECT[^;]*\bknown\b/)
    expect(h.dbQuery.mock.calls[1][0]).toContain('SUM(known)')
    expect(json.recent[0]).toMatchObject({ imported: 5, known: 9 })
    expect(json.totals).toMatchObject({ rows_imported: 5, rows_known: 9, files_done: 1 })
  })

  it('reports 0 known rows when there are no finished jobs yet', async () => {
    h.dbQuery.mockReturnValue([])
    const json = await (await GET(new NextRequest('http://localhost/api/upload/queue-status'))).json()
    expect(json.totals).toEqual({ files_done: 0, files_failed: 0, rows_imported: 0, rows_known: 0, rows_skipped: 0 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/upload-route-spool.test.ts __tests__/upload-v1-route-spool.test.ts __tests__/queue-status-known.test.ts 2>&1 | tail -25`
Expected: FAIL (the routes do not carry `known` yet).

- [ ] **Step 3: The HTTP upload route**

In `/home/cole/ulp-suite/app/api/upload/route.ts`:

Replace

```ts
    updateJob(jobId, {
      status:              'done',
      imported:            result.imported,
      skipped:             result.skipped,
      tierDropped:         result.tierDropped,
      rejection_breakdown: result.rejection_breakdown,
    })
```

with

```ts
    updateJob(jobId, {
      status:              'done',
      phase:               undefined,
      imported:            result.imported,
      known:               result.known,
      inFileDuplicates:    result.inFileDuplicates,
      skipped:             result.skipped,
      tierDropped:         result.tierDropped,
      rejection_breakdown: result.rejection_breakdown,
    })
```

Replace

```ts
      status:      'done',
      imported:    result.imported,
      skipped:     result.skipped,
      duration_ms: Date.now() - startAt,
      breach_name: result.breach_name,
    })
    void logUploadAction('upload.complete', actor, jobId, {
      filename, imported: result.imported, skipped: result.skipped, duration_ms: Date.now() - startAt,
    })
```

with

```ts
      status:      'done',
      imported:    result.imported,
      known:       result.known,
      skipped:     result.skipped,
      duration_ms: Date.now() - startAt,
      breach_name: result.breach_name,
    })
    void logUploadAction('upload.complete', actor, jobId, {
      filename, imported: result.imported, known: result.known, skipped: result.skipped, duration_ms: Date.now() - startAt,
    })
```

Replace

```ts
              if (result.imported > 0) results.push(result)
```

with

```ts
              if (result.imported > 0 || result.known > 0) results.push(result)
```

Replace the totals block

```ts
    let totalImported = 0
    let totalSkipped  = 0
    let totalTierDropped = 0

    for (const r of results) {
      totalImported += r.imported
      totalSkipped  += r.skipped
      totalTierDropped += r.tierDropped
```

with

```ts
    let totalImported = 0
    let totalKnown    = 0
    let totalRepeated = 0
    let totalSkipped  = 0
    let totalTierDropped = 0

    for (const r of results) {
      totalImported += r.imported
      totalKnown    += r.known
      totalRepeated += r.inFileDuplicates
      totalSkipped  += r.skipped
      totalTierDropped += r.tierDropped
```

Replace

```ts
      status:      'done',
      imported:    totalImported,
      skipped:     totalSkipped,
      duration_ms: Date.now() - startAt,
      ...(failedEntries.length > 0
```

with

```ts
      status:      'done',
      imported:    totalImported,
      known:       totalKnown,
      skipped:     totalSkipped,
      duration_ms: Date.now() - startAt,
      ...(failedEntries.length > 0
```

Replace

```ts
      filename: originalFilename, imported: totalImported, skipped: totalSkipped, errors: totalErrors,
      duration_ms: Date.now() - startAt,
    })

    const total = totalImported + totalSkipped
    return NextResponse.json({
      success:             true,
      imported:            totalImported,
      skipped:             totalSkipped,
      tierDropped:         totalTierDropped,
      errors:              totalErrors,
      import_pct:          total > 0 ? Math.round(totalImported / total * 1000) / 10 : 0,
      rejection_breakdown: totalBreakdown,
      files:               results.map(r => ({
        filename:    r.filename,
        breach_name: r.breach_name,
        imported:    r.imported,
      })),
```

with

```ts
      filename: originalFilename, imported: totalImported, known: totalKnown, skipped: totalSkipped, errors: totalErrors,
      duration_ms: Date.now() - startAt,
    })

    // Lines the parser accepted: new rows, rows already in the database and rows repeated inside a file. (On the direct path the
    // last two are 0, which makes this the same ratio as before.)
    const kept  = totalImported + totalKnown + totalRepeated
    const total = kept + totalSkipped
    return NextResponse.json({
      success:             true,
      imported:            totalImported,
      known:               totalKnown,
      inFileDuplicates:    totalRepeated,
      skipped:             totalSkipped,
      tierDropped:         totalTierDropped,
      errors:              totalErrors,
      import_pct:          total > 0 ? Math.round(kept / total * 1000) / 10 : 0,
      rejection_breakdown: totalBreakdown,
      files:               results.map(r => ({
        filename:    r.filename,
        breach_name: r.breach_name,
        imported:    r.imported,
        known:       r.known,
      })),
```

- [ ] **Step 4: The v1 route**

In `/home/cole/ulp-suite/app/api/v1/upload/route.ts`:

Replace the header comment line ` * Uses the same processing pipeline as the other routes:` with:

```ts
 * `imported` in every reply counts NEW rows. `known` is how many distinct credentials of the file the database already held and
 * `inFileDuplicates` how many rows repeated an earlier row of the same file (novelty-aware ingest; 0 when it is switched off).
 *
 * Uses the same processing pipeline as the other routes:
```

Replace

```ts
        status:      'done',
        imported:    r.imported,
        skipped:     r.skipped,
        duration_ms: Date.now() - startAt,
        breach_name: r.breach_name,
      })
      void logUploadAction('upload.api.complete', actor, null, {
        ...keyDetails, filename: originalFilename, imported: r.imported, skipped: r.skipped, duration_ms: Date.now() - startAt,
      })

      const response = NextResponse.json({
        success:  true,
        imported: r.imported,
        skipped:  r.skipped,
        errors:   r.errors,
        filename: r.filename,
      })
```

with

```ts
        status:      'done',
        imported:    r.imported,
        known:       r.known,
        skipped:     r.skipped,
        duration_ms: Date.now() - startAt,
        breach_name: r.breach_name,
      })
      void logUploadAction('upload.api.complete', actor, null, {
        ...keyDetails, filename: originalFilename, imported: r.imported, known: r.known, skipped: r.skipped, duration_ms: Date.now() - startAt,
      })

      const response = NextResponse.json({
        success:  true,
        imported: r.imported,
        known:    r.known,
        inFileDuplicates: r.inFileDuplicates,
        skipped:  r.skipped,
        errors:   r.errors,
        filename: r.filename,
      })
```

Replace

```ts
          if (result.imported > 0) results.push(result)
```

with

```ts
          if (result.imported > 0 || result.known > 0) results.push(result)
```

Replace

```ts
    let totalImported = 0
    let totalSkipped  = 0
    for (const r of results) { totalImported += r.imported; totalSkipped += r.skipped }

    logJob({
      source:      'http',
      filename:    originalFilename,
      status:      'done',
      imported:    totalImported,
      skipped:     totalSkipped,
```

with

```ts
    let totalImported = 0
    let totalKnown    = 0
    let totalRepeated = 0
    let totalSkipped  = 0
    for (const r of results) { totalImported += r.imported; totalKnown += r.known; totalRepeated += r.inFileDuplicates; totalSkipped += r.skipped }

    logJob({
      source:      'http',
      filename:    originalFilename,
      status:      'done',
      imported:    totalImported,
      known:       totalKnown,
      skipped:     totalSkipped,
```

Replace

```ts
      ...keyDetails, filename: originalFilename, imported: totalImported, skipped: totalSkipped, errors: totalErrors,
      duration_ms: Date.now() - startAt,
    })

    const response = NextResponse.json({
      success:  true,
      imported: totalImported,
      skipped:  totalSkipped,
      errors:   totalErrors,
      files:    results.map(r => ({ filename: r.filename, imported: r.imported })),
```

with

```ts
      ...keyDetails, filename: originalFilename, imported: totalImported, known: totalKnown, skipped: totalSkipped, errors: totalErrors,
      duration_ms: Date.now() - startAt,
    })

    const response = NextResponse.json({
      success:  true,
      imported: totalImported,
      known:    totalKnown,
      inFileDuplicates: totalRepeated,
      skipped:  totalSkipped,
      errors:   totalErrors,
      files:    results.map(r => ({ filename: r.filename, imported: r.imported, known: r.known })),
```

- [ ] **Step 5: The queue-status route**

In `/home/cole/ulp-suite/app/api/upload/queue-status/route.ts` replace the whole body below the imports with:

```ts
export const dynamic = 'force-dynamic'

interface ProcessingJobRow {
  id:            number
  source:        string
  filename:      string
  status:        string
  imported:      number
  known:         number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  breach_name:   string | null
  created_at:    string
}

interface TotalsRow {
  status:         string
  file_count:     number
  total_imported: number
  total_known:    number
  total_skipped:  number
}

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const recent = dbQuery(
    `SELECT id, source, filename, status, imported, known, skipped,
            duration_ms, error_message, breach_name, created_at
     FROM processing_jobs
     ORDER BY id DESC
     LIMIT 20`,
  ) as ProcessingJobRow[]

  const totalsRows = dbQuery(
    `SELECT status,
            COUNT(*)          AS file_count,
            SUM(imported)     AS total_imported,
            SUM(known)        AS total_known,
            SUM(skipped)      AS total_skipped
     FROM processing_jobs
     GROUP BY status`,
  ) as TotalsRow[]

  const done   = totalsRows.find(r => r.status === 'done')
  const failed = totalsRows.find(r => r.status === 'failed')

  return NextResponse.json({
    queue: {
      active:       uploadQueue.activeCount,
      pending:      uploadQueue.pendingCount,
      current_file: getCurrentJob(),
    },
    recent,
    totals: {
      files_done:    done?.file_count    ?? 0,
      files_failed:  failed?.file_count  ?? 0,
      rows_imported: done?.total_imported ?? 0,
      rows_known:    done?.total_known    ?? 0,
      rows_skipped:  done?.total_skipped  ?? 0,
    },
  })
}
```

(keep the file's existing four `import` lines at the top unchanged.)

- [ ] **Step 6: The API docs page**

In `/home/cole/ulp-suite/app/docs/page.tsx` replace

```tsx
  "success": true,
  "imported": 45230,
  "skipped": 4770,
  "errors": 0,
  "filename": "credentials.txt"
}`}
                  />
```

with

```tsx
  "success": true,
  "imported": 12480,
  "known": 32750,
  "inFileDuplicates": 0,
  "skipped": 4770,
  "errors": 0,
  "filename": "credentials.txt"
}`}
                  />
                  <p className="text-sm text-muted-foreground mt-3">
                    <code className="text-xs bg-muted px-1 rounded">imported</code> counts NEW rows only.{" "}
                    <code className="text-xs bg-muted px-1 rounded">known</code> is how many distinct credentials of the file the database
                    already held, and <code className="text-xs bg-muted px-1 rounded">inFileDuplicates</code> how many rows repeated an
                    earlier row of the same file. A ZIP reply adds <code className="text-xs bg-muted px-1 rounded">known</code> to each
                    entry of <code className="text-xs bg-muted px-1 rounded">files</code>.
                  </p>
```

- [ ] **Step 7: Run the route suites and the typecheck**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/upload-route-spool.test.ts __tests__/upload-v1-route-spool.test.ts __tests__/queue-status-known.test.ts 2>&1 | tail -14 && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 8: Commit**

```bash
cd /home/cole/ulp-suite && git add app/api/upload/route.ts app/api/v1/upload/route.ts app/api/upload/queue-status/route.ts app/docs/page.tsx __tests__/upload-route-spool.test.ts __tests__/upload-v1-route-spool.test.ts __tests__/queue-status-known.test.ts && git commit -m "feat(api): upload replies, the job log and queue status report new, known and repeated rows" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The inbox reports phases and known rows

**Files:**
- Create: `/home/cole/ulp-suite/lib/inbox-progress.ts`
- Modify: `/home/cole/ulp-suite/lib/inbox-watcher.ts`
- Modify: `/home/cole/ulp-suite/app/api/inbox/status/route.ts`
- Test: `/home/cole/ulp-suite/__tests__/inbox-progress.test.ts`
- Test: `/home/cole/ulp-suite/__tests__/inbox-status-route-novelty.test.ts`

**Interfaces:**
- Consumes: `ImportPhase`, `ImportProgressEvent` (Task 7); `ProcessResult.known` (Task 8); `noveltyConfig` (Task 2).
- Produces:
  - `lib/inbox-progress.ts`: `interface InboxProgressFields { rows_imported: number; phase?: ImportPhase; rows_staged?: number; rows_known?: number; slab?: number; slabs?: number }`, `applyImportProgress(progress: InboxProgressFields, e: ImportProgressEvent, base: { imported: number; known: number }): void`, `progressRows(p: { rows_imported: number; phase?: ImportPhase; rows_staged?: number }): number`
  - `InboxJobProgress` gains optional `phase`, `rows_staged`, `rows_known`, `slab`, `slabs`
  - `GET /api/inbox/status`: `current_progress` gains `rows_staged`, `rows_known`, `phase`, `slab`, `slabs`; each `done_recent` row gains `known`

- [ ] **Step 1: Write the failing tests**

Create `/home/cole/ulp-suite/__tests__/inbox-progress.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyImportProgress, progressRows, type InboxProgressFields } from '@/lib/inbox-progress'

const fresh = (): InboxProgressFields => ({ rows_imported: 0 })

describe('applyImportProgress', () => {
  it('copies the phase, the staged rows and the slab, and the running new / known counts of a plain file', () => {
    const p = fresh()
    applyImportProgress(p, { phase: 'inserting', staged: 900, skipped: 4, known: 300, inserted: 500, slab: 2, slabs: 5 }, { imported: 0, known: 0 })
    expect(p).toEqual({ rows_imported: 500, phase: 'inserting', rows_staged: 900, rows_known: 300, slab: 2, slabs: 5 })
  })

  it('adds what the finished entries of an archive already contributed', () => {
    const p = fresh()
    applyImportProgress(p, { phase: 'checking', staged: 100, skipped: 0, known: 10, inserted: 20, slab: 1, slabs: 1 }, { imported: 1000, known: 400 })
    expect(p).toMatchObject({ rows_imported: 1020, rows_known: 410, rows_staged: 100 })
  })

  it('clears the slab when the event has none (parsing)', () => {
    const p: InboxProgressFields = { rows_imported: 0, slab: 3, slabs: 4 }
    applyImportProgress(p, { phase: 'parsing', staged: 50, skipped: 0, known: 0, inserted: 0 }, { imported: 0, known: 0 })
    expect(p.slab).toBeUndefined()
    expect(p.slabs).toBeUndefined()
    expect(p.phase).toBe('parsing')
  })
})

describe('progressRows', () => {
  it('is the staged rows while novelty-aware ingest is working and the imported rows otherwise', () => {
    expect(progressRows({ rows_imported: 7 })).toBe(7)
    expect(progressRows({ rows_imported: 7, phase: 'parsing', rows_staged: 4000 })).toBe(4000)
    expect(progressRows({ rows_imported: 7, phase: 'inserting' })).toBe(0)
  })
})
```

Create `/home/cole/ulp-suite/__tests__/inbox-status-route-novelty.test.ts`:

```ts
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ progress: null as null | Record<string, unknown>, dbQuery: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/sqlite', () => ({ dbQuery: h.dbQuery }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: { activeCount: 1, pendingCount: 0 }, getCurrentJob: () => 'big.txt' }))
vi.mock('@/lib/inbox-helpers', () => ({ getWaiting: () => [], getFailed: () => [], getDoneCount: () => 0 }))
vi.mock('@/lib/inbox-watcher', () => ({ getInboxJobProgress: () => h.progress, getInFlightCount: () => 1 }))

import { GET } from '@/app/api/inbox/status/route'

const get = async () => (await GET(new NextRequest('http://localhost/api/inbox/status'))).json()

beforeEach(() => {
  h.progress = null
  h.dbQuery.mockReset()
  h.dbQuery.mockReturnValue([])
})

describe('GET /api/inbox/status with novelty-aware ingest', () => {
  it('measures progress by the rows staged while the file is being read, and passes the phase on', async () => {
    h.progress = {
      filename: 'big.txt', started_at: Date.now() - 100_000, rows_imported: 0, file_size_bytes: 800_000_000,
      phase: 'parsing', rows_staged: 4_000_000, rows_known: 0,
    }
    const json = await get()
    expect(json.current_progress).toMatchObject({
      filename: 'big.txt', phase: 'parsing', rows_imported: 0, rows_staged: 4_000_000, rows_known: 0, est_total_rows: 10_000_000, pct: 40,
    })
    expect(json.current_progress.rows_per_sec).toBeGreaterThan(30_000)
    expect(json.current_progress.rows_per_sec).toBeLessThan(40_100)
  })

  it('reports the slab and the running new / known counts while committing', async () => {
    h.progress = {
      filename: 'big.txt', started_at: Date.now() - 1_000, rows_imported: 300, file_size_bytes: 8_000,
      phase: 'inserting', rows_staged: 100, rows_known: 200, slab: 2, slabs: 3,
    }
    const json = await get()
    expect(json.current_progress).toMatchObject({ phase: 'inserting', rows_imported: 300, rows_known: 200, slab: 2, slabs: 3 })
  })

  it('shows a file that has not staged a batch yet, with a zero phase block', async () => {
    h.progress = { filename: 'big.txt', started_at: Date.now(), rows_imported: 0, file_size_bytes: 100, phase: 'parsing', rows_staged: 0 }
    const json = await get()
    expect(json.current_progress).toMatchObject({ phase: 'parsing', rows_staged: 0, rows_imported: 0, pct: null, eta_ms: null })
  })

  it('still works for the direct path: no phase, progress from the imported rows', async () => {
    h.progress = { filename: 'big.txt', started_at: Date.now() - 10_000, rows_imported: 500_000, file_size_bytes: 80_000_000 }
    const json = await get()
    expect(json.current_progress).toMatchObject({ rows_imported: 500_000, rows_staged: 0, rows_known: 0, phase: null, est_total_rows: 1_000_000, pct: 50 })
  })

  it('lists the known count of each finished file', async () => {
    h.dbQuery.mockReturnValue([{ id: 1, filename: 'a.txt', status: 'done', imported: 5, known: 9, skipped: 0, duration_ms: 1, error_message: null, created_at: 'x' }])
    const json = await get()
    expect(h.dbQuery.mock.calls[0][0]).toMatch(/SELECT[^;]*\bknown\b/)
    expect(json.done_recent[0]).toMatchObject({ imported: 5, known: 9 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/inbox-progress.test.ts __tests__/inbox-status-route-novelty.test.ts 2>&1 | tail -16`
Expected: FAIL (`@/lib/inbox-progress` does not exist; the route has no phase fields).

- [ ] **Step 3: The helper**

Create `/home/cole/ulp-suite/lib/inbox-progress.ts`:

```ts
/**
 * How the inbox's live progress line follows novelty-aware ingest (lib/ingest-novelty.ts). Pure, so it can be tested without the
 * watcher.
 */
import type { ImportPhase, ImportProgressEvent } from '@/lib/import-runner'

export interface InboxProgressFields {
  /** Rows written so far: NEW rows with novelty-aware ingest. */
  rows_imported: number
  phase?: ImportPhase
  rows_staged?: number
  rows_known?: number
  slab?: number
  slabs?: number
}

/**
 * Applies one progress event of the file being imported. `base` is what the entries of the same archive that already finished
 * contributed (0 and 0 for a plain text file), because the event's counters belong to the entry in flight only.
 */
export function applyImportProgress(
  progress: InboxProgressFields,
  e: ImportProgressEvent,
  base: { imported: number; known: number },
): void {
  progress.phase = e.phase
  progress.rows_staged = e.staged
  progress.rows_known = base.known + e.known
  progress.rows_imported = base.imported + e.inserted
  progress.slab = e.slab
  progress.slabs = e.slabs
}

/**
 * The rows that count as "done" for the percentage and the ETA: the rows read and staged while novelty-aware ingest is working
 * (the rows written would stay near 0 for most of a file), the rows written otherwise.
 */
export function progressRows(p: { rows_imported: number; phase?: ImportPhase; rows_staged?: number }): number {
  return p.phase ? (p.rows_staged ?? 0) : p.rows_imported
}
```

- [ ] **Step 4: The watcher**

In `/home/cole/ulp-suite/lib/inbox-watcher.ts`:

Add to the imports (after the `waitForDiskSpace` import):

```ts
import { noveltyConfig } from '@/lib/ingest-novelty-config'
import { applyImportProgress } from '@/lib/inbox-progress'
import type { ImportPhase, ImportProgressEvent } from '@/lib/import-runner'
```

Replace the `InboxJobProgress` interface

```ts
export interface InboxJobProgress {
  filename:        string
  started_at:      number   // Date.now() when processing began
  rows_imported:   number   // rows successfully inserted so far
  file_size_bytes: number   // from fs.statSync before processing
}
```

with

```ts
export interface InboxJobProgress {
  filename:        string
  started_at:      number   // Date.now() when processing began
  rows_imported:   number   // rows successfully written so far (NEW rows with novelty-aware ingest)
  file_size_bytes: number   // from fs.statSync before processing
  /** Novelty-aware ingest only: where the import is, and the rows staged / already known so far. */
  phase?:          ImportPhase
  rows_staged?:    number
  rows_known?:     number
  slab?:           number
  slabs?:          number
}
```

In `enqueueFile`, replace

```ts
    let imported = 0
    let skipped  = 0
    let procPath: string | null = null
```

with

```ts
    let imported = 0
    let known    = 0
    let skipped  = 0
    let procPath: string | null = null
```

Replace the block from `// runImportJob fails the job, and frees this queue slot` through the end of the `if (ext === '.zip') {...} else {...}` statement with:

```ts
      // The live line follows novelty-aware ingest: reading the file, checking it against the table, writing the new rows. For an
      // archive, `imported` / `known` hold the entries that already finished, so the entry in flight adds to them.
      const onImportProgress = (e: ImportProgressEvent) => {
        const cp = getCurrentProgress()
        if (cp) applyImportProgress(cp, e, { imported, known })
      }

      // runImportJob fails the job, and frees this queue slot, if it stops making progress for IMPORT_STALL_TIMEOUT_MS:
      // one wedged import can no longer hold the shared queue until an app restart.
      if (ext === '.zip') {
        await runImportJob({
          label: filename,
          work:  ctx => processZipFile(claimedPath, result => {
            imported += result.imported
            known    += result.known
            skipped  += result.skipped
            const cp = getCurrentProgress()
            if (cp) { cp.rows_imported = imported; cp.rows_known = known }
            if (result.imported > 0 || result.known > 0) {
              console.log(
                `[inbox-watcher]   ${result.filename}: ` +
                `imported=${result.imported} known=${result.known} skipped=${result.skipped}`
              )
            } else if (result.errors > 0) {
              console.warn(`[inbox-watcher]   ${result.filename}: skipped (entry error)`)
            }
          }, { ...ctx, onImportProgress }),
        })
      } else {
        const result = await runImportJob({
          label: filename,
          work:  ctx => processTextFile(claimedPath, filename, undefined, n => {
            // onBatch: update live progress after each batch (each slab with novelty-aware ingest)
            const cp = getCurrentProgress()
            if (cp) cp.rows_imported = n
          }, { ...ctx, onImportProgress }),
        })
        imported = result.imported
        known    = result.known
        skipped  = result.skipped
        console.log(
          `[inbox-watcher] done: ${filename} ` +
          `imported=${result.imported} known=${result.known} skipped=${result.skipped}`
        )
      }
```

In the `logJob({ ... status: 'done', ... })` call add `known,` after `imported,`; in the failure `logJob({ ... status: 'failed', ... })` add `known,` after `imported,`. The two calls are the ones containing `status:      'done',` and `status:        'failed',` inside `enqueueFile`'s task.

Replace the interrupted-file message

```ts
      error_message: 'Interrupted mid-import (app restart) — may be partially imported; review before re-adding.',
```

with

```ts
      error_message: noveltyConfig().enabled
        ? 'Interrupted mid-import (app restart). Safe to Retry: rows already imported are skipped.'
        : 'Interrupted mid-import (app restart) — may be partially imported; review before re-adding.',
```

Also update the two header-comment sentences that promise review: in the "Startup sweep" bullet of the file's top comment, change `moved to failed/ for review, never silently re-imported.` to `moved to failed/ for review, never silently re-imported (with novelty-aware ingest a Retry is safe: rows already imported count as known).`

The existing inbox tests read the watcher source and check for `processZipFile(claimedPath` and `processTextFile(claimedPath`; both strings are still there.

- [ ] **Step 5: The status route**

In `/home/cole/ulp-suite/app/api/inbox/status/route.ts`:

Add `import { progressRows } from '@/lib/inbox-progress'` after the other imports. Replace the `DoneRow` interface with:

```ts
interface DoneRow {
  id:            number
  filename:      string
  status:        string
  imported:      number
  known:         number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  created_at:    string
}
```

Replace the `done_recent` query's first line `` `SELECT id, filename, status, imported, skipped, duration_ms, error_message, created_at`` with `` `SELECT id, filename, status, imported, known, skipped, duration_ms, error_message, created_at``.

Replace the whole block from `// Build enriched progress object with ETA if we have enough data.` through the closing `}` of the `else if (progress) {...}` with:

```ts
  // Build enriched progress object with ETA if we have enough data. With novelty-aware ingest the rows read and staged measure
  // progress (the rows written stay near zero for most of a file); otherwise the rows written do.
  const phaseFields = progress
    ? {
        rows_staged: progress.rows_staged ?? 0,
        rows_known:  progress.rows_known ?? 0,
        phase:       progress.phase ?? null,
        slab:        progress.slab ?? null,
        slabs:       progress.slabs ?? null,
      }
    : null
  const rowsDone = progress ? progressRows(progress) : 0
  let current_progress = null
  if (progress && rowsDone > 0) {
    const elapsed_ms     = Date.now() - progress.started_at
    const rows_per_sec   = Math.round(rowsDone / (elapsed_ms / 1_000))
    // Estimate total rows from file size (avg credential line ≈ 80 bytes)
    const est_total_rows = progress.file_size_bytes > 0
      ? Math.round(progress.file_size_bytes / 80)
      : null
    const pct = est_total_rows && est_total_rows > 0
      ? Math.min(99, Math.round(rowsDone / est_total_rows * 100))
      : null
    const eta_ms = est_total_rows && rows_per_sec > 0
      ? Math.round((est_total_rows - rowsDone) / rows_per_sec * 1_000)
      : null

    current_progress = {
      filename:         progress.filename,
      started_at:       progress.started_at,
      elapsed_ms,
      rows_imported:    progress.rows_imported,
      ...phaseFields,
      file_size_bytes:  progress.file_size_bytes,
      rows_per_sec,
      est_total_rows,
      pct,
      eta_ms,
    }
  } else if (progress) {
    // Processing started but no rows yet (parsing/first batch)
    current_progress = {
      filename:         progress.filename,
      started_at:       progress.started_at,
      elapsed_ms:       Date.now() - progress.started_at,
      rows_imported:    progress.rows_imported,
      ...phaseFields,
      file_size_bytes:  progress.file_size_bytes,
      rows_per_sec:     0,
      est_total_rows:   null,
      pct:              null,
      eta_ms:           null,
    }
  }
```

- [ ] **Step 6: Run the inbox suites and the typecheck**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/inbox-progress.test.ts __tests__/inbox-status-route-novelty.test.ts __tests__/inbox-watcher-runner.test.ts __tests__/inbox-watcher-globalthis.test.ts __tests__/inbox-watcher-disk-gate.test.ts __tests__/inbox-watcher-memory-guard.test.ts __tests__/inbox-watcher-stability.test.ts __tests__/inbox-status.test.ts 2>&1 | tail -14 && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/inbox-progress.ts lib/inbox-watcher.ts app/api/inbox/status/route.ts __tests__/inbox-progress.test.ts __tests__/inbox-status-route-novelty.test.ts && git commit -m "feat(inbox): live progress follows the phases, the log records known rows, an interrupted file is safe to retry" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The Upload and Inbox pages say what was new

**Files:**
- Create: `/home/cole/ulp-suite/lib/import-summary.ts`
- Modify: `/home/cole/ulp-suite/app/upload/page.tsx`
- Modify: `/home/cole/ulp-suite/app/inbox/page.tsx`
- Test: `/home/cole/ulp-suite/__tests__/import-summary.test.ts`

**Interfaces:**
- Consumes: `ImportPhase` (Task 7).
- Produces (`lib/import-summary.ts`):
  - `keptRows(r: { imported: number; known?: number; inFileDuplicates?: number }): number`
  - `importRatePct(r: { imported: number; known?: number; inFileDuplicates?: number; skipped: number }): number` (one decimal)
  - `phaseLine(p: { phase?: ImportPhase | null; staged?: number; known?: number; imported?: number; slab?: number | null; slabs?: number | null }): string | null`
  - `newKnownLabel(imported: number, known: number | undefined, fmt: (n: number) => string): string`

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/import-summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { importRatePct, keptRows, newKnownLabel, phaseLine } from '@/lib/import-summary'

describe('keptRows / importRatePct', () => {
  it('counts the new, the already-known and the repeated rows as accepted', () => {
    expect(keptRows({ imported: 2, known: 6, inFileDuplicates: 1 })).toBe(9)
    expect(keptRows({ imported: 5 })).toBe(5)
  })

  it('is the accepted share of all lines, to one decimal, and 0 for an empty file', () => {
    expect(importRatePct({ imported: 2, known: 6, inFileDuplicates: 1, skipped: 3 })).toBe(75)
    expect(importRatePct({ imported: 1, skipped: 2 })).toBe(33.3)
    expect(importRatePct({ imported: 0, skipped: 0 })).toBe(0)
  })

  it('is the same ratio as before on the direct path (known and repeated are 0)', () => {
    expect(importRatePct({ imported: 900, known: 0, inFileDuplicates: 0, skipped: 100 })).toBe(90)
  })
})

describe('phaseLine', () => {
  it('says nothing without a phase (the direct path)', () => {
    expect(phaseLine({})).toBeNull()
    expect(phaseLine({ phase: null, staged: 5 })).toBeNull()
  })

  it('describes reading, checking and writing', () => {
    expect(phaseLine({ phase: 'parsing', staged: 1234567 })).toBe('Reading the file: 1,234,567 rows so far')
    expect(phaseLine({ phase: 'checking', staged: 20000000 })).toBe('Checking 20,000,000 rows against the database')
    expect(phaseLine({ phase: 'inserting', imported: 500, known: 1500 })).toBe('Writing the new rows: 500 new, 1,500 already in the database so far')
  })

  it('names the part when a file is committed in several', () => {
    expect(phaseLine({ phase: 'checking', staged: 60000000, slab: 2, slabs: 3 })).toBe('Checking 60,000,000 rows against the database (part 2 of 3)')
    expect(phaseLine({ phase: 'inserting', imported: 1, known: 2, slab: 3, slabs: 3 })).toBe('Writing the new rows (part 3 of 3): 1 new, 2 already in the database so far')
    expect(phaseLine({ phase: 'checking', staged: 5, slab: 1, slabs: 1 })).toBe('Checking 5 rows against the database')
  })
})

describe('newKnownLabel', () => {
  const fmt = (n: number) => `<${n}>`
  it('keeps the old wording when nothing was known', () => {
    expect(newKnownLabel(1000, 0, fmt)).toBe('<1000> rows')
    expect(newKnownLabel(1000, undefined, fmt)).toBe('<1000> rows')
  })
  it('shows new and known side by side otherwise', () => {
    expect(newKnownLabel(1000, 250, fmt)).toBe('<1000> new · <250> known')
    expect(newKnownLabel(0, 250, fmt)).toBe('<0> new · <250> known')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/import-summary.test.ts 2>&1 | tail -10`
Expected: FAIL, `Failed to resolve import "@/lib/import-summary"`.

- [ ] **Step 3: The helpers**

Create `/home/cole/ulp-suite/lib/import-summary.ts`:

```ts
/**
 * Wording and arithmetic for what an import did, shared by the Upload and Inbox pages (docs/superpowers/specs/
 * 2026-10-02-novelty-aware-ingest-design.md). Pure, so the pages stay thin and this is tested.
 */
import type { ImportPhase } from '@/lib/import-runner'

const count = (n: number | undefined) => (n ?? 0).toLocaleString('en-US')

/** Lines the parser accepted: new rows, rows the database already held, and rows repeated inside the file. */
export function keptRows(r: { imported: number; known?: number; inFileDuplicates?: number }): number {
  return r.imported + (r.known ?? 0) + (r.inFileDuplicates ?? 0)
}

/** The accepted share of all lines, to one decimal. On the direct path known and repeated are 0, so this is the old import rate. */
export function importRatePct(r: { imported: number; known?: number; inFileDuplicates?: number; skipped: number }): number {
  const kept = keptRows(r)
  const total = kept + r.skipped
  return total > 0 ? Math.round((kept / total) * 1000) / 10 : 0
}

/** One line for the progress card, or null when there is no phase to describe (the direct path). */
export function phaseLine(p: {
  phase?: ImportPhase | null
  staged?: number
  known?: number
  imported?: number
  slab?: number | null
  slabs?: number | null
}): string | null {
  if (!p.phase) return null
  const part = p.slabs && p.slabs > 1 && p.slab ? ` (part ${p.slab} of ${p.slabs})` : ''
  if (p.phase === 'parsing') return `Reading the file: ${count(p.staged)} rows so far`
  if (p.phase === 'checking') return `Checking ${count(p.staged)} rows against the database${part}`
  return `Writing the new rows${part}: ${count(p.imported)} new, ${count(p.known)} already in the database so far`
}

/** "1.2M rows" as before when nothing was known, otherwise "1.2M new · 340K known". */
export function newKnownLabel(imported: number, known: number | undefined, fmt: (n: number) => string): string {
  return (known ?? 0) > 0 ? `${fmt(imported)} new · ${fmt(known ?? 0)} known` : `${fmt(imported)} rows`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/import-summary.test.ts 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: The Upload page**

In `/home/cole/ulp-suite/app/upload/page.tsx`:

1. Add after the `buildTopRejections` import line: `import { importRatePct, keptRows, newKnownLabel, phaseLine } from "@/lib/import-summary"`.
2. Replace

```ts
interface ZipFileEntry {
  filename: string
  breach_name: string
  imported: number
}

interface UploadResult {
  imported: number
  skipped: number
```

with

```ts
interface ZipFileEntry {
  filename: string
  breach_name: string
  imported: number
  /** Distinct credentials of the file that were already in the database. */
  known?: number
}

interface UploadResult {
  /** New rows written to the database. */
  imported: number
  /** Distinct credentials of the file that were already in the database. */
  known?: number
  /** Rows that repeat an earlier row of the same file. */
  inFileDuplicates?: number
  skipped: number
```

3. After `const [liveTierDropped, setLiveTierDropped] = useState(0)` add:

```ts
  // Novelty-aware ingest: where the server is (reading the file, checking it against the database, writing the new rows).
  const [liveProgress, setLiveProgress] = useState<{
    phase: 'parsing' | 'checking' | 'inserting'; staged: number; imported: number; known: number; slab?: number; slabs?: number
  } | null>(null)
```

4. Replace `setLiveImported(0); setLiveSkipped(0); setLiveTierDropped(0); setLivePct(0); setElapsedMs(0)` with `setLiveImported(0); setLiveSkipped(0); setLiveTierDropped(0); setLiveProgress(null); setLivePct(0); setElapsedMs(0)`.
5. Replace

```ts
              setLiveTierDropped(d.tierDropped ?? 0)
              setLivePct(d.pct           ?? 0)
```

with

```ts
              setLiveTierDropped(d.tierDropped ?? 0)
              setLiveProgress(d.phase
                ? { phase: d.phase, staged: d.staged ?? 0, imported: d.imported ?? 0, known: d.known ?? 0, slab: d.slab, slabs: d.slabs }
                : null)
              setLivePct(d.pct           ?? 0)
```

6. In the `status === 'done'` result object replace `tierDropped:         d.tierDropped ?? 0,\n                  errors:              0,` with `tierDropped:         d.tierDropped ?? 0,\n                  known:               d.known ?? 0,\n                  inFileDuplicates:    d.inFileDuplicates ?? 0,\n                  errors:              0,`.
7. Replace the live counters

```tsx
                  <span>{liveImported.toLocaleString()} imported</span>
                  <span>{livePct}%</span>
                  <span>{liveSkipped.toLocaleString()} skipped</span>
                </div>
```

with

```tsx
                  <span>{liveImported.toLocaleString()} {liveProgress ? 'new' : 'imported'}</span>
                  <span>{livePct}%</span>
                  <span>{liveSkipped.toLocaleString()} skipped</span>
                </div>
                {liveProgress && (
                  <p className="text-center text-xs text-muted-foreground tabular-nums">{phaseLine(liveProgress)}</p>
                )}
```

and replace the closing of that `livePct > 0` branch's fallback so the phase also shows before the first percentage: replace

```tsx
            ) : (
              <Progress value={progress} className="h-2" />
            )}
          </CardContent>
```

with

```tsx
            ) : (
              <>
                <Progress value={progress} className="h-2" />
                {liveProgress && (
                  <p className="text-center text-xs text-muted-foreground tabular-nums">{phaseLine(liveProgress)}</p>
                )}
              </>
            )}
          </CardContent>
```

8. In the success summary, replace

```tsx
        const totalSkipped  = allResults.reduce((s, r) => s + r.skipped,  0)
```

with

```tsx
        const totalSkipped  = allResults.reduce((s, r) => s + r.skipped,  0)
        const totalKnown    = allResults.reduce((s, r) => s + (r.known ?? 0), 0)
        const totalRepeated = allResults.reduce((s, r) => s + (r.inFileDuplicates ?? 0), 0)
```

Replace

```tsx
        const total      = totalImported + totalSkipped
        const import_pct = total > 0 ? Math.round(totalImported / total * 1000) / 10 : 0
```

with

```tsx
        const import_pct = importRatePct({ imported: totalImported, known: totalKnown, inFileDuplicates: totalRepeated, skipped: totalSkipped })
```

Replace `r.files ?? [{ filename: r.filename, breach_name: r.breach_name ?? '', imported: r.imported }]` with `r.files ?? [{ filename: r.filename, breach_name: r.breach_name ?? '', imported: r.imported, known: r.known ?? 0 }]`.

Replace

```tsx
          imported:            totalImported,
          skipped:             totalSkipped,
          tierDropped:         totalTierDropped,
```

with

```tsx
          imported:            totalImported,
          known:               totalKnown,
          inFileDuplicates:    totalRepeated,
          skipped:             totalSkipped,
          tierDropped:         totalTierDropped,
```

Replace the stat grid

```tsx
              <div className={(displayResult.tierDropped ?? 0) > 0 ? "grid grid-cols-4 gap-3" : "grid grid-cols-3 gap-3"}>
                <StatBox label="Imported" value={displayResult.imported.toLocaleString()} color="green" />
                <StatBox label="Skipped"  value={displayResult.skipped.toLocaleString()}  color="yellow" />
                <StatBox label="Errors"   value={displayResult.errors.toLocaleString()}   color="red" />
                {(displayResult.tierDropped ?? 0) > 0 && (
                  <StatBox label="Filtered" value={(displayResult.tierDropped ?? 0).toLocaleString()} color="yellow" />
                )}
              </div>
```

with

```tsx
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatBox label="Imported" value={displayResult.imported.toLocaleString()} color="green" />
                {(displayResult.known ?? 0) > 0 && (
                  <StatBox label="Already in the database" value={(displayResult.known ?? 0).toLocaleString()} color="yellow" />
                )}
                {(displayResult.inFileDuplicates ?? 0) > 0 && (
                  <StatBox label="Repeated in the file" value={(displayResult.inFileDuplicates ?? 0).toLocaleString()} color="yellow" />
                )}
                <StatBox label="Skipped"  value={displayResult.skipped.toLocaleString()}  color="yellow" />
                <StatBox label="Errors"   value={displayResult.errors.toLocaleString()}   color="red" />
                {(displayResult.tierDropped ?? 0) > 0 && (
                  <StatBox label="Filtered" value={(displayResult.tierDropped ?? 0).toLocaleString()} color="yellow" />
                )}
              </div>
```

Replace `const rejTotal   = displayResult.imported + displayResult.skipped` with `const rejTotal   = keptRows(displayResult) + displayResult.skipped`.

Replace

```tsx
                          {f.imported.toLocaleString()} rows
```

with

```tsx
                          {newKnownLabel(f.imported, f.known, n => n.toLocaleString())}
```

9. In the queue panel: in `interface QueueJob` add `known?: number` after `imported: number`; in `interface QueueStatus` totals add `rows_known?: number` after `rows_imported: number`; replace `<span className="tabular-nums shrink-0">{fmtRows(job.imported)} rows</span>` with `<span className="tabular-nums shrink-0">{newKnownLabel(job.imported, job.known, fmtRows)}</span>`; replace `<span><span className="font-medium text-foreground">{fmtRows(data.totals.rows_imported)}</span> rows imported</span>` with `<span><span className="font-medium text-foreground">{fmtRows(data.totals.rows_imported)}</span> rows imported{(data.totals.rows_known ?? 0) > 0 && <>, <span className="font-medium text-foreground">{fmtRows(data.totals.rows_known ?? 0)}</span> already known</>}</span>`.

- [ ] **Step 6: The Inbox page**

In `/home/cole/ulp-suite/app/inbox/page.tsx`:

1. Add after the existing lucide/ui imports a line `import { newKnownLabel, phaseLine } from "@/lib/import-summary"` (use the file's quote style: it uses double quotes for the import specifiers elsewhere; follow the neighbouring lines).
2. In `interface DoneEntry` add `known?:        number` after `imported:      number`.
3. In `interface CurrentProgress` add after `eta_ms:          number | null`:

```ts
  /** Novelty-aware ingest only. */
  phase?:          'parsing' | 'checking' | 'inserting' | null
  rows_staged?:    number
  rows_known?:     number
  slab?:           number | null
  slabs?:          number | null
```

4. Replace `<span>{fmtRows(data.current_progress.rows_imported)} rows imported</span>` with:

```tsx
                  <span>
                    {data.current_progress.phase
                      ? `${fmtRows(data.current_progress.rows_staged ?? 0)} rows read`
                      : `${fmtRows(data.current_progress.rows_imported)} rows imported`}
                  </span>
```

5. Replace

```tsx
              <p className="text-xs text-muted-foreground">
                {fmtRows(data.current_progress.rows_imported)} rows imported
                {data.current_progress.rows_imported === 0 && ' — parsing first batch…'}
              </p>
            )}
```

with

```tsx
              <p className="text-xs text-muted-foreground">
                {data.current_progress.phase
                  ? `${fmtRows(data.current_progress.rows_staged ?? 0)} rows read`
                  : `${fmtRows(data.current_progress.rows_imported)} rows imported`}
                {(data.current_progress.phase ? (data.current_progress.rows_staged ?? 0) : data.current_progress.rows_imported) === 0 && ' — parsing first batch…'}
              </p>
            )}
            {data.current_progress.phase && (
              <p className="text-xs text-muted-foreground">
                {phaseLine({
                  phase:    data.current_progress.phase,
                  staged:   data.current_progress.rows_staged,
                  imported: data.current_progress.rows_imported,
                  known:    data.current_progress.rows_known,
                  slab:     data.current_progress.slab,
                  slabs:    data.current_progress.slabs,
                })}
              </p>
            )}
```

6. Replace `<span className="tabular-nums shrink-0">{fmtRows(job.imported)} rows</span>` with `<span className="tabular-nums shrink-0">{newKnownLabel(job.imported, job.known, fmtRows)}</span>`.

- [ ] **Step 7: Typecheck, lint the touched files, run the suites**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit && npx eslint app/upload/page.tsx app/inbox/page.tsx lib/import-summary.ts lib/inbox-progress.ts lib/ingest-stage.ts lib/ingest-novelty.ts lib/ingest-novelty-config.ts lib/upload-processor.ts lib/inbox-watcher.ts 2>&1 | tail -20 && npx vitest run __tests__/import-summary.test.ts 2>&1 | tail -6`
Expected: tsc exit 0; eslint prints nothing (or only warnings that already exist elsewhere in these files: check with `git stash` if unsure); the suite passes.

- [ ] **Step 8: Look at the pages**

Start the dev server with the project's preview tool (`preview_start` with the name from `.claude/launch.json`), open `/upload` and `/inbox` in the built-in browser, and confirm both still render. The pages need an admin session; do not type anyone's password: if the pages redirect to the login page, say so and rely on Task 16's rehearsal, where a test admin exists.

- [ ] **Step 9: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/import-summary.ts __tests__/import-summary.test.ts app/upload/page.tsx app/inbox/page.tsx && git commit -m "feat(ui): the Upload and Inbox pages show what was new, what was already known and where the import is" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Start-up sweep, configuration and documentation

**Files:**
- Modify: `/home/cole/ulp-suite/instrumentation.ts`
- Modify: `/home/cole/ulp-suite/docker-compose.yml`
- Modify: `/home/cole/ulp-suite/docker-compose.rehearsal.yml`
- Modify: `/home/cole/ulp-suite/.env.example`
- Modify: `/home/cole/ulp-suite/README.md`
- Test: `/home/cole/ulp-suite/__tests__/novelty-wiring.test.ts`

**Interfaces:**
- Consumes: `startStageSweeper` (Task 4).
- Produces: the sweeper runs, and finishes (or 20 s pass), before the inbox watcher starts; `INGEST_NOVELTY_CHECK`, `INGEST_NOVELTY_SLAB_ROWS` are forwarded by the production compose file (empty = the defaults in code); the rehearsal compose forwards `UPLOAD_CONCURRENCY`, `INGEST_NOVELTY_CHECK`, `INGEST_NOVELTY_SLAB_ROWS` from `REHEARSAL_*` variables.

- [ ] **Step 1: Write the failing test**

Create `/home/cole/ulp-suite/__tests__/novelty-wiring.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('novelty-aware ingest wiring', () => {
  it('sweeps orphan stage tables before the inbox watcher starts importing', () => {
    const src = read('instrumentation.ts')
    const sweep = src.indexOf('startStageSweeper')
    const inbox = src.indexOf('startInboxWatcher()')
    expect(sweep).toBeGreaterThan(-1)
    expect(inbox).toBeGreaterThan(-1)
    expect(sweep).toBeLessThan(inbox)
    expect(src).toMatch(/Promise\.race\(\[\s*startStageSweeper\(\)/) // bounded: a slow ClickHouse must not delay the app
  })

  it('forwards both settings through the production compose file with empty defaults', () => {
    const compose = read('docker-compose.yml')
    expect(compose).toContain('INGEST_NOVELTY_CHECK: ${INGEST_NOVELTY_CHECK:-}')
    expect(compose).toContain('INGEST_NOVELTY_SLAB_ROWS: ${INGEST_NOVELTY_SLAB_ROWS:-}')
  })

  it('lets the rehearsal compose file choose concurrency, the novelty check and the slab size', () => {
    const compose = read('docker-compose.rehearsal.yml')
    expect(compose).toContain('UPLOAD_CONCURRENCY: ${REHEARSAL_UPLOAD_CONCURRENCY:-}')
    expect(compose).toContain('INGEST_NOVELTY_CHECK: ${REHEARSAL_INGEST_NOVELTY_CHECK:-}')
    expect(compose).toContain('INGEST_NOVELTY_SLAB_ROWS: ${REHEARSAL_INGEST_NOVELTY_SLAB_ROWS:-}')
  })

  it('documents the settings in .env.example and the README', () => {
    expect(read('.env.example')).toContain('INGEST_NOVELTY_CHECK')
    expect(read('.env.example')).toContain('INGEST_NOVELTY_SLAB_ROWS')
    expect(read('README.md')).toContain('INGEST_NOVELTY_CHECK')
    expect(read('README.md')).toContain('INGEST_NOVELTY_SLAB_ROWS')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/novelty-wiring.test.ts 2>&1 | tail -14`
Expected: FAIL (four tests).

- [ ] **Step 3: The start-up sweep**

In `/home/cole/ulp-suite/instrumentation.ts`, immediately before the block

```ts
      try {
        const { startInboxWatcher } = await import('./lib/inbox-watcher')
```

insert:

```ts
      // Drop the stage tables a previous process left behind (novelty-aware ingest, lib/ingest-stage.ts) BEFORE the inbox starts
      // importing. Waits at most 20 s for ClickHouse, so a slow start never delays the app.
      try {
        const { startStageSweeper } = await import('./lib/ingest-stage')
        await Promise.race([
          startStageSweeper(),
          new Promise<void>(resolve => setTimeout(resolve, 20_000)),
        ])
      } catch (err) {
        console.error('[instrumentation] Stage-table sweeper failed to start:', err)
      }

```

- [ ] **Step 4: Compose files**

In `/home/cole/ulp-suite/docker-compose.yml`, after the line `      INGEST_DISK_GATE: ${INGEST_DISK_GATE:-}` add:

```yaml
      # Novelty-aware ingest (lib/ingest-novelty.ts) -- optional; forwarded explicitly (see above). On by default: a file is parsed
      # into a stage table and only the credentials ulp.credentials does not hold yet are written. INGEST_NOVELTY_CHECK=off imports
      # straight into ulp.credentials as before. INGEST_NOVELTY_SLAB_ROWS (empty = 20000000, at least 1000) is the size of one
      # commit step.
      INGEST_NOVELTY_CHECK: ${INGEST_NOVELTY_CHECK:-}
      INGEST_NOVELTY_SLAB_ROWS: ${INGEST_NOVELTY_SLAB_ROWS:-}
```

In `/home/cole/ulp-suite/docker-compose.rehearsal.yml`, after the line `      INGEST_DISK_GATE: ${REHEARSAL_INGEST_DISK_GATE:-}` add:

```yaml
      # scripts/e2e-novelty-ingest.ts recreates the app with these (empty = the production defaults: one file at a time, novelty
      # check on, 20,000,000-row slabs).
      UPLOAD_CONCURRENCY: ${REHEARSAL_UPLOAD_CONCURRENCY:-}
      INGEST_NOVELTY_CHECK: ${REHEARSAL_INGEST_NOVELTY_CHECK:-}
      INGEST_NOVELTY_SLAB_ROWS: ${REHEARSAL_INGEST_NOVELTY_SLAB_ROWS:-}
```

- [ ] **Step 5: `.env.example` and the README**

In `/home/cole/ulp-suite/.env.example`, immediately after the line `# INGEST_DISK_GATE=off` add:

```
# ── Novelty-aware ingest ─────────────────────────────────────────────────────
# On by default. A file is parsed into a stage table in ClickHouse and only the credentials ulp.credentials does not hold
# yet are written (identified by content_key_hash, the key the nightly dedup uses). Every import reports how many rows
# were new, how many the database already held and how many repeated inside the file, and a retry never duplicates a row.
#   INGEST_NOVELTY_CHECK=off     import straight into ulp.credentials as before (rows already there are stored again)
#   INGEST_NOVELTY_SLAB_ROWS     rows per commit step, default 20000000, at least 1000
# INGEST_NOVELTY_CHECK=
# INGEST_NOVELTY_SLAB_ROWS=20000000
```

In `/home/cole/ulp-suite/README.md`, after the `IMPORT_STALL_TIMEOUT_MS` bullet (the one ending `not trip it. Default \`1200000\` (20 minutes).`) add:

```markdown
- `INGEST_NOVELTY_CHECK` — novelty-aware ingest, on by default (`lib/ingest-novelty.ts`,
  `docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md`). A file is parsed into a private
  stage table and only the credentials `ulp.credentials` does not hold yet are written; every import
  reports **new / already in the database / repeated in the file**, a finished file is remembered in
  `ulp.sources` even when it added nothing, and a retry never duplicates a row (`imported` now means new
  rows). A fully new file takes about 50% longer than the direct path; a file the database already
  holds costs the parse and one scan of one column. `off` imports straight into `ulp.credentials` as before.
- `INGEST_NOVELTY_SLAB_ROWS` — rows per commit step (default `20000000`, at least `1000`). Files below
  this are committed in one step; larger ones in hash slabs, one slab at a time across all imports.
```

and replace the table row `| Dedup Set cap | 2M entries → ~440 MB max (prevents OOM on huge files) |` with `| Dedup Set cap (direct path only) | 2M entries → ~440 MB max (prevents OOM on huge files); novelty-aware ingest dedups in the stage table, exactly, for any file size |`.

- [ ] **Step 6: Run the wiring test and the neighbouring structure tests**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/novelty-wiring.test.ts __tests__/rehearsal-isolation.test.ts __tests__/compose-hardening.test.ts 2>&1 | tail -14`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/cole/ulp-suite && git add instrumentation.ts docker-compose.yml docker-compose.rehearsal.yml .env.example README.md __tests__/novelty-wiring.test.ts && git commit -m "feat(ingest): sweep orphan stage tables at start-up, forward and document the novelty settings" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 13: The full gate

**Files:** none (fixes go where the failures point).

- [ ] **Step 1: Typecheck, lint, the whole suite**

Run:

```bash
cd /home/cole/ulp-suite && npx tsc --noEmit && npx next lint 2>&1 | tail -15 && npx vitest run 2>&1 | tail -8
```
Expected: tsc exit 0; lint prints no errors (warnings that already exist on `main` may remain: compare with `git stash -u; npx next lint; git stash pop` if in doubt); vitest: every file passes, with BASELINE files + 11 and more than BASELINE tests + 150.

- [ ] **Step 2: If anything fails, fix it where it lives**

Use the `superpowers:systematic-debugging` skill for any failure that is not an obvious typo. A failing existing suite that was not touched by this plan is a regression in this plan's code: fix the code, not the test, unless the test pins a response shape this plan changed on purpose (then change the expectation and say why in the commit).

- [ ] **Step 3: Commit any fixes**

```bash
cd /home/cole/ulp-suite && git add -A && git status --short && git commit -m "fix(ingest): <what the full gate found>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Skip this step when Step 1 was clean.

---

### Task 14: Live parity on real files, read-only on the real table

**Files:** none in the repository. The script lives in the session scratchpad; it imports the repository's own modules, so it exercises the code under test.

What it proves against the real 1.39B-row table without writing to it: the stage's hash agrees with the table's on real rows; the commit classifies rows known / new exactly as an independent natural-key lookup does; the commit settings (`max_execution_time` 3300, `insert_deduplicate` 0) reach the server through the real client; and `KILL QUERY` by id works against the real server. Nothing is written to `ulp.credentials`: the target of the commit is a throwaway clone (`ulp.zz_parity_target`, a plain-MergeTree copy of the live DDL) and the stage tables are dropped at the end.

- [ ] **Step 1: Pick three small real files and write the script**

The download pile is at `~/Downloads/AyuGram Desktop` (the operator's own data; never print or commit a file name). Choose three `.txt` files between 1 and 10 MiB:

```bash
find "$HOME/Downloads/AyuGram Desktop" -maxdepth 1 -type f -name '*.txt' -size +1M -size -10M | head -3
```

Create `parity.ts` in the scratchpad directory (the path printed by `echo $SCRATCH` in your session):

```ts
/**
 * Live parity check for novelty-aware ingest. Read-only on ulp.credentials: the commit writes to a throwaway clone.
 *   cd /home/cole/ulp-suite && CLICKHOUSE_HOST=http://<clickhouse container ip>:8123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD= \
 *     CLICKHOUSE_DATABASE=ulp INGEST_FILTER_HARD_DROP_TIERS=T3 INGEST_DISK_GATE=off npx tsx <scratch>/parity.ts <file> [<file> ...]
 */
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { getClient } from '/home/cole/ulp-suite/lib/clickhouse'
import { streamCredentialsToTable, UPLOAD_BATCH_SIZE } from '/home/cole/ulp-suite/lib/upload-processor'
import { clickhouseNoveltyDb, commitStage, newQueryId } from '/home/cole/ulp-suite/lib/ingest-novelty'
import { createStage, dropStage, newStageId, stageTables } from '/home/cole/ulp-suite/lib/ingest-stage'
import { makeHardDropPredicate, parseIngestPolicy, policyActive } from '/home/cole/ulp-suite/lib/ingest-filter'
import { URL_CONTENT_KEY } from '/home/cole/ulp-suite/lib/url-content-key'

const ch = getClient()
const db = clickhouseNoveltyDb()
const TARGET = 'ulp.zz_parity_target'
const SAMPLE = 'ulp.zz_parity_sample'
const rows = async <T = any>(query: string): Promise<T[]> =>
  (await (await ch.query({ query, format: 'JSONEachRow', clickhouse_settings: { use_query_cache: 0 } as any })).json()) as T[]
const one = async (q: string) => (await rows(q))[0]
let failed = false
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failed = true
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
}

async function cloneLive(): Promise<void> {
  const show = (await rows<{ statement: string }>(`SELECT create_table_query AS statement FROM system.tables WHERE database='ulp' AND name='credentials'`))[0].statement
  const ddl = show.replace(/^CREATE TABLE ulp\.credentials/, `CREATE TABLE ${TARGET}`).replace(/ENGINE = ReplicatedMergeTree\([^)]*\)/, 'ENGINE = MergeTree')
  if (!ddl.includes(TARGET) || /Replicated/.test(ddl)) throw new Error('clone rewrite failed')
  await ch.command({ query: `DROP TABLE IF EXISTS ${TARGET} SYNC` })
  await ch.command({ query: ddl })
}

async function serverSide(): Promise<void> {
  console.log('\nCommit settings and KILL QUERY against the real server')
  const ctl = new AbortController()
  const s = (await db.select<Record<string, unknown>>(
    `SELECT getSetting('max_execution_time') AS t, getSetting('insert_deduplicate') AS d, getSetting('async_insert') AS a, getSetting('use_query_cache') AS q`,
    { queryId: newQueryId(), signal: ctl.signal },
  ))[0]
  check('max_execution_time reaches the server as 3300 (the client default is 60)', Number(s.t) === 3300, JSON.stringify(s))
  check('insert_deduplicate, async_insert and use_query_cache reach the server as 0', [s.d, s.a, s.q].every(v => v === 0 || v === '0' || v === false), JSON.stringify(s))

  const id = newQueryId()
  const t0 = performance.now()
  const running = db.exec('SELECT sleepEachRow(1) FROM numbers(40) FORMAT Null', { queryId: id, signal: new AbortController().signal })
  running.catch(() => {})
  await new Promise(r => setTimeout(r, 2500))
  const before = Number((await one(`SELECT count() AS c FROM system.processes WHERE query_id = '${id}'`)).c)
  await db.kill(id)
  const settled = await Promise.race([running.then(() => 'finished', () => 'rejected'), new Promise<string>(r => setTimeout(() => r('hung'), 15_000))])
  const after = Number((await one(`SELECT count() AS c FROM system.processes WHERE query_id = '${id}'`)).c)
  check('KILL QUERY by id stops a running statement (it was running, now it is gone, well before its 40 s)', before === 1 && after === 0 && settled === 'rejected' && performance.now() - t0 < 20_000, `before ${before} after ${after} ${settled}`)

  const ctrl = new AbortController()
  const id2 = newQueryId()
  const longOne = db.exec('SELECT sleepEachRow(1) FROM numbers(25) FORMAT Null', { queryId: id2, signal: ctrl.signal })
  longOne.catch(() => {})
  await new Promise(r => setTimeout(r, 2000))
  ctrl.abort(new Error('stalled'))
  await new Promise(r => setTimeout(r, 2000))
  const stillRunning = Number((await one(`SELECT count() AS c FROM system.processes WHERE query_id = '${id2}'`)).c)
  console.log(`  INFO  after a client-side abort the statement is ${stillRunning === 1 ? 'STILL RUNNING on the server (so the kill is needed)' : 'gone from the server (the abort cancelled it)'}`)
  await db.kill(id2).catch(() => {})
  check('...and a KILL after the abort leaves nothing running', Number((await one(`SELECT count() AS c FROM system.processes WHERE query_id = '${id2}'`)).c) === 0)
}

async function parityForFile(index: number, path: string): Promise<void> {
  const size = statSync(path).size
  console.log(`\nFile #${index} (${(size / 1048576).toFixed(1)} MiB)`)
  await cloneLive()
  const tables = stageTables(newStageId())
  const policy = parseIngestPolicy()
  const soft = { ...policy, hardTiers: new Set<string>() }
  const ctl = new AbortController()
  try {
    await createStage(tables)
    const t0 = performance.now()
    const streamed = await streamCredentialsToTable(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, `parity-${index}.txt`, {
      table: tables.stage, batchSize: UPLOAD_BATCH_SIZE, filterOn: policyActive(soft), dropPolicy: soft,
      shouldHardDrop: makeHardDropPredicate(policy), dedupInFile: false, signal: ctl.signal,
    })
    const t1 = performance.now()
    const commit = await commitStage({
      tables, target: TARGET, noveltyAgainst: 'ulp.credentials', parsedRows: streamed.imported,
      slabRows: 20_000_000, signal: ctl.signal,
    })
    const t2 = performance.now()
    console.log(`  INFO  parsed ${commit.rows.toLocaleString()} rows (${((t1 - t0) / 1000).toFixed(1)} s), distinct ${commit.distinct.toLocaleString()}, known ${commit.known.toLocaleString()} (${(100 * commit.known / Math.max(1, commit.distinct)).toFixed(1)}%), new ${commit.inserted.toLocaleString()}, repeated in file ${commit.inFileDuplicates.toLocaleString()}, commit ${((t2 - t1) / 1000).toFixed(1)} s`)
    check('one slab, accounting adds up (rows = new + known + repeated)', commit.slabs === 1 && commit.rows === commit.inserted + commit.known + commit.inFileDuplicates)

    // A: the hash probe, done directly (no slabs, no known table)
    const direct = Number((await one(`SELECT uniqExact(content_key_hash) AS c FROM ${tables.stage} WHERE content_key_hash IN (SELECT content_key_hash FROM ulp.credentials)`)).c)
    check('known equals a direct hash probe of the whole stage', direct === commit.known, `commit ${commit.known} direct ${direct}`)

    // B: natural key, independent of the hash expression: the same (URL key, email, password) exists in the live table
    await ch.command({ query: `DROP TABLE IF EXISTS ${SAMPLE} SYNC` })
    await ch.command({
      query: `CREATE TABLE ${SAMPLE} ENGINE = Memory AS SELECT url, email, password, content_key_hash FROM
              (SELECT url, email, password, content_key_hash FROM ${tables.stage} LIMIT 1 BY content_key_hash) ORDER BY cityHash64(content_key_hash, 7) LIMIT 5000`,
    })
    const sample = await one(`
      SELECT count() AS n,
             countIf(content_key_hash IN (SELECT content_key_hash FROM ${tables.known})) AS by_hash,
             countIf((${URL_CONTENT_KEY}, email, password) IN (
               SELECT ${URL_CONTENT_KEY}, email, password FROM ulp.credentials WHERE email IN (SELECT email FROM ${SAMPLE}))) AS by_natural_key
      FROM ${SAMPLE}`)
    console.log(`  INFO  sample of ${sample.n}: ${sample.by_hash} known by hash, ${sample.by_natural_key} known by natural key`)
    check('the commit\\'s known/new split equals an independent natural-key lookup on a 5,000-row sample', Number(sample.by_hash) === Number(sample.by_natural_key), JSON.stringify(sample))

    // C: what the commit wrote is exactly the new rows, once each
    const written = await one(`SELECT count() AS c, uniqExact(content_key_hash) AS d FROM ${TARGET}`)
    check('the clone holds exactly the new rows, each once', Number(written.c) === commit.inserted && Number(written.d) === commit.inserted, JSON.stringify(written))
    // D: the target holds nothing the live table already had
    const overlap = Number((await one(`SELECT uniqExact(content_key_hash) AS c FROM ${TARGET} WHERE content_key_hash IN (SELECT content_key_hash FROM ulp.credentials)`)).c)
    check('...and none of them is in the live table', overlap === 0, `overlap ${overlap}`)
  } finally {
    await dropStage(tables).catch(() => {})
    await ch.command({ query: `DROP TABLE IF EXISTS ${SAMPLE} SYNC` }).catch(() => {})
    await ch.command({ query: `DROP TABLE IF EXISTS ${TARGET} SYNC` }).catch(() => {})
  }
}

async function main() {
  const before = Number((await one(`SELECT count() AS c FROM ulp.credentials`)).c)
  await serverSide()
  const files = process.argv.slice(2)
  for (let i = 0; i < files.length; i++) await parityForFile(i + 1, files[i])
  const after = Number((await one(`SELECT count() AS c FROM ulp.credentials`)).c)
  check('ulp.credentials was not written (same row count before and after)', before === after, `${before} -> ${after}`)
  const left = await rows(`SELECT name FROM system.tables WHERE database='ulp' AND (name LIKE 'zz_parity%' OR name LIKE 'zz_import_%')`)
  check('no scratch table is left behind', left.length === 0, JSON.stringify(left))
}

main().catch(err => { console.error('PARITY ERROR', err); failed = true }).finally(() => process.exit(failed ? 1 : 0))
```

- [ ] **Step 2: Run it**

```bash
cd /home/cole/ulp-suite && IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ulpsuite_clickhouse | awk '{print $1}') && CLICKHOUSE_HOST=http://$IP:8123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD= CLICKHOUSE_DATABASE=ulp INGEST_FILTER_HARD_DROP_TIERS=T3 INGEST_DISK_GATE=off npx tsx "$SCRATCH/parity.ts" <file1> <file2> <file3> 2>&1 | tail -40
```
Expected: every line `PASS`, exit 0. Each file takes seconds to a minute (the table scan is about 10 s). If the natural-key sample disagrees with the hash on any row, that is a finding about the data (rows whose URL differs only by something `URL_CONTENT_KEY` normalises differently from the parser), not a reason to relax the check: investigate before going on.

- [ ] **Step 3: Record the result**

Add the numbers (aggregate counts only: no file names, no values) to the spec's "Spike results" table as a new row "Live parity on 3 real files", and commit:

```bash
cd /home/cole/ulp-suite && git add docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md && git commit -m "docs(specs): live parity of the novelty commit on three real files" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: The rehearsal script

**Files:**
- Create: `/home/cole/ulp-suite/scripts/e2e-novelty-ingest.ts`

The unit tests use fakes. This script uses the production image, a real ClickHouse and a real process kill, in the isolated rehearsal stack (own ClickHouse, own volumes, own port; it shares nothing with the real stack). It follows `scripts/e2e-disk-gate.ts` and `scripts/e2e-upload-resilience.ts`.

- [ ] **Step 1: Write the script**

Create `/home/cole/ulp-suite/scripts/e2e-novelty-ingest.ts`:

```ts
/**
 * End-to-end check of novelty-aware ingest on the production image, against the ISOLATED rehearsal stack
 * (docker-compose.rehearsal.yml: its own ClickHouse, app and volumes; it shares nothing with the real stack).
 *
 * The unit tests use fakes. This uses real uploads, a real ClickHouse and a real process kill. Scenarios (keys for --only=):
 *   basic       a new file; the same content under a new name (0 new, the name remembered, a second upload of it skipped); a
 *               half-overlap file; a file with repeated lines; a ZIP with a new and a known entry; a file dropped in the inbox
 *   monitor     a monitor alerts for rows that are new to the database, not for a row the database already held
 *   big         2.5M distinct lines + 100k repeats of early lines (past the old 2M in-file cap): exact, in 5 slabs, phases visible
 *   kill        the app is killed in the middle of the commit; after the restart the orphan stage tables are gone and a retry
 *               adds exactly the rows that were missing (no duplicates)
 *   concurrent  UPLOAD_CONCURRENCY=2, two files that share 30,000 rows: written once
 *   gate        free disk under the ingest floor while staging: the import waits (its stage exists), resumes, writes each row once
 *   off         INGEST_NOVELTY_CHECK=off: the direct path, no stage tables, rows stored again as before
 *
 *   docker compose build app
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the rehearsal stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-novelty-ingest.ts            # about 15 minutes; --only=kill,off runs just those; --skip-gate leaves out the filler
 *   docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
 *
 * Needs `zip` and `curl`, and about 40 GiB of free host disk for the gate scenario. Exit 0 when every check passes, 1 when one
 * fails, 2 when the stack is not ready or there is not enough room to run.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const RECEIVER = 'ulprehearsal_receiver'
const PROJECT = 'ulp-rehearsal'
const COMPOSE_FILE = 'docker-compose.rehearsal.yml'
const BASE = 'http://127.0.0.1:3101'
const GiB = 1024 ** 3
const FILLER = '/var/lib/clickhouse/zz_novelty_filler'
const BRAND = 'novelty-brand.test'

if (![APP, CH, RECEIVER].every(n => n.startsWith('ulprehearsal_'))) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

const onlyArg = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length).split(',')
const want = (key: string) => !onlyArg || onlyArg.includes(key)
const skipGate = process.argv.includes('--skip-gate')

const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}

const info = (label: string, value: unknown) => console.log(`  INFO  ${label}: ${value}`)

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-4).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

// --async_insert=0: the default profile buffers inserts, and this script reads what was written straight away.
const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', sql])
const inList = (names: string[]) => names.map(n => `'${n}'`).join(', ')
const rowsFor = (...names: string[]) => Number(chQuery(`SELECT count() FROM ulp.credentials WHERE source_file IN (${inList(names)})`))
const distinctFor = (...names: string[]) => Number(chQuery(`SELECT uniqExact(content_key_hash) FROM ulp.credentials WHERE source_file IN (${inList(names)})`))
const sourceLine = (name: string) => chQuery(`SELECT line_count FROM ulp.sources WHERE filename = '${name}'`)
const stageTableCount = () => Number(chQuery("SELECT count() FROM system.tables WHERE database = 'ulp' AND name LIKE 'zz_import_%'"))
const freeBytes = () => Number(chQuery("SELECT unreserved_space FROM system.disks WHERE name = 'default'"))
const appLog = () => {
  const r = spawnSync('docker', ['logs', APP], { encoding: 'utf8', maxBuffer: 256 << 20 })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}
const receiverLines = (): Array<Record<string, any>> =>
  sh('docker', ['logs', RECEIVER]).split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 500): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      /* not yet */
    }
    await sleep(intervalMs)
  }
  return null
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const RUN = Date.now().toString(36) // source names are unique per run: the importer skips a name it has already imported
const work = mkdtempSync(join(tmpdir(), 'e2e-novelty-'))
const dockerCfg = mkdtempSync(join(tmpdir(), 'e2e-novelty-docker-'))
writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop's global Docker config has a broken credsStore

const line = (tag: string, i: number) => `https://shop${i % 500}.example-store.test/login:${tag}${i}@probe-mail.test:Pw-${tag}${i}-Xy!`
const lines = (tag: string, from: number, to: number) => Array.from({ length: to - from }, (_, k) => line(tag, from + k))
const text = (ls: string[]) => ls.join('\n') + '\n'
const fixture = (name: string, ls: string[]) => {
  const path = join(work, name)
  writeFileSync(path, text(ls))
  return path
}

function writeBig(path: string, tag: string, distinct: number, repeats: number): void {
  writeFileSync(path, '')
  const CHUNK = 100_000
  for (let from = 0; from < distinct; from += CHUNK) appendFileSync(path, text(lines(tag, from, Math.min(distinct, from + CHUNK))))
  appendFileSync(path, text(lines(tag, 0, repeats)))
}

// ── the app: secrets, login, API ────────────────────────────────────────────────────────────────
let secrets = { jwt: '', email: '', password: '' }
let cookie = ''

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: secrets.email, password: secrets.password }),
  })
  const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
  const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
  if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
  cookie = `auth=${auth}`
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* not JSON */
  }
  return { status: res.status, json }
}

interface AppSettings { concurrency?: string; novelty?: string; slab?: string; floorBytes?: number }

/** Looks for an accounting failure in the log of the container that is about to be replaced (its log goes with it). */
function scanLog(label: string): void {
  let log = ''
  try {
    log = appLog()
  } catch {
    return
  }
  check(`${label}: no accounting error in the app log`, !/NoveltyAccountingError|written-rows|accounting/i.test(log))
}

/** Recreates only the rehearsal app, keeping its data volume and its secrets. */
async function recreateApp(s: AppSettings = {}): Promise<boolean> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOCKER_CONFIG: dockerCfg,
    REHEARSAL_JWT_SECRET: secrets.jwt,
    REHEARSAL_ADMIN_EMAIL: secrets.email,
    REHEARSAL_ADMIN_PASSWORD: secrets.password,
    REHEARSAL_WEBHOOK_SECRET: 'unused-here', // the compose file interpolates it; the receiver is not touched
    REHEARSAL_UPLOAD_CONCURRENCY: s.concurrency ?? '',
    REHEARSAL_INGEST_NOVELTY_CHECK: s.novelty ?? '',
    REHEARSAL_INGEST_NOVELTY_SLAB_ROWS: s.slab ?? '',
    REHEARSAL_INGEST_MIN_FREE_BYTES: s.floorBytes === undefined ? '' : String(s.floorBytes),
    REHEARSAL_INGEST_DISK_GATE: '',
  }
  sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, 'up', '-d', '--no-deps', '--force-recreate', 'app'], env)
  const up = await waitFor(() => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy', 300_000, 2000)
  if (!up) return false
  await login()
  return true
}

// ── uploads and jobs ────────────────────────────────────────────────────────────────────────────
/** POST a file with curl. The body is received into the spool before the server answers, so a text upload returns quickly. */
function upload(name: string, path: string): { status: number; body: string; jobId: string | null } {
  const out = sh('curl', [
    '-sS', '-m', '900', '-w', '\n%{http_code}', '-X', 'POST',
    '-H', `cookie: ${cookie}`, '-H', 'content-type: application/octet-stream',
    '--data-binary', `@${path}`, `${BASE}/api/upload?filename=${encodeURIComponent(name)}`,
  ])
  const parts = out.split('\n')
  const status = Number(parts.pop())
  const body = parts.join('\n')
  return { status, body, jobId: /"jobId":"([^"]+)"/.exec(body)?.[1] ?? null }
}

interface JobEvent {
  status: string
  imported?: number
  known?: number
  inFileDuplicates?: number
  skipped?: number
  phase?: string
  staged?: number
  slab?: number
  slabs?: number
  error?: string
}

/** One SSE frame for the job (a finished job answers at once; a running one pushes a frame every 2 s). */
async function jobSnapshot(jobId: string, waitMs = 4500): Promise<JobEvent> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), waitMs)
  try {
    const res = await fetch(`${BASE}/api/upload/progress/${jobId}`, { headers: { cookie }, signal: controller.signal })
    if (res.status !== 200 || !res.body) return { status: `http-${res.status}` }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) return { status: 'stream-closed' }
      buffer += decoder.decode(value, { stream: true })
      const frame = /^data: (.*)$/m.exec(buffer)
      if (frame) {
        controller.abort()
        return JSON.parse(frame[1]) as JobEvent
      }
    }
  } catch {
    return { status: 'no-event' }
  } finally {
    clearTimeout(timer)
  }
}

async function waitJob(jobId: string, timeoutMs: number, onEvent?: (e: JobEvent) => void): Promise<JobEvent> {
  const end = Date.now() + timeoutMs
  let last: JobEvent = { status: 'no-event' }
  while (Date.now() < end) {
    last = await jobSnapshot(jobId)
    onEvent?.(last)
    if (last.status === 'done' || last.status === 'error') return last
    await sleep(1000)
  }
  return last
}

async function importPath(name: string, path: string, timeoutMs = 300_000, onEvent?: (e: JobEvent) => void): Promise<JobEvent> {
  const up = upload(name, path)
  if (up.status !== 200 || !up.jobId) return { status: `http-${up.status}`, error: up.body.slice(0, 200) }
  return waitJob(up.jobId, timeoutMs, onEvent)
}

const importLines = (name: string, ls: string[], timeoutMs?: number) => importPath(name, fixture(name, ls), timeoutMs)
const brief = (e: JobEvent) => JSON.stringify({ status: e.status, imported: e.imported, known: e.known, dup: e.inFileDuplicates, skipped: e.skipped, error: e.error })

// ── scenarios ───────────────────────────────────────────────────────────────────────────────────
async function basic(): Promise<void> {
  console.log('\n1. Files through the HTTP upload and the inbox')
  const A = `e2e-nov-a-${RUN}.txt`
  const B = `e2e-nov-b-${RUN}.txt`
  const C = `e2e-nov-c-${RUN}.txt`
  const D = `e2e-nov-d-${RUN}.txt`

  const a = await importLines(A, lines('A', 0, 20_000))
  check('a new file: 20000 new, none known, none repeated', a.status === 'done' && a.imported === 20_000 && a.known === 0 && a.inFileDuplicates === 0, brief(a))
  check('...all 20000 rows are in ClickHouse', rowsFor(A) === 20_000, `rows ${rowsFor(A)}`)
  check('...the file is remembered in ulp.sources with its 20000 rows', sourceLine(A) === '20000', sourceLine(A))
  check('...and no stage table is left behind', stageTableCount() === 0, `tables ${stageTableCount()}`)

  const b = await importLines(B, lines('A', 0, 20_000))
  check('the same content under another name: 0 new, 20000 already known', b.status === 'done' && b.imported === 0 && b.known === 20_000, brief(b))
  check('...nothing was stored twice', rowsFor(B) === 0 && distinctFor(A, B) === 20_000, `rows ${rowsFor(B)}, distinct ${distinctFor(A, B)}`)
  check('...the second name is remembered too, with 0 rows', sourceLine(B) === '0', `[${sourceLine(B)}]`)
  const b2 = await importLines(B, lines('A', 0, 20_000))
  check('...and uploading that name again is skipped by the same-name guard', b2.status === 'done' && b2.imported === 0 && b2.known === 0 && sourceLine(B) === '0', brief(b2))

  const c = await importLines(C, [...lines('A', 0, 10_000), ...lines('C', 0, 10_000)])
  check('a half-overlap file: 10000 new, 10000 already known', c.status === 'done' && c.imported === 10_000 && c.known === 10_000, brief(c))
  check('...only the new half was stored', rowsFor(C) === 10_000 && distinctFor(A, B, C) === 30_000, `rows ${rowsFor(C)}, distinct ${distinctFor(A, B, C)}`)

  const repeated = lines('D', 0, 5_000)
  const d = await importLines(D, [...repeated, ...repeated, ...repeated])
  check('a file of 5000 lines repeated three times: 5000 new, 10000 repeats, none known', d.status === 'done' && d.imported === 5_000 && d.inFileDuplicates === 10_000 && d.known === 0, brief(d))
  check('...5000 rows stored', rowsFor(D) === 5_000, `rows ${rowsFor(D)}`)

  const z1 = `e2e-nov-z1-${RUN}.txt`
  const z2 = `e2e-nov-z2-${RUN}.txt`
  const zipPath = join(work, `e2e-nov-${RUN}.zip`)
  sh('zip', ['-j', '-q', zipPath, fixture(z1, lines('Z', 0, 3_000)), fixture(z2, lines('A', 0, 5_000))])
  const zip = upload(`e2e-nov-${RUN}.zip`, zipPath)
  let zipJson: any = null
  try {
    zipJson = JSON.parse(zip.body)
  } catch {
    /* reported below */
  }
  check('a ZIP with a new and a known entry: 3000 new, 5000 known', zip.status === 200 && zipJson?.imported === 3_000 && zipJson?.known === 5_000, zip.body.slice(0, 200))
  check('...both entries are listed, the known one with 0 new rows',
    zipJson?.files?.length === 2 && zipJson.files.some((f: any) => f.filename === z2 && f.imported === 0 && f.known === 5_000), JSON.stringify(zipJson?.files))
  check('...and both entries are remembered', sourceLine(z1) === '3000' && sourceLine(z2) === '0', `[${sourceLine(z1)}] [${sourceLine(z2)}]`)

  const N = `e2e-nov-inbox-${RUN}.txt`
  sh('docker', ['exec', '-i', APP, 'sh', '-c', `cat > /app/inbox/${N}`], process.env, text([...lines('A', 0, 3_000), ...lines('N', 0, 5_000)]))
  const done = await waitFor(async () => {
    const status = await api('GET', '/api/inbox/status')
    return (status.json?.done_recent ?? []).find((r: any) => r.filename === N && (r.status === 'done' || r.status === 'failed'))
  }, 180_000, 2000)
  check('a file dropped in the inbox is processed: 5000 new, 3000 known in the job log', !!done && done.status === 'done' && done.imported === 5_000 && done.known === 3_000, JSON.stringify(done))
  check('...its rows are in ClickHouse once', rowsFor(N) === 5_000 && sourceLine(N) === '5000', `rows ${rowsFor(N)}`)
  const queue = await api('GET', '/api/upload/queue-status')
  check('the queue status totals the known rows', (queue.json?.totals?.rows_known ?? 0) >= 28_000, JSON.stringify(queue.json?.totals))
  check('no stage table is left after all of it', stageTableCount() === 0, `tables ${stageTableCount()}`)
}

async function monitorScenario(): Promise<void> {
  console.log('\n2. A monitor alerts for the rows that are new to the database')
  const hook = await api('POST', '/api/monitoring/webhooks', { name: `Novelty Receiver ${RUN}`, url: `http://${RECEIVER}:9000/hook`, secret: 'rehearsal' })
  const hookId = hook.json?.data?.id as number | undefined
  if (!check('a webhook to the receiver is accepted', hook.status === 200 && !!hookId, `status ${hook.status}: ${hook.json?.error ?? ''}`)) return
  const mon = await api('POST', '/api/monitoring/monitors', {
    name: `Novelty Monitor ${RUN}`, domains: [BRAND], match_mode: 'both', webhook_ids: [hookId], rescan_mode: 'dedup', rescan_interval_hours: 1,
  })
  if (!check('a monitor on the synthetic brand domain is created', mon.status === 200 && !!mon.json?.data?.id, `status ${mon.status}`)) return

  // A row the database holds but this monitor has never seen: it did not come through the importer.
  chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file) VALUES ('https://${BRAND}/login', 'quiet-${RUN}@${BRAND}', 'Pw-quiet-Xy!', '${BRAND}', 'e2e-nov-direct-${RUN}.txt')`)
  const name = `e2e-nov-mon-${RUN}.txt`
  const ev = await importLines(name, [
    `https://${BRAND}/login:quiet-${RUN}@${BRAND}:Pw-quiet-Xy!`,
    `https://${BRAND}/login:fresh-${RUN}@${BRAND}:Pw-fresh-Xy!`,
    ...lines('M', 0, 50),
  ])
  check('the file imported: 51 new, 1 known (the row the database already held)', ev.status === 'done' && ev.imported === 51 && ev.known === 1, brief(ev))
  const alert = await waitFor(() => receiverLines().find(l => l.source_file === name), 90_000, 2000)
  check('the monitor alerted for the file', !!alert)
  check('...for the new row only (the row the database already held did not alert)',
    alert?.total_matches === 1 && alert.match_emails?.length === 1 && alert.match_emails[0] === `fresh-${RUN}@${BRAND}`, JSON.stringify(alert))
}

async function bigFile(): Promise<void> {
  console.log('\n3. A file past the old 2,000,000-entry in-file cap, in slabs of 500,000')
  scanLog('before the big file')
  if (!check('the rehearsal app restarted with 500000-row slabs', await recreateApp({ slab: '500000' }))) return
  const name = `e2e-nov-big-${RUN}.txt`
  const path = join(work, name)
  writeBig(path, 'B', 2_500_000, 100_000)
  const phases = new Set<string>()
  const ev = await importPath(name, path, 900_000, e => { if (e.phase) phases.add(e.phase) })
  check('2,500,000 new rows', ev.status === 'done' && ev.imported === 2_500_000, brief(ev))
  check('100,000 repeats of early lines were counted as repeats (the old per-file Set stopped at 2M entries)', ev.inFileDuplicates === 100_000 && ev.known === 0, brief(ev))
  check('...stored exactly once each', rowsFor(name) === 2_500_000 && distinctFor(name) === 2_500_000, `rows ${rowsFor(name)}, distinct ${distinctFor(name)}`)
  check('it was committed in 5 slabs', ev.slabs === 5, `slabs ${ev.slabs}`)
  check('the phases were visible while it ran: reading, then checking or writing', phases.has('parsing') && (phases.has('checking') || phases.has('inserting')), [...phases].join(','))
  check('no stage table is left', stageTableCount() === 0)
}

async function killMidCommit(): Promise<void> {
  console.log('\n4. The app is killed in the middle of the commit')
  scanLog('before the kill scenario')
  if (!check('the rehearsal app restarted with 1000-row slabs', await recreateApp({ slab: '1000' }))) return
  const name = `e2e-nov-kill-${RUN}.txt`
  const path = fixture(name, lines('K', 0, 120_000))
  const up = upload(name, path)
  check('the upload was accepted', up.status === 200 && !!up.jobId, `HTTP ${up.status}`)
  const midway = await waitFor(() => { const n = rowsFor(name); return n >= 3_000 && n < 100_000 ? n : 0 }, 240_000, 300)
  check('the commit was under way: some rows written, not all', !!midway, `rows ${rowsFor(name)}`)
  check('...and its stage tables exist', stageTableCount() === 2, `tables ${stageTableCount()}`)
  sh('docker', ['kill', APP])
  await sleep(10_000) // a statement the dead client left running finishes
  const before = rowsFor(name)
  info('rows written when the app was killed', before)
  check('the interrupted import wrote only part of the file', before > 0 && before < 120_000, `rows ${before}`)
  check('nothing has dropped the orphan stage tables yet', stageTableCount() === 2, `tables ${stageTableCount()}`)
  check('the file is not remembered as imported', sourceLine(name) === '', `[${sourceLine(name)}]`)

  if (!check('the app started again', await recreateApp({ slab: '1000' }))) return
  const swept = await waitFor(() => stageTableCount() === 0, 90_000, 1000)
  check('the start-up sweep dropped the orphan stage tables', !!swept, `tables ${stageTableCount()}`)
  check('the log says so', /\[ingest-stage\] dropped 2 orphan stage table/.test(appLog()))

  const again = await importPath(name, path)
  check('a retry of the same file adds exactly the rows that were missing', again.status === 'done' && again.imported === 120_000 - before, `${brief(again)} (before ${before})`)
  check('...and counts the rows that had been written as known', again.known === before, `known ${again.known}, before ${before}`)
  check('every row is there exactly once', rowsFor(name) === 120_000 && distinctFor(name) === 120_000, `rows ${rowsFor(name)}, distinct ${distinctFor(name)}`)
  check('now the file is remembered, with the rows the retry added', sourceLine(name) === String(120_000 - before), `[${sourceLine(name)}]`)
}

async function concurrentFiles(): Promise<void> {
  console.log('\n5. Two files at once (UPLOAD_CONCURRENCY=2) that share 30,000 rows')
  scanLog('before the concurrent scenario')
  if (!check('the rehearsal app restarted with concurrency 2', await recreateApp({ concurrency: '2' }))) return
  const shared = lines('S', 0, 30_000)
  const g = `e2e-nov-g-${RUN}.txt`
  const h = `e2e-nov-h-${RUN}.txt`
  const upG = upload(g, fixture(g, [...shared, ...lines('G', 0, 10_000)]))
  const upH = upload(h, fixture(h, [...shared, ...lines('H', 0, 10_000)]))
  const [evG, evH] = await Promise.all([waitJob(upG.jobId ?? '', 300_000), waitJob(upH.jobId ?? '', 300_000)])
  check('both imports finished', evG.status === 'done' && evH.status === 'done', `${brief(evG)} ${brief(evH)}`)
  check('together they wrote 50,000 new rows: the shared 30,000 once', (evG.imported ?? 0) + (evH.imported ?? 0) === 50_000, `${evG.imported} + ${evH.imported}`)
  check('...and one of them counted the shared rows as known', (evG.known ?? 0) + (evH.known ?? 0) === 30_000, `${evG.known} + ${evH.known}`)
  check('ClickHouse holds 50,000 rows, all distinct', rowsFor(g, h) === 50_000 && distinctFor(g, h) === 50_000, `rows ${rowsFor(g, h)}, distinct ${distinctFor(g, h)}`)
}

async function gateScenario(): Promise<boolean> {
  console.log('\n6. Free disk under the ingest floor while staging')
  scanLog('before the gate scenario')
  const start = freeBytes()
  const floor = Math.floor(((start - 2 * GiB) * 10) / 11) // the resume level (floor x 1.1) sits 2 GiB under the free space now
  const fillerBytes = start - floor + GiB
  info('free space / floor / filler', `${(start / GiB).toFixed(1)} / ${(floor / GiB).toFixed(1)} / ${(fillerBytes / GiB).toFixed(1)} GiB`)
  if (start - fillerBytes < 20 * GiB) {
    console.error('Not enough free host disk space to run the gate scenario safely (it would leave less than 20 GiB).')
    return false
  }
  if (!check('the rehearsal app restarted with the test floor', await recreateApp({ floorBytes: floor }))) return true
  try {
    const mib = Math.ceil(fillerBytes / (1024 * 1024))
    try {
      sh('docker', ['exec', CH, 'fallocate', '-l', `${mib}M`, FILLER])
    } catch {
      sh('docker', ['exec', CH, 'sh', '-c', `dd if=/dev/zero of=${FILLER} bs=1M count=${mib} 2>/dev/null`])
    }
    check('free space is now under the floor', !!(await waitFor(() => freeBytes() < floor, 60_000, 500)), `free ${freeBytes()} floor ${floor}`)
    await sleep(6_000) // the gate reuses a free-space reading younger than 5 s
    const name = `e2e-nov-gate-${RUN}.txt`
    const up = upload(name, fixture(name, lines('P', 0, 20_000)))
    check('the upload was accepted', up.status === 200 && !!up.jobId, `HTTP ${up.status}`)
    const paused = await waitFor(async () => (await api('GET', '/api/monitoring/disk')).json?.gate?.paused === true, 60_000)
    check('the gate paused the import', !!paused)
    check('...its stage tables already exist (created before the first batch)', stageTableCount() === 2, `tables ${stageTableCount()}`)
    await sleep(40_000) // longer than the rehearsal's 30 s stall timeout: only the gate's heartbeat keeps the job alive
    const during = up.jobId ? await jobSnapshot(up.jobId) : { status: 'none' }
    check('after 40 s the job is still waiting, not failed and not finished', during.status === 'running', JSON.stringify(during))
    check('nothing reached the real table meanwhile', rowsFor(name) === 0, `rows ${rowsFor(name)}`)
    try {
      sh('docker', ['exec', CH, 'rm', '-f', FILLER])
    } catch {
      /* reported by the next check */
    }
    const final = up.jobId ? await waitJob(up.jobId, 240_000) : null
    check('the filler is removed: the import finishes by itself, 20000 new rows', final?.status === 'done' && final.imported === 20_000, JSON.stringify(final))
    check('...each row exactly once', rowsFor(name) === 20_000 && distinctFor(name) === 20_000, `rows ${rowsFor(name)}`)
    check('...and the stage tables are gone', stageTableCount() === 0, `tables ${stageTableCount()}`)
  } finally {
    try {
      sh('docker', ['exec', CH, 'rm', '-f', FILLER])
    } catch {
      /* already gone */
    }
  }
  return true
}

async function directPath(): Promise<void> {
  console.log('\n7. INGEST_NOVELTY_CHECK=off keeps the direct path')
  scanLog('before the direct-path scenario')
  if (!check('the rehearsal app restarted with the novelty check off', await recreateApp({ novelty: 'off' }))) return
  const X = `e2e-nov-off-x-${RUN}.txt`
  const Y = `e2e-nov-off-y-${RUN}.txt`
  const x = await importLines(X, lines('O', 0, 2_000))
  const y = await importLines(Y, lines('O', 0, 2_000))
  check('both copies are imported in full: 2000 rows each, nothing known', x.imported === 2_000 && y.imported === 2_000 && (y.known ?? 0) === 0, `${brief(x)} ${brief(y)}`)
  check('...so the same content is stored twice, as before the feature', rowsFor(X, Y) === 4_000 && distinctFor(X, Y) === 2_000, `rows ${rowsFor(X, Y)}, distinct ${distinctFor(X, Y)}`)
  check('no stage table was created', stageTableCount() === 0)
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
async function run(): Promise<number> {
  for (const container of [APP, CH, RECEIVER]) {
    let state = ''
    try {
      state = sh('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container])
    } catch {
      /* missing */
    }
    if (state !== 'healthy' && state !== 'running') {
      console.error(`${container} is not running. Start the rehearsal stack first:\n  npx tsx scripts/e2e-alert-rehearsal.ts --keep`)
      return 2
    }
  }
  secrets = {
    jwt: sh('docker', ['exec', APP, 'printenv', 'JWT_SECRET']),
    email: sh('docker', ['exec', APP, 'printenv', 'ADMIN_EMAIL']),
    password: sh('docker', ['exec', APP, 'printenv', 'ADMIN_PASSWORD']),
  }
  scanLog('at the start')
  if (!check('the rehearsal app restarted with the production defaults', await recreateApp())) return 1
  const probe = await api('GET', '/api/inbox/status')
  if (!check('the inbox status endpoint answers (the image is current: `docker compose build app`)', probe.status === 200, `HTTP ${probe.status}`)) return 2

  if (want('basic')) await basic()
  if (want('monitor')) await monitorScenario()
  if (want('big')) await bigFile()
  if (want('kill')) await killMidCommit()
  if (want('concurrent')) await concurrentFiles()
  if (want('gate') && !skipGate && !(await gateScenario())) return 2
  if (want('off')) await directPath()

  scanLog('at the end')
  await recreateApp() // leave the stack on the production defaults
  return 0
}

async function main(): Promise<number> {
  process.on('SIGINT', () => {
    try {
      sh('docker', ['exec', CH, 'rm', '-f', FILLER])
    } catch {
      /* nothing to remove */
    }
    process.exit(130)
  })
  let code = 1
  try {
    code = await run()
  } catch (err) {
    check('the scenarios ran without an unexpected error', false, err instanceof Error ? err.message : String(err))
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(dockerCfg, { recursive: true, force: true })
  }
  if (code === 2) return 2
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`)
  return failed.length === 0 && code === 0 ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err)
    process.exit(2)
  },
)
```

- [ ] **Step 2: Typecheck it**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit`
Expected: exit 0 (the repository's `tsconfig.json` includes `scripts/`; if it does not, run `npx tsc --noEmit --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --types node scripts/e2e-novelty-ingest.ts`).

- [ ] **Step 3: Commit**

```bash
cd /home/cole/ulp-suite && git add scripts/e2e-novelty-ingest.ts && git commit -m "test(e2e): rehearse novelty-aware ingest on the production image (real uploads, a real kill, a real disk filler)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: The image and the rehearsals

**Files:** none (fixes go where the failures point).

- [ ] **Step 1: Keep a rollback tag of the image that is deployed now**

```bash
cd /home/cole/ulp-suite && docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep '^ulp-suite-app:latest' && docker tag ulp-suite-app:latest ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz) && docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep rollback | head -3
```
Expected: `latest` is `7a0c098486cd` (SP1) and a new `rollback-20261011-....z` tag shows the same id. Write the tag name down for Task 18.

- [ ] **Step 2: Build the image**

```bash
mkdir -p "$SCRATCH/docker-cfg" && echo '{}' > "$SCRATCH/docker-cfg/config.json" && cd /home/cole/ulp-suite && DOCKER_CONFIG="$SCRATCH/docker-cfg" docker compose build app 2>&1 | tail -15
```
Expected: the build succeeds (the first minutes compile Next.js). `docker images ulp-suite-app:latest` shows a new id. (`$SCRATCH` is the session scratchpad directory.)

- [ ] **Step 3: The existing rehearsals must still pass**

```bash
cd /home/cole/ulp-suite && DOCKER_CONFIG="$SCRATCH/docker-cfg" npx tsx scripts/e2e-alert-rehearsal.ts --keep 2>&1 | tail -60
```
Expected: every check PASS (36 when this plan was written), exit 0, and the stack left running. Then:

```bash
cd /home/cole/ulp-suite && npx tsx scripts/e2e-upload-resilience.ts 2>&1 | tail -50
```
Expected: every check PASS (33), about 6 minutes. Then:

```bash
cd /home/cole/ulp-suite && npx tsx scripts/e2e-disk-gate.ts 2>&1 | tail -40
```
Expected: every check PASS (20), about 5 minutes.

Watch for two kinds of difference, which are about the novelty path being on by default and not about a defect in these scripts: a scenario that freezes ClickHouse for longer than the 30 s stall timeout now also exercises the commit's `KILL` on the way out; and a scenario that counts rows by `source_file` is unaffected because new content is still written. If one of these scripts fails, use the `superpowers:systematic-debugging` skill to find the cause before touching the script.

- [ ] **Step 4: The new rehearsal**

```bash
cd /home/cole/ulp-suite && npx tsx scripts/e2e-novelty-ingest.ts 2>&1 | tee "$SCRATCH/e2e-novelty.log" | tail -120
```
Expected: every check PASS, exit 0, about 15 minutes. The first run of a new rehearsal usually finds something (the 2026-10-04 rehearsal found two ClickHouse bugs that mocked tests had passed): treat each FAIL as a real finding. Fix it where it lives, with a unit test where one can reproduce it, rebuild the image (Step 2), and re-run only the scenario with `--only=<key>`, then the whole script once more at the end.

- [ ] **Step 5: Tear the rehearsal stack down**

```bash
cd /home/cole/ulp-suite && DOCKER_CONFIG="$SCRATCH/docker-cfg" docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v 2>&1 | tail -5
```
Expected: the `ulprehearsal_*` containers and volumes are removed (the real `ulpsuite_*` containers are untouched: `docker ps` still shows them healthy).

- [ ] **Step 6: Commit any fixes the rehearsals led to**

```bash
cd /home/cole/ulp-suite && git add -A && git status --short && git commit -m "fix(ingest): <what the rehearsal found>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Skip when there was nothing to fix.

---

### Task 17: Sync the documents, merge, push

**Files:**
- Modify: `/home/cole/ulp-suite/docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md`
- Modify: `/home/cole/ulp-suite/docs/superpowers/plans/2026-10-11-novelty-aware-ingest.md` (tick the steps that were done; note what the build changed)

- [ ] **Step 1: Bring the spec up to what was built**

In the spec: change the `Status:` line to `**implemented 2026-10-11**`; replace the two paragraphs of "Pieces" that no longer match with the real file list (`lib/ingest-novelty-config.ts`, `lib/ingest-stage.ts`, `lib/ingest-novelty.ts`, `lib/inbox-progress.ts`, `lib/import-summary.ts`, `scripts/e2e-novelty-ingest.ts`); in "Verification plan" item 3 replace "must equal what the 2026-10-11 probe computes for the same rows" with "must equal an independent natural-key lookup on a 5,000-row sample (the probe's own script was not kept)"; add the rehearsal's results (counts of checks, anything it found) as a short "What the rehearsal found" paragraph. Keep every number aggregate: no file names, no values.

- [ ] **Step 2: Tick the plan and note the deltas**

```bash
cd /home/cole/ulp-suite && sed -i 's/^- \[ \] \*\*Step/- [x] **Step/' docs/superpowers/plans/2026-10-11-novelty-aware-ingest.md && grep -c '^- \[ \]' docs/superpowers/plans/2026-10-11-novelty-aware-ingest.md
```
Expected: `0`, or only the steps of Tasks 17-18 that are still to be done (tick those as they finish). Add a short "What the build changed" section at the end of the plan listing every place where the code differs from the blocks above (as the disk-safety plan did).

- [ ] **Step 3: Last full gate**

Run: `cd /home/cole/ulp-suite && npx tsc --noEmit && npx next lint 2>&1 | tail -5 && npx vitest run 2>&1 | tail -6`
Expected: tsc 0, lint clean, every test file passes.

- [ ] **Step 4: Commit, fast-forward main, push**

```bash
cd /home/cole/ulp-suite && git add -A && git commit -m "docs: mark novelty-aware ingest implemented and record what the build and the rehearsal found" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git switch main && git merge --ff-only sp2-novelty-aware-ingest && git push origin main && git log --oneline -3
```
Expected: the fast-forward succeeds and the push is accepted. If `origin/main` moved meanwhile, stop and merge it into the branch first.

- [ ] **Step 5: CI**

Run: `cd /home/cole/ulp-suite && sleep 90 && gh run list --limit 2`
Expected: the latest run for this push is `completed` and `success`. If it is still running, check again after a minute; if it fails, read it with `gh run view --log-failed`.

---

### Task 18: Deploy, verify, record

**Files:**
- Modify: `/home/cole/ulp-suite/.env` (one line; not tracked)
- Modify: the project memory notes

Deploying is local-only on this laptop and was part of the approval ("build, rehearse and deploy it inline"). Do not import the download pile as part of this task: that is a separate step the operator decides.

- [ ] **Step 1: Pre-flight**

```bash
cd /home/cole/ulp-suite && git status -sb && git log --oneline -1 && df -h / | tail -1 && docker ps --format '{{.Names}} {{.Status}}' | grep ulpsuite && grep -n '^CONTENT_DEDUP_APPLY=' .env && docker images ulp-suite-app --format '{{.Tag}} {{.ID}}'
```
Expected: clean `main` at the merged commit; at least 100 GiB free; both `ulpsuite_*` containers healthy; `.env` shows `CONTENT_DEDUP_APPLY=true` (the value to change); the images list shows `latest`, the rollback tag from Task 16 and the older ones.

- [ ] **Step 2: Rebuild so that the image is exactly `main`**

```bash
cd /home/cole/ulp-suite && DOCKER_CONFIG="$SCRATCH/docker-cfg" docker compose build app 2>&1 | tail -6 && docker images ulp-suite-app:latest --format '{{.ID}} {{.CreatedSince}}'
```
Expected: a successful build (cached layers make it quick when nothing changed since Task 16).

- [ ] **Step 3: Decision D6, then recreate only the app**

```bash
cd /home/cole/ulp-suite && sed -i 's/^CONTENT_DEDUP_APPLY=.*/CONTENT_DEDUP_APPLY=false/' .env && grep -n '^CONTENT_DEDUP_APPLY=' .env && DOCKER_CONFIG="$SCRATCH/docker-cfg" docker compose up -d --no-deps app 2>&1 | tail -5
```
Expected: `CONTENT_DEDUP_APPLY=false` (it was `true`), and only `ulpsuite_app` is recreated (ClickHouse untouched).

- [ ] **Step 4: Verify**

```bash
sleep 45; docker ps --format '{{.Names}} {{.Status}}' | grep ulpsuite; docker exec ulpsuite_app printenv CONTENT_DEDUP_APPLY INGEST_NOVELTY_CHECK INGEST_NOVELTY_SLAB_ROWS; docker logs ulpsuite_app 2>&1 | grep -E "ingest-stage|ingest-novelty|inbox-watcher\] started|content-dedup\] cron|Error|error" | head -20
```
Expected: both containers healthy; `false` and two empty lines (the defaults: novelty on, 20,000,000-row slabs); the log shows `[ingest-stage] start-up sweep: no orphan stage tables` before `[inbox-watcher] started`, and no new errors. Then confirm the stage tables namespace is empty and the real table is untouched:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM system.tables WHERE database='ulp' AND name LIKE 'zz_import_%'" && docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials"
```
Expected: `0`, and `1394459025` (or whatever it was before: nothing in this task writes to it).

- [ ] **Step 5: Check the browser pane**

Open `http://localhost:3000/upload` in the built-in browser. The page needs the operator's session: if it shows the login page, say so and stop there (never type a password). If the operator is already signed in to that origin, confirm that the Upload and Inbox pages render and the Ingest Health panel is intact.

- [ ] **Step 6: Record it**

Update the project memory (`project_disk_full_incident_2026_10_10.md` and `project_open_items_2026_09_30.md`, and add `project_novelty_aware_ingest_2026_10_11.md`): SP2 shipped, the commit, the image id and rollback tag, D6 applied (`CONTENT_DEDUP_APPLY=false` in `.env`, was `true`), what the spike and the rehearsal found, the settings and how to turn the feature off (`INGEST_NOVELTY_CHECK=off` in `.env`, then recreate `app`), what is still open (the pile import is the operator's call and now costs about +62 GiB of new rows, so move or delete the raw files as each one finishes; no off-disk backup; the 381 GiB archive drop is still the operator's), and the check due on 2026-10-12 after 05:00Z (the two cron lines from SP1 plus the report-only dedup tick).

- [ ] **Step 7: Tick the last plan steps and push the note**

```bash
cd /home/cole/ulp-suite && sed -i 's/^- \[ \] \*\*Step/- [x] **Step/' docs/superpowers/plans/2026-10-11-novelty-aware-ingest.md && git add docs/superpowers/plans/2026-10-11-novelty-aware-ingest.md && git commit -m "docs: record the novelty-aware ingest release" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git push origin main
```
