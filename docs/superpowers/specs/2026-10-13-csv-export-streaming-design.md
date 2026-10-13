# CSV export beyond 10,000 rows — Design

Date: 2026-10-13
Status: **implemented on 2026-10-13** (plan `docs/superpowers/plans/2026-10-13-csv-export-streaming.md`). The owner approved the design in chat on 2026-10-13 and chose the direct streamed download over a background file. One detail is a refinement of what was presented (the response starts when ClickHouse has its first rows, not before). The repository is public: this file holds numbers only, never real addresses, file names or search terms.

## Why

The owner's data use is the web search and CSV exports (parser v6 spec, "Owner's decisions"), and on 2026-10-12 they asked to raise the 10,000-row export cap to about 1,000,000 rows and stream the file. Today `app/api/export/route.ts` answers `csv`, `ulp`, `userpass`, `ndjson` and `json` by running one query, holding every row in memory, building one string and sending it with `X-Export-Rows` and `X-Export-Truncated`. A million rows would be about a gigabyte of JavaScript objects and strings inside the one Node process that also serves every search (container limit 8 GiB, heap 6 GiB). `emails`, `domains`, `wordlist`, `spray` and `hcmask` already stream or aggregate and are not touched.

## Measurements (2026-10-13, 1.84B rows, the export's 16 columns, output discarded, caches off)

| 1,000,000 rows | Server time |
|---|---|
| One big site (`domain = x`, primary-key prefix), newest first | 1.2 s |
| An e-mail domain with about 500M rows, in the table's own order | 4.3 s |
| A whole-word login search (390k rows), newest first | 63.6 s |
| An e-mail domain with about 500M rows, newest first | 137.7 s |

The time depends on the sort and the term, not on the row count: a newest-first export of a broad term sorts everything it matches. A CSV row averages 225 bytes (measured on a 1M-row sample), so a full file is about 215 MiB. The server's default `max_execution_time` is 3600 s, `max_memory_usage` is 0, and `send_timeout` is 300 s (a client that stops reading for 300 s breaks the stream).

## What the owner sees

* `csv`, `ulp` (url:login:password), `userpass` (login:password) and `ndjson` export up to **1,000,000 rows**. `json` stays at 10,000 rows (a pretty-printed array of a million objects is not a useful file); the toast says so.
* The Export button reads "Preparing…" until the first rows arrive, then a live row count. The file is saved when the stream ends.
* If the count reached the cap, the toast says the export stopped at that many rows and that "Since last export" was not moved. This is today's rule with the real cap.

## Server

* `lib/export-stream.ts` (new, no server-only imports): `EXPORT_ROW_CAP = 1_000_000`, `JSON_EXPORT_ROW_CAP = 10_000`, the pure line formatters (`csvHeaderLine`, `exportLine(format, row, guard)`, using `csvCell` for the formula guard) and `createExportStream(batches, { format, guard, cap })`, which returns a pull-based `ReadableStream<Uint8Array>`: the CSV header first, one newline-terminated line per row, a chunk per batch, nothing queued beyond one chunk, and `cancel()` stops reading the source. It stops after `cap` rows.
* The route builds the same SQL as today (inner `RAW_COLS` query with `ORDER BY`, the dedupe `LIMIT 1 BY` and `LIMIT cap`, outer `NORM_COLS`) with `SETTINGS max_execution_time = 600, max_bytes_before_external_sort = 4 GiB` plus `NORM_COLS_SETTING`. It runs it through `getClient().query({ format: 'JSONEachRow', abort_signal: request.signal })` and feeds `resultSet.stream()` to `createExportStream`.
* **Refinement of the presented design:** the response is created after the query has started answering, so a query that fails (memory, timeout) returns a clean HTTP 500 `{ success: false, error }` and not a broken file. The page shows "Preparing…" meanwhile. A failure after the first rows errors the stream; the page discards the partial file and reports it.
* Headers of a streamed export: `Content-Type`, the same `Content-Disposition` file name, `X-Export-Cap`, and the imported-window headers (`importedWindowHeaders`). `X-Export-Rows` and `X-Export-Truncated` cannot be known before the body and are not sent; `json` keeps the old in-memory path and all its headers.
* Closing the tab aborts the ClickHouse query through the request signal, so a two-minute sort does not keep running.
* The scope and every other filter work as they do now (the SQL is unchanged); the range planner and `exclude_noise` are untouched.

## Page

* `doExport` reads the body with a reader when the response has `X-Export-Cap`: it counts newline bytes per chunk (the importer splits on lines, so no field holds a newline; if one ever did, the count could only go up, which errs on the safe side of not moving the mark), keeps the chunks for the Blob, and shows the running count. Rows = newlines, minus one for the header line in `csv` only. The file name comes from `Content-Disposition` as today.
* `truncated = rows >= cap`, passed to `markAfterExport(exportMark, window, { truncated, rows }, now)` unchanged. A result of exactly 1,000,000 rows is treated as possibly cut (the only false alarm).
* A response without `X-Export-Cap` (`json`, and the formats that already stream) takes today's path.

## The dedup stats-pass guard (independent change, same release)

The daily dedup tick runs a full `GROUP BY content_key_hash` that spilled 13.82 GiB to disk on 2026-10-13 and has no disk guard (the guard covers only populate and projection restores). `runContentDedupTick` will skip the stats pass when `checkDiskHeadroom()` reports less than `DEDUP_STATS_MIN_FREE_BYTES` free (default 40 GiB, about three times that spill), log `[content-dedup] <trigger>: skipped the stats pass, <free> free < <needed> needed`, and return `{ total: 0, excess: 0, applied: false, skipped: true }`. A headroom check that fails also skips. Nothing else in the tick changes.

## Testing and verification

* `__tests__/export-stream.test.ts`: every formatter (the header, quoting, the formula guard, `ndjson`, `ulp`, `userpass`), and `createExportStream` with a fake batch source: the cap stops it exactly, it reads lazily (backpressure), `cancel()` stops the source, an error in the source errors the stream.
* Route tests with a mocked ClickHouse stream: `csv` answers with the header and rows and `X-Export-Cap` and no `X-Export-Rows`; `json` keeps its headers and the 10,000 cap; a failing query is a 500; the scope still reaches the SQL.
* Page source tests in the existing style: the reader loop, the count, `truncated = rows >= cap`, the progress label, the unchanged mark call.
* Dedup tests: below the threshold the stats query is not run and the tick reports `skipped`; above it nothing changes; the default and the environment override.
* A read-only live check through the real handler: a 200,000-row export of a big-site search with the time to the first byte, the row count, flat memory, and the first 10,000 rows byte-identical to the old path (`json` excluded).
* The whole gate (`tsc`, `eslint` on `app lib components` and the new tests, `vitest`) and the image build, as for the login scope.

## Rollout

One image deployed locally with the rollback tag set first. No schema change, no migration, no new index. The app restarts for about 30 s.

## Not included

A background export file with a Download button, streaming the JSON array, reusing the fast "Newest first" windows for broad searches (a broad newest-first export keeps its two-minute wait for the first rows), an export progress bar by percentage, Excel or zip output, resumable downloads.

## Risks

* The wait for the first rows can reach about 2.3 minutes for a broad newest-first search (measured 137.7 s); `Preparing…` shows meanwhile.
* The browser holds the whole file while it downloads: about 215 MiB for a full export.
* A browser that stops reading for 300 s breaks the stream (ClickHouse `send_timeout`); the page reports a failed export.
