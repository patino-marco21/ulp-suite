# Ingest Quality Gate and Archive Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a bad file before one of its rows is stored (a quality gate with a hold, a Release and an offline preflight), and let the importer read a file straight from the source archive (an `.archiveref` in the inbox), so that a parser or policy change never again means re-importing by hand.

**Architecture:** `lib/ingest-quality-gate.ts` is pure (invariants, counters, thresholds, verdict, report). `streamCredentialsToTable` feeds it every batch; `importThroughStage` evaluates it once early (after 1,000,000 lines) and once before `commitStage`, and a hold throws `IngestHeldError` so the existing `finally` drops the stage tables. The inbox watcher moves a held file to `inbox/held/` and logs the job as `held`; an admin Releases it (a one-shot override in SQLite). An `.archiveref` file is claimed like any inbox file; `processArchiveRef` reads the plaintext through `openSource`, hashes it on the way, and checks the sha256 before the commit. `ulp.sources` gets three identity columns (DDL v28).

**Tech Stack:** TypeScript (strict; `lib/` and `app/` are type-checked, `scripts/` is not), Next.js route handlers, better-sqlite3, ClickHouse over `@clickhouse/client`, vitest, tsx, bash.

Spec: `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md` (Part 2, and "The importer reads the archive too"). Plan 1 (`docs/superpowers/plans/2026-10-12-source-archive.md`) is merged: `lib/source-archive.ts` (`openSource`, `readManifest`, `latestByName`, `ManifestEntry`) and `scripts/archive-sources.ts` exist.

## Global Constraints

- The gate only counts. It never changes what the parser produces (`lib/ulp-parser.ts` is not touched). The counters belong to one import: no module state.
- The nine kinds, in this order, each row counted once under the first that matches: `login-is-scheme-or-ends-colon`, `login-has-scheme`, `login-has-slash` (not for `android://` urls), `login-has-colon`, `login-is-bare-host`, `url-holds-credential`, `password-has-scheme`, `telegram-link-in-field`, `double-encoded-text`.
- Signals: **junk** = rows with a kind / stored rows; **unsplit** = `no_fields` rejects / non-blank lines; **garbage** = `garbage` rejects / non-blank lines. **Hold** when at least 20,000 lines were read and junk > 2% or unsplit > 5% or garbage > 25%. **Warn** when at least 20,000 lines were read and junk > 1% or unsplit > 2%. Under 20,000 lines the verdict is at most warn. A comparison is "greater than": exactly 2.00% is not above 2%.
- Environment (all optional): `INGEST_QUALITY_GATE` (`hold` default, `warn`, `off`), `INGEST_QUALITY_GATE_JUNK_PCT` (2), `INGEST_QUALITY_GATE_UNSPLIT_PCT` (5), `INGEST_QUALITY_GATE_GARBAGE_PCT` (25), `INGEST_QUALITY_GATE_WARN_JUNK_PCT` (1), `INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT` (2), `INGEST_QUALITY_GATE_MIN_LINES` (20000), `INGEST_QUALITY_GATE_EARLY_LINES` (1000000; added by this plan so tests can move the checkpoint).
- Evaluated twice: after the first 1,000,000 lines of a larger file, and after the last line just before `commitStage`. With `INGEST_NOVELTY_CHECK=off` (the direct path inserts as it parses) the gate only warns.
- An exception inside `classifyStoredRow` is caught and counted as `gate_errors`; it never fails the import; more than 0.1% of rows with a gate error turns the verdict into a warn.
- A hold: the file moves from `inbox/processing/` to `inbox/held/`; the job row gets `status = 'held'` and `gate_report TEXT` (JSON: counts, thresholds crossed, up to 20 masked shapes with counts; a shape replaces every run of word characters by `w`, so no raw text is stored). Release moves the file back to `inbox/` and stores a one-shot override in SQLite (`gate_overrides`), consumed by the next claim of that file name; it writes an `inbox.release` audit row.
- The reference file is `<name>.archiveref`, JSON `{ v: 1, id, name, size, sha256 }` (`id` = the first 24 hex characters of `sha256`). The importer reads the plaintext through `openSource(id)`; a sha256 that differs from the reference fails the job before the commit; `inbox/done` keeps only the reference. The duplicate-file guard compares `sha256` when the import has one and the `ulp.sources` row has one: the same name with different content is a new file, the same name with the same content (or a row without a hash) stays blocked. A plain file has no hash at claim time and keeps the name-only guard.
- `ulp.sources` gets `size UInt64 DEFAULT 0`, `sha256 String DEFAULT ''`, `archive_id String DEFAULT ''` (DDL v28, `ADD COLUMN IF NOT EXISTS`, metadata only).
- The repository is public: no file names from the pile, no search terms, no credential values in code, tests, docs or commit messages. Tests use made-up hosts (`*.example.test`) and made-up logins and passwords.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; use `git commit -F <file>` (a heredoc in `$(...)` is refused in this session).
- Work in the worktree `/home/cole/ulp-suite/.claude/worktrees/reversible-pipeline` (branch `reversible-pipeline`). Start every Bash command with `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline &&` (the shell otherwise resets to the primary checkout, which is on another branch). Never touch the `parser-v6` worktree (run 5's scripts execute from it), the primary checkout, the running stack or the pile.
- **No image build, no `docker compose up`, no deploy, no ClickHouse change in this plan** (run 5 owns the disk and the app). Tasks 1-8 are unit-tested offline; Task 9 writes the end-to-end scenarios and runs them only after run 5 is complete.

## Deviations from the spec (decided while reading the code; each is repeated where it applies)

1. **HTTP text uploads cannot answer 422.** `app/api/upload/route.ts` replies with a job id before the import starts, so the verdict is not known yet. The job ends as `error` with the hold message and the spooled file is kept in `inbox/held/`; only a ZIP upload (answered after the import) gets `422` with the report.
2. **Shapes.** The importer's report lists the masked shapes of the junk rows (it has the rows). The parser does not expose rejected lines and must not change, so the shapes of unsplit lines come from the offline preflight, which reads the lines itself.
3. **A held ZIP entry holds the whole archive.** `processZipEntries` rejects the archive on an error that is not a stream error; entries imported before it stay imported, a Release re-imports the archive and the entries already recorded in `ulp.sources` are skipped by name. A Release of a ZIP releases every entry of it.
4. **Identity written by the importer.** The spec said the importer does not write `size`, `sha256`, `archive_id`. It does when it knows them (an import from the archive); a plain file still leaves them empty for the archive tool to fill.
5. **Check order.** The integrity check (`hooks.beforeCommit`, the archive's sha256) runs before the final gate check, because a damaged archive would otherwise read as a bad file.
6. **Archive directory in the container.** The compose file mounts the host's `~/ulp-archive` read-only at `/archive` and sets `ULP_ARCHIVE_DIR=/archive`. The host directory must exist before `compose up` (Docker would create it root-owned).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/ingest-quality-gate.ts` (create) | Kinds, `classifyStoredRow`, counters, config, `evaluateGate`, report, masked shapes, `IngestHeldError`. Pure. |
| `lib/ingest-gate-store.ts` (create) | SQLite side: one-shot overrides, the latest held report of a file name. |
| `lib/archive-ref.ts` (create) | `.archiveref` parse / validate / serialize, the app's archive directory, a hashing stream. Pure apart from reading one small file. |
| `lib/ingest-preflight.ts` (create) | The offline sampler: slices of a source through the same parser and counters. |
| `scripts/preflight.ts` (create) | CLI over `lib/ingest-preflight.ts`. |
| `scripts/pile/archive-queue.cjs` (create) | Feeder helper for `SOURCE=archive`: list the manifest, write one reference. |
| `app/api/inbox/release/route.ts` (create) | `POST /api/inbox/release`. |
| `lib/import-runner.ts` (modify) | `ImportHooks`: `gateOverride`, `beforeCommit`, `source`. |
| `lib/upload-processor.ts` (modify) | Gate wiring, `ProcessResult.gate`, `processArchiveRef`, sha-aware guard, identity in `recordSource`. |
| `lib/inbox-helpers.ts` (modify) | `HELD_DIR`, `getHeld`, `releaseFiles`, `holdSpooledFile`, `isSafeFileName`. |
| `lib/inbox-watcher.ts` (modify) | `inbox/held/`, `.archiveref`, override consumption, the held outcome. |
| `lib/processing-log.ts`, `lib/sqlite.ts`, `lib/audit-log.ts` (modify) | `held` status + `gate_report`; the `gate_report` column and `gate_overrides` table; `inbox.release`. |
| `lib/clickhouse-migrations.ts`, `docker/clickhouse/init/01-ulp-tables.sql`, `lib/source-archive.ts` (modify) | DDL v28 and one shared SQL constant. |
| `app/api/inbox/status/route.ts`, `app/inbox/page.tsx`, `app/api/monitoring/ingest-health/route.ts`, `components/ingest-health-panel.tsx`, `app/api/upload/route.ts` (modify) | Held list, Held card, held count, HTTP upload outcome. |
| `docker-compose.yml`, `docker-compose.rehearsal.yml` (modify) | `/archive` mount and `ULP_ARCHIVE_DIR`. |
| `scripts/pile/feed.sh` (modify) | `HELD`, `PREFLIGHT=1`, `SOURCE=archive`. |
| `scripts/e2e-novelty-ingest.ts` (modify) | Scenarios `quality-gate` and `archive-ref`. |
| `README.md`, `.env.example`, `docs/pile-import-runbook.md`, the spec (modify) | Variables, procedure, status. |
| `__tests__/*` (create / modify) | Named in each task. |

---

### Task 1: The gate core (pure)

**Files:**
- Create: `lib/ingest-quality-gate.ts`
- Test: `__tests__/ingest-quality-gate.test.ts`

**Interfaces:**
- Consumes: `holdsCredential` (`lib/ulp-recover.ts`), the type `RejectionReason` (`lib/ulp-parser.ts`).
- Produces (exact signatures, used by every later task):
  - `export const GATE_KINDS: readonly [...]`, `export type GateKind`
  - `export function classifyStoredRow(url: string, login: string, password: string): GateKind | null`
  - `export function urlHoldsCredential(url: string): boolean`
  - `export const SHAPE_CAP: number` (500)
  - `export interface GateCounters { lines; stored; junk; noFields; noPassword; garbage; tierDropped; dedup; gateErrors: number; kinds: Record<GateKind, number>; shapes: Map<string, number> }`
  - `export function newGateCounters(): GateCounters`
  - `export interface GateBatch { credentials: ReadonlyArray<{ url: string; email: string; password: string }>; rejected: number; breakdown: Partial<Record<RejectionReason, number>> }`
  - `export function recordGateBatch(c: GateCounters, batch: GateBatch): void`
  - `export function maskText(s: string, max?: number): string`, `export function maskShape(url: string, login: string, password: string): string`
  - `export type GateMode = 'hold' | 'warn' | 'off'`; `export interface GateConfig { mode; minLines; earlyLines; holdJunkPct; holdUnsplitPct; holdGarbagePct; warnJunkPct; warnUnsplitPct }`
  - `export function parseGateConfig(env?: NodeJS.ProcessEnv): GateConfig`
  - `export type GateLevel = 'pass' | 'warn' | 'hold'`; `export interface GateReport`; `export interface GateVerdict { level: GateLevel; reasons: string[]; report: GateReport }`
  - `export function evaluateGate(c: GateCounters, cfg: GateConfig, phase: 'early' | 'final'): GateVerdict`
  - `export function describeVerdict(v: GateVerdict): string`
  - `export class IngestHeldError extends Error { readonly report: GateReport }`, `export function isIngestHeldError(e: unknown): e is IngestHeldError`

- [ ] **Step 1: Write the failing test**

Create `__tests__/ingest-quality-gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { holdsCredential } from '@/lib/ulp-recover'
import {
  GATE_KINDS, SHAPE_CAP, IngestHeldError, classifyStoredRow, evaluateGate, isIngestHeldError, maskShape, maskText, newGateCounters,
  parseGateConfig, recordGateBatch, urlHoldsCredential, type GateConfig, type GateCounters, type GateKind,
} from '@/lib/ingest-quality-gate'

type Row = [string, string, string]
const CLEAN: Row = ['https://shop.example.test/login', 'alice@mail.test', 'Pw-abc!']

describe('classifyStoredRow: one fixture per kind', () => {
  const FIXTURES: Array<[GateKind, Row]> = [
    ['login-is-scheme-or-ends-colon', ['https://shop.example.test', 'https://other.example.test/x', 'Pw-1']],
    ['login-is-scheme-or-ends-colon', ['https://shop.example.test', 'alice@mail.test:', 'Pw-1']],
    ['login-has-scheme', ['https://shop.example.test', 'alice see https://x.example.test', 'Pw-1']],
    ['login-has-slash', ['https://shop.example.test', 'alice/bob', 'Pw-1']],
    ['login-has-colon', ['https://shop.example.test', 'alice:bob', 'Pw-1']],
    ['login-is-bare-host', ['', 'mail.example.test', 'Pw-1']],
    ['url-holds-credential', ['https://a.example.test:alice:secret', 'bob@mail.test', 'Pw-1']],
    ['password-has-scheme', ['https://shop.example.test', 'alice@mail.test', 'Pw://x1']],
    ['telegram-link-in-field', ['https://shop.example.test', 'alice@mail.test', 'pw t.me/channel']],
    ['telegram-link-in-field', ['android://hash==@com.example.app/', 'alice t.me/channel', 'Pw-1']],
    ['double-encoded-text', ['https://shop.example.test', 'alice@mail.test', 'Caf\u00C3\u00A9-1']],
  ]

  it.each(FIXTURES)('%s', (kind, [url, login, password]) => {
    expect(classifyStoredRow(url, login, password)).toBe(kind)
  })

  it('has a fixture for every kind', () => {
    expect(new Set(FIXTURES.map(f => f[0]))).toEqual(new Set(GATE_KINDS))
  })

  it('leaves a clean row alone, whatever else it carries', () => {
    expect(classifyStoredRow(...CLEAN)).toBeNull()
    expect(classifyStoredRow('', 'alice@mail.test', 'Pw')).toBeNull()
    expect(classifyStoredRow('https://x.example.test', 'mail.example.test', 'Pw')).toBeNull() // a bare-host login is only suspicious without a url
    expect(classifyStoredRow('android://hash==@com.example.app/', 'a/b', 'Pw-1')).toBeNull() // the android exception of login-has-slash
    expect(classifyStoredRow('https://shop.example.test:8080/login', 'alice', 'Pw-1')).toBeNull() // a port is not a credential
  })

  it('counts a row under the first kind that matches', () => {
    expect(classifyStoredRow('https://shop.example.test', 'https://x.example.test:', 'Pw://')).toBe('login-is-scheme-or-ends-colon')
  })

  it('urlHoldsCredential answers exactly like holdsCredential', () => {
    const urls = [
      '', 'host.test', 'https://host.test', 'https://host.test/path', 'https://host.test:8080/path', 'https://host.test:alice:secret',
      'host.test:alice:secret', 'alice@mail.test:', 'alice@mail.test:pw', 'http://a:b@host.test/', 'android://hash==@com.example.app/',
      'a:b', 'a:b:c', '://', 'x://y://z', 'https://host.test/a:b', ':',
    ]
    for (const url of urls) expect(urlHoldsCredential(url), JSON.stringify(url)).toBe(holdsCredential(url))
  })
})

describe('maskShape', () => {
  it('replaces every run of letters and digits (any script) by w and keeps only the punctuation', () => {
    expect(maskShape('https://shop.example.test/a', '\u0430\u043B\u0438\u0441\u0430@mail.test', '\u043F\u0430\u0440\u043E\u043B\u044C123')).toBe('w://w/w | w@w | w')
  })

  it('caps each field so a long line cannot fill the report', () => {
    expect(maskShape('', '', '!'.repeat(500)).length).toBeLessThan(80)
  })

  it('maskText masks a free line the same way and cuts it at max', () => {
    expect(maskText('Foo: bar baz!! 123', 70)).toBe('w: w w!! w')
    expect(maskText('a'.repeat(100), 10)).toBe('w')
    expect(maskText('x!'.repeat(100), 6)).toBe('w!w!w!')
  })
})

describe('recordGateBatch', () => {
  const batch = (credentials: Row[], rejected = 0, breakdown = {}) => ({
    credentials: credentials.map(([url, email, password]) => ({ url, email, password })), rejected, breakdown,
  })

  it('counts the non-blank lines, the stored rows, the rejects by reason and the rows that break a rule', () => {
    const c = newGateCounters()
    recordGateBatch(c, batch([CLEAN, CLEAN, ['https://shop.example.test', 'alice:bob', 'Pw-1']], 6,
      { blank: 2, no_fields: 1, no_password: 1, garbage: 1, tier_dropped: 1, dedup: 0 }))
    expect(c).toMatchObject({ lines: 3 + 6 - 2, stored: 3, junk: 1, noFields: 1, noPassword: 1, garbage: 1, tierDropped: 1, dedup: 0, gateErrors: 0 })
    expect(c.kinds['login-has-colon']).toBe(1)
    expect(c.shapes.get('w://w | w:w | w')).toBe(1)
  })

  it('adds up over batches and keeps one counter set per import', () => {
    const a = newGateCounters()
    const b = newGateCounters()
    recordGateBatch(a, batch([CLEAN]))
    recordGateBatch(a, batch([CLEAN]))
    recordGateBatch(b, batch([CLEAN]))
    expect([a.stored, b.stored]).toEqual([2, 1])
  })

  it('counts a failure of the classifier and goes on', () => {
    const c = newGateCounters()
    recordGateBatch(c, { credentials: [{ url: 'u', email: undefined as unknown as string, password: 'p' }, { url: CLEAN[0], email: CLEAN[1], password: CLEAN[2] }], rejected: 0, breakdown: {} })
    expect(c).toMatchObject({ stored: 2, junk: 0, gateErrors: 1 })
  })

  it('remembers at most SHAPE_CAP distinct shapes and counts the rest together', () => {
    const c = newGateCounters()
    // 20 login shapes x 30 password shapes = 600 distinct masked shapes (a field is cut at 60 characters, so one field alone cannot make that many)
    const rows: Row[] = Array.from({ length: SHAPE_CAP + 100 }, (_, i): Row => ['https://shop.example.test', 'a' + '/'.repeat((i % 20) + 1), 'P' + '!'.repeat(Math.floor(i / 20) + 1)])
    recordGateBatch(c, batch(rows))
    expect(c.junk).toBe(SHAPE_CAP + 100)
    expect(c.shapes.size).toBe(SHAPE_CAP + 1)
    expect(c.shapes.get('(other shapes)')).toBe(100)
  })
})

describe('parseGateConfig', () => {
  it('defaults to the spec', () => {
    expect(parseGateConfig({})).toEqual({
      mode: 'hold', minLines: 20_000, earlyLines: 1_000_000,
      holdJunkPct: 2, holdUnsplitPct: 5, holdGarbagePct: 25, warnJunkPct: 1, warnUnsplitPct: 2,
    })
  })

  it('reads the environment', () => {
    const cfg = parseGateConfig({
      INGEST_QUALITY_GATE: ' WARN ', INGEST_QUALITY_GATE_JUNK_PCT: '3.5', INGEST_QUALITY_GATE_UNSPLIT_PCT: '8', INGEST_QUALITY_GATE_GARBAGE_PCT: '40',
      INGEST_QUALITY_GATE_WARN_JUNK_PCT: '0.5', INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT: '1', INGEST_QUALITY_GATE_MIN_LINES: '100',
      INGEST_QUALITY_GATE_EARLY_LINES: '5000',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg).toEqual({ mode: 'warn', minLines: 100, earlyLines: 5000, holdJunkPct: 3.5, holdUnsplitPct: 8, holdGarbagePct: 40, warnJunkPct: 0.5, warnUnsplitPct: 1 })
    expect(parseGateConfig({ INGEST_QUALITY_GATE: 'off' } as unknown as NodeJS.ProcessEnv).mode).toBe('off')
  })

  it('falls back to the default for a value that makes no sense, and to hold for an unknown mode', () => {
    const cfg = parseGateConfig({
      INGEST_QUALITY_GATE: 'maybe', INGEST_QUALITY_GATE_JUNK_PCT: 'abc', INGEST_QUALITY_GATE_UNSPLIT_PCT: '-1', INGEST_QUALITY_GATE_MIN_LINES: '0',
      INGEST_QUALITY_GATE_EARLY_LINES: '',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg).toMatchObject({ mode: 'hold', holdJunkPct: 2, holdUnsplitPct: 5, minLines: 20_000, earlyLines: 1_000_000 })
  })
})

describe('evaluateGate', () => {
  const cfg = (over: Partial<GateConfig> = {}): GateConfig => ({ ...parseGateConfig({}), ...over })
  const counters = (c: Partial<Omit<GateCounters, 'kinds' | 'shapes'>>): GateCounters => ({ ...newGateCounters(), ...c })
  const BIG = { lines: 100_000, stored: 90_000 }
  const level = (c: Partial<Omit<GateCounters, 'kinds' | 'shapes'>>, over: Partial<GateConfig> = {}) => evaluateGate(counters(c), cfg(over), 'final').level

  it('passes a clean file', () => {
    expect(level({ ...BIG, junk: 100, noFields: 500, garbage: 1_000 })).toBe('pass')
  })

  it('holds above 2% junk, warns above 1%, and "above" means strictly above', () => {
    expect(level({ ...BIG, junk: 1_900 })).toBe('hold') // 2.11%
    expect(level({ ...BIG, junk: 1_800 })).toBe('warn') // exactly 2.00%
    expect(level({ ...BIG, junk: 1_000 })).toBe('warn') // 1.11%
    expect(level({ ...BIG, junk: 900 })).toBe('pass') //   exactly 1.00%
  })

  it('holds above 5% unsplit lines, warns above 2%', () => {
    expect(level({ ...BIG, noFields: 5_100 })).toBe('hold')
    expect(level({ ...BIG, noFields: 5_000 })).toBe('warn')
    expect(level({ ...BIG, noFields: 2_100 })).toBe('warn')
    expect(level({ ...BIG, noFields: 2_000 })).toBe('pass')
  })

  it('holds above 25% garbage and has no warn tier for it', () => {
    expect(level({ ...BIG, garbage: 25_100 })).toBe('hold')
    expect(level({ ...BIG, garbage: 25_000 })).toBe('pass')
  })

  it('is at most a warn under 20,000 lines, and says nothing about a small file that only crosses a warn limit', () => {
    expect(level({ lines: 10_000, stored: 5_000, junk: 2_000 })).toBe('warn')
    expect(level({ lines: 10_000, stored: 9_000, junk: 150 })).toBe('pass') // 1.67%: a warn limit, too little data
  })

  it('never holds in warn mode and never reports in off mode', () => {
    expect(level({ ...BIG, junk: 5_000 }, { mode: 'warn' })).toBe('warn')
    expect(level({ ...BIG, junk: 5_000 }, { mode: 'off' })).toBe('pass')
  })

  it('turns a pass into a warn when the gate itself failed on more than 0.1% of the rows', () => {
    expect(level({ lines: 10_000, stored: 10_000, gateErrors: 11 })).toBe('warn')
    expect(level({ lines: 10_000, stored: 10_000, gateErrors: 10 })).toBe('pass')
  })

  it('reports numbers, the non-zero kinds, the top 20 shapes, the thresholds, and no text', () => {
    const c = newGateCounters()
    const rows: Row[] = Array.from({ length: 25 }, (_, i) => ['https://shop.example.test', 'secretlogin' + '/'.repeat(i + 1), 'topsecretpw'])
    recordGateBatch(c, { credentials: rows.map(([url, email, password]) => ({ url, email, password })), rejected: 0, breakdown: {} })
    const verdict = evaluateGate(c, cfg({ minLines: 10 }), 'early')
    expect(verdict.level).toBe('hold')
    expect(verdict.reasons[0]).toMatch(/^100\.00% of the stored rows break a rule \(limit 2%\)$/)
    expect(verdict.report).toMatchObject({ v: 1, phase: 'early', level: 'hold', lines: 25, stored: 25, junk: 25, junkPct: 100, unsplitPct: 0, garbagePct: 0 })
    expect(verdict.report.kinds).toEqual({ 'login-has-slash': 25 })
    expect(verdict.report.shapes).toHaveLength(20)
    expect(verdict.report.thresholds).toEqual({ minLines: 10, holdJunkPct: 2, holdUnsplitPct: 5, holdGarbagePct: 25, warnJunkPct: 1, warnUnsplitPct: 2 })
    expect(JSON.stringify(verdict.report)).not.toMatch(/secretlogin|topsecretpw/)
  })
})

describe('the two old parser defects, built as rows (the current parser no longer produces them)', () => {
  const cfg = parseGateConfig({})
  const rowsOf = (clean: number, bad: Row[]) => ({
    credentials: [...Array.from({ length: clean }, () => CLEAN), ...bad].map(([url, email, password]) => ({ url, email, password })),
    rejected: 0, breakdown: {},
  })

  it('holds a file whose passwords carry a channel tag', () => {
    const c = newGateCounters()
    recordGateBatch(c, rowsOf(94_000, Array.from({ length: 6_000 }, (): Row => ['https://shop.example.test', 'bob@mail.test', 'secret t.me/somechannel'])))
    expect(evaluateGate(c, cfg, 'final').level).toBe('hold')
  })

  it('holds a file where a url line, a login line and a password line were joined into one row', () => {
    const c = newGateCounters()
    recordGateBatch(c, rowsOf(90_000, Array.from({ length: 10_000 }, (): Row => ['', 'https://a.example.test/login carol@mail.test Pw-1', 'Pw-2'])))
    expect(evaluateGate(c, cfg, 'final').level).toBe('hold')
  })

  it('passes a file shaped like a clean one, even with a few rows that break a rule', () => {
    const c = newGateCounters()
    recordGateBatch(c, rowsOf(99_900, Array.from({ length: 100 }, (): Row => ['https://shop.example.test', 'dave:erin', 'Pw-1'])))
    expect(evaluateGate(c, cfg, 'final').level).toBe('pass')
  })
})

describe('IngestHeldError', () => {
  const report = evaluateGate(Object.assign(newGateCounters(), { lines: 30_000, stored: 30_000, junk: 3_000 }), parseGateConfig({}), 'final').report

  it('carries the report and says why in its message', () => {
    const err = new IngestHeldError(report)
    expect(err.name).toBe('IngestHeldError')
    expect(err.report).toBe(report)
    expect(err.message).toBe('Held by the quality gate: 10.00% of the stored rows break a rule (limit 2%).')
  })

  it('is recognised by shape too, because the app is built as several bundles', () => {
    expect(isIngestHeldError(new IngestHeldError(report))).toBe(true)
    const lookalike = Object.assign(new Error('x'), { name: 'IngestHeldError', report })
    expect(isIngestHeldError(lookalike)).toBe(true)
    expect(isIngestHeldError(new Error('x'))).toBe(false)
    expect(isIngestHeldError('IngestHeldError')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/ingest-quality-gate.test.ts`
Expected: FAIL, `Failed to resolve import "@/lib/ingest-quality-gate"`.

- [ ] **Step 3: Write the module**

Create `lib/ingest-quality-gate.ts`:

```ts
/**
 * The ingest quality gate (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md, Part 2).
 *
 * A correctly parsed row never breaks a few invariants: a login that is a URL, a url that holds a whole credential, a Telegram link inside a field, UTF-8
 * text read as Latin-1. The importer counts the breaks while it stages a file; when they pass a threshold the file is HELD before one row reaches
 * ulp.credentials, with a report that says why. The two worst parser defects of the pile import were visible in a two-minute sample of the file.
 *
 * Everything here is pure: counters, a config, a verdict. It only counts; it never changes what the parser produces. The counters belong to ONE import (no
 * module state), so two imports running side by side cannot mix. A report holds counts and masked shapes, never a line of a file.
 */
import { holdsCredential } from '@/lib/ulp-recover'
import type { RejectionReason } from '@/lib/ulp-parser'

// ─── What a stored row must never look like ───────────────────────────────────

export const GATE_KINDS = [
  'login-is-scheme-or-ends-colon',
  'login-has-scheme',
  'login-has-slash',
  'login-has-colon',
  'login-is-bare-host',
  'url-holds-credential',
  'password-has-scheme',
  'telegram-link-in-field',
  'double-encoded-text',
] as const

export type GateKind = (typeof GATE_KINDS)[number]

const LOGIN_IS_URL = /^[a-z][a-z0-9+.-]*:\/\/\S*$/i
const BARE_HOST = /^[\w-]+(?:\.[\w-]+)+$/
const TELEGRAM_LINK = /t\.me\//i
// UTF-8 text that was read as Latin-1 and written out as UTF-8 again: a lead byte (U+00C2..U+00EF) followed by a continuation byte (U+0080..U+00BF).
const DOUBLE_ENCODED = /[\u00C2-\u00EF][\u0080-\u00BF]/

/**
 * `holdsCredential` (lib/ulp-recover.ts) without its two allocations for the commonest url, "scheme://host/path": exactly one colon, and it starts the "://".
 * It answers exactly like holdsCredential (the test compares them).
 */
export function urlHoldsCredential(url: string): boolean {
  const first = url.indexOf(':')
  if (first === -1) return false
  if (url.charCodeAt(first + 1) === 47 && url.charCodeAt(first + 2) === 47 && url.indexOf(':', first + 1) === -1) return false
  return holdsCredential(url)
}

/** The first invariant a stored row breaks, or null. Each row is counted once. */
export function classifyStoredRow(url: string, login: string, password: string): GateKind | null {
  if (LOGIN_IS_URL.test(login) || login.endsWith(':')) return 'login-is-scheme-or-ends-colon'
  if (login.includes('://')) return 'login-has-scheme'
  if (login.includes('/') && !url.startsWith('android://')) return 'login-has-slash'
  if (login.includes(':')) return 'login-has-colon'
  if (url === '' && !login.includes('@') && BARE_HOST.test(login)) return 'login-is-bare-host'
  if (urlHoldsCredential(url)) return 'url-holds-credential'
  if (password.includes('://')) return 'password-has-scheme'
  if (TELEGRAM_LINK.test(password) || TELEGRAM_LINK.test(login)) return 'telegram-link-in-field'
  if (DOUBLE_ENCODED.test(password)) return 'double-encoded-text'
  return null
}

// ─── Counters (one set per import) ────────────────────────────────────────────

export const SHAPE_CAP = 500
const OTHER_SHAPES = '(other shapes)'
const REPORT_SHAPES = 20
const FIELD_SHAPE_CHARS = 60
const WORD_RUN = /[\p{L}\p{N}_.~-]+/gu

export interface GateCounters {
  /** Non-blank lines read: the rows the parser kept plus every rejected line that is not blank. */
  lines: number
  /** Rows the parser kept (before the tier filter). */
  stored: number
  /** Stored rows that break a rule. */
  junk: number
  noFields: number
  noPassword: number
  garbage: number
  tierDropped: number
  dedup: number
  /** Rows the classifier threw on. It never fails an import. */
  gateErrors: number
  kinds: Record<GateKind, number>
  /** Masked shapes of the junk rows, at most SHAPE_CAP distinct ones. */
  shapes: Map<string, number>
}

export function newGateCounters(): GateCounters {
  return {
    lines: 0, stored: 0, junk: 0, noFields: 0, noPassword: 0, garbage: 0, tierDropped: 0, dedup: 0, gateErrors: 0,
    kinds: Object.fromEntries(GATE_KINDS.map(k => [k, 0])) as Record<GateKind, number>,
    shapes: new Map(),
  }
}

/** What parseULPStream yields per batch (lib/ulp-parser.ts StreamBatch), as far as the gate needs it. */
export interface GateBatch {
  credentials: ReadonlyArray<{ url: string; email: string; password: string }>
  rejected: number
  breakdown: Partial<Record<RejectionReason, number>>
}

/** Every run of letters, digits, '_', '.', '~' and '-' (any script) becomes w, white space collapses, only the punctuation stays. Looks at no more than `max` characters. */
export function maskText(s: string, max = FIELD_SHAPE_CHARS): string {
  return s.slice(0, max).replace(WORD_RUN, 'w').replace(/\s+/g, ' ')
}

/** "w://w/w | w@w | w": the masked url, login and password of a row. */
export function maskShape(url: string, login: string, password: string): string {
  return `${maskText(url)} | ${maskText(login)} | ${maskText(password)}`
}

function noteShape(c: GateCounters, url: string, login: string, password: string): void {
  const shape = maskShape(url, login, password)
  const key = c.shapes.has(shape) || c.shapes.size < SHAPE_CAP ? shape : OTHER_SHAPES
  c.shapes.set(key, (c.shapes.get(key) ?? 0) + 1)
}

/** Adds one parser batch to the counters. Never throws. */
export function recordGateBatch(c: GateCounters, batch: GateBatch): void {
  const b = batch.breakdown
  c.lines += batch.credentials.length + batch.rejected - (b.blank ?? 0)
  c.stored += batch.credentials.length
  c.noFields += b.no_fields ?? 0
  c.noPassword += b.no_password ?? 0
  c.garbage += b.garbage ?? 0
  c.tierDropped += b.tier_dropped ?? 0
  c.dedup += b.dedup ?? 0
  for (const cred of batch.credentials) {
    try {
      const kind = classifyStoredRow(cred.url, cred.email, cred.password)
      if (kind === null) continue
      c.junk++
      c.kinds[kind]++
      noteShape(c, cred.url, cred.email, cred.password)
    } catch {
      c.gateErrors++
    }
  }
}

// ─── Configuration ────────────────────────────────────────────────────────────

export type GateMode = 'hold' | 'warn' | 'off'

export interface GateConfig {
  mode: GateMode
  /** Fewer lines than this and the verdict is at most a warn. */
  minLines: number
  /** The early check runs once the first batch that brings the count to this many lines has been parsed. */
  earlyLines: number
  holdJunkPct: number
  holdUnsplitPct: number
  holdGarbagePct: number
  warnJunkPct: number
  warnUnsplitPct: number
}

function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function whole(raw: string | undefined, fallback: number): number {
  const n = Math.floor(positive(raw, fallback))
  return n >= 1 ? n : fallback
}

/** Reads INGEST_QUALITY_GATE*. Anything that is not a positive number falls back to the default; an unknown mode is `hold`. */
export function parseGateConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
  const mode = (env.INGEST_QUALITY_GATE ?? '').trim().toLowerCase()
  return {
    mode: mode === 'warn' || mode === 'off' ? mode : 'hold',
    minLines: whole(env.INGEST_QUALITY_GATE_MIN_LINES, 20_000),
    earlyLines: whole(env.INGEST_QUALITY_GATE_EARLY_LINES, 1_000_000),
    holdJunkPct: positive(env.INGEST_QUALITY_GATE_JUNK_PCT, 2),
    holdUnsplitPct: positive(env.INGEST_QUALITY_GATE_UNSPLIT_PCT, 5),
    holdGarbagePct: positive(env.INGEST_QUALITY_GATE_GARBAGE_PCT, 25),
    warnJunkPct: positive(env.INGEST_QUALITY_GATE_WARN_JUNK_PCT, 1),
    warnUnsplitPct: positive(env.INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT, 2),
  }
}

// ─── Verdict ──────────────────────────────────────────────────────────────────

export type GateLevel = 'pass' | 'warn' | 'hold'

export interface GateReport {
  v: 1
  phase: 'early' | 'final'
  level: GateLevel
  reasons: string[]
  lines: number
  stored: number
  junk: number
  noFields: number
  noPassword: number
  garbage: number
  tierDropped: number
  gateErrors: number
  junkPct: number
  unsplitPct: number
  garbagePct: number
  /** Only the kinds that occurred. */
  kinds: Partial<Record<GateKind, number>>
  /** The most frequent masked shapes of the junk rows. */
  shapes: Array<{ shape: string; count: number }>
  thresholds: {
    minLines: number
    holdJunkPct: number
    holdUnsplitPct: number
    holdGarbagePct: number
    warnJunkPct: number
    warnUnsplitPct: number
  }
}

export interface GateVerdict {
  level: GateLevel
  reasons: string[]
  report: GateReport
}

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0)
const round2 = (x: number) => Math.round(x * 100) / 100
/** n / d is above `limit` percent. Integer arithmetic where the inputs are integers, so exactly 2.00% is not above 2%. */
const above = (n: number, d: number, limit: number) => d > 0 && n * 100 > limit * d

export function evaluateGate(c: GateCounters, cfg: GateConfig, phase: 'early' | 'final'): GateVerdict {
  const junkPct = round2(pct(c.junk, c.stored))
  const unsplitPct = round2(pct(c.noFields, c.lines))
  const garbagePct = round2(pct(c.garbage, c.lines))

  const holdReasons: string[] = []
  if (above(c.junk, c.stored, cfg.holdJunkPct)) holdReasons.push(`${junkPct.toFixed(2)}% of the stored rows break a rule (limit ${cfg.holdJunkPct}%)`)
  if (above(c.noFields, c.lines, cfg.holdUnsplitPct)) holdReasons.push(`${unsplitPct.toFixed(2)}% of the lines could not be split (limit ${cfg.holdUnsplitPct}%)`)
  if (above(c.garbage, c.lines, cfg.holdGarbagePct)) holdReasons.push(`${garbagePct.toFixed(2)}% of the lines are garbage (limit ${cfg.holdGarbagePct}%)`)

  const warnReasons: string[] = []
  if (above(c.junk, c.stored, cfg.warnJunkPct)) warnReasons.push(`${junkPct.toFixed(2)}% of the stored rows break a rule (warn limit ${cfg.warnJunkPct}%)`)
  if (above(c.noFields, c.lines, cfg.warnUnsplitPct)) warnReasons.push(`${unsplitPct.toFixed(2)}% of the lines could not be split (warn limit ${cfg.warnUnsplitPct}%)`)
  const gateErrorReason = c.stored > 0 && c.gateErrors * 1000 > c.stored ? `the gate itself failed on ${c.gateErrors} of ${c.stored} rows` : null

  const enough = c.lines >= cfg.minLines
  let level: GateLevel = 'pass'
  let reasons: string[] = []
  if (cfg.mode !== 'off') {
    if (holdReasons.length > 0) {
      level = enough && cfg.mode === 'hold' ? 'hold' : 'warn'
      reasons = holdReasons
    } else if (enough && warnReasons.length > 0) {
      level = 'warn'
      reasons = warnReasons
    }
    if (gateErrorReason) {
      if (level === 'pass') level = 'warn'
      reasons = [...reasons, gateErrorReason]
    }
  }

  const kinds: Partial<Record<GateKind, number>> = {}
  for (const k of GATE_KINDS) if (c.kinds[k] > 0) kinds[k] = c.kinds[k]
  const shapes = [...c.shapes.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, REPORT_SHAPES)
    .map(([shape, count]) => ({ shape, count }))

  const report: GateReport = {
    v: 1, phase, level, reasons,
    lines: c.lines, stored: c.stored, junk: c.junk, noFields: c.noFields, noPassword: c.noPassword, garbage: c.garbage, tierDropped: c.tierDropped, gateErrors: c.gateErrors,
    junkPct, unsplitPct, garbagePct, kinds, shapes,
    thresholds: {
      minLines: cfg.minLines, holdJunkPct: cfg.holdJunkPct, holdUnsplitPct: cfg.holdUnsplitPct, holdGarbagePct: cfg.holdGarbagePct,
      warnJunkPct: cfg.warnJunkPct, warnUnsplitPct: cfg.warnUnsplitPct,
    },
  }
  return { level, reasons, report }
}

/** One log line of numbers; no file content. */
export function describeVerdict(v: GateVerdict): string {
  const r = v.report
  return `${v.level} (${r.phase}): ${r.lines} lines, ${r.stored} stored, junk ${r.junkPct}%, unsplit ${r.unsplitPct}%, garbage ${r.garbagePct}%${v.reasons.length ? `: ${v.reasons.join('; ')}` : ''}`
}

// ─── The error a hold throws ──────────────────────────────────────────────────

export class IngestHeldError extends Error {
  readonly report: GateReport

  constructor(report: GateReport) {
    super(`Held by the quality gate: ${report.reasons.join('; ')}.`)
    this.name = 'IngestHeldError'
    this.report = report
  }
}

/** `instanceof` fails across the app's webpack bundles (the watcher and the routes load separate copies of a module), so the shape counts too. */
export function isIngestHeldError(e: unknown): e is IngestHeldError {
  if (e instanceof IngestHeldError) return true
  return e instanceof Error && e.name === 'IngestHeldError' && typeof (e as { report?: unknown }).report === 'object' && (e as { report?: unknown }).report !== null
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/ingest-quality-gate.test.ts`
Expected: PASS, all tests green. (`-` and `.` are part of the word class, so `Pw-1` is one run and masks to `w`; the junk row of the `recordGateBatch` test has the shape `w://w | w:w | w`.)

- [ ] **Step 5: Type-check and lint**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit -p . 2>&1 | head -20 && npx eslint --no-eslintrc -c .eslintrc.json lib/ingest-quality-gate.ts __tests__/ingest-quality-gate.test.ts`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add lib/ingest-quality-gate.ts __tests__/ingest-quality-gate.test.ts
printf '%s\n' 'feat(gate): the ingest quality gate core: invariants, counters, thresholds, verdict, report' '' 'Pure module: nine invariants a correctly parsed row never breaks, per-import counters, the hold / warn thresholds of the spec, a report of counts and masked shapes, and IngestHeldError.' '' 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate1.txt
git commit -F /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate1.txt
```

---

### Task 2: Wire the gate into the import pipeline

**Files:**
- Modify: `lib/import-runner.ts` (hooks)
- Modify: `lib/upload-processor.ts` (`ProcessResult.gate`, `StreamToTableOptions`, `streamCredentialsToTable`, `importThroughStage`, the direct path)
- Test: `__tests__/upload-processor-gate.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `ImportHooks` gains `gateOverride?: boolean`, `beforeCommit?: () => void | Promise<void>`, `source?: SourceIdentity`; `export interface SourceIdentity { sha256: string; size: number; archiveId: string }` (`lib/import-runner.ts`).
  - `ProcessResult.gate?: GateReport` (set when the final level is not `pass`).
  - `StreamToTableOptions.gate?: GateCounters` and `.gateCheckpoint?: { atLines: number; check: () => void }`.
  - A hold throws `IngestHeldError` out of `processTextStream` / `processTextFile` before `commitStage` and before any row of the file is written to `ulp.credentials`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/upload-processor-gate.test.ts`:

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
  return { ...actual, createStage: h.createStage, dropStage: h.dropStage, registerStage: h.registerStage, unregisterStage: h.unregisterStage }
})

