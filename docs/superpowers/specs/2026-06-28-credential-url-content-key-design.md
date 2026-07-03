# Credential URL Content-Key Normalization Design

## Objective

Collapse credential rows that differ only by URL scheme (`http://` / `https://` / none) or a single trailing slash so they are recognized as the same credential, across the credentials browser view *and* the two storage-level content-dedup passes (the daily cron and the manual purge script) — without changing how `email`/`password` are compared or how a survivor is chosen among duplicates.

## Confirmed Requirements

- The content key for `(url, email, password)` treats `http://`, `https://`, and no-scheme forms of the same URL as identical.
- The content key also treats a URL with and without one trailing slash as identical.
- `email` and `password` remain compared byte-exact — no case-folding or other normalization.
- The change applies to all three existing consumers of this content key: `lib/ulp-dedupe.ts` (view), `lib/content-dedup.ts` (daily cron, destructive), and `scripts/dedup-credentials-content.sh` (manual one-time purge, destructive).
- Survivor selection (which physical row is kept among a duplicate group) is unchanged in both destructive surfaces.
- Existing safety gates are unchanged: `CONTENT_DEDUP_APPLY` report-only default, `minExcessToApply` threshold, the script's dry-run-by-default behavior and `_predup` rollback table.

## Root-Cause Findings

The credentials browser's `dedupe=1` view collapses rows via `LIMIT 1 BY url, email, password` (`lib/ulp-dedupe.ts`). `url` is the raw imported value, untouched by scheme or trailing slash. The same physical credential, recorded once as `https://host/login` and once as `host/login` (or `host/login/`), produces two different `url` strings and therefore two different content keys — confirmed directly in a credentials-browser screenshot, where `didierronald@gmail.com` / `Ronald10@` on `affiliate.ledger.com` appears as all four combinations of {`https://`, none} × {trailing slash, none}.

The identical literal key `(url, email, password)` is independently duplicated in two further places that perform real deletions against the 1.41-billion-row `ulp.credentials` table:

- `lib/content-dedup.ts` — a scheduled daily cron (`lib/dedup-cron.ts`, default every 24h, anchored to 04:00 UTC) that runs `ALTER TABLE ulp.credentials DELETE WHERE ...`, gated by `CONTENT_DEDUP_APPLY` (defaults to `false` / report-only per `docker-compose.yml`).
- `scripts/dedup-credentials-content.sh` — a manual, dry-run-by-default rewrite-and-swap operator script.

None of the three currently treat scheme or trailing-slash variants as the same credential, so the same underlying credential can occupy 2-4x the row count it should across all of them.

## Design

### Shared URL-normalization primitive

New module `lib/url-content-key.ts`:

```ts
export const URL_CONTENT_KEY =
  `replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '')`
```

