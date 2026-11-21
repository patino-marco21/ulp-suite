# Site directory: a running list of every site counted, with a login-type breakdown — Design

Date: 2026-11-21
Status: **design approved by the owner on 2026-11-21 and revised the same day twice: an endless list (see The page) and a directory that stays current after every ingest (see Staying current); the revisions await the owner's review; not built.** First release: the list, the recording, the page and the on-demand breakdown. The sites in this file are made up (`corp.example`): the owner's lists stay on the owner's machine.
Related: `2026-10-26-site-counts-design.md` (the counts this records), `2026-10-29-site-marks-design.md` (the marks this shows and the host key it shares).

## Why

The Site Counts page keeps nothing between visits: a count is a table in the page's memory and is gone on a reload, and no other table records which sites were ever counted (the audit log holds logins and uploads only). The ask: an extra page right below Site Counts that holds every site that was uploaded and searched, as a running directory that grows with every count batch, ordered by the site count as the Site Counts page orders it, scrolling without end as the Credentials page does, and that shows how a site's logins split into e-mail, phone, user name and anything else.

The owner described it as a hub and a running tally of everything researched and uploaded, sorted from most rows to fewest, holding what the Site Counts rows hold (the subdomain count and the top subdomains), and **kept up to date after each count batch or upload and whenever new files are ingested**, in case a number changes.

Of the entry points offered (Site Counts runs, Batch Lookup domain lines, Credentials-page searches for one domain, monitored domains) the owner chose **Site Counts runs** only. Of the three ways to work out the split (inside every count, in a second pass, on demand) the owner chose **on demand, one site at a time**, for the cost measured below. They then asked that clicking a site shows its count and its split, so **opening a row is the demand** (see The page).

## What a directory entry is

A **site**, keyed by the host the counts name (`siteEntry`, `lib/site-counts-input.ts`; the key the marks use): `https://www.corp.example/login`, `corp.example` and `*.corp.example` are one entry, `app.corp.example` is its own, a path is ignored. An entry that is not a site address (`NOT_A_SITE`) is not recorded.

An entry holds:

| Part | Meaning |
|---|---|
| first added, last counted, times counted | when the site first appeared; the last request that carried it; how many requests carried it (a site pasted twice in one list is carried once) |
| the last all-time count | rows, on the site, on subdomains, subdomains, top 10 subdomains, and when they were taken; absent until an all-time count of it succeeded |
| the breakdown | e-mail, phone, user name, other: four row counts and when they were taken; absent until the owner asks for it |
| the stale markers | the fingerprint of the live table (below) read just before the count was made, and the same for the breakdown; a site whose marker is not the table's present fingerprint is out of date |

A number that was not counted is never stored as a zero and never replaces a stored number.

## How sites get in

Recorded **on the server, at the end of `answerSiteCounts`** (`lib/site-counts.ts`), which both routes share. So the page, a tab closed in the middle of a run and `POST /api/v1/lookup/counts` all feed the directory; the page counts in requests of 20, so each batch lands when it finishes. Recording from the page was rejected: a closed tab loses the sites, and an API run is never seen.

- One transaction per request, one upsert per distinct host: `times_counted + 1`, `last_counted = now`, and the numbers per the rules below.
- **A count with an imported window** (`imported_after` / `imported_before`) adds the new sites and bumps the dates, but writes no numbers, so "Rows" always means all time.
- **A site that failed to count** (too broad, out of time) is still added, with whatever numbers it already had and the reason, kept with the marker so the refresh does not try it again until the table changes.
- **The fingerprint is read before the counting** (one metadata query per request, milliseconds), so rows that arrive during a count leave the site out of date for the next refresh. If it cannot be read the marker is empty and the next refresh counts the site again.
- **A host-only result** (`subdomains_counted: false`, the reversed-domain key missing on a part) is stored only when no complete count is stored; it never replaces one.
- **Recording cannot fail a count.** An error is logged with `console.error` and the count is returned as before.
- The recorder is one function (`recordSites`), so Batch Lookup, Credentials-page searches or monitors can call it later; none do now.
- **Seed, once.** No search history exists, so the directory starts empty, except that the sites that carry a mark (66 when this was written) are added once, with no numbers, dated by their mark (guarded by an `app_settings` flag, so a removed site is not added again at the next start). The first refresh (below) counts them, so they do not stay at the bottom with no number.

