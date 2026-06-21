#!/usr/bin/env bash
# Permanently remove the existing T3 backlog after the ingest hard-drop is live.
# Dry-run by default. Destructive modes:
#   BACKUP_VERIFIED=1 APPLY=1 bash scripts/purge-existing-t3.sh
#   ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/purge-existing-t3.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
BACKUP_VERIFIED="${BACKUP_VERIFIED:-0}"
ACCEPT_PERMANENT_DATA_LOSS="${ACCEPT_PERMANENT_DATA_LOSS:-0}"
POLL_SECONDS="${POLL_SECONDS:-5}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-7200}"
PREDICATE="country_tier = 'T3'"
CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"

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

echo
echo "Submitting asynchronous T3 deletion mutation..."
ch "
ALTER TABLE ulp.credentials
DELETE WHERE $PREDICATE
SETTINGS mutations_sync = 0
"

mutation_id="$(ch "
SELECT mutation_id
FROM system.mutations
WHERE database = 'ulp'
  AND table = 'credentials'
  AND command = '(DELETE WHERE country_tier = \\'T3\\')'
ORDER BY create_time DESC
LIMIT 1
FORMAT TSVRaw
")"

if [[ -z "$mutation_id" ]]; then
  echo "ERROR: deletion was submitted but its mutation id could not be found." >&2
  exit 1
fi

echo "Mutation: $mutation_id"
started_at="$(date +%s)"

while true; do
  row="$(ch "
SELECT is_done, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE database = 'ulp' AND table = 'credentials' AND mutation_id = '$mutation_id'
FORMAT TSVRaw
")"

  if [[ -z "$row" ]]; then
    echo "ERROR: mutation $mutation_id disappeared before completion." >&2
    exit 1
  fi

  IFS=$'\t' read -r is_done parts_to_do latest_fail_reason <<< "$row"
  if [[ -n "${latest_fail_reason:-}" ]]; then
    echo "ERROR: mutation failed: $latest_fail_reason" >&2
    exit 1
  fi
  if [[ "$is_done" == "1" ]]; then
    break
  fi

  now="$(date +%s)"
  if (( now - started_at >= TIMEOUT_SECONDS )); then
    echo "ERROR: timed out after ${TIMEOUT_SECONDS}s; mutation still has $parts_to_do part(s)." >&2
    exit 1
  fi

  echo "Waiting: $parts_to_do part(s) remaining..."
  sleep "$POLL_SECONDS"
done

remaining_t3="$(ch "
SELECT countIf($PREDICATE) AS remaining_t3
FROM ulp.credentials
FORMAT TSVRaw
")"

if [[ "$remaining_t3" != "0" ]]; then
  echo "ERROR: mutation completed but remaining_t3=$remaining_t3." >&2
  exit 1
fi

echo "T3 purge complete; remaining_t3=0."
