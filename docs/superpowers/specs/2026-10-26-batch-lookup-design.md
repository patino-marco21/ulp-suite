# Batch lookup: pasted input and long address lists — Design

Date: 2026-10-26
Status: **implemented and verified on the live table on 2026-10-26; not yet deployed.** Read-only proof: `BLK_LIVE=1 npx vitest run __tests__/batch-lookup.live.test.ts` (about 6 minutes). No DDL, no new setting.

## Why

The report was "the email or domain batch lookup is not working". Reading the app's own `system.query_log` and then running both routes (`POST /api/lookup/batch`, used by the Batch Lookup page, and `POST /api/v1/lookup/batch`) against the real table found four causes. None of them is an error: three return HTTP 200 with "not found", which is why it looked like clean data.

1. **A domain list is compared as typed.** `domain` stores the bare lower-case host: the parser (`extractDomain`) drops the scheme, the path, `user@`, the port and a leading `www.`. The routes lower-cased the pasted text and nothing else. The two real domain batches in the query log carried full URLs (scheme included) and read 0 rows. Measured with one real domain asked in ten shapes, on both routes: only the bare host was found; `https://host`, `https://host/path?x`, `http://www.host/`, `WWW.HOST`, `host:8443`, `https://user@host/path`, `host/` and padded text all returned `found=false`.
2. **An address list is compared as typed.** Of six shapes of one real address only the exact one and the upper-case one were found; padding (the page trims, the API does not), `mailto:a@b`, `<a@b>` and `"a@b"` missed. JavaScript's `toLowerCase()` also folds non-ASCII capitals that ClickHouse's `lower()` leaves alone, so such an address could never equal its stored form.
3. **A long address list timed out (a regression of 2026-10-13).** Commit `d9c5daf` (the case-insensitive lookup) replaced `email IN (...)` by `lower(email) IN (lower(...), ...)`. The old form was narrowed by the primary key and the exact text index `idx_inv_email`; the new one can use neither, and its bloom filter (`bloom_filter(0.05)`) cannot narrow a list: granules kept by `EXPLAIN indexes = 1`, of 34,299: 1 address 1,499 (4.4%), 10 addresses 12,162 (35%), 100 addresses 33,865 (98.7%). The design measured single addresses only. Same 100 sampled addresses, ClickHouse caches dropped, `use_query_cache = 0`:

   | addresses | before 10-13: `email IN (...)` | since 10-13: `lower(email) IN (...)` | this change |
   |---|---|---|---|
   | 1 | | 1.3-2 s | 0.2 s |
   | 10 | 1.4 s | 13.2 s | 0.4 s |
   | 50 | 2.9 s | 30.3 s | 1.7 s |
   | 100 | 4.4 s (63.8M rows read) | 37.8 s (26 s when warm; 2.2B rows read) | 2.5-3.3 s (64.5M rows read) |

   The routes abort at `max_execution_time = 30`, so a list of about 50 or more addresses came back as the 408 "timed out" error, and the page advertises 100.
4. **The page classifies the whole paste.** Any `@` anywhere sent every line as an e-mail (a domain in a mixed list was looked up as an address), although the API takes both lists in one request; and the Email/Domain choice was overwritten on every keystroke.

Ruled out, with evidence: authentication and the middleware (`/api/lookup/*` goes through the normal JWT check, only the login endpoints are rate limited), ClickHouse down or overloaded (idle, 0 merges), the client's own timeout (`request_timeout` is one hour), an index missing on some part (all 15 active parts carry the files of `idx_inv_email`, `idx_bf_email` and `idx_bf_email_lc`), and `NORM_COLS` (a pass-through for ordinary rows).

## Measurements behind the design (2026-10-26, 2,229,506,200 rows, 15 parts, ClickHouse 26.3.17.4)

**Stored domains.** 4,605 rows keep a leading `www.`; 0 have an upper-case letter; 226,642 keep a numeric `:port` and 1.37 million a `/`; 26.8 million are empty. So the pasted text is cut to the bare host, and the text as typed stays a second candidate (when it has no scheme): the new lookup never finds fewer rows than the old exact comparison did.

**What makes the text index prune.** Five forms of the same 100-address query, granules left of 34,299 and wall time:

| prefilter | granules | time |
|---|---|---|
| none (production since 10-13) | 33,865 | 37.8 s |
| `hasToken(email, w) AND ...` chains, 8 / 3 / 1 words per address | 18,543 / 18,566 / 34,293 | 65 / 62 / 49 s |
| `hasAllTokens(email, [words]) OR ...` as an ordinary filter, default settings | 994 in EXPLAIN, **2.2B rows read** | 23 s |
| same, `query_plan_direct_read_from_text_index = 0` | 734 marks, 47.8M rows | 2.7 s |
| **`indexHint(hasAllTokens(email, [words]) OR ...)`, default settings** | 994 then 990 (with the bloom filter) | **2.5 s** |

`EXPLAIN` is not execution: with `use_skip_indexes_on_data_read = 1` (the 26.3 default) the plan showed 994 granules while the query read every row. `system.query_log` (`read_rows`) is the number to trust.

