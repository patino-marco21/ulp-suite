# Parser & Monitor Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add block-format stealer log parsing, fix N+1 SQLite in monitor rescan, add NORM_COLS to rescan query, support pipe as a primary field separator, stream CSV inserts row-by-row, and percent-decode URL-encoded passwords.

**Architecture:** All parser changes live in `lib/ulp-parser.ts` with exported helpers; the block state machine is integrated into the existing `parseULPContent`/`parseULPStream` hybrid loop so both inline-ULP and block-format lines are handled in a single pass. Monitor fixes are isolated to `lib/monitor-rescan-cron.ts`. Upload route streaming fix is in `app/api/upload/route.ts`.

**Tech Stack:** TypeScript, Vitest, Node.js `stream.Readable`, ClickHouse JS client, better-sqlite3

---

## File Map

| File | Change |
|---|---|
| `lib/ulp-parser.ts` | Export `extractDomain`; add block helpers (`BlockState`, `BlockField`, `classifyBlockLabel`, `isBlockSeparator`, `makeBlockState`, `flushBlockState`, `parseBlockLine`, `parseBlockContent`, `parseBlockStream`); add pipe separator; add percent-decode; integrate block hybrid into `parseULPContent` + `parseULPStream` |
| `__tests__/ulp-parser-block.test.ts` | New — 30+ tests for block-format parsing |
| `__tests__/ulp-parser-extended.test.ts` | Add §15 — pipe separator tests |
| `lib/monitor-rescan-cron.ts` | Fix N+1 SQLite; add `NORM_DOMAIN_EXPR` to ClickHouse WHERE |
| `app/api/upload/route.ts` | Replace `csvRows` string materialisation with generator-based Readable |

---

## Task 1 — Block parser core helpers

**Files:**
- Modify: `lib/ulp-parser.ts` (after `extractDomain`, before `colonSplit`)
- Create: `__tests__/ulp-parser-block.test.ts`

### Step 1.1 — Write the failing tests for `classifyBlockLabel`

- [ ] Create `__tests__/ulp-parser-block.test.ts` with this content:

