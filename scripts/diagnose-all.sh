#!/bin/bash
# =============================================================================
# diagnose-all.sh
#
# Single READ-ONLY diagnostic sweep for "what is going on right now" with
# ClickHouse / the import pipeline. Writes a full report to a timestamped
# file (easy to paste/share) AND prints it to stdout.
#
# Covers, in one pass:
#   1. Container status + health
#   2. Disk space (host volumes + ClickHouse's view of its own disk)
#   3. ClickHouse version, databases, ulp tables + live row/part counts
#   4. Detached parts across ALL ulp tables, grouped by table + reason
#      (this is where "missing" rows usually are — nothing here is deleted)
#   5. Where rows actually landed, across ALL databases/tables (system.parts)
#   6. Recent INSERT query_log entries for ulp.credentials, with exceptions
#   7. Async-insert settings currently in effect
#   8. ClickHouse server log: ATTACH / restore / suspicious-parts messages
#      from the most recent startup
#   9. App's SQLite metadata: ch_ddl_version / ch_repair_mutations_fired /
#      ch_mv_backfill_fired, and the last 20 processing_jobs rows (import
#      history with imported/skipped/error_message per file)
#  10. App container errors (last 300 lines)
#  11. ./inbox and ./uploads directory listing
#
# Nothing here modifies data, config, or containers. Safe to run anytime.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-all.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

REPORT="/tmp/ulp-diagnostics-$(date +%Y%m%d-%H%M%S).txt"
CH="docker exec ulpsuite_clickhouse clickhouse-client --query"

# Tee everything to both stdout and the report file
exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — full diagnostic sweep (read-only)               ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/11  Container status + health ════════════════════════════"
docker compose ps
echo ""

echo "═══ 2/11  Disk space ════════════════════════════════════════════"
echo "-- Host filesystem --"
df -h / 2>/dev/null
echo ""
echo "-- ClickHouse container's view of /var/lib/clickhouse --"
docker exec ulpsuite_clickhouse df -h /var/lib/clickhouse 2>/dev/null
echo ""
echo "-- system.disks (as ClickHouse sees it) --"
$CH "SELECT name, formatReadableSize(free_space) AS free, formatReadableSize(total_space) AS total FROM system.disks" --format PrettyCompact 2>/dev/null
echo ""

echo "═══ 3/11  ClickHouse version, databases, ulp table row counts ═══"
$CH "SELECT version()" --format PrettyCompact 2>/dev/null
$CH "SHOW DATABASES" --format PrettyCompact 2>/dev/null
echo ""
echo "-- Tables currently in ulp (post-DDL-v10, the 4 MV tables should be GONE) --"
$CH "SELECT name, engine FROM system.tables WHERE database = 'ulp' ORDER BY name" --format PrettyCompact 2>/dev/null
echo ""
echo "-- Live row/part counts per ulp table --"
$CH "
SELECT table,
       count() AS active_parts,
       sum(rows) AS active_rows,
       formatReadableSize(sum(bytes_on_disk)) AS active_size
FROM system.parts
WHERE database = 'ulp' AND active
GROUP BY table
ORDER BY active_rows DESC
" --format PrettyCompact 2>/dev/null
echo ""

echo "═══ 4/11  Detached parts — ALL ulp tables, by reason ═══════════"
echo "    (NOT deleted — sitting in detached/ on disk, recoverable)"
$CH "
SELECT table, reason,
       count() AS parts,
       sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.detached_parts
WHERE database = 'ulp'
GROUP BY table, reason
ORDER BY table, rows DESC
" --format PrettyCompact 2>/dev/null
echo ""

echo "═══ 5/11  Where did the data land? (top 20 across ALL databases) ═"
$CH "
SELECT database, table,
       count() AS parts,
       sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts
WHERE active
GROUP BY database, table
ORDER BY rows DESC
LIMIT 20
" --format PrettyCompact 2>/dev/null
echo ""

echo "═══ 6/11  Recent INSERT queries against ulp.credentials (last 20) ═"
echo "    Non-empty exception = the insert FAILED even if the app"
echo "    reported success."
$CH "
SELECT event_time, written_rows, exception_code,
       substring(exception, 1, 200) AS exception
FROM system.query_log
WHERE query ILIKE '%INSERT%ulp.credentials%'
ORDER BY event_time DESC
LIMIT 20
" --format PrettyCompact 2>/dev/null
echo ""

echo "═══ 7/11  Async insert settings currently in effect ═════════════"
$CH "
SELECT name, value
FROM system.settings
WHERE name IN ('async_insert','wait_for_async_insert','async_insert_busy_timeout_ms')
" --format PrettyCompact 2>/dev/null
echo ""

echo "═══ 8/11  ClickHouse startup log — ATTACH / restore / suspicious ═"
docker compose logs clickhouse 2>/dev/null \
  | grep -iE "force_restore_data|Detaching|unexpected|suspicious|Cannot attach|TOO_MANY|CORRUPTED" \
  | tail -60 || echo "  (no matching lines found — logs may have rotated)"
echo ""

echo "═══ 9/11  App SQLite metadata (ch_* settings + last 20 import jobs) ═"
docker exec ulpsuite_app node -e "
const db = require('better-sqlite3')('/app/data/ulp.db');
console.log('-- app_settings (ch_*) --');
console.log(JSON.stringify(db.prepare(\"SELECT key_name, value, updated_at FROM app_settings WHERE key_name LIKE 'ch_%'\").all(), null, 2));
console.log('');
console.log('-- last 20 processing_jobs --');
console.log(JSON.stringify(db.prepare('SELECT id, source, filename, status, imported, skipped, duration_ms, error_message, created_at FROM processing_jobs ORDER BY id DESC LIMIT 20').all(), null, 2));
" 2>/dev/null || echo "  (could not query SQLite — app container may be down)"
echo ""

echo "═══ 10/11  App container errors (last 300 lines) ═══════════════"
docker compose logs app --tail=300 2>/dev/null \
  | grep -iE "error|exception|fail" | tail -50 \
  || echo "  (no error/exception/fail lines found)"
echo ""

echo "═══ 11/11  ./inbox and ./uploads directory listing ═════════════"
echo "-- ./inbox --"
ls -la ./inbox 2>/dev/null || echo "  (not found)"
echo ""
echo "-- ./uploads --"
ls -la ./uploads 2>/dev/null || echo "  (not found)"
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo "Share that file's contents — it has everything needed to decide"
echo "the next step without guessing or wiping anything."
echo "═══════════════════════════════════════════════════════════════"
