#!/bin/bash
# =============================================================================
# verify-imported-desc-projection.sh
#
# Follow-up to add-imported-desc-projection.sh (task #10).
#
# That script reported BEFORE 0.627s -> AFTER 0.115s (5.4x) for the default
# view query, but EXPLAIN indexes=1 showed:
#   ReadFromMergeTree (ulp.credentials)
# not "ReadFromMergeTree (ulp.credentials.proj_imported_desc)" -- which is
# how ClickHouse denotes projection usage in EXPLAIN. The MATERIALIZE
# PROJECTION step that ran just before did an 11.4s full sequential read of
# all 499MB/20.3M rows to build the projection, which would also warm OS
# page cache / ClickHouse caches on its own. So the 5.4x AFTER number may be
# cache warming, not proj_imported_desc actually being used.
#
# This script runs READ-ONLY queries with
#   SETTINGS optimize_use_projections = 1, force_optimize_projection = 1
# which makes ClickHouse ERROR if no projection can serve the query -- a
# definitive yes/no, unlike a timing comparison confounded by caching.
#
#   A) The app's real query: ORDER BY imported_at DESC, domain ASC, email
#      ASC, url ASC, password ASC  (SORT_MAP['imported_desc'])
#   B) The projection's literal sort key: ORDER BY
#      negate(toUnixTimestamp(imported_at)), domain, email, url, password
#      (no DESC -- exactly proj_imported_desc's ORDER BY expression)
#
# Outcomes:
#   A succeeds           -> proj_imported_desc IS used for the app's real
#                            query. The 5.4x number is real (or close to
#                            it) -- this script re-times it to confirm.
#   A errors, B succeeds -> the projection CAN be used, but ClickHouse isn't
#                            matching "imported_at DESC" against
#                            negate(toUnixTimestamp(imported_at)) via
#                            monotonic-function inference. Fix: rewrite the
#                            app's imported_desc ORDER BY
#                            (lib/cursor-pagination.ts + route.ts) to the
#                            literal B expression -- bigger change, plan it
#                            separately.
#   A errors, B errors   -> proj_imported_desc isn't selected for either
#                            form. Most likely ClickHouse's cost-based
#                            optimizer judges this table (499MB/20.3M rows)
#                            too small for the projection to pay off yet.
#                            The 5.4x number was cache warming. Projection
#                            is harmless to leave (may kick in as the table
#                            grows) or drop (command printed) if you'd
#                            rather not pay its storage/insert overhead
#                            until then.
#
# Read-only (no ALTER). Safe to re-run any time, including after the table
# grows, to recheck.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host):
#   bash scripts/verify-imported-desc-projection.sh
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

# A: the app's real ORDER BY (SORT_MAP['imported_desc'], lib/cursor-pagination.ts)
QUERY_ORDER_APP="imported_at DESC, domain ASC, email ASC, url ASC, password ASC"

# B: the projection's literal sort key expression (no DESC) -- exactly
# proj_imported_desc's ORDER BY from add-imported-desc-projection.sh
QUERY_ORDER_PROJ="negate(toUnixTimestamp(imported_at)), domain, email, url, password"

FORCE_SETTINGS="optimize_use_projections = 1, force_optimize_projection = 1, max_execution_time = 300, timeout_overflow_mode = 'throw'"

read -r -d '' QUERY_A <<EOF
SELECT $PROJ_COLS
FROM ulp.credentials
WHERE 1=1
ORDER BY $QUERY_ORDER_APP
LIMIT 50
SETTINGS $FORCE_SETTINGS
EOF

read -r -d '' QUERY_B <<EOF
SELECT $PROJ_COLS
FROM ulp.credentials
WHERE 1=1
ORDER BY $QUERY_ORDER_PROJ
LIMIT 50
SETTINGS $FORCE_SETTINGS
EOF

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Verify proj_imported_desc usage (task #10 follow-up)        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "═══ A) App's real query (ORDER BY $QUERY_ORDER_APP) ═══"
echo "  + force_optimize_projection=1 -- errors if no projection applies"
A_OK=1
if A_OUT=$($CH "$QUERY_A" --format Null 2>&1); then
  echo "SUCCESS -- $PROJ (the only projection on this table) is usable for"
  echo "this exact query. Timing it:"
  time $CH "$QUERY_A" --format Null
else
  A_OK=0
  echo "ERRORED (this is informative, not a problem):"
  echo "$A_OUT" | head -5
fi
echo ""

if [ "$A_OK" = "0" ]; then
  echo "═══ B) Projection's literal sort key (ORDER BY $QUERY_ORDER_PROJ) ═══"
  echo "  + force_optimize_projection=1 -- can the projection be used at all?"
  if B_OUT=$($CH "$QUERY_B" --format Null 2>&1); then
    echo "SUCCESS -- $PROJ IS usable, just not for the app's literal"
    echo "'imported_at DESC' form. ClickHouse isn't matching that against"
    echo "negate(toUnixTimestamp(imported_at)) via monotonic-function"
    echo "inference."
    echo ""
    echo ">>> Next step: rewrite the app's imported_desc ORDER BY"
    echo "    (lib/cursor-pagination.ts SORT_MAP + buildCursorWhere,"
    echo "    app/api/credentials/route.ts) to use"
    echo "    negate(toUnixTimestamp(imported_at)) literally instead of"
    echo "    'imported_at DESC'. Bigger change -- plan it separately."
  else
    echo "ERRORED too (this is informative, not a problem):"
    echo "$B_OUT" | head -5
    echo ""
    echo ">>> $PROJ isn't being selected for either query form. Most likely"
    echo "    ClickHouse's cost-based optimizer judges this table (499MB /"
    echo "    20.3M rows) too small for the projection to be worth it yet --"
    echo "    the earlier 0.627s -> 0.115s drop was most likely cache"
    echo "    warming from MATERIALIZE PROJECTION's full read, not $PROJ"
    echo "    being used."
    echo ""
    echo "    The projection may start being selected automatically as the"
    echo "    table grows toward the 'tens of billions' target -- harmless"
    echo "    to leave in place (re-run this script later to recheck). To"
    echo "    remove it now instead (frees its stored columns):"
    echo "      docker exec ulpsuite_clickhouse clickhouse-client --query \\"
    echo "        \"ALTER TABLE ulp.credentials DROP PROJECTION $PROJ\""
  fi
  echo ""
fi

echo "═══════════════════════════════════════════════════════════════"
echo "Read-only -- nothing was changed. Re-run any time, including after"
echo "the table grows, to recheck."
echo "═══════════════════════════════════════════════════════════════"
