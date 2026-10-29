# Next page, endless scrolling and an Email default for a search — Design

Date: 2026-10-28
Status: **in progress** (phase A: the cursor, endless scrolling and the Email default). Phase B (the hit-set plan for more than 5,000 matches) is measured here and not built.

## Why

The report: going to the next page of results takes far too long. The app's own `system.query_log` (ClickHouse 26.3, `ulp.credentials` 2,229,506,200 rows in 15 parts, 34,299 granules of 65,536 rows, 195 GiB), `EXPLAIN` and reruns of the logged statements show where the time goes, for one real "contains" search (a text with a special character, `url LIKE '%x%' OR email LIKE '%x%' OR password LIKE '%x%'`) that has **125,760 matches** (108,377 Email, 16,743 username, 640 phone; about 98% of them in domains that start with one letter).

| the search, as the app ran it (user `default`) | seconds | rows read | GiB read |
|---|---|---|---|
| hit-set scan (`LIMIT 5001`), stopped at its cap | 13.8 | 559M | 41 |
| page 1, rows | 97.5 | 1,793M | 133 |
| page 1, totals (started together with the rows) | 109.6 | 2,225M | 161 |
| page 2 (cursor) | 67.9 | 2,214M | 164 |
| page 3 (cursor) | 59.2 | 2,212M | 163 |

**1. The cursor does not prune the primary key, so every page starts again from the first granule.** `buildCursorWhere` writes the cursor of `domain_asc` (the default sort) and of `email_asc`, `imported_asc`, `pw_len_*` as a tuple comparison, `(domain, email, imported_at, url, password) > (…)`. ClickHouse 26.3 does not use a tuple comparison for primary-key analysis: `EXPLAIN indexes = 1` on the page-3 statement says `PrimaryKey Condition: true, Granules: 34299/34299`, and so it does for `(domain, email) >= (…)` and `(domain, email, imported_at) >= (…)` on their own. A scalar form prunes: `domain >= x` selected 10,992 of 34,299 granules for a mid-table cursor, and `domain > d OR (domain = d AND email > e)` 10,836. The plan itself reads in primary-key order (`ReadPoolInOrder`, `FinishSortingTransform`), so a LIMIT can stop the read early; the cursor just never moves its start.

**2. Under the cursor a rare text is still a scan, because the data is in 15 parts.** The ordered read merges one stream per part, and a part whose next match is far away must be read up to it before the merge can emit anything. With the cursor rewritten as in 1, a page deep inside the dense part of the key space still read 623M rows (18.8 s), though its 200 rows are adjacent: that is the floor of the plain query for a text this rare, and only knowing where the matches are goes below it.

**3. The shortcut for that, the hit-set plan (`lib/search-hit-set.ts`), lists at most 5,000 positions (15,000 by setting).** This search has 125,760, so the plan declined and page 1, its count and every page after ran the plain scan. (One scan to find the matches took 33.2 s cold and 2.4 s with the table in the page cache.)

**4. The page throws its rows away while it waits.** `app/credentials/page.tsx` replaces the table by a spinner for the whole wait (50-100 s here), and the previous-page button runs the query again from its cursor.

The Email chip is not part of the cost: it kept 108,377 of the 125,760 matches (86%).

## Measured (2026-10-28, same table, the logged statements rerun in one session)

The page cache was not dropped between runs, so each time is a lower bound for a first run (the first scan for the positions took 33.2 s and the later one 2.4 s); the rows, GiB and granule columns do not depend on the cache.

| | seconds | rows read | GiB read | granules |
|---|---|---|---|---|
| page 3, today's tuple cursor (rerun) | 52.3 | 2,169M | 160 | 34,299 of 34,299 |
| page 3, cursor rewritten | 25.3 | 706M | 66 | 19,275 of 34,299 |
| page deep in the dense area, tuple cursor | 51.3 | 2,216M | 163 | |
| same, cursor rewritten | 18.8 | 623M | 58 | |
| *phase B (prototype, warm):* page 1 through the 125,760 listed positions | 12.6 | 188M | 36 | |
| page 3 through the positions, cursor rewritten | 6.8 | 84M | 15 | |
| deep page through the positions, cursor rewritten | 3.8 | 41M | 8 | |
| deep page through the positions, tuple cursor | 16.3 | 229M | 44 | |

