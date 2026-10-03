# Domain search dictionary — design (2026-10-03)

Status: **designed, not built.** Companion: `2026-10-03-hardening-bundle-design.md`. Sub-project 3 of the 2026-10-02 improvement plan ("search
dictionaries"), reshaped by what the live query log showed on 2026-10-03. Everything marked *measured* was run on the live ClickHouse
(1,394,459,025 rows, 26.3.17.4) on an otherwise idle server with `use_query_cache = 0, use_query_condition_cache = 0` (the condition cache
makes a repeat of the same WHERE look about 10x faster, so cold figures only). The scratch tables used (`ulp.zz_pairs`, `ulp.zz_emd`) were
dropped afterwards; the live `ulp.credentials` was only read.

## What is wrong

The owner's real workflow is a domain search on the Credentials page, sorted A to Z (the default). `system.query_log` (the app's HTTP
queries) shows what it costs today:

| When | Search | Rows query | Totals query |
|---|---|---|---|
| 2026-10-03 00:42-00:55Z (3 searches) | a rare domain, "term A" | 17.3, 19.3, 15.8 s | 16.7, 18.1, 14.8 s |
| 2026-10-02 01:30-01:32Z | another rare domain, "term B" | 60-77 s first time, 12-23 s repeats | 45-76 s |

The two requests (`skip_totals=1` for rows, `totals_only=1` for the count, `app/credentials/page.tsx:733`) run at the same time and both scan the
same 26 GiB; alone each takes 8-12 s (*measured*), so the contention roughly doubles the wait. The cause is one sentence: **a domain-shaped
term becomes `domain = x OR domain LIKE '%.x' OR url_host LIKE '%x%' OR email_domain LIKE '%x%'`
(`lib/ulp-search.ts`), and ClickHouse cannot prune any of it once two substring branches sit in the OR.** With `ORDER BY domain` it then reads
every granule alphabetically before the term (507 M of 1.39 B rows for term A), and for a rare term it reads everything.

The exact-site part is nearly free (`domain = '<term A>'`: 0.04 s, primary key). The four branches partition today's result set
exactly (parity *measured* on three terms: 2,894 / 871 / 1,560 raw rows = site + subdomains + email domain + lookalikes), but
`ledger.com` shows why they cannot simply be dropped: 84% of its 1,352 unique results come only from the substring branches (lookalike hosts).

**Decision recorded 2026-10-03 (owner):** results keep **one A-Z list, exactly as today** (same rows, same order, same cursors, same totals).
An alternative that groups site matches first and loads lookalikes later was designed, mocked up and declined.

## Goals

1. A domain search returns the identical rows, order, cursors and totals as today, by construction and proven by a parity test.
2. Cold first page in about 2-3.5 s for the usual rare-to-mid term (was 8-12 s alone, 15-19 s in the app), later pages and repeats in 0.2-2 s, totals in 0.2-1 s (were 8-9 s).
3. Every non-domain sort (email, newest, password length) benefits too: term B's 23 s and 38 s become 0.3 s after the lookup (*measured*).
4. Any problem (stale dictionary, too many candidates, a ClickHouse error, a timeout of the lookup) falls back to today's query: slower, never wrong.
5. No change to the API contract, the UI or the stored data; the new tables are derived and rebuildable.

## Approaches

