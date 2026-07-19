# Credentials Search: Missing Indexes & Domain-Shaped Query Fix — Design

## Problem

The credentials search box (`app/api/credentials/route.ts`'s `q` param, parsed by
`lib/ulp-search.ts`) was reported as having two related bugs:

1. **Dotted search terms take the slow path.** `parseULPQuery` classifies a term as
   a "clean token" (→ indexed `hasToken()` search) only if it matches `/^[\w-]+$/`.
   Anything with a dot ("ledger.com", "trezor.io") fails that test and falls to the
   `'like'` branch — a raw `url LIKE '%v%' OR email LIKE '%v%' OR password LIKE '%v%'`
   full scan, ~10s+ even for small result sets.
2. **The indexes the fast path depends on were assumed missing.** The original report
   (based on investigation predating this session) found `idx_ngram_url_host` /
   `idx_ngram_email_domain` absent from both the live table and its rollback snapshot,
   and traced this to `lib/clickhouse-migrations.ts`'s DDL v9 apparently never
   completing.

Live investigation in this session (against the real 562M-row `ulp.credentials`,
ClickHouse 26.3.17.4) confirmed bug 1 but found a materially different picture for
bug 2, and identified a third, previously-unknown issue. All findings below were
verified directly against the database, not assumed from documentation — one
mid-session pivot (see "Rejected: text() index with `ngrams` tokenizer" below) exists
specifically because the documented/GA-recommended approach turned out to be broken
in practice and was caught by that verification.

### What investigation found

- **`idx_ngram_url_host` / `idx_ngram_email_domain` already exist and are
  materialized** on the live table — added directly against `clickhouse-client` on
  2026-07-09 (confirmed via `system.query_log`), ten days before this session,
  outside the migration runner (`ch_ddl_version` was already at 16 by then, so the
  version gate never re-fires DDL v9). The bug report's snapshot
  (`ulp.credentials_predup_auto`) predates that fix and is not representative of the
  current table.
- **But they provide ~0% pruning benefit.** `EXPLAIN indexes=1` for a real search
  term ("ledger") shows 0 of 8833 granules pruned even with the index fully
  materialized. Root cause: `ngrambf_v1(4, 1024, 1, 0)` — an 8192-bit filter with 1
  hash function — is undersized for this table's cardinality (34.47M distinct
  `url_host` values; sampled long-tail granules had 879–5,705 distinct hostnames
  each) and saturates to a near-100% false-positive rate. This is a sizing problem,
  not an existence problem — simply "getting DDL v9 to land" would not have fixed
  the reported slowness.
- **A separate, more impactful index was never successfully added at all.**
  `idx_inv_url` / `idx_inv_email` / `idx_inv_password` — the `text()` indexes meant
  to accelerate `hasToken()` itself (intended by DDL v6/v7) — are absent from the
  live table. `system.query_log` shows exactly one historical attempt (also
  2026-07-09, same session as the ngram fix), and it used DDL v5's broken
  `full_text(0)` syntax (`Code: 80, Unknown Index type 'full_text'`) rather than v6/
  v7's corrected `text(tokenizer = splitByNonAlpha, ...)` syntax. The corrected
  syntax has never actually run against this table. Without it, `hasToken()` is an
  unindexed full-column scan: verified at **11+ seconds** for `hasToken` alone over
  562M rows.
- **A structural gap independent of both bugs above**: the content-dedup
  rewrite+swap mechanism (`lib/content-dedup.ts`, and the manual
  `scripts/dedup-credentials-content.sh`) clones the live table via
  `SHOW CREATE TABLE` + rename. This completely bypasses `ch_ddl_version` — whatever
  indexes the source table has (or lacks) at swap time get carried forward
  permanently, with no automatic re-check. This is architecturally why an index fix
  can regress silently after a future swap, independent of whether the fix itself
  was correct.

## Root Cause Summary

