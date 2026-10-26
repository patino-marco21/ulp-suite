# Slow searches and slow filter clicks: one scan instead of two, and no scan for a search nobody waits for — Design

Date: 2026-10-26
Status: **implemented, verified and deployed locally on 2026-10-26** (main `55042df`, code `711c341`; image `ulp-suite-app:latest` = `e2eedf7af068`, built by `git archive 711c341`; rollback tag `ulp-suite-app:rollback-20261026-2310z` = `37e4fbe4430f`, the image that was running). Rehearsed on the built image: the stack's own scenarios 49/49, `scripts/e2e-hit-set.ts` 19/19, `scripts/e2e-search-dictionary.ts` 81/81. Live proof on the real table: `HSP_PARITY=1 npx vitest run __tests__/hit-set-parity.live.test.ts` (about 10 minutes). No DDL, no data change. Two settings: `SEARCH_HIT_SET`, `SEARCH_HIT_SET_MAX_HITS`.

## Why

The report was: some searches have suddenly become extremely slow, some of them right after results came back and the **Email** login-type chip was chosen. The app's own `system.query_log` (user `default`, HTTP interface, ClickHouse 26.3.17.4, `ulp.credentials` 2,229,506,200 rows in 15 parts, 195 GiB) and the machine's counters show where the time goes. Nothing is wrong with ClickHouse (idle, 0 merges, 0 mutations, 296 GiB free), the disk, the memory (the PSI memory pressure was 0.02%) or the network.

**1. A text with a special character that no word can prune is a scan of 150 GiB, and the page asks for it twice.** A URL with a path, `user:pass` or anything with a space is the `like` type of `lib/ulp-search.ts`: `url LIKE '%x%' OR email LIKE '%x%' OR password LIKE '%x%'`. The substring plan (`lib/search-substring-plan.ts`) can prune it only with a whole word that sits INSIDE the text and is rare; for `host.tld/page` the only such word is `tld`, which matches a billion rows, so the plan steps aside (the probe is capped at 50,001 hits). What is left reads the three string columns of every granule: 148-150 GiB, 597-702 CPU-seconds per scan. The page sends the rows request and the totals request together, so one search is two of these scans.

| measured on a quiet machine (nothing else running), fresh texts, ClickHouse caches empty | seconds |
|---|---|
| one scan alone | 66.5 (60.7 and 56.6 in two later runs) |
| the page's pair, rows + totals started together | 121.0 and 129.7 |
| the same scan on 2026-10-13, 1.84B rows / 124 GiB / 457 CPU-s (42 scans) | 38.6 on average |

Per GiB the CPU cost rose 11% (3.69 to 4.09 CPU-s); the rest is the table (+21% rows, +20% bytes) and CPU wait: the same scan now waits 322 s for a core (20-120 s on 10-13). The CPU is an 8-core / 16-thread laptop part (i7-10870H) at 85-86 °C that runs at 2.6-3.0 GHz while scanning (5.0 GHz maximum), with 23.7 million package throttle events since boot.

**2. Every click starts a new pair, and the old pair is not stopped.** `app/credentials/page.tsx` aborts the browser's fetches when a newer `load()` starts, and its comment says that this "cancels the older one instead of letting both run concurrently against ClickHouse". It does not: `app/api/credentials/route.ts` never looked at `request.signal`, and ClickHouse does not stop a statement because its client went away when `http_wait_end_of_query = 1` is set, which the Credentials queries need (a time limit then arrives as an HTTP error instead of as garbled JSON in the middle of the body). Measured on 26.3.17: a client that disconnected 3 s into a long query left it running for the 19 s the test watched, with and without `cancel_http_readonly_queries_on_client_close = 1`. In the 14 minutes from 21:21 to 21:35Z on 2026-10-26 the page started six searches, twelve scans of 148-150 GiB; six of those scans belonged to three searches that had been replaced before they finished. Up to 4-5 queries ran at once, the host's load average was 46-53 (idle 1-23%), and every other query slowed with them: the default page (1.0 s when idle) took 21.3 s, and two related-records queries hit their 30 s limit. Each search took 139-262 s.

