# ULP parser reject taxonomy (reference)

- **Date:** 2026-06-15
- **Status:** Reference (consolidates the 2026-06-14/06-15 parser hardening work)
- **Scope:** `lib/ulp-parser.ts`. All rejections are **forward-only** — they apply to new
  imports and anything re-imported through the fixed parser; existing rows are unchanged.

This is the single source of truth for what the parser drops, what it deliberately keeps,
and what it deliberately leaves alone. Counts are from the live `ulp.credentials` table
(52,339,301 rows) at the time of the work. The reject machinery is shared across all
emission paths (inline `parseLine` Rule 3.x, block `flushBlockState`, and the positional
emitters in `parseULPContent`/`parseULPStream`); the production import path is
`parseULPStream`.

## What the parser rejects (reason `garbage` unless noted)

| Class | Signal | ~Rows | Spec/commit |
|---|---|---:|---|
| Double-encoded mojibake | `hasBinaryOrReplacement`: the latin1 view of `EF BF BD` (`ï¿½`) + control bytes/U+FFFD | 2.1k | 2026-06-14 |
| Garbage URL host | `^https?://` with a non-host (`isValidHost` fails) and no salvageable email | — | (pre-existing, retained) |
| Placeholder login | `isPlaceholderLogin`: `password`, `n/a`, `na`, `none`, `null`, `undefined`, `[not_saved]`, `not_saved`, `unknown`, `[unknown]`, `{mail}`, `{email}`, `false`, `missing-user`, `pass`, `https`, `http` | ~210k+ | 2026-06-14/15 |
| Sentinel password | `isSentinelPassword`: `[not_saved]`, `*none*`, `none`, `[fail]`, `decryptionfailed.`, `old or unknown version.`, `[empty]`, `*empty*`, `[fetch_error]`, and all-asterisk masks (`^\*+$`) | ~324k | 2026-06-15 |
| Token / decryption blob | `hasJunkMarker` on login/password: `gmail_ps=`, `gmail=`, `==@com.`, `[Wrong padding]` | ~177k | 2026-06-14 |
| URL-path-with-`@` in login slot | colonSplit email shortcut now requires `@` to precede any `/`; a 2-field `host/path/@x:value` → `no_fields` | 27.6k | 2026-06-15 |

All checks are trimmed + case-insensitive, and exact-match for the sets (so a real password
*containing* a token, e.g. `none123`, is unaffected).

## What the parser deliberately recovers

| Class | Behavior | ~Rows |
|---|---|---:|
| Port/path-leak | scheme-less `host:port[/path]:login:pass` folds the port into the URL instead of making it the login; never drops a row the old code kept (numeric-login fall-through) | 176k |
| URL-path-with-`@` (3-field) | `host/path/@x:login:pass` keeps the path as the URL and extracts the real `login`/`pass` | — |

## What the parser deliberately KEEPS (false-positive guards)

- **Real default/device logins:** `admin`, `administrator`, `root`, `ubnt`, `info`, `user`,
  `username` — common real accounts (router/admin panels), so they are **not** placeholders.
- **Weak real passwords:** `password`, `123456`, `qwerty`, `P@ssw0rd`, etc. — the placeholder
  check is login-only; the sentinel check is exact-match.
- **Legit `android://…==@com.pkg`:** the `==@com.` marker is checked only on login/password,
  never the URL.
- **Phone logins** (`+91`, `+62`, …): classified via `login_type`, kept.

## Deliberately deferred (documented non-goals)

- **`(https…` parenthesized/markdown-annotated URLs** (~10k): irregular source shape
  (`host (https://host/path):login:pass`); a clean parser fix isn't feasible and a band-aid
  reject wouldn't recover the buried credential. Deferred.
- **Bare base64 token logins** (GAIA recovery tokens, ~tens of thousands): indistinguishable
  from real long usernames — too high a false-positive risk. Deferred.
- **Ambiguous tokens** `login` (15k), single-char logins (`1`, `c`): possible real usernames;
  excluded on the same caution as `user`/`username`.
- **Recovery/backfill of existing rows:** out of scope — handled by re-importing source files
  through the fixed parser (and de-duplicating), on the operator's processing host.

## Tests

`__tests__/ulp-parser-extended.test.ts` §18–§24 and `__tests__/ulp-parser-stream.test.ts`
("garbage rejection (production path)") cover every class above through both `parseLine`/
`parseULPContent` and the streaming `parseULPStream`, including positive (rejected) and
negative (kept) cases and the recovery shapes. `__tests__/rejection-report.test.ts` covers
the shared rejection-reason labels/recommendations surfaced in the parse-sample diagnostic
and the upload UI.

## Diagnostic surfacing

`garbage` is now labeled and recommended-on in the parse-sample admin endpoint and the
upload UI's "why skipped" panel, via the shared `lib/rejection-report.ts` module.
