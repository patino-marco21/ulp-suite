#!/bin/bash
# =============================================================================
# diagnose-norm-cols-coverage.sh
#
# READ-ONLY. Characterizes the ~245K rows in ulp.credentials whose RAW columns
# still trip the NORM_COLS read-time repair logic (lib/ulp-normalize.ts cases
# A-D), found by diagnose-scale-readiness.sh §7 on 2026-06-14:
#
#     case_a_jsessionid   =   2,984
#     case_b_cc_prefix    = 196,624
#     case_c_scheme_split =       0
#     case_d_monster      =  45,529
#                           ~245,137 rows (1.2% of 20,315,675)
#
# WHY THIS MATTERS (the bug this digs into):
#   app/api/credentials/route.ts:95 and lib/cursor-pagination.ts both assert
#   "all data-repair mutations are done -- raw columns match normalized values
#   for all rows." §7 shows that's false for ~245K rows. NORM_COLS rewrites the
#   DISPLAY (SELECT list) for these rows, but every RAW-column operation does
#   NOT see the repair:
#     - WHERE domain = {x}      (route.ts:97)   -> raw domain, wrong for these
#     - WHERE url_host = {x}    (route.ts:100)
#     - WHERE email_domain = {x}(route.ts:101)
#     - ORDER BY ... domain/email/url (SORT_MAP) -> sorts on raw, not display
#     - cursor compare (buildCursorWhere)        -> raw vs displayed mismatch
#   So a domain/host filter can silently MISS these rows, and pagination can
#   order them by their corrupt raw values. NORM_COLS papers over the display
#   only.
#
#   diagnose-scale-readiness.sh §6 also showed ulp.credentials has ZERO
#   data-repair mutations (only the projection one), while credentials_old has
#   100. So the dedup'd `credentials` table most likely never received the
#   case A-D repair UPDATEs -- this script checks that hypothesis directly.
#
# This script answers, read-only, before any fix is chosen:
#   1. Re-count cases A-D + overlap (rows matching >1 case) + % of table.
#   2. Per case: sample raw url/email/password/domain SIDE BY SIDE with what
#      NORM_COLS would display -- visual proof the raw storage is corrupt and
#      the repair changes it.
#   3. Affected rows by source_file (top 15) and by import month -- tells us
#      whether this is old backlog (repair missed) or the parser is STILL
#      producing these rows on new imports.
#   4. Raw-column filter impact: for case_b (cc_prefix) rows, the distribution
#      of raw `domain` -- shows how badly domain= filters are degraded.
#   5. Cross-check vs credentials_old: do the same conditions match there, and
#      at what count -- if far lower, the OLD table was repaired and the dedup
#      dropped the repair; if similar, neither table was ever repaired.
#
# NO FIX applied. Once this evidence is in, the fix is one of:
#   (a) ALTER TABLE ulp.credentials UPDATE ... for cases A-D (materialize the
#       NORM_COLS logic into raw columns; then NORM_COLS truly becomes a no-op
#       and can be removed), or
#   (b) re-import the affected source_files with the current (fixed) parser, or
#   (c) accept NORM_COLS as permanent and fix the RAW-column filter paths to
#       use the NORM_*_EXPR expressions (slower, but correct).
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host):
#   bash scripts/diagnose-norm-cols-coverage.sh
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
REPORT="/tmp/ulp-diagnose-norm-cols-$(date +%Y%m%d-%H%M%S).txt"
exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — NORM_COLS raw-column coverage (read-only)      ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/5  Re-count cases A-D + overlap + % of table ════════════════"
$CH "$(cat <<'EOSQL'
SELECT
  count() AS total_rows,
  countIf(lower(left(email,11))='jsessionid=') AS case_a,
  countIf(match(url,'^[A-Za-z]{1,3}\\s+https?://')) AS case_b,
  countIf(url IN ('http','https') AND startsWith(email,'//') AND position(email,' ')>0) AS case_c,
  countIf(url='' AND NOT position(email,'@')>0 AND position(email,'/')>0 AND lower(left(email,11))!='jsessionid=') AS case_d,
  countIf(
    (lower(left(email,11))='jsessionid=')
    OR match(url,'^[A-Za-z]{1,3}\\s+https?://')
    OR (url IN ('http','https') AND startsWith(email,'//') AND position(email,' ')>0)
    OR (url='' AND NOT position(email,'@')>0 AND position(email,'/')>0 AND lower(left(email,11))!='jsessionid=')
  ) AS any_case,
  round(100.0 * any_case / total_rows, 3) AS pct_of_table
FROM ulp.credentials
SETTINGS max_execution_time = 300
EOSQL
)" --format Vertical
echo ""

echo "═══ 2/5  Per-case: RAW columns vs. what NORM_COLS would display ════"
echo "(If raw and norm differ, the row is genuinely corrupt in storage and"
echo " every raw-column filter/sort/cursor sees the corrupt value.)"
echo ""
echo "-- Case A (jsessionid): raw email holds the whole token; norm splits it --"
$CH "$(cat <<'EOSQL'
SELECT
  substring(url,1,40)      AS raw_url,
  substring(email,1,50)    AS raw_email,
  substring(password,1,40) AS raw_password,
  domain                   AS raw_domain,
  substring(arrayElement(splitByChar(':',email),-2),1,40) AS norm_email,
  substring(trimLeft(replaceRegexpOne(password,'^[A-Za-z]{1,3}\\s+','')),1,40) AS norm_url