```typescript
/**
 * Tests for block-format stealer log parsing (Raccoon/Stealc/Meta/Vidar style).
 * These stealers produce labeled multiline blocks instead of inline ULP lines.
 */

import { describe, test, expect } from 'vitest'
import {
  classifyBlockLabel,
  isBlockSeparator,
  makeBlockState,
  flushBlockState,
  parseBlockLine,
  parseBlockContent,
  type BlockState,
} from '@/lib/ulp-parser'

const src = 'block-test.txt'

// ─────────────────────────────────────────────────────────────────────────────
// §A  classifyBlockLabel
// ─────────────────────────────────────────────────────────────────────────────

describe('§A classifyBlockLabel', () => {

  describe('url aliases', () => {
    test('Host: https://site.com → {field:url, value:https://site.com}', () => {
      expect(classifyBlockLabel('Host: https://site.com')).toEqual({ field: 'url', value: 'https://site.com' })
    })
    test('URL: https://site.com → url', () => {
      expect(classifyBlockLabel('URL: https://site.com')).toEqual({ field: 'url', value: 'https://site.com' })
    })
    test('Hostname: site.com → url', () => {
      expect(classifyBlockLabel('Hostname: site.com')).toEqual({ field: 'url', value: 'site.com' })
    })
    test('host: (lowercase) → url', () => {
      expect(classifyBlockLabel('host: http://example.com')).toEqual({ field: 'url', value: 'http://example.com' })
    })
    test('HOST: (uppercase) → url', () => {
      expect(classifyBlockLabel('HOST: https://example.com')).toEqual({ field: 'url', value: 'https://example.com' })
    })
    test('Host: (empty value) → {field:url, value:""}', () => {
      expect(classifyBlockLabel('Host:')).toEqual({ field: 'url', value: '' })
    })
  })

  describe('login aliases', () => {
    test('Login: user@example.com → login', () => {
      expect(classifyBlockLabel('Login: user@example.com')).toEqual({ field: 'login', value: 'user@example.com' })
    })
    test('Username: player99 → login', () => {
      expect(classifyBlockLabel('Username: player99')).toEqual({ field: 'login', value: 'player99' })
    })
    test('User: alice → login', () => {
      expect(classifyBlockLabel('User: alice')).toEqual({ field: 'login', value: 'alice' })
    })
    test('USER: BOB (uppercase) → login', () => {
      expect(classifyBlockLabel('USER: BOB')).toEqual({ field: 'login', value: 'BOB' })
    })
    test('user: (lowercase key) → login', () => {
      expect(classifyBlockLabel('user: alice')).toEqual({ field: 'login', value: 'alice' })
    })
  })

  describe('password aliases', () => {
    test('Password: P@ssword123 → password', () => {
      expect(classifyBlockLabel('Password: P@ssword123')).toEqual({ field: 'password', value: 'P@ssword123' })
    })
    test('Pass: abc123 → password', () => {
      expect(classifyBlockLabel('Pass: abc123')).toEqual({ field: 'password', value: 'abc123' })
    })
    test('Pwd: secret → password', () => {
      expect(classifyBlockLabel('Pwd: secret')).toEqual({ field: 'password', value: 'secret' })
    })
    test('PASSWORD: (uppercase) → password', () => {
      expect(classifyBlockLabel('PASSWORD: hunter2')).toEqual({ field: 'password', value: 'hunter2' })
    })
    test('PASS: (uppercase) → password', () => {
      expect(classifyBlockLabel('PASS: hunter2')).toEqual({ field: 'password', value: 'hunter2' })
    })
  })

  describe('soft/metadata aliases', () => {
    test('Soft: Google Chrome [Default] → soft', () => {
      expect(classifyBlockLabel('Soft: Google Chrome [Default]')).toEqual({ field: 'soft', value: 'Google Chrome [Default]' })
    })
    test('Application: Firefox → soft', () => {
      expect(classifyBlockLabel('Application: Firefox')).toEqual({ field: 'soft', value: 'Firefox' })
    })
    test('browser: Edge → soft', () => {
      expect(classifyBlockLabel('browser: Edge')).toEqual({ field: 'soft', value: 'Edge' })
    })
  })

  describe('non-labels → null', () => {
    test('random: line → null', () => {
      expect(classifyBlockLabel('random: line')).toBeNull()
    })
    test('no colon at all → null', () => {
      expect(classifyBlockLabel('just some text')).toBeNull()
    })
    test('https://site.com → null (URL is not a label)', () => {
      expect(classifyBlockLabel('https://site.com')).toBeNull()
    })
    test('======== separator → null', () => {
      expect(classifyBlockLabel('========================')).toBeNull()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §B  isBlockSeparator
// ─────────────────────────────────────────────────────────────────────────────

describe('§B isBlockSeparator', () => {
  test('empty string → true', () => { expect(isBlockSeparator('')).toBe(true) })
  test('=== line → true', () => { expect(isBlockSeparator('==========================')).toBe(true) })
  test('--- line → true', () => { expect(isBlockSeparator('----------------------------')).toBe(true) })
  test('>>> line → true', () => { expect(isBlockSeparator('>>>>>>>')).toBe(true) })
  test('mixed === → true', () => { expect(isBlockSeparator('===')).toBe(true) })
  test('regular text → false', () => { expect(isBlockSeparator('Host: example.com')).toBe(false) })
  test('https URL → false', () => { expect(isBlockSeparator('https://example.com')).toBe(false) })
  test('single char = → false (too short)', () => { expect(isBlockSeparator('=')).toBe(false) })
})

// ─────────────────────────────────────────────────────────────────────────────
// §C  flushBlockState
// ─────────────────────────────────────────────────────────────────────────────

describe('§C flushBlockState', () => {
  test('complete state → ULPCredential with correct fields', () => {
    const state: BlockState = { url: 'https://roblox.com/login', login: 'player@gmail.com', password: 'P@ssword123' }
    const c = flushBlockState(state, src)
    expect(c).not.toBeNull()
    expect(c!.url).toBe('https://roblox.com/login')
    expect(c!.email).toBe('player@gmail.com')
    expect(c!.password).toBe('P@ssword123')
    expect(c!.domain).toBe('roblox.com')
    expect(c!.source_file).toBe(src)
  })

  test('missing login → null', () => {
    const state: BlockState = { url: 'https://site.com', login: '', password: 'pass123' }
    expect(flushBlockState(state, src)).toBeNull()
  })

  test('missing password → null', () => {
    const state: BlockState = { url: 'https://site.com', login: 'user', password: '' }
    expect(flushBlockState(state, src)).toBeNull()
  })

  test('password < 3 chars → null', () => {
    const state: BlockState = { url: 'https://site.com', login: 'user', password: 'ab' }
    expect(flushBlockState(state, src)).toBeNull()
  })

  test('login === password → null', () => {
    const state: BlockState = { url: 'https://site.com', login: 'same', password: 'same' }
    expect(flushBlockState(state, src)).toBeNull()
  })

  test('missing url → domain fallback to email domain', () => {
    const state: BlockState = { url: '', login: 'user@gmail.com', password: 'mypassword1' }
    const c = flushBlockState(state, src)
    expect(c).not.toBeNull()
    expect(c!.url).toBe('')
    expect(c!.domain).toBe('gmail.com')
  })

  test('missing url + non-email login → domain empty', () => {
    const state: BlockState = { url: '', login: 'localuser', password: 'mypassword1' }
    const c = flushBlockState(state, src)
    expect(c).not.toBeNull()
    expect(c!.domain).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §D  parseBlockLine — state machine transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('§D parseBlockLine', () => {
  test('Host line → returns "field", sets state.url', () => {
    const state = makeBlockState()
    const result = parseBlockLine('Host: https://site.com', state)
    expect(result).toBe('field')
    expect(state.url).toBe('https://site.com')
  })

  test('Login line → returns "field", sets state.login', () => {
    const state = makeBlockState()
    const result = parseBlockLine('Login: user@site.com', state)
    expect(result).toBe('field')
    expect(state.login).toBe('user@site.com')
  })

  test('Password line → returns "field", sets state.password', () => {
    const state = makeBlockState()
    const result = parseBlockLine('Password: hunter2pass', state)
    expect(result).toBe('field')
    expect(state.password).toBe('hunter2pass')
  })

  test('Soft line → returns "field", does NOT change url/login/password', () => {
    const state = makeBlockState()
    const result = parseBlockLine('Soft: Chrome', state)
    expect(result).toBe('field')
    expect(state.url).toBe('')
    expect(state.login).toBe('')
    expect(state.password).toBe('')
  })

  test('separator line → returns "separator"', () => {
    const state = makeBlockState()
    const result = parseBlockLine('======================', state)
    expect(result).toBe('separator')
  })

  test('blank line → returns "separator"', () => {
    const state = makeBlockState()
    expect(parseBlockLine('', state)).toBe('separator')
  })

  test('unrecognised line → returns "ignored"', () => {
    const state = makeBlockState()
    expect(parseBlockLine('some random text 123', state)).toBe('ignored')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §E  parseBlockContent — full integration
// ─────────────────────────────────────────────────────────────────────────────

describe('§E parseBlockContent', () => {
  test('single complete block → 1 credential', () => {
    const content = [
      'Soft: Chrome',
      'Host: https://roblox.com/login',
      'Login: player@gmail.com',
      'Password: P@ssword123!',
      '=============================',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].url).toBe('https://roblox.com/login')
    expect(result.credentials[0].email).toBe('player@gmail.com')
    expect(result.credentials[0].password).toBe('P@ssword123!')
    expect(result.credentials[0].domain).toBe('roblox.com')
  })

  test('two blocks separated by === → 2 credentials', () => {
    const content = [
      'Host: https://site1.com',
      'Login: alice@gmail.com',
      'Password: alicepass1',
      '================',
      'Host: https://site2.com',
      'Login: bob@gmail.com',
      'Password: bobpass123',
      '================',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(2)
    expect(result.credentials[0].email).toBe('alice@gmail.com')
    expect(result.credentials[1].email).toBe('bob@gmail.com')
  })

  test('two blocks separated by blank line → 2 credentials', () => {
    const content = [
      'Host: https://site1.com',
      'Login: alice@gmail.com',
      'Password: alicepass1',
      '',
      'Host: https://site2.com',
      'Login: bob@gmail.com',
      'Password: bobpass123',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(2)
  })

  test('block missing password → 0 credentials (incomplete)', () => {
    const content = [
      'Host: https://site.com',
      'Login: user@example.com',
      '================',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(0)
  })

  test('block missing url → credential with url="" and domain from email', () => {
    const content = [
      'Login: user@example.com',
      'Password: mypassword123',
      '================',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].url).toBe('')
    expect(result.credentials[0].domain).toBe('example.com')
  })

  test('last block without trailing separator → still emitted', () => {
    const content = [
      'Host: https://site.com',
      'Login: user@example.com',
      'Password: mypassword123',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(1)
  })

  test('source_file set on every credential', () => {
    const content = 'Host: https://site.com\nLogin: u@e.com\nPassword: pass123\n===\n'
    const result = parseBlockContent(content, 'myfile.txt')
    expect(result.credentials[0].source_file).toBe('myfile.txt')
  })

  test('fields in any order (Password before Login before Host)', () => {
    const content = [
      'Password: hunter2pass',
      'Login: user@site.com',
      'Host: https://site.com',
      '===',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].email).toBe('user@site.com')
    expect(result.credentials[0].password).toBe('hunter2pass')
  })
})
```

