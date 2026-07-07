#!/usr/bin/env bash
# One-off / re-runnable bucketed content-dedup DELETE against a bucket range.
#
# Mirrors lib/content-dedup.ts's contentDuplicatePredicateForBucket /
# buildDeleteExecSqlForBucket exactly -- bash can't import TS, so this
# hand-copies the same expressions (matching scripts/dedup-credentials-content.sh's
# existing precedent for this table). Keep CONTENT_KEY/FULL_HASH below
# byte-identical to lib/url-content-key.ts's URL_CONTENT_KEY and
# lib/content-dedup.ts's CONTENT_KEY / FULL_HASH.
#
# Dry-run by default (reports current duplicate scope only, submits nothing).
# Set APPLY=1 to actually run the DELETE mutations for the configured bucket
# range.
#
#   bash scripts/content-dedup-bucket-run.sh                                        # dry-run, buckets 0-31 of 1024
#   BUCKET_START=0 BUCKET_END=31 APPLY=1 bash scripts/content-dedup-bucket-run.sh    # apply buckets 0-31
#   BUCKET_START=32 BUCKET_END=63 APPLY=1 bash scripts/content-dedup-bucket-run.sh   # apply the next range
#
# See docs/superpowers/specs/2026-07-06-content-dedup-bucketed-delete-design.md
# for why this exists (Rollout Plan) and lib/content-dedup.ts's SCALE comment
# for why the DELETE is bucketed at all.
#
# Each bucket is submitted fire-and-forget and polled for completion (not one
# blocking connection held open for the mutation's full duration -- see the
# MUTATION WAIT comment in lib/content-dedup.ts for why). Tune with:
#   PROGRESS_POLL_SECONDS      how often to print a live progress line (default 15)
#   BUCKET_MAX_WAIT_SECONDS    give up waiting for one bucket after this long (default 3600)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
APPLY="${APPLY:-0}"
BUCKET_START="${BUCKET_START:-0}"
BUCKET_END="${BUCKET_END:-31}"
BUCKET_COUNT="${BUCKET_COUNT:-1024}"

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

if [[ "$BUCKET_START" -lt 0 || "$BUCKET_END" -lt "$BUCKET_START" || "$BUCKET_END" -ge "$BUCKET_COUNT" ]]; then
  echo "ERROR: invalid bucket range BUCKET_START=$BUCKET_START BUCKET_END=$BUCKET_END BUCKET_COUNT=$BUCKET_COUNT" >&2
  exit 1
fi

ch() {
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "$1"
}

# Must stay byte-identical to lib/url-content-key.ts's URL_CONTENT_KEY and
# lib/content-dedup.ts's CONTENT_KEY / FULL_HASH. The `\$` below is
# bash-escaping for a literal `$` (RE2 end-of-string anchor).
CONTENT_KEY="replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password"
FULL_HASH="cityHash64(url, email, password, domain, source_file, breach_name, imported_at, _part, _part_offset)"
# Distinctive substring of the mutation command, for the in-flight check below --
# must match lib/content-dedup.ts's MUTATION_MARKER exactly.
MUTATION_MARKER="GROUP BY $CONTENT_KEY"

echo "ULP Suite - bucketed content-dedup DELETE"
echo "APPLY=$APPLY (0 = dry-run)"
echo "Buckets: $BUCKET_START..$BUCKET_END of $BUCKET_COUNT"
echo

# MUTATION_MARKER contains single quotes (from CONTENT_KEY's regex literals),
# and gets embedded here inside another single-quoted SQL string ('%...%') --
# without escaping, ClickHouse's parser sees those quotes as closing the outer
# string early and throws a syntax error. Double them (SQL's standard escape)
# to keep the whole thing one valid string literal.
escaped_marker="${MUTATION_MARKER//\'/\'\'}"
active="$(ch "
SELECT count()
FROM system.mutations
WHERE database = 'ulp' AND table = 'credentials' AND is_done = 0
  AND command LIKE '%$escaped_marker%'
FORMAT TSVRaw
")"
if [[ "$active" != "0" ]]; then
  echo "ERROR: $active content-dedup mutation(s) already in flight; wait before running more buckets." >&2
  exit 1
fi

echo "Duplicate stats before this run (whole table):"
ch "
SELECT
  count() AS total,
  uniqExact(cityHash64($CONTENT_KEY)) AS distinct_creds,
  total - distinct_creds AS excess
FROM ulp.credentials
FORMAT Vertical
"

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry-run complete; no mutation submitted."
  echo "To apply buckets $BUCKET_START-$BUCKET_END, run:"
  echo "  BUCKET_START=$BUCKET_START BUCKET_END=$BUCKET_END APPLY=1 bash scripts/content-dedup-bucket-run.sh"
  exit 0
fi