import { processTextStream } from '@/lib/upload-processor'

// The current parser stores "Pw://x" as a password, which the gate counts as a row that breaks a rule (password-has-scheme).
const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const textOf = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'
const stream = (text: string) => Readable.toWeb(Readable.from([Buffer.from(text)])) as ReadableStream<Uint8Array>
const insertedTables = () => h.insert.mock.calls.map(c => c[0].table as string)

beforeEach(() => {
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  vi.stubEnv('INGEST_QUALITY_GATE_MIN_LINES', '100')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const fn of Object.values(h)) fn.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
  h.createStage.mockResolvedValue(undefined)
  h.dropStage.mockResolvedValue(undefined)
  h.commitStage.mockResolvedValue({ rows: 1000, distinct: 1000, known: 0, inserted: 1000, inFileDuplicates: 0, slabs: 1, matches: [] })
  dm.getActiveMonitors.mockReset()
  dm.getActiveMonitors.mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset()
  dm.fireMonitorAlertsFromMatches.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the quality gate in the staged import', () => {
  it('holds a file whose rows break the rules: nothing is committed, the stage is dropped, ulp.credentials and ulp.sources are untouched', async () => {
    await expect(processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt')).rejects.toMatchObject({ name: 'IngestHeldError' })
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    expect(insertedTables()).not.toContain('ulp.credentials')
    expect(insertedTables()).not.toContain('ulp.sources')
  })

  it('puts the numbers in the error, not the lines', async () => {
    const err = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt').catch(e => e)
    expect(err.report).toMatchObject({ phase: 'final', level: 'hold', lines: 1_000, stored: 1_000, junk: 1_000, junkPct: 100 })
    expect(err.report.kinds).toEqual({ 'password-has-scheme': 1_000 })
    expect(JSON.stringify(err.report)).not.toContain('example.test')
  })

  it('stores a clean file and returns no gate report', async () => {
    const out = await processTextStream(stream(textOf(1_000, cleanLine)), 'clean.txt')
    expect(out.imported).toBe(1_000)
    expect(out.gate).toBeUndefined()
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('imports a released file anyway and keeps the report on the result', async () => {
    const out = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt', undefined, undefined, { gateOverride: true })
    expect(h.commitStage).toHaveBeenCalledTimes(1)
    expect(out.gate).toMatchObject({ level: 'hold', junk: 1_000 })
  })

  it('INGEST_QUALITY_GATE=warn reports and imports; =off does not even count', async () => {
    vi.stubEnv('INGEST_QUALITY_GATE', 'warn')
    const warned = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt')
    expect(warned.gate).toMatchObject({ level: 'warn' })
    expect(h.commitStage).toHaveBeenCalledTimes(1)

    h.commitStage.mockClear()
    vi.stubEnv('INGEST_QUALITY_GATE', 'off')
    const off = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt')
    expect(off.gate).toBeUndefined()
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('holds early: a large bad file is stopped after the first batch, before one row is staged', async () => {
    vi.stubEnv('INGEST_QUALITY_GATE_EARLY_LINES', '50000')
    await expect(processTextStream(stream(textOf(250_000, junkLine)), 'big-junk.txt')).rejects.toMatchObject({ name: 'IngestHeldError' })
    expect(insertedTables()).toEqual([])
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
  }, 60_000)

  it('runs beforeCommit after the whole file was read and BEFORE the final gate check: a failed integrity check wins over a hold', async () => {
    const beforeCommit = vi.fn().mockRejectedValue(new Error('archive failed its sha256 check'))
    await expect(processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt', undefined, undefined, { beforeCommit })).rejects.toThrow('archive failed its sha256 check')
    expect(beforeCommit).toHaveBeenCalledTimes(1)
    expect(h.commitStage).not.toHaveBeenCalled()
  })

  it('calls beforeCommit once for a good file, then commits', async () => {
    const order: string[] = []
    const beforeCommit = vi.fn(async () => { order.push('beforeCommit') })
    h.commitStage.mockImplementation(async () => {
      order.push('commit')
      return { rows: 1000, distinct: 1000, known: 0, inserted: 1000, inFileDuplicates: 0, slabs: 1, matches: [] }
    })
    await processTextStream(stream(textOf(1_000, cleanLine)), 'clean.txt', undefined, undefined, { beforeCommit })
    expect(order).toEqual(['beforeCommit', 'commit'])
  })
})

describe('the quality gate on the direct path (INGEST_NOVELTY_CHECK=off)', () => {
  it('only warns: the rows are inserted as they are parsed, so there is nothing left to hold', async () => {
    vi.stubEnv('INGEST_NOVELTY_CHECK', 'off')
    const out = await processTextStream(stream(textOf(1_000, junkLine)), 'junk.txt')
    expect(out.imported).toBe(1_000)
    expect(insertedTables()).toContain('ulp.credentials')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[quality-gate] junk.txt'))
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/upload-processor-gate.test.ts`
Expected: FAIL (the first test resolves instead of rejecting; `out.gate` is undefined).

- [ ] **Step 3: Extend the hooks**

In `lib/import-runner.ts`, replace

```ts
/** What the pipeline functions accept: every part optional, so existing callers and tests need no change. */
export type ImportHooks = Partial<ImportContext> & {
  /** Novelty-aware ingest reports where it is: parsing, checking against the table, inserting. */
  onImportProgress?: (event: ImportProgressEvent) => void
}
```

with

```ts
/** Who a file is when it was read from the source archive (lib/archive-ref.ts): written to ulp.sources and compared by the duplicate-file guard. */
export interface SourceIdentity {
  sha256: string
  size: number
  archiveId: string
}

/** What the pipeline functions accept: every part optional, so existing callers and tests need no change. */
export type ImportHooks = Partial<ImportContext> & {
  /** Novelty-aware ingest reports where it is: parsing, checking against the table, inserting. */
  onImportProgress?: (event: ImportProgressEvent) => void
  /** An admin released this file from the Held list: the quality gate then reports what it found but does not hold the file. */
  gateOverride?: boolean
  /** Runs once the whole file was read and BEFORE the final gate check and the commit; a throw fails the import with nothing written (the archive's sha256 check). */
  beforeCommit?: () => void | Promise<void>
  /** The file's identity when it was read from the source archive. */
  source?: SourceIdentity
}
```

- [ ] **Step 4: Wire `lib/upload-processor.ts`**

(a) Imports. After the line `import { createStage, dropStage, newStageId, registerStage, stageTables, unregisterStage } from '@/lib/ingest-stage'` add:

```ts
import {
  IngestHeldError, describeVerdict, evaluateGate, newGateCounters, parseGateConfig, recordGateBatch,
  type GateCounters, type GateReport, type GateVerdict,
} from '@/lib/ingest-quality-gate'
```

(b) `ProcessResult`: after the `error_reason?` member add

```ts
  /** The quality gate's report, set when its final verdict was not `pass` (a warn, or a hold that an admin released). */
  gate?:               GateReport
```

(c) `StreamToTableOptions`: after the `onBeat?` member add

```ts
  /** Counts the lines and the rows that break a rule (lib/ingest-quality-gate.ts). Passed by the staged path and, for a warning only, by the direct path. */
  gate?: GateCounters
  /** Runs once, after the first batch that brings `gate.lines` to `atLines`. A throw ends the import before that batch is written (an early hold costs a million lines, not a 4 GB file). */
  gateCheckpoint?: { atLines: number; check: () => void }
```

(d) `streamCredentialsToTable`: after `let tierDropped = 0` add `let checkpointDone = false`, and after the line `if (pipeline) pending = gen.next()` (inside the loop) insert

```ts

      // The quality gate counts what the parser produced, before the tier filter below drops anything. A hold at the checkpoint throws here, before this
      // batch is written; the finally releases the parser.
      if (options.gate) {
        recordGateBatch(options.gate, batch)
        const cp = options.gateCheckpoint
        if (cp && !checkpointDone && options.gate.lines >= cp.atLines) {
          checkpointDone = true
          cp.check()
        }
      }
```

(e) `importThroughStage`. Right after `const tables = stageTables(newStageId())` add

```ts

  // The quality gate counts the rows as they are staged and holds the file before commitStage when they break too many rules. A hold throws, so the
  // finally below drops the stage tables and nothing reaches ulp.credentials. A released file (hooks.gateOverride) is reported, not held.
  const gateConfig = parseGateConfig()
  const gate = gateConfig.mode === 'off' ? undefined : newGateCounters()
  const gateCheck = (phase: 'early' | 'final'): GateVerdict | null => {
    if (!gate) return null
    const verdict = evaluateGate(gate, gateConfig, phase)
    const holds = verdict.level === 'hold' && !hooks.gateOverride
    if (verdict.level !== 'pass' && (phase === 'final' || holds)) {
      console.warn(`[quality-gate] ${filename}: ${describeVerdict(verdict)}${verdict.level === 'hold' && hooks.gateOverride ? ' -- released by an admin, importing anyway' : ''}`)
    }
    if (holds) throw new IngestHeldError(verdict.report)
    return verdict
  }
```

In the `streamCredentialsToTable(a.stream, filename, { ... })` call, after the line `onBatchMetrics: recordBatch,` add

```ts
        gate,
        gateCheckpoint: gate ? { atLines: gateConfig.earlyLines, check: () => { gateCheck('early') } } : undefined,
```

After the block that logs `dropped ... low-tier rows pre-insert` (and before `const commit = await commitStage({`), add

```ts

    // Integrity before the gate: a damaged archive would read as a bad file. A throw here fails the job with nothing written.
    await hooks.beforeCommit?.()
    const gateVerdict = gateCheck('final')
```

In the returned object of `importThroughStage` add, after `tierDropped:         streamed.tierDropped,`:

```ts
      gate:                gateVerdict && gateVerdict.level !== 'pass' ? gateVerdict.report : undefined,
```

(f) The direct path in `processTextStream` (`startIngest(filename)` … `streamCredentialsToTable(stream, filename, { table: 'ulp.credentials', ...`): before `startIngest(filename)` add

```ts
  // Warn only: this path inserts as it parses, so there is nothing left to hold when the verdict is known.
  const gateConfig = parseGateConfig()
  const gate = gateConfig.mode === 'off' ? undefined : newGateCounters()
```

add `gate,` to that call's options (after `onBatchMetrics: recordBatch,`), and after the `finally { finishIngest() }` block of the direct path add

```ts

  if (gate) {
    const verdict = evaluateGate(gate, gateConfig, 'final')
    if (verdict.level !== 'pass') console.warn(`[quality-gate] ${filename}: ${describeVerdict(verdict)} (direct path: rows already written)`)
  }
```

- [ ] **Step 5: Run the new test and the neighbours**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/upload-processor-gate.test.ts __tests__/upload-processor-novelty.test.ts __tests__/upload-processor.test.ts __tests__/import-pipeline.test.ts __tests__/upload-processor-disk-gate.test.ts`
Expected: PASS. A neighbour that asserted an exact `console.warn` count may need its expectation adjusted; a gate warning on a tiny fixture is the new, correct behaviour (a downgraded hold), so change the neighbour's fixture or its assertion, not the gate.

- [ ] **Step 6: Measure the cost of the counters (budget: 5% of parse time)**

Create the scratch file `/tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/gate-overhead.mts` (not committed):

```ts
import { parseULPStream } from '@/lib/ulp-parser'
import { newGateCounters, recordGateBatch } from '@/lib/ingest-quality-gate'

const N = 600_000
const text = Array.from({ length: N }, (_, i) => `https://shop${i % 500}.example-store.test/login:user${i}@probe-mail.test:Pw-${i}-Xy!`).join('\n') + '\n'

async function run(withGate: boolean): Promise<number> {
  const stream = new Response(text).body as ReadableStream<Uint8Array>
  const counters = newGateCounters()
  const t0 = performance.now()
  for await (const batch of parseULPStream(stream, 'f.txt', 100_000, undefined, { dedupInFile: false })) {
    if (withGate) recordGateBatch(counters, batch)
  }
  return performance.now() - t0
}

await run(false) // warm up
const plain: number[] = []
const gated: number[] = []
for (let i = 0; i < 5; i++) {
  plain.push(await run(false))
  gated.push(await run(true))
}
const median = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]
console.log(`parse ${median(plain).toFixed(0)} ms, parse + gate ${median(gated).toFixed(0)} ms, overhead ${((median(gated) / median(plain) - 1) * 100).toFixed(1)}%`)
```

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && nice -n 10 npx tsx --tsconfig tsconfig.json /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/gate-overhead.mts`
Expected: an overhead under 5%. If it is higher, profile `classifyStoredRow` (the first suspects are `LOGIN_IS_URL` and `urlHoldsCredential`) and shorten the common path; do not lower the budget. Record the measured number in the commit message.

- [ ] **Step 7: Type-check, lint, run the whole suite for fallout**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit -p . 2>&1 | head -20 && npx eslint --no-eslintrc -c .eslintrc.json lib/upload-processor.ts lib/import-runner.ts __tests__/upload-processor-gate.test.ts && npx vitest run 2>&1 | tail -15`
Expected: tsc and eslint print nothing; vitest reports every file passed.

- [ ] **Step 8: Commit**

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add lib/import-runner.ts lib/upload-processor.ts __tests__/upload-processor-gate.test.ts
printf '%s\n' 'feat(gate): the importer counts every batch and holds a bad file before commitStage' '' 'streamCredentialsToTable feeds the counters; importThroughStage checks once after the first million lines and once before the commit and throws IngestHeldError on a hold, so the stage is dropped and ulp.credentials is untouched. hooks.gateOverride (a released file), hooks.beforeCommit (runs before the final check) and hooks.source are the new extension points. The direct path only warns. Counter cost: <measured> % of parse time.' '' 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate2.txt
git commit -F /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate2.txt
```


---

### Task 3: Persistence and the inbox: `held/`, the job log, one-shot releases, the watcher

**Files:**
- Modify: `lib/sqlite.ts`, `lib/processing-log.ts`, `lib/audit-log.ts`, `lib/inbox-helpers.ts`, `lib/inbox-watcher.ts`
- Create: `lib/ingest-gate-store.ts`
- Test: `__tests__/processing-log-gate.test.ts`, `__tests__/ingest-gate-store.test.ts`, `__tests__/inbox-held-helpers.test.ts`, `__tests__/inbox-watcher-held.test.ts` (create); `__tests__/upload-audit.test.ts`, `__tests__/inbox-watcher-runner.test.ts` (modify)

**Interfaces:**
- Consumes: Task 1 (`IngestHeldError`, `isIngestHeldError`, `GateReport`), Task 2 (`ImportHooks.gateOverride`, `ProcessResult.gate`).
- Produces:
  - `JobLogEntry.status: 'done' | 'failed' | 'held'`, `JobLogEntry.gate_report?: string`
  - `lib/ingest-gate-store.ts`: `addGateOverride(filename: string, by: string | null): boolean`, `removeGateOverride(filename: string): void`, `consumeGateOverride(filename: string): boolean`, `latestHeldReport(filename: string): GateReport | null`
  - `lib/inbox-helpers.ts`: `HELD_DIR`, `isSafeFileName(name: string): boolean`, `getHeld(heldDir?: string): InboxFileEntry[]`, `releaseFiles(filenames: string[], heldDir?: string, inboxDir?: string): string[]`, `holdSpooledFile(spoolPath: string, uploadName: string, heldDir?: string): string | null`
  - `AuditAction` includes `'inbox.release'` (resource type `inbox`)
  - The watcher: `inbox/held/`, `.archiveref` files are claimed and imported through `processArchiveRef` (Task 6 writes it; the watcher already calls it, so Task 3 adds a stub export in Step 7 and Task 6 replaces the stub).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/processing-log-gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { dbGet, dbQuery } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

describe('processing_jobs.gate_report and gate_overrides', () => {
  it('the application database has a nullable gate_report column and a gate_overrides table keyed by file name', () => {
    const cols = dbQuery('PRAGMA table_info(processing_jobs)') as Array<{ name: string; type: string; notnull: number }>
    expect(cols.find(c => c.name === 'gate_report')).toMatchObject({ type: 'TEXT', notnull: 0 })
    const overrides = dbQuery('PRAGMA table_info(gate_overrides)') as Array<{ name: string; pk: number }>
    expect(overrides.map(c => c.name).sort()).toEqual(['created_at', 'created_by', 'filename'])
    expect(overrides.find(c => c.name === 'filename')?.pk).toBe(1)
  })

  it('logJob stores a held job with its report, and NULL when there is none', () => {
    logJob({
      source: 'inbox', filename: 'gate-roundtrip-a.txt', status: 'held', imported: 0, skipped: 0, duration_ms: 5,
      error_message: 'Held by the quality gate: x.', gate_report: '{"level":"hold"}',
    })
    logJob({ source: 'inbox', filename: 'gate-roundtrip-b.txt', status: 'done', imported: 5, skipped: 0, duration_ms: 5 })
    expect(dbGet('SELECT status, gate_report FROM processing_jobs WHERE filename = ?', ['gate-roundtrip-a.txt'])).toEqual({ status: 'held', gate_report: '{"level":"hold"}' })
    expect(dbGet('SELECT gate_report FROM processing_jobs WHERE filename = ?', ['gate-roundtrip-b.txt'])).toEqual({ gate_report: null })
  })
})
```

Create `__tests__/ingest-gate-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { dbGet, dbRun } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'
import { addGateOverride, consumeGateOverride, latestHeldReport, removeGateOverride } from '@/lib/ingest-gate-store'

beforeEach(() => {
  dbRun('DELETE FROM gate_overrides')
})

describe('gate overrides: a release is one-shot and belongs to one file name', () => {
  it('is consumed by the next claim of that name, once', () => {
    expect(addGateOverride('a.txt', 'admin@example.com')).toBe(true)
    expect(consumeGateOverride('a.txt')).toBe(true)
    expect(consumeGateOverride('a.txt')).toBe(false)
  })

  it('does not release another file', () => {
    addGateOverride('a.txt', null)
    expect(consumeGateOverride('b.txt')).toBe(false)
    expect(consumeGateOverride('a.txt')).toBe(true)
  })

  it('keeps one row when the same file is released twice', () => {
    addGateOverride('a.txt', 'one@example.com')
    addGateOverride('a.txt', 'two@example.com')
    expect(dbGet(`SELECT count(*) AS n, max(created_by) AS by FROM gate_overrides WHERE filename = 'a.txt'`)).toEqual({ n: 1, by: 'two@example.com' })
  })

  it('removeGateOverride withdraws a release', () => {
    addGateOverride('a.txt', null)
    removeGateOverride('a.txt')
    expect(consumeGateOverride('a.txt')).toBe(false)
  })

  it('a release older than a day is gone', () => {
    dbRun(`INSERT INTO gate_overrides (filename, created_by, created_at) VALUES (?, ?, datetime('now', '-2 days'))`, ['old.txt', null])
    expect(consumeGateOverride('old.txt')).toBe(false)
    expect(dbGet(`SELECT count(*) AS n FROM gate_overrides WHERE filename = 'old.txt'`)).toEqual({ n: 0 })
  })
})

describe('latestHeldReport', () => {
  const held = (filename: string, gate_report: string) =>
    logJob({ source: 'inbox', filename, status: 'held', imported: 0, skipped: 0, duration_ms: 1, gate_report })

  it('returns the report of the newest held job of the file, and null for a file that was never held', () => {
    held('held-report-a.txt', JSON.stringify({ v: 1, level: 'hold', junkPct: 3 }))
    held('held-report-a.txt', JSON.stringify({ v: 1, level: 'hold', junkPct: 9 }))
    expect(latestHeldReport('held-report-a.txt')).toMatchObject({ junkPct: 9 })
    expect(latestHeldReport('never-held.txt')).toBeNull()
  })

  it('does not take a report from a job that was not held', () => {
    logJob({ source: 'inbox', filename: 'held-report-b.txt', status: 'done', imported: 1, skipped: 0, duration_ms: 1, gate_report: JSON.stringify({ v: 1, level: 'warn' }) })
    expect(latestHeldReport('held-report-b.txt')).toBeNull()
  })

  it('survives a malformed report', () => {
    held('held-report-c.txt', '{not json')
    expect(latestHeldReport('held-report-c.txt')).toBeNull()
  })
})
```

Create `__tests__/inbox-held-helpers.test.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getHeld, holdSpooledFile, isSafeFileName, releaseFiles } from '@/lib/inbox-helpers'

let root: string
let held: string
let inbox: string
let spool: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-held-'))
  held = path.join(root, 'inbox', 'held')
  inbox = path.join(root, 'inbox')
  spool = path.join(root, 'spool')
  fs.mkdirSync(spool, { recursive: true })
  fs.mkdirSync(inbox, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const spooled = (body = 'x\n') => {
  const p = path.join(spool, `${Math.random().toString(36).slice(2)}.part`)
  fs.writeFileSync(p, body)
  return p
}

describe('isSafeFileName', () => {
  it('accepts a plain name and refuses anything that could leave the directory', () => {
    expect(isSafeFileName('a b (1).txt')).toBe(true)
    for (const bad of ['', '../x', 'a/b', 'a\\b', '..', 'a..b', 'a\0b']) expect(isSafeFileName(bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('getHeld', () => {
  it('lists the files of the held directory with their sizes, and nothing when it does not exist', () => {
    expect(getHeld(held)).toEqual([])
    fs.mkdirSync(held, { recursive: true })
    fs.writeFileSync(path.join(held, 'a.txt'), '12345')
    fs.mkdirSync(path.join(held, 'sub'))
    expect(getHeld(held)).toEqual([{ name: 'a.txt', size_bytes: 5, mtime: expect.any(String) }])
  })
})

describe('releaseFiles', () => {
  it('moves a held file back to the inbox and reports the names it moved', () => {
    fs.mkdirSync(held, { recursive: true })
    fs.writeFileSync(path.join(held, 'a.txt'), 'a')
    fs.writeFileSync(path.join(held, 'b.txt'), 'b')
    expect(releaseFiles(['a.txt', 'missing.txt'], held, inbox)).toEqual(['a.txt'])
    expect(fs.existsSync(path.join(inbox, 'a.txt'))).toBe(true)
    expect(fs.existsSync(path.join(held, 'a.txt'))).toBe(false)
    expect(fs.existsSync(path.join(held, 'b.txt'))).toBe(true)
  })

  it('refuses a name that is a path', () => {
    fs.mkdirSync(held, { recursive: true })
    fs.writeFileSync(path.join(root, 'secret.txt'), 's')
    expect(releaseFiles(['../../secret.txt', '../secret.txt'], held, inbox)).toEqual([])
    expect(fs.existsSync(path.join(root, 'secret.txt'))).toBe(true)
  })
})

describe('holdSpooledFile', () => {
  it('moves the spooled upload into the held directory under its upload name', () => {
    const p = spooled('payload')
    expect(holdSpooledFile(p, 'upload.txt', held)).toBe('upload.txt')
    expect(fs.readFileSync(path.join(held, 'upload.txt'), 'utf8')).toBe('payload')
    expect(fs.existsSync(p)).toBe(false)
  })

  it('keeps only the base name, so an upload name cannot leave the directory', () => {
    expect(holdSpooledFile(spooled(), '../../etc/passwd', held)).toBe('passwd')
    expect(holdSpooledFile(spooled(), 'C:\\temp\\evil.txt', held)).toBe('evil.txt')
    expect(holdSpooledFile(spooled(), 'a\u0001b.txt', held)).toBe('ab.txt')
    expect(fs.readdirSync(held).sort()).toEqual(['ab.txt', 'evil.txt', 'passwd'])
  })

  it('gives a name that is already held a numbered sibling instead of overwriting it', () => {
    holdSpooledFile(spooled('first'), 'dup.txt', held)
    expect(holdSpooledFile(spooled('second'), 'dup.txt', held)).toBe('dup (2).txt')
    expect(fs.readFileSync(path.join(held, 'dup.txt'), 'utf8')).toBe('first')
    expect(fs.readFileSync(path.join(held, 'dup (2).txt'), 'utf8')).toBe('second')
  })

  it('names a nameless upload', () => {
    const name = holdSpooledFile(spooled(), '..', held)
    expect(name).toMatch(/^upload-\d+\.txt$/)
  })

  it('copies and removes when the spool is on another filesystem (EXDEV)', () => {
    const p = spooled('cross-device')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    })
    expect(holdSpooledFile(p, 'x.txt', held)).toBe('x.txt')
    expect(fs.readFileSync(path.join(held, 'x.txt'), 'utf8')).toBe('cross-device')
    expect(fs.existsSync(p)).toBe(false)
  })

  it('returns null when the spool file is gone', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(holdSpooledFile(path.join(spool, 'does-not-exist.part'), 'x.txt', held)).toBeNull()
  })
})
```

Create `__tests__/inbox-watcher-held.test.ts`:

```ts
/**
 * The inbox watcher run for real against a temporary ./inbox: only the import itself, the job log and the override store are replaced.
 * The module reads ./inbox when it loads, so the test changes the working directory first.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IngestHeldError, type GateReport } from '@/lib/ingest-quality-gate'

const h = vi.hoisted(() => ({
  processTextFile: vi.fn(),
  processZipFile: vi.fn(),
  processArchiveRef: vi.fn(),
  logJob: vi.fn(),
  consume: vi.fn(),
}))

vi.mock('@/lib/upload-processor', () => ({ processTextFile: h.processTextFile, processZipFile: h.processZipFile, processArchiveRef: h.processArchiveRef }))
vi.mock('@/lib/processing-log', () => ({ logJob: h.logJob }))
vi.mock('@/lib/ingest-gate-store', () => ({ consumeGateOverride: h.consume }))
vi.mock('@/lib/upload-queue', () => ({ uploadQueue: (fn: () => Promise<unknown>) => fn(), queueSize: () => 0, setCurrentJob: () => {} }))
vi.mock('@/lib/clickhouse-memory-guard', () => ({ waitForHeadroom: async () => {} }))
vi.mock('@/lib/ingest-disk-gate', () => ({ waitForDiskSpace: async () => {} }))

const REPORT = {
  v: 1, phase: 'final', level: 'hold', reasons: ['10.00% of the stored rows break a rule (limit 2%)'],
  lines: 30_000, stored: 30_000, junk: 3_000, noFields: 0, noPassword: 0, garbage: 0, tierDropped: 0, gateErrors: 0,
  junkPct: 10, unsplitPct: 0, garbagePct: 0, kinds: { 'login-has-colon': 3_000 }, shapes: [],
  thresholds: { minLines: 20_000, holdJunkPct: 2, holdUnsplitPct: 5, holdGarbagePct: 25, warnJunkPct: 1, warnUnsplitPct: 2 },
} as GateReport

const OK = { imported: 5, known: 1, inFileDuplicates: 0, skipped: 2, errors: 0, filename: 'x', breach_name: 'b', rejection_breakdown: {}, alreadyImported: false, tierDropped: 0 }

let cwd: string
let root: string
let forceReconcile: () => number

beforeAll(async () => {
  cwd = process.cwd()
  root = mkdtempSync(join(tmpdir(), 'watcher-held-'))
  process.chdir(root)
  ;({ forceReconcile } = await import('@/lib/inbox-watcher'))
})

afterAll(() => {
  process.chdir(cwd)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.consume.mockReturnValue(false)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const dir = (...p: string[]) => join(root, 'inbox', ...p)
const drop = (name: string, body = 'x\n') => {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(dir(name), body)
}
const logged = (name: string) => h.logJob.mock.calls.map(c => c[0]).filter(e => e.filename === name)
const settled = (name: string) => vi.waitFor(() => { if (logged(name).length === 0) throw new Error('not logged yet') }, { timeout: 10_000, interval: 100 })
const run = async (name: string, body?: string) => {
  drop(name, body)
  forceReconcile()
  await settled(name)
}

describe('inbox watcher: held files', () => {
  it('moves a file the quality gate held to inbox/held/ and logs it as held with its report', async () => {
    h.processTextFile.mockRejectedValue(new IngestHeldError(REPORT))
    await run('held-a.txt')
    expect(existsSync(dir('held', 'held-a.txt'))).toBe(true)
    expect(existsSync(dir('failed', 'held-a.txt'))).toBe(false)
    expect(existsSync(dir('processing', 'held-a.txt'))).toBe(false)
    expect(existsSync(dir('held-a.txt'))).toBe(false)
    expect(logged('held-a.txt')).toEqual([expect.objectContaining({
      source: 'inbox', status: 'held', gate_report: JSON.stringify(REPORT), error_message: expect.stringContaining('Held by the quality gate'),
    })])
  })

  it('holds a ZIP the same way', async () => {
    h.processZipFile.mockRejectedValue(new IngestHeldError(REPORT))
    await run('held-b.zip')
    expect(existsSync(dir('held', 'held-b.zip'))).toBe(true)
    expect(logged('held-b.zip')[0]).toMatchObject({ status: 'held' })
  })

  it('still sends an ordinary failure to inbox/failed/', async () => {
    h.processTextFile.mockRejectedValue(new Error('boom'))
    await run('failed-a.txt')
    expect(existsSync(dir('failed', 'failed-a.txt'))).toBe(true)
    expect(existsSync(dir('held', 'failed-a.txt'))).toBe(false)
    expect(logged('failed-a.txt')[0]).toMatchObject({ status: 'failed', error_message: 'boom' })
  })

  it('consumes a release when it claims the file and hands it to the import as gateOverride', async () => {
    h.consume.mockImplementation((name: string) => name === 'released-a.txt')
    h.processTextFile.mockResolvedValue(OK)
    await run('released-a.txt')
    expect(h.consume).toHaveBeenCalledWith('released-a.txt')
    expect(h.processTextFile.mock.calls[0][4]).toMatchObject({ gateOverride: true })
    expect(existsSync(dir('done', 'released-a.txt'))).toBe(true)
  })

  it('does not release a file nobody released', async () => {
    h.processTextFile.mockResolvedValue(OK)
    await run('plain-a.txt')
    expect(h.processTextFile.mock.calls[0][4].gateOverride).toBe(false)
  })

  it('records the gate report of a file that was imported with a warning', async () => {
    h.processTextFile.mockResolvedValue({ ...OK, gate: { ...REPORT, level: 'warn' } })
    await run('warned-a.txt')
    expect(logged('warned-a.txt')[0]).toMatchObject({ status: 'done', gate_report: JSON.stringify({ ...REPORT, level: 'warn' }) })
  })
})

describe('inbox watcher: .archiveref files', () => {
  it('imports the reference through processArchiveRef and keeps only the reference in done/', async () => {
    h.processArchiveRef.mockResolvedValue(OK)
    const ref = JSON.stringify({ v: 1, id: 'a'.repeat(24), name: 'original-name.txt', size: 3, sha256: 'a'.repeat(64) })
    await run('original-name.txt.archiveref', ref + '\n')
    expect(h.processArchiveRef).toHaveBeenCalledTimes(1)
    expect(h.processArchiveRef.mock.calls[0][0]).toBe(dir('processing', 'original-name.txt.archiveref'))
    expect(existsSync(dir('done', 'original-name.txt.archiveref'))).toBe(true)
    expect(existsSync(dir('done', 'original-name.txt'))).toBe(false)
    expect(logged('original-name.txt.archiveref')[0]).toMatchObject({ status: 'done', imported: 5, known: 1, skipped: 2 })
  })

  it('a reference that fails goes to failed/ like any file', async () => {
    h.processArchiveRef.mockRejectedValue(new Error('archive abc failed its sha256 check'))
    await run('bad.txt.archiveref', '{}\n')
    expect(existsSync(dir('failed', 'bad.txt.archiveref'))).toBe(true)
    expect(logged('bad.txt.archiveref')[0]).toMatchObject({ status: 'failed', error_message: 'archive abc failed its sha256 check' })
  })
})
```

Modify `__tests__/inbox-watcher-runner.test.ts`: the third import branch is new. Replace

```ts
  test('both the text and the zip import run inside runImportJob', () => {
    const afterClaim = source.slice(source.indexOf('claimFileForProcessing(filePath, PROC)'))
    expect(afterClaim.match(/runImportJob\(/g)?.length).toBe(2)
    expect(afterClaim).toContain('processZipFile(claimedPath')
    expect(afterClaim).toContain('processTextFile(claimedPath')
  })
```

with

```ts
  test('the text, the zip and the archive-reference import all run inside runImportJob', () => {
    const afterClaim = source.slice(source.indexOf('claimFileForProcessing(filePath, PROC)'))
    expect(afterClaim.match(/runImportJob\(/g)?.length).toBe(3)
    expect(afterClaim).toContain('processZipFile(claimedPath')
    expect(afterClaim).toContain('processTextFile(claimedPath')
    expect(afterClaim).toContain('processArchiveRef(claimedPath')
  })
```

In `__tests__/upload-audit.test.ts`, inside the existing `describe`, after the test `files an inbox retry under the inbox resource type and works without a request`, add:

```ts
  it('files an inbox release under the inbox resource type', async () => {
    await logUploadAction('inbox.release', { id: 3, email: 'admin@example.com' }, null, { moved: ['a.txt'], mode: 'one' })

    const [, params] = mockDbRun.mock.calls[0]
    expect(params[2]).toBe('inbox.release')
    expect(params[3]).toBe('inbox')
    expect(JSON.parse(params[5])).toEqual({ moved: ['a.txt'], mode: 'one' })
  })
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/processing-log-gate.test.ts __tests__/ingest-gate-store.test.ts __tests__/inbox-held-helpers.test.ts __tests__/inbox-watcher-held.test.ts __tests__/inbox-watcher-runner.test.ts __tests__/upload-audit.test.ts 2>&1 | tail -30`
Expected: FAIL (missing modules and exports, no `gate_report` column).

- [ ] **Step 3: SQLite schema**

In `lib/sqlite.ts`, after the line

```ts
  try { db.exec(`ALTER TABLE processing_jobs ADD COLUMN known INTEGER NOT NULL DEFAULT 0`) } catch {}
```

add

```ts

  // Ingest quality gate (lib/ingest-quality-gate.ts): the JSON report of a held or warned import. Additive, like `known` above.
  try { db.exec(`ALTER TABLE processing_jobs ADD COLUMN gate_report TEXT`) } catch {}

  // One-shot releases of held files (lib/ingest-gate-store.ts): an admin pressed Release; the next claim of that file name consumes the row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_overrides (
      filename   TEXT PRIMARY KEY,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
```

- [ ] **Step 4: The job log and the audit action**

In `lib/processing-log.ts` replace the interface member `status:         'done' | 'failed'` with `status:         'done' | 'failed' | 'held'`, add after `known?:         number`:

```ts
  /** The quality gate's JSON report (lib/ingest-quality-gate.ts) for a held file, or for a file imported with a warning. */
  gate_report?:   string
```

and replace the INSERT with

```ts
    dbRun(
      `INSERT INTO processing_jobs
         (source, filename, status, imported, skipped, duration_ms, error_message, breach_name, known, gate_report)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        entry.gate_report   ?? null,
      ],
    )
```

In `lib/audit-log.ts`: in `AuditAction` replace `  | 'inbox.retry'\n  | 'user.create'` with `  | 'inbox.retry' | 'inbox.release'\n  | 'user.create'`; replace `        | 'inbox.retry',\n  performedBy:` with `        | 'inbox.retry' | 'inbox.release',\n  performedBy:`; replace `resource_type: action === 'inbox.retry' ? 'inbox' : 'upload',` with `resource_type: action === 'inbox.retry' || action === 'inbox.release' ? 'inbox' : 'upload',`; and in the comment above `logUploadAction` replace "and who pressed Retry on an inbox file" with "and who pressed Retry or Release on an inbox file".

- [ ] **Step 5: The store**

Create `lib/ingest-gate-store.ts`:

```ts
/**
 * SQLite side of the ingest quality gate (lib/ingest-quality-gate.ts): the one-shot releases of held files, and the report of the newest hold of a file.
 *
 * A release is a row in gate_overrides keyed by FILE NAME. The Release route stores it before it moves the file back into the inbox; the watcher consumes it when
 * it claims that name. It is one-shot (a second import of the same name is gated again) and it expires after a day, so an old click cannot release a file that
 * comes back next month.
 */
import { dbGet, dbRun } from '@/lib/sqlite'
import type { GateReport } from '@/lib/ingest-quality-gate'

const OVERRIDE_MAX_AGE = '-1 day'

/** Stores a release. False when SQLite refused (the caller then must not move the file: it would only be held again). */
export function addGateOverride(filename: string, by: string | null): boolean {
  try {
    dbRun(`INSERT OR REPLACE INTO gate_overrides (filename, created_by) VALUES (?, ?)`, [filename, by])
    return true
  } catch (err) {
    console.error('[ingest-gate-store] could not store the release of a held file:', err instanceof Error ? err.message : err)
    return false
  }
}

export function removeGateOverride(filename: string): void {
  try {
    dbRun(`DELETE FROM gate_overrides WHERE filename = ?`, [filename])
  } catch {
    /* nothing to remove */
  }
}

/** True when an admin released this file name less than a day ago. The row is consumed. A SQLite failure answers false: the file is held again, the safe side. */
export function consumeGateOverride(filename: string): boolean {
  try {
    dbRun(`DELETE FROM gate_overrides WHERE created_at < datetime('now', ?)`, [OVERRIDE_MAX_AGE])
    return dbRun(`DELETE FROM gate_overrides WHERE filename = ?`, [filename]).changes > 0
  } catch {
    return false
  }
}

/** The report stored with the newest held job of this file name, or null. */
export function latestHeldReport(filename: string): GateReport | null {
  try {
    const row = dbGet(
      `SELECT gate_report FROM processing_jobs WHERE filename = ? AND status = 'held' AND gate_report IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [filename],
    ) as { gate_report: string } | undefined
    return row ? (JSON.parse(row.gate_report) as GateReport) : null
  } catch {
    return null
  }
}
```

- [ ] **Step 6: The inbox helpers**

In `lib/inbox-helpers.ts`:

(a) After `export const FAILED_DIR = path.resolve('./inbox/failed')` add

```ts
/** Files the ingest quality gate stopped before one row was stored; an admin releases them from the Inbox page. */
export const HELD_DIR   = path.resolve('./inbox/held')

/** A plain file name: no separator, no "..", no NUL. */
export function isSafeFileName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.includes('..') && !name.includes('\0')
}
```

(b) In `retryFiles` replace `if (name.includes('/') || name.includes('\\') || name.includes('..')) continue` with `if (!isSafeFileName(name)) continue`.

(c) After `getFailed` add

```ts

/** Files in inbox/held/. */
export function getHeld(heldDir: string = HELD_DIR): InboxFileEntry[] {
  return readFileEntries(heldDir)
}
```

(d) After `retryAllFailed` add

```ts

/**
 * Move named files from inbox/held/ → inbox/ (same traversal guard as retryFiles). The caller stores the one-shot release BEFORE calling this: the watcher
 * can claim the file the moment it appears. Returns the names actually moved.
 */
export function releaseFiles(filenames: string[], heldDir: string = HELD_DIR, inboxDir: string = INBOX_DIR): string[] {
  const moved: string[] = []
  for (const name of filenames) {
    if (!isSafeFileName(name)) continue
    try {
      fs.renameSync(path.join(heldDir, name), path.join(inboxDir, name))
      moved.push(name)
    } catch {
      // file missing or unreadable — skip
    }
  }
  return moved
}

/**
 * Keep a spooled HTTP upload that the quality gate held: move it into inbox/held/ under a safe name that is not taken yet. The spool directory is usually on
 * another filesystem than the inbox, so a rename that fails with EXDEV falls back to copy + remove. Returns the name it is kept under, or null (the caller then
 * discards the spool file as before).
 */
export function holdSpooledFile(spoolPath: string, uploadName: string, heldDir: string = HELD_DIR): string | null {
  const base = path.basename(uploadName.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim()
  const safe = base === '' || base === '.' || base === '..' ? `upload-${Date.now()}.txt` : base
  try {
    fs.mkdirSync(heldDir, { recursive: true })
    const ext = path.extname(safe)
    const stem = safe.slice(0, safe.length - ext.length)
    let name = safe
    for (let n = 2; fs.existsSync(path.join(heldDir, name)); n++) {
      if (n > 100) return null
      name = `${stem} (${n})${ext}`
    }
    const dest = path.join(heldDir, name)
    try {
      fs.renameSync(spoolPath, dest)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      fs.copyFileSync(spoolPath, dest)
      fs.rmSync(spoolPath, { force: true })
    }
    return name
  } catch (err) {
    console.error('[inbox] could not keep the held upload:', err instanceof Error ? err.message : err)
    return null
  }
}
```

- [ ] **Step 7: The watcher**

In `lib/inbox-watcher.ts`, apply these edits in this order.

(a) Header comment: after ` *   ./inbox/failed/     — failed (or interrupted) files are moved here` add the line ` *   ./inbox/held/       — files the ingest quality gate stopped before one row was stored (an admin releases them)`.

(b) Imports. Replace `import { processTextFile, processZipFile } from '@/lib/upload-processor'` with `import { processTextFile, processZipFile, processArchiveRef } from '@/lib/upload-processor'`, and after `import { sniffFileKind } from '@/lib/inbox-helpers'` add

```ts
import { isIngestHeldError } from '@/lib/ingest-quality-gate'
import { consumeGateOverride } from '@/lib/ingest-gate-store'
import { ARCHIVE_REF_EXT } from '@/lib/archive-ref'
```

(c) Directories. After `const FAIL  = path.resolve('./inbox/failed')` add

```ts
// held/ keeps a file the ingest quality gate stopped before one row was stored (lib/ingest-quality-gate.ts); an admin releases it from the Inbox page.
const HELD  = path.resolve('./inbox/held')
```

and after `const PROC_PREFIX = PROC + path.sep` add `const HELD_PREFIX = HELD + path.sep`.

(d) Replace `const SUPPORTED_EXTS = new Set(['.txt', '.csv', '.zip'])` with `const SUPPORTED_EXTS = new Set(['.txt', '.csv', '.zip', ARCHIVE_REF_EXT])`; in the unsupported-extension message replace `supported: .txt, .csv, .zip` with `supported: .txt, .csv, .zip, .archiveref`.

(e) Replace `  if (filePath.startsWith(DONE_PREFIX) || filePath.startsWith(FAIL_PREFIX) || filePath.startsWith(PROC_PREFIX)) return` with

```ts
  if (filePath.startsWith(DONE_PREFIX) || filePath.startsWith(FAIL_PREFIX) || filePath.startsWith(PROC_PREFIX) || filePath.startsWith(HELD_PREFIX)) return
```

(f) In the queued task: after `    let procPath: string | null = null` add `    let gateReport: string | undefined`. Before `      console.log(\`[inbox-watcher] processing: ${filename}\`)` insert

```ts
      // A file an admin released from the Held list is imported once without being held again (lib/ingest-gate-store.ts). The quality gate still
      // counts it and reports what it found.
      const gateOverride = consumeGateOverride(filename)
      if (gateOverride) console.warn(`[inbox-watcher] ${filename} was released by an admin: the quality gate reports on it but does not hold it`)

```

(g) The text branch. Replace

```ts
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

with

```ts
          }, { ...ctx, onImportProgress, gateOverride }),
        })
        imported = result.imported
        known    = result.known
        skipped  = result.skipped
        gateReport = result.gate ? JSON.stringify(result.gate) : undefined
        console.log(
          `[inbox-watcher] done: ${filename} ` +
          `imported=${result.imported} known=${result.known} skipped=${result.skipped}`
        )
      }
```

(h) The zip branch and the new archive branch. Replace

```ts
          }, { ...ctx, onImportProgress }),
        })
      } else {
```

with

```ts
          }, { ...ctx, onImportProgress, gateOverride }),
        })
      } else if (ext === ARCHIVE_REF_EXT) {
        // The reference names a file in the source archive (lib/archive-ref.ts): the plaintext is read from there, never from the inbox.
        const result = await runImportJob({
          label: filename,
          work:  ctx => processArchiveRef(claimedPath, n => {
            const cp = getCurrentProgress()
            if (cp) cp.rows_imported = n
          }, { ...ctx, onImportProgress, gateOverride }),
        })
        imported = result.imported
        known    = result.known
        skipped  = result.skipped
        gateReport = result.gate ? JSON.stringify(result.gate) : undefined
        console.log(
          `[inbox-watcher] done: ${filename} (from the archive) ` +
          `imported=${result.imported} known=${result.known} skipped=${result.skipped}`
        )
      } else {
```

(i) The done log. Replace

```ts
        status:      'done',
        imported,
        known,
        skipped,
        duration_ms: Date.now() - startAt,
      })
