#!/bin/bash
# =============================================================================
# diagnose-credentials-data-dir.sh
#
# READ-ONLY follow-up to diagnose-orphaned-credentials.sh.
#
# That script found:
#   - ulp.credentials' CURRENT uuid is c18dd084-8910-4696-9bcf-abfc0a0134e8
#   - ClickHouse reports only 39,213 active rows / 2.81 MiB for this table
#   - But /var/lib/clickhouse/store/c18/c18dd084-.../  is 41 GiB on disk —
#     i.e. the missing data is sitting INSIDE THIS TABLE'S OWN DIRECTORY,
#     not some other orphaned uuid.
#   - system.detached_parts was empty for ulp.credentials (and the original
#     query had a bad column — system.detached_parts in 26.3 has no `rows`
#     column, fixed below).
#
# So the 41 GiB is either:
#   (a) sitting in a detached/ subfolder under that uuid dir (recoverable via
#       ALTER TABLE ... ATTACH PART), or
#   (b) sitting as loose, unregistered part directories directly inside the
#       uuid dir, alongside the small set of "active" parts ClickHouse
#       currently knows about (would need to be moved into detached/ first,
#       then ATTACH PART), or
#   (c) inactive parts ClickHouse still tracks in system.parts (active=0)
#       that are pending background cleanup.
#
# This script only LISTS directory contents and queries system.parts /
# system.detached_parts with corrected columns. It does NOT move, attach,
# or delete anything.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-credentials-data-dir.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

REPORT="/tmp/ulp-datadir-diagnostics-$(date +%Y%m%d-%H%M%S).txt"
CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
TBL_UUID="c18dd084-8910-4696-9bcf-abfc0a0134e8"
TBL_DIR="/var/lib/clickhouse/store/c18/${TBL_UUID}"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — ulp.credentials data-dir diagnostics (RO)      ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo "Inspecting: $TBL_DIR"
echo ""

echo "═══ 1/5  Top-level contents of the table's data directory ══════"
docker exec ulpsuite_clickhouse sh -c "ls -la '$TBL_DIR'" 2>&1
echo ""

echo "═══ 2/5  Size of each entry (subdirectory = one part, usually) ═"
docker exec ulpsuite_clickhouse sh -c "
  for d in '$TBL_DIR'/*/; do
    [ -d \"\$d\" ] || continue
    du -sh \"\$d\" 2>/dev/null
  done
" 2>&1 | sort -rh
echo ""

echo "═══ 3/5  If a detached/ subfolder exists, list + size its contents ═"
docker exec ulpsuite_clickhouse sh -c "
  if [ -d '$TBL_DIR/detached' ]; then
    echo '-- detached/ exists --'
    ls -la '$TBL_DIR/detached'
    echo ''
    for d in '$TBL_DIR/detached'/*/; do
      [ -d \"\$d\" ] || continue
      du -sh \"\$d\" 2>/dev/null
    done | sort -rh
  else
    echo '-- no detached/ subfolder under this table dir --'
  fi
" 2>&1
echo ""

echo "═══ 4/5  system.parts for ulp.credentials — ALL parts (active + inactive) ═"
$CH "
SELECT partition, name, active, rows,
       formatReadableSize(bytes_on_disk) AS size,
       min_date, max_date, modification_time
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials'
ORDER BY active DESC, rows DESC
" --format PrettyCompact 2>&1
echo ""
echo "-- Totals by active flag --"
$CH "
SELECT active, count() AS part_count, sum(rows) AS total_rows,
       formatReadableSize(sum(bytes_on_disk)) AS total_size
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials'
GROUP BY active
" --format PrettyCompact 2>&1
echo ""

echo "═══ 5/5  system.detached_parts for ulp.credentials (corrected columns) ═"
$CH "
SELECT database, table, partition_id, name, reason, disk,
       formatReadableSize(bytes_on_disk) AS size
FROM system.detached_parts
WHERE database = 'ulp' AND table = 'credentials'
" --format PrettyCompact 2>&1
echo ""
echo "-- Same, but across ALL ulp tables (sanity check) --"
$CH "
SELECT database, table, partition_id, name, reason, disk,
       formatReadableSize(bytes_on_disk) AS size
FROM system.detached_parts
WHERE database = 'ulp'
" --format PrettyCompact 2>&1
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What to look for:"
echo "  - Step 2: a handful of LARGE part directories (the bulk of the 41 GiB)"
echo "    sitting alongside one small recent part (from the 39,213-row import)."
echo "  - Step 3: if detached/ has entries, that's the easy case — each can be"
echo "    re-attached with ALTER TABLE ulp.credentials ATTACH PART '<name>'."
echo "  - Step 4: if the big parts show up here with active=0, ClickHouse"
echo "    still knows about them but considers them superseded/stale — that's"
echo "    a different (more delicate) situation, share this before acting."
echo "  - Step 4: if the big parts DON'T show up in system.parts AT ALL"
echo "    (only the small new one does) but DO show up in step 2's du output,"
echo "    they're unregistered directories ClickHouse's loader skipped over —"
echo "    recoverable, but needs a manual detach+attach, share this first."
echo "═══════════════════════════════════════════════════════════════"
