#!/bin/bash
# =============================================================================
# fix-credentials-duplicates.sh
#
# Removes duplicate rows from ulp.credentials (task #9), caused by the
# now-fixed (commit 66def2d) inbox reprocessing-loop bug.
#
# diagnose-scale-readiness.sh (2026-06-13) found:
#   - 14,966,570 of 35,282,245 rows (42.42%) are excess duplicates of
#     (url, email, password, imported_at, source_file)
#   - 100% concentrated in 6 source_files (5 exactly 2x, one ~2.0006x):
#       ☆ VIP ULP 10.300.908 @ratclouds.txt          (19,929,506 -> 10,464,606)
#       StarX_ULP_19.12.2025_Part_2.txt              ( 5,235,280 ->  2,615,794)
#       VIP ULP 21.04.2026 - @updh1_PART_4.txt       ( 3,636,500 ->  1,818,250)
#       (ghost) @updh1 [3,523,604] 12.05.2026 VIP ULP.txt (992,416 -> 496,208)
#       (ghost) @updh1 [2,085,420] 13.05.2026 VIP ULP.txt (688,668 -> 344,334)
#       VIP ULPP @Redline_Cl0ud4 (31).txt            (   446,784 ->    223,392)
#   - All other source_files have zero excess (already distinct).
#   - ulp.credentials is plain MergeTree (insert_deduplicate=0), so nothing
#     dedups this automatically. This is a one-time historical cleanup; the
#     reprocessing loop that caused it is already fixed.
#
# STRATEGY (rewrite + swap, NOT ReplacingMergeTree/FINAL):
#   ulp.credentials' ORDER BY is (domain, email, imported_at), which does NOT
#   uniquely identify a duplicate group (the same domain/email/imported_at can
#   legitimately have many different url/password rows) -- ReplacingMergeTree
#   on the current ORDER BY would wrongly collapse those. Instead:
#     1. ulp.credentials_dedup -- new table, IDENTICAL schema (copied via
#        SHOW CREATE TABLE), starts empty.
#     2. INSERT INTO ulp.credentials_dedup SELECT * FROM ulp.credentials
#        ORDER BY <dedup key> LIMIT 1 BY <dedup key> -- read-only against
#        ulp.credentials, keeps exactly one row per
#        (url, email, password, imported_at, source_file).
#     3. Verify: row count matches a fresh uniqExact(cityHash64(<dedup key>))
#        over the ORIGINAL table, and re-running the duplicate check against
#        ulp.credentials_dedup itself returns 0 excess.
#     4. RENAME TABLE ulp.credentials TO ulp.credentials_old,
#        ulp.credentials_dedup TO ulp.credentials -- metadata-only, instant,
#        no app restart needed. ulp.credentials_old is the untouched
#        original -- NOTHING IS DROPPED by this script.
#
# Safe to re-run: each step checks whether its target already exists / is
# already populated and skips with guidance instead of double-applying.
#
# Disk: ulp.credentials_dedup will hold ~20.3M of the current 35.28M rows
# (~58%, roughly +420MB at the current 719.76 MiB / 10.51x compression) while
# both tables exist briefly (steps 2-4, before the swap in step 5).
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/fix-credentials-duplicates.sh
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
DEDUP_KEY="url, email, password, imported_at, source_file"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — dedupe ulp.credentials (task #9)               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "═══ 1/5  Pre-flight: current duplicate scope ════════════════════"
$CH "
SELECT
  count() AS total_rows,
  uniqExact(cityHash64($DEDUP_KEY)) AS distinct_rows,
  count() - uniqExact(cityHash64($DEDUP_KEY)) AS excess_rows,
  round(100.0 * (count() - uniqExact(cityHash64($DEDUP_KEY))) / count(), 2) AS pct_excess
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo "(2026-06-13 diagnostic: 35,282,245 / 20,315,675 / 14,966,570 / 42.42%."
echo " If total_rows above is larger, new data has been imported since --"
echo " that's fine, this script works off whatever's in the table now.)"
echo ""

DEDUP_EXISTS=$($CH "EXISTS TABLE ulp.credentials_dedup" --format TabSeparated)
OLD_EXISTS=$($CH "EXISTS TABLE ulp.credentials_old" --format TabSeparated)

echo "═══ 2/5  Create ulp.credentials_dedup (same schema, empty) ══════"
if [ "$DEDUP_EXISTS" = "1" ]; then
  echo "ulp.credentials_dedup already exists -- skipping creation."
  echo "(If this is left over from a prior failed/partial run and you want a"
  echo " clean restart: DROP TABLE ulp.credentials_dedup, then re-run this"
  echo " script from the top.)"
else
  echo "Copying the live schema of ulp.credentials via SHOW CREATE TABLE"
  echo "(columns, materialized expressions, indices, engine, PARTITION BY,"
  echo "ORDER BY, SETTINGS) so credentials_dedup is structurally identical."
  CREATE_SQL=$($CH "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw)
  if [ -z "$CREATE_SQL" ]; then
    echo "ERROR: SHOW CREATE TABLE ulp.credentials returned nothing."
    exit 1
  fi
  NEW_SQL=$(printf '%s\n' "$CREATE_SQL" | sed '1s/ulp\.credentials/ulp.credentials_dedup/')
  if ! printf '%s\n' "$NEW_SQL" | docker exec -i ulpsuite_clickhouse clickhouse-client; then
    echo "ERROR: failed to create ulp.credentials_dedup. DDL attempted:"
    echo "$NEW_SQL"
    exit 1
  fi
  echo "Created. Confirming schema matches (ignoring the table name)..."
  ORIG_SQL=$($CH "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw)
  DEDUP_SQL=$($CH "SHOW CREATE TABLE ulp.credentials_dedup" --format TabSeparatedRaw \
    | sed '1s/ulp\.credentials_dedup/ulp.credentials/')
  if [ "$ORIG_SQL" = "$DEDUP_SQL" ]; then
    echo "Schema matches."
  else
    echo "WARNING: schema differs beyond the table name:"
    diff <(printf '%s\n' "$ORIG_SQL") <(printf '%s\n' "$DEDUP_SQL")
  fi
fi
echo ""

echo "═══ 3/5  Populate ulp.credentials_dedup (read-only on the original) ═"
DEDUP_COUNT=$($CH "SELECT count() FROM ulp.credentials_dedup" --format TabSeparated)
if [ "$DEDUP_COUNT" != "0" ]; then
  echo "ulp.credentials_dedup already has $DEDUP_COUNT rows -- skipping populate"
  echo "(re-running the INSERT would double these rows)."
  echo "If this is left over from a prior partial run and the count looks"
  echo "wrong, DROP TABLE ulp.credentials_dedup and re-run from the top."
else
  echo "INSERT INTO ulp.credentials_dedup SELECT * FROM ulp.credentials"
  echo "  ORDER BY $DEDUP_KEY LIMIT 1 BY $DEDUP_KEY"
  echo "ulp.credentials itself is not modified by this step."
  time $CH "
  INSERT INTO ulp.credentials_dedup
  SELECT * FROM ulp.credentials
  ORDER BY $DEDUP_KEY
  LIMIT 1 BY $DEDUP_KEY
  SETTINGS max_execution_time = 1800, timeout_overflow_mode = 'throw'
  "
  INSERT_STATUS=$?
  if [ $INSERT_STATUS -ne 0 ]; then
    echo "ERROR: INSERT failed or timed out (exit $INSERT_STATUS)."
    echo "ulp.credentials_dedup likely has partial data. DROP TABLE"
    echo "ulp.credentials_dedup and re-run this script from the top once"
    echo "you've addressed the cause."
    exit 1
  fi
fi
echo ""

echo "═══ 4/5  Verify before swapping ═════════════════════════════════"
echo "-- Row counts: dedup_rows should equal expected_rows --"
$CH "
SELECT
  (SELECT count() FROM ulp.credentials)       AS original_rows,
  (SELECT count() FROM ulp.credentials_dedup) AS dedup_rows,
  (SELECT uniqExact(cityHash64($DEDUP_KEY)) FROM ulp.credentials
     SETTINGS max_execution_time = 300)       AS expected_rows
" --format PrettyCompact

echo "-- Re-checking for duplicates INSIDE credentials_dedup (should be 0) --"
EXCESS_AFTER=$($CH "
SELECT count() - uniqExact(cityHash64($DEDUP_KEY))
FROM ulp.credentials_dedup
SETTINGS max_execution_time = 300
" --format TabSeparated)
echo "excess_rows_in_dedup_table = $EXCESS_AFTER"
echo ""

echo "-- Per-source_file spot check (top 10 by original row count) --"
$CH "
SELECT
  c2.source_file AS source_file,
  c2.cnt AS original_rows,
  c1.cnt AS dedup_rows
FROM (SELECT source_file, count() AS cnt FROM ulp.credentials GROUP BY source_file) c2
LEFT JOIN (SELECT source_file, count() AS cnt FROM ulp.credentials_dedup GROUP BY source_file) c1
  ON c1.source_file = c2.source_file
ORDER BY c2.cnt DESC
LIMIT 10
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""

DEDUP_ROWS=$($CH "SELECT count() FROM ulp.credentials_dedup" --format TabSeparated)
EXPECTED_ROWS=$($CH "SELECT uniqExact(cityHash64($DEDUP_KEY)) FROM ulp.credentials SETTINGS max_execution_time=300" --format TabSeparated)

if [ "$DEDUP_ROWS" != "$EXPECTED_ROWS" ] || [ "$EXCESS_AFTER" != "0" ]; then
  echo "STOPPING -- verification failed:"
  echo "  credentials_dedup has $DEDUP_ROWS rows, expected $EXPECTED_ROWS"
  echo "  excess_rows_in_dedup_table = $EXCESS_AFTER (expected 0)"
  echo ""
  echo "Do NOT proceed to the swap. ulp.credentials has NOT been touched."
  echo "Investigate, or DROP TABLE ulp.credentials_dedup and re-run from the"
  echo "top."
  exit 1
fi
echo "Verification passed: $DEDUP_ROWS rows, 0 internal duplicates."
echo ""

echo "═══ 5/5  Swap tables (RENAME, metadata-only, instant) ═══════════"
if [ "$OLD_EXISTS" = "1" ]; then
  echo "ulp.credentials_old already exists -- this script has likely already"
  echo "been run to completion. Refusing to RENAME again (the destination"
  echo "name 'credentials_old' is already taken)."
  echo ""
  echo "If ulp.credentials is already the deduped table (check: count() should"
  echo "be $DEDUP_ROWS), you're done -- see the cleanup note below."
  echo "If something went wrong, inspect ulp.credentials_old (the pre-dedup"
  echo "original) and decide manually."
  exit 0
fi

echo "Renaming:"
echo "  ulp.credentials       -> ulp.credentials_old   (original, preserved)"
echo "  ulp.credentials_dedup -> ulp.credentials        (now live)"
if ! $CH "RENAME TABLE ulp.credentials TO ulp.credentials_old, ulp.credentials_dedup TO ulp.credentials"; then
  echo "ERROR: RENAME failed. Both tables should be unchanged -- check with:"
  echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \"EXISTS TABLE ulp.credentials\""
  echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \"EXISTS TABLE ulp.credentials_dedup\""
  echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \"EXISTS TABLE ulp.credentials_old\""
  exit 1
fi
echo ""

CREDS_NOW=$($CH "SELECT count() FROM ulp.credentials" --format TabSeparated)
CREDS_OLD_NOW=$($CH "SELECT count() FROM ulp.credentials_old" --format TabSeparated)

echo "═══════════════════════════════════════════════════════════════"
echo "Done. ulp.credentials now has $CREDS_NOW rows (was $CREDS_OLD_NOW before"
echo "dedup). The app reads/writes ulp.credentials directly -- no restart"
echo "needed."
echo ""
echo "ulp.credentials_old is the untouched original. To roll back:"
echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \\"
echo "    \"RENAME TABLE ulp.credentials TO ulp.credentials_dedup, ulp.credentials_old TO ulp.credentials\""
echo ""
echo "Once you've confirmed the Credentials Browser looks correct (no more"
echo "doubled rows), free the disk space:"
echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \\"
echo "    \"DROP TABLE ulp.credentials_old\""
echo ""
echo "Next (task #10): add+materialize the imported_at-sort projection on the"
echo "new, smaller ulp.credentials -- see project notes for the exact"
echo "ALTER TABLE ADD PROJECTION / MATERIALIZE PROJECTION statements."
echo "═══════════════════════════════════════════════════════════════"