```

with

```ts
        status:      'done',
        imported,
        known,
        skipped,
        duration_ms: Date.now() - startAt,
        gate_report: gateReport,
      })
```

(j) The catch. Replace

```ts
    } catch (err) {
      console.error(`[inbox-watcher] failed: ${filename}`, err)
      logJob({
        source:        'inbox',
        filename,
        status:        'failed',
        imported,
        known,
        skipped,
        duration_ms:   Date.now() - startAt,
        error_message: err instanceof Error ? err.message : String(err),
      })
      // Move the claimed file (if we claimed it) to failed/ for review.
      if (procPath) {
        try {
          fs.mkdirSync(FAIL, { recursive: true })
          fs.renameSync(procPath, path.join(FAIL, filename))
        } catch {}
      }
    } finally {
```

with

```ts
    } catch (err) {
      if (isIngestHeldError(err)) {
        // The quality gate stopped the file before one of its rows was stored: keep it in held/ for an admin to look at, and log why.
        console.warn(`[inbox-watcher] held: ${filename}: ${err.message}`)
        logJob({
          source:        'inbox',
          filename,
          status:        'held',
          imported,
          known,
          skipped,
          duration_ms:   Date.now() - startAt,
          error_message: err.message,
          gate_report:   JSON.stringify(err.report),
        })
        if (procPath) {
          try {
            fs.mkdirSync(HELD, { recursive: true })
            fs.renameSync(procPath, path.join(HELD, filename))
          } catch (moveErr) {
            console.error(`[inbox-watcher] could not move the held file ${filename} to held/, moving it to failed/:`, moveErr)
            try {
              fs.mkdirSync(FAIL, { recursive: true })
              fs.renameSync(procPath, path.join(FAIL, filename))
            } catch {}
          }
        }
      } else {
        console.error(`[inbox-watcher] failed: ${filename}`, err)
        logJob({
          source:        'inbox',
          filename,
          status:        'failed',
          imported,
          known,
          skipped,
          duration_ms:   Date.now() - startAt,
          error_message: err instanceof Error ? err.message : String(err),
        })
        // Move the claimed file (if we claimed it) to failed/ for review.
        if (procPath) {
          try {
            fs.mkdirSync(FAIL, { recursive: true })
            fs.renameSync(procPath, path.join(FAIL, filename))
          } catch {}
        }
      }
    } finally {
```

(k) In `startInboxWatcher` replace `;[INBOX, DONE, FAIL, PROC].forEach(d => fs.mkdirSync(d, { recursive: true }))` with `;[INBOX, DONE, FAIL, PROC, HELD].forEach(d => fs.mkdirSync(d, { recursive: true }))`.

(l) The files that Task 6 will write do not exist yet. Create the two stubs so that this task compiles and its tests run; Task 6 replaces them with the real thing. `lib/archive-ref.ts`:

```ts
// Replaced by Task 6 (the real .archiveref support).
export const ARCHIVE_REF_EXT = '.archiveref'
```

and append to `lib/upload-processor.ts`, after `processTextFile`:

```ts

// Replaced by Task 6 (reads the plaintext from the source archive).
export async function processArchiveRef(
  _refPath: string,
  _onBatch?: (imported: number) => void,
  _hooks: ImportHooks = {},
): Promise<ProcessResult> {
  throw new Error('archive references are not supported yet')
}
```

- [ ] **Step 8: Run the tests**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/processing-log-gate.test.ts __tests__/ingest-gate-store.test.ts __tests__/inbox-held-helpers.test.ts __tests__/inbox-watcher-held.test.ts __tests__/inbox-watcher-runner.test.ts __tests__/upload-audit.test.ts __tests__/processing-log.test.ts __tests__/processing-log-known.test.ts __tests__/inbox-claim.test.ts __tests__/inbox-watcher-disk-gate.test.ts __tests__/inbox-watcher-memory-guard.test.ts __tests__/inbox-watcher-stability.test.ts __tests__/inbox-watcher-globalthis.test.ts 2>&1 | tail -30`
Expected: PASS. The watcher test takes about 10 seconds (each file waits 1 s for its size to be stable).

- [ ] **Step 9: Type-check, lint, commit**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit -p . 2>&1 | head -20 && npx eslint --no-eslintrc -c .eslintrc.json lib/ingest-gate-store.ts lib/inbox-helpers.ts lib/inbox-watcher.ts lib/processing-log.ts lib/audit-log.ts lib/sqlite.ts`
Expected: no output.

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add lib __tests__
printf '%s\n' 'feat(gate): held files: inbox/held, the job log, one-shot releases, the watcher' '' 'A file the quality gate holds moves from processing/ to inbox/held/ and its job is logged as held with the JSON report. gate_overrides stores a release per file name (one-shot, expires after a day); the watcher consumes it at the claim and hands it to the import as gateOverride. .archiveref joins the supported extensions (Task 6 supplies processArchiveRef; a stub keeps this commit building). Audit action inbox.release.' '' 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate3.txt
git commit -F /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate3.txt
```

---

### Task 4: Release, the Held list, the held count, and the HTTP routes

**Files:**
- Create: `app/api/inbox/release/route.ts`
- Modify: `app/api/inbox/status/route.ts`, `app/inbox/page.tsx`, `app/api/monitoring/ingest-health/route.ts`, `components/ingest-health-panel.tsx`, `app/api/upload/route.ts`, `app/api/v1/upload/route.ts`
- Test: `__tests__/inbox-release-route.test.ts` (create); `__tests__/inbox-status-route-novelty.test.ts`, `__tests__/ingest-health-route.test.ts`, `__tests__/ingest-health-panel.test.ts`, `__tests__/upload-route-spool.test.ts`, `__tests__/upload-v1-route-spool.test.ts` (modify)

**Interfaces:**
- Consumes: Task 3 (`getHeld`, `releaseFiles`, `isSafeFileName`, `holdSpooledFile`, `addGateOverride`, `removeGateOverride`, `latestHeldReport`, `logJob` with `held`).
- Produces:
  - `POST /api/inbox/release` with `{ filename: string }` or `{ all: true }` answers `{ success: true, moved: string[] }`; audit action `inbox.release` with `{ moved, mode: 'one' | 'all' }`.
  - `GET /api/inbox/status` gains `held: Array<InboxFileEntry & { report: GateReport | null }>` and, on each `done_recent` row, `gate_level` and `gate_note`.
  - `GET /api/monitoring/ingest-health` gains `held: { count: number }`.
  - An HTTP text upload that is held ends its job as `error` with the hold message and keeps the file in `inbox/held/`; a ZIP upload and a v1 upload answer `422` `{ success: false, held: true, kept: boolean, error, report }`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/inbox-release-route.test.ts`:

```ts
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  order: [] as string[],
  getHeld: vi.fn(),
  releaseFiles: vi.fn(),
  addGateOverride: vi.fn(),
  removeGateOverride: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '4', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/inbox-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/inbox-helpers')>('@/lib/inbox-helpers')
  return { ...actual, getHeld: h.getHeld, releaseFiles: h.releaseFiles }
})
vi.mock('@/lib/ingest-gate-store', () => ({ addGateOverride: h.addGateOverride, removeGateOverride: h.removeGateOverride }))
vi.mock('@/lib/audit-log', () => ({ logUploadAction: h.audit }))

