#!/usr/bin/env bash
# Backfill ulp.credentials.country_tier after DDL v26 (lib/clickhouse-migrations.ts), supervised.
#
#   bash scripts/materialize-country-tier.sh            # dry run: preconditions, sample parity, estimate; changes nothing
#   APPLY=1 bash scripts/materialize-country-tier.sh    # runs the backfill, waits for it, then verifies the whole table
#
# Why: the stored label was a frozen copy of the generator and it drifted (on 2026-10-01 1,919,919 rows were stored
# as T3 that the importer's classifyTier() does not call T3; a 1.39M-row sample showed 0.35% of ALL rows labelled
# differently from the importer). v26 swapped the column's expression so new rows are right; this rewrites the
# existing ones with `ALTER TABLE ulp.credentials MATERIALIZE COLUMN country_tier`: a new country_tier column file per
# part and a rebuild of idx_set_country_tier. It is the label only -- derived from email_domain and url -- so no row is
# added or removed.
#
# proj_imported_desc carries country_tier, and MATERIALIZE COLUMN does NOT rebuild it (measured on a scratch copy: after
# the backfill the base column had 0 stale labels while the projection still served 92,635 of 24.76M, and a plain
# `MATERIALIZE PROJECTION` is a no-op on a part that already has it). So each partition that has the projection is then
# CLEARed and MATERIALIZEd again (~30 GiB written on the newest partition), and the result is verified through the
# projection as well as through the base column.
#
# Refuses (nothing changed) unless: the live column already has the v26 expression (exit 2), no other mutation is
# running on the table (2), there is enough free disk (2), and the new expression agrees with the importer on a
# deterministic 0.1% sample (3). While it runs it watches free space and kills the mutation below ABORT_FREE_GIB (4).
#
# Exit: 0 ok | 2 precondition | 3 expression disagrees with the importer | 4 aborted for disk | 5 timed out (the
#       mutation is still running) | 6 the mutation failed, or the verification found a stored label that differs.
# Needs `npm ci` in this checkout (tsx). Counts only; never prints a row.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
MIN_FREE_GIB="${MIN_FREE_GIB:-100}"
ABORT_FREE_GIB="${ABORT_FREE_GIB:-50}"
POLL_SECONDS="${POLL_SECONDS:-15}"
MAX_MINUTES="${MAX_MINUTES:-240}"
SAMPLE_MOD="${SAMPLE_MOD:-1000}"
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
  "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "$1"
}

echo "ULP Suite - country_tier backfill (DDL v26)"
echo "APPLY=$APPLY (0 = dry run)"
echo

# The expression the code generates: what the column should hold, and what we verify against.
EXPR="$("$TSX_BIN" -e "import { buildCountryTierExpression as b } from './lib/country-tiers'; process.stdout.write(b())")"
if [[ -z "$EXPR" ]]; then
  echo "ERROR: could not generate the country_tier expression." >&2
  exit 1
fi

# 1. The column must already have the v26 expression, or MATERIALIZE would just recompute the old (wrong) labels.
live_expr="$(ch "SELECT default_expression AS live_expression FROM system.columns WHERE database = 'ulp' AND table = 'credentials' AND name = 'country_tier' FORMAT TSVRaw")"
if [[ "$live_expr" != *email_domain* || "$live_expr" == *"splitByChar('@', lower(email))"* ]]; then
  echo "ERROR: ulp.credentials.country_tier still has the old expression. Deploy the app first so DDL v26 runs" >&2
  echo "       (docker compose logs app | grep 'DDL v26'), then run this again." >&2
  exit 2
fi
echo "column expression: v26 (reads email_domain)"

# 2. One mutation at a time on this table.
pending="$(ch "SELECT count() AS pending_mutations FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND NOT is_done FORMAT TSVRaw")"
pending="${pending:-0}"
if (( pending > 0 )); then
  echo "ERROR: $pending mutation(s) are still running on ulp.credentials. Wait for them (system.mutations) and retry." >&2
  exit 2
