#!/bin/bash
# =============================================================================
# diagnose-credentials-part-corruption.sh
#
# READ-ONLY. Investigates Issue #2 from the 2026-06-13 credentials/sources
# failure: /api/credentials returns "No credentials found" / "Failed to load"
# with the app log showing:
#
#   Code: 131. DB::Exception: Too large string size: 14085863238104309442.
#   The maximum is: 17179869184: (while reading column url):
#   (while reading from part .../202605_3912_3912_0/ in table ulp.credentials
#   ... from mark 0 with max_rows_to_read = ...): While reading part
#   202605_3912_3912_0 ...
#
# This is a sanity-check failure while decoding the `url` column's string
# length prefix for part 202605_3912_3912_0 — the decoded "length"
# (~1.4e19 bytes, close to UINT64_MAX) is consistent with reading
# garbage/corrupted bytes off disk, NOT a genuinely oversized-but-valid
# string from upstream data. This looks like physical part corruption
# (e.g. a torn/incomplete write), not a parser bug.
#
# Context: this error appeared in app logs INTERLEAVED with active
# `INSERT INTO ulp.credentials ... FORMAT CSV` batches and an inbox-watcher
# failure:
#   [inbox-watcher] failed: VIP ULP 21.04.2026 - @updh1_PART_4 (2).txt
#   Error: ENOENT: no such file or directory, rename
#     '/app/inbox/VIP ULP 21.04.2026 - @updh1_PART_4 (2).txt' ->
#     '/app/inbox/done/...'
#
# Part-naming: 202605_3912_3912_0 = partition 202605 (May 2026),
# min_block=max_block=3912, level=0 -> a single fresh INSERT (not yet
# merged). Block 3912 is HIGHER than the recovered part's range (31-3755),
# so this part holds NEW data inserted after the 2026-06-12/13 recovery —
# it is not the recovered 40GiB part itself.
#
# At the time of the prior diagnostic, system.parts showed partition 202605
# as exactly 1 active part / 1,457,952,559 rows / 40.12 GiB (== the known-good
# recovered count). That snapshot may predate, postdate, or simply not
# include 202605_3912_3912_0 if it has since merged into a bigger part —
# this script checks all of those possibilities.
#
# This script does NOT modify, drop, or detach anything. It:
#   1. Lists all parts (active + inactive) in partition 202605 with
#      min_block_number >= 3750, to place part 3912 in context.
#   2. Looks up system.parts for 202605_3912_3912_0 specifically
#      (active or not) and resolves its on-disk path.
#   3. Looks up system.parts_columns for that part's columns/sizes
#      (focus on `url` vs. its neighbours).
#   4. If it has an on-disk path, lists the part directory contents
#      (ls -la + columns.txt — both safe, no binary files are read).
#   5. Reproduces: a query on _part='202605_3912_3912_0' that avoids the
#      `url` column (source_file/breach_name/imported_at/count) — tests
#      whether OTHER columns in this part are readable, and identifies
#      which import created it.
#   6. Reproduces: SELECT url ... LIMIT 1 from that same part — tests
#      whether the `url` column read fails again (persistent vs. one-off).
#   7. If part 3912 no longer exists as such, finds whatever active part
#      NOW covers block 3912 (by block-number range) and repeats the
#      `url` read-test against it, to see whether corruption (if any)
#      propagated through a merge.
#   8. Cross-checks ulp.sources for 'updh1_PART_4' entries (with/without
#      the "(2)" suffix), lists ./inbox, ./inbox/done, ./inbox/failed for
#      that filename, and greps recent app logs for the filename / part
#      name / error code.
#   9. Checks system.errors for cumulative corruption-related error counts
#      since ClickHouse startup (131 TOO_LARGE_STRING_SIZE and friends).
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-credentials-part-corruption.sh
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
REPORT="/tmp/ulp-part-corruption-$(date +%Y%m%d-%H%M%S).txt"
TARGET_PART="202605_3912_3912_0"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — credentials part corruption check (RO)         ║"
echo "║   Target part: $TARGET_PART"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/9  Partition 202605 — parts with min_block_number >= 3750 ════"
$CH "
SELECT name, active, min_block_number, max_block_number, level,
       rows, formatReadableSize(bytes_on_disk) AS size, modification_time
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND partition = '202605'
  AND min_block_number >= 3750
ORDER BY min_block_number, active DESC
" --format PrettyCompact
echo ""

echo "═══ 2/9  system.parts detail for $TARGET_PART ══════════════════════"
$CH "
SELECT name, active, rows, formatReadableSize(bytes_on_disk) AS size, path
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND name = '$TARGET_PART'
" --format PrettyCompact

