#!/bin/bash
# =============================================================================
# diagnose-scale-readiness.sh
#
# READ-ONLY. Gathers evidence for the "30M rows already takes 29.2s, needs to
# handle tens of billions" investigation, triggered by the Credentials Browser
# showing "34,046,965 records · 29.2s · click any row to inspect" with the
# default view (q='', sort=imported_desc) AND a screenshot where every visible
# row appears EXACTLY TWICE with byte-identical content (same url, email,
# password, jsessionid token, mask value).
#
# Two code-level findings motivate this script — NEITHER has been confirmed
# against the live database yet:
#
# FINDING #1 — ORDER BY / physical sort-order mismatch (app/api/credentials/route.ts
# + lib/cursor-pagination.ts + docker/clickhouse/init/01-ulp-tables.sql):
#
#   Table:        ENGINE = MergeTree ORDER BY (domain, email, imported_at)
#   Default view: ORDER BY imported_at DESC, domain ASC, email ASC, url ASC,
#                  password ASC   (SORT_MAP['imported_desc'])
#
#   `imported_at` is LAST in the table's physical order, not first. The
#   default view's ORDER BY is NOT a prefix of the table's ORDER BY, so
#   ClickHouse cannot "read in order" — at WHERE 1=1 (no filter, matches all
#   rows) it must read+decompress ~15 columns for ALL matching rows, fully
#   sort by imported_at, then take the top 50. At 34M rows that's 29.2s. At
#   "tens of billions" this would blow well past max_execution_time=300 and/or
#   OOM. The standard ClickHouse fix is an ADD PROJECTION with an ORDER BY
#   that puts imported_at first, MATERIALIZEd for old parts.
#
# FINDING #2 — possible systemic duplicate rows in ulp.credentials:
#
#   `ulp.credentials` is a plain MergeTree (insert_deduplicate=0, no engine-level
#   dedup) — the only dedup is a per-batch in-memory Set inside parseULPStream,
#   which cannot catch duplicates across separate files/batches/import-runs.
#   A separate incident (scripts/fix-inbox-rename-loop.sh) found files getting
#   stuck in a "reprocess forever" loop due to a missing inbox/done|failed dir,
#   each loop iteration re-inserting that file's rows into ulp.credentials
#   again. If that (or something like it) affected many files, EVERY row from
#   those files would be duplicated — consistent with "every visible row
#   appears exactly twice, byte-identical" in the screenshot. At "tens of
#   billions" scale, systemic duplication wastes storage/CPU/IO proportionally
#   and makes count()/aggregates wrong.
#
# FINDING #3 — possible system.mutations backlog:
#
#   lib/clickhouse-migrations.ts DDL v6-v11 each ran `ALTER TABLE ... ADD COLUMN
#   ... MATERIALIZED ...` followed by `MATERIALIZE COLUMN`, and v9 added
#   `idx_ngram_url_host`/`idx_ngram_email_domain` followed by `MATERIALIZE INDEX`.
#   These are all async mutations that rewrite existing parts. If still
#   pending, they (a) consume background CPU/IO continuously — possibly
#   explaining ulpsuite_clickhouse's previously-flagged-but-never-explained
#   78.65% CPU / 134GB read + 67.9GB write — and (b) mean old parts haven't
#   gotten the new materialized columns/indexes yet, making queries against
#   those parts slower than queries against new parts.
#
# This script (7 read-only sections):
#   1. system.parts capacity overview (rows/parts/compressed/uncompressed per
#      table) — baseline for extrapolating storage/IO to "tens of billions".
#   2. system.tables.engine_full — confirms the ORDER BY/PARTITION BY/SETTINGS
#      that actually took effect (vs. what the init SQL/migrations intended).
#   3. TIMED comparison: the exact default-view query (ORDER BY imported_at
#      DESC, ...) vs. the same query with ORDER BY rewritten to a prefix of
#      the table's physical order (domain, email, imported_at) — direct
#      evidence for/against Finding #1, and a measure of the win available.
#   4. EXPLAIN indexes=1 for both queries above — shows WHY: granules
#      read/skipped, whether "read in order" / a sort step appears.
#   5. Duplicate-row scan: global excess-row count via
#      cityHash64(url,email,password,imported_at,source_file) +
#      uniqExact(), a per-source_file breakdown of which imports are
#      duplicated and by how much, and a sample of actual duplicate rows —
#      direct evidence for/against Finding #2.
#   6. system.mutations — done vs. pending count per table, and full detail
#      of any pending mutations — direct evidence for/against Finding #3.
#   7. NORM_COLS fix-up coverage (lib/ulp-normalize.ts cases A-D) — how many
#      rows still need the per-query IF/match() rewrite logic. If ~0, the
#      background UPDATE mutations referenced in that file's comments have
#      completed and the fix-up logic could eventually be removed.
#
# NO FIX is applied by this script. Sections 5/6 in particular involve
# expensive operations (ADD PROJECTION + MATERIALIZE PROJECTION on old parts,
# or a dedup rewrite) that should only be undertaken once this evidence
# confirms which problem(s) actually exist and how large they are.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-scale-readiness.sh
#
# Expect section 3/5 to take a while — they scan all of ulp.credentials
# (34M+ rows). This is read-only and won't block other queries, but don't be
# surprised if the whole script takes a few minutes.
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
REPORT="/tmp/ulp-diagnose-scale-readiness-$(date +%Y%m%d-%H%M%S).txt"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — diagnose scale readiness (read-only)           ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/7  Capacity overview — system.parts per table ════════════════"
$CH "
SELECT table,
       sum(rows) AS total_rows,
       count() AS part_count,
       formatReadableSize(sum(data_compressed_bytes))   AS compressed,
       formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed,
       round(sum(data_uncompressed_bytes) / sum(data_compressed_bytes), 2) AS ratio
