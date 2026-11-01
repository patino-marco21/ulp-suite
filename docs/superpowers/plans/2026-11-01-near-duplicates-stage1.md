# Near-duplicates, Stage 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop new look-alikes (rows that differ from a stored row only by a leading `www.`, capitals in the host or the login, or extra trailing slashes) from being stored: a second key column `norm_key_hash`, a supervised backfill of it, and an import that matches on it once every part of the table holds it.

**Architecture:** DDL v30 adds `norm_key_hash UInt64 MATERIALIZED <the key>` (metadata only); `scripts/materialize-norm-key.sh` fills the existing parts one partition at a time. `lib/norm-key-ready.ts` decides per import, from the catalogue, whether the column is complete (and `INGEST_NORM_KEY` is not off); `lib/ingest-novelty.ts` then takes the key column as a parameter (slabs, known check, insert, monitor match), and the job records which rule it used. Until the column is complete everything behaves exactly as today. Stage 2 (removing the look-alikes already stored) is NOT in this plan.

**Tech Stack:** TypeScript (Next.js app, vitest), ClickHouse 26.3 SQL, bash (the supervised backfill, tested against a stub `docker`), the isolated rehearsal stack (`docker-compose.rehearsal.yml`) for real-ClickHouse proof.

**Spec:** `docs/superpowers/specs/2026-11-01-near-duplicates-design.md` (approved 2026-11-01). Read its "The rule", "Stage 1" and "Decisions" first.

## Global Constraints

Every task's requirements include these (values copied from the spec).

- **The rule, as SQL text** (written once in `lib/url-content-key.ts`; `s` is the URL without its `http://` or `https://`, any case):
  `cityHash64(concat(lower(extract(s, '^(?i:www\\.)?([^/?#]*)')), extract(s, '^[^/?#]*(.*?)/*$')), lower(email), password)`.
  Port, path and its capitals, query, fragment and password are compared as typed. The exact key (`content_key_hash`) is not changed in any way.
- **DDL v30** is `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS norm_key_hash UInt64 MATERIALIZED <the key>` and nothing else: it never fires the backfill (start-up is not coupled to a mutation). A failed ADD is not recorded as done (the recorded version stays 29) and the next start tries again.
- **`INGEST_NORM_KEY`**: on by default; `off`, `0` or `false` (any case, trimmed) match on the exact key everywhere, and then every statement is today's to the letter.
- **Readiness**: an import uses `norm_key_hash` only if the column exists in `ulp.credentials` and the number of active parts equals the number of active parts that list it in `system.parts_columns` (an empty table counts as complete). Metadata only; fails closed (any error or odd answer means the exact key); remembered 60 s when ready and 5 s when not; decided once per import, before the first slab.
- **`processing_jobs.match_key`**: nullable TEXT, `norm` or `exact`; null (a job from before this release) means exact.
- **With the normalised key** the commit insert and the monitor query take `ORDER BY url, email LIMIT 1 BY norm_key_hash` (the monitor query sorts after its WHERE); the sort spills to disk above `max_bytes_before_external_sort` = 1073741824 (1 GiB). With the exact key neither statement has an ORDER BY.
- **Cost gate**: the new commit statement on a 20,000,000-row, all-new slab may take at most 1.25 times the old one, measured on the rehearsal stack. Over that, stop and report; do not ship an arbitrary pick.
- **Backfill**: `MATERIALIZE COLUMN norm_key_hash IN PARTITION <p>`, one partition at a time, smallest first, a partition that is already complete skipped; refuses to start under 170 GiB free or while another mutation runs on the table; kills its mutation under 155 GiB free. The disk's critical floor is 140.5 GiB and its warning level 187.4 GiB; the column adds about 19.5 GiB.
- **The repository is public**: committed text carries numbers and reasons only. No search terms, log excerpts, names of data files or credential values. Tests and fixtures use invented `.example` / `.test` hosts.
- **Logging**: `console.warn` / `console.error` for anything `docker logs` has to show (the production build strips `console.log`).
- **A new setting** is forwarded by name in `docker-compose.yml` (in `docker-compose.rehearsal.yml` as `REHEARSAL_<NAME>`), described in `.env.example` and in the README.
- **ClickHouse changes are proven on a real ClickHouse**: Task 8 and Task 9 are the proof. **Deploys**: tag the running image first, build a candidate under its own tag, rehearse it with `REHEARSAL_APP_IMAGE`, run `docker compose` from the primary checkout only (from a worktree it blanks `.env` and serves an empty database).
- **Gates** (CI runs them in this order): `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`. `typecheck` also covers `scripts/` and `__tests__/`.
- **Commits** end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Working copy**: a worktree under `.claude/worktrees/` branched from `origin/main` (it has the spec); a fresh one needs `npm install`. Run `npm test` once before Task 1 so any failure that is already there is known.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/url-content-key.ts` | The one definition of both keys, as SQL builders over any column expressions | 1 |
| `lib/clickhouse-migrations.ts`, `lib/clickhouse-migration-safety.ts`, `docker/clickhouse/init/01-ulp-tables.sql` | DDL v30, the column list the start-up check owns, the fresh-install definition | 2 |
| `lib/ingest-novelty-config.ts` | `normKeyEnabled()`, the external-sort bound | 3 |
| `lib/norm-key-ready.ts` (new) | `MatchKey`, `KeyColumn`, the catalogue readiness check, `resolveMatchKey()` | 3 |
| `docker-compose.yml`, `docker-compose.rehearsal.yml`, `.env.example`, `README.md`, `__tests__/setup/ingest-novelty-off.ts` | The setting, forwarded, documented, off in the unit suites | 3 |
| `lib/ingest-stage.ts`, `lib/ingest-novelty.ts` | The stage gets the column; the builders and `commitStage` take a key column | 4 |
| `lib/upload-processor.ts`, `lib/import-summary.ts`, `lib/processing-log.ts`, `lib/sqlite.ts` | The import chooses its key once, passes it, returns it; the job records it | 5 |
| `scripts/materialize-norm-key.sh` (new) | The supervised backfill | 6 |
| `scripts/pile/verify-file.ts` | The per-file recount follows the job's key | 7 |
| `scripts/e2e-novelty-ingest.ts`, `scripts/e2e-alert-rehearsal.ts`, `scripts/measure-commit-sort-cost.ts` (new), `scripts/check-norm-key-parity.ts` (new) | Real-ClickHouse scenarios, the cost gate, the read-only parity check | 2, 8 |

---

### Task 1: The key in one place

**Files:**
- Modify: `lib/url-content-key.ts` (append after `URL_CONTENT_KEY`)
- Modify: `__tests__/url-content-key.test.ts` (whole file)

**Interfaces:**
- Consumes: nothing.
- Produces (all from `lib/url-content-key.ts`; the existing `URL_CONTENT_KEY` stays exactly as it is):
  - `interface KeyColumns { url: string; email: string; password: string }`
  - `const TABLE_KEY_COLUMNS: KeyColumns` (`url`, `email`, `password`)
  - `exactKeySql(c?: KeyColumns): string`
  - `normHostSql(url?: string): string`, `normRestSql(url?: string): string`
  - `normKeySql(c?: KeyColumns): string`
  - `const NORM_CONTENT_KEY: string` (= `normKeySql()`)

- [ ] **Step 1: Write the failing tests**

Replace `__tests__/url-content-key.test.ts` with:

```ts
import { describe, test, expect } from 'vitest'
import {
  NORM_CONTENT_KEY,
  URL_CONTENT_KEY,
  exactKeySql,
  normHostSql,
  normKeySql,
  normRestSql,
} from '@/lib/url-content-key'

const S = `replaceRegexpOne(url, '^(?i:https?://)', '')`

describe('url-content-key', () => {
  test('strips a leading http:// or https:// (case-insensitive) and one trailing slash from url', () => {
    expect(URL_CONTENT_KEY).toBe(
      `replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '')`
    )
  })

  test('the exact key over the table columns is the one the live table and the stage define', () => {
    expect(exactKeySql()).toBe(`cityHash64(${URL_CONTENT_KEY}, email, password)`)
  })

  test('the exact key can be computed over other expressions, as the per-file recount does', () => {
    expect(exactKeySql({ url: 'unhex(u)', email: 'unhex(e)', password: 'unhex(p)' })).toBe(
      `cityHash64(replaceRegexpOne(replaceRegexpOne(unhex(u), '^(?i:https?://)', ''), '/$', ''), unhex(e), unhex(p))`,
    )
  })
})