# Poll interval (seconds) for the live progress line printed while waiting for
# a bucket's mutation to finish. system.mutations' parts_to_do only moves when
# an ENTIRE part finishes -- for a large/slow part that can be many minutes
# with parts_to_do looking frozen the whole time, which is indistinguishable
# from "hung" without also checking system.merges' live per-part progress
# fraction (confirmed live 2026-07-07: a single part took ~20 minutes with
# parts_to_do stuck at 1 throughout, while system.merges showed steady
# 0.76 -> 0.84 -> ... progress the whole time).
PROGRESS_POLL_SECONDS="${PROGRESS_POLL_SECONDS:-15}"
# Give up waiting for a single bucket after this long -- matches
# lib/content-dedup.ts's CONTENT_DEDUP_BUCKET_MAX_WAIT_MS.
BUCKET_MAX_WAIT_SECONDS="${BUCKET_MAX_WAIT_SECONDS:-3600}"

for BUCKET in $(seq "$BUCKET_START" "$BUCKET_END"); do
  echo
  echo "-- Bucket $BUCKET / $((BUCKET_COUNT - 1)) --"
  BUCKET_FILTER="cityHash64($CONTENT_KEY) % $BUCKET_COUNT = $BUCKET"
  start_ts=$(date +%s)

  # mutations_sync = 0: fire-and-forget. The submitting query returns as soon
  # as the mutation is registered, instead of holding one connection open and
  # blocking for the mutation's full duration. Confirmed live 2026-07-07:
  # mutations_sync = 1 hit the profile's receive_timeout/send_timeout (300s)
  # on a bucket that took ~34 minutes -- reported as a client-side failure
  # even though the mutation had ACTUALLY SUCCEEDED server-side (is_done=1,
  # correct row count removed). Polling below (fresh short queries each time)
  # avoids that whole class of long-lived-connection timeout.
  ch "
    ALTER TABLE ulp.credentials
    DELETE WHERE $BUCKET_FILTER
      AND $FULL_HASH NOT IN (
        SELECT min($FULL_HASH) FROM ulp.credentials
        WHERE $BUCKET_FILTER
        GROUP BY $CONTENT_KEY
      )
    SETTINGS mutations_sync = 0,
             allow_nondeterministic_mutations = 1,
             max_threads = 2,
             max_bytes_before_external_group_by = 4294967296
  "

  while true; do
    # `|| true`: this is a status poll only -- under set -e, a transient
    # failure here (e.g. a momentary docker exec hiccup) must never abort the
    # script while the real mutation may still be running server-side.
    active="$(ch "
      SELECT count() FROM system.mutations
      WHERE database = 'ulp' AND table = 'credentials' AND is_done = 0
        AND command LIKE '%$escaped_marker%'
      FORMAT TSVRaw
    " 2>/dev/null)" || true
    [[ "$active" == "0" ]] && break

    now_ts=$(date +%s)
    if (( now_ts - start_ts > BUCKET_MAX_WAIT_SECONDS )); then
      echo "Bucket $BUCKET did not finish within ${BUCKET_MAX_WAIT_SECONDS}s -- giving up (mutation may still be running server-side; check system.mutations)." >&2
      exit 1
    fi

    merge_line="$(ch "
      SELECT concat(round(progress * 100, 1), '% of current part (', toString(round(elapsed)), 's elapsed, ', result_part_name, ')')
      FROM system.merges
      WHERE database = 'ulp' AND table = 'credentials' AND is_mutation = 1
      LIMIT 1
      FORMAT TSVRaw
    " 2>/dev/null)" || true
    parts_left="$(ch "
      SELECT parts_to_do FROM system.mutations
      WHERE database = 'ulp' AND table = 'credentials' AND is_done = 0
      ORDER BY create_time DESC LIMIT 1
      FORMAT TSVRaw
    " 2>/dev/null)" || true
    if [[ -n "$merge_line" ]]; then
      echo "  [$(date +%H:%M:%S)] $merge_line -- parts_to_do=${parts_left:-?}"
    else
      echo "  [$(date +%H:%M:%S)] between parts -- parts_to_do=${parts_left:-?}"
    fi
    sleep "$PROGRESS_POLL_SECONDS"
  done

  # No separate latest_fail_reason check here: it can hold a stale message
  # from an earlier transient retry even after the mutation goes on to
  # succeed, so checking it after "no longer in flight" risks a false
  # positive -- "no longer in flight" (is_done=1, since nothing else removes
  # a mutation from system.mutations under normal operation) is the
  # authoritative completion signal, matching lib/content-dedup.ts's
  # waitForBucketMutation.
  elapsed=$(( $(date +%s) - start_ts ))
  echo "Bucket $BUCKET done in ${elapsed}s."
done

echo
echo "Duplicate stats after this run (whole table):"
ch "
SELECT
  count() AS total,
  uniqExact(cityHash64($CONTENT_KEY)) AS distinct_creds,
  total - distinct_creds AS excess
FROM ulp.credentials
FORMAT Vertical
"

echo
PROJ_COUNT="$(ch "SHOW CREATE TABLE ulp.credentials" --format TabSeparatedRaw | grep -c "proj_imported_desc" || true)"
echo "Projection present: $PROJ_COUNT (should be 1)"

echo
echo "Bucket range $BUCKET_START-$BUCKET_END of $BUCKET_COUNT complete."