FROM system.parts
WHERE database = 'ulp' AND active = 1
GROUP BY table
ORDER BY total_rows DESC
" --format PrettyCompact
echo ""

echo "═══ 2/7  Applied engine settings — system.tables.engine_full ══════"
$CH "
SELECT name, engine_full
FROM system.tables
WHERE database = 'ulp'
ORDER BY name
" --format Vertical
echo ""

echo "═══ 3/7  TIMED: default-view ORDER BY vs. table-prefix ORDER BY ════"
echo "(Finding #1 — table is ORDER BY (domain, email, imported_at). The"
echo " default Credentials Browser view sorts by imported_at FIRST, which is"
echo " NOT a prefix, forcing a full read + full sort at WHERE 1=1. Query B"
echo " below uses a prefix of the table's physical order instead.)"
echo ""
echo "-- Query A: current default view — ORDER BY imported_at DESC, domain ASC, email ASC, url ASC, password ASC --"
time $CH "
SELECT url, email, password, source_file, breach_name, country_tier, login_type,
       password_length, password_mask, url_scheme, is_corporate_email, email_domain,
       url_host, password_entropy_band, imported_at, domain
FROM ulp.credentials
WHERE 1=1
ORDER BY imported_at DESC, domain ASC, email ASC, url ASC, password ASC
LIMIT 50
SETTINGS max_execution_time = 300, timeout_overflow_mode = 'throw'
" --format Null
echo ""
echo "-- Query B: domain-prefix-aligned — ORDER BY domain ASC, email ASC, imported_at ASC (prefix of table's ORDER BY) --"
time $CH "
SELECT url, email, password, source_file, breach_name, country_tier, login_type,
       password_length, password_mask, url_scheme, is_corporate_email, email_domain,
       url_host, password_entropy_band, imported_at, domain
FROM ulp.credentials
WHERE 1=1
ORDER BY domain ASC, email ASC, imported_at ASC
LIMIT 50
SETTINGS max_execution_time = 300, timeout_overflow_mode = 'throw'
" --format Null
echo ""

echo "═══ 4/7  EXPLAIN indexes=1 — why Query A is slow vs. Query B ═══════"
echo "(ClickHouse >= 25.9 moved skip-index analysis into the scan itself and"
echo " >= 25.10 probes the query condition cache before index analysis, both"
echo " of which make EXPLAIN indexes=1 misleading unless disabled for the"
echo " explain — hence the SETTINGS clause on both queries below.)"
echo "-- Query A (imported_at-first ORDER BY) --"
$CH "
EXPLAIN indexes = 1
SELECT url, email, password, imported_at, domain
FROM ulp.credentials
WHERE 1=1
ORDER BY imported_at DESC, domain ASC, email ASC, url ASC, password ASC
LIMIT 50
SETTINGS use_query_condition_cache = 0, use_skip_indexes_on_data_read = 0
"
echo ""
echo "-- Query B (domain-prefix ORDER BY) --"
$CH "
EXPLAIN indexes = 1
SELECT url, email, password, imported_at, domain
FROM ulp.credentials
WHERE 1=1
ORDER BY domain ASC, email ASC, imported_at ASC
LIMIT 50
SETTINGS use_query_condition_cache = 0, use_skip_indexes_on_data_read = 0
"
echo ""

