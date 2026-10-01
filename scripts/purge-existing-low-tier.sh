#!/bin/bash
# =============================================================================
# purge-existing-low-tier.sh
#
# Removes EXISTING low-tier rows from ulp.credentials — the backlog the ingest
# tier filter (lib/ingest-filter.ts) only blocks going FORWARD. Uses the SAME
# policy so they stay in lockstep: set INGEST_FILTER_DROP_TIERS /
# INGEST_FILTER_DROP_SUFFIXES once (in .env), then the filter blocks new imports
# and this clears what's already stored.
#
# Deletes via the stored, indexed columns (country_tier / email_domain / tld). Those
# are a SQL copy of classifyTier() and the copy has DRIFTED (on 2026-10-01 1.9M rows
# were stored as T3 that the importer calls untiered, T1 or T2), so no row is deleted
# on the stored columns alone: every candidate is first replayed through the importer's
# own policy (scripts/audit-purge-candidates.ts, lib/purge-audit.ts), and if the
# importer would have kept even one of them nothing is deleted (exit 3). The audit
# also runs in the dry run and needs `npm ci` (tsx) in this checkout. The DELETE is a
# race-safe background mutation (concurrent inserts are never lost).
#
# Config (read from env, else from ./.env, else the TIERS=/SUFFIXES= overrides):
#   INGEST_FILTER_DROP_TIERS     e.g. "T3"  or  "T2,T3"
#   INGEST_FILTER_DROP_SUFFIXES  e.g. ".pt,.gr,.il,.ae"   (your "lower T2" picks)
#
# DRY-RUN by default (counts + per-tier breakdown + sample; deletes nothing).
# Set APPLY=1 to fire the delete.
#
#   bash scripts/purge-existing-low-tier.sh                        # dry-run (safe)
#   INGEST_FILTER_DROP_TIERS=T3 bash scripts/purge-existing-low-tier.sh
#   APPLY=1 bash scripts/purge-existing-low-tier.sh                # delete
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
APPLY="${APPLY:-0}"
TSX_BIN="${TSX_BIN:-$PROJECT_DIR/node_modules/.bin/tsx}"

# ── Resolve policy: explicit env → INGEST_FILTER_* → ./.env file ──────────────
TIERS_RAW="${INGEST_FILTER_DROP_TIERS:-${TIERS:-}}"
SUFFIXES_RAW="${INGEST_FILTER_DROP_SUFFIXES:-${SUFFIXES:-}}"
KEEP_RAW="${INGEST_FILTER_KEEP_SUFFIXES:-${KEEP:-}}"
if [ -z "$TIERS_RAW" ] && [ -z "$SUFFIXES_RAW" ] && [ -f .env ]; then
  TIERS_RAW=$(grep -E '^INGEST_FILTER_DROP_TIERS=' .env | tail -1 | cut -d= -f2- | tr -d "\"' ")
  SUFFIXES_RAW=$(grep -E '^INGEST_FILTER_DROP_SUFFIXES=' .env | tail -1 | cut -d= -f2- | tr -d "\"' ")
fi
if [ -z "$KEEP_RAW" ] && [ -f .env ]; then
  KEEP_RAW=$(grep -E '^INGEST_FILTER_KEEP_SUFFIXES=' .env | tail -1 | cut -d= -f2- | tr -d "\"' ")
fi

# ── Build the WHERE predicate (mirrors shouldDropAtIngest) ───────────────────
TIER_CLAUSE=""
if [ -n "$TIERS_RAW" ]; then
  TIER_LIST=""
  IFS=',' read -ra TARR <<< "$TIERS_RAW"
  for t in "${TARR[@]}"; do
    t=$(echo "$t" | tr -d ' ' | tr '[:lower:]' '[:upper:]')
    case "$t" in T1|T2|T3) TIER_LIST="${TIER_LIST:+$TIER_LIST,}'$t'";; esac
  done
  [ -n "$TIER_LIST" ] && TIER_CLAUSE="country_tier IN ($TIER_LIST)"
fi

SUF_CLAUSE=""
if [ -n "$SUFFIXES_RAW" ]; then
  IFS=',' read -ra SARR <<< "$SUFFIXES_RAW"
  for s in "${SARR[@]}"; do
    s=$(echo "$s" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
    [ -z "$s" ] && continue
    case "$s" in .*) suf="$s";; *) suf=".$s";; esac
    tld="${suf#.}"
    cond="endsWith(email_domain, '$suf') OR tld = '$tld'"
    SUF_CLAUSE="${SUF_CLAUSE:+$SUF_CLAUSE OR }$cond"
  done
fi

PRED=""
[ -n "$TIER_CLAUSE" ] && PRED="$TIER_CLAUSE"
[ -n "$SUF_CLAUSE" ]  && PRED="${PRED:+$PRED OR }($SUF_CLAUSE)"
if [ -z "$PRED" ]; then
  echo "ERROR: nothing configured to purge."
  echo "Set INGEST_FILTER_DROP_TIERS and/or INGEST_FILTER_DROP_SUFFIXES (env or .env)."
  exit 1
fi

