#!/usr/bin/env bash
# Collapse ulp.credentials' exact-duplicate rows (by content_key_hash) into
# one canonical row per group, preserving cross-source lineage in
# ulp.credential_dedup_meta. Dry-run by default. Destructive modes:
#   BACKUP_VERIFIED=1 APPLY=1 bash scripts/backfill-credential-dedup.sh
#   ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/backfill-credential-dedup.sh
#
# See docs/superpowers/specs/2026-09-24-credential-dedup-backfill-design.md
#
# Architecture: a single GROUP BY content_key_hash over the full table needs
# more memory than the server allows. content_key_hash is a hash of a
# superset of (email, password), so bucketing on cityHash64(email, password)
# % 100 is disjoint in content_key_hash space -- each bucket's aggregate is
# already final and can be written straight into ulp.credential_dedup_meta,
# no cross-bucket merge required. If a bucket's plain aggregate still doesn't
# fit, it falls back to 8 further sub-slices (on cityHash64(source_file, url),
# uncorrelated with content_key_hash) merged via -State/-Merge combinators
# through the scratch table ulp.credential_dedup_partial before being written
# to the same target, then the scratch table is truncated back to empty.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
BACKUP_VERIFIED="${BACKUP_VERIFIED:-0}"
ACCEPT_PERMANENT_DATA_LOSS="${ACCEPT_PERMANENT_DATA_LOSS:-0}"
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

echo "ULP Suite - credential dedup backfill"
echo "APPLY=$APPLY (0 = dry-run)"
echo

echo "Ensuring scratch table exists (ad-hoc fallback buffer, not schema-tracked)..."
ch "
CREATE TABLE IF NOT EXISTS ulp.credential_dedup_partial
(
    content_key_hash            UInt64,
    partial_count                UInt64,
    sources_state                 AggregateFunction(groupUniqArray(50), String),
    partial_first_seen             DateTime,
    partial_last_seen              DateTime,
    canonical_url_state            AggregateFunction(argMin, String, Tuple(DateTime, String, String, String)),
    canonical_email_state          AggregateFunction(argMin, String, Tuple(DateTime, String, String, String)),
    canonical_password_state       AggregateFunction(argMin, String, Tuple(DateTime, String, String, String)),
    canonical_source_file_state    AggregateFunction(argMin, String, Tuple(DateTime, String, String, String))
)
ENGINE = MergeTree()
ORDER BY content_key_hash
"

echo "Clearing state from any previous attempt..."
ch "TRUNCATE TABLE ulp.credential_dedup_meta"
ch "TRUNCATE TABLE ulp.credential_dedup_partial SETTINGS max_table_size_to_drop = 0"

insert_bucket_plain() {
  local k="$1"
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "
  INSERT INTO ulp.credential_dedup_meta
  SELECT
      content_key_hash,
      count() AS source_count,
      groupUniqArray(50)(source_file) AS sources,
      min(imported_at) AS first_seen,
      max(imported_at) AS last_seen,
      argMin(url, (imported_at, url, email, password)) AS canonical_url,
      argMin(email, (imported_at, url, email, password)) AS canonical_email,
      argMin(password, (imported_at, url, email, password)) AS canonical_password,
      argMin(source_file, (imported_at, url, email, password)) AS canonical_source_file
  FROM ulp.credentials
  WHERE cityHash64(email, password) % 100 = $k
  GROUP BY content_key_hash
  SETTINGS max_execution_time = 0
  "
}

insert_bucket_subsliced() {
  local k="$1"
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "TRUNCATE TABLE ulp.credential_dedup_partial SETTINGS max_table_size_to_drop = 0" || return 1
  for s in 0 1 2 3 4 5 6 7; do
    "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "
    INSERT INTO ulp.credential_dedup_partial
    SELECT
        content_key_hash,
        count() AS partial_count,
        groupUniqArrayState(50)(source_file) AS sources_state,
        min(imported_at) AS partial_first_seen,
        max(imported_at) AS partial_last_seen,
        argMinState(url, (imported_at, url, email, password)) AS canonical_url_state,
        argMinState(email, (imported_at, url, email, password)) AS canonical_email_state,
        argMinState(password, (imported_at, url, email, password)) AS canonical_password_state,
        argMinState(source_file, (imported_at, url, email, password)) AS canonical_source_file_state
    FROM ulp.credentials
    WHERE cityHash64(email, password) % 100 = $k AND cityHash64(source_file, url) % 8 = $s
    GROUP BY content_key_hash
    SETTINGS max_execution_time = 0
    " || return 1
  done
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "
  INSERT INTO ulp.credential_dedup_meta
  SELECT
      content_key_hash,
      sum(partial_count) AS source_count,
      groupUniqArrayMerge(50)(sources_state) AS sources,
      min(partial_first_seen) AS first_seen,
      max(partial_last_seen) AS last_seen,
      argMinMerge(canonical_url_state) AS canonical_url,
      argMinMerge(canonical_email_state) AS canonical_email,
      argMinMerge(canonical_password_state) AS canonical_password,
      argMinMerge(canonical_source_file_state) AS canonical_source_file
  FROM ulp.credential_dedup_partial
  GROUP BY content_key_hash
  SETTINGS optimize_aggregation_in_order = 1
  " || return 1
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "TRUNCATE TABLE ulp.credential_dedup_partial SETTINGS max_table_size_to_drop = 0"
}