The list of 125,760 positions is 1.26 million characters of SQL and needs `max_query_size` raised (the code's limit for the list today is 150,000 characters; ClickHouse's default is 262,144).

## Design (phase A)

### A. The cursor prunes the primary key (`lib/cursor-pagination.ts`)

The cursor condition stays exactly what it is, as the last conjunct, and a **superset of it that the primary key can use** is ANDed in front of it. The superset never removes a row the exact condition keeps, so the rows, their order and the next cursor are the same; it only lets ClickHouse skip the granules before the cursor.

| sort | superset (c_* are the cursor row's values) |
|---|---|
| `domain_asc` | `domain > c_d OR (domain = c_d AND (email > c_e OR (email = c_e AND imported_at >= c_ia)))` |
| `domain_desc` | its existing `domain < c_d OR (domain = c_d AND …)`, the inner part narrowed the same way by `email` and `imported_at` |
| `imported_asc` | `imported_at >= c_ia` (the partition key is `toYYYYMM(imported_at)` and `imported_at` has a min-max index) |
| `imported_desc`, `email_*`, `pw_len_*` | unchanged: `imported_desc` is already a scalar form (and the newest-first windows add their own bound); the others lead with a column that is not a prefix of the primary key, so nothing can prune them |

The clause is parenthesised as a whole, because the three routes that use it append it with ` AND `.

### B. Endless scrolling (`app/credentials/page.tsx`, new `lib/credential-pages.ts`)

* The table keeps its rows. When the end of the list comes within 1,500 px of the bottom of the table's scroll box, the next 200 rows (the page size) are fetched with the cursor of the last page and appended. A fetch never replaces the table; a new search does.
* The next page continues the search **on screen**, not the filter bar: the query string of the first page is kept (`appliedQueryRef`), so editing a box without pressing Apply, then scrolling, cannot mix two searches. (The Next button used the bar's current values with the old cursor.)
* A search that is replaced while a page is loading drops the late answer (a generation counter) and aborts the request, which the route already turns into a `KILL QUERY` (`lib/clickhouse.ts`).
* The footer says how many rows are loaded, shows the seconds a slow page has taken so far with a Stop button, and on an error or a stop shows a Retry button instead of clearing the rows. Nothing retries by itself.
* No library virtualises the table, so the rows are a memoised component, and loading stops by itself at 5,000 rows; past that a "Load 200 more" button continues one page at a time.
* The previous/next buttons and the page-cursor state go. Going back is scrolling up.

### C. Email by default for a search (`lib/login-type-default.ts`, the page)

* The login-type chips start automatic: **Email** when the request carries a search text or a domain, **All types** otherwise. A click on a chip is a choice that holds until Clear (the way Declutter works), including "All types".
* Not applied to the bare browse or to a view that only names a window or a file ("View what this added"): those show everything, and a request with a login-type filter loses the free total of a WHERE-free count.
* The chip row shows what the next Apply will use; the Clear button does not light up for the automatic choice; the export and the "since last export" memory use the same effective type as the search.
* Clicking "search this login" in a row's detail sheet on a row that is not Email-type searches with All types, so the row that was clicked is in the answer.
* The API is unchanged: no `login_type` parameter still means every type.

## Not done (phase B)

Lift the hit-set plan from 5,000 positions to about 200,000: the list travels in the SQL (1.26 MB for this search, `max_query_size` raised per query), and pages then cost 4-13 s instead of 50-100 s. Going well under a second would take a second step that sorts and filters the positions once (the position list answers a page with the sort and the filters still to apply: 4-13 s here, not 0.3 s as for a few dozen hits) and has not been measured. It needs its own design, the rehearsal and the live parity run.

## Proof

* `__tests__/cursor-pagination.test.ts`: the shape of each clause (the superset first, the exact tuple last, the same parameters).
* `__tests__/cursor-pagination.live.test.ts` (`CURSOR_PARITY=1`, the real table): for each sort, a walk of 30 pages through the route equals one ordered read, from the start and from a cursor deep in the table; `EXPLAIN` selects fewer granules than the tuple form.
* `scripts/e2e-cursor-pages.ts` (the rehearsal stack, the built image): a table with ties on `(domain, email, imported_at)` and on the whole sort key; every page of every sort equals the one ordered read, and the primary key prunes.
* Unit tests for `lib/login-type-default.ts` and `lib/credential-pages.ts`; the page itself driven in the browser on the rehearsal app.

## Rollout

(filled in when it ships)