import { POST } from '@/app/api/inbox/release/route'

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/inbox/release', { method: 'POST', body: JSON.stringify(body) }))
const admin = { id: 4, email: 'admin@example.com' }

beforeEach(() => {
  h.order.length = 0
  for (const fn of [h.getHeld, h.releaseFiles, h.addGateOverride, h.removeGateOverride, h.audit]) fn.mockReset()
  h.addGateOverride.mockImplementation((name: string) => { h.order.push(`override:${name}`); return true })
  h.releaseFiles.mockImplementation((names: string[]) => { h.order.push(`move:${names.join(',')}`); return names })
  h.audit.mockResolvedValue(1)
})

describe('POST /api/inbox/release', () => {
  it('stores the one-shot release BEFORE it moves the file (the watcher could claim it the moment it is back), then records who released what', async () => {
    const res = await post({ filename: 'a.txt' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, moved: ['a.txt'] })
    expect(h.order).toEqual(['override:a.txt', 'move:a.txt'])
    expect(h.addGateOverride).toHaveBeenCalledWith('a.txt', 'admin@example.com')
    expect(h.audit).toHaveBeenCalledWith('inbox.release', admin, null, { moved: ['a.txt'], mode: 'one' }, expect.anything())
  })

  it('releases every held file for { all: true }', async () => {
    h.getHeld.mockReturnValue([{ name: 'a.txt' }, { name: 'b.zip' }])
    const res = await post({ all: true })
    expect((await res.json()).moved).toEqual(['a.txt', 'b.zip'])
    expect(h.audit).toHaveBeenCalledWith('inbox.release', admin, null, { moved: ['a.txt', 'b.zip'], mode: 'all' }, expect.anything())
  })

  it('withdraws the release when the file could not be moved', async () => {
    h.releaseFiles.mockReturnValue([])
    const res = await post({ filename: 'gone.txt' })
    expect((await res.json()).moved).toEqual([])
    expect(h.removeGateOverride).toHaveBeenCalledWith('gone.txt')
  })

  it('does not move a file whose release could not be stored: it would only be held again', async () => {
    h.addGateOverride.mockReturnValue(false)
    const res = await post({ filename: 'a.txt' })
    expect((await res.json()).moved).toEqual([])
    expect(h.releaseFiles).not.toHaveBeenCalled()
  })

  it('refuses a name that is a path, without storing anything', async () => {
    const res = await post({ filename: '../x.txt' })
    expect((await res.json()).moved).toEqual([])
    expect(h.addGateOverride).not.toHaveBeenCalled()
    expect(h.releaseFiles).not.toHaveBeenCalled()
  })

  it('rejects a malformed body and records nothing', async () => {
    const res = await post({ nothing: true })
    expect(res.status).toBe(400)
    expect(h.audit).not.toHaveBeenCalled()
    const notJson = await POST(new NextRequest('http://localhost/api/inbox/release', { method: 'POST', body: '{' }))
    expect(notJson.status).toBe(400)
  })
})
```

In `__tests__/inbox-status-route-novelty.test.ts`: change the hoisted block and mocks. Replace

```ts
const h = vi.hoisted(() => ({ progress: null as null | Record<string, unknown>, dbQuery: vi.fn() }))
```

with

```ts
const h = vi.hoisted(() => ({ progress: null as null | Record<string, unknown>, dbQuery: vi.fn(), held: [] as Array<Record<string, unknown>>, latestHeldReport: vi.fn() }))
```

replace the line `vi.mock('@/lib/inbox-helpers', () => ({ getWaiting: () => [], getFailed: () => [], getDoneCount: () => 0 }))` with

```ts
vi.mock('@/lib/inbox-helpers', () => ({ getWaiting: () => [], getFailed: () => [], getHeld: () => h.held, getDoneCount: () => 0 }))
vi.mock('@/lib/ingest-gate-store', () => ({ latestHeldReport: h.latestHeldReport }))
```

in `beforeEach` add `h.held = []` and `h.latestHeldReport.mockReset()`, and append inside the `describe`:

```ts
  it('lists the files held by the quality gate with the report of their hold', async () => {
    h.held = [{ name: 'held.txt', size_bytes: 10, mtime: 'x' }, { name: 'noreport.txt', size_bytes: 5, mtime: 'y' }]
    h.latestHeldReport.mockImplementation((name: string) => (name === 'held.txt' ? { level: 'hold', junkPct: 7 } : null))
    const json = await get()
    expect(json.held).toEqual([
      { name: 'held.txt', size_bytes: 10, mtime: 'x', report: { level: 'hold', junkPct: 7 } },
      { name: 'noreport.txt', size_bytes: 5, mtime: 'y', report: null },
    ])
  })

  it('says nothing is held when nothing is', async () => {
    expect((await get()).held).toEqual([])
  })

  it('selects the gate level and the first reason of each recent job, and tolerates a malformed report', async () => {
    h.dbQuery.mockReturnValue([{ id: 1, filename: 'a.txt', status: 'held', imported: 0, known: 0, skipped: 0, duration_ms: 1, error_message: 'Held', created_at: 'x', gate_level: 'hold', gate_note: '7% break a rule' }])
    const json = await get()
    const sql = h.dbQuery.mock.calls[0][0] as string
    expect(sql).toMatch(/json_valid\(gate_report\)/)
    expect(sql).toMatch(/AS gate_level/)
    expect(sql).toMatch(/AS gate_note/)
    expect(json.done_recent[0]).toMatchObject({ status: 'held', gate_level: 'hold', gate_note: '7% break a rule' })
  })
```

In `__tests__/ingest-health-route.test.ts` add after the existing `vi.mock('@/lib/ingest-metrics', ...)` block:

```ts
const held = vi.hoisted(() => ({ list: [] as Array<{ name: string }> }))
vi.mock('@/lib/inbox-helpers', () => ({ getHeld: () => held.list }))
```

in `beforeEach` add `held.list = []`, and append inside the `describe`:

```ts
  it('reports how many files the quality gate is holding', async () => {
    held.list = [{ name: 'a.txt' }, { name: 'b.txt' }]
    const json = await (await GET({} as any)).json()
    expect(json.held).toEqual({ count: 2 })
  })

  it('reports zero held files when there are none', async () => {
    const json = await (await GET({} as any)).json()
    expect(json.held).toEqual({ count: 0 })
  })
```

In `__tests__/ingest-health-panel.test.ts` append:

```ts
describe('Ingest Health panel — files held by the quality gate', () => {
  test('shows an amber line with the count and points at the Inbox, only when something is held', () => {
    expect(panel).toContain('data-testid="held-files"')
    expect(panel).toContain('held by the quality gate')
    expect(panel).toContain('{held && held.count > 0 && (')
  })

  test('the block is optional in the payload, so an older server response still renders', () => {
    expect(panel).toMatch(/held\?: \{/)
  })
})
```

In `__tests__/upload-route-spool.test.ts`: add to the `vi.mock('@/lib/processing-log', ...)` neighbours

```ts
const held = vi.hoisted(() => ({ holdSpooledFile: vi.fn() }))
vi.mock('@/lib/inbox-helpers', () => ({ holdSpooledFile: held.holdSpooledFile }))
```

and, after the imports, `import { IngestHeldError, type GateReport } from '@/lib/ingest-quality-gate'`; append a new `describe`:

```ts
describe('POST /api/upload: a file the quality gate holds', () => {
  const REPORT = { v: 1, phase: 'final', level: 'hold', reasons: ['10.00% of the stored rows break a rule (limit 2%)'], lines: 30_000, stored: 30_000, junk: 3_000 } as unknown as GateReport

  it('ends a text upload as an error with the hold message, keeps the file, and logs the job as held', async () => {
    held.holdSpooledFile.mockReturnValue('kept.txt')
    mockProcessTextFile.mockRejectedValueOnce(new IngestHeldError(REPORT))
    const res = await post('held.txt', 'a:b:c\n')
    const { jobId } = await res.json()
    await vi.waitFor(() => { expect(getJob(jobId)?.status).toBe('error') }, { timeout: 5000 })
    expect(getJob(jobId)?.error).toContain('Held by the quality gate')
    expect(getJob(jobId)?.error).toContain('kept')
    expect(held.holdSpooledFile).toHaveBeenCalledWith(expect.stringContaining(spoolRoot), 'held.txt')
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ source: 'http', filename: 'held.txt', status: 'held', gate_report: JSON.stringify(REPORT) }))
    expect(mockAudit).toHaveBeenCalledWith('upload.fail', admin, jobId, expect.objectContaining({ held: true }))
  })

  it('answers a ZIP upload with 422 and the report, and keeps the archive', async () => {
    held.holdSpooledFile.mockReturnValue('kept.zip')
    mockProcessZipFile.mockRejectedValueOnce(new IngestHeldError(REPORT))
    const res = await post('held.zip', 'PK')
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ success: false, held: true, kept: true, report: { level: 'hold' } })
    expect(held.holdSpooledFile).toHaveBeenCalledWith(expect.stringContaining(spoolRoot), 'held.zip')
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ filename: 'held.zip', status: 'held' }))
  })
})
```

(Also add `held.holdSpooledFile.mockReset()` to that file's `beforeEach`.)

In `__tests__/upload-v1-route-spool.test.ts` make the same two additions (the `inbox-helpers` mock and the import) and append:

```ts
describe('POST /api/v1/upload: a file the quality gate holds', () => {
  const REPORT = { v: 1, phase: 'final', level: 'hold', reasons: ['10.00% of the stored rows break a rule (limit 2%)'] } as unknown as GateReport

  it('answers 422 with the report, keeps the file and logs the job as held (not failed)', async () => {
    held.holdSpooledFile.mockReturnValue('kept.txt')
    mockProcessTextFile.mockRejectedValueOnce(new IngestHeldError(REPORT))
    const res = await post('held.txt', 'a:b:c\n')
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ success: false, held: true, kept: true, report: { level: 'hold' } })
    expect(mockLogJob).toHaveBeenCalledWith(expect.objectContaining({ filename: 'held.txt', status: 'held' }))
    expect(mockLogJob).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  })
})
```

(`post(name, body)` is the helper that file already defines.)

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/inbox-release-route.test.ts __tests__/inbox-status-route-novelty.test.ts __tests__/ingest-health-route.test.ts __tests__/ingest-health-panel.test.ts __tests__/upload-route-spool.test.ts __tests__/upload-v1-route-spool.test.ts 2>&1 | tail -30`
Expected: FAIL.

- [ ] **Step 3: The Release route**

Create `app/api/inbox/release/route.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { getHeld, isSafeFileName, releaseFiles } from '@/lib/inbox-helpers'
import { addGateOverride, removeGateOverride } from '@/lib/ingest-gate-store'
import { logUploadAction } from '@/lib/audit-log'

export const dynamic = 'force-dynamic'

/**
 * Release files the ingest quality gate held (lib/ingest-quality-gate.ts). A file goes back to the inbox with a one-shot release stored for its name: the watcher
 * imports it once without holding it again, and reports what the gate found. The release is stored BEFORE the file moves, because the watcher can claim the file
 * the moment it is back.
 */
export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ success: false, error: 'Body must be an object' }, { status: 400 })
  }

  const b = body as Record<string, unknown>

  let names: string[]
  if (b.all === true) {
    names = getHeld().map(f => f.name)
  } else if (typeof b.filename === 'string' && b.filename.length > 0) {
    names = [b.filename]
  } else {
    return NextResponse.json(
      { success: false, error: 'Body must be { filename: string } or { all: true }' },
      { status: 400 },
    )
  }

  const moved: string[] = []
  for (const name of names) {
    if (!isSafeFileName(name)) continue
    if (!addGateOverride(name, user?.email || null)) continue
    if (releaseFiles([name]).length === 1) moved.push(name)
    else removeGateOverride(name)
  }

  await logUploadAction(
    'inbox.release',
    { id: user ? Number(user.userId) : null, email: user?.email || null },
    null,
    { moved, mode: b.all === true ? 'all' : 'one' },
    request,
  )

  return NextResponse.json({ success: true, moved })
}
```

- [ ] **Step 4: The status route**

In `app/api/inbox/status/route.ts`: replace `import { getWaiting, getFailed, getDoneCount } from '@/lib/inbox-helpers'` with

```ts
import { getWaiting, getFailed, getHeld, getDoneCount } from '@/lib/inbox-helpers'
import { latestHeldReport } from '@/lib/ingest-gate-store'
```

add to `DoneRow` (after `error_message: string | null`):

```ts
  gate_level:    string | null
  gate_note:     string | null
```

replace `  const failed     = getFailed()` with

```ts
  const failed     = getFailed()
  // Files the ingest quality gate stopped, each with the report of its hold (null when none was recorded).
  const held       = getHeld().map(f => ({ ...f, report: latestHeldReport(f.name) }))
```

replace the `done_recent` query with

```ts
  const done_recent = dbQuery(
    `SELECT id, filename, status, imported, known, skipped, duration_ms, error_message, created_at,
            CASE WHEN json_valid(gate_report) THEN json_extract(gate_report, '$.level') END AS gate_level,
            CASE WHEN json_valid(gate_report) THEN json_extract(gate_report, '$.reasons[0]') END AS gate_note
     FROM processing_jobs
     WHERE source = 'inbox'
     ORDER BY id DESC
     LIMIT 10`,
  ) as DoneRow[]
```

and add `    held,` after `    failed,` in the response object.

- [ ] **Step 5: The Inbox page**

In `app/inbox/page.tsx`:

(a) Replace the lucide import's last line `  AlertCircle, HardDrive, Timer,` with `  AlertCircle, HardDrive, Timer, ShieldAlert,`.

(b) Types. Replace `  status:        'done' | 'failed'` with `  status:        'done' | 'failed' | 'held'`, and add after `  error_message: string | null` (inside `DoneEntry`):

```ts
  /** The ingest quality gate's verdict for this job and its first reason, when it recorded one. */
  gate_level?:   string | null
  gate_note?:    string | null
```

Add before `interface InboxStatus {`:

```ts
interface GateReportView {
  level:     'pass' | 'warn' | 'hold'
  phase:     'early' | 'final'
  reasons:   string[]
  lines:     number
  stored:    number
  junkPct:   number
  unsplitPct: number
  garbagePct: number
  kinds:     Record<string, number>
  shapes:    Array<{ shape: string; count: number }>
}

interface HeldEntry extends InboxFileEntry {
  report: GateReportView | null
}

```

and add `  held?:            HeldEntry[]` after `  failed:           InboxFileEntry[]` in `InboxStatus`.

(c) State and handler. After `const [scanning, setScanning]       = useState(false)` add `  const [releasing, setReleasing]     = useState<string | null>(null)`. After the `retryAll` callback add:

```tsx

  const release = useCallback(async (filename: string) => {
    setReleasing(filename)
    try {
      const res = await fetch('/api/inbox/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      })
      if (res.ok) toast({ title: `${filename} released: it is imported once, and the quality gate will not hold it again` })
      else        toast({ title: 'Release failed', variant: 'destructive' })
    } catch {
      toast({ title: 'Release failed', variant: 'destructive' })
    } finally {
      setReleasing(null)
    }
  }, [toast])
```

(d) The Held card. Insert immediately before `      {/* Failed */}`:

```tsx
      {/* Held by the ingest quality gate */}
      {data && (data.held?.length ?? 0) > 0 && (
        <Card data-testid="held-card">
          <CardHeader className="py-3">
            <CardTitle className="text-base text-amber-600 dark:text-amber-400">
              Held by the quality gate ({data.held!.length} files)
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              These files were stopped before one row was stored: too many of their rows look wrongly split. Read the reasons; Release imports a file once anyway.
            </p>
          </CardHeader>
          <CardContent className="pt-0 pb-4">
            <div className="space-y-3">
              {data.held!.map(f => (
                <div key={f.name} className="text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-3 w-3 shrink-0 text-amber-500" />
                    <span className="font-mono truncate flex-1 text-muted-foreground" title={f.name}>{f.name}</span>
                    <span className="text-muted-foreground shrink-0">{fmtBytes(f.size_bytes)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => release(f.name)}
                      disabled={releasing === f.name}
                      className="h-6 px-2 text-xs"
                    >
                      {releasing === f.name ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      <span className="ml-1">Release</span>
                    </Button>
                  </div>
                  {f.report ? (
                    <div className="pl-5 space-y-0.5 text-muted-foreground">
                      {f.report.reasons.map(r => <p key={r}>{r}</p>)}
                      <p className="tabular-nums">
                        {fmtRows(f.report.lines)} lines read, {fmtRows(f.report.stored)} stored; {f.report.junkPct}% break a rule,
                        {' '}{f.report.unsplitPct}% unsplit, {f.report.garbagePct}% garbage
                        {f.report.phase === 'early' ? ' (stopped early, after the first million lines)' : ''}
                      </p>
                      {Object.keys(f.report.kinds).length > 0 && (
                        <p>{Object.entries(f.report.kinds).map(([k, n]) => `${k}: ${fmtRows(n)}`).join(', ')}</p>
                      )}
                      {f.report.shapes.length > 0 && (
                        <details>
                          <summary className="cursor-pointer">Most common shapes of the rows that break a rule</summary>
                          <ul className="font-mono">
                            {f.report.shapes.slice(0, 10).map(s => <li key={s.shape}>{fmtRows(s.count)} × {s.shape}</li>)}
                          </ul>
                        </details>
                      )}
                    </div>
                  ) : (
                    <p className="pl-5 text-muted-foreground">No report was recorded for this file.</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

```

(e) The recent list. Replace

```tsx
                  {job.status === 'done'
                    ? <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />
                    : <XCircle    className="h-3 w-3 shrink-0 text-red-500" />
                  }
```

with

```tsx
                  {job.status === 'done'
                    ? <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />
                    : job.status === 'held'
                      ? <ShieldAlert className="h-3 w-3 shrink-0 text-amber-500" />
                      : <XCircle    className="h-3 w-3 shrink-0 text-red-500" />
                  }
```

and replace

```tsx
                      <span className="tabular-nums shrink-0">{newKnownLabel(job.imported, job.known, fmtRows)}</span>
                      <span className="text-muted-foreground shrink-0 flex items-center gap-0.5">
                        <Timer className="h-2.5 w-2.5" />{fmtDuration(job.duration_ms)}
                      </span>
                    </>
                  ) : (
                    <span className="text-red-500 truncate max-w-xs" title={job.error_message ?? ''}>
                      {job.error_message ?? 'failed'}
                    </span>
                  )}
```

with

```tsx
                      <span className="tabular-nums shrink-0">{newKnownLabel(job.imported, job.known, fmtRows)}</span>
                      {job.gate_level === 'warn' && (
                        <span className="text-amber-600 shrink-0" title={job.gate_note ?? 'The quality gate warned about this file'}>gate: warn</span>
                      )}
                      <span className="text-muted-foreground shrink-0 flex items-center gap-0.5">
                        <Timer className="h-2.5 w-2.5" />{fmtDuration(job.duration_ms)}
                      </span>
                    </>
                  ) : (
                    <span className={`${job.status === 'held' ? 'text-amber-600' : 'text-red-500'} truncate max-w-xs`} title={job.error_message ?? ''}>
                      {job.error_message ?? job.status}
                    </span>
                  )}
```

- [ ] **Step 6: Ingest Health**

In `app/api/monitoring/ingest-health/route.ts` add `import { getHeld } from '@/lib/inbox-helpers'` after the other imports, and replace the final `return NextResponse.json({ ... })` with

```ts
  // Files the ingest quality gate stopped (lib/ingest-quality-gate.ts): they wait in inbox/held/ for an admin to release them.
  const held = { count: getHeld().length }

  return NextResponse.json({
    app: getIngestMetrics(), clickhouse, diskBudget, disk, ingestGate: getIngestDiskGate(), backup: readBackupStatus(), searchDictionary, held,
  })
```

In `components/ingest-health-panel.tsx`: add to `IngestHealth` after the `searchDictionary?` block

```ts
  // Files the ingest quality gate is holding in inbox/held/ (lib/ingest-quality-gate.ts).
  held?: { count: number }
```

change `const { app, clickhouse, diskBudget, disk, ingestGate, backup, searchDictionary } = data` to include `held`, and insert after the `ingestGate?.paused` block:

```tsx
        {held && held.count > 0 && (
          <div className="text-xs border-t pt-3 text-amber-600 font-medium" data-testid="held-files" role="status">
            {held.count} file{held.count === 1 ? "" : "s"} held by the quality gate — review {held.count === 1 ? "it" : "them"} in the Inbox
          </div>
        )}
```

- [ ] **Step 7: The HTTP upload routes**

In `app/api/upload/route.ts`:

(a) After `import { logUploadAction } from '@/lib/audit-log'` add

```ts
import { isIngestHeldError } from '@/lib/ingest-quality-gate'
import { holdSpooledFile } from '@/lib/inbox-helpers'
```