**3. A chip is a new query, and ClickHouse's own cache cannot help.** Six seconds after a search came back in 0.12 s and 0.16 s (ClickHouse's query-condition cache had the answer of two earlier identical runs), the same search with `login_type IN ('email')` took 140 and 148 s. The condition cache stores per (part, filter) which marks hold no match, and it was tempting to make the search its own `PREWHERE` step so that a chip could reuse it. Measured on a faithful copy of the table (the real DDL, 42M rows, 3 partitions, 16 parts) and then on the real one, that is too fragile to build on:

* a query with a **skip-index-backed filter in its chain** (the login-type set index, the tier set index, ...) writes nothing, and its identical repeat is cold again; with `ignore_data_skipping_indices` on that index, or `use_skip_indexes = 0`, it writes. So a chip-first search never leaves an entry;
* a search that **has no whole word inside it** is read from the `proj_imported_desc` projection by the planner, whose parts have their own names (643 of 651 marks), so nothing is shared with the base-table queries; with projections off it still wrote nothing for texts with hits;
* it is **ClickHouse-version dependent** (the guards are in `MergeTreeSelectProcessor`).

## What was tried and rejected

* **`PREWHERE` on the search, plus a priming scan** so that chips hit the cached entry: works for texts with a text-index hint and no skip-index filter (`B1`: a pure-search query first, then every chip/noise/rows/totals variant is a hit, 0.00-0.01 s on the copy), not for the others (above); and a prime that does not help costs a whole extra scan.
* **`max_threads = 8`** to leave cores for interactive queries: the scan took 70.1 s against 60.7 s, with no visible gain for the page query (0.2-1.0 s either way).
* **A queue of heavy scans:** unnecessary once an abandoned scan is killed and the two requests of a search share one.
* **A host-dictionary plan for `host/path` texts** (candidate domains from `search_host_dict`, as for domain searches): not exact. The text can occur in the query string of another host's URL, or in the login or password column, and the dictionary only knows hosts. It would change what a search finds, which is the owner's decision, not a speed fix (see the last section).

## Measurements behind the design (2026-10-26, same table)

The whole cost of such a search is in FINDING the rows; what is found is tiny. For one real login-page search (a host and a path) the scan returned **49 matching rows in 3 parts**, after 53.6 s. Everything the page can ask for after that is a filter over 49 rows. With the positions in hand (`SELECT _part, _part_offset ... WHERE <the search> LIMIT 20001`, projections off) the four request shapes of the page ran as today's query plus `AND ((_part = 'p' AND _part_offset IN (...)) OR ...)`:

| shape | with the positions | today's query |
|---|---|---|
| totals, Email chip | 0.20-0.25 s | 139-163 s (as logged) |
| rows, Email chip, Declutter | 0.26 s | 148-196 s (as logged) |
| totals, no chip | 0.22-0.24 s | 0.21 s (condition-cache hit) |
| rows, no chip, Declutter | 0.24-0.32 s | 64.1 s cold |

The output was **identical**: md5 of the result lines equal for the totals and for the rows without the chip (the two shapes the legacy query could answer in reasonable time). On the faithful copy: 20 of 20 comparisons identical (5 texts, with and without hits, with and without an inner word, 4 request shapes each), 0.14-0.22 s against 1.0-1.5 s. A literal grouped by part (`(_part = 'p' AND _part_offset IN (1,2,3))`) is 2.7 times shorter than a tuple list (670 against 1,782 characters for 49 hits) at the same speed, so that is what the SQL carries.

The cost of the fingerprint query that guards the set: 4 ms (`system.parts` of 15 parts).

## Design

**`lib/clickhouse.ts`** — `executeQuery(sql, params, signal)`: when given a signal the statement runs under an id of its own (`ulp-q-<uuid>`), and an abort sends `KILL QUERY WHERE query_id = '<id>' ASYNC` (`killQuery`: best effort, bounded to 10 s, the id is checked against a fixed shape). The listener is removed when the statement settles, so a finished query is never "killed". `isAbortError` is exported. The client library prints a stack trace at ERROR level for every aborted request, which would put an error block in `docker logs` per replaced search, so the client gets a logger (`ClickHouseClientLogger`) that drops exactly that one case and logs everything else as the default logger did.

