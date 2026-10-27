# Site counts: how many rows a list of sites has — Design

Date: 2026-10-26
Status: **implemented, verified (4,347 tests, live parity, rehearsal 90 of 90) and deployed locally on 2026-10-26** (main `fc62653`; image `ulp-suite-app:latest` = `37e4fbe4430f`, built by `git archive e3bab14`; the image that ran before, `4145c664f865`, is tagged `ulp-suite-app:rollback-20261026-1705z`). Rollout at the end. The number columns became sortable on 2026-10-27: see the last section.

## Why

The request: paste or upload a list of platforms, pages or URLs and be told how many results there are for each. The tools that exist do not answer that:

- The Batch Lookup returns rows, at most 50 per entry, and its `count` is the length of that capped list, so every busy site reads "50 hits".
- A site is more than one host. `domain` stores the bare host the parser extracted, so the rows of `app.corp.tld` are not found by `domain = 'corp.tld'`. On a 58-site list 46 sites have rows; 26 of them have more rows on subdomains than on the host and 7 have none on the host at all (one site had 7 rows on its host and 2,608 on 8 subdomains). Counting only hosts would have shown 33,160 of the 150,079 rows (22%) and reported 0 for 7 sites that have rows.

## What is counted

A **site** is the host an entry stands for and every subdomain of it. That is the meaning a domain monitor already has (`lib/domain-match.ts`: "the candidate is the monitored domain itself, or any subdomain of it"), so the two features agree. The answer tells the two apart:

