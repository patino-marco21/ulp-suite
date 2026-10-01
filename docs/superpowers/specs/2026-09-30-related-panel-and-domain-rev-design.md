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
  `preferred_optimize_projection_name = 'proj_domain_rev'` only when every active part carries the projection
  (`isDomainRevProjectionReady`, fails closed); otherwise today's query with `optimize_use_projections = 0`.
  The `email_domain` decision is unchanged. Both readiness checks are metadata-only.
- DDL v24 (`ADD PROJECTION IF NOT EXISTS`, no MATERIALIZE at deploy), the init-SQL mirror, a third restorer in
  `runContentDedupTick` step 9 (order: `proj_email_domain_rev`, `proj_domain_rev`, then the 90 GiB
  `proj_imported_desc`), and `scripts/run-content-dedup-once.ts --restore-domain-projection` (idempotent).
  `--restore-projections` covers all three.
- Unaffected by construction: `stripProjectionsFromCreateTableDdl` (removes any number of projections), the
  main search, and the UI's exact filters.

### Hazard to measure, not assume: broad domains

ClickHouse only uses a projection index when the rows it selects stay under
`max_projection_rows_to_use_projection_index` (default 1M). A broad monitored domain (facebook.com) would
then fall back to evaluating `reverse(domain)` over every row, which could be slower than today's column
scan. Gate D0 measures a broad domain cold, original against rewritten, and the plan adds
`max_projection_rows_to_use_projection_index` to the query's settings, or gates the rewrite on breadth, only if
the measurement shows a regression.

### Gate D0 (live, before the resolver change is merged)

Precondition: no `clickhouse-js` queries in `system.query_log` for the last 10 minutes, free disk above the disk
guard's floor. Steps: add the projection, materialize per partition behind the guard (partition 202608 first),
record per-part size, time and peak per-task memory; then, with `SYSTEM DROP QUERY CONDITION CACHE`
before each timing, measure the monitor's 17-domain `domain` scan before/after, and a broad domain
(facebook.com) before/after; compare result sets (count and value hash). Stop and `DROP PROJECTION` if peak
memory passes 8 GiB, free disk falls below 100 GiB, the server restarts, or any result set differs.
Pass criteria: identical result sets, the 17-domain scan under 2 s cold, no regression on the broad domain.

## Results

Part 1: measured above; implementation and tests in this change. Part 2: filled in after Gate D0.
