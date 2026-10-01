# "Newest first" as exact time windows — design and measurements (2026-10-01)

Follow-up to `2026-09-30-related-panel-and-domain-rev-design.md`, "Deliberately NOT done" item 6 (token / substring search:
25–43 s). Reference table: `ulp.credentials`, 1.39B rows, partitions 202607 (897.6M rows) and 202608 (495.8M), ordered by
`(domain, email, imported_at)`. Every timing is cold-ish (query cache and condition cache off) on the one 16-thread laptop.

## What was slow, and what was not

The Credentials Browser's default request is `sort=domain_asc`, Declutter on, Unique on, 200 rows. That sort is a prefix of the
table's own primary key, so ClickHouse reads in key order and stops after 200 matches. Measured:

| Term (default sort `domain_asc`) | rows query | totals query (separate request) |
|---|---|---|
| `binance.com` | 7.0 s | 12.8 s |
| `accounts.google.com` | 8.2 s | 14.3 s |
| `ledger.com` | 9.2 s | 8.6 s |
| `ledger` (word token) | 14.1 s | 11.8 s |
| `binance` (word token) | 11.2 s | 16.5 s |
| no match at all | 5.0 s | 3.7 s |

The slow cases were every sort that is NOT a primary-key prefix. For those the rows query must read every matching row and sort:

| Term | `imported_desc` ("Newest first") | `email_asc` | `pw_len_desc` |
|---|---|---|---|
| `binance.com` | 18.2 s | 17.9 s | 17.9 s |
| `accounts.google.com` | **45.0 s, 10 GiB** | 37.6 s | 38.0 s |
| `ledger` | 19.5 s | 19.5 s | 19.5 s |
| no match | 4.6 s | 4.8 s | 4.6 s |

and a plain browse (no search) by "Newest first" took **40–48 s** (a full scan and sort), with or without Declutter.
`/api/search` and `/api/v1/search/credentials` default to this sort too.

## Why `proj_imported_desc` did not help

`proj_imported_desc` (DDL v14) holds the browse columns sorted `negate(toUnixTimestamp(imported_at)), domain, email, url, password`,
i.e. newest-first. It was meant to let ClickHouse read newest-first and stop after 200 rows. Measured on 26.3.17, it never does:

- the plan is `Sorting` + `ReadFromMergeTree (proj_imported_desc)` with `ReadType: Default` and every granule (7,609 of 7,674) read,
  even when `ORDER BY` is written as the projection's own key expression; the projection is used only as a narrower covering copy;
- it lacked `is_noise` and `content_key_hash`, so the default Declutter + Unique query could not use it at all;
- a predicate on `imported_at` does not range-prune it: the newest 60 seconds written `imported_at >= X` read **495,875,196 rows in
  7.6 s**; the same window written on the key expression, `negate(toUnixTimestamp(imported_at)) < -X`, read **200,384 rows in 0.13 s**.

The v14 comment's "monotonic-function inference" claim was measured at 16.85M rows and does not hold at this scale.

## Design: windows on the projection key (`lib/newest-first.ts`)

Run the query as disjoint time windows, newest first, each restricted by a predicate on the key expression, until the page is full:
the newest minute, then 16x wider each time (1 min, 16 min, 4.3 h, 2.8 d, 45 d, the rest). The newest import burst is about 15,000
rows per second, so a term that is not rare fills its page from the first window or two.

**Exact, not approximate.** Windows are disjoint by timestamp, so every row in a window is strictly newer than every row in the next;
each window is ordered by the full `ORDER BY`; so the concatenation is the global order and the first `want` rows are the global
top `want`. Unique (`LIMIT 1 BY content_key_hash`) is applied to the same top 3n rows the plain query took (it already de-duplicated
inside a 3n window), in JS, first row per key. The cursor and the date range only move the top and bottom of the range; the route's
own keyset clause stays in the WHERE. Verified, not argued: `__tests__/newest-first-parity.live.test.ts` drives the real route and
asserts the windowed pages and cursors equal the plain query's (13 scenarios, 3 pages each).

**Rare terms are the catch.** The plain query prunes granules with the base table's skip indexes (bloom, ngram, text); a projection has
none. On the 1-in-40 sandbox, no-match / rare-domain / word-token searches took about twice as long windowed. So the windows get a
small budget (`HANDOFF_MS`, 2.5 s): each next window is 16x wider than the last, its cost is predicted from the last one, and when it
will not fit the request is handed back to the plain query, which is exactly what ran before. A rare term pays the plain query plus the
first window or two.

**Fails closed.** `isNewestFirstReady` (metadata only, cached 60 s) requires the live projection to carry `is_noise` and
`content_key_hash` and every part of the newest partition to have it. Not ready, a hand-off, or a window error that is not a timeout:
the plain query answers. A timeout is a 408, not a second attempt. The response says which plan ran: `"plan": "windows" | "plain"`.

## Schema changes

- **DDL v27** re-creates `proj_imported_desc` with `is_noise, content_key_hash` added (`IMPORTED_DESC_PROJECTION_BODY`, shared by
  v14, v27, the restore after a dedup swap and the init SQL; a test pins the init SQL to it). DROP and ADD are metadata-level;
  the build for 495M rows (~34 GiB) is **not** done at app start: `scripts/rebuild-imported-desc-projection.sh`, supervised,
  asynchronous and polled, with a free-disk floor and a final check that a windowed query is answered by the projection and reads a
  sliver of the partition. Safe to re-run; with nothing missing it writes nothing.