# Keep-override (mirrors INGEST_FILTER_KEEP_SUFFIXES): never purge these countries,
# even if their tier/suffix is dropped. Wraps the drop predicate as (drop) AND NOT (keep).
KEEP_CLAUSE=""
if [ -n "$KEEP_RAW" ]; then
  IFS=',' read -ra KARR <<< "$KEEP_RAW"
  for s in "${KARR[@]}"; do
    s=$(echo "$s" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
    [ -z "$s" ] && continue
    case "$s" in .*) suf="$s";; *) suf=".$s";; esac
    tld="${suf#.}"
    cond="endsWith(email_domain, '$suf') OR tld = '$tld'"
    KEEP_CLAUSE="${KEEP_CLAUSE:+$KEEP_CLAUSE OR }$cond"
  done
fi
[ -n "$KEEP_CLAUSE" ] && PRED="($PRED) AND NOT ($KEEP_CLAUSE)"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — purge EXISTING low-tier rows                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "APPLY=$APPLY  (0 = dry-run)"
echo "DROP_TIERS    = ${TIERS_RAW:-(none)}"
echo "DROP_SUFFIXES = ${SUFFIXES_RAW:-(none)}"
echo "KEEP_SUFFIXES = ${KEEP_RAW:-(none)}"
echo "WHERE $PRED"
echo ""

echo "═══ 1/4  How many rows match ════════════════════════════════════"
$CH "
SELECT count() AS total_rows,
       countIf($PRED) AS to_delete,
       round(100.0 * countIf($PRED) / count(), 2) AS pct
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format Vertical
echo ""
echo "-- breakdown by tier among matches --"
$CH "
SELECT country_tier, count() AS rows
FROM ulp.credentials WHERE $PRED
GROUP BY country_tier ORDER BY rows DESC
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""

echo "═══ 2/4  Sample 15 rows that WOULD be deleted (verify) ══════════"
$CH "
SELECT substring(url,1,45) AS url, substring(email,1,28) AS email, country_tier, tld
FROM ulp.credentials WHERE $PRED LIMIT 15
SETTINGS max_execution_time = 120
" --format PrettyCompact
echo ""

echo "═══ 3/4  Label audit (the importer must agree with every row) ═══"
audit_report=""
audit_rc=0
if [ ! -x "$TSX_BIN" ]; then
  audit_rc=127
  echo "Label audit: cannot run; $TSX_BIN is missing (run 'npm ci' in $PROJECT_DIR)."
else
  audit_report="$($CH "SELECT email, url FROM ulp.credentials WHERE $PRED SETTINGS max_threads = 4 FORMAT TSV" |
    INGEST_FILTER_HARD_DROP_TIERS= INGEST_FILTER_DROP_NOISE= \
    INGEST_FILTER_DROP_TIERS="$TIERS_RAW" INGEST_FILTER_DROP_SUFFIXES="$SUFFIXES_RAW" INGEST_FILTER_KEEP_SUFFIXES="$KEEP_RAW" \
    "$TSX_BIN" "$SCRIPT_DIR/audit-purge-candidates.ts")"
  audit_rc=$?
fi
[ -n "$audit_report" ] && echo "$audit_report"
audited="$(sed -n 's/^audit-result: checked=\([0-9]*\) .*/\1/p' <<<"$audit_report")"
echo ""

echo "═══ 4/4  Delete ═════════════════════════════════════════════════"
if [ "$APPLY" != "1" ]; then
  if [ "$audit_rc" != "0" ]; then
    echo "BLOCKED: APPLY=1 would refuse to delete anything (the label audit did not pass, exit $audit_rc)."
    echo "The stored country_tier / tld / email_domain disagree with the importer's own rules; see README, \"Purge safety gate\"."
    echo ""
  fi
  echo "Dry-run. Review the count + sample above. To delete:"
  echo "  APPLY=1 INGEST_FILTER_DROP_TIERS='${TIERS_RAW}' INGEST_FILTER_DROP_SUFFIXES='${SUFFIXES_RAW}' INGEST_FILTER_KEEP_SUFFIXES='${KEEP_RAW}' bash scripts/purge-existing-low-tier.sh"
else
  if [ "$audit_rc" != "0" ]; then
    echo "ERROR: refusing to purge: the label audit did not pass (exit $audit_rc); nothing was deleted."
    echo "The stored country_tier / tld / email_domain disagree with the importer's own rules; see README, \"Purge safety gate\"."
    exit 3
  fi
  candidates_now="$($CH "SELECT count() AS candidate_rows FROM ulp.credentials WHERE $PRED FORMAT TSVRaw")"
  if [ "$candidates_now" != "$audited" ]; then
    echo "ERROR: the candidate set changed while it was being audited ($audited audited, $candidates_now now); rerun."
    exit 3
  fi
  echo "Firing ALTER TABLE ulp.credentials DELETE WHERE <policy> (async mutation)..."
  if ! $CH "ALTER TABLE ulp.credentials DELETE WHERE $PRED SETTINGS mutations_sync = 0"; then
    echo "ERROR: DELETE mutation failed to submit."
    exit 1
  fi
  echo "Submitted. Monitor:"
  echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \\"
  echo "    \"SELECT mutation_id, is_done, parts_to_do FROM system.mutations"
  echo "     WHERE database='ulp' AND table='credentials' AND NOT is_done\""
  echo "Then re-run this script (dry-run) to watch to_delete fall toward 0."
fi
echo ""
echo "═══════════════════════════════════════════════════════════════"
