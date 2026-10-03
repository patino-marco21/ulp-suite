# Domain Search Dictionary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A search for one domain-shaped term on the Credentials page returns exactly today's rows, order, cursors and totals, in about 2-4 s instead of 15-19 s, by resolving the substring branches against two small derived dictionary tables so the primary key can prune again.

**Architecture:** Two plain-MergeTree dictionaries (`ulp.search_host_dict` pairs of `(domain, url_host)`, `ulp.search_emaildomain_dict`) are built by a shadow-table + `EXCHANGE TABLES` swap and fingerprinted (table uuid, per-partition rows and block range, non-projection mutations) in their table COMMENT, so a stale dictionary fails closed to today's query. A lookup resolves the term to candidate domains D and email domains E, cached per `(fingerprint, term)`. The route then ANDs redundant pruning conjuncts onto the unchanged legacy WHERE: branch 1 `domain IN D`, branch 2 `domain NOT IN D` plus a `(_part, _part_offset)` set from `proj_email_domain_rev`, merged by the same ORDER BY; totals merge aggregate states. Any problem falls back to the legacy query.

**Tech Stack:** TypeScript (Next.js 15 route handlers, `instrumentation.ts` crons), ClickHouse 26.3 over `@clickhouse/client`, Vitest, tsx scripts, Docker Compose rehearsal stack.

**Spec:** `docs/superpowers/specs/2026-10-03-domain-search-dictionary-design.md` (amended 2026-10-03 with five measured corrections; this plan follows the amended text).

## Global Constraints

Every task's requirements implicitly include these (values copied from the spec, including its 2026-10-03 amendments).

- **One A-Z list, exactly as today**: the dictionary plan returns the identical rows, order, cursors and totals as the legacy query. The legacy `where` and `cursorClause` stay in every query verbatim; the plan only ANDs extra, redundant conjuncts, so an over-inclusive candidate set costs time and can never return a wrong row.
- **Eligibility**: `q` is exactly one positive, non-regex, domain-shaped term (`/^[\w-]+(\.[\w-]+)+$/` as `parseULPQuery` decides), feature flag on (`SEARCH_DICTIONARY` not `0`/`false`/`off`/`no`), and the request has no `dictionary=0`. Anything else (single word, `@email`, several terms, negation, regex) is untouched.
- **Caps**: `SEARCH_DICT_MAX_DOMAINS` default **3,000** candidate domains, `SEARCH_DICT_MAX_EMAIL_DOMAINS` default **300**; the inlined list of D at most **90,000 bytes**, the list of E at most **20,000 bytes**, the finished SQL at most **240,000 characters** (`max_query_size` is 262,144 and D appears twice in a query). Above any cap: legacy query.
- **Fallbacks**: dictionary missing / building / stale / unknown, `proj_email_domain_rev` not on every part, lookup slower than **8 s** (`max_execution_time = 8`) or failing, or a non-timeout ClickHouse error in the plan: the legacy query, one `console.warn` with the reason. A query timeout inside the plan: the same **408** the legacy path returns. D and E both empty: an empty page and zero totals without touching the table.
- **Dictionary tables**: plain `MergeTree` (no Keeper path). `ulp.search_host_dict (domain String, url_host String) ORDER BY (domain, url_host)` and `ulp.search_emaildomain_dict (email_domain String) ORDER BY email_domain`. Built into `<name>__new`, then `EXCHANGE TABLES` and drop of the old one (the first build uses `RENAME TABLE`; the `ulp` database is Atomic). No n-gram index, no codec.
- **Build settings**: `max_threads = 8`, `max_memory_usage = 6000000000`, `max_bytes_before_external_group_by = 3000000000`, `async_insert = 0`, `log_comment = 'search_dict_build'`.
- **Freshness (fail closed)**: `fingerprint = sha1(table uuid | per partition rows:min block:max block | every non-projection, non-index mutation id and command)`, read BEFORE the build and stored in the COMMENT of BOTH tables (JSON `{"v":1,"fp":...,"builtAt":...,"rows":...}`); fresh only when both comments equal the live fingerprint; cached **3 s** (amended from the spec's 15 s: a cached `fresh` is the one answer that must not outlive a data change, or a search right after an import could miss a row with a new domain). Mutation commands are wrapped in parentheses in `system.mutations`, so the exclusion is `^\(?(CLEAR|MATERIALIZE|DROP|ADD) (PROJECTION|INDEX)`.
- **Lookup**: the same LIKE parameters the legacy predicate builds (`dom0`, `domsuf0`, `domlk0` from `buildULPWhere`); cached per `(fingerprint, term)` for 10 minutes, at most 200 terms, sharing the in-flight promise so the page's rows request and totals request resolve once; a failed lookup is cached 60 s.
- **Candidate lists are SQL literals, not parameters** (ClickHouse refuses a URL parameter above 128 KiB). Strings are escaped by `chStringLiteral`; E is reversed as UTF-8 BYTES (`reverse()` is bytewise), never as a reversed JavaScript string.
- **Totals**: merge aggregate states (`uniqIfState`/`uniqIfMerge`, `uniqState`/`uniqMerge`; counts `sum`), never add two `uniq` estimates (measured: 1,234,344 summed against 1,234,432 for the single scan; the merge gave 1,234,432).
- **Two ClickHouse 26.3 facts pinned in code comments and tests**: `query_plan_optimize_lazy_materialization = 0` on the offset branch (otherwise "Not found column _part_offset in block" for sorts not led by `domain`), and the offset sub-select keeps projections ON (`optimize_use_projections = 1, preferred_optimize_projection_name = 'proj_email_domain_rev'`; turning them off took 9-16 s instead of 0.3-1 s).
- **Cron**: `SEARCH_DICT_CRON_MINUTES` default **10** (`0` disables); rebuild only when stale or missing, the fingerprint unchanged across a settle wait (`SEARCH_DICT_SETTLE_SECONDS` default **120**), no content mutation running, no build running, disk headroom for about **3 GiB** above the disk guard's floor; **3 failures in a row wait an hour**. Production only (`instrumentation.ts`).
- **Observability**: the response's `plan` says `'dictionary'` when the plan answered the rows (the `totals_only` response gains `plan` too); `/api/monitoring/ingest-health` gains `searchDictionary` and the panel one line.
- **Rollback**: `SEARCH_DICTIONARY=0` (no rebuild needed) or the rollback image tag. `/api/credentials?dictionary=0` forces the legacy query for one request (parity tests, scripts); there is no UI for it.
- **The repository is PUBLIC**: no owner search term, log excerpt or credential value in any code, test, spec or commit. Tests and docs use brand examples only (`ledger.com`, `trezor.io`, `kraken.com`) and reserved `.test` names; the live test takes terms from `SDP_TERMS`.
- **No change** to the API contract (additive `plan` only), the UI, the stored data, or `ulp.credentials`.
- **Query-count regexes in older tests**: `__tests__/credentials-route-totals.test.ts` counts data queries with `/\) AS t\s/` and totals queries with `/AS raw_total/`. Status, fingerprint and lookup SQL must contain neither.

## File Structure

| File | Responsibility |
|---|---|
| `lib/clickhouse-literals.ts` (new) | Escape a string, a byte string and the bytewise-reversed form into ClickHouse literals; array forms. |
| `lib/ulp-dedupe.ts` (modify) | `dedupeCountPartial`: the state form of the result tally, so disjoint scans combine exactly. |
| `lib/search-dictionary.ts` (new) | Config, fingerprint, comment codec, status (fresh/stale/missing/building/disabled/unknown), the shadow build and swap, free-space check. |
| `lib/search-dictionary-plan.ts` (new) | Eligibility and the term, candidate lookup with caps and cache, the rows SQL and the totals SQL builders (pure). |
| `lib/search-dictionary-cron.ts` (new) | The tick (settle, mutation and disk checks, backoff) and `startSearchDictionaryCron`. |
| `app/api/credentials/route.ts` (modify) | Use the plan for rows and totals when eligible, fall back to the legacy queries, report `plan`. |
| `app/api/monitoring/ingest-health/route.ts`, `components/ingest-health-panel.tsx` (modify) | Report and show the dictionary status. |
| `instrumentation.ts`, `docker-compose.yml`, `docker-compose.rehearsal.yml`, `.env.example`, `README.md`, `scripts/clickhouse-backup.sh` (modify) | Start the cron, forward and document the env vars, keep the derived tables out of backups. |
| `scripts/build-search-dictionary.ts` (new) | The supervised first build, by hand. |
| `scripts/e2e-search-dictionary.ts` (new) | End-to-end rehearsal on the isolated stack. |
| `__tests__/*.test.ts`, `__tests__/search-dictionary-parity.live.test.ts` (new) | Unit tests per module, the route integration, source pins, and the gated live parity + timing test. |

## Setup

Work in the main checkout (the live app runs from a Docker image, so editing the tree changes nothing until the image is rebuilt) on a branch:

```bash
cd /home/cole/ulp-suite && git switch -c feat/search-dictionary
```

The plan and the spec's amendments are already committed on `main`. `git status` shows only the untracked `.claude/` before you start. Every task ends in a commit on this branch; Task 10 merges it to `main` after the live checks.

---

### Task 1: ClickHouse string literals

**Files:**
- Create: `lib/clickhouse-literals.ts`
- Test: `__tests__/clickhouse-literals.test.ts`

**Interfaces:**
- Produces (used by Tasks 4 and 9):
  - `chStringLiteral(value: string): string`
  - `chStringArrayLiteral(values: readonly string[]): string`
  - `chBytesLiteral(bytes: Uint8Array): string`
  - `chReversedLiteral(value: string): string`  (the literal of `reverse(value)` as ClickHouse computes it: the UTF-8 bytes in reverse order)
  - `chReversedArrayLiteral(values: readonly string[]): string`

- [ ] **Step 1: Write the failing test**

Create `__tests__/clickhouse-literals.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import {
  chStringLiteral, chStringArrayLiteral, chBytesLiteral, chReversedLiteral, chReversedArrayLiteral,
} from '@/lib/clickhouse-literals'

/** The inverse of the escaping, from ClickHouse's own rules for a quoted string: \\ \' \xHH, every other character literal. */
function unescapeToBytes(literal: string): Buffer {
  expect(literal.startsWith("'") && literal.endsWith("'")).toBe(true)
  const body = literal.slice(1, -1)
  const out: Buffer[] = []
  for (let i = 0; i < body.length; ) {
    const ch = body[i]
    if (ch === '\\') {
      const next = body[i + 1]
      if (next === '\\' || next === "'") { out.push(Buffer.from(next)); i += 2; continue }
      if (next === 'x') { out.push(Buffer.from([parseInt(body.slice(i + 2, i + 4), 16)])); i += 4; continue }
      throw new Error(`unexpected escape \\${next}`)
    }
    expect(ch).not.toBe("'")
    const cp = body.codePointAt(i) as number
    const text = String.fromCodePoint(cp)
    out.push(Buffer.from(text, 'utf8'))
    i += text.length
  }
  return Buffer.concat(out)
}

const nasty = [
  'plain.com', "a'b.com", 'a\\b.com', "a\\'b.com", "'; DROP TABLE ulp.credentials; --", '\\\\\'', "x'] ) OR 1=1 --",
  'line\nbreak.com', 'tab\tchar.com', 'nul\u0000byte.com', 'bell\u0007.com', 'del\u007f.com', 'emoji-😀.com', 'rtl-‮evil.com',
  'percent%_underscore_.com', '', ' ', 'a'.repeat(4000), 'ünïcödé.例え.jp', 'back`tick"dq.com', '--comment', '/* c */', '\\x41', '\\0', '\\n',
]

describe('chStringLiteral', () => {
  test('wraps a plain value in single quotes', () => {
    expect(chStringLiteral('plain.com')).toBe("'plain.com'")
    expect(chStringLiteral('')).toBe("''")
  })

  test('escapes the two characters that can end or alter a literal: the quote and the backslash', () => {
    expect(chStringLiteral("a'b")).toBe("'a\\'b'")
    expect(chStringLiteral('a\\b')).toBe("'a\\\\b'")
    expect(chStringLiteral("a\\'b")).toBe("'a\\\\\\'b'")
  })

  test('an injection attempt stays inside the literal', () => {
    expect(chStringLiteral("'; DROP TABLE x; --")).toBe("'\\'; DROP TABLE x; --'")
  })

  test('writes control characters as \\xHH so no raw NUL or line break travels in the SQL text', () => {
    expect(chStringLiteral('a\u0000b')).toBe("'a\\x00b'")
    expect(chStringLiteral('a\nb')).toBe("'a\\x0ab'")
    expect(chStringLiteral('a\tb')).toBe("'a\\x09b'")
    expect(chStringLiteral('a\u007fb')).toBe("'a\\x7fb'")
  })

  test('leaves printable and non-ASCII text alone', () => {
    expect(chStringLiteral('emoji-😀.com')).toBe("'emoji-😀.com'")
    expect(chStringLiteral('ünïcödé.例え.jp')).toBe("'ünïcödé.例え.jp'")
  })

  test.each(nasty)('round-trips byte for byte: %j', value => {
    expect(unescapeToBytes(chStringLiteral(value)).equals(Buffer.from(value, 'utf8'))).toBe(true)
  })

  test('round-trips 300 pseudo-random strings built from the troublesome alphabet', () => {
    const alphabet = ["'", '\\', '"', '`', '\n', '\r', '\t', '\u0000', '\u001f', '\u007f', ' ', 'a', 'Z', '0', '.', '-', '_', '%', '😀', 'é', '例', '‮']
    let seed = 12345
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    for (let n = 0; n < 300; n++) {
      const len = next() % 40
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[next() % alphabet.length]
      expect(unescapeToBytes(chStringLiteral(s)).equals(Buffer.from(s, 'utf8')), JSON.stringify(s)).toBe(true)
    }
  })
})

describe('chBytesLiteral / chReversedLiteral', () => {
  test('writes every byte of 0x7f and above, every control byte, the quote and the backslash as an escape', () => {
    expect(chBytesLiteral(Uint8Array.from([0x6d, 0xa9, 0xc3, 0x27, 0x5c, 0x00]))).toBe("'m\\xa9\\xc3\\'\\\\\\x00'")
  })

  test('is the literal of reverse(value) as ClickHouse computes it: the UTF-8 bytes in reverse order', () => {
    expect(chReversedLiteral('ledger.com')).toBe("'moc.regdel'")
    // verified on the live server: reverse('é.com') = 'moc.\xA9\xC3', and it is NOT 'moc.é'
    expect(chReversedLiteral('é.com')).toBe("'moc.\\xa9\\xc3'")
  })

  test('a reversed literal unescapes to the reversed bytes', () => {
    for (const v of ['ledger.com', 'é.com', 'gma?°l.com', 'пример.рф', "o'neil.com"]) {
      expect(unescapeToBytes(chReversedLiteral(v)).equals(Buffer.from(Buffer.from(v, 'utf8')).reverse())).toBe(true)
    }
  })
})

