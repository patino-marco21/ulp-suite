#!/usr/bin/env bash
# Fill norm_key_hash in the existing parts of ulp.credentials after DDL v30, supervised.
#
#   bash scripts/materialize-norm-key.sh                          # dry run: preconditions and what it would do; changes nothing
#   APPLY=1 bash scripts/materialize-norm-key.sh                  # materializes the column one partition at a time, verifies, prints the exact share of surplus rows
#   APPLY=1 ONLY_PARTITION=202611 bash scripts/materialize-norm-key.sh   # one partition only (the smallest first: its time and disk change predict the rest)
#
# Why: an import matches on norm_key_hash only once every part of ulp.credentials holds it (lib/norm-key-ready.ts). DDL v30 adds the definition
# (metadata; parts written from then on carry the value); the existing parts need `ALTER TABLE ulp.credentials MATERIALIZE COLUMN norm_key_hash`,
# a mutation that computes the key from url, email and password and writes one 8-byte column (about 19.5 GiB for 2.6B rows; the key computes at
# 5.4M rows a second on 8 threads, so about 8 minutes of computing for the whole table). The image can be deployed first: until the column is
# complete the importer keeps the exact key. Design: docs/superpowers/specs/2026-11-01-near-duplicates-design.md
#
# Run it with no import running (it competes for CPU on a laptop that runs hot). Never with merges stopped: SYSTEM STOP MERGES stops mutations too,
# and the wait below would never end. A partition whose parts all hold the column already is skipped (doing it again recomputes 8 bytes a row).
#
# Refuses (nothing changed) unless: the column is defined, i.e. DDL v30 ran (exit 2); no other mutation is running on the table (2); and free disk is
# at least MIN_FREE_GIB (2). While it runs it watches free space and kills the mutation below ABORT_FREE_GIB (4). It ends by checking that every
# active part holds the column (6) and that in a 1/64 sample (content_key_hash % 64 = 0) the stored value equals the expression for every row (6), and
# prints the exact share of surplus rows from a 1/64 bucket of norm_key_hash (a bucket keeps whole groups, so it is an unbiased estimate).
#
# Exit: 0 ok | 2 precondition | 4 aborted for disk | 5 timed out (the mutation is still running) | 6 the mutation failed, or a check failed.
# Needs `npm ci` in this checkout (tsx). Counts only; never prints a row.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
ONLY_PARTITION="${ONLY_PARTITION:-}"
MIN_FREE_GIB="${MIN_FREE_GIB:-170}"
ABORT_FREE_GIB="${ABORT_FREE_GIB:-155}"
POLL_SECONDS="${POLL_SECONDS:-5}"
MAX_MINUTES="${MAX_MINUTES:-90}"
CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
TSX_BIN="${TSX_BIN:-$PROJECT_DIR/node_modules/.bin/tsx}"
COLUMN="norm_key_hash"
LIMITS="SETTINGS max_threads = 6, max_memory_usage = 4000000000"

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

free_gib() {
  local v
  v="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
  echo "${v:-0}"
}

parts_total() {
  ch "SELECT count() AS parts_total FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active FORMAT TSVRaw"
}

parts_with_column() {
  ch "SELECT uniqExact(name) AS parts_with_column FROM system.parts_columns WHERE database = 'ulp' AND table = 'credentials' AND active AND column = '$COLUMN' FORMAT TSVRaw"
}

# 1 when every active part of the partition lists the column.
partition_complete() {
  local p="$1" complete
  complete="$(ch "SELECT (SELECT count() FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active AND partition = '$p') = (SELECT uniqExact(name) FROM system.parts_columns WHERE database = 'ulp' AND table = 'credentials' AND active AND partition = '$p' AND column = '$COLUMN') AS partition_complete FORMAT TSVRaw")"
  [[ "$complete" == "1" ]]
}

echo "ULP Suite - norm_key_hash backfill (DDL v30)"
echo "APPLY=$APPLY (0 = dry run)"
echo

# The expression comes from the code the importer's tables are built from, so the two cannot drift.
EXPR="$("$TSX_BIN" -e "import { NORM_CONTENT_KEY as e } from './lib/url-content-key'; process.stdout.write(e)")"
if [[ -z "$EXPR" ]]; then
  echo "ERROR: could not read the key from lib/url-content-key.ts." >&2
  exit 1
fi

# 1. The column must exist: the app adds it at start-up (DDL v30).
defined="$(ch "SELECT count() AS column_defined FROM system.columns WHERE database = 'ulp' AND table = 'credentials' AND name = '$COLUMN' FORMAT TSVRaw")"
if [[ "${defined:-0}" != "1" ]]; then
  echo "ERROR: ulp.credentials has no $COLUMN column. Deploy the image with DDL v30 and let the app start first." >&2
  exit 2
fi
echo "column: defined"

# 2. One mutation at a time on this table.
pending="$(ch "SELECT count() AS pending_mutations FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND NOT is_done FORMAT TSVRaw")"
pending="${pending:-0}"
if (( pending > 0 )); then
  echo "ERROR: $pending mutation(s) are still running on ulp.credentials. Wait for them (system.mutations) and retry." >&2
  exit 2
fi
echo "pending mutations: 0"

# 3. Room: the column is about 19.5 GiB in all; a mutation writes the new column's files next to the old part and links the rest.
free_now="$(free_gib)"
if (( free_now < MIN_FREE_GIB )); then
  echo "ERROR: only $free_now GiB free; need at least $MIN_FREE_GIB GiB (MIN_FREE_GIB)." >&2
  exit 2
fi
echo "free disk: $free_now GiB (need $MIN_FREE_GIB, abort below $ABORT_FREE_GIB)"