FROM ulp.credentials
WHERE lower(left(email,11))='jsessionid='
LIMIT 5
SETTINGS max_execution_time = 120
EOSQL
)" --format Vertical
echo ""
echo "-- Case B (cc_prefix): raw url has a 'XX ' country-code prefix; norm strips it --"
$CH "$(cat <<'EOSQL'
SELECT
  substring(url,1,50)   AS raw_url,
  domain                AS raw_domain,
  substring(trimLeft(replaceRegexpOne(url,'^[A-Za-z]{1,3}\\s+','')),1,50) AS norm_url,
  replaceRegexpOne(domain(trimLeft(replaceRegexpOne(url,'^[A-Za-z]{1,3}\\s+',''))),'^www\\.','') AS norm_domain
FROM ulp.credentials
WHERE match(url,'^[A-Za-z]{1,3}\\s+https?://')
LIMIT 5
SETTINGS max_execution_time = 120
EOSQL
)" --format Vertical
echo ""
echo "-- Case D (monster blank-first-tab): raw url empty, email holds URL, password holds creds --"
$CH "$(cat <<'EOSQL'
SELECT
  url                      AS raw_url,
  substring(email,1,50)    AS raw_email,
  substring(password,1,50) AS raw_password,
  domain                   AS raw_domain
FROM ulp.credentials
WHERE url='' AND NOT position(email,'@')>0 AND position(email,'/')>0 AND lower(left(email,11))!='jsessionid='
LIMIT 5
SETTINGS max_execution_time = 120
EOSQL
)" --format Vertical
echo ""

echo "═══ 3/5  Affected rows: by source_file and by import month ════════"
echo "(Recent months => parser STILL producing these. Old only => repair"
echo " backlog the dedup'd table never received.)"
echo "-- Top 15 source_files among affected rows --"
$CH "$(cat <<'EOSQL'
SELECT source_file, count() AS affected
FROM ulp.credentials
WHERE (lower(left(email,11))='jsessionid=')
   OR match(url,'^[A-Za-z]{1,3}\\s+https?://')
   OR (url IN ('http','https') AND startsWith(email,'//') AND position(email,' ')>0)
   OR (url='' AND NOT position(email,'@')>0 AND position(email,'/')>0 AND lower(left(email,11))!='jsessionid=')
GROUP BY source_file
ORDER BY affected DESC
LIMIT 15
SETTINGS max_execution_time = 300
EOSQL
)" --format PrettyCompact
echo ""
echo "-- Affected rows by import month --"
$CH "$(cat <<'EOSQL'
SELECT toYYYYMM(imported_at) AS month, count() AS affected
FROM ulp.credentials
WHERE (lower(left(email,11))='jsessionid=')
   OR match(url,'^[A-Za-z]{1,3}\\s+https?://')
   OR (url IN ('http','https') AND startsWith(email,'//') AND position(email,' ')>0)
   OR (url='' AND NOT position(email,'@')>0 AND position(email,'/')>0 AND lower(left(email,11))!='jsessionid=')
GROUP BY month
ORDER BY month
SETTINGS max_execution_time = 300
EOSQL
)" --format PrettyCompact
echo ""

echo "═══ 4/5  Raw-column filter impact (case_b -> raw domain) ══════════"
echo "(These rows' raw \`domain\` is what WHERE domain={x} / domain sort use."
echo " If it's blank/garbage, domain filters silently miss them.)"
$CH "$(cat <<'EOSQL'
SELECT
  multiIf(domain='', '(empty)', domain IN ('http','https'), '(scheme-only)', 'other') AS raw_domain_class,
  count() AS rows
FROM ulp.credentials
WHERE match(url,'^[A-Za-z]{1,3}\\s+https?://')
GROUP BY raw_domain_class
ORDER BY rows DESC
SETTINGS max_execution_time = 300
EOSQL
)" --format PrettyCompact
echo ""

echo "═══ 5/5  Cross-check: same conditions in credentials_old ══════════"
echo "(If credentials_old's counts are far LOWER, the old table WAS repaired"
echo " and the dedup dropped the repair. If similar, neither was repaired.)"
$CH "$(cat <<'EOSQL'
SELECT
  'credentials'     AS tbl,
  countIf(lower(left(email,11))='jsessionid=') AS case_a,
  countIf(match(url,'^[A-Za-z]{1,3}\\s+https?://')) AS case_b,
  countIf(url='' AND NOT position(email,'@')>0 AND position(email,'/')>0 AND lower(left(email,11))!='jsessionid=') AS case_d
FROM ulp.credentials
UNION ALL
SELECT
  'credentials_old' AS tbl,
  countIf(lower(left(email,11))='jsessionid=') AS case_a,
  countIf(match(url,'^[A-Za-z]{1,3}\\s+https?://')) AS case_b,
  countIf(url='' AND NOT position(email,'@')>0 AND position(email,'/')>0 AND lower(left(email,11))!='jsessionid=') AS case_d
FROM ulp.credentials_old
SETTINGS max_execution_time = 300
EOSQL
)" --format PrettyCompact
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report: $REPORT"
echo ""
echo "Read this to decide the fix:"
echo "  - §2 differing raw-vs-norm confirms raw storage is corrupt (not a"
echo "    false-positive condition match)."
echo "  - §3 recent months => fix the parser too, not just a one-off repair."
echo "  - §4 shows how many domain filters are currently broken for case_b."
echo "  - §5 tells us whether the repair existed and the dedup dropped it"
echo "    (=> re-run the repair UPDATEs on credentials) or never existed."
echo "Then: ALTER TABLE ulp.credentials UPDATE for cases A-D, OR re-import the"
echo "affected source_files, OR make raw-column filters use NORM_*_EXPR."
echo "No action taken by this script."
echo "═══════════════════════════════════════════════════════════════"
