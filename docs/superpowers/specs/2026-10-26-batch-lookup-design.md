# Batch lookup: pasted input and long address lists — Design

Date: 2026-10-26
Status: **implemented, verified and deployed locally on 2026-10-26** (main `6f20161`; image `3a55b8134c9b` (`ulp-suite-app:latest` until the follow-up below), built by `git archive d98fb82`, rehearsed 40/40; rollback tag `ulp-suite-app:rollback-20261026-0631z` = `94509bf36e66`, the image that was running). Read-only proof on the real table: `BLK_LIVE=1 npx vitest run __tests__/batch-lookup.live.test.ts` (about 6 minutes); proof on the built image: `npx tsx scripts/e2e-batch-lookup.ts`. No DDL, no new setting: the deployed app logged "DDL v29 already applied" and did no schema work. The single lookup `GET /api/v1/lookup?domain=` was fixed the same day: see the last section.

## Why

The report was "the email or domain batch lookup is not working". Reading the app's own `system.query_log` and then running both routes (`POST /api/lookup/batch`, used by the Batch Lookup page, and `POST /api/v1/lookup/batch`) against the real table found five causes. Three of them are not errors at all: the routes return HTTP 200 with "not found", which is why it looked like clean data. One is a timeout (408) and one is a documentation error (405).

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
5. **The README sent API users to an endpoint that does not exist.** Its table listed `POST /api/v1/lookup` as the batch lookup; that route exports only `GET`, so following the table gave a 405 (checked on the deployed app: 405). The batch route is `POST /api/v1/lookup/batch`, which the in-app docs always had.

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

The page sends `{ emails, domains }` built per line, stops overriding an explicit Email/Domain choice, shows `as <host>` beside a result that was searched under another name, and counts both kinds. The suggested choice (`suggestBatchKind`) is decided by the plain lines, the only ones it governs: Domain when at least half of them read as a host, else Email. This was found on the rehearsal stack: with the first version (Email as soon as any `@` appears) a mixed paste made its plain host a login and came back "not found".

## Proof

* `__tests__/batch-input.test.ts`, `__tests__/batch-lookup.test.ts`: the cleaning rules, the parity of `domainEntry(url).host` with `extractDomain` over ten URLs, the planner, the matching, both routes with a mocked client; among them the guard that `hasAllTokens` never appears outside `indexHint(...)`.
* `__tests__/lookup-routes-imported-range.test.ts` pins the `WHERE` line and was updated for the hint; every other existing batch test passes unchanged.
* `__tests__/batch-lookup.live.test.ts` (read-only, prints no value), 2026-10-26, both routes: ten domain shapes and nine address shapes all found with the same rows as the clean form; 100 domains 0.7-1.1 s and 100 addresses 1.9-2.5 s, all found; **parity**: 89 sampled addresses (35 stored in mixed case, 25 lower case, 12 with punctuation, 4 digits-only, 8 non-ASCII, 8 absent; 88 mixed-case stored rows among those compared) in one batch return exactly the rows of a separate `lower(email) = lower(value)` query per address (no text index, no hint), **0 rows differing** on each route.

* `scripts/e2e-batch-lookup.ts`, on the built candidate image against a FRESH install of the isolated rehearsal stack (production init SQL and migrations), 2026-10-26: **40/40**. The fresh table has the text index the hint assumes (`splitByNonAlpha`, preprocessor `lower(email)`); six domain shapes, the `www.` and `:port` rows of the older parser, eight address shapes in four stored casings, a non-ASCII address, both kinds in one request, 100 addresses (39 ms on 1.5M rows) and 100 domains, 101 refused with 422; EXPLAIN on 100 absent addresses: 0 of 23 granules with the hint, 23 of 23 for the bloom filter alone; v1 with a real API key (`X-API-Key` and `Bearer`), 401 without one. The page itself, driven in the browser pane with a mixed paste: a URL with an upper-case host, `<addr>`, `mailto:addr`, a plain host and an address that does not exist gave 3 email + 2 domain, 4 found, 1 clean, with `as <host>` on the cleaned ones.

