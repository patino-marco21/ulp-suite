#!/bin/bash
# =============================================================================
# diagnose-credentials-recovery.sh
#
# READ-ONLY diagnostic for the data drop seen after running
# fix-clickhouse-broken-parts.sh (force_restore_data).
#
# Why this exists
# ----------------
# force_restore_data is a GLOBAL, instance-wide flag — it relaxes the
# broken/unexpected-parts check for EVERY table on that startup, not just
# ulp.domain_counts/password_counts/url_host_counts/reuse_pairs. If
# ulp.credentials itself had parts the recovery considered "unexpected"
# (likely a holdover from the earlier 26.4->26.3 CORRUPTED_DATA incident),
# those got moved to detached/ too — which would explain a row count
# collapsing from ~52,339,303 to ~39,213.
#
# detached/ directories are NOT deleted by this process. This script only
# READS system.detached_parts and system.parts to confirm where the data
# went before anything is reattached. Do not run new imports until this
# has been reviewed — reattaching later could create duplicates against
# anything inserted in the meantime.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host):
#   bash scripts/diagnose-credentials-recovery.sh
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — credentials recovery diagnostics (read-only)   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

echo "── 1/5  Current row count, ulp.credentials ─────────────────────"
$CH "SELECT count() AS active_rows FROM ulp.credentials" --format PrettyCompact
echo ""

echo "── 2/5  Active parts for ulp.credentials (on-disk, currently attached) ─"
$CH "
SELECT count() AS active_parts,
       sum(rows) AS active_rows,
       formatReadableSize(sum(bytes_on_disk)) AS active_size
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active
" --format PrettyCompact
echo ""

echo "── 3/5  Detached parts for ulp.credentials, grouped by reason ──"
echo "   (these are NOT deleted — sitting in detached/ on disk)"
$CH "
SELECT reason,
       count() AS parts,
       sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.detached_parts
WHERE database = 'ulp' AND table = 'credentials'
GROUP BY reason
ORDER BY rows DESC
" --format PrettyCompact
echo ""

echo "── 4/5  Detached parts for the other ULP tables (sanity check) ─"
$CH "
SELECT table, reason,
       count() AS parts,
       sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.detached_parts
WHERE database = 'ulp'
GROUP BY table, reason
ORDER BY table, rows DESC
" --format PrettyCompact
echo ""

echo "── 5/5  Recent ClickHouse log lines mentioning restore/detach ──"
docker compose logs clickhouse 2>/dev/null \
  | grep -iE "force_restore_data|Detaching|unexpected|suspicious" \
  | tail -40 || echo "  (no matching log lines found — logs may have rotated)"
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Next: share this output before reattaching anything."
echo ""
echo "If step 3 shows a large 'rows' total for ulp.credentials with"
echo "reason != 'broken' (e.g. 'unexpected', 'ignored', or empty),"
echo "that data is very likely intact and reattachable via:"
echo ""
echo "  ALTER TABLE ulp.credentials ATTACH PART '<part_name>'"
echo ""
echo "Parts with reason = 'broken' should NOT be blindly reattached —"
echo "those need individual review."
echo "═══════════════════════════════════════════════════════════════"
