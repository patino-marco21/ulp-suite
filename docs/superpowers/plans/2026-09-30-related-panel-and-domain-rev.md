# Related panel fix and `proj_domain_rev` — execution record

> **For agentic workers:** executed inline (superpowers:executing-plans) the same day the design was approved; this file records what was run, in order, so the live gates can be repeated. Spec: `docs/superpowers/specs/2026-09-30-related-panel-and-domain-rev-design.md`.

**Goal:** make the Credentials row sheet's Related panel return rows (Part 1), and give the monitor's `domain` candidate scan a reversed-key partial projection like `proj_email_domain_rev` (Part 2).

**Architecture:** Part 1 moves the three `/api/related` queries into `lib/related-queries.ts` as raw-column inner queries (primary-key-order sample) wrapped by an outer `NORM_COLS` select. Part 2 generalizes `lib/credentials-projections.ts` over a `{ name, body }` descriptor, adds `proj_domain_rev` (`SELECT _part_offset ORDER BY reverse(domain)`), a reversed predicate builder, a readiness-gated resolver branch, DDL v24, an init-SQL mirror, a third dedup-tick restorer and a script flag.

**Tech stack:** Next.js 15 route + ClickHouse 26.3 (single-replica ReplicatedMergeTree) + vitest source-contract tests.

## Global constraints

- Never drop `ulp.credentials_predup_auto` (the user's call). Never restart the ClickHouse container. No table rebuilds.
- Work happens on branches in the main checkout (`/home/cole/ulp-suite`), not a worktree: `docker compose` must run from this directory. Part 1: `perf/related-panel-split`; Part 2: `perf/domain-rev-projection`.
- Every timing uses `--use_query_cache=0` (this server's default profile caches results for 30 s) and `SYSTEM DROP QUERY CONDITION CACHE` before it. Compare cold runs only.
- `proj_domain_rev` body is exactly `SELECT _part_offset ORDER BY reverse(domain)`; MATERIALIZE settings `mutations_sync = 1, max_execution_time = 3300, timeout_overflow_mode = 'throw'`; DDL version becomes 24; `PHASE1_MAX_EXECUTION_TIME` stays 90.
- Never run `--restore-projections` casually: it re-materializes the 90 GiB `proj_imported_desc`. The one-shot for this work is `--restore-domain-projection`.

## Part 1 — related panel (done, merged ed26833, deployed)

- [x] **Task 1: `lib/related-queries.ts` + route + tests.** Measured the plain split first (popular logins and passwords read the whole table: 9.5 s and 21.9 s), then chose `ORDER BY domain, email` for the inner query; all nine probes 0.8-1.1 s cold, three popular buckets together 1.26 s. `__tests__/related-queries.test.ts` (27 tests, a mutation check fails 6 of them).
- [x] **Deploy.** `DOCKER_CONFIG=<dir with {}> docker compose up -d --build app`; the deployed `/app/.next/server/app/api/related/route.js` contains the inner/outer text. Not exercised through the browser (the route needs a login).

## Part 2 — `proj_domain_rev`

- [x] **Task 2: sandbox probe** (`ulp.zz_probe_domain`, 80.1M rows). Found that `domain` needs `optimize_distinct_in_order = 0` or the planner ignores the projection; result sets identical to the original for the 17-domain monitor and for facebook.com.
- [x] **Task 3: `lib/credentials-projections.ts`** generalized (existing email_domain exports kept as wrappers; all 41 existing tests unchanged), `proj_domain_rev` exports added.
- [x] **Task 4: `lib/domain-match.ts`** `buildReversedCandidateWhereClause(column, domains)` with `buildEmailDomainRevCandidateWhereClause` and `buildDomainRevCandidateWhereClause` as wrappers.
- [x] **Task 5: `lib/monitor-match-resolver.ts`** per-column readiness check; `REVERSED_KEY_SCANS` table gives each column its projection, builder and extra settings.
- [x] **Task 6: schema plumbing.** DDL v24 (`ADD PROJECTION IF NOT EXISTS`, no MATERIALIZE), init SQL mirror, `restoreDeferredProjections` order email_domain, domain, imported_desc, `--restore-domain-projection`.
- [x] **Task 7: tests.** `credentials-projections-domain.test.ts`, `domain-match-domain-rev.test.ts`, `monitor-match-resolver-domain-rev.test.ts`; two existing test files adapted (readiness answered per projection name; DDL-version assertions survive v24). Mutation checks: dropping the distinct-in-order setting fails 1, pointing the domain readiness at the email projection fails 3, keeping `endsWith` in the builder fails 2. Suite after: 86 files / 1,295 tests.
- [x] **Task 8: live Gate D0.** Passed; the numbers are in the spec's Results section (17-domain scan 16.9 s -> 0.30 s, identical result sets, 6.62 GiB, peak container memory 2.5 GiB). Commands:

```bash
export DOCKER_CONFIG=<dir containing config.json with {}>
cd /home/cole/ulp-suite
# restore (ADD + MATERIALIZE per partition behind the disk guard), from a throwaway container on the compose network
docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app --env-file .env \
  -e CLICKHOUSE_HOST="http://clickhouse:8123" \
  node:24-bookworm-slim npx tsx scripts/run-content-dedup-once.ts --restore-domain-projection
# end-to-end check of the real resolver (temporary script, delete afterwards): scripts/tmp-resolve-monitor.ts
docker exec ulpsuite_clickhouse clickhouse-client --query "SYSTEM DROP QUERY CONDITION CACHE"
docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app --env-file .env \
  -e CLICKHOUSE_HOST="http://clickhouse:8123" \
  node:24-bookworm-slim npx tsx scripts/tmp-resolve-monitor.ts
```

- [ ] **Task 9: deploy** (`docker compose up -d --build app`; expect `DDL v24 applied`), merge, push, memory.