(b) In `runWithProgress` replace the whole `} catch (err) { ... } finally {` block (from `} catch (err) {` to the line before `clearInterval(interval)`) with

```ts
  } catch (err) {
    // A held file is not a failed import: the quality gate stopped it before one row was stored, and the upload is kept in inbox/held/.
    const heldError = isIngestHeldError(err) ? err : null
    const message = err instanceof Error ? err.message : 'Upload failed'
    updateJob(jobId, {
      status: 'error',
      error:  heldError ? `${message} The file was kept; an admin can review it and release it in the Inbox.` : message,
    })
    const j = getJob(jobId)
    if (j) await pushEvent(j)
    logJob({
      source:        'http',
      filename,
      status:        heldError ? 'held' : 'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   Date.now() - startAt,
      error_message: err instanceof Error ? err.message : String(err),
      ...(heldError ? { gate_report: JSON.stringify(heldError.report) } : {}),
    })
    void logUploadAction('upload.fail', actor, jobId, {
      filename, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startAt, ...(heldError ? { held: true } : {}),
    })
  } finally {
```

(c) In the text branch of `POST`, replace

```ts
          try {
            return await runImportJob({
              label: originalFilename,
              work:  ctx => processTextFile(spool.path, originalFilename, jobId, undefined, ctx),
            })
          } finally {
```

with

```ts
          try {
            return await runImportJob({
              label: originalFilename,
              work:  ctx => processTextFile(spool.path, originalFilename, jobId, undefined, ctx),
            })
          } catch (err) {
            // Keep a file the quality gate held (the spool file moves to inbox/held/); everything else is discarded below, as before.
            if (isIngestHeldError(err)) holdSpooledFile(spool.path, originalFilename)
            throw err
          } finally {
```

(d) The outer `catch`. Replace

```ts
  } catch (error) {
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  } finally {
```

(the one followed by `finally`; the spool `catch` near the top of `POST` is a different one) with

```ts
  } catch (error) {
    if (isIngestHeldError(error)) {
      // The quality gate stopped an entry of the archive. The archive is kept in inbox/held/; an admin can review it and release it in the Inbox.
      const kept = holdSpooledFile(spool.path, originalFilename)
      logJob({
        source: 'http', filename: originalFilename, status: 'held', imported: 0, skipped: 0, duration_ms: Date.now() - requestStartedAt,
        error_message: error.message, gate_report: JSON.stringify(error.report),
      })
      return NextResponse.json({ success: false, held: true, kept: kept !== null, error: error.message, report: error.report }, { status: 422 })
    }
    console.error('Upload error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  } finally {
```

and declare `const requestStartedAt = Date.now()` on the line before `let handedOff = false`.

In `app/api/v1/upload/route.ts`: add the same two imports (`isIngestHeldError` from `@/lib/ingest-quality-gate`, `holdSpooledFile` from `@/lib/inbox-helpers`) and replace

```ts
  } catch (error) {
    const known = describeSpoolError(error)
    const cancelled = !known && request.signal.aborted
```

with

```ts
  } catch (error) {
    if (isIngestHeldError(error) && spool) {
      // The quality gate stopped the file before one row was stored. It is kept in inbox/held/; an admin can review it and release it in the Inbox.
      const kept = holdSpooledFile(spool.path, originalFilename)
      logJob({
        source: 'http', filename: originalFilename, status: 'held', imported: 0, skipped: 0, duration_ms: Date.now() - startAt,
        error_message: error.message, gate_report: JSON.stringify(error.report),
      })
      void logUploadAction('upload.api.fail', actor, null, {
        ...keyDetails, filename: originalFilename, error: error.message, duration_ms: Date.now() - startAt, held: true,
      })
      return NextResponse.json({ success: false, held: true, kept: kept !== null, error: error.message, report: error.report }, { status: 422 })
    }
    const known = describeSpoolError(error)
    const cancelled = !known && request.signal.aborted
```

- [ ] **Step 8: Run the tests**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/inbox-release-route.test.ts __tests__/inbox-status-route-novelty.test.ts __tests__/inbox-status.test.ts __tests__/ingest-health-route.test.ts __tests__/ingest-health-panel.test.ts __tests__/ingest-health-disk.test.ts __tests__/upload-route-spool.test.ts __tests__/upload-v1-route-spool.test.ts __tests__/inbox-retry-audit.test.ts 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 9: Type-check, lint, build the page, commit**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit -p . 2>&1 | head -20 && npx eslint --no-eslintrc -c .eslintrc.json app/api/inbox app/api/upload app/api/v1/upload app/api/monitoring/ingest-health app/inbox components/ingest-health-panel.tsx`
Expected: no output.

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add app components __tests__
printf '%s\n' 'feat(gate): Release, the Held list on the Inbox page, the held count, held HTTP uploads' '' 'POST /api/inbox/release stores the one-shot release before it moves the file back. The status route lists inbox/held with the report of the hold and the gate verdict of recent jobs; the Inbox page gets a Held card with reasons, counts, kinds and masked shapes; Ingest Health shows how many files are held. A held text upload ends its job as an error and keeps the file; a held ZIP or v1 upload answers 422 with the report.' '' 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate4.txt
git commit -F /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate4.txt
```

---

### Task 5: DDL v28 and the identity-aware duplicate guard

**Files:**
- Modify: `lib/source-archive.ts` (one exported constant), `lib/clickhouse-migrations.ts`, `docker/clickhouse/init/01-ulp-tables.sql`, `lib/upload-processor.ts`
- Test: `__tests__/sources-identity.test.ts` (create)

**Interfaces:**
- Consumes: Task 2 (`ImportHooks.source`, `SourceIdentity`).
- Produces:
  - `export const SOURCES_IDENTITY_ALTER: string` in `lib/source-archive.ts` (`ALTER TABLE ulp.sources ADD COLUMN IF NOT EXISTS size UInt64 DEFAULT 0, ADD COLUMN IF NOT EXISTS sha256 String DEFAULT '', ADD COLUMN IF NOT EXISTS archive_id String DEFAULT ''`); `sourcesSyncSql` starts with it.
  - `sourceAlreadyImported(filename, hooks)` counts only rows with that name and an empty or equal sha256 when `hooks.source` is set; otherwise by name only.
  - `recordSource(filename, lineCount, hooks)` writes `size`, `sha256`, `archive_id` when `hooks.source` is set.

- [ ] **Step 1: Write the failing test**

Create `__tests__/sources-identity.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ insert: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))

import { recordSource, sourceAlreadyImported } from '@/lib/upload-processor'
import { SOURCES_IDENTITY_ALTER, sourcesSyncSql } from '@/lib/source-archive'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const SOURCE = { sha256: 'ab'.repeat(32), size: 1234, archiveId: 'ab'.repeat(12) }

beforeEach(() => {
  h.insert.mockReset().mockResolvedValue(undefined)
  h.query.mockReset().mockResolvedValue({ json: async () => [{ c: 0 }] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DDL v28: ulp.sources identity columns', () => {
  const migrations = read('lib/clickhouse-migrations.ts')

  it('is version 28, applied once before the version is saved, inside its own try/catch, from the shared statement', () => {
    expect(migrations).toMatch(/const DDL_VERSION = (2[8-9]|[3-9]\d)\b/)
    const start = migrations.indexOf('if (lastDdl < 28)')
    expect(start).toBeGreaterThan(-1)
    const block = migrations.slice(start, migrations.indexOf('if (lastDdl < DDL_VERSION)'))
    expect(block).toContain('SOURCES_IDENTITY_ALTER')
    expect(block).toMatch(/try \{[\s\S]*\} catch \(err\)/)
  })

  it('the fresh-install table has the same three columns, in the same order', () => {
    const sql = read('docker/clickhouse/init/01-ulp-tables.sql')
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS ulp.sources'), sql.indexOf('CREATE TABLE IF NOT EXISTS ulp.domains'))
    expect(table).toMatch(/size\s+UInt64\s+DEFAULT 0/)
    expect(table).toMatch(/sha256\s+String\s+DEFAULT ''/)
    expect(table).toMatch(/archive_id\s+String\s+DEFAULT ''/)
    expect(table.indexOf('imported_at')).toBeLessThan(table.indexOf('size'))
    expect(table.indexOf('size')).toBeLessThan(table.indexOf('sha256'))
    expect(table.indexOf('sha256')).toBeLessThan(table.indexOf('archive_id'))
  })

  it('the archive tool and the migration share one statement', () => {
    expect(SOURCES_IDENTITY_ALTER).toBe(
      "ALTER TABLE ulp.sources ADD COLUMN IF NOT EXISTS size UInt64 DEFAULT 0, ADD COLUMN IF NOT EXISTS sha256 String DEFAULT '', ADD COLUMN IF NOT EXISTS archive_id String DEFAULT ''",
    )
    expect(sourcesSyncSql([]).startsWith(`${SOURCES_IDENTITY_ALTER};`)).toBe(true)
  })
})

describe('the duplicate-file guard with a content hash', () => {
  const sqlOf = (call: number) => h.query.mock.calls[call][0] as { query: string; query_params: Record<string, string> }

  it('asks by name only when the import has no identity (a plain file), exactly as before', async () => {
    await sourceAlreadyImported('a.txt')
    expect(sqlOf(0).query).toBe('SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} LIMIT 1')
    expect(sqlOf(0).query_params).toEqual({ f: 'a.txt' })
  })

  it('counts only rows with that name and an empty or the same hash when the import has an identity', async () => {
    await sourceAlreadyImported('a.txt', { source: SOURCE })
    expect(sqlOf(0).query).toBe("SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} AND (sha256 = '' OR sha256 = {h:String}) LIMIT 1")
    expect(sqlOf(0).query_params).toEqual({ f: 'a.txt', h: SOURCE.sha256 })
  })

  it('says "already imported" when such a row exists and "new file" when only rows with another hash exist', async () => {
    h.query.mockResolvedValue({ json: async () => [{ c: 1 }] })
    expect(await sourceAlreadyImported('a.txt', { source: SOURCE })).toBe(true)
    h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
    expect(await sourceAlreadyImported('a.txt', { source: SOURCE })).toBe(false)
  })
})

describe('recordSource', () => {
  const sourcesInsert = () => h.insert.mock.calls.map(c => c[0]).find(c => c.table === 'ulp.sources')

  it('writes only the name and the line count for a plain file', async () => {
    await recordSource('a.txt', 10)
    expect(sourcesInsert().values).toEqual([{ filename: 'a.txt', line_count: 10 }])
  })

  it('writes the size, the sha256 and the archive id when the import came from the archive', async () => {
    await recordSource('a.txt', 10, { source: SOURCE })
    expect(sourcesInsert().values).toEqual([{ filename: 'a.txt', line_count: 10, size: 1234, sha256: SOURCE.sha256, archive_id: SOURCE.archiveId }])
  })

  it('stays idempotent: a name already recorded with the same content is not recorded again', async () => {
    h.query.mockResolvedValue({ json: async () => [{ c: 1 }] })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await recordSource('a.txt', 10, { source: SOURCE })
    expect(sourcesInsert()).toBeUndefined()
    expect(Readable).toBeDefined()
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/sources-identity.test.ts`
Expected: FAIL (`SOURCES_IDENTITY_ALTER` is not exported, DDL is still 27).

- [ ] **Step 3: One shared statement**

In `lib/source-archive.ts`, replace the body of `sourcesSyncSql`'s first lines

```ts
  const cols =
    `ADD COLUMN IF NOT EXISTS size UInt64 DEFAULT 0, ADD COLUMN IF NOT EXISTS sha256 String DEFAULT '', ADD COLUMN IF NOT EXISTS archive_id String DEFAULT ''`
  const statements = [`ALTER TABLE ulp.sources ${cols};`]
```

with

```ts
  const statements = [`${SOURCES_IDENTITY_ALTER};`]
```

and add above `export function sqlQuote`:

```ts
/** DDL v28 (lib/clickhouse-migrations.ts) and the archive tool run this same statement: ulp.sources learns the identity of the file a row came from. */
export const SOURCES_IDENTITY_ALTER =
  `ALTER TABLE ulp.sources ADD COLUMN IF NOT EXISTS size UInt64 DEFAULT 0, ADD COLUMN IF NOT EXISTS sha256 String DEFAULT '', ADD COLUMN IF NOT EXISTS archive_id String DEFAULT ''`
```

- [ ] **Step 4: The migration and the init SQL**

In `lib/clickhouse-migrations.ts`: add near the other imports `import { SOURCES_IDENTITY_ALTER } from '@/lib/source-archive'`; add to the DDL_VERSION comment block, after the v27 paragraph:

```ts
// v28: ulp.sources gets the identity of the file a row came from: size, sha256, archive_id (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md).
//      ADD COLUMN IF NOT EXISTS on a table of a few hundred rows, metadata only. scripts/archive-sources.ts fills them for the names it archived; the importer
//      writes them for a file it read from the source archive, and the duplicate-file guard compares the sha256 when both sides have one.
```

change `const DDL_VERSION = 27` to `const DDL_VERSION = 28`, and insert before `  if (lastDdl < DDL_VERSION) {` (the tail):

```ts
  // v28 — ulp.sources identity columns (see DDL_VERSION comment above). IF NOT EXISTS makes it idempotent (the archive tool may have added them first); a failure
  // is logged and the importer then keeps working with the name-only guard for plain files (only an import from the archive writes the new columns).
  if (lastDdl < 28) {
    try {
      await client.exec({ query: SOURCES_IDENTITY_ALTER })
      console.warn('[ClickHouse migration] DDL v28 applied (ulp.sources has size, sha256 and archive_id)')
    } catch (err) {
      console.error('[ClickHouse migration] v28: ulp.sources identity columns -- FAILED:', err instanceof Error ? err.message : String(err))
    }
  }

```

In `docker/clickhouse/init/01-ulp-tables.sql` replace the `ulp.sources` definition's columns

```sql
    filename    String   CODEC(ZSTD(1)),
    line_count  UInt64,
    imported_at DateTime DEFAULT now() CODEC(Delta, ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/sources', '{replica}')
```

with

```sql
    filename    String   CODEC(ZSTD(1)),
    line_count  UInt64,
    imported_at DateTime DEFAULT now() CODEC(Delta, ZSTD(1)),
    -- Identity of the file (DDL v28; lib/clickhouse-migrations.ts is the source of truth -- keep in sync). Filled by scripts/archive-sources.ts and by an
    -- import from the source archive; empty for a file imported as plain text.
    size        UInt64   DEFAULT 0,
    sha256      String   DEFAULT '',
    archive_id  String   DEFAULT ''
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/sources', '{replica}')
```

- [ ] **Step 5: The guard and `recordSource`**

In `lib/upload-processor.ts`:

(a) Replace the head of `querySourceAlreadyImported`

```ts
async function querySourceAlreadyImported(filename: string, signal: AbortSignal): Promise<boolean> {
  const res = await getClient().query({
    query:        `SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} LIMIT 1`,
    query_params: { f: filename },
```

with

```ts
async function querySourceAlreadyImported(filename: string, signal: AbortSignal, sha256?: string): Promise<boolean> {
  const res = await getClient().query({
    // With a content hash (an import from the source archive) the same name with other content is a different file; a row without a hash (an older
    // import, or a plain file) still blocks by name. Without a hash -- a plain file, whose content is not known at claim time -- it is the name alone.
    query:        sha256
      ? `SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} AND (sha256 = '' OR sha256 = {h:String}) LIMIT 1`
      : `SELECT count() AS c FROM ulp.sources WHERE filename = {f:String} LIMIT 1`,
    query_params: sha256 ? { f: filename, h: sha256 } : { f: filename },
```

(b) In `sourceAlreadyImported` replace `async signal => querySourceAlreadyImported(filename, signal),` with `async signal => querySourceAlreadyImported(filename, signal, hooks.source?.sha256),`.

(c) In `recordSource` replace `if (await querySourceAlreadyImported(filename, signal)) {` with `if (await querySourceAlreadyImported(filename, signal, hooks.source?.sha256)) {` and replace

```ts
        values: [{ filename, line_count: lineCount }],
```

with

```ts
        values: [{
          filename,
          line_count: lineCount,
          // The identity of the file, when the importer knows it (it read the file from the source archive). A plain file leaves the columns at their defaults;
          // scripts/archive-sources.ts fills them later.
          ...(hooks.source ? { size: hooks.source.size, sha256: hooks.source.sha256, archive_id: hooks.source.archiveId } : {}),
        }],
```

- [ ] **Step 6: Run the tests**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/sources-identity.test.ts __tests__/upload-skip-imported.test.ts __tests__/upload-processor-novelty.test.ts __tests__/source-archive.test.ts __tests__/archive-sources-cli.test.ts __tests__/country-tier-expression.test.ts __tests__/merge-fsync-settings.test.ts __tests__/newest-first-schema.test.ts __tests__/credentials-projections-domain.test.ts __tests__/credentials-projections-email-domain.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check, lint, commit**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit -p . 2>&1 | head -20 && npx eslint --no-eslintrc -c .eslintrc.json lib/clickhouse-migrations.ts lib/source-archive.ts lib/upload-processor.ts`
Expected: no output.

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add lib docker __tests__
printf '%s\n' 'feat(sources): DDL v28 identity columns and a duplicate guard that compares the sha256' '' 'ulp.sources gets size, sha256 and archive_id (one shared ALTER statement for the migration and the archive tool). With a content hash the guard lets the same name with other content through and still blocks the same content; a plain file keeps the name-only guard. An import from the archive records its identity.' '' 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate5.txt
git commit -F /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate5.txt
```

---

### Task 6: The archive reference: import a file straight from the source archive

**Files:**
- Create (replacing the Task 3 stub): `lib/archive-ref.ts`
- Modify: `lib/upload-processor.ts` (replace the `processArchiveRef` stub), `docker-compose.yml`, `docker-compose.rehearsal.yml`, `README.md`, `.env.example`
- Test: `__tests__/archive-ref.test.ts`, `__tests__/upload-processor-archive-ref.test.ts`, `__tests__/archive-compose.test.ts` (create)

**Interfaces:**
- Consumes: `openSource`, `appendManifest`, `archiveFile`, `ManifestEntry` (`lib/source-archive.ts`, Plan 1); `ImportHooks.source/beforeCommit/gateOverride` (Task 2); the sha-aware guard and identity-writing `recordSource` (Task 5).
- Produces:
  - `lib/archive-ref.ts`: `ARCHIVE_REF_EXT = '.archiveref'`, `interface ArchiveRef { v: 1; id: string; name: string; size: number; sha256: string }`, `class ArchiveRefError extends Error`, `appArchiveDir(env?): string` (`ULP_ARCHIVE_DIR`, default `/archive`), `parseArchiveRef(text: string): ArchiveRef`, `readArchiveRefFile(path: string): ArchiveRef`, `serializeArchiveRef(entry: { id; name; size; sha256 }): string`, `hashingStream(src: Readable): { stream: ReadableStream<Uint8Array>; digest: () => string }`
  - `processArchiveRef(refPath: string, onBatch?: (imported: number) => void, hooks?: ImportHooks): Promise<ProcessResult>`: reads the reference, opens the archive, imports the plaintext under the reference's original name, and fails before the commit when the plaintext's sha256 is not the reference's.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/archive-ref.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ARCHIVE_REF_EXT, ArchiveRefError, appArchiveDir, hashingStream, parseArchiveRef, readArchiveRefFile, serializeArchiveRef,
} from '@/lib/archive-ref'

const ID = 'ab12'.repeat(6) // 24 hex characters
const SHA = ID + 'cd34'.repeat(10) // 64 hex characters, starting with the id
const ref = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, id: ID, name: 'some file (1).txt', size: 1234, sha256: SHA, ...over })

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'archive-ref-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('parseArchiveRef', () => {
  it('reads a valid reference', () => {
    expect(parseArchiveRef(ref())).toEqual({ v: 1, id: ID, name: 'some file (1).txt', size: 1234, sha256: SHA })
    expect(ARCHIVE_REF_EXT).toBe('.archiveref')
  })

  it('accepts an empty file (size 0) and ignores fields it does not know', () => {
    expect(parseArchiveRef(ref({ size: 0, extra: 'x' })).size).toBe(0)
  })

  it.each([
    ['not JSON', '{nope', /not valid JSON/],
    ['an array', '[]', /must be a JSON object/],
    ['null', 'null', /must be a JSON object/],
    ['another version', ref({ v: 2 }), /unsupported archive reference version/],
    ['an id that is too short', ref({ id: 'ab12' }), /no valid id/],
    ['an upper-case id', ref({ id: ID.toUpperCase() }), /no valid id/],
    ['a sha256 that is too short', ref({ sha256: SHA.slice(1) }), /no valid sha256/],
    ['a sha256 that does not start with the id', ref({ sha256: 'f'.repeat(64) }), /not the start of its sha256/],
    ['an empty name', ref({ name: '' }), /no valid file name/],
    ['a name with a slash', ref({ name: 'a/b.txt' }), /no valid file name/],
    ['a name with a backslash', ref({ name: 'a\\b.txt' }), /no valid file name/],
    ['a name with a NUL', ref({ name: 'a\0b.txt' }), /no valid file name/],
    ['a name that is too long', ref({ name: 'a'.repeat(256) }), /no valid file name/],
    ['a negative size', ref({ size: -1 }), /no valid size/],
    ['a fractional size', ref({ size: 1.5 }), /no valid size/],
    ['a size that is a string', ref({ size: '12' }), /no valid size/],
  ])('refuses %s', (_label, text, message) => {
    expect(() => parseArchiveRef(text)).toThrow(ArchiveRefError)
    expect(() => parseArchiveRef(text)).toThrow(message)
  })
})

describe('readArchiveRefFile and serializeArchiveRef', () => {
  it('round-trips through a file', () => {
    const p = join(root, 'a.txt.archiveref')
    writeFileSync(p, serializeArchiveRef({ id: ID, name: 'a.txt', size: 5, sha256: SHA }))
    expect(readArchiveRefFile(p)).toEqual({ v: 1, id: ID, name: 'a.txt', size: 5, sha256: SHA })
    expect(serializeArchiveRef({ id: ID, name: 'a.txt', size: 5, sha256: SHA }).endsWith('\n')).toBe(true)
  })

  it('refuses a file that is far too big to be a reference', () => {
    const p = join(root, 'big.archiveref')
    writeFileSync(p, 'x'.repeat(70 * 1024))
    expect(() => readArchiveRefFile(p)).toThrow(/a few hundred bytes/)
  })
})

describe('appArchiveDir', () => {
  it('is /archive in the container unless ULP_ARCHIVE_DIR says otherwise', () => {
    expect(appArchiveDir({} as NodeJS.ProcessEnv)).toBe('/archive')
    expect(appArchiveDir({ ULP_ARCHIVE_DIR: '' } as unknown as NodeJS.ProcessEnv)).toBe('/archive')
    expect(appArchiveDir({ ULP_ARCHIVE_DIR: ' /data/arc ' } as unknown as NodeJS.ProcessEnv)).toBe('/data/arc')
  })
})

describe('hashingStream', () => {
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const parts: Buffer[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(Buffer.from(value))
    }
    return Buffer.concat(parts)
  }

  it('passes the bytes through unchanged and knows their sha256 once the stream has ended', async () => {
    const { stream, digest } = hashingStream(Readable.from([Buffer.from('abc'), Buffer.from('def')]))
    expect((await drain(stream)).toString()).toBe('abcdef')
    expect(digest()).toBe(createHash('sha256').update('abcdef').digest('hex'))
  })

  it('refuses to give a digest before the stream was read to its end', async () => {
    const { stream, digest } = hashingStream(Readable.from([Buffer.from('abc'), Buffer.from('def')]))
    const reader = stream.getReader()
    await reader.read()
    expect(() => digest()).toThrow(ArchiveRefError)
    await reader.cancel()
  })
})
```

Create `__tests__/upload-processor-archive-ref.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
const dm = vi.hoisted(() => ({ getActiveMonitors: vi.fn(), fireMonitorAlertsFromMatches: vi.fn() }))

vi.mock('@/lib/clickhouse', () => ({ getClient: () => ({ insert: h.insert, query: h.query }) }))
vi.mock('@/lib/domain-monitor', () => dm)
vi.mock('@/lib/upload-jobs', () => ({ updateJob: h.updateJob }))
vi.mock('@/lib/ingest-novelty', () => ({ commitStage: h.commitStage }))
vi.mock('@/lib/ingest-stage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ingest-stage')>('@/lib/ingest-stage')
  return { ...actual, createStage: h.createStage, dropStage: h.dropStage, registerStage: h.registerStage, unregisterStage: h.unregisterStage }
})

import { appendManifest, archiveFile } from '@/lib/source-archive'
import { serializeArchiveRef } from '@/lib/archive-ref'
import { processArchiveRef } from '@/lib/upload-processor'

const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
const textOf = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'
const COMMIT = { rows: 300, distinct: 300, known: 0, inserted: 300, inFileDuplicates: 0, slabs: 1, matches: [] }

let root: string
let archiveDir: string

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'archive-ref-import-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  vi.stubEnv('INGEST_NOVELTY_CHECK', 'on')
  vi.stubEnv('INGEST_QUALITY_GATE_MIN_LINES', '100')
  archiveDir = mkdtempSync(join(root, 'arc-'))
  vi.stubEnv('ULP_ARCHIVE_DIR', archiveDir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const fn of Object.values(h)) fn.mockReset()
  h.insert.mockResolvedValue(undefined)
  h.query.mockResolvedValue({ json: async () => [{ c: 0 }] })
  h.createStage.mockResolvedValue(undefined)
  h.dropStage.mockResolvedValue(undefined)
  h.commitStage.mockResolvedValue(COMMIT)
  dm.getActiveMonitors.mockReset().mockResolvedValue([])
  dm.fireMonitorAlertsFromMatches.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Archives a synthetic file (small frames, so the stream crosses several) and writes its reference next to it. */
function archived(name: string, text = textOf(300, cleanLine)) {
  const src = join(root, `src-${name}`)
  writeFileSync(src, text)
  const entry = archiveFile(src, { archiveDir, name, frameBytes: 4096, searchBytes: 512 })
  appendManifest(archiveDir, entry)
  const refPath = join(root, `${name}.archiveref`)
  writeFileSync(refPath, serializeArchiveRef(entry))
  return { entry, refPath }
}
const sourcesInsert = () => h.insert.mock.calls.map(c => c[0]).find(c => c.table === 'ulp.sources')

