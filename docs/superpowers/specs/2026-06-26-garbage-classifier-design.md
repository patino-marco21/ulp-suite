# Garbage classifier — whitespace identities, punctuation domains, non-replacement mojibake

- **Date:** 2026-06-26
- **Status:** Approved (design); pending implementation plan
- **Scope:** `lib/ulp-garbage.ts` (new, shared) + `lib/ulp-parser.ts` (parser gate) +
  `scripts/diagnose-and-purge-garbage.sh` (existing-data purge). Drop-only, no schema change.
- **Origin:** Credentials Browser screenshot (40,053,493 rows, Domain A→Z view) showing
  malformed rows clustered at the top of the sort.

## 1. Problem

The Credentials Browser still surfaces large volumes of malformed rows after two prior
rounds of cleanup:

- `scripts/diagnose-and-purge-garbage.sh` already deletes bad-host `http(s)` URLs with no
  real email, control bytes, and the `�` (`EF BF BD`) replacement-char mojibake — and has
  already been run with `PURGE=1` against the live table.
- The 2026-06-14 parser fixes already reject port/path-leaks, placeholder logins
  (`Password`, `N/A`), token/decryption-junk markers, and the same `ï¿½` replacement-char
  signature, via the `isJunkCredential` gate called from every emit path.

What remains is three classes neither surface catches, because both were built around
*http-URL host validity* and *the replacement character specifically* — not identity shape
or non-replacement mojibake:

| # | Class | Example | Why existing tools miss it |
|---|---|---|---|
| 1 | Whitespace-in-identity | `Shubashi @ gmail.com`, `@ 1 E x a n d e r` | No whitespace/shape check on the login/email field anywhere. |
| 2 | Letter-less (punctuation-only) domain | `&aq2ZS*@#` → domain `#`, `8004882ea1213.,@!` → `!` | The purge's host check only fires on `^https?://` URLs; these rows carry no URL, just a junk `@`-fragment. |
| 3 | Non-replacement mojibake | `Î´ÎµÎ¹Î»Î¿Ï`, `Ã©`, `Â£` | `Buffer.toString('latin1')` decode of real UTF-8 produces *valid* latin1 (printable chars), not control bytes or `ï¿½` — the only two signals the existing checks test for. |

## 2. Goals / Non-goals

**Goals**
- Reject all three classes at parse time so new imports stop manufacturing them.
- Extend the existing purge script to delete matching rows from the existing ~40M-row
  table, using the exact same predicate as the parser (single source of truth).
- Zero regressions: a clean ASCII credential, and a credential with a real but
  **accented password** (e.g. `café123`), must still be kept.

**Non-goals**
- Salvage/recovery of the three classes. All three are drop-only, new and existing rows
  alike — confirmed: existing rows can't be salvaged in place regardless (`email`/`domain`
  are `ORDER BY` key columns; ClickHouse `ALTER TABLE … UPDATE` cannot modify key columns),
  and salvage-on-import was explicitly declined to keep behavior consistent between new and
  existing data.
- "Code/file captured as password" (e.g. a Python script in the password field) — fuzzy to
  define safely, deferred.
- Any change to `password` field validation. All three rules judge `email`/identity (and
  Rule 3 also `url`); `password` is explicitly out of scope (see §3.2).
- A new `is_garbage` materialized column. Drop-only means nothing needs to be flagged and
  filtered — only the `is_noise` precedent (a *filter*, not a delete) used a column; this
  project's data-policy decision was delete, so no schema change is needed.

## 3. Design

### 3.1 Shared module — `lib/ulp-garbage.ts`

Mirrors the existing `lib/ulp-noise.ts` pattern exactly: one canonical SQL expression plus a
JS mirror, so the parser (TS) and the purge script (SQL) can never drift apart.

```ts
/** SQL fragment (interpolated into the purge script's heredoc). True = drop.
 *  Assembled from the three rules' SQL clauses, OR'd together — §3.1 below
 *  gives each rule's exact SQL clause and JS equivalent. */
export const GARBAGE_EXPR = `<rule 1 SQL> OR <rule 2 SQL> OR <rule 3 SQL>`

/** JS mirror — unit-tested directly, used by the parser's isJunkCredential gate. */
export function hasGarbageIdentity(identity: string): boolean   // Rule 1 OR Rule 2
export function hasMojibakeSignature(s: string): boolean        // Rule 3
```

**Rule 1 — whitespace-in-identity.** The identity field contains internal whitespace (after
trim). RFC 5321/5322 forbid spaces in an address, so no real email can match this — zero
false-positive risk.
- TS: `/\s/.test(identity.trim())`
- SQL: `match(trimBoth(email), '\\s')`

**Rule 2 — letter-less domain.** The identity contains `@`, and the domain part (after the
last `@`) contains no ASCII letter. Every real domain's TLD has letters.
- TS: `identity.includes('@') && !/[a-z]/i.test(domainPart)`
- SQL: reuses the materialized `email_domain` column:
  `position(email,'@')>0 AND email_domain!='' AND NOT match(email_domain,'[a-z]')`

**Rule 3 — non-replacement mojibake.** The latin1 view of a UTF-8 multibyte sequence: a lead
byte `[\xC2-\xDF\xE0-\xEF]` immediately followed by a continuation byte `[\x80-\xBF]`. This
is an extension of the *existing* `hasBinaryOrReplacement` corruption check (which already
drops control bytes / `ï¿½` regardless of whether the email looks real) — same drop-always
semantics, broader signature.
- An isolated accented latin1 character (a real `café`) has no continuation byte after it,
  so it does not match this signature — this is what keeps Rule 3 from firing on real
  accented passwords.
