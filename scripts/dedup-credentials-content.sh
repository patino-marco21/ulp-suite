#!/bin/bash
# =============================================================================
# dedup-credentials-content.sh
#
# Removes EXACT (url, email, password) duplicates from ulp.credentials —
# the cross-source / cross-import copies that the earlier dedup (task #9) and
# the import-time guards deliberately KEEP, because their keys all include
# source_file + imported_at (to preserve provenance). The same credential
# arriving in multiple combolist files therefore shows up 2–3× in the browser.
#
# This collapses each (url, email, password) to ONE row, keeping the EARLIEST
# imported_at (its first sighting). Provenance of the other source_files for
# that exact credential is lost — that is the point of a content-level dedup.
#
# STRATEGY: rewrite + swap (same proven shape as fix-credentials-duplicates.sh,
# NOT ReplacingMergeTree/FINAL which is eventual + expensive at scale):
#   1. ulp.credentials_cdedup — new table, schema copied via SHOW CREATE TABLE.
#      ⚠️ The table is now ReplicatedMergeTree, so we rewrite BOTH the table name
#         AND the ZooKeeper path in the DDL (a clone with the same path would
#         collide: REPLICA_ALREADY_EXISTS).
#   2. INSERT … SELECT * … ORDER BY url,email,password,imported_at
#      LIMIT 1 BY url,email,password  → one earliest row per credential.
#   3. Verify count == uniqExact(cityHash64(url,email,password)) of the original
#      AND that credentials_cdedup has 0 internal content-dupes.
#   4. RENAME swap. ulp.credentials_predup is the untouched original (rollback).
#
# DRY-RUN by default (shows scope + per-source impact, creates nothing). Set
# APPLY=1 to actually build + swap.
#
#   bash scripts/dedup-credentials-content.sh           # dry-run (safe)
#   APPLY=1 bash scripts/dedup-credentials-content.sh    # build + swap
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
APPLY="${APPLY:-0}"
KEY="url, email, password"                       # content dedup key
ORDER="url, email, password, imported_at"        # ASC → LIMIT 1 BY keeps earliest

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — content dedup of ulp.credentials (url+email+pw)║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "APPLY=$APPLY  (0 = dry-run, nothing created/changed)"
echo ""

echo "═══ 1/5  Exact-duplicate scope on ($KEY) ════════════════════════"
$CH "
SELECT
  count() AS total_rows,
  uniqExact(cityHash64($KEY)) AS distinct_creds,
  count() - uniqExact(cityHash64($KEY)) AS excess_rows,
  round(100.0 * (count() - uniqExact(cityHash64($KEY))) / count(), 2) AS pct_excess
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""
echo "-- worst offenders: most-duplicated exact credentials --"
$CH "
SELECT substring(url,1,40) AS url, substring(email,1,24) AS email, count() AS copies
FROM ulp.credentials
GROUP BY url, email, password
ORDER BY copies DESC
LIMIT 12
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""

if [ "$APPLY" != "1" ]; then
  echo "Dry-run. Review excess_rows above. To build the deduped table + swap:"
  echo "  APPLY=1 bash scripts/dedup-credentials-content.sh"
  echo ""
  exit 0
fi

CDEDUP_EXISTS=$($CH "EXISTS TABLE ulp.credentials_cdedup" --format TabSeparated)
PREDUP_EXISTS=$($CH "EXISTS TABLE ulp.credentials_predup" --format TabSeparated)

echo "═══ 2/5  Create ulp.credentials_cdedup (same schema, new ZK path) ══"
if [ "$CDEDUP_EXISTS" = "1" ]; then
  echo "ulp.credentials_cdedup already exists — skipping creation."
  echo "(clean restart: DROP TABLE ulp.credentials_cdedup, then re-run.)"