describe('processArchiveRef', () => {
  it('imports the file from the archive: the parser sees every line, the commit runs, and ulp.sources gets the original name and the identity', async () => {
    const { entry, refPath } = archived('arch-a.txt')
    const out = await processArchiveRef(refPath)
    expect(out).toMatchObject({ imported: 300, filename: 'arch-a.txt', alreadyImported: false })
    expect(h.commitStage.mock.calls[0][0]).toMatchObject({ parsedRows: 300 })
    expect(sourcesInsert().values).toEqual([{ filename: 'arch-a.txt', line_count: 300, size: entry.size, sha256: entry.sha256, archive_id: entry.id }])
  })

  it('asks the duplicate guard about the original name AND the content hash', async () => {
    const { entry, refPath } = archived('arch-b.txt')
    await processArchiveRef(refPath)
    expect(h.query.mock.calls[0][0].query_params).toEqual({ f: 'arch-b.txt', h: entry.sha256 })
  })

  it('skips a file whose name and content are already in ulp.sources, before any stage exists', async () => {
    const { refPath } = archived('arch-c.txt')
    h.query.mockResolvedValue({ json: async () => [{ c: 1 }] })
    const out = await processArchiveRef(refPath)
    expect(out.alreadyImported).toBe(true)
    expect(h.createStage).not.toHaveBeenCalled()
    expect(h.commitStage).not.toHaveBeenCalled()
  })

  it('imports a file with the same name and other content as a new file', async () => {
    archived('dup.txt')
    const second = archived('dup.txt', textOf(300, i => cleanLine(i + 1_000)))
    h.query.mockResolvedValue({ json: async () => [{ c: 0 }] }) // no row of ulp.sources has that name with an empty or equal hash
    await processArchiveRef(second.refPath)
    expect(h.query.mock.calls[0][0].query_params.h).toBe(second.entry.sha256)
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('refuses a reference whose sha256 is not the manifest\'s, before it reads anything', async () => {
    const { entry, refPath } = archived('arch-d.txt')
    writeFileSync(refPath, serializeArchiveRef({ ...entry, sha256: entry.id + 'f'.repeat(40) }))
    await expect(processArchiveRef(refPath)).rejects.toThrow(/does not match the archive manifest/)
    expect(h.createStage).not.toHaveBeenCalled()
  })

  it('refuses a size that is not the manifest\'s', async () => {
    const { entry, refPath } = archived('arch-e.txt')
    writeFileSync(refPath, serializeArchiveRef({ ...entry, size: entry.size + 1 }))
    await expect(processArchiveRef(refPath)).rejects.toThrow(/does not match the archive manifest/)
  })

  it('refuses an id the manifest does not know', async () => {
    mkdirSync(archiveDir, { recursive: true })
    const refPath = join(root, 'unknown.archiveref')
    writeFileSync(refPath, serializeArchiveRef({ id: 'c'.repeat(24), name: 'unknown.txt', size: 5, sha256: 'c'.repeat(64) }))
    await expect(processArchiveRef(refPath)).rejects.toThrow(/not in the archive manifest/)
    expect(h.createStage).not.toHaveBeenCalled()
  })

  it('fails before the commit when the archive was damaged: nothing is committed and the stage is dropped', async () => {
    const { entry, refPath } = archived('arch-f.txt')
    const zst = join(archiveDir, `${entry.id}.zst`)
    const bytes = readFileSync(zst)
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    writeFileSync(zst, bytes)
    await expect(processArchiveRef(refPath)).rejects.toThrow()
    expect(h.commitStage).not.toHaveBeenCalled()
    expect(h.dropStage).toHaveBeenCalledTimes(1)
    expect(sourcesInsert()).toBeUndefined()
  })

  it('holds a bad file that comes from the archive like any other, and imports it once it is released', async () => {
    const { refPath } = archived('arch-g.txt', textOf(300, junkLine))
    await expect(processArchiveRef(refPath)).rejects.toMatchObject({ name: 'IngestHeldError' })
    expect(h.commitStage).not.toHaveBeenCalled()
    const released = await processArchiveRef(refPath, undefined, { gateOverride: true })
    expect(released.gate).toMatchObject({ level: 'hold' })
    expect(h.commitStage).toHaveBeenCalledTimes(1)
  })

  it('runs the caller\'s own beforeCommit after the integrity check', async () => {
    const { refPath } = archived('arch-h.txt')
    const beforeCommit = vi.fn()
    await processArchiveRef(refPath, undefined, { beforeCommit })
    expect(beforeCommit).toHaveBeenCalledTimes(1)
  })

  it('reports progress through onBatch like a plain file', async () => {
    const { refPath } = archived('arch-i.txt')
    h.commitStage.mockImplementation(async (a: { onSlab?: (e: Record<string, number>) => void }) => {
      a.onSlab?.({ known: 0, inserted: 300, slab: 1, slabs: 1 })
      return COMMIT
    })
    const seen: number[] = []
    await processArchiveRef(refPath, n => seen.push(n))
    expect(seen).toEqual([300])
  })
})
```

Create `__tests__/archive-compose.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const GATE_VARS = [
  'INGEST_QUALITY_GATE', 'INGEST_QUALITY_GATE_JUNK_PCT', 'INGEST_QUALITY_GATE_UNSPLIT_PCT', 'INGEST_QUALITY_GATE_GARBAGE_PCT',
  'INGEST_QUALITY_GATE_WARN_JUNK_PCT', 'INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT', 'INGEST_QUALITY_GATE_MIN_LINES', 'INGEST_QUALITY_GATE_EARLY_LINES',
]

describe('quality gate and source archive wiring', () => {
  it('forwards every gate variable through the production compose file, empty by default (the defaults live in code)', () => {
    const compose = read('docker-compose.yml')
    for (const v of GATE_VARS) expect(compose, v).toContain(`${v}: \${${v}:-}`)
  })

  it('mounts the host archive directory read-only at /archive and points the app at it', () => {
    const compose = read('docker-compose.yml')
    expect(compose).toContain('ULP_ARCHIVE_DIR: /archive')
    expect(compose).toContain('- ${ULP_ARCHIVE_HOST_DIR:-${HOME}/ulp-archive}:/archive:ro')
  })

  it('tells the rehearsal app where the archive is; it has no host mount (the scenario copies a scratch archive in)', () => {
    const compose = read('docker-compose.rehearsal.yml')
    expect(compose).toContain('ULP_ARCHIVE_DIR: /archive')
    expect(compose).not.toMatch(/ulp-archive/)
  })

  it('documents the variables in .env.example and the README', () => {
    for (const file of ['.env.example', 'README.md']) {
      const text = read(file)
      for (const v of ['INGEST_QUALITY_GATE', 'INGEST_QUALITY_GATE_EARLY_LINES', 'ULP_ARCHIVE_HOST_DIR']) expect(text, `${file} ${v}`).toContain(v)
    }
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/archive-ref.test.ts __tests__/upload-processor-archive-ref.test.ts __tests__/archive-compose.test.ts 2>&1 | tail -30`
Expected: FAIL (the stub exports nothing but the extension; `processArchiveRef` throws).

- [ ] **Step 3: The reference module**

This file replaces the Task 3 stub of the same name.

Create `lib/archive-ref.ts`:

```ts
/**
 * The archive reference (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md, "The importer reads the archive too").
 *
 * After `archive-sources --replace` there is no original left to hardlink into ./inbox, and restoring 140 GiB of plaintext would need 140 GiB of free space.
 * A tiny file `<name>.archiveref` dropped into ./inbox tells the importer to read that file from the source archive instead: no plaintext touches the disk,
 * and inbox/done keeps only the reference.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'

export const ARCHIVE_REF_EXT = '.archiveref'
const MAX_REF_BYTES = 64 * 1024
const ID_HEX = /^[0-9a-f]{24}$/
const SHA_HEX = /^[0-9a-f]{64}$/

export interface ArchiveRef {
  v: 1
  /** The archive file `<id>.zst`: the first 24 hex characters of the plaintext's sha256. */
  id: string
  /** The original file name: ulp.sources records it, the breach label is taken from it, and the same-name guard compares it. */
  name: string
  size: number
  sha256: string
}

export class ArchiveRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveRefError'
  }
}

/** The archive directory as the app sees it: docker-compose.yml mounts the host's ~/ulp-archive read-only at /archive. */
export function appArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ULP_ARCHIVE_DIR?.trim() || '/archive'
}

export function parseArchiveRef(text: string): ArchiveRef {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ArchiveRefError('the archive reference is not valid JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ArchiveRefError('the archive reference must be a JSON object')
  const r = raw as Record<string, unknown>
  if (r.v !== 1) throw new ArchiveRefError(`unsupported archive reference version: ${String(r.v)}`)
  if (typeof r.id !== 'string' || !ID_HEX.test(r.id)) throw new ArchiveRefError('the archive reference has no valid id (24 hex characters)')
  if (typeof r.sha256 !== 'string' || !SHA_HEX.test(r.sha256)) throw new ArchiveRefError('the archive reference has no valid sha256 (64 hex characters)')
  if (!r.sha256.startsWith(r.id)) throw new ArchiveRefError('the archive reference id is not the start of its sha256')
  if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 255 || /[/\\\0]/.test(r.name)) throw new ArchiveRefError('the archive reference has no valid file name')
  if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) throw new ArchiveRefError('the archive reference has no valid size')
  return { v: 1, id: r.id, name: r.name, size: r.size, sha256: r.sha256 }
}

export function readArchiveRefFile(path: string): ArchiveRef {
  const size = statSync(path).size
  if (size > MAX_REF_BYTES) throw new ArchiveRefError(`an archive reference is a few hundred bytes, this file has ${size}`)
  return parseArchiveRef(readFileSync(path, 'utf8'))
}

export function serializeArchiveRef(entry: { id: string; name: string; size: number; sha256: string }): string {
  return JSON.stringify({ v: 1, id: entry.id, name: entry.name, size: entry.size, sha256: entry.sha256 }) + '\n'
}

/**
 * Wraps the plaintext stream of an archive: every chunk is hashed on its way through. `digest()` is valid once the stream has been read to its end (it throws
 * before that), and gives the sha256 of exactly the bytes the parser saw.
 */
export function hashingStream(src: Readable): { stream: ReadableStream<Uint8Array>; digest: () => string } {
  const hash = createHash('sha256')
  let ended = false
  const web = Readable.toWeb(src) as ReadableStream<Uint8Array>
  const stream = web.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk)
      controller.enqueue(chunk)
    },
    flush() {
      ended = true
    },
  }))
  return {
    stream,
    digest() {
      if (!ended) throw new ArchiveRefError('the archive was not read to its end')
      return hash.digest('hex')
    },
  }
}
```

- [ ] **Step 4: `processArchiveRef`**

In `lib/upload-processor.ts`, add after the imports from `@/lib/ingest-quality-gate`:

```ts
import { openSource } from '@/lib/source-archive'
import { ArchiveRefError, appArchiveDir, hashingStream, readArchiveRefFile } from '@/lib/archive-ref'
```

and replace the Task 3 stub (the comment `// Replaced by Task 6 ...` and the function under it) with

```ts
/**
 * Import a file from the source archive (scripts/archive-sources.ts) instead of from the inbox: `refPath` is an `.archiveref` file (lib/archive-ref.ts). The
 * plaintext is decoded frame by frame, hashed on its way to the parser, and imported under the ORIGINAL name; no plaintext copy is made. If its sha256 is not the
 * reference's, the import fails before the commit (beforeCommit), so a damaged archive cannot put damaged rows into the table.
 */
export async function processArchiveRef(
  refPath: string,
  onBatch?: (imported: number) => void,
  hooks: ImportHooks = {},
): Promise<ProcessResult> {
  const ref = readArchiveRefFile(refPath)
  const source = openSource(ref.id, { archiveDir: appArchiveDir() })
  if (source.origin.kind !== 'archive' || source.size !== ref.size || source.entry?.sha256 !== ref.sha256) {
    throw new ArchiveRefError(`the reference for ${ref.id} does not match the archive manifest (size or sha256 differ)`)
  }
  const nodeStream = source.stream()
  const { stream, digest } = hashingStream(nodeStream)
  try {
    return await processTextStream(stream, ref.name, undefined, onBatch, {
      ...hooks,
      source: { sha256: ref.sha256, size: ref.size, archiveId: ref.id },
      beforeCommit: async () => {
        const got = digest()
        if (got !== ref.sha256) {
          throw new ArchiveRefError(`archive ${ref.id} failed its sha256 check while it was read (got ${got.slice(0, 12)}, expected ${ref.sha256.slice(0, 12)})`)
        }
        await hooks.beforeCommit?.()
      },
    })
  } finally {
    nodeStream.destroy()
  }
}
```

- [ ] **Step 5: Compose, README, `.env.example`**

In `docker-compose.yml` replace

```yaml
      INGEST_NOVELTY_CHECK: ${INGEST_NOVELTY_CHECK:-}
      INGEST_NOVELTY_SLAB_ROWS: ${INGEST_NOVELTY_SLAB_ROWS:-}
```

with

```yaml
      INGEST_NOVELTY_CHECK: ${INGEST_NOVELTY_CHECK:-}
      INGEST_NOVELTY_SLAB_ROWS: ${INGEST_NOVELTY_SLAB_ROWS:-}
      # Ingest quality gate (lib/ingest-quality-gate.ts) -- optional; forwarded explicitly (see above). A file whose rows break too many rules is held in
      # inbox/held/ before one row is stored. INGEST_QUALITY_GATE=warn only reports, =off switches it off. The thresholds are percentages; empty = the
      # defaults in code (hold above 2% rows that break a rule, 5% unsplit lines, 25% garbage; at least 20000 lines; the first check after 1000000 lines).
      INGEST_QUALITY_GATE: ${INGEST_QUALITY_GATE:-}
      INGEST_QUALITY_GATE_JUNK_PCT: ${INGEST_QUALITY_GATE_JUNK_PCT:-}
      INGEST_QUALITY_GATE_UNSPLIT_PCT: ${INGEST_QUALITY_GATE_UNSPLIT_PCT:-}
      INGEST_QUALITY_GATE_GARBAGE_PCT: ${INGEST_QUALITY_GATE_GARBAGE_PCT:-}
      INGEST_QUALITY_GATE_WARN_JUNK_PCT: ${INGEST_QUALITY_GATE_WARN_JUNK_PCT:-}
      INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT: ${INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT:-}
      INGEST_QUALITY_GATE_MIN_LINES: ${INGEST_QUALITY_GATE_MIN_LINES:-}
      INGEST_QUALITY_GATE_EARLY_LINES: ${INGEST_QUALITY_GATE_EARLY_LINES:-}
      # Source archive (lib/archive-ref.ts): an .archiveref file in the inbox is read from this directory, the host's ULP_ARCHIVE_HOST_DIR mounted read-only below.
      ULP_ARCHIVE_DIR: /archive
```

and replace

```yaml
      - ./uploads:/app/uploads
      - ./data:/app/data
      - ./inbox:/app/inbox
```

with

```yaml
      - ./uploads:/app/uploads
      - ./data:/app/data
      - ./inbox:/app/inbox
      # The source archive (scripts/archive-sources.ts), read-only. The host directory must exist BEFORE `docker compose up` (mkdir ~/ulp-archive): if it does
      # not, Docker creates it owned by root and the archive tool cannot write to it.
      - ${ULP_ARCHIVE_HOST_DIR:-${HOME}/ulp-archive}:/archive:ro
```

In `docker-compose.rehearsal.yml` replace `      INGEST_NOVELTY_SLAB_ROWS: ${REHEARSAL_INGEST_NOVELTY_SLAB_ROWS:-}` with

```yaml
      INGEST_NOVELTY_SLAB_ROWS: ${REHEARSAL_INGEST_NOVELTY_SLAB_ROWS:-}
      # lib/archive-ref.ts reads the source archive from here; scripts/e2e-novelty-ingest.ts (scenario archive-ref) copies a scratch archive into the container.
      ULP_ARCHIVE_DIR: /archive
```

In `README.md`, after the line `  this are committed in one step; larger ones in hash slabs, one slab at a time across all imports.` insert

```markdown
- `INGEST_QUALITY_GATE` — the ingest quality gate, on by default (`hold`; `lib/ingest-quality-gate.ts`,
  `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md`). While a file is staged the importer counts
  the rows that break a rule a correctly parsed row never breaks (a login that is a URL, a url that holds a credential, a
  Telegram link in a field, double-encoded text) and the lines it could not split. When at least 20,000 lines were read and
  more than 2% of the stored rows break a rule, more than 5% of the lines were unsplit, or more than 25% are garbage, the
  file is **held** before one row is stored: it moves to `inbox/held/`, the Inbox page lists it with the reasons, and an admin
  can **Release** it (it is then imported once without being held again). `warn` only reports; `off` switches it off.
  Thresholds: `INGEST_QUALITY_GATE_JUNK_PCT` (2), `INGEST_QUALITY_GATE_UNSPLIT_PCT` (5), `INGEST_QUALITY_GATE_GARBAGE_PCT` (25),
  `INGEST_QUALITY_GATE_WARN_JUNK_PCT` (1), `INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT` (2), `INGEST_QUALITY_GATE_MIN_LINES` (20000) and
  `INGEST_QUALITY_GATE_EARLY_LINES` (1000000: a big file is checked once after that many lines, so a bad 4 GB file costs a
  million lines, not the whole file). `npx tsx scripts/preflight.ts <file>...` gives the verdict from a sample before a file is imported.
- `ULP_ARCHIVE_HOST_DIR` — the host directory of the source archive (`scripts/archive-sources.ts`, default `~/ulp-archive`,
  which must exist), mounted read-only at `/archive`. A file named `<name>.archiveref` dropped into `inbox/` (the feeder writes
  them with `SOURCE=archive`) is imported from the archive instead of from the inbox: the plaintext is decoded on the way to the
  parser, its sha256 is checked before the commit, and no plaintext copy is made.
```

In `.env.example`, after the line `# INGEST_NOVELTY_SLAB_ROWS=20000000` insert

```
# ── Ingest quality gate ─────────────────────────────────────────�
# A file whose rows break too many rules a correctly parsed row never breaks (a login that is a URL, a url that holds a credential, a Telegram link in a
# field, double-encoded text) or whose lines mostly cannot be split is HELD before one row is stored: it moves to inbox/held/ and the Inbox page offers a Release.
#   INGEST_QUALITY_GATE=warn      report only, never hold      INGEST_QUALITY_GATE=off   switch it off
#   INGEST_QUALITY_GATE_JUNK_PCT / _UNSPLIT_PCT / _GARBAGE_PCT          hold above these percentages (2 / 5 / 25)
#   INGEST_QUALITY_GATE_WARN_JUNK_PCT / _WARN_UNSPLIT_PCT               warn above these percentages (1 / 2)
#   INGEST_QUALITY_GATE_MIN_LINES (20000)   under this many lines the verdict is at most a warning
#   INGEST_QUALITY_GATE_EARLY_LINES (1000000)   the first check of a big file, after this many lines
# INGEST_QUALITY_GATE=
# INGEST_QUALITY_GATE_JUNK_PCT=2
# INGEST_QUALITY_GATE_UNSPLIT_PCT=5
# INGEST_QUALITY_GATE_GARBAGE_PCT=25
# INGEST_QUALITY_GATE_WARN_JUNK_PCT=1
# INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT=2
# INGEST_QUALITY_GATE_MIN_LINES=20000
# INGEST_QUALITY_GATE_EARLY_LINES=1000000
# ── Source archive ──────────────────────────────────────────────�
# The host directory of the source archive made by scripts/archive-sources.ts, mounted read-only at /archive so that an .archiveref file in the inbox can be
# imported from it. Default ~/ulp-archive. It must exist before `docker compose up` (create it with mkdir): otherwise Docker creates it owned by root.
# ULP_ARCHIVE_HOST_DIR=/home/you/ulp-archive
```

- [ ] **Step 6: Run the tests**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/archive-ref.test.ts __tests__/upload-processor-archive-ref.test.ts __tests__/archive-compose.test.ts __tests__/inbox-watcher-held.test.ts __tests__/novelty-wiring.test.ts __tests__/rehearsal-isolation.test.ts __tests__/compose-hardening.test.ts 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 7: Check what Compose makes of the new mount (read-only; changes nothing)**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && JWT_SECRET=x DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose -f docker-compose.yml config 2>&1 | grep -B1 -A1 "archive"`
Expected: a `source: /home/<user>/ulp-archive`, `target: /archive`, `read_only: true` volume, and `ULP_ARCHIVE_DIR: /archive`. If Compose does not expand the nested default, replace the mount with `- ${ULP_ARCHIVE_HOST_DIR:?set ULP_ARCHIVE_HOST_DIR in .env}:/archive:ro` ONLY after adding the variable to `.env` at deploy time; do not ship a required variable that the running stack lacks.

- [ ] **Step 8: Type-check, lint, commit**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit -p . 2>&1 | head -20 && npx eslint --no-eslintrc -c .eslintrc.json lib/archive-ref.ts lib/upload-processor.ts`
Expected: no output.

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add lib docker-compose.yml docker-compose.rehearsal.yml README.md .env.example __tests__
printf '%s\n' 'feat(archive): the importer reads a file straight from the source archive (.archiveref)' '' 'A <name>.archiveref file in the inbox names a file in the archive. processArchiveRef decodes it frame by frame, hashes it on its way to the parser, imports it under the original name and fails before the commit when the sha256 is not the reference. The app container mounts the host archive read-only at /archive; the gate variables are forwarded.' '' 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate6.txt
git commit -F /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate6.txt
```

---

### Task 7: The offline preflight

**Files:**
- Create: `lib/ingest-preflight.ts`, `scripts/preflight.ts`
- Test: `__tests__/ingest-preflight.test.ts`, `__tests__/preflight-cli.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 (`evaluateGate`, `recordGateBatch`, `newGateCounters`, `maskText`, `parseGateConfig`), `Source` / `openSource` (Plan 1), `parseULPStream`, `parseInlineLine`, `repairUtf8Line`, the ingest policy.
- Produces:
  - `lib/ingest-preflight.ts`: `PREFLIGHT_SLICES = 5`, `PREFLIGHT_SLICE_BYTES = 2 MiB`, `PREFLIGHT_WHOLE_FILE_MAX = 8 MiB`, `preflightHardDrop(env?)`, `sliceRanges(size, slices, sliceBytes, wholeFileMax): Array<[offset, length]>`, `wholeLines(buf, startsFile, endsFile): Buffer`, `interface PreflightResult { name; size; sampledBytes; whole; counters; verdict; unsplitShapes }`, `preflightSource(source: Source, opts: { slices?; sliceBytes?; wholeFileMax?; config: GateConfig; env? }): Promise<PreflightResult>`
  - `scripts/preflight.ts [--slices 5] [--slice-mb 2] [--quiet] [--json] <file | archived name>...`; exit 1 when any file would be held, 2 on a usage or read error, else 0. `--quiet` prints at most one line per file and never the file's name.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/ingest-preflight.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendManifest, archiveFile, openSource } from '@/lib/source-archive'
import { parseGateConfig } from '@/lib/ingest-quality-gate'
import { preflightSource, sliceRanges, wholeLines } from '@/lib/ingest-preflight'

const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
const wordsLine = (i: number) => `just some words number ${i} and nothing else`
const textOf = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'
const CONFIG = { ...parseGateConfig({}), minLines: 100 }

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'preflight-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
const put = (name: string, text: string) => { const p = join(root, name); writeFileSync(p, text); return p }

describe('sliceRanges', () => {
  it('reads a small file whole, and nothing from an empty one', () => {
    expect(sliceRanges(1000, 5, 100, 8000)).toEqual([[0, 1000]])
    expect(sliceRanges(0, 5, 100, 8000)).toEqual([])
  })

  it('spreads slices evenly over a big file, the first at the start and the last ending at the end', () => {
    const r = sliceRanges(100_000, 5, 1000, 8000)
    expect(r).toHaveLength(5)
    expect(r[0]).toEqual([0, 1000])
    expect(r[4]).toEqual([99_000, 1000])
    expect(r.map(([o]) => o)).toEqual([0, 24_750, 49_500, 74_250, 99_000])
  })

  it('uses at least two slices', () => {
    expect(sliceRanges(100_000, 1, 1000, 8000)).toHaveLength(2)
  })
})

describe('wholeLines', () => {
  const buf = Buffer.from('partial\nwhole one\nwhole two\npartial')
  it('drops the partial line at the start and at the end of a slice from the middle of a file', () => {
    expect(wholeLines(buf, false, false).toString()).toBe('whole one\nwhole two\n')
  })

  it('keeps the start of a slice that starts the file and the end of one that ends it', () => {
    expect(wholeLines(buf, true, true).toString()).toBe(buf.toString())
    expect(wholeLines(buf, true, false).toString()).toBe('partial\nwhole one\nwhole two\n')
    expect(wholeLines(buf, false, true).toString()).toBe('whole one\nwhole two\npartial')
  })

  it('returns nothing when there is no newline to cut at', () => {
    expect(wholeLines(Buffer.from('no newline here'), false, false)).toHaveLength(0)
  })
})