- TS: regex over the lead/continuation byte-pair signature (operating on the latin1-decoded
  string, where each original byte is one char).
- SQL: equivalent `match()` byte-range signature.

### 3.2 Parser integration (new imports) — `lib/ulp-parser.ts`

`hasGarbageIdentity` and `hasMojibakeSignature` from `lib/ulp-garbage.ts` are added to the
existing `isJunkCredential` gate (already called from every emit path: inline `parseLine`,
both positional emitters, both block-flush paths) and to the existing URL corruption check
alongside `hasBinaryOrReplacement`. Rejection reason: the existing `garbage` (no new
`RejectionReason` literal, matching the 2026-06-14 precedent).

**Scope is identity + URL, never password.** Real email addresses and URLs are pure ASCII
(punycode/ASCII local-parts); whitespace, a letter-less domain, or mojibake there is always
junk. Passwords are the one field that legitimately carries non-ASCII content — leaving them
untouched guarantees a real credential is never dropped just because its password has an
accented character mangled by the latin1 decode. The existing control-byte/`ï¿½` password
check is unchanged.

**Known tradeoff (accepted):** a real non-Latin-script identity (Cyrillic/Greek/CJK) decodes
to mojibake under `Buffer.toString('latin1')` and will now be rejected by Rule 3. This
overlaps heavily with the existing T3 hard-drop policy, and real emails are ASCII regardless
of the account holder's script, so the practical loss is confined to already-low-value
identities.

### 3.3 Purge integration (existing ~40M rows) — `scripts/diagnose-and-purge-garbage.sh`

Extends the existing `IS_GARBAGE` heredoc predicate with the three `GARBAGE_EXPR` terms
(same `\\`-escaping convention already used in the script), and adds matching labeled
count / sub-signal / sample sections (mirroring the script's existing §1–§4 structure) so
each new rule's matches are visible and sampled before any delete. No change to the script's
read-only-by-default / `PURGE=1` / async-mutation / re-run-to-confirm flow.

Because `PURGE=1` has already been run against the *old* predicate, the old terms now match
~0 rows; the new sections surface exactly the three classes from the screenshot.

## 4. Testing (TDD, failing-first)

| Test (file) | Asserts |
|---|---|
| `ulp-garbage.test.ts` (new) | `hasMojibakeSignature`: positive (`Î´`, `Ã©`, `Ð¿Ñ€Ð¸`), negative (clean ASCII, empty, isolated high-latin1 char with no continuation byte). `hasGarbageIdentity`: positive (`a @ b.com`, `@ 1 E`, `x@#`, `x@123`, `Î´@x`), negative (`john@gmail.com`, `john_doe`, empty). |
| `ulp-parser-extended.test.ts` (extend) | New describe block: spaced-email / punctuation-domain / mojibake-identity / mojibake-URL lines rejected `garbage` across inline + positional + block emit paths. **Regression guards:** clean ASCII cred kept; `user@site.com:café123` (accented password) kept. Review existing §8 valid-Unicode test — non-ASCII in password is unaffected; non-ASCII in identity flips to rejected (deliberate, noted inline like the 2026-06-14 §2 update). |
| Manual (purge script) | Read-only run on the Ubuntu host after the parser change ships; eyeball new sample sections before any `PURGE=1`. |

**Regression gate.** Full `npm test` green across the parser suite (`ulp-parser.test.ts`,
`ulp-parser-extended.test.ts`, `ulp-parser-stream.test.ts`, `ulp-parser-block.test.ts`) plus
the new `ulp-garbage.test.ts`; typecheck / lint / build clean.

## 5. Risks & mitigations

- **Rule 3 false positives.** Mitigated structurally (continuation-byte requirement excludes
  isolated accented chars) and operationally (the purge script's existing sample-before-delete
  step lets the exact regex be verified against real rows before any `DELETE` fires).
- **Rule 2 over-matching numeric domains.** A domain that is all-digits (no letters) is
  already not a valid real-world TLD today, so this is intentional, not a corner case.
- **Non-Latin identity loss (§3.2 known tradeoff).** Accepted; overlaps existing T3 policy.
- **Drift between parser and purge.** Eliminated by construction — both read from
  `lib/ulp-garbage.ts`'s single canonical definitions, not independent reimplementations.

## 6. Rollout

- Parser fix is forward-only — takes effect on the next import, no migration, no schema
  change (drop-only, matching the existing `garbage` reason; no new column).
- Existing ~40M rows: on the Ubuntu host, `bash scripts/diagnose-and-purge-garbage.sh`
  (read-only) → review the new sample sections → `PURGE=1 bash scripts/diagnose-and-purge-garbage.sh`
  → re-run read-only to confirm counts fall toward zero.
- Deploy unchanged: `git pull && docker compose up -d --build app` (rebuilds only the `app`
  service; the purge script runs via `docker exec` against the existing ClickHouse
  container/volume — never recreated).

## 7. Success criteria

- New imports never manufacture whitespace-identity, letter-less-domain, or
  non-replacement-mojibake rows.
- The purge script reports and deletes all three classes from the existing table while
  preserving rows with a real ASCII email and any row with a non-ASCII **password**.
- The Domain A→Z Credentials Browser view no longer clusters whitespace/punctuation/mojibake
  rows at the top.
- All existing tests plus the new `ulp-garbage.test.ts` pass; typecheck / lint / build clean.
