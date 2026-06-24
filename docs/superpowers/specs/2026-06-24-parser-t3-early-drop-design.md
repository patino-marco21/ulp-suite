# Parser-time T3 early-drop — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Scope:** Move the hard-tier (T3) ingest drop from the post-batch filter into the
parser, bailing at the earliest point a row can be classified — so T3 rows cost
the bare minimum of parse work and nothing downstream.

---

## 1. Goal

Spend as little time and memory as physically possible on T3 (and any configured
hard-drop tier) credentials during import: classify a row the instant its fields
are split, and if it is a hard-drop tier, **stop immediately** — before
password-decode, the binary/garbage/placeholder regex rules, domain extraction,
credential-object construction, the dedup `Set`, the batch, CSV generation, and
the ClickHouse insert.

## 2. Context and the hard constraint

T3 is *defined* by the email domain (`@mail.ru`, `@qq.com`) or URL TLD (`.ru`,
`.cn`). A row cannot be known to be T3 until it has been split into fields and its
email/host read — so **zero parsing is impossible**; some field-splitting is
unavoidable. The split is the cheap part; everything expensive is downstream of
classification, which is exactly what this change skips.

The existing `lib/ingest-filter.ts` already hard-drops T3 (`INGEST_FILTER_HARD_DROP_TIERS=T3`,
shipped on by default) — but **post-batch**, i.e. after `parseLine` has fully
built each credential. So today every T3 row still pays the full parse-side cost
before being discarded. This change eliminates that waste. The substantive
storage/index/insert savings were already delivered by the 2026-06-20
`hard-drop-t3` project; this is the parse-side complement.

**Accuracy is non-negotiable.** Per filter-pushdown practice, the one cost never
to pay is *false-dropping a row you wanted to keep*. The predicate only ever drops
a **confirmed** hard-tier row; anything untiered or unclassifiable
(`classifyTier → ''`) falls through to normal parsing untouched.

## 3. Scope

**In scope**
- An injected `shouldHardDrop(email, url): boolean` predicate threaded into the
  streaming parser (`parseULPStream` → `parseLine`, plus its block/positional
  emit paths).
- The early bail in `parseLine` after Rule 3, before Rule 3.5.
- A new `'tier_dropped'` rejection reason for observability.
- `makeHardDropPredicate(policy)` in `ingest-filter.ts`.
- Processor wiring in `upload-processor.ts`: build the predicate, split the policy
  into hard (parser) / soft (post-batch), thread the predicate via
  `streamCredentialsToTable`.

**Out of scope**
- Moving the noise / soft-tier / suffix drops into the parser (Approach B). Those
  stay in the post-batch filter; noise is off in the current config anyway.
- A heuristic raw-line pre-scan that skips the field split (rejected: false-drop
  risk for a negligible saving over the cheap split).
- Hardcoding T3 (rejected: loses configurability, two sources of truth).
- Changing tier classification, the `country-tiers` logic, or the existing
  `purge-existing-t3.sh`.

## 4. Approach (A — hard-tier fast-path)

Keep the parser decoupled from the tier/policy logic by **injecting a predicate**.
The parser never imports `country-tiers`/`ingest-filter`; it just calls the
predicate it is handed (or does nothing when handed `undefined`).

## 5. Components

### 5.1 File map

| File | Change |
|---|---|
| `lib/ulp-parser.ts` | Add `'tier_dropped'` to `RejectionReason` + `makeRejectionMap()`; `parseLine` gains optional `shouldHardDrop?`; `parseULPStream` gains the param, threads it to `parseLine`, and checks it at the block (`tryFlushBlock`) and positional emit points before `streamSeenCheck`/`batch.push` |
| `lib/ingest-filter.ts` | Export `makeHardDropPredicate(policy): ((email, url) => boolean) \| undefined` (undefined when `hardTiers` is empty) |
| `lib/upload-processor.ts` | Build the predicate + `softPolicy = { ...policy, hardTiers: ∅ }`; add `StreamToTableOptions.shouldHardDrop`; thread it into `parseULPStream`; post-batch filter uses `softPolicy` |
| Tests | `__tests__/ulp-parser.test.ts` (or focused new file) + processor tests |
| Docs | Short `.env.example` / README note: hard-tier drops now happen at parse time |

### 5.2 The predicate

