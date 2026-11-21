# Site directory: a running list of every site counted, with a login-type breakdown — Design

Date: 2026-11-21
Status: **design approved by the owner on 2026-11-21, not built.** First release: the list, the recording, the page and the on-demand breakdown. The sites in this file are made up (`corp.example`): the owner's lists stay on the owner's machine.
Related: `2026-10-26-site-counts-design.md` (the counts this records), `2026-10-29-site-marks-design.md` (the marks this shows and the host key it shares).

## Why

The Site Counts page keeps nothing between visits: a count is a table in the page's memory and is gone on a reload, and no other table records which sites were ever counted (the audit log holds logins and uploads only). The ask: an extra page right below Site Counts that holds every site that was uploaded and searched, as a running directory that grows with every count batch, ordered by the site count as the Site Counts page orders it, and that shows how a site's logins split into e-mail, phone, user name and anything else.

Of the entry points offered (Site Counts runs, Batch Lookup domain lines, Credentials-page searches for one domain, monitored domains) the owner chose **Site Counts runs** only. Of the three ways to work out the split (inside every count, in a second pass, on demand) the owner chose **on demand, one site at a time**, for the cost measured below.

## What a directory entry is

A **site**, keyed by the host the counts name (`siteEntry`, `lib/site-counts-input.ts`; the key the marks use): `https://www.corp.example/login`, `corp.example` and `*.corp.example` are one entry, `app.corp.example` is its own, a path is ignored. An entry that is not a site address (`NOT_A_SITE`) is not recorded.

An entry holds:

| Part | Meaning |
|---|---|
| first added, last counted, times counted | when the site first appeared; the last request that carried it; how many requests carried it (a site pasted twice in one list is carried once) |
| the last all-time count | rows, on the site, on subdomains, subdomains, top 10 subdomains, and when they were taken; absent until an all-time count of it succeeded |
| the breakdown | e-mail, phone, user name, other: four row counts and when they were taken; absent until the owner asks for it |

A number that was not counted is never stored as a zero and never replaces a stored number.

## How sites get in

Recorded **on the server, at the end of `answerSiteCounts`** (`lib/site-counts.ts`), which both routes share. So the page, a tab closed in the middle of a run and `POST /api/v1/lookup/counts` all feed the directory; the page counts in requests of 20, so each batch lands when it finishes. Recording from the page was rejected: a closed tab loses the sites, and an API run is never seen.

- One transaction per request, one upsert per distinct host: `times_counted + 1`, `last_counted = now`, and the numbers per the rules below.
- **A count with an imported window** (`imported_after` / `imported_before`) adds the new sites and bumps the dates, but writes no numbers, so "Rows" always means all time.
- **A site that failed to count** (too broad, out of time) is still added, with whatever numbers it already had.
- **A host-only result** (`subdomains_counted: false`, the reversed-domain key missing on a part) is stored only when no complete count is stored; it never replaces one.
- **Recording cannot fail a count.** An error is logged with `console.error` and the count is returned as before.
- The recorder is one function (`recordSites`), so Batch Lookup, Credentials-page searches or monitors can call it later; none do now.
- **Seed, once.** No search history exists, so the directory starts empty, except that the sites that carry a mark (66 when this was written) are added once, with no numbers, dated by their mark (guarded by an `app_settings` flag, so a removed site is not added again at the next start).

## The page

`/directory`, sidebar item **Site Directory** directly under **Site Counts**. Session-only, any signed-in user, as Site Counts.

- **The same table as Site Counts**: Site, Mark, Rows, On the site, On subdomains, Subdomains, the click-to-sort headers (`nextSiteSort`, `orderSiteRows`), the mark chips with their numbers and the mark editable in place (`PUT /api/lookup/marks`, as on the counts page). The row detail lists the top subdomains.
- **Order: the most rows first, then the sites with none, then the sites with no number yet.** It is the order of the Site Counts page without its "not counted first" rule, which exists there so a failed site is seen at once after a run and would put the 66 seeded sites at the top here. A column sort works as on the counts page (biggest first, smallest first, back to the default; a site with no number last).
- **New:** a search box (a part of a host, case-insensitive), a "last counted" date, a **Remove** action (a typo or a paste of junk; it comes back, with its history reset, if it is counted again), and the breakdown.
- The marks come with the list (a join on the server), because the marks read takes 2,000 hosts at most and the directory can grow past that. The page loads the whole directory and shows 200 rows at a time ("show more"); revisit this above about 10,000 sites.
- **The breakdown cell.** No breakdown: a **Break down** button (one at a time; the button says it is working). With one: a thin stacked bar of the four parts with the share of each (text labels and numbers, so colour is not the only signal) and, in the row detail, the four counts, "as of <date>, N rows", and a note when the site's rows today are not N. It is stored, so it is asked once per site.