- [ ] Run tests to confirm they all fail (functions not yet exported)

```
cd C:\Users\coler\Desktop\vault-refactor\bron-vault
npx vitest run __tests__/ulp-parser-block.test.ts 2>&1 | tail -15
```

Expected: multiple FAIL — "is not a function" or "does not provide an export named"

---

### Step 1.2 — Export `extractDomain` and add block helpers to `lib/ulp-parser.ts`

- [ ] In `lib/ulp-parser.ts`, change line 47 from `function extractDomain` to `export function extractDomain`:

```typescript
export function extractDomain(url: string): string {
```

- [ ] Add these type and helper definitions to `lib/ulp-parser.ts` after the `extractDomain` function (before `colonSplit`, around line 62):

```typescript
// ── Block-format parser (Raccoon / Stealc / Meta / Vidar style) ──────────────

export type BlockField = 'url' | 'login' | 'password' | 'soft'

export interface BlockState {
  url:      string
  login:    string
  password: string
}

const BLOCK_URL_LABELS   = new Set(['host', 'url', 'hostname'])
const BLOCK_LOGIN_LABELS = new Set(['login', 'username', 'user'])
const BLOCK_PASS_LABELS  = new Set(['password', 'pass', 'pwd'])
const BLOCK_SOFT_LABELS  = new Set(['soft', 'application', 'browser', 'app'])

/**
 * If `trimmed` is a labeled block field (e.g. "Host: https://..."), return its
 * field type and value.  Matching is case-insensitive on the label.
 * Returns null for non-labeled lines.
 */
export function classifyBlockLabel(
  trimmed: string,
): { field: BlockField; value: string } | null {
  const colon = trimmed.indexOf(':')
  if (colon === -1) return null
  const label = trimmed.slice(0, colon).trim().toLowerCase()
  const value = trimmed.slice(colon + 1).trim()
  if (BLOCK_URL_LABELS.has(label))   return { field: 'url',      value }
  if (BLOCK_LOGIN_LABELS.has(label)) return { field: 'login',    value }
  if (BLOCK_PASS_LABELS.has(label))  return { field: 'password', value }
  if (BLOCK_SOFT_LABELS.has(label))  return { field: 'soft',     value }
  return null
}

/**
 * Returns true if this line signals end-of-block:
 * blank line, or a run of 3+ identical separator characters (=, -, >).
 */
export function isBlockSeparator(trimmed: string): boolean {
  if (!trimmed) return true
  return trimmed.length >= 3 && /^[=\->]{3,}$/.test(trimmed)
}

/** Returns a fresh empty BlockState. */
export function makeBlockState(): BlockState {
  return { url: '', login: '', password: '' }
}

/**
 * Flush `state` into a ULPCredential if it satisfies validation rules.
 * Returns null if login is empty, password is absent/too-short, or login===password.
 */
export function flushBlockState(
  state: BlockState,
  sourceFile: string,
): ULPCredential | null {
  const { url, login, password } = state
  if (!login)                           return null
  if (!password || password.length < 3) return null
  if (login === password)               return null
  const domain = url
    ? extractDomain(url)
    : (login.includes('@') ? login.split('@').pop()!.toLowerCase() : '')
  return { url, email: login, password, domain, source_file: sourceFile }
}

/**
 * Process one line against a mutable BlockState.
 *
 * - 'field'     — line was a labeled field; state has been updated.
 * - 'separator' — line is a block separator; caller should flush state.
 * - 'ignored'   — line was neither a label nor a separator.
 */
export function parseBlockLine(
  line:  string,
  state: BlockState,
): 'field' | 'separator' | 'ignored' {
  const trimmed = line.trim()
  const labeled = classifyBlockLabel(trimmed)
  if (labeled) {
    if (labeled.field === 'url')      state.url      = labeled.value
    if (labeled.field === 'login')    state.login    = labeled.value
    if (labeled.field === 'password') state.password = labeled.value
    // 'soft' is metadata — intentionally not stored
    return 'field'
  }
  if (isBlockSeparator(trimmed)) return 'separator'
  return 'ignored'
}

/** Parse a string of pure block-format content. */
export function parseBlockContent(content: string, sourceFile: string): ParseResult {
  const lines       = content.split('\n')
  const credentials: ULPCredential[] = []
  const breakdown   = makeRejectionMap()
  let   skipped     = 0
  let   state       = makeBlockState()

  function tryFlush() {
    const cred = flushBlockState(state, sourceFile)
    if (cred) {
      credentials.push(cred)
    } else if (state.url || state.login || state.password) {
      skipped++
      if (!state.login || !state.password) breakdown.no_fields++
      else breakdown.no_password++
    }
    state = makeBlockState()
  }

  for (const line of lines) {
    const result = parseBlockLine(line, state)
    if (result === 'separator') tryFlush()
    // 'field' and 'ignored' — state already updated or line irrelevant
  }
  tryFlush()  // flush final block

  return { credentials, skipped, errors: 0, rejection_breakdown: breakdown }
}

/** Streaming block-format parser — yields batches of credentials. */
export async function* parseBlockStream(
  stream:    ReadableStream<Uint8Array>,
  filename:  string,
  batchSize: number,
): AsyncGenerator<StreamBatch> {
  const reader  = stream.getReader()
  const decoder = new TextDecoder()
  let   buffer  = ''
  let   batch:  ULPCredential[] = []
  let   batchRejected = 0
  let   batchBreakdown: Record<RejectionReason, number> = { blank: 0, no_fields: 0, no_password: 0 }
  let   state   = makeBlockState()

  function flushBatch(): StreamBatch {
    const out: StreamBatch = { credentials: batch, rejected: batchRejected, breakdown: batchBreakdown }
    batch = []; batchRejected = 0
    batchBreakdown = { blank: 0, no_fields: 0, no_password: 0 }
    return out
  }

  function tryFlushBlock() {
    const cred = flushBlockState(state, filename)
    if (cred) {
      batch.push(cred)
    } else if (state.url || state.login || state.password) {
      batchRejected++
      if (!state.login || !state.password) batchBreakdown.no_fields++
      else batchBreakdown.no_password++
    }
    state = makeBlockState()
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const result = parseBlockLine(line, state)
        if (result === 'separator') {
          tryFlushBlock()
          if (batch.length >= batchSize) yield flushBatch()
        }
      }
    }
    if (buffer) {
      const result = parseBlockLine(buffer, state)
      if (result === 'separator') tryFlushBlock()
    }
    tryFlushBlock()  // flush final incomplete block
    if (batch.length > 0 || batchRejected > 0) yield flushBatch()
  } finally {
    reader.releaseLock()
  }
}
```

