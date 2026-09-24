# Scale Audit Follow-ups Design

**Date:** 2026-09-24
**Status:** Approved

## Goal

Close out the remaining actionable items from the 2026-08-26 scale audit (published as a Claude Artifact, "ULP Suite Scale Audit") and its 2026-09-24 re-verification pass: findings 1, 3, and 6, plus four adjacent items (A–D) surfaced during that re-verification. Finding 4 (multi-instance Redis/BullMQ) and finding 7 (sharding vs. replication — context only, no defect) are explicitly out of scope; see "What This Does NOT Change."

## Problem Statement

Five independent pieces of debt, all previously diagnosed and re-confirmed still open as of today:

1. **Finding 1 (Critical):** `email_domain` search on `ulp.credentials` reads all 2.4B rows despite two dedicated skip indexes, because the column is uncorrelated with the table's `ORDER BY (domain, email, imported_at)`.
2. **Finding 3 (Medium):** the public, documented `/api/v1/search/credentials` endpoint still paginates with `LIMIT`/`OFFSET`, while the internal Credentials Browser (`/api/credentials`) already uses a tested keyset-cursor implementation (`lib/cursor-pagination.ts`).
3. **Finding 6 (Medium):** the test suite has no database of its own — `lib/sqlite.ts` falls back to `./data/ulp.db` whenever `SQLITE_PATH` is unset, which is true in both `vitest.config.ts` and `.env.example` today.
4. **Items A–D:** two live `npm audit` vulnerabilities with fixes available, a stale row-count comment, `@clickhouse/client` version drift next to a fragile fix, and five orphaned `.claude/worktrees/` checkouts.

## Scope Decisions

- **Finding 4 (multi-instance) is deferred, not built.** Confirmed with the user: no second app instance is planned, the README states a single-server target, and building Redis-backed BullMQ/rate-limiting now would be speculative infrastructure for a scaling scenario that doesn't exist. Left exactly as documented in the audit.
- **Finding 1's fix is scoped to measurement, not production.** Per the punch list's own framing ("prototype... measure real pruning"), this pass builds a separate, droppable test table with a representative sample — never touches `ulp.credentials`'s live schema, never added to `lib/clickhouse-migrations.ts`. Applying a validated projection to production is a distinct, later decision.
- **Finding 6's fix lives entirely in test configuration.** `lib/sqlite.ts`'s production fallback (`./data/ulp.db` when `SQLITE_PATH` unset) is untouched — real deployments keep their current behavior. Only Vitest's own setup changes.
- **Finding 3 is additive only.** No existing request or response shape for `/api/v1/search/credentials` changes for callers that don't opt in.

## 1. Housekeeping (A, C, and part of B)

- **Stale comment (C):** `app/api/credentials/route.ts:46` — replace "91M rows" with the current live-measured figure (2.4B+, cited the same way the surrounding comments already cite their sources).
- **`npm audit` fixes (A):** run `npm audit fix` for the `@vitest/mocker` and `browserslist`/`baseline-browser-mapping` advisories, then verify with `npm ci` plus a direct `node_modules/<pkg>/package.json` version/mtime check — not just a second `npm audit` — per the exact silent-failure mode already documented for this project. Re-run `npm test`/`typecheck`/`lint` afterward.
- **`@clickhouse/client` version check (B):** read the 1.19.0→1.23.1 changelog for anything touching HTTP streaming or JSON parsing. If nothing looks relevant to the `http_wait_end_of_query` workaround, bump and re-run the full test suite (which includes the timeout-regression coverage); if anything looks risky, leave it at 1.19.0 and document why instead of bumping blind.
- **Worktree cleanup (D):** for each of the 5 checkouts under `.claude/worktrees/`, check `git status` (uncommitted changes) and whether its branch is merged into `main`. Remove only checkouts that are both clean and merged; leave anything else in place and report it instead of guessing.

## 2. SQLite test isolation (finding 6)

**Architecture:** a new Vitest `globalSetup` module builds one template database by calling `lib/sqlite.ts`'s existing schema functions (`initSchema` via `getDb()`, which already includes the race-safe `seedDefaultAdmin`) against a fresh file under a scratch directory — never `./data/`. `globalSetup` runs once for the whole test run, before any worker starts.

A `setupFiles` module then runs once per worker, before that worker loads any test file: it reads Vitest's own per-worker id (`process.env.VITEST_POOL_ID` — confirming the exact mechanism against the installed Vitest version during implementation), copies the template file to a worker-specific path, and sets `process.env.SQLITE_PATH` to that copy *before* anything imports `lib/sqlite.ts` — required, since `lib/sqlite.ts` reads that env var once at module-evaluation time. `globalSetup`'s teardown (its returned function) deletes the template and all worker copies after the run completes.

This closes both previously-seen symptoms with one mechanism: the main checkout's `SQLITE_READONLY` wall (tests never touch `./data/ulp.db`) and the fresh-worktree concurrent-seed race (each worker owns an independent file). `lib/sqlite.ts`'s own fallback logic is not modified.

**Side effect:** CI's current job-level `env: SQLITE_PATH: /tmp/ci-test.db` (`.github/workflows/ci.yml`) becomes redundant once every worker sets its own path — remove it as part of this change rather than leave two competing mechanisms in place.

**Testing:** run the full suite in the main checkout (`npx vitest run`, no manual `SQLITE_PATH=...` prefix) and confirm it's green without the workaround that's been required since Aug 16. Run it a second time immediately after, to catch any leftover-state issue between runs (stale template/worker files not cleaned up).