else
  CREATE_SQL=$($CH "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw)
  [ -n "$CREATE_SQL" ] || { echo "ERROR: SHOW CREATE TABLE returned nothing."; exit 1; }
  # Rewrite the table NAME (line 1) and the ReplicatedMergeTree ZK PATH so the
  # clone does not collide with the live table's replica path.
  NEW_SQL=$(printf '%s\n' "$CREATE_SQL" \
    | sed '1s/ulp\.credentials/ulp.credentials_cdedup/' \
    | sed "s|/ulp/credentials'|/ulp/credentials_cdedup'|")
  if printf '%s\n' "$NEW_SQL" | grep -q "/ulp/credentials'"; then
    echo "ERROR: could not rewrite the ZooKeeper path (unexpected SHOW CREATE shape)."
    echo "DDL was:"; printf '%s\n' "$NEW_SQL"; exit 1
  fi
  if ! printf '%s\n' "$NEW_SQL" | docker exec -i ulpsuite_clickhouse clickhouse-client; then
    echo "ERROR: failed to create ulp.credentials_cdedup. DDL attempted:"; printf '%s\n' "$NEW_SQL"; exit 1
  fi
  echo "Created ulp.credentials_cdedup."
fi
echo ""

echo "═══ 3/5  Populate (read-only on the original; keeps earliest row) ══"
CDEDUP_COUNT=$($CH "SELECT count() FROM ulp.credentials_cdedup" --format TabSeparated)
if [ "$CDEDUP_COUNT" != "0" ]; then
  echo "ulp.credentials_cdedup already has $CDEDUP_COUNT rows — skipping populate"
  echo "(re-running the INSERT would double them; DROP + re-run if partial)."
else
  echo "INSERT INTO ulp.credentials_cdedup SELECT * FROM ulp.credentials"
  echo "  ORDER BY $ORDER LIMIT 1 BY $KEY"
  time $CH "
  INSERT INTO ulp.credentials_cdedup
  SELECT * FROM ulp.credentials
  ORDER BY $ORDER
  LIMIT 1 BY $KEY
  SETTINGS max_execution_time = 1800, timeout_overflow_mode = 'throw'
  " || { echo "ERROR: INSERT failed/timed out. DROP TABLE ulp.credentials_cdedup and re-run."; exit 1; }
fi
echo ""

echo "═══ 4/5  Verify before swapping ═════════════════════════════════"
$CH "
SELECT
  (SELECT count() FROM ulp.credentials)        AS original_rows,
  (SELECT count() FROM ulp.credentials_cdedup) AS cdedup_rows,
  (SELECT uniqExact(cityHash64($KEY)) FROM ulp.credentials SETTINGS max_execution_time=300) AS expected_rows
" --format PrettyCompact
CDEDUP_ROWS=$($CH "SELECT count() FROM ulp.credentials_cdedup" --format TabSeparated)
EXPECTED_ROWS=$($CH "SELECT uniqExact(cityHash64($KEY)) FROM ulp.credentials SETTINGS max_execution_time=300" --format TabSeparated)
EXCESS_AFTER=$($CH "SELECT count() - uniqExact(cityHash64($KEY)) FROM ulp.credentials_cdedup SETTINGS max_execution_time=300" --format TabSeparated)
echo "excess_rows_in_cdedup = $EXCESS_AFTER (expected 0)"
if [ "$CDEDUP_ROWS" != "$EXPECTED_ROWS" ] || [ "$EXCESS_AFTER" != "0" ]; then
  echo "STOPPING — verification failed (cdedup=$CDEDUP_ROWS expected=$EXPECTED_ROWS excess=$EXCESS_AFTER)."
  echo "ulp.credentials is UNTOUCHED. Investigate or DROP TABLE ulp.credentials_cdedup and re-run."
  exit 1
fi
echo "Verification passed: $CDEDUP_ROWS rows, 0 internal content-duplicates."
echo ""

echo "═══ 5/5  Swap (RENAME, metadata-only, instant) ══════════════════"
if [ "$PREDUP_EXISTS" = "1" ]; then
  echo "ulp.credentials_predup already exists — refusing to overwrite the backup."
  echo "This script likely already completed. Verify count() then DROP TABLE"
  echo "ulp.credentials_predup once satisfied."
  exit 0
fi
if ! $CH "RENAME TABLE ulp.credentials TO ulp.credentials_predup, ulp.credentials_cdedup TO ulp.credentials"; then
  echo "ERROR: RENAME failed. Tables unchanged — check EXISTS for each."; exit 1
fi
CREDS_NOW=$($CH "SELECT count() FROM ulp.credentials" --format TabSeparated)
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Done. ulp.credentials now has $CREDS_NOW unique-credential rows."
echo "ulp.credentials_predup is the untouched original. Roll back with:"
echo "  RENAME TABLE ulp.credentials TO ulp.credentials_cdedup, ulp.credentials_predup TO ulp.credentials"
echo "Once the browser looks right, reclaim space: DROP TABLE ulp.credentials_predup"
echo "NOTE: the live table now uses the ...'/ulp/credentials_cdedup' ZK path; this"
echo "is cosmetic. The canonical path frees up when you drop ulp.credentials_predup."
echo "═══════════════════════════════════════════════════════════════"
