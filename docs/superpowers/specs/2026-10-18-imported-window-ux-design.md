# Imported window: an always-visible control, links from import jobs, and API parity (2026-10-18)

Status: **implemented and deployed on 2026-10-18.** The decisions below are the owner's answers of 2026-10-18; "Release and result" says what shipped, what was measured and what was left.
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

- **Job link.** A job stamps its rows between its start and its end, so the link carries `after = floor(end - duration) - 1 s` and `before = end + 1 s` (the log row is stamped to the second; the lower bound is exclusive). The window alone is NOT exact: the queue can run jobs side by side (`UPLOAD_CONCURRENCY`, 2 on the machine this was built on), and then a neighbour's rows fall inside it (measured on the 2026-10-17 intake: the window alone matched 7 of 20 jobs, with 24.7M rows of neighbours). The FILE is what makes the link exact: 20 of 20 jobs select exactly the rows they wrote with window plus `source_file`. So a plain `.txt` / `.csv` (or the original name inside an `.archiveref`, which the feeder names `<original>.archiveref`) also pins `source_file`. A ZIP's rows carry its inner file names: it gets the window only, and its tooltip says rows of files imported at the same time can be included.
- **password lookup.** The window is a WHERE predicate: the logins that use this password among the rows added in the window. Plain form (the bloom filter on `password` already prunes).
- **associate.** The window limits where a candidate can come from. The login's own rows and its anchor on a site are always read from the whole table, because they are what identifies the account. Every candidate-producing query (same site and password, same password elsewhere, same handle, handle and password) also returns `max(<window>) AS in_win`, and a candidate qualifies only when at least one row that produced it is in the window (an address implied only by a mail-provider sign-in qualifies through the login's own row at the provider, which the `own` query flags the same way without filtering by it). A window that covers everything therefore gives exactly the unwindowed answer, and the live test pins it. The popularity gates (a password shared by 300+ logins tells nothing; a handle on too many sites is several people) keep reading the UNWINDOWED group, so a narrow window cannot make a common password look rare. Without a window the SQL is byte for byte what it was.
- **summary.** `GET /api/v1/summary?imported_after=..[&imported_before=..]` returns the same shape for a window (`credentials` exact; `unique_domains` and `unique_emails` estimates; `sources` = files imported in the window, from `ulp.sources`; the top 20 domains) plus the effective `imported_after` / `imported_before`. A lower bound is required: an upper bound alone is the whole table up to a date, which is the 28 s scan the table-wide summary runs in the background, and a per-request scan like that is what the cache exists to avoid. Results are cached per window (2 minutes while the window is open at the top, 10 minutes once its upper bound is more than 10 minutes old; 32 windows) and concurrent identical requests share one query. The aggregate shape lets the planner use the projection form, so a day takes tenths of a second.

## Verification plan

Pure helpers with injected time zones (a DST day included); the client URL reader against the server parser on a table of inputs; route tests for the three endpoints; live parity (read-only, on the real table) for each of them against the same question asked without the window; the popover and the links driven in a browser on the isolated rehearsal stack with test data; the whole suite, both typechecks, lint, build; the usual rollback tag and a local deploy.

## Release and result (2026-10-18)

**Release 1.** Merged to `main` by fast-forward (`99b19e5` .. `7139f8d`, 29 files, +2,151 / -188) and deployed locally the same evening while no import was queued or running: `ulp-suite-app:latest` became image `82057bfed7f9`; the image it replaced (`5aa70e386777`, the fast-ingest Step A release) is tagged `ulp-suite-app:rollback-20261018-2045z`. No schema, projection, index or data change, so the rollback is the previous image. Only the app container was recreated (`--no-deps`); ClickHouse stayed up. CI (`verify`: typecheck of the app, `scripts/` and `__tests__/`, test, lint, build) passed on `7139f8d`. Locally: 3,887 tests pass (89 skipped, the live files among them), both typechecks and lint clean.

**Live proof, read-only, on the 1.87B-row table** (`__tests__/imported-window-api.live.test.ts`, `IWA_LIVE=1`; it prints counts and timings only):
- `v1/summary` for a window equals an independent plain query over the same bounds (credentials, top 20 domains, source count); the estimates are within 3% of the exact distinct counts. A 34M-row window answers in 1.1 s against 4.5 s for the plain form, a 4M-row window in 0.2 s against 0.4 s.
- `lookup/password` in a window finds exactly the logins an independent query finds there, a subset of the unwindowed answer.
- `lookup/associate`: a window that covers everything reproduces the unwindowed answer exactly; a window in the future finds nothing; a window in the middle only narrows. The first run of this test failed (addresses implied by a mail-provider sign-in dropped out under a covering window); flagging the login's own row at the provider fixed it.
- "View what this added": for the 20 import jobs since 2026-10-17 the window plus the file selects exactly the rows each job wrote (20 of 20). The window alone matched 7 of 20: the queue runs two jobs side by side (`UPLOAD_CONCURRENCY=2`) and 24.7M rows of neighbours fell inside the windows.

**Browser, on the isolated rehearsal stack** (the deployed image, synthetic files, no live data). First pass, Credentials: the pill in the chips row, a preset that searches at once, typed dates on Enter and on closing, Escape and an invalid range dropped, a reload that restores the window from the address, the Inbox links. Second pass: Lookup (the batch body carries `imported_after`, and `imported_before` once typed), the Breaches export (both bounds), the Upload page links (right window and file, and a link opens exactly that job's rows), the light theme, a 375 px phone width.

**Release 2: four layout defects the second pass found (`f840fc7`).** Measured before the change, fixed and measured again after it:

| defect | before | after |
|---|---|---|
| popover taller than a short window | 451 px tall at a 768 px high window; Apply and Clear at y 792 to 820, below the visible area, on a fixed layer the page cannot scroll to | capped at the 378 px Radix measures, scrolls inside, Clear and Apply pinned to its bottom edge and in view |
| popover against the screen edge at 375 px | flush with the right edge | 8 px margin (`collisionPadding`) |
| Breaches export row at 375 px | pill on two lines, "user:pass" and "ULP" past the card edge | pill on one line, buttons wrap inside the card, no horizontal overflow |
| job-link icon | 12 px hit area | 20 x 20 px, the row does not move |

Built from `f840fc7` (CI `verify` green; 3,891 tests pass locally) and deployed the same evening with the queue idle, app container only: `ulp-suite-app:latest` is image `143ade4b35c7`; the image it replaced (release 1, `82057bfed7f9`) is tagged `ulp-suite-app:rollback-20261018-2108z`. On the container: healthy, no errors in the startup log, the new popover rule in the client bundle. The live job-links test also stopped leaving a copy of the app's database in `/tmp` (`0bb8246`).

**Found and left alone.** The "Breach..." filter on the Credentials page sits in a row that does not wrap and overflows a 375 px screen (it made the emulated phone zoom out to 526 px); it is not part of this change. `/credentials?breach=<name>` links from the Breaches pages still open the unfiltered browser, because the page reads no `breach` parameter; the three window parameters and `source_file` are the only ones it reads.

**Not verified.** The deployed app itself was not driven in a browser (the pane is not signed in to it, and only the owner can sign in). On the deployed container: healthy, no errors in the startup log, the schema migration skipped as already applied, both new UI strings in the bundle, and `v1/summary` answers 401 without a key.
