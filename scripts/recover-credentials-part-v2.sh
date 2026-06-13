#!/bin/bash
# =============================================================================
# recover-credentials-part-v2.sh
#
# Follow-up to recover-credentials-part.sh, which got the 40.12 GiB detached
# part renamed to '202605_31_3755_8_3863' and backed up to
# 'BACKUP_202605_31_3755_8_3863', but ATTACH PART failed with:
#
#   Code: 107. DB::Exception: ... detached/attaching_202605_31_3755_8_3863/
#   serialization.json doesn't exist: columns: columns format version: 1 ...
#
# Root cause (confirmed against ClickHouse 26.3 source,
# src/Storages/MergeTree/MergeTreeDataPartChecksum.cpp):
#
#   The part's checksums.txt lists 'serialization.json' as a file that should
#   exist (recorded when this part was written by an older ClickHouse
#   version). The actual serialization.json file is missing from the part
#   directory on disk. ATTACH PART calls
#   loadColumnsChecksumsIndexes(require_columns_checksums=false, check_consistency=true)
#   -> checkConsistencyBase() iterates every file listed in checksums.txt and
#   calls existsFile() on it -> false for serialization.json -> throws
#   FILE_DOESNT_EXIST ("... doesn't exist").
#
# The fix: when checksums.txt is ABSENT (not just inconsistent), loadChecksums
# falls back to recomputing checksums from the files actually present on disk
# (checkDataPart()), and that recomputation only adds 'serialization.json' to
# the new checksums.txt IF the file actually exists. Since it doesn't, the
# freshly-computed checksums.txt won't reference it, and checkConsistencyBase
# will pass.
#
# So: remove checksums.txt from the renamed part directory (saving a copy
# first) and retry ATTACH PART. ClickHouse will read through the part's ~40GB
# of column/index files to recompute checksums (read-only against those
# files, may take a few minutes), write a fresh checksums.txt, and attach.
#
# Safety:
#   - A full copy of the original part (including its original checksums.txt)
#     already exists at detached/BACKUP_202605_31_3755_8_3863/ from the
#     previous script run.
#   - This script additionally copies checksums.txt out to
#     detached/SAVED_checksums_202605_31_3755_8_3863.txt before removing it
#     from the working copy, and restores it if ATTACH fails again.
#   - Any leftover detached/attaching_202605_31_3755_8_3863/ directory from
#     the failed previous attempt is removed first (it's a partial hardlinked
#     copy ClickHouse left behind; the real data is in '202605_31_3755_8_3863'
#     and the BACKUP copy).
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/recover-credentials-part-v2.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --receive_timeout=1800 --query"
TBL_DIR="/var/lib/clickhouse/store/c18/c18dd084-8910-4696-9bcf-abfc0a0134e8/detached"
PART_NAME="202605_31_3755_8_3863"
ATTACHING_NAME="attaching_${PART_NAME}"
BACKUP_NAME="BACKUP_${PART_NAME}"
SAVED_CHECKSUMS="SAVED_checksums_${PART_NAME}.txt"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — recover credentials part v2 (fix checksums)    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "Step 1/6  Current state of detached/..."
docker exec ulpsuite_clickhouse sh -c "ls -la '$TBL_DIR'"
echo ""

echo "Step 2/6  Removing leftover '$ATTACHING_NAME' from the failed attempt"
echo "          (if present — it's a partial hardlinked copy; the real data"
echo "          is safe in '$PART_NAME' and '$BACKUP_NAME')..."
if docker exec ulpsuite_clickhouse sh -c "[ -d '$TBL_DIR/$ATTACHING_NAME' ]"; then
  docker exec ulpsuite_clickhouse rm -rf "$TBL_DIR/$ATTACHING_NAME"
  echo "          Removed."
else
  echo "          Not present — nothing to remove."
fi
echo ""

echo "Step 3/6  Verifying '$PART_NAME' exists, has checksums.txt, and is"
echo "          missing serialization.json (the root cause)..."
if ! docker exec ulpsuite_clickhouse sh -c "[ -d '$TBL_DIR/$PART_NAME' ]"; then
  echo "ERROR: $TBL_DIR/$PART_NAME not found. Has it already been attached?"
  echo "Check with: docker exec ulpsuite_clickhouse ls -la '$TBL_DIR'"
  echo "and: docker exec ulpsuite_clickhouse clickhouse-client --query \"SELECT count() FROM ulp.credentials\""
  exit 1