describe('the normalised key', () => {
  test('the host part has no leading www., is lower case, and ends at the first / ? or #', () => {
    expect(normHostSql()).toBe(String.raw`lower(extract(${S}, '^(?i:www\\.)?([^/?#]*)'))`)
  })

  test('the rest of the URL is as typed, without any trailing slash', () => {
    expect(normRestSql()).toBe(String.raw`extract(${S}, '^[^/?#]*(.*?)/*$')`)
  })

  test('the key text is locked: host and rest, the login in lower case, the password as typed', () => {
    expect(NORM_CONTENT_KEY).toBe(
      String.raw`cityHash64(concat(lower(extract(${S}, '^(?i:www\\.)?([^/?#]*)')), extract(${S}, '^[^/?#]*(.*?)/*$')), lower(email), password)`,
    )
    expect(normKeySql()).toBe(NORM_CONTENT_KEY)
  })

  test('over other expressions it lower-cases the login only', () => {
    const key = normKeySql({ url: 'unhex(u)', email: 'unhex(e)', password: 'unhex(p)' })
    expect(key).toContain('lower(unhex(e)), unhex(p))')
    expect(key).not.toContain('lower(unhex(p))')
    expect(key).not.toMatch(/\burl\b/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/url-content-key.test.ts`
Expected: FAIL (`exactKeySql is not a function` and the same for the other new exports).

- [ ] **Step 3: Write the implementation**

Append to `lib/url-content-key.ts`, after the `URL_CONTENT_KEY` constant:

```ts

// ── Both keys as SQL over any column expressions ────────────────────────────────────────────────────
// docs/superpowers/specs/2026-11-01-near-duplicates-design.md. The normalised key is the same credential once a leading `www.`, capitals in the
// host and in the login, and any number of trailing slashes are ignored; the port, the path and its capitals, the query, the fragment and the
// password are compared as typed. `concat` cannot confuse two keys: the rest always starts with `/`, `?` or `#`, or is empty, because the host
// part stops at the first of them. `lower` is ASCII only, as measured. Hand copy: docker/clickhouse/init/01-ulp-tables.sql (a test locks it).

/** The three values a key is computed from: column names for the table and the stage, other expressions (`unhex(u)`) for a script. */
export interface KeyColumns {
  url: string
  email: string
  password: string
}

export const TABLE_KEY_COLUMNS: KeyColumns = { url: 'url', email: 'email', password: 'password' }

/** The exact key (content_key_hash): the URL without its scheme and one trailing slash, the login and the password as stored. */
export function exactKeySql(c: KeyColumns = TABLE_KEY_COLUMNS): string {
  return `cityHash64(replaceRegexpOne(replaceRegexpOne(${c.url}, '^(?i:https?://)', ''), '/$', ''), ${c.email}, ${c.password})`
}

const withoutScheme = (url: string) => `replaceRegexpOne(${url}, '^(?i:https?://)', '')`

/** The host as the normalised key sees it: no leading `www.`, lower case, up to the first `/`, `?` or `#` (a port and a `user:pw@` stay in it). */
export function normHostSql(url: string = TABLE_KEY_COLUMNS.url): string {
  return String.raw`lower(extract(${withoutScheme(url)}, '^(?i:www\\.)?([^/?#]*)'))`
}

/** The rest of the URL: path, query and fragment as typed, without any trailing slash. */
export function normRestSql(url: string = TABLE_KEY_COLUMNS.url): string {
  return String.raw`extract(${withoutScheme(url)}, '^[^/?#]*(.*?)/*$')`
}

/** The normalised key (norm_key_hash). */
export function normKeySql(c: KeyColumns = TABLE_KEY_COLUMNS): string {
  return `cityHash64(concat(${normHostSql(c.url)}, ${normRestSql(c.url)}), lower(${c.email}), ${c.password})`
}

/** The normalised key over the table's own columns: what DDL v30, the stage and the init SQL define. */
export const NORM_CONTENT_KEY = normKeySql()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/url-content-key.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/url-content-key.ts __tests__/url-content-key.test.ts
git commit -m "feat(near-dup): both content keys as SQL builders; the normalised key text locked by a test" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: DDL v30, the init SQL, the column list

**Files:**
- Modify: `lib/clickhouse-migrations.ts` (import, the version comment and constants, `ddlVersionToRecord`, a v30 block, the recorded-version call)
- Modify: `lib/clickhouse-migration-safety.ts` (`MIGRATION_COLUMNS`)
- Modify: `docker/clickhouse/init/01-ulp-tables.sql` (the column, after `content_key_hash`)
- Modify: `scripts/e2e-alert-rehearsal.ts` (the DDL version it expects)
- Modify: `__tests__/ddl-version-record.test.ts` (whole file), `__tests__/clickhouse-migrations-startup.test.ts` (whole file), `__tests__/url-content-key.test.ts` (append)

**Interfaces:**
- Consumes: `NORM_CONTENT_KEY` from Task 1.
- Produces: `ddlVersionToRecord(sourcesIdentityFailed: boolean, addressIndexFailed = false, normKeyFailed = false): number` (30 when nothing failed; 29 when only v30 failed; 28 when v29 failed; 27 when v28 failed); `MIGRATION_COLUMNS` contains `'norm_key_hash'`; a fresh install has the column.

- [ ] **Step 1: Write the failing tests**

Replace `__tests__/ddl-version-record.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { ddlVersionToRecord } from '@/lib/clickhouse-migrations'

describe('ddlVersionToRecord', () => {
  it('records v30 when the ulp.sources identity columns, the address index and the norm_key_hash column were added', () => {
    expect(ddlVersionToRecord(false)).toBe(30)
    expect(ddlVersionToRecord(false, false)).toBe(30)
    expect(ddlVersionToRecord(false, false, false)).toBe(30)
  })

  it('keeps the version below v30 when the ADD COLUMN failed, so the next start tries it again', () => {
    expect(ddlVersionToRecord(false, false, true)).toBe(29)
  })

  it('keeps the version below v29 when the ADD INDEX failed, whatever happened to v30', () => {
    expect(ddlVersionToRecord(false, true)).toBe(28)
    expect(ddlVersionToRecord(false, true, true)).toBe(28)
  })

  it('keeps the version below v28 when that ALTER failed, whatever happened to v29 and v30', () => {
    expect(ddlVersionToRecord(true)).toBe(27)
    expect(ddlVersionToRecord(true, false)).toBe(27)
    expect(ddlVersionToRecord(true, true)).toBe(27)
    expect(ddlVersionToRecord(true, false, true)).toBe(27)
  })
})
```

Replace `__tests__/clickhouse-migrations-startup.test.ts` with:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { dbGet, dbRun } from '@/lib/sqlite'

// The runner only needs getClient from @/lib/clickhouse; every other export stays real.
const h = vi.hoisted(() => {
  const state = {
    probes: 0,
    probeFailures: 0, // the first N "SELECT 1" probes are refused, like a server that is not listening yet
    firstProbeAnswerAtExecs: -1,
    execs: [] as string[],
    queries: [] as string[],
    dropExecs: false, // every exec fails like a connection that was reset
    failExecWith: '' as string, // an exec whose SQL contains this fails with a server-side error
    indexes: [] as string[],
    columns: [] as string[],
  }
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 172.20.0.2:8123'), { code: 'ECONNREFUSED' })
  const client = {
    query: vi.fn(async ({ query }: { query: string }) => {
      state.queries.push(query)
      if (query.trim() === 'SELECT 1') {
        state.probes++
        if (state.probes <= state.probeFailures) throw refused()
        if (state.firstProbeAnswerAtExecs < 0) state.firstProbeAnswerAtExecs = state.execs.length
        return { json: async () => [{ 1: 1 }] }
      }
      if (query.includes('system.data_skipping_indices')) return { json: async () => state.indexes.map(name => ({ name })) }
      if (query.includes('system.columns')) return { json: async () => state.columns.map(name => ({ name })) }
      return { json: async () => [] } // the v27 projection check
    }),
    exec: vi.fn(async ({ query }: { query: string }) => {
      state.execs.push(query)
      if (state.dropExecs) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      if (state.failExecWith && query.includes(state.failExecWith)) throw new Error('Code: 62. DB::Exception: Syntax error: failed at position 1')
      return {}
    }),
  }
  return { state, client }
})

vi.mock('@/lib/clickhouse', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/clickhouse')>()),
  getClient: () => h.client,
}))

const LIVE_INDEXES = [
  'idx_bf_breach_name', 'idx_bf_domain', 'idx_bf_email', 'idx_bf_email_domain', 'idx_bf_email_lc', 'idx_bf_password', 'idx_bf_source_file',
  'idx_bf_url_host', 'idx_inv_email', 'idx_inv_password', 'idx_inv_url', 'idx_mm_imported_at', 'idx_ngram_domain', 'idx_ngram_email_domain',
  'idx_ngram_url_host', 'idx_set_country_tier', 'idx_set_login_type', 'idx_set_password_entropy', 'idx_set_password_mask', 'idx_set_url_scheme',
]

const getSetting = (key: string): string | null => (dbGet(`SELECT value FROM app_settings WHERE key_name = ?`, [key]) as { value: string } | undefined)?.value ?? null
const setSetting = (key: string, value: string) => dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES (?, ?)`, [key, value])
const clearSetting = (key: string) => dbRun(`DELETE FROM app_settings WHERE key_name = ?`, [key])

// A clock that only moves when the runner sleeps, so a wait of "45 seconds" takes no time.
function fakeWait(timeoutMs = 45_000) {
  let t = 0
  return { timeoutMs, sleep: async (ms: number) => { t += ms }, now: () => t }
}

describe('runClickHouseMigrations — start-up safeguards', () => {
  let run: typeof import('@/lib/clickhouse-migrations').runClickHouseMigrations
  let error: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.resetModules() // a fresh migrationsDone for every test
    ;({ runClickHouseMigrations: run } = await import('@/lib/clickhouse-migrations'))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
    Object.assign(h.state, { probes: 0, probeFailures: 0, firstProbeAnswerAtExecs: -1, dropExecs: false, failExecWith: '', indexes: [...LIVE_INDEXES] })
    h.state.execs.length = 0
    h.state.queries.length = 0
    h.state.columns = [
      'url', 'email', 'password', 'domain', 'source_file', 'imported_at', 'breach_name', 'tld', 'email_domain', 'country_tier', 'login_type',
      'password_length', 'password_mask', 'url_scheme', 'is_corporate_email', 'url_host', 'password_entropy_band', 'is_noise', 'content_key_hash',
      'norm_key_hash', 'was_duplicated',
    ]
    setSetting('ch_ddl_version', '29') // an upgrade from the last release: only the v30 block has work to do
    setSetting('ch_repair_mutations_fired', '1')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('asks a real query first and runs nothing until the server answers it', async () => {
    h.state.probeFailures = 3
    await run({ wait: fakeWait() })
    expect(h.state.probes).toBe(4)
    expect(h.state.firstProbeAnswerAtExecs).toBe(0) // not one statement was sent before the first answer
    expect(h.state.execs.some(sql => sql.includes('norm_key_hash'))).toBe(true)
    expect(getSetting('ch_ddl_version')).toBe('30')
    // once, however many times it had to ask: the log is what tells a person why the start took a few seconds longer
    const waiting = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('not accepting connections yet'))
    expect(waiting).toHaveLength(1)
  })

  test('a server that answers at once logs nothing about waiting', async () => {
    await run({ wait: fakeWait() })
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('not accepting connections yet'))).toBe(false)
  })

  test('a server that never answers: nothing is run, nothing is recorded, and the log says so', async () => {
    h.state.probeFailures = Number.POSITIVE_INFINITY
    await run({ wait: fakeWait(5_000) })
    expect(h.state.execs).toEqual([])
    expect(getSetting('ch_ddl_version')).toBe('29')
    const lines = error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(lines).toContain('no DDL was run')
  })

  test('after such a failure a call within the minute returns at once, a later one asks again', async () => {
    h.state.probeFailures = Number.POSITIVE_INFINITY
    await run({ wait: fakeWait(1_000) })
    const asked = h.state.probes
    await run({ wait: fakeWait(1_000) })
    expect(h.state.probes).toBe(asked) // every upload request calls the runner: it must not wait 45 s each time

    vi.setSystemTime(new Date('2026-10-17T12:01:01Z'))
    h.state.probeFailures = 0
    await run({ wait: fakeWait() })
    expect(h.state.probes).toBeGreaterThan(asked)
    expect(getSetting('ch_ddl_version')).toBe('30')
  })

  test('a connection lost during the run keeps the version, leaves the repair mutations unfired, and the next call runs it all again', async () => {
    clearSetting('ch_repair_mutations_fired')
    h.state.dropExecs = true
    await run({ wait: fakeWait() })
    expect(getSetting('ch_ddl_version')).toBe('29')
    expect(getSetting('ch_repair_mutations_fired')).toBeNull()
    expect(h.state.queries.some(q => q.includes('system.data_skipping_indices'))).toBe(false) // no schema check against a server that just dropped us
    expect(error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('connection')

    h.state.dropExecs = false
    h.state.execs.length = 0
    vi.setSystemTime(new Date('2026-10-17T12:02:00Z'))
    await run({ wait: fakeWait() })
    expect(h.state.execs.some(sql => sql.includes('norm_key_hash'))).toBe(true)
    expect(getSetting('ch_ddl_version')).toBe('30')
    expect(getSetting('ch_repair_mutations_fired')).toBe('1')
  })

  test('a server-side failure of the v29 ADD INDEX still keeps the version at 28, as before', async () => {
    setSetting('ch_ddl_version', '28') // both the v29 and the v30 block have work to do
    h.state.failExecWith = 'idx_bf_email_lc'
    await run({ wait: fakeWait() })
    expect(getSetting('ch_ddl_version')).toBe('28')
  })

  test('v30 adds the column from the shared key text and fires no backfill: that is the supervised script\'s job', async () => {
    await run({ wait: fakeWait() })
    expect(h.state.execs).toHaveLength(1)
    expect(h.state.execs[0]).toMatch(/^ALTER TABLE ulp\.credentials ADD COLUMN IF NOT EXISTS norm_key_hash UInt64 MATERIALIZED cityHash64\(/)
    expect(h.state.execs.some(sql => /MATERIALIZE/.test(sql))).toBe(false)
    expect(getSetting('ch_ddl_version')).toBe('30')
  })

  test('a server-side failure of the v30 ADD COLUMN keeps the version at 29, so the next start tries it again', async () => {
    h.state.failExecWith = 'norm_key_hash'
    await run({ wait: fakeWait() })
    expect(getSetting('ch_ddl_version')).toBe('29')
    expect(error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('v30')
  })

  test('a finished run is done for the process: the second call sends nothing', async () => {
    await run({ wait: fakeWait() })
    const sent = h.state.execs.length
    const asked = h.state.queries.length
    await run({ wait: fakeWait() })
    expect(h.state.execs.length).toBe(sent)
    expect(h.state.queries.length).toBe(asked)
  })

  test('the schema check runs after every completed run, even when the version is already current, and adds what is missing', async () => {
    setSetting('ch_ddl_version', '30')
    h.state.indexes = LIVE_INDEXES.filter(n => n !== 'idx_inv_url' && n !== 'idx_ngram_domain')
    await run({ wait: fakeWait() })
    expect(h.state.execs).toHaveLength(2)
    expect(h.state.execs.some(sql => sql.includes('idx_inv_url'))).toBe(true)
    expect(h.state.execs.some(sql => sql.includes('idx_ngram_domain'))).toBe(true)
    expect(getSetting('ch_ddl_version')).toBe('30')
  })

  test('a complete schema on a current install costs the probe and two metadata queries, and no statement', async () => {
    setSetting('ch_ddl_version', '30')
    await run({ wait: fakeWait() })
    expect(h.state.execs).toEqual([])
    expect(h.state.queries).toHaveLength(3)
  })
})
```

Append to `__tests__/url-content-key.test.ts` (and add `import { readFileSync } from 'node:fs'` at the top of the file):

```ts
const squash = (s: string) => s.replace(/\s+/g, '')
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('the normalised key is defined once and copied to the places plain SQL cannot import it', () => {
  test('the init SQL defines norm_key_hash with exactly the TypeScript text', () => {
    expect(squash(read('docker/clickhouse/init/01-ulp-tables.sql'))).toContain(`norm_key_hashUInt64MATERIALIZED${squash(NORM_CONTENT_KEY)}`)
  })

  test('DDL v30 adds the column from the same constant and does not fire the backfill', () => {
    const migrations = read('lib/clickhouse-migrations.ts')
    expect(squash(migrations)).toContain(squash('ADD COLUMN IF NOT EXISTS norm_key_hash UInt64 MATERIALIZED ${NORM_CONTENT_KEY}'))
    expect(migrations).not.toMatch(/MATERIALIZE COLUMN norm_key_hash/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/ddl-version-record.test.ts __tests__/clickhouse-migrations-startup.test.ts __tests__/url-content-key.test.ts __tests__/clickhouse-migration-safety.test.ts`
Expected: FAIL (the recorded version is 29 where 30 is expected, no `norm_key_hash` statement is sent, the init SQL lacks the column).

- [ ] **Step 3: Write the implementation**

In `lib/clickhouse-migrations.ts`:

1. Replace the line `import { URL_CONTENT_KEY } from './url-content-key'` with:

```ts
import { NORM_CONTENT_KEY, URL_CONTENT_KEY } from './url-content-key'
```

2. Replace this block (the end of the version comment, the constants and `ddlVersionToRecord`):

```ts
const DDL_VERSION = 29
const DDL_BEFORE_SOURCES_IDENTITY = 27
const DDL_BEFORE_ADDRESS_INDEX = 28

/** The DDL version to record after a run: a failed v28 ALTER (ulp.sources identity columns) or a failed v29 ADD INDEX is not recorded as done, so the next start tries it again. */
export function ddlVersionToRecord(sourcesIdentityFailed: boolean, addressIndexFailed = false): number {
  if (sourcesIdentityFailed) return DDL_BEFORE_SOURCES_IDENTITY
  return addressIndexFailed ? DDL_BEFORE_ADDRESS_INDEX : DDL_VERSION
}
```

with:

```ts
// v30: norm_key_hash, the key an import matches on once every part holds it (docs/superpowers/specs/2026-11-01-near-duplicates-design.md): a leading www., capitals in the host or the login
//      and extra trailing slashes are ignored. ADD COLUMN IF NOT EXISTS is metadata only; parts written from now on carry the value. Existing parts get it with MATERIALIZE COLUMN, NOT fired
//      here (see v23: start-up must not be coupled to a mutation): scripts/materialize-norm-key.sh, supervised. Until every part has it the importer keeps the exact key
//      (lib/norm-key-ready.ts), so the image can be deployed first. A failed ADD is not recorded as done and the next start tries again.
const DDL_VERSION = 30
const DDL_BEFORE_SOURCES_IDENTITY = 27
const DDL_BEFORE_ADDRESS_INDEX = 28
const DDL_BEFORE_NORM_KEY = 29

/** The DDL version to record after a run: a failed v28 ALTER (ulp.sources identity columns), a failed v29 ADD INDEX or a failed v30 ADD COLUMN is not recorded as done, so the next start tries it again. */
export function ddlVersionToRecord(sourcesIdentityFailed: boolean, addressIndexFailed = false, normKeyFailed = false): number {
  if (sourcesIdentityFailed) return DDL_BEFORE_SOURCES_IDENTITY
  if (addressIndexFailed) return DDL_BEFORE_ADDRESS_INDEX
  return normKeyFailed ? DDL_BEFORE_NORM_KEY : DDL_VERSION
}
```

3. Insert this block immediately before the line that starts `  // A connection that was lost at any point means statements may not have reached the server`:

```ts
  // v30 — norm_key_hash (see DDL_VERSION comment above). ADD COLUMN IF NOT EXISTS is metadata only and idempotent. The existing parts get the value from scripts/materialize-norm-key.sh,
  // never from here; until they have it the importer keeps the exact key (lib/norm-key-ready.ts), so a failure costs nothing but the feature and is tried again at the next start.
  let normKeyFailed = false
  if (lastDdl < 30) {
    try {
      await client.exec({ query: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS norm_key_hash UInt64 MATERIALIZED ${NORM_CONTENT_KEY}` })
      console.warn('[ClickHouse migration] DDL v30 applied (norm_key_hash column -- existing parts need scripts/materialize-norm-key.sh)')
    } catch (err) {
      normKeyFailed = true
      console.error('[ClickHouse migration] v30: ADD COLUMN norm_key_hash -- FAILED (tried again at the next start):', err instanceof Error ? err.message : String(err))
    }
  }

```

4. Replace these two lines:

```ts
  // A failed v28 or v29 keeps the recorded version below it, so the next start runs the ALTER again: an import from the archive needs the v28 columns, the lookups the v29 index.
  const ddlReached = ddlVersionToRecord(sourcesIdentityFailed, addressIndexFailed)
```

with:

```ts
  // A failed v28, v29 or v30 keeps the recorded version below it, so the next start runs the ALTER again: an import from the archive needs the v28 columns, the lookups the v29 index, the intake the v30 column.
  const ddlReached = ddlVersionToRecord(sourcesIdentityFailed, addressIndexFailed, normKeyFailed)
```

In `lib/clickhouse-migration-safety.ts`, in `MIGRATION_COLUMNS`, add `'norm_key_hash',` on the line after `'content_key_hash',`.

In `docker/clickhouse/init/01-ulp-tables.sql`, directly after the `content_key_hash` definition (the lines `content_key_hash UInt64 MATERIALIZED cityHash64(` through the closing `),`), add:

```sql

    -- norm_key_hash: the same credential as an import sees it once a leading www., capitals in the host or the login and extra trailing
    -- slashes are ignored (path, query, port and password as typed). Definition: lib/url-content-key.ts (a test locks this copy to it);
    -- DDL v30 in lib/clickhouse-migrations.ts adds it to an existing table; docs/superpowers/specs/2026-11-01-near-duplicates-design.md.
    norm_key_hash UInt64 MATERIALIZED cityHash64(
        concat(lower(extract(replaceRegexpOne(url, '^(?i:https?://)', ''), '^(?i:www\\.)?([^/?#]*)')),
               extract(replaceRegexpOne(url, '^(?i:https?://)', ''), '^[^/?#]*(.*?)/*$')),
        lower(email), password
    ),
```

In `scripts/e2e-alert-rehearsal.ts` make these five replacements (each string occurs once):

- `() => ddlRecorded() === '29', 180_000, 3000)` → `() => ddlRecorded() === '30', 180_000, 3000)`
- ``check('the DDL version recorded in SQLite is 29 (v29: the lower(email) index)', ddl === '29', `got ${ddl}`)`` → the two lines below:

```ts
    check('the DDL version recorded in SQLite is 30 (v30: the norm_key_hash column)', ddl === '30', `got ${ddl}`)
    const normKeyKind = chQuery("SELECT default_kind FROM system.columns WHERE database='ulp' AND table='credentials' AND name='norm_key_hash'")
    check('norm_key_hash exists on a fresh install as a MATERIALIZED column (the init SQL; DDL v30 found it there)', normKeyKind === 'MATERIALIZED', `got ${normKeyKind}`)
