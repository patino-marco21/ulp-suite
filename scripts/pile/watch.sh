#!/bin/bash
# One monitor for a pile run: feeder events (STOP / LOW DISK / DISK OK / PHASE LIMIT / COMPLETE), anomalies (app or ClickHouse restart or unhealthy, read-only
# replica, replication queue, open mutations, detached parts, errors in text_log, app log errors) and a HEARTBEAT line at the start and every HB seconds.
# usage: START_TS='2026-10-12 12:00:00' FEED_LOG=<path of the feeder's output> scripts/pile/watch.sh      (run it under the Monitor tool; it ends only when stopped)
# Env: START_TS (required), FEED_LOG (required), HB (1800), PARTITION (202610), CH_CONTAINER, APP_CONTAINER (ulpsuite_app), PILE_WORK_DIR,
#      ULP_REPO (the checkout whose ./inbox and ./data are used; default: the checkout this script is in).
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=${ULP_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}; cd "$REPO" || exit 1
WORK=${PILE_WORK_DIR:-"$REPO/.pile-work"}; mkdir -p "$WORK"
CH_CONTAINER=${CH_CONTAINER:-ulpsuite_clickhouse}; APP_CONTAINER=${APP_CONTAINER:-ulpsuite_app}
PARTITION=${PARTITION:-202610}
START_TS=${START_TS:?set START_TS}; FEED_LOG=${FEED_LOG:?set FEED_LOG}
HB=${HB:-1800}
trap 'kill $(jobs -p) 2>/dev/null' EXIT

tail -n 0 -F "$FEED_LOG" | grep --line-buffered -E 'STOP|LOW DISK|DISK OK|PHASE LIMIT|COMPLETE' | sed -u 's/^/FEEDER /' &
docker logs -f --since "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$APP_CONTAINER" 2>&1 \
  | grep -E --line-buffered 'rror|[Ff]ailed|CRITICAL|[Pp]aused|abort|ECONN' | grep -v --line-buffered 'monitor-rescan' | sed -u 's/^/APP-LOG /' &

app0=$(docker inspect -f '{{.State.StartedAt}}' "$APP_CONTAINER"); ch0=$(docker inspect -f '{{.State.StartedAt}}' "$CH_CONTAINER")
chq() { docker exec "$CH_CONTAINER" clickhouse-client -q "$1" 2>/dev/null; }
heartbeat() {
  local fed js p free inflight alive
  fed=$(grep -c ' FEED ' "$FEED_LOG" 2>/dev/null)
  rm -rf "$WORK/hbq"; mkdir -p "$WORK/hbq"; cp data/ulp.db data/ulp.db-wal data/ulp.db-shm "$WORK/hbq/" 2>/dev/null
  js=$(node "$SCRIPT_DIR/jobs-summary.cjs" "$WORK/hbq" "$START_TS" 2>&1 | head -1 | sed 's/^JOBS since [0-9: -]*: //')
  p=$(chq "SELECT concat(toString(round(sumIf(bytes_on_disk, partition='$PARTITION')/1073741824, 1)), ' GiB, ', toString(sumIf(rows, partition='$PARTITION')), ' rows') FROM system.parts WHERE database='ulp' AND table='credentials' AND active")
  free=$(df -BG --output=avail / | tail -1 | tr -d ' ')
  inflight=$(( $(ls -A inbox | grep -v -E '^(done|failed|processing)$' | wc -l) + $(ls -A inbox/processing | wc -l) ))
  pgrep -f "scripts/pile/feed.sh" >/dev/null && alive=alive || alive=NOT-RUNNING
  echo "$(date -u +%T) HEARTBEAT feeder=$alive fed=$fed inflight=$inflight | $js | p${PARTITION}=$p | free=$free"
}

prev=""; last_hb=0
while true; do
  now=$(date +%s)
  if [ $((now - last_hb)) -ge "$HB" ]; then heartbeat; last_hb=$now; fi
  a=$(docker inspect -f '{{.State.StartedAt}}|{{.State.Health.Status}}' "$APP_CONTAINER" 2>&1)
  c=$(docker inspect -f '{{.State.StartedAt}}|{{.State.Health.Status}}' "$CH_CONTAINER" 2>&1)
  q=$(chq "SELECT concat((SELECT toString(max(is_readonly)) FROM system.replicas), '|', (SELECT toString(max(queue_size)) FROM system.replicas), '|', toString((SELECT count() FROM system.mutations WHERE NOT is_done)), '|', toString((SELECT count() FROM system.detached_parts)), '|', toString((SELECT count() FROM system.text_log WHERE level IN ('Error','Fatal') AND event_time > now() - INTERVAL 10 MINUTE)))")
  IFS='|' read -r ro qs mut det err <<< "$q"
  issues=""
  [ "${a%%|*}" != "$app0" ] && issues="$issues app-restarted"
  [ "${a##*|}" != "healthy" ] && issues="$issues app-${a##*|}"
  [ "${c%%|*}" != "$ch0" ] && issues="$issues clickhouse-restarted"
  [ "${c##*|}" != "healthy" ] && issues="$issues clickhouse-${c##*|}"
  [ "$ro" != "0" ] && issues="$issues replica-readonly=$ro"
  [ "${qs:-0}" -gt 20 ] 2>/dev/null && issues="$issues repl-queue=$qs"
  [ "${mut:-0}" != "0" ] && issues="$issues open-mutations=$mut"
  [ "${det:-0}" != "0" ] && issues="$issues detached-parts=$det"
  [ "${err:-0}" != "0" ] && issues="$issues text_log-errors-10m=$err"
  pgrep -f "scripts/pile/feed.sh" >/dev/null || issues="$issues feeder-not-running"
  if [ "$issues" != "$prev" ]; then
    if [ -n "$issues" ]; then echo "$(date -u +%T) ANOMALY:$issues"; else echo "$(date -u +%T) ALL CLEAR (was:$prev)"; fi
    prev="$issues"
  fi
  sleep 60
done
