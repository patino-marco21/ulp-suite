# Related-credentials panel fix and a reversed-key `domain` projection — design

Date: 2026-09-30. Follows `2026-09-30-query-perf-wins-design.md` (its Gate C0 found the `domain`
scan problem and the condition-cache effect). Table at the time: `ulp.credentials`, 1,393,449,551
rows, 185 GiB, `ORDER BY (domain, email, imported_at)`, 8 parts in 2 partitions.

## Problem

Measured on the live table the same day, from `system.query_log` and direct probes:

| Finding | Evidence |
|---|---|
| The Credentials row sheet's **Related** panel never worked at this scale | 78 `/api/related` queries in 3 h, **all 78 hit `max_execution_time = 30` and returned 0 rows**. `timeout_overflow_mode = 'break'` on a query with `ORDER BY` returns nothing, so the panel only looked empty. Each sheet open starts 3 parallel 30 s scans. |
| Cause | `SELECT ${NORM_COLS}` aliases `url/email/password/domain`; the aliases shadow the stored columns in `WHERE`, so neither the primary key nor the bloom filters can prune, and the planner scans `proj_imported_desc` newest-first. |
| The monitor's `domain` candidate scan is slow when cold | 42.7 s / 666M rows / 21,469 of 21,469 marks (17 domains). `idx_ngram_domain` prunes nothing. It is 0.36 s only while ClickHouse's per-granule query condition cache is warm, and any merge or mutation drops that cache. |
| A `domain` projection does **not** help the main search | The Credentials page's domain-token search ORs `domain = x OR domain LIKE '%.x'` with `url_host LIKE '%x%' OR email_domain LIKE '%x%'`; every branch is a cold full-column scan (binance.com: 12.7 s, 11.0 s, 3.6 s, 34.5 s combined). No ordered index helps an infix match. |

## Scope

- **Part 1 — fix `/api/related`.** Done in this change.
- **Part 2 — `proj_domain_rev` for the monitor's `domain` scan.** Mirror of `proj_email_domain_rev`.
- **Part 3 — the main search's substring branches.** NOT designed here. It needs a product decision
  (a distinct-value dictionary, a semantics change such as exact-plus-subdomains by default, or
  accepting it). Distinct values: `domain` 40.6M, `url_host` 80.1M, `email_domain` 13.2M.

## Part 1 — design

`lib/related-queries.ts` holds the three SQL strings; the route imports them (the route file cannot
export extra names under Next 15, and a lib module lets the tests and a live check run the exact text).
Each bucket is an **inner query on raw columns** (`WHERE`, `ORDER BY domain, email`, `LIMIT 25`) wrapped
by an **outer query that applies `NORM_COLS`** and re-sorts the ≤ 25 rows newest-first — the split
`app/api/credentials/route.ts` and `app/api/export/route.ts` already use.

Why `ORDER BY domain, email` and not `imported_at`: the plain split fixes rare values but a login or
password present in nearly every granule (bloom filter prunes nothing) reads the whole table and sorts it.
Measured cold, before choosing:

| Probe | split + `ORDER BY imported_at DESC` | split + `ORDER BY domain, email` (shipped) |
|---|---|---|
| email, rare | 0.90 s | 0.90 s |
| email `admin` | **9.5 s** / 963M rows | 0.86 s / 1.6M rows |
| email `test@test.com` | 3.7 s | 0.89 s |
| domain, small / google.com / facebook.com | 0.94 / 0.88 / 1.2 s | 0.79 / 0.81 / 0.81 s |
| password, rare | 1.4 s | 0.98 s |
| password `123456` | **21.9 s** / 1.39B rows | 1.05 s / 2.3M rows |
| password `password` | **22.6 s** | 1.1 s |

All three popular probes at once, as the route runs them: 1.26 s wall. The primary-key prefix is the
one order the table gives away for free (same reasoning as `MATCH_ORDER_BY` in
`lib/monitor-match-resolver.ts`). **Behaviour change, deliberate:** when more than 25 rows match
(popular logins and passwords), the panel shows the first 25 by (domain, email), not the 25 newest; they
still display newest-first, and a bucket with ≤ 25 matches is complete either way. On a 2-row bucket
(`ellipal.com`) the new output is byte-identical to a reference newest-first query.

Rejected: `prefer_column_name_to_alias = 1` (also fast, but changes `NORM_COLS` output on the legacy
rows, so the panel would disagree with the Credentials table); an unordered `LIMIT 25` (similar speed,
but a different sample on every open).

Kept unchanged: `max_execution_time = 30`, `timeout_overflow_mode = 'break'`, `use_query_cache = 0`
(every probe is 20-30x under the cap). Known residue: if a query ever does reach the cap, `break` plus
`ORDER BY` still returns nothing, silently. Not changed here; a UI that reports it is a separate piece of work.