## Limits and what is not done

* An address with a non-ASCII character is looked up without the hint. Eight of them in a batch of 89 took 8.7 s instead of 2.5 s; a batch of 100 of them would take the old 26-38 s. Validating the tokenizer for non-ASCII text would remove this; it is rare enough not to.
* The hint is correct because `idx_inv_email` is `text(tokenizer = splitByNonAlpha, preprocessor = lower(email))`. If that index is rebuilt with another tokenizer or preprocessor, the hint prunes wrongly: run the live test.
* A domain is an exact match on the host: its subdomains are not included, and the 4,605 rows stored with a `www.` are found only by typing `www.`.
* `GET /api/v1/lookup?domain=` had the first defect and was not changed here; the follow-up below fixes it.
* Not done, and not needed now: a lower false-positive rate for `idx_bf_email_lc` (a rebuild of 195 GiB of indexes) or a projection on `lower(email)`. Either would make the comparison independent of the text index, at a cost the hint does not have.

## Follow-up: `GET /api/v1/lookup?domain=` (2026-10-26)

Status: **implemented, verified and deployed locally on 2026-10-26** (code `7929a7b`; image `ulp-suite-app:latest` = `4145c664f865`, built by `git archive 7929a7b`, rehearsed 55/55 twice; rollback tag `ulp-suite-app:rollback-20261026-1448z` = `3a55b8134c9b`, the image that was running; the container was healthy 10 s after the restart, its compiled route holds `domain IN` and no `domain = {domain:String}`, and it logged "DDL v29 already applied" and did no schema work). No DDL, no new setting.

### Why

The single lookup had cause 1 above. It compared `domain = {domain:String}` with the value lower-cased and trimmed, nothing else, so a URL, a `www.` host, `host:port` or a value with quotes or a trailing comma came back HTTP 200 with `found=false`. Its e-mail branch is not part of this change.

### Design

* The value goes through `domainEntry` like a batch entry and is looked up as `domain IN (candidates)`: the host, its `www.` form and the text as typed (when it has no scheme), so no match the old comparison found is lost. `ORDER BY imported_at DESC LIMIT 100` and the `SETTINGS` are unchanged.
* For a bare host the answer keeps `success, found, domain, count, results`. `domain` is still the value trimmed and lower-cased; `searched_as` follows it only when the host looked up differs from that (`searchedAsField`, the batch rule).
* A value with no host in it (a bare scheme, a host over 512 characters) runs no query and is a 200 with `found=false`, as in the batch lookups; a blank value is still the 400.
* `domainIn` (`lib/batch-lookup.ts`) builds the list and its parameters for this route and for both batch routes (their SQL is byte-identical to before).
* The 100 rows are shared by the forms: typing `www.host` returns the newest 100 of the host and its `www.` form together, where it returned only the `www.` rows. A row the old comparison found can be displaced only by a newer row of the other form, and only when the forms hold more than 100 rows between them; the live parity set those values aside (below).

### One query shape: `IN` costs nothing that shows

2026-10-26, 2,229,506,200 rows, 15 parts, ClickHouse caches dropped, `use_query_cache = 0`, the route's own query on three real domains of 39, 19,574 and 2,388,325 rows (single runs; rows read / wall time):

| form | 39 rows | 19,574 rows | 2,388,325 rows |
|---|---|---|---|
| `domain = x` (before) | 524,248 / 46 ms | 872,272 / 37 ms | 3,338,255 / 79 ms |
| `domain IN (x)` | 524,248 / 50 ms | 872,272 / 46 ms | 3,338,255 / 104 ms |
| `IN (x, www.x)` | 589,784 / 52 ms | 872,272 / 46 ms | 3,532,742 / 105 ms |
| `IN (x, www.x, x:8443)` | 665,086 / 52 ms | 937,808 / 71 ms | 3,608,044 / 81 ms |

One value reads exactly the rows of the equality (warm: 34-60 ms against 40-84 ms); each further value reads 0-270,000 rows more. So the route has one SQL shape, not an equality for one candidate and a list for several.

### Found on the way: `domainEntry` was quadratic

