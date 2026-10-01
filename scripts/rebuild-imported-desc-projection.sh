#!/usr/bin/env bash
# Re-create proj_imported_desc with is_noise + content_key_hash (DDL v27) and build it for every partition in scope, supervised.
#
#   bash scripts/rebuild-imported-desc-projection.sh            # dry run: what exists, what would be built; changes nothing
#   APPLY=1 bash scripts/rebuild-imported-desc-projection.sh    # drops the old projection, adds the new one, builds it, verifies it
#
# Why: the Credentials Browser's default view filters on is_noise (Declutter) and de-duplicates on content_key_hash (Unique).
# A projection that lacks a column a query needs is not used, so with the v14 definition every default-view "Newest first"
# query read the base table (a plain browse took 40-48 s on 2026-10-01). With both columns lib/newest-first.ts runs the query
# as time windows on the projection's key: 0.13 s. The app refuses to use that path (isNewestFirstReady) until every part of the
# newest partition carries the NEW definition, so running this is what switches the speedup on; nothing breaks while it runs.
#
# What it writes: the projection only (a derived copy of the browse columns, ~34 GiB for the newest partition). It never
# touches a base row. DROP PROJECTION frees the old copy at once and the new one is built partition by partition; until a
# partition is rebuilt its queries fall back to the plain scan, as before. Every build is submitted asynchronously
# (mutations_sync = 0) and polled: a synchronous ALTER sits silent past clickhouse-client's 300 s receive timeout and the
# 2026-10-01 country_tier run was abandoned that way (the server finished it anyway).
#
# Refuses (nothing changed) while another mutation runs on the table (exit 2) or with under MIN_FREE_GIB free (2). While it runs
# it watches free space and kills the mutation below ABORT_FREE_GIB (4). Safe to re-run: when the projection is current it only
# builds the partitions that still have a part without it, and with nothing missing it writes nothing.
#
# Exit: 0 ok | 2 precondition | 4 aborted for disk | 5 timed out (the mutation is still running) | 6 a mutation failed, or the
#       verification found a part without the projection / a windowed query that does not use it.
# Needs `npm ci` in this checkout (tsx). Counts only; never prints a row.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
MIN_FREE_GIB="${MIN_FREE_GIB:-100}"
ABORT_FREE_GIB="${ABORT_FREE_GIB:-50}"
POLL_SECONDS="${POLL_SECONDS:-15}"
MAX_MINUTES="${MAX_MINUTES:-180}"
CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
TSX_BIN="${TSX_BIN:-$PROJECT_DIR/node_modules/.bin/tsx}"

cd "$PROJECT_DIR"

if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  echo "ERROR: Docker is unavailable in this shell." >&2
  exit 1
fi
if ! "$DOCKER_BIN" inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: ClickHouse container '$CONTAINER' is not running." >&2
  exit 1
fi
if [[ ! -x "$TSX_BIN" ]]; then
  echo "ERROR: $TSX_BIN is missing (run 'npm ci' in $PROJECT_DIR)." >&2
  exit 1
fi

ch() {
  # --receive_timeout: the client's default is 300 s of silence; a query that only waits must not be abandoned.
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --receive_timeout=7200 --send_timeout=7200 --query "$1"
}

echo "ULP Suite - rebuild proj_imported_desc (DDL v27)"
echo "APPLY=$APPLY (0 = dry run)"
echo

# The SQL comes from the code, so this script cannot drift from the migration, the restore after a dedup swap, or the readiness gate.
ts() { "$TSX_BIN" -e "import * as p from './lib/credentials-projections'; import * as s from './lib/projection-scope'; $1"; }
CURRENT_SQL="$(ts "process.stdout.write(p.buildImportedDescProjectionCurrentSql())")"
DROP_SQL="$(ts "process.stdout.write(p.buildDropImportedDescProjectionSql())")"
ADD_SQL="$(ts "process.stdout.write(p.buildAddImportedDescProjectionSql())")"
SCOPE_SQL="$(ts "process.stdout.write(p.buildRecentPartitionsSql(s.cutoffPartition(s.projectionScopeWindowMonths(), new Date())))")"
if [[ -z "$CURRENT_SQL" || -z "$DROP_SQL" || -z "$ADD_SQL" || -z "$SCOPE_SQL" ]]; then
  echo "ERROR: could not read the projection SQL from lib/credentials-projections.ts." >&2
  exit 1
fi

# 1. One mutation at a time on this table.
pending="$(ch "SELECT count() AS pending_mutations FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND NOT is_done FORMAT TSVRaw")"
pending="${pending:-0}"
if (( pending > 0 )); then
  echo "ERROR: $pending mutation(s) are still running on ulp.credentials. Wait for them (system.mutations) and retry." >&2
  exit 2
