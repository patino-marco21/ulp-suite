# Query Performance Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (This project's standing preference is lean inline execution via executing-plans — no subagents.)

**Goal:** Cut three measured costs on the 1.39B-row `ulp.credentials`: the Credentials Browser's "Unique" total (5.57 s → 0.19 s), the nightly idle dedup stats scan (71 s / 9.3 GiB RAM / 10.4 GiB temp-disk writes → ~0), and the domain monitor's `email_domain` candidate scan (22 s / 9 s → sub-second, projected).

**Architecture:** A and B are small, independent changes to `lib/ulp-dedupe.ts` + the credentials route and to `lib/content-dedup.ts` + its cron. C adds a partial projection `proj_email_domain_rev` (`SELECT _part_offset ORDER BY reverse(email_domain)`) that turns the monitor's suffix matches into prefix ranges; the resolver uses it only when every active part carries it and otherwise runs today's query verbatim. C is gated on a live feasibility check (Task 3) before any C code exists.

**Tech Stack:** Next.js 15 / TypeScript, ClickHouse 26.3 (`@clickhouse/client`), Vitest 4, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-30-query-perf-wins-design.md` (measurements and rationale live there).

## Global Constraints

- Verification commands (CI runs all three): `npm run typecheck`, `npm test` (= `vitest run`), `npm run lint`. Single file: `npx vitest run __tests__/<file>.test.ts`.
- `console.log` is stripped from production builds (only `console.error`/`console.warn` survive) — every health/progress line in new code uses `console.warn` or `console.error`.
- Never `git add -A` / `git add .`: the working tree carries the user's own uncommitted `package.json` (vitest bump) and untracked `.claude/`. Stage explicit paths only.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
- Docker on this laptop: the global `~/.docker/config.json` is broken (`credsStore: desktop`). Use a scoped config for every docker command: `export DOCKER_CONFIG=<dir containing a config.json with {}>`. The laptop also runs an unrelated stack — only ever touch `ulpsuite_*` containers; never `docker prune`.
- Never drop `ulp.credentials_predup_auto` (the user's call). Never restart the ClickHouse container. No table rebuilds.
- Values fixed by the spec: `STATS_FORCE_INTERVAL_MS` = 7 days; projection name `proj_email_domain_rev`; projection body `SELECT _part_offset ORDER BY reverse(email_domain)`; `MATERIALIZE` settings `mutations_sync = 1, max_execution_time = 3300, timeout_overflow_mode = 'throw'`; `PHASE1_MAX_EXECUTION_TIME` stays 90; DDL version becomes 23.
- Work happens on branch `perf/query-perf-wins` in the main checkout (`/home/cole/ulp-suite`). Not a worktree: `docker compose` must run from this directory.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/ulp-dedupe.ts` | modify | `dedupeCountExpr(dedupe, hasUserFilter = true)` |
| `app/api/credentials/route.ts` | modify | compute `hasUserFilter`, pass it to the total |
| `lib/content-dedup.ts` | modify | idle short-circuit (`shouldSkipStatsPass`, `buildTableRowCountSql`, `skipIfUnchanged`), `restoreDeferredProjections`, step 9 restores both projections |
| `lib/dedup-cron.ts` | modify | cron ticks pass `skipIfUnchanged: true` |
| `lib/credentials-projections.ts` | modify | email_domain projection constants, builders, readiness, restore; shared materialize loop |
| `lib/domain-match.ts` | modify | `buildEmailDomainRevCandidateWhereClause`; shared param helper |
| `lib/monitor-match-resolver.ts` | modify | choose the email_domain scan plan by projection readiness |
| `lib/clickhouse-migrations.ts` | modify | DDL v23 (ADD only) |
| `docker/clickhouse/init/01-ulp-tables.sql` | modify | mirror the projection for fresh installs |
| `scripts/run-content-dedup-once.ts` | modify | `--restore-projections` covers both; new `--restore-email-domain-projection` |
| `__tests__/ulp-dedupe.test.ts`, `__tests__/credentials-route.test.ts`, `__tests__/dedup-cron.test.ts` | modify | A / B tests |
| `__tests__/content-dedup-stats-skip.test.ts` | create | B pure + orchestration tests |
| `__tests__/content-dedup-projection-restore.test.ts` | create | `restoreDeferredProjections` tests |
| `__tests__/credentials-projections-email-domain.test.ts` | create | C projection-module + plumbing tests |
| `__tests__/domain-match-email-rev.test.ts` | create | C clause-builder tests |
| `__tests__/monitor-match-resolver-email-rev.test.ts` | create | C resolver plan-selection tests |

---

### Task 1: Unique total uses `count()` when nothing is filtered (A)

**Files:**
- Modify: `lib/ulp-dedupe.ts`, `app/api/credentials/route.ts`
- Test: `__tests__/ulp-dedupe.test.ts`, `__tests__/credentials-route.test.ts`

**Interfaces:**
- Produces: `dedupeCountExpr(dedupe: boolean, hasUserFilter = true): string` — `uniq(content_key_hash)` only when `dedupe && hasUserFilter`, else `count()`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/ulp-dedupe.test.ts`, replace this block:

```ts
  describe('dedupeCountExpr', () => {
    test('counts distinct credentials via uniq() over the hash column when deduping', () => {
      expect(dedupeCountExpr(true)).toBe('uniq(content_key_hash)')
    })
    test('plain count() when not deduping', () => {
      expect(dedupeCountExpr(false)).toBe('count()')
    })
  })
```

with:

```ts
  describe('dedupeCountExpr', () => {
    test('counts distinct credentials via uniq() over the hash column when deduping a filtered search', () => {
      expect(dedupeCountExpr(true, true)).toBe('uniq(content_key_hash)')
    })
    test('defaults to the uniq() form when the caller says nothing about filters (conservative)', () => {
      expect(dedupeCountExpr(true)).toBe('uniq(content_key_hash)')
    })
    test('plain count() for the unfiltered view: storage is deduped at rest, so the row count IS the distinct count and the 10 GiB hash column need not be scanned', () => {
      expect(dedupeCountExpr(true, false)).toBe('count()')
    })
    test('plain count() when not deduping, filtered or not', () => {
      expect(dedupeCountExpr(false)).toBe('count()')
      expect(dedupeCountExpr(false, true)).toBe('count()')
      expect(dedupeCountExpr(false, false)).toBe('count()')
    })
  })
```

Append to `__tests__/credentials-route.test.ts`:

```bash
cat >> __tests__/credentials-route.test.ts <<'EOF'

describe('credentials route — Unique total skips the hash scan when nothing is filtered (measured 5.57 s -> 0.19 s on 1.39B rows)', () => {
  const source = readFileSync(new URL('../app/api/credentials/route.ts', import.meta.url), 'utf8')
  const getFn = source.slice(source.indexOf('export async function GET'))

  test('derives hasUserFilter from the raw conditions and the tier / login-type extras', () => {
    expect(getFn).toMatch(/const hasUserFilter\s*=\s*conditionsRaw\.length > 1 \|\| tierExtra !== '' \|\| loginTypeExtra !== ''/)
  })

  test('passes it to dedupeCountExpr for the total', () => {
    expect(getFn).toContain('dedupeCountExpr(dedupe, hasUserFilter)')
  })
})
EOF
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/ulp-dedupe.test.ts __tests__/credentials-route.test.ts`
Expected: 3 FAIL — `dedupeCountExpr(true, false)` returns `uniq(...)` instead of `count()`, and the two new route contract tests. Everything else passes.

- [ ] **Step 3: Implement**

In `lib/ulp-dedupe.ts`, replace:

```ts
/**
 * Count expression for the result tally: distinct credentials when deduping
 * (`uniq` — approximate but fast/low-memory), else plain `count()`.
 */
export function dedupeCountExpr(dedupe: boolean): string {
  return dedupe ? `uniq(${DEDUPE_BY})` : 'count()'
}
```

with:

```ts
/**
 * Count expression for the result tally.
 *
 * - Not deduping: plain `count()`.
 * - Deduping a FILTERED search (`hasUserFilter`, the default when unspecified):
 *   distinct credentials via `uniq` (HyperLogLog). Filtered sets are pruned by
 *   indexes, and a not-yet-deduped duplicate inside one must not show up as an
 *   extra result ("2 results" for one displayed row).
 * - Deduping with NO user filter (the default Declutter + Unique browse view):
 *   plain `count()`. `ulp.credentials` is deduped at rest by lib/content-dedup.ts,
 *   so the row count already equals the distinct-credential count (measured
 *   2026-09-30: 1,393,449,551 rows and 1,393,449,551 distinct). Reading only the
 *   filter column instead of the 10.4 GiB hash column took this tally from 5.57 s
 *   to 0.19 s at 1.39B rows. The figure can exceed the true distinct count only by
 *   rows imported since the last rebuild, which the nightly tick bounds at
 *   DEDUP_MIN_EXCESS (~1%) — the same order as uniq's own error (measured
 *   -0.79% .. +0.32%).
 */
export function dedupeCountExpr(dedupe: boolean, hasUserFilter = true): string {
  return dedupe && hasUserFilter ? `uniq(${DEDUPE_BY})` : 'count()'
}
```

In the same file, replace the header line:

```ts
 * internally, just relocated from query-time to insert-time).
```

with:

```ts
 * internally, just relocated from query-time to insert-time). With no filter
 * narrowing the view the count is a plain count() instead — see dedupeCountExpr.
```

In `app/api/credentials/route.ts`, replace:

```ts
  const whereRaw = conditionsRaw.join(' AND ') + tierExtra + loginTypeExtra
```

with:

```ts
  const whereRaw = conditionsRaw.join(' AND ') + tierExtra + loginTypeExtra

  // Anything that narrows the result set. Declutter/Unique/sort/limit/cursor do not.
  // With no filter the Unique tally is a plain count() — see dedupeCountExpr.
  const hasUserFilter = conditionsRaw.length > 1 || tierExtra !== '' || loginTypeExtra !== ''
```

and replace:

```ts
          // When deduping, total = distinct credentials via uniq() (HLL, cheap).
          `SELECT ${dedupeCountExpr(dedupe)} AS total FROM ulp.credentials WHERE ${where}
```

with:

```ts
          // When deduping a filtered search, total = distinct credentials via uniq()
          // (HLL); with no filter it is a plain count() — storage is deduped at rest
          // (see dedupeCountExpr for the measured cost and error bound).
          `SELECT ${dedupeCountExpr(dedupe, hasUserFilter)} AS total FROM ulp.credentials WHERE ${where}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run __tests__/ulp-dedupe.test.ts __tests__/credentials-route.test.ts && npm run typecheck`
Expected: all PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/ulp-dedupe.ts app/api/credentials/route.ts __tests__/ulp-dedupe.test.ts __tests__/credentials-route.test.ts
git commit -m "$(cat <<'EOF'
perf(credentials): Unique total is a plain count() when nothing is filtered

uniq(content_key_hash) read the 10.4 GiB hash column on every first page of the
default view (5.57 s at 1.39B rows). The table is deduped at rest, so count()
equals the distinct count (0.19 s). Filtered searches keep uniq so a pending
duplicate never shows as an extra result.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Idle dedup tick skips the stats scan (B)

**Files:**
- Modify: `lib/content-dedup.ts`, `lib/dedup-cron.ts`
- Create: `__tests__/content-dedup-stats-skip.test.ts`
- Test: `__tests__/dedup-cron.test.ts` (append)

**Interfaces:**
- Produces (`lib/content-dedup.ts`): `STATS_FORCE_INTERVAL_MS: number`; `buildTableRowCountSql(): string`; `shouldSkipStatsPass(params: { rows: number | null; last: { rows: number; at: number } | null; now: number; maxAgeMs?: number }): boolean`; `DedupTickResult.skipped?: boolean`; `runContentDedupTick(opts: { trigger?: string; skipIfUnchanged?: boolean })`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/content-dedup-stats-skip.test.ts`:

