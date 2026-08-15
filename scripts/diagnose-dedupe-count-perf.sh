#!/bin/bash
# =============================================================================
# diagnose-dedupe-count-perf.sh
#
# Verifies the "Unique" dedupe/count filter's performance fix (DDL v18).
#
# The Credentials Browser's default view ("Unique" on) counts distinct
# credentials via uniq() over (normalized url, email, password). It shipped
# as a LIVE double-regex expression evaluated per row with no LIMIT --
# confirmed at 58-63s against 1.48B rows. DDL v18 precomputes it into a
# MATERIALIZED content_key_hash column so the count becomes uniq(content_key_hash)
# instead -- see docs/superpowers/specs/2026-08-15-credentials-dedupe-materialized-key-design.md.
#
# This script is READ-ONLY. It (1) confirms the column + backfill state, and
# (2) TIMES the old inline expression vs the new column to prove the fix.
#
#   bash scripts/diagnose-dedupe-count-perf.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$PROJECT_DIR/docker-compose.yml" ] || { echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  content_key_hash backfill status                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
$CH "SELECT mutation_id, is_done, parts_to_do FROM system.mutations WHERE table = 'credentials' AND command LIKE '%content_key_hash%' ORDER BY create_time DESC LIMIT 5 FORMAT PrettyCompact"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  OLD: live double-regex uniq() over the full table (is_noise=0)║"
echo "╚══════════════════════════════════════════════════════════════╝"
time $CH "
SELECT uniq(replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/\$', ''), email, password) AS total
FROM ulp.credentials
WHERE is_noise = 0
SETTINGS max_execution_time = 300
"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  NEW: uniq() over the materialized content_key_hash column     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
time $CH "
SELECT uniq(content_key_hash) AS total
FROM ulp.credentials
WHERE is_noise = 0
SETTINGS max_execution_time = 300
"

echo ""
echo "Both totals above should match (or be within ~0.5% -- both are the same"
echo "HyperLogLog algorithm, just fed via a live expression vs. a precomputed"
echo "column). The NEW query's wall-clock time is the number that matters --"
echo "it should drop sharply once the backfill (checked above) reaches is_done=1"
echo "for all parts. Before that, rows in not-yet-rewritten parts still compute"
echo "content_key_hash on the fly, so the speedup is partial until backfill completes."
