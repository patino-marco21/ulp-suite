#!/bin/bash
# =============================================================================
# diagnose-noise-rows.sh
#
# Counts and samples the LOW-SIGNAL ("noise") rows that the credential browser's
# default-on "Declutter" toggle hides — the same predicate as lib/ulp-noise.ts:
#
#   - url host is a bare IP address (incl. private/LAN + IP-prefixed corruption)
#   - url carries an explicit :port  (router / Odoo :8069 / cPanel :2083 / …)
#   - url is a generic login script ending in .php  (wp-login.php, …)
#   - host is localhost or *.local
#
# These rows usually contain a REAL email+password, so unlike the binary/mojibake
# garbage handled by diagnose-and-purge-garbage.sh, they are NOT deleted — the UI
# just hides them from view. This script is therefore DIAGNOSE-ONLY: it never
# mutates the table. Use it to (a) see how much the toggle removes and (b) verify
# the predicate is catching junk, not real credentials.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host):
#   bash scripts/diagnose-noise-rows.sh
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

# The NOISE predicate. MUST stay identical to NOISE_PREDICATE in lib/ulp-noise.ts.
# Single-quoted heredoc keeps backslashes literal (two backslashes -> ClickHouse
# unescapes to one, the form RE2 needs). Interpolated into the double-quoted query
# strings below (bash does not re-process backslashes from an expanded variable).
IS_NOISE=$(cat <<'EOF'
(
     isIPv4String(domain)
  OR isIPv6String(domain)
  OR match(domain, '^[0-9]{1,3}(\\.[0-9]{1,3}){3}')
  OR domain = 'localhost'
  OR endsWith(domain, '.local')
  OR port(url) != 0
  OR match(lower(url), '\\.php($|[?#])')
)
EOF
)

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — diagnose noise / low-signal rows (read-only)   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "═══ 1/4  Noise count + share ════════════════════════════════════"
$CH "
SELECT
  count() AS total_rows,
  countIf($IS_NOISE) AS noise_rows,
  round(100.0 * countIf($IS_NOISE) / count(), 3) AS pct_noise
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format Vertical
echo ""

echo "═══ 2/4  Sub-signals (which rule fires) ═════════════════════════"
$CH "
SELECT
  countIf(isIPv4String(domain) OR isIPv6String(domain) OR match(domain, '^[0-9]{1,3}(\\\\.[0-9]{1,3}){3}')) AS ip_host,
  countIf(domain = 'localhost' OR endsWith(domain, '.local'))                                                AS localhost_local,
  countIf(port(url) != 0)                                                                                    AS has_port,
  countIf(match(lower(url), '\\\\.php(\$|[?#])'))                                                             AS php_endpoint
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format Vertical
echo ""

echo "═══ 3/4  Sample 15 rows that get HIDDEN (verify they're noise) ══"
$CH "
SELECT substring(url,1,55) AS url, substring(email,1,30) AS email, domain
FROM ulp.credentials
WHERE $IS_NOISE
LIMIT 15
SETTINGS max_execution_time = 120
" --format PrettyCompact
echo ""

echo "═══ 4/4  False-positive guard — digit-led domains that are KEPT ══"
echo "-- real domains starting with a digit (e.g. 5paisa.com) must NOT be hidden --"
$CH "
SELECT domain, count() AS rows
FROM ulp.credentials
WHERE match(domain, '^[0-9]') AND NOT ($IS_NOISE)
GROUP BY domain
ORDER BY rows DESC
LIMIT 15
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Read-only — nothing was modified. The browser's 'Declutter' toggle"
echo "(on by default) hides exactly these rows; toggle it off to see them."
echo ""
