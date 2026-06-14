# ULP parser garbage fixes — port/path-leak, junk-marker rejection, double-encoded mojibake

- **Date:** 2026-06-14
- **Status:** Approved (design)
- **Scope:** `lib/ulp-parser.ts` only. Forward-looking parser fixes. No recovery/backfill of existing rows.
- **Origin:** Triage of the live Credentials Browser ("riddled with bugs") + quantification against the local ClickHouse `ulp.credentials` table (52,339,301 rows).

## 1. Problem

The Credentials Browser surfaces large volumes of mis-parsed and junk rows. Quantified across all 52.34M rows, the dominant identifiable classes are:

| # | Class | Count | Real source shape (reverse-engineered) | Verdict |
|---|---|---:|---|---|
| 1 | Port/path-leak (`email ~ ^[0-9]+/`) | 176,405 | scheme-less `host:port/path:login:pass` — the **port** is parsed as the login | **Recover** |
| 2 | Placeholder identity (`email` ∈ Password/N/A/user/[NOT_SAVED]…) | 209,820 (187,220 are literally `password`) | RedLine/Vidar positional blocks where the username is genuinely missing; a label/placeholder landed in the identity column | Reject |
| 3 | Corrupted GAIA-token glue (`==@com.` in login/pass) | 176,929 | digit-obfuscated token blobs (`...==@com.tlive`), **not** real `android://` creds | Reject |
| 4 | Double-encoded mojibake (`ï¿½`) | 2,102 | binary/mis-encoded source; the latin1 view of the `EF BF BD` replacement-char bytes | Reject (filter gap) |
| 5 | Decryption junk (`[Wrong padding] HEX:`) | 293 | failed AES/hex decryption artifacts | Reject |
| 6 | GAIA recovery tokens (`gmail_ps=`, `gmail=`) | 179 | Google account token blobs, not passwords | Reject |

**Root-cause notes**
- Class 1 is the parser's own documented wart: the §2 test `mysite.com:443:admin:secret123` asserts "443 becomes login". The colon-splitter's no-scheme branch treats the first colon-field after the host as the login, so a port (`10000/`, `443`) is mis-assigned.
- Class 2 is produced by the positional 3-line mode (and other paths) accepting a placeholder token as a login. We reject the **symptom** (placeholder login) rather than re-architecting positional mode (out of scope — regression risk).
- Class 4 is a real filter gap: `hasBinaryOrReplacement` checks `c === 0xFFFD`, but the streaming parsers decode bytes with `Buffer.toString('latin1')`, so a real U+FFFD never appears as codepoint 0xFFFD — it appears as the 3-char sequence `ï¿½`. The check never fires.

## 2. Goals / Non-goals

**Goals**
- Recover the port/path-leak class on (re-)import by parsing `host:port[/path]:login:pass` correctly.
- Reject placeholder-identity, token-blob, decryption-junk, and double-encoded-mojibake rows at parse time so they stop being manufactured.
- Zero regressions in the existing suite (95 base + extended + stream + block tests).

**Non-goals (explicitly out of scope)**
- Recovery/backfill of the existing 52.34M rows (re-import or ClickHouse mutation). Forward-only.
- Tightening the positional 3-line mode (root cause of class 2) — riskier; we reject the symptom instead.
- New rejection-reason types / config-driven reject lists / monitoring surface changes.

## 3. Design

All changes live in `lib/ulp-parser.ts`. TDD: write failing tests first (new §18 section), then implement.

### Fix 1 — Port/path-leak (`colonSplit`, no-scheme branch)

Today the no-scheme branch (`colonSplit`, ~lines 380–401) does, for `host:X:rest`:
`url=host, login=X, password=rest`.

**Change:** after computing `left` (host) and confirming it has no `@`, inspect the segment between the first and second colon (`mid = line.slice(c1+1, c2)`). If `mid` is a **port** or **port+path**, fold `host:mid` into the URL and re-split the remainder as `login:password`.