describe('array literals', () => {
  test('comma-joined inside brackets, empty is []', () => {
    expect(chStringArrayLiteral(['a.com', "b'c.com"])).toBe("['a.com','b\\'c.com']")
    expect(chStringArrayLiteral([])).toBe('[]')
    expect(chReversedArrayLiteral(['ab.com', 'é.com'])).toBe("['moc.ba','moc.\\xa9\\xc3']")
    expect(chReversedArrayLiteral([])).toBe('[]')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/clickhouse-literals.test.ts`
Expected: FAIL, "Failed to resolve import "@/lib/clickhouse-literals"".

- [ ] **Step 3: Write the implementation**

Create `lib/clickhouse-literals.ts`:

```ts
/**
 * ClickHouse string literals, for the few places a value must be written into the SQL text instead of passed as a query parameter.
 *
 * Why not always a parameter: parameters travel in the URL, and ClickHouse refuses one longer than http_max_field_value_size (128 KiB:
 * "HTML Form Exception: Field value too long" -- measured 2026-10-03 with 3,000 domains of 43 characters; 40,000 gave "URI too long").
 * The SQL itself travels in the request body, where the limit is max_query_size (256 KiB). A candidate list of a few thousand domains fits
 * there, so lib/search-dictionary-plan.ts inlines it, and caps it by bytes.
 *
 * The escaping rule (a ClickHouse quoted string): a backslash and a single quote are the only characters that end or alter a literal, so
 * those two are escaped; control characters are written as \xHH so no raw NUL or line break travels in the text. Verified live: 25 awkward
 * strings (quotes, backslashes, "'; DROP TABLE", NUL, RTL override, a 4,000-character string, "\x41" as text) came back byte for byte.
 *
 * `reverse()` in ClickHouse is BYTEWISE: reverse('é.com') is 'moc.\xA9\xC3', not 'moc.é'. The reversed-key projection
 * (proj_email_domain_rev, ORDER BY reverse(email_domain)) is matched with exactly those bytes, so a reversed value is built from the UTF-8
 * bytes here and written with \xHH escapes -- never from a reversed JavaScript string, which would silently miss every non-ASCII value.
 */
export function chStringLiteral(value: string): string {
  let out = "'"
  for (const ch of value) {
    const code = ch.codePointAt(0) as number
    if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "\\'"
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return `${out}'`
}

export function chStringArrayLiteral(values: readonly string[]): string {
  return `[${values.map(chStringLiteral).join(',')}]`
}

/** A literal for raw bytes: printable ASCII as is, the quote and backslash escaped, everything else (and 0x7f) as \xHH. */
export function chBytesLiteral(bytes: Uint8Array): string {
  let out = "'"
  for (const b of bytes) {
    if (b === 0x5c) out += '\\\\'
    else if (b === 0x27) out += "\\'"
    else if (b < 0x20 || b >= 0x7f) out += `\\x${b.toString(16).padStart(2, '0')}`
    else out += String.fromCharCode(b)
  }
  return `${out}'`
}

/** The literal of reverse(value) as ClickHouse computes it on a String: the UTF-8 bytes, last to first. */
export function chReversedLiteral(value: string): string {
  return chBytesLiteral(Buffer.from(value, 'utf8').reverse())
}

export function chReversedArrayLiteral(values: readonly string[]): string {
  return `[${values.map(chReversedLiteral).join(',')}]`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/clickhouse-literals.test.ts`
Expected: PASS (all tests in the file; about 40 including the `test.each` cases).

- [ ] **Step 5: Commit**

```bash
git add lib/clickhouse-literals.ts __tests__/clickhouse-literals.test.ts
git commit -m "feat(search-dictionary): escaped ClickHouse literals and the bytewise reverse of the projection key

Parameters above 128 KiB are refused by ClickHouse, so the candidate lists are inlined; the escaping is pinned by a round trip of awkward strings.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Exact combination of disjoint tallies

**Files:**
- Modify: `lib/ulp-dedupe.ts` (append after `dedupeCountExpr`, line 65)
- Modify: `__tests__/ulp-dedupe.test.ts` (extend the import on line 2, add a `describe` before the final `})`)

**Interfaces:**
- Consumes: `DEDUPE_BY` from the same file.
- Produces (used by Task 4): `dedupeCountPartial(dedupe: boolean, hasUserFilter?: boolean, onlyIf?: string): { partial: string; combine: (column: string) => string }`

- [ ] **Step 1: Write the failing tests**

In `__tests__/ulp-dedupe.test.ts` change line 2 to:

```ts
import { DEDUPE_BY, dedupeLimitBy, dedupeCountExpr, dedupeCountPartial } from '@/lib/ulp-dedupe'
```

and insert, just before the final `})` of the outer `describe('ulp-dedupe', ...)`:

```ts
  describe('dedupeCountPartial', () => {
    // Measured on the live table 2026-10-03 for a term with 1.23M credentials: one scan 1,234,432 unique; the SUM of the two
    // disjoint halves 1,234,344; uniqIfMerge over uniqIfState of the same halves 1,234,432, identical. Counts add exactly.
    test('the distinct forms hand back aggregate STATES and merge them, so two disjoint scans equal one scan', () => {
      const withNoise = dedupeCountPartial(true, true, 'is_noise = 0')
      expect(withNoise.partial).toBe('uniqIfState(content_key_hash, is_noise = 0)')
      expect(withNoise.combine('part_total')).toBe('uniqIfMerge(part_total)')
      const plain = dedupeCountPartial(true, true)
      expect(plain.partial).toBe('uniqState(content_key_hash)')
      expect(plain.combine('part_total')).toBe('uniqMerge(part_total)')
    })

    test('the count forms are plain counts that are summed', () => {
      expect(dedupeCountPartial(false, true).partial).toBe('count()')
      expect(dedupeCountPartial(false, true).combine('c')).toBe('sum(c)')
      expect(dedupeCountPartial(false, true, 'is_noise = 0').partial).toBe('countIf(is_noise = 0)')
      expect(dedupeCountPartial(true, false).partial).toBe('count()')
      expect(dedupeCountPartial(true, false, 'is_noise = 0').partial).toBe('countIf(is_noise = 0)')
    })

    test('defaults to the filtered, distinct form, like dedupeCountExpr', () => {
      expect(dedupeCountPartial(true).partial).toBe('uniqState(content_key_hash)')
    })

    test('chooses the same form as dedupeCountExpr for every input', () => {
      for (const dedupe of [true, false]) {
        for (const filtered of [true, false]) {
          for (const onlyIf of [undefined, 'is_noise = 0']) {
            const expr = dedupeCountExpr(dedupe, filtered, onlyIf)
            const { partial } = dedupeCountPartial(dedupe, filtered, onlyIf)
            // the state form is the plain aggregate with `State` after the function name
            expect(partial).toBe(expr.replace(/^uniqIf\(/, 'uniqIfState(').replace(/^uniq\(/, 'uniqState('))
          }
        }
      }
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/ulp-dedupe.test.ts`
Expected: FAIL, `dedupeCountPartial is not a function` (the four new tests fail; the older ones pass).

- [ ] **Step 3: Write the implementation**

Append to `lib/ulp-dedupe.ts`:

```ts

export interface DedupeCountPartial {
  /** The aggregate one scan computes. For the distinct forms it is an aggregate STATE; for the count forms a plain count. */
  partial: string
  /** Turns a column holding the partials of several DISJOINT scans into the final tally. */
  combine: (column: string) => string
}

/**
 * dedupeCountExpr split in two, so that several disjoint scans of the search predicate (lib/search-dictionary-plan.ts runs two) add up EXACTLY.
 * `uniq` is an estimate and the sum of two estimates is not the estimate of the union: measured on the live table for a term with 1.23M
 * credentials, one scan gave 1,234,432, the SUM of two disjoint halves 1,234,344, and `uniqIfMerge` over the halves' `uniqIfState`s 1,234,432
 * -- identical to the single scan. Counts add exactly. The branch of each form is the same one dedupeCountExpr picks.
 */
export function dedupeCountPartial(dedupe: boolean, hasUserFilter = true, onlyIf?: string): DedupeCountPartial {
  const distinct = dedupe && hasUserFilter
  if (distinct) {
    return onlyIf
      ? { partial: `uniqIfState(${DEDUPE_BY}, ${onlyIf})`, combine: column => `uniqIfMerge(${column})` }
      : { partial: `uniqState(${DEDUPE_BY})`, combine: column => `uniqMerge(${column})` }
  }
  return onlyIf
    ? { partial: `countIf(${onlyIf})`, combine: column => `sum(${column})` }
    : { partial: 'count()', combine: column => `sum(${column})` }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/ulp-dedupe.test.ts`
Expected: PASS (all tests, including the four new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/ulp-dedupe.ts __tests__/ulp-dedupe.test.ts
git commit -m "feat(search-dictionary): a state form of the result tally

Two disjoint scans must add up to the single scan's number: merging uniq states did (1,234,432), adding the estimates did not (1,234,344).

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The dictionary tables, their fingerprint, status and build

**Files:**
- Create: `lib/search-dictionary.ts`
- Test: `__tests__/search-dictionary.test.ts`

**Interfaces:**
- Consumes: `executeQuery`, `getClient` (`@/lib/clickhouse`); `checkDiskHeadroom`, `computeEffectiveFloorBytes`, `resolveDiskGuardOptions`, `formatBytes` (`@/lib/clickhouse-disk-guard`).
- Produces (used by Tasks 4, 5, 6, 7, 8, 9):
  - `type Run = (sql: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>`
  - constants `HOST_DICT_TABLE = 'ulp.search_host_dict'`, `EMAIL_DICT_TABLE = 'ulp.search_emaildomain_dict'`, `DICT_FORMAT_VERSION = 1`, `DICT_BUILD_LOG_COMMENT = 'search_dict_build'`, `BUILD_HEADROOM_BYTES`
  - `searchDictionaryEnabled(env?)`, `searchDictMaxDomains(env?)` (3000), `searchDictMaxEmailDomains(env?)` (300), `searchDictCronMinutes(env?)` (10), `searchDictSettleSeconds(env?)` (120)
  - `buildLiveStateSql(): string`, `liveStateFromRow(row): LiveState | null`, `readLiveState(run?): Promise<LiveState | null>` with `LiveState = { fingerprint: string; mutationsRunning: number; buildsRunning: number }`
  - `encodeDictionaryComment(c)`, `parseDictionaryComment(raw)` with `DictionaryComment = { v: number; fp: string; builtAt: string; rows: number | null }`
  - `type DictionaryState = 'fresh' | 'stale' | 'missing' | 'building' | 'disabled' | 'unknown'`; `interface DictionaryStatus { state; fingerprint: string | null; builtAt: string | null; pairRows: number | null; emailRows: number | null; bytes: number | null; lastError: string | null; lastBuildMs: number | null }`
  - `evaluateDictionaryState({ enabled, live, tables })`, `getSearchDictionaryStatus(run?, now?)`, `resetSearchDictionaryCache()`
  - `recordBuildOutcome(patch)`, `readBuildRecord()`
  - `class DictionaryHeadroomError extends Error`, `buildSearchDictionary(opts?): Promise<{ pairRows; emailRows; ms; fingerprint }>` with `BuildOptions = { client?; run?; now?; log?; skipHeadroomCheck? }`

- [ ] **Step 1: Write the failing test**

Create `__tests__/search-dictionary.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))
vi.mock('@/lib/clickhouse-disk-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/clickhouse-disk-guard')>('@/lib/clickhouse-disk-guard')
  return { ...actual, checkDiskHeadroom: vi.fn() }
})

import * as dict from '@/lib/search-dictionary'
import { checkDiskHeadroom } from '@/lib/clickhouse-disk-guard'

const GIB = 1024 ** 3
const liveRow = (over: Record<string, unknown> = {}) => ({
  table_uuid: 'uuid-1',
  part_state: '202607:100:0:5;202608:200:0:6',
  mutation_state: '0000000012:(MATERIALIZE COLUMN country_tier)',
  mutations_running: '0',
  builds_running: '0',
  ...over,
})
const fpOf = (over: Record<string, unknown> = {}) => dict.liveStateFromRow(liveRow(over))!.fingerprint

beforeEach(() => {
  dict.resetSearchDictionaryCache()
  dict.recordBuildOutcome({ lastError: null, lastBuildMs: null, lastBuiltAt: null })
  vi.mocked(checkDiskHeadroom).mockResolvedValue({ freeBytes: 300 * GIB, totalBytes: 937 * GIB, ratio: 0.32 })
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('configuration', () => {
  test('on unless switched off', () => {
    expect(dict.searchDictionaryEnabled({})).toBe(true)
    expect(dict.searchDictionaryEnabled({ SEARCH_DICTIONARY: '1' })).toBe(true)
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' 0 ']) expect(dict.searchDictionaryEnabled({ SEARCH_DICTIONARY: v }), v).toBe(false)
  })

  test('caps, cron and settle defaults, overrides, and junk falling back to the default', () => {
    expect(dict.searchDictMaxDomains({})).toBe(3000)
    expect(dict.searchDictMaxEmailDomains({})).toBe(300)
    expect(dict.searchDictCronMinutes({})).toBe(10)
    expect(dict.searchDictSettleSeconds({})).toBe(120)
    expect(dict.searchDictMaxDomains({ SEARCH_DICT_MAX_DOMAINS: '500' })).toBe(500)
    expect(dict.searchDictCronMinutes({ SEARCH_DICT_CRON_MINUTES: '0' })).toBe(0)
    expect(dict.searchDictSettleSeconds({ SEARCH_DICT_SETTLE_SECONDS: '5' })).toBe(5)
    for (const junk of ['', 'abc', '-5', 'NaN']) expect(dict.searchDictMaxDomains({ SEARCH_DICT_MAX_DOMAINS: junk }), junk).toBe(3000)
  })
})

describe('buildLiveStateSql', () => {
  const sql = dict.buildLiveStateSql()

  // `system.mutations.command` is wrapped in parentheses -- (CLEAR PROJECTION proj_imported_desc IN PARTITION '202607') -- so an anchored
  // ^CLEAR PROJECTION matches none of them and the dictionary would be invalidated by the daily 05:00Z clear (verified live 2026-10-03:
  // this form excludes 18 of the 19 listed mutations; the one kept is MATERIALIZE COLUMN country_tier).
  test('leaves projection and index mutations out of the fingerprint, with a pattern that allows the opening parenthesis', () => {
    expect(sql).toContain(String.raw`match(command, '^\\(?(CLEAR|MATERIALIZE|DROP|ADD) (PROJECTION|INDEX)')`)
    expect(sql.match(/NOT match\(command/g)).toHaveLength(2)
  })

  test('fingerprints the table uuid, per-partition rows and block range of the ACTIVE parts, and the mutation list', () => {
    expect(sql).toContain("FROM system.tables WHERE database = 'ulp' AND name = 'credentials'")
    expect(sql).toContain('min(min_block_number)')
    expect(sql).toContain('max(max_block_number)')
    expect(sql).toContain("table = 'credentials' AND active GROUP BY partition")
  })

  test('also reports running content mutations and running dictionary builds', () => {
    expect(sql).toContain('AND NOT is_done AND NOT match(command')
    expect(sql).toContain("FROM system.processes WHERE log_comment = 'search_dict_build'")
  })

  test('never goes through the query cache, and stays out of the older route tests\' query-count patterns', () => {
    expect(sql).toContain('use_query_cache = 0')
    expect(sql).not.toMatch(/\) AS t\s/)
    expect(sql).not.toMatch(/AS raw_total/)
  })
})

describe('liveStateFromRow', () => {
  test('a stable sha1 of the uuid, the part state and the mutation state', () => {
    const a = dict.liveStateFromRow(liveRow())!
    expect(a.fingerprint).toMatch(/^[0-9a-f]{40}$/)
    expect(dict.liveStateFromRow(liveRow())!.fingerprint).toBe(a.fingerprint)
  })

  test('changes when rows arrive, a partition appears, the table is swapped, or a content mutation is added', () => {
    const base = fpOf()
    expect(fpOf({ part_state: '202607:100:0:5;202608:201:0:7' })).not.toBe(base)
    expect(fpOf({ part_state: '202607:100:0:5;202608:200:0:6;202610:5:0:8' })).not.toBe(base)
    expect(fpOf({ table_uuid: 'uuid-2' })).not.toBe(base)
    expect(fpOf({ mutation_state: '0000000012:(MATERIALIZE COLUMN country_tier);0000000019:(DELETE WHERE x = 1)' })).not.toBe(base)
  })

  test('reads the running counts, which arrive as strings', () => {
    expect(dict.liveStateFromRow(liveRow({ mutations_running: '2', builds_running: '1' }))).toMatchObject({ mutationsRunning: 2, buildsRunning: 1 })
  })

  test('an empty mutation list is a valid state; anything unusable fails closed', () => {
    expect(dict.liveStateFromRow(liveRow({ mutation_state: '' }))).not.toBeNull()
    expect(dict.liveStateFromRow(undefined)).toBeNull()
    expect(dict.liveStateFromRow(liveRow({ table_uuid: '' }))).toBeNull()
    expect(dict.liveStateFromRow(liveRow({ part_state: '' }))).toBeNull()
    expect(dict.liveStateFromRow(liveRow({ mutation_state: null }))).toBeNull()
    expect(dict.liveStateFromRow({ total: '7', raw_total: '9' })).toBeNull() // what an older test's mock answers to any query
  })
})

describe('dictionary comment', () => {
  test('round-trips', () => {
    const c = { v: 1, fp: 'a'.repeat(40), builtAt: '2026-10-03T12:00:00.000Z', rows: 85232652 }
    expect(dict.parseDictionaryComment(dict.encodeDictionaryComment(c))).toEqual(c)
    expect(dict.parseDictionaryComment(dict.encodeDictionaryComment({ ...c, rows: null }))).toEqual({ ...c, rows: null })
  })

  test('rejects anything that is not this version\'s comment', () => {
    for (const bad of [undefined, null, '', 'not json', '{}', '{"v":2,"fp":"aaaaaaaaaa","builtAt":"x"}', '{"v":1,"fp":"short","builtAt":"x"}', '{"v":1,"fp":"aaaaaaaaaa"}', 42]) {
      expect(dict.parseDictionaryComment(bad), String(bad)).toBeNull()
    }
  })

  test('refuses to encode a value that would need escaping inside the single-quoted DDL string', () => {
    expect(() => dict.encodeDictionaryComment({ v: 1, fp: "ab'cdefghij", builtAt: 'x', rows: null })).toThrow()
    expect(() => dict.encodeDictionaryComment({ v: 1, fp: 'ab\\cdefghij', builtAt: 'x', rows: null })).toThrow()
  })
})

describe('evaluateDictionaryState', () => {
  const live = dict.liveStateFromRow(liveRow())!
  const comment = (fp: string, rows: number | null = 10) => dict.encodeDictionaryComment({ v: 1, fp, builtAt: '2026-10-03T12:00:00.000Z', rows })
  const tables = (hostFp: string, emailFp: string) => [
    { name: 'search_host_dict', comment: comment(hostFp, 85), rows: 85, bytes: 2000 },
    { name: 'search_emaildomain_dict', comment: comment(emailFp, 13), rows: 13, bytes: 100 },
  ]

  test('fresh only when BOTH comments carry the live fingerprint', () => {
    const s = dict.evaluateDictionaryState({ enabled: true, live, tables: tables(live.fingerprint, live.fingerprint) })
    expect(s).toMatchObject({ state: 'fresh', fingerprint: live.fingerprint, pairRows: 85, emailRows: 13, bytes: 2100, builtAt: '2026-10-03T12:00:00.000Z' })
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: tables(live.fingerprint, 'f'.repeat(40)) }).state).toBe('stale')
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: tables('f'.repeat(40), live.fingerprint) }).state).toBe('stale')
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: tables('f'.repeat(40), 'f'.repeat(40)) }).fingerprint).toBeNull()
  })

  test('stale when a comment cannot be read', () => {
    const t = tables(live.fingerprint, live.fingerprint)
    t[1] = { ...t[1], comment: '' }
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: t }).state).toBe('stale')
  })

  test('missing when either table is absent', () => {
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: [] }).state).toBe('missing')
    expect(dict.evaluateDictionaryState({ enabled: true, live, tables: tables(live.fingerprint, live.fingerprint).slice(0, 1) }).state).toBe('missing')
  })

  test('building while a build query runs, disabled when switched off, unknown when the live state cannot be read', () => {
    expect(dict.evaluateDictionaryState({ enabled: true, live: { ...live, buildsRunning: 1 }, tables: tables(live.fingerprint, live.fingerprint) }).state).toBe('building')
    expect(dict.evaluateDictionaryState({ enabled: false, live, tables: [] }).state).toBe('disabled')
    expect(dict.evaluateDictionaryState({ enabled: true, live: null, tables: [] }).state).toBe('unknown')
  })
})

describe('getSearchDictionaryStatus', () => {
  const live = dict.liveStateFromRow(liveRow())!
  const goodTables = [
    { name: 'search_host_dict', comment: dict.encodeDictionaryComment({ v: 1, fp: live.fingerprint, builtAt: '2026-10-03T12:00:00.000Z', rows: 85 }), table_rows: '85', table_bytes: '2000' },
    { name: 'search_emaildomain_dict', comment: dict.encodeDictionaryComment({ v: 1, fp: live.fingerprint, builtAt: '2026-10-03T12:00:00.000Z', rows: 13 }), table_rows: '13', table_bytes: '100' },
  ]
  const router = () => vi.fn(async (sql: string) => (sql.includes('AS table_uuid') ? [liveRow()] : sql.includes('FROM system.tables') ? goodTables : []))

  test('fresh, with the sizes and the build time', async () => {
    const s = await dict.getSearchDictionaryStatus(router(), () => 1000)
    expect(s).toMatchObject({ state: 'fresh', pairRows: 85, emailRows: 13, bytes: 2100, fingerprint: live.fingerprint })
  })

  test('answers from a 3 second cache, then asks again (a "fresh" verdict must not outlive a change to the data for long)', async () => {
    const run = router()
    let t = 1000
    await dict.getSearchDictionaryStatus(run, () => t)
    await dict.getSearchDictionaryStatus(run, () => t)
    t += 2_000
    await dict.getSearchDictionaryStatus(run, () => t)
    expect(run).toHaveBeenCalledTimes(2) // the live state and the table list, once
    t += 1_500
    await dict.getSearchDictionaryStatus(run, () => t)
    expect(run).toHaveBeenCalledTimes(4)
  })

  test('concurrent callers share one check', async () => {
    const run = router()
    await Promise.all([1, 2, 3].map(() => dict.getSearchDictionaryStatus(run, () => 1000)))
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('fails closed to unknown when ClickHouse errors, and retries after five seconds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn().mockRejectedValue(new Error('connection refused'))
    let t = 1000
    expect((await dict.getSearchDictionaryStatus(run, () => t)).state).toBe('unknown')
    const calls = run.mock.calls.length
    t += 4_000
    await dict.getSearchDictionaryStatus(run, () => t)
    expect(run.mock.calls.length).toBe(calls)
    t += 2_000
    await dict.getSearchDictionaryStatus(run, () => t)
    expect(run.mock.calls.length).toBeGreaterThan(calls)
  })

  test('an answer it cannot read is unknown, never fresh', async () => {
    const run = vi.fn(async () => [{ total: '7', raw_total: '9' }])
    expect((await dict.getSearchDictionaryStatus(run, () => 1000)).state).toBe('unknown')
  })

  test('switched off: disabled, and ClickHouse is not asked', async () => {
    vi.stubEnv('SEARCH_DICTIONARY', '0')
    const run = router()
    expect((await dict.getSearchDictionaryStatus(run, () => 1000)).state).toBe('disabled')
    expect(run).not.toHaveBeenCalled()
  })

  test('carries the last build error and duration the cron recorded', async () => {
    dict.recordBuildOutcome({ lastError: 'boom', lastBuildMs: 129_000 })
    const s = await dict.getSearchDictionaryStatus(router(), () => 1000)
    expect(s).toMatchObject({ lastError: 'boom', lastBuildMs: 129_000 })
  })
})

describe('buildSearchDictionary', () => {
  const NOW = new Date('2026-10-03T12:00:00.000Z')

  function harness(opts: { existing?: boolean; failOn?: RegExp; live?: Record<string, unknown>; counts?: [number, number] } = {}) {
    const events: string[] = []
    const counts = opts.counts ?? [85, 13]
    const client = {
      command: vi.fn(async (a: { query: string; clickhouse_settings?: Record<string, unknown> }) => {
        if (opts.failOn?.test(a.query)) throw new Error(`boom in ${a.query.slice(0, 40)}`)
        events.push(`cmd:${a.query}`)
        return {}
      }),
    }
    const run = vi.fn(async (sql: string) => {
      if (sql.includes('AS table_uuid')) { events.push('run:live'); return [liveRow(opts.live)] }
      if (/FROM system\.tables/.test(sql)) { events.push('run:exists'); return [{ n: opts.existing ? '1' : '0' }] }
      if (/FROM ulp\.search_host_dict__new/.test(sql)) return [{ n: String(counts[0]) }]
      if (/FROM ulp\.search_emaildomain_dict__new/.test(sql)) return [{ n: String(counts[1]) }]
      return []
    })
    return { client, run, events }
  }
  const cmds = (events: string[]) => events.filter(e => e.startsWith('cmd:')).map(e => e.slice(4))
  const at = (events: string[], re: RegExp) => events.findIndex(e => re.test(e))
  const commentOf = (query: string) => dict.parseDictionaryComment(/COMMENT '(.*)'$/.exec(query.replace(/\s+/g, ' ').trim())?.[1])

  test('reads the fingerprint FIRST, builds into shadow tables, then swaps (a first build renames)', async () => {
    const h = harness()
    const result = await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    expect(result).toMatchObject({ pairRows: 85, emailRows: 13, fingerprint: fpOf() })
    expect(h.events[0]).toBe('run:live')
    const e = h.events
    const order = [
      /DROP TABLE IF EXISTS ulp\.search_host_dict__new SYNC/, /CREATE TABLE ulp\.search_host_dict__new/, /CREATE TABLE ulp\.search_emaildomain_dict__new/,
      /INSERT INTO ulp\.search_host_dict__new SELECT domain, url_host FROM ulp\.credentials GROUP BY domain, url_host/,
      /OPTIMIZE TABLE ulp\.search_host_dict__new FINAL/, /ALTER TABLE ulp\.search_host_dict__new MODIFY COMMENT/,
      /INSERT INTO ulp\.search_emaildomain_dict__new SELECT email_domain FROM ulp\.credentials GROUP BY email_domain/,
      /ALTER TABLE ulp\.search_emaildomain_dict__new MODIFY COMMENT/,
      /RENAME TABLE ulp\.search_host_dict__new TO ulp\.search_host_dict/, /RENAME TABLE ulp\.search_emaildomain_dict__new TO ulp\.search_emaildomain_dict/,
    ].map(re => at(e, re))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(at(e, /EXCHANGE/)).toBe(-1)
  })

  test('when the dictionary already exists the swap is EXCHANGE TABLES, and the old copy is dropped afterwards', async () => {
    const h = harness({ existing: true })
    await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    const c = cmds(h.events)
    expect(c).toContain('EXCHANGE TABLES ulp.search_host_dict__new AND ulp.search_host_dict')
    expect(c).toContain('EXCHANGE TABLES ulp.search_emaildomain_dict__new AND ulp.search_emaildomain_dict')
    expect(c.some(q => q.startsWith('RENAME'))).toBe(false)
    expect(at(h.events, /EXCHANGE TABLES ulp\.search_host_dict__new/)).toBeLessThan(h.events.lastIndexOf('cmd:DROP TABLE IF EXISTS ulp.search_host_dict__new SYNC'))
  })

  test('both tables carry the fingerprint read BEFORE the build; the row count is added before the swap', async () => {
    const h = harness()
    await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    const c = cmds(h.events)
    const created = c.filter(q => q.startsWith('CREATE TABLE'))
    expect(created).toHaveLength(2)
    for (const q of created) expect(commentOf(q)).toMatchObject({ v: 1, fp: fpOf(), builtAt: NOW.toISOString(), rows: null })
    const modified = c.filter(q => q.startsWith('ALTER TABLE'))
    expect(modified.map(q => commentOf(q)?.rows)).toEqual([85, 13])
    expect(created[0]).toContain('ENGINE = MergeTree ORDER BY (domain, url_host)')
    expect(created[1]).toContain('ENGINE = MergeTree ORDER BY email_domain')
  })

  test('the two INSERT ... SELECT statements carry the build settings of the spec', async () => {
    const h = harness()
    await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    const inserts = h.client.command.mock.calls.map(c => c[0]).filter(a => a.query.startsWith('INSERT INTO'))
    expect(inserts).toHaveLength(2)
    for (const a of inserts) {
      expect(a.clickhouse_settings).toMatchObject({
        max_threads: 8, max_memory_usage: 6_000_000_000, max_bytes_before_external_group_by: 3_000_000_000,
        async_insert: 0, log_comment: 'search_dict_build', use_query_cache: 0,
      })
    }
  })

  test('a failure half way drops the shadow tables, issues no swap, and records the error', async () => {
    const h = harness({ failOn: /INSERT INTO ulp\.search_emaildomain_dict__new/ })
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })).rejects.toThrow(/boom/)
    const c = cmds(h.events)
    expect(c.some(q => q.startsWith('EXCHANGE') || q.startsWith('RENAME'))).toBe(false)
    expect(c.filter(q => q === 'DROP TABLE IF EXISTS ulp.search_host_dict__new SYNC').length).toBeGreaterThanOrEqual(2)
    expect(c.filter(q => q === 'DROP TABLE IF EXISTS ulp.search_emaildomain_dict__new SYNC').length).toBeGreaterThanOrEqual(2)
    expect(dict.readBuildRecord().lastError).toMatch(/boom/)
  })

  test('an empty copy is never swapped in', async () => {
    const h = harness({ counts: [85, 0] })
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })).rejects.toThrow(/empty/)
    expect(cmds(h.events).some(q => q.startsWith('EXCHANGE') || q.startsWith('RENAME'))).toBe(false)
  })

  test('refuses while another build is running, and when the live fingerprint cannot be read; nothing is created', async () => {
    const busy = harness({ live: { builds_running: '1' } })
    await expect(dict.buildSearchDictionary({ client: busy.client, run: busy.run, log: () => {} })).rejects.toThrow(/already running/)
    expect(busy.client.command).not.toHaveBeenCalled()
    const blind = harness()
    blind.run.mockResolvedValue([])
    await expect(dict.buildSearchDictionary({ client: blind.client, run: blind.run, log: () => {} })).rejects.toThrow(/fingerprint/)
    expect(blind.client.command).not.toHaveBeenCalled()
  })

  test('refuses when the copy would push free space under the disk guard\'s floor, unless told the operator has checked', async () => {
    // floor on a 937 GiB disk = max(50 GiB, 15%) = 140.55 GiB; 143 GiB free minus the 3 GiB the build needs is under it
    vi.mocked(checkDiskHeadroom).mockResolvedValue({ freeBytes: 143 * GIB, totalBytes: 937 * GIB, ratio: 0.15 })
    const h = harness()
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, log: () => {} })).rejects.toBeInstanceOf(dict.DictionaryHeadroomError)
    expect(h.client.command).not.toHaveBeenCalled()
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {}, skipHeadroomCheck: true })).resolves.toBeTruthy()
  })

  test('an unreadable disk counts as no headroom (fail closed)', async () => {
    vi.mocked(checkDiskHeadroom).mockRejectedValue(new Error('system.disks returned no usable row'))
    const h = harness()
    await expect(dict.buildSearchDictionary({ client: h.client, run: h.run, log: () => {} })).rejects.toBeInstanceOf(dict.DictionaryHeadroomError)
  })

  test('success clears the recorded error, records the duration, and forgets the cached status', async () => {
    dict.recordBuildOutcome({ lastError: 'old failure' })
    const statusRun = vi.fn(async (sql: string) => (sql.includes('AS table_uuid') ? [liveRow()] : []))
    await dict.getSearchDictionaryStatus(statusRun, () => 1000) // fills the cache
    const h = harness()
    const result = await dict.buildSearchDictionary({ client: h.client, run: h.run, now: () => NOW, log: () => {} })
    expect(result.ms).toBeGreaterThanOrEqual(0)
    expect(dict.readBuildRecord()).toMatchObject({ lastError: null, lastBuiltAt: NOW.toISOString() })
    await dict.getSearchDictionaryStatus(statusRun, () => 1001) // within 3 s: only a reset cache asks again
    expect(statusRun.mock.calls.length).toBeGreaterThan(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/search-dictionary.test.ts`
Expected: FAIL, "Failed to resolve import "@/lib/search-dictionary"".

- [ ] **Step 3: Write the implementation**

Create `lib/search-dictionary.ts`:

```ts
/**
 * The search dictionary: two small derived tables behind the fast domain search.
 * Design and measurements: docs/superpowers/specs/2026-10-03-domain-search-dictionary-design.md
 *
 * Why. A domain-shaped term becomes `domain = x OR domain LIKE '%.x' OR url_host LIKE '%x%' OR email_domain LIKE '%x%'`, and ClickHouse
 * cannot prune any of it once two substring branches sit in the OR: `ORDER BY domain LIMIT 200` reads every granule before the term
 * (15-19 s in the app for the owner's real searches). The substring branches can be answered from the DISTINCT values instead:
 *   ulp.search_host_dict         (domain, url_host) pairs   85.2M rows, 1.99 GiB  -> which `domain` values hold a host containing x
 *   ulp.search_emaildomain_dict  (email_domain)             13.2M rows, 152 MiB   -> which email domains contain x
 * lib/search-dictionary-plan.ts turns those into pruning conjuncts. Both tables are DERIVED: dropped and rebuilt freely, never backed up
 * (scripts/clickhouse-backup.sh skips `search_`), plain MergeTree so a laptop resume that expires the Keeper session cannot make them read-only.
 *
 * Freshness fails CLOSED. The fingerprint of the live table (uuid, per-partition rows and block range, non-projection mutations) is
 * read BEFORE a build and stored in the COMMENT of both tables; the dictionary is fresh only when both comments equal the live
 * fingerprint, so an import, a delete, a partition swap or a table swap makes it stale and searches take today's query until the next build.
 */
import { createHash } from 'node:crypto'
import { executeQuery, getClient } from '@/lib/clickhouse'
import {
  checkDiskHeadroom, computeEffectiveFloorBytes, resolveDiskGuardOptions, formatBytes,
} from '@/lib/clickhouse-disk-guard'

export type Run = (sql: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
type Env = Record<string, string | undefined>

export const HOST_DICT_TABLE = 'ulp.search_host_dict'
export const EMAIL_DICT_TABLE = 'ulp.search_emaildomain_dict'
export const DICT_FORMAT_VERSION = 1
export const DICT_BUILD_LOG_COMMENT = 'search_dict_build'
const SHADOW_SUFFIX = '__new'
/** Free space a build needs above the disk guard's floor: the new copy lives next to the old one (2.14 GiB measured) plus merge slack. */
export const BUILD_HEADROOM_BYTES = 3 * 1024 ** 3

// ── configuration ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function searchDictionaryEnabled(env: Env = process.env): boolean {
  const v = (env.SEARCH_DICTIONARY ?? '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(v)
}
export const searchDictMaxDomains = (env: Env = process.env): number => envInt(env.SEARCH_DICT_MAX_DOMAINS, 3000)
export const searchDictMaxEmailDomains = (env: Env = process.env): number => envInt(env.SEARCH_DICT_MAX_EMAIL_DOMAINS, 300)
export const searchDictCronMinutes = (env: Env = process.env): number => envInt(env.SEARCH_DICT_CRON_MINUTES, 10)
export const searchDictSettleSeconds = (env: Env = process.env): number => envInt(env.SEARCH_DICT_SETTLE_SECONDS, 120)

// ── the fingerprint of the live table ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Mutations that cannot change what the dictionary holds: projection and index maintenance. lib/projection-scope-cron.ts runs `CLEAR PROJECTION`
 * on partition 202607 every day at 05:00Z, and without this exclusion that alone would invalidate the dictionary daily. NOTE the opening
 * parenthesis: system.mutations.command reads `(CLEAR PROJECTION proj_imported_desc IN PARTITION '202607')`, so an anchored `^CLEAR PROJECTION`
 * matches nothing (verified live 2026-10-03: this form excludes 18 of the 19 listed mutations; the one kept is MATERIALIZE COLUMN country_tier).
 * Index mutations are excluded too: the oldest history entries are DROP INDEX, and a spurious rebuild each time one ages out of the list is waste.
 * The doubled backslash is the SQL string literal's escape of one regex backslash.
 */
const NON_CONTENT_MUTATION = String.raw`match(command, '^\\(?(CLEAR|MATERIALIZE|DROP|ADD) (PROJECTION|INDEX)')`

/** One metadata query: the fingerprint inputs, plus whether a content mutation or a build is running. Never cached by ClickHouse. */
export function buildLiveStateSql(): string {
  return `SELECT
  (SELECT toString(uuid) FROM system.tables WHERE database = 'ulp' AND name = 'credentials') AS table_uuid,
  (SELECT arrayStringConcat(arraySort(groupArray(concat(partition, ':', toString(part_rows), ':', toString(min_block), ':', toString(max_block)))), ';')
     FROM (SELECT partition, sum(rows) AS part_rows, min(min_block_number) AS min_block, max(max_block_number) AS max_block
           FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active GROUP BY partition)) AS part_state,
  (SELECT arrayStringConcat(arraySort(groupArray(concat(mutation_id, ':', command))), ';')
     FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND NOT ${NON_CONTENT_MUTATION}) AS mutation_state,
  (SELECT count() FROM system.mutations
     WHERE database = 'ulp' AND table = 'credentials' AND NOT is_done AND NOT ${NON_CONTENT_MUTATION}) AS mutations_running,
  (SELECT count() FROM system.processes WHERE log_comment = '${DICT_BUILD_LOG_COMMENT}') AS builds_running
SETTINGS use_query_cache = 0`
}

export interface LiveState {
  /** sha1 of the table uuid, the part state and the content-mutation list. */
  fingerprint: string
  /** Content mutations (not projection or index ones) that have not finished. */
  mutationsRunning: number
  /** Dictionary build queries currently running anywhere (this app, a script, another process). */
  buildsRunning: number
}

/** null for anything unusable (no row, no uuid, no active parts, a row of another shape): the caller fails closed. */
export function liveStateFromRow(row: Record<string, unknown> | undefined): LiveState | null {
  if (!row) return null
  const uuid = typeof row.table_uuid === 'string' ? row.table_uuid : ''
  const parts = typeof row.part_state === 'string' ? row.part_state : ''
  const mutations = typeof row.mutation_state === 'string' ? row.mutation_state : null
  if (uuid === '' || parts === '' || mutations === null) return null
  const fingerprint = createHash('sha1').update(`${uuid}|${parts}|${mutations}`).digest('hex')
  return { fingerprint, mutationsRunning: Number(row.mutations_running) || 0, buildsRunning: Number(row.builds_running) || 0 }
}

export async function readLiveState(run: Run = executeQuery): Promise<LiveState | null> {
  try {
    const [row] = await run(buildLiveStateSql())
    return liveStateFromRow(row)
  } catch {
    return null
  }
}

// ── the comment that marks what a dictionary was built from ─────────────────────────────────────────────────────────────────

export interface DictionaryComment {
  v: number
  fp: string
  builtAt: string
  rows: number | null
}

/** The comment sits inside a single-quoted DDL string, so a quote or backslash in any field is refused rather than escaped. */
export function encodeDictionaryComment(c: DictionaryComment): string {
  const json = JSON.stringify({ v: c.v, fp: c.fp, builtAt: c.builtAt, rows: c.rows })
  if (/['\\]/.test(json)) throw new Error('[search-dictionary] a comment field contains a quote or backslash')
  return json
}

export function parseDictionaryComment(raw: unknown): DictionaryComment | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (o.v !== DICT_FORMAT_VERSION || typeof o.fp !== 'string' || o.fp.length < 8 || typeof o.builtAt !== 'string') return null
    return { v: o.v, fp: o.fp, builtAt: o.builtAt, rows: typeof o.rows === 'number' ? o.rows : null }
  } catch {
    return null
  }
}

// ── status ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type DictionaryState = 'fresh' | 'stale' | 'missing' | 'building' | 'disabled' | 'unknown'

export interface DictionaryTableInfo {
  /** Without the database: `search_host_dict`. */
  name: string
  comment: unknown
  rows: number
  bytes: number
}

export interface DictionaryStatus {
  state: DictionaryState
  /** The fingerprint the SERVING dictionary was built from; null unless fresh. */
  fingerprint: string | null
  builtAt: string | null
  pairRows: number | null
  emailRows: number | null
  bytes: number | null
  lastError: string | null
  lastBuildMs: number | null
}

const blankStatus = (state: DictionaryState): DictionaryStatus => ({
  state, fingerprint: null, builtAt: null, pairRows: null, emailRows: null, bytes: null, lastError: null, lastBuildMs: null,
})

/** Pure: what the live state and the two tables say. */
export function evaluateDictionaryState(input: { enabled: boolean; live: LiveState | null; tables: DictionaryTableInfo[] }): DictionaryStatus {
  if (!input.enabled) return blankStatus('disabled')
  if (!input.live) return blankStatus('unknown')
  const host = input.tables.find(t => t.name === 'search_host_dict')
  const email = input.tables.find(t => t.name === 'search_emaildomain_dict')
  const sizes = {
    pairRows: host?.rows ?? null,
    emailRows: email?.rows ?? null,
    bytes: host && email ? host.bytes + email.bytes : null,
  }
  if (input.live.buildsRunning > 0) return { ...blankStatus('building'), ...sizes }
  if (!host || !email) return { ...blankStatus('missing'), ...sizes }
  const hostComment = parseDictionaryComment(host.comment)
  const emailComment = parseDictionaryComment(email.comment)
  const fresh = hostComment !== null && emailComment !== null
    && hostComment.fp === input.live.fingerprint && emailComment.fp === input.live.fingerprint
  return {
    ...blankStatus(fresh ? 'fresh' : 'stale'), ...sizes,
    fingerprint: fresh ? input.live.fingerprint : null,
    builtAt: hostComment?.builtAt ?? null,
  }
}

interface BuildRecord { lastError: string | null; lastBuildMs: number | null; lastBuiltAt: string | null }
// The cron runs in the instrumentation chunk and the routes in their own: module-scope state would not be shared (see instrumentation.ts),
// so what a build leaves behind for the status lives on globalThis.
const G = globalThis as unknown as { __ulpSearchDictionary?: BuildRecord }
const record = (): BuildRecord => (G.__ulpSearchDictionary ??= { lastError: null, lastBuildMs: null, lastBuiltAt: null })

export function recordBuildOutcome(patch: Partial<BuildRecord>): void {
  Object.assign(record(), patch)
}
export function readBuildRecord(): BuildRecord {
  return { ...record() }
}
const withRecord = (s: DictionaryStatus): DictionaryStatus => ({ ...s, lastError: record().lastError, lastBuildMs: record().lastBuildMs })

const TABLES_SQL = `SELECT name, comment, total_rows AS table_rows, total_bytes AS table_bytes
FROM system.tables
WHERE database = 'ulp' AND name IN ('search_host_dict', 'search_emaildomain_dict')
SETTINGS use_query_cache = 0`

const STATUS_TTL_MS = 3_000
const STATUS_FAILED_TTL_MS = 5_000
let statusCache: { at: number; ttl: number; value: DictionaryStatus } | null = null
let statusInflight: Promise<DictionaryStatus> | null = null

export function resetSearchDictionaryCache(): void {
  statusCache = null
  statusInflight = null
}

/**
 * Never throws: any ClickHouse trouble is `unknown`, which no caller treats as fresh. Cached 3 s (5 s after a failure): a verdict of `fresh` is the
 * one answer that must not outlive a change to the data, because for that long a search could use candidates that miss a row with a NEW domain.
 */
export async function getSearchDictionaryStatus(run: Run = executeQuery, now: () => number = Date.now): Promise<DictionaryStatus> {
  const enabled = searchDictionaryEnabled()
  if (!enabled) return withRecord(blankStatus('disabled'))
  const t = now()
  if (statusCache && t - statusCache.at < statusCache.ttl) return withRecord(statusCache.value)
  if (statusInflight) return withRecord(await statusInflight)

  statusInflight = (async () => {
    let value = blankStatus('unknown')
    let ttl = STATUS_FAILED_TTL_MS
    try {
      const [live, tableRows] = await Promise.all([readLiveState(run), run(TABLES_SQL)])
      const tables: DictionaryTableInfo[] = tableRows.map(r => ({
        name: String(r.name), comment: r.comment, rows: Number(r.table_rows) || 0, bytes: Number(r.table_bytes) || 0,
      }))
      value = evaluateDictionaryState({ enabled, live, tables })
      if (value.state !== 'unknown') ttl = STATUS_TTL_MS
    } catch (err) {
      console.warn('[search-dictionary] status check failed -- treating the dictionary as unavailable:', err instanceof Error ? err.message : String(err))
    }
    statusCache = { at: now(), ttl, value }
    return value
  })()
  try {
    return withRecord(await statusInflight)
  } finally {
    statusInflight = null
  }
}

// ── the build ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Not a failure: the disk is too full to hold a second copy. The cron skips the tick and tries again later. */
export class DictionaryHeadroomError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DictionaryHeadroomError'
  }
}

export interface BuildClient {
  command(args: { query: string; clickhouse_settings?: Record<string, string | number | boolean> }): Promise<unknown>
}

export interface BuildOptions {
  client?: BuildClient
  run?: Run
  now?: () => Date
  log?: (message: string) => void
  /** Skip the free-space check: a supervised first build on a disk the operator has looked at. */
  skipHeadroomCheck?: boolean
}

export interface BuildResult {
  pairRows: number
  emailRows: number
  ms: number
  fingerprint: string
}

/** Measured 2026-10-03: pairs 129 s with a 3.78 GiB peak, email domains 20 s with 1.71 GiB; both stay far under these limits. */
const BUILD_SETTINGS = {
  max_threads: 8,
  max_memory_usage: 6_000_000_000,
  max_bytes_before_external_group_by: 3_000_000_000,
  async_insert: 0,
  max_execution_time: 1800,
  log_comment: DICT_BUILD_LOG_COMMENT,
  use_query_cache: 0,
}

async function assertHeadroom(): Promise<void> {
  let free: number
  let floor: number
  try {
    const headroom = await checkDiskHeadroom()
    free = headroom.freeBytes
    floor = computeEffectiveFloorBytes(resolveDiskGuardOptions(), headroom.totalBytes)
  } catch (err) {
    throw new DictionaryHeadroomError(`free space could not be read, so no build is started: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (free - BUILD_HEADROOM_BYTES < floor) {
    throw new DictionaryHeadroomError(
      `${formatBytes(free)} free would fall under the ${formatBytes(floor)} floor once the new copy (about ${formatBytes(BUILD_HEADROOM_BYTES)}) is written`,
    )
  }
}

/**
 * Rebuilds both tables into `<name>__new` and swaps them in (EXCHANGE TABLES; the first build has nothing to exchange and renames). The
 * fingerprint is read BEFORE the build and written to the new tables, so data that arrives meanwhile leaves them born stale and the next tick
 * rebuilds. Queries in flight finish on the old table. A failure drops the shadow tables and leaves the serving ones untouched.
 */
export async function buildSearchDictionary(opts: BuildOptions = {}): Promise<BuildResult> {
  const run: Run = opts.run ?? executeQuery
  const client: BuildClient = opts.client ?? (getClient() as unknown as BuildClient)
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? ((message: string) => console.warn(`[search-dictionary] ${message}`))
  const startedAt = Date.now()

  const live = await readLiveState(run)
  if (!live) throw new Error('[search-dictionary] the live fingerprint could not be read; refusing to build')
  if (live.buildsRunning > 0) throw new Error('[search-dictionary] another build of the search dictionary is already running')
  if (!opts.skipHeadroomCheck) await assertHeadroom()

  const builtAt = now().toISOString()
  const comment = (rows: number | null) => encodeDictionaryComment({ v: DICT_FORMAT_VERSION, fp: live.fingerprint, builtAt, rows })
  const shadow = (table: string) => `${table}${SHADOW_SUFFIX}`
  const specs = [
    {
      table: HOST_DICT_TABLE,
      ddl: '(domain String, url_host String) ENGINE = MergeTree ORDER BY (domain, url_host)',
      fill: 'SELECT domain, url_host FROM ulp.credentials GROUP BY domain, url_host',
    },
    {
      table: EMAIL_DICT_TABLE,
      ddl: '(email_domain String) ENGINE = MergeTree ORDER BY email_domain',
      fill: 'SELECT email_domain FROM ulp.credentials GROUP BY email_domain',
    },
  ]
  const dropShadows = async () => {
    for (const s of specs) await client.command({ query: `DROP TABLE IF EXISTS ${shadow(s.table)} SYNC` })
  }

  const counts: number[] = []
  try {
    await dropShadows()
    for (const s of specs) await client.command({ query: `CREATE TABLE ${shadow(s.table)} ${s.ddl} COMMENT '${comment(null)}'` })
    for (const s of specs) {
      log(`filling ${shadow(s.table)}`)
      await client.command({ query: `INSERT INTO ${shadow(s.table)} ${s.fill}`, clickhouse_settings: BUILD_SETTINGS })
      await client.command({ query: `OPTIMIZE TABLE ${shadow(s.table)} FINAL`, clickhouse_settings: { max_execution_time: 1800, optimize_throw_if_noop: 0 } })
      const [row] = await run(`SELECT count() AS n FROM ${shadow(s.table)} SETTINGS use_query_cache = 0`)
      const n = Number(row?.n)
      if (!Number.isFinite(n) || n <= 0) throw new Error(`[search-dictionary] ${shadow(s.table)} is empty after the build; not swapping it in`)
      counts.push(n)
      await client.command({ query: `ALTER TABLE ${shadow(s.table)} MODIFY COMMENT '${comment(n)}'` })
    }
    for (const s of specs) {
      const name = s.table.split('.')[1]
      const [row] = await run(`SELECT count() AS n FROM system.tables WHERE database = 'ulp' AND name = '${name}' SETTINGS use_query_cache = 0`)
      const exists = Number(row?.n) > 0
      await client.command({ query: exists ? `EXCHANGE TABLES ${shadow(s.table)} AND ${s.table}` : `RENAME TABLE ${shadow(s.table)} TO ${s.table}` })
      // after an EXCHANGE the shadow name holds the OLD copy; after a RENAME there is nothing left to drop
      await client.command({ query: `DROP TABLE IF EXISTS ${shadow(s.table)} SYNC` })
    }
  } catch (err) {
    await dropShadows().catch(() => {})
    recordBuildOutcome({ lastError: err instanceof Error ? err.message : String(err) })
    throw err
  }

  const ms = Date.now() - startedAt
  resetSearchDictionaryCache()
  recordBuildOutcome({ lastError: null, lastBuildMs: ms, lastBuiltAt: builtAt })
  log(`built: ${counts[0]} host pairs, ${counts[1]} email domains in ${Math.round(ms / 1000)}s (fingerprint ${live.fingerprint.slice(0, 12)})`)
  return { pairRows: counts[0], emailRows: counts[1], ms, fingerprint: live.fingerprint }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/search-dictionary.test.ts`
Expected: PASS (all tests in the file).

Run: `npx tsc --noEmit`
Expected: no output (no type errors).

- [ ] **Step 5: Commit**

```bash
git add lib/search-dictionary.ts __tests__/search-dictionary.test.ts
git commit -m "feat(search-dictionary): the derived tables, their fingerprint, status and shadow-swap build

Fails closed: the fingerprint (table uuid, partition rows and blocks, content mutations) lives in both tables' comments; the projection mutation that runs daily is excluded, with the parenthesised command text the live server actually reports.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The plan - term, candidate lookup, and the two SQL builders

**Files:**
- Create: `lib/search-dictionary-plan.ts`
- Test: `__tests__/search-dictionary-plan.test.ts`

**Interfaces:**
- Consumes: `parseULPQuery`, `buildULPWhere` (`lib/ulp-search.ts`); `dedupeLimitBy`, `dedupeCountPartial` (`lib/ulp-dedupe.ts`, Task 2); `chStringArrayLiteral`, `chReversedArrayLiteral` (Task 1); `isEmailDomainRevProjectionReady`, `EMAIL_DOMAIN_REV_PROJECTION_NAME` (`lib/credentials-projections.ts`); `getSearchDictionaryStatus`, `searchDictionaryEnabled`, `searchDictMaxDomains`, `searchDictMaxEmailDomains`, `HOST_DICT_TABLE`, `EMAIL_DICT_TABLE`, `Run`, `DictionaryStatus` (Task 3).
- Produces (used by Tasks 5, 8, 9):
  - `interface DictionaryTerm { exact: string; suffix: string; like: string }`
  - `dictionaryTermFromQuery(q: string, regex: boolean): DictionaryTerm | null`
  - `interface DictionaryCandidates { domains: string[]; emailDomains: string[]; empty: boolean; domainsLiteral: string; emailRevLiteral: string }`
  - `interface PlannerDeps { run?: Run; now?: () => number; status?: () => Promise<DictionaryStatus>; projectionReady?: () => Promise<boolean> }`
  - `resolveDictionaryCandidates(term: DictionaryTerm, deps?: PlannerDeps): Promise<DictionaryCandidates | null>` (null = run today's query)
  - `resetDictionaryPlanCache(): void`
  - `interface RowsSqlInput { where: string; cursorClause: string; orderBy: string; dedupe: boolean; dedupeInWindow: boolean; rawCols: string; selectList: string; sortMaxMemoryBytes: number; normColsSetting: string; candidates: DictionaryCandidates }`
  - `buildDictionaryRowsSql(a: RowsSqlInput): string | null` (references the route's `{limit:UInt32}` and, in the window form, `{windowLimit:UInt32}` parameters)
  - `interface TotalsSqlInput { whereRaw: string; dedupe: boolean; hasUserFilter: boolean; onlyIf?: string; candidates: DictionaryCandidates }`
  - `buildDictionaryTotalsSql(a: TotalsSqlInput): string | null`
  - constants `DOMAINS_LITERAL_MAX_BYTES = 90_000`, `EMAIL_LITERAL_MAX_BYTES = 20_000`, `DICTIONARY_SQL_MAX_CHARS = 240_000`

- [ ] **Step 1: Write the failing test**

Create `__tests__/search-dictionary-plan.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  dictionaryTermFromQuery, resolveDictionaryCandidates, resetDictionaryPlanCache, buildDictionaryRowsSql, buildDictionaryTotalsSql,
  DICTIONARY_SQL_MAX_CHARS, type DictionaryCandidates, type DictionaryTerm,
} from '@/lib/search-dictionary-plan'
import { buildULPWhere, parseULPQuery } from '@/lib/ulp-search'
import type { DictionaryStatus } from '@/lib/search-dictionary'

const freshStatus = (fp = 'fp-1'): DictionaryStatus => ({
  state: 'fresh', fingerprint: fp, builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
})
const notFresh = (state: DictionaryStatus['state']): DictionaryStatus => ({ ...freshStatus(), state, fingerprint: null })
const TERM: DictionaryTerm = { exact: 'ledger.com', suffix: '%.ledger.com', like: '%ledger.com%' }

function lookupRun(data: { exact?: string[]; suffix?: string[]; host?: string[]; email?: string[] }) {
  return vi.fn(async (sql: string, _params: Record<string, unknown> = {}) => {
    if (sql.includes('WHERE domain = {exact:String}')) return (data.exact ?? []).map(domain => ({ domain }))
    if (sql.includes('WHERE domain LIKE {suffix:String}')) return (data.suffix ?? []).map(domain => ({ domain }))
    if (sql.includes('WHERE url_host LIKE {like:String}')) return (data.host ?? []).map(domain => ({ domain }))
    if (sql.includes('FROM ulp.search_emaildomain_dict')) return (data.email ?? []).map(email_domain => ({ email_domain }))
    return []
  })
}
const ready = async () => true

beforeEach(() => { resetDictionaryPlanCache() })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('dictionaryTermFromQuery', () => {
  test('one positive domain-shaped term gives the very LIKE patterns the legacy predicate uses', () => {
    expect(dictionaryTermFromQuery('ledger.com', false)).toEqual(TERM)
    expect(dictionaryTermFromQuery('Trezor.IO', false)).toEqual({ exact: 'trezor.io', suffix: '%.trezor.io', like: '%trezor.io%' })
    expect(dictionaryTermFromQuery('my_site.example.com', false)).toEqual({
      exact: 'my_site.example.com', suffix: '%.my\\_site.example.com', like: '%my\\_site.example.com%',
    })
    expect(dictionaryTermFromQuery('192.168.1.1', false)).not.toBeNull()
  })

  test('the patterns are the ones buildULPWhere puts in its parameters, so the two cannot drift apart', () => {
    for (const q of ['ledger.com', 'a-b.c_d.example.org']) {
      const { params } = buildULPWhere(parseULPQuery(q))
      expect(dictionaryTermFromQuery(q, false)).toEqual({ exact: params.dom0, suffix: params.domsuf0, like: params.domlk0 })
    }
  })

  test.each(['ledger', '@ledger.com', 'john@ledger.com', 'ledger.com,trezor.io', '-ledger.com', 'a b.com', '', 'ledger.com/path', 'ledger..com'])(
    'not eligible: %j',
    q => { expect(dictionaryTermFromQuery(q, false)).toBeNull() },
  )

  test('regex mode is never eligible', () => {
    expect(dictionaryTermFromQuery('ledger.com', true)).toBeNull()
  })
})

describe('resolveDictionaryCandidates', () => {
  test('runs the four lookups with the term\'s patterns and a cap one above the limit; sorts and de-duplicates', async () => {
    const run = lookupRun({ exact: ['ledger.com'], suffix: ['app.ledger.com'], host: ['ledger.com', 'coinledger.com'], email: ['ledger.com'] })
    const c = await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })
    expect(run).toHaveBeenCalledTimes(4)
    const params = run.mock.calls.map(call => call[1])
    expect(params).toEqual(expect.arrayContaining([
      { exact: 'ledger.com', cap: 3001 }, { suffix: '%.ledger.com', cap: 3001 }, { like: '%ledger.com%', cap: 3001 }, { like: '%ledger.com%', cap: 301 },
    ]))
    expect(c).toEqual({
      domains: ['app.ledger.com', 'coinledger.com', 'ledger.com'],
      emailDomains: ['ledger.com'],
      empty: false,
      domainsLiteral: "['app.ledger.com','coinledger.com','ledger.com']",
      emailRevLiteral: "['moc.regdel']",
    })
  })

  test('every lookup has a time limit and bypasses the ClickHouse result cache; none can be mistaken for a data or totals query', async () => {
    const run = lookupRun({ exact: ['ledger.com'] })
    await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })
    for (const [sql] of run.mock.calls) {
      expect(sql).toContain('max_execution_time = 8')
      expect(sql).toContain('use_query_cache = 0')
      expect(sql).not.toMatch(/\) AS t\s/)
      expect(sql).not.toMatch(/AS raw_total/)
    }
  })

  test('the email domains are reversed as UTF-8 BYTES, like ClickHouse reverse(); a reversed JavaScript string would miss non-ASCII ones', async () => {
    const run = lookupRun({ email: ['é.com', 'ledger.com'] })
    const c = await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })
    // sorted as JavaScript sorts ('l' is U+006C, 'é' U+00E9), THEN reversed bytewise
    expect(c!.emailRevLiteral).toBe("['moc.regdel','moc.\\xa9\\xc3']")
  })

  test.each(['stale', 'missing', 'building', 'unknown', 'disabled'] as const)('a dictionary that is %s means today\'s query, and no lookup runs', async state => {
    const run = lookupRun({ exact: ['ledger.com'] })
    expect(await resolveDictionaryCandidates(TERM, { run, status: async () => notFresh(state), projectionReady: ready })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  test('switched off by the environment: null, and not even the status is read', async () => {
    vi.stubEnv('SEARCH_DICTIONARY', '0')
    const status = vi.fn(async () => freshStatus())
    expect(await resolveDictionaryCandidates(TERM, { run: lookupRun({}), status, projectionReady: ready })).toBeNull()
    expect(status).not.toHaveBeenCalled()
  })

  test('a repeat of the term reuses the answer; another fingerprint or another term looks again', async () => {
    const run = lookupRun({ exact: ['ledger.com'] })
    const deps = (fp: string) => ({ run, status: async () => freshStatus(fp), projectionReady: ready })
    await resolveDictionaryCandidates(TERM, deps('fp-1'))
    await resolveDictionaryCandidates(TERM, deps('fp-1'))
    expect(run).toHaveBeenCalledTimes(4)
    await resolveDictionaryCandidates(TERM, deps('fp-2'))
    expect(run).toHaveBeenCalledTimes(8)
    await resolveDictionaryCandidates({ exact: 'trezor.io', suffix: '%.trezor.io', like: '%trezor.io%' }, deps('fp-2'))
    expect(run).toHaveBeenCalledTimes(12)
  })

  test('the rows request and the totals request the page sends together share ONE lookup (the in-flight promise)', async () => {
    const run = lookupRun({ exact: ['ledger.com'], email: ['ledger.com'] })
    const deps = { run, status: async () => freshStatus(), projectionReady: ready }
    const [a, b] = await Promise.all([resolveDictionaryCandidates(TERM, deps), resolveDictionaryCandidates(TERM, deps)])
    expect(run).toHaveBeenCalledTimes(4)
    expect(a).toBe(b)
  })

  test('the answer is kept for ten minutes, then looked up again', async () => {
    const run = lookupRun({ exact: ['ledger.com'] })
    let t = 0
    const deps = { run, now: () => t, status: async () => freshStatus(), projectionReady: ready }
    await resolveDictionaryCandidates(TERM, deps)
    t = 599_000
    await resolveDictionaryCandidates(TERM, deps)
    expect(run).toHaveBeenCalledTimes(4)
    t = 601_000
    await resolveDictionaryCandidates(TERM, deps)
    expect(run).toHaveBeenCalledTimes(8)
  })

  test('keeps at most 200 terms', async () => {
    const run = lookupRun({ exact: ['x.com'] })
    const deps = { run, status: async () => freshStatus(), projectionReady: ready }
    for (let i = 0; i < 201; i++) await resolveDictionaryCandidates({ exact: `t${i}.com`, suffix: `%.t${i}.com`, like: `%t${i}.com%` }, deps)
    run.mockClear()
    await resolveDictionaryCandidates({ exact: 't0.com', suffix: '%.t0.com', like: '%t0.com%' }, deps) // the oldest was evicted
    expect(run).toHaveBeenCalledTimes(4)
    run.mockClear()
    await resolveDictionaryCandidates({ exact: 't200.com', suffix: '%.t200.com', like: '%t200.com%' }, deps) // the newest is still there
    expect(run).not.toHaveBeenCalled()
  })

  describe('caps: above any of them the answer is "use today\'s query", and that verdict is remembered too', () => {
    test('more candidate domains than SEARCH_DICT_MAX_DOMAINS (counted over the union of the three lookups)', async () => {
      vi.stubEnv('SEARCH_DICT_MAX_DOMAINS', '2')
      const run = lookupRun({ exact: ['a.com'], suffix: ['b.com'], host: ['c.com'] })
      const deps = { run, status: async () => freshStatus(), projectionReady: ready }
      expect(await resolveDictionaryCandidates(TERM, deps)).toBeNull()
      expect(run.mock.calls.find(c => String(c[0]).includes('{exact:String}'))![1]).toMatchObject({ cap: 3 })
      expect(await resolveDictionaryCandidates(TERM, deps)).toBeNull()
      expect(run).toHaveBeenCalledTimes(4)
    })

    test('more email domains than SEARCH_DICT_MAX_EMAIL_DOMAINS', async () => {
      vi.stubEnv('SEARCH_DICT_MAX_EMAIL_DOMAINS', '1')
      const run = lookupRun({ exact: ['ledger.com'], email: ['a.ledger.com', 'b.ledger.com'] })
      expect(await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })).toBeNull()
    })

    test('a list of D that would not fit the SQL (90,000 bytes) even though the count is under the cap', async () => {
      const long = Array.from({ length: 2000 }, (_, i) => `d${i}.${'x'.repeat(50)}.test`)
      const run = lookupRun({ host: long })
      expect(await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })).toBeNull()
    })

    test('a list of E above 20,000 bytes', async () => {
      const long = Array.from({ length: 290 }, (_, i) => `${'y'.repeat(70)}${i}.ledger.com`) // under the 300 count cap, about 26 KB of literal
      const run = lookupRun({ exact: ['ledger.com'], email: long })
      expect(await resolveDictionaryCandidates(TERM, { run, status: async () => freshStatus(), projectionReady: ready })).toBeNull()
    })
  })

  test('a lookup that fails or times out means today\'s query, with one warning, and is not retried for a minute', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn().mockRejectedValue(new Error('Code: 159. Timeout exceeded: TIMEOUT_EXCEEDED'))
    let t = 0
    const deps = { run, now: () => t, status: async () => freshStatus(), projectionReady: ready }
    expect(await resolveDictionaryCandidates(TERM, deps)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('candidate lookup failed')
    const calls = run.mock.calls.length
    t = 59_000
    expect(await resolveDictionaryCandidates(TERM, deps)).toBeNull()
    expect(run.mock.calls.length).toBe(calls)
    t = 61_000
    await resolveDictionaryCandidates(TERM, deps)
    expect(run.mock.calls.length).toBeGreaterThan(calls)
  })

  test('nothing in either lookup: an empty answer (no row can match), without consulting the projection', async () => {
    const projectionReady = vi.fn(async () => true)
    const c = await resolveDictionaryCandidates(TERM, { run: lookupRun({}), status: async () => freshStatus(), projectionReady })
    expect(c).toMatchObject({ empty: true, domains: [], emailDomains: [], domainsLiteral: '[]', emailRevLiteral: '[]' })
    expect(projectionReady).not.toHaveBeenCalled()
  })

  test('email domains need proj_email_domain_rev on every part; without it, today\'s query. Without email domains the projection does not matter.', async () => {
    const notReady = vi.fn(async () => false)
    expect(await resolveDictionaryCandidates(TERM, { run: lookupRun({ exact: ['ledger.com'], email: ['ledger.com'] }), status: async () => freshStatus(), projectionReady: notReady })).toBeNull()
    expect(notReady).toHaveBeenCalledTimes(1)
    resetDictionaryPlanCache()
    const notReady2 = vi.fn(async () => false)
    const c = await resolveDictionaryCandidates(TERM, { run: lookupRun({ exact: ['ledger.com'] }), status: async () => freshStatus(), projectionReady: notReady2 })
    expect(c).not.toBeNull()
    expect(notReady2).not.toHaveBeenCalled()
  })
})

// ── the SQL ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const cands = (over: Partial<DictionaryCandidates> = {}): DictionaryCandidates => ({
  domains: ['ledger.com', 'app.ledger.com'], emailDomains: ['ledger.com'], empty: false,
  domainsLiteral: "['ledger.com','app.ledger.com']", emailRevLiteral: "['moc.regdel']", ...over,
})
const WHERE = '1=1 AND ((domain = {dom0:String} OR url_host LIKE {domlk0:String})) AND is_noise = 0'
const CURSOR = ' AND (domain, email, imported_at, url, password) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})'
const DOMAIN_ORDER = 'domain ASC,  email ASC, imported_at ASC, url ASC, password ASC'
const EMAIL_ORDER = 'email ASC, domain ASC, imported_at ASC, url ASC, password ASC'
const rowsInput = (over: Record<string, unknown> = {}) => ({
  where: WHERE, cursorClause: CURSOR, orderBy: DOMAIN_ORDER, dedupe: true, dedupeInWindow: false,
  rawCols: 'url, email, password, domain, imported_at', selectList: 'NORMALIZED, url AS _c_url',
  sortMaxMemoryBytes: 4_294_967_296, normColsSetting: 'prefer_column_name_to_alias = 1', candidates: cands(), ...over,
})
const OFFSET = "(_part, _part_offset) IN (SELECT _part, _part_offset FROM ulp.credentials WHERE reverse(email_domain) IN ['moc.regdel'] SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = 'proj_email_domain_rev')"
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

describe('buildDictionaryRowsSql', () => {
  test('two disjoint branches over the UNCHANGED legacy WHERE and keyset clause, merged by the same ORDER BY', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(sql.split(`WHERE ${WHERE}${CURSOR}`).length - 1).toBe(2) // the legacy WHERE and keyset clause, verbatim, in both branches
    expect(sql).toContain(`${CURSOR} AND domain IN ['ledger.com','app.ledger.com']\nORDER BY`)
    expect(sql).toContain(`${CURSOR} AND domain NOT IN ['ledger.com','app.ledger.com'] AND ${OFFSET}\nORDER BY`)
    expect(count(sql, /UNION ALL/g)).toBe(1)
  })

  // ClickHouse 26.3: with a _part_offset filter, lazy materialization fails ("Not found column _part_offset in block") for every sort not
  // led by `domain`; turning it off for THAT branch fixes it. And `optimize_use_projections = 0` there destroys the pruning (9-16 s instead of
  // 0.3-1 s), so the offset sub-select pins projections ON and names the projection.
  test('pins the two ClickHouse 26.3 facts: lazy materialization off on the offset branch only, projections on inside its sub-select', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(count(sql, /query_plan_optimize_lazy_materialization = 0/g)).toBe(1)
    const [branch1, branch2] = sql.split('UNION ALL')
    expect(branch1).not.toContain('query_plan_optimize_lazy_materialization')
    expect(branch2).toContain('LIMIT {limit:UInt32} SETTINGS query_plan_optimize_lazy_materialization = 0')
    expect(sql).toContain("SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = 'proj_email_domain_rev')")
    expect(sql).not.toContain('optimize_use_projections = 0')
  })

  test('a domain-led sort de-duplicates inside each branch, then again in the merge (the first N unique rows of the union lie in the union of the branches\' first N)', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(count(sql, /LIMIT 1 BY content_key_hash/g)).toBe(3)
    expect(count(sql, /LIMIT \{limit:UInt32\}/g)).toBe(3)
    expect(sql).not.toContain('windowLimit')
  })

  test('Unique with a sort not led by domain keeps the legacy window: each branch takes the window, the union is cut to it, then de-duplicated and limited', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ orderBy: EMAIL_ORDER, dedupeInWindow: true }))!
    expect(count(sql, /LIMIT \{windowLimit:UInt32\}/g)).toBe(3) // two branches and the cut of the union
    expect(count(sql, /LIMIT 1 BY content_key_hash/g)).toBe(1)
    expect(sql).toMatch(/LIMIT 1 BY content_key_hash\s+LIMIT \{limit:UInt32\}/)
    expect(sql.indexOf('LIMIT 1 BY')).toBeGreaterThan(sql.lastIndexOf('LIMIT {windowLimit:UInt32}'))
  })

  test('without Unique nothing is de-duplicated anywhere', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ dedupe: false }))!
    expect(sql).not.toContain('LIMIT 1 BY')
  })

  test('only candidate domains (no email domain): one branch, no UNION, no offset sub-select, no NOT IN', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ candidates: cands({ emailDomains: [], emailRevLiteral: '[]' }) }))!
    expect(sql).not.toContain('UNION ALL')
    expect(sql).not.toContain('_part_offset')
    expect(sql).not.toContain('NOT IN')
    expect(sql).not.toContain('lazy_materialization')
    expect(sql).toContain("AND domain IN ['ledger.com','app.ledger.com']")
  })

  test('only email domains (no candidate domain): one branch through the projection, no domain predicate at all', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ candidates: cands({ domains: [], domainsLiteral: '[]' }) }))!
    expect(sql).not.toContain('UNION ALL')
    expect(sql).not.toMatch(/domain (NOT )?IN \[/)
    expect(sql).toContain(OFFSET)
    expect(sql).toContain('lazy_materialization = 0')
  })

  test('the outer select, the sort memory limit and the NORM_COLS setting are the legacy query\'s, and the shape ends like it: `) AS t`', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(sql.startsWith('SELECT NORMALIZED, url AS _c_url\nFROM (')).toBe(true)
    expect(sql).toMatch(/\) AS t\s+SETTINGS max_execution_time = 300,\s+timeout_overflow_mode = 'throw',\s+http_wait_end_of_query = 1,\s+max_bytes_before_external_sort = 4294967296,\s+prefer_column_name_to_alias = 1$/)
  })

  test('the candidate lists are literals; the only placeholders are the route\'s own', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    const names = new Set([...sql.matchAll(/\{(\w+):/g)].map(m => m[1]))
    expect([...names].sort()).toEqual(['c_d', 'c_e', 'c_ia', 'c_pw', 'c_u', 'dom0', 'domlk0', 'limit'].sort())
  })

  test('null when the finished SQL would not fit max_query_size (the caller then runs today\'s query)', () => {
    const huge = `['${'a'.repeat(DICTIONARY_SQL_MAX_CHARS / 2)}']`
    expect(buildDictionaryRowsSql(rowsInput({ candidates: cands({ domainsLiteral: huge }) }))).toBeNull()
  })

  test('null when there is nothing to search (the caller answers an empty page without a query)', () => {
    expect(buildDictionaryRowsSql(rowsInput({ candidates: cands({ domains: [], emailDomains: [], empty: true, domainsLiteral: '[]', emailRevLiteral: '[]' }) }))).toBeNull()
  })
})

const totalsInput = (over: Record<string, unknown> = {}) => ({
  whereRaw: '1=1 AND ((domain = {dom0:String} OR url_host LIKE {domlk0:String}))', dedupe: true, hasUserFilter: true, onlyIf: 'is_noise = 0', candidates: cands(), ...over,
})

describe('buildDictionaryTotalsSql', () => {
  test('one aggregate per branch, combined by merging states, so the number equals the legacy single scan', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toContain('SELECT uniqIfMerge(part_total) AS total, sum(part_rows) AS raw_total')
    expect(count(sql, /uniqIfState\(content_key_hash, is_noise = 0\) AS part_total, count\(\) AS part_rows/g)).toBe(2)
    expect(count(sql, /UNION ALL/g)).toBe(1)
    expect(sql).toContain("AND domain IN ['ledger.com','app.ledger.com']")
    expect(sql).toContain(`AND domain NOT IN ['ledger.com','app.ledger.com'] AND ${OFFSET}`)
  })

  test('the branches use the raw WHERE: no cursor, and the noise filter moved inside the aggregate', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).not.toContain('{c_d') // no keyset clause
    const firstWhere = sql.slice(sql.indexOf('WHERE'), sql.indexOf('UNION ALL'))
    expect(firstWhere).not.toContain('is_noise') // the Declutter condition is inside the aggregate (uniqIfState), not in the WHERE
    expect(count(sql, /WHERE 1=1 AND/g)).toBe(2)
  })

  test.each([
    [{ dedupe: true, onlyIf: undefined }, 'uniqMerge(part_total) AS total', 'uniqState(content_key_hash) AS part_total'],
    [{ dedupe: false, onlyIf: 'is_noise = 0' }, 'sum(part_total) AS total', 'countIf(is_noise = 0) AS part_total'],
    [{ dedupe: false, onlyIf: undefined }, 'sum(part_total) AS total', 'count() AS part_total'],
  ])('%j', (over, outer, inner) => {
    const sql = buildDictionaryTotalsSql(totalsInput(over))!
    expect(sql).toContain(outer)
    expect(sql).toContain(inner)
  })

  test('keeps the counts\' own settings (partial counts on a timeout, no result cache) and the offset-branch settings', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toMatch(/SETTINGS optimize_trivial_count_query = 1,\s+max_execution_time = 300,\s+timeout_overflow_mode = 'break',\s+use_query_cache = 0$/)
    expect(sql).not.toContain('LIMIT')
    expect(count(sql, /query_plan_optimize_lazy_materialization = 0/g)).toBe(1)
    expect(sql).not.toContain('optimize_use_projections = 0')
  })

  test('is recognised by the older route tests as a totals query, and never as a data query', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toMatch(/AS raw_total/)
    expect(sql).not.toMatch(/\) AS t\s/)
  })

  test('single-branch forms like the rows query; null when oversize or empty', () => {
    expect(buildDictionaryTotalsSql(totalsInput({ candidates: cands({ emailDomains: [], emailRevLiteral: '[]' }) }))).not.toContain('UNION ALL')
    expect(buildDictionaryTotalsSql(totalsInput({ candidates: cands({ domainsLiteral: `['${'a'.repeat(DICTIONARY_SQL_MAX_CHARS)}']` }) }))).toBeNull()
    expect(buildDictionaryTotalsSql(totalsInput({ candidates: cands({ domains: [], emailDomains: [], empty: true }) }))).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/search-dictionary-plan.test.ts`
Expected: FAIL, "Failed to resolve import "@/lib/search-dictionary-plan"".

- [ ] **Step 3: Write the implementation**

Create `lib/search-dictionary-plan.ts`:

```ts
/**
 * The domain search plan (design: docs/superpowers/specs/2026-10-03-domain-search-dictionary-design.md).
 *
 * A search for ONE positive, domain-shaped term is `P = A or B or C` in the legacy predicate (lib/ulp-search.ts):
 *   A: domain = x OR domain LIKE '%.x'      B: url_host LIKE '%x%'      C: email_domain LIKE '%x%'
 * and ClickHouse cannot prune it once two substring branches sit in the OR. From the dictionaries (lib/search-dictionary.ts) it takes
 *   D = every `domain` of a row satisfying A or B      E = every `email_domain` containing x
 * and the route keeps its legacy WHERE and keyset clause VERBATIM and ANDs a redundant, prunable conjunct onto two disjoint branches:
 *   branch 1: P AND domain IN D                               (primary key on `domain`)
 *   branch 2: P AND domain NOT IN D AND (_part, _part_offset) IN (rows of E through proj_email_domain_rev)
 * Only C can be true outside D, and those rows are exactly what branch 2 reads. Because the legacy predicate stays in every query, an
 * over-inclusive candidate set can only cost time; a wrong row is impossible, and the dictionary's freshness guard exists so that the
 * candidate set is never too SMALL.
 *
 * Two ClickHouse 26.3 facts found by testing (each pinned by a test):
 *  - with a `_part_offset` filter, lazy materialization breaks ("Not found column _part_offset in block") for every sort not led by `domain`
 *    once more than the sort-key columns are selected; `query_plan_optimize_lazy_materialization = 0` on THAT branch fixes it;
 *  - `optimize_use_projections = 0` around the offset sub-select destroys its pruning (9-16 s instead of 0.3-1 s), so the sub-select pins
 *    projections on and names the projection.
 *
 * The candidate lists are written into the SQL as literals (lib/clickhouse-literals.ts): a URL parameter above 128 KiB is refused by
 * ClickHouse and the body limit is max_query_size (256 KiB), so the lists are capped by count AND by bytes.
 */
import { executeQuery } from '@/lib/clickhouse'
import { parseULPQuery, buildULPWhere } from '@/lib/ulp-search'
import { dedupeLimitBy, dedupeCountPartial } from '@/lib/ulp-dedupe'
import { chStringArrayLiteral, chReversedArrayLiteral } from '@/lib/clickhouse-literals'
import { isEmailDomainRevProjectionReady, EMAIL_DOMAIN_REV_PROJECTION_NAME } from '@/lib/credentials-projections'
import {
  getSearchDictionaryStatus, searchDictionaryEnabled, searchDictMaxDomains, searchDictMaxEmailDomains, HOST_DICT_TABLE, EMAIL_DICT_TABLE,
  type DictionaryStatus, type Run,
} from '@/lib/search-dictionary'

export const DOMAINS_LITERAL_MAX_BYTES = 90_000
export const EMAIL_LITERAL_MAX_BYTES = 20_000
/** max_query_size is 262,144 and D appears twice in a query; this leaves room for the rest of the SQL. */
export const DICTIONARY_SQL_MAX_CHARS = 240_000

const LOOKUP_TIMEOUT_SECONDS = 8
const VERDICT_TTL_MS = 600_000
const FAILURE_TTL_MS = 60_000
const CACHE_MAX_TERMS = 200
const PROJECTION_READY_TTL_MS = 60_000

// ── the term ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DictionaryTerm {
  /** The lowercased term: `domain = exact`. */
  exact: string
  /** `domain LIKE suffix`, i.e. `%.term`, with `_` escaped as the legacy predicate does. */
  suffix: string
  /** `url_host LIKE like` and `email_domain LIKE like`, i.e. `%term%`. */
  like: string
}

/**
 * The term, when the whole search is exactly one positive, non-regex, domain-shaped term; null for everything else (single word, @email, several
 * terms, negation, regex), which keeps today's query. The patterns come out of buildULPWhere's own parameters so they cannot drift from it.
 */
export function dictionaryTermFromQuery(q: string, regex: boolean): DictionaryTerm | null {
  if (regex) return null
  const tokens = parseULPQuery(q)
  if (tokens.length !== 1) return null
  const [token] = tokens
  if (token.type !== 'domain' || token.negate) return null
  const { params } = buildULPWhere(tokens)
  const { dom0, domsuf0, domlk0 } = params
  if (typeof dom0 !== 'string' || typeof domsuf0 !== 'string' || typeof domlk0 !== 'string') return null
  return { exact: dom0, suffix: domsuf0, like: domlk0 }
}

// ── the candidates ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DictionaryCandidates {
  /** D: sorted, de-duplicated. */
  domains: string[]
  /** E: sorted. */
  emailDomains: string[]
  /** Neither D nor E has a value: no row can match. */
  empty: boolean
  /** D as a ClickHouse array literal, ready to inline. */
  domainsLiteral: string
  /** reverse(E), bytewise, as an array literal: the key of proj_email_domain_rev. */
  emailRevLiteral: string
}

export interface PlannerDeps {
  run?: Run
  now?: () => number
  status?: () => Promise<DictionaryStatus>
  projectionReady?: () => Promise<boolean>
}

const LOOKUP_SETTINGS = `SETTINGS use_query_cache = 0, max_execution_time = ${LOOKUP_TIMEOUT_SECONDS}`
const SQL_BY_EXACT = `SELECT domain FROM ${HOST_DICT_TABLE} WHERE domain = {exact:String} GROUP BY domain LIMIT {cap:UInt32} ${LOOKUP_SETTINGS}`
const SQL_BY_SUFFIX = `SELECT domain FROM ${HOST_DICT_TABLE} WHERE domain LIKE {suffix:String} GROUP BY domain LIMIT {cap:UInt32} ${LOOKUP_SETTINGS}`
const SQL_BY_HOST = `SELECT domain FROM ${HOST_DICT_TABLE} WHERE url_host LIKE {like:String} GROUP BY domain LIMIT {cap:UInt32} ${LOOKUP_SETTINGS}`
const SQL_BY_EMAIL = `SELECT email_domain FROM ${EMAIL_DICT_TABLE} WHERE email_domain LIKE {like:String} LIMIT {cap:UInt32} ${LOOKUP_SETTINGS}`

interface CacheEntry { at: number; ttl: number; value: Promise<DictionaryCandidates | null> }
const cache = new Map<string, CacheEntry>()
let projectionCache: { at: number; value: boolean } | null = null

export function resetDictionaryPlanCache(): void {
  cache.clear()
  projectionCache = null
}

async function projectionIsReady(run: Run, now: () => number): Promise<boolean> {
  const t = now()
  if (projectionCache && t - projectionCache.at < PROJECTION_READY_TTL_MS) return projectionCache.value
  const value = await isEmailDomainRevProjectionReady(sql => run(sql) as Promise<Array<{ parts?: unknown; with_projection?: unknown }>>)
  projectionCache = { at: t, value }
  return value
}

async function lookupCandidates(term: DictionaryTerm, run: Run, deps: PlannerDeps, now: () => number): Promise<DictionaryCandidates | null> {
  const maxDomains = searchDictMaxDomains()
  const maxEmail = searchDictMaxEmailDomains()
  // one above each cap, so "over the cap" is visible without reading the whole answer
  const [exact, suffix, host, email] = await Promise.all([
    run(SQL_BY_EXACT, { exact: term.exact, cap: maxDomains + 1 }),
    run(SQL_BY_SUFFIX, { suffix: term.suffix, cap: maxDomains + 1 }),
    run(SQL_BY_HOST, { like: term.like, cap: maxDomains + 1 }),
    run(SQL_BY_EMAIL, { like: term.like, cap: maxEmail + 1 }),
  ])
  const domains = [...new Set([...exact, ...suffix, ...host].map(r => String(r.domain)))].sort()
  const emailDomains = email.map(r => String(r.email_domain)).sort()
  if (domains.length > maxDomains || emailDomains.length > maxEmail) return null

  const domainsLiteral = chStringArrayLiteral(domains)
  const emailRevLiteral = chReversedArrayLiteral(emailDomains)
  if (Buffer.byteLength(domainsLiteral, 'utf8') > DOMAINS_LITERAL_MAX_BYTES || Buffer.byteLength(emailRevLiteral, 'utf8') > EMAIL_LITERAL_MAX_BYTES) return null

  if (emailDomains.length > 0 && !(await (deps.projectionReady ?? (() => projectionIsReady(run, now)))())) return null
  return { domains, emailDomains, empty: domains.length === 0 && emailDomains.length === 0, domainsLiteral, emailRevLiteral }
}

/**
 * The candidates for a term, or null when today's query should run (feature off, dictionary not fresh, a cap exceeded, the projection missing,
 * the lookup failed). Cached per (dictionary fingerprint, term) for ten minutes, a failure for one; concurrent callers share the one lookup.
 */
export async function resolveDictionaryCandidates(term: DictionaryTerm, deps: PlannerDeps = {}): Promise<DictionaryCandidates | null> {
  if (!searchDictionaryEnabled()) return null
  const run: Run = deps.run ?? executeQuery
  const now = deps.now ?? Date.now
  const status = await (deps.status ?? (() => getSearchDictionaryStatus(run)))()
  if (status.state !== 'fresh' || !status.fingerprint) return null

  const key = `${status.fingerprint}\u0000${term.exact}`
  const t = now()
  const hit = cache.get(key)
  if (hit && t - hit.at < hit.ttl) return hit.value

  const entry: CacheEntry = { at: t, ttl: VERDICT_TTL_MS, value: Promise.resolve(null) }
  entry.value = lookupCandidates(term, run, deps, now).catch((err: unknown) => {
    entry.ttl = FAILURE_TTL_MS
    console.warn('[search-dictionary] candidate lookup failed -- using the plain query:', err instanceof Error ? err.message : String(err))
    return null
  })
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CACHE_MAX_TERMS) cache.delete(cache.keys().next().value as string)
  return entry.value
}

// ── the SQL ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function offsetFilter(c: DictionaryCandidates): string {
  return `(_part, _part_offset) IN (SELECT _part, _part_offset FROM ulp.credentials WHERE reverse(email_domain) IN ${c.emailRevLiteral} `
    + `SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = '${EMAIL_DOMAIN_REV_PROJECTION_NAME}')`
}

interface Branch {
  /** ANDed onto the route's WHERE. */
  conjunct: string
  /** Appended to the branch's SELECT. */
  settings: string
}

function branchesFor(c: DictionaryCandidates): Branch[] {
  const out: Branch[] = []
  const hasDomains = c.domains.length > 0
  if (hasDomains) out.push({ conjunct: ` AND domain IN ${c.domainsLiteral}`, settings: '' })
  if (c.emailDomains.length > 0) {
    out.push({
      conjunct: `${hasDomains ? ` AND domain NOT IN ${c.domainsLiteral}` : ''} AND ${offsetFilter(c)}`,
      settings: ' SETTINGS query_plan_optimize_lazy_materialization = 0',
    })
  }
  return out
}

const union = (selects: string[]): string => (selects.length === 1 ? selects[0] : selects.map(s => `(${s})`).join('\nUNION ALL\n'))

export interface RowsSqlInput {
  /** The route's `where`: search predicate, filters, Declutter, tier and login type. Used verbatim. */
  where: string
  /** The route's keyset clause (`' AND ...'`) or ''. Used verbatim. */
  cursorClause: string
  orderBy: string
  dedupe: boolean
  /** Unique with a sort not led by `domain`: de-duplicate inside a bounded window (the route's DEDUPE_WINDOW_FACTOR). */
  dedupeInWindow: boolean
  rawCols: string
  selectList: string
  sortMaxMemoryBytes: number
  normColsSetting: string
  candidates: DictionaryCandidates
}

/**
 * The route's data query, answered from the candidates. Same rows, same order: each branch is the legacy inner SELECT with one more
 * conjunct, the merge re-applies the ORDER BY, the de-duplication and the LIMIT. Null when there is nothing to search (the caller answers
 * an empty page) or the SQL would not fit max_query_size (the caller runs today's query). References {limit:UInt32} and, in the window form,
 * {windowLimit:UInt32}, which the route already binds.
 */
export function buildDictionaryRowsSql(a: RowsSqlInput): string | null {
  const branches = branchesFor(a.candidates)
  if (branches.length === 0) return null
  const branchLimit = a.dedupeInWindow ? '{windowLimit:UInt32}' : '{limit:UInt32}'
  const branchDedupe = a.dedupeInWindow ? '' : dedupeLimitBy(a.dedupe)
  const select = (b: Branch) => `SELECT ${a.rawCols}, content_key_hash
FROM ulp.credentials
WHERE ${a.where}${a.cursorClause}${b.conjunct}
ORDER BY ${a.orderBy}
${branchDedupe}
LIMIT ${branchLimit}${b.settings}`
  const merged = union(branches.map(select))
  const settings = `SETTINGS max_execution_time = 300,
         timeout_overflow_mode = 'throw',
         http_wait_end_of_query = 1,
         max_bytes_before_external_sort = ${a.sortMaxMemoryBytes},
         ${a.normColsSetting}`
  const sql = a.dedupeInWindow
    ? `SELECT ${a.selectList}
FROM (
  SELECT ${a.rawCols}
  FROM (
    SELECT ${a.rawCols}, content_key_hash
    FROM (${merged})
    ORDER BY ${a.orderBy}
    LIMIT {windowLimit:UInt32}
  )
  ORDER BY ${a.orderBy}
  ${dedupeLimitBy(true)}
  LIMIT {limit:UInt32}
) AS t
${settings}`
    : `SELECT ${a.selectList}
FROM (
  SELECT ${a.rawCols}
  FROM (${merged})
  ORDER BY ${a.orderBy}
  ${dedupeLimitBy(a.dedupe)}
  LIMIT {limit:UInt32}
) AS t
${settings}`
  return sql.length <= DICTIONARY_SQL_MAX_CHARS ? sql : null
}

export interface TotalsSqlInput {
  /** The route's `whereRaw`: the search without the Declutter condition and without the cursor. Used verbatim. */
  whereRaw: string
  dedupe: boolean
  hasUserFilter: boolean
  /** The Declutter condition (`is_noise = 0`) when it is on: it lives inside the aggregate, as in the legacy totals. */
  onlyIf?: string
  candidates: DictionaryCandidates
}

/**
 * The route's totals query (`total` and `raw_total` in one pass), one aggregate per disjoint branch, combined by merging aggregate states
 * (lib/ulp-dedupe.ts dedupeCountPartial) so the number equals the legacy single scan's. Null as buildDictionaryRowsSql.
 */
export function buildDictionaryTotalsSql(a: TotalsSqlInput): string | null {
  const branches = branchesFor(a.candidates)
  if (branches.length === 0) return null
  const { partial, combine } = dedupeCountPartial(a.dedupe, a.hasUserFilter, a.onlyIf)
  const select = (b: Branch) => `SELECT ${partial} AS part_total, count() AS part_rows
FROM ulp.credentials
WHERE ${a.whereRaw}${b.conjunct}${b.settings}`
  const sql = `SELECT ${combine('part_total')} AS total, sum(part_rows) AS raw_total
FROM (${union(branches.map(select))})
SETTINGS optimize_trivial_count_query = 1,
         max_execution_time = 300,
         timeout_overflow_mode = 'break',
         use_query_cache = 0`
  return sql.length <= DICTIONARY_SQL_MAX_CHARS ? sql : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/search-dictionary-plan.test.ts`
Expected: PASS (all tests in the file).

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/search-dictionary-plan.ts __tests__/search-dictionary-plan.test.ts
git commit -m "feat(search-dictionary): the plan - term, cached candidate lookup with caps, rows and totals SQL

Branches only AND redundant conjuncts onto the legacy WHERE, so a wrong row is impossible; candidate lists are inlined and capped by count and bytes; totals merge uniq states.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Use the plan in `GET /api/credentials`

**Files:**
- Modify: `app/api/credentials/route.ts`
- Test: `__tests__/credentials-route-dictionary.test.ts` (create)

**Interfaces:**
- Consumes: `dictionaryTermFromQuery`, `resolveDictionaryCandidates`, `buildDictionaryRowsSql`, `buildDictionaryTotalsSql`, `DictionaryCandidates` (Task 4).
- Produces: unchanged API contract plus `plan: 'dictionary'` on a rows response the plan answered, `plan: 'dictionary' | 'plain'` on a `totals_only` response, and `?dictionary=0` to force today's query for one request.

- [ ] **Step 1: Write the failing test**

Create `__tests__/credentials-route-dictionary.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

type Call = { sql: string; params: Record<string, unknown> }
const calls: Call[] = []
let dataRows: Array<Record<string, unknown>> = []
let dictDataError: Error | null = null
let legacyDataError: Error | null = null
let dictTotalsError: Error | null = null
let totalsRow: Record<string, unknown> = { total: '11', raw_total: '12' }
let hostDomains: string[] = ['ledger.com', 'app.ledger.com']
let emailDomains: string[] = ['ledger.com']
let windowsReadiness: Array<Record<string, unknown>> = [{ defined: 0, parts: 1, with_projection: 0 }] // newest-first windows NOT ready: the plain/dictionary path answers
const fresh = (fp = 'fp-1') => ({
  state: 'fresh', fingerprint: fp, builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100, lastError: null, lastBuildMs: null,
})
let dictStatus: Record<string, unknown> = fresh()

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params })
    if (/FROM ulp\.search_host_dict/.test(sql)) return hostDomains.map(domain => ({ domain }))
    if (/FROM ulp\.search_emaildomain_dict/.test(sql)) return emailDomains.map(email_domain => ({ email_domain }))
    if (/system\.projections/.test(sql)) return windowsReadiness
    if (/AS raw_total/.test(sql)) {
      if (/part_total/.test(sql) && dictTotalsError) throw dictTotalsError
      return [totalsRow]
    }
    if (/\) AS t\s/.test(sql)) {
      const err = /domain IN \[/.test(sql) ? dictDataError : legacyDataError
      if (err) throw err
      return dataRows
    }
    return []
  }),
}))
vi.mock('@/lib/search-dictionary', async () => {
  const actual = await vi.importActual<typeof import('@/lib/search-dictionary')>('@/lib/search-dictionary')
  return { ...actual, getSearchDictionaryStatus: vi.fn(async () => dictStatus) }
})
vi.mock('@/lib/credentials-projections', async () => {
  const actual = await vi.importActual<typeof import('@/lib/credentials-projections')>('@/lib/credentials-projections')
  return { ...actual, isEmailDomainRevProjectionReady: vi.fn(async () => true) }
})

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/credentials/route'
import { encodeCursor } from '@/lib/cursor-pagination'
import { resetDictionaryPlanCache } from '@/lib/search-dictionary-plan'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'
import { getSearchDictionaryStatus } from '@/lib/search-dictionary'

const row = (n: number) => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`,
  _c_url: `https://s${n}.example/login`, _c_email: `u${n}@mail.test`, _c_password: `pw${n}`, _c_domain: `s${n}.example`,
  imported_at: '2026-08-28 23:34:14', password_length: 4,
})
const isLookup = (c: Call) => /FROM ulp\.search_(host|emaildomain)_dict/.test(c.sql)
const dictRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && /domain IN \[/.test(c.sql))
const plainRows = () => calls.filter(c => /\) AS t\s/.test(c.sql) && !/domain IN \[/.test(c.sql))
const dictTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && /part_total/.test(c.sql))
const plainTotals = () => calls.filter(c => /AS raw_total/.test(c.sql) && !/part_total/.test(c.sql))
const get = (qs: string) => GET(new NextRequest(`http://localhost/api/credentials?${qs}`))

beforeEach(() => {
  calls.length = 0
  dataRows = [row(1), row(2)]
  dictDataError = legacyDataError = dictTotalsError = null
  totalsRow = { total: '11', raw_total: '12' }
  hostDomains = ['ledger.com', 'app.ledger.com']
  emailDomains = ['ledger.com']
  windowsReadiness = [{ defined: 0, parts: 1, with_projection: 0 }]
  dictStatus = fresh()
  resetDictionaryPlanCache()
  resetNewestFirstReadyCache()
  vi.mocked(getSearchDictionaryStatus).mockClear()
})

describe('GET /api/credentials — a domain search answered from the dictionary', () => {
  test('the page\'s rows request and totals request are both answered by the plan and share ONE lookup', async () => {
    const [rowsRes, totalsRes] = await Promise.all([
      get('q=ledger.com&skip_totals=1&exclude_noise=1&dedupe=1'),
      get('q=ledger.com&totals_only=1&exclude_noise=1&dedupe=1'),
    ])
    const rowsBody = await rowsRes.json()
    const totalsBody = await totalsRes.json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'dictionary' })
    expect(rowsBody.results).toHaveLength(2)
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'dictionary' })
    expect(calls.filter(isLookup)).toHaveLength(4)
    expect(dictRows()).toHaveLength(1)
    expect(dictTotals()).toHaveLength(1)
    expect(plainRows()).toHaveLength(0)
    expect(plainTotals()).toHaveLength(0)
  })

  test('the rows SQL keeps the legacy predicate, filters and parameters and adds the candidates', async () => {
    await get('q=ledger.com&skip_totals=1&dedupe=1&exclude_noise=1&limit=50')
    const { sql, params } = dictRows()[0]
    expect(sql).toContain('domain = {dom0:String}') // the legacy predicate is still there
    expect(sql).toContain('url_host LIKE {domlk0:String}')
    expect(sql).toContain("AND domain IN ['app.ledger.com','ledger.com']")
    expect(sql).toContain("AND domain NOT IN ['app.ledger.com','ledger.com']")
    expect(sql).toContain('is_noise = 0')
    expect(sql).toContain('ORDER BY domain ASC')
    expect(params).toMatchObject({ dom0: 'ledger.com', limit: 50 })
    expect(params).not.toHaveProperty('windowLimit')
  })

  test('Unique with a sort not led by domain uses the window form and binds windowLimit like the legacy query', async () => {
    await get('q=ledger.com&skip_totals=1&dedupe=1&sort=email_asc&limit=50')
    const { sql, params } = dictRows()[0]
    expect(sql).toContain('LIMIT {windowLimit:UInt32}')
    expect(params).toMatchObject({ limit: 50, windowLimit: 150 })
  })

  test('a cursor page puts the keyset clause in both branches and does not look the term up again', async () => {
    await get('q=ledger.com&sort=domain_asc&skip_totals=1&limit=2')
    const cursor = encodeCursor('domain_asc', row(2))
    calls.length = 0
    await get(`q=ledger.com&sort=domain_asc&limit=2&cursor=${encodeURIComponent(cursor)}`)
    const { sql, params } = dictRows()[0]
    expect(sql.split('(domain, email, imported_at, url, password) > ({c_d:String}').length - 1).toBe(2)
    expect(params).toMatchObject({ c_d: 's2.example', c_e: 'u2@mail.test' })
    expect(calls.filter(isLookup)).toHaveLength(0) // the verdict for this term is remembered
    expect(dictTotals()).toHaveLength(0) // a cursor page has no totals
  })

  test('the totals merge aggregate states for Unique and sum counts otherwise; they ignore the cursor and carry no noise filter in the WHERE', async () => {
    await get('q=ledger.com&totals_only=1&exclude_noise=1&dedupe=1')
    expect(dictTotals()[0].sql).toContain('uniqIfMerge(part_total) AS total')
    calls.length = 0
    await get('q=ledger.com&totals_only=1')
    expect(dictTotals()[0].sql).toContain('sum(part_total) AS total')
    expect(dictTotals()[0].sql).toContain('count() AS part_total')
  })

  test('both lists empty: an empty page and zero totals without touching the table', async () => {
    hostDomains = []
    emailDomains = []
    const rowsBody = await (await get('q=ledger.com&skip_totals=1')).json()
    const totalsBody = await (await get('q=ledger.com&totals_only=1')).json()
    expect(rowsBody).toMatchObject({ success: true, results: [], plan: 'dictionary', next_cursor: null })
    expect(totalsBody).toMatchObject({ success: true, total: 0, raw_total: 0, plan: 'dictionary' })
    expect(dictRows()).toHaveLength(0)
    expect(plainRows()).toHaveLength(0)
    expect(dictTotals()).toHaveLength(0)
    expect(plainTotals()).toHaveLength(0)
  })

  test('"Newest first" without the projection windows falls to the plan instead of the full scan', async () => {
    const body = await (await get('q=ledger.com&skip_totals=1&sort=imported_desc&limit=2')).json()
    expect(body.plan).toBe('dictionary')
    expect(plainRows()).toHaveLength(0)
  })
})

describe('GET /api/credentials — everything else is today\'s query, untouched', () => {
  test('dictionary=0 forces the plain query for one request; the dictionary is not even consulted', async () => {
    const [rowsBody, totalsBody] = await Promise.all([
      get('q=ledger.com&skip_totals=1&dictionary=0').then(r => r.json()),
      get('q=ledger.com&totals_only=1&dictionary=0').then(r => r.json()),
    ])
    expect(rowsBody.plan).toBe('plain')
    expect(totalsBody).toMatchObject({ total: 11, raw_total: 12, plan: 'plain' })
    expect(getSearchDictionaryStatus).not.toHaveBeenCalled()
    expect(calls.filter(isLookup)).toHaveLength(0)
    expect(dictRows()).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
    expect(plainTotals()).toHaveLength(1)
  })

  test.each([
    ['regex mode', 'q=ledger.com&regex=1'],
    ['a single word', 'q=ledger'],
    ['two terms', 'q=ledger.com,trezor.io'],
    ['an @domain', 'q=@ledger.com'],
    ['a negated term', 'q=-ledger.com'],
    ['no search', 'exclude_noise=1'],
  ])('%s never touches the dictionary', async (_name, qs) => {
    await get(`${qs}&skip_totals=1`)
    expect(getSearchDictionaryStatus).not.toHaveBeenCalled()
    expect(calls.filter(isLookup)).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test.each(['stale', 'missing', 'building', 'unknown', 'disabled'])('a dictionary that is %s: the plain query answers and no lookup runs', async state => {
    dictStatus = { ...fresh(), state, fingerprint: null }
    const body = await (await get('q=ledger.com&skip_totals=1')).json()
    expect(body.plan).toBe('plain')
    expect(calls.filter(isLookup)).toHaveLength(0)
    expect(plainRows()).toHaveLength(1)
  })

  test('a plan query that fails for any reason but a timeout falls back to the plain query, rows and totals alike', async () => {
    dictDataError = new Error('Code: 241. DB::Exception: MEMORY_LIMIT_EXCEEDED')
    dictTotalsError = new Error('Code: 47. DB::Exception: Not found column _part_offset in block')
    const rowsBody = await (await get('q=ledger.com&skip_totals=1')).json()
    expect(rowsBody).toMatchObject({ success: true, plan: 'plain' })
    expect(rowsBody.results).toHaveLength(2)
    expect(plainRows()).toHaveLength(1)
    const totalsBody = await (await get('q=ledger.com&totals_only=1')).json()
    expect(totalsBody).toMatchObject({ success: true, total: 11, raw_total: 12, plan: 'plain' })
    expect(plainTotals()).toHaveLength(1)
  })

  test('a timeout inside the plan is the same 408 the plain query gives, and is not retried as a second full-length query', async () => {
    dictDataError = new Error('Code: 159. DB::Exception: Timeout exceeded: TIMEOUT_EXCEEDED')
    const res = await get('q=ledger.com&skip_totals=1')
    expect(res.status).toBe(408)
    expect((await res.json()).timed_out).toBe(true)
    expect(plainRows()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/credentials-route-dictionary.test.ts`
Expected: FAIL. The first test sees `plan: 'plain'` (the route does not use the plan yet) and no lookups.

- [ ] **Step 3: Edit the route**

All edits are in `app/api/credentials/route.ts`.

3a. Imports. Replace

```ts
import { runNewestFirst, dedupeRows } from "@/lib/newest-first"
```

with

```ts
import { runNewestFirst, dedupeRows } from "@/lib/newest-first"
import {
  dictionaryTermFromQuery, resolveDictionaryCandidates, buildDictionaryRowsSql, buildDictionaryTotalsSql, type DictionaryCandidates,
} from "@/lib/search-dictionary-plan"
```

3b. The parameter list in the doc comment. Replace

```ts
 *   totals_only   '1'       totals only (no rows): { total, raw_total, query_ms, timed_out }
 */
```

with

```ts
 *   totals_only   '1'       totals only (no rows): { total, raw_total, query_ms, timed_out, plan }
 *   dictionary    '0'       run the plain query even when the domain search dictionary could answer (parity tests, scripts)
 */
```

3c. The term and its memo. Replace

```ts
  const allParams = { ...params, ...cursorParams }

  try {
    const t0 = Date.now()
```

with

```ts
  const allParams = { ...params, ...cursorParams }

  // Domain search dictionary (lib/search-dictionary-plan.ts): a search for exactly one domain-shaped term is answered from two small derived
  // tables (the same rows, order, cursors and totals, 2-4 s instead of 15-19 s). null = this request keeps today's query. The rows request and the
  // totals request the page sends together share one lookup.
  const dictionaryTerm = sp.get('dictionary') === '0' ? null : dictionaryTermFromQuery(q.trim(), regex)
  let candidatesMemo: Promise<DictionaryCandidates | null> | null = null
  const getCandidates = (): Promise<DictionaryCandidates | null> => {
    if (!dictionaryTerm) return Promise.resolve(null)
    return (candidatesMemo ??= resolveDictionaryCandidates(dictionaryTerm))
  }

  try {
    const t0 = Date.now()
```

3d. The totals. Replace the whole `const totalsPromise ... executeQuery(...)` statement

```ts
    const totalsPromise: Promise<Array<{ total?: unknown; raw_total?: unknown }> | null> = !wantTotals
      ? Promise.resolve(null)
      : executeQuery(
          `SELECT ${dedupeCountExpr(dedupe, hasUserFilter, excludeNoise ? NOISE_FILTER : undefined)} AS total,
                  count() AS raw_total
           FROM ulp.credentials WHERE ${whereRaw}
           SETTINGS optimize_trivial_count_query = 1,
                    max_execution_time = 300,
                    timeout_overflow_mode = 'break',
                    use_query_cache = 0${dateFrom || dateTo ? '' : ',\n                    optimize_use_projections = 0'}`,
          params
        )
```

with

```ts
    type TotalsRows = Array<{ total?: unknown; raw_total?: unknown }>
    const runPlainTotals = (): Promise<TotalsRows> => executeQuery(
          `SELECT ${dedupeCountExpr(dedupe, hasUserFilter, excludeNoise ? NOISE_FILTER : undefined)} AS total,
                  count() AS raw_total
           FROM ulp.credentials WHERE ${whereRaw}
           SETTINGS optimize_trivial_count_query = 1,
                    max_execution_time = 300,
                    timeout_overflow_mode = 'break',
                    use_query_cache = 0${dateFrom || dateTo ? '' : ',\n                    optimize_use_projections = 0'}`,
          params
        )
    // The same two numbers from the dictionary's candidates: one aggregate per disjoint branch, merged as aggregate states so the figure equals the
    // single scan's. Any failure falls back to the plain count (which breaks on a timeout instead of throwing, so there is nothing to re-raise).
    let totalsPlan: 'dictionary' | 'plain' = 'plain'
    const runTotals = async (): Promise<TotalsRows> => {
      const candidates = await getCandidates()
      if (candidates) {
        if (candidates.empty) { totalsPlan = 'dictionary'; return [{ total: 0, raw_total: 0 }] }
        const sql = buildDictionaryTotalsSql({ whereRaw, dedupe, hasUserFilter, onlyIf: excludeNoise ? NOISE_FILTER : undefined, candidates })
        if (sql) {
          try {
            const answered: TotalsRows = await executeQuery(sql, params)
            totalsPlan = 'dictionary'
            return answered
          } catch (err) {
            console.warn('[credentials] dictionary totals failed -- using the plain count:', err instanceof Error ? err.message : String(err))
          }
        }
      }
      return runPlainTotals()
    }
    const totalsPromise: Promise<TotalsRows | null> = !wantTotals ? Promise.resolve(null) : runTotals()
```

3e. The data path. Replace

```ts
    let plan: 'windows' | 'plain' = 'plain'
    const runNewestFirstData = async (): Promise<unknown[]> => {
```

with

```ts
    let plan: 'windows' | 'plain' | 'dictionary' = 'plain'

    // The rows from the dictionary's candidates (lib/search-dictionary-plan.ts), or the plain query when the term is not eligible, the dictionary is
    // not fresh, a cap is exceeded, or the plan fails for any reason but a timeout. A timeout is not retried: the plain query would take at least as long.
    const runDataQuery = async (): Promise<unknown[]> => {
      const candidates = await getCandidates()
      if (candidates) {
        if (candidates.empty) { plan = 'dictionary'; return [] }
        const sql = buildDictionaryRowsSql({
          where, cursorClause, orderBy, dedupe, dedupeInWindow,
          rawCols: RAW_COLS, selectList: SELECT, sortMaxMemoryBytes: SORT_MAX_MEMORY_BYTES, normColsSetting: NORM_COLS_SETTING, candidates,
        })
        if (sql) {
          try {
            const answered = await executeQuery(sql, dedupeInWindow ? { ...allParams, windowLimit: limit * DEDUPE_WINDOW_FACTOR } : allParams) as unknown[]
            plan = 'dictionary'
            return answered
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout') || msg.includes('Timeout')) throw err
            console.warn('[credentials] dictionary plan failed -- using the plain query:', msg)
          }
        }
      }
      return runPlainDataQuery()
    }

    const runNewestFirstData = async (): Promise<unknown[]> => {
```

3f. Where the windows hand off. Replace

```ts
        console.warn('[credentials] newest-first windows failed -- using the plain query:', msg)
      }
      return runPlainDataQuery()
    }
```

with

```ts
        console.warn('[credentials] newest-first windows failed -- using the plain query:', msg)
      }
      return runDataQuery()
    }
```

3g. The default branch. Replace

```ts
      : sortKey === 'imported_desc' ? runNewestFirstData() : runPlainDataQuery()
```

with

```ts
      : sortKey === 'imported_desc' ? runNewestFirstData() : runDataQuery()
```

3h. The responses. Replace

```ts
      return NextResponse.json({ success: true, total, raw_total, query_ms, timed_out })
```

with

```ts
      return NextResponse.json({ success: true, total, raw_total, query_ms, timed_out, plan: totalsPlan })
```

and replace

```ts
      // Which plan answered the rows: 'windows' (lib/newest-first.ts) or 'plain'.
      plan,
```

with

```ts
      // Which plan answered the rows: 'windows' (lib/newest-first.ts), 'dictionary' (lib/search-dictionary-plan.ts) or 'plain'.
      plan,
```

- [ ] **Step 4: Run the new test, the neighbouring route tests, and the type check**

Run: `npx vitest run __tests__/credentials-route-dictionary.test.ts __tests__/credentials-route-totals.test.ts __tests__/credentials-route-newest-first.test.ts __tests__/credentials-route.test.ts __tests__/credentials-route-dedupe-window.test.ts`
Expected: PASS for every file. The older files use `q=binance.com`, which is now eligible: their mock answers the dictionary's status queries with the totals row, which reads as `unknown`, so they take the plain path and their query counts are unchanged (the status and lookup SQL carry neither `) AS t` nor `AS raw_total`).

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS (every file; the count is the previous total plus the new test files). If a test outside the route fails because it asserts the exact list of `executeQuery` calls for a domain-shaped `q`, update that assertion to ignore the dictionary's status queries (they are the ones whose SQL contains `search_host_dict` or `AS table_uuid`), not the route.

- [ ] **Step 6: Commit**

```bash
git add app/api/credentials/route.ts __tests__/credentials-route-dictionary.test.ts
git commit -m "feat(credentials): answer a one-domain search from the dictionary, with the legacy query as the fallback for everything

Rows and totals take the plan when the term is eligible and the dictionary is fresh; dictionary=0 forces the plain query; plan reports which answered.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The rebuild cron, and the wiring (env, compose, docs, backups)

**Files:**
- Create: `lib/search-dictionary-cron.ts`
- Modify: `instrumentation.ts`, `docker-compose.yml`, `.env.example`, `README.md`, `scripts/clickhouse-backup.sh`
- Test: `__tests__/search-dictionary-cron.test.ts`, `__tests__/search-dictionary-wiring.test.ts` (create both)

**Interfaces:**
- Consumes (Task 3): `buildSearchDictionary`, `DictionaryHeadroomError`, `getSearchDictionaryStatus`, `readLiveState`, `resetSearchDictionaryCache`, `recordBuildOutcome`, `searchDictCronMinutes`, `searchDictSettleSeconds`, `searchDictionaryEnabled`, `DictionaryStatus`, `LiveState`, `BuildResult`.
- Produces: `type TickOutcome = 'disabled' | 'fresh' | 'unknown' | 'building' | 'settling' | 'mutating' | 'backoff' | 'no-headroom' | 'built' | 'failed'`; `runSearchDictionaryTick(overrides?: Partial<TickDeps>): Promise<TickOutcome>`; `startSearchDictionaryCron(): void`; `resetCronState(): void`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/search-dictionary-cron.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(async () => []), getClient: vi.fn() }))

import { runSearchDictionaryTick, startSearchDictionaryCron, resetCronState } from '@/lib/search-dictionary-cron'
import { DictionaryHeadroomError, readBuildRecord, recordBuildOutcome, type DictionaryStatus, type LiveState } from '@/lib/search-dictionary'
import { executeQuery } from '@/lib/clickhouse'

const status = (state: DictionaryStatus['state']): DictionaryStatus => ({
  state, fingerprint: null, builtAt: null, pairRows: null, emailRows: null, bytes: null, lastError: null, lastBuildMs: null,
})
const live = (over: Partial<LiveState> = {}): LiveState => ({ fingerprint: 'fp-a', mutationsRunning: 0, buildsRunning: 0, ...over })
const BUILT = { pairRows: 85, emailRows: 13, ms: 1000, fingerprint: 'fp-a' }

function deps(over: Record<string, unknown> = {}) {
  return {
    status: vi.fn(async () => status('stale')),
    live: vi.fn(async () => live()),
    build: vi.fn(async () => BUILT),
    sleep: vi.fn(async (_ms: number) => {}),
    now: vi.fn(() => 1_000_000),
    ...over,
  } as Parameters<typeof runSearchDictionaryTick>[0] & { build: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn>; live: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  resetCronState()
  vi.mocked(executeQuery).mockClear()
  recordBuildOutcome({ lastError: null, lastBuildMs: null, lastBuiltAt: null })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('runSearchDictionaryTick', () => {
  test('switched off: nothing is read', async () => {
    vi.stubEnv('SEARCH_DICTIONARY', '0')
    const d = deps()
    expect(await runSearchDictionaryTick(d)).toBe('disabled')
    expect(d.status).not.toHaveBeenCalled()
  })

  test.each([['fresh', 'fresh'], ['unknown', 'unknown'], ['building', 'building'], ['disabled', 'disabled']] as const)('%s: nothing to do', async (state, outcome) => {
    const d = deps({ status: vi.fn(async () => status(state)) })
    expect(await runSearchDictionaryTick(d)).toBe(outcome)
    expect(d.build).not.toHaveBeenCalled()
    expect(d.sleep).not.toHaveBeenCalled()
  })

  test.each(['stale', 'missing'] as const)('%s and quiet: waits the settle time, reads the fingerprint again, then builds', async state => {
    const d = deps({ status: vi.fn(async () => status(state)) })
    expect(await runSearchDictionaryTick(d)).toBe('built')
    expect(d.sleep).toHaveBeenCalledWith(120_000)
    expect(d.live).toHaveBeenCalledTimes(2)
    expect(d.build).toHaveBeenCalledTimes(1)
  })

  test('the settle time is configurable', async () => {
    vi.stubEnv('SEARCH_DICT_SETTLE_SECONDS', '5')
    const d = deps()
    await runSearchDictionaryTick(d)
    expect(d.sleep).toHaveBeenCalledWith(5_000)
  })

  test('the fingerprint changed while it waited (an import is running): no build this time', async () => {
    const d = deps({ live: vi.fn().mockResolvedValueOnce(live({ fingerprint: 'fp-a' })).mockResolvedValueOnce(live({ fingerprint: 'fp-b' })) })
    expect(await runSearchDictionaryTick(d)).toBe('settling')
    expect(d.build).not.toHaveBeenCalled()
  })

  test('a content mutation running, before or after the wait: no build', async () => {
    const before = deps({ live: vi.fn(async () => live({ mutationsRunning: 1 })) })
    expect(await runSearchDictionaryTick(before)).toBe('mutating')
    expect(before.sleep).not.toHaveBeenCalled()
    const after = deps({ live: vi.fn().mockResolvedValueOnce(live()).mockResolvedValueOnce(live({ mutationsRunning: 1 })) })
    expect(await runSearchDictionaryTick(after)).toBe('mutating')
    expect(after.build).not.toHaveBeenCalled()
  })

  test('a build already running elsewhere (the script, another process): no second one', async () => {
    const d = deps({ live: vi.fn().mockResolvedValueOnce(live()).mockResolvedValueOnce(live({ buildsRunning: 1 })) })
    expect(await runSearchDictionaryTick(d)).toBe('building')
    expect(d.build).not.toHaveBeenCalled()
  })

  test('the live state unreadable: unknown, no build', async () => {
    const d = deps({ live: vi.fn(async () => null) })
    expect(await runSearchDictionaryTick(d)).toBe('unknown')
    expect(d.build).not.toHaveBeenCalled()
  })

  test('no room for the second copy is not a failure: the tick is skipped, and it keeps trying every tick', async () => {
    const d = deps({ build: vi.fn(async () => { throw new DictionaryHeadroomError('143 GiB free') }) })
    for (let i = 0; i < 5; i++) expect(await runSearchDictionaryTick(d)).toBe('no-headroom')
    expect(d.build).toHaveBeenCalledTimes(5)
    expect(readBuildRecord().lastError).toBeNull()
  })

  test('failures are recorded; three in a row wait an hour; after the hour it tries again; a success clears the count', async () => {
    let t = 1_000_000
    const build = vi.fn(async () => { throw new Error('MEMORY_LIMIT_EXCEEDED') })
    const d = deps({ build, now: vi.fn(() => t) })
    for (let i = 0; i < 3; i++) expect(await runSearchDictionaryTick(d)).toBe('failed')
    expect(readBuildRecord().lastError).toContain('MEMORY_LIMIT_EXCEEDED')
    expect(await runSearchDictionaryTick(d)).toBe('backoff')
    expect(build).toHaveBeenCalledTimes(3)
    t += 3_599_000
    expect(await runSearchDictionaryTick(d)).toBe('backoff')
    t += 2_000
    expect(await runSearchDictionaryTick(d)).toBe('failed') // tried again
    expect(build).toHaveBeenCalledTimes(4)

    build.mockResolvedValueOnce(BUILT)
    t += 3_700_000
    expect(await runSearchDictionaryTick(d)).toBe('built')
    build.mockRejectedValue(new Error('again'))
    for (let i = 0; i < 3; i++) expect(await runSearchDictionaryTick(d)).toBe('failed') // the count started over
    expect(await runSearchDictionaryTick(d)).toBe('backoff')
  })
})

describe('startSearchDictionaryCron', () => {
  test('SEARCH_DICT_CRON_MINUTES=0 schedules nothing', () => {
    vi.useFakeTimers()
    vi.stubEnv('SEARCH_DICT_CRON_MINUTES', '0')
    startSearchDictionaryCron()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('switched off schedules nothing', () => {
    vi.useFakeTimers()
    vi.stubEnv('SEARCH_DICTIONARY', '0')
    startSearchDictionaryCron()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('schedules a first tick and an interval once, however often it is started', () => {
    vi.useFakeTimers()
    startSearchDictionaryCron()
    startSearchDictionaryCron()
    expect(vi.getTimerCount()).toBe(2)
  })

  test('the first tick comes after two minutes (or the interval if that is shorter) and reads the status', async () => {
    vi.useFakeTimers()
    vi.stubEnv('SEARCH_DICT_CRON_MINUTES', '1')
    startSearchDictionaryCron()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(vi.mocked(executeQuery)).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(vi.mocked(executeQuery)).toHaveBeenCalled() // the status check of the first tick
  })
})
```

Create `__tests__/search-dictionary-wiring.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')
const VARS = ['SEARCH_DICTIONARY', 'SEARCH_DICT_MAX_DOMAINS', 'SEARCH_DICT_MAX_EMAIL_DOMAINS', 'SEARCH_DICT_CRON_MINUTES', 'SEARCH_DICT_SETTLE_SECONDS']

describe('search dictionary wiring', () => {
  test('instrumentation starts the rebuild cron, in the production block only', () => {
    const src = read('instrumentation.ts')
    expect(src).toContain("await import('./lib/search-dictionary-cron')")
    expect(src).toContain('startSearchDictionaryCron()')
    expect(src.indexOf('startSearchDictionaryCron()')).toBeGreaterThan(src.indexOf("process.env.NODE_ENV === 'production'"))
  })

  test.each(VARS)('docker-compose forwards %s to the app (compose passes no other .env keys)', name => {
    expect(read('docker-compose.yml')).toContain(`${name}: \${${name}:-}`)
  })

  test.each(VARS)('.env.example documents %s', name => {
    expect(read('.env.example')).toContain(`# ${name}=`)
  })

  test('the README explains the feature, its first build, and how to switch it off', () => {
    const readme = read('README.md')
    expect(readme).toContain('### Domain search dictionary')
    expect(readme).toContain('scripts/build-search-dictionary.ts')
    expect(readme).toContain('SEARCH_DICTIONARY=0')
    expect(readme).toContain('dictionary=0')
  })

  test('the backup script leaves the derived tables (and their shadow copies) out of the default list', () => {
    const script = read('scripts/clickhouse-backup.sh')
    expect(script).toContain("NOT match(name, '^(credentials_|zz_|search_)')")
    expect(script).toContain('search_host_dict')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/search-dictionary-cron.test.ts __tests__/search-dictionary-wiring.test.ts`
Expected: FAIL (the cron module does not exist; the wiring pins fail).

- [ ] **Step 3: Write the cron**

Create `lib/search-dictionary-cron.ts`:

```ts
/**
 * Keeps the search dictionary (lib/search-dictionary.ts) current. One tick every SEARCH_DICT_CRON_MINUTES (default 10; 0 disables). A tick rebuilds only
 * when the dictionary is stale or missing AND the table has been quiet: the fingerprint is read, the tick waits SEARCH_DICT_SETTLE_SECONDS (default
 * 120) and reads it again, so an import in progress is never built against. It also skips while a content mutation or another build is running,
 * and when the disk has no room for the second copy (not a failure). Failures back off: three in a row wait an hour.
 *
 * Production only (instrumentation.ts). The settle wait makes a tick long, so a tick never overlaps the previous one.
 */
import {
  buildSearchDictionary, DictionaryHeadroomError, getSearchDictionaryStatus, readLiveState, resetSearchDictionaryCache, recordBuildOutcome,
  searchDictCronMinutes, searchDictSettleSeconds, searchDictionaryEnabled,
  type BuildResult, type DictionaryStatus, type LiveState,
} from '@/lib/search-dictionary'

export type TickOutcome = 'disabled' | 'fresh' | 'unknown' | 'building' | 'settling' | 'mutating' | 'backoff' | 'no-headroom' | 'built' | 'failed'

export interface TickDeps {
  status: () => Promise<DictionaryStatus>
  live: () => Promise<LiveState | null>
  build: () => Promise<BuildResult>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const BACKOFF_AFTER_FAILURES = 3
const BACKOFF_MS = 3_600_000
const FIRST_TICK_MS = 120_000

let failures = 0
let lastFailureAt = 0
let started = false

export function resetCronState(): void {
  failures = 0
  lastFailureAt = 0
  started = false
}

const defaultDeps = (): TickDeps => ({
  // the cron must not trust a cached answer (up to 3 s old): it is about to act on it
  status: async () => { resetSearchDictionaryCache(); return getSearchDictionaryStatus() },
  live: () => readLiveState(),
  build: () => buildSearchDictionary(),
  sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
  now: Date.now,
})

export async function runSearchDictionaryTick(overrides: Partial<TickDeps> = {}): Promise<TickOutcome> {
  if (!searchDictionaryEnabled()) return 'disabled'
  const d: TickDeps = { ...defaultDeps(), ...overrides }

  const status = await d.status()
  if (status.state === 'fresh') return 'fresh'
  if (status.state === 'building') return 'building'
  if (status.state === 'disabled') return 'disabled'
  if (status.state === 'unknown') return 'unknown'

  // stale or missing
  if (failures >= BACKOFF_AFTER_FAILURES && d.now() - lastFailureAt < BACKOFF_MS) return 'backoff'
  const first = await d.live()
  if (!first) return 'unknown'
  if (first.mutationsRunning > 0) return 'mutating'
  await d.sleep(searchDictSettleSeconds() * 1000)
  const second = await d.live()
  if (!second) return 'unknown'
  if (second.fingerprint !== first.fingerprint) return 'settling'
  if (second.mutationsRunning > 0) return 'mutating'
  if (second.buildsRunning > 0) return 'building'

  try {
    const result = await d.build()
    failures = 0
    console.warn(`[search-dictionary] tick built the dictionary: ${result.pairRows} host pairs, ${result.emailRows} email domains in ${Math.round(result.ms / 1000)}s`)
    return 'built'
  } catch (err) {
    if (err instanceof DictionaryHeadroomError) {
      console.warn(`[search-dictionary] build skipped: ${err.message}`)
      return 'no-headroom'
    }
    failures += 1
    lastFailureAt = d.now()
    recordBuildOutcome({ lastError: err instanceof Error ? err.message : String(err) })
    console.error('[search-dictionary] build failed:', err)
    return 'failed'
  }
}

export function startSearchDictionaryCron(): void {
  if (started) return
  const minutes = searchDictCronMinutes()
  if (minutes <= 0 || !searchDictionaryEnabled()) {
    console.log('[search-dictionary] cron disabled (SEARCH_DICT_CRON_MINUTES=0 or SEARCH_DICTIONARY=0)')
    return
  }
  started = true
  const everyMs = minutes * 60_000
  const firstMs = Math.min(FIRST_TICK_MS, everyMs)
  let running = false
  const tick = () => {
    if (running) return
    running = true
    runSearchDictionaryTick()
      .catch(err => console.error('[search-dictionary] tick failed:', err))
      .finally(() => { running = false })
  }
  console.warn(`[search-dictionary] cron started — first tick in ${Math.round(firstMs / 1000)}s, then every ${minutes}m`)
  setTimeout(tick, firstMs)
  setInterval(tick, everyMs)
}
```

- [ ] **Step 4: Wire it in**

4a. `instrumentation.ts`: replace

```ts
        console.error('[instrumentation] Disk-watch cron failed to start:', err)
      }
    }
```

with

```ts
        console.error('[instrumentation] Disk-watch cron failed to start:', err)
      }

      // Domain search dictionary: rebuilds the two derived tables behind the fast domain search when they are stale or missing
      // (settle wait, mutation and disk checks, backoff inside). See lib/search-dictionary-cron.ts.
      try {
        const { startSearchDictionaryCron } = await import('./lib/search-dictionary-cron')
        startSearchDictionaryCron()
      } catch (err) {
        console.error('[instrumentation] Search-dictionary cron failed to start:', err)
      }
    }
```

4b. `docker-compose.yml`: replace

```yaml
      BACKUP_MAX_AGE_HOURS: ${BACKUP_MAX_AGE_HOURS:-}
    volumes:
      - ./uploads:/app/uploads
```

with

```yaml
      BACKUP_MAX_AGE_HOURS: ${BACKUP_MAX_AGE_HOURS:-}
      # Domain search dictionary (lib/search-dictionary.ts) -- optional; forwarded explicitly (see above). Empty values use the defaults in code:
      # on; at most 3000 candidate domains and 300 email domains per search; a rebuild tick every 10 minutes; 120 s of quiet before a rebuild.
      SEARCH_DICTIONARY: ${SEARCH_DICTIONARY:-}
      SEARCH_DICT_MAX_DOMAINS: ${SEARCH_DICT_MAX_DOMAINS:-}
      SEARCH_DICT_MAX_EMAIL_DOMAINS: ${SEARCH_DICT_MAX_EMAIL_DOMAINS:-}
      SEARCH_DICT_CRON_MINUTES: ${SEARCH_DICT_CRON_MINUTES:-}
      SEARCH_DICT_SETTLE_SECONDS: ${SEARCH_DICT_SETTLE_SECONDS:-}
    volumes:
      - ./uploads:/app/uploads
```

4c. `.env.example`: append at the end of the file

```
# ─── Domain search dictionary ───────────────────────
# Two small derived tables (ulp.search_host_dict and ulp.search_emaildomain_dict, about 2 GiB together) make a search for one domain-shaped
# term fast; see the README, "Domain search dictionary". They are rebuilt automatically after imports, and while one is stale or missing
# searches use the slower original query. SEARCH_DICTIONARY=0 switches the feature off. The two caps are how many candidate domains and
# email domains one term may have before the original query runs instead (popular terms such as google.com). SEARCH_DICT_CRON_MINUTES=0 stops
# the automatic rebuilds (build by hand with scripts/build-search-dictionary.ts). SEARCH_DICT_SETTLE_SECONDS is how long the data must stay
# unchanged before a rebuild starts.
# SEARCH_DICTIONARY=1
# SEARCH_DICT_MAX_DOMAINS=3000
# SEARCH_DICT_MAX_EMAIL_DOMAINS=300
# SEARCH_DICT_CRON_MINUTES=10
# SEARCH_DICT_SETTLE_SECONDS=120
```

4d. `README.md`: insert before the line `### Content deduplication (storage)`:

```
### Domain search dictionary (speed)

A search for one domain, such as `ledger.com`, matches the site, its subdomains, hosts that contain the name, and email domains that contain it. ClickHouse cannot use the primary key for that mix, so it used to read most of the table (15-19 s on the 1.39B-row deployment). Two small derived tables, `ulp.search_host_dict` (distinct domain and host pairs, about 2 GiB) and `ulp.search_emaildomain_dict` (about 150 MiB), let the app look up which domains and email domains can match first and then read only those ranges: the same rows, order, cursors and totals in about 2-4 s. It is used only for a search that is exactly one domain-shaped term; everything else, and any problem, runs the original query.

- The tables are rebuilt automatically after imports (a tick every `SEARCH_DICT_CRON_MINUTES`, once the data has been quiet for `SEARCH_DICT_SETTLE_SECONDS`). While one is stale or missing, searches simply use the slower original query. Ingest Health shows its state.
- First build, by hand and watched (about 2.5 minutes, 2 GiB; run it before relying on it): `npx tsx scripts/build-search-dictionary.ts` (the header of the script shows the `CLICKHOUSE_HOST` to use from the host).
- `SEARCH_DICTIONARY=0` switches it off (no rebuild needed). `SEARCH_DICT_MAX_DOMAINS` (3000) and `SEARCH_DICT_MAX_EMAIL_DOMAINS` (300) bound how many candidates one term may have; above them the original query runs (popular terms such as `google.com`).
- `/api/credentials?...&dictionary=0` forces the original query for one request, and a response says which plan answered in `plan` (`dictionary`, `windows` or `plain`).
- The tables are derived data: `scripts/clickhouse-backup.sh` leaves them out, and dropping them is always safe.

```

4e. `scripts/clickhouse-backup.sh`: replace the comment block

```
# Why tables are listed instead of `ulp.*`: the ulp database also holds the multi-hundred-GiB pre-dedup
# archive (credentials_predup_auto) and any dedup scratch tables. A wildcard would snapshot them too,
# pinning their parts (so dropping the archive later would free nothing while the snapshot exists) and
# trying to upload them.
```

with

```
# Why tables are listed instead of `ulp.*`: the ulp database also holds the multi-hundred-GiB pre-dedup
# archive (credentials_predup_auto), any dedup scratch tables, and the derived search dictionary
# (search_host_dict, search_emaildomain_dict and their __new shadow copies; rebuilt by the app, never
# worth backing up). A wildcard would snapshot them too, pinning their parts (so dropping the archive
# later would free nothing while the snapshot exists) and trying to upload them.
```

and replace

```
                 WHERE database = 'ulp' AND NOT match(name, '^(credentials_|zz_)')" 2>/dev/null || true
```

with

```
                 WHERE database = 'ulp' AND NOT match(name, '^(credentials_|zz_|search_)')" 2>/dev/null || true
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run __tests__/search-dictionary-cron.test.ts __tests__/search-dictionary-wiring.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; the whole suite passes.

- [ ] **Step 6: Commit**

```bash
git add lib/search-dictionary-cron.ts instrumentation.ts docker-compose.yml .env.example README.md scripts/clickhouse-backup.sh __tests__/search-dictionary-cron.test.ts __tests__/search-dictionary-wiring.test.ts
git commit -m "feat(search-dictionary): the rebuild cron, its env and docs, and keep the derived tables out of backups

A tick rebuilds only a stale or missing dictionary that has been quiet across a settle wait, with no content mutation or build running and room on disk; three failures wait an hour.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Show the dictionary in Ingest Health

**Files:**
- Modify: `app/api/monitoring/ingest-health/route.ts`, `components/ingest-health-panel.tsx`
- Test: `__tests__/ingest-health-route.test.ts`, `__tests__/ingest-health-panel.test.ts` (extend both)

**Interfaces:**
- Consumes: `getSearchDictionaryStatus` (Task 3).
- Produces: `GET /api/monitoring/ingest-health` gains `searchDictionary: { state, builtAt, pairRows, emailRows, bytes, lastError, lastBuildMs }`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/ingest-health-route.test.ts`, add to the imports (below the existing `import { GET } ...`):

```ts
import { liveStateFromRow, encodeDictionaryComment, resetSearchDictionaryCache } from '@/lib/search-dictionary'
```

add `resetSearchDictionaryCache()` as the first line inside the existing `beforeEach(() => {`, and add, inside `describe('GET /api/monitoring/ingest-health', ...)` before its closing `})`:

```ts
  it('reports the search dictionary: unknown when ClickHouse cannot say', async () => {
    mockEQ
      .mockResolvedValueOnce([{ c: 42 }]).mockResolvedValueOnce([{ c: 3 }]).mockResolvedValueOnce([{ v: 1 }]).mockResolvedValueOnce([{ bytes: 1 }])
    const json = await (await GET({} as any)).json()
    expect(json.searchDictionary).toMatchObject({ state: 'unknown', builtAt: null, pairRows: null, bytes: null })
  })

  it('reports a fresh search dictionary with its size and build time', async () => {
    const liveRow = { table_uuid: 'u1', part_state: '202608:1:0:1', mutation_state: '', mutations_running: '0', builds_running: '0' }
    const fp = liveStateFromRow(liveRow)!.fingerprint
    const comment = (rows: number) => encodeDictionaryComment({ v: 1, fp, builtAt: '2026-10-03T12:00:00.000Z', rows })
    mockEQ
      .mockResolvedValueOnce([{ c: 42 }]).mockResolvedValueOnce([{ c: 3 }]).mockResolvedValueOnce([{ v: 1 }]).mockResolvedValueOnce([{ bytes: 1 }])
      .mockImplementation(async (sql: string) => {
        if (sql.includes('AS table_uuid')) return [liveRow]
        if (sql.includes("name IN ('search_host_dict'")) {
          return [
            { name: 'search_host_dict', comment: comment(85), table_rows: '85', table_bytes: '2000' },
            { name: 'search_emaildomain_dict', comment: comment(13), table_rows: '13', table_bytes: '100' },
          ]
        }
        return []
      })
    const json = await (await GET({} as any)).json()
    expect(json.searchDictionary).toMatchObject({ state: 'fresh', builtAt: '2026-10-03T12:00:00.000Z', pairRows: 85, emailRows: 13, bytes: 2100 })
    expect(json.searchDictionary).not.toHaveProperty('fingerprint')
  })
```

In `__tests__/ingest-health-panel.test.ts`, add before the final `})`... (the file's `describe` ends at its last line `})`): append a new `describe` after it:

```ts

describe('Ingest Health panel — the search dictionary', () => {
  test('shows one line for it, amber unless it is fresh or switched off', () => {
    expect(panel).toContain('data-testid="search-dictionary"')
    expect(panel).toContain('Search dictionary: fresh')
    expect(panel).toContain('Search dictionary: stale')
    expect(panel).toContain('Search dictionary: missing')
    expect(panel).toContain('Search dictionary: building')
    expect(panel).toContain('Search dictionary: off (SEARCH_DICTIONARY=0)')
    expect(panel).toContain('Search dictionary: state unavailable')
    expect(panel).toMatch(/label\.ok \? "text-muted-foreground" : "text-amber-600 font-medium"/)
  })

  test('says so when the last build failed', () => {
    expect(panel).toContain('last build failed')
  })

  test('the block is optional in the payload, so an older server response still renders', () => {
    expect(panel).toMatch(/searchDictionary\?: \{/)
    expect(panel).toContain('{searchDictionary && (')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/ingest-health-route.test.ts __tests__/ingest-health-panel.test.ts`
Expected: FAIL (`searchDictionary` is undefined in the route's answer; the panel has no such text).

- [ ] **Step 3: Write the route change**

In `app/api/monitoring/ingest-health/route.ts` add below `import { readBackupStatus } from '@/lib/backup-status'`:

```ts
import { getSearchDictionaryStatus } from '@/lib/search-dictionary'
```

and replace

```ts
  const disk = await readDisk()

  return NextResponse.json({ app: getIngestMetrics(), clickhouse, diskBudget, disk, backup: readBackupStatus() })
```

with

```ts
  const disk = await readDisk()

  // The derived tables behind the fast domain search (lib/search-dictionary.ts). Never throws: 'unknown' when ClickHouse cannot say.
  const dict = await getSearchDictionaryStatus()
  const searchDictionary = {
    state: dict.state, builtAt: dict.builtAt, pairRows: dict.pairRows, emailRows: dict.emailRows, bytes: dict.bytes,
    lastError: dict.lastError, lastBuildMs: dict.lastBuildMs,
  }

  return NextResponse.json({ app: getIngestMetrics(), clickhouse, diskBudget, disk, backup: readBackupStatus(), searchDictionary })
```

- [ ] **Step 4: Write the panel change**

In `components/ingest-health-panel.tsx`:

4a. In `interface IngestHealth`, after the `disk?: { ... }` member (before the closing `}` of the interface), add:

```ts
  // The two derived tables behind the fast domain search (lib/search-dictionary.ts).
  searchDictionary?: {
    state: "fresh" | "stale" | "missing" | "building" | "disabled" | "unknown"
    builtAt: string | null
    pairRows: number | null
    emailRows: number | null
    bytes: number | null
    lastError: string | null
    lastBuildMs: number | null
  }
```

4b. After the `fmtAge` helper line, add:

```tsx
function dictionaryLabel(d: NonNullable<IngestHealth["searchDictionary"]>): { text: string; ok: boolean } {
  const ageHours = d.builtAt ? Math.max(0, (Date.now() - Date.parse(d.builtAt)) / 3_600_000) : null
  switch (d.state) {
    case "fresh":
      return { ok: true, text: `Search dictionary: fresh${ageHours !== null && Number.isFinite(ageHours) ? `, built ${fmtAge(ageHours)}` : ""}${d.bytes !== null ? `, ${fmtGB(d.bytes)}` : ""}` }
    case "building":
      return { ok: false, text: "Search dictionary: building — domain searches use the slower query until it is done" }
    case "stale":
      return { ok: false, text: "Search dictionary: stale — domain searches use the slower query until it is rebuilt" }
    case "missing":
      return { ok: false, text: "Search dictionary: missing — domain searches use the slower query (build it: scripts/build-search-dictionary.ts)" }
    case "disabled":
      return { ok: true, text: "Search dictionary: off (SEARCH_DICTIONARY=0)" }
    default:
      return { ok: false, text: "Search dictionary: state unavailable" }
  }
}
```

4c. Change the destructuring line `const { app, clickhouse, diskBudget, disk, backup } = data` to:

```tsx
  const { app, clickhouse, diskBudget, disk, backup, searchDictionary } = data
```

4d. After the `{backup && ( ... )}` block (just before `</CardContent>`), add:

```tsx
        {searchDictionary && (() => {
          const label = dictionaryLabel(searchDictionary)
          return (
            <div className="flex gap-6 flex-wrap text-xs border-t pt-3" data-testid="search-dictionary">
              <span
                className={label.ok ? "text-muted-foreground" : "text-amber-600 font-medium"}
                title="Two small derived tables that make a one-domain search fast; rebuilt automatically after imports (README, Domain search dictionary)"
              >
                {label.text}
              </span>
              {searchDictionary.lastError && (
                <span className="text-red-600" title={searchDictionary.lastError}>last build failed</span>
              )}
            </div>
          )
        })()}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run __tests__/ingest-health-route.test.ts __tests__/ingest-health-panel.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit && npx eslint --no-eslintrc -c .eslintrc.json components/ingest-health-panel.tsx app/api/monitoring/ingest-health/route.ts lib/search-dictionary.ts lib/search-dictionary-plan.ts lib/search-dictionary-cron.ts lib/clickhouse-literals.ts`
Expected: no output from either.

- [ ] **Step 6: Commit**

```bash
git add app/api/monitoring/ingest-health/route.ts components/ingest-health-panel.tsx __tests__/ingest-health-route.test.ts __tests__/ingest-health-panel.test.ts
git commit -m "feat(ingest-health): show the search dictionary's state, size and last build error

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The first-build script and the live parity test

**Files:**
- Create: `scripts/build-search-dictionary.ts`
- Create: `__tests__/search-dictionary-parity.live.test.ts` (gated: skipped unless `SDP_PARITY=1`)
- Create: `__tests__/search-dictionary-script.test.ts`

**Interfaces:**
- Consumes: `buildSearchDictionary`, `getSearchDictionaryStatus`, `resetSearchDictionaryCache` (Task 3); the route's `GET` (Task 5).
- Produces: `npx tsx scripts/build-search-dictionary.ts [--status] [--force] [--skip-headroom-check]` (exit 0 fresh, 1 error, 3 built but already stale); the live test `SDP_PARITY=1 npx vitest run __tests__/search-dictionary-parity.live.test.ts` with `SDP_TERMS`, `SDP_SORTS`, `SDP_DEDUPES`, `SDP_PAGES`, `SDP_LEGACY_TERMS`, `SDP_TIMING_ONLY`.

- [ ] **Step 1: Write the failing pin test for the script**

Create `__tests__/search-dictionary-script.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'

const script = readFileSync('scripts/build-search-dictionary.ts', 'utf8')

describe('scripts/build-search-dictionary.ts', () => {
  test('runs the same build function the cron calls, and can only print the status', () => {
    expect(script).toContain("from '@/lib/search-dictionary'")
    expect(script).toContain('buildSearchDictionary(')
    expect(script).toContain("'--status'")
    expect(script).toContain("'--force'")
    expect(script).toContain("'--skip-headroom-check'")
  })

  test('tells the operator how to reach ClickHouse from the host, and that nothing is exposed', () => {
    expect(script).toContain('docker inspect ulpsuite_clickhouse')
    expect(script).toContain('CLICKHOUSE_HOST=http://$IP:8123')
  })

  test('refuses to start a second build and says what a stale answer right after a build means', () => {
    expect(script).toContain("status.state === 'building'")
    expect(script).toContain('exit code 3')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/search-dictionary-script.test.ts`
Expected: FAIL (ENOENT: no such file `scripts/build-search-dictionary.ts`).

- [ ] **Step 3: Write the script**

Create `scripts/build-search-dictionary.ts`:

```ts
/**
 * The supervised build of the search dictionary (lib/search-dictionary.ts): the same function the cron calls, run once by hand, so a person is
 * watching the first one (about 2.5 minutes, reads about 66 GiB, peaks under 4 GiB, writes about 2.2 GiB) and the dictionary exists and is
 * verified before anything depends on it. Run it BEFORE deploying the version whose cron would otherwise do the first build unattended.
 *
 * ClickHouse is not published to the host, but the compose network is routable from it, so no throwaway container is needed:
 *
 *   IP=$(docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
 *   CLICKHOUSE_HOST=http://$IP:8123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD= CLICKHOUSE_DATABASE=ulp \
 *     npx tsx scripts/build-search-dictionary.ts
 *
 *   --status                prints the dictionary's state and exits (changes nothing)
 *   --force                 builds even when the dictionary is already fresh
 *   --skip-headroom-check   skips the free-space check (only after you have looked at `df`)
 *
 * Exit code 0: the dictionary is fresh. 1: an error (the serving tables are untouched). 3: it was built, but the data changed meanwhile, so it is
 * already stale (an import ran; the cron will rebuild it, or run this again).
 */
import { pathToFileURL } from 'node:url'
import { getClient } from '@/lib/clickhouse'
import { buildSearchDictionary, getSearchDictionaryStatus, resetSearchDictionaryCache } from '@/lib/search-dictionary'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const show = async (label: string) => {
    resetSearchDictionaryCache()
    const s = await getSearchDictionaryStatus()
    console.log(`${label}: ${s.state}${s.builtAt ? `, built ${s.builtAt}` : ''}${s.pairRows !== null ? `, ${s.pairRows} host pairs` : ''}${s.emailRows !== null ? `, ${s.emailRows} email domains` : ''}${s.bytes !== null ? `, ${(s.bytes / 2 ** 30).toFixed(2)} GiB` : ''}`)
    return s
  }

  const status = await show('status')
  if (args.includes('--status')) return status.state === 'fresh' ? 0 : 1
  if (status.state === 'building') {
    console.error('a build of the dictionary is already running; not starting a second one')
    return 1
  }
  if (status.state === 'disabled') {
    console.error('SEARCH_DICTIONARY switches the feature off in this environment; building anyway would be harmless but pointless')
    return 1
  }
  if (status.state === 'fresh' && !args.includes('--force')) {
    console.log('the dictionary is already fresh; nothing to do (use --force to rebuild)')
    return 0
  }

  const result = await buildSearchDictionary({ skipHeadroomCheck: args.includes('--skip-headroom-check'), log: m => console.log(m) })
  console.log(`result: ${JSON.stringify(result)}`)
  const after = await show('status after the build')
  if (after.state === 'fresh') return 0
  console.error(`the dictionary is ${after.state} right after the build: the data changed while it ran (exit code 3)`)
  return 3
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main()
    .then(async code => { await getClient().close(); process.exit(code) })
    .catch(async err => { console.error(err); await getClient().close().catch(() => {}); process.exit(1) })
}
```

- [ ] **Step 4: Write the live parity test**

Create `__tests__/search-dictionary-parity.live.test.ts`:

```ts
import { execSync } from 'node:child_process'
import { describe, expect, test, vi, afterAll } from 'vitest'

/**
 * LIVE parity check for the domain search dictionary (lib/search-dictionary-plan.ts): the route's answer from the dictionary must be IDENTICAL to
 * today's plain query, page after page, for rows and for totals. Skipped unless SDP_PARITY=1; it talks to the real ClickHouse (the running
 * ulpsuite_clickhouse container) and prints timings. READ-ONLY. It drives the real GET /api/credentials handler; the plain query is forced with
 * `dictionary=0`, so the legacy SQL it compares against cannot drift from the route's. It also prints the timings the design promised (first page,
 * later pages, totals), which is why there is no separate benchmark script.
 *
 *   SDP_PARITY=1 npx vitest run __tests__/search-dictionary-parity.live.test.ts
 *   SDP_PARITY=1 SDP_TERMS=ledger.com,kraken.com SDP_SORTS=domain_asc,email_asc SDP_PAGES=2 SDP_DEDUPES=1 npx vitest run __tests__/search-dictionary-parity.live.test.ts
 *
 *   SDP_TERMS         comma list of domain-shaped terms (default: three public brands and one that matches nothing). Real search terms belong in YOUR
 *                     environment, never in this file: the repository is public.
 *   SDP_SORTS         default domain_asc,email_asc,imported_desc      SDP_DEDUPES  default 1,0 (Unique on, off)      SDP_PAGES  default 2
 *   SDP_LEGACY_TERMS  terms expected to exceed a cap (e.g. google.com): they must answer from the plain query
 *   SDP_TIMING_ONLY=1 first page and totals through the dictionary only, no legacy comparison (the plain query takes 8-60 s per call)
 *
 * The user profile has the query cache on and ClickHouse keeps a per-granule condition cache, so both are dropped before EVERY call (a repeat of
 * the same WHERE looks about 10x faster otherwise), and the planner's lookup cache is reset before the first page of each scenario. Re-run it after
 * anything that rebuilds the table or the dictionary (a content-dedup swap, a ClickHouse upgrade); it is also the tripwire for the two ClickHouse 26.3
 * quirks the plan works around.
 */
const LIVE = process.env.SDP_PARITY === '1'
const TIMING_ONLY = process.env.SDP_TIMING_ONLY === '1'
const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(',').map(s => s.trim()).filter(Boolean)
const TERMS = list(process.env.SDP_TERMS, 'ledger.com,trezor.io,kraken.com,zzqxnonexistent.example')
const SORTS = list(process.env.SDP_SORTS, 'domain_asc,email_asc,imported_desc')
const DEDUPES = list(process.env.SDP_DEDUPES, '1,0')
const PAGES = Number(process.env.SDP_PAGES ?? 2)
const LEGACY_TERMS = new Set(list(process.env.SDP_LEGACY_TERMS, ''))

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

// "Newest first" is answered by the time windows (lib/newest-first.ts) when they can, and by the plan only after they hand off, so for that sort either may answer.
const expectedPlans = (term: string, sort: string): string[] =>
  LEGACY_TERMS.has(term) ? ['plain'] : sort === 'imported_desc' ? ['dictionary', 'windows'] : ['dictionary']

type Timing = { scenario: string; page: string; legacyMs: number; planMs: number; plan: string; rows: number }
const timings: Timing[] = []
const matrix = TERMS.flatMap(term => SORTS.flatMap(sort => DEDUPES.map(dedupe => ({ term, sort, dedupe }))))

describe.skipIf(!LIVE)('search dictionary parity on the live table', () => {
  afterAll(() => {
    console.log('\nscenario | page | plain ms | dictionary ms (plan) | rows')
    for (const t of timings) console.log(`${t.scenario} | ${t.page} | ${t.legacyMs} | ${t.planMs} (${t.plan}) | ${t.rows}`)
  })

  test('the dictionary is fresh, so the comparison below measures the plan and not its fallback', async () => {
    const { getSearchDictionaryStatus, resetSearchDictionaryCache } = await import('@/lib/search-dictionary')
    resetSearchDictionaryCache()
    const status = await getSearchDictionaryStatus()
    console.log(`dictionary: ${status.state}, ${status.pairRows} host pairs, ${status.emailRows} email domains, ${status.bytes} bytes, built ${status.builtAt}`)
    expect(status.state, 'run scripts/build-search-dictionary.ts first').toBe('fresh')
  })

  test.each(matrix)('$term | $sort | Unique=$dedupe', async ({ term, sort, dedupe }) => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const { getClient } = await import('@/lib/clickhouse')
    const { resetDictionaryPlanCache } = await import('@/lib/search-dictionary-plan')
    const { resetSearchDictionaryCache } = await import('@/lib/search-dictionary')
    const { resetNewestFirstReadyCache } = await import('@/lib/newest-first')

    const call = async (qs: string, cold: boolean) => {
      if (cold) { resetDictionaryPlanCache(); resetSearchDictionaryCache() }
      resetNewestFirstReadyCache()
      await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
      await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
      const t0 = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}`))
      const ms = Date.now() - t0
      return { ms, body: await res.json() }
    }
    const base = `q=${encodeURIComponent(term)}&sort=${sort}&limit=200&exclude_noise=1&dedupe=${dedupe}`
    const scenario = `${term} ${sort} U${dedupe}`

    if (TIMING_ONLY) {
      const planned = await call(`${base}&skip_totals=1`, true)
      expect(planned.body.success).toBe(true)
      expect(expectedPlans(term, sort)).toContain(planned.body.plan)
      const totals = await call(`${base}&totals_only=1`, true)
      timings.push({ scenario, page: '1', legacyMs: 0, planMs: planned.ms, plan: planned.body.plan, rows: planned.body.results.length })
      timings.push({ scenario, page: 'totals', legacyMs: 0, planMs: totals.ms, plan: totals.body.plan, rows: Number(totals.body.total) })
      return
    }

    let cursor = ''
    for (let page = 1; page <= PAGES; page++) {
      const extra = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const legacy = await call(`${base}&skip_totals=1&dictionary=0${extra}`, true)
      const planned = await call(`${base}&skip_totals=1${extra}`, page === 1)
      expect(legacy.body.success, `page ${page} (plain): ${JSON.stringify(legacy.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.success, `page ${page}: ${JSON.stringify(planned.body).slice(0, 300)}`).toBe(true)
      expect(planned.body.results).toEqual(legacy.body.results)
      expect(planned.body.next_cursor).toEqual(legacy.body.next_cursor)
      expect(expectedPlans(term, sort), `which plan answered: ${scenario} page ${page}`).toContain(planned.body.plan)
      timings.push({ scenario, page: String(page), legacyMs: legacy.ms, planMs: planned.ms, plan: planned.body.plan, rows: legacy.body.results.length })
      if (!legacy.body.next_cursor) break
      cursor = legacy.body.next_cursor
    }

    const legacyTotals = await call(`${base}&totals_only=1&dictionary=0`, true)
    const plannedTotals = await call(`${base}&totals_only=1`, true)
    expect(plannedTotals.body.success).toBe(true)
    expect({ total: plannedTotals.body.total, raw_total: plannedTotals.body.raw_total })
      .toEqual({ total: legacyTotals.body.total, raw_total: legacyTotals.body.raw_total })
    timings.push({ scenario, page: 'totals', legacyMs: legacyTotals.ms, planMs: plannedTotals.ms, plan: plannedTotals.body.plan, rows: Number(plannedTotals.body.total) })
  }, 60 * 60_000)
})

describe.skipIf(!LIVE)('candidate lists written as literals reach the live ClickHouse byte for byte', () => {
  test('25 awkward strings come back identical (quotes, backslashes, an injection attempt, NUL, RTL override, a 4,000-character value)', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { chStringArrayLiteral } = await import('@/lib/clickhouse-literals')
    const nasty = [
      'plain.com', "a'b.com", 'a\\b.com', "a\\'b.com", "'; DROP TABLE ulp.credentials; --", '\\\\\'', "x'] ) OR 1=1 --",
      'line\nbreak.com', 'tab\tchar.com', 'nul\u0000byte.com', 'bell\u0007.com', 'del\u007f.com', 'emoji-😀.com', 'rtl-‮evil.com',
      'percent%_underscore_.com', '', ' ', 'a'.repeat(4000), 'ünïcödé.例え.jp', 'back`tick"dq.com', '--comment', '/* c */', '\\x41', '\\0', '\\n',
    ]
    const rows = await executeQuery(`SELECT ${chStringArrayLiteral(nasty)} AS a`, {})
    expect(rows[0].a).toEqual(nasty)
  })

  test('the reversed form matches reverse() on the server, including a non-ASCII value', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { chStringLiteral, chReversedLiteral } = await import('@/lib/clickhouse-literals')
    for (const v of ['ledger.com', 'é.com', 'пример.рф', "o'neil.com"]) {
      const [row] = await executeQuery(`SELECT reverse(${chStringLiteral(v)}) = ${chReversedLiteral(v)} AS same`, {})
      expect(Number(row.same), v).toBe(1)
    }
  })
})
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run __tests__/search-dictionary-script.test.ts __tests__/search-dictionary-parity.live.test.ts`
Expected: the script pins PASS; the live file is skipped (`describe.skipIf`), which Vitest reports as skipped, not failed.

Run: `npx tsc --noEmit`
Expected: no output. (`scripts/` and `__tests__/` are outside tsconfig's `include`; the tsx run in Task 10 type-strips them.)

- [ ] **Step 6: Commit**

```bash
git add scripts/build-search-dictionary.ts __tests__/search-dictionary-script.test.ts __tests__/search-dictionary-parity.live.test.ts
git commit -m "feat(search-dictionary): the supervised first-build script and a gated live parity and timing test

The live test drives the route itself with dictionary=0 as the reference, so the legacy SQL it compares against cannot drift; real search terms come from SDP_TERMS, never from the file.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The end-to-end rehearsal on the isolated stack

**Files:**
- Modify: `docker-compose.rehearsal.yml` (two env lines on the app)
- Modify: `__tests__/search-dictionary-wiring.test.ts` (one pin)
- Create: `scripts/e2e-search-dictionary.ts`

**Interfaces:**
- Consumes: the rebuilt app image (`docker compose build app`), the running rehearsal stack (`npx tsx scripts/e2e-alert-rehearsal.ts --keep`), and over HTTP the routes of Tasks 5 and 7.
- Produces: `npx tsx scripts/e2e-search-dictionary.ts` (about 8 minutes; exit 0 when every check passes, 1 when one fails, 2 when the stack is not ready).

What it proves that unit tests cannot: the production image starts the cron, the cron builds the dictionary on a FRESH install (init SQL, Atomic database), the route's answers equal the plain query's for every sort and Unique setting, rows are found that only the email-domain branch (including a non-ASCII domain and a blank-domain row) or a path-text host can reach, the caps and the byte cap fall back, a 76 KB inlined candidate list is accepted by ClickHouse, an import makes the dictionary stale and searches step aside without missing the new row, a dropped table falls back, and queries during the rebuild and swap never fail or return a different total.

- [ ] **Step 1: Write the failing pin**

Append to the `describe` in `__tests__/search-dictionary-wiring.test.ts` (before its final `})`):

```ts

  test('the rehearsal stack runs the cron fast, so scripts/e2e-search-dictionary.ts can watch the dictionary rebuild itself', () => {
    const compose = read('docker-compose.rehearsal.yml')
    expect(compose).toContain('SEARCH_DICT_CRON_MINUTES: "1"')
    expect(compose).toContain('SEARCH_DICT_SETTLE_SECONDS: "5"')
  })
```

Run: `npx vitest run __tests__/search-dictionary-wiring.test.ts`
Expected: FAIL on the new test.

- [ ] **Step 2: Add the rehearsal environment**

In `docker-compose.rehearsal.yml`, replace

```yaml
      IMPORT_STALL_TIMEOUT_MS: "30000"
```

with

```yaml
      IMPORT_STALL_TIMEOUT_MS: "30000"
      # lib/search-dictionary-cron.ts: a tick a minute and 5 s of quiet (production: 10 minutes and 120 s), so that
      # scripts/e2e-search-dictionary.ts can watch the dictionary build and rebuild itself in the production image.
      SEARCH_DICT_CRON_MINUTES: "1"
      SEARCH_DICT_SETTLE_SECONDS: "5"
```

Run: `npx vitest run __tests__/search-dictionary-wiring.test.ts __tests__/rehearsal-isolation.test.ts`
Expected: PASS (the isolation test still passes: no mount, name, network, volume or port changed).

- [ ] **Step 3: Write the rehearsal driver**

Create `scripts/e2e-search-dictionary.ts`:

```ts
/**
 * End-to-end scenarios for the domain search dictionary, against the ISOLATED rehearsal stack (docker-compose.rehearsal.yml: its own ClickHouse,
 * app and volumes; it shares nothing with the real stack). The app there runs the PRODUCTION image with its rebuild cron turned up to a tick a
 * minute, so the dictionary is built, found stale, and rebuilt by the app itself while this script watches.
 *
 *   docker compose build app
 *   npx tsx scripts/e2e-alert-rehearsal.ts --keep      # brings the stack up (about 4 minutes) and leaves it running
 *   npx tsx scripts/e2e-search-dictionary.ts           # about 8 minutes
 *   docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
 *
 * Every term is unique per run (the run id is in the name), so a re-run on the same stack does not pass vacuously. Exit 0 when every check passes,
 * 1 when one fails, 2 when the stack is not ready.
 */
import { execFileSync } from 'node:child_process'

const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const HOST = '127.0.0.1'
const PORT = 3101
const BASE = `http://${HOST}:${PORT}`
if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_') || PORT !== 3101) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

const RUN = Date.now().toString(36)
const TERM = `probe-wallet-${RUN}.test`
const CAP_TERM = `cap-probe-${RUN}.test`
const FIT_TERM = `fit-probe-${RUN}.test`
const BYTES_TERM = `bytes-probe-${RUN}.test`

const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}
const info = (label: string, value: unknown) => console.log(`  INFO  ${label}: ${value}`)

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-3).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}
// --async_insert=0: the default profile buffers inserts, and this script reads what it wrote straight away.
const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--max_query_size=10000000', '--query', sql])
const insert = (select: string) => chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name) ${select}`)

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 1000): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch { /* not yet */ }
    await sleep(intervalMs)
  }
  return null
}

let cookie = ''
async function login(): Promise<void> {
  const email = sh('docker', ['exec', APP, 'printenv', 'ADMIN_EMAIL'])
  const password = sh('docker', ['exec', APP, 'printenv', 'ADMIN_PASSWORD'])
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
  const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
  if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
  cookie = `auth=${auth}`
}

async function api(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const search = (term: string, extra = '') => api(`/api/credentials?q=${encodeURIComponent(term)}&limit=200&exclude_noise=1${extra}`)
const dictState = async (): Promise<any | null> => (await api('/api/monitoring/ingest-health')).body?.searchDictionary ?? null
const waitFresh = (timeoutMs = 300_000) => waitFor(async () => { const d = await dictState(); return d?.state === 'fresh' ? d : null }, timeoutMs, 3000)

/** Every page of a search by following the cursor; the dictionary plan or (legacy) today's query. */
async function walk(term: string, sort: string, dedupe: number, legacy: boolean) {
  const pages: any[] = []
  let cursor = ''
  for (let i = 0; i < 12; i++) {
    const r = await search(term, `&sort=${sort}&dedupe=${dedupe}&skip_totals=1${legacy ? '&dictionary=0' : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (r.status !== 200 || !r.body?.success) return { error: `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`, pages }
    pages.push(r.body)
    if (!r.body.next_cursor) break
    cursor = r.body.next_cursor
  }
  return { error: null as string | null, pages }
}