```

- `with its DDL version already at 29.` → `with its DDL version already at 30.`
- `grep -c 'DDL v29 already applied'` → `grep -c 'DDL v30 already applied'`
- `check('the recorded DDL version is still 29', ddlRecorded() === '29')` → `check('the recorded DDL version is still 30', ddlRecorded() === '30')`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/ddl-version-record.test.ts __tests__/clickhouse-migrations-startup.test.ts __tests__/url-content-key.test.ts __tests__/clickhouse-migration-safety.test.ts __tests__/ingest-stage.test.ts`
Expected: PASS. (`clickhouse-migration-safety.test.ts` "the columns are exactly those the migrations add" now sees `norm_key_hash` on both sides.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/clickhouse-migrations.ts lib/clickhouse-migration-safety.ts docker/clickhouse/init/01-ulp-tables.sql scripts/e2e-alert-rehearsal.ts __tests__/ddl-version-record.test.ts __tests__/clickhouse-migrations-startup.test.ts __tests__/url-content-key.test.ts
git commit -m "feat(near-dup): DDL v30 adds norm_key_hash (metadata only); the init SQL and the start-up column check carry it" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `INGEST_NORM_KEY` and the readiness check

**Files:**
- Modify: `lib/ingest-novelty-config.ts`
- Create: `lib/norm-key-ready.ts`
- Modify: `docker-compose.yml`, `docker-compose.rehearsal.yml`, `.env.example`, `README.md`, `docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md` (a pointer), `__tests__/setup/ingest-novelty-off.ts`
- Test: `__tests__/ingest-novelty-config.test.ts` (extend), `__tests__/norm-key-ready.test.ts` (new), `__tests__/novelty-wiring.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `lib/ingest-novelty-config.ts`: `normKeyEnabled(env?: NodeJS.Dict<string>): boolean`; `COMMIT_EXTERNAL_SORT_BYTES = 1_073_741_824`.
  - `lib/norm-key-ready.ts`: `type MatchKey = 'norm' | 'exact'`; `type KeyColumn = 'norm_key_hash' | 'content_key_hash'`; `keyColumnOf(key: MatchKey): KeyColumn`; `buildNormKeyReadySql(): string`; `normKeyReadyFrom(row: Record<string, unknown> | undefined): boolean`; `isNormKeyReady(run?, now?): Promise<boolean>`; `resolveMatchKey(opts?: { env?: NodeJS.Dict<string>; run?; now? }): Promise<MatchKey>`; `resetNormKeyReadyCache(): void`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/ingest-novelty-config.test.ts`, replace the import block

```ts
import {
  COMMIT_MAX_EXECUTION_S,
  DEFAULT_COMMIT_INSERT_THREADS,
  DEFAULT_NOVELTY_SLAB_ROWS,
  MIN_NOVELTY_SLAB_ROWS,
  commitInsertThreads,
  noveltyConfig,
  slabCount,
} from '@/lib/ingest-novelty-config'
```

with

```ts
import {
  COMMIT_EXTERNAL_SORT_BYTES,
  COMMIT_MAX_EXECUTION_S,
  DEFAULT_COMMIT_INSERT_THREADS,
  DEFAULT_NOVELTY_SLAB_ROWS,
  MIN_NOVELTY_SLAB_ROWS,
  commitInsertThreads,
  normKeyEnabled,
  noveltyConfig,
  slabCount,
} from '@/lib/ingest-novelty-config'
```

and append at the end of the file:

```ts

describe('normKeyEnabled', () => {
  it('is on by default', () => {
    expect(normKeyEnabled(env())).toBe(true)
  })

  it.each(['off', 'OFF', '0', 'false', ' False '])('INGEST_NORM_KEY=%j switches it off', raw => {
    expect(normKeyEnabled(env({ INGEST_NORM_KEY: raw }))).toBe(false)
  })

  it.each(['', 'on', '1', 'true', 'yes'])('INGEST_NORM_KEY=%j leaves it on', raw => {
    expect(normKeyEnabled(env({ INGEST_NORM_KEY: raw }))).toBe(true)
  })

  it('bounds the memory of the commit sort at 1 GiB before it spills to disk', () => {
    expect(COMMIT_EXTERNAL_SORT_BYTES).toBe(1_073_741_824)
  })
})
```

Create `__tests__/norm-key-ready.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ getClient: vi.fn() }))

import {
  buildNormKeyReadySql,
  isNormKeyReady,
  keyColumnOf,
  normKeyReadyFrom,
  resetNormKeyReadyCache,
  resolveMatchKey,
} from '@/lib/norm-key-ready'

const READY = { defined: '1', parts: '16', with_column: '16' }
const MISSING_ONE = { defined: '1', parts: '16', with_column: '15' }
const warnings = () => vi.mocked(console.warn).mock.calls.map(c => String(c[0]))

let clock = 0
const now = () => clock

beforeEach(() => {
  resetNormKeyReadyCache()
  clock = 1_000_000
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('keyColumnOf', () => {
  it('maps the two rules to their columns', () => {
    expect(keyColumnOf('norm')).toBe('norm_key_hash')
    expect(keyColumnOf('exact')).toBe('content_key_hash')
  })
})

describe('buildNormKeyReadySql', () => {
  it('is metadata only: it reads the catalogue and never ulp.credentials itself', () => {
    const sql = buildNormKeyReadySql()
    expect(sql).toContain('system.columns')
    expect(sql).toContain('system.parts ')
    expect(sql).toContain('system.parts_columns')
    expect(sql).toContain("column = 'norm_key_hash'")
    expect(sql).toContain('active')
    expect(sql).not.toMatch(/FROM ulp\./)
  })
})

describe('normKeyReadyFrom', () => {
  it.each([
    [{ defined: '1', parts: '16', with_column: '16' }, true],
    [{ defined: 1, parts: 3, with_column: 3 }, true],
    [{ defined: '1', parts: '0', with_column: '0' }, true], // an empty table is complete
    [{ defined: '1', parts: '16', with_column: '15' }, false], // a part that lacks the column
    [{ defined: '0', parts: '0', with_column: '0' }, false], // no column at all
    [{ defined: '1', parts: '3', with_column: '4' }, false], // an answer that cannot be right
    [{ defined: '1', parts: 'x', with_column: 'x' }, false],
    [{}, false],
    [undefined, false],
  ])('%j is %s', (row, want) => {
    expect(normKeyReadyFrom(row as Record<string, unknown> | undefined)).toBe(want)
  })
})

describe('isNormKeyReady', () => {
  it('asks the catalogue once and remembers a ready answer for 60 s', async () => {
    const run = vi.fn().mockResolvedValue([READY])
    expect(await isNormKeyReady(run, now)).toBe(true)
    clock += 59_000
    expect(await isNormKeyReady(run, now)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    clock += 2_000
    expect(await isNormKeyReady(run, now)).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('remembers a not-ready answer for 5 s only, so a finished backfill is noticed quickly', async () => {
    const run = vi.fn().mockResolvedValueOnce([MISSING_ONE]).mockResolvedValue([READY])
    expect(await isNormKeyReady(run, now)).toBe(false)
    clock += 4_000
    expect(await isNormKeyReady(run, now)).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    clock += 2_000
    expect(await isNormKeyReady(run, now)).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('fails closed: an error is "not ready", is logged, and is asked again after 5 s', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue([READY])
    expect(await isNormKeyReady(run, now)).toBe(false)
    expect(warnings().some(w => w.includes('connection refused'))).toBe(true)
    clock += 6_000
    expect(await isNormKeyReady(run, now)).toBe(true)
  })

  it('lets concurrent callers share one query', async () => {
    let release!: (rows: Array<Record<string, unknown>>) => void
    const run = vi.fn(() => new Promise<Array<Record<string, unknown>>>(resolve => { release = resolve }))
    const a = isNormKeyReady(run, now)
    const b = isNormKeyReady(run, now)
    release([READY])
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('resolveMatchKey', () => {
  it('is exact, without asking anything, when the setting is off', async () => {
    const run = vi.fn()
    expect(await resolveMatchKey({ env: { INGEST_NORM_KEY: 'off' }, run, now })).toBe('exact')
    expect(run).not.toHaveBeenCalled()
  })

  it('is norm when the setting is on and the column is complete', async () => {
    const run = vi.fn().mockResolvedValue([READY])
    expect(await resolveMatchKey({ env: {}, run, now })).toBe('norm')
  })

  it('is exact when the column is not complete in every part', async () => {
    const run = vi.fn().mockResolvedValue([MISSING_ONE])
    expect(await resolveMatchKey({ env: {}, run, now })).toBe('exact')
  })

  it('says which key is in use when it changes, not on every import', async () => {
    const run = vi.fn().mockResolvedValue([READY])
    await resolveMatchKey({ env: {}, run, now })
    await resolveMatchKey({ env: {}, run, now })
    expect(warnings().filter(w => /normalised key/.test(w))).toHaveLength(1)
    clock += 120_000
    run.mockResolvedValue([MISSING_ONE])
    await resolveMatchKey({ env: {}, run, now })
    await resolveMatchKey({ env: {}, run, now })
    expect(warnings().filter(w => /exact key/.test(w))).toHaveLength(1)
  })
})
```

In `__tests__/novelty-wiring.test.ts`, add inside the existing `describe('novelty-aware ingest wiring', ...)` block, after the last `it(...)`:

```ts

  it('forwards INGEST_NORM_KEY through the production compose file, lets the rehearsal compose choose it, and documents it', () => {
    expect(read('docker-compose.yml')).toContain('INGEST_NORM_KEY: ${INGEST_NORM_KEY:-}')
    expect(read('docker-compose.rehearsal.yml')).toContain('INGEST_NORM_KEY: ${REHEARSAL_INGEST_NORM_KEY:-}')
    expect(read('.env.example')).toContain('INGEST_NORM_KEY')
    expect(read('README.md')).toContain('INGEST_NORM_KEY')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/ingest-novelty-config.test.ts __tests__/norm-key-ready.test.ts __tests__/novelty-wiring.test.ts`
Expected: FAIL (`normKeyEnabled` and `@/lib/norm-key-ready` do not exist; the compose files lack the setting).

- [ ] **Step 3: Write the implementation**

In `lib/ingest-novelty-config.ts`:

1. In the header comment, add after the `INGEST_COMMIT_INSERT_THREADS` entry (inside the comment block):

```
 *   INGEST_NORM_KEY           default on. off | 0 | false matches imports on the exact key (content_key_hash) everywhere. When on, the normalised key
 *                             (norm_key_hash) is used once every part of ulp.credentials holds it (lib/norm-key-ready.ts).
```

2. After the `COMMIT_MAX_EXECUTION_S` constant add:

```ts

/** The sort of a normalised-key commit spills to disk above this many bytes (max_bytes_before_external_sort) instead of growing ClickHouse's memory. */
export const COMMIT_EXTERNAL_SORT_BYTES = 1_073_741_824
```

3. After `noveltyConfig` add:

```ts

/** INGEST_NORM_KEY: on unless `off`, `0` or `false`. Whether the normalised key may be used at all; lib/norm-key-ready.ts decides when it can be. */
export function normKeyEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  const flag = (env.INGEST_NORM_KEY ?? '').trim().toLowerCase()
  return !(flag === 'off' || flag === '0' || flag === 'false')
}
```

Create `lib/norm-key-ready.ts`:

```ts
/**
 * Which key an import matches on (docs/superpowers/specs/2026-11-01-near-duplicates-design.md).
 *
 *   exact  content_key_hash: the URL without its scheme and one trailing slash, the login and the password as stored (since 2026-06-28).
 *   norm   norm_key_hash:    also ignores a leading www., capitals in the host and in the login, and extra trailing slashes.
 *
 * norm is used only when INGEST_NORM_KEY is not off AND the column is complete: it exists, and every active part of ulp.credentials holds it. A part
 * that lacks the column computes it on the fly, which gives the right value but reads three columns instead of one, so an import must not take that
 * path; until the backfill (scripts/materialize-norm-key.sh) has finished the importer keeps the exact key, and the image can be deployed first.
 *
 * The check is metadata only (the catalogue, never the table), fails CLOSED (any error or odd answer means exact), and is remembered for 60 s when
 * ready and 5 s when not, like the Newest-first readiness gate (lib/newest-first.ts). A file chooses once, before its first slab, and never mixes keys.
 */
import { getClient } from '@/lib/clickhouse'
import { normKeyEnabled } from '@/lib/ingest-novelty-config'

export type MatchKey = 'norm' | 'exact'
export type KeyColumn = 'norm_key_hash' | 'content_key_hash'

export const keyColumnOf = (key: MatchKey): KeyColumn => (key === 'norm' ? 'norm_key_hash' : 'content_key_hash')

type Run = (sql: string) => Promise<Array<Record<string, unknown>>>

const READY_TTL_MS = 60_000
const NOT_READY_TTL_MS = 5_000

/** Three numbers from the catalogue: is the column defined, how many parts are active, and how many of them list the column. */
export function buildNormKeyReadySql(): string {
  return `SELECT
  (SELECT count() FROM system.columns WHERE database = 'ulp' AND table = 'credentials' AND name = 'norm_key_hash') AS defined,
  (SELECT count() FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active) AS parts,
  (SELECT uniqExact(name) FROM system.parts_columns WHERE database = 'ulp' AND table = 'credentials' AND active AND column = 'norm_key_hash') AS with_column`
}

/** Complete: the column is defined and every active part lists it. An empty table is complete. Anything odd is not. */
export function normKeyReadyFrom(row: Record<string, unknown> | undefined): boolean {
  const defined = Number(row?.defined)
  const parts = Number(row?.parts)
  const withColumn = Number(row?.with_column)
  return defined === 1 && Number.isFinite(parts) && Number.isFinite(withColumn) && parts === withColumn
}

async function clickhouseRun(sql: string): Promise<Array<Record<string, unknown>>> {
  const res = await getClient().query({ query: sql, format: 'JSONEachRow', clickhouse_settings: { use_query_cache: 0 } })
  return (await res.json()) as Array<Record<string, unknown>>
}

let cache: { at: number; ttl: number; ready: boolean } | null = null
let inflight: Promise<boolean> | null = null
let announced: MatchKey | null = null

/** Test seam. */
export function resetNormKeyReadyCache(): void {
  cache = null
  inflight = null
  announced = null
}

export async function isNormKeyReady(run: Run = clickhouseRun, now: () => number = Date.now): Promise<boolean> {
  if (cache && now() - cache.at < cache.ttl) return cache.ready
  if (inflight) return inflight
  inflight = (async () => {
    let ready = false
    try {
      const [row] = await run(buildNormKeyReadySql())
      ready = normKeyReadyFrom(row)
    } catch (err) {
      console.warn('[norm-key] the readiness check failed -- matching on the exact key:', err instanceof Error ? err.message : String(err))
    }
    cache = { at: now(), ttl: ready ? READY_TTL_MS : NOT_READY_TTL_MS, ready }
    return ready
  })()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

/** Says which key is in use when it changes (once per change, not per import): docker logs is where an operator looks. */
function announce(key: MatchKey, why?: string): MatchKey {
  if (announced !== key) {
    announced = key
    const which = key === 'norm' ? 'normalised key (norm_key_hash)' : 'exact key (content_key_hash)'
    console.warn(`[ingest-novelty] matching imports on the ${which}${why ? `: ${why}` : ''}`)
  }
  return key
}

/** The key one import matches on. Never throws. */
export async function resolveMatchKey(opts: { env?: NodeJS.Dict<string>; run?: Run; now?: () => number } = {}): Promise<MatchKey> {
  if (!normKeyEnabled(opts.env)) return announce('exact', 'INGEST_NORM_KEY is off')
  if (await isNormKeyReady(opts.run, opts.now)) return announce('norm')
  return announce('exact', 'norm_key_hash is not complete in every part yet')
}
```

In `docker-compose.yml`, directly after the line `      INGEST_NOVELTY_SLAB_ROWS: ${INGEST_NOVELTY_SLAB_ROWS:-}` add:

```yaml
      # Near-duplicates (docs/superpowers/specs/2026-11-01-near-duplicates-design.md) -- optional; forwarded explicitly (see above). On by default: an import
      # matches on the normalised key (a leading www., capitals in the host or the login and extra trailing slashes ignored) once every part of
      # ulp.credentials holds norm_key_hash, and on the exact key before that. INGEST_NORM_KEY=off matches on the exact key everywhere.
      INGEST_NORM_KEY: ${INGEST_NORM_KEY:-}
```

In `docker-compose.rehearsal.yml`, directly after the line `      INGEST_NOVELTY_SLAB_ROWS: ${REHEARSAL_INGEST_NOVELTY_SLAB_ROWS:-}` add:

```yaml
      # scripts/e2e-novelty-ingest.ts (scenario lookalikes) switches the normalised key off with this (empty = the production default: on).
      INGEST_NORM_KEY: ${REHEARSAL_INGEST_NORM_KEY:-}
```

In `.env.example`, between the lines `# INGEST_NOVELTY_SLAB_ROWS=20000000` and `# ── Import speed (fast ingest, step A)`, add:

```
# ── Near-duplicates ──────────────────────────────────────────────────────────
# On by default. An import matches a credential on its normalised key once every part of ulp.credentials holds norm_key_hash
# (DDL v30 adds the column, scripts/materialize-norm-key.sh fills it): a leading www., capitals in the host or the login and
# extra trailing slashes are ignored, so those look-alikes count as already in the database instead of being stored again.
# Until the column is complete in every part it matches on the exact key (content_key_hash), as before.
#   INGEST_NORM_KEY=off          match on the exact key (content_key_hash) everywhere
# INGEST_NORM_KEY=
```

In `README.md`, directly after the two lines of the `INGEST_NOVELTY_SLAB_ROWS` bullet (`  this are committed in one step; larger ones in hash slabs, one slab at a time across all imports.`) add:

```
- `INGEST_NORM_KEY` — near-duplicates, on by default (`lib/norm-key-ready.ts`,
  `docs/superpowers/specs/2026-11-01-near-duplicates-design.md`). An import matches a credential on `norm_key_hash`
  (a leading `www.`, capitals in the host or the login and extra trailing slashes ignored; path, port, query and
  password as typed) once every part of `ulp.credentials` holds the column, and on `content_key_hash` before that; each
  job records the rule it used (`processing_jobs.match_key`). `off`, `0` or `false` matches on `content_key_hash`
  everywhere. DDL v30 adds the column; `scripts/materialize-norm-key.sh` fills it (supervised, one partition at a time).
```

and, directly before the line `### Content deduplication (storage)`, add:

```
### Near-duplicates

The Unique toggle and the storage dedup below compare the exact key: the URL without its scheme and one trailing slash, and the login and the password as stored. Rows that differ only by a leading `www.`, capitals in the host or in the login, or extra trailing slashes are therefore separate rows (about 8% of the table when measured on 2026-11-01). Imports match on the normalised key (`INGEST_NORM_KEY`) once the `norm_key_hash` backfill is done, so those look-alikes are counted as already in the database and are not stored again. The ones already stored stay until an explicit, separately approved removal (Stage 2 of `docs/superpowers/specs/2026-11-01-near-duplicates-design.md`).

```

In `docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md`, add this line directly above the line that starts `Reference table:`:

```
Follow-up: the key an import matches on can be the normalised one (a leading www., capitals in the host or the login and extra trailing slashes ignored): docs/superpowers/specs/2026-11-01-near-duplicates-design.md.
```

Append to `__tests__/setup/ingest-novelty-off.ts`:

```ts
// The normalised key asks the catalogue which key to use (lib/norm-key-ready.ts), which the same mocked clients cannot answer. The suites that
// exercise it pass `env` explicitly or mock the module; scripts/e2e-novelty-ingest.ts exercises it for real.
process.env.INGEST_NORM_KEY = 'off'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/ingest-novelty-config.test.ts __tests__/norm-key-ready.test.ts __tests__/novelty-wiring.test.ts __tests__/url-content-key-docs.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/ingest-novelty-config.ts lib/norm-key-ready.ts docker-compose.yml docker-compose.rehearsal.yml .env.example README.md docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md __tests__/setup/ingest-novelty-off.ts __tests__/ingest-novelty-config.test.ts __tests__/norm-key-ready.test.ts __tests__/novelty-wiring.test.ts
git commit -m "feat(near-dup): INGEST_NORM_KEY and the catalogue readiness check that decides which key an import uses" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The stage and the commit take a key column

**Files:**
- Modify: `lib/ingest-stage.ts` (the stage gets the column; the known table's column is renamed `key_hash`)
- Modify: `lib/ingest-novelty.ts` (the builders and `commitStage` take the key column; the sort bound joins the commit settings)
- Test: `__tests__/ingest-stage.test.ts`, `__tests__/ingest-novelty-sql.test.ts`, `__tests__/ingest-novelty-commit.test.ts`

**Interfaces:**
- Consumes: `NORM_CONTENT_KEY` (Task 1); `type KeyColumn` from `@/lib/norm-key-ready` and `COMMIT_EXTERNAL_SORT_BYTES` from `@/lib/ingest-novelty-config` (Task 3).
- Produces, from `lib/ingest-novelty.ts` (every new parameter is the LAST one and defaults to `DEFAULT_KEY`, so a caller that passes nothing gets today's statements):
  - `const DEFAULT_KEY: KeyColumn` (`'content_key_hash'`)
  - `slabPredicate(K, k, key?)`, `slabDistinctSql(t, K, k, key?)`, `knownFillSql(t, against, K, k, key?)`, `commitInsertSql(t, target, K, k, key?)`, `monitorStageSql(t, K, k, monitor, limit, key?)`
  - `CommitOptions.keyColumn?: KeyColumn`
  - the known table is `(key_hash UInt64)`; every `NOT IN` reads `SELECT key_hash FROM <known>`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/ingest-stage.test.ts`:

1. Replace `import { URL_CONTENT_KEY } from '@/lib/url-content-key'` with `import { NORM_CONTENT_KEY, URL_CONTENT_KEY } from '@/lib/url-content-key'`.
2. In the test `makes a plain, unpartitioned MergeTree stage ...`, after the line `expect(squash(ddl)).toContain(squash(\`content_key_hash UInt64 MATERIALIZED cityHash64(${URL_CONTENT_KEY}, email, password)\`))` add:
```ts
    expect(squash(ddl)).toContain(squash(`norm_key_hash UInt64 MATERIALIZED ${NORM_CONTENT_KEY}`))
```
3. In the test `makes a small known table ordered by the hash`, replace the expected string with:
```ts
      'CREATE TABLE IF NOT EXISTS ulp.zz_import_known_0123456789ab (key_hash UInt64) ENGINE = MergeTree ORDER BY key_hash',
```
4. In the test `computes the hash exactly as the live table does (drift test)`, after `expect(squash(stageDdl(t))).toContain(expected)` add:
```ts
    expect(squash(stageDdl(t))).toContain(squash(NORM_CONTENT_KEY))
```

In `__tests__/ingest-novelty-sql.test.ts`:

1. In `inserts one row per new hash, in the six insert columns only`, replace the line
`'WHERE content_key_hash % 3 = 1 AND content_key_hash NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)\n' +`
with
`'WHERE content_key_hash % 3 = 1 AND content_key_hash NOT IN (SELECT key_hash FROM ulp.zz_import_known_0123456789ab)\n' +`
2. In `matches the not-yet-known rows of the slab with one normalisation per row`, replace the line
`expect(q.sql).toContain('WHERE content_key_hash % 3 = 1 AND content_key_hash NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)')`
with
`expect(q.sql).toContain('WHERE content_key_hash % 3 = 1 AND content_key_hash NOT IN (SELECT key_hash FROM ulp.zz_import_known_0123456789ab)')`
3. In the first `clickhouseNoveltyDb` test (`runs a statement with the commit settings ...`), the line
`expect(call.clickhouse_settings).toEqual({ max_execution_time: 3300, insert_deduplicate: 0, async_insert: 0, use_query_cache: 0 })` compares the whole settings object; replace it with
```ts
    expect(call.clickhouse_settings).toEqual({
      max_execution_time: 3300, insert_deduplicate: 0, async_insert: 0, use_query_cache: 0, max_bytes_before_external_sort: 1_073_741_824,
    })
```
4. Insert this block immediately before the line `describe('clickhouseNoveltyDb', () => {`:

```ts
describe('SQL builders with the normalised key', () => {
  it('cut the slabs, count and probe on norm_key_hash, so every look-alike lands in the slab of its credential', () => {
    expect(slabPredicate(3, 1, 'norm_key_hash')).toBe('norm_key_hash % 3 = 1')
    expect(slabDistinctSql(t, 3, 1, 'norm_key_hash')).toBe(
      'SELECT uniqExact(norm_key_hash) AS c FROM ulp.zz_import_stage_0123456789ab WHERE norm_key_hash % 3 = 1',
    )
    expect(knownFillSql(t, 'ulp.credentials', 3, 1, 'norm_key_hash')).toBe(
      'INSERT INTO ulp.zz_import_known_0123456789ab\n' +
      'SELECT DISTINCT norm_key_hash FROM ulp.credentials\n' +
      'WHERE norm_key_hash IN (SELECT norm_key_hash FROM ulp.zz_import_stage_0123456789ab WHERE norm_key_hash % 3 = 1)',
    )
  })

  it('insert the first row of each key by (url, email); the exact key keeps the statement it always had', () => {
    expect(commitInsertSql(t, 'ulp.credentials', 3, 1, 'norm_key_hash')).toBe(
      'INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name)\n' +
      'SELECT url, email, password, domain, source_file, breach_name FROM ulp.zz_import_stage_0123456789ab\n' +
      'WHERE norm_key_hash % 3 = 1 AND norm_key_hash NOT IN (SELECT key_hash FROM ulp.zz_import_known_0123456789ab)\n' +
      'ORDER BY url, email\n' +
      'LIMIT 1 BY norm_key_hash',
    )
    expect(commitInsertSql(t, 'ulp.credentials', 3, 1, 'content_key_hash')).not.toContain('ORDER BY')
    expect(commitInsertSql(t, 'ulp.credentials', 3, 1)).toBe(commitInsertSql(t, 'ulp.credentials', 3, 1, 'content_key_hash'))
  })

  it('sort the monitor query the same way, after its WHERE, so it sorts only the matching rows', () => {
    const monitor = { domains: ['example.test'], match_mode: 'both' as const }
    const q = monitorStageSql(t, 3, 1, monitor, 50, 'norm_key_hash')!
    expect(q.sql).toContain('WHERE norm_key_hash % 3 = 1 AND norm_key_hash NOT IN (SELECT key_hash FROM ulp.zz_import_known_0123456789ab)')
    expect(q.sql).toMatch(/\) WHERE [\s\S]*\nORDER BY url, email\nLIMIT 1 BY norm_key_hash\nLIMIT 50$/)
    expect(monitorStageSql(t, 3, 1, monitor, 50)!.sql).not.toContain('ORDER BY')
  })
})

```

Append to the end of `__tests__/ingest-novelty-commit.test.ts`:

```ts

describe('commitStage with the normalised key', () => {
  it('cuts the slabs, probes the table and inserts on norm_key_hash, and sorts the new rows by (url, email)', async () => {
    const db = makeDb({ stageRows: 2000, distinct: [900, 800], known: [100, 0] })
    await commitStage(options(db, { parsedRows: 2000, slabRows: 1000, keyColumn: 'norm_key_hash' }))
    for (const c of db.calls) expect(c.sql).not.toContain('content_key_hash')
    expect(db.calls.find(c => c.sql.startsWith('SELECT uniqExact'))!.sql).toContain('uniqExact(norm_key_hash)')
    const inserts = db.calls.filter(c => c.sql.startsWith('INSERT INTO ulp.credentials'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0].sql).toContain('norm_key_hash % 2 = 0')
    expect(inserts[1].sql).toContain('norm_key_hash % 2 = 1')
    for (const i of inserts) {
      expect(i.sql).toContain('NOT IN (SELECT key_hash FROM ulp.zz_import_known_0123456789ab)')
      expect(i.sql).toContain('ORDER BY url, email\nLIMIT 1 BY norm_key_hash')
    }
  })

  it('asks the monitor question on the same key, sorted the same way', async () => {
    const db = makeDb({ stageRows: 100, distinct: [100], known: [10], monitorRows: [] })
    await commitStage(options(db, {
      parsedRows: 100, keyColumn: 'norm_key_hash', monitors: [{ id: 1, domains: ['example.test'], match_mode: 'both' }], matchCap: 5,
    }))
    const q = db.calls.find(c => c.sql.startsWith('SELECT url, email, password, domain FROM ('))!
    expect(q.sql).toContain('norm_key_hash NOT IN (SELECT key_hash FROM ulp.zz_import_known_0123456789ab)')
    expect(q.sql).toContain('ORDER BY url, email\nLIMIT 1 BY norm_key_hash')
  })

  it('keeps the statements it always had when no key is given', async () => {
    const db = makeDb({ stageRows: 100, distinct: [100], known: [10] })
    await commitStage(options(db, { parsedRows: 100 }))
    for (const c of db.calls) expect(c.sql).not.toContain('norm_key_hash')
    expect(db.calls.find(c => c.sql.startsWith('INSERT INTO ulp.credentials'))!.sql).not.toContain('ORDER BY')
  })
})
```

In `__tests__/ingest-novelty-commit.test.ts`, also make these two one-line replacements (each occurs once): in `writes only what the table does not hold`, `expect(insert.sql).toContain('NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)')` becomes `expect(insert.sql).toContain('NOT IN (SELECT key_hash FROM ulp.zz_import_known_0123456789ab)')`; in `matches the new rows of each slab on the stage ...`, `expect(q.sql).toContain('NOT IN (SELECT content_key_hash FROM ulp.zz_import_known_0123456789ab)')` becomes `expect(q.sql).toContain('NOT IN (SELECT key_hash FROM ulp.zz_import_known_0123456789ab)')`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/ingest-stage.test.ts __tests__/ingest-novelty-sql.test.ts __tests__/ingest-novelty-commit.test.ts`
Expected: FAIL (the stage has no `norm_key_hash`, the known table is still `content_key_hash`, the builders take no key, the settings lack the sort bound).

- [ ] **Step 3: Write the implementation**

In `lib/ingest-stage.ts`:

1. Replace `import { URL_CONTENT_KEY } from '@/lib/url-content-key'` with `import { NORM_CONTENT_KEY, URL_CONTENT_KEY } from '@/lib/url-content-key'`.
2. In the header comment, replace ` * columns and the same \`content_key_hash\` the live table materialises.` with ` * columns and the same \`content_key_hash\` and \`norm_key_hash\` the live table materialises (an import matches on one of them: lib/norm-key-ready.ts).`
3. In `stageDdl`, replace the line `  content_key_hash UInt64 MATERIALIZED cityHash64(${URL_CONTENT_KEY}, email, password)` with:
```ts
  content_key_hash UInt64 MATERIALIZED cityHash64(${URL_CONTENT_KEY}, email, password),
  norm_key_hash UInt64 MATERIALIZED ${NORM_CONTENT_KEY}
```
4. Replace the body of `knownDdl` with:
```ts
export function knownDdl(t: StageTables): string {
  // One column whatever the key: it holds the slab's hashes that the live table already has, of content_key_hash or of norm_key_hash.
  return `CREATE TABLE IF NOT EXISTS ${t.known} (key_hash UInt64) ENGINE = MergeTree ORDER BY key_hash`
}
```

In `lib/ingest-novelty.ts`:

1. Header comment: before the line ` * Settings travel as client settings: the client's default max_execution_time is 60 s and a slab takes minutes.` add:
```
 * Which hash the slabs, the probe and the insert use is a parameter (`KeyColumn`): the exact `content_key_hash` as before, or `norm_key_hash`
 * (lib/norm-key-ready.ts decides per import). On the normalised key the insert and the monitor query pick the first row of a key by (url, email).
 *
```
2. Replace `import { COMMIT_MAX_EXECUTION_S, commitInsertThreads, slabCount } from '@/lib/ingest-novelty-config'` with `import { COMMIT_EXTERNAL_SORT_BYTES, COMMIT_MAX_EXECUTION_S, commitInsertThreads, slabCount } from '@/lib/ingest-novelty-config'`, and add `import type { KeyColumn } from '@/lib/norm-key-ready'` on the line after `import type { StageTables } from '@/lib/ingest-stage'`.
3. Replace `slabPredicate` (comment and function) with:
```ts
/** The key a statement is built on when none is given: the exact one, so a caller that does not choose gets the statements it always had. */
export const DEFAULT_KEY: KeyColumn = 'content_key_hash'

/** The stage rows of slab `k` of `K`: the key decides, so a credential (and, on the normalised key, every look-alike of it) always lands in the same slab. */
export function slabPredicate(K: number, k: number, key: KeyColumn = DEFAULT_KEY): string {
  if (!Number.isInteger(K) || !Number.isInteger(k) || K < 1 || k < 0 || k >= K) throw new Error(`bad slab ${k} of ${K}`)
  return `${key} % ${K} = ${k}`
}
```
4. Replace `slabDistinctSql` with:
```ts
export const slabDistinctSql = (t: StageTables, K: number, k: number, key: KeyColumn = DEFAULT_KEY) =>
  `SELECT uniqExact(${key}) AS c FROM ${t.stage} WHERE ${slabPredicate(K, k, key)}`
```
5. Replace `knownFillSql` with:
```ts
export const knownFillSql = (t: StageTables, against: string, K: number, k: number, key: KeyColumn = DEFAULT_KEY) =>
  `INSERT INTO ${t.known}\n` +
  `SELECT DISTINCT ${key} FROM ${qualified(against)}\n` +
  `WHERE ${key} IN (SELECT ${key} FROM ${t.stage} WHERE ${slabPredicate(K, k, key)})`
```
6. Replace `commitInsertSql` with:
```ts
/**
 * One row per key. On the normalised key the row kept is the first by (url, email), so that the monitor query below reports the row that was stored
 * (look-alikes can differ in the login's case, and a monitor fingerprint uses the login as stored). On the exact key the statement is the one it
 * always was: exact twins differ only in the scheme or one slash, so any of them will do.
 */
export const commitInsertSql = (t: StageTables, target: string, K: number, k: number, key: KeyColumn = DEFAULT_KEY) =>
  `INSERT INTO ${qualified(target)} (url, email, password, domain, source_file, breach_name)\n` +
  `SELECT url, email, password, domain, source_file, breach_name FROM ${t.stage}\n` +
  `WHERE ${slabPredicate(K, k, key)} AND ${key} NOT IN (SELECT key_hash FROM ${t.known})\n` +
  (key === 'norm_key_hash' ? `ORDER BY url, email\n` : '') +
  `LIMIT 1 BY ${key}`
```
7. In `monitorStageSql`, add the parameter `key: KeyColumn = DEFAULT_KEY,` after `limit: number,` and replace the `const sql = ...` statement with:
```ts
  const sql =
    `SELECT url, email, password, domain FROM (\n` +
    `  SELECT url, email, password, domain, ${key}, ${match.normalizedColumns}\n` +
    `  FROM ${t.stage}\n` +
    `  WHERE ${slabPredicate(K, k, key)} AND ${key} NOT IN (SELECT key_hash FROM ${t.known})\n` +
    `) WHERE ${match.clause}\n` +
    (key === 'norm_key_hash' ? `ORDER BY url, email\n` : '') +
    `LIMIT 1 BY ${key}\n` +
    `LIMIT ${cap}`
```
8. Replace `COMMIT_SETTINGS` with:
```ts
const COMMIT_SETTINGS = {
  max_execution_time: COMMIT_MAX_EXECUTION_S,
  insert_deduplicate: 0,
  async_insert: 0,
  use_query_cache: 0,
  // Only a statement with an ORDER BY (the normalised key's) looks at this; it spills the sort to disk instead of growing memory.
  max_bytes_before_external_sort: COMMIT_EXTERNAL_SORT_BYTES,
} as unknown as ClickHouseSettings
```
9. In `CommitOptions`, after `noveltyAgainst: string` add:
```ts
  /** The hash the slabs, the probe and the insert use: 'content_key_hash' (the exact key, the default) or 'norm_key_hash' (lib/norm-key-ready.ts). */
  keyColumn?: KeyColumn
```
10. In `commitStage`, after `const insertThreads = opts.insertThreads ?? commitInsertThreads()` add `const key = opts.keyColumn ?? DEFAULT_KEY`, and pass `key` as the last argument of the four builder calls: `slabDistinctSql(t, slabs, k, key)`, `knownFillSql(t, opts.noveltyAgainst, slabs, k, key)`, `commitInsertSql(t, opts.target, slabs, k, key)`, `monitorStageSql(t, slabs, k, monitor, room, key)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/ingest-stage.test.ts __tests__/ingest-novelty-sql.test.ts __tests__/ingest-novelty-commit.test.ts __tests__/ingest-novelty-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/ingest-stage.ts lib/ingest-novelty.ts __tests__/ingest-stage.test.ts __tests__/ingest-novelty-sql.test.ts __tests__/ingest-novelty-commit.test.ts
git commit -m "feat(near-dup): the stage carries norm_key_hash; the commit builders take the key column and sort a normalised-key insert by (url, email)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The import chooses its key once, passes it on, and the job records it

**Files:**
- Modify: `lib/upload-processor.ts` (choose before the first slab, pass `keyColumn`, return `matchKey`)
- Modify: `lib/import-summary.ts` (the tally carries the rule), `lib/processing-log.ts` (`match_key` in the entry and the INSERT), `lib/sqlite.ts` (the column)
- Test: `__tests__/upload-processor-novelty.test.ts` (extend), `__tests__/import-summary.test.ts` (extend), `__tests__/processing-log-match-key.test.ts` (new)

**Interfaces:**
- Consumes: `resolveMatchKey`, `keyColumnOf`, `type MatchKey` (Task 3); `CommitOptions.keyColumn` (Task 4).
- Produces: `ProcessResult.matchKey?: MatchKey`; `JobTally.matchKey: MatchKey | null`; `addToTally(t, r)` and `tallyOf(r)` accept `r.matchKey?: MatchKey`; `jobAccounting(t)` returns `{ repeats: number; note?: string; match_key?: MatchKey }`; `JobLogEntry.match_key?: MatchKey`; `processing_jobs.match_key TEXT` (nullable). The four call sites that spread `jobAccounting(...)` into `logJob({...})` need no change.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/processing-log-match-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { dbGet, dbQuery } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

type Column = { name: string; type: string; notnull: number; dflt_value: string | null }

describe('processing_jobs.match_key', () => {
  it('exists in the application database as a nullable TEXT column, so a job from before reads NULL, which means the exact key', () => {
    const cols = dbQuery('PRAGMA table_info(processing_jobs)') as Column[]
    expect(cols.find(c => c.name === 'match_key')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
  })

  it('logJob stores the rule an import matched on', () => {
    logJob({ source: 'inbox', filename: 'mk-a.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10, match_key: 'norm' })
    logJob({ source: 'inbox', filename: 'mk-b.txt', status: 'done', imported: 5, skipped: 1, duration_ms: 10, match_key: 'exact' })
    expect(dbGet('SELECT match_key FROM processing_jobs WHERE filename = ?', ['mk-a.txt'])).toEqual({ match_key: 'norm' })
    expect(dbGet('SELECT match_key FROM processing_jobs WHERE filename = ?', ['mk-b.txt'])).toEqual({ match_key: 'exact' })
  })

  it('stores nothing for a job that was not matched (the direct path, a failed or held file)', () => {
    logJob({ source: 'inbox', filename: 'mk-c.txt', status: 'failed', imported: 0, skipped: 0, duration_ms: 10 })
    expect(dbGet('SELECT match_key FROM processing_jobs WHERE filename = ?', ['mk-c.txt'])).toEqual({ match_key: null })
  })
})
```

In `__tests__/import-summary.test.ts`, replace the helper line

```ts
const entry = (over: Partial<{ inFileDuplicates: number; alreadyImported: boolean; errors: number }> = {}) => ({ inFileDuplicates: 0, alreadyImported: false, errors: 0, ...over })
```

with

```ts
const entry = (over: Partial<{ inFileDuplicates: number; alreadyImported: boolean; errors: number; matchKey: 'norm' | 'exact' }> = {}) => ({ inFileDuplicates: 0, alreadyImported: false, errors: 0, ...over })
```

and append at the end of the file:

```ts

describe('the job tally records the rule the entries were matched on', () => {
  it('is norm only while every matched entry used it, and exact as soon as one did not', () => {
    const t = newJobTally()
    addToTally(t, entry({ matchKey: 'norm' }))
    addToTally(t, entry({ matchKey: 'norm' }))
    expect(jobAccounting(t)).toEqual({ repeats: 0, match_key: 'norm' })
    addToTally(t, entry({ matchKey: 'exact' }))
    expect(jobAccounting(t).match_key).toBe('exact')
    addToTally(t, entry({ matchKey: 'norm' }))
    expect(jobAccounting(t).match_key).toBe('exact')
  })

  it('records nothing for entries that were never matched (the direct path, a file the same-name check skipped)', () => {
    const t = newJobTally()
    addToTally(t, entry({ alreadyImported: true }))
    expect(jobAccounting(t)).toEqual({ repeats: 0, note: ALREADY_IMPORTED_NOTE })
    expect(jobAccounting(newJobTally())).toEqual({ repeats: 0 })
  })

  it('ignores a failed entry, as the rest of the tally does', () => {
    const t = newJobTally()
    addToTally(t, entry({ errors: 1, matchKey: 'exact' }))
    addToTally(t, entry({ matchKey: 'norm' }))
    expect(jobAccounting(t).match_key).toBe('norm')
  })

  it('tallyOf carries the key of a single file', () => {
    expect(jobAccounting(tallyOf({ inFileDuplicates: 3, alreadyImported: false, errors: 0, matchKey: 'norm' }))).toEqual({ repeats: 3, match_key: 'norm' })
  })
})
```

In `__tests__/upload-processor-novelty.test.ts`:

1. In the hoisted `h` object replace
```ts
  commitStage: vi.fn(),
  updateJob: vi.fn(),
}))
```
with
```ts
  commitStage: vi.fn(),
  resolveMatchKey: vi.fn(),
  updateJob: vi.fn(),
}))
```
2. After the line `vi.mock('@/lib/ingest-novelty', () => ({ commitStage: h.commitStage }))` add:
```ts
vi.mock('@/lib/norm-key-ready', async () => {
  const actual = await vi.importActual<typeof import('@/lib/norm-key-ready')>('@/lib/norm-key-ready')
  return { ...actual, resolveMatchKey: h.resolveMatchKey }
})
```
3. In `beforeEach`, after `h.commitStage.mockResolvedValue(commitResult())` add `h.resolveMatchKey.mockResolvedValue('exact')`.
4. Append at the end of the file:

```ts

describe('processTextStream: which key the import matches on', () => {
  it('commits on the normalised key when the readiness check says the column is complete, and returns the rule', async () => {
    h.resolveMatchKey.mockResolvedValue('norm')
    const out = await processTextStream(stream(), 'novelty-norm.txt')
    expect(h.commitStage.mock.calls[0][0].keyColumn).toBe('norm_key_hash')
    expect(out.matchKey).toBe('norm')
  })

  it('commits on the exact key otherwise', async () => {
    const out = await processTextStream(stream(), 'novelty-exact.txt')
    expect(h.commitStage.mock.calls[0][0].keyColumn).toBe('content_key_hash')
    expect(out.matchKey).toBe('exact')
  })

  it('chooses once, after the file is staged and before the first slab', async () => {
    await processTextStream(stream(), 'novelty-once.txt')
    expect(h.resolveMatchKey).toHaveBeenCalledTimes(1)
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]
    expect(order(h.insert)).toBeLessThan(order(h.resolveMatchKey))
    expect(order(h.resolveMatchKey)).toBeLessThan(order(h.commitStage))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/processing-log-match-key.test.ts __tests__/import-summary.test.ts __tests__/upload-processor-novelty.test.ts`
Expected: FAIL (no `match_key` column, the tally ignores `matchKey`, `commitStage` gets no `keyColumn`).

- [ ] **Step 3: Write the implementation**

In `lib/sqlite.ts`, directly after the line `  try { db.exec(\`ALTER TABLE processing_jobs ADD COLUMN note TEXT\`) } catch {}` add:

```ts

  // Which key an import matched on (lib/norm-key-ready.ts): 'norm' or 'exact'. Additive and nullable: a job from before the normalised key reads NULL, which means the exact key.
  try { db.exec(`ALTER TABLE processing_jobs ADD COLUMN match_key TEXT`) } catch {}
```

In `lib/processing-log.ts`:

1. After `import type { PhaseTimings } from '@/lib/phase-timings'` add `import type { MatchKey } from '@/lib/norm-key-ready'`.
2. In `JobLogEntry`, after the `note?:` field add:
```ts
  /** The key the import matched on (lib/norm-key-ready.ts). Absent on the direct path and on a job from before the normalised key; a recount reads absent as 'exact'. */
  match_key?:     MatchKey
```
3. Replace the two statement lines of the INSERT
```
         (source, filename, status, imported, skipped, duration_ms, error_message, breach_name, known, gate_report, parse_ms, check_ms, insert_ms, repeats, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```
with
```
         (source, filename, status, imported, skipped, duration_ms, error_message, breach_name, known, gate_report, parse_ms, check_ms, insert_ms, repeats, note, match_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```
and after the parameter line `entry.note ?? null,` add `entry.match_key ?? null,`.

In `lib/import-summary.ts`:

1. After `import type { ImportPhase } from '@/lib/import-runner'` add `import type { MatchKey } from '@/lib/norm-key-ready'`.
2. Replace `JobTally`, `newJobTally` and `addToTally` with:
```ts
export interface JobTally {
  entries: number
  alreadyImported: number
  repeats: number
  /** The rule the entries were matched on (lib/norm-key-ready.ts); null until one was. 'norm' only while every matched entry used it. */
  matchKey: MatchKey | null
}

export const newJobTally = (): JobTally => ({ entries: 0, alreadyImported: 0, repeats: 0, matchKey: null })

/** Adds one imported file or one entry of a ZIP. An entry that failed counts for nothing: the same-name check did not skip it. */
export function addToTally(t: JobTally, r: { inFileDuplicates: number; alreadyImported: boolean; errors: number; matchKey?: MatchKey }): void {
  if (r.errors > 0) return
  t.entries++
  if (r.alreadyImported) t.alreadyImported++
  t.repeats += r.inFileDuplicates
  // One entry matched on the exact key makes the job 'exact': the weaker claim, and the one a recount checks correctly for it.
  if (r.matchKey) t.matchKey = t.matchKey === null ? r.matchKey : t.matchKey === 'norm' && r.matchKey === 'norm' ? 'norm' : 'exact'
}
```
3. Replace the signature line of `tallyOf` with `export function tallyOf(r: { inFileDuplicates: number; alreadyImported: boolean; errors: number; matchKey?: MatchKey }): JobTally {`.
4. Replace `jobAccounting` (comment and function) with:
```ts
/** The job-row fields the tally decides. The note is set only when there was at least one entry and the check skipped every one; match_key only when an entry was matched. */
export function jobAccounting(t: JobTally): { repeats: number; note?: string; match_key?: MatchKey } {
  const base = { repeats: t.repeats, ...(t.matchKey ? { match_key: t.matchKey } : {}) }
  return t.entries > 0 && t.alreadyImported === t.entries ? { ...base, note: ALREADY_IMPORTED_NOTE } : base
}
```

In `lib/upload-processor.ts`:

1. After `import { createStage, dropStage, newStageId, registerStage, stageTables, unregisterStage } from '@/lib/ingest-stage'` add:
```ts
import { keyColumnOf, resolveMatchKey, type MatchKey } from '@/lib/norm-key-ready'
```
2. In `ProcessResult`, after the `timings?:` field add:
```ts
  /** The key the import matched on (lib/norm-key-ready.ts). Set by the staged path when it committed; the direct path and a skipped file have none. */
  matchKey?:           MatchKey
```
3. In `importThroughStage`, replace
```ts
    const gateVerdict = gateCheck('final')

    const commit = await commitStage({
      tables,
      target:         'ulp.credentials',
      noveltyAgainst: 'ulp.credentials',
```
with
```ts
    const gateVerdict = gateCheck('final')

    // Once per file, after the parse and before the first slab: a file never mixes keys (lib/norm-key-ready.ts). It does not throw.
    const matchKey = await resolveMatchKey()
    hooks.beat?.()

    const commit = await commitStage({
      tables,
      target:         'ulp.credentials',
      noveltyAgainst: 'ulp.credentials',
      keyColumn:      keyColumnOf(matchKey),
```
4. In the `return { ... }` of the same function, replace
```ts
      gate:                gateVerdict && gateVerdict.level !== 'pass' ? gateVerdict.report : undefined,
      timings: {
```
with
```ts
      gate:                gateVerdict && gateVerdict.level !== 'pass' ? gateVerdict.report : undefined,
      matchKey,
      timings: {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/processing-log-match-key.test.ts __tests__/import-summary.test.ts __tests__/upload-processor-novelty.test.ts __tests__/upload-processor-gate.test.ts __tests__/upload-processor-archive-ref.test.ts __tests__/upload-processor-disk-gate.test.ts __tests__/job-routes-repeats.test.ts __tests__/processing-log-repeats.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole unit suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: no type errors; every test file passes (the same files as the baseline run before Task 1, plus the new ones).

- [ ] **Step 6: Commit**

```bash
git add lib/upload-processor.ts lib/import-summary.ts lib/processing-log.ts lib/sqlite.ts __tests__/upload-processor-novelty.test.ts __tests__/import-summary.test.ts __tests__/processing-log-match-key.test.ts
git commit -m "feat(near-dup): an import chooses its key once before the first slab, matches on it, and its job records it" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The supervised backfill

**Files:**
- Create: `scripts/materialize-norm-key.sh`
- Test: `__tests__/materialize-norm-key-script.test.ts` (new; the script runs for real against a stand-in `docker`, as `__tests__/materialize-address-index-script.test.ts` does)

**Interfaces:**
- Consumes: `NORM_CONTENT_KEY` (Task 1), read by the script through `tsx`; DDL v30's column (Task 2).
- Produces: `bash scripts/materialize-norm-key.sh` (dry run) and `APPLY=1 bash scripts/materialize-norm-key.sh`. Env: `ONLY_PARTITION` (one partition only; the final checks are then skipped), `MIN_FREE_GIB` (170), `ABORT_FREE_GIB` (155), `POLL_SECONDS` (5), `MAX_MINUTES` per partition (90), `CLICKHOUSE_CONTAINER` (`ulpsuite_clickhouse`), `DOCKER_BIN`, `TSX_BIN`. Exit codes: 0 ok, 2 precondition, 4 aborted for disk, 5 timed out, 6 mutation or check failed.

- [ ] **Step 1: Write the failing test**

Create `__tests__/materialize-norm-key-script.test.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { NORM_CONTENT_KEY } from '@/lib/url-content-key'

/**
 * scripts/materialize-norm-key.sh fills norm_key_hash in the existing parts after DDL v30. It is a mutation on a 2.6B-row table, so it is run here for
 * real against a stand-in `docker` that answers from the environment and records every statement: the stub shadows `docker` on PATH and DOCKER_HOST
 * points at a dead socket, so no test can reach a real ClickHouse (run() refuses to start unless `docker` resolves to the stub).
 */

const REPO = resolve(__dirname, '..')

const STUB_DOCKER = `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  info|inspect) exit 0 ;;
  exec) ;;
  *) exit 0 ;;
