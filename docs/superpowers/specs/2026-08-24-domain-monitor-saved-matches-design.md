# Domain Monitor Saved Matches — Design

## Problem

The "View Matches" panel queries the 2.4B-row `ulp.credentials` table live on every
open ([app/api/monitoring/monitors/[id]/matches/route.ts](../../../app/api/monitoring/monitors/[id]/matches/route.ts)).
For a monitor whose domain-suffix conditions can't be pruned by ClickHouse's bloom
filters, this measured at 50.76s for phase 1 alone against the live container —
already past the route's own 45s budget, and consistent with the reported "over
three and a half minutes, zero results."

Two further, compounding bugs surfaced during investigation:

1. **Data bug**: the one existing monitor ("Dedicated / general hardware wallets")
   has all 17 domains stored with a trailing slash (`"trezor.io/"`) or an extra path
   (`"blockstream.com/jade/"`). `domain`/`email_domain` in ClickHouse store bare
   hostnames, so none of these patterns can ever match anything, independent of
   query speed. Root cause: monitor create/update only `.trim().toLowerCase()`s
   input ([app/api/monitoring/monitors/route.ts:87](../../../app/api/monitoring/monitors/route.ts)),
   no protocol/path stripping.
2. **Silent cron failure**: `lib/monitor-rescan-cron.ts` already attempts a
   per-monitor rescan every 15 minutes (production only, gated by `NODE_ENV`), but
   it has timed out on this monitor every tick since creation (`Timeout exceeded:
   elapsed 60049ms, maximum: 60000ms`), caught and only `console.error`'d
   ([lib/monitor-rescan-cron.ts:204-206](../../../lib/monitor-rescan-cron.ts)) —
   `last_triggered_at` stays `NULL` forever, retrying and failing indefinitely with
   no visible trace anywhere in the product. This is the same issue filed out of
   scope as task `task_14757f00` in
   [2026-08-24-saved-searches-hub-design.md](2026-08-24-saved-searches-hub-design.md);
   this design fixes it as part of the broader change (chip dismissed accordingly).

The user wants matches served from a saved/precomputed cache instead of querying
live on every panel open, with a manual escape hatch for "check right now."

## Scope

