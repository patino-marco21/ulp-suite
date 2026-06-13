#!/bin/bash
# =============================================================================
# recover-credentials-part.sh
#
# Re-attaches the 40.12 GiB detached part holding the original ~1.46B-row
# ulp.credentials dataset (partition 202605, May 2026).
#
# Background
# -----------
# diagnose-detached-credentials-part.sh confirmed:
#   - /var/lib/clickhouse/store/c18/c18dd084-.../detached/
#       broken-on-start_202605_31_3755_8_3863/   (40.12 GiB)
#   - count.txt = 1457952559 rows
#   - checksums.txt, columns.txt, primary.cidx, minmax_imported_at.idx,
#     partition.dat and all 121 column/index files present with sane sizes
#
# This part was very likely swept into detached/ wholesale during the
# force_restore_data recovery (triggered by the cascading domain_counts
# TOO_MANY_UNEXPECTED_DATA_PARTS failure), NOT because it's actually corrupt.
# Everything needed for ATTACH PART looks intact.
#
# What this script does
# ----------------------
#   1. Verifies the detached part still exists where expected
#   2. Makes an on-disk COPY of the part (still inside detached/, ~40GB,
#      plenty of free space — 799 GiB free in the ClickHouse volume) as a
#      safety net BEFORE touching the original
#   3. Renames the original off the "broken-on-start_" prefix — ATTACH PART
#      requires a name matching <partition>_<min>_<max>_<level>[_<mutation>]
#   4. Runs ALTER TABLE ulp.credentials ATTACH PART '202605_31_3755_8_3863'
#   5. Verifies the new row count and per-partition breakdown
#
# If ATTACH PART fails for any reason, the renamed directory remains in
# detached/ (ATTACH PART does not delete on failure) AND the backup copy
# (step 2) is untouched — nothing is lost either way.
#
# After a successful attach, ulp.credentials will contain BOTH the restored
# May 2026 (202605) partition (~1.46B rows) and whatever June 2026 (202606)
# rows have been inserted since the restart. NOTE: if any of the files
# currently in ./inbox were ALREADY part of the original 1.46B-row dataset,
# re-processing them will create duplicate rows (ulp.credentials is a plain
# MergeTree, not ReplacingMergeTree — dedup only happens within a single
# import batch). Consider pausing new imports until you've confirmed which
# inbox files are genuinely new vs. already-represented in the May partition.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/recover-credentials-part.sh
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
TBL_DIR="/var/lib/clickhouse/store/c18/c18dd084-8910-4696-9bcf-abfc0a0134e8/detached"
ORIG_NAME="broken-on-start_202605_31_3755_8_3863"
NEW_NAME="202605_31_3755_8_3863"
BACKUP_NAME="BACKUP_${NEW_NAME}"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — recover detached credentials part (1.46B rows) ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "Step 1/5  Verifying detached part exists..."
if ! docker exec ulpsuite_clickhouse sh -c "[ -d '$TBL_DIR/$ORIG_NAME' ]"; then
  echo "ERROR: $TBL_DIR/$ORIG_NAME not found."
  echo "It may already have been renamed/attached. Check with:"
  echo "  docker exec ulpsuite_clickhouse ls -la '$TBL_DIR'"
  exit 1
fi
COUNT=$(docker exec ulpsuite_clickhouse cat "$TBL_DIR/$ORIG_NAME/count.txt" 2>/dev/null || echo "?")
echo "          Found. count.txt reports $COUNT rows."
echo ""

echo "Step 2/5  Making an on-disk backup copy (this copies ~40GB, may take"
echo "          a few minutes — same volume, 799 GiB free)..."
if docker exec ulpsuite_clickhouse sh -c "[ -d '$TBL_DIR/$BACKUP_NAME' ]"; then
  echo "          Backup already exists at $TBL_DIR/$BACKUP_NAME — skipping copy."
else
  docker exec ulpsuite_clickhouse cp -r "$TBL_DIR/$ORIG_NAME" "$TBL_DIR/$BACKUP_NAME"
  echo "          Done. Backup at: $TBL_DIR/$BACKUP_NAME"
fi
echo ""

echo "Step 3/5  Renaming off the 'broken-on-start_' prefix..."
if docker exec ulpsuite_clickhouse sh -c "[ -d '$TBL_DIR/$NEW_NAME' ]"; then
  echo "          $TBL_DIR/$NEW_NAME already exists — skipping rename."
else
  docker exec ulpsuite_clickhouse mv "$TBL_DIR/$ORIG_NAME" "$TBL_DIR/$NEW_NAME"
  echo "          Done. Renamed to: $TBL_DIR/$NEW_NAME"
fi
echo ""

echo "Step 4/5  Attaching part to ulp.credentials..."
ATTACH_OUT=$($CH "ALTER TABLE ulp.credentials ATTACH PART '$NEW_NAME'" 2>&1)
ATTACH_STATUS=$?
echo "$ATTACH_OUT"
if [ $ATTACH_STATUS -ne 0 ]; then
  echo ""
  echo "  ⚠  ATTACH PART failed (see error above)."
  echo "     The part is still safe in detached/ as '$NEW_NAME', and a full"
  echo "     backup copy exists at '$BACKUP_NAME'. Nothing was lost."
  echo "     Share the error output above before trying anything else."
  exit 1
fi
echo "          Done."
echo ""

echo "Step 5/5  Verifying..."
$CH "SELECT count() AS total_rows FROM ulp.credentials" --format PrettyCompact
echo ""
$CH "
SELECT partition, count() AS parts, sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
GROUP BY partition
ORDER BY partition
" --format PrettyCompact
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Recovery complete."
echo ""
echo "ulp.credentials should now show ~1.46B rows (partition 202605) plus"
echo "whatever June 2026 (202606) rows were inserted since the restart."
echo ""
echo "A backup copy of the recovered part is still sitting at:"
echo "  $TBL_DIR/$BACKUP_NAME  (~40 GiB)"
echo "Once you've confirmed the Credentials page looks correct, you can"
echo "remove it to reclaim space:"
echo "  docker exec ulpsuite_clickhouse rm -rf '$TBL_DIR/$BACKUP_NAME'"
echo ""
echo "Reminder: if any files in ./inbox were already part of the original"
echo "1.46B-row dataset, re-processing them now will create duplicate rows"
echo "(ulp.credentials is a plain MergeTree). Review ./inbox vs. what's"
echo "already in the 202605 partition before letting more imports run."
echo "═══════════════════════════════════════════════════════════════"