- [ ] Run the block tests:

```
npx vitest run __tests__/ulp-parser-block.test.ts 2>&1 | tail -15
```

Expected: all pass

- [ ] Run the full suite to confirm no regressions:

```
npx vitest run 2>&1 | tail -10
```

Expected: all previous tests still pass

- [ ] Commit:

```
git add lib/ulp-parser.ts __tests__/ulp-parser-block.test.ts
git commit -m "feat(parser): add block-format stealer log parser (Raccoon/Stealc/Meta/Vidar)"
```

---

## Task 2 — Integrate block parsing into `parseULPContent` + `parseULPStream`

Block labeled lines (Host:, Login:, Password:) currently reach `parseLine` and produce false-positive credentials (`email='Login'`, `password=' user@site.com'`). The hybrid loop intercepts labeled lines and separator lines _before_ calling `parseLine`, so block-format files are parsed correctly and mixed files work in a single pass.

**Files:**
- Modify: `lib/ulp-parser.ts` — `parseULPContent` and `parseULPStream`

### Step 2.1 — Update `parseULPContent`

- [ ] Replace the entire `parseULPContent` function (lines ~244–261) with:

```typescript
export function parseULPContent(content: string, sourceFile: string): ParseResult {
  const lines       = content.split('\n')
  const credentials: ULPCredential[] = []
  const breakdown   = makeRejectionMap()
  let   skipped     = 0
  let   blockState  = makeBlockState()

  function tryFlushBlock() {
    const cred = flushBlockState(blockState, sourceFile)
    if (cred) {
      credentials.push(cred)
    } else if (blockState.url || blockState.login || blockState.password) {
      skipped++
      if (!blockState.login || !blockState.password) breakdown.no_fields++
      else breakdown.no_password++
    }
    blockState = makeBlockState()
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // Block labeled field — intercept before inline parseLine to prevent false positives
    const labeled = classifyBlockLabel(trimmed)
    if (labeled) {
      if (labeled.field === 'url')      blockState.url      = labeled.value
      if (labeled.field === 'login')    blockState.login    = labeled.value
      if (labeled.field === 'password') blockState.password = labeled.value
      continue
    }

    // Block separator — flush accumulated block state if any fields present
    if (isBlockSeparator(trimmed)) {
      if (blockState.url || blockState.login || blockState.password) {
        tryFlushBlock()
      } else {
        // Plain blank line with no block state → count as inline blank
        skipped++
        breakdown.blank++
      }
      continue
    }

    // Inline parseLine (non-labeled, non-separator lines)
    const { credential, reason } = parseLine(line, sourceFile)
    if (credential) {
      credentials.push(credential)
    } else {
      skipped++
      if (reason && reason in breakdown) breakdown[reason]++
    }
  }

  tryFlushBlock()  // flush any trailing incomplete block at EOF

  return { credentials, skipped, errors: 0, rejection_breakdown: breakdown }
}
```

