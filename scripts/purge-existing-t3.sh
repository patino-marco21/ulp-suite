#!/usr/bin/env bash
# Permanently remove the existing T3 backlog after the ingest hard-drop is live.
# Dry-run by default. Destructive modes:
#   BACKUP_VERIFIED=1 APPLY=1 bash scripts/purge-existing-t3.sh
#   ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/purge-existing-t3.sh
#
# Safety gate: the stored country_tier is a SQL copy of lib/country-tiers.ts and it has drifted
# (on 2026-10-01 1.9M rows were stored as T3 that the importer calls untiered, T1 or T2), so no row
# is deleted on the label alone. Every candidate is first replayed through the importer's own
# policy (scripts/audit-purge-candidates.ts, lib/purge-audit.ts); if the importer would have kept
# even one of them nothing is deleted (exit 3). The audit also runs in the dry run, and needs
# `npm ci` (tsx) in this checkout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
BACKUP_VERIFIED="${BACKUP_VERIFIED:-0}"
ACCEPT_PERMANENT_DATA_LOSS="${ACCEPT_PERMANENT_DATA_LOSS:-0}"
PREDICATE="country_tier = 'T3'"
CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
TSX_BIN="${TSX_BIN:-$PROJECT_DIR/node_modules/.bin/tsx}"

cd "$PROJECT_DIR"

if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  if command -v docker.exe >/dev/null 2>&1 && docker.exe info >/dev/null 2>&1; then
    DOCKER_BIN="docker.exe"
  else
    echo "ERROR: Docker is unavailable in this shell." >&2
    exit 1
  fi
fi

if ! "$DOCKER_BIN" inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: ClickHouse container '$CONTAINER' is not running." >&2
  exit 1
fi

ch() {
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "$1"
}

echo "ULP Suite - permanent T3 backlog purge"
echo "APPLY=$APPLY (0 = dry-run)"
echo "Predicate: $PREDICATE"
echo

ch "
SELECT
  count() AS total_rows,
  countIf($PREDICATE) AS t3_rows,
  round(100.0 * countIf($PREDICATE) / count(), 2) AS t3_percent
FROM ulp.credentials
FORMAT Vertical
"

# The label is only trusted where the importer agrees with it.
audit_candidates() {
  ch "SELECT email, url FROM ulp.credentials WHERE $PREDICATE SETTINGS max_threads = 4 FORMAT TSV" |
    INGEST_FILTER_HARD_DROP_TIERS=T3 INGEST_FILTER_DROP_TIERS= INGEST_FILTER_DROP_SUFFIXES= \
    INGEST_FILTER_KEEP_SUFFIXES= INGEST_FILTER_DROP_NOISE= \
    "$TSX_BIN" "$SCRIPT_DIR/audit-purge-candidates.ts"
}

echo
audit_report=""
audit_rc=0
if [[ ! -x "$TSX_BIN" ]]; then
  audit_rc=127
  echo "Label audit: cannot run; $TSX_BIN is missing (run 'npm ci' in $PROJECT_DIR)."
elif audit_report="$(audit_candidates)"; then
  audit_rc=0
else
  audit_rc=$?
fi
if [[ -n "$audit_report" ]]; then
  echo "$audit_report"
fi
audited="$(sed -n 's/^audit-result: checked=\([0-9]*\) .*/\1/p' <<<"$audit_report")"

echo
echo "Password-free sample of rows that match:"
ch "
SELECT
  substring(url, 1, 60) AS url,
  domain,
  country_tier,
  tld,
  source_file
FROM ulp.credentials
WHERE $PREDICATE
LIMIT 15
FORMAT PrettyCompact
"

