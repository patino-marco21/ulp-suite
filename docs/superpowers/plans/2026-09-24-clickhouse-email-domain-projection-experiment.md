# ClickHouse email_domain Projection Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on a representative sample table (not production), whether a `PROJECTION` ordered by `email_domain` actually prunes granules the way the real table's existing skip indexes don't — and at what storage cost — producing a written verdict that a later, separate decision can act on.

**Architecture:** One throwaway `MergeTree` table (`ulp.credentials_email_domain_sample`), never added to `lib/clickhouse-migrations.ts` or the init SQL, built from a deterministic ~1% hash-sample of `ulp.credentials`. A partial projection (`SELECT _part_offset ORDER BY email_domain`, ClickHouse 25.5+ syntax) gets added and materialized once; the `optimize_use_projections` setting toggles projection use on/off per query against that same finalized table, giving a clean before/after comparison without needing two separate table snapshots.

**Tech Stack:** ClickHouse 26.3 (`ulpsuite_clickhouse` container), `docker exec` + `clickhouse-client`.

## Global Constraints

- Never touch `ulp.credentials` itself — every DDL/DML statement in this plan targets `ulp.credentials_email_domain_sample` only.
- Never add this table to `lib/clickhouse-migrations.ts` or `docker/clickhouse/init/01-ulp-tables.sql` — it is not part of the schema-managed system.
- Measure real execution (`read_rows` from `system.query_log`, after `SYSTEM FLUSH LOGS`), not just `EXPLAIN`'s estimate — the original finding already showed `EXPLAIN` optimistically overstated pruning that didn't hold at real execution time; don't repeat that mistake here by trusting `EXPLAIN` alone.
- All commands run via `docker exec ulpsuite_clickhouse clickhouse-client --query "..."` against the live container — this project's established way of touching ClickHouse directly (see project memory on empirical ClickHouse verification).

---

### Task 1: Build the sample table

**Files:** none — this task only touches the live ClickHouse container, no repo files.