### Step 2.2 — Update `parseULPStream`

- [ ] Replace the entire `parseULPStream` function (lines ~269–324) with:

```typescript
export async function* parseULPStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  batchSize: number,
): AsyncGenerator<StreamBatch> {
  const reader  = stream.getReader()
  const decoder = new TextDecoder()
  let   buffer  = ''
  let   batch:  ULPCredential[] = []
  let   batchRejected = 0
  let   batchBreakdown: Record<RejectionReason, number> = { blank: 0, no_fields: 0, no_password: 0 }
  let   blockState = makeBlockState()

  function flushBatch(): StreamBatch {
    const out: StreamBatch = { credentials: batch, rejected: batchRejected, breakdown: batchBreakdown }
    batch = []; batchRejected = 0
    batchBreakdown = { blank: 0, no_fields: 0, no_password: 0 }
    return out
  }

  function tryFlushBlock() {
    const cred = flushBlockState(blockState, filename)
    if (cred) {
      batch.push(cred)
    } else if (blockState.url || blockState.login || blockState.password) {
      batchRejected++
      if (!blockState.login || !blockState.password) batchBreakdown.no_fields++
      else batchBreakdown.no_password++
    }
    blockState = makeBlockState()
  }

  function processLine(line: string) {
    const trimmed = line.trim()

    const labeled = classifyBlockLabel(trimmed)
    if (labeled) {
      if (labeled.field === 'url')      blockState.url      = labeled.value
      if (labeled.field === 'login')    blockState.login    = labeled.value
      if (labeled.field === 'password') blockState.password = labeled.value
      return
    }

    if (isBlockSeparator(trimmed)) {
      if (blockState.url || blockState.login || blockState.password) {
        tryFlushBlock()
      } else {
        batchRejected++
        batchBreakdown.blank++
      }
      return
    }

    const { credential, reason } = parseLine(line, filename)
    if (credential) {
      batch.push(credential)
    } else {
      batchRejected++
      if (reason) batchBreakdown[reason]++
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        processLine(line)
        if (batch.length >= batchSize) yield flushBatch()
      }
    }
    if (buffer) processLine(buffer)
    tryFlushBlock()  // flush trailing block at EOF
    if (batch.length > 0 || batchRejected > 0) yield flushBatch()
  } finally {
    reader.releaseLock()
  }
}
```

### Step 2.3 — Run full test suite

- [ ] Run all tests:

```
npx vitest run 2>&1 | tail -15
```

Expected: all pass. The §7 "label-line false-positive audit" tests in `ulp-parser-extended.test.ts` test `parseLine` directly — those tests remain valid because `parseLine` itself is unchanged; only the hybrid batch loop intercepts labels.

- [ ] Commit:

```
git add lib/ulp-parser.ts
git commit -m "feat(parser): integrate block-format hybrid loop into parseULPContent + parseULPStream"
```

---

## Task 3 — N+1 SQLite fix + NORM_DOMAIN_EXPR in monitor rescan

**Files:**
- Modify: `lib/monitor-rescan-cron.ts` lines ~69–111 (runTick function)

The current code queries `SELECT 1 FROM monitor_credential_seen WHERE monitor_id = ? AND fingerprint = ?` once per credential in a `.filter()` loop, producing N SQLite round-trips per monitor tick. Replace with a single `WHERE fingerprint IN (...)` query. Separately, the ClickHouse domain query uses the raw `domain` column which misses Cases A–D corrupted rows; fix by using `NORM_DOMAIN_EXPR`.

### Step 3.1 — Add `NORM_DOMAIN_EXPR` import

- [ ] In `lib/monitor-rescan-cron.ts`, add this import at the top (after existing imports):

```typescript
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'
```

### Step 3.2 — Replace the ClickHouse query and the N+1 filter

- [ ] Replace the `runTick` function body — specifically the section that queries ClickHouse and filters unseen rows (lines ~88–133). Find this block:

