# Parser-time T3 Early-Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop hard-tier (T3) credentials at the earliest point the parser can classify them — right after the field split, before the expensive rule-checks, object build, dedup set, batch, and insert.

**Architecture:** Inject a pure `shouldHardDrop(email, url)` predicate (built from the existing `INGEST_FILTER_HARD_DROP_TIERS` policy) into `parseULPStream`/`parseLine`; bail in `parseLine` after Rule 3 and at the block/positional emit points. The post-batch ingest-filter keeps only the soft (noise/suffix/soft-tier) policy, so kept rows are never re-classified. Parser stays decoupled — it imports no tier/policy code.

**Tech Stack:** TypeScript, Vitest, the existing `lib/ulp-parser.ts` / `lib/ingest-filter.ts` / `lib/country-tiers.ts` / `lib/upload-processor.ts`.

**Spec:** [docs/superpowers/specs/2026-06-24-parser-t3-early-drop-design.md](../specs/2026-06-24-parser-t3-early-drop-design.md)

**Execution isolation:** Run this plan on a dedicated branch (e.g. `feat/parser-t3-early-drop`). End commit messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer. Do not push unless asked.

**Resolved facts:** `parseBlockStream` is NOT on the import path (defined in `ulp-parser.ts:315`, no call site) — do not touch it. `classifyTier(email, url): Tier` (`lib/country-tiers.ts:308`) is pure. The import UI labels reasons via `REASON_LABELS` in `lib/rejection-report.ts` with a `?? reason` fallback.

**Note on the test runner:** `npm test` also collects the nested `.worktrees/hard-drop-t3/` worktree, which has 2 pre-existing failing zip-fixture tests unrelated to this work — ignore them; run the named test files for each task.

---

### Task 1: Add the `tier_dropped` rejection reason

**Files:**
- Modify: `lib/ulp-parser.ts` (the `RejectionReason` type, `makeRejectionMap`, and the four `Record<RejectionReason, number>` batch-breakdown literals)
- Modify: `lib/rejection-report.ts` (label)
- Test: `__tests__/rejection-report.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/rejection-report.test.ts`:

```ts
import { REASON_LABELS as RL } from '@/lib/rejection-report'
import { makeRejectionMap as mkMap } from '@/lib/ulp-parser'

describe('tier_dropped reason', () => {
  it('is a labeled, zero-initialized rejection reason', () => {
    expect(mkMap().tier_dropped).toBe(0)
    expect(typeof RL.tier_dropped).toBe('string')
    expect(RL.tier_dropped.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- __tests__/rejection-report.test.ts`
Expected: FAIL — `tier_dropped` is missing from the map and labels.

- [ ] **Step 3: Add the reason to the parser**

In `lib/ulp-parser.ts`:

(a) Extend the type (currently `export type RejectionReason = 'blank' | 'no_fields' | 'no_password' | 'dedup' | 'garbage'`):

```ts
export type RejectionReason = 'blank' | 'no_fields' | 'no_password' | 'dedup' | 'garbage' | 'tier_dropped'
```

(b) In `makeRejectionMap`, add the key:

```ts
export function makeRejectionMap(): Record<string, number> {
  return { blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0, tier_dropped: 0 }
}
```

(c) There are **four** inline batch-breakdown literals typed `Record<RejectionReason, number>` — two in `parseBlockStream` and two in `parseULPStream` (the initial `let batchBreakdown = …` and the reset inside each `flushBatch`). Add `tier_dropped: 0` to all four. Each currently reads:

```ts
{ blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 }
```

and must become:

```ts
{ blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0, tier_dropped: 0 }
```

- [ ] **Step 4: Add the label**

In `lib/rejection-report.ts`, add to `REASON_LABELS`:

```ts
  tier_dropped: 'Hard-dropped country tier (e.g. T3) — rejected at parse time before any further work',
```

- [ ] **Step 5: Run tests + typecheck and confirm GREEN**

Run: `npm test -- __tests__/rejection-report.test.ts __tests__/ulp-parser-stream.test.ts`
Expected: PASS (the dual-implementation consistency test still passes — both sides now carry `tier_dropped: 0`).

