#!/bin/bash
# =============================================================================
# fix-clickhouse-broken-parts.sh
#
# One-shot recovery for the ClickHouse TOO_MANY_UNEXPECTED_DATA_PARTS crash
# caused by the old MV-backfill leaving oversized leftover parts.
#
# Root cause
# ----------
# The old "MV backfill" in lib/clickhouse-migrations.ts ran fire-and-forget
# INSERT ... SELECT ... GROUP BY queries over the 1.46B-row ulp.credentials
# table into ulp.domain_counts, ulp.password_counts, ulp.url_host_counts and
# ulp.reuse_pairs. If the container was OOM-killed or restarted mid-insert,
# ClickHouse left behind part directories that don't match the table's
# committed part list ("unexpected data parts").
#
# On the next startup, ClickHouse tries to quarantine those leftover parts
# into detached/, but refuses when their total size exceeds the
# max_suspicious_broken_parts_bytes safety threshold (default 1.00 GiB),
# and throws instead:
#
#   DB::Exception: Suspiciously big size (N parts, X GiB in total) of all
#   broken parts to remove while maximum allowed broken parts size is
#   1.00 GiB ... Cannot attach table `ulp`.`<table>` ...
#   (TOO_MANY_UNEXPECTED_DATA_PARTS)
#
# This is NOT scoped to one table — it happens during the server's startup
# "load metadata" phase and blocks the ENTIRE ClickHouse server from coming
# up. Consequence: ClickHouse container crash-loops -> /ping never responds
# -> depends_on: service_healthy never satisfied -> app stuck "Starting" ->
# browser shows "fail to load" for every page. Same failure shape as the
# serialization-corruption crash fixed by fix-clickhouse-data.sh.
#
# The fix
# -------
# Plant ClickHouse's built-in force_restore_data flag in the data volume.
# On the next startup, ClickHouse moves ANY size of suspicious/unexpected
# parts into detached/ for ALL affected tables in one pass, regardless of
# the 1 GiB limit, and the flag is consumed (removed) automatically.
#
# DDL v10 (already in lib/clickhouse-migrations.ts) then drops
# ulp.domain_counts, ulp.password_counts, ulp.url_host_counts and
# ulp.reuse_pairs (+ their materialized views) entirely on app startup —
# DROP TABLE removes the whole on-disk directory, detached broken parts
# and all, so no manual disk cleanup is needed afterward.
#
# Ref: https://kb.altinity.com/altinity-kb-setup-and-maintenance/suspiciously-many-broken-parts/
#      https://github.com/clickhouse/clickhouse/issues/87030
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host):
#   bash scripts/fix-clickhouse-broken-parts.sh
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — ClickHouse broken-parts recovery               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Must run from (or find) the project root where docker-compose.yml lives
if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  echo "  Run this from ~/ulp-suite:  bash scripts/fix-clickhouse-broken-parts.sh"
  exit 1
fi

cd "$PROJECT_DIR"

# Step 1 — stop the stack so nothing holds the volume open
echo "Step 1/4  Stopping all containers..."
docker compose down 2>&1 | tail -5
echo "          Done."
echo ""

# Step 2 — plant the force_restore_data flag (run sh instead of clickhouse so
#          the server never starts, but the declared volume is still mounted)
echo "Step 2/4  Planting force_restore_data recovery flag..."
docker compose run --rm --no-deps --entrypoint sh clickhouse -c '
  mkdir -p /var/lib/clickhouse/flags
  touch /var/lib/clickhouse/flags/force_restore_data
  echo "          Done."
' 2>/dev/null
echo ""

# Step 3 — start ClickHouse and wait for it to come up
echo "Step 3/4  Starting ClickHouse..."
docker compose up -d clickhouse
echo ""
echo "          Watching logs for 'Ready for connections' (Ctrl+C to stop watching"
echo "          once you see it — the recovery has already happened by then):"
echo ""
docker compose logs -f clickhouse &
LOGPID=$!
# Poll until healthy, then stop tailing logs
for i in $(seq 1 90); do
  STATUS=$(docker compose ps clickhouse --format '{{.Health}}' 2>/dev/null || echo "")
  if [ "$STATUS" = "healthy" ]; then
    break
  fi
  sleep 5
done
kill "$LOGPID" 2>/dev/null || true
echo ""
if [ "$STATUS" != "healthy" ]; then
  echo "  ⚠  ClickHouse did not report healthy within ~7.5 minutes."
  echo "     Check logs manually:  docker compose logs --tail=200 clickhouse"
  exit 1
fi
echo "          ClickHouse is healthy."
echo ""

# Step 4 — start the app; DDL v10 drops the broken MV tables for good
echo "Step 4/4  Starting app (DDL v10 will drop the broken MV tables)..."
docker compose up -d app
sleep 5
docker compose logs app --tail=100 | grep -i "DDL v10\|ClickHouse migration" || true
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Recovery complete."
echo ""
echo "Verify:"
echo "  docker compose logs app --tail=100 | grep -i 'DDL v10'"
echo "    -> expect: 'DDL v10 applied (dropped stats/reuse MV tables + views)'"
echo ""
echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \\"
echo "    \"SELECT name FROM system.tables WHERE database='ulp' AND name IN"
echo "     ('domain_counts','password_counts','url_host_counts','reuse_pairs',"
echo "      'mv_domain_counts','mv_password_counts','mv_url_host_counts','mv_reuse_pairs')\""
echo "    -> expect: empty (zero rows)"
echo ""
echo "  docker compose ps   # verify status = healthy for both services"
echo "═══════════════════════════════════════════════════════════════"