echo "Building ulp.credential_dedup_meta, 100 disjoint buckets on cityHash64(email, password)..."
failed_buckets=()
for k in $(seq 0 99); do
  if insert_bucket_plain "$k" >/tmp/dedup-bucket-$k.log 2>&1; then
    echo "$(date '+%H:%M:%S') bucket $k: OK (direct)"
    continue
  fi
  echo "$(date '+%H:%M:%S') bucket $k: direct attempt didn't fit, retrying with 8-way sub-slicing..."
  if insert_bucket_subsliced "$k" >/tmp/dedup-bucket-$k.log 2>&1; then
    echo "$(date '+%H:%M:%S') bucket $k: OK (sub-sliced)"
    continue
  fi
  echo "$(date '+%H:%M:%S') bucket $k: sub-sliced attempt also failed, restarting container and retrying once..."
  "$DOCKER_BIN" restart "$CONTAINER" >/dev/null
  until "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "SELECT 1" >/dev/null 2>&1; do sleep 2; done
  if insert_bucket_subsliced "$k" >/tmp/dedup-bucket-$k.log 2>&1; then
    echo "$(date '+%H:%M:%S') bucket $k: OK (sub-sliced, after restart)"
    continue
  fi
  echo "$(date '+%H:%M:%S') bucket $k: FAILED after restart -- see /tmp/dedup-bucket-$k.log"
  failed_buckets+=("$k")
done

echo
if [[ ${#failed_buckets[@]} -gt 0 ]]; then
  echo "WARNING: ${#failed_buckets[@]} bucket(s) never succeeded: ${failed_buckets[*]}"
  echo "The integrity check below will fail if this made the companion table incomplete."
else
  echo "All 100 buckets populated ulp.credential_dedup_meta successfully."
fi

echo
echo "Integrity check: sum(source_count) must equal ulp.credentials' total row count."
total_credentials="$(ch "SELECT count() FROM ulp.credentials FORMAT TSVRaw")"
sum_source_count="$(ch "SELECT sum(source_count) FROM ulp.credential_dedup_meta FORMAT TSVRaw")"
echo "  ulp.credentials total:            $total_credentials"
echo "  sum(source_count) in companion:   $sum_source_count"
if [[ "$total_credentials" != "$sum_source_count" ]]; then
  echo "ERROR: integrity check failed -- these must match exactly. Not proceeding." >&2
  exit 1
fi
echo "  OK: integrity check passed."

canonical_rows="$(ch "SELECT count() FROM ulp.credential_dedup_meta FORMAT TSVRaw")"
would_delete=$((total_credentials - canonical_rows))
echo
echo "Companion table has $canonical_rows canonical groups."
echo "This would delete $would_delete duplicate rows, keeping $canonical_rows."
echo "Note: a small number of groups (~0.2% at sample scale) tie on the full"
echo "match tuple due to batch-level imported_at granularity, so slightly"
echo "fewer than $would_delete rows may actually be removed -- this is a known,"
echo "safe (not a correctness issue) limitation. See the design doc."

echo
echo "Sample of duplicate groups by source_count (top 10):"
ch "
SELECT content_key_hash, source_count, length(sources) AS distinct_sources_seen, first_seen, last_seen
FROM ulp.credential_dedup_meta
ORDER BY source_count DESC
LIMIT 10
FORMAT PrettyCompact
"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry-run complete; no deletion submitted."
  echo "ulp.credential_dedup_meta is populated and ready to query."
  echo "After verifying an off-host backup, run:"
  echo "  BACKUP_VERIFIED=1 APPLY=1 bash scripts/backfill-credential-dedup.sh"
  echo "Or, to proceed irreversibly without a backup:"
  echo "  ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/backfill-credential-dedup.sh"
  exit 0
fi

if [[ "$BACKUP_VERIFIED" != "1" && "$ACCEPT_PERMANENT_DATA_LOSS" != "1" ]]; then
  echo "ERROR: refusing permanent deletion without an explicit acknowledgement." >&2
  echo "Use BACKUP_VERIFIED=1 after backup verification, or ACCEPT_PERMANENT_DATA_LOSS=1 to proceed without recovery." >&2
  exit 1
fi

if [[ "$BACKUP_VERIFIED" != "1" ]]; then
  echo "WARNING: no verified backup; permanent duplicate-row data loss explicitly accepted." >&2
fi

active="$(ch "
SELECT count() FROM system.mutations
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

echo
echo "Submitting bounded-memory lightweight duplicate-row deletion..."
ch "
DELETE FROM ulp.credentials
WHERE (content_key_hash, imported_at, url, email, password) NOT IN (
    SELECT content_key_hash, first_seen, canonical_url, canonical_email, canonical_password
    FROM ulp.credential_dedup_meta
)
SETTINGS lightweight_deletes_sync = 2,
         max_threads = 2,
         max_execution_time = 0,
         join_algorithm = 'auto'
"

remaining="$(ch "SELECT count() FROM ulp.credentials FORMAT TSVRaw")"
echo "Dedup purge complete; ulp.credentials now has $remaining rows (was $total_credentials, expected close to $canonical_rows)."

bytes_after="$(ch "
SELECT formatReadableSize(sum(bytes_on_disk))
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
FORMAT TSVRaw
")"

echo "Active-part storage: $bytes_before before, $bytes_after immediately after."
echo "Physical disk is reclaimed gradually by normal background merges; no OPTIMIZE FINAL is run."