`mid` is treated as part of the URL when:
- `mid` matches `^\d+/` (digits then a slash — a port with a path), **or**
- `mid` matches `^\d{1,5}$` and its numeric value ≤ 65535 (a bare port).

Behavior:
- `localhost:10000/:admin:12345` → `url=localhost:10000/`, `login=admin`, `password=12345`
- `admin:10000/session_login.cgi:studioprint:3571nt62` → `url=admin:10000/session_login.cgi`, `login=studioprint`, `password=3571nt62`
- `psvm001:1000/:psdc001\administrator:AAS@4770477` → `url=psvm001:1000/`, `login=psdc001\administrator`, `password=AAS@4770477`
- `mysite.com:443:admin:secret123` → `url=mysite.com:443`, `login=admin`, `password=secret123` (**changes the §2 test**, see §5)

Non-port middles are untouched (the heuristic only fires on a digit-led `mid`):
- `example.com:alice:hunter2pass` → unchanged (`mid=alice`)
- `steamcommunity.com:user@gmail.com:pass` → unchanged (`mid=user@gmail.com`)
- `mail.google.com:user@gmail.com:pass123` → unchanged

Edge cases:
- `host:port` with no trailing `login:password` (only two fields) → still `no_fields` (no credential). Acceptable.
- `host:port/path` only (no creds after) → `no_fields`. Acceptable.
- `extractDomain` on the rebuilt `host:port[/path]` works: with a dot it strips port/path correctly (`intranet.corp.com:8080/app` → `intranet.corp.com`); `localhost`/`psvm001` (no dot) → `domain=''`, which is correct.
- Rule 3.6 garbage-URL rejection only inspects `^https?://` URLs, so scheme-less rebuilt URLs are not affected.
- The `://`-present branch already absorbs ports (existing §2 path/port tests) — Fix 1 is no-scheme only.

### Fix 2 — Reject junk markers

Two new predicates plus a small constant set:

```ts
// Logins that are export placeholders, never a real identity.
const PLACEHOLDER_LOGINS = new Set([
  'password', 'n/a', 'na', 'none', 'null', 'undefined', '[not_saved]', 'not_saved',
  'user', 'username',
])
function isPlaceholderLogin(login: string): boolean {
  return PLACEHOLDER_LOGINS.has(login.trim().toLowerCase())
}

// Token / decryption blobs that never appear in a real login or password.
function hasJunkMarker(s: string): boolean {
  return s.includes('gmail_ps=') || s.includes('gmail=')
      || s.includes('==@com.')   || s.includes('[Wrong padding]')
}
```

Rejection (reason `garbage`, reused — no new reason type) fires when:
- `isPlaceholderLogin(login)` — checked on the **login only**, never the password (so a weak real password like `password` survives), **or**
- `hasJunkMarker(login) || hasJunkMarker(password)` — `==@com.` is checked on login/password only, never the url, so legit `android://HASH==@com.pkg` URLs are unaffected.

**Emission-point coverage (important).** These checks must run on every path that finalizes a credential, not just inline `parseLine`:
1. `parseLine` — add after the existing Rule 3.6 (covers inline + colon/tab/semicolon/pipe).
2. `flushBlockState` — block-labeled credentials.
3. Positional emit points in `parseULPContent` and `parseULPStream` — the placeholder-`password` class (class 2) arrives here.

To avoid duplication, introduce one helper called from all four sites:

```ts
function isJunkCredential(login: string, password: string): boolean {
  return isPlaceholderLogin(login) || hasJunkMarker(login) || hasJunkMarker(password)
}
```

`flushBlockState` and the positional emitters currently do **not** call any garbage check; wiring `isJunkCredential` (and, see Fix 3, the binary check) into them is part of this change.

### Fix 3 — Double-encoded mojibake (`hasBinaryOrReplacement`)