function seed(): void {
  const src = (name: string) => `'seed-${RUN}-${name}'`
  // the site, its subdomain, two lookalike hosts, a scheme-less URL with the term in its path
  insert(`SELECT 'https://${TERM}/login', concat('user', toString(number), '@mail-', toString(number % 7), '.test'), concat('Pw-', toString(number), '-Aa1!'), '${TERM}', ${src('site')}, '' FROM numbers(450)`)
  insert(`SELECT 'https://app.${TERM}/signin', concat('app', toString(number), '@mail.test'), concat('Ap-', toString(number)), 'app.${TERM}', ${src('sub')}, '' FROM numbers(30)`)
  insert(`SELECT 'https://${TERM}.phish.test/login', concat('ph', toString(number), '@mail.test'), concat('Ph-', toString(number)), 'phish.test', ${src('look')}, '' FROM numbers(20)`)
  insert(`SELECT 'https://secure-${TERM}-login.test/', concat('sl', toString(number), '@mail.test'), concat('Sl-', toString(number)), 'login-host.test', ${src('look')}, '' FROM numbers(20)`)
  insert(`SELECT 'login.example.test/${TERM}/signin', concat('pt', toString(number), '@mail.test'), concat('Pt-', toString(number)), 'login.example.test', ${src('path')}, '' FROM numbers(10)`)
  // rows only the email-domain branch can reach: an unrelated site, a blank domain, and a NON-ASCII email domain (reverse() is bytewise)
  insert(`SELECT 'https://other-site.test/', concat('x', toString(number), '@${TERM}'), concat('Xe-', toString(number)), 'other-site.test', ${src('email')}, '' FROM numbers(25)`)
  insert(`SELECT '', concat('y', toString(number), '@${TERM}'), concat('Ye-', toString(number)), '', ${src('blank')}, '' FROM numbers(5)`)
  insert(`SELECT 'https://other-site.test/', concat('z', toString(number), '@${TERM}.пример'), concat('Ze-', toString(number)), 'other-site.test', ${src('nonascii')}, '' FROM numbers(5)`)
  // duplicates of the first site rows (Unique collapses them), noise (Declutter hides it), and unrelated rows
  insert(`SELECT 'https://${TERM}/login', concat('user', toString(number), '@mail-', toString(number % 7), '.test'), concat('Pw-', toString(number), '-Aa1!'), '${TERM}', ${src('dup')}, '' FROM numbers(10)`)
  insert(`SELECT 'http://192.0.2.7/${TERM}/admin.php', concat('n', toString(number), '@mail.test'), concat('Nz-', toString(number)), '192.0.2.7', ${src('noise')}, '' FROM numbers(10)`)
  insert(`SELECT 'https://unrelated.test/', concat('u', toString(number), '@mail.test'), concat('Un-', toString(number)), 'unrelated.test', ${src('control')}, '' FROM numbers(200)`)
  // the caps: 3,200 candidate domains (over the 3,000 count cap), 2,000 that fit (a ~76 KB literal), 2,000 long ones (over the 90,000 byte cap)
  insert(`SELECT concat('https://cd', toString(number), '.${CAP_TERM}/login'), concat('c', toString(number), '@mail.test'), 'pw', concat('cd', toString(number), '.${CAP_TERM}'), ${src('cap')}, '' FROM numbers(3200)`)
  insert(`SELECT concat('https://fit', toString(number), '-pad.${FIT_TERM}/'), concat('f', toString(number), '@mail.test'), 'pw', concat('fit', toString(number), '-pad.${FIT_TERM}'), ${src('fit')}, '' FROM numbers(2000)`)
  insert(`SELECT concat('https://b', toString(number), '-', repeat('x', 50), '.${BYTES_TERM}/'), concat('b', toString(number), '@mail.test'), 'pw', concat('b', toString(number), '-', repeat('x', 50), '.${BYTES_TERM}'), ${src('bytes')}, '' FROM numbers(2000)`)
}

