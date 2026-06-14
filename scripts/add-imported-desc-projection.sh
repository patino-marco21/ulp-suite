#!/bin/bash
# =============================================================================
# add-imported-desc-projection.sh
#
# Adds + materializes a projection on ulp.credentials so the default
# Credentials Browser view can be served via read-in-order instead of a full
# read + sort (task #10).
#
# BACKGROUND:
#   Table:        ENGINE = MergeTree ORDER BY (domain, email, imported_at)
#                  PARTITION BY toYYYYMM(imported_at)
#   Default view: SORT_MAP['imported_desc'] (lib/cursor-pagination.ts) =
#                  'imported_at DESC, domain ASC, email ASC, url ASC, password ASC'
#
#   `imported_at` is LAST in the table's physical ORDER BY, not first, so the
#   default view's ORDER BY is not a prefix of the table's -- ClickHouse can't
#   read in order and must read+decompress+sort the whole table at WHERE 1=1.
#
#   diagnose-scale-readiness.sh (2026-06-13, pre-dedup, 35,282,245 rows) found
#   this query takes 0.948s vs 0.150s for a table-prefix-ordered equivalent --
#   6.3x, and would compound severely at "tens of billions" rows.
#
#   Task #9 (fix-credentials-duplicates.sh) has already run: ulp.credentials
#   is now 20,315,675 rows (was 35,282,245), so this projection's initial
#   MATERIALIZE is over a smaller table than it would have been.
#
# STRATEGY:
#   1. ALTER TABLE ulp.credentials ADD PROJECTION proj_imported_desc (...)
#      -- metadata only, instant. New INSERTs get the projection immediately;
#      existing parts are untouched until step 3.
#
#      The projection stores exactly the 16 raw columns
#      app/api/credentials/route.ts's SELECT reads (url/email/password/domain
#      via NORM_COLS, plus source_file, breach_name, country_tier, login_type,
#      password_length, password_mask, url_scheme, is_corporate_email,
#      email_domain, url_host, password_entropy_band, imported_at) -- NOT
#      `SELECT *`, which would ~double table storage at the current 10.51x
#      compression ratio.
#
#      ORDER BY: a projection's ORDER BY (like a table's MergeTree sorting
#      key) is a plain comma-separated expression list -- ASC/DESC are NOT
#      accepted (confirmed 2026-06-13: "ADD PROJECTION ... ORDER BY
#      imported_at DESC, ..." fails with Code: 62 Syntax error at "DESC",
#      table left unchanged). To match SORT_MAP['imported_desc']
#      (imported_at DESC, domain ASC, email ASC, url ASC, password ASC)
#      exactly -- including the domain/email/url/password tiebreak
#      direction, which matters because imported_at DEFAULT now() means a
#      whole bulk import can share one imported_at value -- the projection's
#      ORDER BY is:
#        negate(toUnixTimestamp(imported_at)), domain, email, url, password
#      negate(toUnixTimestamp(imported_at)) is ascending exactly when
#      imported_at is descending, so a forward read of this projection visits
#      rows in precisely SORT_MAP['imported_desc']'s order, term for term.
#      Whether ClickHouse's optimizer actually matches the app's literal
#      "imported_at DESC" query against this projection (a "monotonic
#      function" inference) is what step 3's EXPLAIN + timing empirically
#      tests -- if it doesn't, DROP PROJECTION (printed at the end) is cheap
#      and a different approach (rewriting the app's ORDER BY to the negated
#      expression directly) would be the next step.
#
#   2. ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_imported_desc
#      IN PARTITION '<partition>' SETTINGS mutations_sync = 1
#      -- run ONE partition (toYYYYMM) at a time. mutations_sync=1 makes each
#      ALTER block until that partition's projection is built, so progress is
#      incremental and visible (vs. one big all-at-once mutation). New parts
#      already have the projection from step 1 regardless.
#
#   3. Verify: system.mutations all done, EXPLAIN indexes=1 shows
#      proj_imported_desc in use, and a timed before/after comparison of the
#      real default-view query.
#
# Safe to re-run:
#   - Step 2 (ADD PROJECTION) is skipped if SHOW CREATE TABLE already mentions
#     proj_imported_desc.
#   - Step 3's per-partition loop skips any partition that already has a
#     done MATERIALIZE PROJECTION proj_imported_desc mutation recorded in
#     system.mutations.
#
# Rollback: DROP PROJECTION is cheap (metadata + frees the projection's
# stored columns) -- printed at the end, not run automatically:
#   ALTER TABLE ulp.credentials DROP PROJECTION proj_imported_desc
#
# Disk: the projection re-stores these 16 columns sorted by
# (imported_at, domain, email, url, password) -- less than a full table copy
# (several wide/derived columns are excluded), but still adds meaningfully to
# the current ~410MB. system.parts after materialization shows the actual
# delta.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/add-imported-desc-projection.sh
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
PROJ="proj_imported_desc"
PROJ_COLS="url, email, password, source_file, breach_name, country_tier, login_type, password_length, password_mask, url_scheme, is_corporate_email, email_domain, url_host, password_entropy_band, imported_at, domain"