| | Verdict |
|---|---|
| A. Group results by relevance (site, subdomains, email, lookalikes) | First page 0.04-1.7 s, no new tables. **Declined by the owner** (changes the order). |
| B. Site matches only, lookalikes opt-in | Fastest, but changes what a default search returns. **Declined.** |
| **C. Resolve the substring branches against small dictionaries of distinct values, then run pruned branches and merge** | **Chosen.** Same rows and order by construction; cost is one 2 GiB derived table and a freshness guard. |
| D. A text/n-gram index on the main table's `url_host`, `email_domain`, `domain` | Not built: estimated at tens of GiB and hours to materialize on 1.39 B rows, and the same idea *measured* on the 85 M-row dictionary pruned granules to 10% but ended no faster (index +3.8 GiB, 10 extra minutes). |
| E. Cache the resolved candidates per term, no dictionary | The first search of a new term (the owner's usual case) would still scan 1.39 B rows (5.5-9 s). Kept only as the per-term cache inside C. |

## Design (approach C)

### Principle: add conjuncts, never rewrite the predicate

The route already builds the legacy `where` (the search predicate, every filter, the Declutter noise filter, the tier and login-type extras)
and the keyset `cursorClause`. The planner **leaves them in place and ANDs extra, redundant conjuncts that let ClickHouse prune.** Because the
legacy predicate stays in every query, an over-inclusive candidate set can only cost time; it can never return a wrong row. The only way to
lose rows is a candidate set that is too small, which the dictionary's completeness guard exists to prevent. Two branches cover the whole
predicate P = A or B or C (A: `domain = x`, `domain LIKE '%.x'`; B: `url_host LIKE '%x%'`; C: `email_domain LIKE '%x%'`):

- Let D = every `domain` value for which some row satisfies A or B (from the dictionary), E = every `email_domain` value containing x.
- **Branch 1** = P and `domain IN D`. Primary-key prunable on `domain`. It contains every row that satisfies A or B, plus the C-only rows
  whose domain happens to be in D.
- **Branch 2** = P and `domain NOT IN D` and the row positions of E. Only C can be true outside D, and those rows are found through the
  existing partial projection `proj_email_domain_rev` (`(_part, _part_offset) IN (SELECT _part, _part_offset ... WHERE reverse(email_domain)
  IN E)`, the pattern used by `lib/credentials-projections.ts`). The two branches are disjoint (`domain IN D` against `NOT IN D`).

### Dictionary (two derived tables, `lib/search-dictionary.ts`)

| Table | Content | Measured |
|---|---|---|
| `ulp.search_host_dict (domain String, url_host String)` ORDER BY (domain, url_host) | distinct (domain, url_host) pairs; `url_host` is a function of `url`, `domain` is stored, so pairs are needed (a plain `domain` list loses matches in the path text of scheme-less URLs) | 85,232,652 rows, **1.99 GiB**, build **129 s**, peak memory 3.78 GiB |
| `ulp.search_emaildomain_dict (email_domain String)` ORDER BY email_domain | distinct `email_domain` | 13,203,601 rows, **152 MiB**, build **20 s**, peak memory 1.71 GiB |

Both are plain `MergeTree` (no Keeper path, so a laptop resume that expires the Keeper session cannot make them read-only). They are derived data:
they are dropped and rebuilt freely, and `scripts/clickhouse-backup.sh` excludes them (its default list skips only `credentials_*` and `zz_*`;
the pattern gains `search_`). No n-gram or other index: *measured*, no gain. Compression codecs make no difference either (uncompressed copy:
0.83 s against 0.77 s per scan).

### Lookup (the 1.0-1.5 s floor)

E is matched against the projection's key, `reverse(email_domain)`, and ClickHouse's `reverse` is **bytewise** (`reverse('é.com')` is `moc.\xA9\xC3`, not `moc.é`; verified live,
and 16 non-ASCII email domains turned up in a 5,000-row sample), so E is reversed as UTF-8 bytes and written with `\xHH` escapes, never as a reversed JavaScript string.
D comes from one scan of the pair table, E from one scan of the email table (0.07-0.17 s); both use the *same LIKE parameters the legacy
predicate uses* (`domlk`/`domsuf` escaping of `_`), so the semantics are identical. The scan is bound by reading the 85 M strings (a bare
`sum(length(url_host))` takes as long as the match: 0.75 s), not by matching, so it cannot be tuned much; three single-column scans run in parallel
(`domain = x`, `domain LIKE '%.x'` over the domain column, `url_host LIKE '%x%'`) finish in **1.0 s** against 1.45 s for one query. Results are
cached per `(fingerprint, term)` for 10 minutes, at most 200 terms, **sharing the in-flight promise** so the rows and totals requests the page
sends together resolve once. A repeat or a later page skips the lookup.

### Branch queries and merge

Both branches are the legacy SELECT (same `RAW_COLS`, `where`, `cursorClause`, `orderBy`) with the extra conjuncts, each
`ORDER BY <sort> LIMIT n`, merged by an outer `ORDER BY <sort>` over `UNION ALL`, then the legacy tail (`LIMIT 1 BY content_key_hash` when
Unique is on, `LIMIT limit`, then the outer `NORM_COLS` select). For the in-window Unique form (a sort not led by `domain`) each branch takes the
legacy window `limit * 3`, the union is cut to the window, then deduplicated and limited, which is exactly the legacy window semantics. For the
`domain`-led sorts each branch dedupes inside itself first (`LIMIT 1 BY ... LIMIT limit`); the first `limit` unique rows of the union are inside the
union of the branches' first `limit` unique rows, so the result is the same. The candidate lists are written into the SQL as **escaped
string literals** (`lib/clickhouse-literals.ts`), not passed as `{name:Array(String)}` parameters. *Amended 2026-10-03, measured while planning:* parameters travel in the
URL and ClickHouse refuses one above `http_max_field_value_size` (128 KiB): 3,000 domains of 43 characters failed with "HTML Form Exception: Field value too long", 40,000 with "URI too long".
The SQL travels in the body, where the limit is `max_query_size` (256 KiB, and it cannot be raised from inside the query): three copies of a 3,000-domain list (83 KiB each) fit, six thousand domains do not.
So the caps below also count bytes (see the caps table), and the escaping is pinned by tests and by a live round trip of 25 awkward strings (quotes, backslashes, `'; DROP TABLE`, NUL, RTL override, 4,000 characters), all returned byte for byte.

Two ClickHouse 26.3 facts found by testing, both pinned in the code comments and the tests:

- With a `_part_offset` filter, **lazy materialization breaks** ("Not found column _part_offset in block", reproduced for every sort not led by
  `domain` when more columns than the sort keys are selected). `query_plan_optimize_lazy_materialization = 0` on the offset branch fixes it
  (also `optimize_move_to_prewhere = 0`; the legacy analyzer too). A future ClickHouse may change this, which is why any plan error falls back.
- **`optimize_use_projections = 0` on the offset branch destroys its pruning** (the totals took 9-16 s instead of 0.3-1 s). Projections stay at the
  default there; branch 1 and the totals keep the legacy settings otherwise.

### Totals

One aggregate per branch over the disjoint branches, combined by **merging aggregate states**, not by adding the numbers (*amended 2026-10-03*): `uniq` is an
estimate, and the sum of two estimates is not the estimate of the union. Measured on the live table for a term with 1.23M credentials: the legacy single scan gave
1,234,432 unique, the sum of two disjoint branches 1,234,344, and `uniqIfMerge` over `uniqIfState` of the same two branches **1,234,432, identical**. Counts add exactly.
`lib/ulp-dedupe.ts` gains `dedupeCountPartial` (the state form of `dedupeCountExpr`). *Measured:* raw 2,894 / 871 / 1,560 and unique 1,710 / 870 / 1,352, identical to the legacy
query, in 0.17-1.1 s against 5-9 s.

### Eligibility, caps and fallbacks (every row falls back to the unchanged legacy path)

| Condition | Result |
|---|---|
| `q` is exactly one positive, non-regex, domain-shaped term (`^[\w-]+(\.[\w-]+)+$`); no `dictionary=0` parameter; feature flag on | eligible; anything else (single word, `@email`, several terms, negation, regex, `like` fallback) is untouched |
| Dictionary missing, building, or fingerprint differs from the live table | legacy |
| `proj_email_domain_rev` is not on every part (`isEmailDomainRevProjectionReady`) | legacy |
| \|D\| above `SEARCH_DICT_MAX_DOMAINS` (default 3,000) or \|E\| above `SEARCH_DICT_MAX_EMAIL_DOMAINS` (default 300) | legacy |
| The inlined list of D is above 90,000 bytes or the list of E above 20,000 bytes, or the finished SQL above 240,000 characters (`max_query_size` is 262,144; D appears twice in a query) | legacy |
| The lookup takes longer than 8 s, or the plan raises a non-timeout ClickHouse error | legacy, one `console.warn` with the reason |
| A query timeout inside the plan | the same 408 response the legacy path returns |
| D and E are both empty | an empty page and zero totals without touching the table (today this costs a 9-12 s full scan to find nothing) |

The caps come from the measured cost: branch 1 costs about 1.5 ms per candidate domain range (496 domains 1.0 s, 2,370 domains 3.6 s), so beyond roughly
3,000 domains the plan is no faster than the legacy query (its cost stays 8-12 s), and branch 2's cost follows the number of scattered rows. Popular
terms (`google.com` 158,010 domains, `facebook.com` 143,518, `amazon.com` 33,831) therefore keep the legacy path, where early termination in
domain order already helps. The caps are environment-tunable. `/api/credentials?dictionary=0` forces the legacy path for one request (parity tests and scripts; there is no UI for it), and a response answered by the plan reports `plan: 'dictionary'`.

### Freshness guard (fail closed)

`fingerprint = hash(uuid of ulp.credentials, per partition (rows, min block, max block), every NON-projection mutation id and command)`, one
metadata query over `system.parts` and `system.mutations`. Inserts raise rows and the max block; `ATTACH`/`REPLACE PARTITION` raise the max block;
deletes and content mutations change rows or the mutation list; a table swap changes the uuid; merges change none of them. **Projection and index
mutations are excluded**: `lib/projection-scope-cron.ts` runs `CLEAR PROJECTION` on partition 202607 every day at 05:00Z (verified: mutations on
2026-10-02 and 2026-10-03), and part versions would otherwise invalidate the dictionary daily. *Amended 2026-10-03:* `system.mutations.command` is wrapped in parentheses
(`(CLEAR PROJECTION proj_imported_desc IN PARTITION '202607')`), so the exclusion is `match(command, '^\\(?(CLEAR|MATERIALIZE|DROP|ADD) (PROJECTION|INDEX)')`; an anchored
`^CLEAR PROJECTION` would match nothing. Index mutations are excluded too (they cannot change a dictionary column, and the oldest history entries are `DROP INDEX`, which would
force a spurious rebuild when they age out of the list). Measured on the live table: 18 of the 19 listed mutations are excluded; the one kept is `MATERIALIZE COLUMN country_tier`. A content mutation still running makes the dictionary
stale. The fingerprint is stored in the `COMMENT` of **both** dictionary tables (JSON with build time and counts) so it travels with the table
through the swap; the dictionary is fresh only when both comments equal the live fingerprint. The check is cached **3 s** (*amended 2026-10-03*; the spec said 15 s): a cached
`fresh` is the one answer that must not outlive a change to the data, because for that long a search could use candidates that miss a row with a new domain, and the check
is two metadata queries that cost milliseconds.

### Build and refresh (`lib/search-dictionary.ts`, `lib/search-dictionary-cron.ts`, `scripts/build-search-dictionary.ts`)

- Build into `<name>__new`, then `EXCHANGE TABLES` (the `ulp` database is Atomic) and drop the old one; the first build uses `RENAME TABLE`.
  The fingerprint is read **before** the build and written to the new table's comment: if the data changed during the build the dictionary is
  born stale and the next tick rebuilds it. Queries in flight finish on the old table.
- Settings: `max_threads = 8`, `max_memory_usage` 6 GiB, `max_bytes_before_external_group_by` 3 GiB, `async_insert = 0`, a `log_comment`.
- A tick (`SEARCH_DICT_CRON_MINUTES`, default 10; 0 disables) rebuilds only when the dictionary is stale or missing **and** the fingerprint has been
  unchanged for 2 minutes (not in the middle of an import) **and** no content mutation or import job is running **and** the disk guard
  (`lib/clickhouse-disk-guard.ts`) leaves headroom for the shadow copy (about 2.2 GiB plus the floor). Failures back off (3 in a row wait an hour).
  `scripts/build-search-dictionary.ts` runs the same function by hand for the first build, which is run and verified before anything depends on it.
- Observability: the response's existing `plan` field says `dictionary`; `/api/monitoring/ingest-health` gains `searchDictionary`
  (`fresh | stale | building | missing | disabled`, built time, counts, size, last error) and the panel one line.

## Measured: today against the plan (cold, idle server, first page and totals, `domain_asc`)

Terms A and B are the owner's real searches, so their names are withheld (the repository is public); the live parity test takes terms from `SDP_TERMS`.

| Term | Candidates D / E | Today rows / totals | Plan first page (lookup + rows) / totals | Cold lookup alone |
|---|---|---|---|---|
| term A | 13 / 1 | 11.4 s / 8.7 s | 1.98 s / 0.23 s | 1.53 s |
| term B | 11 / 0 | 8.7 s / 6.5 s | 1.86 s / 0.17 s | 1.53 s |
| trezor.io | 14 / 1 | 7.2 s / 5.1 s | 1.96 s / 0.22 s | 1.53 s |
| kraken.com | 496 / 17 | 9.4 s / 8.5 s | 2.80 s / 1.09 s | 1.56 s |
| ledger.com | 303 / 37 | 7.6 s / 9.2 s | 3.49 s / 0.93 s | 1.53 s |
| blockchain.com | 2,370 / 58 | 7.7 s / 8.5 s | 5.77 s / 2.90 s | 1.58 s |

With the parallel lookup (1.0 s) the first page is about 0.5 s lower. In the app both requests run together, so today's 15-19 s becomes about
2-4 s. Pages 2+ and repeats reuse the cached lookup: 0.17-1.8 s. Other sorts (term B, page 1 / page 2): `email_asc` 22.8 s / 39.4 s
becomes 0.35 s / 0.25 s, `imported_desc` 23.2 s / 37.6 s becomes 0.35 s / 0.27 s.

**Parity (*measured*, ordered, stored keys): 16 pages of 200 rows were identical to today's** (term A, term B and `ledger.com` x
`domain_asc`, `email_asc`, `imported_desc`, pages 1 and 2 by cursor, Unique on), and the totals matched on the three terms.