fi
if ! docker exec ulpsuite_clickhouse sh -c "[ -f '$TBL_DIR/$PART_NAME/checksums.txt' ]"; then
  echo "ERROR: $TBL_DIR/$PART_NAME/checksums.txt not found."
  echo "This script's assumption (checksums.txt present but references a"
  echo "missing serialization.json) doesn't hold. Stop here and share:"
  docker exec ulpsuite_clickhouse sh -c "ls -la '$TBL_DIR/$PART_NAME'"
  exit 1
fi
if docker exec ulpsuite_clickhouse sh -c "[ -f '$TBL_DIR/$PART_NAME/serialization.json' ]"; then
  echo "          NOTE: serialization.json IS present after all — the"
  echo "          original error may have a different cause. Proceeding"
  echo "          anyway (removing checksums.txt is harmless either way,"
  echo "          ClickHouse will just recompute it), but flag this for"
  echo "          review if ATTACH still fails."
else
  echo "          Confirmed: checksums.txt present, serialization.json absent."
fi
echo ""

echo "Step 4/6  Saving a copy of checksums.txt, then removing it from the"
echo "          working copy so ClickHouse recomputes it from the actual"
echo "          on-disk files during ATTACH..."
if docker exec ulpsuite_clickhouse sh -c "[ -f '$TBL_DIR/$SAVED_CHECKSUMS' ]"; then
  echo "          $TBL_DIR/$SAVED_CHECKSUMS already exists — skipping save."
else
  docker exec ulpsuite_clickhouse cp "$TBL_DIR/$PART_NAME/checksums.txt" "$TBL_DIR/$SAVED_CHECKSUMS"
  echo "          Saved to: $TBL_DIR/$SAVED_CHECKSUMS"
fi
docker exec ulpsuite_clickhouse rm -f "$TBL_DIR/$PART_NAME/checksums.txt"
echo "          Removed checksums.txt from $TBL_DIR/$PART_NAME/"
echo ""

echo "Step 5/6  Attaching part to ulp.credentials..."
echo "          ClickHouse will read through ~40GB of column/index files to"
echo "          recompute checksums.txt from scratch — this can take a few"
echo "          minutes. Please be patient."
ATTACH_OUT=$($CH "ALTER TABLE ulp.credentials ATTACH PART '$PART_NAME'" 2>&1)
ATTACH_STATUS=$?
echo "$ATTACH_OUT"
if [ $ATTACH_STATUS -ne 0 ]; then
  echo ""
  echo "  ⚠  ATTACH PART failed again (see error above)."
  echo "     Restoring checksums.txt from the saved copy..."
  docker exec ulpsuite_clickhouse cp "$TBL_DIR/$SAVED_CHECKSUMS" "$TBL_DIR/$PART_NAME/checksums.txt" 2>/dev/null \
    && echo "     Restored." \
    || echo "     '$PART_NAME' may have been consumed/renamed by the failed attempt — check $TBL_DIR"
  echo "     The full backup copy is still safe at: $TBL_DIR/$BACKUP_NAME"
  echo "     Share the error output above before trying anything else."
  exit 1
fi
echo "          Done."
echo ""

echo "Step 6/6  Verifying..."
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
echo "Cleanup (once you've confirmed the Credentials page looks correct):"
echo "  docker exec ulpsuite_clickhouse rm -rf '$TBL_DIR/$BACKUP_NAME'"
echo "  docker exec ulpsuite_clickhouse rm -f  '$TBL_DIR/$SAVED_CHECKSUMS'"
echo ""
echo "Reminder: if any files in ./inbox were already part of the original"
echo "1.46B-row dataset, re-processing them now will create duplicate rows"
echo "(ulp.credentials is a plain MergeTree). Review ./inbox vs. what's"
echo "already in the 202605 partition before letting more imports run."
echo "═══════════════════════════════════════════════════════════════"