```ts
// lib/ingest-filter.ts
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

### 5.3 The bail point (`parseLine`)

Inserted after Rule 3 (login present, password present & ≥3 chars, login≠password)
and **before** Rule 3.5 (binary), so the binary loop, garbage-URL regex,
placeholder/sentinel lookups, percent-decode, domain extraction, and the object
literal are all skipped for a hard-tier row:

```ts
// … Rule 3 validation has passed; url/login/password are known …
if (shouldHardDrop?.(login, url)) {
  return { credential: null, reason: 'tier_dropped' }
}
// Rule 3.5 (binary) and everything below — skipped for hard-tier rows
```

`parseLine(line, sourceFile, shouldHardDrop?)`. When `shouldHardDrop` is
`undefined`, the function is byte-identical to today.

### 5.4 Emit-path coverage

`parseULPStream` emits credentials from three shapes. Inline rows go through
`parseLine` (covered above — maximal early bail). Labeled-block rows
(`tryFlushBlock`) and 3-line positional rows build the credential elsewhere, so
for them the predicate is checked at their emit point, before `streamSeenCheck`
and `batch.push`:

```ts
if (shouldHardDrop?.(cred.email, cred.url)) { batchRejected++; batchBreakdown.tier_dropped++; }
else if (streamSeenCheck(fp)) { … dedup … }
else { batch.push(cred) }
```

Block/positional rows thus still skip the dedup `Set`, the batch, and everything
downstream — only their (cheap) object build runs.

### 5.5 Processor wiring (`upload-processor.ts`)

```ts
const policy = parseIngestPolicy()
const shouldHardDrop = makeHardDropPredicate(policy)
const softPolicy = { ...policy, hardTiers: new Set<string>() }
// streamCredentialsToTable opts: { shouldHardDrop,
//   dropPolicy: softPolicy, filterOn: policyActive(softPolicy), … }
```

`streamCredentialsToTable` passes `shouldHardDrop` into `parseULPStream` and keeps
the existing post-batch filter for `softPolicy` only — so a kept row is never
re-classified for hard tiers. With the current config (`HARD_DROP_TIERS=T3`, rest
empty), `softPolicy` is inactive and the post-batch filter is skipped entirely.
The benchmark passes no policy → `shouldHardDrop` is `undefined` → unchanged.

## 6. Data flow

```
line → split into url/login/password
     → Rule 3 (cheap validity)
     → shouldHardDrop(login, url)?  ── yes ─→ reason 'tier_dropped'  (STOP: no decode,
     │                                        no regex rules, no domain, no object,
     │                                        no dedup Set, no batch, no insert)
     └─ no ─→ Rules 3.5–3.7 → domain → credential → dedup Set → batch → insert
```

## 7. Memory and cost

- **Dedup Set:** inline T3 rows return from `parseLine` before reaching
  `streamSeenCheck`, so they never consume a slot in the 2 M-cap per-file dedup
  `Set` — direct relief under the tight-memory constraint.
- **CPU:** `classifyTier` moves from the post-batch filter to right-after-split.
  Kept rows pay it once either way (same total); T3 rows (~15.6% of the audited
  table) now skip the entire expensive tail.

## 8. Observability

`'tier_dropped'` is added to `RejectionReason` and `makeRejectionMap()`. The
parser increments `batchBreakdown.tier_dropped`, which flows through the existing
`rejection_breakdown` into the import result's "Why lines were skipped" panel and
the SSE progress — a live per-import T3-drop count with no new plumbing.
`ProcessResult.tierDropped` remains the post-batch soft/noise counter; the spec
documents the distinction so the two are not conflated.

## 9. Testing (TDD)

| Test | Asserts |
|---|---|
| Bail point | a T3 email carrying binary junk / a placeholder login still returns `reason:'tier_dropped'` — proving the bail precedes Rules 3.5–3.7 |
| Accuracy | untiered (`@gmail.com`) + T1/T2 rows parse normally with the predicate active; a garbage URL on a non-T3 email is not T3-dropped |
| Stream exclusion | mixed stream → T3 excluded from the batch, counted in `tier_dropped`, and absent from the dedup `Set` |
| Emit paths | a labeled-block T3 and a positional-block T3 are both dropped |
| Decoupling | `lib/ulp-parser.ts` imports neither `country-tiers` nor `ingest-filter` |
| Predicate | `makeHardDropPredicate` returns `undefined` for an empty hard-tier set; drops T3 and keeps T1/T2/untiered otherwise |
| Regression | `shouldHardDrop` undefined → byte-identical behavior; full parser + processor suites green |

## 10. Success criteria

- A hard-tier row bails before the expensive tail (proven by the binary/placeholder
  test) and never enters the dedup `Set`, batch, or insert.
- No hard tiers configured → behavior identical to today.
- T3-drop count visible in `rejection_breakdown.tier_dropped`.
- No double-classification of kept rows.
- All existing parser and processor tests pass; typecheck/lint/build clean.

## 11. Open questions / planning notes

- Confirm whether any import path uses `parseBlockStream` (the standalone block
  streamer) in addition to `parseULPStream`; if so, thread the predicate there
  too. The non-streaming `parseULPContent`/`parseBlockContent` are used by tests
  and need the param only for parity (decide in the plan — likely optional param,
  default off).
- `classifyTier` is imported from `@/lib/country-tiers`; confirm it is pure and
  side-effect-free (it is used this way by `ingest-filter.ts`).
- Decide the exact bail insertion line relative to the current Rule numbering when
  writing the plan (after Rule 3 at ~`ulp-parser.ts:647`, before Rule 3.5).
