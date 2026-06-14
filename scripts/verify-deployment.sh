#!/bin/bash
# =============================================================================
# verify-deployment.sh
#
# READ-ONLY end-to-end health + correctness check for the ULP Suite stack on
# the Ubuntu processing host. Run it AFTER deploying the latest code:
#
#   cd ~/ulp-suite
#   git pull
#   docker compose up -d --build app     # rebuilds the Next.js image (the code
#                                         # fixes are baked in at build time --
#                                         # git pull alone does NOT update the
#                                         # running container)
#   bash scripts/verify-deployment.sh
#
# Checks, in order:
#   1. Containers up + ClickHouse healthy, and WHEN the app container was last
#      (re)created -- a recent time confirms the rebuild took effect.
#   2. App reachable: GET /api/check (unauthenticated) exercises the full
#      Next.js -> ClickHouse -> credentials path end to end.
#   3. ClickHouse query layer ready (SELECT 1).
#   4. system.errors -- recent server errors (informational).
#   5. system.mutations -- any pending (expect 0).
#   6. system.parts -- parts per partition (>100 in one partition = merge lag).
#   7. Table sanity -- ulp.credentials row count; credentials_old should be gone.
#   8. Data-fix spot checks (raw columns the fixes target).
#
# Nothing is modified. Safe to run any time.
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
APP_URL="http://localhost:3000"
concerns=0

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — verify deployment (read-only)                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Host: $(hostname)   $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

# ── 1  Containers ────────────────────────────────────────────────────────────
echo "═══ 1  Containers (both Up; clickhouse healthy) ═════════════════"
docker compose ps
echo ""
echo "-- app container created/status (recent 'Created' = rebuild took effect) --"
docker ps --filter name=ulpsuite_app --format 'created: {{.CreatedAt}}   status: {{.Status}}' || true
CH_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' ulpsuite_clickhouse 2>/dev/null || echo "unknown")
echo "clickhouse health: $CH_HEALTH"
if [ "$CH_HEALTH" != "healthy" ]; then
  echo ">>> CONCERN: clickhouse not healthy."
  concerns=$((concerns+1))
fi
echo ""

# ── 2  App reachability (end-to-end through ClickHouse) ──────────────────────
echo "═══ 2  App reachable — GET /api/check (Next -> ClickHouse) ══════"
# Wait up to ~60s for the app to finish starting — the container may have just
# been (re)built. Poll /api/check until it answers 200 or we time out, so a
# rebuild-then-verify in one breath doesn't false-alarm on a cold start.
CHECK_URL="$APP_URL/api/check?email=deploytest@example.com"
CHECK_HTTP=000
for _ in $(seq 1 30); do
  CHECK_HTTP=$(curl -s -o /tmp/ulp-check-body -w '%{http_code}' --max-time 10 "$CHECK_URL" 2>/dev/null)
  CHECK_HTTP=${CHECK_HTTP:-000}
  [ "$CHECK_HTTP" = "200" ] && break
  sleep 2
done
echo "HTTP $CHECK_HTTP"
echo -n "body: "; head -c 300 /tmp/ulp-check-body 2>/dev/null; echo ""
if [ "$CHECK_HTTP" = "200" ]; then
  echo ">>> OK: app served a query result through ClickHouse."
else
  echo ">>> CONCERN: expected HTTP 200 (got $CHECK_HTTP after ~60s). Check: docker compose logs --tail=50 app"
  concerns=$((concerns+1))
fi
echo ""

# ── 3  ClickHouse query layer ────────────────────────────────────────────────
echo "═══ 3  ClickHouse query layer (SELECT 1) ════════════════════════"
if SELECT1=$($CH "SELECT 1" 2>&1) && [ "$SELECT1" = "1" ]; then
  echo ">>> OK: ClickHouse answering queries."
else
  echo ">>> CONCERN: SELECT 1 failed: $SELECT1"
  concerns=$((concerns+1))
fi
echo ""

# ── 4  Recent server errors ──────────────────────────────────────────────────
echo "═══ 4  system.errors (value > 0; informational) ════════════════"
$CH "
SELECT name, value, last_error_message
FROM system.errors
WHERE value > 0
ORDER BY value DESC
LIMIT 15
" --format PrettyCompact 2>&1 || echo "(could not read system.errors)"
echo "(These are cumulative since server start -- a non-zero count is not"
echo " necessarily a current problem; look for recent/repeating ones.)"
echo ""