esac
sql=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--query" ]; then sql="$2"; break; fi
  shift
done
printf '%s\\n-- end of statement --\\n' "$sql" >> "$STUB_CALLS"
case "$sql" in
  *"AS column_defined"*)      echo "\${STUB_DEFINED:-1}" ;;
  *"AS pending_mutations"*)   echo "\${STUB_PENDING:-0}" ;;
  *"AS free_gib"*)            echo "\${STUB_FREE_GIB:-200}" ;;
  *"AS partition_id"*)        printf '%b' "\${STUB_PARTITIONS-202611\\\\n202610\\\\n}" ;;
  *"AS partition_complete"*)
    out=0
    for id in \${STUB_COMPLETE:-}; do
      case "$sql" in *"partition = '$id'"*) out=1 ;; esac
    done
    echo "$out" ;;
  *"AS parts_total"*)         echo "\${STUB_PARTS_TOTAL:-16}" ;;
  *"AS parts_with_column"*)   echo "\${STUB_PARTS_WITH:-16}" ;;
  *"AS mutation_state"*)      printf '%b' "\${STUB_MUTATION_STATE:-1\\\\t0\\\\t\\\\n}" ;;
  *"AS last_mutation"*)       echo "\${STUB_LAST_MUTATION-}" ;;
  *"AS norm_mismatches"*)     echo "\${STUB_MISMATCHES:-0}" ;;
  *"AS sample_rows"*)         printf '%b' "\${STUB_SAMPLE-40000000\\\\t36800000\\\\n}" ;;
  *)                          : ;;
