# Imported-after filter — design (2026-10-05)

Status: **design approved in chat on 2026-10-05; this written spec awaits the owner's read; not implemented.** One rule changed after approval,
because a measurement disproved it: the helper never switches skip indexes off (see "The plan rule" and "Measurements"), and a prerequisite fix
(P0) was added. Reference table: `ulp.credentials`, 1,394,459,025 rows in
partitions 202607 (897.7M) and 202608 (496.7M), `imported_at DateTime` (second precision, server and column time zone UTC), 2026-07-03 to
2026-08-28. Every timing below is READ-ONLY, taken on the live server on 2026-10-05 with the query, condition and mark caches dropped before each
run (the OS page cache stays warm), 4 threads, 4 GB memory cap. Search terms are labelled, not named: term A = a popular domain, term B = a
common word, term C = a rare word. "Delta" = rows newer than the cutoff.

## The problem

The operator wants "only the entries imported after a certain date" on every search and export, so that repeating an earlier export returns only
what arrived since.

A day-level version exists: `date_from` / `date_to` (`imported_at >= 'D 00:00:00'`, `<= 'D 23:59:59'`) in `/api/credentials`, `/api/export`
(csv, json, ndjson, ulp, userpass, hcmask, emails, domains) and `/api/search` (no UI caller), with two `<input type="date">` in the Credentials
page's Advanced Filters. It falls short of the goal:

- **Day precision, in UTC.** A picked date means 00:00 UTC, so an operator whose local time is behind UTC (for example UTC-5) gets a boundary
  in the previous evening, and cannot say "after 2:37 pm". Ingest stamps each 100k-row insert block with `now()` (a file spreads over hours:
  143M rows landed within 2 h 41 min on 2026-08-28; about 75k rows share a second), so a same-day cutoff re-includes or misses rows.
- **Missing surfaces.** None of these has a date bound: `/api/v1/search/credentials`, `/api/v1/search/domain`, `/api/v1/lookup`,
  `/api/v1/lookup/batch`, `/api/lookup/batch` (the Lookup page), the breach-page export (the UI sends no date).
- **Silent drops.** `format=spray` receives the filters as `_extra` and never reads them (`streamSprayList`, `app/api/export/route.ts`);
  `format=wordlist` ignores the query and every filter. No test pins either, so they are oversights.
- **Silent truncation.** csv, json, ndjson, ulp and user:pass exports are `LIMIT 10000` and say nothing (the dropdown reads "CSV (full)"). An
  incremental workflow that advances its cutoff after a truncated export loses the oldest rows of the delta for good.
- **Slow for the incremental case.** Plain `imported_at > T` reads the whole newest partition: 11-13 s for a search scoped to a recent cutoff.

## Goals

1. A timestamp-exact bound, `imported_after` (exclusive) and `imported_before` (inclusive), on every surface that returns credential rows or a
   list derived from them.
2. One parser and one SQL builder, used by every route, so behavior cannot drift between surfaces.
3. Fast where it matters (Newest-first, exports, v1 search, totals): reuse the projection's key expression, which the Newest-first work
   already proved range-prunes.
4. Exports tell the truth: the window they covered, and whether the 10,000-row cap cut them.
5. A "since last export" convenience that cannot skip rows.

Not goals: "new content" semantics (decision D1: the filter means rows ADDED after the cutoff); changing the 10,000-row cap; the other advanced
filters spray also drops (password length, mask, scheme, corporate, email domain); `/api/check`, `/api/related`, monitors (their own fingerprint
ledger already tells new from seen), sources and upload; any schema, projection or index change.

## Semantics

Two params, on every surface (query string for GET routes, JSON body keys for POST routes): `imported_after`, `imported_before`. The legacy
`date_from` / `date_to` keep their exact current meaning and combine with the new ones (the stricter lower and upper bound win).

| Input | `imported_after` means | `imported_before` means |
|---|---|---|
| bare date `2026-10-05` | from the start of that UTC day, the day included | to the end of that UTC day, the day included |
| `2026-10-05 14:37:00` or `2026-10-05T14:37:00` | stamped after that UTC second | stamped at or before it |
| `...Z` or `...-05:00` | the same instant, converted from its offset | the same |
| fractional seconds | floored to the second | floored |