fi
echo "pending mutations: 0"

# 3. Room for the projection rebuild (about 30 GiB) plus merges.
free_gib="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
free_gib="${free_gib:-0}"
if (( free_gib < MIN_FREE_GIB )); then
  echo "ERROR: only $free_gib GiB free; need at least $MIN_FREE_GIB GiB (MIN_FREE_GIB) before rewriting proj_imported_desc." >&2
  exit 2
fi
echo "free disk: $free_gib GiB (need $MIN_FREE_GIB)"
echo

# 4. The new expression must agree with the importer before it is spread over every row. The stored label is EXPECTED to
#    differ on this sample (that is what the backfill fixes); only expression-vs-importer must be zero.
parity_sample() {
  ch "SELECT country_tier, ($EXPR), email, url FROM ulp.credentials WHERE cityHash64(email, url) % $SAMPLE_MOD = 13 FORMAT TSV" |
    "$TSX_BIN" "$SCRIPT_DIR/check-tier-parity.ts" || true
}
echo "Sample parity (1 row in $SAMPLE_MOD): stored label vs the new expression vs the importer's classifyTier()"
parity_report="$(parity_sample)"
echo "$parity_report"
expr_vs_importer="$(sed -n 's/.*expression_vs_importer=\([0-9][0-9]*\).*/\1/p' <<<"$parity_report" | tail -1)"
if [[ -z "$expr_vs_importer" || "$expr_vs_importer" != 0 ]]; then
  echo "ERROR: refusing: the new expression disagrees with the importer on the sample (expression_vs_importer=${expr_vs_importer:-unknown})." >&2
  echo "       Fix lib/country-tiers.ts (the generator or classifyTier) first; the backfill would spread the disagreement." >&2
  exit 3
fi

total_rows="$(ch "SELECT count() AS total_rows FROM ulp.credentials FORMAT TSVRaw" || true)"
changing="$(sed -n 's/.*stored_vs_expression=\([0-9][0-9]*\).*/\1/p' <<<"$parity_report" | tail -1)"
checked="$(sed -n 's/.*parity-result: checked=\([0-9][0-9]*\).*/\1/p' <<<"$parity_report" | tail -1)"
if [[ -n "${total_rows:-}" && -n "$changing" && -n "$checked" && "$checked" != 0 ]]; then
  echo "Estimate: about $(( total_rows * changing / checked )) of $total_rows rows change their stored label."
fi

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry run: nothing was changed. Run again with APPLY=1 to backfill."
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────
echo
echo "Starting: ALTER TABLE ulp.credentials MATERIALIZE COLUMN country_tier (asynchronous; this script watches it)"
ch "ALTER TABLE ulp.credentials MATERIALIZE COLUMN country_tier SETTINGS mutations_sync = 0"

deadline=$(( $(date +%s) + MAX_MINUTES * 60 ))
not_found=0
while true; do
  state="$(ch "SELECT is_done, parts_to_do, latest_fail_reason AS mutation_state FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '%MATERIALIZE COLUMN country_tier%' ORDER BY create_time DESC LIMIT 1 FORMAT TSVRaw")"
  if [[ -z "$state" ]]; then
    not_found=$(( not_found + 1 ))
    if (( not_found >= 5 )); then
      echo "ERROR: the MATERIALIZE mutation is not in system.mutations; check it by hand before running this again." >&2
      exit 6
    fi
    sleep "$POLL_SECONDS"
    continue
  fi
  IFS=$'\t' read -r is_done parts_to_do fail_reason <<<"$state"
  if [[ -n "${fail_reason:-}" ]]; then
    echo "ERROR: the mutation is failing: $fail_reason" >&2
    echo "       It keeps retrying. To stop it:  docker exec $CONTAINER clickhouse-client --query \"KILL MUTATION WHERE database='ulp' AND table='credentials' AND command LIKE '%MATERIALIZE COLUMN country_tier%'\"" >&2
    exit 6
  fi
  if [[ "${is_done:-0}" == "1" ]]; then
    break
  fi
  free_now="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
  free_now="${free_now:-0}"
  echo "  $(date -u +%H:%M:%S) parts still to rewrite: ${parts_to_do:-?}; free disk ${free_now} GiB"
  if (( free_now < ABORT_FREE_GIB )); then
    ch "KILL MUTATION WHERE database = 'ulp' AND table = 'credentials' AND command LIKE '%MATERIALIZE COLUMN country_tier%'" || true
    echo "ERROR: free disk fell to $free_now GiB (< $ABORT_FREE_GIB); the mutation was killed. Free space and run again." >&2
    exit 4
  fi
  if (( $(date +%s) > deadline )); then
    echo "ERROR: still running after $MAX_MINUTES minutes. It was NOT stopped; watch it in system.mutations." >&2
    exit 5
  fi
  sleep "$POLL_SECONDS"
