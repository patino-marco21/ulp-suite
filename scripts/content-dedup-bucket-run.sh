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

# Escape single quotes in MUTATION_MARKER for SQL (double them)
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

for BUCKET in $(seq "$BUCKET_START" "$BUCKET_END"); do
  echo
  echo "-- Bucket $BUCKET / $((BUCKET_COUNT - 1)) --"
  BUCKET_FILTER="cityHash64($CONTENT_KEY) % $BUCKET_COUNT = $BUCKET"
  start_ts=$(date +%s)
  ch "
    ALTER TABLE ulp.credentials
    DELETE WHERE $BUCKET_FILTER
      AND $FULL_HASH NOT IN (
        SELECT min($FULL_HASH) FROM ulp.credentials
        WHERE $BUCKET_FILTER
        GROUP BY $CONTENT_KEY
      )
    SETTINGS mutations_sync = 1,
             allow_nondeterministic_mutations = 1,
             max_threads = 2,
             max_bytes_before_external_group_by = 4294967296
  "
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