## Verification plan

1. **Unit** (pure, fake runner; the planner takes `run` as a parameter, like `lib/newest-first.ts`): eligibility matrix; the branch SQL keeps the legacy `where`
   and `cursorClause` verbatim and only adds the conjuncts; both dedupe forms; empty D, empty E, both empty; caps; parameters never inlined; cache sharing of an
   in-flight lookup; each fallback row of the table; fingerprint SQL excludes projection mutations; freshness logic (equal, differs, missing, comment unparsable);
   the build's order of operations (fingerprint first, shadow, swap) and its backoff; source pins for the two ClickHouse settings above.
2. **Live parity** (`__tests__/search-dictionary-parity.live.test.ts`, gated like `newest-first-parity.live.test.ts`): six or more terms (rare, mid, email-heavy,
   no-match, one just under and one over each cap) x four sorts x Unique on and off x a three-page cursor chain: ordered stored keys and both totals equal
   the legacy plan (`dictionary=0`). This is also the tripwire for a ClickHouse upgrade.
3. **Rehearsal** (`scripts/e2e-search-dictionary.ts` on the isolated stack): seed lookalike hosts, subdomains, scheme-less URLs with the term in the path,
   blank-domain legacy rows and email-domain-only matches; build through the real function; assert API parity with and without `dictionary=0`; import a file
   and see the dictionary go stale (legacy answers) and fresh again after the build; drop the tables (fallback); swap under a concurrent query loop; a 3,000-value
   parameter reaches ClickHouse.