done
echo "mutation finished"

# ── proj_imported_desc: clear and rebuild it where it exists (see the header) ─────────────────────────────────────────
projection_partitions="$(ch "SELECT DISTINCT partition AS projection_partition FROM system.projection_parts WHERE database = 'ulp' AND table = 'credentials' AND name = 'proj_imported_desc' AND active ORDER BY partition FORMAT TSVRaw")"
for p in $projection_partitions; do
  free_now="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
  free_now="${free_now:-0}"
  if (( free_now < MIN_FREE_GIB )); then
    echo "ERROR: only $free_now GiB free before rebuilding proj_imported_desc for partition $p (need $MIN_FREE_GIB)." >&2
    echo "       The column is backfilled, but that partition's projection still serves the OLD labels. Free space, then:" >&2
    echo "       ALTER TABLE ulp.credentials CLEAR PROJECTION proj_imported_desc IN PARTITION '$p'; then MATERIALIZE it again." >&2
    exit 4
  fi
  echo
  echo "Rebuilding proj_imported_desc for partition $p (it carries country_tier; this takes a while)..."
  ch "ALTER TABLE ulp.credentials CLEAR PROJECTION proj_imported_desc IN PARTITION '$p' SETTINGS mutations_sync = 2"
  ch "ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_imported_desc IN PARTITION '$p' SETTINGS mutations_sync = 1, max_execution_time = 7200, timeout_overflow_mode = 'throw'"
done

# ── verify: the stored label must now equal the expression on EVERY row (base columns), and in the projection ──────────
echo
echo "Verifying every row against the expression (reads email_domain and url; takes a few minutes)..."
mismatch="$(ch "SELECT countIf(country_tier != ($EXPR)) AS stored_ne_expression FROM ulp.credentials SETTINGS optimize_use_projections = 0, max_execution_time = 3600 FORMAT TSVRaw")"
if [[ "${mismatch:-x}" != "0" ]]; then
  echo "ERROR: $mismatch rows still carry a stored label that differs from the expression." >&2
  exit 6
fi
for p in $projection_partitions; do
  stale="$(ch "SELECT count() AS stale_in_projection FROM ulp.credentials WHERE toYYYYMM(imported_at) = $p AND country_tier != ($EXPR) SETTINGS optimize_use_projections = 1, force_optimize_projection = 1, force_optimize_projection_name = 'proj_imported_desc', max_execution_time = 3600 FORMAT TSVRaw")"
  if [[ "${stale:-x}" != "0" ]]; then
    echo "ERROR: proj_imported_desc (partition $p) still serves a stale label on ${stale:-an unknown number of} rows." >&2
    exit 6
  fi
  echo "proj_imported_desc (partition $p): consistent"
done

echo "Sample parity after the backfill:"
echo "$(parity_sample)"
echo
echo "Distribution (country_tier, rows):"
ch "SELECT country_tier, count() FROM ulp.credentials GROUP BY country_tier ORDER BY country_tier FORMAT TSV"
echo
echo "country_tier is now consistent with the importer's classifier."
echo "Next: bash scripts/purge-existing-t3.sh   (dry run; its audit should now pass or list only real T3 rows)"