```ts
import { readFileSync } from 'fs'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// content-dedup and the modules it imports only need getClient from @/lib/clickhouse.
const h = vi.hoisted(() => {
  const state = { rows: 1000, statsCalls: 0, rowCountCalls: 0, failRowCount: false }
  const client = {
    exec: vi.fn(),
    query: vi.fn(async ({ query }: { query: string }) => {
      if (query.includes('FROM system.parts')) {
        state.rowCountCalls++
        if (state.failRowCount) throw new Error('keeper unavailable')
        return { json: async () => [{ rows: String(state.rows) }] }
      }
      if (query.includes('GROUP BY content_key_hash')) {
        state.statsCalls++
        return { json: async () => [{ total: String(state.rows), distinctCreds: String(state.rows) }] }
      }
      throw new Error(`unexpected query in test: ${query.slice(0, 80)}`)
    }),
  }
  return { state, client }
})

vi.mock('@/lib/clickhouse', () => ({ getClient: () => h.client }))

import {
  STATS_FORCE_INTERVAL_MS,
  shouldSkipStatsPass,
  buildTableRowCountSql,
} from '@/lib/content-dedup'

describe('buildTableRowCountSql', () => {
  test('reads the live row count from part metadata, never from a table scan', () => {
    const sql = buildTableRowCountSql()
    expect(sql).toContain('sum(rows)')
    expect(sql).toContain('FROM system.parts')
    expect(sql).toContain(`database = 'ulp' AND table = 'credentials'`)
    expect(sql).toContain('active')
    expect(sql).not.toContain('ulp.credentials')
  })
})

describe('shouldSkipStatsPass', () => {
  const now = 1_000_000_000_000
  const last = { rows: 1_393_449_551, at: now - 60_000 }

  test('skips when the row count is unchanged and the previous pass is recent', () => {
    expect(shouldSkipStatsPass({ rows: 1_393_449_551, last, now })).toBe(true)
  })
  test('runs when rows were added (excess can only grow through inserts)', () => {
    expect(shouldSkipStatsPass({ rows: 1_393_449_552, last, now })).toBe(false)
  })
  test('runs when rows were removed too -- any change re-measures', () => {
    expect(shouldSkipStatsPass({ rows: 1_393_449_550, last, now })).toBe(false)
  })
  test('runs when there is no previous pass (first tick after a restart)', () => {
    expect(shouldSkipStatsPass({ rows: 1_393_449_551, last: null, now })).toBe(false)
  })
  test('runs when the row count could not be read (fail open)', () => {
    expect(shouldSkipStatsPass({ rows: null, last, now })).toBe(false)
  })
  test('runs again once the previous pass is older than the forced-refresh interval', () => {
    const old = { rows: 1_393_449_551, at: now - STATS_FORCE_INTERVAL_MS - 1 }
    expect(shouldSkipStatsPass({ rows: 1_393_449_551, last: old, now })).toBe(false)
  })
  test('still skips one millisecond inside the interval', () => {
    const edge = { rows: 1_393_449_551, at: now - STATS_FORCE_INTERVAL_MS + 1 }
    expect(shouldSkipStatsPass({ rows: 1_393_449_551, last: edge, now })).toBe(true)
  })
  test('the forced refresh is 7 days', () => {
    expect(STATS_FORCE_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

function silenceConsole() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  return { warn, restore: () => { warn.mockRestore(); error.mockRestore() } }
}

describe('runContentDedupTick — idle short-circuit', () => {
  let runContentDedupTick: typeof import('@/lib/content-dedup').runContentDedupTick
  let spies: ReturnType<typeof silenceConsole>

  beforeEach(async () => {
    vi.resetModules() // fresh module-level lastStatsPass for every test
    ;({ runContentDedupTick } = await import('@/lib/content-dedup'))
    // Fake timers only AFTER the dynamic import, so module loading never waits on a faked clock.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T04:00:00Z'))
    spies = silenceConsole()
    h.state.rows = 1000
    h.state.statsCalls = 0
    h.state.rowCountCalls = 0
    h.state.failRowCount = false
    delete process.env.CONTENT_DEDUP_APPLY // report-only: the tick returns right after the stats pass
  })

  afterEach(() => {
    vi.useRealTimers()
    spies.restore()
  })

  test('the first cron tick runs the full stats pass; a second tick with unchanged rows skips it', async () => {
    const first = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(first).toEqual({ total: 1000, excess: 0, applied: false })
    expect(h.state.statsCalls).toBe(1)

    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second).toEqual({ total: 1000, excess: 0, applied: false, skipped: true })
    expect(h.state.statsCalls).toBe(1) // not run again
    expect(spies.warn.mock.calls.some(c => String(c[0]).includes('skipping the stats scan'))).toBe(true)
  })

  test('runs the full pass again once rows have changed', async () => {
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    h.state.rows = 1500
    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second).toEqual({ total: 1500, excess: 0, applied: false })
    expect(h.state.statsCalls).toBe(2)
  })

  test('a manual tick (no skipIfUnchanged) never skips and never reads the row count', async () => {
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(h.state.rowCountCalls).toBe(1)
    const manual = await runContentDedupTick({ trigger: 'manual' })
    expect(manual.skipped).toBeUndefined()
    expect(h.state.statsCalls).toBe(2)
    expect(h.state.rowCountCalls).toBe(1)
  })

  test('forces a full pass again after 7 days even when nothing changed', async () => {
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    vi.setSystemTime(new Date('2026-10-09T04:00:00Z')) // 8 days later
    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second.skipped).toBeUndefined()
    expect(h.state.statsCalls).toBe(2)
  })

  test('fails open: an unreadable row count falls through to the full pass', async () => {
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    h.state.failRowCount = true
    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second.skipped).toBeUndefined()
    expect(h.state.statsCalls).toBe(2)
  })

  test('does not remember a pass whose row count could not be read', async () => {
    h.state.failRowCount = true
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    h.state.failRowCount = false
    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second.skipped).toBeUndefined()
    expect(h.state.statsCalls).toBe(2)
  })

  test('an applying tick forgets the remembered pass before it touches anything (source contract)', () => {
    const src = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
    const tick = src.slice(src.indexOf('export async function runContentDedupTick'))
    const reset = tick.indexOf('lastStatsPass = null')
    expect(reset).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(tick.indexOf('if (!willApply)'))
  })
})
```

Append to `__tests__/dedup-cron.test.ts`:

```bash
cat >> __tests__/dedup-cron.test.ts <<'EOF'

describe('dedup-cron idle short-circuit contract', () => {
  const source = readFileSync(new URL('../lib/dedup-cron.ts', import.meta.url), 'utf8')

  test('both cron call sites opt into the idle short-circuit', () => {
    const calls = source.match(/runContentDedupTick\(\{[^}]*\}\)/g) ?? []
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call).toContain('skipIfUnchanged: true')
  })
})

describe('run-content-dedup-once source contract', () => {
  test('a manual run never opts into the idle short-circuit -- a human asking for a run wants the full pass', () => {
    const script = readFileSync(new URL('../scripts/run-content-dedup-once.ts', import.meta.url), 'utf8')
    expect(script).not.toContain('skipIfUnchanged')
  })
})
EOF
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/content-dedup-stats-skip.test.ts __tests__/dedup-cron.test.ts`
Expected: FAIL — `shouldSkipStatsPass`/`buildTableRowCountSql` are not exported (`is not a function`), orchestration tests fail, and the cron call-site contract fails (no `skipIfUnchanged` yet). The manual-script contract already passes.

- [ ] **Step 3: Implement**

In `lib/content-dedup.ts`, replace:

```ts
let tickInFlight = false

export interface DedupTickResult {
  total: number
  excess: number
  applied: boolean
  /** Only set when applied: whether proj_imported_desc was restored after the swap (see tick step 9). */
  projectionsRestored?: boolean
}
```

with:

```ts
let tickInFlight = false

/**
 * What the most recent completed, non-applying stats pass saw. In-process, like the
 * project's other single-node caches: a restart costs one full pass, exactly today's
 * cost. Reset to null whenever a tick goes on to rebuild the table.
 */
interface LastStatsPass { rows: number; total: number; excess: number; at: number }
let lastStatsPass: LastStatsPass | null = null

export interface DedupTickResult {
  total: number
  excess: number
  applied: boolean
  /** Only set when applied: whether the deferred projections were restored after the swap (see tick step 9). */
  projectionsRestored?: boolean
  /** Only set on a cron tick that found the table unchanged and skipped the stats scan. */
  skipped?: boolean
}

/** A cron tick runs the full stats pass at least this often, even when the row count never changes. */
export const STATS_FORCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/** Metadata-only (no table scan): rows across the active parts of ulp.credentials. */
export function buildTableRowCountSql(): string {
  return `SELECT sum(rows) AS rows
  FROM system.parts
  WHERE database = 'ulp' AND table = 'credentials' AND active`
}

/**
 * Whether a cron tick may skip the heavy stats scan. Duplicates (excess) can only grow
 * through inserts, and every insert changes the row count; deletes cannot create
 * duplicates. The one blind spot -- an in-place mutation that rewrites key columns
 * without changing the count -- is covered by the forced full pass every
 * STATS_FORCE_INTERVAL_MS. Fails open: an unreadable count (null) or no previous pass
 * never skips.
 */
export function shouldSkipStatsPass(params: {
  rows: number | null
  last: { rows: number; at: number } | null
  now: number
  maxAgeMs?: number
}): boolean {
  const { rows, last, now, maxAgeMs = STATS_FORCE_INTERVAL_MS } = params
  if (rows === null || last === null) return false
  return rows === last.rows && now - last.at < maxAgeMs
}

/** null = could not be read; callers then fall through to the full pass (fail open). */
async function queryTableRowCount(client: ClickHouseClient): Promise<number | null> {
  try {
    const res = await client.query({ query: buildTableRowCountSql(), format: 'JSONEachRow' })
    const [row] = (await res.json()) as Array<{ rows: string }>
    const n = Number(row?.rows)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
```

Replace the tick signature line:

```ts
export async function runContentDedupTick(opts: { trigger?: string } = {}): Promise<DedupTickResult> {
```

with:

```ts
export async function runContentDedupTick(
  opts: { trigger?: string; skipIfUnchanged?: boolean } = {},
): Promise<DedupTickResult> {
```

Replace:

```ts
    const bucketCount = contentDedupBucketCount()
    const { total, distinctCreds } = await queryContentKeyStats(client, buildContentKeyStatsSql())
```

with:

```ts
    const bucketCount = contentDedupBucketCount()

    // Idle short-circuit (cron ticks only). The stats pass below is a full GROUP BY over
    // every content key -- measured 2026-09-30 at 1.39B rows: 71 s, 9.3 GiB peak RAM and
    // 10.4 GiB spilled to temp disk -- and duplicates can only appear through inserts,
    // which change the row count. The count is read BEFORE the pass so rows imported while
    // it runs make the next tick measure again. See
    // docs/superpowers/specs/2026-09-30-query-perf-wins-design.md.
    const rowsBefore = opts.skipIfUnchanged ? await queryTableRowCount(client) : null
    const prior = lastStatsPass
    if (prior !== null && shouldSkipStatsPass({ rows: rowsBefore, last: prior, now: Date.now() })) {
      console.warn(
        `[content-dedup] ${trigger}: rows unchanged since the last stats pass (rows=${prior.rows}, ` +
          `${Math.round((Date.now() - prior.at) / 3_600_000)}h ago) -- skipping the stats scan`,
      )
      return { total: prior.total, excess: prior.excess, applied: false, skipped: true }
    }

    const { total, distinctCreds } = await queryContentKeyStats(client, buildContentKeyStatsSql())
```

Replace:

```ts
    if (!willApply) return { total, excess, applied: false }
```

with:

```ts
    if (!willApply) {
      if (rowsBefore !== null) lastStatsPass = { rows: rowsBefore, total, excess, at: Date.now() }
      return { total, excess, applied: false }
    }

    // Applying: forget what the last pass saw. The table is about to be rebuilt, so the
    // next tick must measure again (re-verifying excess = 0) rather than skip.
    lastStatsPass = null
```

In `lib/dedup-cron.ts`, replace every occurrence of `runContentDedupTick({ trigger: 'cron' })` with `runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })` (two call sites — `setTimeout` and `setInterval`), and replace the header line:

```ts
 * heavy-query window. SETTINGS still bound the stats query itself.
```

with:

```ts
 * heavy-query window. SETTINGS still bound the stats query itself. Cron ticks pass
 * skipIfUnchanged: the tick skips its heavy stats scan while the table's row count is
 * unchanged since the last pass (see runContentDedupTick).
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run __tests__/content-dedup-stats-skip.test.ts __tests__/dedup-cron.test.ts __tests__/content-dedup.test.ts && npm run typecheck`
Expected: all PASS (the existing content-dedup tests are the regression net), typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add lib/content-dedup.ts lib/dedup-cron.ts __tests__/content-dedup-stats-skip.test.ts __tests__/dedup-cron.test.ts
git commit -m "$(cat <<'EOF'
perf(dedup): cron tick skips the stats scan while the table is unchanged