4. **Live acceptance**: the supervised first build (about 2.5 min, 2.2 GiB), then the live parity test, which also prints the timings of the table above (it drives the route itself, so
   the legacy SQL it compares against cannot drift from the route's; *amended 2026-10-03*: there is no separate `scripts/benchmark-search.ts`), before the flag is left on.
   Rollback: `SEARCH_DICTIONARY=0` (no rebuild needed), or the rollback image tag.

## Decisions for the owner (defaults in bold)

1. Build and keep a 2.2 GiB derived dictionary, rebuilt automatically after imports: **yes** (it is the cost of keeping one A-Z list).
2. Caps: **3,000 candidate domains and 300 email domains**, above which a term uses today's query.
3. Supervised first build on the live server (8 threads, under 4 GiB, about 2.5 min, reading about 66 GiB): **yes, at a quiet moment**.
4. The Ingest Health line for the dictionary: **yes**.

## Deliberately NOT done

- Single-word terms (`ledger`), `@email`, multi-term, negated and regex searches: the word case also needs `hasToken` branches that read in primary-key order (2-9 s
  *measured* for `ledger` and `binance`), so it is a separate project; `/api/search`, the v1 API and `/api/export` keep their own query paths.
- Grouping results by relevance (declined), progressive loading of lookalikes (declined), n-gram or any index on the main table, incremental dictionary
  maintenance (a full rebuild takes 2.5 minutes and imports are rare; revisit if imports become daily), a materialized view feeding the dictionary
  (it would miss `ATTACH`/`REPLACE PARTITION`; the fingerprint covers every path).
- Raising the lookup floor below 1 s: the scan is bound by reading 85 M strings; the next lever would be a smaller haystack, not a faster scan.