```typescript
      // Query ClickHouse across ALL source files (not scoped to a single upload)
      const matchedRows: CredentialRow[] = []
      for (const domain of domains) {
        const d = domain.toLowerCase().trim()
        const rows = await executeClickHouseQuery(
          `SELECT url, email, password, domain
           FROM ulp.credentials
           WHERE domain = {domain:String} OR endsWith(lower(email), {emailSuffix:String})
           LIMIT 100`,
          { domain: d, emailSuffix: `@${d}` }
        ) as CredentialRow[]
        matchedRows.push(...rows)
      }

      if (matchedRows.length === 0) {
        // No matches — still stamp last_triggered_at so we don't re-query every tick
        dbRun(`UPDATE domain_monitors SET last_triggered_at = datetime('now') WHERE id = ?`, [monitorRow.id])
        continue
      }

      // Filter unseen credentials
      const unseenRows = matchedRows.filter(row => {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        const seen = dbQuery(
          'SELECT 1 FROM monitor_credential_seen WHERE monitor_id = ? AND fingerprint = ?',
          [monitorRow.id, fp]
        )
        return seen.length === 0
      })
```

Replace with:

```typescript
      // Query ClickHouse using NORM_DOMAIN_EXPR so Cases A-D corrupted rows match
      const matchedRows: CredentialRow[] = []
      for (const domain of domains) {
        const d = domain.toLowerCase().trim()
        const rows = await executeClickHouseQuery(
          `SELECT url, email, password, (${NORM_DOMAIN_EXPR}) AS domain
           FROM ulp.credentials
           WHERE (${NORM_DOMAIN_EXPR}) = {domain:String}
              OR endsWith(lower(${NORM_DOMAIN_EXPR}), {emailSuffix:String})
           LIMIT 100`,
          { domain: d, emailSuffix: `@${d}` }
        ) as CredentialRow[]
        matchedRows.push(...rows)
      }

      if (matchedRows.length === 0) {
        dbRun(`UPDATE domain_monitors SET last_triggered_at = datetime('now') WHERE id = ?`, [monitorRow.id])
        continue
      }

      // Batch N+1 fix: compute all fingerprints, query seen set in one call
      const fingerprintMap = new Map(
        matchedRows.map(row => [
          credentialFingerprint(row.email, row.password, row.domain),
          row,
        ])
      )
      const fps = Array.from(fingerprintMap.keys())
      const placeholders = fps.map(() => '?').join(',')
      const seenRows = dbQuery(
        `SELECT fingerprint FROM monitor_credential_seen WHERE monitor_id = ? AND fingerprint IN (${placeholders})`,
        [monitorRow.id, ...fps]
      ) as { fingerprint: string }[]
      const seenSet = new Set(seenRows.map(r => r.fingerprint))

      const unseenRows = matchedRows.filter(row => {
        const fp = credentialFingerprint(row.email, row.password, row.domain)
        return !seenSet.has(fp)
      })
```

- [ ] Run the TypeScript compiler to confirm no errors:

```
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] Run the full test suite:

```
npx vitest run 2>&1 | tail -10
```

Expected: all pass

- [ ] Commit:

```
git add lib/monitor-rescan-cron.ts
git commit -m "fix(monitor): batch SQLite fingerprint check + use NORM_DOMAIN_EXPR in ClickHouse query"
```

---

## Task 4 — Pipe primary separator

Combo lists distributed via Telegram and older leak archives commonly use `|` as the primary field separator: `https://site.com|user|pass`. The existing pipe logic strips everything after the first `|` as trailing metadata. This task adds smart detection: if the segment before the first `|` has fewer than 2 non-scheme colons, treat `|` as the primary separator instead.

**Files:**
- Modify: `lib/ulp-parser.ts` — `parseLine`, the pipe-stripping block and separator-detection block
- Modify: `__tests__/ulp-parser-extended.test.ts` — add §15

### Step 4.1 — Write failing tests for §15

- [ ] Append to the end of `__tests__/ulp-parser-extended.test.ts`:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// §15  Pipe primary separator
// Lines like "url|login|pass" use pipe as the primary field separator.
// Trailing-metadata lines like "url:login:pass|RU|source" still strip the pipe.
// ─────────────────────────────────────────────────────────────────────────────

