#!/bin/bash
# =============================================================================
# diagnose-detached-credentials-part.sh
#
# READ-ONLY follow-up to diagnose-credentials-data-dir.sh.
#
# Found: /var/lib/clickhouse/store/c18/c18dd084-.../detached/
#          broken-on-start_202605_31_3755_8_3863/   (40.12 GiB, partition 202605)
#
# This is almost certainly the bulk of the original ~52M-row dataset
# (a heavily-merged part — level 8, covering insert blocks 31..3755 — i.e.
# thousands of merged inserts from May 2026, partition 202605). It is sitting
# safely in detached/, untouched by anything so far.
#
# Before attempting `ALTER TABLE ulp.credentials ATTACH PART` (which requires
# renaming off the broken-on-start_ prefix first), this script gathers
# evidence on:
#   1. What files exist inside the part directory (checksums.txt, columns.txt,
#      count.txt, primary.idx, partition.dat, per-column .bin/.mrk files) and
#      whether count.txt gives us the row count without touching anything
#   2. The ClickHouse server log around 02:10 (when it was detached) — the
#      actual reason this specific part (not domain_counts) was flagged
#      broken-on-start
#   3. Free disk space (to confirm there's room for a safety-copy of this
#      40GB part before any ATTACH attempt)
#   4. Same checks for ulp.domain_counts' 7 broken-on-start parts (2.23 GiB
#      total — matches the original error exactly), for completeness
#
# Nothing here modifies, renames, copies, or attaches anything.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-detached-credentials-part.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

REPORT="/tmp/ulp-detached-part-diagnostics-$(date +%Y%m%d-%H%M%S).txt"
PART_DIR="/var/lib/clickhouse/store/c18/c18dd084-8910-4696-9bcf-abfc0a0134e8/detached/broken-on-start_202605_31_3755_8_3863"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — detached credentials part diagnostics (RO)     ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo "Inspecting: $PART_DIR"
echo ""

echo "═══ 1/4  Contents of the detached part directory ═══════════════"
docker exec ulpsuite_clickhouse sh -c "ls -la '$PART_DIR' | head -100" 2>&1
echo ""
echo "-- Total file count --"
docker exec ulpsuite_clickhouse sh -c "ls -1 '$PART_DIR' | wc -l" 2>&1
echo ""
echo "-- count.txt (row count ClickHouse recorded for this part) --"
docker exec ulpsuite_clickhouse sh -c "cat '$PART_DIR/count.txt' 2>/dev/null || echo '  (no count.txt)'" 2>&1
echo ""
echo "-- columns.txt (first 20 lines) --"
docker exec ulpsuite_clickhouse sh -c "head -20 '$PART_DIR/columns.txt' 2>/dev/null || echo '  (no columns.txt)'" 2>&1
echo ""
echo "-- checksums.txt present? --"
docker exec ulpsuite_clickhouse sh -c "
  if [ -f '$PART_DIR/checksums.txt' ]; then
    ls -la '$PART_DIR/checksums.txt'
  else
    echo '  (no checksums.txt)'
  fi
" 2>&1
echo ""
echo "-- partition.dat / minmax files present? --"
docker exec ulpsuite_clickhouse sh -c "ls -la '$PART_DIR'/partition.dat '$PART_DIR'/minmax_*.idx 2>/dev/null || echo '  (none found)'" 2>&1
echo ""

echo "═══ 2/4  ClickHouse server log around the 02:10 restart/detach ═"
echo "    (looking for this part name + 'broken-on-start' + reasons)"
docker compose logs clickhouse --since 1h 2>/dev/null \
  | grep -iE "202605_31_3755_8_3863|broken-on-start|broken.part|Checksum|Cannot read|Corrupted|while loading part" \
  | tail -100 || echo "  (no matching lines found — logs may have rotated)"
echo ""

echo "═══ 3/4  Free disk space (need ~45GB free for a safety copy) ═══"
df -h / 2>/dev/null
echo ""
docker exec ulpsuite_clickhouse df -h /var/lib/clickhouse 2>/dev/null
echo ""

echo "═══ 4/4  ulp.domain_counts' broken-on-start parts (2.23 GiB total) ═"
echo "    (for completeness — these match the ORIGINAL error exactly,"
echo "     confirming force_restore_data worked correctly for this table)"
docker exec ulpsuite_clickhouse sh -c "
  DC_UUID=\$(grep -oE \"UUID '[^']+'\" /var/lib/clickhouse/metadata/ulp/domain_counts.sql | head -1 | grep -oE '[0-9a-f-]{36}')
  DC_DIR=\"/var/lib/clickhouse/store/\${DC_UUID:0:3}/\$DC_UUID/detached\"
  echo \"domain_counts uuid: \$DC_UUID\"
  ls -la \"\$DC_DIR\" 2>/dev/null || echo '  (detached dir not found)'
" 2>&1
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What to look for:"
echo "  - Step 1: if count.txt, columns.txt, checksums.txt, primary.idx all"
echo "    exist and count.txt shows a large number (tens of millions), the"
echo "    part is very likely structurally intact — just flagged at startup."
echo "  - Step 2: the actual exception for THIS part tells us whether it's"
echo "    a real checksum/corruption issue or just an 'unexpected part'"
echo "    classification from force_restore_data."
echo "  - Step 3: confirms there's room to copy this 40GB part somewhere"
echo "    safe before any ATTACH PART attempt (belt-and-suspenders)."
echo "═══════════════════════════════════════════════════════════════"