**Interfaces:**
- Produces: table `ulp.credentials_email_domain_sample` (columns: `domain String, email String, imported_at DateTime, email_domain String`, `ORDER BY (domain, email, imported_at)` — mirrors the real table's key prefix so the "before" baseline reproduces the same primary-key-order-only pruning behavior finding 1 originally diagnosed).

- [ ] **Step 1: Confirm the container is up and check available disk headroom**

```bash
docker ps --filter name=ulpsuite_clickhouse --format '{{.Names}}\t{{.Status}}'
docker exec ulpsuite_clickhouse df -h /var/lib/clickhouse
```

Expected: container `Up`/`healthy`; note the `Avail` column — the sample table plus its projection should total well under 5 GB, so this is a sanity check, not expected to be tight.

- [ ] **Step 2: Create the sample table**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
CREATE TABLE ulp.credentials_email_domain_sample
(
    domain       String,
    email        String,
    imported_at  DateTime,
    email_domain String
)
ENGINE = MergeTree()
ORDER BY (domain, email, imported_at)
"
```

Expected: no output (success). Verify: `docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_email_domain_sample"` → `1`.

- [ ] **Step 3: Populate it with a deterministic ~1% sample**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
INSERT INTO ulp.credentials_email_domain_sample
SELECT domain, email, imported_at, email_domain
FROM ulp.credentials
WHERE cityHash64(email, password) % 100 = 0
"
```

This is one sequential pass over the source table (no sort), so it's a single full-table-scan-equivalent cost — expect this to take a while given 2.4B source rows; let it run to completion rather than interrupting.

- [ ] **Step 4: Confirm row count and realistic distribution**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM ulp.credentials_email_domain_sample"
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT email_domain, count() AS c
FROM ulp.credentials_email_domain_sample
GROUP BY email_domain
ORDER BY c DESC
LIMIT 10
"
```

Expected: roughly 1% of the real table's row count (per the 2.4B baseline, expect somewhere around 20–25M rows — exact figure depends on current live growth). Record the top 10 `email_domain` values and their counts — Task 2 uses real values from this output, not guessed domains.

- [ ] **Step 5: Record the row count for later extrapolation**

Save the exact count from Step 4 — you'll need it in Task 4 to extrapolate the measured storage overhead to the real table's 2.4B-row / 333GB scale.

---

### Task 2: Measure baseline (no projection) behavior

**Files:** none.

**Interfaces:**
- Consumes: the top `email_domain` values recorded in Task 1 Step 4.

- [ ] **Step 1: Enable query logging for this session and pick test domains**

Use the single most frequent domain from Task 1 Step 4 as `$DOMAIN_1`, and the top 5 domains joined with `OR` as the multi-condition case — substitute the actual values from Task 1's output for the placeholders below.

- [ ] **Step 2: Single-domain filter — EXPLAIN**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
EXPLAIN indexes=1
SELECT count() FROM ulp.credentials_email_domain_sample WHERE email_domain = '<DOMAIN_1>'
"
```

Record the output — note whether it claims any granule pruning at all (there is no projection yet, so it shouldn't).

- [ ] **Step 3: Single-domain filter — real timed execution**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --time --query "
SELECT count() FROM ulp.credentials_email_domain_sample WHERE email_domain = '<DOMAIN_1>' SETTINGS log_queries = 1
"
docker exec ulpsuite_clickhouse clickhouse-client --query "SYSTEM FLUSH LOGS"
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT read_rows, query_duration_ms
FROM system.query_log
WHERE query LIKE '%credentials_email_domain_sample%email_domain = ''<DOMAIN_1>''%'
  AND type = 'QueryFinish'
ORDER BY event_time DESC
LIMIT 1
"
```

Record `read_rows` — expected to equal (or be very close to) the full sample row count from Task 1 Step 4, confirming the baseline has no useful pruning, same as the original finding against the real table.

- [ ] **Step 4: Multi-domain OR filter — EXPLAIN + real timed execution**

Repeat Steps 2–3 with `WHERE email_domain = '<D1>' OR email_domain = '<D2>' OR email_domain = '<D3>' OR email_domain = '<D4>' OR email_domain = '<D5>'` using the top 5 domains from Task 1 Step 4. Record `read_rows` and `query_duration_ms` the same way.

- [ ] **Step 5: Record both baseline results**

You now have, for the sample table with no projection: single-domain `read_rows`/duration, and 5-domain-OR `read_rows`/duration. These are the "before" numbers Task 4's writeup compares against.

---

### Task 3: Add the projection, materialize, and re-measure

**Files:** none.

**Interfaces:**
- Consumes: the same test domains and queries from Task 2.

- [ ] **Step 1: Record pre-projection storage size**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT sum(bytes_on_disk) AS bytes
FROM system.parts
WHERE table = 'credentials_email_domain_sample' AND active
"
```

Record this value — the "before" storage baseline.

- [ ] **Step 2: Add the partial projection**

Uses the ClickHouse 25.5+ partial-projection syntax (store only the sort key + `_part_offset`, read remaining columns from the base table on match) — confirmed available on the running 26.3:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
ALTER TABLE ulp.credentials_email_domain_sample
ADD PROJECTION proj_email_domain
(
    SELECT _part_offset ORDER BY email_domain
)
"
```

If this exact syntax errors on the live server, that's a real, useful finding in itself — record the exact error, then try the fuller form `SELECT domain, email, imported_at, email_domain, _part_offset ORDER BY email_domain` as a fallback (a full, not partial, projection — more storage, but confirms whether the *concept* prunes at all even if the lightest-weight syntax isn't available on this version).

- [ ] **Step 3: Materialize it and wait for completion**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
ALTER TABLE ulp.credentials_email_domain_sample MATERIALIZE PROJECTION proj_email_domain
"
```

Poll until done (materialization is async):

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT is_done, latest_fail_reason
FROM system.mutations
WHERE table = 'credentials_email_domain_sample'
ORDER BY create_time DESC
LIMIT 1
"
```

Expected eventually: `is_done = 1`, empty `latest_fail_reason`. Re-run this query every few seconds until it reports done — at ~24M rows this should complete in well under a minute, not the multi-hour timescale the real 2.4B-row table would need.

- [ ] **Step 4: Record post-projection storage size and the delta**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT sum(bytes_on_disk) AS bytes
FROM system.parts
WHERE table = 'credentials_email_domain_sample' AND active
"
```

Subtract Step 1's value from this to get the projection's storage overhead in bytes for ~1% of the table. Multiply by 100 (and adjust for the exact sample fraction from Task 1 Step 4 if it wasn't exactly 1%) to extrapolate to what this projection would cost at the full 2.4B-row / 333GB table.

- [ ] **Step 5: Re-run the exact same queries from Task 2, with the projection now available**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "
EXPLAIN indexes=1
SELECT count() FROM ulp.credentials_email_domain_sample WHERE email_domain = '<DOMAIN_1>'
"
docker exec ulpsuite_clickhouse clickhouse-client --time --query "
SELECT count() FROM ulp.credentials_email_domain_sample WHERE email_domain = '<DOMAIN_1>' SETTINGS log_queries = 1
"
docker exec ulpsuite_clickhouse clickhouse-client --query "SYSTEM FLUSH LOGS"
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT read_rows, query_duration_ms
FROM system.query_log
WHERE query LIKE '%credentials_email_domain_sample%email_domain = ''<DOMAIN_1>''%'
  AND type = 'QueryFinish'
ORDER BY event_time DESC
LIMIT 1
"
```

