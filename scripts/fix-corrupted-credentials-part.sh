#!/bin/bash
# =============================================================================
# fix-corrupted-credentials-part.sh
#
# Three rounds of read-only diagnosis confirmed part 202605_3912_3912_0
# (1,457,952,559 rows / 40.12 GiB - the recovered partition 202605) has
# corrupted url/domain/email/password column data: 13/13 evenly-spaced
# samples across the entire part fail with Code 131 TOO_LARGE_STRING_SIZE
# (garbage length-prefix values from ~22GB to ~1.8e19) or Code 241
# MEMORY_LIMIT_EXCEEDED (same signature, garbage value just under 16GiB).
# Partition 202606 (other ~26.4M rows) reads fine - isolated to this part.
# The pre-fix backup (detached/BACKUP_202605_31_3755_8_3863) no longer exists.
#
# ROOT CAUSE THEORY (Altinity KB "Suspiciously many broken parts" + ClickHouse
# CHECK TABLE docs): ClickHouse doesn't fsync by default - INSERTed data is
# "durable" once in the Linux page cache. A hard restart/OOM-kill of the
# container DURING the original ~40GB bulk INSERT (this part's files are
# dated Jun 1) would leave a part that's structurally complete (right files,
# right count.txt) but with garbage/un-flushed compressed content for
# whichever columns' blocks hadn't hit disk yet. This re-explains the
# 2026-06-12/13 incident too: the `broken-on-start_` prefix on this part was
# very likely ClickHouse CORRECTLY flagging it as broken at startup (not just
# force_restore_data's blast radius) - and the recovery's ATTACH PART restored
# the part's metadata-level integration (count, checksums.txt) but never
# could and didn't repair the underlying garbage column data.
#
# This script:
#   1. (read-only) Looks for crash/OOM evidence around 2026-06-01:
#      system.crash_log, ClickHouse container memory limit + restart count,
#      host dmesg OOM matches.
#   2. (read-only, bounded) CHECK TABLE ulp.credentials PART
#      '202605_3912_3912_0' - ClickHouse's own checksum-based corruption
#      check, for the record. 120s timeout - expected to confirm corruption
#      (Code 131) or time out; either way does not block step 3.
#   3. *** THE FIX *** ALTER TABLE ulp.credentials DETACH PART
#      '202605_3912_3912_0' - REVERSIBLE: moves this part's files to
#      detached/, removes it from the active table. Does not read/decompress
#      column data, so corruption does not block this. Immediately stops
#      Code 131 on /api/credentials for every other query against this table.
#   4. Verifies: row count (expect ~26,410,465 - partition 202606 only),
#      a url/domain read that previously failed at mark 0 now succeeds, and
#      lists detached/ to confirm the part landed there.
#
# After this: /api/credentials and /api/sources should work (showing the
# healthy 26.4M rows). Re-importing partition 202605's ~1.46B rows from
# original source files is a separate follow-up - depends on whether those
# files still exist.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/fix-corrupted-credentials-part.sh
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
REPORT="/tmp/ulp-fix-credentials-corruption-$(date +%Y%m%d-%H%M%S).txt"
BAD_PART="202605_3912_3912_0"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — fix corrupted credentials part                 ║"
echo "║   Part: $BAD_PART"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/4  Crash/OOM evidence around 2026-06-01 ══════════════════════"
echo "-- system.crash_log (ClickHouse's own crash records) --"
$CH "SELECT event_time, signal, build_id FROM system.crash_log ORDER BY event_time DESC LIMIT 10" --format PrettyCompact 2>&1
echo ""
echo "-- ClickHouse container: memory limit + restart count --"
docker inspect ulpsuite_clickhouse --format 'MemLimit={{.HostConfig.Memory}} RestartCount={{.RestartCount}} StartedAt={{.State.StartedAt}}' 2>&1
echo ""
echo "-- host dmesg: OOM / killed process (may be empty if log rotated) --"
dmesg 2>/dev/null | grep -iE "oom|killed process|out of memory" | tail -20 || echo "  (no matches, or dmesg unavailable without sudo)"
echo ""

echo "═══ 2/4  CHECK TABLE PART $BAD_PART (bounded, for the record) ══════"
$CH "
CHECK TABLE ulp.credentials PART '$BAD_PART'
SETTINGS check_query_single_value_result = 0, max_execution_time = 120
" --format PrettyCompact
echo ""

echo "═══ 3/4  THE FIX: DETACH PART $BAD_PART (reversible) ════════════════"
echo "-- before --"
$CH "SELECT count() AS total_rows FROM ulp.credentials" --format PrettyCompact
echo ""
echo "Detaching..."
$CH "ALTER TABLE ulp.credentials DETACH PART '$BAD_PART'" --format PrettyCompact
echo "(no output above this line = success)"
echo ""

echo "═══ 4/4  Verify ═════════════════════════════════════════════════════"
echo "-- row count after detach (expect ~26,410,465 - partition 202606 only) --"
$CH "SELECT count() AS total_rows FROM ulp.credentials" --format PrettyCompact
echo ""
echo "-- url/domain read test (this exact shape of query failed with Code 131 before) --"
$CH "
SELECT _part, left(url, 60) AS url_preview, left(domain, 40) AS domain_preview
FROM ulp.credentials
ORDER BY imported_at DESC
LIMIT 3
SETTINGS max_execution_time = 30
" --format Vertical
echo ""
echo "-- detached/ listing (the corrupted part should now be here) --"
$CH "
SELECT name, reason, formatReadableSize(bytes_on_disk) AS size
FROM system.detached_parts
WHERE table = 'credentials'
" --format PrettyCompact
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "If section 4 shows ~26.4M rows and the url/domain read succeeds,"
echo "/api/credentials and /api/sources should work now - no rebuild needed,"
echo "this is a data-only change and the app reads ulp.credentials live."
echo ""
echo "If CHECK TABLE in section 2 errored with Code 131, that's ClickHouse's"
echo "own checksum mechanism agreeing with our sampling - expected."
echo ""
echo "Part '$BAD_PART' is now in detached/ (not deleted) - if ever needed for"
echo "forensics: ALTER TABLE ulp.credentials ATTACH PART '$BAD_PART' brings it"
echo "back (though its url/domain/email/password data is garbage either way)."
echo ""
echo "Next: re-importing partition 202605's ~1.46B rows depends on whether the"
echo "original source files still exist. Share this output and let's figure"
echo "out what's next."
echo "═══════════════════════════════════════════════════════════════"
