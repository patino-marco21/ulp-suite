# ULP parser — sentinel passwords + extended placeholder logins

- **Date:** 2026-06-15
- **Status:** Implemented
- **Scope:** `lib/ulp-parser.ts` only. Forward-only. Follow-up to `2026-06-14-ulp-parser-garbage-fixes-design.md`.
- **Origin:** Top-value scan of `ulp.credentials` (52.34M rows) revealed large junk classes the 2026-06-14 fixes missed.

## Problem

The 2026-06-14 placeholder check ran on the **login** field only. The most common junk
is actually in the **password** field — "no password could be extracted" sentinels —
and several placeholder **logins** were not catalogued. Counts from the live table:

| Class | Count | Example |
|---|---:|---|
| `[NOT_SAVED]` as **password** (Chrome "not saved" marker) | 92,634 | `url\|user\|[NOT_SAVED]` |
| `*none*` password | 84,259 | |
| `[fail]` password | 40,957 | |
| `Decryptionfailed.` password | 16,493 | |
| `Old or unknown version.` password | 12,689 | |
| `none`/`None` password | ~77,000 | |
| **Sentinel passwords subtotal** | **~324,000** | |
| Placeholder logins `UNKNOWN`/`{mail}`/`false`/`missing-user`/`PASS` | ~117,000 | |

Web research confirms these are non-credentials: Chrome's `blacklisted_by_user=1`
entries (user declined to save) carry empty/sentinel password fields
([ASEC/RedLine](https://asec.ahnlab.com/en/29885/),
[Group-IB combolists](https://www.group-ib.com/blog/combolists-ulp-darkweb/)).

Two patterns were checked and found **not** worth handling: `<!--…-->` base64 HTML-comment
blobs (only 119 rows — the prior summary over-weighted this) and bare base64 token logins
(~4k, ambiguous/indistinguishable from real usernames).

## Design

All in `lib/ulp-parser.ts`, reusing the 2026-06-14 reject machinery:

- **`SENTINEL_PASSWORDS`** set + `isSentinelPassword(password)` — exact match (trimmed,
  case-insensitive), so a real password merely *containing* a token (e.g. `none123`) is
  unaffected. Members: `[not_saved]`, `not_saved`, `*none*`, `none`, `[fail]`,
  `decryptionfailed.`, `old or unknown version.`, `[empty]`, `*empty*`, `[fetch_error]`.
  `none`/`None` are included per explicit decision (accepts the small risk of dropping a
  real password literally equal to "none").
- **`PLACEHOLDER_LOGINS`** extended with `unknown`, `{mail}`, `{email}`, `false`,
  `missing-user`, `pass`. (`user`/`username`/`admin`/`root` remain excluded — real logins.)
- Wired into both reject paths: `parseLine` Rule 3.7 (inline) and `isJunkCredential`
  (block + positional). Rejection reason reused: `garbage`.

## Decisions / risks

- **`none`/`None` and `pass`/`false` as reject tokens** carry a small false-positive risk
  (a real password/username could equal one of these). Accepted per the goal of cutting the
  largest junk class; exact-match scoping keeps the blast radius to literal equality.
- **Reason = `garbage`** (not `no_password`) keeps the block/positional wiring uniform
  through the single `isJunkCredential` gate. A sentinel password is semantically
  "no password", but bucketing it with the junk family is acceptable and consistent.

## Tests

New `§22` block in `__tests__/ulp-parser-extended.test.ts` (14 tests): each sentinel
password rejected; `none123` kept (exact-match proof); real weak `123456` kept; the new
placeholder logins rejected; a positional block with a sentinel password dropped and
counted as `garbage`. Full suite: 495/495.

## Rollout

Forward-only — applies to new and re-imported data; the ~440k existing rows are corrected
by re-importing source files through the fixed parser.
