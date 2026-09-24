# email_domain Projection Experiment — Results

**Date:** 2026-09-24
**Status:** Measurement complete — recommend applying to production as a real migration

## Setup

- Sample: `ulp.credentials_email_domain_sample`, 27,990,933 rows (~1% deterministic hash sample of `ulp.credentials`'s current 2,778,102,283 rows via `cityHash64(email, password) % 100 = 0`).
- Schema: `domain, email, imported_at, email_domain`, `ORDER BY (domain, email, imported_at)` — mirrors the real table's key prefix.
- Projection: `proj_email_domain`, **partial** (`SELECT _part_offset ORDER BY email_domain`) — the ClickHouse 25.5+/26.1+ syntax confirmed available and working on the running 26.3 server, no fallback to a full projection needed.

## Storage cost

- Before: 474,380,476 bytes (452.4 MiB).
- After: 597,319,228 bytes (569.6 MiB).
- Overhead: 122,938,752 bytes for 27,990,933 rows — **4.39 bytes/row**.
- Extrapolated to the real table's current 2,778,102,283 rows / 381.2 GiB: approximately **12.2 GB** — about 3.2% of the table's current disk footprint.

## Pruning results

| Query | read_rows (baseline, no projection) | read_rows (with projection) | read_rows (projection forced off) | Verdict |
|---|---|---|---|---|
| Single domain (`gmail.com`) | 27,990,933 | 10,010,624 | 27,990,933 | **pruned** — 64% fewer rows read |
| 5-domain OR (`gmail.com`, `hotmail.com`, `yahoo.com`, `outlook.com`, `icloud.com`) | 27,990,933 | 12,430,709 | *(not re-tested — single-domain case already isolates the effect)* | **pruned** — 56% fewer rows read |

Duration: single-domain 64ms → 26ms (baseline vs. with-projection); OR case 65ms → 34ms. Absolute times are naturally much smaller than the original finding's 2.4B-row production numbers (0.5–2.5s per condition) since this sample is ~1% of the real table — `read_rows` is the meaningful signal here, not the absolute duration, and it dropped by more than half in both cases. The forced-off re-run (`optimize_use_projections = 0`) reverted `read_rows` back to the full 27,990,933-row baseline exactly, confirming the improvement comes from the projection itself, not caching or an unrelated effect.

`read_rows` didn't drop all the way to the exact match count (9,948,336 for `gmail.com`) — ClickHouse prunes at granule granularity, not exact row level, so some slack is expected and this is a normal, honest result, not a flaw in the experiment.

## Recommendation

The partial projection validates finding 1's original diagnosis and recommendation: `email_domain` genuinely wasn't being pruned by its two skip indexes because it's uncorrelated with the table's `ORDER BY (domain, email, imported_at)`, and a projection ordered by `email_domain` fixes exactly that — confirmed here with real execution measurements, not just `EXPLAIN`'s estimate (which the original finding already showed can't be trusted for this table). At an extrapolated ~12.2 GB cost against a 381 GiB table, this is cheap enough that the next step is a real migration: add `proj_email_domain` to `lib/clickhouse-migrations.ts` (source of truth) and mirror it in `docker/clickhouse/init/01-ulp-tables.sql`, the same way `proj_imported_desc` already exists in both places. The production `MATERIALIZE PROJECTION` will take meaningfully longer than this experiment's sub-minute run (2.78B rows vs. 28M — expect this to scale roughly linearly, so budget on the order of an hour+, not minutes) and should be scheduled with the same care as other multi-hour migrations this project has already done (see `lib/clickhouse.ts`'s `send_progress_in_http_headers` heartbeat handling for long-running operations). That migration is intentionally not part of this experiment — this document's job was only to answer "does it actually work, and what does it cost," which it now does.
