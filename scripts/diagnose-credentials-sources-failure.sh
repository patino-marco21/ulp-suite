#!/bin/bash
# =============================================================================
# diagnose-credentials-sources-failure.sh
#
# READ-ONLY. Investigates why the UI shows:
#   - Credentials Browser: "No credentials found" + "Failed to load" toast
#   - Sources: "0 files imported" / "No sources yet"
# even though ulp.credentials holds the recovered ~1.48B rows
# (confirmed via direct clickhouse-client queries after the 2026-06-13
# part recovery).
#
# Hypothesis (from code + schema review, NOT yet confirmed):
#
#   ulp.credentials: ORDER BY (domain, email, imported_at),
#                     PARTITION BY toYYYYMM(imported_at)
#   Partition 202605 is currently ONE part: 1,457,952,559 rows / 40.12 GiB.
#
#   - app/api/credentials/route.ts, default sort 'imported_desc' =
#       "imported_at DESC, domain ASC, email ASC, url ASC, password ASC"
#     with WHERE 1=1 (no filter). This order is NOT a prefix of the table's
#     sort key, so ClickHouse can't use optimize_read_in_order — it must
#     read+sort those columns across all 1.48B rows.
#     SETTINGS max_execution_time = 300 (5 min) — could hit that, or
#     MEMORY_LIMIT_EXCEEDED first (message wouldn't contain "timeout", so
#     it falls through to the generic 500 "Query failed" branch, which
#     matches the "Failed to load" toast).
#
#   - app/api/sources/route.ts, third query:
#       SELECT source_file, count() AS cred_count FROM ulp.credentials
#       GROUP BY source_file SETTINGS max_execution_time = 30
#     source_file isn't in the sort key either — full scan+aggregate over
#     1.48B rows in a 30s budget. If THIS query throws, the whole
#     Promise.all rejects -> /api/sources returns {success:false} ->
#     UI shows the empty-state "0 files imported / No sources yet"
#     (not a visible error, since the page doesn't distinguish error vs.
#     empty for this endpoint).
#
# This script does NOT re-run those expensive queries. It inspects:
#   1. App container logs for the verbose ClickHouse error lines
#      (lib/clickhouse.ts logs "❌ ClickHouse query error: ..." with the
#      exact code/message/type for every failed query).
#   2. system.query_log for exceptions/slow entries against
#      ulp.credentials / ulp.sources in the last hour — this already
#      contains whatever happened when you loaded the UI.
#   3. system.parts sanity check (confirm the 1.48B rows are still intact).
#   4. Current ClickHouse memory usage + relevant settings.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-credentials-sources-failure.sh
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
REPORT="/tmp/ulp-cred-sources-failure-$(date +%Y%m%d-%H%M%S).txt"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — /api/credentials & /api/sources failure (RO)   ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/4  App logs — ClickHouse query errors ════════════════════════"
echo "(searching last 1000 lines of 'app' container logs for the verbose"
echo " error blocks logged by lib/clickhouse.ts's executeQuery catch block)"
echo ""
MATCHES=$(docker compose logs app --tail=1000 2>/dev/null | grep -B1 -A8 "ClickHouse query error\|Credentials browse error\|Sources error\|Error code:\|Error type")
if [ -n "$MATCHES" ]; then
  echo "$MATCHES" | tail -200
else
  echo "(no matching error lines in the last 1000 log lines — showing last 40"
  echo " lines of app logs for context instead)"
  echo ""
  docker compose logs app --tail=40 2>/dev/null
fi
echo ""

echo "═══ 2/4  system.query_log — exceptions/slow queries, last 60 min ══"
$CH "
SELECT event_time, type, query_duration_ms, memory_usage,
       read_rows, exception, left(query, 180) AS query_preview
FROM system.query_log
WHERE event_time >= now() - INTERVAL 60 MINUTE
  AND is_initial_query = 1
  AND (query ILIKE '%ulp.credentials%' OR query ILIKE '%ulp.sources%')
  AND type IN ('QueryFinish','ExceptionWhileProcessing')
ORDER BY event_time DESC
LIMIT 30
" --format Vertical
echo ""

echo "═══ 3/4  ulp.credentials parts (sanity check) ══════════════════════"
$CH "
SELECT partition, count() AS parts, sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
GROUP BY partition
ORDER BY partition
" --format PrettyCompact
echo ""
$CH "SELECT count() AS total_sources FROM ulp.sources" --format PrettyCompact
echo ""

echo "═══ 4/4  ClickHouse memory + relevant settings ════════════════════"
$CH "SELECT metric, value FROM system.metrics WHERE metric = 'MemoryTracking'" --format PrettyCompact
$CH "SELECT name, value, description FROM system.settings WHERE name IN ('max_memory_usage','max_execution_time','max_threads')" --format PrettyCompact
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What this tells us:"
echo "  - Section 1 should show the EXACT error (code/message) the app got"
echo "    from ClickHouse for the failed /api/credentials and/or"
echo "    /api/sources requests."
echo "  - Section 2 shows ClickHouse's own record of those queries —"
echo "    'exception' column will say e.g. TIMEOUT_EXCEEDED or"
echo "    MEMORY_LIMIT_EXCEEDED if that's what happened, plus actual"
echo "    query_duration_ms / memory_usage / read_rows for comparison."
echo "  - Section 3 confirms the 1.48B rows are still intact (this is a"
echo "    query-performance issue, not a data issue, if so)."
echo "  - Section 4 gives the ceiling each query is working within."
echo "Share the output and I'll pin down the exact cause before proposing"
echo "a fix."
echo "═══════════════════════════════════════════════════════════════"