## 3. v1 API cursor pagination (finding 3)

**Current state** (`app/api/v1/search/credentials/route.ts`): `page`/`limit` → `offset`, single fixed sort (`ORDER BY imported_at DESC`), response `{ success, results, total, page, pages, query }`.

**Change:** add an optional `cursor` param, reusing `lib/cursor-pagination.ts` exactly as the internal `/api/credentials` route already does — same `encodeCursor`/`decodeCursor`/`buildCursorWhere` calls, same `'imported_desc'` sort key (the only order this endpoint has ever used), same conventions:

- `cursor` present → decode it, append `buildCursorWhere('imported_desc', cursor)`'s clause to the existing `WHERE`, drop `OFFSET` entirely, skip the `count()` query (`total: null`, matching the internal route's "client keeps the page-1 total" convention), omit `page`/`pages` (set `null`).
- `cursor` absent → today's exact behavior, byte-for-byte: same query, same `page`/`pages`/`total`.
- **Both cases** get a new `next_cursor` field: `rows.length === limit ? encodeCursor('imported_desc', lastRow) : null` — identical heuristic to the internal route. This is the backward-compatible migration path: a caller who has never heard of `cursor` still gets `next_cursor` in its response from page 1 onward and can switch to cheap keyset paging at any point, with no opt-in flag and no breaking change.

All five columns `buildCursorWhere`/`encodeCursor` need for `imported_desc` (`imported_at, domain, email, url, password`) are already in this route's existing `SELECT` — no query columns change.

**Error handling:** an invalid/undecodable cursor is treated the same as "no cursor" (matches the internal route's `if (cursor && cursor.sort === sortKey)` guard) — falls back to offset mode rather than a hard 400, mirroring the existing, already-tested convention rather than inventing a new error contract for this port.

**Docs:** update whatever currently documents this endpoint (README/API reference) to recommend `cursor`/`next_cursor` for deep pagination, with `page` still documented as supported for shallow/random access.

**Testing:** extend this route's existing test coverage (if any) or add a new test file mirroring `lib/cursor-pagination.ts`'s own tests — verify offset-mode is byte-for-byte unchanged, verify cursor-mode returns the correct next page and a `null` cursor on the last page, verify identical row identity between an offset walk and a cursor walk over the same result set.

## 4. ClickHouse `email_domain` projection experiment (finding 1)

**Table:** `ulp.credentials` is `ENGINE = ReplicatedMergeTree`, `ORDER BY (domain, email, imported_at)`, `PARTITION BY toYYYYMM(imported_at)` — `email_domain` has no correlation to any of that, which is the root cause the original finding already diagnosed correctly.

**Sample:** a standalone table (working name `ulp.credentials_email_domain_sample`, plain `MergeTree`, not replicated — a throwaway artifact, not added to `lib/clickhouse-migrations.ts` or the init SQL) populated via a single deterministic-hash filter (e.g. `cityHash64(email, password) % 100 = 0`, ~1% ≈ 24M rows) rather than an `ORDER BY rand()` sort, so building it is one sequential pass over the source table instead of a full shuffle. Minimal columns: enough to reproduce the original finding's query shape (`email_domain`, plus `domain`/`email`/`imported_at` for realism) — not a full copy of every column, since this experiment doesn't need the rest.

**Projection:** add a projection ordered by `email_domain` and materialize it. Confirm against ClickHouse 26.3's actual current docs (not last week's search snippets) whether the *partial*-projection syntax (storing only the sort key + `_part_offset`, reading remaining columns from the base table — cheaper than this codebase's existing `proj_imported_desc`, which is a full-column projection) is available and stable on this version before committing to that form over a standard full projection.

**Measurement:** `EXPLAIN indexes=1` and real timed queries against the sample table, both for a single `email_domain =` filter and an OR'd multi-domain filter (mirroring the original finding's methodology), compared against the same queries run without the projection enabled. Plus the storage cost itself, read directly from `system.parts` before and after `MATERIALIZE PROJECTION` — extrapolated to what it would cost at the real table's 333GB.

**Output:** a written verdict — does the projection actually prune at this cardinality, and at what storage cost — that a later, separate decision can act on. This pass does not modify `ulp.credentials`.

## What This Does NOT Change

- **No Redis, no BullMQ, no rate-limiter change** — finding 4 stays exactly as documented in the audit; `lib/rate-limiter.ts` and `instrumentation.ts` are untouched.
- **No production ClickHouse schema change** — the projection experiment is a separate table, never `ulp.credentials`, never added to the migration system.
- **No change to `/api/v1/search/credentials`'s behavior for existing callers** — offset-mode is byte-for-byte identical; `cursor` is opt-in.
- **No change to `lib/sqlite.ts`'s production default** — only Vitest configuration changes.
- **Finding 7** (sharding vs. replication) — context only in the audit, no code change proposed here.

## Implementation Order

Independent workstreams, no shared state between them — can be built and verified in any order:

1. Housekeeping (A, C, D, and the B changelog check) — smallest, fastest, unblocks nothing else.
2. SQLite test isolation (finding 6) — worth doing early since a clean, un-worked-around `npx vitest run` makes verifying everything else easier.
3. v1 API cursor pagination (finding 3).
4. ClickHouse `email_domain` projection experiment (finding 1) — largest single piece, produces a measurement/verdict rather than a merge-ready code change.