Run: `npm run typecheck`
Expected: exit 0 — proves all four `Record<RejectionReason, number>` literals were updated (otherwise TS errors on the missing key).

- [ ] **Step 6: Commit**

```bash
git add lib/ulp-parser.ts lib/rejection-report.ts __tests__/rejection-report.test.ts
git commit -m "feat(parser): add tier_dropped rejection reason + label"
```

---

### Task 2: `makeHardDropPredicate` in ingest-filter

**Files:**
- Modify: `lib/ingest-filter.ts`
- Test: `__tests__/hard-drop-predicate.test.ts` (create)

**Interface:** `makeHardDropPredicate(p: IngestDropPolicy): ((email: string, url: string) => boolean) | undefined` — `undefined` when no hard tiers; otherwise drops a row whose `classifyTier` is in `p.hardTiers`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/hard-drop-predicate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeHardDropPredicate, parseIngestPolicy } from '@/lib/ingest-filter'

describe('makeHardDropPredicate', () => {
  it('returns undefined when no hard tiers are configured', () => {
    expect(makeHardDropPredicate(parseIngestPolicy({}))).toBeUndefined()
  })

  it('drops the configured hard tier and keeps the rest', () => {
    const pred = makeHardDropPredicate(parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3' }))!
    expect(typeof pred).toBe('function')
    expect(pred('x@mail.ru', '')).toBe(true)      // mail.ru → T3 → drop
    expect(pred('x@comcast.net', '')).toBe(false) // T1 → keep
    expect(pred('x@web.de', '')).toBe(false)       // T2 → keep
    expect(pred('x@gmail.com', '')).toBe(false)    // untiered → keep
  })
})
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- __tests__/hard-drop-predicate.test.ts`
Expected: FAIL — `makeHardDropPredicate` is not exported.

- [ ] **Step 3: Implement it**

In `lib/ingest-filter.ts`, the `classifyTier` import already exists (`import { classifyTier, … } from '@/lib/country-tiers'`). Add, after `parseIngestPolicy`:

```ts
/**
 * Build a pure predicate that returns true for rows whose tier is a configured
 * HARD drop. Used by the parser to bail on (e.g.) T3 the instant the fields are
 * split — before any downstream work. Returns undefined when no hard tiers are
 * set, so callers can skip the work entirely.
 */
export function makeHardDropPredicate(
  p: IngestDropPolicy,
): ((email: string, url: string) => boolean) | undefined {
  if (p.hardTiers.size === 0) return undefined
  return (email, url) => {
    const tier = classifyTier(email, url)
    return tier !== '' && p.hardTiers.has(tier)
  }
}
```

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `npm test -- __tests__/hard-drop-predicate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ingest-filter.ts __tests__/hard-drop-predicate.test.ts
git commit -m "feat(ingest): makeHardDropPredicate for parser-time hard-tier drop"
```

---

### Task 3: parseLine early-bail + parseULPStream threading

**Files:**
- Modify: `lib/ulp-parser.ts` (`parseLine`, `parseULPStream`)
- Test: `__tests__/ulp-parser.test.ts`

**Interface:**
- `parseLine(line, sourceFile, shouldHardDrop?)` — bails after Rule 3 with `reason:'tier_dropped'`.
- `parseULPStream(stream, filename, batchSize, shouldHardDrop?)` — threads the predicate to `parseLine` and checks it at the block + positional emit points.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/ulp-parser.test.ts`:

```ts
import { readFileSync as _rf } from 'node:fs'

describe('parser-time hard-tier drop', () => {
  const dropT3 = (email: string, _url: string) => email.toLowerCase().endsWith('@mail.ru')

  it('bails on a hard-tier row before the binary/garbage rules (proves ordering)', () => {
    // password carries a control char → without the predicate this is `garbage`
    const line = 'user@mail.ru:pass\x01word'
    expect(parseLine(line, 'f.txt').reason).toBe('garbage')              // no predicate → Rule 3.5
    expect(parseLine(line, 'f.txt', dropT3).reason).toBe('tier_dropped') // predicate → bail first
  })

  it('keeps untiered / non-hard rows when the predicate is active', () => {
    expect(parseLine('user@gmail.com:password123', 'f.txt', dropT3).credential).not.toBeNull()
    expect(parseLine('user@comcast.net:password123', 'f.txt', dropT3).credential).not.toBeNull()
  })

  it('does NOT change behavior when no predicate is passed', () => {
    const r = parseLine('user@mail.ru:password123', 'f.txt')
    expect(r.credential).not.toBeNull()           // T3 kept without a predicate
    expect(r.credential!.email).toBe('user@mail.ru')
  })

  it('the parser imports no tier/policy module (stays decoupled)', () => {
    const src = _rf(new URL('../lib/ulp-parser.ts', import.meta.url), 'utf8')
    expect(src).not.toContain('country-tiers')
    expect(src).not.toContain('ingest-filter')
  })
})

describe('parseULPStream hard-tier drop', () => {
  const dropT3 = (email: string, _url: string) => email.toLowerCase().endsWith('@mail.ru')
  const streamOf = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() },
    })
  const collect = async (text: string, pred?: (e: string, u: string) => boolean) => {
    const creds: string[] = []
    const breakdown: Record<string, number> = {}
    for await (const b of parseULPStream(streamOf(text), 'f.txt', 1000, pred)) {
      for (const c of b.credentials) creds.push(c.email)
      for (const [k, v] of Object.entries(b.breakdown)) breakdown[k] = (breakdown[k] ?? 0) + v
    }
    return { creds, breakdown }
  }

  it('excludes hard-tier inline rows from the batch and counts them', async () => {
    const { creds, breakdown } = await collect(
      'a@comcast.net:password1\nb@mail.ru:password2\n', dropT3)
    expect(creds).toEqual(['a@comcast.net'])
    expect(breakdown.tier_dropped).toBe(1)
  })

  it('drops duplicate hard-tier rows without consuming the dedup set', async () => {
    const { creds, breakdown } = await collect(
      'b@mail.ru:password2\nb@mail.ru:password2\n', dropT3)
    expect(creds).toEqual([])
    expect(breakdown.tier_dropped).toBe(2)   // both bailed before the dedup check
    expect(breakdown.dedup ?? 0).toBe(0)
  })

  it('drops hard-tier positional (3-line) blocks', async () => {
    const { creds, breakdown } = await collect(
      'https://site.ru/login\nuser@mail.ru\npassword123\n', dropT3)
    expect(creds).toEqual([])
    expect(breakdown.tier_dropped).toBe(1)
  })

  it('drops hard-tier labeled blocks', async () => {
    const { creds, breakdown } = await collect(
      'URL: https://x.ru/\nLOGIN: user@mail.ru\nPASSWORD: password123\n=====\n', dropT3)
    expect(creds).toEqual([])
    expect(breakdown.tier_dropped).toBe(1)
  })
})
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm test -- __tests__/ulp-parser.test.ts`
Expected: FAIL — `parseLine`/`parseULPStream` don't accept the predicate yet.

- [ ] **Step 3: Add the predicate param + bail to `parseLine`**

Change the `parseLine` signature from:

```ts
export function parseLine(
  line: string,
  sourceFile: string,
): { credential: ULPCredential | null; reason: RejectionReason | null } {
```

to:

```ts
export function parseLine(
  line: string,
  sourceFile: string,
  shouldHardDrop?: (email: string, url: string) => boolean,
): { credential: ULPCredential | null; reason: RejectionReason | null } {
```

Then, immediately **after** the Rule 3 block (the three `if (!login) … / if (!password …) … / if (login === password) …` returns) and **before** the `// Rule 3.5` binary check, insert:

```ts
  // Rule 3.4: hard-tier early drop. The instant we have a plausible login/url we
  // can classify; if it's a configured hard-drop tier, bail BEFORE the binary /
  // garbage-URL / placeholder rules, domain extraction, and object construction.
  if (shouldHardDrop?.(login, url)) {
    return { credential: null, reason: 'tier_dropped' }
  }
```

- [ ] **Step 4: Thread the predicate through `parseULPStream`**

Change the `parseULPStream` signature from:

```ts
export async function* parseULPStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  batchSize: number,
): AsyncGenerator<StreamBatch> {
```

to:

```ts
export async function* parseULPStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  batchSize: number,
  shouldHardDrop?: (email: string, url: string) => boolean,
): AsyncGenerator<StreamBatch> {
```

(a) Inline path — in `processLine`, change `const { credential, reason } = parseLine(line, filename)` to:

```ts
    const { credential, reason } = parseLine(line, filename, shouldHardDrop)
```

(b) Positional emit — in the `if (positionalUrl && positionalLogin)` block, after the `isJunkCredential` check and before the `const fp = …` dedup line, insert:

```ts
      if (shouldHardDrop?.(positionalLogin, positionalUrl)) {
        batchRejected++; batchBreakdown.tier_dropped++
        positionalUrl = positionalLogin = ''
        return
      }
```

(c) Labeled-block emit — in `tryFlushBlock`, change the `if (cred) { … }` arm from:

```ts
    if (cred) {
      const fp = `${cred.url}\0${cred.email}\0${cred.password}`
      if (streamSeenCheck(fp)) { batchRejected++; batchBreakdown.dedup++ }
      else                     { batch.push(cred) }
    } else if (blockState.url || blockState.login || blockState.password) {
```

to:

```ts
    if (cred) {
      if (shouldHardDrop?.(cred.email, cred.url)) {
        batchRejected++; batchBreakdown.tier_dropped++
      } else {
        const fp = `${cred.url}\0${cred.email}\0${cred.password}`
        if (streamSeenCheck(fp)) { batchRejected++; batchBreakdown.dedup++ }
        else                     { batch.push(cred) }
      }
    } else if (blockState.url || blockState.login || blockState.password) {
```

- [ ] **Step 5: Run the tests and confirm GREEN**

Run: `npm test -- __tests__/ulp-parser.test.ts __tests__/ulp-parser-stream.test.ts __tests__/ulp-parser-extended.test.ts`
Expected: PASS — including the existing parser suites (no-predicate behavior is byte-identical).

Run: `npm run typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/ulp-parser.ts __tests__/ulp-parser.test.ts
git commit -m "feat(parser): early-bail hard-tier rows in parseLine + stream emit paths"
```

---

### Task 4: Processor wiring

**Files:**
- Modify: `lib/upload-processor.ts` (`StreamToTableOptions`, `streamCredentialsToTable`, `processTextStream`)
- Test: `__tests__/upload-processor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/upload-processor.test.ts` (this file already mocks `@/lib/clickhouse`, `@/lib/domain-monitor`, `@/lib/upload-jobs`):

```ts
describe('parser-time hard-tier drop wiring', () => {
  it('passes a hard-drop predicate to parseULPStream and drops T3 in the parser', async () => {
    vi.resetModules()
    process.env.INGEST_FILTER_HARD_DROP_TIERS = 'T3'

    let received: ((e: string, u: string) => boolean) | undefined
    vi.doMock('@/lib/ulp-parser', async () => {
      const actual = await vi.importActual<typeof import('@/lib/ulp-parser')>('@/lib/ulp-parser')
      return {
        ...actual,
        parseULPStream: async function* (_s: any, _f: any, _b: any, pred?: any) {
          received = pred
          yield { credentials: [], rejected: 1, breakdown: { ...actual.makeRejectionMap(), tier_dropped: 1 } }
        },
      }
    })

    try {
      const { processTextStream } = await import('@/lib/upload-processor')
      const { Readable } = await import('node:stream')
      const res = await processTextStream(
        Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>, 'tier.txt')
      expect(typeof received).toBe('function')
      expect(received!('x@mail.ru', '')).toBe(true)       // T3 dropped
      expect(received!('x@gmail.com', '')).toBe(false)     // untiered kept
      expect(res.rejection_breakdown.tier_dropped).toBe(1) // surfaced in the result
    } finally {
      delete process.env.INGEST_FILTER_HARD_DROP_TIERS
      vi.doUnmock('@/lib/ulp-parser')
      vi.resetModules()
    }
  })
})
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- __tests__/upload-processor.test.ts`
Expected: FAIL — `received` is `undefined` (no predicate threaded yet).

- [ ] **Step 3: Add the option and thread it**

In `lib/upload-processor.ts`:

(a) Add `makeHardDropPredicate` to the ingest-filter import:

```ts
import { parseIngestPolicy, policyActive, shouldDropAtIngest, makeHardDropPredicate } from '@/lib/ingest-filter'
```

(b) In `StreamToTableOptions`, add the field (next to `dropPolicy`):

```ts
  /** Hard-tier early-drop predicate, applied inside the parser. */
  shouldHardDrop?: (email: string, url: string) => boolean
```

(c) In `streamCredentialsToTable`, change the parser call from `parseULPStream(stream, filename, batchSize)` to:

```ts
  const gen = parseULPStream(stream, filename, batchSize, options.shouldHardDrop)
```

(d) In `processTextStream`, replace the policy/`dropPolicy` setup:

```ts
  // Ingest tier filter — hard tiers drop in the parser (earliest); the rest
  // (noise/soft-tier/suffix) stays in the post-batch filter so kept rows are
  // never re-classified.
  const policy         = parseIngestPolicy()
  const shouldHardDrop = makeHardDropPredicate(policy)
  const softPolicy     = { ...policy, hardTiers: new Set<string>() }
  const filterOn       = policyActive(softPolicy)
```

and add `shouldHardDrop` + use `softPolicy` in the `streamCredentialsToTable` options:

```ts
      filterOn,
      dropPolicy: softPolicy,
      breachName: breach_name,
      shouldHardDrop,
```

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `npm test -- __tests__/upload-processor.test.ts __tests__/insert-batch-dedup.test.ts __tests__/import-pipeline.test.ts`
Expected: PASS — including the existing processor + pipelining suites.

Run: `npm run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/upload-processor.ts __tests__/upload-processor.test.ts
git commit -m "feat(import): wire hard-tier predicate into the parser, soft policy post-batch"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `.env.example`, `README.md`

- [ ] **Step 1: Document the parse-time behavior**

In `.env.example`, append to the `INGEST_FILTER_HARD_DROP_TIERS` comment block a line noting the timing:

```dotenv
#   (Hard-drop tiers are rejected inside the parser, before any further work —
#    no object build, dedup, batch, or insert cost. Soft/noise/suffix drops still
#    run post-parse.)
```

In `README.md`, in the import section, add one line:

```markdown
Hard-tier drops (`INGEST_FILTER_HARD_DROP_TIERS`, e.g. `T3`) are rejected at parse
time — the row is dropped the instant it's classified, and shows up as
`tier_dropped` in an import's "why lines were skipped" breakdown.
```

- [ ] **Step 2: Commit docs**

```bash
git add .env.example README.md
git commit -m "docs: note hard-tier drops happen at parse time"
```

- [ ] **Step 3: Full verification**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```
Expected: all green except the 2 pre-existing `.worktrees/hard-drop-t3/` zip-fixture failures. Confirm the new `tier_dropped` reason, the predicate, the parser bail, and the processor wiring are all covered and passing.

- [ ] **Step 4: Review the diff**

```bash
git diff --stat main...HEAD
git diff --check main...HEAD
```
Expected: only `lib/ulp-parser.ts`, `lib/ingest-filter.ts`, `lib/upload-processor.ts`, `lib/rejection-report.ts`, the four test files, `.env.example`, `README.md`, and the spec/plan docs changed; no whitespace errors.

---

## Self-review notes (author)

- **Spec coverage:** predicate (Task 2), bail point after Rule 3 (Task 3), emit-path coverage (Task 3), `tier_dropped` + label/observability (Task 1), processor split with no double-classification (Task 4), decoupling test (Task 3), regression via existing suites (Tasks 3-5), docs (Task 5). All spec §3 in-scope items map to a task; out-of-scope items (noise/suffix relocation, raw pre-scan, hardcoding, `parseBlockStream`) are absent.
- **Type consistency:** `shouldHardDrop?: (email: string, url: string) => boolean` is identical across `parseLine`, `parseULPStream`, `StreamToTableOptions`, and `makeHardDropPredicate`'s return type. `tier_dropped` is the single spelling everywhere.
- **Ordering proof:** the binary-junk-in-a-T3-row test (Task 3, Step 1) is the load-bearing assertion that the bail precedes Rule 3.5 — `garbage` without the predicate, `tier_dropped` with it.