esac
exit 0
`

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'norm-key-'))
  const stubPath = join(dir, 'docker')
  const callsPath = join(dir, 'calls.log')
  writeFileSync(stubPath, STUB_DOCKER)
  chmodSync(stubPath, 0o755)
  writeFileSync(callsPath, '')

  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(APPLY$|ONLY_|STUB_|DOCKER_|CLICKHOUSE_|MIN_FREE|ABORT_|POLL_|MAX_)/.test(k)) base[k] = v
  }
  base.PATH = [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  base.DOCKER_HOST = 'unix:///nonexistent/docker.sock'
  base.STUB_CALLS = callsPath
  base.POLL_SECONDS = '0'

  const probe = spawnSync('bash', ['-c', 'command -v docker'], { env: base as NodeJS.ProcessEnv, encoding: 'utf8' })
  if (probe.stdout.trim() !== stubPath) throw new Error(`refusing to run: docker resolves to "${probe.stdout.trim()}", not the stub`)

  const r = spawnSync('bash', [join(REPO, 'scripts', 'materialize-norm-key.sh')], {
    cwd: REPO,
    env: { ...base, ...env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), calls: readFileSync(callsPath, 'utf8') }
}

/** Every statement the script sent that is not a read, whitespace collapsed, SETTINGS dropped. */
const writes = (calls: string) =>
  calls.split('-- end of statement --').map(s => s.trim()).filter(s => /^(ALTER|KILL|INSERT|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|SYSTEM)\b/i.test(s))
    .map(s => s.replace(/\s+/g, ' ').replace(/ SETTINGS .*/, ''))

const MATERIALIZE = (p: string) => `ALTER TABLE ulp.credentials MATERIALIZE COLUMN norm_key_hash IN PARTITION '${p}'`

describe('scripts/materialize-norm-key.sh', () => {
  test('a dry run checks the preconditions, says what it would do, and changes nothing', () => {
    const r = run({})
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/dry run/i)
    expect(r.out).toContain('column: defined')
    expect(r.out).toContain('partitions (smallest first): 202611 202610')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('APPLY=1 materializes one partition at a time (smallest first), verifies, and prints the exact share of surplus rows; nothing else is written', () => {
    const r = run({ APPLY: '1' })
    expect(r.status).toBe(0)
    expect(writes(r.calls)).toEqual([MATERIALIZE('202611'), MATERIALIZE('202610')])
    expect(r.out).toContain('every one of 16 parts holds norm_key_hash')
    expect(r.out).toContain('3200000 of 40000000 in a 1/64 bucket = 8.00%')
    expect(r.calls).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|KILL MUTATION/i)
  }, 120_000)

  test('it checks the stored value against the expression the code defines, not a copy of it', () => {
    const r = run({ APPLY: '1' })
    expect(r.calls).toContain(`norm_key_hash != ${NORM_CONTENT_KEY}`)
  }, 120_000)

  test('a partition whose parts all hold the column already is not recomputed', () => {
    const r = run({ APPLY: '1', STUB_COMPLETE: '202611' })
    expect(r.status).toBe(0)
    expect(writes(r.calls)).toEqual([MATERIALIZE('202610')])
    expect(r.out).toContain('partition 202611: every part already holds norm_key_hash, skipped')
  }, 120_000)

  test('ONLY_PARTITION does one partition, reports its time and the free disk, and skips the final checks', () => {
    const r = run({ APPLY: '1', ONLY_PARTITION: '202611' })
    expect(r.status).toBe(0)
    expect(writes(r.calls)).toEqual([MATERIALIZE('202611')])
    expect(r.out).toMatch(/partition 202611 done in \d+ s; free disk \d+ GiB/)
    expect(r.out).toMatch(/final checks skipped/i)
    expect(r.calls).not.toContain('AS norm_mismatches')
  }, 120_000)

  test('ONLY_PARTITION names a partition the table has, or nothing is done', () => {
    const r = run({ APPLY: '1', ONLY_PARTITION: '299999' })
    expect(r.status).toBe(2)
    expect(r.out).toContain('299999')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses when the column is not defined (the image with DDL v30 has not started yet)', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '0' })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/no norm_key_hash column/)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses while another mutation is running', () => {
    const r = run({ APPLY: '1', STUB_PENDING: '2' })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/mutation/i)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses under MIN_FREE_GIB (170 by default)', () => {
    const r = run({ APPLY: '1', STUB_FREE_GIB: '100' })
    expect(r.status).toBe(2)
    expect(r.out).toContain('only 100 GiB free')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('free disk falling under ABORT_FREE_GIB while a mutation runs kills it and stops', () => {
    const r = run({ APPLY: '1', MIN_FREE_GIB: '10', ABORT_FREE_GIB: '150', STUB_FREE_GIB: '120', STUB_MUTATION_STATE: '0\\t3\\t\\n' })
    expect(r.status).toBe(4)
    expect(r.calls).toMatch(/KILL MUTATION WHERE database = 'ulp' AND table = 'credentials'/)
    expect(r.out).toMatch(/killed/i)
  }, 120_000)

  test('a mutation that keeps failing is reported and the script stops', () => {
    const r = run({ APPLY: '1', STUB_MUTATION_STATE: '0\\t3\\tCode: 999. boom\\n' })
    expect(r.status).toBe(6)
    expect(r.out).toContain('boom')
  }, 120_000)

  test('parts that still lack the column after the last mutation are reported: the importer keeps the exact key', () => {
    const r = run({ APPLY: '1', STUB_PARTS_WITH: '15' })
    expect(r.status).toBe(6)
    expect(r.out).toContain('only 15 of 16 parts hold norm_key_hash')
  }, 120_000)

  test('a stored value that differs from the expression on the sample is rejected', () => {
    const r = run({ APPLY: '1', STUB_MISMATCHES: '3' })
    expect(r.status).toBe(6)
    expect(r.out).toContain('3 rows of a 1/64 sample')
  }, 120_000)

  test('the checks run after the last MATERIALIZE', () => {
    const r = run({ APPLY: '1' })
    expect(r.calls.lastIndexOf('MATERIALIZE COLUMN')).toBeLessThan(r.calls.indexOf('AS norm_mismatches'))
  }, 120_000)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/materialize-norm-key-script.test.ts`
Expected: FAIL (the script does not exist: `bash` exits 127).

- [ ] **Step 3: Write the script**

Create `scripts/materialize-norm-key.sh`:

