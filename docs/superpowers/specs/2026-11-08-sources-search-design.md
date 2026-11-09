# Sources search: type a file name and see whether it was already ingested — design (2026-11-08)

Date: 2026-11-08
Status: **Approved by the owner 2026-11-08, being built.** Read-only feature: no table, no DDL, no setting.
Related: `2026-11-07-file-ledger-design.md` (the ledger the answer comes from), `2026-11-07-download-mover-design.md` (the stand-in and the "check before downloading" tools).
File names, search terms and credential values are deliberately absent (the repository is public); the tests use placeholders.

## Why

Before downloading a file from a chat the owner wants to know whether it was already ingested. The Sources page lists `ulp.sources` 50 names at a time and cannot be searched. `ulp.sources` is also not the whole answer: the job log knows files the ledger does not (files processed before the ledger existed, files the quality gate held, files that failed), so a search over `ulp.sources` alone would say "not found" for a file that was in fact processed.

Measured 2026-11-08: `ulp.sources` 1,069 rows / 1,066 names (865 with a size, 864 with a hash); the job log 1,368 names (17 with a held job, 163 with a failed job). The existing per-page credential count (`source_file IN (50 names)` over `ulp.credentials`) took 7.4 s, too slow for search as you type.

## What the owner sees

A search box under the heading ("Check a file name before you download it"). Typing (after a 300 ms pause) or Enter searches; a clear button returns to the list. The results are the same cards as the list, plus:

- a **status badge**: *Ingested* (a row in `ulp.sources`), *Processed earlier* (the job log finished it, no `ulp.sources` row: from before the ledger), *Held* (the quality gate stopped it, waiting for a decision), *Failed* (its import failed and no run finished it);
- the **size** in bytes (when `ulp.sources` recorded it) so it can be compared with the size the chat client shows: two files can share a name and differ in content;
- the date, shown in the browser's own time zone (the list showed ClickHouse's UTC string as if it were local time; fixed for both modes).

No match: *"No file with 'x' in its name has been ingested or processed."* with one line saying the importer also skips identical bytes under any name, so a re-download of a known file adds nothing.

## Matching

Case-insensitive "contains" on the whole name (`mansory3` finds `mansory3 (2).txt` and the re-feed variants). `%` and `_` are plain characters (no LIKE). The query is trimmed; fewer than 2 characters is the normal list. At most 200 characters.

## How

- `GET /api/sources?q=…` (same route; no `q` is the list as before). With `q`: ClickHouse `positionCaseInsensitiveUTF8(filename, {q:String}) > 0` over `ulp.sources`, grouped by name as the list does (`argMax` by `imported_at`; aliases differ from the column names, see the comment in the route); the job log read from SQLite (`processing_jobs`) and matched in JS with the same case folding. Both sets are tiny (about 1,000 names each), so the merge and the paging (50 a page) happen in the route.
- `lib/sources-search.ts` (pure): `normalizeQuery`, `matchesName`, `mergeHits`. Priority per name: *Ingested* (a `ulp.sources` row) over *Processed earlier* (any finished job) over the latest unfinished job (*Held*, *Failed*). A job named like an archive reference (`….archiveref`) stands for the file it points at (as `lib/ledger-export.ts` does).
- While searching the per-page credential count is skipped (the question is "was it ingested", not "how many credentials"); the plain list keeps it.
- The page: an `Input`, a debounce, an `AbortController` so a slow earlier answer never overwrites a newer one, the badge, the size (`formatBytes`).

## Proof

Unit tests for the three pure functions and for the route's use of them; the exact ClickHouse statement run on the live ClickHouse and on the isolated rehearsal stack; the built image driven in the Browser pane on the rehearsal stack (type, clear, no match, a name only in the job log); then the usual deploy with a rollback tag.

## Left out (cheap to add later)

A size input box; pasting a whole chat export (`scripts/ledger-check.ts` does that from a terminal); searching by content hash.
