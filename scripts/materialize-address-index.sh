#!/usr/bin/env bash
# Add the lower(email) bloom filter (idx_bf_email_lc) to the existing parts of ulp.credentials after DDL v29, supervised.
#
#   bash scripts/materialize-address-index.sh            # dry run: preconditions and what it would do; changes nothing
#   APPLY=1 bash scripts/materialize-address-index.sh    # adds the index if missing, materializes it one partition at a time, verifies
#
# Why: every exact-address lookup compares lower(email) = lower(value) (lib/address-lookup.ts). That finds every stored casing of an
# address, but it is only fast when the parts carry this index. DDL v29 adds the definition (metadata; parts written from then on have
# the index); the existing parts need `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_bf_email_lc`, a mutation that rewrites index
# files only (measured on a scratch copy: 2.7 s and +47 MiB for 46M rows; about 1.2 GiB and a few minutes for 1.84B rows). Run this
# BEFORE deploying the image whose queries depend on the index. Design: docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md
#
# Never run it with merges stopped: SYSTEM STOP MERGES stops mutations too, and the wait below would never end. While parts are
# still merging the mutation is slower (it waits for the merges that involve its parts).
#
# Refuses (nothing changed) unless: no other mutation is running on the table (exit 2), free disk is at least MIN_FREE_GIB (2), and an
# index named idx_bf_email_lc that already exists indexes lower(email) (2). While it runs it watches free space and kills the mutation
# below ABORT_FREE_GIB (4). It ends by asking ClickHouse (EXPLAIN indexes = 1, projections off like the app's lookups) how many granules
# an address that cannot exist would read: at most MAX_SELECTED_PCT percent (the bloom filter's own false-positive rate is about 5%),
# or the index is not doing its job (6).
#
# Exit: 0 ok | 2 precondition | 4 aborted for disk | 5 timed out (the mutation is still running) | 6 the mutation failed, or the index is
#       not used / reads too much.
# Needs `npm ci` in this checkout (tsx). Counts only; never prints a row.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
MIN_FREE_GIB="${MIN_FREE_GIB:-130}"
ABORT_FREE_GIB="${ABORT_FREE_GIB:-120}"
POLL_SECONDS="${POLL_SECONDS:-5}"
MAX_MINUTES="${MAX_MINUTES:-60}"
MAX_SELECTED_PCT="${MAX_SELECTED_PCT:-10}"
CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
TSX_BIN="${TSX_BIN:-$PROJECT_DIR/node_modules/.bin/tsx}"
INDEX="idx_bf_email_lc"

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

echo "ULP Suite - lower(email) index backfill (DDL v29)"
echo "APPLY=$APPLY (0 = dry run)"
echo

# The DDL and the expression come from the code the queries are built from, so the two cannot drift.
ADD_SQL="$("$TSX_BIN" -e "import { addressIndexAddSql as s } from './lib/address-lookup'; process.stdout.write(s('ulp.credentials'))")"
EXPR="$("$TSX_BIN" -e "import { ADDRESS_INDEX_EXPR as e } from './lib/address-lookup'; process.stdout.write(e)")"
if [[ -z "$ADD_SQL" || -z "$EXPR" ]]; then
  echo "ERROR: could not read the index definition from lib/address-lookup.ts." >&2
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

# 2. Room: the index files are about 1.2 GiB, but a mutation may briefly keep a second copy of a part's files.
free_now="$(free_gib)"
if (( free_now < MIN_FREE_GIB )); then
  echo "ERROR: only $free_now GiB free; need at least $MIN_FREE_GIB GiB (MIN_FREE_GIB)." >&2
  exit 2
fi
echo "free disk: $free_now GiB (need $MIN_FREE_GIB, abort below $ABORT_FREE_GIB)"

