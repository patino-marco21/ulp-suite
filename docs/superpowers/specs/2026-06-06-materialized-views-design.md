# Materialized Views — ULP Suite Performance Design

## Goal

Pre-aggregate the four highest-cardinality GROUP BY queries (top_domains, top_passwords, top_url_hosts, reuse_pairs) into ClickHouse backing tables so the stats dashboard and reuse browser go from 15–60 s full-table scans to <500 ms MV reads at 1.46 B rows and beyond.

## Architecture

Four ClickHouse backing tables fed by four materialized views. New inserts automatically update all four aggregations at write time (zero query-time overhead). A one-time backfill covers the existing 1.46 B rows. Routes transparently fall back to the original full-scan queries while the backfill runs.

## Tech Stack

ClickHouse SummingMergeTree, AggregatingMergeTree, MATERIALIZED VIEW, INSERT...SELECT with `max_bytes_before_external_group_by`, Next.js API routes, SQLite gate (same pattern as `ch_repair_mutations_fired`).

---

## Section 1: ClickHouse Schema

### Backing Tables

```sql
-- 1. domain_counts — SummingMergeTree, one row per domain
CREATE TABLE IF NOT EXISTS ulp.domain_counts (
  domain String,
  count  UInt64
) ENGINE = SummingMergeTree(count)
ORDER BY domain;

-- 2. password_counts — SummingMergeTree, one row per password
CREATE TABLE IF NOT EXISTS ulp.password_counts (
  password String,
  count    UInt64
) ENGINE = SummingMergeTree(count)
ORDER BY password;

-- 3. url_host_counts — SummingMergeTree, one row per url_host
CREATE TABLE IF NOT EXISTS ulp.url_host_counts (
  url_host String,
  count    UInt64
) ENGINE = SummingMergeTree(count)
ORDER BY url_host;

-- 4. reuse_pairs — AggregatingMergeTree, one row per (email, password)
CREATE TABLE IF NOT EXISTS ulp.reuse_pairs (
  email      String,
  password   String,
  domain_hll AggregateFunction(uniq, String)
) ENGINE = AggregatingMergeTree()
ORDER BY (email, password);
```

**SummingMergeTree** is correct for simple counts: ClickHouse may store multiple partial rows per key (one per INSERT batch) before background merges run. Queries must `GROUP BY key + sum(count)` — this is always correct regardless of merge state.

**AggregatingMergeTree** is required for `uniq(domain)`: the HyperLogLog intermediate state cannot be summed; it must be merged with `uniqMerge()`.

### Materialized Views

```sql
-- MV 1: feeds domain_counts on every INSERT into credentials
CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_domain_counts
TO ulp.domain_counts AS
SELECT domain, count() AS count
FROM ulp.credentials
WHERE domain != ''
GROUP BY domain;

-- MV 2: feeds password_counts on every INSERT into credentials
CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_password_counts
TO ulp.password_counts AS
SELECT password, count() AS count
FROM ulp.credentials
WHERE length(password) > 0
GROUP BY password;

-- MV 3: feeds url_host_counts on every INSERT into credentials
CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_url_host_counts
TO ulp.url_host_counts AS
SELECT if(url_host != '', url_host, domain) AS url_host, count() AS count
FROM ulp.credentials
WHERE (url_host != '' OR domain != '')
GROUP BY url_host;

-- MV 4: feeds reuse_pairs on every INSERT into credentials
CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_reuse_pairs
TO ulp.reuse_pairs AS
SELECT
  email,
  password,
  uniqState(domain) AS domain_hll
FROM ulp.credentials
WHERE login_type = 'email' AND length(password) > 0
GROUP BY email, password;
```

---

## Section 2: Backfill Strategy

MVs only capture inserts that occur after their creation. The existing 1.46 B rows need a one-time backfill.

### Mechanism

Four sequential `INSERT INTO ... SELECT ... FROM ulp.credentials GROUP BY ...` statements fired as a fire-and-forget async chain inside `lib/clickhouse-migrations.ts`, gated by SQLite key `ch_mv_backfill_fired` (identical pattern to `ch_repair_mutations_fired`).

