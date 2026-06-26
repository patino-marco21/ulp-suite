# Garbage Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the parser from manufacturing — and extend the existing purge script to delete — the three malformed-credential classes neither catches today: whitespace-in-identity, letter-less (punctuation-only) domains, and non-replacement mojibake from the latin1 decode.

**Architecture:** One new shared module (`lib/ulp-garbage.ts`) holds the canonical SQL expression + JS mirror, mirroring the existing `lib/ulp-noise.ts` pattern. The parser wires the JS mirror into its existing `isJunkCredential` gate and `parseLine`'s Rule 3.5 check (reusing the `garbage` rejection reason — no new type). The purge script (`scripts/diagnose-and-purge-garbage.sh`) embeds the same SQL expression into its existing `IS_GARBAGE` predicate. Drop-only; no schema change, no migration.

**Tech Stack:** TypeScript (lib/ulp-parser.ts), Vitest, ClickHouse RE2 regex (bash script).

**Spec:** `docs/superpowers/specs/2026-06-26-garbage-classifier-design.md`

---

## Task 1: Shared module — `lib/ulp-garbage.ts`

**Files:**
- Create: `lib/ulp-garbage.ts`
- Create: `__tests__/ulp-garbage.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `__tests__/ulp-garbage.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { hasGarbageIdentity, hasMojibakeSignature } from '@/lib/ulp-garbage'

