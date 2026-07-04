#!/bin/bash
# =============================================================================
# archive-old-partitions.sh
#
# Exports partitions of ulp.credentials older than ARCHIVE_AGE_MONTHS (default 3)
# to compact zstd-compressed Native-format files in ARCHIVE_DIR (default ./archive),
# then drops them from the live table -- the on-disk cold-tier half of
# docs/superpowers/specs/2026-07-03-scale-tiered-archive-design.md.
#
# Native format round-trips back into a table later (see scripts/restore-archive.sh)
# with no schema translation, and carries none of the live table's index/projection
# storage overhead, so an archived partition is far denser than its live equivalent.
#
# SAFETY: dry-run by default -- reports candidate partitions and their row counts,
# exports and drops NOTHING unless APPLY=1. A partition is only dropped after its
# row count is re-confirmed unchanged against the live table right before the drop.
#
# Usage:
#   bash scripts/archive-old-partitions.sh                       # dry run (default)
#   APPLY=1 bash scripts/archive-old-partitions.sh                # actually export + drop
#   ARCHIVE_AGE_MONTHS=6 bash scripts/archive-old-partitions.sh   # override the age threshold
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
ARCHIVE_AGE_MONTHS="${ARCHIVE_AGE_MONTHS:-3}"
ARCHIVE_DIR="${ARCHIVE_DIR:-./archive}"
APPLY="${APPLY:-0}"

CUTOFF=$($CH "SELECT formatDateTime(addMonths(today(), -${ARCHIVE_AGE_MONTHS}), '%Y%m')" --format TabSeparated)

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — archive old partitions                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Cutoff partition (older than $ARCHIVE_AGE_MONTHS months): $CUTOFF"
echo "Archive directory: $ARCHIVE_DIR"
echo ""

echo "═══ Candidate partitions ═══"
$CH "
SELECT partition, sum(rows) AS rows, formatReadableSize(sum(data_compressed_bytes)) AS compressed
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
  AND partition < '$CUTOFF'
GROUP BY partition
ORDER BY partition
" --format PrettyCompact

PARTITIONS=$($CH "
SELECT DISTINCT partition FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
  AND partition < '$CUTOFF'
ORDER BY partition
" --format TabSeparated)

if [ -z "$PARTITIONS" ]; then
  echo "No partitions older than $CUTOFF. Nothing to do."
  exit 0
fi

if [ "$APPLY" != "1" ]; then
  echo ""
  echo "Dry-run. Set APPLY=1 to actually export + drop the partitions above."
  exit 0
fi

mkdir -p "$ARCHIVE_DIR"

for PART in $PARTITIONS; do
  FILE="$ARCHIVE_DIR/$PART.native.zst"
  echo ""
  echo "-- Partition $PART: exporting to $FILE --"
  EXPECTED=$($CH "SELECT count() FROM ulp.credentials WHERE toYYYYMM(imported_at) = $PART" --format TabSeparated)

  if ! (docker exec ulpsuite_clickhouse clickhouse-client --query \
    "SELECT * FROM ulp.credentials WHERE toYYYYMM(imported_at) = $PART FORMAT Native" \
    | zstd -q -o "$FILE"); then
    echo "ERROR: export failed for partition $PART. Not dropping. Skipping."
    rm -f "$FILE"
    continue
  fi

  ACTUAL=$($CH "SELECT count() FROM ulp.credentials WHERE toYYYYMM(imported_at) = $PART" --format TabSeparated)

  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "ERROR: row count changed during export ($EXPECTED -> $ACTUAL) for partition $PART."
    echo "Not dropping -- live data may have changed mid-export (e.g. a new import landed)."
    echo "Re-run once imports have quiesced."
    rm -f "$FILE"
    continue
  fi

  echo "Verified: $ACTUAL rows exported and confirmed still $ACTUAL live. Dropping partition."
  $CH "ALTER TABLE ulp.credentials DROP PARTITION '$PART'"
  echo "Dropped partition $PART ($ACTUAL rows archived to $FILE)."
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Done. Archived files are in $ARCHIVE_DIR/ -- restore with scripts/restore-archive.sh."
echo "═══════════════════════════════════════════════════════════════"
