#!/bin/bash
# =============================================================================
# tier-distribution.sh   (READ-ONLY)
#
# Shows how ulp.credentials breaks down by country tier and country, so you can
# choose an ingest-filter / purge policy (INGEST_FILTER_DROP_TIERS /
# KEEP_SUFFIXES — see lib/ingest-filter.ts) with real numbers in front of you.
#
# Reminder: untiered ('') = no country signal (mostly @gmail/.com users), which
# includes most of your US/UK targets — that's why the filter never tier-drops it.
#
#   bash scripts/tier-distribution.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — tier / country distribution (read-only)        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "═══ 1/3  Rows by country tier ═══════════════════════════════════"
echo "(T1=US/UK/CA/AU/NZ · T2=W.Europe/JP/KR/SG/IL/AE · T3=RU/CN/BR/LATAM/SEA · ''=untiered)"
$CH "
SELECT
  if(country_tier = '', '(untiered)', country_tier) AS tier,
  count() AS rows,
  round(100.0 * count() / (SELECT count() FROM ulp.credentials), 2) AS pct
FROM ulp.credentials
GROUP BY country_tier
ORDER BY rows DESC
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""

echo "═══ 2/3  Top 25 URL TLDs ════════════════════════════════════════"
$CH "
SELECT tld, count() AS rows
FROM ulp.credentials
WHERE tld != ''
GROUP BY tld ORDER BY rows DESC LIMIT 25
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""

echo "═══ 3/3  Top 25 email-domain TLDs ═══════════════════════════════"
$CH "
SELECT arrayElement(splitByChar('.', email_domain), -1) AS email_tld, count() AS rows
FROM ulp.credentials
WHERE email_domain != ''
GROUP BY email_tld ORDER BY rows DESC LIMIT 25
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Use these to set INGEST_FILTER_DROP_TIERS / INGEST_FILTER_KEEP_SUFFIXES,"
echo "then preview the exact impact with: bash scripts/purge-existing-low-tier.sh"
echo ""