Sequential (not parallel) to avoid OOM: each GROUP BY at 1.46 B rows uses 2–4 GB RAM with disk spill. Running all four concurrently would exceed the 6 GB container limit.

### Backfill Queries

```sql
-- 1. domain_counts backfill
INSERT INTO ulp.domain_counts
SELECT domain, count() AS count
FROM ulp.credentials
WHERE domain != ''
GROUP BY domain
SETTINGS max_bytes_before_external_group_by = 4294967296;

-- 2. password_counts backfill
INSERT INTO ulp.password_counts
SELECT password, count() AS count
FROM ulp.credentials
WHERE length(password) > 0
GROUP BY password
SETTINGS max_bytes_before_external_group_by = 4294967296;

-- 3. url_host_counts backfill
INSERT INTO ulp.url_host_counts
SELECT if(url_host != '', url_host, domain) AS url_host, count() AS count
FROM ulp.credentials
WHERE (url_host != '' OR domain != '')
GROUP BY url_host
SETTINGS max_bytes_before_external_group_by = 4294967296;

-- 4. reuse_pairs backfill
INSERT INTO ulp.reuse_pairs
SELECT email, password, uniqState(domain) AS domain_hll
FROM ulp.credentials
WHERE login_type = 'email' AND length(password) > 0
GROUP BY email, password
SETTINGS max_bytes_before_external_group_by = 4294967296;
```

### SQLite Gate

Key: `ch_mv_backfill_fired` — value `'1'` once the backfill chain is started. Reset to `'0'` by the admin rebuild endpoint to allow re-backfill.

---

## Section 3: Live Fallback

During the backfill (5–30 minutes after first deploy), the MV tables are empty. Routes must not serve zero results during this window.

### Per-Route `mvReady` Flag

Each route file that uses an MV table has a module-level boolean:

```typescript
let domainMvReady: boolean | null = null  // null = unchecked

async function isDomainMvReady(): Promise<boolean> {
  if (domainMvReady !== null) return domainMvReady
  const r = await executeQuery('SELECT count() AS n FROM ulp.domain_counts LIMIT 1')
  domainMvReady = Number(r[0]?.n ?? 0) > 0
  return domainMvReady
}
```

Once the table has rows, the check returns `true` permanently (no per-request DB hit). If it returns `false`, the route falls back to the original full-scan query transparently.

The four flags: `domainMvReady`, `passwordMvReady`, `urlHostMvReady`, `reuseMvReady`.

---

## Section 4: Route Changes

### `app/api/stats/route.ts` — 4 queries replaced

| Query | Old | New (MV path) |
|---|---|---|
| `topDomains` | `GROUP BY domain` on credentials | `sum(count) FROM ulp.domain_counts GROUP BY domain LIMIT 15` |
| `topPasswords` | `GROUP BY password` on credentials | `sum(count) FROM ulp.password_counts GROUP BY password LIMIT 50` |
| `topUrlHosts` | `GROUP BY url_host` on credentials | `sum(count) FROM ulp.url_host_counts GROUP BY url_host LIMIT 15` |
| `reuseStats` | Double GROUP BY on credentials | `uniqMerge(domain_hll) FROM ulp.reuse_pairs + countIf` |

Fallback: if `mvReady` is false for that specific table, the original query runs unchanged.

**MV read queries:**

```sql
-- top_domains (MV)
SELECT domain, sum(count) AS count
FROM ulp.domain_counts
WHERE domain != ''
GROUP BY domain
ORDER BY count DESC
LIMIT 15
SETTINGS max_execution_time = 10;

-- top_passwords (MV)
SELECT password, sum(count) AS count
FROM ulp.password_counts
WHERE password != ''
GROUP BY password
ORDER BY count DESC
LIMIT 50
SETTINGS max_execution_time = 10;

-- top_url_hosts (MV)
SELECT url_host, sum(count) AS count
FROM ulp.url_host_counts
WHERE url_host != ''
GROUP BY url_host
ORDER BY count DESC
LIMIT 15
SETTINGS max_execution_time = 10;

-- reuse_stats (MV) — subquery approach
SELECT
  countIf(dc > 1) AS reused_pairs,
  count()         AS total_pairs
FROM (
  SELECT email, password, uniqMerge(domain_hll) AS dc
  FROM ulp.reuse_pairs
  GROUP BY email, password
)
SETTINGS max_execution_time = 30;
```

