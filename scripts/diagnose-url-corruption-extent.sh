#!/bin/bash
# =============================================================================
# diagnose-url-corruption-extent.sh
#
# READ-ONLY. Third round investigating the Code 131 TOO_LARGE_STRING_SIZE
# corruption in part 202605_3912_3912_0 (1,457,952,559 rows / 40.12 GiB —
# essentially ALL of ulp.credentials).
#
# Prior findings:
#   - Round 1: SELECT url ... WHERE _part='202605_3912_3912_0' LIMIT 1
#     (mark 0, forward order) -> Code 131 on column `url`, garbage size
#     14085863238104309442.
#   - Round 2: SELECT ... ORDER BY domain DESC LIMIT 1 (same part,
#     InReverseOrder, lands on mark 22249 of 22251) -> Code 131 on column
#     `domain`, DIFFERENT garbage size 4859675936325408835.
#   - So at least 2 different String columns, at the very start AND near
#     the very end of this part, both fail to decode. Not a single bad
#     block in one column.
#   - Round 2's section 2 (isolation test against other partitions) had a
#     SQL bug (`partition` is not a selectable column on the table -
#     should be the virtual column `_partition_id`) and never ran.
#   - All 13 Code-131 entries in system.query_log are from TODAY
#     (2026-06-13, 13:44-14:09) - no evidence either way about whether
#     this worked before the recovery, just that nothing queried it
#     until today.
#   - detached/BACKUP_202605_31_3755_8_3863 (40.12 GiB) may still exist
#     from the v2 recovery script's backup step - if its copies of
#     url.bin/domain.bin etc. differ from the active part's, that could
#     be a recovery path.
#
# This script does NOT modify, drop, or detach anything. It:
#   1. Re-runs the isolation test correctly (_partition_id != '202605').
#   2. Samples 13 points evenly spread across the part's 1,457,952,559
#      rows via _part_offset ranges, calling length() on 5 String columns
#      (url, domain, email, password, source_file) per sample - reports
#      pass/Code131/Code159(inconclusive) per sample, to estimate what
#      fraction of the part is affected.
#   3. Checks whether detached/BACKUP_202605_31_3755_8_3863 still exists
#      and, if so, compares md5sums of url.bin/url.size.bin/url.cmrk2/
#      domain.bin/domain.size.bin/domain.cmrk2 between the backup and the
#      active part.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-url-corruption-extent.sh
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
REPORT="/tmp/ulp-url-corruption-extent-$(date +%Y%m%d-%H%M%S).txt"
BAD_PART="202605_3912_3912_0"
TOTAL_ROWS=1457952559

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — corruption extent sampling (RO)                ║"
echo "║   Part: $BAD_PART  ($TOTAL_ROWS rows)"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/3  Isolation test (fixed): url/domain from OTHER partitions ══"
$CH "
SELECT _part, _partition_id, length(url) AS url_len, length(domain) AS domain_len
FROM ulp.credentials
WHERE _partition_id != '202605'
LIMIT 1
SETTINGS max_execution_time = 20
" --format Vertical
echo ""

echo "═══ 2/3  Scope sample: 13 points across $BAD_PART ══════════════════"
echo "(for each sample, _part_offset range -> length() on 5 String cols."
echo " PASS = lengths printed, all 5 columns decode fine for that granule."
echo " Code 131 = that granule has at least one corrupted column (named"
echo " in the error). Code 159 = inconclusive, treat as untested.)"
echo ""
STEP=$((TOTAL_ROWS / 12))
for i in 0 1 2 3 4 5 6 7 8 9 10 11 12; do
  OFFSET=$((i * STEP))
  if [ "$OFFSET" -ge "$TOTAL_ROWS" ]; then OFFSET=$((TOTAL_ROWS - 1)); fi
  PCT=$((i * 100 / 12))
  echo "-- sample $i/12 (~${PCT}%): _part_offset in [$OFFSET, $((OFFSET+1000))) --"
  $CH "
  SELECT _part_offset,
         length(url) AS url_len, length(domain) AS domain_len, length(email) AS email_len,
         length(password) AS password_len, length(source_file) AS sf_len
  FROM ulp.credentials
  WHERE _part = '$BAD_PART' AND _part_offset >= $OFFSET AND _part_offset < $((OFFSET+1000))
  LIMIT 1
  SETTINGS max_execution_time = 15
  " --format TSV
  echo ""
done

echo "═══ 3/3  detached/ backup check + hash comparison ═══════════════════"
PART_PATH=$($CH "
SELECT path FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND name = '$BAD_PART'
LIMIT 1
" --format TSV)

if [ -z "$PART_PATH" ]; then
  echo "(could not resolve path for $BAD_PART - skipping backup check)"
else
  PARENT="${PART_PATH%${BAD_PART}/}"
  DETACHED="${PARENT}detached/"
  echo "-- detached/ contents --"
  docker exec ulpsuite_clickhouse ls -la "$DETACHED" 2>&1
  echo ""

  BACKUP_DIR=$(docker exec ulpsuite_clickhouse sh -c "ls -d ${DETACHED}BACKUP_* 2>/dev/null" | head -1)
  if [ -n "$BACKUP_DIR" ]; then
    echo "Found backup dir: $BACKUP_DIR"
    echo ""
    for f in url.bin url.size.bin url.cmrk2 domain.bin domain.size.bin domain.cmrk2; do
      echo "-- $f --"
      echo -n "  active: "; docker exec ulpsuite_clickhouse md5sum "${PART_PATH}${f}" 2>&1
      echo -n "  backup: "; docker exec ulpsuite_clickhouse md5sum "${BACKUP_DIR}/${f}" 2>&1
    done
  else
    echo "(no BACKUP_* directory found in detached/ - skipping hash comparison)"
  fi
fi
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What this tells us:"
echo "  - Section 1: are the OTHER ~26.4M rows (partition 202606) fine?"
echo "    If yes, this is isolated to part $BAD_PART, not a table-wide"
echo "    schema/codec issue."
echo "  - Section 2: out of 13 samples spread across the part, how many"
echo "    PASS vs. Code 131 vs. inconclusive (159)? This is a rough"
echo "    estimate of what fraction of the 1.46B rows are affected -"
echo "    e.g. 0/13 bad (only the 2 known edge marks) vs. several/13 bad"
echo "    (widespread)."
echo "  - Section 3: if a pre-fix backup of this part still exists, do"
echo "    its url.bin/domain.bin/etc. hashes MATCH the active part's?"
echo "    - MATCH -> corruption was already present before the v2 fix"
echo "      (and likely before that, since v2 only touched checksums.txt)"
echo "    - DIFFER -> the backup may hold an undamaged copy worth"
echo "      investigating as a recovery source."
echo "Share the output and I'll assess whether this is a few recoverable"
echo "granules vs. a re-import situation - no action taken without"
echo "confirming with you first."
echo "═══════════════════════════════════════════════════════════════"
