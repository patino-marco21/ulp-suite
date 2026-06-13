#!/bin/bash
# =============================================================================
# diagnose-orphaned-credentials.sh
#
# READ-ONLY follow-up to diagnose-all.sh.
#
# What we now know (from diagnose-all.sh output, 2026-06-13 02:25 UTC):
#  - ulp.credentials currently has exactly 39,213 rows — which exactly matches
#    the imported count of the MOST RECENT import job (id 337, finished
#    02:11:02, right after a container restart at ~02:10:55).
#  - ulp.domain_counts and ulp.mv_domain_counts STILL EXIST in system.tables,
#    even though DDL v10 (ch_ddl_version=10 since 00:17:33) is supposed to
#    DROP both. runMigration() swallows ALL errors as non-fatal warnings, so
#    those two DROP statements almost certainly failed silently (most likely
#    because ulp.domain_counts still can't ATTACH due to the original
#    "Suspiciously big size (7 parts, 2.23 GiB)" TOO_MANY_UNEXPECTED_DATA_PARTS
#    issue) — and because ch_ddl_version is already 10, v10 will never
#    re-run to retry those drops.
#  - That same cascading load failure (Code 696: 'startup table ulp.credentials'
#    -> 'startup table ulp.mv_domain_counts' -> ... ) repeatedly made
#    ulp.credentials itself fail to load between 00:19 and 01:38, causing every
#    import in that window to report imported=0.
#  - system.detached_parts is EMPTY for every ulp table — so the missing
#    ~52.3M rows are NOT sitting in detached/.
#  - system.parts (across ALL databases) shows nothing close to 52M rows
#    anywhere — so if that data still exists on disk, it must be in an
#    ORPHANED table directory under /var/lib/clickhouse/store/ that is no
#    longer referenced by any attached table (e.g. if ulp.credentials
#    couldn't ATTACH at some point and was recreated with CREATE TABLE IF NOT
#    EXISTS, ClickHouse's Atomic database engine would give the new table a
#    NEW uuid/directory, leaving the old data directory orphaned but NOT
#    deleted on disk).
#
# This script:
#  1. Shows ulp.credentials' CURRENT uuid + on-disk data path + row/byte totals
#  2. Shows ulp.domain_counts / ulp.mv_domain_counts current state (uuid, errors)
#  3. Lists every directory under /var/lib/clickhouse/store/*/* with its size,
#     sorted largest-first — an orphaned ~52.3M-row credentials table would be
#     several GB and would show up here even if not in system.tables/system.parts
#  4. Cross-references: flags any large store/ directory whose uuid does NOT
#     match the current ulp.credentials uuid (candidate orphan)
#  5. Lists current metadata .sql files for ulp (and any *.sql leftovers)
#  6. Checks whether /var/lib/clickhouse/flags/force_restore_data still exists
#     (tells us whether the last restart consumed it or it's still pending)
#  7. Full-ish ClickHouse log since the last restart, grepped for
#     credentials / domain_counts / Attaching / Creating / Removing / Renaming
#
# Nothing here modifies data, config, or containers. Safe to run anytime.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-orphaned-credentials.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

REPORT="/tmp/ulp-orphan-diagnostics-$(date +%Y%m%d-%H%M%S).txt"
CH="docker exec ulpsuite_clickhouse clickhouse-client --query"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — orphaned credentials data diagnostics (RO)     ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/7  ulp.credentials — current uuid, data path, totals ═════"
$CH "
SELECT database, name, engine, uuid, metadata_path, data_paths,
       total_rows, formatReadableSize(total_bytes) AS total_bytes
FROM system.tables
WHERE database = 'ulp' AND name = 'credentials'
FORMAT Vertical
" 2>&1
echo ""

echo "═══ 2/7  ulp.domain_counts / ulp.mv_domain_counts — current state ═"
$CH "
SELECT database, name, engine, uuid, data_paths,
       total_rows, formatReadableSize(total_bytes) AS total_bytes
FROM system.tables
WHERE database = 'ulp' AND name IN ('domain_counts','mv_domain_counts')
FORMAT Vertical
" 2>&1
echo ""
echo "-- Does domain_counts currently have detached/unexpected parts? --"
$CH "
SELECT reason, count() AS parts, sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.detached_parts
WHERE database = 'ulp' AND table = 'domain_counts'
GROUP BY reason
" --format PrettyCompact 2>&1
echo ""

echo "═══ 3/7  All directories under ClickHouse store/, sorted by size ═"
echo "    (an orphaned ~52.3M-row credentials table would be several GB"
echo "     and would show up here even though it's NOT in system.tables)"
docker exec ulpsuite_clickhouse sh -c '
  for d in /var/lib/clickhouse/store/*/*/; do
    [ -d "$d" ] || continue
    du -sh "$d" 2>/dev/null
  done
' 2>/dev/null | sort -rh | head -40
echo ""

echo "═══ 4/7  Cross-reference: every table uuid currently known to ClickHouse ═"
echo "    (compare the big directories above against this list — any large"
echo "     directory whose uuid prefix is NOT below is an orphan candidate)"
$CH "
SELECT database, name, uuid, formatReadableSize(total_bytes) AS size, total_rows
FROM system.tables
WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
ORDER BY total_bytes DESC
" --format PrettyCompact 2>&1
echo ""

echo "═══ 5/7  Metadata .sql files for ulp database ═══════════════════"
docker exec ulpsuite_clickhouse sh -c '
  ls -la /var/lib/clickhouse/metadata/ulp/ 2>/dev/null
  echo ""
  echo "-- contents of credentials.sql --"
  cat /var/lib/clickhouse/metadata/ulp/credentials.sql 2>/dev/null
  echo ""
  echo "-- contents of domain_counts.sql (if present) --"
  cat /var/lib/clickhouse/metadata/ulp/domain_counts.sql 2>/dev/null
  echo ""
  echo "-- contents of mv_domain_counts.sql (if present) --"
  cat /var/lib/clickhouse/metadata/ulp/mv_domain_counts.sql 2>/dev/null
' 2>/dev/null
echo ""

echo "═══ 6/7  force_restore_data flag — still present? ═══════════════"
docker exec ulpsuite_clickhouse sh -c '
  if [ -f /var/lib/clickhouse/flags/force_restore_data ]; then
    echo "  PRESENT — will trigger another restore-data pass on next ClickHouse restart"
    ls -la /var/lib/clickhouse/flags/
  else
    echo "  not present (already consumed, or never planted on this volume)"
  fi
' 2>/dev/null
echo ""

echo "═══ 7/7  ClickHouse log since last restart — credentials/domain_counts ═"
docker compose logs clickhouse --since 30m 2>/dev/null \
  | grep -iE "credentials|domain_counts|attaching|creating table|removing|renam|TOO_MANY|force_restore|unexpected|suspicious" \
  | tail -100 || echo "  (no matching lines found)"
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What to look for:"
echo "  - Step 1: note ulp.credentials' uuid and total_rows (should be 39213)."
echo "  - Step 3: any directory several GB in size."
echo "  - Step 4: match that directory's uuid prefix against this table. If"
echo "    it does NOT match ulp.credentials' uuid (or any other table here),"
echo "    it's very likely the orphaned ~52.3M-row credentials data — still"
echo "    on disk, recoverable, but NOT currently attached to any table."
echo "  - Step 6: if the flag is PRESENT, do NOT restart ClickHouse yet —"
echo "    share this output first, since another restore pass could move"
echo "    more parts around before we've confirmed where the orphan is."
echo "═══════════════════════════════════════════════════════════════"