async function main(): Promise<number> {
  console.log(`run ${RUN}: term ${TERM}`)
  const ready = await waitFor(async () => (await fetch(`${BASE}/api/auth/check-users`)).status === 200, 20_000)
  if (!ready) { console.error('the rehearsal stack is not answering on 3101; start it with scripts/e2e-alert-rehearsal.ts --keep'); return 2 }
  await login()

  console.log('\n[1] seed, and the app builds the dictionary by itself')
  seed()
  info('rows seeded for the main term', chQuery(`SELECT count() FROM ulp.credentials WHERE source_file LIKE 'seed-${RUN}-%' AND (url_host LIKE '%${TERM}%' OR email_domain LIKE '%${TERM}%')`))
  const first = await waitFresh()
  check('the cron built the dictionary on a fresh install', !!first, JSON.stringify(await dictState()))
  if (!first) return 1
  info('dictionary', `${first.pairRows} host pairs, ${first.emailRows} email domains, ${first.bytes} bytes, built ${first.builtAt}`)
  check('Ingest Health reports its size', first.pairRows > 0 && first.emailRows > 0 && first.bytes > 0)

  console.log('\n[2] the dictionary plan returns exactly what the plain query returns')
  for (const sort of ['domain_asc', 'email_asc', 'pw_len_desc', 'imported_desc']) {
    for (const dedupe of [1, 0]) {
      const plain = await walk(TERM, sort, dedupe, true)
      const planned = await walk(TERM, sort, dedupe, false)
      const label = `${sort}, Unique ${dedupe}: ${plain.pages.length} pages`
      if (plain.error || planned.error) { check(label, false, plain.error ?? planned.error ?? ''); continue }
      const same = plain.pages.length === planned.pages.length
        && plain.pages.every((p, i) => JSON.stringify(p.results) === JSON.stringify(planned.pages[i].results) && p.next_cursor === planned.pages[i].next_cursor)
      check(`${label}, rows and cursors identical`, same)
      const expected = sort === 'imported_desc' ? ['dictionary', 'windows'] : ['dictionary']
      check(`${sort}, Unique ${dedupe}: answered by the ${expected.join(' or ')} plan`, expected.includes(planned.pages[0].plan), String(planned.pages[0].plan))
    }
  }
  const t1 = await api(`/api/credentials?q=${encodeURIComponent(TERM)}&exclude_noise=1&dedupe=1&totals_only=1`)
  const t0 = await api(`/api/credentials?q=${encodeURIComponent(TERM)}&exclude_noise=1&dedupe=1&totals_only=1&dictionary=0`)
  check('the totals equal the plain query\'s, both numbers', t1.body?.total === t0.body?.total && t1.body?.raw_total === t0.body?.raw_total, `${JSON.stringify(t1.body)} vs ${JSON.stringify(t0.body)}`)
  check('the totals came from the dictionary plan', t1.body?.plan === 'dictionary' && t0.body?.plan === 'plain')

  console.log('\n[3] rows only the email-domain branch or a path-text host can reach are found')
  const every = (await walk(TERM, 'email_asc', 0, false)).pages.flatMap(p => p.results as any[])
  check('a row with a non-ASCII email domain (reverse() is bytewise)', every.some(r => String(r.email).endsWith('.пример')))
  check('a row whose domain is blank', every.some(r => String(r.email).startsWith('y') && String(r.email).endsWith(`@${TERM}`)))
  check('a row on an unrelated site whose EMAIL domain is the term', every.some(r => r.domain === 'other-site.test'))
  check('a scheme-less URL with the term in its path', every.some(r => r.domain === 'login.example.test'))
  check('a lookalike host', every.some(r => r.domain === 'phish.test'))

  console.log('\n[4] the caps')
  const over = await walk(CAP_TERM, 'domain_asc', 1, false)
  check('3,200 candidate domains (over the 3,000 cap): today\'s query answers', over.pages[0]?.plan === 'plain', String(over.pages[0]?.plan))
  check('...and its rows are right', JSON.stringify(over.pages[0]?.results) === JSON.stringify((await walk(CAP_TERM, 'domain_asc', 1, true)).pages[0]?.results))
  const fit = await walk(FIT_TERM, 'domain_asc', 1, false)
  check('2,000 candidate domains in a ~76 KB inlined list: ClickHouse accepts it and the dictionary answers', fit.pages[0]?.plan === 'dictionary', fit.error ?? String(fit.pages[0]?.plan))
  check('...and its rows are identical to the plain query\'s', JSON.stringify(fit.pages[0]?.results) === JSON.stringify((await walk(FIT_TERM, 'domain_asc', 1, true)).pages[0]?.results))
  const bytes = await walk(BYTES_TERM, 'domain_asc', 1, false)
  check('2,000 long domains (over the 90,000-byte list cap): today\'s query answers', bytes.pages[0]?.plan === 'plain', String(bytes.pages[0]?.plan))

  console.log('\n[5] new data: the plan steps aside until the app has rebuilt, and no row is missed')
  const lateHost = `late.${TERM}`
  insert(`SELECT 'https://${lateHost}/', 'late-row@mail.test', 'Lt-1', '${lateHost}', 'seed-${RUN}-late', '' FROM numbers(1)`)
  const sawStale = await waitFor(async () => { const d = await dictState(); return d && d.state !== 'fresh' ? d : null }, 30_000, 500)
  check('an inserted row with a NEW domain makes the dictionary stale', !!sawStale, JSON.stringify(await dictState()))
  // The credentials route caches its freshness verdict for 3 s; a search inside that window could still use the old candidates (accepted: it needs
  // a single insert followed within 3 s by a search for a term whose new row has a new domain). Wait it out so this check is deterministic.
  await sleep(3500)
  const staleAnswer = await search(TERM, '&sort=domain_asc&dedupe=1&skip_totals=1')
  check('while stale the search is answered by today\'s query', staleAnswer.body?.plan === 'plain', String(staleAnswer.body?.plan))
  check('...and the new row is in it (a stale dictionary would have missed it)', (staleAnswer.body?.results ?? []).some((r: any) => r.domain === lateHost))
  const rebuilt = await waitFresh()
  check('the app rebuilt the dictionary by itself', !!rebuilt, JSON.stringify(await dictState()))
  const afterBuild = await walk(TERM, 'domain_asc', 1, false)
  check('then the dictionary answers again, with the new row in it', afterBuild.pages[0]?.plan === 'dictionary' && afterBuild.pages[0].results.some((r: any) => r.domain === lateHost))

  console.log('\n[6] a dictionary table dropped under a cached "fresh"')
  chQuery('DROP TABLE ulp.search_host_dict SYNC')
  const immediate = await search(TERM, '&sort=email_asc&dedupe=1&skip_totals=1')
  const reference = await search(TERM, '&sort=email_asc&dedupe=1&skip_totals=1&dictionary=0')
  // Right after the drop the answer may come from a candidate list the app already holds (still correct) or from the plain query (the lookup failed,
  // or the status already says missing), so only the ROWS are checked here; the plan is checked once the status has caught up.
  check('the answer is still right', immediate.status === 200 && JSON.stringify(immediate.body?.results) === JSON.stringify(reference.body?.results))
  const sawMissing = await waitFor(async () => { const d = await dictState(); return d?.state === 'missing' ? d : null }, 30_000, 500)
  check('the status reports the dropped table as missing', !!sawMissing, JSON.stringify(await dictState()))
  await sleep(3500)
  const whileMissing = await search(TERM, '&sort=email_asc&dedupe=1&skip_totals=1')
  check('while a table is missing the plain query answers, with the same rows', whileMissing.body?.plan === 'plain' && JSON.stringify(whileMissing.body?.results) === JSON.stringify(reference.body?.results), String(whileMissing.body?.plan))
  check('the app rebuilt the missing table', !!(await waitFresh()), JSON.stringify(await dictState()))

  console.log('\n[7] queries while the dictionary goes stale, rebuilds and is swapped in')
  const swapHost = `swap.${TERM}`
  insert(`SELECT 'https://${swapHost}/', 'swap-row@mail.test', 'Sw-1', '${swapHost}', 'seed-${RUN}-swap', '' FROM numbers(1)`)
  const expected = (await api(`/api/credentials?q=${encodeURIComponent(TERM)}&exclude_noise=1&dedupe=1&totals_only=1&dictionary=0`)).body
  await waitFor(async () => { const d = await dictState(); return d && d.state !== 'fresh' ? d : null }, 30_000, 500)
  await sleep(3500) // past the 3 s freshness cache, as in [5]
  const plans = new Set<string>()
  let requests = 0
  let wrong = 0
  const end = Date.now() + 240_000
  while (Date.now() < end) {
    const t = await api(`/api/credentials?q=${encodeURIComponent(TERM)}&exclude_noise=1&dedupe=1&totals_only=1`)
    requests++
    if (t.status !== 200 || !t.body?.success || t.body.total !== expected.total || t.body.raw_total !== expected.raw_total) wrong++
    plans.add(String(t.body?.plan))
    if (plans.has('plain') && plans.has('dictionary') && (await dictState())?.state === 'fresh') break
    await sleep(250)
  }
  check(`${requests} totals requests across the stale, rebuild and swap: every one succeeded with the right numbers`, wrong === 0 && requests > 10, `${wrong} wrong of ${requests}`)
  check('both plans answered during the run', plans.has('plain') && plans.has('dictionary'), [...plans].join(','))

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  return failed.length ? 1 : 0
}