The nightly stats pass costs 71 s, 9.3 GiB RAM and 10.4 GiB of temp-disk writes at
1.39B rows even when nothing was imported. The cron now reads sum(rows) from
system.parts first and skips when it equals the last pass (forced every 7 days,
fail-open, manual runs always full).

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Gate C0 — feasibility of `proj_email_domain_rev` on the live table (supervised; no code)

This task changes the live schema (additive, reversible with one `DROP PROJECTION`). It is the fail-fast check the spec requires before any C code exists. **Stop and report if any stop condition trips.**

**Files:**
- Modify (docs only, last step): `docs/superpowers/specs/2026-09-30-query-perf-wins-design.md`

Set up once per shell (every command below assumes these):

```bash
export DOCKER_CONFIG=<dir containing config.json with {}>
CH="docker exec -i ulpsuite_clickhouse clickhouse-client"
cd /home/cole/ulp-suite
```

- [ ] **Step 1: Preconditions — the server is idle and has headroom**

```bash
$CH --query "SYSTEM FLUSH LOGS"
$CH --query "SELECT count() FROM system.processes WHERE query NOT LIKE '%system.processes%' FORMAT TSV"
$CH --query "SELECT count() FROM system.query_log WHERE event_time > now() - INTERVAL 10 MINUTE AND type = 'QueryFinish' AND is_initial_query AND http_user_agent LIKE '%clickhouse-js%' AND query_duration_ms > 1000 AND query NOT LIKE '%system.%' FORMAT TSV"
$CH --query "SELECT (SELECT count() FROM system.merges), (SELECT count() FROM system.mutations WHERE NOT is_done) FORMAT TSV"
$CH --query "SELECT formatReadableSize(unreserved_space) FROM system.disks FORMAT TSV"
```

Expected: `0`, `0`, `0	0`, and at least ~150 GiB free. If the second number is non-zero, someone is using the UI: wait and re-check — do not start the mutation under interactive load.

- [ ] **Step 2: Capture the "before" baselines**

```bash
# (a) browse-shape plan (must be unchanged afterwards)
$CH --query "EXPLAIN indexes = 1 SELECT url, email, password FROM ulp.credentials WHERE is_noise = 0 ORDER BY negate(toUnixTimestamp(imported_at)), domain, email, url, password LIMIT 200 FORMAT TSVRaw" > /tmp/c0-browse-before.txt; head -12 /tmp/c0-browse-before.txt
# (b) equality-filter cost (expected to improve)
$CH --time --query "SELECT count() FROM ulp.credentials WHERE email_domain = 'protonmail.com' SETTINGS use_query_cache = 0, log_comment = 'C0_eq_before' FORMAT TSV" 2>&1
# (c) today's monitor scan: original predicate, projections off (what prod runs now)
node - > /tmp/c0-before.sql <<'EOF'
const D = require('/home/cole/ulp-suite/node_modules/better-sqlite3')
const db = new D('/home/cole/ulp-suite/data/ulp.db', { readonly: true })
const domains = JSON.parse(db.prepare('select domains from domain_monitors where id=1').get().domains)
const orig = domains.map(d => `(email_domain = '${d}' OR endsWith(email_domain, '.${d}'))`).join(' OR ')
console.log(`SELECT 'C0_orig', count() AS n, groupBitXor(cityHash64(value)) AS h FROM (SELECT DISTINCT email_domain AS value FROM ulp.credentials WHERE (${orig}) LIMIT 1001) SETTINGS optimize_use_projections = 0, log_comment = 'C0_orig' FORMAT TSV;`)
EOF
$CH --time --multiquery < /tmp/c0-before.sql 2>&1
```

Expected: (c) prints `C0_orig	<n>	<hash>` and takes roughly 9–22 s. Write down `n` and `hash`.

- [ ] **Step 3: Add the projection (metadata-only) and confirm it exists**

```bash
$CH --query "ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS proj_email_domain_rev (SELECT _part_offset ORDER BY reverse(email_domain))"
$CH --query "SHOW CREATE TABLE ulp.credentials FORMAT TSVRaw" | grep -A4 'PROJECTION proj_email_domain_rev'
```

Expected: the four-line `PROJECTION proj_email_domain_rev ( SELECT _part_offset ORDER BY reverse(email_domain) )` block.

- [ ] **Step 4: Materialize one partition at a time (newest, smaller, first) under observation**

Run each as a background command (`run_in_background`) so it can be watched; `mutations_sync = 1` makes it block until done.

```bash
$CH --receive_timeout=3300 --time --query "ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_email_domain_rev IN PARTITION '202608' SETTINGS mutations_sync = 1, max_execution_time = 3300, timeout_overflow_mode = 'throw'" 2>&1
```

(`--receive_timeout=3300`: the native client defaults to 300 s of silence and would give up on a long synchronous ALTER; the mutation itself keeps running server-side either way.)

While it runs, poll every ~20–30 s in separate calls:

```bash
$CH --query "SELECT mutation_id, parts_to_do, is_done, latest_fail_reason FROM system.mutations WHERE table = 'credentials' AND NOT is_done FORMAT PrettyCompactMonoBlock"
docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' ulpsuite_clickhouse
$CH --query "SELECT formatReadableSize(unreserved_space) FROM system.disks FORMAT TSV"
```

**Stop conditions:** container memory above ~15 GiB of 20 GiB; free disk below ~120 GiB; `latest_fail_reason` non-empty; the UI visibly struggling. On any: `KILL MUTATION WHERE table = 'credentials' AND NOT is_done` then go to the rollback step.

Expected: partition `202608` (1 part, 495.8M rows) finishes in minutes. Then the same command with `'202607'` (7 parts, 897.6M rows), observed the same way.

- [ ] **Step 5: Confirm every active part now carries it**

```bash
$CH --query "SELECT (SELECT count() FROM system.parts WHERE database='ulp' AND table='credentials' AND active) AS parts, (SELECT count() FROM system.projection_parts WHERE database='ulp' AND table='credentials' AND name='proj_email_domain_rev' AND active) AS with_projection, (SELECT formatReadableSize(sum(bytes_on_disk)) FROM system.projection_parts WHERE database='ulp' AND table='credentials' AND name='proj_email_domain_rev' AND active) AS proj_size FORMAT PrettyCompactMonoBlock"
```

Expected: `parts == with_projection` (8 and 8) and `proj_size` near 5.9 GiB (probe extrapolation).

- [ ] **Step 6: Verify equality, plan and timing with the real predicate**

```bash
node - > /tmp/c0-after.sql <<'EOF'
const D = require('/home/cole/ulp-suite/node_modules/better-sqlite3')
const db = new D('/home/cole/ulp-suite/data/ulp.db', { readonly: true })
const domains = JSON.parse(db.prepare('select domains from domain_monitors where id=1').get().domains)
const rev = domains.map(d => `(reverse(email_domain) = reverse('${d}') OR startsWith(reverse(email_domain), reverse('.${d}')))`).join(' OR ')
console.log(`SELECT 'C0_rev', count() AS n, groupBitXor(cityHash64(value)) AS h FROM (SELECT DISTINCT email_domain AS value FROM ulp.credentials WHERE (${rev}) LIMIT 1001) SETTINGS preferred_optimize_projection_name = 'proj_email_domain_rev', log_comment = 'C0_rev' FORMAT TSV;`)
console.log(`EXPLAIN indexes = 1 SELECT DISTINCT email_domain AS value FROM ulp.credentials WHERE (${rev}) LIMIT 1001 SETTINGS preferred_optimize_projection_name = 'proj_email_domain_rev' FORMAT TSVRaw;`)
EOF
$CH --time --multiquery < /tmp/c0-after.sql 2>&1 | cut -c1-200 | head -40
$CH --query "SYSTEM FLUSH LOGS"
$CH --query "SELECT log_comment, query_duration_ms AS ms, formatReadableQuantity(read_rows) AS rows_read, formatReadableSize(read_bytes) AS bytes_read, ProfileEvents['SelectedMarks'] AS marks FROM system.query_log WHERE event_date = today() AND type = 'QueryFinish' AND log_comment IN ('C0_orig','C0_rev') ORDER BY event_time FORMAT PrettyCompactMonoBlock"
```

**Pass criteria (all):** `C0_rev` prints the identical `n` and `hash` as `C0_orig`; the EXPLAIN shows `ReadFromMergeTree (proj_email_domain_rev)` with `reverse(email_domain)` prefix ranges (e.g. `['oi.rozert.', 'oi.rozert/')`) and a small `Granules: N/M`; `C0_rev` is clearly faster than `C0_orig` (target: under ~3 s against 9–22 s; `rows_read` far below 545M).

- [ ] **Step 7: Parameterized smoke test (the app passes `{param:String}`, not literals)**

```bash
$CH --param_eq0=ledger.com --param_sx0=.ledger.com --param_eq1=trezor.io --param_sx1=.trezor.io --query "EXPLAIN indexes = 1 SELECT DISTINCT email_domain AS value FROM ulp.credentials WHERE ((reverse(email_domain) = reverse({eq0:String}) OR startsWith(reverse(email_domain), reverse({sx0:String}))) OR (reverse(email_domain) = reverse({eq1:String}) OR startsWith(reverse(email_domain), reverse({sx1:String})))) LIMIT 1001 SETTINGS preferred_optimize_projection_name = 'proj_email_domain_rev' FORMAT TSVRaw" | cut -c1-200 | head -20
```

