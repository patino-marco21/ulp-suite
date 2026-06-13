#!/bin/bash
# =============================================================================
# diagnose-url-corruption-scope.sh
#
# READ-ONLY. Follow-up to diagnose-credentials-part-corruption.sh, which
# CONFIRMED:
#
#   - Part 202605_3912_3912_0 (1,457,952,559 rows, 40.12 GiB — the part
#     holding ~99.998% of all of ulp.credentials) has a PERSISTENT,
#     reproducible Code 131 TOO_LARGE_STRING_SIZE error reading `url` at
#     mark 0 / offset 0.
#   - url.bin, url.size.bin, url.cmrk2, url.size.cmrk2 are all dated
#     "Jun 1 05:38" — the ORIGINAL bulk-load files, never rewritten by the
#     2026-06-12/13 recovery (which only touched checksums.txt and a few
#     metadata files). So this corruption predates the recovery incident
#     and is unrelated to force_restore_data / ATTACH PART.
#   - Reading source_file/breach_name/imported_at from the same part
#     works (hit a 30s unindexed-scan timeout, NOT Code 131) — so the
#     corruption looks specific to the url column's data, not the whole
#     part.
#   - system.errors shows 193 cumulative Code 131s since ClickHouse last
#     started — i.e. every /api/credentials (and search/export) query
#     that reads `url` from this part has been failing immediately.
#
# OPEN QUESTION this script targets: is the corruption confined to the
# FIRST granule (mark 0) of `url`, or does it affect the WHOLE column for
# this part? That determines whether this is "lose one granule's worth of
# rows' url field" vs. "the url column for 1.46B rows is unreadable".
#
# This script does NOT modify, drop, or detach anything. It:
#   1. Gets marks/rows for 202605_3912_3912_0 (granule size estimate).
#   2. Isolation test: reads `url` from a part OUTSIDE partition 202605
#      (e.g. partition 202606) — confirms the url column definition/codec
#      itself is fine elsewhere, i.e. this is a per-part problem.
#   3. Tail test: reads `url` from 202605_3912_3912_0 ordered by the
#      primary-key prefix (domain) DESCENDING — if optimize_read_in_order
#      lets this start from the LAST granule instead of mark 0, a
#      successful read here means corruption is localized near the start;
#      a Code 131 here (possibly with a different garbage number) means
#      it's pervasive.
#   4. system.query_log history for exception_code=131 — first/last seen,
#      to check whether this predates 2026-06-12 (i.e. was /api/credentials
#      already broken before the recovery incident, for an unrelated
#      reason?).
#   5. Raw byte comparison: first 48 bytes of url.bin and url.size.bin for
#      the bad part (202605_3912_3912_0) vs. a healthy part in partition
#      202606 — a sanity-check block has a known header shape (16-byte
#      checksum + 1-byte method + 4+4 byte sizes); comparing the two may
#      show whether the header itself looks like garbage vs. a plausible
#      LZ4/ZSTD block.
#   6. ulp.sources — lists ALL filenames with more than one row, to gauge
#      how widespread the duplicate-import issue (seen for "PART_4") is.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-url-corruption-scope.sh
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
REPORT="/tmp/ulp-url-corruption-scope-$(date +%Y%m%d-%H%M%S).txt"
BAD_PART="202605_3912_3912_0"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — url corruption scope check (RO)                ║"
echo "║   Bad part: $BAD_PART"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/6  Granule size for $BAD_PART ════════════════════════════════"
$CH "
SELECT name, rows, marks, round(rows / marks, 1) AS avg_rows_per_mark
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND name = '$BAD_PART'
" --format PrettyCompact
echo ""

echo "═══ 2/6  Isolation test: url from a part OUTSIDE partition 202605 ══"
$CH "
SELECT _part, left(url, 80) AS url_preview
FROM ulp.credentials
WHERE partition != '202605'
LIMIT 1
SETTINGS max_execution_time = 20
" --format Vertical
echo ""