main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 4: Check it parses and the isolation guard still holds**

Run: `npx esbuild scripts/e2e-search-dictionary.ts --log-level=error > /dev/null && echo parses`
Expected: `parses` (esbuild only strips the types; it never runs the script, which would start driving the stack).

Run: `npx vitest run __tests__/rehearsal-isolation.test.ts __tests__/search-dictionary-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.rehearsal.yml scripts/e2e-search-dictionary.ts __tests__/search-dictionary-wiring.test.ts
git commit -m "test(e2e): rehearse the search dictionary on the isolated stack, in the production image

Seeds lookalikes, path-text hosts, email-domain-only, blank-domain and non-ASCII rows plus three cap probes; the app's own cron builds, finds stale and rebuilds; parity with dictionary=0 for every sort; fallbacks; a swap under a request loop.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live acceptance, deploy, and the record

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-domain-search-dictionary-design.md` (status line), `docs/superpowers/plans/2026-10-03-domain-search-dictionary.md` (tick the boxes)
- No code. The live ClickHouse tables `ulp.search_host_dict` and `ulp.search_emaildomain_dict` are CREATED (derived, rebuildable); `ulp.credentials` is only read.

Standing permissions apply (build and create freely; the deploy is local-only on this laptop; merge to main and push once verified). Do NOT run an unscoped `docker prune`: this Docker daemon also runs another project's stack. Docker's global config is broken on this machine (`credsStore`), so every `docker compose build` and `up` below uses a scoped `DOCKER_CONFIG`.