```bash
#!/usr/bin/env bash
# Fill norm_key_hash in the existing parts of ulp.credentials after DDL v30, supervised.
#
#   bash scripts/materialize-norm-key.sh                          # dry run: preconditions and what it would do; changes nothing
#   APPLY=1 bash scripts/materialize-norm-key.sh                  # materializes the column one partition at a time, verifies, prints the exact share of surplus rows
#   APPLY=1 ONLY_PARTITION=202611 bash scripts/materialize-norm-key.sh   # one partition only (the smallest first: its time and disk change predict the rest)
#
# Why: an import matches on norm_key_hash only once every part of ulp.credentials holds it (lib/norm-key-ready.ts). DDL v30 adds the definition
# (metadata; parts written from then on carry the value); the existing parts need `ALTER TABLE ulp.credentials MATERIALIZE COLUMN norm_key_hash`,
# a mutation that computes the key from url, email and password and writes one 8-byte column (about 19.5 GiB for 2.6B rows; the key computes at
# 5.4M rows a second on 8 threads, so about 8 minutes of computing for the whole table). The image can be deployed first: until the column is
# complete the importer keeps the exact key. Design: docs/superpowers/specs/2026-11-01-near-duplicates-design.md
#
# Run it with no import running (it competes for CPU on a laptop that runs hot). Never with merges stopped: SYSTEM STOP MERGES stops mutations too,
# and the wait below would never end. A partition whose parts all hold the column already is skipped (doing it again recomputes 8 bytes a row).
#
# Refuses (nothing changed) unless: the column is defined, i.e. DDL v30 ran (exit 2); no other mutation is running on the table (2); and free disk is
# at least MIN_FREE_GIB (2). While it runs it watches free space and kills the mutation below ABORT_FREE_GIB (4). It ends by checking that every
# active part holds the column (6) and that in a 1/64 sample (content_key_hash % 64 = 0) the stored value equals the expression for every row (6), and
# prints the exact share of surplus rows from a 1/64 bucket of norm_key_hash (a bucket keeps whole groups, so it is an unbiased estimate).
#
# Exit: 0 ok | 2 precondition | 4 aborted for disk | 5 timed out (the mutation is still running) | 6 the mutation failed, or a check failed.
# Needs `npm ci` in this checkout (tsx). Counts only; never prints a row.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
ONLY_PARTITION="${ONLY_PARTITION:-}"
MIN_FREE_GIB="${MIN_FREE_GIB:-170}"
ABORT_FREE_GIB="${ABORT_FREE_GIB:-155}"
POLL_SECONDS="${POLL_SECONDS:-5}"
MAX_MINUTES="${MAX_MINUTES:-90}"
CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
TSX_BIN="${TSX_BIN:-$PROJECT_DIR/node_modules/.bin/tsx}"
COLUMN="norm_key_hash"
LIMITS="SETTINGS max_threads = 6, max_memory_usage = 4000000000"

cd "$PROJECT_DIR"

if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  echo "ERROR: Docker is unavailable in this shell." >&2
  exit 1
fi
if ! "$DOCKER_BIN" inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: ClickHouse container '$CONTAINER' is not running." >&2
  exit 1
fi
if [[ ! -x "$TSX_BIN" ]]; then
  echo "ERROR: $TSX_BIN is missing (run 'npm ci' in $PROJECT_DIR)." >&2
  exit 1
fi

ch() {
  # --receive_timeout: the client's default is 300 s of silence; a query that only waits must not be abandoned.
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --receive_timeout=7200 --send_timeout=7200 --query "$1"
}

free_gib() {
  local v
  v="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
  echo "${v:-0}"
}

parts_total() {
  ch "SELECT count() AS parts_total FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active FORMAT TSVRaw"
}

parts_with_column() {
  ch "SELECT uniqExact(name) AS parts_with_column FROM system.parts_columns WHERE database = 'ulp' AND table = 'credentials' AND active AND column = '$COLUMN' FORMAT TSVRaw"
}

# 1 when every active part of the partition lists the column.
partition_complete() {
  local p="$1" complete
  complete="$(ch "SELECT (SELECT count() FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active AND partition = '$p') = (SELECT uniqExact(name) FROM system.parts_columns WHERE database = 'ulp' AND table = 'credentials' AND active AND partition = '$p' AND column = '$COLUMN') AS partition_complete FORMAT TSVRaw")"
  [[ "$complete" == "1" ]]
}

echo "ULP Suite - norm_key_hash backfill (DDL v30)"
echo "APPLY=$APPLY (0 = dry run)"
echo

# The expression comes from the code the importer's tables are built from, so the two cannot drift.
EXPR="$("$TSX_BIN" -e "import { NORM_CONTENT_KEY as e } from './lib/url-content-key'; process.stdout.write(e)")"
if [[ -z "$EXPR" ]]; then
  echo "ERROR: could not read the key from lib/url-content-key.ts." >&2
  exit 1
fi

# 1. The column must exist: the app adds it at start-up (DDL v30).
defined="$(ch "SELECT count() AS column_defined FROM system.columns WHERE database = 'ulp' AND table = 'credentials' AND name = '$COLUMN' FORMAT TSVRaw")"
if [[ "${defined:-0}" != "1" ]]; then
  echo "ERROR: ulp.credentials has no $COLUMN column. Deploy the image with DDL v30 and let the app start first." >&2
  exit 2
fi
echo "column: defined"

# 2. One mutation at a time on this table.
pending="$(ch "SELECT count() AS pending_mutations FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND NOT is_done FORMAT TSVRaw")"
pending="${pending:-0}"
if (( pending > 0 )); then
  echo "ERROR: $pending mutation(s) are still running on ulp.credentials. Wait for them (system.mutations) and retry." >&2
  exit 2
fi
echo "pending mutations: 0"

# 3. Room: the column is about 19.5 GiB in all; a mutation writes the new column's files next to the old part and links the rest.
free_now="$(free_gib)"
if (( free_now < MIN_FREE_GIB )); then
  echo "ERROR: only $free_now GiB free; need at least $MIN_FREE_GIB GiB (MIN_FREE_GIB)." >&2
  exit 2
fi
echo "free disk: $free_now GiB (need $MIN_FREE_GIB, abort below $ABORT_FREE_GIB)"

# 4. Partitions, the smallest first, so the first mutation is the cheapest measurement of what it costs.
partitions="$(ch "SELECT partition AS partition_id FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active GROUP BY partition ORDER BY sum(bytes_on_disk) ASC FORMAT TSVRaw")"
if [[ -n "$ONLY_PARTITION" ]]; then
  if ! grep -qx "$ONLY_PARTITION" <<<"$partitions"; then
    echo "ERROR: ONLY_PARTITION=$ONLY_PARTITION is not a partition of ulp.credentials ($(echo $partitions))." >&2
    exit 2
  fi
  partitions="$ONLY_PARTITION"
fi
echo "parts holding $COLUMN: $(parts_with_column) of $(parts_total)"
echo "partitions (smallest first): $(echo $partitions)"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry run: nothing was changed. Run again with APPLY=1 to materialize $COLUMN."
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────

# Newest mutation id whose command matches a LIKE pattern, read BEFORE submitting a new one, so that we only ever wait for a
# mutation NEWER than that (an earlier finished run with the same command must not pass for this one).
last_mutation_id() {
  ch "SELECT max(mutation_id) AS last_mutation FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$1' FORMAT TSVRaw"
}

# wait_for_mutation LIKE_PATTERN LABEL BEFORE_ID: poll system.mutations until the newest matching mutation after BEFORE_ID is done.
# Exit 6 if it is failing or cannot be found, 4 (after killing it) if free disk drops below ABORT_FREE_GIB, 5 on timeout.
# Submitted with mutations_sync = 0 and polled: an ALTER that waits holds a silent connection the client may abandon.
wait_for_mutation() {
  local pattern="$1" label="$2" before="$3"
  local deadline=$(( $(date +%s) + MAX_MINUTES * 60 )) not_found=0 state is_done parts_to_do fail_reason free_here
  while true; do
    state="$(ch "SELECT is_done, parts_to_do, latest_fail_reason AS mutation_state FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$pattern' AND mutation_id > '$before' ORDER BY mutation_id DESC LIMIT 1 FORMAT TSVRaw")"
    if [[ -z "$state" ]]; then
      not_found=$(( not_found + 1 ))
      if (( not_found >= 5 )); then
        echo "ERROR: the $label mutation is not in system.mutations; check it by hand before running this again." >&2
        exit 6
      fi
      sleep "$POLL_SECONDS"
      continue
    fi
    IFS=$'\t' read -r is_done parts_to_do fail_reason <<<"$state"
    if [[ -n "${fail_reason:-}" ]]; then
      echo "ERROR: the $label mutation is failing: $fail_reason" >&2
      echo "       It keeps retrying. To stop it:  docker exec $CONTAINER clickhouse-client --query \"KILL MUTATION WHERE database='ulp' AND table='credentials' AND command LIKE '$pattern' AND mutation_id > '$before'\"" >&2
      exit 6
    fi
    if [[ "${is_done:-0}" == "1" ]]; then
      return 0
    fi
    free_here="$(free_gib)"
    echo "  $(date -u +%H:%M:%S) $label: parts still to rewrite: ${parts_to_do:-?}; free disk ${free_here} GiB"
    if (( free_here < ABORT_FREE_GIB )); then
      ch "KILL MUTATION WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$pattern' AND mutation_id > '$before'" || true
      echo "ERROR: free disk fell to $free_here GiB (< $ABORT_FREE_GIB); the $label mutation was killed. Free space and run again." >&2
      exit 4
    fi
    if (( $(date +%s) > deadline )); then
      echo "ERROR: the $label mutation is still running after $MAX_MINUTES minutes. It was NOT stopped; watch it in system.mutations." >&2
      exit 5
    fi
    sleep "$POLL_SECONDS"
  done
}

for p in $partitions; do
  if partition_complete "$p"; then
    echo
    echo "partition $p: every part already holds $COLUMN, skipped"
    continue
  fi
  free_now="$(free_gib)"
  if (( free_now < MIN_FREE_GIB )); then
    echo "ERROR: only $free_now GiB free before partition $p (need $MIN_FREE_GIB). Free space, then run again: a partition that is already done is skipped." >&2
    exit 4
  fi
  echo
  echo "Materializing $COLUMN for partition $p"
  started="$(date +%s)"
  PATTERN="%MATERIALIZE COLUMN $COLUMN IN PARTITION%$p%"
  before="$(last_mutation_id "$PATTERN")"
  ch "ALTER TABLE ulp.credentials MATERIALIZE COLUMN $COLUMN IN PARTITION '$p' SETTINGS mutations_sync = 0"
  wait_for_mutation "$PATTERN" "partition $p" "$before"
  echo "  partition $p done in $(( $(date +%s) - started )) s; free disk $(free_gib) GiB"
done

if [[ -n "$ONLY_PARTITION" ]]; then
  echo
  echo "Partition $ONLY_PARTITION is done. The final checks skipped: they need every partition (run again without ONLY_PARTITION)."
  exit 0
fi

# ── verify ───────────────────────────────────────────────────────────────────
echo
total="$(parts_total)"
with="$(parts_with_column)"
if [[ "$total" != "$with" ]]; then
  echo "ERROR: only $with of $total parts hold $COLUMN: the importer keeps the exact key until every part does." >&2
  exit 6
fi
echo "readiness: every one of $total parts holds $COLUMN"

mismatches="$(ch "SELECT count() AS norm_mismatches FROM ulp.credentials WHERE content_key_hash % 64 = 0 AND $COLUMN != $EXPR $LIMITS FORMAT TSVRaw")"
if [[ "${mismatches:-x}" != "0" ]]; then
  echo "ERROR: $mismatches rows of a 1/64 sample hold a $COLUMN that differs from the expression: the column is wrong." >&2
  exit 6
fi
echo "check: $COLUMN equals the expression for every row of a 1/64 sample"

sample="$(ch "SELECT count() AS sample_rows, uniqExact($COLUMN) AS sample_keys FROM ulp.credentials WHERE $COLUMN % 64 = 0 $LIMITS FORMAT TSVRaw")"
IFS=$'\t' read -r sample_rows sample_keys <<<"$sample"
if [[ ! "${sample_rows:-}" =~ ^[0-9]+$ || ! "${sample_keys:-}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: the sample query answered something else than two numbers." >&2
  exit 6
fi
awk -v r="$sample_rows" -v k="$sample_keys" 'BEGIN { if (r > 0) printf "surplus rows (they collapse into another row): %.0f of %.0f in a 1/64 bucket = %.2f%%\n", r - k, r, (r - k) * 100 / r }'
echo
echo "$COLUMN is complete. The next import matches on it by itself (INGEST_NORM_KEY=off turns that off)."
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `chmod +x scripts/materialize-norm-key.sh && npx vitest run __tests__/materialize-norm-key-script.test.ts`
Expected: PASS (14 tests; each runs the script for real against the stub).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add scripts/materialize-norm-key.sh __tests__/materialize-norm-key-script.test.ts
git commit -m "feat(near-dup): scripts/materialize-norm-key.sh, the supervised backfill, one partition at a time with disk limits and checks" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The per-file recount follows the job's key

**Files:**
- Modify: `scripts/pile/verify-file.ts`

**Interfaces:**
- Consumes: `exactKeySql`, `normKeySql` (Task 1); `processing_jobs.match_key` (Task 5).
- Produces: a recount that hashes and probes `norm_key_hash` for a job whose `match_key` is `norm`, and `content_key_hash` for every other job (no column, null or `exact`). It has no unit test (it drives `docker` and a parser run); Task 8's scenario `lookalikes` runs it for real against both keys.

- [ ] **Step 1: Make the edits**

In `scripts/pile/verify-file.ts`:

1. In the header comment, replace ` * no app involvement), hashes every importable row with the table's own content-key expression inside ClickHouse, and compares` with ` * no app involvement), hashes every importable row with the table's own key expression inside ClickHouse (the exact key, or the normalised one for a job whose match_key is 'norm'), and compares`.
2. After the line `import { openSource } from '@/lib/source-archive'` add `import { exactKeySql, normKeySql } from '@/lib/url-content-key'`.
3. Replace the line
```ts
const CONTENT_KEY = `cityHash64(replaceRegexpOne(replaceRegexpOne(unhex(u), '^(?i:https?://)', ''), '/$', ''), unhex(e), unhex(p))`
```
with
```ts
// The file's rows are staged as hex (u, e, p), so a key is computed over unhex(...) with the SAME builders the importer's tables use. A job that matched on the
// normalised key (processing_jobs.match_key = 'norm') is recounted on norm_key_hash; every other job, including one from before the column, on content_key_hash.
type KeyColumn = 'norm_key_hash' | 'content_key_hash'
const UNHEX = { url: 'unhex(u)', email: 'unhex(e)', password: 'unhex(p)' }
const hashSql = (column: KeyColumn) => (column === 'norm_key_hash' ? normKeySql(UNHEX) : exactKeySql(UNHEX))
```
4. Replace the comment line `// repeats and note exist on a database from the release that recorded them; a copy from before has neither, and those checks are then left out.` with `// repeats, note and match_key exist on a database from the release that recorded them; a copy from before has none of them, and those checks are then left out (no match_key means the exact key).`
5. Replace `const optional = ['repeats', 'note'].filter(` with `const optional = ['repeats', 'note', 'match_key'].filter(`.
6. Replace the `JobRow` interface line with `interface JobRow { status: string; imported: number; known: number; skipped: number; repeats?: number | null; note?: string | null; match_key?: string | null }`.
7. Replace `function probeBucket(filename: string, buckets: number, k: number): Probe {` with `function probeBucket(filename: string, buckets: number, k: number, column: KeyColumn): Probe {`, and in its query replace the two lines
```
      SELECT uniqExact(content_key_hash) AS present, uniqExactIf(content_key_hash, source_file = ${sqlStr(filename)}) AS own
      FROM ulp.credentials WHERE content_key_hash IN (SELECT h FROM ${SCRATCH}${only})
```
with
```
      SELECT uniqExact(${column}) AS present, uniqExactIf(${column}, source_file = ${sqlStr(filename)}) AS own
      FROM ulp.credentials WHERE ${column} IN (SELECT h FROM ${SCRATCH}${only})
```
8. Replace `function stageRows(input: string): void {` with `function stageRows(input: string, column: KeyColumn): void {` and `SELECT ${CONTENT_KEY} FROM input(` with `SELECT ${hashSql(column)} FROM input(`.
9. In `main()`, directly after the line that skips a job the same-name check skipped (`if (job.note === 'already-imported') { ... continue }`), add:
```ts
    const column: KeyColumn = job.match_key === 'norm' ? 'norm_key_hash' : 'content_key_hash'
    console.log(`info: recounted on the ${column === 'norm_key_hash' ? 'normalised' : 'exact'} key (the job recorded ${job.match_key ?? 'nothing, which means the exact key'})`)
```
10. In the same loop replace `const flush = () => { if (batch.length) { stageRows(batch.join('\n') + '\n'); batch = [] } }` with `const flush = () => { if (batch.length) { stageRows(batch.join('\n') + '\n', column); batch = [] } }`, and `const probe = probeBucket(filename, buckets, k)` with `const probe = probeBucket(filename, buckets, k, column)`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (`scripts/` is covered by `tsconfig.tests.json`).

- [ ] **Step 3: Commit**

```bash
git add scripts/pile/verify-file.ts
git commit -m "feat(near-dup): the per-file recount hashes and probes the key the job recorded" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Real-ClickHouse scenarios, the cost gate and the parity check

**Files:**
- Modify: `scripts/e2e-novelty-ingest.ts` (three scenarios and their helpers)
- Create: `scripts/measure-commit-sort-cost.ts`, `scripts/check-norm-key-parity.ts`

**Interfaces:**
- Consumes: everything above. `commitInsertSql`, `stageDdl`, `knownDdl`, `stageTables` are imported by `scripts/measure-commit-sort-cost.ts`; `NORM_CONTENT_KEY`, `exactKeySql`, `normHostSql`, `normKeySql`, `normRestSql` by the e2e script and the parity check.
- Produces: scenarios `golden`, `lookalikes`, `norm-not-ready` (run with `--only=`); the cost gate (exit 0 when the ratio is within 1.25); the parity check (exit 0 when the compared key counts agree). Task 9 runs all three.

These drive docker and a real ClickHouse, so their proof is running them (Task 9); here they must typecheck, load, and fail fast on bad input.

- [ ] **Step 1: Add the scenarios to `scripts/e2e-novelty-ingest.ts`**

1. In the header comment, after the second line of the `retention` entry (the line ending `...and one the job log never imported all stay`), add:

```
 *   golden        the normalised key on the edge cases of docs/superpowers/specs/2026-11-01-near-duplicates-design.md, computed by ClickHouse itself: the host part and the rest of 13
 *                 URLs, and how many distinct keys five spellings of one credential and six different credentials give (the exact key tells the five apart)
 *   lookalikes    look-alikes (www., scheme, host case, slashes, login case) against the exact key (INGEST_NORM_KEY=off: all stored) and the normalised key (known, not stored);
 *                 look-alikes inside one file count as repeats; a path or a password that differs stays a different credential; the monitor alerts with the row that was stored;
 *                 each job records its key; the per-file recount (scripts/pile/verify-file.ts) agrees with the job for both keys
 *   norm-not-ready  the column dropped and added again (existing parts lack it): the import keeps the exact key and says so; after MATERIALIZE COLUMN the next one matches on the normalised key
