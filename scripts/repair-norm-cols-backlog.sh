#!/bin/bash
# =============================================================================
# repair-norm-cols-backlog.sh
#
# One-time, in-place repair of the legacy NORM_COLS backlog in ulp.credentials
# found by diagnose-norm-cols-coverage.sh (2026-06-14). The PARSER is already
# fixed (commit d5b0615 case-B prefix strip; the monster shapes are handled or
# rejected -- see ulp-parser.test.ts), so NO NEW rows of these shapes are
# created; this only repairs the existing backlog. NORM_COLS already repairs
# DISPLAY at read time (commits 3a71391, 2e71277) -- this script fixes the RAW
# columns so the index-backed filters (domain=, url_host=, url_scheme=) also
# find these rows, which read-time NORM cannot help with.
#
# ── What gets repaired ───────────────────────────────────────────────────────
#
# CASE D  (~45,529 rows: url='' with the URL living in the email column)
#   raw domain='' so the Credentials Browser domain filter misses them. The
#   correct fix is to materialize the right domain into raw `domain` -- BUT
#   `domain` is the first column of ORDER BY (domain, email, imported_at), and
#   ClickHouse refuses ALTER UPDATE on a sorting-key column (Code: 420,
#   CANNOT_UPDATE_COLUMN -- confirmed on the live table 2026-06-14). So case D
#   CANNOT be repaired in place. The only way to correct a key column is a full
#   table rewrite (INSERT ... SELECT into a new table with the corrected domain,
#   then RENAME swap -- the same pattern as fix-credentials-duplicates.sh).
#   That is a 20.3M-row rewrite for a 0.22% filterability gain on rows that are
#   ALREADY display-correct (NORM_COLS) and monitor-matchable (NORM_DOMAIN_EXPR
#   in domain-monitor/monitor-rescan WHERE). Recommendation: LEAVE case D as-is
#   unless a table rewrite is happening anyway for another reason, in which case
#   fold the domain fix into that pass. This script therefore does NOT touch
#   case D (it only reports the count).
#
# CASE B  (~196,624 rows: raw url = "XX https://..." country-code prefix)
#   VALUE: COSMETIC. raw domain is ALREADY correct (extractDomain ignored the
#   prefix), so domain= filters already work. Only `url` (display already fixed
#   by NORM_COLS) and url_host / url_scheme carry the prefix. `url` is NOT a key
#   column, so an in-place ALTER UPDATE works. Repairing strips the prefix from
#   raw `url`, then re-materializes url_host, url_scheme, tld and country_tier
#   (its TLD fallback depends on tld). Four full-column rewrites for a cosmetic
#   gain, so OPT-IN:
#       INCLUDE_CASE_B=1 bash scripts/repair-norm-cols-backlog.sh
#   The default run does nothing but the pre-flight report.
#
# ── Safety ───────────────────────────────────────────────────────────────────
#   - Idempotent: the case-B repair is gated on a pre-flight count; a re-run
#     after completion finds 0 and skips.
#   - mutations_sync=1: every ALTER blocks until finished -- visible, ordered.
#   - Rollback: ALTER UPDATE is not transactional, BUT ulp.credentials_old (the
#     untouched pre-dedup backup, 35.28M rows) is the fallback if anything looks
#     wrong. (Drop it separately later, once trusted, to reclaim 719 MiB.)
#   - Cost: MATERIALIZE COLUMN rewrites that column across all parts (~20.3M
#     rows / 499 MiB compressed) -- expect seconds-to-minutes each.
#
# All SQL uses single-quoted heredocs (literal; two-backslash regex escaping,
# the form that ClickHouse unescapes to one backslash -- verified against the
# diagnostics). No regex is used where a plain function is clearer.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/repair-norm-cols-backlog.sh                  # report only
#   INCLUDE_CASE_B=1 bash scripts/repair-norm-cols-backlog.sh # + case-B url fix
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
INCLUDE_CASE_B="${INCLUDE_CASE_B:-0}"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — repair NORM_COLS raw-column backlog            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Case B (cosmetic url/url_host/url_scheme): INCLUDE_CASE_B=$INCLUDE_CASE_B"
echo ""

did_caseB=0

# ── 1/4  Pre-flight ──────────────────────────────────────────────────────────
echo "═══ 1/4  Pre-flight counts ══════════════════════════════════════"
$CH "$(cat <<'EOSQL'
SELECT
  countIf(url='' AND position(email,'@')=0 AND position(email,'/')>0
          AND lower(left(email,11))!='jsessionid=' AND domain='')  AS case_d_not_repairable_in_place,
  countIf(match(url, '^[A-Za-z]{1,3}\\s+https?://'))               AS case_b_repairable,
  count()                                                          AS total_rows