**`app/api/credentials/route.ts`** — every long query gets `request.signal`: the plain rows and totals, all plan queries (dictionary, word, substring, hit-set) and the "Newest first" windows (not the shared readiness and anchor lookups or the cached probes: another request awaits those). An aborted request ends with a quiet **499** (`signal.aborted` or an `AbortError`; an `ECONNRESET` to ClickHouse stays a logged 500). `runWithBudget` lets an `AbortError` through instead of treating it as a plan failure that deserves today's query.

**`lib/search-hit-set.ts`** — the hit-set plan, between the substring plan and today's query:

* *Eligible:* exactly one positive `like` term in the default scope (`substringNeedleFromQuery`), no regex, and none of the filters that already make today's query cheap (domain, breach, source file, URL host, e-mail domain, imported range). A login type, a tier, Declutter, Unique, the sort and the limit do not count.
* *The scan:* `SELECT _part AS part, _part_offset AS off FROM ulp.credentials WHERE (<the search>) LIMIT cap + 1`, `optimize_use_projections = 0` (positions refer to base parts), `max_execution_time = 300` that throws. One scan per (parts fingerprint, search), shared by every request that needs it.
* *The answer:* today's rows or totals query, unchanged, plus the conjunct above, plus `optimize_use_projections = 0, optimize_move_to_prewhere = 0, query_plan_optimize_lazy_materialization = 0` (the `_part_offset` fix of the dictionary plan's branch E), within 20 s that throws. The search predicate stays in the query. No hits: an empty page and zero totals without a query. More than the cap, a conjunct over 150,000 characters, an overrun or any error: today's query.
* *Validity:* the set carries the fingerprint of the table (`cityHash64(uuid, sorted active part names)`) read BEFORE the scan. It is used only while the fingerprint is unchanged: read before use, after the scan, and after the answering query. A scan that straddled a change is dropped and its search is left to today's query for 2 minutes (an import running would otherwise start a new 60-second scan per click). Sets live 15 minutes, at most 32.
* *Cancellation:* the waiters of a scan are counted; when the last one leaves, the scan is aborted (hence killed) after 1.5 s unless a newer request for the same search joined meanwhile (a filter click aborts the page's two requests and sends two new ones within milliseconds).
* *A later page* (a request with a cursor) uses a set that is there and never starts a scan.
* Kill switches: `SEARCH_HIT_SET=0`, `SEARCH_TOKEN_PLANS=0`, `hit_set=0` / `token_plans=0` for one request. The response's `plan` is `hits`.

### Failure modes

| what | what happens |
|---|---|
| an import commits during the scan or the answer | the fingerprint differs: the set/answer is dropped, today's query runs |
| a merge replaces parts (same rows, new names) | same; the next search scans again |
| the table is swapped (dedup) | the uuid is in the fingerprint |
| `system.parts` unreadable | no plan |
| more hits than the cap | an unlisted set is cached, so the next click does not scan again; today's query answers |
| the answering query is slow or fails | today's query runs after at most 20 s |
| the user leaves | the shared scan is killed once nobody waits for it |
| ClickHouse is upgraded | nothing here depends on the condition cache or on planner heuristics; the `_part_offset` settings are pinned by a rehearsal |

## Tests

`__tests__/clickhouse-kill-on-abort.test.ts` (15), `__tests__/search-hit-set.test.ts` (40), `__tests__/credentials-route-hitset.test.ts` (33), `__tests__/search-hit-set-wiring.test.ts`; each guard was mutation-checked (dropping the signal, the freshness check on rows and on totals, the empty-set short circuit, the filter gate, the later-page rule, the abort handling, the post-scan fingerprint check, the part test of the conjunct: all caught; one gap found and closed by a totals-side test). `__tests__/hit-set-parity.live.test.ts` (`HSP_PARITY=1`) compares the plan with `hit_set=0` on the real table and proves that an abandoned search leaves nothing running; `scripts/e2e-hit-set.ts` rehearses it on the built image against an isolated ClickHouse, including a row imported after the set was built.

## What this does not change

* The FIRST search of such a text still costs one scan: 54-66 s on this machine, once instead of twice, and the page shows the rows and the totals together at that moment.
* A text that matches more than `SEARCH_HIT_SET_MAX_HITS` rows, and a search with a narrowing filter, keep today's query.
* The same scan exists in the exports with a search term and in `/api/v1/search`; they are not changed here.
* The machine: the laptop runs hot (85 °C, throttled), has 8 physical cores and 31 GiB of RAM shared with 21 sandbox containers, and its swap is full. Not touched.

Options for the first search, for the owner to decide (none is built): (a) accept one minute; (b) for a text that starts with a host (`host.tld/path`, `https://host`), search the URL column of the rows whose host matches, from the dictionary (0.1-3 s), which would no longer find the text inside another host's query string or in the login or password column; (c) a substring index on `url`: not available as an add-on in 26.3. A column may carry only ONE text index (`ADD INDEX ... TYPE text(tokenizer = ngrams(4))` on the faithful copy: "Column `url` must not have more than one text index"), and `idx_inv_url` is the one the word, substring and hit-set probes use. An `ngrambf_v1` bloom filter is the other kind; for 65,536-row granules of 37-byte URLs (about 2.4 MB of text per granule) it would need roughly 1.9 MB per granule at a 5% false-positive rate, about 65 GB for `url` alone (an estimate, not measured), so it was not built.

## Rollout

Deployed locally on 2026-10-26 about 23:23Z: only the app container was recreated (3 s, healthy after 11 s); ClickHouse (up 4 days) was not touched, and the start-up log says "DDL v29 already applied" and does no schema work. Order followed: rollback tag on the running image first, candidate built under its own tag from `git archive`, rehearsal with `REHEARSAL_APP_IMAGE`, then `docker compose up -d --no-build app` from the primary checkout.

Gates on `711c341`: `tsc` for the app, `scripts/` and `__tests__/` clean, eslint clean, 4,444 tests in 272 files (13 live files skipped).

**Live proof on the final code** (real table, 2,229,506,200 rows, every plain reference run with the query cache and the condition cache dropped; one real login-page search that finds 49 rows, one invented text that finds none; rows and totals compared with `hit_set=0`: identical in every variant):

| | plain rows | plan rows | plain totals | plan totals |
|---|---|---|---|---|
| real search, first (builds the set: one scan) | 62.7 s | 55.5 s | 56.2 s | 0.10 s |
| real search, Email chip afterwards (38 rows) | 63.6 s | 0.19 s | 64.6 s | 0.10 s |
| invented text, first | 63.0 s | 53.7 s | 57.1 s | 0.01 s |
| invented text, chip afterwards | 64.2 s | 0.02 s | 63.3 s | 0.02 s |

In the page, the plain rows and totals run together (121 s and 130 s measured on a quiet machine, 139-262 s as logged), so the first search is about 55 s instead of 2 minutes or more, and a chip click about 0.2 s instead of another 2-4 minutes. Both abandonment checks pass: a search abandoned 3 s after it started leaves nothing in `system.processes` (today's query: killed at once; the shared position scan: killed 1.5 s after the last waiter left).

**Not verified:** the owner has not tried the page since (no credentials for the real UI: the deployed app was checked for health, environment and bundle only). The abort chain is proven in parts: `request.signal` fires on a browser disconnect in a production build of this Next version (throwaway server, 2,972 ms for a 3 s client timeout), the handler's abort kills the statement on the real ClickHouse (live test), and the built image answers aborted requests quietly (rehearsal [6]); an abort long enough to need a kill is not rehearsed on the isolated stack because its table is too small to give a scan that lasts seconds.

**Re-verify:** `HSP_PARITY=1 HSP_NEEDLES='<texts>' npx vitest run __tests__/hit-set-parity.live.test.ts`; `REHEARSAL_APP_IMAGE=<tag> npx tsx scripts/e2e-alert-rehearsal.ts --keep`, then `npx tsx scripts/e2e-hit-set.ts`. After any ClickHouse upgrade re-run both: the plan depends on `_part`, `_part_offset` and the `optimize_move_to_prewhere = 0` workaround, not on the condition cache.