Strips a leading `http://`/`https://` (case-insensitive, scoped via RE2's `(?i:...)` non-capturing group), then strips one trailing `/`. Nothing else about the URL — path, query string, case beyond the scheme token — is touched. `email` and `password` are not part of this module; each consumer keeps referencing them exactly as it already does.

**Update, post-implementation: verified.** `(?i:...)` was confirmed against a real ClickHouse instance (ClickHouse 26.7.1.110, via the public `play.clickhouse.com` playground — this project's own Docker daemon was never reachable from the dev machine that did this work, so the playground substituted for it using only literal test strings, no real data). Five cases checked: mixed-case scheme + trailing slash, the exact `http://affiliate.ledger.com/` example from the original bug report, a bare no-scheme host, a double trailing slash (confirms exactly one is stripped, not all), a mid-string `http` substring that must NOT be stripped (confirms the `^` anchor), and a fully mixed-case scheme. All five behaved correctly. The fallback below is no longer needed but kept for the record.

~~**Unverified assumption, flagged honestly:**~~ `(?i:...)` is documented RE2 syntax, but it hasn't been run against this project's actual ClickHouse instance — there is no Docker daemon reachable from this dev machine right now. If it doesn't parse, ClickHouse will reject the query with a loud syntax error (not a silent correctness bug), and the fallback is trivial: drop the case-insensitivity and match only the lowercase form (`'^https?://'`), which covers every example seen in this dataset so far — scheme tokens here are always lowercase. Confirm the `(?i:...)` form against a real query during implementation before relying on it.

### View-level: `lib/ulp-dedupe.ts`

`DEDUPE_BY` becomes `` `${URL_CONTENT_KEY}, email, password` ``, importing `URL_CONTENT_KEY` from the new module. `dedupeLimitBy`/`dedupeCountExpr` are unchanged — they already just interpolate `DEDUPE_BY`.

### Storage-level cron: `lib/content-dedup.ts`

`CONTENT_KEY` becomes `` `${URL_CONTENT_KEY}, email, password` ``, same pattern. `FULL_HASH` (survivor tie-break) and `CONTENT_DUPLICATE_PREDICATE` are otherwise unchanged — they already reference `CONTENT_KEY` and inherit the new grouping automatically. `MUTATION_MARKER` is still derived from `CONTENT_KEY`, so the in-flight-mutation substring check stays correct by construction regardless of the key's complexity.

### Storage-level manual script: `scripts/dedup-credentials-content.sh`

`KEY=` gets the identical regex hand-copied (bash can't import TS), with a comment pointing at `lib/url-content-key.ts` as the source of truth to stay in sync with — mirroring how this script's header already cross-references `lib/content-dedup.ts`. `ORDER=` keeps `imported_at` last for earliest-row survivor selection, unchanged in shape.

## Error Handling and Data Safety

- No change to any existing gate: `CONTENT_DEDUP_APPLY` still defaults to report-only; `minExcessToApply` (default 1000) still applies; the script is still dry-run unless `APPLY=1`; the `_predup` rollback table is still created before any swap.
- Broadening the grouping key will increase the measured "excess" duplicate count substantially (every scheme/slash variant now counts toward it). **Before deploying the `content-dedup.ts` change, confirm what `CONTENT_DEDUP_APPLY` is actually set to in the production `.env`.** If it is `true`, the next scheduled tick will delete a meaningfully larger batch of rows than before, automatically, within `DEDUP_CRON_HOURS` of deploy. If so, deploy during a window where the result can be watched, or temporarily raise `DEDUP_MIN_EXCESS` until the new baseline is confirmed sane.
- The manual script remains dry-run by default; review its stats/worst-offenders output before passing `APPLY=1`.
- No change to what counts as a duplicate for `email`/`password` — only `url` comparison is affected, so this cannot merge two rows that have genuinely different login or password values.

## Testing

- `__tests__/ulp-dedupe.test.ts`: update `DEDUPE_BY`/`dedupeLimitBy`/`dedupeCountExpr` expectations to assert against the new `URL_CONTENT_KEY`-based string, importing the constant rather than hand-duplicating the regex in the test.
- `__tests__/content-dedup.test.ts`: update `CONTENT_KEY` and the `buildDeleteSql`/`buildStatsSql` substring assertions the same way.
- New test coverage for `lib/url-content-key.ts` asserting the exact SQL fragment text.
- `scripts/dedup-credentials-content.sh` has no automated test today, consistent with the rest of the suite (which covers `lib/` and API routes, not operator shell scripts). Verification is the script's own dry-run output, reviewed manually before `APPLY=1`. This dev environment has no Docker daemon reachable, so this step has to run wherever ClickHouse actually is (dev or prod host).
- `npx tsc --noEmit` clean.

## Deployment and Operations

The view-level and cron changes ship with the normal `app`-only rebuild:

```bash
cd ~/ulp-suite
git pull
docker compose up -d --build app
```

The manual script requires no deploy — it runs directly via `bash scripts/dedup-credentials-content.sh` (dry-run) / `APPLY=1 bash scripts/dedup-credentials-content.sh` (apply) on whichever host has `docker exec ulpsuite_clickhouse` access, independent of the app container.

Recommended order: ship the view-level fix first (purely reversible, visible immediately in the browser), confirm it looks right, **then** check the prod `CONTENT_DEDUP_APPLY` value before shipping the cron change, then run the manual script's dry-run last to see the actual scope before ever passing `APPLY=1`.

## Out of Scope

- Normalizing `email` or `password` (case-folding or otherwise) — not requested, and password-case differences may be genuinely distinct credentials rather than capture artifacts.
- Normalizing query strings, deeper path differences, or `www.` prefixes on the URL.
- Rewriting the stored `url` value itself (a parser-level change) — this only changes the matching key used for grouping, not any stored data.
- Changing survivor-selection logic in either destructive surface.