# 4. Partitions, the smallest first, so the first mutation is the cheapest measurement of what it costs.
partitions="$(ch "SELECT partition AS partition_id FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active GROUP BY partition ORDER BY sum(bytes_on_disk) ASC FORMAT TSVRaw")"
if [[ -n "$ONLY_PARTITION" ]]; then
  if ! grep -qx "$ONLY_PARTITION" <<<"$partitions"; then
    echo "ERROR: ONLY_PARTITION=$ONLY_PARTITION is not a partition of ulp.credentials ($(echo $partitions))." >&2
    exit 2
  fi
  partitions="$ONLY_PARTITION"
fi
echo "parts holding $COLUMN: $(parts_with_column) of $(parts_total)"
echo "partitions (smallest first): $(echo $partitions)"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry run: nothing was changed. Run again with APPLY=1 to materialize $COLUMN."
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────

# Newest mutation id whose command matches a LIKE pattern, read BEFORE submitting a new one, so that we only ever wait for a
# mutation NEWER than that (an earlier finished run with the same command must not pass for this one).
last_mutation_id() {
  ch "SELECT max(mutation_id) AS last_mutation FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$1' FORMAT TSVRaw"
}

# wait_for_mutation LIKE_PATTERN LABEL BEFORE_ID: poll system.mutations until the newest matching mutation after BEFORE_ID is done.
# Exit 6 if it is failing or cannot be found, 4 (after killing it) if free disk drops below ABORT_FREE_GIB, 5 on timeout.
# Submitted with mutations_sync = 0 and polled: an ALTER that waits holds a silent connection the client may abandon.
wait_for_mutation() {
  local pattern="$1" label="$2" before="$3"
  local deadline=$(( $(date +%s) + MAX_MINUTES * 60 )) not_found=0 state is_done parts_to_do fail_reason free_here
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
    free_here="$(free_gib)"
    echo "  $(date -u +%H:%M:%S) $label: parts still to rewrite: ${parts_to_do:-?}; free disk ${free_here} GiB"
    if (( free_here < ABORT_FREE_GIB )); then
      ch "KILL MUTATION WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '$pattern' AND mutation_id > '$before'" || true
      echo "ERROR: free disk fell to $free_here GiB (< $ABORT_FREE_GIB); the $label mutation was killed. Free space and run again." >&2
      exit 4
    fi
    if (( $(date +%s) > deadline )); then
      echo "ERROR: the $label mutation is still running after $MAX_MINUTES minutes. It was NOT stopped; watch it in system.mutations." >&2
      exit 5
    fi
    sleep "$POLL_SECONDS"
  done
}

for p in $partitions; do
  if partition_complete "$p"; then
    echo
    echo "partition $p: every part already holds $COLUMN, skipped"
    continue
  fi
  free_now="$(free_gib)"
  if (( free_now < MIN_FREE_GIB )); then
    echo "ERROR: only $free_now GiB free before partition $p (need $MIN_FREE_GIB). Free space, then run again: a partition that is already done is skipped." >&2
    exit 4
  fi
  echo
  echo "Materializing $COLUMN for partition $p"
  started="$(date +%s)"
  PATTERN="%MATERIALIZE COLUMN $COLUMN IN PARTITION%$p%"
  before="$(last_mutation_id "$PATTERN")"
  ch "ALTER TABLE ulp.credentials MATERIALIZE COLUMN $COLUMN IN PARTITION '$p' SETTINGS mutations_sync = 0"
  wait_for_mutation "$PATTERN" "partition $p" "$before"
  echo "  partition $p done in $(( $(date +%s) - started )) s; free disk $(free_gib) GiB"
done

if [[ -n "$ONLY_PARTITION" ]]; then
  echo
  echo "Partition $ONLY_PARTITION is done. The final checks skipped: they need every partition (run again without ONLY_PARTITION)."
  exit 0
fi

# ── verify ───────────────────────────────────────────────────────────────────
echo
total="$(parts_total)"
with="$(parts_with_column)"
if [[ "$total" != "$with" ]]; then
  echo "ERROR: only $with of $total parts hold $COLUMN: the importer keeps the exact key until every part does." >&2
  exit 6
fi
echo "readiness: every one of $total parts holds $COLUMN"

mismatches="$(ch "SELECT count() AS norm_mismatches FROM ulp.credentials WHERE content_key_hash % 64 = 0 AND $COLUMN != $EXPR $LIMITS FORMAT TSVRaw")"
if [[ "${mismatches:-x}" != "0" ]]; then
  echo "ERROR: $mismatches rows of a 1/64 sample hold a $COLUMN that differs from the expression: the column is wrong." >&2
  exit 6
fi
echo "check: $COLUMN equals the expression for every row of a 1/64 sample"

sample="$(ch "SELECT count() AS sample_rows, uniqExact($COLUMN) AS sample_keys FROM ulp.credentials WHERE $COLUMN % 64 = 0 $LIMITS FORMAT TSVRaw")"
IFS=$'\t' read -r sample_rows sample_keys <<<"$sample"
if [[ ! "${sample_rows:-}" =~ ^[0-9]+$ || ! "${sample_keys:-}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: the sample query answered something else than two numbers." >&2
  exit 6
fi
awk -v r="$sample_rows" -v k="$sample_keys" 'BEGIN { if (r > 0) printf "surplus rows (they collapse into another row): %.0f of %.0f in a 1/64 bucket = %.2f%%\n", r - k, r, (r - k) * 100 / r }'
echo
echo "$COLUMN is complete. The next import matches on it by itself (INGEST_NORM_KEY=off turns that off)."