describe('§15 Pipe primary separator', () => {

  test('https://site.com|user@email.com|pass123 → correct fields', () => {
    const c = cred('https://roblox.com|player99@gmail.com|P@ssword!')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('https://roblox.com')
    expect(c!.email).toBe('player99@gmail.com')
    expect(c!.password).toBe('P@ssword!')
    expect(c!.domain).toBe('roblox.com')
  })

  test('bare domain|user|pass → correct fields', () => {
    const c = cred('steamcommunity.com|player123|steam_pass99')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('steamcommunity.com')
    expect(c!.email).toBe('player123')
    expect(c!.password).toBe('steam_pass99')
    expect(c!.domain).toBe('steamcommunity.com')
  })

  test('2-field pipe: email|pass → url empty', () => {
    const c = cred('user@gmail.com|mypassword99')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('')
    expect(c!.email).toBe('user@gmail.com')
    expect(c!.password).toBe('mypassword99')
  })

  test('3-field pipe with http URL', () => {
    const c = cred('http://forum.example.com|alice|hunter2pass')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('http://forum.example.com')
    expect(c!.email).toBe('alice')
    expect(c!.password).toBe('hunter2pass')
  })

  test('URL-with-port|user|pass → pipe-primary', () => {
    const c = cred('ftp://files.site.com:21|ftpuser|ftppass99')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('ftp://files.site.com:21')
    expect(c!.email).toBe('ftpuser')
    expect(c!.password).toBe('ftppass99')
  })

  test('pipe password with extra pipes: url|user|p|a|s → password gets extra pipes', () => {
    const c = cred('https://site.com|user|p|a|s|s')
    expect(c).not.toBeNull()
    expect(c!.email).toBe('user')
    expect(c!.password).toBe('p|a|s|s')
  })

  test('trailing-metadata still stripped: url:login:pass|RU|source', () => {
    const c = cred('https://vk.com/login:vkuser:vkpass99|RU|source.txt')
    expect(c).not.toBeNull()
    expect(c!.email).toBe('vkuser')
    expect(c!.password).toBe('vkpass99')
  })

  test('colon-credential with 1-segment pipe noise: site.com:user:pass|RU', () => {
    const c = cred('site.com:user:pass123|RU')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('site.com')
    expect(c!.email).toBe('user')
    expect(c!.password).toBe('pass123')
  })
})
```

- [ ] Run to confirm they fail:

```
npx vitest run __tests__/ulp-parser-extended.test.ts 2>&1 | grep -A3 "§15"
```

Expected: FAIL — pipe lines still rejected

### Step 4.2 — Implement pipe primary detection in `parseLine`

- [ ] Replace the pipe-stripping block in `parseLine` (lines ~153–156):

```typescript
  // Strip trailing pipe-separated noise (e.g. "url:login:pass|source|country")
  const clean = trimmed.includes('|') && !trimmed.startsWith('|')
    ? trimmed.split('|')[0].trim()
    : trimmed
```

With:

```typescript
  // Pipe separator detection:
  // If the segment before the first '|' has <2 non-scheme colons, treat '|' as
  // the primary field separator (combo-list format: url|login|pass).
  // Otherwise treat '|' as trailing metadata noise and strip from first '|'.
  let clean: string
  if (trimmed.includes('|') && !trimmed.startsWith('|')) {
    const beforePipe = trimmed.slice(0, trimmed.indexOf('|'))
    // Count colons that are NOT part of a '://' scheme
    const nonSchemeColons = (beforePipe.replace('://', '  ').match(/:/g) ?? []).length
    if (nonSchemeColons >= 2) {
      // Has login:pass embedded before the pipe → trailing metadata, strip it
      clean = beforePipe.trim()
    } else {
      // No embedded credential before the pipe → pipe IS the separator
      clean = trimmed
    }
  } else {
    clean = trimmed
  }
```

- [ ] Add the pipe separator detection to the separator-detection block in `parseLine`.  
  Find the semicolon else-if and colon else blocks (around line ~204–220):

```typescript
  } else if (clean.includes(';')) {
    // ... existing semicolon code
  } else {
    const split = colonSplit(clean)
    if (!split) return { credential: null, reason: 'no_fields' }
    ;[url, login, password] = split
  }
```

Replace with:

```typescript
  } else if (clean.includes(';')) {
    const parts = clean.split(';')
    if (parts.length >= 3) {
      url      = parts[0].trim()
      login    = parts[1].trim()
      password = parts.slice(2).join(';').trim()
    } else if (parts.length === 2) {
      login    = parts[0].trim()
      password = parts[1].trim()
    } else {
      return { credential: null, reason: 'no_fields' }
    }
  } else if (clean.includes('|') && !clean.startsWith('|')) {
    // Pipe primary separator (set by the clean-assignment logic above)
    const parts = clean.split('|')
    if (parts.length >= 3) {
      url      = parts[0].trim()
      login    = parts[1].trim()
      password = parts.slice(2).join('|').trim()
    } else if (parts.length === 2) {
      login    = parts[0].trim()
      password = parts[1].trim()
    } else {
      return { credential: null, reason: 'no_fields' }
    }
  } else {
    const split = colonSplit(clean)
    if (!split) return { credential: null, reason: 'no_fields' }
    ;[url, login, password] = split
  }
```

### Step 4.3 — Run all tests

- [ ] Run the full suite:

```
npx vitest run 2>&1 | tail -10
```

Expected: all pass (246 + 8 new §15 = 254 total)

- [ ] Commit:

```
git add lib/ulp-parser.ts __tests__/ulp-parser-extended.test.ts
git commit -m "feat(parser): add pipe primary separator (url|login|pass combo-list format)"
```

---

## Task 5 — `insertBatch` row-by-row generator streaming

Replaces the `credentials.map(...).join('\n')` pattern that allocates a ~50 MB string for a 500 K-row batch with a generator that yields one CSV row at a time. Node.js `Readable.from` consumes the generator lazily, keeping allocations constant per row.

**Files:**
- Modify: `app/api/upload/route.ts` — `insertBatch` function (lines ~36–74)

### Step 5.1 — Replace the `csvRows` materialization

- [ ] In `app/api/upload/route.ts`, replace the `insertBatch` function body (lines ~43–73) — specifically the `csvRows` construction and `Readable.from` call:

Find:

```typescript
  const csvRows = credentials.map(c =>
    [
      csvField(c.url),
      csvField(c.email),
      csvField(c.password),
      csvField(c.domain),
      csvField(c.source_file),
      csvField(breach_name),
    ].join(',')
  ).join('\n') + '\n'

  // objectMode MUST be false for @clickhouse/client CSV format.
  // Readable.from() defaults to objectMode:true (treats each element as an
  // object), which the client rejects with "expected Readable Stream with
  // disabled object mode".  Setting objectMode:false makes it a byte stream.
  const readable = Readable.from([csvRows], { objectMode: false })