PART_PATH=$($CH "
SELECT path FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND name = '$TARGET_PART'
LIMIT 1
" --format TSV)
echo ""

echo "═══ 3/9  system.parts_columns for $TARGET_PART (per-column sizes) ══"
echo "(if this query errors due to a column-name mismatch across CH"
echo " versions, it's non-fatal — the rest of the script still runs)"
$CH "
SELECT column, type, rows,
       formatReadableSize(column_data_compressed_bytes)   AS compressed,
       formatReadableSize(column_data_uncompressed_bytes) AS uncompressed
FROM system.parts_columns
WHERE database = 'ulp' AND table = 'credentials' AND name = '$TARGET_PART'
ORDER BY column
" --format PrettyCompact
echo ""

echo "═══ 4/9  On-disk listing for $TARGET_PART ══════════════════════════"
if [ -n "$PART_PATH" ]; then
  echo "-- path: $PART_PATH --"
  docker exec ulpsuite_clickhouse ls -la "$PART_PATH" 2>&1
  echo ""
  echo "-- columns.txt --"
  docker exec ulpsuite_clickhouse cat "${PART_PATH}columns.txt" 2>&1
else
  echo "(part not found in system.parts — no path available; it may have"
  echo " merged into another part or been cleaned up already. See section 7.)"
fi
echo ""

echo "═══ 5/9  Reproduce: read $TARGET_PART avoiding 'url' ═══════════════"
$CH "
SELECT source_file, breach_name, min(imported_at) AS first_imported,
       max(imported_at) AS last_imported, count() AS rows
FROM ulp.credentials
WHERE _part = '$TARGET_PART'
GROUP BY source_file, breach_name
SETTINGS max_execution_time = 30
" --format PrettyCompact
echo ""

echo "═══ 6/9  Reproduce: read 'url' from $TARGET_PART (LIMIT 1) ═════════"
echo "(if this errors with Code 131 again, corruption is persistent in"
echo " this exact part; if it returns 0 rows, the part is gone — see"
echo " section 7 for its merged successor)"
$CH "
SELECT _part, url FROM ulp.credentials
WHERE _part = '$TARGET_PART'
LIMIT 1
SETTINGS max_execution_time = 10
" --format Vertical
echo ""

echo "═══ 7/9  If $TARGET_PART is gone: test its merged successor ════════"
SUCCESSOR=$($CH "
SELECT name FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND partition = '202605'
  AND active = 1 AND min_block_number <= 3912 AND max_block_number >= 3912
LIMIT 1
" --format TSV)
if [ -n "$SUCCESSOR" ] && [ "$SUCCESSOR" != "$TARGET_PART" ]; then
  echo "Successor part covering block 3912: $SUCCESSOR"
  echo ""
  echo "-- url read-test on $SUCCESSOR (LIMIT 1, checking for the same error) --"
  $CH "
  SELECT _part, url FROM ulp.credentials
  WHERE _part = '$SUCCESSOR'
  LIMIT 1
  SETTINGS max_execution_time = 10
  " --format Vertical
elif [ "$SUCCESSOR" == "$TARGET_PART" ]; then
  echo "$TARGET_PART is itself still the active part covering block 3912"
  echo "(see sections 2-6 above)."
else
  echo "No active part currently covers block 3912 in partition 202605."
fi
echo ""

echo "═══ 8/9  ulp.sources + inbox + app logs for 'updh1_PART_4' ═════════"
echo "-- ulp.sources entries matching 'updh1_PART_4' --"
$CH "
SELECT filename, line_count, imported_at
FROM ulp.sources
WHERE filename ILIKE '%updh1_PART_4%'
ORDER BY imported_at DESC
" --format PrettyCompact
echo ""
echo "-- ./inbox listing (matching 'updh1_PART_4') --"
ls -la inbox/ 2>/dev/null | grep -i 'updh1_PART_4' || echo "  (none in inbox/)"
ls -la inbox/done/ 2>/dev/null | grep -i 'updh1_PART_4' || echo "  (none in inbox/done/)"
ls -la inbox/failed/ 2>/dev/null | grep -i 'updh1_PART_4' || echo "  (none in inbox/failed/)"
echo ""
echo "-- app logs: filename / part name / Code 131, last 2000 lines ─────"
docker compose logs app --tail=2000 2>/dev/null \
  | grep -i -B2 -A5 "updh1_PART_4\|$TARGET_PART\|TOO_LARGE_STRING_SIZE\|Code: 131" \
  | tail -150
echo ""

echo "═══ 9/9  system.errors — cumulative corruption-related codes ══════"
$CH "
SELECT name, code, value
FROM system.errors
WHERE name IN ('TOO_LARGE_STRING_SIZE','CHECKSUM_DOESNT_MATCH','CORRUPTED_DATA',
                'CANNOT_READ_ALL_DATA','UNEXPECTED_END_OF_FILE','UNKNOWN_FORMAT')
ORDER BY code
" --format PrettyCompact
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What this tells us:"
echo "  - Section 1 places part $TARGET_PART among its neighbours — is it"
echo "    isolated, or part of a run of similarly-sized/timed parts?"
echo "  - Sections 2-4 confirm whether the part still exists, its declared"
echo "    column sizes, and on-disk file listing (a 0-byte or missing"
echo "    column file points to a truncated/torn write)."
echo "  - Section 5 tells us WHICH import created this part (source_file),"
echo "    without touching the corrupted 'url' column."
echo "  - Section 6 attempts to reproduce Code 131 directly — persistent"
echo "    vs. one-off."
echo "  - Section 7 checks whether a merged successor part has the same"
echo "    problem (corruption surviving a merge would be worse — future"
echo "    merges/reads of that range would keep failing)."
echo "  - Section 8 ties this to the 'VIP ULP 21.04.2026 - @updh1_PART_4"
echo "    (2).txt' inbox-watcher ENOENT failure from the prior report —"
echo "    is this the file that produced part $TARGET_PART?"
echo "Share the output and I'll pin down scope (single part vs. systemic)"
echo "before proposing any fix — nothing will be dropped/altered without"
echo "confirming root cause with you first."
echo "═══════════════════════════════════════════════════════════════"