Expected: the same kind of plan — `Condition` lines with reversed prefix ranges and a small granule count. (If the parameterized form does not constant-fold `reverse({p})`, the plan will show a full granule count: then Task 5's builder must pass pre-reversed literals instead — report before continuing.)

- [ ] **Step 8: Regression spot-checks**

```bash
# (a) browse plan unchanged
$CH --query "EXPLAIN indexes = 1 SELECT url, email, password FROM ulp.credentials WHERE is_noise = 0 ORDER BY negate(toUnixTimestamp(imported_at)), domain, email, url, password LIMIT 200 FORMAT TSVRaw" > /tmp/c0-browse-after.txt
diff /tmp/c0-browse-before.txt /tmp/c0-browse-after.txt && echo "browse plan UNCHANGED"
# (b) equality filter (expected faster)
$CH --time --query "SELECT count() FROM ulp.credentials WHERE email_domain = 'protonmail.com' SETTINGS use_query_cache = 0, log_comment = 'C0_eq_after' FORMAT TSV" 2>&1
# (c) the domain monitor scan is untouched (still projections off)
$CH --time --query "SELECT count() FROM (SELECT DISTINCT domain AS value FROM ulp.credentials WHERE (domain = 'ledger.com' OR endsWith(domain, '.ledger.com')) LIMIT 1001 SETTINGS optimize_use_projections = 0) FORMAT TSV" 2>&1
```

Expected: `browse plan UNCHANGED` (a diff here means the new projection changed the default-view plan — STOP and report); (b) faster than before; (c) about 1 s as before.

- [ ] **Step 9: Decide — go or roll back**

If every pass criterion and stop condition is clean: proceed to Task 4. Otherwise roll back and stop C (A and B stand on their own):

```bash
$CH --query "ALTER TABLE ulp.credentials DROP PROJECTION IF EXISTS proj_email_domain_rev"
```

- [ ] **Step 10: Record the results in the spec and commit**

Append a `## Gate C0 results (2026-09-30)` section to `docs/superpowers/specs/2026-09-30-query-perf-wins-design.md` containing the measured numbers from Steps 2, 5, 6, 7 and 8 (before/after wall time, `rows_read`, marks, projection size, materialize duration per partition, peak container memory, equality-filter before/after, browse-plan diff result), then:

```bash
git add docs/superpowers/specs/2026-09-30-query-perf-wins-design.md
git commit -m "$(cat <<'EOF'
docs(spec): gate C0 results — proj_email_domain_rev on the live table

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Projection module — constants, builders, readiness, restore (C, part 1)

**Files:**
- Modify: `lib/credentials-projections.ts`
- Create: `__tests__/credentials-projections-email-domain.test.ts`

**Interfaces:**
- Produces (`lib/credentials-projections.ts`): `EMAIL_DOMAIN_REV_PROJECTION_NAME = 'proj_email_domain_rev'`; `EMAIL_DOMAIN_REV_PROJECTION_BODY: string`; `buildAddEmailDomainRevProjectionSql(): string`; `buildPartitionsMissingEmailDomainRevSql(): string`; `buildMaterializeEmailDomainRevProjectionSql(partition: string): string`; `buildEmailDomainRevProjectionReadySql(): string`; `emailDomainRevProjectionReady(counts: { parts: number; withProjection: number }): boolean`; `isEmailDomainRevProjectionReady(run: (sql: string) => Promise<Array<{ parts?: unknown; with_projection?: unknown }>>): Promise<boolean>`; `restoreEmailDomainRevProjection(client: ClickHouseClient, guard: DiskGuard): Promise<{ partitions: string[] }>`.
- `restoreImportedDescProjection` keeps its exact behavior (existing tests in `__tests__/credentials-projections.test.ts` are the regression net).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/credentials-projections-email-domain.test.ts` (the fixture is **verbatim** `SHOW CREATE TABLE` output captured from the live ClickHouse 26.3 server on 2026-09-30 for a scratch table carrying a normal projection and the partial one):

```ts
import { describe, test, expect, vi } from 'vitest'
import { DiskHeadroomError, type DiskGuard } from '@/lib/clickhouse-disk-guard'
import {
  EMAIL_DOMAIN_REV_PROJECTION_NAME,
  EMAIL_DOMAIN_REV_PROJECTION_BODY,
  buildAddEmailDomainRevProjectionSql,
  buildPartitionsMissingEmailDomainRevSql,
  buildMaterializeEmailDomainRevProjectionSql,
  buildEmailDomainRevProjectionReadySql,
  emailDomainRevProjectionReady,
  isEmailDomainRevProjectionReady,
  restoreEmailDomainRevProjection,
  stripProjectionsFromCreateTableDdl,
} from '@/lib/credentials-projections'

// Verbatim SHOW CREATE TABLE (ClickHouse 26.3.17, 2026-09-30): the partial projection
// prints `SELECT _part_offset` on one line, unlike a normal projection's one-column-per-line body.
const DDL_WITH_PARTIAL_PROJECTION = `CREATE TABLE ulp.zz_fixture_proj
(
    \`url\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`domain\` String CODEC(ZSTD(3)),
    \`imported_at\` DateTime DEFAULT now() CODEC(Delta(4), ZSTD(1)),
    \`email_domain\` String MATERIALIZED lower(substringIndex(email, '@', -1)),
    INDEX idx_bf_email email TYPE bloom_filter(0.05) GRANULARITY 1,
    PROJECTION proj_imported_desc
    (
        SELECT
            url,
            email,
            email_domain,
            imported_at,
            domain
        ORDER BY
            negate(toUnixTimestamp(imported_at)),
            domain,
            email,
            url
    ),
    PROJECTION proj_email_domain_rev
    (
        SELECT _part_offset
        ORDER BY reverse(email_domain)
    )
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)
SETTINGS index_granularity = 65536`

const DDL_WITH_PARTIAL_PROJECTION_STRIPPED = `CREATE TABLE ulp.zz_fixture_proj
(
    \`url\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`domain\` String CODEC(ZSTD(3)),
    \`imported_at\` DateTime DEFAULT now() CODEC(Delta(4), ZSTD(1)),
    \`email_domain\` String MATERIALIZED lower(substringIndex(email, '@', -1)),
    INDEX idx_bf_email email TYPE bloom_filter(0.05) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(imported_at)
ORDER BY (domain, email, imported_at)
SETTINGS index_granularity = 65536`

describe('credentials-projections — proj_email_domain_rev', () => {
  describe('definition', () => {
    const normalize = (s: string) => s.replace(/\s+/g, '')

    test('is named proj_email_domain_rev and ordered by the reversed email_domain', () => {
      expect(EMAIL_DOMAIN_REV_PROJECTION_NAME).toBe('proj_email_domain_rev')
      expect(normalize(EMAIL_DOMAIN_REV_PROJECTION_BODY)).toBe('SELECT_part_offsetORDERBYreverse(email_domain)')
    })

    test('is exactly what the live table prints for the partial projection (whitespace aside) -- restore must reproduce what the strip removes', () => {
      const liveBlock = DDL_WITH_PARTIAL_PROJECTION.match(/PROJECTION proj_email_domain_rev\s*\(([\s\S]*?)\n    \)\n\)/)?.[1]
      expect(liveBlock).toBeDefined()
      expect(normalize(EMAIL_DOMAIN_REV_PROJECTION_BODY)).toBe(normalize(liveBlock!))
    })
  })

  describe('stripProjectionsFromCreateTableDdl with a partial projection (real SHOW CREATE TABLE shape)', () => {
    test('strips both the normal and the partial projection and fixes the trailing comma', () => {
      expect(stripProjectionsFromCreateTableDdl(DDL_WITH_PARTIAL_PROJECTION)).toBe(DDL_WITH_PARTIAL_PROJECTION_STRIPPED)
    })
  })

  describe('SQL builders', () => {
    test('ADD is idempotent (IF NOT EXISTS) and embeds the shared body', () => {
      const sql = buildAddEmailDomainRevProjectionSql()
      expect(sql).toContain('ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS proj_email_domain_rev')
      expect(sql).toContain(EMAIL_DOMAIN_REV_PROJECTION_BODY)
    })

    test('the partition query returns only partitions that still have a part without the projection, newest first', () => {
      const sql = buildPartitionsMissingEmailDomainRevSql()
      expect(sql).toContain(`database = 'ulp' AND table = 'credentials' AND active`)
      expect(sql).toContain('NOT IN')
      expect(sql).toContain('parent_name')
      expect(sql).toContain('system.projection_parts')
      expect(sql).toContain(`name = 'proj_email_domain_rev'`)
      expect(sql).toContain('ORDER BY partition DESC')
    })

    test('MATERIALIZE targets one partition, waits, and stays under the client 1h request timeout', () => {
      const sql = buildMaterializeEmailDomainRevProjectionSql('202608')
      expect(sql).toContain(`MATERIALIZE PROJECTION proj_email_domain_rev IN PARTITION '202608'`)
      expect(sql).toContain('mutations_sync = 1')
      expect(sql).toContain('max_execution_time = 3300')
      expect(sql).toContain(`timeout_overflow_mode = 'throw'`)
    })

    test('the readiness query compares active parts with active projection parts', () => {
      const sql = buildEmailDomainRevProjectionReadySql()
      expect(sql).toContain('FROM system.parts')
      expect(sql).toContain('FROM system.projection_parts')
      expect(sql).toContain(`name = 'proj_email_domain_rev'`)
      expect(sql).toContain('AS parts')
      expect(sql).toContain('AS with_projection')
    })
  })

  describe('readiness decision', () => {
    test('ready only when there are parts and every one carries the projection', () => {
      expect(emailDomainRevProjectionReady({ parts: 8, withProjection: 8 })).toBe(true)
    })
    test('not ready when only some parts carry it (mixed state: the rewritten predicate would partly full-scan)', () => {
      expect(emailDomainRevProjectionReady({ parts: 8, withProjection: 5 })).toBe(false)
    })
    test('not ready with no parts or none carrying it', () => {
      expect(emailDomainRevProjectionReady({ parts: 0, withProjection: 0 })).toBe(false)
      expect(emailDomainRevProjectionReady({ parts: 8, withProjection: 0 })).toBe(false)
    })
    test('not ready for non-numeric input', () => {
      expect(emailDomainRevProjectionReady({ parts: NaN, withProjection: NaN })).toBe(false)
    })
  })

  describe('isEmailDomainRevProjectionReady', () => {
    test('runs the readiness query and reads the UInt64-as-string counts', async () => {
      const run = vi.fn().mockResolvedValue([{ parts: '8', with_projection: '8' }])
      await expect(isEmailDomainRevProjectionReady(run)).resolves.toBe(true)
      expect(run).toHaveBeenCalledWith(buildEmailDomainRevProjectionReadySql())
    })
    test('false for a partly built projection', async () => {
      const run = vi.fn().mockResolvedValue([{ parts: '8', with_projection: '3' }])
      await expect(isEmailDomainRevProjectionReady(run)).resolves.toBe(false)
    })
    test('false for an empty result', async () => {
      const run = vi.fn().mockResolvedValue([])
      await expect(isEmailDomainRevProjectionReady(run)).resolves.toBe(false)
    })
    test('fails closed (false, with a warning) when the query throws', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const run = vi.fn().mockRejectedValue(new Error('connection refused'))
      await expect(isEmailDomainRevProjectionReady(run)).resolves.toBe(false)
      expect(warn.mock.calls.some(c => String(c[0]).includes('readiness check failed'))).toBe(true)
      warn.mockRestore()
    })
  })

  describe('restoreEmailDomainRevProjection', () => {
    function fakeClient(partitions: string[]) {
      return {
        exec: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ json: async () => partitions.map(partition => ({ partition })) }),
      }
    }
    function fakeGuard(overrides: Partial<DiskGuard> = {}): DiskGuard {
      return {
        preflight: vi.fn().mockResolvedValue(undefined),
        checkBeforeIteration: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      }
    }

    test('adds the projection first, then materializes each partition that still lacks it, guarding each one', async () => {
      const client = fakeClient(['202608', '202607'])
      const guard = fakeGuard()

      const result = await restoreEmailDomainRevProjection(client as any, guard)

      expect(result.partitions).toEqual(['202608', '202607'])
      expect(client.query.mock.calls[0][0].query).toBe(buildPartitionsMissingEmailDomainRevSql())
      expect(client.exec.mock.calls.map(c => c[0].query)).toEqual([
        buildAddEmailDomainRevProjectionSql(),
        buildMaterializeEmailDomainRevProjectionSql('202608'),
        buildMaterializeEmailDomainRevProjectionSql('202607'),
      ])
      expect(guard.preflight).toHaveBeenCalledTimes(1)
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(1, undefined, { index: 0, total: 2 })
      expect(guard.checkBeforeIteration).toHaveBeenNthCalledWith(2, undefined, { index: 1, total: 2 })
    })

    test('is a no-op beyond the idempotent ADD when every partition already has the projection', async () => {
      const client = fakeClient([])
      const guard = fakeGuard()

      const result = await restoreEmailDomainRevProjection(client as any, guard)

      expect(result.partitions).toEqual([])
      expect(client.exec).toHaveBeenCalledTimes(1)
      expect(client.exec).toHaveBeenCalledWith({ query: buildAddEmailDomainRevProjectionSql() })
      expect(guard.preflight).not.toHaveBeenCalled()
    })

    test('re-throws a disk-guard trip WITHOUT dropping anything -- this is the live table -- and stops before the next partition', async () => {
      const client = fakeClient(['202608', '202607'])
      const tripError = new DiskHeadroomError('projected-breach', 'nope', null, null)
      const guard = fakeGuard({
        checkBeforeIteration: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(tripError),
      })

      await expect(restoreEmailDomainRevProjection(client as any, guard)).rejects.toBe(tripError)

      const statements = client.exec.mock.calls.map(c => c[0].query as string)
      expect(statements).toEqual([
        buildAddEmailDomainRevProjectionSql(),
        buildMaterializeEmailDomainRevProjectionSql('202608'),
      ])
      expect(statements.some(s => /DROP/i.test(s))).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/credentials-projections-email-domain.test.ts`
Expected: FAIL — the new names are not exported (`... is not a function` / undefined).

- [ ] **Step 3: Implement**

In `lib/credentials-projections.ts`, replace this header tail:

```ts
 * Letting it fall away with the swap therefore retires it. If it is ever wanted
 * back: ADD PROJECTION ... ORDER BY reverse(domain), then MATERIALIZE.
 */
```

with:

```ts
 * Letting it fall away with the swap therefore retires it. If it is ever wanted
 * back: ADD PROJECTION ... ORDER BY reverse(domain), then MATERIALIZE.
 *
 * proj_email_domain_rev IS restored, for all partitions still missing it (it is
 * ~5.9 GiB at 1.39B rows, so the recency window does not apply): a partial
 * projection (`SELECT _part_offset ORDER BY reverse(email_domain)`) that lets the
 * domain monitor's `email_domain = 'x' OR endsWith(email_domain, '.x')` scan range-prune
 * instead of reading the table. See docs/superpowers/specs/2026-09-30-query-perf-wins-design.md.
 */
```

Replace:

```ts
export function buildMaterializeProjectionSql(partition: string): string {
  return `ALTER TABLE ulp.credentials MATERIALIZE PROJECTION ${PROJECTION_NAME} IN PARTITION '${partition}'
  SETTINGS mutations_sync = 1, max_execution_time = 3300, timeout_overflow_mode = 'throw'`
}
```

with:

```ts
export function buildMaterializeProjectionSql(partition: string): string {
  return buildMaterializeSql(PROJECTION_NAME, partition)
}

/** Shared by every projection this file restores; see buildMaterializeProjectionSql for the settings' reasoning. */
function buildMaterializeSql(projectionName: string, partition: string): string {
  return `ALTER TABLE ulp.credentials MATERIALIZE PROJECTION ${projectionName} IN PARTITION '${partition}'
  SETTINGS mutations_sync = 1, max_execution_time = 3300, timeout_overflow_mode = 'throw'`
}

/**
 * One partition at a time, each behind the disk guard, logging progress. Shared by every
 * restore in this file. A guard trip propagates (the table being worked on is the live
 * one, so nothing is ever dropped here).
 */
async function materializeEachPartition(
  client: ClickHouseClient,
  guard: DiskGuard,
  projectionName: string,
  partitions: string[],
): Promise<void> {
  if (partitions.length === 0) return
  await guard.preflight()
  for (let i = 0; i < partitions.length; i++) {
    await guard.checkBeforeIteration(undefined, { index: i, total: partitions.length })
    const startedAt = Date.now()
    await client.exec({ query: buildMaterializeSql(projectionName, partitions[i]) })
    console.warn(
      `[credentials-projections] materialized ${projectionName} for partition ${partitions[i]} ` +
        `(${i + 1}/${partitions.length}) in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    )
  }
}
```

Replace the loop at the end of `restoreImportedDescProjection`:

```ts
  if (partitions.length === 0) return { partitions }

  await guard.preflight()
  for (let i = 0; i < partitions.length; i++) {
    await guard.checkBeforeIteration(undefined, { index: i, total: partitions.length })
    const startedAt = Date.now()
    await client.exec({ query: buildMaterializeProjectionSql(partitions[i]) })
    console.warn(
      `[credentials-projections] materialized ${PROJECTION_NAME} for partition ${partitions[i]} ` +
        `(${i + 1}/${partitions.length}) in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    )
  }
  return { partitions }
}
```

with (and append the new exports after the closing brace):

```ts
  await materializeEachPartition(client, guard, PROJECTION_NAME, partitions)
  return { partitions }
}

// ── proj_email_domain_rev ────────────────────────────────────────────────────

export const EMAIL_DOMAIN_REV_PROJECTION_NAME = 'proj_email_domain_rev'

/**
 * A PARTIAL projection (projection index): it stores only the sort key and each row's
 * position, ~4.55 bytes/row. Ordering by the REVERSED value turns a suffix match into a
 * prefix range -- `endsWith(v, '.x')` == `startsWith(reverse(v), reverse('.x'))`,
 * byte-for-byte -- which ClickHouse can range-prune on. Shared by DDL v23, the init SQL
 * mirror and restoreEmailDomainRevProjection so they cannot drift apart.
 */
export const EMAIL_DOMAIN_REV_PROJECTION_BODY = `SELECT _part_offset
        ORDER BY reverse(email_domain)`

/** Metadata-only and idempotent: new inserts get the projection immediately, existing parts need MATERIALIZE. */
export function buildAddEmailDomainRevProjectionSql(): string {
  return `ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS ${EMAIL_DOMAIN_REV_PROJECTION_NAME} (${EMAIL_DOMAIN_REV_PROJECTION_BODY})`
}

/**
 * Partitions that still have at least one active part without the projection -- so a
 * re-run after a finished restore finds nothing to do. Newest first: newer partitions are
 * usually the smaller ones, which keeps the disk guard's linear projection from
 * over-projecting after one big partition.
 */
export function buildPartitionsMissingEmailDomainRevSql(): string {
  return `SELECT DISTINCT partition FROM system.parts
    WHERE database = 'ulp' AND table = 'credentials' AND active
      AND name NOT IN (
        SELECT parent_name FROM system.projection_parts
        WHERE database = 'ulp' AND table = 'credentials'
          AND name = '${EMAIL_DOMAIN_REV_PROJECTION_NAME}' AND active
      )
    ORDER BY partition DESC`
}

export function buildMaterializeEmailDomainRevProjectionSql(partition: string): string {
  return buildMaterializeSql(EMAIL_DOMAIN_REV_PROJECTION_NAME, partition)
}

/** Active parts vs active parts carrying the projection, in one metadata-only query. */
export function buildEmailDomainRevProjectionReadySql(): string {
  return `SELECT
    (SELECT count() FROM system.parts
      WHERE database = 'ulp' AND table = 'credentials' AND active) AS parts,
    (SELECT count() FROM system.projection_parts
      WHERE database = 'ulp' AND table = 'credentials'
        AND name = '${EMAIL_DOMAIN_REV_PROJECTION_NAME}' AND active) AS with_projection`
}

/**
 * Ready only when there are parts and EVERY one carries the projection. A mixed state
 * would run the rewritten predicate over parts without the index -- measured worse than
 * today's plan (a full read).
 */
export function emailDomainRevProjectionReady(counts: { parts: number; withProjection: number }): boolean {
  return Number.isFinite(counts.parts) && counts.parts > 0 && counts.parts === counts.withProjection
}

/**
 * Fails CLOSED: any error means "not ready", so the caller runs the original skip-index
 * plan. `run` is injected (the resolver passes executeQuery) so this stays unit-testable.
 */
export async function isEmailDomainRevProjectionReady(
  run: (sql: string) => Promise<Array<{ parts?: unknown; with_projection?: unknown }>>,
): Promise<boolean> {
  try {
    const [row] = await run(buildEmailDomainRevProjectionReadySql())
    return emailDomainRevProjectionReady({ parts: Number(row?.parts), withProjection: Number(row?.with_projection) })
  } catch (err) {
    console.warn(
      '[credentials-projections] proj_email_domain_rev readiness check failed -- using the skip-index scan:',
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Re-creates proj_email_domain_rev on the live ulp.credentials: ADD it (new inserts carry it
 * at once), then materialize each partition that still has a part without it, behind the
 * disk guard. Idempotent: when nothing is missing it is just the IF NOT EXISTS ADD. Like
 * restoreImportedDescProjection, a guard trip must NOT drop anything -- the table is live and
 * correct without the projection (the monitor falls back to its skip-index scan).
 */
export async function restoreEmailDomainRevProjection(
  client: ClickHouseClient,
  guard: DiskGuard,
): Promise<{ partitions: string[] }> {
  await client.exec({ query: buildAddEmailDomainRevProjectionSql() })

  const res = await client.query({ query: buildPartitionsMissingEmailDomainRevSql(), format: 'JSONEachRow' })
  const partitions = ((await res.json()) as Array<{ partition: string }>).map(row => row.partition)
  await materializeEachPartition(client, guard, EMAIL_DOMAIN_REV_PROJECTION_NAME, partitions)
  return { partitions }
}
```

- [ ] **Step 4: Run tests (new and existing) and typecheck**

Run: `npx vitest run __tests__/credentials-projections-email-domain.test.ts __tests__/credentials-projections.test.ts __tests__/projection-scope.test.ts && npm run typecheck`
Expected: all PASS — the pre-existing `credentials-projections.test.ts` proves the `materializeEachPartition` refactor kept `restoreImportedDescProjection`'s behavior.

- [ ] **Step 5: Commit**

```bash
git add lib/credentials-projections.ts __tests__/credentials-projections-email-domain.test.ts
git commit -m "$(cat <<'EOF'
feat(projections): proj_email_domain_rev builders, readiness check and restore

Partial projection ordered by reverse(email_domain); restore only materializes
partitions still missing it. Shared materialize loop with proj_imported_desc's restore.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Query builder and resolver plan selection (C, part 2)

**Files:**
- Modify: `lib/domain-match.ts`, `lib/monitor-match-resolver.ts`
- Create: `__tests__/domain-match-email-rev.test.ts`, `__tests__/monitor-match-resolver-email-rev.test.ts`

**Interfaces:**
- Consumes (Task 4): `EMAIL_DOMAIN_REV_PROJECTION_NAME`, `isEmailDomainRevProjectionReady(run)`.
- Produces: `buildEmailDomainRevCandidateWhereClause(domains: string[]): { clause: string; params: Record<string, string> }` — same param names/values as `buildCandidateColumnWhereClause('email_domain', domains)`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/domain-match-email-rev.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import {
  buildCandidateColumnWhereClause,
  buildEmailDomainRevCandidateWhereClause,
} from '@/lib/domain-match'

describe('buildEmailDomainRevCandidateWhereClause', () => {
  test('rewrites equality and suffix into reversed-key forms a prefix range can prune', () => {
    const { clause } = buildEmailDomainRevCandidateWhereClause(['aave.com'])
    expect(clause).toBe(
      '((reverse(email_domain) = reverse({email_domainEq0:String}) OR startsWith(reverse(email_domain), reverse({email_domainSuffix0:String}))))',
    )
  })

  test('never uses the un-prunable endsWith(email_domain, ...) form', () => {
    const { clause } = buildEmailDomainRevCandidateWhereClause(['trezor.io', 'ledger.com'])
    expect(clause).not.toContain('endsWith')
    expect(clause).not.toContain('email_domain = ') // the original form's bare equality
  })

  test('uses exactly the same parameter names and values as the original email_domain builder', () => {
    const domains = [' AAVE.com ', 'trezor.io']
    expect(buildEmailDomainRevCandidateWhereClause(domains).params)
      .toEqual(buildCandidateColumnWhereClause('email_domain', domains).params)
  })

  test('the suffix param is dot-prefixed, so a domain merely ending with the same letters cannot false-match', () => {
    const { params } = buildEmailDomainRevCandidateWhereClause(['trezor.io'])
    expect(params.email_domainEq0).toBe('trezor.io')
    expect(params.email_domainSuffix0).toBe('.trezor.io')
  })

  test('ORs every domain in the set', () => {
    const { clause, params } = buildEmailDomainRevCandidateWhereClause(['a.com', 'b.com'])
    expect(clause).toContain(' OR ')
    expect(Object.keys(params).sort()).toEqual([
      'email_domainEq0', 'email_domainEq1', 'email_domainSuffix0', 'email_domainSuffix1',
    ])
  })

  test('returns a never-true clause for an empty domain list', () => {
    expect(buildEmailDomainRevCandidateWhereClause([]).clause).toBe('0')
  })

  test('leaves the original builder untouched (it stays the fallback plan)', () => {
    expect(buildCandidateColumnWhereClause('email_domain', ['aave.com']).clause)
      .toBe('((email_domain = {email_domainEq0:String} OR endsWith(email_domain, {email_domainSuffix0:String})))')
  })
})
```

Create `__tests__/monitor-match-resolver-email-rev.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/ulp-normalize', () => ({
  NORM_DOMAIN_EXPR: 'domain',
  NORM_EMAIL_EXPR: 'email',
}))

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn().mockResolvedValue([]),
}))

import { resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { executeQuery } from '@/lib/clickhouse'

const mockExecuteQuery = vi.mocked(executeQuery)

beforeEach(() => {
  vi.clearAllMocks()
  mockExecuteQuery.mockResolvedValue([])
})

// Each test uses its own domain: the resolver caches phase-1 results per (mode, domains)
// in a module-level Map that clearAllMocks does not reset.
function answerReadiness(result: unknown[] | Error) {
  mockExecuteQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('system.projection_parts')) {
      if (result instanceof Error) throw result
      return result as any[]
    }
    return []
  })
}
const sqlCalls = () => mockExecuteQuery.mock.calls.map(([sql]) => sql as string)
const emailScan = () => sqlCalls().find(sql => sql.includes('SELECT DISTINCT email_domain'))
const domainScan = () => sqlCalls().find(sql => sql.includes('SELECT DISTINCT domain'))

describe('resolveMonitorMatches — email_domain candidate scan plan', () => {
  test('uses the reversed-key prefix predicate, keeps projections on and prefers proj_email_domain_rev when every part carries it', async () => {
    answerReadiness([{ parts: '8', with_projection: '8' }])
    await resolveMonitorMatches('both', ['rev-ready.example'])
    const sql = emailScan()!
    expect(sql).toContain('reverse(email_domain)')
    expect(sql).toContain(`preferred_optimize_projection_name = 'proj_email_domain_rev'`)
    expect(sql).not.toContain('optimize_use_projections = 0')
    expect(sql).not.toContain('endsWith(email_domain')
  })

  test('the domain scan is unaffected -- same endsWith predicate, projections still off', async () => {
    answerReadiness([{ parts: '8', with_projection: '8' }])
    await resolveMonitorMatches('both', ['rev-domain-unchanged.example'])
    const sql = domainScan()!
    expect(sql).toContain('endsWith(domain')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).not.toContain('reverse(')
  })

  test('falls back to today\'s skip-index scan when only some parts carry the projection', async () => {
    answerReadiness([{ parts: '8', with_projection: '5' }])
    await resolveMonitorMatches('both', ['rev-partial.example'])
    const sql = emailScan()!
    expect(sql).toContain('endsWith(email_domain')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).not.toContain('reverse(')
  })

  test('falls back when there are no parts', async () => {
    answerReadiness([{ parts: '0', with_projection: '0' }])
    await resolveMonitorMatches('both', ['rev-noparts.example'])
    expect(emailScan()!).toContain('optimize_use_projections = 0')
  })

  test('falls back (and does not throw) when the readiness query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    answerReadiness(new Error('connection refused'))
    await resolveMonitorMatches('both', ['rev-error.example'])
    expect(emailScan()!).toContain('endsWith(email_domain')
    warn.mockRestore()
  })

  test('does not run the readiness check for url-mode monitors (no email_domain scan at all)', async () => {
    answerReadiness([{ parts: '8', with_projection: '8' }])
    await resolveMonitorMatches('url', ['rev-url-mode.example'])
    expect(sqlCalls().some(sql => sql.includes('system.projection_parts'))).toBe(false)
    expect(emailScan()).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/domain-match-email-rev.test.ts __tests__/monitor-match-resolver-email-rev.test.ts`
Expected: FAIL — `buildEmailDomainRevCandidateWhereClause is not a function`; the resolver tests fail on the `reverse(` / `preferred_optimize_projection_name` assertions (the fallback-case tests already pass).

- [ ] **Step 3: Implement the clause builder**

In `lib/domain-match.ts`, replace:

```ts
 * history — kept there instead of re-explained on every read of this file.
 */
export function buildCandidateColumnWhereClause(
```

with:

```ts
 * history — kept there instead of re-explained on every read of this file.
 *
 * 2026-09-30 addendum: that attempt used a normal covering projection and a minmax
 * index. A PARTIAL projection (`SELECT _part_offset ORDER BY reverse(email_domain)`,
 * ClickHouse 26.3 projection-index filtering) IS selected by the planner and does
 * range-prune the reversed predicate — measured on a sandbox and then on the live table;
 * see buildEmailDomainRevCandidateWhereClause below and
 * docs/superpowers/specs/2026-09-30-query-perf-wins-design.md. This builder remains the
 * fallback whenever that projection is not fully materialized.
 */
export function buildCandidateColumnWhereClause(
```

Replace the body of `buildCandidateColumnWhereClause`:

```ts
): { clause: string; params: Record<string, string> } {
  const params: Record<string, string> = {}
  const parts = domains.map((domain, i) => {
    const d = domain.toLowerCase().trim()
    const eqParam = `${column}Eq${i}`
    const suffixParam = `${column}Suffix${i}`
    params[eqParam] = d
    params[suffixParam] = `.${d}`
    return `(${column} = {${eqParam}:String} OR endsWith(${column}, {${suffixParam}:String}))`
  })
  return { clause: parts.length ? `(${parts.join(' OR ')})` : '0', params }
}
```

with:

```ts
): { clause: string; params: Record<string, string> } {
  const { params, names } = candidateParams(column, domains)
  const parts = names.map(
    ({ eqParam, suffixParam }) =>
      `(${column} = {${eqParam}:String} OR endsWith(${column}, {${suffixParam}:String}))`,
  )
  return { clause: parts.length ? `(${parts.join(' OR ')})` : '0', params }
}

/**
 * The same domain-or-subdomain semantics as buildCandidateColumnWhereClause('email_domain', ...),
 * rewritten against the reversed value so ClickHouse can range-prune it through
 * proj_email_domain_rev (`ORDER BY reverse(email_domain)`): `= 'x'` becomes an equality on the
 * reversed key and `endsWith(v, '.x')` becomes `startsWith(reverse(v), reverse('.x'))`, a
 * prefix range. `reverse` is byte-wise on both sides, so the two forms match exactly the
 * same rows. Same parameter names and values as the original builder.
 *
 * ONLY valid to run when that projection exists on every part: without it this form is a
 * full read, worse than the original (measured) — callers gate on
 * isEmailDomainRevProjectionReady (lib/credentials-projections.ts).
 */
export function buildEmailDomainRevCandidateWhereClause(
  domains: string[],
): { clause: string; params: Record<string, string> } {
  const { params, names } = candidateParams('email_domain', domains)
  const parts = names.map(
    ({ eqParam, suffixParam }) =>
      `(reverse(email_domain) = reverse({${eqParam}:String}) OR startsWith(reverse(email_domain), reverse({${suffixParam}:String})))`,
  )
  return { clause: parts.length ? `(${parts.join(' OR ')})` : '0', params }
}

/** Parameter names/values shared by both candidate builders: per domain, the bare value and its dot-prefixed suffix. */
function candidateParams(
  column: CandidateColumn,
  domains: string[],
): { params: Record<string, string>; names: Array<{ eqParam: string; suffixParam: string }> } {
  const params: Record<string, string> = {}
  const names = domains.map((domain, i) => {
    const d = domain.toLowerCase().trim()
    const eqParam = `${column}Eq${i}`
    const suffixParam = `${column}Suffix${i}`
    params[eqParam] = d
    params[suffixParam] = `.${d}`
    return { eqParam, suffixParam }
  })
  return { params, names }
}
```

- [ ] **Step 4: Implement the resolver change**

In `lib/monitor-match-resolver.ts`, replace the import block:

```ts
import {
  buildDomainSetWhereClause,
  buildCandidateColumnWhereClause,
  buildCandidateValueBranches,
```

with:

```ts
import {
  EMAIL_DOMAIN_REV_PROJECTION_NAME,
  isEmailDomainRevProjectionReady,
} from '@/lib/credentials-projections'
import {
  buildDomainSetWhereClause,
  buildCandidateColumnWhereClause,
  buildEmailDomainRevCandidateWhereClause,
  buildCandidateValueBranches,
```

Replace this addendum anchor in the `PHASE1_MAX_EXECUTION_TIME` doc comment:

```ts
 * timeout bump fixes. 90 s is a verified-sufficient budget for the monitor
 * that surfaced this (2× the slower of the two measured costs), not a
 * guarantee for an even broader one.
 */
const PHASE1_MAX_EXECUTION_TIME = 90
```

with:

```ts
 * timeout bump fixes. 90 s is a verified-sufficient budget for the monitor
 * that surfaced this (2× the slower of the two measured costs), not a
 * guarantee for an even broader one.
 *
 * 2026-09-30: explained and fixed — email_domain is uncorrelated with the
 * table's ORDER BY, and a suffix match cannot prune on a plain ordered index.
 * proj_email_domain_rev (ORDER BY reverse(email_domain)) plus the rewritten
 * predicate in buildEmailDomainRevCandidateWhereClause turns each domain into
 * prefix ranges; resolveCandidates uses it whenever the projection is fully
 * materialized and this skip-index plan otherwise. See
 * docs/superpowers/specs/2026-09-30-query-perf-wins-design.md.
 */
const PHASE1_MAX_EXECUTION_TIME = 90
```

Replace the start of `resolveCandidates` (through the end of the `scans` map):

```ts
  const scans = columns.map(async column => {
    const { clause, params } = buildCandidateColumnWhereClause(column, domains)
    // optimize_use_projections = 0: for this scan's shape the planner prefers any
    // narrow covering projection (proj_imported_desc includes email_domain) over the
    // base table's ngram skip indexes and then reads every row -- measured live
    // 2026-09-30: 22s / 1.39B rows with it vs 9s / 545M rows without, identical
    // results. Skip indexes are what actually prune this predicate.
    const rows = await executeQuery(
      `SELECT DISTINCT ${column} AS value
       FROM ulp.credentials
       WHERE ${clause}
       LIMIT {candidateLimit:UInt32}
       SETTINGS max_execution_time = ${PHASE1_MAX_EXECUTION_TIME}, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, optimize_use_projections = 0`,
      { ...params, candidateLimit: CANDIDATE_LIMIT + 1 }
    ) as { value: string }[]
    return { column, values: rows.map(r => r.value) }
  })
```

with:

```ts
  // One metadata query (system.parts vs system.projection_parts) decides how the email_domain
  // scan runs: through proj_email_domain_rev only when EVERY active part carries it, otherwise
  // today's skip-index plan verbatim. Fails closed -- see isEmailDomainRevProjectionReady.
  const viaRevProjection =
    columns.includes('email_domain') && (await isEmailDomainRevProjectionReady(sql => executeQuery(sql)))

  const scans = columns.map(async column => {
    const useRev = column === 'email_domain' && viaRevProjection
    const { clause, params } = useRev
      ? buildEmailDomainRevCandidateWhereClause(domains)
      : buildCandidateColumnWhereClause(column, domains)
    // Plan settings differ per path:
    //  - reversed-key projection index: projections stay ON and the named projection is
    //    preferred. `reverse(email_domain)` turns each `= 'x' OR endsWith(.., '.x')` pair into
    //    prefix ranges, so the scan reads ~(domains x one granule) instead of the table.
    //  - skip-index plan: optimize_use_projections = 0. For this predicate shape the planner
    //    prefers any narrow covering projection (proj_imported_desc includes email_domain) over
    //    the base table's ngram skip indexes and then reads every row -- measured live
    //    2026-09-30: 22s / 1.39B rows with it vs 9s / 545M rows without, identical results.
    const planSettings = useRev
      ? `preferred_optimize_projection_name = '${EMAIL_DOMAIN_REV_PROJECTION_NAME}'`
      : 'optimize_use_projections = 0'
    const rows = await executeQuery(
      `SELECT DISTINCT ${column} AS value
       FROM ulp.credentials
       WHERE ${clause}
       LIMIT {candidateLimit:UInt32}
       SETTINGS max_execution_time = ${PHASE1_MAX_EXECUTION_TIME}, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, ${planSettings}`,
      { ...params, candidateLimit: CANDIDATE_LIMIT + 1 }
    ) as { value: string }[]
    return { column, values: rows.map(r => r.value) }
  })
```

- [ ] **Step 5: Run the new and existing tests and typecheck**

Run: `npx vitest run __tests__/domain-match-email-rev.test.ts __tests__/monitor-match-resolver-email-rev.test.ts __tests__/domain-match.test.ts __tests__/monitor-match-resolver.test.ts && npm run typecheck`
Expected: all PASS — the existing `domain-match.test.ts` and `monitor-match-resolver.test.ts` (including "phase 1 candidate scans disable projection use", which still holds because the default mock returns `[]` for the readiness query → fallback) are the regression net.

- [ ] **Step 6: Commit**

```bash
git add lib/domain-match.ts lib/monitor-match-resolver.ts __tests__/domain-match-email-rev.test.ts __tests__/monitor-match-resolver-email-rev.test.ts
git commit -m "$(cat <<'EOF'
perf(monitor): email_domain candidate scan uses proj_email_domain_rev when ready

Reversed-key prefix predicate + preferred projection when every active part carries
the projection; otherwise today's skip-index query verbatim (fails closed). The
domain scan is untouched.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Schema plumbing — DDL v23, init SQL, dedup restore, script flags (C, part 3)

**Files:**
- Modify: `lib/clickhouse-migrations.ts`, `docker/clickhouse/init/01-ulp-tables.sql`, `lib/content-dedup.ts`, `scripts/run-content-dedup-once.ts`
- Create: `__tests__/content-dedup-projection-restore.test.ts`
- Test: `__tests__/credentials-projections-email-domain.test.ts` (append)

**Interfaces:**
- Consumes (Task 4): `buildAddEmailDomainRevProjectionSql`, `restoreEmailDomainRevProjection`, `EMAIL_DOMAIN_REV_PROJECTION_NAME`.
- Produces (`lib/content-dedup.ts`): `restoreDeferredProjections(trigger: string, restorers: Array<{ name: string; run: () => Promise<unknown> }>): Promise<boolean>` — runs each restorer in its own try/catch; true only if all succeed.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/content-dedup-projection-restore.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest'
import { restoreDeferredProjections } from '@/lib/content-dedup'

describe('restoreDeferredProjections', () => {
  test('runs every restorer in order and reports true when all succeed', async () => {
    const order: string[] = []
    const ok = await restoreDeferredProjections('cron', [
      { name: 'proj_email_domain_rev', run: async () => { order.push('email') } },
      { name: 'proj_imported_desc', run: async () => { order.push('imported') } },
    ])
    expect(ok).toBe(true)
    expect(order).toEqual(['email', 'imported'])
  })

  test('one failing restorer is reported with its name and re-run command but never blocks the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = vi.fn().mockResolvedValue(undefined)
    const ok = await restoreDeferredProjections('cron', [
      { name: 'proj_email_domain_rev', run: async () => { throw new Error('disk headroom') } },
      { name: 'proj_imported_desc', run: second },
    ])
    expect(ok).toBe(false)
    expect(second).toHaveBeenCalledTimes(1)
    const message = String(error.mock.calls[0][0])
    expect(message).toContain('proj_email_domain_rev')
    expect(message).toContain('--restore-projections')
    expect(String(error.mock.calls[0][1])).toContain('disk headroom')
    error.mockRestore()
  })

  test('reports false when the last one fails too, and when every one fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = await restoreDeferredProjections('manual', [
      { name: 'a', run: async () => { throw new Error('x') } },
      { name: 'b', run: async () => { throw new Error('y') } },
    ])
    expect(ok).toBe(false)
    expect(error).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })
})
```

Append to `__tests__/credentials-projections-email-domain.test.ts`:

```bash
cat >> __tests__/credentials-projections-email-domain.test.ts <<'EOF'

describe('schema plumbing for proj_email_domain_rev', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  test('DDL v23 adds the projection through the shared builder and does NOT materialize at deploy', () => {
    const src = read('../lib/clickhouse-migrations.ts')
    expect(src).toMatch(/const DDL_VERSION = 23\b/)
    const block = src.slice(src.indexOf('if (lastDdl < 23)'), src.indexOf('if (lastDdl < DDL_VERSION)'))
    expect(block).toContain('buildAddEmailDomainRevProjectionSql()')
    expect(block).not.toContain('MATERIALIZE')
  })

  test('the init SQL mirror carries the same projection body for fresh installs', () => {
    const sql = read('../docker/clickhouse/init/01-ulp-tables.sql')
    expect(sql).toContain('PROJECTION proj_email_domain_rev')
    expect(sql).toMatch(/SELECT _part_offset\s+ORDER BY reverse\(email_domain\)/)
  })

  test('the dedup tick restores both projections through restoreDeferredProjections', () => {
    const src = read('../lib/content-dedup.ts')
    const tick = src.slice(src.indexOf('export async function runContentDedupTick'))
    expect(tick).toContain('restoreDeferredProjections(')
    expect(tick).toContain('restoreEmailDomainRevProjection(')
    expect(tick).toContain('restoreImportedDescProjection(')
  })

  test('the one-off script can restore just the email_domain projection, and --restore-projections covers both', () => {
    const script = read('../scripts/run-content-dedup-once.ts')
    expect(script).toContain('--restore-email-domain-projection')
    expect(script).toContain('--restore-projections')
    expect(script).toContain('restoreEmailDomainRevProjection')
    expect(script).toContain('restoreImportedDescProjection')
  })
})
EOF
sed -i "1i import { readFileSync } from 'fs'" __tests__/credentials-projections-email-domain.test.ts
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/content-dedup-projection-restore.test.ts __tests__/credentials-projections-email-domain.test.ts`
Expected: FAIL — `restoreDeferredProjections is not a function`; the four plumbing tests fail (no v23, no init mirror, tick/script not updated). The Task 4 tests in that file still pass.

- [ ] **Step 3: Implement DDL v23 and the init SQL mirror**

In `lib/clickhouse-migrations.ts`, replace:

```ts
import { IMPORTED_DESC_PROJECTION_BODY } from './credentials-projections'
```

with:

```ts
import { IMPORTED_DESC_PROJECTION_BODY, buildAddEmailDomainRevProjectionSql } from './credentials-projections'
```

Replace:

```ts
//      deployment reaches the same end state automatically. See
//      docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md.
const DDL_VERSION = 22
```

with:

```ts
//      deployment reaches the same end state automatically. See
//      docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md.
// v23: proj_email_domain_rev — partial projection (`SELECT _part_offset ORDER BY
//      reverse(email_domain)`) that lets the domain monitor's email_domain
//      candidate scan range-prune a suffix match instead of reading the table.
//      ADD only (metadata-only; new parts carry it). Existing parts are backfilled
//      by the supervised, per-partition, disk-guarded restoreEmailDomainRevProjection
//      (lib/credentials-projections.ts), deliberately NOT fired here the way v14 fires
//      its MATERIALIZE: app start must not be coupled to a mutation. Until every part
//      carries it the resolver runs its original skip-index scan. See
//      docs/superpowers/specs/2026-09-30-query-perf-wins-design.md.
const DDL_VERSION = 23
```

Replace:

```ts
  if (lastDdl < DDL_VERSION) {
    setSetting('ch_ddl_version', String(DDL_VERSION))
```

with:

```ts
  // v23 — proj_email_domain_rev (see DDL_VERSION comment above). ADD only. Logged with full
  // detail like v22: a failure just means the monitor keeps using its skip-index scan
  // (the readiness check sees no projection).
  if (lastDdl < 23) {
    try {
      await client.exec({ query: buildAddEmailDomainRevProjectionSql() })
      console.warn('[ClickHouse migration] DDL v23 applied (added proj_email_domain_rev projection -- existing parts need restoreEmailDomainRevProjection)')
    } catch (err) {
      console.error('[ClickHouse migration] v23: ADD PROJECTION proj_email_domain_rev -- FAILED:', err instanceof Error ? err.message : String(err))
    }
  }

  if (lastDdl < DDL_VERSION) {
    setSetting('ch_ddl_version', String(DDL_VERSION))
```

In `docker/clickhouse/init/01-ulp-tables.sql`, replace:

```sql
        ORDER BY negate(toUnixTimestamp(imported_at)), domain, email, url, password
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials', '{replica}')
```

with:

```sql
        ORDER BY negate(toUnixTimestamp(imported_at)), domain, email, url, password
    ),

    -- proj_email_domain_rev: partial projection (projection index) for the domain monitor's
    -- email_domain scan. Ordering by the REVERSED value turns `endsWith(email_domain, '.x')`
    -- into a prefix range ClickHouse can prune on. Mirrors DDL v23 in
    -- lib/clickhouse-migrations.ts — that file is the source of truth; keep both in sync.
    PROJECTION proj_email_domain_rev (
        SELECT _part_offset
        ORDER BY reverse(email_domain)
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials', '{replica}')
```

- [ ] **Step 4: Implement the dedup restore wiring**

In `lib/content-dedup.ts`, replace the import:

```ts
import { restoreImportedDescProjection, stripProjectionsFromCreateTableDdl } from '@/lib/credentials-projections'
```

with:

```ts
import {
  EMAIL_DOMAIN_REV_PROJECTION_NAME,
  restoreEmailDomainRevProjection,
  restoreImportedDescProjection,
  stripProjectionsFromCreateTableDdl,
} from '@/lib/credentials-projections'
```

Replace the header line:

```ts
 * proj_imported_desc is restored on the live table after the swap and
```

with:

```ts
 * proj_email_domain_rev and proj_imported_desc are restored on the live table after the swap and
```

Insert, directly after the `queryTableRowCount` function added in Task 2, this exported helper:

```ts
/**
 * Runs each deferred-projection restore on its own, so one failing (most likely a disk-guard
 * trip) never blocks the others. True only if every restorer succeeded. A failure is reported
 * with the re-run command but never turns the tick into applied: false -- the swap and
 * catch-up are already done and ulp.credentials is correct without the projections.
 */
export async function restoreDeferredProjections(
  trigger: string,
  restorers: Array<{ name: string; run: () => Promise<unknown> }>,
): Promise<boolean> {
  let allRestored = true
  for (const { name, run } of restorers) {
    try {
      await run()
    } catch (err) {
      allRestored = false
      console.error(
        `[content-dedup] ${trigger}: swap and catch-up succeeded, but restoring ${name} failed -- ` +
          `ulp.credentials is live and correct, just without the projection for some partitions. ` +
          `Re-run with: npx tsx scripts/run-content-dedup-once.ts --restore-projections. Cause:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  return allRestored
}
```

Replace tick step 9:

```ts
    // 9. Restore the projection deferred out of the build (see DEFERRED
    // PROJECTIONS in the file header). The swap and catch-up are already done
    // and ulp.credentials is correct without it -- only the "newest first"
    // default sort is slower for partitions still waiting -- so a failure here
    // (most likely a disk-guard trip while the archived original is still on
    // disk) is reported but must NOT turn this into applied: false.
    let projectionsRestored = true
    try {
      await restoreImportedDescProjection(client, createDiskGuard('ulp.credentials'))
    } catch (err) {
      projectionsRestored = false
      console.error(
        `[content-dedup] ${trigger}: swap and catch-up succeeded, but restoring proj_imported_desc failed -- ` +
          `ulp.credentials is live and correct, just without the projection for some partitions. ` +
          `Re-run with: npx tsx scripts/run-content-dedup-once.ts --restore-projections. Cause:`,
        err instanceof Error ? err.message : String(err),
      )
    }
```

with:

```ts
    // 9. Restore the projections deferred out of the build (see DEFERRED
    // PROJECTIONS in the file header). The swap and catch-up are already done
    // and ulp.credentials is correct without them -- the "newest first" default
    // sort and the monitor's email_domain scan are merely slower (the resolver
    // falls back on its own) -- so a failure here (most likely a disk-guard trip
    // while the archived original is still on disk) is reported but must NOT turn
    // this into applied: false. The small email_domain one goes first.
    const projectionsRestored = await restoreDeferredProjections(trigger, [
      { name: EMAIL_DOMAIN_REV_PROJECTION_NAME, run: () => restoreEmailDomainRevProjection(client, createDiskGuard('ulp.credentials')) },
      { name: 'proj_imported_desc', run: () => restoreImportedDescProjection(client, createDiskGuard('ulp.credentials')) },
    ])
```

- [ ] **Step 5: Implement the script flags**

In `scripts/run-content-dedup-once.ts`, replace the header sentences:

```ts
 * The rewrite+swap builds the deduped table WITHOUT ulp.credentials'
 * projections and restores proj_imported_desc afterwards (see
 * lib/credentials-projections.ts). If that last step failed -- or the run was
 * interrupted after the swap -- re-run just the restore, same docker command
 * with `--restore-projections` appended to the `npx tsx` line (no
 * CONTENT_DEDUP_APPLY needed; it never touches row data).
```

with:

```ts
 * The rewrite+swap builds the deduped table WITHOUT ulp.credentials'
 * projections and restores proj_email_domain_rev and proj_imported_desc
 * afterwards (see lib/credentials-projections.ts). If that last step failed --
 * or the run was interrupted after the swap -- re-run just the restore, same
 * docker command with `--restore-projections` appended to the `npx tsx` line
 * (no CONTENT_DEDUP_APPLY needed; it never touches row data). Use
 * `--restore-email-domain-projection` to restore only the small email_domain
 * one (idempotent: materializes only partitions still missing it) without
 * re-materializing the large proj_imported_desc.
```

Replace:

```ts
import { restoreImportedDescProjection } from '@/lib/credentials-projections'

async function main(): Promise<void> {
  if (process.argv.includes('--restore-projections')) {
    const { partitions } = await restoreImportedDescProjection(getClient(), createDiskGuard('ulp.credentials'))
    console.log(`[run-content-dedup-once] proj_imported_desc restored for partitions: ${partitions.join(', ') || '(none in the recency window)'}`)
    await getClient().close()
    return
  }
```

with:

```ts
import { restoreEmailDomainRevProjection, restoreImportedDescProjection } from '@/lib/credentials-projections'

async function main(): Promise<void> {
  const restoreAll = process.argv.includes('--restore-projections')
  const restoreEmailOnly = process.argv.includes('--restore-email-domain-projection')
  if (restoreAll || restoreEmailOnly) {
    const email = await restoreEmailDomainRevProjection(getClient(), createDiskGuard('ulp.credentials'))
    console.log(`[run-content-dedup-once] proj_email_domain_rev materialized for partitions: ${email.partitions.join(', ') || '(none missing)'}`)
    if (restoreAll) {
      const imported = await restoreImportedDescProjection(getClient(), createDiskGuard('ulp.credentials'))
      console.log(`[run-content-dedup-once] proj_imported_desc restored for partitions: ${imported.partitions.join(', ') || '(none in the recency window)'}`)
    }
    await getClient().close()
    return
  }
```

Also replace the closing error message:

```ts
      '[run-content-dedup-once] the swap succeeded but restoring proj_imported_desc failed -- ' +
```

with:

```ts
      '[run-content-dedup-once] the swap succeeded but restoring a projection failed -- ' +
```

- [ ] **Step 6: Run the tests (new and affected existing) and typecheck**

Run: `npx vitest run __tests__/content-dedup-projection-restore.test.ts __tests__/credentials-projections-email-domain.test.ts __tests__/content-dedup.test.ts __tests__/content-dedup-stats-skip.test.ts __tests__/dedup-cron.test.ts && npm run typecheck`
Expected: all PASS. (`dedup-cron.test.ts`'s script contract still passes: the script never mentions `skipIfUnchanged`.)

- [ ] **Step 7: Commit**

```bash
git add lib/clickhouse-migrations.ts docker/clickhouse/init/01-ulp-tables.sql lib/content-dedup.ts scripts/run-content-dedup-once.ts __tests__/content-dedup-projection-restore.test.ts __tests__/credentials-projections-email-domain.test.ts
git commit -m "$(cat <<'EOF'
feat(projections): DDL v23, init mirror, and dedup restore for proj_email_domain_rev

v23 adds the projection only (no MATERIALIZE at deploy). The dedup tick restores both
deferred projections independently, email_domain first. The one-off script gains
--restore-email-domain-projection; --restore-projections covers both.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Full verification, deploy, final gates, docs and merge

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-query-perf-wins-design.md` (status + results), `docs/superpowers/plans/2026-09-30-query-perf-wins.md` (tick boxes, status)
- Temporary (never committed): `scripts/tmp-tick-twice.ts`, `scripts/tmp-resolve-monitor.ts`

- [ ] **Step 1: Run everything CI runs**

Run: `npm run typecheck && npm test && npm run lint`
Expected: all exit 0; `npm test` reports every file passing (baseline before this work: 73+ files / 1106+ tests; the count grows with the new files). Any failure: fix before continuing.

- [ ] **Step 2: Build and deploy the app locally (ClickHouse is not touched)**

Wait for a lull first (no UI queries in the last ~5 min: `SELECT count() FROM system.query_log WHERE event_time > now() - INTERVAL 5 MINUTE AND http_user_agent LIKE '%clickhouse-js%' AND query_duration_ms > 1000`), because the restart drops in-flight requests.

```bash
export DOCKER_CONFIG=<dir containing config.json with {}>
cd /home/cole/ulp-suite
docker compose up -d --build app
docker ps --filter name=ulpsuite --format 'table {{.Names}}\t{{.Status}}'
docker logs --tail 40 ulpsuite_app 2>&1 | grep -E 'DDL|content-dedup|monitor-rescan|Ready'
```

Expected: `ulpsuite_app` healthy; logs show `DDL v23 applied` (or `DDL v23 already applied` if gate C0 already added the projection — the ADD is `IF NOT EXISTS`), the content-dedup cron line, `Ready`.

- [ ] **Step 3: Gate C-final 1 — the monitor resolves through the new path, end to end**

Create `scripts/tmp-resolve-monitor.ts` (temporary):

```ts
import { resolveMonitorMatches } from '@/lib/monitor-match-resolver'
import { getClient } from '@/lib/clickhouse'

const domains = [
  'bitbox.team', 'bitkey.world', 'blockstream.com', 'coldcard.com', 'cypherock.com',
  'dcentwallet.com', 'ellipal.com', 'foundation.xyz', 'gridplus.io', 'keepkey.com',
  'keyst.one', 'ledger.com', 'ngrave.io', 'onekey.so', 'safepal.com', 'tangem.com', 'trezor.io',
]

async function main() {
  const t0 = Date.now()
  const r = await resolveMonitorMatches('both', domains)
  console.log(JSON.stringify({ ms: Date.now() - t0, rows: r.rows.length, limited: r.limited }))
  await getClient().close()
}
main().catch(e => { console.error(e); process.exit(1) })
```

Run it from a throwaway container on the compose network (the pattern documented in `scripts/run-content-dedup-once.ts`):

```bash
docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app \
  --env-file .env -e CLICKHOUSE_HOST="http://clickhouse:8123" \
  node:24-bookworm-slim npx tsx scripts/tmp-resolve-monitor.ts
```

Expected: one JSON line, `rows` equal to the monitor's saved match count (59 in `monitor_matches`; both come from the same predicate) and `limited: false`, and `ms` dominated by the legacy probe (seconds), no longer by a 22 s `email_domain` scan. Then confirm which plan ran, from the query log:

```bash
$CH --query "SYSTEM FLUSH LOGS"
$CH --query "SELECT query_duration_ms AS ms, formatReadableQuantity(read_rows) AS rows_read, positionCaseInsensitive(query, 'reverse(email_domain)') > 0 AS used_rev_form FROM system.query_log WHERE event_time > now() - INTERVAL 5 MINUTE AND type = 'QueryFinish' AND startsWith(query, 'SELECT DISTINCT email_domain') ORDER BY event_time DESC LIMIT 3 FORMAT PrettyCompactMonoBlock"
```

Expected: `used_rev_form = 1`, `rows_read` in the low millions at most, duration under ~3 s.

- [ ] **Step 4: Gate C-final 2 — fallback, restore helper and strip against the real DDL**

```bash
# (a) the restore helper is a no-op on the live table (everything already materialized)
docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app \
  --env-file .env -e CLICKHOUSE_HOST="http://clickhouse:8123" \
  node:24-bookworm-slim npx tsx scripts/run-content-dedup-once.ts --restore-email-domain-projection
```

Expected output: `proj_email_domain_rev materialized for partitions: (none missing)`. **Never run `--restore-projections` here: it would re-materialize the 90 GiB `proj_imported_desc`.**

```bash
# (b) the strip function accepts the REAL live DDL (a format mismatch would block dedup)
$CH --query "SHOW CREATE TABLE ulp.credentials FORMAT TSVRaw" > /tmp/live-ddl.sql
cat > scripts/tmp-strip-check.ts <<'EOF'
import { readFileSync } from 'node:fs'
import { stripProjectionsFromCreateTableDdl } from '@/lib/credentials-projections'
const out = stripProjectionsFromCreateTableDdl(readFileSync('/tmp/live-ddl.sql', 'utf8'))
console.log(/PROJECTION/.test(out) ? 'STILL HAS PROJECTION' : 'strip OK: no PROJECTION left')
EOF
docker run --rm -v "$(pwd)":/app -v /tmp/live-ddl.sql:/tmp/live-ddl.sql:ro -w /app node:24-bookworm-slim npx tsx scripts/tmp-strip-check.ts
rm scripts/tmp-strip-check.ts
```

Expected: `strip OK: no PROJECTION left`.

```bash
# (c) fallback: the resolver must still work with the projection absent. Verified by the unit
# tests (readiness false -> original plan). Do NOT drop the live projection just to demo it.
```

- [ ] **Step 5: Gate — B on the live server (two ticks in one process, report-only)**

Create `scripts/tmp-tick-twice.ts` (temporary):

```ts
import { runContentDedupTick } from '@/lib/content-dedup'
import { getClient } from '@/lib/clickhouse'

async function main() {
  const t0 = Date.now()
  const a = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
  const t1 = Date.now()
  const b = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
  const t2 = Date.now()
  console.log(JSON.stringify({ first: { ...a, ms: t1 - t0 }, second: { ...b, ms: t2 - t1 } }))
  await getClient().close()
}
main().catch(e => { console.error(e); process.exit(1) })
```

```bash
docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app \
  --env-file .env -e CLICKHOUSE_HOST="http://clickhouse:8123" -e CONTENT_DEDUP_APPLY=false \
  node:24-bookworm-slim npx tsx scripts/tmp-tick-twice.ts
```

(`.env` arms `CONTENT_DEDUP_APPLY=true` for the cron; the `-e ...=false` override keeps this check report-only.) Expected: `first` ≈ 70 s with `excess: 0` and no `skipped`; `second` returns in milliseconds with `skipped: true`. Run it only when the server is idle — the first tick is the same heavy scan the nightly cron runs.

```bash
rm -f scripts/tmp-tick-twice.ts scripts/tmp-resolve-monitor.ts
git status --short
```

Expected: only the user's `package.json` and `.claude/` remain dirty.

- [ ] **Step 6: Gate — A in production traffic**

After the deploy, the next default-view load should issue `SELECT count() AS total ...` rather than `uniq(content_key_hash)`:

```bash
$CH --query "SYSTEM FLUSH LOGS"
$CH --query "SELECT event_time, query_duration_ms AS ms, substring(replaceRegexpAll(query,'\\\\s+',' '),1,90) AS q FROM system.query_log WHERE event_time > now() - INTERVAL 30 MINUTE AND type = 'QueryFinish' AND query LIKE '%AS total FROM ulp.credentials%' ORDER BY event_time DESC LIMIT 5 FORMAT PrettyCompactMonoBlock"
```

If no default-view request has arrived yet, the route's behavior rests on the unit/contract tests plus the direct measurement (5.57 s → 0.19 s); note that in the report rather than forcing traffic.

- [ ] **Step 7: Close out the docs**

In `docs/superpowers/specs/2026-09-30-query-perf-wins-design.md` change the Status line to `Implemented <date> on branch perf/query-perf-wins (merged <sha>)`, and add a `## Results` section with the measured before/after numbers from Steps 3–6 and gate C0. Tick the plan's checkboxes and mark it complete:

```bash
sed -i 's/^- \[ \]/- [x]/' docs/superpowers/plans/2026-09-30-query-perf-wins.md
```

and add `**Status:** Completed <date> (merged <sha>)` under the plan's title line. Then:

```bash
git add docs/superpowers/specs/2026-09-30-query-perf-wins-design.md docs/superpowers/plans/2026-09-30-query-perf-wins.md
git commit -m "$(cat <<'EOF'
docs: close out query performance wins (spec results, plan status)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Merge to main and push (standing permission, verification above is the gate)**

```bash
git switch main
git merge --ff-only perf/query-perf-wins
git push origin main
git log --oneline -8
```

Expected: fast-forward merge; push succeeds; `git status` still shows only the user's two pre-existing changes. CI (typecheck, test, lint) runs on the push — look at it once at the end of the session (`gh run list --limit 3`), do not poll.

- [ ] **Step 9: Update memory**

Update `project_open_items_2026_09_30.md` (items 5–7 done, with the measured results), `project_email_domain_no_index_pruning.md` (live gate results), and add the newly observed open item: interactive domain searches (`domain = 'x' OR domain LIKE '%.x'`, e.g. cryptio.co / anchorage.com / ledger.com) cost 20–48 s per count query (`uniq` 19–23 s over ~600M rows; `count() raw_total` 46–48 s over 1.39B rows) — the same suffix-match shape as the monitor scan, on the main search path, a candidate for a reversed-`domain` partial projection.

---

## Self-Review

**Spec coverage:** A → Task 1 (count() when unfiltered, `hasUserFilter`, tests, measured numbers in docs). B → Task 2 (row-count signature, `shouldSkipStatsPass`, 7-day force, cron-only, fail-open, apply resets state, `skipped` result, health line via `console.warn`; manual script never skips). C projection → Tasks 3–6 (feasibility gate first; constants/builders/readiness/restore; reversed-key builder and resolver plan selection with fallback; DDL v23 ADD-only; init mirror; dedup step 9 restoring both projections; script flags; strip fixture from real `SHOW CREATE`; stale `domain-match.ts` comment addendum). Live gates C0 and C-final → Tasks 3 and 7. Rollback (`DROP PROJECTION`) → Task 3 Step 9 and Task 7. Out-of-scope items are not touched.

**Placeholder scan:** no TBD/TODO; every code step has full code; every command has expected output. The only intentionally open values are results to be measured live (recorded in Task 3 Step 10 and Task 7 Step 7), which are outputs, not missing inputs.

**Type consistency:** `dedupeCountExpr(dedupe, hasUserFilter = true)` (Task 1) is what the route calls. `shouldSkipStatsPass({ rows, last, now, maxAgeMs? })`, `buildTableRowCountSql`, `STATS_FORCE_INTERVAL_MS`, `DedupTickResult.skipped` (Task 2) match the tests. `EMAIL_DOMAIN_REV_PROJECTION_NAME`, `isEmailDomainRevProjectionReady(run)`, `restoreEmailDomainRevProjection(client, guard)`, `buildAddEmailDomainRevProjectionSql` (Task 4) are consumed unchanged in Tasks 5 and 6. `buildEmailDomainRevCandidateWhereClause` (Task 5) returns the same `{ clause, params }` shape as `buildCandidateColumnWhereClause`. `restoreDeferredProjections(trigger, restorers)` (Task 6) matches its test. The param names `email_domainEq{i}` / `email_domainSuffix{i}` are identical across both builders (asserted by test).