if [[ "$APPLY" != "1" ]]; then
  echo
  if [[ "$audit_rc" != "0" ]]; then
    echo "BLOCKED: apply mode would refuse to delete anything (the label audit did not pass, exit $audit_rc)."
    echo "The stored country_tier cannot be used as the purge predicate until it is repaired; see README, \"Purge safety gate\"."
    echo
  fi
  echo "Dry-run complete; no mutation submitted."
  echo "After verifying an off-host backup, run:"
  echo "  BACKUP_VERIFIED=1 APPLY=1 bash scripts/purge-existing-t3.sh"
  echo "Or, to proceed irreversibly without a backup:"
  echo "  ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/purge-existing-t3.sh"
  exit 0
fi

if [[ "$BACKUP_VERIFIED" != "1" && "$ACCEPT_PERMANENT_DATA_LOSS" != "1" ]]; then
  echo "ERROR: refusing permanent deletion without an explicit acknowledgement." >&2
  echo "Use BACKUP_VERIFIED=1 after backup verification, or ACCEPT_PERMANENT_DATA_LOSS=1 to proceed without recovery." >&2
  exit 1
fi

if [[ "$BACKUP_VERIFIED" != "1" ]]; then
  echo "WARNING: no verified backup; permanent T3 data loss explicitly accepted." >&2
fi

if [[ "$audit_rc" != "0" ]]; then
  echo "ERROR: refusing to purge: the label audit did not pass (exit $audit_rc); nothing was deleted." >&2
  echo "The stored country_tier disagrees with the importer's own rules; see README, \"Purge safety gate\"." >&2
  exit 3
fi

cancel_failed_t3_mutations() {
  local ids mutation_id
  ids="$(ch "
SELECT mutation_id
FROM system.mutations
WHERE database = 'ulp'
  AND table = 'credentials'
  AND is_done = 0
  AND latest_fail_reason != ''
  AND command = '(DELETE WHERE country_tier = \\'T3\\')'
FORMAT TSVRaw
")"

  while IFS= read -r mutation_id; do
    [[ -z "$mutation_id" ]] && continue
    echo "Cancelling failed exact T3 mutation: $mutation_id"
    ch "
KILL MUTATION
WHERE database = 'ulp'
  AND table = 'credentials'
  AND mutation_id = '$mutation_id'
  AND is_done = 0
  AND latest_fail_reason != ''
  AND command = '(DELETE WHERE country_tier = \\'T3\\')'
SYNC
"
  done <<< "$ids"
}

cancel_failed_t3_mutations

active="$(ch "
SELECT count()
FROM system.mutations
WHERE database = 'ulp' AND table = 'credentials' AND is_done = 0
FORMAT TSVRaw
")"
if [[ "$active" != "0" ]]; then
  echo "ERROR: $active credential-table mutation(s) are already active; wait before purging." >&2
  exit 1
fi

bytes_before="$(ch "
SELECT formatReadableSize(sum(bytes_on_disk))
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
FORMAT TSVRaw
")"

candidates_now="$(ch "SELECT count() AS candidate_rows FROM ulp.credentials WHERE $PREDICATE FORMAT TSVRaw")"
if [[ "$candidates_now" != "$audited" ]]; then
  echo "ERROR: the candidate set changed while it was being audited ($audited audited, $candidates_now now); rerun." >&2
  exit 3
fi

echo
echo "Submitting bounded-memory lightweight T3 deletion..."
ch "
DELETE FROM ulp.credentials
WHERE $PREDICATE
SETTINGS lightweight_deletes_sync = 2,
         max_threads = 2,
         max_execution_time = 0
"

remaining_t3="$(ch "
SELECT countIf($PREDICATE) AS remaining_t3
FROM ulp.credentials
FORMAT TSVRaw
")"

if [[ "$remaining_t3" != "0" ]]; then
  echo "ERROR: mutation completed but remaining_t3=$remaining_t3." >&2
  exit 1
fi

bytes_after="$(ch "
SELECT formatReadableSize(sum(bytes_on_disk))
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
FORMAT TSVRaw
")"

echo "T3 purge complete; remaining_t3=0."
echo "Active-part storage: $bytes_before before, $bytes_after immediately after."
echo "Physical disk is reclaimed gradually by normal background merges; no OPTIMIZE FINAL is run."