| Symptom | Cause |
|---|---|
| Dotted terms are slow | `parseULPQuery`'s classification regex rejects any value containing `.`, forcing the unindexed `'like'` fallback regardless of whether a faster path could apply |
| `hasToken()` searches (existing bare-word search) are slow | `idx_inv_url/email/password` were never successfully added — only attempt used a syntax broken on ClickHouse 26.x |
| `url_host`/`email_domain` substring search doesn't benefit from its index | `idx_ngram_url_host/email_domain` exist but are undersized for this table's real cardinality — near-0% pruning |
| A future content-dedup swap could silently undo any of the above | Rewrite+swap clones DDL via `SHOW CREATE TABLE`, bypassing the versioned migration gate entirely |

## Architecture

### 1. Index infrastructure fixes (`lib/clickhouse-migrations.ts`, new DDL v17)

**1a — Add the missing `hasToken()` index**, re-attempting DDL v6/v7's syntax
(idempotent re-verify, same pattern as v7 itself being a re-verify of v6):

```sql
ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_url
  url TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(url)) GRANULARITY 1;
ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_url;
-- (same for idx_inv_email / email, idx_inv_password / password)
```

Verified in isolation on real data (5M-row sample of production `url`): identical
result count with the index forced on vs. forced off (`SETTINGS use_skip_indexes=0`)
— 275 rows both ways, matching a ground-truth word-boundary regex — and 2/77
granules read (97% pruned) with the index active. The existing query code
(`hasToken(url, {p:String})`, raw column reference, pre-lowercased value in JS) is
already the correct calling convention — confirmed that wrapping the column itself
in `lower(...)` at query time defeats the index (it no longer matches the indexed
expression), which is exactly why the existing code lowercases the *value*, not the
column. No changes needed to how `buildULPWhere` calls `hasToken()` for the existing
bare-word path.

**1b — Resize the ngram bloom filters.** `ngrambf_v1` can't be resized in place;
requires `DROP INDEX` + re-`ADD INDEX`:

```sql
ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_ngram_url_host;
ALTER TABLE ulp.credentials ADD INDEX idx_ngram_url_host
  url_host TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1;
ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_ngram_url_host;
-- (same for idx_ngram_email_domain / email_domain)
```

Old: `(4, 1024, 1, 0)` — 8192 bits, 1 hash function. New: `(4, 8192, 4, 0)` — 8x the
filter size, 4 hash functions. Verified on a 5M-row real-data sample: strictly more
granules pruned than the old size for the same query. Storage cost is trivial at
either size (well under 1% of table size). Bloom filters mathematically cannot
produce false negatives (only false positives) — also verified directly:
index-assisted and forced-full-scan (`use_skip_indexes=0`) result counts were
identical.

**1c — Verification order.** Both changes get applied to a disposable clone first
(matching this session's established practice — see `scripts/dedup-credentials-content.sh`
and the 2026-07-07 rewrite+swap design), confirmed via `EXPLAIN indexes=1` showing
real pruning improvement, *before* being added as DDL v17 for the live table to pick
up automatically on its next migration run.

### 2. Domain-shaped search terms (`lib/ulp-search.ts`)

**Classification (`parseULPQuery`).** Add a new token type, `'domain'`, for values
that look like a hostname — one or more dot-separated labels of word characters/
hyphens:

```
/^[\w-]+(\.[\w-]+)+$/
```

This requires at least one dot (so undotted bare words are unaffected — still
`'token'` type, unchanged behavior) and rejects anything with a `/`, space, or empty
label (so URLs-with-paths, IP addresses formatted oddly, and malformed input all
still fall through to the existing `'like'` fallback exactly as today). IP addresses
specifically (e.g. `192.168.1.1`) *do* match this pattern and *are* now treated as
`'domain'`-shaped — this is intentional and safe: unlike the rejected `hasToken()`-
based approach (see below), the new `'domain'` branch never calls `hasToken()`, so
there's no separator-character restriction to violate, and `domain = '192.168.1.1'`
is a perfectly valid, correct lookup for IP-hosted credentials (which do occur in
this dataset, e.g. router admin pages).

**Query building (`buildULPWhere`), new `'domain'` branch:**

```sql
domain = 'ledger.com'                 -- exact site match (see below: primary-key accelerated)
OR domain LIKE '%.ledger.com'         -- subdomains (beta.ledger.com, account.ledger.com)
OR url_host LIKE '%ledger.com%'       -- compound/embedded matches (coinledger.io-style,
                                       --   and phishing-adjacent domains that embed the
                                       --   target string, e.g. ledger.com.evil-site.net)
OR email_domain LIKE '%ledger.com%'   -- credentials with a matching email domain
```