```

2. After the line `import { join } from 'node:path'` add:

```ts
import { NORM_CONTENT_KEY, exactKeySql, normHostSql, normKeySql, normRestSql } from '../lib/url-content-key'
```

3. Replace `interface AppSettings { concurrency?: string; novelty?: string; slab?: string; floorBytes?: number }` with `interface AppSettings { concurrency?: string; novelty?: string; slab?: string; normKey?: string; floorBytes?: number }`, and after the line `    REHEARSAL_INGEST_NOVELTY_SLAB_ROWS: s.slab ?? '',` add `    REHEARSAL_INGEST_NORM_KEY: s.normKey ?? '',`.

4. After the `distinctFor` definition add:

```ts
const distinctNormFor = (...names: string[]) => Number(chQuery(`SELECT uniqExact(norm_key_hash) FROM ulp.credentials WHERE source_file IN (${inList(names)})`))
```

5. Insert the following immediately before `async function run(): Promise<number> {`:

```ts
// ── near-duplicates: docs/superpowers/specs/2026-11-01-near-duplicates-design.md ──────────────────────────

/** The match_key the newest job row of a file recorded: 'missing' when there is no row yet, 'null' when the column is empty. Read from SQLite inside the app container. */
function matchKeyOf(name: string): string {
  return sh('docker', ['exec', '-i', APP, 'node', '-e', `
    const Database = require('better-sqlite3');
    const name = require('fs').readFileSync(0, 'utf8');
    const db = new Database('/app/data/ulp.db', { readonly: true });
    const row = db.prepare('SELECT match_key FROM processing_jobs WHERE filename = ? ORDER BY id DESC LIMIT 1').get(name);
    process.stdout.write(row === undefined ? 'missing' : String(row.match_key));
    db.close();`], process.env, name)
}

/** Waits for the job row (it is written just after the job's last event) and returns its match_key. */
const jobMatchKey = (name: string) => waitFor(() => { const k = matchKeyOf(name); return k === 'missing' ? null : k }, 20_000, 1000)

async function goldenKey(): Promise<void> {
  console.log("\n12. The normalised key on the design's edge cases, computed by ClickHouse itself")
  // [url, host part, rest]: the table of "The rule" in the design, checked on ClickHouse 26.3.17.4.
  const cases: Array<[string, string, string]> = [
    ['https://www.Example.COM/Path/', 'example.com', '/Path'],
    ['http://example.com/Path', 'example.com', '/Path'],
    ['HTTPS://WWW.example.com', 'example.com', ''],
    ['https://example.com:8443/a//', 'example.com:8443', '/a'],
    ['HTTP://www.Example.com:80/a/', 'example.com:80', '/a'],
    ['https://example.com/a#frag', 'example.com', '/a#frag'],
    ['https://example.com/?x=1/', 'example.com', '/?x=1'],
    ['https://www.www.example.com/', 'www.example.com', ''],
    ['https://user:Pw@Host.com/x', 'user:pw@host.com', '/x'],
    ['ftp://www.x.com/a', 'ftp:', '//www.x.com/a'],
    ['android://abcDEF@com.app.name/', 'android:', '//abcDEF@com.app.name'],
    ['https://www.com', 'com', ''],
    ['', '', ''],
  ]
  const urls = cases.map(([u]) => `'${u}'`).join(', ')
  const out = chQuery(`SELECT url, ${normHostSql('url')} AS host, ${normRestSql('url')} AS rest FROM (SELECT arrayJoin([${urls}]) AS url) FORMAT JSONEachRow`)
  const got = new Map((out.split('\n').map(l => JSON.parse(l)) as Array<{ url: string; host: string; rest: string }>).map(r => [r.url, r]))
  for (const [url, host, rest] of cases) {
    const g = got.get(url)
    check(`${JSON.stringify(url)}: host ${JSON.stringify(host)}, rest ${JSON.stringify(rest)}`, g?.host === host && g?.rest === rest, JSON.stringify(g))
  }

  // How many distinct keys a set of spellings gives. Rows are [url, login, password].
  const distinctKeys = (key: (c: { url: string; email: string; password: string }) => string, rows: Array<[string, string, string]>) =>
    Number(chQuery(`SELECT uniqExact(${key({ url: 't.1', email: 't.2', password: 't.3' })}) FROM (SELECT arrayJoin([${rows.map(r => `('${r[0]}', '${r[1]}', '${r[2]}')`).join(', ')}]) AS t)`))
  const oneCredential: Array<[string, string, string]> = [
    ['https://www.Shop.example/login/', 'Sam@Mail.example', 'pw-1'],
    ['http://shop.example/login', 'sam@mail.example', 'pw-1'],
    ['HTTPS://SHOP.EXAMPLE/login//', 'SAM@MAIL.EXAMPLE', 'pw-1'],
    ['shop.example/login', 'sam@mail.EXAMPLE', 'pw-1'],
    ['https://WWW.shop.example/login///', 'Sam@mail.example', 'pw-1'],
  ]
  const differentCredentials: Array<[string, string, string]> = [
    ['https://shop.example/login', 'sam@mail.example', 'pw-1'],
    ['https://shop.example/Login', 'sam@mail.example', 'pw-1'], // path case
    ['https://shop.example/login2', 'sam@mail.example', 'pw-1'], // another path
    ['https://shop.example:8443/login', 'sam@mail.example', 'pw-1'], // a port
    ['https://shop.example/login', 'sam@mail.example', 'PW-1'], // password case
    ['https://shop.example/login?x=1', 'sam@mail.example', 'pw-1'], // a query
  ]
  check('five spellings of one credential give one normalised key', distinctKeys(normKeySql, oneCredential) === 1, String(distinctKeys(normKeySql, oneCredential)))
  check('...and five exact keys: the old key cannot see that they are one', distinctKeys(exactKeySql, oneCredential) === 5, String(distinctKeys(exactKeySql, oneCredential)))
  check('six credentials that differ by path, path case, port, query or password give six normalised keys', distinctKeys(normKeySql, differentCredentials) === 6, String(distinctKeys(normKeySql, differentCredentials)))
  // The stored column against the TypeScript text, on two look-alikes written straight into the table: one stored value for both, equal to the expression.
  const G = `e2e-nov-golden-${RUN}.txt`
  chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file) VALUES
    ('https://www.Golden.example/x/', 'G@x.example', 'pw', 'golden.example', '${G}'), ('http://golden.example/x', 'g@x.example', 'pw', 'golden.example', '${G}')`)
  const stored = chQuery(`SELECT uniqExact(norm_key_hash), countIf(norm_key_hash != ${NORM_CONTENT_KEY}) FROM ulp.credentials WHERE source_file = '${G}'`)
  check('the column ClickHouse stores equals the TypeScript expression, and two look-alikes share one value', stored === '1\t0', stored)
}

async function lookAlikes(): Promise<void> {
  console.log('\n13. Look-alikes are one credential: the exact key stores them, the normalised key counts them as known')
  scanLog('before the look-alike scenario')
  const since = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19) // SQLite stamps jobs in UTC
  const partition = new Date().toISOString().slice(0, 7).replace('-', '')
  const site = (tag: string) => `lk-${tag}-${RUN}.example-store.test`
  // The first file stores three credentials. The second brings look-alikes of two of them (B1 and B2) and two credentials that are different (B3, B4).
  const first = (tag: string) => [
    `https://www.${site(tag)}/login/:Sam${RUN}@probe-mail.test:Pw-${tag}-one`, // A1
    `https://${site(tag)}/Shop:user${RUN}@probe-mail.test:Pw-${tag}-two`, // A2
    `https://${site(tag)}/cart:cart${RUN}@probe-mail.test:Pw-${tag}-three`, // A3
  ]
  const second = (tag: string) => [
    `http://${site(tag)}/login:sam${RUN}@probe-mail.test:Pw-${tag}-one`, // B1: A1 without www., on http, no trailing slash, a lower-case login
    `https://${site(tag).toUpperCase()}/Shop//:USER${RUN}@probe-mail.test:Pw-${tag}-two`, // B2: A2 in another host case, with extra slashes and login case
    `https://${site(tag)}/shop:user${RUN}@probe-mail.test:Pw-${tag}-two`, // B3: another path case, so another credential
    `https://${site(tag)}/cart:cart${RUN}@probe-mail.test:Pw-${tag}-THREE`, // B4: another password case, so another credential
  ]

  // 1. The exact key: every line is a new row, which also proves the fixtures really are different to the old key.
  const X1 = `e2e-nov-lk-x1-${RUN}.txt`
  const X2 = `e2e-nov-lk-x2-${RUN}.txt`
  if (!check('the rehearsal app restarted with INGEST_NORM_KEY=off', await recreateApp({ normKey: 'off' }))) return
  const x1 = await importLines(X1, first('x'))
  const x2 = await importLines(X2, second('x'))
  check('under the exact key every look-alike is a new row: 3 + 4 stored, none known', x1.imported === 3 && x2.imported === 4 && (x2.known ?? 0) === 0, `${brief(x1)} ${brief(x2)}`)
  check('...the exact key tells all 7 rows apart, the normalised one sees B1 and B2 as the copies they are (5 distinct)',
    distinctFor(X1, X2) === 7 && distinctNormFor(X1, X2) === 5, `exact ${distinctFor(X1, X2)}, norm ${distinctNormFor(X1, X2)}`)
  check('...and both jobs recorded the exact key', (await jobMatchKey(X1)) === 'exact' && (await jobMatchKey(X2)) === 'exact')

  // 2. The normalised key (the production default; a fresh stack has the column complete).
  const Y1 = `e2e-nov-lk-y1-${RUN}.txt`
  const Y2 = `e2e-nov-lk-y2-${RUN}.txt`
  if (!check('the rehearsal app restarted with the production defaults', await recreateApp())) return
  const y1 = await importLines(Y1, first('y'))
  const y2 = await importLines(Y2, second('y'))
  check('the first file stores its 3 rows', y1.imported === 3 && (y1.known ?? 0) === 0, brief(y1))
  check('the second file: the 2 look-alikes are known, the 2 different credentials are new', y2.imported === 2 && y2.known === 2 && y2.inFileDuplicates === 0, brief(y2))
  check('...only those 2 were stored, and the table holds 5 distinct credentials of the two files', rowsFor(Y2) === 2 && distinctNormFor(Y1, Y2) === 5, `rows ${rowsFor(Y2)}, norm ${distinctNormFor(Y1, Y2)}`)
  check('...and both jobs recorded the normalised key', (await jobMatchKey(Y1)) === 'norm' && (await jobMatchKey(Y2)) === 'norm')

  // 3. Look-alikes inside one file.
  const Z = `e2e-nov-lk-z-${RUN}.txt`
  const z = await importLines(Z, [
    `https://www.${site('z')}/login:Zed${RUN}@probe-mail.test:Pw-z-one`,
    `https://${site('z')}/login/:zed${RUN}@probe-mail.test:Pw-z-one`,
    `https://${site('z')}/login:other${RUN}@probe-mail.test:Pw-z-two`,
  ])
  check('inside one file the pair is one stored row and one repeat', z.imported === 2 && z.inFileDuplicates === 1 && (z.known ?? 0) === 0 && rowsFor(Z) === 2, brief(z))

  // 4. The monitor reports the row that was stored.
  const BRAND2 = `lookalike-brand-${RUN}.test`
  const hook = await api('POST', '/api/monitoring/webhooks', { name: `Look-alike Receiver ${RUN}`, url: `http://${RECEIVER}:9000/hook`, secret: 'rehearsal' })
  const hookId = hook.json?.data?.id as number | undefined
  if (check('a webhook to the receiver is accepted', hook.status === 200 && !!hookId, `status ${hook.status}: ${hook.json?.error ?? ''}`)) {
    const mon = await api('POST', '/api/monitoring/monitors', {
      name: `Look-alike Monitor ${RUN}`, domains: [BRAND2], match_mode: 'both', webhook_ids: [hookId], rescan_mode: 'dedup', rescan_interval_hours: 1,
    })
    if (check('a monitor on the look-alike brand domain is created', mon.status === 200 && !!mon.json?.data?.id, `status ${mon.status}`)) {
      const M = `e2e-nov-lk-mon-${RUN}.txt`
      const m = await importLines(M, [
        `https://${BRAND2}/login:pick${RUN}@${BRAND2}:Pw-pick-Xy!`, // the lower-case login comes first in the file...
        `https://${BRAND2}/login:Pick${RUN}@${BRAND2}:Pw-pick-Xy!`, // ...and the capital P sorts before the lower-case p
        ...lines('LK', 0, 20),
      ])
      check('the pair is one stored row and one repeat; the 20 other rows are new', m.imported === 21 && m.inFileDuplicates === 1, brief(m))
      const stored = chQuery(`SELECT email FROM ulp.credentials WHERE source_file = '${M}' AND lower(email) = 'pick${RUN}@${BRAND2}'`)
      check('the stored spelling is the first by (url, email), not the first in the file', stored === `Pick${RUN}@${BRAND2}`, stored)
      const alert = await waitFor(() => receiverLines().find(l => l.source_file === M), 90_000, 2000)
      check('the monitor alerted once, with the spelling that was stored', !!alert && alert.total_matches === 1 && alert.match_emails?.[0] === stored, JSON.stringify(alert))
    }
  }

  // 5. The per-file recount agrees with the job, for the normalised key and for the exact one.
  const data = mkdtempSync(join(tmpdir(), 'e2e-nov-data-'))
  try {
    sh('docker', ['cp', `${APP}:/app/data/.`, data])
    const recount = (name: string) => spawnSync('npx', ['tsx', 'scripts/pile/verify-file.ts', data, since, name], {
      env: { ...process.env, PILE_DIR: work, CH_CONTAINER: CH, PARTITION: partition }, encoding: 'utf8', maxBuffer: 64 << 20,
    })
    const vy = recount(Y2)
    check('the recount of the second file on the normalised key agrees with its job', vy.status === 0 && /recounted on the normalised key/.test(vy.stdout) && /ALL CHECKS PASSED/.test(vy.stdout), (vy.stdout + vy.stderr).slice(-500))
    const vx = recount(X2)
    check('the recount of the exact-key file agrees with its job', vx.status === 0 && /recounted on the exact key/.test(vx.stdout) && /ALL CHECKS PASSED/.test(vx.stdout), (vx.stdout + vx.stderr).slice(-500))
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
  scanLog('after the look-alike scenario')
}

async function normNotReady(): Promise<void> {
  console.log('\n14. The normalised key is used only when every part holds the column')
  chQuery('ALTER TABLE ulp.credentials DROP COLUMN norm_key_hash')
  chQuery(`ALTER TABLE ulp.credentials ADD COLUMN norm_key_hash UInt64 MATERIALIZED ${NORM_CONTENT_KEY}`)
  const partsNow = () => Number(chQuery("SELECT count() FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active"))
  const withColumn = () => Number(chQuery("SELECT uniqExact(name) FROM system.parts_columns WHERE database = 'ulp' AND table = 'credentials' AND active AND column = 'norm_key_hash'"))
  check('after the column was dropped and added again the existing parts lack it (the upgrade state)', partsNow() > 0 && withColumn() < partsNow(), `parts ${partsNow()}, with the column ${withColumn()}`)
  if (!check('the rehearsal app restarted (its readiness answer is cold)', await recreateApp())) return
  const site = `lk-nr-${RUN}.example-store.test`
  const N = (n: string) => `e2e-nov-nr-${n}-${RUN}.txt`
  const a = await importLines(N('a'), [`https://www.${site}/login:Nina${RUN}@probe-mail.test:Pw-nr`])
  const b = await importLines(N('b'), [`http://${site}/login/:nina${RUN}@probe-mail.test:Pw-nr`])
  check('while the column is incomplete the import matches on the exact key: the look-alike is a new row', a.imported === 1 && b.imported === 1 && (b.known ?? 0) === 0, `${brief(a)} ${brief(b)}`)
  check('...and both jobs say so', (await jobMatchKey(N('a'))) === 'exact' && (await jobMatchKey(N('b'))) === 'exact')
  chQuery('ALTER TABLE ulp.credentials MATERIALIZE COLUMN norm_key_hash SETTINGS mutations_sync = 2')
  check('MATERIALIZE COLUMN completed the column in every part', withColumn() === partsNow(), `parts ${partsNow()}, with the column ${withColumn()}`)
  await sleep(6_000) // a not-ready answer is remembered for 5 s
  const c = await importLines(N('c'), [`https://WWW.${site}/login//:NINA${RUN}@probe-mail.test:Pw-nr`])
  check('once it is complete the next import matches on the normalised key: the third spelling is known', c.imported === 0 && c.known === 1, brief(c))
  check('...and the job says so', (await jobMatchKey(N('c'))) === 'norm')
}

```

6. After the line `  if (want('retention')) await doneRetention()` in `run()` add:

```ts
  if (want('golden')) await goldenKey()
  if (want('lookalikes')) await lookAlikes()
  if (want('norm-not-ready')) await normNotReady()
```

- [ ] **Step 2: Create `scripts/measure-commit-sort-cost.ts`**

```ts
/**
 * The cost gate of docs/superpowers/specs/2026-11-01-near-duplicates-design.md ("Which twin is kept"): the commit statement on the normalised key sorts the
 * new rows by (url, email); on a 20,000,000-row, all-new slab it may take at most 1.25 times the statement it replaces.
 *
 * Runs on the ISOLATED rehearsal stack only (docker-compose.rehearsal.yml). It writes 2 x ROWS rows into that stack's ulp.credentials, so take the stack
 * down afterwards. A stage of ROWS all-new rows (the known table is empty: every row is new, the worst case for the sort), then four timed runs in the order
 * old, new, new, old, so that a drift in the machine's speed over the run cancels out of the two means.
 *
 *   REHEARSAL_APP_IMAGE=<tag> npx tsx scripts/e2e-alert-rehearsal.ts --keep    # brings the rehearsal stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/measure-commit-sort-cost.ts                                 # about 10 minutes at 20,000,000 rows
 *
 * Env: COST_ROWS (20000000), COST_LIMIT (1.25). Exit 0 when the ratio is within the limit, 1 when it is not.
 */
import { execFileSync } from 'node:child_process'
import { commitInsertSql } from '../lib/ingest-novelty'
import { knownDdl, stageDdl, stageTables } from '../lib/ingest-stage'

const CH = 'ulprehearsal_clickhouse'
if (!CH.startsWith('ulprehearsal_')) throw new Error('refusing to run: this script only drives the isolated rehearsal stack')

const ROWS = Math.floor(Number(process.env.COST_ROWS ?? 20_000_000))
const LIMIT = Number(process.env.COST_LIMIT ?? 1.25)
const t = stageTables('c05700000000')

function ch(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', CH, 'clickhouse-client', '--async_insert=0', '--insert_deduplicate=0', '--max_execution_time=3300', '--max_insert_threads=4', '--max_bytes_before_external_sort=1073741824', '--query', sql],
    { encoding: 'utf8', maxBuffer: 64 << 20 },
  ).trim()
}

function timed(label: string, sql: string): number {
  const started = Date.now()
  ch(sql)
  const seconds = (Date.now() - started) / 1000
  console.log(`  ${label}: ${seconds.toFixed(1)} s`)
  return seconds
}