# ── 5  Pending mutations ─────────────────────────────────────────────────────
echo "═══ 5  system.mutations — pending (expect 0) ════════════════════"
PENDING=$($CH "SELECT count() FROM system.mutations WHERE database='ulp' AND NOT is_done" 2>/dev/null || echo "?")
echo "pending mutations on ulp.*: $PENDING"
if [ "${PENDING:-1}" != "0" ]; then
  echo ">>> CONCERN: mutations still running -- detail:"
  $CH "
  SELECT table, mutation_id, command, parts_to_do, latest_fail_reason
  FROM system.mutations WHERE database='ulp' AND NOT is_done
  " --format Vertical 2>&1 || true
  concerns=$((concerns+1))
fi
echo ""

# ── 6  Parts / merge lag ─────────────────────────────────────────────────────
echo "═══ 6  system.parts — active parts per partition (>100 = lag) ═══"
$CH "
SELECT table, partition, count() AS parts, sum(rows) AS rows,
       formatReadableSize(sum(data_compressed_bytes)) AS compressed
FROM system.parts
WHERE database='ulp' AND active=1
GROUP BY table, partition
ORDER BY parts DESC
" --format PrettyCompact 2>&1 || echo "(could not read system.parts)"
MAXPARTS=$($CH "SELECT max(c) FROM (SELECT count() AS c FROM system.parts WHERE database='ulp' AND active=1 GROUP BY table, partition)" 2>/dev/null || echo 0)
if [ "${MAXPARTS:-0}" -gt 100 ] 2>/dev/null; then
  echo ">>> CONCERN: a partition has >100 active parts ($MAXPARTS) -- merge lag."
  concerns=$((concerns+1))
fi
echo ""

# ── 7  Table sanity ──────────────────────────────────────────────────────────
echo "═══ 7  Table sanity ═════════════════════════════════════════════"
$CH "
SELECT name,
       (SELECT sum(rows) FROM system.parts WHERE database='ulp' AND table=t.name AND active=1) AS rows
FROM system.tables t WHERE database='ulp' ORDER BY name
" --format PrettyCompact 2>&1 || true
OLD_GONE=$($CH "SELECT count() FROM system.tables WHERE database='ulp' AND name='credentials_old'" 2>/dev/null || echo "?")
echo "credentials_old present: $OLD_GONE (0 = dropped, as expected post-cleanup)"
echo ""

# ── 8  Data-fix spot checks ──────────────────────────────────────────────────
echo "═══ 8  Data-fix spot checks (raw columns the fixes target) ══════"
echo "-- Case A (jsessionid w/ good url): NORM_COLS now keeps these raw values --"
$CH "
SELECT substring(url,1,45) AS url, domain, substring(email,1,30) AS email
FROM ulp.credentials
WHERE lower(left(email,11))='jsessionid=' AND url != ''
LIMIT 3
SETTINGS max_execution_time = 60
" --format Vertical 2>&1 || true
echo ""
echo "-- Case D (url='' URL-in-email): host NORM_COLS now extracts (real, not 'https') --"
$CH "$(cat <<'EOSQL'
SELECT substring(email,1,45) AS email,
       domain(if(startsWith(lower(email),'http'), email, concat('https://',email))) AS norm_host
FROM ulp.credentials
WHERE url='' AND position(email,'@')=0 AND position(email,'/')>0
  AND lower(left(email,11))!='jsessionid='
LIMIT 3
SETTINGS max_execution_time = 60
EOSQL
)" --format Vertical 2>&1 || true
echo ""

echo "═══════════════════════════════════════════════════════════════"
if [ "$concerns" = "0" ]; then
  echo "RESULT: no concerns flagged. Stack looks healthy."
else
  echo "RESULT: $concerns concern(s) flagged above -- see the >>> lines."
fi
echo ""
echo "Still worth a manual look in the browser ($APP_URL):"
echo "  - log in, open Credentials Browser, confirm it loads + counts look right;"
echo "  - page forward on a filtered search: the record count should stay put"
echo "    while later pages load (the count()-skip change);"
echo "  - the jsessionid rows above should display a real url/domain, not garbage."
echo "═══════════════════════════════════════════════════════════════"