fi
echo "pending mutations: 0"

# 2. Room for the new projection (about 34 GiB for the newest partition) plus merges.
free_gib="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
free_gib="${free_gib:-0}"
if (( free_gib < MIN_FREE_GIB )); then
  echo "ERROR: only $free_gib GiB free; need at least $MIN_FREE_GIB GiB (MIN_FREE_GIB)." >&2
  exit 2
fi
echo "free disk: $free_gib GiB (need $MIN_FREE_GIB)"

# 3. What exists, and which partitions should have it (the recency window, plus always the newest partition).
current="$(ch "$CURRENT_SQL FORMAT TSVRaw")"
current="${current:-0}"
scope="$(ch "SELECT partition AS scope_partition FROM ($SCOPE_SQL) ORDER BY scope_partition DESC FORMAT TSVRaw")"
if [[ -z "$scope" ]]; then
  echo "ERROR: the table has no partitions." >&2
  exit 2
fi
scope_list="$(printf '%s\n' $scope | sed "s/.*/'&'/" | paste -sd, -)"
echo "projection definition: $([[ "$current" == "1" ]] && echo 'current (has is_noise + content_key_hash)' || echo 'missing or OLD (v14: no is_noise / content_key_hash)')"
echo "partitions in scope: $(printf '%s\n' $scope | paste -sd' ' -)"

missing_partitions() {
  ch "SELECT DISTINCT partition AS partition_missing_projection FROM system.parts
      WHERE database = 'ulp' AND table = 'credentials' AND active AND partition IN ($scope_list)
        AND name NOT IN (SELECT parent_name FROM system.projection_parts
                         WHERE database = 'ulp' AND table = 'credentials' AND name = 'proj_imported_desc' AND active)
      ORDER BY partition DESC FORMAT TSVRaw"
}

if [[ "$APPLY" != "1" ]]; then
  echo
  if [[ "$current" == "1" ]]; then
    to_build="$(missing_partitions)"
    echo "Dry run: would build proj_imported_desc for: ${to_build:-nothing (every part in scope already has it)}"
  else
    echo "Dry run: would DROP the old projection, ADD the new one, and build it for every partition in scope."
  fi
  echo "Nothing was changed. Run again with APPLY=1."
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────

last_mutation_id() {
  ch "SELECT max(mutation_id) AS last_mutation FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$1' FORMAT TSVRaw"
}

# wait_for_mutation LIKE_PATTERN LABEL BEFORE_ID: poll system.mutations until the newest matching mutation after BEFORE_ID is done.
# Exit 6 if it is failing or cannot be found, 4 (after killing it) if free disk drops below ABORT_FREE_GIB, 5 on timeout.
wait_for_mutation() {
  local pattern="$1" label="$2" before="$3"
  local deadline=$(( $(date +%s) + MAX_MINUTES * 60 )) not_found=0 state is_done parts_to_do fail_reason free_now
  while true; do
    state="$(ch "SELECT is_done, parts_to_do, latest_fail_reason AS mutation_state FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$pattern' AND mutation_id > '$before' ORDER BY mutation_id DESC LIMIT 1 FORMAT TSVRaw")"
    if [[ -z "$state" ]]; then
      not_found=$(( not_found + 1 ))
      if (( not_found >= 5 )); then
        echo "ERROR: the $label mutation is not in system.mutations; check it by hand before running this again." >&2
        exit 6
      fi
      sleep "$POLL_SECONDS"
      continue
    fi
    IFS=$'\t' read -r is_done parts_to_do fail_reason <<<"$state"
    if [[ -n "${fail_reason:-}" ]]; then
      echo "ERROR: the $label mutation is failing: $fail_reason" >&2
      echo "       It keeps retrying. To stop it:  docker exec $CONTAINER clickhouse-client --query \"KILL MUTATION WHERE database='ulp' AND table='credentials' AND command LIKE '$pattern' AND mutation_id > '$before'\"" >&2
      exit 6
    fi
    if [[ "${is_done:-0}" == "1" ]]; then
      return 0
    fi
    free_now="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
    free_now="${free_now:-0}"
    echo "  $(date -u +%H:%M:%S) $label: parts still to build: ${parts_to_do:-?}; free disk ${free_now} GiB"
    if (( free_now < ABORT_FREE_GIB )); then
      ch "KILL MUTATION WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$pattern' AND mutation_id > '$before'" || true
      echo "ERROR: free disk fell to $free_now GiB (< $ABORT_FREE_GIB); the $label mutation was killed. Free space and run again." >&2
      exit 4
    fi
    if (( $(date +%s) > deadline )); then
      echo "ERROR: the $label mutation is still running after $MAX_MINUTES minutes. It was NOT stopped; watch it in system.mutations." >&2
      exit 5
    fi
    sleep "$POLL_SECONDS"
  done
}