Add one line to `hasBinaryOrReplacement` (~line 92): also return `true` when the string contains the 3-char sequence `ï¿½` (the latin1 view of the `EF BF BD` UTF-8 replacement-char bytes — what renders as `ï¿½`). This is always a corruption signal (those bytes only exist after a decoder already replaced invalid input).

```ts
if (s.includes('ï¿½')) return true
```

Because `flushBlockState` / positional emitters don't currently call `hasBinaryOrReplacement`, this fix only takes full effect once those paths also run the binary check (folded into the Fix 2 emission-point wiring, e.g. an `isJunkCredential` that also calls `hasBinaryOrReplacement(login) || hasBinaryOrReplacement(password)`).

## 4. Rejection reason

Reuse the existing `garbage` `RejectionReason`. No type, schema, `makeRejectionMap`, or `parse-sample` changes — `parse-sample` already renders unknown reasons via a label fallback, and `parseLine` already returns `garbage` for binary/url-junk.

## 5. Test plan

TDD, failing-first. New describe block **§18 "Garbage taxonomy fixes"** in `__tests__/ulp-parser-extended.test.ts`:

1. **Port/path-leak** (Fix 1): the four behavioral examples above + the non-port regression cases. Assert `url`, `email`, `password`, and `domain`.
2. **Bare port** (Fix 1): `mysite.com:443:admin:secret123` → `url=mysite.com:443`. **Update** the existing §2 test `'no-scheme domain with port-like segment'` to the new expectation (delete the old "443 becomes login" assertion; replace with the corrected one and a comment noting the behavior change).
3. **Placeholder identity** (Fix 2): `…:Password`, `…:N/A`, `…:[NOT_SAVED]` → rejected `garbage`; a real weak password `site.com:user:password` is **kept** (placeholder check is login-only).
4. **Token/decryption blobs** (Fix 2): `gmail_ps=…`, `gmail=…`, `==@com.` in password, `[Wrong padding] HEX:` → rejected; legit `android://HASH==@com.instagram.android:user:pass` → **kept** (existing §17 must still pass).
5. **Double-encoded mojibake** (Fix 3): a line containing `ï¿½` in any field → rejected `garbage`; an all-valid Unicode line (Cyrillic/Chinese/emoji, §8) → still **kept**.
6. **Emission-path coverage**: a positional 3-line block `<host>\n password \n value:value` → rejected (placeholder login reaches the positional emitter); a block-format credential with a junk marker → rejected.

**Real-data validation.** Reconstruct the actual mis-parsed source line from live DB rows (e.g. `url + ':' + email + ':' + password`) for a handful of sampled class-1 rows and assert the fixed parser now yields the correct `url/email/password`. (Manual/one-off check during implementation; not a committed network-dependent test.)

**Regression gate.** Full suite green: `npm test` (vitest) across `ulp-parser.test.ts`, `ulp-parser-extended.test.ts`, `ulp-parser-stream.test.ts`, `ulp-parser-block.test.ts`. The only intentionally-changed assertion is the §2 bare-port test.

## 6. Risks & mitigations

- **Placeholder false positives — `user`/`username`.** These are occasionally real usernames. Included per the approved "drop placeholder rows entirely" decision; the loss is a small slice vs. the 187k clear-junk `password` rows. Flagged for spec review — easy to drop from `PLACEHOLDER_LOGINS` if undesired.
- **`password` as a real username.** Extraordinarily rare; the data shows these are positional mis-alignments (login==password, NordVPN/UUID hosts). Net positive to reject.
- **Fix 1 over-absorption.** Bounded by `^\d{1,5}$` ≤ 65535 (bare port) or a required slash (port+path); alphanumeric logins never match. The `://` branch is untouched.
- **`==@com.` collateral.** Checked on login/password only; legit `android://` creds carry the marker in the url field, so they pass.

## 7. Rollout

Forward-only. New imports parse correctly immediately. Existing rows are corrected by re-importing the original source files through the fixed parser (recovers the port/path-leak class) — out of scope here, handled separately by the operator.
