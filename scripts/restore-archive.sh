#!/bin/bash
# =============================================================================
# restore-archive.sh
#
# Loads an archive file (produced by scripts/archive-old-partitions.sh) into an
# isolated ulp.archive_scratch_<timestamp> table for occasional deep dives --
# NEVER ulp.credentials directly, so a restore can never collide with or
# overwrite live production data. Mirrors scripts/benchmark-import.ts's
# assertBenchTable isolation guard, adapted to bash.
#
# Usage:
#   bash scripts/restore-archive.sh ./archive/202601.native.zst
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

ARCHIVE_FILE="${1:-}"
if [ -z "$ARCHIVE_FILE" ] || [ ! -f "$ARCHIVE_FILE" ]; then
  echo "Usage: bash scripts/restore-archive.sh <path-to-archive-file>.native.zst"
  exit 1
fi

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
TABLE="ulp.archive_scratch_$(date +%s)"

# Guard: refuse to operate on anything but a ulp.archive_scratch_* table -- a
# restore must never be able to target ulp.credentials, even by mistake.
if [[ ! "$TABLE" =~ ^ulp\.archive_scratch_[0-9]+$ ]]; then
  echo "ERROR: refusing to use non-scratch table name: $TABLE"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — restore archive into scratch table              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Archive file: $ARCHIVE_FILE"
echo "Target (isolated, never live): $TABLE"
echo ""

echo "═══ Creating scratch table (same shape as ulp.credentials, plain local MergeTree) ═══"
$CH "CREATE TABLE $TABLE AS ulp.credentials ENGINE = MergeTree PARTITION BY toYYYYMM(imported_at) ORDER BY (domain, email, imported_at)"

echo "═══ Loading archive into $TABLE ═══"
if ! (zstd -dc "$ARCHIVE_FILE" | docker exec -i ulpsuite_clickhouse clickhouse-client --query "INSERT INTO $TABLE FORMAT Native"); then
  echo "ERROR: restore failed. $TABLE may be partially populated -- inspect or drop it:"
  echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \"DROP TABLE $TABLE\""
  exit 1
fi

echo "═══ Verify ═══"
$CH "SELECT count() AS rows FROM $TABLE" --format PrettyCompact

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Restored into $TABLE. Query it directly, e.g.:"
echo "  docker exec -it ulpsuite_clickhouse clickhouse-client --query \"SELECT * FROM $TABLE LIMIT 10\""
echo ""
echo "This scratch table is never cleaned up automatically -- drop it when done:"
echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \"DROP TABLE $TABLE\""
echo "═══════════════════════════════════════════════════════════════"
