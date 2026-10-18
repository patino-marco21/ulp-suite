# Imported window: an always-visible control, links from import jobs, and API parity (2026-10-18)

Status: IN PROGRESS. The decisions below are the owner's answers of 2026-10-18; "Release and result" is filled in when it ships.
Builds on `2026-10-05-imported-after-filter-design.md`: the semantics (`imported_after` EXCLUSIVE, `imported_before` INCLUSIVE, UTC), the SQL forms and the plan rule are unchanged.

## The problem

- On the Credentials page the window is two date-time fields inside "Advanced", closed by default. Nobody finds a filter they have to open a drawer for.
- The Lookup and Breaches pages show only "after", although the API takes both.
- Three endpoints return rows or numbers derived from `ulp.credentials` and ignore the window: `v1/lookup/associate`, `v1/lookup/password`, `v1/summary`.
- After an import, "what did this file add?" has no one-click answer: the job list and the browser do not know each other.

## Decisions (owner, 2026-10-18)

1. **Layout: a pill with a popover** in the filter chips row of the Credentials page (left of "Advanced", like Country tier). The pill says what is active ("Imported: any time", "Imported: last 24 h", "Imported: Oct 17 00:00 → Oct 18 11:55"). The popover holds the presets, both fields (local time, with the UTC instant under each), Clear and Apply. The same component serves the Lookup and Breaches pages, with both bounds.
2. **When it runs:** a preset runs the search at once. Typed dates run on Enter, on Apply, and when the popover closes with a changed, valid value; Escape drops the edit. The page's Apply button still works.
3. **Presets:** Today, Yesterday, Last 24 h, Last 7 days, Last 30 days, and Since last export (Credentials page only, as before). "Today" and "Yesterday" are calendar days in the browser's time zone and are written so that the exclusive lower bound keeps the first second of the day (lower = midnight − 1 s, upper = next midnight − 1 s). No "Latest import" preset.
4. **URL:** the Credentials page reads `imported_after`, `imported_before` and `source_file` from its address when it opens, and keeps the first two (and `source_file`) in the address as the search changes, so a window can be bookmarked. Each finished import job with new rows, on the Inbox and Upload pages, links to `/credentials?imported_after=..&imported_before=..&source_file=..` ("View what this added").
5. **API:** `imported_after` / `imported_before` on `v1/lookup/associate`, `v1/lookup/password` (JSON body) and `v1/summary` (query string). Errors name the parameter, exactly as on `v1/lookup`.
6. **Not done, on purpose:** `/api/check` and `/api/related` (a window changes what they answer), monitors (their own "new since last view" ledger), the Sources and Domains pages, the monitor matches list, a "Latest import" preset.

## Semantics worth writing down

- **Job link window.** A job's rows are stamped between its start and its end, and jobs run one at a time. The link carries `after = floor(end - duration) - 1 s` and `before = end + 1 s` (the log row is stamped to the second), plus `source_file = the file name` for plain `.txt` / `.csv` files, which removes any bleed from the neighbouring job. ZIP and `.archiveref` jobs get the window only: their rows carry the inner file names.
- **password lookup.** The window is a WHERE predicate: the logins that use this password among the rows added in the window. Plain form (the bloom filter on `password` already prunes).
- **associate.** The window limits where a candidate can come from. The login's own rows and its anchor on a site are always read from the whole table, because they are what identifies the account. Every candidate-producing query (same site and password, same password elsewhere, same handle, handle and password) also returns `max(<window>) AS in_win`, and a candidate qualifies only when at least one row that produced it is in the window. The popularity gates (a password shared by 300+ logins tells nothing; a handle on too many sites is several people) keep reading the UNWINDOWED group, so a narrow window cannot make a common password look rare. Without a window the SQL is byte for byte what it was.
- **summary.** `GET /api/v1/summary?imported_after=..[&imported_before=..]` returns the same shape for a window (`credentials` exact; `unique_domains` and `unique_emails` estimates; `sources` and `source_lines` from `ulp.sources`; the top 20 domains) plus `window`. A lower bound is required: an upper bound alone is the whole table up to a date, which is the 28 s scan the table-wide summary runs in the background, and a per-request scan like that is what the cache exists to avoid. Results are cached per window (2 minutes while the window is open at the top, 10 minutes once its upper bound is more than 10 minutes old; 32 windows) and concurrent identical requests share one query. The aggregate shape lets the planner use the projection form, so a day takes tenths of a second.

## Verification plan

Pure helpers with injected time zones (a DST day included); the client URL reader against the server parser on a table of inputs; route tests for the three endpoints; live parity (read-only, on the real table) for each of them against the same question asked without the window; the popover and the links driven in a browser on the isolated rehearsal stack with test data; the whole suite, both typechecks, lint, build; the usual rollback tag and a local deploy.

## Release and result

(filled in when it ships)