## Staying current

A count is a snapshot and the table changes: an import adds rows, a delete or the content dedup removes them. So the directory refreshes itself, on the signal the search dictionary already uses (`lib/search-dictionary-cron.ts`, `readLiveState` in `lib/search-dictionary.ts`): the **fingerprint of the live table**, a hash of the table's uuid, the rows and block range of every partition, and the content mutations. It changes on an import, a delete, a dedup and a partition swap; it does not change on a merge (a merge keeps a partition's rows and block range) or on the daily projection maintenance.

- **Out of date** means: never counted all-time (the seeded sites, a site first seen in a windowed run), or the marker stored with its numbers is not the table's present fingerprint.
- **The tick** is `lib/site-directory-cron.ts`, production only, started from `instrumentation.ts` like the others, one tick every `SITE_DIRECTORY_CRON_MINUTES` (default 10; 0 switches it off), and a tick never overlaps the last. With nothing out of date it costs one SQLite query and one metadata query. Otherwise it behaves like the dictionary tick: it waits while an import is queued or running (`queueSize()`), while a content mutation runs, and until the fingerprint has stayed the same for `SITE_DIRECTORY_SETTLE_SECONDS` (default 120), because a big file commits minutes apart and a quiet moment inside a batch would be out of date on arrival.
- **The refresh** recounts the out-of-date sites, most rows first, 100 at a time through `countSites` (so the chunks of 20, the time limit and the too-broad fallback are the ones of the counts), and stores each answer with the fingerprint read before counting. It stops at once when an import starts and carries on at the next tick. A site that is too broad for the time limit stores that reason and is not tried again until the table changes. A failure backs off as the dictionary cron does (three in a row wait an hour).
- **A breakdown that exists is refreshed too**, after the counts, one site at a time with the breakdown's own 20 s limit, for the out-of-date sites only. A site with no breakdown never gets one from the tick: opening its row stays the only demand.
- **Cost.** The counts take about 22 ms a site (the 102-site list took 1.8 s, `2026-10-26-site-counts-design.md`), so a directory of 1,000 sites is about 22 s of reads after each settled batch, plus a second or two for each very broad site; a refreshed breakdown is about 0.1 s for an ordinary site and for a 110 M-row one alike (Measured, below). Nothing runs while an import does. At about 20,000 sites a full pass after every change would take minutes; the way out is to recount only the sites that occur in the new rows, which is neither measured nor built.
- **What you see.** Each row's detail says when its numbers were taken. The line above the list says "N sites · numbers current", "waiting for imports to settle: N sites will be recounted" or "refreshing: N sites are older than the last import". While anything is out of date the page asks `GET /api/lookup/directory/status` every 30 s (the visible tab only). New numbers never move under the cursor: when a refresh has finished the line offers **Reload the list**, which fetches page one again.
- **Two new settings**, `SITE_DIRECTORY_CRON_MINUTES` and `SITE_DIRECTORY_SETTLE_SECONDS`, forwarded by name in `docker-compose.yml` (the app sees only what compose forwards), in `.env.example` and in the README.

## The page

`/directory`, sidebar item **Site Directory** directly under **Site Counts**. Session-only, any signed-in user, as Site Counts.