function main(): number {
  if (!Number.isFinite(ROWS) || ROWS < 1) throw new Error(`bad COST_ROWS: ${process.env.COST_ROWS}`)
  console.log(`commit statement cost, ${ROWS.toLocaleString('en-US')} all-new rows, on the rehearsal stack`)
  ch(`DROP TABLE IF EXISTS ${t.stage} SYNC`)
  ch(`DROP TABLE IF EXISTS ${t.known} SYNC`)
  ch(stageDdl(t))
  ch(knownDdl(t))
  try {
    ch(`INSERT INTO ${t.stage} (url, email, password, domain, source_file, breach_name)
        SELECT concat('https://shop', toString(number % 5000), '.example-store.test/login'), concat('user', toString(number), '@probe-mail.test'),
               concat('Pw-', toString(number), '-Xy!'), concat('shop', toString(number % 5000), '.example-store.test'), 'cost.txt', ''
        FROM numbers(${ROWS})`)
    const staged = Number(ch(`SELECT count() FROM ${t.stage}`))
    if (staged !== ROWS) throw new Error(`the stage holds ${staged} rows, expected ${ROWS}`)

    const oldSql = commitInsertSql(t, 'ulp.credentials', 1, 0, 'content_key_hash')
    const newSql = commitInsertSql(t, 'ulp.credentials', 1, 0, 'norm_key_hash')
    const old1 = timed('old statement (exact key, no sort), run 1', oldSql)
    const new1 = timed('new statement (normalised key, sorted by url, email), run 1', newSql)
    const new2 = timed('new statement, run 2', newSql)
    const old2 = timed('old statement, run 2', oldSql)
    const oldMean = (old1 + old2) / 2
    const newMean = (new1 + new2) / 2
    const ratio = newMean / oldMean
    console.log(`  mean old ${oldMean.toFixed(1)} s, mean new ${newMean.toFixed(1)} s, ratio ${ratio.toFixed(2)} (limit ${LIMIT})`)
    return ratio <= LIMIT ? 0 : 1
  } finally {
    ch(`DROP TABLE IF EXISTS ${t.stage} SYNC`)
    ch(`DROP TABLE IF EXISTS ${t.known} SYNC`)
  }
}

process.exit(main())
```

- [ ] **Step 3: Create `scripts/check-norm-key-parity.ts`**

```ts
/**
 * Read-only parity check of the normalised key (docs/superpowers/specs/2026-11-01-near-duplicates-design.md): in each domain range given, the number of distinct
 * keys of the SQL the tables define (lib/url-content-key.ts) must equal the number of an independent formulation of the same rule (the scheme and one trailing
 * slash removed, host and rest split by hand, then the www. and the remaining trailing slashes removed with their own patterns). It counts and writes nothing.
 * Look-alikes share a `domain` (the parser lower-cases it and strips www.) and the table is ordered by it, so a domain range holds every twin of its rows.
 *
 *   npx tsx scripts/check-norm-key-parity.ts ha:hb ta:tb sc:sd                          # the live server: container ulpsuite_clickhouse
 *   CH_CONTAINER=ulprehearsal_clickhouse npx tsx scripts/check-norm-key-parity.ts a:b   # the rehearsal stack
 *
 * A range is lo:hi, meaning domain >= lo AND domain < hi. Exit 0 when every range agrees, 1 when one does not, 2 on a usage or ClickHouse error.
 */
import { execFileSync } from 'node:child_process'
import { NORM_CONTENT_KEY } from '../lib/url-content-key'

const CH = process.env.CH_CONTAINER ?? 'ulpsuite_clickhouse'
const ranges = process.argv.slice(2).map(a => a.split(':'))
if (ranges.length === 0 || ranges.some(r => r.length !== 2 || r[0] === '' || r[1] === '')) {
  console.error('usage: check-norm-key-parity.ts <lo:hi> [<lo:hi> ...]   (domain >= lo AND domain < hi)')
  process.exit(2)
}

const INDEPENDENT = String.raw`cityHash64(concat(lower(replaceRegexpOne(auth, '^(?i:www\\.)', '')), replaceRegexpOne(rest, '/+$', '')), lower(email), password)`

const QUERY = `
WITH
  replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '') AS u,
  extract(u, '^[^/?#]*') AS auth,
  substring(u, length(auth) + 1) AS rest
SELECT count() AS rows, uniqExact(${INDEPENDENT}) AS independent_keys, uniqExact(${NORM_CONTENT_KEY}) AS table_keys
FROM ulp.credentials WHERE domain >= {lo:String} AND domain < {hi:String}
SETTINGS max_threads = 6, max_memory_usage = 4000000000
FORMAT TSV`

let failed = 0
for (const [lo, hi] of ranges) {
  let out: string
  try {
    out = execFileSync('docker', ['exec', CH, 'clickhouse-client', `--param_lo=${lo}`, `--param_hi=${hi}`, '--query', QUERY], { encoding: 'utf8', maxBuffer: 1 << 20 }).trim()
  } catch (err) {
    console.error(`range ${lo}:${hi}: ClickHouse failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`)
    process.exit(2)
  }
  const [rows, independent, table] = out.split('\t').map(Number)
  const ok = Number.isFinite(independent) && independent === table
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${lo}:${hi}  rows ${rows}  independent form ${independent} keys  table's SQL ${table} keys`)
}
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 4: Check that the new scripts load and fail fast**

Run:
```bash
npx tsx -e "import('./lib/ingest-novelty').then(() => console.log('importable'))"
npx tsx scripts/check-norm-key-parity.ts; echo "exit $?"
```
Expected: `importable` (so `scripts/measure-commit-sort-cost.ts` can import the builders without a ClickHouse connection), then the usage line and `exit 2`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/e2e-novelty-ingest.ts scripts/measure-commit-sort-cost.ts scripts/check-norm-key-parity.ts
git commit -m "test(near-dup): rehearsal scenarios golden, lookalikes and norm-not-ready, the commit-sort cost gate and a read-only parity check" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The candidate image and the rehearsal

Follows `CLAUDE.md`: a candidate under its own tag, rehearsed on the isolated stack before anything is deployed. Nothing here touches the running stack except the read-only check in Step 8. Needs about 40 GiB of free host disk (the `gate` scenario).

- [ ] **Step 1: Run the full gates in the worktree**

```bash
npm run typecheck && npm test && npm run lint && npm run build
```
Expected: all four pass. (`npm run build` takes a few minutes.)

- [ ] **Step 2: Build the candidate under its own tag**

From the worktree, with the branch's tip commit (a global Docker config on this laptop is broken: scope an empty one to the command):

```bash
CFG=$(mktemp -d) && echo '{}' > $CFG/config.json
git rev-parse --short HEAD
git archive HEAD | DOCKER_CONFIG=$CFG docker build -t ulp-suite-app:norm-key-candidate -
```
Expected: the build ends with the image tagged `ulp-suite-app:norm-key-candidate`. The image that is rehearsed is the image that is deployed.

- [ ] **Step 3: Bring up a FRESH rehearsal stack on the candidate**

A stack that was started from an older init SQL would lack the column in its first parts, so remove any old one first:

```bash
REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
export REHEARSAL_APP_IMAGE=ulp-suite-app:norm-key-candidate
npx tsx scripts/e2e-alert-rehearsal.ts --keep
```
Expected: about 4 minutes; every check passes, including `the DDL version recorded in SQLite is 30` and `norm_key_hash exists on a fresh install as a MATERIALIZED column`; the stack stays up.

- [ ] **Step 4: Run the new scenarios**

```bash
npx tsx scripts/e2e-novelty-ingest.ts --only=golden,lookalikes,norm-not-ready
```
Expected: about 6 minutes, `N of N checks passed`, exit 0. If a `lookalikes` check fails in part 1 (under the exact key), the fixture is not what it claims (the parser changed a line): fix the fixture, not the expectation. If anything else fails, fix the code with a unit test first, rebuild the candidate (Step 2) and bring the stack up again (Step 3).

- [ ] **Step 5: Run every scenario again, under the new default**

```bash
npx tsx scripts/e2e-novelty-ingest.ts
```
Expected: about 20 minutes, `N of N checks passed`, exit 0. A fresh stack has the column complete, so every existing scenario now runs on the normalised key. A count that changed because a fixture line happens to be a look-alike of another is fixed in the fixture (name it in the commit), never by weakening the check.

- [ ] **Step 6: The cost gate**

```bash
npx tsx scripts/measure-commit-sort-cost.ts
```
Expected: four timings and `ratio` at most `1.25`, exit 0. Write the four timings and the ratio down: they go into the spec's "As deployed". Over 1.25: STOP and report to the owner (the spec says not to ship an arbitrary pick instead).

- [ ] **Step 7: The backfill script on a real ClickHouse**

Put the rehearsal stack into the upgrade state (the column defined, no part holding it), then run the script against it:

```bash
npx tsx -e "
import { execFileSync } from 'node:child_process'
import { NORM_CONTENT_KEY } from './lib/url-content-key'
const ch = (q: string) => execFileSync('docker', ['exec', 'ulprehearsal_clickhouse', 'clickhouse-client', '--query', q], { encoding: 'utf8' }).trim()
ch('ALTER TABLE ulp.credentials DROP COLUMN norm_key_hash')
ch('ALTER TABLE ulp.credentials ADD COLUMN norm_key_hash UInt64 MATERIALIZED ' + NORM_CONTENT_KEY)
console.log(ch(\"SELECT count() FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active\"), 'parts, none holds the column')
"
export CLICKHOUSE_CONTAINER=ulprehearsal_clickhouse MIN_FREE_GIB=1 ABORT_FREE_GIB=0
bash scripts/materialize-norm-key.sh
APPLY=1 ONLY_PARTITION=$(docker exec ulprehearsal_clickhouse clickhouse-client --query "SELECT min(partition) FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active") bash scripts/materialize-norm-key.sh
APPLY=1 bash scripts/materialize-norm-key.sh
unset CLICKHOUSE_CONTAINER MIN_FREE_GIB ABORT_FREE_GIB
```
Expected: the dry run lists `parts holding norm_key_hash: 0 of N` and the partitions and changes nothing; the `ONLY_PARTITION` run materializes one partition (`MATERIALIZE COLUMN ... IN PARTITION` is accepted by the real server), prints its time, and says the final checks were skipped; the last run skips that partition, materializes the rest and ends with `readiness: every one of N parts holds norm_key_hash`, `check: norm_key_hash equals the expression for every row of a 1/64 sample`, the surplus line and exit 0. (On the rehearsal stack's few rows the surplus share means nothing; the point is that the script's SQL runs.)

- [ ] **Step 8: The read-only parity check on the live table**

The final SQL text must give the same distinct counts as an independent formulation of the rule, on three domain ranges of the live table (a few seconds to a minute each; it only reads):

```bash
npx tsx scripts/check-norm-key-parity.ts ha:hb ta:tb sc:sd
```
Expected: three `ok` lines (`independent form N keys  table's SQL N keys`, equal) and exit 0.

- [ ] **Step 9: Take the rehearsal stack down**

```bash
unset REHEARSAL_APP_IMAGE
REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
```

- [ ] **Step 10: Commit any fix**

Only if a step needed a change (a fixture, a message, a bug the rehearsal showed):

```bash
git add <the files you changed>
git commit -m "fix(near-dup): <what the rehearsal showed>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Deploy, backfill, the first import, and close-out

Deploying is local only (this laptop); nothing is pushed to a registry. The commands that touch the running stack run from the PRIMARY checkout. This task changes the live system: **the backfill (Step 5) and the first import after it are the owner's go** (ask before Step 5; the deploy in Step 3 is covered by the standing local build/deploy permission).

- [ ] **Step 1: Check the stack is quiet**

No import is running and `inbox/processing` is empty (`ls inbox/processing` in the primary checkout prints nothing; no job is active on the Inbox page, or `docker logs --since 10m ulpsuite_app | tail -20` shows none). If one is running, wait for it: a restart kills the import in flight (a retry is safe, but wasteful). Free disk must be well above the backfill's 170 GiB (`df -h /`).

- [ ] **Step 2: Tag the running image BEFORE building or moving anything**

containerd drops an image when its tag moves, so the rollback tag comes first:

```bash
docker tag "$(docker inspect -f '{{.Image}}' ulpsuite_app)" ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz)
docker images ulp-suite-app --format '{{.Tag}} {{.ID}}' | head -6
```
Expected: a `rollback-<UTC time>` tag with the id `latest` has now. (If `docker` fails with a credsStore error, prefix with `DOCKER_CONFIG=$CFG` as in Task 9.)

- [ ] **Step 3: Deploy the rehearsed image**

From the PRIMARY checkout:

```bash
docker tag ulp-suite-app:norm-key-candidate ulp-suite-app:latest
docker compose up -d --no-deps --no-build app
sleep 45
docker inspect -f '{{.State.Health.Status}} {{.RestartCount}}' ulpsuite_app
docker logs --since 3m ulpsuite_app 2>&1 | grep -F '[ClickHouse migration]'
docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT default_kind, type FROM system.columns WHERE database = 'ulp' AND table = 'credentials' AND name = 'norm_key_hash'"
```
Expected: `healthy 0`; the migration log has `DDL v30 applied (norm_key_hash column -- existing parts need scripts/materialize-norm-key.sh)` and `DDL now at v30` and no `FAILED`; the column query prints `MATERIALIZED	UInt64`. The app log also says `matching imports on the exact key (content_key_hash): norm_key_hash is not complete in every part yet` at the first import, and imports behave exactly as before.

Rollback, if anything is wrong: `docker tag ulp-suite-app:rollback-<the time you tagged> ulp-suite-app:latest`, then the same `docker compose up -d --no-deps --no-build app`. The old image never reads the column and finds the recorded DDL version (30) above its own (29), so it skips every step; the 19.5 GiB column can stay or go with `ALTER TABLE ulp.credentials DROP COLUMN norm_key_hash`.

- [ ] **Step 4: Check the readiness answer and the free disk**

```bash
docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT (SELECT count() FROM system.parts WHERE database='ulp' AND table='credentials' AND active) AS parts, (SELECT uniqExact(name) FROM system.parts_columns WHERE database='ulp' AND table='credentials' AND active AND column='norm_key_hash') AS with_column"
df -h / | tail -1
```
Expected: `with_column` smaller than `parts` (only parts written since the deploy hold it); free disk unchanged to within a GiB or two.

- [ ] **Step 5: The backfill (ask the owner first), smallest partition first**

```bash
bash scripts/materialize-norm-key.sh
ONLY_PARTITION=$(docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT partition FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active GROUP BY partition ORDER BY sum(bytes_on_disk) LIMIT 1") APPLY=1 bash scripts/materialize-norm-key.sh
```
Expected: the dry run passes its preconditions (no mutation running, free disk at least 170 GiB) and lists the partitions; the second command does the smallest partition (202611 at the time of writing: 38M rows, 5.2 GiB) and prints how long it took and the free disk afterwards. **Stop and read those two numbers**: free disk should have fallen by about that partition's share of the column (the column is 8 bytes a row, so about 0.3 GB for 38M rows, not by the size of its projections), and the time times the row ratio (2.6B / 38M) should be under about 90 minutes. If either is far off, do not continue; report. Then the rest:

```bash
APPLY=1 bash scripts/materialize-norm-key.sh
```
Expected: the other partitions one by one with progress lines (parts still to rewrite, free disk), ending with `readiness: every one of N parts holds norm_key_hash`, `check: norm_key_hash equals the expression for every row of a 1/64 sample`, and the line `surplus rows (they collapse into another row): X of Y in a 1/64 bucket = Z%`. **Write Z down: it is the exact share that replaces the spec's estimate of 8.0%** (about 8% expected), and the figure the owner needs before deciding on Stage 2.

- [ ] **Step 6: The first import after the backfill**

Let the owner's next import run (or drop one small file in the inbox with their go). Then read the job's rule and counts (names are the owner's; do not write them anywhere that is committed):

```bash
docker exec ulpsuite_app node -e "const D=require('better-sqlite3');const d=new D('/app/data/ulp.db',{readonly:true});console.log(d.prepare('SELECT id, status, imported, known, repeats, match_key FROM processing_jobs ORDER BY id DESC LIMIT 3').all())"
docker logs --since 30m ulpsuite_app 2>&1 | grep -F 'matching imports on the'
```
Expected: the newest job has `match_key: 'norm'`; the log says `matching imports on the normalised key (norm_key_hash)`; `imported + known + repeats + skipped` adds up to the file's lines as before; `known` and `repeats` are higher than a file of that kind used to give (about one new row in eight is now discarded as a look-alike).

- [ ] **Step 7: The two table checks**

The exact-duplicate check must still give 0, and no group of look-alikes may contain a row imported after the first normalised import (put its UTC start time, taken from the log line above, in `FLIP`):

```bash
FLIP='2026-11-01 00:00:00'
docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT count() AS rows, uniqExact(content_key_hash) AS distinct_keys FROM ulp.credentials WHERE content_key_hash % 64 = 0 SETTINGS max_threads=6, max_memory_usage=4000000000"
docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT count() AS groups_with_a_row_after_the_flip FROM (SELECT norm_key_hash FROM ulp.credentials WHERE norm_key_hash % 64 = 0 GROUP BY norm_key_hash HAVING count() > 1 AND max(imported_at) >= toDateTime('$FLIP')) SETTINGS max_threads=6, max_memory_usage=4000000000"
```
Expected: `rows` equals `distinct_keys` (the first query prints two equal numbers); the second prints `0`. If the second is not 0, a look-alike was stored after the flip: stop and report with the group counts (never a row).

- [ ] **Step 8: Close the spec, merge, remember**

1. Update `docs/superpowers/specs/2026-11-01-near-duplicates-design.md` the way earlier specs were closed: replace the Status line with `**Stage 1 implemented, verified and deployed locally on <date>** (main <commit>, CI green, image <id>, rollback tag <tag>); Stage 2 not started`, and add a section "## As deployed (Stage 1, checked on the running system on <date>)" with numbers only: the first partition's time and disk change, the whole backfill's time, the exact surplus share Z (and whether it is inside 7.2% to 8.8%), the cost-gate timings and ratio, the rehearsal's check counts, the first normalised import's `known` and `repeats` against what such a file gave before, and the two table checks. No file names, no log lines.
2. Merge the branch into `main` fast-forward and push `origin/main` (the owner's standing permission once verified); use `superpowers:finishing-a-development-branch`, then leave the worktree. Look once at the CI run of the push (`gh run list --branch main --limit 1`) and report its state as it is.
3. Update the project memory for the feature (`project_near_duplicates_2026_11_01.md`: Stage 1 deployed, the commit, the image, the rollback tag, the exact share Z, the backfill time, what Stage 2 still needs: the owner's go and the `credentials_predup_auto` decision) and its line in `MEMORY.md`.
4. Tell the owner the exact share Z and the first import's numbers, and that Stage 2 is theirs to start or leave.