FROM ulp.credentials
SETTINGS max_execution_time = 300
EOSQL
)" --format Vertical
echo ""

# ── 2/4  Case D: cannot be repaired in place (domain is a key column) ─────────
echo "═══ 2/4  Case D — NOT repaired (domain is an ORDER BY key column) ═"
echo 'ClickHouse refuses ALTER UPDATE on domain (first column of ORDER BY'
echo '(domain, email, imported_at)) -- Code: 420, CANNOT_UPDATE_COLUMN.'
echo 'Fixing it needs a full table rewrite (INSERT ... SELECT + RENAME swap),'
echo 'a 20.3M-row operation for a 0.22% filterability gain on rows that are'
echo 'already display-correct (NORM_COLS) and monitor-matchable. Left as-is by'
echo 'design; fold the domain fix into a table rewrite only if one happens for'
echo 'another reason. No change made here.'
echo ""

# ── 3/4  Case B: strip url prefix (opt-in; url is not a key column) ───────────
echo "═══ 3/4  Case B — strip country-code url prefix (opt-in) ════════"
if [ "$INCLUDE_CASE_B" != "1" ]; then
  echo "INCLUDE_CASE_B != 1 -- skipping (cosmetic; raw domain already correct)."
else
  B_TODO=$($CH "$(cat <<'EOSQL'
SELECT countIf(match(url, '^[A-Za-z]{1,3}\\s+https?://')) FROM ulp.credentials
EOSQL
)" --format TabSeparated)
  if [ "${B_TODO:-0}" = "0" ]; then
    echo "No case-B prefixed urls remain -- skipping."
  else
    echo "Stripping the prefix from $B_TODO case-B urls."
    # Non-regex strip: take the url from the first 'http' onward, which drops
    # any "XX " country-code prefix. Matched rows always contain a scheme.
    if ! $CH "$(cat <<'EOSQL'
ALTER TABLE ulp.credentials
UPDATE url = substring(url, position(url, 'http'))
WHERE match(url, '^[A-Za-z]{1,3}\\s+https?://')
SETTINGS mutations_sync = 1
EOSQL
)"; then
      echo "ERROR: case-B url UPDATE failed. ulp.credentials_old is the backup."
      exit 1
    fi
    did_caseB=1
    echo "Done."
  fi
fi
echo ""

# ── 4/4  Re-materialize url-derived columns + verify ─────────────────────────
echo "═══ 4/4  Re-materialize derived columns + verify ═══════════════"
materialize_col() {
  local col="$1"
  echo "-- MATERIALIZE COLUMN $col ..."
  if ! $CH "ALTER TABLE ulp.credentials MATERIALIZE COLUMN $col SETTINGS mutations_sync = 1"; then
    echo "ERROR: MATERIALIZE COLUMN $col failed."
    exit 1
  fi
}

if [ "$did_caseB" = "1" ]; then
  # All four derive from url (directly, or via tld for country_tier's fallback).
  # Materialize tld before country_tier.
  materialize_col url_host
  materialize_col url_scheme
  materialize_col tld
  materialize_col country_tier
else
  echo "Nothing was repaired -- no columns to re-materialize."
fi
echo ""

echo "-- Verify: case-B rows remaining (expect 0 if case B ran; case D is"
echo "   unchanged by design and its count is informational) --"
$CH "$(cat <<'EOSQL'
SELECT
  countIf(match(url, '^[A-Za-z]{1,3}\\s+https?://'))               AS case_b_remaining,
  countIf(url='' AND position(email,'@')=0 AND position(email,'/')>0
          AND lower(left(email,11))!='jsessionid=' AND domain='')  AS case_d_unchanged
FROM ulp.credentials
SETTINGS max_execution_time = 300
EOSQL
)" --format Vertical
echo ""

echo "═══════════════════════════════════════════════════════════════"
if [ "$did_caseB" = "1" ]; then
  echo "Case-B url prefix stripped + url_host/url_scheme/tld/country_tier"
  echo "re-materialized. case_b_remaining above should be 0."
else
  echo "No changes made (case D is not repairable in place; case B is opt-in"
  echo "via INCLUDE_CASE_B=1)."
fi
echo "Case D is unchanged by design -- NORM_COLS still owns its display and the"
echo "domain monitors still match it; only the raw domain= filter misses it."
echo "Rollback fallback: ulp.credentials_old (untouched pre-dedup backup)."
echo "═══════════════════════════════════════════════════════════════"