```

Replace with:

```typescript
  // Generator yields one CSV row at a time — no large string materialised.
  // objectMode MUST be false: Readable.from() defaults to objectMode:true
  // (treats each element as an object), rejected by the ClickHouse CSV reader.
  const readable = Readable.from(
    (function* () {
      for (const c of credentials) {
        yield [
          csvField(c.url),
          csvField(c.email),
          csvField(c.password),
          csvField(c.domain),
          csvField(c.source_file),
          csvField(breach_name),
        ].join(',') + '\n'
      }
    })(),
    { objectMode: false },
  )
```

- [ ] Run TypeScript check:

```
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors

- [ ] Commit:

```
git add app/api/upload/route.ts
git commit -m "perf(upload): stream CSV rows one-at-a-time instead of materialising 500K-row string"
```

---

## Task 6 — Percent-decode URL-encoded passwords

Some stealers URL-encode the password before writing it to the log. `P%40ssw0rd` should be stored as `P@ssw0rd`. Decoding happens after field splitting in `parseLine`, wrapped in try/catch for malformed sequences.

**Files:**
- Modify: `lib/ulp-parser.ts` — `parseLine`, after the separator block before validation
- Modify: `__tests__/ulp-parser-extended.test.ts` — add §16

### Step 6.1 — Write failing tests for §16

- [ ] Append to `__tests__/ulp-parser-extended.test.ts`:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// §16  Percent-decode URL-encoded passwords
// Stealers sometimes URL-encode the password field.
// ─────────────────────────────────────────────────────────────────────────────

describe('§16 Percent-decode URL-encoded passwords', () => {

  test('%40 decoded to @: P%40ssw0rd → P@ssw0rd', () => {
    const c = cred('https://example.com:user:P%40ssw0rd')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('P@ssw0rd')
  })

  test('%3A decoded to colon: pass%3Aword → pass:word', () => {
    const c = cred('https://example.com:user:pass%3Aword')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('pass:word')
  })

  test('plain password without % unchanged', () => {
    const c = cred('https://example.com:user:plainpassword')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('plainpassword')
  })

  test('malformed %ZZ sequence — kept as-is (no crash)', () => {
    const c = cred('https://example.com:user:pass%ZZword')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('pass%ZZword')  // decodeURIComponent throws, fallback to original
  })

  test('%20 decoded to space', () => {
    const c = cred('https://example.com:user:my%20password')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('my password')
  })

  test('fully encoded password still passes length check on decoded value', () => {
    // '%61%62%63' = 'abc' (3 chars, exactly at boundary)
    const c = cred('https://example.com:user:%61%62%63')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('abc')
  })
})
```

- [ ] Run to confirm they fail:

```
npx vitest run __tests__/ulp-parser-extended.test.ts --reporter=verbose 2>&1 | grep "§16" -A5 | head -20
```

Expected: first two tests fail (password still encoded)

### Step 6.2 — Implement percent-decode in `parseLine`

- [ ] In `lib/ulp-parser.ts`, find the separator block ending (where `[url, login, password] = split` is set) and the validation block that follows. Add percent-decode between them:

Find this exact comment + block (around line ~222):

```typescript
  // Rule 3: validation
  if (!login)                           return { credential: null, reason: 'no_fields' }
```

Insert before it:

```typescript
  // Percent-decode URL-encoded password (some stealers encode special chars)
  if (password.includes('%')) {
    try { password = decodeURIComponent(password) } catch { /* keep original if malformed */ }
  }

```

### Step 6.3 — Run all tests

- [ ] Run the full suite:

```
npx vitest run 2>&1 | tail -10
```

Expected: all pass

- [ ] Commit:

```
git add lib/ulp-parser.ts __tests__/ulp-parser-extended.test.ts
git commit -m "feat(parser): percent-decode URL-encoded passwords"
```

---

## Final verification

- [ ] Run the complete test suite one last time:

```
npx vitest run --reporter=verbose 2>&1 | tail -20
```

Expected output contains:
```
Test Files  3 passed (3)
      Tests  NNN passed (NNN)
```

Where NNN is ≥ 268 (246 pre-existing + 22 new §15/§16 tests in extended file + 30+ new tests in block file).

- [ ] Push all commits:

```
git log --oneline -8
git push origin main
```

---

## Self-Review

**Spec coverage check:**

| Item | Tasks covering it |
|---|---|
| Block-format state machine in `lib/ulp-parser.ts` | Tasks 1, 2 |
| `parseBlockLine`, `parseBlockContent`, `parseBlockStream` exports | Task 1 |
| Block tests (≥30) | Task 1 — §A through §E |
| Integrate into `parseULPContent` + `parseULPStream` | Task 2 |
| N+1 SQLite fix | Task 3 |
| `NORM_DOMAIN_EXPR` in rescan query | Task 3 |
| Pipe primary separator | Task 4 |
| Pipe tests (§15) | Task 4 |
| `insertBatch` row-by-row streaming | Task 5 |
| Percent-decode passwords | Task 6 |
| Percent-decode tests (§16) | Task 6 |

All spec items covered. No placeholders. Type signatures consistent throughout.
