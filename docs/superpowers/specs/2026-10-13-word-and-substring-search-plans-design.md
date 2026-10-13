# Faster word and substring searches — Design

Date: 2026-10-13
Status: design, written for the owner's review. Nothing in this document is built. The repository is public: this file holds numbers only, never search terms or addresses (needles are numbered, words are generic).

## Why

Two search shapes are still slow, and the 14 days of `system.query_log` show the owner running both:

* **One word, all fields** (`maria`, a handle, a brand). The legacy predicate is `hasToken(url) OR hasToken(email) OR hasToken(password) OR url_host LIKE '%w%' OR email_domain LIKE '%w%'`. A skip index prunes one column at a time, so an OR across columns reads the whole table. The page's two requests took 25 to 34 s each for a word with no match (12.7 s for the same predicate alone on a warm cache), and up to 150 s while an import was running.
* **A substring** (`url LIKE '%x%' OR email LIKE '%x%' OR password LIKE '%x%'`, what any term with a dot, slash or colon becomes). 13 distinct needles in 14 days; each reads about 95 GiB and takes 35 to 42 s warm, 72 to 82 s as logged.

The domain search already escaped this with the dictionary plan (`docs/superpowers/specs/2026-10-03-domain-search-dictionary-design.md`, `lib/search-dictionary-plan.ts`): keep the legacy predicate verbatim, AND a prunable conjunct onto disjoint branches, merge. This design applies the same idea to words and substrings, and adds the one thing that plan lacks for these shapes: a cheap gate and a time budget, because a plan that is right for a rare term is slower than today's query for a common one (measured below; a plain per-column rewrite of the word search was 98 s against 19.6 s for a word with 774k matches).

## What the owner sees

Same rows, same order, same cursors, same totals (verified identical on every term below). Faster when the term is rare, unchanged otherwise. No new control. The response's `plan` field says which plan answered (`words`, `substring`, as it already says `dictionary` or `windows`). `SEARCH_TOKEN_PLANS=off` in `.env` turns both off.

## Measurements (2026-10-13, 1.84B rows, query cache off, pages and totals compared exactly with today's queries)

