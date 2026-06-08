#!/bin/bash
# =============================================================================
# fix-clickhouse-data.sh
#
# One-shot recovery for the ClickHouse CORRUPTED_DATA crash caused by a partial
# ClickHouse 26.4 format upgrade.
#
# Root cause
# ----------
# ClickHouse 26.4 introduced a new on-disk format for per-part serialization
# metadata (serialization.json, version 1).  When the 26.4 server was stopped
# mid-upgrade (OOM-kill or Ctrl+C), it left some data parts with version-1
# files alongside version-0 parts.  ClickHouse 26.3 cannot read version-1
# files and crashes immediately with:
#
#   DB::Exception: Unknown version of serialization infos (1).
#                  Should be less or equal than 0.  (CORRUPTED_DATA)
#
# Consequence: ClickHouse container crash-loops → /ping never responds →
# depends_on: service_healthy never satisfied → app stuck in "Starting" →
# browser shows "fail to load" for every page.
#
# The fix
# -------
# Delete all serialization.json and serialization_infos.txt files.
# ClickHouse regenerates them from the actual binary column data on next start.
# NO data is lost — these files are regenerable metadata only.
#
# Ref: https://github.com/ClickHouse/ClickHouse/issues/103398
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host):
#   bash scripts/fix-clickhouse-data.sh
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — ClickHouse serialization-corruption recovery   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Must run from (or find) the project root where docker-compose.yml lives
if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  echo "  Run this from ~/ulp-suite:  bash scripts/fix-clickhouse-data.sh"
  exit 1
fi

cd "$PROJECT_DIR"

# Step 1 — stop the stack so nothing holds the volume open
echo "Step 1/5  Stopping all containers..."
docker compose down 2>&1 | tail -5
echo "          Done."
echo ""

# Step 2 — count corrupted files (run sh instead of clickhouse so the server
#          never starts, but all declared volumes are still mounted)
echo "Step 2/5  Scanning ClickHouse data volume..."
CORRUPTED=$(docker compose run --rm --no-deps --entrypoint sh clickhouse \
  -c 'find /var/lib/clickhouse -name "serialization.json" -o -name "serialization_infos.txt" 2>/dev/null | wc -l' 2>/dev/null \
  | tail -1 | tr -d '[:space:]')

echo "          Found ${CORRUPTED:-0} serialization metadata file(s)."
echo ""

if [ "${CORRUPTED:-0}" -eq "0" ]; then
  echo "  No corrupted serialization files found."
  echo "  The crash may have a different cause. Check ClickHouse logs:"
  echo ""
  echo "    docker compose up -d clickhouse"
  echo "    sleep 15 && docker compose logs --tail=100 clickhouse"
  echo ""
  docker compose up -d
  exit 0
fi

# Step 3 — delete them
echo "Step 3/5  Removing ${CORRUPTED} corrupted file(s) from /var/lib/clickhouse..."
docker compose run --rm --no-deps --entrypoint sh clickhouse -c '
  find /var/lib/clickhouse -name "serialization.json"     -delete 2>/dev/null || true
  find /var/lib/clickhouse -name "serialization_infos.txt" -delete 2>/dev/null || true
  echo "          Done."
' 2>/dev/null
echo ""

# Step 4 — verify .env is present and JWT_SECRET is set
echo "Step 4/5  Checking .env file..."
if [ ! -f ".env" ]; then
  echo ""
  echo "  ⚠  WARNING: .env file is missing!"
  echo "     The app will fail to start without JWT_SECRET."
  echo ""
  echo "     Fix now:"
  echo "       cp .env.example .env"
  echo "       sed -i \"s|change-me-run-openssl-rand-hex-32|\$(openssl rand -hex 32)|\" .env"
  echo ""
elif ! grep -qE '^JWT_SECRET=.{8,}' .env 2>/dev/null; then
  echo ""
  echo "  ⚠  WARNING: JWT_SECRET is empty or too short in .env!"
  echo "     Fix now:"
  echo "       sed -i \"s|^JWT_SECRET=.*|JWT_SECRET=\$(openssl rand -hex 32)|\" .env"
  echo ""
else
  echo "          .env OK — JWT_SECRET is set."
fi
echo ""

# Step 5 — bring the stack back up
echo "Step 5/5  Starting containers..."
docker compose up -d
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Recovery complete.  Timeline after this point:"
echo ""
echo "  t+0  s  ClickHouse container starts"
echo "  t+30 s  ClickHouse /ping begins responding (HTTP thread ready)"
echo "  t+60 s  First healthcheck fires (start_period expires)"
echo "  t+70 s  ClickHouse marked healthy → App container starts"
echo "  t+90 s  Next.js migrations run, port 3000 opens"
echo ""
echo "Monitor:"
echo "  docker compose logs -f clickhouse   # watch for 'Ready for connections'"
echo "  docker compose logs -f app          # watch for '[ulp-suite] launching'"
echo "  docker compose ps                   # verify status = healthy"
echo "═══════════════════════════════════════════════════════════════"