echo "═══ 3/6  Tail test: url from $BAD_PART, ordered by domain DESC ═════"
echo "(forces optimize_read_in_order to start from the END of the part;"
echo " success here => corruption localized near the start; Code 131"
echo " again => likely pervasive across the whole url column)"
$CH "
SELECT _part, left(url, 80) AS url_preview
FROM ulp.credentials
WHERE _part = '$BAD_PART'
ORDER BY domain DESC
LIMIT 1
SETTINGS max_execution_time = 20, max_threads = 1, optimize_read_in_order = 1
" --format Vertical
echo ""

echo "═══ 4/6  system.query_log history for exception_code = 131 ════════"
$CH "
SELECT count() AS total, min(event_time) AS first_seen, max(event_time) AS last_seen
FROM system.query_log
WHERE exception_code = 131
" --format PrettyCompact
echo ""
echo "-- earliest 3 --"
$CH "
SELECT event_time, query_duration_ms, left(query, 150) AS query_preview
FROM system.query_log
WHERE exception_code = 131
ORDER BY event_time ASC
LIMIT 3
" --format Vertical
echo "-- latest 3 --"
$CH "
SELECT event_time, query_duration_ms, left(query, 150) AS query_preview
FROM system.query_log
WHERE exception_code = 131
ORDER BY event_time DESC
LIMIT 3
" --format Vertical
echo ""

echo "═══ 5/6  Raw byte headers: url.bin / url.size.bin, bad vs good part ═"
BAD_PATH=$($CH "
SELECT path FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND name = '$BAD_PART'
LIMIT 1
" --format TSV)

GOOD_PART=$($CH "
SELECT name FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND partition = '202606' AND active = 1
ORDER BY rows DESC
LIMIT 1
" --format TSV)

GOOD_PATH=$($CH "
SELECT path FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND name = '$GOOD_PART'
LIMIT 1
" --format TSV)

echo "bad part:  $BAD_PART  -> $BAD_PATH"
echo "good part: $GOOD_PART -> $GOOD_PATH"
echo ""
if [ -n "$BAD_PATH" ]; then
  echo "-- $BAD_PART / url.bin (first 48 bytes) --"
  docker exec ulpsuite_clickhouse od -A d -t x1z -N 48 "${BAD_PATH}url.bin" 2>&1
  echo "-- $BAD_PART / url.size.bin (first 48 bytes) --"
  docker exec ulpsuite_clickhouse od -A d -t x1z -N 48 "${BAD_PATH}url.size.bin" 2>&1
fi
echo ""
if [ -n "$GOOD_PATH" ]; then
  echo "-- $GOOD_PART / url.bin (first 48 bytes) --"
  docker exec ulpsuite_clickhouse od -A d -t x1z -N 48 "${GOOD_PATH}url.bin" 2>&1
  echo "-- $GOOD_PART / url.size.bin (first 48 bytes) --"
  docker exec ulpsuite_clickhouse od -A d -t x1z -N 48 "${GOOD_PATH}url.size.bin" 2>&1
fi
echo ""

echo "═══ 6/6  ulp.sources — all filenames with duplicate rows ═══════════"
$CH "
SELECT filename, count() AS n, min(imported_at) AS first_imported, max(imported_at) AS last_imported
FROM ulp.sources
GROUP BY filename
HAVING n > 1
ORDER BY n DESC
" --format PrettyCompact
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What this tells us:"
echo "  - Section 1: how many rows one granule covers (e.g. ~1457952559/marks)."
echo "  - Section 2: confirms the url column itself is fine in other parts —"
echo "    i.e. this is a per-part problem, not a schema/codec problem."
echo "  - Section 3: the key test — does the END of the bad part's url"
echo "    column read cleanly? Localized vs. pervasive corruption."
echo "  - Section 4: does Code 131 predate 2026-06-12? (was this broken"
echo "    before the recovery incident too, for the same reason?)"
echo "  - Section 5: do the bad part's url.bin/url.size.bin headers look"
echo "    like garbage compared to a healthy part's equivalent files?"
echo "  - Section 6: how many other files (besides 'PART_4') have"
echo "    duplicate ulp.sources rows — scopes the separate dedup issue."
echo "Share the output and I'll determine whether this is recoverable by"
echo "dropping/rewriting just the affected granule(s), or whether the url"
echo "column for this part needs to be re-imported from source files —"
echo "no action will be taken without confirming with you first."
echo "═══════════════════════════════════════════════════════════════"
