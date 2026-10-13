# Login-only search scope — Design

Date: 2026-10-13
Status: **implemented on 2026-10-13** (plan `docs/superpowers/plans/2026-10-13-login-search-scope.md`). The owner chose the behaviour in chat on 2026-10-13 (two login choices; "anywhere in the login" for the slower one) and approved the design, including the e-mail casing probe. The repository is public: this file holds numbers only, never real addresses, file names or search terms.

## Why

The owner's searches that matter are one domain, one keyword, and an e-mail or username lookup (parser v6 spec, "Owner's decisions"). On 2026-10-12 they approved a login-only scope: a `login:` prefix and a small "search in" dropdown on the credentials page. Today a plain word is looked up in the url, the login and the password and in two host columns, so a username lookup reads about 95 GiB.

## Measurements (2026-10-13, 1.84B rows, cold, query cache and condition cache off)

One very common given name as the term; counts only.

| What the query does | Rows | Time |
|---|---|---|
| Today: the word in url, login, password and the host columns | 773,704 | 30.2 s |
| Login, whole word: `hasToken(email, w)` (text index) | 390,727 | 0.20 s |
| Login, starts with: `email LIKE 'w%'` | 2,175,372 | 10.0 s |
| Login, anywhere: `positionCaseInsensitive(email, w) > 0` | 3,772,873 | 25.4 s |
| Exact address today: `email = lower(a)` (bloom filter) | 445 | 2.0 s |
| Dotted name, two words plus the phrase check | 1,114 | 2.8 s |

`hasToken` accepts hyphen and underscore needles on the table without error (both returned the same 1,989 rows for a test pair), and `hasAllTokens` exists on ClickHouse 26.3.17. The route runs its queries with `max_execution_time = 300`, so a 25 s scan is inside the budget.

## What the owner sees

