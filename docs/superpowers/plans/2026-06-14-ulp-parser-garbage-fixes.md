# ULP Parser Garbage Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ULP parser correctly recover scheme-less `host:port/path:login:pass` credentials and reject placeholder-identity, token/decryption-blob, and double-encoded-mojibake junk at parse time.

**Architecture:** Three surgical changes inside `lib/ulp-parser.ts` — (1) port/path absorption in `colonSplit`'s no-scheme branch, (2) a shared `isJunkCredential` gate wired into every credential-emission site, (3) a double-encoded-`ï¿½` check in `hasBinaryOrReplacement`. Forward-only; existing rows are recovered by re-import (out of scope). Rejections reuse the existing `garbage` reason.

**Tech Stack:** TypeScript, Vitest. Test runner: `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-06-14-ulp-parser-garbage-fixes-design.md`

---

## File Structure

- **Modify:** `lib/ulp-parser.ts`
  - `hasBinaryOrReplacement` (~line 92) — add mojibake check (Task 1)
  - `colonSplit` no-scheme branch (~lines 380–401) — port/path absorption (Task 2)
  - New module-level constants + helpers `PLACEHOLDER_LOGINS`, `isPlaceholderLogin`, `hasJunkMarker`, `isJunkCredential` (Task 3)
  - `parseLine` validation — new Rule 3.7 (Task 3)
  - `flushBlockState` (~lines 170–182), positional emitters in `parseULPContent` (~lines 666–677) and `parseULPStream` (~lines 812–822) — wire `isJunkCredential` (Task 4)
- **Modify (tests):** `__tests__/ulp-parser-extended.test.ts`
  - Update existing §2 bare-port test (Task 2)
  - New `§18`–`§21` describe blocks (Tasks 1–4)

All work happens on the existing branch `parser-garbage-fixes`.

---

## Task 1: Fix 3 — Double-encoded mojibake filter

**Files:**
- Modify: `lib/ulp-parser.ts:92` (`hasBinaryOrReplacement`)
- Test: `__tests__/ulp-parser-extended.test.ts` (new `§18` block, end of file)

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/ulp-parser-extended.test.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// §18  Double-encoded mojibake (ï¿½) rejection
// The streaming parsers decode bytes as latin1, so a UTF-8 replacement char
// (EF BF BD) appears as the 3-char sequence U+00EF U+00BF U+00BD, never as
// codepoint 0xFFFD. The garbage filter must catch that form.
// ─────────────────────────────────────────────────────────────────────────────

