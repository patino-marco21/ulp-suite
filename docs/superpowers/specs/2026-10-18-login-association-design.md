# Login association and password lookup

Date: 2026-10-18
Status: **implemented and verified on the live table on 2026-10-18** (`lib/login-association.ts`, `app/api/v1/lookup/associate`, `app/api/v1/lookup/password`; tests `__tests__/login-association*.test.ts`, `__tests__/v1-lookup-*-route.test.ts`, live check `LA_LIVE=1`). The repository is public: this file holds method and numbers only, never a login, a password or a file name.

## What was asked

The owner asked whether the app could turn a username into an e-mail address, a password into the e-mail addresses that use it, "or anything else". Before this, nothing in the app or its API did: `GET /api/v1/search/credentials?q=login:NAME` finds the same handle only, and `GET /api/related` (`by_password`) needs an e-mail or a domain and returns 25 rows through a session.

## Why it can only be inferred

`ulp.credentials.email` is the login as typed; `login_type` says e-mail, username, phone or empty. A ULP line carries one login, one password and one URL, so no row pairs a username with an address, and `source_file` is a 3-38M-row dump that does not group one victim's rows. The only link between two logins that the data holds is a shared secret: the password the account uses. A handle is weak evidence (a generic one belongs to many people: one appeared on 248 sites in the first run), so the first cut, which scored handles, called 46 of 57 "high" results on handles that belong to many people. The account's password on the site the login is known from identifies the person.

## The endpoints

`POST /api/v1/lookup/associate` takes `{ login, site?, password?, want? }` or `{ items: [...] }` (up to 10). `want` is `email` (default), `username` or `phone`, so the same call answers "which handle goes with this address". It returns, per login, `anchored`, `too_common`, `login_sites`, the ranked `candidates` (`login`, `confidence`, `evidence`), `candidates_total` and `errors` (a step that failed, by kind: `reuse: timed out`).

`POST /api/v1/lookup/password` takes `{ password, type?, limit?, domain? }` and returns the logins that use that exact password (case-sensitive), one row per login with its site count and up to 5 sites. `type` is `email` (default), `username`, `phone` or `any`. A POST body so the password stays out of URLs and access logs; it is never logged or returned, and error texts (which can quote a query) are reduced to a kind.

Both use the v1 API keys (roles admin and analyst), the key's rate limit and the request log (endpoint name only).

## Signals and confidence

| | Signal | Applies to |
|---|---|---|
| S1 | a login of the wanted kind on the SAME site with the SAME password as the login | any |
| S2 | a login of the wanted kind on ANY site with that password (8+ characters; ignored when 300+ logins share it); fewer sharers is stronger | any |
| S3 | an address whose local part equals the handle; strong only if it also uses one of the account's passwords | e-mail answers to a handle |
| S4 | the login signs in at a mail provider (`accounts.google.com`, `login.live.com`, ...), which implies `<handle>@<provider>` | e-mail answers to a handle |

The account's passwords are the login's stored password on the given `site`, found by its own query so a cap cannot hide it, plus the `password` the caller supplied; without a site, the login's passwords on every site (probed, but they may belong to someone else with the same handle). Confidence: **high** when the password is shared on the account's site by at most 2 logins, or on any site by at most 2 for a pinned account, or the handle address also uses an account password, or (a handle seen on at most 5 sites) the handle address plus a provider sign-in; **medium** at 3-4 sharers on the site, at most 10 anywhere, or one weak signal on a distinctive handle; otherwise **low**. These are the rules the first run was validated with (32 high, 28 medium, 53 low, 9 none on 122 handles; random pairings share four or more letters 0.3% of the time against 41-54% for high and medium). Heuristics, not proof.

## Limits and what they cost

One login costs a few queries, each capped at 30 s and read-only: its own rows (500 groups), the anchor (50), up to 12 (site, password) pairs, up to 6 passwords for reuse, the handle address and its tie to a password. Measured on 1.87B rows on 2026-10-18: a rare handle or an exact pair answers in 0.5-2.5 s; `admin` 0.5 s, `test` 2 s, `___` 5 s, `john` 14 s, a single letter 33 s (all `too_common`). The queries that read a login's own rows stop at their group cap (`max_rows_to_group_by` with `group_by_overflow_mode = 'break'`), which turned a 30 s timeout on a common four-letter handle into a fast "too common"; a login with no word to prune by never runs the handle query (it would read the whole table); every login has a 40 s budget and says so when it stops early. Requests run three logins at a time. A password lookup reads at most 100,000 matching rows (`partial` says it did) and is pruned by the bloom filter on `password`: a rare password about a second (cold cache a few seconds), a very common one can still time out (a 408 asks for a `domain`).

## Verification

Unit tests with a fake runner cover the rules, the limits, the failure reporting and the validation; route tests cover keys, validation, shape, concurrency and that no password ever appears in a response. `LA_LIVE=1 npx vitest run __tests__/login-association.live.test.ts` finds twelve (site, password) groups that hold exactly one username and one address and checks that the password lookup returns both, that the username's association lists the address and the reverse, with no failed step and no query over 30 s (12 of 12 on 2026-10-18, all "high", slowest call 2.4 s). The live run is what found the common-handle timeout above.