All four conditions reuse existing columns; no new materialized columns needed. The
`url_host`/`email_domain` conditions are accelerated by the 1b resize above.

**Why `domain =` and `domain LIKE 'prefix%'` are effectively free**: `domain` is the
table's actual physical sort key (`ORDER BY (domain, email, imported_at)`). Verified
via `EXPLAIN indexes=1`: both exact match and prefix match get `PrimaryKey` binary-
search pruning — 11 of 8833 granules read (99.9% pruned), ~100ms, confirmed stable
across repeated runs and multiple real domains. This required zero new indexes; it's
already true of the table today. `domain` is also already stored consistently
lowercase (verified: 0 rows differ from `lower(domain)`), so no case-normalization
trap.

**Why the four conditions are combined with a single `OR`, not split into separate
queries** — see "Rejected: UNION-based query restructuring" below.

### 3. Keeping this fixed across future content-dedup swaps (`lib/content-dedup.ts`)

The rewrite+swap sequence (see `docs/superpowers/specs/2026-07-07-content-dedup-rewrite-swap-design.md`)
creates its replacement table (`ulp.credentials_cdedup_auto`) via
`rewriteCreateTableDdl(showCreateSql, AUTO_DEDUP_TABLE)`, which faithfully clones
whatever DDL the live table currently has — including index gaps, if any exist at
swap time.

Fix: immediately after that table is created (before the populate `INSERT ...
SELECT` step runs), apply the same index-ensuring statements as DDL v17, against the
new (still-empty) table. Because the table has no data yet, this is `ADD INDEX` only
— no `MATERIALIZE INDEX` backfill is needed at all, since the subsequent populate
insert computes each index as it writes rows. This is strictly cheaper than
re-checking after the swap (which would require a real backfill against a
already-populated 500M+ row table).