# The app's real ORDER BY (SORT_MAP['imported_desc'], lib/cursor-pagination.ts)
# -- used for the default-view query and the EXPLAIN check below. NOT used
# inside ADD PROJECTION (see header: projection ORDER BY rejects ASC/DESC).
QUERY_ORDER="imported_at DESC, domain ASC, email ASC, url ASC, password ASC"

# The projection's physical sort order -- see header for why
# negate(toUnixTimestamp(imported_at)) stands in for "imported_at DESC".
PROJ_ORDER="negate(toUnixTimestamp(imported_at)), domain, email, url, password"

# Exact default-view query (app/api/credentials/route.ts, sort=imported_desc),
# minus the NORM_COLS rewrite -- same raw-column shape as diagnose-scale-
# readiness.sh's Query A (post-97d6c43 SETTINGS placement fix).
read -r -d '' QUERY_DEFAULT <<EOF
SELECT $PROJ_COLS
FROM ulp.credentials
WHERE 1=1
ORDER BY $QUERY_ORDER
LIMIT 50
SETTINGS max_execution_time = 300, timeout_overflow_mode = 'throw'
EOF

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — add imported_at-desc projection (task #10)     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "═══ 1/4  Pre-flight: table size, partitions, BEFORE timing ══════"
$CH "
SELECT
  sum(rows) AS total_rows,
  count() AS part_count,
  formatReadableSize(sum(data_compressed_bytes)) AS compressed
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active = 1
" --format PrettyCompact

echo "-- Rows per partition (toYYYYMM(imported_at)) --"
$CH "
SELECT partition, sum(rows) AS rows
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active = 1
GROUP BY partition
ORDER BY partition
" --format PrettyCompact

echo "-- BEFORE: default view query (ORDER BY $QUERY_ORDER), LIMIT 50 --"
time $CH "$QUERY_DEFAULT" --format Null
echo ""

PROJ_EXISTS=$($CH "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw | grep -c "$PROJ" || true)

echo "═══ 2/4  ADD PROJECTION $PROJ (metadata only, instant) ═══════"
if [ "$PROJ_EXISTS" != "0" ]; then
  echo "$PROJ already present in SHOW CREATE TABLE -- skipping ADD PROJECTION."
  echo "(If you want to redefine it, first: ALTER TABLE ulp.credentials DROP"
  echo " PROJECTION $PROJ, then re-run this script from the top.)"
else
  echo "ALTER TABLE ulp.credentials ADD PROJECTION $PROJ ("
  echo "  SELECT $PROJ_COLS"
  echo "  ORDER BY $PROJ_ORDER"
  echo ")"
  echo "New INSERTs get this immediately. Existing parts are untouched until"
  echo "step 3/4 below."
  if ! $CH "
  ALTER TABLE ulp.credentials ADD PROJECTION $PROJ (
    SELECT $PROJ_COLS
    ORDER BY $PROJ_ORDER
  )
  "; then
    echo "ERROR: ADD PROJECTION failed. ulp.credentials is unchanged."
    exit 1
  fi
  echo "Added."
fi
echo ""

echo "═══ 3/4  MATERIALIZE PROJECTION $PROJ, one partition at a time ══"
echo "Each partition runs with SETTINGS mutations_sync = 1 -- the ALTER"
echo "blocks until that partition's projection is fully built, so this loop"
echo "shows real incremental progress. Partitions already done (per"
echo "system.mutations) are skipped."
echo ""

PARTITIONS=$($CH "
SELECT DISTINCT partition
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active = 1
ORDER BY partition
" --format TabSeparated)

for PART in $PARTITIONS; do
  ALREADY_DONE=$($CH "
  SELECT count() FROM system.mutations
  WHERE database = 'ulp' AND table = 'credentials' AND is_done = 1
    AND command LIKE '%MATERIALIZE PROJECTION%$PROJ%'
    AND command LIKE '%$PART%'
  " --format TabSeparated)

  if [ "$ALREADY_DONE" != "0" ]; then
    echo "-- Partition $PART: $PROJ already materialized -- skipping."
    continue
  fi

  echo "-- Partition $PART: materializing $PROJ ..."
  if ! time $CH "
  ALTER TABLE ulp.credentials
  MATERIALIZE PROJECTION $PROJ IN PARTITION '$PART'
  SETTINGS mutations_sync = 1, max_execution_time = 1800, timeout_overflow_mode = 'throw'
  "; then
    echo "ERROR: MATERIALIZE PROJECTION failed/timed out for partition $PART."
    echo "Partitions already completed above are fine and don't need redoing."
    echo "Re-run this script once you've addressed the cause -- it will pick"
    echo "up from this partition."
    exit 1
  fi
done
echo ""
echo "All partitions processed."
echo ""

echo "═══ 4/4  Verify ═════════════════════════════════════════════════"
echo "-- system.mutations: any NOT done for ulp.credentials? (expect 0) --"
$CH "
SELECT count() AS pending
FROM system.mutations
WHERE database = 'ulp' AND table = 'credentials' AND NOT is_done
" --format PrettyCompact

echo "-- EXPLAIN indexes=1: looking for $PROJ in the plan --"
EXPLAIN_OUT=$($CH "
EXPLAIN indexes = 1
SELECT url, email, password, imported_at, domain
FROM ulp.credentials
WHERE 1=1
ORDER BY $QUERY_ORDER
LIMIT 50
SETTINGS use_query_condition_cache = 0, use_skip_indexes_on_data_read = 0
")
echo "$EXPLAIN_OUT"
if echo "$EXPLAIN_OUT" | grep -qi "$PROJ"; then
  echo ">>> $PROJ found in EXPLAIN output -- projection is being used."
else
  echo ">>> $PROJ NOT found in EXPLAIN output -- ClickHouse chose not to use"
  echo "    it for this query (or 'EXPLAIN indexes=1' doesn't surface"
  echo "    projection usage on this version). The timing comparison below"
  echo "    is the more reliable signal."
fi
echo ""

echo "-- AFTER: default view query (ORDER BY $QUERY_ORDER), LIMIT 50 --"
time $CH "$QUERY_DEFAULT" --format Null
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Done. Compare the BEFORE (step 1/4) and AFTER (step 4/4) 'real' times"
echo "above for the same query -- that's the actual win from this projection."
echo ""
echo "If AFTER ~= BEFORE and $PROJ did NOT appear in the EXPLAIN output above,"
echo "ClickHouse isn't matching the app's 'imported_at DESC' query against this"
echo "projection's negate(toUnixTimestamp(...))-based order -- the projection"
echo "is still harmless (DROP PROJECTION below is cheap). Next step would be"
echo "rewriting the app's ORDER BY to use negate(toUnixTimestamp(imported_at))"
echo "directly so it's a literal match instead of relying on monotonicity"
echo "inference."
echo ""
echo "New parts (from future imports) get $PROJ automatically; nothing"
echo "further to do for those."
echo ""
echo "To remove the projection (cheap, frees its stored columns):"
echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \\"
echo "    \"ALTER TABLE ulp.credentials DROP PROJECTION $PROJ\""
echo ""
echo "Next: with #9 (dedup) and #10 (this projection) both landed, re-measure"
echo "the real Credentials Browser default view (originally reported as"
echo "29.2s at ~34M rows) -- if it's now fast, the NORM_COLS hypothesis in"
echo "project notes is moot. If it's still slow, that's the next thing to"
echo "isolate."
echo "═══════════════════════════════════════════════════════════════"