- [ ] **Step 1: Full verification on the branch**

```bash
cd /home/cole/ulp-suite
npx tsc --noEmit && npm run lint && npx vitest run
```
Expected: no type errors; lint clean; every test file passes (the live files are skipped).

- [ ] **Step 2: Tag the running image as the rollback, then build the new one**

```bash
cd /home/cole/ulp-suite
SCR=/tmp/claude-1000/-home-cole-ulp-suite/ecdbe909-7de3-4a15-aea2-37a7d3b0573d/scratchpad
mkdir -p $SCR/dockercfg && echo '{}' > $SCR/dockercfg/config.json
docker tag ulp-suite-app:latest ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz)
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep ulp-suite-app
DOCKER_CONFIG=$SCR/dockercfg docker compose build app 2>&1 | tail -15
```
Expected: the rollback tag lists the OLD image id (it was `2d6ba2bcf747`); the build ends with the app image tagged `ulp-suite-app:latest` and a NEW id; the running container is untouched.

- [ ] **Step 3: The three rehearsals on the isolated stack (the live app is not involved)**

```bash
cd /home/cole/ulp-suite
npx tsx scripts/e2e-alert-rehearsal.ts --keep          # about 4 minutes; expect all checks PASS (32/32 before this work)
npx tsx scripts/e2e-upload-resilience.ts               # about 6 minutes; expect 33/33
npx tsx scripts/e2e-search-dictionary.ts               # about 8 minutes; expect "N/N checks passed", exit 0
docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v
```
Expected: all three exit 0. If a check in `e2e-search-dictionary.ts` fails, STOP: fix the cause (do not weaken the check), rebuild the image (Step 2) and re-run from the failed script. Run each in the background with a log file if the tool's time limit is short, and wait for a final-line sentinel rather than polling for a process name.