To prevent the migration file and the swap code from silently drifting apart over
time (one gets a new index, the other doesn't), both pull the list of "indexes
search depends on" from one shared definition rather than maintaining two separate
copies of the DDL strings.

## Rejected Alternatives

**`text()` index with `tokenizer = ngrams` + `hasAllTokens()`, replacing `ngrambf_v1`
entirely.** ClickHouse's current documentation describes `ngrambf_v1`/`tokenbf_v1` as
deprecated in favor of the native `text()` index, and `hasToken()` as discouraged in
favor of `hasAnyTokens`/`hasAllTokens` (better semantics, no separator-character
restriction — `hasAllTokens(col, 'ledger.com')` doesn't throw the way
`hasToken(col, 'ledger.com')` does). This looked like it would solve both the ngram
sizing problem and the dotted-term problem in one step, with no application-level
string-splitting logic needed. Built and tested against a 5M-row real-data sample
before trusting it further: correctness broke down at scale. `hasAllTokens(url_host,
'ledger')` returned 2404 rows with its skip index active but only **277** with the
index forced off (`use_skip_indexes=0`) — ground truth was 2394. The function itself
does not reliably implement substring matching against an `ngrams`-tokenized column
on this ClickHouse version (26.3.17.4), regardless of what the documentation
describes. This would have shipped a search feature that silently drops the large
majority of true matches — worse than the slow-but-complete status quo. Not used.
`hasToken()` against the (already-planned, differently-tokenized) `splitByNonAlpha`
index was separately verified correct (see 1a) and is unaffected by this finding.

**Splitting dotted terms into per-segment `hasToken()` calls, ANDed together, plus a
`position()` exactness recheck.** The original plan for handling e.g. "ledger.com":
split on `.`, require `hasToken(col,'ledger') AND hasToken(col,'com')` (index-
accelerated) plus `position(col, 'ledger.com') > 0` (exactness guard against e.g. an
unrelated `.com` page that separately mentions "ledger"). Technically correct, but
superseded once the actual use case was clarified as "site lookup" (searching
ledger.com, trezor.io, safepal.com — complete canonical domains) rather than generic
substring search across URL paths and passwords. The `domain`/`url_host`/
`email_domain`-based design (Section 2) serves that use case directly, is simpler
(no `hasToken()` involvement for domain-shaped terms at all, sidestepping the
separator-character restriction entirely rather than working around it), and is
faster for the primary case (exact match rides the primary key). Trade-off, stated
plainly: the new design will not find a domain string that appears only incidentally
inside a URL path or password on an unrelated site. Accepted, given the clarified
use case.

**UNION-based query restructuring**, to avoid the combined `OR`'s pruning being
bounded by its weakest branch. Verified directly at full scale
(`domain = 'x' OR domain LIKE '%.x' OR url_host LIKE '%x%' OR email_domain LIKE
'%x%'`, real 562M-row table): the combined condition shows 0/8833 granules pruned
even though `domain = 'x'` alone gets 11/8833 — confirming the OR does poison the
fast path, same pattern observed everywhere else in this investigation. Rewriting as
`UNION ALL` of four independently-optimized sub-queries (each getting its own best
index) was built and measured: ~6.2–6.4s for the plain `OR` vs. ~3.8–4.3s for the
`UNION` version, on genuinely cold (never-cached) search terms — a real but modest
~35–40% improvement, *not* the dramatic win a first (cache-warmed, misleading) test
run suggested. The response still has to wait for the slowest of the four branches
before it can return sorted, paginated results, so `UNION` doesn't hide the ngram
branches' cost the way it might for a simple existence check. Given that gain, the
added cost was judged not worth it: every other filter in `route.ts` (country tier,
login type, date range, etc.) would need to be duplicated into all four branches
instead of appearing once, and the change would touch the count/pagination/cursor
logic, which has its own documented history of subtle breakage (see `route.ts`'s
existing comments on `MEMORY_LIMIT_EXCEEDED` and `LIMIT BY` sort materialization).
Decision: ship the simpler `OR` design plus the 1b index resize (which benefits both
approaches equally) rather than the `UNION` restructuring.

## Testing

1. **Disposable-clone verification** (required before touching the live table,
   matching this session's established practice): rebuild a clone of
   `ulp.credentials` (or reuse the `_ddltest` pattern from the 2026-07-09
   investigation), apply DDL v17's index changes, and confirm via `EXPLAIN
   indexes=1` that granule pruning genuinely improves for representative queries
   (a common bare word, a rare bare word, an exact domain, a subdomain, a compound-
   match domain) — the same checks performed live during this design session,
   captured as a repeatable step rather than one-off investigation.
2. **Unit tests** for `parseULPQuery`'s new classification (`'domain'` type: dotted
   hostnames match, IPs match, URLs-with-paths/spaces/empty-labels don't) and
   `buildULPWhere`'s new branch (exact SQL shape, parameter escaping for `_` as a
   LIKE wildcard, negation handling), matching this file's existing test style.
3. **Live rollout verification**: after DDL v17 lands on the real table (via normal
   deploy + next migration run), spot-check real searches — an exact domain
   (ledger.com), a term expected to hit the subdomain/compound branches, and a
   plain bare word (regression check on the existing, unchanged `'token'` path) —
   confirming both correctness (expected rows returned) and the measured speed
   improvement (roughly 10s+ → single-digit seconds for a cold dotted term; sub-
   second for exact-domain-dominated cases).
4. **Content-dedup swap verification**: exercise a rewrite+swap cycle against a
   disposable clone (per the existing 2026-07-07 design's own testing section) and
   confirm the new table has the full search index set immediately after creation,
   before the populate step runs.

## Error Handling

Consistent with the existing migration runner: each DDL statement is wrapped by the
existing `runMigration()` helper (non-fatal errors logged via `console.warn`, not
thrown), and `MATERIALIZE INDEX` is fire-and-forget in the background, matching
every prior DDL version. The content-dedup swap-safety addition (Section 3) follows
the same non-fatal pattern already used for the rest of that file's error handling —
if the index-ensuring step fails, it logs and the swap proceeds (the same
degraded-but-functional state as today, not a new failure mode), rather than
blocking the swap on index creation succeeding.