**Substring needles** (the owner's 13 distinct needles; the plan ANDs the most selective whole token of the needle as a text-index predicate onto the legacy WHERE):

| Needle | Hits of its best whole token | Rows page | Totals | Today |
|---|---|---|---|---|
| 1, 2, 3 | 1,158 | 0.50 to 0.54 s | 0.44 to 0.49 s | 41.2 s / 34.6 s (needle 1; identical page and totals) |
| 4 | 126 | 0.38 s | 0.39 s | |
| 13 | 3,617 | 0.83 s | 0.71 s | |
| 6, 7 | 21,643 | 2.5 to 2.7 s | 2.3 s | 41.8 s / 34.7 s (needle 6; identical) |
| 12 | 39,772 | 10.7 s | 10.0 s | |
| 9 | 96,045 | 19.0 s | 18.8 s | |
| 10 | 21,284,683 | not run | | |
| 5, 8, 11 | 1,506,141,764 (the only whole token is in 82% of rows) | not run | | |

The cost follows how many granules hold a hit, not the hit count itself, so beyond about 50,000 hits the gain shrinks to 2x and then to nothing. Eight of the 13 needles pass a 50,000-hit gate (five under a second, two near 2.5 s, one 11 s); five keep today's query.

**Single words** (the plan has three disjoint branches: T = the three text-index leaves alone; H = legacy predicate AND `domain IN D` AND NOT the text leaves; E = legacy predicate AND `domain NOT IN D` AND NOT the text leaves AND the rows of the e-mail-domain candidates, found through `proj_email_domain_rev`; D and E come from the dictionaries):

| Word | Matches | Domains in D / E | Totals today to plan | Rows page today to plan |
|---|---|---|---|---|
| none in the data | 0 | 0 / 0 | 12.97 s to 0.35 s | 17.2 s to 0.10 s |
| a brand with few hosts | 2,068 | 122 / 27 | 13.26 s to 1.17 s | 9.65 s to 1.99 s |
| a brand | 18,409 | 1,649 / 212 | 14.29 s to 7.32 s | 10.19 s to 11.22 s |
| a larger brand | 174,481 | 1,747 / 236 | 17.03 s to 8.71 s | 14.80 s to 19.71 s |

Totals win every time; rows win when the term is rare and lose when matches are plentiful, because today's rows query stops reading as soon as it has 200 rows, while the host and e-mail-domain branches must each find their own 200 inside whole domains. Of 14 common words tested, 11 exceed the dictionary plan's existing cap of 3,000 candidate domains and never use the plan.

Two traps found while measuring, both pinned by tests below: `optimize_use_projections = 0` on a query that contains the e-mail-domain offset sub-select makes that branch about 15 times slower (8.1 s against 0.5 s; the existing plan's header says so, and it is the settings of the OUTER query that matter, not the branch's own), and a candidate list that drops the empty `domain` loses the blank-domain rows.

## Design

**Rule for both plans.** A plan only ADDS to today's query: every branch keeps the route's WHERE, filters, cursor, ordering, de-duplication and limit; the result must equal today's. Any plan that errors, runs over its budget, is not eligible, or whose gate says no, falls back to today's query for that request. The rows request and the totals request decide independently (the page sends both). Gates and budgets are constants in one module, documented with the measurements above.

**B. Substring plan** (`lib/search-substring-plan.ts`).
* Eligible: the search is exactly one positive, non-regex term of type `like` in scope All fields.
* Whole token: a maximal run of ASCII letters and digits inside the needle that has a character on both sides in the needle, both ASCII non-alphanumeric and neither a LIKE metacharacter (`%`, `_`, `\`). Such a run is a whole token of any haystack that contains the needle, so `hasToken(col, lower(run))` is a NECESSARY condition of the legacy predicate (the text index lowercases, LIKE here is case-sensitive: the condition can only be wider). Non-ASCII neighbours are token characters for `splitByNonAlpha` and disqualify a run.
* Choice: one `count()` per whole token through the text indexes (0.3 s each, in parallel, cached ten minutes per token), take the smallest. Gate: smallest hit count at most 50,000. No whole token, or none under the gate: today's query.
* SQL: the legacy WHERE with `AND (hasToken(url, t) OR hasToken(email, t) OR hasToken(password, t))` appended. One query for the rows, one for the totals. Runs with `optimize_use_projections = 0`, like the legacy no-range search. Budget 15 s (today's query takes 35 s or more), then today's query.

**A. Word plan** (extends `lib/search-dictionary-plan.ts`; same candidate lookups, caps, freshness guard and offset sub-select as the domain plan).
* Eligible: exactly one positive, non-regex term of type `token` in scope All fields, dictionary fresh, caps respected (3,000 domains, the e-mail cap, the literal size limits), `proj_email_domain_rev` ready.
* Candidates: D from `url_host LIKE %w%` (the pattern comes out of `buildULPWhere`'s own parameters), E from `email_domain LIKE %w%`; the empty domain stays in D when it is there.
* Branches and merge exactly as in the table above. Branch T replaces the search predicate inside `where` with the three text-index leaves, using the same substitution the route already does for the Newest-first windows (`whereProjection`), and is built by the same function that builds the legacy leaves so the two cannot drift. Totals combine aggregate states (`dedupeCountPartial`) as the domain plan does. The outer query must not carry `optimize_use_projections = 0`.
* Totals: used whenever eligible, budget 12 s (the slowest measured plan took 8.7 s, today's query 13 to 17 s), then today's query. Rows: used only when D has at most 300 domains, E at most 100, and the text leaves have at most 20,000 hits (one more 0.3 s count, cached); budget 4 s, then today's query. These thresholds are starting values between the measured wins and losses; the plan stage re-measures about 15 more words and fixes them so that no tested word is more than 1.2 times slower than today.

**What does not change.** No DDL, no index, no data. The dictionary tables, the text indexes and the projection already exist. Multi-term searches, negation, regex, the login scopes (already 0.2 s), addresses (own index), domains (own plan) and the list exports keep their paths.

## Components

`lib/search-plan-gate.ts` (the kill switch, the budgets and thresholds, a small TTL cache of probe counts, `runWithBudget(run, budgetSeconds)` that turns a budget timeout into "use today's query"); `lib/search-substring-plan.ts` (needle parsing, token choice, the two SQL builders); `lib/search-dictionary-plan.ts` (word terms: eligibility, candidates for words, branches T, H, E, the rows gate); `lib/ulp-search.ts` (export the word-leaves builder so T and the legacy clause share it); `app/api/credentials/route.ts` (plan selection and fallback for rows and totals, next to the dictionary plan); README and the `plan` documentation.

## Rollout

Build B first (larger gain, one query, no dictionaries), then A, as two plans of one spec. Each: tests, the whole gate, the live parity script on the real table, the isolated-stack rehearsal for A (it needs the dictionaries), deploy `app` only with the rollback tag set first. No materialize step.

## Tests

* Unit: the whole-token rule (dots, slashes, hyphens, `%`, `_`, `\`, non-ASCII neighbours, a needle that is one run, uppercase); the SQL builders; the gates and the budget fallback (a mocked slow plan returns today's rows); route tests for plan choice and for the unchanged paths (multi-term, negation, regex, scopes).
* Live parity (read-only, terms in the environment, never in the repository): for each term the plan's page and totals equal today's, and the plan is not slower than 1.2 times today's. The needles and words come from `LSP_`-style environment variables.
* Rehearsal for A on the isolated stack: seed words with hosts under a shared domain, blank-domain rows, a non-ASCII e-mail domain and mixed-case text; plan equals legacy on every page.

## Risks

* A plan slower than today's for a term in the middle band: the gates, the budgets and the live parity bound.
* A token that is not actually necessary would silently drop rows: the rule above is conservative on purpose, tested on adversarial needles, and the live parity test compares exact counts.
* A stale dictionary making the candidate set too small: the existing freshness guard applies unchanged.
* The extra probe queries (0.3 s each) on every first use of a term: cached, and parallel with the dictionary lookups.

## Not doing

* A race between the plan and today's query (double load on a laptop, contention made both slower in the measurements).
* A rewrite of the word search as a union of per-column queries (98 s against 19.6 s for a word with 774k matches).
* A host-level candidate condition (`url_host IN hosts`): measured, no gain, a bloom filter probed with thousands of values passes every granule.
* Raising the 3,000-domain cap or a subquery form of the candidate sets: a possible later step for words in the middle band.
* An n-gram index on url, login or password (tens of GiB), and the e-mail, domain, mask and spray list exports.