The route feeds `domainEntry` a query-string value. The way it took trailing punctuation and dots off, `/[...]+$/`, is retried from every start of a long run: 16,000 dots and one more character took 0.46 s, 160,000 took 44 s (a run of brackets and quotes: 0.25 s and 24 s), on the single thread that serves every request. The batch routes were exposed the same way through their JSON bodies, which have no length cap. `67a6dd6` makes the cut with a loop (about a millisecond for 200,000 characters). Checked against the previous implementation on 2,404,000 random inputs (of the structured ones 98% reached a host, 88% ended in a stripped character, 19% had dots before a port): 0 differences. Three timing tests (1.5-2.7 s before, limit 250 ms) now take under 1 ms. `cleanEmailEntry` has the same shape (293 ms at 16,000 characters, 27 s at 160,000) and is not changed here.

### Proof

* `__tests__/v1-lookup-domain-route.test.ts` (11 tests, mocked client): a bare host in its old shape and key order; upper case and padding; a URL; a `www.` host; `host:port`; quotes and a comma; a bare scheme (no query); 100 rows uncapped and in the order given; the query's order, limit and settings; the blank 400; the e-mail branch independent of the domain parameter. `__tests__/batch-lookup.test.ts` +5 (`domainIn`, `searchedAsField`), `__tests__/batch-input.test.ts` +8, and the domain pin of `__tests__/lookup-routes-imported-range.test.ts` moved to the IN form. Whole suite 4,261 passed, 95 skipped, 0 failed; both typechecks and eslint clean.
* Live, read-only (`BLK_LIVE=1 npx vitest run __tests__/batch-lookup.live.test.ts -t "single lookup"`, about 35 s, prints no value): a real domain of 4 rows (an earlier run: 27 rows) in the ten shapes d0-d9 returns exactly the rows of the bare host in each (31-50 ms), with `searched_as` on every shape but the bare and the padded ones. PARITY: for domains as they are stored, the answer equals the union of one `domain = value` query per value the entry stands for, and no row of the old answer is missing. Twelve values were sampled per stored shape; those whose lists reach the 100-row cap are set aside, because ties in `imported_at` make the cut arbitrary:

  | stored shape | compared (set aside) | rows in the answers | rows the old comparison found | differing | old rows missing | answers that grew |
  |---|---|---|---|---|---|---|
  | clean | 12 (0) | 45 | 45 | 0 | 0 | 0 |
  | with `www.` | 9 (3) | 29 | 10 | 0 | 0 | 4 |
  | with `:port` | 5 (7) | 54 | 7 | 0 | 0 | 3 |
  | with `/path` | 10 (2) | 48 | 15 | 0 | 0 | 6 |

  A clean host is answered with exactly the rows as before; the other shapes now also return the rows of the bare host (the earlier run on another sample: 0 differing, 0 missing as well).
* `scripts/e2e-batch-lookup.ts` on the candidate image against a fresh install: **55/55** (the 40 checks of the batch lookups and 15 for this route), twice (the second run kept the stack for the docs card). The shapes of the batch check (a URL with path, query and fragment, an upper-case `www.` host, `host:port`, `user@host`, padded and quoted text) all return the 3 rows of the host; a bare host's answer keeps its keys and has no `searched_as`; a URL's answer echoes it lower-cased and says `searched_as`; the row stored with a `www.` and the one stored with a `:port` by the older parser are found when typed as stored; a bare scheme is a 200, not found; a blank domain is a 400; the imported window composes; 401 without a key. EXPLAIN on the fresh table: the primary key leaves 1 of 23 granules for `domain IN (host, www. form)`. Over HTTP on that stack a value of 15,000 dots answered in 8 ms (a request line cannot be longer), and the corrected docs card rendered in the browser pane.

### Not done

* `cleanEmailEntry` (above) keeps its quadratic trailing-run cut.
* Two other routes compare a typed domain exactly and have cause 1: `GET /api/v1/search/domain?domain=` (a paginated search) and the `domain` filter of `GET /api/credentials`. They are a search and a filter with their own semantics and were not changed.