## The breakdown

`login_type` is a stored column (`email`, `phone`, `username`, or empty), so there is no new classification (`lib/login-type.ts`). The four parts are e-mail, phone, user name and **other** (an empty login). The site is the host and every subdomain, the same meaning as the count, found by the same reversed-domain prefix ranges; the query is the counting query with a `countIf` per type.

`POST /api/lookup/directory/breakdown`, body `{ host }`, for a host that is in the directory and that `siteEntry` leaves unchanged. Time limit 20 s as for a count; on a timeout nothing is stored and the answer says "too broad to break down in the time allowed". Without the reversed-domain key on every part it says it is not available (the host-only fallback of the counts is not worth a second meaning here).

### Measured (2026-11-21, the live table, 3.31 B rows, read-only, query cache off)

The breakdown is not folded into the count because of what it cost on the same chunk:

| Query | Plain count | Count + breakdown |
|---|---|---|
| 20 sites from 145 to 7.3 M rows (20.0 M rows in all) | 1.74 s, 49.7 M rows, 0.94 GiB read | 2.93 s and 2.62 s (two runs), 212 M rows, 2.87 GiB read |
| one site of 125 M rows | 1.04 s, 126.8 M rows, 2.56 GiB read | 5.77 s, 1.22 B rows, 18.4 GiB read |

The counts were identical in both (0 mismatches over the 20 hosts and the big one) and the four parts added up to the total on every host. The mix on the 20-site sample: e-mail 56.3%, phone 4.0%, user name 39.7%, other 0.0%. The plain query always ran first, so the breakdown query had the warmer cache against it if anything; the operating system's cache was not dropped (no sudo).

**Not understood, and the first task of the plan:** why reading `login_type` makes the planner read 4 to 10 times the rows (the projection index narrows the plain count to 49.7 M rows, the same ranges with a second column read 212 M). The plan re-measures the single-site shape, with the type counts in a separate pass over the same ranges and with a `PREWHERE`, before settling for 5.8 s on a broad site; a cheaper shape changes what "too broad" means, not the page.

## Storage and routes

- SQLite table `site_directory` in `lib/sqlite.ts` next to `site_marks`: additive (`CREATE TABLE IF NOT EXISTS`), so an image that does not know it ignores it. Not in `site_marks`: a mark is a decision, a directory entry exists without one, and clearing a mark deletes its row.
- `lib/site-directory.ts` (store, recording, seed, the answers) and `lib/site-directory-input.ts` (what the page may import: the types and the pure parts, as `site-marks-input.ts`).
- `GET /api/lookup/directory` (the whole list with marks and breakdowns), `DELETE /api/lookup/directory` (body `{ host }`), `POST /api/lookup/directory/breakdown`. Session only, not on `/api/v1`: an API key has no person, and the directory is read by people. An API run still feeds it.
- `app/directory/page.tsx`; the row is `components/site-count-row.tsx` with the breakdown cell and the date added, not a copy.
- No ClickHouse DDL, no new setting, no new variable for `docker-compose.yml`. The README and `app/docs` say what the page holds and that a windowed count writes no numbers.

## Proof the build must produce

- Unit tests for the store: a first run, a repeat (`times_counted`), a windowed run, a failed site, a host-only result, an entry that is not a site, a spelling variant, remove, the seed and its flag; a failing write that leaves the count unchanged. Mutation-check the rules above.
- The breakdown SQL against a plain full-scan `countIf` on sampled sites of every size band on the live table (read-only, as `__tests__/site-counts.live.test.ts`), and a step in the rehearsal stack (`scripts/e2e-batch-lookup.ts` already covers the counts and the marks).
- The page in the Browser pane on the rehearsal stack at 800 and 1440 px: a count run feeds the directory, order and sorts, search, remove, mark, breakdown button and bar, a failed breakdown.
- Deploy as the repo does: rollback tag first, a candidate under its own tag rehearsed with `REHEARSAL_APP_IMAGE`, `compose up -d --no-deps --no-build app` from the primary checkout.

## Not done

- Recording from Batch Lookup, Credentials-page searches or monitored domains (one function to call when wanted).
- CSV export of the directory, a "count everything again" button, a history of runs, a view per person.
- A breakdown in the Site Counts table or its CSV, a sort by a type's share, and a bulk breakdown. Asked for none; each is a small step on top.