Repeat for the 5-domain-OR case too. Record `read_rows`/duration for both — these are the "with projection, default settings" numbers.

- [ ] **Step 6: Confirm the projection is actually what caused any improvement, not a fluke**

Re-run the exact same single-domain and multi-domain queries once more, this time forcing the projection OFF, on the same finalized table:

```bash
docker exec ulpsuite_clickhouse clickhouse-client --time --query "
SELECT count() FROM ulp.credentials_email_domain_sample WHERE email_domain = '<DOMAIN_1>'
SETTINGS log_queries = 1, optimize_use_projections = 0
"
docker exec ulpsuite_clickhouse clickhouse-client --query "SYSTEM FLUSH LOGS"
docker exec ulpsuite_clickhouse clickhouse-client --query "
SELECT read_rows, query_duration_ms
FROM system.query_log
WHERE query LIKE '%credentials_email_domain_sample%email_domain = ''<DOMAIN_1>''%'
  AND type = 'QueryFinish'
ORDER BY event_time DESC
LIMIT 1
"
```

Expected: `read_rows` here should match Task 2's baseline (full scan) again, confirming the improvement in Step 5 came from the projection and not from caching or an unrelated effect. If `read_rows` stays low even with `optimize_use_projections = 0`, something else is going on (e.g. `query_cache` — re-run with `use_query_cache = 0` added) — investigate before trusting Step 5's numbers.

---

### Task 4: Write the verdict and clean up

**Files:**
- Create: `docs/superpowers/specs/2026-09-24-email-domain-projection-experiment-results.md`

**Interfaces:** none — this is the plan's final output artifact.

- [ ] **Step 1: Write the results doc**

Create `docs/superpowers/specs/2026-09-24-email-domain-projection-experiment-results.md` with this structure, filled in with the actual numbers recorded in Tasks 1–3 (do not leave any bracketed placeholder unfilled):

```markdown
# email_domain Projection Experiment — Results

**Date:** 2026-09-24
**Status:** Measurement complete — [recommend applying to production / recommend against / inconclusive, needs X]

## Setup

- Sample: `ulp.credentials_email_domain_sample`, [N] rows (~1% deterministic hash sample of `ulp.credentials`'s [2.4B / current count] via `cityHash64(email, password) % 100 = 0`).
- Schema: `domain, email, imported_at, email_domain`, `ORDER BY (domain, email, imported_at)` — mirrors the real table's key prefix.
- Projection: `proj_email_domain`, [partial (`SELECT _part_offset ORDER BY email_domain`) / full — state which, and why if partial syntax wasn't available].

## Storage cost

- Before: [X] bytes ([X] MB/GB).
- After: [Y] bytes ([Y] MB/GB).
- Overhead: [Y-X] bytes for [N] rows ([bytes/row]).
- Extrapolated to the real table's [2.4B rows / 333GB]: approximately [extrapolated GB].

## Pruning results

| Query | read_rows (baseline, no projection) | read_rows (with projection) | read_rows (projection forced off) | Verdict |
|---|---|---|---|---|
| Single domain (`<DOMAIN_1>`) | [X] | [Y] | [Z] | [pruned / did not prune] |
| 5-domain OR | [X] | [Y] | [Z] | [pruned / did not prune] |

Duration numbers: [fill in query_duration_ms for each cell above, or a short prose summary].

## Recommendation

[One paragraph: does this validate applying the projection to production? If yes, what's the next step (a real migration in lib/clickhouse-migrations.ts, sized for the real table's build time)? If no or inconclusive, what would need to change about this experiment to get a clearer answer?]
```

- [ ] **Step 2: Commit the results doc**

```bash
git add docs/superpowers/specs/2026-09-24-email-domain-projection-experiment-results.md
git commit -m "docs(spec): record email_domain projection experiment results

Measured against a ~1% sample table, not production. See the doc for
the recommendation on whether this is worth a real migration."
```

- [ ] **Step 3: Drop the sample table**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "DROP TABLE ulp.credentials_email_domain_sample"
```

Verify: `docker exec ulpsuite_clickhouse clickhouse-client --query "EXISTS TABLE ulp.credentials_email_domain_sample"` → `0`.

- [ ] **Step 4: Confirm production is untouched**

```bash
docker exec ulpsuite_clickhouse clickhouse-client --query "SELECT count() FROM system.projections WHERE database = 'ulp' AND table = 'credentials'"
```

Expected: same projection count as before this plan started (just `proj_imported_desc` — this experiment never added anything to the real `ulp.credentials` table).
