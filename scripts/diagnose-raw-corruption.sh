#!/bin/bash
# =============================================================================
# diagnose-raw-corruption.sh   (READ-ONLY)
#
# Quantifies the "raw ≠ normalized" rows in ulp.credentials — rows whose stored
# url/email/domain were mis-parsed before the parser was fixed (Cases A–E, see
# the data-repair mutations in lib/clickhouse-migrations.ts). The deduped table
# was rebuilt by INSERT…SELECT and never ran those repairs, so these linger and
# make raw-column filters (domain=, url_host=) + the .php declutter miss them.
#
# This ONLY COUNTS + samples — it changes nothing. Use it to decide whether a
# repair is worth running, and to find which source_files to re-import.
#
#   bash scripts/diagnose-raw-corruption.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"

# Per-case match conditions. Single-quoted heredoc keeps backslashes literal
# (\\s -> ClickHouse unescapes to \s, the form RE2 needs); bash does not
# re-process backslashes from an expanded variable, so interpolating into the
# double-quoted query below is safe. Mirrors the WHERE clauses of the Case A–E
# data-repair mutations in lib/clickhouse-migrations.ts.
A=$(cat <<'EOF'
(url = '' AND lower(left(email,11)) = 'jsessionid=' AND match(password, '^[A-Za-z]{1,3}\\s+https?://'))
EOF
)
B=$(cat <<'EOF'
(match(url, '^[A-Za-z]{1,3}\\s+https?://') AND position(url,'@') = 0)
EOF
)
C=$(cat <<'EOF'
(url IN ('http','https') AND startsWith(email,'//') AND position(email,' ') > 0)
EOF
)
D=$(cat <<'EOF'
(match(email, '^https?://'))
EOF
)
E=$(cat <<'EOF'
(url != '' AND match(url, '^https?://') AND (position(domain(url),'.') = 0 OR length(topLevelDomain(url)) > 6))
EOF
)
ANY="($A OR $B OR $C OR $D OR $E)"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — raw-column corruption report (read-only)       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "═══ 1/3  Rows matching each repair case ═════════════════════════"
$CH "
SELECT
  count() AS total_rows,
  countIf($A) AS case_a_jsessionid,
  countIf($B) AS case_b_cc_prefix,
  countIf($C) AS case_c_scheme_split,
  countIf($D) AS case_d_url_in_email,
  countIf($E) AS case_e_junk_url,
  countIf($ANY) AS any_corrupt,
  round(100.0 * countIf($ANY) / count(), 3) AS pct_corrupt
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format Vertical
echo ""

echo "═══ 2/3  Top source_files among corrupt rows (re-import targets) ═"
$CH "
SELECT source_file, count() AS corrupt_rows
FROM ulp.credentials
WHERE $ANY
GROUP BY source_file ORDER BY corrupt_rows DESC LIMIT 15
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""

echo "═══ 3/3  Sample 10 corrupt rows ═════════════════════════════════"
$CH "
SELECT substring(url,1,30) AS url, substring(email,1,40) AS email, substring(password,1,25) AS password, domain
FROM ulp.credentials WHERE $ANY LIMIT 10
SETTINGS max_execution_time = 120
" --format PrettyCompact
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "If any_corrupt is meaningful, two ways to fix (your call):"
echo ""
echo " A) RE-IMPORT (cleanest) — re-process the source_files above through the"
echo "    fixed parser. Move them back into ./inbox (the watcher re-imports), or"
echo "    re-upload. The current parser fixes Cases A–E at parse time. Then run"
echo "    scripts/dedup-credentials-content.sh to collapse any re-introduced dupes."
echo ""
echo " B) IN-PLACE REPAIR — re-fire the Case A–E ALTER UPDATE mutations, THEN"
echo "    MATERIALIZE the derived columns (url_host, domain, email_domain, tld,"
echo "    country_tier, is_noise, …) — an ALTER UPDATE of base columns does NOT"
echo "    auto-recompute MATERIALIZED columns, so skipping this leaves is_noise /"
echo "    country_tier / url_host stale. Ask and I'll ship a gated script for this."
echo ""