echo "═══ 5/7  Duplicate-row scan (Finding #2) ════════════════════════════"
echo "-- Global: total rows vs. distinct (url,email,password,imported_at,source_file) --"
$CH "
SELECT
  count() AS total_rows,
  uniqExact(cityHash64(url, email, password, imported_at, source_file)) AS distinct_rows,
  count() - uniqExact(cityHash64(url, email, password, imported_at, source_file)) AS excess_rows,
  round(100.0 * (count() - uniqExact(cityHash64(url, email, password, imported_at, source_file))) / count(), 2) AS pct_excess
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""
echo "-- Per source_file: which imports are duplicated, and by how much --"
$CH "
SELECT
  source_file,
  count() AS total_rows,
  uniqExact(cityHash64(url, email, password, imported_at)) AS distinct_rows,
  count() - uniqExact(cityHash64(url, email, password, imported_at)) AS excess_rows
FROM ulp.credentials
GROUP BY source_file
HAVING excess_rows > 0
ORDER BY excess_rows DESC
LIMIT 15
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""
echo "-- Sample of actual duplicate rows (count() > 1 for identical url/email/password/source_file/imported_at) --"
$CH "
SELECT url, email, password, source_file, imported_at, count() AS c
FROM ulp.credentials
GROUP BY url, email, password, source_file, imported_at
HAVING c > 1
ORDER BY c DESC
LIMIT 5
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""

echo "═══ 6/7  system.mutations — pending MATERIALIZE backlog (Finding #3) ═"
echo "-- Done vs. pending per table --"
$CH "
SELECT table, count() AS total, countIf(is_done) AS done, countIf(NOT is_done) AS pending
FROM system.mutations
WHERE database = 'ulp'
GROUP BY table
ORDER BY table
" --format PrettyCompact
echo ""
echo "-- Detail of any PENDING mutations --"
$CH "
SELECT table, mutation_id, command, create_time, parts_to_do, is_done, latest_fail_reason
FROM system.mutations
WHERE database = 'ulp' AND NOT is_done
ORDER BY create_time
" --format Vertical
echo ""

echo "═══ 7/7  NORM_COLS fix-up coverage (lib/ulp-normalize.ts cases A-D) ═"
echo "(If these are all ~0, the background UPDATE mutations referenced in"
echo " that file's comments are done and the per-query IF/match() rewrite"
echo " logic in NORM_COLS is now a no-op — a candidate for later removal.)"
$CH "$(cat <<'EOSQL'
SELECT
  countIf(lower(left(email,11))='jsessionid=') AS case_a_jsessionid,
  countIf(match(url,'^[A-Za-z]{1,3}\\s+https?://')) AS case_b_cc_prefix,
  countIf(url IN ('http','https') AND startsWith(email,'//') AND position(email,' ')>0) AS case_c_scheme_split,
  countIf(url='' AND NOT position(email,'@')>0 AND position(email,'/')>0 AND lower(left(email,11))!='jsessionid=') AS case_d_monster
FROM ulp.credentials
SETTINGS max_execution_time = 300
EOSQL
)" --format PrettyCompact
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What this tells us:"
echo "  - Section 1: current per-table row counts / sizes / compression ratio"
echo "    — multiply out to estimate disk + IO at 'tens of billions' rows."
echo "  - Section 2: confirms the LIVE ORDER BY/PARTITION BY/SETTINGS, in case"
echo "    any migration didn't fully apply."
echo "  - Section 3: the headline numbers. If Query B (domain-prefix ORDER BY)"
echo "    is dramatically faster than Query A (current default view), that's"
echo "    direct, quantified confirmation of Finding #1 — and tells us roughly"
echo "    how much a projection on (imported_at, domain, email, ...) would"
echo "    save vs. read-in-order on the existing primary key."
echo "  - Section 4: EXPLAIN should show Query A doing a full read with a"
echo "    'Sorting' step (no usable index for read-in-order), and Query B"
echo "    using the primary key to read in order with minimal/no sort step."
echo "  - Section 5: excess_rows / pct_excess quantifies Finding #2. The"
echo "    per-source_file breakdown shows whether duplication is isolated to"
echo "    specific (likely rename-loop-affected) files or systemic across all"
echo "    imports. The sample should visually match the screenshot's"
echo "    byte-identical adjacent-row pattern if this is the same issue."
echo "  - Section 6: any 'pending' mutations from DDL v6-v11 confirms Finding"
echo "    #3 — explains background CPU/IO load and means old parts are"
echo "    querying materialized columns/indexes on-the-fly until done."
echo "  - Section 7: near-zero counts mean NORM_COLS's fix-up IFs are dead"
echo "    weight on every query (small per-row cost, but on tens of billions"
echo "    of rows that adds up) — a candidate for later cleanup."
echo ""
echo "Share this output and we'll turn sections 3-6 into a prioritized,"
echo "ordered set of schema changes (projection, dedup strategy, mutation"
echo "follow-up) sized for 'tens of billions' — no action taken on the live"
echo "system yet."
echo "═══════════════════════════════════════════════════════════════"