**In scope:**
- Fix the ClickHouse query so per-monitor domain-suffix matching is index-prunable
  (currently isn't — see Architecture §1).
- New `monitor_matches` SQLite cache table; `GET .../matches` reads from it instead
  of querying ClickHouse.
- Extend the existing `monitor-rescan-cron` tick to populate the cache (reusing its
  existing per-monitor ClickHouse call rather than adding a second one) and to
  record success/failure status visibly instead of only `console.error`.
- New `POST .../matches/rescan` endpoint + "Rescan now" button for on-demand
  refresh.
- Domain normalization at monitor create/update time, plus a one-time correction of
  the existing monitor's 17 domains.

**Out of scope:**
- Changing `rescan_interval_hours`/`rescan_mode` semantics or their settings UI —
  reused as-is.
- Any change to webhook alerting logic itself (`monitor_alerts`,
  `monitor_webhook_map`) beyond reusing its already-fetched query results —
  behavior unchanged.
- The `/saved-searches` hub page itself — already shipped
  ([2026-08-24-saved-searches-hub-design.md](2026-08-24-saved-searches-hub-design.md));
  this design's dialog changes apply there too since it shares
  `useMonitorMatches`/`MonitorMatchesDialog`.
- `scripts/init-database.sql`'s stale MySQL schema — confirmed unreferenced by
  anything that runs; not touched.

## Architecture

### 1. ClickHouse query fix: `idx_ngram_domain`

Current predicate ([lib/domain-match.ts:163-177](../../../lib/domain-match.ts)) is
`domain = {d} OR endsWith(domain, '.'+{d})`. Per the route's own `EXPLAIN
indexes=1` finding ([route.ts:27-75](../../../app/api/monitoring/monitors/[id]/matches/route.ts)),
the `endsWith` half defeats `idx_bf_domain` entirely (37350→37350 granules;
equality alone prunes to 38) — because `idx_bf_domain` is a plain `bloom_filter`,
which only accelerates equality.

**The fix, in the end, is small:** `email_domain` already had this exact problem
solved. It carries both a `bloom_filter` index (same limitation as `domain`'s) AND
an `ngrambf_v1` skip index, and the ngram one is what actually prunes its
`endsWith()` predicate — that's the documented reason `email_domain` measured fast
(0.24s) while `domain` measured 50.76s for the identical predicate shape. Give
`domain` the same second index type `email_domain` already has, same parameters:

```sql
ALTER TABLE ulp.credentials
  ADD INDEX IF NOT EXISTS idx_ngram_domain domain TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1;
ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_ngram_domain;
```

No predicate rewrite needed — the existing `domain = {d} OR endsWith(domain,
{'.'+d})` shape is unchanged; only a second index type is added. Measured against
the live 2.4B-row table with this index in place: `idx_ngram_domain` pruned
37350→6710 granules for a 2-domain query (the `bloom_filter` index alone had
already pruned 37350→36605 — i.e. essentially nothing), and the full query for the
real "Dedicated / general hardware wallets" monitor's 17 domains completed in
24.9s (down from the 50.76s baseline, and — the number that actually matters —
back inside the route's 45s phase-1 budget with real margin, where before it was
timing out).

**Two other approaches were tried first and empirically disproven against this
table on 2026-08-25** — kept here, in full, so nobody re-attempts either:

1. **A projection ordered by `reverse(domain)`.** Reasoned that a prefix match on
   a reversed string is a suffix match on the original, and prefix matches are
   what a sorted projection can range-prune. True in principle; ClickHouse's
   planner nonetheless never selected this projection for a
   `startsWith(reverse(domain), ...)` predicate — confirmed via `SETTINGS
   force_optimize_projection = 1`, which raised `PROJECTION_NOT_USED` rather than
   using it. A projection ordered by a bare function of a column, it turns out, is
   not reliably recognized as satisfying a range condition over that function —
   distinct from a projection's proven use in this schema for supplying a
   pre-sorted read order (`proj_imported_desc`), which is a different access
   pattern than WHERE-clause pruning.
2. **A `domain_reversed` materialized column + `minmax` skip index on it.** Moving
   the reversal into an actual stored column *did* get selected by the planner —
   but `minmax` only prunes a granule when that granule's value range is narrow,
   which requires the indexed expression to correlate with the table's physical
   storage order. `ulp.credentials` is sorted by forward `domain`
   (`ORDER BY (domain, email, imported_at)`); a *reversed* string has no such
   correlation — two forward-adjacent domains (e.g. differing in the 2nd
   character) can have wildly different reversed forms. Result: 24/25 granules
   pruned on a small disposable test table (built by inserting one big block of
   synthetic rows, then the real test domains — a favorable, non-representative
   order), but only ~35% pruned on the real table (37350→24349) once tested there.
   The lesson generalizes: **validate a `minmax` index's real effectiveness on
   data whose physical order matches production, not a scratch table you built by
   hand** — small-scale validation caught the projection approach's total failure
   correctly, but was actively misleading for `minmax` specifically, because
   `minmax`'s effectiveness is a property of row *order*, not just row *content*,
   and a hand-built scratch table doesn't reproduce that.

Whether this makes the existing two-phase candidate-resolution machinery in
`lib/domain-match.ts` unnecessary (vs. just making both phases fast) was measured,
not assumed: with the ngram index, phase 1's per-column scan is fast enough that
the two-phase split's main remaining value is bounding phase 2's read to an exact
IN-list rather than collapsing to one query — kept as-is; simplifying it further
was not attempted, since it isn't broken and this section already spent its
budget on the indexing question.

Considered following the existing MV pattern from
[2026-06-06-materialized-views-design.md](2026-06-06-materialized-views-design.md)
(`SummingMergeTree`/`AggregatingMergeTree` fed by `CREATE MATERIALIZED VIEW ... TO`)
instead of any of the above. That pattern fits a fixed aggregation dimension
(domain, password, url_host) computed once and shared by all readers. It doesn't
fit here: each monitor has its own arbitrary, user-editable domain list, so
there's no single fixed `GROUP BY` key to materialize against. An index that
accelerates a `WHERE`-clause predicate on an existing column is the right tool for
"look up rows matching one of N patterns," not aggregation.

### 2. New SQLite cache: `monitor_matches` + `monitor_rescan_status`

Added to `initSchema` in [lib/sqlite.ts](../../../lib/sqlite.ts), alongside the
existing `monitor_views`/`monitor_credential_seen` tables:

```sql
CREATE TABLE IF NOT EXISTS monitor_matches (
  monitor_id  INTEGER NOT NULL REFERENCES domain_monitors(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  email       TEXT NOT NULL,
  password    TEXT NOT NULL,
  domain      TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (monitor_id, url, email, password)
);

CREATE TABLE IF NOT EXISTS monitor_rescan_status (
  monitor_id      INTEGER PRIMARY KEY REFERENCES domain_monitors(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK(status IN ('ok', 'failed')),
  error           TEXT,
  attempted_at    TEXT NOT NULL,
  last_success_at TEXT
);
```

`monitor_matches` is fully replaced per monitor on every successful rescan
(delete-then-insert in one transaction) — it's a cache, not a history. `is_new` is
computed and stored at write time (against `monitor_credential_seen`, same logic
`markMatchesNewSinceLastView` already does, moved from read-time to write-time)
rather than recomputed on every read, so it isn't a stored column here — it's
derived once when the API layer reads the cache (see §4).

`monitor_rescan_status` tracks the two things a cache consumer needs that aren't
derivable from `monitor_matches` rows alone: `attempted_at`/`status`/`error`
describe the *most recent* attempt (so a persistent failure is visible instead of
indistinguishable from "hasn't run yet" — the original bug); `last_success_at`
is independent of whether the latest attempt succeeded, and is what "showing
results from `<time>`" reads — needed because a monitor with zero genuine matches
has no `monitor_matches` rows to read a timestamp from.

Primary key on `monitor_matches` is `(monitor_id, url, email, password)`, not
`(monitor_id, url, email)` — the same email/URL can legitimately recur with a
different password across different breach sources, and collapsing those would
silently drop real distinct rows.

### 3. Cron changes: `lib/monitor-rescan-cron.ts`

Same tick, same per-monitor loop — no second cron. After each monitor's ClickHouse
query resolves:
- **Success**: replace that monitor's `monitor_matches` rows, upsert
  `monitor_rescan_status` (`status='ok'`, `attempted_at`/`last_success_at` both
  now), update `last_triggered_at` (unchanged behavior), continue to the existing
  webhook-diff/alert logic using the same result set — no second query.
- **Failure (including timeout)**: upsert `monitor_rescan_status`
  (`status='failed'`, `error=<message>`, `attempted_at` now, `last_success_at`
  unchanged) — this is the fix for the silent-failure bug. `monitor_matches` is
  left untouched; a cache is more useful stale than empty.

This also depends on §1: today's per-domain loop query
([lib/monitor-rescan-cron.ts:93-103](../../../lib/monitor-rescan-cron.ts)) doesn't
even use the two-phase optimization the live route has, so it's the slowest path
in the system today. It moves to the same fixed predicate.

### 4. API changes

`GET .../matches` — replace the ClickHouse call with a `monitor_matches` +
`monitor_rescan_status` read, computing `is_new` against `monitor_credential_seen`
at read time (cheap — SQLite join on a capped ~100-row result, not a ClickHouse
call). Response gains `checked_at` (`last_success_at`, or `null` if never
succeeded) and `stale`/`last_error` fields, remapped to three states the dialog
must distinguish:
- No `monitor_rescan_status` row yet → never scanned.
- `last_success_at` set, latest `status='ok'` → fresh: matches + `checked_at`.
- `last_success_at` set, latest `status='failed'` → stale: last-good matches (or
  genuinely empty, if the last success found none) + `checked_at` (of that last
  success) + `last_error` (of the current failing streak).

`POST app/api/monitoring/monitors/[id]/matches/rescan/route.ts` (new) — admin-only
(matches existing `adminOnly` gating on the Domains sidebar entry), runs one
monitor's fixed query synchronously, writes through to `monitor_matches`/
`monitor_rescan_status` via the same function the cron uses (extracted to a shared
helper, not duplicated), returns the fresh result in the same shape as the GET.
Guards against two overlapping scans of the *same* monitor — e.g. an admin
double-clicking, or the 15-minute cron firing mid-manual-rescan — with an
in-flight lock keyed by `monitor_id` (an in-memory `Set`/`Map` is sufficient given
this is a single-process deployment, see [Dockerfile](../../../Dockerfile)/
[docker-compose.yml](../../../docker-compose.yml)); a per-IP rate limit alone
wouldn't catch two different admins hitting the same monitor.

### 5. UI changes

[hooks/useMonitorMatches.ts](../../../hooks/useMonitorMatches.ts) and
[components/monitor-matches-dialog.tsx](../../../components/monitor-matches-dialog.tsx)
— shared by both `/monitoring` and `/saved-searches` already
([2026-08-24-saved-searches-hub-design.md](2026-08-24-saved-searches-hub-design.md)):
- Add `checkedAt`/`lastError` to hook state; add a `rescanNow()` action calling the
  new POST endpoint, reusing the existing `matchesLoading`/request-sequencing-guard
  pattern so a rescan can't race a panel-switch the same way the initial fetch
  already guards against
  ([useMonitorMatches.ts:30-33](../../../hooks/useMonitorMatches.ts)).
- Dialog header: replace "queried live" copy with "Last checked `<relative
  time>`" / "Not yet scanned" / "Last check failed: `<error>` — showing results
  from `<relative time>`", plus a "Rescan now" button next to it. The existing
  error-vs-empty branch order (error must render before the empty-state check, per
  the comment at
  [monitor-matches-dialog.tsx:39-41](../../../components/monitor-matches-dialog.tsx))
  stays — a hard failure (network/5xx on the GET itself) still needs to out-rank
  "0 rows" the same way it does today; the new stale/failed-cache state is a third
  branch alongside it, not a replacement for it.

### 6. Domain normalization

`app/api/monitoring/monitors/route.ts:87` (POST) and
`app/api/monitoring/monitors/[id]/route.ts:77` (PUT) — replace
`.trim().toLowerCase()` with a `normalizeDomainInput()` helper (new,
`lib/domain-monitor.ts`) that strips a leading scheme (`https://`, `http://`) and
everything from the first `/` onward, then trims/lowercases. One-time data fix:
correct the existing monitor's 17 stored domains the same way (migration or
one-off script, TBD in the implementation plan).

## Data flow

1. Cron tick (every 15 min, production only) or "Rescan now" click → fixed
   ClickHouse query (§1) → `monitor_matches` + `monitor_rescan_status` written
   (§2/§3).
2. Dialog open → `GET .../matches` → pure SQLite read (§4), always fast, three
   distinguishable states (never-scanned / fresh / stale-after-failure).
3. "Rescan now" → `POST .../matches/rescan` → same write path as the cron,
   response feeds the dialog directly (no need to re-GET).

## Error handling

- Cache read (`GET`) has no ClickHouse-shaped failure mode anymore — it never
  touches ClickHouse, so it can't time out. Ordinary SQLite errors are handled
  the same way the rest of the app already handles them.
- Cron/rescan write failures are captured in `monitor_rescan_status` instead of
  only `console.error` — visible in the dialog (§5) instead of invisible.
- The in-flight-scan lock (§4) makes a concurrent rescan request a no-op/409
  rather than two overlapping ClickHouse queries for the same monitor.

## Testing

- `lib/domain-match.ts` predicate rewrite: extend the existing real-database
  regression test style (`is_new` cross-referencing against a real database) to
  assert the reversed-domain predicate returns the same *rows* as the old
  predicate across a range of domains (including the `eviltrezor.io`-shaped
  false-positive case), plus a timing assertion against the live container,
  consistent with this repo's practice of verifying ClickHouse changes
  empirically rather than by diff-reading alone.
- `normalizeDomainInput()`: unit tests for scheme/path/trailing-slash stripping,
  including the exact 17 inputs from the existing monitor.
- Cron: extend rescan-cron tests to cover the status-write-on-failure path
  (currently untested — the timeout is only ever `console.error`'d today, nothing
  asserts on it).
- New `POST .../rescan` route: success path, concurrent-scan lock, and that a
  failed rescan doesn't clobber a previous good `monitor_matches` snapshot.
- Dialog: new state (`checked_at`/`last_error`/stale) rendering, extending
  existing coverage for the error-before-empty branch order.