- **The same table as Site Counts**: Site, Mark, Rows, On the site, On subdomains, Subdomains, the click-to-sort headers (`nextSiteSort` for the click cycle; the ordering itself is done by the server, see below), the mark chips with their numbers and the mark editable in place (`PUT /api/lookup/marks`, as on the counts page). The row detail is the Site Counts row's: the number of subdomains and the top 10 subdomains with their rows (the page shows ten, not five; the count stores ten).
- **Order: the most rows first, then the sites with none, then the sites with no number yet.** It is the order of the Site Counts page without its "not counted first" rule, which exists there so a failed site is seen at once after a run and would put the 66 seeded sites at the top here. A column sort works as on the counts page (biggest first, smallest first, back to the default; a site with no number last).
- **New:** a search box (a part of a host, case-insensitive), a "last counted" date, a **Remove** action (a typo or a paste of junk; it comes back, with its history reset, if it is counted again), and the breakdown.
- **An endless list, as the Credentials page has (asked by the owner on 2026-11-21, "for all of this").** The page loads the first 200 sites and appends the next 200 when the end of the list comes within 1,500 px of the bottom of the scroller; there is no pager and no "show more" button. The machinery is shared, not copied: `LOAD_AHEAD_PX`, `AUTO_LOAD_ROW_CAP` (5,000 rows, then a **Load the next rows** button), `shouldAutoLoad`, `listFooter` and `scrollParentOf` from `lib/credential-pages.ts`, and the line under the rows (loading with the seconds it has taken and a Stop button, Retry after an error, "N sites loaded · scroll for more", "N sites · end of the directory"). That line is `ListFooterLine` in `app/credentials/page.tsx` today; it moves to a component both pages import, with the noun ("rows" / "sites") and the "a rare search scans the whole table" hint as props, and the Credentials page's text stays byte for byte what it is. The observer is rooted on the real scroller (`scrollParentOf`): the Credentials page's first version rooted it on the table's own box, which grows with its rows, and fetched every page at once (found only by driving the page in a browser, see Proof).
- **So the server pages, sorts and filters.** The page never holds the whole directory, so `orderSiteRows`, the search and the mark chips cannot run in it; they run in SQLite, with the rules above (a column sort: the number, biggest or smallest first, a site with no number last, ties by the default order, then the host; the Mark column by `markRank`). The marks come with each page (a join), because the marks read takes 2,000 hosts at most.
- **Paging is `LIMIT 200 OFFSET n`, not a keyset cursor.** A cursor was what ClickHouse needed (`lib/cursor-pagination.ts`); SQLite sorts the whole directory for every page in milliseconds. Indicative, on 100,000 synthetic sites (SQLite 3.46, in memory, no index): the first page ordered by rows 43 ms, the page at offset 20,000 100 ms, at 99,800 171 ms, a search 19 ms, a sort by mark 47 ms, the mark chip counts 63 ms; the build re-measures it on the app's own SQLite. A site added between two pages (a count run in another tab) can shift the offset, so the page ignores a host it already shows: none appears twice, and a reload reads the list as it is.
- **The search box and the chips replace the list**: a typed search waits a moment, then fetches page one and scrolls back to the top; a chip, a sort or a clear does the same, and an answer for a search that is no longer on screen is dropped (the Credentials page's `searchRef` rule). The number on each chip is for the current search and arrives with the first page, as the totals do on the Credentials page.
- **An edit changes the row on screen and nothing else**: a mark, a breakdown or a removal updates its row in place; the row keeps its position and its chip until the list is next loaded, and the chip numbers update at once.
- **Clicking a site opens its detail (asked by the owner on 2026-11-21), which shows the site count and the breakdown.** The whole row is the target and the chevron is the keyboard's button, as on Site Counts (`SiteRow`); every directory row opens, not only those with rows, and the detail says what is true of it. It holds:
  - **The count**: rows on the site and on its subdomains with the total, the number of subdomains and the top 10 with their rows (as the Site Counts detail), and "as of <date>".
  - **The breakdown**: a bar of the four parts, e-mail, phone, user name and other, each with its count and share (text labels and numbers, so colour is not the only signal), "as of <date>, N rows", and a note when the site's rows today are not N. **If none is stored, opening the row works it out** ("working out the split…", with a note after a few seconds that a very broad site takes several), and stores it, so it is asked once per site; closing the row does not cancel it. A failure ("too broad to break down in the time allowed") stays in the detail with a **Try again**.
  - **The rest of what the directory knows**: first added, last counted, times counted, the mark and its note (editable, as in the row), a **Recount** (the same count as the page, for this one site, so the detail is current without waiting for the refresh; it also redoes a stored breakdown) and **Remove**.
  - **Edge cases**: a site counted at 0 rows says "no rows" and makes no breakdown query; a site with no number yet says "not counted yet, the next refresh counts it" and may still be broken down; a site the refresh found too broad shows the reason.
  - In the list, a stored breakdown also shows as a thin bar in the row (wide windows only), so a scan of the directory shows the splits that have been opened; a site not yet opened shows nothing there. There is no per-row button.

## The breakdown

`login_type` is a stored column (`email`, `phone`, `username`, or empty), so there is no new classification (`lib/login-type.ts`). The four parts are e-mail, phone, user name and **other** (an empty login). The site is the host and every subdomain, the same meaning as the count, found by the same reversed-domain prefix ranges; the query is the counting query with a `countIf` per type.

`POST /api/lookup/directory/breakdown`, body `{ host }` (the result is stored whether or not the page is still waiting), for a host that is in the directory and that `siteEntry` leaves unchanged. It is called when a row with no stored breakdown is opened, and by Try again, Recount and the refresh tick. At most two breakdown queries run at once in the app (a third waits), because a closed connection does not stop a ClickHouse query and a quick run of clicks on broad sites would otherwise pile up reads. Time limit 20 s as for a count; on a timeout nothing is stored and the answer says "too broad to break down in the time allowed". Without the reversed-domain key on every part it says it is not available (the host-only fallback of the counts is not worth a second meaning here).

### Measured (2026-11-21, the live table, 3.31 B rows, read-only, query cache off)

The breakdown is not folded into the count because of what it cost on the same chunk:

| Query | Plain count | Count + breakdown |
|---|---|---|
| 20 sites from 145 to 7.3 M rows (20.0 M rows in all) | 1.74 s, 49.7 M rows, 0.94 GiB read | 2.93 s and 2.62 s (two runs), 212 M rows, 2.87 GiB read |
| one site of 125 M rows | 1.04 s, 126.8 M rows, 2.56 GiB read | 5.77 s, 1.22 B rows, 18.4 GiB read |

The counts were identical in both (0 mismatches over the 20 hosts and the big one) and the four parts added up to the total on every host. The mix on the 20-site sample: e-mail 56.3%, phone 4.0%, user name 39.7%, other 0.0%. The plain query always ran first, so the breakdown query had the warmer cache against it if anything; the operating system's cache was not dropped (no sudo).

**Settled by the build (2026-11-21):** the folded query read 4 to 10 times the rows because the 20-site shape reads `login_type` for every granule the ranges leave. The single-site query does not have to: `SELECT login_type, count() ... GROUP BY login_type` with the reversed-domain ranges in `PREWHERE` reads `login_type` only for the granules the ranges keep. Measured on the live table (3.31 B rows, read-only), six sites from a few hundred rows to 110 M, 12 runs of each shape in the order V0, V1, V2, V0, V1, V2: V0 (four `countIf`, the shape measured above) 344 ms on average (slowest 3,383 ms), 15.9 M rows read; V1 (`GROUP BY` in `WHERE`) 276 ms (2,692 ms), 15.4 M rows; **V2 (`GROUP BY` with `PREWHERE`) 54 ms (109 ms), 2.6 M rows, 41 MiB**. The rule written down before looking was "PREWHERE if it reads at least 25% fewer rows": 83% fewer, so V2 ships. The three shapes returned identical splits for all six sites. Parity (`BLK_LIVE=1 npx vitest run __tests__/site-directory.live.test.ts`): five sites sampled from recent rows each equal a plain full scan (no projection, no index) and add up to the count query's number, in 70 to 151 ms; the 110 M-row site's three parts equal a full scan to the row. So a split costs about 0.1 s even on the broadest site, not the 6 s the folded shape suggested.

## Storage and routes

- SQLite table `site_directory` in `lib/sqlite.ts` next to `site_marks`: additive (`CREATE TABLE IF NOT EXISTS`), so an image that does not know it ignores it. Not in `site_marks`: a mark is a decision, a directory entry exists without one, and clearing a mark deletes its row.
- `lib/site-directory-cron.ts` (the refresh tick above) and the two settings.
- `lib/site-directory.ts` (store, recording, seed, the answers) and `lib/site-directory-input.ts` (what the page may import: the types and the pure parts, as `site-marks-input.ts`).
- `GET /api/lookup/directory?sort=<key>&dir=desc|asc&q=<text>&mark=all|done|skip|todo|none&offset=<n>&limit=<at most 200>` -> `{ success, sites, next_offset (null at the end), total (the sites matching the search and chip; null after the first page), marks (the number each chip shows; null after the first page) }`, a site carrying its numbers, its mark and its breakdown. `DELETE /api/lookup/directory` (body `{ host }`), `POST /api/lookup/directory/breakdown`, `GET /api/lookup/directory/status` -> `{ total, out_of_date, state: 'current' | 'waiting' | 'refreshing', refreshed_at }`. The search is a case-insensitive substring of the host with `%`, `_` and the escape character escaped, so a typed `_` is a letter. Session only, not on `/api/v1`: an API key has no person, and the directory is read by people. An API run still feeds it.
- `app/directory/page.tsx`; the row is `components/site-count-row.tsx` with a detail that adds the breakdown, the dates, Recount and Remove (a prop, so the Site Counts page is unchanged), not a copy.
- No ClickHouse DDL, no new setting, no new variable for `docker-compose.yml`. The README and `app/docs` say what the page holds and that a windowed count writes no numbers.

## Proof the build must produce

- Unit tests for the store: a first run, a repeat (`times_counted`), a windowed run, a failed site, a host-only result, an entry that is not a site, a spelling variant, remove, the seed and its flag; a failing write that leaves the count unchanged. Mutation-check the rules above.
- The breakdown SQL against a plain full-scan `countIf` on sampled sites of every size band on the live table (read-only, as `__tests__/site-counts.live.test.ts`), and a step in the rehearsal stack (`scripts/e2e-batch-lookup.ts` already covers the counts and the marks).
- The refresh tick is tested with its dependencies injected, as `__tests__/search-dictionary-cron.test.ts` tests the dictionary's: nothing out of date; an import running; the fingerprint moving during the settle wait; a mutation running; a never-counted site counted; a site recounted after the fingerprint changed; the marker stored is the one read before counting; an import starting mid-refresh stops it; a too-broad site not retried until the fingerprint changes; an existing breakdown refreshed and a missing one not created; the back-off.
- The refresh is proved end to end on the rehearsal stack (`scripts/e2e-site-directory.ts`): count a synthetic site, import a file that adds rows for it and for one of its subdomains, shorten the settle wait, and the directory's rows, host and subdomain numbers equal a fresh count; a stored breakdown moves with it; a delete (a mutation) does the same.
- The order is the Site Counts page's: a test sorts random directories (ties, zeros, missing numbers, every mark) in SQLite and compares the rows, key by key and direction by direction, with `orderSiteRows` as the oracle, adding the host as the final tie-break; the paging test walks a directory page by page and gets every site once, in that order.
- The endless list is proved in a browser, because a unit test cannot see the scroller: a synthetic directory of about 1,000 sites seeded into the rehearsal stack's SQLite, then in the Browser pane one page loads at the start, one more per scroll to the end (not every page at once: the Credentials page's first observer did that), the footer line follows each state, a search and a sort scroll back to the top, and Stop and Retry work. The Credentials page is checked once as well, because its footer moved: its text is pinned by a test and looked at.
- The page in the Browser pane on the rehearsal stack at 800 and 1440 px: a count run feeds the directory, order and sorts, search, remove, mark, a click on a site opens its count and its split, a row with no stored split works it out on opening and keeps it after a reload, a very broad site shows the working note, three quick clicks on broad sites run two at a time, a failed breakdown and Try again, Recount, and the edge cases (no rows, not counted yet).
- Deploy as the repo does: rollback tag first, a candidate under its own tag rehearsed with `REHEARSAL_APP_IMAGE`, `compose up -d --no-deps --no-build app` from the primary checkout.

## Not done

- Recording from Batch Lookup, Credentials-page searches or monitored domains (one function to call when wanted).
- A button that recounts the whole directory at once (one site has Recount in its detail), and recounting only the sites that occur in the new rows (needed only near 20,000 sites).
- CSV export of the directory, a "count everything again" button, a history of runs, a view per person.
- A breakdown in the Site Counts table or its CSV, a sort by a type's share, and a bulk breakdown. Asked for none; each is a small step on top.
