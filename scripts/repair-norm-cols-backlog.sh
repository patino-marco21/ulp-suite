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
#   VALUE: HIGH. raw domain='' so the Credentials Browser domain filter
#   (app/api/credentials/route.ts: WHERE domain = {x}, raw column for the
#   bloom-filter index) silently MISSES all 45K. This step materializes the
#   correct domain (extracted from the email-held URL, scheme-aware like
#   NORM_COLS d_url) into raw `domain`, then re-materializes url_host (which
#   derives from domain when url='').
#   NON-LOSSY: url/email/password are left untouched, so url stays '' and
#   NORM_COLS case-D keeps owning the DISPLAY (its login/password
#   reconstruction is imperfect for some sub-shapes and is better left at read
#   time than frozen into storage). Only the unambiguous `domain` is committed.
#   Runs by default.
#
# CASE B  (~196,624 rows: raw url = "XX https://..." country-code prefix)
#   VALUE: COSMETIC. raw domain is ALREADY correct (extractDomain ignored the
#   prefix), so domain= filters already work. Only `url` (display already fixed
#   by NORM_COLS) and url_host / url_scheme carry the prefix. Repairing strips
#   the prefix from raw `url`, then re-materializes url_host, url_scheme, tld
#   and country_tier (its TLD fallback depends on tld). Four full-column
#   rewrites for a cosmetic gain, so OPT-IN:
#       INCLUDE_CASE_B=1 bash scripts/repair-norm-cols-backlog.sh
#
# ── Safety ───────────────────────────────────────────────────────────────────
#   - Idempotent: each repair is gated on a pre-flight count of rows still
#     needing it; a re-run after completion finds 0 and skips.
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
#   bash scripts/repair-norm-cols-backlog.sh                  # case D only
#   INCLUDE_CASE_B=1 bash scripts/repair-norm-cols-backlog.sh # case D + case B
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

did_materialize_urlhost=0
did_materialize_urlcols=0

# ── 1/4  Pre-flight ──────────────────────────────────────────────────────────
echo "═══ 1/4  Pre-flight counts ══════════════════════════════════════"
$CH "$(cat <<'EOSQL'
SELECT
  countIf(url='' AND position(email,'@')=0 AND position(email,'/')>0
          AND lower(left(email,11))!='jsessionid=' AND domain='')  AS case_d_repairable,
  countIf(match(url, '^[A-Za-z]{1,3}\\s+https?://'))               AS case_b_repairable,
  count()                                                          AS total_rows
FROM ulp.credentials
SETTINGS max_execution_time = 300
EOSQL
)" --format Vertical
echo ""

# ── 2/4  Case D: materialize correct domain (always) ─────────────────────────
echo "═══ 2/4  Case D — materialize correct domain (raw column) ═══════"
D_TODO=$($CH "$(cat <<'EOSQL'
SELECT countIf(url='' AND position(email,'@')=0 AND position(email,'/')>0
               AND lower(left(email,11))!='jsessionid=' AND domain='')
FROM ulp.credentials
EOSQL
)" --format TabSeparated)
if [ "${D_TODO:-0}" = "0" ]; then
  echo "No case-D rows with empty domain remain -- skipping."
else
  echo "Repairing $D_TODO case-D rows: domain <- host of the email-held URL"
  echo "(url/email/password left untouched so NORM_COLS keeps the display)."
  # domain(...) of the scheme-aware reconstructed URL; strip a leading 'www.'
  # without regex (startsWith/substring) to match the parser's www handling.
  if ! $CH "$(cat <<'EOSQL'
ALTER TABLE ulp.credentials
UPDATE domain =
  if(startsWith(domain(if(startsWith(lower(email),'http://') OR startsWith(lower(email),'https://'), email, concat('https://',email))), 'www.'),
     substring(domain(if(startsWith(lower(email),'http://') OR startsWith(lower(email),'https://'), email, concat('https://',email))), 5),
     domain(if(startsWith(lower(email),'http://') OR startsWith(lower(email),'https://'), email, concat('https://',email))))
WHERE url='' AND position(email,'@')=0 AND position(email,'/')>0
  AND lower(left(email,11))!='jsessionid=' AND domain=''
SETTINGS mutations_sync = 1
EOSQL
)"; then
    echo "ERROR: case-D domain UPDATE failed. ulp.credentials_old is the backup."
    exit 1
  fi
  did_materialize_urlhost=1
  echo "Done."
fi
echo ""

# ── 3/4  Case B: strip url prefix (opt-in) ───────────────────────────────────
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
    did_materialize_urlhost=1
    did_materialize_urlcols=1
    echo "Done."
  fi
fi
echo ""

# ── 4/4  Re-materialize derived columns + verify ─────────────────────────────
echo "═══ 4/4  Re-materialize derived columns + verify ═══════════════"
materialize_col() {
  local col="$1"
  echo "-- MATERIALIZE COLUMN $col ..."
  if ! $CH "ALTER TABLE ulp.credentials MATERIALIZE COLUMN $col SETTINGS mutations_sync = 1"; then
    echo "ERROR: MATERIALIZE COLUMN $col failed."
    exit 1
  fi
}

if [ "$did_materialize_urlhost" = "1" ]; then
  # url_host derives from url (case B) and from domain when url='' (case D).
  materialize_col url_host
fi
if [ "$did_materialize_urlcols" = "1" ]; then
  # url_scheme + tld derive from url; country_tier's TLD fallback derives from
  # tld -- materialize tld before country_tier.
  materialize_col url_scheme
  materialize_col tld
  materialize_col country_tier
fi
if [ "$did_materialize_urlhost" = "0" ] && [ "$did_materialize_urlcols" = "0" ]; then
  echo "Nothing was repaired -- no columns to re-materialize."
fi
echo ""

echo "-- Verify: remaining repairable rows (expect ~0 for what ran; a small"
echo "   case-D residual is rows whose email yields no extractable host) --"
$CH "$(cat <<'EOSQL'
SELECT
  countIf(url='' AND position(email,'@')=0 AND position(email,'/')>0
          AND lower(left(email,11))!='jsessionid=' AND domain='')  AS case_d_remaining,
  countIf(match(url, '^[A-Za-z]{1,3}\\s+https?://'))               AS case_b_remaining
FROM ulp.credentials
SETTINGS max_execution_time = 300
EOSQL
)" --format Vertical
echo ""

echo "-- Spot-check: 5 repaired case-D rows (url stays '', domain now set) --"
$CH "$(cat <<'EOSQL'
SELECT substring(email,1,50) AS email, domain, url_host
FROM ulp.credentials
WHERE url='' AND position(email,'@')=0 AND position(email,'/')>0
  AND lower(left(email,11))!='jsessionid=' AND domain != ''
LIMIT 5
SETTINGS max_execution_time = 120
EOSQL
)" --format Vertical
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Repair complete. NORM_COLS still owns the DISPLAY for case D (url='')."
echo "Storage now has a correct raw domain (+ url_host) for case-D rows, so"
echo "domain= / url_host= filters find them."
echo "Re-run any time -- the pre-flight gates make it idempotent."
echo "Rollback fallback: ulp.credentials_old (untouched pre-dedup backup)."
echo "═══════════════════════════════════════════════════════════════"