* A native `<select>` "Search in", styled like the sort and page-size selects, between the search box and the Domain box. Choices: **All fields** (default, today's behaviour), **Login (whole word)** and **Login (contains)**.
* The placeholder follows the choice ("Search URL / email / password…", "Search login (whole word)…", "Search login (contains)…"). The select has a title that explains `login:`.
* In the box, `login:name` always means a whole word, whatever the dropdown says; `-login:name` excludes. Terms stay comma-separated and are ANDed, as they are now. Plain terms follow the dropdown.
* The choice lives in component state like the other filters; Clear resets it to All fields. CSV export sends the same choice, so the file holds what the table showed.

## Matching rules

The term types stay as `parseULPQuery` classifies them today. What changes is the SQL for a term whose scope is a login choice.

| Term | All fields | Login (whole word), and every `login:` term | Login (contains) |
|---|---|---|---|
| A word (`[\w-]+`) | unchanged | `hasToken(email, w)`, `w` lowercased (the text index folds case) | `positionCaseInsensitive(email, w) > 0` |
| Dotted or other special value (`john.smith`, `a+b`) | unchanged (domain match or LIKE) | one `hasToken(email, word)` per word of the value, AND `positionCaseInsensitive(email, value) > 0`; a value without any word uses only the second part | `positionCaseInsensitive(email, value) > 0` |
| Full address `name@host` | casing probe (below) | same as All fields | `positionCaseInsensitive(email, value) > 0` (complete, any case) |
| `@host` | unchanged (`email_domain` OR `domain`) | `email_domain = host` only (no site clause) | same as whole word |

* A "word" of a value is a maximal run of ASCII letters and digits and of non-ASCII characters, the way the index's `splitByNonAlpha` tokenizer cuts a login.
* A `-` in front negates the whole term, as now. A term that is empty after `login:` is dropped, like an empty term.
* A search for the literal text `login:…` used to match as a LIKE fallback and now means the scope. This is rare and is stated in the README.
* Regex mode: with a login choice (or a `login:` term) the pattern is matched with `match(email, p)` only; with All fields it is unchanged.
* `positionCaseInsensitive` folds ASCII case only. A non-ASCII letter matches case-sensitively. Logins are overwhelmingly ASCII; the README says so.
* Index neutrality (`isIndexNeutralSearch`, which decides whether the imported-range planner may use the projection key): a whole-word term is **not** neutral, because `hasToken` behaves differently on a projection part; the projection form writes `hasToken(lower(email), w)` through the existing `caseInsensitiveTokens` option. A contains term, an address and a `@host` term are neutral.

## The e-mail casing probe (included; the owner can strike this section)

> **Superseded 2026-10-13 (later the same day):** an index on lower(email) makes the exact match complete and just as fast, so the probe was removed; see docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md.

Finding: 54,493,387 of 1,013,574,274 e-mail-shaped logins (5.4%) are stored with uppercase letters, because logins are kept as typed, while the exact-address lookup compares with `lower(value)`. On three real mixed-case addresses it found 117 of 138 rows, 1 of 2 and 163 of 209.

A complete case-insensitive exact match through the text index costs about 11 s for a common local part (`maria@`, `info@`, `admin@`: 10.9 to 11.9 s against 0.4 to 1.3 s today), which breaks the "e-mail lookups must be fast" rule. So the probe tries the common casings through the same bloom filter instead:

* the value as typed lowercased; ALL UPPER; First letter only upper; Title Case local part with a lowercase domain; UPPER local part with a lowercase domain; lowercase local part with a Capitalised domain. The variants are built in code, de-duplicated and bound as parameters in `email IN (…)`.
* Coverage over the whole table: the five patterns together cover 35,863,383 of the 54,493,387 mixed-case logins (65.8%); the first three alone (UPPER, First letter only, Title Case local part) cover 62.3%. In four sample lookups a probe of four casings (lowercase, UPPER, First letter only, Title Case) returned 94% to 100% of the rows a complete match returns (for example 514 of 518), at 0.4 to 2.2 s; the six values above are a superset of that probe.
* It does not reach every casing (about 34% of the mixed-case rows use others, for example camel case). "Login (contains)" is the complete, slower route. The fully complete and fast fix is a materialised lowercase login column with a bloom filter, which rewrites the table (tens of GiB, about an hour of mutation time); it is a separate project, not part of this one.

## Components

* `lib/ulp-search.ts`: `export type SearchScope = 'all' | 'login' | 'login_contains'`; `ParsedToken.scope`; `parseULPQuery(raw, defaultScope: SearchScope = 'all')` strips a `login:` prefix (case-insensitive, after the optional `-`) and sets the scope; `buildULPWhere` and `buildULPWhereRegex` honour it; `isIndexNeutralSearch` follows the rules above; a small exported helper builds the casing variants.
* `lib/search-dictionary-plan.ts`: the domain dictionary is used only when the single term has scope `all`.
* `app/api/credentials/route.ts`: reads `scope` (`all`, `login`, `login_contains`; absent means `all`; anything else is a 400 `{ success: false, error }`), passes it to `parseULPQuery`. The totals request and the rows request both carry it (`totalsParams` in `lib/credential-totals.ts` copies every parameter, so it needs no change).
* `app/api/export/route.ts`: reads `scope` from the JSON body with the same validation, for the CSV path and the spray list.
* `app/credentials/page.tsx`: `scope` state, the select, `buildParams`, the export body, Clear, the placeholder.
* `/api/search` and `/api/v1/search/credentials`: no code change; `login:` works in `q` because the parser handles it, they take no `scope` parameter (the owner uses the web page and the CSV export, not the API).
* `README.md`: the Search section documents the scope, `login:`, the speeds and the ASCII note, and fixes a sentence that is wrong today (it says terms combine with AND `+` and OR `,`; the parser has no `+`, and comma-separated terms are ANDed).

No schema change, no migration, no new index.

## Speed and safeguards

| Query | Expected (cold) |
|---|---|
| Login, whole word | about 0.2 s |
| Dotted name | about 3 s |
| Address with the casing probe | 0.4 to 2.2 s |
| Login, contains | about 25 s for the full scan; the page shows rows before the total, as it does now. Whether the "Newest first" windows answer a common term sooner is measured in the live parity run, not assumed |

Every value is bound as a ClickHouse parameter; nothing is spliced into the SQL. `scope` is an allow-list. The existing `max_execution_time = 300` and memory settings apply unchanged.

## Testing and verification

* `__tests__/ulp-search.test.ts`: every term type in every scope, negation, the `login:` prefix in each dropdown state, an empty prefix, regex mode, index neutrality, and the casing variants (exact lists for a few inputs).
* Route tests: `credentials-route*.test.ts` (scope validation, the clause shape per scope, the dictionary plan not used for a login scope) and `export-route*.test.ts` (scope in the body, spray list).
* Page source tests in the existing style (`imported-range-credentials-page.test.ts`): the select, its three options, the parameter and the export body.
* A read-only live parity script before the deploy, over a handful of terms: the whole-word count equals a brute-force reference, the contains count equals `positionCaseInsensitive` over the column, the "Newest first" page equals the plain page for the same search, and the casing probe returns a superset of today's rows in which every extra row is equal to the address ignoring case.
* The whole gate: `tsc`, `eslint`, `vitest`, `next build`.

## Rollout

One image, deployed to the local stack. The running image is tagged as the rollback first. The app restarts for about 30 s; the data and the search dictionary are untouched.

## Not included

Password and URL scopes, wildcards and a starts-with mode, a remembered choice, a `scope` parameter on API v1, an n-gram index on the login (the text index on `email` with n-grams would add tens of GiB), and the lowercase-login column.

## Risks

* A contains search is a full scan of the login column, about 25 s cold; it is the owner's explicit choice and the whole-word choice stays one click away.
* The `login:` prefix changes the meaning of a literal search for that text.
* Case folding is ASCII only.