Anything else, or a year outside 1970-2105, is a 400 `{ success: false, error }` that names the param and the three accepted forms; no query runs.

Internally a range is `{ lower, upper }` in epoch seconds, `lower` exclusive and `upper` inclusive, either may be null (a bare-date lower bound is
`epoch(D 00:00:00) - 1`, a bare-date upper bound `epoch(D 23:59:59)`, which reproduces today's date_from / date_to exactly). A window with
`lower >= upper` matches nothing and is not an error. Because "after" is exclusive and "before" inclusive, exports chained as
`(previous before, next before]` never overlap and never leave a gap.

## The plan rule (what the measurements allow)

The helper (`lib/imported-range.ts`) emits two forms of the same predicate:

- **Plain**, always correct, on every route: `imported_at > toDateTime({impAfter:Int64}) AND imported_at <= toDateTime({impBefore:Int64})`,
  the column bare on the left so partition pruning and the `idx_mm_imported_at` minmax index still apply.
- **Projection-aware**: the plain form plus `negate(toUnixTimestamp(imported_at)) < -lower` and `... >= -upper`, written exactly as
  `IMPORTED_KEY_EXPR` in `lib/newest-first.ts` (only this form range-prunes `proj_imported_desc`). Mathematically the same row set.

The projection-aware form is used only when ALL of these hold: `lower` is set; `getNewestFirstStatus` says ready (it fails closed); the query is
time-ordered (`imported_desc`, `imported_asc`) or an aggregate (the totals `uniq` + `count`); and the search is **index-neutral**: no word token,
no LIKE-fallback token, no regex, that is, only domain, email, `@domain` terms and filters, or no query at all. The helper NEVER adds
`use_skip_indexes = 0`.

Why those conditions (all measured, see below): (1) A projection part has no text index, so `hasToken` evaluated there is a plain
case-sensitive function, while the base-table plan answers it from the text index (`preprocessor = lower(col)`) case-insensitively. Forcing the
projection with `use_skip_indexes = 0` therefore drops mixed-case matches (27,263 against 27,285 rows). (2) On non-time sorts the projection is not
chosen and skip-off is 3-4x slower (a rare word 8 s -> 31 s, 49 GiB). (3) For word terms the key predicate alone changes nothing: the planner reads the
base table either way, so they simply cost what the same search costs today. Domain, email and no-query searches have no index-dependent
semantics, and parity was measured identical.

## Prerequisite P0: Newest-first must return the plain query's rows

The same drift exists today, in production, in the Newest-first windows (`app/api/credentials/route.ts` passes `use_skip_indexes = 0` for a window
inside the projection's coverage): a word-token search on the windowed plan omits mixed-case matches the plain plan returns. Confirmed end to end
through the real handler: with a cursor placed on such a row, the windowed page (plan `windows`, 145 ms) leaves it out and the plain page (102 s)
returns it first, the two pages differing by exactly one row. The 2026-10-01 parity test missed it because its only word scenario hands off to the
plain plan, so a word term on the windowed plan was never compared.

The imported-after browse view runs on those windows, so the gap would be inherited. P0 closes it, with the fix chosen by proof, not by taste:

- **P0-a (keeps the speed):** on the projected path only, write word-token predicates over the lowercased column (`hasToken(lower(url), tok)`),
  which is exactly the text index's own preprocessor (both `lower` are ASCII-only). Accepted only if a mixed-case parity run over a term set
  (several common and rare words, capitalised, upper-case and camel-case variants) shows the windowed and plain pages identical.
- **P0-b (fallback):** never disable skip indexes when the WHERE contains `hasToken`; such searches use the plain plan.

Acceptance: a new live parity scenario (a word term, cursor on a case-only row) passes, and the existing 13 scenarios stay identical. The owner
may strike P0; the imported-after browse view then inherits the gap for word terms and the docs say so.

## Where it applies

| Surface | Change |
|---|---|
| `GET /api/credentials` | the bound joins `conditions` and the totals; Newest-first windows take the floor and ceiling as epoch seconds (no string parsing, no time-zone assumption) |
| `POST /api/export` | every format, including `spray` and `wordlist` (wordlist gets the date bound only; its other behavior is unchanged); the breach-page export sends it too |
| `GET /api/search` | the helper replaces its two lines (legacy, no UI caller) |
| `POST /api/lookup/batch`, `POST /api/v1/lookup/batch` | body keys; plain bound beside `email IN (...)` / `domain IN (...)` (the key already narrows the read) |
| `GET /api/v1/search/credentials`, `/search/domain`, `/lookup` | query params; the first two are fixed `imported_at DESC`, so they get the projection-aware form whenever the search is index-neutral (a domain search always is); JSON responses echo the normalized bounds when given |

`app/docs/page.tsx` documents the params for the four v1 endpoints.

## UI

- **Credentials, Advanced Filters:** the two date pickers become date-time inputs in the operator's local time, with the UTC value shown beside
  each (`= 2026-10-05 19:37:00 UTC`), and presets: Last 24 h, Last 7 days, Since last export. Setting a lower bound while the sort is not a time
  sort switches it to Newest first once (the operator can change it back), because that is the plan with the fast path.
- **Lookup page** and **breach-page export:** one optional "Imported after" input each, sent with the request.
- The detail view labels `imported_at` as UTC. Under the inputs: "Matches rows added to the database after this time; a credential imported
  again later counts as added" (D1).
- **Since last export:** the page keeps, per search, the cut of its last complete export in `localStorage` (key from a hash of every filter
  except dates, sort and format). An export started from the preset sends `imported_after = remembered cut` and `imported_before = now - 120 s`
  (rows are stamped up to a few seconds before they become visible: p95 3.6 s per insert block), and on success remembers that
  `imported_before`. The cut is recorded only when the export was complete (not truncated) AND its lower bound was empty (the first export) or
  equal to the previous remembered cut, so the chain has no gaps; a hand-typed range never moves it.

## Export honesty

- The non-streaming formats ask for 10,001 rows, trim to 10,000 and send `X-Export-Truncated: 1`; the toast then says "Export stopped at
  10,000 rows - narrow the window to get the rest". `X-Export-Rows` carries the count. The cap itself stays (the sort memory it protects is the
  reason it exists).
- Every format sends `X-Export-Imported-After` / `X-Export-Imported-Before` (ISO UTC) when a bound was used, and the filename carries the window
  (`..._after-20261003T143700Z_before-20261005T143500Z.csv`), so the cut survives in the file name even if the browser's memory is cleared.
- hcmask (top 2,000 passwords by design) and the streaming lists (emails, domains, spray, wordlist) have no row cap and no truncation flag.

## Measurements (2026-10-05)

Export shape (`ORDER BY imported_at DESC, domain ASC LIMIT 10000`), delta = the newest ~2.2M rows (cutoff 2026-08-28 23:30:00 UTC):

| Search | plain bound | + key predicate |
|---|---|---|
| no query | 0.21 s | 0.06 s |
| term A (domain) | 12.9 s, 497M rows, 25.4 GiB | **0.12 s**, 2.7M rows, 188 MiB |
| term B (word) | 11.3 s, base table, 22.9 GiB | 8.6 s, base table (no gain) |

Same shape, delta = the whole 143.3M-row newest burst: term A 15.7 s -> 4.3 s; term B 14.2 s -> 12.3 s; no query 1.8 s -> 1.7 s.

Browse totals (`uniq(content_key_hash)` + `count()`), same delta: term A 12.6 s -> **0.23 s**, identical counts (94,345 / 93,856); term B 8.6 s ->
7.7 s, identical (27,285); term C 7.1 s -> 7.5 s, identical (1). Four very common words: identical counts with and without the key predicate
(825,231 / 1,832,776 / 513,276 / 459,414), base table both ways.

Default browse sort (`domain_asc`, LIMIT 200), delta ~2.2M rows: no query 0.2-0.3 s in every variant; term A 9.5 s plain, 7.9 s key predicate, 10.1 s
with skip indexes off; term C 8.0 s, 8.2 s, **31.2 s** (48.7 GiB). Delta 143M rows: term C 9.9 s, 10.4 s, **33.7 s**.

The case-sensitivity finding, on the newest ~2.2M rows for term B with skip indexes off: raw `hasToken` 27,263 matches, `hasToken` over `lower(col)`
27,285, identical to the plain plan; 22 rows match only when lowercased, none the other way; they hold capitalised, upper-case and camel-case forms
of the word in url, email and password.

Exact-novelty probe, for the record (decision D1): an anti-join of the delta's `content_key_hash` against older rows took 21.5 s; none of the
2,222,224 newest rows has an older twin, because the 2026-09-30 content-dedup keeps the earliest row, so today `imported_at` is first-seen for
every row. The importer still re-inserts credentials it already has (`2026-10-02-novelty-aware-ingest-design.md`), so after the next overlapping
import "imported after" and "new content" part ways until a dedup pass or novelty-aware ingest.

## Failure and edge cases

| Case | Outcome |
|---|---|
| Invalid bound | 400 with a clear message, no ClickHouse query |
| Projection not ready, or a window error | plain bound only; slower, never wrong (the readiness check fails closed, cached 60 s) |
| Range reaching older partitions (no projection parts) | both predicates stay; the key predicate only restricts the projection read, the base partitions use the plain bound |
| Only an upper bound | plain form (the projection helps a lower bound) |
| An export racing a running import | the 120 s lag on the preset; a caller-chosen `imported_before` is used as given |
| localStorage cleared | the preset reads "none yet"; the file name still carries the cut |

## Decisions (defaults in bold)

- **D1.** "New" means rows added to the database after the cutoff. Re-imported credentials count as added until a dedup pass; exact novelty
  (the 21.5 s anti-join, or novelty-aware ingest) is a separate, later choice.
- **D2.** A bare date includes its whole UTC day on its own side; an explicit date-time is an exact instant.
- **D3.** After is exclusive and before is inclusive, so chained windows tile.
- **D4.** The last-export cut lives in the browser, not in the database; the file name is the durable record.
- **D5.** The 10,000-row cap stays, reported instead of silent.
- **D6.** Wordlist gets only the date bound; spray's other dropped filters stay dropped.
- **D7.** P0 (the Newest-first parity fix) is part of this work and goes first; strike it only if the owner accepts the inherited gap.

## Verification plan (empirical, per the project's own rule)

1. Unit tests, `__tests__/imported-range.test.ts`: every accepted form and offset, bare-date semantics, floors, rejects, the legacy mapping and
   the stricter-bound merge, the SQL shape pinned (bare column on the left; the key predicate string equals `IMPORTED_KEY_EXPR`; the
   `use_skip_indexes` setting never appears), and the index-neutral gate over every token type.
2. Route tests in the repo's style (source slices plus mocked `executeQuery`): each route reads the params, 400s without querying, passes the
   bound to its SQL; spray and wordlist honor it; the export's 10,001 trick, headers and file name.
3. Live, read-only parity test, `__tests__/imported-range-parity.live.test.ts`, gated like the Newest-first one (`IRP_PARITY=1`, cache dropped
   before every call): for several cutoffs (a few minutes, the newest burst, mid-range, a range spanning both partitions) x searches (none, a
   domain, an email, a word, an `@domain`) x sorts, the helper's plan returns row-for-row what the plain bound returns, with timings printed;
   includes `imported_asc` (not yet measured) and the P0 mixed-case scenario.
4. A pure-function test for the browser pieces (local time to UTC, the filter fingerprint, the chain rule for the last-export cut).
5. The Browser pane: set the filter, see the rows, export, read the headers and file name. Deploy locally as before; no migration, so the
   rollback is the previous image.

## Risks

- A wrong key predicate would drop rows. It is the plain predicate rewritten, pinned by a unit test and by the live parity run.
- Skip indexes off drops rows and can be 4x slower: the helper never sets it, a test pins that, and P0 removes the one existing use that drifts.
- The readiness cache can be up to 60 s stale: it fails closed, and a stale "ready" only changes speed.
- The 120 s lag is a heuristic against in-flight inserts; a stalled insert longer than that is already killed by the import watchdog.

## Deliberately NOT done

Novelty-aware ingest and the anti-join (D1), a server-side export ledger, spray's other filters, raising or removing the 10,000-row cap, a
`since:` token in the search box (it would count as a second term and switch off the one-domain dictionary path, and it never reaches the lookup
routes), `/api/check`, `/api/related`, monitors, any schema or projection change.