# 3. The index: absent (APPLY=1 adds it) or present and indexing the right expression.
defined="$(ch "SELECT count() AS index_defined FROM system.data_skipping_indices WHERE database = 'ulp' AND table = 'credentials' AND name = '$INDEX' FORMAT TSVRaw")"
if [[ "${defined:-0}" != "0" ]]; then
  live_expr="$(ch "SELECT expr AS index_expression FROM system.data_skipping_indices WHERE database = 'ulp' AND table = 'credentials' AND name = '$INDEX' FORMAT TSVRaw")"
  if [[ "$live_expr" != "$EXPR" ]]; then
    echo "ERROR: an index named $INDEX exists but indexes '$live_expr', not '$EXPR'. Drop it by hand (ALTER TABLE ulp.credentials DROP INDEX $INDEX) and run again." >&2
    exit 2
  fi
  echo "index: defined on $EXPR"
else
  echo "index: not defined yet (APPLY=1 adds it)"
fi

# 4. Partitions, the smallest first, so the first mutation is the cheapest measurement of what it costs.
partitions="$(ch "SELECT partition AS partition_id FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active GROUP BY partition ORDER BY sum(bytes_on_disk) ASC FORMAT TSVRaw")"
echo "partitions (smallest first): $(echo $partitions)"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry run: nothing was changed. Run again with APPLY=1 to add the index and materialize it."
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

if [[ "${defined:-0}" == "0" ]]; then
  echo
  echo "Adding the index definition (metadata only)"
  ch "$ADD_SQL"
fi

for p in $partitions; do
  free_now="$(free_gib)"
  if (( free_now < MIN_FREE_GIB )); then
    echo "ERROR: only $free_now GiB free before partition $p (need $MIN_FREE_GIB). Free space, then run again: a partition that is already materialized is cheap to repeat." >&2
    exit 4
  fi
  echo
  echo "Materializing $INDEX for partition $p"
  started="$(date +%s)"
  PATTERN="%MATERIALIZE INDEX $INDEX IN PARTITION%$p%"
  before="$(last_mutation_id "$PATTERN")"
  ch "ALTER TABLE ulp.credentials MATERIALIZE INDEX $INDEX IN PARTITION '$p' SETTINGS mutations_sync = 0"
  wait_for_mutation "$PATTERN" "partition $p" "$before"
  echo "  partition $p done in $(( $(date +%s) - started )) s; free disk $(free_gib) GiB"
done

# ── verify: an address that cannot exist must read almost no granules ────────────────────────────────────────────────
echo
probe="ulp-address-index-probe-$$-$(date +%s)@invalid.test"
explain="$(ch "EXPLAIN indexes = 1 SELECT count() FROM ulp.credentials WHERE lower(email) = lower('$probe') SETTINGS optimize_use_projections = 0 FORMAT TSVRaw")"
granules="$(awk -v n="$INDEX" '$0 ~ ("Name: " n) { f = 1 } f && /Granules:/ { print $2; exit }' <<<"$explain")"
selected="${granules%/*}"
initial="${granules#*/}"
if [[ ! "$selected" =~ ^[0-9]+$ || ! "$initial" =~ ^[0-9]+$ ]]; then
  echo "ERROR: EXPLAIN does not show $INDEX being used for lower(email) = lower(value): the index is not used." >&2
  echo "$explain" | sed 's/^/       /' >&2
  exit 6
fi
echo "EXPLAIN: an address that cannot exist selects $selected of $initial granules"
if (( initial > 0 )) && (( selected * 100 > MAX_SELECTED_PCT * initial )); then
  echo "ERROR: that is more than $MAX_SELECTED_PCT% of the granules: some part does not carry $INDEX (or the index is ineffective)." >&2
  exit 6
fi

echo "index size: $(ch "SELECT formatReadableSize(data_compressed_bytes) AS index_size FROM system.data_skipping_indices WHERE database = 'ulp' AND table = 'credentials' AND name = '$INDEX' FORMAT TSVRaw")"
echo
echo "$INDEX is materialized on every partition. It is now safe to deploy the image whose lookups compare lower(email)."