Tests (`__tests__/related-queries.test.ts`): the inner query has raw columns, the filter, the key-prefix
order and the limit, and contains neither `NORM_COLS` nor an alias reusing a column name; the outer applies
`NORM_COLS` once and the display order; placeholders match what the route binds; the route imports the
three constants and no longer inlines SQL. A mutation check (inner `NORM_COLS`, `ORDER BY imported_at`)
fails 6 of the 27 tests.

Not fixed, same shape, unmeasured: `app/api/v1/lookup/batch` and `app/api/search` also put `NORM_COLS` in
the same SELECT as a `WHERE` on the raw columns. Both are API-key endpoints; there are no API keys and no
API request logs in this deployment.

## Part 2 — design

A partial projection (`SELECT _part_offset ORDER BY reverse(domain)`, ~4.5 bytes/row, estimated 5-8 GiB
because `domain` has 40.6M distinct values against `email_domain`'s 13.2M) and a rewritten predicate:
`reverse(domain) = reverse({eq:String}) OR startsWith(reverse(domain), reverse({suffix:String}))`, which is
byte-for-byte the same match as `domain = x OR endsWith(domain, '.x')` and becomes prefix ranges.

- `lib/credentials-projections.ts`: generalize the email_domain code (name, body, ADD, missing-partitions,
  materialize, readiness, restore) over a small descriptor `{ name, column }`; keep the existing
  `...EmailDomainRev...` exports as thin wrappers so nothing else changes, and add the `domain` ones.
- `lib/domain-match.ts`: one reversed-key builder parameterized by column; `buildEmailDomainRevCandidateWhereClause`
  stays as a wrapper; add `buildDomainRevCandidateWhereClause`.
- `lib/monitor-match-resolver.ts`: the `domain` scan uses the rewritten predicate plus
  `preferred_optimize_projection_name = 'proj_domain_rev'` and **`optimize_distinct_in_order = 0`** only when every
  active part carries the projection (`isDomainRevProjectionReady`, fails closed); otherwise today's query with
  `optimize_use_projections = 0`. The `email_domain` decision is unchanged. Both readiness checks are metadata-only.
  The extra setting is needed because `domain` leads the primary key: with it on, the planner answers
  `SELECT DISTINCT domain` by reading the base table in key order and never considers the projection
  (sandbox: 1224 of 1224 granules, no projection used; with it off, 29 granules and 1.8M rows). `email_domain` is
  not in the key, so that path never needed it.
- DDL v24 (`ADD PROJECTION IF NOT EXISTS`, no MATERIALIZE at deploy), the init-SQL mirror, a third restorer in
  `runContentDedupTick` step 9 (order: `proj_email_domain_rev`, `proj_domain_rev`, then the 90 GiB
  `proj_imported_desc`), and `scripts/run-content-dedup-once.ts --restore-domain-projection` (idempotent).
  `--restore-projections` covers all three.
- Unaffected by construction: `stripProjectionsFromCreateTableDdl` (removes any number of projections), the
  main search, and the UI's exact filters.

### Sandbox probe (throwaway `ulp.zz_probe_domain`, dropped afterwards)

80.1M rows: a 1% hash sample plus every row of roblox.com and facebook.com (67M rows between them, to
exercise broad domains) plus every row for the monitor's 17 domains; same `ORDER BY`, partitioning and
granularity as the live table, merged to one part per partition. Projection size 4.47-4.55 bytes/row, so about
5.9 GiB at 1.39B rows. With the setting above, the rewritten predicate returned **identical result sets** (value
count and hash) to the original for the 17-domain monitor (44 values) and for facebook.com (811 values; a 31M-row
domain), and for roblox.com plus facebook.com both overflow `CANDIDATE_LIMIT` (1001 values each; which 1001 is
arbitrary, so only the count is comparable). Cost: 17 domains 1.7 s / 80M rows / 1224 granules -> 0.1 s / 1.8M rows
/ 29 granules; facebook.com 0.37 s / 80M rows -> 0.23 s / 31M rows / 477 granules.

Hazard that did not materialize: `max_projection_rows_to_use_projection_index` (default 1M) was a worry for broad
domains, but raising it (and `min_table_rows_to_use_projection_index`) changed nothing for facebook.com, which
reads the same 477 granules either way, so the rewrite needs no extra settings beyond the one above. Gate D0
still measures a broad domain on the live table.

Also measured: the sandbox's own `count()` shapes use `proj_domain_rev` directly (`Granules: 2/1224`), which is
fine; and a **result cache** trap: this server runs with `use_query_cache = 1` (30 s TTL) for the default profile,
so a repeated identical probe returns in 0 ms from the cache (`QueryCacheHits = 1`). Every timing here passes
`--use_query_cache=0` and drops the query condition cache first.

### Gate D0 (live)

Precondition: no `clickhouse-js` queries in `system.query_log` for the last 10 minutes, free disk above the disk
guard's floor. Steps: add the projection, materialize per partition behind the guard (partition 202608 first),
record per-part size, time and peak memory; then, with `SYSTEM DROP QUERY CONDITION CACHE` and
`--use_query_cache=0` before each timing, measure the monitor's 17-domain `domain` scan before/after, a broad
domain (facebook.com) before/after, and the whole resolver; compare result sets (count and value hash). Stop
and `DROP PROJECTION` if peak memory passes 8 GiB, free disk falls below 100 GiB, the server restarts, or any
result set differs. Pass criteria: identical result sets, the 17-domain scan under 2 s cold, no regression on
the broad domain. Outcome: all met; see Results.

## Results

**Part 1** is shipped and live (`ed26833`): measurements above, 27 tests, deployed bundle checked for the inner/outer text.

**Part 2, Gate D0 on the live table (1.39B rows, 8 parts), all cold with the result cache off:**

| Measure | Before | After |
|---|---|---|
| Monitor's 17-domain `domain` candidate scan, isolated | 16.9 s / 666,299,212 rows / 21,469 marks | **0.30 s / 8.4M rows / 128 marks**, identical 44 values (hash `7a6caecdda`) |
| Broad domain (facebook.com, overflows the 1001-value limit) | 75 ms | 76 ms (no regression; both stop at the limit) |
| Whole resolver, cold, real code path | 56.9 s | 41.4 s on two runs; the same 100 rows, `limited: true`, same hash `7d3086668fe4` before and after and across both runs |
| `MATERIALIZE` | n/a | 243 s (202608, one 496M-row part) + 128 s (202607, seven parts) = 6.2 min |
| Resources during it | n/a | container memory peaked at 2.5 GiB of 20; free disk dipped to 197.1 GiB (from 205.4) and settled at 199.2; no restart, no failed mutation |
| Size | n/a | **6.62 GiB**: 5.19 bytes/row in 202607, 4.85 in 202608 (the sandbox's 4.5 was a little low; `domain` has more distinct, longer values) |

The earlier "42.7 s" for the `domain` scan was measured while the user was searching; at idle it is 16.9 s
isolated, and 45 s when it runs next to the legacy probe, which is how the resolver runs it.

Side effects checked on the same table: the default browse sort (`domain_asc`, dedupe and noise on) 1.27 s and the
domain-filtered browse 0.96 s, both without any projection and unchanged in shape; the exact `domain` filter 16 ms
to 22 ms (noise); `domain = x OR domain LIKE '%.x'` counts now plan through `proj_domain_rev` and went from 12.6 s to
7.0 s with the same result (1,187,564); the `url_host LIKE '%x%'` branch is untouched (10.9 s).

### Findings the gate surfaced (not fixed here)

1. **The legacy probe is now the slowest part of a cold rescan, and it scales with the number of domains.** The
   `domain IN ('', 'http', 'https') AND <full match condition>` scan reads 22.6M rows and needs 404 CPU-seconds
   for the 17-domain monitor: 40 s alone, 55 s beside another scan, against `PHASE1_MAX_EXECUTION_TIME = 90`. With
   1, 4 and 17 domains it takes 2.9 s / 9.9 s / 39.9 s (27.8 / 101 / 406 CPU-seconds): `buildDomainSetWhereClause`
   re-evaluates the `NORM_*` expressions once per domain and column. It returned 0 rows for this monitor, so the
   40 s found nothing. The code comment's "5.7-7.9 s" dates from the old 2.4B-row table and has been corrected. A
   fix is to normalize once per row in a subquery and match the domain set with `arrayExists` against that
   (expected: about the 1-domain cost, ~3 s, independent of the domain count); it needs result-equality checks
   against a domain set that does hit legacy rows.
2. **Sorting by "newest first" with Unique on cannot finish at this scale.** `ORDER BY imported_at DESC` with
   `LIMIT 1 BY content_key_hash` plans a full read plus external sort with no projection (read 1.22B rows, 9.8 GiB,
   `TIMEOUT_EXCEEDED` at the route's 300 s cap). `projections: []` and the plan are the same as without
   `proj_domain_rev`, so it predates this work; the route's own comment already says it was 16-30 s at 91M rows. The
   UI's default sort (`domain_asc`) is unaffected.
3. `NORM_COLS` corrections look like a no-op under the default alias semantics (0 of 5,000 legacy-bucket rows altered
   against about 28 with `prefer_column_name_to_alias = 1`), so ~38K legacy rows probably show raw values. Not investigated.