- **Projection scope.** `PROJECTION_SCOPE_WINDOW_MONTHS` is counted from the calendar, and nothing has been imported since 2026-08-28:
  as the months went by, the daily scope tick would have cleared the projection from the only partition that matters. The newest
  partition is now never cleared and always restored.
- Two June scripts that built the old definition and argued for the in-order read (`add-/verify-imported-desc-projection.sh`) are removed.

## Results on the live table (2026-10-01)

The projection was rebuilt with `scripts/rebuild-imported-desc-projection.sh` (496,740,436 rows, 33.14 GiB; about 32 minutes: the
mutation reads for 13 minutes and then writes the 34 GiB single-threaded). Page 1, 50 rows, Declutter + Unique, cold; the "plain"
column is the route's own query before this change (first call, so not a cache hit), "windows" is the route now with the query cache
dropped before every call. `__tests__/newest-first-parity.live.test.ts` (`NFW_PARITY=1`) produces both columns and asserts that the pages
and cursors are IDENTICAL for 13 scenarios x 3 pages: **13 of 13 identical**.

| Scenario | plain | windows | answered by |
|---|---|---|---|
| default view, no search | 76 s | **0.09 s** | windows |
| `binance.com` | 38.7 s | **0.80 s** | windows |
| `accounts.google.com` (47.7M matches) | 47.7 s | **0.87 s** | windows |
| tier T1 + corporate logins | 61.7 s | **0.48 s** | windows |
| password filters | 67.0 s | **0.08 s** | windows |
| regex `^admin@` | 69.0 s | **0.72 s** | windows |
| date range inside the newest burst | 6.7 s | **0.09 s** | windows |
| word token `ledger` | 18.1 s | 17.7 s | plain (hand-off) |
| rare domain `trezor.io` | 16.3 s | 15.7 s | plain (hand-off) |
| no match at all | 15.0 s | 13.8 s | plain (hand-off) |
| date range wholly older than the projection | 28.3 s | 26.9 s | plain (range outside coverage) |
| date range 08-10..08-20 (a gap above a dense burst) | 21.9 s | 20.7 s | windows (no gain, no loss) |

Per-window cost on the live projection (UI default, 600 rows wanted): the newest minute 0.11-0.17 s (reads ~0 rows), the next 15
minutes 0.4-1.1 s (12-17M rows), the next 4 hours 3.7-7.8 s (131-153M rows). That is why the budget is 2.5 s: two windows fit, a third does not.

Two things the profile taught, both in the code: (1) ClickHouse planned a word-token window on the base table because the text and
ngram skip indexes made it look cheaper (202M rows for the newest minute, 1.96 s); with `use_skip_indexes = 0` it uses the projection
(0.19 s), so the windows inside the projection's coverage turn them off, while a window that reaches the older partition (no projection)
keeps them (without them its base-table scan took 28 s instead of 17 s); (2) a `date_to` newer than the newest row used to anchor the
windows above the data, so the newest burst landed in one 4-hour window (6.7 s); the windows now hang from the newest row (0.09 s).

**Known limits.** A mid-rare term such as `ledger` would finish in 8.8 s by windows (3 windows) against 18 s plain, but the hand-off
decides after the second window and the plain query answers: no gain, no loss (+0.9 s). A `date_to` that falls in a gap above a dense
burst makes the first non-empty window the whole burst, i.e. the plain query's cost. Both would be fixed by estimating each window's
cost from its row count (a count over the key range) instead of from the previous window's time; not done, because it adds a round trip
to every request for a minority of searches.

## What this does not change

- **Other sorts** (`email_*`, `pw_len_*`, `imported_asc`) still scan every match. `imported_asc` would need the projection on 202607 too
  (~60 GiB). Not worth it for a sort nobody asked for.
- **`/api/search` and `/api/v1/search/credentials`** compute `total` in the same request, and that count (8–17 s) is now the long pole,
  so their first page is not faster. They were left alone.
- **The substring branches of the free-text search** (`url_host LIKE '%x%'`, `email_domain LIKE '%x%'`) are unchanged: for `ledger.com`
  86% of today's matches come only from them (lookalike hosts such as `coinledger.com`), so narrowing a dotted term to "the site and its
  subdomains" would delete the use case it serves (1,338 of 1,560 matches; for `binance.com` 3.6%, `accounts.google.com` 0.4%, `trezor.io` 0.5%).
  The exact-domain filter and the bare word are the fast, precise paths today.
- **A distinct-value dictionary** (aggregate projections over `(domain, url_host)` and `email_domain`, ~100M and 13M distinct values, so a
  substring is resolved in ~0.5 s and the data query becomes `domain IN (...)` / `reverse(email_domain) IN (...)`) would take word-token
  searches from 11–16 s to roughly 2–3 s with unchanged results. It needs two more projections, a restore path after every dedup swap, a
  multi-branch query planner in the routes and a ~10–20 minute live build. At this scale (one user, nothing ingested for a month) the
  gain does not pay for the coupling; it is the design to pick up if substring search becomes a daily tool.
