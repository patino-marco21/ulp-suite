# Site counts: how many rows a list of sites has — Design

Date: 2026-10-26
Status: **implemented and verified (unit, live parity, rehearsal); rollout recorded at the end.**

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
- Page `/counts` ("Site Counts", Search group): a paste box or an uploaded `.txt`/`.csv`/`.tsv` file (or a dropped one; up to 2 MB), up to 2,000 sites, sent in requests of 20 with a progress bar and a Stop button; a table sorted by the sites that need attention first, then the most rows; a click shows the top subdomains; Export CSV (`siteCountsCsv`, formula-safe). The pure parts are in `lib/site-counts-input.ts`, which the page can import (the counting module talks to ClickHouse).

## Proof

- Unit and route tests (`__tests__/site-counts*.test.ts`): cleaning, planning, the SQL text (the prune, the settings, no `indexHint`, the window), shaping, chunking, the site-by-site retry, the budget, the fallback, both routes (auth, 400/422/500, the window echo, both routes answering the same). 17 mutations of the library (drop the `www.` spelling, drop the dot of the prefix, ignore the window, no chunking, no retry, swallow every error, drop the projection setting, wrap in `indexHint`, sort the top list ascending, count only the host, always set `searched_as`, ignore the budget, ignore readiness, accept 100,000 sites, keep `www.`, allow one label, print a null as 0): the first run killed 15; the two that survived (chunk size, sort order) were pinned in the tests and are killed now.
- Live, read-only (`BLK_LIVE=1 npx vitest run __tests__/site-counts.live.test.ts`, about 2.5 minutes, prints no value): for 21 sampled sites (stored domains, the site that contains each, `www.`-stored, absent) both routes equal one plain full scan with `endsWith` and no projection, worked out in code: rows on the host, rows on subdomains, how many subdomains, the ten biggest in order, **0 mismatches** (the scan takes 48.5 s, the route 0.5 s); the same under a 10-day window; eleven pasted shapes of one site give the bare host's numbers; 100 sites in 1.9 s with EXPLAIN reading 117 of 34,299 granules (0.34%) through `proj_domain_rev`; the host-only fallback agrees with the answer on all 21 hosts.
- Rehearsal (`scripts/e2e-batch-lookup.ts`, step 7) on the built image against a fresh install: the exact numbers for a seeded site (host, `www.` spelling, subdomains two labels deep and under another listed site, a look-alike name, a `:port` spelling, rows imported in 2020), every pasted shape, windows, 100 sites, 101 refused, EXPLAIN on the fresh table, both routes agreeing, the page; last the fallback (the projection cleared: hosts only and the answer says so; after `MATERIALIZE` the subdomains are counted again).

## Not done

- A path in an entry is ignored. Matching the path would be a substring test on `url` over the rows of the site (the text index on `url` can narrow it); say so if page-level counts are wanted.
- Distinct logins per site: needs the e-mail column of every row of the site (a broad site has tens of millions).
- E-mail-domain hits (the staff accounts of the site, `@corp.tld`): the monitors have that mode (`proj_email_domain_rev`); not asked for here.
- Subdomains stored with a port or a path (`app.corp.tld:8443`) are not under any reversed prefix. The same fragments on a host are 0.05% of rows.
- A list is counted sequentially (about 22 ms a site; 2,000 ordinary sites take about 45 s).