describe('§18 Double-encoded mojibake', () => {
  test('ï¿½ in password → rejected as garbage', () => {
    const line = 'https://site.com:realuser:paï¿½ss'
    expect(cred(line)).toBeNull()
    expect(why(line)).toBe('garbage')
  })

  test('ï¿½ in email/login → rejected as garbage', () => {
    const line = 'https://site.com:reï¿½aluser:realpass123'
    expect(cred(line)).toBeNull()
    expect(why(line)).toBe('garbage')
  })

  test('valid Unicode password (Cyrillic/Chinese/emoji) still kept — no false positive', () => {
    const c = cred('https://site.com:realuser:пароль密码🔑')
    expect(c).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§18"`
Expected: the two mojibake tests FAIL (credential is currently produced, not null); the Unicode test passes.

- [ ] **Step 3: Implement the mojibake check**

In `lib/ulp-parser.ts`, replace the body of `hasBinaryOrReplacement` (~lines 92–99):

```ts
function hasBinaryOrReplacement(s: string): boolean {
  // Double-encoded U+FFFD: the streaming parsers decode bytes with
  // Buffer.toString('latin1'), so a real replacement char (UTF-8 EF BF BD)
  // appears as the 3-char sequence U+00EF U+00BF U+00BD ("ï¿½"), never as
  // codepoint 0xFFFD. Those bytes only exist after a decoder already gave up
  // on invalid input, so they are always a corruption signal.
  if (s.includes('ï¿½')) return true
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    // control chars except tab(9)/LF(10)/CR(13), or U+FFFD replacement char
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0xFFFD) return true
  }
  return false
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§18"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ulp-parser.ts __tests__/ulp-parser-extended.test.ts
git commit -m "$(cat <<'EOF'
fix(parser): catch double-encoded U+FFFD mojibake (ï¿½)

The latin1 streaming decode turns UTF-8 EF BF BD into the 3-char sequence
U+00EF U+00BF U+00BD, which the 0xFFFD-only check never matched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Fix 1 — Port/path-leak recovery in `colonSplit`

**Files:**
- Modify: `lib/ulp-parser.ts:380-401` (`colonSplit` no-scheme branch)
- Test: `__tests__/ulp-parser-extended.test.ts` (update §2 test; new `§19` block)

- [ ] **Step 1: Write the failing tests (new §19) and update the §2 bare-port test**

Append a new block to `__tests__/ulp-parser-extended.test.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// §19  Port/path-leak recovery (scheme-less host:port[/path]:login:pass)
// The no-scheme colon-splitter used to make the port the login. Now host:port
// (with or without a path) is absorbed into the URL.
// ─────────────────────────────────────────────────────────────────────────────

describe('§19 Port/path-leak recovery', () => {
  test('localhost:port/ : login : pass → port+path folds into URL', () => {
    const c = cred('localhost:10000/:admin:12345')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('localhost:10000/')
    expect(c!.email).toBe('admin')
    expect(c!.password).toBe('12345')
  })

  test('host:port/path.cgi : login : pass → full path preserved in URL', () => {
    const c = cred('admin:10000/session_login.cgi:studioprint:3571nt62')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('admin:10000/session_login.cgi')
    expect(c!.email).toBe('studioprint')
    expect(c!.password).toBe('3571nt62')
  })

  test('hostname:port/ with backslash login preserved', () => {
    const c = cred('psvm001:1000/:psdc001\\administrator:AAS@4770477')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('psvm001:1000/')
    expect(c!.email).toBe('psdc001\\administrator')
    expect(c!.password).toBe('AAS@4770477')
  })

  test('bare port (no path): host:443:login:pass → port folds into URL', () => {
    const c = cred('mysite.com:443:admin:secret123')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('mysite.com:443')
    expect(c!.email).toBe('admin')
    expect(c!.password).toBe('secret123')
    expect(c!.domain).toBe('mysite.com')
  })

  test('IPv4 no-scheme with port+path: ip:port/path:login:pass', () => {
    const c = cred('192.168.1.1:8080/admin:root:toor')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('192.168.1.1:8080/admin')
    expect(c!.email).toBe('root')
    expect(c!.password).toBe('toor')
  })

  // ── Regressions: non-port middles must be untouched ──
  test('regression: no-scheme domain:login:pass (non-numeric middle) unchanged', () => {
    const c = cred('example.com:alice:hunter2pass')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('example.com')
    expect(c!.email).toBe('alice')
    expect(c!.password).toBe('hunter2pass')
  })

  test('regression: no-scheme host:email@domain:pass unchanged', () => {
    const c = cred('netflix.com:user@gmail.com:netfl1x!')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('netflix.com')
    expect(c!.email).toBe('user@gmail.com')
    expect(c!.password).toBe('netfl1x!')
  })
})
```

Then **replace** the existing §2 test `'no-scheme domain with port-like segment...'` (currently at `__tests__/ulp-parser-extended.test.ts:200-209`) with:

```ts
  test('no-scheme domain with bare port: domain:443:user:pass — 443 folds into URL', () => {
    // Behaviour change (Fix 1, 2026-06-14): a digit-only middle field after a
    // scheme-less host is treated as a PORT and absorbed into the URL, not as
    // the login. Previously this asserted email='443'.
    const c = cred('mysite.com:443:admin:secret123')
    expect(c).not.toBeNull()
    expect(c!.url).toBe('mysite.com:443')
    expect(c!.email).toBe('admin')
    expect(c!.password).toBe('secret123')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§19"`
Expected: FAIL — e.g. `localhost:10000/:admin:12345` currently yields `email='10000/'`, `password='admin:12345'`.

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§2 Port disambiguation"`
Expected: the updated bare-port test FAILS (current code returns `email='443'`).

- [ ] **Step 3: Implement port/path absorption**

In `lib/ulp-parser.ts`, the no-scheme tail of `colonSplit` currently ends (~lines 392–401):

```ts
  const c2 = line.indexOf(':', c1 + 1)
  if (c2 === -1) {
    // 2-field line: "login:password" — but if left contains '/' it is a
    // URL-path:username pattern (e.g. "site.com/login:Camerajake"), not a
    // credential.  Reject it so the URL doesn't land in the email column.
    if (left.includes('/')) return null
    // "login:password" — signal no-URL with empty string
    return ['', left, line.slice(c1 + 1)]
  }
  return [left, line.slice(c1 + 1, c2), line.slice(c2 + 1)]
}
```

Replace the final `return [left, ...]` line (the one after the `c2 === -1` block) with:

```ts
  // Port / port+path leak: scheme-less "host:port[/path]:login:pass". The
  // segment between the first two colons is a port (digits, ≤65535) or a port
  // followed by a path — part of the URL, NOT the login. Absorb "host:mid" into
  // the URL and re-split the remainder as login:password. (e.g.
  // "localhost:10000/:admin:12345" → url="localhost:10000/", login="admin".)
  const mid = line.slice(c1 + 1, c2)
  const isPortPath = /^\d+\//.test(mid)
  const isBarePort = /^\d{1,5}$/.test(mid) && Number(mid) <= 65535
  if (isPortPath || isBarePort) {
    const rest = line.slice(c2 + 1)           // login:password (may have more colons)
    const rc   = rest.indexOf(':')
    // Only absorb the port when a real login:password follows it. If nothing
    // after the port contains a ':', this is a plain 3-field "host:login:pass"
    // with a numeric (or path-looking) login — fall through to the default
    // split below rather than dropping the row.
    if (rc !== -1) {
      return [left + ':' + mid, rest.slice(0, rc), rest.slice(rc + 1)]
    }
  }
  return [left, line.slice(c1 + 1, c2), line.slice(c2 + 1)]
}
```

> **Note (post-review):** an earlier draft of this block did `if (rc === -1) return null`, which silently dropped legitimate 3-field rows with a numeric login (e.g. `forum.com:12345:realpass`). The corrected version falls through to the plain split instead, so absorption never loses a row the old code kept. Step 1 includes two regression tests for this.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§19"`
Expected: PASS (7 tests).

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§2 Port disambiguation"`
Expected: PASS (all §2 tests, including the updated bare-port one).

- [ ] **Step 5: Commit**

```bash
git add lib/ulp-parser.ts __tests__/ulp-parser-extended.test.ts
git commit -m "$(cat <<'EOF'
fix(parser): recover scheme-less host:port/path:login:pass

The no-scheme colon-splitter made the port the login. Absorb a digit-only
or port+path middle field into the URL and re-split the rest as login:pass.
Updates the §2 test that documented the old "443 becomes login" behaviour.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Fix 2 (part 1) — Junk-marker helpers + inline `parseLine` rejection

**Files:**
- Modify: `lib/ulp-parser.ts` (add helpers near the other helpers ~line 116; add Rule 3.7 in `parseLine` after Rule 3.6 ~line 572)
- Test: `__tests__/ulp-parser-extended.test.ts` (new `§20` block)

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/ulp-parser-extended.test.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// §20  Junk-marker rejection (inline parseLine)
// Placeholder logins and token/decryption blobs are not real credentials.
// ─────────────────────────────────────────────────────────────────────────────

describe('§20 Junk-marker rejection (inline)', () => {
  test('placeholder login "Password" → rejected garbage', () => {
    expect(cred('https://site.com:Password:realpass123')).toBeNull()
    expect(why('https://site.com:Password:realpass123')).toBe('garbage')
  })

  test('placeholder login "N/A" → rejected garbage', () => {
    expect(cred('https://site.com:N/A:realpass123')).toBeNull()
    expect(why('https://site.com:N/A:realpass123')).toBe('garbage')
  })

  test('placeholder login "[NOT_SAVED]" → rejected garbage', () => {
    expect(cred('https://site.com:[NOT_SAVED]:realpass123')).toBeNull()
    expect(why('https://site.com:[NOT_SAVED]:realpass123')).toBe('garbage')
  })

  test('real weak password "password" is KEPT (placeholder check is login-only)', () => {
    const c = cred('https://site.com:realuser:password')
    expect(c).not.toBeNull()
    expect(c!.email).toBe('realuser')
    expect(c!.password).toBe('password')
  })

  test('gmail_ps= token blob in password → rejected garbage', () => {
    expect(cred('https://site.com:realuser:gmail_ps=CrMBAAlriVxyz')).toBeNull()
    expect(why('https://site.com:realuser:gmail_ps=CrMBAAlriVxyz')).toBe('garbage')
  })

  test('[Wrong padding] decryption junk in password → rejected garbage', () => {
    expect(cred('https://site.com:realuser:[Wrong padding] HEX: D4-75-C9')).toBeNull()
    expect(why('https://site.com:realuser:[Wrong padding] HEX: D4-75-C9')).toBe('garbage')
  })

  test('legit android ==@com. credential still KEPT (marker is in URL, not login/pass)', () => {
    const c = cred('android://HASH==@com.instagram.android:john_doe:SecretPass99')
    expect(c).not.toBeNull()
    expect(c!.email).toBe('john_doe')
    expect(c!.password).toBe('SecretPass99')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§20"`
Expected: FAIL — the placeholder/token tests currently produce credentials; the "kept" tests already pass.

- [ ] **Step 3: Add the helpers and Rule 3.7**

In `lib/ulp-parser.ts`, add immediately after `isValidHost` (~line 116):

```ts
/**
 * Logins that are export placeholders, never a real identity — Chrome/stealer
 * dumps emit these when no username was captured (password-reset pages, etc.).
 * Checked case-insensitively, on the login field only (so a weak real PASSWORD
 * like "password" is unaffected).
 */
const PLACEHOLDER_LOGINS = new Set([
  'password', 'n/a', 'na', 'none', 'null', 'undefined', '[not_saved]', 'not_saved',
  // "user"/"username" deliberately excluded — common REAL logins, rejecting them
  // collided with 42 existing tests and would drop real router/admin credentials.
])
function isPlaceholderLogin(login: string): boolean {
  return PLACEHOLDER_LOGINS.has(login.trim().toLowerCase())
}

/**
 * Token / decryption blobs that never appear in a real login or password:
 * Google GAIA recovery tokens (gmail_ps=, gmail=), digit-corrupted android
 * token glue (==@com.), and AES/hex decryption failures ([Wrong padding]).
 * Note: legit "android://HASH==@com.pkg" carries "==@com." in the URL field,
 * which is never passed here — only login/password are checked.
 */
function hasJunkMarker(s: string): boolean {
  return s.includes('gmail_ps=') || s.includes('gmail=')
      || s.includes('==@com.')   || s.includes('[Wrong padding]')
}

/**
 * Finalize-time junk gate, bundling every reject rule that applies to a built
 * credential: placeholder login, token/decryption marker, and binary/mojibake.
 * Called from credential-emission sites that don't otherwise run these checks
 * (block + positional). `parseLine` runs the binary check inline already.
 */
function isJunkCredential(login: string, password: string): boolean {
  return isPlaceholderLogin(login)
      || hasJunkMarker(login)          || hasJunkMarker(password)
      || hasBinaryOrReplacement(login) || hasBinaryOrReplacement(password)
}
```

Then in `parseLine`, immediately after the Rule 3.6 garbage-URL block (~line 572, before `// Rule 4: domain extraction`), insert:

```ts
  // Rule 3.7: placeholder identity / token-blob rejection. A login that is an
  // export placeholder (Password, N/A, [NOT_SAVED], ...) is not a real identity;
  // gmail_ps=/gmail=/==@com./[Wrong padding] are token or decryption junk.
  // (Binary/mojibake already handled by Rule 3.5.)
  if (isPlaceholderLogin(login) || hasJunkMarker(login) || hasJunkMarker(password)) {
    return { credential: null, reason: 'garbage' }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§20"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ulp-parser.ts __tests__/ulp-parser-extended.test.ts
git commit -m "$(cat <<'EOF'
fix(parser): reject placeholder logins and token/decryption blobs (inline)

Adds isPlaceholderLogin / hasJunkMarker / isJunkCredential helpers and a
Rule 3.7 in parseLine that drops Password/N/A/[NOT_SAVED] logins and
gmail_ps=/gmail=/==@com./[Wrong padding] markers as garbage.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Fix 2 (part 2) — Wire `isJunkCredential` into block + positional emitters

**Files:**
- Modify: `lib/ulp-parser.ts` — `flushBlockState` (~lines 170–182); positional emitter in `parseULPContent` (~lines 666–677); positional emitter in `parseULPStream` (~lines 812–822)
- Test: `__tests__/ulp-parser-extended.test.ts` (new `§21` block)

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/ulp-parser-extended.test.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// §21  Junk-marker rejection on block + positional paths
// The placeholder/token gate must also run where credentials are emitted
// without going through parseLine.
// ─────────────────────────────────────────────────────────────────────────────

describe('§21 Junk-marker rejection (block + positional)', () => {
  test('positional 3-line block with placeholder login "password" → dropped', () => {
    const content = ['https://example.com/login', 'password', 'foo:barbaz'].join('\n')
    const r = parseULPContent(content, 'src.txt')
    expect(r.credentials.length).toBe(0)
  })

  test('positional 3-line block with real login → kept (regression)', () => {
    const content = ['https://example.com/login', 'realuser', 'realpassword123'].join('\n')
    const r = parseULPContent(content, 'src.txt')
    expect(r.credentials.length).toBe(1)
    expect(r.credentials[0].email).toBe('realuser')
    expect(r.credentials[0].password).toBe('realpassword123')
  })

  test('block-format credential with gmail_ps= token → dropped', () => {
    const content = ['Host: https://site.com', 'Login: realuser', 'Password: gmail_ps=CrMBxyz', '===='].join('\n')
    const r = parseULPContent(content, 'src.txt')
    expect(r.credentials.length).toBe(0)
  })

  test('block-format normal credential → kept (regression)', () => {
    const content = ['Host: https://site.com', 'Login: realuser', 'Password: GoodPass99', '===='].join('\n')
    const r = parseULPContent(content, 'src.txt')
    expect(r.credentials.length).toBe(1)
    expect(r.credentials[0].email).toBe('realuser')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§21"`
Expected: the two "dropped" tests FAIL (credentials still produced); the two regression tests pass.

- [ ] **Step 3a: Gate `flushBlockState`**

In `lib/ulp-parser.ts`, in `flushBlockState` (~lines 170–182), after the `login === password` guard and before the `domain` computation, add the junk gate:

```ts
export function flushBlockState(
  state: BlockState,
  sourceFile: string,
): ULPCredential | null {
  const { url, login, password } = state
  if (!login)                           return null
  if (!password || password.length < 3) return null
  if (login === password)               return null
  if (isJunkCredential(login, password)) return null
  const domain = url
    ? extractDomain(url)
    : (login.includes('@') ? login.split('@').pop()!.toLowerCase() : '')
  return { url, email: login, password, domain, source_file: sourceFile }
}
```

- [ ] **Step 3b: Gate the `parseULPContent` positional emitter**

In `lib/ulp-parser.ts`, the positional-password block in `parseULPContent` (~lines 666–677) currently reads:

```ts
    // Positional password: URL + login already collected → emit credential
    if (positionalUrl && positionalLogin) {
      const fp = `${positionalUrl}\0${positionalLogin}\0${trimmed}`
      if (seen.has(fp)) {
        skipped++; breakdown.dedup++
      } else {
        const domain = extractDomain(positionalUrl)
        addSeen(fp, sourceFile)
        credentials.push({ url: positionalUrl, email: positionalLogin, password: trimmed, domain, source_file: sourceFile })
      }
      positionalUrl = positionalLogin = ''
      continue
    }
```

Replace it with (adds the junk check before dedup/emit):

```ts
    // Positional password: URL + login already collected → emit credential
    if (positionalUrl && positionalLogin) {
      if (isJunkCredential(positionalLogin, trimmed)) {
        skipped++; breakdown.garbage++
        positionalUrl = positionalLogin = ''
        continue
      }
      const fp = `${positionalUrl}\0${positionalLogin}\0${trimmed}`
      if (seen.has(fp)) {
        skipped++; breakdown.dedup++
      } else {
        const domain = extractDomain(positionalUrl)
        addSeen(fp, sourceFile)
        credentials.push({ url: positionalUrl, email: positionalLogin, password: trimmed, domain, source_file: sourceFile })
      }
      positionalUrl = positionalLogin = ''
      continue
    }
```

- [ ] **Step 3c: Gate the `parseULPStream` positional emitter**

In `lib/ulp-parser.ts`, the positional-password block in `parseULPStream`'s `processLine` (~lines 812–822) currently reads:

```ts
    // Positional password: URL + login collected → emit credential
    if (positionalUrl && positionalLogin) {
      const fp = `${positionalUrl}\0${positionalLogin}\0${trimmed}`
      if (streamSeenCheck(fp)) {
        batchRejected++; batchBreakdown.dedup++
      } else {
        const domain = extractDomain(positionalUrl)
        batch.push({ url: positionalUrl, email: positionalLogin, password: trimmed, domain, source_file: filename })
      }
      positionalUrl = positionalLogin = ''
      return
    }
```

Replace it with:

```ts
    // Positional password: URL + login collected → emit credential
    if (positionalUrl && positionalLogin) {
      if (isJunkCredential(positionalLogin, trimmed)) {
        batchRejected++; batchBreakdown.garbage++
        positionalUrl = positionalLogin = ''
        return
      }
      const fp = `${positionalUrl}\0${positionalLogin}\0${trimmed}`
      if (streamSeenCheck(fp)) {
        batchRejected++; batchBreakdown.dedup++
      } else {
        const domain = extractDomain(positionalUrl)
        batch.push({ url: positionalUrl, email: positionalLogin, password: trimmed, domain, source_file: filename })
      }
      positionalUrl = positionalLogin = ''
      return
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/ulp-parser-extended.test.ts -t "§21"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ulp-parser.ts __tests__/ulp-parser-extended.test.ts
git commit -m "$(cat <<'EOF'
fix(parser): apply junk gate to block + positional emitters

flushBlockState and the positional emitters in parseULPContent/parseULPStream
now run isJunkCredential, so placeholder/token/mojibake rows are dropped on
those paths too (counted as garbage).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Full regression + real-data validation

**Files:** none (verification only)

- [ ] **Step 1: Run the complete parser suite**

Run: `npx vitest run __tests__/ulp-parser.test.ts __tests__/ulp-parser-extended.test.ts __tests__/ulp-parser-stream.test.ts __tests__/ulp-parser-block.test.ts`
Expected: ALL pass. The only intentionally-changed pre-existing assertion is the §2 bare-port test (Task 2).

- [ ] **Step 2: Investigate any failure caused by `user`/`username` placeholders**

If a pre-existing test fails because it used `user`/`username` as a valid login (the known false-positive risk from the spec §6), do NOT silently edit the test. Surface it: it means a real login value collides with the placeholder set. Decide with the spec owner whether to drop `user`/`username` from `PLACEHOLDER_LOGINS` (remove those two entries) or keep and update the test. Re-run Step 1 after the decision.

- [ ] **Step 3: Real-data spot-check (manual, non-committed)**

Pull a few class-1 (port-leak) rows from the live local table and reconstruct their source lines:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT concat(url, ':', email, ':', password) AS reconstructed
FROM ulp.credentials
WHERE match(email,'^[0-9]+/') AND (url='localhost' OR match(url,'^[A-Za-z0-9][A-Za-z0-9.-]*$'))
LIMIT 5 FORMAT TSVRaw"
```

For each reconstructed line, confirm the fixed parser now assigns `url=host:port/path`, a real `email`, and a real `password` (e.g. paste into a scratch vitest `parseLine(line, 'x')` assertion or the `parse-sample` admin endpoint). This is a sanity check on real shapes, not a committed test.

- [ ] **Step 4: Final confirmation**

Confirm: 5 commits on `parser-garbage-fixes` (Tasks 1–4 + this plan/spec already committed), full suite green, no unintended behavior changes beyond the documented §2 update.

---

## Self-Review

**Spec coverage:**
- Fix 1 (port/path-leak) → Task 2 ✓
- Fix 2 placeholder + token/decryption rejection, all emission paths (inline, block, positional) → Tasks 3 + 4 ✓
- Fix 3 (double-encoded mojibake) → Task 1; full effect on block/positional via `isJunkCredential` (which calls `hasBinaryOrReplacement`) → Task 4 ✓
- Reuse `garbage` reason, no new types → all tasks use `reason: 'garbage'` / `breakdown.garbage` ✓
- §18 tests + §2 update + real-data validation → Tasks 1–5 ✓
- `user`/`username` false-positive risk → Task 5 Step 2 ✓
- Non-goals (recovery, positional-mode rewrite) → not present in any task ✓

**Type/name consistency:** `PLACEHOLDER_LOGINS`, `isPlaceholderLogin`, `hasJunkMarker`, `isJunkCredential` defined once (Task 3) and referenced identically in Tasks 3–4. `breakdown.garbage` / `batchBreakdown.garbage` keys exist in `makeRejectionMap` and the stream breakdown initializers. `RejectionReason` `'garbage'` is already in the union.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertions.