- `host_count`: rows whose stored domain is the host or its `www.` spelling (4,605 older rows keep one; they are the site's own).
- `subdomain_count`, `subdomains` (how many different ones) and `top_subdomains` (up to 10, most rows first, ties by name).
- `count = host_count + subdomain_count`.

The entry is cleaned with the cut the lookups use (`domainEntry`, `lib/batch-input.ts`: a URL, a `www.` host, `host:port`, quotes, padding), plus a leading `*.` or `.`. **A path in an entry is ignored**: `domain` holds hosts, and counting the rows whose URL contains a path is a different query (a substring test on the URL column over every row of the site) that was not asked for. The answer carries `searched_as` when what was counted differs from what was typed, as the lookups do.

Rows are counted, not distinct logins. A login seen in two files is two rows (the content dedup removes exact repeats of url + login + password, not the same login on two sites).

Not counted, on purpose: rows whose stored domain is `host:...` or `host/...` (older imports kept a fragment of the line after the host: on a 58-site list that is 79 rows against 150,079, 0.05%, and what follows the colon is a password fragment, not a port). A name that merely ends like the site (`not-corp.tld` against `corp.tld`) is not under it: the match is on a dot boundary.

An entry that is not a site (nothing, a bare scheme, a name with no dot such as `localhost` or a top-level name, which would count every site under it, a name longer than 253 characters) has `error` and null numbers. So does a site too broad to count in the time allowed. A null is never a zero.

## The query

`proj_domain_rev` (`PROJECTION ... SELECT _part_offset ORDER BY reverse(domain)`, on all 15 parts, 10.15 GiB) turns a suffix match into prefix ranges: `endsWith(domain, '.x')` is `startsWith(reverse(domain), reverse('.x'))` byte for byte. One pass answers a chunk of sites:

1. the WHERE is only the pruning condition: per host an equality and a label-boundary prefix on the reversed key (ClickHouse folds the equalities into one set);
2. the granules it leaves are grouped by stored domain (`GROUP BY domain`, `count()`);
3. each stored domain is expanded into its dot-boundary suffixes (`a.b.tld` -> `a.b.tld`, `b.tld`, `tld`) and only the suffixes that are listed hosts stay, which gives each domain to every listed host it is under (a list may hold `corp.tld` and `login.corp.tld`);
4. per host: `sumIf` for the host's rows and the subdomains' rows, `countIf` for how many, and the top list sorted in SQL, so the answer is a few hundred bytes however many subdomains there are (one very broad site has 650,000).

All reversals happen in SQL, never in JavaScript: ClickHouse's `reverse` is byte-wise on both sides, JavaScript's is by code unit.

### Measured (2026-10-26, 2,229,506,200 rows, 15 parts, ClickHouse 26.3.17.4, 16 cores; cold = condition, mark and uncompressed caches dropped)

| Probe | Result |
|---|---|
| exact hosts only, 58 sites, `domain IN (...)` through the primary key | 0.17 s |
| 58 sites + subdomains, `GROUP BY domain` with `max(imported_at)` | **full scan: 131 s, 2.23B rows, 38.5 GiB.** The planner skips the projection index when the rows it would read exceed `max_projection_rows_to_use_projection_index` (1,000,000) and the query needs a column the projection does not hold |
| the same with the pruning condition inside `indexHint(...)` (as the e-mail lookups do for their text index) | full scan, 24 s: the projection index does not see through it |
| `SELECT DISTINCT domain` through the projection (what a monitor does), then `domain IN (7,500 values)` | 2.3 s + 12.6 s and 502M rows: 7,500 sparse keys cost at least one granule of 65,536 rows each |
| **shipped: one pass, 58 sites** | **2.3 s cold, 264 of 34,299 granules, 17.2M rows; the same 46 sites with rows and the same 150,079 rows as the 131 s scan, 0 differences** |
| sites per query: 10 / 20 / 50 / 100 | 0.23 / 0.44 / 1.4 / 5.0 s (23 / 22 / 28 / 50 ms a site) |
| a 419-site list with a few of the broadest sites, one query | did not finish in 60 s |
| the same 26.3M rows, 100 sites: equalities only / with the prefix conditions | 0.37 s / 4.6-5.0 s |
| very broad sites alone (73M, 83M, 90M rows; 35,000-79,000 subdomains) | 0.8 / 0.9 / 0.7 s |
| a chunk of 20 with two of those and 18 ordinary sites | 2.1 s |
| public-suffix-like entries (22M rows, 652,000 subdomains) | 0.97 s |
| an imported window, default settings | 15 s timeout (every month the window touches is read) |
| an imported window, `max_projection_rows_to_use_projection_index = 200000000` | 0.4-1.3 s per chunk of 20; 3-4 s for a site of 73M-83M rows |
| 100 random sites through the route, 20 per query | 1.9 s |

**Why chunks of 20.** The prefix conditions are evaluated on every row of the granules that are read, so the work is rows x hosts (the equality-only probe above reads the same granules and takes 0.37 s). Chunking divides it: about 22 ms a site however long the list. A chunk that times out (20 s) is counted site by site, so only a site that is too broad on its own is reported without a number; and the whole request stops starting queries after 45 s (the sites left say so). Anything else that goes wrong (ClickHouse down) is a 500 for the request, not a quiet gap in the list.

**Why no derived table or aggregate projection.** Either would make a count a prefix scan of about 40 million rows (tens of milliseconds for any list), but costs a build that groups 2.2 billion rows (about 2 GB of aggregation state on a host that has had a ClickHouse out-of-memory kill), a freshness fingerprint and a fallback path, or a DDL change and a materialisation over 2.2 billion rows. At 22 ms a site that is not needed.

**The fallback.** `isDomainRevProjectionReady` (`lib/credentials-projections.ts`, the gate the monitors use) is one metadata query: ready only when every active part carries the projection. Otherwise a mixed state would read the parts without it whole, so only the hosts are counted (`domain IN (host, www.host)`, the primary key) and the answer says `subdomains_counted: false` with null subdomain numbers; the page shows a notice.

## Interfaces

- `POST /api/v1/lookup/counts` (API key, admin or analyst) and `POST /api/lookup/counts` (session), body `{ domains: string[], imported_after?, imported_before? }`, at most 100 sites; 400 for none or a bad window, 422 for more than 100. Both call `answerSiteCounts` (`lib/site-counts.ts`): the batch lookups had two copies of their logic and both carried the same defects.
- The window is the one of every other lookup (`lib/imported-range.ts`).
- Page `/counts` ("Site Counts", Search group): a paste box or an uploaded `.txt`/`.csv`/`.tsv` file (or a dropped one; up to 2 MB), up to 2,000 sites, sent in requests of 20 with a progress bar and a Stop button; a table sorted by the sites that need attention first, then the most rows (a click on a number column's header sorts by it: see the last section); a click opens the detail of a counted site (rows on the host, rows on its subdomains, the top subdomains); below 1024 px the list sits above the table so site names keep their width; a count that is stopped says so; Export CSV (`siteCountsCsv`, formula-safe). The pure parts are in `lib/site-counts-input.ts`, which the page can import (the counting module talks to ClickHouse).

## Proof

- Unit and route tests (`__tests__/site-counts*.test.ts`): cleaning, planning, the SQL text (the prune, the settings, no `indexHint`, the window), shaping, chunking, the site-by-site retry, the budget, the fallback, both routes (auth, 400/422/500, the window echo, both routes answering the same). 17 mutations of the library (drop the `www.` spelling, drop the dot of the prefix, ignore the window, no chunking, no retry, swallow every error, drop the projection setting, wrap in `indexHint`, sort the top list ascending, count only the host, always set `searched_as`, ignore the budget, ignore readiness, accept 100,000 sites, keep `www.`, allow one label, print a null as 0): the first run killed 15; the two that survived (chunk size, sort order) were pinned in the tests and are killed now.
- Live, read-only (`BLK_LIVE=1 npx vitest run __tests__/site-counts.live.test.ts`, about 2.5 minutes, prints no value): for 21 sampled sites (stored domains, the site that contains each, `www.`-stored, absent) both routes equal one plain full scan with `endsWith` and no projection, worked out in code: rows on the host, rows on subdomains, how many subdomains, the ten biggest in order, **0 mismatches** (the scan takes 37-49 s, the route 0.5 s; run three times on different random samples, the last on the final commit); the same under a 10-day window; eleven pasted shapes of one site give the bare host's numbers; 100 sites in 1.8-1.9 s with EXPLAIN reading 117-120 of 34,299 granules (0.35%) through `proj_domain_rev`; the host-only fallback agrees with the answer on all 21 hosts. The first run failed two tests on the sample itself (a stored `www.<tld>` is a domain whose remainder is not a site), which the product answered correctly; the sampling now requires a real site after the `www.`.
- Rehearsal (`scripts/e2e-batch-lookup.ts`, step 7; 90 of 90 checks with the 55 of the lookups) on the built image against a fresh install: the exact numbers for a seeded site (host, `www.` spelling, subdomains two labels deep and under another listed site, a look-alike name, a `:port` spelling, rows imported in 2020), every pasted shape, windows, 100 sites, 101 refused, EXPLAIN on the fresh table, both routes agreeing, the page; last the fallback (the projection cleared: hosts only and the answer says so; after `MATERIALIZE` the subdomains are counted again). The first rehearsal run failed one check, which was the check: it asked for a window after the year 2999, and a DateTime ends in 2106, so the route rightly answered 400 (now a check of its own). The page was also looked at in the browser pane on the rehearsal stack: a layout that gave the site column no width at 800 px was found and fixed, and a file chosen through the input replaced the list.

## Not done

- A path in an entry is ignored. Matching the path would be a substring test on `url` over the rows of the site (the text index on `url` can narrow it); say so if page-level counts are wanted.
- Distinct logins per site: needs the e-mail column of every row of the site (a broad site has tens of millions).
- E-mail-domain hits (the staff accounts of the site, `@corp.tld`): the monitors have that mode (`proj_email_domain_rev`); not asked for here.
- Subdomains stored with a port or a path (`app.corp.tld:8443`) are not under any reversed prefix. The same fragments on a host are 0.05% of rows.
- A list is counted sequentially (about 22 ms a site; 2,000 ordinary sites take about 45 s).

## Rollout (2026-10-26, local only)

Checked first: no import job running, `inbox/processing` empty, ClickHouse idle (0 queries, 0 merges). The running image was tagged `ulp-suite-app:rollback-20261026-1705z` before anything was built (containerd drops an image when its tag moves). The candidate `37e4fbe4430f` (`git archive e3bab14`, tag `counts-candidate`) was rehearsed 90 of 90 on a fresh install and looked at in the browser pane (800 px and 1440 px). `ulp-suite-app:latest` was moved to it and `docker compose up -d --no-deps --no-build app` was run from the primary checkout (from a worktree it would blank `.env`). The app was healthy after the restart with 0 restarts and no error in its log, said "DDL v29 already applied" (no schema work), mounts `uploads`, `data`, `inbox` under the primary checkout and the archive directory, has `JWT_SECRET`, and its server bundle holds the counting SQL (the prune condition and the projection setting) and no `indexHint` in it. Without credentials: `POST /api/v1/lookup/counts` and `POST /api/lookup/counts` answer 401, `GET /counts` redirects to the sign-in page, and the lookups answer as before. The deployed routes could not be called with a key (none was available to the session); what ran was the same code in process against the real table (the live test) and the same image on the rehearsal stack. Rollback: `docker tag ulp-suite-app:rollback-20261026-1705z ulp-suite-app:latest`, then the same `compose up` from the primary checkout; nothing else changed (no DDL, no setting, ClickHouse untouched).

## Sortable columns (2026-10-27)

The four number headers (Rows, On the site, On subdomains, Subdomains) sort the table, in the look and the click cycle of the Credentials headers (a faint arrow pair that brightens on hover, an accent-coloured chevron on the active column). The first click sorts biggest first (these are counts, and the Credentials page starts smallest-first), the second smallest first, the third goes back to the default order (not counted first, then the most rows); a click on another column starts that column over.

- A site with no number for the column (not counted, or only its host counted, so its subdomain numbers are null) goes last whichever way, never as a zero. Sites that tie keep the default order, so equal numbers still list the biggest sites first.
- The ordering is `orderSiteRows` and `nextSiteSort` in `lib/site-counts-input.ts` (pure; the page's `displayOrder` moved there). The sort is page state, so counting again keeps it; the CSV follows the order on screen; a row that is open stays open when it moves.
- The Subdomains column showed from 2xl (1536 px) only, so on a laptop window it could not be clicked. All four number columns show from xl (1280 px), and each header keeps room for its arrow: columns of 80 / 96 / 112 / 96 px, with 32 / 12 / 4 / 7 px to spare at 1440 px. The site name keeps 372 px at 1440 px and 212 px at 1280 px (a long entry with a path is cut with its tooltip holding all of it); below 1280 px only Rows shows, as before.

Proof. 9 unit tests of the ordering and 2 page checks, written first and seen failing; 6 of 6 mutations of the ordering are caught (rows without a number first, direction flipped, no tie-break, a missing number read as zero, no third-click reset, the caller's list sorted in place). Full suite 4,455 passed, typecheck and lint clean. Rehearsal 90 of 90 on the candidate image (`git archive 26ccb9e`) against a fresh install. In the browser pane on the rehearsal stack, seven seeded sites (ties, a site with rows only on subdomains, a `www.` spelling, a not-counted entry) gave the hand-worked order for every column both ways and for the reset; a row opened before a sort stayed open as it moved; counting again kept the sort; nothing overflowed at 1440, 1280, 1100 and 375 px. On the live page with a 102-entry list (77 sites with rows, 4,655,137 rows) all four columns in all three states kept the 102 rows and their numbers (one checksum over every row before and after) and were monotonic, with not-counted rows last and ties ordered by total rows.

Not done: the Site column is not sortable (not asked for); a sort on a column that is hidden below 1280 px stays in effect when the window narrows, and only Rows is on screen then; the Export CSV button was not clicked in the browser (a download), the function that writes it was run on the real results instead.

Rollout (2026-10-27 ~14:58Z, local only). Checked first: ClickHouse 0 queries and 0 merges, `inbox/processing` empty. The running image `e2eedf7af068` was tagged `ulp-suite-app:rollback-20261027-1450z` before anything was built. The candidate `bdc8ddd37b1f` (`git archive 26ccb9e`, tag `sort-candidate`, built in 42 s from cached layers) was rehearsed on the isolated stack, which was then removed with its volumes. `ulp-suite-app:latest` was moved to it and `docker compose up -d --no-deps --no-build app` was run from the primary checkout. The app was healthy with 0 restarts, said "DDL v29 already applied", logged no error, answered 401 on both routes without credentials and redirected `/counts` to the sign-in page, and the signed-in session survived the restart. Rollback: `docker tag ulp-suite-app:rollback-20261027-1450z ulp-suite-app:latest`, then the same `compose up` from the primary checkout.

## How the numbers compare with the Credentials page (2026-10-27)

Asked why one site read 4,993 here and "3,036 records of 5,025" on the Credentials Browser. Measured on the live table (2,229,506,200 rows), then checked on the page itself. No site is named: the list is the owner's.

What each counts. Site Counts: the rows whose stored `domain` is the host, its `www.` spelling or a subdomain, with nothing hidden. The Credentials header: the larger number is every row the search matched, the smaller one that after Declutter (`is_noise = 0`) and Unique (`uniqIf(content_key_hash, ...)`). A domain-shaped text matches `domain = X`, `domain LIKE '%.X'`, `url_host LIKE '%X%'` and `email_domain LIKE '%X%'` (`lib/ulp-search.ts`): the last two are substring tests, so they also take hosts that merely contain the text and every e-mail address on that domain.

One site, reconciled to the row: 4,985 on the host + 8 on subdomains = 4,993 here; + 22 e-mail-domain hits (an address of that domain used on other sites) + 10 hosts that only contain the text (7 glued to other text, 3 stored with a `:` fragment, which Site Counts leaves out on purpose) = 5,025 matched; - 1,989 hidden by Declutter (1,988 `.php` URLs, 1 domain holding a space) - 0 removed by Unique = 3,036. The same two identities held on 13 other sites (on one, Unique's figure read 94,948 where the exact distinct count was 94,969: it is a HyperLogLog estimate on a filtered search).

What Declutter hides, by where it is used.

- The whole table: 116,286,422 rows (5.22%). By the first rule that hides them: `.php` URLs 66.6M (57%), IP-address hosts 23.0M, host without a dot 11.3M, `:port` 8.0M, blank / punctuation / space-or-@ domains 6.6M, localhost and browser schemes 0.8M.
- The owner's 77 sites that have rows (4,655,137 rows): 2,581 hidden (0.06%), 80% of them `.php`. 21 sites lose at least one row, 6 lose 1% or more, 3 lose 20% or more, and one loses every row: with the defaults a search for it returns 0 rows (3 with Declutter off). The one site that loses 39.8% (1,987 of 4,993) runs its own index, sign-up and login on `.php`.
- A person's address (a hash sample of 12,944 addresses): 5.9% lose at least one row, 1.3% lose all of them (2.55% of rows).
- A common login is the opposite case: 25 to 71% of the rows of the five commonest logins are hidden, nearly all router and IP-host panels (`admin` 56%, `root` 71%). That is what the chip is for.
- The default view (Domain A to Z, no search), first 200 rows: Declutter off gives 200 blank-domain rows of which 198 are parser junk; on gives 200 blank-domain rows of bare login:password (11.8M such rows are kept, 15.0M junk ones hidden), none junk.
- Speed is the same either way: 0.3 to 1.0 s for the default view, 0.41 against 0.43 s for a domain search, 2.49 against 2.51 s for an address.
- Unique removed 0 rows on all 14 sites tried: `uniqExact(content_key_hash)` equals `count()` (storage is de-duplicated at rest).

Changed: the dim text after the records now reads "of N matching" (it said "total imported", which read as the site's own total; with no search or filter it still says so) and its tooltip gives the rows matched, the rows shown and which chips hide the rest (`matchingLabel`, `matchingHint` in `lib/credential-totals.ts`); the Declutter chip's tooltip says it hides every URL ending in `.php`, not only login pages; the note under the list on the Site Counts page says Declutter and Unique are not applied.

The default of Declutter (the owner chose the rule on 2026-10-27). Off everywhere puts parser junk on the first page of the default view and floods the searches for common logins; on everywhere hides real rows of site and address lookups. So it starts on for the bare browse and for broad searches (a word, a login, a pattern) and off for a lookup of one thing: any term that is a domain or an IP address, an address (or `@domain`), or a text with a path, a colon, a space or a symbol in it; in a login scope only a whole address; the Domain box and the host and e-mail domain filters. Terms are ANDed, so one such term makes the whole search a lookup; a term that only excludes does not decide. A click on the chip sets it until Clear. `declutterByDefault` in `lib/declutter-default.ts` is the rule (pure); `buildParams` applies it to the values a request carries, so a click on an address or a domain in a row counts; the chip and the header follow the view each request asked for (`appliedViewOf`), not the filter bar. An IP address could never be found with Declutter on: its rows are the rule's first target.