### `app/api/reuse/route.ts` — Two-query pattern

**Query 1 — MV (paginated list):**
```sql
SELECT email, password, uniqMerge(domain_hll) AS domain_count
FROM ulp.reuse_pairs
GROUP BY email, password
HAVING domain_count > 1
ORDER BY domain_count DESC
LIMIT {limit} OFFSET {offset}
SETTINGS max_execution_time = 30;
```

**Query 2 — domains sample (runs AFTER Query 1 returns its rows):**
```sql
SELECT email, password, groupUniqArray(8)(domain) AS domains
FROM ulp.credentials
WHERE (email, password) IN (('e1','p1'), ('e2','p2'), ...)
  AND login_type = 'email'
GROUP BY email, password
SETTINGS max_execution_time = 10;
```

Query 2 fires once per page (not once per row) after Query 1 returns the email/password pairs. The IN list contains up to 50 tuples (one per page row). Query 2 uses the email bloom_filter skip index. Results from both queries are merged in Node by matching on `(email, password)`.

**Parallelism:** Query 1 and the count query run via `Promise.all`. Query 2 is serial after Query 1 (it depends on Query 1's rows to build the IN list).

**Count query (MV):**
```sql
SELECT count() AS total
FROM (
  SELECT email, password
  FROM ulp.reuse_pairs
  GROUP BY email, password
  HAVING uniqMerge(domain_hll) > 1
)
SETTINGS max_execution_time = 30;
```

Fallback (when `reuseMvReady = false`): original single GROUP BY query on `ulp.credentials` unchanged.

---

## Section 5: Files Created / Modified

### Modified

| File | Change |
|---|---|
| `lib/clickhouse-migrations.ts` | Add DDL_VERSION 3 block: CREATE 4 tables + 4 MVs; add `ch_mv_backfill_fired` gate + sequential backfill chain |
| `app/api/stats/route.ts` | Replace 4 queries with MV versions + `mvReady` fallback flags |
| `app/api/reuse/route.ts` | Replace main/count queries with MV two-query pattern + `reuseMvReady` fallback |

### Created

| File | Purpose |
|---|---|
| `app/api/admin/rebuild-mv/route.ts` | Admin-gated POST: TRUNCATE 4 tables, reset SQLite gate to `'0'`, re-fire backfill chain |

---

## Section 6: Error Handling

- **Backfill failure**: logged with `console.error`; `ch_mv_backfill_fired` is set BEFORE the chain runs (prevents infinite retry loops on crash). If the backfill fails, the fallback queries continue serving. Admin can trigger `/api/admin/rebuild-mv` to retry.
- **MV query failure**: caught and re-thrown; caller falls back to full-scan (same `try/catch` pattern as existing timeout fallback).
- **Partial backfill**: if the container crashes mid-backfill, `ch_mv_backfill_fired = '1'` prevents re-backfill on restart. Admin must call `/api/admin/rebuild-mv` to reset and retry. The partially-filled MV tables serve partial results until then (fallback kicks in when count = 0; partial data is served when count > 0 but incomplete).

---

## Expected Performance Impact

| Query | Before | After (MV warmed) |
|---|---|---|
| top_domains (1.46 B rows) | 15–30 s | ~50 ms |
| top_passwords (1.46 B rows) | 30–60 s | ~50 ms |
| top_url_hosts (1.46 B rows) | 10–20 s | ~50 ms |
| reuseStats (double GROUP BY) | 45–120 s | ~200 ms |
| reuse browser page (MV + domains) | timeout / 120 s | ~300 ms |
