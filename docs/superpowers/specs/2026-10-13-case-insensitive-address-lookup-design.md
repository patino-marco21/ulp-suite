# Case-insensitive exact-address lookup — Design

Date: 2026-10-13
Status: design, written for the owner's review. Nothing in this document is built. The repository is public: this file holds numbers only, never search terms or addresses.

## Why

Logins are stored as typed. 54,493,387 of 1,013,574,274 e-mail-shaped logins (5.4%) have an uppercase letter (measured 2026-10-13, see the login-scope spec). Every exact-address lookup compares with the lowercased value (`email = lower(value)`), so it cannot see those rows: three real addresses returned 117 of 138, 1 of 2 and 163 of 209 stored rows. The affected paths are the search box (a full address), `/api/check`, `/api/v1/lookup`, both batch lookups and the "same login" bucket of the related panel. The login-scope release added a probe of six common casings to the search box; it covers 65.8% of the mixed-case rows and nothing else was changed.

The complete fix is cheap. An index on the expression `lower(email)` makes `lower(email) = lower(address)` as fast as today's exact match, finds every casing, and needs no new column. This corrects the earlier estimate (a materialized lowercase column, tens of GiB, about an hour); see `docs/superpowers/specs/2026-10-13-login-search-scope-design.md`, "The e-mail casing probe".

## Measurements (2026-10-13)

On a throwaway MergeTree table of 36,693,958 `email` values taken from the live table (dropped afterwards):