if [[ "$current" != "1" ]]; then
  echo
  echo "Replacing the projection definition (metadata only: the old copy is freed, the base rows are untouched)..."
  ch "$DROP_SQL"
  ch "$ADD_SQL"
fi

to_build="$(missing_partitions)"
for p in $to_build; do
  free_now="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
  free_now="${free_now:-0}"
  if (( free_now < MIN_FREE_GIB )); then
    echo "ERROR: only $free_now GiB free before building partition $p (need $MIN_FREE_GIB). Free space, then run this again." >&2
    exit 4
  fi
  echo
  echo "Building proj_imported_desc for partition $p (this takes a while)..."
  PATTERN="%MATERIALIZE PROJECTION proj_imported_desc IN PARTITION%$p%"
  before="$(last_mutation_id "$PATTERN")"
  ch "ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_imported_desc IN PARTITION '$p' SETTINGS mutations_sync = 0"
  wait_for_mutation "$PATTERN" "proj_imported_desc build (partition $p)" "$before"
  echo "partition $p built"
done

# ── verify ───────────────────────────────────────────────────────────────────
echo
echo "Verifying..."
for p in $scope; do
  without="$(ch "SELECT count() AS parts_without_projection FROM system.parts
      WHERE database = 'ulp' AND table = 'credentials' AND active AND partition = '$p'
        AND name NOT IN (SELECT parent_name FROM system.projection_parts
                         WHERE database = 'ulp' AND table = 'credentials' AND name = 'proj_imported_desc' AND active)
      FORMAT TSVRaw")"
  if [[ "${without:-x}" != "0" ]]; then
    echo "ERROR: partition $p still has ${without:-an unknown number of} part(s) without proj_imported_desc." >&2
    exit 6
  fi
  echo "partition $p: every part carries proj_imported_desc"
done
now_current="$(ch "$CURRENT_SQL FORMAT TSVRaw")"
if [[ "${now_current:-0}" != "1" ]]; then
  echo "ERROR: the live projection definition is still not the current one." >&2
  exit 6
fi

# The point of all this: a windowed query, written on the projection's key, must be answered by the projection and read a sliver of
# the partition (the same window written on imported_at read all 495,875,196 rows of the newest partition on 2026-10-01).
newest="$(ch "SELECT toUnixTimestamp(max(imported_at)) AS newest_ts FROM ulp.credentials FORMAT TSVRaw")"
qid="rebuild-probe-$$-$(date +%s)"
"$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query_id "$qid" --format Null --query "SELECT url, email, password, domain, imported_at, is_noise, content_key_hash FROM ulp.credentials WHERE negate(toUnixTimestamp(imported_at)) < -($newest - 300) AND is_noise = 0 ORDER BY imported_at DESC, domain ASC, email ASC, url ASC, password ASC LIMIT 50"
ch "SYSTEM FLUSH LOGS" >/dev/null
check="$(ch "SELECT toUInt8(has(projections, 'ulp.credentials.proj_imported_desc') AND read_rows < 100000000) AS projection_check FROM system.query_log WHERE query_id = '$qid' AND type = 'QueryFinish' ORDER BY event_time DESC LIMIT 1 FORMAT TSVRaw")"
if [[ "${check:-0}" != "1" ]]; then
  echo "ERROR: the windowed query did not use proj_imported_desc, or read 100M+ rows (system.query_log, query_id $qid)." >&2
  echo "       lib/newest-first.ts would not be faster than the plain query; do not rely on it until this is understood." >&2
  exit 6
fi
echo "a 5-minute window on the projection key is answered by proj_imported_desc and reads a sliver of the partition"

echo
echo "Projection sizes (partition, parts, rows, GiB):"
ch "SELECT partition, count() AS parts, sum(rows) AS rows, round(sum(bytes_on_disk) / 1073741824, 2) AS gib FROM system.projection_parts WHERE database = 'ulp' AND table = 'credentials' AND name = 'proj_imported_desc' AND active GROUP BY partition ORDER BY partition FORMAT TSV"
echo
echo "proj_imported_desc is ready."
echo "Next: NFW_PARITY=1 npx vitest run __tests__/newest-first-parity.live.test.ts   (the windowed pages must equal the plain query's, page for page)"