describe('preflightSource', () => {
  it('passes a clean file and reads it whole', async () => {
    const r = await preflightSource(openSource(put('clean.txt', textOf(2_000, cleanLine))), { config: CONFIG })
    expect(r.whole).toBe(true)
    expect(r.verdict.level).toBe('pass')
    expect(r.counters).toMatchObject({ lines: 2_000, stored: 2_000, junk: 0 })
    expect(r.unsplitShapes).toEqual([])
  })

  it('holds a file whose rows break the rules, with the kinds and masked shapes, and no text', async () => {
    const r = await preflightSource(openSource(put('junk.txt', textOf(2_000, junkLine))), { config: CONFIG })
    expect(r.verdict.level).toBe('hold')
    expect(r.verdict.report.kinds).toEqual({ 'password-has-scheme': 2_000 })
    expect(JSON.stringify(r.verdict.report)).not.toContain('example.test')
  })

  it('holds a file most of whose lines cannot be split, and lists the masked shape of those lines', async () => {
    const r = await preflightSource(openSource(put('words.txt', textOf(2_000, wordsLine))), { config: CONFIG })
    expect(r.verdict.level).toBe('hold')
    expect(r.verdict.report.unsplitPct).toBeGreaterThan(90)
    expect(r.unsplitShapes[0]).toEqual({ shape: 'w w w w w w w w', count: 2_000 })
    expect(JSON.stringify(r)).not.toContain('nothing')
  })

  it('samples a big file instead of reading it, and still sees the rows', async () => {
    const big = textOf(20_000, cleanLine)
    const r = await preflightSource(openSource(put('big.txt', big)), { config: CONFIG, slices: 3, sliceBytes: 100_000, wholeFileMax: 200_000 })
    expect(r.whole).toBe(false)
    expect(r.sampledBytes).toBeLessThan(big.length)
    expect(r.counters.stored).toBeGreaterThan(1_000)
    expect(r.verdict.level).toBe('pass')
  })

  it('reads an archived name exactly like the file', async () => {
    const dir = mkdtempSync(join(root, 'arc-'))
    const p = put('archived.txt', textOf(2_000, junkLine))
    appendManifest(dir, archiveFile(p, { archiveDir: dir, frameBytes: 4096, searchBytes: 512 }))
    const fromFile = await preflightSource(openSource(p), { config: CONFIG })
    const fromArchive = await preflightSource(openSource('archived.txt', { archiveDir: dir }), { config: CONFIG })
    expect(fromArchive.counters).toEqual(fromFile.counters)
    expect(fromArchive.verdict.level).toBe(fromFile.verdict.level)
  })

  it('applies the production ingest policy: a T3 line is a policy drop, neither a stored row nor an unsplit line', async () => {
    const t3Line = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.com.br:Pw-${i}-Xy!` // a Brazilian address: T3, not on the keep-list
    const r = await preflightSource(openSource(put('t3.txt', textOf(500, t3Line))), { config: CONFIG })
    expect(r.counters).toMatchObject({ lines: 500, stored: 0, tierDropped: 500, noFields: 0, junk: 0 })
    expect(r.verdict.level).toBe('pass')
  })
})
```

Create `__tests__/preflight-cli.test.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO = new URL('../', import.meta.url).pathname
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
const textOf = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'preflight-cli-'))
  writeFileSync(join(root, 'clean.txt'), textOf(3_000, cleanLine))
  writeFileSync(join(root, 'junk.txt'), textOf(3_000, junkLine))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = (args: string[]) =>
  spawnSync(TSX, ['scripts/preflight.ts', ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, INGEST_QUALITY_GATE_MIN_LINES: '100' } })

describe('scripts/preflight.ts', () => {
  it('exits 0 for a clean file and prints a PASS line with the numbers', () => {
    const r = run([join(root, 'clean.txt')])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/PASS/)
  })

  it('exits 1 for a file the gate would hold, and says why', () => {
    const r = run([join(root, 'junk.txt')])
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stdout).toMatch(/HOLD/)
    expect(r.stdout).toMatch(/break a rule/)
  })

  it('exits 1 when any one of several files would be held', () => {
    expect(run([join(root, 'clean.txt'), join(root, 'junk.txt')]).status).toBe(1)
  })

  it('--quiet prints one line without the file name; --json prints one object per file', () => {
    const quiet = run(['--quiet', join(root, 'junk.txt')])
    expect(quiet.status).toBe(1)
    expect(quiet.stdout.trim().split('\n')).toHaveLength(1)
    expect(quiet.stdout).not.toContain('junk.txt')
    const json = run(['--json', join(root, 'clean.txt')])
    expect(JSON.parse(json.stdout.trim().split('\n')[0])).toMatchObject({ level: 'pass', whole: true })
  })

  it('exits 2 without a file, and for a file that is neither readable nor archived', () => {
    expect(run([]).status).toBe(2)
    expect(run([join(root, 'does-not-exist.txt')]).status).toBe(2)
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/ingest-preflight.test.ts __tests__/preflight-cli.test.ts 2>&1 | tail -20`
Expected: FAIL (modules missing).

- [ ] **Step 3: The library**

Create `lib/ingest-preflight.ts`:

```ts
/**
 * The offline preflight of the ingest quality gate (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md, "The offline preflight").
 *
 * Reads a few slices of a source (a file, or an archived name), runs them through the SAME parser and the SAME counters as the importer, and says what the gate
 * would do with the whole file. Nothing is written anywhere. No line of the file is kept: the result holds counts and masked shapes. The two worst parser defects
 * of the pile import were visible in a two-minute sample, which is what this reads.
 */
import { parseInlineLine, parseULPStream } from '@/lib/ulp-parser'
import { DEFAULT_HARD_KEEP_COUNTRIES, makeHardDropPredicate, parseIngestPolicy } from '@/lib/ingest-filter'
import { repairUtf8Line } from '@/lib/ulp-utf8'
import {
  SHAPE_CAP, evaluateGate, maskText, newGateCounters, recordGateBatch, type GateConfig, type GateCounters, type GateVerdict,
} from '@/lib/ingest-quality-gate'
import type { Source } from '@/lib/source-archive'

export const PREFLIGHT_SLICES = 5
export const PREFLIGHT_SLICE_BYTES = 2 * 1024 * 1024
export const PREFLIGHT_WHOLE_FILE_MAX = 8 * 1024 * 1024
const TOP_UNSPLIT_SHAPES = 20

export interface PreflightOptions {
  slices?: number
  sliceBytes?: number
  wholeFileMax?: number
  config: GateConfig
  env?: NodeJS.ProcessEnv
}

export interface PreflightResult {
  name: string
  size: number
  sampledBytes: number
  /** True when the whole file was read (it is at most `wholeFileMax` bytes). */
  whole: boolean
  counters: GateCounters
  verdict: GateVerdict
  /** The most frequent masked shapes of the lines no field split could read (a single-line view; see preflightSource). */
  unsplitShapes: Array<{ shape: string; count: number }>
}

/** The ingest policy as the production app runs it: T3 dropped, with the keep-list of countries. */
export function preflightHardDrop(env: NodeJS.ProcessEnv = process.env): (email: string, url: string) => boolean {
  const policy = parseIngestPolicy({
    INGEST_FILTER_HARD_DROP_TIERS: env.INGEST_FILTER_HARD_DROP_TIERS ?? 'T3',
    INGEST_FILTER_HARD_KEEP_COUNTRIES: env.INGEST_FILTER_HARD_KEEP_COUNTRIES ?? DEFAULT_HARD_KEEP_COUNTRIES,
  } as unknown as NodeJS.ProcessEnv)
  return makeHardDropPredicate(policy)
}

/** The byte ranges to read: the whole file when it is small, else `slices` (at least 2) evenly spaced ones, the first at the start and the last ending at the end. */
export function sliceRanges(size: number, slices: number, sliceBytes: number, wholeFileMax: number): Array<[number, number]> {
  if (size === 0) return []
  if (size <= wholeFileMax) return [[0, size]]
  const n = Math.max(2, slices)
  return Array.from({ length: n }, (_, i) => {
    const offset = Math.floor((i * (size - sliceBytes)) / (n - 1))
    return [offset, Math.min(sliceBytes, size - offset)] as [number, number]
  })
}

/** The part of a slice that holds whole lines: the partial line at the start is dropped (unless the slice starts the file), and so is the one at the end (unless it ends the file). */
export function wholeLines(buf: Buffer, startsFile: boolean, endsFile: boolean): Buffer {
  let from = 0
  let to = buf.length
  if (!startsFile) {
    const nl = buf.indexOf(10)
    if (nl === -1) return Buffer.alloc(0)
    from = nl + 1
  }
  if (!endsFile) {
    const nl = buf.lastIndexOf(10)
    if (nl < from) return Buffer.alloc(0)
    to = nl + 1
  }
  return buf.subarray(from, to)
}

export async function preflightSource(source: Source, opts: PreflightOptions): Promise<PreflightResult> {
  const hard = preflightHardDrop(opts.env)
  const counters = newGateCounters()
  const unsplit = new Map<string, number>()
  const wholeFileMax = opts.wholeFileMax ?? PREFLIGHT_WHOLE_FILE_MAX
  let sampled = 0

  for (const [offset, length] of sliceRanges(source.size, opts.slices ?? PREFLIGHT_SLICES, opts.sliceBytes ?? PREFLIGHT_SLICE_BYTES, wholeFileMax)) {
    const raw = await source.readSlice(offset, length)
    const buf = wholeLines(raw, offset === 0, offset + length >= source.size)
    if (buf.length === 0) continue
    sampled += buf.length

    // The importer's own parser and counters.
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length)
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    for await (const batch of parseULPStream(stream, source.name, 100_000, hard, { dedupInFile: false })) recordGateBatch(counters, batch)

    // parseULPStream hands out counts, not the lines it rejected, and it must not change. So the lines no field split could read are looked at again, one by one,
    // the way the design probe did: this view is exact for single-line records and an upper bound for labelled or positional blocks.
    for (const line of buf.toString('latin1').split('\n')) {
      if (line.trim() === '') continue
      const r = parseInlineLine(repairUtf8Line(line), source.name, hard)
      if (r.credential || r.reason !== 'no_fields') continue
      const shape = maskText(line.trim(), 70)
      const key = unsplit.has(shape) || unsplit.size < SHAPE_CAP ? shape : '(other shapes)'
      unsplit.set(key, (unsplit.get(key) ?? 0) + 1)
    }
  }

  const unsplitShapes = [...unsplit.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, TOP_UNSPLIT_SHAPES)
    .map(([shape, count]) => ({ shape, count }))
  return {
    name: source.name, size: source.size, sampledBytes: sampled, whole: source.size <= wholeFileMax,
    counters, verdict: evaluateGate(counters, opts.config, 'final'), unsplitShapes,
  }
}
```

- [ ] **Step 4: The command**

Create `scripts/preflight.ts`:

```ts
/**
 * Preflight of the ingest quality gate: what would the importer do with these files? (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md)
 *
 *   tsx scripts/preflight.ts [--slices 5] [--slice-mb 2] [--quiet] [--json] <file | archived name>...
 *
 * Reads 5 slices of 2 MiB per file (the whole file when it is at most 8 MiB) through the importer's own parser and counters, and prints one line per file: lines,
 * share stored, share of rows that break a rule, share of unsplit lines, share of garbage, and the verdict (PASS / WARN / HOLD), then the reasons, the kinds and the
 * masked shapes for a file that is not a PASS. It never prints a line of a file. The gate's thresholds come from INGEST_QUALITY_GATE_* like the app's.
 *
 * An archived name is read from the archive (ULP_ARCHIVE_DIR, default ~/ulp-archive). Exit 0 when no file would be held, 1 when one would, 2 on a usage or read error.
 * --quiet prints at most one line per file and never the file's name (the feeder logs the name itself); --json prints one JSON object per file.
 */
import { setPriority } from 'node:os'
import { openSource } from '@/lib/source-archive'
import { parseGateConfig } from '@/lib/ingest-quality-gate'
import { PREFLIGHT_SLICES, PREFLIGHT_SLICE_BYTES, preflightSource } from '@/lib/ingest-preflight'

const argv = process.argv.slice(2)
const has = (name: string) => argv.includes(`--${name}`)
const valueOf = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const valueFlags = new Set(['--slices', '--slice-mb'])
const targets = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1] ?? ''))

if (targets.length === 0) {
  console.error('usage: tsx scripts/preflight.ts [--slices 5] [--slice-mb 2] [--quiet] [--json] <file | archived name>...')
  process.exit(2)
}

try { setPriority(19) } catch { /* best effort: a background job */ }

const slices = Number(valueOf('slices') ?? PREFLIGHT_SLICES)
const sliceBytes = Math.round(Number(valueOf('slice-mb') ?? PREFLIGHT_SLICE_BYTES / 1048576) * 1048576)
if (!Number.isFinite(slices) || slices < 1 || !Number.isFinite(sliceBytes) || sliceBytes < 1024) {
  console.error('--slices must be at least 1 and --slice-mb a positive number')
  process.exit(2)
}

const pct = (x: number) => `${x.toFixed(2)}%`.padStart(7)

async function main(): Promise<number> {
  const config = parseGateConfig()
  let anyHold = false
  let failed = false
  for (const [index, target] of targets.entries()) {
    let result
    try {
      result = await preflightSource(openSource(target), { slices, sliceBytes, config })
    } catch (err) {
      console.error(`cannot read ${has('quiet') ? 'the file' : target}: ${err instanceof Error ? err.message : String(err)}`)
      failed = true
      continue
    }
    const { verdict, counters } = result
    const level = verdict.level.toUpperCase()
    if (verdict.level === 'hold') anyHold = true
    const r = verdict.report

    if (has('json')) {
      console.log(JSON.stringify({ name: result.name, size: result.size, sampledBytes: result.sampledBytes, whole: result.whole, level: verdict.level, reasons: verdict.reasons, report: r, unsplitShapes: result.unsplitShapes }))
      continue
    }
    if (has('quiet')) {
      if (verdict.level !== 'pass') console.log(`${level} ${verdict.reasons.join('; ')}`)
      continue
    }

    const storedPct = counters.lines > 0 ? (counters.stored / counters.lines) * 100 : 0
    console.log(
      `${String(index + 1).padStart(3)}  ${String(counters.lines).padStart(10)} lines  stored${pct(storedPct)}  junk${pct(r.junkPct)}  unsplit${pct(r.unsplitPct)}  garbage${pct(r.garbagePct)}  ${level.padEnd(4)}  ${result.name}${result.whole ? '' : '  (sampled)'}`,
    )
    if (verdict.level !== 'pass') {
      for (const reason of verdict.reasons) console.log(`       ${reason}`)
      const kinds = Object.entries(r.kinds)
      if (kinds.length > 0) console.log(`       kinds: ${kinds.map(([k, n]) => `${k} ${n}`).join(', ')}`)
      for (const s of r.shapes.slice(0, 5)) console.log(`       row shape x${s.count}: ${s.shape}`)
      for (const s of result.unsplitShapes.slice(0, 5)) console.log(`       unsplit line shape x${s.count}: ${s.shape}`)
    }
  }
  return failed ? 2 : anyHold ? 1 : 0
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(2) })
```

- [ ] **Step 5: Run the tests**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/ingest-preflight.test.ts __tests__/preflight-cli.test.ts 2>&1 | tail -20`
Expected: PASS. (`just some words number 12 and nothing else` has eight word runs separated by single spaces, so its mask is eight `w`; the current parser rejects such a line as `no_fields`.)

- [ ] **Step 6: Type-check, lint, commit**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit -p . 2>&1 | head -20 && npx eslint --no-eslintrc -c .eslintrc.json lib/ingest-preflight.ts`
Expected: no output.

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add lib scripts/preflight.ts __tests__
printf '%s\n' 'feat(gate): the offline preflight: what would the importer do with this file?' '' 'Reads a few slices of a file or an archived name through the importer parser and counters and prints the verdict, the reasons, the kinds and the masked shapes of the rows that break a rule and of the lines no field split could read. Exit 1 when a file would be held; --quiet never prints a name.' '' 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate7.txt
git commit -F /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate7.txt
```

---

### Task 8: The feeder, the monitor and the reset know `held`, the preflight and the archive

**Files:**
- Create: `scripts/pile/archive-queue.cjs`
- Modify: `scripts/pile/feed.sh`, `scripts/pile/watch.sh`, `scripts/pile/reset.sh`
- Test: `__tests__/archive-queue.test.ts` (create); `__tests__/pile-scripts-behavior.test.ts`, `__tests__/pile-scripts.test.ts` (modify)

**Interfaces:**
- Consumes: Task 7's `scripts/preflight.ts --quiet` (exit 1 = would be held), the manifest format of Plan 1 (`name`, `id`, `size`, `sha256`), `parseArchiveRef`.
- Produces:
  - `node scripts/pile/archive-queue.cjs list <archiveDir>` prints `size<TAB>name<TAB>sha256` for the latest manifest entry of each name; `write <archiveDir> <name> <dest>` writes the reference file for `<name>` (exit 3 when the name is not archived).
  - `feed.sh`: `SOURCE=archive` (queue and references from the manifest, no originals needed; a name is done when `ulp.sources` has it with an empty or the same sha256), `ULP_ARCHIVE_DIR`, `PREFLIGHT=1` + `PREFLIGHT_CMD` (default `npx tsx scripts/preflight.ts --quiet`; exit 1 skips the file and logs `SKIP`, any other non-zero exit logs `WARN` and feeds anyway), log line `HELD +n (total m): names` once per new file in `inbox/held`, and `COMPLETE all N files processed (held=H, skipped=S)`.
  - All three scripts stop counting the `held` directory as a file in flight.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/archive-queue.test.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseArchiveRef } from '@/lib/archive-ref'

const script = new URL('../scripts/pile/archive-queue.cjs', import.meta.url).pathname
const entry = (name: string, idChar: string, size: number) => {
  const sha256 = idChar.repeat(64)
  return { name, id: sha256.slice(0, 24), size, sha256, lines: 1, frames: [], archive_bytes: 1, archive_sha256: 'e'.repeat(64), level: 12, created_at: '2026-10-12T00:00:00Z' }
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'archive-queue-'))
  const lines = [
    entry('a.txt', 'a', 10),
    entry('b.txt', 'b', 20),
    entry('a.txt', 'c', 30), // a newer entry for the same name wins
    entry('tab\tname.txt', 'd', 40), // a name the feeder's tab-separated queue cannot carry
  ].map(e => JSON.stringify(e))
  writeFileSync(join(dir, 'manifest.jsonl'), lines.join('\n') + '\n\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (...args: string[]) => spawnSync('node', [script, ...args], { encoding: 'utf8' })

describe('archive-queue.cjs', () => {
  it('lists the latest manifest entry of each name as size, name and sha256, and leaves out a name that has a tab in it', () => {
    const r = run('list', dir)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim().split('\n').sort()).toEqual([`20\tb.txt\t${'b'.repeat(64)}`, `30\ta.txt\t${'c'.repeat(64)}`])
  })

  it('writes a reference that the importer accepts', () => {
    const dest = join(dir, 'a.txt.archiveref')
    const r = run('write', dir, 'a.txt', dest)
    expect(r.status, r.stderr).toBe(0)
    expect(parseArchiveRef(readFileSync(dest, 'utf8'))).toEqual({ v: 1, id: 'c'.repeat(24), name: 'a.txt', size: 30, sha256: 'c'.repeat(64) })
  })

  it('exits 3 and writes nothing for a name that is not archived', () => {
    const dest = join(dir, 'nope.txt.archiveref')
    const r = run('write', dir, 'nope.txt', dest)
    expect(r.status).toBe(3)
    expect(existsSync(dest)).toBe(false)
  })

  it('exits 2 on a usage error and 3 when the manifest cannot be read', () => {
    expect(run().status).toBe(2)
    expect(run('list', join(dir, 'missing')).status).toBe(3)
  })
})
```

In `__tests__/pile-scripts.test.ts` append inside the `describe('scripts/pile', ...)` block:

```ts
  test('feed.sh, watch.sh and reset.sh do not count the held directory as a file in flight', () => {
    for (const f of ['feed.sh', 'watch.sh', 'reset.sh']) expect(read(f), f).toContain('(done|failed|processing|held)')
  })
  test('the feeder knows the archive source, the preflight and the held files, and the archive helper is plain CommonJS', () => {
    const s = read('feed.sh')
    for (const word of ['SOURCE', 'PREFLIGHT_CMD', 'archive-queue.cjs', 'HELD +', 'SKIP']) expect(s, word).toContain(word)
    expect(read('archive-queue.cjs')).not.toMatch(/^import |\brequire\('@\//m)
  })
```

and change `test.each(['feed.sh', 'reset.sh', 'watch.sh', 'global-checks.sh'])('%s is valid bash', ...)` is unchanged; in the `nothing is hard-wired` test add `'archive-queue.cjs'` to the list `['feed.sh', 'reset.sh', 'watch.sh', 'global-checks.sh', 'jobs-summary.cjs', 'verify-file.ts']`.

In `__tests__/pile-scripts-behavior.test.ts`:

(a) Extend the fake `docker` in `makeBox`: add `sourcesTsv` to the `Box` interface (`sourcesTsv: string`), create `const sqlLog = join(root, 'sql.log'), sources = join(root, 'sources.txt'), sourcesTsv = join(root, 'sources-tsv.txt')`, write it empty, return it in the box, and add this case to the shim's `case "$sql" in` before the `ALTER` cases:

```
  "SELECT filename, sha256 FROM ulp.sources") cat "${sourcesTsv}" ;;
```

(b) Add a `holdName` parameter to `runFeeder`: `async function runFeeder(b: Box, env: NodeJS.ProcessEnv, failName?: string, holdName?: string)`, create `mkdirSync(join(b.repo, 'inbox', 'held'), { recursive: true })` at the top of `runFeeder`, and in the importer tick replace `renameSync(join(b.repo, 'inbox', name), join(b.repo, 'inbox', name === failName ? 'failed' : 'done', name))` with

```ts
      renameSync(join(b.repo, 'inbox', name), join(b.repo, 'inbox', name === failName ? 'failed' : name === holdName ? 'held' : 'done', name))
```

and make `inboxTop` ignore the new directory: replace `['done', 'failed', 'processing'].includes(n)` with `['done', 'failed', 'processing', 'held'].includes(n)`.

(c) Append inside `describe('scripts/pile/feed.sh in a sandbox', ...)`:

```ts
  test('a file the app holds is logged once as HELD, does not stop the feeding, and the run still completes', async () => {
    box = makeBox({ 'a.txt': sizes(10), 'b.txt': sizes(20), 'c.txt': sizes(30) })
    const { code, out } = await runFeeder(box, box.env, undefined, 'b.txt')
    expect(code, out).toBe(0)
    expect([...out.matchAll(/ HELD \+1 /g)]).toHaveLength(1)
    expect(out).toMatch(/COMPLETE all 3 files processed \(held=1, skipped=0\)/)
    expect(readdirSync(join(box.repo, 'inbox', 'held'))).toEqual(['b.txt'])
    expect(readdirSync(join(box.repo, 'inbox', 'done')).sort()).toEqual(['a.txt', 'c.txt'])
  }, 60_000)

  test('a held directory in the inbox is not a file in flight, and a name already held is not queued again', async () => {
    box = makeBox({ 'a.txt': sizes(10), 'b.txt': sizes(20) })
    mkdirSync(join(box.repo, 'inbox', 'held'), { recursive: true })
    writeFileSync(join(box.repo, 'inbox', 'held', 'b.txt'), 'held earlier')
    const { code, out } = await runFeeder(box, box.env)
    expect(code, out).toBe(0)
    expect(out).toContain('START queue=1 files')
    expect([...out.matchAll(/FEED \d+\/1 [\d.]+ MB (\S+)/g)].map(m => m[1])).toEqual(['a.txt'])
  }, 60_000)

  test('PREFLIGHT=1 skips a file the preflight would hold (exit 1), feeds one it cannot judge (exit 2) with a warning, and still completes', async () => {
    box = makeBox({ 'a.txt': sizes(10), 'b.txt': sizes(20), 'c.txt': sizes(30) })
    const pf = join(box.bin, 'preflight')
    writeFileSync(pf, `#!/bin/bash\ncase "$1" in\n  *b.txt) echo "HOLD 9.00% of the stored rows break a rule (limit 2%)"; exit 1 ;;\n  *c.txt) echo "boom"; exit 2 ;;\n  *) exit 0 ;;\nesac\n`, { mode: 0o755 })
    const { code, out } = await runFeeder(box, { ...box.env, PREFLIGHT: '1', PREFLIGHT_CMD: pf })
    expect(code, out).toBe(0)
    expect(out).toMatch(/SKIP 2\/3 \(preflight would hold it\) b\.txt: HOLD 9\.00%/)
    expect(out).toMatch(/WARN preflight could not judge c\.txt \(exit 2\); feeding it anyway/)
    expect(out).toMatch(/COMPLETE all 3 files processed \(held=0, skipped=1\)/)
    expect(readdirSync(join(box.repo, 'inbox', 'done')).sort()).toEqual(['a.txt', 'c.txt'])
  }, 60_000)

  test('SOURCE=archive writes a reference for each archived name that ulp.sources does not have with the same content, and links nothing', async () => {
    box = makeBox({}) // no originals at all: they were replaced by the archive
    const arc = join(box.root, 'arc')
    mkdirSync(arc)
    const e = (name: string, c: string, size: number) => JSON.stringify({ name, id: c.repeat(24), size, sha256: c.repeat(64), lines: 1, frames: [], archive_bytes: 1, archive_sha256: 'e'.repeat(64), level: 12, created_at: 'x' })
    writeFileSync(join(arc, 'manifest.jsonl'), [e('a.txt', 'a', 10), e('b.txt', 'b', 20), e('c.txt', 'c', 30), e('d.txt', 'd', 40)].join('\n') + '\n')
    // a.txt: same name, same content: done.  b.txt: same name, other content: a new file.  c.txt: an older row without a hash: done by name.
    writeFileSync(box.sourcesTsv, `a.txt\t${'a'.repeat(64)}\nb.txt\t${'f'.repeat(64)}\nc.txt\t\n`)
    const dry = spawnSync('bash', [script('feed.sh')], { env: { ...box.env, SOURCE: 'archive', ULP_ARCHIVE_DIR: arc, DRY_RUN: '1' }, encoding: 'utf8' })
    expect(dry.status, dry.stdout + dry.stderr).toBe(0)
    expect(dry.stdout).toContain('START queue=2 files')
    const { code, out } = await runFeeder(box, { ...box.env, SOURCE: 'archive', ULP_ARCHIVE_DIR: arc })
    expect(code, out).toBe(0)
    expect([...out.matchAll(/FEED \d+\/2 [\d.]+ MB (\S+)/g)].map(m => m[1])).toEqual(['b.txt', 'd.txt'])
    expect(readdirSync(join(box.repo, 'inbox', 'done')).sort()).toEqual(['b.txt.archiveref', 'd.txt.archiveref'])
    const ref = JSON.parse(readFileSync(join(box.repo, 'inbox', 'done', 'b.txt.archiveref'), 'utf8'))
    expect(ref).toEqual({ v: 1, id: 'b'.repeat(24), name: 'b.txt', size: 20, sha256: 'b'.repeat(64) })
  }, 60_000)
```

(`sizes`, `makeBox`, `script`, `runFeeder` and the imports `mkdirSync`, `readdirSync`, `readFileSync`, `writeFileSync`, `spawnSync` are already in that file.)

In the `reset.sh` describe (it defines the `run(b, mode)` helper), append a test: with an empty `inbox/held` directory present, `check` must still count no file in flight and must not abort:

```ts
  test('an inbox/held directory is not a file in flight', () => {
    box = makeBox({})
    mkdirSync(join(box.repo, 'inbox', 'held'), { recursive: true })
    const r = run(box, 'check')
    expect(r.stdout).toContain('top-level=0')
    expect(r.stdout).not.toContain('ABORT: files are in flight')
  })
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/archive-queue.test.ts __tests__/pile-scripts.test.ts __tests__/pile-scripts-behavior.test.ts 2>&1 | tail -30`
Expected: FAIL (no helper script; the held directory blocks the feeder; no SOURCE support).

- [ ] **Step 3: The helper**

Create `scripts/pile/archive-queue.cjs`:

```js
#!/usr/bin/env node
// Helper of scripts/pile/feed.sh for SOURCE=archive. Plain CommonJS, so the feeder needs no TypeScript runner.
//   archive-queue.cjs list  <archiveDir>                 one line per archived name: size <TAB> name <TAB> sha256 (the latest manifest entry of the name)
//   archive-queue.cjs write <archiveDir> <name> <dest>   writes the .archiveref file of <name> at <dest>
// Exit codes: 0 ok, 2 usage, 3 the manifest cannot be read or the name is not archived.
const fs = require('fs')
const path = require('path')

const [cmd, dir, name, dest] = process.argv.slice(2)

function latestByName(archiveDir) {
  let text
  try {
    text = fs.readFileSync(path.join(archiveDir, 'manifest.jsonl'), 'utf8')
  } catch (err) {
    console.error(`cannot read the manifest in ${archiveDir}: ${err.message}`)
    process.exit(3)
  }
  const byName = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry.name === 'string') byName.set(entry.name, entry)
    } catch { /* a damaged line is skipped, like readManifest does */ }
  }
  return byName
}

if (cmd === 'list' && dir) {
  for (const e of latestByName(dir).values()) {
    if (/[\t\n\r]/.test(e.name)) continue // the feeder's queue is tab separated
    process.stdout.write(`${e.size}\t${e.name}\t${e.sha256}\n`)
  }
} else if (cmd === 'write' && dir && name && dest) {
  const e = latestByName(dir).get(name)
  if (!e) {
    console.error(`not archived: ${name}`)
    process.exit(3)
  }
  // One small write: the inbox watcher only claims a file whose size has stopped changing.
  fs.writeFileSync(dest, JSON.stringify({ v: 1, id: e.id, name: e.name, size: e.size, sha256: e.sha256 }) + '\n')
} else {
  console.error('usage: archive-queue.cjs list <archiveDir> | write <archiveDir> <name> <dest>')
  process.exit(2)
}
```

- [ ] **Step 4: `feed.sh`**

Apply these edits to `scripts/pile/feed.sh`.

(a) Header. Replace the comment line `# Log lines: START / FEED / PROGRESS / JOBS / STOP / LOW DISK / DISK OK / PHASE LIMIT / COMPLETE.` with

```bash
#      SOURCE (files): "archive" feeds from the source archive instead (scripts/archive-sources.ts): the queue is the manifest's names and each file is a
#      small .archiveref written into the inbox (the importer reads the plaintext from the archive), so no original has to exist. A name is done when
#      ulp.sources holds it with an empty or the same sha256. ULP_ARCHIVE_DIR (~/ulp-archive) is the archive.
#      PREFLIGHT (0): 1 asks the offline preflight about each file first (PREFLIGHT_CMD, default "npx tsx scripts/preflight.ts --quiet"; exit 1 = the quality gate
#      would hold it): such a file is skipped and logged as SKIP, and any other non-zero exit logs a WARN and feeds the file anyway (the app's own gate decides).
#      A file the app's quality gate holds lands in inbox/held: it is logged once as HELD and is finished work for the feeder (the owner decides; it is not an error).
# Log lines: START / FEED / SKIP / HELD / WARN / PROGRESS / JOBS / STOP / LOW DISK / DISK OK / PHASE LIMIT / COMPLETE.
```

(b) After `MAX_FILES=${MAX_FILES:-100000}` add

```bash
SOURCE=${SOURCE:-files}
ARCHIVE_DIR=${ULP_ARCHIVE_DIR:-"$HOME/ulp-archive"}
PREFLIGHT=${PREFLIGHT:-0}
PREFLIGHT_CMD=${PREFLIGHT_CMD:-"npx tsx scripts/preflight.ts --quiet"}
[ "$SOURCE" = archive ] && export ULP_ARCHIVE_DIR="$ARCHIVE_DIR"   # the preflight resolves an archived name through it
```

(c) The queue. Replace this block

```bash
find "$PILE_DIR" -maxdepth 1 -type f -iname '*.txt' -printf '%f\n' | LC_ALL=C sort > "$WORK/candidates.txt"
ch "SELECT filename FROM ulp.sources" | LC_ALL=C sort > "$WORK/sources.txt"
LC_ALL=C comm -23 "$WORK/candidates.txt" "$WORK/sources.txt" > "$WORK/todo.txt"
: > "$WORK/queue.tsv"
while IFS= read -r f; do
  [ -e "$PILE_DIR/$f" ] || continue
  { [ -e "inbox/$f" ] || [ -e "inbox/done/$f" ] || [ -e "inbox/processing/$f" ] || [ -e "inbox/failed/$f" ]; } && continue
  printf '%s\t%s\n' "$(stat -c %s "$PILE_DIR/$f")" "$f" >> "$WORK/queue.tsv"
done < "$WORK/todo.txt"
sort -n -o "$WORK/queue.tsv" "$WORK/queue.tsv"
```

with

```bash
: > "$WORK/queue.tsv"
if [ "$SOURCE" = archive ]; then
  node "$SCRIPT_DIR/archive-queue.cjs" list "$ARCHIVE_DIR" > "$WORK/archive.tsv" || { echo "$(now) STOP cannot read the archive manifest in $ARCHIVE_DIR"; exit 3; }
  ch "SELECT filename, sha256 FROM ulp.sources" > "$WORK/sources.tsv"
  while IFS=$'\t' read -r size f sha; do
    # done: ulp.sources holds the name with an empty hash (an older import) or with this content
    awk -F'\t' -v f="$f" -v h="$sha" '$1 == f && ($2 == "" || $2 == h) { found = 1 } END { exit !found }' "$WORK/sources.tsv" && continue
    { [ -e "inbox/$f.archiveref" ] || [ -e "inbox/done/$f.archiveref" ] || [ -e "inbox/processing/$f.archiveref" ] || [ -e "inbox/failed/$f.archiveref" ] || [ -e "inbox/held/$f.archiveref" ]; } && continue
    printf '%s\t%s\n' "$size" "$f" >> "$WORK/queue.tsv"
  done < "$WORK/archive.tsv"
else
  find "$PILE_DIR" -maxdepth 1 -type f -iname '*.txt' -printf '%f\n' | LC_ALL=C sort > "$WORK/candidates.txt"
  ch "SELECT filename FROM ulp.sources" | LC_ALL=C sort > "$WORK/sources.txt"
  LC_ALL=C comm -23 "$WORK/candidates.txt" "$WORK/sources.txt" > "$WORK/todo.txt"
  while IFS= read -r f; do
    [ -e "$PILE_DIR/$f" ] || continue
    { [ -e "inbox/$f" ] || [ -e "inbox/done/$f" ] || [ -e "inbox/processing/$f" ] || [ -e "inbox/failed/$f" ] || [ -e "inbox/held/$f" ]; } && continue
    printf '%s\t%s\n' "$(stat -c %s "$PILE_DIR/$f")" "$f" >> "$WORK/queue.tsv"
  done < "$WORK/todo.txt"
fi
sort -n -o "$WORK/queue.tsv" "$WORK/queue.tsv"
```

