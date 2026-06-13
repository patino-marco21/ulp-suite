#!/bin/bash
# =============================================================================
# diagnose-empty-credentials.sh
#
# READ-ONLY diagnostic for: the inbox/upload pipeline reports billions of
# rows successfully parsed, but the Credentials page shows no data.
#
# Two likely causes, both non-destructive to fix:
#
#  1. Async insert buffering — with async_insert=1 + wait_for_async_insert=0,
#     INSERT returns immediately while rows sit in an in-memory buffer until
#     async_insert_busy_timeout_ms elapses. SELECT count() won't see them
#     until the buffer flushes. (ulp-profiles.xml sets these.)
#
#  2. ulp.credentials itself failed to ATTACH (same family of issue as the
#     domain_counts TOO_MANY_UNEXPECTED_DATA_PARTS crash) — every INSERT
#     errors out, but the app's "rows parsed" counter may reflect lines
#     READ from the file, not rows ACKNOWLEDGED by ClickHouse.
#
# This script does NOT modify any data. Run it BEFORE deciding to wipe and
# restart from scratch — a wipe here would destroy the only evidence of
# which of the above is happening.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-empty-credentials.sh
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — empty credentials diagnostics (read-only)      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "── 1/6  Container status ────────────────────────────────────────"
docker compose ps
echo ""

echo "── 2/6  Does ulp.credentials exist and what does ClickHouse think ─"
echo "       its row count is right now?"
$CH "EXISTS TABLE ulp.credentials" --format PrettyCompact || true
$CH "SELECT count() AS credentials_count FROM ulp.credentials" --format PrettyCompact || true
echo ""

echo "── 3/6  Where DID the data land? (all databases/tables by row count) ─"
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
" --format PrettyCompact
echo ""

echo "── 4/6  Recent INSERT queries against ulp.credentials (last 20) ──"
echo "       Look at 'exception_code' / 'exception' — non-empty means the"
echo "       insert FAILED even if the app reported success."
$CH "
SELECT event_time, query_kind, written_rows, exception_code,
       substring(exception, 1, 200) AS exception
FROM system.query_log
WHERE query ILIKE '%INSERT%ulp.credentials%'
ORDER BY event_time DESC
LIMIT 20
" --format PrettyCompact
echo ""

echo "── 5/6  Async insert settings currently in effect ────────────────"
$CH "
SELECT name, value
FROM system.settings
WHERE name IN ('async_insert','wait_for_async_insert','async_insert_busy_timeout_ms')
" --format PrettyCompact
echo ""

echo "── 6/6  App container errors during processing (last 300 lines) ─"
docker compose logs app --tail=300 2>/dev/null \
  | grep -iE "error|exception|fail" | tail -40 \
  || echo "  (no error/exception/fail lines found)"
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Share this output before deciding to wipe and restart."
echo ""
echo "If step 3 shows the rows landed somewhere (any database/table),"
echo "the data exists — this is a visibility or routing issue, not loss."
echo ""
echo "If step 4 shows exception_code != 0 for the INSERTs, ulp.credentials"
echo "itself likely failed to attach — check 'docker compose logs"
echo "clickhouse --tail=200' for a TOO_MANY_UNEXPECTED_DATA_PARTS or"
echo "similar ATTACH error, same family as the domain_counts issue."
echo "═══════════════════════════════════════════════════════════════"