- [ ] **Step 4: The supervised first build on the LIVE ClickHouse (before the deploy)**

Pick a quiet moment: `docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT count() FROM system.processes WHERE query_kind = 'Insert'"` should be 0 and the dedup/projection ticks (04:00Z, 05:00Z) should not be near. The old app image does not know the dictionary, so building it first has no effect on searches.

```bash
cd /home/cole/ulp-suite
SCR=/tmp/claude-1000/-home-cole-ulp-suite/ecdbe909-7de3-4a15-aea2-37a7d3b0573d/scratchpad   # use this session's scratchpad directory
IP=$(docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
export CLICKHOUSE_HOST=http://$IP:8123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD= CLICKHOUSE_DATABASE=ulp
npx tsx scripts/build-search-dictionary.ts --status       # expect "status: missing", exit 1
npx tsx scripts/build-search-dictionary.ts > $SCR/first-build.log 2>&1; echo "exit $?" >> $SCR/first-build.log   # run in the background; about 2.5 minutes
tail -5 $SCR/first-build.log
```
Expected: the log ends with `result: {"pairRows":~85000000,"emailRows":~13000000,...}`, `status after the build: fresh`, `exit 0`. Then confirm on the server: `docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT name, total_rows, formatReadableSize(total_bytes), substring(comment, 1, 80) FROM system.tables WHERE database='ulp' AND name LIKE 'search_%'"` shows exactly the two tables (no `__new` leftovers), about 2 GiB and 150 MiB, and `docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT count() FROM system.tables WHERE database='ulp' AND name LIKE 'zz_%'"` is 0.