(d) Counters. Replace `fail0=$(count inbox/failed); done0=$(count inbox/done)` and the next line `fed=0; idx=0; paused_disk=0; last_progress=0; last_jobs=0` with

```bash
fail0=$(count inbox/failed); done0=$(count inbox/done); held0=$(count inbox/held); held_logged=$held0
fed=0; idx=0; paused_disk=0; last_progress=0; last_jobs=0; skipped_pf=0
```

(e) The held log and the in-flight count. Replace

```bash
  top=$(ls -A inbox | grep -v -E '^(done|failed|processing)$' | wc -l); proc=$(count inbox/processing)
```

with

```bash
  # 1b. a file the app's quality gate held is finished work for the feeder: log it once, keep feeding
  nheld=$(count inbox/held)
  if [ "$nheld" -gt "$held_logged" ]; then
    echo "$(now) HELD +$((nheld - held_logged)) (total $((nheld - held0))): $(ls -At inbox/held | head -$((nheld - held_logged)) | tr '\n' ';')"
    held_logged=$nheld
  fi

  top=$(ls -A inbox | grep -v -E '^(done|failed|processing|held)$' | wc -l); proc=$(count inbox/processing)
```

(f) Feeding. Replace

```bash
    if ln "$PILE_DIR/$name" "inbox/$name" 2>/dev/null; then
      fed=$((fed + 1)); inflight=$((inflight + 1))
```

with

```bash
    # PREFLIGHT=1: the offline preflight looks at a sample first. Exit 1 = the quality gate would hold the file: it is not fed (it counts as finished).
    if [ "$PREFLIGHT" = 1 ]; then
      if [ "$SOURCE" = archive ]; then pf_target="$name"; else pf_target="$PILE_DIR/$name"; fi
      pf_out=$($PREFLIGHT_CMD "$pf_target" 2>&1); pf_code=$?
      if [ "$pf_code" = 1 ]; then
        fed=$((fed + 1)); skipped_pf=$((skipped_pf + 1))
        echo "$(now) SKIP $fed/$total (preflight would hold it) $name: $(printf '%s' "$pf_out" | head -1)"
        continue
      elif [ "$pf_code" != 0 ]; then
        echo "$(now) WARN preflight could not judge $name (exit $pf_code); feeding it anyway"
      fi
    fi
    feed_ok=0
    if [ "$SOURCE" = archive ]; then
      node "$SCRIPT_DIR/archive-queue.cjs" write "$ARCHIVE_DIR" "$name" "inbox/$name.archiveref" && feed_ok=1
    else
      ln "$PILE_DIR/$name" "inbox/$name" 2>/dev/null && feed_ok=1
    fi
    if [ "$feed_ok" = 1 ]; then
      fed=$((fed + 1)); inflight=$((inflight + 1))
```

(g) The end line. Replace `else echo "$(now) COMPLETE all $fed files processed"; fi` with `else echo "$(now) COMPLETE all $fed files processed (held=$((nheld - held0)), skipped=$skipped_pf)"; fi`. (The line is long: replace only that substring.)

`feed.sh` must still contain the literal `ln "$PILE_DIR/$name" "inbox/$name"` (step f keeps it) and still not contain `node scripts/pile/`.

- [ ] **Step 5: `watch.sh` and `reset.sh`**

In `scripts/pile/watch.sh` replace `grep --line-buffered -E 'STOP|LOW DISK|DISK OK|PHASE LIMIT|COMPLETE'` with `grep --line-buffered -E 'STOP|LOW DISK|DISK OK|PHASE LIMIT|COMPLETE|HELD|SKIP|WARN'`, replace `'^(done|failed|processing)$'` with `'^(done|failed|processing|held)$'`, and in the first comment line of the file replace `(STOP / LOW DISK / DISK OK / PHASE LIMIT / COMPLETE)` with `(STOP / LOW DISK / DISK OK / PHASE LIMIT / COMPLETE / HELD / SKIP / WARN)`.

In `scripts/pile/reset.sh` replace `'^(done|failed|processing)$'` with `'^(done|failed|processing|held)$'`.

- [ ] **Step 6: Run the tests**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx vitest run __tests__/archive-queue.test.ts __tests__/pile-scripts.test.ts __tests__/pile-scripts-behavior.test.ts 2>&1 | tail -30 && bash -n scripts/pile/feed.sh && bash -n scripts/pile/watch.sh && bash -n scripts/pile/reset.sh`
Expected: PASS and no bash syntax errors.

- [ ] **Step 7: Commit**

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add scripts/pile __tests__
printf '%s\n' 'feat(pile): the feeder knows held files, the preflight and the source archive' '' 'inbox/held is no longer counted as a file in flight (feed.sh, watch.sh, reset.sh would have refused to work once the app created it). HELD is logged once and keeps the run going; PREFLIGHT=1 skips a file the gate would hold; SOURCE=archive writes .archiveref files from the manifest, so a redo needs no originals, and skips a name only when ulp.sources has it with an empty or the same sha256.' '' 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate8.txt
git commit -F /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate8.txt
```

---

### Task 9: End-to-end scenarios, documents, and the gate for the single deploy

**Files:**
- Modify: `scripts/e2e-novelty-ingest.ts`, `docs/pile-import-runbook.md`, `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md`
- Test: the scenarios themselves (they need the rehearsal stack and run only after run 5 is complete)

**Interfaces:**
- Consumes: everything above; the rehearsal stack (`scripts/e2e-alert-rehearsal.ts --keep`), the app image built from this branch.
- Produces: scenarios `quality-gate` and `archive-ref` (keys for `--only=`), a runbook section, a deploy checklist, a corrected spec.

- [ ] **Step 1: The scenarios**

In `scripts/e2e-novelty-ingest.ts`:

(a) Header comment: after the ` *   off         INGEST_NOVELTY_CHECK=off: the direct path, no stage tables, rows stored again as before` line add

```
 *   quality-gate  a file where 1 line in 20 breaks a rule is HELD (production defaults): zero rows stored, it waits in inbox/held with its report, Release imports it
 *                 once, and the audit row exists. (The disk gate's scenario is called "gate".)
 *   archive-ref   a file imported from the source archive through an .archiveref: same counts as the plain import, identity in ulp.sources, a same-name file with other
 *                 content is a new file, a damaged archive fails before one row is committed, and no plaintext copy of the file appears in the inbox
```

and add `readFileSync`, `mkdirSync` and `utimesSync` to the `node:fs` import line (`import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'`).

(b) Add these functions before the `// ── main ──` section:

```ts
// ── quality gate and archive reference ─────────────────────────────────────────
const inboxLs = (sub: string) => sh('docker', ['exec', APP, 'sh', '-c', `ls -1 /app/inbox/${sub} 2>/dev/null || true`]).split('\n').filter(Boolean)

async function qualityGate(): Promise<void> {
  console.log('\n9. The ingest quality gate holds a bad file, and Release imports it')
  scanLog('before the quality-gate scenario')
  if (!check('the rehearsal app restarted with the production defaults', await recreateApp())) return
  const H = `e2e-qg-held-${RUN}.txt`
  const junk = (i: number) => `https://shop${i % 500}.example-store.test/login:user${i}${RUN}@probe-mail.test:Pw://x${i}${RUN}`
  const body = [...lines('Q', 0, 22_800), ...Array.from({ length: 1_200 }, (_, i) => junk(i))]

  const held = await importLines(H, body)
  check('a file where 1 line in 20 breaks a rule ends in error with the hold message', held.status === 'error' && /Held by the quality gate/.test(held.error ?? ''), brief(held))
  check('...not one row of it was stored', rowsFor(H) === 0, `rows ${rowsFor(H)}`)
  check('...it was not remembered as imported', sourceLine(H) === '', `[${sourceLine(H)}]`)
  check('...no stage table is left behind', stageTableCount() === 0, `tables ${stageTableCount()}`)
  check('...the file waits in inbox/held', inboxLs('held').includes(H), inboxLs('held').join(','))

  const status = await api('GET', '/api/inbox/status')
  const entry = (status.json?.held ?? []).find((f: any) => f.name === H)
  check('the Inbox status lists it with the report of the hold', !!entry && entry.report?.level === 'hold' && entry.report?.junkPct >= 4.9 && entry.report?.kinds?.['password-has-scheme'] === 1_200, JSON.stringify(entry?.report ?? null).slice(0, 200))
  const health = await api('GET', '/api/monitoring/ingest-health')
  check('Ingest Health counts it', (health.json?.held?.count ?? 0) >= 1, JSON.stringify(health.json?.held))

  const released = await api('POST', '/api/inbox/release', { filename: H })
  check('Release moves the file back to the inbox', released.status === 200 && released.json?.moved?.[0] === H, JSON.stringify(released.json))
  const done = await waitFor(async () => {
    const s = await api('GET', '/api/inbox/status')
    return (s.json?.done_recent ?? []).find((j: any) => j.filename === H && j.status === 'done')
  }, 240_000, 2000)
  check('the released file is imported: 24000 new rows, none known', !!done && done.imported === 24_000 && done.known === 0, JSON.stringify(done ?? null))
  check('...with the gate verdict recorded as a hold that was released', !!done && done.gate_level === 'hold', JSON.stringify(done?.gate_level))
  check('...all 24000 rows are in ClickHouse', rowsFor(H) === 24_000, `rows ${rowsFor(H)}`)
  check('...and the file left inbox/held', !inboxLs('held').includes(H))

  const audit = await api('GET', '/api/audit-logs?action=inbox.release&limit=5')
  check('the audit log has the release', JSON.stringify(audit.json ?? {}).includes(H), JSON.stringify(audit.json ?? {}).slice(0, 160))

  const again = await importLines(H, body)
  check('the same name again is skipped by the duplicate guard, not held again', again.status === 'done' && again.imported === 0, brief(again))
  scanLog('after the quality-gate scenario')
}

async function archiveRef(): Promise<void> {
  console.log('\n10. An import from the source archive through an .archiveref')
  scanLog('before the archive-ref scenario')
  if (!check('the rehearsal app restarted with the production defaults', await recreateApp())) return
  const PLAIN = `e2e-ar-plain-${RUN}.txt`
  const FROM = `e2e-ar-arch-${RUN}.txt`
  const OTHER = `e2e-ar-other-${RUN}.txt`
  const DAMAGED = `e2e-ar-bad-${RUN}.txt`
  const same = lines('R', 0, 30_000)

  const plain = await importLines(PLAIN, same)
  check('the file as plain text: 30000 new', plain.status === 'done' && plain.imported === 30_000 && plain.known === 0, brief(plain))

  // The real archive tool, on the host, without ClickHouse and without --replace.
  const srcDir = join(work, 'ar-src')
  const archiveDir = join(work, 'ar-archive')
  mkdirSync(srcDir)
  mkdirSync(archiveDir)
  // The archive tool leaves a file modified in the last 10 minutes alone (it may still be downloading): make the fixtures an hour old.
  const hourAgo = new Date(Date.now() - 3_600_000)
  const putOld = (name: string, ls: string[]) => { writeFileSync(join(srcDir, name), text(ls)); utimesSync(join(srcDir, name), hourAgo, hourAgo) }
  putOld(FROM, same)
  putOld(OTHER, lines('S', 0, 30_000))
  putOld(DAMAGED, lines('T', 0, 5_000))
  sh('npx', ['tsx', 'scripts/archive-sources.ts', 'archive', '--src', srcDir, '--out', archiveDir, '--workers', '1', '--no-sources'])
  const manifest = new Map<string, any>(readFileSync(join(archiveDir, 'manifest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).map((e: any) => [e.name, e]))
  check('the archive tool archived the three files', manifest.size === 3, String(manifest.size))

  sh('docker', ['exec', APP, 'rm', '-rf', '/archive'])
  sh('docker', ['cp', archiveDir, `${APP}:/archive`])
  const ref = (e: any) => JSON.stringify({ v: 1, id: e.id, name: e.name, size: e.size, sha256: e.sha256 }) + '\n'
  const drop = (e: any) => sh('docker', ['exec', '-i', APP, 'sh', '-c', `cat > /app/inbox/${e.name}.archiveref`], process.env, ref(e))
  const finished = (name: string) => waitFor(async () => {
    const s = await api('GET', '/api/inbox/status')
    return (s.json?.done_recent ?? []).find((j: any) => j.filename === `${name}.archiveref`)
  }, 240_000, 2000)

  drop(manifest.get(FROM))
  const a = await finished(FROM)
  check('the same content through an .archiveref: every row was already known (the archive yields the same bytes)', !!a && a.status === 'done' && a.imported === 0 && a.known === 30_000, JSON.stringify(a ?? null))
  check('...ulp.sources has the original name with the size, the sha256 and the archive id', chQuery(`SELECT concat(toString(size), '|', sha256, '|', archive_id) FROM ulp.sources WHERE filename = '${FROM}'`) === `${manifest.get(FROM).size}|${manifest.get(FROM).sha256}|${manifest.get(FROM).id}`)
  check('...the inbox holds the reference and no plaintext copy', inboxLs('done').includes(`${FROM}.archiveref`) && !inboxLs('done').includes(FROM) && !inboxLs('').includes(FROM))

  drop(manifest.get(FROM))
  const b = await waitFor(async () => {
    const s = await api('GET', '/api/inbox/status')
    return (s.json?.done_recent ?? []).filter((j: any) => j.filename === `${FROM}.archiveref`).length >= 2
  }, 120_000, 2000)
  check('the same name with the same content again is skipped', !!b)

  drop(manifest.get(OTHER))
  const o = await finished(OTHER)
  check('another file through the archive: 30000 new rows', !!o && o.status === 'done' && o.imported === 30_000 && rowsFor(OTHER) === 30_000, JSON.stringify(o ?? null))

  // A same-name file with other content is a new file: archive different content (another size, so the tool archives it again) under the first name and import it.
  putOld(FROM, lines('U', 0, 10_000))
  sh('npx', ['tsx', 'scripts/archive-sources.ts', 'archive', '--src', srcDir, '--out', archiveDir, '--workers', '1', '--no-sources', '--only', FROM])
  const changed = readFileSync(join(archiveDir, 'manifest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter((e: any) => e.name === FROM).pop()
  sh('docker', ['exec', APP, 'rm', '-rf', '/archive'])
  sh('docker', ['cp', archiveDir, `${APP}:/archive`])
  check('the changed file has another content id', changed.id !== manifest.get(FROM).id)
  const before = Number(chQuery(`SELECT count() FROM ulp.sources WHERE filename = '${FROM}'`))
  drop(changed)
  const c = await waitFor(async () => Number(chQuery(`SELECT count() FROM ulp.sources WHERE filename = '${FROM}'`)) > before, 240_000, 2000)
  check('a same-name file with other content is a new file: imported, a second row in ulp.sources', !!c && rowsFor(FROM) === 10_000, `rows ${rowsFor(FROM)}`)

  // A damaged archive fails before one row is committed.
  const bad = manifest.get(DAMAGED)
  sh('docker', ['exec', APP, 'sh', '-c', `printf '\\377' | dd of=/archive/${bad.id}.zst bs=1 seek=40 conv=notrunc 2>/dev/null`])
  drop(bad)
  const d = await finished(DAMAGED)
  check('a damaged archive fails the job', !!d && d.status === 'failed', JSON.stringify(d ?? null))
  check('...not one row of it was committed, and no stage table is left', rowsFor(DAMAGED) === 0 && stageTableCount() === 0, `rows ${rowsFor(DAMAGED)}, tables ${stageTableCount()}`)
  check('...the reference waits in inbox/failed', inboxLs('failed').includes(`${DAMAGED}.archiveref`))
  scanLog('after the archive-ref scenario')
}
```

(c) Register them in `run()` after the `off` line: `if (want('off')) await directPath()` becomes

```ts
  if (want('off')) await directPath()
  if (want('quality-gate')) await qualityGate()
  if (want('archive-ref')) await archiveRef()
```

(d) In `qualityGate`, the status route's recent-job row must carry `gate_level` (it does, Task 4). If `inboxLs('')` shows the sub-directories `done failed held processing` as well as plaintext names, that is fine: the check looks only for the plaintext file name.

- [ ] **Step 2: Static checks that do not need the stack**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --types node scripts/e2e-novelty-ingest.ts 2>&1 | head -10; npx vitest run __tests__/rehearsal-isolation.test.ts __tests__/novelty-wiring.test.ts 2>&1 | tail -8`
Expected: tsc prints nothing for the new functions (it may print unrelated notes about the `@/` alias; there are none in this script), and the isolation tests pass (the script still refuses to run against anything but the rehearsal stack).

- [ ] **Step 3: The runbook**

In `docs/pile-import-runbook.md`:

(a) In the table of scripts replace the `feed.sh` row with

```markdown
| `feed.sh` | Hardlinks the pile's `.txt` files into `./inbox` smallest-first, two in flight; pauses under `FLOOR_GIB`, stops on a new file in `inbox/failed`. `DRY_RUN=1` prints the queue and stops. Never touches an original. `SOURCE=archive` writes `.archiveref` files from the source archive instead (no original needed). `PREFLIGHT=1` skips a file the offline preflight says the quality gate would hold. A file the app holds (`inbox/held/`) is logged once as `HELD`; the run goes on. |
```

and add a row after `verify-file.ts`:

```markdown
| `scripts/archive-queue.cjs` | The feeder's helper for `SOURCE=archive`: `list <archive dir>` and `write <archive dir> <name> <dest>`. |
```

(b) Add `ULP_ARCHIVE_DIR`, `SOURCE`, `PREFLIGHT`, `PREFLIGHT_CMD` to the environment paragraph: after "`IN_FLIGHT` (2)." add "`SOURCE` (`files`; `archive` feeds from the source archive in `ULP_ARCHIVE_DIR`, default `~/ulp-archive`), `PREFLIGHT` (0), `PREFLIGHT_CMD` (`npx tsx scripts/preflight.ts --quiet`)."

(c) After the section "## The source archive" add

```markdown
## The quality gate

The importer counts, while it stages a file, the rows that break a rule a correctly parsed row never breaks and the lines it could not split (`lib/ingest-quality-gate.ts`;
design in `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md`). A file is **held** before one row is stored when at least 20,000 lines were read and
more than 2% of the stored rows break a rule, more than 5% of the lines were unsplit, or more than 25% are garbage; it is checked once after the first million lines (a bad 4 GB
file costs a million lines, not the file) and once before the commit. A held file moves to `inbox/held/`, the job is logged as `held` with its report, the Inbox page lists it
with the reasons, the counts, the kinds and the masked shapes (no text of the file), and Ingest Health shows how many are held.

- **Read the reasons first.** A hold usually means the parser mis-reads a layout, not that the file is bad. Fix the parser and drop the file in again (move it from `inbox/held/` to `inbox/`; the next claim is gated again), or
- **Release** it on the Inbox page when the file is what you want: it is imported once, the gate reports but does not hold it, and the audit log gets an `inbox.release` row.
- `INGEST_QUALITY_GATE=warn` only reports; `off` switches it off (the Rollback of the gate release). A held file is never deleted by the app; delete it by hand when you do not want it.
- **Before a batch:** `npx tsx scripts/preflight.ts <file or archived name>...` reads a sample (5 slices of 2 MiB; the whole file when it is at most 8 MiB) through the same parser and counters
  and prints PASS / WARN / HOLD per file with the numbers, the kinds, the masked shapes of the rows that break a rule and of the lines no field split could read. Exit 1 when a file would be held.
  `PREFLIGHT=1` makes the feeder do this for every file and skip (log `SKIP`) what would be held. Reading the whole pile takes about two minutes with four low-priority workers.
- A ZIP entry that is held holds the whole archive (the entries before it stay imported; a Release re-imports the ZIP and the recorded entries are skipped by name).

### Importing from the archive

After `archive-sources ... --replace` there is no original to link. `SOURCE=archive scripts/pile/feed.sh` writes one `<name>.archiveref` per archived name into `./inbox` (the file is a few hundred
bytes: id, name, size, sha256); the importer decodes the plaintext from `~/ulp-archive` (mounted read-only into the app at `/archive`), hashes it on the way to the parser and fails the job
before the commit when the sha256 differs. `ulp.sources` records the original name with its size, sha256 and archive id; a file with the same name and another content is a new file, the same
name and content stays blocked. No plaintext copy is made: `inbox/done` keeps only the references.

### Deploy checklist of the gate release (one app deploy, after a pile run is complete and its checks are recorded)

1. Nothing in `inbox/` or `inbox/processing/`; tag the running image first (`docker tag "$(docker inspect ulpsuite_app --format '{{.Image}}')" ulp-suite-app:rollback-<yyyymmdd>-<hhmm>z`).
2. `test -d ~/ulp-archive || mkdir ~/ulp-archive` **as the owner, before `compose up`**: the compose file mounts it, and Docker creates a missing host directory owned by root.
3. Build from the merged commit with `git archive` (as in Switchover step 2), run the rehearsals on the isolated stack: alert, upload-resilience, novelty (`--only=quality-gate,archive-ref` plus the full run), and the disk-filling ones.
4. Recreate only the app with the compose file of the merged commit, anchored to the primary checkout's environment (Switchover step 3). The log must say `DDL v28 applied`; `docker exec ulpsuite_app ls /archive` lists the archive.
5. Verify: `healthy 0`; the Inbox page shows no Held card; `npx tsx scripts/archive-sources.ts status` reports the names without an archive row; `sources-sync` fills the identity columns.
6. Rollback: `INGEST_QUALITY_GATE=off` in `.env` and recreate the app, or the rollback image tag. DDL v28 is additive and stays.
```

(d) In "After the run" step 5 add at its end: "Before importing a new batch run `scripts/preflight.ts` on it (see The quality gate)."

- [ ] **Step 4: The spec**

In `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md` replace the first paragraph after the title (`Status: Part 1 ... is BUILT and merged ...`) with

```markdown
Status: Part 1 (the source archive: library, guards, CLI, readers, runbook) is BUILT and merged (plan `docs/superpowers/plans/2026-10-12-source-archive.md`). The importer's archive reference
(`.archiveref`), the ingest quality gate (Part 2) and the DDL v28 are BUILT on branch `reversible-pipeline` (plan `docs/superpowers/plans/2026-10-12-ingest-quality-gate-and-archive-ref.md`) and
ship in one app deploy after the pile run; the deviations decided while reading the code are listed in that plan (HTTP text uploads cannot answer 422 because the route replies before the import
starts; the importer's report carries the shapes of the junk rows only, the preflight adds the shapes of unsplit lines; a held ZIP entry holds the whole archive; the importer writes the identity
columns when it read from the archive). The repository is public: this file holds numbers only, never file names, search terms or credential values.
```

(Keep the rest of the file. If that first paragraph already reads differently, replace whatever the "Status:" paragraph is.)

- [ ] **Step 5: The whole local gate (no stack needed)**

Run: `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && npx tsc --noEmit -p . 2>&1 | head -20 && npx eslint --no-eslintrc -c .eslintrc.json app lib components scripts/preflight.ts 2>&1 | tail -15 && nice -n 10 npx vitest run 2>&1 | tail -15`
Expected: tsc and eslint print nothing; vitest: every file passed, 0 failed.

- [ ] **Step 6: The gate that needs the stack (only after run 5 is complete and its checks are recorded)**

1. `cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline && git archive HEAD | tar -x -C /tmp/build-gate && DOCKER_CONFIG=/tmp/claude-1000/dockercfg nice -n 19 docker build -t ulp-suite-app:gate-candidate /tmp/build-gate` (never `compose build` from here; the memory notes why).
2. Bring the rehearsal stack up (`REHEARSAL_APP_IMAGE=ulp-suite-app:gate-candidate npx tsx scripts/e2e-alert-rehearsal.ts --keep`), then `npx tsx scripts/e2e-novelty-ingest.ts --only=quality-gate,archive-ref`, then the full `npx tsx scripts/e2e-novelty-ingest.ts`, `npx tsx scripts/e2e-upload-resilience.ts`, and the disk-filling ones, per the runbook.
3. Calibrate against the pile once: `nice -n 19 npx tsx scripts/preflight.ts "$HOME/Downloads/AyuGram Desktop"/*.txt > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/preflight-pile.txt` (read-only, about two minutes of one low-priority core; the output holds file names, keep it out of the repository). The design probe predicted 6 of 281 large files held and 31 warned; a clearly different count means the thresholds or the counters differ from the probe: find out why before the deploy.
4. Only then merge `reversible-pipeline` into `main` and push (standing permission), because the switchover runbook builds from `main`: merging earlier would let the next switchover deploy a gate that has not been rehearsed.

- [ ] **Step 7: Commit the scenarios and the documents**

```bash
cd /home/cole/ulp-suite/.claude/worktrees/reversible-pipeline
git add scripts/e2e-novelty-ingest.ts docs
printf '%s\n' 'test(gate): end-to-end scenarios quality-gate and archive-ref, the runbook and the deploy checklist' '' 'quality-gate: a file with 1 line in 20 breaking a rule is held with zero rows stored, listed with its report, released, imported and audited. archive-ref: an .archiveref imports with the same counts and the identity in ulp.sources, a same-name file with other content is new, a damaged archive fails before one row is committed, and no plaintext copy appears in the inbox. They run on the rehearsal stack after the pile run.' '' 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' > /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate9.txt
git commit -F /tmp/claude-1000/-home-cole-ulp-suite/17952c48-2eaf-4710-9295-a4ed7d7d6e0c/scratchpad/commit-gate9.txt
```

---

## Self-Review

**Spec coverage (Part 2 and "The importer reads the archive too"):**
- Nine kinds, `classifyStoredRow` pure, counters per import, `gate_errors`: Task 1.
- Thresholds, minimum lines, warn tier, environment variables, early + final evaluation, direct path warn-only: Tasks 1 and 2.
- Hold throws, stage dropped, nothing in `ulp.credentials`: Task 2 (tested with the real parser and a mocked ClickHouse). Early hold before the first insert: Task 2.
- `inbox/held/`, `status = 'held'`, `gate_report`, masked shapes (no raw text), Release with `gate_overrides` and the `inbox.release` audit row, the Held section, the Ingest Health count: Tasks 3 and 4. HTTP upload: Task 4 (deviation 1 recorded).
- The offline preflight and the feeder (`HELD`, `PREFLIGHT=1`, `SOURCE=archive`): Tasks 7 and 8. The held directory no longer counts as in flight in three scripts (found while reading them).
- `.archiveref`, `openSource`, the sha256 check before the commit, `inbox/done` keeps only the reference, the sha-aware guard, DDL v28, identity written: Tasks 5 and 6.
- Testing section of the spec: one fixture per kind, thresholds, old defects built as rows, the two e2e scenarios (`quality-gate`, `archive-ref`): Tasks 1, 2, 9.
- Rollout and rollback (`INGEST_QUALITY_GATE=off`, additive DDL): Task 9 checklist.

**Placeholder scan:** the plan has no TBD / TODO. Two instructions depend on reading the current file at execution: Task 8 Step 1 `reset.sh` test says to copy the setup of its sibling test (the sibling is named; the three lines that differ are given), and Task 4's `done_recent` row shape in the e2e (`gate_level`) is the one Task 4 adds.

**Type consistency:** `GateReport` is produced by `evaluateGate` (Task 1), carried by `IngestHeldError.report` and `ProcessResult.gate` (Task 2), stored as JSON by `logJob` (Task 3), parsed by `latestHeldReport` and shown by the Inbox page's `GateReportView` (Task 4, a structural subset). `SourceIdentity` (`sha256`, `size`, `archiveId`) is defined in `lib/import-runner.ts` (Task 2) and used by the guard, `recordSource` (Task 5) and `processArchiveRef` (Task 6). `ARCHIVE_REF_EXT` is exported from `lib/archive-ref.ts` (stub in Task 3, real in Task 6) and used by the watcher. `isSafeFileName` (Task 3) is used by the Release route (Task 4). `maskText` (Task 1) is used by the preflight (Task 7).

**Risks I could not close offline:** the cost of the counters on the real pile (Task 2 Step 6 measures it on synthetic lines; Task 9 Step 6 calibrates the verdicts on the pile); the nested default in the compose mount (Task 6 Step 7 checks what Compose makes of it); the e2e scenarios themselves (they need the stack and run after run 5).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-12-ingest-quality-gate-and-archive-ref.md`. Execution is inline (this session), task by task with the verification commands above; a subagent per task would re-derive context that this session already holds and Tasks 2 to 6 share one file. Tasks 1 to 8 are executed now; Task 9 Steps 1 to 5 are executed now; Task 9 Step 6 waits for run 5.
