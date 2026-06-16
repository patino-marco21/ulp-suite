#!/bin/bash
# =============================================================================
# diagnose-noise-rows.sh
#
# Verifies the "Declutter" filter AND its performance fix (DDL v12).
#
# The filter hides low-signal rows (IP-host / :port / .php / localhost URLs — see
# lib/ulp-noise.ts). It was first shipped as an INLINE WHERE predicate of
# non-indexable per-row functions (match/port/isIPv4String) over the wide url
# column; on a broad search that the token index can't prune (e.g. a Ledger-themed
# DB where "ledger" is everywhere) it scanned for ~79 s. DDL v12 precomputes it
# into a MATERIALIZED `is_noise` column so the browser filters on a cheap
# `is_noise = 0` PREWHERE compare instead.
#
# This script is READ-ONLY. It (1) confirms the column + backfill state, (2) TIMES
# the old inline predicate vs the new column to prove the regression + the fix, and
# (3) samples hidden rows + flags any raw-vs-normalized leak.
#
#   bash scripts/diagnose-noise-rows.sh            # search term defaults to "ledger"
#   Q=coinledger bash scripts/diagnose-noise-rows.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
Q="${Q:-ledger}"   # search term to reproduce the real (broad) browse query

# Representative search clause — mirrors lib/ulp-search.ts buildULPWhere() for a
# plain token, the case that barely prunes on a themed DB.
SEARCH="(hasToken(url,'$Q') OR hasToken(email,'$Q') OR hasToken(password,'$Q') OR url_host LIKE '%$Q%' OR email_domain LIKE '%$Q%')"

# OLD inline noise predicate (single-quoted heredoc keeps backslashes literal:
# two backslashes -> ClickHouse unescapes to one, the form RE2 needs).
IS_NOISE_INLINE=$(cat <<'EOF'
(
     isIPv4String(url_host) OR isIPv6String(url_host)
  OR match(url_host, '^[0-9]{1,3}(\\.[0-9]{1,3}){3}')
  OR url_host = 'localhost' OR endsWith(url_host, '.local')
  OR port(url) != 0
  OR match(lower(url), '\\.php($|[?#])')
)
EOF
)

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — Declutter filter + perf verification (read-only)║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Search term Q='$Q'"
echo ""

echo "═══ 1/5  is_noise column present? ═══════════════════════════════"
$CH "SELECT name, type, default_kind, default_expression != '' AS has_expr
     FROM system.columns
     WHERE database='ulp' AND table='credentials' AND name='is_noise'
     SETTINGS max_execution_time=30" --format Vertical
echo "(no row above = DDL v12 hasn't run yet — rebuild the app: docker compose up -d --build)"
echo ""

echo "═══ 2/5  MATERIALIZE COLUMN backfill status (speedup needs is_done=1) ══"
$CH "SELECT mutation_id, is_done, parts_to_do, latest_fail_reason
     FROM system.mutations
     WHERE database='ulp' AND table='credentials' AND command LIKE '%is_noise%'
     ORDER BY create_time DESC LIMIT 5
     SETTINGS max_execution_time=30" --format PrettyCompact
echo "(parts_to_do=0 / is_done=1 → backfilled; until then is_noise is computed on the fly = still slow)"
echo ""

echo "═══ 3/5  Noise share ════════════════════════════════════════════"
$CH "SELECT count() AS total_rows,
            countIf(is_noise = 1) AS noise_rows,
            round(100.0 * countIf(is_noise = 1) / count(), 3) AS pct_noise
     FROM ulp.credentials
     SETTINGS max_execution_time=300" --format Vertical
echo ""

echo "═══ 4/5  TIMED: old inline predicate  vs  new is_noise column ═══"
echo "-- both run the same Q='$Q' search + sort + limit; compare elapsed --"
echo "--- A) OLD inline predicate (the regression) ---"
$CH "SELECT count() FROM (
       SELECT 1 FROM ulp.credentials
       WHERE $SEARCH AND NOT $IS_NOISE_INLINE
       ORDER BY imported_at DESC LIMIT 50
     ) SETTINGS max_execution_time=300" --format Null --time
echo "--- B) NEW is_noise = 0 column (the fix) ---"
$CH "SELECT count() FROM (
       SELECT 1 FROM ulp.credentials
       WHERE $SEARCH AND is_noise = 0
       ORDER BY imported_at DESC LIMIT 50
     ) SETTINGS max_execution_time=300" --format Null --time
echo "(B should be dramatically faster than A once §2 shows the backfill is done)"
echo ""

echo "═══ 5/5  Sample hidden rows + raw-vs-normalized leak check ══════"
echo "-- 10 rows the filter hides (is_noise=1) --"
$CH "SELECT substring(url,1,55) AS url, url_host, substring(email,1,28) AS email
     FROM ulp.credentials WHERE is_noise = 1 LIMIT 10
     SETTINGS max_execution_time=120" --format PrettyCompact
echo ""
echo "-- LEAK: rows whose RAW url ends in .php but is_noise=0 (raw≠normalized; should be small) --"
$CH "SELECT count() AS php_leak_rows
     FROM ulp.credentials
     WHERE is_noise = 0 AND match(lower(url), '\\\\.php(\$|[?#])')
     SETTINGS max_execution_time=300" --format Vertical
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Read-only — nothing modified. The browser 'Declutter' toggle (on by"
echo "default) filters is_noise = 0; toggle off to see every row."
echo ""