- [ ] **Step 5: Live parity and the timings of the design**

```bash
cd /home/cole/ulp-suite
SDP_PARITY=1 npx vitest run __tests__/search-dictionary-parity.live.test.ts 2>&1 | tail -60
```
Expected: PASS for the freshness test, the literal round trip, and every scenario (3 public terms and one that matches nothing, three sorts, Unique on and off, two pages, and totals), and the printed table shows, for the public terms with a few dozen candidates (`trezor.io`) a dictionary first page of about 2 s and totals under 1 s, and for `ledger.com` and `kraken.com` (hundreds of candidates) a first page under 4 s and totals under 2 s; non-domain sorts of a rare term in well under 2 s once looked up. Any difference in rows, cursor or total is a failure to fix, not to tolerate. Then the popular-term fallback:

```bash
SDP_PARITY=1 SDP_TERMS=google.com SDP_LEGACY_TERMS=google.com SDP_SORTS=domain_asc SDP_DEDUPES=1 SDP_PAGES=1 npx vitest run __tests__/search-dictionary-parity.live.test.ts -t 'google.com' 2>&1 | tail -15
```
Expected: PASS with `plain` as the plan (158,010 candidate domains are far over the cap; the plain query takes about 8-60 s here).

If the timings are well off the spec's table for a term within the caps, try the one alternative the measurements left open before accepting: add `optimize_use_projections = 0` to the outer SETTINGS of `buildDictionaryTotalsSql` (the offset sub-select keeps its own `= 1`), re-run the totals part, keep whichever is faster, and update the unit test that pins the choice.

- [ ] **Step 6: Deploy locally, behind the rollback tag**

```bash
cd /home/cole/ulp-suite
SCR=/tmp/claude-1000/-home-cole-ulp-suite/ecdbe909-7de3-4a15-aea2-37a7d3b0573d/scratchpad
DOCKER_CONFIG=$SCR/dockercfg docker compose up -d --no-deps app 2>&1 | tail -5
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep ulpsuite_app
curl -s -o /dev/null -w 'check-users %{http_code}\n' http://127.0.0.1:3000/api/auth/check-users
docker logs ulpsuite_app 2>&1 | grep -E 'search-dictionary|error|warn' | head
```
Expected: only `ulpsuite_app` was recreated (the ClickHouse container's uptime is unchanged); it is healthy; `check-users 200`; the log shows `[search-dictionary] cron started — first tick in 120s, then every 10m` and no error or warn line. Wait three minutes, then `docker logs ulpsuite_app 2>&1 | grep search-dictionary` still shows no build line (the dictionary was fresh at the first tick) and `docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT count() FROM system.processes WHERE log_comment = 'search_dict_build'"` is 0. Rollback if anything is off: `docker tag ulp-suite-app:rollback-<stamp> ulp-suite-app:latest && DOCKER_CONFIG=$SCR/dockercfg docker compose up -d --no-deps app`, or set `SEARCH_DICTIONARY=0` in `.env` and recreate.

- [ ] **Step 7: Record it and merge**

Tick every box of this plan (`sed -i 's/- \[ \]/- [x]/g' docs/superpowers/plans/2026-10-03-domain-search-dictionary.md`), change the spec's `Status: **designed, not built.**` line to `Status: **implemented and deployed locally 2026-10-03** (image <new id>, rollback tag ulp-suite-app:rollback-<stamp>; plan docs/superpowers/plans/2026-10-03-domain-search-dictionary.md)`, append a short "Release" paragraph with the measured parity and the first-page and totals timings from Step 5, then:

```bash
cd /home/cole/ulp-suite
git add docs/superpowers/specs/2026-10-03-domain-search-dictionary-design.md docs/superpowers/plans/2026-10-03-domain-search-dictionary.md
git commit -m "docs: mark the search dictionary implemented and record the release

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git switch main && git merge --ff-only feat/search-dictionary && git push origin main
gh run list --limit 2
```
Expected: the fast-forward merge succeeds, the push goes through, and the CI run for the new HEAD turns green (it runs `npm ci`, typecheck, tests and lint; the live and rehearsal files do not run there).

Follow-up the owner can see for themselves: the next day, after the 05:00Z projection-clearing mutation has run, `scripts/build-search-dictionary.ts --status` must still say `fresh` (it proves the parenthesis-aware mutation exclusion on the live server). Record the first-build time, the timings and that follow-up in the project memory.