| What | Result |
|---|---|
| `bloom_filter` on `email` | 27.9 MiB |
| `bloom_filter` on `lower(email)` | 27.9 MiB (same size; the live `idx_bf_email`, `bloom_filter(0.05)`, is 1.20 GiB for 1.84B rows) |
| `MATERIALIZE INDEX` | 2.2 s for 36.7M rows, so about 2 minutes for the table if it scales; the mutation rewrites index files only |
| `email = <lowercased stored address>` for an address stored with capitals | 0 rows |
| `lower(email) = <same address>` | 1 row, 0.013 s, 91 of 4,480 granules read (2.0%, with ClickHouse's default false-positive rate of 0.025; the live indexes use 0.05, so expect about 5%) |

## Measured while building (2026-10-13, after the owner approved the design)

The first measurement used a scratch table with only the new index. The table the app queries also has the primary key `(domain, email, imported_at)`, a text index on `email`, 18 other skip indexes, 64k-row granules and three projections, so the design was tested again on a scratch copy with all of them (MergeTree instead of Replicated; 46M rows = a 1/40 sample of the live rows, 732 granules, merges settled; dropped afterwards). Counts and times only:

| Address | old: `email = lower(a)` | new, default settings | new, `optimize_use_projections = 0` | scan, no skip indexes |
|---|---|---|---|---|
| stored only with capitals, 1 row | 0 rows, 0.009 s | 1 row, 0.407 s | 1 row, 0.024 s | 0.438 s |
| 2,431 rows | 2,431, 0.184 s | 2,431, 0.407 s | 2,431, 0.250 s | 0.379 s |
| the most frequent address, 32,028 rows | **0 rows**, 0.015 s | 32,028, 0.404 s | 32,028, 0.054 s | 0.404 s |
| absent | 0, 0.009 s | 0, 0.420 s | 0, 0.026 s | 0.376 s |
| three addresses with `IN (...)` | 2,431, 0.238 s | 2,432, 0.434 s | 2,432, 0.280 s | |

* The old lookup is fast because the primary key and the text index on `email` do most of the pruning (EXPLAIN for a rare address: 732, 642, then 1 granule). The new predicate can use neither, so the bloom filter alone does the work (27 of 732 granules for an absent address, 3.7%, close to the filter's 5% false-positive rate), and with projections off it is as fast. The new counts equal the full scan in every row. The most frequent address shows the recall gap at its worst: the old lookup found none of its 32,028 stored rows.
* **With projections enabled the new form is about 17 times slower** (0.42 s against 0.024 s; about 16 s against 1 s at 1.84B rows). Given a projection to choose from, the planner reads the whole projection (it counts marks and does not credit the skip index's pruning) and never uses `idx_bf_email_lc`. So every query that compares `lower(email)` must run with `optimize_use_projections = 0` (below, "Projections").
* `MATERIALIZE INDEX` on the settled copy took 2.7 s and added 47 MiB (the new part directories hardlink every file they do not change). It took about 2 minutes while 53 small parts were still merging, because a mutation waits for the merges that involve its parts. `SYSTEM STOP MERGES` stops mutations too (a mutation started with merges stopped never finishes), so merges are never stopped around a materialize.

## What the owner sees

* An address typed in any case finds every stored casing of it, in the search box (all fields and both login scopes), on the Check endpoint, in the API lookups (single and batch) and in the related panel. Each stored row is shown as stored, so a lookup can return `John@Gmail.com` and `john@gmail.com` rows side by side. Counts for such addresses rise by the share of rows that were invisible before (about 5% overall).
* Speed does not change: the exact match was 0.4 to 2.2 s and stays there.
* The six-casing probe is gone; "Login (contains)" is no longer needed to find an address in another casing.

## Design

**The index.** `idx_bf_email_lc`, `ADD INDEX IF NOT EXISTS idx_bf_email_lc lower(email) TYPE bloom_filter(0.05) GRANULARITY 1`, the same type and parameters as `idx_bf_email`. The expression text lives in one constant (`lib/address-lookup.ts`) used by the DDL and by every query, because a skip index is used only when the query contains the identical expression.

* DDL v29 in `lib/clickhouse-migrations.ts` adds it (metadata only; new parts carry it from then on). If the ALTER fails, the recorded version stays at 28 and the next start retries, as v28 does, because the new queries depend on the index.
* It is also added to `SEARCH_INDEX_DEFINITIONS` (`lib/search-index-definitions.ts`), so a content-dedup rewrite clone built from that list carries it. The v17 block that applies the list is skipped on any install already past v17 (the live one), so nothing is dropped or rebuilt.
* Existing parts get it with `MATERIALIZE INDEX`, which is NOT fired from app start (the rule of v23: start-up must not be coupled to a mutation). `scripts/materialize-address-index.sh` does it, supervised, one partition at a time with `mutations_sync = 2`: it adds the index, refuses to start under 130 GiB free, kills the mutation and stops if free space falls under 120 GiB, prints seconds and free space per partition, and ends with an EXPLAIN check that an impossible address selects at most 10% of the granules (about 5% is the index's own false-positive rate). It runs BEFORE the image that depends on the index is deployed, so there is no window in which lookups scan.

**The queries.** The value is compared as `lower(email) = lower({p:String})`; ClickHouse's `lower` folds ASCII only and is applied to both sides, so the comparison is exactly "equal ignoring ASCII case", which is what the index stores.

* `buildULPWhere` (`lib/ulp-search.ts`): an `email_full` term becomes `(lower(email) = lower({exactemailN:String}))` in every scope; `emailCasings`, the extra parameters and their tests are deleted. Negation (`-address`) keeps working through the existing `NOT` wrapper. The Newest-first projection query reuses the same clause.
* `/api/check` and `/api/v1/lookup`: `WHERE lower(email) = lower({email:String})`.
* `/api/lookup/batch` and `/api/v1/lookup/batch`: `lower(email) IN (lower({email0:String}), ...)`, `ORDER BY lower(email) ASC, imported_at DESC`, `LIMIT {cap} BY lower(email)` (the per-address cap now holds across casings), and the result for each queried address is the rows whose lowercased login equals it.
* Related panel (`lib/related-queries.ts`): "same login" is `lower(email) = lower({email})`; the "same domain" and "same password" buckets exclude the same login the same way (`lower(email) != lower({email})`), so one account never appears as its own "other".

**Projections.** `lib/address-lookup.ts` exports `ADDRESS_LOOKUP_SETTING = 'optimize_use_projections = 0'`, and every query that compares `lower(email)` carries it: always in the four lookup routes and the related panel (their queries are address queries by construction); in the search routes only when the search has an address term (`usesAddressIndex(tokens)` in `lib/ulp-search.ts`: an `email_full` term outside Login (contains)), so searches for words and domains keep today's settings: the Credentials route (its totals query also when an imported range is set, and both row templates), the legacy `/api/search`, `/api/v1/search/credentials` and the row export. Not touched: the Newest-first window queries (they read `proj_imported_desc` by design and hand off to the plain query, which carries the setting), the dictionary plan (domain terms only) and the e-mail, domain, mask and spray list exports.

**Where the data stands.** Nothing is rewritten: stored logins keep their casing, the index and the queries are the only changes. A rollback is the previous image; the extra index is harmless to it.

## Rollout

1. Build and test on a branch; the whole gate (tsc, eslint, vitest) green.
2. Isolated-stack rehearsal of the UPGRADE path: the previous image with seeded mixed-case rows, then the candidate image (log shows `DDL v29 applied`), then the script, then the lookups over HTTP find the mixed-case rows and EXPLAIN shows the index used.
3. Merge to main, tag the running image as the rollback, build the candidate with `git archive`.
4. Live: `scripts/materialize-address-index.sh` supervised (about 2 minutes expected, +1.2 GiB), then deploy `app` only, then the read-only live parity test.

## Tests

* Unit: the builder clause and parameters for every scope, with and without negation; the routes' SQL text and result mapping (case-insensitive hits, per-address cap across casings); the related buckets; the DDL version record (27 / 28 / 29); the definitions list contains `idx_bf_email_lc` and its expression equals the shared constant; a guard test that no query still compares `email = lower(`.
* Live, read-only (`__tests__/login-scope-parity.live.test.ts`, tightened): for addresses stored with capitals the lookup count equals a reference computed with the index switched off (`use_skip_indexes = 0`), no longer "between the lowercase lookup and the complete answer"; EXPLAIN selects at most 10% of the granules; each lookup stays under 3 s.
* Rehearsal script `scripts/e2e-address-index.ts` for step 2 above.

## Risks

* A skip index built on an expression is ignored when the query's expression differs in any way, and it is bypassed when the planner reads a projection instead. Mitigations: one shared constant for the expression and one for the setting, the guard tests, route tests that assert the setting, the EXPLAIN check (run with projections off) in the script and in the live test, and a timing bound (under 3 s) in the live test.
* The mutation could rewrite more than index files. It is run one partition at a time with a free-space watchdog, starting with the smaller partition, and the disk figures are printed.
* Installs without the materialized index still answer correctly, only by scanning (13 to 30 s; `/api/check`, which stops at 30 s, can time out). The README names the one command that fixes it.
* Behaviour change for API clients: a lookup can now return several casings of the same address. The API docs say so.

## Not doing

* Unicode case folding (`lowerUTF8`): addresses are ASCII in practice and the index would need a second expression.
* A lowercase column, or rewriting stored logins to lowercase (destructive; the display keeps the typed form).
* A runtime readiness gate with a fallback to the old probe: the rollout order guarantees the index before the code that needs it, and a fallback would keep the six-casing code alive.
* Case-insensitive URL or password lookups.
