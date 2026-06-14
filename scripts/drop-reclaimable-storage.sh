#!/bin/bash
# =============================================================================
# drop-reclaimable-storage.sh
#
# Reclaims the two items left over from the scale work (~1.86 GiB total vs a
# 499 MiB live dataset):
#
#   1. proj_imported_desc  (~1.14 GiB) -- the imported_at-desc projection.
#      Confirmed DORMANT (verify-imported-desc-projection.sh: the cost
#      optimizer won't auto-use it at 20.3M rows) and 2.3x the base table.
#      REVERSIBLE: re-add any time with add-imported-desc-projection.sh.
#
#   2. ulp.credentials_old (~719 MiB, 35.28M rows) -- the untouched pre-dedup
#      backup. Its only remaining role is the dedup rollback (the backlog
#      repair that also used it as a fallback is off the table -- case-D can't
#      be repaired in place). IRREVERSIBLE: once dropped, the pre-dedup data is
#      gone. Only drop this once you trust the dedup'd ulp.credentials.
#
# DESTRUCTIVE actions are OPT-IN. The default run only REPORTS sizes + the
# commands to actually drop. Enable each drop explicitly:
#
#   DROP_PROJECTION=1 bash scripts/drop-reclaimable-storage.sh   # drop projection
#   DROP_OLD=1        bash scripts/drop-reclaimable-storage.sh   # drop old table
#   DROP_PROJECTION=1 DROP_OLD=1 bash scripts/drop-reclaimable-storage.sh  # both
#
# The DROP_OLD path refuses unless ulp.credentials looks healthy (exists, has a
# sane row count, and has no pending mutations) -- a guard against dropping the
# backup when the live table is mid-rebuild or empty.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/drop-reclaimable-storage.sh        # report only (safe)
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
DROP_PROJECTION="${DROP_PROJECTION:-0}"
DROP_OLD="${DROP_OLD:-0}"
PROJ="proj_imported_desc"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — reclaim storage (projection + old backup)     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "DROP_PROJECTION=$DROP_PROJECTION   DROP_OLD=$DROP_OLD"
echo ""

# ── 1/3  Report sizes ────────────────────────────────────────────────────────
echo "═══ 1/3  Current sizes ══════════════════════════════════════════"
echo "-- proj_imported_desc footprint --"
$CH "
SELECT name AS projection, sum(rows) AS rows,
       formatReadableSize(sum(data_compressed_bytes)) AS compressed
FROM system.projection_parts
WHERE database='ulp' AND table='credentials' AND active=1
GROUP BY name
" --format PrettyCompact 2>&1 || echo "(none / system.projection_parts unavailable)"
echo ""
echo "-- tables (ulp) --"
$CH "
SELECT table, sum(rows) AS rows,
       formatReadableSize(sum(data_compressed_bytes)) AS compressed
FROM system.parts
WHERE database='ulp' AND active=1
GROUP BY table
ORDER BY sum(data_compressed_bytes) DESC
" --format PrettyCompact
echo ""

# ── 2/3  Drop projection (opt-in, reversible) ────────────────────────────────
echo "═══ 2/3  Drop projection $PROJ (reversible) ═════════════════════"
PROJ_PRESENT=$($CH "SELECT count() FROM system.projection_parts WHERE database='ulp' AND table='credentials' AND name='$PROJ' AND active=1")
if [ "${PROJ_PRESENT:-0}" = "0" ]; then
  echo "$PROJ not present -- nothing to drop."
elif [ "$DROP_PROJECTION" != "1" ]; then
  echo "Set DROP_PROJECTION=1 to drop it (re-add later with"
  echo "add-imported-desc-projection.sh). Skipping."
else
  echo "Dropping $PROJ ..."
  if ! $CH "ALTER TABLE ulp.credentials DROP PROJECTION $PROJ"; then
    echo "ERROR: DROP PROJECTION failed."
    exit 1
  fi
  echo "Dropped. (Reclaim shows up after background part cleanup.)"
fi
echo ""

# ── 3/3  Drop credentials_old (opt-in, IRREVERSIBLE, guarded) ────────────────
echo "═══ 3/3  Drop ulp.credentials_old (IRREVERSIBLE) ════════════════"
OLD_PRESENT=$($CH "SELECT count() FROM system.tables WHERE database='ulp' AND name='credentials_old'")
if [ "${OLD_PRESENT:-0}" = "0" ]; then
  echo "ulp.credentials_old not present -- nothing to drop."
elif [ "$DROP_OLD" != "1" ]; then
  echo "Set DROP_OLD=1 to drop the pre-dedup backup. This is IRREVERSIBLE --"
  echo "it is the dedup rollback. Skipping."
else
  # Safety guard: refuse if the live table looks unhealthy.
  CRED_ROWS=$($CH "SELECT count() FROM ulp.credentials")
  PENDING=$($CH "SELECT count() FROM system.mutations WHERE database='ulp' AND table='credentials' AND NOT is_done")
  echo "Live ulp.credentials: ${CRED_ROWS:-?} rows, ${PENDING:-?} pending mutations."
  if [ "${CRED_ROWS:-0}" -lt 1000000 ]; then
    echo "REFUSING: ulp.credentials has < 1,000,000 rows -- that does not look"
    echo "like the healthy dedup'd table. Not dropping the backup. Investigate."
    exit 1
  fi
  if [ "${PENDING:-1}" != "0" ]; then
    echo "REFUSING: ulp.credentials has pending mutations -- wait for them to"
    echo "finish before dropping the backup. Not dropping."
    exit 1
  fi
  echo "Guards passed. Dropping ulp.credentials_old ..."
  if ! $CH "DROP TABLE IF EXISTS ulp.credentials_old"; then
    echo "ERROR: DROP TABLE failed."
    exit 1
  fi
  echo "Dropped."
fi
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "-- Sizes after --"
$CH "
SELECT table, sum(rows) AS rows,
       formatReadableSize(sum(data_compressed_bytes)) AS compressed
FROM system.parts
WHERE database='ulp' AND active=1
GROUP BY table
ORDER BY sum(data_compressed_bytes) DESC
" --format PrettyCompact
echo ""
if [ "$DROP_PROJECTION" != "1" ] || [ "$DROP_OLD" != "1" ]; then
  echo "Report-only for anything not enabled. To actually reclaim:"
  echo "  DROP_PROJECTION=1 DROP_OLD=1 bash scripts/drop-reclaimable-storage.sh"
  echo "(drop the projection first/any time; drop credentials_old only once you"
  echo " trust the dedup -- it is IRREVERSIBLE.)"
fi
echo "═══════════════════════════════════════════════════════════════"