describe('ulp-garbage', () => {
  describe('hasGarbageIdentity — whitespace + letter-less domain', () => {
    test.each([
      // [identity, why]
      ['Shubashi @ gmail.com', 'internal whitespace around @'],
      ['jailissalcedo689@ gmail.com', 'space immediately after @'],
      ['y j s J @ i 3 2 Y E G', 'heavily spaced identity'],
      ['@ 1 E x a n d e r', 'spaced, no real local-part'],
      ['x@#', 'punctuation-only domain'],
      ['x@123', 'numeric-only domain'],
      ['x@', 'empty domain after @'],
      ['&aq2ZS*@#', 'real screenshot example — domain is "#"'],
    ])('garbage: %s (%s)', (identity) => {
      expect(hasGarbageIdentity(identity)).toBe(true)
    })

    test.each([
      // [identity, why] — false-positive guards
      ['john@gmail.com', 'normal real email'],
      ['john_doe', 'bare username, no @ at all'],
      ['user@münchen.de', 'real IDN domain has letters'],
      ['', 'empty string'],
      ['admin@router', 'no-TLD host is a separate concern (is_noise), not garbage here'],
    ])('keep: %s (%s)', (identity) => {
      expect(hasGarbageIdentity(identity)).toBe(false)
    })
  })

  describe('hasMojibakeSignature — latin1 view of UTF-8 multibyte chars', () => {
    test.each([
      // [string, why]
      ['Î´ÎµÎ¹Î»Î¿Ï', 'Greek "δειλοϊ" decoded as latin1'],
      ['Ã©cole', 'French "école" decoded as latin1'],
      ['Ð¿Ñ€Ð¸Ð²Ñ\x82', 'Cyrillic decoded as latin1'],
      ['userÎ´ÎµÎ¹', 'mojibake embedded mid-string'],
    ])('mojibake: %s (%s)', (s) => {
      expect(hasMojibakeSignature(s)).toBe(true)
    })

    test.each([
      // [string, why] — false-positive guards
      ['café123', 'real accented char with no continuation byte after it'],
      ['Müller', 'real accented char (ü) followed by ASCII'],
      ['plain ascii text', 'no high-latin1 chars at all'],
      ['', 'empty string'],
      ['münchen.de', 'real IDN domain'],
    ])('keep: %s (%s)', (s) => {
      expect(hasMojibakeSignature(s)).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ulp-garbage`
Expected: FAIL — `Cannot find module '@/lib/ulp-garbage'` (or similar resolution error). This confirms the test runs before the module exists.

- [ ] **Step 3: Implement `lib/ulp-garbage.ts`**

Create `lib/ulp-garbage.ts`:

```ts
/**
 * Garbage-identity / mojibake classification — the malformed-credential
 * classes neither the parser's existing isJunkCredential gate nor
 * scripts/diagnose-and-purge-garbage.sh's IS_GARBAGE predicate catch today:
 * whitespace inside an email/login, an @-domain with no letter at all, and
 * non-replacement mojibake (real UTF-8 decoded as latin1).
 *
 * Mirrors the lib/ulp-noise.ts split: {@link GARBAGE_EXPR} is the canonical
 * SQL clause (embedded into scripts/diagnose-and-purge-garbage.sh's
 * IS_GARBAGE predicate); {@link hasGarbageIdentity} and
 * {@link hasMojibakeSignature} are the JS mirror, wired into the parser's
 * isJunkCredential gate (lib/ulp-parser.ts) and unit-tested directly here.
 *
 * Scope: identity (email/login) and url only — NEVER password. Real emails
 * and URLs are pure ASCII, so whitespace / a letter-less domain / mojibake
 * there is always junk. Passwords are the one field that legitimately
 * carries non-ASCII content (e.g. a real "café123"), so every rule here
 * deliberately exempts password.
 */

/**
 * Lead byte of a 2- or 3-byte UTF-8 sequence (0xC2-0xDF, 0xE0-0xEF -- a
 * contiguous range) immediately followed by a UTF-8 continuation byte
 * (0x80-0xBF). When real UTF-8 bytes are decoded with Buffer.toString('latin1')
 * (see lib/ulp-parser.ts), each original byte maps 1:1 to the Unicode
 * codepoint of the same numeric value, so this exact codepoint-pair is the
 * latin1 "mojibake" signature of a multibyte UTF-8 character -- e.g. Greek d
 * (U+03B4, UTF-8 bytes CE B4) decodes to the 2-char sequence U+00CE U+00B4,
 * which matches. A genuine single accented latin1 character (e.g. the e-acute
 * in a real password "cafe123"-style string) has no continuation byte
 * immediately after it and does not match. Written as a manual charCodeAt
 * loop (numeric comparisons only, no regex escapes) -- the same style as
 * hasBinaryOrReplacement in lib/ulp-parser.ts, which this extends.
 */
export function hasMojibakeSignature(s: string): boolean {
  for (let i = 0; i < s.length - 1; i++) {
    const lead = s.charCodeAt(i)
    const cont = s.charCodeAt(i + 1)
    if (lead >= 0xC2 && lead <= 0xEF && cont >= 0x80 && cont <= 0xBF) return true
  }
  return false
}

/**
 * True if `identity` (an email/login field) is structurally not a real
 * identity: internal whitespace (no real email contains a space — RFC
 * 5321/5322), or an @-domain with no letter at all (every real domain's TLD
 * has letters; catches "x@#", "x@123", and an empty domain after a bare "x@").
 * Logins with no "@" at all (bare usernames) are only checked for whitespace.
 */
export function hasGarbageIdentity(identity: string): boolean {
  const trimmed = identity.trim()
  if (/\s/.test(trimmed)) return true
  const at = trimmed.lastIndexOf('@')
  if (at === -1) return false
  const domainPart = trimmed.slice(at + 1)
  return !/[a-z]/i.test(domainPart)
}

/**
 * SQL fragment (interpolated into scripts/diagnose-and-purge-garbage.sh's
 * IS_GARBAGE predicate — that script's single-quoted heredoc uses a
 * 2-backslash convention, matching the escaping below). True = drop.
 * `email_domain` is the existing materialized column (lower(domain-part-of-
 * email), '' if no '@') defined in docker/clickhouse/init/01-ulp-tables.sql —
 * reused here rather than recomputed.
 */
export const GARBAGE_EXPR = `(
  match(trimBoth(email), '\\s')
  OR (position(email,'@') > 0 AND NOT match(email_domain, '[a-z]'))
  OR match(email, '[\\x{C2}-\\x{EF}][\\x{80}-\\x{BF}]')
  OR match(url,   '[\\x{C2}-\\x{EF}][\\x{80}-\\x{BF}]')
)`
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- ulp-garbage`
Expected: PASS — all `test.each` cases green (2 describe blocks, ~17 cases total).

- [ ] **Step 5: Commit**

```bash
git add lib/ulp-garbage.ts __tests__/ulp-garbage.test.ts
git commit -m "feat: add shared garbage-identity/mojibake classifier module"
```

---

## Task 2: Wire into the parser

**Files:**
- Modify: `lib/ulp-parser.ts:17` (import), `lib/ulp-parser.ts:183-187` (`isJunkCredential`), `lib/ulp-parser.ts:657-663` (Rule 3.5)
- Modify: `__tests__/ulp-parser-extended.test.ts` (header comment + new §25 describe block)

- [ ] **Step 1: Write the failing tests**

In `__tests__/ulp-parser-extended.test.ts`, update the header comment block (after the existing `*  §24 ...` line, around line 20) to add:

```ts
 *  §25 Garbage identity + non-replacement mojibake — whitespace-in-login,
 *      letter-less domains, and latin1-mojibake on email/url (never password)
```

Then append a new describe block at the end of the file (after the existing `§24` block, which currently ends the file):

```ts
// ─────────────────────────────────────────────────────────────────────────────
// §25  Garbage identity + non-replacement mojibake
// Three classes neither isJunkCredential nor the purge script caught before:
// whitespace-in-identity, letter-less domains, and latin1-mojibake on
// email/url. Never on password — the one field that legitimately carries
// non-ASCII content. See lib/ulp-garbage.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe('§25 Garbage identity + non-replacement mojibake', () => {
  test('whitespace-in-login (tab-separated, no URL) → rejected garbage', () => {
    expect(cred('user @example.com\tsecret123')).toBeNull()
    expect(why('user @example.com\tsecret123')).toBe('garbage')
  })

  test('whitespace-in-login with URL → rejected garbage', () => {
    expect(cred('https://example.com\tuser @example.com\tsecret123')).toBeNull()
    expect(why('https://example.com\tuser @example.com\tsecret123')).toBe('garbage')
  })

  test('real screenshot example — heavily spaced login → rejected garbage', () => {
    expect(cred('https://example.com\ty j s J @ i 3 2 Y E G\tsecret123')).toBeNull()
  })

  test('letter-less domain "x@#" → rejected garbage', () => {
    expect(cred('https://example.com\tx@#\tsecret123')).toBeNull()
    expect(why('https://example.com\tx@#\tsecret123')).toBe('garbage')
  })

  test('numeric-only domain "weird@123" → rejected garbage', () => {
    expect(cred('https://example.com\tweird@123\tsecret123')).toBeNull()
  })

  test('mojibake login (Greek decoded as latin1) → rejected garbage', () => {
    expect(cred('https://example.com\tÎ´ÎµÎ¹Î»Î¿Ï@gmail.com\tsecret123')).toBeNull()
    expect(why('https://example.com\tÎ´ÎµÎ¹Î»Î¿Ï@gmail.com\tsecret123')).toBe('garbage')
  })

  test('mojibake URL (French decoded as latin1) → rejected garbage', () => {
    expect(cred('https://caÃ©.com\tuser@site.com\tsecret123')).toBeNull()
    expect(why('https://caÃ©.com\tuser@site.com\tsecret123')).toBe('garbage')
  })

  test('clean ASCII credential is KEPT (regression)', () => {
    const c = cred('https://example.com\tuser@example.com\tsecret123')
    expect(c).not.toBeNull()
    expect(c!.email).toBe('user@example.com')
  })

  test('real accented PASSWORD is KEPT — password is exempt from every rule here', () => {
    const c = cred('https://example.com\tuser@example.com\tcafé123')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('café123')
  })

  test('password containing the literal mojibake signature is KEPT (password is exempt)', () => {
    const c = cred('https://example.com\tuser@example.com\tÎ´ÎµÎ¹Î»Î¿Ï123')
    expect(c).not.toBeNull()
    expect(c!.password).toBe('Î´ÎµÎ¹Î»Î¿Ï123')
  })

  test('positional 3-line block with whitespace-in-login → dropped', () => {
    const content = ['https://example.com/login', 'user @example.com', 'realpassword123'].join('\n')
    const r = parseULPContent(content, 'src.txt')
    expect(r.credentials.length).toBe(0)
    expect(r.rejection_breakdown.garbage).toBe(1)
  })

  test('positional 3-line block with real login → kept (regression)', () => {
    const content = ['https://example.com/login', 'realuser@example.com', 'realpassword123'].join('\n')
    const r = parseULPContent(content, 'src.txt')
    expect(r.credentials.length).toBe(1)
    expect(r.credentials[0].email).toBe('realuser@example.com')
  })

  test('block-format credential with letter-less-domain login → dropped', () => {
    const content = ['Host: https://site.com', 'Login: x@#', 'Password: GoodPass99', '===='].join('\n')
    const r = parseULPContent(content, 'src.txt')
    expect(r.credentials.length).toBe(0)
    expect(r.rejection_breakdown.garbage).toBe(1)
  })

  test('block-format normal credential → kept (regression)', () => {
    const content = ['Host: https://site.com', 'Login: realuser@example.com', 'Password: GoodPass99', '===='].join('\n')
    const r = parseULPContent(content, 'src.txt')
    expect(r.credentials.length).toBe(1)
    expect(r.credentials[0].email).toBe('realuser@example.com')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- ulp-parser-extended`
Expected: FAIL on every new §25 case (the rules don't exist in the parser yet); all pre-existing §1–§24 cases still PASS (no implementation change yet).

- [ ] **Step 3: Implement the parser wiring**

In `lib/ulp-parser.ts`, add the import right after the top file-docstring (after the closing `*/` on line 16, before `export interface ULPCredential` on line 18):

```ts
import { hasGarbageIdentity, hasMojibakeSignature } from '@/lib/ulp-garbage'
```

Then replace the `isJunkCredential` function (lines 183-187):

```ts
function isJunkCredential(login: string, password: string): boolean {
  return isPlaceholderLogin(login)     || isSentinelPassword(password)
      || hasJunkMarker(login)          || hasJunkMarker(password)
      || hasBinaryOrReplacement(login) || hasBinaryOrReplacement(password)
}
```

with:

```ts
function isJunkCredential(login: string, password: string): boolean {
  return isPlaceholderLogin(login)     || isSentinelPassword(password)
      || hasJunkMarker(login)          || hasJunkMarker(password)
      || hasBinaryOrReplacement(login) || hasBinaryOrReplacement(password)
      || hasGarbageIdentity(login)     || hasMojibakeSignature(login)
}
```

Then replace the Rule 3.5 block inside `parseLine` (lines 657-663):

```ts
  // Rule 3.5: binary / encoding-failure rejection. A control byte or a U+FFFD
  // replacement char in any field means the source line was binary or
  // mis-encoded, not a credential — colonSplit will still have produced
  // url/login/password from the junk. Drop it. (International text is unharmed.)
  if (hasBinaryOrReplacement(url) || hasBinaryOrReplacement(login) || hasBinaryOrReplacement(password)) {
    return { credential: null, reason: 'garbage' }
  }
```

with:

```ts
  // Rule 3.5: binary / encoding-failure rejection. A control byte or a U+FFFD
  // replacement char in any field means the source line was binary or
  // mis-encoded, not a credential — colonSplit will still have produced
  // url/login/password from the junk. Drop it. (International text is unharmed.)
  // Also covers identity shape (internal whitespace, letter-less domain) and
  // non-replacement mojibake on url/login — never password (the one field
  // that legitimately carries non-ASCII content).
  if (hasBinaryOrReplacement(url) || hasBinaryOrReplacement(login) || hasBinaryOrReplacement(password)
      || hasGarbageIdentity(login) || hasMojibakeSignature(url) || hasMojibakeSignature(login)) {
    return { credential: null, reason: 'garbage' }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- ulp-parser-extended`
Expected: PASS — all §25 cases green.

- [ ] **Step 5: Run the full parser suite to confirm zero regressions**

Run: `npm test -- ulp-parser`
Expected: PASS across `ulp-parser.test.ts`, `ulp-parser-extended.test.ts`, `ulp-parser-stream.test.ts`, `ulp-parser-block.test.ts` — in particular §8 (Unicode & special characters) and §17 (android:// parsing), which exercise non-ASCII passwords/URLs and `@`-bearing logins. If anything in §1–§24 newly fails, inspect whether it's a genuine false positive (a real-shaped identity/url that `hasGarbageIdentity`/`hasMojibakeSignature` wrongly flags) — if so, narrow the rule — rather than changing the test's expectation.

- [ ] **Step 6: Commit**

```bash
git add lib/ulp-parser.ts __tests__/ulp-parser-extended.test.ts
git commit -m "feat: reject whitespace-identity, letter-less-domain, and mojibake rows in parser"
```

---

## Task 3: Extend the purge script for the existing ~40M rows

**Files:**
- Modify: `scripts/diagnose-and-purge-garbage.sh`

- [ ] **Step 1: Update the header comment**

In `scripts/diagnose-and-purge-garbage.sh`, the header's "A row is GARBAGE if:" list (lines 11-18) currently ends after item (b). Add two new items, replacing lines 17-18 (the existing closing two lines of that block, `# (b) any of url/email/password contains a control byte...` and the following blank line):

```bash
# A row is GARBAGE if:
#   (a) url is http(s) but its host isn't a real hostname (domain(url) fails a
#       Unicode-aware dot-separated-label check) AND the email isn't a real
#       email (so there's nothing salvageable). App schemes (android://) and
#       scheme-less hosts are NOT touched, mirroring the parser.
#   (b) any of url/email/password contains a control byte (excl. tab/LF/CR) or
#       the U+FFFD replacement char -- a sure sign of binary/mis-encoded input.
#   (c) the email contains internal whitespace, or has an @-domain with no
#       letter at all (e.g. "x@#", "x@123") -- no real email matches either.
#   (d) email or url contains the latin1-mojibake signature of a multibyte
#       UTF-8 character (real UTF-8 decoded as latin1 by the parser) -- NEVER
#       checked on password, the one field that legitimately carries
#       non-ASCII content. See lib/ulp-garbage.ts (shared with the parser).
```

- [ ] **Step 2: Extend the `IS_GARBAGE` predicate**

Replace the `IS_GARBAGE` heredoc block:

```bash
IS_GARBAGE=$(cat <<'EOF'
(
  ( match(url, '^https?://')
    AND NOT match(domain(url), '^[\\p{L}\\p{N}]([\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?(\\.[\\p{L}\\p{N}]([\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?)+$')
    AND NOT match(email, '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$') )
  OR match(url,      '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]')
  OR match(email,    '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]')
  OR match(password, '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]')
  OR position(url,      unhex('EFBFBD')) > 0
  OR position(email,    unhex('EFBFBD')) > 0
  OR position(password, unhex('EFBFBD')) > 0
)
EOF
)
```

with:

```bash
IS_GARBAGE=$(cat <<'EOF'
(
  ( match(url, '^https?://')
    AND NOT match(domain(url), '^[\\p{L}\\p{N}]([\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?(\\.[\\p{L}\\p{N}]([\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?)+$')
    AND NOT match(email, '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$') )
  OR match(url,      '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]')
  OR match(email,    '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]')
  OR match(password, '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]')
  OR position(url,      unhex('EFBFBD')) > 0
  OR position(email,    unhex('EFBFBD')) > 0
  OR position(password, unhex('EFBFBD')) > 0
  OR match(trimBoth(email), '\\s')
  OR (position(email,'@') > 0 AND NOT match(email_domain, '[a-z]'))
  OR match(email, '[\\x{C2}-\\x{EF}][\\x{80}-\\x{BF}]')
  OR match(url,   '[\\x{C2}-\\x{EF}][\\x{80}-\\x{BF}]')
)
EOF
)
```

(This must stay textually identical to `GARBAGE_EXPR` in `lib/ulp-garbage.ts` — same four new clauses, same 2-backslash heredoc escaping already used by every existing clause in this block.)

- [ ] **Step 3: Extend the §2 sub-signals query**

Replace:

```bash
echo "═══ 2/5  Sub-signals (which rule fires) ═════════════════════════"
$CH "
SELECT
  countIf(match(url, '^https?://') AND NOT match(domain(url), '^[\\\\p{L}\\\\p{N}]([\\\\p{L}\\\\p{N}-]*[\\\\p{L}\\\\p{N}])?(\\\\.[\\\\p{L}\\\\p{N}]([\\\\p{L}\\\\p{N}-]*[\\\\p{L}\\\\p{N}])?)+\$')) AS bad_host_any,
  countIf(match(url, '[\\\\x00-\\\\x08\\\\x0B\\\\x0C\\\\x0E-\\\\x1F]') OR match(email, '[\\\\x00-\\\\x08\\\\x0B\\\\x0C\\\\x0E-\\\\x1F]') OR match(password, '[\\\\x00-\\\\x08\\\\x0B\\\\x0C\\\\x0E-\\\\x1F]')) AS has_control_byte,
  countIf(position(url, unhex('EFBFBD'))>0 OR position(email, unhex('EFBFBD'))>0 OR position(password, unhex('EFBFBD'))>0) AS has_replacement_char
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format Vertical
echo ""
```

with:

```bash
echo "═══ 2/5  Sub-signals (which rule fires) ═════════════════════════"
$CH "
SELECT
  countIf(match(url, '^https?://') AND NOT match(domain(url), '^[\\\\p{L}\\\\p{N}]([\\\\p{L}\\\\p{N}-]*[\\\\p{L}\\\\p{N}])?(\\\\.[\\\\p{L}\\\\p{N}]([\\\\p{L}\\\\p{N}-]*[\\\\p{L}\\\\p{N}])?)+\$')) AS bad_host_any,
  countIf(match(url, '[\\\\x00-\\\\x08\\\\x0B\\\\x0C\\\\x0E-\\\\x1F]') OR match(email, '[\\\\x00-\\\\x08\\\\x0B\\\\x0C\\\\x0E-\\\\x1F]') OR match(password, '[\\\\x00-\\\\x08\\\\x0B\\\\x0C\\\\x0E-\\\\x1F]')) AS has_control_byte,
  countIf(position(url, unhex('EFBFBD'))>0 OR position(email, unhex('EFBFBD'))>0 OR position(password, unhex('EFBFBD'))>0) AS has_replacement_char,
  countIf(match(trimBoth(email), '\\\\s')) AS has_whitespace_identity,
  countIf(position(email,'@')>0 AND NOT match(email_domain, '[a-z]')) AS has_letterless_domain,
  countIf(match(email, '[\\\\x{C2}-\\\\x{EF}][\\\\x{80}-\\\\x{BF}]') OR match(url, '[\\\\x{C2}-\\\\x{EF}][\\\\x{80}-\\\\x{BF}]')) AS has_mojibake_signature
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format Vertical
echo ""
```

(This block runs inside a directly double-quoted `$CH "..."` string, not the single-quoted `IS_GARBAGE` heredoc, so it needs 4 backslashes per escape — matching the existing `has_control_byte` line directly above it — not the 2-backslash convention used in Step 2.)

- [ ] **Step 4: Syntax-check the script**

Run: `bash -n scripts/diagnose-and-purge-garbage.sh`
Expected: no output, exit code 0 (valid bash syntax). This is the only check available in this dev environment — there is no local ClickHouse to run the query against. Real verification happens on the Ubuntu host (Task 4, Step 4).

- [ ] **Step 5: Commit**

```bash
git add scripts/diagnose-and-purge-garbage.sh
git commit -m "feat: extend garbage purge script with whitespace/letterless-domain/mojibake rules"
```

---

## Task 4: Full verification + final review

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (688 + the new `ulp-garbage.test.ts` cases + the new §25 cases), 0 failures.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors (warnings acceptable only if already present on `main` before this change).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Final review**

Review the full diff (`git diff main...HEAD` or equivalent) against `docs/superpowers/specs/2026-06-26-garbage-classifier-design.md`: confirm `hasGarbageIdentity`/`hasMojibakeSignature` are never called on `password` anywhere, confirm `GARBAGE_EXPR` and the parser's checks are logically identical (same four conditions), and confirm no schema/migration file was touched.

- [ ] **Step 6: Note the manual post-deploy step (not part of this commit)**

After this branch is deployed (`git pull && docker compose up -d --build app` on the Ubuntu host), run the purge script read-only to see the new classes' real counts before any delete:

```bash
bash scripts/diagnose-and-purge-garbage.sh
```

Review the §2 sub-signal counts (`has_whitespace_identity`, `has_letterless_domain`, `has_mojibake_signature`) and the §3 sample rows. Only then run `PURGE=1 bash scripts/diagnose-and-purge-garbage.sh` to delete them, and re-run read-only afterward to confirm the counts fall toward zero.