**Why `indexHint`, not a filter.** The plain functions are case-sensitive: `hasAllTokens('John.Smith@X.com', ['john', ...])` is 0. Only the text index, through its preprocessor `lower(email)`, matches case-insensitively. For one real address stored in 54 rows (2 in mixed case): exact comparison 54 rows (2 mixed); with `hasAllTokens(email, ...)` as a filter and the index answering 54; with every skip index disabled **52, both mixed-case rows lost**. A filter is therefore exact only while the planner happens to use the index (a part without it, a projection read, a setting). `indexHint(expr)` is used by the index analysis and never evaluated on a row: 54 rows (2 mixed) with the index on and with every skip index off, and the same 994-granule pruning.

**Tokenizer.** ClickHouse's `tokens(lower(email), 'splitByNonAlpha')` equals the plain cut `[a-z0-9]+` of the lower-cased login on 5,000,000 sampled ASCII logins (0 differences) and on the 200,000 of the live test (199,954 hints built, 46 logins without a usable word, 0 differences). Its cut of non-ASCII characters is not validated, so an address with one gets no hint.

Cold, measured: caches dropped 3.1 s, plus `min_bytes_to_use_direct_io = 1` 3.3 s, warm 2.5 s (100 addresses).

## Design

`lib/batch-input.ts` (pure, shared with the page):
* `parseBatchText`: one entry per line, comma or semicolon; a line such as `a.tld b.tld` is split only when every word is an address, a host or a URL; an exact repeat counts once.
* `domainEntry`: the parser's cut (scheme, path, `user@`, port, `www.`, lower-case) made tolerant of `?query`, `#fragment`, quotes, a trailing dot and text after a space. Candidates, best first: the host, the host with its `www.`, the text as typed (not when it has a scheme).
* `cleanEmailEntry`: `Name <a@b>`, `<a@b>`, `"a@b"`, `mailto:a@b`, `a@b:password`, `a@b.`, zero-width characters. Without an `@` (a username, a phone number) only quotes and padding go. A `'` inside is kept.
* `classifyBatchLine` / `buildBatchRequest`: a URL is a domain, an `@` with no path is an e-mail, any other line follows the page's Email/Domain choice, so one paste can hold both.
* `prefilterWords`: the maximal ASCII alphanumeric runs of the ASCII-lower-cased login, longest first, at most 8, none longer than 64; `null` for a login with a non-ASCII character or without a word.

`lib/batch-lookup.ts` (server, shared by both routes, which had two copies of this logic and both carried the defects):
* `planEmailBatch`: `lower(email) IN (lower(v1), ...) AND indexHint(hasAllTokens(email, {tok0:Array(String)}) OR ...)` for the addresses that have words; a second query with the plain comparison for those that do not (almost always none).
* `emailResults` / `domainResults`: rows are matched back to the string as sent (the response keys do not change); case is folded for ASCII only on both sides; an input that stands for several stored domains gets them together, newest first, capped at 50; `searched_as` appears only when what was looked up differs from what was sent.
* The SQL shapes the other tests pin (order, `LIMIT {cap} BY`, `optimize_use_projections = 0`, the 30 s cap, the v1 inner/outer split with `NORM_COLS`) are unchanged.

The page sends `{ emails, domains }` built per line, stops overriding an explicit Email/Domain choice, shows `as <host>` beside a result that was searched under another name, and counts both kinds.

## Proof

* `__tests__/batch-input.test.ts`, `__tests__/batch-lookup.test.ts`: the cleaning rules, the parity of `domainEntry(url).host` with `extractDomain` over ten URLs, the planner, the matching, both routes with a mocked client; among them the guard that `hasAllTokens` never appears outside `indexHint(...)`.
* `__tests__/lookup-routes-imported-range.test.ts` pins the `WHERE` line and was updated for the hint; every other existing batch test passes unchanged.
* `__tests__/batch-lookup.live.test.ts` (read-only, prints no value), 2026-10-26, both routes: ten domain shapes and nine address shapes all found with the same rows as the clean form; 100 domains 0.7-1.1 s and 100 addresses 1.9-2.5 s, all found; **parity**: 89 sampled addresses (35 stored in mixed case, 25 lower case, 12 with punctuation, 4 digits-only, 8 non-ASCII, 8 absent; 88 mixed-case stored rows among those compared) in one batch return exactly the rows of a separate `lower(email) = lower(value)` query per address (no text index, no hint), **0 rows differing** on each route.

## Limits and what is not done

* An address with a non-ASCII character is looked up without the hint. Eight of them in a batch of 89 took 8.7 s instead of 2.5 s; a batch of 100 of them would take the old 26-38 s. Validating the tokenizer for non-ASCII text would remove this; it is rare enough not to.
* The hint is correct because `idx_inv_email` is `text(tokenizer = splitByNonAlpha, preprocessor = lower(email))`. If that index is rebuilt with another tokenizer or preprocessor, the hint prunes wrongly: run the live test.
* A domain is an exact match on the host: its subdomains are not included, and the 4,605 rows stored with a `www.` are found only by typing `www.`.
* `GET /api/v1/lookup?domain=` compares the typed domain the same way and has the first defect; it was not changed here.
* Not done, and not needed now: a lower false-positive rate for `idx_bf_email_lc` (a rebuild of 195 GiB of indexes) or a projection on `lower(email)`. Either would make the comparison independent of the text index, at a cost the hint does not have.
